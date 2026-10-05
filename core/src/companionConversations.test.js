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
      commitTurn(id, userContent, assistantContent) {
        commitCalls.push([id, userContent, assistantContent]);
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

  const result = await service.sendMessage(ID, { message: "What was my test word?" });

  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].role, "primary");
  assert.equal(modelCalls[0].toolChoice, "none");
  assert.deepEqual(modelCalls[0].messages.slice(1), [
    { role: "user", content: "My test word is heliotrope." },
    { role: "assistant", content: "I will remember it here." },
    { role: "user", content: "What was my test word?" },
  ]);
  assert.deepEqual(commitCalls, [[
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
    service.sendMessage(ID, { message: "Hello" }),
    (error) => error.code === "MODEL_UNAVAILABLE"
      && !String(error.message).includes("private model failure"),
  );
  assert.equal(commits, 0);
});

test("persistent turns fail cleanly above the 200-message context bound", async () => {
  let modelCalls = 0;
  let commits = 0;
  const service = createCompanionConversationService({
    conversationStore: {
      getConversation() { return { id: ID }; },
      getMessages() {
        return Array.from({ length: 201 }, (_, index) => ({
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
    service.sendMessage(ID, { message: "Continue" }),
    (error) => error.code === "CONTEXT_LIMIT_EXCEEDED",
  );
  assert.equal(modelCalls, 0);
  assert.equal(commits, 0);
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

  const first = service.sendMessage(ID, { message: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.sendMessage(ID, { message: "second" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(modelCall, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(seenHistoryLengths, [0, 2]);
  assert.deepEqual(stored.map(({ sequence }) => sequence), [1, 2, 3, 4]);
});
