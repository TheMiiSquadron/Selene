(function definePairingPanelState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SelenePairingPanelState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function toTimestamp(value) {
    if (typeof value !== "string" || !value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function normalizeSession(session) {
    if (!isPlainObject(session)) return null;
    const expiresAtMs = toTimestamp(session.expiresAt);
    return Object.freeze({
      id: typeof session.id === "string" ? session.id : "",
      createdAt: typeof session.createdAt === "string" ? session.createdAt : "",
      expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : "",
      expiresAtMs,
      failedAttempts: Number.isInteger(session.failedAttempts) ? session.failedAttempts : 0,
      failedAttemptsRemaining: Number.isInteger(session.failedAttemptsRemaining)
        ? session.failedAttemptsRemaining
        : 0,
    });
  }

  function createInitialPairingState() {
    return Object.freeze({
      availability: "unavailable",
      phase: "unavailable",
      message: "Pairing unavailable.",
      session: null,
      pairingSecret: null,
      busy: false,
      cancelUnconfirmed: false,
    });
  }

  function withBusy(state, busy) {
    return Object.freeze({
      ...state,
      busy: Boolean(busy),
    });
  }

  function clearSecret(state, message = state.message) {
    return Object.freeze({
      ...state,
      message,
      pairingSecret: null,
    });
  }

  function applyUnavailable(state, message = "Secure pairing is unavailable in the current Core mode.") {
    return Object.freeze({
      ...state,
      availability: "unavailable",
      phase: "unavailable",
      message,
      session: null,
      pairingSecret: null,
      busy: false,
      cancelUnconfirmed: false,
    });
  }

  function applyStatus(state, response, nowMs = Date.now()) {
    if (!isPlainObject(response) || response.ok === false || response.available !== true) {
      return applyUnavailable(state, response?.message);
    }

    const session = normalizeSession(response.session);
    if (!session) {
      return Object.freeze({
        ...state,
        availability: "available",
        phase: "ready",
        message: response.message || "Ready to pair.",
        session: null,
        pairingSecret: null,
        busy: false,
        cancelUnconfirmed: false,
      });
    }

    if (session.expiresAtMs !== null && session.expiresAtMs <= nowMs) {
      return Object.freeze({
        ...state,
        availability: "available",
        phase: "expired",
        message: "Pairing expired.",
        session,
        pairingSecret: null,
        busy: false,
        cancelUnconfirmed: false,
      });
    }

    const keepSecret = state.session?.id === session.id
      ? state.pairingSecret
      : null;

    return Object.freeze({
      ...state,
      availability: "available",
      phase: "active",
      message: response.message || "Pairing active.",
      session,
      pairingSecret: keepSecret,
      busy: false,
      cancelUnconfirmed: false,
    });
  }

  function applyStartResult(state, response, nowMs = Date.now()) {
    if (!isPlainObject(response) || response.ok !== true || response.available !== true) {
      return Object.freeze({
        ...applyUnavailable(state, response?.message || "Pairing could not be started."),
        phase: "error",
      });
    }

    const session = normalizeSession(response.session);
    const pairingSecret = typeof response.pairingSecret === "string"
      ? response.pairingSecret
      : "";

    if (!session || !pairingSecret) {
      return Object.freeze({
        ...state,
        phase: "error",
        message: "Pairing could not be started.",
        pairingSecret: null,
        busy: false,
      });
    }

    return applyStatus(Object.freeze({
      ...state,
      pairingSecret,
      session,
      availability: "available",
    }), {
      ok: true,
      available: true,
      message: response.message || "Pairing active.",
      session,
    }, nowMs);
  }

  function applyCancelResult(state, response) {
    if (!isPlainObject(response) || response.ok !== true || response.available !== true) {
      return Object.freeze({
        ...state,
        phase: "error",
        message: response?.message || "Secure Core pairing cancellation could not be confirmed.",
        pairingSecret: null,
        busy: false,
        cancelUnconfirmed: true,
      });
    }

    return Object.freeze({
      ...state,
      availability: "available",
      phase: response.session ? "active" : "ready",
      message: response.message || "Pairing cancelled.",
      session: normalizeSession(response.session),
      pairingSecret: null,
      busy: false,
      cancelUnconfirmed: false,
    });
  }

  function expireIfNeeded(state, nowMs = Date.now()) {
    const expiresAtMs = state.session?.expiresAtMs;
    if (state.phase !== "active" || expiresAtMs === null || expiresAtMs > nowMs) {
      return state;
    }

    return Object.freeze({
      ...state,
      phase: "expired",
      message: "Pairing expired.",
      pairingSecret: null,
      busy: false,
    });
  }

  return Object.freeze({
    createInitialPairingState,
    withBusy,
    clearSecret,
    applyUnavailable,
    applyStatus,
    applyStartResult,
    applyCancelResult,
    expireIfNeeded,
  });
});
