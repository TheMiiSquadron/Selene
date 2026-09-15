import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  loadApps,
  loadApplicationPermissions,
  isApplicationEnabled,
  normalizeAppName,
  resolveApprovedApp,
} from "./apps.js";
import {
  authorizationFailurePayload,
  authorizeToolAction,
} from "./authority.js";
import { keyboardShortcut, typeText } from "./interact.js";
import { readMemory } from "./memory.js";
import { listShortcutIds } from "./shortcuts.js";

function spawnDetached(command, args = [], options = {}) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: Boolean(options.windowsHide),
    });

    child.unref();
    return { ok: true, processId: child.pid };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

export function buildLaunchCommand(entry) {
  if (entry.launch.type === "exe") {
    return {
      command: entry.launch.target,
      args: entry.launch.args ?? [],
      windowsHide: false,
    };
  }

  if (entry.launch.type === "shortcut" || entry.launch.type === "uri") {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", "start", "", entry.launch.target],
      windowsHide: true,
    };
  }

  return null;
}

export function appLaunchFailure(appId, name, reason) {
  return {
    ok: false,
    action: "open_app",
    appId,
    message: `Failed to open ${name}.`,
    reason,
  };
}

export async function resolveRememberedAppAlias(requestedName, memoryService = { readMemory }) {
  const requested = normalizeAppName(requestedName);
  if (!requested) return null;

  const aliases = await memoryService.readMemory("appAliases");
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return null;

  for (const [key, value] of Object.entries(aliases)) {
    if (normalizeAppName(key) !== requested) continue;

    const target = normalizeAppName(value);
    if (!target) return null;

    return {
      key: normalizeAppName(key),
      target,
      rawTarget: String(value).trim(),
    };
  }

  return null;
}

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "open_app",
      description:
        "Open an approved application from Selene Core's registry. Common aliases such as vscode, vs code, chrome, opera, bambu, and fl are accepted if configured.",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description:
              "Friendly app name or alias, e.g. visual studio code, vscode, chrome, steam, discord, audacity.",
          },
        },
        required: ["app"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a safe http or https URL in the default browser.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Request typing literal user-approved text into the current foreground application. Authority Manager decides whether this Level 5 action may execute. Do not use for shell commands or secrets.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Literal text from the user's request to type into the foreground app.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "keyboard_shortcut",
      description:
        `Request one allowlisted keyboard shortcut. Authority Manager decides whether this Level 5 action may execute. Allowed shortcuts: ${listShortcutIds().join(", ")}. Do not invent shortcuts.`,
      parameters: {
        type: "object",
        properties: {
          shortcut: {
            type: "string",
            enum: listShortcutIds(),
          },
        },
        required: ["shortcut"],
        additionalProperties: false,
      },
    },
  },
];

export async function openApp(name, options = {}) {
  const authority = await authorizeToolAction("open_app", {
    authorityToken: options.authorityToken,
  });

  if (!authority.allowed) {
    return authorizationFailurePayload(authority);
  }

  const apps = options.apps ?? await loadApps();
  const requested = normalizeAppName(name);
  const rememberedAlias = await resolveRememberedAppAlias(
    requested,
    options.memoryService ?? { readMemory },
  );
  const resolutionName = rememberedAlias?.target ?? requested;
  const resolved = resolveApprovedApp(apps, resolutionName);

  if (!resolved) {
    if (rememberedAlias) {
      return {
        ok: false,
        action: "open_app",
        appId: requested,
        memoryAlias: {
          key: rememberedAlias.key,
          target: rememberedAlias.rawTarget,
        },
        aliasResolutionFailed: true,
        message: `Application alias "${rememberedAlias.key}" points to "${rememberedAlias.rawTarget}", but that is not approved for Selene.`,
        reason: "Remembered app aliases must resolve through the approved application registry.",
      };
    }

    return {
      ok: false,
      error: `Application "${requested}" is not approved.`,
      approvedApps: Object.keys(apps),
    };
  }

  const { canonicalName, entry } = resolved;
  const permissions = options.permissions ?? await loadApplicationPermissions();

  if (!isApplicationEnabled(canonicalName, permissions)) {
    return {
      ok: false,
      disabled: true,
      error: `Application "${canonicalName}" is not enabled for Selene.`,
    };
  }

  if (["exe", "shortcut"].includes(entry.launch.type) && !existsSync(entry.launch.target)) {
    return appLaunchFailure(
      canonicalName,
      entry.name,
      "Configured launch target is unavailable.",
    );
  }

  const launchCommand = buildLaunchCommand(entry);
  if (!launchCommand) {
    return appLaunchFailure(canonicalName, entry.name, "Unsupported launch type.");
  }

  const launcher = options.launcher ?? spawnDetached;
  const launched = launcher(launchCommand.command, launchCommand.args, {
    windowsHide: launchCommand.windowsHide,
  });
  if (!launched.ok) {
    return appLaunchFailure(
      canonicalName,
      entry.name,
      launched.reason || "Configured launch target could not be started.",
    );
  }

  return {
    ok: true,
    action: "open_app",
    appId: canonicalName,
    appName: entry.name,
    windowTitle: entry.name,
    processId: launched.processId,
    message: `Opened ${entry.name}.`,
  };
}

export async function openUrl(value, options = {}) {
  const authority = await authorizeToolAction("open_url", {
    authorityToken: options.authorityToken,
  });

  if (!authority.allowed) {
    return authorizationFailurePayload(authority);
  }

  let url;

  try {
    url = new URL(String(value).trim());
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, error: "Only http/https URLs are allowed." };
  }

  spawnDetached("cmd.exe", ["/c", "start", "", url.href]);
  return { ok: true, message: `Opened ${url.href}.` };
}

export async function executeTool(name, args, options = {}) {
  if (name === "open_app") return openApp(args?.app, options);
  if (name === "open_url") return openUrl(args?.url, options);
  if (name === "type_text") return typeText(args?.text, options);
  if (name === "keyboard_shortcut") return keyboardShortcut(args?.shortcut, options);

  throw new Error(`Unknown tool: ${name}`);
}
