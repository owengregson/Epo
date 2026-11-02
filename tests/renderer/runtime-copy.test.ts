import { frontierCaption, runtimeHold } from '@/renderer/cards/overview/runtime-copy';
import { transportModel } from '@/renderer/lib/engine-view';
import { idleStatus } from '../kit/render-bridge';

test('portfolio reports real rotation reasons and eligibility rather than exhaustion', () => {
  const now = Date.now();
  const status = idleStatus({ frontier: { version: 1, currentTargetPk: 'a', totalFollows: 4,
    recentFollowSources: ['a'], sources: [
      { pk: 'a', source: 'seed', status: 'working', resumeAt: now, lastVisitedAt: now,
        totalFollows: 4, lastReason: null, visit: { startedAt: now, follows: 4, slices: 1,
          emptySlices: 0, rows: 20, globallyNew: 15, profiles: 10, eligible: 4 } },
      { pk: 'b', source: 'seed', status: 'deferred', resumeAt: now + 3_600_000,
        lastVisitedAt: now - 10, totalFollows: 0, visit: null, lastReason: 'low-yield' },
    ] } });
  expect(frontierCaption(status, [], now)).toEqual([
    'This visit: 4 follows · 2 sources in rotation',
    'Last rotation: few eligible people found.',
    expect.stringMatching(/^Next revisit eligible /),
  ]);
});

test('manual prune keeps its countdown while growth is deliberately stopped', () => {
  const status = idleStatus({ runtime: { desired: 'stopped', phase: 'ready', blockedReason: null,
    lastProgressAt: null, progressPhase: null, incidents: [] } });
  expect(runtimeHold(status)?.headline).toBe('Stopped');
  expect(runtimeHold(status, true)).toBeNull();
});

test('the transport retains cancel intent through recovery while an active prune keeps its own controls', () => {
  const runtime = { desired: 'running' as const, phase: 'recovering' as const, blockedReason: null,
    lastProgressAt: null, progressPhase: null, incidents: [] };
  expect(transportModel('idle', 'idle', runtime)).toMatchObject({ driver: 'growth', intentActive: true });
  expect(transportModel('idle', 'running', runtime)).toMatchObject({ driver: 'prune', state: 'running' });
});
