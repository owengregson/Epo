/**
 * The launch catch-up (spec §9.6, ADR 0213): startup step 3, after the reveal, under the startup lease. It
 * admits on the launch's state — passive reads go on under an operational block (ADR 0210 amended) — and
 * runs the frontier sweep in launch mode: the header, one drawer pass with no panel, the followers head.
 */

import { isRateLimitHaltKey } from '@/engine/halt-reason';
import type { StartupStep } from '@/shared/boot';
import type { CatchUpSkip } from '@/shared/reopen-view';
import * as logger from '@/utils/logger';

export type BlockKind = 'identity' | 'rate' | 'operational' | 'unknown';
export type CatchUpAdmission = { readonly run: true } | { readonly run: false; readonly why: CatchUpSkip };

/** What the admission reads at the step (spec Appendix E): gathered by the wiring, judged here. */
export interface CatchUpState {
  readonly identity: 'confirmed' | 'missing' | 'changed';
  readonly online: boolean;
  /** The sentinel's reading of the tab: `ok` or the wall it sees. */
  readonly sentinel: string;
  readonly recovery: 'idle' | 'holding' | 'probing';
  /** The persisted runtime block, if any. */
  readonly block: string | null;
}

/** The launch's state as the composition root offers it (absent: no catch-up step). */
export interface CatchUpLaunch {
  /** The signed-in account from the session cookie (no navigation). */
  signedInPk(): Promise<string | null>;
  online(): boolean;
  block(): string | null;
  /** The tab is free for startup work: no tour, no other driver. */
  tabFree(): boolean;
  /** Drive the tab under the catch-up's activity hold (the veil is up for every tab-driving routine). */
  hold<T>(run: () => Promise<T>): Promise<T>;
  /** BL's landing on our own profile, for a launch whose landing did not run behind the splash. */
  land(signal: AbortSignal): Promise<void>;
}

/** Blocks that are not account activity, so passive reads go on: an exhausted chain, an unresolved seed. */
const OPERATIONAL: ReadonlySet<string> = new Set(['chain-exhausted', 'seed-unresolved']);

/** Blocks about who is signed in, and the skip each reads as. */
const IDENTITY: Readonly<Record<string, CatchUpSkip>> = {
  'login-required': 'signed-out', 'sentinel:logged-out': 'signed-out', 'account-changed': 'account-changed',
  'identity-changed': 'account-changed', 'account-identity-unavailable': 'account-changed', 'sentinel:challenge': 'blocked',
};

/** A persisted block's kind (spec Appendix E): operational is the allow-list; rate is the halt vocabulary's own set. */
export function blockKind(reason: string): BlockKind {
  if (OPERATIONAL.has(reason)) return 'operational';
  if (Object.hasOwn(IDENTITY, reason)) return 'identity';
  return isRateLimitHaltKey(reason) ? 'rate' : 'unknown';
}

/** Whether the launch catch-up runs: identity confirmed, online, the tab clear, the ladder not holding, no blocking block. */
export function catchUpAdmission(s: CatchUpState): CatchUpAdmission {
  const skip = (why: CatchUpSkip): CatchUpAdmission => ({ run: false, why });
  if (s.identity !== 'confirmed') return skip(s.identity === 'missing' ? 'signed-out' : 'account-changed');
  if (!s.online) return skip('offline');
  if (s.sentinel !== 'ok') return skip(s.sentinel === 'logged-out' ? 'signed-out' : s.sentinel === 'action-blocked' ? 'wall' : 'blocked');
  if (s.recovery === 'holding') return skip('holding');
  if (s.block === null) return { run: true };
  const kind = blockKind(s.block);
  if (kind === 'operational') return { run: true };
  return skip(kind === 'identity' ? IDENTITY[s.block] : kind === 'rate' ? 'wall' : 'blocked');
}

/** The sweep as the step drives it. */
export interface CatchUpSweep {
  run(mode: 'launch', signal: AbortSignal): Promise<unknown>;
  skip(why: CatchUpSkip): void;
}

/** Startup step 3: admit at the step, then one launch sweep, under one activity hold; a refusal reads nothing. */
export function catchUpStep(sweep: CatchUpSweep, admit: (signal: AbortSignal) => Promise<CatchUpAdmission>,
  tab: Pick<CatchUpLaunch, 'tabFree' | 'hold'>): StartupStep {
  return {
    name: 'catch-up',
    when: () => tab.tabFree(),
    run: (signal) => tab.hold(async () => {
      const admitted = await admit(signal);
      if (signal.aborted) return;
      if (!admitted.run) {
        logger.info('catch-up: skipped', { why: admitted.why });
        sweep.skip(admitted.why);
        return;
      }
      await sweep.run('launch', signal);
    }),
  };
}
