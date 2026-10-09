import { PAGE_BUNDLE } from '@/adapter/page/bundle.generated';
import type { RendererCanaryTiming } from '@/adapter/page/renderer-canary';
import { RENDERER_HEALTH } from '@/kernel/renderer-health-policy';

export interface RendererCanaryHealth {
  healthy: boolean;
  rafTicks: number;
  elapsedMs: number;
  fps: number;
}

/** A tiny injected observation still allows one normally scheduled frame. */
export function rendererCanaryTiming(windowMs: number): RendererCanaryTiming {
  if (!Number.isFinite(windowMs) || windowMs < 0) throw new RangeError('Invalid canary window');
  return {
    windowMs,
    backstopMs: Math.max(windowMs * RENDERER_HEALTH.backstopWindowFactor, 1000 / RENDERER_HEALTH.minAnimationFps),
  };
}

export function rendererCanaryScript(windowMs: number): string {
  return `(() => { ${PAGE_BUNDLE}; return __epoPage.measureRendererCanary(${JSON.stringify(rendererCanaryTiming(windowMs))}); })()`;
}

/** Frames divided by ACTUAL time, including a late first frame or late timer. */
export function assessRendererCanary(sample: unknown): RendererCanaryHealth {
  const invalid = { healthy: false, rafTicks: 0, elapsedMs: 0, fps: 0 };
  if (!sample || typeof sample !== 'object') return invalid;
  const { rafTicks, elapsedMs } = sample as { rafTicks?: unknown; elapsedMs?: unknown };
  if (typeof rafTicks !== 'number' || !Number.isSafeInteger(rafTicks) || rafTicks < 0
    || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return invalid;
  const fps = rafTicks * 1000 / elapsedMs;
  return { healthy: rafTicks > 0 && fps >= RENDERER_HEALTH.minAnimationFps, rafTicks, elapsedMs, fps };
}
