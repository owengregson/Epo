import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Run the actual ESM supervisor in an isolated Node process, never Electron. */
function simulate(body: string): Record<string, unknown> {
  const module = pathToFileURL(path.resolve('scripts/run-desktop.mjs')).href;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { supervise } from ${JSON.stringify(module)};
    import { spawn } from 'node:child_process';
    import { EventEmitter } from 'node:events';
    const signalSource = new EventEmitter();
    ${body}
  `], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
}

test('real child process crashes receive exactly three delayed retries', () => {
  expect(simulate(`
    const waits = []; let launches = 0;
    const code = await supervise({ executable: process.execPath, args: ['-e', 'process.exit(17)'],
      signalSource, launch: (...args) => { launches++; return spawn(...args); },
      schedule: (fn, ms) => { waits.push(ms); return setTimeout(fn, 0); } });
    console.log(JSON.stringify({ code, launches, waits, listeners: signalSource.listenerCount('SIGTERM') }));
  `)).toEqual({ code: 17, launches: 4, waits: [1000, 5000, 15000], listeners: 0 });
});

test('a clean child exit is final', () => {
  expect(simulate(`
    let launches = 0;
    const code = await supervise({ executable: process.execPath, args: ['-e', 'process.exit(0)'],
      signalSource, launch: (...args) => { launches++; return spawn(...args); } });
    console.log(JSON.stringify({ code, launches }));
  `)).toEqual({ code: 0, launches: 1 });
});

test('synchronous launch failures are bounded and remove signal handlers', () => {
  expect(simulate(`
    let launches = 0;
    const code = await supervise({ executable: 'unused', args: [], signalSource,
      launch: () => { launches++; throw new Error('spawn unavailable'); },
      schedule: (fn) => setTimeout(fn, 0) });
    console.log(JSON.stringify({ code, launches, listeners: signalSource.listenerCount('SIGINT') }));
  `)).toEqual({ code: 1, launches: 4, listeners: 0 });
});

test('an intentional signal during crash backoff cancels the queued restart', () => {
  expect(simulate(`
    let launches = 0;
    const code = await supervise({ executable: 'unused', args: [], signalSource,
      launch: () => { launches++; const child = new EventEmitter(); child.exitCode = 2;
        child.signalCode = null; queueMicrotask(() => child.emit('exit', 2, null)); return child; },
      schedule: (fn) => { queueMicrotask(() => signalSource.emit('SIGINT')); return setTimeout(fn, 1000); } });
    console.log(JSON.stringify({ code, launches, listeners: signalSource.listenerCount('SIGINT') }));
  `)).toEqual({ code: 0, launches: 1, listeners: 0 });
});

test('termination forwards to the live child and never starts a replacement', () => {
  expect(simulate(`
    let launches = 0; let killed;
    const done = supervise({ executable: 'unused', args: [], signalSource, launch: () => {
      launches++; const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = (signal) => { killed = signal; child.signalCode = signal; child.emit('exit', null, signal); };
      return child;
    } });
    signalSource.emit('SIGTERM'); const code = await done;
    console.log(JSON.stringify({ code, launches, killed }));
  `)).toEqual({ code: 0, launches: 1, killed: 'SIGTERM' });
});
