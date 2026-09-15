import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LM_STUDIO_REQUEST_TIMEOUT_MS,
  createChatCompletion,
  getLmStudioRequestTimeoutMs,
} from "./lmStudio.js";

test("LM Studio request timeout defaults to compatibility value", () => {
  assert.equal(getLmStudioRequestTimeoutMs({}), DEFAULT_LM_STUDIO_REQUEST_TIMEOUT_MS);
});

test("LM Studio request timeout supports environment override", () => {
  assert.equal(getLmStudioRequestTimeoutMs({ LM_STUDIO_REQUEST_TIMEOUT_MS: "1234" }), 1234);
  assert.equal(getLmStudioRequestTimeoutMs({ LM_STUDIO_TIMEOUT_MS: "2345" }), 2345);
  assert.equal(getLmStudioRequestTimeoutMs({ LM_STUDIO_REQUEST_TIMEOUT_MS: "nope" }), DEFAULT_LM_STUDIO_REQUEST_TIMEOUT_MS);
});

test("createChatCompletion aborts timed out LM Studio requests", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  });

  try {
    await assert.rejects(
      () => createChatCompletion({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
        timeoutMs: 1,
      }),
      /timed out after 1 ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createChatCompletion serializes benchmark-compatible seed setting", async () => {
  const originalFetch = globalThis.fetch;
  let body;

  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    };
  };

  try {
    await createChatCompletion({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
      seed: 42,
      topP: 0.9,
      maxTokens: 1200,
    });

    assert.equal(body.seed, 42);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.max_tokens, 1200);
    assert.equal(body.stream, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
