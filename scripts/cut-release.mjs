/**
 * Cut a release (docs/RELEASE.md §2) — the human side of the auto-releaser:
 *
 *   node scripts/cut-release.mjs patch|minor|major|<x.y.z[-suffix]>
 *
 * Bumps package.json (+ lockfile), regenerates the version-stamped release
 * banner, and rewrites .github/release-highlights.md with this tag's marker
 * and a highlights stub. It does NOT commit: edit the highlights, then
 * commit everything as `release: vX.Y.Z` and push — the release workflow
 * detects the unreleased version on main and does the rest (gates → package
 * → tag → publish). A hyphenated version publishes as a pre-release.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/cut-release.mjs patch|minor|major|<x.y.z[-suffix]>');
  process.exit(1);
}

execFileSync('npm', ['version', '--no-git-tag-version', arg], { cwd: ROOT, stdio: 'inherit' });
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// The banner is part of the release: regenerate it stamped with the new
// version (the workflow's detect job refuses to release a stale banner).
execFileSync('node', [path.join(ROOT, 'scripts', 'readme-assets.mjs')], { stdio: 'inherit' });

writeFileSync(
  path.join(ROOT, '.github', 'release-highlights.md'),
  `<!-- v${version} -->\n\n` +
    `<!-- 2-5 user-facing bullets: what can someone DO now that they couldn't\n` +
    `     before? Benefit first, one idea per bullet, no hype words. Injected\n` +
    `     into the v${version} release notes; the marker above must stay line 1. -->\n\n` +
    `- \n- \n`,
);

console.log(`
Cut v${version}. Next:
  1. Edit .github/release-highlights.md (2-5 user-facing bullets).
  2. git add -A && git commit -m "release: v${version}"
  3. git push
The release workflow takes it from there: four gates, macOS/Windows
packaging, the Linux boot smoke, then tag + publish — no tag by hand.`);
