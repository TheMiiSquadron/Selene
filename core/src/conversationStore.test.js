import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CONVERSATION_SCHEMA_VERSION,
  ConversationNotFoundError,
  ConversationStoreClosedError,
  ConversationStoreSchemaError,
  ConversationStoreValidationError,
  UnsupportedConversationSchemaVersionError,
  createConversationStore,
  resolveDefaultConversationDatabasePath,
} from "./conversationStore.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createTempDatabasePath() {
  const directory = await mkdtemp(join(tmpdir(), "selene-conversations-test-"));
  return join(directory, "conversations.sqlite3");
}

function sequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("production path resolves beneath LOCALAPPDATA without opening a database", () => {
  const localAppData = join("C:\\", "Users", "Selene", "AppData", "Local");
  const databasePath = resolveDefaultConversationDatabasePath({ LOCALAPPDATA: localAppData });

  assert.equal(
    databasePath,
    join(localAppData, "Selene", "data", "conversations.sqlite3"),
  );
  assert.throws(
    () => resolveDefaultConversationDatabasePath({}),
    ConversationStoreValidationError,
  );
});

test("fresh database initializes schema version 1, tables, and indexes", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ databasePath });
  store.close();

  const database = new DatabaseSync(databasePath);
  try {
    assert.equal(
      database.prepare("PRAGMA user_version").get().user_version,
      CONVERSATION_SCHEMA_VERSION,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name IN ('conversations', 'messages')
        ORDER BY name
      `).all().map(({ name }) => name),
      ["conversations", "messages"],
    );
    assert.deepEqual(
      database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'index' AND name IN (
          'conversations_updated_idx',
          'messages_conversation_order_idx'
        )
        ORDER BY name
      `).all().map(({ name }) => name),
      ["conversations_updated_idx", "messages_conversation_order_idx"],
    );
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    database.close();
  }
});

test("conversations have generated UUIDs and stable UTC timestamps", async () => {
  const databasePath = await createTempDatabasePath();
  const instant = new Date("2026-09-19T12:34:56.789Z");
  const store = createConversationStore({ databasePath, now: () => instant });

  try {
    const created = store.createConversation({ title: " First conversation " });

    assert.match(created.id, UUID_PATTERN);
    assert.deepEqual(created, {
      id: created.id,
      title: "First conversation",
      createdAt: instant.toISOString(),
      updatedAt: instant.toISOString(),
    });
    assert.deepEqual(store.getConversation(created.id), created);
    assert.deepEqual(store.listConversations(), [created]);
  } finally {
    store.close();
  }
});

test("conversation listing is deterministic by update time, creation time, and ID", async () => {
  const databasePath = await createTempDatabasePath();
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const times = [
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-02T00:00:00.000Z"),
    new Date("2026-01-03T00:00:00.000Z"),
  ];
  const store = createConversationStore({
    databasePath,
    generateId: sequence(ids),
    now: sequence(times),
  });

  try {
    const first = store.createConversation({ title: "First" });
    const second = store.createConversation({ title: "Second" });
    store.addUserMessage(first.id, "Updated later");

    assert.deepEqual(
      store.listConversations().map(({ id }) => id),
      [first.id, second.id],
    );
  } finally {
    store.close();
  }
});

test("messages use authoritative sequence order even with identical timestamps", async () => {
  const databasePath = await createTempDatabasePath();
  const instant = new Date("2026-02-03T04:05:06.789Z");
  const store = createConversationStore({ databasePath, now: () => instant });

  try {
    const conversation = store.createConversation();
    const user = store.addUserMessage(conversation.id, "Hello");
    const assistant = store.addAssistantMessage(conversation.id, "Hi there");
    const messages = store.getMessages(conversation.id);

    assert.deepEqual(messages, [user, assistant]);
    assert.deepEqual(messages.map(({ sequence }) => sequence), [1, 2]);
    assert.deepEqual(messages.map(({ role }) => role), ["user", "assistant"]);
    assert.equal(messages[0].createdAt, messages[1].createdAt);
    assert.match(messages[0].id, UUID_PATTERN);
    assert.match(messages[1].id, UUID_PATTERN);
  } finally {
    store.close();
  }
});

test("schema enforces foreign keys and per-conversation sequence uniqueness", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ databasePath });
  const conversation = store.createConversation();
  store.close();

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  const insert = database.prepare(`
    INSERT INTO messages (
      id, conversation_id, sequence, role, content, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const timestamp = new Date().toISOString();

  try {
    assert.throws(() => insert.run(
      randomUUID(),
      randomUUID(),
      1,
      "user",
      "Orphan",
      timestamp,
    ), /FOREIGN KEY constraint failed/);

    insert.run(randomUUID(), conversation.id, 1, "user", "First", timestamp);
    assert.throws(() => insert.run(
      randomUUID(),
      conversation.id,
      1,
      "assistant",
      "Duplicate sequence",
      timestamp,
    ), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test("message insertion and conversation timestamp update commit atomically", async () => {
  const databasePath = await createTempDatabasePath();
  const createdAt = new Date("2026-03-01T00:00:00.000Z");
  const messageAt = new Date("2026-03-01T00:01:00.000Z");
  const store = createConversationStore({
    databasePath,
    now: sequence([createdAt, messageAt]),
  });

  try {
    const conversation = store.createConversation();
    const message = store.addUserMessage(conversation.id, "Persist this");

    assert.equal(message.createdAt, messageAt.toISOString());
    assert.equal(store.getConversation(conversation.id).updatedAt, messageAt.toISOString());
    assert.deepEqual(store.getMessages(conversation.id), [message]);
  } finally {
    store.close();
  }
});

test("an unsuccessful message transaction rolls back the inserted message", async () => {
  const databasePath = await createTempDatabasePath();
  let store = createConversationStore({ databasePath });
  const conversation = store.createConversation();
  store.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TRIGGER reject_conversation_update
    BEFORE UPDATE ON conversations
    BEGIN
      SELECT RAISE(ABORT, 'forced timestamp failure');
    END;
  `);
  database.close();

  store = createConversationStore({ databasePath });
  try {
    const before = store.getConversation(conversation.id);

    assert.throws(
      () => store.addUserMessage(conversation.id, "Must roll back"),
      /forced timestamp failure/,
    );
    assert.deepEqual(store.getMessages(conversation.id), []);
    assert.deepEqual(store.getConversation(conversation.id), before);
  } finally {
    store.close();
  }
});

test("conversations and messages persist after closing and reopening", async () => {
  const databasePath = await createTempDatabasePath();
  let store = createConversationStore({ databasePath });
  const conversation = store.createConversation({ title: "Persistent" });
  const message = store.addUserMessage(conversation.id, "Still here");
  store.close();

  store = createConversationStore({ databasePath });
  try {
    assert.equal(store.getConversation(conversation.id).title, "Persistent");
    assert.deepEqual(store.getMessages(conversation.id), [message]);
  } finally {
    store.close();
  }
});

test("invalid inputs and unknown conversations fail explicitly", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ databasePath });
  const unknownId = randomUUID();

  try {
    assert.throws(() => store.createConversation({ title: "   " }), ConversationStoreValidationError);
    assert.throws(() => store.getConversation("not-a-uuid"), ConversationStoreValidationError);
    assert.equal(store.getConversation(unknownId), null);
    assert.throws(
      () => store.addUserMessage(unknownId, "Hello"),
      ConversationNotFoundError,
    );
    assert.throws(
      () => store.getMessages(unknownId),
      ConversationNotFoundError,
    );
    assert.throws(
      () => store.addAssistantMessage(unknownId, "   "),
      ConversationStoreValidationError,
    );
  } finally {
    store.close();
  }
});

test("future schema versions are rejected without modifying their data", async () => {
  const databasePath = await createTempDatabasePath();
  let database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE future_data (value TEXT NOT NULL) STRICT;
    INSERT INTO future_data (value) VALUES ('preserve me');
    PRAGMA user_version = 2;
  `);
  database.close();

  assert.throws(
    () => createConversationStore({ databasePath }),
    UnsupportedConversationSchemaVersionError,
  );

  database = new DatabaseSync(databasePath);
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      database.prepare("SELECT value FROM future_data").get().value,
      "preserve me",
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'table' AND name IN ('conversations', 'messages')
      `).get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("nonempty unversioned databases are rejected without rebuilding", async () => {
  const databasePath = await createTempDatabasePath();
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE legacy_data (value TEXT)");
  database.close();

  assert.throws(
    () => createConversationStore({ databasePath }),
    ConversationStoreSchemaError,
  );
});

test("close is idempotent and prevents further operations", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ databasePath });

  store.close();
  store.close();

  assert.throws(() => store.listConversations(), ConversationStoreClosedError);
  assert.throws(() => store.createConversation(), ConversationStoreClosedError);
});
