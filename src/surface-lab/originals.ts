/**
 * What the LOCAL originals contain, and whether any of it survived.
 *
 * Two halves of the same safety property. The scrubber's pseudonym tables must
 * be PRESEEDED from the whole capture — a followers dialog names accounts whose
 * bodies the corpus never keeps, and an unseeded name walks straight through
 * the DOM pass. And after scrubbing, a residual check re-reads the output with
 * the originals in hand: if anything real survived, the fixture is DROPPED
 * rather than committed. "If you cannot guarantee a field is scrubbed, drop the
 * fixture" is a rule the pipeline enforces, not one a reviewer remembers.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every identifier the LOCAL originals carry — the residual check's needle set. */
export interface Originals {
  handles: Set<string>;
  names: Set<string>;
  pks: Set<string>;
}

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Harvest every username, display name and pk the capture holds — from ALL raw
 * bodies, not just the ones the corpus keeps. A followers dialog names accounts
 * whose bodies were never picked, and the pseudonym table has to know them
 * BEFORE the DOM pass runs or those names walk straight through.
 */
export function harvestOriginals(sourceDir: string): Originals {
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
      if ((key === 'username' || key === 'profile_name') && typeof v === 'string' && v !== '') {
        handles.add(v.toLowerCase());
      }
      if (key === 'full_name' && typeof v === 'string' && v.length >= 3) names.add(v);
      if (
        (key === 'pk' || key === 'id' || key === 'pk_id' || key === 'profile_id') &&
        (typeof v === 'string' || typeof v === 'number') &&
        /^\d{6,}$/.test(String(v))
      ) {
        pks.add(String(v));
      }
      visit(v);
    }
  };

  const rawDir = join(sourceDir, 'raw');
  if (existsSync(rawDir)) {
    for (const name of readdirSync(rawDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        visit(JSON.parse(readFileSync(join(rawDir, name), 'utf8')));
      } catch {
        // a non-JSON capture artefact carries nothing to harvest
      }
    }
  }
  const domDir = join(sourceDir, 'dom');
  if (existsSync(domDir)) {
    for (const name of readdirSync(domDir)) {
      const html = readFileSync(join(domDir, name), 'utf8');
      for (const m of html.matchAll(/href="\/([A-Za-z0-9._]{1,30})(?:\/[^"]*)?"/g)) {
        const handle = (m[1] ?? '').toLowerCase();
        if (handle !== '') handles.add(handle);
      }
      for (const m of html.matchAll(/alt="([A-Za-z0-9._]{1,30})('|&#39;|\u2019)s profile/g)) {
        handles.add((m[1] ?? '').toLowerCase());
      }
      for (const m of html.matchAll(/\d{8,}/g)) pks.add(m[0]);
    }
  }
  return { handles, names, pks };
}

/** The first original identifier still present in `text`, or `null`. */
export function residual(text: string, originals: Originals): string | null {
  const lower = text.toLowerCase();
  for (const pk of originals.pks) {
    if (lower.includes(pk)) return `pk ${pk}`;
  }
  for (const handle of originals.handles) {
    if (handle.length < 3) continue;
    if (new RegExp(`(?<![a-z0-9._])${escapeRe(handle)}(?![a-z0-9._])`).test(lower)) {
      return `handle ${handle}`;
    }
  }
  for (const name of originals.names) {
    if (name.length < 3) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(lower)) {
      return `name ${name.slice(0, 3)}…`;
    }
  }
  return null;
}
