/**
 * The engine kit's reopen-side fakes: the frontier sweep the follow-back rule runs.
 * Re-exported by `engine-harness.ts`, so suites import from either.
 */

import type { EngineFollowback } from '@/engine/engine';

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
