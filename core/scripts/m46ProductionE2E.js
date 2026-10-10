// M4.6: production HTTPS conversation smoke test.
// Run only against your own Selene Host. Does not disable TLS verification.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [phase, stateFile] = process.argv.slice(2);
const base = process.env.SELENE_M46_URL;
const token = process.env.SELENE_M46_BEARER;
if (!["before", "after"].includes(phase) || !stateFile || !base || !token) {
  console.error("Usage: node scripts/m46ProductionE2E.js before|after <state-file-outside-repo>");
  console.error("Required environment: SELENE_M46_URL (https://...), SELENE_M46_BEARER");
  process.exit(2);
}
const url = new URL(base);
if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
  throw new Error("SELENE_M46_URL must be an HTTPS base URL without credentials or query.");
}
const statePath = resolve(stateFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const relativeState = relative(root, statePath);
if (relativeState === "" || (relativeState !== ".." && !relativeState.startsWith(`..${sep}`) && !isAbsolute(relativeState))) {
  throw new Error("State file must be outside the repository.");
}
const origin = url.href.replace(/\/$/, "");
async function request(method, path, body, bearer = token) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  return { status: response.status, payload, headers: response.headers };
}
function checkStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: expected HTTP ${status}, got ${result.status}; code=${result.payload?.error?.code ?? "none"}`);
}
const health = await request("GET", "/health", undefined, null);
checkStatus(health, 200, "health");
const denied = await request("GET", "/api/conversations", undefined, null);
checkStatus(denied, 401, "unauthenticated list");
const listing = await request("GET", "/api/conversations?limit=20");
checkStatus(listing, 200, "authenticated list");
assert.equal(listing.payload.ok, true);
assert.ok(Array.isArray(listing.payload.conversations));
if (phase === "before") {
  const created = await request("POST", "/api/conversations", {});
  checkStatus(created, 201, "create conversation");
  const id = created.payload.conversation?.id;
  assert.match(id, /^[0-9a-f-]{36}$/i);
  const first = await request("POST", `/api/conversations/${encodeURIComponent(id)}/messages`, {
    message: "M4.6 validation turn one. Please reply briefly.",
  });
  checkStatus(first, 200, "first turn");
  assert.equal(first.payload.conversationId, id);
  assert.ok(first.payload.assistantMessage?.content);
  const retrieved = await request("GET", `/api/conversations/${encodeURIComponent(id)}`);
  checkStatus(retrieved, 200, "retrieve");
  assert.equal(retrieved.payload.messages.length, 2);
  const listAgain = await request("GET", "/api/conversations?limit=20");
  checkStatus(listAgain, 200, "list after create");
  assert.ok(listAgain.payload.conversations.some((c) => c.id === id));
  await writeFile(statePath, JSON.stringify({ conversationId: id, baseUrl: origin }, null, 2), { flag: "wx", mode: 0o600 });
  console.log("M4.6 BEFORE passed. Stop and restart Selene Core, then run AFTER with the same state file.");
} else {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.baseUrl, origin, "Host URL changed between phases");
  const id = state.conversationId;
  const retrieved = await request("GET", `/api/conversations/${encodeURIComponent(id)}`);
  checkStatus(retrieved, 200, "retrieve after restart");
  assert.equal(retrieved.payload.messages.length, 2);
  const second = await request("POST", `/api/conversations/${encodeURIComponent(id)}/messages`, {
    message: "M4.6 validation turn two after Host restart. Please reply briefly.",
  });
  checkStatus(second, 200, "second turn");
  assert.ok(second.payload.assistantMessage?.content);
  const final = await request("GET", `/api/conversations/${encodeURIComponent(id)}`);
  checkStatus(final, 200, "retrieve final");
  assert.equal(final.payload.messages.length, 4);
  console.log("M4.6 AFTER passed. Conversation persisted and continued across restart.");
}
