/**
 * The engine kit's reopen-side fakes: the follow-back watcher.
 * Re-exported by `engine-harness.ts`, so suites import from either.
 */

import type { EngineFollowback } from '@/engine/engine';

export class FakeFollowback implements EngineFollowback {
  checks = 0;
  async check(): Promise<{ detected: string[] }> {
    this.checks += 1;
    return { detected: [] };
  }
}
