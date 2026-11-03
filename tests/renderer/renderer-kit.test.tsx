/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The renderer kit landed in Phase F: the keep-alive hook's `onError`, the final
 * stylesheet cascade, the fake bridge covering every contract method, the empty
 * gallery scenario arrays and the Settings stage placeholder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { signal } from '@preact/signals';
import { render, waitFor } from '@testing-library/preact';
import { CHANNELS } from '@/ipc/contract';
import { LIVE_SCENARIOS } from '@/renderer/gallery/fixtures-live';
import { SURFACE_SCENARIOS } from '@/renderer/gallery/fixtures-surface';
import { useKeepAlivePoll } from '@/renderer/hooks/useKeepAlivePoll';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import { installFakeBridge } from '../kit/render-bridge';

test('a failed pull reaches onError, and a later push still lands', async () => {
  const sink = signal<number | null>(null);
  const errors: unknown[] = [];
  const push: { current: ((v: number) => void) | null } = { current: null };
  function Probe() {
    useKeepAlivePoll<number>({
      subscribe: (apply) => {
        push.current = apply;
        return () => {};
      },
      pull: () => Promise.reject(new Error('offline')),
      sink,
      onError: (e) => errors.push(e),
    });
    return null;
  }
  render(<Probe />);
  await waitFor(() => expect(errors).toHaveLength(1));
  expect(String(errors[0])).toContain('offline');
  push.current?.(7);
  expect(sink.value).toBe(7);
});

test('the stylesheet cascade is final: fonts first, today\'s order, then the six new stage files', () => {
  const dir = path.resolve(__dirname, '../../src/renderer/styles');
  const order = [...fs.readFileSync(path.join(dir, 'index.css'), 'utf8').matchAll(/@import "\.\/([a-z.-]+)";/g)]
    .map((m) => m[1]);
  expect(order[0]).toBe('fonts.css');
  expect(order.slice(-6)).toEqual(['sidebar.css', 'people.css', 'settings-stage.css', 'compatibility.css', 'boot.css',
    'diagnostics.css']);
  for (const file of order) expect(fs.existsSync(path.join(dir, file))).toBe(true);
});

test('the fake bridge implements every contract method', () => {
  const fake = installFakeBridge(DEFAULT_SETTINGS);
  const bridge = fake.bridge as unknown as Record<string, unknown>;
  for (const method of Object.keys(CHANNELS)) expect({ method, fn: typeof bridge[method] }).toEqual({ method, fn: 'function' });
  expect(fake.data.settingsFacts).toMatchObject({ built: false });
});

test('the gallery scenario arrays the later streams fill start empty (the compatibility three have landed)', () => {
  expect(LIVE_SCENARIOS).toEqual([]);
  expect(SURFACE_SCENARIOS.map((s) => s.key)).toEqual(['surface-adapted', 'surface-unfollows-paused', 'surface-exploration-paused']);
});
