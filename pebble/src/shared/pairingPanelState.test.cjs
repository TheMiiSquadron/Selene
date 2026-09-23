const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInitialPairingState,
  withBusy,
  withSecureCoreBusy,
  clearSecret,
  applyUnavailable,
  applyStatus,
  applySecureCoreStartResult,
  applyStartResult,
  applyCancelResult,
  expireIfNeeded,
} = require("./pairingPanelState.cjs");

const NOW = Date.parse("2026-09-23T00:00:00.000Z");
const ACTIVE_SESSION = Object.freeze({
  id: "session-1",
  createdAt: "2026-09-23T00:00:00.000Z",
  expiresAt: "2026-09-23T00:05:00.000Z",
  failedAttempts: 0,
  failedAttemptsRemaining: 5,
});

test("initial state is unavailable and secret-free", () => {
  const state = createInitialPairingState();

  assert.equal(state.availability, "unavailable");
  assert.equal(state.phase, "unavailable");
  assert.equal(state.pairingSecret, null);
});

test("no Core and external Core status select explicit transition states", () => {
  const noCore = applyStatus(createInitialPairingState(), {
    ok: true,
    available: false,
    state: "no-core",
    message: "Device pairing requires Core to run securely under Pebble.",
  }, NOW);
  const external = applyStatus(noCore, {
    ok: true,
    available: false,
    state: "external-core",
    message: "Core is running externally. Close it manually, then check again.",
  }, NOW);

  assert.equal(noCore.phase, "no-core");
  assert.equal(noCore.pairingSecret, null);
  assert.equal(external.phase, "external-core");
  assert.equal(external.pairingSecret, null);
});

test("Secure Core start result enables pairing only after success", () => {
  const launched = applySecureCoreStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    state: "ready",
    message: "Secure Core connected. Ready to pair a device.",
  });
  const failed = applySecureCoreStartResult(launched, {
    ok: false,
    state: "secure-core-failed",
    message: "Secure Core launch failed.",
  });

  assert.equal(launched.availability, "available");
  assert.equal(launched.phase, "ready");
  assert.equal(launched.pairingSecret, null);
  assert.equal(failed.availability, "unavailable");
  assert.equal(failed.phase, "secure-core-failed");
});

test("status active never invents or reveals a pairing secret", () => {
  const pairingSecret = "I".repeat(43);
  const state = applyStatus(createInitialPairingState(), {
    ok: true,
    available: true,
    session: ACTIVE_SESSION,
  }, NOW);

  assert.equal(state.phase, "active");
  assert.equal(state.pairingSecret, null);
  assert.doesNotMatch(JSON.stringify(state), new RegExp(pairingSecret));
});

test("explicit start stores the returned secret only for the active display state", () => {
  const pairingSecret = "C".repeat(43);
  const state = applyStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    pairingSecret,
    session: ACTIVE_SESSION,
  }, NOW);

  assert.equal(state.phase, "active");
  assert.equal(state.pairingSecret, pairingSecret);
});

test("replacement start replaces the displayed secret", () => {
  const firstSecret = "D".repeat(43);
  const secondSecret = "E".repeat(43);
  const first = applyStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    pairingSecret: firstSecret,
    session: ACTIVE_SESSION,
  }, NOW);
  const second = applyStartResult(first, {
    ok: true,
    available: true,
    pairingSecret: secondSecret,
    session: {
      ...ACTIVE_SESSION,
      id: "session-2",
    },
  }, NOW);

  assert.equal(second.pairingSecret, secondSecret);
  assert.doesNotMatch(JSON.stringify(second), new RegExp(firstSecret));
});

test("status inactive, unavailable, cancel, and explicit clear remove the secret", () => {
  const pairingSecret = "F".repeat(43);
  const active = applyStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    pairingSecret,
    session: ACTIVE_SESSION,
  }, NOW);

  assert.equal(applyStatus(active, { ok: true, available: true, session: null }, NOW).pairingSecret, null);
  assert.equal(applyUnavailable(active).pairingSecret, null);
  assert.equal(applyCancelResult(active, { ok: true, available: true, cancelled: true, session: null }).pairingSecret, null);
  assert.equal(clearSecret(active).pairingSecret, null);
});

test("failed or unconfirmed cancel clears the secret without claiming success", () => {
  const pairingSecret = "G".repeat(43);
  const active = applyStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    pairingSecret,
    session: ACTIVE_SESSION,
  }, NOW);
  const cancelled = applyCancelResult(active, {
    ok: false,
    message: "Secure Core pairing cancellation could not be confirmed.",
  });

  assert.equal(cancelled.phase, "error");
  assert.equal(cancelled.cancelUnconfirmed, true);
  assert.equal(cancelled.pairingSecret, null);
  assert.doesNotMatch(JSON.stringify(cancelled), new RegExp(pairingSecret));
});

test("expiration clears the displayed plaintext secret and does not restart pairing", () => {
  const pairingSecret = "H".repeat(43);
  const active = applyStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    pairingSecret,
    session: ACTIVE_SESSION,
  }, NOW);
  const expired = expireIfNeeded(
    active,
    Date.parse("2026-09-23T00:05:00.000Z"),
  );

  assert.equal(expired.phase, "expired");
  assert.equal(expired.pairingSecret, null);
  assert.doesNotMatch(JSON.stringify(expired), new RegExp(pairingSecret));
});

test("busy state does not expose secret through ordinary status transitions", () => {
  const state = withBusy(createInitialPairingState(), true);

  assert.equal(state.busy, true);
  assert.equal(state.pairingSecret, null);
});

test("Secure Core launch busy state clears any displayed pairing secret", () => {
  const active = applyStartResult(createInitialPairingState(), {
    ok: true,
    available: true,
    pairingSecret: "J".repeat(43),
    session: ACTIVE_SESSION,
  }, NOW);
  const busy = withSecureCoreBusy(active, true);

  assert.equal(busy.secureCoreBusy, true);
  assert.equal(busy.pairingSecret, null);
});
