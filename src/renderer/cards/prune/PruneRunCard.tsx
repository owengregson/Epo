/** @jsx h */
import { h } from 'preact';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import { commas } from '@/renderer/lib/format';
import { Badge, type BadgeTone } from '@/renderer/ui/Badge';
import { Button } from '@/renderer/ui/Button';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { Meter } from '@/renderer/ui/Meter';
import { Stepper } from '@/renderer/ui/Stepper';
import type { PruneStatus, Settings } from '@/types';

type PruneSentinel = NonNullable<PruneStatus['lastSentinel']>;

/** Short sentinel readout (mirrors the Live Status card's vocabulary). */
function sentinelLabel(s: PruneSentinel): string {
  switch (s) {
    case 'ok':
      return 'ok';
    case 'action-blocked':
      return 'blocked';
    case 'challenge':
      return 'challenge';
    default:
      return 'logged out';
  }
}

/** Readable state label + badge tone for the prune state chip (also the
 *  prune page's hero badge — see PruneView). */
export function stateChip(state: PruneStatus['state'] | undefined): { label: string; tone: BadgeTone } {
  switch (state) {
    case 'scanning':
      return { label: 'Scanning', tone: 'live' };
    case 'running':
      return { label: 'Running', tone: 'live' };
    case 'done':
      return { label: 'Done', tone: 'default' };
    case 'halted':
      return { label: 'Halted', tone: 'warn' };
    default:
      return { label: 'Idle', tone: 'default' };
  }
}

export interface PruneRunCardProps {
  /** Live prune projection. */
  prune: PruneStatus | null;
  /** Growth engine actively running — running prune will pause it, then resume it. */
  growthRunning: boolean;
  /**
   * Whether a fresh, complete scan is ready (the 2-step gate): Run stays locked
   * until the user scans, so a run only ever acts on a reviewed candidate set.
   */
  readyToRun: boolean;
  /** Best-known candidate count (this session's scan, else the last scan). */
  candidates: number;
  /** Which control is awaiting the backend, if any. */
  pending: 'run' | 'stop' | null;
  onRun(): void;
  /** Halt the active run (already confirmed by this card). */
  onStop(): void;
  /** The shell's confirm modal — gates every stop. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Persisted settings (for the daily-unfollow cap); null while loading. */
  settings: Settings | null;
  /** Persist a partial settings change (the view saves + relays onSaved). */
  onSave(part: Partial<Settings>): void;
}

/**
 * Prune · Run — the destructive controls. Run (confirm-gated by the view)
 * starts one full prune run; Stop (confirm-gated here) halts it between
 * actions. The meter tracks unfollowed / candidates live, and a halt surfaces
 * its sentinel verdict.
 */
export function PruneRunCard({
  prune,
  growthRunning,
  readyToRun,
  candidates,
  pending,
  onRun,
  onStop,
  confirm,
  settings,
  onSave,
}: PruneRunCardProps): h.JSX.Element {
  const state = prune?.state ?? 'idle';
  const active = state === 'scanning' || state === 'running';
  const chip = stateChip(prune?.state);

  const total = prune !== null && prune.candidates > 0 ? prune.candidates : candidates;
  const unfollowed = prune?.unfollowed ?? 0;
  const remaining = prune?.remaining ?? 0;
  // Progress = candidates VISITED, not verified unfollows: dry-run, failed and
  // skipped candidates all advance the run (a dry-run used to sit at 0% for an
  // entire run while the footer counted down, looking hung).
  const visited = Math.max(0, total - remaining);
  const pct = total > 0 ? (visited / total) * 100 : 0;

  const dailyDone = prune?.dailyDone ?? 0;
  const dailyLimit = prune?.dailyLimit ?? 0;
  const atDailyLimit = dailyLimit > 0 && dailyDone >= dailyLimit;
  const halted = state === 'halted';
  const lastSentinel = prune?.lastSentinel ?? null;

  const onStopRun = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Stop the prune run?',
      body: 'The accounts already unfollowed stay unfollowed.',
      confirm: 'Stop run',
      dismiss: 'Keep running',
      danger: true,
    });
    if (ok) onStop();
  };

  return (
    <Card index={2}>
      <CardHeader icon="user-minus" aux={active ? `${commas(remaining)} remaining` : undefined}>
        Prune · Run
      </CardHeader>
      <CardBody>
        <KeyValue k="State">
          <Badge tone={chip.tone}>{chip.label}</Badge>
        </KeyValue>
        <div class="hero-today num">
          <div class="ht-top">
            <span class="k">This run</span>
            <span class="v">
              <b>{commas(unfollowed)}</b> <span class="dim">/ {total > 0 ? commas(total) : '—'}</span>
            </span>
          </div>
          <Meter pct={pct} brass={halted} />
          <div class="ht-foot">
            <span>
              <b>{commas(remaining)}</b> remaining
            </span>
            <span>
              today <b>{commas(dailyDone)}</b> / {dailyLimit > 0 ? commas(dailyLimit) : '—'}
            </span>
          </div>
        </div>
        {/* Stop here means stop the RUN — a live scan's stop (with its own
            confirm copy) lives on PruneScanCard, so mid-scan this card keeps
            its (locked) Run affordance instead of a second, mislabeled stop. */}
        {state === 'running' ? (
          <Button
            wide
            icon="stop"
            iconSpin={pending === 'stop'}
            disabled={pending !== null}
            onClick={() => {
              void onStopRun();
            }}
          >
            Stop prune
          </Button>
        ) : (
          <Button
            wide
            danger
            icon="user-minus"
            iconSpin={pending === 'run'}
            disabled={!readyToRun || active || pending !== null}
            onClick={onRun}
          >
            Run prune
          </Button>
        )}
        <div class="hint" hidden={!readyToRun || active}>
          Unfollows run one at a time with paced delays; the daily limit and whitelist always apply.
        </div>
        <div class="hint" hidden={readyToRun || active}>
          Run a scan first — it unlocks pruning and shows exactly who a run would drop.
        </div>
        <div class="hint" hidden={!growthRunning || active}>
          The growth engine is running — pruning pauses it, then resumes it when the run finishes.
        </div>
        <div class="hint warn" hidden={active || !atDailyLimit}>
          Daily prune limit reached — the next run resumes tomorrow.
        </div>
        <div class="hint alarm" role="alert" hidden={!halted}>
          Halted{lastSentinel !== null ? ` — sentinel ${sentinelLabel(lastSentinel)}` : ''}. Check the
          Instagram tab before running again.
        </div>
        {settings !== null ? (
          <Field
            label="Daily unfollow limit"
            tip="Hard cap on prune unfollows per local day. Prune keeps its own ledger, independent of the growth engine's daily ceiling."
          >
            <Stepper
              min={5}
              max={500}
              step={5}
              value={settings.pruneDailyLimit}
              onChange={(v) => onSave({ pruneDailyLimit: v })}
              ariaLabel="Daily prune unfollow limit"
            />
          </Field>
        ) : null}
      </CardBody>
    </Card>
  );
}
