import { asOwn, asTarget, pk, tryPk, tryUsername, username } from '@/kernel/brand';

describe('kernel/brand', () => {
  it('mints a pk from a numeric id and trims surrounding space', () => {
    expect(pk('17841400000')).toBe('17841400000');
    expect(pk('  42 ')).toBe('42');
  });

  it('refuses anything that is not an account id', () => {
    for (const bad of ['', '   ', 'abc', '12a', '1 2', '@42']) {
      expect(tryPk(bad)).toBeNull();
      expect(() => pk(bad)).toThrow(TypeError);
    }
  });

  it('normalises a username: strips one @, lowercases, trims', () => {
    expect(username('@Owen.Gregson')).toBe('owen.gregson');
    expect(username('  MiXeD_case  ')).toBe('mixed_case');
    expect(username('a')).toBe('a');
  });

  it('refuses handles Instagram would not resolve', () => {
    for (const bad of ['', '@', 'has space', 'has/slash', 'a'.repeat(31), '@@double']) {
      expect(tryUsername(bad)).toBeNull();
      expect(() => username(bad)).toThrow(TypeError);
    }
  });

  it('normalisation is idempotent', () => {
    const first = username('@Owen');
    expect(username(first)).toBe(first);
  });

  it('refines a pk to own/target without changing the value', () => {
    const p = pk('900');
    expect(asOwn(p)).toBe('900');
    expect(asTarget(p)).toBe('900');
  });
});
