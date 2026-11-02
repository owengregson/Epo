import type { Rule } from './rules';

/** Knowledge recovery has its own read phase before admitting the daily action plan. */
export const reconcileRule: Rule<'clock' | 'cadence'> = {
  id: 'reconcile',
  modes: ['growth'],
  needs: ['clock', 'cadence'],
  decide: (f) => f.cadence.reconcile
    ? { do: 'run', effect: { id: 'sweep-followback', now: f.clock.now } }
    : null,
};

export const rotateRule: Rule<'target' | 'queue' | 'action'> = {
  id: 'rotate',
  modes: ['growth'],
  needs: ['target', 'queue', 'action'],
  decide: (f) => f.queue.rotationReason && f.target.current !== null
    && f.action.due?.state !== 'unfollow_queued'
    ? { do: 'run', effect: { id: 'advance-chain', target: f.target.current } }
    : null,
};

/**
 * Adopting an existing active target is free (the fact source did it);
 * bootstrapping the seed costs the step — it IS an acquisition.
 */
export const targetRule: Rule<'target' | 'action'> = {
  id: 'target',
  modes: ['growth'],
  needs: ['target', 'action'],
  decide: (f) =>
    f.target.current === null && f.action.due === null && f.action.pruneCandidate === null
      ? { do: 'run', effect: { id: 'bootstrap-seed-target' } } : null,
};

