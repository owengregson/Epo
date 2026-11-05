/**
 * The tempo registry's one door (ADR 0607): keys, specs, resolution, the
 * gesture motion policy and the TempoSource port. Consumers import from here.
 */
export { TEMPO_KEYS, type TempoAxis, type TempoKey } from './keys';
export { deriveMotion, MOTION_REFERENCE, type MotionPolicy } from './motion';
export { NOT_TEMPO } from './not-tempo';
export { PENDING_CONSUMERS } from './pending';
export { drawResolved, locationOf, priorMin, type Resolved, resolve, scaleAbove, type TempoSite } from './resolve';
export {
  REFERENCE_TEMPO,
  referenceTempoSource,
  type TempoPolicy,
  type TempoSource,
  type TempoSourceDeps,
  tempoOrReference,
  tempoSource,
} from './source';
export { type Floor, type Identity, type Prior, TEMPO_SPECS, type TempoSpec } from './specs';
