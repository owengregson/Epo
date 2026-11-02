/** Supervise the main process. A clean quit is final; crashes have a bounded retry budget. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function supervise({ executable, args, cwd, launch = spawn, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, signalSource = process }) {
  let child;
  let stopped = false;
  let finished = false;
  let timer;
  let attempts = [];
  const signals = new Map();
  const cleanup = () => {
    if (timer) cancel(timer);
    for (const [signal, handler] of signals) signalSource.removeListener(signal, handler);
  };
  const done = new Promise((resolve) => {
    const finish = (code) => { if (finished) return; finished = true; cleanup(); resolve(code); };
    const start = () => {
      if (stopped || finished) return;
      child = undefined;
      let ended = false;
      const end = (code, signal) => {
        if (ended) return;
        ended = true;
        if (stopped || code === 0) { finish(stopped ? 0 : code); return; }
        const at = now();
        attempts = attempts.filter((t) => at - t < 10 * 60_000);
        if (attempts.length >= 3) {
          console.error('Epo stopped after three crash recovery attempts in ten minutes.', { code, signal });
          finish(code ?? 1);
          return;
        }
        attempts.push(at);
        const delay = [1000, 5000, 15000][attempts.length - 1];
        console.error(`Epo process exited unexpectedly; restarting in ${delay / 1000}s.`, { code, signal });
        timer = schedule(start, delay);
      };
      try { child = launch(executable, args, { cwd, stdio: 'inherit', env: process.env }); }
      catch (error) { console.error('Could not launch Epo:', error); end(1, null); return; }
      child.once('error', (error) => { console.error('Could not launch Epo:', error); end(1, null); });
      child.once('exit', end);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        stopped = true;
        if (timer) cancel(timer);
        if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
        else finish(0);
      };
      signals.set(signal, handler);
      signalSource.on(signal, handler);
    }
    start();
  });
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  process.exitCode = await supervise({
    executable: require('electron'),
    args: [path.join(cwd, 'dist/main/main.js'), ...process.argv.slice(2)],
    cwd,
  });
}
