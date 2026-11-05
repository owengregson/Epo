/**
 * L-ATTENTION (spec §12.3): every runtime-block literal main can persist and every halt key classifies to a
 * known attention; an unknown key stays neutral (Diagnostics, the raw key never the sentence).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_HALT_REASONS, haltReasonKey } from '@/engine/halt-reason';
import { classifyBlock, isKnownBlockKey, KNOWN_BLOCK_KEYS } from '@/shared/attention';

const MAIN = path.resolve(__dirname, '../../src/main');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Every string literal handed to a block site: `blockRuntime(…)`, `stopForIncident(…)`, `.block(…)`, `.blocked(…)`, `blockedReason = …`. */
function blockLiterals(): Map<string, string> {
  const found = new Map<string, string>();
  const site = /(?:blockRuntime|stopForIncident|\.block|\.blocked)\(([^)]*)\)|blockedReason = ('[^']+')/g;
  for (const file of sources(MAIN)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(site)) {
      const args = m[1] ?? m[2] ?? '';
      for (const lit of args.matchAll(/'([^'$]+)'/g)) {
        const key = lit[1] as string;
        if (!found.has(key)) found.set(key, path.relative(MAIN, file));
      }
    }
  }
  return found;
}

describe('attention (L-ATTENTION)', () => {
  it('finds the block sites it guards (the grep is not vacuous)', () => {
    const keys = [...blockLiterals().keys()];
    expect(keys).toEqual(expect.arrayContaining(['account-changed', 'login-required', 'startup-failed']));
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  it('every block literal under src/main classifies to a known key', () => {
    const unknown = [...blockLiterals()].filter(([key]) => classifyBlock(key).key === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('every halt key classifies to a known key (parity with the halt vocabulary)', () => {
    const halts = ALL_HALT_REASONS.map(haltReasonKey);
    expect(halts.filter((k) => !isKnownBlockKey(k))).toEqual([]);
  });

  it('an unknown key is neutral: Diagnostics, blocks schedules, raw kept for the code line', () => {
    expect(classifyBlock('something-new')).toEqual({
      key: 'unknown', raw: 'something-new', action: 'diagnostics', blocksSchedules: true,
    });
  });

  it('every known key has an action, and only the unconfirmed-actions breaker leaves schedules running', () => {
    for (const key of KNOWN_BLOCK_KEYS) {
      const a = classifyBlock(key);
      expect(a.key).toBe(key);
      expect(a.blocksSchedules).toBe(key !== 'actions-unconfirmed');
    }
    expect(classifyBlock('adapter-drift').action).toBe('check-update');
    expect(classifyBlock('seed-unresolved').action).toBe('choose-seed');
    expect(classifyBlock('sentinel:logged-out').action).toBe('show-live');
    expect(classifyBlock('runtime-state-persist-failed').action).toBe('restart-app');
  });
});
