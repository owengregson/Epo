/** @jest-environment jsdom */
/**
 * The followers / following count controls.
 *
 * The shape below is the live one re-verified 2026-08-12: both counts are
 * `<a href="#">` that open the modal via JS. A selector keyed on
 * `/<user>/followers/` — the older shape — can never match, which is why these
 * are located by TEXT, and why "followers" must not also claim "following".
 */

import type { StatCfg } from '@/adapter/page';
import { locateStat } from '@/adapter/page';
import { box, mount, rx } from '../kit/adapter-dom';

const base = {
  rx: { followers: rx(/\bfollowers?\b/i), following: rx(/\bfollowing\b/i) },
  scopes: ['header', 'main', 'body'],
  candSel: 'a, button, [role="button"], [role="link"], button',
  clickableSel: 'a, button, [role="button"], [role="link"]',
} as const;

const cfg = (which: 'followers' | 'following'): StatCfg => ({ ...base, which });

const profile = (): void => {
  mount(`
    <header>
      <section>
        <ul>
          <li><span>12 posts</span></li>
          <li><a href="#" id="followers"><span>1,204</span> followers</a></li>
          <li><a href="#" id="following"><span>318</span> following</a></li>
        </ul>
      </section>
    </header>
  `);
};

describe('locateStat picks exactly one stat', () => {
  test('the followers control, by text — not by a /followers/ href', () => {
    profile();
    box(document.getElementById('followers') as Element, {
      x: 120,
      y: 260,
      width: 90,
      height: 22,
    });
    expect(locateStat(cfg('followers'))).toEqual({
      found: true,
      rect: { x: 120, y: 260, width: 90, height: 22 },
    });
  });

  test('the following control is its sibling — the two never cross-match', () => {
    profile();
    box(document.getElementById('following') as Element, {
      x: 230,
      y: 260,
      width: 80,
      height: 22,
    });
    expect(locateStat(cfg('following'))).toEqual({
      found: true,
      rect: { x: 230, y: 260, width: 80, height: 22 },
    });
  });

  test('"following" is not matched by the followers pattern', () => {
    mount('<header><a href="#" id="g"><span>318</span> following</a></header>');
    expect(locateStat(cfg('followers'))).toEqual({ found: false });
  });

  test('a row naming BOTH counts matches neither (ambiguous, never guessed)', () => {
    mount('<header><a href="#">1,204 followers · 318 following</a></header>');
    expect(locateStat(cfg('followers'))).toEqual({ found: false });
    expect(locateStat(cfg('following'))).toEqual({ found: false });
  });
});

describe('scope order and clickable resolution', () => {
  test('the header wins over a stat mentioned elsewhere on the page', () => {
    mount(`
      <header><a href="#" id="head">1,204 followers</a></header>
      <main><a href="#" id="body-stat">9 followers</a></main>
    `);
    box(document.getElementById('head') as Element, { x: 120, y: 260, width: 90, height: 22 });
    box(document.getElementById('body-stat') as Element, { x: 10, y: 900, width: 90, height: 22 });
    expect(locateStat(cfg('followers')).rect).toEqual({ x: 120, y: 260, width: 90, height: 22 });
  });

  test('the rect is the clickable ancestor’s, not the inner text node’s', () => {
    mount('<header><a href="#" id="a"><span id="n">1,204</span> followers</a></header>');
    box(document.getElementById('a') as Element, { x: 120, y: 260, width: 90, height: 22 });
    box(document.getElementById('n') as Element, { x: 122, y: 264, width: 30, height: 14 });
    expect(locateStat(cfg('followers')).rect).toEqual({ x: 120, y: 260, width: 90, height: 22 });
  });

  test('a header without either stat reports not-found', () => {
    mount('<header><a href="#">12 posts</a></header>');
    expect(locateStat(cfg('followers'))).toEqual({ found: false });
  });
});
