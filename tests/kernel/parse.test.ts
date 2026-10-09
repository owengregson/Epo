import fc from 'fast-check';
import { z } from 'zod';
import { isDrift, parseWith } from '@/kernel/parse';

const user = z.object({ pk: z.string(), username: z.string() });
const followersList = z.object({ users: z.array(user), next_max_id: z.string().optional() });
const parseFollowers = parseWith(followersList, 'followersList');

describe('kernel/parse', () => {
  it('an EMPTY list is a value, not a drift — the ADR 0303 distinction', () => {
    const parsed = parseFollowers({ users: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.users).toEqual([]);
  });

  it('a wrong shape is a drift carrying the exact JSON path', () => {
    const parsed = parseFollowers({ users: [{ pk: '1', username: 'a' }, { pk: 2, username: 'b' }] });
    expect(isDrift(parsed)).toBe(true);
    if (!parsed.ok) {
      expect(parsed.drift.at).toBe('followersList.users[1].pk');
      expect(parsed.drift.expected).toBe('string');
      expect(parsed.drift.got).toBe('number 2');
    }
  });

  it('a missing container drifts at the label itself', () => {
    const parsed = parseFollowers({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.drift.at).toBe('followersList.users');
      expect(parsed.drift.got).toBe('undefined');
    }
  });

  it('the two exits are the ONLY exits: parseWith never throws', () => {
    const explosive = z.string().transform(() => {
      throw new Error('schema exploded');
    });
    const parse = parseWith(explosive as unknown as z.ZodType<string>, 'explosive');
    const parsed = parse('anything');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.drift.got).toContain('schema exploded');
  });

  it('never throws for any input at all', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const parsed = parseFollowers(input);
        expect(typeof parsed.ok).toBe('boolean');
        if (!parsed.ok) {
          expect(parsed.drift.at.startsWith('followersList')).toBe(true);
          expect(parsed.drift.expected.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('truncates a large received value instead of logging a whole body', () => {
    const parsed = parseWith(z.string(), 'body')({ blob: 'x'.repeat(500) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.drift.got.length).toBeLessThan(80);
  });
});
