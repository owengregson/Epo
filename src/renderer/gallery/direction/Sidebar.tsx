/**
 * The live column as one posture at one height. Zone heights come from
 * `sidebarGeometry`, so a posture change never reflows the column and the
 * test can add the zones up.
 */
import { type JSX } from 'preact';
import { sidebarGeometry } from '@/renderer/gallery/direction/layout';
import type { PostureSpec } from '@/renderer/gallery/direction/postures';
import { Footer, Masthead, NowZone } from '@/renderer/gallery/direction/sidebar-now';
import { ActivityZone, BoostPreview, GetStarted, ResultsZone, TodayZone } from '@/renderer/gallery/direction/sidebar-panels';

export function Sidebar({ p, height }: { p: PostureSpec; height: number }): JSX.Element {
  const g = sidebarGeometry(height);
  const middle = (
    <>
      {p.today === 'get-started' || p.results === null ? (
        <GetStarted height={g.today + g.results} />
      ) : (
        <>
          <TodayZone t={p.today} height={g.today} />
          <ResultsZone r={p.results} height={g.results} />
        </>
      )}
      {/* The list sits at its top here, so the "↑ N new" pill (shown only when scrolled away) stays hidden. */}
      <ActivityZone feed={p.feed} height={g.mode === 'full' ? g.rest : null} fresh={0} />
    </>
  );
  return (
    <aside class="dx-col" data-mode={g.mode} data-tone={p.tone} style={`height:${height}px`}>
      <Masthead tone={p.tone} />
      <NowZone p={p} compact={g.mode === 'compact'} height={g.now} />
      {g.mode === 'full' ? (
        middle
      ) : (
        <div class="dx-scroller" data-zone="scroller" style={`height:${g.rest}px`}>
          {middle}
        </div>
      )}
      <Footer />
      {/* Under the Boost button: the title row (40) below the zone's top padding (14). */}
      {p.popover === 'boost-preview' ? <BoostPreview top={g.masthead + g.now + 54} /> : null}
    </aside>
  );
}
