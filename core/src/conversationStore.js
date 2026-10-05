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

function initializeSchema(database, primaryOwnerId) {
  const version = readSchemaVersion(database);

  if (version > CONVERSATION_SCHEMA_VERSION) {
    throw new UnsupportedConversationSchemaVersionError(version);
  }

  if (version === CONVERSATION_SCHEMA_VERSION) return;

  if (version === 1) {
    database.exec("PRAGMA foreign_keys = ON");
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name IN ('conversations', 'messages')
      ORDER BY name
    `).all().map(({ name }) => name);
    if (JSON.stringify(tables) !== JSON.stringify(["conversations", "messages"])) {
      throw new ConversationStoreSchemaError(
        "Conversation database schema does not match version 1.",
        version,
      );
    }

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
    WHERE id = ?
  `);
  const listConversationRows = database.prepare(`
    SELECT id, owner_id, title, created_at, updated_at
    FROM conversations
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `);
  const listConversationRowsAfter = database.prepare(`
    SELECT id, owner_id, title, created_at, updated_at
    FROM conversations
    WHERE updated_at < ?
       OR (updated_at = ? AND id < ?)
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
    WHERE id = ?
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

  function createConversation({ title = null } = {}) {
    ensureOpen();
    const id = createId();
    const timestamp = createTimestamp();
    const normalizedTitle = validateTitle(title);

    insertConversation.run(id, normalizedPrimaryOwnerId, normalizedTitle, timestamp, timestamp);
    return mapConversation(selectConversation.get(id));
  }

  function getConversation(conversationId) {
    ensureOpen();
    const id = validateConversationId(conversationId);
    return mapConversation(selectConversation.get(id));
  }

  function listConversations({ limit, after = null } = {}) {
    ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ConversationStoreValidationError("Conversation list limit must be a positive integer.");
    }
    if (after === null) {
      return listConversationRows.all(limit).map(mapConversation);
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
      .all(after.updatedAt, after.updatedAt, id, limit)
      .map(mapConversation);
  }

  function insertMessage(conversationId, content, role) {
    ensureOpen();
    const id = validateConversationId(conversationId);
    const normalizedContent = validateMessageContent(content);
    const messageId = createId();
    const timestamp = createTimestamp();

    return runTransaction(() => {
      if (!selectConversation.get(id)) {
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

      const update = updateConversationTimestamp.run(timestamp, id);
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

  function commitTurn(conversationId, userContent, assistantContent) {
    ensureOpen();
    const id = validateConversationId(conversationId);
    const normalizedUserContent = validateMessageContent(userContent);
    const normalizedAssistantContent = validateMessageContent(assistantContent);
    const userMessageId = createId();
    const assistantMessageId = createId();
    const userTimestamp = createTimestamp();
    const assistantTimestamp = createTimestamp();

    return runTransaction(() => {
      if (!selectConversation.get(id)) {
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

      const update = updateConversationTimestamp.run(assistantTimestamp, id);
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

  function addUserMessage(conversationId, content) {
    return insertMessage(conversationId, content, "user");
  }

  function addAssistantMessage(conversationId, content) {
    return insertMessage(conversationId, content, "assistant");
  }

  function getMessages(conversationId, { limit = 201 } = {}) {
    ensureOpen();
    const id = validateConversationId(conversationId);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ConversationStoreValidationError("Message limit must be a positive integer.");
    }
    if (!selectConversation.get(id)) {
      throw new ConversationNotFoundError(id);
    }
    return selectMessages.all(id, limit).map(mapMessage);
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
