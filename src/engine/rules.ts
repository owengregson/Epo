/**
 * The conductor's precedence, as PURE decisions over a {@link Facts} snapshot.
 *
 * A rule answers one question — "given these facts, does this tick belong to
 * me?" — and returns a {@link RuleVerdict} or `null`. It may not await, read a
 * clock, touch the store or drive Instagram: everything it needs was gathered
 * once, before it ran (`facts.ts`). The executor in `engine.ts` performs the
 * SINGLE verdict the first claiming rule returns, which is what makes "one
 * action per iteration" (ADR 0205) structural rather than a convention.
 *
 * {@link PROGRAM} is the rule table. Reordering it reorders the loop;
 * `tests/engine/rules.test.ts` pins the order AND proves the precedence
 * properties over generated facts (ADR 0902), and `tests/engine/engine.test.ts`
 * drives the real table end to end.
 *
 * Prune is a MODE over the same safety prefix, not a second engine. Its rule
 * lists are declared here; wave B merges the prune loop onto them (§5 of the v4
 * design), at which point ~600 lines of `prune-engine.ts` delete.
 */

import type { FollowRecord } from '../store/types';
import type { DelayPolicy } from '../timing/primitives';
import { pickAction } from './decisions';
import type { EngineWaitKey } from './engine-waits';
import type { FactKey, Facts, FeedCandidate, Mode, RunCtx } from './facts';
import type { HaltReason } from './halt-reason';
import { followbackRule, journalRule, rotateRule, targetRule } from './lifecycle-rules';
import { pacingVerdict } from './pacers';
import type { CurrentTarget, StepResult } from './ports';
import type { FailureKind } from './recovery';
import { PRUNE_RULES } from './rules-prune';

/** Every mode a rule may belong to. */
export const ALL_MODES: readonly Mode[] = ['growth', 'prune-scan', 'prune-run'];

/**
 * A park: the ONE wait the step performs, named by its wait key (which carries
 * the noise class and the surfaced park reason) and the StepResult it produces.
 */
export interface ParkSpec {
  key: EngineWaitKey;
  delay: DelayPolicy | number;
  step: StepResult;
}

/**
 * The effects the executor knows how to perform. A verdict carries AT MOST ONE,
 * so a burst is unrepresentable rather than merely disallowed.
 */
export type EffectRef =
  | { id: 'serve-recovery-hold' }
  | { id: 'enter-recovery'; kind: FailureKind }
  | { id: 'bootstrap-seed-target' }
  | { id: 'settle-journal'; now: number }
  | { id: 'sweep-followback'; now: number }
  | { id: 'refill-pool'; target: CurrentTarget; oneRead?: boolean }
  | { id: 'churn-action'; now: number; record: FollowRecord }
  | { id: 'woven-unfollow'; now: number; candidate: FeedCandidate }
  | { id: 'advance-chain'; target: CurrentTarget; oneRead?: boolean; preparingReserve?: boolean }
  | { id: 'idle' };

/**
 * What a rule may decide.
 *
 *  - `halt` with a reason is terminal; `halt` with `reason: null` means this
 *    generation is superseded or already halted — stop the step, record nothing
 *    new. (One class, so "aborted dominates everything" is one property.)
 *  - `park` performs one wait and ends the step.
 *  - `run` performs one effect.
 *  - `yield` claims the tick without doing anything — the kernel idles.
 */
export type RuleVerdict =
  | { do: 'halt'; reason: HaltReason | null }
  | { do: 'park'; spec: ParkSpec }
  | { do: 'run'; effect: EffectRef }
  | { do: 'yield' };

/** The closed rule vocabulary — also the span/reason names wave B records under. */
export type RuleId =
  | 'aborted'
  | 'sentinel-auth'
  | 'recovery-hold'
  | 'sentinel-blocked'
  | 'pacing'
  | 'target'
  | 'followback'
  | 'journal'
  | 'rotate'
  | 'refill'
  | 'action'
  | 'chain'
  | 'idle'
  | 'prune-cap'
  | 'prune-candidate';

export interface Rule<N extends FactKey = FactKey> {
  readonly id: RuleId;
  readonly modes: readonly Mode[];
  /** Exactly the fact groups `decide` may read — the gatherer collects these. */
  readonly needs: readonly N[];
  decide(f: Pick<Facts, N>, run: RunCtx): RuleVerdict | null;
}

/**
 * Widen a rule for the table while keeping `decide`'s parameter narrowed to its
 * declared `needs`: `Facts` is assignable to `Pick<Facts, N>`, so this is a
 * subtype coercion, not a cast — declaring a fact you do not need is free, but
 * READING one you did not declare is a type error at the definition site.
 */
export function defineRule<const N extends FactKey>(rule: Rule<N>): Rule {
  return rule;
}

// --- Safety: every mode runs these first -------------------------------------------

/** Stopped or halted: never touch anything. */
const abortedRule = defineRule({
  id: 'aborted',
  modes: ALL_MODES,
  needs: ['lifecycle'],
  decide: (f) =>
    f.lifecycle.aborted || f.lifecycle.halted ? { do: 'halt', reason: null } : null,
});

/**
 * The hard safety stop, checked before anything else. AUTH states are terminal —
 * only the user can repair the session; `action-blocked` is a rate-limit signal
 * and is routed into the ladder by {@link sentinelBlockedRule} instead.
 */
const sentinelAuthRule = defineRule({
  id: 'sentinel-auth',
  modes: ALL_MODES,
  needs: ['sentinel'],
  decide: (f) =>
    f.sentinel.status === 'challenge' || f.sentinel.status === 'logged-out'
      ? { do: 'halt', reason: { kind: 'sentinel', status: f.sentinel.status } }
      : null,
});

/**
 * An armed recovery hold — from this run, an interrupted wait, or a PREVIOUS app
 * launch (the deadline is absolute and durable) — is served before any other
 * work: the whole point of the hold is to stay off Instagram.
 */
const recoveryHoldRule = defineRule({
  id: 'recovery-hold',
  modes: ALL_MODES,
  needs: ['recovery'],
  decide: (f) =>
    f.recovery.phase === 'holding' ? { do: 'run', effect: { id: 'serve-recovery-hold' } } : null,
});

/** A verified action block is a rate-wall signal: ladder, never halt. */
const sentinelBlockedRule = defineRule({
  id: 'sentinel-blocked',
  modes: ALL_MODES,
  needs: ['sentinel'],
  decide: (f) =>
    f.sentinel.status === 'action-blocked'
      ? { do: 'run', effect: { id: 'enter-recovery', kind: 'rate-limited' } }
      : null,
});

// --- Growth ------------------------------------------------------------------------

/** The pacing model's own gate (session/velocity, or active-hours/daily cap). */
const pacingRule = defineRule({
  id: 'pacing',
  modes: ['growth'],
  needs: ['clock', 'ledger', 'pacing'],
  decide: (f) => {
    const spec = pacingVerdict(f);
    return spec === null ? null : { do: 'park', spec };
  },
});

/**
 * Candidate pool low → one bounded slice of the refill cycle: acquire once →
 * enrich the count-less candidates (capped) → plan.
 */
const refillRule = defineRule({
  id: 'refill',
  modes: ['growth'],
  needs: ['target', 'queue', 'action', 'clock'],
  decide: (f) => {
    const target = f.target.current;
    // Defensive: the target rule bootstraps rather than falling through, so a
    // null here would mean the table was reordered wrong.
    if (target === null) return null;
    if (f.queue.canPrepare === false) return null;
    if ((f.queue.refillAvailableAt ?? 0) > f.clock.now) return null;
    if (f.queue.rotationReason || (f.queue.yieldToAction && (f.action.due !== null || f.action.pruneCandidate !== null))) return null;
    return f.queue.queuedForTarget < f.queue.lowWaterCandidates && !f.queue.targetExhausted
      ? { do: 'run', effect: { id: 'refill-pool', target,
        ...(f.queue.qualityEnabled && (f.action.due !== null || f.action.pruneCandidate !== null) ? { oneRead: true } : {}) } }
      : null;
  },
});

/** Exactly ONE Instagram action, preceded by any inter-action delay still owed. */
const actionRule = defineRule({
  id: 'action',
  modes: ['growth'],
  needs: ['clock', 'action'],
  decide: (f) => {
    const { due, pruneCandidate, weaveDraw, unfollowFraction } = f.action;
    const choice = pickAction(due, pruneCandidate, { unfollowFraction, draw: weaveDraw });
    if (choice === 'prune' && pruneCandidate !== null) {
      return { do: 'run', effect: { id: 'woven-unfollow', now: f.clock.now, candidate: pruneCandidate } };
    }
    if (choice === 'lifecycle' && due !== null) {
      return { do: 'run', effect: { id: 'churn-action', now: f.clock.now, record: due } };
    }
    return null;
  },
});

/** The target is spent (queue drained, refill closed on an empty plan) → advance. */
const chainRule = defineRule({
  id: 'chain',
  modes: ['growth'],
  needs: ['target', 'queue', 'clock'],
  decide: (f) => {
    const target = f.target.current;
    if (target === null) return null;
    if (f.queue.canPrepare === false || Math.max(f.queue.refillAvailableAt ?? 0, f.queue.advanceAvailableAt ?? 0) > f.clock.now) return null;
    return f.queue.queuedForTarget === 0 && f.queue.targetExhausted
      ? { do: 'run', effect: { id: 'advance-chain', target } }
      : null;
  },
});

/** Nothing due yet (records waiting on follow-back/holds): a short idle beat. */
const idleRule = defineRule({
  id: 'idle',
  modes: ['growth'],
  needs: [],
  decide: () => ({ do: 'run', effect: { id: 'idle' } }),
});

/**
 * The rule table. `safety` runs in every mode and always first; the mode's own
 * list follows. Order IS the contract.
 */
export const PROGRAM = {
  safety: [abortedRule, sentinelAuthRule, recoveryHoldRule, sentinelBlockedRule],
  growth: [
    pacingRule,
    journalRule,
    targetRule,
    followbackRule,
    rotateRule,
    refillRule,
    actionRule,
    chainRule,
    idleRule,
  ],
  scan: [] as readonly Rule[],
  run: PRUNE_RULES,
} as const satisfies Record<string, readonly Rule[]>;

/** The ordered rule list for `mode`: the safety prefix, then the mode's own. */
export function programFor(mode: Mode): readonly Rule[] {
  const own =
    mode === 'growth' ? PROGRAM.growth : mode === 'prune-scan' ? PROGRAM.scan : PROGRAM.run;
  return [...PROGRAM.safety, ...own].filter((r) => r.modes.includes(mode));
}

/**
 * ONE pass over a mode's rule table: gather each rule's declared facts, ask it
 * to decide, and return the FIRST claim. This is the whole conductor — the
 * executor supplies a real (lazy, memoised) gatherer, and the property tests
 * supply generated facts, so both drive the SAME loop.
 *
 * `gather` is handed exactly `rule.needs`; what it returns is typed `Facts` only
 * because the widened {@link Rule} erased which keys those were. A rule reading
 * outside its declaration sees `undefined` — `tests/engine/rules.test.ts` turns
 * that into a thrown error.
 */
export async function decideProgram(
  run: RunCtx,
  gather: (needs: readonly FactKey[]) => Promise<Facts>,
): Promise<{ rule: RuleId; verdict: RuleVerdict } | null> {
  for (const rule of programFor(run.mode)) {
    const verdict = rule.decide(await gather(rule.needs), run);
    if (verdict !== null) return { rule: rule.id, verdict };
  }
  return null;
}

/** Every fact group `mode`'s program may read — the source set an owner must register. */
export function factsNeededFor(mode: Mode): readonly FactKey[] {
  const seen = new Set<FactKey>();
  for (const rule of programFor(mode)) for (const need of rule.needs) seen.add(need);
  return [...seen];
}
