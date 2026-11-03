/**
 * The settings side of the plan preview (spec §6.9, Appendix B.8): the plan core's intent port wrapped to
 * effective settings. The fingerprint is the digest every re-plan keys on, so it differs exactly when a
 * change re-plans; the week is the port's plan-days for the same intent. Pure; nothing writes.
 */
import type { PlanPreviewPort } from '@/governors/plan-types';
import type { PlanPreviewDay } from '@/kernel/plan/types';
import type { Feasibility } from '@/shared/settings-view';
import type { EffectiveSettings } from './effective';
import { intentDigest, toPlanIntent } from './plan-intent';
import { feasibilityOfEffective } from './view-options';

export interface SettingsPlanPreview {
  fingerprint(e: EffectiveSettings): string;
  previewDays(e: EffectiveSettings, at: number, days: number): readonly PlanPreviewDay[];
  feasibility(e: EffectiveSettings): Feasibility;
}

export function settingsPlanPreview(port: PlanPreviewPort): SettingsPlanPreview {
  return {
    fingerprint: (e) => intentDigest(toPlanIntent(e)),
    previewDays: (e, at, days) => port.previewDays(toPlanIntent(e), at, days),
    feasibility: feasibilityOfEffective,
  };
}
