const path = require("node:path");
const { randomBytes: defaultRandomBytes } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const LOCAL_ADMIN_CHANNEL_NAME = "selene.localAdmin";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1000;
const DEFAULT_MAX_PENDING_REQUESTS = 32;

function defaultProtocolPath() {
  return path.resolve(__dirname, "..", "..", "core", "src", "localAdminProtocol.js");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeReason(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code) return code;
  const name = typeof error?.name === "string" ? error.name : null;
  return name || "CORE_ADMIN_CHANNEL_ERROR";
}

function createStatus({ state, ready = false, failure = null, pendingRequests = 0 } = {}) {
  return Object.freeze({
    state,
    ready,
    failure,
    pendingRequests,
  });
}

class CoreAdminChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CoreAdminChannelError";
    this.code = code;
  }
}

function channelError(code, message) {
  return new CoreAdminChannelError(code, message);
}

function envelope(kind, payload = {}) {
  return Object.freeze({
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind,
    ...payload,
  });
}

async function loadProtocol(protocolModulePath = defaultProtocolPath()) {
  return import(pathToFileURL(protocolModulePath).href);
}

function writeBootstrapCapability(child, capabilityBytes) {
  const stream = child?.stdio?.[3];
  if (!stream || typeof stream.write !== "function" || typeof stream.end !== "function") {
    throw channelError(
      "BOOTSTRAP_UNAVAILABLE",
      "Core admin bootstrap stream is unavailable.",
    );
  }
  stream.write(`${capabilityBytes.toString("base64url")}\n`);
  stream.end();
}

function sendChildMessage(child, message) {
  if (!child || typeof child.send !== "function") {
    throw channelError("IPC_UNAVAILABLE", "Core admin IPC is unavailable.");
  }
  const sent = child.send(message);
  if (sent === false) {
    throw channelError("IPC_SEND_FAILED", "Core admin IPC send failed.");
  }
}

function makeRequestId(prefix, counter) {
  return `${prefix}-${counter}`;
}

function createCoreAdminChannel({
  child,
  protocolModule = null,
  protocolModulePath,
  randomBytes = defaultRandomBytes,
  handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxPendingRequests = DEFAULT_MAX_PENDING_REQUESTS,
  requestIdPrefix = "admin",
} = {}) {
  if (!child) {
    throw channelError("INVALID_CHILD", "Core admin channel requires an owned child process.");
  }
  if (typeof randomBytes !== "function") {
    throw channelError("INVALID_RANDOM_SOURCE", "Core admin random source is invalid.");
  }
  if (!Number.isInteger(maxPendingRequests) || maxPendingRequests <= 0) {
    throw channelError("INVALID_CONFIGURATION", "Core admin pending-request limit is invalid.");
  }

  let state = "bootstrapping";
  let capability = null;
  let challenge = null;
  let replayGuard = null;
  let protocol = protocolModule;
  let closed = false;
  let failure = null;
  let requestCounter = 0;
  let handshakeTimer = null;
  const pending = new Map();
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
      message: "Core admin channel failed.",
    };
    cleanup(error);
    rejectReady(error instanceof Error ? error : channelError(
      "CHANNEL_FAILED",
      "Core admin channel failed.",
    ));
  }

  function cleanup(error) {
    closed = true;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    capability = null;
    challenge = null;
    replayGuard = null;
    if (typeof child.off === "function") {
      child.off("message", handleMessage);
      child.off("exit", handleExit);
      child.off("disconnect", handleDisconnect);
      child.off("error", handleChildError);
    } else if (typeof child.removeListener === "function") {
      child.removeListener("message", handleMessage);
      child.removeListener("exit", handleExit);
      child.removeListener("disconnect", handleDisconnect);
      child.removeListener("error", handleChildError);
    }
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error instanceof Error ? error : channelError(
        "CHANNEL_CLOSED",
        "Core admin channel closed.",
      ));
      pending.delete(requestId);
    }
  }

  function close() {
    if (closed) return;
    state = "closed";
    cleanup(channelError("CHANNEL_CLOSED", "Core admin channel closed."));
  }

  function getStatus() {
    return createStatus({
      state,
      ready: state === "ready",
      failure,
      pendingRequests: pending.size,
    });
  }

  function handleExit() {
    if (state !== "closed" && state !== "failed") {
      fail(channelError("CHILD_EXITED", "Owned Core child exited."));
    }
  }

  function handleDisconnect() {
    if (state !== "closed" && state !== "failed") {
      fail(channelError("IPC_DISCONNECTED", "Owned Core IPC disconnected."));
    }
  }

  function handleChildError(error) {
    if (state !== "closed" && state !== "failed") {
      fail(error);
    }
  }

  function handleReadyResponse(raw) {
    if (raw.kind !== "response" || !isPlainObject(raw.message)) {
      fail(channelError("UNEXPECTED_MESSAGE", "Unexpected Core admin message."));
      return;
    }

    let verified;
    try {
      verified = protocol.verifyLocalAdminMessage(capability, raw.message, { replayGuard });
    } catch (error) {
      fail(error);
      return;
    }

    const entry = pending.get(verified.requestId);
    if (!entry) return;
    pending.delete(verified.requestId);
    clearTimeout(entry.timer);
    entry.resolve(verified);
  }

  function handleMessage(raw) {
    if (!isPlainObject(raw) || raw.channel !== LOCAL_ADMIN_CHANNEL_NAME) return;

    if (state === "authenticating") {
      if (raw.kind !== "handshake-challenge" || !isPlainObject(raw.challenge)) {
        fail(channelError("UNEXPECTED_MESSAGE", "Unexpected Core admin handshake message."));
        return;
      }

      try {
        challenge = raw.challenge;
        const response = protocol.createLocalAdminHandshakeResponse(capability, challenge, {
          requestId: makeRequestId("handshake", ++requestCounter),
          randomBytes,
        });
        sendChildMessage(child, envelope("handshake-response", { message: response }));
        state = "confirming";
      } catch (error) {
        fail(error);
      }
      return;
    }

    if (state === "confirming") {
      if (raw.kind !== "handshake-confirm" || !isPlainObject(raw.message)) {
        fail(channelError("UNEXPECTED_MESSAGE", "Unexpected Core admin confirmation message."));
        return;
      }
      try {
        protocol.verifyLocalAdminHandshakeConfirmation(
          capability,
          challenge,
          raw.message,
          { replayGuard },
        );
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        state = "ready";
        resolveReady(getStatus());
      } catch (error) {
        fail(error);
      }
      return;
    }

    if (state === "ready") {
      handleReadyResponse(raw);
      return;
    }

    if (state !== "closed" && state !== "failed") {
      fail(channelError("UNEXPECTED_MESSAGE", "Unexpected Core admin message."));
    }
  }

  async function start() {
    try {
      protocol = protocol ?? await loadProtocol(protocolModulePath);
      const capabilityBytes = randomBytes(protocol.LOCAL_ADMIN_CAPABILITY_BYTES);
      if (!Buffer.isBuffer(capabilityBytes)
        || capabilityBytes.length !== protocol.LOCAL_ADMIN_CAPABILITY_BYTES) {
        throw channelError("INVALID_RANDOM_SOURCE", "Core admin random source returned invalid bytes.");
      }

      capability = protocol.createLocalAdminCapabilityFromBytes(capabilityBytes);
      writeBootstrapCapability(child, capabilityBytes);
      capabilityBytes.fill(0);
      replayGuard = protocol.createLocalAdminReplayGuard();

      if (typeof child.on !== "function") {
        throw channelError("IPC_UNAVAILABLE", "Core admin IPC is unavailable.");
      }
      child.on("message", handleMessage);
      child.once("exit", handleExit);
      child.once("disconnect", handleDisconnect);
      child.once("error", handleChildError);

      state = "authenticating";
      handshakeTimer = setTimeout(() => {
        fail(channelError("HANDSHAKE_TIMEOUT", "Core admin handshake timed out."));
      }, handshakeTimeoutMs);
    } catch (error) {
      fail(error);
    }
  }

  function sendRequest(action, payload = {}) {
    if (state !== "ready") {
      return Promise.reject(channelError(
        "CHANNEL_NOT_READY",
        "Core admin channel is not ready.",
      ));
    }
    if (pending.size >= maxPendingRequests) {
      return Promise.reject(channelError(
        "TOO_MANY_PENDING_REQUESTS",
        "Core admin channel has too many pending requests.",
      ));
    }

    const requestId = makeRequestId(requestIdPrefix, ++requestCounter);
    const message = protocol.signLocalAdminMessage(capability, {
      requestId,
      action,
      payload,
      randomBytes,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(channelError("REQUEST_TIMEOUT", "Core admin request timed out."));
      }, requestTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      try {
        sendChildMessage(child, envelope("request", { message }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  queueMicrotask(start);

  return Object.freeze({
    get state() {
      return state;
    },
    ready,
    close,
    getStatus,
    sendRequest,
  });
}

module.exports = {
  CoreAdminChannelError,
  LOCAL_ADMIN_CHANNEL_NAME,
  createCoreAdminChannel,
};
