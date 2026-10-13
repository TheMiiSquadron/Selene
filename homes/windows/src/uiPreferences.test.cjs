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

test('missing, corrupt, and incompatible preferences fail safely to expanded', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');

  fs.writeFileSync(preferencePath, '{broken json', 'utf8');
  assert.deepEqual(loadUiPreferences(preferencePath), DEFAULT_UI_PREFERENCES);

  fs.writeFileSync(preferencePath, JSON.stringify({
    version: UI_PREFERENCES_VERSION + 1,
    sidebarCollapsed: true
  }), 'utf8');
  assert.deepEqual(loadUiPreferences(preferencePath), DEFAULT_UI_PREFERENCES);
});

test('invalid sidebar values are rejected without changing persisted state', (t) => {
  const preferencePath = path.join(makeTempDirectory(t), 'ui-preferences.json');
  const store = createUiPreferencesStore(preferencePath);

  assert.throws(() => store.setSidebarCollapsed('true'), /must be a boolean/);
  assert.equal(store.getSidebarCollapsed(), false);
  assert.equal(fs.existsSync(preferencePath), false);
});

test('normalization accepts only the versioned preference shape', () => {
  assert.deepEqual(normalizeUiPreferences({
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true
  }), {
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: true
  });
  assert.equal(normalizeUiPreferences({
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: 1
  }), null);
});
