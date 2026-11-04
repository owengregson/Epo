/** Main-document readiness and evaluation, independent of slow child-frame resources. */
import type { Event as ElectronEvent, WebContents, WebContentsDidStartNavigationEventParams } from 'electron';
import { TIMED_OUT, withTimeout } from '../timing/primitives';
import * as logger from '../utils/logger';
import { ActionAbortedError, TabUnavailableError, TabUnresponsiveError } from './errors';

const aborted = (error: unknown): boolean => {
  const e = error as { code?: string; errno?: number };
  return e?.code === 'ERR_ABORTED' || e?.errno === -3;
};

/** A new top-level document can be used after DOM readiness; loadURL still reports navigation failures. */
async function mainDocumentReady(wc: WebContents, navigate: () => Promise<void> | void,
  timeoutMs: number, component: 'goto' | 'recovery-reload'): Promise<void> {
  let committed = false;
  let ready = false;
  let resolveReady = (): void => {};
  let rejectReady = (_error: unknown): void => {};
  const documentReady = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const onStart = (details: ElectronEvent<WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) committed = false;
  };
  const onCommit = (_event: ElectronEvent, _url: string, _status: number, _text: string, isMainFrame: boolean): void => {
    // Error documents have no HTTP commit. Their DOM cannot prove the requested page is ready.
    if (isMainFrame) committed = _status >= 0;
  };
  const onReady = (): void => {
    if (!committed) return;
    ready = true;
    resolveReady();
  };
  const onFailure = (_event: ElectronEvent, code: number, description: string, _url: string, isMainFrame: boolean): void => {
    if (!isMainFrame || code === -3) return;
    committed = false;
    rejectReady(Object.assign(new Error(`Main document failed: ${description} (${code})`), { errno: code }));
  };
  wc.on('did-start-navigation', onStart);
  wc.on('did-frame-navigate', onCommit);
  wc.on('dom-ready', onReady);
  wc.on('did-fail-load', onFailure);
  try {
    const loading = navigate();
    const loaded = loading?.catch((error: unknown) => {
      // Supersession is not readiness. Wait for the winning main document within this same deadline.
      if (aborted(error)) {
        logger.debug('tab.goto: navigation superseded; awaiting the winning main document');
        return documentReady;
      }
      if (ready) {
        logger.warn('tab.goto: load failed after main document became ready', { error: String(error) });
      }
      throw error;
    });
    const result = await withTimeout(loaded === undefined ? documentReady : Promise.race([loaded, documentReady]), timeoutMs);
    if (result === TIMED_OUT) throw new TabUnresponsiveError(component, timeoutMs);
  } finally {
    wc.removeListener('did-start-navigation', onStart);
    wc.removeListener('did-frame-navigate', onCommit);
    wc.removeListener('dom-ready', onReady);
    wc.removeListener('did-fail-load', onFailure);
  }
}

export function loadMainDocument(wc: WebContents, url: string, timeoutMs: number): Promise<void> {
  return mainDocumentReady(wc, () => wc.loadURL(url), timeoutMs, 'goto');
}

export function reloadMainDocument(wc: WebContents, timeoutMs: number): Promise<void> {
  return mainDocumentReady(wc, () => wc.reload(), timeoutMs, 'recovery-reload');
}

/** Electron's frame API keeps its result/error semantics without WebContents' full-load deferral. */
export async function evaluateMainDocument<T>(wc: WebContents, code: string, timeoutMs: number,
  currentVersion: () => number): Promise<T> {
  const version = currentVersion();
  const frame = wc.mainFrame;
  if (frame.isDestroyed() || frame.detached) throw new TabUnavailableError('evaluate');
  const stale = (): boolean => wc.isDestroyed() || frame.isDestroyed() || frame.detached
    || currentVersion() !== version || wc.mainFrame !== frame;
  try {
    const result = await withTimeout(frame.executeJavaScript(code, false) as Promise<T>, timeoutMs);
    if (result === TIMED_OUT) throw new TabUnresponsiveError('evaluate', timeoutMs);
    if (stale()) throw new ActionAbortedError('evaluate:stale-document');
    return result;
  } catch (error) {
    if (stale()) throw new ActionAbortedError('evaluate:stale-document');
    throw error;
  }
}
