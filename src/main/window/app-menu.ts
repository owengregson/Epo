/**
 * The application menu (spec §12.4): stage accelerators that work while Instagram has focus (each asks the
 * renderer for a stage through `PUSH.stageRequest`), the standard Edit and Window menus, no page zoom (CSS px
 * always equal DIP; owner Q29), and Reload / DevTools only in unpackaged runs.
 */

import { Menu, type MenuItemConstructorOptions } from 'electron';
import { STAGE_MODES, type StageMode } from '@/shared/stage-mode';

/** The stage bar's labels, in the bar's order (owner Q28: the fourth is Prune). */
const STAGE_LABELS: Readonly<Record<StageMode, string>> = {
  tab: 'Live', people: 'People', graph: 'Graph', prune: 'Prune', settings: 'Settings',
};

export interface AppMenuDeps {
  /** Ask the renderer for a stage (main sends `PUSH.stageRequest`). */
  onStage(mode: StageMode): void;
  isPackaged: boolean;
  isMac: boolean;
}

export function buildAppMenu(d: AppMenuDeps): Menu {
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => d.onStage('settings'),
  };
  const stages: MenuItemConstructorOptions[] = STAGE_MODES.map((mode, i) => ({
    label: STAGE_LABELS[mode], accelerator: `CmdOrCtrl+${i + 1}`, click: () => d.onStage(mode),
  }));
  const develop: MenuItemConstructorOptions[] = d.isPackaged
    ? []
    : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }];
  const first: MenuItemConstructorOptions = d.isMac
    ? { label: 'Epo', submenu: [{ role: 'about' }, { type: 'separator' }, settings, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }
    : { label: 'File', submenu: [settings, { type: 'separator' }, { role: 'quit' }] };
  return Menu.buildFromTemplate([
    first,
    { role: 'editMenu' },
    { label: 'View', submenu: [...stages, ...develop] },
    { role: 'windowMenu' },
  ]);
}
