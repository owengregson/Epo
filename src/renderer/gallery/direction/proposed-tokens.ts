/**
 * What the token specimens print. The boards themselves now read the app's own
 * tokens (`tokens.palette.css`, `tokens.generated.css`); the numbers below are
 * the few the specimens need in TypeScript — the palette's hex values (pinned to
 * the stylesheet by `tests/renderer/contrast.test.ts`) and the radii — while the
 * type, spacing, control and motion ladders come from `design/*` directly.
 */
import { DUR } from '@/renderer/design/motion-scale';
import { CONTROL_NAMES, CONTROL_PX, SPACE_PX, TYPE_LADDER } from '@/renderer/design/scale';

/** Surfaces, text and accents, as `tokens.palette.css` declares them. */
export const PALETTE = {
  bg: '#0d0d0f',
  surface: '#141417',
  elevated: '#1b1b1f',
  'chip-bg': '#202025',
  'track-bg': '#212126',
  'active-fill': '#26262c',
  border: '#26262b',
  'border-strong': '#33333a',
  text: '#ececee',
  muted: '#a8a8b0',
  faint: '#8e8e97',
  silver: '#c9ccd1',
  chrome: '#eef1f4',
  live: '#d8dde3',
  warn: '#d8b768',
  danger: '#d27878',
  ok: '#6db28a',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** The three values this refresh reopened, with the old value beside each. */
export const REOPENED: ReadonlyArray<{ key: PaletteKey; was: string }> = [
  { key: 'faint', was: '#66666e' },
  { key: 'muted', was: '#9a9aa2' },
  { key: 'danger', was: '#c96a6a' },
];

/** Every surface text must sit on at ≥ 4.5:1. */
export const SURFACES: readonly PaletteKey[] = ['bg', 'surface', 'elevated', 'chip-bg', 'track-bg', 'active-fill'];

/** Text tokens checked against every surface. */
export const TEXT_TOKENS: readonly PaletteKey[] = ['text', 'muted', 'faint', 'silver', 'chrome', 'live', 'warn', 'danger', 'ok'];

/** Colour is state: each posture tone aliases one existing accent (no new hue); calm sits a step below live. */
export const TONES = {
  live: 'live',
  calm: 'muted',
  hold: 'warn',
  alert: 'danger',
  good: 'ok',
  idle: 'faint',
} as const satisfies Record<string, PaletteKey>;

export type Tone = keyof typeof TONES;

/** How each rung of the ladder is used, beside its size from `design/scale.ts`. */
const TYPE_USE: Readonly<Record<string, { weight: number; sample: string; use: string }>> = {
  micro: { weight: 500, sample: '9 AM · 12 PM · 3 PM', use: 'axis ticks, badge counts — never sentences' },
  caption: { weight: 400, sample: 'Today · 4m · Yesterday 8:12 PM', use: 'timestamps, group headers, meta' },
  small: { weight: 400, sample: 'Next session at 5:40 PM', use: 'secondary lines, hints, chips, the next line' },
  label: { weight: 500, sample: 'Followed @jane.doe', use: 'control labels, stage tabs, feed sentences' },
  body: { weight: 400, sample: 'How quickly should Epo grow your account?', use: 'body, inputs, buttons, zone titles' },
  lead: { weight: 400, sample: 'Following @jane.doe', use: 'the now line, the wordmark, section leads' },
  title: { weight: 600, sample: 'Growth pace', use: 'section titles, column titles' },
  heading: { weight: 600, sample: 'Settings', use: 'page titles, the compact posture word' },
  state: { weight: 600, sample: 'Working', use: 'the posture word' },
  hero: { weight: 650, sample: '+12', use: 'the one hero number' },
};

const FALLBACK_USE = { weight: 400, sample: '', use: '' };

export const TYPE_SPECIMEN = TYPE_LADDER.map((r) => ({ name: r.name, px: r.px, ...(TYPE_USE[r.name] ?? FALLBACK_USE) }));

export { SPACE_PX };

/** Controls `32 + 4n`, by name. */
export const CONTROL_SPECIMEN = CONTROL_NAMES.map((name, i) => ({ name, px: CONTROL_PX[i] as number }));

/** Radii 8 / 10 / 14, as `tokens.palette.css` declares them (pills unchanged). */
export const RADIUS_PX = { sm: 8, md: 10, lg: 14 } as const;

/** The five durations, `--dur-1 … --dur-5`. */
export const DUR_MS = [DUR[1], DUR[2], DUR[3], DUR[4], DUR[5]];

/** WCAG 2 relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours (1 … 21). */
export function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
