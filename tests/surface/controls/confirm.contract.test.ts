/** @jest-environment jsdom */
/**
 * The unfollow / cancel-request confirm control, against the real menu.
 *
 * Two live-observed failures are the reason this control has two passes, and
 * both are checked here against captured markup rather than a hand-written
 * approximation: the HIDDEN TWIN (a menu that renders the row twice, one
 * `display:none`, where a first-DOM-match search kept pressing the invisible
 * copy) and the BARE-DIV menu (rows shipped with no role at all, where the
 * role-marked query goes blind while the control sits plainly on screen).
 */

import type { ConfirmCfg, LayerCfg } from '@/adapter/page';
import { confirmLayer, locateConfirm } from '@/adapter/page';
import { surface } from '@/surface/index';
import { box, DEFAULT_BOX } from '../../kit/adapter-dom';
import { domText } from '../corpus';
import { hitTest, mountSnapshot } from '../dom-kit';

/** The descriptor from the document — the config is data, not a test constant. */
const CFG = surface().controls['unfollow-confirm'] as unknown as ConfirmCfg;

describe('the real confirm dialog (role-marked rows)', () => {
  beforeEach(() => {
    mountSnapshot('dialog-01.html');
  });

  test('the document’s descriptor is a role-then-deep-text control', () => {
    expect(surface().controls['unfollow-confirm']?.strategy).toBe('role-then-deep-text');
  });

  test('finds the Unfollow button on the PRIMARY pass, never the Cancel beside it', () => {
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Unfollow', 'Cancel']);

    const res = locateConfirm(CFG);
    expect(res.found).toBe(true);
    // `fallback: false` matters: a persistent fallback is early drift in the
    // primary anchors, and the Actor warns on it.
    expect(res.fallback).toBe(false);
    expect(res.rect?.width).toBeGreaterThan(2);
  });

  test('the HIDDEN TWIN is skipped and the visible copy is pressed', () => {
    const real = document.querySelector('button') as HTMLButtonElement;
    const ghost = real.cloneNode(true) as HTMLButtonElement;
    ghost.setAttribute('style', 'display:none');
    ghost.getBoundingClientRect = (): DOMRect =>
      ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
    real.parentElement?.insertBefore(ghost, real);

    // The ghost is FIRST in document order — a naive search returns it.
    expect(document.querySelectorAll('button')[0]).toBe(ghost);
    expect(locateConfirm(CFG).found).toBe(true);
    expect(locateConfirm(CFG).rect?.width).toBeGreaterThan(2);
  });

  test('a dialog with no confirm row reports not-found instead of guessing', () => {
    for (const button of Array.from(document.querySelectorAll('button'))) button.remove();
    expect(locateConfirm(CFG)).toEqual({ found: false });
  });
});

describe('the real menu whose row is a div[role=button], not a <button>', () => {
  beforeEach(() => {
    mountSnapshot('dialog-02.html');
  });

  test('matching by ROLE — not by tag — is what finds it', () => {
    // Selected by the corpus for exactly this signature (`confirmButton:0
    // confirmText:1`), so the fixture and the behaviour cannot drift apart.
    expect(document.querySelector('button')).toBeNull();
    const row = Array.from(document.querySelectorAll('[role="button"]')).find((n) =>
      /^\s*unfollow\b/i.test((n.textContent ?? '').trim()),
    );
    expect(row).toBeDefined();
    // The text is three elements deep inside it — a selector on the text node's
    // own tag would press the <span> and miss the handler.
    expect(row?.querySelector('span span')?.textContent).toBe('Unfollow');

    const res = locateConfirm(CFG);
    expect(res).toMatchObject({ found: true, fallback: false });
    expect(res.rect?.width).toBeGreaterThan(2);
  });

  test('with the role attribute GONE the self-recovery pass still finds it', () => {
    // The drift the fallback tier exists for: Instagram periodically ships menu
    // rows with no role at all, and the role-marked query goes blind while the
    // control sits plainly on screen. Simulated on the real markup rather than
    // on a hand-written stand-in.
    for (const el of Array.from(document.querySelectorAll('[role="button"]'))) {
      el.removeAttribute('role');
    }
    expect(document.querySelectorAll(CFG.roleSel)).toHaveLength(0);

    const res = locateConfirm(CFG);
    expect(res).toMatchObject({ found: true, fallback: true });
    // The Actor warns on `fallback: true`: a persistent recovery is early drift.
    expect(res.rect?.width).toBeGreaterThan(2);
  });
});

describe('two layers on the real captures (ADR 0308, spec §11.2 item 1)', () => {
  const MENU_ROW = { x: 420, y: 501, width: 560, height: 54 };
  const DIALOG_BUTTON = { x: 520, y: 300, width: 400, height: 48 };
  const LATER: ConfirmCfg = { ...CFG, dialogsOnly: true };

  /** Append a real snapshot as a new portal, laid out like the rest of the page. */
  function appendSnapshot(file: string, html = domText(file)): Element {
    document.body.insertAdjacentHTML('beforeend', html);
    const added = document.body.lastElementChild as Element;
    for (const el of [added, ...Array.from(added.querySelectorAll('*'))]) box(el, DEFAULT_BOX);
    return added;
  }

  /** `top` covers the page: a point inside one of its controls lands there, anywhere else on its backdrop. */
  function coveredBy(top: Element): void {
    hitTest((x, y) => {
      const under = Array.from(top.querySelectorAll('*')).filter((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      return under[under.length - 1] ?? top;
    });
  }

  const rowOf = (root: ParentNode, tag: string): Element =>
    Array.from(root.querySelectorAll(tag)).find((n) => /^\s*unfollow\b/i.test(n.textContent ?? '')) as Element;

  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  test('the descriptor names the companion, the dialog scopes and the two layers', () => {
    const d = surface().controls['unfollow-confirm'] as Record<string, unknown>;
    expect(d.layers).toEqual(['menu', 'dialog']);
    expect(d.scopes).toEqual(['[role="dialog"]', '[role="alertdialog"]']);
    expect(d.companionRx).toBeDefined();
  });

  test('menu, then the dialog on top of it: the second locate is the dialog’s button, a new layer, never the menu row', () => {
    mountSnapshot('dialog-02.html');
    box(rowOf(document, '[role="button"]'), MENU_ROW);
    const first = locateConfirm(CFG);
    expect(first).toMatchObject({ found: true, rect: MENU_ROW, layer: 'menu' });

    const dialog = appendSnapshot('dialog-01.html');
    box(rowOf(dialog, 'button'), DIALOG_BUTTON);
    coveredBy(dialog);
    const second = locateConfirm(LATER);
    expect(second).toMatchObject({ found: true, rect: DIALOG_BUTTON, layer: 'dialog', fallback: false });
    expect(second.sig).not.toBe(first.sig);
  });

  test('with the dialog’s button not yet pressable, the covered menu row is never offered instead', () => {
    mountSnapshot('dialog-02.html');
    box(rowOf(document, '[role="button"]'), MENU_ROW);
    const dialog = appendSnapshot('dialog-01.html');
    box(rowOf(dialog, 'button'), { x: 0, y: 0, width: 0, height: 0 });
    coveredBy(dialog);
    expect(locateConfirm(LATER)).toEqual({ found: false });
    expect(confirmLayer(CFG as LayerCfg)).toMatchObject({ present: true, layer: 'dialog', matches: true });
  });

  test('the Cancel control is found in the dialog only, and never the Unfollow beside it', () => {
    const cancel = surface().controls['unfollow-dialog-cancel'] as unknown as ConfirmCfg;
    mountSnapshot('dialog-02.html');
    expect(locateConfirm(cancel)).toEqual({ found: false });
    const dialog = appendSnapshot('dialog-01.html');
    const button = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Cancel') as Element;
    box(button, DIALOG_BUTTON);
    expect(locateConfirm(cancel)).toMatchObject({ found: true, rect: DIALOG_BUTTON });
  });

  test('an unexpected two-button dialog on the menu: nothing to press, its control reported for the capture', () => {
    mountSnapshot('dialog-02.html');
    const restrict = domText('dialog-01.html')
      .replace(/If you change your mind[^<]*/, 'Restrict @user_i12?')
      .replace('>Unfollow</button>', '>Restrict</button>');
    const dialog = appendSnapshot('dialog-01.html', restrict);
    coveredBy(dialog);
    expect(locateConfirm(LATER)).toEqual({ found: false });
    expect(confirmLayer(CFG as LayerCfg)).toMatchObject({
      present: true, layer: 'dialog', controls: 2, matches: false, structural: 'Restrict',
    });
  });
});
