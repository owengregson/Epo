const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('peanut', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getTargets: () => ipcRenderer.invoke('targets:get'),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  refreshFollowers: () => ipcRenderer.invoke('bot:refresh-followers'),
  clearSession: () => ipcRenderer.invoke('bot:clear-session'),
  toggleHeadless: (headless) => ipcRenderer.invoke('bot:toggle-headless', headless),
});
