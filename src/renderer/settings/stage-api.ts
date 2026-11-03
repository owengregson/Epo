/**
 * What every Settings section receives: the view and facts, the change queue, the mode, the status
 * projection (today's plan, Boost) and the stage's navigation and confirm helpers. One object, so a
 * section's props never drift from its siblings'.
 */
import type { Push } from '@/ipc/contract';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { SettingsCommit } from '@/renderer/hooks/useSettingsCommit';
import type { ToastKind } from '@/renderer/hooks/useToasts';
import type { SettingsFacts } from '@/shared/settings-facts';
import type { SettingsOp } from '@/shared/settings-ops';
import type { SectionId } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import type { UpdateStatus } from '@/shared/update-status';
import type { SettingsMode } from './sections';

export interface StageApi {
  readonly view: SettingsView;
  readonly facts: SettingsFacts | null;
  readonly c: SettingsCommit;
  readonly mode: SettingsMode;
  readonly status: Push<'status'> | null;
  readonly updateStatus: UpdateStatus | null;
  /** Bring a section (and optionally one row in it) into view. */
  scrollTo(section: SectionId, row?: string): void;
  /** Switch to Advanced if needed, then scroll to the section. */
  openAdvanced(section: SectionId, row?: string): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  toast(kind: ToastKind, message: string): void;
  /**
   * Send one control's change. `shown` is what the control shows until it settles; a change that would
   * move the pace to Instagram's known limit asks once per app session first.
   */
  send(key: string, ops: readonly SettingsOp[], shown?: unknown): void;
}

export interface SectionProps {
  readonly s: StageApi;
}
