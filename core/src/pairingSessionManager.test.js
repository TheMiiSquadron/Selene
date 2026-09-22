import test from "node:test";
import assert from "node:assert/strict";
import {
  PairingSessionError,
  PAIRING_SECRET_BYTES,
  PAIRING_SESSION_TTL_MS,
  createPairingSessionManager,
} from "./pairingSessionManager.js";

function fixedSecret(fill) {
  return Buffer.alloc(PAIRING_SECRET_BYTES, fill);
}

function secretText(fill) {
  return fixedSecret(fill).toString("base64url");
}

function assertPairingError(operation, code) {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof PairingSessionError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /[A-Za-z0-9_-]{32,}/);
    return error;
  }
  assert.fail(`Expected pairing error ${code}.`);
}

test("creating a session returns a high-entropy secret and public metadata only", () => {
  const manager = createPairingSessionManager({
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    generateId: () => "pairing-1",
    generateSecret: () => fixedSecret(0x1f),
  });

  const { pairingSecret, session } = manager.createSession();

  assert.equal(pairingSecret, secretText(0x1f));
  assert.equal(pairingSecret.length, 43);
  assert.equal(session.id, "pairing-1");
  assert.equal(session.createdAt, "2026-09-22T12:00:00.000Z");
  assert.equal(session.expiresAt, "2026-09-22T12:05:00.000Z");
  assert.equal(session.failedAttempts, 0);
  assert.equal(session.failedAttemptsRemaining, 5);
  assert.deepEqual(manager.getActiveSession(), session);
  assert.doesNotMatch(JSON.stringify(session), new RegExp(pairingSecret));
  assert.doesNotMatch(JSON.stringify(manager.getActiveSession()), new RegExp(pairingSecret));
});

test("successful claim is single-use and clears the active session", () => {
  let current = new Date("2026-09-22T12:00:00.000Z");
  const manager = createPairingSessionManager({
    now: () => current,
    generateId: () => "pairing-claim",
    generateSecret: () => fixedSecret(0x2a),
  });
  const { pairingSecret } = manager.createSession();
  current = new Date("2026-09-22T12:01:00.000Z");

  assert.deepEqual(manager.claimSecret(pairingSecret), {
    id: "pairing-claim",
    createdAt: "2026-09-22T12:00:00.000Z",
    expiresAt: "2026-09-22T12:05:00.000Z",
    claimedAt: "2026-09-22T12:01:00.000Z",
  });
  assert.equal(manager.getActiveSession(), null);
  assertPairingError(
    () => manager.claimSecret(pairingSecret),
    "NO_ACTIVE_PAIRING_SESSION",
  );
});

test("expired sessions are rejected and removed from memory", () => {
  let current = new Date("2026-09-22T12:00:00.000Z");
  const manager = createPairingSessionManager({
    now: () => current,
    generateSecret: () => fixedSecret(0x3b),
  });
  const { pairingSecret } = manager.createSession();
  current = new Date("2026-09-22T12:05:00.000Z");

  assertPairingError(
    () => manager.claimSecret(pairingSecret),
    "PAIRING_EXPIRED",
  );
  assert.equal(manager.getActiveSession(), null);
});

test("incorrect secrets are rejected and attempts are limited", () => {
  const manager = createPairingSessionManager({
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    generateSecret: () => fixedSecret(0x4c),
    maxFailedAttempts: 3,
  });
  manager.createSession();

  assertPairingError(
    () => manager.claimSecret(secretText(0x00)),
    "INVALID_PAIRING_SECRET",
  );
  assert.equal(manager.getActiveSession().failedAttempts, 1);
  assertPairingError(
    () => manager.claimSecret("not-a-valid-secret"),
    "INVALID_PAIRING_SECRET",
  );
  assert.equal(manager.getActiveSession().failedAttempts, 2);
  assertPairingError(
    () => manager.claimSecret(secretText(0x01)),
    "PAIRING_ATTEMPTS_EXCEEDED",
  );
  assert.equal(manager.getActiveSession(), null);
});

test("explicit cancellation clears the active session", () => {
  const manager = createPairingSessionManager({
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    generateSecret: () => fixedSecret(0x5d),
  });
  const { pairingSecret } = manager.createSession();

  assert.equal(manager.cancelSession(), true);
  assert.equal(manager.cancelSession(), false);
  assert.equal(manager.getActiveSession(), null);
  assertPairingError(
    () => manager.claimSecret(pairingSecret),
    "NO_ACTIVE_PAIRING_SESSION",
  );
});

test("creating a new session replaces the previous active session", () => {
  const secrets = [fixedSecret(0x6e), fixedSecret(0x7f)];
  let secretIndex = 0;
  let idIndex = 0;
  const manager = createPairingSessionManager({
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    generateId: () => `pairing-${++idIndex}`,
    generateSecret: () => secrets[secretIndex++],
  });
  const first = manager.createSession();
  const second = manager.createSession();

  assert.notEqual(first.pairingSecret, second.pairingSecret);
  assert.equal(manager.getActiveSession().id, "pairing-2");
  assertPairingError(
    () => manager.claimSecret(first.pairingSecret),
    "INVALID_PAIRING_SECRET",
  );
  assert.equal(manager.claimSecret(second.pairingSecret).id, "pairing-2");
});

test("custom TTL uses the configured expiration interval", () => {
  const manager = createPairingSessionManager({
    now: () => new Date("2026-09-22T12:00:00.000Z"),
    generateSecret: () => fixedSecret(0x8a),
    ttlMs: 60_000,
  });

  assert.equal(
    manager.createSession().session.expiresAt,
    "2026-09-22T12:01:00.000Z",
  );
  assert.equal(PAIRING_SESSION_TTL_MS, 300_000);
});

test("invalid injected dependencies fail closed", () => {
  assert.throws(
    () => createPairingSessionManager({ ttlMs: 0 }),
    PairingSessionError,
  );
  assert.throws(
    () => createPairingSessionManager({ maxFailedAttempts: 0 }),
    PairingSessionError,
  );

  const badSecretManager = createPairingSessionManager({
    generateSecret: () => Buffer.alloc(PAIRING_SECRET_BYTES - 1),
  });
  assertPairingError(
    () => badSecretManager.createSession(),
    "INVALID_SECRET_GENERATOR",
  );

  const badClockManager = createPairingSessionManager({
    now: () => new Date("bad"),
  });
  assertPairingError(
    () => badClockManager.createSession(),
    "INVALID_CLOCK",
  );
});
