/**
 * Display vocabulary shared by every surface that names an engine concept.
 * One map per concept: two cards showing two different words for one sentinel
 * is a bug the type system cannot catch.
 */
import type { EpoStatus } from '@/types';

/** The sentinel vocabulary as the status projection carries it. */
type Sentinel = NonNullable<EpoStatus['lastSentinel']>;

/** Short sentinel readout — "sentinel ok", "sentinel blocked". */
export function sentinelLabel(s: Sentinel): string {
  switch (s) {
    case 'ok':
      return 'ok';
    case 'action-blocked':
      return 'blocked';
    case 'challenge':
      return 'challenge';
    default:
      return 'logged out';
  }
}
