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

const PRIMARY_OWNER_ID = "00000000-0000-4000-8000-0000000000aa";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function createTempDatabasePath() {
  const directory = await mkdtemp(join(tmpdir(), "selene-conversations-test-"));
  return join(directory, "conversations.sqlite3");
}

function sequence(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("Windows production path preserves the LOCALAPPDATA conversation location", () => {
  const localAppData = "C:\\Users\\Selene\\AppData\\Local";
  const databasePath = resolveDefaultConversationDatabasePath(
    { LOCALAPPDATA: localAppData },
    "win32",
  );

  assert.equal(
    databasePath,
    "C:\\Users\\Selene\\AppData\\Local\\Selene\\data\\conversations.sqlite3",
  );
  assert.throws(
    () => resolveDefaultConversationDatabasePath({}, "win32"),
    ConversationStoreValidationError,
  );
});

test("fresh database initializes schema version 2 with owner isolation indexes", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
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
          'conversations_owner_updated_idx',
          'messages_conversation_order_idx'
        )
        ORDER BY name
      `).all().map(({ name }) => name),
      ["conversations_owner_updated_idx", "messages_conversation_order_idx"],
    );
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    database.close();
  }
});

test("schema v1 migrates existing conversations to the supplied primary owner", async () => {
  const databasePath = await createTempDatabasePath();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL CHECK (length(content) > 0),
      created_at TEXT NOT NULL,
      UNIQUE (conversation_id, sequence)
    ) STRICT;
    CREATE INDEX conversations_updated_idx
      ON conversations(updated_at DESC, created_at DESC, id DESC);
    CREATE INDEX messages_conversation_order_idx
      ON messages(conversation_id, sequence);
    INSERT INTO conversations VALUES (
      '00000000-0000-4000-8000-000000000011',
      'Legacy',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO messages VALUES (
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000011',
      1, 'user', 'Legacy message', '2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const store = createConversationStore({
    databasePath,
    primaryOwnerId: PRIMARY_OWNER_ID,
  });
  store.close();

  const migrated = new DatabaseSync(databasePath);
  try {
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      migrated.prepare("SELECT owner_id FROM conversations").get().owner_id,
      PRIMARY_OWNER_ID,
    );
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 1);
    assert.equal(
      migrated.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );
  } finally {
    migrated.close();
  }
});

test("conversations have generated UUIDs and stable UTC timestamps", async () => {
  const databasePath = await createTempDatabasePath();
  const instant = new Date("2026-09-19T12:34:56.789Z");
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath, now: () => instant });

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
    assert.deepEqual(store.listConversations({ limit: 20 }), [created]);
  } finally {
    store.close();
  }
});

test("conversation listing is deterministic by update time and ID", async () => {
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
    primaryOwnerId: PRIMARY_OWNER_ID,
    databasePath,
    generateId: sequence(ids),
    now: sequence(times),
  });

  try {
    const first = store.createConversation({ title: "First" });
    const second = store.createConversation({ title: "Second" });
    store.addUserMessage(first.id, "Updated later");

    assert.deepEqual(
      store.listConversations({ limit: 20 }).map(({ id }) => id),
      [first.id, second.id],
    );
  } finally {
    store.close();
  }
});

test("messages use authoritative sequence order even with identical timestamps", async () => {
  const databasePath = await createTempDatabasePath();
  const instant = new Date("2026-02-03T04:05:06.789Z");
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath, now: () => instant });

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
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
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
    primaryOwnerId: PRIMARY_OWNER_ID,
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
  let store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
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

  store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
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
  let store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
  const conversation = store.createConversation({ title: "Persistent" });
  const message = store.addUserMessage(conversation.id, "Still here");
  store.close();

  store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
  try {
    assert.equal(store.getConversation(conversation.id).title, "Persistent");
    assert.deepEqual(store.getMessages(conversation.id), [message]);
  } finally {
    store.close();
  }
});

test("invalid inputs and unknown conversations fail explicitly", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
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
    PRAGMA user_version = 3;
  `);
  database.close();

  assert.throws(
    () => createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath }),
    UnsupportedConversationSchemaVersionError,
  );

  database = new DatabaseSync(databasePath);
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 3);
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
    () => createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath }),
    ConversationStoreSchemaError,
  );
});

test("close is idempotent and prevents further operations", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });

  store.close();
  store.close();

  assert.throws(() => store.listConversations(), ConversationStoreClosedError);
  assert.throws(() => store.createConversation(), ConversationStoreClosedError);
});


test("completed turns persist user and assistant messages atomically with consecutive metadata", async () => {
  const databasePath = await createTempDatabasePath();
  const times = [
    new Date("2026-10-05T12:00:00.000Z"),
    new Date("2026-10-05T12:00:01.000Z"),
    new Date("2026-10-05T12:00:02.000Z"),
  ];
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath, now: sequence(times) });

  try {
    const conversation = store.createConversation();
    const turn = store.commitTurn(conversation.id, "Hello", "Hi there");

    assert.deepEqual(
      [turn.userMessage.sequence, turn.assistantMessage.sequence],
      [1, 2],
    );
    assert.deepEqual(
      [turn.userMessage.role, turn.assistantMessage.role],
      ["user", "assistant"],
    );
    assert.deepEqual(store.getMessages(conversation.id), [
      turn.userMessage,
      turn.assistantMessage,
    ]);
    assert.equal(
      store.getConversation(conversation.id).updatedAt,
      turn.assistantMessage.createdAt,
    );
  } finally {
    store.close();
  }
});

test("failed completed-turn persistence rolls back both messages", async () => {
  const databasePath = await createTempDatabasePath();
  let store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
  const conversation = store.createConversation();
  store.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TRIGGER reject_assistant_turn
    BEFORE INSERT ON messages
    WHEN NEW.role = 'assistant'
    BEGIN
      SELECT RAISE(ABORT, 'forced assistant failure');
    END;
  `);
  database.close();

  store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });
  try {
    const before = store.getConversation(conversation.id);
    assert.throws(
      () => store.commitTurn(conversation.id, "Do not orphan me", "Failure"),
      /forced assistant failure/,
    );
    assert.deepEqual(store.getMessages(conversation.id), []);
    assert.deepEqual(store.getConversation(conversation.id), before);
  } finally {
    store.close();
  }
});


test("conversation listing performs bounded deterministic keyset reads", async () => {
  const databasePath = await createTempDatabasePath();
  const times = [
    new Date("2026-10-05T12:00:00.000Z"),
    new Date("2026-10-05T12:00:01.000Z"),
    new Date("2026-10-05T12:00:02.000Z"),
  ];
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath, now: sequence(times) });

  try {
    const firstCreated = store.createConversation();
    const secondCreated = store.createConversation();
    const thirdCreated = store.createConversation();

    const firstPage = store.listConversations({ limit: 2 });
    assert.deepEqual(firstPage.map(({ id }) => id), [thirdCreated.id, secondCreated.id]);

    const secondPage = store.listConversations({
      limit: 2,
      after: {
        updatedAt: firstPage.at(-1).updatedAt,
        id: firstPage.at(-1).id,
      },
    });
    assert.deepEqual(secondPage.map(({ id }) => id), [firstCreated.id]);
  } finally {
    store.close();
  }
});

test("message retrieval applies its bound inside the store", async () => {
  const databasePath = await createTempDatabasePath();
  const store = createConversationStore({ primaryOwnerId: PRIMARY_OWNER_ID, databasePath });

  try {
    const conversation = store.createConversation();
    store.addUserMessage(conversation.id, "one");
    store.addAssistantMessage(conversation.id, "two");
    store.addUserMessage(conversation.id, "three");

    const messages = store.getMessages(conversation.id, { limit: 2 });
    assert.deepEqual(messages.map(({ sequence }) => sequence), [1, 2]);
  } finally {
    store.close();
  }
});
