jest.mock('electron', () => ({ app: new (require('node:events').EventEmitter)() }));
jest.mock('@/main/bootstrap', () => ({ openToolWindow: jest.fn(), awaitLogin: jest.fn(async () => true),
  ensureInstagramOrigin: jest.fn(async () => {}) }));
jest.mock('@/adapter/identity', () => ({ resolveOwnUsername: jest.fn(async () => 'owner') }));
jest.mock('@/adapter/tab-interactor', () => ({ createTabInteractor: jest.fn(() => ({})) }));
jest.mock('@/timing/primitives', () => ({ ...jest.requireActual('@/timing/primitives'), sleep: jest.fn(async () => {}) }));

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { app, type WebContents } from 'electron';
import { Actor } from '@/adapter/actor';
import { Reader } from '@/adapter/reader';
import { Sentinel } from '@/adapter/sentinel';
import type { InstagramTab } from '@/adapter/tab';
import { createTabInteractor } from '@/adapter/tab-interactor';
import { awaitLogin, openToolWindow } from '@/main/bootstrap';
import { launchVerify } from '@/probe/verify-launch';
import { TabProfileVisitor } from '@/rim/profile-visit';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import type { ResponseHandler } from '@/shared/tab-response';
import { sleep } from '@/timing/primitives';

const dirs: string[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Sentinel.prototype, 'check').mockResolvedValue('ok');
  jest.spyOn(TabProfileVisitor.prototype, 'visit').mockImplementation(async (name) => name.startsWith('epo_nx_')
    ? { ok: false, kind: 'gone', evidence: 'profile-absent', detail: {} } : profile(name));
  for (const method of ['clickNotifications', 'clickNotificationsFollowsFilter', 'clickFollowRequestsEntry',
    'clickNotificationsClose', 'clickOwnProfileLink'] as const) jest.spyOn(Actor.prototype, method).mockResolvedValue(true);
  for (const method of ['follow', 'unfollow', 'confirmNextFollowRequest'] as const) {
    jest.spyOn(Actor.prototype, method).mockImplementation(async () => { throw new Error('mutation forbidden'); });
  }
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(app.listenerCount('web-contents-created')).toBe(0);
});

function profile(username: string): ProfileVisit {
  return { ok: true, obs: { accountPk: username, observedAt: 0, source: 'profile',
    fields: { username, followers: 50, following: 40, bio: '', isVerified: false, isPrivate: false } },
  viewer: { following: true, requested: false, followsUs: true, incomingRequest: false }, tier: 'canonical', partial: false,
  presence: { counts: 'read', bio: 'read', isVerified: 'read', isPrivate: 'read', relationship: 'read' } };
}

function harness(opts: { initial?: () => void; ready?: Promise<void>; recorder?: boolean } = {}) {
  const out = mkdtempSync(path.join(tmpdir(), 'epo-verify-'));
  dirs.push(out);
  const dbg = Object.assign(new EventEmitter(), { isAttached: () => true,
    sendCommand: jest.fn(async () => ({ body: '{"status":"ok"}', base64Encoded: false })) });
  const wc = { debugger: dbg } as unknown as WebContents;
  const handlers = new Set<ResponseHandler>();
  const tab = { goto: jest.fn(async () => {}), currentUrl: () => 'https://www.instagram.com/owner/',
    evaluate: jest.fn(async () => ({ found: false })), captureScreenshot: jest.fn(async () => Buffer.from('png')),
    onResponse: (f: ResponseHandler) => { handlers.add(f); return () => handlers.delete(f); },
  } as unknown as InstagramTab;
  const traffic = (status: number, mimeType = 'application/json') => {
    dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'unsafe',
      request: { url: 'https://www.instagram.com/api/graphql', method: 'POST' } });
    dbg.emit('message', {}, 'Network.responseReceived', { requestId: 'unsafe', response: { status, mimeType } });
    dbg.emit('message', {}, 'Network.loadingFinished', { requestId: 'unsafe' });
  };
  jest.mocked(openToolWindow).mockImplementation(() => {
    if (opts.recorder !== false) app.emit('web-contents-created', {}, wc);
    opts.initial?.();
    return { tab, win: { contentView: { children: [{ webContents: wc }] } },
      isOpen: () => true, ready: opts.ready ?? Promise.resolve() } as unknown as ReturnType<typeof openToolWindow>;
  });
  const result = () => JSON.parse(readFileSync(path.join(out, 'verify.json'), 'utf8'));
  return { out, tab, traffic, result, handlers, dbg };
}

test('expected nonexistent gone passes, all steps complete, and no mutation method is called', async () => {
  const h = harness();
  const own = profile('owner');
  if (own.ok && own.presence) own.presence = { ...own.presence, relationship: 'self' };
  jest.mocked(TabProfileVisitor.prototype.visit).mockResolvedValueOnce(own);
  await launchVerify(h.out, 'target');
  expect(h.result()).toMatchObject({ outcome: 'passed', coverage: { initialHome: true },
    'visit-nonexistent': { ok: false, kind: 'gone' }, 'own-profile-link': { clicked: true } });
  expect(h.tab.captureScreenshot).toHaveBeenCalledTimes(9);
  expect(Actor.prototype.follow).not.toHaveBeenCalled();
  expect(Actor.prototype.unfollow).not.toHaveBeenCalled();
  expect(Actor.prototype.confirmNextFollowRequest).not.toHaveBeenCalled();
  expect(h.handlers.size).toBe(0);
});

test.each(['absent', 'partial'] as const)('target relationship %s stops before nonexistent visit or drawer', async (relationship) => {
  const h = harness();
  const target = profile('target');
  if (target.ok && target.presence) target.presence = { ...target.presence, relationship };
  jest.mocked(TabProfileVisitor.prototype.visit).mockResolvedValueOnce(profile('owner')).mockResolvedValueOnce(target);
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(TabProfileVisitor.prototype.visit).toHaveBeenCalledTimes(2);
  expect(Actor.prototype.clickNotifications).not.toHaveBeenCalled();
  expect(h.result().stop.step).toBe('visit-target');
});

test('a failed own visit stops before target or drawer and keeps partial evidence', async () => {
  const h = harness();
  jest.mocked(TabProfileVisitor.prototype.visit).mockResolvedValueOnce({ ok: false, kind: 'walled', detail: {} });
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(TabProfileVisitor.prototype.visit).toHaveBeenCalledTimes(1);
  expect(Actor.prototype.clickNotifications).not.toHaveBeenCalled();
  expect(h.result()).toMatchObject({ outcome: 'stopped', stop: { reason: 'step-result', step: 'visit-own' } });
  expect(JSON.parse(readFileSync(path.join(h.out, 'traffic.json'), 'utf8'))).toEqual([]);
});

test('missing recorder stops before identity or visits', async () => {
  const h = harness({ recorder: false });
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(TabProfileVisitor.prototype.visit).not.toHaveBeenCalled();
  expect(h.result().stop.reason).toBe('recorder-unavailable');
});

test('an initial non-ok sentinel stops before login or visits', async () => {
  const h = harness();
  jest.mocked(Sentinel.prototype.check).mockResolvedValueOnce('challenge');
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(awaitLogin).not.toHaveBeenCalled();
  expect(TabProfileVisitor.prototype.visit).not.toHaveBeenCalled();
  expect(h.result()).toMatchObject({ stop: { reason: 'sentinel', detail: 'challenge' } });
});

test.each([[429, 'application/json'], [200, 'text/html']])('initial unsafe traffic stops unresolved readiness (%s/%s)', async (status, mime) => {
  const h = harness({ ready: new Promise(() => {}), initial: () => h.traffic(status, mime) });
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(awaitLogin).not.toHaveBeenCalled();
  expect(TabProfileVisitor.prototype.visit).not.toHaveBeenCalled();
  expect(h.result()).toMatchObject({ outcome: 'stopped', stop: { reason: 'traffic', step: 'initial-home' }, exchanges: 1 });
});

test('a wall during an unresolved visit cancels its input signal without starting another step', async () => {
  const h = harness();
  jest.mocked(TabProfileVisitor.prototype.visit).mockImplementationOnce(() => {
    h.traffic(429);
    return new Promise(() => {});
  });
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(jest.mocked(createTabInteractor).mock.calls[0][1]?.abortSignal?.()?.aborted).toBe(true);
  expect(TabProfileVisitor.prototype.visit).toHaveBeenCalledTimes(1);
  expect(Actor.prototype.clickNotifications).not.toHaveBeenCalled();
});

test('a wall during a settle interrupts before the next visit', async () => {
  const h = harness();
  jest.mocked(sleep).mockResolvedValueOnce().mockImplementationOnce(async (_ms, signal) => {
    h.traffic(429);
    expect(signal?.aborted).toBe(true);
  });
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(TabProfileVisitor.prototype.visit).toHaveBeenCalledTimes(1);
});

test('a false drawer press prevents every later drawer press', async () => {
  const h = harness();
  jest.mocked(Actor.prototype.clickNotificationsFollowsFilter).mockResolvedValueOnce(false);
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(Actor.prototype.clickFollowRequestsEntry).not.toHaveBeenCalled();
  expect(Actor.prototype.clickNotificationsClose).not.toHaveBeenCalled();
  expect(h.result().stop.step).toBe('drawer-follows');
});

test('a screenshot failure preserves the successful visit and prevents subsequent visits', async () => {
  const h = harness();
  jest.mocked(h.tab.captureScreenshot).mockRejectedValueOnce(new Error('capture unavailable'));
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(h.result()).toMatchObject({ outcome: 'stopped', 'visit-own': { ok: true }, stop: { reason: 'exception' } });
  expect(TabProfileVisitor.prototype.visit).toHaveBeenCalledTimes(1);
});

test('a reverse-shadow disagreement stops an active visit through the shared sink', async () => {
  const h = harness();
  const read = jest.spyOn(Reader.prototype, 'read').mockImplementation(function (this: Reader) {
    this.env.sink.drift({ endpoint: 'activity-feed', cls: 'shadow-disagreed', path: 'rows', detail: {} }, 0);
    return { ok: false, kind: 'mismatch', endpoint: 'activity-feed', issues: [], keys: [] };
  });
  jest.mocked(TabProfileVisitor.prototype.visit).mockImplementationOnce(() => {
    for (const f of h.handlers) f({ requestId: 'feed', url: 'https://www.instagram.com/api/v1/news/inbox/', status: 200,
      mimeType: 'application/json', getBody: async () => '{"status":"ok"}' });
    return new Promise(() => {});
  });
  await expect(launchVerify(h.out, 'target')).rejects.toThrow('verify stopped');
  expect(read).toHaveBeenCalledTimes(1);
  expect(h.result().stop.reason).toBe('shadow-disagreed');
  expect(TabProfileVisitor.prototype.visit).toHaveBeenCalledTimes(1);
});
