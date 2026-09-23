import { PairingSessionError } from "./pairingSessionManager.js";

export class PairingClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairingClaimError";
    this.code = code;
  }
}

const DISPLAY_NAME_MAX_LENGTH = 80;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(code, message) {
  throw new PairingClaimError(code, message);
}

function validateDisplayName(deviceName) {
  if (typeof deviceName !== "string") {
    fail("INVALID_REQUEST", "Device name is required.");
  }

  const displayName = deviceName.trim();
  if (
    !displayName
    || displayName.length > DISPLAY_NAME_MAX_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(displayName)
  ) {
    fail(
      "INVALID_REQUEST",
      `Device name must be 1 to ${DISPLAY_NAME_MAX_LENGTH} characters without control characters.`,
    );
  }

  return displayName;
}

function validateClaimRequest(request) {
  if (
    !request
    || typeof request !== "object"
    || Array.isArray(request)
    || Object.keys(request).sort().join(",") !== "deviceName,secret"
  ) {
    fail("INVALID_REQUEST", "Pairing claim request is invalid.");
  }

  if (typeof request.secret !== "string" || !request.secret) {
    fail("INVALID_REQUEST", "Pairing secret is required.");
  }

  return Object.freeze({
    secret: request.secret,
    displayName: validateDisplayName(request.deviceName),
  });
}

/**
 * Creates the narrow remote pairing claim service. It receives only the active
 * session claim closure and the narrow chat-credential issuer. A successful
 * secret claim is consumed before credential issuance; if issuance later fails,
 * the pairing session is deliberately not restored.
 */
export function createPairingClaimService({
  claimPairingSecret,
  credentialIssuer,
  getCredentialIssuer,
} = {}) {
  if (typeof claimPairingSecret !== "function") {
    throw new PairingClaimError(
      "INVALID_CONFIGURATION",
      "Pairing claim service requires a secret claim function.",
    );
  }

  return Object.freeze({
    claim(request) {
      const { secret, displayName } = validateClaimRequest(request);
      let issuer = credentialIssuer;

      if (!issuer && typeof getCredentialIssuer === "function") {
        try {
          issuer = getCredentialIssuer();
        } catch {
          fail("PAIRING_UNAVAILABLE", "Pairing is unavailable.");
        }
      }

      if (
        !issuer
        || typeof issuer.issueChatCredentialForPairedDevice !== "function"
      ) {
        fail("PAIRING_UNAVAILABLE", "Pairing is unavailable.");
      }

      try {
        claimPairingSecret(secret);
      } catch (error) {
        if (error instanceof PairingSessionError) {
          fail("PAIRING_FAILED", "Pairing failed.");
        }
        throw error;
      }

      try {
        const issued = issuer.issueChatCredentialForPairedDevice({
          displayName,
        });
        if (!issued || typeof issued.bearerCredential !== "string") {
          fail("PAIRING_UNAVAILABLE", "Pairing is unavailable.");
        }
        return Object.freeze({
          paired: true,
          credential: issued.bearerCredential,
        });
      } catch (error) {
        if (error instanceof PairingClaimError) throw error;
        fail("PAIRING_UNAVAILABLE", "Pairing is unavailable.");
      }
    },
  });
}
