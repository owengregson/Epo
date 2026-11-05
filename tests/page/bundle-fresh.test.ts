/**
 * Gate on the committed page bundle.
 *
 * `src/adapter/page/bundle.generated.ts` is checked in so the app and the test
 * suite need no build step — which means it can silently go stale the moment
 * anyone edits `src/adapter/page/*.ts`. This rebuilds it in memory and fails
 * when the two differ: a stale bundle would ship OLD in-page mechanics while
 * every unit test exercised the new ones.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { SURFACE } from '@/adapter/ig-surface';
import { PAGE_BUNDLE } from '@/adapter/page/bundle.generated';

const REPO = path.join(__dirname, '..', '..');

test('the committed page bundle matches its sources', () => {
  // `--check` rebuilds in memory and exits non-zero when the committed module
  // differs. Run `node esbuild.page.mjs` to refresh it.
  expect(() =>
    execFileSync('node', ['esbuild.page.mjs', '--check'], { cwd: REPO, stdio: 'pipe' }),
  ).not.toThrow();
}, 60_000);

describe('the bundle carries no Instagram literals', () => {
  /**
   * Constraint (a) of CLAUDE.md, made checkable: every selector, text matcher
   * and URL lives in `src/adapter/versions/*` and reaches page context as a
   * JSON config. If one leaked into `src/adapter/page/*.ts`, a new capture
   * would have to re-implement the mechanics instead of just retabling.
   */
  const components = [
    'action-button',
    'unfollow-confirm',
    'followers-stat',
    'following-stat',
    'notifications-link',
    'dialog',
  ] as const;

  test.each(components)('no %s selector/matcher is baked in', (component) => {
    expect(PAGE_BUNDLE).not.toContain(SURFACE.staleSelectorLabel(component));
  });

  test('no origin, app id, or endpoint path', () => {
    expect(PAGE_BUNDLE).not.toContain(SURFACE.origin);
    expect(PAGE_BUNDLE).not.toContain(SURFACE.appId);
    expect(PAGE_BUNDLE.toLowerCase()).not.toContain('instagram');
    expect(PAGE_BUNDLE).not.toContain('/api/');
  });
});

describe('the bundle is callable', () => {
  test('page reads leave existing globals intact and do not publish helpers', () => {
    const context = { window: { __epoPage: 'page-owned' }, document: { querySelector: () => null } };
    expect(runInNewContext(SURFACE.dialogPresentScript(), context)).toEqual({ present: false });
    expect(context.window.__epoPage).toBe('page-owned');
    expect(Object.keys(context)).toEqual(['window', 'document']);
    expect(PAGE_BUNDLE).not.toContain('window.__epoPage=');
  });

  test('every control script is one bundle plus one descriptor call', () => {
    // Controls are DATA now: each script is the bundle plus a single
    // `locate`/`probe` call whose descriptor names the control. The old
    // per-control page functions are gone from the CALL SITE, not from the
    // bundle — `locate` dispatches to the same implementations.
    const scripts: Array<[string, string, string]> = [
      ['locate', 'action-button', SURFACE.locateActionButtonScript('follow')],
      ['probe', 'action-button', SURFACE.probeStateScript()],
      ['locate', 'unfollow-confirm', SURFACE.locateConfirmUnfollowScript()],
      ['locate', 'followers-stat', SURFACE.locateFollowersStatScript()],
      ['locate', 'following-stat', SURFACE.locateFollowingStatScript()],
      ['locate', 'list-scroller', SURFACE.locateScrollContainerScript()],
      ['locate', 'drawer-scroller', SURFACE.locateNotificationsScrollScript()],
      ['locate', 'notifications-link', SURFACE.locateNotificationsLinkScript()],
      ['locate', 'drawer-close', SURFACE.locateNotificationsCloseScript()],
      ['locate', 'follow-requests-entry', SURFACE.locateFollowRequestsEntryScript()],
      ['locate', 'notifications-follows-filter', SURFACE.locateNotificationsFollowsFilterScript()],
      ['locate', 'confirm-follow-request', SURFACE.locateConfirmFollowRequestScript()],
      ['locate', 'profile-link', SURFACE.locateProfileLinkScript()],
      ['locate', 'profile-href', SURFACE.readProfileHrefScript()],
      ['locate', 'profile-link-click', SURFACE.clickProfileLinkScript()],
      ['locate', 'avatar-alt', SURFACE.readAvatarAltScript()],
    ];
    for (const [entry, control, script] of scripts) {
      expect(script.startsWith(`(() => { ${PAGE_BUNDLE}`)).toBe(true);
      expect(script.slice(script.indexOf(PAGE_BUNDLE) + PAGE_BUNDLE.length)).toMatch(
        new RegExp(`^; return __epoPage\\.${entry}\\(\\{.*\\}\\); \\}\\)\\(\\)$`, 's'),
      );
      expect(script).toContain(`"control":"${control}"`);
    }
  });

  test('the two non-control probes keep their own entry points', () => {
    // `dialogPresent` and `blockText` are page PROBES, not controls: they name
    // no press target, so they are not descriptors.
    for (const [fn, script] of [
      ['dialogPresent', SURFACE.dialogPresentScript()],
      ['blockText', SURFACE.bodyTextProbeScript()],
    ] as Array<[string, string]>) {
      expect(script.slice(script.indexOf(PAGE_BUNDLE) + PAGE_BUNDLE.length)).toMatch(
        new RegExp(`^; return __epoPage\\.${fn}\\(\\{.*\\}\\); \\}\\)\\(\\)$`, 's'),
      );
    }
  });
});
