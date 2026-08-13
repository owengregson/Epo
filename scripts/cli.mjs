#!/usr/bin/env node
// Epo build CLI — a thin harness over the project's npm scripts.
// No dependencies: node:util parseArgs + node:child_process only.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMANDS = {
  build:     { run: () => npm('run', 'build'),        help: 'Bundle main/renderer with esbuild (production)' },
  dev:       { run: () => npm('run', 'dev'),          help: 'Dev build + launch Electron' },
  dist:      { run: () => npm('run', 'dist'),         help: 'Build, then package the standalone app (electron-builder)' },
  test:      { run: () => npm('test'),                help: 'Rebuild native module for Node, then run Jest' },
  lint:      { run: () => npm('run', 'lint'),         help: 'Lint src with ESLint (flat config)' },
  typecheck: { run: () => npx('tsc', '--noEmit'),     help: 'Type-check with tsc (no emit)' },
  clean:     { run: clean,                            help: 'Remove dist/ and release/' },
};

function npm(...args) {
  return run('npm', args);
}

function npx(...args) {
  return run('npx', args);
}

function run(cmd, args) {
  const { status } = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  return status ?? 1;
}

function clean() {
  for (const dir of ['dist', 'release']) {
    rmSync(join(ROOT, dir), { recursive: true, force: true });
    console.log(`removed ${dir}/`);
  }
  return 0;
}

function usage() {
  const lines = Object.entries(COMMANDS).map(
    ([name, { help }]) => `  ${name.padEnd(10)} ${help}`,
  );
  console.log(
    [
      'epo — build harness for the Epo app',
      '',
      'Usage: epo <command> [--help]',
      '',
      'Commands:',
      ...lines,
      '',
      'Options:',
      '  -h, --help   Show this help',
    ].join('\n'),
  );
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { help: { type: 'boolean', short: 'h', default: false } },
});

const command = positionals[0];

if (values.help || !command) {
  usage();
  process.exit(command ? 0 : values.help ? 0 : 1);
}

if (!(command in COMMANDS)) {
  console.error(`epo: unknown command "${command}"\n`);
  usage();
  process.exit(1);
}

process.exit(COMMANDS[command].run());
