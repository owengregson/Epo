import {
  ratioScore,
  scoreCandidate,
  SCORER_DEFAULTS,
  type ScorerConfig,
} from '@/engine/scorer';
import type { AccountState } from '@/store/types';

const cfg: ScorerConfig = SCORER_DEFAULTS;

/** Build an AccountState from partial fields with sensible bookkeeping defaults. */
const acct = (fields: Partial<AccountState>): AccountState => ({
  pk: '1',
  enrichment: 'profiled',
  firstSeenAt: 0,
  lastSeenAt: 0,
  ...fields,
});

// --- ratioScore: plateau ------------------------------------------------------

test('full score across the peak plateau', () => {
  expect(ratioScore(1.0, cfg)).toBe(1);
  expect(ratioScore(1.1, cfg)).toBe(1);
  expect(ratioScore(1.2, cfg)).toBe(1);
});

test('band edges score at bandEdgeScore (>0 and <1)', () => {
  expect(ratioScore(0.9, cfg)).toBeCloseTo(cfg.bandEdgeScore);
  expect(ratioScore(1.5, cfg)).toBeCloseTo(cfg.bandEdgeScore);
  expect(ratioScore(0.9, cfg)).toBeGreaterThan(0);
  expect(ratioScore(0.9, cfg)).toBeLessThan(1);
  expect(ratioScore(1.5, cfg)).toBeGreaterThan(0);
  expect(ratioScore(1.5, cfg)).toBeLessThan(1);
});

test('soft edge (r=2.0) is penalized below the band edge', () => {
  const s = ratioScore(2.0, cfg);
  expect(s).toBeGreaterThan(0);
  expect(s).toBeLessThan(cfg.bandEdgeScore);
});

test('hard-excluded ratios score exactly 0', () => {
  expect(ratioScore(3.1, cfg)).toBe(0);
  expect(ratioScore(0.4, cfg)).toBe(0);
  expect(ratioScore(cfg.hardLow, cfg)).toBe(0);
  expect(ratioScore(cfg.hardHigh, cfg)).toBe(0);
});

test('monotonic increase across [hardLow, peakLow]', () => {
  let prev = -1;
  for (let r = cfg.hardLow; r <= cfg.peakLow + 1e-9; r += 0.01) {
    const s = ratioScore(r, cfg);
    expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
    prev = s;
  }
  expect(ratioScore(cfg.peakLow, cfg)).toBe(1);
});

test('monotonic decrease across [peakHigh, hardHigh]', () => {
  let prev = 2;
  for (let r = cfg.peakHigh; r <= cfg.hardHigh + 1e-9; r += 0.01) {
    const s = ratioScore(r, cfg);
    expect(s).toBeLessThanOrEqual(prev + 1e-9);
    prev = s;
  }
  expect(ratioScore(cfg.hardHigh, cfg)).toBe(0);
});

test('curve is continuous at internal breakpoints', () => {
  const eps = 1e-6;
  for (const bp of [cfg.hardLow, cfg.bandLow, cfg.peakLow, cfg.peakHigh, cfg.bandHigh, cfg.hardHigh]) {
    expect(ratioScore(bp - eps, cfg)).toBeCloseTo(ratioScore(bp + eps, cfg), 4);
  }
});

// --- scoreCandidate -----------------------------------------------------------

test('no counts → ineligible with no-counts reason', () => {
  const r = scoreCandidate(acct({}), cfg);
  expect(r).toEqual({ score: 0, eligible: false, reasons: ['no-counts'] });
});

test('verified account → ineligible', () => {
  const r = scoreCandidate(acct({ followers: 1000, following: 1100, isVerified: true }), cfg);
  expect(r.eligible).toBe(false);
  expect(r.score).toBe(0);
  expect(r.reasons).toContain('verified');
});

test('too-small account → ineligible', () => {
  const r = scoreCandidate(acct({ followers: 40, following: 44 }), cfg);
  expect(r.eligible).toBe(false);
  expect(r.score).toBe(0);
});

test('too-large account → ineligible', () => {
  const r = scoreCandidate(acct({ followers: 25000, following: 27000 }), cfg);
  expect(r.eligible).toBe(false);
  expect(r.score).toBe(0);
});

test('ratio far outside hard bounds → ineligible', () => {
  const r = scoreCandidate(acct({ followers: 1000, following: 5000 }), cfg); // r = 5.0
  expect(r.eligible).toBe(false);
  expect(r.score).toBe(0);
});

test('in-band peak account is eligible and scores full pre-boost', () => {
  const r = scoreCandidate(acct({ followers: 1000, following: 1100 }), cfg); // r = 1.1
  expect(r.eligible).toBe(true);
  expect(r.score).toBe(1);
  expect(r.reasons).toContain('peak-ratio');
});

test('private in-band account outscores an identical public one', () => {
  const base = { followers: 1000, following: 950 }; // r = 0.95, sub-peak
  const pub = scoreCandidate(acct({ ...base, isPrivate: false }), cfg);
  const priv = scoreCandidate(acct({ ...base, isPrivate: true }), cfg);
  expect(pub.eligible).toBe(true);
  expect(priv.eligible).toBe(true);
  expect(priv.score).toBeGreaterThan(pub.score);
  expect(priv.reasons).toContain('private-boost');
  expect(pub.reasons).not.toContain('private-boost');
});

test('private boost is capped at 1 (clamp01)', () => {
  const r = scoreCandidate(acct({ followers: 1000, following: 1100, isPrivate: true }), cfg);
  expect(r.score).toBe(1);
});

test('explicit ratio field is used when present', () => {
  const r = scoreCandidate(acct({ ratio: 1.1, followers: 1000, following: 999999 }), cfg);
  expect(r.eligible).toBe(true);
  expect(r.reasons).toContain('peak-ratio');
});
