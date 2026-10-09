/**
 * Store helpers for tests: an in-memory KnowledgeStore that is always closed.
 *
 * Both accept the store's ambient-dependency options, so a suite that asserts
 * on day buckets or a drawn seed can pin `now`/`rng` instead of racing the
 * machine's calendar.
 */
import { KnowledgeStore, type KnowledgeStoreOptions } from '@/store/knowledge-store';

/** Open a fresh `:memory:` store, run `fn`, and close the store afterwards. */
export async function withStore<T>(
  fn: (store: KnowledgeStore) => Promise<T> | T,
  opts?: KnowledgeStoreOptions,
): Promise<T> {
  const store = new KnowledgeStore(':memory:', opts);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/** A `:memory:` store for suites that manage the lifecycle themselves (close it in `afterEach`). */
export const memoryStore = (opts?: KnowledgeStoreOptions): KnowledgeStore =>
  new KnowledgeStore(':memory:', opts);
