import { ok, err } from '@/utils/result';
test('result helpers', () => {
  expect(ok(5)).toEqual({ ok: true, value: 5 });
  expect(err('x')).toEqual({ ok: false, reason: 'x' });
});
