/**
 * The one write vocabulary (spec §6.7, Appendix B.5): `applyOps(doc, ops, ctx)` applies ops atomically, in
 * order, coercing each to its nearest safe value (ADR 0103) and returning the ops that undo it. Pure: no
 * persist, no clock read (`ctx.now`). The migration and older-version imports are the service's own.
 */
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { type Intent, type IntentKey, MAX_DAYS_OFF } from '@/shared/settings-intent';
import type { ParamValue } from '@/shared/settings-model';
import type { Adjustment, SettingsOp } from '@/shared/settings-ops';
import type { ParamKey, SectionId } from '@/shared/settings-params';
import { type OverrideEntry, RECOMMENDED_INTENT, type SettingsDocV2 } from './doc';
import { INTENT_RULES } from './doc-rules';
import { applyProtectionOp } from './ops-protection';
import { ALL_PARAM_KEYS, PARAM_SPECS } from './params';
import { fitsKind } from './params-spec';

export type Touched = 'intent' | 'overrides' | 'seed' | 'protection' | 'prefs' | 'app';

export interface OpsCtx {
  readonly origin: 'user' | 'system';
  readonly now: number;
  /** The recommendation an override is set against (its basis), for the document as it stands. */
  recommended(doc: SettingsDocV2, key: ParamKey): ParamValue;
  /** A refused migration: only the migration and ui ops apply; protection cannot be acknowledged. */
  readonly migrationPending: boolean;
}

export type Refusal = { readonly kind: 'refused'; readonly reason: 'invalid' | 'migration-pending' | 'protection-not-migrated'; readonly detail: string };
export type OpsResult =
  | {
      readonly kind: 'applied'; readonly doc: SettingsDocV2; readonly adjustments: readonly Adjustment[];
      readonly inverse: readonly SettingsOp[]; readonly touched: ReadonlySet<Touched>;
    }
  | Refusal;

interface Step { readonly doc: SettingsDocV2; readonly inverse: readonly SettingsOp[]; readonly adjustments?: readonly Adjustment[]; readonly touched: readonly Touched[] }

/** The intent keys each section's reset returns to the recommendation. */
export const SECTION_INTENT: Readonly<Partial<Record<SectionId, readonly IntentKey[]>>> = {
  pace: ['activity', 'caution', 'consistency'],
  schedule: ['rhythm', 'dayShape', 'weeklyShape', 'quietHours', 'daysOff'],
  audience: ['audienceFocus', 'audienceSize', 'preferPrivate'],
  unfollow: ['patience', 'mutuals', 'cleanup'],
};

const refuse = (reason: Refusal['reason'], detail: string): Refusal => ({ kind: 'refused', reason, detail });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const normalizeSeed = (s: string): string => s.trim().replace(/^@/, '').trim();
const SYSTEM_ONLY = new Set<SettingsOp['op']>(['protect-link', 'consume-bookkeeping']);
const SERVICE_OPS = new Set<SettingsOp['op']>(['migration', 'import-older-version']);

/** Apply `ops` atomically: every op applies, or none does (the first refusal is returned). */
export function applyOps(doc: SettingsDocV2, ops: readonly SettingsOp[], ctx: OpsCtx): OpsResult {
  let d = doc;
  const adjustments: Adjustment[] = [];
  let inverse: SettingsOp[] = [];
  const touched = new Set<Touched>();
  for (const op of ops) {
    const step = applyOne(d, op, ctx);
    if ('kind' in step) return step;
    d = step.doc;
    adjustments.push(...(step.adjustments ?? []));
    inverse = [...step.inverse, ...inverse];
    for (const t of step.touched) touched.add(t);
  }
  return { kind: 'applied', doc: d, adjustments, inverse, touched };
}

function applyOne(d: SettingsDocV2, op: SettingsOp, ctx: OpsCtx): Step | Refusal {
  if (op.op === 'acknowledge-protection' && ctx.migrationPending) {
    return refuse('protection-not-migrated', 'the protection lists did not come from a successful migration');
  }
  if (ctx.migrationPending && op.op !== 'migration' && op.op !== 'ui') return refuse('migration-pending', `${op.op} waits for the migration`);
  if (SYSTEM_ONLY.has(op.op) && ctx.origin === 'user') return refuse('invalid', `${op.op} is a system op`);
  if (SERVICE_OPS.has(op.op)) return refuse('invalid', `${op.op} applies alone, through the settings service`);
  switch (op.op) {
    case 'intent': return intentStep(d, op.key, op.value);
    case 'override': {
      const spec = PARAM_SPECS[op.key];
      if (!fitsKind(spec.kind, op.value)) return refuse('invalid', `${op.key} takes a ${spec.kind}`);
      const prev = d.overrides[op.key];
      const entry: OverrideEntry = { value: op.value, setAt: ctx.now, basis: ctx.recommended(d, op.key) };
      return {
        doc: { ...d, overrides: { ...d.overrides, [op.key]: entry } }, touched: ['overrides'],
        inverse: [prev === undefined ? { op: 'clear-override', key: op.key } : { op: 'override', key: op.key, value: prev.value }],
      };
    }
    case 'clear-override': {
      const { [op.key]: prev, ...rest } = d.overrides;
      return { doc: { ...d, overrides: rest }, touched: ['overrides'], inverse: prev === undefined ? [] : [{ op: 'override', key: op.key, value: prev.value }] };
    }
    case 'seed': {
      const seed = normalizeSeed(op.handle);
      const adjustments: Adjustment[] = seed === op.handle ? [] : [{ key: 'seed', requested: op.handle, applied: seed, because: 'normalized' }];
      return { doc: { ...d, seed }, touched: ['seed'], adjustments, inverse: [{ op: 'seed', handle: d.seed }] };
    }
    case 'protect-add': case 'protect-remove': case 'protect-restore': case 'word-add': case 'word-remove':
    case 'protect-rule': case 'protect-link': {
      const step = applyProtectionOp(d.protection, op, ctx.now);
      return { doc: { ...d, protection: step.protection }, touched: ['protection'], inverse: step.inverse, adjustments: step.adjustments };
    }
    case 'pref': return prefStep(d, op);
    case 'ui': return { doc: { ...d, app: { ...d.app, mode: op.mode } }, touched: ['app'], inverse: [{ op: 'ui', mode: d.app.mode }] };
    case 'tour-completed': return { doc: { ...d, app: { ...d.app, tourCompletedAt: op.at } }, touched: ['app'], inverse: [] };
    case 'tour-version-seen': return { doc: { ...d, app: { ...d.app, tourVersionSeen: op.version } }, touched: ['app'], inverse: [] };
    case 'dismiss-notice': {
      const dismissed = d.app.dismissedNotices.includes(op.id) ? d.app.dismissedNotices : [...d.app.dismissedNotices, op.id];
      return { doc: { ...d, app: { ...d.app, dismissedNotices: dismissed } }, touched: ['app'], inverse: [] };
    }
    case 'acknowledge-protection': return { doc: { ...d, protectionState: 'ready' }, touched: ['protection'], inverse: [] };
    case 'consume-bookkeeping': {
      const migration = d.migration === null ? null : { ...d.migration, bookkeeping: null };
      return { doc: { ...d, migration }, touched: ['app'], inverse: [] };
    }
    case 'reset': return resetStep(d, op.scope.kind === 'recommended' ? null : op.scope.section);
    case 'migration': case 'import-older-version':
      return refuse('invalid', `${op.op} applies alone, through the settings service`);
  }
}

function intentStep<K extends IntentKey>(d: SettingsDocV2, key: K, value: Intent[K]): Step | Refusal {
  const rule = INTENT_RULES[key] as unknown as (raw: unknown, fb: Intent[K]) => { value: Intent[K]; dropped: number };
  const c = rule(value, d.intent[key]);
  if (key === 'daysOff' && new Set(value as readonly number[]).size > MAX_DAYS_OFF) {
    return refuse('invalid', 'seven days off is Stop, not a plan');
  }
  if (c.dropped > 0 && key !== 'daysOff') return refuse('invalid', `${key} has no nearest safe value`);
  const adjustments: Adjustment[] = same(c.value, value) ? [] : [{ key, requested: value, applied: c.value, because: 'normalized' }];
  return {
    doc: { ...d, intent: { ...d.intent, [key]: c.value } }, touched: ['intent'], adjustments,
    inverse: [{ op: 'intent', key, value: d.intent[key] } as SettingsOp],
  };
}

function prefStep(d: SettingsDocV2, op: Extract<SettingsOp, { op: 'pref' }>): Step {
  const p = d.prefs;
  if (op.key === 'boost.hours') {
    const { MIN_HOURS, MAX_HOURS } = SETTINGS_POLICY.BOOST;
    const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, op.value));
    const adjustments: Adjustment[] = hours === op.value ? []
      : [{ key: 'prefs.boost.hours', requested: op.value, applied: hours, because: hours < op.value ? 'above-safe-max' : 'below-safe-min' }];
    return { doc: { ...d, prefs: { ...p, boost: { ...p.boost, hours } } }, touched: ['prefs'], adjustments,
      inverse: [{ op: 'pref', key: 'boost.hours', value: p.boost.hours }] };
  }
  const prev = op.key === 'practice' ? p.practice : op.key === 'acceptRequests' ? p.acceptRequests : p.boost.acceptRequests;
  const prefs = op.key === 'boost.acceptRequests' ? { ...p, boost: { ...p.boost, acceptRequests: op.value } } : { ...p, [op.key]: op.value };
  return { doc: { ...d, prefs }, touched: ['prefs'], inverse: [{ op: 'pref', key: op.key, value: prev }] };
}

/** Reset the intent (all of it, or one section's) and clear the matching overrides; nothing else moves. */
function resetStep(d: SettingsDocV2, section: SectionId | null): Step {
  const keys = section === null ? (Object.keys(RECOMMENDED_INTENT) as IntentKey[]) : (SECTION_INTENT[section] ?? []);
  const intent = { ...d.intent };
  const inverse: SettingsOp[] = [];
  for (const k of keys) {
    if (same(d.intent[k], RECOMMENDED_INTENT[k])) continue;
    inverse.push({ op: 'intent', key: k, value: d.intent[k] } as SettingsOp);
    (intent as Record<IntentKey, unknown>)[k] = RECOMMENDED_INTENT[k];
  }
  const cleared = ALL_PARAM_KEYS.filter((k) => d.overrides[k] !== undefined && (section === null || PARAM_SPECS[k].section === section));
  const overrides = { ...d.overrides };
  for (const k of cleared) {
    inverse.push({ op: 'override', key: k, value: (d.overrides[k] as OverrideEntry).value });
    delete overrides[k];
  }
  return { doc: { ...d, intent, overrides }, touched: ['intent', 'overrides'], inverse };
}
