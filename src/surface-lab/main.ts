/**
 * `surface-lab` — one tool, five subcommands.
 *
 *   node dist/surface-lab/main.js <capture|inspect|smoke|replay|diff>
 *
 * `src/capture/**`, `src/livetest/**` and `src/inspect/**` were three separate
 * Electron apps with three npm scripts, three esbuild entries and three copies
 * of the same open-window / await-login / dispose sequence. They are still the
 * implementations — this is the front door. The three original entry points
 * keep working unchanged (and so do their esbuild entries and npm scripts), so
 * consolidation costs nothing to roll back.
 *
 * | subcommand | needs Electron | what it is                                   |
 * |------------|----------------|----------------------------------------------|
 * | `capture`  | yes            | passive capture of real responses + DOM      |
 * | `inspect`  | yes            | click-to-capture element instrumentation     |
 * | `smoke`    | yes            | the live action test (`npm run livetest`)    |
 * | `replay`   | no             | re-parse the committed corpora (CI-runnable) |
 * | `diff`     | no             | corpus shape digest vs the schemas           |
 * | `ingest`   | no             | scrub local probe runs into the 2026-11-02 corpus (`EPO_SCRUB_SOURCE`) |
 *
 * The two that need no Electron are the point: they run under plain Node (and
 * under Jest, which is where CI actually runs them), so the contract the corpus
 * encodes is checkable without a browser or a session.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { surface } from '@/surface/index';
import { readResponse } from '@/surface/parse';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { diffEndpoint } from '@/surface-lab/digest';
import { ingestProbeRuns, PROBE_CORPUS_DIR } from '@/surface-lab/probe-ingest';
import type { CorpusManifest } from '@/surface-lab/scrub-fixtures';

export type Subcommand = 'capture' | 'inspect' | 'smoke' | 'replay' | 'diff' | 'ingest';

const SUBCOMMANDS: readonly Subcommand[] = ['capture', 'inspect', 'smoke', 'replay', 'diff', 'ingest'];

const isSubcommand = (value: string): value is Subcommand =>
  (SUBCOMMANDS as readonly string[]).includes(value);

/** Where the committed corpora live, relative to the repo root. */
const CORPORA_ROOT = (): string => join(process.cwd(), 'tests/fixtures/surface');

/** Every committed corpus (one directory per capture, each with its manifest), oldest first. */
function loadManifests(): Array<{ dir: string; manifest: CorpusManifest }> {
  const root = CORPORA_ROOT();
  if (!existsSync(root)) return [];
  return readdirSync(root).sort()
    .map((id) => join(root, id))
    .filter((dir) => existsSync(join(dir, 'manifest.json')))
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as CorpusManifest }));
}

/** Re-parse every committed body of every corpus through the active surface. Returns the failures. */
export function replay(): { checked: number; failures: string[] } {
  const corpora = loadManifests();
  if (corpora.length === 0) return { checked: 0, failures: ['no committed corpus'] };
  const doc = surface();
  const failures: string[] = [];
  let checked = 0;

  for (const loaded of corpora) for (const entry of loaded.manifest.bodies) {
    checked += 1;
    const endpoint = doc.endpoints.find((e) => e.kind === entry.endpoint);
    if (endpoint === undefined) {
      failures.push(`${entry.file}: no endpoint for ${entry.endpoint}`);
      continue;
    }
    const body: unknown = JSON.parse(
      readFileSync(join(loaded.dir, 'bodies', entry.file), 'utf8'),
    );
    const result = readResponse(endpoint, body, {
      at: loaded.manifest.replayAt,
      source: entry.source,
      pk: entry.pk,
    });
    if (!result.ok) {
      failures.push(`${entry.file}: ${result.issues.map((i) => `${i.path} — ${i.message}`).join('; ')}`);
      continue;
    }
    const got = {
      facts: result.projection.facts.length,
      cursor: result.projection.cursor,
      hasMore: result.projection.hasMore,
    };
    const want = {
      facts: entry.expect.facts,
      cursor: entry.expect.cursor,
      hasMore: entry.expect.hasMore,
    };
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${entry.file}: projected ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
  return { checked, failures };
}

/** Compare the corpora's observed shapes against the schemas. */
export function diff(): string[] {
  const corpora = loadManifests();
  if (corpora.length === 0) return ['no committed corpus'];
  const byEndpoint = new Map<EndpointKind, unknown[]>();
  for (const loaded of corpora) for (const entry of loaded.manifest.bodies) {
    const bucket = byEndpoint.get(entry.endpoint) ?? [];
    bucket.push(JSON.parse(readFileSync(join(loaded.dir, 'bodies', entry.file), 'utf8')));
    byEndpoint.set(entry.endpoint, bucket);
  }
  const lines: string[] = [];
  for (const [endpoint, bodies] of byEndpoint) {
    const findings = diffEndpoint(endpoint, bodies);
    lines.push(`${endpoint}: ${bodies.length} bodies, ${findings.length} findings`);
    for (const f of findings) lines.push(`  ${f.kind.padEnd(18)} ${f.path} — ${f.detail}`);
  }
  const covered = new Set(byEndpoint.keys());
  for (const missing of new Set(corpora.flatMap((c) => c.manifest.missing))) {
    if (!covered.has(missing)) lines.push(`${missing}: NO BODY IN THE CORPUS — this endpoint is unverified`);
  }
  return lines;
}

/** How many raw bodies the LOCAL (git-ignored) capture holds, for `capture`'s summary. */
export const localCaptureSize = (dir: string): number =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).length : 0;

function usage(): void {
  process.stdout.write(
    `surface-lab — the Instagram surface workbench\n\n` +
      `  capture   passive capture of real responses + DOM (Electron, interactive)\n` +
      `  inspect   click-to-capture element instrumentation (Electron, interactive)\n` +
      `  smoke     the live action test (Electron, interactive, real account)\n` +
      `  replay    re-parse the committed corpus through the active surface\n` +
      `  diff      corpus shape digest vs the endpoint schemas\n` +
      `  ingest    scrub the local probe runs (EPO_SCRUB_SOURCE) into the 2026-11-02 corpus\n`,
  );
}

/** Dispatch. Electron subcommands are `require`d LAZILY: loading one boots an app. */
export function main(argv: readonly string[]): number {
  const command = argv.find((a) => !a.startsWith('-')) ?? '';
  if (!isSubcommand(command)) {
    usage();
    return command === '' ? 0 : 1;
  }
  switch (command) {
    case 'capture':
      require('@/capture/capture-main');
      return 0;
    case 'inspect':
      require('@/inspect/inspect-main');
      return 0;
    case 'smoke':
      require('@/livetest/livetest-main');
      return 0;
    case 'replay': {
      const { checked, failures } = replay();
      for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
      process.stdout.write(`replay: ${checked - failures.length}/${checked} bodies reproduced\n`);
      return failures.length === 0 ? 0 : 1;
    }
    case 'diff': {
      for (const line of diff()) process.stdout.write(`${line}\n`);
      return 0;
    }
    case 'ingest': {
      const source = process.env.EPO_SCRUB_SOURCE;
      if (source === undefined) {
        process.stdout.write('ingest: set EPO_SCRUB_SOURCE to the local probe runs\n');
        return 1;
      }
      const { manifest } = ingestProbeRuns({ source, outDir: join(process.cwd(), PROBE_CORPUS_DIR), repoRoot: process.cwd() });
      process.stdout.write(`ingest: ${manifest.bodies.length} bodies, ${manifest.dropped.length} dropped\n`);
      return 0;
    }
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
