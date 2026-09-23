const PAIRING_CHANNELS = Object.freeze({
  STATUS: "nova-panel:pairing-status",
  START: "nova-panel:pairing-start",
  CANCEL: "nova-panel:pairing-cancel",
  START_SECURE_CORE: "nova-panel:start-secure-core",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unavailableResponse(message = "Secure pairing is unavailable in the current Core mode.") {
  return Object.freeze({
    ok: true,
    available: false,
    state: "unavailable",
    coreState: "unknown",
    canStartSecureCore: false,
    canCheckAgain: true,
    message,
    session: null,
  });
}

function errorResponse(code, message) {
  return Object.freeze({
    ok: false,
    available: false,
    state: "error",
    coreState: "error",
    canStartSecureCore: false,
    canCheckAgain: true,
    error: Object.freeze({ code, message }),
    message,
    session: null,
  });
}

function sanitizeErrorCode(error) {
  return typeof error?.code === "string" && error.code
    ? error.code
    : "PAIRING_OPERATION_FAILED";
}

function assertNoArguments(args) {
  if (args.length !== 0) {
    return errorResponse(
      "INVALID_PAIRING_REQUEST",
      "Pairing requests do not accept renderer-supplied parameters.",
    );
  }
  return null;
}

function normalizeSession(session) {
  if (!isPlainObject(session)) return null;
  return Object.freeze({
    id: typeof session.id === "string" ? session.id : "",
    createdAt: typeof session.createdAt === "string" ? session.createdAt : "",
    expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : "",
    failedAttempts: Number.isInteger(session.failedAttempts) ? session.failedAttempts : 0,
    failedAttemptsRemaining: Number.isInteger(session.failedAttemptsRemaining)
      ? session.failedAttemptsRemaining
      : 0,
  });
}

function normalizeStatusPayload(payload) {
  const session = normalizeSession(payload?.session);
  return Object.freeze({
    ok: payload?.ok !== false,
    available: true,
    state: session ? "active" : "ready",
    coreState: "secure-core-ready",
    canStartSecureCore: false,
    canCheckAgain: true,
    message: session ? "Pairing active." : "Ready to pair.",
    session,
  });
}

function normalizeStartPayload(payload) {
  const pairingSecret = typeof payload?.pairingSecret === "string"
    ? payload.pairingSecret
    : "";
  const session = normalizeSession(payload?.session);

  if (payload?.ok !== true || !pairingSecret || !session) {
    return errorResponse(
      "PAIRING_START_FAILED",
      "Pairing could not be started.",
    );
  }

  return Object.freeze({
    ok: true,
    available: true,
    state: "active",
    coreState: "secure-core-ready",
    canStartSecureCore: false,
    canCheckAgain: true,
    message: "Pairing active.",
    pairingSecret,
    session,
  });
}

function normalizeCancelPayload(payload) {
  const status = normalizeStatusPayload(payload?.status ?? { ok: true, session: null });
  return Object.freeze({
    ok: payload?.ok !== false,
    available: true,
    state: status.session ? "active" : "ready",
    coreState: "secure-core-ready",
    canStartSecureCore: false,
    canCheckAgain: true,
    message: payload?.cancelled
      ? "Pairing cancelled."
      : "No active pairing session.",
    cancelled: Boolean(payload?.cancelled),
    session: status.session,
  });
}

function isPairingAvailable(coreLifecycle) {
  const status = coreLifecycle?.getAdminChannelStatus?.();
  return Boolean(status?.ready === true);
}

async function unavailablePairingStatus(coreLifecycle) {
  const adminChannel = coreLifecycle?.getAdminChannelStatus?.() ?? {
    state: "unavailable",
    ready: false,
  };
  const lifecycle = typeof coreLifecycle?.checkAvailability === "function"
    ? await coreLifecycle.checkAvailability()
    : { state: "unavailable", reachable: false };

  if (lifecycle.reachable === true && lifecycle.owned !== true) {
    return Object.freeze({
      ok: true,
      available: false,
      state: "external-core",
      coreState: "external-core",
      canStartSecureCore: false,
      canCheckAgain: true,
      message: "Core is running externally. Close it manually, then check again.",
      session: null,
      adminChannel,
    });
  }

  if (lifecycle.owned === true || ["owned-starting", "owned-stopping"].includes(lifecycle.state)) {
    return Object.freeze({
      ok: true,
      available: false,
      state: adminChannel.state === "failed" ? "secure-core-failed" : "secure-core-connecting",
      coreState: lifecycle.state,
      canStartSecureCore: false,
      canCheckAgain: true,
      message: adminChannel.state === "failed"
        ? "Secure Core connection failed."
        : "Securing Core connection…",
      session: null,
      adminChannel,
    });
  }

  return Object.freeze({
    ok: true,
    available: false,
    state: "no-core",
    coreState: "no-core",
    canStartSecureCore: true,
    canCheckAgain: true,
    message: "Device pairing requires Core to run securely under Pebble.",
    session: null,
    adminChannel,
  });
}

function normalizeSecureCoreStartPayload(payload) {
  if (payload?.ok === true) {
    return Object.freeze({
      ok: true,
      available: true,
      state: "ready",
      coreState: "secure-core-ready",
      canStartSecureCore: false,
      canCheckAgain: true,
      message: "Secure Core connected. Ready to pair a device.",
      session: null,
    });
  }

  if (payload?.state === "external-core") {
    return Object.freeze({
      ok: false,
      available: false,
      state: "external-core",
      coreState: "external-core",
      canStartSecureCore: false,
      canCheckAgain: true,
      message: "Core is running externally. Close it manually, then check again.",
      session: null,
    });
  }

  return Object.freeze({
    ok: false,
    available: false,
    state: "secure-core-failed",
    coreState: "secure-core-failed",
    canStartSecureCore: true,
    canCheckAgain: true,
    message: payload?.message || "Secure Core launch failed.",
    session: null,
  });
}

function registerPairingIpcHandlers({
  ipcMain,
  coreLifecycle,
  isAllowedSender = () => true,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("Pairing IPC registration requires ipcMain.handle.");
  }
  if (!coreLifecycle) {
    throw new TypeError("Pairing IPC registration requires a Core lifecycle.");
  }

  function assertAllowedSender(event) {
    if (isAllowedSender(event) === true) return null;
    return errorResponse(
      "PAIRING_IPC_FORBIDDEN",
      "Pairing controls are not available to this window.",
    );
  }

  ipcMain.handle(PAIRING_CHANNELS.STATUS, async (event, ...args) => {
    return assertAllowedSender(event)
      ?? assertNoArguments(args)
      ?? (isPairingAvailable(coreLifecycle)
        ? normalizeStatusPayload(await coreLifecycle.getPairingStatus())
        : unavailablePairingStatus(coreLifecycle));
  });

  ipcMain.handle(PAIRING_CHANNELS.START_SECURE_CORE, async (event, ...args) => {
    const rejected = assertAllowedSender(event) ?? assertNoArguments(args);
    if (rejected) return rejected;

    const current = await unavailablePairingStatus(coreLifecycle);
    if (current.state === "external-core") return current;
    if (isPairingAvailable(coreLifecycle)) {
      return normalizeSecureCoreStartPayload({ ok: true });
    }
    if (current.canStartSecureCore !== true) return current;

    try {
      return normalizeSecureCoreStartPayload(await coreLifecycle.startSecureCore());
    } catch (error) {
      return errorResponse(
        sanitizeErrorCode(error),
        "Secure Core launch failed.",
      );
    }
  });

  ipcMain.handle(PAIRING_CHANNELS.START, async (event, ...args) => {
    const rejected = assertAllowedSender(event) ?? assertNoArguments(args);
    if (rejected) return rejected;
    if (!isPairingAvailable(coreLifecycle)) return unavailableResponse();

    try {
      return normalizeStartPayload(await coreLifecycle.startPairing());
    } catch (error) {
      return errorResponse(
        sanitizeErrorCode(error),
        "Pairing could not be started.",
      );
    }
  });

  ipcMain.handle(PAIRING_CHANNELS.CANCEL, async (event, ...args) => {
    const rejected = assertAllowedSender(event) ?? assertNoArguments(args);
    if (rejected) return rejected;
    if (!isPairingAvailable(coreLifecycle)) {
      return errorResponse(
        "PAIRING_CANCEL_UNCONFIRMED",
        "Secure Core pairing cancellation could not be confirmed.",
      );
    }

    try {
      return normalizeCancelPayload(await coreLifecycle.cancelPairing());
    } catch (error) {
      return errorResponse(
        sanitizeErrorCode(error),
        "Secure Core pairing cancellation could not be confirmed.",
      );
    }
  });
}

module.exports = {
  PAIRING_CHANNELS,
  registerPairingIpcHandlers,
};
