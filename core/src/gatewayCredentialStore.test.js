import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_CREDENTIAL_SCHEMA_VERSION,
  GatewayCredentialAuthenticationError,
  GatewayCredentialStoreClosedError,
  GatewayCredentialStoreSchemaError,
  GatewayCredentialStoreValidationError,
  UnsupportedGatewayCredentialSchemaVersionError,
  createGatewayCredentialStore,
  resolveDefaultGatewayCredentialDatabasePath,
} from "./gatewayCredentialStore.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALL_CAPABILITIES = [...GATEWAY_CAPABILITIES];

async function createTempDatabasePath(filename = "gateway-credentials.sqlite3") {
  const directory = await mkdtemp(join(tmpdir(), "selene-gateway-credentials-test-"));
  return join(directory, filename);
}

function issueWindowsHome(store, overrides = {}) {
  return store.issueCredential({
    homeId: "windows-home",
    displayName: "Windows Home",
    capabilities: ALL_CAPABILITIES,
    ...overrides,
  });
}

function authenticationFailure(store, bearerCredential) {
  try {
    store.authenticateCredential(bearerCredential);
  } catch (error) {
    assert.ok(error instanceof GatewayCredentialAuthenticationError);
    assert.equal(error.message, "Gateway credential authentication failed.");
    return error;
  }
  assert.fail("Expected Gateway credential authentication to fail.");
}

test("production path is isolated beneath LOCALAPPDATA without opening a database", async () => {
  const localAppData = join("C:\\", "Users", "Selene", "AppData", "Local");
  const expectedPath = join(
    localAppData,
    "Selene",
    "security",
    "gateway-credentials.sqlite3",
  );

  assert.equal(
    resolveDefaultGatewayCredentialDatabasePath({ LOCALAPPDATA: localAppData }),
    expectedPath,
  );
  assert.notEqual(
    expectedPath,
    join(localAppData, "Selene", "data", "conversations.sqlite3"),
  );
  assert.throws(
    () => resolveDefaultGatewayCredentialDatabasePath({}),
    GatewayCredentialStoreValidationError,
  );

  const untouchedLocalAppData = await mkdtemp(join(tmpdir(), "selene-import-only-test-"));
  const untouchedPath = resolveDefaultGatewayCredentialDatabasePath({
    LOCALAPPDATA: untouchedLocalAppData,
  });
  await assert.rejects(() => access(untouchedPath));
});

test("fresh database initializes the versioned strict schema and required settings", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createGatewayCredentialStore({ databasePath });
  store.close();

  const database = new DatabaseSync(databasePath);
  try {
    assert.equal(
      database.prepare("PRAGMA user_version").get().user_version,
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name LIKE 'gateway_%'
        ORDER BY name
      `).all().map(({ name }) => name),
      ["gateway_credential_capabilities", "gateway_credentials"],
    );
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.deepEqual(
      database.prepare(`
        SELECT name, strict
        FROM pragma_table_list
        WHERE name LIKE 'gateway_%'
        ORDER BY name
      `).all().map(({ name, strict }) => ({ name, strict })),
      [
        { name: "gateway_credential_capabilities", strict: 1 },
        { name: "gateway_credentials", strict: 1 },
      ],
    );
  } finally {
    database.close();
  }
});

test("issuance returns unique credentials with stable identity and all approved capabilities", async () => {
  const databasePath = await createTempDatabasePath();
  const instant = new Date("2026-09-19T12:34:56.789Z");
  const store = createGatewayCredentialStore({ databasePath, now: () => instant });

  try {
    const first = issueWindowsHome(store);
    const second = store.issueCredential({
      homeId: "iphone-home",
      displayName: "Alex's iPhone",
      capabilities: ["conversation:write", "chat", "conversation:read"],
    });

    assert.match(first.credential.id, UUID_PATTERN);
    assert.match(second.credential.id, UUID_PATTERN);
    assert.notEqual(first.credential.id, second.credential.id);
    assert.notEqual(first.bearerCredential, second.bearerCredential);
    assert.equal(first.credential.createdAt, instant.toISOString());
    assert.deepEqual(first.credential.capabilities, ALL_CAPABILITIES);
    assert.deepEqual(second.credential.capabilities, ALL_CAPABILITIES);

    const identity = store.authenticateCredential(first.bearerCredential);
    assert.deepEqual(identity, {
      credentialId: first.credential.id,
      homeId: "windows-home",
      displayName: "Windows Home",
      createdAt: instant.toISOString(),
      capabilities: ALL_CAPABILITIES,
    });
  } finally {
    store.close();
  }
});

test("database persists only fixed-size digests and public results never disclose secrets", async () => {
  const databasePath = await createTempDatabasePath();
  const secret = Buffer.alloc(32, 0x5a);
  const store = createGatewayCredentialStore({
    databasePath,
    generateSecret: () => secret,
  });
  const issued = issueWindowsHome(store);
  const identity = store.authenticateCredential(issued.bearerCredential);
  const listing = store.listCredentials();
  store.close();

  const encodedSecret = secret.toString("base64url");
  assert.ok(issued.bearerCredential.includes(encodedSecret));
  for (const value of [identity, listing, issued.credential]) {
    const serialized = JSON.stringify(value);
    assert.ok(!serialized.includes(encodedSecret));
    assert.ok(!serialized.includes("secret"));
    assert.ok(!serialized.includes("digest"));
    assert.ok(!serialized.includes("bearer"));
  }

  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(`
      SELECT secret_digest, length(secret_digest) AS digest_length
      FROM gateway_credentials
    `).get();
    assert.ok(ArrayBuffer.isView(row.secret_digest));
    assert.equal(row.digest_length, 32);
    assert.notDeepEqual(row.secret_digest, secret);
    assert.ok(!JSON.stringify(database.prepare(`
      SELECT id, home_id, display_name, created_at, revoked_at
      FROM gateway_credentials
    `).all()).includes(encodedSecret));
  } finally {
    database.close();
  }
});

test("authentication rejects every invalid credential with the same public error", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createGatewayCredentialStore({ databasePath });
  const issued = issueWindowsHome(store);
  const parts = issued.bearerCredential.split(".");
  const modifiedSecret = `${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;
  const malformedInputs = [
    undefined,
    null,
    "",
    "Bearer not-a-credential",
    `${parts[0]}.${randomUUID()}.${parts[2]}`,
    `${parts[0]}.${parts[1]}.${modifiedSecret}`,
  ];

  try {
    const errors = malformedInputs.map((value) => authenticationFailure(store, value));
    assert.deepEqual(
      new Set(errors.map(({ name }) => name)),
      new Set(["GatewayCredentialAuthenticationError"]),
    );
    assert.deepEqual(
      new Set(errors.map(({ message }) => message)),
      new Set(["Gateway credential authentication failed."]),
    );
  } finally {
    store.close();
  }
});

test("credential parsing rejects early secret changes and malformed Base64URL", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createGatewayCredentialStore({ databasePath });
  const issued = issueWindowsHome(store);
  const [prefix, credentialId, secret] = issued.bearerCredential.split(".");
  const earlyIndex = 4;
  const earlyReplacement = secret[earlyIndex] === "A" ? "B" : "A";
  const modifiedEarlySecret = [
    secret.slice(0, earlyIndex),
    earlyReplacement,
    secret.slice(earlyIndex + 1),
  ].join("");
  const invalidAlphabetSecret = `${secret.slice(0, 8)}+${secret.slice(9)}`;
  const invalidCredentials = [
    `${prefix}.${credentialId}.${modifiedEarlySecret}`,
    `${prefix}.${credentialId}.${invalidAlphabetSecret}`,
    `${prefix}.${credentialId}.${secret}=`,
    `${prefix}.${credentialId}.${secret.slice(0, -1)}`,
    `${prefix}.${credentialId}.${secret}A`,
  ];

  try {
    for (const credential of invalidCredentials) {
      authenticationFailure(store, credential);
    }
  } finally {
    store.close();
  }
});

test("revocation is per credential and survives closing and reopening", async () => {
  const databasePath = await createTempDatabasePath();
  const times = [
    new Date("2026-09-19T10:00:00.000Z"),
    new Date("2026-09-19T10:01:00.000Z"),
    new Date("2026-09-19T10:02:00.000Z"),
  ];
  let timeIndex = 0;
  let store = createGatewayCredentialStore({
    databasePath,
    now: () => times[Math.min(timeIndex++, times.length - 1)],
  });
  const windows = issueWindowsHome(store);
  const iphone = store.issueCredential({
    homeId: "iphone-home",
    displayName: "iPhone Home",
    capabilities: ["chat", "conversation:read"],
  });

  assert.equal(store.revokeCredential(windows.credential.id), true);
  assert.equal(store.revokeCredential(windows.credential.id), false);
  authenticationFailure(store, windows.bearerCredential);
  assert.equal(
    store.authenticateCredential(iphone.bearerCredential).homeId,
    "iphone-home",
  );
  store.close();

  store = createGatewayCredentialStore({ databasePath });
  try {
    authenticationFailure(store, windows.bearerCredential);
    assert.equal(
      store.authenticateCredential(iphone.bearerCredential).credentialId,
      iphone.credential.id,
    );
    const credentials = store.listCredentials();
    assert.equal(
      credentials.find(({ id }) => id === windows.credential.id).revokedAt,
      times[2].toISOString(),
    );
    assert.equal(
      credentials.find(({ id }) => id === iphone.credential.id).revokedAt,
      null,
    );
  } finally {
    store.close();
  }
});

test("listings are deterministic and contain normalized capabilities", async () => {
  const databasePath = await createTempDatabasePath();
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  let idIndex = 0;
  const store = createGatewayCredentialStore({
    databasePath,
    generateId: () => ids[idIndex++],
    now: () => new Date("2026-09-19T12:00:00.000Z"),
  });

  try {
    issueWindowsHome(store, { capabilities: ["conversation:write", "chat"] });
    store.issueCredential({
      homeId: "iphone-home",
      displayName: "iPhone Home",
      capabilities: ["conversation:read"],
    });

    const credentials = store.listCredentials();
    assert.deepEqual(credentials.map(({ id }) => id), [ids[1], ids[0]]);
    assert.deepEqual(credentials[1].capabilities, ["chat", "conversation:write"]);
  } finally {
    store.close();
  }
});

test("strict validation rejects malformed issuance, revocation, and generated values", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createGatewayCredentialStore({ databasePath });

  try {
    assert.throws(() => store.issueCredential(null), GatewayCredentialStoreValidationError);
    assert.throws(() => issueWindowsHome(store, { homeId: "" }), GatewayCredentialStoreValidationError);
    assert.throws(() => issueWindowsHome(store, { homeId: "space home" }), GatewayCredentialStoreValidationError);
    assert.throws(() => issueWindowsHome(store, { displayName: "   " }), GatewayCredentialStoreValidationError);
    assert.throws(() => issueWindowsHome(store, { displayName: "Home\nInjected" }), GatewayCredentialStoreValidationError);
    assert.throws(() => issueWindowsHome(store, { capabilities: [] }), GatewayCredentialStoreValidationError);
    assert.throws(
      () => issueWindowsHome(store, { capabilities: ["chat", "admin"] }),
      GatewayCredentialStoreValidationError,
    );
    assert.throws(
      () => issueWindowsHome(store, { capabilities: ["chat", "chat"] }),
      GatewayCredentialStoreValidationError,
    );
    assert.throws(() => store.revokeCredential("not-a-uuid"), GatewayCredentialStoreValidationError);
  } finally {
    store.close();
  }

  const invalidIdStore = createGatewayCredentialStore({
    databasePath: await createTempDatabasePath(),
    generateId: () => "not-a-uuid",
  });
  try {
    assert.throws(() => issueWindowsHome(invalidIdStore), GatewayCredentialStoreValidationError);
  } finally {
    invalidIdStore.close();
  }

  const shortSecretStore = createGatewayCredentialStore({
    databasePath: await createTempDatabasePath(),
    generateSecret: () => randomBytes(31),
  });
  try {
    assert.throws(() => issueWindowsHome(shortSecretStore), GatewayCredentialStoreValidationError);
  } finally {
    shortSecretStore.close();
  }
});

test("a failed issuance transaction leaves no partial credential or capabilities", async () => {
  const databasePath = await createTempDatabasePath();
  let store = createGatewayCredentialStore({ databasePath });
  store.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TRIGGER reject_capability_insert
    BEFORE INSERT ON gateway_credential_capabilities
    BEGIN
      SELECT RAISE(ABORT, 'forced capability failure');
    END;
  `);
  database.close();

  store = createGatewayCredentialStore({ databasePath });
  try {
    assert.throws(() => issueWindowsHome(store), /forced capability failure/);
    assert.deepEqual(store.listCredentials(), []);
  } finally {
    store.close();
  }

  const inspection = new DatabaseSync(databasePath);
  try {
    assert.equal(
      inspection.prepare("SELECT COUNT(*) AS count FROM gateway_credentials").get().count,
      0,
    );
    assert.equal(
      inspection.prepare("SELECT COUNT(*) AS count FROM gateway_credential_capabilities").get().count,
      0,
    );
  } finally {
    inspection.close();
  }
});

test("future and incompatible schemas are rejected without rebuilding", async () => {
  const futurePath = await createTempDatabasePath();
  let database = new DatabaseSync(futurePath);
  database.exec(`
    CREATE TABLE future_data (value TEXT NOT NULL) STRICT;
    INSERT INTO future_data (value) VALUES ('preserve me');
    PRAGMA user_version = 2;
  `);
  database.close();

  assert.throws(
    () => createGatewayCredentialStore({ databasePath: futurePath }),
    UnsupportedGatewayCredentialSchemaVersionError,
  );
  database = new DatabaseSync(futurePath);
  assert.equal(database.prepare("SELECT value FROM future_data").get().value, "preserve me");
  database.close();

  const unversionedPath = await createTempDatabasePath();
  database = new DatabaseSync(unversionedPath);
  database.exec("CREATE TABLE legacy_data (value TEXT)");
  database.close();
  assert.throws(
    () => createGatewayCredentialStore({ databasePath: unversionedPath }),
    GatewayCredentialStoreSchemaError,
  );

  const incompatiblePath = await createTempDatabasePath();
  database = new DatabaseSync(incompatiblePath);
  database.exec(`
    CREATE TABLE gateway_credentials (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE gateway_credential_capabilities (
      credential_id TEXT,
      capability TEXT
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  database.close();
  assert.throws(
    () => createGatewayCredentialStore({ databasePath: incompatiblePath }),
    GatewayCredentialStoreSchemaError,
  );
});

test("schema verification rejects weakened constraints, foreign keys, and indexes", async (t) => {
  await t.test("weakened table constraints and missing foreign key", async () => {
    const databasePath = await createTempDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE gateway_credentials (
        id TEXT PRIMARY KEY NOT NULL,
        home_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        secret_digest BLOB NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT;
      CREATE TABLE gateway_credential_capabilities (
        credential_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        PRIMARY KEY (credential_id, capability)
      ) STRICT;
      CREATE INDEX gateway_credentials_created_idx
        ON gateway_credentials(created_at DESC, id DESC);
      CREATE INDEX gateway_credentials_home_idx
        ON gateway_credentials(home_id, created_at DESC, id DESC);
      PRAGMA user_version = 1;
    `);
    database.close();

    assert.throws(
      () => createGatewayCredentialStore({ databasePath }),
      GatewayCredentialStoreSchemaError,
    );
  });

  await t.test("named index with the wrong key order", async () => {
    const databasePath = await createTempDatabasePath();
    const store = createGatewayCredentialStore({ databasePath });
    store.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP INDEX gateway_credentials_home_idx;
      CREATE INDEX gateway_credentials_home_idx
        ON gateway_credentials(created_at DESC, home_id, id DESC);
    `);
    database.close();

    assert.throws(
      () => createGatewayCredentialStore({ databasePath }),
      GatewayCredentialStoreSchemaError,
    );
  });
});

test("close is idempotent and prevents all subsequent operations", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createGatewayCredentialStore({ databasePath });
  store.close();
  store.close();

  assert.throws(() => store.listCredentials(), GatewayCredentialStoreClosedError);
  assert.throws(() => issueWindowsHome(store), GatewayCredentialStoreClosedError);
  assert.throws(
    () => store.authenticateCredential("anything"),
    GatewayCredentialStoreClosedError,
  );
  assert.throws(() => store.revokeCredential(randomUUID()), GatewayCredentialStoreClosedError);
});
