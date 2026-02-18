import { LogEntry } from '../types';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';
let logBuffer: LogEntry[] = [];
let onLogCallback: ((entry: LogEntry) => void) | null = null;
const MAX_BUFFER = 500;

export const setLevel = (level: LogLevel): void => {
  currentLevel = level;
};

export const setLogCallback = (cb: (entry: LogEntry) => void): void => {
  onLogCallback = cb;
};

export const getLogBuffer = (): LogEntry[] => [...logBuffer];

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
  if (LEVEL_VALUES[level] < LEVEL_VALUES[currentLevel]) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    meta,
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer = logBuffer.slice(-MAX_BUFFER);

  if (onLogCallback) onLogCallback(entry);

  const prefix = `[${entry.timestamp}] ${level.toUpperCase()}`;
  const output = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;
  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
};

export const debug = (message: string, meta?: Record<string, unknown>): void => log('debug', message, meta);
export const info = (message: string, meta?: Record<string, unknown>): void => log('info', message, meta);
export const warn = (message: string, meta?: Record<string, unknown>): void => log('warn', message, meta);
export const error = (message: string, meta?: Record<string, unknown>): void => log('error', message, meta);
