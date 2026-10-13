(function definePanelChromeState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SelenePanelChromeState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const APPEARANCE_THEMES = Object.freeze([
    "obsidian",
    "ruby",
    "sapphire",
  ]);

  function normalizeAppearanceTheme(value) {
    return APPEARANCE_THEMES.includes(value) ? value : "obsidian";
  }

  function createInitialPanelChromeState(theme = "obsidian") {
    return Object.freeze({
      menuOpen: false,
      theme: normalizeAppearanceTheme(theme),
    });
  }

  function setMenuOpen(state, menuOpen) {
    return Object.freeze({
      ...state,
      menuOpen: Boolean(menuOpen),
    });
  }

  function selectAppearanceTheme(state, theme) {
    return Object.freeze({
      ...state,
      theme: normalizeAppearanceTheme(theme),
    });
  }

  return Object.freeze({
    APPEARANCE_THEMES,
    normalizeAppearanceTheme,
    createInitialPanelChromeState,
    setMenuOpen,
    selectAppearanceTheme,
  });
});
