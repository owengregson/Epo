type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let level: Level = 'info';
type Sink = ((l: Level, m: string, meta?: unknown) => void) | null;
let sink: Sink = null;
let durableSink: Sink = null;
export const setLevel = (l: Level) => { level = l; };
export const setSink = (fn: Sink) => { sink = fn; };
export const setDurableSink = (fn: Sink) => { durableSink = fn; };
const emit = (l: Level, m: string, meta?: unknown) => {
  if (RANK[l] < RANK[level]) return;
  // A renderer crash must not turn a successful operation into a failed one.
  for (const target of [durableSink, sink]) {
    try { target?.(l, m, meta); } catch { /* Diagnostics cannot own runtime control. */ }
  }
  let detail = '';
  try { detail = meta ? ` ${JSON.stringify(meta)}` : ''; } catch { detail = ' [unserializable]'; }
  const line = `${l.toUpperCase()} ${m}${detail}`;
  (l === 'error' ? console.error : console.log)(line);
};
export const debug = (m: string, meta?: unknown) => emit('debug', m, meta);
export const info = (m: string, meta?: unknown) => emit('info', m, meta);
export const warn = (m: string, meta?: unknown) => emit('warn', m, meta);
export const error = (m: string, meta?: unknown) => emit('error', m, meta);
