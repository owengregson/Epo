import type { InstagramTab } from '@/adapter/tab';
import { type CursorObserver, ElectronInputDriver, ObservedInputDriver } from '@/interaction/input-driver';
import { Interactor } from '@/interaction/interactor';
import type { TempoSource } from '@/kernel/tempo';

/** One production input path for the app, capture tools and live verification. */
export function createTabInteractor(tab: InstagramTab, options: {
  observer?: CursorObserver;
  abortSignal?: () => AbortSignal | undefined;
  /** The tempo every gesture's motion resolves from (default: the reference tempo). */
  tempo?: TempoSource;
} = {}): Interactor {
  const driver = new ElectronInputDriver(tab);
  return new Interactor({
    driver: options.observer ? new ObservedInputDriver(driver, options.observer) : driver,
    abortSignal: options.abortSignal,
    tempo: options.tempo,
    contextVersion: () => tab.inputVersion(),
    prepareClick: (target, point) => tab.prepareClick(target, point),
    viewport: () => tab.evaluate(() => ({ x: 0, y: 0, width: innerWidth, height: innerHeight })),
  });
}
