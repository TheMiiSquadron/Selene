import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompanionServer } from "./companionServer.js";
import { createGatewayCredentialStore } from "./gatewayCredentialStore.js";

// Disposable HTTPS material keeps test credentials off plaintext transport.
function der(tag, ...parts) {
  const body = Buffer.concat(parts.map((part) => Buffer.from(part)));
  const length = body.length < 128 ? Buffer.from([body.length])
    : body.length < 256 ? Buffer.from([0x81, body.length])
      : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function testCertificate() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const seq = (...values) => der(0x30, ...values);
  const oid = (...bytes) => der(0x06, Buffer.from(bytes));
  const algorithm = seq(oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), der(0x05));
  const name = seq(der(0x31, seq(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from("localhost")))));
  const validity = seq(der(0x18, Buffer.from("20200101000000Z")),
    der(0x18, Buffer.from("20400101000000Z")));
  const extensions = der(0xa3, seq(seq(oid(0x55, 0x1d, 0x11), der(0x04,
    seq(der(0x82, Buffer.from("localhost")))))));
  const serialBytes = randomBytes(16);
  if (serialBytes[0] === 0) serialBytes[0] = 1;
  const serial = serialBytes[0] & 0x80
    ? Buffer.concat([Buffer.from([0]), serialBytes])
    : serialBytes;
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial),
    algorithm, name, validity, name, publicKey, extensions);
  const encoded = seq(tbs, algorithm,
    der(0x03, Buffer.from([0]), sign("RSA-SHA256", tbs, privateKey)))
    .toString("base64").match(/.{1,64}/g).join("\n");
  return { cert: `-----BEGIN CERTIFICATE-----\n${encoded}\n-----END CERTIFICATE-----\n`, key };
}

async function fixture(t, credentialStoreOverride) {
  const directory = await mkdtemp(join(tmpdir(), "selene-companion-auth-test-"));
  const store = createGatewayCredentialStore({ databasePath: join(directory, "credentials.sqlite3") });
  const tlsOptions = testCertificate();
  let chatCalls = 0;
  const server = createCompanionServer({
    tlsOptions,
    credentialStore: credentialStoreOverride === undefined ? store : credentialStoreOverride,
    async chatHandler() {
      chatCalls += 1;
      return { ok: true, reply: "test reply", state: "idle", events: [] };
    },
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, port, cert: tlsOptions.cert, get chatCalls() { return chatCalls; } };
}

function request(f, { method = "POST", path = "/api/chat", headers = {}, body = { message: "Hello" }, rawBody = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : rawBody ? body : JSON.stringify(body);
    const req = https.request({
      host: "127.0.0.1", servername: "localhost", port: f.port, method, path, ca: f.cert,
      headers: Array.isArray(headers) ? headers : {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
    }, (response) => {
      let result = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { result += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: result }));
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

test("chat requires one valid bearer with the chat capability", async (t) => {
  const f = await fixture(t);
  const chat = f.store.issueCredential({
    homeId: "test-home", displayName: "Test Home", capabilities: ["chat"],
  });
  const readOnly = f.store.issueCredential({
    homeId: "reader", displayName: "Reader", capabilities: ["conversation:read"],
  });
  const bearer = chat.bearerCredential;
  const allowed = await request(f, { headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).reply, "test reply");
  assert.equal(f.chatCalls, 1);

  const parts = bearer.split(".");
  const unknown = `${parts[0]}.00000000-0000-4000-8000-000000000000.${parts[2]}`;
  const rejected = [
    {},
    { Authorization: bearer },
    { Authorization: `Basic ${bearer}` },
    { Authorization: `Bearer ${bearer}, Bearer ${bearer}` },
    { Authorization: `Bearer ${unknown}` },
    { Authorization: `Bearer ${bearer.slice(0, -1)}x` },
  ];
  for (const headers of rejected) {
    const response = await request(f, { headers });
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body).error.code, "UNAUTHORIZED");
    assert.doesNotMatch(response.body, /selene_gateway_v1|sqlite|secret/i);
  }
  const duplicate = await request(f, { headers: [
    "Content-Type", "application/json", "Authorization", `Bearer ${bearer}`,
    "authorization", `Bearer ${bearer}`,
  ] });
  assert.ok([400, 401].includes(duplicate.status));

  const insufficient = await request(f, {
    headers: { Authorization: `Bearer ${readOnly.bearerCredential}` },
  });
  assert.equal(insufficient.status, 403);
  assert.equal(JSON.parse(insufficient.body).error.code, "FORBIDDEN");
  assert.doesNotMatch(insufficient.body, /selene_gateway_v1|sqlite|secret/i);

  assert.equal(f.store.revokeCredential(chat.credential.id), true);
  const revoked = await request(f, { headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(revoked.status, 401);
  assert.equal(f.chatCalls, 1);
});

test("query, body and cookie credentials do not authenticate chat", async (t) => {
  const f = await fixture(t);
  const issued = f.store.issueCredential({
    homeId: "test-home", displayName: "Test Home", capabilities: ["chat"],
  });
  const token = issued.bearerCredential;
  const response = await request(f, {
    path: `/api/chat?token=${encodeURIComponent(token)}`,
    headers: { Cookie: `token=${token}` },
    body: { message: "Hello", token },
  });
  assert.equal(response.status, 401);
  assert.equal(f.chatCalls, 0);
  assert.doesNotMatch(response.body, /selene_gateway_v1|sqlite|secret/i);
});

test("store failure and absence fail closed, while health stays anonymous", async (t) => {
  const f = await fixture(t, {
    authenticateCredential() { throw new Error("private database details"); },
  });
  const denied = await request(f, { headers: { Authorization: "Bearer unavailable" } });
  assert.equal(denied.status, 401);
  assert.doesNotMatch(denied.body, /private database details|unavailable/i);
  assert.equal(f.chatCalls, 0);
  const health = await request(f, { method: "GET", path: "/health", body: null });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });
});

test("missing credential store fails closed", async (t) => {
  const f = await fixture(t, null);
  const denied = await request(f, { headers: { Authorization: "Bearer unavailable" } });
  assert.equal(denied.status, 401);
  assert.equal(f.chatCalls, 0);
});

test("plaintext chat is rejected before authentication or model invocation", async (t) => {
  let chatCalls = 0;
  const server = createCompanionServer({
    credentialStore: { authenticateCredential() { throw new Error("should not authenticate"); } },
    async chatHandler() { chatCalls += 1; return { reply: "unexpected" }; },
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/chat" },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      });
    req.on("error", reject);
    req.end();
  });
  assert.equal(result.status, 426);
  assert.equal(JSON.parse(result.body).error.code, "HTTPS_REQUIRED");
  assert.equal(chatCalls, 0);
});

test("forged forwarding header cannot turn plaintext chat into HTTPS", async (t) => {
  let authenticationCalls = 0;
  let chatCalls = 0;
  const server = createCompanionServer({
    credentialStore: {
      authenticateCredential() { authenticationCalls += 1; return { capabilities: ["chat"] }; },
    },
    async chatHandler() { chatCalls += 1; return { reply: "unexpected" }; },
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: "/api/chat",
      headers: {
        Authorization: "Bearer synthetic-test-token",
        "X-Forwarded-Proto": "https",
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(result.status, 426);
  assert.equal(JSON.parse(result.body).error.code, "HTTPS_REQUIRED");
  assert.equal(authenticationCalls, 0);
  assert.equal(chatCalls, 0);
});

test("unauthenticated chat is rejected before malformed JSON is parsed", async (t) => {
  const f = await fixture(t);
  const result = await request(f, { body: "{invalid json", rawBody: true });
  assert.equal(result.status, 401);
  assert.equal(JSON.parse(result.body).error.code, "UNAUTHORIZED");
  assert.equal(f.chatCalls, 0);
});

test("chat fails closed when the credential store closes after startup", async (t) => {
  const f = await fixture(t);
  const issued = f.store.issueCredential({
    homeId: "test-home", displayName: "Test Home", capabilities: ["chat"],
  });
  f.store.close();
  const result = await request(f, {
    headers: { Authorization: `Bearer ${issued.bearerCredential}` },
  });
  assert.equal(result.status, 401);
  assert.equal(JSON.parse(result.body).error.code, "UNAUTHORIZED");
  assert.equal(f.chatCalls, 0);
  assert.doesNotMatch(result.body, /sqlite|database|closed|selene_gateway_v1/i);
});
