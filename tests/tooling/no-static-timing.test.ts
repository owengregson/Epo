/**
 * The static-timing gate (spec §20.4): outside src/kernel and src/renderer no numeric literal other
 * than 0, ±1 and the kernel/units multipliers, no read of a tempo-claimed prior and no Math.random
 * survives unless tests/tooling/static-timing.allow.json lists it with a class and a reason.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as derive from '@/kernel/derive';
import { MOTION } from '@/kernel/motion-policy';
import { TEMPO_SPECS } from '@/kernel/tempo';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@/kernel/units';

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = 'tests/tooling/fixtures/static-timing';

/** Runs an ES module snippet from the repo root: the scripts are ESM and this suite is CJS. */
function esm<T>(code: string): T {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (run.status !== 0) throw new Error(`static-timing script failed:\n${run.stderr}`);
  return JSON.parse(run.stdout) as T;
}

interface Finding {
  key: string;
  file: string;
  kind: 'literal' | 'prior' | 'random';
  line: number;
}

const scan = esm<{ files: string[]; claims: string[]; multipliers: number[]; tree: Finding[]; fixtures: Finding[] }>(`
  import { scan, scanContext, scopeFiles } from './scripts/static-timing-scan.mjs';
  const ctx = scanContext();
  const files = scopeFiles();
  const fixtures = ['positions', 'priors', 'randomness', 'allowed'].map((f) => '${FIXTURES}/' + f + '.ts');
  const out = { files, claims: [...ctx.claims], multipliers: [...ctx.multipliers], tree: scan(files, ctx), fixtures: scan(fixtures, ctx) };
  process.stdout.write(JSON.stringify(out));
`);

/** A fixture's keys without the file part, in source order. */
const keysIn = (file: string): string[] =>
  scan.fixtures.filter((f) => f.file === `${FIXTURES}/${file}`).map((f) => f.key.slice(`${FIXTURES}/${file} :: `.length));

describe('the scanner catches every position', () => {
  test('a numeric literal anywhere: property, nested property, const, array, default, field, argument, operand', () => {
    expect(keysIn('positions.ts')).toEqual([
      'ACQUISITION_DEFAULTS :: maxCoverageFraction :: 0.5',
      'ACQUISITION_DEFAULTS :: targetNewPks :: 100',
      'EFFECT_POLICY :: READ_RETRY.base :: 2_000',
      'EFFECT_POLICY :: READ_RETRY.cap :: 30_000',
      'RETRY_LIMIT :: RETRY_LIMIT :: 7',
      'STEPS_MS :: STEPS_MS[] :: 250',
      'STEPS_MS :: STEPS_MS[] :: 500',
      'retryAfter :: waitMs :: 1_500',
      'Pacer :: restMs :: 400',
      'Pacer.pause :: settleMs :: 300',
      'Pacer.pause :: sleep :: 2_500',
      'Pacer.pause :: sleep :: 3',
      'Pacer.pause :: sleep :: 60_000',
      'clampStep :: if :: 12',
      'clampStep :: return :: -4',
    ]);
  });

  test('a read of a claimed prior, through a group import, an alias, a namespace or destructuring', () => {
    expect(keysIn('priors.ts')).toEqual([
      'scrollWait :: scrollWait :: RIM.SCROLL_WAIT_MS',
      'idle :: idle :: ENGINE.IDLE_MS',
      'park :: park :: PRUNE.PARK_MS',
      '<module> :: BEAT_MIN_FACTOR :: NOISE.BEAT_MIN_FACTOR',
      'gravity :: gravity :: MOTION.gravity',
      'readBase :: readBase :: PACING_BASE_MS.read',
    ]);
  });

  test('Math.random, called, referenced, defaulted or destructured', () => {
    expect(keysIn('randomness.ts')).toEqual([
      'draw :: return :: Math.random',
      'source :: source :: Math.random',
      'pick :: return :: Math.random',
      '<module> :: random :: Math.random',
    ]);
  });

  test('0, ±1, the unit multipliers as multipliers and type positions pass', () => {
    expect(keysIn('allowed.ts')).toEqual([]);
  });
});

describe('the scan reads its vocabulary from the kernel', () => {
  test("the claimed priors are exactly the tempo specs' identities", () => {
    const claims = Object.values(TEMPO_SPECS).flatMap((spec) => {
      const identity = spec.identity as { registry?: readonly string[]; motion?: readonly string[] };
      return [...(identity.registry ?? []), ...(identity.motion ?? []).map((key) => `MOTION.${key}`)];
    });
    expect(scan.claims).toEqual([...new Set(claims)].sort());
  });

  test('every claimed key exists in its group', () => {
    const groups = { ...derive, MOTION } as unknown as Record<string, Record<string, unknown> | undefined>;
    const missing = scan.claims.filter((claim) => {
      const [group, key] = claim.split('.');
      return !(key in (groups[group] ?? {}));
    });
    expect(missing).toEqual([]);
  });

  test("the allowed multipliers are kernel/units' MS_PER_* values", () => {
    expect(scan.multipliers).toEqual([MS_PER_SECOND, MS_PER_MINUTE, MS_PER_HOUR, MS_PER_DAY]);
  });
});

interface Entry {
  key: string;
  class: 'GEOM' | 'HARNESS' | 'PENDING';
  stream?: string;
  reason: string;
  count?: number;
  movedFrom?: string;
}

/** The generator's operations over a synthetic list (`new Map` counts stand in for a scan). */
const ratchet = esm<Record<string, unknown>>(`
  import * as g from './scripts/gen-static-timing-allow.mjs';
  import { classify } from './scripts/static-timing-seed.mjs';
  const entry = (key, more = {}) => ({ key, class: 'PENDING', stream: 'PR', reason: 'PR: a synthetic ratchet entry', ...more });
  const counts = new Map([['a', 2], ['b', 1], ['c', 1]]);
  const listed = [entry('a', { count: 3 }), entry('b'), entry('gone')];
  const refuse = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const finding = (file, scope, context, text, kind = 'literal') => ({ key: [file, scope, context, text].join(' :: '), file, scope, context, text, kind });
  const findings = [finding('src/probe/x.ts', 'f', 'sleep', '5000'), finding('src/engine/engine.ts', 'ACTIONS_FAILING_HALT', 'ACTIONS_FAILING_HALT', '8'),
    finding('src/adapter/versions/v.ts', 'X', 'AbortSignal.timeout', '20000'), finding('src/engine/engine.ts', 'E', 'x', '9'), finding('src/engine/engine.ts', 'E', 'x', '9')];
  const seeded = g.seed([entry('src/engine/engine.ts :: E :: x :: 9', { class: 'GEOM', stream: undefined, reason: 'kept as reviewed' })], findings);
  process.stdout.write(JSON.stringify({
    pruned: g.prune(listed, counts),
    uncovered: g.uncovered(g.prune(listed, counts), counts),
    moved: g.move(listed, 'b', 'c', counts),
    moveRefusals: [refuse(() => g.move(listed, 'x', 'c', counts)), refuse(() => g.move(listed, 'b', 'a', counts)), refuse(() => g.move(listed, 'b', 'z', counts))],
    against: g.refusalsAgainst([entry('a', { count: 2 }), entry('b', { count: 2 }), entry('new'), entry('c', { movedFrom: 'b' })], [entry('a', { count: 2 }), entry('b')]),
    settled: g.settleMoves([entry('c', { movedFrom: 'b' }), entry('d', { movedFrom: 'b' })], [entry('c')]),
    seeded, reseeded: g.seed(seeded, findings), serialized: g.serialize([entry('b'), entry('a', { count: 2 })]),
    guarded: classify(finding('src/adapter/versions/v.ts', 'X', 'pollMs', '250')),
  }));
`);

describe('the allow-list is a ratchet', () => {
  test('prune drops what is gone and lowers counts; it never adds or raises', () => {
    expect((ratchet.pruned as Entry[]).map((e) => [e.key, e.count])).toEqual([['a', 2], ['b', undefined]]);
    expect(ratchet.uncovered).toEqual(['c (1 found, 0 listed)']);
  });

  test('--move re-keys an entry, keeps its class and reason, and remembers the origin', () => {
    const moved = (ratchet.moved as Entry[]).find((e) => e.key === 'c');
    expect(moved).toEqual({ key: 'c', class: 'PENDING', stream: 'PR', reason: 'PR: a synthetic ratchet entry', movedFrom: 'b' });
    expect(ratchet.moveRefusals).toEqual([
      '--move: nothing listed under x',
      '--move: a is listed already',
      '--move: z is not a current finding',
    ]);
  });

  test('--against refuses a key or a count the ref does not list; a moved key answers to its origin', () => {
    expect(ratchet.against).toEqual(['b: count 2 > 1 at the ref', 'new: not listed at the ref']);
    expect((ratchet.settled as Entry[]).map((e) => [e.key, e.movedFrom])).toEqual([['c', undefined], ['d', 'b']]);
  });

  test('--seed keeps reviewed entries, classes the rest, and a second run changes nothing', () => {
    const seeded = ratchet.seeded as Entry[];
    expect(seeded.map((e) => [e.key.split(' :: ')[0], e.class, e.stream, e.count])).toEqual([
      ['src/adapter/versions/v.ts', 'PENDING', 'PP', undefined],
      ['src/engine/engine.ts', 'PENDING', 'PR', undefined],
      ['src/engine/engine.ts', 'GEOM', undefined, 2],
      ['src/probe/x.ts', 'HARNESS', undefined, undefined],
    ]);
    expect(ratchet.reseeded).toEqual(seeded);
  });

  test('a name that says time keeps a literal out of the generic GEOM families', () => {
    expect(ratchet.guarded).toMatchObject({ class: 'PENDING', stream: 'PP' });
  });

  test('the generator refuses an unknown option and a half-given --move', () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['scripts/gen-static-timing-allow.mjs', ...args, '--print'], { cwd: ROOT, encoding: 'utf8' });
    const unknown = run('--grow');
    expect([unknown.status, unknown.stderr.trim()]).toEqual([1, 'static-timing: unknown option(s): --grow']);
    const half = run('--move', 'one-key');
    expect([half.status, half.stderr.trim()]).toEqual([1, 'static-timing: --move takes 2 argument(s)']);
  });

  test('the file holds one entry per line, sorted by key', () => {
    expect((ratchet.serialized as string).split('\n').slice(2, 4)).toEqual([
      '    {"key":"a","class":"PENDING","stream":"PR","reason":"PR: a synthetic ratchet entry","count":2},',
      '    {"key":"b","class":"PENDING","stream":"PR","reason":"PR: a synthetic ratchet entry"}',
    ]);
  });
});

describe('scope', () => {
  test('all of src but the kernel, the renderer and generated files', () => {
    expect(scan.files.filter((f) => !/^src\/.+[.]tsx?$/.test(f))).toEqual([]);
    expect(scan.files.filter((f) => /^src\/(kernel|renderer)\/|[.]generated[.]/.test(f))).toEqual([]);
  });

  test.each(['probe', 'livetest', 'capture', 'inspect', 'tools', 'surface-lab', 'adapter', 'engine', 'main', 'rim', 'store'])(
    'src/%s is scanned',
    (dir) => {
      expect(scan.files.some((f) => f.startsWith(`src/${dir}/`))).toBe(true);
    },
  );
});
