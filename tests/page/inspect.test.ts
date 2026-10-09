/** @jest-environment jsdom */
/**
 * The inspection harness's in-page instrumentation, against a DOM.
 *
 * It had no test at all while it was an ES5 string: `tsc` saw text, Biome saw
 * text, and the only thing that ever ran it was a live session. Its two safety
 * properties are exactly the ones worth a regression test — RECORD-ONLY must
 * stop the click dead (inspecting a Follow button must never follow anyone),
 * and the harness's own UI must never capture or intercept itself.
 */

import type { InspectCfg } from '@/adapter/page';
import { buildRecord, inspectBanner, inspectTick } from '@/adapter/page';

const CFG: InspectCfg = {
  banner: 'EPO INSPECT — click any element',
  prefix: '__epo_inspect_',
  maxDepth: 8,
  maxText: 120,
  maxHtml: 400,
};

interface InspectWindow extends Window {
  __epoInspectInstalled?: boolean;
  __epoInspectMode?: 'record-only' | 'pass-through';
}
const w = (): InspectWindow => window as InspectWindow;

beforeEach(() => {
  document.body.innerHTML = '';
  delete w().__epoInspectInstalled;
  delete w().__epoInspectMode;
});

describe('install and UI', () => {
  test('installs once and re-injects the UI every tick (the SPA wipes it)', () => {
    inspectTick(CFG);
    expect(document.getElementById('__epo_inspect_banner')?.textContent).toBe(CFG.banner);
    expect(document.getElementById('__epo_inspect_toggle')?.textContent).toBe('MODE: RECORD-ONLY');

    document.body.innerHTML = ''; // an Instagram re-render
    inspectTick(CFG);
    expect(document.getElementById('__epo_inspect_banner')).not.toBeNull();
    expect(document.getElementById('__epo_inspect_toggle')).not.toBeNull();
  });

  test('the pre-login banner does not intercept anything', () => {
    expect(inspectBanner({ banner: 'log in', prefix: CFG.prefix })).toBe(true);
    const el = document.getElementById('__epo_inspect_prelogin') as HTMLElement;
    expect(el.textContent).toBe('log in');
    expect(el.style.cssText).toContain('pointer-events: none');
  });
});

describe('RECORD-ONLY is the safe default', () => {
  test('a click is captured and STOPPED — the page never sees it', () => {
    document.body.innerHTML = '<button id="follow" aria-label="Follow">Follow</button>';
    inspectTick(CFG);

    let pageSawIt = false;
    document.getElementById('follow')?.addEventListener('click', () => {
      pageSawIt = true;
    });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('follow')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(pageSawIt).toBe(false);

    const records = inspectTick(CFG);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tag: 'button', id: 'follow', ariaLabel: 'Follow', text: 'Follow' });
  });

  test('PASS-THROUGH records AND lets the click land', () => {
    document.body.innerHTML = '<button id="menu">Following</button>';
    inspectTick(CFG);
    (document.getElementById('__epo_inspect_toggle') as HTMLButtonElement).click();
    expect(w().__epoInspectMode).toBe('pass-through');

    let pageSawIt = false;
    document.getElementById('menu')?.addEventListener('click', () => {
      pageSawIt = true;
    });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('menu')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(pageSawIt).toBe(true);
    // The toggle's own click is not a capture.
    expect(inspectTick(CFG)).toHaveLength(1);
  });

  test('the harness never captures its own UI', () => {
    inspectTick(CFG);
    inspectTick(CFG); // drain the install tick
    (document.getElementById('__epo_inspect_toggle') as HTMLButtonElement).click();
    expect(inspectTick(CFG)).toEqual([]);
  });
});

describe('the record', () => {
  test('carries the ancestor chain, attributes and a truncated outerHTML', () => {
    document.body.innerHTML =
      '<nav><div role="button"><a href="/user_a1/" data-x="1" class="c1 c2">Long text</a></div></nav>';
    const el = document.querySelector('a') as Element;
    const record = buildRecord(el, { ...CFG, maxText: 4, maxHtml: 10 });

    expect(record).toMatchObject({ tag: 'a', href: '/user_a1/', classes: ['c1', 'c2'] });
    expect(record.attributes['data-x']).toBe('1');
    expect(record.dataset.x).toBe('1');
    expect(record.text).toBe('Long');
    expect(record.outerHTML).toHaveLength(10);
    // Nearest-first, and the button-ish ancestor is flagged — the whole point
    // of the harness is finding what the page treats as the control.
    expect(record.ancestors[0]).toMatchObject({ tag: 'div', role: 'button', isButtonish: true });
    expect(record.ancestors[1]?.tag).toBe('nav');
  });

  test('the ancestor chain is depth-capped', () => {
    document.body.innerHTML = '<div><div><div><div><span id="deep">x</span></div></div></div></div>';
    const el = document.getElementById('deep') as Element;
    expect(buildRecord(el, { ...CFG, maxDepth: 2 }).ancestors).toHaveLength(2);
  });
});
