import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const GATEWAY_CREDENTIAL_SCHEMA_VERSION = 1;
export const GATEWAY_CREDENTIAL_DATABASE_FILENAME = "gateway-credentials.sqlite3";
export const GATEWAY_CAPABILITIES = Object.freeze([
  "chat",
  "conversation:read",
  "conversation:write",
]);

const BUSY_TIMEOUT_MS = 5_000;
const SECRET_BYTES = 32;
const DIGEST_BYTES = 32;
const TOKEN_PREFIX = "selene_gateway_v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]{0,98}[a-z0-9])?$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_DISPLAY_NAME_LENGTH = 200;
const DUMMY_DIGEST = Buffer.alloc(DIGEST_BYTES);
const CAPABILITY_ORDER = new Map(
  GATEWAY_CAPABILITIES.map((capability, index) => [capability, index]),
);
const CREATE_CREDENTIALS_TABLE_SQL = `
  CREATE TABLE gateway_credentials (
    id TEXT PRIMARY KEY NOT NULL,
    home_id TEXT NOT NULL
      CHECK (length(home_id) BETWEEN 1 AND 100 AND home_id = trim(home_id)),
    display_name TEXT NOT NULL
      CHECK (length(display_name) BETWEEN 1 AND ${MAX_DISPLAY_NAME_LENGTH}
        AND display_name = trim(display_name)),
    secret_digest BLOB NOT NULL
      CHECK (typeof(secret_digest) = 'blob' AND length(secret_digest) = ${DIGEST_BYTES}),
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT
`;
const CREATE_CAPABILITIES_TABLE_SQL = `
  CREATE TABLE gateway_credential_capabilities (
    credential_id TEXT NOT NULL
      REFERENCES gateway_credentials(id) ON DELETE CASCADE,
    capability TEXT NOT NULL
      CHECK (capability IN ('chat', 'conversation:read', 'conversation:write')),
    PRIMARY KEY (credential_id, capability)
  ) STRICT
`;
const CREATE_CREATED_INDEX_SQL = `
  CREATE INDEX gateway_credentials_created_idx
    ON gateway_credentials(created_at DESC, id DESC)
`;
const CREATE_HOME_INDEX_SQL = `
  CREATE INDEX gateway_credentials_home_idx
    ON gateway_credentials(home_id, created_at DESC, id DESC)
`;

export class GatewayCredentialStoreValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayCredentialStoreValidationError";
  }
}

export class GatewayCredentialAuthenticationError extends Error {
  constructor() {
    super("Gateway credential authentication failed.");
    this.name = "GatewayCredentialAuthenticationError";
  }
}

export class GatewayCredentialStoreClosedError extends Error {
  constructor() {
    super("Gateway credential store is closed.");
    this.name = "GatewayCredentialStoreClosedError";
  }
}

export class GatewayCredentialStoreSchemaError extends Error {
  constructor(message, version, options) {
    super(message, options);
    this.name = "GatewayCredentialStoreSchemaError";
    this.version = version;
  }
}

export class UnsupportedGatewayCredentialSchemaVersionError
  extends GatewayCredentialStoreSchemaError {
  constructor(version) {
    super(
      `Gateway credential database schema version ${version} is not supported; expected version ${GATEWAY_CREDENTIAL_SCHEMA_VERSION}.`,
      version,
    );
    this.name = "UnsupportedGatewayCredentialSchemaVersionError";
  }
}

export function resolveDefaultGatewayCredentialDatabasePath(env = process.env) {
  const localAppData = typeof env.LOCALAPPDATA === "string"
    ? env.LOCALAPPDATA.trim()
    : "";

  if (!localAppData || !isAbsolute(localAppData)) {
    throw new GatewayCredentialStoreValidationError(
      "LOCALAPPDATA must be an absolute path before opening the production Gateway credential store.",
    );
  }

  return resolve(
    localAppData,
    "Selene",
    "security",
    GATEWAY_CREDENTIAL_DATABASE_FILENAME,
  );
}

function validateDatabasePath(databasePath) {
  if (typeof databasePath !== "string" || !databasePath.trim()) {
    throw new GatewayCredentialStoreValidationError(
      "Gateway credential database path is required.",
    );
  }
  return resolve(databasePath.trim());
}

function validateCredentialId(credentialId) {
  if (typeof credentialId !== "string" || !UUID_PATTERN.test(credentialId.trim())) {
    throw new GatewayCredentialStoreValidationError("Credential ID must be a UUID.");
  }
  return credentialId.trim().toLowerCase();
}

function validateHomeId(homeId) {
  if (typeof homeId !== "string") {
    throw new GatewayCredentialStoreValidationError("Home ID must be a string.");
  }

  const value = homeId.trim();
  if (!HOME_ID_PATTERN.test(value)) {
    throw new GatewayCredentialStoreValidationError(
      "Home ID must be 1 to 100 letters, numbers, periods, underscores, colons, or hyphens.",
    );
  }
  return value;
}

function validateDisplayName(displayName) {
  if (typeof displayName !== "string") {
    throw new GatewayCredentialStoreValidationError("Display name must be a string.");
  }

  const value = displayName.trim();
  if (
    !value
    || value.length > MAX_DISPLAY_NAME_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new GatewayCredentialStoreValidationError(
      `Display name must be between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters without control characters.`,
    );
  }
  return value;
}

function validateCapabilities(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new GatewayCredentialStoreValidationError(
      "At least one Gateway capability is required.",
    );
  }

  const normalized = [];
  const seen = new Set();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !CAPABILITY_ORDER.has(capability)) {
      throw new GatewayCredentialStoreValidationError(
        `Unknown Gateway capability: ${String(capability)}.`,
      );
    }
    if (seen.has(capability)) {
      throw new GatewayCredentialStoreValidationError(
        `Duplicate Gateway capability: ${capability}.`,
      );
    }
    seen.add(capability);
    normalized.push(capability);
  }

  return normalized.sort(
    (left, right) => CAPABILITY_ORDER.get(left) - CAPABILITY_ORDER.get(right),
  );
}

function readSchemaVersion(database) {
  return Number(database.prepare("PRAGMA user_version").get().user_version);
}

function assertTableShape(database, tableName, expectedColumns) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => ({
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    pk: column.pk,
  }));

  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new GatewayCredentialStoreSchemaError(
      `Gateway credential database table ${tableName} has an incompatible schema.`,
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }
}

function normalizeSchemaSql(sql) {
  return String(sql ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/;$/u, "")
    .toLowerCase();
}

function assertSchemaObjectSql(database, type, name, expectedSql) {
  const row = database.prepare(`
    SELECT sql
    FROM sqlite_schema
    WHERE type = ? AND name = ?
  `).get(type, name);

  if (!row || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expectedSql)) {
    throw new GatewayCredentialStoreSchemaError(
      `Gateway credential database ${type} ${name} has an incompatible definition.`,
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }
}

function assertIndexStructure(database, tableName, indexName, expectedColumns) {
  const index = database.prepare(`
    SELECT name, "unique", origin, partial
    FROM pragma_index_list(?)
    WHERE name = ?
  `).get(tableName, indexName);

  if (
    !index
    || index.unique !== 0
    || index.origin !== "c"
    || index.partial !== 0
  ) {
    throw new GatewayCredentialStoreSchemaError(
      `Gateway credential database index ${indexName} has incompatible properties.`,
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  const columns = database.prepare(`
    SELECT name, desc, coll
    FROM pragma_index_xinfo(?)
    WHERE key = 1
    ORDER BY seqno
  `).all(indexName).map((column) => ({
    name: column.name,
    descending: column.desc,
    collation: column.coll,
  }));

  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new GatewayCredentialStoreSchemaError(
      `Gateway credential database index ${indexName} has incompatible columns.`,
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }
}

function verifySchema(database) {
  const integrityRows = database.prepare("PRAGMA quick_check").all();
  if (
    integrityRows.length !== 1
    || String(integrityRows[0].quick_check).toLowerCase() !== "ok"
  ) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database failed its integrity check.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  const tables = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => name);
  if (JSON.stringify(tables) !== JSON.stringify([
    "gateway_credential_capabilities",
    "gateway_credentials",
  ])) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database has an incompatible table set.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  assertTableShape(database, "gateway_credentials", [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "home_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "display_name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "secret_digest", type: "BLOB", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revoked_at", type: "TEXT", notnull: 0, pk: 0 },
  ]);
  assertTableShape(database, "gateway_credential_capabilities", [
    { name: "credential_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "capability", type: "TEXT", notnull: 1, pk: 2 },
  ]);

  assertSchemaObjectSql(
    database,
    "table",
    "gateway_credentials",
    CREATE_CREDENTIALS_TABLE_SQL,
  );
  assertSchemaObjectSql(
    database,
    "table",
    "gateway_credential_capabilities",
    CREATE_CAPABILITIES_TABLE_SQL,
  );
  assertSchemaObjectSql(
    database,
    "index",
    "gateway_credentials_created_idx",
    CREATE_CREATED_INDEX_SQL,
  );
  assertSchemaObjectSql(
    database,
    "index",
    "gateway_credentials_home_idx",
    CREATE_HOME_INDEX_SQL,
  );

  const strictTables = database.prepare(`
    SELECT name, strict
    FROM pragma_table_list
    WHERE name IN ('gateway_credentials', 'gateway_credential_capabilities')
    ORDER BY name
  `).all();
  if (strictTables.length !== 2 || strictTables.some(({ strict }) => strict !== 1)) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database tables must use strict typing.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  if (database.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database requires foreign-key enforcement.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  const foreignKeys = database.prepare(`
    SELECT id, seq, "table", "from", "to", on_update, on_delete, match
    FROM pragma_foreign_key_list(?)
    ORDER BY id, seq
  `).all("gateway_credential_capabilities").map((foreignKey) => ({
    id: foreignKey.id,
    sequence: foreignKey.seq,
    table: foreignKey.table,
    from: foreignKey.from,
    to: foreignKey.to,
    onUpdate: foreignKey.on_update,
    onDelete: foreignKey.on_delete,
    match: foreignKey.match,
  }));
  if (JSON.stringify(foreignKeys) !== JSON.stringify([{
    id: 0,
    sequence: 0,
    table: "gateway_credentials",
    from: "credential_id",
    to: "id",
    onUpdate: "NO ACTION",
    onDelete: "CASCADE",
    match: "NONE",
  }])) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database has an incompatible capability foreign key.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  assertIndexStructure(
    database,
    "gateway_credentials",
    "gateway_credentials_created_idx",
    [
      { name: "created_at", descending: 1, collation: "BINARY" },
      { name: "id", descending: 1, collation: "BINARY" },
    ],
  );
  assertIndexStructure(
    database,
    "gateway_credentials",
    "gateway_credentials_home_idx",
    [
      { name: "home_id", descending: 0, collation: "BINARY" },
      { name: "created_at", descending: 1, collation: "BINARY" },
      { name: "id", descending: 1, collation: "BINARY" },
    ],
  );

  const foreignKeyErrors = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length > 0) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database contains invalid capability ownership.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }

  const invalidData = database.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM gateway_credentials
      WHERE typeof(secret_digest) != 'blob'
        OR length(secret_digest) != ${DIGEST_BYTES}
        OR length(trim(home_id)) = 0
        OR length(trim(display_name)) = 0
    ) OR EXISTS (
      SELECT 1
      FROM gateway_credential_capabilities
      WHERE capability NOT IN ('chat', 'conversation:read', 'conversation:write')
    ) OR EXISTS (
      SELECT 1
      FROM gateway_credentials AS credentials
      WHERE NOT EXISTS (
        SELECT 1
        FROM gateway_credential_capabilities AS capabilities
        WHERE capabilities.credential_id = credentials.id
      )
    ) AS invalid
  `).get().invalid;
  if (invalidData) {
    throw new GatewayCredentialStoreSchemaError(
      "Gateway credential database contains incompatible credential data.",
      GATEWAY_CREDENTIAL_SCHEMA_VERSION,
    );
  }
}

function initializeSchema(database) {
  const version = readSchemaVersion(database);

  if (version !== 0 && version !== GATEWAY_CREDENTIAL_SCHEMA_VERSION) {
    throw new UnsupportedGatewayCredentialSchemaVersionError(version);
  }

  if (version === GATEWAY_CREDENTIAL_SCHEMA_VERSION) {
    verifySchema(database);
    return;
  }

  const existingTables = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  if (existingTables.length > 0) {
    throw new GatewayCredentialStoreSchemaError(
      "Refusing to initialize an existing unversioned Gateway credential database.",
      version,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ${CREATE_CREDENTIALS_TABLE_SQL};
      ${CREATE_CAPABILITIES_TABLE_SQL};
      ${CREATE_CREATED_INDEX_SQL};
      ${CREATE_HOME_INDEX_SQL};

      PRAGMA user_version = 1;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  verifySchema(database);
}

function digestSecret(secret) {
  return createHash("sha256").update(secret).digest();
}

function parseBearerCredential(bearerCredential) {
  if (typeof bearerCredential !== "string") return null;
  const parts = bearerCredential.split(".");
  if (
    parts.length !== 3
    || parts[0] !== TOKEN_PREFIX
    || !UUID_PATTERN.test(parts[1])
    || !BASE64URL_PATTERN.test(parts[2])
  ) {
    return null;
  }

  const secret = Buffer.from(parts[2], "base64url");
  if (secret.length !== SECRET_BYTES || secret.toString("base64url") !== parts[2]) {
    return null;
  }

  return {
    credentialId: parts[1].toLowerCase(),
    digest: digestSecret(secret),
  };
}

/**
 * Opens the isolated Gateway credential store.
 *
 * Public operations:
 * - issueCredential({ homeId, displayName, capabilities })
 * - authenticateCredential(bearerCredential)
 * - listCredentials()
 * - revokeCredential(credentialId)
 * - close()
 *
 * The full bearer credential is returned only by issueCredential. Listings and
 * authenticated identities never contain the bearer secret or its digest.
 * Construction dependencies are host configuration and test seams, not inputs
 * accepted from a Home or future HTTP request.
 */
export function createGatewayCredentialStore({
  databasePath = resolveDefaultGatewayCredentialDatabasePath(),
  now = () => new Date(),
  generateId = randomUUID,
  generateSecret = () => randomBytes(SECRET_BYTES),
} = {}) {
  const resolvedDatabasePath = validateDatabasePath(databasePath);
  mkdirSync(dirname(resolvedDatabasePath), { recursive: true });

  const database = new DatabaseSync(resolvedDatabasePath, {
    timeout: BUSY_TIMEOUT_MS,
  });
  let closed = false;

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    initializeSchema(database);
    database.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    database.close();
    closed = true;
    throw error;
  }

  const insertCredential = database.prepare(`
    INSERT INTO gateway_credentials (
      id, home_id, display_name, secret_digest, created_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
  `);
  const insertCapability = database.prepare(`
    INSERT INTO gateway_credential_capabilities (credential_id, capability)
    VALUES (?, ?)
  `);
  const selectCredentialForAuthentication = database.prepare(`
    SELECT id, home_id, display_name, secret_digest, created_at, revoked_at
    FROM gateway_credentials
    WHERE id = ?
  `);
  const selectCredentialRows = database.prepare(`
    SELECT id, home_id, display_name, created_at, revoked_at
    FROM gateway_credentials
    ORDER BY created_at DESC, id DESC
  `);
  const selectCapabilities = database.prepare(`
    SELECT capability
    FROM gateway_credential_capabilities
    WHERE credential_id = ?
  `);
  const revokeCredentialRow = database.prepare(`
    UPDATE gateway_credentials
    SET revoked_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `);

  function ensureOpen() {
    if (closed) throw new GatewayCredentialStoreClosedError();
  }

  function createId() {
    const generated = generateId();
    if (typeof generated !== "string" || !UUID_PATTERN.test(generated.trim())) {
      throw new GatewayCredentialStoreValidationError("Generated credential ID must be a UUID.");
    }
    return generated.trim().toLowerCase();
  }

  function createTimestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new GatewayCredentialStoreValidationError(
        "Generated credential timestamp must be a valid Date.",
      );
    }
    return value.toISOString();
  }

  function createSecret() {
    const value = generateSecret();
    if (!Buffer.isBuffer(value) || value.length !== SECRET_BYTES) {
      throw new GatewayCredentialStoreValidationError(
        `Generated credential secret must be exactly ${SECRET_BYTES} bytes.`,
      );
    }
    return Buffer.from(value);
  }

  function runTransaction(operation) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function readCapabilities(credentialId) {
    const capabilities = selectCapabilities.all(credentialId)
      .map(({ capability }) => capability);
    return validateCapabilities(capabilities);
  }

  function mapCredential(row) {
    return Object.freeze({
      id: row.id,
      homeId: row.home_id,
      displayName: row.display_name,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      capabilities: Object.freeze(readCapabilities(row.id)),
    });
  }

  function issueCredential(options = {}) {
    ensureOpen();
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new GatewayCredentialStoreValidationError(
        "Credential issuance options must be an object.",
      );
    }
    const { homeId, displayName, capabilities } = options;
    const normalizedHomeId = validateHomeId(homeId);
    const normalizedDisplayName = validateDisplayName(displayName);
    const normalizedCapabilities = validateCapabilities(capabilities);
    const id = createId();
    const createdAt = createTimestamp();
    const secret = createSecret();
    const encodedSecret = secret.toString("base64url");
    const bearerCredential = `${TOKEN_PREFIX}.${id}.${encodedSecret}`;
    const secretDigest = digestSecret(secret);

    runTransaction(() => {
      insertCredential.run(
        id,
        normalizedHomeId,
        normalizedDisplayName,
        secretDigest,
        createdAt,
      );
      for (const capability of normalizedCapabilities) {
        insertCapability.run(id, capability);
      }
    });

    return Object.freeze({
      bearerCredential,
      credential: Object.freeze({
        id,
        homeId: normalizedHomeId,
        displayName: normalizedDisplayName,
        createdAt,
        revokedAt: null,
        capabilities: Object.freeze([...normalizedCapabilities]),
      }),
    });
  }

  function authenticateCredential(bearerCredential) {
    ensureOpen();
    const parsed = parseBearerCredential(bearerCredential);
    if (!parsed) throw new GatewayCredentialAuthenticationError();

    const row = selectCredentialForAuthentication.get(parsed.credentialId);
    const storedDigest = row && ArrayBuffer.isView(row.secret_digest)
      && row.secret_digest.byteLength === DIGEST_BYTES
      ? Buffer.from(
        row.secret_digest.buffer,
        row.secret_digest.byteOffset,
        row.secret_digest.byteLength,
      )
      : DUMMY_DIGEST;
    const digestMatches = timingSafeEqual(storedDigest, parsed.digest);

    if (!row || !digestMatches || row.revoked_at !== null) {
      throw new GatewayCredentialAuthenticationError();
    }

    const credential = mapCredential(row);
    return Object.freeze({
      credentialId: credential.id,
      homeId: credential.homeId,
      displayName: credential.displayName,
      createdAt: credential.createdAt,
      capabilities: credential.capabilities,
    });
  }

  function listCredentials() {
    ensureOpen();
    return Object.freeze(selectCredentialRows.all().map(mapCredential));
  }

  function revokeCredential(credentialId) {
    ensureOpen();
    const id = validateCredentialId(credentialId);
    const revokedAt = createTimestamp();
    return Number(revokeCredentialRow.run(revokedAt, id).changes) === 1;
  }

  function close() {
    if (closed) return;
    database.close();
    closed = true;
  }

  return Object.freeze({
    databasePath: resolvedDatabasePath,
    issueCredential,
    authenticateCredential,
    listCredentials,
    revokeCredential,
    close,
  });
}
