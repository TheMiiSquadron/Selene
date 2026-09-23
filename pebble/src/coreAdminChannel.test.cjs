const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const { Writable } = require("node:stream");
const {
  LOCAL_ADMIN_CHANNEL_NAME,
  createCoreAdminChannel,
} = require("./coreAdminChannel.cjs");

function bytes(fill) {
  return Buffer.alloc(32, fill);
}

function sequenceRandom(...values) {
  let index = 0;
  return (size) => {
    const value = values[index++] ?? bytes(0x7a);
    assert.equal(value.length, size);
    return Buffer.from(value);
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.bootstrapText = "";
    this.stdio = [];
    this.stdio[3] = new Writable({
      write: (chunk, _encoding, callback) => {
        this.bootstrapText += chunk.toString("utf8");
        callback();
      },
    });
  }

  send(message) {
    this.sent.push(message);
    this.emit("child-message", message);
    return true;
  }

  waitForChildMessage(kind, { afterIndex = 0 } = {}) {
    const existing = this.sent.slice(afterIndex).find((message) => message.kind === kind);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const onMessage = (message) => {
        if (message.kind === kind) {
          this.off("child-message", onMessage);
          resolve(message);
        }
      };
      this.on("child-message", onMessage);
    });
  }

  waitForBootstrap() {
    if (this.stdio[3].writableEnded) return Promise.resolve(this.bootstrapText.trim());
    return new Promise((resolve) => {
      this.stdio[3].once("finish", () => resolve(this.bootstrapText.trim()));
    });
  }
}

async function establishChannel({
  child = new FakeChild(),
  capabilityBytes = bytes(0x11),
  protocol,
  mutateConfirmation = null,
} = {}) {
  const channel = createCoreAdminChannel({
    child,
    protocolModule: protocol,
    randomBytes: sequenceRandom(capabilityBytes, bytes(0x22), bytes(0x33), bytes(0x44)),
    handshakeTimeoutMs: 50,
    requestTimeoutMs: 50,
  });

  const bootstrapText = await child.waitForBootstrap();
  assert.equal(bootstrapText, capabilityBytes.toString("base64url"));
  const capability = protocol.createLocalAdminCapabilityFromBytes(Buffer.from(bootstrapText, "base64url"));
  const challenge = protocol.createLocalAdminHandshakeChallenge({
    randomBytes: sequenceRandom(bytes(0x55)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "handshake-challenge",
    challenge,
  });
  const response = await child.waitForChildMessage("handshake-response");
  protocol.verifyLocalAdminHandshakeResponse(capability, challenge, response.message);
  const confirmation = protocol.createLocalAdminHandshakeConfirmation(capability, challenge, {
    requestId: response.message.requestId,
    randomBytes: sequenceRandom(bytes(0x66)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "handshake-confirm",
    message: mutateConfirmation ? mutateConfirmation(confirmation) : confirmation,
  });

  await channel.ready;
  return { channel, child, capability, protocol };
}

test("pebble-owned admin channel bootstraps capability over fd 3 and reaches ready after confirmation", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const { channel, child } = await establishChannel({ protocol });

  assert.equal(channel.getStatus().state, "ready");
  assert.equal(channel.getStatus().ready, true);
  assert.equal(child.sent[0].kind, "handshake-response");
  assert.doesNotMatch(JSON.stringify(child.sent), new RegExp(bytes(0x11).toString("base64url")));
  assert.doesNotMatch(JSON.stringify(channel.getStatus()), new RegExp(bytes(0x11).toString("base64url")));
});

test("missing bootstrap stream fails closed", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const child = new FakeChild();
  child.stdio[3] = null;
  const channel = createCoreAdminChannel({
    child,
    protocolModule: protocol,
    randomBytes: sequenceRandom(bytes(0x11)),
    handshakeTimeoutMs: 10,
  });

  await assert.rejects(channel.ready, /bootstrap/i);
  assert.equal(channel.getStatus().state, "failed");
});

test("handshake timeout and mutated confirmation fail closed", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const timeoutChild = new FakeChild();
  const timeoutChannel = createCoreAdminChannel({
    child: timeoutChild,
    protocolModule: protocol,
    randomBytes: sequenceRandom(bytes(0x11)),
    handshakeTimeoutMs: 5,
  });
  await timeoutChild.waitForBootstrap();
  await assert.rejects(timeoutChannel.ready, /handshake/i);
  assert.equal(timeoutChannel.getStatus().state, "failed");

  const mutated = establishChannel({
    protocol,
    mutateConfirmation: (confirmation) => ({
      ...confirmation,
      payload: { ...confirmation.payload, ready: false },
    }),
  });
  await assert.rejects(mutated, /authentication|confirmation/i);
});

test("authenticated request correlates response without invoking pairing", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const { channel, child, capability } = await establishChannel({ protocol });

  const requestPromise = channel.sendRequest(protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS, {});
  const request = await child.waitForChildMessage("request");
  const verified = protocol.verifyLocalAdminMessage(capability, request.message);
  assert.equal(verified.action, protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS);

  const response = protocol.signLocalAdminMessage(capability, {
    requestId: verified.requestId,
    action: verified.action,
    payload: {
      ok: false,
      error: { code: "LOCAL_ADMIN_ACTION_UNAVAILABLE" },
    },
    randomBytes: sequenceRandom(bytes(0x77)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: response,
  });

  const result = await requestPromise;
  assert.equal(result.requestId, verified.requestId);
  assert.equal(result.payload.error.code, "LOCAL_ADMIN_ACTION_UNAVAILABLE");
});

test("pairing helper methods send narrow authenticated requests and do not cache secrets in status", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const { channel, child, capability } = await establishChannel({ protocol });

  let sentIndex = child.sent.length;
  const startPromise = channel.startPairing();
  const startRequest = await child.waitForChildMessage("request", { afterIndex: sentIndex });
  const verifiedStart = protocol.verifyLocalAdminMessage(capability, startRequest.message);
  assert.equal(verifiedStart.action, protocol.LOCAL_ADMIN_ACTIONS.PAIRING_START);
  assert.deepEqual(verifiedStart.payload, {});

  const pairingSecret = "A".repeat(43);
  const startResponse = protocol.signLocalAdminMessage(capability, {
    requestId: verifiedStart.requestId,
    action: verifiedStart.action,
    payload: {
      ok: true,
      pairingSecret,
      session: { id: "pairing-1", expiresAt: "2026-09-23T00:05:00.000Z" },
    },
    randomBytes: sequenceRandom(bytes(0x90)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: startResponse,
  });

  assert.equal((await startPromise).payload.pairingSecret, pairingSecret);
  assert.doesNotMatch(JSON.stringify(channel.getStatus()), new RegExp(pairingSecret));

  sentIndex = child.sent.length;
  const statusPromise = channel.getPairingStatus();
  const statusRequest = await child.waitForChildMessage("request", { afterIndex: sentIndex });
  const verifiedStatus = protocol.verifyLocalAdminMessage(capability, statusRequest.message);
  assert.equal(verifiedStatus.action, protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS);
  const statusResponse = protocol.signLocalAdminMessage(capability, {
    requestId: verifiedStatus.requestId,
    action: verifiedStatus.action,
    payload: { ok: true, session: null },
    randomBytes: sequenceRandom(bytes(0x91)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: statusResponse,
  });
  assert.equal((await statusPromise).payload.session, null);

  sentIndex = child.sent.length;
  const cancelPromise = channel.cancelPairing();
  const cancelRequest = await child.waitForChildMessage("request", { afterIndex: sentIndex });
  const verifiedCancel = protocol.verifyLocalAdminMessage(capability, cancelRequest.message);
  assert.equal(verifiedCancel.action, protocol.LOCAL_ADMIN_ACTIONS.PAIRING_CANCEL);
  assert.deepEqual(verifiedCancel.payload, {});
  const cancelResponse = protocol.signLocalAdminMessage(capability, {
    requestId: verifiedCancel.requestId,
    action: verifiedCancel.action,
    payload: { ok: true, cancelled: true, status: { ok: true, session: null } },
    randomBytes: sequenceRandom(bytes(0x92)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: cancelResponse,
  });
  assert.equal((await cancelPromise).payload.cancelled, true);
});

test("pairing helpers fail before ready and after close", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const child = new FakeChild();
  const channel = createCoreAdminChannel({
    child,
    protocolModule: protocol,
    randomBytes: sequenceRandom(bytes(0x11)),
    handshakeTimeoutMs: 50,
  });

  await assert.rejects(channel.startPairing(), /not ready/i);
  channel.close();
  await assert.rejects(channel.cancelPairing(), /not ready/i);
});

test("wrong or replayed responses fail closed, unknown responses are ignored safely", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const { channel, child, capability } = await establishChannel({ protocol });
  const requestPromise = channel.sendRequest(protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS, {});
  const request = await child.waitForChildMessage("request");
  const verified = protocol.verifyLocalAdminMessage(capability, request.message);

  const unknown = protocol.signLocalAdminMessage(capability, {
    requestId: "unknown-response",
    action: protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: {},
    randomBytes: sequenceRandom(bytes(0x88)),
  });
  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: unknown,
  });
  assert.equal(channel.getStatus().state, "ready");

  child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: { ...unknown, requestId: verified.requestId },
  });
  assert.equal(channel.getStatus().state, "failed");
  await assert.rejects(requestPromise, /authentication|replayed|failed/i);
});

test("request timeout cleans pending state and child exit rejects pending requests", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const first = await establishChannel({ protocol });
  await assert.rejects(
    first.channel.sendRequest(protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS, {}),
    /timed out/i,
  );
  assert.equal(first.channel.getStatus().pendingRequests, 0);

  const second = await establishChannel({ protocol });
  const pending = second.channel.sendRequest(protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS, {});
  await second.child.waitForChildMessage("request");
  second.child.emit("exit", 1, null);
  await assert.rejects(pending, /exited/i);
  assert.equal(second.channel.getStatus().state, "failed");
});

test("restart uses a new capability and old messages cannot authenticate", async () => {
  const protocol = await import("../../core/src/localAdminProtocol.js");
  const first = await establishChannel({ protocol, capabilityBytes: bytes(0x11) });
  const firstRequest = first.channel.sendRequest(protocol.LOCAL_ADMIN_ACTIONS.PAIRING_STATUS, {});
  const oldRequest = await first.child.waitForChildMessage("request");
  first.channel.close();
  await assert.rejects(firstRequest, /closed/i);

  const second = await establishChannel({ protocol, capabilityBytes: bytes(0x22) });
  second.child.emit("message", {
    channel: LOCAL_ADMIN_CHANNEL_NAME,
    kind: "response",
    message: oldRequest.message,
  });
  assert.equal(second.channel.getStatus().state, "failed");
});
