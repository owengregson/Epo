import * as fs from 'node:fs';
import * as path from 'node:path';
import { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import { cleanupMainHarness, tempUserData } from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('intent survives process loss, while a deliberate stop revokes old continuations', () => {
  const file = path.join(tempUserData(), 'runtime.json');
  const runtime = new RuntimeCoordinator(file);
  runtime.authorizeAccount('42');
  const running = runtime.command('running');
  expect(new RuntimeCoordinator(file).snapshot()).toMatchObject({ desired: 'running', accountPk: '42' });
  runtime.command('stopped');
  expect(runtime.wantsRun(running)).toBe(false);
  expect(new RuntimeCoordinator(file).snapshot().desired).toBe('stopped');
});

test('repairs coalesce and their attempt budget survives a restart', async () => {
  const file = path.join(tempUserData(), 'runtime.json');
  const runtime = new RuntimeCoordinator(file, () => 1_000);
  let finish!: () => void;
  const repair = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const first = runtime.repair('watchdog', repair);
  const second = runtime.repair('renderer-gone', repair);
  await Promise.resolve();
  expect(repair).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second]);
  await runtime.repair('again', async () => {});
  const restarted = new RuntimeCoordinator(file, () => 2_000);
  await restarted.repair('again', async () => {});
  await expect(restarted.repair('again', async () => {})).rejects.toThrow('runtime-recovery-exhausted');
  expect(restarted.snapshot().blockedReason).toBe('runtime-recovery-exhausted');
});

test('Stop during wake closes restart intent but completes reconciliation', () => {
  const runtime = new RuntimeCoordinator(path.join(tempUserData(), 'runtime.json'));
  runtime.command('running');
  const beforeSleep = runtime.signal();
  runtime.suspend();
  expect(beforeSleep.aborted).toBe(true);
  const token = runtime.beginWake();
  runtime.command('stopped');
  runtime.finishWake(token);
  expect(runtime.ready()).toBe(true);
  expect(runtime.wantsRun(token)).toBe(false);
});

test('separate identities never reuse the first account database', () => {
  const file = path.join(tempUserData(), 'runtime.json');
  const runtime = new RuntimeCoordinator(file);
  expect(runtime.bindAccount('first')).toBe('epo.db');
  expect(runtime.bindAccount('second')).toBe('epo-account-second.db');
  expect(new RuntimeCoordinator(file).bindAccount('first')).toBe('epo.db');
});

test('a failed state write refuses activity without preventing Stop from changing intent', () => {
  const file = path.join(tempUserData(), 'runtime.json');
  const runtime = new RuntimeCoordinator(file);
  runtime.command('running');
  const signal = runtime.signal();
  fs.mkdirSync(`${file}.tmp`); // deterministic filesystem failure, no module mock
  expect(() => runtime.command('stopped')).not.toThrow();
  expect(runtime.snapshot()).toMatchObject({ desired: 'stopped', blockedReason: 'runtime-state-persist-failed' });
  expect(signal.aborted).toBe(true);
  expect(runtime.ready()).toBe(false);
});
