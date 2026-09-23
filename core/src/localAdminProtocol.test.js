import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_ADMIN_ACTIONS,
  LOCAL_ADMIN_CAPABILITY_BYTES,
  LOCAL_ADMIN_PROTOCOL_VERSION,
  LocalAdminProtocolError,
  createLocalAdminCapabilityFromBytes,
  createLocalAdminHandshakeChallenge,
  createLocalAdminHandshakeResponse,
  createLocalAdminReplayGuard,
  generateLocalAdminCapability,
  signLocalAdminMessage,
  verifyLocalAdminHandshakeResponse,
  verifyLocalAdminMessage,
} from "./localAdminProtocol.js";

function bytes(fill, length = LOCAL_ADMIN_CAPABILITY_BYTES) {
  return Buffer.alloc(length, fill);
}

function capability(fill = 0x11) {
  return createLocalAdminCapabilityFromBytes(bytes(fill));
}

function randomSequence(...buffers) {
  let index = 0;
  return (size) => {
    const value = buffers[index++];
    assert.ok(value, "Test random source exhausted.");
    assert.equal(value.length, size);
    return Buffer.from(value);
  };
}

function fixedNonce(fill = 0x22) {
  return bytes(fill).toString("base64url");
}

function fixedChallenge(fill = 0x33) {
  return bytes(fill).toString("base64url");
}

function message(overrides = {}) {
  return signLocalAdminMessage(capability(), {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: { nested: { b: 2, a: 1 }, ok: true },
    nonce: fixedNonce(),
    ...overrides,
  });
}

function assertProtocolError(operation, code) {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof LocalAdminProtocolError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /[A-Za-z0-9_-]{32,}/);
    assert.doesNotMatch(error.message, /secret|capability bytes|hmac|digest/i);
    return error;
  }
  assert.fail(`Expected LocalAdminProtocolError ${code}.`);
}

test("capability generation has the required entropy length and safe representation", () => {
  const generated = generateLocalAdminCapability({
    randomBytes: randomSequence(bytes(0xab)),
  });

  assert.equal(generated.byteLength, LOCAL_ADMIN_CAPABILITY_BYTES);
  assert.equal(String(generated), "[SeleneLocalAdminCapability]");
  assert.equal(JSON.stringify(generated), "\"[redacted]\"");
  assert.doesNotMatch(JSON.stringify(generated), /q6ur|abab|[A-Za-z0-9_-]{43}/);
});

test("valid authenticated message verifies and omits capability material", () => {
  const cap = capability();
  const signed = signLocalAdminMessage(cap, {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    payload: { approved: true },
    nonce: fixedNonce(),
  });

  assert.deepEqual(verifyLocalAdminMessage(cap, signed), {
    version: LOCAL_ADMIN_PROTOCOL_VERSION,
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_START,
    nonce: fixedNonce(),
    payload: { approved: true },
  });
  assert.equal(Object.hasOwn(signed, "capability"), false);
  assert.doesNotMatch(
    JSON.stringify(signed),
    new RegExp(bytes(0x11).toString("base64url")),
  );
});

test("wrong capability fails authentication", () => {
  const signed = message();
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(0x99), signed),
    "AUTHENTICATION_FAILED",
  );
});

test("mutating authenticated fields fails authentication", () => {
  const signed = message();
  const mutations = [
    { version: LOCAL_ADMIN_PROTOCOL_VERSION + 1, code: "UNSUPPORTED_VERSION" },
    { requestId: "request-2", code: "AUTHENTICATION_FAILED" },
    { action: LOCAL_ADMIN_ACTIONS.PAIRING_CANCEL, code: "AUTHENTICATION_FAILED" },
    { nonce: bytes(0x44).toString("base64url"), code: "AUTHENTICATION_FAILED" },
    { payload: { nested: { a: 1, b: 3 }, ok: true }, code: "AUTHENTICATION_FAILED" },
    { tag: bytes(0x55).toString("base64url"), code: "AUTHENTICATION_FAILED" },
  ];

  for (const mutation of mutations) {
    const { code, ...fields } = mutation;
    const mutated = { ...signed, ...fields };
    assertProtocolError(
      () => verifyLocalAdminMessage(capability(), mutated),
      code,
    );
  }
});

test("missing or malformed authentication fails safely", () => {
  const signed = message();
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, tag: undefined }),
    "AUTHENTICATION_FAILED",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, tag: "short" }),
    "AUTHENTICATION_FAILED",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, tag: `${signed.tag}a` }),
    "AUTHENTICATION_FAILED",
  );
});

test("unsupported protocol version, action, and malformed shapes fail closed", () => {
  const signed = message();
  assertProtocolError(
    () => signLocalAdminMessage(capability(), {
      requestId: "request-1",
      action: "authority.elevate",
      payload: {},
      nonce: fixedNonce(),
    }),
    "UNSUPPORTED_ACTION",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, action: "authority.elevate" }),
    "UNSUPPORTED_ACTION",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, version: 99 }),
    "UNSUPPORTED_VERSION",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), null),
    "INVALID_MESSAGE",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, extra: true }),
    "INVALID_MESSAGE",
  );
  assertProtocolError(
    () => verifyLocalAdminMessage(capability(), { ...signed, requestId: "../bad" }),
    "INVALID_REQUEST_ID",
  );
  assertProtocolError(
    () => signLocalAdminMessage(capability(), {
      requestId: "request-1",
      action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
      payload: { bad: undefined },
      nonce: fixedNonce(),
    }),
    "INVALID_PAYLOAD",
  );
});

test("canonicalization produces stable authentication for equivalent payloads", () => {
  const cap = capability();
  const first = signLocalAdminMessage(cap, {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: { b: 2, a: { d: 4, c: 3 } },
    nonce: fixedNonce(),
  });
  const second = signLocalAdminMessage(cap, {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: { a: { c: 3, d: 4 }, b: 2 },
    nonce: fixedNonce(),
  });

  assert.equal(first.tag, second.tag);
  assert.deepEqual(verifyLocalAdminMessage(cap, first).payload, {
    a: { c: 3, d: 4 },
    b: 2,
  });
});

test("replay guard rejects nonce reuse after a valid message", () => {
  const cap = capability();
  const guard = createLocalAdminReplayGuard({ maxEntries: 2 });
  const signed = message();

  assert.equal(verifyLocalAdminMessage(cap, signed, { replayGuard: guard }).nonce, fixedNonce());
  assert.equal(guard.size, 1);
  assertProtocolError(
    () => verifyLocalAdminMessage(cap, signed, { replayGuard: guard }),
    "REPLAYED_MESSAGE",
  );

  verifyLocalAdminMessage(cap, message({
    requestId: "request-2",
    nonce: bytes(0x23).toString("base64url"),
  }), { replayGuard: guard });
  verifyLocalAdminMessage(cap, message({
    requestId: "request-3",
    nonce: bytes(0x24).toString("base64url"),
  }), { replayGuard: guard });
  assert.equal(guard.size, 2);
});

test("handshake challenge and response succeed with the correct capability", () => {
  const cap = capability();
  const challenge = createLocalAdminHandshakeChallenge({
    randomBytes: randomSequence(bytes(0x33)),
  });
  const response = createLocalAdminHandshakeResponse(cap, challenge, {
    requestId: "handshake-1",
    randomBytes: randomSequence(bytes(0x44)),
  });

  assert.deepEqual(challenge, {
    version: LOCAL_ADMIN_PROTOCOL_VERSION,
    type: "admin.hello",
    challenge: fixedChallenge(),
  });
  assert.deepEqual(verifyLocalAdminHandshakeResponse(cap, challenge, response), {
    version: LOCAL_ADMIN_PROTOCOL_VERSION,
    requestId: "handshake-1",
    action: LOCAL_ADMIN_ACTIONS.HANDSHAKE_RESPONSE,
    nonce: bytes(0x44).toString("base64url"),
  });
});

test("handshake response fails with wrong capability", () => {
  const challenge = createLocalAdminHandshakeChallenge({
    randomBytes: randomSequence(bytes(0x33)),
  });
  const response = createLocalAdminHandshakeResponse(capability(), challenge, {
    requestId: "handshake-1",
    randomBytes: randomSequence(bytes(0x44)),
  });

  assertProtocolError(
    () => verifyLocalAdminHandshakeResponse(capability(0x77), challenge, response),
    "AUTHENTICATION_FAILED",
  );
});

test("reusing or mutating a handshake challenge cannot authenticate as fresh", () => {
  const cap = capability();
  const guard = createLocalAdminReplayGuard();
  const challenge = createLocalAdminHandshakeChallenge({
    randomBytes: randomSequence(bytes(0x33)),
  });
  const response = createLocalAdminHandshakeResponse(cap, challenge, {
    requestId: "handshake-1",
    randomBytes: randomSequence(bytes(0x44)),
  });

  assert.equal(
    verifyLocalAdminHandshakeResponse(cap, challenge, response, { replayGuard: guard }).requestId,
    "handshake-1",
  );
  assertProtocolError(
    () => verifyLocalAdminHandshakeResponse(cap, challenge, response, { replayGuard: guard }),
    "REPLAYED_MESSAGE",
  );
  assertProtocolError(
    () => verifyLocalAdminHandshakeResponse(
      cap,
      { ...challenge, challenge: bytes(0x34).toString("base64url") },
      response,
    ),
    "AUTHENTICATION_FAILED",
  );
});

test("malformed handshake messages fail closed", () => {
  const cap = capability();
  const challenge = createLocalAdminHandshakeChallenge({
    randomBytes: randomSequence(bytes(0x33)),
  });
  const response = createLocalAdminHandshakeResponse(cap, challenge, {
    requestId: "handshake-1",
    randomBytes: randomSequence(bytes(0x44)),
  });

  for (const badChallenge of [
    { challenge: null, code: "INVALID_HANDSHAKE" },
    { challenge: { ...challenge, type: "bad" }, code: "INVALID_HANDSHAKE" },
    { challenge: { ...challenge, version: 2 }, code: "UNSUPPORTED_VERSION" },
    { challenge: { ...challenge, challenge: "short" }, code: "INVALID_HANDSHAKE" },
    { challenge: { ...challenge, extra: true }, code: "INVALID_HANDSHAKE" },
  ]) {
    assertProtocolError(
      () => verifyLocalAdminHandshakeResponse(cap, badChallenge.challenge, response),
      badChallenge.code,
    );
  }

  assertProtocolError(
    () => verifyLocalAdminHandshakeResponse(
      cap,
      challenge,
      signLocalAdminMessage(cap, {
        requestId: "not-handshake",
        action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
        payload: { challenge: challenge.challenge },
        nonce: fixedNonce(),
      }),
    ),
    "AUTHENTICATION_FAILED",
  );
});

test("ordinary thrown errors do not include sensitive key or tag material", () => {
  const cap = capability(0x5a);
  const signed = signLocalAdminMessage(cap, {
    requestId: "request-1",
    action: LOCAL_ADMIN_ACTIONS.PAIRING_STATUS,
    payload: {},
    nonce: fixedNonce(),
  });
  const secretText = bytes(0x5a).toString("base64url");

  const error = assertProtocolError(
    () => verifyLocalAdminMessage(capability(0x5b), signed),
    "AUTHENTICATION_FAILED",
  );
  assert.doesNotMatch(error.stack, new RegExp(secretText));
  assert.doesNotMatch(error.stack, new RegExp(signed.tag));
});
