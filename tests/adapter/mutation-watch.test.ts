/**
 * MutationWatch's own diagnosis: what it saw INSTEAD when the window expires,
 * and the blindness alarm. A mutation table that matches nothing Instagram
 * fires degrades every action to DOM-only verification without a single
 * failure — observed live 2026-09-20, a whole night of `via=dom` verdicts and
 * eight clicks into a rate wall. Blindness therefore has to announce itself.
 */
import {
  MUTATION_BLIND_STREAK,
  MUTATION_BLINDNESS,
  MutationWatch,
} from '@/adapter/mutation-watch';
import { setLevel, setSink } from '@/utils/logger';
import { NetworkTab } from '../kit/tabs';

const ORIGIN = 'https://www.instagram.com';
const FOLLOW_URL = `${ORIGIN}/api/v1/web/friendships/123/follow/`;

interface Line {
  level: string;
  message: string;
  meta: unknown;
}

let lines: Line[] = [];

beforeEach(() => {
  lines = [];
  setLevel('error');
  setSink((level, message, meta) => lines.push({ level, message, meta }));
  MUTATION_BLINDNESS.reset();
});

afterAll(() => setSink(null));

/** One armed window that expires with nothing recognised. */
async function blindWindow(tab: NetworkTab, emitUnmatched = true): Promise<MutationWatch> {
  const watch = new MutationWatch('follow', 'actor.follow', tab);
  if (emitUnmatched) {
    tab.emit({
      url: `${ORIGIN}/somewhere/new?doc_id=1&fb_dtsg=SECRET`,
      status: 200,
      requestHeaders: { 'x-fb-friendly-name': 'usePolarisFollowMutation' },
      body: {},
    });
    tab.emit({ url: `${ORIGIN}/api/v1/friendships/show/1/`, status: 200, method: 'GET', body: {} });
  }
  expect(await watch.next(5)).toBeNull();
  watch.warnUnobserved('someone');
  watch.dispose();
  return watch;
}

describe('MutationWatch — what it saw instead', () => {
  test('unmatched POSTs are remembered by path + friendly name; reads and query strings are not', async () => {
    const watch = await blindWindow(new NetworkTab());
    expect(watch.unmatchedPosts()).toEqual([
      { path: '/somewhere/new', friendlyName: 'usePolarisFollowMutation', status: 200 },
    ]);
  });
});

describe('MutationWatch — the blindness alarm', () => {
  test('consecutive unobserved windows raise ONE error carrying the unmatched POSTs', async () => {
    const tab = new NetworkTab();
    for (let i = 0; i < MUTATION_BLIND_STREAK + 2; i++) await blindWindow(tab);

    const alarms = lines.filter((l) => l.level === 'error');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].message).toMatch(/mutation table/i);
    expect(JSON.stringify(alarms[0].meta)).toContain('usePolarisFollowMutation');
    expect(JSON.stringify(alarms[0].meta)).not.toContain('SECRET');
    expect(MUTATION_BLINDNESS.streak()).toBe(MUTATION_BLIND_STREAK + 2);
  });

  test('one unobserved window is not an alarm', async () => {
    await blindWindow(new NetworkTab());
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  test('an observed mutation clears the streak and re-arms the alarm', async () => {
    const tab = new NetworkTab();
    for (let i = 0; i < MUTATION_BLIND_STREAK; i++) await blindWindow(tab);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(1);

    const watch = new MutationWatch('follow', 'actor.follow', tab);
    tab.emit({ url: FOLLOW_URL, status: 200, body: { result: 'following', status: 'ok' } });
    expect(await watch.next(50)).not.toBeNull();
    watch.dispose();
    expect(MUTATION_BLINDNESS.streak()).toBe(0);

    for (let i = 0; i < MUTATION_BLIND_STREAK; i++) await blindWindow(tab);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(2);
  });
});
