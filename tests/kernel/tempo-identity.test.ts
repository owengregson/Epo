/**
 * The tempo-identity golden (ADR 0607, spec §5.12 item 3): at REFERENCE_TEMPO every spec resolves to
 * its prior, every prior is the value today's call site draws from, and every RIM/ENGINE/NOISE key and
 * MOTION tempo key is claimed by exactly one spec or listed in NOT_TEMPO with a reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import fc from 'fast-check';
import { ENGINE, NOISE, PRUNE, RECOVERY, RIM, SESSION } from '@/kernel/derive';
import { MOTION } from '@/kernel/motion-policy';
import { MOTION_ROLE } from '@/kernel/motion-roles';
import { mulberry32 } from '@/kernel/rng';
import {
  MOTION_REFERENCE,
  NOT_TEMPO,
  PENDING_CONSUMERS,
  type Prior,
  REFERENCE_TEMPO,
  referenceTempoSource,
  resolve,
  TEMPO_KEYS,
  TEMPO_SPECS,
  type TempoKey,
} from '@/kernel/tempo';
import { clamp, logNormal } from '@/timing/distributions';
import { nextRestStride, noisify } from '@/timing/noise';
import { sample, uniform } from '@/timing/primitives';
import { LEGACY_SNAPSHOT } from './legacy-config.snapshot';

const REGISTRY: Record<string, Record<string, unknown>> = { ENGINE, NOISE, PRUNE, RECOVERY, RIM, SESSION };
const valueAt = (p: string): unknown => {
  const [group, key] = p.split('.');
  return REGISTRY[group]?.[key];
};
const band = (min: number, max: number): Prior => ({ shape: 'band', min, max });
const pair = (p: readonly [number, number]): Prior => band(p[0], p[1]);

/** What each key's prior must equal: the numbers today's call site draws from. */
const TODAY: Record<Exclude<TempoKey, 'gap.action' | 'motion.travel'>, Prior> = {
  'gap.accept': band(RIM.ACCEPT_PACE_MIN_MS, RIM.ACCEPT_PACE_MAX_MS),
  'dwell.visit': { shape: 'logn', median: MOTION.profileDwellMedianMs, sigma: MOTION.profileDwellSigma,
    min: MOTION.profileDwellMs[0], max: MOTION.profileDwellMs[1] },
  // The retired enrich pace's band, as the snapshot pins it (the key left the registry, ADR 0607).
  'dwell.before-press': band(LEGACY_SNAPSHOT.groups.RIM.ENRICH_PACE_MIN_MS, LEGACY_SNAPSHOT.groups.RIM.ENRICH_PACE_MAX_MS),
  'ui.step-pause': band(RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS, RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS),
  'drawer.close-settle': band(RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS, RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS),
  'scroll.wait.drawer': band(RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS, RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS),
  'scroll.wait.dialog': band(RIM.SCROLL_WAIT_MS * NOISE.BEAT_MIN_FACTOR, RIM.SCROLL_WAIT_MS * NOISE.BEAT_MAX_FACTOR),
  'scroll.wait.acquire': band(RIM.ACQUIRE_SCROLL_MIN_MS, RIM.ACQUIRE_SCROLL_MAX_MS),
  'scroll.depth.drawer': { shape: 'scale', value: 2, spread: 0 },
  'scroll.depth.dialog': { shape: 'scale', value: 3, spread: 0 },
  'walk.page': band(RIM.LIST_WALK_PAGE_MIN_MS, RIM.LIST_WALK_PAGE_MAX_MS),
  'walk.rest': band(RIM.LIST_WALK_REST_MIN_MS, RIM.LIST_WALK_REST_MAX_MS),
  'walk.rest-every': { shape: 'pages', min: NOISE.LIST_WALK_REST_EVERY_MIN, max: NOISE.LIST_WALK_REST_EVERY_MAX },
  'pause.retry': { shape: 'relative', lo: NOISE.BEAT_MIN_FACTOR, hi: NOISE.BEAT_MAX_FACTOR },
  'pause.wake-settle': band(RECOVERY.RESUME_SETTLE_MIN_MS, RECOVERY.RESUME_SETTLE_MAX_MS),
  'park.blocked': { shape: 'base', value: PRUNE.PARK_MS },
  'backoff.walled': { shape: 'base', value: ENGINE.ENRICH_BACKOFF_MS },
  'beat.transient': { shape: 'base', value: ENGINE.IDLE_MS },
  'check.spacing': { shape: 'base', value: 2 * SESSION.SESSION_BOUNDARY_MS },
  'motion.press': { shape: 'logn', median: MOTION.pressMedianMs, sigma: MOTION.pressSigma,
    min: MOTION.pressMs[0], max: MOTION.pressMs[1] },
  'motion.pre-press': pair(MOTION.prePressMs),
  'motion.hover-settle': pair(MOTION.hoverSettleMs),
  'wheel.tick-pause': pair(MOTION.wheelPauseMs),
  'wheel.micro-pause': { shape: 'mix', p: MOTION.wheelMicroPauseProbability, base: pair(MOTION.wheelPauseMs),
    alt: pair(MOTION.wheelMicroPauseMs) },
  'wheel.correction-pause': pair(MOTION.wheelCorrectionPauseMs),
};

describe('the registry', () => {
  test('27 unique keys, and a spec for each — no more, no fewer', () => {
    expect(TEMPO_KEYS).toHaveLength(27);
    expect(new Set(TEMPO_KEYS).size).toBe(27);
    expect(Object.keys(TEMPO_SPECS).sort()).toEqual([...TEMPO_KEYS].sort());
  });

  test.each(TEMPO_KEYS)('%s resolves to its prior at REFERENCE_TEMPO', (key) => {
    expect(resolve(key, REFERENCE_TEMPO).prior).toEqual(TEMPO_SPECS[key].prior);
  });

  test.each(Object.keys(TODAY) as Array<keyof typeof TODAY>)('%s: the prior is what today draws from', (key) => {
    expect(TEMPO_SPECS[key].prior).toEqual(TODAY[key]);
  });

  test('the gap and travel priors are markers resolved elsewhere, and the reference gap is today\'s shape at τ = 1', () => {
    expect(TEMPO_SPECS['gap.action'].prior).toEqual({ shape: 'gap' });
    expect(TEMPO_SPECS['motion.travel'].prior).toEqual({ shape: 'travel' });
    expect(REFERENCE_TEMPO).toMatchObject({ z: 0, pace: 1, motion: 1, depth: 1, mix: 'normal', probation: false });
    expect(REFERENCE_TEMPO.gap).toMatchObject({ sigma: SESSION.GAP_SIGMA, capMs: SESSION.GAP_CAP_MS,
      hawkesAlpha: SESSION.HAWKES_ALPHA, hawkesTauMs: SESSION.HAWKES_TAU_MS, timeScale: 1 });
  });
});

describe('claims', () => {
  const registryClaims = TEMPO_KEYS.flatMap((key) => {
    const id = TEMPO_SPECS[key].identity;
    return 'registry' in id ? id.registry.map((p) => ({ key, path: p })) : [];
  });
  const motionClaims = TEMPO_KEYS.flatMap((key) => {
    const id = TEMPO_SPECS[key].identity;
    return 'motion' in id ? id.motion.map((name) => ({ key, name })) : [];
  });

  test('every claimed registry path exists and is claimed by exactly one spec', () => {
    for (const c of registryClaims) expect(valueAt(c.path)).toBeDefined();
    const paths = registryClaims.map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('every RIM, ENGINE and NOISE key is claimed by one spec or listed in NOT_TEMPO, never both', () => {
    const claimed = new Set<string>(registryClaims.map((c) => c.path));
    for (const group of ['RIM', 'ENGINE', 'NOISE']) {
      for (const key of Object.keys(REGISTRY[group])) {
        const p = `${group}.${key}`;
        expect([p, claimed.has(p) !== p in NOT_TEMPO]).toEqual([p, true]);
      }
    }
    for (const [p, reason] of Object.entries(NOT_TEMPO)) {
      expect(valueAt(p)).toBeDefined();
      expect(reason.length).toBeGreaterThanOrEqual(20);
    }
  });

  test('every MOTION tempo-role key is claimed by exactly one spec, and only those are', () => {
    const names = motionClaims.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const tempoRole = (Object.keys(MOTION_ROLE) as Array<keyof typeof MOTION_ROLE>)
      .filter((k) => MOTION_ROLE[k] === 'tempo');
    expect([...names].sort()).toEqual([...tempoRole].sort());
  });

  test('an added key names where its prior came from; a moved key names the literal it replaced', () => {
    for (const key of TEMPO_KEYS) {
      const id = TEMPO_SPECS[key].identity;
      if ('added' in id) expect(id.added).toBe('0607');
      if ('added' in id || 'moved' in id) expect(('from' in id ? id.from : id.moved).length).toBeGreaterThan(5);
    }
  });

  test('pending keys are a subset of the registry', () => {
    for (const key of PENDING_CONSUMERS) expect(TEMPO_KEYS).toContain(key);
  });
});

describe('referenceTempoSource', () => {
  const tempo = referenceTempoSource();

  test('the tempo in force is REFERENCE_TEMPO and every gesture uses MOTION_REFERENCE', () => {
    expect(tempo.current()).toBe(REFERENCE_TEMPO);
    expect(tempo.gesture().policy).toBe(MOTION_REFERENCE);
  });

  test('only the keys this overhaul adds are disabled at identity', () => {
    const disabled = TEMPO_KEYS.filter((k) => !tempo.enabled(k));
    expect(disabled.sort()).toEqual(['dwell.before-press', 'ui.step-pause']);
  });

  test('bases are today\'s wait bases', () => {
    expect(tempo.base('park.blocked')).toBe(PRUNE.PARK_MS);
    expect(tempo.base('backoff.walled')).toBe(ENGINE.ENRICH_BACKOFF_MS);
    expect(tempo.base('beat.transient')).toBe(ENGINE.IDLE_MS);
  });

  /** n draws through the tempo policy and through today's sampler, from twin seeded streams. */
  const twin = (seed: number, viaTempo: (rng: () => number) => number, today: (rng: () => number) => number) => {
    const a = mulberry32(seed);
    const b = mulberry32(seed);
    return { tempo: Array.from({ length: 200 }, () => viaTempo(a)), today: Array.from({ length: 200 }, () => today(b)) };
  };

  test.each([
    ['gap.accept', RIM.ACCEPT_PACE_MIN_MS, RIM.ACCEPT_PACE_MAX_MS],
    ['drawer.close-settle', RIM.NOTIFICATIONS_CLOSE_DELAY_MIN_MS, RIM.NOTIFICATIONS_CLOSE_DELAY_MAX_MS],
    ['scroll.wait.drawer', RIM.NOTIFICATIONS_SCROLL_WAIT_MIN_MS, RIM.NOTIFICATIONS_SCROLL_WAIT_MAX_MS],
    ['scroll.wait.acquire', RIM.ACQUIRE_SCROLL_MIN_MS, RIM.ACQUIRE_SCROLL_MAX_MS],
    ['walk.page', RIM.LIST_WALK_PAGE_MIN_MS, RIM.LIST_WALK_PAGE_MAX_MS],
    ['walk.rest', RIM.LIST_WALK_REST_MIN_MS, RIM.LIST_WALK_REST_MAX_MS],
    ['pause.wake-settle', RECOVERY.RESUME_SETTLE_MIN_MS, RECOVERY.RESUME_SETTLE_MAX_MS],
  ] as const)('%s draws exactly what uniform(min, max) draws', (key, min, max) => {
    const r = twin(7, (rng) => sample(tempo.policy(key), rng), (rng) => sample(uniform(min, max), rng));
    expect(r.tempo).toEqual(r.today);
  });

  test('dwell.visit draws exactly the clamped log-normal the visitor draws today', () => {
    const [min, max] = MOTION.profileDwellMs;
    const r = twin(11, (rng) => sample(tempo.policy('dwell.visit'), rng),
      (rng) => sample(clamp(logNormal(MOTION.profileDwellMedianMs, MOTION.profileDwellSigma), min, max), rng));
    expect(r.tempo).toEqual(r.today);
  });

  test('scroll.wait.dialog draws exactly the sub-cadence band around the dialog scroll wait', () => {
    const r = twin(13, (rng) => sample(tempo.policy('scroll.wait.dialog'), rng),
      (rng) => sample(noisify('sub-cadence', RIM.SCROLL_WAIT_MS, rng), rng));
    expect(r.tempo).toEqual(r.today);
  });

  test('pause.retry draws exactly the sub-cadence band around its call site\'s base', () => {
    const r = twin(17, (rng) => sample(tempo.policy('pause.retry', { baseMs: 1_350 }), rng),
      (rng) => sample(noisify('sub-cadence', 1_350, rng), rng));
    expect(r.tempo).toEqual(r.today);
    expect(() => tempo.policy('pause.retry').sample(() => 0.5)).toThrow(RangeError);
  });

  test('walk.rest-every draws exactly the rest stride', () => {
    const r = twin(19, (rng) => sample(tempo.policy('walk.rest-every'), rng), (rng) => nextRestStride(rng));
    expect(r.tempo).toEqual(r.today);
  });

  test('the depth spread is off at identity: viewports are today\'s literals and draw nothing', () => {
    let calls = 0;
    const counting = (): number => { calls += 1; return 0.9; };
    expect(tempo.policy('scroll.depth.drawer').sample(counting)).toBe(2);
    expect(tempo.policy('scroll.depth.dialog').sample(counting)).toBe(3);
    expect(calls).toBe(0);
  });

  test('without a call-site rng, each key draws from its own seeded stream (launch seed honoured)', () => {
    const a = referenceTempoSource(42);
    const b = referenceTempoSource(42);
    const c = referenceTempoSource(43);
    const seq = (t: ReturnType<typeof referenceTempoSource>) => [t.draw('walk.page'), t.draw('walk.page'), t.draw('gap.accept')];
    expect(seq(a)).toEqual(seq(b));
    expect(seq(a)).not.toEqual(seq(c));
  });
});

describe('laws at any tempo (L10)', () => {
  const tempoAt = (pace: number) => ({ ...REFERENCE_TEMPO, pace, motion: pace ** 0.5, depth: 1 / pace });
  const pace = fc.double({ min: 0.7, max: 1.45, noNaN: true });
  const override = fc.double({ min: 1, max: 3, noNaN: true });
  const lowest = (p: Prior): number[] => {
    switch (p.shape) {
      case 'band': case 'logn': case 'pages': return [p.min];
      case 'base': return [p.value];
      case 'mix': return lowest(p.alt); // the key's own component; `base` keeps its own key's floor
      default: return [];
    }
  };

  test('no resolved value falls below its floor', () => {
    fc.assert(fc.property(pace, override, (f, o) => {
      for (const key of TEMPO_KEYS) {
        const r = resolve(key, tempoAt(f), o);
        for (const v of lowest(r.prior)) expect(v).toBeGreaterThanOrEqual(r.floorValue - 1e-9);
      }
    }));
  });

  test('a pace-up wait is never shorter than its prior, at any pace or override', () => {
    fc.assert(fc.property(pace, override, (f, o) => {
      for (const key of ['park.blocked', 'backoff.walled', 'beat.transient'] as const) {
        const r = resolve(key, tempoAt(f), o).prior;
        const prior = TEMPO_SPECS[key].prior;
        if (r.shape !== 'base' || prior.shape !== 'base') throw new Error(`${key} is not a base prior`);
        expect(r.value).toBeGreaterThanOrEqual(prior.value);
      }
    }));
  });
});

describe('call sites', () => {
  const SRC = path.resolve(__dirname, '..', '..', 'src');
  const text = fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.startsWith(path.join('kernel', 'tempo')))
    .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8'))
    .join('\n');
  /** A key is consumed by name, or (motion keys) every MOTION key it claims is read off a gesture's policy. */
  const consumed = (key: TempoKey): boolean => {
    if (text.includes(`'${key}'`)) return true;
    const spec = TEMPO_SPECS[key];
    return spec.axis === 'motion' && 'motion' in spec.identity
      && spec.identity.motion.every((name) => new RegExp(`\\bpolicy\\.${name}\\b`).test(text));
  };

  test.each(TEMPO_KEYS)('%s has a call site, or sits in PENDING_CONSUMERS (never both)', (key) => {
    expect(consumed(key)).toBe(!PENDING_CONSUMERS.includes(key));
  });
});

test('the kernel draws no Math.random anywhere', () => {
  const kernel = path.resolve(__dirname, '..', '..', 'src', 'kernel');
  const files = fs.readdirSync(kernel, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  for (const file of files) expect([file, fs.readFileSync(path.join(kernel, file), 'utf8').includes('Math.random')]).toEqual([file, false]);
});
