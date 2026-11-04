/**
 * The mutation cadence over a real plan and store (spec §5.13 S2): the admission asked before any
 * visit, the deadline drawn from the session's gap spec and persisted at dispatch, restart-stable,
 * one deadline per accept pass, and the manual headroom.
 */
import { ActionDeferredError } from '@/adapter/errors';
import { createMutationCadence } from '@/main/services/mutation-cadence';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { type SessionPlanRig, sessionPlanRig } from '../kit/harness-plan';

let rig: SessionPlanRig;
beforeEach(() => {
  rig = sessionPlanRig();
});
afterEach(() => rig.dispose());

const cadence = () => createMutationCadence({ plan: rig.plan.service, store: rig.store });
const view = () => rig.plan.service.view(rig.clock.now());
const write = (pk: string, action: 'follow' | 'unfollow' = 'follow') => {
  const at = rig.clock.now();
  const intent = rig.store.beginEffectIntent({ accountPk: pk, username: pk, action, channel: 'growth', at });
  rig.store.markEffectDispatched(intent.id, at);
  rig.store.settleEffectIntent(intent.id, { at, result: 'ok', ledger: 'growth' });
};

describe('preflight: the plan admission before any visit', () => {
  test('inside the open session a follow is admitted; an owed deadline refuses exactly until it', () => {
    const c = cadence();
    expect(c.preflight('follow', 'growth', rig.clock.now(), { pk: 'a' })).toEqual({ ok: true });
    rig.store.setActionDelayDeadline(rig.clock.now() + 60_000);
    expect(c.preflight('follow', 'growth', rig.clock.now(), { pk: 'a' }))
      .toEqual({ ok: false, reason: 'deadline', until: rig.clock.now() + 60_000 });
  });

  test("between sessions the refusal is typed and carries the next session's start", () => {
    const open = view().open;
    expect(open).not.toBeNull();
    const closesAt = view().sessions[open?.idx ?? 0].closesAt ?? 0;
    rig.clock.t = closesAt + 1;
    const next = view().nextSessionAt;
    expect(cadence().preflight('follow', 'growth', rig.clock.now())).toEqual({ ok: false, reason: 'session-closed', until: next });
  });

  test("an account's own open write refuses it with the typed journal reason; other accounts proceed", () => {
    const intent = rig.store.beginEffectIntent({ accountPk: 'x', username: 'x', action: 'unfollow', channel: 'growth', at: rig.clock.now() });
    rig.store.markEffectDispatched(intent.id, rig.clock.now());
    const c = cadence();
    expect(c.preflight('unfollow', 'growth', rig.clock.now(), { pk: 'x' })).toEqual({ ok: false, reason: 'journal', until: null });
    expect(c.preflight('follow', 'growth', rig.clock.now(), { pk: 'y' })).toEqual({ ok: true });
  });
});

describe('armAtDispatch: the deadline drawn at dispatch', () => {
  test("re-checks, draws within the session's gap spec and persists the deadline", () => {
    const spec = view().tempo.gap;
    const now = rig.clock.now();
    const deadline = cadence().armAtDispatch('follow', 'growth', now, { pk: 'a' });
    expect(rig.store.getActionDelayDeadline()).toBe(deadline);
    expect(deadline - now).toBeGreaterThanOrEqual(spec.floorMs);
    expect(deadline - now).toBeLessThanOrEqual(spec.capMs);
  });

  test('the draw is restart-stable: a new process at the same ledger draws the same deadline', () => {
    const now = rig.clock.now();
    const first = cadence().armAtDispatch('follow', 'growth', now, { pk: 'a' });
    rig.store.setActionDelayDeadline(null);
    expect(cadence().armAtDispatch('follow', 'growth', now, { pk: 'a' })).toBe(first);
    // The session's next write draws at the next coordinate.
    write('a');
    rig.store.setActionDelayDeadline(null);
    rig.clock.advance(1);
    expect(cadence().armAtDispatch('follow', 'growth', rig.clock.now(), { pk: 'b' }) - rig.clock.now()).not.toBe(first - now);
  });

  test('a refusal at dispatch throws a typed deferral and persists nothing', () => {
    const owed = rig.clock.now() + 1_000;
    rig.store.setActionDelayDeadline(owed);
    let thrown: unknown;
    try {
      cadence().armAtDispatch('follow', 'growth', rig.clock.now(), { pk: 'a' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ActionDeferredError);
    expect(thrown).toMatchObject({ reason: 'deadline', until: owed });
    expect(rig.store.getActionDelayDeadline()).toBe(owed);
  });

  test('a manual write while a deadline is owed never shortens it', () => {
    const owed = rig.clock.now() + 3 * 3_600_000;
    rig.store.setActionDelayDeadline(owed);
    expect(cadence().armAtDispatch('follow', 'manual', rig.clock.now(), { pk: 'a' })).toBe(owed);
  });
});

describe('accept passes: one deadline per pass, inside the accept budget', () => {
  test("a pass admits up to the plan's allowance, spends one gap draw and owes it after its last accept", () => {
    const c = cadence();
    const now = rig.clock.now();
    const allowed = view().acceptsAllowed(Number.POSITIVE_INFINITY, 0);
    expect(allowed).toBeGreaterThan(1);
    const armed: number[] = [];
    for (let i = 0; i < allowed; i += 1) {
      expect(c.acceptAllowed(rig.clock.now())).toBe(true);
      armed.push(c.acceptPassEnded(rig.clock.now()) - rig.clock.now());
      rig.clock.advance(2_000);
    }
    expect(c.acceptAllowed(rig.clock.now())).toBe(false);
    // One gap for the whole pass, re-anchored on each accept: the last one owes it.
    expect(new Set(armed).size).toBe(1);
    expect(rig.store.getActionDelayDeadline()).toBe(now + (allowed - 1) * 2_000 + armed[0]);
  });

  test("another write's deadline closes the pass; after it a new pass opens", () => {
    const c = cadence();
    expect(c.acceptAllowed(rig.clock.now())).toBe(true);
    c.acceptPassEnded(rig.clock.now());
    const followDeadline = c.armAtDispatch('follow', 'manual', rig.clock.now(), { pk: 'a' });
    rig.store.setActionDelayDeadline(followDeadline + 1);
    expect(c.acceptAllowed(rig.clock.now())).toBe(false);
    rig.clock.t = followDeadline + 2;
    expect(c.acceptAllowed(rig.clock.now())).toBe(true);
  });

  test.each(['dailyHardCeiling', 'hourlyVelocityCap', 'dailyOperatingRate'] as const)(
    'an owed pass rechecks a lowered %s before another accept', (key) => {
      const c = cadence();
      expect(c.acceptAllowed(rig.clock.now())).toBe(true);
      const owed = c.acceptPassEnded(rig.clock.now());
      write('accepted');
      rig.host.change({ [key]: 1 });
      expect(owed).toBeGreaterThan(rig.clock.now());
      expect(c.acceptAllowed(rig.clock.now())).toBe(false);
      expect(rig.store.getActionDelayDeadline()).toBe(owed);
    });

  test('a joined session closing ends its accept pass even while its own gap is owed', () => {
    write('joined');
    const open = view().open?.idx ?? 0;
    const closesAt = view().sessions[open].closesAt ?? 0;
    rig.clock.t = closesAt - 1;
    const c = cadence();
    expect(c.acceptAllowed(rig.clock.now())).toBe(true);
    const owed = c.acceptPassEnded(rig.clock.now());
    rig.clock.advance(2);
    expect(owed).toBeGreaterThan(rig.clock.now());
    expect(c.acceptAllowed(rig.clock.now())).toBe(false);
  });

  test('a lowered per-pass cap counts accepts already completed by the pass', () => {
    let lowered = false;
    const c = createMutationCadence({ store: rig.store, plan: { view: (now) => {
      const v = rig.plan.service.view(now);
      return lowered ? { ...v, plan: { ...v.plan, ceilings: { ...v.plan.ceilings, acceptsPerPass: 1 } } } : v;
    } } });
    expect(c.acceptAllowed(rig.clock.now())).toBe(true);
    c.acceptPassEnded(rig.clock.now());
    lowered = true;
    expect(c.acceptAllowed(rig.clock.now())).toBe(false);
  });

  test.each(['day', 'session'] as const)('a changed %s cannot inherit an earlier accept pass', (changed) => {
    let moved = false;
    const c = createMutationCadence({ store: rig.store, plan: { view: (now) => {
      const v = rig.plan.service.view(now);
      if (!moved) return v;
      return changed === 'day' ? { ...v, window: { ...v.window, key: `${v.window.key}-changed` } }
        : { ...v, plan: { ...v.plan, sessions: v.plan.sessions.map((s) => ({ ...s, startAt: s.startAt + 1 })) } };
    } } });
    expect(c.acceptAllowed(rig.clock.now())).toBe(true);
    c.acceptPassEnded(rig.clock.now());
    moved = true;
    expect(c.acceptAllowed(rig.clock.now())).toBe(false);
  });
});

test('manualOpen is the ceiling and the hourly cap only', () => {
  rig.dispose();
  rig = sessionPlanRig({ ...DEFAULT_SETTINGS, dailyHardCeiling: 2 });
  const c = cadence();
  expect(c.manualOpen(rig.clock.now())).toEqual({ ok: true });
  write('a');
  write('b');
  expect(c.manualOpen(rig.clock.now())).toMatchObject({ ok: false, reason: 'ceiling' });
});
