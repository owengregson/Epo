/**
 * The two-hop profile read, run for real against a stubbed `fetch`. Hop 1
 * (username → pk by search) must only ever report "gone" on a READABLE search
 * result: the enricher marks a `gone` account permanently un-enrichable, so a
 * drifted or walled search body reported as a 404 would erase candidates.
 */
import vm from 'node:vm';
import { classifyEnvelope, type FetchEnvelope, SURFACE } from '@/adapter/ig-surface';

interface Reply {
  status?: number;
  contentType?: string;
  body: unknown;
}

async function run(username: string, replies: Reply[]): Promise<FetchEnvelope> {
  const queue = [...replies];
  const fetch = async (url: string): Promise<unknown> => {
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`unexpected fetch: ${url}`);
    const status = reply.status ?? 200;
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: { get: () => reply.contentType ?? 'application/json' },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
  const context = vm.createContext({ fetch, AbortSignal, encodeURIComponent });
  return (await vm.runInContext(SURFACE.profileInfoScript(username), context)) as FetchEnvelope;
}

describe('profile read — hop 1 (search) never fabricates "gone"', () => {
  test('a readable search result with no exact match is the synthetic 404 (gone)', async () => {
    const env = await run('someone', [{ body: { users: [{ user: { username: 'someone_else', pk: 5 } }] } }]);
    expect(classifyEnvelope(env).kind).toBe('gone');
  });

  test('a search body WITHOUT the users container is drift — never gone', async () => {
    const env = await run('someone', [{ body: { status: 'ok', message: 'renamed' } }]);
    expect(env.ok).toBe(false);
    expect(classifyEnvelope(env).kind).toBe('drift-suspect');
  });

  test('an exact match proceeds to hop 2 and returns its body', async () => {
    const env = await run('Someone', [
      { body: { users: [{ user: { username: 'someone', pk: 42 } }] } },
      { body: { user: { pk: 42 }, status: 'ok' } },
    ]);
    expect(env.ok).toBe(true);
  });
});
