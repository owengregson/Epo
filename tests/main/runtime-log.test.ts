import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RuntimeLog } from '@/main/services/runtime-log';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-log-test-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function lines(file = 'runtime.jsonl'): Record<string, unknown>[] {
  return fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('close drains overlapping writes and serializes circular metadata safely', async () => {
  const log = new RuntimeLog(directory);
  const meta: Record<string, unknown> = {};
  meta.self = meta;
  log.write('info', 'first', meta);
  const first = log.flush();
  log.write('warn', 'last');
  await log.close();
  await first;
  expect(lines().map((line) => line.message)).toEqual(['first', 'last']);
  expect(lines()[0]?.meta).toBe('[unserializable]');
  log.write('info', 'after-close');
  expect(lines()).toHaveLength(2);
});

test('rotation retains only the configured number of bounded files', async () => {
  const log = new RuntimeLog(directory, 500, 2);
  for (let i = 0; i < 20; i++) {
    log.write('info', `${i}: ${'x'.repeat(200)}`);
    await log.flush();
  }
  await log.close();
  expect(fs.readdirSync(directory).sort()).toEqual(['runtime.jsonl', 'runtime.jsonl.1']);
  for (const file of fs.readdirSync(directory)) expect(fs.statSync(path.join(directory, file)).size).toBeLessThanOrEqual(500);
  expect(lines().at(-1)?.message).toBe(`19: ${'x'.repeat(200)}`);
});

test('overflow and oversized entries cannot create an unbounded diagnostic queue', async () => {
  const log = new RuntimeLog(directory);
  log.write('error', 'x'.repeat(40_000));
  for (let i = 0; i < 1000; i++) log.write('info', 'x'.repeat(1000));
  await log.close();
  const saved = lines();
  expect(saved[0]?.truncated).toBe(true);
  expect(saved.at(-1)?.message).toBe('diagnostic queue overflow');
  expect(Number(saved.at(-1)?.dropped)).toBeGreaterThan(0);
  expect(fs.statSync(path.join(directory, 'runtime.jsonl')).size).toBeLessThan(263_000);
});

test('disk failure is reported without rejecting shutdown or recursing through logging', async () => {
  const file = path.join(directory, 'file');
  fs.writeFileSync(file, 'not a directory');
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const log = new RuntimeLog(path.join(file, 'logs'));
    log.write('error', 'test');
    await expect(log.close()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  } finally { error.mockRestore(); }
});
