/**
 * The README's live panel, committed nightly to the `readme-live` branch: one real plan-day drawn by the SAME
 * day plan and gap the engine runs, in both themes from one drawing function. Growth is measured only (the
 * simulated projection retired, owner Q30). CI-ONLY: bundled by .github/workflows/readme-live.yml.
 */

import { drawDayPlan, drawGapMs, type PlanDemand, phaseOffsetHours, planDayWindow, quietMinute, u } from '@/kernel/plan';
import { effectiveFromV1 } from '@/settings/effective';
import { toPlanIntent } from '@/settings/plan-intent';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { MS_PER_DAY, MS_PER_HOUR } from '@/timing/units';

const UI_FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
const MONO_FONT = `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;

/** §3.4 panel palette, dark/light. */
interface Palette {
  bg: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  grid: string;
  amber: string;
  activeBand: string;
}

const DARK: Palette = {
  bg: '#141417',
  border: '#26262b',
  text: '#ececee',
  muted: '#9a9aa2',
  faint: '#66666e',
  grid: 'rgba(255,255,255,0.05)',
  amber: '#d8b768',
  activeBand: 'rgba(255,255,255,0.035)',
};

const LIGHT: Palette = {
  bg: '#f6f8fa',
  border: '#d0d7de',
  text: '#1f2328',
  muted: '#656d76',
  faint: '#8c959f',
  grid: 'rgba(9,10,12,0.07)',
  amber: '#9a6700',
  activeBand: 'rgba(9,10,12,0.04)',
};

// The panel is 820×300 (§5).
const W = 820;
const H = 300;

function panelShell(c: Palette, kicker: string, stamp: string, body: string, label: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.bg}" stroke="${c.border}"/>` +
    `<text x="24" y="31" font-family="${UI_FONT}" font-size="11.5" font-weight="600" letter-spacing="2.5" fill="${c.muted}">${kicker}</text>` +
    `<text x="${W - 24}" y="31" text-anchor="end" font-family="${MONO_FONT}" font-size="10.5" fill="${c.faint}">${stamp}</text>` +
    body +
    `</svg>\n`
  );
}

// --- Pace chart (§5b: one real plan-day drawn by the shipping day plan) ---

export interface DayPlan {
  /** Epoch ms of each planned action, in order. */
  actions: number[];
  /** The plan-day's automatic volume (the PLAN in the stamp). */
  target: number;
  /** The hard daily ceiling (the CAP line). */
  cap: number;
  /** Hours from `dayStartMs` to the first session's start and the last session's end (the band). */
  activeStartHour: number;
  activeEndHour: number;
  dayStartMs: number;
}

/** A fresh install's demand: no work waiting anywhere. */
const NO_DEMAND: PlanDemand = {
  lifecycleDueByDayEnd: 0, lifecycleBacklog: 0, pruneStock: 0, protectedReeval: 0, journalPending: 0,
  followsDoneToday: 0, outsideToday: 0, pendingRequests: 0, acceptsRecent: 0,
  ownHeader: { followers: null, following: null }, census: { lastCompleteAt: null, rowsPerPage: null },
};

/**
 * Draw the plan-day ending in this calendar day on the default settings, then spend each session's
 * budget from its start at the engine's reference gap (the rolling hour first).
 */
export function planOneDay(dayStartMs: number, seed: number): DayPlan {
  const intent = toPlanIntent(effectiveFromV1(DEFAULT_SETTINGS));
  const entropy = seed >>> 0;
  const phase = phaseOffsetHours(entropy);
  const window = planDayWindow(dayStartMs + MS_PER_DAY - 1, quietMinute(intent.shape, phase, intent.quietHours));
  const plan = drawDayPlan({
    installEntropy: entropy, window, intent, demand: NO_DEMAND, phaseOffsetHours: phase,
    firstOpenAt: window.startsAt, boost: null, runIntent: 'running',
  });
  const actions: number[] = [];
  for (const session of plan.sessions) {
    let t = session.startAt;
    for (let k = 0; k < session.budget && t < window.endsAt; k += 1) {
      actions.push(t);
      // The gap the cadence draws at each dispatch: the session's spec over the trailing hour.
      t += drawGapMs(session.tempo.gap, actions.filter((a) => a > t - MS_PER_HOUR), t, (attempt) => u(plan.seed, 'gap', session.idx, k, attempt));
    }
  }
  const kept = plan.sessions.filter((x) => x.budget > 0);
  const hourOf = (ms: number): number => (ms - dayStartMs) / MS_PER_HOUR;
  return {
    actions,
    target: plan.volume.planned,
    cap: intent.hardCeiling,
    activeStartHour: hourOf(kept[0]?.startAt ?? window.startsAt),
    activeEndHour: hourOf(kept[kept.length - 1]?.expectedEndAt ?? window.startsAt),
    dayStartMs,
  };
}

const hhmm = (h: number): string => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

/** Both themes of the pace chart for an already-planned day. */
export function paceCharts(plan: DayPlan, dateStamp: string): { light: string; dark: string } {
  const L = 46;
  const R = 802;
  const T = 48;
  const B = 266;
  // The cap line must sit visibly above every dot, even for a cap-equal plan (§7.6).
  const ymax = plan.cap * 1.1;
  const x = (ms: number): number => L + ((R - L) * (ms - plan.dayStartMs)) / MS_PER_DAY;
  const y = (v: number): number => B - ((B - T) * v) / ymax;

  const draw = (c: Palette): string => {
    let g = '';
    for (let h = 0; h <= 24; h += 3) {
      const gx = x(plan.dayStartMs + h * MS_PER_HOUR);
      g += `<line x1="${gx}" y1="${T}" x2="${gx}" y2="${B}" stroke="${c.grid}"/>`;
      g += `<text x="${gx}" y="${B + 17}" text-anchor="middle" font-family="${MONO_FONT}" font-size="10" fill="${c.faint}">${String(h).padStart(2, '0')}</text>`;
    }
    for (let v = 0; v < plan.cap; v += 10) {
      g += `<line x1="${L}" y1="${y(v)}" x2="${R}" y2="${y(v)}" stroke="${c.grid}"/>`;
      g += `<text x="${L - 8}" y="${y(v) + 3.5}" text-anchor="end" font-family="${MONO_FONT}" font-size="10" fill="${c.faint}">${v}</text>`;
    }
    // The day's session span.
    const bx1 = x(plan.dayStartMs + plan.activeStartHour * MS_PER_HOUR);
    const bx2 = x(plan.dayStartMs + plan.activeEndHour * MS_PER_HOUR);
    g += `<rect x="${bx1}" y="${T}" width="${bx2 - bx1}" height="${B - T}" fill="${c.activeBand}"/>`;
    g += `<line x1="${bx1}" y1="${T}" x2="${bx1}" y2="${B}" stroke="${c.grid}"/>`;
    g += `<line x1="${bx2}" y1="${T}" x2="${bx2}" y2="${B}" stroke="${c.grid}"/>`;
    g += `<text x="${bx1 + 12}" y="${T + 15}" font-family="${MONO_FONT}" font-size="10.5" letter-spacing="1.5" fill="${c.faint}">SESSIONS ${hhmm(plan.activeStartHour)}–${hhmm(plan.activeEndHour)}</text>`;
    // The daily-cap line.
    g += `<line x1="${L}" y1="${y(plan.cap)}" x2="${R}" y2="${y(plan.cap)}" stroke="${c.amber}" stroke-width="1.5" stroke-dasharray="6 5"/>`;
    g += `<text x="${R - 8}" y="${y(plan.cap) - 8}" text-anchor="end" font-family="${MONO_FONT}" font-size="10.5" letter-spacing="1.5" fill="${c.amber}">DAILY CAP · ${plan.cap}</text>`;
    // One dot per action at its cumulative count — the stair-step under the cap.
    plan.actions.forEach((ms, i) => {
      g += `<circle cx="${x(ms).toFixed(1)}" cy="${y(i + 1).toFixed(1)}" r="3" fill="${c.text}" stroke="${c.bg}"/>`;
    });
    return panelShell(
      c,
      'ONE PLANNED DAY — DRAWN BY THE SHIPPING PLANNER',
      `${dateStamp} · PLAN ${plan.target} / CAP ${plan.cap}`,
      g,
      'One planned day of paced actions inside its sessions, under the daily cap',
    );
  };

  return { light: draw(LIGHT), dark: draw(DARK) };
}
