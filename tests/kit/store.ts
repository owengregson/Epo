/**
 * Store helpers for tests: every test store opens through {@link openTestStore},
 * which injects the kernel's store policy exactly as main does.
 *
 * Each accepts the store's ambient-dependency options, so a suite that asserts
 * on day buckets or a drawn seed can pin `now`/`rng` instead of racing the
 * machine's calendar.
 */
import { STORE_POLICY } from '@/kernel/store-policy';
import { KnowledgeStore, type KnowledgeStoreOptions } from '@/store/knowledge-store';
import type { StorePolicy } from '@/store/types';

/** The policy main injects (`STORE_POLICY`), typed as the store reads it. */
export const TEST_STORE_POLICY: StorePolicy = STORE_POLICY;

/** Open a store at `path` (default `:memory:`) with the injected policy; the caller closes it. */
export const openTestStore = (path = ':memory:', opts: KnowledgeStoreOptions = {}): KnowledgeStore =>
  new KnowledgeStore(path, { ...opts, policy: TEST_STORE_POLICY });

/** Open a fresh `:memory:` store, run `fn`, and close the store afterwards. */
export async function withStore<T>(
  fn: (store: KnowledgeStore) => Promise<T> | T,
  opts?: KnowledgeStoreOptions,
): Promise<T> {
  const store = openTestStore(':memory:', opts);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/** A `:memory:` store for suites that manage the lifecycle themselves (close it in `afterEach`). */
export const memoryStore = (opts?: KnowledgeStoreOptions): KnowledgeStore => openTestStore(':memory:', opts);
