/** @jest-environment jsdom */
/**
 * The notifications drawer and the follow-requests panel.
 *
 * Three searches, all scope-ordered: page content must never beat the nav rail
 * or the open drawer — a stray "Notifications" heading in a feed post would
 * otherwise be pressed instead of the bell.
 */

import type { ConfirmRequestCfg, LabeledCfg, TextEntryCfg } from '@/adapter/page';
import { locateConfirmRequest, locateLabeled, locateTextEntry } from '@/adapter/page';
import { box, mount, rx } from '../kit/adapter-dom';

const el = (id: string): Element => document.getElementById(id) as Element;

const NOTIFICATIONS: LabeledCfg = {
  rx: rx(/^\s*notifications\s*$/i),
  scopes: ['nav', '[role="navigation"]', 'body'],
  labeledSel: 'svg[aria-label], [aria-label]',
  clickableSel: 'a, button, [role="button"], [role="link"]',
};

const REQUESTS_ENTRY: TextEntryCfg = {
  rx: rx(/^\s*follow requests\b/i),
  scopes: ['[role="dialog"]', '[role="alertdialog"]', 'aside', 'body'],
  nodeSel: 'span, div, a, button, [role="button"]',
  clickableSel: 'a, button, [role="button"], [role="link"], [role="menuitem"]',
};

const CONFIRM_REQUEST: ConfirmRequestCfg = {
  rx: rx(/^\s*confirm\s*$/i),
  scopes: ['[role="dialog"]', '[role="alertdialog"]', 'aside', 'body'],
  buttonSel: 'button, [role="button"]',
  profilePathRx: rx(/^\/[A-Za-z0-9._]+\/?$/),
  maxDepth: 8,
};

describe('locateLabeled: icon controls with no text', () => {
  test('the bell is found by accessible name, and the rect is its pressable ancestor', () => {
    mount(`
      <nav>
        <div role="button" id="row"><svg aria-label="Notifications"></svg><span>Notifications</span></div>
      </nav>
    `);
    box(el('row'), { x: 12, y: 300, width: 220, height: 48 });
    expect(locateLabeled(NOTIFICATIONS)).toEqual({
      found: true,
      rect: { x: 12, y: 300, width: 220, height: 48 },
    });
  });

  test('the nav rail wins over a matching label in page content', () => {
    mount(`
      <main><div aria-label="Notifications" id="post"></div></main>
      <nav><a href="#" id="bell" aria-label="Notifications"></a></nav>
    `);
    box(el('post'), { x: 500, y: 800, width: 200, height: 40 });
    box(el('bell'), { x: 12, y: 300, width: 220, height: 48 });
    expect(locateLabeled(NOTIFICATIONS).rect).toEqual({ x: 12, y: 300, width: 220, height: 48 });
  });

  test('an unlabelled rail reports not-found (a soft skip, never stale)', () => {
    mount('<nav><a href="#" aria-label="Home"></a></nav>');
    expect(locateLabeled(NOTIFICATIONS)).toEqual({ found: false });
  });
});

describe('locateTextEntry: the smallest element whose own text matches', () => {
  test('the entry label wins over every ancestor containing it', () => {
    mount(`
      <div role="dialog">
        <div id="outer"><div id="mid"><span id="label">Follow requests</span></div></div>
      </div>
    `);
    box(el('outer'), { x: 0, y: 0, width: 400, height: 600 });
    box(el('label'), { x: 20, y: 90, width: 180, height: 24 });
    // No press-shaped ancestor here, so the label's own rect is returned.
    expect(locateTextEntry(REQUESTS_ENTRY).rect).toEqual({
      x: 20,
      y: 90,
      width: 180,
      height: 24,
    });
  });

  test('the rect resolves up to the pressable row when there is one', () => {
    mount(`
      <div role="dialog">
        <div role="button" id="row"><span id="label">Follow requests</span><span>3</span></div>
      </div>
    `);
    box(el('row'), { x: 16, y: 88, width: 360, height: 56 });
    box(el('label'), { x: 20, y: 96, width: 180, height: 24 });
    expect(locateTextEntry(REQUESTS_ENTRY).rect).toEqual({
      x: 16,
      y: 88,
      width: 360,
      height: 56,
    });
  });

  test('no entry (public account, nothing pending) is a soft not-found', () => {
    mount('<div role="dialog"><div>This Week</div></div>');
    expect(locateTextEntry(REQUESTS_ENTRY)).toEqual({ found: false });
  });
});

describe('locateConfirmRequest: the head of the requests panel', () => {
  const panel = (rows: { user: string }[]): void => {
    mount(`
      <div role="dialog">
        ${rows
          .map(
            (r) => `
          <div class="_abcd">
            <a href="/${r.user}/"><img alt="${r.user}'s profile picture"></a>
            <a href="/${r.user}/">${r.user}</a>
            <button id="c-${r.user}">Confirm</button>
            <button>Delete</button>
          </div>`,
          )
          .join('')}
      </div>
    `);
  };

  test('returns the FIRST Confirm, whose row it is, and how many remain', () => {
    panel([{ user: 'alpha' }, { user: 'bravo' }, { user: 'charlie' }]);
    box(el('c-alpha'), { x: 300, y: 160, width: 88, height: 32 });

    expect(locateConfirmRequest(CONFIRM_REQUEST)).toEqual({
      found: true,
      rect: { x: 300, y: 160, width: 88, height: 32 },
      username: 'alpha',
      remaining: 3,
    });
  });

  test('the remaining count is the progress signal between accepts', () => {
    panel([{ user: 'alpha' }]);
    expect(locateConfirmRequest(CONFIRM_REQUEST)).toMatchObject({
      username: 'alpha',
      remaining: 1,
    });
  });

  test('a row with no profile link yields a null username, not a wrong one', () => {
    mount(`
      <div role="dialog">
        <div><span>someone</span><button id="c">Confirm</button></div>
      </div>
    `);
    expect(locateConfirmRequest(CONFIRM_REQUEST)).toMatchObject({ found: true, username: null });
  });

  test('an empty panel reports not-found (the accept loop stops)', () => {
    mount('<div role="dialog"><div>No new requests</div></div>');
    expect(locateConfirmRequest(CONFIRM_REQUEST)).toEqual({ found: false });
  });

  test('a "Confirm" button outside every drawer scope still loses to the panel', () => {
    mount(`
      <main><button id="stray">Confirm</button></main>
      <div role="dialog">
        <div><a href="/alpha/">alpha</a><button id="real">Confirm</button></div>
      </div>
    `);
    box(el('stray'), { x: 5, y: 900, width: 80, height: 30 });
    box(el('real'), { x: 300, y: 160, width: 88, height: 32 });
    expect(locateConfirmRequest(CONFIRM_REQUEST)).toMatchObject({
      rect: { x: 300, y: 160, width: 88, height: 32 },
      username: 'alpha',
    });
  });
});
