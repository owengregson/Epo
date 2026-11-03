/**
 * The topic designs a worktree may copy into `.overhaul/` carry account-specific evidence, so they
 * are never committed (workplan §0.1, §0.3; spec §20.4). The common-dir exclude hides them from
 * `git status`; this refuses them in the index, staged or committed.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');

test('nothing under .overhaul/ is tracked', () => {
  const ls = spawnSync('git', ['ls-files', '--', '.overhaul'], { cwd: ROOT, encoding: 'utf8' });
  expect([ls.status, ls.stdout]).toEqual([0, '']);
});
