import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOWS = ['ci', 'release', 'package-rehearsal'];

test.each(WORKFLOWS)('%s only invokes npm scripts present in the manifest', (name) => {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const workflow = readFileSync(path.join(ROOT, `.github/workflows/${name}.yml`), 'utf8')
    .replace(/^\s*#.*$/gm, '');
  for (const [, command] of workflow.matchAll(/\bnpm run ([\w:-]+)/g)) {
    expect({ command, exists: command in scripts }).toEqual({ command, exists: true });
  }
});

test('public release downloads select both package artifacts and exclude the diagnostic log', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const download = workflow.split(/\n\s+- name:/).find((step) => step.includes('uses: actions/download-artifact@'));
  const pattern = download?.match(/^\s+pattern:\s*(\S+)/m)?.[1];
  expect(pattern).toBeDefined();
  const selected = new RegExp(`^${pattern?.replaceAll('*', '.*')}$`);
  expect(['epo-macos-latest', 'epo-windows-latest', 'release-boot-log'].filter((name) => selected.test(name)))
    .toEqual(['epo-macos-latest', 'epo-windows-latest']);
});

/** Exercise process lifetime, inherited-profile replacement and cleanup with a local Node child. */
function smoke(childBody: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epo-smoke-test-'));
  const fakeApp = path.join(dir, 'app.cjs');
  const receipt = path.join(dir, 'receipt.json');
  const module = pathToFileURL(path.join(ROOT, 'scripts/ci-boot-smoke.mjs')).href;
  writeFileSync(fakeApp, `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
    profile: process.env.EPO_USER_DATA_DIR, blocked: process.env.EPO_BLOCK_NETWORK, pid: process.pid
  }));\n${childBody}`);
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { bootSmoke } from ${JSON.stringify(module)};
      await bootSmoke({ executable: process.execPath, args: [${JSON.stringify(fakeApp)}],
        observeMs: 1_000, shutdownMs: 50, tempRoot: ${JSON.stringify(dir)},
        logPath: ${JSON.stringify(path.join(dir, 'boot.log'))} });
    `], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, EPO_USER_DATA_DIR: '/must-not-use-real-profile', EPO_BLOCK_NETWORK: '0' },
    });
    const observed = JSON.parse(readFileSync(receipt, 'utf8')) as {
      profile: string; blocked: string; pid: number; grandchild?: number;
    };
    expect(observed.profile.startsWith(path.join(dir, 'epo-boot-smoke-'))).toBe(true);
    expect(observed.blocked).toBe('1');
    expect(run.error).toBeUndefined();
    expect(readdirSync(dir).filter((name) => name.startsWith('epo-boot-smoke-'))).toEqual([]);
    expect(() => process.kill(observed.pid, 0)).toThrow();
    if (observed.grandchild) {
      const state = spawnSync('ps', ['-o', 'stat=', '-p', String(observed.grandchild)], { encoding: 'utf8' });
      // A killed orphan may briefly await the OS reaper, but must not remain running.
      expect(state.stdout.trim() === '' || state.stdout.trim().startsWith('Z')).toBe(true);
    }
    return run;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const READY = "console.log('Epo window ready; network blocked for this launch');";

test('smoke accepts a ready child, then terminates it and removes its isolated profile', () => {
  const run = smoke(`${READY} setInterval(() => {}, 1000);`);
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
});

test('smoke fails an early clean exit as well as an unready live process', () => {
  expect(smoke(READY).status).not.toBe(0);
  const unready = smoke('setInterval(() => {}, 1000);');
  expect(unready.status).not.toBe(0);
  expect(unready.stderr).toContain('without confirming the window and network block');
});

test('smoke bounds teardown when the child ignores graceful termination', () => {
  const run = smoke(`${READY} process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
});

test('smoke kills a surviving helper even when the main child exits early', () => {
  const run = smoke(`${READY}
    const helper = require('node:child_process').spawn(process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const fs = require('node:fs'), file = require('node:path').join(process.env.EPO_USER_DATA_DIR, '..', 'receipt.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), grandchild: helper.pid }));
    helper.once('message', () => { helper.disconnect(); helper.unref(); });
  `);
  expect(run.status).not.toBe(0);
});

test('an interrupt received during teardown cannot report a successful smoke', () => {
  const run = smoke(`${READY}
    process.on('SIGTERM', () => process.kill(process.ppid, 'SIGTERM'));
    setInterval(() => {}, 1000);
  `);
  expect(run.error).toBeUndefined();
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain('interrupted during teardown');
});

test('a missing executable fails and removes the profile', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'epo-smoke-missing-'));
  try {
    const module = pathToFileURL(path.join(ROOT, 'scripts/ci-boot-smoke.mjs')).href;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { bootSmoke } from ${JSON.stringify(module)};
      await bootSmoke({ executable: ${JSON.stringify(path.join(dir, 'absent'))},
        tempRoot: ${JSON.stringify(dir)}, logPath: ${JSON.stringify(path.join(dir, 'boot.log'))} });
    `], { encoding: 'utf8', timeout: 5_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Could not launch app');
    expect(readdirSync(dir)).toEqual(['boot.log']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
