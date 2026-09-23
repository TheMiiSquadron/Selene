import { createReadStream as defaultCreateReadStream } from "node:fs";
import {
  LOCAL_ADMIN_ACTIONS,
  createLocalAdminCapabilityFromBytes,
  createLocalAdminHandshakeChallenge,
  createLocalAdminHandshakeConfirmation,
  createLocalAdminReplayGuard,
  signLocalAdminMessage,
  verifyLocalAdminHandshakeResponse,
  verifyLocalAdminMessage,
} from "./localAdminProtocol.js";

export const OWNED_CORE_ADMIN_IPC_ARG = "--selene-owned-core-admin-ipc";
export const LOCAL_ADMIN_CHANNEL_NAME = "selene.localAdmin";
export const LOCAL_ADMIN_BOOTSTRAP_FD = 3;

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 1000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1000;
const MAX_BOOTSTRAP_BYTES = 128;
const CAPABILITY_TEXT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class LocalAdminChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalAdminChannelError";
    this.code = code;
  }
}

function channelError(code, message) {
  return new LocalAdminChannelError(code, message);
}

function sanitizeReason(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code) return code;
  const name = typeof error?.name === "string" ? error.name : null;
  return name || "LOCAL_ADMIN_CHANNEL_ERROR";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function shouldStartOwnedCoreAdminIpc(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(OWNED_CORE_ADMIN_IPC_ARG);
}

function readBootstrapCapability({
  bootstrapFd,
  createReadStream,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks = [];
    let stream;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    const timer = setTimeout(() => {
      stream?.destroy?.();
      finish(reject, channelError(
        "BOOTSTRAP_TIMEOUT",
        "Local admin bootstrap did not complete before the timeout.",
      ));
    }, timeoutMs);

    try {
      stream = createReadStream(null, {
        fd: bootstrapFd,
        autoClose: true,
        encoding: "utf8",
      });
    } catch (error) {
      clearTimeout(timer);
      reject(channelError(
        "BOOTSTRAP_UNAVAILABLE",
        "Local admin bootstrap stream is unavailable.",
      ));
      return;
    }

    stream.on("data", (chunk) => {
      total += Buffer.byteLength(chunk, "utf8");
      if (total > MAX_BOOTSTRAP_BYTES) {
        stream.destroy(channelError(
          "BOOTSTRAP_MALFORMED",
          "Local admin bootstrap material is malformed.",
        ));
        return;
      }
      chunks.push(chunk);
    });

    stream.once("error", (error) => {
      finish(reject, error instanceof LocalAdminChannelError
        ? error
        : channelError(
          "BOOTSTRAP_UNAVAILABLE",
          "Local admin bootstrap stream failed.",
        ));
    });

    stream.once("end", () => {
      const text = chunks.join("").trim();
      if (!CAPABILITY_TEXT_PATTERN.test(text)) {
        finish(reject, channelError(
          "BOOTSTRAP_MALFORMED",
          "Local admin bootstrap material is malformed.",
        ));
        return;
      }
      const bytes = Buffer.from(text, "base64url");
      if (bytes.length !== 32 || bytes.toString("base64url") !== text) {
        bytes.fill(0);
        finish(reject, channelError(
          "BOOTSTRAP_MALFORMED",
          "Local admin bootstrap material is malformed.",
        ));
        return;
      }
      finish(resolve, bytes);
    });
  });
}

function sendProcessMessage(processObject, message) {
  if (typeof processObject.send !== "function") {
    throw channelError(
      "IPC_UNAVAILABLE",
      "Local admin IPC is unavailable.",
    );
  }
  processObject.send(message);
}

function envelope(kind, payload = {}) {
  return Object.freeze({
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind,
    ...payload,
  });
}

export function startCoreLocalAdminChildChannel({
  processObject = process,
  argv = processObject.argv,
  pairingControls = null,
  bootstrapFd = LOCAL_ADMIN_BOOTSTRAP_FD,
  createReadStream = defaultCreateReadStream,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  randomBytes,
} = {}) {
  if (!shouldStartOwnedCoreAdminIpc(argv)) {
    return Object.freeze({
      state: "unavailable",
      ready: Promise.resolve(null),
      close() {},
      getStatus() {
        return Object.freeze({ state: "unavailable", ready: false });
      },
    });
  }

  let state = "bootstrapping";
  let capability = null;
  let challenge = null;
  let replayGuard = null;
  let closed = false;
  let failure = null;
  const pendingMessages = [];
  let handshakeTimer = null;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function fail(error) {
    if (closed || state === "failed") return;
    state = "failed";
    failure = {
      code: sanitizeReason(error),
      message: "Local admin channel failed.",
    };
    cleanup();
    rejectReady(error instanceof Error ? error : channelError(
      "CHANNEL_FAILED",
      "Local admin channel failed.",
    ));
  }

  function close() {
    if (closed) return;
    state = "closed";
    cleanup();
  }

  function cleanup() {
    closed = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    capability = null;
    challenge = null;
    replayGuard = null;
    if (typeof processObject.off === "function") {
      processObject.off("message", handleMessage);
      processObject.off("disconnect", handleDisconnect);
    } else if (typeof processObject.removeListener === "function") {
      processObject.removeListener("message", handleMessage);
      processObject.removeListener("disconnect", handleDisconnect);
    }
  }

  function getStatus() {
    return Object.freeze({
      state,
      ready: state === "ready",
      failure,
    });
  }

  function verifyRequest(message) {
    return verifyLocalAdminMessage(capability, message, { replayGuard });
  }

  function validateEmptyPayload(payload) {
    if (!isPlainObject(payload) || Object.keys(payload).length !== 0) {
      throw channelError(
        "INVALID_PAYLOAD",
        "Local admin action payload is invalid.",
      );
    }
  }

  function sendAuthenticatedResponse({ requestId, action, payload }) {
    const response = signLocalAdminMessage(capability, {
      requestId,
      action,
      payload,
      randomBytes,
    });
    sendProcessMessage(processObject, envelope("response", { message: response }));
  }

  function actionUnavailable(verified) {
    sendAuthenticatedResponse({
      requestId: verified.requestId,
      action: verified.action,
      payload: {
        ok: false,
        error: {
          code: "LOCAL_ADMIN_ACTION_UNAVAILABLE",
          message: "Local admin action is not available.",
        },
      },
    });
  }

  function actionError(verified, error) {
    sendAuthenticatedResponse({
      requestId: verified.requestId,
      action: verified.action,
      payload: {
        ok: false,
        error: {
          code: sanitizeReason(error),
          message: "Local admin action failed.",
        },
      },
    });
  }

  function handlePairingAction(verified) {
    try {
      validateEmptyPayload(verified.payload);
    } catch (error) {
      actionError(verified, error);
      return;
    }

    if (!pairingControls) {
      actionUnavailable(verified);
      return;
    }

    try {
      if (verified.action === LOCAL_ADMIN_ACTIONS.PAIRING_STATUS) {
        sendAuthenticatedResponse({
          requestId: verified.requestId,
          action: verified.action,
          payload: pairingControls.getPairingStatus(),
        });
        return;
      }

      if (verified.action === LOCAL_ADMIN_ACTIONS.PAIRING_START) {
        sendAuthenticatedResponse({
          requestId: verified.requestId,
          action: verified.action,
          payload: pairingControls.startPairing(),
        });
        return;
      }

      if (verified.action === LOCAL_ADMIN_ACTIONS.PAIRING_CANCEL) {
        sendAuthenticatedResponse({
          requestId: verified.requestId,
          action: verified.action,
          payload: pairingControls.cancelPairing(),
        });
        return;
      }
    } catch (error) {
      actionError(verified, error);
      return;
    }

    actionUnavailable(verified);
  }

  function handleReadyRequest(message) {
    let verified;
    try {
      verified = verifyRequest(message);
    } catch (error) {
      fail(error);
      return;
    }

    if (!Object.values(LOCAL_ADMIN_ACTIONS).includes(verified.action)) {
      fail(channelError("UNSUPPORTED_ACTION", "Unsupported local admin action."));
      return;
    }

    handlePairingAction(verified);
  }

  function handleMessage(raw) {
    if (!isPlainObject(raw) || raw.channel !== LOCAL_ADMIN_CHANNEL_NAME) return;
    if (state === "bootstrapping") {
      pendingMessages.push(raw);
      return;
    }

    if (state === "authenticating") {
      if (raw.kind !== "handshake-response" || !isPlainObject(raw.message)) {
        fail(channelError(
          "UNEXPECTED_MESSAGE",
          "Unexpected local admin message during authentication.",
        ));
        return;
      }

      try {
        const verified = verifyLocalAdminHandshakeResponse(
          capability,
          challenge,
          raw.message,
          { replayGuard },
        );
        const confirmation = createLocalAdminHandshakeConfirmation(capability, challenge, {
          requestId: verified.requestId,
          randomBytes,
        });
        sendProcessMessage(processObject, envelope("handshake-confirm", {
          message: confirmation,
        }));
        state = "ready";
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        resolveReady(getStatus());
      } catch (error) {
        fail(error);
      }
      return;
    }

    if (state === "ready") {
      if (raw.kind !== "request" || !isPlainObject(raw.message)) {
        fail(channelError(
          "UNEXPECTED_MESSAGE",
          "Unexpected local admin message.",
        ));
        return;
      }
      handleReadyRequest(raw.message);
    }
  }

  function handleDisconnect() {
    if (state !== "closed" && state !== "failed") {
      fail(channelError("IPC_DISCONNECTED", "Local admin IPC disconnected."));
    }
  }

  async function start() {
    if (typeof processObject.on !== "function") {
      fail(channelError("IPC_UNAVAILABLE", "Local admin IPC is unavailable."));
      return;
    }

    processObject.on("message", handleMessage);
    processObject.on("disconnect", handleDisconnect);

    try {
      const bytes = await readBootstrapCapability({
        bootstrapFd,
        createReadStream,
        timeoutMs: bootstrapTimeoutMs,
      });
      capability = createLocalAdminCapabilityFromBytes(bytes);
      bytes.fill(0);
      replayGuard = createLocalAdminReplayGuard();
      challenge = createLocalAdminHandshakeChallenge({ randomBytes });
      state = "authenticating";
      sendProcessMessage(processObject, envelope("handshake-challenge", { challenge }));
      handshakeTimer = setTimeout(() => {
        fail(channelError(
          "HANDSHAKE_TIMEOUT",
          "Local admin handshake did not complete before the timeout.",
        ));
      }, handshakeTimeoutMs);

      for (const pending of pendingMessages.splice(0)) {
        handleMessage(pending);
      }
    } catch (error) {
      fail(error);
    }
  }

  queueMicrotask(start);

  return Object.freeze({
    get state() {
      return state;
    },
    ready,
    close,
    getStatus,
  });
}
