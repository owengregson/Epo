/**
 * The corpus must not leak. This is the gate that lets it be committed at all.
 *
 * Risk #3 of the surface design: "a committed corpus with a missed field is
 * permanent and public". So the check runs in two layers, and the STRONGER one
 * needs no access to the originals:
 *
 *  1. STRUCTURAL (always, including CI). Every committed byte is checked against
 *     the shapes identity takes: an Instagram CDN URL, a cookie/token name, an
 *     `@handle` that is not a pseudonym, a profile href that is not a
 *     pseudonym, a long digit run outside the synthetic pk range. If the
 *     scrubber ever misses a field, one of these fires — without the test
 *     itself having to carry a list of real handles (which would be the leak).
 *
 *  2. DIFFERENTIAL (only where the git-ignored capture exists). Every username,
 *     full name and pk in the LOCAL originals is asserted absent from the
 *     corpus. This is the direct form of the check and it runs on the machine
 *     that regenerates the corpus — i.e. exactly where a new leak is created.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRUBBED_URL_HOST, SYNTHETIC_PK_BASE } from '@/surface/lab/scrub';
import { RESERVED_ROUTES } from '@/surface/versions/2026-08-12/literals';
import { REPLAY_AT } from '@/surface-lab/scrub-fixtures';
import { CORPUS_DIR, hasCorpus, LOCAL_CAPTURE_DIR } from './corpus';

/** Every committed corpus file, as `[relative path, text]`. */
function corpusFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path, `${prefix}${name.name}/`);
      else out.push([`${prefix}${name.name}`, readFileSync(path, 'utf8')]);
    }
  };
  walk(CORPUS_DIR, '');
  return out;
}

const PSEUDO_HANDLE = /^user_[a-z]\d+$/;

describe('the committed corpus carries no real identity', () => {
  test('the corpus exists (regenerate with EPO_SCRUB=1 npx jest tests/surface/scrub-fixtures)', () => {
    expect(hasCorpus()).toBe(true);
  });

  const files = hasCorpus() ? corpusFiles() : [];

  test.each(files.map(([name]) => name))('%s carries no Instagram media URL', (name) => {
    const text = files.find(([n]) => n === name)?.[1] ?? '';
    expect(text).not.toMatch(/cdninstagram\.com|fbcdn\.net|scontent[-.]/i);
    // Every media reference must point at the unresolvable placeholder host.
    for (const url of text.match(/https?:\/\/[^\s"'()<>\\]+/g) ?? []) {
      expect(url.startsWith(SCRUBBED_URL_HOST)).toBe(true);
    }
  });

  test.each(files.map(([name]) => name))('%s carries nothing cookie-shaped', (name) => {
    const text = files.find(([n]) => n === name)?.[1] ?? '';
    expect(text).not.toMatch(
      /\b(sessionid|csrftoken|ds_user_id|mid|ig_did|rur|shbid|shbts|authorization|bearer|x-ig-www-claim)\b/i,
    );
    // A long opaque token (32+ chars of base64/hex) is exactly the shape a
    // session cookie takes; nothing the corpus needs looks like that.
    expect(text).not.toMatch(/\b[A-Za-z0-9+/=_-]{40,}\b/);
  });

  test.each(files.map(([name]) => name))('%s carries no real @handle', (name) => {
    const text = files.find(([n]) => n === name)?.[1] ?? '';
    for (const raw of text.match(/@[A-Za-z0-9._]{2,30}/g) ?? []) {
      expect(raw.slice(1)).toMatch(PSEUDO_HANDLE);
    }
    // Profile hrefs are the other place a handle lives — and the handle is the
    // FIRST path segment, which a deep link (`/x/followers/mutualFirst`) hides
    // behind more segments.
    for (const m of text.matchAll(/href="\/([A-Za-z0-9._]{1,30})(?:\/[^"]*)?"/g)) {
      const handle = m[1] ?? '';
      if (handle === '' || RESERVED_ROUTES.has(handle.toLowerCase())) continue;
      expect(handle).toMatch(PSEUDO_HANDLE);
    }
  });

  test.each(files.map(([name]) => name))('%s carries no id outside the synthetic range', (name) => {
    const text = files.find(([n]) => n === name)?.[1] ?? '';
    const offenders = (text.match(/\d{8,}/g) ?? []).filter((d) => {
      const synthetic =
        d.length === 12 && Number(d) >= SYNTHETIC_PK_BASE && Number(d) < SYNTHETIC_PK_BASE + 1e6;
      // The manifest stamps the fixed replay clock; it is the corpus's own
      // constant, not an observed id.
      return !synthetic && d !== String(REPLAY_AT);
    });
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Differential layer — runs where the git-ignored originals exist.
// ---------------------------------------------------------------------------

const localRaw = join(LOCAL_CAPTURE_DIR, 'raw');
const localDom = join(LOCAL_CAPTURE_DIR, 'dom');
const differential = hasCorpus() && existsSync(localRaw);

(differential ? describe : describe.skip)('no original identifier survives into the corpus', () => {
  /** Usernames, full names and pks harvested from the LOCAL originals. */
  const originals = (): { handles: Set<string>; names: Set<string>; pks: Set<string> } => {
    const handles = new Set<string>();
    const names = new Set<string>();
    const pks = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const v of value) visit(v);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'username' && typeof v === 'string' && v !== '') handles.add(v.toLowerCase());
        if (key === 'full_name' && typeof v === 'string' && v.length >= 3) names.add(v);
        if ((key === 'pk' || key === 'id' || key === 'pk_id') && (typeof v === 'string' || typeof v === 'number')) {
          if (/^\d{6,}$/.test(String(v))) pks.add(String(v));
        }
        visit(v);
      }
    };
    for (const name of readdirSync(localRaw)) {
      if (!name.endsWith('.json')) continue;
      try {
        visit(JSON.parse(readFileSync(join(localRaw, name), 'utf8')));
      } catch {
        // a non-JSON capture artefact: nothing to harvest
      }
    }
    if (existsSync(localDom)) {
      for (const name of readdirSync(localDom)) {
        const html = readFileSync(join(localDom, name), 'utf8');
        for (const m of html.matchAll(/href="\/([A-Za-z0-9._]{1,30})(?:\/[^"]*)?"/g)) {
          const handle = (m[1] ?? '').toLowerCase();
          if (handle !== '' && !RESERVED_ROUTES.has(handle)) handles.add(handle);
        }
        for (const m of html.matchAll(/alt="([A-Za-z0-9._]{1,30})('|&#39;|’)s profile/g)) {
          handles.add((m[1] ?? '').toLowerCase());
        }
        for (const m of html.matchAll(/\d{8,}/g)) pks.add(m[0]);
      }
    }
    return { handles, names, pks };
  };

  test('no original username, full name or pk appears anywhere in the corpus', () => {
    const { handles, names, pks } = originals();
    expect(handles.size).toBeGreaterThan(0);
    const blob = corpusFiles()
      .map(([, text]) => text)
      .join('\n')
      .toLowerCase();

    const leakedHandles = [...handles].filter(
      (h) => h.length >= 3 && new RegExp(`(?<![a-z0-9._])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9._])`).test(blob),
    );
    expect(leakedHandles).toEqual([]);

    const leakedNames = [...names].filter((n) => blob.includes(n.toLowerCase()));
    expect(leakedNames).toEqual([]);

    const leakedPks = [...pks].filter((pk) => blob.includes(pk));
    expect(leakedPks).toEqual([]);
  });
});
