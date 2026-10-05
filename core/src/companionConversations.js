import {
  ConversationNotFoundError,
  ConversationStoreValidationError,
} from "./conversationStore.js";

export const COMPANION_CONVERSATION_LIST_LIMIT = 50;

export class CompanionConversationValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompanionConversationValidationError";
    this.code = code;
  }
}

function requireStoreMethod(store, method) {
  if (!store || typeof store[method] !== "function") {
    throw new Error("Conversation store unavailable.");
  }
}

function requireObject(value, message = "Request body must be a JSON object.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionConversationValidationError("INVALID_REQUEST", message);
  }
  return value;
}

function rejectUnknownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CompanionConversationValidationError(
        "INVALID_REQUEST",
        `Unsupported field: ${key}.`,
      );
    }
  }
}

function mapStoreError(error) {
  if (error instanceof ConversationNotFoundError) {
    return new CompanionConversationValidationError(
      "CONVERSATION_NOT_FOUND",
      "Conversation not found.",
    );
  }
  if (error instanceof ConversationStoreValidationError) {
    return new CompanionConversationValidationError(
      "INVALID_REQUEST",
      error.message,
    );
  }
  return error;
}

export function createCompanionConversationService({ conversationStore } = {}) {
  function createConversation(payload = {}) {
    const body = requireObject(payload);
    rejectUnknownKeys(body, new Set(["title"]));
    requireStoreMethod(conversationStore, "createConversation");

    try {
      const conversation = conversationStore.createConversation({
        title: body.title ?? null,
      });
      return Object.freeze({ ok: true, conversation });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  function listConversations() {
    requireStoreMethod(conversationStore, "listConversations");

    try {
      const conversations = conversationStore
        .listConversations()
        .slice(0, COMPANION_CONVERSATION_LIST_LIMIT);
      return Object.freeze({
        ok: true,
        conversations,
        limit: COMPANION_CONVERSATION_LIST_LIMIT,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  function getConversation(conversationId) {
    requireStoreMethod(conversationStore, "getConversation");
    requireStoreMethod(conversationStore, "getMessages");

    try {
      const conversation = conversationStore.getConversation(conversationId);
      if (!conversation) {
        throw new ConversationNotFoundError(conversationId);
      }
      const messages = conversationStore.getMessages(conversationId);
      return Object.freeze({ ok: true, conversation, messages });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  return Object.freeze({
    createConversation,
    listConversations,
    getConversation,
  });
}
