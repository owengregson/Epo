/**
 * The confirm layers of an unfollow (ADR 0308): dialog scopes newest first, `document` last unless a
 * later layer drops it, and only a control a press at its centre reaches. A text miss reports nothing
 * to press; `confirmLayer` describes the top layer for the flow's exits and the passive capture.
 */

import { clickableOf, type LocateRect, mk, norm, onTop, type RegexLit, rectOf, scopesOf, visible } from './dom';

export interface ConfirmCfg {
  /** The confirm text matcher (prefix match — menu rows can carry a suffix). */
  rx: RegexLit;
  /** The dialog scopes a confirm layer renders in. */
  scopes: readonly string[];
  /** Role-marked controls (the primary pass). */
  roleSel: string;
  /** Bare containers the self-recovery pass scans. */
  deepSel: string;
  /** Press-shaped ancestors preferred for a recovery hit. */
  clickableSel: string;
  /** A recovery candidate may hold at most this many element children… */
  maxChildren: number;
  /** …and at most this much text (a whole panel is not a menu row). */
  maxTextLen: number;
  /** The control a confirm dialog carries beside its confirm (its Cancel); a menu sheet has none. */
  companionRx?: RegexLit;
  /** Search the dialog scopes only: the page behind a later layer is never one. */
  dialogsOnly?: boolean;
}

/** A located confirm control and the layer it sits in. */
export interface ConfirmLocate extends LocateRect {
  /** `dialog` when its layer also offers the companion control, else `menu`. */
  layer?: 'menu' | 'dialog';
  /** The layer's signature: its index from the newest, its role-marked controls, its text. */
  sig?: string;
}

/** The layer report's config: the confirm descriptor, plus whether to return the markup. */
export interface LayerCfg extends ConfirmCfg {
  withMarkup?: boolean;
}

/** The top confirm layer on screen, for the flow's exits and the passive capture. */
export interface LayerReport {
  present: boolean;
  sig?: string;
  layer?: 'menu' | 'dialog';
  /** Role-marked controls in the layer. */
  controls?: number;
  /** Whether the confirm text appears in the layer at all: a stall, not an unknown layer. */
  matches?: boolean;
  /** The one control a two-button layer offers beside its companion: reported, never pressed. */
  structural?: string | null;
  markup?: string;
}

interface Hit {
  clickable: Element;
  fallback: boolean;
}

/** Dialog scopes, newest first: portals append, so the last in document order is on top. */
function newestFirst(cfg: ConfirmCfg): Element[] {
  return [...new Set(scopesOf(cfg.scopes))].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1);
}

function find(cfg: ConfirmCfg, layers: readonly Element[]): Hit | null {
  const rx = mk(cfg.rx);
  const scopes: ParentNode[] = cfg.dialogsOnly ? [...layers] : [...layers, document];

  for (const scope of scopes) {
    for (const n of Array.from(scope.querySelectorAll(cfg.roleSel))) {
      if (rx.test(norm(n.textContent)) && visible(n) && onTop(n)) return { clickable: n, fallback: false };
    }
  }

  for (const scope of scopes) {
    let best: Element | null = null;
    for (const el of Array.from(scope.querySelectorAll(cfg.deepSel))) {
      if (el.children.length > cfg.maxChildren) continue;
      const t = norm(el.textContent);
      if (!t || t.length > cfg.maxTextLen || !rx.test(t)) continue;
      if (!visible(el)) continue;
      // Keep descending: a later candidate the current best CONTAINS is deeper.
      if (best === null || best.contains(el)) best = el;
    }
    if (best === null) continue;
    const near = clickableOf(best, cfg.clickableSel);
    const clickable = near !== best && visible(near) ? near : best;
    if (onTop(clickable)) return { clickable, fallback: true };
  }
  return null;
}

/** A layer's signature: its index from the newest, its role-marked controls, its normalized text. */
function sigOf(layer: Element | null, layers: readonly Element[], cfg: ConfirmCfg, text: string): string {
  if (layer === null) return ['-1', '0', text].join(':');
  return [layers.indexOf(layer), layer.querySelectorAll(cfg.roleSel).length, norm(layer.textContent)].join(':');
}

/** `dialog` when the layer offers the companion control beside its confirm, else `menu`. */
function kindOf(layer: Element | null, cfg: ConfirmCfg): 'menu' | 'dialog' {
  if (layer === null || cfg.companionRx === undefined) return 'menu';
  const companion = mk(cfg.companionRx);
  const offered = Array.from(layer.querySelectorAll(cfg.roleSel)).some((n) => companion.test(norm(n.textContent)) && visible(n));
  return offered ? 'dialog' : 'menu';
}

/** The one visible control a layer offers beside its companion: the capture's report, never pressed. */
function structuralOf(controls: readonly Element[], cfg: ConfirmCfg): string | null {
  if (cfg.companionRx === undefined) return null;
  const companion = mk(cfg.companionRx);
  const shown = controls.filter((n) => visible(n));
  const others = shown.filter((n) => !companion.test(norm(n.textContent)));
  return others.length === 1 && others.length < shown.length ? norm(others[0].textContent) : null;
}

/** The confirm control's rect and layer, or `found: false` when no layer holds one on top. */
export function locateConfirm(cfg: ConfirmCfg): ConfirmLocate {
  const layers = newestFirst(cfg);
  const hit = find(cfg, layers);
  if (!hit) return { found: false };
  const layer = hit.clickable.closest(cfg.scopes.join(', '));
  return { found: true, rect: rectOf(hit.clickable), fallback: hit.fallback, layer: kindOf(layer, cfg),
    sig: sigOf(layer, layers, cfg, norm(hit.clickable.textContent)) };
}

/** The top confirm layer: the newest dialog scope that is visible and on top, if any. */
export function confirmLayer(cfg: LayerCfg): LayerReport {
  const layers = newestFirst(cfg);
  const top = layers.find((el) => visible(el) && onTop(el));
  if (top === undefined) return { present: false };
  const controls = Array.from(top.querySelectorAll(cfg.roleSel));
  const rx = mk(cfg.rx);
  return {
    present: true,
    sig: sigOf(top, layers, cfg, ''),
    layer: kindOf(top, cfg),
    controls: controls.length,
    matches: Array.from(top.querySelectorAll([cfg.roleSel, cfg.deepSel].join(', '))).some((n) => rx.test(norm(n.textContent))),
    structural: structuralOf(controls, cfg),
    markup: cfg.withMarkup ? top.outerHTML : undefined,
  };
}
