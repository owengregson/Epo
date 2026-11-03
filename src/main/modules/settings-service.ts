/**
 * The settings service (spec §6.6, §6.9, Appendix B.8): the one writer of epo-settings-v2.json. Reads or
 * migrates at construction, applies ops persist-first, recompiles protection and the view per revision,
 * tells its listeners and pushes the view. Production runs the transitional service until it is wired.
 */
import type { PlanPreviewPort } from '@/governors/plan-types';
import type { BuiltGraph } from '@/main/services/graph-types';
import { migrationBasis, type PlanMath } from '@/settings/basis';
import { DEFAULT_DOC, type SettingsDocV2 } from '@/settings/doc';
import { type EffectiveSettings, effectiveFrom, effectiveFromV1 } from '@/settings/effective';
import { migrateV1 } from '@/settings/migrate-v1';
import { migrateAccountList, migrateWordList } from '@/settings/migrate-v1-lists';
import { applyOps, type Touched } from '@/settings/ops';
import { PARAM_SPECS } from '@/settings/params';
import { sameValue } from '@/settings/params-spec';
import { NODE_SETTINGS_FS, readSettings, SETTINGS_FILES, type SettingsFs, writeSettings } from '@/settings/persist';
import { type ResolvedParams, resolveParams } from '@/settings/resolve';
import { migrateLegacyPattern, sanitizeSettings } from '@/settings/v1/settings-v1';
import type { Settings } from '@/settings/v1/settings-v1-types';
import { opsFromV1Partial, toV1Settings, type V1Bookkeeping } from '@/settings/v1-adapter';
import { buildView, previewChanges } from '@/settings/view';
import type { ApplyNote, OverrideConflict, SettingsOp, SettingsPreviewResult, SettingsSaveResult } from '@/shared/settings-ops';
import type { ParamKey } from '@/shared/settings-params';
import type { BasisResult, SettingsCapabilities, SettingsHealth, SettingsView } from '@/shared/settings-view';
import { compileProtection, type ProtectionIndex } from '@/shared/unfollow-protection';
import * as logger from '@/utils/logger';

import { reloadChanged } from './settings-reload';

export { SettingsService } from './settings-transitional';

export interface SettingsChangeEvent {
  readonly rev: number;
  readonly prev: EffectiveSettings;
  readonly next: EffectiveSettings;
  readonly touched: ReadonlySet<Touched>;
  readonly origin: 'user' | 'system' | 'migration';
}

export interface SettingsServiceDeps {
  readonly userDataDir: string;
  readonly fs?: SettingsFs;
  knowledgeDbExists(): boolean;
  /** The plan core's numbers (the effective gap, the day law, the retry limit). */
  readonly math: PlanMath;
  now(): number;
  /** Sends the view to the renderer after every persisted write. */
  push(view: SettingsView): void;
  /** The live graph whose components reload what changed (null while the session is closed). */
  graph?(): BuiltGraph | null;
}

/** A refused migration keeps serving the readable v1 file; no v2 is written until a recovery op succeeds. */
interface Refused { readonly v1: Settings; readonly detail: string }

type Opened = { doc: SettingsDocV2; health: SettingsHealth; refused: Refused | null };

const OFF: SettingsCapabilities = { plan: false, tempo: false, boost: false, protectionEverywhere: false };

export class SettingsServiceV2 {
  private doc: SettingsDocV2;
  private health: SettingsHealth;
  private refused: Refused | null;
  private capabilities: SettingsCapabilities = OFF;
  private port: PlanPreviewPort | null = null;
  private memo: { key: string; resolved: ResolvedParams; effective: EffectiveSettings; index: ProtectionIndex; view: SettingsView } | null = null;
  private readonly listeners = new Set<(e: SettingsChangeEvent) => void>();
  private readonly fs: SettingsFs;

  constructor(private readonly d: SettingsServiceDeps) {
    this.fs = d.fs ?? NODE_SETTINGS_FS;
    const plan = readSettings(this.fs, d.userDataDir, { knowledgeDbExists: d.knowledgeDbExists(), now: d.now() });
    const opened: Opened = plan.kind === 'migrate' ? this.migrate(plan.raw, plan.mtimeMs, plan.health, plan.review)
      : { doc: reviewed(plan.kind === 'doc' ? plan.doc : DEFAULT_DOC, plan.review), health: plan.health, refused: null };
    ({ doc: this.doc, health: this.health, refused: this.refused } = opened);
  }

  /** Migrate a raw v1 file; a refusal keeps v1's own numbers, lists and practice mode in memory. */
  private migrate(raw: string, mtimeMs: number, health: SettingsHealth, review: boolean): Opened {
    const now = this.d.now();
    const out = migrateV1(raw, { now, legacyAccountPk: null, mtimeMs, basis: migrationBasis(this.d.math),
      resolve: (doc) => this.resolveFor(doc) });
    if (out.kind === 'migrated') {
      const doc = reviewed(out.doc, review);
      const next = { ...doc, rev: doc.rev + 1 };
      const written = writeSettings(this.fs, this.d.userDataDir, next, { now, fromV1Sha256: doc.migration?.fromV1?.sha256 ?? null });
      if (!written.ok) logger.error('settings: the migrated settings could not be saved; the migration runs again next launch');
      return { doc: written.ok ? next : doc, health: health.kind === 'ok' ? { kind: 'migrated', at: now } : health, refused: null };
    }
    const detail = out.reasons.join(', ');
    logger.error('settings: the v1 migration was refused; running on the v1 settings as they were', { detail });
    let parsed: Partial<Settings> = {};
    try {
      parsed = JSON.parse(raw) as Partial<Settings>;
    } catch (e) {
      logger.error('settings: the v1 file is not JSON; defaults under review', { error: String(e) });
      return { doc: reviewed(DEFAULT_DOC, true), health: { kind: 'defaults-after-unreadable', quarantined: null }, refused: null };
    }
    const v1 = sanitizeSettings(migrateLegacyPattern({ ...parsed }));
    const protection = { ...DEFAULT_DOC.protection, accounts: migrateAccountList(parsed.pruneWhitelist, now).accounts,
      words: migrateWordList(parsed.pruneBioFilterWords, now).words };
    const doc: SettingsDocV2 = { ...DEFAULT_DOC, seed: v1.seed, protection, protectionState: 'needs-review',
      prefs: { ...DEFAULT_DOC.prefs, practice: v1.dryRun, acceptRequests: v1.autoAcceptFollowRequests } };
    return { doc, health: { kind: 'migration-refused', detail }, refused: { v1, detail } };
  }

  private resolveFor(doc: SettingsDocV2): ResolvedParams {
    return resolveParams({ intent: doc.intent, overrides: doc.overrides, plan: this.capabilities.plan, math: this.d.math });
  }

  /** Everything derived from the document, computed once per revision, capabilities and health. */
  private derived() {
    const key = JSON.stringify([this.doc.rev, this.capabilities, this.health, this.doc.app.mode, this.doc.app.dismissedNotices]);
    if (this.memo?.key !== key) {
      const resolved = this.resolveFor(this.doc);
      const effective = this.refused === null ? effectiveFrom(this.doc, resolved) : effectiveFromV1(this.refused.v1);
      const index = compileProtection(this.doc.protection, this.doc.protectionState, this.doc.rev);
      const view = buildView({ doc: this.doc, health: this.health, capabilities: this.capabilities, resolved, effective,
        math: this.d.math, week: null });
      this.memo = { key, resolved, effective, index, view };
    }
    return this.memo;
  }

  view(): SettingsView { return this.derived().view; }
  effective(): EffectiveSettings { return this.derived().effective; }
  protection(): ProtectionIndex { return this.derived().index; }
  app(): { readonly tourCompletedAt: number | null } { return { tourCompletedAt: this.doc.app.tourCompletedAt }; }
  basis(): BasisResult { return { kind: 'unavailable' }; }
  setCapabilities(patch: Partial<SettingsCapabilities>): void { this.capabilities = { ...this.capabilities, ...patch }; }
  setPlanPort(port: PlanPreviewPort | null): void { this.port = port; }
  planPort(): PlanPreviewPort | null { return this.port; }

  onChange(fn: (e: SettingsChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The v1 sweep and prune stamps the migration carried, until the reopen state takes them (then consumed). */
  takeBookkeeping(): V1Bookkeeping & { readonly forPk: string | null } | null {
    return this.doc.migration?.bookkeeping ?? null;
  }

  /** Apply ops through the one writer: persist first; a failed write changes nothing at all. */
  apply(ops: readonly SettingsOp[], origin: 'user' | 'system'): SettingsSaveResult {
    if (ops.length === 1 && ops[0].op === 'migration') return this.recover(ops[0].action);
    const r = applyOps(this.doc, ops, { origin, now: this.d.now(), migrationPending: this.refused !== null,
      recommended: (doc, key) => this.resolveFor(doc)[key].recommended });
    if (r.kind === 'refused') return { kind: 'refused', reason: r.reason, detail: r.detail, view: this.view() };
    const prev = this.derived();
    if (this.refused !== null) {
      // While a migration is refused nothing is written: the mode switch lives in memory.
      this.doc = r.doc;
      return { kind: 'saved', view: this.view(), adjustments: r.adjustments, conflicts: [], applies: [], inverse: r.inverse };
    }
    const next = { ...r.doc, rev: this.doc.rev + 1 };
    const written = writeSettings(this.fs, this.d.userDataDir, next, { now: this.d.now(), fromV1Sha256: null });
    if (!written.ok) return { kind: 'not-saved', view: this.view(), detail: written.detail };
    this.doc = next;
    const now = this.derived();
    const event: SettingsChangeEvent = { rev: next.rev, prev: prev.effective, next: now.effective, touched: r.touched, origin };
    this.emit(event);
    this.d.push(now.view);
    return { kind: 'saved', view: now.view, adjustments: r.adjustments, conflicts: conflicts(prev.resolved, now.resolved),
      applies: applies(prev.resolved, now.resolved, this.capabilities.plan), inverse: r.inverse };
  }

  private emit(event: SettingsChangeEvent): void {
    const g = this.d.graph?.() ?? null;
    if (g !== null) reloadChanged(g, toV1Settings(event.prev, this.doc, null), toV1Settings(event.next, this.doc, null));
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (e) {
        logger.error('settings: a change listener failed; the save stands', { error: String(e) });
      }
    }
  }

  /** What the ops would do: pure — nothing persists, nothing is pushed, the plan is not touched. */
  preview(ops: readonly SettingsOp[]): SettingsPreviewResult {
    const r = applyOps(this.doc, ops, { origin: 'user', now: this.d.now(), migrationPending: this.refused !== null,
      recommended: (doc, key) => this.resolveFor(doc)[key].recommended });
    if (r.kind === 'refused') return { kind: 'unavailable' };
    const before = this.derived();
    const resolved = this.resolveFor(r.doc);
    const effective = effectiveFrom(r.doc, resolved);
    const view = buildView({ doc: r.doc, health: this.health, capabilities: this.capabilities, resolved, effective, math: this.d.math, week: null });
    return { kind: 'ok', view, changes: previewChanges(this.doc, r.doc, before.resolved, resolved),
      conflicts: conflicts(before.resolved, resolved), adjustments: r.adjustments };
  }

  /** The recovery ops of a refused migration, and the deliberate re-migration (spec §6.6, §6.10). */
  private recover(action: 'retry' | 'start-from-recommended' | 'remigrate-from-v1'): SettingsSaveResult {
    const at = (f: string) => `${this.d.userDataDir}/${f}`;
    if (action === 'start-from-recommended') {
      if (this.refused === null) return { kind: 'refused', reason: 'invalid', detail: 'no migration is pending', view: this.view() };
      const fresh: SettingsDocV2 = { ...DEFAULT_DOC, seed: this.doc.seed, protection: this.doc.protection,
        protectionState: 'needs-review', prefs: this.doc.prefs, rev: 1 };
      return this.reopen({ doc: fresh, health: { kind: 'ok' }, refused: null }, fresh);
    }
    if (action === 'retry' && this.refused === null) return { kind: 'refused', reason: 'invalid', detail: 'no migration is pending', view: this.view() };
    let raw: string;
    try {
      raw = this.fs.readFile(at(SETTINGS_FILES.v1));
    } catch (e) {
      return { kind: 'refused', reason: 'internal', detail: `the older settings are unreadable: ${String(e)}`, view: this.view() };
    }
    const health: SettingsHealth = action === 'retry' ? { kind: 'ok' } : { kind: 'remigrated-from-v1', quarantined: null };
    return this.reopen(this.migrate(raw, this.fs.mtimeMs(at(SETTINGS_FILES.v1)), health, action === 'remigrate-from-v1'), null);
  }

  private reopen(o: Opened, write: SettingsDocV2 | null): SettingsSaveResult {
    if (write !== null) {
      const ok = writeSettings(this.fs, this.d.userDataDir, write, { now: this.d.now(), fromV1Sha256: null });
      if (!ok.ok) return { kind: 'not-saved', view: this.view(), detail: ok.detail };
    }
    const prev = this.effective();
    ({ doc: this.doc, health: this.health, refused: this.refused } = o);
    if (this.refused !== null) return { kind: 'refused', reason: 'migration-pending', detail: this.refused.detail, view: this.view() };
    const event: SettingsChangeEvent = { rev: this.doc.rev, prev, next: this.effective(), origin: 'migration',
      touched: new Set<Touched>(['intent', 'overrides', 'seed', 'protection', 'prefs', 'app']) };
    this.emit(event);
    this.d.push(this.view());
    return { kind: 'saved', view: this.view(), adjustments: [], conflicts: [], applies: [], inverse: [] };
  }

  // --- @transitional: the v1 window for today's renderer and engine readers (deleted with the old UI) ---

  resolveSettings(): Settings {
    return this.refused?.v1 ?? toV1Settings(this.effective(), this.doc, this.takeBookkeeping());
  }

  async getSettings(): Promise<Settings> { return this.resolveSettings(); }

  /** An old renderer's partial as keyed ops; a failure throws so the old UI shows "Not saved". */
  async updateSettings(partial: Partial<Settings>): Promise<Settings> {
    const t = opsFromV1Partial(partial, this.resolveSettings(), this.derived().resolved);
    if (t.dropped.length > 0) logger.warn('settings: dropped writes of knobs v2 derives or no longer has', { dropped: t.dropped });
    if (Object.keys(t.bookkeeping).length > 0) this.recordBookkeeping(t.bookkeeping);
    if (t.ops.length > 0) {
      const r = this.apply(t.ops, 'user');
      if (r.kind !== 'saved') throw new Error(`settings not saved: ${r.kind === 'refused' ? r.reason : 'write failed'}: ${r.detail}`);
    }
    return this.resolveSettings();
  }

  async resetSettings(): Promise<Settings> {
    const r = this.apply([{ op: 'reset', scope: { kind: 'recommended' } }], 'user');
    if (r.kind !== 'saved') throw new Error(`settings not reset: ${r.detail}`);
    return this.resolveSettings();
  }

  /** The v1 run stamps today's sweep and scheduled prune keep, persisted with the migration record. */
  private recordBookkeeping(patch: Partial<V1Bookkeeping>): void {
    if (this.refused !== null) return;
    const m = this.doc.migration ?? { at: this.d.now(), fromV1: null, notes: [], bookkeeping: null };
    const bookkeeping = { forPk: null, sweepLastRunAt: null, sweepIntervalFactor: null, pruneLastRunAt: null, ...m.bookkeeping, ...patch };
    const next = { ...this.doc, rev: this.doc.rev + 1, migration: { ...m, bookkeeping } };
    if (writeSettings(this.fs, this.d.userDataDir, next, { now: this.d.now(), fromV1Sha256: null }).ok) this.doc = next;
  }
}

const reviewed = (doc: SettingsDocV2, review: boolean): SettingsDocV2 => (review ? { ...doc, protectionState: 'needs-review' } : doc);

/** Overrides whose recommendation moved under them (rendered inline as "You set … ; … would use …"). */
function conflicts(before: ResolvedParams, after: ResolvedParams): OverrideConflict[] {
  return (Object.keys(after) as ParamKey[]).flatMap((key) => {
    const o = after[key].override;
    return o === null || sameValue(before[key].recommended, after[key].recommended) ? []
      : [{ key, yours: o.requested, recommendedBefore: before[key].recommended, recommendedNow: after[key].recommended }];
  });
}

/** When the changed values take effect, for the save note. */
function applies(before: ResolvedParams, after: ResolvedParams, plan: boolean): ApplyNote[] {
  const when = new Set((Object.keys(after) as ParamKey[]).filter((k) => !sameValue(before[k].value, after[k].value))
    .map((k) => PARAM_SPECS[k].applies));
  const out: ApplyNote[] = [];
  if (when.has('now')) out.push({ what: 'applies-now' });
  if (when.has('replan')) out.push({ what: plan ? 'replanned-today' : 'from-tomorrow' });
  return out;
}
