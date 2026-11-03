import { useBridgeEvent } from '@/renderer/hooks/useBridgeEvent';
import { isStageMode, type StageMode } from '@/shared/stage-mode';

/**
 * The application menu's stage requests (⌘1–⌘5, ⌘,), pushed by main so they work
 * while Instagram has focus (spec §12.4). Ignored while `enabled` is false — the
 * tour drives the stages itself while it is open.
 */
export function useStageRequest(show: (mode: StageMode) => void, enabled: boolean): void {
  useBridgeEvent('stageRequest', (mode) => {
    if (enabled && isStageMode(mode)) show(mode);
  });
}
