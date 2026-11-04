/**
 * The at-limit acknowledgement (spec §6.2): a change that moves the risk level to `at-limit` asks once per
 * app session. The level comes from the view's own options when they answer it, else from a what-if
 * preview in main; nothing here computes a limit.
 */
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { ActivityLevel, Caution } from '@/shared/settings-intent';
import { PACE_CARDS, type PaceCardId } from '@/shared/settings-intent';
import type { SettingsOp } from '@/shared/settings-ops';
import type { RiskLevel } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import { PACE_COPY } from './copy/choices';

let acknowledged = false;

/** Test seam: a new app session. */
export function resetAtLimitAcknowledgement(): void {
  acknowledged = false;
}

const PACE_KEYS = new Set(['pace.dailyVolume', 'pace.hourlyCap']);

function touchesPace(ops: readonly SettingsOp[]): boolean {
  return ops.some((o) => (o.op === 'intent' && (o.key === 'activity' || o.key === 'caution'))
    || ((o.op === 'override' || o.op === 'clear-override') && PACE_KEYS.has(o.key)));
}

/** The level the view's options already know for an intent-only change, else null. */
function localRisk(view: SettingsView, ops: readonly SettingsOp[]): RiskLevel | null {
  if (ops.some((o) => o.op !== 'intent')) return null;
  let activity: ActivityLevel = view.intent.activity;
  let caution: Caution = view.intent.caution;
  for (const o of ops) {
    if (o.op === 'intent' && o.key === 'activity') activity = o.value;
    if (o.op === 'intent' && o.key === 'caution') caution = o.value;
  }
  const card = (Object.keys(PACE_CARDS) as PaceCardId[]).find((id) => PACE_CARDS[id].activity === activity && PACE_CARDS[id].caution === caution);
  if (card !== undefined) return view.options.paceCards.find((p) => p.id === card)?.risk ?? null;
  return caution === view.intent.caution ? view.options.activity[activity].risk : null;
}

async function riskAfter(view: SettingsView, ops: readonly SettingsOp[]): Promise<RiskLevel | null> {
  const local = localRisk(view, ops);
  if (local !== null) return local;
  try {
    const r = await window.epo.previewSettings(ops);
    return r.kind === 'ok' ? r.view.typical.risk : null;
  } catch {
    // No answer from main: the change itself is still bounded there, so nothing is asked here.
    return null;
  }
}

/** Resolve true to send the change; false when the user kept the current pace. */
export async function atLimitGate(
  view: SettingsView, ops: readonly SettingsOp[], confirm: (o: ConfirmOptions) => Promise<boolean>,
): Promise<boolean> {
  if (acknowledged || !touchesPace(ops) || view.typical.risk === 'at-limit') return true;
  if ((await riskAfter(view, ops)) !== 'at-limit') return true;
  const ok = await confirm({
    title: PACE_COPY.atLimitTitle, body: PACE_COPY.atLimit, confirm: PACE_COPY.atLimitYes, dismiss: PACE_COPY.atLimitNo,
  });
  if (ok) acknowledged = true;
  return ok;
}
