import { randomUUID } from "node:crypto";
import { modelManager as defaultModelManager } from "./modelManager.js";
import { modelService as defaultModelService } from "./modelService.js";
import { tryFastRoute } from "./router.js";
import { executeTool, toolDefinitions } from "./tools.js";
import { logEvent } from "./logger.js";

export const SYSTEM_PROMPT = `
You are Selene, the local AI assistant running on the Windows PC named NOVA.
Use tools for approved actions.
You may use friendly aliases for approved apps, such as "vscode" for Visual Studio Code.
You may request type_text only for literal text the user asked to type into the focused foreground application.
If the user says "type the words", "type the phrase", or "type a note saying", pass only the intended content to type, not the instruction wrapper.
You may request keyboard_shortcut only for allowlisted shortcut names from the tool schema.
You request actions; Selene Core's Authority Manager decides whether they may execute.
You cannot elevate your own authority or invent arbitrary shortcuts.
Never claim an action succeeded unless the tool result says it succeeded.
Default personality: calm, perceptive, capable, warm, lightly witty, concise during routine actions, honest about uncertainty, and non-intrusive.
Routine commands should usually receive short confirmations such as "Done."
Do not over-explain routine actions unless asked.
Use humor occasionally, not constantly.
Ask when genuinely uncertain instead of guessing.
Permission or authority refusals should be calm and clear rather than dramatic.
Feel natural in conversation without becoming excessively chatty.
`.trim();

export const BENCHMARK_SYSTEM_PROMPT = "You are a candidate reasoning model being evaluated as the local brain for Selene, a local-first Windows AI assistant. Follow the user's instructions precisely. Be truthful about uncertainty and evidence. Do not claim actions, tool results, files, tests, or observations that you do not actually have.";

export const BENCHMARK_EQUIVALENT_SETTINGS = Object.freeze({
  temperature: 0.2,
  topP: 0.9,
  maxTokens: 1200,
  seed: 42,
});

export function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000;
}

export function getFastRouteLogOutput(result) {
  if (result?.action === "awareness_query") return "awareness_query_answered";
  if (result?.action === "awareness_context_query") return "awareness_context_query_answered";
  return result?.message;
}

export function formatTimingSummary({
  taskId,
  role = "default",
  model = "",
  lmStudioMs = 0,
  toolCallCount = 0,
  totalMs = 0,
  queueWaitMs,
  modelSwitchMs,
} = {}) {
  const request = taskId ? `Request: ${taskId}` : "Request: unknown";
  const displayModel = model || "(none)";

  const parts = [
    request,
    `Role: ${role || "default"}`,
    `Model: ${displayModel}`,
    `LM Studio latency: ${(lmStudioMs / 1000).toFixed(1)}s`,
    `Tool calls: ${toolCallCount}`,
    `Total Core latency: ${(totalMs / 1000).toFixed(1)}s`,
  ];

  if (typeof queueWaitMs === "number") {
    parts.push(`Model queue wait: ${(queueWaitMs / 1000).toFixed(1)}s`);
  }

  if (typeof modelSwitchMs === "number") {
    parts.push(`Model switch: ${(modelSwitchMs / 1000).toFixed(1)}s`);
  }

  return parts.join(" | ");
}

export async function runModelTurn(model, userText, options = {}) {
  const service = options.modelService ?? defaultModelService;
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText },
  ];

  const firstStart = process.hrtime.bigint();
  const first = await service.createChatCompletion({
    role: options.modelRole,
    model,
    messages,
    tools: toolDefinitions,
  });
  const firstMs = msSince(firstStart);

  const assistant = first?.choices?.[0]?.message;
  const modelObservability = first?.seleneModel ?? {};

  if (!assistant) {
    throw new Error("LM Studio returned no assistant message.");
  }

  const calls = assistant.tool_calls ?? [];
  const toolCallCount = calls.length;

  if (!calls.length) {
    return {
      text: assistant.content?.trim() || "(No response.)",
      firstMs,
      lmStudioMs: modelObservability.lmStudioMs ?? firstMs,
      modelResolveMs: modelObservability.resolveMs ?? 0,
      modelRole: modelObservability.role ?? options.modelRole ?? "default",
      model: modelObservability.model ?? model ?? "",
      modelSource: modelObservability.source ?? "",
      toolCallCount,
      toolMs: 0,
      ok: true,
    };
  }

  const toolStart = process.hrtime.bigint();
  let result = null;

  for (const call of calls) {
    let args = {};

    try {
      args = JSON.parse(call?.function?.arguments || "{}");
    } catch {
      args = {};
    }

    try {
      result = await executeTool(call?.function?.name, args, options);
    } catch (error) {
      result = { ok: false, error: error.message };
    }

    if (result?.ok === false) {
      break;
    }
  }

  return {
    text: result?.message ?? result?.error ?? "Done.",
    firstMs,
    lmStudioMs: modelObservability.lmStudioMs ?? firstMs,
    modelResolveMs: modelObservability.resolveMs ?? 0,
    modelRole: modelObservability.role ?? options.modelRole ?? "default",
    model: modelObservability.model ?? model ?? "",
    modelSource: modelObservability.source ?? "",
    toolCallCount,
    toolMs: msSince(toolStart),
    ok: result?.ok !== false,
    result,
  };
}

export async function runModelRoleTest(userText, role, {
  modelService,
  modelManager,
  logTiming = true,
  benchmarkEquivalent = false,
} = {}) {
  const taskId = randomUUID().slice(0, 8);
  const start = process.hrtime.bigint();
  const service = modelService ?? defaultModelService;
  const manager = modelManager === null
    ? null
    : modelManager ?? defaultModelManager;
  const settings = benchmarkEquivalent ? BENCHMARK_EQUIVALENT_SETTINGS : {};
  const messages = [
    {
      role: "system",
      content: benchmarkEquivalent ? BENCHMARK_SYSTEM_PROMPT : SYSTEM_PROMPT,
    },
    { role: "user", content: userText },
  ];

  let residency = {};
  let first;
  const firstStart = process.hrtime.bigint();

  async function generate(profile) {
    return service.createChatCompletion({
      role,
      model: profile?.apiId,
      messages,
      toolChoice: "none",
      requireAvailableModel: !profile?.apiId,
      allowRoleFallback: false,
      ...settings,
    });
  }

  if (manager) {
    const managed = await manager.runWithRoleReady(role, async ({ profile }) =>
      generate(profile),
    );
    first = managed.result;
    residency = managed.residency ?? {};
  } else {
    first = await generate(null);
  }

  const firstMs = msSince(firstStart);
  const totalMs = msSince(start);
  const assistant = first?.choices?.[0]?.message;

  if (!assistant) {
    throw new Error("LM Studio returned no assistant message.");
  }

  const modelObservability = first?.seleneModel ?? {};
  const toolCallCount = assistant.tool_calls?.length ?? 0;
  const timingSummary = formatTimingSummary({
    taskId,
    role: modelObservability.role ?? role,
    model: modelObservability.model ?? "",
    lmStudioMs: modelObservability.lmStudioMs ?? firstMs,
    toolCallCount,
    totalMs,
    queueWaitMs: residency.queueWaitMs,
    modelSwitchMs: residency.modelSwitchMs,
  });

  const residencyDebug = {
    residencyState: residency.residencyState,
    requestedRole: residency.requestedRole ?? role,
    residentRoleBefore: residency.residentRoleBefore ?? "",
    residentIdentifierBefore: residency.residentIdentifierBefore ?? "",
    residentRoleAfter: residency.residentRoleAfter ?? "",
    residentIdentifierAfter: residency.residentIdentifierAfter ?? "",
    modelAlreadyLoaded: Boolean(residency.modelAlreadyLoaded),
    modelLoadMs: residency.modelLoadMs ?? 0,
    modelUnloadMs: residency.modelUnloadMs ?? 0,
    modelSwitchMs: residency.modelSwitchMs ?? 0,
    queueWaitMs: residency.queueWaitMs ?? 0,
    residencyCheckMs: residency.residencyCheckMs ?? 0,
    restoreFastMs: residency.restoreFastMs ?? 0,
    modelManagerError: residency.modelManagerError ?? "",
    recoveryAttempted: Boolean(residency.recoveryAttempted),
    recoverySucceeded: residency.recoverySucceeded ?? null,
  };

  await logEvent({
    taskId,
    route: "debug-model-test",
    role: modelObservability.role ?? role,
    model: modelObservability.model ?? "",
    modelSource: modelObservability.source ?? "",
    inputCharacters: String(userText ?? "").length,
    output: assistant.content?.trim() || "(No response.)",
    firstModelMs: firstMs,
    lmStudioMs: modelObservability.lmStudioMs ?? firstMs,
    modelResolveMs: modelObservability.resolveMs ?? 0,
    toolCallCount,
    toolMs: 0,
    totalMs,
    ...residencyDebug,
  });

  if (logTiming) {
    console.log(timingSummary);
  }

  return {
    ok: true,
    message: assistant.content?.trim() || "(No response.)",
    route: "debug-model-test",
    taskId,
    role: modelObservability.role ?? role,
    model: modelObservability.model ?? "",
    modelSource: modelObservability.source ?? "",
    firstModelMs: firstMs,
    lmStudioMs: modelObservability.lmStudioMs ?? firstMs,
    modelResolveMs: modelObservability.resolveMs ?? 0,
    toolCallCount,
    toolMs: 0,
    totalMs,
    timingSummary,
    ...residencyDebug,
    debug: {
      benchmarkEquivalent,
      systemPrompt: benchmarkEquivalent ? "benchmark" : "selene-core",
      generationSettings: benchmarkEquivalent
        ? {
            temperature: BENCHMARK_EQUIVALENT_SETTINGS.temperature,
            topP: BENCHMARK_EQUIVALENT_SETTINGS.topP,
            maxTokens: BENCHMARK_EQUIVALENT_SETTINGS.maxTokens,
            seed: BENCHMARK_EQUIVALENT_SETTINGS.seed,
            stream: false,
            tools: false,
            toolChoice: "none",
          }
        : {
            stream: false,
            tools: false,
            toolChoice: "none",
          },
    },
  };
}

export async function runNovaCommand(userText, {
  model,
  modelRole,
  authorityToken,
  modelService,
  logTiming = true,
} = {}) {
  const taskId = randomUUID().slice(0, 8);
  const start = process.hrtime.bigint();
  const fast = await tryFastRoute(userText, { authorityToken, taskId });

  if (fast.handled) {
    const totalMs = msSince(start);

    await logEvent({
      taskId,
      route: "fast",
      inputCharacters: String(userText ?? "").length,
      output: getFastRouteLogOutput(fast.result),
      totalMs,
    });

    return {
      ok: fast.result.ok !== false,
      message: fast.result.message ?? fast.result.error ?? "Done.",
      route: "fast",
      totalMs,
      ...fast.result,
    };
  }

  const response = await runModelTurn(model, userText, {
    authorityToken,
    taskId,
    modelRole,
    modelService,
  });
  const totalMs = msSince(start);

  await logEvent({
    taskId,
    route: "model",
    role: response.modelRole,
    model: response.model,
    modelSource: response.modelSource,
    inputCharacters: String(userText ?? "").length,
    output: response.text,
    firstModelMs: response.firstMs,
    lmStudioMs: response.lmStudioMs,
    modelResolveMs: response.modelResolveMs,
    toolCallCount: response.toolCallCount,
    toolMs: response.toolMs,
    totalMs,
  });

  const timingSummary = formatTimingSummary({
    taskId,
    role: response.modelRole,
    model: response.model,
    lmStudioMs: response.lmStudioMs,
    toolCallCount: response.toolCallCount,
    totalMs,
  });

  if (logTiming) {
    console.log(timingSummary);
  }

  return {
    ok: response.ok,
    message: response.text,
    route: "model",
    taskId,
    role: response.modelRole,
    model: response.model,
    modelSource: response.modelSource,
    firstModelMs: response.firstMs,
    lmStudioMs: response.lmStudioMs,
    modelResolveMs: response.modelResolveMs,
    toolCallCount: response.toolCallCount,
    toolMs: response.toolMs,
    totalMs,
    timingSummary,
    ...(response.result ?? {}),
  };
}
