/**
 * Prune ledger (Phase 5): the migration applies on a fresh `:memory:` db and
 * `recordPruneAction`/`pruneCountSince` mirror `recordAction`/`actionCountSince`
 * over the prune-own table — independent of growth's action_ledger.
 */
import { KnowledgeStore } from '@/store/knowledge-store';

let s: KnowledgeStore;
beforeEach(() => {
  s = new KnowledgeStore(':memory:');
});
afterEach(() => s.close());

test('migration applies on a fresh db: the prune ledger exists and starts empty', () => {
  expect(s.pruneCountSince(0)).toBe(0);
});

test('recordPruneAction drives the durable daily count (at >= sinceMs)', () => {
  s.recordPruneAction('7', 'ok', 1000);
  s.recordPruneAction('8', 'fail', 2000);
  s.recordPruneAction('9', 'simulated', 3000);
  expect(s.pruneCountSince(0)).toBe(3);
  expect(s.pruneCountSince(2000)).toBe(2); // boundary is inclusive
  expect(s.pruneCountSince(2001)).toBe(1);
  expect(s.pruneCountSince(3001)).toBe(0);
});

test('the prune ledger is independent of growth’s action ledger', () => {
  s.recordAction('7', 'unfollow', 'ok', 1000);
  expect(s.pruneCountSince(0)).toBe(0);
  s.recordPruneAction('7', 'ok', 1000);
  expect(s.actionCountSince(0)).toBe(1);
  expect(s.pruneCountSince(0)).toBe(1);
});
