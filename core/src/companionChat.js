export const COMPANION_CHAT_MAX_MESSAGE_CHARS = 8000;

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

export async function handleCompanionChat({ message }) {
  validateCompanionChatMessage(message);

  // Temporary v1 transport response. Replace this boundary with Selene's
  // non-privileged conversational pipeline when that is designed.
  return {
    ok: true,
    reply: "I'm here.",
    state: "idle",
    events: [],
  };
}
