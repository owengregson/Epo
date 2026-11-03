/**
 * One decoder for every body (spec §10.5): a declared JSON guard, newline-delimited and multipart
 * payloads merged by path, errors concatenated, and the final flag. It never throws.
 */
import fc from 'fast-check';
import { decodeBody } from '@/surface/transport/decode';
import { TRANSPORT } from '@/surface/versions/2026-08-12/transport-decl';

const decode = (text: string) => decodeBody(text, TRANSPORT);

describe('decodeBody', () => {
  test('a plain JSON document', () => {
    expect(decode('{"data":{"user":{"pk":"1"}}}')).toEqual({ ok: true, json: { data: { user: { pk: '1' } } },
      format: 'json', payloads: 1, final: null });
  });

  test('a declared guard is stripped at offset 0 only', () => {
    expect(decode('for (;;);{"a":1}')).toMatchObject({ ok: true, json: { a: 1 }, format: 'guarded' });
    expect(decode(' for (;;);{"a":1}')).toMatchObject({ ok: false, reason: 'invalid-json' });
  });

  test('the final flag of the last payload: false makes the body partial', () => {
    expect(decode('{"data":{},"extensions":{"is_final":true}}')).toMatchObject({ final: true });
    expect(decode('{"data":{},"extensions":{"is_final":false}}')).toMatchObject({ final: false });
  });

  test('newline-delimited payloads merge: data at its path, items appended, errors concatenated', () => {
    const text = [
      '{"data":{"user":{"pk":"1","edge":{"rows":[1]}}},"errors":[{"message":"a"}],"extensions":{"is_final":false}}',
      '{"path":["user"],"data":{"bio":"hi"},"label":"x","extensions":{"is_final":false}}',
      '{"incremental":[{"path":["user","edge","rows"],"items":[2,3]}],"errors":[{"message":"b"}]}',
      '{"extensions":{"is_final":true}}',
    ].join('\n');
    expect(decode(text)).toEqual({
      ok: true,
      json: { data: { user: { pk: '1', bio: 'hi', edge: { rows: [1, 2, 3] } } }, errors: [{ message: 'a' }, { message: 'b' }],
        extensions: { is_final: false } },
      format: 'ndjson', payloads: 4, final: true,
    });
  });

  test('multipart parts merge the same way', () => {
    const text = ['--graphql', 'Content-Type: application/json', '', '{"data":{"user":{"pk":"1"}}}', '--graphql',
      'Content-Type: application/json', '', '{"path":["user"],"data":{"bio":"x"},"extensions":{"is_final":true}}',
      '--graphql--', ''].join('\r\n');
    expect(decode(text)).toMatchObject({ ok: true, json: { data: { user: { pk: '1', bio: 'x' } } }, format: 'multipart',
      payloads: 2, final: true });
  });

  test('an empty body, invalid JSON and an unknown payload shape are typed failures', () => {
    expect(decode('  ')).toEqual({ ok: false, reason: 'empty', head: '' });
    expect(decode('<!DOCTYPE html><html>')).toMatchObject({ ok: false, reason: 'invalid-json', head: '<!DOCTYPE html><html>' });
    expect(decode('{"data":{}}\n{"surprise":1}')).toMatchObject({ ok: false, reason: 'bad-frame' });
    expect(decode('{"data":{}}\n{"path":["x"],"data":{"a":1}\n{"broken"')).toMatchObject({ ok: false, reason: 'bad-frame' });
  });

  test('a payload never reaches a prototype', () => {
    expect(decode('{"data":{}}\n{"path":["__proto__"],"data":{"polluted":true}}')).toMatchObject({ ok: false, reason: 'bad-frame' });
    const merged = decode('{"data":{"user":{}}}\n{"path":["user"],"data":{"__proto__":{"polluted":true}}}');
    expect(merged.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('framing law: decode(frame(b, f)) ≡ b', () => {
  const RUNS = { numRuns: 200, seed: 20261102 };
  const RESERVED = ['path', 'incremental', 'errors', 'extensions', 'data', 'part', '__proto__', 'constructor', 'prototype'];
  const bodyArb = fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }).filter((k) => !RESERVED.includes(k)),
    fc.jsonValue({ maxDepth: 2 }), { minKeys: 1, maxKeys: 4 });

  test('a guard prefix, an incremental split and a multipart wrapping all decode to the same body', () => {
    fc.assert(fc.property(bodyArb, bodyArb, (head, tail) => {
      const body = { data: { ...head, part: tail } };
      const json = JSON.stringify(body);
      const ndjson = `${JSON.stringify({ data: { ...head } })}\n${JSON.stringify({ path: ['part'], data: tail })}`;
      const multipart = `--b\r\nContent-Type: application/json\r\n\r\n${json}\r\n--b--`;
      return [`for (;;);${json}`, ndjson, multipart].every((text) => {
        const d = decode(text);
        return d.ok && JSON.stringify(d.json) === JSON.stringify(body);
      });
    }), RUNS);
  });

  test('random text never throws', () => {
    fc.assert(fc.property(fc.string(), (s) => {
      decode(s);
      return true;
    }), RUNS);
  });
});
