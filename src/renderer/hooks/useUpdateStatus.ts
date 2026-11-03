import { useEffect, useState } from 'preact/hooks';
import type { Res } from '@/ipc/contract';
import { useBridgeEvent } from '@/renderer/hooks/useBridgeEvent';

type UpdateStatus = Res<'updateStatus'>;

/**
 * The self-updater's status (spec §13): pushed by main as it changes, and pulled once at mount, so the
 * footer and Settings know the truth from the first frame (main no longer replays it on load). A push that
 * lands before the pull wins.
 */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useBridgeEvent('updateStatus', setStatus);
  useEffect(() => {
    let alive = true;
    // Main answers a typed fallback, so a rejected pull means the bridge went away: the push stays the source.
    window.epo.updateStatus().then(
      (s) => alive && setStatus((current) => current ?? s),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return status;
}
