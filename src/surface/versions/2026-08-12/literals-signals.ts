/**
 * Instagram literals — capture 2026-08-12: the URL, body-text and mutation
 * refusal signatures. Re-exported by `literals.ts`.
 */

// ---------------------------------------------------------------------------
// Signals (Sentinel + mutation refusals)
// ---------------------------------------------------------------------------

/**
 * URL block / challenge / logged-out signatures. The login redirect means the
 * session expired (`logged-out`); `/challenge/` and `/accounts/suspended/` are
 * account interstitials (`challenge`).
 */
export const URL_BLOCK_SIGNATURES = [
  { pattern: /\/challenge\//i, status: 'challenge' },
  { pattern: /\/accounts\/suspended\//i, status: 'challenge' },
  { pattern: /\/accounts\/login\//i, status: 'logged-out' },
] as const;

/** Body-text signatures (best-effort; refine the first time a wall is hit). */
export const TEXT_BLOCK_SIGNATURES = [
  { pattern: /action blocked/i, status: 'action-blocked' },
  { pattern: /try again later/i, status: 'action-blocked' },
  { pattern: /we restrict certain activity/i, status: 'action-blocked' },
  { pattern: /confirm it['’]s you/i, status: 'action-blocked' },
  { pattern: /your account has been/i, status: 'action-blocked' },
] as const;

/**
 * Refusal signatures over a FAILED mutation verdict's message + feedback text.
 * The throttle family maps to `action-blocked` (the ladder waits it out); the
 * session walls map to their sentinel statuses.
 */
export const MUTATION_REFUSAL_SIGNATURES = [
  { pattern: /feedback_required/i, status: 'action-blocked' },
  { pattern: /try again later/i, status: 'action-blocked' },
  { pattern: /we restrict certain activity/i, status: 'action-blocked' },
  { pattern: /rate.?limit|wait a few minutes/i, status: 'action-blocked' },
  { pattern: /checkpoint_required|challenge_required/i, status: 'challenge' },
  { pattern: /login_required/i, status: 'logged-out' },
] as const;
