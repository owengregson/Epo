import { type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { BRAND_MARK, type MarkLayer } from '@/renderer/design/brand-mark';

/** Page-wide counter: ids stay unique across separate render roots, unlike `useId`. */
let instances = 0;

export interface EpoMarkProps {
  /** Rendered edge in CSS px (the viewBox stays 64). */
  size?: number;
  /** Accessible name; `null` makes the mark decorative. */
  label?: string | null;
  class?: string;
}

const LAYERS = ['body', 'shadow', 'highlight'] as const;

/** One vertical gradient of the mark, in user space so every layer spans the square. */
function Layer({ id, layer }: { id: string; layer: MarkLayer }): JSX.Element {
  return (
    <linearGradient id={id} x1="0" y1={layer.y1} x2="0" y2={layer.y2} gradientUnits="userSpaceOnUse">
      {layer.stops.map((s) => (
        <stop
          key={s.offset}
          offset={`${s.offset}%`}
          stop-color={s.color}
          stop-opacity={s.opacity === 1 ? undefined : s.opacity}
        />
      ))}
    </linearGradient>
  );
}

/**
 * The Epo mark, drawn from `BRAND_MARK` (the one geometry source). Ids are
 * per instance, so any number of marks can share a page and removing one never
 * blanks another's mask.
 */
export function EpoMark({ size = 24, label = 'Epo', class: cls }: EpoMarkProps): JSX.Element {
  const [uid] = useState(() => `epo-mark-${++instances}`);
  const edge = BRAND_MARK.size;
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox={`0 0 ${edge} ${edge}`}
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : 'true'}
    >
      <defs>
        <mask id={`${uid}-cut`} maskUnits="userSpaceOnUse" x="0" y="0" width={edge} height={edge}>
          {BRAND_MARK.mask.map((r) => (
            <rect
              key={`${r.x}-${r.y}`}
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              rx={r.r || undefined}
              ry={r.r || undefined}
              fill={r.keep ? '#fff' : '#000'}
            />
          ))}
        </mask>
        {LAYERS.map((name) => (
          <Layer key={name} id={`${uid}-${name}`} layer={BRAND_MARK.layers[name]} />
        ))}
      </defs>
      <g mask={`url(#${uid}-cut)`}>
        {LAYERS.map((name) => (
          <rect key={name} width={edge} height={edge} fill={`url(#${uid}-${name})`} />
        ))}
      </g>
    </svg>
  );
}
