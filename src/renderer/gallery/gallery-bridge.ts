import {
  basePrune,
  baseStatus,
  GALLERY_CHAIN,
  GALLERY_QUEUE,
  GALLERY_SETTINGS,
} from '@/renderer/gallery/fixtures';
import type { EpoBridge } from '@/types';

/**
 * A `window.epo` stand-in for the gallery route.
 *
 * The gallery must render with no main process behind it, but the views still
 * pull (`chain:detail`, `queue:list`, `growth:series`) as part of the §2
 * push-with-pull-backstop contract — and a rejected pull would show loading
 * states instead of the design. So every invoke resolves from a fixture, and
 * every unknown method resolves to `undefined` through the proxy rather than
 * throwing: adding an IPC channel must never break the gallery.
 *
 * Subscriptions are accepted and never fired — in the gallery a "push" is the
 * scenario picker writing the signals directly.
 */
const RESPONSES: Record<string, unknown> = {
  status: baseStatus(),
  engineStatus: baseStatus(),
  pruneStatus: basePrune(),
  getSettings: GALLERY_SETTINGS,
  updateSettings: GALLERY_SETTINGS,
  resetSettings: GALLERY_SETTINGS,
  chainList: GALLERY_CHAIN,
  chainDetail: null,
  queueList: { rows: GALLERY_QUEUE, truncated: true },
  growthSeries: { points: [], baselineAt: null },
  graphSnapshot: null,
  pruneCandidates: [],
  checkSeed: { ok: true, exists: true, followersVisible: true, isPrivate: false },
  checkForUpdate: { state: 'idle', mode: 'notify', current: '0.0.0', version: null, percent: null, error: null },
};

/** Install the fixture bridge on `window.epo`. Idempotent. */
export function installGalleryBridge(): void {
  const bridge = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'on' || prop === 'off' || prop === 'onPruneStatus' || prop === 'offPruneStatus') {
          return () => {};
        }
        return () => Promise.resolve(RESPONSES[prop]);
      },
    },
  );
  (window as unknown as { epo: EpoBridge }).epo = bridge as EpoBridge;
}
