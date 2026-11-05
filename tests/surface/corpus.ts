/**
 * Shared access to the committed contract corpora.
 *
 * Not a test file (`testPathIgnorePatterns` does not cover `tests/surface/`, so
 * this one is named without `.test.ts` and Jest leaves it alone).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusManifest } from '@/surface-lab/scrub-fixtures';

/** The LOCAL, git-ignored 2026-08-12 capture (`raw/*.json` + `dom/`): real data, on a capture machine only. */
export const LOCAL_CAPTURE_DIR = process.env.EPO_CAPTURE_DIR ?? join(__dirname, '../../docs/adapter/fixtures');

/** The LOCAL probe runs the 2026-11-02 corpus is ingested from (read in place, never copied). */
export const PROBE_RUNS_DIR = process.env.EPO_SCRUB_SOURCE ?? join(LOCAL_CAPTURE_DIR, 'raw', 'probe-verify-2026-11-02');

/** Every committed corpus, oldest first. */
export const CORPORA = ['2026-08-12', '2026-11-02', '2026-11-04'] as const;
export type CorpusId = (typeof CORPORA)[number];

/** A committed, scrubbed corpus directory. */
export const corpusDir = (id: CorpusId): string => join(__dirname, '../fixtures/surface', id);

/** The 2026-08-12 corpus (bodies and the DOM snapshots the control contract tests mount). */
export const CORPUS_DIR = corpusDir('2026-08-12');

export const hasCorpusAt = (id: CorpusId): boolean => existsSync(join(corpusDir(id), 'manifest.json'));
export const hasCorpus = (): boolean => hasCorpusAt('2026-08-12');

export const manifestOf = (id: CorpusId): CorpusManifest =>
  JSON.parse(readFileSync(join(corpusDir(id), 'manifest.json'), 'utf8')) as CorpusManifest;
export const manifest = (): CorpusManifest => manifestOf('2026-08-12');

export const bodyOf = (id: CorpusId, file: string): unknown =>
  JSON.parse(readFileSync(join(corpusDir(id), 'bodies', file), 'utf8')) as unknown;

export const bodyText = (file: string): string => readFileSync(join(CORPUS_DIR, 'bodies', file), 'utf8');

export const body = (file: string): unknown => JSON.parse(bodyText(file)) as unknown;

export const domText = (file: string): string => readFileSync(join(CORPUS_DIR, 'dom', file), 'utf8');
