/** Engineering guardrails for a responsive renderer, not human-behavior claims. */
export const RENDERER_HEALTH = {
  /** A live-but-throttled 1fps page cannot reliably hydrate controls or deliver input. */
  minAnimationFps: 10,
  /** Stop a zero-frame observation even when its requested frame window never completes. */
  backstopWindowFactor: 4,
} as const;
