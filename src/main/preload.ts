import { contextBridge, ipcRenderer } from 'electron';
import type { PeanutAPI } from '../types';

const api: PeanutAPI = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  getStatus: () => ipcRenderer.invoke('status:get'),
  getFollowerList: () => ipcRenderer.invoke('followers:get'),
  startBot: () => ipcRenderer.invoke('bot:start'),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  startScraping: () => ipcRenderer.invoke('bot:scrape'),
  clearSession: () => ipcRenderer.invoke('bot:clear'),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  onLog: (callback) => {
    ipcRenderer.on('log:entry', (_event, entry) => callback(entry));
  },
  onStatus: (callback) => {
    ipcRenderer.on('status:update', (_event, status) => callback(status));
  },
};

contextBridge.exposeInMainWorld('peanut', api);
