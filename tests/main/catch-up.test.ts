/**
 * The launch catch-up's admission and startup step (spec §9.6, Appendix E): passive reads go on under an
 * operational block (ADR 0210 amended); an identity, rate or unknown block, a holding ladder, an offline
 * machine or a sentinel wall skip it with a typed reason; the step runs the sweep in launch mode only.
 */
import { blockKind, type CatchUpAdmission, catchUpAdmission, catchUpStep } from '@/main/modules/catch-up';
import type { BuiltGraph } from '@/main/services/graph-types';
import { cleanupMainHarness, newFoundation } from '../kit/main-harness';

const OK = { identity: 'confirmed', online: true, sentinel: 'ok', recovery: 'idle', block: null } as const;

describe('blockKind', () => {
  test.each([
    ['chain-exhausted', 'operational'], ['seed-unresolved', 'operational'],
    ['account-changed', 'identity'], ['login-required', 'identity'], ['sentinel:logged-out', 'identity'],
    ['sentinel:challenge', 'identity'], ['identity-changed', 'identity'],
    ['sentinel:action-blocked', 'rate'], ['rate-limited', 'rate'], ['recovery-exhausted', 'rate'], ['blocked-repeatedly', 'rate'],
    ['adapter-drift', 'unknown'], ['tab-recovery-failed', 'unknown'], ['something-new', 'unknown'],
  ])('%s is %s', (reason, kind) => {
    expect(blockKind(reason)).toBe(kind);
  });
});

describe('catchUpAdmission', () => {
  test('a confirmed, online, unblocked launch runs; an operational block does not stop the reads', () => {
    expect(catchUpAdmission(OK)).toEqual({ run: true });
    expect(catchUpAdmission({ ...OK, block: 'chain-exhausted' })).toEqual({ run: true });
    expect(catchUpAdmission({ ...OK, block: 'seed-unresolved' })).toEqual({ run: true });
    expect(catchUpAdmission({ ...OK, recovery: 'probing' })).toEqual({ run: true });
  });

  test.each<[Partial<Parameters<typeof catchUpAdmission>[0]>, CatchUpAdmission]>([
    [{ identity: 'missing' }, { run: false, why: 'signed-out' }],
    [{ identity: 'changed' }, { run: false, why: 'account-changed' }],
    [{ online: false }, { run: false, why: 'offline' }],
    [{ sentinel: 'logged-out' }, { run: false, why: 'signed-out' }],
    [{ sentinel: 'action-blocked' }, { run: false, why: 'wall' }],
    [{ sentinel: 'challenge' }, { run: false, why: 'blocked' }],
    [{ recovery: 'holding' }, { run: false, why: 'holding' }],
    [{ block: 'login-required' }, { run: false, why: 'signed-out' }],
    [{ block: 'account-changed' }, { run: false, why: 'account-changed' }],
    [{ block: 'rate-limited' }, { run: false, why: 'wall' }],
    [{ block: 'adapter-drift' }, { run: false, why: 'blocked' }],
  ])('%j skips with its reason', (patch, expected) => {
    expect(catchUpAdmission({ ...OK, ...patch })).toEqual(expected);
  });
});

describe('catchUpStep', () => {
  const sweep = () => ({ run: jest.fn(async () => undefined), skip: jest.fn() });
  const holds: string[] = [];
  const tab = (free = true) => ({ tabFree: () => free, hold: async <T>(run: () => Promise<T>) => {
    holds.push('catch-up');
    return run();
  } });

  test('an admitted step runs the sweep in launch mode with the step signal', async () => {
    const s = sweep();
    const step = catchUpStep(s, async () => ({ run: true }), tab());
    expect(step.name).toBe('catch-up');
    expect(step.when()).toBe(true);
    const signal = new AbortController().signal;
    await step.run(signal);
    expect(s.run).toHaveBeenCalledWith('launch', signal);
    expect(s.skip).not.toHaveBeenCalled();
    expect(holds).toContain('catch-up');
  });

  test('a refused step records the skip and reads nothing', async () => {
    const s = sweep();
    await catchUpStep(s, async () => ({ run: false, why: 'offline' }), tab()).run(new AbortController().signal);
    expect(s.skip).toHaveBeenCalledWith('offline');
    expect(s.run).not.toHaveBeenCalled();
  });

  test('a tab another driver holds keeps the step from running at all', () => {
    expect(catchUpStep(sweep(), async () => ({ run: true }), tab(false)).when()).toBe(false);
  });
});

describe('the composed graph (spec §9.6, workplan I.4)', () => {
  afterAll(cleanupMainHarness);

  test('the built graph returns the catch-up step and the five reopen contributors; the status carries them', async () => {
    const { foundation: f } = newFoundation({ catchUp: true });
    expect(await f.ensureBuilt()).toBe(true);
    const graph = (f as unknown as { graph: BuiltGraph | null }).graph;
    expect(graph?.startupSteps.map((s) => s.name)).toEqual(['catch-up']);
    expect(graph?.statusContributors.map((c) => c.name)).toEqual(expect.arrayContaining(['catchUp', 'own', 'today', 'journal', 'requests']));
    const status = await f.status();
    expect(status.catchUp).toMatchObject({ state: 'idle' });
    expect(status.journal).toEqual({ pending: 0, parked: 0, nextAttemptAt: null });
    await f.dispose();
  });
});
