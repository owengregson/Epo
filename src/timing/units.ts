/**
 * Shared time units + local-day helpers — one home for the millisecond
 * arithmetic every subsystem repeats. Pure and dependency-free (no Node, no
 * Electron): the renderer imports these too.
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Local midnight (epoch ms) of the day containing `ms`. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
