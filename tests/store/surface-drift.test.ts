/**
 * The surface drift repo (spec §10.6–§10.7, migration 16): first sightings, repeats and re-opened episodes,
 * witnessed hints, clean-read resolution, per-plan-day health, retention, and the meter's meta round trip.
 * Bounds and day keys are arguments; the repo computes no day.
 */

import type { DriftUpsert, HealthDelta } from '@/store/repos/surface-drift';
import { memoryStore } from '../kit/store';
import { withLegacyDb } from '../kit/store-legacy-db';

const S = '2026-08-12';
const sig = (over: Partial<DriftUpsert> = {}): DriftUpsert => ({
  signature: `${S}|profile-graphql|recovered|data.user`, surfaceId: S, endpoint: 'profile-graphql', cls: 'recovered',
  path: 'data.user', detail: JSON.stringify({ role: 'profile-user' }), at: 1_000, hintPattern: 'data.x.user', ...over,
});
const delta = (over: Partial<HealthDelta> = {}): HealthDelta => ({ canonical: 0, normalized: 0, recovered: 0, failed: 0,
  walls: 0, rowIssues: 0, fieldIssues: 0, shadowDisagreed: 0, readAt: null, okAt: null, failAt: null, ...over });

test('an upgraded database (schema 13) migrates and takes surface rows', () => {
  withLegacyDb(13, (db) => {
    const store = db.open();
    expect(store.surface.upsertSignal(sig()).firstSighting).toBe(true);
    store.surface.addHealth('2026-11-02', S, 'profile-graphql', delta({ canonical: 1, readAt: 5, okAt: 5 }));
    expect(store.surface.health(S, '')).toHaveLength(1);
  });
});

describe('signatures', () => {
  test('a repeat counts and is no first sighting; a resolved signature seen again re-opens as one', () => {
    const repo = memoryStore().surface;
    repo.upsertSignal(sig());
    const again = repo.upsertSignal(sig({ at: 2_000 }));
    expect(again.firstSighting).toBe(false);
    expect(again.row).toMatchObject({ seen: 2, firstSeenAt: 1_000, lastSeenAt: 2_000, state: 'open' });
    expect(repo.noteCleanRead(S, 'profile-graphql', null, 3_000, 2, 2)).toBe(1);
    const reopened = repo.upsertSignal(sig({ at: 4_000 }));
    expect(reopened.firstSighting).toBe(true);
    expect(reopened.row).toMatchObject({ state: 'open', firstSeenAt: 4_000, cleanReads: 0 });
  });

  test('hints: distinct agreeing subjects make it consistent; one contradiction ends it', () => {
    const repo = memoryStore().surface;
    const { row } = repo.upsertSignal(sig());
    repo.witness(row.signature, 'pk-1', true, 1_100, 2);
    repo.witness(row.signature, 'pk-1', true, 1_200, 2);
    expect(repo.signatureOf(row.signature)?.state).toBe('open');
    expect(repo.witness(row.signature, 'pk-2', true, 1_300, 2)).toMatchObject({ state: 'consistent', witnesses: 2 });
    expect(repo.hintPatterns(S, 'profile-graphql', 'profile-user')).toEqual(['data.x.user']);
    expect(repo.hintPatterns(S, 'profile-graphql', 'username-field')).toEqual([]);
    expect(repo.witness(row.signature, 'pk-3', false, 1_400, 2)?.state).toBe('contradicted');
    expect(repo.hintPatterns(S, 'profile-graphql', 'profile-user')).toEqual([]);
  });

  test('learned operations are consistent unrouted hints only', () => {
    const repo = memoryStore().surface;
    const unrouted = sig({ signature: `${S}|activity-feed|unrouted|op`, endpoint: 'activity-feed', cls: 'unrouted',
      path: 'op', hintPattern: 'NewFeedQuery' });
    repo.upsertSignal(unrouted);
    expect(repo.learnedOps(S)).toEqual([]);
    repo.witness(unrouted.signature, 'pass-1', true, 1, 1);
    expect(repo.learnedOps(S)).toEqual([{ op: 'NewFeedQuery', kind: 'activity-feed' }]);
  });

  test('clean reads resolve every class but a shadow disagreement, and only at the threshold', () => {
    const repo = memoryStore().surface;
    repo.upsertSignal(sig());
    repo.upsertSignal(sig({ signature: `${S}|profile-graphql|shadow-disagreed|x`, cls: 'shadow-disagreed', path: 'x' }));
    expect(repo.noteCleanRead(S, 'profile-graphql', null, 2_000, 3)).toBe(0);
    expect(repo.noteCleanRead(S, 'profile-graphql', null, 2_100, 3, 2)).toBe(1);
    expect(repo.openSignatures(S).map((r) => r.cls)).toEqual(['shadow-disagreed']);
  });

  test('a shipped update resolves the signatures of the surface it replaced', () => {
    const repo = memoryStore().surface;
    repo.upsertSignal(sig({ signature: 'old|profile-graphql|recovered|data.user', surfaceId: 'old' }));
    repo.upsertSignal(sig());
    expect(repo.resolveOtherSurfaces(S, 9_000)).toBe(1);
    expect(repo.openSignatures('old')).toEqual([]);
    expect(repo.openSignatures(S)).toHaveLength(1);
  });
});

describe('health, retention and the meter', () => {
  test('health counters add up per plan-day and keep the newest read, ok and failure times', () => {
    const repo = memoryStore().surface;
    repo.addHealth('2026-11-02', S, 'followers-list', delta({ canonical: 2, rowIssues: 1, readAt: 10, okAt: 10 }));
    repo.addHealth('2026-11-02', S, 'followers-list', delta({ failed: 1, readAt: 20, failAt: 20 }));
    repo.addHealth('2026-11-03', S, 'followers-list', delta({ walls: 1, readAt: 30 }));
    expect(repo.health(S, '2026-11-02')[0]).toMatchObject({ canonical: 2, failed: 1, rowIssues: 1, lastReadAt: 20,
      lastOkAt: 10, lastFailAt: 20 });
    expect(repo.health(S, '2026-11-03').map((h) => h.walls)).toEqual([1]);
  });

  test('prune keeps the newest plan-days, recent resolved rows, and caps an endpoint informational-first', () => {
    const repo = memoryStore().surface;
    for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) repo.addHealth(day, S, 'profile-graphql', delta({ canonical: 1 }));
    repo.upsertSignal(sig({ signature: 'a', cls: 'novel-key', path: 'a', at: 5 }));
    repo.upsertSignal(sig({ signature: 'b', cls: 'mismatch', path: 'b', at: 1 }));
    repo.upsertSignal(sig({ signature: 'c', cls: 'recovered', path: 'c', at: 9 }));
    repo.upsertSignal(sig({ signature: 'gone', cls: 'mismatch', path: 'gone', at: 2 }));
    repo.noteCleanRead(S, 'profile-graphql', 'gone', 3, 1);
    repo.prune({ healthDays: 2, resolvedBefore: 4, maxPerEndpoint: 2 });
    expect(repo.health(S, '').map((h) => h.day)).toEqual(['2026-11-02', '2026-11-03']);
    expect(repo.openSignatures(S).map((r) => r.signature).sort()).toEqual(['b', 'c']);
  });

  test('samples since a plan-day start count only signatures first seen in it', () => {
    const repo = memoryStore().surface;
    repo.upsertSignal(sig({ signature: 'early', at: 10 }));
    repo.setSample('early', '{}');
    repo.upsertSignal(sig({ signature: 'late', at: 100 }));
    repo.setSample('late', '{}');
    expect(repo.samplesSince(S, 50)).toBe(1);
  });

  test('the meter round-trips through meta, and every write bumps the revision', () => {
    const repo = memoryStore().surface;
    const before = repo.revision;
    repo.setMeter('{"v":1,"samples":{}}');
    expect(repo.meter()).toBe('{"v":1,"samples":{}}');
    repo.upsertSignal(sig());
    expect(repo.revision).toBeGreaterThan(before);
  });
});
