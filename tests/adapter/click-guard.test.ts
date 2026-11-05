import { prepareClickGuard } from '@/adapter/click-guard';

const target = { x: 100, y: 100, width: 120, height: 40 };
const point = { x: 160, y: 120 };

test('holds the original node across travel and releases its remote handle', async () => {
  const command = jest.fn()
    .mockResolvedValueOnce({ result: { objectId: 'original-node' } })
    .mockResolvedValueOnce({ result: { value: true } })
    .mockResolvedValueOnce({});
  const guard = await prepareClickGuard(command, target, point);
  await expect(guard.validate()).resolves.toBe(true);
  await guard.dispose();
  expect(command.mock.calls[0][0]).toBe('Runtime.evaluate');
  expect(command.mock.calls[1]).toEqual(['Runtime.callFunctionOn', expect.objectContaining({ objectId: 'original-node' })]);
  expect(command.mock.calls[1][1].functionDeclaration).toContain('=== this');
  expect(command.mock.calls[2]).toEqual(['Runtime.releaseObject', { objectId: 'original-node' }]);
});

test('a replaced node cannot inherit a same-position click', async () => {
  const command = jest.fn().mockResolvedValueOnce({ result: { objectId: 'old' } })
    .mockResolvedValueOnce({ result: { value: false } });
  const guard = await prepareClickGuard(command, target, point);
  await expect(guard.validate()).resolves.toBe(false);
});

test('a missing target never starts cursor travel', async () => {
  const command = jest.fn().mockResolvedValue({ result: { value: null } });
  await expect(prepareClickGuard(command, target, point)).rejects.toThrow('control moved');
  expect(command).toHaveBeenCalledTimes(1);
});
