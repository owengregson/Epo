/**
 * The direction boards as gallery scenarios: one chip per board in the rail.
 * A chip applies its scenario by writing its status object; that object's
 * identity opens the board, so `Gallery.tsx` needs nothing beyond this array.
 */
import { effect } from '@preact/signals';
import { statusSignal } from '@/renderer/app/shell-context';
import { hideBoard, showBoard } from '@/renderer/gallery/direction/host';
import { BOARDS } from '@/renderer/gallery/direction/registry';
import { basePrune, baseStatus, type Scenario } from '@/renderer/gallery/fixtures';

const BOARD_BY_STATUS = new Map<Scenario['status'], string>();

export const DIRECTION_SCENARIOS: Scenario[] = BOARDS.map((b) => {
  const status = baseStatus();
  BOARD_BY_STATUS.set(status, b.id);
  return { key: `board-${b.id}`, label: `Board · ${b.chip}`, status, prune: basePrune() };
});

/** Move to another board from the board's own bar. */
function pick(id: string): void {
  const s = DIRECTION_SCENARIOS.find((x) => x.key === `board-${id}`);
  if (s) statusSignal.value = s.status;
}

/** Back to the gallery: an equal copy is no board's status, and the same chip can reopen the board. */
function close(): void {
  const current = statusSignal.value;
  if (current) statusSignal.value = { ...current };
}

effect(() => {
  const status = statusSignal.value;
  const id = status ? BOARD_BY_STATUS.get(status) : undefined;
  if (id === undefined) hideBoard();
  else showBoard(id, { pick, close });
});
