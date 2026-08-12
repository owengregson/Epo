import { PkRegistry } from '@/main/foundation-wiring';

/**
 * The PkRegistry is the pk-map the Foundation uses to key ledger entries and
 * edges by the real numeric pk (identity is the pk, never the username). It is
 * the one piece of foundation-wiring that is cleanly unit-testable without
 * Electron / a live tab.
 */
describe('PkRegistry', () => {
  test('remembers a username -> pk pairing and looks it up', () => {
    const r = new PkRegistry();
    r.remember('SomeUser', '12345');
    expect(r.lookup('SomeUser')).toBe('12345');
  });

  test('lookup is case-insensitive (usernames are attributes, pk is identity)', () => {
    const r = new PkRegistry();
    r.remember('SomeUser', '12345');
    expect(r.lookup('someuser')).toBe('12345');
    expect(r.lookup('SOMEUSER')).toBe('12345');
  });

  test('returns null for an unknown username (caller falls back to the name)', () => {
    const r = new PkRegistry();
    expect(r.lookup('nobody')).toBeNull();
  });

  test('ignores an undefined username without recording anything', () => {
    const r = new PkRegistry();
    r.remember(undefined, '999');
    expect(r.lookup('999')).toBeNull();
  });

  test('a newer observation overwrites the pk for the same username', () => {
    const r = new PkRegistry();
    r.remember('rotator', '1');
    r.remember('rotator', '2');
    expect(r.lookup('rotator')).toBe('2');
  });
});
