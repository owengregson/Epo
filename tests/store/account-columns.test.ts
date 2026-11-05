/**
 * The `accounts` column manifest is the single declaration the upsert is
 * generated from — so it has to describe the real table, and the generated
 * statement has to write every field it claims to.
 */

import { ACCOUNT_COLUMNS } from '@/store/repos/account-columns';
import { memoryStore } from '../kit/store';

test('the manifest names exactly the columns the accounts table has', () => {
  const s = memoryStore();
  try {
    // Reaching into the raw table is the point: this is the assertion that a
    // migration adding a column without a manifest entry fails loudly.
    const live = (
      s as unknown as {
        db: { prepare(sql: string): { all(): Array<{ name: string }> } };
      }
    ).db
      .prepare(`PRAGMA table_info(accounts)`)
      .all()
      .map((c) => c.name);
    expect([...live].sort()).toEqual([...ACCOUNT_COLUMNS.map((c) => c.column)].sort());
  } finally {
    s.close();
  }
});

test('the generated upsert round-trips every field the projection carries', () => {
  const s = memoryStore();
  try {
    s.observe({
      accountPk: '9',
      observedAt: 500,
      source: 'profile',
      fields: {
        username: 'nine',
        followers: 300,
        following: 150,
        mutuals: 7,
        isPrivate: true,
        isVerified: false,
        activitySignal: 0.25,
        bio: 'hello',
      },
    });
    expect(s.getAccount('9')).toMatchObject({
      pk: '9',
      username: 'nine',
      enrichment: 'profiled',
      followers: 300,
      following: 150,
      mutuals: 7,
      isPrivate: true,
      isVerified: false,
      activitySignal: 0.25,
      bio: 'hello',
      ratio: 0.5,
      statsObservedAt: 500,
      statsSource: 'profile',
      firstSeenAt: 500,
      lastSeenAt: 500,
    });
  } finally {
    s.close();
  }
});

test('a successful stats read heals the enrichment-failure marker', () => {
  const s = memoryStore();
  try {
    s.observe({ accountPk: '9', observedAt: 100, source: 'profile', fields: { username: 'nine' } });
    s.markEnrichmentFailed('nine', 900);
    expect(s.getAccount('9')?.enrichFailedAt).toBe(900);
    // A read that produces follower counts proves the account is fetchable.
    s.observe({
      accountPk: '9',
      observedAt: 1000,
      source: 'profile',
      fields: { followers: 10, following: 5 },
    });
    expect(s.getAccount('9')?.enrichFailedAt).toBeUndefined();
  } finally {
    s.close();
  }
});
