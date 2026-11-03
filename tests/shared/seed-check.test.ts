/**
 * `toLegacySeedCheck` maps the typed seed result down to the older wire shape
 * with the exact reason strings today's checker sends and today's Settings view
 * reads (`useSeedCheck.ts`), so re-typing the core changes nothing on the wire.
 */

import { type LegacySeedCheck, type SeedCheckResult, toLegacySeedCheck } from '@/shared/seed-check';

const refused = (reason: string): LegacySeedCheck =>
  ({ ok: false, exists: false, followersVisible: false, isPrivate: false, reason });

test('an ok result keeps visibility and privacy; a hidden private seed says private', () => {
  const ok = { kind: 'ok', pk: '1', followers: 10, observedAt: 5, fromStore: false } as const;
  expect(toLegacySeedCheck({ ...ok, isPrivate: false, followersVisible: true })).toEqual({
    ok: true, exists: true, followersVisible: true, isPrivate: false, reason: undefined,
  });
  expect(toLegacySeedCheck({ ...ok, isPrivate: true, followersVisible: false })).toEqual({
    ok: true, exists: true, followersVisible: false, isPrivate: true, reason: 'private',
  });
});

test('every refusal maps to the reason string the older checker sent', () => {
  const table: Array<[SeedCheckResult, string]> = [
    [{ kind: 'not-found', evidence: 'profile-absent', observedAt: 1 }, 'not-found'],
    [{ kind: 'not-found', evidence: 'page-text', observedAt: 1 }, 'not-found'],
    [{ kind: 'queued', why: 'engine' }, 'engine-running'],
    [{ kind: 'queued', why: 'prune' }, 'prune-running'],
    [{ kind: 'queued', why: 'manual' }, 'manual-running'],
    [{ kind: 'queued', why: 'runtime-blocked' }, 'runtime-not-ready'],
    [{ kind: 'queued', why: 'starting' }, 'runtime-not-ready'],
    [{ kind: 'queued', why: 'offline' }, 'offline'],
    [{ kind: 'queued', why: 'signed-out' }, 'not-logged-in'],
    [{ kind: 'queued', why: 'read-budget' }, 'read-budget'],
    [{ kind: 'unreadable', why: 'walled' }, 'blocked'],
    [{ kind: 'unreadable', why: 'challenge' }, 'blocked'],
    [{ kind: 'unreadable', why: 'signed-out' }, 'not-logged-in'],
    [{ kind: 'unreadable', why: 'no-answer' }, 'error'],
    [{ kind: 'unreadable', why: 'aborted' }, 'error'],
    [{ kind: 'unreadable', why: 'drift' }, 'error'],
    [{ kind: 'unreadable', why: 'error' }, 'error'],
    [{ kind: 'invalid-handle' }, 'empty'],
  ];
  for (const [result, reason] of table) expect(toLegacySeedCheck(result)).toEqual(refused(reason));
});
