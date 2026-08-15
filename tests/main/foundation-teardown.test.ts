import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Lifecycle races (audit 2026-08-15). `clearData()` tears the graph down, deletes
 * the DB files, and clears the IG session — but a BUILD already in flight when the
 * wipe starts used to keep running and execute `this.graph = this.build(...)`
 * afterwards, re-opening a fresh store over the just-deleted path (SQLite happily
 * recreates the file) with the OLD account identity. The teardown lock must refuse
 * that resurrection: the in-flight build settles to `false` and no DB reappears.
 *
 * Electron is mocked at module scope: `app.getPath` → a temp dir, and the IG
 * partition serves a fixed `ds_user_id` cookie (the pk resolve reads only this).
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-foundation-'));

/** Mutable session identity: tests flip this to simulate an in-tab account switch. */
const cookieState = { value: '4242' };

jest.mock('electron', () => ({
  app: { getPath: () => tmp },
  session: {
    fromPartition: () => ({
      cookies: { get: async () => [{ name: 'ds_user_id', value: cookieState.value }] },
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
  },
}));

import { Foundation } from '@/main/foundation-wiring';
import type { InstagramTab } from '@/adapter/tab';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
  const tab = {
    show: () => {},
    hide: () => {},
    goto: async () => {},
    currentUrl: () => 'https://www.instagram.com/',
    evaluate: async () => {
      evaluates += 1;
      if (evaluates === 1) {
        reached();
        await gate;
      }
      return '/myself/';
    },
    onResponse: () => () => {},
  } as unknown as InstagramTab;

  const f = new Foundation({ tab });
  const building = f.ensureBuilt(); // parked inside username resolution
  await reachedGate;

  const clearing = f.clearData(); // the wipe starts while the build is mid-flight
  release();

  const [built] = await Promise.all([building, clearing]);
  await new Promise((r) => setTimeout(r, 0)); // let any stray resurrection land

  // The superseded build must have refused, and no store may have been re-opened
  // over the wiped path.
  expect(built).toBe(false);
  expect(fs.existsSync(path.join(tmp, 'epo.db'))).toBe(false);

  await f.dispose();
});

test('an in-tab account switch (ds_user_id change) tears down the stale graph and rebuilds', async () => {
  cookieState.value = '4242';
  let evaluates = 0;
  const tab = {
    show: () => {},
    hide: () => {},
    goto: async () => {},
    currentUrl: () => 'https://www.instagram.com/',
    evaluate: async () => {
      evaluates += 1;
      return '/myself/';
    },
    onResponse: () => () => {},
  } as unknown as InstagramTab;

  const f = new Foundation({ tab });
  expect(await f.ensureBuilt()).toBe(true); // graph anchored to pk 4242
  const evaluatesAfterFirstBuild = evaluates;

  // The user logs out and back in as a DIFFERENT account inside the tab.
  cookieState.value = '9999';
  await f.isLoggedIn(); // any routine pk resolve must notice the switch

  // The stale graph (anchored to 4242) is gone; the next ensureBuilt rebuilds —
  // observable as a fresh identity resolution against the tab.
  expect(await f.ensureBuilt()).toBe(true);
  expect(evaluates).toBeGreaterThan(evaluatesAfterFirstBuild);

  await f.dispose();
});
