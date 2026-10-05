import {
  ConversationNotFoundError,
  ConversationStoreValidationError,
} from "./conversationStore.js";

export const COMPANION_CONVERSATION_LIST_DEFAULT_LIMIT = 20;
export const COMPANION_CONVERSATION_LIST_MAX_LIMIT = 100;
export const COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT = 200;

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
        "The request is invalid.",
      );
    }
  }
}

function parseLimit(value, { defaultLimit, maxLimit }) {
  if (value === undefined || value === null || value === "") return defaultLimit;
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new CompanionConversationValidationError("INVALID_REQUEST", "The request is invalid.");
  }
  const limit = Number(text);
  if (!Number.isSafeInteger(limit) || limit > maxLimit) {
    throw new CompanionConversationValidationError("INVALID_REQUEST", "The request is invalid.");
  }
  return limit;
}

function validateCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) {
    throw new CompanionConversationValidationError("INVALID_REQUEST", "The request is invalid.");
  }
  return value;
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
      "The request is invalid.",
    );
  }
  return error;
}

export function createCompanionConversationService({ conversationStore } = {}) {
  function createConversation(payload = {}) {
    const body = requireObject(payload);
    rejectUnknownKeys(body, new Set());
    requireStoreMethod(conversationStore, "createConversation");

    try {
      const conversation = conversationStore.createConversation();
      return Object.freeze({ ok: true, conversation });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  function listConversations({ limit, cursor } = {}) {
    requireStoreMethod(conversationStore, "listConversations");
    const resolvedLimit = parseLimit(limit, {
      defaultLimit: COMPANION_CONVERSATION_LIST_DEFAULT_LIMIT,
      maxLimit: COMPANION_CONVERSATION_LIST_MAX_LIMIT,
    });
    validateCursor(cursor);

    try {
      const rows = conversationStore.listConversations();
      const conversations = rows.slice(0, resolvedLimit);
      return Object.freeze({
        ok: true,
        conversations,
        hasMore: rows.length > resolvedLimit,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  function getConversation(conversationId, { limit, cursor } = {}) {
    requireStoreMethod(conversationStore, "getConversation");
    requireStoreMethod(conversationStore, "getMessages");
    const resolvedLimit = parseLimit(limit, {
      defaultLimit: COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT,
      maxLimit: COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT,
    });
    validateCursor(cursor);

    try {
      const conversation = conversationStore.getConversation(conversationId);
      if (!conversation) {
        throw new ConversationNotFoundError(conversationId);
      }
      const rows = conversationStore.getMessages(conversationId);
      const messages = rows.slice(0, resolvedLimit);
      return Object.freeze({
        ok: true,
        conversation,
        messages,
        hasMore: rows.length > resolvedLimit,
      });
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
