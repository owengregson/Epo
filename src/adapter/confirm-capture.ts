/**
 * The passive confirm-layer capture (ADR 0308, spec §11.1): a layer met after the first, one left on
 * screen, or an unrecognized one is kept as scrubbed markup with the watch's unmatched POSTs, locally.
 */

import type { UnmatchedPost } from '@/adapter/mutation-watch';
import { Scrubber } from '@/surface/lab/scrub';
import * as logger from '@/utils/logger';

/** Why a layer was captured. */
export type CaptureReason = 'later-layer' | 'left-visible' | 'unrecognized';

/** One capture: what the layer was and what the tab had sent, every handle, pk and image URL scrubbed. */
export interface ConfirmCaptureRecord {
  readonly reason: CaptureReason;
  readonly op: 'actor.follow' | 'actor.unfollow';
  readonly layer: 'menu' | 'dialog' | null;
  readonly controls: number | null;
  /** The one control a two-button layer offered beside its companion (never pressed). */
  readonly structural: string | null;
  readonly markup: string;
  readonly unmatchedPosts: readonly UnmatchedPost[];
}

/** Where captures go; each distinct layer (by signature) is kept once. */
export interface ConfirmCapture {
  wants(sig: string): boolean;
  save(sig: string, record: ConfirmCaptureRecord): void;
}

/** Nothing is kept: a harness or a test that asks for no captures. */
export const NO_CAPTURE: ConfirmCapture = { wants: () => false, save: () => {} };

/**
 * The default: one line per distinct layer in the durable runtime log — the local diagnostics area,
 * never committed, never uploaded. Nothing is written below the info level (tests run at error).
 */
export function logCapture(): ConfirmCapture {
  const kept = new Set<string>();
  return {
    wants: (sig) => !kept.has(sig),
    save: (sig, record) => {
      kept.add(sig);
      logger.info('actor: confirm layer captured', record);
    },
  };
}

/** The raw layer as the page reported it, before the scrub. */
export interface RawLayer {
  readonly reason: CaptureReason;
  readonly op: 'actor.follow' | 'actor.unfollow';
  readonly username: string;
  readonly layer?: 'menu' | 'dialog';
  readonly controls?: number;
  readonly structural?: string | null;
  readonly markup: string;
  readonly unmatchedPosts: readonly UnmatchedPost[];
}

/** Through the fixture scrubber's DOM pass, with the action's own handle seeded so every mention of it goes. */
export function scrubbedCapture(raw: RawLayer): ConfirmCaptureRecord {
  const scrubber = new Scrubber();
  scrubber.handle(raw.username);
  const markup = scrubber.dom(raw.markup);
  return {
    reason: raw.reason,
    op: raw.op,
    layer: raw.layer ?? null,
    controls: raw.controls ?? null,
    structural: raw.structural ? scrubber.dom(raw.structural) : null,
    markup,
    unmatchedPosts: raw.unmatchedPosts.map((p) => ({ ...p, path: scrubber.dom(p.path) })),
  };
}
