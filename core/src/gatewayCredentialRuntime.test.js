import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createGatewayCredentialStore,
  resolveDefaultGatewayCredentialDatabasePath,
} from "./gatewayCredentialStore.js";
import {
  GATEWAY_RUNTIME_TOCTOU_LIMITATION,
  GatewayCredentialRuntimeError,
  getProductionGatewayCredentialStorageStatus,
  openProductionGatewayCredentialIssuer,
  setupProductionGatewayCredentialStorage,
} from "./gatewayCredentialRuntime.js";
import {
  GatewayProvisioningError,
  PRODUCTION_WRITES_DISABLED_MESSAGE,
  issueGatewayCredential,
  revokeGatewayCredential,
} from "./gatewayProvisioning.js";

const SECRET_PATTERN = /selene_gateway_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/u;

function requireWindows(t) {
  if (process.platform !== "win32") {
    t.skip("Gateway credential runtime ACL verification is Windows-specific.");
  }
}

async function withIsolatedLocalAppData(t, operation) {
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const root = await mkdtemp(join(tmpdir(), "selene-gateway-runtime-test-"));
  process.env.LOCALAPPDATA = root;
  t.after(async () => {
    if (previousLocalAppData === undefined) {
      delete process.env.LOCALAPPDATA;
    } else {
      process.env.LOCALAPPDATA = previousLocalAppData;
    }
    await rm(root, { recursive: true, force: true });
  });

  return operation({
    root,
    databasePath: resolveDefaultGatewayCredentialDatabasePath({ LOCALAPPDATA: root }),
  });
}

async function removeDatabaseFiles(databasePath) {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-journal`, { force: true }),
  ]);
}

function openRawDatabase(databasePath) {
  return new DatabaseSync(databasePath);
}

test("explicit setup creates a reusable restricted production-style database", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, ({ databasePath }) => {
    const first = setupProductionGatewayCredentialStorage();
    assert.equal(first.ok, true);
    assert.equal(first.databasePath, databasePath);
    assert.equal(first.limitation, GATEWAY_RUNTIME_TOCTOU_LIMITATION);
    assert.equal(existsSync(databasePath), true);

    const issuer = openProductionGatewayCredentialIssuer();
    const issued = issuer.issueChatCredentialForPairedDevice({
      displayName: "Alex's iPhone",
    });
    issuer.close();

    assert.match(issued.bearerCredential, SECRET_PATTERN);
    assert.deepEqual(issued.credential.capabilities, ["chat"]);

    const second = setupProductionGatewayCredentialStorage();
    assert.equal(second.databasePath, databasePath);

    const store = createGatewayCredentialStore({ databasePath });
    try {
      const identity = store.authenticateCredential(issued.bearerCredential);
      assert.equal(identity.credentialId, issued.credential.id);
      assert.equal(identity.displayName, "Alex's iPhone");
      assert.deepEqual(identity.capabilities, ["chat"]);
    } finally {
      store.close();
    }
  });
});
test("runtime opening rejects missing directory and missing database without creating them", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, async ({ databasePath }) => {
    assert.throws(
      () => openProductionGatewayCredentialIssuer(),
      /security directory must already exist/u,
    );
    assert.equal(existsSync(databasePath), false);

    await mkdir(dirname(databasePath), { recursive: true });
    assert.throws(
      () => openProductionGatewayCredentialIssuer(),
      /database must already exist/u,
    );
    assert.equal(existsSync(databasePath), false);
  });
});
test("runtime opening rejects invalid ACLs before exposing an issuer", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, ({ databasePath }) => {
    const store = createGatewayCredentialStore({ databasePath });
    store.close();

    assert.throws(
      () => openProductionGatewayCredentialIssuer(),
      GatewayCredentialRuntimeError,
    );
  });
});
test("runtime opening rejects unsupported schemas and unsafe sidecars", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, async ({ databasePath }) => {
    setupProductionGatewayCredentialStorage();

    const database = openRawDatabase(databasePath);
    try {
      database.exec("PRAGMA user_version = 999");
    } finally {
      database.close();
    }
    assert.throws(
      () => openProductionGatewayCredentialIssuer(),
      /schema version 999 is not supported/u,
    );

    await removeDatabaseFiles(databasePath);
    setupProductionGatewayCredentialStorage();
    await rm(`${databasePath}-wal`, { force: true });
    await mkdir(`${databasePath}-wal`);
    assert.throws(
      () => openProductionGatewayCredentialIssuer(),
      /sidecars must be regular files/u,
    );
  });
});

test("runtime opening rejects detectable symbolic database substitution", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, async ({ databasePath }) => {
    setupProductionGatewayCredentialStorage();
    const target = join(tmpdir(), `selene-gateway-runtime-link-target-${randomUUID()}.sqlite3`);
    const targetStore = createGatewayCredentialStore({ databasePath: target });
    targetStore.close();
    await removeDatabaseFiles(databasePath);

    try {
      await symlink(target, databasePath, "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        await rm(target, { force: true });
        t.skip("Windows denied creating a symbolic link in this test environment.");
        return;
      }
      throw error;
    }

    try {
      assert.throws(
        () => openProductionGatewayCredentialIssuer(),
        /symbolic links or junctions|regular file|substituted path/u,
      );
    } finally {
      await rm(target, { force: true });
    }
  });
});

test("narrow runtime issuer does not expose full store operations or caller-controlled authority", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, ({ databasePath }) => {
    setupProductionGatewayCredentialStorage();
    const issuer = openProductionGatewayCredentialIssuer();
    try {
      assert.deepEqual(
        Object.keys(issuer).sort(),
        ["close", "issueChatCredentialForPairedDevice"],
      );
      assert.equal(issuer.listCredentials, undefined);
      assert.equal(issuer.revokeCredential, undefined);
      assert.equal(issuer.issueCredential, undefined);

      const issued = issuer.issueChatCredentialForPairedDevice({
        displayName: "  Alex's iPhone  ",
        id: "caller-selected-id",
        homeId: "caller-selected-home",
        capabilities: ["conversation:read", "conversation:write"],
        createdAt: "2001-01-01T00:00:00.000Z",
      });

      assert.match(issued.bearerCredential, SECRET_PATTERN);
      assert.notEqual(issued.credential.homeId, "caller-selected-home");
      assert.match(issued.credential.homeId, /^paired:[0-9a-f-]{36}$/u);
      assert.equal(issued.credential.displayName, "Alex's iPhone");
      assert.deepEqual(issued.credential.capabilities, ["chat"]);
      assert.notEqual(issued.credential.createdAt, "2001-01-01T00:00:00.000Z");

      const store = createGatewayCredentialStore({ databasePath });
      try {
        const identity = store.authenticateCredential(issued.bearerCredential);
        assert.deepEqual(identity.capabilities, ["chat"]);
      } finally {
        store.close();
      }
    } finally {
      issuer.close();
    }
  });
});

test("display names are bounded metadata and credential secrets are not persisted in public fields", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, ({ databasePath }) => {
    setupProductionGatewayCredentialStorage();
    const issuer = openProductionGatewayCredentialIssuer();
    try {
      assert.throws(
        () => issuer.issueChatCredentialForPairedDevice({ displayName: "" }),
        /Device display name/u,
      );
      assert.throws(
        () => issuer.issueChatCredentialForPairedDevice({ displayName: `${"a".repeat(81)}` }),
        /Device display name/u,
      );
      assert.throws(
        () => issuer.issueChatCredentialForPairedDevice({ displayName: "bad\nname" }),
        /Device display name/u,
      );

      const issued = issuer.issueChatCredentialForPairedDevice({ displayName: "iPhone" });
      const encodedSecret = issued.bearerCredential.split(".")[2];
      const database = openRawDatabase(databasePath);
      try {
        const rows = database.prepare(`
          SELECT id, home_id, display_name, secret_digest, created_at, revoked_at
          FROM gateway_credentials
        `).all();
        const serializedPublicColumns = JSON.stringify(rows.map((row) => ({
          id: row.id,
          home_id: row.home_id,
          display_name: row.display_name,
          created_at: row.created_at,
          revoked_at: row.revoked_at,
        })));
        assert.ok(!serializedPublicColumns.includes(encodedSecret));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].secret_digest.byteLength, 32);
        assert.notEqual(Buffer.from(rows[0].secret_digest).toString("base64url"), encodedSecret);
      } finally {
        database.close();
      }
    } finally {
      issuer.close();
    }
  });
});

test("storage status is safe and production provisioning issue/revoke stay disabled", async (t) => {
  requireWindows(t);
  await withIsolatedLocalAppData(t, () => {
    const unavailable = getProductionGatewayCredentialStorageStatus();
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.limitation, GATEWAY_RUNTIME_TOCTOU_LIMITATION);
    assert.doesNotMatch(JSON.stringify(unavailable), SECRET_PATTERN);

    setupProductionGatewayCredentialStorage();
    const ready = getProductionGatewayCredentialStorageStatus();
    assert.equal(ready.ok, true);
    assert.equal(ready.limitation, GATEWAY_RUNTIME_TOCTOU_LIMITATION);

    assert.throws(
      () => issueGatewayCredential({
        homeId: "iphone",
        displayName: "iPhone",
        capabilities: ["chat"],
        deliverCredential() {},
      }),
      (error) => error instanceof GatewayProvisioningError
        && error.message === PRODUCTION_WRITES_DISABLED_MESSAGE,
    );
    assert.throws(
      () => revokeGatewayCredential({ credentialId: randomUUID() }),
      (error) => error instanceof GatewayProvisioningError
        && error.message === PRODUCTION_WRITES_DISABLED_MESSAGE,
    );
  });
});
