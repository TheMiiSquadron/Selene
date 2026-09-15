import { modelService as defaultModelService } from "./modelService.js";

export const COMPANION_CHAT_MAX_MESSAGE_CHARS = 8000;

export const COMPANION_CHAT_SYSTEM_PROMPT = `
You are Selene, a warm, perceptive, and concise conversational assistant.
This Companion chat path is non-privileged and conversational only. You cannot run commands, use tools, open or control applications, access the shell, automate Windows, elevate authority, or write memories.
Never claim that you performed an action or changed anything on the user's device. If asked to perform a privileged action, clearly explain that this chat cannot do it, while still offering useful conversational guidance when appropriate.
Be honest about uncertainty and do not invent results or observations.
`.trim();

export const COMPANION_CHAT_EMPTY_REPLY = "(No response.)";

export const COMPANION_CHAT_STATES = new Set([
  "idle",
  "working",
  "success",
  "asking",
  "error",
  "proactive",
]);

export class CompanionChatValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompanionChatValidationError";
    this.code = code;
  }
}

export function validateCompanionChatMessage(value) {
  if (typeof value !== "string") {
    throw new CompanionChatValidationError(
      "INVALID_MESSAGE",
      "Message must be a string.",
    );
  }

  const message = value.trim();

  if (!message) {
    throw new CompanionChatValidationError(
      "INVALID_MESSAGE",
      "Message must not be empty.",
    );
  }

  if (message.length > COMPANION_CHAT_MAX_MESSAGE_CHARS) {
    throw new CompanionChatValidationError(
      "MESSAGE_TOO_LARGE",
      `Message must be ${COMPANION_CHAT_MAX_MESSAGE_CHARS} characters or fewer.`,
    );
  }

  return message;
}

export async function handleCompanionChat({
  message,
  modelService = defaultModelService,
}) {
  const userMessage = validateCompanionChatMessage(message);
  const response = await modelService.createChatCompletion({
    role: "primary",
    messages: [
      { role: "system", content: COMPANION_CHAT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    toolChoice: "none",
  });
  const content = response?.choices?.[0]?.message?.content;
  const reply = typeof content === "string"
    ? content.trim() || COMPANION_CHAT_EMPTY_REPLY
    : COMPANION_CHAT_EMPTY_REPLY;

  return {
    ok: true,
    reply,
    state: "idle",
    events: [],
  };
}
