jest.mock('electron', () => ({
  app: {
    commandLine: { appendSwitch: jest.fn() },
    getPreferredSystemLanguages: () => ['en-US'],
  },
  session: {
    fromPartition: () => ({
      getUserAgent: () =>
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Epo/3.1.1 Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36',
      setUserAgent: jest.fn(),
    }),
  },
  WebContentsView: jest.fn().mockImplementation(() => ({
    webContents: { setUserAgent: jest.fn() },
  })),
}));

import { app, WebContentsView } from 'electron';
import { InstagramTab } from '@/adapter/tab';
import { applyBackgroundSurvivalSwitches } from '@/main/bootstrap';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  jest.clearAllMocks();
});

test.each(['darwin', 'win32', 'linux'])('%s keeps shared GPU and dashboard frame pacing', (os) => {
  Object.defineProperty(process, 'platform', { value: os });
  applyBackgroundSurvivalSwitches();
  expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('disable-frame-rate-limit');
  expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith('disable-gpu-vsync');
  expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-background-timer-throttling');
});

test.each(['darwin', 'win32', 'linux'])('%s scopes hidden-page frame survival to Instagram', (os) => {
  Object.defineProperty(process, 'platform', { value: os });
  new InstagramTab();
  expect(WebContentsView).toHaveBeenCalledWith({
    webPreferences: expect.objectContaining({
      backgroundThrottling: false,
      additionalArguments: os === 'darwin' ? ['--disable-frame-rate-limit'] : [],
    }),
  });
  expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
});
