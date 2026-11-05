/** Completed census and annotated remaining rows from one invented account. */
import type { Res } from '@/ipc/contract';
import { settingsFactsSignal } from '@/renderer/app/shell-context';
import { basePrune, baseStatus, type Scenario } from '@/renderer/gallery/fixtures';
import { livePlan, MIN, NOW } from '@/renderer/gallery/fixtures-live-data';
import { answerInGallery } from '@/renderer/gallery/gallery-bridge';
import { GALLERY_SETTINGS_FACTS } from '@/renderer/gallery/settings-fixture';

type CandidateRead = Extract<Res<'pruneCandidates'>, { ok: true }>;
const candidates: CandidateRead['candidates'] = [
  ...Array.from({ length: 37 }, (_, i) => ({ pk: `gallery-prune-${i}`, username: i === 0 ? 'longish.synthetic.candidate.name' : `candidate.${i}`,
    protectedBy: null, bioUnread: i % 5 === 0 })),
  { pk: '2001', username: 'theo.park', protectedBy: 'account', bioUnread: false },
  { pk: 'gallery-verified', username: 'verified.studio', protectedBy: 'verified', bioUnread: false },
  { pk: 'gallery-keyword', username: 'family.photographer', protectedBy: 'bio-word', bioUnread: false },
];
const actionable = candidates.filter(row => row.protectedBy === null).length;
const census: NonNullable<Res<'pruneStatus'>['census']> = {
  at: NOW - 5 * MIN, following: 902, followers: 1284, scrapedFollowing: 890, scrapedFollowers: 1284,
  rowsPerPage: 50, notFollowingBack: 80, candidates: candidates.length,
};

export const PRUNE_SCENARIOS: Scenario[] = [{
  key: 'prune-census-ready', label: 'Prune · census ready',
  status: baseStatus({ state: 'idle', plan: livePlan(), account: { username: 'yourname', confirmed: true },
    actionsToday: 26, plannedToday: 44, remainingToday: 18, pendingFollowback: 30, unfollowDue: 10,
    own: { followers: { count: census.followers, at: census.at, seenSince: { gained: 0, lost: 0 } }, following: { count: census.following, at: census.at } } }),
  prune: basePrune({ state: 'idle', following: census.following, followers: census.followers,
    candidates: actionable, remaining: actionable, rawRemaining: candidates.length, scanReady: true,
    scanAt: census.at, census, graph: { following: census.following, followers: census.followers, notFollowingBack: census.notFollowingBack } }),
  apply() {
    answerInGallery('pruneCandidates', { ok: true, candidates } satisfies CandidateRead);
    settingsFactsSignal.value = { ...GALLERY_SETTINGS_FACTS,
      protection: GALLERY_SETTINGS_FACTS.protection ? { ...GALLERY_SETTINGS_FACTS.protection, followingKnown: census.following } : null,
      cleanup: { census: { at: census.at, candidates: candidates.length, protectedAmong: 3, verifiedComplete: true, tooLarge: false } } };
  },
}];
