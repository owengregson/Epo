/**
 * The read laws (spec §10.8) over both committed corpora × delivery mutations: a key renamed,
 * dropped or wrapped, a value retyped, the body framed, streamed partially or carrying errors.
 * Every read is a correct parse or a typed failure — never a wrong fact — and the small
 * delivery changes (framing, a digit-string count, an alias id) still parse to the same facts.
 */
import fc from 'fast-check';
import { routeOf } from '@/surface/index';
import { readBody } from '@/surface/read/read';
import type { BodyInput, SurfaceRead } from '@/surface/read/types';
import { ENDPOINT_KINDS } from '@/surface/schema/endpoints';
import type { Projection } from '@/surface/schema/projection';
import type { CorpusBody } from '@/surface-lab/scrub-fixtures';
import { setLevel } from '@/utils/logger';
import { bodyOf, CORPORA, type CorpusId, hasCorpusAt, manifestOf } from './corpus';

beforeAll(() => setLevel('error'));

const RUNS = { numRuns: 300, seed: 20261103 };
type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Case { id: CorpusId; entry: CorpusBody; body: unknown; at: number }
const CASES: Case[] = [...CORPORA].filter(hasCorpusAt).flatMap((id) => {
  const m = manifestOf(id);
  return m.bodies.map((entry) => ({ id, entry, body: bodyOf(id, entry.file), at: m.replayAt }));
});

const json = (v: unknown, final: boolean | null = null): BodyInput => ({ decoded: { ok: true, json: v, format: 'json', payloads: 1, final } });
const read = (c: Case, input: BodyInput): SurfaceRead => {
  const r = c.entry.route;
  const route = r === undefined ? null
    : routeOf({ url: r.path, method: r.method, requestHeaders: r.op === null ? {} : { 'x-fb-friendly-name': r.op } });
  return readBody(c.entry.endpoint, input, { at: c.at, source: c.entry.source, pk: c.entry.pk, ...(route === null ? {} : { route }) });
};

/** Every object key path in a body (rows sampled), as segment lists. */
function keyPaths(v: unknown, prefix: Array<string | number> = [], out: Array<Array<string | number>> = []): Array<Array<string | number>> {
  if (Array.isArray(v)) {
    for (const [i, row] of v.slice(0, 3).entries()) keyPaths(row, [...prefix, i], out);
  } else if (isRecord(v)) {
    for (const [k, child] of Object.entries(v)) {
      out.push([...prefix, k]);
      keyPaths(child, [...prefix, k], out);
    }
  }
  return out;
}

const parentOf = (root: unknown, path: ReadonlyArray<string | number>): Json | unknown[] | null => {
  let at: unknown = root;
  for (const seg of path.slice(0, -1)) at = (at as Record<string | number, unknown>)?.[seg];
  return isRecord(at) || Array.isArray(at) ? at : null;
};

type Op = 'rename' | 'drop' | 'wrap' | 'retype';
function mutate(body: unknown, path: ReadonlyArray<string | number>, op: Op): unknown {
  const out = clone(body);
  const parent = parentOf(out, path) as Record<string | number, unknown> | null;
  const key = path[path.length - 1];
  if (parent === null || key === undefined) return out;
  const value = parent[key];
  if (op === 'rename') {
    delete parent[key];
    parent[`${String(key)}_v2`] = value;
  } else if (op === 'drop') delete parent[key];
  else if (op === 'wrap') parent[key] = { node: value };
  else parent[key] = typeof value === 'number' || typeof value === 'boolean' ? String(value)
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return out;
}

/** No fact the mutated read admits disagrees with what the real body says. */
function noWrongFact(orig: Projection, r: SurfaceRead): boolean {
  if (!r.ok) return true;
  const p = r.projection;
  const factOk = (f: Projection['facts'][number], pool: Projection['facts']): boolean => {
    const o = pool.find((x) => x.accountPk === f.accountPk);
    return o !== undefined && Object.entries(f.fields).every(([k, v]) => v === undefined || (o.fields as Json)[k] === v);
  };
  if (!p.facts.every((f) => factOk(f, orig.facts))) return false;
  if (!p.pendingPreview.every((f) => factOk(f, orig.pendingPreview))) return false;
  for (const rel of p.relationships) {
    const known = (['following', 'outgoingRequest', 'followedBy', 'incomingRequest'] as const).filter((k) => rel[k] !== null);
    if (known.length === 0) continue; // every flag unknown: no fact at all
    const o = orig.relationships.find((x) => x.pk === rel.pk);
    if (o === undefined) return false;
    for (const k of ['following', 'outgoingRequest', 'followedBy', 'incomingRequest'] as const) if (rel[k] !== null && rel[k] !== o[k]) return false;
  }
  for (const e of p.events) {
    const o = orig.events.find((x) => x.pk === e.pk);
    if (o === undefined || (e.username !== null && e.username !== o.username) || (e.atMs !== null && e.atMs !== o.atMs)) return false;
  }
  if (p.absent === true && orig.absent !== true) return false;
  if (p.continuation?.kind === 'end' && orig.continuation?.kind !== 'end') return false;
  return !(p.continuation?.kind === 'next' && orig.continuation?.kind === 'next' && p.continuation.cursor !== orig.continuation.cursor);
}

const origOf = (c: Case): Projection => {
  const r = read(c, json(c.body));
  if (!r.ok) throw new Error(`${c.entry.file} does not read`);
  return r.projection;
};

describe('L-TOTAL: the parser never throws', () => {
  test('any text or JSON, as any endpoint, is a typed read or a typed failure', () => {
    const input = fc.oneof(fc.string().map((text) => ({ text })), fc.json().map((t) => json(JSON.parse(t) as unknown)));
    fc.assert(fc.property(fc.constantFrom(...ENDPOINT_KINDS), input, (kind, body) => {
      const r = readBody(kind, body, { at: 1_786_534_400_000 });
      return typeof r.ok === 'boolean' && r.endpoint === kind;
    }), RUNS);
  });
});

describe('correct parse or typed failure, never a wrong fact (both corpora × mutations)', () => {
  test.each(CASES.map((c) => [c.entry.file, c] as const))('%s', (_file, c) => {
    const orig = origOf(c);
    const paths = keyPaths(c.body);
    const op = fc.constantFrom<Op>('rename', 'drop', 'wrap', 'retype');
    fc.assert(fc.property(fc.integer({ min: 0, max: paths.length - 1 }), op, (i, kind) =>
      noWrongFact(orig, read(c, json(mutate(c.body, paths[i] ?? [], kind))))), RUNS);
  });

  test.each(CASES.map((c) => [c.entry.file, c] as const))('%s: errors beside the data make the read partial; errors alone a wall', (_f, c) => {
    const errors = [{ message: 'Please wait a few minutes', summary: 'x' }];
    const beside = read(c, json({ ...(c.body as Json), errors }));
    expect(!beside.ok || beside.partial || !('data' in (c.body as Json))).toBe(true);
    const alone = read(c, json({ errors }));
    expect(alone).toMatchObject({ ok: false, kind: 'wall', via: 'graphql' });
  });

  test.each(CASES.map((c) => [c.entry.file, c] as const))('%s: a stream that is not final never claims an end or an absence', (_f, c) => {
    const r = read(c, json(c.body, false));
    expect(r.ok && (r.projection.continuation?.kind === 'end' || r.projection.absent === true)).toBe(false);
    if (r.ok) expect(r.partial).toBe(true);
  });
});

describe('small delivery changes still parse to the same facts (C1)', () => {
  const factsOf = (p: Projection) => ({ facts: p.facts, relationships: p.relationships, events: p.events, pendingPreview: p.pendingPreview });
  const same = (orig: Projection, got: Projection): void => expect(factsOf(got)).toEqual(factsOf(orig));

  test.each(CASES.map((c) => [c.entry.file, c] as const))('%s: guarded, newline-delimited and multipart framing', (_f, c) => {
    const text = JSON.stringify(c.body);
    for (const framed of [`for (;;);${text}`, `${text}\n{"extensions":{"is_final":true}}`, `--b\r\nContent-Type: application/json\r\n\r\n${text}\r\n--b--`]) {
      const r = read(c, { text: framed });
      expect(r).toMatchObject({ ok: true, tier: 'normalized' });
      if (r.ok) same(origOf(c), r.projection);
    }
  });

  test('a digit-string count is retyped and keeps its pair', () => {
    const c = CASES.find((x) => x.entry.endpoint === 'profile-graphql');
    if (c === undefined) throw new Error('no profile body');
    const body = clone(c.body) as { data: { user: Json } };
    body.data.user.follower_count = String(body.data.user.follower_count);
    const r = read(c, json(body));
    expect(r).toMatchObject({ ok: true, tier: 'normalized', steps: [{ kind: 'retype', at: 'follower_count', detail: 'string' }] });
    if (r.ok) same(origOf(c), r.projection);
  });

  test('a row whose canonical id is renamed reads from its agreeing aliases', () => {
    const c = CASES.find((x) => x.entry.endpoint === 'followers-list');
    if (c === undefined) throw new Error('no list body');
    const body = clone(c.body) as { users: Json[] };
    for (const row of body.users) delete row.pk;
    const r = read(c, json(body));
    expect(r).toMatchObject({ ok: true, tier: 'normalized', steps: [{ kind: 'alias-key', at: 'users[].pk_id' }] });
    if (r.ok) same(origOf(c), r.projection);
  });
});
