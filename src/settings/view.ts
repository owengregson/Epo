/**
 * The Settings view (spec §6.9, Appendix B.4): computed in main from the document, its resolved parameters
 * and the effective record — options for every choice, the typical day, every row whose capability is on,
 * the read allowance, overrides and notices. Pure and deterministic for a fixed document; cached per rev.
 */
import { riskRung, shareOfLowWall } from '@/kernel/derive-envelope';
import { INTENT_KEYS, type IntentKey, PACE_CARDS, type PaceCardId } from '@/shared/settings-intent';
import type { ApplyNote, ChangeLine, OverrideConflict } from '@/shared/settings-ops';
import { type ParamKey, RISK_LEVELS, type SectionId } from '@/shared/settings-params';
import type {
  ParamView, PlanPreviewDay, ProvenanceStep, SettingsCapabilities, SettingsHealth, SettingsNotice, SettingsView,
} from '@/shared/settings-view';
import type { PlanMath } from './basis';
import type { SettingsDocV2 } from './doc';
import type { EffectiveSettings } from './effective';
import type { OlderVersionOffer } from './older-version';
import { ALL_PARAM_KEYS, PARAM_SPECS } from './params';
import { type ParamSpec, sameValue } from './params-spec';
import { toReadAllowance } from './read-allowance';
import type { ResolvedParams } from './resolve';
import { feasibilityOfEffective, optionPreviews } from './view-options';

export interface ViewInput {
  readonly doc: SettingsDocV2;
  readonly health: SettingsHealth;
  readonly capabilities: SettingsCapabilities;
  readonly resolved: ResolvedParams;
  readonly effective: EffectiveSettings;
  readonly math: PlanMath;
  /** The week ahead from the plan's preview port (null until the plan capability is on). */
  readonly week: readonly PlanPreviewDay[] | null;
  /** What an older build added to the v1 lists since the document read them. */
  readonly older?: OlderVersionOffer | null;
}

/** The intent choice each derived row follows, for its "Why this number?" chain. */
const CHOICE: Readonly<Partial<Record<ParamKey, IntentKey>>> = {
  'pace.dailyVolume': 'activity', 'pace.hourlyCap': 'caution', 'pace.dayVariation': 'consistency',
  'pace.restDayChance': 'consistency', 'sessions.perDayMin': 'rhythm', 'sessions.perDayMax': 'rhythm',
  'sessions.gapTypical': 'caution', 'sessions.gapMinimum': 'caution', 'unfollow.waitDays': 'patience',
  'unfollow.holdDays': 'patience', 'unfollow.cleanupShare': 'cleanup', 'audience.followerRange': 'audienceSize',
  'audience.ratioCurve': 'audienceFocus', 'audience.privateBoost': 'preferPrivate',
};
const PLAN_ROWS = new Set<ParamKey>(['unfollow.cleanupPerDay', 'unfollow.censusEveryDays', 'checks.everyHours']);

function shown(key: ParamKey, c: SettingsCapabilities): boolean {
  const needs = PARAM_SPECS[key].needs;
  return needs === null || c[needs];
}

function paramView(key: ParamKey, i: ViewInput): ParamView {
  const spec: ParamSpec = PARAM_SPECS[key];
  const r = i.resolved[key];
  const choice = CHOICE[key];
  const provenance: ProvenanceStep[] = [
    ...(choice === undefined ? [] : [{ kind: 'choice', intent: choice, value: String(i.doc.intent[choice]) } as const]),
    ...spec.deps.flatMap((d) => (typeof i.resolved[d].value === 'number' ? [{ kind: 'param', key: d, value: i.resolved[d].value as number } as const] : [])),
  ];
  return {
    key, section: spec.section, kind: spec.kind, unit: spec.unit, step: spec.step, value: r.value, recommended: r.recommended,
    override: r.override, bounds: { kind: spec.kind === 'int' ? 'number' : spec.kind === 'bool' ? 'number' : spec.kind, ...r.bounds },
    risk: spec.risk,
    // Without the plan port a re-plan has nothing to redraw: the change shows from the next day.
    applies: spec.applies === 'replan' && !i.capabilities.plan ? 'next-day' : spec.applies,
    source: i.capabilities.plan && PLAN_ROWS.has(key) ? 'plan' : choice === undefined ? 'recommended' : 'derived',
    inactive: spec.inactive?.(i.doc.intent) ?? null,
    provenance,
  };
}

function notices(i: ViewInput, stale: number): SettingsNotice[] {
  const out: SettingsNotice[] = [];
  const add = (id: string, tone: SettingsNotice['tone'], kind: SettingsNotice['kind'], data: SettingsNotice['data'] = {}, dismissible = true) => {
    if (!dismissible || !i.doc.app.dismissedNotices.includes(id)) out.push({ id, tone, kind, data, dismissible });
  };
  const h = i.health;
  if (h.kind === 'migration-refused') add('health:migration-refused', 'error', 'migration-refused', { detail: h.detail }, false);
  if (h.kind === 'migrated') add(`health:migrated:${h.at}`, 'info', 'migrated');
  if (h.kind === 'restored-from-backup') add(`health:restored:${h.quarantined}`, 'warning', 'restored-backup');
  if (h.kind === 'defaults-after-unreadable') add('health:unreadable-defaults', 'warning', 'unreadable-defaults');
  if (i.doc.protectionState !== 'ready') add('protection:needs-review', 'warning', 'needs-review', {}, false);
  for (const n of i.doc.migration?.notes ?? []) {
    const { kind, ...data } = n;
    const key = 'key' in n ? `:${n.key}` : 'list' in n ? `:${n.list}` : '';
    add(`migration:${kind}${key}`, 'info', kind, data as SettingsNotice['data']);
  }
  if (stale > 0) add('overrides:stale', 'info', 'override-stale', { count: stale });
  const older = i.older ?? null;
  if (older !== null) {
    add(`older-version:${older.from.sha256}`, 'info', 'older-version-changed', { accounts: older.accounts.length, words: older.words.length });
  }
  return out;
}

export function buildView(i: ViewInput): SettingsView {
  const { doc, effective: e, math, capabilities } = i;
  const keys = ALL_PARAM_KEYS.filter((k) => i.resolved[k].override !== null);
  const stale = keys.filter((k) => i.resolved[k].override?.stale === true).length;
  const bySection: Partial<Record<SectionId, number>> = {};
  for (const k of keys) bySection[PARAM_SPECS[k].section] = (bySection[PARAM_SPECS[k].section] ?? 0) + 1;
  const paceOverridden = (['pace.dailyVolume', 'pace.dailyCeiling', 'pace.hourlyCap'] as const).some((k) => i.resolved[k].override !== null);
  const card = (Object.keys(PACE_CARDS) as PaceCardId[])
    .find((id) => PACE_CARDS[id].activity === doc.intent.activity && PACE_CARDS[id].caution === doc.intent.caution);
  const automaticMax = math.automaticDayMax(e.dailyOperatingRate);
  const { windowMs: _window, ...reads } = toReadAllowance(e);
  return {
    rev: doc.rev, health: i.health, capabilities, mode: doc.app.mode, intent: doc.intent, seed: doc.seed,
    protection: doc.protection, protectionState: doc.protectionState, prefs: doc.prefs,
    easy: {
      pace: card === undefined || paceOverridden ? 'custom' : card,
      size: i.resolved['audience.followerRange'].override === null ? doc.intent.audienceSize : 'custom',
      focus: i.resolved['audience.ratioCurve'].override === null ? doc.intent.audienceFocus : 'custom',
      quietHours: e.quietHours,
    },
    options: optionPreviews(doc.intent, e, math),
    typical: {
      perDay: math.dayLaw({ operatingRate: e.dailyOperatingRate, dayVariationPct: e.dailyVolumeVariancePct, restDayPct: e.restDayChancePct }),
      automaticMax, ceiling: e.dailyHardCeiling, perHourMax: e.hourlyVelocityCap,
      sessions: { min: e.sessionsPerDayMin, max: e.sessionsPerDayMax },
      shareOfLowWall: shareOfLowWall(automaticMax),
      risk: RISK_LEVELS[riskRung({ dailyVolume: e.dailyOperatingRate, hourlyCap: e.hourlyVelocityCap })],
      feasibility: feasibilityOfEffective(e),
      week: capabilities.plan ? i.week : null,
    },
    params: ALL_PARAM_KEYS.filter((k) => shown(k, capabilities)).map((k) => paramView(k, i)),
    reads: { ...reads, window: 'plan-day', backstop: 'trailing-24h' },
    overrides: { count: keys.length, stale, bySection },
    effective: {
      seed: doc.seed, practice: doc.prefs.practice, acceptRequests: doc.prefs.acceptRequests,
      waitDays: e.maxWaitForFollowbackDays, holdDays: e.rotateMutuals ? e.holdAfterFollowbackDays : null,
      dailyVolume: e.dailyOperatingRate, dailyCeiling: e.dailyHardCeiling, hourlyCap: e.hourlyVelocityCap,
      quietHours: e.quietHours, daysOff: e.daysOff, cleanup: doc.intent.cleanup, boostDefaultHours: doc.prefs.boost.hours,
    },
    notices: notices(i, stale),
    app: { tourCompletedAt: doc.app.tourCompletedAt },
  };
}

const ORDER = { cleanup: ['off', 'trickle', 'steady'], patience: ['patient', 'normal', 'quick'], mutuals: ['keep', 'rotate'] } as const;
/** Rows whose rise (+1) or fall (−1) makes Epo unfollow more or sooner. */
const LOOSER: Readonly<Partial<Record<ParamKey, 1 | -1>>> = {
  'unfollow.waitDays': -1, 'unfollow.holdDays': -1, 'unfollow.censusEveryDays': -1, 'unfollow.cleanupShare': 1, 'unfollow.cleanupPerDay': 1,
};
const shownValue = (v: unknown): string | number | boolean => (typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean));

/** What a preview changes, each line marked when it makes Epo unfollow more or sooner (the reset confirm). */
export function previewChanges(before: SettingsDocV2, after: SettingsDocV2, rb: ResolvedParams, ra: ResolvedParams): ChangeLine[] {
  const lines: ChangeLine[] = [];
  for (const k of INTENT_KEYS) {
    const [b, a] = [before.intent[k], after.intent[k]];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const order = (ORDER as Readonly<Partial<Record<IntentKey, readonly string[]>>>)[k];
    lines.push({ key: k, before: shownValue(b), after: shownValue(a),
      loosensUnfollows: order !== undefined && order.indexOf(a as string) > order.indexOf(b as string) });
  }
  for (const k of ALL_PARAM_KEYS) {
    const [b, a] = [rb[k].value, ra[k].value];
    if (sameValue(b, a)) continue;
    const dir = LOOSER[k];
    lines.push({ key: k, before: shownValue(b), after: shownValue(a),
      loosensUnfollows: dir !== undefined && typeof a === 'number' && typeof b === 'number' && (a - b) * dir > 0 });
  }
  if (before.seed !== after.seed) lines.push({ key: 'seed', before: before.seed, after: after.seed, loosensUnfollows: false });
  if (before.prefs.practice !== after.prefs.practice) {
    lines.push({ key: 'prefs.practice', before: before.prefs.practice, after: after.prefs.practice, loosensUnfollows: before.prefs.practice });
  }
  return lines;
}

/** Overrides whose recommendation moved under them (rendered inline as "You set …; … would use …"). */
export function overrideConflicts(before: ResolvedParams, after: ResolvedParams): OverrideConflict[] {
  return ALL_PARAM_KEYS.flatMap((key) => {
    const o = after[key].override;
    return o === null || sameValue(before[key].recommended, after[key].recommended) ? []
      : [{ key, yours: o.requested, recommendedBefore: before[key].recommended, recommendedNow: after[key].recommended }];
  });
}

/** When the changed values take effect; `replanned` (the plan intent's fingerprint moved) wins when known. */
export function applyNotes(before: ResolvedParams, after: ResolvedParams, plan: boolean, replanned: boolean | null): ApplyNote[] {
  const when = new Set(ALL_PARAM_KEYS.filter((k) => !sameValue(before[k].value, after[k].value)).map((k) => PARAM_SPECS[k].applies));
  const out: ApplyNote[] = [];
  if (when.has('now')) out.push({ what: 'applies-now' });
  if (replanned ?? when.has('replan')) out.push({ what: plan ? 'replanned-today' : 'from-tomorrow' });
  return out;
}
