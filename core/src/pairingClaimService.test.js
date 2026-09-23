import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGatewayCredentialStore } from "./gatewayCredentialStore.js";
import { createPairingClaimService, PairingClaimError } from "./pairingClaimService.js";
import { createPairingSessionManager } from "./pairingSessionManager.js";

const SECRET_PATTERN = /selene_gateway_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/u;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "selene-pairing-claim-test-"));
  const databasePath = join(directory, "gateway-credentials.sqlite3");
  const store = createGatewayCredentialStore({ databasePath });
  const manager = createPairingSessionManager(options.managerOptions);
  const issuer = Object.hasOwn(options, "issuer") ? options.issuer : {
    issueChatCredentialForPairedDevice({ displayName }) {
      return store.issueCredential({
        homeId: "paired-test-home",
        displayName,
        capabilities: ["chat"],
      });
    },
  };
  const service = createPairingClaimService({
    claimPairingSecret: manager.claimSecret,
    credentialIssuer: issuer,
    getCredentialIssuer: options.getCredentialIssuer,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { databasePath, store, manager, service };
}

function assertPairingFailed(operation) {
  assert.throws(
    operation,
    (error) => error instanceof PairingClaimError
      && error.code === "PAIRING_FAILED"
      && error.message === "Pairing failed.",
  );
}

test("valid claim succeeds once and persists only a chat credential digest", async (t) => {
  const f = await fixture(t);
  const { pairingSecret } = f.manager.createSession();

  const result = f.service.claim({
    secret: pairingSecret,
    deviceName: "  Alex’s iPhone 📱  ",
  });

  assert.deepEqual(Object.keys(result).sort(), ["credential", "paired"]);
  assert.equal(result.paired, true);
  assert.match(result.credential, SECRET_PATTERN);
  assert.equal(f.manager.getActiveSession(), null);

  const identity = f.store.authenticateCredential(result.credential);
  assert.equal(identity.displayName, "Alex’s iPhone 📱");
  assert.deepEqual(identity.capabilities, ["chat"]);

  const database = new DatabaseSync(f.databasePath);
  try {
    const rows = database.prepare(`
      SELECT id, home_id, display_name, secret_digest
      FROM gateway_credentials
    `).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].secret_digest.byteLength, 32);
    assert.ok(!JSON.stringify(rows.map(({ id, home_id, display_name }) => ({
      id,
      home_id,
      display_name,
    }))).includes(result.credential.split(".")[2]));
  } finally {
    database.close();
  }

  assertPairingFailed(() => f.service.claim({
    secret: pairingSecret,
    deviceName: "Alex’s iPhone 📱",
  }));
});

test("wrong, expired, cancelled, reused and attempt-limited claims share one external failure", async (t) => {
  const wrong = await fixture(t);
  wrong.manager.createSession();
  assertPairingFailed(() => wrong.service.claim({
    secret: "wrong",
    deviceName: "iPhone",
  }));

  let now = new Date("2026-09-23T00:00:00Z");
  const expired = await fixture(t, {
    managerOptions: { now: () => now, ttlMs: 1 },
  });
  const expiredSession = expired.manager.createSession();
  now = new Date("2026-09-23T00:00:00.002Z");
  assertPairingFailed(() => expired.service.claim({
    secret: expiredSession.pairingSecret,
    deviceName: "iPhone",
  }));

  const cancelled = await fixture(t);
  const cancelledSession = cancelled.manager.createSession();
  cancelled.manager.cancelSession();
  assertPairingFailed(() => cancelled.service.claim({
    secret: cancelledSession.pairingSecret,
    deviceName: "iPhone",
  }));

  const reused = await fixture(t);
  const reusedSession = reused.manager.createSession();
  reused.service.claim({ secret: reusedSession.pairingSecret, deviceName: "iPhone" });
  assertPairingFailed(() => reused.service.claim({
    secret: reusedSession.pairingSecret,
    deviceName: "iPhone",
  }));

  const limited = await fixture(t, {
    managerOptions: { maxFailedAttempts: 1 },
  });
  limited.manager.createSession();
  assertPairingFailed(() => limited.service.claim({ secret: "wrong", deviceName: "iPhone" }));
  assert.equal(limited.manager.getActiveSession(), null);
});

test("invalid request shape and device names are rejected before session claim", async (t) => {
  let claimCalls = 0;
  const service = createPairingClaimService({
    claimPairingSecret() {
      claimCalls += 1;
    },
    credentialIssuer: {
      issueChatCredentialForPairedDevice() {
        throw new Error("should not issue");
      },
    },
  });

  for (const request of [
    null,
    [],
    {},
    { secret: "secret", deviceName: "iPhone", capabilities: ["chat"] },
    { secret: "", deviceName: "iPhone" },
    { secret: "secret", deviceName: "" },
    { secret: "secret", deviceName: "   " },
    { secret: "secret", deviceName: "a".repeat(81) },
    { secret: "secret", deviceName: "bad\nname" },
  ]) {
    assert.throws(
      () => service.claim(request),
      (error) => error instanceof PairingClaimError
        && error.code === "INVALID_REQUEST",
    );
  }
  assert.equal(claimCalls, 0);
});

test("credential issuer is requested lazily only for validly shaped claims", async (t) => {
  let openCalls = 0;
  let claimCalls = 0;
  const service = createPairingClaimService({
    claimPairingSecret() {
      claimCalls += 1;
    },
    getCredentialIssuer() {
      openCalls += 1;
      throw new Error("private ACL details");
    },
  });

  assert.equal(openCalls, 0);
  assert.throws(
    () => service.claim({ secret: "secret", deviceName: "" }),
    (error) => error instanceof PairingClaimError
      && error.code === "INVALID_REQUEST",
  );
  assert.equal(openCalls, 0);
  assert.equal(claimCalls, 0);

  assert.throws(
    () => service.claim({ secret: "secret", deviceName: "iPhone" }),
    (error) => error instanceof PairingClaimError
      && error.code === "PAIRING_UNAVAILABLE"
      && !/acl|private|sqlite|secret|bearer/i.test(error.message),
  );
  assert.equal(openCalls, 1);
  assert.equal(claimCalls, 0);
});

test("issuer unavailable does not consume the active pairing secret", async (t) => {
  const f = await fixture(t, { issuer: null });
  const { pairingSecret } = f.manager.createSession();
  assert.throws(
    () => f.service.claim({ secret: pairingSecret, deviceName: "iPhone" }),
    (error) => error instanceof PairingClaimError
      && error.code === "PAIRING_UNAVAILABLE",
  );
  assert.notEqual(f.manager.getActiveSession(), null);
});

test("later issuer availability can claim without restarting the service", async (t) => {
  const f = await fixture(t, {
    issuer: null,
    getCredentialIssuer() {
      return f.currentIssuer;
    },
  });
  const { pairingSecret } = f.manager.createSession();

  assert.throws(
    () => f.service.claim({ secret: pairingSecret, deviceName: "iPhone" }),
    (error) => error instanceof PairingClaimError
      && error.code === "PAIRING_UNAVAILABLE",
  );
  assert.notEqual(f.manager.getActiveSession(), null);

  f.currentIssuer = {
    issueChatCredentialForPairedDevice({ displayName }) {
      return f.store.issueCredential({
        homeId: "paired-later-home",
        displayName,
        capabilities: ["chat"],
      });
    },
  };

  const result = f.service.claim({ secret: pairingSecret, deviceName: "iPhone" });
  assert.equal(result.paired, true);
  assert.match(result.credential, SECRET_PATTERN);
  assert.equal(f.manager.getActiveSession(), null);
});

test("issuance failure after a successful secret claim does not restore the session", async (t) => {
  const f = await fixture(t, {
    issuer: {
      issueChatCredentialForPairedDevice() {
        throw new Error("private sqlite details");
      },
    },
  });
  const { pairingSecret } = f.manager.createSession();
  assert.throws(
    () => f.service.claim({ secret: pairingSecret, deviceName: "iPhone" }),
    (error) => error instanceof PairingClaimError
      && error.code === "PAIRING_UNAVAILABLE"
      && !/sqlite|private|secret|bearer/i.test(error.message),
  );
  assert.equal(f.manager.getActiveSession(), null);
  assertPairingFailed(() => f.service.claim({ secret: pairingSecret, deviceName: "iPhone" }));
});
