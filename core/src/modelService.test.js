import test from "node:test";
import assert from "node:assert/strict";
import { createModelService } from "./modelService.js";

const profiles = {
  roles: {
    fast: {
      model: "fast-model",
      settings: {
        temperature: 0.2,
        maxTokens: 64,
      },
    },
    primary: {
      model: "primary-model",
      settings: {},
    },
    specialized: {
      model: "",
      fallbackToDefault: true,
      settings: {},
    },
  },
};

test("model service resolves a role and delegates to LM Studio client", async () => {
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        throw new Error("fallback should not be needed");
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  const result = await service.createChatCompletion({
    role: "fast",
    messages: [{ role: "user", content: "Hi" }],
    tools: [{ type: "function" }],
  });

  assert.equal(result.choices[0].message.content, "ok");
  assert.equal(result.seleneModel.role, "fast");
  assert.equal(result.seleneModel.model, "fast-model");
  assert.equal(result.seleneModel.source, "config");
  assert.equal(typeof result.seleneModel.resolveMs, "number");
  assert.equal(typeof result.seleneModel.lmStudioMs, "number");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "fast-model");
  assert.equal(calls[0].temperature, 0.2);
  assert.equal(calls[0].maxTokens, 64);
  assert.deepEqual(calls[0].tools, [{ type: "function" }]);
});

test("model service forwards fixed request settings without changing model resolution", async () => {
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        throw new Error("fallback should not be needed");
      },
      async getModelStatus() {
        return {
          reachable: true,
          model: "fast-model",
          models: ["fast-model"],
        };
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  await service.createChatCompletion({
    role: "fast",
    messages: [{ role: "user", content: "Hi" }],
    toolChoice: "none",
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 1200,
    seed: 42,
    requireAvailableModel: true,
    allowRoleFallback: false,
  });

  assert.equal(calls[0].model, "fast-model");
  assert.equal(calls[0].toolChoice, "none");
  assert.equal(calls[0].temperature, 0.2);
  assert.equal(calls[0].topP, 0.9);
  assert.equal(calls[0].maxTokens, 1200);
  assert.equal(calls[0].seed, 42);
});

test("model service strict fast role verifies exact configured model availability", async () => {
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async getModelStatus() {
        return {
          reachable: true,
          model: "fast-model",
          models: ["fast-model", "primary-model"],
        };
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  await service.createChatCompletion({
    role: "fast",
    messages: [{ role: "user", content: "Hi" }],
    requireAvailableModel: true,
    allowRoleFallback: false,
  });

  assert.equal(calls[0].model, "fast-model");
});

test("model service strict primary role verifies exact configured model availability", async () => {
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async getModelStatus() {
        return {
          reachable: true,
          model: "primary-model",
          models: ["fast-model", "primary-model"],
        };
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  await service.createChatCompletion({
    role: "primary",
    messages: [{ role: "user", content: "Hi" }],
    requireAvailableModel: true,
    allowRoleFallback: false,
  });

  assert.equal(calls[0].model, "primary-model");
});

test("model service default path uses current single-model discovery", async () => {
  let profileReads = 0;
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => {
      profileReads += 1;
      throw new Error("default path should not need profiles");
    },
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  await service.createChatCompletion({
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.equal(profileReads, 0);
  assert.equal(calls[0].model, "current-single-model");
});

test("model service explicit model bypasses role config for compatibility", async () => {
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => {
      throw new Error("explicit model should not need profiles");
    },
    lmStudio: {
      async getModelId() {
        throw new Error("fallback should not be needed");
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  await service.createChatCompletion({
    role: "primary",
    model: "caller-selected-model",
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.equal(calls[0].model, "caller-selected-model");
});

test("model service falls back safely for unset specialized role", async () => {
  const calls = [];
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async createChatCompletion(args) {
        calls.push(args);
        return { choices: [{ message: { content: "ok" } }] };
      },
    },
  });

  await service.createChatCompletion({
    role: "specialized",
    messages: [{ role: "user", content: "Hi" }],
  });

  assert.equal(calls[0].model, "current-single-model");
});

test("model service strict specialized role fails when unset", async () => {
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async getModelStatus() {
        return {
          reachable: true,
          model: "current-single-model",
          models: ["current-single-model"],
        };
      },
      async createChatCompletion() {
        throw new Error("should not call LM Studio");
      },
    },
  });

  await assert.rejects(
    () => service.createChatCompletion({
      role: "specialized",
      messages: [{ role: "user", content: "Hi" }],
      requireAvailableModel: true,
      allowRoleFallback: false,
    }),
    /does not resolve to a model/,
  );
});

test("model service strict role fails when configured model is unavailable", async () => {
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async getModelStatus() {
        return {
          reachable: true,
          model: "primary-model",
          models: ["primary-model"],
        };
      },
      async createChatCompletion() {
        throw new Error("should not call LM Studio");
      },
    },
  });

  await assert.rejects(
    () => service.createChatCompletion({
      role: "fast",
      messages: [{ role: "user", content: "Hi" }],
      requireAvailableModel: true,
      allowRoleFallback: false,
    }),
    /not available in LM Studio: fast-model/,
  );
});

test("model service strict role does not silently substitute current loaded model", async () => {
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "primary-model";
      },
      async getModelStatus() {
        return {
          reachable: true,
          model: "primary-model",
          models: ["primary-model"],
        };
      },
      async createChatCompletion() {
        throw new Error("should not call LM Studio");
      },
    },
  });

  await assert.rejects(
    () => service.createChatCompletion({
      role: "fast",
      messages: [{ role: "user", content: "Hi" }],
      requireAvailableModel: true,
      allowRoleFallback: false,
    }),
    /fast-model/,
  );
});

test("model service rejects unknown roles", async () => {
  const service = createModelService({
    loadProfiles: async () => profiles,
    lmStudio: {
      async getModelId() {
        return "current-single-model";
      },
      async createChatCompletion() {
        throw new Error("should not call LM Studio");
      },
    },
  });

  await assert.rejects(
    () => service.createChatCompletion({
      role: "deep",
      messages: [{ role: "user", content: "Hi" }],
    }),
    /Unknown model role/,
  );
});
