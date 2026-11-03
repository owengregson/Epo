import type { QueueLanes } from '@/renderer/app/live-signals';
import {
  basePrune,
  baseStatus,
  GALLERY_CHAIN,
  GALLERY_QUEUE,
  GALLERY_SETTINGS,
} from '@/renderer/gallery/fixtures';
import { GALLERY_BASIS } from '@/renderer/gallery/fixtures-settings';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import type { EpoBridge } from '@/types';

/** One page of fixture rows, cut like main cuts a long lane. */
const LANE = { rows: GALLERY_QUEUE, truncated: true };

/** The People lanes as the shell would have preloaded them. */
export const GALLERY_LANES: QueueLanes = {
  next: LANE,
  waiting: LANE,
  back: LANE,
  leaving: LANE,
  kept: { kind: 'ok', rows: [], total: 0 },
};

/**
 * A `window.epo` stand-in for the gallery route.
 *
 * The gallery must render with no main process behind it, but the pages still
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
  chainList: GALLERY_CHAIN,
  chainDetail: null,
  queueList: LANE,
  keptList: GALLERY_LANES.kept,
  growthSeries: { points: [], baselineAt: null },
  graphSnapshot: null,
  // Annotated as main serves them: two to prune (one bio not read yet), one kept by the protection list.
  pruneCandidates: [
    { pk: '9001', username: 'sunny.loops', protectedBy: null, bioUnread: false },
    { pk: '9002', username: 'quiet.harbor', protectedBy: null, bioUnread: true },
    { pk: '2001', username: 'theo.park', protectedBy: 'account', bioUnread: false },
  ],
  checkSeed: { kind: 'ok', pk: '1001', isPrivate: false, followersVisible: true, followers: 12_400, observedAt: 0, fromStore: true },
  checkForUpdate: { state: 'idle', mode: 'notify', current: '0.0.0', version: null, percent: null, error: null },
  // The Settings stage: no main process saves here, so every change answers honestly that nothing was saved.
  settingsView: GALLERY_SETTINGS_VIEW,
  settingsFacts: GALLERY_SETTINGS_FACTS,
  settingsBasis: { kind: 'ok', rows: GALLERY_BASIS },
  applySettings: { kind: 'not-saved', view: GALLERY_SETTINGS_VIEW, detail: 'the gallery has no main process to save to' },
  previewSettings: { kind: 'unavailable' },
  suggestAccounts: { kind: 'ok', rows: [] },
  updateStatus: { state: 'unchecked', mode: 'notify', current: '3.1.1', version: null, percent: null, error: null, checkedAt: null },
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
