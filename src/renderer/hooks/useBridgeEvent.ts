import { useEffect, useRef } from 'preact/hooks';
import type { EpoEventChannel, EpoEventPayloads } from '@/types';

/**
 * Subscribe to one pushed bridge channel for the life of the component. The
 * handler is held in a ref, so a fresh closure per render neither resubscribes
 * nor goes stale — the `off` half can never be forgotten.
 */
export function useBridgeEvent<C extends EpoEventChannel>(
  channel: C,
  handler: (payload: EpoEventPayloads[C]) => void,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const cb = (payload: EpoEventPayloads[C]): void => latest.current(payload);
    window.epo.on(channel, cb);
    return () => window.epo.off(channel, cb);
  }, [channel]);
}
