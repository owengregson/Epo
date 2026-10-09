export interface RendererCanarySample {
  rafTicks: number;
  elapsedMs: number;
}

export interface RendererCanaryTiming {
  windowMs: number;
  backstopMs: number;
}

/** Measure actual elapsed time; both completion paths retire every callback. */
export function measureRendererCanary({ windowMs, backstopMs }: RendererCanaryTiming): Promise<RendererCanarySample> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let rafTicks = 0;
    let finished = false;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
      resolve({ rafTicks, elapsedMs: Math.max(0, performance.now() - startedAt) });
    };
    const step = (): void => {
      if (finished) return;
      frame = undefined;
      rafTicks += 1;
      if (performance.now() - startedAt >= windowMs) finish();
      else frame = requestAnimationFrame(step);
    };
    timer = setTimeout(finish, backstopMs);
    frame = requestAnimationFrame(step);
  });
}
