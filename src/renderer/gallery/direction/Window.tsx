/**
 * A whole window at a real width: the live column, the stage bar (one 44 px
 * band with the masthead) and the stage body. Stage widths are the app's own
 * (window − 460), so a 1024 board shows the 564 px stage the app really has.
 */
import { type ComponentChildren, type JSX } from 'preact';
import { PeopleGlyph } from '@/renderer/gallery/direction/instruments';
import { BAND_H, SIDEBAR_W, tabWidth } from '@/renderer/gallery/direction/layout';
import type { PostureSpec } from '@/renderer/gallery/direction/postures';
import { Sidebar } from '@/renderer/gallery/direction/Sidebar';
import { Icon } from '@/renderer/ui/Icon';

type StageKey = 'tab' | 'people' | 'graph' | 'prune' | 'settings';

/** Spec §12.4, with the owner's word for the fourth tab (§18.3 Q28). */
const STAGE_TABS: ReadonlyArray<{ key: StageKey; label: string; tip: string }> = [
  { key: 'tab', label: 'Live', tip: 'Live — Instagram as Epo uses it · ⌘1' },
  { key: 'people', label: 'People', tip: 'Where Epo finds people, and who’s in progress · ⌘2' },
  { key: 'graph', label: 'Graph', tip: 'Everyone Epo knows, as a map · ⌘3' },
  { key: 'prune', label: 'Prune', tip: 'Review people who don’t follow you back · ⌘4' },
  { key: 'settings', label: 'Settings', tip: 'Settings · ⌘5 or ⌘,' },
];

function TabIcon({ k }: { k: StageKey }): JSX.Element {
  if (k === 'tab') return <Icon name="instagram" brand />;
  if (k === 'people') return <PeopleGlyph />;
  return <Icon name={k === 'graph' ? 'circle-nodes' : k === 'prune' ? 'user-minus' : 'sliders'} />;
}

interface StageBarProps {
  stage: StageKey;
  stageWidth: number;
  /** Epo is using the Instagram page while you look at another stage: the Live dot breathes. */
  busyElsewhere: boolean;
  context: string | null;
}

function StageBar({ stage, stageWidth, busyElsewhere, context }: StageBarProps): JSX.Element {
  return (
    <div class="dx-stagebar" data-zone="stagebar" style={`height:${BAND_H}px`}>
      <div class="dx-tabs" role="tablist" aria-label="Stage" style={`--tab-w:${tabWidth(stageWidth)}px`}>
        {STAGE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === stage ? 'true' : 'false'}
            class={t.key === stage ? 'is-on' : undefined}
            title={t.tip}
          >
            <TabIcon k={t.key} />
            <span>{t.label}</span>
            {t.key === 'tab' && busyElsewhere ? <i class="dx-tabdot" aria-label="Epo is using this page" /> : null}
          </button>
        ))}
      </div>
      {context && stageWidth >= 900 ? (
        <span class="dx-stagebar__ctx">
          <i class="dx-dot" /> {context}
        </span>
      ) : null}
    </div>
  );
}

/** A neutral stand-in for the Instagram page (never real content). */
export function InstagramStandIn(): JSX.Element {
  return (
    <div class="dx-ig" aria-label="Instagram page">
      <div class="dx-ig__head">
        <span class="dx-ig__avatar" />
        <div class="dx-ig__lines">
          <i style="width:38%" />
          <i style="width:62%" />
          <i style="width:48%" />
        </div>
      </div>
      <div class="dx-ig__grid">
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} />
        ))}
      </div>
    </div>
  );
}

export interface WindowProps {
  width: number;
  height: number;
  posture: PostureSpec;
  stage: StageKey;
  context?: string | null;
  children: ComponentChildren;
}

export function Window({ width, height, posture, stage, context = null, children }: WindowProps): JSX.Element {
  const stageW = width - SIDEBAR_W;
  return (
    <div class="dx-win" style={`width:${width}px;height:${height}px`}>
      <Sidebar p={posture} height={height} />
      <div class="dx-stage" style={`width:${stageW}px;height:${height}px`}>
        <StageBar stage={stage} stageWidth={stageW} busyElsewhere={stage !== 'tab' && posture.tone === 'live'} context={context} />
        <div class="dx-stage__body" data-stage={stage} style={`height:${height - BAND_H}px`}>
          {children}
        </div>
      </div>
    </div>
  );
}
