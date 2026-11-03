/**
 * The fixture scrubber's DOM pass: markup has no schema, so every construct
 * that can carry identity is rewritten through the scrubber's pseudonym tables.
 */

import { RESERVED_ROUTES, USERNAME_RE } from '@/surface/versions/2026-08-12/literals';

/** The host every scrubbed media URL points at — unresolvable by construction. */
export const SCRUBBED_URL_HOST = 'https://example.invalid';

/** The scrubber state the DOM pass reads and grows: the same tables a body scrub uses. */
export interface DomPseudonyms {
  handle(real: string): string;
  pk(real: string | number): string;
  /** Live: handles a pass discovers in its hrefs and alt text are rewritten everywhere after. */
  readonly handles: ReadonlyMap<string, string>;
  readonly names: ReadonlyMap<string, string>;
}

/**
 * Scrub a DOM snapshot. Markup has no schema, so the allow-list is expressed
 * the other way round: every construct that CAN carry identity is rewritten,
 * and the page's structure (classes, roles, aria-labels, inline styles — what
 * the control contract tests actually exercise) is left alone.
 *
 * Order matters: media URLs go first (they embed pks and signed tokens), then
 * hrefs and alt text (which is where handles are discovered), then a global
 * pass over every discovered handle, then long digit runs.
 */
export function scrubDom(html: string, t: DomPseudonyms): string {
  let out = html;

  // 1. Media: any Instagram CDN URL, in src / srcset / url(...) / plain text.
  out = out.replace(
    /https?:\/\/[^\s"'()<>]*(?:cdninstagram\.com|fbcdn\.net)[^\s"'()<>]*/g,
    (u) => `${SCRUBBED_URL_HOST}/pic/${t.pk(u.slice(0, 120))}.jpg`,
  );

  // 2. Profile hrefs — and the handle they name. The FIRST path segment is
  //    what carries the handle, and it is not always the last: Instagram
  //    ships deep links like `/<handle>/followers/mutualFirst`, which an
  //    end-anchored matcher walks straight past.
  out = out.replace(/href="\/([A-Za-z0-9._]{1,30})(\/[^"]*)?"/g, (whole, name: string) => {
    if (!USERNAME_RE.test(name) || RESERVED_ROUTES.has(name.toLowerCase())) return whole;
    return whole.replace(name, t.handle(name));
  });

  // 3. Avatar alt text: "<username>'s profile picture".
  out = out.replace(/alt="([A-Za-z0-9._]{1,30})('|&#39;|’)s profile/g, (whole, name: string) =>
    whole.replace(name, t.handle(name)),
  );

  // 4. Every handle discovered so far, wherever else it appears (text nodes,
  //    "@handle" mentions, aria-labels, title attributes).
  for (const [real, alias] of t.handles) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9._])${escapeRe(real)}(?![A-Za-z0-9._])`, 'gi'), alias);
  }

  // 5. Full names already pseudonymised from a body.
  for (const [real, alias] of t.names) {
    if (real.length < 3) continue;
    out = out.replace(new RegExp(escapeRe(real), 'g'), alias);
  }

  // 6. Any long digit run left is an id (media ids, pks, fbids). Class names
  //    and inline styles never carry one this long.
  out = out.replace(/\d{8,}/g, (d) => t.pk(d));

  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
