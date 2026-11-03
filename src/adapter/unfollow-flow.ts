/**
 * The confirm layers of one follow or unfollow (ADR 0308, spec §11.1 F2–F5): after the header press, each
 * layer is located, paused on and pressed until Instagram answers; an exit that did not land is closed.
 */

import { verdictToResult } from '@/adapter/action-result';
import type { LocatedRect, LocateRectResult } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import type { MutationWatch } from '@/adapter/mutation-watch';
import type { ConfirmLocate, LayerReport, ProbeStateResult } from '@/adapter/page';
import { pageCall } from '@/adapter/page-call';
import { type SettleInteractor, settleAndPress } from '@/adapter/settle-press';
import type { Verdict } from '@/adapter/verdict';
import type { TempoSource } from '@/kernel/tempo';
import { surface } from '@/surface/index';
import { NO_SINK, type SurfaceSink } from '@/surface/sink';
import { type SleepFn, sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import type { Result } from '@/utils/result';
import type { AdapterTab } from './actor-types';
import { type CaptureReason, type ConfirmCapture, logCapture, scrubbedCapture } from './confirm-capture';
import { ActionAbortedError, ActionBlockedError, ActionRateLimitedError, AdapterStaleError } from './errors';

const CONFIRM = 'unfollow-confirm';
const CANCEL = 'unfollow-dialog-cancel';
const CLOSE = 'drawer-close';

/** What the confirm flow adds to the Actor's options. */
export interface ConfirmFlowOptions {
  /** The step pause's sleep (default: the real one). */
  readonly sleep?: SleepFn;
  /** Where an unrecognized confirm layer is reported (default: nowhere, until the production sink is wired). */
  readonly sink?: SurfaceSink;
  /** Where layer captures go (default: the durable runtime log, each layer once). */
  readonly capture?: ConfirmCapture;
}

/** The flow options with their defaults filled in. */
export const confirmDefaults = (o: ConfirmFlowOptions): Required<ConfirmFlowOptions> =>
  ({ sleep: o.sleep ?? sleep, sink: o.sink ?? NO_SINK, capture: o.capture ?? logCapture() });

/** One action's flow: what the layer loop drives and reads. */
export interface LayerFlow extends Required<ConfirmFlowOptions> {
  readonly op: 'actor.follow' | 'actor.unfollow';
  readonly username: string;
  readonly tab: AdapterTab;
  readonly interactor: SettleInteractor;
  readonly watch: MutationWatch;
  /** The action's dispatch closure: admitted once, so a later layer re-runs only its check (F1). */
  readonly dispatch: () => Promise<void>;
  /** Header states that prove the action landed (an inline or optimistic flip). */
  readonly settled: (state: ProbeStateResult['state']) => boolean;
  readonly tempo: TempoSource;
  readonly signal: () => AbortSignal | undefined;
  readonly usable: (rect: LocatedRect | undefined) => rect is LocatedRect;
  /** The Actor's D4 poll: `run` until `done`, the control deadline, or a stop. */
  readonly waitFor: <T>(run: () => Promise<T>, done: (value: T) => boolean) => Promise<T | null>;
  /** Confirm layers this action may press: the surface's layers for an unfollow, none for a follow. */
  readonly maxLayers: number;
}

/** What the loop left behind: the signature of the last layer it pressed. */
export interface LayerRun {
  readonly lastSig: string | null;
}

type Step =
  | { readonly kind: 'pending' }
  | { readonly kind: 'evidence' }
  | { readonly kind: 'confirm'; readonly located: ConfirmLocate };

/** The active surface document's descriptor for a control: the data the version façade's scripts read. */
function descriptor(id: string): Record<string, unknown> {
  const d = surface().controls[id];
  if (d === undefined) throw new Error(`surface: the document declares no ${id} control`);
  return d;
}

const confirmScript = (later: boolean): string =>
  pageCall('locate', { control: CONFIRM, ...descriptor(CONFIRM), dialogsOnly: later });
const layerScript = (withMarkup: boolean): string =>
  pageCall('confirmLayer', { control: CONFIRM, ...descriptor(CONFIRM), withMarkup });
const cancelScript = (): string => pageCall('locate', { control: CANCEL, ...descriptor(CANCEL) });
/** The menu's Close X: the drawer's descriptor, searched in the confirm layers' scopes only. */
const closeScript = (): string =>
  pageCall('locate', { control: CLOSE, ...descriptor(CLOSE), scopes: descriptor(CONFIRM).scopes });

/** A located layer's signature; one the page cannot tell apart reads as the same layer, never as a new one. */
const sigOf = (located: ConfirmLocate | null): string => located?.sig ?? '';

/** The confirm layers an unfollow can show (the surface's `layers`); their count bounds the flow. */
export function confirmLayerBound(): number {
  const layers = descriptor(CONFIRM).layers;
  if (!Array.isArray(layers)) throw new Error(`surface: the ${CONFIRM} control declares no layers`);
  return layers.length;
}

/** F2: locate, pause on and press each confirm layer until evidence, a quiet page, or the surface's bound. */
export async function pressConfirmLayers(f: LayerFlow): Promise<LayerRun> {
  let lastSig: string | null = null;
  for (let layer = 0; layer < f.maxLayers; layer++) {
    const later = layer > 0;
    const step = await f.waitFor(() => probe(f, lastSig, later), (s) => s.kind !== 'pending');
    if (step === null || step.kind !== 'confirm') break;
    if (later) await captureLater(f, step.located);
    const pressed = await pressLayer(f, step.located, later);
    if (pressed !== null) lastSig = sigOf(pressed);
  }
  return { lastSig };
}

/** A layer met after the first is captured once (the next private unfollow is also the capture, §22 L5). */
async function captureLater(f: LayerFlow, located: ConfirmLocate): Promise<void> {
  if (!f.capture.wants(sigOf(located))) return;
  try {
    const top = await report(f, true);
    if (top?.present === true) keep(f, 'later-layer', top);
  } catch (e) {
    logger.warn(`${f.op}: the confirm layer capture failed`, { username: f.username, error: String(e) });
  }
}

/** Save one capture of the top layer: scrubbed markup and the watch's unmatched POSTs. */
function keep(f: LayerFlow, reason: CaptureReason, top: LayerReport): void {
  const sig = top.sig ?? '';
  if (!f.capture.wants(sig) || top.markup === undefined) return;
  f.capture.save(sig, scrubbedCapture({ reason, op: f.op, username: f.username, layer: top.layer, controls: top.controls,
    structural: top.structural, markup: top.markup, unmatchedPosts: f.watch.unmatchedPosts() }));
}

/** One poll: the mutation's answer, a new pressable layer, or the header's flip. */
async function probe(f: LayerFlow, lastSig: string | null, later: boolean): Promise<Step> {
  if (f.watch.peek() !== null) return { kind: 'evidence' };
  const located = await f.tab.evaluate<ConfirmLocate | null>(confirmScript(later));
  if (located?.found && sigOf(located) !== lastSig && f.usable(located.rect)) return { kind: 'confirm', located };
  const header = await f.tab.evaluate<ProbeStateResult | null>(SURFACE.probeStateScript());
  return header?.found && f.settled(header.state) ? { kind: 'evidence' } : { kind: 'pending' };
}

/** A reading pause on the located layer (`ui.step-pause`), then a settled press of that same layer only. */
async function pressLayer(f: LayerFlow, located: ConfirmLocate, later: boolean): Promise<ConfirmLocate | null> {
  // A persistent self-recovery hit is early drift in the primary anchors, caught while the press still works.
  if (located.fallback) logger.warn(`${f.op}: the confirm's role-marked search missed; found by its text instead`);
  if (f.tempo.enabled('ui.step-pause')) await f.sleep(f.tempo.draw('ui.step-pause'), f.signal());
  if (f.signal()?.aborted) throw new ActionAbortedError(f.op);
  const relocate = async (): Promise<ConfirmLocate> => {
    const settled = await f.tab.evaluate<ConfirmLocate | null>(confirmScript(later));
    return settled?.found && sigOf(settled) === sigOf(located) ? settled : { found: false };
  };
  const pressing: SettleInteractor = {
    hover: (rect, aim) => f.interactor.hover(rect, aim),
    click: async (rect, aim) => {
      await f.dispatch();
      await f.interactor.click(rect, aim);
      f.watch.markPress();
    },
  };
  return settleAndPress(pressing, located, relocate, f.usable);
}

/** F4: an unobserved mutation window counts toward blindness only when no confirm layer is on screen. */
export async function noteUnobserved(f: LayerFlow): Promise<void> {
  const top = await report(f, false);
  if (top?.present !== true) {
    f.watch.warnUnobserved(f.username);
    return;
  }
  logger.warn(`${f.op}: no mutation response while a confirm layer is on screen; the page stalled, not the mutation table`,
    { username: f.username, layer: top.layer ?? null, postsSeen: f.watch.unmatchedPosts() });
}

/** The top confirm layer on screen, with its markup on request. */
const report = (f: LayerFlow, withMarkup: boolean): Promise<LayerReport | null> =>
  f.tab.evaluate<LayerReport | null>(layerScript(withMarkup));

/**
 * F7: after a dispatched press, `err` means Instagram showed nothing (unverified). A response it did send
 * — a refusal, an `errors[]` body, an answer the DOM contradicts — is evidence and throws as a refusal.
 */
export function settledResult(verdict: Verdict, op: string, username: string): Result<{ clicked: boolean }> {
  const result = verdictToResult(verdict, op, username);
  if (!result.ok && verdict.kind === 'refused' && verdict.evidence.source !== 'dom') {
    throw new ActionBlockedError(op, verdict.detail);
  }
  return result;
}

/** An exit after which a layer may still need closing: Instagram's own refusal, or a drifted control. */
const leavesOnError = (e: unknown): boolean =>
  e instanceof ActionBlockedError || e instanceof ActionRateLimitedError || e instanceof AdapterStaleError;

/**
 * The layers, then the one arbitration; an exit that did not land leaves the tab clean (F5). A stop,
 * a stalled tab or a check that failed mid-layers presses nothing more.
 */
export async function runFlow(f: LayerFlow, decide: () => Promise<Result<{ clicked: boolean }>>):
  Promise<Result<{ clicked: boolean }>> {
  const run = await pressConfirmLayers(f);
  let result: Result<{ clicked: boolean }>;
  try {
    result = await decide();
  } catch (e) {
    if (leavesOnError(e)) await leaveLayers(f, run, 'refusal');
    throw e;
  }
  if (!result.ok) await leaveLayers(f, run, 'nothing');
  return result;
}

/**
 * F5: close a layer left on screen — the dialog's Cancel, else the menu's Close X. When Instagram showed
 * nothing and the layer is neither one already pressed nor one carrying the confirm, it is unrecognized.
 */
async function leaveLayers(f: LayerFlow, run: LayerRun, shown: 'nothing' | 'refusal'): Promise<void> {
  try {
    if (f.signal()?.aborted) return;
    const top = await report(f, true);
    if (top?.present !== true) return;
    const unrecognized = shown === 'nothing' && top.sig !== run.lastSig && (f.maxLayers === 0 || top.matches !== true);
    if (unrecognized) noteUnrecognized(f, top);
    keep(f, unrecognized ? 'unrecognized' : 'left-visible', top);
    await closeLayer(f, top);
  } catch (e) {
    logger.warn(`${f.op}: leaving the confirm layer failed`, { username: f.username, error: String(e) });
  }
}

/** Never pressed: the drift signature and the log say what was there instead (spec §11.1 F3). */
function noteUnrecognized(f: LayerFlow, top: LayerReport): void {
  logger.warn(`${f.op}: a confirmation step looked different; Epo cancelled instead of guessing`,
    { username: f.username, layer: top.layer ?? null, controls: top.controls ?? null });
  f.sink.drift({ endpoint: 'mutation', cls: 'confirm-unrecognized', path: `controls.${CONFIRM}`,
    detail: { op: f.op, layer: top.layer ?? null, controls: top.controls ?? null } }, Date.now());
}

/** Press the layer's Cancel, else its Close X, until it is gone; a layer that stays is a warn, never silent. */
async function closeLayer(f: LayerFlow, top: LayerReport): Promise<void> {
  for (const script of [cancelScript(), closeScript()]) {
    if (f.signal()?.aborted) return;
    const locate = (): Promise<LocateRectResult | null> => f.tab.evaluate<LocateRectResult | null>(script);
    if ((await settleAndPress(f.interactor, await locate(), locate, f.usable)) === null) continue;
    const gone = await f.waitFor(() => report(f, false), (r) => r?.present !== true || r.sig !== top.sig);
    if (gone !== null) return;
  }
  logger.warn(`${f.op}: a confirm layer stayed on screen; neither its Cancel nor its Close X closed it`,
    { username: f.username, layer: top.layer ?? null });
}
