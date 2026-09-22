import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANION_HOST,
  COMPANION_LAN_HOST,
  COMPANION_PORT,
  createCompanionServer,
  resolveCompanionHost,
  startCompanionServer,
  prepareCompanionTransport,
  CompanionTransportConfigurationError,
} from "./companionServer.js";
import {
  COMPANION_CHAT_STATES,
  handleCompanionChat,
} from "./companionChat.js";
import { startSeleneServers } from "./server.js";

const TEST_CHAT_REPLY = "A conversational reply.";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

test("Companion host defaults safely unless LAN mode is exactly enabled", () => {
  assert.equal(COMPANION_PORT, 8787);
  assert.equal(resolveCompanionHost({}), COMPANION_HOST);
  assert.equal(resolveCompanionHost({ SELENE_COMPANION_LAN: "" }), COMPANION_HOST);
  assert.equal(resolveCompanionHost({ SELENE_COMPANION_LAN: "0" }), COMPANION_HOST);
  assert.equal(resolveCompanionHost({ SELENE_COMPANION_LAN: "true" }), COMPANION_HOST);
  assert.equal(resolveCompanionHost({ SELENE_COMPANION_LAN: " 1 " }), COMPANION_HOST);
  assert.equal(resolveCompanionHost({ SELENE_COMPANION_LAN: "1" }), COMPANION_LAN_HOST);
});

test("Companion startup defaults to loopback and identifies loopback mode", async () => {
  const messages = [];
  const server = await startCompanionServer({
    port: 0,
    env: {},
    onListening(message) {
      messages.push(message);
    },
    onError() {},
  });

  try {
    const address = server.address();
    assert.equal(address.address, COMPANION_HOST);
    assert.equal(address.port > 0, true);
    assert.deepEqual(messages, [
      `Selene Companion API listening on http://${COMPANION_HOST}:${address.port} (loopback only).`,
    ]);
  } finally {
    await close(server);
  }
});

test("Companion LAN flag binds all IPv4 interfaces and identifies LAN mode", async () => {
  const messages = [];
  const server = await startCompanionServer({
    port: 0,
    env: { SELENE_COMPANION_LAN: "1" },
    onListening(message) {
      messages.push(message);
    },
    onError() {},
  });

  try {
    const address = server.address();
    assert.equal(address.address, COMPANION_LAN_HOST);
    assert.equal(address.port > 0, true);
    assert.deepEqual(messages, [
      `Selene Companion API listening on http port ${address.port} (LAN mode enabled).`,
    ]);
  } finally {
    await close(server);
  }
});

test("Explicit Companion host overrides the LAN environment flag", async () => {
  const server = await startCompanionServer({
    host: COMPANION_HOST,
    port: 0,
    env: { SELENE_COMPANION_LAN: "1" },
    onListening() {},
    onError() {},
  });

  try {
    assert.equal(server.address().address, COMPANION_HOST);
  } finally {
    await close(server);
  }
});

test("Companion health and chat endpoints work while bound for LAN access", async () => {
  const server = createTestCompanionServer({ host: COMPANION_LAN_HOST });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, COMPANION_LAN_HOST, () => resolve(server.address().port));
  });

  try {
    const health = await request({ port });
    const chat = await request({
      port,
      method: "POST",
      path: "/api/chat",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        message: "Hello over LAN",
      },
    });

    assert.equal(server.address().address, COMPANION_LAN_HOST);
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    assert.equal(chat.statusCode, 200);
    assert.deepEqual(JSON.parse(chat.body), {
      ok: true,
      reply: TEST_CHAT_REPLY,
      state: "idle",
      events: [],
    });
  } finally {
    await close(server);
  }
});

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

// Generate a disposable self-signed fixture with built-in crypto; no key is
// committed, installed, or used outside a temporary test directory.
function der(tag, ...parts) {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part)));
  const length = body.length < 128
    ? Buffer.from([body.length])
    : body.length < 256
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function makeTestCertificate() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const sequence = (...values) => der(0x30, ...values);
  const oid = (...bytes) => der(0x06, Buffer.from(bytes));
  const algorithm = sequence(
    oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b),
    der(0x05),
  );
  const name = sequence(der(0x31, sequence(
    oid(0x55, 0x04, 0x03),
    der(0x0c, Buffer.from("localhost")),
  )));
  const validity = sequence(
    der(0x18, Buffer.from("20200101000000Z")),
    der(0x18, Buffer.from("20400101000000Z")),
  );
  const names = sequence(
    der(0x82, Buffer.from("localhost")),
    der(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = der(0xa3, sequence(sequence(
    oid(0x55, 0x1d, 0x11),
    der(0x04, names),
  )));
  const serialBytes = randomBytes(16);
  if (serialBytes[0] === 0) serialBytes[0] = 1;
  const serial = serialBytes[0] & 0x80
    ? Buffer.concat([Buffer.from([0]), serialBytes])
    : serialBytes;
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    validity,
    name,
    publicKey,
    extensions,
  );
  const certificate = sequence(
    tbs,
    algorithm,
    der(0x03, Buffer.from([0]), sign("RSA-SHA256", tbs, privateKey)),
  );
  const encoded = certificate.toString("base64").match(/.{1,64}/g).join("\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`,
    key,
  };
}

async function tlsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "selene-companion-tls-test-"));
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  const material = makeTestCertificate();
  await writeFile(certPath, material.cert);
  await writeFile(keyPath, material.key);
  return { ...material, certPath, keyPath, directory };
}

function secureRequest({ port, cert, method = "GET", path = "/health", body, origin }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestBody = body === undefined ? null : JSON.stringify(body);
    const headers = {
      ...(origin ? { Origin: origin } : {}),
      ...(requestBody === null ? {} : {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
      }),
    };
    const req = https.request({
      host: COMPANION_HOST,
      port,
      method,
      path,
      ca: cert,
      headers,
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolveRequest({
        statusCode: res.statusCode,
        headers: res.headers,
        body: responseBody,
      }));
    });
    req.on("error", rejectRequest);
    if (requestBody !== null) req.write(requestBody);
    req.end();
  });
}

test("HTTPS flag has strict values and rejects TLS paths in HTTP mode", () => {
  for (const flag of [undefined, "", "0"]) {
    assert.deepEqual(prepareCompanionTransport({ SELENE_COMPANION_HTTPS: flag }), {
      host: COMPANION_HOST,
      tlsOptions: null,
    });
  }
  for (const flag of ["true", " 1 ", "2", "false"]) {
    assert.throws(
      () => prepareCompanionTransport({ SELENE_COMPANION_HTTPS: flag }),
      CompanionTransportConfigurationError,
    );
  }
  for (const name of ["SELENE_COMPANION_TLS_CERT_PATH", "SELENE_COMPANION_TLS_KEY_PATH"]) {
    assert.throws(
      () => prepareCompanionTransport({ [name]: "unused.pem" }),
      CompanionTransportConfigurationError,
    );
  }
});

test("HTTPS requires both absolute TLS paths outside the repository", async () => {
  const fixture = await tlsFixture();
  const base = { SELENE_COMPANION_HTTPS: "1" };
  for (const env of [
    base,
    { ...base, SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath },
    { ...base, SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath },
    { ...base, SELENE_COMPANION_TLS_CERT_PATH: "relative.pem", SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath },
    { ...base, SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath, SELENE_COMPANION_TLS_KEY_PATH: "relative.pem" },
    { ...base, SELENE_COMPANION_TLS_CERT_PATH: resolve("src/companionServer.js"), SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath },
  ]) {
    assert.throws(() => prepareCompanionTransport(env), CompanionTransportConfigurationError);
  }
});

test("HTTPS rejects a TLS path traversing into the repository", async () => {
  const fixture = await tlsFixture();
  const traversingPath = `${REPOSITORY_ROOT}${sep}core${sep}..${sep}core${sep}package.json`;
  assert.match(traversingPath, /\.\./);
  assert.throws(() => prepareCompanionTransport({
    SELENE_COMPANION_HTTPS: "1",
    SELENE_COMPANION_TLS_CERT_PATH: traversingPath,
    SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
  }), /outside the repository/);
});

test("HTTPS rejects case-varied repository paths on case-insensitive Windows", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows path casing applies only on Windows.");
    return;
  }
  const caseVariedPath = join(REPOSITORY_ROOT, "core", "package.json").toUpperCase();
  if (!existsSync(caseVariedPath)) {
    t.skip("This Windows filesystem does not resolve the case-varied path.");
    return;
  }
  const fixture = await tlsFixture();
  assert.throws(() => prepareCompanionTransport({
    SELENE_COMPANION_HTTPS: "1",
    SELENE_COMPANION_TLS_CERT_PATH: caseVariedPath,
    SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
  }), /outside the repository/);
});

test("HTTPS rejects a symlink or junction resolving into the repository", async (t) => {
  const fixture = await tlsFixture();
  const linkPath = join(fixture.directory, "repository-link");
  try {
    await symlink(REPOSITORY_ROOT, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
      t.skip(`Directory links are unavailable on this filesystem (${error.code}).`);
      return;
    }
    throw error;
  }
  assert.throws(() => prepareCompanionTransport({
    SELENE_COMPANION_HTTPS: "1",
    SELENE_COMPANION_TLS_CERT_PATH: join(linkPath, "core", "package.json"),
    SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
  }), /outside the repository/);
});

test("HTTPS rejects missing, unreadable, empty, malformed, and mismatched material", async () => {
  const fixture = await tlsFixture();
  const env = {
    SELENE_COMPANION_HTTPS: "1",
    SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath,
    SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
  };
  const emptyPath = join(fixture.directory, "empty.pem");
  const malformedPath = join(fixture.directory, "malformed.pem");
  await writeFile(emptyPath, "");
  await writeFile(malformedPath, "not a PEM file");
  const other = await tlsFixture();

  for (const override of [
    { SELENE_COMPANION_TLS_CERT_PATH: join(fixture.directory, "missing.pem") },
    { SELENE_COMPANION_TLS_CERT_PATH: fixture.directory },
    { SELENE_COMPANION_TLS_CERT_PATH: emptyPath },
    { SELENE_COMPANION_TLS_KEY_PATH: emptyPath },
    { SELENE_COMPANION_TLS_CERT_PATH: malformedPath },
    { SELENE_COMPANION_TLS_KEY_PATH: malformedPath },
    { SELENE_COMPANION_TLS_KEY_PATH: other.keyPath },
  ]) {
    assert.throws(() => prepareCompanionTransport({ ...env, ...override }),
      CompanionTransportConfigurationError);
  }
  assert.equal(prepareCompanionTransport(env).tlsOptions.cert.toString(), fixture.cert);
});

test("HTTPS and HTTP share route behavior, with no HTTP fallback", async () => {
  const fixture = await tlsFixture();
  const messages = [];
  const server = await startCompanionServer({
    port: 0,
    env: {
      SELENE_COMPANION_HTTPS: "1",
      SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath,
      SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
    },
    onListening(message) { messages.push(message); },
  });
  try {
    const port = server.address().port;
    assert.equal(server.address().address, COMPANION_HOST);
    assert.deepEqual(messages, [
      `Selene Companion API listening on https://${COMPANION_HOST}:${port} (loopback only).`,
    ]);
    const health = await secureRequest({ port, cert: fixture.cert });
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    const chat = await secureRequest({
      port, cert: fixture.cert, method: "POST", path: "/api/chat", body: {},
      origin: "http://localhost:8080",
    });
    assert.equal(chat.statusCode, 400);
    assert.equal(JSON.parse(chat.body).error.code, "INVALID_MESSAGE");
    assert.equal(chat.headers["access-control-allow-origin"], "http://localhost:8080");
    const preflight = await secureRequest({
      port, cert: fixture.cert, method: "OPTIONS", path: "/api/chat",
      origin: "http://localhost:8080",
    });
    assert.equal(preflight.statusCode, 204);
    const wrongMethod = await secureRequest({ port, cert: fixture.cert, path: "/api/chat" });
    assert.equal(wrongMethod.statusCode, 405);
    const privilegedRoute = await secureRequest({ port, cert: fixture.cert, path: "/authority" });
    assert.equal(privilegedRoute.statusCode, 404);
    await assert.rejects(new Promise((resolveRequest, rejectRequest) => {
      const req = https.get({ host: COMPANION_HOST, port, path: "/health" }, resolveRequest);
      req.on("error", rejectRequest);
    }), /self-signed|certificate/i);
    await assert.rejects(request({ port }), /socket hang up|reset|EPROTO/i);
  } finally {
    await close(server);
  }
});

test("HTTPS plus LAN retains the explicit all-interface bind switch", async () => {
  const fixture = await tlsFixture();
  const messages = [];
  const server = await startCompanionServer({
    port: 0,
    env: {
      SELENE_COMPANION_HTTPS: "1",
      SELENE_COMPANION_LAN: "1",
      SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath,
      SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
    },
    onListening(message) { messages.push(message); },
  });
  try {
    assert.equal(server.address().address, COMPANION_LAN_HOST);
    assert.deepEqual(messages, [
      `Selene Companion API listening on https port ${server.address().port} (LAN mode enabled).`,
    ]);
  } finally {
    await close(server);
  }
});

test("combined startup keeps HTTPS Companion on LAN and privileged Core on loopback port 3030", async (t) => {
  const fixture = await tlsFixture();
  let listeners;
  try {
    listeners = await startSeleneServers({
      env: {
        SELENE_COMPANION_HTTPS: "1",
        SELENE_COMPANION_LAN: "1",
        SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath,
        SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
      },
      companionPort: 0,
      onCoreListening() {},
      onCompanionListening() {},
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") {
      t.skip("Core port 3030 is already in use; combined binding cannot be tested here.");
      return;
    }
    throw error;
  }
  const { server, companionServer } = listeners;
  try {
    assert.equal(server.address().address, COMPANION_HOST);
    assert.equal(server.address().port, 3030);
    assert.equal(companionServer.address().address, COMPANION_LAN_HOST);
    const health = await secureRequest({ port: companionServer.address().port, cert: fixture.cert });
    assert.equal(health.statusCode, 200);
    assert.equal(JSON.parse(health.body).ok, true);
  } finally {
    await close(companionServer);
    await close(server);
  }
});

test("HTTPS preserves successful chat, CORS rejection, and sanitized model errors", async () => {
  const fixture = await tlsFixture();
  const tlsOptions = prepareCompanionTransport({
    SELENE_COMPANION_HTTPS: "1",
    SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath,
    SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
  }).tlsOptions;
  const server = createTestCompanionServer({ tlsOptions });
  const port = await listen(server);
  try {
    const chat = await secureRequest({
      port, cert: fixture.cert, method: "POST", path: "/api/chat",
      body: { message: "Hello" }, origin: "http://example.test",
    });
    assert.equal(chat.statusCode, 200);
    assert.equal(JSON.parse(chat.body).reply, TEST_CHAT_REPLY);
    assert.equal(chat.headers["access-control-allow-origin"], undefined);
  } finally {
    await close(server);
  }

  const failingServer = createCompanionServer({
    tlsOptions,
    async chatHandler() { throw new Error("private model diagnostic"); },
  });
  const failingPort = await listen(failingServer);
  try {
    const result = await secureRequest({
      port: failingPort, cert: fixture.cert, method: "POST", path: "/api/chat",
      body: { message: "Hello" },
    });
    assert.equal(result.statusCode, 500);
    assert.equal(JSON.parse(result.body).error.code, "CHAT_FAILED");
    assert.doesNotMatch(result.body, /private model diagnostic/);
  } finally {
    await close(failingServer);
  }
});

test("invalid HTTPS startup never opens a plaintext listener", async () => {
  const occupied = http.createServer((_request, response) => response.end("still HTTP"));
  const occupiedPort = await listen(occupied);
  try {
    assert.throws(() => startCompanionServer({
      port: occupiedPort,
      env: {
        SELENE_COMPANION_HTTPS: "1",
        SELENE_COMPANION_TLS_CERT_PATH: join(tmpdir(), "missing-selene-cert.pem"),
        SELENE_COMPANION_TLS_KEY_PATH: join(tmpdir(), "missing-selene-key.pem"),
      },
      onError() {},
    }), CompanionTransportConfigurationError);
    const result = await request({ port: occupiedPort });
    assert.equal(result.body, "still HTTP");
  } finally {
    await close(occupied);
  }
});

test("a supplied HTTP transport cannot override explicit HTTPS configuration", async () => {
  const fixture = await tlsFixture();
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const messages = [];
  assert.throws(() => startCompanionServer({
    port,
    env: {
      SELENE_COMPANION_HTTPS: "1",
      SELENE_COMPANION_TLS_CERT_PATH: fixture.certPath,
      SELENE_COMPANION_TLS_KEY_PATH: fixture.keyPath,
    },
    transport: { host: COMPANION_HOST, tlsOptions: null },
    onListening(message) { messages.push(message); },
  }), CompanionTransportConfigurationError);
  assert.deepEqual(messages, []);
  await assert.rejects(request({ port }), { code: "ECONNREFUSED" });
});
