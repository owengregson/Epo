import type { InstagramTab } from '@/adapter/tab';
import {
  cleanupMainHarness,
  makeFakeTab,
  makeIgSession,
  newFoundation,
} from '../kit/main-harness';

/**
 * The intro tour runs over a QUIET app: while the `tour:hold` is up, nothing
 * self-starts — the lazy graph build, the startup profile landing, and the
 * scheduled-prune watcher all wait until the tour closes. These exercise the
 * hold's not-built paths: with no session the un-held landing would poll its
 * bounded retry loop for seconds — the held one must return instantly, before
 * ever touching the tab.
 */

afterAll(cleanupMainHarness);

const countingTab = (): { tab: InstagramTab; touched(): number } => {
  let touches = 0;
  const bump = <T>(value: T): T => {
    touches++;
    return value;
  };
  const tab = makeFakeTab({
    show: () => bump(undefined),
    hide: () => bump(undefined),
    goto: async () => bump(undefined),
    currentUrl: () => bump('https://www.instagram.com/'),
    evaluate: async <T>(): Promise<T> => bump(null as T),
  });
  return { tab, touched: () => touches };
};

describe('Foundation tour hold', () => {
  test('landOnOwnProfile defers instantly while held — the tab is never touched', async () => {
    const { tab, touched } = countingTab();
    const { foundation: f } = newFoundation({ tab, igSession: makeIgSession(null) });
    f.setTourHold(true);
    await f.landOnOwnProfile(); // no retry poll, no navigation, no click
    expect(touched()).toBe(0);
    await f.dispose();
  });

  test('the store opens while held (store-first), and the tab is never touched', async () => {
    const { tab, touched } = countingTab();
    const { foundation: f } = newFoundation({ tab });
    f.setTourHold(true);
    await expect(f.ensureBuilt()).resolves.toBe(true);
    expect(touched()).toBe(0);
    await f.dispose();
  });

  test('setTourHold is idempotent and safe before any graph exists', async () => {
    const { tab } = countingTab();
    const { foundation: f } = newFoundation({ tab, igSession: makeIgSession(null) });
    f.setTourHold(true);
    f.setTourHold(true); // repeat engage: no-op
    f.setTourHold(false); // release with nothing deferred: quiet
    f.setTourHold(false); // repeat release: no-op
    await f.dispose();
  });
});
