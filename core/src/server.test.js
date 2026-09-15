import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createCoreServer } from "./server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function request({
  port,
  method = "POST",
  path = "/debug/model-test",
  body = {},
}) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
      },
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body: JSON.parse(responseBody),
        });
      });
    });

    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });
}

test("debug model-test endpoint accepts a known role and returns diagnostics", async () => {
  const calls = [];
  const server = createCoreServer({
    modelRoleTester: async (text, role, options) => {
      calls.push({ text, role, options });
      return {
        ok: true,
        message: "Hi.",
        route: "debug-model-test",
        taskId: "abcd1234",
        role,
        model: "fast-model",
        modelSource: "config",
        lmStudioMs: 25,
        modelResolveMs: 2,
        toolCallCount: 0,
        toolMs: 0,
        totalMs: 30,
        timingSummary: "Request: abcd1234 | Role: fast | Model: fast-model | LM Studio latency: 0.0s | Tool calls: 0 | Total Core latency: 0.0s",
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      body: {
        text: "Hello",
        role: "fast",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.route, "debug-model-test");
    assert.equal(response.body.role, "fast");
    assert.equal(response.body.model, "fast-model");
    assert.equal(response.body.toolCallCount, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      text: "Hello",
      role: "fast",
      options: { benchmarkEquivalent: false },
    });
  } finally {
    await close(server);
  }
});

test("debug model-test endpoint rejects unknown roles before model execution", async () => {
  const server = createCoreServer({
    modelRoleTester: async () => {
      throw new Error("should not call model role tester");
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      body: {
        text: "Hello",
        role: "gemma",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /Unknown model role/);
  } finally {
    await close(server);
  }
});

test("debug model-test endpoint requires an explicit role", async () => {
  const server = createCoreServer({
    modelRoleTester: async () => {
      throw new Error("should not call model role tester");
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      body: {
        text: "Hello",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /Expected "role"/);
  } finally {
    await close(server);
  }
});

test("debug model-test endpoint does not expose authority tokens or tools", async () => {
  const calls = [];
  const server = createCoreServer({
    modelRoleTester: async (text, role, options) => {
      calls.push({ text, role, options });
      return {
        ok: true,
        message: "No tool execution.",
        route: "debug-model-test",
        role,
        model: "primary-model",
        toolCallCount: 1,
        toolMs: 0,
        totalMs: 10,
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      body: {
        text: "Open Notepad",
        role: "primary",
        model: "caller-selected-model",
        authorityToken: "ignored",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.route, "debug-model-test");
    assert.equal(response.body.toolMs, 0);
    assert.deepEqual(calls, [{
      text: "Open Notepad",
      role: "primary",
      options: { benchmarkEquivalent: false },
    }]);
  } finally {
    await close(server);
  }
});

test("debug model-test endpoint passes benchmarkEquivalent flag narrowly", async () => {
  const calls = [];
  const server = createCoreServer({
    modelRoleTester: async (text, role, options) => {
      calls.push({ text, role, options });
      return {
        ok: true,
        message: "Benchmark mode.",
        route: "debug-model-test",
        role,
        model: "fast-model",
        toolCallCount: 0,
        toolMs: 0,
        totalMs: 10,
        debug: {
          benchmarkEquivalent: options.benchmarkEquivalent,
          generationSettings: {
            temperature: 0.2,
            topP: 0.9,
            maxTokens: 1200,
            seed: 42,
            stream: false,
            tools: false,
            toolChoice: "none",
          },
        },
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      body: {
        text: "Hello",
        role: "fast",
        benchmarkEquivalent: true,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.debug.benchmarkEquivalent, true);
    assert.equal(response.body.debug.generationSettings.temperature, 0.2);
    assert.equal(response.body.debug.generationSettings.topP, 0.9);
    assert.equal(response.body.debug.generationSettings.maxTokens, 1200);
    assert.equal(response.body.debug.generationSettings.seed, 42);
    assert.deepEqual(calls, [{
      text: "Hello",
      role: "fast",
      options: { benchmarkEquivalent: true },
    }]);
  } finally {
    await close(server);
  }
});
