/**
 * Shared harness for the `tests/main` suites.
 *
 * Six suites used to re-declare the same `jest.mock('electron')` + `mkdtemp` +
 * `fakeTab` block. `Foundation` now takes its two electron seams as injected
 * ports (`userDataDir`, `IgSessionPort`), so there is no electron mock left to
 * share — only these builders.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { InstagramTab } from '@/adapter/tab';
import type { PushContract, PushMethod } from '@/ipc/contract';
import { Foundation, type FoundationDeps } from '@/main/foundation-wiring';
import type { IgSessionPort } from '@/main/services/ig-session';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { ChainTargetView, EpoStatus, PruneStatus } from '@/types';

/** Temp directories handed out by this module, removed by {@link cleanupMainHarness}. */
const tempDirs: string[] = [];

/** A fresh userData directory for one suite (registered for cleanup). */
export function tempUserData(prefix = 'epo-main-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Remove every temp userData directory this module created. Call in `afterAll`. */
export function cleanupMainHarness(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** The `InstagramTab` surface the Foundation actually touches under test. */
export interface FakeTabParts {
  show(): void;
  hide(): void;
  goto(url: string): Promise<void>;
  currentUrl(): string;
  evaluate<T>(script: unknown): Promise<T>;
  onResponse(handler: unknown): () => void;
  onUnhealthy?(cb: (reason: string) => void): void;
  checkHealth?(): Promise<{ healthy: boolean }>;
  recoverTab?(): Promise<void>;
  probeInput?(): Promise<boolean>;
}

/**
 * A tab that resolves identity (`evaluate` answers the nav profile-link href)
 * and does nothing else. Override any member to shape a specific scenario.
 */
export function makeFakeTab(over: Partial<FakeTabParts> = {}): InstagramTab {
  return {
    show: () => {},
    hide: () => {},
    goto: async () => {},
    currentUrl: () => 'https://www.instagram.com/',
    evaluate: async () => '/myself/',
    onResponse: () => () => {},
    ...over,
  } as unknown as InstagramTab;
}

/** The injected IG session, with a mutable identity so a suite can switch accounts. */
export interface FakeIgSession extends IgSessionPort {
  /** Set (or clear, with null) the `ds_user_id` the port answers with. */
  setDsUserId(value: string | null): void;
  /** How many times {@link IgSessionPort.clear} ran. */
  clears(): number;
}

export function makeIgSession(dsUserId: string | null = '4242'): FakeIgSession {
  let value = dsUserId;
  let cleared = 0;
  return {
    readCookie: async (name: string) => (name === 'ds_user_id' ? value : null),
    clear: async () => {
      cleared += 1;
    },
    setDsUserId: (next) => {
      value = next;
    },
    clears: () => cleared,
  };
}

/**
 * The three per-projection callbacks the Foundation used to take directly.
 * They are now ONE `push` seam over the contract's push table (ADR 1008); this
 * shim keeps every suite that asserts on a specific projection reading the way
 * it did, so the §2 push tests stay the untouched oracle for the refactor.
 */
export interface PushSpies {
  onStatus?(status: EpoStatus): void;
  onPruneStatus?(status: PruneStatus): void;
  onChainList?(list: ChainTargetView[]): void;
}

/** Fold {@link PushSpies} into the single `push` dependency. */
function pushFrom(spies: PushSpies, own?: FoundationDeps['push']): FoundationDeps['push'] {
  return <C extends PushMethod>(channel: C, payload: PushContract[C]): void => {
    own?.(channel, payload);
    if (channel === 'status') spies.onStatus?.(payload as EpoStatus);
    if (channel === 'pruneStatus') spies.onPruneStatus?.(payload as PruneStatus);
    if (channel === 'chainList') spies.onChainList?.(payload as ChainTargetView[]);
  };
}

export interface MainHarness {
  foundation: Foundation;
  tab: InstagramTab;
  session: FakeIgSession;
  userDataDir: string;
}

/**
 * A Foundation over a fresh temp userData directory and a logged-in fake
 * session. Pass `igSession: makeIgSession(null)` for the logged-out paths.
 */
export function newFoundation(over: Partial<FoundationDeps> & PushSpies = {}): MainHarness {
  const userDataDir = over.userDataDir ?? tempUserData();
  const tab = over.tab ?? makeFakeTab();
  const session = (over.igSession as FakeIgSession | undefined) ?? makeIgSession();
  const foundation = new Foundation({
    ...over,
    tab,
    userDataDir,
    igSession: session,
    push: pushFrom(over, over.push),
  });
  return { foundation, tab, session, userDataDir };
}

/** {@link newFoundation} plus a completed lazy build (throws if it refuses). */
export async function builtFoundation(
  over: Partial<FoundationDeps> & PushSpies = {},
): Promise<MainHarness> {
  const harness = newFoundation(over);
  if (!(await harness.foundation.ensureBuilt())) {
    throw new Error('builtFoundation: ensureBuilt refused (no session?)');
  }
  return harness;
}

/** The REAL store a built Foundation is writing through (for §2 push assertions). */
export function foundationStore(f: Foundation): KnowledgeStore {
  const session = (f as unknown as { session: { current(): { store: KnowledgeStore } | null } })
    .session;
  const graph = session.current();
  if (graph === null) throw new Error('foundationStore: no graph (not built?)');
  return graph.store;
}
