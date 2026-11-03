/**
 * Presence-gated relationships (spec §10.4): an absent key is unknown, never `false`, and the
 * branded `ObservedRelation` is minted in exactly one module.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { admits } from '@/surface/read/admission';
import { mintObserved, type RelationshipKeys, readRelationship, weFollowOf } from '@/surface/read/relationship';

const KEYS: RelationshipKeys = {
  following: 'following',
  outgoingRequest: 'outgoing_request',
  followedBy: 'followed_by',
  incomingRequest: 'incoming_request',
};
const C0 = { tier: 'canonical', partial: false } as const;

describe('readRelationship reads each key by presence', () => {
  test('present booleans are read as they are', () => {
    const record = { following: false, outgoing_request: true, followed_by: true, incoming_request: false };
    expect(readRelationship(record, KEYS, '7')).toEqual({
      pk: '7', following: false, outgoingRequest: true, followedBy: true, incomingRequest: false,
    });
  });

  test('an absent, null or non-boolean key is unknown (null), never false', () => {
    const record = { following: null, outgoing_request: 'false', followed_by: 0 };
    expect(readRelationship(record, KEYS, '7')).toEqual({
      pk: '7', following: null, outgoingRequest: null, followedBy: null, incomingRequest: null,
    });
  });
});

describe('weFollowOf', () => {
  test.each([
    [true, false, true],
    [false, true, true],
    [true, null, true],
    [null, true, true],
    [false, false, false],
    [false, null, null],
    [null, false, null],
    [null, null, null],
  ])('following %p, outgoing %p → %p', (following, outgoingRequest, want) => {
    expect(weFollowOf({ following, outgoingRequest })).toBe(want);
  });
});

describe('mintObserved', () => {
  const fact = (pk: string, following: boolean | null, outgoingRequest: boolean | null) => ({
    pk, following, outgoingRequest, followedBy: null, incomingRequest: null,
  });

  test('mints only facts whose weFollow is known', () => {
    const out = mintObserved(C0, [fact('1', true, false), fact('2', false, false), fact('3', false, null)]);
    expect(out.map((o) => [o.pk, o.weFollow])).toEqual([['1', true], ['2', false]]);
  });

  test('a recovered read mints nothing; a partial read mints only the guarded weFollow:true', () => {
    const facts = [fact('1', true, false), fact('2', false, false)];
    expect(mintObserved({ tier: 'recovered', partial: false }, facts)).toEqual([]);
    expect(mintObserved({ tier: 'normalized', partial: true }, facts).map((o) => o.pk)).toEqual(['1']);
    expect(mintObserved({ tier: 'normalized', partial: false }, facts).map((o) => o.pk)).toEqual(['1', '2']);
  });

  test('admission: destructive needs C0/C1 and complete; guarded needs C0/C1; additive always', () => {
    expect(admits('destructive', { tier: 'canonical', partial: false })).toBe(true);
    expect(admits('destructive', { tier: 'normalized', partial: true })).toBe(false);
    expect(admits('destructive', { tier: 'recovered', partial: false })).toBe(false);
    expect(admits('guarded', { tier: 'normalized', partial: true })).toBe(true);
    expect(admits('guarded', { tier: 'recovered', partial: false })).toBe(false);
    expect(admits('additive', { tier: 'recovered', partial: true })).toBe(true);
  });
});

describe('the branded ObservedRelation has one mint', () => {
  const ROOT = path.resolve(__dirname, '..', '..', 'src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });

  test('only src/surface/read/relationship.ts casts to ObservedRelation', () => {
    const minting = files(ROOT)
      .filter((f) => /\bas\s+(unknown\s+as\s+)?(readonly\s+)?ObservedRelation\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.resolve(ROOT, '..'), f));
    expect(minting).toEqual(['src/surface/read/relationship.ts']);
  });
});
