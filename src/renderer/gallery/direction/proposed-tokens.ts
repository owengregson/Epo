/**
 * The PROPOSED tokens of spec §12.6–12.7, scoped to the direction boards: the
 * board root carries them as inline custom properties, so the boards preview
 * the refresh while the app keeps today's tokens. Steps 2–3 move them into
 * `design/scale.ts` and `tokens.palette.css`; the boards then read those.
 */

/** Surfaces, text and accents. Three values reopened for WCAG AA; the rest unchanged. */
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

/** The three values this refresh reopens, with today's value beside each. */
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

/** The semantic type ladder: text rungs 15 + [−4 … +2], display rungs 2·round(16·1.25ⁿ/2). */
export const TYPE_LADDER = [
  { name: 'micro', px: 11, weight: 500, sample: '9 AM · 12 PM · 3 PM', use: 'axis ticks, badge counts — never sentences' },
  { name: 'caption', px: 12, weight: 400, sample: 'Today · 4m · Yesterday 8:12 PM', use: 'timestamps, group headers, meta' },
  { name: 'small', px: 13, weight: 400, sample: 'Next session at 5:40 PM', use: 'secondary lines, hints, chips, the next line' },
  { name: 'label', px: 14, weight: 500, sample: 'Followed @jane.doe', use: 'control labels, stage tabs, feed sentences' },
  { name: 'body', px: 15, weight: 400, sample: 'How quickly should Epo grow your account?', use: 'body, inputs, buttons, zone titles' },
  { name: 'lead', px: 17, weight: 400, sample: 'Following @jane.doe', use: 'the now line, the wordmark, section leads' },
  { name: 'title', px: 20, weight: 600, sample: 'Growth pace', use: 'section titles, column titles' },
  { name: 'heading', px: 26, weight: 600, sample: 'Settings', use: 'page titles, the compact posture word' },
  { name: 'state', px: 32, weight: 600, sample: 'Working', use: 'the posture word' },
  { name: 'hero', px: 48, weight: 650, sample: '+12', use: 'the one hero number' },
] as const;

/** Spacing: 4 × [0.5, 1, 2, 3, 4, 5, 6, 8, 10] — `--sp-7` and `--sp-8` are new. */
export const SPACE_PX = [2, 4, 8, 12, 16, 20, 24, 32, 40] as const;

/** Controls `32 + 4n`: chips, segments and tabs, inputs, primary. */
export const CONTROL_PX = { xs: 32, sm: 36, md: 40, lg: 44 } as const;

/** Radii 8 / 10 / 14 (pills unchanged). */
export const RADIUS_PX = { sm: 8, md: 10, lg: 14 } as const;

/** Motion: DUR = PERCEPTION × 1.2 × [1, 5/3, 8/3, 4, 7.5]; one breath for the two loops. */
export const PERCEPTION_MS = 100;
export const DUR_MS = [1, 5 / 3, 8 / 3, 4, 7.5].map((k) => Math.round(PERCEPTION_MS * 1.2 * k));
const BREATH_MS = 2600;
const EASE = {
  ease: 'cubic-bezier(0.22, 0.9, 0.28, 1)',
  'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

/** The face the boards load (Inter Variable, Latin subset); step 4 renames it "Inter". */
const BOARD_FONT = '"Epo Board Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

/** Every proposed token as one inline `style` string for the board root. */
export function tokenStyle(): string {
  const decl: string[] = [];
  for (const [k, v] of Object.entries(PALETTE)) decl.push(`--${k}:${v}`);
  for (const [tone, key] of Object.entries(TONES)) decl.push(`--st-${tone}:var(--${key})`);
  for (const t of TYPE_LADDER) decl.push(`--fs-${t.name}:${t.px}px`);
  for (const [i, px] of SPACE_PX.entries()) decl.push(`--sp-${i}:${px}px`);
  for (const [k, px] of Object.entries(CONTROL_PX)) decl.push(`--h-${k}:${px}px`);
  decl.push(`--r-sm:${RADIUS_PX.sm}px`, `--r:${RADIUS_PX.md}px`, `--r-lg:${RADIUS_PX.lg}px`, '--r-pill:99px');
  for (const [i, ms] of DUR_MS.entries()) decl.push(`--dur-${i + 1}:${ms}ms`);
  decl.push(`--breath:${BREATH_MS}ms`);
  for (const [k, v] of Object.entries(EASE)) decl.push(`--${k}:${v}`);
  decl.push(`--font:${BOARD_FONT}`);
  return decl.join(';');
}

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
