import { DashboardRecovery } from '@/main/services/dashboard-recovery';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('coalesces duplicate crashes and stops after three repairs even when each reload succeeds', async () => {
  const load = jest.fn(async () => {});
  const blocked = jest.fn();
  const recovery = new DashboardRecovery({ load, available: () => true, blocked });
  recovery.load();
  await jest.advanceTimersByTimeAsync(0);
  for (const delay of [1000, 2000, 3000]) {
    recovery.failed('crashed');
    recovery.failed('unresponsive');
    await jest.advanceTimersByTimeAsync(delay);
  }
  expect(load).toHaveBeenCalledTimes(4);
  recovery.failed('crashed');
  await jest.advanceTimersByTimeAsync(60_000);
  expect(load).toHaveBeenCalledTimes(4);
  expect(blocked).toHaveBeenCalledWith('dashboard-recovery-exhausted');
});

test('a never-settling initial load also consumes the bounded repair budget', async () => {
  const blocked = jest.fn();
  const load = jest.fn(() => new Promise<void>(() => {}));
  const recovery = new DashboardRecovery({ load, available: () => true, blocked });
  recovery.load();
  await jest.advanceTimersByTimeAsync(130_000);
  expect(blocked).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(4);
});

test('closing the window revokes a pending reload', async () => {
  const load = jest.fn(async () => {});
  const recovery = new DashboardRecovery({ load, available: () => true, blocked: jest.fn() });
  recovery.failed('crashed');
  recovery.stop();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(load).not.toHaveBeenCalled();
});

test('a failed load retries, while a stale promise cannot consume a new repair attempt', async () => {
  let reject!: (error: Error) => void;
  const load = jest.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }))
    .mockResolvedValueOnce(undefined);
  const blocked = jest.fn();
  const recovery = new DashboardRecovery({ load, available: () => true, blocked });
  recovery.load();
  await jest.advanceTimersByTimeAsync(0);
  recovery.failed('crashed');
  await jest.advanceTimersByTimeAsync(1000);
  const oldReject = reject;
  recovery.failed('crashed');
  oldReject(new Error('stale load'));
  await jest.advanceTimersByTimeAsync(2000);
  expect(load).toHaveBeenCalledTimes(3);
  expect(blocked).not.toHaveBeenCalled();
  recovery.stop();
});
