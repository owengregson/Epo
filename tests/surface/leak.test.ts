/**
 * The corpora must not leak. This is the gate that lets them be committed at all.
 *
 * Risk #3 of the surface design: "a committed corpus with a missed field is
 * permanent and public". So the check runs in two layers, and the STRONGER one
 * needs no access to the originals:
 *
 *  1. STRUCTURAL (always, including CI). Every committed byte of every corpus is
 *     held to the rules of `src/surface/lab/structural-leak.ts`: no Instagram
 *     media URL, no cookie or token, no `@handle` or profile href that is not a
 *     pseudonym, no long digit run outside the synthetic id and time ranges.
 *     The same rules check every sample the production sink stores.
 *
 *  2. DIFFERENTIAL (only where the git-ignored originals exist). Every username,
 *     full name and id in the LOCAL capture and probe runs is asserted absent
 *     from every corpus — the direct form of the check, run on the machine that
 *     regenerates a corpus, i.e. exactly where a new leak is created.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { structuralLeaks } from '@/surface/lab/structural-leak';
import { RESERVED_ROUTES } from '@/surface/versions/2026-08-12/literals';
import { harvestOriginals, residual } from '@/surface-lab/originals';
import { harvestProbeOriginals } from '@/surface-lab/probe-ingest';
import { REPLAY_AT } from '@/surface-lab/scrub-fixtures';
import { CORPORA, corpusDir, hasCorpusAt, LOCAL_CAPTURE_DIR, PROBE_RUNS_DIR } from './corpus';

/** Every committed file of every corpus, as `[corpus/relative path, text]`. */
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
  for (const id of CORPORA) walk(corpusDir(id), `${id}/`);
  return out;
}

describe('the committed corpora carry no real identity', () => {
  test.each([...CORPORA])('the %s corpus exists', (id) => {
    expect(hasCorpusAt(id)).toBe(true);
  });

  const files = corpusFiles();

  test.each(files.map(([name]) => name))('%s breaks no structural leak rule', (name) => {
    const text = files.find(([n]) => n === name)?.[1] ?? '';
    // The manifests stamp the fixed replay clock: the corpus's own constant, not an observed value.
    expect(structuralLeaks(text, [String(REPLAY_AT)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Differential layer — runs where the git-ignored originals exist.
// ---------------------------------------------------------------------------

const capture = existsSync(join(LOCAL_CAPTURE_DIR, 'raw'));
const probes = existsSync(PROBE_RUNS_DIR);

(capture || probes ? describe : describe.skip)('no original identifier survives into any corpus', () => {
  test('no original username, full name or id appears anywhere in the corpora', () => {
    const originals = capture ? harvestOriginals(LOCAL_CAPTURE_DIR) : harvestProbeOriginals(PROBE_RUNS_DIR);
    if (capture && probes) {
      const more = harvestProbeOriginals(PROBE_RUNS_DIR);
      for (const h of more.handles) originals.handles.add(h);
      for (const n of more.names) originals.names.add(n);
      for (const p of more.pks) originals.pks.add(p);
    }
    // A reserved route (`/explore/`) is page structure the DOM snapshots keep, not a handle.
    for (const h of [...originals.handles]) if (RESERVED_ROUTES.has(h)) originals.handles.delete(h);
    expect(originals.handles.size).toBeGreaterThan(0);
    // Only the CLASS of a survivor is reported, so a failure never prints the value it found.
    const survivors = corpusFiles()
      .map(([name, text]) => [name, residual(text, originals)] as const)
      .filter(([, found]) => found !== null);
    expect(survivors).toEqual([]);
  });
});
