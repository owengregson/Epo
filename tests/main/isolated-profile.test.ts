/**
 * The isolated-profile launch mode: `EPO_USER_DATA_DIR` moves the whole profile
 * before the app name is claimed (the real `<appData>/Epo` is never opened), and
 * `EPO_BLOCK_NETWORK=1` routes the Instagram partition through an unroutable proxy.
 */

jest.mock('electron', () => {
  const nodePath = jest.requireActual('node:path') as typeof import('node:path');
  const nodeFs = jest.requireActual('node:fs') as typeof import('node:fs');
  const state = {
    name: 'Electron',
    appData: '',
    paths: new Map<string, string>(),
    calls: [] as string[],
    proxies: [] as Array<{ partition: string; cfg: unknown }>,
  };
  /** Electron's defaults: userData and sessionData derive from appData + the app name. */
  const derived = (key: string): string => {
    if (key === 'appData') return state.appData;
    if (key === 'userData' || key === 'sessionData') return nodePath.join(state.appData, state.name);
    throw new Error(`unexpected path ${key}`);
  };
  return {
    app: {
      setName: (name: string): void => {
        state.calls.push(`setName:${name}`);
        state.name = name;
      },
      setPath: (key: string, value: string): void => {
        if (!nodeFs.existsSync(value)) throw new Error(`setPath(${key}) on a missing directory`);
        state.calls.push(`setPath:${key}`);
        state.paths.set(key, value);
      },
      getPath: (key: string): string => state.paths.get(key) ?? derived(key),
    },
    session: {
      fromPartition: (partition: string) => ({
        setProxy: async (cfg: unknown): Promise<void> => {
          state.proxies.push({ partition, cfg });
        },
      }),
    },
    WebContentsView: class {},
    __identityMock: state,
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { IG_PARTITION } from '@/adapter/tab';
import { claimAppIdentity } from '@/main/app-identity';
import { applyNetworkBlock } from '@/main/services/ig-session';
import { setLevel } from '@/utils/logger';

interface IdentityMock {
  name: string;
  appData: string;
  paths: Map<string, string>;
  calls: string[];
  proxies: Array<{ partition: string; cfg: unknown }>;
}

const mock = (jest.requireMock('electron') as { __identityMock: IdentityMock }).__identityMock;
const temps: string[] = [];

/** A fresh appData holding a pre-rename dev profile (`Electron/epo.db`). */
function freshAppData(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-appdata-'));
  temps.push(dir);
  fs.mkdirSync(path.join(dir, 'Electron'));
  fs.writeFileSync(path.join(dir, 'Electron', 'epo.db'), 'legacy');
  return dir;
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
}

beforeAll(() => setLevel('error'));
beforeEach(() => {
  mock.name = 'Electron';
  mock.paths.clear();
  mock.calls.length = 0;
  mock.proxies.length = 0;
});
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('EPO_USER_DATA_DIR', () => {
  test('the profile lives in the given directory, claimed before the name; <appData>/Epo is never touched', () => {
    mock.appData = freshAppData();
    const isolated = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epo-isolated-')), 'profile');
    temps.push(path.dirname(isolated));

    claimAppIdentity({ EPO_USER_DATA_DIR: isolated });

    expect(app.getPath('userData')).toBe(isolated);
    expect(app.getPath('sessionData')).toBe(isolated);
    expect(fs.existsSync(isolated)).toBe(true);
    expect(mock.calls).toEqual(['setPath:userData', 'setPath:sessionData', 'setName:Epo']);
    expect(fs.existsSync(path.join(mock.appData, 'Epo'))).toBe(false);
    expect(filesUnder(mock.appData)).toEqual(['Electron', path.join('Electron', 'epo.db')]);
  });

  test('unset, the default profile and the one-time legacy move are unchanged', () => {
    mock.appData = freshAppData();

    claimAppIdentity({});

    expect(mock.calls).toEqual(['setName:Epo']);
    expect(app.getPath('userData')).toBe(path.join(mock.appData, 'Epo'));
    expect(fs.existsSync(path.join(mock.appData, 'Epo', 'epo.db'))).toBe(true);
  });
});

describe('EPO_BLOCK_NETWORK', () => {
  test('=1 routes the Instagram partition through an unroutable proxy', async () => {
    expect(await applyNetworkBlock({ EPO_BLOCK_NETWORK: '1' })).toBe(true);
    expect(mock.proxies).toEqual([
      { partition: IG_PARTITION, cfg: { mode: 'fixed_servers', proxyRules: '192.0.2.1:9' } },
    ]);
  });

  test('unset or any other value leaves the partition alone', async () => {
    expect(await applyNetworkBlock({})).toBe(false);
    expect(await applyNetworkBlock({ EPO_BLOCK_NETWORK: 'true' })).toBe(false);
    expect(mock.proxies).toEqual([]);
  });
});
