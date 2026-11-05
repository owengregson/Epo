/**
 * GOLDEN ORACLE — a deep-frozen literal copy of `src/timing/config.ts` and every
 * table `src/settings/pattern-map.ts` resolved, captured BEFORE the fundamentals
 * refactor (git 864f6ba, 2026-09-02).
 *
 * Generated, then frozen by hand-off: this file is the migration seam. Nothing in
 * it may be edited to make a test pass — a diff here is a deliberate behaviour
 * change and must be argued for in `src/kernel/overrides.ts` and an ADR.
 *
 * See docs/adr/0605-constants-derive-from-fundamentals.md.
 */

/** Recursively freeze a plain object/array literal. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const LEGACY_SNAPSHOT = deepFreeze(
  {
    "groups": {
      "ENGINE": {
        "IDLE_MS": 30000,
        "REFILL_PACING_MIN_MS": 2000,
        "REFILL_PACING_MAX_MS": 5000,
        "ENRICH_BACKOFF_MS": 600000,
        "VELOCITY_PARK_MEDIAN_MS": 480000,
        "VELOCITY_PARK_SIGMA": 0.3,
        "VELOCITY_PARK_MIN_MS": 300000,
        "VELOCITY_PARK_MAX_MS": 900000
      },
      "PRUNE": {
        "DELAY_FACTOR": 0.3333333333333333,
        "PARK_MS": 30000,
        "SCAN_FRESH_MS": 345600000,
        "PARK_TIMEOUT_MS": 90000
      },
      "CONNECTIVITY": {
        "PROBE_INTERVAL_MS": 20000,
        "REQUEST_TIMEOUT_MS": 5000
      },
      "SCHEDULER": {
        "AUTO_PRUNE_CHECK_MS": 1800000,
        "USERNAME_RESOLVE_RETRY_MS": 1500,
        "USERNAME_RESOLVE_ATTEMPTS": 4,
        "USERNAME_REBUILD_BACKOFF_MS": 300000,
        "MANUAL_OP_DRAIN_TIMEOUT_MS": 15000
      },
      "ADAPTER": {
        "POLL_INTERVAL_MS": 250,
        "POLL_TIMEOUT_MS": 8000,
        "MUTATION_RESPONSE_TIMEOUT_MS": 12000,
        "IDENTITY_ATTEMPTS": 4,
        "IDENTITY_RETRY_MS": 1200,
        "NAV_SETTLE_ROUNDS": 15,
        "NAV_SETTLE_MS": 300,
        "PROFILE_LAND_ATTEMPTS": 20,
        "PROFILE_LAND_RETRY_MS": 1500
      },
      "TAB": {
        "GOTO_TIMEOUT_MS": 30000,
        "EVALUATE_TIMEOUT_MS": 15000,
        "GET_BODY_TIMEOUT_MS": 10000,
        "FETCH_ABORT_MS": 20000,
        "TEARDOWN_ENGINE_WAIT_MS": 15000
      },
      "RECOVERY": {
        "STEP_WATCHDOG_MS": 480000,
        "STEP_WATCHDOG_CHECK_MS": 60000,
        "HOLD_MEDIANS_MS": [
          3600000,
          5400000,
          7200000
        ],
        "HOLD_SIGMA": 0.25,
        "HOLD_MIN_FACTOR": 0.6,
        "HOLD_MAX_FACTOR": 1.6,
        "MAX_HOLDS": 3,
        "REENTRY_FAILS": 2,
        "BLOCKED_STREAK_ENTRY": 3,
        "WALLED_CYCLES_ENTRY": 3,
        "CANARY_WINDOW_MS": 500,
        "PRUNE_COOLDOWN_AFTER_RATE_HALT_MS": 7200000,
        "TAB_EVENT_DEBOUNCE_MS": 60000,
        "RESUME_SETTLE_MIN_MS": 3000,
        "RESUME_SETTLE_MAX_MS": 10000,
        "EXHAUSTED_REVERIFY_WINDOW_MS": 172800000,
        "HEAL_MAX_RECORDS": 200,
        "HEAL_GRACE_MS": 3600000
      },
      "RIM": {
        "SCROLL_WAIT_MS": 2000,
        "ENRICH_PACE_MIN_MS": 2500,
        "ENRICH_PACE_MAX_MS": 4500,
        "FETCH_ALL_MAX_ROUNDS": 400,
        "FETCH_ALL_NO_NEW_STOP": 5,
        "ACQUIRE_MAX_ROUNDS": 5,
        "ACQUIRE_NO_NEW_STOP": 2,
        "ACQUIRE_SCROLL_MIN_MS": 1400,
        "ACQUIRE_SCROLL_MAX_MS": 3600,
        "LIST_WALK_MAX_PAGES": 200,
        "LIST_WALK_PAGE_MIN_MS": 1000,
        "LIST_WALK_PAGE_MAX_MS": 3000,
        "LIST_WALK_REST_MIN_MS": 5000,
        "LIST_WALK_REST_MAX_MS": 15000,
        "LIST_WALK_STAGNANT_STOP": 3,
        "NOTIFICATIONS_WAIT_MS": 10000,
        "NOTIFICATIONS_CLOSE_DELAY_MIN_MS": 500,
        "NOTIFICATIONS_CLOSE_DELAY_MAX_MS": 1200,
        "REQUEST_ACCEPT_CAP": 20,
        "NOTIFICATIONS_SCROLL_ROUNDS": 2,
        "NOTIFICATIONS_SCROLL_WAIT_MIN_MS": 1400,
        "NOTIFICATIONS_SCROLL_WAIT_MAX_MS": 2800,
        "NOTIFICATIONS_POLL_MS": 150,
        "ACCEPT_VERIFY_MS": 4000,
        "ACCEPT_VERIFY_POLL_MS": 200,
        "ACCEPT_PACE_MIN_MS": 1500,
        "ACCEPT_PACE_MAX_MS": 3000
      },
      "NOISE": {
        "DAILY_BOUNDARY_JITTER_MAX_MS": 2400000,
        "CADENCE_SIGMA": 0.3,
        "CADENCE_MIN_FACTOR": 0.5,
        "CADENCE_MAX_FACTOR": 2,
        "PRUNE_LAUNCH_JITTER_MAX_MS": 1200000,
        "BACKOFF_SIGMA": 0.3,
        "BACKOFF_MIN_FACTOR": 0.5,
        "BACKOFF_MAX_FACTOR": 2,
        "BEAT_MIN_FACTOR": 0.7,
        "BEAT_MAX_FACTOR": 1.45,
        "LIST_WALK_REST_EVERY_MIN": 5,
        "LIST_WALK_REST_EVERY_MAX": 10
      },
      "POLL": {
        "KEEPALIVE_MS": 10000,
        "GRAPH_PUSH_THROTTLE_MS": 300
      },
      "HARNESS": {
        "LOGIN_POLL_MS": 2000,
        "DIALOG_SWEEP_MS": 2000,
        "INSPECT_POLL_MS": 300,
        "CAPTURE_NAV_SETTLE_MS": 4000,
        "CAPTURE_DIALOG_SETTLE_MS": 2500,
        "CAPTURE_SHORT_SETTLE_MS": 1500,
        "OP_DELAY_MIN_MS": 4000,
        "OP_DELAY_MAX_MS": 9000,
        "ENRICH_PACE_MIN_MS": 3000,
        "ENRICH_PACE_MAX_MS": 5000,
        "FOLLOW_UNFOLLOW_GAP_MS": 45000
      },
      "CIRCADIAN": {
        "BUMPS": [
          {
            "centerHour": 8,
            "amplitude": 0.45,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 1,
            "widthHours": 3
          }
        ],
        "OVERNIGHT_FLOOR": 0.015,
        "DAY_OF_WEEK_WEIGHTS": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "WEEKEND_SHIFT_HOURS": 1.4,
        "PHASE_JITTER_MAX_HOURS": 1.5
      },
      "SESSION": {
        "GAP_SIGMA": 0.75,
        "GAP_CAP_MS": 480000,
        "SESSION_BOUNDARY_MS": 1800000,
        "HAWKES_ALPHA": 0.35,
        "HAWKES_TAU_MS": 90000
      },
      "PATTERN": {
        "REST_DAY_MAX_FRACTION": 0.15,
        "CYCLE_PLAN_MIN_FRACTION": 0.85,
        "CYCLE_PLAN_MAX_FRACTION": 0.97,
        "CYCLE_PLAN_MIN_CAP": 10,
        "MAX_UNFOLLOW_FRACTION_PER_SESSION": 0.5
      },
      "UPDATER": {
        "CHECK_INTERVAL_MS": 21600000
      }
    },
    "personas": {
      "casual": {
        "dailyOperatingRate": 30,
        "dailyHardCeiling": 39,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 5,
        "sessionsPerDayMax": 9,
        "gapMedianSeconds": 180,
        "gapFloorSeconds": 60,
        "hourlyVelocityCap": 14,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.25,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 36
      },
      "balanced": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "grower": {
        "dailyOperatingRate": 75,
        "dailyHardCeiling": 98,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 35,
        "hourlyVelocityCap": 30,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 2,
        "holdAfterFollowbackDays": 1,
        "dailyPlanSize": 90
      },
      "nineToFive": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 12,
        "restDayChancePct": 0,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "nightOwl": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 2,
        "sessionsPerDayMax": 4,
        "gapMedianSeconds": 55,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.25,
        "maxWaitForFollowbackDays": 7,
        "holdAfterFollowbackDays": 4,
        "dailyPlanSize": 60
      }
    },
    "grid": {
      "activityLevel=minimal": {
        "dailyOperatingRate": 15,
        "dailyHardCeiling": 20,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 18
      },
      "activityLevel=light": {
        "dailyOperatingRate": 30,
        "dailyHardCeiling": 39,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 36
      },
      "activityLevel=moderate": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "activityLevel=active": {
        "dailyOperatingRate": 75,
        "dailyHardCeiling": 98,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 90
      },
      "activityLevel=aggressive": {
        "dailyOperatingRate": 100,
        "dailyHardCeiling": 130,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 120
      },
      "consistency=clockwork": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 12,
        "restDayChancePct": 0,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "consistency=natural": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "consistency=erratic": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 45,
        "restDayChancePct": 18,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "rhythm=trickle": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 5,
        "sessionsPerDayMax": 9,
        "gapMedianSeconds": 180,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "rhythm=sessions": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "rhythm=bursts": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 2,
        "sessionsPerDayMax": 4,
        "gapMedianSeconds": 55,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "dayShape=morning": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "dayShape=balanced": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "dayShape=evening": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "dayShape=nightowl": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "dayShape=business": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "weeklyShape=uniform": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "weeklyShape=weekdays": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "weeklyShape=weekends": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "weeklyShape=realistic": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "caution=cautious": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 60,
        "hourlyVelocityCap": 14,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "caution=standard": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "caution=bold": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 35,
        "hourlyVelocityCap": 30,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "cleanup=off": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": false,
        "maxUnfollowFractionPerSession": 0,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "cleanup=trickle": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.25,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "cleanup=steady": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "cleanup=deep": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.7,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "patience=quick": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 2,
        "holdAfterFollowbackDays": 1,
        "dailyPlanSize": 60
      },
      "patience=normal": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 4,
        "holdAfterFollowbackDays": 2,
        "dailyPlanSize": 60
      },
      "patience=patient": {
        "dailyOperatingRate": 50,
        "dailyHardCeiling": 65,
        "dailyVolumeVariancePct": 28,
        "restDayChancePct": 8,
        "sessionsPerDayMin": 3,
        "sessionsPerDayMax": 6,
        "gapMedianSeconds": 95,
        "gapFloorSeconds": 45,
        "hourlyVelocityCap": 22,
        "weaveEnabled": true,
        "maxUnfollowFractionPerSession": 0.5,
        "maxWaitForFollowbackDays": 7,
        "holdAfterFollowbackDays": 4,
        "dailyPlanSize": 60
      }
    },
    "profiles": {
      "dayShape=morning": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.9,
            "widthHours": 1.8
          },
          {
            "centerHour": 12.5,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 0.5,
            "widthHours": 3
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "dayShape=balanced": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.45,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 1,
            "widthHours": 3
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "dayShape=evening": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.3,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.45,
            "widthHours": 2
          },
          {
            "centerHour": 19,
            "amplitude": 1,
            "widthHours": 3.2
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "dayShape=nightowl": {
        "bumps": [
          {
            "centerHour": 11,
            "amplitude": 0.4,
            "widthHours": 2
          },
          {
            "centerHour": 16,
            "amplitude": 0.5,
            "widthHours": 2.5
          },
          {
            "centerHour": 22,
            "amplitude": 1,
            "widthHours": 3.2
          }
        ],
        "overnightFloor": 0.06,
        "dayOfWeekWeights": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "dayShape=business": {
        "bumps": [
          {
            "centerHour": 10,
            "amplitude": 0.8,
            "widthHours": 2.5
          },
          {
            "centerHour": 15,
            "amplitude": 0.9,
            "widthHours": 3
          },
          {
            "centerHour": 19,
            "amplitude": 0.3,
            "widthHours": 2
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "weeklyShape=uniform": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.45,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 1,
            "widthHours": 3
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          1,
          1,
          1,
          1,
          1,
          1,
          1
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "weeklyShape=weekdays": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.45,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 1,
            "widthHours": 3
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          0.6,
          1.1,
          1.1,
          1.1,
          1.1,
          1.1,
          0.6
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "weeklyShape=weekends": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.45,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 1,
            "widthHours": 3
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          1.3,
          0.85,
          0.85,
          0.85,
          0.85,
          0.9,
          1.3
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      },
      "weeklyShape=realistic": {
        "bumps": [
          {
            "centerHour": 8,
            "amplitude": 0.45,
            "widthHours": 1.6
          },
          {
            "centerHour": 13,
            "amplitude": 0.5,
            "widthHours": 2
          },
          {
            "centerHour": 18,
            "amplitude": 1,
            "widthHours": 3
          }
        ],
        "overnightFloor": 0.015,
        "dayOfWeekWeights": [
          0.9,
          1,
          1.08,
          1.08,
          1,
          1.02,
          0.92
        ],
        "weekendShiftHours": 1.4,
        "phaseOffsetHours": 0
      }
    },
    "personaBundles": {
      "casual": {
        "activityLevel": "light",
        "consistency": "natural",
        "rhythm": "trickle",
        "dayShape": "evening",
        "weeklyShape": "realistic",
        "caution": "cautious",
        "cleanup": "trickle",
        "patience": "normal"
      },
      "balanced": {
        "activityLevel": "moderate",
        "consistency": "natural",
        "rhythm": "sessions",
        "dayShape": "balanced",
        "weeklyShape": "realistic",
        "caution": "standard",
        "cleanup": "steady",
        "patience": "normal"
      },
      "grower": {
        "activityLevel": "active",
        "consistency": "natural",
        "rhythm": "sessions",
        "dayShape": "balanced",
        "weeklyShape": "realistic",
        "caution": "bold",
        "cleanup": "steady",
        "patience": "quick"
      },
      "nineToFive": {
        "activityLevel": "moderate",
        "consistency": "clockwork",
        "rhythm": "sessions",
        "dayShape": "business",
        "weeklyShape": "weekdays",
        "caution": "standard",
        "cleanup": "steady",
        "patience": "normal"
      },
      "nightOwl": {
        "activityLevel": "moderate",
        "consistency": "natural",
        "rhythm": "bursts",
        "dayShape": "nightowl",
        "weeklyShape": "realistic",
        "caution": "standard",
        "cleanup": "trickle",
        "patience": "patient"
      }
    }
  },
);

/** Every leaf key path in the legacy `timing/config.ts` registry, "GROUP.KEY". */
export const LEGACY_CONFIG_KEYS: readonly string[] = Object.freeze(
  Object.entries(LEGACY_SNAPSHOT.groups).flatMap(([group, keys]) =>
    Object.keys(keys as Record<string, unknown>).map((k) => `${group}.${k}`),
  ),
);
