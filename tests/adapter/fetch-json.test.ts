/**
 * `fetchJson` (spec §10.5): the in-page script hands back the body TEXT for any parseable 2xx, and
 * it is decoded once here — a guarded or streamed list page reads; an undecodable 2xx is drift.
 */
import { fetchJson } from '@/adapter/fetch-json';
import { SURFACE } from '@/adapter/ig-surface';
import { TAB } from '@/timing/config';
import { FakeTab } from '../kit/fakes';

const tabAnswering = (envelope: unknown): FakeTab => {
  const tab = new FakeTab();
  tab.onEvaluate = () => envelope;
  return tab;
};
const ok = (text: string, contentType = 'application/json') => ({ ok: true, status: 200, contentType, finalUrl: 'u', text });

test('a JSON page is decoded once and handed back with its text', async () => {
  const res = await fetchJson(tabAnswering(ok('{"users":[],"has_more":false}')), 'script');
  expect(res).toMatchObject({ ok: true, status: 200, json: { users: [], has_more: false },
    decoded: { ok: true, format: 'json', final: null } });
});

test('a guarded javascript body reads (the json-only gate is gone, U07 E1)', async () => {
  const res = await fetchJson(tabAnswering(ok('for (;;);{"users":[]}', 'text/javascript')), 'script');
  expect(res).toMatchObject({ ok: true, json: { users: [] }, decoded: { format: 'guarded' } });
});

test('a 2xx that does not decode is drift-suspect, never data', async () => {
  const res = await fetchJson(tabAnswering(ok('{"users":[')), 'script');
  expect(res).toMatchObject({ ok: false, kind: 'drift-suspect', status: 200 });
});

test('an envelope that already carries parsed JSON is taken as is', async () => {
  const res = await fetchJson(tabAnswering({ ok: true, status: 200, contentType: 'application/json', json: { a: 1 } }), 'script');
  expect(res).toMatchObject({ ok: true, json: { a: 1 } });
});

test('the composed list script returns text for any parseable 2xx and takes its abort bound', () => {
  const script = SURFACE.listPageScript('42', 'followers', null, false, 1_234);
  expect(script).toContain('AbortSignal.timeout(1234)');
  expect(script).toContain('text: t');
  expect(script).not.toContain('r.json()');
  expect(SURFACE.listPageScript('42', 'followers', null)).toContain(`AbortSignal.timeout(${TAB.FETCH_ABORT_MS})`);
});
