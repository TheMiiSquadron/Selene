(function definePanelViewState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SelenePanelViewState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const PANEL_VIEWS = Object.freeze({
    CHAT: "chat",
    DEVICES_SECURITY: "devices-security",
  });

  function normalizePanelView(value) {
    return value === PANEL_VIEWS.DEVICES_SECURITY
      ? PANEL_VIEWS.DEVICES_SECURITY
      : PANEL_VIEWS.CHAT;
  }

  function createInitialPanelViewState() {
    return Object.freeze({ currentView: PANEL_VIEWS.CHAT });
  }

  function selectPanelView(state, view) {
    return Object.freeze({
      ...state,
      currentView: normalizePanelView(view),
    });
  }

  return Object.freeze({
    PANEL_VIEWS,
    normalizePanelView,
    createInitialPanelViewState,
    selectPanelView,
  });
});
