/**
 * The in-memory sink as a hint book and a tally (spec §10.6–§10.7): a hint is consistent once the threshold of
 * distinct subjects agreed with none against, a contradiction ends it, and the snapshot counts reads per tally.
 */

import { MemorySink } from '@/surface/sink';

const hinted = (subject: string | null, agreed = true) => ({
  endpoint: 'profile-graphql' as const, cls: 'recovered' as const, path: 'data.x.user', detail: {},
  hint: { role: 'profile-user' as const, pattern: 'data.x.user', subject, agreed },
});

test('consistent first, then open; a contradicted hint is never offered', () => {
  const sink = new MemorySink(2);
  sink.drift(hinted('a'), 1);
  expect(sink.patterns('profile-graphql', 'profile-user')).toEqual(['data.x.user']);
  sink.drift(hinted('a'), 2);
  expect(sink.snapshot().hints[0]).toMatchObject({ witnesses: 1, state: 'open' });
  sink.drift(hinted('b'), 3);
  expect(sink.snapshot().hints[0]).toMatchObject({ witnesses: 2, state: 'consistent' });
  sink.drift(hinted(null, false), 4);
  expect(sink.patterns('profile-graphql', 'profile-user')).toEqual([]);
});

test('learned operations come from consistent unrouted hints only', () => {
  const sink = new MemorySink(1);
  sink.drift({ endpoint: 'activity-feed', cls: 'unrouted', path: 'op', detail: {},
    hint: { role: 'feed-stories', pattern: 'NewFeedQuery', subject: 'pass-1', agreed: true } }, 1);
  expect(sink.learnedOps()).toEqual([{ op: 'NewFeedQuery', kind: 'activity-feed' }]);
});

test('the snapshot tallies reads per endpoint and tally', () => {
  const sink = new MemorySink();
  sink.read('followers-list', 'canonical', { rows: 0, fields: 0 }, 1);
  sink.read('followers-list', 'canonical', { rows: 0, fields: 0 }, 2);
  sink.read('followers-list', 'wall', { rows: 0, fields: 0 }, 3);
  expect(sink.snapshot().tallies).toEqual({ 'followers-list': { canonical: 2, wall: 1 } });
});
