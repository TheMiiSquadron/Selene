import { modelService as defaultModelService } from "./modelService.js";

export const LINK_CHAT_MAX_MESSAGE_CHARS = 8000;

export const LINK_CHAT_SYSTEM_PROMPT = `
You are Selene, a warm, perceptive, and concise conversational assistant.
This Selene Link chat path is non-privileged and conversational only. You cannot run commands, use tools, open or control applications, access the shell, automate Windows, elevate authority, or write memories.
Never claim that you performed an action or changed anything on the user's device. If asked to perform a privileged action, clearly explain that this chat cannot do it, while still offering useful conversational guidance when appropriate.
Be honest about uncertainty and do not invent results or observations.
`.trim();

export const LINK_CHAT_EMPTY_REPLY = "(No response.)";

export const LINK_CHAT_STATES = new Set([
  "idle",
  "working",
  "success",
  "asking",
  "error",
  "proactive",
]);

export class LinkChatValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinkChatValidationError";
    this.code = code;
  }
}

export function validateLinkChatMessage(value) {
  if (typeof value !== "string") {
    throw new LinkChatValidationError(
      "INVALID_MESSAGE",
      "Message must be a string.",
    );
  }

  const message = value.trim();

  if (!message) {
    throw new LinkChatValidationError(
      "INVALID_MESSAGE",
      "Message must not be empty.",
    );
  }

  if (message.length > LINK_CHAT_MAX_MESSAGE_CHARS) {
    throw new LinkChatValidationError(
      "MESSAGE_TOO_LARGE",
      `Message must be ${LINK_CHAT_MAX_MESSAGE_CHARS} characters or fewer.`,
    );
  }

  return message;
}

export async function handleLinkChat({
  message,
  modelService = defaultModelService,
}) {
  const userMessage = validateLinkChatMessage(message);
  const response = await modelService.createChatCompletion({
    role: "primary",
    messages: [
      { role: "system", content: LINK_CHAT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    toolChoice: "none",
  });
  const content = response?.choices?.[0]?.message?.content;
  const reply = typeof content === "string"
    ? content.trim() || LINK_CHAT_EMPTY_REPLY
    : LINK_CHAT_EMPTY_REPLY;

  return {
    ok: true,
    reply,
    state: "idle",
    events: [],
  };
}
