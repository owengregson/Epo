/**
 * The prune mode's rules — DECLARED here, not yet driven.
 *
 * Prune is a MODE over the conductor's safety prefix, not a second engine
 * (ADR 0902). Wave B merges `prune-engine.ts`'s run loop onto these, at which
 * point pause/resume/stop/halt/streak/status-throttling stop existing twice and
 * ~600 lines delete. The per-candidate correctness rules already moved out
 * (`prune-candidate.ts`) and are shared by both paths TODAY, so the merge
 * cannot silently lose them.
 */

import type { Facts } from './facts';
import { decidePruneCandidate } from './prune-candidate';
import type { Rule } from './rules';

// Type-only import from `rules.ts`: `PROGRAM` pulls this module in, so a VALUE
// import would close a module cycle. Each rule is therefore annotated `Rule`
// with a narrowed `decide` parameter, which is exactly what `defineRule` does.

/** All unfollows look alike to Instagram: the durable daily cap closes the mode. */
const pruneCapRule: Rule = {
  id: 'prune-cap',
  modes: ['prune-run'],
  needs: ['prune'],
  decide: (f: Pick<Facts, 'prune'>) => (f.prune.atDailyCap ? { do: 'yield' } : null),
};

/**
 * The per-candidate decision, unchanged from both of today's copies — see
 * `prune-candidate.ts` for the three rules it enforces. A skip is a `yield`:
 * the executor consumes the row (whitelisted rows without spending an
 * actionable slot) and the next tick takes the following candidate.
 */
const pruneCandidateRule: Rule = {
  id: 'prune-candidate',
  modes: ['prune-run'],
  needs: ['clock', 'prune'],
  decide: (f: Pick<Facts, 'clock' | 'prune'>) => {
    const candidate = f.prune.candidate;
    if (candidate === null) return { do: 'yield' };
    const verdict = decidePruneCandidate({
      candidate,
      whitelist: f.prune.whitelist,
      followsUsNow: f.prune.followsUsNow,
    });
    return verdict.do === 'skip'
      ? { do: 'yield' }
      : {
          do: 'run',
          effect: {
            id: 'woven-unfollow',
            now: f.clock.now,
            candidate: { pk: verdict.pk, username: verdict.username },
          },
        };
  },
};

/** The `prune-run` mode's own rules, in order. */
export const PRUNE_RULES: readonly Rule[] = [pruneCapRule, pruneCandidateRule];
