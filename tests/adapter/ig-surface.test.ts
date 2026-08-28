/**
 * The stable surface contract: envelope handling (what `checkSeed` and the
 * enricher branch on) and the labelled signature / endpoint-id tables.
 */
import {
  SURFACE,
  asFetchEnvelope,
  classifyEnvelope,
  envelopeLooksLikeHtml,
  type FetchEnvelope,
} from '@/adapter/ig-surface';
import { TAB } from '@/timing/config';

describe('asFetchEnvelope', () => {
  test('accepts a well-formed envelope', () => {
    const env = asFetchEnvelope({ ok: true, status: 200, contentType: 'application/json', json: {} });
    expect(env).not.toBeNull();
    expect(env!.ok).toBe(true);
  });

  test('rejects non-envelope evaluate results (raw bodies, null, primitives)', () => {
    expect(asFetchEnvelope(null)).toBeNull();
    expect(asFetchEnvelope(undefined)).toBeNull();
    expect(asFetchEnvelope('<!DOCTYPE html>')).toBeNull();
    expect(asFetchEnvelope({ data: { user: {} } })).toBeNull(); // a raw IG body, not an envelope
    expect(asFetchEnvelope({ ok: 'yes', status: 200, contentType: '' })).toBeNull();
  });
});

describe('envelopeLooksLikeHtml', () => {
  const env = (contentType: string, textHead?: string): FetchEnvelope => ({
    ok: false,
    status: 429,
    contentType,
    textHead,
  });

  test('true for a text/html content type (an IG wall page)', () => {
    expect(envelopeLooksLikeHtml(env('text/html; charset=utf-8', 'Please wait'))).toBe(true);
  });

  test('true when the body head starts with a tag even without a content type', () => {
    expect(envelopeLooksLikeHtml(env('', '  <!DOCTYPE html><html>'))).toBe(true);
  });

  test('false for a JSON error body', () => {
    expect(envelopeLooksLikeHtml(env('application/json', '{"message":"checkpoint_required"}'))).toBe(false);
  });
});

describe('SURFACE endpoint ids (folds the old duplicated URL regexes)', () => {
  test('friendship-show URLs yield the subject pk', () => {
    expect(
      SURFACE.extractIds(
        'friendship-show',
        'https://i.instagram.com/api/v1/friendships/show/17841400000/',
      ).pk,
    ).toBe('17841400000');
  });

  test('followers-list URLs yield the target pk', () => {
    expect(
      SURFACE.extractIds(
        'followers-list',
        'https://www.instagram.com/api/v1/friendships/17841400000/followers/?count=12',
      ).targetPk,
    ).toBe('17841400000');
  });

  test('non-matching URLs yield no ids', () => {
    expect(SURFACE.extractIds('friendship-show', 'https://example.com/')).toEqual({});
    expect(SURFACE.extractIds('show-many', 'https://example.com/')).toEqual({});
  });
});

describe('SURFACE labelled block signatures (replaces the positional contract)', () => {
  test('the login redirect is labelled logged-out; interstitials are challenge', () => {
    const statusFor = (url: string) =>
      SURFACE.blockSignatures.find((sig) => sig.pattern.test(url))?.status;
    expect(statusFor('https://www.instagram.com/accounts/login/?next=/')).toBe('logged-out');
    expect(statusFor('https://www.instagram.com/challenge/?next=/')).toBe('challenge');
    expect(statusFor('https://www.instagram.com/accounts/suspended/')).toBe('challenge');
    expect(statusFor('https://www.instagram.com/someone/')).toBeUndefined();
  });

  test('every text signature labels action-blocked', () => {
    expect(SURFACE.textSignatures.length).toBeGreaterThan(0);
    for (const sig of SURFACE.textSignatures) {
      expect(sig.status).toBe('action-blocked');
    }
  });
});

describe('SURFACE envelope fetch scripts are abort-bounded', () => {
  test('every in-page fetch carries AbortSignal.timeout matching TAB.FETCH_ABORT_MS', () => {
    // The literal is inlined in the versions file (page scripts cannot
    // import); this pins it to the registry value so the two never drift.
    const scripts = [
      SURFACE.profileInfoScript('someone'),
      SURFACE.currentUserScript(),
      SURFACE.friendshipShowScript('17841400000'),
      SURFACE.listPageScript('17841400000', 'followers', null),
    ];
    for (const script of scripts) {
      expect(script).toContain(`AbortSignal.timeout(${TAB.FETCH_ABORT_MS})`);
    }
  });
});

describe('classifyEnvelope — the recovery ladder’s read-side failure families', () => {
  const env = (over: Partial<FetchEnvelope>): FetchEnvelope => ({
    ok: false,
    status: 200,
    contentType: 'application/json',
    ...over,
  });

  test('a 2xx JSON envelope is ok', () => {
    expect(classifyEnvelope(env({ ok: true }))).toEqual({ kind: 'ok' });
  });

  test('HTTP 429 and 5xx are rate-limited', () => {
    expect(classifyEnvelope(env({ status: 429 })).kind).toBe('rate-limited');
    expect(classifyEnvelope(env({ status: 500 })).kind).toBe('rate-limited');
    expect(classifyEnvelope(env({ status: 503 })).kind).toBe('rate-limited');
  });

  test('a finalUrl matching a logged-out/challenge wall is auth (with the wall status)', () => {
    expect(
      classifyEnvelope(env({ status: 200, finalUrl: 'https://www.instagram.com/accounts/login/?next=/' })),
    ).toEqual({ kind: 'auth', wall: 'logged-out' });
    expect(
      classifyEnvelope(env({ status: 200, finalUrl: 'https://www.instagram.com/challenge/?next=/' })),
    ).toEqual({ kind: 'auth', wall: 'challenge' });
  });

  test('an HTML wall where an API body belongs is rate-limited', () => {
    expect(
      classifyEnvelope(env({ status: 200, contentType: 'text/html', textHead: '<!DOCTYPE html>' })).kind,
    ).toBe('rate-limited');
    // Even a 404 wrapped in an HTML page is the wall, not a missing resource.
    expect(
      classifyEnvelope(env({ status: 404, contentType: 'text/html', textHead: '<html>' })).kind,
    ).toBe('rate-limited');
  });

  test('a JSON 404 is gone; status 0 is network; an unknown refusal is drift-suspect', () => {
    expect(classifyEnvelope(env({ status: 404 })).kind).toBe('gone');
    expect(classifyEnvelope(env({ status: 0, contentType: '', textHead: 'TypeError: failed' })).kind).toBe(
      'network',
    );
    expect(classifyEnvelope(env({ status: 403 })).kind).toBe('drift-suspect');
  });
});
