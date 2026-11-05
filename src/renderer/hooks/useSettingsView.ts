import { useCallback, useEffect, useState } from 'preact/hooks';
import { settingsViewSignal } from '@/renderer/app/shell-context';
import type { SettingsView } from '@/shared/settings-view';

export interface SettingsLoad {
  /** The view the shell holds (pushed after every persisted write); null until the first pull lands. */
  readonly view: SettingsView | null;
  /** The pull failed and no view arrived since: the stage says so and offers Retry. */
  readonly failed: boolean;
  retry(): void;
}

/**
 * The Settings stage's view (spec §6.8): the shell owns the one subscription; this reads it. When the
 * stage opens before any view arrived, it pulls once more and, on a failure, says it could not load
 * rather than waiting silently. Retry pulls again.
 */
export function useSettingsView(): SettingsLoad {
  const view = settingsViewSignal.value;
  const [failed, setFailed] = useState(false);

  const pull = useCallback(() => {
    setFailed(false);
    window.epo.settingsView().then(
      (v) => {
        if ((settingsViewSignal.peek()?.rev ?? -1) < v.rev) settingsViewSignal.value = v;
      },
      () => setFailed(true),
    );
  }, []);

  useEffect(() => {
    if (settingsViewSignal.peek() === null) pull();
  }, [pull]);

  return { view, failed: failed && view === null, retry: pull };
}
