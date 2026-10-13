const test = require("node:test");
const assert = require("node:assert/strict");
const {
  APPEARANCE_THEMES,
  normalizeAppearanceTheme,
  createInitialPanelChromeState,
  setMenuOpen,
  selectAppearanceTheme,
} = require("./panelChromeState.cjs");

test("Mini Chat supports the three Selene appearance themes", () => {
  assert.deepEqual(APPEARANCE_THEMES, ["obsidian", "ruby", "sapphire"]);
  assert.equal(createInitialPanelChromeState().theme, "obsidian");

  for (const theme of APPEARANCE_THEMES) {
    assert.equal(normalizeAppearanceTheme(theme), theme);
  }

  assert.equal(normalizeAppearanceTheme("outdated"), "obsidian");
});

test("the header menu opens and closes independently of appearance", () => {
  const initial = createInitialPanelChromeState("ruby");
  const open = setMenuOpen(initial, true);
  const closed = setMenuOpen(open, false);

  assert.equal(open.menuOpen, true);
  assert.equal(open.theme, "ruby");
  assert.equal(closed.menuOpen, false);
  assert.equal(closed.theme, "ruby");
});

test("theme selection preserves menu state and safely recovers invalid values", () => {
  const open = setMenuOpen(createInitialPanelChromeState(), true);
  const sapphire = selectAppearanceTheme(open, "sapphire");
  const recovered = selectAppearanceTheme(sapphire, "legacy-theme");

  assert.equal(sapphire.theme, "sapphire");
  assert.equal(sapphire.menuOpen, true);
  assert.equal(recovered.theme, "obsidian");
});
