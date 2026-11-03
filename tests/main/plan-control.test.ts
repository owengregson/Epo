/**
 * The plan's triggers (spec §5.6): the build ensures and arms the next edge; the edge ensures and
 * re-arms; a settings change, a resume and a census reach the plan; a write pushes the status and
 * wakes the plan parks once the build is done; dispose stops the edge and the settings watch; a
 * failing ensure is logged and never thrown.
 */
import { PlanControl, type PlanControlDeps } from '@/main/modules/plan-control';
import * as logger from '@/utils/logger';

const HOUR = 3_600_000;

function rig(over: Partial<PlanControlDeps['plan']> = {}) {
  const calls: string[] = [];
  const timers = new Map<string, { at: number; fn: () => void | Promise<void> }>();
  let listener: (() => void) | null = null;
  const clock = { t: 1_000, now: () => clock.t };
  let control: PlanControl | null = null;
  const plan: PlanControlDeps['plan'] = {
    ensure: () => {
      calls.push('ensure');
      control?.changed();
      return undefined as never;
    },
    onSettings: () => {
      calls.push('settings');
      return undefined as never;
    },
    onDemand: () => {
      calls.push('demand');
      return undefined as never;
    },
    nextEdgeAt: (now = clock.t) => now + HOUR,
    ...over,
  };
  control = new PlanControl({
    plan,
    scheduler: {
      after: (key, ms, fn) => {
        timers.set(key, { at: clock.t + ms, fn });
      },
      stop: (key) => {
        timers.delete(key);
      },
    },
    settings: {
      onChange: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    },
    clock,
    pushStatus: () => calls.push('push'),
    wake: () => calls.push('wake'),
  });
  return { control, calls, timers, clock, fire: () => listener?.(), listening: () => listener !== null };
}

test('the build ensures without pushing, then arms the next edge and watches the settings', () => {
  const r = rig();
  r.control.start();
  expect(r.calls).toEqual(['ensure']);
  expect(r.timers.get('plan:edge')?.at).toBe(1_000 + HOUR);
  expect(r.listening()).toBe(true);
});

test('the edge ensures and re-arms; a write pushes the status and wakes the plan parks', async () => {
  const r = rig();
  r.control.start();
  r.calls.length = 0;
  r.clock.t += HOUR;
  await r.timers.get('plan:edge')?.fn();
  expect(r.calls).toEqual(['ensure', 'push', 'wake']);
  expect(r.timers.get('plan:edge')?.at).toBe(r.clock.t + HOUR);
});

test('a settings change, a resume and a census reach the plan', () => {
  const r = rig();
  r.control.start();
  r.calls.length = 0;
  r.fire();
  r.control.resumed();
  r.control.demandChanged();
  expect(r.calls).toEqual(['settings', 'ensure', 'push', 'wake', 'demand']);
});

test('dispose stops the edge and the settings watch; a later change is ignored', () => {
  const r = rig();
  r.control.start();
  r.control.dispose();
  expect(r.timers.size).toBe(0);
  expect(r.listening()).toBe(false);
  r.calls.length = 0;
  r.control.changed();
  expect(r.calls).toEqual([]);
});

test('a failing ensure or edge read is logged and never thrown', () => {
  const logged: string[] = [];
  logger.setSink((level, message) => {
    if (level === 'error') logged.push(message);
  });
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
  const r = rig({
    ensure: () => {
      throw new Error('database is not open');
    },
    nextEdgeAt: () => {
      throw new Error('database is not open');
    },
  });
  expect(() => r.control.start()).not.toThrow();
  expect(() => r.control.resumed()).not.toThrow();
  expect(r.timers.size).toBe(0);
  expect(logged).toEqual(['plan: ensure failed', 'plan: the next edge could not be read', 'plan: ensure failed',
    'plan: the next edge could not be read']);
  logger.setSink(null);
  quiet.mockRestore();
});
