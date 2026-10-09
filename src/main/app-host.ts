/**
 * The host environment every module builds against.
 *
 * The kernel imports nothing from `src/`, so `Module<T, D, H>` leaves `H`
 * open and the application names it here: the Electron seams the composition
 * root must not own itself (ADR 0102's `userDataDir` and `IgSessionPort`) plus
 * the one renderer push seam (ADR 1008).
 *
 * Kept in its own file so a module can name the host without importing
 * `app.ts` — which pulls in `electron-updater` at module load and must stay
 * unreachable from `tests/**` (ADR 0102).
 */

import type { PushFn } from '@/main/modules/projections';
import type { IgSessionPort } from '@/main/services/ig-session';

export interface AppHost {
  /** Where the knowledge DB, the settings file and the window state live. */
  userDataDir: string;
  /** The persistent IG session: the identity cookie and the logout wipe. */
  igSession: IgSessionPort;
  /** Push a projection to the renderer, typed by the contract's push table. */
  push: PushFn;
}
