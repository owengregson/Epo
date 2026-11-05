/**
 * `UpdaterModule` — the first thing moved onto the kernel graph.
 *
 * Chosen deliberately as the easy case: the updater has NO dependencies, no
 * session, and a textbook lifecycle (construct → `start()` a poll → `dispose()`
 * the timer), so it proves the `compose()` contract end to end before anything
 * load-bearing rides on it.
 *
 * ADR 0102's isolation rule is preserved exactly: `@/main/updater` imports
 * `electron-updater`, which requires electron at module load, so it must never
 * be reachable from a jest suite. This file is the only importer besides
 * `main/app.ts`, and neither is imported by `tests/**`.
 */

import { defineModule, type Lifetime, type NoDeps } from '@/kernel/module';
import type { AppHost } from '@/main/app-host';
import type { UpdaterPort } from '@/main/ipc';
import { EpoUpdater } from '@/main/updater';

/** What the composed graph hands back for the updater. */
export type UpdaterService = UpdaterPort & Lifetime;

/**
 * The self-updater (docs/RELEASE.md §5) as a module: its status pushes ride
 * the host's one push seam, `start()` runs the launch check plus the polling
 * cadence, and `dispose()` clears the timer — all driven by `compose()` rather
 * than by three hand-placed calls in `main.ts`.
 */
export const UpdaterModule = defineModule<UpdaterService, NoDeps, AppHost>({
  id: 'updater',
  needs: {},
  build: (_deps, host) => {
    const updater = new EpoUpdater({ onStatus: (status) => host.push('updateStatus', status) });
    return {
      check: () => updater.check(),
      install: () => updater.install(),
      openLatest: () => updater.openLatest(),
      current: () => updater.current(),
      start: () => updater.start(),
      dispose: () => updater.dispose(),
    };
  },
});
