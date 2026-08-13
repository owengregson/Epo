/** @jsx h */
import { h, Fragment } from 'preact';
import type { LogEntry, EpoStatus, Settings } from '@/types';
import { SignInCard } from '@/renderer/cards/overview/SignInCard';
import { LiveStatusCard } from '@/renderer/cards/overview/LiveStatusCard';
import { GrowthCard } from '@/renderer/cards/overview/GrowthCard';
import { NowTargetingCard } from '@/renderer/cards/overview/NowTargetingCard';
import { RateSafetyCard } from '@/renderer/cards/overview/RateSafetyCard';
import { ActivityCard } from '@/renderer/cards/overview/ActivityCard';
import { usePeekFit } from '@/renderer/hooks/usePeekFit';

export interface OverviewViewProps {
  status: EpoStatus | null;
  settings: Settings | null;
  logLines: LogEntry[];
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

  return (
    <Fragment>
      {props.loggedOut ? <SignInCard pending={props.pending} onLogin={props.onLogin} /> : null}
      <LiveStatusCard status={props.status} settings={props.settings} />
      <GrowthCard status={props.status} />
      <NowTargetingCard status={props.status} />
      <RateSafetyCard status={props.status} settings={props.settings} />
      <ActivityCard logLines={props.logLines} />
    </Fragment>
  );
}
