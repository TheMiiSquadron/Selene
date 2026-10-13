const fs = require('node:fs');
const path = require('node:path');

const UI_PREFERENCES_FILENAME = 'ui-preferences.json';
const UI_PREFERENCES_VERSION = 2;
const SUPPORTED_THEMES = Object.freeze(['obsidian', 'ruby', 'sapphire']);
const DEFAULT_UI_PREFERENCES = Object.freeze({
  version: UI_PREFERENCES_VERSION,
  sidebarCollapsed: false,
  theme: 'obsidian'
});

function isSupportedTheme(value) {
  return SUPPORTED_THEMES.includes(value);
}

function normalizeUiPreferences(value) {
  if (
    !value
    || typeof value !== 'object'
    || value.version !== UI_PREFERENCES_VERSION
    || typeof value.sidebarCollapsed !== 'boolean'
    || !isSupportedTheme(value.theme)
  ) {
    return null;
  }

  return {
    version: UI_PREFERENCES_VERSION,
    sidebarCollapsed: value.sidebarCollapsed,
    theme: value.theme
  };
}

function migrateUiPreferences(value) {
  if (
    value
    && typeof value === 'object'
    && value.version === 1
    && typeof value.sidebarCollapsed === 'boolean'
  ) {
    return {
      version: UI_PREFERENCES_VERSION,
      sidebarCollapsed: value.sidebarCollapsed,
      theme: DEFAULT_UI_PREFERENCES.theme
    };
  }

  return null;
}

function loadUiPreferences(filePath, fileSystem = fs) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(filePath, 'utf8'));
    return normalizeUiPreferences(parsed)
      ?? migrateUiPreferences(parsed)
      ?? { ...DEFAULT_UI_PREFERENCES };
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

function saveUiPreferences(filePath, preferences, fileSystem = fs) {
  const normalized = normalizeUiPreferences(preferences);
  if (!normalized) {
    throw new TypeError('Refusing to save invalid UI preferences.');
  }

  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fileSystem.mkdirSync(directory, { recursive: true });

  try {
    fileSystem.writeFileSync(
      temporaryPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8'
    );
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

function createUiPreferencesStore(filePath, fileSystem = fs) {
  let preferences = loadUiPreferences(filePath, fileSystem);

  return {
    getSidebarCollapsed() {
      return preferences.sidebarCollapsed;
    },

    setSidebarCollapsed(collapsed) {
      if (typeof collapsed !== 'boolean') {
        throw new TypeError('Sidebar preference must be a boolean.');
      }

      const nextPreferences = {
        ...preferences,
        sidebarCollapsed: collapsed
      };
      saveUiPreferences(filePath, nextPreferences, fileSystem);
      preferences = nextPreferences;
      return preferences.sidebarCollapsed;
    },

    getTheme() {
      return preferences.theme;
    },

    setTheme(theme) {
      if (!isSupportedTheme(theme)) {
        throw new TypeError('Theme preference must be obsidian, ruby, or sapphire.');
      }

      const nextPreferences = {
        ...preferences,
        theme
      };
      saveUiPreferences(filePath, nextPreferences, fileSystem);
      preferences = nextPreferences;
      return preferences.theme;
    }
  };
}

module.exports = {
  DEFAULT_UI_PREFERENCES,
  UI_PREFERENCES_FILENAME,
  UI_PREFERENCES_VERSION,
  SUPPORTED_THEMES,
  createUiPreferencesStore,
  isSupportedTheme,
  loadUiPreferences,
  migrateUiPreferences,
  normalizeUiPreferences,
  saveUiPreferences
};
