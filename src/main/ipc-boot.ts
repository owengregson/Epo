/**
 * The boot row's handler and typed fallback (spec §12.8), spread into
 * `src/main/ipc.ts`. The renderer reports that its intro ended; the boot
 * sequence goes `'live'` and runs the remaining startup steps.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';

export function bootHandlers(boot: { bootRevealed(): void }): Pick<IpcHandlers, 'bootRevealed'> {
  return { bootRevealed: () => boot.bootRevealed() };
}

export function bootFallbacks(): Pick<IpcFallbacks, 'bootRevealed'> {
  return { bootRevealed: () => undefined };
}
