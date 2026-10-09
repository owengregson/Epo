/** @jest-environment jsdom */
/**
 * The unfollow / cancel-request confirm control, against a real DOM.
 *
 * Two behaviours matter here and both were live-observed failures:
 *  - the HIDDEN TWIN — the menu renders the row twice, one `display:none`, and
 *    a first-DOM-match search kept pressing the invisible copy;
 *  - the BARE-DIV menu — Instagram periodically ships rows with no role at all,
 *    and the role-marked query goes blind while the control is plainly visible.
 */

import type { ConfirmCfg } from '@/adapter/page';
import { locateConfirm } from '@/adapter/page';
import { box, mount, rx } from '../kit/adapter-dom';

const CFG: ConfirmCfg = {
  rx: rx(/^\s*(unfollow|cancel request)\b/i),
  scopes: ['[role="dialog"]', '[role="alertdialog"]'],
  roleSel: 'button, [role="button"], [role="menuitem"]',
  deepSel: 'div, span, a, [tabindex]',
  clickableSel: 'button, [role="button"], [role="menuitem"], [tabindex], a',
  maxChildren: 3,
  maxTextLen: 40,
};

describe('primary pass: role-marked, visible controls', () => {
  test('finds the Unfollow menu item and reports its rect', () => {
    mount(`
      <div role="dialog">
        <div role="menuitem">Add to favorites</div>
        <div role="menuitem" id="hit">Unfollow</div>
        <div role="menuitem">Cancel</div>
      </div>
    `);
    box(document.getElementById('hit') as Element, { x: 400, y: 500, width: 200, height: 44 });

    expect(locateConfirm(CFG)).toEqual({
      found: true,
      rect: { x: 400, y: 500, width: 200, height: 44 },
      fallback: false,
    });
  });

  test('a suffixed row ("Unfollow @name") still matches — the regex is a PREFIX test', () => {
    mount('<div role="dialog"><button>Unfollow @someone</button></div>');
    expect(locateConfirm(CFG).found).toBe(true);
  });

  test('"Cancel Request" is the confirm for a pending follow request', () => {
    mount('<div role="dialog"><button>Cancel Request</button></div>');
    expect(locateConfirm(CFG)).toMatchObject({ found: true, fallback: false });
  });

  test('the HIDDEN TWIN is skipped and the visible copy is returned', () => {
    mount(`
      <div role="dialog">
        <div role="menuitem" id="ghost" style="display:none">Unfollow</div>
        <div role="menuitem" id="real">Unfollow</div>
      </div>
    `);
    box(document.getElementById('ghost') as Element, { x: 0, y: 0, width: 200, height: 44 });
    box(document.getElementById('real') as Element, { x: 400, y: 500, width: 200, height: 44 });

    expect(locateConfirm(CFG).rect).toEqual({ x: 400, y: 500, width: 200, height: 44 });
  });

  test('a zero-sized control is not pressable and is skipped', () => {
    mount('<div role="dialog"><h2>Options</h2><button id="b">Unfollow</button></div>');
    box(document.getElementById('b') as Element, { x: 10, y: 10, width: 0, height: 0 });
    expect(locateConfirm(CFG)).toEqual({ found: false });
  });

  test('dialog scopes are searched before the document', () => {
    mount(`
      <main><button id="stray">Unfollow</button></main>
      <div role="dialog"><button id="menu">Unfollow</button></div>
    `);
    box(document.getElementById('stray') as Element, { x: 5, y: 5, width: 90, height: 20 });
    box(document.getElementById('menu') as Element, { x: 400, y: 500, width: 200, height: 44 });
    expect(locateConfirm(CFG).rect).toEqual({ x: 400, y: 500, width: 200, height: 44 });
  });
});

describe('self-recovery pass: a menu shipped as bare divs', () => {
  test('finds the deepest matching element and prefers a press-shaped ancestor', () => {
    mount(`
      <div role="dialog">
        <div tabindex="0" id="row"><div><span id="label">Unfollow</span></div></div>
      </div>
    `);
    box(document.getElementById('row') as Element, { x: 400, y: 500, width: 260, height: 48 });
    box(document.getElementById('label') as Element, { x: 420, y: 512, width: 80, height: 20 });

    const res = locateConfirm(CFG);
    // `fallback: true` is the Actor's early-drift signal.
    expect(res.fallback).toBe(true);
    // The rect is the pressable ancestor's, not the bare text span's.
    expect(res.rect).toEqual({ x: 400, y: 500, width: 260, height: 48 });
  });

  test('a whole panel of text is NOT mistaken for a menu row', () => {
    mount(`
      <div role="dialog">
        <div id="panel">Unfollow this account? You will stop seeing their posts in your feed.</div>
      </div>
    `);
    expect(locateConfirm(CFG)).toEqual({ found: false });
  });

  test('the row LABEL wins over the multi-child wrapper that contains it', () => {
    mount(`
      <div role="dialog">
        <div id="wrap" tabindex="0">
          <span>Unfollow</span><i>a</i><i>b</i><i>c</i><i>d</i>
        </div>
      </div>
    `);
    box(document.getElementById('wrap') as Element, { x: 400, y: 500, width: 260, height: 48 });

    // The wrapper holds more children than a menu row ever does, so it is not a
    // candidate itself; the deepest matching label is, and the rect resolves
    // back up to the pressable ancestor.
    expect(locateConfirm(CFG)).toEqual({
      found: true,
      fallback: true,
      rect: { x: 400, y: 500, width: 260, height: 48 },
    });
  });

  test('an empty menu reports not-found (the Actor escalates to stale)', () => {
    mount('<div role="dialog"><div role="menuitem">Report</div></div>');
    expect(locateConfirm(CFG)).toEqual({ found: false });
  });
});
