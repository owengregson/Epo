/**
 * List continuation (spec §10.4): what one page says about the rest of the list, read from the
 * declared cursor keys and more-flags in a fixed rule order. Version-agnostic: keys are injected.
 */

import type { ContinuationDecl } from '@/surface/schema/decls';
import type { Continuation, NormalizeStep } from '@/surface/schema/projection';

export type { ContinuationDecl } from '@/surface/schema/decls';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A container's keys; an array contributes its rows' keys. */
const entriesOf = (v: unknown): Array<[string, unknown]> =>
  isRecord(v) ? Object.entries(v) : Array.isArray(v) ? v.flatMap((row) => (isRecord(row) ? Object.entries(row) : [])) : [];

/** Whether a container holds a cursor-named key on its own level or the one below. */
function holdsCursorKey(v: unknown, decl: ContinuationDecl): boolean {
  const named = (k: string): boolean => decl.cursorKeys.includes(k) || decl.cursorName.test(k);
  return entriesOf(v).some(([k, child]) => named(k) || entriesOf(child).some(([k2]) => named(k2)));
}

/** The first unexplained root key whose value could be a cursor or a "more" claim. */
function vetoKeyOf(page: Record<string, unknown>, decl: ContinuationDecl): string | undefined {
  const explained = new Set([...decl.cursorKeys, ...decl.moreFlags, ...decl.explainedPageKeys]);
  for (const [key, v] of Object.entries(page)) {
    if (explained.has(key)) continue;
    const cursorLike = (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v))
      || (v === true && decl.moreFlagName.test(key)) || ((isRecord(v) || Array.isArray(v)) && holdsCursorKey(v, decl));
    if (cursorLike) return key;
  }
  return undefined;
}

/**
 * The page's continuation, by these rules in order: a non-final stream is drift; a cursor
 * continues; no cursor with a more-flag set is drift; no cursor with flags all false is an end
 * on the server flags; no cursor and no flags is an end without evidence.
 */
export function continuationOf(
  page: Record<string, unknown>,
  decl: ContinuationDecl,
  opts: { final: boolean | null },
): { continuation: Continuation; steps: NormalizeStep[] } {
  const steps: NormalizeStep[] = [];
  if (opts.final === false) return { continuation: { kind: 'drift', reason: 'incomplete-stream' }, steps };
  const next = (cursor: string): Continuation => ({
    kind: 'next', cursor, form: decl.offsetCursor.test(cursor) ? 'offset' : 'opaque',
  });
  for (const key of decl.cursorKeys) {
    const v = page[key];
    if (typeof v === 'string' && v !== '') return { continuation: next(v), steps };
    if (typeof v === 'number' && Number.isSafeInteger(v)) {
      steps.push({ kind: 'retype', at: key, detail: 'number' });
      return { continuation: next(String(v)), steps };
    }
  }
  const flags = decl.moreFlags.filter((k) => typeof page[k] === 'boolean');
  const more = flags.find((k) => page[k] === true);
  if (more !== undefined) return { continuation: { kind: 'drift', reason: 'more-without-cursor', key: more }, steps };
  const vetoKey = vetoKeyOf(page, decl);
  const evidence = flags.length > 0 ? 'flags-false' : 'no-flags';
  return { continuation: { kind: 'end', evidence, ...(vetoKey === undefined ? {} : { vetoKey }) }, steps };
}
