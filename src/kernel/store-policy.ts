import { MS_PER_DAY } from './units';

/**
 * Bounds the knowledge store applies by itself: retention at open and the span
 * ring. Tier 1 (guardrails, no Instagram-facing timing); main injects this
 * object through `KnowledgeStore` options, so the store never imports the kernel.
 */
export const STORE_POLICY = {
  /** Guards: observations, username history and settled intent detail stay bounded; every reader looks back less. */
  retentionMs: 90 * MS_PER_DAY,
  /** Guards: persisted diagnostic spans have independent row, event, trim and read bounds. */
  spans: {
    /** Guards: the span ring holds weeks of runs and never needs a sweep job. */
    ringRows: 50_000,
    /** Guards: one looping span cannot grow its row; older inline events drop with a count. */
    inlineEvents: 32,
    /** Guards: the indexed ring trim runs once per this many opens, not on every one. */
    trimEvery: 512,
    /** Guards: a span listing with no explicit limit stays a bounded read. */
    listLimit: 100,
  },
} as const;
