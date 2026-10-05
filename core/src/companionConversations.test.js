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
const OWNER_ID = "00000000-0000-4000-8000-0000000000aa";

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

  assert.equal(service.createConversation(OWNER_ID, {}).conversation.title, null);
  assert.deepEqual(calls, [[OWNER_ID]]);
  assert.throws(
    () => service.createConversation(OWNER_ID, { title: "client title" }),
    (error) => error instanceof CompanionConversationValidationError
      && error.code === "INVALID_REQUEST",
  );
});

test("conversation lists use bounded keyset pagination and opaque cursors", () => {
  const calls = [];
  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    updatedAt: new Date(Date.UTC(2026, 9, 5, 20, 0, 20 - index)).toISOString(),
  }));
  const service = createCompanionConversationService({
    conversationStore: {
      listConversations(ownerId, options) {
        calls.push([ownerId, options]);
        return rows;
      },
    },
  });

  const first = service.listConversations(OWNER_ID, );
  assert.equal(COMPANION_CONVERSATION_LIST_DEFAULT_LIMIT, 20);
  assert.equal(COMPANION_CONVERSATION_LIST_MAX_LIMIT, 100);
  assert.equal(first.conversations.length, 20);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");
  assert.deepEqual(calls[0], [OWNER_ID, { limit: 21, after: null }]);

  service.listConversations(OWNER_ID, { limit: 20, cursor: first.nextCursor });
  assert.deepEqual(calls[1], [OWNER_ID, {
    limit: 21,
    after: {
      updatedAt: rows[19].updatedAt,
      id: rows[19].id,
    },
  }]);

  assert.throws(
    () => service.listConversations(OWNER_ID, { limit: 101 }),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => service.listConversations(OWNER_ID, { cursor: "not-a-valid-cursor" }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("conversation retrieval returns complete bounded history and rejects overflow", () => {
  const calls = [];
  const messages = Array.from({ length: 200 }, (_, index) => ({
    sequence: index + 1,
  }));
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID, title: null }; },
      getMessages(ownerId, id, options) {
        calls.push([ownerId, id, options]);
        return messages;
      },
    },
  });

  const result = service.getConversation(OWNER_ID, ID);
  assert.equal(COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT, 200);
  assert.equal(result.messages.length, 200);
  assert.equal(result.messages[0].sequence, 1);
  assert.equal(result.messages.at(-1).sequence, 200);
  assert.deepEqual(calls, [[OWNER_ID, ID, { limit: 201 }]]);
  assert.throws(
    () => service.getConversation(OWNER_ID, ID, { limit: 20 }),
    (error) => error.code === "INVALID_REQUEST",
  );

  const overflow = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID, title: null }; },
      getMessages() {
        return Array.from({ length: 201 }, (_, index) => ({ sequence: index + 1 }));
      },
    },
  });
  assert.throws(
    () => overflow.getConversation(OWNER_ID, ID),
    (error) => error.code === "CONTEXT_LIMIT_EXCEEDED",
  );
});


test("persistent turn supplies chronological history and commits the authoritative pair", async () => {
  const history = [
    { sequence: 1, role: "user", content: "My test word is heliotrope." },
    { sequence: 2, role: "assistant", content: "I will remember it here." },
  ];
  const modelCalls = [];
  const commitCalls = [];
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID, title: null }; },
      getMessages() { return history; },
      commitTurn(ownerId, id, userContent, assistantContent) {
        commitCalls.push([ownerId, id, userContent, assistantContent]);
        return {
          userMessage: { sequence: 3, role: "user", content: userContent, createdAt: "u" },
          assistantMessage: { sequence: 4, role: "assistant", content: assistantContent, createdAt: "a" },
        };
      },
    },
    modelService: {
      async createChatCompletion(request) {
        modelCalls.push(request);
        return { choices: [{ message: { content: "Your test word was heliotrope." } }] };
      },
    },
  });

  const result = await service.sendMessage(OWNER_ID, ID, { message: "What was my test word?" });

  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].role, "primary");
  assert.equal(modelCalls[0].toolChoice, "none");
  assert.deepEqual(modelCalls[0].messages.slice(1), [
    { role: "user", content: "My test word is heliotrope." },
    { role: "assistant", content: "I will remember it here." },
    { role: "user", content: "What was my test word?" },
  ]);
  assert.deepEqual(commitCalls, [[
    OWNER_ID,
    ID,
    "What was my test word?",
    "Your test word was heliotrope.",
  ]]);
  assert.equal(result.conversationId, ID);
  assert.equal(result.userMessage.sequence, 3);
  assert.equal(result.assistantMessage.sequence, 4);
});

test("model failure leaves persistent conversation history unchanged", async () => {
  let commits = 0;
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID }; },
      getMessages() { return []; },
      commitTurn() { commits += 1; },
    },
    modelService: {
      async createChatCompletion() { throw new Error("private model failure"); },
    },
  });

  await assert.rejects(
    service.sendMessage(OWNER_ID, ID, { message: "Hello" }),
    (error) => error.code === "MODEL_UNAVAILABLE"
      && !String(error.message).includes("private model failure"),
  );
  assert.equal(commits, 0);
});

test("persistent turns reject a new pair when it would exceed the 200-message ceiling", async () => {
  for (const historyLength of [199, 200, 201]) {
    let modelCalls = 0;
    let commits = 0;
    const service = createCompanionConversationService({
      conversationStore: {
        getConversation() { return { id: ID }; },
        getMessages() {
          return Array.from({ length: historyLength }, (_, index) => ({
            sequence: index + 1,
            role: index % 2 === 0 ? "user" : "assistant",
            content: `message ${index + 1}`,
          }));
        },
        commitTurn() { commits += 1; },
      },
      modelService: {
        async createChatCompletion() { modelCalls += 1; },
      },
    });

    await assert.rejects(
      service.sendMessage(OWNER_ID, ID, { message: "Continue" }),
      (error) => error.code === "CONTEXT_LIMIT_EXCEEDED",
    );
    assert.equal(modelCalls, 0);
    assert.equal(commits, 0);
  }
});

test("persistent turns allow the final pair that reaches exactly 200 messages", async () => {
  const history = Array.from({ length: 198 }, (_, index) => ({
    sequence: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1}`,
  }));
  let commits = 0;
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID }; },
      getMessages() { return history; },
      commitTurn(_id, userContent, assistantContent) {
        commits += 1;
        return {
          userMessage: { sequence: 199, role: "user", content: userContent },
          assistantMessage: { sequence: 200, role: "assistant", content: assistantContent },
        };
      },
    },
    modelService: {
      async createChatCompletion() {
        return { choices: [{ message: { content: "final reply" } }] };
      },
    },
  });

  const result = await service.sendMessage(OWNER_ID, ID, { message: "final turn" });
  assert.equal(commits, 1);
  assert.equal(result.userMessage.sequence, 199);
  assert.equal(result.assistantMessage.sequence, 200);
});

test("turns serialize per conversation so the next turn sees the prior commit", async () => {
  const stored = [];
  const seenHistoryLengths = [];
  let releaseFirst;
  const firstGeneration = new Promise((resolve) => { releaseFirst = resolve; });
  let modelCall = 0;
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID }; },
      getMessages() { return [...stored]; },
      commitTurn(_id, userContent, assistantContent) {
        const sequence = stored.length + 1;
        const userMessage = { sequence, role: "user", content: userContent };
        const assistantMessage = { sequence: sequence + 1, role: "assistant", content: assistantContent };
        stored.push(userMessage, assistantMessage);
        return { userMessage, assistantMessage };
      },
    },
    modelService: {
      async createChatCompletion({ messages }) {
        seenHistoryLengths.push(messages.length - 2);
        modelCall += 1;
        if (modelCall === 1) await firstGeneration;
        return { choices: [{ message: { content: `reply ${modelCall}` } }] };
      },
    },
  });

  const first = service.sendMessage(OWNER_ID, ID, { message: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.sendMessage(OWNER_ID, ID, { message: "second" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(modelCall, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(seenHistoryLengths, [0, 2]);
  assert.deepEqual(stored.map(({ sequence }) => sequence), [1, 2, 3, 4]);
});
