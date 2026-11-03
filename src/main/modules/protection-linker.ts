/**
 * The protection linker (spec §7.7): on the throttled store mutation pulse it links protected handles the
 * store now maps to a pk and follows renames of linked ones, through system ops and only when something
 * changed. Zero Instagram traffic: it reads the store, never the tab.
 */
import type { BuiltGraph } from '@/main/services/graph-types';
import type { ProtectedAccount } from '@/shared/settings-model';
import type { SettingsOp, SettingsSaveResult } from '@/shared/settings-ops';
import { POLL } from '@/timing/config';
import * as logger from '@/utils/logger';

/** The open store, bound on graph OPEN and dropped on CLOSE (the kernel Session binding). */
export interface SettingsStoreBinding {
  readonly ownPk: string;
  pkByUsername(username: string): string | null;
  username(pk: string): string | null;
  onMutation(fn: () => void): () => void;
}

/** A built graph's binding: its account owns the run stamps, its store links protected handles. */
export function settingsBinding(graph: BuiltGraph): SettingsStoreBinding {
  return { ownPk: graph.ownPk, pkByUsername: (u) => graph.store.pkByUsername(u),
    username: (pk) => graph.store.getAccount(pk)?.username ?? null, onMutation: (fn) => graph.store.onMutation(fn) };
}

const ALL_DIGITS = /^\d+$/;

/**
 * The links the store now implies: an unlinked handle it maps takes its pk; a linked pk it knows under a new
 * name follows the rename. Migrated all-digit entries keep matching pk or name exactly as v1 did.
 */
export function linkOps(accounts: readonly ProtectedAccount[], store: Pick<SettingsStoreBinding, 'pkByUsername' | 'username'>,
  at: number): SettingsOp[] {
  return accounts.flatMap((a): SettingsOp[] => {
    if (!a.valid || (a.pk !== null && ALL_DIGITS.test(a.username) && a.pk === a.username)) return [];
    if (a.pk === null) {
      const pk = store.pkByUsername(a.username);
      return pk === null ? [] : [{ op: 'protect-link', pk, username: a.username, at }];
    }
    const current = store.username(a.pk);
    if (current !== null && current !== a.username) return [{ op: 'protect-link', pk: a.pk, username: current, at }];
    return a.linkedAt === null ? [{ op: 'protect-link', pk: a.pk, username: a.username, at }] : [];
  });
}

export interface ProtectionLinkerDeps {
  /** The settings service's protection list and its one writer. */
  settings: {
    view(): { readonly health: { readonly kind: string }; readonly protection: { readonly accounts: readonly ProtectedAccount[] } };
    apply(ops: readonly SettingsOp[], origin: 'system'): SettingsSaveResult;
  };
  now(): number;
  /** Trailing coalescing window (the graph push throttle by default). */
  throttleMs?: number;
}

export class ProtectionLinker {
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: ProtectionLinkerDeps) {}

  /** Follow a store (links once at open, then after each burst of writes); null stops. */
  bind(store: SettingsStoreBinding | null): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (store === null) return;
    this.unsub = store.onMutation(() => {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.link(store);
      }, this.d.throttleMs ?? POLL.GRAPH_PUSH_THROTTLE_MS);
    });
    this.link(store);
  }

  /** Persist the links the store implies, if any (one system write); a refused migration links nothing. */
  link(store: Pick<SettingsStoreBinding, 'pkByUsername' | 'username'>): void {
    const view = this.d.settings.view();
    const ops = view.health.kind === 'migration-refused' ? [] : linkOps(view.protection.accounts, store, this.d.now());
    if (ops.length === 0) return;
    const r = this.d.settings.apply(ops, 'system');
    if (r.kind !== 'saved') logger.warn('protection linker: the links were not saved', { kind: r.kind, detail: r.detail });
    else logger.info('protection linker: linked protected accounts', { count: ops.length });
  }
}
