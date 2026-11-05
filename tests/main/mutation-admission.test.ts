import { ActionAbortedError, ActionDeferredError } from '@/adapter/errors';
import { createMutationAdmission, type ReviewedAction } from '@/main/services/mutation-admission';
import type { MutationCadence } from '@/main/services/mutation-cadence';
import { DEFAULT_SETTINGS } from '@/settings/settings';

/** An admission over a recording cadence: what each dispatch arms, and the accept pass it asks. */
function admission(o: { reviewed?: ReviewedAction | null; refuse?: boolean; active?: boolean; dryRun?: boolean; duringActive?: () => void } = {}) {
  const armed: Parameters<MutationCadence['armAtDispatch']>[] = [];
  let ended = 0;
  const cadence: MutationCadence = {
    preflight: () => ({ ok: true }),
    armAtDispatch: (...args) => {
      if (o.refuse) throw new ActionDeferredError('deferred at dispatch: deadline', { reason: 'deadline', until: 5 });
      armed.push(args);
      return 2_000;
    },
    acceptPassEnded: () => { ended += 1; return 3_000; },
    acceptAllowed: () => true,
    manualOpen: () => ({ ok: true }),
    armPractice: () => 0,
    velocityParkUntil: () => null,
  };
  let reviewed = o.reviewed ?? null;
  const gate = createMutationAdmission({ clock: { now: () => 1_000 }, cadence, settings: () => ({ ...DEFAULT_SETTINGS, dryRun: o.dryRun ?? false }),
    active: async () => { o.duringActive?.(); return o.active ?? true; }, takeReviewed: () => { const r = reviewed; reviewed = null; return r; } });
  return { gate, armed, ended: () => ended };
}

test('the dispatch closure arms the reviewed action exactly once, with its kind, writer and subject', async () => {
  const a = admission({ reviewed: { kind: 'unfollow', writer: 'woven', subject: { pk: 'p' } } });
  await a.gate.beforeMutation();
  expect(a.armed).toEqual([['unfollow', 'woven', 1_000, { pk: 'p' }]]);
});

test('a dispatch with no review before it is held to the manual headroom', async () => {
  const a = admission();
  await a.gate.beforeMutation();
  expect(a.armed).toEqual([['follow', 'manual', 1_000, undefined]]);
});

test("a refusal at dispatch propagates the cadence's typed deferral; a stopped driver aborts first", async () => {
  await expect(admission({ refuse: true }).gate.beforeMutation()).rejects.toMatchObject({ reason: 'deadline', until: 5 });
  const stopped = admission({ active: false });
  await expect(stopped.gate.beforeMutation()).rejects.toBeInstanceOf(ActionAbortedError);
  expect(stopped.armed).toEqual([]);
});

test('accepts ask the pass and end it once per accept; practice mode never accepts', async () => {
  const a = admission();
  expect(await a.gate.canAccept()).toBe(true);
  a.gate.onAccepted();
  expect(a.ended()).toBe(1);
  expect(await admission({ dryRun: true }).gate.canAccept()).toBe(false);
});

test('Practice enabled after a review refuses dispatch before arming a real write', async () => {
  const options = { dryRun: false, reviewed: { kind: 'unfollow' as const, writer: 'cleanup-run' as const, subject: { pk: 'p' } } };
  const a = admission(options);
  options.dryRun = true;
  await expect(a.gate.beforeMutation()).rejects.toBeInstanceOf(ActionAbortedError);
  expect(a.armed).toEqual([]);
});

test('Practice enabled during the async identity check refuses dispatch and request acceptance', async () => {
  const options = { dryRun: false, duringActive: () => { options.dryRun = true; } };
  const a = admission(options);
  await expect(a.gate.beforeMutation()).rejects.toBeInstanceOf(ActionAbortedError);
  expect(a.armed).toEqual([]);
  options.dryRun = false;
  expect(await a.gate.canAccept()).toBe(false);
});
