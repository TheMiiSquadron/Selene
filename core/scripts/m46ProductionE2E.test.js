import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configuration, observeLocalCore, runValidation, FIRST, SECOND } from "./m46ProductionE2E.js";

const env = { SELENE_M46_URL: "https://nova.test:8787", SELENE_M46_BEARER: "isolated_test_bearer" };
const baseline = { pid: 101, startTicks: "638960000000000000", previousAlive: true };
const restarted = { pid: 102, startTicks: "638960001000000000", previousAlive: false };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "selene-m46-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, "run.jsonl");
  const id = randomUUID();
  let messages = [];
  let identity = baseline;
  let interceptor = null;
  const calls = [];
  let creates = 0;
  let turns = 0;
  const response = (status, payload) => ({ status, redirected: false, json: async () => structuredClone(payload) });
  async function fetchImpl(url, options) {
    calls.push({ url, ...options });
    if (interceptor) {
      const intercepted = await interceptor(url, options, response);
      if (intercepted) return intercepted;
    }
    const path = new URL(url).pathname;
    if (path === "/health") return response(200, { ok: true });
    if (!options.headers.Authorization) return response(401, { ok: false });
    if (path === "/api/conversations" && options.method === "GET") return response(200, { ok: true, conversations: creates ? [{ id }] : [] });
    if (path === "/api/conversations" && options.method === "POST") { creates++; return response(201, { ok: true, conversation: { id } }); }
    if (path === `/api/conversations/${id}` && options.method === "GET") return response(200, { ok: true, conversation: { id }, messages });
    if (path.endsWith("/messages") && options.method === "POST") {
      turns++;
      const userMessage = { id: randomUUID(), conversationId: id, sequence: messages.length + 1,
        role: "user", content: JSON.parse(options.body).message };
      const assistantMessage = { id: randomUUID(), conversationId: id, sequence: messages.length + 2,
        role: "assistant", content: `Reply ${turns}` };
      messages.push(userMessage, assistantMessage);
      return response(200, { conversationId: id, userMessage, assistantMessage });
    }
    throw new Error("Unexpected fixture request");
  }
  const run = (phase, options = {}) => runValidation({ phase, stateFile, env, execArgs: [],
    fetchImpl, observe: async () => structuredClone(identity), ...options });
  return { root, stateFile, run, calls, fetchImpl, response, id,
    restart(value = restarted) { identity = value; },
    intercept(value) { interceptor = value; },
    history() { return messages; }, setHistory(value) { messages = value; },
    get creates() { return creates; }, get turns() { return turns; } };
}

test("before/real restart/after verifies exact persisted messages and repeat AFTER does not duplicate", async (t) => {
  const f = await fixture(t);
  assert.match(await f.run("before"), /BEFORE passed/);
  const before = JSON.parse((await readFile(f.stateFile, "utf8")).trim().split("\n").at(-1));
  assert.equal(before.conversationId, f.id);
  assert.deepEqual(before.initial, f.history());
  f.restart();
  assert.match(await f.run("after"), /restart, exact history persistence/);
  assert.match(await f.run("after"), /AFTER passed/);
  assert.equal(f.creates, 1);
  assert.equal(f.turns, 2);
  assert.deepEqual(f.history().map((m) => m.content), [FIRST, "Reply 1", SECOND, "Reply 2"]);
  assert.ok(f.calls.every((c) => c.redirect === "error" && c.url.startsWith("https://")));
  assert.equal(f.calls[0].headers.Authorization, undefined);
  assert.equal((await readFile(f.stateFile, "utf8")).includes(env.SELENE_M46_BEARER), false);
});

test("unchanged process, PID-only change, and still-live original cannot prove restart", async (t) => {
  const f = await fixture(t);
  await f.run("before");
  for (const identity of [baseline, { ...baseline, pid: 202, previousAlive: false }, { ...restarted, previousAlive: true }]) {
    f.restart(identity);
    await assert.rejects(f.run("after"), /Restart not proven/);
  }
  assert.equal(f.turns, 1);
});

test("PID reuse with a later startup and exited original is valid evidence", async (t) => {
  const f = await fixture(t); await f.run("before");
  f.restart({ ...restarted, pid: baseline.pid });
  assert.match(await f.run("after"), /AFTER passed/);
});

test("missing startup evidence fails before production mutations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("before", { observe: async () => null }), /identity is unavailable/);
  assert.equal(f.calls.length, 0);
});

test("process replacement during a phase fails closed", async (t) => {
  const f = await fixture(t);
  let count = 0;
  await assert.rejects(f.run("before", { observe: async () => ++count === 1 ? baseline : restarted }), /changed during this phase/);
  assert.equal(f.creates, 0);
});

for (const corruption of ["id", "content", "ordering", "conversationId", "sequence", "role"]) {
  test(`AFTER rejects changed message ${corruption}`, async (t) => {
    const f = await fixture(t); await f.run("before"); f.restart();
    if (corruption === "ordering") f.history().reverse();
    else if (corruption === "id" || corruption === "conversationId") f.history()[0][corruption] = randomUUID();
    else if (corruption === "sequence") f.history()[0].sequence = 9;
    else f.history()[0][corruption] = "changed";
    await assert.rejects(f.run("after"), /History contains|Persisted message/);
    assert.equal(f.turns, 1);
  });
}

test("existing state is never overwritten by a fresh BEFORE", async (t) => {
  const f = await fixture(t); await writeFile(f.stateFile, "preserve me");
  await assert.rejects(f.run("before"), /already exists/);
  assert.equal(await readFile(f.stateFile, "utf8"), "preserve me");
  assert.equal(f.calls.length, 0);
});

test("missing parent and repository-local state fail before requests", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("before", { stateFile: join(f.root, "missing", "run") }), /could not proceed/);
  await assert.rejects(f.run("before", { repositoryRoot: f.root }), /outside the repository/);
  assert.equal(f.calls.length, 0);
});

test("symlink/junction parent and linked state are rejected", async (t) => {
  const f = await fixture(t);
  const target = join(f.root, "target"); const alias = join(f.root, "alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run("before", { stateFile: join(alias, "run") }), /symlinks or junctions|substituted/);
  const original = join(f.root, "original"); await writeFile(original, "untouched");
  await link(original, f.stateFile);
  await assert.rejects(f.run("before"), /one link/);
  assert.equal(await readFile(original, "utf8"), "untouched");
  assert.equal(f.calls.length, 0);
});

test("existing lock is preserved and concurrent validation is refused", async (t) => {
  const f = await fixture(t); await writeFile(`${f.stateFile}.lock`, "other run");
  await assert.rejects(f.run("before"), /state lock/);
  assert.equal(await readFile(`${f.stateFile}.lock`, "utf8"), "other run");
  assert.equal(f.calls.length, 0);
});

test("truncated and malformed journals are preserved without requests", async (t) => {
  const f = await fixture(t);
  for (const text of ["{", "not-json\n", "{}\n"]) {
    await writeFile(f.stateFile, text);
    await assert.rejects(f.run("after"), /truncated|could not proceed|invalid/);
    assert.equal(await readFile(f.stateFile, "utf8"), text);
  }
  assert.equal(f.calls.length, 0);
});

test("lost message response recovers committed turn without retransmission", async (t) => {
  const f = await fixture(t);
  const wrapped = async (url, options) => {
    const result = await f.fetchImpl(url, options);
    if (url.endsWith("/messages")) throw new Error(`network error ${env.SELENE_M46_BEARER}`);
    return result;
  };
  await assert.rejects(f.run("before", { fetchImpl: wrapped }), (e) => /use recovery/.test(e.message) && !e.message.includes(env.SELENE_M46_BEARER));
  assert.match(await f.run("before", { resume: true }), /BEFORE passed/);
  assert.equal(f.turns, 1);
  f.restart();
  await assert.rejects(f.run("after", { fetchImpl: wrapped }), /use recovery/);
  assert.match(await f.run("after"), /AFTER passed/);
  assert.equal(f.turns, 2);
});

test("uncertain uncommitted write is never automatically resent", async (t) => {
  const f = await fixture(t);
  f.intercept(async (url) => { if (url.endsWith("/messages")) throw new Error("connection lost"); });
  await assert.rejects(f.run("before"), /use recovery/);
  f.intercept(null);
  await assert.rejects(f.run("before", { resume: true }), /outcome is still unknown/);
  assert.equal(f.turns, 0);
  assert.equal(f.creates, 1);
});

test("lost creation response preserves uncertain state and refuses duplicate creation", async (t) => {
  const f = await fixture(t);
  const wrapped = async (url, options) => {
    const result = await f.fetchImpl(url, options);
    if (new URL(url).pathname === "/api/conversations" && options.method === "POST") throw new Error("lost");
    return result;
  };
  await assert.rejects(f.run("before", { fetchImpl: wrapped }), /use recovery/);
  await assert.rejects(f.run("before", { resume: true }), /creation outcome is unknown/);
  assert.equal(f.creates, 1);
});

test("HTTPS origin and unsafe launch settings are validated before any I/O", () => {
  for (const url of ["http://nova.test:8787", "https://user:secret@nova.test", "https://nova.test/path", "https://nova.test/?x=1", "https://nova.test/#fragment"]) {
    assert.throws(() => configuration({ ...env, SELENE_M46_URL: url }), /HTTPS origin/);
  }
  assert.throws(() => configuration({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /Unsafe TLS/);
  assert.throws(() => configuration({ ...env, NODE_OPTIONS: "--require override.cjs" }), /Unsupported Node/);
  assert.throws(() => configuration(env, ["--import=override.js"]), /Unsupported Node/);
  assert.equal(configuration({ ...env, NODE_OPTIONS: "--use-system-ca", NODE_EXTRA_CA_CERTS: "trusted-ca.pem" }).baseUrl, env.SELENE_M46_URL);
});

test("redirects, HTTP failures and untrusted TLS fail with secret-free errors", async (t) => {
  const f = await fixture(t);
  for (const [index, fetchImpl] of [
    async () => f.response(302, {}),
    async () => ({ ...f.response(200, {}), redirected: true }),
    async () => f.response(403, { error: { message: env.SELENE_M46_BEARER } }),
    async () => { throw new Error(`certificate error ${env.SELENE_M46_BEARER}`); },
    async () => ({ status: 200, redirected: false, json() { throw new Error(env.SELENE_M46_BEARER); } }),
  ].entries()) {
    await assert.rejects(f.run("before", { stateFile: join(f.root, `failure-${index}`), fetchImpl }),
      (error) => !error.message.includes(env.SELENE_M46_BEARER));
  }
  assert.equal(f.creates, 0);
});

test("CLI failures never print credentials or raw exceptions", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./m46ProductionE2E.js", import.meta.url)), "invalid", "unused"],
    { env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stderr.includes(env.SELENE_M46_BEARER), false);
});

test("local process observer requires local Windows sockets and checks startup identity", async () => {
  let executions = 0;
  const seams = { platform: "win32", lookupImpl: async () => [{ address: "127.0.0.1" }], interfaces: () => ({}),
    execute(executable, args, options) {
      executions++;
      assert.equal(executable, "powershell.exe");
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /LocalPort 8787/);
      assert.match(script, /LocalPort 3030/);
      assert.match(script, /owners.Count -ne 1/);
      assert.match(script, /StartTime.ToUniversalTime\(\).Ticks/);
      assert.match(script, /Get-Process -Id 101/);
      assert.equal(options.windowsHide, true);
      return JSON.stringify(restarted);
    } };
  assert.deepEqual(await observeLocalCore(env.SELENE_M46_URL, baseline, seams), restarted);
  await assert.rejects(observeLocalCore(env.SELENE_M46_URL, baseline, { ...seams, platform: "darwin" }), /unsupported/);
  await assert.rejects(observeLocalCore("https://nova.test:9999", baseline, seams), /standard Link port/);
  await assert.rejects(observeLocalCore(env.SELENE_M46_URL, baseline,
    { ...seams, lookupImpl: async () => [{ address: "192.0.2.9" }] }), /remote host/);
  await assert.rejects(observeLocalCore(env.SELENE_M46_URL, baseline,
    { ...seams, execute() { throw new Error("private diagnostic"); } }), /Cannot verify local/);
  await assert.rejects(observeLocalCore(env.SELENE_M46_URL, baseline,
    { ...seams, execute() { return '{}'; } }), /Cannot verify local/);
  assert.equal(executions, 1);
});

test("different origin and incomplete BEFORE cannot start AFTER writes", async (t) => {
  const f = await fixture(t);
  f.intercept(async (url, options, response) => {
    if (url.endsWith("/health")) return response(503, {});
  });
  await assert.rejects(f.run("before"), /HTTP 503/);
  f.intercept(null);
  f.restart();
  await assert.rejects(f.run("after"), /BEFORE is incomplete/);
  await assert.rejects(f.run("after", { env: { ...env, SELENE_M46_URL: "https://other.test:8787" } }), /different HTTPS origin/);
  assert.equal(f.creates, 0);
});

test("malformed message response is rejected, and committed history remains recoverable", async (t) => {
  const f = await fixture(t);
  const wrapped = async (url, options) => {
    const result = await f.fetchImpl(url, options);
    if (url.endsWith("/messages")) {
      const data = await result.json(); data.assistantMessage.id = randomUUID();
      return f.response(200, data);
    }
    return result;
  };
  await assert.rejects(f.run("before", { fetchImpl: wrapped }), /does not match/);
  assert.match(await f.run("before", { resume: true }), /BEFORE passed/);
  assert.equal(f.turns, 1);
});

test("state directory and symlinked lock are refused before requests", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "directory"); await mkdir(directory);
  await assert.rejects(f.run("before", { stateFile: directory }), /regular file/);
  await symlink(directory, `${f.stateFile}.lock`, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.run("before"), /symlinks or junctions/);
  assert.equal(f.calls.length, 0);
});

test("BEFORE cannot be repeated after completion", async (t) => {
  const f = await fixture(t); await f.run("before");
  await assert.rejects(f.run("before", { resume: true }), /already complete/);
  assert.equal(f.turns, 1);
});

test("AFTER rejects a further process replacement during recovery", async (t) => {
  const f = await fixture(t); await f.run("before"); f.restart();
  await f.run("after");
  f.restart({ ...restarted, pid: 103, startTicks: "638960002000000000" });
  await assert.rejects(f.run("after"), /changed again/);
  assert.equal(f.turns, 2);
});

test("conversation listing failure after a committed turn is recoverable without another message", async (t) => {
  const f = await fixture(t);
  f.intercept(async (url, options, response) => {
    if (url.includes("?limit=20") && f.turns) return response(200, { ok: true, conversations: [] });
  });
  await assert.rejects(f.run("before"), /missing from the recent/);
  f.intercept(null);
  assert.match(await f.run("before", { resume: true }), /BEFORE passed/);
  assert.equal(f.turns, 1);
});
