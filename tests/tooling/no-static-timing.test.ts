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
