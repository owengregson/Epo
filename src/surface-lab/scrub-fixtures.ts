/**
 * Turn the LOCAL capture (`docs/adapter/fixtures/`, git-ignored, real data)
 * into the COMMITTED contract corpus (`tests/fixtures/surface/<id>/`).
 *
 * The fixtures are git-ignored today precisely because they are real payloads;
 * scrubbing at capture time is what makes a committed corpus safe, and an
 * allow-list driven by the schema's `pii` metadata is what makes the scrubbing
 * trustworthy (`src/surface/lab/scrub.ts`).
 *
 * Selection is SHAPE-DIVERSE rather than exhaustive: per endpoint the corpus
 * keeps up to `PER_ENDPOINT` bodies with distinct key-sets, smallest first.
 * Four followers pages differing only in which accounts they list
 * regression-test nothing; a page WITHOUT `next_max_id` (the end-of-list shape
 * ADR 0303 is about) and one carrying `groups` each earn their bytes.
 *
 * Run it with `EPO_SCRUB=1 npx jest tests/surface/scrub-fixtures` — a jest
 * harness rather than a CLI because there is no `tsx` in this tree and the
 * routine must be type-checked and linted like everything else.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { surface } from '@/surface/index';
import { Scrubber } from '@/surface/lab/scrub';
import { SCRUB_SHAPES } from '@/surface/lab/shape';
import { structuralLeaks } from '@/surface/lab/structural-leak';
import { readResponse } from '@/surface/parse';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { CorpusBody, CorpusDom, CorpusManifest, ScrubOptions, ScrubOutcome } from '@/surface-lab/corpus-types';
import { harvestOriginals, residual } from '@/surface-lab/originals';
import { classifyBody, domFeatures, fingerprint, SOURCE_OF } from '@/surface-lab/select';

export type { CorpusBody, CorpusDom, CorpusManifest, ScrubOptions, ScrubOutcome } from '@/surface-lab/corpus-types';

/** How many bodies per endpoint the corpus keeps. */
export const PER_ENDPOINT = 4;
/** How many DOM snapshots the corpus keeps (the biggest cost by far). */
export const DOM_BUDGET = 7;
/** Snapshots above this size are skipped: a 780 KB page tests nothing extra. */
export const DOM_MAX_BYTES = 30_000;

/** The observation timestamp every replay uses — fixed so counts are stable. */
export const REPLAY_AT = 1_786_534_400_000;

/** A corpus file's name: the endpoint (or snapshot kind) and its 1-based index, zero-padded. */
export const corpusFile = (kind: string, n: number, ext: 'json' | 'html'): string =>
  `${kind}-${String(n).padStart(2, '0')}.${ext}`;

/** Write a corpus manifest (two-space JSON, trailing newline). */
export function writeManifest(dir: string, manifest: CorpusManifest): void {
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Every structural rule a scrubbed text breaks, or the class of an original that survived; `null` when clean. */
export function leakOf(text: string, originals: ReturnType<typeof harvestOriginals>): string | null {
  const rules = structuralLeaks(text, [String(REPLAY_AT)]);
  if (rules.length > 0) return `structural:${rules.join('+')}`;
  return residual(text, originals);
}

/** Build the committed corpus from the local capture. Overwrites `outDir`. */
export function scrubFixtures(opts: ScrubOptions): ScrubOutcome {
  const rawDir = join(opts.sourceDir, 'raw');
  const domDir = join(opts.sourceDir, 'dom');
  if (!existsSync(rawDir)) {
    throw new Error(`scrub-fixtures: no local capture at ${rawDir} — run \`npm run capture\` first`);
  }

  const doc = surface();
  const scrubber = new Scrubber();
  const originals = harvestOriginals(opts.sourceDir);
  // Preseed the pseudonym tables from the WHOLE capture so the DOM pass can
  // replace a name whose own body the corpus does not keep.
  for (const handle of originals.handles) scrubber.handle(handle);
  for (const name of originals.names) if (name.length >= 3) scrubber.name(name);
  const dropped: Array<{ origin: string; reason: string }> = [];
  const bodiesOut = join(opts.outDir, 'bodies');
  const domOut = join(opts.outDir, 'dom');
  // A bodies-only re-scrub keeps the committed selection: the same raw bodies, the same files, the same DOM.
  const previous = opts.bodiesOnly === true
    ? (JSON.parse(readFileSync(join(opts.outDir, 'manifest.json'), 'utf8')) as CorpusManifest)
    : null;
  const keptDom = previous?.dom ?? null;
  if (previous === null) rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(bodiesOut, { recursive: true });
  mkdirSync(domOut, { recursive: true });

  // --- bodies -------------------------------------------------------------
  const byEndpoint = new Map<EndpointKind, Array<{ name: string; body: unknown; size: number }>>();
  for (const name of readdirSync(rawDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const text = readFileSync(join(rawDir, name), 'utf8');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      continue; // a non-JSON capture is not a response body
    }
    const kind = classifyBody(name, body);
    if (kind === null) continue;
    const bucket = byEndpoint.get(kind) ?? [];
    bucket.push({ name, body, size: text.length });
    byEndpoint.set(kind, bucket);
  }

  const bodies: CorpusBody[] = [];
  type Pick = { name: string; body: unknown; size: number; file?: string };
  const pickedByKind = new Map<EndpointKind, Pick[]>();
  for (const entry of previous?.bodies ?? []) {
    const raw = byEndpoint.get(entry.endpoint)?.find((b) => b.name === entry.origin);
    if (raw === undefined) throw new Error(`scrub-fixtures: ${entry.file} has no raw body in the local capture`);
    pickedByKind.set(entry.endpoint, [...(pickedByKind.get(entry.endpoint) ?? []), { ...raw, file: entry.file }]);
  }
  for (const [kind, all] of previous === null ? byEndpoint : new Map<EndpointKind, Pick[]>()) {
    const seen = new Set<string>();
    const picked = all
      .slice()
      .sort((a, b) => a.size - b.size)
      .filter((entry) => {
        const fp = fingerprint(entry.body);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      })
      .slice(0, PER_ENDPOINT);
    pickedByKind.set(kind, picked);
  }
  // Every picked body's times share one synthetic origin, so intervals across bodies survive.
  for (const [kind, picked] of pickedByKind) scrubber.seedTimes(SCRUB_SHAPES[kind], picked.map((p) => p.body));
  for (const [kind, picked] of pickedByKind) {
    picked.forEach((entry, index) => {
      const scrubbed = scrubber.body(SCRUB_SHAPES[kind], entry.body);
      const text = `${JSON.stringify(scrubbed, null, 1)}\n`;
      const leak = leakOf(text, originals);
      if (leak !== null) {
        dropped.push({ origin: `${kind}/${entry.name}`, reason: leak });
        return;
      }
      const file = entry.file ?? corpusFile(kind, index + 1, 'json');
      writeFileSync(join(bodiesOut, file), text);

      const endpoint = doc.endpoints.find((e) => e.kind === kind);
      const source = SOURCE_OF[kind];
      // The single-relationship body carries no pk of its own; the corpus pins
      // a synthetic one so the projection is deterministic.
      const pk = kind === 'friendship-show' ? scrubber.pk(`fixture-${file}`) : undefined;
      const replay =
        endpoint === undefined
          ? null
          : readResponse(endpoint, scrubbed, { at: REPLAY_AT, source, pk });
      if (replay === null || !replay.ok) {
        throw new Error(
          `scrub-fixtures: scrubbed ${file} no longer parses (${
            replay === null ? 'no endpoint' : replay.issues.map((i) => i.path).join(',')
          }) — the scrubber changed a load-bearing field`,
        );
      }
      bodies.push({
        file,
        endpoint: kind,
        source,
        pk,
        origin: basename(entry.name),
        expect: {
          facts: replay.projection.facts.length,
          relationships: replay.projection.relationships.length,
          events: replay.projection.events.length,
          cursor: replay.projection.cursor,
          hasMore: replay.projection.hasMore,
          absent: replay.projection.absent,
          rowIssues: replay.projection.rowIssues.length,
          novelKeys: [...replay.novelKeys],
        },
      });
    });
  }

  // --- DOM ----------------------------------------------------------------
  //
  // Diversified the same way the bodies are, but along the axis that matters
  // for the control contracts: which BEHAVIOURS a snapshot can exercise. Three
  // byte-identical copies of the same dialog regression-test one thing.
  const dom: CorpusDom[] = keptDom ?? [];
  if (keptDom === null && existsSync(domDir)) {
    const seenHtml = new Set<string>();
    const seenFeatures = new Set<string>();
    const candidates = readdirSync(domDir)
      .filter((n) => n.endsWith('.html'))
      .map((n) => ({ name: n, html: readFileSync(join(domDir, n), 'utf8') }))
      .filter((c) => c.html.length <= DOM_MAX_BYTES)
      .sort((a, b) => {
        const rank = (n: string): number => (n.startsWith('profile-header') ? 0 : 1);
        return rank(a.name) - rank(b.name) || a.html.length - b.html.length;
      })
      .filter((c) => {
        const digest = `${c.html.length}:${c.html.slice(0, 400)}`;
        if (seenHtml.has(digest)) return false;
        seenHtml.add(digest);
        const features = domFeatures(c.html);
        if (seenFeatures.has(features)) return false;
        seenFeatures.add(features);
        return true;
      })
      .slice(0, DOM_BUDGET);

    for (const candidate of candidates) {
      const scrubbed = scrubber.dom(candidate.html);
      const leak = leakOf(scrubbed, originals);
      if (leak !== null) {
        dropped.push({ origin: domFeatures(candidate.html), reason: leak });
        continue;
      }
      const kind = candidate.name.startsWith('profile-header') ? 'profile-header' : 'dialog';
      // The capture file name itself carries a handle — rename by index.
      const index = dom.filter((d) => d.kind === kind).length + 1;
      const file = corpusFile(kind, index, 'html');
      writeFileSync(join(domOut, file), scrubbed);
      dom.push({
        file,
        kind,
        origin: domFeatures(candidate.html),
        bytes: scrubbed.length,
      });
    }
  }

  const missing = [...new Set(doc.endpoints.map((e) => e.kind))]
    .filter((kind) => !bodies.some((b) => b.endpoint === kind));

  const manifest: CorpusManifest = {
    surfaceId: doc.id,
    scrubbedAt: new Date(REPLAY_AT).toISOString(),
    replayAt: REPLAY_AT,
    bodies: bodies.sort((a, b) => a.file.localeCompare(b.file)),
    dom,
    missing,
    dropped,
    stats: scrubber.stats(),
  };
  writeManifest(opts.outDir, manifest);
  return { manifest, wrote: { bodies: bodies.length, dom: dom.length } };
}
