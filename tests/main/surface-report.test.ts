/**
 * The surface report (spec §10.7): today's tallies per area, the recorded changes with friendly field names,
 * the meter's percentiles, and a copy text that carries scrubbed samples but no id, no username and no digit
 * run of six or more. Before a graph exists the handler answers the not-built report.
 */

import { surfaceHandlers } from '@/main/ipc-surface';
import { createSurfaceReport } from '@/main/services/surface-report';
import { SURFACE_AREAS } from '@/shared/surface-health';
import { SurfaceMeter } from '@/surface/meter';
import { memoryStore } from '../kit/store';

const S = '2026-08-12';
const day = { window: () => ({ key: 'd2', startsAt: 0, endsAt: 1e13, quietMinute: 0 }), dayKey: () => 'd2', onRoll: () => () => {} };
const clock = { now: () => Date.UTC(2026, 10, 3, 12) };
const zero = { canonical: 0, normalized: 0, recovered: 0, failed: 0, walls: 0, rowIssues: 0, fieldIssues: 0,
  shadowDisagreed: 0, readAt: null, okAt: null, failAt: null };

function seeded() {
  const store = memoryStore();
  store.surface.addHealth('d1', S, 'followers-list', { ...zero, canonical: 5, readAt: 100, okAt: 100 });
  store.surface.addHealth('d2', S, 'followers-list', { ...zero, canonical: 2, failed: 1, rowIssues: 3, readAt: 200, okAt: 150, failAt: 200 });
  store.surface.upsertSignal({ signature: 'a', surfaceId: S, endpoint: 'followers-list', cls: 'more-without-cursor',
    path: 'has_more', detail: '{"got":"boolean"}', at: 180 });
  store.surface.upsertSignal({ signature: 'b', surfaceId: S, endpoint: 'profile-graphql', cls: 'expected-absent',
    path: 'data.user.biography', detail: '{}', at: 190 });
  store.surface.setSample('b', '{"data":{"user":{"pk":"700000000123","username":"user_a1","full_name":"Name A1"}}}');
  const meter = new SurfaceMeter();
  meter.record('list-page', 120);
  return { store, report: createSurfaceReport({ store, surfaceId: S, day, clock, meter }) };
}

test('areas carry their state, what they pause, the newest read and today’s tallies', () => {
  const r = seeded().report.report();
  expect(r.surfaceId).toBe(S);
  expect(r.areas.map((a) => a.area)).toEqual([...SURFACE_AREAS]);
  expect(r.areas.find((a) => a.area === 'lists')).toEqual({ area: 'lists', state: 'paused', paused: ['cleanup'],
    lastReadAt: 200, today: { canonical: 2, normalized: 0, recovered: 0, failed: 1, walls: 0, rowIssues: 3, fieldIssues: 0 } });
  expect(r.areas.find((a) => a.area === 'profiles')).toMatchObject({ state: 'paused', paused: ['unfollows'], lastReadAt: null });
  expect(r.meter['list-page']).toEqual({ n: 1, p50: 120, p95: 120 });
});

test('changes name their field and say whether a sample exists', () => {
  const { changes } = seeded().report.report();
  expect(changes.map((c) => [c.area, c.cls, c.field, c.hasSample])).toEqual([
    ['lists', 'more-without-cursor', 'has_more', false],
    ['profiles', 'expected-absent', 'biography', true],
  ]);
});

test('the copy text explains in plain words, carries the sample, and leaks no id or long digit run', () => {
  const { copyText } = seeded().report.report();
  expect(copyText).toContain('pruning waits');
  expect(copyText).toContain('Profiles: bio is missing');
  expect(copyText).toContain('sample: {"data":{"user":{"pk":"#"');
  expect(copyText).not.toMatch(/\d{6,}/);
  expect(copyText).not.toContain('700000000123');
});

test('before a graph exists the handler answers the not-built report', async () => {
  const r = await surfaceHandlers().surfaceReport();
  expect(r.areas.every((a) => a.state === 'unseen')).toBe(true);
  expect(r.changes).toEqual([]);
});
