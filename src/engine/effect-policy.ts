/**
 * Effect policies as DATA.
 *
 * Every Instagram-facing effect the runtime can dispatch declares, in one table,
 * what the runner must do around it: which budget it debits, where its timeout
 * comes from, whether it may be retried, what a refusal does to the record, what
 * it requires, how many may run per iteration, and whether it is idempotent.
 *
 * The load-bearing type-level rule: **`idempotent: false` forces
 * `retry: 'never'`**. A mutation that may have landed can never be re-driven by
 * the runner — the only re-drive path in the app is the recovery ladder, through
 * a hold. Today's `churn-scheduler` and `prune-engine` each hand-implement that
 * rule in an outcome `switch`; wave B deletes both in favour of `onRefusal`.
 *
 * DECLARATION ONLY this wave: nothing consumes the table but
 * `tests/engine/effect-policy.test.ts`, which asserts it is TOTAL over the
 * effect ids. Wave B's effect runner reads it.
 *
 * SEAM (wave B): `timeoutFrom` names a latency op the derived constants already
 * measure (`src/kernel/derive.ts`); `retry` schedules use `src/engine/schedule.ts`,
 * which moves to `src/kernel/schedule.ts`.
 */

import type { Schedule } from './schedule';

/** Every Instagram-facing effect the runtime dispatches today. */
export type IgEffectId =
  /** One follow click, response-arbitrated (ADR 0304). */
  | 'follow'
  /** One unfollow click, response-arbitrated. */
  | 'unfollow'
  /** Accept one pending follow request. */
  | 'accept-request'
  /** One page of a followers/following list walk. */
  | 'list-walk'
  /** A batch of `web_profile_info` reads for count-less candidates. */
  | 'enrich'
  /** One notifications-drawer read (the follow-back signal). */
  | 'notifications';

/** Which ledger a dispatch debits BEFORE it runs — the governor cannot be bypassed. */
export type BudgetClass = 'mutation' | 'read-heavy' | 'read-light' | 'local';

/** A measured latency family; the timeout is `p99 × TIMEOUT_SLACK`. */
export type LatencyOp = 'mutation' | 'hydration' | 'nav' | 'control';

/** What a REFUSAL does to the follow record (ADR 0206: never a fabricated fact). */
export type RefusalEffect = 'record-untouched' | 'record-failed' | 'record-ambiguous';

/** What must be true before a dispatch is even attempted. */
export type Requirement = 'tab' | 'session' | 'online';

interface PolicyBase {
  readonly budget: BudgetClass;
  readonly timeoutFrom: LatencyOp;
  readonly onRefusal: RefusalEffect;
  readonly requires: readonly Requirement[];
  /** `1` means at most one per loop iteration (ADR 0205). */
  readonly perIteration: 1 | 'unbounded';
  /** The span this effect opens — the observability vocabulary. */
  readonly span: string;
}

/**
 * The retry rule, as a type. A non-idempotent effect CANNOT declare a retry
 * schedule: `{ idempotent: false; retry: someSchedule }` does not typecheck.
 */
export type EffectPolicy = PolicyBase &
  ({ readonly idempotent: true; readonly retry: Schedule | 'never' } | {
    readonly idempotent: false;
    readonly retry: 'never';
  });

/** One bounded read retry — reads may be repeated; mutations may not. */
const READ_RETRY: Schedule = {
  k: 'truncate',
  n: 3,
  inner: { k: 'exponential', base: 2_000, factor: 2, cap: 30_000 },
};

/**
 * The policy for every Instagram-facing effect. TOTAL over {@link IgEffectId} —
 * `satisfies` makes a new effect a tsc error until its policy exists.
 */
export const EFFECT_POLICY = {
  follow: {
    budget: 'mutation',
    timeoutFrom: 'mutation',
    // A click may have landed even when the response never arrived.
    idempotent: false,
    retry: 'never',
    onRefusal: 'record-untouched',
    requires: ['tab', 'session', 'online'],
    perIteration: 1,
    span: 'ig.follow',
  },
  unfollow: {
    budget: 'mutation',
    timeoutFrom: 'mutation',
    idempotent: false,
    retry: 'never',
    onRefusal: 'record-untouched',
    requires: ['tab', 'session', 'online'],
    perIteration: 1,
    span: 'ig.unfollow',
  },
  'accept-request': {
    budget: 'mutation',
    timeoutFrom: 'mutation',
    idempotent: false,
    retry: 'never',
    onRefusal: 'record-untouched',
    requires: ['tab', 'session', 'online'],
    perIteration: 1,
    span: 'ig.accept-request',
  },
  'list-walk': {
    budget: 'read-heavy',
    timeoutFrom: 'hydration',
    // A repeated page read is the same page: safe to retry, cursor-idempotent.
    idempotent: true,
    retry: READ_RETRY,
    onRefusal: 'record-untouched',
    requires: ['tab', 'session', 'online'],
    perIteration: 'unbounded',
    span: 'ig.list-walk',
  },
  enrich: {
    budget: 'read-light',
    timeoutFrom: 'hydration',
    idempotent: true,
    retry: READ_RETRY,
    onRefusal: 'record-untouched',
    requires: ['tab', 'session', 'online'],
    perIteration: 'unbounded',
    span: 'ig.enrich',
  },
  notifications: {
    budget: 'read-light',
    timeoutFrom: 'control',
    idempotent: true,
    retry: READ_RETRY,
    onRefusal: 'record-untouched',
    requires: ['tab', 'session', 'online'],
    perIteration: 'unbounded',
    span: 'ig.notifications',
  },
} as const satisfies Record<IgEffectId, EffectPolicy>;

/** The policy for one effect. Total by construction. */
export function policyFor(id: IgEffectId): EffectPolicy {
  return EFFECT_POLICY[id];
}

/** Every declared effect id, for totality tests and span registries. */
export const IG_EFFECT_IDS = Object.keys(EFFECT_POLICY) as readonly IgEffectId[];
