import type { JSX } from 'preact';
import { StageHost } from '@/renderer/app/StageHost';
import { LivePlaceholder } from '@/renderer/boot/LivePlaceholder';
import { GraphStage } from '@/renderer/graph/GraphStage';
import { useGraphBoard } from '@/renderer/hooks/useGraphBoard';
import { PeoplePage } from '@/renderer/pages/PeoplePage';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { PruneView } from '@/renderer/views/PruneView';

export const GALLERY_SURFACES = [
  { key: 'people', label: 'People' },
  { key: 'graph', label: 'Graph' },
  { key: 'prune', label: 'Prune' },
  { key: 'settings', label: 'Settings' },
  { key: 'live', label: 'Live placeholder' },
  { key: 'diagnostics', label: 'Diagnostics' },
] as const;
export type GallerySurface = (typeof GALLERY_SURFACES)[number]['key'];

function GalleryGraph({ active }: { active: boolean }): JSX.Element {
  const board = useGraphBoard(active);
  return <GraphStage board={board} active={active} />;
}

/** Real stage hosts retain page state across navigation, including the tour's lazy Settings reveal. */
export function GalleryStage({ surface, graphKey }: { surface: GallerySurface; graphKey: string }): JSX.Element {
  return <div class="stagepane-body">
    <StageHost mode="people" active={surface === 'people'} mount="on-activation"><PeoplePage /></StageHost>
    <StageHost mode="graph" active={surface === 'graph'} mount="on-activation">
      <GalleryGraph key={graphKey} active={surface === 'graph'} />
    </StageHost>
    <StageHost mode="prune" active={surface === 'prune'} mount="on-activation"><PruneView /></StageHost>
    <StageHost mode="settings" active={surface === 'settings'} mount="lazy"><SettingsStage updateStatus={null} /></StageHost>
    <StageHost mode="tab" active={surface === 'live'} mount="on-activation"><LivePlaceholder /></StageHost>
  </div>;
}
