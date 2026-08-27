/** @jsx h */
import { Fragment, h } from 'preact';
import { ActivityCard } from '@/renderer/cards/overview/ActivityCard';
import { GrowthCard } from '@/renderer/cards/overview/GrowthCard';
import { LiveStatusCard } from '@/renderer/cards/overview/LiveStatusCard';
import { NowTargetingCard } from '@/renderer/cards/overview/NowTargetingCard';
import { RateSafetyCard } from '@/renderer/cards/overview/RateSafetyCard';
import { SignInCard } from '@/renderer/cards/overview/SignInCard';
import type { LogLine } from '@/renderer/hooks/useLogFeed';
import { usePeekFit } from '@/renderer/hooks/usePeekFit';
import type { EpoStatus, Settings } from '@/types';

export interface OverviewViewProps {
  status: EpoStatus | null;
  settings: Settings | null;
  logLines: LogLine[];
  loggedOut: boolean;
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
export function OverviewView(props: OverviewViewProps): h.JSX.Element {
  usePeekFit('view-overview', props.loggedOut);

  // The sign-in gate takes stagger slot 0 when it leads; every other card
  // shifts down one so the entrance cascade matches the visual order.
  const base = props.loggedOut ? 1 : 0;

  return (
    <Fragment>
      {props.loggedOut ? <SignInCard pending={props.pending} onLogin={props.onLogin} /> : null}
      <LiveStatusCard status={props.status} settings={props.settings} index={base} />
      <GrowthCard status={props.status} index={base + 1} />
      <NowTargetingCard status={props.status} index={base + 2} />
      <RateSafetyCard status={props.status} settings={props.settings} index={base + 3} />
      <ActivityCard logLines={props.logLines} index={base + 4} />
    </Fragment>
  );
}
