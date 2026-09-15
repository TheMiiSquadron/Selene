import test from "node:test";
import assert from "node:assert/strict";
import {
  BENCHMARK_SYSTEM_PROMPT,
  getFastRouteLogOutput,
  formatTimingSummary,
  runModelTurn,
  runModelRoleTest,
  runNovaCommand,
} from "./commandPipeline.js";

test("raw awareness window title is not returned as normal log output", () => {
  assert.equal(getFastRouteLogOutput({
    action: "awareness_query",
    message: "You're currently in Visual Studio Code - router.js - Selene Core - Visual Studio Code.",
  }), "awareness_query_answered");
});

test("raw interpreted context is not returned as normal log output", () => {
  assert.equal(getFastRouteLogOutput({
    action: "awareness_context_query",
    message: "It looks like you're working in Visual Studio Code on Selene Core, with router.js open.",
  }), "awareness_context_query_answered");
});

test("non-awareness fast-route output is preserved for normal logging", () => {
  assert.equal(getFastRouteLogOutput({
    action: "open_app",
    message: "Opened Firefox.",
  }), "Opened Firefox.");
});

test("timing summary formats model observability for humans", () => {
  assert.equal(formatTimingSummary({
    taskId: "1842",
    role: "default",
    model: "zai-org/glm-4.7-flash",
    lmStudioMs: 6200,
    toolCallCount: 0,
    totalMs: 6400,
  }), "Request: 1842 | Role: default | Model: zai-org/glm-4.7-flash | LM Studio latency: 6.2s | Tool calls: 0 | Total Core latency: 6.4s");
});

test("runModelTurn uses model service and preserves plain response shape", async () => {
  const calls = [];
  const response = await runModelTurn("caller-model", "Hello", {
    modelRole: "primary",
    modelService: {
      async createChatCompletion(args) {
        calls.push(args);
        return {
          choices: [
            {
              message: {
                content: " Hello back. ",
              },
            },
          ],
          seleneModel: {
            role: "primary",
            model: "resolved-primary-model",
            source: "config",
            resolveMs: 2,
            lmStudioMs: 12,
          },
        };
      },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.text, "Hello back.");
  assert.equal(response.toolMs, 0);
  assert.equal(response.modelRole, "primary");
  assert.equal(response.model, "resolved-primary-model");
  assert.equal(response.modelSource, "config");
  assert.equal(response.modelResolveMs, 2);
  assert.equal(response.lmStudioMs, 12);
  assert.equal(response.toolCallCount, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "primary");
  assert.equal(calls[0].model, "caller-model");
});

test("runModelTurn preserves tool-call execution behavior through model service", async () => {
  const result = await runModelTurn("caller-model", "Open unknown", {
    modelService: {
      async createChatCompletion() {
        return {
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "missing_tool",
                      arguments: "{}",
                    },
                  },
                ],
              },
            },
          ],
        };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /Unknown tool/);
});

test("runNovaCommand deterministic fast route avoids model service", async () => {
  const response = await runNovaCommand("What app am I in?", {
    logTiming: false,
    modelService: {
      async createChatCompletion() {
        throw new Error("model service should not be called");
      },
    },
  });

  assert.equal(response.route, "fast");
  assert.equal(response.action, "awareness_query");
  assert.equal(response.ok, true);
});

test("runNovaCommand keeps single-model compatibility when model fallback is needed", async () => {
  const calls = [];
  const response = await runNovaCommand("Tell me something", {
    model: "legacy-single-model",
    logTiming: false,
    modelService: {
      async createChatCompletion(args) {
        calls.push(args);
        return {
          choices: [
            {
              message: {
                content: "A small useful thing.",
              },
            },
          ],
          seleneModel: {
            role: "default",
            model: "legacy-single-model",
            source: "explicit",
            resolveMs: 1,
            lmStudioMs: 20,
          },
        };
      },
    },
  });

  assert.equal(response.route, "model");
  assert.equal(response.message, "A small useful thing.");
  assert.equal(response.role, "default");
  assert.equal(response.model, "legacy-single-model");
  assert.equal(response.modelSource, "explicit");
  assert.equal(response.modelResolveMs, 1);
  assert.equal(response.lmStudioMs, 20);
  assert.equal(response.toolCallCount, 0);
  assert.match(response.timingSummary, /LM Studio latency: 0\.0s/);
  assert.equal(calls[0].model, "legacy-single-model");
  assert.equal(calls[0].role, undefined);
});

test("runModelRoleTest uses explicit role with no tools and returns diagnostics", async () => {
  const calls = [];
  const response = await runModelRoleTest("Hello", "fast", {
    logTiming: false,
    modelManager: null,
    modelService: {
      async createChatCompletion(args) {
        calls.push(args);
        return {
          choices: [
            {
              message: {
                content: "Fast hello.",
              },
            },
          ],
          seleneModel: {
            role: "fast",
            model: "fast-model",
            source: "config",
            resolveMs: 3,
            lmStudioMs: 40,
          },
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "fast");
  assert.equal(calls[0].toolChoice, "none");
  assert.equal(calls[0].requireAvailableModel, true);
  assert.equal(calls[0].allowRoleFallback, false);
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].temperature, undefined);
  assert.equal(calls[0].topP, undefined);
  assert.equal(calls[0].maxTokens, undefined);
  assert.equal(calls[0].seed, undefined);
  assert.equal(response.route, "debug-model-test");
  assert.equal(response.role, "fast");
  assert.equal(response.model, "fast-model");
  assert.equal(response.modelSource, "config");
  assert.equal(response.modelResolveMs, 3);
  assert.equal(response.lmStudioMs, 40);
  assert.equal(response.toolCallCount, 0);
  assert.equal(response.toolMs, 0);
  assert.equal(response.debug.benchmarkEquivalent, false);
  assert.equal(response.debug.systemPrompt, "selene-core");
});

test("runModelRoleTest benchmarkEquivalent applies tournament request settings", async () => {
  const calls = [];
  const response = await runModelRoleTest("Hello", "fast", {
    benchmarkEquivalent: true,
    logTiming: false,
    modelManager: null,
    modelService: {
      async createChatCompletion(args) {
        calls.push(args);
        return {
          choices: [
            {
              message: {
                content: "Benchmark hello.",
              },
            },
          ],
          seleneModel: {
            role: "fast",
            model: "fast-model",
            source: "config",
            resolveMs: 3,
            lmStudioMs: 40,
          },
        };
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "fast");
  assert.equal(calls[0].toolChoice, "none");
  assert.equal(calls[0].requireAvailableModel, true);
  assert.equal(calls[0].allowRoleFallback, false);
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].temperature, 0.2);
  assert.equal(calls[0].topP, 0.9);
  assert.equal(calls[0].maxTokens, 1200);
  assert.equal(calls[0].seed, 42);
  assert.equal(calls[0].messages[0].content, BENCHMARK_SYSTEM_PROMPT);
  assert.equal(response.debug.benchmarkEquivalent, true);
  assert.equal(response.debug.systemPrompt, "benchmark");
  assert.deepEqual(response.debug.generationSettings, {
    temperature: 0.2,
    topP: 0.9,
    maxTokens: 1200,
    seed: 42,
    stream: false,
    tools: false,
    toolChoice: "none",
  });
});

test("runModelRoleTest uses managed profile apiId and returns residency diagnostics", async () => {
  const calls = [];
  const response = await runModelRoleTest("Hello", "primary", {
    logTiming: false,
    modelManager: {
      async runWithRoleReady(role, fn) {
        const result = await fn({
          profile: {
            role,
            modelKey: "meta/muse-glimmer",
            apiId: "selene-muse-glimmer-30b",
          },
        });

        return {
          result,
          residency: {
            requestedRole: "primary",
            residentRoleBefore: "fast",
            residentIdentifierBefore: "selene-gemma4-26b-a4b",
            residentRoleAfter: "fast",
            residentIdentifierAfter: "selene-gemma4-26b-a4b",
            modelAlreadyLoaded: false,
            modelLoadMs: 8000,
            modelUnloadMs: 1000,
            modelSwitchMs: 9000,
            queueWaitMs: 12,
            residencyCheckMs: 3,
            restoreFastMs: 8500,
            recoveryAttempted: true,
            recoverySucceeded: true,
            residencyState: {
              loaded: true,
              activeRole: "fast",
              activeIdentifier: "selene-gemma4-26b-a4b",
            },
          },
        };
      },
    },
    modelService: {
      async createChatCompletion(args) {
        calls.push(args);
        return {
          choices: [
            {
              message: {
                content: "Primary hello.",
              },
            },
          ],
          seleneModel: {
            role: "primary",
            model: "selene-muse-glimmer-30b",
            source: "explicit",
            resolveMs: 1,
            lmStudioMs: 50,
          },
        };
      },
    },
  });

  assert.equal(calls[0].role, "primary");
  assert.equal(calls[0].model, "selene-muse-glimmer-30b");
  assert.equal(calls[0].requireAvailableModel, false);
  assert.equal(response.requestedRole, "primary");
  assert.equal(response.residentRoleBefore, "fast");
  assert.equal(response.residentIdentifierBefore, "selene-gemma4-26b-a4b");
  assert.equal(response.residentRoleAfter, "fast");
  assert.equal(response.residentIdentifierAfter, "selene-gemma4-26b-a4b");
  assert.equal(response.modelAlreadyLoaded, false);
  assert.equal(response.modelLoadMs, 8000);
  assert.equal(response.modelUnloadMs, 1000);
  assert.equal(response.modelSwitchMs, 9000);
  assert.equal(response.queueWaitMs, 12);
  assert.equal(response.residencyCheckMs, 3);
  assert.equal(response.restoreFastMs, 8500);
  assert.equal(response.recoveryAttempted, true);
  assert.equal(response.recoverySucceeded, true);
  assert.match(response.timingSummary, /Model queue wait:/);
  assert.match(response.timingSummary, /Model switch:/);
});

test("runModelRoleTest does not execute returned tool calls", async () => {
  const response = await runModelRoleTest("Open Notepad", "primary", {
    logTiming: false,
    modelManager: null,
    modelService: {
      async createChatCompletion() {
        return {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    function: {
                      name: "open_app",
                      arguments: "{\"app\":\"notepad\"}",
                    },
                  },
                ],
              },
            },
          ],
          seleneModel: {
            role: "primary",
            model: "primary-model",
            source: "config",
            resolveMs: 1,
            lmStudioMs: 10,
          },
        };
      },
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.message, "(No response.)");
  assert.equal(response.toolCallCount, 1);
  assert.equal(response.toolMs, 0);
});
