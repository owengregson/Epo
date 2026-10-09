/**
 * A push channel string appears EXACTLY ONCE in the repo.
 *
 * ADR 0101 made that true for the 35 invoke channels; the five push channels
 * stayed hand-written in three places (`preload.ts`'s `EVENT_CHANNELS`,
 * `main.ts`'s literal `shell.send()` calls, `EpoEventPayloads` in `types.ts`)
 * and had already drifted once. This is the mechanical guard: a grep over
 * `src/**` that fails the moment a second copy of a channel string — or a
 * brand-new `epo:*` literal declared outside the contract — appears.
 *
 * See ADR 1008.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PUSH, type PushMethod } from '@/ipc/contract';

const SRC = path.resolve(__dirname, '../../src');
const CONTRACT = path.join(SRC, 'ipc', 'contract.ts');

/** Every source file under `src/`, absolute. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

test('every push channel string is written in exactly one place', () => {
  const channels = Object.keys(PUSH) as PushMethod[];
  expect(channels.length).toBeGreaterThan(0);

  for (const channel of channels) {
    const literal = PUSH[channel];
    const sites = FILES.flatMap(({ file, text }) =>
      text.split(literal).length > 1 ? [{ file, count: text.split(literal).length - 1 }] : [],
    );
    expect({ literal, sites }).toEqual({
      literal,
      sites: [{ file: CONTRACT, count: 1 }],
    });
  }
});

test('no `epo:` push literal is declared outside the contract', () => {
  const declared = new Set<string>(Object.values(PUSH));
  const strays: { file: string; literal: string }[] = [];
  for (const { file, text } of FILES) {
    if (file === CONTRACT) continue;
    for (const match of text.matchAll(/'(epo:[a-z-]+)'/g)) {
      const literal = match[1] as string;
      strays.push({ file, literal });
    }
  }
  // Every stray is a violation whether or not the contract already knows the
  // channel: a known one is a second copy, an unknown one is a channel the
  // contract never declared.
  expect({ strays, declared: [...declared].sort() }).toEqual({
    strays: [],
    declared: [...declared].sort(),
  });
});
