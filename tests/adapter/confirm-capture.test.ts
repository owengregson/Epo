/**
 * The passive confirm-layer capture (ADR 0308): every capture is scrubbed through the fixture
 * scrubber's DOM pass before it is kept, each layer is kept once, and the default capture writes to
 * the durable log only — nothing at the test log level.
 */
import { logCapture, NO_CAPTURE, scrubbedCapture } from '@/adapter/confirm-capture';
import { setLevel, setSink } from '@/utils/logger';
import { domText } from '../surface/corpus';

const RAW = {
  reason: 'later-layer' as const,
  op: 'actor.unfollow' as const,
  username: 'someone',
  layer: 'dialog' as const,
  controls: 2,
  structural: 'Unfollow @someone',
  markup: '<div role="dialog"><a href="/someone/"><img alt="someone\'s profile picture" '
    + 'src="https://scontent.cdninstagram.com/v/t51/99887766554433_n.jpg"></a>'
    + '<span>If you change your mind, you\'ll have to request to follow @someone again.</span>'
    + '<button>Unfollow</button><button>Cancel</button></div>',
  unmatchedPosts: [{ path: '/api/v1/web/friendships/55443322110/unfollow/', friendlyName: null, status: 200 }],
};

test("the action's own handle, links, image URLs and long ids are scrubbed; the structure stays", () => {
  const record = scrubbedCapture(RAW);
  const kept = JSON.stringify(record);
  expect(kept).not.toMatch(/someone|cdninstagram|99887766554433|55443322110/);
  expect(record.markup).toContain('<button>Unfollow</button><button>Cancel</button>');
  expect(record.structural).toBe('Unfollow @user_a1');
  expect(record).toMatchObject({ reason: 'later-layer', op: 'actor.unfollow', layer: 'dialog', controls: 2 });
});

test('a real captured dialog keeps none of its handles after the scrub', () => {
  const markup = domText('dialog-01.html');
  const handle = /@(user_[a-z]\d+)/.exec(markup)?.[1] as string;
  const record = scrubbedCapture({ ...RAW, username: handle, markup, structural: null });
  expect(record.markup).not.toContain(handle);
  expect(record.markup).toContain('Cancel');
});

test('the default capture keeps each layer once, in the durable log, and writes nothing below info', () => {
  const lines: Array<[string, string]> = [];
  setSink((level, message) => lines.push([level, message]));
  try {
    const capture = logCapture();
    expect(capture.wants('0:2:dialog')).toBe(true);
    capture.save('0:2:dialog', scrubbedCapture(RAW));
    expect(capture.wants('0:2:dialog')).toBe(false);
    expect(lines).toEqual([]);
    setLevel('info');
    logCapture().save('0:2:dialog', scrubbedCapture(RAW));
    expect(lines).toEqual([['info', 'actor: confirm layer captured']]);
  } finally {
    setLevel('error');
    setSink(null);
  }
});

test('NO_CAPTURE keeps nothing', () => {
  expect(NO_CAPTURE.wants('anything')).toBe(false);
});
