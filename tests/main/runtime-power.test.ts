import { EventEmitter } from 'node:events';
import { RuntimePower, type RuntimePowerDependencies } from '@/main/runtime-power';
import * as logger from '@/utils/logger';

function harness(): {
  power: RuntimePower;
  monitor: EventEmitter;
  blocker: RuntimePowerDependencies['blocker'];
  suspend: jest.Mock;
  resume: jest.Mock;
} {
  const monitor = new EventEmitter();
  const blocker = {
    start: jest.fn().mockReturnValue(41),
    stop: jest.fn().mockReturnValue(true),
    isStarted: jest.fn().mockReturnValue(true),
  };
  const suspend = jest.fn();
  const resume = jest.fn().mockResolvedValue(undefined);
  const power = new RuntimePower({ blocker, monitor, suspend, resume });
  return { power, monitor, blocker, suspend, resume };
}

test('one app-suspension assertion survives quiet periods and is explicitly released', () => {
  const { power, monitor, blocker } = harness();
  power.start();
  power.start();
  expect(blocker.start).toHaveBeenCalledTimes(1);
  expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension');
  expect(monitor.listenerCount('resume')).toBe(1);
  power.stopWatching();
  expect(monitor.listenerCount('resume')).toBe(0);
  expect(blocker.stop).not.toHaveBeenCalled(); // protect async teardown, too
  power.dispose();
  power.dispose();
  power.start();
  expect(blocker.stop).toHaveBeenCalledTimes(1);
  expect(blocker.stop).toHaveBeenCalledWith(41);
  expect(blocker.start).toHaveBeenCalledTimes(1);
});

test('duplicate suspend events cannot erase the pre-sleep running state', async () => {
  const { power, monitor, suspend, resume } = harness();
  power.start();
  monitor.emit('suspend');
  monitor.emit('suspend');
  expect(suspend).toHaveBeenCalledTimes(1);
  monitor.emit('resume');
  expect(resume).toHaveBeenCalledTimes(1);
  monitor.emit('suspend');
  expect(suspend).toHaveBeenCalledTimes(2);
  power.dispose();
  monitor.emit('resume');
  expect(resume).toHaveBeenCalledTimes(1);
});

test('resume reacquires a lost assertion before revalidating the tab', () => {
  const { power, monitor, blocker, resume } = harness();
  power.start();
  jest.mocked(blocker.isStarted).mockReturnValue(false);
  jest.mocked(blocker.start).mockReturnValue(42);
  monitor.emit('resume');
  expect(blocker.start).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledTimes(1);
  power.dispose();
  expect(blocker.stop).toHaveBeenCalledWith(42);
});

test('a rejected wake sequence is logged rather than an unhandled rejection', async () => {
  const { power, monitor, resume } = harness();
  const error = jest.fn();
  logger.setSink(error);
  resume.mockRejectedValue(new Error('shutdown aborted the wake delay'));
  power.start();
  monitor.emit('resume');
  await Promise.resolve();
  expect(error).toHaveBeenCalledWith('error', 'main: wake sequence failed', {
    error: 'Error: shutdown aborted the wake delay',
  });
  power.dispose();
  logger.setSink(null);
});
