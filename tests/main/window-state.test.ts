import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW,
  loadWindowState,
  sanitizeWindowState,
  saveWindowState,
  type WindowRect,
} from '@/main/window-state';

/** One 1440×900 display at the origin — the common laptop case. */
const LAPTOP: WindowRect[] = [{ x: 0, y: 0, width: 1440, height: 900 }];

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-winstate-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sanitizeWindowState', () => {
  test('non-object input yields the defaults (no position)', () => {
    const s = sanitizeWindowState('nope', LAPTOP);
    expect(s.width).toBe(DEFAULT_WINDOW_STATE.width);
    expect(s.height).toBe(DEFAULT_WINDOW_STATE.height);
    expect(s.maximized).toBe(false);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
  });

  test('sizes clamp up to the window minimums', () => {
    const s = sanitizeWindowState({ width: 200, height: 100 }, LAPTOP);
    expect(s.width).toBe(MIN_WINDOW.width);
    expect(s.height).toBe(MIN_WINDOW.height);
  });

  test('a position on a current display is kept', () => {
    const s = sanitizeWindowState({ x: 100, y: 50, width: 1200, height: 800 }, LAPTOP);
    expect(s.x).toBe(100);
    expect(s.y).toBe(50);
  });

  test('a position stranded off every display is dropped (unplugged monitor)', () => {
    // Saved while an external display sat at x=2000; now only the laptop remains.
    const s = sanitizeWindowState({ x: 2600, y: 100, width: 1200, height: 800 }, LAPTOP);
    expect(s.x).toBeUndefined();
    expect(s.y).toBeUndefined();
    // The size survives even when the position does not.
    expect(s.width).toBe(1200);
    expect(s.height).toBe(800);
  });

  test('a sliver of overlap is not enough — the title bar must be reachable', () => {
    // Only ~40px of the window pokes onto the display: dropped.
    const s = sanitizeWindowState({ x: 1400, y: 100, width: 1200, height: 800 }, LAPTOP);
    expect(s.x).toBeUndefined();
  });

  test('maximized coerces to a strict boolean', () => {
    expect(sanitizeWindowState({ maximized: true }, LAPTOP).maximized).toBe(true);
    expect(sanitizeWindowState({ maximized: 'yes' }, LAPTOP).maximized).toBe(false);
  });
});

describe('persistence', () => {
  test('save → load round-trips (atomically, no temp file left)', () => {
    const file = path.join(dir, 'window-state.json');
    const state = { x: 60, y: 40, width: 1280, height: 820, maximized: true };
    saveWindowState(file, state);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(loadWindowState(file, LAPTOP)).toEqual(state);
  });

  test('a missing file is the first launch: defaults, no throw', () => {
    expect(loadWindowState(path.join(dir, 'absent.json'), LAPTOP)).toEqual(DEFAULT_WINDOW_STATE);
  });

  test('corrupt JSON degrades to the defaults, no throw', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ not json', 'utf8');
    expect(loadWindowState(file, LAPTOP)).toEqual(DEFAULT_WINDOW_STATE);
  });
});
