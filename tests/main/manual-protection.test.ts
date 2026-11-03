/**
 * P9 (spec §7.1): a manual unfollow the click review refuses for protection comes back as a typed
 * refusal naming the verdict, with nothing pressed and its journal intent cancelled.
 */
import type { Foundation } from '@/main/foundation-wiring';
import type { BuiltGraph } from '@/main/services/graph-builder';
import type { ClickVerdict } from '@/shared/click-verdict';
import { cleanupMainHarness, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);
const graphOf = (f: Foundation): BuiltGraph => (f as unknown as { session: { current(): BuiltGraph } }).session.current();

test.each<ClickVerdict>([
  { kind: 'protected', by: 'account', match: '77' },
  { kind: 'protection-unknown', missing: 'bio' },
  { kind: 'protection-paused', state: 'needs-review' },
])('unfollowOne refuses with the verdict ($kind) and settles nothing', async (verdict) => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  graph.store.observe({ accountPk: '77', observedAt: Date.now(), source: 'profile', fields: { username: 'target' } });
  const note = jest.spyOn(graph, 'noteMutation');
  jest.spyOn(graph.churnActions, 'unfollow').mockResolvedValue({ status: 'reviewed', verdict });
  expect(await foundation.unfollowOne('target')).toEqual({ ok: false, username: 'target', reason: verdict.kind });
  expect(note).not.toHaveBeenCalled();
  expect(graph.store.pendingEffectIntents()).toEqual([]);
  expect(graph.store.actionCountSince(0)).toBe(0);
  await foundation.dispose();
});
