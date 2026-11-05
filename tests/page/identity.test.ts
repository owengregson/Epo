/** @jest-environment jsdom */
/**
 * The nav profile-avatar link — how the app learns whose account it drives.
 *
 * Getting this wrong is expensive: the resolved username anchors the whole
 * knowledge graph, so a profile link belonging to someone ELSE (a feed post's
 * author link, a suggestion card) must never win over the rail's own avatar.
 */

import type { ProfileLinkCfg } from '@/adapter/page';
import { clickProfileLink, locateProfileLink, readAvatarAlt, readProfileHref } from '@/adapter/page';
import { box, mount, rx } from '../kit/adapter-dom';

const NAV_ONLY: ProfileLinkCfg = {
  profilePathRx: rx(/^\/[A-Za-z0-9._]+\/$/),
  scopes: ['nav', '[role="navigation"]'],
};
const NAV_THEN_BODY: ProfileLinkCfg = { ...NAV_ONLY, scopes: [...NAV_ONLY.scopes, 'body'] };

const AVATAR_SEL = 'img[alt*="profile picture"], img[alt*="profile photo"]';

describe('readProfileHref', () => {
  test('returns the nav avatar anchor’s bare profile path', () => {
    mount(`
      <nav>
        <a href="/explore/">Explore</a>
        <a href="/myuser/"><img alt="myuser's profile picture"></a>
      </nav>
    `);
    expect(readProfileHref(NAV_THEN_BODY)).toBe('/myuser/');
  });

  test('an anchor WITHOUT an avatar image is not the profile link', () => {
    // The rail's text links point at routes, not at us.
    mount('<nav><a href="/myuser/">Profile</a></nav>');
    expect(readProfileHref(NAV_THEN_BODY)).toBeNull();
  });

  test('a nested path is not a bare profile path', () => {
    mount('<nav><a href="/myuser/saved/"><img alt="x"></a></nav>');
    expect(readProfileHref(NAV_THEN_BODY)).toBeNull();
  });

  test('the nav is searched before the body — a post author never wins', () => {
    mount(`
      <main><article><a href="/otheruser/"><img alt="otheruser's profile picture"></a></article></main>
      <nav><a href="/myuser/"><img alt="myuser's profile picture"></a></nav>
    `);
    expect(readProfileHref(NAV_THEN_BODY)).toBe('/myuser/');
  });

  test('with no nav at all the body is the last resort', () => {
    mount('<main><a href="/myuser/"><img alt="myuser\'s profile picture"></a></main>');
    expect(readProfileHref(NAV_THEN_BODY)).toBe('/myuser/');
  });
});

describe('locateProfileLink', () => {
  test('reports the anchor’s rect for the Interactor to press', () => {
    mount('<nav><a href="/myuser/" id="a"><img alt="myuser\'s profile picture"></a></nav>');
    box(document.getElementById('a') as Element, { x: 16, y: 520, width: 220, height: 48 });
    expect(locateProfileLink(NAV_THEN_BODY)).toEqual({
      found: true,
      rect: { x: 16, y: 520, width: 220, height: 48 },
    });
  });

  test('an un-hydrated rail is found:false, not an error', () => {
    mount('<nav></nav>');
    expect(locateProfileLink(NAV_THEN_BODY)).toEqual({ found: false });
  });
});

describe('clickProfileLink (the identity resolver’s own synthetic click)', () => {
  test('presses the nav avatar anchor and reports it', () => {
    mount('<nav><a href="/myuser/" id="a"><img alt="myuser\'s profile picture"></a></nav>');
    let clicks = 0;
    (document.getElementById('a') as HTMLElement).addEventListener('click', () => {
      clicks += 1;
    });
    expect(clickProfileLink(NAV_ONLY)).toBe(true);
    expect(clicks).toBe(1);
  });

  test('scoped to the nav ONLY — a body profile link is never clicked', () => {
    mount('<main><a href="/otheruser/"><img alt="otheruser\'s profile picture"></a></main>');
    expect(clickProfileLink(NAV_ONLY)).toBe(false);
  });
});

describe('readAvatarAlt', () => {
  test('returns the RAW alt text (the username is parsed main-process side)', () => {
    mount('<nav><img alt="myuser\'s profile picture"></nav>');
    expect(readAvatarAlt({ sel: AVATAR_SEL })).toBe("myuser's profile picture");
  });

  test('the "profile photo" wording is accepted too', () => {
    mount('<nav><img alt="myuser\'s profile photo"></nav>');
    expect(readAvatarAlt({ sel: AVATAR_SEL })).toBe("myuser's profile photo");
  });

  test('no avatar yields null', () => {
    mount('<nav><img alt="Instagram"></nav>');
    expect(readAvatarAlt({ sel: AVATAR_SEL })).toBeNull();
  });
});
