/** @jest-environment jsdom */
/**
 * The profile action button, against a real DOM. The header markup below is a
 * hand-trimmed, anonymized shape of what Instagram ships: obfuscated class
 * names, the state word LEADING the button's text, and an icon whose alt text
 * is appended to it.
 */

import type { ActionButtonCfg } from '@/adapter/page';
import { locateActionButton, probeActionButton } from '@/adapter/page';
import { box, mount, rx } from '../kit/adapter-dom';

/** The literals the version module supplies — mirrored here, not imported. */
const CFG: ActionButtonCfg = {
  sel: 'header button, header [role="button"]',
  rx: {
    'follow-back': rx(/^\s*follow back/i),
    following: rx(/^\s*following/i),
    requested: rx(/^\s*requested/i),
    follow: rx(/^\s*follow(\s|$)/i),
  },
};

const header = (buttonHtml: string): void => {
  mount(`<header class="_aswp _aswr"><section><div>${buttonHtml}</div></section></header>`);
};

describe('locateActionButton reads the leading state word', () => {
  test('a Follow button would be pressed by the follow op', () => {
    header('<button class="_acan">Follow</button>');
    expect(locateActionButton({ ...CFG, op: 'follow' })).toMatchObject({
      found: true,
      state: 'follow',
      wouldClick: true,
      needsConfirm: false,
    });
  });

  test('the icon alt text appended to "Following" does not defeat the match', () => {
    // Observed live: the button's textContent reads "FollowingDown chevron icon".
    header('<button class="_acan">Following<svg><title>Down chevron icon</title></svg></button>');
    const res = locateActionButton({ ...CFG, op: 'unfollow' });
    expect(res.state).toBe('following');
    expect(res.wouldClick).toBe(true);
    // The unfollow click opens a menu, so a confirm click is required.
    expect(res.needsConfirm).toBe(true);
  });

  test('"Follow Back" is matched before the bare Follow regex would claim it', () => {
    header('<button>Follow Back</button>');
    expect(locateActionButton({ ...CFG, op: 'follow' }).state).toBe('follow-back');
  });

  test('a pending Requested button is cancellable (an unfollow op presses it)', () => {
    header('<button>Requested</button>');
    expect(locateActionButton({ ...CFG, op: 'unfollow' })).toMatchObject({
      state: 'requested',
      wouldClick: true,
      needsConfirm: true,
    });
  });

  test('an already-Following button is a no-op for the follow op', () => {
    header('<button>Following</button>');
    expect(locateActionButton({ ...CFG, op: 'follow' })).toMatchObject({
      found: true,
      state: 'following',
      wouldClick: false,
    });
  });

  test('the located rect is the button’s own', () => {
    header('<button id="b">Follow</button>');
    const btn = document.getElementById('b') as Element;
    box(btn, { x: 300, y: 210, width: 120, height: 32 });
    expect(locateActionButton({ ...CFG, op: 'follow' }).rect).toEqual({
      x: 300,
      y: 210,
      width: 120,
      height: 32,
    });
  });
});

describe('the header anchor is the ONLY scope (no document-wide fallback)', () => {
  test('a Follow button OUTSIDE the header is never located', () => {
    // A suggestion carousel's Follow button belongs to a DIFFERENT account.
    // A document-wide search would press it and then "verify" against it —
    // writing a ledger row and a graph edge for an account never followed.
    mount(`
      <header><section><div><span>No action button yet</span></div></section></header>
      <main><div role="button">Follow</div><button>Follow</button></main>
    `);
    expect(locateActionButton({ ...CFG, op: 'follow' })).toEqual({ found: false });
    expect(probeActionButton(CFG)).toEqual({ found: false, state: 'unknown' });
  });

  test('a header with no matching text reports not-found (drift fails loud)', () => {
    header('<button>Message</button>');
    expect(locateActionButton({ ...CFG, op: 'follow' })).toEqual({ found: false });
  });
});

describe('probeActionButton is the post-click verification', () => {
  test('reads the flipped state after a follow', () => {
    header('<button>Following</button>');
    expect(probeActionButton(CFG)).toEqual({ found: true, state: 'following' });
  });

  test('reads the flipped state after an unfollow', () => {
    header('<button>Follow</button>');
    expect(probeActionButton(CFG)).toEqual({ found: true, state: 'follow' });
  });

  test('an empty-text control is skipped rather than claimed', () => {
    header('<button></button><button>Follow</button>');
    expect(probeActionButton(CFG)).toEqual({ found: true, state: 'follow' });
  });
});
