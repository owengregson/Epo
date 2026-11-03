import type { JSX } from 'preact';
import { ChainView } from '@/renderer/views/ChainView';
import { QueuesView } from '@/renderer/views/QueuesView';

/** The People stage (spec §12.5): where Epo finds people, and who is in progress. */
export function PeoplePage(): JSX.Element {
  return (
    <div class="stage-page people-page">
      <ChainView />
      <QueuesView />
    </div>
  );
}
