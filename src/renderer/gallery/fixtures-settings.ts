/**
 * The Settings stage's gallery scenarios (workplan SU step 1): one chip per state the stage is designed for.
 * A chip writes its own status object; that object's identity publishes its Settings view and facts, so
 * `Gallery.tsx` needs nothing beyond this array. Pick "Page · Settings" to see them; names are invented.
 */
import { effect } from '@preact/signals';
import { settingsFactsSignal, settingsViewSignal, statusSignal } from '@/renderer/app/shell-context';
import { basePrune, baseStatus, type Scenario } from '@/renderer/gallery/fixtures';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import type { PlanProjection } from '@/shared/plan-projection';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { BasisRow, PlanPreviewDay, SettingsView } from '@/shared/settings-view';

const H = 3_600_000;
/** Today's plan-day in the fixtures: 2:45 AM to 2:45 AM, local time. */
const DAY0 = (() => {
  const d = new Date();
  d.setHours(2, 45, 0, 0);
  return d.getTime();
})();
const at = (hours: number): number => DAY0 + hours * H;

/** Five sessions: 30 follows + 10 unfollows + 4 approvals = the Balanced day of 44 (maximum 48, hard stop 65). */
const SESSIONS = [
  { from: 6.3, to: 6.9, f: 6, u: 2, a: 1, state: 'done', pace: 'normal', p: 1 },
  { from: 8.6, to: 9.3, f: 6, u: 2, a: 1, state: 'done', pace: 'relaxed', p: 1.22 },
  { from: 11.1, to: 12.4, f: 11, u: 3, a: 1, state: 'now', pace: 'quick', p: 0.86 },
  { from: 14.9, to: 15.75, f: 5, u: 2, a: 1, state: 'next', pace: 'normal', p: 0.99 },
  { from: 17.5, to: 18.25, f: 2, u: 1, a: 0, state: 'later', pace: 'relaxed', p: 1.31 },
] as const;

/** Today's plan as `status.plan` carries it, with the Advanced detail block. */
export const GALLERY_PLAN: PlanProjection = {
  day: { key: 'today', startsAt: DAY0, endsAt: at(24), quietMinute: 165, light: false, lateStart: false, binding: 'band', dayOff: false },
  revision: 3,
  cause: 'day-start',
  totals: { planned: 44, done: 18, remaining: 26, automaticMax: 48, ceiling: 65, outside: 2 },
  kinds: { follow: { planned: 30, done: 18 }, unfollow: { planned: 10, done: 6 }, accept: { planned: 4, done: 2 } },
  reads: { profiles: { planned: 120, done: 51 }, pages: { planned: 40, done: 12 }, checks: { planned: 9, done: 4 } },
  sessions: SESSIONS.map((s, idx) => ({
    idx, startAt: at(s.from), endAt: at(s.to), planned: s.f + s.u + s.a, done: s.state === 'done' ? s.f + s.u + s.a : s.state === 'now' ? 8 : 0,
    state: s.state, mix: 'normal', probation: false, censusHost: idx === 3, pace: s.pace,
  })),
  now: { sessionIdx: 2, nextAt: at(14.9), closesAt: at(12.4) },
  detail: {
    caps: { automaticMax: 48, day: 65, hour: 22, unfollowHour: 22, probationHour: 14, acceptsPerPass: 5 },
    sessions: SESSIONS.map((s, idx) => ({
      idx, pace: s.p, motion: s.p, depth: 1,
      gap: { targetMeanMs: 304_000 * s.p, medianMs: 280_000 * s.p, floorMs: 130_000 * s.p, capMs: 912_000, timeScale: s.p },
      kinds: { follow: s.f, unfollow: s.u, accept: s.a },
      reads: { profiles: 4 * (s.f + s.u), pages: 2 * s.f, checks: 2 },
    })),
  },
};

/** The next seven plan-days (the fifth is a day off chosen in Easy). */
const WEEK: PlanPreviewDay[] = [44, 41, 47, 38, 0, 36, 44].map((total, d) => ({
  dayKey: `day-${d}`, startAt: at(24 * d), endAt: at(24 * (d + 1)), restDay: false, dayOff: total === 0, total,
  follows: Math.round(total * 0.68), unfollows: Math.round(total * 0.23), sessions: [],
}));

const base: SettingsView = { ...GALLERY_SETTINGS_VIEW, typical: { ...GALLERY_SETTINGS_VIEW.typical, week: WEEK } };

/** A view with one value set by the user (the hard stop, 65 → 60), as Advanced shows it. */
function withOverride(v: SettingsView, stale: boolean): SettingsView {
  return {
    ...v,
    overrides: { count: 1, stale: stale ? 1 : 0, bySection: { pace: 1 } },
    params: v.params.map((p) =>
      p.key === 'pace.dailyCeiling'
        ? { ...p, value: 60, override: { requested: 60, setAt: DAY0, clamped: false, stale, basis: stale ? 52 : 65 } }
        : p,
    ),
  };
}

const notice = (id: string, tone: 'info' | 'warning' | 'error', kind: SettingsView['notices'][number]['kind'],
  data: Record<string, string | number> = {}, dismissible = true) => ({ id, tone, kind, data, dismissible });

const VIEWS: Record<string, SettingsView> = {
  'settings-easy': base,
  'settings-advanced': withOverride({ ...base, mode: 'advanced' }, false),
  'settings-not-saved': base,
  'settings-needs-review': {
    ...base, protectionState: 'needs-review', notices: [notice('protection:needs-review', 'warning', 'needs-review', {}, false)],
  },
  'settings-migration-refused': {
    ...base, health: { kind: 'migration-refused', detail: 'the protection lists did not survive the move' },
    protectionState: 'needs-review',
    notices: [notice('health:migration-refused', 'error', 'migration-refused', { detail: 'lists' }, false)],
  },
  'settings-override-conflict': withOverride({ ...base, mode: 'advanced' }, true),
  'settings-infeasible': {
    ...base,
    typical: { ...base.typical, feasibility: { kind: 'short', reachablePerDay: 31, binding: 'active-time' } },
    easy: { ...base.easy, quietHours: { startMinute: 1260, endMinute: 660 } },
    intent: { ...base.intent, quietHours: { kind: 'custom', startMinute: 1260, endMinute: 660 } },
  },
  'seed-queued': base,
  'boost-unavailable': base,
  'plan-detail': { ...base, mode: 'advanced' },
};

const FACTS: Record<string, SettingsFacts> = {
  'seed-queued': { ...GALLERY_SETTINGS_FACTS, seed: { kind: 'queued', handle: 'studio.lumen', why: 'engine' } },
};

const LABELS: Record<string, string> = {
  'settings-easy': 'Settings · Easy',
  'settings-advanced': 'Settings · Advanced',
  'settings-not-saved': 'Settings · not saved (press a choice)',
  'settings-needs-review': 'Settings · protection to review',
  'settings-migration-refused': 'Settings · couldn’t move settings',
  'settings-override-conflict': 'Settings · your value vs a new recommendation',
  'settings-infeasible': 'Settings · schedule too short',
  'seed-queued': 'Settings · starting account queued',
  'boost-unavailable': 'Settings · Boost unavailable (signed out)',
  'plan-detail': 'Settings · today’s plan in detail',
};

/** A few rows of each Under-the-hood group, shaped as `settingsBasis` serves them. */
export const GALLERY_BASIS: BasisRow[] = [
  { id: 'EMPIRICAL.FOLLOW_WALL_PER_DAY.low', group: 'fundamental', value: 100, unit: '/day', tier: null, src: 'field reports', rev: '2026-08', module: 'fundamentals', guard: 'the lowest daily follow limit Instagram is known to apply' },
  { id: 'EMPIRICAL.FOLLOW_WALL_PER_HOUR.low', group: 'fundamental', value: 30, unit: '/h', tier: null, src: 'field reports', rev: '2026-08', module: 'fundamentals', guard: 'the lowest hourly follow limit seen' },
  { id: 'POLICY.CEILING_HEADROOM', group: 'policy', value: 1.3, unit: null, tier: null, src: null, rev: null, module: 'policy', guard: 'room for your own actions above Epo\u2019s day' },
  { id: 'SETTINGS_POLICY.BOOST.CHOICES', group: 'policy', value: '[2, 4, 8, 12, 24]', unit: 'h', tier: null, src: null, rev: null, module: 'settings-policy', guard: 'the Boost lengths offered' },
  { id: 'SURFACE_BOUNDS.noveltyMaxDepth', group: 'bound', value: 6, unit: null, tier: null, src: null, rev: null, module: 'surface-policy', guard: 'how deep a response is fingerprinted' },
  { id: 'ENVELOPE.hourlyCap.max', group: 'derived', value: 30, unit: '/h', tier: 'derived', src: null, rev: null, module: 'derive-envelope', guard: null },
  { id: 'dailyPlan.moderate', group: 'registry', value: 50, unit: '/day', tier: 'policy', src: null, rev: null, module: 'derive', guard: 'the daily target at Moderate activity' },
  { id: 'MOTION.gravity', group: 'motion', value: 9, unit: null, tier: 'shape', src: 'path geometry dial', rev: null, module: 'motion-policy', guard: 'how strongly a path bends toward its target' },
  { id: 'MOTION.travelMs', group: 'motion', value: '[220, 640]', unit: 'ms', tier: 'duration', src: null, rev: null, module: 'motion-policy', guard: null },
];

const BY_STATUS = new Map<Scenario['status'], string>();

export const SETTINGS_SCENARIOS: Scenario[] = Object.keys(VIEWS).map((key) => {
  const status = baseStatus({ plan: GALLERY_PLAN, loggedIn: key !== 'boost-unavailable' });
  BY_STATUS.set(status, key);
  return { key, label: LABELS[key] ?? key, status, prune: basePrune() };
});

/** The scenario's Settings view, or the base one for every other scenario. */
effect(() => {
  const status = statusSignal.value;
  const key = status ? BY_STATUS.get(status) : undefined;
  settingsViewSignal.value = key === undefined ? base : (VIEWS[key] ?? base);
  settingsFactsSignal.value = key === undefined ? GALLERY_SETTINGS_FACTS : (FACTS[key] ?? GALLERY_SETTINGS_FACTS);
});
