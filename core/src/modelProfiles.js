import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MODEL_ROLES = Object.freeze(["fast", "primary", "specialized"]);
export const DEFAULT_MODEL_PROFILE_PATH = resolve("config", "modelProfiles.json");

export class ModelProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelProfileError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeModelRole(role) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (!normalized) return "";

  if (!MODEL_ROLES.includes(normalized)) {
    throw new ModelProfileError(`Unknown model role: ${normalized}.`);
  }

  return normalized;
}

export function validateModelProfiles(value) {
  const source = isPlainObject(value) ? value : {};
  const sourceRoles = isPlainObject(source.roles) ? source.roles : {};
  const roles = {};

  for (const role of MODEL_ROLES) {
    const profile = isPlainObject(sourceRoles[role]) ? sourceRoles[role] : {};
    const residency = isPlainObject(profile.residency) ? profile.residency : {};
    roles[role] = {
      model: String(profile.model ?? "").trim(),
      apiId: String(profile.apiId ?? "").trim(),
      fallbackToDefault: Boolean(profile.fallbackToDefault),
      residency: {
        modelKey: String(residency.modelKey ?? profile.model ?? "").trim(),
        apiId: String(residency.apiId ?? profile.apiId ?? profile.model ?? "").trim(),
        gpu: String(residency.gpu ?? "").trim(),
        contextLength: Number.isInteger(residency.contextLength)
          ? residency.contextLength
          : null,
        loadTimeoutMs: Number.isInteger(residency.loadTimeoutMs)
          ? residency.loadTimeoutMs
          : null,
        pollIntervalMs: Number.isInteger(residency.pollIntervalMs)
          ? residency.pollIntervalMs
          : null,
      },
      settings: isPlainObject(profile.settings) ? { ...profile.settings } : {},
    };
  }

  return { roles };
}

export async function loadModelProfiles({
  profilePath = DEFAULT_MODEL_PROFILE_PATH,
} = {}) {
  const parsed = JSON.parse(await readFile(profilePath, "utf-8"));
  return validateModelProfiles(parsed);
}

function modelOverrideForRole(role, env) {
  if (!role) return "";
  return String(env[`SELENE_MODEL_${role.toUpperCase()}`] ?? "").trim();
}

export function resolveModelProfile({
  role = "",
  explicitModel = "",
  profiles,
  env = process.env,
  fallbackModel = "",
  allowRoleFallback = true,
} = {}) {
  const normalizedRole = normalizeModelRole(role);
  const directModel = String(explicitModel ?? "").trim();

  if (directModel) {
    return {
      role: normalizedRole || "default",
      model: directModel,
      apiId: directModel,
      residency: {
        modelKey: directModel,
        apiId: directModel,
        gpu: "",
        contextLength: null,
        loadTimeoutMs: null,
        pollIntervalMs: null,
      },
      settings: {},
      source: "explicit",
    };
  }

  const envFallback = String(env.LM_STUDIO_MODEL ?? "").trim();
  const defaultModel = envFallback || String(fallbackModel ?? "").trim();

  if (!normalizedRole) {
    return {
      role: "default",
      model: defaultModel,
      apiId: defaultModel,
      residency: {
        modelKey: defaultModel,
        apiId: defaultModel,
        gpu: "",
        contextLength: null,
        loadTimeoutMs: null,
        pollIntervalMs: null,
      },
      settings: {},
      source: envFallback ? "env:LM_STUDIO_MODEL" : "fallback",
    };
  }

  const config = validateModelProfiles(profiles);
  const profile = config.roles[normalizedRole];
  const envOverride = modelOverrideForRole(normalizedRole, env);
  const configuredModel = String(profile.model ?? "").trim();
  const model = envOverride || configuredModel ||
    (allowRoleFallback && profile.fallbackToDefault ? defaultModel : "");

  if (!model) {
    throw new ModelProfileError(`Model role "${normalizedRole}" does not resolve to a model.`);
  }

  return {
    role: normalizedRole,
    model,
    apiId: profile.apiId || model,
    residency: { ...profile.residency },
    settings: { ...profile.settings },
    source: envOverride
      ? `env:SELENE_MODEL_${normalizedRole.toUpperCase()}`
      : configuredModel
        ? "config"
        : "fallback",
  };
}
