/**
 * The composition root, as a graph.
 *
 * `main.ts` is the Electron entry point — window, power events, quit dance —
 * and this is the part of it that says WHAT the app is made of. Today that is
 * one module; the migration lands the rest here one at a time (session,
 * engine-control, prune-control, manual-ops, projections, lifecycle), and
 * everything not yet a module is still passed through by `main.ts` exactly as
 * before. The shape is the point: adding a unit is a line in `ROOTS`, and its
 * start/dispose order stops being something a human maintains.
 *
 * `bootstrap.ts` (identity + the background-survival switches),
 * `window/shell.ts` and `adapter/tab.ts` are deliberately NOT modules and are
 * out of scope for every wave — the kernel wraps them, never rewrites them.
 *
 * NOT importable from `tests/**`: `UpdaterModule` reaches `electron-updater`,
 * which requires electron at module load (ADR 0102). See ADR 1007.
 */

import { type AnyModule, type Composed, compose } from '@/kernel/module';
import type { AppHost } from '@/main/app-host';
import { UpdaterModule, type UpdaterService } from '@/main/modules/updater';
import * as logger from '@/utils/logger';

export type { AppHost } from '@/main/app-host';

/** The roots of the module graph. Dependencies are pulled in automatically. */
const ROOTS: readonly AnyModule<unknown, AppHost>[] = [UpdaterModule];

/** The composed app: the module graph plus named accessors for what main wires. */
export interface App {
  /** The self-updater, for the three `update:*` IPC channels + the load replay. */
  readonly updater: UpdaterService;
  /** Module ids in start order — logged at boot, asserted in tests. */
  readonly order: readonly string[];
  /** Release every module in the exact reverse of the order it started. */
  dispose(): Promise<void>;
}

/**
 * Build and start the module graph. A module whose `start()` throws unwinds
 * what already started and rethrows, so a half-composed app can never be
 * handed to the window.
 */
export async function composeApp(host: AppHost): Promise<App> {
  const composed: Composed<AppHost> = await compose(ROOTS, host, {
    onUnwindError: (id, phase, error) =>
      logger.error(`app: module ${id} ${phase} failed`, { error: String(error) }),
  });
  logger.info('app: modules composed', { order: composed.order });
  return {
    updater: composed.get(UpdaterModule),
    order: composed.order,
    dispose: () => composed.dispose(),
  };
}
