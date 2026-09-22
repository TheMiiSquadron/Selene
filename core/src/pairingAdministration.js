import { createPairingSessionManager } from "./pairingSessionManager.js";

export class PairingAdministrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairingAdministrationError";
    this.code = code;
  }
}

function trustedApprovalUnavailable() {
  throw new PairingAdministrationError(
    "TRUSTED_PAIRING_APPROVAL_UNAVAILABLE",
    "Pairing start and cancellation require a trusted local approval surface.",
  );
}

export function createLocalPairingAdministration({
  sessionManager = createPairingSessionManager(),
} = {}) {
  function startPairing() {
    trustedApprovalUnavailable();
  }

  function getPairingStatus() {
    return Object.freeze({
      ok: true,
      session: sessionManager.getActiveSession(),
    });
  }

  function cancelPairing() {
    trustedApprovalUnavailable();
  }

  function shutdown() {
    return Object.freeze({
      ok: true,
      cancelled: sessionManager.cancelSession(),
    });
  }

  return Object.freeze({
    startPairing,
    getPairingStatus,
    cancelPairing,
    shutdown,
  });
}
