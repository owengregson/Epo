/**
 * Shared tab/interactor fakes for the adapter suites. Not a test file, so Jest
 * imports it without trying to run it (`testPathIgnorePatterns` covers
 * `tests/kit/`).
 *
 * The dispatch contract is the trailing page call a built script ends with
 * (`__epoPage.<fn>({…})`) — see {@link pageCall}. Anything unscripted throws, so
 * an unexpected script path fails loudly instead of resolving `undefined`.
 */

import type { ActorInteractor } from '@/adapter/actor';
import type { LocatedRect } from '@/adapter/ig-surface';
import type { Navigable, Observable } from '@/adapter/tab-ports';
import type { ResponseHandler, TabResponse, Unsubscribe } from '@/types';

/** Match a script by a raw fragment of its source. */
export const marker =
  (m: string) =>
  (s: string): boolean =>
    s.includes(m);

/**
 * Every control the version module drives is now a DESCRIPTOR interpreted by
 * one page entry point (`__epoPage.locate` / `__epoPage.probe`), so a script is
 * identified by the CONTROL it names rather than by a per-control function.
 * The old function names are kept as the test vocabulary and mapped here — a
 * test asking for `locateActionButton` is asking for the action button, and
 * that stays true whichever way the bundle dispatches.
 */
const CONTROL_OF: Readonly<Record<string, { entry: 'locate' | 'probe'; control: string }>> = {
  locateActionButton: { entry: 'locate', control: 'action-button' },
  probeActionButton: { entry: 'probe', control: 'action-button' },
  locateConfirm: { entry: 'locate', control: 'unfollow-confirm' },
  locateStat: { entry: 'locate', control: 'followers-stat' },
  locateScrollContainer: { entry: 'locate', control: 'list-scroller' },
  locateDrawerScroll: { entry: 'locate', control: 'drawer-scroller' },
  locateProfileLink: { entry: 'locate', control: 'profile-link' },
  readProfileHref: { entry: 'locate', control: 'profile-href' },
  clickProfileLink: { entry: 'locate', control: 'profile-link-click' },
  readAvatarAlt: { entry: 'locate', control: 'avatar-alt' },
  locateConfirmRequest: { entry: 'locate', control: 'confirm-follow-request' },
};

/**
 * Match one page-bundle call. A built script is
 * `<PAGE_BUNDLE>;__epoPage.<entry>({…descriptor})`, so the trailing call plus
 * the descriptor's control id names the control, and extra `cfgContains`
 * fragments distinguish two calls of the same one
 * (`pageCall('locateStat', '"which":"followers"')`). Matching the whole source
 * would be useless — every script carries the same bundle prefix.
 */
export const pageCall =
  (fn: string, ...cfgContains: string[]) =>
  (s: string): boolean => {
    const mapped = CONTROL_OF[fn];
    const head =
      mapped === undefined
        ? s.includes(`__epoPage.${fn}({`)
        : s.includes(`__epoPage.${mapped.entry}({`) && s.includes(`"control":"${mapped.control}"`);
    return head && cfgContains.every((c) => s.includes(c));
  };

interface ScriptHandler {
  match: (s: string) => boolean;
  result: () => unknown;
}

/**
 * A tab whose `evaluate` dispatches on the script source. Records every script
 * it saw (`evaluated`) and counts post-state probes (`probes`) so a test can
 * assert which path the Actor took.
 */
export class ScriptedTab implements Navigable {
  url = '';
  evaluated: string[] = [];
  gotoCalls: string[] = [];
  /** How many times the post-state probe ran (the DOM verification's footprint). */
  probes = 0;
  readonly scripts: ScriptHandler[] = [];

  /** Script a result for every evaluate whose source satisfies `match`. */
  on(match: (s: string) => boolean, result: () => unknown): this {
    this.scripts.push({ match, result });
    return this;
  }

  async goto(u: string): Promise<void> {
    this.url = u;
    this.gotoCalls.push(u);
  }

  currentUrl(): string {
    return this.url;
  }

  async evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T> {
    const script = String(fnOrString);
    this.evaluated.push(script);
    if (script.includes('__epoPage.probe({')) this.probes += 1;
    for (const h of this.scripts) {
      if (h.match(script)) return h.result() as T;
    }
    throw new Error(`unscripted evaluate: ${script.slice(0, 80)}`);
  }
}

/** A {@link ScriptedTab} that also carries the network-observation seam. */
export class NetworkTab extends ScriptedTab implements Observable {
  readonly responseHandlers = new Set<ResponseHandler>();

  onResponse(handler: ResponseHandler): Unsubscribe {
    this.responseHandlers.add(handler);
    return () => {
      this.responseHandlers.delete(handler);
    };
  }

  /** Emit a captured response to every subscriber, like the CDP observer does. */
  emit(partial: Partial<TabResponse> & { url: string; status: number; body: unknown }): void {
    const { body, ...rest } = partial;
    const response: TabResponse = {
      requestId: 'r1',
      mimeType: 'application/json',
      method: 'POST',
      getBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      ...rest,
    };
    for (const h of this.responseHandlers) h(response);
  }
}

/**
 * A tab whose `evaluate` always answers the same canned value (default `null`,
 * i.e. the "control not found" shape). Used to prove the health-checks fail
 * loud when the page reports nothing.
 */
export class CannedTab implements Navigable {
  evaluateReturn: unknown;
  urlReturn: string;
  gotoCalls: string[] = [];

  constructor(opts: { evaluateReturn?: unknown; urlReturn?: string } = {}) {
    this.evaluateReturn = opts.evaluateReturn ?? null;
    this.urlReturn = opts.urlReturn ?? 'https://www.instagram.com/';
  }

  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
  }

  async evaluate<T>(): Promise<T> {
    return this.evaluateReturn as T;
  }

  currentUrl(): string {
    return this.urlReturn;
  }
}

/** A recording {@link ActorInteractor}: every click/scroll is captured, none dispatched. */
export class FakeInteractor implements ActorInteractor {
  clicks: LocatedRect[] = [];
  scrolls: { container: LocatedRect; deltaPx: number; restPoint?: { x: number; y: number } }[] = [];
  /** Fired after each click, so a test can emit the mutation response "from the page". */
  onClick: (() => void) | null = null;

  async click(target: LocatedRect): Promise<void> {
    this.clicks.push(target);
    this.onClick?.();
  }

  async scroll(
    container: LocatedRect,
    deltaPx: number,
    restPoint?: { x: number; y: number },
  ): Promise<void> {
    this.scrolls.push({ container, deltaPx, restPoint });
  }
}
