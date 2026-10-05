import test from "node:test";
import assert from "node:assert/strict";
import { createCompanionConversationService } from "./companionConversations.js";

test("conversation service exposes its operations", () => {
  const service = createCompanionConversationService({ conversationStore: {} });
  assert.equal(typeof service.createConversation, "function");
  assert.equal(typeof service.listConversations, "function");
  assert.equal(typeof service.getConversation, "function");
});
