import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_ROLES,
  ModelProfileError,
  normalizeModelRole,
  resolveModelProfile,
  validateModelProfiles,
} from "./modelProfiles.js";

const profiles = validateModelProfiles({
  roles: {
    fast: {
      model: "fast-model",
      settings: {
        temperature: 0.2,
      },
    },
    primary: {
      model: "primary-model",
    },
    specialized: {
      fallbackToDefault: true,
    },
  },
});

test("supported model roles are explicit and stable", () => {
  assert.deepEqual(MODEL_ROLES, ["fast", "primary", "specialized"]);
});

test("model role normalization accepts supported roles", () => {
  assert.equal(normalizeModelRole(" Primary "), "primary");
  assert.equal(normalizeModelRole(""), "");
});

test("unknown model role fails closed", () => {
  assert.throws(
    () => normalizeModelRole("deep"),
    ModelProfileError,
  );
});

test("role resolves to configured model identifier and settings", () => {
  const resolved = resolveModelProfile({
    role: "fast",
    profiles,
    env: {},
    fallbackModel: "fallback-model",
  });

  assert.equal(resolved.model, "fast-model");
  assert.equal(resolved.role, "fast");
  assert.equal(resolved.source, "config");
  assert.deepEqual(resolved.settings, { temperature: 0.2 });
});

test("role-specific environment override wins over configured model", () => {
  const resolved = resolveModelProfile({
    role: "primary",
    profiles,
    env: {
      SELENE_MODEL_PRIMARY: "env-primary-model",
    },
  });

  assert.equal(resolved.model, "env-primary-model");
  assert.equal(resolved.source, "env:SELENE_MODEL_PRIMARY");
});

test("unset role can fall back to LM_STUDIO_MODEL compatibility value", () => {
  const resolved = resolveModelProfile({
    role: "specialized",
    profiles,
    env: {
      LM_STUDIO_MODEL: "legacy-env-model",
    },
    fallbackModel: "first-loaded-model",
  });

  assert.equal(resolved.model, "legacy-env-model");
  assert.equal(resolved.source, "fallback");
});

test("no explicit role preserves default single-model fallback behavior", () => {
  const resolved = resolveModelProfile({
    profiles,
    env: {},
    fallbackModel: "first-loaded-model",
  });

  assert.equal(resolved.role, "default");
  assert.equal(resolved.model, "first-loaded-model");
  assert.equal(resolved.source, "fallback");
});

test("explicit model preserves current caller-selected model compatibility", () => {
  const resolved = resolveModelProfile({
    role: "primary",
    explicitModel: "caller-model",
    profiles,
    env: {
      SELENE_MODEL_PRIMARY: "env-primary-model",
    },
  });

  assert.equal(resolved.role, "primary");
  assert.equal(resolved.model, "caller-model");
  assert.equal(resolved.source, "explicit");
});

test("unset role without fallback fails clearly", () => {
  assert.throws(
    () => resolveModelProfile({
      role: "specialized",
      profiles: validateModelProfiles({
        roles: {
          specialized: {},
        },
      }),
      env: {},
    }),
    ModelProfileError,
  );
});
