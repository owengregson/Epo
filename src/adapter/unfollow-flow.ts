/**
 * The confirm layers of one follow or unfollow (ADR 0308, spec §11.1 F2/F4): after the header press,
 * each layer is located, paused on and pressed until Instagram answers or the surface's layers run out.
 */

import type { LocatedRect } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import type { MutationWatch } from '@/adapter/mutation-watch';
import type { ConfirmLocate, LayerReport, ProbeStateResult } from '@/adapter/page';
import { pageCall } from '@/adapter/page-call';
import { type SettleInteractor, settleAndPress } from '@/adapter/settle-press';
import type { TempoSource } from '@/kernel/tempo';
import { surface } from '@/surface/index';
import type { SleepFn } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import type { AdapterTab } from './actor-types';
import { ActionAbortedError } from './errors';

const CONFIRM = 'unfollow-confirm';

/** What the confirm flow adds to the Actor's options. */
export interface ConfirmFlowOptions {
  /** The step pause's sleep (default: the real one). */
  readonly sleep?: SleepFn;
}

/** One action's flow: what the layer loop drives and reads. */
export interface LayerFlow {
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
  readonly sleep: SleepFn;
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
    const pressed = await pressLayer(f, step.located, later);
    if (pressed !== null) lastSig = sigOf(pressed);
  }
  return { lastSig };
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
  const top = await f.tab.evaluate<LayerReport | null>(layerScript(false));
  if (top?.present !== true) {
    f.watch.warnUnobserved(f.username);
    return;
  }
  logger.warn(`${f.op}: no mutation response while a confirm layer is on screen; the page stalled, not the mutation table`,
    { username: f.username, layer: top.layer ?? null, postsSeen: f.watch.unmatchedPosts() });
}
