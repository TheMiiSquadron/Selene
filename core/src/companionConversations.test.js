import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPANION_CONVERSATION_LIST_DEFAULT_LIMIT,
  COMPANION_CONVERSATION_LIST_MAX_LIMIT,
  COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT,
  CompanionConversationValidationError,
  createCompanionConversationService,
} from "./companionConversations.js";

const ID = "00000000-0000-4000-8000-000000000001";

test("conversation service exposes its operations", () => {
  const service = createCompanionConversationService({ conversationStore: {} });
  assert.equal(typeof service.createConversation, "function");
  assert.equal(typeof service.listConversations, "function");
  assert.equal(typeof service.getConversation, "function");
});

test("conversation creation accepts only an empty client object", () => {
  const calls = [];
  const service = createCompanionConversationService({
    conversationStore: {
      createConversation(...args) {
        calls.push(args);
        return { id: ID, title: null };
      },
    },
  });

  assert.equal(service.createConversation({}).conversation.title, null);
  assert.deepEqual(calls, [[]]);
  assert.throws(
    () => service.createConversation({ title: "client title" }),
    (error) => error instanceof CompanionConversationValidationError
      && error.code === "INVALID_REQUEST",
  );
});

test("conversation lists default to 20 and reject limits above 100", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ id: String(index) }));
  const service = createCompanionConversationService({
    conversationStore: { listConversations() { return rows; } },
  });

  const result = service.listConversations();
  assert.equal(COMPANION_CONVERSATION_LIST_DEFAULT_LIMIT, 20);
  assert.equal(COMPANION_CONVERSATION_LIST_MAX_LIMIT, 100);
  assert.equal(result.conversations.length, 20);
  assert.equal(result.hasMore, true);
  assert.throws(
    () => service.listConversations({ limit: 101 }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("conversation retrieval is bounded to 200 chronological messages", () => {
  const messages = Array.from({ length: 201 }, (_, index) => ({
    sequence: index + 1,
  }));
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID, title: null }; },
      getMessages() { return messages; },
    },
  });

  const result = service.getConversation(ID);
  assert.equal(COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT, 200);
  assert.equal(result.messages.length, 200);
  assert.equal(result.messages[0].sequence, 1);
  assert.equal(result.messages.at(-1).sequence, 200);
  assert.equal(result.hasMore, true);
  assert.throws(
    () => service.getConversation(ID, { limit: 201 }),
    (error) => error.code === "INVALID_REQUEST",
  );
});
