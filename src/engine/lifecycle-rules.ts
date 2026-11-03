import type { Rule } from './rules';

/**
 * One due journal intent settles per step (spec §9.8): after the safety prefix and pacing, so a
 * settlement read happens only inside a session, and before the session's other work.
 */
export const journalRule: Rule<'clock' | 'cadence'> = {
  id: 'journal',
  modes: ['growth'],
  needs: ['clock', 'cadence'],
  decide: (f) => f.cadence.journalDue
    ? { do: 'run', effect: { id: 'settle-journal', now: f.clock.now } }
    : null,
};

/** The follow-back sweep on its slow, persisted cadence (IG traffic → paced). */
export const followbackRule: Rule<'clock' | 'cadence'> = {
  id: 'followback',
  modes: ['growth'],
  needs: ['clock', 'cadence'],
  decide: (f) =>
    f.cadence.sweepDue
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
