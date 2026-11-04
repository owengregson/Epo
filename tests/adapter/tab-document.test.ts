import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { ActionAbortedError, TabUnavailableError } from '@/adapter/errors';
import { evaluateMainDocument, loadMainDocument, reloadMainDocument } from '@/adapter/tab-document';
import * as logger from '@/utils/logger';

jest.mock('@/utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }));

function deferred<T>() {
  let resolve = (_value: T): void => {};
  let reject = (_error: unknown): void => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const events = new EventEmitter();
  const load = deferred<void>();
  const evaluation = deferred<unknown>();
  const frame = { isDestroyed: jest.fn(() => false), detached: false,
    executeJavaScript: jest.fn(() => evaluation.promise) };
  const wc = Object.assign(events, {
    loadURL: jest.fn(() => load.promise), reload: jest.fn(),
    isDestroyed: jest.fn(() => false), mainFrame: frame,
  });
  const contents = wc as unknown as WebContents;
  const start = () => wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  const commit = (status = 200) => wc.emit('did-frame-navigate', {}, 'https://fixture.invalid/', status, '', true);
  const ready = () => wc.emit('dom-ready');
  const fail = (code = -105) => wc.emit('did-fail-load', {}, code, 'ERR_NAME_NOT_RESOLVED', 'https://fixture.invalid/', true);
  const cleaned = () => expect(wc.eventNames()).toEqual([]);
  return { wc, contents, load, evaluation, frame, start, commit, ready, fail, cleaned };
}

beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('superseded navigation waits for the replacement main document and cleans listeners', async () => {
  const f = fixture();
  const navigation = loadMainDocument(f.contents, 'https://fixture.invalid/', 25);
  let settled = false;
  void navigation.then(() => { settled = true; });
  f.start(); f.commit();
  f.start(); // A second navigation invalidates the old commit before its DOM-ready event.
  f.load.reject(Object.assign(new Error('superseded'), { errno: -3 }));
  f.ready();
  await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false);
  f.commit(); f.ready();
  await navigation;
  f.cleaned();
});

test('main load failure after commit rejects before DOM readiness and removes all listeners', async () => {
  const f = fixture();
  const navigation = loadMainDocument(f.contents, 'https://fixture.invalid/', 25);
  const rejected = expect(navigation).rejects.toMatchObject({ errno: -105 });
  f.start(); f.commit(); f.fail(); f.ready();
  await rejected;
  f.cleaned();
});

test('error document readiness cannot turn an aborted navigation into success', async () => {
  const f = fixture();
  const navigation = loadMainDocument(f.contents, 'https://fixture.invalid/', 25);
  const rejected = expect(navigation).rejects.toMatchObject({ component: 'goto' });
  f.load.reject(Object.assign(new Error('superseded'), { code: 'ERR_ABORTED' }));
  f.commit(-1); f.ready();
  await jest.advanceTimersByTimeAsync(25);
  await rejected;
  f.cleaned();
});

test('a late full-load rejection after DOM readiness is handled and recorded', async () => {
  const f = fixture();
  const navigation = loadMainDocument(f.contents, 'https://fixture.invalid/', 25);
  f.commit(); f.ready();
  await navigation;
  f.load.reject(new Error('late full-load failure'));
  await jest.advanceTimersByTimeAsync(0);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('after main document'), {
    error: 'Error: late full-load failure',
  });
  f.cleaned();
});

test('recovery reload needs main DOM readiness, not a load-stop event or child readiness', async () => {
  const f = fixture();
  const recovery = reloadMainDocument(f.contents, 25);
  let settled = false;
  void recovery.then(() => { settled = true; });
  expect(f.wc.reload).toHaveBeenCalledTimes(1);
  f.wc.emit('did-stop-loading');
  f.wc.emit('did-frame-navigate', {}, 'https://fixture.invalid/child', 200, '', false);
  f.ready();
  await Promise.resolve();
  expect(settled).toBe(false);
  f.start(); f.commit(); f.ready();
  await recovery;
  f.cleaned();
});

test.each(['failure', 'timeout'] as const)('recovery %s cleans every readiness listener', async (kind) => {
  const f = fixture();
  const recovery = reloadMainDocument(f.contents, 25);
  const rejected = expect(recovery).rejects.toMatchObject(kind === 'failure'
    ? { errno: -105 } : { component: 'recovery-reload' });
  f.start(); f.commit();
  if (kind === 'failure') f.fail();
  else await jest.advanceTimersByTimeAsync(25);
  await rejected;
  f.cleaned();
});

test.each(['epoch', 'frame', 'destroyed', 'detached'] as const)('evaluation rejects a stale %s at completion', async (kind) => {
  const f = fixture();
  let epoch = 0;
  const evaluation = evaluateMainDocument(f.contents, 'Promise.resolve({ value: 42 })', 25, () => epoch);
  const rejected = expect(evaluation).rejects.toBeInstanceOf(ActionAbortedError);
  if (kind === 'epoch') epoch++;
  if (kind === 'frame') f.wc.mainFrame = { ...f.frame };
  if (kind === 'destroyed') f.wc.isDestroyed.mockReturnValue(true);
  if (kind === 'detached') f.frame.detached = true;
  f.evaluation.resolve({ value: 42 });
  await rejected;
});

test('evaluation preserves script errors and does not enable user gesture privileges', async () => {
  const f = fixture();
  const error = new Error('script failed');
  const evaluation = evaluateMainDocument(f.contents, 'throw new Error("script failed")', 25, () => 0);
  const rejected = expect(evaluation).rejects.toBe(error);
  f.evaluation.reject(error);
  await rejected;
  expect(f.frame.executeJavaScript).toHaveBeenCalledWith('throw new Error("script failed")', false);
});

test('evaluation refuses a detached main frame before sending any script', async () => {
  const f = fixture();
  f.frame.detached = true;
  await expect(evaluateMainDocument(f.contents, '42', 25, () => 0)).rejects.toBeInstanceOf(TabUnavailableError);
  expect(f.frame.executeJavaScript).not.toHaveBeenCalled();
});
