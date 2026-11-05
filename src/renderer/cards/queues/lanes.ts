import type { Req } from '@/ipc/contract';

/** A follow record's lifecycle state, as the `queue:list` channel takes it. */
export type LaneState = Req<'queueList'>[0];

/** The People page's "In progress" lanes, in the order a person moves through them (spec §12.5). */
export type LaneKey = 'next' | 'waiting' | 'back' | 'leaving' | 'kept';

/** The four lanes listed from follow records; Kept reads the protection table instead. */
export type RowLaneKey = Exclude<LaneKey, 'kept'>;

export interface Lane {
  readonly key: LaneKey;
  readonly label: string;
  /** One line under the lane tabs saying who is in it. */
  readonly hint: string;
}

/** Each row lane's record state (`queue:list`). */
export const LANE_STATE: Readonly<Record<RowLaneKey, LaneState>> = {
  next: 'queued',
  waiting: 'pending_followback',
  back: 'followed_back',
  leaving: 'unfollow_queued',
};

export const LANES: readonly Lane[] = [
  { key: 'next', label: 'Up next', hint: 'People Epo plans to follow, best fit first.' },
  { key: 'waiting', label: 'Waiting', hint: 'People Epo followed, waiting to see if they follow back.' },
  { key: 'back', label: 'Following back', hint: 'People who followed you back. Epo keeps following them for a while.' },
  { key: 'leaving', label: 'Leaving soon', hint: 'People Epo will unfollow in an upcoming session.' },
  { key: 'kept', label: 'Kept', hint: 'People your protection settings keep. Epo never unfollows them.' },
];

export const ROW_LANES: readonly RowLaneKey[] = ['next', 'waiting', 'back', 'leaving'];
