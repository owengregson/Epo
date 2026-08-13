/**
 * Formatting helpers — pure, dependency-free, and shared across the console.
 * Every counter uses tabular figures (the `.num` class), so these return plain
 * strings and never inject markup.
 */

/** Thousands separators: 4210 → "4,210". Rounds to an integer first. */
export function commas(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Clamp a number into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Seconds → "m:ss" countdown, e.g. 227 → "3:47". */
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Milliseconds of elapsed time → "2h 41m" (session-uptime style). */
export function durationHm(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/** Epoch ms → local wall clock "14:32:07" (log/ticker timestamps). */
export function clockTime(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Epoch ms → short local date "Aug 12" (chart axis labels). */
export function shortDate(atMs: number): string {
  return new Date(atMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** First letter of a handle, uppercased, for monogram avatars. "@chloe" → "C". */
export function monogram(handle: string | null | undefined): string {
  const h = (handle || '').replace(/^@/, '');
  return h ? h.charAt(0).toUpperCase() : '·';
}

/** Ensure a single leading "@". */
export function withAt(username: string | null | undefined): string {
  const u = (username || '').trim();
  if (!u) return '';
  return u.startsWith('@') ? u : `@${u}`;
}

/** Two-decimal ratio, e.g. 0.97. */
export function ratio(v: number): string {
  return v.toFixed(2);
}

/** A fraction 0..1 → integer percent string, e.g. 0.18 → "18". */
export function pctInt(frac: number): string {
  return String(Math.round(frac * 100));
}
