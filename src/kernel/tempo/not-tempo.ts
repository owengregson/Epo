/**
 * RIM, ENGINE and NOISE registry keys no tempo spec claims, each with the
 * reason it does not scale with the session's tempo (spec §5.12, §17). The
 * tempo-identity golden requires every key in those groups to be claimed by
 * exactly one spec or listed here.
 */
export const NOT_TEMPO: Readonly<Record<string, string>> = {
  'ENGINE.VELOCITY_PARK_MEDIAN_MS': 'retired: the velocity park becomes the exact trailing-hour window (PR)',
  'ENGINE.VELOCITY_PARK_SIGMA': 'retired: the velocity park becomes the exact trailing-hour window (PR)',
  'ENGINE.VELOCITY_PARK_MIN_MS': 'retired: the velocity park becomes the exact trailing-hour window (PR)',
  'ENGINE.VELOCITY_PARK_MAX_MS': 'retired: the velocity park becomes the exact trailing-hour window (PR)',
  'RIM.ENRICH_PACE_MIN_MS': 'retired with the activity clock: one entry spacing replaces the enrich pace',
  'RIM.ENRICH_PACE_MAX_MS': 'retired with the activity clock: one entry spacing replaces the enrich pace',
  'RIM.FETCH_ALL_MAX_ROUNDS': 'a runaway bound on whole-list scrapes, not a wait',
  'RIM.FETCH_ALL_NO_NEW_STOP': 'a stagnation count on whole-list scrapes, not a wait',
  'RIM.ACQUIRE_MAX_ROUNDS': 'a dead runaway bound, retired with the registry rewrite (PR)',
  'RIM.ACQUIRE_NO_NEW_STOP': 'a stagnation count on an acquisition slice, not a wait',
  'RIM.LIST_WALK_MAX_PAGES': 'a runaway page bound for acquisition walks, not a wait',
  'RIM.LIST_WALK_STAGNANT_STOP': 'a statistical stagnation threshold (D5), identical at every tempo',
  'RIM.NOTIFICATIONS_WAIT_MS': 'a D4 deadline: failure detection never loosens with a relaxed session',
  'RIM.REQUEST_ACCEPT_CAP': 'a runaway bound on accepts per pass; the plan sizes each pass',
  'RIM.NOTIFICATIONS_SCROLL_ROUNDS': 'a runaway bound on drawer rounds; the watermark sets the depth',
  'RIM.NOTIFICATIONS_POLL_MS': 'a D4 poll interval, identical at every tempo',
  'RIM.ACCEPT_VERIFY_MS': 'a D4 deadline: failure detection never loosens with a relaxed session',
  'RIM.ACCEPT_VERIFY_POLL_MS': 'a D4 poll interval, identical at every tempo',
  'NOISE.DAILY_BOUNDARY_JITTER_MAX_MS': 'a desync jitter retired with the exact plan-day parks (PR)',
  'NOISE.CADENCE_SIGMA': 'the sweep cadence factor, retired with the plan-derived check spacing (PR)',
  'NOISE.CADENCE_MIN_FACTOR': 'the sweep cadence factor, retired with the plan-derived check spacing (PR)',
  'NOISE.CADENCE_MAX_FACTOR': 'the sweep cadence factor, retired with the plan-derived check spacing (PR)',
  'NOISE.PRUNE_LAUNCH_JITTER_MAX_MS': 'the scheduled bulk prune is retired (C14); no launch to jitter',
  'NOISE.BACKOFF_SIGMA': 'the retry-backoff noise shape around a base, not a duration',
  'NOISE.BACKOFF_MIN_FACTOR': 'the retry-backoff clamp around a base, not a duration',
  'NOISE.BACKOFF_MAX_FACTOR': 'the retry-backoff clamp around a base, not a duration',
};
