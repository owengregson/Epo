import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import { RuntimeLog } from '@/main/services/runtime-log';
import { terminateFailedStartup } from '@/main/services/startup-failure';

test('composition failure persists a run block and drains diagnostics before abnormal exit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-startup-test-'));
  try {
    const file = path.join(directory, 'runtime.json');
    const runtime = new RuntimeCoordinator(file);
    runtime.command('running');
    const log = new RuntimeLog(path.join(directory, 'logs'));
    const order: string[] = [];
    await terminateFailedStartup(new Error('composition failed'), {
      claim: () => true,
      block: (error) => { runtime.block('startup-failed', String(error)); order.push('blocked'); },
      dispose: async () => { order.push('disposed'); },
      closeLog: async () => { await log.close(); order.push('drained'); },
      report: (phase, error) => log.write('error', phase, { error: String(error) }),
      exit: (code) => { expect(code).toBe(1); order.push('exited'); },
    });
    expect(order).toEqual(['blocked', 'disposed', 'drained', 'exited']);
    const restored = new RuntimeCoordinator(file);
    expect(restored.snapshot()).toMatchObject({ desired: 'running', blockedReason: 'startup-failed' });
    expect(restored.wantsRun()).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'logs/runtime.jsonl'), 'utf8')).toContain('composition failed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('hung cleanup and disk drain cannot keep a failed startup alive', async () => {
  jest.useFakeTimers();
  try {
    const exit = jest.fn();
    const report = jest.fn();
    const pending = terminateFailedStartup('failed', { claim: () => true, block: () => {},
      dispose: () => new Promise(() => {}), closeLog: () => new Promise(() => {}), report, exit });
    await jest.advanceTimersByTimeAsync(15_000);
    expect(exit).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('startup cleanup failed', 'deadline exceeded');
    await jest.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(report).toHaveBeenCalledWith('startup log drain failed', 'deadline exceeded');
    expect(exit).toHaveBeenCalledWith(1);
  } finally { jest.useRealTimers(); }
});

test('intentional shutdown already in progress cannot be converted into a supervised restart', async () => {
  const block = jest.fn();
  const dispose = jest.fn();
  const closeLog = jest.fn();
  const exit = jest.fn();
  await terminateFailedStartup('late failure', { claim: () => false, block, dispose, closeLog, exit, report: jest.fn() });
  expect(block).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  expect(closeLog).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});

test('persistence and cleanup exceptions still attempt log drain and abnormal exit', async () => {
  const report = jest.fn();
  const closeLog = jest.fn(async () => {});
  const exit = jest.fn();
  await terminateFailedStartup('failed', { claim: () => true,
    block: () => { throw new Error('disk full'); },
    dispose: async () => { throw new Error('cleanup rejected'); }, closeLog, report, exit });
  expect(closeLog).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
  expect(report).toHaveBeenCalledWith('startup block persistence failed', expect.any(Error));
});
