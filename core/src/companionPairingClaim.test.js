import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createCompanionServer } from "./companionServer.js";

const TEST_BEARER =
  "selene_gateway_v1.00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SENSITIVE_PATTERN = /selene_gateway_v1|pairing-secret|sqlite|digest|private|bearer/i;

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
  const names = seq(
    der(0x82, Buffer.from("localhost")),
    der(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = der(0xa3, seq(seq(oid(0x55, 0x1d, 0x11), der(0x04, names))));
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

async function listen(t, server) {
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return port;
}

async function fixture(t, options = {}) {
  const tlsOptions = testCertificate();
  const pairingCalls = [];
  let chatCalls = 0;
  const pairingClaimService = Object.hasOwn(options, "pairingClaimService")
    ? options.pairingClaimService
    : {
        claim(payload) {
          pairingCalls.push(payload);
          return { paired: true, credential: TEST_BEARER };
        },
      };
  const server = createCompanionServer({
    tlsOptions,
    pairingClaimService,
    credentialStore: options.credentialStore ?? {
      authenticateCredential(value) {
        if (value !== TEST_BEARER) throw new Error("invalid");
        return { capabilities: ["chat"] };
      },
    },
    async chatHandler() {
      chatCalls += 1;
      return { ok: true, reply: "chat", state: "idle", events: [] };
    },
  });
  const port = await listen(t, server);
  return {
    port,
    cert: tlsOptions.cert,
    pairingCalls,
    get chatCalls() { return chatCalls; },
  };
}

function request(f, {
  method = "POST",
  path = "/api/pairing/claim",
  headers = { "Content-Type": "application/json" },
  body = { secret: "pairing-secret", deviceName: "iPhone" },
  rawBody = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : rawBody ? body : JSON.stringify(body);
    const req = https.request({
      host: "127.0.0.1",
      servername: "localhost",
      port: f.port,
      method,
      path,
      ca: f.cert,
      headers: Array.isArray(headers) ? headers : {
        ...headers,
        ...(data !== null ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (response) => {
      let result = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { result += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: result,
      }));
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

test("pairing claim route requires HTTPS and never falls back to plaintext", async (t) => {
  let claimCalls = 0;
  const server = createCompanionServer({
    pairingClaimService: {
      claim() {
        claimCalls += 1;
        return { paired: true, credential: TEST_BEARER };
      },
    },
  });
  const port = await listen(t, server);
  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ secret: "pairing-secret", deviceName: "iPhone" });
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/pairing/claim",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody,
      }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  assert.equal(result.status, 426);
  assert.equal(JSON.parse(result.body).error.code, "HTTPS_REQUIRED");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(claimCalls, 0);
});

test("valid HTTPS pairing claim returns exactly one direct bearer response with no-store", async (t) => {
  const f = await fixture(t);
  const result = await request(f);
  assert.equal(result.status, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(result.body), {
    paired: true,
    credential: TEST_BEARER,
  });
  assert.deepEqual(f.pairingCalls, [{
    secret: "pairing-secret",
    deviceName: "iPhone",
  }]);
});

test("pairing claim enforces content type, JSON shape, method and unavailable service", async (t) => {
  const f = await fixture(t, { pairingClaimService: null });

  const wrongMethod = await request(f, { method: "GET", body: null });
  assert.equal(wrongMethod.status, 405);
  assert.equal(JSON.parse(wrongMethod.body).error.code, "METHOD_NOT_ALLOWED");
  assert.equal(wrongMethod.headers["cache-control"], "no-store");

  const unsupported = await request(f, {
    headers: { "Content-Type": "text/plain" },
    body: "hello",
    rawBody: true,
  });
  assert.equal(unsupported.status, 415);
  assert.equal(JSON.parse(unsupported.body).error.code, "UNSUPPORTED_CONTENT_TYPE");
  assert.equal(unsupported.headers["cache-control"], "no-store");

  const malformed = await request(f, { body: "{", rawBody: true });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.body).error.code, "INVALID_REQUEST");
  assert.equal(malformed.headers["cache-control"], "no-store");

  const unavailable = await request(f);
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.parse(unavailable.body).error.code, "PAIRING_UNAVAILABLE");
  assert.equal(unavailable.headers["cache-control"], "no-store");
  assert.doesNotMatch(unavailable.body, SENSITIVE_PATTERN);
});

test("pairing claim maps service failures to sanitized external errors", async (t) => {
  for (const [code, status] of [
    ["INVALID_REQUEST", 400],
    ["PAIRING_FAILED", 401],
    ["PAIRING_UNAVAILABLE", 503],
    ["PRIVATE_INTERNAL", 500],
  ]) {
    const f = await fixture(t, {
      pairingClaimService: {
        claim() {
          const error = new Error("private sqlite secret details");
          error.code = code;
          throw error;
        },
      },
    });
    const result = await request(f);
    assert.equal(result.status, status);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.doesNotMatch(result.body, SENSITIVE_PATTERN);
  }
});

test("/api/chat remains independently authenticated and /health remains anonymous", async (t) => {
  const f = await fixture(t);
  const health = await request(f, { method: "GET", path: "/health", body: null });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { ok: true });

  const chatWithoutBearer = await request(f, {
    path: "/api/chat",
    body: { message: "Hello" },
  });
  assert.equal(chatWithoutBearer.status, 401);
  assert.equal(f.chatCalls, 0);

  const chatWithBearer = await request(f, {
    path: "/api/chat",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_BEARER}`,
    },
    body: { message: "Hello" },
  });
  assert.equal(chatWithBearer.status, 200);
  assert.equal(f.chatCalls, 1);
});
