/**
 * The settings file protocol (spec §6.6, §16.4), over an injected fs. Write: copy the current file to
 * `.bak` → write `.tmp`, fsync, close → rename → fsync the directory (best effort, logged); the first
 * write also leaves the never-deleted `.created` marker. Read: the §6.6 table, first matching row wins.
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import type { SettingsHealth } from '@/shared/settings-view';
import * as logger from '@/utils/logger';
import type { SettingsDocV2 } from './doc';
import { coerceDoc, DOC_RULES } from './doc-rules';

export interface SettingsFs {
  exists(p: string): boolean;
  /** Throws when the file cannot be read. */
  readFile(p: string): string;
  /** Write, fsync and close. */
  writeFileSynced(p: string, data: string): void;
  copyFile(from: string, to: string): void;
  rename(from: string, to: string): void;
  fsyncDir(dir: string): void;
  mtimeMs(p: string): number;
  list(dir: string): string[];
}

export const NODE_SETTINGS_FS: SettingsFs = {
  exists: (p) => nodeFs.existsSync(p),
  readFile: (p) => nodeFs.readFileSync(p, 'utf8'),
  writeFileSynced: (p, data) => {
    const fd = nodeFs.openSync(p, 'w');
    try {
      nodeFs.writeSync(fd, data);
      nodeFs.fsyncSync(fd);
    } finally {
      nodeFs.closeSync(fd);
    }
  },
  copyFile: (from, to) => nodeFs.copyFileSync(from, to),
  rename: (from, to) => nodeFs.renameSync(from, to),
  fsyncDir: (dir) => {
    const fd = nodeFs.openSync(dir, 'r');
    try {
      nodeFs.fsyncSync(fd);
    } finally {
      nodeFs.closeSync(fd);
    }
  },
  mtimeMs: (p) => nodeFs.statSync(p).mtimeMs,
  list: (dir) => nodeFs.readdirSync(dir),
};

const V2 = 'epo-settings-v2.json';
const CORRUPT = /^epo-settings-v2[.]corrupt-\d+[.]json$/;
export const SETTINGS_FILES = {
  v1: 'epo-settings.json', v2: V2, bak: `${V2}.bak`, tmp: `${V2}.tmp`, created: 'epo-settings-v2.created',
  corrupt: (epoch: number) => `epo-settings-v2.corrupt-${epoch}.json`,
} as const;

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** Persist `doc` (its rev already advanced); any failure before the rename leaves the old file in place. */
export function writeSettings(
  fs: SettingsFs, dir: string, doc: SettingsDocV2, marker: { readonly now: number; readonly fromV1Sha256: string | null },
): WriteResult {
  const at = (f: string) => path.join(dir, f);
  try {
    const data = `${JSON.stringify(doc, null, '  ')}\n`;
    if (fs.exists(at(SETTINGS_FILES.v2))) fs.copyFile(at(SETTINGS_FILES.v2), at(SETTINGS_FILES.bak));
    fs.writeFileSynced(at(SETTINGS_FILES.tmp), data);
    fs.rename(at(SETTINGS_FILES.tmp), at(SETTINGS_FILES.v2));
  } catch (e) {
    logger.error('settings: write failed; nothing changed', { error: String(e) });
    return { ok: false, detail: String(e) };
  }
  try {
    fs.fsyncDir(dir);
  } catch (e) {
    logger.warn('settings: directory fsync failed (the file itself is synced)', { error: String(e) });
  }
  if (!fs.exists(at(SETTINGS_FILES.created))) {
    try {
      fs.writeFileSynced(at(SETTINGS_FILES.created), JSON.stringify({ createdAt: marker.now, fromV1Sha256: marker.fromV1Sha256 }));
    } catch (e) {
      logger.error('settings: the v2 marker could not be written', { error: String(e) });
    }
  }
  return { ok: true };
}

/** What construction does with the files it finds (spec §6.6). */
export type ReadPlan =
  | { readonly kind: 'doc'; readonly doc: SettingsDocV2; readonly health: SettingsHealth; readonly review: boolean }
  | { readonly kind: 'migrate'; readonly raw: string; readonly mtimeMs: number; readonly health: SettingsHealth; readonly review: boolean }
  | { readonly kind: 'defaults'; readonly health: SettingsHealth; readonly review: boolean };

/** Parse and coerce a v2 file; null when it is unreadable. Protection garbage puts protection under review. */
function parseV2(fs: SettingsFs, p: string): { doc: SettingsDocV2; review: boolean } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFile(p));
  } catch (e) {
    logger.warn('settings: unreadable settings file', { file: path.basename(p), error: String(e) });
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const protection = DOC_RULES.protection((raw as Record<string, unknown>).protection, coerceDoc(undefined).value.protection);
  return { doc: coerceDoc(raw).value, review: protection.dropped > 0 };
}

/** Read the settings files: the first matching row of the §6.6 table wins. */
export function readSettings(fs: SettingsFs, dir: string, o: { readonly knowledgeDbExists: boolean; readonly now: number }): ReadPlan {
  const at = (f: string) => path.join(dir, f);
  const v1 = (): { raw: string; mtimeMs: number } | null => {
    if (!fs.exists(at(SETTINGS_FILES.v1))) return null;
    try {
      return { raw: fs.readFile(at(SETTINGS_FILES.v1)), mtimeMs: fs.mtimeMs(at(SETTINGS_FILES.v1)) };
    } catch (e) {
      logger.warn('settings: the v1 file is unreadable', { error: String(e) });
      return null;
    }
  };
  let quarantined: string | null = null;
  if (fs.exists(at(SETTINGS_FILES.v2))) {
    const v2 = parseV2(fs, at(SETTINGS_FILES.v2));
    if (v2 !== null) return { kind: 'doc', doc: v2.doc, health: { kind: 'ok' }, review: v2.review };
    try {
      fs.rename(at(SETTINGS_FILES.v2), at(SETTINGS_FILES.corrupt(o.now)));
      quarantined = SETTINGS_FILES.corrupt(o.now);
      logger.error('settings: the settings file was unreadable and is kept aside', { quarantined });
    } catch (e) {
      logger.error('settings: an unreadable settings file could not be set aside', { error: String(e) });
    }
  }
  const evidence = quarantined !== null || fs.exists(at(SETTINGS_FILES.v2)) || fs.exists(at(SETTINGS_FILES.bak)) || fs.exists(at(SETTINGS_FILES.created))
    || fs.list(dir).some((f) => CORRUPT.test(f));
  const old = v1();
  if (!evidence) {
    if (old !== null) return { kind: 'migrate', ...old, health: { kind: 'ok' }, review: false };
    return o.knowledgeDbExists
      ? { kind: 'defaults', health: { kind: 'defaults-after-unreadable', quarantined: null }, review: true }
      : { kind: 'defaults', health: { kind: 'ok' }, review: false };
  }
  // A previous v2 existed: never a silent re-migration (it would drop every later protection edit).
  const bak = fs.exists(at(SETTINGS_FILES.bak)) ? parseV2(fs, at(SETTINGS_FILES.bak)) : null;
  if (bak !== null) return { kind: 'doc', doc: bak.doc, health: { kind: 'restored-from-backup', quarantined: quarantined ?? '' }, review: true };
  if (old !== null) return { kind: 'migrate', ...old, health: { kind: 'remigrated-from-v1', quarantined }, review: true };
  return { kind: 'defaults', health: { kind: 'defaults-after-unreadable', quarantined }, review: true };
}
