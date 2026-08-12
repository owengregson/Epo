type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let level: Level = 'info';
let sink: ((l: Level, m: string, meta?: unknown) => void) | null = null;
export const setLevel = (l: Level) => { level = l; };
export const setSink = (fn: typeof sink) => { sink = fn; };
const emit = (l: Level, m: string, meta?: unknown) => {
  if (RANK[l] < RANK[level]) return;
  sink?.(l, m, meta);
  const line = meta ? `${l.toUpperCase()} ${m} ${JSON.stringify(meta)}` : `${l.toUpperCase()} ${m}`;
  (l === 'error' ? console.error : console.log)(line);
};
export const debug = (m: string, meta?: unknown) => emit('debug', m, meta);
export const info = (m: string, meta?: unknown) => emit('info', m, meta);
export const warn = (m: string, meta?: unknown) => emit('warn', m, meta);
export const error = (m: string, meta?: unknown) => emit('error', m, meta);
