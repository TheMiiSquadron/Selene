import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const APPS_PATH = resolve("config", "apps.json");
const APP_PERMISSIONS_PATH = resolve("config", "applicationPermissions.json");
const SUPPORTED_LAUNCH_TYPES = new Set(["exe", "shortcut", "uri"]);

export const BUILTIN_APPS = {
  notepad: {
    id: "notepad",
    name: "Notepad",
    aliases: ["notepad"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Windows\\System32\\notepad.exe",
    },
  },
  calculator: {
    id: "calculator",
    name: "Calculator",
    aliases: ["calculator", "calc"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Windows\\System32\\calc.exe",
    },
  },
  "file explorer": {
    id: "file explorer",
    name: "File Explorer",
    aliases: ["file explorer", "explorer", "windows explorer"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Windows\\explorer.exe",
    },
  },
  settings: {
    id: "settings",
    name: "Settings",
    aliases: ["settings", "windows settings"],
    source: "builtin",
    launch: {
      type: "uri",
      target: "ms-settings:",
    },
  },
  paint: {
    id: "paint",
    name: "Paint",
    aliases: ["paint", "mspaint"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Users\\alexm\\AppData\\Local\\Microsoft\\WindowsApps\\mspaint.exe",
    },
  },
  "snipping tool": {
    id: "snipping tool",
    name: "Snipping Tool",
    aliases: ["snipping tool", "snip", "screen snip"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Users\\alexm\\AppData\\Local\\Microsoft\\WindowsApps\\SnippingTool.exe",
    },
  },
  firefox: {
    id: "firefox",
    name: "Firefox",
    aliases: ["firefox", "mozilla firefox"],
    source: "builtin",
    launch: {
      type: "exe",
      target: "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
    },
  },
};

export function normalizeAppName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function titleCase(value) {
  return normalizeAppName(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizeAliasList(id, aliases = []) {
  const seen = new Set();
  const result = [];

  for (const alias of [id, ...aliases]) {
    const normalized = normalizeAppName(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function legacyLaunchType(type) {
  const normalized = String(type ?? "").trim().toLowerCase();
  if (normalized === "path" || normalized === "command") return "exe";
  if (normalized === "uri") return "uri";
  if (normalized === "shortcut") return "shortcut";
  return normalized;
}

export function normalizeAppEntry(id, entry) {
  const canonicalId = normalizeAppName(entry?.id ?? id);
  if (!canonicalId || !entry || typeof entry !== "object") return null;

  const launch = entry.launch && typeof entry.launch === "object"
    ? entry.launch
    : {
        type: legacyLaunchType(entry.type),
        target: entry.target,
        args: entry.args,
      };

  const launchType = String(launch?.type ?? "").trim().toLowerCase();
  const target = String(launch?.target ?? "").trim();

  if (!SUPPORTED_LAUNCH_TYPES.has(launchType) || !target) return null;

  return {
    id: canonicalId,
    name: String(entry.name ?? titleCase(canonicalId)),
    aliases: normalizeAliasList(canonicalId, entry.aliases),
    source: String(entry.source ?? "manual"),
    launch: {
      type: launchType,
      target,
      ...(Array.isArray(launch.args) && launch.args.length
        ? { args: launch.args.map(String) }
        : {}),
    },
  };
}

export function mergeAppRegistries(...registries) {
  const merged = {};

  for (const registry of registries) {
    for (const [id, rawEntry] of Object.entries(registry ?? {})) {
      if (id === "_comment") continue;
      const entry = normalizeAppEntry(id, rawEntry);
      if (!entry) continue;

      const existing = merged[entry.id];
      if (!existing) {
        merged[entry.id] = entry;
        continue;
      }

      merged[entry.id] = {
        ...existing,
        ...entry,
        aliases: normalizeAliasList(entry.id, [...existing.aliases, ...entry.aliases]),
      };
    }
  }

  return merged;
}

export async function isLaunchAvailable(entry) {
  const app = normalizeAppEntry(entry?.id, entry);
  if (!app) return false;

  if (["exe", "shortcut"].includes(app.launch.type)) {
    try {
      await access(app.launch.target, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

export async function loadApps() {
  const parsed = JSON.parse(await readFile(APPS_PATH, "utf-8"));
  return mergeAppRegistries(parsed, BUILTIN_APPS);
}

export async function loadApplicationPermissions() {
  try {
    const parsed = JSON.parse(await readFile(APP_PERMISSIONS_PATH, "utf-8"));
    return sanitizePermissionMap(parsed?.applications);
  } catch {
    return {};
  }
}

export async function saveApplicationPermissions(permissions) {
  const body = {
    _comment: "Launch permissions saved by Selene Setup. Discovery paths and aliases stay in config/apps.json.",
    applications: sanitizePermissionMap(permissions),
  };

  await writeFile(APP_PERMISSIONS_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
  return body.applications;
}

export function sanitizePermissionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const permissions = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      permissions[normalizeAppName(name)] = enabled;
    }
  }
  return permissions;
}

export function isApplicationEnabled(canonicalName, permissions) {
  const normalized = normalizeAppName(canonicalName);
  return permissions[normalized] !== false;
}

export async function listApplicationsForSetup(apps, permissions = {}) {
  const entries = await Promise.all(Object.entries(apps).map(async ([canonicalName, entry]) => {
    const normalized = normalizeAppEntry(canonicalName, entry);
    const enabled = isApplicationEnabled(canonicalName, permissions);

    return {
      id: canonicalName,
      canonicalName,
      name: normalized?.name ?? canonicalName,
      aliases: normalized?.aliases ?? [],
      enabled,
      allowed: enabled,
      type: normalized?.launch?.type ?? "unknown",
      source: normalized?.source ?? "unknown",
      launchType: normalized?.launch?.type ?? "unknown",
      available: normalized ? await isLaunchAvailable(normalized) : false,
    };
  }));

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listApplicationsForDiagnostics(apps, permissions = {}) {
  const entries = await Promise.all(Object.entries(apps).map(async ([canonicalName, entry]) => {
    const normalized = normalizeAppEntry(canonicalName, entry);
    const enabled = isApplicationEnabled(canonicalName, permissions);

    return {
      id: canonicalName,
      name: normalized?.name ?? canonicalName,
      aliases: normalized?.aliases ?? [],
      source: normalized?.source ?? "unknown",
      launchType: normalized?.launch?.type ?? "unknown",
      launchTarget: normalized?.launch?.target ?? "",
      permissionEnabled: enabled,
      available: normalized ? await isLaunchAvailable(normalized) : false,
    };
  }));

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function applyApplicationPermissionPatch(apps, currentPermissions, patch) {
  const next = { ...sanitizePermissionMap(currentPermissions) };
  const sanitizedPatch = sanitizePermissionMap(patch);
  const unknown = [];

  for (const [requestedName, enabled] of Object.entries(sanitizedPatch)) {
    const resolved = resolveApprovedApp(apps, requestedName);
    if (!resolved) {
      unknown.push(requestedName);
      continue;
    }
    next[resolved.canonicalName] = enabled;
  }

  return { permissions: next, unknown };
}

export function resolveApprovedApp(apps, requestedName) {
  const requested = normalizeAppName(requestedName);

  for (const [canonicalName, entry] of Object.entries(apps)) {
    const normalized = normalizeAppEntry(canonicalName, entry);
    if (!normalized) continue;

    if (normalizeAppName(canonicalName) === requested || normalized.id === requested) {
      return { canonicalName, entry: normalized };
    }

    if (normalized.aliases.some((alias) => normalizeAppName(alias) === requested)) {
      return { canonicalName, entry: normalized };
    }
  }

  return null;
}
