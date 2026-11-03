/**
 * The live column (spec §12.1–12.2, ADR 1010): instruments only — the masthead, Now, Today, Results and
 * Recent activity over the footer, at fixed heights with reserved slots, so a posture change never reflows
 * it. A first run shows Get started in Today's and Results' place; before the store is built both zones hold
 * final-size skeletons, never a digit (law L-ZERO). Short windows scroll everything under Now (CSS only).
 */
import { computed } from '@preact/signals';
import type { JSX } from 'preact';
import type { Res } from '@/ipc/contract';
import { feedSignal } from '@/renderer/app/live-signals';
import { pruneSignal, statusSignal } from '@/renderer/app/shell-context';
import type { ToastControls } from '@/renderer/hooks/useToasts';
import { ActivityFeed } from '@/renderer/sidebar/ActivityFeed';
import { BoostCard } from '@/renderer/sidebar/BoostControl';
import { RESULTS, TODAY_TITLE } from '@/renderer/sidebar/copy/zone-copy';
import { GetStarted } from '@/renderer/sidebar/GetStarted';
import { Masthead } from '@/renderer/sidebar/Masthead';
import { NowPanel } from '@/renderer/sidebar/NowPanel';
import { postureInputSignal, postureSignal } from '@/renderer/sidebar/posture-signal';
import { ResultsPanel } from '@/renderer/sidebar/ResultsPanel';
import { SidebarFooter } from '@/renderer/sidebar/SidebarFooter';
import { SidebarToasts } from '@/renderer/sidebar/SidebarToasts';
import { TodayPanel } from '@/renderer/sidebar/TodayPanel';
import { Skeleton } from '@/renderer/ui/Skeleton';

export interface SidebarProps {
  readonly toasts: ToastControls;
  readonly update: Res<'updateStatus'> | null;
}

/** Epo has acted for this account: a run on record, or a settled follow or unfollow in the feed. */
export const actedSignal = computed(() => {
  const s = statusSignal.value;
  if (s?.lastActionAt != null || s?.state === 'running' || s?.state === 'paused') return true;
  return feedSignal.value?.items.some((i) => i.kind === 'followed' || i.kind === 'unfollowed') ?? false;
});

/**
 * What fills the middle: Get started on a first run (`!loggedIn`, no starting account, or nothing done
 * yet), the built zones, or their skeletons. A computed, so a push that changes none of it re-renders nothing.
 */
const middleSignal = computed((): 'start' | 'built' | 'waiting' | null => {
  const s = statusSignal.value;
  if (s === null) return null;
  if (!s.loggedIn || !postureInputSignal.value.seedSet || !actedSignal.value) return 'start';
  return s.basis === 'built' ? 'built' : 'waiting';
});

/** The column's state for the shell's cascade: a prune holding the tab reads as running (or paused). */
const transportSignal = computed(() => {
  if (postureSignal.value.driver === 'prune') return pruneSignal.value?.state === 'paused' ? 'paused' : 'running';
  return statusSignal.value?.state ?? 'idle';
});

/** The two zones' final size while the store is not built yet. */
function Waiting(): JSX.Element {
  return (
    <>
      <section class="sb-zone sb-today" data-zone="today" data-tour="today">
        <div class="sb-today__title">
          <h3>{TODAY_TITLE}</h3>
        </div>
        <Skeleton lines={3} label={RESULTS.loading} />
      </section>
      <section class="sb-zone sb-results" data-zone="results" data-tour="results">
        <Skeleton lines={3} label={RESULTS.loading} />
      </section>
    </>
  );
}

export function Sidebar({ toasts, update }: SidebarProps): JSX.Element {
  const tone = postureSignal.value.tone;
  const middle = middleSignal.value;
  return (
    <aside class="console sidebar" data-state={transportSignal.value} data-tone={tone} aria-label="Live">
      <Masthead tone={tone} />
      <NowPanel />
      <div class="sb-middle">
        {middle === 'start' ? (
          <GetStarted started={actedSignal.value} />
        ) : middle === 'built' ? (
          <>
            <TodayPanel />
            <ResultsPanel />
          </>
        ) : (
          <Waiting />
        )}
        <ActivityFeed />
      </div>
      <SidebarFooter update={update} />
      <SidebarToasts toasts={toasts} />
      <BoostCard />
    </aside>
  );
}
