const { contextBridge, ipcRenderer } = require('electron');

const SIDEBAR_GET_CHANNEL = 'selene:preferences:get-sidebar-collapsed';
const SIDEBAR_SET_CHANNEL = 'selene:preferences:set-sidebar-collapsed';

contextBridge.exposeInMainWorld('selenePreferences', Object.freeze({
  getSidebarCollapsed() {
    return ipcRenderer.invoke(SIDEBAR_GET_CHANNEL);
  },

  setSidebarCollapsed(collapsed) {
    return ipcRenderer.invoke(SIDEBAR_SET_CHANNEL, collapsed);
  }
}));
