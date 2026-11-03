/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * Overlays over native views (spec §12.4): on Live the Instagram page covers the
 * stage body and draws above anything the renderer paints, so a tooltip stays
 * inside the console column its anchor sits in — or is not shown at all — and
 * the shell's one popover never reaches under the page.
 */
import { act, fireEvent, render } from '@testing-library/preact';
import { liveRevealedSignal } from '@/renderer/app/live-signals';
import { PopoverHost, usePopover } from '@/renderer/app/PopoverHost';
import { modalSignal, stageSignal } from '@/renderer/app/shell-context';
import { TooltipHost } from '@/renderer/app/TooltipHost';
import { placeAvoiding } from '@/renderer/lib/anchor';

/** The stage body's box: right of a 460 px column, below a 44 px stage bar. */
const BODY = { x: 460, y: 44, w: 980, h: 856 };
const VIEWPORT = { w: 1440, h: 900 };

describe('placeAvoiding', () => {
  const bubble = { w: 300, h: 40 };

  it('places as usual when no native view is drawn', () => {
    expect(placeAvoiding({ x: 600, y: 10, w: 80, h: 30 }, bubble, VIEWPORT, null, { side: 'above' })).not.toBeNull();
  });

  it('keeps a bubble anchored in the column inside the column', () => {
    const at = placeAvoiding({ x: 400, y: 300, w: 50, h: 20 }, bubble, VIEWPORT, BODY, { side: 'above', edge: 8 });
    expect(at).not.toBeNull();
    expect((at?.left ?? 0) + bubble.w).toBeLessThanOrEqual(BODY.x - 8);
  });

  it('refuses a bubble wider than the column', () => {
    expect(placeAvoiding({ x: 40, y: 300, w: 50, h: 20 }, { w: 500, h: 40 }, VIEWPORT, BODY, {})).toBeNull();
  });

  it('refuses a stage-bar bubble that would reach under the page', () => {
    // Above leaves the window, so it flips below the 44 px bar — into the covered body.
    expect(placeAvoiding({ x: 600, y: 7, w: 80, h: 30 }, bubble, VIEWPORT, BODY, { side: 'above' })).toBeNull();
  });
});

describe('TooltipHost on Live', () => {
  let width: jest.SpyInstance;
  let height: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    stageSignal.value = 'tab';
    liveRevealedSignal.value = true;
    modalSignal.value = false;
    Object.assign(window, { innerWidth: VIEWPORT.w, innerHeight: VIEWPORT.h });
    width = jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    height = jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40);
  });

  afterEach(() => {
    width.mockRestore();
    height.mockRestore();
    jest.useRealTimers();
  });

  /** A stage body and one tip anchor at `box`, laid out as on a real window. */
  function layout(anchorBox: { x: number; y: number; w: number; h: number }): HTMLElement {
    const body = document.createElement('div');
    body.className = 'stagepane-body';
    body.getBoundingClientRect = () => new DOMRect(BODY.x, BODY.y, BODY.w, BODY.h);
    const anchor = document.createElement('button');
    anchor.setAttribute('data-tip', 'Pages · ⌘2');
    anchor.getBoundingClientRect = () => new DOMRect(anchorBox.x, anchorBox.y, anchorBox.w, anchorBox.h);
    document.body.append(body, anchor);
    return anchor;
  }

  async function hover(anchor: HTMLElement): Promise<HTMLElement> {
    render(<TooltipHost />);
    await act(async () => {
      fireEvent.mouseOver(anchor);
      jest.runOnlyPendingTimers();
    });
    return document.querySelector('.tip') as HTMLElement;
  }

  it('shows a column anchor’s bubble inside the column', async () => {
    const tip = await hover(layout({ x: 40, y: 300, w: 60, h: 20 }));
    expect(tip.className).toContain('show');
    expect(Number.parseFloat(tip.style.left) + 300).toBeLessThanOrEqual(BODY.x);
  });

  it('does not show a bubble the Instagram page would cover', async () => {
    const tip = await hover(layout({ x: 600, y: 7, w: 80, h: 30 }));
    expect(tip.className).not.toContain('show');
    expect(tip.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the same bubble when another stage covers Instagram', async () => {
    stageSignal.value = 'graph';
    const tip = await hover(layout({ x: 600, y: 7, w: 80, h: 30 }));
    expect(tip.className).toContain('show');
  });
});

describe('PopoverHost', () => {
  function Opener(): preact.JSX.Element {
    const popover = usePopover();
    return (
      <button
        type="button"
        id="why"
        onClick={(e) =>
          popover.open({
            anchor: e.currentTarget as Element,
            labelledBy: 'why-title',
            content: () => <p id="why-title">Why Epo is resting</p>,
          })
        }
      >
        Why?
      </button>
    );
  }

  it('opens one labelled dialog, and Escape closes it', async () => {
    render(
      <>
        <Opener />
        <PopoverHost />
      </>,
    );
    await act(async () => {
      fireEvent.click(document.getElementById('why') as HTMLElement);
    });
    const dialog = document.querySelector('.popover');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('why-title');
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('a press elsewhere closes it', async () => {
    render(
      <>
        <Opener />
        <PopoverHost />
      </>,
    );
    await act(async () => {
      fireEvent.click(document.getElementById('why') as HTMLElement);
    });
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });
    expect(document.querySelector('.popover')).toBeNull();
  });
});
