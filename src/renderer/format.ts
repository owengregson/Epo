/** Small, dependency-free display formatters for the dashboard. */

/** Wall-clock time, 24h, no date — for log lines. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * A compact relative label for a future or past timestamp, e.g. "in 2h 5m",
 * "3m ago", "now". Used for hold / unfollow / next-action ETAs.
 */
export function relativeTime(target: number, now: number = Date.now()): string {
  const deltaMs = target - now;
  const past = deltaMs < 0;
  const secs = Math.round(Math.abs(deltaMs) / 1000);
  if (secs < 5) return 'now';
  const label = humanizeDuration(secs);
  return past ? `${label} ago` : `in ${label}`;
}

/** Seconds → the two most-significant units, e.g. 7325 → "2h 2m". */
export function humanizeDuration(totalSecs: number): string {
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`, `${h}h`);
  else if (h > 0) parts.push(`${h}h`, `${m}m`);
  else if (m > 0) parts.push(`${m}m`, `${s}s`);
  else parts.push(`${s}s`);
  return parts.slice(0, 2).join(' ');
}

/** A ratio like 1.23 → "1.23"; undefined/null → "—". */
export function fmtRatio(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? '—' : ratio.toFixed(2);
}

/** A follow-back rate 0..1 → "42%"; guards NaN. */
export function fmtPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '0%';
  return `${Math.round(rate * 100)}%`;
}
