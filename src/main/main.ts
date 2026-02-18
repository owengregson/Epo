import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { BotService } from './bot-service';
import * as logger from '../utils/logger';
import { LogEntry } from '../types';

let mainWindow: BrowserWindow | null = null;
let botService: BotService | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#09090b',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
};

const registerIpc = (): void => {
  if (!botService) return;

  ipcMain.handle('settings:get', () => botService!.getSettings());
  ipcMain.handle('settings:update', (_e, settings) => botService!.updateSettings(settings));
  ipcMain.handle('status:get', () => botService!.getStatus());
  ipcMain.handle('followers:get', () => botService!.getFollowerList());
  ipcMain.handle('bot:start', () => botService!.start());
  ipcMain.handle('bot:stop', () => botService!.stop());
  ipcMain.handle('bot:scrape', () => botService!.startScraping());
  ipcMain.handle('bot:clear', () => botService!.clearSession());
  ipcMain.handle('logs:get', () => logger.getLogBuffer());

  // Forward log entries to renderer
  logger.setLogCallback((entry: LogEntry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log:entry', entry);
    }
  });

  // Forward status updates to renderer
  botService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status:update', status);
    }
  });
};

app.whenReady().then(() => {
  botService = new BotService();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (botService) {
    event.preventDefault();
    await botService.stop();
    botService = null;
    app.exit(0);
  }
});
