import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  LOCAL_ADMIN_ACTIONS,
  createLocalAdminCapabilityFromBytes,
  createLocalAdminHandshakeResponse,
  verifyLocalAdminMessage,
  signLocalAdminMessage,
} from "./localAdminProtocol.js";
import {
  PairingAdministrationError,
  createLocalPairingAdministration,
} from "./pairingAdministration.js";
import { createPairingSessionManager } from "./pairingSessionManager.js";
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

function createTrustedPairingControls() {
  const sessionManager = createPairingSessionManager();
  const administration = createLocalPairingAdministration({ sessionManager });
  const controls = Object.freeze({
    getPairingStatus: administration.getPairingStatus,
    startPairing() {
      return Object.freeze({
        ok: true,
        ...sessionManager.createSession(),
      });
    },
    cancelPairing() {
      return Object.freeze({
        ok: true,
        cancelled: sessionManager.cancelSession(),
        status: administration.getPairingStatus(),
      });
    },
  });
  return { administration, controls };
}

function attemptRegistrarForgery() {
  const administration = createLocalPairingAdministration({
    trustedControlRegistrar(controls) {
      throw new Error(`registrar should not receive controls: ${String(controls)}`);
    },
  });
  return administration;
}

async function establishPairingChannel() {
  const { controls, administration } = createTrustedPairingControls();
  const processObject = new FakeProcess();
  const capBytes = bytes(0x11);
  const capability = createLocalAdminCapabilityFromBytes(capBytes);
  const channel = startCoreLocalAdminChildChannel({
    processObject,
    pairingControls: controls,
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
  return { channel, processObject, capability, administration };
}

async function sendAdminRequest({ processObject, capability, action, payload = {}, nonceFill }) {
  const startIndex = processObject.sent.length;
  const request = signLocalAdminMessage(capability, {
    requestId: `request-${nonceFill}`,
    action,
    payload,
    nonce: bytes(nonceFill).toString("base64url"),
    randomBytes: fixedRandom,
  });
  processObject.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "request",
    message: request,
  });
  const response = processObject.sent.slice(startIndex).find((message) => message.kind === "response")
    ?? await new Promise((resolve) => {
      const onSent = (message) => {
        if (message.kind === "response") {
          processObject.off("sent", onSent);
          resolve(message);
        }
      };
      processObject.on("sent", onSent);
    });
  return verifyLocalAdminMessage(capability, response.message);
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

test("public pairing start and cancel remain fail-closed", () => {
  const { administration, controls } = createTrustedPairingControls();
  const forgedAdministration = attemptRegistrarForgery();

  assert.throws(
    () => administration.startPairing(),
    PairingAdministrationError,
  );
  assert.throws(
    () => administration.cancelPairing(),
    PairingAdministrationError,
  );
  assert.equal(typeof controls.startPairing, "function");
  assert.equal(Object.hasOwn(administration, "trustedControls"), false);
  assert.equal(Object.hasOwn(administration, "startPairingTrusted"), false);
  assert.throws(
    () => forgedAdministration.startPairing(),
    PairingAdministrationError,
  );
  assert.equal(Object.hasOwn(forgedAdministration, "trustedControls"), false);
});

test("authenticated pairing status is secret-free", async () => {
  const { processObject, capability } = await establishPairingChannel();

  const status = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    nonceFill: 0x91,
  });

  assert.deepEqual(status.payload, { ok: true, session: null });
  assert.doesNotMatch(JSON.stringify(status.payload), /secret|digest|hmac|capability/i);
});

test("authenticated pairing start returns secret once and status never reveals it", async () => {
  const { processObject, capability } = await establishPairingChannel();

  const started = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    nonceFill: 0x92,
  });
  const pairingSecret = started.payload.pairingSecret;

  assert.equal(started.payload.ok, true);
  assert.match(pairingSecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(started.payload.session.failedAttempts, 0);

  const status = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    nonceFill: 0x93,
  });
  assert.equal(status.payload.session.id, started.payload.session.id);
  assert.doesNotMatch(JSON.stringify(status.payload), new RegExp(pairingSecret));
});

test("second authenticated start replaces the previous pairing session", async () => {
  const { processObject, capability, administration } = await establishPairingChannel();
  const first = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    nonceFill: 0x94,
  });
  const second = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    nonceFill: 0x95,
  });

  assert.notEqual(first.payload.pairingSecret, second.payload.pairingSecret);
  assert.notEqual(first.payload.session.id, second.payload.session.id);
  assert.equal(administration.getPairingStatus().session.id, second.payload.session.id);
});

test("authenticated pairing requests reject unexpected payload fields", async () => {
  const { processObject, capability } = await establishPairingChannel();

  const response = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    payload: { ttlMs: 1 },
    nonceFill: 0x96,
  });

  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error.code, "INVALID_PAYLOAD");
  assert.doesNotMatch(JSON.stringify(response.payload), /[A-Za-z0-9_-]{43}/);
});

test("authenticated cancel invalidates active pairing and stays secret-free", async () => {
  const { processObject, capability, administration } = await establishPairingChannel();
  const started = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    nonceFill: 0x97,
  });
  const cancel = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_CANCEL,
    nonceFill: 0xa1,
  });
  const secondCancel = await sendAdminRequest({
    processObject,
    capability,
    action: LOCAL_ADMIN_ACTIONS.PAIRING_CANCEL,
    nonceFill: 0xa2,
  });

  assert.equal(cancel.payload.ok, true);
  assert.equal(cancel.payload.cancelled, true);
  assert.equal(cancel.payload.status.session, null);
  assert.equal(secondCancel.payload.cancelled, false);
  assert.equal(administration.getPairingStatus().session, null);
  assert.doesNotMatch(JSON.stringify(cancel.payload), new RegExp(started.payload.pairingSecret));
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
