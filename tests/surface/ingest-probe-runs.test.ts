/**
 * Ingest the LOCAL probe runs into the committed 2026-11-02 corpus.
 *
 *   EPO_SCRUB=1 EPO_SCRUB_SOURCE=<probe runs dir> npx jest tests/surface/ingest-probe-runs
 *
 * Skipped by default and in CI: the probe bodies are real data outside the repo, read in place. The
 * ingested corpus must then pass `tests/surface/leak.test.ts` before it is committed — that is the gate.
 */

import { join } from 'node:path';
import { ingestProbeRuns, PROBE_CORPUS_DIR, probeRuns } from '@/surface-lab/probe-ingest';
import { PROBE_RUNS_DIR } from './corpus';

const ROOT = join(__dirname, '../..');
const enabled = process.env.EPO_SCRUB === '1' && probeRuns(PROBE_RUNS_DIR).length > 0;

describe('the ingester writes only the probe corpus directory', () => {
  test('any other output directory is refused before anything is read', () => {
    expect(() => ingestProbeRuns({ source: PROBE_RUNS_DIR, outDir: join(ROOT, 'tests/fixtures/surface/2026-08-12'),
      repoRoot: ROOT })).toThrow(/writes only/);
    expect(() => ingestProbeRuns({ source: PROBE_RUNS_DIR, outDir: join(ROOT, 'docs'), repoRoot: ROOT }))
      .toThrow(/writes only/);
  });
});

(enabled ? describe : describe.skip)('ingest the local probe runs into the committed corpus', () => {
  test('writes routed, scrubbed bodies and a manifest that replays', () => {
    const { manifest, wrote } = ingestProbeRuns({ source: PROBE_RUNS_DIR, outDir: join(ROOT, PROBE_CORPUS_DIR),
      repoRoot: ROOT });
    // eslint-disable-next-line no-console
    console.log(
      `ingested ${wrote.bodies} bodies; dropped=${manifest.dropped.length} ` +
        `missing=[${manifest.missing.join(',')}] unknownKeys=${manifest.stats.unknownKeys}`,
    );
    expect(wrote.bodies).toBeGreaterThan(0);
  });
});
