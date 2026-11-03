/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Icons are inline SVG from `ui/icons.ts` — no webfont, no icon CSS. The map
 * must cover every name the app actually renders, which this suite pins.
 */
import { render } from '@testing-library/preact';
import { Icon } from '@/renderer/ui/Icon';
import { BRAND_ICONS, ICONS } from '@/renderer/ui/icons';

const svg = (el: Element): SVGElement => el.querySelector('svg') as SVGElement;

describe('Icon', () => {
  it('renders one path from the map, sized in em so CSS font-size drives it', () => {
    const { container } = render(<Icon name="play" />);
    const el = svg(container);
    expect(el.getAttribute('viewBox')).toBe(ICONS.play.box);
    expect(el.querySelector('path')?.getAttribute('d')).toBe(ICONS.play.d);
    expect(el.getAttribute('width')).toBe('1em');
    expect(el.getAttribute('fill')).toBe('currentColor');
  });

  it('is decorative by default and an image once titled', () => {
    const { container: plain } = render(<Icon name="play" />);
    expect(svg(plain).getAttribute('aria-hidden')).toBe('true');
    expect(svg(plain).getAttribute('role')).toBeNull();

    const { container: named } = render(<Icon name="play" title="Start" />);
    expect(svg(named).getAttribute('role')).toBe('img');
    expect(svg(named).getAttribute('aria-label')).toBe('Start');
    expect(named.querySelector('title')?.textContent).toBe('Start');
  });

  it('spin adds the keyframe class; extra classes are appended', () => {
    const { container } = render(<Icon name="spinner" spin class="mine" />);
    expect(svg(container).getAttribute('class')).toBe('icon icon-spin mine');
  });

  it('reads brands from their own map', () => {
    const { container } = render(<Icon name="instagram" brand />);
    expect(svg(container).querySelector('path')?.getAttribute('d')).toBe(BRAND_ICONS.instagram.d);
  });

  it('an unknown name renders an empty box instead of throwing', () => {
    const { container } = render(<Icon name="not-a-glyph" />);
    expect(svg(container).querySelector('path')).toBeNull();
  });
});

describe('icons.ts covers what the app renders', () => {
  const REQUIRED = [
    'angle-right',
    'arrow-right-long',
    'arrow-trend-up',
    'arrows-rotate',
    'bolt',
    'calendar-check',
    'chart-pie',
    'check',
    'chevron-down',
    'chevron-right',
    'chevron-up',
    'circle-exclamation',
    'circle-nodes',
    'filter',
    'gauge-high',
    'hourglass-half',
    'layer-group',
    'link',
    'lock',
    'moon',
    'pause',
    'play',
    'shield-halved',
    'sliders',
    'spinner',
    'stopwatch',
    'user-minus',
    'users',
    'wifi',
    'xmark',
  ];

  it.each(REQUIRED)('has a glyph for "%s"', (name) => {
    expect(ICONS[name]?.d.length).toBeGreaterThan(0);
  });

  it('every entry carries a viewBox and a non-empty outline', () => {
    for (const [name, glyph] of Object.entries({ ...ICONS, ...BRAND_ICONS })) {
      expect(`${name}:${/^0 0 \d+ 512$/.test(glyph.box)}`).toBe(`${name}:true`);
      expect(glyph.d.length).toBeGreaterThan(0);
    }
  });
});
