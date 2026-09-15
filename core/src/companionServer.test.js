import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  COMPANION_HOST,
  createCompanionServer,
  startCompanionServer,
} from "./companionServer.js";
import {
  COMPANION_CHAT_STATES,
  handleCompanionChat,
} from "./companionChat.js";

const TEST_CHAT_REPLY = "A conversational reply.";

function createTestCompanionServer(options = {}) {
  const modelService = {
    async createChatCompletion() {
      return {
        choices: [{ message: { content: TEST_CHAT_REPLY } }],
      };
    },
  };

  return createCompanionServer({
    ...options,
    chatHandler: ({ message }) => handleCompanionChat({ message, modelService }),
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, COMPANION_HOST, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function request({
  port,
  method = "GET",
  path = "/health",
  origin = "",
  body = null,
  headers = {},
}) {
  return new Promise((resolve, reject) => {
    const requestBody = body === null
      ? null
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
    const requestHeaders = {
      ...headers,
      ...(origin ? { Origin: origin } : {}),
    };

    if (requestBody !== null) {
      requestHeaders["Content-Length"] = Buffer.byteLength(requestBody);
    }

    const req = http.request({
      host: COMPANION_HOST,
      port,
      method,
      path,
      headers: requestHeaders,
    }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    });

    req.on("error", reject);
    if (requestBody !== null) {
      req.write(requestBody);
    }
    req.end();
  });
}

test("Companion health endpoint returns Selene Core status", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({ port });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.name, "Selene Core");
    assert.equal(body.machine, "NOVA");
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
  } finally {
    await close(server);
  }
});

test("Companion API allows only configured local development origins", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const localhost = await request({
      port,
      origin: "http://localhost:8080",
    });
    const loopback = await request({
      port,
      origin: "http://127.0.0.1:8080",
    });
    const unknown = await request({
      port,
      origin: "http://example.test",
    });

    assert.equal(
      localhost.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(
      loopback.headers["access-control-allow-origin"],
      "http://127.0.0.1:8080",
    );
    assert.equal(unknown.headers["access-control-allow-origin"], undefined);
  } finally {
    await close(server);
  }
});

test("Companion API handles OPTIONS requests for allowed origins", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "OPTIONS",
      origin: "http://localhost:8080",
    });

    assert.equal(response.statusCode, 204);
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(response.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  } finally {
    await close(server);
  }
});

test("Companion chat endpoint accepts a valid message", async () => {
  const server = createTestCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: " Hello, Selene. ",
      },
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.reply, "string");
    assert.equal(body.reply, TEST_CHAT_REPLY);
    assert.equal(COMPANION_CHAT_STATES.has(body.state), true);
    assert.equal(body.state, "idle");
    assert.equal(Array.isArray(body.events), true);
    assert.deepEqual(body.events, []);
  } finally {
    await close(server);
  }
});

test("Companion chat remains disconnected from privileged command/model pipeline", async () => {
  const calls = [];
  const server = createCompanionServer({
    async chatHandler(input) {
      calls.push(input);
      return {
        ok: true,
        reply: "I can discuss that, but cannot open applications here.",
        state: "idle",
        events: [],
      };
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "Open Notepad",
        authorityToken: "not-used-by-companion-chat",
      },
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{ message: "Open Notepad" }]);
    assert.deepEqual(body, {
      ok: true,
      reply: "I can discuss that, but cannot open applications here.",
      state: "idle",
      events: [],
    });
  } finally {
    await close(server);
  }
});

test("Companion chat rejects a missing message", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {},
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INVALID_MESSAGE");
  } finally {
    await close(server);
  }
});

test("Companion chat rejects an empty message", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "   ",
      },
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.message, "Message must not be empty.");
  } finally {
    await close(server);
  }
});

test("Companion chat rejects a non-string message", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: 123,
      },
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, "INVALID_MESSAGE");
  } finally {
    await close(server);
  }
});

test("Companion chat rejects malformed JSON", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{ nope",
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, "MALFORMED_JSON");
  } finally {
    await close(server);
  }
});

test("Companion chat rejects oversized messages", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "x".repeat(8001),
      },
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 400);
    assert.equal(body.error.code, "MESSAGE_TOO_LARGE");
  } finally {
    await close(server);
  }
});

test("Companion chat rejects unsupported content type", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "text/plain",
      },
      body: "message=hello",
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 415);
    assert.equal(body.error.code, "UNSUPPORTED_CONTENT_TYPE");
  } finally {
    await close(server);
  }
});

test("Companion chat rejects unsupported methods", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "GET",
      path: "/api/chat",
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 405);
    assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
  } finally {
    await close(server);
  }
});

test("Companion chat CORS allows both local development origins only", async () => {
  const server = createTestCompanionServer();
  const port = await listen(server);

  try {
    const localhost = await request({
      port,
      method: "POST",
      path: "/api/chat",
      origin: "http://localhost:8080",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "Hello",
      },
    });
    const loopback = await request({
      port,
      method: "POST",
      path: "/api/chat",
      origin: "http://127.0.0.1:8080",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "Hello",
      },
    });
    const unknown = await request({
      port,
      method: "POST",
      path: "/api/chat",
      origin: "http://example.test",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "Hello",
      },
    });

    assert.equal(
      localhost.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(
      loopback.headers["access-control-allow-origin"],
      "http://127.0.0.1:8080",
    );
    assert.equal(unknown.headers["access-control-allow-origin"], undefined);
  } finally {
    await close(server);
  }
});

test("Companion chat sanitizes model failures", async () => {
  const server = createCompanionServer({
    async chatHandler() {
      throw new Error("private model diagnostic");
    },
  });
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "Hello",
      },
    });
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 500);
    assert.deepEqual(body, {
      ok: false,
      error: {
        code: "CHAT_FAILED",
        message: "Chat request failed.",
      },
    });
    assert.doesNotMatch(response.body, /private model diagnostic/);
  } finally {
    await close(server);
  }
});

test("Companion chat OPTIONS preflight supports JSON POST", async () => {
  const server = createCompanionServer();
  const port = await listen(server);

  try {
    const response = await request({
      port,
      method: "OPTIONS",
      path: "/api/chat",
      origin: "http://127.0.0.1:8080",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://127.0.0.1:8080",
    );
    assert.equal(response.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
    assert.equal(response.headers["access-control-allow-headers"], "Content-Type, Accept");
  } finally {
    await close(server);
  }
});

test("Companion API reports port conflicts without throwing", async () => {
  const occupied = http.createServer((_req, res) => {
    res.end("occupied");
  });
  const port = await listen(occupied);
  const errors = [];

  try {
    const server = await startCompanionServer({
      host: COMPANION_HOST,
      port,
      onListening() {},
      onError(message) {
        errors.push(message);
      },
    });

    assert.equal(server, null);
    assert.match(errors[0], /port is already in use/);
  } finally {
    await close(occupied);
  }
});
