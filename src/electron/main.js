const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const BotService = require('../botService');

let mainWindow = null;
let botService = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0b0f1a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
};

const registerIpc = () => {
  ipcMain.handle('settings:get', () => botService.getSettings());
  ipcMain.handle('settings:update', (_event, settings) => botService.updateSettings(settings));
  ipcMain.handle('status:get', () => botService.getStatus());
  ipcMain.handle('targets:get', () => botService.getTargets());
  ipcMain.handle('bot:start', () => botService.start());
  ipcMain.handle('bot:stop', () => botService.stop());
  ipcMain.handle('bot:refresh-followers', () => botService.refreshFollowers());
  ipcMain.handle('bot:clear-session', () => botService.clearSession());
  ipcMain.handle('bot:toggle-headless', (_event, headless) => botService.toggleHeadless(headless));
};

app.whenReady().then(() => {
  const settingsPath = path.join(app.getPath('userData'), 'peanut-settings.json');
  botService = new BotService({ settingsPath });
  registerIpc();
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

app.on('before-quit', async (event) => {
  if (botService) {
    event.preventDefault();
    await botService.stop();
    app.exit(0);
  }
});
