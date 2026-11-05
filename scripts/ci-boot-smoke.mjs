/** CI-only uptime smoke: isolated profile, no Instagram traffic, bounded teardown. */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The executable seam lets tests exercise real process exit/cleanup without launching Electron. */
export async function bootSmoke({
  executable,
  args = ['dist/main/main.js', '--no-sandbox', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
  observeMs = 25_000,
  shutdownMs = 5_000,
  tempRoot = process.env.RUNNER_TEMP || tmpdir(),
  logPath = 'boot.log',
}) {
  const profile = mkdtempSync(path.join(tempRoot, 'epo-boot-smoke-'));
  let log;
  let child;
  let stopped;
  let observation;
  let shutdown;
  let termination;
  let wasInterrupted = false;
  const interrupted = new Promise((resolve) => { termination = resolve; });
  const onInterrupt = () => {
    wasInterrupted = true;
    termination('CI smoke interrupted');
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    log = openSync(logPath, 'w');
    child = spawn(executable, args, {
      // POSIX CI owns the whole Electron process tree, including orphaned helpers.
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
      env: { ...process.env, EPO_USER_DATA_DIR: profile, EPO_BLOCK_NETWORK: '1' },
    });
    stopped = new Promise((resolve) => {
      child.once('error', (error) => resolve(`Could not launch app: ${error.message}`));
      child.once('exit', (code, signal) => resolve(`App exited during boot (code=${code}, signal=${signal})`));
    });
    const failure = await Promise.race([
      stopped,
      interrupted,
      new Promise((resolve) => { observation = setTimeout(() => resolve(null), observeMs); }),
    ]);
    if (failure !== null) throw new Error(failure);
    const output = readFileSync(logPath, 'utf8');
    if (!output.includes('Epo window ready') || !output.includes('network blocked for this launch')) {
      throw new Error('App stayed alive without confirming the window and network block');
    }
  } finally {
    clearTimeout(observation);
    if (child?.pid) {
      const signalTree = (signal) => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      signalTree('SIGTERM');
      await Promise.race([
        stopped,
        new Promise((resolve) => { shutdown = setTimeout(resolve, shutdownMs); }),
      ]);
      // An exited main process does not prove all helpers have exited.
      signalTree('SIGKILL');
      await stopped;
    }
    clearTimeout(shutdown);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    if (log !== undefined) closeSync(log);
    rmSync(profile, { recursive: true, force: true });
  }
  if (wasInterrupted) throw new Error('CI smoke interrupted during teardown');
  console.log(`Boot smoke passed: window ready and network blocked; alive after ${observeMs} ms.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  bootSmoke({ executable: require('electron') }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
