/** @jest-environment jsdom */
/**
 * The profile action button, against the DOM Instagram ACTUALLY SHIPPED.
 *
 * `tests/page/action-button.test.ts` exercises hand-written markup — what we
 * believe the header looks like. This exercises a scrubbed capture of the real
 * thing: obfuscated rotating class names, the state word wrapped three divs
 * deep inside the `<button>`, and a `Down chevron icon` svg beside it.
 *
 * The load-bearing case is the NEGATIVE at the bottom. ADR 0302 refuses a
 * document-wide fallback because a wider scope can press a DIFFERENT account's
 * Follow button and then "verify" against the same wrong button — a silent,
 * permanent corruption of the graph. That refusal is only worth anything if
 * something checks it against a page that really does carry other accounts'
 * Follow buttons.
 */

import type { ActionButtonCfg } from '@/adapter/page';
import { locateActionButton, probeActionButton } from '@/adapter/page';
import { surface } from '@/surface/index';
import { SELECTORS } from '@/surface/versions/2026-08-12/literals';
import { mountSnapshot, suggestionCarousel } from '../dom-kit';

/** Built from the DOCUMENT's descriptor, not re-typed — the point of controls-as-data. */
const descriptor = surface().controls['action-button'] as unknown as {
  sel: string;
  states: Array<[string, { source: string; flags: string }]>;
};

const CFG: ActionButtonCfg = {
  sel: descriptor.sel,
  rx: Object.fromEntries(descriptor.states) as ActionButtonCfg['rx'],
};

beforeEach(() => {
  mountSnapshot('profile-header-01.html');
});

describe('the real header', () => {
  test('the descriptor is the version module’s anchor, sourced from the document', () => {
    expect(CFG.sel).toBe(SELECTORS.profileActionButtonRole);
    expect(Object.keys(CFG.rx).sort()).toEqual(['follow', 'follow-back', 'following', 'requested']);
  });

  test('reads state `following` and would open the unfollow menu', () => {
    const res = locateActionButton({ ...CFG, op: 'unfollow' });
    expect(res).toMatchObject({
      found: true,
      state: 'following',
      wouldClick: true,
      needsConfirm: true,
    });
    // A degenerate rect would be pressed at viewport (0,0); the Actor's
    // `rectUsable` guard is what stops that, and it needs a real box here.
    expect(res.rect?.width).toBeGreaterThan(2);
    expect(res.rect?.height).toBeGreaterThan(2);
  });

  test('a follow op on an already-Following button is an idempotent no-op', () => {
    expect(locateActionButton({ ...CFG, op: 'follow' })).toMatchObject({
      found: true,
      state: 'following',
      wouldClick: false,
    });
  });

  test('the post-click probe reads the same button', () => {
    expect(probeActionButton(CFG)).toEqual({ found: true, state: 'following' });
  });

  test('appended icon alt text does not defeat the PREFIX matcher', () => {
    // Observed live: the button's textContent reads "FollowingDown chevron icon"
    // when the chevron ships a <title> instead of an aria-label.
    const svg = document.querySelector('header svg[aria-label="Down chevron icon"]');
    expect(svg).not.toBeNull();
    const title = document.createElement('title');
    title.textContent = 'Down chevron icon';
    svg?.appendChild(title);
    expect(document.querySelector('header button')?.textContent).toContain('FollowingDown');
    expect(locateActionButton({ ...CFG, op: 'unfollow' }).state).toBe('following');
  });
});

describe('the header anchor has no fallback tier (ADR 0302)', () => {
  test('a suggestion carousel appended to the page NEVER wins the anchor', () => {
    const before = locateActionButton({ ...CFG, op: 'unfollow' });
    document.body.insertAdjacentHTML('beforeend', suggestionCarousel());
    for (const el of Array.from(document.querySelectorAll('[role="region"] *'))) {
      el.getBoundingClientRect = (): DOMRect =>
        ({ x: 900, y: 900, left: 900, top: 900, right: 1000, bottom: 940, width: 100, height: 40, toJSON: () => ({}) }) as DOMRect;
    }

    // The carousel's buttons read "Follow" — exactly what a follow op hunts for.
    expect(document.querySelectorAll('[role="region"] button')).toHaveLength(2);
    const after = locateActionButton({ ...CFG, op: 'follow' });
    expect(after.state).toBe('following');
    expect(after.rect).toEqual(before.rect);
    expect(after.wouldClick).toBe(false);
  });

  test('with the header GONE the search fails loudly rather than finding a stranger', () => {
    document.querySelector('header')?.remove();
    document.body.insertAdjacentHTML('beforeend', suggestionCarousel());
    // No header ⇒ not found ⇒ the Actor throws AdapterStaleError. A widened
    // scope would instead return a stranger's Follow button and "succeed".
    expect(locateActionButton({ ...CFG, op: 'follow' })).toEqual({ found: false });
    expect(probeActionButton(CFG)).toEqual({ found: false, state: 'unknown' });
  });
});
