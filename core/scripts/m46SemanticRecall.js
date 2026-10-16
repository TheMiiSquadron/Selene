// Explicit operator action only. Importing this module sends no requests.
import { isDeepStrictEqual } from "node:util";

export const RECALL_FIRST = "My favorite fictional planet is Krypton. Please remember that for this conversation.";
export const RECALL_SECOND = "What fictional planet did I tell you was my favorite?";
const ORIGIN = "https://127.0.0.1:8787";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class RecallError extends Error {}
function check(value, message) { if (!value) throw new RecallError(message); }

export async function runSemanticRecall({ credential, fetchImpl = globalThis.fetch } = {}) {
  check(typeof credential === "string" && credential.length > 0, "A paired in-memory credential is required.");
  let conversationId = null;
  try {
    async function request(method, path, expected, body) {
      let response;
      try {
        response = await fetchImpl(ORIGIN + path, {
          method, redirect: "error", signal: AbortSignal.timeout(660000),
          headers: { Authorization: `Bearer ${credential}`, Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new RecallError("Recall HTTPS request failed. Outcome may be uncertain; no automatic retry was made."); }
      check(response.status === expected && !response.redirected,
        "Recall response status or redirect was rejected. No automatic retry was made.");
      check((response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json"
        && response.headers.get("cache-control") === "no-store", "Recall response headers were rejected.");
      try { return await response.json(); } catch { throw new RecallError("Recall response was not valid JSON."); }
    }
    function messageSnapshot(message, sequence) {
      check(message && UUID.test(message.id) && message.conversationId === conversationId
        && message.sequence === sequence && message.role === (sequence % 2 ? "user" : "assistant")
        && typeof message.content === "string" && message.content.trim()
        && !message.content.includes(credential), "Recall returned invalid message metadata or unsafe content.");
      return { id: message.id, conversationId: message.conversationId, sequence: message.sequence,
        role: message.role, content: message.content };
    }
    async function history() {
      const payload = await request("GET", `/api/conversations/${conversationId}`, 200);
      check(payload?.ok === true && payload.conversation?.id === conversationId && Array.isArray(payload.messages),
        "Recall retrieval returned the wrong conversation or invalid history.");
      const messages = payload.messages.map((m, index) => messageSnapshot(m, index + 1));
      check(new Set(messages.map((m) => m.id)).size === messages.length, "Recall history contains duplicate message IDs.");
      return messages;
    }
    const created = await request("POST", "/api/conversations", 201, {});
    check(created?.ok === true && UUID.test(created.conversation?.id), "Recall creation returned an invalid conversation ID.");
    conversationId = created.conversation.id;
    check((await history()).length === 0, "Recall requires a fresh, empty conversation.");
    async function turn(text, sequence) {
      // Exactly one message field. No expected answer, system prompt, or history
      // is added by the client. Core must obtain context from its saved history.
      const result = await request("POST", `/api/conversations/${conversationId}/messages`, 200, { message: text });
      check(result?.conversationId === conversationId, "Recall turn returned the wrong conversation ID.");
      const pair = [messageSnapshot(result.userMessage, sequence), messageSnapshot(result.assistantMessage, sequence + 1)];
      check(pair[0].content === text && pair[0].id !== pair[1].id, "Recall turn did not preserve the submitted user message.");
      return pair;
    }
    const first = await turn(RECALL_FIRST, 1);
    check(isDeepStrictEqual(await history(), first), "Recall first turn was not persisted exactly before the follow-up.");
    const second = await turn(RECALL_SECOND, 3);
    const persisted = await history();
    check(persisted.length === 4 && isDeepStrictEqual(persisted, [...first, ...second]),
      "Recall exchange was not persisted with the exact four messages in order.");
    const modelResponse = second[1].content;
    return { conversationId, modelResponse, answerMentionsKrypton: /\bkrypton\b/i.test(modelResponse),
      persistenceVerified: true, messageIds: persisted.map((m) => m.id) };
  } catch (error) {
    const safe = error instanceof RecallError ? error : new RecallError("Recall stopped unexpectedly. Sensitive diagnostics withheld.");
    // Only the fresh conversation's public UUID is retained for manual investigation.
    safe.conversationId = conversationId;
    throw safe;
  }
}
