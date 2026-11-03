/**
 * Launch: the splash (everything loads behind it) and the intro storyboard —
 * the mark flies into the masthead while the already-built app rises under it
 * (spec §12.8). Each storyboard frame is the real window frozen at one instant.
 */
import { type ComponentChildren, type JSX } from 'preact';
import { POSTURES, type PostureSpec } from '@/renderer/gallery/direction/postures';
import { InstagramStandIn, Window } from '@/renderer/gallery/direction/Window';
import { EpoMark } from '@/renderer/ui/EpoMark';

/** The logical window every storyboard frame is drawn at, then scaled to fit. */
export const STORY_W = 1440;
export const STORY_H = 900;

/** Draws a full-size composition scaled into a smaller box (the box is what the board lays out). */
export function Scaled({ width, children }: { width: number; children: ComponentChildren }): JSX.Element {
  const s = width / STORY_W;
  return (
    <div class="db-scaled" style={`width:${width}px;height:${Math.round(STORY_H * s)}px`}>
      <div style={`width:${STORY_W}px;height:${STORY_H}px;transform:scale(${s});transform-origin:0 0`}>{children}</div>
    </div>
  );
}

/** Where the flying mark sits: the splash centre (72 px) → the masthead (24 px). */
interface MarkAt {
  cx: number;
  cy: number;
  size: number;
}

const SPLASH_MARK: MarkAt = { cx: STORY_W / 2, cy: STORY_H * 0.46, size: 72 };
const MASTHEAD_MARK: MarkAt = { cx: 36, cy: 22, size: 24 };

function between(a: MarkAt, b: MarkAt, t: number): MarkAt {
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, size: a.size + (b.size - a.size) * t };
}

export interface SplashProps {
  caption: string;
  backdrop?: number;
  /** `'centre'`: the resting splash in any frame size; a point: the mark mid-flight (story coordinates). */
  mark?: MarkAt | 'centre' | null;
}

/** The splash: graphite, the mark at 46% height, a shimmer hairline and one caption line. */
export function SplashScreen({ caption, backdrop = 1, mark = 'centre' }: SplashProps): JSX.Element {
  const at =
    mark === 'centre'
      ? 'left:calc(50% - 36px);top:calc(46% - 36px);width:72px;height:72px'
      : mark
        ? `left:${mark.cx - mark.size / 2}px;top:${mark.cy - mark.size / 2}px;width:${mark.size}px;height:${mark.size}px`
        : null;
  const size = mark === 'centre' || mark === null ? 72 : mark.size;
  return (
    <div class="dx-splash" role="status" aria-label="Epo is starting">
      <div class="dx-splash__backdrop" style={`opacity:${backdrop}`} />
      {at ? (
        <span class="dx-splash__mark" style={at}>
          <EpoMark size={size} label={null} />
        </span>
      ) : null}
      {backdrop > 0.5 ? (
        <span class="dx-splash__under">
          <span class="dx-splash__shimmer" />
          <span class="dx-splash__caption">{caption}</span>
        </span>
      ) : null}
    </div>
  );
}

export interface IntroStep {
  key: string;
  at: string;
  title: string;
  note: string;
}

export const INTRO_STEPS: IntroStep[] = [
  { key: 'i0', at: '0 ms', title: 'Ready behind the splash', note: 'Data, fonts, Graph and the landing on your profile are all done before anything moves.' },
  { key: 'i1', at: '240 ms', title: 'The mark flies home', note: 'The splash mark glides into the masthead while the backdrop fades and the app shows through.' },
  { key: 'i2', at: '440 ms', title: 'The frame settles', note: 'Masthead and stage bar are in place; Now, Today, Results and Activity rise 60 ms apart.' },
  { key: 'i3', at: '600 ms', title: 'Values draw in', note: 'The ring, plan blocks and spark draw to their real values — numbers never count up. Instagram fades in.' },
  { key: 'i4', at: '900 ms', title: 'Live', note: 'Instagram is already on your profile; Epo catches up on what changed, then waits for Start.' },
];

/** The posture the app lands on after the reveal. */
const CATCHING_UP = POSTURES.find((p) => p.id === 'catching-up') as PostureSpec;

/** One storyboard instant: the real window plus the splash at that point of its exit. */
export function IntroFrame({ step }: { step: number }): JSX.Element {
  const mark = step === 0 ? 'centre' : step === 1 ? between(SPLASH_MARK, MASTHEAD_MARK, 0.75) : null;
  const backdrop = [1, 0.55, 0.08, 0, 0][step] ?? 0;
  return (
    <div class="dx-intro" data-step={step}>
      <Window width={STORY_W} height={STORY_H} posture={CATCHING_UP} stage="tab" context="Epo is using this page">
        <InstagramStandIn />
      </Window>
      {step < 3 ? <SplashScreen caption="Almost there…" backdrop={backdrop} mark={mark} /> : null}
    </div>
  );
}

export const SPLASH_CAPTIONS = [
  { key: 's1', at: 'after 1.2 s', caption: 'Opening your data…', note: 'Only while the store is still opening.' },
  { key: 's2', at: 'while landing', caption: 'Opening Instagram…', note: 'Instagram loads your profile behind the splash.' },
  { key: 's3', at: 'ready', caption: 'Almost there…', note: 'Everything is loaded; the intro starts.' },
  { key: 's4', at: 'after 2.5 s', caption: 'Still loading — this can take a moment.', note: 'A slow network; at about 6.6 s Epo opens anyway.' },
] as const;
