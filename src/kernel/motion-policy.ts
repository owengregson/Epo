/**
 * Tier 1 motion choices and guardrails, not claims of measured human behavior.
 * The force model follows WindMouse's gravity + correlated-wind idea; gains,
 * damping, cadence and constraints are independently chosen for viewport input.
 * https://ben.land/post/2021/04/25/windmouse-human-mouse-movement/
 */
export const MOTION = {
  /** Limit work and reject corrupt page geometry before it reaches CDP. */
  maxDistancePx: 32_768,
  maxIntegrationSteps: 2_048,
  arrivalPx: 0.35,
  gravity: [1.8, 3.4],
  windGravityRatio: [0.18, 0.4],
  windMemory: [0.8, 0.92],
  momentum: [0.8, 0.9],
  maxStepPx: [12, 22],
  referenceDistancePx: 400,
  distanceScale: [0.28, 1.5],
  dampingRadiusPx: [28, 48],
  brakingScale: 0.65,
  speedMemory: 0.85,
  speedVariation: [0.8, 1],
  /** Corridor prevents large accidental excursions toward unrelated controls. */
  corridorFraction: 0.18,
  corridorMinPx: 3,
  overshootProbability: 0.2,
  overshootMinDistancePx: 160,
  overshootFraction: [0.012, 0.035],
  overshootMaxPx: 18,
  overshootTargetFraction: 0.3,
  /** Limit per-event velocity; total duration may grow to honor this bound. */
  peakSpeedPxPerSecond: 2_400,
  /** Avoid pinning every long-distance movement to one ceiling velocity. */
  peakSpeedFactor: [0.82, 1],
  minEventDelayMs: 4,
  cadenceMemory: 0.65,
  cadenceSigma: 0.13,
  cadenceWeightFloor: 0.35,
  travelBaseMs: 100,
  travelScaleMs: 150,
  moveMinMs: 120,
  moveMaxMs: 1_400,
  travelSigma: 0.14,
  /** Keep short/capped movements variable instead of piling up at hard bounds. */
  travelBoundaryInsetFactor: 1.18,
  travelRejectionAttempts: 12,
  minTargetWidthPx: 4,
  /**
   * The dwell after the cursor ARRIVES on a hover-reactive control and before it
   * is located again to be pressed. Live 2026-10-08: Instagram's nav rail
   * re-renders its nodes by the time the cursor arrives (stable from the first
   * 2 ms sample through 2.5 s), and the drawer's close control scales
   * 16 → 16.8 px over ~200 ms — so the floor clears that transition.
   */
  hoverSettleMs: [250, 600],
  /**
   * The rest between two profile VISITS, whoever asks (enrichment, relationship
   * checks, effect reconciliation, acquisition, seed checks): a clamped
   * log-normal draw measured from the END of the previous visit. A visit is a
   * page load a person makes, and a person looks at a profile before opening
   * the next — ten back to back in ~25 s (live 2026-11-02) is the rhythm no
   * person browses at. Choices, not a measured population.
   */
  profileDwellMedianMs: 9_000,
  profileDwellSigma: 0.45,
  profileDwellMs: [5_000, 30_000],
  pressMs: [40, 120],
  pressMedianMs: 70,
  pressSigma: 0.24,
  targetMarginFraction: 0.08,
  targetMarginMaxFraction: 0.25,
  targetSigmaFraction: 1 / 6,
  targetRejectionAttempts: 12,
  /** Overscroll is bounded; tiny nonzero requests still emit a nonzero tick. */
  wheelDistanceFactor: [0.96, 1.05],
  wheelAverageTickPx: [60, 130],
  wheelOvershootMinTicks: 4,
  wheelOvershootProbability: 0.35,
  wheelOvershootFraction: [0.04, 0.1],
  wheelRampFraction: 0.3,
  wheelRampFloor: 0.35,
  wheelWeightFloor: 0.2,
  wheelSigma: 0.12,
  wheelPauseMs: [30, 90],
  wheelMicroPauseProbability: 0.12,
  wheelMicroPauseMs: [180, 450],
  wheelCorrectionPauseMs: [120, 300],
  wheelCorrectionMaxTicks: 3,
  wheelCorrectionFraction: [0.3, 0.7],
} as const;
