/**
 * Token and motion specimens: the proposed ladder, palette (with measured
 * contrast), ramps, and the six gestures — each a small looping demonstration
 * that the OS reduced-motion setting turns off.
 */
import { type JSX } from 'preact';
import { Ring, Said } from '@/renderer/gallery/direction/instruments';
import {
  CONTROL_PX,
  contrast,
  DUR_MS,
  PALETTE,
  type PaletteKey,
  RADIUS_PX,
  REOPENED,
  SPACE_PX,
  SURFACES,
  TEXT_TOKENS,
  TONES,
  TYPE_LADDER,
} from '@/renderer/gallery/direction/proposed-tokens';
import { Icon } from '@/renderer/ui/Icon';

export function TypeSpecimen(): JSX.Element {
  return (
    <div class="db-spec">
      {[...TYPE_LADDER].reverse().map((t) => (
        <div key={t.name} class="db-spec__type">
          <span class="db-spec__meta">
            --fs-{t.name} · {t.px}px · {t.weight}
          </span>
          <span class="db-spec__sample" style={`font-size:${t.px}px;font-weight:${t.weight}`}>
            {t.sample}
          </span>
          <span class="db-spec__use">{t.use}</span>
        </div>
      ))}
    </div>
  );
}

function worst(key: PaletteKey): number {
  return Math.min(...SURFACES.map((s) => contrast(PALETTE[key], PALETTE[s])));
}

export function ColourSpecimen(): JSX.Element {
  const reopened = new Map(REOPENED.map((r) => [r.key, r.was]));
  return (
    <div class="db-spec">
      <div class="db-spec__surfaces">
        {SURFACES.map((s) => (
          <span key={s} style={`background:${PALETTE[s]}`}>
            {s}
          </span>
        ))}
      </div>
      {TEXT_TOKENS.map((k) => (
        <div key={k} class="db-spec__colour">
          <i style={`background:${PALETTE[k]}`} />
          <span style={`color:${PALETTE[k]}`}>--{k}</span>
          <span class="num">{PALETTE[k]}</span>
          <span class="num">≥ {worst(k).toFixed(2)}:1 on every surface</span>
          {reopened.has(k) ? <span class="db-spec__was num">was {reopened.get(k)}</span> : null}
        </div>
      ))}
      <div class="db-spec__tones">
        {Object.entries(TONES).map(([tone, key]) => (
          <span key={tone} style={`color:${PALETTE[key]};border-color:${PALETTE[key]}55`}>
            {tone}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RampSpecimen(): JSX.Element {
  return (
    <div class="db-spec">
      <div class="db-spec__ramp">
        {SPACE_PX.map((px, i) => (
          <span key={px}>
            <i style={`width:${px}px;height:${px}px`} />
            --sp-{i} {px}
          </span>
        ))}
      </div>
      <div class="db-spec__controls">
        {Object.entries(CONTROL_PX).map(([k, px]) => (
          <span key={k} class="db-spec__control" style={`height:${px}px`}>
            --h-{k} {px}
          </span>
        ))}
      </div>
      <div class="db-spec__radii">
        {Object.entries(RADIUS_PX).map(([k, px]) => (
          <span key={k} class="num" style={`border-radius:${px}px`}>
            {k} {px}
          </span>
        ))}
      </div>
      <div class="db-spec__durs">
        {DUR_MS.map((ms, i) => (
          <span key={ms}>
            <i style={`width:${ms / 4}px`} />
            --dur-{i + 1} {ms} ms
          </span>
        ))}
      </div>
    </div>
  );
}

export interface Gesture {
  key: string;
  name: string;
  meaning: string;
  reduced: string;
}

export const GESTURES: Gesture[] = [
  { key: 'settle', name: 'Settle', meaning: 'A value changed: digits roll to the new number.', reduced: 'The number swaps.' },
  { key: 'deplete', name: 'Deplete', meaning: 'The ring is full while a step runs, then drains toward the next one: one animation per deadline.', reduced: 'A still fraction, refreshed each minute.' },
  { key: 'arrive', name: 'Arrive', meaning: 'Something new appeared: it slides in and its highlight fades.', reduced: 'It appears.' },
  { key: 'breathe', name: 'Breathe', meaning: 'Epo is working. Only two things ever loop: the mark’s ring and the Live dot. The Now ring never spins.', reduced: 'Still.' },
  { key: 'nudge', name: 'Nudge', meaning: 'Something needs you: two small shakes, once.', reduced: 'The border changes colour.' },
  { key: 'file-into', name: 'File into', meaning: 'The step just done becomes history: the now line drops into the feed.', reduced: 'The row appears.' },
];

export function GestureDemo({ g }: { g: Gesture }): JSX.Element {
  let demo: JSX.Element;
  if (g.key === 'settle') {
    demo = (
      <span class="db-g-settle num">
        1,28<span class="db-g-settle__reel">
          <span>4</span>
          <span>5</span>
        </span>{' '}
        followers
      </span>
    );
  } else if (g.key === 'deplete') {
    demo = <Ring size={72} mode="deplete" fraction={1} glyph="hourglass-half" />;
  } else if (g.key === 'arrive') {
    demo = (
      <span class="db-g-arrive">
        <Icon name="arrows-rotate" /> <Said parts={['@bob.rivera', ' followed you back']} />
      </span>
    );
  } else if (g.key === 'breathe') {
    demo = <span class="db-g-breathe" />;
  } else if (g.key === 'nudge') {
    demo = <span class="db-g-nudge">Needs attention</span>;
  } else {
    demo = (
      <span class="db-g-file">
        <span class="db-g-file__now">
          Following <b>@jane.doe</b>
        </span>
        <span class="db-g-file__row">
          <Icon name="check" /> Followed <b>@jane.doe</b>
        </span>
      </span>
    );
  }
  return (
    <div class="db-gesture" data-gesture={g.key}>
      <div class="db-gesture__stage">{demo}</div>
      <p class="db-gesture__reduced">Reduced motion: {g.reduced}</p>
    </div>
  );
}
