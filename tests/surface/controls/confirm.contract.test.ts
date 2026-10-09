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

import type { ConfirmCfg } from '@/adapter/page';
import { locateConfirm } from '@/adapter/page';
import { surface } from '@/surface/index';
import { mountSnapshot } from '../dom-kit';

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
