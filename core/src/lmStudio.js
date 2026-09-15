const BASE_URL =
  process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";

export const DEFAULT_LM_STUDIO_REQUEST_TIMEOUT_MS = 600_000;

export function getLmStudioRequestTimeoutMs(env = process.env) {
  const raw = env.LM_STUDIO_REQUEST_TIMEOUT_MS ?? env.LM_STUDIO_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_LM_STUDIO_REQUEST_TIMEOUT_MS;
}

async function request(path, options = {}) {
  const {
    timeoutMs = getLmStudioRequestTimeoutMs(),
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;

  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(fetchOptions.headers ?? {}),
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`LM Studio request timed out after ${timeoutMs} ms.`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(
      `LM Studio HTTP ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}

export async function getModelId() {
  if (process.env.LM_STUDIO_MODEL) return process.env.LM_STUDIO_MODEL;

  const data = await request("/models");
  const id = data?.data?.[0]?.id;

  if (!id) {
    throw new Error("LM Studio is reachable, but no model is available.");
  }

  return id;
}

export async function getModelStatus() {
  try {
    const data = await request("/models");
    const models = Array.isArray(data?.data)
      ? data.data.map((model) => String(model?.id ?? "")).filter(Boolean)
      : [];

    return {
      reachable: true,
      model: process.env.LM_STUDIO_MODEL || models[0] || "",
      models,
    };
  } catch {
    return {
      reachable: false,
      model: "",
      models: [],
    };
  }
}

export async function createChatCompletion({
  model,
  messages,
  tools,
  toolChoice = "auto",
  temperature = 0.1,
  topP,
  maxTokens,
  seed,
  timeoutMs,
}) {
  const body = {
    model,
    messages,
    tools,
    tool_choice: toolChoice,
    temperature,
    stream: false,
  };

  if (typeof topP !== "undefined") body.top_p = topP;
  if (typeof maxTokens !== "undefined") body.max_tokens = maxTokens;
  if (typeof seed !== "undefined") body.seed = seed;

  return request("/chat/completions", {
    method: "POST",
    timeoutMs,
    body: JSON.stringify(body),
  });
}
