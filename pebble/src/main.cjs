const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage } = require("electron");
const { PEBBLE_STATES, normalizePebbleState } = require("./shared/pebbleStates.cjs");
const {
  normalizeProactiveNotifications,
  shouldShowProactiveState,
} = require("./shared/proactiveNotifications.cjs");
const { createCoreLifecycle } = require("./coreLifecycle.cjs");

const PEBBLE_WINDOW = { width: 72, height: 64 };
const PANEL_WINDOW = { width: 360, minHeight: 152, maxHeight: 420 };
const SETUP_WINDOW = { width: 860, height: 620 };
const CURSOR_OFFSET_X = 30;
const CURSOR_OFFSET_Y = 36;
const FOLLOW_FACTOR = 0.20;
const FRAME_MS = 16;
const NOTIFICATION_POLL_MS = 4000;
const PANEL_MARGIN = 18;
const USER_DATA_DIR = path.join(os.tmpdir(), `nova-pebble-electron-${process.pid}`);
const NOVA_CORE_COMMAND_URL = "http://127.0.0.1:3030/command";
const NOVA_CORE_BASE_URL = "http://127.0.0.1:3030";
const SETUP_VERSION = 1;
const TRAY_ASSET_DIR = path.join(__dirname, "..", "assets", "tray");
const coreLifecycle = createCoreLifecycle({ coreBaseUrl: NOVA_CORE_BASE_URL });
const LIFECYCLE_QUIT_TIMEOUT_MS = 2500;

fs.mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath("userData", USER_DATA_DIR);
app.commandLine.appendSwitch("disk-cache-dir", path.join(USER_DATA_DIR, "Cache"));

let pebbleWindow;
let panelWindow;
let setupWindow;
let tray;
let isQuitting = false;
let lifecycleShutdownStarted = false;
let panelReady = false;
let cursorOnPebble = false;
let requestedPebbleState = "idle";
let currentPebbleState = "idle";
let currentX = 0;
let currentY = 0;
let timer;
let notificationTimer;
const trayImages = new Map();
const pendingProactiveNotifications = new Map();

const AUTHORITY_LEVELS = [
  { level: 1, title: "Observe", description: "read system state" },
  { level: 2, title: "Inspect", description: "inspect context / files" },
  { level: 3, title: "Open", description: "open_app, open_url, open_path" },
  { level: 4, title: "Assist", description: "volume, media, window focus/minimize/maximize" },
  { level: 5, title: "Operate", description: "type_text, keyboard shortcuts, UI click" },
  { level: 6, title: "Manage Files", description: "file creation/move/rename, approved command tools" },
  { level: 7, title: "Communicate", description: "send_message, send_email, submit external forms" },
  { level: 8, title: "Maintain", description: "install/update/uninstall software" },
  { level: 9, title: "Configure", description: "delete data, modify system configuration" },
  { level: 10, title: "Critical", description: "payments, credentials/security, major irreversible actions" },
];

const DEFAULT_CONFIG = {
  user: {
    displayName: "",
  },
  ai: {
    coreUrl: NOVA_CORE_BASE_URL,
    lmStudioUrl: "",
    activeModel: "",
    selectedModel: "",
    modelSelectionEnabled: false,
  },
  applications: {
    source: "core",
    permissionsSource: "selene-core",
  },
  interface: {
    systemTray: true,
    pebbleEnabled: true,
    startWithWindows: false,
    pebbleVisibility: "always",
    globalShortcut: "CommandOrControl+Space",
  },
  privacy: {
    activeWindowName: "allow",
    clipboard: "ask",
    selectedText: "ask",
    screenContents: "deny",
    microphone: "deny",
  },
  authority: {
    defaultLevel: 4,
  },
  personality: {
    preset: "natural",
    humorOccasionally: true,
    acknowledgeCompletedTasks: true,
    explainRoutineActions: false,
    askWhenUncertain: true,
    identity:
      "Calm, perceptive, capable, warm, lightly witty, concise during routine actions, honest about uncertainty, and non-intrusive.",
  },
  memory: {
    preferences: true,
    appAliases: true,
    projects: false,
    conversationFacts: false,
    scaffoldingOnly: true,
  },
  setup: {
    completed: false,
    version: SETUP_VERSION,
    completedAt: null,
    updatedAt: null,
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(defaults, loaded) {
  if (!isPlainObject(loaded)) return structuredClone(defaults);

  const merged = structuredClone(defaults);
  for (const [key, value] of Object.entries(loaded)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeConfig(merged[key], value);
    } else if (key in merged) {
      merged[key] = value;
    }
  }
  return validateConfig(merged);
}

function validatePolicy(value, fallback) {
  return ["allow", "ask", "deny"].includes(value) ? value : fallback;
}

function validateConfig(config) {
  const next = structuredClone(config);
  next.user.displayName = String(next.user.displayName ?? "").slice(0, 80);
  next.ai.coreUrl = NOVA_CORE_BASE_URL;
  next.ai.lmStudioUrl = "";
  next.ai.activeModel = "";
  next.ai.selectedModel = "";
  next.ai.modelSelectionEnabled = false;
  next.applications.source = "core";
  next.applications.permissionsSource = "selene-core";
  delete next.applications.allowed;
  next.interface.systemTray = Boolean(next.interface.systemTray);
  next.interface.pebbleEnabled = Boolean(next.interface.pebbleEnabled);
  next.interface.startWithWindows = Boolean(next.interface.startWithWindows);
  next.interface.pebbleVisibility = next.interface.pebbleVisibility === "summon" ? "summon" : "always";
  next.interface.globalShortcut = String(next.interface.globalShortcut ?? "").slice(0, 80);
  next.privacy.activeWindowName = validatePolicy(next.privacy.activeWindowName, "allow");
  next.privacy.clipboard = validatePolicy(next.privacy.clipboard, "ask");
  next.privacy.selectedText = validatePolicy(next.privacy.selectedText, "ask");
  next.privacy.screenContents = validatePolicy(next.privacy.screenContents, "deny");
  next.privacy.microphone = validatePolicy(next.privacy.microphone, "deny");
  next.authority.defaultLevel = clamp(Number.parseInt(next.authority.defaultLevel, 10) || 4, 1, 10);
  next.personality.preset = ["professional", "friendly", "natural", "minimal"].includes(next.personality.preset)
    ? next.personality.preset
    : "natural";
  next.memory.scaffoldingOnly = true;
  next.setup.completed = Boolean(next.setup.completed);
  next.setup.version = SETUP_VERSION;
  return next;
}

function getConfigPath() {
  return path.join(app.getPath("appData"), "Selene Pebble", "config.json");
}

function getLegacyConfigPath() {
  return path.join(app.getPath("appData"), "NOVA Pebble", "config.json");
}

function loadConfig() {
  const configPath = getConfigPath();
  const legacyConfigPath = getLegacyConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyConfigPath, "utf-8"));
      const migrated = mergeConfig(DEFAULT_CONFIG, parsed);
      saveConfig(migrated, { completed: migrated.setup.completed });
      return migrated;
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }
}

function saveConfig(config, { completed = false } = {}) {
  const configPath = getConfigPath();
  const next = validateConfig(config);
  next.setup.updatedAt = new Date().toISOString();
  if (completed) {
    next.setup.completed = true;
    next.setup.completedAt = next.setup.completedAt || next.setup.updatedAt;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

async function syncAwarenessConfig(config) {
  try {
    await fetch(`${NOVA_CORE_BASE_URL}/awareness/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeWindowName: validateConfig(config).privacy.activeWindowName,
      }),
    });
  } catch {
    // Core may be offline during Setup. It will remain usable and can sync later.
  }
}

function shouldForceSetup() {
  return process.argv.includes("--setup") || process.env.NOVA_FORCE_SETUP === "1";
}


function loadTrayImages() {
  if (trayImages.size > 0) return;

  for (const state of PEBBLE_STATES) {
    const imagePath = path.join(TRAY_ASSET_DIR, `tray-moon-${state.id}.png`);
    try {
      const image = nativeImage.createFromPath(imagePath);
      if (!image.isEmpty()) {
        trayImages.set(state.id, image.resize({ width: 16, height: 16 }));
      }
    } catch {
      // Tray artwork is visual-only; keep Selene running if an asset is missing.
    }
  }
}

function createTrayIcon(state = currentPebbleState) {
  loadTrayImages();
  return trayImages.get(normalizePebbleState(state))
    ?? trayImages.get("idle")
    ?? nativeImage.createEmpty();
}

function setTrayPebbleState(state) {
  const normalized = normalizePebbleState(state);
  if (!tray || tray.isDestroyed()) return;

  const image = createTrayIcon(normalized);
  if (!image.isEmpty()) {
    tray.setImage(image);
  }
}

function getVisiblePebbleState() {
  return normalizePebbleState(shouldShowProactiveState(
    requestedPebbleState,
    pendingProactiveNotifications.size,
  ));
}

function applyPebbleVisualState() {
  const visibleState = getVisiblePebbleState();
  currentPebbleState = visibleState;

  if (pebbleWindow && !pebbleWindow.isDestroyed()) {
    pebbleWindow.webContents.send("nova-pebble:set-state", visibleState);
  }

  setTrayPebbleState(visibleState);
}

function publishPebbleState(state) {
  requestedPebbleState = normalizePebbleState(state);
  applyPebbleVisualState();
}

function getPendingNotificationList() {
  return [...pendingProactiveNotifications.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function sendPendingNotificationsToPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;

  const notifications = getPendingNotificationList();
  if (!notifications.length) return;

  panelWindow.webContents.send("nova-panel:proactive-notifications", notifications);
}

async function fetchCoreNotifications() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);

  try {
    const response = await fetch(`${NOVA_CORE_BASE_URL}/notifications`, {
      signal: controller.signal,
    });
    if (!response.ok) return;

    const payload = await response.json().catch(() => null);
    const notifications = normalizeProactiveNotifications(payload?.notifications);

    pendingProactiveNotifications.clear();
    for (const notification of notifications) {
      pendingProactiveNotifications.set(notification.id, notification);
    }

    applyPebbleVisualState();

    if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
      sendPendingNotificationsToPanel();
    }
  } catch {
    // Core may be offline. Polling is quiet and will recover on the next successful check.
  } finally {
    clearTimeout(timeout);
  }
}

async function acknowledgeCoreNotification(id) {
  const notificationId = String(id ?? "").trim();
  if (!notificationId) {
    return { ok: false, message: "Notification ID is required." };
  }

  try {
    const response = await fetch(
      `${NOVA_CORE_BASE_URL}/notifications/${encodeURIComponent(notificationId)}/acknowledge`,
      { method: "POST" },
    );
    const payload = await response.json().catch(() => null);

    if (response.ok && payload?.ok !== false) {
      pendingProactiveNotifications.delete(notificationId);
      applyPebbleVisualState();
    }

    return {
      ...(payload ?? {}),
      ok: response.ok && payload?.ok !== false,
      message: payload?.message ?? (response.ok ? "Notification acknowledged." : `Selene Core returned HTTP ${response.status}.`),
    };
  } catch {
    return { ok: false, message: "Selene Core is offline." };
  }
}

function startNotificationPolling() {
  if (notificationTimer) return;

  void fetchCoreNotifications();
  notificationTimer = setInterval(() => {
    void fetchCoreNotifications();
  }, NOTIFICATION_POLL_MS);
}

function stopNotificationPolling() {
  if (!notificationTimer) return;
  clearInterval(notificationTimer);
  notificationTimer = undefined;
}

async function getCoreTrayStatus() {
  const status = await coreLifecycle.checkAvailability();
  if (!status.reachable) return "Offline";
  return status.owned ? "Online (owned)" : "Online";
}

function setPebbleEnabled(enabled, { persist = true } = {}) {
  const nextEnabled = Boolean(enabled);

  if (nextEnabled) {
    if (!pebbleWindow || pebbleWindow.isDestroyed()) {
      createPebbleWindow();
    } else {
      snapToCursor();
      pebbleWindow.showInactive();
      followCursor();
    }
  } else if (pebbleWindow && !pebbleWindow.isDestroyed()) {
    pebbleWindow.hide();
  }

  if (persist) {
    const config = loadConfig();
    config.interface.pebbleEnabled = nextEnabled;
    saveConfig(config, { completed: config.setup.completed });
  }
}

function buildTrayMenu(coreStatus = "Checking…") {
  const config = loadConfig();

  return Menu.buildFromTemplate([
    {
      label: "Open Selene",
      click: () => openPanel(),
    },
    {
      label: "Show Pebble",
      type: "checkbox",
      checked: Boolean(config.interface.pebbleEnabled),
      click: (item) => {
        setPebbleEnabled(Boolean(item.checked));
        void refreshTrayMenu();
      },
    },
    {
      label: `Core status: ${coreStatus}`,
      enabled: false,
    },
    {
      label: "Settings…",
      click: () => createSetupWindow(),
    },
    { type: "separator" },
    {
      label: "Quit Selene",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

async function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;

  const status = await getCoreTrayStatus();
  if (!tray || tray.isDestroyed()) return;

  tray.setToolTip(`Selene — Core ${status.toLowerCase()}`);
  tray.setContextMenu(buildTrayMenu(status));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;

  tray = new Tray(createTrayIcon());
  tray.setToolTip("Selene");
  tray.setContextMenu(buildTrayMenu());
  setTrayPebbleState(currentPebbleState);

  tray.on("click", () => {
    openPanel();
  });

  tray.on("right-click", async () => {
    await refreshTrayMenu();
    if (tray && !tray.isDestroyed()) {
      tray.popUpContextMenu();
    }
  });

  void refreshTrayMenu();
}

function destroyTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.destroy();
  tray = undefined;
}

function applyInterfaceConfig(config = loadConfig()) {
  if (config.interface.systemTray) {
    createTray();
  } else {
    destroyTray();
  }

  setPebbleEnabled(config.interface.pebbleEnabled, { persist: false });
}

function targetBounds() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const work = display.workArea;

  const x = cursor.x + CURSOR_OFFSET_X - 4;
  const y = cursor.y + CURSOR_OFFSET_Y - 4;

  return {
    x: clamp(Math.round(x), work.x, work.x + work.width - PEBBLE_WINDOW.width),
    y: clamp(Math.round(y), work.y, work.y + work.height - PEBBLE_WINDOW.height),
    width: PEBBLE_WINDOW.width,
    height: PEBBLE_WINDOW.height
  };
}

function snapToCursor() {
  const bounds = targetBounds();
  currentX = bounds.x;
  currentY = bounds.y;
  pebbleWindow.setBounds(bounds, false);
}

function followCursor() {
  if (timer) return;
  snapToCursor();

  timer = setInterval(() => {
    if (!pebbleWindow || pebbleWindow.isDestroyed()) return;
    if (cursorOnPebble) return;

    const target = targetBounds();
    currentX += (target.x - currentX) * FOLLOW_FACTOR;
    currentY += (target.y - currentY) * FOLLOW_FACTOR;
    pebbleWindow.setBounds({
      x: Math.round(currentX),
      y: Math.round(currentY),
      width: target.width,
      height: target.height
    }, false);
  }, FRAME_MS);
}

function getPanelBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const height = panelWindow && !panelWindow.isDestroyed()
    ? panelWindow.getBounds().height
    : PANEL_WINDOW.minHeight;

  return {
    x: workArea.x + workArea.width - PANEL_WINDOW.width - PANEL_MARGIN,
    y: workArea.y + workArea.height - height - PANEL_MARGIN,
    width: PANEL_WINDOW.width,
    height
  };
}

function resizePanelToContent(contentHeight) {
  if (!panelWindow || panelWindow.isDestroyed()) return;

  const { workArea } = screen.getPrimaryDisplay();
  const current = panelWindow.getBounds();
  const height = clamp(
    Math.ceil(Number(contentHeight) || PANEL_WINDOW.minHeight),
    PANEL_WINDOW.minHeight,
    Math.min(PANEL_WINDOW.maxHeight, workArea.height - PANEL_MARGIN * 2),
  );

  panelWindow.setBounds({
    x: workArea.x + workArea.width - PANEL_WINDOW.width - PANEL_MARGIN,
    y: workArea.y + workArea.height - height - PANEL_MARGIN,
    width: current.width,
    height,
  }, false);

  panelWindow.webContents.send("nova-panel:resize-state", {
    height,
    maxHeight: height >= PANEL_WINDOW.maxHeight,
  });
}

function createPebbleWindow() {
  pebbleWindow = new BrowserWindow({
    width: PEBBLE_WINDOW.width,
    height: PEBBLE_WINDOW.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: "Selene Pebble",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  pebbleWindow.setAlwaysOnTop(true, "screen-saver");
  pebbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pebbleWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  pebbleWindow.once("ready-to-show", () => {
    snapToCursor();
    if (loadConfig().interface.pebbleEnabled) {
      pebbleWindow.showInactive();
      followCursor();
    }
  });

  pebbleWindow.on("closed", () => {
    pebbleWindow = undefined;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}

function createPanelWindow() {
  panelReady = false;
  panelWindow = new BrowserWindow({
    width: PANEL_WINDOW.width,
    height: PANEL_WINDOW.minHeight,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: "Selene Command Panel",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  panelWindow.setAlwaysOnTop(true, "floating");
  panelWindow.loadFile(path.join(__dirname, "panel", "index.html"));
  panelWindow.webContents.once("did-finish-load", () => {
    panelReady = true;
  });
  panelWindow.on("blur", () => {
    // Keep the prototype panel stationary; do not auto-dismiss on blur.
  });
  panelWindow.on("closed", () => {
    panelWindow = undefined;
    panelReady = false;
  });
}

function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: SETUP_WINDOW.width,
    height: SETUP_WINDOW.height,
    minWidth: 760,
    minHeight: 560,
    frame: true,
    transparent: false,
    backgroundColor: "#edf1f5",
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Selene Setup",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  setupWindow.loadFile(path.join(__dirname, "setup", "index.html"));
  setupWindow.once("ready-to-show", () => {
    setupWindow.show();
    setupWindow.focus();
  });
  setupWindow.on("closed", () => {
    setupWindow = undefined;
  });
}

function openPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) {
    createPanelWindow();
  }
  const showPanel = () => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    panelWindow.setBounds(getPanelBounds(), false);
    panelWindow.show();
    panelWindow.focus();
    panelWindow.webContents.send("nova-panel:opened");
    sendPendingNotificationsToPanel();
    panelWindow.webContents.send("nova-panel:request-height");
  };

  if (panelReady) {
    showPanel();
  } else {
    panelWindow.webContents.once("did-finish-load", showPanel);
  }
}

function closePanel() {
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return;
  panelWindow.webContents.send("nova-panel:closing");
  setTimeout(() => {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.hide();
    }
  }, 150);
}

function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    closePanel();
  } else {
    openPanel();
  }
}

ipcMain.handle("nova-pebble:toggle-panel", () => {
  togglePanel();
});

ipcMain.handle("nova-pebble:set-hovered", (_event, hovered) => {
  cursorOnPebble = Boolean(hovered);
});

ipcMain.handle("nova-panel:close", () => {
  closePanel();
});

ipcMain.handle("nova-panel:set-state", (_event, state) => {
  publishPebbleState(state);
});

ipcMain.handle("nova-panel:resize-to-content", (_event, contentHeight) => {
  resizePanelToContent(contentHeight);
});

ipcMain.handle("nova-panel:submit-command", async (_event, request) => {
  const payload = typeof request === "object" && request
    ? request
    : { text: request };

  try {
    const response = await fetch(NOVA_CORE_COMMAND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: String(payload.text ?? ""),
        ...(typeof payload.authorityToken === "string" && payload.authorityToken
          ? { authorityToken: payload.authorityToken }
          : {}),
      }),
    });

    const responsePayload = await response.json().catch(() => null);

    return {
      ...(responsePayload ?? {}),
      ok: Boolean(responsePayload?.ok),
      message: responsePayload?.message ?? `Selene Core returned HTTP ${response.status}.`,
    };
  } catch {
    return {
      ok: false,
      message: "Selene Core is offline.",
    };
  }
});

ipcMain.handle("nova-panel:get-authority", async () => {
  try {
    const response = await fetch(`${NOVA_CORE_BASE_URL}/authority`);
    const payload = await response.json().catch(() => null);
    return {
      ...(payload ?? {}),
      ok: Boolean(payload?.ok),
      message: payload?.message ?? `Selene Core returned HTTP ${response.status}.`,
    };
  } catch {
    return { ok: false, message: "Selene Core is offline." };
  }
});

ipcMain.handle("nova-panel:elevate-authority", async (_event, request) => {
  const level = Number(request?.level);
  const minutes = Number(request?.minutes);
  const oneAction = Boolean(request?.oneAction);

  if (!Number.isInteger(level) || level < 1 || level > 10) {
    return { ok: false, message: "Authority level must be between 1 and 10." };
  }

  if (!oneAction && (![5, 15, 30].includes(minutes))) {
    return { ok: false, message: "Choose a supported temporary approval duration." };
  }

  try {
    const response = await fetch(`${NOVA_CORE_BASE_URL}/authority/elevate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(oneAction ? { level, oneAction: true } : { level, minutes }),
    });
    const payload = await response.json().catch(() => null);
    return {
      ...(payload ?? {}),
      ok: Boolean(payload?.ok),
      message: payload?.message ?? (response.ok ? "Authority updated." : `Selene Core returned HTTP ${response.status}.`),
    };
  } catch {
    return { ok: false, message: "Selene Core is offline. Approval was not applied." };
  }
});

ipcMain.handle("nova-panel:acknowledge-notification", async (_event, id) => {
  return acknowledgeCoreNotification(id);
});

ipcMain.handle("nova-setup:get-initial-state", async () => {
  const config = loadConfig();
  return {
    config,
    configPath: getConfigPath(),
    authorityLevels: AUTHORITY_LEVELS,
    coreApi: {
      baseUrl: NOVA_CORE_BASE_URL,
      command: "/command",
      endpoints: [
        "GET /status -> { ok, coreVersion, lmStudio, model, activeModel, models, modelSelectionEnabled, port }",
        "GET /applications -> { ok, applications: [{ id, canonicalName, name, aliases, enabled, allowed, type }] }",
        "POST /applications/permissions -> persists launch permissions in Selene Core",
      ],
    },
  };
});

ipcMain.handle("nova-setup:save-draft", async (_event, config) => {
  const saved = saveConfig(config, { completed: false });
  applyInterfaceConfig(saved);
  await syncAwarenessConfig(saved);
  return saved;
});

ipcMain.handle("nova-setup:complete", async (_event, config) => {
  const saved = saveConfig(config, { completed: true });
  applyInterfaceConfig(saved);
  await syncAwarenessConfig(saved);
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
  }
  return saved;
});

ipcMain.handle("nova-setup:test-shortcut", (_event, accelerator) => {
  const value = String(accelerator ?? "").trim();
  if (!value) return { ok: false, message: "Enter a shortcut first." };

  try {
    const ok = globalShortcut.register(value, () => {});
    if (ok) {
      globalShortcut.unregister(value);
      return { ok: true, message: "Shortcut registered successfully for this test." };
    }
    return { ok: false, message: "Electron could not register that shortcut." };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

ipcMain.handle("nova-setup:check-local-ai", async () => {
  const result = {
    core: {
      ok: false,
      online: false,
      coreVersion: "",
      port: null,
      message: "Selene Core is offline.",
    },
    lmStudio: {
      ok: false,
      available: false,
      message: "LM Studio status is unavailable because Selene Core is offline.",
    },
    activeModel: "",
    models: [],
    modelSelectionEnabled: false,
    missingCoreEndpoints: [],
  };

  try {
    const response = await fetch(`${NOVA_CORE_BASE_URL}/status`);
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const lmStudio = Boolean(payload?.lmStudio);
      const model = String(payload?.model ?? payload?.activeModel ?? "");
      result.core = {
        ok: Boolean(payload?.ok ?? true),
        online: true,
        coreVersion: String(payload?.coreVersion ?? "unknown"),
        port: Number(payload?.port) || null,
        message: `Selene Core ${payload?.coreVersion ?? "unknown"} is online on port ${payload?.port ?? "unknown"}.`,
      };
      result.lmStudio = {
        ok: lmStudio && Boolean(model),
        available: lmStudio,
        message: lmStudio
          ? (model ? "LM Studio is reachable and a model is active." : "LM Studio is reachable, but no active model was returned.")
          : "Selene Core is online, but LM Studio or its model is unavailable.",
      };
      result.activeModel = model;
      result.models = Array.isArray(payload?.models) ? payload.models.map(String) : [];
      result.modelSelectionEnabled = Boolean(payload?.modelSelectionEnabled);
    } else if (response.status === 404) {
      result.core = {
        ok: false,
        online: true,
        coreVersion: "",
        port: null,
        message: "Selene Core is reachable, but GET /status is not implemented yet.",
      };
      result.lmStudio = {
        ok: false,
        available: false,
        message: "LM Studio status is unavailable until Selene Core exposes GET /status.",
      };
      result.missingCoreEndpoints.push("GET /status");
    } else {
      result.core = {
        ok: false,
        online: true,
        coreVersion: "",
        port: null,
        message: `Selene Core returned HTTP ${response.status} for /status.`,
      };
      result.lmStudio = {
        ok: false,
        available: false,
        message: "LM Studio status was not available from Selene Core.",
      };
    }
  } catch {
    result.core = {
      ok: false,
      online: false,
      coreVersion: "",
      port: null,
      message: "Selene Core is offline.",
    };
  }

  return result;
});

ipcMain.handle("nova-setup:get-applications", async () => {
  try {
    const response = await fetch(`${NOVA_CORE_BASE_URL}/applications`);
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      return {
        ok: true,
        applications: Array.isArray(payload?.applications) ? payload.applications : [],
        message: "Applications loaded from Selene Core.",
        missingEndpoint: "",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        applications: [],
        message: "Selene Core is reachable, but it does not expose applications yet.",
        missingEndpoint: "GET /applications",
      };
    }
    return {
      ok: false,
      applications: [],
      message: `Selene Core returned HTTP ${response.status} for applications.`,
      missingEndpoint: "GET /applications",
    };
  } catch {
    return {
      ok: false,
      applications: [],
      message: "Selene Core is offline.",
      missingEndpoint: "GET /applications",
    };
  }
});

ipcMain.handle("nova-setup:set-application-permissions", async (_event, applications) => {
  try {
    const response = await fetch(`${NOVA_CORE_BASE_URL}/applications/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applications: applications && typeof applications === "object" ? applications : {} }),
    });
    const payload = await response.json().catch(() => null);
    return {
      ok: Boolean(payload?.ok),
      applications: Array.isArray(payload?.applications) ? payload.applications : [],
      message: payload?.message ?? (response.ok ? "Application permissions saved." : `Selene Core returned HTTP ${response.status}.`),
    };
  } catch {
    return {
      ok: false,
      applications: [],
      message: "Selene Core is offline. Application permissions were not saved.",
    };
  }
});

ipcMain.handle("nova-setup:test-command", async (_event, text) => {
  try {
    const response = await fetch(NOVA_CORE_COMMAND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(text ?? "") }),
    });
    const payload = await response.json().catch(() => null);
    return {
      ok: Boolean(payload?.ok),
      message: payload?.message ?? `Selene Core returned HTTP ${response.status}.`,
    };
  } catch {
    return { ok: false, message: "Selene Core is offline." };
  }
});

app.whenReady().then(() => {
  const config = loadConfig();

  createPebbleWindow();
  createPanelWindow();
  applyInterfaceConfig(config);
  startNotificationPolling();
  void syncAwarenessConfig(config);

  if (shouldForceSetup() || !config.setup.completed) {
    createSetupWindow();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("before-quit", (event) => {
  if (lifecycleShutdownStarted) return;

  event.preventDefault();
  isQuitting = true;
  lifecycleShutdownStarted = true;
  const timeout = new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        state: "shutdown-timeout",
        message: "Timed out while waiting for Pebble-owned Core shutdown during quit.",
      });
    }, LIFECYCLE_QUIT_TIMEOUT_MS);
  });

  void Promise.race([coreLifecycle.shutdownOwnedCore(), timeout])
    .then((status) => {
      if (!["no-owned-core", "owned-stopped"].includes(status?.state)) {
        console.error(`Selene Core lifecycle cleanup incomplete: ${status?.message ?? "unknown failure"}`);
      }
    })
    .catch((error) => {
      console.error(`Selene Core lifecycle cleanup failed: ${error?.message ?? error}`);
    })
    .finally(() => {
      app.quit();
    });
});

app.on("window-all-closed", () => {
  // On Windows, keep Selene resident while the tray exists.
  // Quitting from the tray still exits normally.
  if (process.platform !== "darwin" && (isQuitting || !tray || tray.isDestroyed())) {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopNotificationPolling();
  destroyTray();
});
