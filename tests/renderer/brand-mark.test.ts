/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * L-MARK: the Epo mark is locked. `src/renderer/design/brand-mark.ts` is its one
 * geometry source; the favicon and any inline mark in `index.html` (the splash)
 * carry copies, and `EpoMark` draws it. All agree rectangle for rectangle and stop for stop.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { render } from '@testing-library/preact';
import { h } from 'preact';
import { BRAND_MARK, brandMarkSvg, type MarkLayer } from '@/renderer/design/brand-mark';
import { EpoMark } from '@/renderer/ui/EpoMark';

interface Geometry {
  rects: string[];
  layers: string[];
}

const LAYERS = ['body', 'shadow', 'highlight'] as const;

function expected(): Geometry {
  const rect = (r: (typeof BRAND_MARK.mask)[number]): string =>
    `${r.x},${r.y},${r.width},${r.height},${r.r},${r.keep ? 'keep' : 'cut'}`;
  const layer = (l: MarkLayer): string =>
    `${l.y1}-${l.y2}:${l.stops.map((s) => `${s.offset}%/${s.color}/${s.opacity}`).join(' ')}`;
  return { rects: BRAND_MARK.mask.map(rect), layers: LAYERS.map((k) => layer(BRAND_MARK.layers[k])) };
}

/** The same description, read back out of any rendered or parsed mark. */
function read(svg: Element): Geometry {
  const num = (el: Element, attr: string): number => Number(el.getAttribute(attr) ?? '0');
  const rects = [...svg.querySelectorAll('mask rect')].map((r) => {
    const keep = (r.getAttribute('fill') ?? '').toLowerCase() === '#fff' ? 'keep' : 'cut';
    return `${num(r, 'x')},${num(r, 'y')},${num(r, 'width')},${num(r, 'height')},${num(r, 'rx')},${keep}`;
  });
  const layers = [...svg.querySelectorAll('linearGradient')].map((g) => {
    const stops = [...g.querySelectorAll('stop')].map((s) => {
      const opacity = s.getAttribute('stop-opacity') ?? '1';
      return `${Number.parseFloat(s.getAttribute('offset') ?? '0')}%/${s.getAttribute('stop-color')}/${Number(opacity)}`;
    });
    return `${num(g, 'y1')}-${num(g, 'y2')}:${stops.join(' ')}`;
  });
  return { rects, layers };
}

const INDEX_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

describe('the brand mark (L-MARK)', () => {
  it('the favicon is the mark', () => {
    const b64 = /href="data:image\/svg\+xml;base64,([^"]+)"/.exec(INDEX_HTML)?.[1] ?? '';
    const svg = new DOMParser().parseFromString(Buffer.from(b64, 'base64').toString('utf8'), 'image/svg+xml');
    expect(read(svg.documentElement)).toEqual(expected());
  });

  it('the favicon is generated from the geometry, byte for byte (no hand-edited copy)', () => {
    const href = /href="(data:image\/svg\+xml;base64,[^"]+)"/.exec(INDEX_HTML)?.[1];
    expect(href).toBe(`data:image/svg+xml;base64,${Buffer.from(brandMarkSvg(), 'utf8').toString('base64')}`);
  });

  it('every mark drawn inline in index.html (the splash, once it lands) is the mark', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    for (const svg of doc.querySelectorAll('svg')) {
      if (svg.querySelector('mask') !== null) expect(read(svg)).toEqual(expected());
    }
  });

  it('EpoMark draws exactly that geometry, at any size', () => {
    const { container } = render(h(EpoMark, { size: 72 }));
    const svg = container.querySelector('svg') as SVGElement;
    expect(read(svg)).toEqual(expected());
    expect(svg.getAttribute('width')).toBe('72');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${BRAND_MARK.size} ${BRAND_MARK.size}`);
  });

  it('two marks on one page never share a mask or gradient id', () => {
    const { container } = render(h('div', {}, h(EpoMark, { size: 24 }), h(EpoMark, { label: null })));
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    const [a, b] = [...container.querySelectorAll('svg')];
    expect(a?.getAttribute('aria-label')).toBe('Epo');
    expect(b?.getAttribute('aria-hidden')).toBe('true');
  });
});
