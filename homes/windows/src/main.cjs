
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const {
  WINDOW_STATE_FILENAME,
  captureWindowState,
  loadWindowState,
  recoverWindowBounds,
  saveWindowState
} = require('./windowState.cjs');
const {
  UI_PREFERENCES_FILENAME,
  createUiPreferencesStore
} = require('./uiPreferences.cjs');

const DEFAULT_WINDOW_BOUNDS = Object.freeze({
  width: 1200,
  height: 800
});

const WINDOW_STATE_SAVE_DELAY_MS = 250;

const SIDEBAR_GET_CHANNEL = 'selene:preferences:get-sidebar-collapsed';
const SIDEBAR_SET_CHANNEL = 'selene:preferences:set-sidebar-collapsed';
const THEME_GET_CHANNEL = 'selene:preferences:get-theme';
const THEME_SET_CHANNEL = 'selene:preferences:set-theme';

const NATIVE_THEME_COLORS = Object.freeze({
  obsidian: Object.freeze({ color: '#0e0d13', symbolColor: '#e8e5f0' }),
  ruby: Object.freeze({ color: '#160b0f', symbolColor: '#f4e8eb' }),
  sapphire: Object.freeze({ color: '#08111e', symbolColor: '#e8f0fa' })
});

function updateWindowTheme(win, theme) {
  if (!win || win.isDestroyed()) {
    return;
  }

  const colors = NATIVE_THEME_COLORS[theme] ?? NATIVE_THEME_COLORS.obsidian;
  try {
    win.setBackgroundColor(colors.color);
    if (typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay({ ...colors, height: 40 });
    }
  } catch (error) {
    console.warn(`Unable to update Selene native theme: ${error.message}`);
  }
}

function registerUiPreferenceHandlers(preferenceStore) {

  ipcMain.handle(SIDEBAR_GET_CHANNEL, () => preferenceStore.getSidebarCollapsed());
  ipcMain.handle(SIDEBAR_SET_CHANNEL, (_event, collapsed) => (
    preferenceStore.setSidebarCollapsed(collapsed)
  ));
  ipcMain.handle(THEME_GET_CHANNEL, () => preferenceStore.getTheme());
  ipcMain.handle(THEME_SET_CHANNEL, (_event, theme) => {
    const selectedTheme = preferenceStore.setTheme(theme);
    BrowserWindow.getAllWindows().forEach((win) => updateWindowTheme(win, selectedTheme));
    return selectedTheme;
  });
}

function persistWindowState(win, statePath) {
  if (win.isDestroyed()) {
    return;
  }

  const state = captureWindowState(win);
  if (!state) {
    return;
  }

  try {
    saveWindowState(statePath, state);
  } catch (error) {
    console.warn(`Unable to save Selene window state: ${error.message}`);
  }
}

function trackWindowState(win, statePath) {
  let saveTimer = null;

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistWindowState(win, statePath);
    }, WINDOW_STATE_SAVE_DELAY_MS);
    saveTimer.unref?.();
  };

  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    persistWindowState(win, statePath);
  });
}

function createWindow(preferenceStore) {
  const statePath = path.join(app.getPath('userData'), WINDOW_STATE_FILENAME);
  const savedState = loadWindowState(statePath);
  const theme = preferenceStore.getTheme();
  const nativeTheme = NATIVE_THEME_COLORS[theme] ?? NATIVE_THEME_COLORS.obsidian;
  const restoredBounds = savedState
    ? recoverWindowBounds(savedState.bounds, screen.getAllDisplays(), screen.getPrimaryDisplay())
    : null;

  const win = new BrowserWindow({
    ...DEFAULT_WINDOW_BOUNDS,
    ...restoredBounds,
    minWidth: 800,
    minHeight: 550,
    show: false,
    backgroundColor: nativeTheme.color,
    title: 'Selene',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: nativeTheme.color,
      symbolColor: nativeTheme.symbolColor,
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  trackWindowState(win, statePath);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (savedState?.isMaximized) {
      win.maximize();
    }
    win.show();
  });
}

app.whenReady().then(() => {
  const preferencePath = path.join(app.getPath('userData'), UI_PREFERENCES_FILENAME);
  const preferenceStore = createUiPreferencesStore(preferencePath);

  registerUiPreferenceHandlers(preferenceStore);
  createWindow(preferenceStore);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(preferenceStore);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
