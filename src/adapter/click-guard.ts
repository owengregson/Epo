import { AdapterStaleError } from '@/adapter/errors';
import { PAGE_BUNDLE } from '@/adapter/page/bundle.generated';
import type { ClickGuard } from '@/interaction/interactor';
import type { ElementRect, Point } from '@/interaction/motion-profile';
import * as logger from '@/utils/logger';

type Command = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface RemoteResult { result?: { objectId?: string; value?: unknown }; exceptionDetails?: unknown }

/**
 * Hold the original DOM node through travel. A same-position replacement row
 * must not inherit its click. The handle is CDP-owned, never a page expando.
 */
export async function prepareClickGuard(
  command: Command, target: ElementRect, point: Point,
): Promise<ClickGuard> {
  const cfg = { target, point };
  const result = await command('Runtime.evaluate', {
    expression: `(() => { ${PAGE_BUNDLE}; return __epoPage.clickTarget(${JSON.stringify(cfg)}); })()`,
    returnByValue: false,
  }) as RemoteResult;
  const objectId = result.result?.objectId;
  if (result.exceptionDetails || !objectId) {
    throw new AdapterStaleError('input.click', 'control moved, disabled or covered');
  }
  return {
    validate: async () => {
      const checked = await command('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(cfg) { ${PAGE_BUNDLE}; return this.isConnected && __epoPage.clickTarget(cfg) === this; }`,
        arguments: [{ value: cfg }],
        returnByValue: true,
      }) as RemoteResult;
      return !checked.exceptionDetails && checked.result?.value === true;
    },
    dispose: async () => {
      try { await command('Runtime.releaseObject', { objectId }); }
      catch (error) { logger.debug('click target handle released with its old context', { error: String(error) }); }
    },
  };
}
