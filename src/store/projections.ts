import {
  type AccountState,
  type EnrichmentLevel,
  type Observation,
  SOURCE_CONFIDENCE,
  ratioOf,
} from './types';

/**
 * Derives the enrichment level from what is currently known:
 *  - `profiled` once both follower/following counts are known,
 *  - `listed` once any basic list-payload field is known,
 *  - `stub` otherwise (seen only as an edge endpoint).
 */
export const enrichmentFor = (state: AccountState): EnrichmentLevel => {
  if (state.followers !== undefined && state.following !== undefined) return 'profiled';
  if (
    state.username !== undefined ||
    state.isPrivate !== undefined ||
    state.isVerified !== undefined ||
    state.followers !== undefined ||
    state.following !== undefined ||
    state.activitySignal !== undefined
  ) {
    return 'listed';
  }
  return 'stub';
};

/**
 * Pure per-field merge of one observation onto the current projected state.
 *
 * Merge policy (§4.5.3 — "per-field, newest-sufficient-confidence-wins"): a field is
 * updated when the incoming observation is NEWER than the field's current provenance,
 * OR carries EQUAL-OR-HIGHER confidence — so a cheap, older list read never clobbers a
 * richer, newer profile value. An observation may always FILL a field that is currently
 * unset, but doing so never downgrades stronger existing provenance.
 *
 * Provenance available in the persisted `AccountState` is per-record:
 *  - numeric stat fields (followers/following/activitySignal) share
 *    `statsObservedAt`/`statsSource`;
 *  - identity/flag fields (username/isPrivate/isVerified) have no persisted per-field
 *    source, so their merge falls back to a newest-wins rule keyed on `lastSeenAt`.
 */
export const projectAccount = (existing: AccountState | null, obs: Observation): AccountState => {
  const now = obs.observedAt;
  const incomingConf = SOURCE_CONFIDENCE[obs.source];
  const f = obs.fields;

  const base: AccountState = existing
    ? { ...existing }
    : { pk: obs.accountPk, enrichment: 'stub', firstSeenAt: now, lastSeenAt: now };

  // --- numeric stat fields: governed by the shared stats provenance --------------
  const statsTime = existing?.statsObservedAt;
  const statsSource = existing?.statsSource;
  const statsConf = statsSource !== undefined ? SOURCE_CONFIDENCE[statsSource] : undefined;
  // "sufficient" = (at least as new AND at least as confident) OR strictly more
  // confident. An OLDER observation of merely EQUAL confidence must never win:
  // two profile reads of the same account can race their async body reads, and
  // the stale one would otherwise overwrite the fresher counts AND rewind
  // `statsObservedAt` backwards.
  const statsSufficient =
    statsTime === undefined ||
    statsConf === undefined ||
    (now >= statsTime && incomingConf >= statsConf) ||
    incomingConf > statsConf;

  let statsTouched = false;
  const applyStat = (key: 'followers' | 'following' | 'mutuals' | 'activitySignal'): void => {
    const incoming = f[key];
    if (incoming === undefined) return;
    if (base[key] === undefined || statsSufficient) {
      base[key] = incoming;
      statsTouched = true;
    }
  };
  applyStat('followers');
  applyStat('following');
  applyStat('mutuals');
  applyStat('activitySignal');
  // Only advance the shared stats provenance when the incoming read was actually
  // sufficient; a mere gap-fill by a weaker/older read keeps the stronger provenance.
  // Provenance time never moves backwards (a strictly-more-confident-but-older
  // read may win the VALUE, but the projection stays dated by its newest input).
  if (statsTouched && statsSufficient) {
    base.statsObservedAt = statsTime === undefined ? now : Math.max(statsTime, now);
    base.statsSource = obs.source;
  }

  // --- identity / flag fields: no persisted per-field source, so newest-wins ------
  const idBaselineTime = existing?.lastSeenAt;
  const idSufficient = idBaselineTime === undefined || now >= idBaselineTime;
  if (f.username !== undefined && (base.username === undefined || idSufficient)) {
    base.username = f.username;
  }
  if (f.isPrivate !== undefined && (base.isPrivate === undefined || idSufficient)) {
    base.isPrivate = f.isPrivate;
  }
  if (f.isVerified !== undefined && (base.isVerified === undefined || idSufficient)) {
    base.isVerified = f.isVerified;
  }

  base.ratio = ratioOf(base.followers, base.following);
  base.firstSeenAt = existing ? Math.min(existing.firstSeenAt, now) : now;
  base.lastSeenAt = existing ? Math.max(existing.lastSeenAt, now) : now;
  base.enrichment = enrichmentFor(base);
  return base;
};
