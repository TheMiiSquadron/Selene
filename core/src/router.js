import { randomUUID } from "node:crypto";
import { awarenessService } from "./awareness.js";
import { keyboardShortcut, typeText } from "./interact.js";
import { logEvent } from "./logger.js";
import { openApp, openUrl } from "./tools.js";

const pendingContinuations = new Map();
const CONTINUATION_TTL_MS = 5 * 60_000;

const NATURAL_SHORTCUTS = {
  "select all": "ctrl+a",
  copy: "ctrl+c",
  paste: "ctrl+v",
  cut: "ctrl+x",
  undo: "ctrl+z",
  redo: "ctrl+y",
  save: "ctrl+s",
  find: "ctrl+f",
};

const AWARENESS_QUERY_PHRASES = new Set([
  "what app am i in",
  "what application am i in",
  "what app am i using",
  "what application am i using",
  "what window is active",
  "what is the active window",
  "what am i currently using",
  "which app is in the foreground",
  "which application is in the foreground",
]);

const CONTEXT_QUERY_PHRASES = new Set([
  "what am i working on",
  "what am i doing right now",
  "what am i doing",
  "what project am i in",
  "what am i looking at",
  "what am i working in",
]);

const FRIENDLY_PROCESS_NAMES = {
  "code.exe": "Visual Studio Code",
  "chrome.exe": "Google Chrome",
  "firefox.exe": "Firefox",
  "explorer.exe": "File Explorer",
  "notepad.exe": "Notepad",
  "discord.exe": "Discord",
};

function normalize(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[?.!,]+$/g, "")
    .replace(/\s+/g, " ");
}

function normalizeIntent(text) {
  let value = normalize(text);
  let previous = "";

  while (value && value !== previous) {
    previous = value;
    value = value.replace(/^(?:okay|ok|so|now),?\s+/, "");
  }

  return value;
}

function friendlyProcessName(processName) {
  const process = String(processName ?? "").trim();
  if (!process) return "";
  return FRIENDLY_PROCESS_NAMES[process.toLowerCase()] ?? process;
}

function isAwarenessQuery(text) {
  return AWARENESS_QUERY_PHRASES.has(normalizeIntent(text));
}

function isContextQuery(text) {
  return CONTEXT_QUERY_PHRASES.has(normalizeIntent(text));
}

function stripTitleSuffix(title, suffixes) {
  const value = String(title ?? "").trim();
  for (const suffix of suffixes) {
    if (value.toLowerCase().endsWith(suffix.toLowerCase())) {
      return value.slice(0, -suffix.length).trim();
    }
  }
  return value;
}

function quoteTitle(value) {
  return `'${String(value ?? "").trim()}'`;
}

function parseVsCodeTitle(title) {
  const withoutSuffix = stripTitleSuffix(title, [" - Visual Studio Code"]);
  const parts = withoutSuffix.split(" - ").map((part) => part.trim()).filter(Boolean);
  const file = parts[0] ?? "";
  const workspace = parts.length > 1 ? parts.at(-1) : "";
  return { file, workspace };
}

function interpretForegroundContext(foreground) {
  const process = String(foreground?.process ?? "").trim();
  const title = String(foreground?.title ?? "").trim();
  const appName = friendlyProcessName(process) || process || "the current app";
  const processKey = process.toLowerCase();

  if (processKey === "code.exe") {
    const parsed = parseVsCodeTitle(title);
    if (parsed.file && parsed.workspace) {
      return {
        application: appName,
        message: `It looks like you're working in ${appName} on ${parsed.workspace}, with ${parsed.file} open.`,
      };
    }
    if (parsed.file) {
      return {
        application: appName,
        message: `It looks like you're working in ${appName}, with ${parsed.file} open.`,
      };
    }
  }

  if (processKey === "chrome.exe") {
    const page = stripTitleSuffix(title, [" - Google Chrome"]);
    if (page) {
      return {
        application: appName,
        message: `It looks like you're viewing ${quoteTitle(page)} in ${appName}.`,
      };
    }
  }

  if (processKey === "firefox.exe") {
    const page = stripTitleSuffix(title, [" - Mozilla Firefox", " \u2014 Mozilla Firefox", " - Firefox"]);
    if (page) {
      return {
        application: appName,
        message: `It looks like you're viewing ${quoteTitle(page)} in ${appName}.`,
      };
    }
  }

  if (processKey === "notepad.exe") {
    const documentTitle = stripTitleSuffix(title, [" - Notepad"]);
    if (documentTitle) {
      return {
        application: appName,
        message: `It looks like you're working in ${appName}, with ${documentTitle} open.`,
      };
    }
  }

  if (processKey === "discord.exe") {
    const view = stripTitleSuffix(title, [" - Discord"]);
    if (view) {
      return {
        application: appName,
        message: `You're in ${appName}, on ${quoteTitle(view)}.`,
      };
    }
  }

  if (processKey === "explorer.exe") {
    if (title) {
      return {
        application: appName,
        message: `It looks like you're viewing ${quoteTitle(title)} in ${appName}.`,
      };
    }
  }

  if (title) {
    return {
      application: appName,
      message: `You're currently in ${appName}, on ${quoteTitle(title)}.`,
    };
  }

  return {
    application: appName,
    message: `You're currently using ${appName}.`,
  };
}

export function formatAwarenessAnswer(state) {
  if (!state?.enabled) {
    return {
      ok: true,
      action: "awareness_query",
      awarenessEnabled: false,
      message: "I can't see the active window because Active Window awareness is disabled.",
    };
  }

  const foreground = state.foreground;
  if (!foreground?.process && !foreground?.title) {
    return {
      ok: true,
      action: "awareness_query",
      awarenessEnabled: true,
      message: "I can't determine the active window right now.",
    };
  }

  const appName = friendlyProcessName(foreground.process);
  const title = String(foreground.title ?? "").trim();
  const titleAddsDetail = title && title.toLowerCase() !== appName.toLowerCase();

  return {
    ok: true,
    action: "awareness_query",
    awarenessEnabled: true,
    foreground: {
      process: foreground.process,
      application: appName || foreground.process,
      title,
      observedAt: foreground.observedAt,
    },
    message: titleAddsDetail
      ? `You're currently in ${appName || foreground.process} - ${title}.`
      : `You're currently in ${appName || foreground.process}.`,
  };
}

export function formatAwarenessContextAnswer(state) {
  if (!state?.enabled) {
    return {
      ok: true,
      action: "awareness_context_query",
      awarenessEnabled: false,
      message: "I can't tell what you're working on because Active Window awareness is disabled.",
    };
  }

  const foreground = state.foreground;
  if (!foreground?.process && !foreground?.title) {
    return {
      ok: true,
      action: "awareness_context_query",
      awarenessEnabled: true,
      message: "I can't determine what you're working on right now.",
    };
  }

  const interpretation = interpretForegroundContext(foreground);

  return {
    ok: true,
    action: "awareness_context_query",
    awarenessEnabled: true,
    foreground: {
      process: foreground.process,
      application: interpretation.application,
      observedAt: foreground.observedAt,
    },
    message: interpretation.message,
  };
}

async function answerAwarenessQuery(options = {}) {
  const service = options.awarenessService ?? awarenessService;
  return formatAwarenessAnswer(service.getState());
}

async function answerAwarenessContextQuery(options = {}) {
  const service = options.awarenessService ?? awarenessService;
  return formatAwarenessContextAnswer(service.getState());
}

function cleanContinuations(now = Date.now()) {
  const expired = [];
  for (const [key, continuation] of pendingContinuations) {
    if (now - continuation.createdAt > CONTINUATION_TTL_MS) {
      pendingContinuations.delete(key);
      expired.push(key);
    }
  }
  return expired;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getWindowTitleHint(openResult) {
  if (openResult?.appId === "notepad") return "Notepad";
  return openResult?.windowTitle ?? openResult?.appName;
}

function getFocusOptions(context) {
  return {
    expectedWindowTitle: getWindowTitleHint(context.openResult),
    expectedProcessId: context.openResult?.processId,
  };
}

function blockedResult(result, continuation) {
  return {
    ...result,
    continuationId: continuation.id,
    continuationPending: true,
  };
}

function parseShortcutPhrase(value) {
  const text = normalize(value).replace(/^then /, "");
  if (NATURAL_SHORTCUTS[text]) return NATURAL_SHORTCUTS[text];

  const direct = text.match(/^(?:press|send) (.+)$/);
  if (direct) return direct[1];

  return null;
}

function normalizeTypedContent(value) {
  let text = String(value ?? "").trim();

  const quoted = text.match(/^["'`](.*)["'`]$/s);
  if (quoted) {
    return quoted[1];
  }

  text = text
    .replace(/^(?:the\s+)?(?:text|words?|phrase)\s+/i, "")
    .replace(/^(?:a\s+)?(?:note|message)\s+(?:that\s+)?(?:says?|saying)\s+/i, "")
    .replace(/^saying\s+/i, "")
    .replace(/\s+into\s+(?:it|notepad|the\s+app|the\s+window)$/i, "")
    .trim();

  const innerQuoted = text.match(/^(?:that\s+says?|saying)\s+["'`](.*)["'`]$/is);
  if (innerQuoted) {
    return innerQuoted[1];
  }

  const normalizedQuoted = text.match(/^["'`](.*)["'`]$/s);
  if (normalizedQuoted) {
    return normalizedQuoted[1];
  }

  return text;
}

function splitShortcutPhrases(value) {
  return String(value ?? "")
    .split(/\s*,\s*(?:then\s+)?|\s+then\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseShortcutSequence(value) {
  const shortcuts = [];

  for (const phrase of splitShortcutPhrases(value)) {
    const shortcut = parseShortcutPhrase(phrase);
    if (!shortcut) return null;
    shortcuts.push(shortcut);
  }

  return shortcuts.length ? shortcuts : null;
}

function parseOpenTypeShortcutPlan(raw) {
  const text = String(raw ?? "").trim();
  const match = text.match(/^(?:open|launch|start)\s+(.+?)(?:,|\s+and)\s+type\s+([\s\S]+)$/i);
  if (!match) return null;

  const app = match[1].trim().replace(/^the\s+/i, "");
  const rest = match[2].trim();
  const suffix = rest.match(/^([\s\S]+?)(?:,\s*(?:then\s+)?|\s+then\s+)((?:select all|copy|paste|cut|undo|redo|save|find|press [^,]+|send [^,]+)(?:\s*,\s*(?:then\s+)?(?:select all|copy|paste|cut|undo|redo|save|find|press [^,]+|send [^,]+)|\s+then\s+(?:select all|copy|paste|cut|undo|redo|save|find|press [^,]+|send [^,]+))*)$/i);

  const typeValue = normalizeTypedContent(suffix ? suffix[1] : rest);
  const shortcutValues = suffix ? parseShortcutSequence(suffix[2]) : [];

  if (!app || !typeValue || shortcutValues === null) return null;

  return [
    { action: "open_app", app },
    { action: "type_text", text: typeValue },
    ...shortcutValues.map((shortcut) => ({ action: "keyboard_shortcut", shortcut })),
  ];
}

async function executePlan(raw, steps, options = {}) {
  const key = normalize(raw);
  const expired = cleanContinuations(options.nowMs ?? Date.now());
  const existing = pendingContinuations.get(key);

  if (!existing && options.authorityToken) {
    return {
      ok: false,
      action: "plan",
      message: expired.includes(key) ? "Approval expired." : "Approval could not be resumed.",
      reason: expired.includes(key)
        ? "The pending interaction expired before approval was completed."
        : "The pending interaction is no longer available. Please repeat the command.",
      continuationExpired: expired.includes(key),
      continuationMissing: !expired.includes(key),
    };
  }

  const continuation = existing ?? {
    id: randomUUID(),
    key,
    createdAt: Date.now(),
    nextStep: 0,
    context: {},
    completedActions: [],
  };

  await logEvent({
    taskId: options.taskId,
    route: "plan",
    event: existing ? "resume" : "start",
    continuationId: continuation.id,
    nextStep: continuation.nextStep,
    steps: steps.map((step) => step.action),
  });

  for (let index = continuation.nextStep; index < steps.length; index += 1) {
    const step = steps[index];
    let result;

    await logEvent({
      taskId: options.taskId,
      route: "plan",
      event: "step_start",
      continuationId: continuation.id,
      stepIndex: index,
      action: step.action,
    });

    if (step.action === "open_app") {
      result = await openApp(step.app, options);
      if (result.ok) {
        continuation.context.openResult = result;
        await wait(700);
      }
    } else if (step.action === "type_text") {
      result = await typeText(step.text, {
        ...options,
        ...getFocusOptions(continuation.context),
      });
    } else if (step.action === "keyboard_shortcut") {
      result = await keyboardShortcut(step.shortcut, {
        ...options,
        ...getFocusOptions(continuation.context),
      });
    } else {
      result = {
        ok: false,
        action: step.action,
        message: "Plan cancelled.",
        reason: "Unsupported plan step.",
      };
    }

    if (!result.ok) {
      if (result.needsApproval) {
        continuation.nextStep = index;
        pendingContinuations.set(key, continuation);
        await logEvent({
          taskId: options.taskId,
          route: "plan",
          event: "step_blocked",
          continuationId: continuation.id,
          stepIndex: index,
          action: result.action,
          requiredLevel: result.requiredLevel,
          currentLevel: result.currentLevel,
        });
        return blockedResult(result, continuation);
      }

      pendingContinuations.delete(key);
      await logEvent({
        taskId: options.taskId,
        route: "plan",
        event: "step_failed",
        continuationId: continuation.id,
        stepIndex: index,
        action: result.action ?? step.action,
        reason: result.reason ?? result.error ?? "Unknown failure.",
      });
      return result;
    }

    continuation.completedActions.push(step.action);
    continuation.nextStep = index + 1;
    pendingContinuations.set(key, continuation);
    await logEvent({
      taskId: options.taskId,
      route: "plan",
      event: "step_complete",
      continuationId: continuation.id,
      stepIndex: index,
      action: step.action,
    });
  }

  pendingContinuations.delete(key);
  await logEvent({
    taskId: options.taskId,
    route: "plan",
    event: "complete",
    continuationId: continuation.id,
    completedActions: continuation.completedActions,
  });
  return {
    ok: true,
    action: "plan",
    completedActions: continuation.completedActions,
    message: "Done.",
  };
}

export async function tryFastRoute(raw, options = {}) {
  const text = normalize(raw);

  if (isAwarenessQuery(raw)) {
    return {
      handled: true,
      result: await answerAwarenessQuery(options),
    };
  }

  if (isContextQuery(raw)) {
    return {
      handled: true,
      result: await answerAwarenessContextQuery(options),
    };
  }

  const plan = parseOpenTypeShortcutPlan(raw);
  if (plan) {
    return {
      handled: true,
      result: await executePlan(raw, plan, options),
    };
  }

  const typeMatch = String(raw ?? "").trim().match(/^type\s+([\s\S]+)$/i);
  if (typeMatch) {
    return {
      handled: true,
      result: await typeText(normalizeTypedContent(typeMatch[1]), options),
    };
  }

  const shortcut = parseShortcutPhrase(text);
  if (shortcut) {
    return {
      handled: true,
      result: await keyboardShortcut(shortcut, options),
    };
  }

  const appMatch = text.match(/^(open|launch|start) (.+)$/);
  if (appMatch) {
    const requested = appMatch[2].replace(/^the /, "");
    const result = await openApp(requested, options);

    if (result.ok) {
      return { handled: true, result };
    }

    if (result.disabled || result.needsApproval || result.aliasResolutionFailed) {
      return { handled: true, result };
    }
  }

  const urlMatch = String(raw).match(/https?:\/\/\S+/i);

  if (/^(open|go to|visit) /.test(text) && urlMatch) {
    return {
      handled: true,
      result: await openUrl(urlMatch[0], options),
    };
  }

  return { handled: false };
}
