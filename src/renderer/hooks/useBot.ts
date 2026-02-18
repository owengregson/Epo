import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { BotStatus, Settings, LogEntry, FollowerEntry, PeanutAPI } from '../../types';

declare global {
  interface Window {
    peanut: PeanutAPI;
  }
}

export type View = 'dashboard' | 'settings' | 'queue' | 'log';
export type QueueTab = 'followers' | 'scheduled' | 'unfollows';

export function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons: Record<string, string> = {
    success: 'fa-circle-check',
    error: 'fa-circle-xmark',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="fa-solid ${icons[type]}"></i><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

const DEFAULT_STATUS: BotStatus = {
  running: false,
  busy: false,
  lastAction: 'Idle',
  target: '',
  followerCount: 0,
  nextFollowIndex: 0,
  queuedFollows: 0,
  pendingUnfollows: 0,
  nextFollowAt: null,
  nextUnfollowAt: null,
  scrapeProgress: null,
};

const DEFAULT_SETTINGS: Settings = {
  target: '',
  headless: true,
  dryRun: false,
  maxActionsPerDay: 20,
  minDelayMinutes: 3,
  maxDelayMinutes: 7,
  activeHoursStart: 8,
  activeHoursEnd: 22,
  jitterPercent: 30,
  scrapeChunkSize: 200,
  unfollowAfterHours: 24,
  slowMo: 0,
  aggressiveness: 'normal',
  minFollowing: 600,
  followRatioTolerance: 50,
};

export function useBot() {
  const [view, setView] = useState<View>('dashboard');
  const [queueTab, setQueueTab] = useState<QueueTab>('followers');
  const [status, setStatus] = useState<BotStatus>(DEFAULT_STATUS);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [followers, setFollowers] = useState<FollowerEntry[]>([]);
  const [nextFollowIndex, setNextFollowIndex] = useState(0);
  const [logFilter, setLogFilter] = useState('all');
  const [ready, setReady] = useState(false);

  const logsRef = useRef(logs);
  logsRef.current = logs;

  // Initial data load
  useEffect(() => {
    async function load() {
      try {
        const [s, st, l, f] = await Promise.all([
          window.peanut.getSettings(),
          window.peanut.getStatus(),
          window.peanut.getLogs(),
          window.peanut.getFollowerList(),
        ]);
        setSettings(s);
        setStatus(st);
        setLogs(l);
        setFollowers(f.followerList);
        setNextFollowIndex(f.nextFollowIndex);
      } catch { /* ignore */ }
      setReady(true);
    }
    load();
  }, []);

  // Real-time listeners
  useEffect(() => {
    window.peanut.onLog((entry: LogEntry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });

    window.peanut.onStatus((s: BotStatus) => {
      setStatus(s);
    });
  }, []);

  // Periodic status refresh
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const s = await window.peanut.getStatus();
        setStatus(s);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Actions
  const startBot = useCallback(async () => {
    try {
      await window.peanut.startBot();
      showToast('Bot started', 'success');
    } catch (err: any) {
      showToast(err.message || 'Failed to start', 'error');
    }
  }, []);

  const stopBot = useCallback(async () => {
    try {
      await window.peanut.stopBot();
      showToast('Bot stopped', 'info');
    } catch (err: any) {
      showToast(err.message || 'Failed to stop', 'error');
    }
  }, []);

  const startScraping = useCallback(async () => {
    try {
      showToast('Scraping started...', 'info');
      await window.peanut.startScraping();
      showToast('Scraping complete', 'success');
      const data = await window.peanut.getFollowerList();
      setFollowers(data.followerList);
      setNextFollowIndex(data.nextFollowIndex);
    } catch (err: any) {
      showToast(err.message || 'Scraping failed', 'error');
    }
  }, []);

  const saveSettings = useCallback(async (partial: Partial<Settings>) => {
    try {
      const updated = await window.peanut.updateSettings(partial);
      setSettings(updated);
      showToast('Settings saved', 'success');
    } catch (err: any) {
      showToast(err.message || 'Failed to save', 'error');
    }
  }, []);

  const clearSession = useCallback(async () => {
    try {
      await window.peanut.clearSession();
      showToast('Session cleared', 'info');
      // Refresh all data
      const [s, st, l, f] = await Promise.all([
        window.peanut.getSettings(),
        window.peanut.getStatus(),
        window.peanut.getLogs(),
        window.peanut.getFollowerList(),
      ]);
      setSettings(s);
      setStatus(st);
      setLogs(l);
      setFollowers(f.followerList);
      setNextFollowIndex(f.nextFollowIndex);
    } catch (err: any) {
      showToast(err.message || 'Failed to clear', 'error');
    }
  }, []);

  return {
    view, setView,
    queueTab, setQueueTab,
    status,
    settings,
    logs,
    followers,
    nextFollowIndex,
    logFilter, setLogFilter,
    ready,
    startBot, stopBot, startScraping, saveSettings, clearSession,
  };
}
