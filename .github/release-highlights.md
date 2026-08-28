<!-- v3.1.0 -->

- Background and overnight runs no longer freeze: every Instagram-facing
  operation now has a deadline, a watchdog revives a stalled tab (after
  sleep, a renderer crash, or a dropped automation session), and quitting
  never hangs behind a wedged loop.
- Failures wait instead of killing the run: repeated failed actions take
  up to three long, jittered backoffs (roughly one to two hours each)
  before Epo concludes something is genuinely wrong; a soft-blocked
  action is parked, never hammered; and records burned during an
  incident are re-queued once it resolves.
- Every quiet state explains itself: overnight rests, daily-cap parks,
  and recovery holds show a reason with a live countdown, settings saves
  confirm or surface their failure, and growth numbers stay honest —
  your chart no longer collapses to zero after the first scan.
- The Chain tab is now Targets, useful from the first session: a live
  per-target funnel, an honest pool-and-coverage readout with a
  days-to-next-target runway, a follow-back conversion verdict that
  waits for real data — and the growth chart compares actuals to plan
  over 14-day to all-time windows.
- Timing never lands on a clock grid: daily wakes, sweeps, backoffs, and
  scroll pacing all draw jittered intervals, and adaptive session pacing
  is now the default for new installs.
