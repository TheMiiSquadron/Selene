import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const AUTHORITY_PATH = resolve("config", "authority.json");
const MIN_LEVEL = 1;
const MAX_LEVEL = 10;
const DEFAULT_LEVEL = 4;

export const AUTHORITY_LEVELS = [
  { level: 1, name: "Observe" },
  { level: 2, name: "Inspect" },
  { level: 3, name: "Launch" },
  { level: 4, name: "Assist" },
  { level: 5, name: "Interact" },
  { level: 6, name: "Control" },
  { level: 7, name: "Communicate" },
  { level: 8, name: "Install" },
  { level: 9, name: "Administrator" },
  { level: 10, name: "Critical" },
];

export const TOOL_AUTHORITY_REQUIREMENTS = {
  open_app: { level: 3 },
  open_url: { level: 3 },
  open_path: { level: 3 },
  volume: { level: 4 },
  media: { level: 4 },
  focus_window: { level: 4 },
  minimize_window: { level: 4 },
  maximize_window: { level: 4 },
  restore_window: { level: 4 },
  type_text: { level: 5 },
  keyboard_shortcut: { level: 5 },
  close_window: { level: 6 },
  critical_action: { level: 10, alwaysConfirm: true },
};

const DEFAULT_AUTHORITY_CONFIG = {
  defaultLevel: DEFAULT_LEVEL,
  currentLevel: DEFAULT_LEVEL,
  temporaryElevation: null,
  oneActionElevation: null,
  alwaysConfirmActions: [],
  updatedAt: null,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function clampAuthorityLevel(value, fallback = DEFAULT_LEVEL) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, parsed));
}

export function getAuthorityLevelName(level) {
  return AUTHORITY_LEVELS.find((item) => item.level === level)?.name ?? "Unknown";
}

export function validateAuthorityConfig(value) {
  const input = isPlainObject(value) ? value : {};
  const defaultLevel = clampAuthorityLevel(input.defaultLevel, DEFAULT_LEVEL);
  const currentLevel = clampAuthorityLevel(input.currentLevel, defaultLevel);
  const temporaryElevation = validateTemporaryElevation(input.temporaryElevation);
  const oneActionElevation = validateOneActionElevation(input.oneActionElevation);
  const alwaysConfirmActions = Array.isArray(input.alwaysConfirmActions)
    ? input.alwaysConfirmActions.map(String).filter(Boolean)
    : [];

  return {
    defaultLevel,
    currentLevel,
    temporaryElevation,
    oneActionElevation,
    alwaysConfirmActions,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null,
  };
}

function validateTemporaryElevation(value) {
  if (!isPlainObject(value)) return null;
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  return {
    level: clampAuthorityLevel(value.level),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function validateOneActionElevation(value) {
  if (!isPlainObject(value)) return null;
  const token = typeof value.token === "string" ? value.token : "";
  if (!token) return null;
  return {
    level: clampAuthorityLevel(value.level),
    token,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

export async function loadAuthorityConfig() {
  try {
    const parsed = JSON.parse(await readFile(AUTHORITY_PATH, "utf-8"));
    return validateAuthorityConfig(parsed);
  } catch {
    return { ...DEFAULT_AUTHORITY_CONFIG };
  }
}

export async function saveAuthorityConfig(config) {
  const next = validateAuthorityConfig(config);
  next.updatedAt = new Date().toISOString();
  await writeFile(AUTHORITY_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function getEffectiveAuthority(config, { now = new Date(), authorityToken = "" } = {}) {
  const validated = validateAuthorityConfig(config);
  let level = validated.currentLevel;
  let source = "current";

  if (validated.temporaryElevation) {
    const expiresAtMs = Date.parse(validated.temporaryElevation.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime()) {
      if (validated.temporaryElevation.level > level) {
        level = validated.temporaryElevation.level;
        source = "temporary";
      }
    }
  }

  if (
    authorityToken &&
    validated.oneActionElevation &&
    validated.oneActionElevation.token === authorityToken &&
    validated.oneActionElevation.level > level
  ) {
    level = validated.oneActionElevation.level;
    source = "one_action";
  }

  return { level, source };
}

export function cleanupExpiredAuthority(config, now = new Date()) {
  const next = validateAuthorityConfig(config);
  if (
    next.temporaryElevation &&
    Date.parse(next.temporaryElevation.expiresAt) <= now.getTime()
  ) {
    next.temporaryElevation = null;
  }
  return next;
}

export function authorizeAction(action, config, options = {}) {
  const normalizedAction = String(action ?? "");
  const requirement = TOOL_AUTHORITY_REQUIREMENTS[normalizedAction] ?? { level: MAX_LEVEL, alwaysConfirm: true };
  const cleaned = cleanupExpiredAuthority(config, options.now ?? new Date());
  const requiredLevel = clampAuthorityLevel(requirement.level, MAX_LEVEL);
  const effective = getEffectiveAuthority(cleaned, {
    ...options,
    authorityToken: "",
  });

  if (
    options.authorityToken &&
    effective.level < requiredLevel &&
    cleaned.oneActionElevation &&
    cleaned.oneActionElevation.token === options.authorityToken &&
    cleaned.oneActionElevation.level >= requiredLevel
  ) {
    effective.level = cleaned.oneActionElevation.level;
    effective.source = "one_action";
  }

  const alwaysConfirm = Boolean(requirement.alwaysConfirm || cleaned.alwaysConfirmActions.includes(normalizedAction));

  if (alwaysConfirm) {
    return {
      allowed: false,
      needsApproval: true,
      alwaysConfirm: true,
      action: normalizedAction,
      requiredLevel,
      currentLevel: effective.level,
      reason: `This action always requires explicit confirmation, even at Level ${MAX_LEVEL}.`,
    };
  }

  if (effective.level >= requiredLevel) {
    return {
      allowed: true,
      needsApproval: false,
      action: normalizedAction,
      requiredLevel,
      currentLevel: effective.level,
      authoritySource: effective.source,
      reason: "Allowed.",
    };
  }

  return {
    allowed: false,
    needsApproval: true,
    alwaysConfirm: false,
    action: normalizedAction,
    requiredLevel,
    currentLevel: effective.level,
    reason: `This action requires Level ${requiredLevel} - ${getAuthorityLevelName(requiredLevel)}.`,
  };
}

export async function authorizeToolAction(action, options = {}) {
  const loaded = await loadAuthorityConfig();
  let config = cleanupExpiredAuthority(loaded);
  const cleanedWasChanged = JSON.stringify(config) !== JSON.stringify(loaded);
  if (cleanedWasChanged) {
    config = await saveAuthorityConfig(config);
  }

  const decision = authorizeAction(action, config, options);
  if (decision.allowed && decision.authoritySource === "one_action" && options.consumeOneAction !== false) {
    config.oneActionElevation = null;
    await saveAuthorityConfig(config);
  }
  return decision;
}

export async function getAuthorityState() {
  let config = cleanupExpiredAuthority(await loadAuthorityConfig());
  config = await saveAuthorityConfig(config);
  const effective = getEffectiveAuthority(config);
  return {
    ok: true,
    levels: AUTHORITY_LEVELS,
    toolRequirements: TOOL_AUTHORITY_REQUIREMENTS,
    defaultLevel: config.defaultLevel,
    currentLevel: config.currentLevel,
    effectiveLevel: effective.level,
    temporaryElevation: config.temporaryElevation,
    oneActionElevation: config.oneActionElevation
      ? {
          level: config.oneActionElevation.level,
          createdAt: config.oneActionElevation.createdAt,
          available: true,
        }
      : null,
    alwaysConfirmActions: config.alwaysConfirmActions,
  };
}

export async function setDefaultAuthority(level) {
  const config = await loadAuthorityConfig();
  const defaultLevel = clampAuthorityLevel(level);
  return saveAuthorityConfig({
    ...config,
    defaultLevel,
    currentLevel: defaultLevel,
    temporaryElevation: null,
    oneActionElevation: null,
  });
}

export async function elevateAuthority({ level, minutes, oneAction = false } = {}) {
  const config = cleanupExpiredAuthority(await loadAuthorityConfig());
  const elevatedLevel = clampAuthorityLevel(level, config.defaultLevel);

  if (oneAction) {
    const token = randomUUID();
    return saveAuthorityConfig({
      ...config,
      oneActionElevation: {
        level: elevatedLevel,
        token,
        createdAt: new Date().toISOString(),
      },
    });
  }

  const durationMinutes = Number(minutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 240) {
    throw new Error("Temporary elevation requires minutes between 1 and 240.");
  }

  return saveAuthorityConfig({
    ...config,
    temporaryElevation: {
      level: elevatedLevel,
      expiresAt: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
    },
  });
}

export async function resetAuthority() {
  const config = await loadAuthorityConfig();
  return saveAuthorityConfig({
    ...config,
    currentLevel: config.defaultLevel,
    temporaryElevation: null,
    oneActionElevation: null,
  });
}

export function formatAuthorizationMessage(decision) {
  return decision.alwaysConfirm ? "Explicit confirmation required." : "Approval required.";
}

export function authorizationFailurePayload(decision) {
  return {
    ok: false,
    needsApproval: true,
    requiredLevel: decision.requiredLevel,
    currentLevel: decision.currentLevel,
    action: decision.action,
    message: formatAuthorizationMessage(decision),
    reason: decision.reason,
    alwaysConfirm: Boolean(decision.alwaysConfirm),
  };
}
