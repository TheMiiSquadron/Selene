import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPANION_CHAT_EMPTY_REPLY,
  COMPANION_CHAT_MAX_MESSAGE_CHARS,
  COMPANION_CHAT_SYSTEM_PROMPT,
  CompanionChatValidationError,
  handleCompanionChat,
} from "./companionChat.js";

function createStubModelService(response) {
  const calls = [];

  return {
    calls,
    service: {
      async createChatCompletion(request) {
        calls.push(request);
        return response;
      },
    },
  };
}

test("Companion chat uses the primary model as a tool-free conversational boundary", async () => {
  const { calls, service } = createStubModelService({
    choices: [{
      message: {
        content: "  Happy to talk.  ",
        tool_calls: [{ function: { name: "open_app", arguments: "{}" } }],
      },
    }],
  });

  const result = await handleCompanionChat({
    message: "  Hello, Selene.  ",
    modelService: service,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "primary");
  assert.equal(calls[0].toolChoice, "none");
  assert.equal(Object.hasOwn(calls[0], "tools"), false);
  assert.deepEqual(calls[0].messages, [
    { role: "system", content: COMPANION_CHAT_SYSTEM_PROMPT },
    { role: "user", content: "Hello, Selene." },
  ]);
  assert.deepEqual(result, {
    ok: true,
    reply: "Happy to talk.",
    state: "idle",
    events: [],
  });
});

test("Companion chat prompt explicitly describes its non-privileged limits", () => {
  assert.match(COMPANION_CHAT_SYSTEM_PROMPT, /non-privileged/i);
  assert.match(COMPANION_CHAT_SYSTEM_PROMPT, /cannot run commands/i);
  assert.match(COMPANION_CHAT_SYSTEM_PROMPT, /cannot.*use tools/i);
  assert.match(COMPANION_CHAT_SYSTEM_PROMPT, /Never claim.*performed an action/i);
});

test("Companion chat safely handles missing or unexpected model response shapes", async (t) => {
  const responses = [
    undefined,
    null,
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: null }] },
    { choices: [{ message: { content: null } }] },
    { choices: [{ message: { content: 42 } }] },
    { choices: [{ message: { content: "   " } }] },
  ];

  for (const response of responses) {
    await t.test(JSON.stringify(response) ?? "undefined", async () => {
      const { service } = createStubModelService(response);
      const result = await handleCompanionChat({
        message: "Hello",
        modelService: service,
      });

      assert.deepEqual(result, {
        ok: true,
        reply: COMPANION_CHAT_EMPTY_REPLY,
        state: "idle",
        events: [],
      });
    });
  }
});

test("Companion chat ignores model tool calls and never invokes them", async () => {
  let invoked = false;
  const toolCall = {
    function: {
      name: "shell_execute",
      arguments: "{}",
      invoke() {
        invoked = true;
      },
    },
  };
  const { service } = createStubModelService({
    choices: [{ message: { content: "", tool_calls: [toolCall] } }],
  });

  const result = await handleCompanionChat({
    message: "Run a command",
    modelService: service,
  });

  assert.equal(invoked, false);
  assert.equal(result.reply, COMPANION_CHAT_EMPTY_REPLY);
  assert.deepEqual(result.events, []);
});

test("Companion chat rejects invalid messages before calling the model", async () => {
  const { calls, service } = createStubModelService({});
  const invalidMessages = [undefined, 123, "   ", "x".repeat(COMPANION_CHAT_MAX_MESSAGE_CHARS + 1)];

  for (const message of invalidMessages) {
    await assert.rejects(
      () => handleCompanionChat({ message, modelService: service }),
      CompanionChatValidationError,
    );
  }

  assert.equal(calls.length, 0);
});

test("Companion chat propagates model failures for the server to sanitize", async () => {
  const failure = new Error("private model detail");
  const modelService = {
    async createChatCompletion() {
      throw failure;
    },
  };

  await assert.rejects(
    () => handleCompanionChat({ message: "Hello", modelService }),
    (error) => error === failure,
  );
});
