/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Recent activity (spec §12.2, Appendix C.15.6): each typed feed item reads as its deck sentence, rows group
 * under their plan-day, the "Since you left" divider is a strict time boundary, and a grouped row expands to
 * list its people.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/preact';
import { App } from '@/renderer/app/App';
import { peopleTargetSignal, stageSignal } from '@/renderer/app/shell-context';
import { rowFace } from '@/renderer/sidebar/copy/feed-copy';
import { feedEntries } from '@/renderer/sidebar/feed-entries';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { FeedItem, FeedView, Person } from '@/shared/feed';
import type { Settings } from '@/types';
import { type FakeBridge, idleStatus, installFakeBridge } from '../kit/render-bridge';

const SEEDED: Settings = { ...DEFAULT_SETTINGS, seed: 'someone', tourCompletedAt: 1 };
const HOUR = 3_600_000;
const T = Date.now();
const DAYS = [
  { key: 'd0', startsAt: T - 2 * HOUR },
  { key: 'd1', startsAt: T - 26 * HOUR },
  { key: 'd2', startsAt: T - 50 * HOUR },
];
const person = (username: string | null, pk = username ?? 'x'): Person => ({ pk, username });

/** The row's words: its line and its detail, as one string. */
function words(item: FeedItem): string {
  const face = rowFace(item);
  const say = (parts: typeof face.line): string =>
    parts.map((p) => (typeof p === 'string' ? p : p.person.username === null ? 'someone' : `@${p.person.username}`)).join('');
  return face.detail === null ? say(face.line) : `${say(face.line)} · ${say(face.detail)}`;
}

const at = { id: 'i', at: T };

describe('each feed item reads as its deck sentence', () => {
  it.each<[string, FeedItem, string]>([
    ['one follow', { ...at, kind: 'followed', people: [person('jane')], via: 'plan', practice: false }, 'Followed @jane'],
    [
      'a grouped follow during Boost',
      { ...at, kind: 'followed', people: ['a', 'b', 'c', 'd'].map((u) => person(u)), via: 'boost', practice: false },
      'Followed 4 people · @a, @b +2 · Boost',
    ],
    ['your own follow', { ...at, kind: 'followed', people: [person('jane')], via: 'you', practice: false }, 'You followed @jane'],
    ['a practice follow', { ...at, kind: 'followed', people: [person('jane')], via: 'plan', practice: true }, 'Practice: would follow @jane'],
    [
      'an unfollow',
      { ...at, kind: 'unfollowed', people: [person('carl')], why: 'no-follow-back', practice: false },
      'Unfollowed @carl · Didn’t follow back',
    ],
    ['a pruned unfollow', { ...at, kind: 'unfollowed', people: [person('carl')], why: 'clean-up', practice: false }, 'Unfollowed @carl · Pruned'],
    ['a follow-back', { ...at, kind: 'followed-back', person: person('bob'), afterMs: 2 * 24 * HOUR, dated: true }, '@bob followed you back · 2 days after you followed'],
    ['a new follower', { ...at, kind: 'new-followers', people: [person('dana')], dated: true }, '@dana started following you'],
    ['undated new followers', { ...at, kind: 'new-followers', people: [person('a'), person('b'), person('c')], dated: false }, 'Found 3 new followers · @a, @b +1'],
    ['lost followers', { ...at, kind: 'lost-followers', count: 2 }, '2 people stopped following you'],
    ['an accepted request', { ...at, kind: 'request-accepted', people: [person('erin')] }, 'Accepted @erin’s follow request'],
    [
      'an unconfirmed follow',
      { ...at, kind: 'not-done', action: 'follow', person: person('jane'), why: 'unconfirmed' },
      'Couldn’t follow @jane · Instagram didn’t confirm it',
    ],
    ['a kept account', { ...at, kind: 'kept', person: person('friend'), reason: 'account' }, 'Kept @friend · protected · On your protection list'],
    ['Boost ended by the clock', { ...at, kind: 'boost', edge: 'ended', endsAt: null, why: 'clock' }, 'Boost ended · Your computer’s clock changed'],
    ['Boost finished', { ...at, kind: 'boost', edge: 'ended', endsAt: null, why: 'expired' }, 'Boost finished'],
    ['a restart', { ...at, kind: 'resumed', after: 'restart' }, 'Epo picked up where it left off · After closing unexpectedly'],
    [
      'a quiet catch-up',
      { ...at, kind: 'caught-up', summary: { awayFrom: T - HOUR, checkedAt: T, newFollowers: 0, followBacks: 0, left: 0 } },
      'While you were away · Nothing new',
    ],
    [
      'a catch-up with news',
      { ...at, kind: 'caught-up', summary: { awayFrom: T - HOUR, checkedAt: T, newFollowers: 14, followBacks: 6, left: 2 } },
      'While you were away · 14 new followers · 6 follow-backs · 2 left',
    ],
    ['an unknown username', { ...at, kind: 'followed', people: [person(null, '9')], via: 'plan', practice: false }, 'Followed someone'],
  ])('%s', (_name, item, expected) => {
    expect(words(item)).toBe(expected);
  });
});

describe('the list order', () => {
  const row = (id: string, t: number): FeedItem => ({ id, at: t, kind: 'lost-followers', count: 1 });

  it('groups rows under their plan-day, today first', () => {
    const view: FeedView = {
      items: [row('a', T - HOUR), row('b', T - 3 * HOUR), row('c', T - 30 * HOUR), row('d', T - 49 * HOUR)],
      awayFrom: null, windowStart: T - 72 * HOUR, shapedAt: T, days: DAYS,
    };
    const labels = feedEntries(view, T).map((e) => (e.kind === 'row' ? e.key : e.label));
    expect(labels.slice(0, 4)).toEqual(['Today', 'a', 'Yesterday', 'b']);
    expect(labels).toContain('c');
    expect(labels.filter((l) => l === 'Yesterday')).toHaveLength(1);
  });

  it('puts the divider exactly where the rows from before you left begin', () => {
    const view: FeedView = {
      items: [row('new', T - HOUR), row('old', T - 1.5 * HOUR)],
      awayFrom: T - 1.2 * HOUR, windowStart: T - 72 * HOUR, shapedAt: T, days: DAYS,
    };
    const kinds = feedEntries(view, T).map((e) => (e.kind === 'row' ? e.key : e.kind));
    expect(kinds).toEqual(['group', 'new', 'divider', 'old']);
  });
});

describe('rendered rows', () => {
  let bridge: FakeBridge;
  beforeEach(() => {
    bridge = installFakeBridge(SEEDED);
    bridge.data.status = idleStatus({ lastActionAt: T - 60_000 });
  });

  async function mount(view: FeedView): Promise<void> {
    render(<App />);
    await waitFor(() => expect(bridge.calls.some((c) => c[0] === 'getSettings')).toBe(true));
    await act(async () => bridge.emit('feed', view));
  }

  it('an empty feed says so in plain words', async () => {
    await mount({ items: [], awayFrom: null, windowStart: T - HOUR, shapedAt: T, days: DAYS });
    expect(document.querySelector('.sb-feed__empty')?.textContent).toBe('Nothing yet today. Activity shows up here as Epo works.');
  });

  it('a grouped row shows two handles and how many more, and expands to list the whole group', async () => {
    // Main closes a group at the live policy's people bound, so an expanded row lists every member.
    const people = Array.from({ length: 6 }, (_, i) => person(`p${i}`));
    await mount({
      items: [{ id: 'g', at: T - 1_000, kind: 'followed', people, via: 'plan', practice: false }],
      awayFrom: null, windowStart: T - HOUR, shapedAt: T, days: DAYS,
    });
    expect(document.querySelector('.sb-row__detail')?.textContent).toBe('@p0, @p1 +4');
    expect(document.querySelector('.sb-row__people')).toBeNull();
    await act(async () => {
      fireEvent.click(document.querySelector('.sb-row__more') as HTMLButtonElement);
    });
    expect(document.querySelector('.sb-row__people')?.querySelectorAll('.sb-handle')).toHaveLength(6);
  });

  it('a handle opens the People page', async () => {
    await mount({
      items: [{ id: 'a', at: T - 1_000, kind: 'followed', people: [person('jane')], via: 'plan', practice: false }],
      awayFrom: null, windowStart: T - HOUR, shapedAt: T, days: DAYS,
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-zone="activity"] .sb-handle') as HTMLButtonElement);
    });
    expect(stageSignal.value).toBe('people');
    expect(peopleTargetSignal.value).toEqual(person('jane'));
    await waitFor(() => expect(document.querySelector('[data-person-pk="jane"]')?.textContent).toContain('stored details'));
  });
});
