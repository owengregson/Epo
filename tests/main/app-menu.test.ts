/**
 * The application menu (spec §12.4): ⌘1–⌘5 and ⌘, ask the renderer for a stage (so they work while Instagram
 * has focus), there is no page zoom anywhere (CSS px always equal DIP), and Reload / DevTools exist only in
 * unpackaged runs.
 */

jest.mock('electron', () => ({ Menu: { buildFromTemplate: (template: unknown) => ({ template }) } }));

import type { MenuItemConstructorOptions } from 'electron';
import { buildAppMenu } from '@/main/window/app-menu';
import type { StageMode } from '@/shared/stage-mode';

type Item = MenuItemConstructorOptions;

function menu(over: { isPackaged?: boolean; isMac?: boolean } = {}) {
  const asked: StageMode[] = [];
  const built = buildAppMenu({ onStage: (mode) => asked.push(mode), isPackaged: over.isPackaged ?? true, isMac: over.isMac ?? true });
  const template = (built as unknown as { template: Item[] }).template;
  const all = (items: Item[]): Item[] =>
    items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? all(i.submenu as Item[]) : [])]);
  return { template, items: all(template), asked };
}

const click = (item: Item | undefined): void => {
  if (item?.click === undefined) throw new Error('no clickable item');
  (item.click as unknown as () => void)();
};

test('⌘1–⌘5 ask for Live, People, Graph, Prune, Settings', () => {
  const m = menu();
  const byKey = ['1', '2', '3', '4', '5'].map((k) => m.items.find((i) => i.accelerator === `CmdOrCtrl+${k}`));
  expect(byKey.map((i) => i?.label)).toEqual(['Live', 'People', 'Graph', 'Prune', 'Settings']);
  for (const item of byKey) click(item);
  expect(m.asked).toEqual(['tab', 'people', 'graph', 'prune', 'settings']);
});

test('⌘, opens Settings, from the app menu on macOS and the File menu elsewhere', () => {
  for (const isMac of [true, false]) {
    const m = menu({ isMac });
    const settings = m.items.find((i) => i.accelerator === 'CmdOrCtrl+,');
    expect(settings?.label).toBe('Settings…');
    click(settings);
    expect(m.asked).toEqual(['settings']);
  }
});

test('no page zoom role anywhere, packaged or not', () => {
  for (const isPackaged of [true, false]) {
    for (const isMac of [true, false]) {
      const roles = menu({ isPackaged, isMac }).items.map((i) => i.role);
      expect(roles).not.toContain('zoomIn');
      expect(roles).not.toContain('zoomOut');
      expect(roles).not.toContain('resetZoom');
      expect(roles).not.toContain('viewMenu');
    }
  }
});

test('Reload and DevTools only in unpackaged runs; Edit, Window and Quit always', () => {
  const packaged = menu({ isPackaged: true }).items.map((i) => i.role);
  const dev = menu({ isPackaged: false }).items.map((i) => i.role);
  expect(packaged).not.toContain('reload');
  expect(packaged).not.toContain('toggleDevTools');
  expect(dev).toEqual(expect.arrayContaining(['reload', 'toggleDevTools']));
  for (const isMac of [true, false]) {
    expect(menu({ isMac }).items.map((i) => i.role)).toEqual(expect.arrayContaining(['editMenu', 'windowMenu', 'quit']));
  }
});
