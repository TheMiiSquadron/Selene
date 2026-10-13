const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_VERSION,
  createUiPreferencesStore,
  loadUiPreferences,
  migrateUiPreferences,
  normalizeUiPreferences
} = require('./uiPreferences.cjs');

function makeTempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-ui-preferences-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('sidebar starts expanded when no preference file exists', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');

  assert.deepEqual(loadUiPreferences(preferencePath), DEFAULT_UI_PREFERENCES);
  assert.equal(createUiPreferencesStore(preferencePath).getSidebarCollapsed(), false);
});

test('sidebar preference persists across store instances', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const firstStore = createUiPreferencesStore(preferencePath);

  assert.equal(firstStore.setSidebarCollapsed(true), true);
  assert.equal(createUiPreferencesStore(preferencePath).getSidebarCollapsed(), true);

  assert.equal(firstStore.setSidebarCollapsed(false), false);
  assert.equal(createUiPreferencesStore(preferencePath).getSidebarCollapsed(), false);
});

test('theme defaults to Obsidian and persists across store instances', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const firstStore = createUiPreferencesStore(preferencePath);

  assert.equal(firstStore.getTheme(), 'obsidian');
  assert.equal(firstStore.setTheme('ruby'), 'ruby');
  assert.equal(createUiPreferencesStore(preferencePath).getTheme(), 'ruby');

  assert.equal(firstStore.setTheme('sapphire'), 'sapphire');
  assert.equal(createUiPreferencesStore(preferencePath).getTheme(), 'sapphire');
});

test('theme and sidebar updates preserve each other', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const store = createUiPreferencesStore(preferencePath);

  store.setSidebarCollapsed(true);
  store.setTheme('ruby');

  const restored = createUiPreferencesStore(preferencePath);
  assert.equal(restored.getSidebarCollapsed(), true);
  assert.equal(restored.getTheme(), 'ruby');
});

test('missing, corrupt, and incompatible preferences fail safely to expanded', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');

  fs.writeFileSync(preferencePath, '{broken json', 'utf8');
  assert.deepEqual(loadUiPreferences(preferencePath), DEFAULT_UI_PREFERENCES);

  fs.writeFileSync(preferencePath, JSON.stringify({
    version: UI_PREFERENCES_VERSION + 1,
    sidebarCollapsed: true,
    theme: 'ruby'
  }), 'utf8');
  assert.deepEqual(loadUiPreferences(preferencePath), DEFAULT_UI_PREFERENCES);
});

test('version 1 preferences retain the sidebar choice and migrate to Obsidian', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const versionOne = { version: 1, sidebarCollapsed: true };
  fs.writeFileSync(preferencePath, JSON.stringify(versionOne), 'utf8');

  assert.deepEqual(loadUiPreferences(preferencePath), {
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true,
    theme: 'obsidian'
  });
  assert.deepEqual(migrateUiPreferences(versionOne), {
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true,
    theme: 'obsidian'
  });
});

test('invalid sidebar values are rejected without changing persisted state', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const store = createUiPreferencesStore(preferencePath);

  assert.throws(() => store.setSidebarCollapsed('true'), /must be a boolean/);
  assert.equal(store.getSidebarCollapsed(), false);
  assert.equal(fs.existsSync(preferencePath), false);
});

test('invalid themes are rejected without changing persisted state', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const store = createUiPreferencesStore(preferencePath);

  store.setTheme('ruby');
  assert.throws(() => store.setTheme('emerald'), /obsidian, ruby, or sapphire/);
  assert.equal(store.getTheme(), 'ruby');
  assert.equal(createUiPreferencesStore(preferencePath).getTheme(), 'ruby');
});

test('invalid saved themes recover to safe defaults', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  fs.writeFileSync(preferencePath, JSON.stringify({
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true,
    theme: 'emerald'
  }), 'utf8');

  assert.deepEqual(loadUiPreferences(preferencePath), DEFAULT_UI_PREFERENCES);
});

test('normalization accepts only the versioned preference shape', () => {
  assert.deepEqual(normalizeUiPreferences({
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true,
    theme: 'sapphire'
  }), {
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true,
    theme: 'sapphire'
  });
  assert.equal(normalizeUiPreferences({
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: 1,
    theme: 'obsidian'
  }), null);
  assert.equal(normalizeUiPreferences({
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: false,
    theme: 'invalid'
  }), null);
});
