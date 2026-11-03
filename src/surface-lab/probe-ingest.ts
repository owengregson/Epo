/**
 * Probe-run ingestion (spec §10.8, §16.5): the probe's recorded exchanges, read in place from the local probe
 * output (never copied), routed through the production router, diversified by fingerprint, trimmed, scrubbed and
 * leak-checked into `tests/fixtures/surface/2026-11-02/` — the only directory it ever writes. Zero requests.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { surface } from '@/surface/index';
import { Scrubber } from '@/surface/lab/scrub';
import { SCRUB_SHAPES } from '@/surface/lab/shape';
import { readResponse } from '@/surface/parse';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { CORPUS_PATHS } from '@/surface/versions/2026-08-12/scrub-shapes';
import { at, fingerprintOf } from '@/surface-lab/fingerprint';
import { emptyOriginals, harvestValue, type Originals, readJson } from '@/surface-lab/originals';
import {
  type CorpusBody, type CorpusManifest, corpusFile, leakOf, PER_ENDPOINT, REPLAY_AT, type ScrubOutcome, writeManifest,
} from '@/surface-lab/scrub-fixtures';
import { type RecordedRequest, routeExchange, SOURCE_OF } from '@/surface-lab/select';

/** The probe corpus's id: the day the probe runs were recorded. */
export const PROBE_CORPUS_ID = '2026-11-02';
/** The one directory ingestion may write, relative to the repo root. */
export const PROBE_CORPUS_DIR = join('tests', 'fixtures', 'surface', PROBE_CORPUS_ID);
/** The endpoints a probe run's visits and drawer passes read. */
export const PROBE_KINDS: readonly EndpointKind[] = ['profile-graphql', 'activity-feed', 'friend-requests'];

/** The fields of one recorded exchange (`src/probe/recorder.ts`) that ingestion reads. */
interface Exchange extends RecordedRequest {
  readonly n: number;
  readonly form?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly mime?: string;
  readonly body?: string;
}

interface Candidate { kind: EndpointKind; op: string | null; ex: Exchange; origin: string; body: unknown; size: number;
  fingerprint: string }

/** The run folders under a source: `<src>/<run>/traffic.json`, or the capture layout `<src>/raw/probe-verify-*`. */
export function probeRuns(source: string): string[] {
  if (!existsSync(source)) return [];
  const dirs = readdirSync(source).map((n) => join(source, n)).filter((d) => statSync(d).isDirectory());
  const direct = dirs.filter((d) => existsSync(join(d, 'traffic.json')));
  if (direct.length > 0) return direct.sort();
  const raw = join(source, 'raw');
  if (!existsSync(raw)) return [];
  return readdirSync(raw).filter((n) => n.startsWith('probe-verify-')).flatMap((n) => probeRuns(join(raw, n))).sort();
}

/** Parsed request variables (a GraphQL form field), or `undefined`. */
function variablesOf(ex: Exchange): unknown {
  const raw = ex.form?.variables;
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Variables the recorder could not keep as JSON carry nothing to harvest or to facet on.
    return undefined;
  }
}

/** Every username, display name and id in every recorded body and request of every run: the residual needles. */
export function harvestProbeOriginals(source: string): Originals {
  const into = emptyOriginals();
  for (const run of probeRuns(source)) {
    for (const ex of (readJson(join(run, 'traffic.json')) as Exchange[] | undefined) ?? []) {
      harvestValue(variablesOf(ex), into);
      if (ex.body !== undefined) harvestValue(readJson(join(run, 'bodies', ex.body)), into);
    }
  }
  return into;
}

/** Keep the first rows of every declared row container: one body tests a row shape, not a long history. */
function trimmed(kind: EndpointKind, body: unknown): unknown {
  const copy = structuredClone(body);
  for (const path of CORPUS_PATHS.rows[kind] ?? []) {
    const cut = path.lastIndexOf('.');
    const parent = cut < 0 ? copy : at(copy, path.slice(0, cut));
    const key = path.slice(cut + 1);
    if (typeof parent !== 'object' || parent === null) continue;
    const rows = (parent as Record<string, unknown>)[key];
    if (Array.isArray(rows)) (parent as Record<string, unknown>)[key] = rows.slice(0, SCRUB_POLICY.rowsKept);
  }
  return copy;
}

/** Ingest every probe run under `source` into the probe corpus at `outDir` (which must be the corpus dir). */
export function ingestProbeRuns(opts: { source: string; outDir: string; repoRoot: string }): ScrubOutcome {
  if (relative(resolve(opts.repoRoot, PROBE_CORPUS_DIR), resolve(opts.outDir)) !== '') {
    throw new Error(`probe-ingest: writes only ${PROBE_CORPUS_DIR}`);
  }
  const runs = probeRuns(opts.source);
  if (runs.length === 0) throw new Error('probe-ingest: no probe run (no traffic.json) under the source');
  const doc = surface();
  const originals = harvestProbeOriginals(opts.source);
  const candidates: Candidate[] = [];
  for (const run of runs) {
    const runName = relative(opts.source, run);
    for (const ex of (readJson(join(run, 'traffic.json')) as Exchange[] | undefined) ?? []) {
      if (ex.body === undefined) continue;
      const body = readJson(join(run, 'bodies', ex.body));
      const route = routeExchange(ex);
      if (route === null || !PROBE_KINDS.includes(route.kind)) continue;
      const endpoint = doc.endpoints.find((e) => e.kind === route.kind);
      if (endpoint === undefined || !readResponse(endpoint, body, { at: REPLAY_AT, source: SOURCE_OF[route.kind] }).ok) continue;
      const size = JSON.stringify(body).length;
      const origin = `${runName}/${String(ex.n)}`;
      candidates.push({ ...route, ex, origin, body, size, fingerprint: fingerprintOf(route.kind, body, variablesOf(ex)) });
    }
  }

  const scrubber = new Scrubber();
  for (const handle of originals.handles) scrubber.handle(handle);
  for (const name of originals.names) scrubber.name(name);
  const picked = new Map<EndpointKind, Candidate[]>();
  for (const kind of PROBE_KINDS) {
    const seen = new Set<string>();
    const mine: Candidate[] = [];
    const ordered = candidates.filter((c) => c.kind === kind)
      .sort((a, b) => a.size - b.size || a.origin.localeCompare(b.origin));
    for (const c of ordered) {
      if (seen.has(c.fingerprint) || mine.length >= PER_ENDPOINT) continue;
      seen.add(c.fingerprint);
      mine.push({ ...c, body: trimmed(kind, c.body) });
    }
    picked.set(kind, mine);
    scrubber.seedTimes(SCRUB_SHAPES[kind], mine.map((c) => c.body));
  }

  const bodiesOut = join(opts.outDir, 'bodies');
  rmSync(opts.outDir, { recursive: true, force: true });
  mkdirSync(bodiesOut, { recursive: true });
  const bodies: CorpusBody[] = [];
  const dropped: CorpusManifest['dropped'] = [];
  for (const [kind, mine] of picked) {
    mine.forEach((c, index) => {
      const scrubbed = scrubber.body(SCRUB_SHAPES[kind], c.body);
      const text = `${JSON.stringify(scrubbed, null, 1)}\n`;
      const leak = leakOf(text, originals);
      if (leak !== null) {
        dropped.push({ origin: `${kind}/${c.origin}`, reason: leak });
        return;
      }
      const endpoint = doc.endpoints.find((e) => e.kind === kind);
      const source = SOURCE_OF[kind];
      const replay = endpoint === undefined ? null : readResponse(endpoint, scrubbed, { at: REPLAY_AT, source });
      if (replay === null || !replay.ok) {
        // Issue paths and zod messages name schema paths and types only, never a value.
        const issues = replay === null ? 'no endpoint' : replay.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        throw new Error(`probe-ingest: a scrubbed ${kind} body no longer parses (${issues}); the scrubber changed a load-bearing field`);
      }
      const file = corpusFile(kind, index + 1, 'json');
      writeFileSync(join(bodiesOut, file), text);
      const { projection } = replay;
      bodies.push({
        file, endpoint: kind, source, origin: c.origin,
        route: { method: c.ex.method, path: c.ex.path, op: c.op, via: c.op === null ? 'url' : 'header' },
        status: c.ex.status ?? null, mime: c.ex.mime ?? null,
        expect: {
          facts: projection.facts.length, relationships: projection.relationships.length,
          events: projection.events.length, cursor: projection.cursor, hasMore: projection.hasMore,
          absent: projection.absent, rowIssues: projection.rowIssues.length, novelKeys: [...replay.novelKeys],
        },
      });
    });
  }

  const manifest: CorpusManifest = {
    corpusId: PROBE_CORPUS_ID,
    capturedAt: PROBE_CORPUS_ID,
    surfaceId: doc.id,
    scrubbedAt: new Date(REPLAY_AT).toISOString(),
    replayAt: REPLAY_AT,
    bodies: bodies.sort((a, b) => a.file.localeCompare(b.file)),
    dom: [],
    missing: [...new Set(doc.endpoints.map((e) => e.kind))].filter((k) => !bodies.some((b) => b.endpoint === k)),
    dropped,
    stats: scrubber.stats(),
  };
  writeManifest(opts.outDir, manifest);
  return { manifest, wrote: { bodies: bodies.length, dom: 0 } };
}
