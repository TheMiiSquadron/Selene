import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  LOCAL_ADMIN_ACTIONS,
  createLocalAdminCapabilityFromBytes,
  createLocalAdminHandshakeResponse,
  signLocalAdminMessage,
} from "./localAdminProtocol.js";
import {
  LOCAL_ADMIN_CHANNEL_NAME,
  OWNED_CORE_ADMIN_IPC_ARG,
  startCoreLocalAdminChildChannel,
} from "./localAdminChannel.js";

function bytes(fill) {
  return Buffer.alloc(32, fill);
}

function fixedRandom() {
  return bytes(0x44);
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.argv = ["node", "server.js", OWNED_CORE_ADMIN_IPC_ARG];
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
    this.emit("sent", message);
    return true;
  }

  waitForSent(kind) {
    const existing = this.sent.find((message) => message.kind === kind);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const onSent = (message) => {
        if (message.kind === kind) {
          this.off("sent", onSent);
          resolve(message);
        }
      };
      this.on("sent", onSent);
    });
  }
}

function streamFrom(text) {
  return () => Readable.from([text]);
}

async function establishChannel({ capBytes = bytes(0x11), processObject = new FakeProcess() } = {}) {
  const capability = createLocalAdminCapabilityFromBytes(capBytes);
  const channel = startCoreLocalAdminChildChannel({
    processObject,
    createReadStream: streamFrom(`${capBytes.toString("base64url")}\n`),
    bootstrapTimeoutMs: 50,
    handshakeTimeoutMs: 50,
    randomBytes: fixedRandom,
  });
  const challenge = await processObject.waitForSent("handshake-challenge");
  const response = createLocalAdminHandshakeResponse(capability, challenge.challenge, {
    requestId: "handshake-1",
    randomBytes: fixedRandom,
  });
  processObject.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "handshake-response",
    message: response,
  });
  await channel.ready;
  return { channel, processObject, capability, challenge };
}

test("manual Core startup has no local admin channel", async () => {
  const channel = startCoreLocalAdminChildChannel({
    argv: ["node", "server.js"],
    processObject: new FakeProcess(),
  });

  assert.equal(channel.getStatus().state, "unavailable");
  assert.equal(await channel.ready, null);
});

test("owned child authenticates after bootstrap and handshake", async () => {
  const { channel, processObject } = await establishChannel();

  assert.equal(channel.getStatus().state, "ready");
  assert.equal(processObject.sent[0].kind, "handshake-challenge");
  assert.equal(processObject.sent[1].kind, "handshake-confirm");
  assert.equal(JSON.stringify(processObject.sent), JSON.stringify(processObject.sent));
  assert.doesNotMatch(JSON.stringify(processObject.sent), new RegExp(bytes(0x11).toString("base64url")));
});

test("missing or malformed bootstrap fails closed", async () => {
  const processObject = new FakeProcess();
  const channel = startCoreLocalAdminChildChannel({
    processObject,
    createReadStream: streamFrom("not-a-capability"),
    bootstrapTimeoutMs: 50,
    handshakeTimeoutMs: 50,
  });

  await assert.rejects(channel.ready, /bootstrap/i);
  assert.equal(channel.getStatus().state, "failed");
  assert.equal(processObject.sent.length, 0);
});

test("wrong capability and mutated handshake response fail closed", async () => {
  const processObject = new FakeProcess();
  const capBytes = bytes(0x11);
  const wrongCapability = createLocalAdminCapabilityFromBytes(bytes(0x22));
  const channel = startCoreLocalAdminChildChannel({
    processObject,
    createReadStream: streamFrom(`${capBytes.toString("base64url")}\n`),
    bootstrapTimeoutMs: 50,
    handshakeTimeoutMs: 50,
    randomBytes: fixedRandom,
  });
  const challenge = await processObject.waitForSent("handshake-challenge");
  const response = createLocalAdminHandshakeResponse(wrongCapability, challenge.challenge, {
    requestId: "handshake-1",
    randomBytes: fixedRandom,
  });
  processObject.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "handshake-response",
    message: response,
  });

  await assert.rejects(channel.ready, /authentication/i);
  assert.equal(channel.getStatus().state, "failed");
});

test("handshake timeout fails closed before channel is ready", async () => {
  const processObject = new FakeProcess();
  const channel = startCoreLocalAdminChildChannel({
    processObject,
    createReadStream: streamFrom(`${bytes(0x11).toString("base64url")}\n`),
    bootstrapTimeoutMs: 50,
    handshakeTimeoutMs: 5,
    randomBytes: fixedRandom,
  });
  await processObject.waitForSent("handshake-challenge");

  assert.equal(channel.getStatus().state, "authenticating");
  await assert.rejects(channel.ready, /handshake/i);
  assert.equal(channel.getStatus().state, "failed");
});

test("authenticated post-handshake request receives unavailable response without invoking pairing", async () => {
  const { channel, processObject, capability } = await establishChannel();
  const request = signLocalAdminMessage(capability, {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: {},
    nonce: bytes(0x99).toString("base64url"),
    randomBytes: fixedRandom,
  });

  processObject.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "request",
    message: request,
  });

  const response = await processObject.waitForSent("response");
  assert.equal(channel.getStatus().state, "ready");
  assert.equal(response.message.requestId, "request-1");
  assert.equal(response.message.action, LOCAL_ADMIN_ACTIONS.PAIRING_STATUS);
  assert.equal(response.message.payload.error.code, "LOCAL_ADMIN_ACTION_UNAVAILABLE");
});

test("unauthenticated, malformed and replayed messages fail closed", async () => {
  const { channel, processObject, capability } = await establishChannel();
  const request = signLocalAdminMessage(capability, {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: {},
    nonce: bytes(0x98).toString("base64url"),
    randomBytes: fixedRandom,
  });

  processObject.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "request",
    message: { ...request, payload: { changed: true } },
  });

  assert.equal(channel.getStatus().state, "failed");

  const second = await establishChannel({ capBytes: bytes(0x33) });
  second.processObject.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "request",
    message: request,
  });
  assert.equal(second.channel.getStatus().state, "failed");
});

test("ipc disconnect closes authenticated channel", async () => {
  const { channel, processObject } = await establishChannel();

  processObject.emit("disconnect");

  assert.equal(channel.getStatus().state, "failed");
});
