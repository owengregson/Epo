/**
 * The boot row's handler and typed fallback (spec §12.8), spread into
 * `src/main/ipc.ts`. The renderer reports the reveal; until the boot sequencer
 * lands nothing listens, so the acknowledgement is all there is.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';

export function bootHandlers(): Pick<IpcHandlers, 'bootRevealed'> {
  return { bootRevealed: () => undefined };
}

export function bootFallbacks(): Pick<IpcFallbacks, 'bootRevealed'> {
  return { bootRevealed: () => undefined };
}
