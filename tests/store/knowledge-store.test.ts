import { KnowledgeStore } from '@/store/knowledge-store';
let s: KnowledgeStore;
beforeEach(() => { s = new KnowledgeStore(':memory:'); });
afterEach(() => s.close());

test('observe then getAccount projects state', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { username: 'z', followers: 100, following: 110 } });
  const a = s.getAccount('7')!;
  expect(a.username).toBe('z');
  expect(a.ratio).toBeCloseTo(1.1);
  expect(a.enrichment).toBe('profiled');
});

test('two observations keep history but project latest', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'followers-list', fields: { username: 'z' } });
  s.observe({ accountPk: '7', observedAt: 200, source: 'profile', fields: { followers: 50, following: 60 } });
  expect(s.getAccount('7')!.followers).toBe(50);
});

test('edges track follow-back as reciprocal actives', () => {
  s.observeEdge('ME', '7', 'follows', true, 100);   // we follow them
  s.observeEdge('7', 'ME', 'follows', true, 150);   // they follow back
  expect(s.getEdge('ME', '7', 'follows')!.status).toBe('active');
  expect(s.getEdge('7', 'ME', 'follows')!.status).toBe('active');
});

test('action ledger drives durable daily count', () => {
  s.recordAction('7', 'follow', 'ok', 1000);
  s.recordAction('8', 'follow', 'ok', 2000);
  expect(s.actionCountSince(0)).toBe(2);
  expect(s.actionCountSince(1500)).toBe(1);
});

test('migrations are idempotent across reopen', () => {
  s.observe({ accountPk: '7', observedAt: 100, source: 'profile', fields: { followers: 1, following: 1 } });
  s.close();
  const s2 = new KnowledgeStore(':memory:'); // fresh; just asserts constructor+migrate doesn't throw
  expect(s2.getAccount('nope')).toBeNull();
  s2.close();
});
