import { projectAccount } from '@/store/projections';
const obs = (pk: string, source: any, fields: any, t: number) =>
  ({ accountPk: pk, observedAt: t, source, fields });

test('list read creates a listed stub with private flag', () => {
  const s = projectAccount(null, obs('1', 'followers-list', { username: 'a', isPrivate: true }, 100));
  expect(s.username).toBe('a');
  expect(s.isPrivate).toBe(true);
  expect(s.enrichment).toBe('listed');
  expect(s.firstSeenAt).toBe(100);
});

test('profile read enriches to profiled and computes ratio', () => {
  let s = projectAccount(null, obs('1', 'followers-list', { username: 'a' }, 100));
  s = projectAccount(s, obs('1', 'profile', { followers: 100, following: 120 }, 200));
  expect(s.enrichment).toBe('profiled');
  expect(s.ratio).toBeCloseTo(1.2);
  expect(s.lastSeenAt).toBe(200);
});

test('cheap older list read does NOT clobber a rich profile field', () => {
  let s = projectAccount(null, obs('1', 'profile', { followers: 100, following: 120 }, 200));
  s = projectAccount(s, obs('1', 'followers-list', { followers: 999 }, 150));
  expect(s.followers).toBe(100); // profile (higher confidence, newer) wins
});

test('newer high-confidence read updates the field', () => {
  let s = projectAccount(null, obs('1', 'profile', { followers: 100, following: 120 }, 200));
  s = projectAccount(s, obs('1', 'profile', { followers: 130, following: 120 }, 300));
  expect(s.followers).toBe(130);
  expect(s.ratio).toBeCloseTo(120 / 130);
});
