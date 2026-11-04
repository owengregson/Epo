import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { WebContents } from 'electron';
import { TrafficRecorder } from '@/probe/recorder';
import { inlineRequestData } from '@/probe/request-data';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const out = mkdtempSync(path.join(tmpdir(), 'epo-lifecycle-'));
  dirs.push(out);
  const dbg = Object.assign(new EventEmitter(), { sendCommand: jest.fn(async (method: string) =>
    method === 'Network.getRequestPostData' ? { postData: 'doc_id=fallback' }
      : { body: '{"status":"ok"}', base64Encoded: false }) });
  const wc = Object.assign(new EventEmitter(), { debugger: dbg });
  const failure = jest.fn();
  const rec = new TrafficRecorder(wc as unknown as WebContents, out, failure);
  rec.start();
  const emit = (method: string, params: object, sessionId = '') => dbg.emit('message', {}, method, params, sessionId);
  const request = (extra: object, sessionId = '') => emit('Network.requestWillBeSent', { requestId: 'one',
    timestamp: 123, frameId: 'frame', loaderId: 'loader', type: 'Fetch',
    request: { url: 'https://www.instagram.com/api/graphql?private=not-for-trace', method: 'POST', ...extra } }, sessionId);
  const finish = (sessionId = '') => {
    emit('Network.responseReceived', { requestId: 'one', timestamp: 124,
      response: { status: 200, mimeType: 'application/json' } }, sessionId);
    emit('Network.loadingFinished', { requestId: 'one', timestamp: 125 }, sessionId);
  };
  return { rec, dbg, wc, emit, request, finish, failure };
}

test('complete event-carried POST entries avoid a renderer metadata lookup', async () => {
  const h = harness();
  h.request({ hasPostData: true, postDataEntries: [{ bytes: Buffer.from('doc_id=event&').toString('base64') },
    { bytes: Buffer.from('secret=hidden').toString('base64') }] });
  h.finish(); h.rec.stop(); await h.rec.drain();
  expect(h.rec.exchanges[0]).toMatchObject({ form: { doc_id: 'event' }, postDataSource: 'postDataEntries',
    hasPostData: true, sessionId: '', resourceType: 'Fetch', frameId: 'frame', loaderId: 'loader' });
  expect(h.dbg.sendCommand).not.toHaveBeenCalledWith('Network.getRequestPostData', expect.anything());
  expect(h.failure).not.toHaveBeenCalled();
  expect(JSON.stringify(h.rec.trace.events)).not.toContain('hidden');
  expect(JSON.stringify(h.rec.trace.events)).not.toContain('not-for-trace');
});

test('positive upload presence survives a failed getter even for an unexpected GET body', async () => {
  const h = harness();
  h.dbg.sendCommand.mockRejectedValueOnce(new Error('metadata unavailable'));
  h.request({ method: 'GET', hasPostData: true });
  h.finish(); h.rec.stop(); await h.rec.drain();
  expect(h.rec.exchanges[0]).toMatchObject({ hasPostData: true, captureErrors: [expect.stringContaining('request metadata:')] });
});

test.each([
  [{ bytes: Buffer.from('doc_id=partial').toString('base64') }, {}],
  [{ bytes: '%%%broken' }],
  [],
].map((entries) => ({ entries })))('incomplete POST entries still require a successful metadata getter ($entries)', async ({ entries }) => {
  const h = harness();
  h.request({ hasPostData: true, postDataEntries: entries });
  h.finish(); h.rec.stop(); await h.rec.drain();
  expect(h.dbg.sendCommand).toHaveBeenCalledWith('Network.getRequestPostData', { requestId: 'one' });
  expect(h.rec.exchanges[0]).toMatchObject({ form: { doc_id: 'fallback' }, postDataSource: 'getter' });
});

test('POST entries are concatenated before UTF-8 decoding, without replacing invalid bytes', () => {
  const bytes = Buffer.from('value=é');
  expect(inlineRequestData({ postDataEntries: [{ bytes: bytes.subarray(0, -1).toString('base64') },
    { bytes: bytes.subarray(-1).toString('base64') }] })).toEqual({ value: 'value=é', source: 'postDataEntries' });
  expect(inlineRequestData({ postDataEntries: [{ bytes: Buffer.from([255]).toString('base64') }] })).toBeUndefined();
});

test('same request ID in separate debugger sessions remains distinct and getters use their owning session', async () => {
  const h = harness();
  h.request({ hasPostData: true }, 'child');
  h.request({ postData: 'doc_id=main' });
  h.finish(); h.finish('child'); h.rec.stop(); await h.rec.drain();
  expect(h.rec.exchanges).toHaveLength(2);
  expect(h.rec.exchanges.map((ex) => ex.sessionId)).toEqual(['child', '']);
  expect(h.dbg.sendCommand).toHaveBeenCalledWith('Network.getRequestPostData', { requestId: 'one' }, 'child');
  expect(h.dbg.sendCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'one' }, 'child');
  expect(h.failure).not.toHaveBeenCalled();
});

test('lifecycle evidence preserves event clocks, cancellation, navigation and command order without payloads', async () => {
  const h = harness();
  h.wc.emit('did-start-navigation', { url: 'https://www.instagram.com/profile/?secret=hidden', isMainFrame: true,
    isSameDocument: false, frame: { processId: 7, routingId: 8 } });
  h.request({ hasPostData: true });
  h.emit('Network.loadingFailed', { requestId: 'one', timestamp: 126, errorText: 'net::ERR_ABORTED', canceled: true });
  h.wc.emit('did-frame-navigate', {}, 'https://www.instagram.com/profile/', 200, 'OK', true, 9, 10);
  h.rec.stop(); await h.rec.drain();
  expect(h.rec.trace.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'navigation-start', frameProcessId: 7, frameRoutingId: 8 }),
    expect.objectContaining({ event: 'Network.requestWillBeSent', timestamp: 123 }),
    expect.objectContaining({ event: 'Network.loadingFailed', canceled: true, errorText: 'net::ERR_ABORTED' }),
    expect.objectContaining({ event: 'navigation-committed', frameProcessId: 9 }),
  ]));
  const methods = h.rec.trace.events.map((e) => e.event);
  expect(methods.indexOf('command-issued')).toBeLessThan(methods.indexOf('command-resolved'));
  expect(JSON.stringify(h.rec.trace.events)).not.toContain('hidden');
  expect(h.wc.listenerCount('did-start-navigation')).toBe(0);
  expect(h.dbg.listenerCount('message')).toBe(0);
  expect(h.failure).toHaveBeenCalledTimes(1);
});
