/**
 * Jest `setupFilesAfterEach` hook: the one place the test log level is set.
 * Individual suites no longer need `beforeAll(() => setLevel('error'))`.
 */
import { setLevel } from '@/utils/logger';

setLevel('error');

// jsdom has no SVG geometry. Gallery smoke tests mount the real populated chart;
// browser QA checks its geometry, while these stubs let its reveal initialize.
if (typeof SVGElement !== 'undefined') {
  Object.defineProperties(SVGElement.prototype, {
    getTotalLength: { configurable: true, value: () => 100 },
    getPointAtLength: { configurable: true, value: (at: number) => ({ x: at, y: 0 }) },
  });
}

// Browser QA checks layout. jsdom exposes no element size or ResizeObserver.
if (typeof window !== 'undefined' && typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
