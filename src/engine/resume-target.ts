/**
 * Which chain target a (re)start resumes: a pure pick over the store and the
 * source frontier. The caller adopts the pick and performs any store write.
 */

import type { KnowledgeStore } from '../store/knowledge-store';
import type { Target } from '../store/types';
import type { SourceFrontier } from './source-frontier';

/** The target to resume, and what the store must do first when the frontier chose it. */
export interface ResumeTarget {
  pk: string;
  /** Set when the frontier picked the source: add it (`existing` null) or reactivate it. */
  ready?: { source: Target['source']; existing: Target | null };
}

/**
 * Pick the store's active target with the highest chainIndex (the front of the
 * chain), or the frontier's resume/next source when one is wired. Free — no IG
 * traffic, no writes. Null when there is nothing to resume.
 */
export function peekResumeTarget(d: {
  store: Pick<KnowledgeStore, 'getTarget' | 'listTargets'>;
  frontier?: Pick<SourceFrontier, 'snapshot' | 'next'>;
}): ResumeTarget | null {
  const resume = d.frontier?.snapshot().currentTargetPk;
  if (resume && d.store.getTarget(resume)) return { pk: resume };
  if (d.frontier !== undefined) {
    const ready = d.frontier.next();
    if (ready === null) return null;
    return { pk: ready.pk, ready: { source: ready.source, existing: d.store.getTarget(ready.pk) } };
  }
  const active = d.store.listTargets().filter((t) => t.status === 'active');
  if (active.length === 0) return null;
  const front = active.reduce((best, t) => {
    const bi = best.chainIndex ?? -1;
    const ti = t.chainIndex ?? -1;
    if (ti !== bi) return ti > bi ? t : best;
    return t.accountPk < best.accountPk ? t : best; // deterministic tie-break
  });
  return { pk: front.accountPk };
}
