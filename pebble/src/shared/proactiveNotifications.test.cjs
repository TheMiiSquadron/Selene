const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeProactiveNotifications,
  shouldShowProactiveState,
} = require("./proactiveNotifications.cjs");

test("proactive notifications normalize and de-duplicate pending messages", () => {
  assert.deepEqual(normalizeProactiveNotifications([
    {
      id: "later",
      type: "proactive",
      message: "Later",
      createdAt: "2026-08-28T12:00:02.000Z",
      acknowledged: false,
    },
    {
      id: "earlier",
      type: "proactive",
      message: "Earlier",
      createdAt: "2026-08-28T12:00:01.000Z",
      acknowledged: false,
    },
    {
      id: "earlier",
      type: "proactive",
      message: "Duplicate",
      createdAt: "2026-08-28T12:00:03.000Z",
      acknowledged: false,
    },
    {
      id: "done",
      type: "proactive",
      message: "Acknowledged",
      createdAt: "2026-08-28T12:00:00.000Z",
      acknowledged: true,
    },
  ]).map((notification) => notification.id), ["earlier", "later"]);
});

test("proactive maps to canonical proactive state when idle-like states are active", () => {
  assert.equal(shouldShowProactiveState("idle", 1), "proactive");
  assert.equal(shouldShowProactiveState("success", 1), "proactive");
  assert.equal(shouldShowProactiveState("proactive", 1), "proactive");
});

test("working, asking, and error are not overwritten by proactive notifications", () => {
  assert.equal(shouldShowProactiveState("working", 1), "working");
  assert.equal(shouldShowProactiveState("asking", 1), "asking");
  assert.equal(shouldShowProactiveState("error", 1), "error");
});

test("no pending notification preserves the current state", () => {
  assert.equal(shouldShowProactiveState("idle", 0), "idle");
  assert.equal(shouldShowProactiveState("working", 0), "working");
});
