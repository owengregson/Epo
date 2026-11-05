import fc from 'fast-check';
import { all, err, flatMap, map, ok, type Res, unwrapOr } from '@/kernel/result';

describe('kernel/result', () => {
  it('carries a typed error instead of a reason string', () => {
    const r: Res<number, { kind: 'nope' }> = err({ kind: 'nope' });
    expect(r).toEqual({ ok: false, error: { kind: 'nope' } });
    expect(unwrapOr(r, 7)).toBe(7);
    expect(unwrapOr(ok(1), 7)).toBe(1);
  });

  it('map only touches the success channel', () => {
    fc.assert(
      fc.property(fc.oneof(fc.nat().map(ok), fc.string().map(err)), (r) => {
        const mapped = map(r as Res<number, string>, (n) => n * 2);
        if (r.ok) expect(mapped).toEqual({ ok: true, value: r.value * 2 });
        else expect(mapped).toBe(r);
      }),
    );
  });

  it('flatMap short-circuits on the first error', () => {
    expect(flatMap(ok(2), (n) => ok(n + 1))).toEqual({ ok: true, value: 3 });
    expect(flatMap(err('boom') as Res<number, string>, (n) => ok(n + 1))).toEqual({ ok: false, error: 'boom' });
    expect(flatMap(ok(2), () => err('inner'))).toEqual({ ok: false, error: 'inner' });
  });

  it('all collects every value, or the FIRST error', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.nat().map(ok), fc.string().map(err))), (rs) => {
        const list = rs as Res<number, string>[];
        const combined = all(list);
        const firstError = list.find((r) => !r.ok);
        if (firstError) expect(combined).toBe(firstError);
        else expect(combined).toEqual({ ok: true, value: list.map((r) => (r.ok ? r.value : null)) });
      }),
    );
  });
});
