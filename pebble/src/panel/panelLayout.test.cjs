const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const html = readFileSync(join(__dirname, "index.html"), "utf8");
const css = readFileSync(join(__dirname, "panel.css"), "utf8");

test("Chat is the default view and Device Pairing lives in the secondary view", () => {
  const chatView = html.indexOf('id="chat-view"');
  const devicesView = html.indexOf('id="devices-security-view"');
  const pairingCard = html.indexOf('id="pairing-card"');

  assert.ok(chatView >= 0);
  assert.ok(devicesView > chatView);
  assert.ok(pairingCard > devicesView);
  assert.match(html, /id="devices-security-view"[\s\S]*?hidden/);
  assert.doesNotMatch(
    html.slice(chatView, devicesView),
    /id="pairing-card"/,
  );
});

test("the accessible overflow menu owns secondary-view navigation and appearance", () => {
  assert.match(html, /id="header-menu-button"[\s\S]*?aria-haspopup="menu"[\s\S]*?aria-expanded="false"/);
  assert.match(html, /id="header-menu"[\s\S]*?role="menu"[\s\S]*?hidden/);
  assert.match(html, /role="menuitem"[\s\S]*?data-menu-action="devices-security"/);
  assert.equal((html.match(/role="menuitemradio"/g) ?? []).length, 3);
  assert.equal((html.match(/data-theme-choice="(obsidian|ruby|sapphire)"/g) ?? []).length, 3);
});

test("the overflow menu is opaque, readable, and anchored to its trigger", () => {
  assert.equal((css.match(/--menu-background:\s*#[0-9a-f]{6}/gi) ?? []).length, 3);
  assert.match(css, /\.panel-menu\s*\{[\s\S]*?right:\s*calc\(26px \+ 3px\)/);
  assert.match(css, /\.panel-menu\s*\{[\s\S]*?width:\s*200px/);
  assert.match(css, /\.panel-menu\s*\{[\s\S]*?var\(--menu-background\)/);
  assert.match(css, /\.panel-menu-item\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.match(css, /\.panel-menu-theme\[aria-checked="true"\]::after/);
});

test("the branded header exposes the current official state", () => {
  assert.match(html, /class="panel-brand-mark"[\s\S]*?aria-hidden="true"/);
  assert.match(html, /id="panel-status"[\s\S]*?aria-label="Idle: I'm here\."/);
  assert.match(html, /id="panel-status-text"[\s\S]*?Idle/);
});

test("Back to Chat and every existing pairing action remain available", () => {
  assert.match(html, /id="back-to-chat"[\s\S]*?aria-label="Back to Chat"/);

  for (const id of [
    "pairing-secure-core",
    "pairing-check",
    "pairing-start",
    "pairing-cancel",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
