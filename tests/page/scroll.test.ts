/** @jest-environment jsdom */
/**
 * Scroll containers. Class names rotate, so the list's scroller is found by
 * BEHAVIOUR — the biggest descendant whose content overflows with an
 * auto/scroll overflow-y — and the wheel is aimed at a point that is NOT over a
 * username link or avatar (those open a hover-preview card that overlays the
 * row and swallows every subsequent wheel event).
 */
import { locateDrawerScroll, locateScrollContainer } from '@/adapter/page';
import { box, hitTest, mount, scroller } from '../kit/adapter-dom';

const LIST_CFG = {
  rootSel: '[role="dialog"]',
  interactiveSel: 'a, button, [role="button"], img, canvas, video, [role="link"]',
};

const el = (id: string): Element => document.getElementById(id) as Element;

describe('the list modal’s scroller is the largest overflowing descendant', () => {
  test('reports its rect and metrics; the shorter scroller loses', () => {
    mount(`
      <div role="dialog">
        <div id="chrome"><h2>Followers</h2></div>
        <div id="tabs"></div>
        <div id="rows"></div>
      </div>
    `);
    scroller(el('tabs'), { scrollHeight: 400, clientHeight: 60 });
    scroller(el('rows'), { scrollHeight: 5000, clientHeight: 600, scrollTop: 120 });
    box(el('rows'), { x: 400, y: 120, width: 400, height: 600 });
    hitTest(() => null);

    expect(locateScrollContainer(LIST_CFG)).toMatchObject({
      found: true,
      rect: { x: 400, y: 120, width: 400, height: 600 },
      scrollTop: 120,
      scrollHeight: 5000,
      clientHeight: 600,
    });
  });

  test('a list that FITS has no scroller — found:false, never a throw', () => {
    // A small follower list overflows nothing. The Actor treats this as
    // "nothing to scroll" and keeps the rows the first page already loaded.
    mount('<div role="dialog"><div id="rows"></div></div>');
    hitTest(() => null);
    expect(locateScrollContainer(LIST_CFG)).toEqual({ found: false });
  });

  test('no dialog at all is also found:false', () => {
    mount('<main><div id="rows"></div></main>');
    scroller(el('rows'), { scrollHeight: 5000, clientHeight: 600 });
    expect(locateScrollContainer(LIST_CFG)).toEqual({ found: false });
  });

  test('an element that overflows but does not SCROLL is not the container', () => {
    mount('<div role="dialog"><div id="rows" style="overflow-y:visible"></div></div>');
    Object.defineProperty(el('rows'), 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(el('rows'), 'clientHeight', { value: 600, configurable: true });
    hitTest(() => null);
    expect(locateScrollContainer(LIST_CFG)).toEqual({ found: false });
  });
});

describe('the hover-safe rest point', () => {
  const setup = (): void => {
    mount(`
      <div role="dialog">
        <div id="rows"><a href="#" id="name">someone</a></div>
      </div>
    `);
    scroller(el('rows'), { scrollHeight: 5000, clientHeight: 600 });
    box(el('rows'), { x: 400, y: 100, width: 400, height: 600 });
  };

  test('a gutter point clear of the row controls is chosen', () => {
    setup();
    // The left gutter is row background; everything else lands on the link.
    hitTest((x) => (x <= 420 ? el('rows') : el('name')));
    const res = locateScrollContainer(LIST_CFG);
    expect(res.safePoint).toBeDefined();
    expect((res.safePoint as { x: number }).x).toBeLessThanOrEqual(420);
  });

  test('a dense list yields NO safe point — the Interactor uses its own entry', () => {
    setup();
    hitTest(() => el('name')); // every probe lands on a hover trigger
    expect(locateScrollContainer(LIST_CFG).safePoint).toBeUndefined();
  });

  test('a point that hit-tests OUTSIDE the scroller is rejected', () => {
    setup();
    mount(`
      <div role="dialog"><div id="rows"></div></div>
      <div id="overlay"></div>
    `);
    scroller(el('rows'), { scrollHeight: 5000, clientHeight: 600 });
    box(el('rows'), { x: 400, y: 100, width: 400, height: 600 });
    hitTest(() => el('overlay'));
    expect(locateScrollContainer(LIST_CFG).safePoint).toBeUndefined();
  });
});

describe('the notifications drawer’s scroller', () => {
  const DRAWER_CFG = { scopes: ['[role="dialog"]', '[role="alertdialog"]', 'aside'] };

  test('found inside the drawer scope', () => {
    mount('<aside><div id="feed"></div></aside>');
    scroller(el('feed'), { scrollHeight: 2400, clientHeight: 800, scrollTop: 40 });
    box(el('feed'), { x: 80, y: 0, width: 400, height: 800 });

    expect(locateDrawerScroll(DRAWER_CFG)).toEqual({
      found: true,
      rect: { x: 80, y: 0, width: 400, height: 800 },
      scrollTop: 40,
      scrollHeight: 2400,
      clientHeight: 800,
    });
  });

  test('a scroller outside every drawer scope is ignored', () => {
    mount('<main><div id="feed"></div></main>');
    scroller(el('feed'), { scrollHeight: 2400, clientHeight: 800 });
    expect(locateDrawerScroll(DRAWER_CFG)).toEqual({ found: false });
  });
});
