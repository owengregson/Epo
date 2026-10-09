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
  makeFakeTab,
  makeIgSession,
  newFoundation,
} from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('clearData while a build is in flight never resurrects a graph over the deleted DB', async () => {
  // Gate the FIRST identity evaluate so the build can be caught in flight; every
  // evaluate answers with the nav profile-link href (identity strategy 1).
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached!: () => void;
  const reachedGate = new Promise<void>((r) => {
    reached = r;
  });
  let evaluates = 0;
  const tab = makeFakeTab({
    evaluate: async <T>(): Promise<T> => {
      evaluates += 1;
      if (evaluates === 1) {
        reached();
        await gate;
      }
      return '/myself/' as T;
    },
  });

  const { foundation: f, userDataDir } = newFoundation({ tab });
  const building = f.ensureBuilt(); // parked inside username resolution
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
  let evaluates = 0;
  const tab = makeFakeTab({
    evaluate: async <T>(): Promise<T> => {
      evaluates += 1;
      return '/myself/' as T;
    },
  });
  const igSession = makeIgSession('4242');

  const { foundation: f } = newFoundation({ tab, igSession });
  expect(await f.ensureBuilt()).toBe(true); // graph anchored to pk 4242
  const evaluatesAfterFirstBuild = evaluates;

  // The user logs out and back in as a DIFFERENT account inside the tab.
  igSession.setDsUserId('9999');
  await f.isLoggedIn(); // any routine pk resolve must notice the switch

  // The stale graph (anchored to 4242) is gone; the next ensureBuilt rebuilds —
  // observable as a fresh identity resolution against the tab.
  expect(await f.ensureBuilt()).toBe(true);
  expect(evaluates).toBeGreaterThan(evaluatesAfterFirstBuild);

  await f.dispose();
});
