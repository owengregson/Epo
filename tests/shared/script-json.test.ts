import { runInNewContext } from 'node:vm';
import { jsonForScript } from '@/shared/script-json';

test('untrusted text remains data in a script expression and has no raw markup delimiters', () => {
  const value = { text: `</script><script>globalThis.injected=true</script><!--\u2028\u2029"\\\n\t\` \${payload}` };
  const context = { injected: false };
  const expression = jsonForScript(value);
  expect(runInNewContext(`(${expression})`, context)).toEqual(value);
  expect(context).toEqual({ injected: false });
  expect(expression).not.toMatch(/[<>\u2028\u2029]/);
  expect(JSON.parse(expression)).toEqual(value);
});

test.each([
  null, true, false, 42, -0, NaN, Infinity,
  { value: undefined, present: 1 },
  [undefined, NaN, Infinity, () => {}],
  { toJSON: () => '<custom>' },
])('preserves JSON serialization semantics for %p', (value) => {
  expect(JSON.parse(jsonForScript(value))).toEqual(JSON.parse(JSON.stringify(value)));
});

test.each([undefined, () => {}, Symbol('omitted')])('preserves top-level undefined serialization: %p', (value) => {
  expect(jsonForScript(value)).toBe('undefined');
  expect(runInNewContext(`(${jsonForScript(value)})`)).toBeUndefined();
});

test('unsupported cyclic values and bigint still reject rather than silently changing data', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => jsonForScript(cyclic)).toThrow(TypeError);
  expect(() => jsonForScript(1n)).toThrow(TypeError);
});
