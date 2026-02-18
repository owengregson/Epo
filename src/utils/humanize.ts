export const randomBetween = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const addJitter = (baseMs: number, jitterPercent: number): number => {
  const factor = 1 + (Math.random() * 2 - 1) * (jitterPercent / 100);
  return Math.round(baseMs * factor);
};

export const humanDelay = (minMs: number, maxMs: number, jitterPercent: number): number => {
  const base = randomBetween(minMs, maxMs);
  return addJitter(base, jitterPercent);
};

export const isWithinActiveHours = (start: number, end: number): boolean => {
  const hour = new Date().getHours();
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // Handles overnight ranges like 22-6
  return hour >= start || hour < end;
};

export const msUntilActiveHours = (start: number): number => {
  const now = new Date();
  const target = new Date(now);
  target.setHours(start, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
