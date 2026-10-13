const test = require("node:test");
const assert = require("node:assert/strict");
const { PEBBLE_STATES } = require("./pebbleStates.cjs");

test("Mini Chat receives the six official Pebble state definitions unchanged", () => {
  assert.deepEqual(PEBBLE_STATES, [
    { id: "idle", label: "Idle", meaning: "I'm here.", color: "#DDEBFF", bloom: "#F4FAFF", halo: "#8AA7D8" },
    { id: "working", label: "Working", meaning: "I'm working.", color: "#2D78FF", bloom: "#A9D1FF", halo: "#1E5FD8" },
    { id: "success", label: "Success", meaning: "Done.", color: "#2FA45E", bloom: "#A7E7C0", halo: "#217547" },
    { id: "asking", label: "Asking", meaning: "I need you.", color: "#EAA40E", bloom: "#FFD98A", halo: "#B87508" },
    { id: "error", label: "Error", meaning: "I couldn't / won't proceed.", color: "#E63B2E", bloom: "#FFAAA3", halo: "#C2301F" },
    { id: "proactive", label: "Proactive", meaning: "I have something for you.", color: "#8B7CFF", bloom: "#B8AFFF", halo: "#6E67E8" },
  ]);
});
