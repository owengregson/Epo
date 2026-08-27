import { Foundation } from '@/main/foundation-wiring';
import type { InstagramTab } from '@/adapter/tab';

/**
 * The intro tour runs over a QUIET app: while the `tour:hold` is up, nothing
 * self-starts — the lazy graph build, the startup profile landing, and the
 * scheduled-prune watcher all wait until the tour closes. These exercise the
 * hold's not-built paths WITHOUT a browser: under jest the electron session is
 * unavailable, so the un-held landing would poll its bounded retry loop for
 * seconds — the held one must return instantly, before ever touching the tab.
 */
describe('Foundation tour hold', () => {
  const makeTab = (): { tab: InstagramTab; touched(): number } => {
    let touches = 0;
    const tab = {
      show: () => {
        touches++;
      },
      hide: () => {
        touches++;
      },
      goto: async () => {
        touches++;
      },
      currentUrl: () => {
        touches++;
        return 'https://www.instagram.com/';
      },
      evaluate: async () => {
        touches++;
        return null;
      },
      onResponse: () => () => {},
    } as unknown as InstagramTab;
    return { tab, touched: () => touches };
  };

  test('landOnOwnProfile defers instantly while held — the tab is never touched', async () => {
    const { tab, touched } = makeTab();
    const f = new Foundation({ tab });
    f.setTourHold(true);
    await f.landOnOwnProfile(); // no retry poll, no navigation, no click
    expect(touched()).toBe(0);
    await f.dispose();
  });

  test('ensureBuilt refuses to build while held', async () => {
    const { tab } = makeTab();
    const f = new Foundation({ tab });
    f.setTourHold(true);
    await expect(f.ensureBuilt()).resolves.toBe(false);
    await f.dispose();
  });

  test('setTourHold is idempotent and safe before any graph exists', async () => {
    const { tab } = makeTab();
    const f = new Foundation({ tab });
    f.setTourHold(true);
    f.setTourHold(true); // repeat engage: no-op
    f.setTourHold(false); // release with nothing deferred: quiet
    f.setTourHold(false); // repeat release: no-op
    await f.dispose();
  });
});
