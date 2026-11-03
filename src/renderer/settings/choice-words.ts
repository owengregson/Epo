/**
 * A setting's name and value in the words the page uses for it: a reset line ("Activity level: Active →
 * Moderate") or a conflict names parameters and intent choices alike. Pure; the numbers come from the view.
 */

import { INTENT_KEYS, type IntentKey } from '@/shared/settings-intent';
import type { ChangeLine } from '@/shared/settings-ops';
import type { ParamKey } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import { ACTIVITY_COPY, AUDIENCE_COPY, CAUTION_COPY, CONSISTENCY_COPY, SCHEDULE_COPY, UNFOLLOW_COPY, WEEKLY_COPY } from './copy/choices';
import { INTENT_LABEL, OTHER_LABEL, PARAM_COPY } from './copy/params';
import { daysLabel, unitLabel } from './format';

const isIntentKey = (k: string): k is IntentKey => (INTENT_KEYS as readonly string[]).includes(k);

/** The label of whatever a change line names. */
export function labelOf(key: ChangeLine['key']): string {
  if (isIntentKey(key)) return INTENT_LABEL[key];
  if (key === 'seed' || key === 'prefs.practice') return OTHER_LABEL[key];
  return PARAM_COPY[key as ParamKey].label;
}

function intentWord(key: IntentKey, v: string, view: SettingsView): string {
  const pick = <T extends Record<string, string>>(table: T): string => (v in table ? table[v as keyof T] : v);
  switch (key) {
    case 'activity': return pick(ACTIVITY_COPY);
    case 'caution': return pick(CAUTION_COPY);
    case 'consistency': return pick(CONSISTENCY_COPY);
    case 'weeklyShape': return pick(WEEKLY_COPY);
    case 'dayShape': return pick(SCHEDULE_COPY.shapes);
    case 'rhythm': return pick(SCHEDULE_COPY.rhythm);
    case 'cleanup': return pick(UNFOLLOW_COPY.cleanup);
    case 'mutuals': return pick(UNFOLLOW_COPY.mutualTitle);
    case 'audienceFocus': return pick(AUDIENCE_COPY.focus);
    case 'audienceSize': return pick(AUDIENCE_COPY.sizes);
    case 'patience': return v in view.options.patience ? daysLabel(view.options.patience[v as keyof typeof view.options.patience].waitDays) : v;
    default: return v;
  }
}

/** One side of a change line, in words: a choice's name, a number in its row's unit, On / Off. */
export function valueWord(key: ChangeLine['key'], v: string | number | boolean, view: SettingsView): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'string') return isIntentKey(key) ? intentWord(key, v, view) : v;
  const param = view.params.find((p) => p.key === key);
  return param === undefined ? String(v) : unitLabel(v, param.unit);
}
