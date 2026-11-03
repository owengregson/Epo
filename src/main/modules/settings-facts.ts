/**
 * The settings facts projection (spec §6.9, Appendix B.6, B.8): what the store knows beside the protection
 * rules and the seed, counted with the one protection predicate. Honest-unknown until the store opens
 * (`built: false`, nulls, never zeros); pushed on store mutation and on every settings change.
 */
import { CENSUS_POLICY } from '@/kernel/census-policy';
import { censusFollowerPages } from '@/kernel/derive-reads';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { KeptPageResult, ProtectionFacts, SettingsFacts, SuggestResult } from '@/shared/settings-facts';
import type { ProtectedAccount } from '@/shared/settings-model';
import { matchedWord, normalizeHandle, type ProtectionIndex, type ProtectionSubject, protectionVerdict } from '@/shared/unfollow-protection';
import type { FollowingRow } from '@/store/repos/protection-facts';
import { notBuiltFacts } from './not-built';
import { type SeedCheckService, seedStoreView } from './seed-check';
import type { SettingsService } from './settings-service';

type Settings = Pick<SettingsService, 'view' | 'protection'>;

/** What the rules cover, whatever the review state: the facts are how the review is made. */
const asReady = (idx: ProtectionIndex): ProtectionIndex => ({ ...idx, state: 'ready' });
const subjectOf = (r: { pk: string; username: string | null; bio: string | null; isVerified: boolean | null }): ProtectionSubject =>
  ({ pk: r.pk, username: r.username, bio: r.bio ?? undefined, isVerified: r.isVerified ?? undefined });

/** The protection counts over the followed accounts, and each listed entry's standing in the store. */
export function protectionFactsOf(graph: BuiltGraph, accounts: readonly ProtectedAccount[], index: ProtectionIndex): ProtectionFacts {
  const rows: FollowingRow[] = graph.store.protectionFacts.followingRows(graph.ownPk);
  const ready = asReady(index);
  const byRule = { account: 0, verified: 0, bioWord: 0 };
  let protectedFollowing = 0;
  for (const r of rows) {
    const v = protectionVerdict(subjectOf(r), ready);
    if (v.kind !== 'protected') continue;
    protectedFollowing += 1;
    if (v.by === 'account') byRule.account += 1;
    else if (v.by === 'verified') byRule.verified += 1;
    else if (v.by === 'bio-word') byRule.bioWord += 1;
  }
  const byWord = Object.fromEntries(index.words.map((w) => [w,
    rows.filter((r) => r.bio !== null && matchedWord(r.bio, { words: [w], wordMatch: index.wordMatch }) !== null).length]));
  const following = new Map(rows.map((r) => [r.pk, r]));
  const entries = Object.fromEntries(accounts.map((a) => {
    const pk = a.valid ? (a.pk ?? graph.store.pkByUsername(a.username)) : null;
    const row = pk === null ? undefined : following.get(pk);
    const currentUsername = pk === null ? null : (graph.store.getAccount(pk)?.username ?? null);
    const status: ProtectionFacts['entries'][string]['status'] = !a.valid ? 'invalid' : pk === null ? 'not-seen'
      : row === undefined ? 'not-followed' : 'linked';
    return [a.username, { status, currentUsername, youFollow: pk === null ? null : row !== undefined, followsYou: row?.followsUs ?? null }];
  }));
  return {
    followingKnown: rows.length, protectedFollowing, byRule, byWord, bioUnread: rows.filter((r) => r.bio === null).length,
    entries, kept: graph.store.protectionFacts.keptCounts(),
  };
}

/** The last census: its candidates, how many the rules protect, and whether one walk can cover the list. */
function censusOf(graph: BuiltGraph, index: ProtectionIndex): NonNullable<SettingsFacts['cleanup']>['census'] {
  const snap = graph.store.getPruneScan();
  if (snap === null) return null;
  const ready = asReady(index);
  const protectedAmong = snap.remaining.filter(({ pk, username }) => {
    const a = graph.store.getAccount(pk);
    return protectionVerdict(subjectOf({ pk, username: username ?? a?.username ?? null, bio: a?.bio ?? null,
      isVerified: a?.isVerified ?? null }), ready).kind === 'protected';
  }).length;
  return { at: snap.at, candidates: snap.candidateCount, protectedAmong, verifiedComplete: true,
    tooLarge: censusFollowerPages(snap.following, BOUNDS_REENTRY.MIN_ROWS_PER_PAGE) > CENSUS_POLICY.maxWalkPages };
}

export function shapeSettingsFacts(d: { graph: BuiltGraph | null; settings: Settings; seed: Pick<SeedCheckService, 'status'> }): SettingsFacts {
  const view = d.settings.view();
  if (d.graph === null) return { ...notBuiltFacts('loading'), seed: d.seed.status(null, view.seed) };
  const graph = d.graph;
  const index = d.settings.protection();
  return {
    built: true,
    seed: d.seed.status(seedStoreView(graph), view.seed),
    ownAccount: { isPrivate: graph.store.getAccount(graph.ownPk)?.isPrivate ?? null },
    protection: protectionFactsOf(graph, view.protection.accounts, index),
    cleanup: { census: censusOf(graph, index) },
  };
}

/** The facts row and its two lookups over the live graph (main's composition root holds one). */
export function settingsFactsSource(graph: () => BuiltGraph | null, settings: () => Settings, seed: () => Pick<SeedCheckService, 'status'>) {
  return {
    facts: (): SettingsFacts => shapeSettingsFacts({ graph: graph(), settings: settings(), seed: seed() }),
    /** Known accounts by handle prefix, each marked when the rules already protect it. */
    suggest(query: string, scope: 'following' | 'known'): SuggestResult {
      const g = graph();
      if (g === null) return { kind: 'unavailable' };
      const { handle } = normalizeHandle(query);
      if (handle === '') return { kind: 'ok', rows: [] };
      const ready = asReady(settings().protection());
      const rows = g.store.protectionFacts.suggest(g.ownPk, handle, scope, SETTINGS_POLICY.FACTS.SUGGEST_LIMIT)
        .map(({ bio, ...r }) => ({ ...r, protected: protectionVerdict(subjectOf({ ...r, bio }), ready).kind === 'protected' }));
      return { kind: 'ok', rows };
    },
    kept(page: number): KeptPageResult {
      const g = graph();
      return g === null ? { kind: 'unavailable' } : { kind: 'ok', ...g.store.protectionFacts.keptPage(page, SETTINGS_POLICY.FACTS.KEPT_PAGE_SIZE) };
    },
  };
}
