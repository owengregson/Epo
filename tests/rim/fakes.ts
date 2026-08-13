/**
 * Shared fakes for the rim tests. Not a test suite itself (no `.test.ts` suffix),
 * so Jest imports it without trying to run it.
 */
import type { ResponseHandler, TabResponse, Unsubscribe } from '@/types';
import type { RimTab } from '@/rim/types';
import type { SentinelStatus } from '@/adapter/sentinel';

/** A fake port-tab. `emit` respects unsubscribe; `emitRaw` ignores it (teardown sim). */
export class FakeTab implements RimTab {
  private readonly handlers = new Set<ResponseHandler>();
  private readonly captured: ResponseHandler[] = [];
  url = 'https://www.instagram.com/';

  async goto(u: string): Promise<void> {
    this.url = u;
  }
  async evaluate<T>(): Promise<T> {
    return undefined as unknown as T;
  }
  onResponse(handler: ResponseHandler): Unsubscribe {
    this.handlers.add(handler);
    this.captured.push(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  currentUrl(): string {
    return this.url;
  }
  /** Deliver to live (subscribed) handlers only. */
  emit(resp: TabResponse): void {
    for (const h of [...this.handlers]) h(resp);
  }
  /** Deliver to every handler ever registered, even after unsubscribe. */
  emitRaw(resp: TabResponse): void {
    for (const h of this.captured) h(resp);
  }
}

/** A budget that counts spends and can be toggled off. Cast to `RequestBudget`. */
export class FakeBudget {
  spends = 0;
  private allow: boolean;
  constructor(allow = true) {
    this.allow = allow;
  }
  canSpend(): boolean {
    return this.allow;
  }
  spend(): void {
    this.spends += 1;
  }
  remaining(): number {
    return this.allow ? 999 : 0;
  }
  setAllow(v: boolean): void {
    this.allow = v;
  }
}

/** A sentinel returning scripted statuses then a fallback. Cast to `Sentinel`. */
export class FakeSentinel {
  checks = 0;
  private readonly queue: SentinelStatus[];
  constructor(
    statuses: SentinelStatus[] = [],
    private readonly fallback: SentinelStatus = 'ok',
  ) {
    this.queue = [...statuses];
  }
  async check(): Promise<SentinelStatus> {
    this.checks += 1;
    return this.queue.length > 0 ? (this.queue.shift() as SentinelStatus) : this.fallback;
  }
}

/** A list-dialog actor whose open/scroll fire test-supplied callbacks. */
export class FakeActor {
  openCalls = 0;
  openFollowingCalls = 0;
  scrollCalls = 0;
  onOpen?: () => void;
  onScroll?: () => void;
  async openFollowersDialog(_targetUsername: string): Promise<void> {
    this.openCalls += 1;
    this.onOpen?.();
  }
  /** The FOLLOWING dialog (Phase 5); fires the same onOpen hook. */
  async openFollowingDialog(_targetUsername: string): Promise<void> {
    this.openFollowingCalls += 1;
    this.onOpen?.();
  }
  /** Returns `true` by default (a page was scrolled); set `scrollReturns` to vary. */
  scrollReturns = true;
  async scrollFollowers(): Promise<boolean> {
    this.scrollCalls += 1;
    this.onScroll?.();
    return this.scrollReturns;
  }
}

/** Build a followers-list URL that carries `targetPk` (what R1 extracts). */
export const followersUrl = (targetPk: string, maxId?: string): string =>
  `https://www.instagram.com/api/v1/friendships/${targetPk}/followers/?count=12` +
  (maxId ? `&max_id=${maxId}` : '');

/** Build a following-list URL that carries `targetPk` (Phase 5 auto-prune). */
export const followingUrl = (targetPk: string, maxId?: string): string =>
  `https://www.instagram.com/api/v1/friendships/${targetPk}/following/?count=12` +
  (maxId ? `&max_id=${maxId}` : '');

/** A followers-list response body in the exact shape the Reader parses. */
export const followersBody = (
  pks: string[],
  nextMaxId: string | null,
  hasMore: boolean,
): unknown => ({
  users: pks.map((pk) => ({
    pk,
    username: `u${pk}`,
    is_private: false,
    is_verified: false,
  })),
  next_max_id: nextMaxId,
  has_more: hasMore,
});

/** Make a TabResponse; `body` may be an object (JSON-encoded) or a raw string. */
export const mkResp = (url: string, body: unknown): TabResponse => ({
  requestId: `${url}#${Math.random()}`,
  url,
  status: 200,
  mimeType: 'application/json',
  getBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
