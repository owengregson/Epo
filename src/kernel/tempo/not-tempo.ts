/**
 * RIM, ENGINE and NOISE registry keys no tempo spec claims, each with the reason it does not scale
 * with the tempo (spec §5.12, §17). The tempo-identity golden requires every key in those groups to
 * be claimed by exactly one spec or listed here; the keys the plan retired are gone (`registry-changes.ts`).
 */
export const NOT_TEMPO: Readonly<Record<string, string>> = {
  'RIM.FETCH_ALL_MAX_ROUNDS': 'a runaway bound on whole-list scrapes, not a wait',
  'RIM.FETCH_ALL_NO_NEW_STOP': 'a stagnation count on whole-list scrapes, not a wait',
  'RIM.ACQUIRE_NO_NEW_STOP': 'a stagnation count on an acquisition slice, not a wait',
  'RIM.LIST_WALK_MAX_PAGES': 'a runaway page bound for acquisition walks, not a wait',
  'RIM.LIST_WALK_STAGNANT_STOP': 'a statistical stagnation threshold (D5), identical at every tempo',
  'RIM.NOTIFICATIONS_WAIT_MS': 'a D4 deadline: a failure is called just as soon on a relaxed session',
  'RIM.REQUEST_ACCEPT_CAP': 'a runaway bound on accepts per pass; the plan sizes each pass',
  'RIM.NOTIFICATIONS_SCROLL_ROUNDS': 'a runaway bound on drawer rounds; the watermark sets the depth',
  'RIM.NOTIFICATIONS_POLL_MS': 'a D4 poll interval, identical at every tempo',
  'RIM.ACCEPT_VERIFY_MS': 'a D4 deadline: a failure is called just as soon on a relaxed session',
  'RIM.ACCEPT_VERIFY_POLL_MS': 'a D4 poll interval, identical at every tempo',
  'NOISE.BACKOFF_SIGMA': 'the retry-backoff noise shape around a base, not a duration',
  'NOISE.BACKOFF_MIN_FACTOR': 'the retry-backoff clamp around a base, not a duration',
  'NOISE.BACKOFF_MAX_FACTOR': 'the retry-backoff clamp around a base, not a duration',
};
