const { contextBridge, ipcRenderer } = require("electron");
const {
  PEBBLE_STATES,
  PEBBLE_STATE_ALIASES,
  normalizePebbleState,
} = require("./shared/pebbleStates.cjs");

contextBridge.exposeInMainWorld("novaPebble", {
  getStateDefinitions() {
    return {
      states: PEBBLE_STATES,
      aliases: PEBBLE_STATE_ALIASES,
    };
  },
  togglePanel() {
    return ipcRenderer.invoke("nova-pebble:toggle-panel");
  },
  setHovered(hovered) {
    return ipcRenderer.invoke("nova-pebble:set-hovered", Boolean(hovered));
  },
  onSetState(callback) {
    ipcRenderer.on("nova-pebble:set-state", (_event, state) => callback(normalizePebbleState(state)));
  }
});

contextBridge.exposeInMainWorld("novaPanel", {
  getStateDefinitions() {
    return {
      states: PEBBLE_STATES,
      aliases: PEBBLE_STATE_ALIASES,
    };
  },
  close() {
    return ipcRenderer.invoke("nova-panel:close");
  },
  setPebbleState(state) {
    return ipcRenderer.invoke("nova-panel:set-state", normalizePebbleState(state));
  },
  submitCommand(request) {
    if (typeof request === "object" && request) {
      return ipcRenderer.invoke("nova-panel:submit-command", {
        text: String(request.text ?? ""),
        authorityToken: typeof request.authorityToken === "string" ? request.authorityToken : "",
      });
    }

    return ipcRenderer.invoke("nova-panel:submit-command", { text: String(request ?? "") });
  },
  getAuthority() {
    return ipcRenderer.invoke("nova-panel:get-authority");
  },
  elevateAuthority(request) {
    return ipcRenderer.invoke("nova-panel:elevate-authority", {
      level: Number(request?.level),
      minutes: Number(request?.minutes),
      oneAction: Boolean(request?.oneAction),
    });
  },
  acknowledgeNotification(id) {
    return ipcRenderer.invoke("nova-panel:acknowledge-notification", String(id ?? ""));
  },
  resizeToContent(contentHeight) {
    return ipcRenderer.invoke("nova-panel:resize-to-content", Number(contentHeight));
  },
  onOpened(callback) {
    ipcRenderer.on("nova-panel:opened", callback);
  },
  onClosing(callback) {
    ipcRenderer.on("nova-panel:closing", callback);
  },
  onRequestHeight(callback) {
    ipcRenderer.on("nova-panel:request-height", callback);
  },
  onResizeState(callback) {
    ipcRenderer.on("nova-panel:resize-state", (_event, state) => callback(state));
  },
  onProactiveNotifications(callback) {
    ipcRenderer.on("nova-panel:proactive-notifications", (_event, notifications) => {
      callback(Array.isArray(notifications) ? notifications : []);
    });
  }
});

contextBridge.exposeInMainWorld("novaSetup", {
  getInitialState() {
    return ipcRenderer.invoke("nova-setup:get-initial-state");
  },
  saveDraft(config) {
    return ipcRenderer.invoke("nova-setup:save-draft", config);
  },
  complete(config) {
    return ipcRenderer.invoke("nova-setup:complete", config);
  },
  checkLocalAi() {
    return ipcRenderer.invoke("nova-setup:check-local-ai");
  },
  getApplications() {
    return ipcRenderer.invoke("nova-setup:get-applications");
  },
  setApplicationPermissions(applications) {
    return ipcRenderer.invoke("nova-setup:set-application-permissions", applications);
  },
  testShortcut(accelerator) {
    return ipcRenderer.invoke("nova-setup:test-shortcut", String(accelerator ?? ""));
  },
  testCommand(text) {
    return ipcRenderer.invoke("nova-setup:test-command", String(text ?? ""));
  }
});
