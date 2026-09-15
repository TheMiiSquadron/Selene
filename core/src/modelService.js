import {
  createChatCompletion as createLmStudioChatCompletion,
  getModelId,
  getModelStatus,
} from "./lmStudio.js";
import {
  loadModelProfiles,
  resolveModelProfile,
} from "./modelProfiles.js";

function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1_000_000;
}

export function createModelService({
  lmStudio = {
    createChatCompletion: createLmStudioChatCompletion,
    getModelId,
    getModelStatus,
  },
  loadProfiles = loadModelProfiles,
  env = process.env,
} = {}) {
  async function resolveProfile({
    role = "",
    model = "",
    allowRoleFallback = true,
  } = {}) {
    let fallbackModel = String(model ?? "").trim();

    if (fallbackModel || !role) {
      if (!fallbackModel) {
        fallbackModel = await lmStudio.getModelId();
      }

      return resolveModelProfile({
        role,
        explicitModel: model,
        env,
        fallbackModel,
        allowRoleFallback,
      });
    }

    const profiles = await loadProfiles();

    try {
      return resolveModelProfile({
        role,
        explicitModel: model,
        profiles,
        env,
        fallbackModel,
        allowRoleFallback,
      });
    } catch (error) {
      if (fallbackModel) throw error;

      return resolveModelProfile({
        role,
        explicitModel: model,
        profiles,
        env,
        fallbackModel: await lmStudio.getModelId(),
        allowRoleFallback,
      });
    }
  }

  async function assertModelAvailable(profile) {
    if (typeof lmStudio.getModelStatus !== "function") {
      return;
    }

    const status = await lmStudio.getModelStatus();
    if (!status.reachable) {
      throw new Error("LM Studio is not reachable.");
    }

    if (!status.models.includes(profile.model)) {
      throw new Error(
        `Configured model for role "${profile.role}" is not available in LM Studio: ${profile.model}`,
      );
    }
  }

  async function createChatCompletion({
    role = "",
    model = "",
    messages,
    tools,
    toolChoice = "auto",
    temperature,
    topP,
    maxTokens,
    seed,
    requireAvailableModel = false,
    allowRoleFallback = true,
  } = {}) {
    const resolveStart = process.hrtime.bigint();
    const profile = await resolveProfile({ role, model, allowRoleFallback });
    const resolveMs = msSince(resolveStart);

    if (requireAvailableModel) {
      await assertModelAvailable(profile);
    }

    const lmStudioStart = process.hrtime.bigint();
    const request = {
      model: profile.model,
      messages,
      tools,
      toolChoice,
      ...profile.settings,
    };

    if (typeof temperature !== "undefined") request.temperature = temperature;
    if (typeof topP !== "undefined") request.topP = topP;
    if (typeof maxTokens !== "undefined") request.maxTokens = maxTokens;
    if (typeof seed !== "undefined") request.seed = seed;

    const response = await lmStudio.createChatCompletion(request);
    const lmStudioMs = msSince(lmStudioStart);

    response.seleneModel = {
      role: profile.role,
      model: profile.model,
      source: profile.source,
      resolveMs,
      lmStudioMs,
    };

    return response;
  }

  return {
    resolveProfile,
    createChatCompletion,
  };
}

export const modelService = createModelService();
