# Timing Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify every scattered delay/scheduling mechanism into `src/timing/` — pure primitives, a stateful DelayManager, a ScheduleManager, and a constants registry — per the approved spec `docs/superpowers/specs/2026-08-13-timing-unification-design.md`.

**Architecture:** New package `src/timing/` (primitives.ts, config.ts, delay-manager.ts, schedule-manager.ts). Engines wait through an injected DelayManager (named, cancellable, observable waits → real `nextActionAt` deadlines pushed to the renderer). Periodic work (connectivity probe, auto-prune watcher, follow-back sweep cadence) goes through ScheduleManager. The adapter layer gains cooperative AbortSignal support wired to the active driver's run token.

**Tech Stack:** TypeScript 7 (native toolchain), Electron, Preact renderer, Jest 30 via @swc/jest, Biome lint. Path alias `@/*` → `src/*`.

## Global Constraints

- Existing public behavior is preserved unless a task explicitly says otherwise (the four approved behavior changes: cancellable adapter waits, real countdown deadlines, persisted sweep cadence, renderer bug fixes).
- All waits resolve (never reject) on abort — the `defaultSleep` semantics from `engine.ts:97`.
- `src/timing/config.ts` and `src/timing/primitives.ts` must stay Node-free (renderer imports them).
- Engine/prune deps stay injectable: existing tests that inject `sleep`, `clock`, `rng` must keep passing.
- The prune ×1/3 expectation is preserved: a 60 000 ms paced draw scales to 20 000 ms (±1 ms rounding tolerance is acceptable but the canonical test values land exactly).
- Run unit tests with `npx jest <path>` (avoids the sqlite rebuild in `npm test`; timing tests don't need it). Full suite (`npm test`) + `npm run lint` + `npm run build` in the final task.
- Comment style: match the codebase — JSDoc headers explaining *why*, review-tag references (R1/f10-style) where they already exist. Don't strip existing tags when moving code.
- Commit after every task with a conventional-commits message ending in:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `src/timing/primitives.ts` — pure timing primitives

**Files:**
- Create: `src/timing/primitives.ts`
- Test: `tests/timing/primitives.test.ts`

**Interfaces:**
- Consumes: nothing (dependency-free).
- Produces (later tasks rely on these exact names/signatures):
  - `type Rng = () => number`
  - `type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>`
  - `interface DelayPolicy { readonly kind: string; sample(rng: Rng): number }`
  - `fixed(ms: number): DelayPolicy`
  - `uniform(minMs: number, maxMs: number): DelayPolicy` (clamps `min ≥ 0`, `max ≥ min`)
  - `jittered(minMs: number, maxMs: number, jitterPercent: number): DelayPolicy` (consumes rng twice: base then jitter — order matters for deterministic tests)
  - `scaled(inner: DelayPolicy, factor: number): DelayPolicy`
  - `sample(policyOrMs: DelayPolicy | number, rng?: Rng): number`
  - `sleep(ms: number, signal?: AbortSignal): Promise<void>` — resolves early on abort, never rejects
  - `const TIMED_OUT: unique symbol` and `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/timing/primitives.test.ts
import {
  fixed,
  jittered,
  sample,
  scaled,
  sleep,
  TIMED_OUT,
  uniform,
  withTimeout,
} from '@/timing/primitives';

/** A deterministic rng that replays the given values in order. */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('timing/primitives — DelayPolicy', () => {
  test('fixed always samples its value', () => {
    expect(sample(fixed(1234), seq(0.9))).toBe(1234);
  });

  test('a bare number passes through sample unchanged', () => {
    expect(sample(5000, seq(0.5))).toBe(5000);
  });

  test('uniform draws Math.round(min + rng * (max - min))', () => {
    expect(sample(uniform(2000, 5000), seq(0))).toBe(2000);
    expect(sample(uniform(2000, 5000), seq(1))).toBe(5000);
    expect(sample(uniform(2000, 5000), seq(0.5))).toBe(3500);
  });

  test('uniform clamps a negative min to 0 and max up to min', () => {
    expect(sample(uniform(-100, 50), seq(0))).toBe(0);
    expect(sample(uniform(4000, 1000), seq(1))).toBe(4000); // max clamped to min
  });

  test('jittered matches the rate-governor formula exactly', () => {
    // base = min + rng()*(max-min); jitter = base * (jp/100) * (rng()*2 - 1)
    // rng draws: 0.5 (base) then 1 (jitter → +jp%)
    // base = 60_000 + 0.5*(120_000-60_000) = 90_000; jitter = 90_000*0.3*1 = 27_000
    expect(sample(jittered(60_000, 120_000, 30), seq(0.5, 1))).toBe(117_000);
    // rng 0.5 then 0.5 → jitter term 0 → the pure midpoint
    expect(sample(jittered(60_000, 120_000, 30), seq(0.5, 0.5))).toBe(90_000);
  });

  test('scaled multiplies the inner sample (the prune 1/3 case: 60_000 → 20_000)', () => {
    const third = scaled(jittered(60_000, 60_000, 0), 1 / 3);
    expect(sample(third, seq(0.5, 0.5))).toBe(20_000);
  });
});

describe('timing/primitives — sleep', () => {
  test('resolves after ms without a signal', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test('resolves early (never rejects) when the signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
  });

  test('an already-aborted signal resolves immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(10_000, ac.signal)).resolves.toBeUndefined();
  });
});

describe('timing/primitives — withTimeout', () => {
  test('resolves the value when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve('v'), 1000)).resolves.toBe('v');
  });

  test('resolves TIMED_OUT when the timeout wins', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10)).resolves.toBe(TIMED_OUT);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/timing/primitives.test.ts`
Expected: FAIL — cannot resolve `@/timing/primitives`.

- [ ] **Step 3: Write the implementation**

```ts
// src/timing/primitives.ts
/**
 * Timing primitives — the ONE home for sleep and delay-shape math.
 *
 * Pure and dependency-free (no Node, no Electron), so both the main process and
 * the renderer import from here. Every delay computation in the app is one of
 * these four policy shapes; composing them (see `scaled`) replaces the formula
 * forks that used to live in rate-governor / prune-engine / followers-page-reader.
 */

/** Injectable randomness — `Math.random`-shaped, deterministic in tests. */
export type Rng = () => number;

/**
 * An interruptible sleep signature: resolves after `ms` OR as soon as `signal`
 * aborts, whichever comes first — it NEVER rejects (E1: nothing may wait
 * un-interruptibly, and an abort is a normal outcome, not an error).
 */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** A pure delay sampler: `sample(rng)` yields the next wait in ms. */
export interface DelayPolicy {
  readonly kind: string;
  sample(rng: Rng): number;
}

/** A constant wait (parks, idle beats, retry spacing). */
export function fixed(ms: number): DelayPolicy {
  return { kind: 'fixed', sample: () => ms };
}

/**
 * A uniform draw in [minMs, maxMs], rounded (scan pacing, refill pacing).
 * Bounds are clamped defensively: `min ≥ 0`, `max ≥ min` — mirroring the old
 * followers-page-reader clamps so a bad settings pair can't yield negatives.
 */
export function uniform(minMs: number, maxMs: number): DelayPolicy {
  const min = Math.max(0, minMs);
  const max = Math.max(min, maxMs);
  return { kind: 'uniform', sample: (rng) => Math.round(min + rng() * (max - min)) };
}

/**
 * THE paced delay: a base uniformly in [min,max], then a symmetric
 * ± `jitterPercent` of that base. Consumes the rng TWICE (base, then jitter) —
 * the exact formula and draw order the RateGovernor has always used, so
 * deterministic tests seeded against the old code still hold.
 */
export function jittered(minMs: number, maxMs: number, jitterPercent: number): DelayPolicy {
  return {
    kind: 'jittered',
    sample: (rng) => {
      const base = minMs + rng() * (maxMs - minMs);
      const jitter = base * (jitterPercent / 100) * (rng() * 2 - 1);
      return Math.round(base + jitter);
    },
  };
}

/** Scale another policy's draw by `factor` (prune runs growth's delay × 1/3). */
export function scaled(inner: DelayPolicy, factor: number): DelayPolicy {
  return { kind: `scaled(${inner.kind})`, sample: (rng) => Math.round(inner.sample(rng) * factor) };
}

/** Draw once from a policy — or pass a plain number through unchanged. */
export function sample(policyOrMs: DelayPolicy | number, rng: Rng = Math.random): number {
  return typeof policyOrMs === 'number' ? policyOrMs : policyOrMs.sample(rng);
}

/**
 * The one canonical sleep: real `setTimeout`, resolving early (not rejecting)
 * when `signal` aborts. Replaces the 8 per-file `new Promise(setTimeout)` copies.
 */
export const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });

/** Sentinel `withTimeout` resolves to when the deadline wins the race. */
export const TIMED_OUT: unique symbol = Symbol('timed-out');

/**
 * Race a promise against a deadline. Resolves the promise's value when it wins,
 * or {@link TIMED_OUT} when the deadline does; the timer is always cleared, and
 * the promise's eventual settlement after a timeout is ignored (never unhandled:
 * a rejection after timeout is swallowed by the race's spec semantics only if
 * the caller attached no other handler — callers that care attach their own).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/timing/primitives.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/timing/primitives.ts tests/timing/primitives.test.ts
git commit -m "feat(timing): pure delay primitives — sleep, DelayPolicy, withTimeout"
```

---

### Task 2: `src/timing/config.ts` — the timing constant registry

**Files:**
- Create: `src/timing/config.ts`
- Test: `tests/timing/config.test.ts`

**Interfaces:**
- Produces namespaced `as const` objects later tasks import: `ENGINE`, `PRUNE`, `CONNECTIVITY`, `SCHEDULER`, `ADAPTER`, `RIM`, `POLL`, `HARNESS`. Values below are copied verbatim from today's per-file constants — this task changes NO behavior, it only creates the registry. Consumers migrate in their own tasks.

- [ ] **Step 1: Write the failing test**

```ts
// tests/timing/config.test.ts
import { ADAPTER, CONNECTIVITY, ENGINE, HARNESS, POLL, PRUNE, RIM, SCHEDULER } from '@/timing/config';

describe('timing/config — registry invariants', () => {
  test('values match the historical per-file constants', () => {
    expect(ENGINE.IDLE_MS).toBe(30_000);
    expect(ENGINE.REFILL_PACING_MIN_MS).toBe(2_000);
    expect(ENGINE.REFILL_PACING_MAX_MS).toBe(5_000);
    expect(PRUNE.DELAY_FACTOR).toBeCloseTo(1 / 3);
    expect(PRUNE.PARK_MS).toBe(30_000);
    expect(PRUNE.SCAN_FRESH_MS).toBe(15 * 60_000);
    expect(PRUNE.PARK_TIMEOUT_MS).toBe(90_000);
    expect(CONNECTIVITY.PROBE_INTERVAL_MS).toBe(20_000);
    expect(CONNECTIVITY.REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(SCHEDULER.AUTO_PRUNE_CHECK_MS).toBe(30 * 60_000);
    expect(SCHEDULER.USERNAME_RESOLVE_RETRY_MS).toBe(1_500);
    expect(ADAPTER.POLL_INTERVAL_MS).toBe(250);
    expect(ADAPTER.POLL_TIMEOUT_MS).toBe(8_000);
    expect(RIM.SCROLL_WAIT_MS).toBe(2_000);
    expect(POLL.KEEPALIVE_MS).toBe(10_000);
    expect(HARNESS.LOGIN_POLL_MS).toBe(2_000);
  });

  test('every min/max pair is ordered', () => {
    expect(ENGINE.REFILL_PACING_MIN_MS).toBeLessThanOrEqual(ENGINE.REFILL_PACING_MAX_MS);
    expect(HARNESS.OP_DELAY_MIN_MS).toBeLessThanOrEqual(HARNESS.OP_DELAY_MAX_MS);
    expect(HARNESS.ENRICH_PACE_MIN_MS).toBeLessThanOrEqual(HARNESS.ENRICH_PACE_MAX_MS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/timing/config.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```ts
// src/timing/config.ts
/**
 * The timing constant registry — every fixed operational timing value in one
 * place, grouped by subsystem, each with a one-line rationale. USER-configurable
 * timing stays in `settings/settings.ts` (one home per kind of value); renderer
 * PRESENTATIONAL timing stays in `renderer/lib/motion.ts`.
 *
 * Node-free by design: the renderer imports `POLL` from here too.
 */

export const ENGINE = {
  /** How long an iteration idles when nothing is due yet (§3.1, final branch). */
  IDLE_MS: 30_000,
  /** f10: bounds of the short jittered pause ending every branch that issued IG traffic. */
  REFILL_PACING_MIN_MS: 2_000,
  REFILL_PACING_MAX_MS: 5_000,
} as const;

export const PRUNE = {
  /** Prune unfollows run at a THIRD of growth's paced pace (deliberate bulk cleanup). */
  DELAY_FACTOR: 1 / 3,
  /** Brief park after a blocked action / closed budget before continuing. */
  PARK_MS: 30_000,
  /** How long a completed scan's candidate set stays runnable for a 2-step run. */
  SCAN_FRESH_MS: 15 * 60_000,
  /** How long the prune hand-off waits for the growth loop to park before aborting. */
  PARK_TIMEOUT_MS: 90_000,
} as const;

export const CONNECTIVITY = {
  /** Probe cadence — cheap 204 endpoint, frequent enough to park the engine promptly. */
  PROBE_INTERVAL_MS: 20_000,
  /** Per-probe deadline; `net.request` has no built-in timeout. */
  REQUEST_TIMEOUT_MS: 5_000,
} as const;

export const SCHEDULER = {
  /** How often the opt-in scheduled-prune watcher re-checks `pruneDue`. */
  AUTO_PRUNE_CHECK_MS: 30 * 60_000,
  /** R5: wait between own-username resolution attempts. */
  USERNAME_RESOLVE_RETRY_MS: 1_500,
  /** R5: how many username resolution attempts before degrading. */
  USERNAME_RESOLVE_ATTEMPTS: 4,
} as const;

export const ADAPTER = {
  /** Poll interval while waiting for a dialog / confirm control. */
  POLL_INTERVAL_MS: 250,
  /** Total wait before declaring a control absent. */
  POLL_TIMEOUT_MS: 8_000,
  /** identity.ts: attempts × retry wait for own-username resolution. */
  IDENTITY_ATTEMPTS: 4,
  IDENTITY_RETRY_MS: 1_200,
  /** identity.ts: nav-settle poll — rounds × per-round wait ≈ 4.5 s ceiling. */
  NAV_SETTLE_ROUNDS: 15,
  NAV_SETTLE_MS: 300,
} as const;

export const RIM = {
  /** Fixed pause after each scroll so the paginated response can land (growth path). */
  SCROLL_WAIT_MS: 2_000,
  /** Pause between profile-info fetches so an enrichment pass can't hammer. */
  ENRICH_PACE_MS: 1_000,
  /** Whole-list scrape bounds (prune census): generous but always finite. */
  FETCH_ALL_MAX_ROUNDS: 60,
  FETCH_ALL_NO_NEW_STOP: 3,
  /** Follow-back sweep scrape bounds (request-bounded page walk). */
  SWEEP_MAX_ROUNDS: 10,
  SWEEP_NO_NEW_STOP: 2,
  /** Follower-acquisition scrape bounds (one refill slice). */
  ACQUIRE_MAX_ROUNDS: 5,
  ACQUIRE_NO_NEW_STOP: 2,
} as const;

export const POLL = {
  /** Renderer keep-alive: pull only when the push stream has gone this quiet (§4). */
  KEEPALIVE_MS: 10_000,
} as const;

export const HARNESS = {
  /** Dev harnesses (livetest / capture / inspect): login-state poll cadence. */
  LOGIN_POLL_MS: 2_000,
  /** capture: dialog sweep interval. */
  DIALOG_SWEEP_MS: 2_000,
  /** inspect: DOM poll cadence. */
  INSPECT_POLL_MS: 300,
  /** capture: fixed navigation settles (long / dialog / short). */
  CAPTURE_NAV_SETTLE_MS: 4_000,
  CAPTURE_DIALOG_SETTLE_MS: 2_500,
  CAPTURE_SHORT_SETTLE_MS: 1_500,
  /** livetest defaults (env-overridable in steps.ts): paced op delay band. */
  OP_DELAY_MIN_MS: 4_000,
  OP_DELAY_MAX_MS: 9_000,
  /** livetest defaults: enrichment pacing band. */
  ENRICH_PACE_MIN_MS: 3_000,
  ENRICH_PACE_MAX_MS: 5_000,
  /** livetest default: follow→unfollow gap before the multiplicative jitter. */
  FOLLOW_UNFOLLOW_GAP_MS: 45_000,
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/timing/config.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timing/config.ts tests/timing/config.test.ts
git commit -m "feat(timing): namespaced registry for all fixed operational timing constants"
```

---

### Task 3: `src/timing/delay-manager.ts` — the stateful wait owner

**Files:**
- Create: `src/timing/delay-manager.ts`
- Test: `tests/timing/delay-manager.test.ts`

**Interfaces:**
- Consumes: `DelayPolicy`, `sample`, `sleep`, `Rng`, `SleepFn` from `@/timing/primitives`; `Clock` from `@/governors/clock`.
- Produces (Tasks 6–7 rely on these exact signatures):
  - `interface PendingDelay { key: string; label: string | undefined; startedAt: number; deadline: number; ms: number }`
  - `interface WaitResult { completed: boolean }`
  - `interface WaitOpts { signal?: AbortSignal; label?: string }`
  - `class DelayManager`:
    - `constructor(deps: { clock: Clock; rng?: Rng; sleep?: SleepFn })`
    - `wait(key: string, policyOrMs: DelayPolicy | number, opts?: WaitOpts): Promise<WaitResult>` — registers synchronously (before its first await), so a caller may `const p = delays.wait(...)`, then read `nextDeadline(key)`, then `await p`.
    - `cancel(key: string): boolean`
    - `cancelAll(prefix?: string): number`
    - `pending(): PendingDelay[]`
    - `nextDeadline(key: string): number | null`
    - `onChange(listener: (pending: PendingDelay[]) => void): () => void`
    - `dispose(): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/timing/delay-manager.test.ts
import { DelayManager } from '@/timing/delay-manager';
import { jittered } from '@/timing/primitives';
import { FakeClock } from '@/governors/clock';

/** A controllable sleep: records calls, resolves when released or aborted. */
function makeSleepHarness() {
  const calls: number[] = [];
  const releases: Array<() => void> = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      calls.push(ms);
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
      releases.push(resolve);
    });
  return { calls, releases, sleep };
}

describe('DelayManager', () => {
  test('wait registers a pending entry with the real deadline, then unregisters', async () => {
    const clock = new FakeClock(1_000_000);
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock, sleep: h.sleep });

    const p = dm.wait('engine:action-delay', 240_000);
    expect(dm.pending()).toEqual([
      {
        key: 'engine:action-delay',
        label: undefined,
        startedAt: 1_000_000,
        deadline: 1_240_000,
        ms: 240_000,
      },
    ]);
    expect(dm.nextDeadline('engine:action-delay')).toBe(1_240_000);

    h.releases[0]();
    await expect(p).resolves.toEqual({ completed: true });
    expect(dm.pending()).toEqual([]);
    expect(dm.nextDeadline('engine:action-delay')).toBeNull();
  });

  test('a policy wait samples with the injected rng', async () => {
    const clock = new FakeClock(0);
    const h = makeSleepHarness();
    const rngValues = [0.5, 0.5]; // jittered midpoint, zero jitter term
    const dm = new DelayManager({ clock, sleep: h.sleep, rng: () => rngValues.shift() ?? 0.5 });
    const p = dm.wait('k', jittered(60_000, 120_000, 30));
    expect(h.calls).toEqual([90_000]);
    h.releases[0]();
    await p;
  });

  test('cancel(key) resolves the wait with completed: false', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const p = dm.wait('prune:park', 30_000);
    expect(dm.cancel('prune:park')).toBe(true);
    await expect(p).resolves.toEqual({ completed: false });
    expect(dm.cancel('prune:park')).toBe(false); // nothing left to cancel
  });

  test('cancelAll(prefix) only cancels matching keys', async () => {
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: h.sleep });
    const e = dm.wait('engine:idle', 1000);
    const pr = dm.wait('prune:park', 1000);
    expect(dm.cancelAll('engine:')).toBe(1);
    await expect(e).resolves.toEqual({ completed: false });
    expect(dm.pending().map((x) => x.key)).toEqual(['prune:park']);
    h.releases.at(-1)?.();
    await expect(pr).resolves.toEqual({ completed: true });
  });

  test('an external signal abort resolves the wait with completed: false', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const ac = new AbortController();
    const p = dm.wait('engine:idle', 30_000, { signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toEqual({ completed: false });
  });

  test('an already-aborted external signal resolves immediately', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const ac = new AbortController();
    ac.abort();
    await expect(dm.wait('k', 30_000, { signal: ac.signal })).resolves.toEqual({
      completed: false,
    });
  });

  test('a duplicate key replaces the previous wait (cancels it first)', async () => {
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: h.sleep });
    const first = dm.wait('k', 1000);
    const second = dm.wait('k', 2000);
    await expect(first).resolves.toEqual({ completed: false });
    expect(dm.pending()).toHaveLength(1);
    h.releases.at(-1)?.();
    await expect(second).resolves.toEqual({ completed: true });
  });

  test('onChange fires on register and settle; unsubscribe stops it', async () => {
    const h = makeSleepHarness();
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: h.sleep });
    const snapshots: number[] = [];
    const off = dm.onChange((pending) => snapshots.push(pending.length));
    const p = dm.wait('k', 1000);
    h.releases[0]();
    await p;
    expect(snapshots).toEqual([1, 0]);
    off();
    const p2 = dm.wait('k', 1000);
    h.releases[1]();
    await p2;
    expect(snapshots).toEqual([1, 0]); // no further notifications
  });

  test('dispose cancels everything', async () => {
    const dm = new DelayManager({ clock: new FakeClock(0), sleep: makeSleepHarness().sleep });
    const p = dm.wait('a', 1000);
    dm.dispose();
    await expect(p).resolves.toEqual({ completed: false });
    expect(dm.pending()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/timing/delay-manager.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Write the implementation**

```ts
// src/timing/delay-manager.ts
/**
 * DelayManager — the ONE owner of in-flight operational waits.
 *
 * Every engine wait goes through `wait(key, policy, { signal })`: the wait is
 * REGISTERED (key, startedAt, deadline) while pending, LINKED to the caller's
 * abort signal (replacing the per-engine `interruptibleSleep` copies), and
 * OBSERVABLE — `pending()` / `nextDeadline()` / `onChange` give the main process
 * real deadlines to push to the renderer, so the countdown shows the actual
 * next-action time instead of estimating.
 *
 * Waits resolve `{ completed: false }` on abort/cancel — they NEVER reject (E1).
 * Registration happens synchronously (before the first internal await), so a
 * caller may start a wait, then read its deadline, then await it.
 */

import type { Clock } from '../governors/clock';
import {
  type DelayPolicy,
  type Rng,
  type SleepFn,
  sample,
  sleep as realSleep,
} from './primitives';

/** One registered in-flight wait — why we're waiting and until when. */
export interface PendingDelay {
  key: string;
  label: string | undefined;
  startedAt: number;
  deadline: number;
  ms: number;
}

export interface WaitResult {
  completed: boolean;
}

export interface WaitOpts {
  /** External abort (an engine's run-generation token): aborting resolves the wait. */
  signal?: AbortSignal;
  /** Optional readable annotation surfaced through `pending()`. */
  label?: string;
}

export interface DelayManagerDeps {
  clock: Clock;
  /** Randomness for policy sampling; injectable for deterministic tests. */
  rng?: Rng;
  /** Injected sleep; defaults to the real interruptible setTimeout. */
  sleep?: SleepFn;
}

interface ActiveWait {
  controller: AbortController;
  entry: PendingDelay;
}

export class DelayManager {
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly sleepFn: SleepFn;
  private readonly waits = new Map<string, ActiveWait>();
  private readonly listeners = new Set<(pending: PendingDelay[]) => void>();

  constructor(deps: DelayManagerDeps) {
    this.clock = deps.clock;
    this.rng = deps.rng ?? Math.random;
    this.sleepFn = deps.sleep ?? realSleep;
  }

  /**
   * Wait `policyOrMs` under `key`. A key is a SINGLETON wait: starting a new
   * wait under a live key cancels the previous one first (a stale wait must
   * never shadow the current deadline). Resolves `{ completed: false }` when
   * cancelled or when `opts.signal` aborts.
   */
  async wait(
    key: string,
    policyOrMs: DelayPolicy | number,
    opts: WaitOpts = {},
  ): Promise<WaitResult> {
    const ms = sample(policyOrMs, this.rng);
    this.cancel(key);

    const controller = new AbortController();
    const external = opts.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    const startedAt = this.clock.now();
    const entry: PendingDelay = { key, label: opts.label, startedAt, deadline: startedAt + ms, ms };
    this.waits.set(key, { controller, entry });
    this.emitChange();

    try {
      await this.sleepFn(ms, controller.signal);
      return { completed: !controller.signal.aborted };
    } finally {
      // Only clear our own registration — a replaced wait resolving late must
      // not delete its successor's entry (mirrors the engines' R2 guard).
      if (this.waits.get(key)?.controller === controller) {
        this.waits.delete(key);
        this.emitChange();
      }
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  /** Cancel the wait under `key`; returns whether one was pending. */
  cancel(key: string): boolean {
    const active = this.waits.get(key);
    if (active === undefined) return false;
    active.controller.abort();
    return true;
  }

  /** Cancel every pending wait whose key starts with `prefix` (all when omitted). */
  cancelAll(prefix = ''): number {
    let n = 0;
    for (const [key, active] of this.waits) {
      if (!key.startsWith(prefix)) continue;
      active.controller.abort();
      n += 1;
    }
    return n;
  }

  /** Snapshot of every in-flight wait. */
  pending(): PendingDelay[] {
    return [...this.waits.values()].map((w) => ({ ...w.entry }));
  }

  /** The deadline of the wait under `key`, or null when none is pending. */
  nextDeadline(key: string): number | null {
    return this.waits.get(key)?.entry.deadline ?? null;
  }

  /** Subscribe to pending-set changes; returns the unsubscriber. */
  onChange(listener: (pending: PendingDelay[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancel everything and drop all listeners. Idempotent. */
  dispose(): void {
    this.cancelAll();
    this.listeners.clear();
  }

  private emitChange(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.pending();
    for (const listener of this.listeners) listener(snapshot);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/timing/delay-manager.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timing/delay-manager.ts tests/timing/delay-manager.test.ts
git commit -m "feat(timing): DelayManager — named, cancellable, observable waits"
```

---

### Task 4: `src/timing/schedule-manager.ts` — periodic work

**Files:**
- Create: `src/timing/schedule-manager.ts`
- Test: `tests/timing/schedule-manager.test.ts`

**Interfaces:**
- Consumes: `Clock` from `@/governors/clock`; `* as log` from `@/utils/logger`.
- Produces (Tasks 8–9 rely on these):
  - `interface EveryOpts { unref?: boolean; immediate?: boolean }`
  - `interface Cadence { isDue(now: number, everyMs: number): boolean; markRun(now: number): void; lastRunAt(): number | null }`
  - `class ScheduleManager`:
    - `constructor(deps: { clock: Clock })`
    - `every(key: string, intervalMs: number, fn: () => void | Promise<void>, opts?: EveryOpts): void` — idempotent per key; overlap guard drops (never stacks) ticks; task exceptions are caught and logged, the loop keeps running.
    - `stop(key: string): void`
    - `cadence(key: string, cfg: { getLastRunAt: () => number | null; setLastRunAt: (at: number) => void }): Cadence` — due-by-timestamp: due when never run or `now - last ≥ everyMs`. `everyMs` is a parameter of `isDue` (not fixed at creation) because cadences like the follow-back sweep read a live settings value.
    - `dispose(): void`

- [ ] **Step 1: Write the failing test**

Use Jest fake timers for `every`; `cadence` is pure.

```ts
// tests/timing/schedule-manager.test.ts
import { ScheduleManager } from '@/timing/schedule-manager';
import { FakeClock, SystemClock } from '@/governors/clock';

describe('ScheduleManager.every', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('runs the task on the interval; immediate runs once up front', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let runs = 0;
    sm.every('k', 1000, () => {
      runs += 1;
    }, { immediate: true });
    expect(runs).toBe(1);
    jest.advanceTimersByTime(3000);
    expect(runs).toBe(4);
    sm.dispose();
  });

  test('a second every() under the same key is a no-op (idempotent)', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let a = 0;
    let b = 0;
    sm.every('k', 1000, () => { a += 1; });
    sm.every('k', 1000, () => { b += 1; });
    jest.advanceTimersByTime(2000);
    expect(a).toBe(2);
    expect(b).toBe(0);
    sm.dispose();
  });

  test('overlap guard: ticks landing while the async task runs are DROPPED', async () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let starts = 0;
    let release: () => void = () => {};
    sm.every('k', 1000, () => {
      starts += 1;
      return new Promise<void>((r) => {
        release = r;
      });
    });
    jest.advanceTimersByTime(1000); // first tick starts, never finishes
    jest.advanceTimersByTime(3000); // three more ticks — all dropped
    expect(starts).toBe(1);
    release();
    await Promise.resolve(); // let the finally clear the busy flag
    jest.advanceTimersByTime(1000);
    expect(starts).toBe(2);
    sm.dispose();
  });

  test('a throwing task never kills the loop', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let runs = 0;
    sm.every('k', 1000, () => {
      runs += 1;
      throw new Error('boom');
    });
    jest.advanceTimersByTime(3000);
    expect(runs).toBe(3);
    sm.dispose();
  });

  test('stop(key) halts that loop; dispose halts everything', () => {
    const sm = new ScheduleManager({ clock: new SystemClock() });
    let a = 0;
    let b = 0;
    sm.every('a', 1000, () => { a += 1; });
    sm.every('b', 1000, () => { b += 1; });
    sm.stop('a');
    jest.advanceTimersByTime(2000);
    expect(a).toBe(0);
    expect(b).toBe(2);
    sm.dispose();
    jest.advanceTimersByTime(2000);
    expect(b).toBe(2);
  });
});

describe('ScheduleManager.cadence', () => {
  test('due when never run; not due until everyMs elapses; markRun persists', () => {
    const sm = new ScheduleManager({ clock: new FakeClock(0) });
    let stored: number | null = null;
    const c = sm.cadence('sweep', {
      getLastRunAt: () => stored,
      setLastRunAt: (at) => {
        stored = at;
      },
    });
    expect(c.isDue(1_000, 4 * 3_600_000)).toBe(true); // never ran
    c.markRun(1_000);
    expect(stored).toBe(1_000);
    expect(c.lastRunAt()).toBe(1_000);
    expect(c.isDue(1_000 + 4 * 3_600_000 - 1, 4 * 3_600_000)).toBe(false);
    expect(c.isDue(1_000 + 4 * 3_600_000, 4 * 3_600_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/timing/schedule-manager.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// src/timing/schedule-manager.ts
/**
 * ScheduleManager — the ONE owner of periodic work.
 *
 * `every()` runs tick loops (connectivity probe, the scheduled-prune watcher)
 * with a built-in overlap guard: a tick landing while the task is still in
 * flight is DROPPED, never stacked — generalizing ConnectivityMonitor's old
 * `checking` flag. Task exceptions are caught and logged; a bad tick never
 * kills the loop.
 *
 * `cadence()` models due-by-timestamp scheduling (follow-back sweep, pruneDue):
 * "due when never run, or when everyMs has elapsed since the recorded last run" —
 * with the timestamp read/written through the caller (so it can live in
 * persisted Settings and survive restarts).
 */

import type { Clock } from '../governors/clock';
import * as log from '../utils/logger';

export interface EveryOpts {
  /** `unref` the timer so it can never hold the process open (main-process loops). */
  unref?: boolean;
  /** Run the task once immediately as well as on the interval. */
  immediate?: boolean;
}

export interface Cadence {
  isDue(now: number, everyMs: number): boolean;
  markRun(now: number): void;
  lastRunAt(): number | null;
}

interface ActiveLoop {
  timer: ReturnType<typeof setInterval>;
}

export class ScheduleManager {
  private readonly clock: Clock;
  private readonly loops = new Map<string, ActiveLoop>();

  constructor(deps: { clock: Clock }) {
    this.clock = deps.clock;
  }

  every(
    key: string,
    intervalMs: number,
    fn: () => void | Promise<void>,
    opts: EveryOpts = {},
  ): void {
    if (this.loops.has(key)) return;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return; // overlap guard: drop, never stack
      busy = true;
      try {
        await fn();
      } catch (e) {
        log.error('schedule: task failed', { key, error: String(e) });
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, intervalMs);
    if (opts.unref === true) timer.unref?.();
    this.loops.set(key, { timer });
    if (opts.immediate === true) void tick();
  }

  stop(key: string): void {
    const loop = this.loops.get(key);
    if (loop === undefined) return;
    clearInterval(loop.timer);
    this.loops.delete(key);
  }

  cadence(
    key: string,
    cfg: { getLastRunAt: () => number | null; setLastRunAt: (at: number) => void },
  ): Cadence {
    return {
      isDue: (now, everyMs) => {
        const last = cfg.getLastRunAt();
        return last === null || now - last >= everyMs;
      },
      markRun: (now) => {
        cfg.setLastRunAt(now);
        log.debug('schedule: cadence run recorded', { key, at: now });
      },
      lastRunAt: cfg.getLastRunAt,
    };
  }

  /** Stop every loop. Idempotent. */
  dispose(): void {
    for (const key of [...this.loops.keys()]) this.stop(key);
  }
}
```

Note: `this.clock` is currently only used by future callers via cadence timestamps the caller supplies — keep the field (constructor-injected) so `every`-based features can consult it later without a signature change; if Biome flags it unused, read it in the `cadence` debug log line (`log.debug(..., { key, at: now, clockNow: this.clock.now() })` is NOT wanted — instead prefix the field with usage via a getter is overkill; simplest accepted fix: mark it `private readonly clock: Clock;` and use it in `markRun`'s debug meta as `recordedAt: this.clock.now()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/timing/schedule-manager.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/timing/schedule-manager.ts tests/timing/schedule-manager.test.ts
git commit -m "feat(timing): ScheduleManager — overlap-guarded tick loops and persisted cadences"
```

---

### Task 5: Deduplicate the paced formula — RateGovernor + FollowersPageReader

**Files:**
- Modify: `src/governors/rate-governor.ts:69-78` (`nextDelayMs`)
- Modify: `src/rim/followers-page-reader.ts:29` (local `sleep`), `:125-132` (`nextWaitMs`), `:114` (`scrollWaitMs` default)
- Tests: existing `tests/governors/governors.test.ts` and `tests/rim/followers-page-reader.test.ts` must keep passing UNCHANGED (this task is pure refactor — identical outputs for identical rng draws).

**Interfaces:**
- Consumes: `jittered`, `uniform`, `fixed`, `sample`, `sleep` from `@/timing/primitives`; `RIM` from `@/timing/config`.
- Produces: unchanged public APIs (`RateGovernor.nextDelayMs(rng?)`, `FollowersPageReader.collect(args)`).

- [ ] **Step 1: Run the existing tests to capture the green baseline**

Run: `npx jest tests/governors tests/rim/followers-page-reader.test.ts` — Expected: PASS.

- [ ] **Step 2: RateGovernor delegates to `jittered`**

In `src/governors/rate-governor.ts`, add the import and replace the `nextDelayMs` body:

```ts
import { jittered, sample } from '../timing/primitives';
```

```ts
  /**
   * A paced delay before the next action: a base uniformly in [min,max], then a
   * symmetric ± jitter of `jitterPercent` (the canonical `jittered` policy from
   * timing/primitives — written exactly once for the whole app). `rng` is
   * injectable for deterministic tests.
   */
  nextDelayMs(rng: () => number = Math.random): number {
    const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
    return sample(jittered(minDelayMs, maxDelayMs, jitterPercent), rng);
  }
```

- [ ] **Step 3: FollowersPageReader uses primitives**

In `src/rim/followers-page-reader.ts`:
1. Delete line 29 (`const sleep = (ms) => …`) and add:
   ```ts
   import { fixed, sample, sleep, uniform } from '@/timing/primitives';
   import { RIM } from '@/timing/config';
   ```
2. Line 114: `this.scrollWaitMs = deps.scrollWaitMs ?? RIM.SCROLL_WAIT_MS;`
3. Replace the `nextWaitMs` closure (`:125-132`) with:
   ```ts
    // Each call draws a FRESH jittered wait when both bounds are set (the prune
    // scan path); otherwise the fixed scrollWaitMs (growth, unchanged).
    const waitPolicy =
      args.scrollMinMs === undefined || args.scrollMaxMs === undefined
        ? fixed(this.scrollWaitMs)
        : uniform(args.scrollMinMs, args.scrollMaxMs);
    const nextWaitMs = (): number => sample(waitPolicy, this.rng);
   ```
   (`uniform` carries the `min ≥ 0`, `max ≥ min` clamps internally — identical output.)
4. `this.sleepFn = deps.sleep ?? sleep;` — the deps type `sleep?: (ms: number) => Promise<void>` stays as-is for now (Task 10 widens it with a signal).

- [ ] **Step 4: Run the same tests — still green, unchanged**

Run: `npx jest tests/governors tests/rim/followers-page-reader.test.ts` — Expected: PASS with zero test edits.

- [ ] **Step 5: Commit**

```bash
git add src/governors/rate-governor.ts src/rim/followers-page-reader.ts
git commit -m "refactor(timing): rate-governor + page-reader delegate to shared delay policies"
```

---

### Task 6: Engine → DelayManager (+ `nextActionAt`, injectable pacing rng, config constants)

**Files:**
- Modify: `src/engine/engine.ts`
- Modify: `tests/engine/engine.test.ts` (status-shape additions only, if it asserts whole status objects)
- Modify: `tests/main/foundation-status.test.ts` (same)

**Interfaces:**
- Consumes: `DelayManager` (Task 3), `uniform`, `withTimeout`, `TIMED_OUT`, `sleep`, `SleepFn` (Task 1), `ENGINE` (Task 2).
- Produces (Tasks 7–11 rely on):
  - `EngineDeps` gains `delays?: DelayManager` and `rng?: () => number`.
  - `EngineStatus` gains `nextActionAt: number | null`.
  - `Engine` gains `runSignal(): AbortSignal` (public).
  - `engine.ts` re-exports for back-compat: `export { sleep as defaultSleep } from '../timing/primitives'; export type { SleepFn } from '../timing/primitives';` and `export const ENGINE_IDLE_MS = ENGINE.IDLE_MS;` etc.

- [ ] **Step 1: Write the failing test (new describe block in `tests/engine/engine.test.ts`)**

Follow the file's existing fake-deps pattern (read it first; reuse its `makeDeps`/fake helpers). Add:

```ts
describe('engine — DelayManager integration', () => {
  test('status().nextActionAt carries the action-delay deadline while waiting, null after', async () => {
    // Arrange a due record so step 8 acts; use an injected sleep that captures
    // the status DURING the wait (deps.onStatus fires when the wait starts).
    // rate.nextDelayMs() → 240_000 in the fakes.
    const seen: Array<number | null> = [];
    const deps = makeDeps({
      onStatus: (s) => seen.push(s.nextActionAt),
      sleep: async () => {}, // instant sleep — but registration precedes it
    });
    const engine = createEngine(deps);
    await engine.stepOnce();
    // At least one emitted status while the action-delay wait was registered
    // must carry a real future deadline; the final status is null again.
    expect(seen.some((v) => v !== null)).toBe(true);
    expect(engine.status().nextActionAt).toBeNull();
  });

  test('refill pacing draws through the injected rng (no raw Math.random)', async () => {
    const draws: number[] = [];
    const deps = makeDeps({
      rng: () => {
        draws.push(1);
        return 0.5;
      },
      sleep: async () => {},
    });
    // Drive a branch that calls pacingSleep (e.g. the followback sweep step).
    const engine = createEngine(deps);
    await engine.stepOnce();
    expect(draws.length).toBeGreaterThan(0);
  });
});
```

Adapt the arrangement to the file's real fakes — the assertions above are the contract.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/engine/engine.test.ts` — Expected: new tests FAIL (`nextActionAt` undefined, rng never consulted).

- [ ] **Step 3: Migrate `src/engine/engine.ts`**

1. **Imports / re-exports.** Replace the local `defaultSleep` definition (lines 94–110) and the constants (113–117) with:
   ```ts
   import { DelayManager } from '../timing/delay-manager';
   import { type DelayPolicy, TIMED_OUT, uniform, withTimeout } from '../timing/primitives';
   import { ENGINE as ENGINE_TIMING } from '../timing/config';

   // Back-compat re-exports: the canonical sleep + SleepFn now live in timing/.
   export { sleep as defaultSleep } from '../timing/primitives';
   export type { SleepFn } from '../timing/primitives';

   /** How long an iteration idles when nothing is due yet (§3.1, final branch). */
   export const ENGINE_IDLE_MS = ENGINE_TIMING.IDLE_MS;
   /** f10: bounds of the short jittered pause ending every branch that issued IG traffic. */
   export const REFILL_PACING_MIN_MS = ENGINE_TIMING.REFILL_PACING_MIN_MS;
   export const REFILL_PACING_MAX_MS = ENGINE_TIMING.REFILL_PACING_MAX_MS;
   ```
   Also `import { sleep as timingSleep } from '../timing/primitives';` for the default below, and `import type { SleepFn } from '../timing/primitives';` where the deps type needs it.
2. **Deps.** In `EngineDeps` add after `sleep?`:
   ```ts
   /**
    * The shared wait owner. When absent the Engine constructs a private one over
    * its own clock/sleep/rng — existing tests that inject `sleep` keep working.
    * The composition root injects ONE DelayManager shared with the prune engine
    * (keys are namespaced `engine:` / `prune:`).
    */
   delays?: DelayManager;
   /** Randomness for the jittered pacing draw; injectable for deterministic tests. */
   rng?: () => number;
   ```
3. **`EngineStatus`** gains, after `sessionStartedAt`:
   ```ts
   /** Deadline (epoch ms) of the in-flight paced action delay, else null. */
   nextActionAt: number | null;
   ```
4. **Constructor.** Replace `this.sleepFn = deps.sleep ?? defaultSleep;` with:
   ```ts
   this.delays =
     deps.delays ??
     new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
   ```
   Field: `private readonly delays: DelayManager;`. Delete the `sleepFn` field and the `activeSleep` field (and its doc comment).
5. **Delete `interruptibleSleep` (lines 763–787) and `pacingSleep`'s body.** Replace with:
   ```ts
   /**
    * Wait through the shared DelayManager under a namespaced key, linked to the
    * CURRENT run-generation token (E1/R2: no wait outlives a control command; a
    * stale generation's wait can never touch the new run's state — the manager's
    * per-key replace guard mirrors the old activeSleep identity check). Emits a
    * status right after registration so the renderer sees the wait's real
    * deadline (`nextActionAt`) while it is pending.
    */
   private async engineWait(key: string, policyOrMs: DelayPolicy | number): Promise<void> {
     const wait = this.delays.wait(key, policyOrMs, { signal: this.runAbort.signal });
     this.emitStatus();
     await wait;
   }

   /**
    * f10: the short jittered pause ending every branch that issued Instagram
    * traffic outside step 8. Drawn via the injected rng (deterministic tests).
    */
   private pacingSleep(): Promise<void> {
     return this.engineWait(
       'engine:refill-pacing',
       uniform(REFILL_PACING_MIN_MS, REFILL_PACING_MAX_MS),
     );
   }
   ```
6. **Call-site keys.** Replace every `await this.interruptibleSleep(X)`:
   - `stepOnce` catch (`:487`) → `await this.engineWait('engine:transient-backoff', ENGINE_IDLE_MS);`
   - step 3 (`:506`) → `await this.engineWait('engine:active-hours-park', this.msUntilActiveWindow());`
   - step 4 (`:512`) → `await this.engineWait('engine:daily-ceiling-park', this.msUntilLocalMidnight());`
   - step 8 budget park (`:558`) → `await this.engineWait('engine:budget-park', ENGINE_IDLE_MS);`
   - step 8 action delay (`:571`) → `await this.engineWait('engine:action-delay', this.deps.rate.nextDelayMs());`
   - step 10 idle (`:600`) → `await this.engineWait('engine:idle', ENGINE_IDLE_MS);`
7. **Lifecycle.** In `pause()` and `setOnline(false)`: replace `this.activeSleep?.abort();` with `this.delays.cancelAll('engine:');`. In `stop()`: replace `this.activeSleep?.abort();` with `this.delays.cancelAll('engine:');` (the run-signal link would cover it too; the explicit cancel keeps stop prompt even for a wait registered in a race window).
8. **Status.** In `status()` add `nextActionAt: this.delays.nextDeadline('engine:action-delay'),`.
9. **`runSignal()`** — add near `status()`:
   ```ts
   /** The CURRENT run-generation abort signal (adapter waits link to this). */
   runSignal(): AbortSignal {
     return this.runAbort.signal;
   }
   ```
10. **`awaitParked`** — replace the hand-rolled timeout (`:854-871`) with:
    ```ts
    async awaitParked(timeoutMs: number): Promise<boolean> {
      const state = this.stateNow();
      if (state === 'idle' || state === 'halted') return true;
      if (state === 'paused' && this.parkedNow) return true;
      const parked = new Promise<true>((resolve) => {
        this.parkAckWaiters.push(() => resolve(true));
      });
      const result = await withTimeout(parked, timeoutMs);
      return result !== TIMED_OUT;
    }
    ```
    (Keep the full doc comment.)

- [ ] **Step 4: Fix status-shape fallout**

`notBuiltStatus` in `src/main/foundation-wiring.ts:1345` gains `nextActionAt: null,`. Grep for other full-`EngineStatus` literals: `grep -rn "sessionStartedAt:" src tests --include="*.ts"` and add `nextActionAt: null` (or the expected value) to each object literal that builds a complete status.

- [ ] **Step 5: Run the engine + main test suites**

Run: `npx jest tests/engine/engine.test.ts tests/main` — Expected: PASS (new tests green, old tests updated only for status shape).

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts src/main/foundation-wiring.ts tests/engine/engine.test.ts tests/main
git commit -m "refactor(engine): waits through DelayManager — named keys, real nextActionAt deadline"
```

---

### Task 7: PruneEngine → DelayManager (+ `nextActionAt`, scaled policy)

**Files:**
- Modify: `src/engine/prune-engine.ts`
- Modify: `tests/engine/prune-engine.test.ts` (status shape + new deadline test)
- Modify: `src/main/foundation-wiring.ts:1328-1343` (`notBuiltPruneStatus` gains `nextActionAt: null`)

**Interfaces:**
- Consumes: `DelayManager`, `scaled`, `jittered`, `sample`, `sleep` from timing; `PRUNE` from config.
- Produces:
  - `PruneEngineDeps` gains `delays?: DelayManager`.
  - `PruneStatus` gains `nextActionAt: number | null`.
  - `PruneEngine` gains `runSignal(): AbortSignal`.
  - Re-exports preserved: `export const PRUNE_PARK_MS = PRUNE.PARK_MS;`, `PRUNE_DELAY_FACTOR = PRUNE.DELAY_FACTOR;`, `PRUNE_SCAN_FRESH_MS = PRUNE.SCAN_FRESH_MS;` (keep the existing doc comments on each).

- [ ] **Step 1: Write the failing test** (new block in `tests/engine/prune-engine.test.ts`, following that file's fake pattern)

```ts
test('status().nextActionAt carries the inter-unfollow deadline while waiting', async () => {
  const seen: Array<number | null> = [];
  // One candidate, rng pinned to 0.5/0.5 → delay = (min+max)/2 * 1/3.
  const deps = makePruneDeps({
    onStatus: (s) => seen.push(s.nextActionAt),
    sleep: async () => {},
    rng: () => 0.5,
  });
  const engine = createPruneEngine(deps);
  await engine.run();
  expect(seen.some((v) => v !== null)).toBe(true);
  expect(engine.status().nextActionAt).toBeNull();
});
```

Also verify the existing `inter-action delay runs at a THIRD of the paced pace` test still asserts 60 000 → 20 000 unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest tests/engine/prune-engine.test.ts` — Expected: new test FAILS.

- [ ] **Step 3: Migrate `src/engine/prune-engine.ts`**

1. Imports: drop `{ defaultSleep, type SleepFn } from './engine'`; add:
   ```ts
   import { DelayManager } from '../timing/delay-manager';
   import { type DelayPolicy, jittered, sample, scaled, sleep as timingSleep, type SleepFn } from '../timing/primitives';
   import { PRUNE } from '../timing/config';
   ```
2. Constants become re-exports of `PRUNE.*` (values identical; keep doc comments).
3. `PruneStatus` gains `/** Deadline (epoch ms) of the in-flight inter-unfollow delay, else null. */ nextActionAt: number | null;`
4. `PruneEngineDeps` gains `delays?: DelayManager;` (same doc pattern as EngineDeps).
5. Constructor: replace `this.sleepFn = deps.sleep ?? defaultSleep;` with
   ```ts
   this.delays =
     deps.delays ??
     new DelayManager({ clock: deps.clock, rng: deps.rng, sleep: deps.sleep ?? timingSleep });
   ```
   Delete `sleepFn` and `activeSleep` fields. KEEP `this.rng` (still used by `nextDelayMs`).
6. Delete `interruptibleSleep` (`:601-617`); add:
   ```ts
   /** Wait via the shared DelayManager, linked to this run's abort token. */
   private async pruneWait(key: string, policyOrMs: DelayPolicy | number): Promise<void> {
     const wait = this.delays.wait(key, policyOrMs, { signal: this.runAbort.signal });
     this.emitStatus();
     await wait;
   }
   ```
7. Call sites: `:362` and `:409` → `await this.pruneWait('prune:park', PRUNE_PARK_MS);`; `:415` → `await this.pruneWait('prune:action-delay', this.nextDelayMs());`
8. `nextDelayMs` becomes composition (same doc comment):
   ```ts
   private nextDelayMs(): number {
     const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
     return sample(scaled(jittered(minDelayMs, maxDelayMs, jitterPercent), PRUNE_DELAY_FACTOR), this.rng);
   }
   ```
   (Rounding note: `scaled` rounds the already-rounded jittered draw — for the canonical 60 000-ms case this is exactly 20 000; the general difference is ≤ 1 ms and covered by the Global Constraints tolerance.)
9. `stop()`: replace `this.activeSleep?.abort();` with `this.delays.cancelAll('prune:');`
10. `status()` gains `nextActionAt: this.delays.nextDeadline('prune:action-delay'),`
11. Add `runSignal(): AbortSignal { return this.runAbort.signal; }` (same doc as Engine's).

- [ ] **Step 4: Fix fallout**

`notBuiltPruneStatus` in foundation-wiring gains `nextActionAt: null,`. Grep `grep -rn "scanReady" src tests --include="*.ts"` for other full-`PruneStatus` literals and extend them.

- [ ] **Step 5: Run tests**

Run: `npx jest tests/engine/prune-engine.test.ts tests/main` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/prune-engine.ts src/main/foundation-wiring.ts tests/engine/prune-engine.test.ts tests/main
git commit -m "refactor(prune): waits through DelayManager, delay formula composed from shared policies"
```

---

### Task 8: Persisted follow-back sweep cadence

**Files:**
- Modify: `src/settings/settings.ts` (new field `sweepLastRunAt`)
- Modify: `src/engine/engine.ts` (sweep goes through an injectable cadence)
- Modify: `src/main/foundation-wiring.ts` (wire a persisted cadence)
- Test: extend `tests/engine/engine.test.ts` and `tests/settings/settings.test.ts` (if present — check `ls tests/settings`)

**Interfaces:**
- Consumes: `Cadence` shape from Task 4 (structural — the Engine defines its own narrow port).
- Produces:
  - `Settings` gains `/** Epoch ms of the last completed follow-back sweep; null when never run. */ sweepLastRunAt: number | null;` — default `null` in `DEFAULT_SETTINGS`.
  - `EngineDeps` gains:
    ```ts
    /**
     * Due-by-timestamp cadence for the follow-back sweep. The composition root
     * injects a persisted cadence (Settings.sweepLastRunAt) so the 4h rhythm
     * survives restarts; the default is the old in-memory behavior (lastSweepAt
     * starts at 0 → first eligible step performs a catch-up sweep).
     */
    sweepCadence?: { isDue(now: number, everyMs: number): boolean; markRun(now: number): void };
    ```

- [ ] **Step 1: Write the failing test**

In `tests/engine/engine.test.ts`:

```ts
test('the follow-back sweep consults the injected cadence and marks the run', async () => {
  const marked: number[] = [];
  const deps = makeDeps({
    sleep: async () => {},
    sweepCadence: {
      isDue: () => true,
      markRun: (now) => marked.push(now),
    },
  });
  const engine = createEngine(deps);
  const result = await engine.stepOnce();
  expect(result).toBe('swept-followback');
  expect(marked).toHaveLength(1);
});

test('a not-due cadence skips the sweep', async () => {
  const deps = makeDeps({
    sleep: async () => {},
    sweepCadence: { isDue: () => false, markRun: () => {} },
  });
  const engine = createEngine(deps);
  const result = await engine.stepOnce();
  expect(result).not.toBe('swept-followback');
});
```

(Arrange per the file's existing sweep-test setup — there will already be a test driving step 6; mirror its fixture.)

- [ ] **Step 2: Run to verify failure** — `npx jest tests/engine/engine.test.ts`

- [ ] **Step 3: Implement**

1. `settings.ts`: add `sweepLastRunAt: number | null;` to the interface (in the request-budget/sweep section, after `followbackSweepHours`) and `sweepLastRunAt: null,` to `DEFAULT_SETTINGS`.
2. `engine.ts`: replace the `lastSweepAt` field (`:262-267`) with:
   ```ts
   /**
    * Sweep cadence port. Injected (persisted) by the composition root; the
    * default preserves the old behavior — in-memory, starting due (a fresh
    * Engine's first eligible step performs a cheap catch-up sweep).
    */
   private readonly sweepCadence: { isDue(now: number, everyMs: number): boolean; markRun(now: number): void };
   ```
   Constructor:
   ```ts
   this.sweepCadence =
     deps.sweepCadence ??
     ((): { isDue(now: number, everyMs: number): boolean; markRun(now: number): void } => {
       let last = 0;
       return {
         isDue: (now, everyMs) => now - last >= everyMs,
         markRun: (now) => {
           last = now;
         },
       };
     })();
   ```
   Step 6 (`:533-539`) becomes:
   ```ts
    // 6. Follow-back sweep on its slow cadence (IG traffic → paced, f10). The
    //    cadence is persisted by the composition root (Settings.sweepLastRunAt),
    //    so a restart no longer resets the rhythm to sweep-immediately.
    const sweepDueMs = this.settings.followbackSweepHours * MS_PER_HOUR;
    if (this.sweepCadence.isDue(now, sweepDueMs)) {
      await this.deps.followback.check();
      this.sweepCadence.markRun(now);
      await this.pacingSleep();
      return 'swept-followback';
    }
   ```
3. `foundation-wiring.ts` `build()`: after constructing `followback`, add:
   ```ts
    // The follow-back sweep cadence, persisted through Settings so the 4h rhythm
    // survives restarts (Settings.sweepLastRunAt; same pattern as pruneLastRunAt).
    const sweepCadence = this.scheduler.cadence('engine:followback-sweep', {
      getLastRunAt: () => this.resolveSettings().sweepLastRunAt,
      setLastRunAt: (at) => {
        void this.updateSettings({ sweepLastRunAt: at });
      },
    });
   ```
   and pass `sweepCadence,` into `createEngine({ … })`. (The `this.scheduler` field is created in Task 9 — if executing this task first, create it here: `private readonly scheduler = new ScheduleManager({ clock: new SystemClock() });` with the import, and Task 9 reuses it.)

- [ ] **Step 4: Run tests** — `npx jest tests/engine/engine.test.ts tests/settings tests/main` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings/settings.ts src/engine/engine.ts src/main/foundation-wiring.ts tests
git commit -m "feat(engine): persist the follow-back sweep cadence across restarts"
```

---

### Task 9: ScheduleManager adoption in the main process

**Files:**
- Modify: `src/main/connectivity.ts` (probe loop via ScheduleManager, constants from config)
- Modify: `src/main/foundation-wiring.ts` (scheduler-owned auto-prune watcher; constants from config)
- Test: `tests/main/connectivity.test.ts` (create if absent — check `ls tests/main`)

**Interfaces:**
- Consumes: `ScheduleManager` (Task 4), `CONNECTIVITY`, `SCHEDULER`, `PRUNE` from config.
- Produces: no public API changes — `ConnectivityMonitor.start()/stop()` and `Foundation.startScheduledPruneWatcher(intervalMs?)` keep their signatures (the watcher's default becomes `SCHEDULER.AUTO_PRUNE_CHECK_MS`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/main/connectivity.test.ts — the probe loop rides ScheduleManager.
// electron's `net` must be mocked BEFORE importing the module under test.
jest.mock('electron', () => ({
  net: { isOnline: () => false, request: () => { throw new Error('unused'); } },
}));
import { ConnectivityMonitor } from '@/main/connectivity';

describe('ConnectivityMonitor', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('reports offline on the first resolved check and only on change after', async () => {
    const changes: boolean[] = [];
    const mon = new ConnectivityMonitor((online) => changes.push(online), {
      intervalMs: 1000,
      timeoutMs: 100,
    });
    mon.start();
    await Promise.resolve(); // let the immediate check settle (isOnline short-circuit)
    expect(changes).toEqual([false]);
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(changes).toEqual([false]); // no change → no repeat callbacks
    mon.stop();
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(changes).toEqual([false]); // stopped → no further checks
  });
});
```

- [ ] **Step 2: Run to verify it fails / establish baseline** — `npx jest tests/main/connectivity.test.ts` (fails only if behavior drifts; the point is a pinned harness before the refactor. If it passes pre-refactor, that's the desired baseline — keep it.)

- [ ] **Step 3: Migrate `connectivity.ts`**

```ts
import { ScheduleManager } from '@/timing/schedule-manager';
import { SystemClock } from '@/governors/clock';
import { CONNECTIVITY } from '@/timing/config';
```

- Replace `const DEFAULT_INTERVAL_MS / DEFAULT_TIMEOUT_MS` with `CONNECTIVITY.PROBE_INTERVAL_MS` / `CONNECTIVITY.REQUEST_TIMEOUT_MS` at the two `??` sites.
- Replace the `timer` field and the `checking` flag with `private readonly scheduler = new ScheduleManager({ clock: new SystemClock() });` and `private started = false;`
- `start()`:
  ```ts
  /** Immediate check, then every `intervalMs`. Idempotent while running. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    // The ScheduleManager's overlap guard replaces the old `checking` flag:
    // a probe still in flight drops the tick instead of stacking.
    this.scheduler.every('connectivity:probe', this.intervalMs, () => this.check(), {
      immediate: true,
    });
  }
  ```
- `stop()`:
  ```ts
  stop(): void {
    this.stopped = true;
    this.started = false;
    this.scheduler.stop('connectivity:probe');
    this.inFlight?.abort();
    this.inFlight = null;
  }
  ```
- `check()` drops its own `checking` guard (keep the `stopped` check and change-detection). The per-request timeout mechanism stays as-is (it must `request.abort()` — a plain `withTimeout` can't reach into the request), just sourced from the config constant. Note this refinement vs. the spec's "withTimeout absorbs the connectivity request timeout pattern" — the abort coupling makes the local timer the honest implementation; record it in the commit message body.

- [ ] **Step 4: Migrate `foundation-wiring.ts`**

0. **The ONE shared DelayManager** (spec architecture — one wait owner, namespaced keys): in `build()`, after `const clock = new SystemClock();`, add
   ```ts
    // The shared wait owner: growth and prune wait through ONE DelayManager
    // (keys namespaced `engine:` / `prune:`), so pending deadlines are readable
    // from a single registry.
    const delays = new DelayManager({ clock });
   ```
   (`import { DelayManager } from '@/timing/delay-manager';`), pass `delays,` into BOTH `createEngine({ … })` and `createPruneEngine({ … })`, and store it on `BuiltGraph` (`delays: DelayManager;` field, `delays,` in the returned object) so `teardownGraph()` can call `graph.delays.dispose();` right before `graph.store.close();`.
1. Imports: `import { ScheduleManager } from '@/timing/schedule-manager'; import { PRUNE, SCHEDULER } from '@/timing/config';`
2. Field (if not already added in Task 8): `private readonly scheduler = new ScheduleManager({ clock: new SystemClock() });`
3. Delete `pruneSchedulerTimer` field; `startScheduledPruneWatcher`:
   ```ts
   startScheduledPruneWatcher(intervalMs = SCHEDULER.AUTO_PRUNE_CHECK_MS): void {
     this.scheduler.every(
       'prune:auto-watcher',
       intervalMs,
       () => this.maybeRunScheduledPrune(),
       { unref: true },
     );
   }
   ```
   (Idempotency now comes from `every()`'s per-key no-op.)
4. `dispose()`: replace the `pruneSchedulerTimer` clearing with `this.scheduler.dispose();`
5. Constants: `USERNAME_RESOLVE_ATTEMPTS`/`USERNAME_RESOLVE_RETRY_MS` (`:99-100`) → use `SCHEDULER.USERNAME_RESOLVE_ATTEMPTS` / `SCHEDULER.USERNAME_RESOLVE_RETRY_MS` at the call site (`resolveOwnUsername`), delete the locals. `PRUNE_PARK_TIMEOUT_MS` (`:109`) → `PRUNE.PARK_TIMEOUT_MS` at `:492`, delete the local (keep its doc comment on the config entry if not already equivalent).

- [ ] **Step 5: Run tests** — `npx jest tests/main` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/connectivity.ts src/main/foundation-wiring.ts tests/main/connectivity.test.ts
git commit -m "refactor(main): probe + auto-prune watcher ride ScheduleManager; constants from timing/config"
```

---

### Task 10: Cancellable adapter layer

**Files:**
- Modify: `src/adapter/actor.ts`, `src/adapter/instagram-adapter.ts`, `src/adapter/identity.ts`, `src/rim/profile-enricher.ts`, `src/rim/followers-page-reader.ts`, `src/main/foundation-wiring.ts`
- Tests: extend `tests/adapter/` actor test (check filename with `ls tests/adapter`), `tests/rim/profile-enricher.test.ts`, `tests/rim/followers-page-reader.test.ts`

**Interfaces:**
- Consumes: `sleep` from primitives; `ADAPTER`, `RIM` from config; `Engine.runSignal()` / `PruneEngine.runSignal()` (Tasks 6–7).
- Produces:
  - `ActorOptions` gains `/** Provider of the ACTIVE driver's abort signal; polled per wait iteration. */ abortSignal?: () => AbortSignal | undefined;`
  - `InstagramAdapter` constructor gains `opts?: { abortSignal?: () => AbortSignal | undefined; }` forwarded to `new Actor(tab, opts)`.
  - `resolveOwnUsername(tab, opts)` accepts `signal?: AbortSignal`.
  - `ProfileEnricherDeps` and `FollowersPageReaderDeps` gain `abortSignal?: () => AbortSignal | undefined;`
  - `FollowersPageReaderDeps.sleep` widens to `(ms: number, signal?: AbortSignal) => Promise<void>` (source-compatible with existing test fakes).

**Semantics (the approved behavior change):** the signal is the active driver's RUN token — it aborts on `stop()` (and engine restarts), not on pause. A pause still lets the in-flight step finish cleanly (the park/hand-off contract is unchanged); a stop now lands mid-poll instead of after up to 8 s.

- [ ] **Step 1: Write the failing tests**

Actor (adapt to the existing actor test file's fake-tab pattern):

```ts
test('waitFor aborts mid-poll when the provided signal fires', async () => {
  const ac = new AbortController();
  let evaluations = 0;
  const tab = makeFakeTab({
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) setTimeout(() => ac.abort(), 0);
      return { found: false }; // never satisfies `done`
    },
  });
  const actor = new Actor(tab, {
    pollIntervalMs: 10_000, // an un-abortable sleep would hang the test
    pollTimeoutMs: 60_000,
    abortSignal: () => ac.signal,
  });
  await expect(actor.follow('someone')).rejects.toThrow(); // AdapterStaleError: not found
  expect(evaluations).toBeLessThan(3); // returned promptly, not after the timeout
});
```

Enricher:

```ts
test('an aborted driver signal stops the pass between usernames', async () => {
  const ac = new AbortController();
  ac.abort();
  const deps = makeEnricherDeps({ abortSignal: () => ac.signal });
  const enricher = new AdapterBackedProfileEnricher(deps);
  const n = await enricher.enrich(['a', 'b', 'c']);
  expect(n).toBe(0); // never fetched
});
```

Page reader:

```ts
test('an aborted driver signal ends the scroll loop like shouldStop', async () => {
  const ac = new AbortController();
  ac.abort();
  const reader = new FollowersPageReader({ ...baseDeps, abortSignal: () => ac.signal });
  const result = await reader.collect({ ...baseArgs, maxRounds: 10, noNewStop: 5 });
  expect(scrolls).toBe(0); // no scroll round ran
});
```

- [ ] **Step 2: Run to verify failures** — `npx jest tests/adapter tests/rim`

- [ ] **Step 3: Implement**

**actor.ts:** delete local `sleep` (line 73); `import { sleep } from '@/timing/primitives'; import { ADAPTER } from '@/timing/config';` Defaults: `opts.pollIntervalMs ?? ADAPTER.POLL_INTERVAL_MS`, `opts.pollTimeoutMs ?? ADAPTER.POLL_TIMEOUT_MS`. Store `private readonly abortSignal?: () => AbortSignal | undefined;` Replace `waitFor`:

```ts
  /**
   * Poll `run` until `done` is satisfied or the timeout elapses — or the ACTIVE
   * driver's abort signal fires (a stop() must not sit out an 8s poll). An
   * aborted signal resolves null immediately, the same "control absent" shape
   * a timeout yields; when no signal is provided the old behavior holds
   * (always at least one attempt).
   */
  private async waitFor<T>(
    run: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T | null> {
    const signal = this.abortSignal?.();
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      if (signal?.aborted) return null;
      const value = await run();
      if (done(value)) return value;
      if (Date.now() >= deadline) return null;
      if (signal?.aborted) return null;
      await sleep(this.pollIntervalMs, signal);
    }
  }
```

**instagram-adapter.ts:**

```ts
  constructor(tab: AdapterTab, opts: { abortSignal?: () => AbortSignal | undefined } = {}) {
    this.actor = new Actor(tab, { abortSignal: opts.abortSignal });
    this.sentinel = new Sentinel(tab);
  }
```

**identity.ts:** delete local `sleep` (line 26); import `sleep` from primitives + `ADAPTER` from config. `opts` gains `signal?: AbortSignal`. Defaults: `attempts ?? ADAPTER.IDENTITY_ATTEMPTS`, `retryMs ?? ADAPTER.IDENTITY_RETRY_MS`. In the attempt loop, first line: `if (opts.signal?.aborted) return undefined;`. Nav-settle loop: `for (let i = 0; i < ADAPTER.NAV_SETTLE_ROUNDS; i++) { if (opts.signal?.aborted) return undefined; await sleep(ADAPTER.NAV_SETTLE_MS, opts.signal); … }`. Retry line: `await sleep(retryMs, opts.signal);`

**profile-enricher.ts:** delete `realSleep` + `DEFAULT_PACE_MS`; import `sleep` from primitives, `RIM` from config. Deps gain `abortSignal?`; `paceMs ?? RIM.ENRICH_PACE_MS`; `this.sleep = deps.sleep ?? sleep;` (widen the stored type to `(ms: number, signal?: AbortSignal) => Promise<void>`). Loop top (before the budget gate): `if (this.abortSignal?.()?.aborted) { logger.info('rim.profile-enricher: driver stopped, ending pass', { username }); break; }` — and `pace()` passes the live signal: `await this.sleep(this.paceMs, this.abortSignal?.());`

**followers-page-reader.ts:** deps gain `abortSignal?`; widen `sleep?` dep + `sleepFn` field to `(ms: number, signal?: AbortSignal) => Promise<void>`. In `collect`, fold the signal into the stop predicate and the waits:

```ts
    const externalStop = args.shouldStop ?? ((): boolean => false);
    const shouldStop = (): boolean =>
      externalStop() || this.abortSignal?.()?.aborted === true;
```

and both `await this.sleepFn(nextWaitMs())` sites become `await this.sleepFn(nextWaitMs(), this.abortSignal?.());`

**foundation-wiring.ts** (`build()`): define the provider and thread it:

```ts
    // The ACTIVE driver's run token: adapter/rim waits link to this so a stop()
    // interrupts an in-flight DOM poll instead of sitting out its timeout.
    const driverSignal = (): AbortSignal | undefined => {
      if (this.activeDriver === 'prune') return this.graph?.pruneEngine.runSignal();
      if (this.activeDriver === 'growth') return this.graph?.engine.runSignal();
      return undefined;
    };
    const adapter = new InstagramAdapter(this.tab, { abortSignal: driverSignal });
    …
    const pageReader = new FollowersPageReader({ tab: this.tab, reader, actor, abortSignal: driverSignal });
    …
    const enricher = new AdapterBackedProfileEnricher({ …, abortSignal: driverSignal });
```

Also add `private readonly disposeAbort = new AbortController();` — `dispose()` calls `this.disposeAbort.abort();` first, and `resolveOwnUsername` passes `signal: this.disposeAbort.signal` so a shutdown interrupts the identity retry loop.

- [ ] **Step 4: Run tests** — `npx jest tests/adapter tests/rim tests/main` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapter src/rim/profile-enricher.ts src/rim/followers-page-reader.ts src/main/foundation-wiring.ts tests
git commit -m "feat(adapter): cancellable waits — driver run token interrupts DOM polls and pacing"
```

---

### Task 11: Renderer — keep-alive dedupe, real countdown, bug fixes

**Files:**
- Create: `src/renderer/hooks/useKeepAlivePoll.ts`, `src/renderer/hooks/useSettings.ts`
- Modify: `src/renderer/hooks/useEngineStatus.ts`, `src/renderer/hooks/usePruneStatus.ts`, `src/renderer/hooks/useCountdown.ts`, `src/renderer/cards/overview/LiveStatusCard.tsx:81`, `src/renderer/charts/ProjectionChart.tsx`, `src/renderer/lib/motion.ts`, `src/renderer/cards/queues/QueueRowItem.tsx`, `src/renderer/views/QueuesView.tsx`
- Test: extend `tests/renderer/` if a hooks test exists (check `ls tests/renderer`); otherwise the renderer suite is chart-only — verify by typecheck/build + existing tests.

**Interfaces:**
- Consumes: `POLL` from `@/timing/config`; `EpoStatus.nextActionAt` (Task 6), `Settings` via `window.epo.getSettings()`.
- Produces:
  - `useKeepAlivePoll<T>(opts: { subscribe: (apply: (v: T) => void) => () => void; pull: () => Promise<T> }): T | null`
  - `useSettings(): Settings | null`
  - `useCountdown(status: EpoStatus | null): Countdown` (the `settings` parameter is REMOVED)
  - `QueueRowItemProps` gains `windows: { followbackMs: number; holdMs: number } | null`
  - `motion.ts` gains `export const PROJ_DASH_DROP_MS = 1300;`

- [ ] **Step 1: `useKeepAlivePoll.ts`**

```ts
// src/renderer/hooks/useKeepAlivePoll.ts
import { useEffect, useRef, useState } from 'preact/hooks';
import { POLL } from '@/timing/config';

/**
 * Push-first status subscription with a quiet-stream fallback (§4): subscribe to
 * the pushed channel, do exactly ONE pull on mount, and pull again ONLY when no
 * push has arrived within the keep-alive window — never on a cadence that would
 * overwrite fresh pushes. The one implementation behind useEngineStatus and
 * usePruneStatus (formerly byte-identical copies).
 */
export function useKeepAlivePoll<T>(opts: {
  subscribe: (apply: (v: T) => void) => () => void;
  pull: () => Promise<T>;
}): T | null {
  const [value, setValue] = useState<T | null>(null);
  const lastUpdateAt = useRef(0);
  // Pin the first render's opts: the effect runs once and the callers' inline
  // closures capture nothing mutable.
  const optsRef = useRef(opts);

  useEffect(() => {
    let alive = true;
    const { subscribe, pull } = optsRef.current;
    const apply = (v: T): void => {
      if (!alive) return;
      lastUpdateAt.current = Date.now();
      setValue(v);
    };
    const unsubscribe = subscribe(apply);
    pull().then(apply).catch(() => {
      // best-effort; a push or the keep-alive will fill this in
    });
    const keepalive = window.setInterval(() => {
      if (Date.now() - lastUpdateAt.current < POLL.KEEPALIVE_MS) return;
      pull().then(apply).catch(() => {});
    }, POLL.KEEPALIVE_MS);
    return () => {
      alive = false;
      window.clearInterval(keepalive);
      unsubscribe();
    };
  }, []);

  return value;
}
```

- [ ] **Step 2: Collapse the twin hooks**

```ts
// src/renderer/hooks/useEngineStatus.ts — full replacement
import type { EpoStatus } from '@/types';
import { useKeepAlivePoll } from './useKeepAlivePoll';

/** The single source of engine status for the whole shell (§4 — push-first). */
export function useEngineStatus(): EpoStatus | null {
  return useKeepAlivePoll<EpoStatus>({
    subscribe: (apply) => {
      const on = (s: EpoStatus): void => apply(s);
      window.epo.on('status', on);
      return () => window.epo.off('status', on);
    },
    pull: () => window.epo.status(),
  });
}
```

`usePruneStatus.ts` mirrors it with `PruneStatus`, channel `'pruneStatus'`, and `window.epo.pruneStatus()`.

- [ ] **Step 3: Real countdown**

```ts
// src/renderer/hooks/useCountdown.ts — full replacement
import { useEffect, useState } from 'preact/hooks';
import type { EpoStatus } from '@/types';

export interface Countdown {
  /** True while the engine is running and a real deadline is pending. */
  active: boolean;
  /** Seconds until the next action. */
  remainingSec: number;
  /** Remaining fraction of the interval (1 = just acted, 0 = due). */
  frac: number;
}

const IDLE: Countdown = { active: false, remainingSec: 0, frac: 0 };

/**
 * Time-to-next-action from the engine's REAL pending deadline (`nextActionAt`,
 * the DelayManager's registered action-delay deadline) — no more estimating from
 * the settings band midpoint. Ticks once a second while running.
 */
export function useCountdown(status: EpoStatus | null): Countdown {
  const [now, setNow] = useState(() => Date.now());

  const running = status?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running || !status || status.nextActionAt == null || status.lastActionAt == null) {
    return IDLE;
  }
  const intervalMs = status.nextActionAt - status.lastActionAt;
  if (intervalMs <= 0) return IDLE;
  const remaining = Math.max(0, status.nextActionAt - now);
  return {
    active: true,
    remainingSec: Math.round(remaining / 1000),
    frac: Math.min(1, Math.max(0, remaining / intervalMs)),
  };
}
```

Update `LiveStatusCard.tsx:81`: `const cd = useCountdown(status);` (drop the `settings` argument; remove the import/variable only if now unused elsewhere in the file).

- [ ] **Step 4: ProjectionChart cleanup + constant**

`motion.ts`: add
```ts
/** ProjectionChart: how long after draw-in the dash attrs are stripped. */
export const PROJ_DASH_DROP_MS = 1300;
```
`ProjectionChart.tsx`: import `PROJ_DASH_DROP_MS`; add `const dashTimer = useRef<number | null>(null);`; the `window.setTimeout(…, 1300)` becomes `dashTimer.current = window.setTimeout(…, PROJ_DASH_DROP_MS);`; the effect cleanup becomes:
```ts
    return () => {
      io.disconnect();
      if (dashTimer.current !== null) window.clearTimeout(dashTimer.current);
    };
```

- [ ] **Step 5: QueueRowItem windows from settings**

```ts
// src/renderer/hooks/useSettings.ts
import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '@/types';

/** One read-only settings pull on mount (no push channel exists for settings). */
export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    window.epo
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return settings;
}
```

`QueueRowItem.tsx`: props gain `windows: { followbackMs: number; holdMs: number } | null;` and `deriveContext(stage, row, now, windows)` uses `windows?.followbackMs ?? FOLLOWBACK_WINDOW_MS` / `windows?.holdMs ?? HOLD_MS` (the constants stay as documented fallbacks for the pre-settings render). `QueuesView.tsx`: `const settings = useSettings();` then
```ts
  const DAY_MS = 24 * 3600 * 1000;
  const windows = settings
    ? {
        followbackMs: settings.maxWaitForFollowbackDays * DAY_MS,
        holdMs: settings.holdAfterFollowbackDays * DAY_MS,
      }
    : null;
```
and pass `windows={windows}` to each `<QueueRowItem …>`.

- [ ] **Step 6: Verify** — `npx jest tests/renderer` then `npm run build` (renderer must bundle: confirms `@/timing/config` resolves in the esbuild renderer graph). Expected: PASS / clean build.

- [ ] **Step 7: Commit**

```bash
git add src/renderer tests/renderer
git commit -m "feat(renderer): real countdown deadlines, shared keep-alive hook, timer-leak and settings-desync fixes"
```

---

### Task 12: Harness migration + full verification

**Files:**
- Modify: `src/livetest/steps.ts`, `src/livetest/livetest-main.ts`, `src/capture/capture-harness.ts`, `src/capture/capture-main.ts`, `src/inspect/inspect-main.ts`

**Interfaces:** consumes `sleep`, `sample`, `uniform` from `@/timing/primitives`; `HARNESS` from `@/timing/config`. No exports change.

- [ ] **Step 1: Migrate each harness (mechanical, read each file as you go)**

- Delete every local `sleep`/`delay` helper (`steps.ts:59`, `livetest-main.ts:34`, `capture-harness.ts:678`, `capture-main.ts:43`, `inspect-main.ts:60`) and import `{ sleep }` from `@/timing/primitives`; rename call sites `delay(x)` → `sleep(x)`.
- `steps.ts:63-66` `jittered(min,max)` helper → delete; replace call sites with `sample(uniform(min, max))` (import `{ sample, uniform }`). The `steps.ts:382-386` multiplicative gap becomes `sample(uniform(followUnfollowGapMs * 0.7, followUnfollowGapMs * 1.6))` (same distribution as `gap * (0.7 + rng*0.9)`).
- `steps.ts:157-163` env-default fallbacks → `HARNESS.OP_DELAY_MIN_MS` / `OP_DELAY_MAX_MS` / `ENRICH_PACE_MIN_MS` / `ENRICH_PACE_MAX_MS` / `FOLLOW_UNFOLLOW_GAP_MS` (env overrides keep working).
- Named poll constants → config: `LOGIN_POLL_MS` (`livetest-main.ts:27`, `capture-main.ts:29`, `inspect-main.ts:42`) → `HARNESS.LOGIN_POLL_MS`; `DIALOG_SWEEP_MS` (`capture-harness.ts:51`) → `HARNESS.DIALOG_SWEEP_MS`; `INSPECT_POLL_MS` (`inspect-main.ts:45`) → `HARNESS.INSPECT_POLL_MS`.
- `capture-harness.ts` magic settles (4000/4000/2500/1500/4000 at `:380,386,396,426,467`) → `HARNESS.CAPTURE_NAV_SETTLE_MS` (the 4000s), `HARNESS.CAPTURE_DIALOG_SETTLE_MS` (2500), `HARNESS.CAPTURE_SHORT_SETTLE_MS` (1500).

- [ ] **Step 2: Duplication sweep**

Run: `grep -rn "new Promise[^;]*setTimeout" src/ --include="*.ts" --include="*.tsx"` — Expected: only `src/timing/primitives.ts` (and `connectivity.ts`'s request-timeout `setTimeout`, which is not a sleep). Any other hit is a missed migration — fix it.

- [ ] **Step 3: Full verification**

Run, in order, and confirm each is clean:
1. `npm run lint`
2. `npm test` (full suite, includes the sqlite rebuild)
3. `npm run build`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(harness): dev harnesses use timing primitives + registry; timing unification complete"
```

---

## Post-plan checks (executor sanity list)

- `grep -rn "Math.random" src/engine src/governors src/rim` → only injectable-default positions (`?? Math.random`), never a direct draw inside a delay computation.
- `grep -rn "interruptibleSleep" src` → no hits.
- Countdown behaves for prune-free growth AND is honest during prune (PruneStatus.nextActionAt exists for future UI use; the growth countdown reads EpoStatus only).
- The spec's §7 (config registry) deviation log: connectivity's request timeout keeps its local `setTimeout` (must abort the request), constants centralized; `pruneDue` stays the pure due-predicate (already tested; `cadence` would only wrap it).
