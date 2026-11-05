import { PAGE_BUNDLE } from '@/adapter/page/bundle.generated';
import { jsonForScript } from '@/shared/script-json';

/** Each read owns its helpers; it must not overwrite or publish page globals. */
export const pageCall = (fn: string, cfg: unknown): string =>
  `(() => { ${PAGE_BUNDLE}; return __epoPage.${fn}(${jsonForScript(cfg)}); })()`;
