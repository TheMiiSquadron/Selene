
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

function registerUiPreferenceHandlers() {
  const preferencePath = path.join(app.getPath('userData'), UI_PREFERENCES_FILENAME);
  const preferenceStore = createUiPreferencesStore(preferencePath);

  ipcMain.handle(SIDEBAR_GET_CHANNEL, () => preferenceStore.getSidebarCollapsed());
  ipcMain.handle(SIDEBAR_SET_CHANNEL, (_event, collapsed) => (
    preferenceStore.setSidebarCollapsed(collapsed)
  ));
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

function createWindow() {
  const statePath = path.join(app.getPath('userData'), WINDOW_STATE_FILENAME);
  const savedState = loadWindowState(statePath);
  const restoredBounds = savedState
    ? recoverWindowBounds(savedState.bounds, screen.getAllDisplays(), screen.getPrimaryDisplay())
    : null;

  const win = new BrowserWindow({
    ...DEFAULT_WINDOW_BOUNDS,
    ...restoredBounds,
    minWidth: 800,
    minHeight: 550,
    show: false,
    backgroundColor: '#0e0d13',
    title: 'Selene',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0e0d13',
      symbolColor: '#e8e5f0',
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
  registerUiPreferenceHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
