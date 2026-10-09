/**
 * Regenerate the committed contract corpus from the LOCAL capture.
 *
 *   EPO_SCRUB=1 npx jest tests/surface/scrub-fixtures
 *
 * Skipped by default and in CI: `docs/adapter/fixtures/` is git-ignored real
 * data and only exists on a machine that has run `npm run capture`. The
 * regenerated corpus must then pass `tests/surface/leak.test.ts` before it is
 * committed — that is the gate, not this.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scrubFixtures } from '@/surface-lab/scrub-fixtures';
import { CORPUS_DIR, LOCAL_CAPTURE_DIR } from './corpus';

const enabled = process.env.EPO_SCRUB === '1' && existsSync(join(LOCAL_CAPTURE_DIR, 'raw'));

(enabled ? describe : describe.skip)('scrub the local capture into the committed corpus', () => {
  test('writes bodies, DOM snapshots and a manifest that replays', () => {
    const { manifest, wrote } = scrubFixtures({
      sourceDir: LOCAL_CAPTURE_DIR,
      outDir: CORPUS_DIR,
    });
    // eslint-disable-next-line no-console
    console.log(
      `scrubbed ${wrote.bodies} bodies + ${wrote.dom} DOM snapshots; ` +
        `handles=${manifest.stats.handles} pks=${manifest.stats.pks} ` +
        `unknownKeys=${manifest.stats.unknownKeys} missing=[${manifest.missing.join(',')}]`,
    );
    expect(wrote.bodies).toBeGreaterThan(0);
  });
});
