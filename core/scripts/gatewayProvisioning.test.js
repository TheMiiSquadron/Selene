import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGatewayCredentialStore,
  resolveDefaultGatewayCredentialDatabasePath,
} from "../src/gatewayCredentialStore.js";
import {
  CREDENTIAL_DELIVERY_FAILED_MESSAGE,
  CREDENTIAL_DELIVERY_UNRESOLVED_MESSAGE,
  GatewayProvisioningError,
  PRODUCTION_WRITES_DISABLED_MESSAGE,
  issueGatewayCredential,
  listGatewayCredentials,
  revokeGatewayCredential,
} from "../src/gatewayProvisioning.js";
import {
  createDisposableGatewayCredentialDatabase,
  issueDisposableGatewayCredential,
  issueDisposableGatewayCredentialWithStoreForTesting,
  listDisposableGatewayCredentials,
  revokeDisposableGatewayCredential,
} from "./gatewayProvisioning.testSupport.js";

const cliPath = fileURLToPath(
  new URL("./gatewayProvisioning.js", import.meta.url),
);
const SECRET_PATTERN = /selene_gateway_v1|secret|digest|bearer/i;

function runCli(args, env = {}) {
  return spawnSync(
    process.execPath,
    [cliPath, ...args],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

test("production CLI rejects arbitrary database paths", () => {
  const result = runCli(["list", "--database", "C:\\test.sqlite3"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout + result.stderr, SECRET_PATTERN);
});

test("production CLI rejects a missing database without creating it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-provisioning-production-"));
  const databasePath = resolveDefaultGatewayCredentialDatabasePath({
    LOCALAPPDATA: directory,
  });

  try {
    const result = runCli(["list"], { LOCALAPPDATA: directory });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must already exist as a regular file/);
    assert.doesNotMatch(result.stdout + result.stderr, SECRET_PATTERN);
    await assert.rejects(access(databasePath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production write commands fail closed without exposing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-provisioning-production-write-"));
  const databasePath = resolveDefaultGatewayCredentialDatabasePath({
    LOCALAPPDATA: directory,
  });
  const store = createGatewayCredentialStore({ databasePath });
  store.close();

  try {
    const issue = runCli(
      ["issue", "--home-id", "nova", "--display-name", "NOVA"],
      { LOCALAPPDATA: directory },
    );
    assert.equal(issue.status, 1);
    assert.match(issue.stderr, /write operations are disabled/);
    assert.doesNotMatch(issue.stdout + issue.stderr, SECRET_PATTERN);

    const revoke = runCli(
      ["revoke", "--id", "00000000-0000-4000-8000-000000000000"],
      { LOCALAPPDATA: directory },
    );
    assert.equal(revoke.status, 1);
    assert.match(revoke.stderr, /write operations are disabled/);
    assert.doesNotMatch(revoke.stdout + revoke.stderr, SECRET_PATTERN);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("list displays metadata without revealing bearer secrets", async () => {
  const database = await createDisposableGatewayCredentialDatabase();

  try {
    const store = createGatewayCredentialStore({ databasePath: database.databasePath });
    let issued;

    try {
      issued = store.issueCredential({
        homeId: "test-home",
        displayName: "Test Home",
        capabilities: ["chat"],
      });
    } finally {
      store.close();
    }

    const credentials = listDisposableGatewayCredentials({
      disposableDatabase: database,
    });

    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].id, issued.credential.id);
    assert.equal(credentials[0].homeId, "test-home");
    assert.equal(credentials[0].displayName, "Test Home");
    assert.equal(credentials[0].capabilities, "chat");

    assert.doesNotMatch(JSON.stringify(credentials), SECRET_PATTERN);
    assert.ok(
      !JSON.stringify(credentials).includes(issued.bearerCredential),
      "Bearer credential must not appear in listing results.",
    );
  } finally {
    await database.cleanup();
  }
});

test("guard rejects a missing database without creating it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-provisioning-missing-"));
  const databasePath = join(directory, "missing.sqlite3");

  try {
    assert.throws(
      () => listGatewayCredentials({
        databasePath,
        expectedDatabasePath: databasePath,
      }),
      /Gateway credential database must already exist as a regular file/,
    );

    await assert.rejects(access(databasePath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disposable listing rejects direct symbolic-link path input", async (t) => {
  const database = await createDisposableGatewayCredentialDatabase();
  const { directory, databasePath } = database;
  const linkPath = join(directory, "linked.sqlite3");

  try {
    try {
      await symlink(databasePath, linkPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`File symbolic links unavailable: ${error.code}`);
        return;
      }

      throw error;
    }

    assert.throws(
      () => listDisposableGatewayCredentials({
        databasePath: linkPath,
      }),
      /disposable Gateway credential database fixture is required/,
    );
  } finally {
    await database.cleanup();
  }
});

test("production listing ignores caller-supplied path and inspector overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-provisioning-production-list-"));
  const arbitraryDirectory = await mkdtemp(join(tmpdir(), "selene-provisioning-arbitrary-"));
  const productionPath = resolveDefaultGatewayCredentialDatabasePath({
    LOCALAPPDATA: directory,
  });
  const arbitraryPath = join(arbitraryDirectory, "gateway-credentials.sqlite3");
  const arbitraryStore = createGatewayCredentialStore({ databasePath: arbitraryPath });
  arbitraryStore.issueCredential({
    homeId: "attacker",
    displayName: "Path Override",
    capabilities: ["chat"],
  });
  arbitraryStore.close();

  try {
    assert.throws(
      () => listGatewayCredentials({
        databasePath: arbitraryPath,
        expectedDatabasePath: arbitraryPath,
        allowNonProductionDatabasePath: true,
        securityInspector() {
          return { filesystemIdentityVerified: true };
        },
      }),
      /Gateway credential database must already exist as a regular file/,
    );
    await assert.rejects(access(productionPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(arbitraryDirectory, { recursive: true, force: true });
  }
});

test("issuance is chat-only and uses a deliberate one-time delivery callback", async () => {
  const database = await createDisposableGatewayCredentialDatabase();
  const delivered = [];

  try {
    const credential = issueDisposableGatewayCredential({
      disposableDatabase: database,
      homeId: "nova",
      displayName: "NOVA",
      deliverCredential(bearerCredential, publicCredential) {
        delivered.push({ bearerCredential, publicCredential });
      },
    });

    assert.equal(credential.homeId, "nova");
    assert.deepEqual(credential.capabilities, ["chat"]);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].bearerCredential, /^selene_gateway_v1\./);
    assert.deepEqual(delivered[0].publicCredential, credential);
    assert.doesNotMatch(JSON.stringify(credential), SECRET_PATTERN);

    const store = createGatewayCredentialStore({ databasePath: database.databasePath });
    assert.equal(
      store.authenticateCredential(delivered[0].bearerCredential).credentialId,
      credential.id,
    );
    store.close();

    assert.throws(
      () => issueDisposableGatewayCredential({
        disposableDatabase: database,
        homeId: "nova",
        displayName: "NOVA",
      }),
      /delivery callback/,
    );
    assert.throws(
      () => issueDisposableGatewayCredential({
        disposableDatabase: database,
        homeId: "nova",
        displayName: "NOVA",
        capabilities: ["conversation:read"],
        deliverCredential() {},
      }),
      /restricted to the chat capability/,
    );
  } finally {
    await database.cleanup();
  }
});

test("revocation rejects malformed IDs and prevents later authentication", async () => {
  const database = await createDisposableGatewayCredentialDatabase();
  let bearerCredential;
  let credentialId;

  try {
    const credential = issueDisposableGatewayCredential({
      disposableDatabase: database,
      homeId: "nova",
      displayName: "NOVA",
      deliverCredential(secret, publicCredential) {
        bearerCredential = secret;
        credentialId = publicCredential.id;
      },
    });
    assert.equal(credential.id, credentialId);

    assert.throws(
      () => revokeDisposableGatewayCredential({
        disposableDatabase: database,
        credentialId: "not-a-uuid",
      }),
      /Credential ID must be a UUID/,
    );

    assert.equal(revokeDisposableGatewayCredential({
      disposableDatabase: database,
      credentialId,
    }), true);

    const store = createGatewayCredentialStore({ databasePath: database.databasePath });
    assert.throws(
      () => store.authenticateCredential(bearerCredential),
      /Gateway credential authentication failed/,
    );
    store.close();
  } finally {
    await database.cleanup();
  }
});

test("production writes remain disabled even with caller-provided guard options", async () => {
  const database = await createDisposableGatewayCredentialDatabase();

  try {
    assert.throws(
      () => issueGatewayCredential({
        databasePath: database.databasePath,
        expectedDatabasePath: database.databasePath,
        allowNonProductionDatabasePath: true,
        securityInspector() {
          return { filesystemIdentityVerified: true };
        },
        homeId: "nova",
        displayName: "NOVA",
        deliverCredential() {},
      }),
      new RegExp(PRODUCTION_WRITES_DISABLED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.throws(
      () => revokeGatewayCredential({
        databasePath: database.databasePath,
        expectedDatabasePath: database.databasePath,
        allowNonProductionDatabasePath: true,
        securityInspector() {
          return { filesystemIdentityVerified: true };
        },
        credentialId: "00000000-0000-4000-8000-000000000000",
      }),
      new RegExp(PRODUCTION_WRITES_DISABLED_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const store = createGatewayCredentialStore({ databasePath: database.databasePath });
    try {
      assert.deepEqual(store.listCredentials(), []);
    } finally {
      store.close();
    }
  } finally {
    await database.cleanup();
  }
});

test("disposable helpers reject arbitrary database path substitution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "selene-provisioning-production-path-"));
  const database = await createDisposableGatewayCredentialDatabase();
  const arbitraryPath = resolveDefaultGatewayCredentialDatabasePath({
    LOCALAPPDATA: directory,
  });
  const store = createGatewayCredentialStore({ databasePath: arbitraryPath });
  store.close();

  try {
    assert.throws(
      () => issueDisposableGatewayCredential({
        databasePath: arbitraryPath,
        homeId: "nova",
        displayName: "NOVA",
        deliverCredential() {},
      }),
      /disposable Gateway credential database fixture is required/,
    );
    assert.throws(
      () => revokeDisposableGatewayCredential({
        databasePath: arbitraryPath,
        credentialId: "00000000-0000-4000-8000-000000000000",
      }),
      /disposable Gateway credential database fixture is required/,
    );
    assert.throws(
      () => listDisposableGatewayCredentials({
        databasePath: arbitraryPath,
      }),
      /disposable Gateway credential database fixture is required/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.cleanup();
  }
});

test("failed one-time delivery revokes the newly issued credential", async () => {
  const database = await createDisposableGatewayCredentialDatabase();
  let bearerCredential;
  let credentialId;

  try {
    assert.throws(
      () => issueDisposableGatewayCredential({
        disposableDatabase: database,
        homeId: "nova",
        displayName: "NOVA",
        deliverCredential(secret, publicCredential) {
          bearerCredential = secret;
          credentialId = publicCredential.id;
          throw new Error("printer failed with private output details");
        },
      }),
      (error) => {
        assert.ok(error instanceof GatewayProvisioningError);
        assert.equal(error.message, CREDENTIAL_DELIVERY_FAILED_MESSAGE);
        assert.doesNotMatch(error.message, SECRET_PATTERN);
        assert.doesNotMatch(error.message, /printer|private output|selene_gateway_v1/i);
        return true;
      },
    );

    assert.throws(
      () => {
        const store = createGatewayCredentialStore({ databasePath: database.databasePath });
        try {
          store.authenticateCredential(bearerCredential);
        } finally {
          store.close();
        }
      },
      /Gateway credential authentication failed/,
    );
    const store = createGatewayCredentialStore({ databasePath: database.databasePath });
    const revokedCredential = store.listCredentials()
      .find((credential) => credential.id === credentialId);
    assert.ok(revokedCredential.revokedAt);
    store.close();
  } finally {
    await database.cleanup();
  }
});

test("failed one-time delivery reports unresolved risk if revocation fails", () => {
  const bearerCredential = "selene_gateway_v1.00000000-0000-4000-8000-000000000000.secret";
  const store = {
    issueCredential() {
      return {
        bearerCredential,
        credential: {
          id: "00000000-0000-4000-8000-000000000000",
          homeId: "nova",
          displayName: "NOVA",
          capabilities: ["chat"],
          createdAt: "2026-09-22T00:00:00.000Z",
          revokedAt: null,
        },
      };
    },
    revokeCredential() {
      throw new Error("sqlite private failure details");
    },
  };

  assert.throws(
    () => issueDisposableGatewayCredentialWithStoreForTesting({
      store,
      homeId: "nova",
      displayName: "NOVA",
      deliverCredential() {
        throw new Error("delivery sink failed");
      },
    }),
    (error) => {
      assert.ok(error instanceof GatewayProvisioningError);
      assert.equal(error.message, CREDENTIAL_DELIVERY_UNRESOLVED_MESSAGE);
      assert.doesNotMatch(error.message, SECRET_PATTERN);
      assert.doesNotMatch(error.message, /sqlite|private|delivery sink/i);
      return true;
    },
  );
});
