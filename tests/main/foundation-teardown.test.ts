import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Lifecycle races. `clearData()` tears the graph down, deletes the DB files,
 * and clears the IG session — but a BUILD already in flight when the wipe
 * starts used to keep running and re-open a fresh store over the just-deleted
 * path (SQLite happily recreates the file) with the OLD account identity. The
 * teardown lock must refuse that resurrection: the in-flight build settles to
 * `false` and no DB reappears.
 */

import {
  cleanupMainHarness,
  foundationStore,
  makeFakeTab,
  makeIgSession,
  newFoundation,
} from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('clearData while a build is in flight never resurrects a graph over the deleted DB', async () => {
  // Gate the FIRST identity cookie read so the store-first open can be caught
  // in flight; every read answers with the same account pk.
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached!: () => void;
  const reachedGate = new Promise<void>((r) => {
    reached = r;
  });
  let reads = 0;
  const igSession = {
    ...makeIgSession('4242'),
    readCookie: async (name: string): Promise<string | null> => {
      reads += 1;
      if (reads === 1) {
        reached();
        await gate;
      }
      return name === 'ds_user_id' ? '4242' : null;
    },
  };

  const { foundation: f, userDataDir } = newFoundation({ igSession });
  const building = f.ensureBuilt(); // parked inside the identity read
  await reachedGate;

  const clearing = f.clearData(); // the wipe starts while the build is mid-flight
  release();

  const [built] = await Promise.all([building, clearing]);
  await new Promise((r) => setTimeout(r, 0)); // let any stray resurrection land

  // The superseded build must have refused, and no store may have been re-opened
  // over the wiped path.
  expect(built).toBe(false);
  expect(fs.existsSync(path.join(userDataDir, 'epo.db'))).toBe(false);

  await f.dispose();
});

test('an in-tab account switch (ds_user_id change) tears down the stale graph and rebuilds', async () => {
  const igSession = makeIgSession('4242');
  const { foundation: f } = newFoundation({ tab: makeFakeTab(), igSession });
  expect(await f.ensureBuilt()).toBe(true); // graph anchored to pk 4242
  const first = foundationStore(f);

  // The user logs out and back in as a DIFFERENT account inside the tab.
  igSession.setDsUserId('9999');
  await f.isLoggedIn(); // any routine pk resolve must notice the switch

  // The stale graph (anchored to 4242) is gone; the next ensureBuilt opens the new account's store.
  expect(await f.ensureBuilt()).toBe(true);
  expect(foundationStore(f)).not.toBe(first);
  const session = (f as unknown as { session: { current(): { ownPk: string } | null } }).session;
  expect(session.current()?.ownPk).toBe('9999');

  await f.dispose();
});
