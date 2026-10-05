import {
  COMPANION_CHAT_SYSTEM_PROMPT,
  CompanionChatValidationError,
  validateCompanionChatMessage,
} from "./companionChat.js";
import {
  ConversationNotFoundError,
  ConversationStoreValidationError,
} from "./conversationStore.js";
import { modelService as defaultModelService } from "./modelService.js";

export const COMPANION_CONVERSATION_LIST_DEFAULT_LIMIT = 20;
export const COMPANION_CONVERSATION_LIST_MAX_LIMIT = 100;
export const COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT = 200;
export const COMPANION_CONVERSATION_CONTEXT_MAX_MESSAGES = 200;

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

function encodeCursor(conversation) {
  return Buffer.from(JSON.stringify({
    updatedAt: conversation.updatedAt,
    id: conversation.id,
  }), "utf8").toString("base64url");
}

function validateCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CompanionConversationValidationError("INVALID_REQUEST", "The request is invalid.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "id,updatedAt"
      || typeof parsed.updatedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.updatedAt))
      || typeof parsed.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) {
      throw new Error();
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id.toLowerCase() };
  } catch {
    throw new CompanionConversationValidationError("INVALID_REQUEST", "The request is invalid.");
  }
}

function validateTurnPayload(payload) {
  const body = requireObject(payload);
  rejectUnknownKeys(body, new Set(["message"]));
  try {
    return validateCompanionChatMessage(body.message);
  } catch (error) {
    if (error instanceof CompanionChatValidationError) {
      throw new CompanionConversationValidationError(
        "INVALID_REQUEST",
        "The request is invalid.",
      );
    }
    throw error;
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
      "The request is invalid.",
    );
  }
  return error;
}

function extractAssistantReply(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new CompanionConversationValidationError(
      "MODEL_UNAVAILABLE",
      "Selene is temporarily unavailable.",
    );
  }
  return content.trim();
}

export function createCompanionConversationService({
  conversationStore,
  modelService = defaultModelService,
} = {}) {
  const turnQueues = new Map();

  async function runSerializedTurn(conversationId, operation) {
    const previous = turnQueues.get(conversationId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    turnQueues.set(conversationId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (turnQueues.get(conversationId) === tail) {
        turnQueues.delete(conversationId);
      }
    }
  }

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
    const after = validateCursor(cursor);

    try {
      const rows = conversationStore.listConversations({
        limit: resolvedLimit + 1,
        after,
      });
      const hasMore = rows.length > resolvedLimit;
      const conversations = rows.slice(0, resolvedLimit);
      return Object.freeze({
        ok: true,
        conversations,
        hasMore,
        nextCursor: hasMore ? encodeCursor(conversations.at(-1)) : null,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  function getConversation(conversationId, { limit, cursor } = {}) {
    requireStoreMethod(conversationStore, "getConversation");
    requireStoreMethod(conversationStore, "getMessages");
    if (limit !== undefined || cursor !== undefined) {
      throw new CompanionConversationValidationError("INVALID_REQUEST", "The request is invalid.");
    }

    try {
      const conversation = conversationStore.getConversation(conversationId);
      if (!conversation) {
        throw new ConversationNotFoundError(conversationId);
      }
      const messages = conversationStore.getMessages(conversationId, {
        limit: COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT + 1,
      });
      if (messages.length > COMPANION_CONVERSATION_MESSAGE_MAX_LIMIT) {
        throw new CompanionConversationValidationError(
          "CONTEXT_LIMIT_EXCEEDED",
          "Conversation context limit exceeded.",
        );
      }
      return Object.freeze({
        ok: true,
        conversation,
        messages,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  async function sendMessage(conversationId, payload) {
    const userContent = validateTurnPayload(payload);
    requireStoreMethod(conversationStore, "getConversation");
    requireStoreMethod(conversationStore, "getMessages");
    requireStoreMethod(conversationStore, "commitTurn");
    if (!modelService || typeof modelService.createChatCompletion !== "function") {
      throw new Error("Model service unavailable.");
    }

    return runSerializedTurn(conversationId, async () => {
      let conversation;
      let history;
      try {
        conversation = conversationStore.getConversation(conversationId);
        if (!conversation) throw new ConversationNotFoundError(conversationId);
        history = conversationStore.getMessages(conversationId);
      } catch (error) {
        throw mapStoreError(error);
      }

      if (history.length > COMPANION_CONVERSATION_CONTEXT_MAX_MESSAGES) {
        throw new CompanionConversationValidationError(
          "CONTEXT_LIMIT_EXCEEDED",
          "Conversation context limit exceeded.",
        );
      }

      let response;
      try {
        response = await modelService.createChatCompletion({
          role: "primary",
          messages: [
            { role: "system", content: COMPANION_CHAT_SYSTEM_PROMPT },
            ...history.map(({ role, content }) => ({ role, content })),
            { role: "user", content: userContent },
          ],
          toolChoice: "none",
        });
      } catch {
        throw new CompanionConversationValidationError(
          "MODEL_UNAVAILABLE",
          "Selene is temporarily unavailable.",
        );
      }

      const assistantContent = extractAssistantReply(response);

      try {
        const { userMessage, assistantMessage } = conversationStore.commitTurn(
          conversation.id,
          userContent,
          assistantContent,
        );
        return Object.freeze({
          conversationId: conversation.id,
          userMessage,
          assistantMessage,
        });
      } catch (error) {
        throw mapStoreError(error);
      }
    });
  }

  return Object.freeze({
    createConversation,
    listConversations,
    getConversation,
    sendMessage,
  });
}
