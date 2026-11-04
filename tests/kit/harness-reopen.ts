/**
 * The engine kit's reopen-side fakes: the frontier sweep the follow-back rule runs.
 * Re-exported by `engine-harness.ts`, so suites import from either.
 */

import type { Observation } from '@/adapter/surface-types';
import type { EngineFollowback } from '@/engine/engine';
import type { WalkArgs, WalkResult } from '@/rim/list-walk-types';

/** A list walker over scripted pages (our followers head or following list): the hooks, the real stop reasons. */
export function scriptedListWalker(pages: () => readonly (readonly string[])[], at: () => number) {
  const calls: WalkArgs[] = [];
  return {
    calls,
    walkAll: async (args: WalkArgs): Promise<WalkResult> => {
      calls.push(args);
      const list = pages();
      const pks: string[] = [];
      let n = 0;
      let reason = 'max-pages';
      for (; n < Math.min(args.maxPages ?? list.length, list.length); n++) {
        const page = list[n].map((pk): Observation => ({ accountPk: pk, observedAt: at(), source: 'followers-list',
          fields: { username: `u${pk}` } }));
        for (const obs of page) { pks.push(obs.accountPk); args.onObservation(obs, null); }
        if (args.stopAfterPage?.(page) === true) { reason = 'caller-stop'; n += 1; break; }
        if (n === list.length - 1) { reason = 'no-more-pages'; n += 1; break; }
      }
      if (list.length === 0) reason = 'no-more-pages';
      const complete = reason === 'no-more-pages';
      return { pks, pages: n, complete, endConfirmed: complete, quarantined: 0, reason, cursor: null };
    },
  };
}

export class FakeFollowback implements EngineFollowback {
  /** How many sweeps ran, and in which modes. */
  checks = 0;
  modes: Array<'session' | 'check'> = [];
  /** A scripted sweep body (a failing step, a slow read); it resolves like every sweep. */
  onRun?: (mode: 'session' | 'check', signal: AbortSignal) => Promise<void>;
  async run(mode: 'session' | 'check', signal: AbortSignal): Promise<{ mode: 'session' | 'check' }> {
    this.checks += 1;
    this.modes.push(mode);
    await this.onRun?.(mode, signal);
    return { mode };
  }
}
