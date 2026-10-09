/**
 * Shared access to the committed contract corpus.
 *
 * Not a test file (`testPathIgnorePatterns` does not cover `tests/surface/`, so
 * this one is named without `.test.ts` and Jest leaves it alone).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusManifest } from '@/surface-lab/scrub-fixtures';

/** The LOCAL, git-ignored capture — real data, present only on a capture machine. */
export const LOCAL_CAPTURE_DIR = join(__dirname, '../../docs/adapter/fixtures');

/** The COMMITTED, scrubbed corpus. */
export const CORPUS_DIR = join(__dirname, '../fixtures/surface/2026-08-12');

export const hasCorpus = (): boolean => existsSync(join(CORPUS_DIR, 'manifest.json'));

export const manifest = (): CorpusManifest =>
  JSON.parse(readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8')) as CorpusManifest;

export const bodyText = (file: string): string =>
  readFileSync(join(CORPUS_DIR, 'bodies', file), 'utf8');

export const body = (file: string): unknown => JSON.parse(bodyText(file)) as unknown;

export const domText = (file: string): string =>
  readFileSync(join(CORPUS_DIR, 'dom', file), 'utf8');
