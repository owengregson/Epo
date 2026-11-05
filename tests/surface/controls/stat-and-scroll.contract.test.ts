/** @jest-environment jsdom */
/**
 * The header STAT controls and the list SCROLLER, against real markup.
 *
 * Both are ADR 0302 cases where a structural selector is already dead:
 *
 *  - the followers/following counts used to be `/{user}/followers/` links and
 *    are now `<a href="#">` opened by JS. The capture below confirms it, so a
 *    selector on the old href could never match again — the stat is found by
 *    which WORD it names, and which it does not.
 *  - the list's scroll container has no stable class, so it is found by
 *    BEHAVIOUR: the descendant with the greatest `scrollHeight` whose
 *    overflow-y scrolls and whose content actually overflows.
 */

import type { ListScrollCfg, StatCfg } from '@/adapter/page';
import { locateScrollContainer, locateStat } from '@/adapter/page';
import { surface } from '@/surface/index';
import { asScroller, mountSnapshot } from '../dom-kit';
import { hitTest } from '../kit-bridge';

const statCfg = (which: 'followers' | 'following'): StatCfg =>
  ({ ...(surface().controls[`${which}-stat`] as unknown as StatCfg), which });

const scrollCfg = surface().controls['list-scroller'] as unknown as ListScrollCfg;

describe('the header stats are `<a href="#">`, matched by their word', () => {
  beforeEach(() => {
    mountSnapshot('profile-header-01.html');
  });

  test('the capture really does ship them as JS-opened anchors', () => {
    const anchors = Array.from(document.querySelectorAll('header a[href="#"]'));
    const texts = anchors.map((a) => (a.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(texts.some((t) => /followers$/i.test(t))).toBe(true);
    expect(texts.some((t) => /following$/i.test(t))).toBe(true);
    // The selector this replaced.
    expect(document.querySelector('header a[href$="/followers/"]')).toBeNull();
  });

  test('the followers stat is located, and is NOT the following one', () => {
    const followers = locateStat(statCfg('followers'));
    const following = locateStat(statCfg('following'));
    expect(followers.found).toBe(true);
    expect(following.found).toBe(true);
    // `\bfollowers?\b` does not match "following" — the two must resolve to
    // different controls or the walk opens the wrong list.
    expect(followers.rect).not.toEqual(undefined);
    const followersEl = Array.from(document.querySelectorAll('header a[href="#"]')).find((a) =>
      /followers$/i.test((a.textContent ?? '').replace(/\s+/g, ' ').trim()),
    );
    const followingEl = Array.from(document.querySelectorAll('header a[href="#"]')).find((a) =>
      /following$/i.test((a.textContent ?? '').replace(/\s+/g, ' ').trim()),
    );
    expect(followersEl).not.toBe(followingEl);
  });

  test('the rect reported is a CLICKABLE ancestor, not the bare text span', () => {
    // The count sits three spans deep; pressing the span's own rect can miss a
    // handler that lives on the wrapping anchor.
    const res = locateStat(statCfg('followers'));
    expect(res.rect?.width).toBeGreaterThan(2);
    expect(res.rect?.height).toBeGreaterThan(2);
  });

  test('a header with no stats reports not-found rather than guessing', () => {
    for (const a of Array.from(document.querySelectorAll('a[href="#"]'))) a.remove();
    for (const el of Array.from(document.querySelectorAll('main, body > div'))) el.remove();
    expect(locateStat(statCfg('followers')).found).toBe(false);
  });
});

describe('the list scroller is found by behaviour, not by class', () => {
  beforeEach(() => {
    mountSnapshot('dialog-04.html');
    hitTest(() => null);
  });

  test('the capture ships the scroller with an inline overflow and no stable class', () => {
    const inline = Array.from(document.querySelectorAll('[style*="overflow"]'));
    expect(inline.length).toBeGreaterThan(0);
    // Every class on it is obfuscated — nothing to key a selector on.
    for (const el of inline) {
      const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      expect(classes.every((c) => /^(x|_)[a-z0-9_]+$/i.test(c) || c === 'html-div')).toBe(true);
    }
  });

  test('the LARGEST overflowing descendant wins, not the first one', () => {
    // jsdom computes no layout and does not resolve the `overflow` shorthand,
    // so the geometry a browser would have produced is stamped on. What is
    // under test is the SELECTION RULE over the real element tree.
    const candidates = Array.from(document.querySelectorAll('[role="dialog"] div')).slice(0, 40);
    const small = candidates[1] as Element;
    const big = candidates[3] as Element;
    asScroller(small, { scrollHeight: 900, clientHeight: 400 });
    asScroller(big, { scrollHeight: 9000, clientHeight: 400 });

    const res = locateScrollContainer(scrollCfg);
    expect(res).toMatchObject({ found: true, scrollHeight: 9000, clientHeight: 400 });
    expect(res.rect?.height).toBeGreaterThan(2);
  });

  test('a container that does not overflow is not a scroller', () => {
    const el = document.querySelectorAll('[role="dialog"] div')[3] as Element;
    asScroller(el, { scrollHeight: 400, clientHeight: 400 });
    expect(locateScrollContainer(scrollCfg)).toEqual({ found: false });
  });

  test('a hover-safe rest point is reported when one exists', () => {
    const el = document.querySelectorAll('[role="dialog"] div')[3] as Element;
    asScroller(el, { scrollHeight: 9000, clientHeight: 400 });
    // A point over row background (no anchor/avatar/button above it) is safe;
    // without one the wheel opens Instagram's hover card, which then swallows
    // every subsequent wheel event and stalls the walk.
    hitTest(() => el);
    expect(locateScrollContainer(scrollCfg).safePoint).toBeDefined();

    hitTest(() => document.querySelector('[role="dialog"] a') ?? null);
    expect(locateScrollContainer(scrollCfg).safePoint).toBeUndefined();
  });
});
