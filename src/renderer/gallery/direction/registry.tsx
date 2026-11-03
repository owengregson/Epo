/**
 * Every direction board: what it shows, what the reviewer should judge, and
 * its frames for a given canvas width. Window frames are full-bleed, so the
 * board at 1024/1440/1920 shows the app at exactly that window width.
 */
import { type JSX } from 'preact';
import {
  INTRO_STEPS,
  IntroFrame,
  Scaled,
  SPLASH_CAPTIONS,
  SplashScreen,
  STORY_H,
  STORY_W,
} from '@/renderer/gallery/direction/launch';
import {
  SIDEBAR_HEIGHTS,
  SIDEBAR_W,
  settingsContentWidth,
  settingsLayout,
  thumbColumns,
  thumbWidth,
} from '@/renderer/gallery/direction/layout';
import { PeoplePage } from '@/renderer/gallery/direction/people-page';
import { POPOVER_FRAMES, POSTURES, type PostureSpec, withPopover } from '@/renderer/gallery/direction/postures';
import { Sidebar } from '@/renderer/gallery/direction/Sidebar';
import { GrowthPaceFineTune, TimingDetail } from '@/renderer/gallery/direction/settings-advanced';
import { GrowthPaceEasy, WhenEasy } from '@/renderer/gallery/direction/settings-easy';
import { SettingsPage } from '@/renderer/gallery/direction/settings-page';
import {
  ColourSpecimen,
  GESTURES,
  GestureDemo,
  RampSpecimen,
  TypeSpecimen,
} from '@/renderer/gallery/direction/specimens';
import { Window } from '@/renderer/gallery/direction/Window';

interface FrameSpec {
  key: string;
  title: string;
  note: string;
  w: number;
  h: number;
  bleed?: boolean;
  render: () => JSX.Element;
}

export interface BoardSpec {
  id: string;
  chip: string;
  title: string;
  intro: string;
  frames: (canvas: number) => FrameSpec[];
}

const WORKING = POSTURES[0] as PostureSpec;

function sidebarBoard(h: number): BoardSpec {
  const mode = h >= 800 ? 'as drawn: every zone fixed, the feed scrolls' : h >= 680 ? 'one scroller' : 'one scroller and a compact Now';
  return {
    id: `sidebar-${h}`,
    chip: `Sidebar ${h}`,
    title: `The live column at ${h} px`,
    intro: `Seven postures at a ${h} px tall window (${mode}), then the two popovers. Zones keep fixed heights, so a posture change never moves anything; only the content changes.`,
    frames: () => [
      ...POSTURES.map((p) => ({ key: `${p.id}-${h}`, title: p.label, note: p.note, w: SIDEBAR_W, h, render: () => <Sidebar p={p} height={h} /> })),
      ...POPOVER_FRAMES.map((f) => {
        const p = withPopover(f.base, f.popover);
        return { key: `${p.id}-${h}`, title: f.label, note: f.note, w: SIDEBAR_W, h, render: () => <Sidebar p={p} height={h} /> };
      }),
    ],
  };
}

/** A window height per Settings layout, for pages whose length follows the stage width. */
type Heights = number | { narrow: number; medium: number; wide: number };

function windowFrame(key: string, title: string, note: string, heights: Heights, body: (stageW: number) => JSX.Element, stage: 'people' | 'settings'): (canvas: number) => FrameSpec {
  return (canvas) => {
    const h = typeof heights === 'number' ? heights : heights[settingsLayout(canvas - SIDEBAR_W)];
    return {
      key,
      title,
      note,
      w: canvas,
      h,
      bleed: true,
      render: () => (
        <Window width={canvas} height={h} posture={WORKING} stage={stage}>
          {body(canvas - SIDEBAR_W)}
        </Window>
      ),
    };
  };
}

const easy = windowFrame(
  'settings-easy',
  'Easy',
  'Plain questions, cards with live numbers, no sliders and no timings. The layout follows the stage width.',
  900,
  (w) => (
    <SettingsPage mode="easy" stageWidth={w} active="pace">
      <GrowthPaceEasy />
      <WhenEasy />
    </SettingsPage>
  ),
  'settings',
);

const easyWhen = windowFrame(
  'settings-easy-when',
  'Easy · When Epo works',
  'The day’s shape, quiet hours, days off and the session style: the whole section at every window width.',
  { narrow: 1280, medium: 920, wide: 920 },
  (w) => (
    <SettingsPage mode="easy" stageWidth={w} active="when">
      <WhenEasy />
    </SettingsPage>
  ),
  'settings',
);

const advancedPace = windowFrame(
  'settings-advanced-pace',
  'Advanced · Growth pace',
  'The same section, with its Fine-tune block underneath: every number, where it comes from, and a way back.',
  1000,
  (w) => (
    <SettingsPage mode="advanced" stageWidth={w} active="pace" scrollTo=".dx-fine">
      <GrowthPaceEasy />
      <GrowthPaceFineTune />
    </SettingsPage>
  ),
  'settings',
);

const advancedTiming = windowFrame(
  'settings-advanced-timing',
  'Advanced · Timing',
  'Today’s plan in detail (read only; a table where it fits, sentences where it does not), then rows that can only slow Epo.',
  { narrow: 1300, medium: 1080, wide: 940 },
  (w) => (
    <SettingsPage mode="advanced" stageWidth={w} active="timing">
      <TimingDetail contentWidth={settingsContentWidth(w, 'advanced')} />
    </SettingsPage>
  ),
  'settings',
);

const people = windowFrame(
  'people',
  'People',
  'Measured growth first, then where Epo finds people and who is in progress, in everyday words.',
  1080,
  (w) => <PeoplePage stageWidth={w} />,
  'people',
);

function thumbs(canvas: number): { cols: number; w: number; h: number } {
  const cols = thumbColumns(canvas);
  const w = thumbWidth(canvas, cols);
  return { cols, w, h: Math.round((STORY_H * w) / STORY_W) };
}

export const BOARDS: BoardSpec[] = [
  {
    id: 'tokens',
    chip: 'Type and colour',
    title: 'Type, colour and space',
    intro: 'A semantic type ladder with a 15 px body, three colours reopened so all text passes WCAG AA on every surface, larger controls and calmer radii. Inter, bundled.',
    frames: () => [
      { key: 'type', title: 'Type ladder', note: 'Sentence case everywhere; uppercase only on badges of three letters or fewer.', w: 560, h: 640, render: () => <TypeSpecimen /> },
      { key: 'colour', title: 'Colour is state', note: 'Graphite and silver stay. Each tone aliases an existing accent; Boost adds no new hue.', w: 560, h: 640, render: () => <ColourSpecimen /> },
      { key: 'ramps', title: 'Space, controls, radii, time', note: 'Spacing gains 32 and 40; controls run 32–44; motion durations come from one perception rule.', w: 560, h: 640, render: () => <RampSpecimen /> },
    ],
  },
  ...SIDEBAR_HEIGHTS.map(sidebarBoard),
  {
    id: 'settings-easy',
    chip: 'Settings · Easy',
    title: 'Settings — Easy',
    intro: 'Settings is now a stage beside Live, People, Graph and Prune. Easy answers plain questions; a decent amount to choose, none of the timings.',
    frames: (c) => [easy(c), easyWhen(c)],
  },
  {
    id: 'settings-advanced',
    chip: 'Settings · Advanced',
    title: 'Settings — Advanced',
    intro: 'Advanced is Easy plus a Fine-tune block under each section and five Advanced-only sections. Nothing moves when you switch.',
    frames: (c) => [advancedPace(c), advancedTiming(c)],
  },
  {
    id: 'people',
    chip: 'People',
    title: 'People',
    intro: 'Targets and Queues become one page: your followers over time, where Epo finds people, and who is in progress.',
    frames: (c) => [people(c)],
  },
  {
    id: 'splash',
    chip: 'Splash',
    title: 'Launch — the splash',
    intro: 'Everything loads behind the splash: your data, the fonts, the Graph, and Instagram landing on your profile. Captions appear only if it takes a while.',
    frames: (c) => {
      const t = thumbs(c);
      return [
        { key: 'splash', title: 'Splash', note: 'The mark on graphite with a shimmer hairline; no caption in the first 1.2 s.', w: c, h: 640, bleed: true, render: () => <SplashScreen caption="" /> },
        ...SPLASH_CAPTIONS.map((s) => ({
          key: s.key,
          title: `“${s.caption}” · ${s.at}`,
          note: s.note,
          w: t.w,
          h: t.h,
          render: () => (
            <Scaled width={t.w}>
              <SplashScreen caption={s.caption} />
            </Scaled>
          ),
        })),
      ];
    },
  },
  {
    id: 'intro',
    chip: 'Intro',
    title: 'Launch — the intro',
    intro: 'About 900 ms from splash to a live, fully loaded app. Five instants of one continuous motion; reduced motion replaces it with a short cross-fade.',
    frames: (c) => {
      const t = thumbs(c);
      return INTRO_STEPS.map((s, i) => ({
        key: s.key,
        title: `${s.at} · ${s.title}`,
        note: s.note,
        w: t.w,
        h: t.h,
        render: () => (
          <Scaled width={t.w}>
            <IntroFrame step={i} />
          </Scaled>
        ),
      }));
    },
  },
  {
    id: 'motion',
    chip: 'Motion',
    title: 'Motion that explains what is happening',
    intro: 'Six gestures, each with one meaning. Only two things ever loop. Everything a motion says is also written down.',
    frames: () => GESTURES.map((g) => ({ key: g.key, title: g.name, note: g.meaning, w: 400, h: 220, render: () => <GestureDemo g={g} /> })),
  },
];
