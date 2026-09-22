import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createLocalPairingAdministration,
  PairingAdministrationError,
} from "./pairingAdministration.js";
import {
  PAIRING_SECRET_BYTES,
  createPairingSessionManager,
} from "./pairingSessionManager.js";
import {
  closeSeleneServers,
  createCoreServer,
  startSeleneServers,
} from "./server.js";

function fixedSecret(fill) {
  return Buffer.alloc(PAIRING_SECRET_BYTES, fill);
}

function assertAdminError(operation, code) {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof PairingAdministrationError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /[A-Za-z0-9_-]{32,}/);
    return;
  }
  assert.fail(`Expected pairing administration error ${code}.`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function request({ port, method = "GET", path = "/pairing/status" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
    }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(body),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("ordinary callers cannot start pairing", () => {
  const sessionManager = createPairingSessionManager({
    generateSecret: () => fixedSecret(0x11),
  });
  const admin = createLocalPairingAdministration({ sessionManager });

  assertAdminError(
    () => admin.startPairing(),
    "TRUSTED_PAIRING_APPROVAL_UNAVAILABLE",
  );
  assertAdminError(
    () => admin.startPairing({
      approval: { type: "selene.local-pairing-approval" },
      token: "caller-controlled",
    }),
    "TRUSTED_PAIRING_APPROVAL_UNAVAILABLE",
  );
  assert.equal(sessionManager.getActiveSession(), null);
});

test("ordinary callers cannot cancel pairing", () => {
  const sessionManager = createPairingSessionManager({
    generateSecret: () => fixedSecret(0x22),
  });
  const admin = createLocalPairingAdministration({ sessionManager });
  sessionManager.createSession();

  assertAdminError(
    () => admin.cancelPairing(),
    "TRUSTED_PAIRING_APPROVAL_UNAVAILABLE",
  );
  assertAdminError(
    () => admin.cancelPairing({
      approval: { type: "selene.local-pairing-approval" },
      token: "caller-controlled",
    }),
    "TRUSTED_PAIRING_APPROVAL_UNAVAILABLE",
  );
  assert.notEqual(admin.getPairingStatus().session, null);
});

test("status never reveals the pairing secret", () => {
  const secret = fixedSecret(0x33).toString("base64url");
  const sessionManager = createPairingSessionManager({
    generateId: () => "pairing-status",
    generateSecret: () => fixedSecret(0x33),
  });
  const admin = createLocalPairingAdministration({ sessionManager });
  sessionManager.createSession();

  const status = admin.getPairingStatus();

  assert.equal(status.session.id, "pairing-status");
  assert.equal(status.session.pairingSecret, undefined);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));
});

test("shutdown invalidates the active pairing session", () => {
  const sessionManager = createPairingSessionManager({
    generateSecret: () => fixedSecret(0x44),
  });
  const admin = createLocalPairingAdministration({ sessionManager });
  const { pairingSecret } = sessionManager.createSession();

  assert.deepEqual(admin.shutdown(), { ok: true, cancelled: true });
  assert.deepEqual(admin.shutdown(), { ok: true, cancelled: false });
  assert.equal(admin.getPairingStatus().session, null);
  assert.throws(
    () => sessionManager.claimSecret(pairingSecret),
    { code: "NO_ACTIVE_PAIRING_SESSION" },
  );
});

test("a new in-process administration instance has no previous sessions", () => {
  const firstSessionManager = createPairingSessionManager({
    generateSecret: () => fixedSecret(0x55),
  });
  firstSessionManager.createSession();
  const restarted = createLocalPairingAdministration({
    sessionManager: createPairingSessionManager({
      generateSecret: () => fixedSecret(0x66),
    }),
  });

  assert.equal(restarted.getPairingStatus().session, null);
});

test("startSeleneServers returns one shared long-lived pairing administration instance", async () => {
  const sessionManager = createPairingSessionManager({
    generateSecret: () => fixedSecret(0x77),
  });
  const admin = createLocalPairingAdministration({ sessionManager });
  const listeners = await startSeleneServers({
    env: {},
    corePort: 0,
    companionPort: 0,
    pairingAdministration: admin,
    credentialStore: {
      authenticate() {
        return null;
      },
    },
    onCoreListening() {},
    onCompanionListening() {},
    onCompanionError() {},
  });

  try {
    const created = sessionManager.createSession();
    assert.equal(listeners.pairingAdministration, admin);
    assert.equal(listeners.pairingAdministration.getPairingStatus().session.id, created.session.id);
  } finally {
    await closeSeleneServers(listeners);
  }
});

test("closeSeleneServers invalidates the shared pairing session", async () => {
  const sessionManager = createPairingSessionManager({
    generateSecret: () => fixedSecret(0x88),
  });
  const admin = createLocalPairingAdministration({ sessionManager });
  const listeners = await startSeleneServers({
    env: {},
    corePort: 0,
    companionPort: 0,
    pairingAdministration: admin,
    credentialStore: {
      authenticate() {
        return null;
      },
    },
    onCoreListening() {},
    onCompanionListening() {},
    onCompanionError() {},
  });
  const { pairingSecret } = sessionManager.createSession();

  await closeSeleneServers(listeners);

  assert.equal(admin.getPairingStatus().session, null);
  assert.throws(
    () => sessionManager.claimSecret(pairingSecret),
    { code: "NO_ACTIVE_PAIRING_SESSION" },
  );
});

test("pairing administration is not exposed as a Core HTTP endpoint", async () => {
  const server = createCoreServer();
  const port = await listen(server);

  try {
    const getStatus = await request({ port });
    const postStart = await request({ port, method: "POST", path: "/pairing/start" });
    const postCancel = await request({ port, method: "POST", path: "/pairing/cancel" });

    assert.equal(getStatus.statusCode, 404);
    assert.equal(postStart.statusCode, 404);
    assert.equal(postCancel.statusCode, 404);
  } finally {
    await close(server);
  }
});
