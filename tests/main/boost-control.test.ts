/**
 * The Boost commands (spec §8.2, §8.5): typed refusals; "Start Epo and Boost" advances run intent,
 * then writes the window and re-plans (the act-now insertion sees desired = running), then starts
 * the engine — the order is a contract; manual prune runs and scans wait while a Boost is on.
 */
import { PlanService } from '@/governors/plan-service';
import { MS_PER_HOUR } from '@/kernel/units';
import { BoostControl, type BoostControlDeps, boostContributor } from '@/main/modules/boost-control';
import { PruneControl, type PruneControlDeps } from '@/main/modules/prune-control';
import { memoryPlanStore, planDeps, windowFor } from '../kit/plan';

const W = windowFor(new Date(2026, 10, 3, 12).getTime());

function rig(over: Partial<BoostControlDeps> = {}, at = W.startsAt + 9 * MS_PER_HOUR) {
  const calls: string[] = [];
  let intent: 'running' | 'stopped' | 'paused' = 'stopped';
  const store = memoryPlanStore();
  const clock = { t: at };
  const service = new PlanService(planDeps(store, clock, { runIntent: () => intent }));
  const control = new BoostControl({
    plan: () => service,
    runIntent: () => intent,
    advanceRunIntent: () => { calls.push(`advance(${intent})`); intent = 'running'; },
    startEngine: () => { calls.push(`start(${intent})`); },
    runtimeBlocked: () => false,
    hasSeed: () => true,
    followsSince: () => 0,
    now: () => clock.t,
    ...over,
  });
  const writes = (): number => store.writes;
  const raw = () => JSON.parse(store.raw ?? 'null');
  return { control, service, calls, clock, writes, raw, setIntent: (i: typeof intent) => { intent = i; } };
}

describe('refusals are typed', () => {
  test('bad duration, signed out, no seed, runtime blocked', () => {
    expect(rig().control.startBoost(Number.NaN, { alsoStart: false })).toMatchObject({ kind: 'refused', reason: 'bad-duration' });
    expect(rig({ plan: () => null }).control.startBoost(4, { alsoStart: false })).toMatchObject({ kind: 'refused', reason: 'signed-out' });
    expect(rig({ hasSeed: () => false }).control.startBoost(4, { alsoStart: false })).toMatchObject({ reason: 'no-seed' });
    expect(rig({ runtimeBlocked: () => true }).control.startBoost(4, { alsoStart: false })).toMatchObject({ reason: 'runtime-blocked' });
    expect(rig({ plan: () => null }).control.previewBoost(4)).toBeNull();
  });

  test('already on, and not on', () => {
    const r = rig();
    r.setIntent('running');
    expect(r.control.startBoost(4, { alsoStart: false }).kind).toBe('started');
    expect(r.control.startBoost(4, { alsoStart: false })).toMatchObject({ kind: 'refused', reason: 'already-on' });
    expect(r.control.endBoost().kind).toBe('ended');
    expect(r.control.endBoost()).toMatchObject({ kind: 'refused', reason: 'not-on' });
  });
});

describe('Start Epo and Boost', () => {
  test('advance run intent → write the window and re-plan → start the engine, in that order', () => {
    const r = rig();
    const before = r.writes();
    const result = r.control.startBoost(4, { alsoStart: true });
    expect(result.kind).toBe('started');
    expect(r.calls).toEqual(['advance(stopped)', 'start(running)']);
    expect(r.writes()).toBeGreaterThan(before);
    expect(r.raw()?.boost?.durationMs).toBe(4 * MS_PER_HOUR);
  });

  test('insertion keys on run intent: the window written after the advance inserts a session now when one can open', () => {
    let inserted = 0;
    for (let h = 7; h < 20; h += 1) {
      const r = rig({}, W.startsAt + h * MS_PER_HOUR);
      const busy = r.service.view(r.clock.t).open !== null;
      r.control.startBoost(4, { alsoStart: true });
      const plan = r.raw()?.plan;
      if (!busy && plan.sessions.some((s: { startAt: number }) => s.startAt === r.clock.t)) inserted += 1;
      const stopped = rig({}, W.startsAt + h * MS_PER_HOUR);
      stopped.control.startBoost(4, { alsoStart: false });
      expect(stopped.raw()?.plan.sessions.some((s: { startAt: number }) => s.startAt === stopped.clock.t)).toBe(false);
    }
    expect(inserted).toBeGreaterThan(0);
  });

  test('a Boost left on while stopped shows paused; its status contributor reports it', () => {
    const r = rig();
    r.control.startBoost(4, { alsoStart: false });
    expect(r.control.view().state).toBe('paused');
    expect(boostContributor(r.control).contribute(null, r.clock.t)).toEqual({ boost: r.control.view() });
  });

  test('hours clamp to the Boost bounds', () => {
    const r = rig();
    r.setIntent('running');
    r.control.startBoost(99, { alsoStart: false });
    expect(r.raw()?.boost?.durationMs).toBe(24 * MS_PER_HOUR);
  });
});

test('manual prune runs and scans are refused while a Boost is on', () => {
  let boost = false;
  const deps = {
    runtime: { ready: () => true }, lease: { owner: () => null }, online: () => true, manualDriving: () => false,
    boostActive: () => boost, graph: () => null,
  } as unknown as PruneControlDeps;
  const prune = new PruneControl(deps);
  expect(prune.pruneRefusalReason()).toBeNull();
  boost = true;
  expect(prune.pruneRefusalReason()).toBe('boost-active');
});
