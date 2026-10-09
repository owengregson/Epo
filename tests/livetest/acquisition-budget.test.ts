import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { SURFACE } from '@/adapter/ig-surface';
import type { InstagramTab } from '@/adapter/tab';
import { LiveTestHarness } from '@/livetest/steps';
import { FakeTab, followersBody } from '../kit/fakes';

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));

test('a one-round live test reads only one direct page and preserves its partial cursor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'epo-livetest-budget-'));
  const priorRounds = process.env.EPO_TEST_ACQUIRE_ROUNDS;
  process.env.EPO_TEST_ACQUIRE_ROUNDS = '1';
  jest.mocked(app.getPath).mockReturnValue(directory);
  jest.useFakeTimers();
  const tab = new FakeTab();
  let pages = 0;
  tab.onEvaluate = (script) => {
    if (script === SURFACE.bodyTextProbeScript()) return '';
    pages += 1;
    return {
      ok: true, status: 200, contentType: 'application/json',
      json: followersBody([`person${pages}`], `cursor${pages}`, true),
    };
  };
  const harness = new LiveTestHarness(tab as unknown as InstagramTab);
  const graph = harness['buildGraph']('999', 'target');
  try {
    graph.store.observe({
      accountPk: '999', observedAt: Date.now(), source: 'profile', fields: { username: 'target' },
    });
    const acquiring = graph.acquisition.acquire('target');
    await jest.runAllTimersAsync();
    const result = await acquiring;
    expect(pages).toBe(1);
    expect(result).toMatchObject({ observed: 1, targetPk: '999', endReason: 'page-budget' });
    expect(graph.store.getScrapeCursor('999')).toBe('cursor1');
    expect(graph.store.getEdge('person1', '999', 'follows')).not.toBeNull();
  } finally {
    graph.store.close();
    jest.useRealTimers();
    if (priorRounds === undefined) delete process.env.EPO_TEST_ACQUIRE_ROUNDS;
    else process.env.EPO_TEST_ACQUIRE_ROUNDS = priorRounds;
    rmSync(directory, { recursive: true, force: true });
  }
});
