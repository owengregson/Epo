/**
 * What the LOCAL originals contain, and whether any of it survived.
 *
 * Two halves of the same safety property. The scrubber's pseudonym tables must
 * be PRESEEDED from the whole capture — a followers dialog names accounts whose
 * bodies the corpus never keeps, and an unseeded name walks straight through
 * the DOM pass. And after scrubbing, a residual check re-reads the output with
 * the originals in hand: if anything real survived, the fixture is DROPPED
 * rather than committed. The check names only the CLASS that survived, never
 * the value, so a drop reason is safe to record in a committed manifest.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRUB_POLICY } from '@/kernel/scrub-policy';

/** Every identifier the LOCAL originals carry — the residual check's needle set. */
export interface Originals {
  handles: Set<string>;
  names: Set<string>;
  pks: Set<string>;
}

/** The keys a handle, a display name or an id sits under, in any body the capture holds. */
const HANDLE_KEYS = new Set(['username', 'profile_name']);
const ID_KEYS = new Set(['pk', 'id', 'pk_id', 'strong_id__', 'fbid_v2', 'fbid', 'interop_messaging_user_fbid', 'profile_id']);
const ID_RE = /^\d{6,}$/;

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const emptyOriginals = (): Originals => ({ handles: new Set(), names: new Set(), pks: new Set() });

/** Add every username, display name and id one parsed body (or request variables object) carries. */
export function harvestValue(value: unknown, into: Originals): void {
  if (Array.isArray(value)) {
    for (const v of value) harvestValue(v, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (HANDLE_KEYS.has(key) && typeof v === 'string' && v !== '') into.handles.add(v.toLowerCase());
    if (key === 'full_name' && typeof v === 'string' && v.length >= SCRUB_POLICY.minNameChars) into.names.add(v);
    if (ID_KEYS.has(key) && (typeof v === 'string' || typeof v === 'number') && ID_RE.test(String(v))) {
      into.pks.add(String(v));
    }
    harvestValue(v, into);
  }
}

/** Handles and long ids a DOM snapshot names in its hrefs, alt text and digit runs. */
export function harvestHtml(html: string, into: Originals): void {
  for (const m of html.matchAll(/href="\/([A-Za-z0-9._]{1,30})(?:\/[^"]*)?"/g)) {
    const handle = (m[1] ?? '').toLowerCase();
    if (handle !== '') into.handles.add(handle);
  }
  for (const m of html.matchAll(/alt="([A-Za-z0-9._]{1,30})('|&#39;|’)s profile/g)) {
    into.handles.add((m[1] ?? '').toLowerCase());
  }
  for (const m of html.matchAll(/\d{8,}/g)) into.pks.add(m[0]);
}

/** Parse one capture file as JSON; a non-JSON artefact carries nothing to harvest. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Harvest every username, display name and pk the capture holds — from ALL raw
 * bodies, not just the ones the corpus keeps. A followers dialog names accounts
 * whose bodies were never picked, and the pseudonym table has to know them
 * BEFORE the DOM pass runs or those names walk straight through.
 */
export function harvestOriginals(sourceDir: string): Originals {
  const into = emptyOriginals();
  const rawDir = join(sourceDir, 'raw');
  if (existsSync(rawDir)) {
    for (const name of readdirSync(rawDir)) {
      if (name.endsWith('.json')) harvestValue(readJson(join(rawDir, name)), into);
    }
  }
  const domDir = join(sourceDir, 'dom');
  if (existsSync(domDir)) {
    for (const name of readdirSync(domDir)) harvestHtml(readFileSync(join(domDir, name), 'utf8'), into);
  }
  return into;
}

/** The CLASS of the first original identifier still present in `text`, or `null` (never the value itself). */
export function residual(text: string, originals: Originals): 'pk' | 'handle' | 'name' | null {
  const lower = text.toLowerCase();
  for (const pk of originals.pks) {
    if (lower.includes(pk)) return 'pk';
  }
  for (const handle of originals.handles) {
    if (handle.length < SCRUB_POLICY.minNameChars) continue;
    if (new RegExp(`(?<![a-z0-9._])${escapeRe(handle)}(?![a-z0-9._])`).test(lower)) return 'handle';
  }
  for (const name of originals.names) {
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.toLowerCase())}(?![\\p{L}\\p{N}])`, 'u').test(lower)) {
      return 'name';
    }
  }
  return null;
}
