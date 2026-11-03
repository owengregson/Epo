/**
 * The settings file protocol (spec §6.6): the write order and its failure modes, the `.created` marker,
 * and every row of the read table in its order — including a missing v2 with evidence of a previous one,
 * which restores the backup or re-migrates under review, never silently.
 */
import { DEFAULT_DOC } from '@/settings/doc';
import { SETTINGS_FILES as F, readSettings, writeSettings } from '@/settings/persist';
import { memoryFs } from '../kit/settings';

const DIR = '/user';
const doc = (rev: number) => ({ ...DEFAULT_DOC, rev, seed: `seed${rev}` });
const json = (rev: number) => JSON.stringify(doc(rev));
const marker = { now: 7, fromV1Sha256: 'abc' };
const read = (fs: ReturnType<typeof memoryFs>['fs'], knowledgeDbExists = false) => readSettings(fs, DIR, { knowledgeDbExists, now: 99 });

describe('write', () => {
  test('copy to .bak → write .tmp (synced) → rename → fsync the directory → the marker, once', () => {
    const m = memoryFs({ [F.v2]: json(1) });
    expect(writeSettings(m.fs, DIR, doc(2), marker)).toEqual({ ok: true });
    expect(m.calls).toEqual([`copy ${F.v2}`, `write ${F.tmp}`, `rename ${F.tmp}`, 'fsync-dir user', `write ${F.created}`]);
    expect(JSON.parse(m.data.get(F.v2) ?? '').rev).toBe(2);
    expect(JSON.parse(m.data.get(F.bak) ?? '').rev).toBe(1);
    expect(JSON.parse(m.data.get(F.created) ?? '')).toEqual({ createdAt: 7, fromV1Sha256: 'abc' });
    m.calls.length = 0;
    writeSettings(m.fs, DIR, doc(3), marker);
    expect(m.calls).not.toContain(`write ${F.created}`);
  });

  test.each(['copy', 'write', 'rename'])('a failed %s is a failed write and leaves the current file', (op) => {
    const m = memoryFs({ [F.v2]: json(1) });
    m.failOn(op);
    expect(writeSettings(m.fs, DIR, doc(2), marker)).toMatchObject({ ok: false });
    expect(JSON.parse(m.data.get(F.v2) ?? '').rev).toBe(1);
  });

  test('a failed directory fsync is logged, never a failed write', () => {
    const m = memoryFs({ [F.v2]: json(1) });
    m.failOn('fsync-dir');
    expect(writeSettings(m.fs, DIR, doc(2), marker)).toEqual({ ok: true });
  });
});

describe('read, first matching row wins', () => {
  test('v2 parses → the document, ok', () => {
    expect(read(memoryFs({ [F.v2]: json(4), [F.v1]: '{}' }).fs)).toMatchObject({ kind: 'doc', doc: { rev: 4 }, health: { kind: 'ok' }, review: false });
  });

  test('v2 with protection garbage → the document, under review', () => {
    const raw = { ...doc(4), protection: { ...DEFAULT_DOC.protection, accounts: [42] } };
    expect(read(memoryFs({ [F.v2]: JSON.stringify(raw) }).fs)).toMatchObject({ kind: 'doc', review: true });
  });

  test('v2 unreadable → set aside under its epoch, the backup restored, under review', () => {
    const m = memoryFs({ [F.v2]: '{oops', [F.bak]: json(3) });
    expect(read(m.fs)).toMatchObject({ kind: 'doc', doc: { rev: 3 }, health: { kind: 'restored-from-backup', quarantined: F.corrupt(99) }, review: true });
    expect(m.data.get(F.corrupt(99))).toBe('{oops');
    expect(m.data.has(F.v2)).toBe(false);
  });

  test('v2 missing with a backup → restored, under review (never a silent re-migration)', () => {
    expect(read(memoryFs({ [F.bak]: json(3), [F.v1]: '{}' }).fs))
      .toMatchObject({ kind: 'doc', doc: { rev: 3 }, health: { kind: 'restored-from-backup' }, review: true });
  });

  test.each([[F.created], [F.corrupt(5)]])('v2 missing, evidence %s, v1 present → re-migrated under review', (evidence) => {
    expect(read(memoryFs({ [evidence]: 'x', [F.v1]: '{"seed":"a"}' }).fs))
      .toMatchObject({ kind: 'migrate', raw: '{"seed":"a"}', health: { kind: 'remigrated-from-v1' }, review: true });
  });

  test('v2 and the backup unreadable, v1 present → re-migrated under review', () => {
    expect(read(memoryFs({ [F.v2]: 'no', [F.bak]: 'no', [F.v1]: '{}' }).fs))
      .toMatchObject({ kind: 'migrate', health: { kind: 'remigrated-from-v1', quarantined: F.corrupt(99) }, review: true });
  });

  test('nothing readable but a knowledge DB → defaults under review', () => {
    expect(read(memoryFs({ [F.v2]: 'no' }).fs, true)).toMatchObject({ kind: 'defaults', health: { kind: 'defaults-after-unreadable' }, review: true });
    expect(read(memoryFs({}).fs, true)).toMatchObject({ kind: 'defaults', health: { kind: 'defaults-after-unreadable' }, review: true });
  });

  test('nothing at all and no DB → a fresh install, ready', () => {
    expect(read(memoryFs({}).fs)).toEqual({ kind: 'defaults', health: { kind: 'ok' }, review: false });
  });

  test('v2 missing, no v2 evidence, v1 present → migrate, ready', () => {
    expect(read(memoryFs({ [F.v1]: '{"seed":"a"}' }, 123).fs))
      .toEqual({ kind: 'migrate', raw: '{"seed":"a"}', mtimeMs: 123, health: { kind: 'ok' }, review: false });
  });
});
