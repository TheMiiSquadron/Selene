import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const PAIRING_SESSION_TTL_MS = 5 * 60 * 1000;
export const PAIRING_SECRET_BYTES = 32;
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_BYTES = 32;
const DUMMY_DIGEST = Buffer.alloc(DIGEST_BYTES);

export class PairingSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairingSessionError";
    this.code = code;
  }
}

function digestSecret(secret) {
  return createHash("sha256").update(secret).digest();
}

function validateNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PairingSessionError(
      "INVALID_CLOCK",
      "Pairing session clock returned an invalid timestamp.",
    );
  }
  return value;
}

function createSecret(generateSecret) {
  const value = generateSecret();
  if (!Buffer.isBuffer(value) || value.length !== PAIRING_SECRET_BYTES) {
    throw new PairingSessionError(
      "INVALID_SECRET_GENERATOR",
      `Pairing secret generator must return ${PAIRING_SECRET_BYTES} bytes.`,
    );
  }
  return Buffer.from(value);
}

function publicSession(session) {
  return Object.freeze({
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    failedAttempts: session.failedAttempts,
    failedAttemptsRemaining: Math.max(0, session.maxFailedAttempts - session.failedAttempts),
  });
}

function parsePairingSecret(pairingSecret) {
  if (typeof pairingSecret !== "string" || !SECRET_PATTERN.test(pairingSecret)) {
    return null;
  }

  const secret = Buffer.from(pairingSecret, "base64url");
  if (
    secret.length !== PAIRING_SECRET_BYTES
    || secret.toString("base64url") !== pairingSecret
  ) {
    return null;
  }
  return secret;
}

export function createPairingSessionManager({
  now = () => new Date(),
  generateId = randomUUID,
  generateSecret = () => randomBytes(PAIRING_SECRET_BYTES),
  ttlMs = PAIRING_SESSION_TTL_MS,
  maxFailedAttempts = PAIRING_MAX_FAILED_ATTEMPTS,
} = {}) {
  if (
    !Number.isInteger(ttlMs)
    || ttlMs <= 0
    || !Number.isInteger(maxFailedAttempts)
    || maxFailedAttempts <= 0
  ) {
    throw new PairingSessionError(
      "INVALID_CONFIGURATION",
      "Pairing session configuration is invalid.",
    );
  }

  let activeSession = null;

  function ensureFreshSession(currentTime = validateNow(now)) {
    if (!activeSession) return null;

    if (currentTime.getTime() >= Date.parse(activeSession.expiresAt)) {
      activeSession = null;
      throw new PairingSessionError(
        "PAIRING_EXPIRED",
        "Pairing session expired.",
      );
    }

    return activeSession;
  }

  function createSession() {
    const created = validateNow(now);
    const secret = createSecret(generateSecret);
    const id = generateId();
    if (typeof id !== "string" || !id.trim()) {
      throw new PairingSessionError(
        "INVALID_ID_GENERATOR",
        "Pairing session ID generator returned an invalid value.",
      );
    }

    activeSession = Object.freeze({
      id: id.trim(),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      secretDigest: digestSecret(secret),
      failedAttempts: 0,
      maxFailedAttempts,
    });

    return Object.freeze({
      pairingSecret: secret.toString("base64url"),
      session: publicSession(activeSession),
    });
  }

  function getActiveSession() {
    try {
      const session = ensureFreshSession();
      return session ? publicSession(session) : null;
    } catch (error) {
      if (error instanceof PairingSessionError && error.code === "PAIRING_EXPIRED") {
        return null;
      }
      throw error;
    }
  }

  function cancelSession() {
    const hadActiveSession = activeSession !== null;
    activeSession = null;
    return hadActiveSession;
  }

  function claimSecret(pairingSecret) {
    const current = validateNow(now);
    const session = ensureFreshSession(current);
    if (!session) {
      throw new PairingSessionError(
        "NO_ACTIVE_PAIRING_SESSION",
        "No active pairing session.",
      );
    }

    const parsedSecret = parsePairingSecret(pairingSecret);
    const candidateDigest = parsedSecret ? digestSecret(parsedSecret) : DUMMY_DIGEST;
    const matches = timingSafeEqual(session.secretDigest, candidateDigest);

    if (!matches) {
      const failedAttempts = session.failedAttempts + 1;
      if (failedAttempts >= session.maxFailedAttempts) {
        activeSession = null;
        throw new PairingSessionError(
          "PAIRING_ATTEMPTS_EXCEEDED",
          "Pairing attempt limit exceeded.",
        );
      }

      activeSession = Object.freeze({
        ...session,
        failedAttempts,
      });
      throw new PairingSessionError(
        "INVALID_PAIRING_SECRET",
        "Pairing secret was rejected.",
      );
    }

    activeSession = null;
    return Object.freeze({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      claimedAt: current.toISOString(),
    });
  }

  return Object.freeze({
    createSession,
    getActiveSession,
    claimSecret,
    cancelSession,
  });
}
