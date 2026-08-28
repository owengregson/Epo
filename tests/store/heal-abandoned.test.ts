/**
 * Requeue-healer store half (migration 11): the `abandoned_at`/`healed_at`
 * stamps on follow_records and `healAbandonedInWindow` — the honest rules for
 * requeueing records a closed systemic-incident window burned. Real `:memory:`
 * store; the migration test builds a pre-migration-11 file DB exactly as a
 * live install would have it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { KnowledgeStore } from '@/store/knowledge-store';
import { MIGRATIONS } from '@/store/schema';
import type { FollowRecord } from '@/store/types';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

let s: KnowledgeStore;
beforeEach(() => { s = new KnowledgeStore(':memory:'); });
afterEach(() => s.close());

const rec = (over: Partial<FollowRecord> & { accountPk: string }): FollowRecord => ({
  targetPk: null,
  state: 'queued',
  retryCount: 0,
  ...over,
});

/** An active chain target the healed records can honestly aim at. */
const seedTarget = (pk = 'T'): void => {
  s.addTarget({ accountPk: pk, source: 'seed', status: 'active', chainIndex: 0 });
};

// Window used throughout: [1000, 2000]; heals stamped at now=5000.
const heal = (over: Partial<Parameters<KnowledgeStore['healAbandonedInWindow']>[0]> = {}) =>
  s.healAbandonedInWindow({ windowStartMs: 1000, windowEndMs: 2000, cap: 200, now: 5000, ...over });

test('an existing pre-migration-11 database migrates cleanly, preserving abandoned rows un-stamped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-heal-mig-'));
  try {
    const dbPath = path.join(dir, 'pre.db');
    // Build a database at the schema version just BEFORE the abandoned_at/
    // healed_at migration (the final entry), exactly as a live install has it.
    const raw = new Database(dbPath);
    const prior = MIGRATIONS.length - 1;
    for (let i = 0; i < prior; i += 1) raw.exec(MIGRATIONS[i]);
    raw.pragma(`user_version = ${prior}`);
    raw
      .prepare(
        `INSERT INTO follow_records (account_pk, state, retry_count) VALUES (?, 'abandoned', 4)`,
      )
      .run('legacy');
    const before = raw.prepare(`PRAGMA table_info(follow_records)`).all() as Array<{ name: string }>;
    expect(before.some((c) => c.name === 'abandoned_at')).toBe(false);
    expect(before.some((c) => c.name === 'healed_at')).toBe(false);
    raw.close();

    // Opening through the store applies the pending migration.
    const store = new KnowledgeStore(dbPath);
    const got = store.getFollowRecord('legacy')!;
    expect(got.state).toBe('abandoned');
    expect(got.retryCount).toBe(4);
    expect(got.abandonedAt).toBeUndefined();
    expect(got.healedAt).toBeUndefined();
    // The new columns work end to end.
    store.upsertFollowRecord({ ...got, abandonedAt: 1500, healedAt: 9000 });
    expect(store.getFollowRecord('legacy')).toMatchObject({ abandonedAt: 1500, healedAt: 9000 });
    store.close();

    const check = new Database(dbPath);
    expect(check.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    check.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('abandonedAt/healedAt round-trip; upserts that omit them preserve, never erase', () => {
  s.upsertFollowRecord(rec({ accountPk: '1', state: 'abandoned', abandonedAt: 1500 }));
  expect(s.getFollowRecord('1')).toMatchObject({ abandonedAt: 1500 });
  expect(s.getFollowRecord('1')!.healedAt).toBeUndefined();

  // A partial upsert (no stamps) must not wipe history (same rule as score).
  s.upsertFollowRecord(rec({ accountPk: '1', state: 'queued' }));
  expect(s.getFollowRecord('1')).toMatchObject({ state: 'queued', abandonedAt: 1500 });

  // A re-abandonment writes a FRESH stamp (non-null excluded wins).
  s.upsertFollowRecord(rec({ accountPk: '1', state: 'abandoned', abandonedAt: 8000 }));
  expect(s.getFollowRecord('1')).toMatchObject({ abandonedAt: 8000 });
});

test('heals only in-window abandoned records: queued again, retries reset, healed_at stamped', () => {
  seedTarget();
  s.upsertFollowRecord(
    rec({ accountPk: 'in', targetPk: 'T', state: 'abandoned', retryCount: 4, abandonedAt: 1500 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'before', targetPk: 'T', state: 'abandoned', retryCount: 4, abandonedAt: 999 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'after', targetPk: 'T', state: 'abandoned', retryCount: 4, abandonedAt: 2001 }),
  );

  const result = heal();
  expect(result).toEqual({ healed: 1, toQueued: 1, toUnfollowQueued: 0, skippedUnworkable: 0 });
  expect(s.getFollowRecord('in')).toMatchObject({
    state: 'queued',
    retryCount: 0,
    healedAt: 5000,
    abandonedAt: 1500, // history stays — the heal is a new fact, not a rewrite
  });
  expect(s.getFollowRecord('before')!.state).toBe('abandoned');
  expect(s.getFollowRecord('after')!.state).toBe('abandoned');
});

test('the funnel moves with the heal: the abandoned segment shrinks, queued grows (§2/§4)', () => {
  seedTarget();
  s.upsertFollowRecord(
    rec({ accountPk: 'a', targetPk: 'T', state: 'abandoned', retryCount: 4, abandonedAt: 1500 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'b', targetPk: 'T', state: 'abandoned', retryCount: 4, abandonedAt: 1600 }),
  );
  expect(s.targetFunnel('T').states).toMatchObject({ abandoned: 2, queued: 0 });

  heal();
  expect(s.targetFunnel('T').states).toMatchObject({ abandoned: 0, queued: 2 });
});

test('an abandonment that ate the UNFOLLOW leg heals to unfollow_queued, never a re-follow', () => {
  seedTarget();
  s.upsertFollowRecord(
    rec({
      accountPk: 'u',
      targetPk: 'T',
      state: 'abandoned',
      retryCount: 4,
      followedAt: 500, // already followed — requeueing as 'queued' would double-follow
      unfollowDueAt: 900,
      abandonedAt: 1500,
    }),
  );
  const result = heal();
  expect(result).toMatchObject({ healed: 1, toQueued: 0, toUnfollowQueued: 1 });
  expect(s.getFollowRecord('u')).toMatchObject({
    state: 'unfollow_queued',
    retryCount: 0,
    followedAt: 500,
    unfollowDueAt: 900,
  });
});

test('a record heals exactly ONCE: re-abandoned later, a covering window leaves it abandoned', () => {
  seedTarget();
  s.upsertFollowRecord(
    rec({ accountPk: 'x', targetPk: 'T', state: 'abandoned', retryCount: 4, abandonedAt: 1500 }),
  );
  expect(heal().healed).toBe(1);

  // Later the healed record burns out again — this time for real.
  const healed = s.getFollowRecord('x')!;
  s.upsertFollowRecord({ ...healed, state: 'abandoned', retryCount: 4, abandonedAt: 7000 });

  // A new incident window covering the re-abandonment: the spent heal blocks it.
  const again = s.healAbandonedInWindow({ windowStartMs: 6000, windowEndMs: 8000, cap: 200, now: 9000 });
  expect(again.healed).toBe(0);
  expect(s.getFollowRecord('x')!.state).toBe('abandoned');
});

test('the cap bounds the batch, best-scored first; the remainder stays put', () => {
  seedTarget();
  s.upsertFollowRecord(
    rec({ accountPk: 'low', targetPk: 'T', state: 'abandoned', abandonedAt: 1500, score: 1 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'high', targetPk: 'T', state: 'abandoned', abandonedAt: 1500, score: 9 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'mid', targetPk: 'T', state: 'abandoned', abandonedAt: 1500, score: 5 }),
  );

  const result = heal({ cap: 2 });
  expect(result.healed).toBe(2);
  expect(s.getFollowRecord('high')!.state).toBe('queued');
  expect(s.getFollowRecord('mid')!.state).toBe('queued');
  expect(s.getFollowRecord('low')!.state).toBe('abandoned'); // capped out, un-healed
});

test('records aimed at a retired/exhausted target stay abandoned (unworkable), counted', () => {
  seedTarget('ACTIVE');
  s.addTarget({ accountPk: 'DONE', source: 'seed', status: 'exhausted', chainIndex: 1 });
  s.addTarget({ accountPk: 'KEPT', source: 'seed', status: 'retained', chainIndex: 2 });
  s.upsertFollowRecord(
    rec({ accountPk: 'ok', targetPk: 'ACTIVE', state: 'abandoned', abandonedAt: 1500 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'gone', targetPk: 'DONE', state: 'abandoned', abandonedAt: 1500 }),
  );
  s.upsertFollowRecord(
    rec({ accountPk: 'held', targetPk: 'KEPT', state: 'abandoned', abandonedAt: 1500 }),
  );
  // A target_pk with no targets row at all: workability is unverifiable → skip.
  s.upsertFollowRecord(
    rec({ accountPk: 'orphan', targetPk: 'MISSING', state: 'abandoned', abandonedAt: 1500 }),
  );

  const result = heal();
  expect(result).toMatchObject({ healed: 1, skippedUnworkable: 3 });
  expect(s.getFollowRecord('ok')!.state).toBe('queued');
  expect(s.getFollowRecord('gone')!.state).toBe('abandoned');
  expect(s.getFollowRecord('held')!.state).toBe('abandoned');
  expect(s.getFollowRecord('orphan')!.state).toBe('abandoned');
});

test('a record with NO target is workable (the churn queue is target-agnostic) and heals', () => {
  s.upsertFollowRecord(rec({ accountPk: 'n', targetPk: null, state: 'abandoned', abandonedAt: 1500 }));
  expect(heal().healed).toBe(1);
  expect(s.getFollowRecord('n')!.state).toBe('queued');
});

test('legacy rows without abandoned_at fall back to the last fail ledger row — the nearest fact', () => {
  seedTarget();
  // The abandoning attempt wrote its fail row at the same moment (in-window).
  s.upsertFollowRecord(rec({ accountPk: 'lgc', targetPk: 'T', state: 'abandoned', retryCount: 4 }));
  s.recordAction('lgc', 'follow', 'fail', 1200);
  s.recordAction('lgc', 'follow', 'fail', 1600); // the abandoning fail — the signal
  // A legacy row whose last fail predates the window: honestly outside it.
  s.upsertFollowRecord(rec({ accountPk: 'old', targetPk: 'T', state: 'abandoned', retryCount: 4 }));
  s.recordAction('old', 'follow', 'fail', 500);
  // No stamp AND no fail row: no honest signal → never healed off absence.
  s.upsertFollowRecord(rec({ accountPk: 'mute', targetPk: 'T', state: 'abandoned', retryCount: 4 }));

  const result = heal();
  expect(result.healed).toBe(1);
  expect(s.getFollowRecord('lgc')!.state).toBe('queued');
  expect(s.getFollowRecord('old')!.state).toBe('abandoned');
  expect(s.getFollowRecord('mute')!.state).toBe('abandoned');
});

test('the heal fires the store mutation callback (§2 — the UI mirrors the graph, live)', () => {
  seedTarget();
  s.upsertFollowRecord(
    rec({ accountPk: 'm', targetPk: 'T', state: 'abandoned', abandonedAt: 1500 }),
  );
  let fired = 0;
  const off = s.onMutation(() => { fired += 1; });
  heal();
  expect(fired).toBe(1);
  off();
});

test('recovery last-incident meta round-trips and clears', () => {
  expect(s.getRecoveryLastIncident()).toBeNull();
  s.setRecoveryLastIncident('{"enteredAt":1}');
  expect(s.getRecoveryLastIncident()).toBe('{"enteredAt":1}');
  s.setRecoveryLastIncident(null);
  expect(s.getRecoveryLastIncident()).toBeNull();
});
