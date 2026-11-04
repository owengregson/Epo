/**
 * The settings service (spec §6.6, §6.9, Appendix B.8): the one writer of epo-settings-v2.json. Reads or
 * migrates at construction, applies ops persist-first, recompiles protection and the view per revision,
 * tells its listeners and pushes the view after every persisted write.
 */
import type { PlanPreviewPort } from '@/governors/plan-types';
import { kernelCatalog } from '@/kernel/catalog';
import type { BuiltGraph } from '@/main/services/graph-types';
import { migrationBasis, type PlanMath } from '@/settings/basis';
import { DEFAULT_DOC, type SettingsDocV2 } from '@/settings/doc';
import { type EffectiveSettings, effectiveFrom } from '@/settings/effective';
import { migrateV1 } from '@/settings/migrate-v1';
import { refusedState } from '@/settings/migration-refusal';
import { type ChangedV1, olderVersionOffer, readChangedV1 } from '@/settings/older-version';
import { applyOps, type OpsCtx, type Touched } from '@/settings/ops';
import { NODE_SETTINGS_FS, readSettings, SETTINGS_FILES, type SettingsFs, type WriteResult, writeSettings } from '@/settings/persist';
import { KERNEL_PLAN_MATH } from '@/settings/plan-math';
import { type SettingsPlanPreview, settingsPlanPreview } from '@/settings/plan-preview-port';
import type { ResolvedParams } from '@/settings/resolve';
import type { Settings } from '@/settings/v1/settings-v1-types';
import { applyNotes, buildView, overrideConflicts, previewChanges } from '@/settings/view';
import type { SettingsOp, SettingsPreviewResult, SettingsSaveResult } from '@/shared/settings-ops';
import type { BasisResult, SettingsCapabilities, SettingsHealth, SettingsView } from '@/shared/settings-view';
import type { ProtectionIndex } from '@/shared/unfollow-protection';
import * as logger from '@/utils/logger';
import { ProtectionLinker, type SettingsStoreBinding } from './protection-linker';
import { resolveDoc, type SettingsCore, SettingsDerived } from './settings-derived';
import { reloadChanged } from './settings-reload';

export { type SettingsStoreBinding, settingsBinding } from './protection-linker';

export interface SettingsChangeEvent {
  readonly rev: number; readonly prev: EffectiveSettings; readonly next: EffectiveSettings;
  readonly touched: ReadonlySet<Touched>; readonly origin: 'user' | 'system' | 'migration';
}

export interface SettingsServiceDeps {
  readonly userDataDir: string;
  readonly fs?: SettingsFs;
  knowledgeDbExists(): boolean;
  /** The plan core's numbers (the effective gap, the day law, the retry limit); the kernel's by default. */
  readonly math?: PlanMath;
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
const EVERYTHING = new Set<Touched>(['intent', 'overrides', 'seed', 'protection', 'prefs', 'app']);

export class SettingsService {
  private doc: SettingsDocV2;
  private health: SettingsHealth;
  private refused: Refused | null;
  private capabilities: SettingsCapabilities = OFF;
  private port: PlanPreviewPort | null = null;
  private bookkeepingOwner: string | null = null;
  private planPreview: SettingsPlanPreview | null = null;
  private readonly listeners = new Set<(e: SettingsChangeEvent) => void>();
  private readonly fs: SettingsFs;
  private readonly math: PlanMath;
  private readonly derived: SettingsDerived;
  /** The v1 file an older build rewrote after the migration (its additions are offered back), read at launch. */
  private readonly older: ChangedV1 | null;
  private readonly linker = new ProtectionLinker({ settings: this, now: () => this.d.now() });

  constructor(private readonly d: SettingsServiceDeps) {
    this.fs = d.fs ?? NODE_SETTINGS_FS;
    this.math = d.math ?? KERNEL_PLAN_MATH;
    this.derived = new SettingsDerived(this.math);
    const plan = readSettings(this.fs, d.userDataDir, { knowledgeDbExists: d.knowledgeDbExists(), now: d.now() });
    const opened: Opened = plan.kind === 'migrate' ? this.migrate(plan.raw, plan.mtimeMs, plan.health, plan.review)
      : { doc: reviewed(plan.kind === 'doc' ? plan.doc : DEFAULT_DOC, plan.review), health: plan.health, refused: null };
    ({ doc: this.doc, health: this.health, refused: this.refused } = opened);
    this.older = readChangedV1(this.fs, d.userDataDir, this.doc.migration);
  }

  /** Migrate a raw v1 file; a refusal keeps v1's own numbers, lists and practice mode in memory. */
  private migrate(raw: string, mtimeMs: number, health: SettingsHealth, review: boolean): Opened {
    const now = this.d.now();
    const out = migrateV1(raw, { now, legacyAccountPk: null, mtimeMs, basis: migrationBasis(this.math),
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
    const state = refusedState(raw, now);
    if (state.kind === 'unreadable') {
      logger.error('settings: the v1 file is not JSON; defaults under review', { error: state.error });
      return { doc: reviewed(DEFAULT_DOC, true), health: { kind: 'defaults-after-unreadable', quarantined: null }, refused: null };
    }
    return { doc: state.doc, health: { kind: 'migration-refused', detail }, refused: { v1: state.v1, detail } };
  }

  private resolveFor(doc: SettingsDocV2): ResolvedParams { return resolveDoc(doc, this.capabilities.plan, this.math); }

  /** Resolved params, effective settings and protection: upstream of the plan, so they never draw its week. */
  private core(): SettingsCore { return this.derived.core({ doc: this.doc, refused: this.refused, plan: this.capabilities.plan }); }

  view(): SettingsView {
    return this.derived.view(this.core(), { capabilities: this.capabilities, health: this.health, preview: this.planPreview,
      older: this.older, now: this.d.now() });
  }
  effective(): EffectiveSettings { return this.core().effective; }
  protection(): ProtectionIndex { return this.core().index; }
  app(): { readonly tourCompletedAt: number | null } { return { tourCompletedAt: this.doc.app.tourCompletedAt }; }
  basis(): BasisResult { return { kind: 'ok', rows: kernelCatalog() }; }
  setCapabilities(patch: Partial<SettingsCapabilities>): void {
    const next = { ...this.capabilities, ...patch };
    if (Object.keys(next).every((key) => next[key as keyof SettingsCapabilities] === this.capabilities[key as keyof SettingsCapabilities])) return;
    this.capabilities = next;
    this.d.push(this.view());
  }
  planPort(): PlanPreviewPort | null { return this.port; }

  /** The plan wiring registers its preview port (null withdraws it; it keys the view only); `plan` stays its own to set. */
  setPlanPort(port: PlanPreviewPort | null): void {
    this.port = port;
    this.planPreview = port === null ? null : settingsPlanPreview(port);
  }

  /** Graph OPEN binds the store (its account owns the run stamps); CLOSE passes null. */
  bindStore(binding: SettingsStoreBinding | null): void {
    this.linker.bind(binding);
  }

  onChange(fn: (e: SettingsChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** An unowned migration stamp belongs to the first opened account, even if its consumption cannot save. */
  takeBookkeeping(ownPk: string): NonNullable<SettingsDocV2['migration']>['bookkeeping'] {
    const carried = this.doc.migration?.bookkeeping ?? null;
    if (carried === null) return null;
    if (carried.forPk === null) this.bookkeepingOwner ??= ownPk;
    const forPk = carried.forPk ?? this.bookkeepingOwner;
    return forPk === ownPk ? { ...carried, forPk } : null;
  }

  /** Apply ops through the one writer; failed saves leave user settings unchanged. */
  apply(ops: readonly SettingsOp[], origin: 'user' | 'system'): SettingsSaveResult {
    if (ops.length === 1 && ops[0].op === 'migration') return this.recover(ops[0].action);
    const r = applyOps(this.doc, ops, this.opsCtx(origin));
    if (r.kind === 'refused') return { kind: 'refused', reason: r.reason, detail: r.detail, view: this.view() };
    if (this.refused !== null) {
      // While a migration is refused nothing is written: the mode switch lives in memory.
      this.doc = r.doc;
      return { kind: 'saved', view: this.view(), adjustments: r.adjustments, conflicts: [], applies: [], inverse: r.inverse };
    }
    if (ops.some((op) => op.op === 'consume-bookkeeping')) {
      const claim = this.claimBookkeeping();
      if (!claim.ok) return { kind: 'not-saved', view: this.view(), detail: claim.detail };
    }
    const before = this.core();
    const written = this.commit({ ...r.doc, rev: this.doc.rev + 1 }, origin, r.touched);
    if (!written.ok) return { kind: 'not-saved', view: this.view(), detail: written.detail };
    const after = this.core();
    const replanned = this.planPreview === null ? null
      : this.planPreview.fingerprint(before.effective) !== this.planPreview.fingerprint(after.effective);
    return { kind: 'saved', view: this.view(), adjustments: r.adjustments, conflicts: overrideConflicts(before.resolved, after.resolved),
      applies: applyNotes(before.resolved, after.resolved, this.capabilities.plan, replanned), inverse: r.inverse };
  }

  /** Persist ownership before clearing, so the normal backup cannot resurrect an unowned stamp. */
  private claimBookkeeping(): WriteResult {
    const migration = this.doc.migration;
    const bookkeeping = migration?.bookkeeping;
    if (migration === null || bookkeeping == null || bookkeeping.forPk !== null) return { ok: true };
    if (this.bookkeepingOwner === null) return { ok: false, detail: 'bookkeeping needs an account before consumption' };
    return this.commit({ ...this.doc, rev: this.doc.rev + 1,
      migration: { ...migration, bookkeeping: { ...bookkeeping, forPk: this.bookkeepingOwner } } }, 'system', new Set());
  }

  /** What the ops would do: pure — nothing persists, nothing is pushed, the plan is not touched. */
  preview(ops: readonly SettingsOp[]): SettingsPreviewResult {
    const r = applyOps(this.doc, ops, this.opsCtx('user'));
    if (r.kind === 'refused') return { kind: 'unavailable' };
    const before = this.core();
    const resolved = this.resolveFor(r.doc);
    const effective = effectiveFrom(r.doc, resolved);
    const view = buildView({ doc: r.doc, health: this.health, capabilities: this.capabilities, resolved, effective, math: this.math, week: null });
    return { kind: 'ok', view, changes: previewChanges(this.doc, r.doc, before.resolved, resolved),
      conflicts: overrideConflicts(before.resolved, resolved), adjustments: r.adjustments };
  }

  private opsCtx(origin: 'user' | 'system'): OpsCtx {
    return { origin, now: this.d.now(), migrationPending: this.refused !== null, olderVersion: olderVersionOffer(this.doc, this.older, this.d.now()),
      recommended: (doc, key) => this.resolveFor(doc)[key].recommended };
  }

  /** The recovery ops of a refused migration, and the deliberate re-migration (spec §6.6, §6.10). */
  private recover(action: 'retry' | 'start-from-recommended' | 'remigrate-from-v1'): SettingsSaveResult {
    const at = (f: string) => `${this.d.userDataDir}/${f}`;
    if (action !== 'remigrate-from-v1' && this.refused === null) return { kind: 'refused', reason: 'invalid', detail: 'no migration is pending', view: this.view() };
    if (action === 'start-from-recommended') {
      const fresh: SettingsDocV2 = { ...DEFAULT_DOC, seed: this.doc.seed, protection: this.doc.protection,
        protectionState: 'needs-review', prefs: this.doc.prefs, rev: 1 };
      return this.reopen({ doc: fresh, health: { kind: 'ok' }, refused: null }, fresh);
    }
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
    this.announce({ rev: this.doc.rev, prev, next: this.effective(), origin: 'migration', touched: EVERYTHING });
    return { kind: 'saved', view: this.view(), adjustments: [], conflicts: [], applies: [], inverse: [] };
  }

  /** Persist, then adopt the document, tell the listeners and push the view; a failed write changes nothing. */
  private commit(next: SettingsDocV2, origin: SettingsChangeEvent['origin'], touched: ReadonlySet<Touched>): WriteResult {
    const prev = this.effective();
    const written = writeSettings(this.fs, this.d.userDataDir, next, { now: this.d.now(), fromV1Sha256: null });
    if (!written.ok) {
      logger.error('settings: the save failed; nothing changed', { detail: written.detail });
      return written;
    }
    this.doc = next;
    this.announce({ rev: next.rev, prev, next: this.effective(), touched, origin });
    return written;
  }

  private announce(event: SettingsChangeEvent): void {
    const g = this.d.graph?.() ?? null;
    if (g !== null) reloadChanged(g, event.prev, event.next, event);
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch (e) {
        logger.error('settings: a change listener failed; the save stands', { error: String(e) });
      }
    }
    this.d.push(this.view());
  }

}

const reviewed = (doc: SettingsDocV2, review: boolean): SettingsDocV2 => (review ? { ...doc, protectionState: 'needs-review' } : doc);
