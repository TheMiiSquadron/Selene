import {
  authorizationFailurePayload,
  authorizeToolAction,
} from "./authority.js";
import { windowsInputAdapter } from "./inputAdapter.js";
import { logEvent } from "./logger.js";
import { listShortcutIds, resolveShortcut } from "./shortcuts.js";

const MAX_TYPE_TEXT_LENGTH = 4000;

export function validateTypeText(value) {
  const text = String(value ?? "");
  if (!text) return { ok: false, reason: "No text was provided." };
  if (text.length > MAX_TYPE_TEXT_LENGTH) {
    return {
      ok: false,
      reason: `Text is too long. Maximum length is ${MAX_TYPE_TEXT_LENGTH} characters.`,
    };
  }
  return { ok: true, text };
}

export async function typeText(value, options = {}) {
  const authority = await authorizeToolAction("type_text", {
    authorityToken: options.authorityToken,
  });

  if (!authority.allowed) {
    return authorizationFailurePayload(authority);
  }

  const validated = validateTypeText(value);
  if (!validated.ok) {
    return {
      ok: false,
      action: "type_text",
      message: "Typing cancelled.",
      reason: validated.reason,
    };
  }

  const adapter = options.inputAdapter ?? windowsInputAdapter;
  const inputOptions = {};
  if (options.expectedWindowTitle) inputOptions.expectedWindowTitle = options.expectedWindowTitle;
  if (options.expectedProcessId) inputOptions.expectedProcessId = options.expectedProcessId;

  const typed = await adapter.typeText(validated.text, inputOptions);

  if (!typed.ok) {
    return {
      ok: false,
      action: "type_text",
      message: "Typing cancelled.",
      reason: typed.focusMismatch
        ? "The intended application is no longer in the foreground."
        : typed.reason || "Windows input could not be sent.",
    };
  }

  await logEvent({
    taskId: options.taskId,
    route: "tool",
    action: "type_text",
    target: options.expectedWindowTitle ?? "foreground",
    typedCharacters: validated.text.length,
    result: "input_dispatched",
  });

  return {
    ok: true,
    action: "type_text",
    message: options.expectedWindowTitle
      ? `Input dispatched to confirmed ${options.expectedWindowTitle} foreground window.`
      : "Input dispatched to foreground window.",
    typedCharacters: validated.text.length,
    targetConfirmed: Boolean(options.expectedWindowTitle || options.expectedProcessId),
    dispatchVerified: true,
    visualResultVerified: false,
  };
}

export async function keyboardShortcut(value, options = {}) {
  const authority = await authorizeToolAction("keyboard_shortcut", {
    authorityToken: options.authorityToken,
  });

  if (!authority.allowed) {
    return authorizationFailurePayload(authority);
  }

  const resolved = resolveShortcut(value);
  if (!resolved) {
    return {
      ok: false,
      action: "keyboard_shortcut",
      message: "Keyboard shortcut cancelled.",
      reason: `Unsupported keyboard shortcut. Allowed shortcuts: ${listShortcutIds().join(", ")}.`,
    };
  }

  const adapter = options.inputAdapter ?? windowsInputAdapter;
  const inputOptions = {};
  if (options.expectedWindowTitle) inputOptions.expectedWindowTitle = options.expectedWindowTitle;
  if (options.expectedProcessId) inputOptions.expectedProcessId = options.expectedProcessId;

  const sent = await adapter.keyboardShortcut(resolved.id, inputOptions);

  if (!sent.ok) {
    return {
      ok: false,
      action: "keyboard_shortcut",
      shortcut: resolved.id,
      message: "Keyboard shortcut cancelled.",
      reason: sent.focusMismatch
        ? "The intended application is no longer in the foreground."
        : sent.reason || "Windows input could not be sent.",
    };
  }

  await logEvent({
    taskId: options.taskId,
    route: "tool",
    action: "keyboard_shortcut",
    shortcut: resolved.id,
    target: options.expectedWindowTitle ?? "foreground",
    result: "input_dispatched",
  });

  return {
    ok: true,
    action: "keyboard_shortcut",
    shortcut: resolved.id,
    message: options.expectedWindowTitle
      ? `Shortcut ${resolved.id} dispatched to confirmed ${options.expectedWindowTitle} foreground window.`
      : `Shortcut ${resolved.id} dispatched to foreground window.`,
    targetConfirmed: Boolean(options.expectedWindowTitle || options.expectedProcessId),
    dispatchVerified: true,
    visualResultVerified: false,
  };
}
