const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInitialPairingState,
  withBusy,
  clearSecret,
  applyUnavailable,
  applyStatus,
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
