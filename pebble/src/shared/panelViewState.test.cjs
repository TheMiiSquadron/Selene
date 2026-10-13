const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PANEL_VIEWS,
  normalizePanelView,
  createInitialPanelViewState,
  selectPanelView,
} = require("./panelViewState.cjs");

test("Mini Chat defaults to the Chat view", () => {
  const state = createInitialPanelViewState();

  assert.equal(state.currentView, PANEL_VIEWS.CHAT);
});

test("Devices & Security can be opened and returns to Chat", () => {
  const devices = selectPanelView(
    createInitialPanelViewState(),
    PANEL_VIEWS.DEVICES_SECURITY,
  );
  const chat = selectPanelView(devices, PANEL_VIEWS.CHAT);

  assert.equal(devices.currentView, PANEL_VIEWS.DEVICES_SECURITY);
  assert.equal(chat.currentView, PANEL_VIEWS.CHAT);
});

test("invalid view requests fail safely to Chat without discarding other state", () => {
  const pairingState = Object.freeze({ phase: "active" });
  const messages = Object.freeze(["Hello"]);
  const state = Object.freeze({
    currentView: PANEL_VIEWS.DEVICES_SECURITY,
    pairingState,
    messages,
  });

  assert.equal(normalizePanelView("unknown"), PANEL_VIEWS.CHAT);

  const next = selectPanelView(state, "unknown");
  assert.equal(next.currentView, PANEL_VIEWS.CHAT);
  assert.equal(next.pairingState, pairingState);
  assert.equal(next.messages, messages);
});
