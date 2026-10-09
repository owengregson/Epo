import { useState } from 'preact/hooks';
import { useBridgeEvent } from '@/renderer/hooks/useBridgeEvent';
import type { UpdateStatus } from '@/types';

/**
 * Live self-updater status, pushed from the main process ('updateStatus').
 * Null until the first push lands — main replays the current status on every
 * renderer load, so that window is one frame, not one check interval.
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useBridgeEvent('updateStatus', setStatus);
  return status;
}
