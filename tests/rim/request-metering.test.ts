import { installRequestMetering } from '@/rim/request-metering';
import { Reader } from '@/adapter/reader';
import type { RequestBudget } from '@/governors/request-budget';
import { FakeTab, FakeBudget, mkResp, followersUrl } from './fakes';

test('spends exactly once per matching IG response, never for non-matching', () => {
  const tab = new FakeTab();
  const reader = new Reader();
  const budget = new FakeBudget();
  const unsubscribe = installRequestMetering(tab, budget as unknown as RequestBudget, reader);

  // N = 3 matching (real IG API endpoints the Reader recognizes).
  tab.emit(mkResp(followersUrl('999'), {}));
  tab.emit(mkResp('https://www.instagram.com/api/v1/users/web_profile_info/?username=x', {}));
  tab.emit(mkResp('https://www.instagram.com/api/v1/friendships/show/42/', {}));

  // M = 2 non-matching (static assets / third-party) → ignored.
  tab.emit(mkResp('https://www.instagram.com/static/bundle.js', {}));
  tab.emit(mkResp('https://cdn.example.com/pixel.png', {}));

  expect(budget.spends).toBe(3);

  // After unsubscribe, further responses are not metered.
  unsubscribe();
  tab.emit(mkResp(followersUrl('999', 'C1'), {}));
  expect(budget.spends).toBe(3);
});
