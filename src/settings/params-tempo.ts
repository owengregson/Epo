/**
 * The `tempo.*` rows of the parameter catalog (spec §5.11, §6.5): one per tempo key except `gap.action` and
 * `check.spacing` (the gap and check rows set those). A row is a reference factor that only lengthens its
 * wait, in [1, TEMPO_OVERRIDE_MAX_FACTOR]; the brisk side is the plan's own pace draw.
 */
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { TEMPO_PARAM_KEYS } from '@/shared/settings-params';
import type { ParamSpec } from './params-spec';

const ROW: ParamSpec = {
  section: 'timing', kind: 'number', step: SETTINGS_POLICY.PARAM_STEP.factor, unit: 'factor',
  risk: 'lower-is-riskier', applies: 'replan', needs: 'tempo', deps: [],
  derive: () => 1,
  bounds: () => ({ min: 1, max: SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR }),
};

export const TEMPO_ROW_SPECS = Object.fromEntries(TEMPO_PARAM_KEYS.map((k) => [k, ROW])) as
  Readonly<Record<(typeof TEMPO_PARAM_KEYS)[number], ParamSpec>>;
