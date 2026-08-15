import { AdapterBackedFollowNotifications } from '@/rim/follow-notifications';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { KnowledgeStore } from '@/store/knowledge-store';
import { FakeTab, FakeSentinel, mkResp } from './fakes';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const INBOX_URL = 'https://www.instagram.com/api/v1/news/inbox/';
const reader = new Reader();

/** A news-inbox body: follow stories split across the new/old sections. */
const inboxBody = (newStories: unknown[], oldStories: unknown[]): unknown => ({
  counts: {},
  new_stories: newStories,
  old_stories: oldStories,
});

const followStory = (pk: string, atSec: number): unknown => ({
  story_type: 101,
  args: {
    profile_id: pk,
    profile_name: `u${pk}`,
    timestamp: atSec,
    text: `u${pk} started following you.`,
  },
});

const likeStory = (pk: string): unknown => ({
  story_type: 60,
  args: { profile_id: pk, text: `u${pk} liked your photo.`, timestamp: 1_000 },
});

/** A scripted notifications actor: each click optionally emits the inbox response. */
class FakeNotificationsActor {
  clicks = 0;
  onClick?: () => void;
  async clickNotifications(): Promise<boolean> {
    this.clicks += 1;
    this.onClick?.();
    return true;
  }

  // --- Drawer niceties (soft: default "not present") ---
  filterClicks = 0;
  closeClicks = 0;
  async clickNotificationsFollowsFilter(): Promise<boolean> {
    this.filterClicks += 1;
    return false; // no filter chip in the scripted drawer
  }
  async clickNotificationsClose(): Promise<boolean> {
    this.closeClicks += 1;
    return true; // X exists and closes
  }
  async scrollNotificationsList(): Promise<boolean> {
    return false; // list fits — nothing to scroll
  }

  // --- Follow-requests surface (scripted) ---
  entryClicks = 0;
  entryExists = false;
  onEntryClick?: () => void;
  async clickFollowRequestsEntry(): Promise<boolean> {
    if (!this.entryExists) return false;
    this.entryClicks += 1;
    this.onEntryClick?.();
    return true;
  }

  /** Head-of-list script: shift()ed per confirm click; probes see the head. */
  requestQueue: string[] = [];
  confirmClicks = 0;
  async confirmNextFollowRequest(): Promise<{
    clicked: boolean;
    username: string | null;
    remaining: number;
  }> {
    const head = this.requestQueue[0];
    if (head === undefined) return { clicked: false, username: null, remaining: 0 };
    this.confirmClicks += 1;
    const remaining = this.requestQueue.length;
    this.requestQueue.shift(); // the click consumes the row
    return { clicked: true, username: head, remaining };
  }

  /** What the source's verify-probe evaluate should report right now. */
  probeResult(): { found: boolean; username: string | null; remaining: number } {
    const head = this.requestQueue[0];
    return head === undefined
      ? { found: false, username: null, remaining: 0 }
      : { found: true, username: head, remaining: this.requestQueue.length };
  }
}

const build = (opts?: { sentinel?: FakeSentinel; waitMs?: number; store?: KnowledgeStore }) => {
  const tab = new FakeTab();
  const actor = new FakeNotificationsActor();
  // The accept loop's verify-probe evaluates the confirm-request locate script
  // read-only; answer it from the scripted actor's live queue.
  tab.onEvaluate = (script) =>
    script.includes('actor:locate-confirm-request') ? actor.probeResult() : undefined;
  const source = new AdapterBackedFollowNotifications({
    tab,
    actor,
    reader,
    sentinel: (opts?.sentinel ?? new FakeSentinel()) as unknown as Sentinel,
    store: opts?.store,
    responseWaitMs: opts?.waitMs ?? 500,
    acceptVerifyMs: 300,
    sleep: async () => {}, // poll spins without real waiting
  });
  return { tab, actor, source };
};

test('clicks the bell, observes the inbox response, and returns the follow events', async () => {
  const { tab, actor, source } = build();
  actor.onClick = () => {
    if (actor.clicks === 1) {
      tab.emit(
        mkResp(
          INBOX_URL,
          inboxBody([followStory('111', 2_000)], [followStory('222', 1_500), likeStory('333')]),
        ),
      );
    }
  };

  const res = await source.fetchRecent();

  expect(res.ok).toBe(true);
  expect(res.events).toEqual([
    { pk: '111', username: 'u111', atMs: 2_000_000 },
    { pk: '222', username: 'u222', atMs: 1_500_000 },
  ]);
  // The drawer is left via its X control — the bell is clicked only to open.
  expect(actor.clicks).toBe(1);
  expect(actor.closeClicks).toBe(1);
  // The Follows filter was attempted (soft-absent in this scripted drawer).
  expect(actor.filterClicks).toBe(1);
});

test('an inbox with no follow stories is a VALID empty result (ok: true)', async () => {
  const { tab, actor, source } = build();
  actor.onClick = () => {
    if (actor.clicks === 1) tab.emit(mkResp(INBOX_URL, inboxBody([], [likeStory('9')])));
  };

  const res = await source.fetchRecent();

  expect(res).toMatchObject({ ok: true, events: [] });
});

test('no response within the wait window is a TYPED failure, never an empty success', async () => {
  const { source } = build({ waitMs: 200 });
  // Click succeeds; the response never arrives.
  const res = await source.fetchRecent();

  expect(res.ok).toBe(false);
  expect(res.reason).toBe('no-response');
  expect(res.events).toEqual([]);
});

test('a blocked sentinel skips the check without touching the tab', async () => {
  const { actor, source } = build({ sentinel: new FakeSentinel(['challenge']) });

  const res = await source.fetchRecent();

  expect(res.ok).toBe(false);
  expect(res.reason).toBe('sentinel:challenge');
  expect(actor.clicks).toBe(0);
});

test('an unlocatable notifications control is a typed failure (control-not-located)', async () => {
  const tab = new FakeTab();
  const source = new AdapterBackedFollowNotifications({
    tab,
    actor: {
      clickNotifications: async () => false,
      clickNotificationsFollowsFilter: async () => false,
      clickNotificationsClose: async () => false,
      scrollNotificationsList: async () => false,
      clickFollowRequestsEntry: async () => false,
      confirmNextFollowRequest: async () => ({ clicked: false, username: null, remaining: 0 }),
    },
    reader,
    sentinel: new FakeSentinel() as unknown as Sentinel,
    responseWaitMs: 200,
    sleep: async () => {},
  });

  const res = await source.fetchRecent();

  expect(res).toMatchObject({ ok: false, reason: 'control-not-located' });
});

test('non-inbox responses are ignored; only the activity feed is parsed', async () => {
  const { tab, actor, source } = build();
  actor.onClick = () => {
    if (actor.clicks !== 1) return;
    tab.emit(mkResp('https://www.instagram.com/api/v1/users/web_profile_info/?username=x', { data: {} }));
    tab.emit(mkResp(INBOX_URL, inboxBody([followStory('7', 1_000)], [])));
  };

  const res = await source.fetchRecent();

  expect(res.ok).toBe(true);
  expect(res.events.map((e) => e.pk)).toEqual(['7']);
});

// --- Follow requests (private accounts): observe + auto-accept ----------------------

const PENDING_URL = 'https://www.instagram.com/api/v1/friendships/pending/';

/** A friendships/pending body (followers-list shape). */
const pendingBody = (rows: Array<{ pk: string; username: string }>): unknown => ({
  users: rows.map((r) => ({ pk: r.pk, username: r.username, is_private: true, is_verified: false })),
  next_max_id: null,
  has_more: false,
});

const emptyInbox = (): unknown => ({ counts: {}, new_stories: [], old_stories: [] });

test('accepts pending requests via Confirm clicks and returns WHO with resolved pks', async () => {
  const store = new KnowledgeStore(':memory:');
  const { tab, actor, source } = build({ store });
  actor.entryExists = true;
  actor.requestQueue = ['req_a', 'req_b'];
  actor.onClick = () => {
    if (actor.clicks === 1) tab.emit(mkResp(INBOX_URL, emptyInbox()));
  };
  actor.onEntryClick = () =>
    tab.emit(
      mkResp(PENDING_URL, pendingBody([
        { pk: '901', username: 'req_a' },
        { pk: '902', username: 'req_b' },
      ])),
    );

  const res = await source.fetchRecent({ acceptRequests: true });

  expect(res.ok).toBe(true);
  expect(res.accepted).toEqual([
    { pk: '901', username: 'req_a' },
    { pk: '902', username: 'req_b' },
  ]);
  expect(actor.confirmClicks).toBe(2);
  // §1 facts stream: the requester rows were stored as they parsed.
  expect(store.getAccount('901')?.username).toBe('req_a');
  expect(store.getAccount('902')?.username).toBe('req_b');
  store.close();
});

test('without acceptRequests the requests subtab is never touched', async () => {
  const { tab, actor, source } = build();
  actor.entryExists = true;
  actor.requestQueue = ['req_a'];
  actor.onClick = () => {
    if (actor.clicks === 1) tab.emit(mkResp(INBOX_URL, emptyInbox()));
  };

  const res = await source.fetchRecent();

  expect(res.ok).toBe(true);
  expect(res.accepted).toEqual([]);
  expect(actor.entryClicks).toBe(0);
  expect(actor.confirmClicks).toBe(0);
});

test('no Follow requests entry (public account / nothing pending) is a soft skip', async () => {
  const { tab, actor, source } = build();
  actor.entryExists = false;
  actor.onClick = () => {
    if (actor.clicks === 1) tab.emit(mkResp(INBOX_URL, emptyInbox()));
  };

  const res = await source.fetchRecent({ acceptRequests: true });

  expect(res).toMatchObject({ ok: true, accepted: [] });
  expect(actor.confirmClicks).toBe(0);
});

test('an accept click that never consumes its row stops the loop (no hammering)', async () => {
  const { tab, actor, source } = build();
  actor.entryExists = true;
  actor.requestQueue = ['stuck'];
  // Sabotage: the click reports success but the row never disappears.
  actor.confirmNextFollowRequest = async () => ({ clicked: true, username: 'stuck', remaining: 1 });
  actor.probeResult = () => ({ found: true, username: 'stuck', remaining: 1 });
  actor.onClick = () => {
    if (actor.clicks === 1) tab.emit(mkResp(INBOX_URL, emptyInbox()));
  };
  actor.onEntryClick = () =>
    tab.emit(mkResp(PENDING_URL, pendingBody([{ pk: '1', username: 'stuck' }])));

  const res = await source.fetchRecent({ acceptRequests: true });

  expect(res.ok).toBe(true);
  expect(res.accepted).toEqual([]); // never verified → never counted
});
