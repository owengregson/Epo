/**
 * The settings' derived values in two memo layers (spec §6.9): the core (resolved params, effective
 * settings, the protection index) the engine, the plan and the change events read, and the view over
 * it, the only layer that draws the plan's week. The core never reads the plan, so the plan reads it.
 */
import type { PlanMath } from '@/settings/basis';
import type { SettingsDocV2 } from '@/settings/doc';
import { type EffectiveSettings, effectiveFrom, effectiveFromV1 } from '@/settings/effective';
import { type ChangedV1, olderVersionOffer } from '@/settings/older-version';
import type { SettingsPlanPreview } from '@/settings/plan-preview-port';
import { type ResolvedParams, resolveParams } from '@/settings/resolve';
import type { Settings } from '@/settings/v1/settings-v1-types';
import { buildView } from '@/settings/view';
import { WEEKDAYS } from '@/shared/settings-intent';
import type { SettingsCapabilities, SettingsHealth, SettingsView } from '@/shared/settings-view';
import { compileProtection, type ProtectionIndex } from '@/shared/unfollow-protection';

/** What the core depends on: the document revision, a refused migration's v1 file, the plan flag. */
export interface CoreInputs {
  readonly doc: SettingsDocV2;
  readonly refused: { readonly v1: Settings } | null;
  /** `capabilities.plan`: resolveParams reads it. */
  readonly plan: boolean;
}

export interface SettingsCore extends CoreInputs {
  readonly resolved: ResolvedParams;
  readonly effective: EffectiveSettings;
  readonly index: ProtectionIndex;
}

/** What only the view reads, beyond its core. */
export interface ViewInputs {
  readonly capabilities: SettingsCapabilities;
  readonly health: SettingsHealth;
  readonly preview: SettingsPlanPreview | null;
  readonly older: ChangedV1 | null;
  readonly now: number;
}

export function resolveDoc(doc: SettingsDocV2, plan: boolean, math: PlanMath): ResolvedParams {
  return resolveParams({ intent: doc.intent, overrides: doc.overrides, plan, math });
}

interface ViewMemo { readonly core: SettingsCore; readonly key: string; readonly preview: SettingsPlanPreview | null; readonly view: SettingsView }

/** The core per document revision, refused state and plan flag; the view per core, capabilities, health and port. */
export class SettingsDerived {
  private coreMemo: SettingsCore | null = null;
  private viewMemo: ViewMemo | null = null;

  constructor(private readonly math: PlanMath) {}

  core(i: CoreInputs): SettingsCore {
    const m = this.coreMemo;
    if (m !== null && m.doc === i.doc && m.refused === i.refused && m.plan === i.plan) return m;
    const resolved = resolveDoc(i.doc, i.plan, this.math);
    const effective = i.refused === null ? effectiveFrom(i.doc, resolved) : effectiveFromV1(i.refused.v1);
    this.coreMemo = { ...i, resolved, effective, index: compileProtection(i.doc.protection, i.doc.protectionState, i.doc.rev) };
    return this.coreMemo;
  }

  /** The view over a memoized core: the port drawing the week may read the core back. */
  view(core: SettingsCore, i: ViewInputs): SettingsView {
    const key = JSON.stringify([i.capabilities, i.health]);
    const m = this.viewMemo;
    if (m !== null && m.core === core && m.key === key && m.preview === i.preview) return m.view;
    const week = i.capabilities.plan && i.preview !== null ? i.preview.previewDays(core.effective, i.now, WEEKDAYS.length) : null;
    const view = buildView({ doc: core.doc, health: i.health, capabilities: i.capabilities, resolved: core.resolved,
      effective: core.effective, math: this.math, week, older: olderVersionOffer(core.doc, i.older, i.now) });
    this.viewMemo = { core, key, preview: i.preview, view };
    return view;
  }
}
