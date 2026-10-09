/**
 * The Account fold, and how it differs from the projection it will replace.
 *
 * `foldAccount` is not on the write path yet (wave A ships the vocabulary and
 * the fold; the events table lands in wave B — docs/adr/0701-event-log-plan.md).
 * What it must earn now is trust, which means two things:
 *
 *  - the properties the append path and the rebuild path will BOTH rely on,
 *    checked over generated streams rather than three hand-picked ones; and
 *  - an explicit, named account of every place it disagrees with today's
 *    `projectAccount`, so wave B's shadow diff has an expected list rather
 *    than a surprise.
 */

import fc from 'fast-check';
import { accountObserved, type DomainEvent } from '@/store/events';
import {
  foldAccount,
  foldAccountStream,
  foldAccounts,
  merge,
  valuesOf,
} from '@/store/folds/account';
import { projectAccount } from '@/store/projections';
import {
  type AccountFields,
  type AccountState,
  type Observation,
  SOURCE_CONFIDENCE,
  type Source,
} from '@/store/types';

const SOURCES = Object.keys(SOURCE_CONFIDENCE) as Source[];

const anyFields = (): fc.Arbitrary<AccountFields> =>
  fc.record(
    {
      username: fc.string({ minLength: 1, maxLength: 6 }),
      followers: fc.nat(10_000),
      following: fc.nat(10_000),
      mutuals: fc.nat(500),
      isPrivate: fc.boolean(),
      isVerified: fc.boolean(),
      activitySignal: fc.double({ min: 0, max: 1, noNaN: true }),
      bio: fc.string({ maxLength: 12 }),
    },
    { requiredKeys: [] },
  );

const anyObservation = (pk = '1'): fc.Arbitrary<Observation> =>
  fc.record({
    accountPk: fc.constant(pk),
    observedAt: fc.integer({ min: 1, max: 100_000 }),
    source: fc.constantFrom(...SOURCES),
    fields: anyFields(),
  });

const asEvents = (obs: readonly Observation[]): DomainEvent[] => obs.map(accountObserved);
const FIELDS = ['username', 'followers', 'following', 'mutuals', 'isPrivate', 'isVerified', 'activitySignal', 'bio'] as const;

// --- The properties the log will rest on ----------------------------------------

test('incremental fold === batch fold: splitting a stream anywhere changes nothing', () => {
  fc.assert(
    fc.property(fc.array(anyObservation(), { maxLength: 60 }), fc.nat(), (obs, cut) => {
      const events = asEvents(obs);
      const k = events.length === 0 ? 0 : cut % (events.length + 1);
      // The append path: fold as facts arrive. The rebuild path: fold the
      // retained tail onto a checkpoint. They MUST agree, or the log is a lie.
      const batch = foldAccountStream(events);
      const incremental = events.slice(k).reduce(foldAccount, foldAccountStream(events.slice(0, k)));
      expect(incremental).toEqual(batch);
    }),
  );
});

test('provenance never rewinds: confidence is non-decreasing, ever', () => {
  fc.assert(
    fc.property(fc.array(anyObservation(), { maxLength: 60 }), (obs) => {
      let state = foldAccountStream([]);
      for (const e of asEvents(obs)) {
        const before = state;
        state = foldAccount(state, e);
        for (const key of FIELDS) {
          const was = before?.fields[key];
          const now = state?.fields[key];
          if (was === undefined || now === undefined) continue;
          // A strictly better source may win with an OLDER stamp — that is the
          // point of provenance — but confidence itself never goes backwards.
          expect(now.conf).toBeGreaterThanOrEqual(was.conf);
          if (now.conf === was.conf) expect(now.at).toBeGreaterThanOrEqual(was.at);
        }
      }
    }),
  );
});

test('every field is dated by an event that actually carried it', () => {
  fc.assert(
    fc.property(fc.array(anyObservation(), { minLength: 1, maxLength: 40 }), (obs) => {
      const state = foldAccountStream(asEvents(obs));
      if (state === null) return;
      for (const key of FIELDS) {
        const prov = state.fields[key];
        if (prov === undefined) continue;
        const carriers = obs.filter((o) => o.fields[key] !== undefined);
        expect(carriers.some((o) => o.observedAt === prov.at)).toBe(true);
        expect(prov.conf).toBe(Math.max(...carriers.filter((o) => o.observedAt === prov.at).map((o) => SOURCE_CONFIDENCE[o.source]).concat(prov.conf)));
      }
      expect(state.firstSeenAt).toBe(Math.min(...obs.map((o) => o.observedAt)));
      expect(state.lastSeenAt).toBe(Math.max(...obs.map((o) => o.observedAt)));
    }),
  );
});

test('equal-confidence events at distinct times are ORDER-INDEPENDENT', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SOURCES),
      fc.uniqueArray(fc.integer({ min: 1, max: 100_000 }), { maxLength: 30 }),
      fc.array(anyFields(), { maxLength: 30 }),
      fc.array(fc.nat(), { maxLength: 30 }),
      (source, times, fieldSets, shuffleKeys) => {
        const obs = times.map((observedAt, i) => ({
          accountPk: '1',
          observedAt,
          source,
          fields: fieldSets[i % Math.max(1, fieldSets.length)] ?? {},
        }));
        const shuffled = obs
          .map((o, i) => ({ o, k: shuffleKeys[i % Math.max(1, shuffleKeys.length)] ?? i }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.o);
        expect(foldAccountStream(asEvents(shuffled))).toEqual(foldAccountStream(asEvents(obs)));
      },
    ),
  );
});

test('the merge rule itself: better source wins, newer-not-worse wins, nothing rewinds', () => {
  fc.assert(
    fc.property(
      fc.record({ value: fc.nat(), at: fc.nat(), conf: fc.constantFrom(40, 60, 80, 90, 100) }),
      fc.record({ value: fc.nat(), at: fc.nat(), conf: fc.constantFrom(40, 60, 80, 90, 100) }),
      (cur, next) => {
        const got = merge(cur, next);
        expect(got.conf).toBeGreaterThanOrEqual(cur.conf);
        if (next.conf > cur.conf) expect(got).toEqual(next);
        else if (next.at >= cur.at && next.conf >= cur.conf) expect(got).toEqual(next);
        else expect(got).toEqual(cur);
        // Idempotent: re-applying the winner is a no-op.
        expect(merge(got, got)).toEqual(got);
      },
    ),
  );
  expect(merge(undefined, { value: 1, at: 5, conf: 40 })).toEqual({ value: 1, at: 5, conf: 40 });
});

test('a mixed stream folds into one projection per account, independently', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), anyObservation()), { maxLength: 60 }),
      (pairs) => {
        const obs = pairs.map(([pk, o]) => ({ ...o, accountPk: pk }));
        const byPk = foldAccounts(asEvents(obs));
        for (const pk of ['a', 'b', 'c']) {
          const mine = obs.filter((o) => o.accountPk === pk);
          expect(byPk.get(pk) ?? null).toEqual(foldAccountStream(asEvents(mine)));
        }
      },
    ),
  );
});

// --- Agreement with today's projection, and every place it ends -----------------

/**
 * The contract the two share: observations that arrive in order AND never
 * weaken. `projectAccount`'s stats gate and its identity newest-wins rule both
 * reduce to "take the newest" there, which is exactly what the merge rule does.
 */
test('foldAccount reproduces projectAccount wherever their contracts overlap', () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.constantFrom(...SOURCES), anyFields()), { maxLength: 40 }),
      (raw) => {
        const obs: Observation[] = raw
          .slice()
          .sort((a, b) => SOURCE_CONFIDENCE[a[0]] - SOURCE_CONFIDENCE[b[0]])
          .map(([source, fields], i) => ({
            accountPk: '1',
            observedAt: 1000 + i * 10,
            source,
            fields,
          }));
        const projected = obs.reduce<AccountState | null>(
          (acc, o) => projectAccount(acc, o),
          null,
        );
        const folded = foldAccountStream(asEvents(obs));
        if (projected === null || folded === null) {
          expect(projected).toBeNull();
          expect(folded).toBeNull();
          return;
        }
        const values = valuesOf(folded);
        for (const key of FIELDS) {
          expect({ [key]: values[key] ?? undefined }).toEqual({ [key]: projected[key] ?? undefined });
        }
        expect(folded.firstSeenAt).toBe(projected.firstSeenAt);
        expect(folded.lastSeenAt).toBe(projected.lastSeenAt);
      },
    ),
  );
});

/**
 * DIVERGENCE 1 — the acknowledged newest-wins hole, fixed.
 * `projectAccount`'s own docstring admits identity fields have no persisted
 * per-field provenance, so a later, WEAKER read wins on arrival order alone.
 */
test('divergence: a later search read no longer overwrites a profile username', () => {
  const profile: Observation = {
    accountPk: '1', observedAt: 100, source: 'profile', fields: { username: 'real' },
  };
  const search: Observation = {
    accountPk: '1', observedAt: 200, source: 'search', fields: { username: 'stale' },
  };
  expect(projectAccount(projectAccount(null, profile), search).username).toBe('stale');
  expect(valuesOf(foldAccountStream(asEvents([profile, search]))!).username).toBe('real');
});

/**
 * DIVERGENCE 2 — one shared stats provenance vs one per field.
 * Today `followers`, `following`, `mutuals` and `activitySignal` share a single
 * `stats_observed_at`/`stats_source` pair, so a high-confidence read of ONE of
 * them freezes the others against legitimately newer equal-confidence reads.
 */
test('divergence: a stats read no longer freezes the OTHER stats fields', () => {
  const stream: Observation[] = [
    { accountPk: '1', observedAt: 100, source: 'following-list', fields: { following: 5 } },
    // A profile read of `followers` promotes the SHARED provenance to conf 90…
    { accountPk: '1', observedAt: 50, source: 'profile', fields: { followers: 7 } },
    // …so this newer, equally-confident read of `following` is refused.
    { accountPk: '1', observedAt: 120, source: 'search', fields: { following: 9 } },
  ];
  const projected = stream.reduce<AccountState | null>((a, o) => projectAccount(a, o), null);
  expect(projected?.following).toBe(5);
  expect(valuesOf(foldAccountStream(asEvents(stream))!).following).toBe(9);
});

/**
 * DIVERGENCE 3 — no stored derived values. `ratio` becomes a generated column
 * and `enrichment` a read-time function of three fields, so neither can go
 * stale against the fields it is derived from.
 */
test('divergence: the fold stores no derived values at all', () => {
  const obs: Observation = {
    accountPk: '1', observedAt: 100, source: 'profile', fields: { followers: 300, following: 150 },
  };
  expect(projectAccount(null, obs)).toMatchObject({ ratio: 0.5, enrichment: 'profiled' });
  const folded = valuesOf(foldAccountStream(asEvents([obs]))!) as Record<string, unknown>;
  expect(folded.ratio).toBeUndefined();
  expect(folded.enrichment).toBeUndefined();
  expect(folded).toEqual({ followers: 300, following: 150 });
});
