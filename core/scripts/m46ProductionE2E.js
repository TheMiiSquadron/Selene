// Explicit production validation only. Importing this module performs no work.
import { open, lstat, realpath, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FIRST = "M4.6 validation turn one. Please reply briefly.";
export const SECOND = "M4.6 validation turn two after Core restart. Please reply briefly.";
export class ValidationError extends Error {}
function requireThat(condition, message) {
  if (!condition) throw new ValidationError(message);
}
function within(path, root) {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function configuration(env, execArgs = []) {
  requireThat(!env.NODE_TLS_REJECT_UNAUTHORIZED || env.NODE_TLS_REJECT_UNAUTHORIZED === "1",
    "Unsafe TLS verification setting. Remove the bypass before validation.");
  const flags = [...execArgs, ...(env.NODE_OPTIONS ?? "").split(/\s+/).filter(Boolean)];
  requireThat(flags.every((flag) => ["--use-system-ca", "--use-bundled-ca", "--use-openssl-ca"].includes(flag)),
    "Unsupported Node launch options. Use a clean Node invocation without preloads or TLS overrides.");
  let url;
  try { url = new URL(env.SELENE_M46_URL); } catch {
    throw new ValidationError("Set SELENE_M46_URL to the production HTTPS origin.");
  }
  requireThat(url.protocol === "https:" && !url.username && !url.password && !url.search
    && !url.hash && url.pathname === "/", "Use an HTTPS origin without credentials, path, query, or fragment.");
  requireThat(typeof env.SELENE_M46_BEARER === "string"
    && /^[A-Za-z0-9._-]+$/.test(env.SELENE_M46_BEARER),
  "Set SELENE_M46_BEARER to a valid Home credential with chat and conversation read/write capabilities.");
  return { baseUrl: url.origin, token: env.SELENE_M46_BEARER };
}

// No production endpoint exposes startup identity. Observe NOVA's local socket
// owners instead; do not pretend that /health, a version, or a changed PID alone
// proves a restart. Remote hosts and alternative hosting arrangements fail closed.
export async function observeLocalCore(baseUrl, previous = null, {
  platform = process.platform, lookupImpl = lookup, interfaces = networkInterfaces,
  execute = execFileSync,
} = {}) {
  requireThat(platform === "win32", "Restart evidence requires NOVA/Windows local process inspection; this host is unsupported.");
  const url = new URL(baseUrl);
  requireThat(url.port === "8787", "Restart evidence requires the standard Link port 8787.");
  requireThat(!previous || validIdentity(previous), "Stored startup identity is invalid.");
  const addresses = await lookupImpl(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  const local = new Set(["127.0.0.1", "::1", ...Object.values(interfaces()).flat().filter(Boolean).map((a) => a.address)]);
  requireThat(addresses.length && addresses.every((a) => local.has(a.address)),
    "Restart evidence is unavailable for a remote host. Run validation locally on NOVA.");
  const script = `
$ErrorActionPreference = 'Stop'
$links = @(Get-NetTCPConnection -State Listen -LocalPort 8787)
$cores = @(Get-NetTCPConnection -State Listen -LocalPort 3030)
$owners = @(@($links + $cores) | Select-Object -ExpandProperty OwningProcess -Unique)
if ($links.Count -eq 0 -or $cores.Count -eq 0 -or $owners.Count -ne 1) { throw 'Unverified ownership' }
$proc = Get-Process -Id $owners[0]
if ($proc.ProcessName -ne 'node') { throw 'Unsupported process' }
$oldAlive = $false
${previous ? `$old = Get-Process -Id ${previous.pid} -ErrorAction SilentlyContinue
if ($old) { $oldAlive = $old.StartTime.ToUniversalTime().Ticks.ToString() -eq '${previous.startTicks}' }` : ""}
[pscustomobject]@{ pid=$proc.Id; startTicks=$proc.StartTime.ToUniversalTime().Ticks.ToString(); previousAlive=$oldAlive } | ConvertTo-Json -Compress
`;
  try {
    const result = JSON.parse(execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "ignore"],
    }));
    requireThat(validIdentity(result), "Local process inspection did not return a startup identity.");
    return result;
  } catch {
    throw new ValidationError("Cannot verify local Core/Link process ownership. Both ports must belong to one accessible Node process.");
  }
}
function validIdentity(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.startTicks === "string" && /^\d{15,20}$/.test(value.startTicks)
    && typeof value.previousAlive === "boolean";
}
function identityEqual(a, b) { return a.pid === b.pid && a.startTicks === b.startTicks; }

async function plainPath(path, root) {
  requireThat(!within(path, root), "State and lock files must be outside the repository.");
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try {
      const stat = await lstat(cursor);
      requireThat(!stat.isSymbolicLink(), "State paths must not contain symlinks or junctions.");
      requireThat(samePath(resolve(await realpath(cursor)), resolve(cursor)), "State paths must not resolve through substituted paths.");
      if (cursor === path) requireThat(stat.isFile() && stat.nlink === 1, "State must be a regular file with one link.");
      else requireThat(stat.isDirectory(), "State parent must be an existing directory.");
    } catch (error) {
      if (error.code !== "ENOENT" || cursor !== path) throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
}

async function journal(path, phase, resume, root) {
  const lockPath = `${path}.lock`;
  await plainPath(path, root);
  await plainPath(lockPath, root);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); } catch {
    throw new ValidationError("Cannot reserve the state lock. Check parent permissions; if a lock exists, verify its run has exited before removing only the stale lock.");
  }
  let file;
  try {
    await plainPath(path, root);
    const create = phase === "before" && !resume;
    file = await open(path, (create ? constants.O_CREAT | constants.O_EXCL : 0)
      | constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
    const existing = await file.readFile("utf8");
    let state = null;
    if (!create) {
      requireThat(existing.endsWith("\n"), "Recovery journal is empty or truncated. Preserve it and inspect it manually; no requests were sent.");
      const entries = existing.trimEnd().split("\n").map((line) => JSON.parse(line));
      state = entries.at(-1);
    }
    const stat = await file.stat();
    async function save(value) {
      await plainPath(path, root);
      const current = await lstat(path);
      requireThat(current.dev === stat.dev && current.ino === stat.ino, "State file identity changed; preserve the journal and stop.");
      await file.appendFile(`${JSON.stringify(value)}\n`, "utf8");
      await file.sync();
    }
    // Reserve and fsync before any network mutation, including on resumed runs.
    await file.sync();
    return { state, save, async close() { await file.close(); await lock.close(); await unlink(lockPath); } };
  } catch (error) {
    await file?.close();
    await lock.close();
    await unlink(lockPath);
    if (error.code === "EEXIST") throw new ValidationError("State file already exists. Use before <state> --resume for recovery, or choose a new path.");
    throw error;
  }
}

function messagesSnapshot(payload, id, token) {
  requireThat(payload?.conversation?.id === id && Array.isArray(payload.messages), "Conversation retrieval returned an unexpected identity or history.");
  const seen = new Set();
  return payload.messages.map((m, index) => {
    requireThat(UUID.test(m.id) && !seen.has(m.id) && m.conversationId === id
      && m.sequence === index + 1 && m.role === (index % 2 ? "assistant" : "user")
      && typeof m.content === "string" && m.content.trim() && !m.content.includes(token),
    "History contains invalid message identities, content, or sequence.");
    seen.add(m.id);
    return { id: m.id, conversationId: m.conversationId, sequence: m.sequence, role: m.role, content: m.content };
  });
}
function validateState(state, baseUrl) {
  requireThat(state?.version === 1 && state.baseUrl === baseUrl && validIdentity(state.baseline)
    && (state.conversationId === null || UUID.test(state.conversationId))
    && [null, "create", "first", "second"].includes(state.pending)
    && typeof state.beforeComplete === "boolean" && typeof state.completed === "boolean"
    && (state.initial === null || (Array.isArray(state.initial) && state.initial.length === 2))
    && (state.final === null || (Array.isArray(state.final) && state.final.length === 4))
    && (state.restart === null || validIdentity(state.restart)),
  "Recovery state is invalid or belongs to a different HTTPS origin. Preserve it for inspection.");
}

export async function runValidation({ phase, stateFile, resume = false, env = process.env,
  execArgs = process.execArgv, fetchImpl = globalThis.fetch, observe = observeLocalCore, repositoryRoot = ROOT } = {}) {
  requireThat(["before", "after"].includes(phase) && typeof stateFile === "string" && stateFile,
    "Usage: node scripts/m46ProductionE2E.js before|after <state-outside-repo> [--resume]");
  const { baseUrl, token } = configuration(env, execArgs);
  let store;
  try {
    store = await journal(resolve(stateFile), phase, resume, repositoryRoot);
    let state = store.state;
    if (state) validateState(state, baseUrl);
    const observed = await observe(baseUrl, state?.baseline);
    requireThat(validIdentity(observed), "Core startup identity is unavailable; restart cannot be verified.");
    const current = { pid: observed.pid, startTicks: observed.startTicks, previousAlive: observed.previousAlive };
    if (!state) {
      state = { version: 1, baseUrl, baseline: current, conversationId: null, pending: null,
        initial: null, final: null, beforeComplete: false, completed: false, restart: null };
      await store.save(state);
    }
    if (phase === "before") {
      requireThat(identityEqual(current, state.baseline), "Core changed during BEFORE recovery. Preserve the run and start a new validation with a new state path.");
      requireThat(!state.beforeComplete, "BEFORE is already complete. Restart Core and run AFTER.");
    } else {
      requireThat(state.beforeComplete && state.initial, "BEFORE is incomplete. Recover it with before <state> --resume first.");
      requireThat(BigInt(current.startTicks) > BigInt(state.baseline.startTicks)
        && !observed.previousAlive, "Restart not proven: the original Core is still running or no later startup was observed.");
      if (state.restart) requireThat(identityEqual(current, state.restart), "Core changed again during AFTER. Preserve this run; start a new validation.");
      state.restart = current;
      await store.save(state);
    }
    async function stable() {
      const next = await observe(baseUrl, state.baseline);
      requireThat(validIdentity(next) && identityEqual(next, current), "Core process changed during this phase. Preserve state and inspect before retrying.");
    }
    async function request(method, path, expected, body, authenticated = true) {
      let response;
      try {
        response = await fetchImpl(baseUrl + path, { method, redirect: "error",
          headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(660000) });
      } catch {
        throw new ValidationError("HTTPS request failed. Check certificate trust/hostname, redirects, connection, and model latency. A pending write must not be resent blindly; use recovery.");
      }
      requireThat(!response.redirected && !(response.status >= 300 && response.status < 400), "Unexpected redirect rejected; verify the direct HTTPS origin.");
      requireThat(response.status === expected, `Expected HTTP ${expected}, received HTTP ${Number.isInteger(response.status) ? response.status : "invalid"}. Check credentials, capabilities, and service availability.`);
      try { return await response.json(); } catch { throw new ValidationError("Gateway returned invalid JSON; preserve state and inspect service health."); }
    }
    requireThat((await request("GET", "/health", 200, undefined, false))?.ok === true, "Gateway health check failed.");
    await request("GET", "/api/conversations", 401, undefined, false);
    const listing = await request("GET", "/api/conversations?limit=20", 200);
    requireThat(listing?.ok === true && Array.isArray(listing.conversations), "Authenticated conversation listing is invalid.");
    await stable();
    if (!state.conversationId) {
      requireThat(state.pending !== "create", "Conversation creation outcome is unknown. Preserve the journal and locate the test conversation manually; do not retry creation with this run.");
      state.pending = "create";
      await store.save(state);
      const created = await request("POST", "/api/conversations", 201, {});
      requireThat(UUID.test(created?.conversation?.id), "Created conversation identity is invalid; creation outcome needs manual inspection.");
      state.conversationId = created.conversation.id;
      state.pending = null;
      await store.save(state);
    }
    const path = `/api/conversations/${encodeURIComponent(state.conversationId)}`;
    async function history() { return messagesSnapshot(await request("GET", path, 200), state.conversationId, token); }
    let messages = await history();
    const turn = phase === "before" ? "first" : "second";
    const offset = phase === "before" ? 0 : 2;
    if (phase === "after") requireThat(isDeepStrictEqual(messages.slice(0, 2), state.initial), "Persisted message identity, content, or ordering changed after restart.");
    requireThat(messages.length === offset || messages.length === offset + 2, "Unexpected history length. Preserve state and inspect the conversation.");
    if (messages.length === offset) {
      requireThat(state.pending === null && !state.completed, "A write outcome is still unknown. Wait for it to settle and retry recovery; automatic resubmission is disabled.");
      await stable();
      state.pending = turn;
      await store.save(state);
      const result = await request("POST", `${path}/messages`, 200, { message: phase === "before" ? FIRST : SECOND });
      requireThat(result?.conversationId === state.conversationId, "Message response returned the wrong conversation identity.");
      messages = await history();
      requireThat(messages.length === offset + 2
        && result.userMessage?.id === messages[offset]?.id && result.assistantMessage?.id === messages[offset + 1]?.id
        && result.userMessage?.content === messages[offset]?.content && result.assistantMessage?.content === messages[offset + 1]?.content,
      "Saved turn does not match the message response; preserve state for recovery.");
    } else {
      requireThat(state.pending === turn || (phase === "after" && state.completed), "Unexpected extra turn; it cannot be attributed to this run.");
    }
    requireThat(messages[offset].content === (phase === "before" ? FIRST : SECOND), "Saved user message differs from the validation turn.");
    if (phase === "after") {
      requireThat(isDeepStrictEqual(messages.slice(0, 2), state.initial), "Initial history changed while continuing the conversation.");
      if (state.completed) requireThat(isDeepStrictEqual(messages, state.final), "Completed validation history has changed.");
    }
    const listed = await request("GET", "/api/conversations?limit=20", 200);
    requireThat(Array.isArray(listed?.conversations)
      && listed.conversations.some((conversation) => conversation.id === state.conversationId),
    "Validation conversation is missing from the recent conversation list. Preserve state and inspect before recovery.");
    await stable();
    state.pending = null;
    if (phase === "before") { state.initial = messages; state.beforeComplete = true; }
    else { state.final = messages; state.completed = true; }
    await store.save(state);
    return phase === "before" ? "M4.6 BEFORE passed. Restart Core, then run AFTER with this journal."
      : "M4.6 AFTER passed. Local Core restart, exact history persistence, and a continued turn verified.";
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("Validation could not proceed. Check state directory/files, access permissions, and local process inspection. Preserve the journal; no automatic write retry was attempted.");
  } finally { await store?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, stateFile, option, ...extra] = process.argv.slice(2);
  try {
    requireThat(!extra.length && (!option || option === "--resume"), "Only the optional --resume argument is supported.");
    console.log(await runValidation({ phase, stateFile, resume: option === "--resume" }));
  } catch (error) {
    console.error(error instanceof ValidationError ? error.message : "Validation failed; preserve recovery state and inspect locally.");
    process.exitCode = 1;
  }
}
