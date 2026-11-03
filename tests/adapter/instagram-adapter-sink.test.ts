/**
 * The production surface sink reaches the Actor (the confirm flow's hand-off): an unrecognized confirm
 * layer is reported to the sink the composition root passes, and nowhere when none is passed.
 */
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { MemorySink, NO_SINK } from '@/surface/sink';

const tab = {} as unknown as ConstructorParameters<typeof InstagramAdapter>[0];
const interactor = {} as unknown as ConstructorParameters<typeof InstagramAdapter>[1]['interactor'];
const sinkOf = (adapter: InstagramAdapter): unknown => (adapter.actor as unknown as { confirm: { sink: unknown } }).confirm.sink;

test('the adapter hands its sink to the Actor; without one the Actor reports nowhere', () => {
  const sink = new MemorySink();
  expect(sinkOf(new InstagramAdapter(tab, { interactor, sink }))).toBe(sink);
  expect(sinkOf(new InstagramAdapter(tab, { interactor }))).toBe(NO_SINK);
});
