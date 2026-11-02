import { Fragment, type JSX } from 'preact';
import { useShell } from '@/renderer/app/shell-context';
import { ActivityCard } from '@/renderer/cards/overview/ActivityCard';
import { GrowthCard } from '@/renderer/cards/overview/GrowthCard';
import { LiveStatusCard } from '@/renderer/cards/overview/LiveStatusCard';
import { NowTargetingCard } from '@/renderer/cards/overview/NowTargetingCard';
import { RateSafetyCard } from '@/renderer/cards/overview/RateSafetyCard';
import { SignInCard } from '@/renderer/cards/overview/SignInCard';
import { usePeekFit } from '@/renderer/hooks/usePeekFit';

export interface OverviewViewProps {
  /** Name of the in-flight shell control, or null (the sign-in gate spins on it). */
  pending: string | null;
  onLogin(): void;
}

/**
 * Overview view. Stacks the Live Status hero, Net Follower Growth, Now
 * Targeting, Rate & Safety, and Activity cards as direct children of the
 * `.view` section (the entrance stagger reads each card's `--i`), with the
 * sign-in gate prepended when logged out. The peek-fit grows the top two
 * cards so the third is deliberately cut at the fold — a scroll affordance.
 */
export function OverviewView(props: OverviewViewProps): JSX.Element {
  const { status, prune, settings } = useShell();
  const loggedOut = status !== null && !status.loggedIn;
  // The peek-fit measures the cards' NATURAL heights, so it must re-run when
  // the hero's content shape changes — a multi-line park caption, halt banner,
  // or offline hint would otherwise bake a stale min-height that outlives the
  // state (or eat the peek when it appears after the fit). The key folds in
  // every status facet that adds/removes hero lines.
  const heroShape = [
    loggedOut,
    status?.state ?? '',
    status?.parkReason ?? '',
    status?.haltReason ?? '',
    status != null && !status.online,
    status?.recovery?.phase ?? '',
    status?.runtime?.phase ?? '',
    status?.runtime?.blockedReason ?? '',
    status?.reentry?.phase ?? '',
    (status?.health?.consecutiveErrors ?? 0) > 0,
    status?.runtime?.lastProgressAt != null || status?.health?.lastProgressAt != null,
    prune?.state ?? '',
  ].join('|');
  usePeekFit('view-overview', heroShape);

  return (
    <Fragment>
      {loggedOut ? <SignInCard pending={props.pending} onLogin={props.onLogin} /> : null}
      <LiveStatusCard status={status} prune={prune} settings={settings} />
      <GrowthCard status={status} settings={settings} />
      <NowTargetingCard status={status} />
      <RateSafetyCard status={status} settings={settings} />
      <ActivityCard />
    </Fragment>
  );
}
