jest.mock('electron', () => ({ webContents: { getAllWebContents: jest.fn() } }));
jest.mock('@/adapter/tab', () => ({ IG_HOME_URL: 'https://www.instagram.com/' }));
jest.mock('@/adapter/actor', () => ({ Actor: jest.fn() }));
jest.mock('@/adapter/tab-interactor', () => ({ createTabInteractor: jest.fn() }));
jest.mock('@/probe/recorder', () => ({
  TrafficRecorder: jest.fn().mockImplementation(() => ({
    start: () => { throw new Error('fixture recorder started'); },
  })),
}));

import { webContents } from 'electron';
import type { InstagramTab } from '@/adapter/tab';
import { TrafficRecorder } from '@/probe/recorder';
import { traffic } from '@/probe/traffic';

const savedTarget = process.env.EPO_PROBE_TARGET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EPO_PROBE_TARGET = 'synthetic-target';
});
afterAll(() => {
  if (savedTarget === undefined) delete process.env.EPO_PROBE_TARGET;
  else process.env.EPO_PROBE_TARGET = savedTarget;
});

const misleading = { getURL: () => 'https://unrelated.example/?next=instagram.com' };

test('traffic probe does not attach to a window mentioning the host in its query', async () => {
  jest.mocked(webContents.getAllWebContents).mockReturnValue([misleading] as never);
  await expect(traffic({} as InstagramTab, 'unused')).rejects.toThrow('no Instagram webContents');
  expect(TrafficRecorder).not.toHaveBeenCalled();
});

test('traffic probe selects the canonical window even when a misleading one precedes it', async () => {
  const canonical = { getURL: () => 'https://www.instagram.com/example/' };
  jest.mocked(webContents.getAllWebContents).mockReturnValue([misleading, canonical] as never);
  await expect(traffic({} as InstagramTab, 'unused')).rejects.toThrow('fixture recorder started');
  expect(TrafficRecorder).toHaveBeenCalledWith(canonical, 'unused');
});
