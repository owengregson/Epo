import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { InstagramTab } from '@/adapter/tab';
import { VerifyEvidence } from '@/probe/verify-evidence';
import { FakeTab } from '../kit/fakes';
import { bodyOf, manifestOf } from '../surface/corpus';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type DrawerKind = 'activity-feed' | 'friend-requests';
function harness() {
  const out = mkdtempSync(path.join(tmpdir(), 'epo-verify-coverage-'));
  dirs.push(out);
  const evidence = new VerifyEvidence(out);
  const tab = new FakeTab();
  evidence.observe(tab as unknown as InstagramTab);
  const emit = (kind: DrawerKind, pending?: Promise<void>) => {
    const entry = manifestOf('2026-11-02').bodies.find((body) => body.endpoint === kind);
    if (!entry?.route?.op || typeof entry.status !== 'number' || typeof entry.mime !== 'string') {
      throw new Error(`missing routed fixture: ${kind}`);
    }
    tab.emit({ requestId: kind, url: `https://www.instagram.com${entry.route.path}`, method: 'POST',
      requestHeaders: { 'x-fb-friendly-name': entry.route.op }, status: entry.status, mimeType: entry.mime,
      getBody: async () => { await pending; return JSON.stringify(bodyOf('2026-11-02', entry.file)); },
    });
  };
  return { evidence, emit, result: () => JSON.parse(readFileSync(path.join(out, 'verify.json'), 'utf8')) };
}

test.each<DrawerKind | null>([null, 'activity-feed', 'friend-requests'])(
  'successful controls cannot substitute for missing response coverage (%s only)', async (only) => {
    const h = harness();
    Object.assign(h.evidence.result, { 'drawer-open': true, 'drawer-follows': true, 'drawer-requests': true,
      'drawer-close': true, 'drawer-closed': true });
    if (only !== null) h.emit(only);
    await h.evidence.finish();
    expect(h.result()).toMatchObject({ outcome: 'stopped', stop: { reason: 'missing-body-coverage',
      detail: ['activity-feed', 'friend-requests'].filter((kind) => kind !== only) } });
  },
);

test('both canonical observed drawer bodies satisfy coverage', async () => {
  const h = harness();
  h.emit('activity-feed'); h.emit('friend-requests');
  await h.evidence.finish();
  expect(h.result()).toMatchObject({ outcome: 'passed', stop: null });
  expect(h.result().drawerBodies).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'activity-feed', tier: 'canonical', partial: false }),
    expect.objectContaining({ kind: 'friend-requests', tier: 'canonical', partial: false }),
  ]));
});

test('coverage is checked after an already-observed response finishes parsing', async () => {
  const h = harness();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  h.emit('activity-feed'); h.emit('friend-requests', pending);
  const finishing = h.evidence.finish();
  await Promise.resolve();
  expect(h.evidence.failure).toBeNull();
  release();
  await finishing;
  expect(h.result().outcome).toBe('passed');
});

test('missing coverage cannot overwrite the original live stop', async () => {
  const h = harness();
  h.evidence.stop('sentinel', 'challenge');
  await h.evidence.finish();
  expect(h.result()).toMatchObject({ outcome: 'stopped', stop: { reason: 'sentinel', detail: 'challenge' } });
});
