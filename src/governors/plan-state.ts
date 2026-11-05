/**
 * The persisted plan state (`meta.plan_state`, spec §16.3): a validated parse with no zod for our
 * own writes, a deterministic repair that keeps whatever parts are still valid (a valid Boost window
 * always survives), and the one-time phase migration from the legacy `pacing_state`.
 */

import type { BoostWindow, DayPlan } from '../kernel/plan';
import { phaseOffsetHours } from '../kernel/plan/seed';

export interface PlanStateV1 {
  readonly v: 1;
  readonly phaseOffsetHours: number;
  readonly plan: DayPlan | null;
  readonly boost: BoostWindow | null;
  readonly upgradeProbation: boolean;
}

/** What a raw value held: each part validated on its own, so a repair keeps the valid ones. */
export interface ParsedPlanState {
  readonly state: PlanStateV1 | null;
  readonly phaseOffsetHours: number | null;
  readonly plan: DayPlan | null;
  readonly boost: BoostWindow | null;
  readonly upgradeProbation: boolean;
  /** Independent valid charge retained when another plan field requires repair. */
  readonly forfeiture?: { readonly key: string; readonly startsAt: number; readonly amount: number };
  /** Why the raw value failed validation; null when absent or valid. */
  readonly problem: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nums = (o: unknown, keys: readonly string[]): boolean => isObj(o) && keys.every((k) => num(o[k]));

const KINDS = ['follow', 'unfollow', 'accept'] as const;
const READS = ['reconcile', 'explore', 'explorePages', 'checks', 'checkPages'] as const;
const GAP = ['medianMs', 'sigma', 'floorMs', 'capMs', 'hawkesAlpha', 'hawkesTauMs', 'timeScale', 'targetMeanMs'] as const;

function validTempo(t: unknown): boolean {
  return isObj(t) && nums(t, ['z', 'pace', 'motion', 'depth']) && nums(t.gap, GAP)
    && (t.mix === 'normal' || t.mix === 'boost') && typeof t.probation === 'boolean';
}

function validSession(s: unknown): boolean {
  return isObj(s) && nums(s, ['idx', 'startAt', 'expectedEndAt', 'budget']) && (s.budget as number) >= 0
    && nums(s.mix, KINDS) && nums(s.reads, READS) && validTempo(s.tempo) && (s.before === 'none' || s.before === 'first-open');
}

/** A structurally valid day plan: every field the view reads is present and finite. */
export function isDayPlan(p: unknown): p is DayPlan {
  if (!isObj(p) || p.v !== 1 || !isObj(p.window) || typeof p.window.key !== 'string') return false;
  if (!nums(p.window, ['startsAt', 'endsAt', 'quietMinute']) || (p.window.startsAt as number) >= (p.window.endsAt as number)) return false;
  if (!nums(p, ['revision', 'drawnAt', 'firstOpenAt', 'seed']) || typeof p.intentDigest !== 'string' || typeof p.cause !== 'string') return false;
  if (!nums(p.volume, ['lognormal', 'band', 'drawn', 'planned'])) return false;
  const forfeited = (p.volume as Obj).forfeited;
  if (forfeited !== undefined && (!num(forfeited) || forfeited < 0)) return false;
  if (!nums(p.ceilings, ['automaticMax', 'day', 'hour', 'unfollowHour', 'probationHour', 'followDay', 'acceptsPerPass'])) return false;
  if (!nums(p.kinds, [...KINDS, 'lifecycleUnfollow', 'slack']) || !nums(p.reads, [...READS, 'census', 'following'])) return false;
  if (!nums((p.reads as Obj).catchUp, ['profiles', 'notifications', 'pages']) || !nums(p.dayTempo, ['z']) || !isObj(p.demand)) return false;
  return Array.isArray(p.sessions) && p.sessions.every(validSession);
}

/** A structurally valid Boost window (clock rules are the service's). */
export function isBoostWindow(b: unknown): b is BoostWindow {
  return isObj(b) && b.v === 1 && nums(b, ['startedAt', 'endsAt', 'durationMs']) && (b.endedAt === null || num(b.endedAt))
    && (b.endReason === null || b.endReason === 'user' || b.endReason === 'expired' || b.endReason === 'clock');
}

const EMPTY: ParsedPlanState = { state: null, phaseOffsetHours: null, plan: null, boost: null, upgradeProbation: false, problem: null };

/** Parse `meta.plan_state`; absent is not a problem, anything malformed is (the parts still read). */
export function parsePlanState(raw: string | null): ParsedPlanState {
  if (raw === null) return EMPTY;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch (e) {
    return { ...EMPTY, problem: `unreadable JSON: ${String(e)}` };
  }
  if (!isObj(o)) return { ...EMPTY, problem: 'not an object' };
  const phase = num(o.phaseOffsetHours) ? o.phaseOffsetHours : null;
  const plan = o.plan === null ? null : isDayPlan(o.plan) ? o.plan : null;
  const boost = o.boost === null || o.boost === undefined ? null : isBoostWindow(o.boost) ? o.boost : null;
  const p = isObj(o.plan) ? o.plan : null;
  const w = isObj(p?.window) ? p.window : null;
  const amount = isObj(p?.volume) ? p.volume.forfeited : undefined;
  const forfeiture = w !== null && typeof w.key === 'string' && num(w.startsAt) && num(amount) && amount >= 0
    ? { key: w.key, startsAt: w.startsAt, amount } : undefined;
  const upgradeProbation = o.upgradeProbation === true;
  const problems = [
    o.v !== 1 ? 'version' : null,
    phase === null ? 'phase' : null,
    o.plan !== null && plan === null ? 'plan' : null,
    o.boost !== null && o.boost !== undefined && boost === null ? 'boost' : null,
    typeof o.upgradeProbation !== 'boolean' ? 'upgradeProbation' : null,
  ].filter((x): x is string => x !== null);
  const valid = problems.length === 0 && phase !== null;
  return {
    state: valid ? { v: 1, phaseOffsetHours: phase, plan, boost, upgradeProbation } : null,
    phaseOffsetHours: phase, plan, boost, upgradeProbation, forfeiture,
    problem: problems.length > 0 ? `invalid ${problems.join(', ')}` : null,
  };
}

export function serializePlanState(s: PlanStateV1): string {
  return JSON.stringify(s);
}

/** The phase the plan uses: a valid legacy planner phase (read once), else the install-seeded one. */
export function migratedPhase(pacingRaw: string | null, installEntropy: number): { readonly phase: number; readonly problem: string | null } {
  if (pacingRaw === null) return { phase: phaseOffsetHours(installEntropy), problem: null };
  try {
    const o: unknown = JSON.parse(pacingRaw);
    if (isObj(o) && num(o.phaseOffsetHours)) return { phase: o.phaseOffsetHours, problem: null };
    return { phase: phaseOffsetHours(installEntropy), problem: 'legacy pacing state carries no phase' };
  } catch (e) {
    return { phase: phaseOffsetHours(installEntropy), problem: `legacy pacing state unreadable: ${String(e)}` };
  }
}

/** A first state: the migrated phase, no plan yet; any install with a ledger owes upgrade probation. */
export function initialPlanState(phase: number, hasLedger: boolean): PlanStateV1 {
  return { v: 1, phaseOffsetHours: phase, plan: null, boost: null, upgradeProbation: hasLedger };
}

/** A deterministic repair: keep the valid phase and Boost window, re-derive the plan (the caller draws it). */
export function repairPlanState(parsed: ParsedPlanState, installEntropy: number): PlanStateV1 {
  return {
    v: 1,
    phaseOffsetHours: parsed.phaseOffsetHours ?? phaseOffsetHours(installEntropy),
    plan: null,
    boost: parsed.boost,
    upgradeProbation: parsed.upgradeProbation,
  };
}
