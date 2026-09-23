import {
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export const LOCAL_ADMIN_PROTOCOL_VERSION = 1;
export const LOCAL_ADMIN_CAPABILITY_BYTES = 32;
export const LOCAL_ADMIN_NONCE_BYTES = 32;
export const LOCAL_ADMIN_TAG_BYTES = 32;
export const LOCAL_ADMIN_CHALLENGE_BYTES = 32;

export const LOCAL_ADMIN_ACTIONS = Object.freeze({
  HANDSHAKE_RESPONSE: "admin.hello.response",
  PAIRING_STATUS: "pairing.status",
  PAIRING_START: "pairing.start",
  PAIRING_CANCEL: "pairing.cancel",
});

const HANDSHAKE_TYPE = "admin.hello";
const BASE64URL_32_BYTES_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const capabilityBytes = new WeakMap();
const allowedActions = new Set(Object.values(LOCAL_ADMIN_ACTIONS));

export class LocalAdminProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalAdminProtocolError";
    this.code = code;
  }
}

function protocolError(code, message) {
  return new LocalAdminProtocolError(code, message);
}

function cloneCapabilityBytes(capability) {
  const bytes = capabilityBytes.get(capability);
  if (!bytes) {
    throw protocolError(
      "INVALID_CAPABILITY",
      "Local admin capability is invalid.",
    );
  }
  return Buffer.from(bytes);
}

function parseBase64UrlBytes(value, byteLength, code, label) {
  if (typeof value !== "string" || !BASE64URL_32_BYTES_PATTERN.test(value)) {
    throw protocolError(code, `${label} is malformed.`);
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== byteLength || decoded.toString("base64url") !== value) {
    throw protocolError(code, `${label} is malformed.`);
  }
  return decoded;
}

function encodeBase64UrlBytes(bytes, byteLength, code, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== byteLength) {
    throw protocolError(code, `${label} source is invalid.`);
  }
  return Buffer.from(bytes).toString("base64url");
}

function generateBytes(randomBytes, byteLength, code, label) {
  const value = randomBytes(byteLength);
  if (!Buffer.isBuffer(value) || value.length !== byteLength) {
    throw protocolError(code, `${label} generator returned invalid bytes.`);
  }
  return Buffer.from(value);
}

export function createLocalAdminCapabilityFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== LOCAL_ADMIN_CAPABILITY_BYTES) {
    throw protocolError(
      "INVALID_CAPABILITY_BYTES",
      `Local admin capability must contain ${LOCAL_ADMIN_CAPABILITY_BYTES} bytes.`,
    );
  }

  const capability = Object.freeze({
    byteLength: LOCAL_ADMIN_CAPABILITY_BYTES,
    toString() {
      return "[SeleneLocalAdminCapability]";
    },
    toJSON() {
      return "[redacted]";
    },
  });
  capabilityBytes.set(capability, Buffer.from(bytes));
  return capability;
}

export function generateLocalAdminCapability({
  randomBytes = cryptoRandomBytes,
} = {}) {
  if (typeof randomBytes !== "function") {
    throw protocolError(
      "INVALID_RANDOM_SOURCE",
      "Local admin random source is invalid.",
    );
  }
  return createLocalAdminCapabilityFromBytes(
    generateBytes(
      randomBytes,
      LOCAL_ADMIN_CAPABILITY_BYTES,
      "INVALID_RANDOM_SOURCE",
      "Capability",
    ),
  );
}

function validateRequestId(requestId) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw protocolError(
      "INVALID_REQUEST_ID",
      "Local admin request ID is invalid.",
    );
  }
  return requestId;
}

function validateAction(action) {
  if (typeof action !== "string" || !allowedActions.has(action)) {
    throw protocolError(
      "UNSUPPORTED_ACTION",
      "Local admin action is unsupported.",
    );
  }
  return action;
}

function validateVersion(version) {
  if (version !== LOCAL_ADMIN_PROTOCOL_VERSION) {
    throw protocolError(
      "UNSUPPORTED_VERSION",
      "Local admin protocol version is unsupported.",
    );
  }
  return version;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value, path = "payload") {
  if (value === null) return null;

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw protocolError(
        "INVALID_PAYLOAD",
        "Local admin payload contains an invalid number.",
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`));
  }

  if (!isPlainObject(value)) {
    throw protocolError(
      "INVALID_PAYLOAD",
      "Local admin payload must be JSON-compatible.",
    );
  }

  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (typeof value[key] === "undefined") {
      throw protocolError(
        "INVALID_PAYLOAD",
        "Local admin payload contains an undefined value.",
      );
    }
    normalized[key] = normalizeJsonValue(value[key], `${path}.${key}`);
  }
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeJsonValue(value));
}

function canonicalAuthenticatedMessage({ version, requestId, action, nonce, payload }) {
  return canonicalJson({
    action,
    nonce,
    payload: normalizeJsonValue(payload),
    requestId,
    version,
  });
}

function validatePayload(payload) {
  return normalizeJsonValue(payload ?? {});
}

function validateUnsignedMessageShape(message) {
  if (!isPlainObject(message)) {
    throw protocolError(
      "INVALID_MESSAGE",
      "Local admin message must be an object.",
    );
  }

  const keys = Object.keys(message).sort();
  const expected = ["action", "nonce", "payload", "requestId", "tag", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw protocolError(
      "INVALID_MESSAGE",
      "Local admin message shape is invalid.",
    );
  }

  return Object.freeze({
    version: validateVersion(message.version),
    requestId: validateRequestId(message.requestId),
    action: validateAction(message.action),
    nonce: parseBase64UrlBytes(
      message.nonce,
      LOCAL_ADMIN_NONCE_BYTES,
      "INVALID_NONCE",
      "Local admin nonce",
    ).toString("base64url"),
    payload: validatePayload(message.payload),
    tag: message.tag,
  });
}

function createAuthenticationTag(capability, authenticatedFields) {
  const key = cloneCapabilityBytes(capability);
  try {
    return createHmac("sha256", key)
      .update(canonicalAuthenticatedMessage(authenticatedFields), "utf8")
      .digest();
  } finally {
    key.fill(0);
  }
}

function parseAuthenticationTag(tag) {
  if (typeof tag !== "string" || !BASE64URL_32_BYTES_PATTERN.test(tag)) {
    return null;
  }

  const decoded = Buffer.from(tag, "base64url");
  if (
    decoded.length !== LOCAL_ADMIN_TAG_BYTES
    || decoded.toString("base64url") !== tag
  ) {
    return null;
  }
  return decoded;
}

function verifyAuthenticationTag(capability, message) {
  const receivedTag = parseAuthenticationTag(message.tag);
  if (!receivedTag) {
    throw protocolError(
      "AUTHENTICATION_FAILED",
      "Local admin message authentication failed.",
    );
  }

  const expectedTag = createAuthenticationTag(capability, message);
  if (
    receivedTag.length !== expectedTag.length
    || !timingSafeEqual(receivedTag, expectedTag)
  ) {
    throw protocolError(
      "AUTHENTICATION_FAILED",
      "Local admin message authentication failed.",
    );
  }
}

export function signLocalAdminMessage(capability, {
  requestId,
  action,
  payload = {},
  nonce,
  randomBytes = cryptoRandomBytes,
}) {
  if (typeof randomBytes !== "function") {
    throw protocolError(
      "INVALID_RANDOM_SOURCE",
      "Local admin random source is invalid.",
    );
  }

  const message = {
    version: LOCAL_ADMIN_PROTOCOL_VERSION,
    requestId: validateRequestId(requestId),
    action: validateAction(action),
    nonce: nonce
      ? parseBase64UrlBytes(
        nonce,
        LOCAL_ADMIN_NONCE_BYTES,
        "INVALID_NONCE",
        "Local admin nonce",
      ).toString("base64url")
      : generateBytes(
        randomBytes,
        LOCAL_ADMIN_NONCE_BYTES,
        "INVALID_RANDOM_SOURCE",
        "Nonce",
      ).toString("base64url"),
    payload: validatePayload(payload),
  };

  const tag = createAuthenticationTag(capability, message).toString("base64url");
  return Object.freeze({
    ...message,
    tag,
  });
}

export function createLocalAdminReplayGuard({ maxEntries = 1024 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw protocolError(
      "INVALID_REPLAY_GUARD",
      "Local admin replay guard configuration is invalid.",
    );
  }

  const seenNonces = new Set();
  const order = [];

  function acceptNonce(nonce) {
    if (seenNonces.has(nonce)) {
      throw protocolError(
        "REPLAYED_MESSAGE",
        "Local admin message nonce was already used.",
      );
    }

    seenNonces.add(nonce);
    order.push(nonce);
    while (order.length > maxEntries) {
      seenNonces.delete(order.shift());
    }
  }

  return Object.freeze({
    acceptNonce,
    get size() {
      return seenNonces.size;
    },
  });
}

export function verifyLocalAdminMessage(capability, message, {
  replayGuard,
} = {}) {
  const validated = validateUnsignedMessageShape(message);
  verifyAuthenticationTag(capability, validated);
  if (replayGuard) {
    replayGuard.acceptNonce(validated.nonce);
  }
  return Object.freeze({
    version: validated.version,
    requestId: validated.requestId,
    action: validated.action,
    nonce: validated.nonce,
    payload: validated.payload,
  });
}

export function createLocalAdminHandshakeChallenge({
  randomBytes = cryptoRandomBytes,
} = {}) {
  if (typeof randomBytes !== "function") {
    throw protocolError(
      "INVALID_RANDOM_SOURCE",
      "Local admin random source is invalid.",
    );
  }

  return Object.freeze({
    version: LOCAL_ADMIN_PROTOCOL_VERSION,
    type: HANDSHAKE_TYPE,
    challenge: generateBytes(
      randomBytes,
      LOCAL_ADMIN_CHALLENGE_BYTES,
      "INVALID_RANDOM_SOURCE",
      "Handshake challenge",
    ).toString("base64url"),
  });
}

function validateHandshakeChallenge(challenge) {
  if (!isPlainObject(challenge)) {
    throw protocolError(
      "INVALID_HANDSHAKE",
      "Local admin handshake challenge is invalid.",
    );
  }

  const keys = Object.keys(challenge).sort();
  const expected = ["challenge", "type", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw protocolError(
      "INVALID_HANDSHAKE",
      "Local admin handshake challenge shape is invalid.",
    );
  }

  validateVersion(challenge.version);
  if (challenge.type !== HANDSHAKE_TYPE) {
    throw protocolError(
      "INVALID_HANDSHAKE",
      "Local admin handshake challenge type is invalid.",
    );
  }

  return Object.freeze({
    version: challenge.version,
    type: challenge.type,
    challenge: parseBase64UrlBytes(
      challenge.challenge,
      LOCAL_ADMIN_CHALLENGE_BYTES,
      "INVALID_HANDSHAKE",
      "Local admin handshake challenge",
    ).toString("base64url"),
  });
}

export function createLocalAdminHandshakeResponse(capability, challenge, {
  requestId,
  randomBytes = cryptoRandomBytes,
} = {}) {
  const validatedChallenge = validateHandshakeChallenge(challenge);
  return signLocalAdminMessage(capability, {
    requestId,
    action: LOCAL_ADMIN_ACTIONS.HANDSHAKE_RESPONSE,
    payload: {
      challenge: validatedChallenge.challenge,
    },
    randomBytes,
  });
}

export function verifyLocalAdminHandshakeResponse(capability, challenge, response, {
  replayGuard,
} = {}) {
  const validatedChallenge = validateHandshakeChallenge(challenge);
  const verified = verifyLocalAdminMessage(capability, response, { replayGuard });

  if (
    verified.action !== LOCAL_ADMIN_ACTIONS.HANDSHAKE_RESPONSE
    || !isPlainObject(verified.payload)
    || verified.payload.challenge !== validatedChallenge.challenge
    || Object.keys(verified.payload).length !== 1
  ) {
    throw protocolError(
      "AUTHENTICATION_FAILED",
      "Local admin handshake authentication failed.",
    );
  }

  return Object.freeze({
    version: verified.version,
    requestId: verified.requestId,
    action: verified.action,
    nonce: verified.nonce,
  });
}
