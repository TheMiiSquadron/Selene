import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runSemanticRecall, RECALL_FIRST, RECALL_SECOND } from "./m46SemanticRecall.js";

const credential = "mock_recall_credential_never_print";
function fixture({ reply = "You told me Krypton was your favorite fictional planet.", mutate = () => {} } = {}) {
  const id = randomUUID(); const calls = []; const stored = []; let reads = 0;
  async function fetchImpl(url, options) {
    const payload = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ url, options, payload });
    const path = new URL(url).pathname;
    let status = 200; let body;
    if (path === "/api/conversations" && options.method === "POST") {
      status = 201; body = { ok: true, conversation: { id } };
    } else if (path === `/api/conversations/${id}` && options.method === "GET") {
      reads++; body = { ok: true, conversation: { id }, messages: structuredClone(stored) };
    } else if (path === `/api/conversations/${id}/messages` && options.method === "POST") {
      const start = stored.length;
      const userMessage = { id: randomUUID(), conversationId: id, sequence: start + 1, role: "user", content: payload.message };
      const assistantMessage = { id: randomUUID(), conversationId: id, sequence: start + 2, role: "assistant", content: start ? reply : "Understood for this conversation." };
      stored.push(userMessage, assistantMessage);
      body = { conversationId: id, userMessage, assistantMessage };
    } else throw Error("Unexpected mock request");
    mutate({ body, path, reads, calls });
    return { status, redirected: false, headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }), json: async () => structuredClone(body) };
  }
  return { id, calls, stored, fetchImpl };
}

test("fresh conversation, exact separate messages, same ID and exact persisted order", async () => {
  const f = fixture();
  const result = await runSemanticRecall({ credential, fetchImpl: f.fetchImpl });
  assert.equal(result.conversationId, f.id);
  assert.equal(result.answerMentionsKrypton, true);
  assert.equal(result.modelResponse, "You told me Krypton was your favorite fictional planet.");
  assert.equal(result.persistenceVerified, true);
  assert.deepEqual(result.messageIds, f.stored.map((m) => m.id));
  assert.equal(f.calls.length, 6); // Create, empty read, first turn, read, second turn, final read.
  const posts = f.calls.filter((c) => c.url.endsWith("/messages"));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].payload, { message: "My favorite fictional planet is Krypton. Please remember that for this conversation." });
  assert.deepEqual(posts[1].payload, { message: "What fictional planet did I tell you was my favorite?" });
  assert(!JSON.stringify(posts[1].payload).toLowerCase().includes("krypton"));
  assert.equal(posts[0].url, posts[1].url);
  assert(f.calls.every((c) => c.options.headers.Authorization === `Bearer ${credential}` && c.options.redirect === "error"));
  assert(f.calls.every((c) => c.url.startsWith("https://127.0.0.1:8787/")));
  assert(f.calls.every((c) => c.payload === undefined || !Object.hasOwn(c.payload, "messages")));
  assert(!JSON.stringify(result).includes(credential));
  assert.equal(RECALL_FIRST, posts[0].payload.message); assert.equal(RECALL_SECOND, posts[1].payload.message);
});

test("wrong answer is reported honestly while persistence is independently verified", async () => {
  const f = fixture({ reply: "You told me Mars." });
  const result = await runSemanticRecall({ credential, fetchImpl: f.fetchImpl });
  assert.equal(result.answerMentionsKrypton, false); assert.equal(result.modelResponse, "You told me Mars.");
  assert.equal(result.persistenceVerified, true);
});

for (const mutation of ["content", "id", "order", "missing", "conversation", "duplicate"]) {
  test(`rejects final persisted history with changed ${mutation}`, async () => {
    const f = fixture({ mutate({ body, reads, path }) {
      if (!body.messages || reads !== 3 || path.endsWith("/messages")) return;
      if (mutation === "content") body.messages[1].content = "changed";
      if (mutation === "id") body.messages[1].id = randomUUID();
      if (mutation === "order") body.messages.reverse();
      if (mutation === "missing") body.messages.pop();
      if (mutation === "conversation") body.conversation.id = randomUUID();
      if (mutation === "duplicate") body.messages[3].id = body.messages[1].id;
    } });
    await assert.rejects(runSemanticRecall({ credential, fetchImpl: f.fetchImpl }));
  });
}

test("first turn must be persisted before follow-up is sent", async () => {
  const f = fixture({ mutate({ body, reads }) { if (body.messages && reads === 2) body.messages = []; } });
  await assert.rejects(runSemanticRecall({ credential, fetchImpl: f.fetchImpl }), /first turn was not persisted/);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/messages")).length, 1);
});

test("nonempty fresh conversation is refused before sending either message", async () => {
  const f = fixture({ mutate({ body, reads }) {
    if (body.messages && reads === 1) body.messages.push({ id: randomUUID(), conversationId: body.conversation.id, sequence: 1, role: "user", content: "existing" });
  } });
  await assert.rejects(runSemanticRecall({ credential, fetchImpl: f.fetchImpl }), /fresh, empty/);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/messages")).length, 0);
});

test("redirects, malformed responses, TLS errors and credentials in content are not exposed", async () => {
  for (const fetchImpl of [
    async () => ({ status: 302, redirected: false }),
    async () => ({ status: 201, redirected: true }),
    async () => { throw Error(credential); },
    async () => ({ status: 201, redirected: false, headers: new Headers({ "content-type": "text/html" }) }),
    fixture({ reply: credential }).fetchImpl,
  ]) {
    await assert.rejects(runSemanticRecall({ credential, fetchImpl }), (error) => !error.message.includes(credential));
  }
});

test("an uncertain write is attempted only once and preserves the fresh ID in memory", async () => {
  const f = fixture(); let sends = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/messages")) { sends++; throw Error("connection lost"); }
    return f.fetchImpl(url, options);
  };
  await assert.rejects(runSemanticRecall({ credential, fetchImpl }), (e) => e.conversationId === f.id && /no automatic retry/.test(e.message));
  assert.equal(sends, 1);
});
