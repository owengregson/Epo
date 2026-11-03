import type { JSX } from 'preact';
import { chainListSignal } from '@/renderer/app/live-signals';
import { stageSignal, useShellControls } from '@/renderer/app/shell-context';
import { SEED_TARGET } from '@/renderer/app/shell-services';
import { FindsPanel } from '@/renderer/pages/people/FindsPanel';
import { GrowthPanel } from '@/renderer/pages/people/GrowthPanel';
import { ProgressPanel } from '@/renderer/pages/people/ProgressPanel';
import { Button } from '@/renderer/ui/Button';
import { Skeleton } from '@/renderer/ui/Skeleton';

/** The one empty state (spec C.15.7): no source yet. */
function NoSources(): JSX.Element {
  const { openSettings } = useShellControls();
  return (
    <div class="people-empty">
      <p>No sources yet. Choose a starting account in Settings and press Start.</p>
      <Button icon="sliders" onClick={() => openSettings(SEED_TARGET)}>
        Choose a starting account
      </Button>
    </div>
  );
}

/**
 * The People stage (spec §12.5): your followers over time, where Epo finds
 * people, and who is in progress. It renders at once from what the shell
 * fetched before the reveal, and reads Instagram-derived data again only while
 * it is shown.
 */
export function PeoplePage(): JSX.Element {
  const active = stageSignal.value === 'people';
  const chain = chainListSignal.value;

  return (
    <div class="stage-page people-page">
      <header class="stage-page__head">
        <h1>People</h1>
        <p>Where Epo finds people, and who’s in progress.</p>
      </header>
      <GrowthPanel active={active} />
      <div class="people-cols">
        <section class="stage-col people-panel" aria-labelledby="people-finds-h">
          <h2 id="people-finds-h">Where Epo finds people</h2>
          {chain === null ? (
            <Skeleton lines={4} label="Loading your sources" />
          ) : chain.length === 0 ? (
            <NoSources />
          ) : (
            <FindsPanel chain={chain} active={active} />
          )}
        </section>
        <section class="stage-col people-panel" aria-labelledby="people-progress-h">
          <h2 id="people-progress-h">In progress</h2>
          <ProgressPanel active={active} />
        </section>
      </div>
    </div>
  );
}
