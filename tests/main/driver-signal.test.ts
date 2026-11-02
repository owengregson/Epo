import { DriverSignal } from '@/main/services/driver-signal';

test('the same underlying tokens always return the same signal object', () => {
  const cache = new DriverSignal();
  const driver = new AbortController();
  const device = new AbortController();
  const first = cache.get(driver.signal, device.signal);
  for (let i = 0; i < 20; i++) expect(cache.get(driver.signal, device.signal)).toBe(first);
  expect(cache.get(undefined, device.signal)).toBe(device.signal);
});

test.each(['driver', 'device'] as const)('a new %s token produces a new generation', (changed) => {
  const cache = new DriverSignal();
  const driver = new AbortController();
  const device = new AbortController();
  const first = cache.get(driver.signal, device.signal);
  const replacement = new AbortController();
  const next = cache.get(changed === 'driver' ? replacement.signal : driver.signal,
    changed === 'device' ? replacement.signal : device.signal);
  expect(next).not.toBe(first);
});

test.each(['driver', 'device'] as const)('either %s cancellation aborts the stable composite', (changed) => {
  const cache = new DriverSignal();
  const driver = new AbortController();
  const device = new AbortController();
  const signal = cache.get(driver.signal, device.signal);
  (changed === 'driver' ? driver : device).abort();
  expect(signal.aborted).toBe(true);
  expect(cache.get(driver.signal, device.signal)).toBe(signal);
});
