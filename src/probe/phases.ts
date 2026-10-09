/**
 * Probe phases that run INSTEAD of the health reads (each module's header says
 * exactly what it asks Instagram for). `probe-main.ts` dispatches here before
 * `health`.
 */

import type { InstagramTab } from '@/adapter/tab';
import { traffic } from '@/probe/traffic';
import { verifyProbe } from '@/probe/verify';

export const SOLO_PHASES: Record<string, (tab: InstagramTab, out: string) => Promise<void>> = {
  /**
   * Passive: browse like a person and record every API exchange Instagram's
   * OWN client makes (endpoints, headers, GraphQL operations, body shapes).
   * Composes no request — the first move when an endpoint dies.
   */
  traffic,
  /** Read-only end-to-end check of the production read + drawer paths. */
  verify: verifyProbe,
};
