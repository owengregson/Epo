import { runInNewContext } from 'node:vm';
import { pageCall } from '@/adapter/page-call';

test('compiled page calls preserve config data without publishing helpers or script delimiters', () => {
  const selector = `</script><script>globalThis.injected = true</script>\u2028\u2029"\\\` \${notCode}`;
  const querySelector = jest.fn(() => null);
  const context = { document: { querySelector }, window: { __epoPage: 'page-owned' } };
  const script = pageCall('dialogPresent', { sel: selector });
  expect(runInNewContext(script, context)).toEqual({ present: false });
  expect(querySelector).toHaveBeenCalledWith(selector);
  expect(context).toEqual({ document: { querySelector }, window: { __epoPage: 'page-owned' } });
  expect(script).not.toMatch(/<\/script>|[\u2028\u2029]/);
});
