import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { prepareRuntime, readHiddenSecret, claimPairing, validatorSession, main, CA_PATH, ORIGIN } from "./m46PairingClient.js";

const secret = Buffer.alloc(32, 7).toString("base64url");
const credential = `selene_gateway_v1.12345678-1234-4234-8234-123456789abc.${Buffer.alloc(32, 9).toString("base64url")}`;
const ca = Buffer.from("mock-ca");
function output() { return { isTTY: true, text: "", write(text) { this.text += text; } }; }
function fakeRequest({ status = 200, headers = { "content-type": "application/json", "cache-control": "no-store" },
  body = JSON.stringify({ paired: true, credential }), error = false, aborted = false } = {}) {
  const calls = [];
  function request(url, options, callback) {
    const req = new EventEmitter(); req.destroy = () => req.emit("close");
    req.end = (payload) => {
      calls.push({ url, options, body: JSON.parse(payload.toString()) });
      queueMicrotask(() => {
        if (error) { req.emit("error", Error(secret + credential)); return; }
        const res = new EventEmitter(); res.statusCode = status; res.headers = headers; res.destroy = () => {};
        callback(res);
        if (aborted) res.emit("aborted");
        else { res.emit("data", Buffer.from(body)); res.emit("end"); }
        req.emit("close");
      });
    };
    return req;
  }
  return { request, calls };
}

test("claim matches exact API contract and enforces verified HTTPS without redirects", async () => {
  const f = fakeRequest();
  assert.equal(await claimPairing(secret, { ca, request: f.request }), credential);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url.href, `${ORIGIN}/api/pairing/claim`);
  assert.deepEqual(call.body, { deviceName: "NOVA M4.6 Validation", secret });
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.rejectUnauthorized, true);
  assert.equal(call.options.agent, false);
  assert.equal(call.options.ca, ca);
  assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(call.options.checkServerIdentity, undefined); // Keep Node's default hostname check.
});

test("redirects, wrong status/type/cache policy, extra fields and malformed bodies fail closed", async () => {
  for (const options of [
    { status: 302 }, { status: 401 }, { status: 503 },
    { headers: { "content-type": "text/html", "cache-control": "no-store" } },
    { headers: { "content-type": "application/json" } },
    { body: "not-json " + secret },
    { body: JSON.stringify({ paired: true, credential, extra: secret }) },
    { body: JSON.stringify({ paired: false, credential }) },
    { body: JSON.stringify({ paired: true, credential: "invalid" }) },
    { body: "x".repeat(9000) }, { error: true }, { aborted: true },
  ]) {
    const f = fakeRequest(options);
    await assert.rejects(claimPairing(secret, { ca, request: f.request }), (error) => {
      assert(!error.message.includes(secret)); assert(!error.message.includes(credential)); return true;
    });
    assert.equal(f.calls.length, 1); // Never follow or retry.
  }
});

test("invalid or noncanonical secrets never reach the network", () => {
  const f = fakeRequest();
  for (const value of ["", "short", secret + "\n", secret.slice(0, -1) + "B"]) {
    assert.throws(() => claimPairing(value, { ca, request: f.request }), /Invalid pairing-secret/);
  }
  assert.equal(f.calls.length, 0);
});

test("runtime checks CA startup trust, unsafe TLS, launch preloads and debug logging", () => {
  const settings = { env: { NODE_EXTRA_CA_CERTS: CA_PATH }, execArgs: [], readCa: () => ca, verifyTrust: () => true };
  assert.equal(prepareRuntime(settings), ca);
  assert.throws(() => prepareRuntime({ ...settings, verifyTrust: () => false }), /not loaded/);
  for (const added of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { NODE_OPTIONS: "--require evil.cjs" },
    { NODE_DEBUG: "https" }, { NODE_DEBUG_NATIVE: "tls" }, { NODE_EXTRA_CA_CERTS: "wrong.pem" }]) {
    assert.throws(() => prepareRuntime({ ...settings, env: { ...settings.env, ...added } }));
  }
  assert.throws(() => prepareRuntime({ ...settings, readCa() { throw Error(secret); } }), (e) => !e.message.includes(secret));
});

function fakeInput() {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false;
  input.isPaused = () => true; input.pause = () => {}; input.resume = () => {};
  input.setRawMode = (raw) => { input.isRaw = raw; };
  return input;
}
test("interactive secret input never echoes and restores terminal mode", async () => {
  const input = fakeInput(); const out = output();
  const promise = readHiddenSecret({ input, output: out });
  assert.equal(input.isRaw, true);
  input.emit("data", Buffer.from(secret + "\r"));
  assert.equal(await promise, secret);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  assert(!out.text.includes(secret));
});

test("hidden input rejects redirected input and cancels cleanly", async () => {
  assert.throws(() => readHiddenSecret({ input: { isTTY: false }, output: output() }), /interactive terminal/);
  for (const action of ["interrupt", "end", "error", "escape", "too-long"]) {
    const input = fakeInput(); const out = output();
    const pending = readHiddenSecret({ input, output: out });
    if (action === "end") input.emit("end");
    else if (action === "error") input.emit("error", Error(secret));
    else input.emit("data", Buffer.from(action === "interrupt" ? "\u0003" : action === "escape" ? "\u001b" : "a".repeat(44)));
    await assert.rejects(pending);
    assert.equal(input.isRaw, false); assert(!out.text.includes(secret));
  }
});

test("in-memory validator handoff never changes process or caller environment", async () => {
  const previous = process.env.SELENE_M46_BEARER;
  const env = { NODE_EXTRA_CA_CERTS: CA_PATH };
  const calls = [];
  const session = validatorSession(credential, { env, validate: async (options) => { calls.push(options); return "passed"; } });
  assert.equal(await session.run("before", "state-path"), "passed");
  await session.run("after", "state-path");
  assert.equal(calls[0].env.SELENE_M46_BEARER, credential);
  assert.equal(calls[0].env.SELENE_M46_URL, ORIGIN);
  assert.equal(calls[0].stateFile, "state-path");
  assert.equal(process.env.SELENE_M46_BEARER, previous);
  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: CA_PATH });
  session.close(); await assert.rejects(session.run("after", "state-path"), /closed/);
});

test("validator errors cannot print injected secrets", async () => {
  const session = validatorSession(credential, { validate: async () => { throw Error(secret + credential); } });
  await assert.rejects(session.run("before", "state-path"), (e) => !e.message.includes(secret) && !e.message.includes(credential));
  session.close();
});

test("CLI accepts no secret arguments and sends no request before an interactive prompt", async () => {
  let preflightCalls = 0;
  await assert.rejects(main({ args: [secret], preflight() { preflightCalls++; } }), /no arguments/);
  assert.equal(preflightCalls, 0);
});

test("successful pairing waits for explicit validator action; quitting closes memory session", async () => {
  const out = output(); let validationCalls = 0; let closed = false; let claims = 0;
  await main({ args: [], input: { isTTY: true }, output: out,
    preflight: () => ca, readSecret: async () => secret,
    claim: async (value) => { assert.equal(value, secret); claims++; return credential; },
    makeSession: () => ({ run: async () => { validationCalls++; }, close: () => { closed = true; } }),
    makeInterface: () => ({ question: async () => "quit", close() {} }),
  });
  assert.equal(claims, 1); assert.equal(validationCalls, 0); assert(closed);
  assert(!out.text.includes(secret)); assert(!out.text.includes(credential));
});

test("only an explicit menu action invokes a validator phase", async () => {
  const out = output(); const answers = ["resume-before", "outside-state-path", "quit"]; const calls = [];
  await main({ args: [], input: { isTTY: true }, output: out, preflight: () => ca,
    readSecret: async () => secret, claim: async () => credential,
    makeSession: () => ({ run: async (...args) => calls.push(args), close() {} }),
    makeInterface: () => ({ question: async () => answers.shift(), close() {} }),
  });
  assert.deepEqual(calls, [["before", "outside-state-path", true]]);
  assert(!out.text.includes(credential));
});

test("premature connection closure fails without leaking or retrying", async () => {
  let calls = 0;
  const request = () => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => { calls++; queueMicrotask(() => req.emit("close")); };
    return req;
  };
  await assert.rejects(claimPairing(secret, { ca, request }), /closed before completion/);
  assert.equal(calls, 1);
});

test("hidden input supports correction without echoing any entered characters", async () => {
  const input = fakeInput(); const out = output();
  const pending = readHiddenSecret({ input, output: out });
  input.emit("data", Buffer.from(secret.slice(0, 42) + "X\u007f" + secret.at(-1) + "\r"));
  assert.equal(await pending, secret);
  assert.equal(input.isRaw, false);
  assert(!out.text.includes(secret));
});

test("opt-in visible input echoes the code and supports Backspace correction", async () => {
  const input = fakeInput(); const out = output();
  const pending = readHiddenSecret({ input, output: out, visible: true });
  input.emit("data", Buffer.from("X\u007f" + secret + "\r"));
  assert.equal(await pending, secret);
  assert(out.text.includes(secret));
  assert(out.text.includes("\b \b"));
  assert.equal(input.isRaw, false);
});

test("show-secret flag enables visible entry but never displays the returned credential", async () => {
  const out = output(); let visible;
  await main({ args: ["--show-secret"], input: { isTTY: true }, output: out,
    preflight: () => ca, readSecret: async (options) => { visible = options.visible; return secret; },
    claim: async () => credential, makeSession: () => ({ close() {} }),
    makeInterface: () => ({ question: async () => "quit", close() {} }),
  });
  assert.equal(visible, true);
  assert(!out.text.includes(credential));
});

test("recall hands off the existing credential in memory and blocks duplicate attempts", async () => {
  let calls = 0;
  const previous = process.env.SELENE_M46_BEARER;
  const session = validatorSession(credential, { recallTest: async (options) => {
    assert.deepEqual(options, { credential }); calls++; return { persistenceVerified: true };
  } });
  assert.deepEqual(await session.recall(), { persistenceVerified: true });
  await assert.rejects(session.recall(), /already attempted/);
  assert.equal(calls, 1); assert.equal(process.env.SELENE_M46_BEARER, previous);
  session.close(); await assert.rejects(session.recall(), /closed/);
});

test("recall menu prints actual response safely without asking for a journal or calling before/after", async () => {
  const out = output(); const answers = ["recall", "quit"]; let recalls = 0;
  await main({ args: [], input: { isTTY: true }, output: out, preflight: () => ca,
    readSecret: async () => secret, claim: async () => credential,
    makeSession: () => ({ recall: async () => { recalls++; return { conversationId: "mock-id", modelResponse: "Krypton.\n\u001b[31m", answerMentionsKrypton: true }; },
      run() { throw Error("Unexpected validator invocation"); }, close() {} }),
    makeInterface: () => ({ question: async () => answers.shift(), close() {} }),
  });
  assert.equal(recalls, 1); assert.match(out.text, /Response mentions Krypton: YES/);
  assert(!out.text.includes("\u001b")); assert(!out.text.includes(credential));
});

test("recall failure discloses neither raw exceptions nor credential and cannot silently retry", async () => {
  let attempts = 0;
  const session = validatorSession(credential, { recallTest: async () => { attempts++; throw Error(credential); } });
  await assert.rejects(session.recall(), (e) => !e.message.includes(credential));
  await assert.rejects(session.recall(), /already attempted/);
  assert.equal(attempts, 1); session.close();
});
