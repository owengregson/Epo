/**
 * Result shapes of the manual-operation invokes (`foundation:readFollowers`,
 * `foundation:followOne` / `unfollowOne`, the seed precheck). Pure value types:
 * an `ok: false` always carries a readable `reason` rather than throwing, so a
 * refusal (engine running, not logged in) reaches the button that asked.
 */

/** Result of reading a target account's followers into the knowledge graph. */
export interface ReadFollowersResult {
  target: string;
  /** Number of follower accounts observed and written to the store. */
  observed: number;
  /**
   * Whether the read actually ran. Optional for back-compat with existing callers
   * that only read `observed`; a manual read refused while the engine is running
   * (R3) or before login returns `ok: false` with a `reason` and `observed: 0`.
   */
  ok?: boolean;
  /** Readable reason when `ok` is false (e.g. `engine-running`). */
  reason?: string;
}

/** Result of a single follow / unfollow DOM action. */
export interface ActionResult {
  ok: boolean;
  username: string;
  /** Readable failure reason when `ok` is false. */
  reason?: string;
}

/** Result of a read-only seed-username precheck (existence + followers visibility). */
export interface SeedCheck {
  ok: boolean;
  exists: boolean;
  followersVisible: boolean;
  isPrivate: boolean;
  reason?: string;
}
