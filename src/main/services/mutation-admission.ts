/**
 * The mutation admission (spec §5.13 S2): the dispatch closure of every write arms the plan's
 * deadline through the cadence (re-checked, drawn and persisted once per action), and request
 * acceptance runs in passes, each inside the plan's accept budget, with one deadline per pass.
 */

import { ActionAbortedError } from '@/adapter/errors';
import type { Clock } from '@/governors/clock';
import type { MutationKind, Writer } from '@/kernel/plan';
import type { Settings } from '@/settings/settings';
import type { MutationCadence, MutationSubject } from './mutation-cadence';

/** The write the click review just admitted: what the dispatch closure arms. */
export interface ReviewedAction {
  readonly kind: MutationKind;
  readonly writer: Writer;
  readonly subject?: MutationSubject;
}

/** A dispatch with no review before it (no subject to verify) is held to the manual headroom. */
const UNREVIEWED: ReviewedAction = { kind: 'follow', writer: 'manual' };

export interface MutationAdmissionDeps {
  clock: Clock;
  cadence: MutationCadence;
  settings(): Settings;
  onProgress?(phase: string): void;
  /** The identity and run-token check every write repeats. */
  active(): Promise<boolean>;
  /** The action the review admitted last, taken by its dispatch. */
  takeReviewed(): ReviewedAction | null;
}

/** The admission half of the mutation policy (see `mutation-policy.ts`). */
export function createMutationAdmission(d: MutationAdmissionDeps) {
  const { clock, cadence, active } = d;
  return {
    beforeMutation: async (): Promise<void> => {
      if (!await active()) throw new ActionAbortedError('mutation-admission');
      const r = d.takeReviewed() ?? UNREVIEWED;
      cadence.armAtDispatch(r.kind, r.writer, clock.now(), r.subject);
    },
    canAccept: async (): Promise<boolean> => !d.settings().dryRun && await active() && cadence.acceptAllowed(clock.now()),
    onAccepted: (): void => {
      cadence.acceptPassEnded(clock.now());
      d.onProgress?.('request-accepted');
    },
  };
}
