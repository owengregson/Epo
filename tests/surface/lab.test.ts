/**
 * `surface-lab replay` and `diff` — the two subcommands that need no Electron.
 *
 * That is the property under test as much as the output: the contract the
 * corpus encodes must be checkable in CI, without a browser, a session, or a
 * live account. `replay` is the same walk `tests/surface/replay.test.ts` does,
 * exposed as a command so a maintainer can run it after editing a schema.
 */

import { diffEndpoint, digestBody } from '@/surface-lab/digest';
import { diff, replay } from '@/surface-lab/main';
import { hasCorpus } from './corpus';

(hasCorpus() ? describe : describe.skip)('replay', () => {
  test('every committed body reproduces its recorded projection', () => {
    const { checked, failures } = replay();
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});

(hasCorpus() ? describe : describe.skip)('diff', () => {
  test('reports per-endpoint findings and names the corpus’s blind spots', () => {
    const lines = diff();
    expect(lines.join('\n')).toContain('followers-list:');
    // A missing endpoint is stated, not silently absent — an unverified
    // endpoint is exactly what a maintainer needs told.
    expect(lines.some((l) => l.includes('NO BODY IN THE CORPUS'))).toBe(true);
  });
});

describe('the shape digest', () => {
  test('counts a field’s presence against its CONTAINER, not the whole body', () => {
    const digest = digestBody({
      users: [{ pk: '1', full_name: 'Name A1' }, { pk: '2' }],
    });
    expect(digest['users[].pk']).toMatchObject({ types: ['string'], seen: 2, total: 2 });
    // 1-of-2 rows carry `full_name` — the shape of the "required but rare"
    // signal, and the reason schemas are not generated from fixtures.
    expect(digest['users[].full_name']).toMatchObject({ seen: 1, total: 2 });
  });

  test('records every type a path took, so a union is visible', () => {
    const digest = digestBody({ users: [{ pk: '1' }, { pk: 2 }] });
    expect(digest['users[].pk']?.types.sort()).toEqual(['number', 'string']);
  });

  test('a novel key is reported against the schema that does not declare it', () => {
    const findings = diffEndpoint('followers-list', [
      { users: [{ pk: '1', brand_new_field: 'x' }], next_max_id: '50' },
    ]);
    expect(findings.some((f) => f.kind === 'novel' && f.path === 'users[].brand_new_field')).toBe(
      true,
    );
  });

  test('a pk arriving as an object is a TYPE finding, not a silent parse', () => {
    const findings = diffEndpoint('followers-list', [
      { users: [{ pk: { id: 1 } }], next_max_id: '50' },
    ]);
    expect(findings.some((f) => f.kind === 'type' && f.path === 'users[].pk')).toBe(true);
  });
});
