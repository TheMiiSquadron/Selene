import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  PlatformPathValidationError,
  resolveSeleneProductionPath,
} from "./platformPaths.js";
import { DatabaseSync } from "node:sqlite";

export const CONVERSATION_SCHEMA_VERSION = 2;
export const CONVERSATION_DATABASE_FILENAME = "conversations.sqlite3";

const BUSY_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 200;

export class ConversationStoreValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationStoreValidationError";
  }
}

export class ConversationNotFoundError extends Error {
  constructor(conversationId) {
    super(`Conversation not found: ${conversationId}.`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

export class ConversationStoreClosedError extends Error {
  constructor() {
    super("Conversation store is closed.");
    this.name = "ConversationStoreClosedError";
  }
}

export class ConversationStoreSchemaError extends Error {
  constructor(message, version) {
    super(message);
    this.name = "ConversationStoreSchemaError";
    this.version = version;
  }
}

export class UnsupportedConversationSchemaVersionError extends ConversationStoreSchemaError {
  constructor(version) {
    super(
      `Conversation database schema version ${version} is newer than supported version ${CONVERSATION_SCHEMA_VERSION}.`,
      version,
    );
    this.name = "UnsupportedConversationSchemaVersionError";
  }
}

export function resolveDefaultConversationDatabasePath(
  env = process.env,
  platform = process.platform,
) {
  try {
    return resolveSeleneProductionPath(
      { platform, env },
      "data",
      CONVERSATION_DATABASE_FILENAME,
    );
  } catch (error) {
    if (error instanceof PlatformPathValidationError) {
      throw new ConversationStoreValidationError(error.message);
    }
    throw error;
  }
}

function validateDatabasePath(databasePath) {
  const value = String(databasePath ?? "").trim();
  if (!value) {
    throw new ConversationStoreValidationError("Conversation database path is required.");
  }
  return resolve(value);
}

function validateOwnerId(ownerId) {
  const value = String(ownerId ?? "").trim();
  if (!UUID_PATTERN.test(value)) {
    throw new ConversationStoreValidationError("Owner ID must be a UUID.");
  }
  return value.toLowerCase();
}

function validateConversationId(conversationId) {
  const value = String(conversationId ?? "").trim();
  if (!UUID_PATTERN.test(value)) {
    throw new ConversationStoreValidationError("Conversation ID must be a UUID.");
  }
  return value.toLowerCase();
}

function validateTitle(title) {
  if (title === null || typeof title === "undefined") return null;
  if (typeof title !== "string") {
    throw new ConversationStoreValidationError("Conversation title must be a string or null.");
  }

  const value = title.trim();
  if (!value) {
    throw new ConversationStoreValidationError("Conversation title must not be empty.");
  }
  if (value.length > MAX_TITLE_LENGTH) {
    throw new ConversationStoreValidationError(
      `Conversation title must be ${MAX_TITLE_LENGTH} characters or fewer.`,
    );
  }
  return value;
}

function validateMessageContent(content) {
  if (typeof content !== "string") {
    throw new ConversationStoreValidationError("Message content must be a string.");
  }

  const value = content.trim();
  if (!value) {
    throw new ConversationStoreValidationError("Message content must not be empty.");
  }
  return value;
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function readSchemaVersion(database) {
  return Number(database.prepare("PRAGMA user_version").get().user_version);
}

function assertConversationTableShape(database, tableName, expected) {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all()
    .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new ConversationStoreSchemaError(
      `Conversation database schema has an incompatible ${tableName} table.`,
      readSchemaVersion(database),
    );
  }
}

function assertConversationIndex(database, tableName, indexName, expectedColumns) {
  const indexes = database.prepare(`PRAGMA index_list(${tableName})`).all();
  if (!indexes.some(({ name }) => name === indexName)) {
    throw new ConversationStoreSchemaError(
      `Conversation database schema is missing ${indexName}.`,
      readSchemaVersion(database),
    );
  }
  const columns = database.prepare(`PRAGMA index_xinfo(${indexName})`).all()
    .filter(({ key }) => key === 1)
    .map(({ name, desc }) => ({ name, descending: desc }));
  if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
    throw new ConversationStoreSchemaError(
      `Conversation database schema has an incompatible ${indexName}.`,
      readSchemaVersion(database),
    );
  }
}

function verifyVersion1Schema(database) {
  assertConversationTableShape(database, "conversations", [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "title", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  ]);
  assertConversationTableShape(database, "messages", [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "conversation_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "sequence", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ]);
  assertConversationIndex(database, "conversations", "conversations_updated_idx", [
    { name: "updated_at", descending: 1 },
    { name: "created_at", descending: 1 },
    { name: "id", descending: 1 },
  ]);
  assertConversationIndex(database, "messages", "messages_conversation_order_idx", [
    { name: "conversation_id", descending: 0 },
    { name: "sequence", descending: 0 },
  ]);
}

function verifySchema(database) {
  assertConversationTableShape(database, "conversations", [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "owner_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "title", type: "TEXT", notnull: 0, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  ]);
  assertConversationTableShape(database, "messages", [
    { name: "id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "conversation_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "sequence", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
  ]);
  assertConversationIndex(database, "conversations", "conversations_owner_updated_idx", [
    { name: "owner_id", descending: 0 },
    { name: "updated_at", descending: 1 },
    { name: "id", descending: 1 },
  ]);
  assertConversationIndex(database, "messages", "messages_conversation_order_idx", [
    { name: "conversation_id", descending: 0 },
    { name: "sequence", descending: 0 },
  ]);

  const strictTables = database.prepare(`
    SELECT name, strict FROM pragma_table_list
    WHERE name IN ('conversations', 'messages')
  `).all();
  if (strictTables.length !== 2 || strictTables.some(({ strict }) => strict !== 1)) {
    throw new ConversationStoreSchemaError(
      "Conversation database tables must use strict typing.",
      CONVERSATION_SCHEMA_VERSION,
    );
  }
  const foreignKeys = database.prepare(`
    SELECT "table", "from", "to", on_delete
    FROM pragma_foreign_key_list('messages')
  `).all();
  if (
    foreignKeys.length !== 1
    || foreignKeys[0].table !== "conversations"
    || foreignKeys[0].from !== "conversation_id"
    || foreignKeys[0].to !== "id"
    || foreignKeys[0].on_delete !== "CASCADE"
  ) {
    throw new ConversationStoreSchemaError(
      "Conversation database has an incompatible message foreign key.",
      CONVERSATION_SCHEMA_VERSION,
    );
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new ConversationStoreSchemaError(
      "Conversation database contains invalid message ownership.",
      CONVERSATION_SCHEMA_VERSION,
    );
  }
  const invalidOwners = database.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM conversations
      WHERE owner_id IS NULL
        OR length(owner_id) != 36
        OR owner_id NOT GLOB '[0-9A-Fa-f]*'
    ) AS invalid
  `).get().invalid;
  if (invalidOwners) {
    throw new ConversationStoreSchemaError(
      "Conversation database contains invalid owner identity.",
      CONVERSATION_SCHEMA_VERSION,
    );
  }
}

function initializeSchema(database, primaryOwnerId) {
  const version = readSchemaVersion(database);

  if (version > CONVERSATION_SCHEMA_VERSION) {
    throw new UnsupportedConversationSchemaVersionError(version);
  }

  if (version === CONVERSATION_SCHEMA_VERSION) {
    verifySchema(database);
    return;
  }

  if (version === 1) {
    database.exec("PRAGMA foreign_keys = ON");
    verifyVersion1Schema(database);

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        DROP INDEX conversations_updated_idx;
        ALTER TABLE conversations ADD COLUMN owner_id TEXT;
        UPDATE conversations SET owner_id = '${primaryOwnerId}';

        CREATE TABLE conversations_v2 (
          id TEXT PRIMARY KEY NOT NULL,
          owner_id TEXT NOT NULL CHECK (length(owner_id) = 36),
          title TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO conversations_v2
          SELECT id, owner_id, title, created_at, updated_at FROM conversations;

        DROP INDEX messages_conversation_order_idx;
        CREATE TABLE messages_v2 (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL CHECK (length(content) > 0),
          created_at TEXT NOT NULL,
          UNIQUE (conversation_id, sequence)
        ) STRICT;
        INSERT INTO messages_v2
          SELECT id, conversation_id, sequence, role, content, created_at FROM messages;

        DROP TABLE messages;
        DROP TABLE conversations;
        ALTER TABLE conversations_v2 RENAME TO conversations;

        CREATE TABLE messages (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL CHECK (length(content) > 0),
          created_at TEXT NOT NULL,
          UNIQUE (conversation_id, sequence)
        ) STRICT;
        INSERT INTO messages
          SELECT id, conversation_id, sequence, role, content, created_at FROM messages_v2;
        DROP TABLE messages_v2;

        CREATE INDEX conversations_owner_updated_idx
          ON conversations(owner_id, updated_at DESC, id DESC);
        CREATE INDEX messages_conversation_order_idx
          ON messages(conversation_id, sequence);

        PRAGMA user_version = 2;
      `);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
    throw new ConversationStoreSchemaError(
      "Refusing to initialize an existing unversioned conversation database.",
      version,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL CHECK (length(owner_id) = 36),
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL CHECK (length(content) > 0),
        created_at TEXT NOT NULL,
        UNIQUE (conversation_id, sequence)
      ) STRICT;

      CREATE INDEX conversations_owner_updated_idx
        ON conversations(owner_id, updated_at DESC, id DESC);

      CREATE INDEX messages_conversation_order_idx
        ON messages(conversation_id, sequence);

      PRAGMA user_version = 2;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  verifySchema(database);
}

/**
 * Opens an isolated conversation store.
 *
 * Public operations generate IDs, timestamps, roles, and sequence numbers
 * internally. `databasePath`, `now`, and `generateId` are construction-time
 * dependencies for host configuration and tests; they are not API payloads.
 */
export function createConversationStore({
  databasePath = resolveDefaultConversationDatabasePath(),
  now = () => new Date(),
  generateId = randomUUID,
  primaryOwnerId,
} = {}) {
  const normalizedPrimaryOwnerId = validateOwnerId(primaryOwnerId);
  const resolvedDatabasePath = validateDatabasePath(databasePath);
  mkdirSync(dirname(resolvedDatabasePath), { recursive: true });

  const database = new DatabaseSync(resolvedDatabasePath, {
    timeout: BUSY_TIMEOUT_MS,
  });
  let closed = false;

  try {
    initializeSchema(database, normalizedPrimaryOwnerId);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    database.close();
    closed = true;
    throw error;
  }

  const selectConversation = database.prepare(`
    SELECT id, owner_id, title, created_at, updated_at
    FROM conversations
    WHERE id = ? AND owner_id = ?
  `);
  const listConversationRows = database.prepare(`
    SELECT id, owner_id, title, created_at, updated_at
    FROM conversations
    WHERE owner_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `);
  const listConversationRowsAfter = database.prepare(`
    SELECT id, owner_id, title, created_at, updated_at
    FROM conversations
    WHERE owner_id = ?
      AND (updated_at < ?
       OR (updated_at = ? AND id < ?))
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `);
  const insertConversation = database.prepare(`
    INSERT INTO conversations (id, owner_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const selectMessages = database.prepare(`
    SELECT id, conversation_id, sequence, role, content, created_at
    FROM messages
    WHERE conversation_id = ?
      AND EXISTS (
        SELECT 1 FROM conversations
        WHERE conversations.id = messages.conversation_id
          AND conversations.owner_id = ?
      )
    ORDER BY sequence ASC
    LIMIT ?
  `);
  const selectNextSequence = database.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM messages
    WHERE conversation_id = ?
  `);
  const insertMessageRow = database.prepare(`
    INSERT INTO messages (
      id,
      conversation_id,
      sequence,
      role,
      content,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateConversationTimestamp = database.prepare(`
    UPDATE conversations
    SET updated_at = ?
    WHERE id = ? AND owner_id = ?
  `);

  function ensureOpen() {
    if (closed) throw new ConversationStoreClosedError();
  }

  function createId() {
    const value = String(generateId()).trim().toLowerCase();
    if (!UUID_PATTERN.test(value)) {
      throw new ConversationStoreValidationError("Generated ID must be a UUID.");
    }
    return value;
  }

  function createTimestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ConversationStoreValidationError("Generated timestamp must be a valid Date.");
    }
    return value.toISOString();
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

  function createConversation(ownerId, { title = null } = {}) {
    const owner = validateOwnerId(ownerId);
    ensureOpen();
    const id = createId();
    const timestamp = createTimestamp();
    const normalizedTitle = validateTitle(title);

    insertConversation.run(id, owner, normalizedTitle, timestamp, timestamp);
    return mapConversation(selectConversation.get(id, owner));
  }

  function getConversation(ownerId, conversationId) {
    ensureOpen();
    const owner = validateOwnerId(ownerId);
    const id = validateConversationId(conversationId);
    return mapConversation(selectConversation.get(id, owner));
  }

  function listConversations(ownerId, { limit, after = null } = {}) {
    ensureOpen();
    const owner = validateOwnerId(ownerId);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ConversationStoreValidationError("Conversation list limit must be a positive integer.");
    }
    if (after === null) {
      return listConversationRows.all(owner, limit).map(mapConversation);
    }
    if (
      !after
      || typeof after !== "object"
      || typeof after.updatedAt !== "string"
      || !Number.isFinite(Date.parse(after.updatedAt))
    ) {
      throw new ConversationStoreValidationError("Conversation list cursor is invalid.");
    }
    const id = validateConversationId(after.id);
    return listConversationRowsAfter
      .all(owner, after.updatedAt, after.updatedAt, id, limit)
      .map(mapConversation);
  }

  function insertMessage(ownerId, conversationId, content, role) {
    ensureOpen();
    const owner = validateOwnerId(ownerId);
    const id = validateConversationId(conversationId);
    const normalizedContent = validateMessageContent(content);
    const messageId = createId();
    const timestamp = createTimestamp();

    return runTransaction(() => {
      if (!selectConversation.get(id, owner)) {
        throw new ConversationNotFoundError(id);
      }

      const sequence = Number(selectNextSequence.get(id).sequence);
      insertMessageRow.run(
        messageId,
        id,
        sequence,
        role,
        normalizedContent,
        timestamp,
      );

      const update = updateConversationTimestamp.run(timestamp, id, owner);
      if (Number(update.changes) !== 1) {
        throw new ConversationNotFoundError(id);
      }

      return mapMessage({
        id: messageId,
        conversation_id: id,
        sequence,
        role,
        content: normalizedContent,
        created_at: timestamp,
      });
    });
  }

  function commitTurn(ownerId, conversationId, userContent, assistantContent) {
    ensureOpen();
    const owner = validateOwnerId(ownerId);
    const id = validateConversationId(conversationId);
    const normalizedUserContent = validateMessageContent(userContent);
    const normalizedAssistantContent = validateMessageContent(assistantContent);
    const userMessageId = createId();
    const assistantMessageId = createId();
    const userTimestamp = createTimestamp();
    const assistantTimestamp = createTimestamp();

    return runTransaction(() => {
      if (!selectConversation.get(id, owner)) {
        throw new ConversationNotFoundError(id);
      }

      const userSequence = Number(selectNextSequence.get(id).sequence);
      const assistantSequence = userSequence + 1;

      insertMessageRow.run(
        userMessageId,
        id,
        userSequence,
        "user",
        normalizedUserContent,
        userTimestamp,
      );
      insertMessageRow.run(
        assistantMessageId,
        id,
        assistantSequence,
        "assistant",
        normalizedAssistantContent,
        assistantTimestamp,
      );

      const update = updateConversationTimestamp.run(assistantTimestamp, id, owner);
      if (Number(update.changes) !== 1) {
        throw new ConversationNotFoundError(id);
      }

      return Object.freeze({
        userMessage: mapMessage({
          id: userMessageId,
          conversation_id: id,
          sequence: userSequence,
          role: "user",
          content: normalizedUserContent,
          created_at: userTimestamp,
        }),
        assistantMessage: mapMessage({
          id: assistantMessageId,
          conversation_id: id,
          sequence: assistantSequence,
          role: "assistant",
          content: normalizedAssistantContent,
          created_at: assistantTimestamp,
        }),
      });
    });
  }

  function addUserMessage(ownerId, conversationId, content) {
    return insertMessage(ownerId, conversationId, content, "user");
  }

  function addAssistantMessage(ownerId, conversationId, content) {
    return insertMessage(ownerId, conversationId, content, "assistant");
  }

  function getMessages(ownerId, conversationId, { limit = 201 } = {}) {
    ensureOpen();
    const owner = validateOwnerId(ownerId);
    const id = validateConversationId(conversationId);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ConversationStoreValidationError("Message limit must be a positive integer.");
    }
    if (!selectConversation.get(id, owner)) {
      throw new ConversationNotFoundError(id);
    }
    return selectMessages.all(id, owner, limit).map(mapMessage);
  }

  function close() {
    if (closed) return;
    database.close();
    closed = true;
  }

  return Object.freeze({
    databasePath: resolvedDatabasePath,
    createConversation,
    getConversation,
    listConversations,
    addUserMessage,
    addAssistantMessage,
    commitTurn,
    getMessages,
    close,
  });
}
