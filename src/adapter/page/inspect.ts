/**
 * In-page instrumentation for the DOM inspection harness (`surface-lab inspect`).
 *
 * This was the LAST hand-written ES5 injection string in the repo — 200 lines
 * of JavaScript inside a template literal that `tsc` saw as text, Biome saw as
 * text, and no test ever ran against a DOM. It is now real TypeScript in the
 * page bundle like every other page script (ADR 0301): the harness that exists
 * to find drift can no longer BE the drift.
 *
 * One tick does both concerns — INSTALL the capture-phase click recorder (plus
 * the mode toggle and banner, re-injected every tick because the SPA wipes
 * them) and DRAIN the records buffered since the last one.
 *
 * Safe by default: in `record-only` every click is intercepted, so NOTHING
 * happens — no navigation, no real follow/unfollow. The toggle switches to
 * `pass-through` when a real click is needed first (opening the unfollow menu).
 *
 * Carries ZERO Instagram literals: the banner text and the element-id prefix
 * arrive in the config, like every other page script.
 */

/** One captured ancestor in a record's chain (nearest-first). */
export interface InspectAncestor {
  tag: string;
  id: string;
  role: string;
  ariaLabel: string;
  href: string;
  classCount: number;
  isButtonish: boolean;
}

/** A single clicked-element capture, as produced in-page and drained to Node. */
export interface InspectRecord {
  tag: string;
  id: string;
  classes: string[];
  attributes: Record<string, string>;
  text: string;
  href: string;
  role: string;
  ariaLabel: string;
  type: string;
  dataset: Record<string, string>;
  outerHTML: string;
  ancestors: InspectAncestor[];
  url: string;
  ts: string;
  /** Present only if building the record itself threw in-page. */
  error?: string;
}

export interface InspectCfg {
  /** The instruction banner's text. */
  banner: string;
  /** Element-id prefix for the harness's own UI (never captured or intercepted). */
  prefix: string;
  /** How deep the ancestor chain goes. */
  maxDepth: number;
  /** Text and outerHTML truncation lengths. */
  maxText: number;
  maxHtml: number;
}

/** The banner-only config, used before login while the page must stay usable. */
export interface InspectBannerCfg {
  banner: string;
  prefix: string;
}

type InspectMode = 'record-only' | 'pass-through';

interface InspectWindow extends Window {
  __epoInspectInstalled?: boolean;
  __epoInspectRecords?: InspectRecord[];
  __epoInspectMode?: InspectMode;
  /** The live capture handler, kept so a re-install can REMOVE it first. */
  __epoInspectHandler?: (event: Event) => void;
}

const win = (): InspectWindow => window as InspectWindow;

const attr = (el: Element, name: string): string => el.getAttribute(name) ?? '';

const truncate = (value: string | null | undefined, max: number): string => {
  const s = value ?? '';
  return s.length > max ? s.slice(0, max) : s;
};

const emptyRecord = (error: string): InspectRecord => ({
  tag: '',
  id: '',
  classes: [],
  attributes: {},
  text: '',
  href: '',
  role: '',
  ariaLabel: '',
  type: '',
  dataset: {},
  outerHTML: '',
  ancestors: [],
  url: typeof location === 'undefined' ? '' : location.href,
  ts: new Date().toISOString(),
  error,
});

const describeAncestor = (node: Element): InspectAncestor => {
  const tag = (node.tagName || '').toLowerCase();
  const role = attr(node, 'role');
  return {
    tag,
    id: node.id || '',
    role,
    ariaLabel: attr(node, 'aria-label'),
    href: attr(node, 'href'),
    classCount: node.classList ? node.classList.length : 0,
    isButtonish: tag === 'a' || tag === 'button' || role === 'button' || role === 'link',
  };
};

/** Build one capture record from a clicked element. Exported for the DOM tests. */
export function buildRecord(el: Element, cfg: InspectCfg): InspectRecord {
  const attributes: Record<string, string> = {};
  for (const a of Array.from(el.attributes ?? [])) attributes[a.name] = a.value;

  const dataset: Record<string, string> = {};
  const data = (el as HTMLElement).dataset;
  if (data) {
    for (const key of Object.keys(data)) dataset[key] = data[key] ?? '';
  }

  const ancestors: InspectAncestor[] = [];
  let parent = el.parentElement;
  for (let depth = 0; parent && depth < cfg.maxDepth; depth++) {
    ancestors.push(describeAncestor(parent));
    parent = parent.parentElement;
  }

  return {
    tag: (el.tagName || '').toLowerCase(),
    id: el.id || '',
    classes: el.classList ? Array.from(el.classList) : [],
    attributes,
    text: truncate((el.textContent || '').trim(), cfg.maxText),
    href: attr(el, 'href'),
    role: attr(el, 'role'),
    ariaLabel: attr(el, 'aria-label'),
    type: attr(el, 'type'),
    dataset,
    outerHTML: truncate(el.outerHTML || '', cfg.maxHtml),
    ancestors,
    url: location.href,
    ts: new Date().toISOString(),
  };
}

/** Whether `node` is (inside) the harness's own UI — never captured or intercepted. */
const isOwnUi = (node: Node | null, prefix: string): boolean => {
  let current: Node | null = node;
  while (current) {
    const el = current as Element;
    if (el.id && String(el.id).indexOf(prefix) === 0) return true;
    if (el.getAttribute?.('data-epo-inspect')) return true;
    current = current.parentNode;
  }
  return false;
};

const BANNER_STYLE = [
  'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
  'font:600 12px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  'background:rgba(14,14,16,0.94)', 'color:#f5f5f7', 'padding:7px 14px',
  'border-bottom:1px solid #333', 'pointer-events:none', 'letter-spacing:0.2px',
].join(';');

const TOGGLE_STYLE = [
  'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
  'font:700 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
  'color:#fff', 'border:none', 'border-radius:8px', 'padding:10px 14px',
  'cursor:pointer', 'box-shadow:0 2px 10px rgba(0,0,0,0.4)', 'pointer-events:auto',
  'letter-spacing:0.3px',
].join(';');

const host = (): Element => document.body || document.documentElement;

/**
 * Build one of the harness's element ids. `concat` rather than interpolation:
 * this module is minified VERBATIM into `bundle.generated.ts`, where a `${…}`
 * inside the bundle string reads as an accidental template placeholder.
 */
const elementId = (prefix: string, name: string): string => prefix.concat(name);

/**
 * A pre-login banner with `pointer-events:none` and NO click interception — the
 * login form has to keep working before the harness may take over the page.
 */
export function inspectBanner(cfg: InspectBannerCfg): boolean {
  try {
    const id = elementId(cfg.prefix, 'prelogin');
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('data-epo-inspect', '1');
      el.style.cssText = BANNER_STYLE;
      host().appendChild(el);
    }
    el.textContent = cfg.banner;
    return true;
  } catch {
    return false;
  }
}

/** Install the instrumentation if absent, refresh the UI, and drain the buffer. */
export function inspectTick(cfg: InspectCfg): InspectRecord[] {
  try {
    const w = win();
    if (!w.__epoInspectInstalled) {
      w.__epoInspectRecords = [];
      w.__epoInspectMode = 'record-only';
      // Remove-then-add, the same discipline the tab uses for its debugger
      // listener: a doubled handler records every click twice, which reads as
      // phantom user activity in the capture log.
      if (w.__epoInspectHandler) {
        document.removeEventListener('click', w.__epoInspectHandler, true);
      }
      const handler = (event: Event): void => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
          let target = (path.length > 0 ? path[0] : event.target) as Node | null;
          if (target?.nodeType !== 1) target = (target as Element | null)?.parentElement ?? null;
          if (target?.nodeType !== 1) return;
          const el = target as Element;
          if (isOwnUi(el, cfg.prefix)) return;
          const records = w.__epoInspectRecords ?? [];
          try {
            records.push(buildRecord(el, cfg));
          } catch (e) {
            records.push(emptyRecord(String(e)));
          }
          if (w.__epoInspectMode === 'record-only') {
            // RECORD-ONLY is the safe default: the click is captured and then
            // stopped dead, so inspecting a Follow button never follows anyone.
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
          }
      };
      w.__epoInspectHandler = handler;
      document.addEventListener('click', handler, true);
      w.__epoInspectInstalled = true;
    }

    // The UI is re-injected every tick: Instagram's SPA re-renders wipe it.
    const bannerId = elementId(cfg.prefix, 'banner');
    let banner = document.getElementById(bannerId);
    if (!banner) {
      banner = document.createElement('div');
      banner.id = bannerId;
      banner.setAttribute('data-epo-inspect', '1');
      banner.style.cssText = BANNER_STYLE;
      host().appendChild(banner);
    }
    banner.textContent = cfg.banner;

    const toggleId = elementId(cfg.prefix, 'toggle');
    let toggle = document.getElementById(toggleId) as HTMLButtonElement | null;
    if (!toggle) {
      toggle = document.createElement('button');
      toggle.id = toggleId;
      toggle.type = 'button';
      toggle.setAttribute('data-epo-inspect', '1');
      toggle.style.cssText = TOGGLE_STYLE;
      toggle.addEventListener('click', (ev: Event) => {
        ev.stopPropagation();
        w.__epoInspectMode = w.__epoInspectMode === 'record-only' ? 'pass-through' : 'record-only';
        setToggleLabel(toggle as HTMLButtonElement, w.__epoInspectMode);
      });
      host().appendChild(toggle);
    }
    setToggleLabel(toggle, w.__epoInspectMode ?? 'record-only');

    return (w.__epoInspectRecords ?? []).splice(0);
  } catch (e) {
    // A throw here would break the page the harness is inspecting; the error is
    // reported as a record instead, so it reaches the log rather than the user.
    return [emptyRecord(String(e))];
  }
}

function setToggleLabel(btn: HTMLButtonElement, mode: InspectMode): void {
  if (mode === 'pass-through') {
    btn.textContent = 'MODE: PASS-THROUGH';
    btn.style.background = '#b45309';
  } else {
    btn.textContent = 'MODE: RECORD-ONLY';
    btn.style.background = '#15803d';
  }
}
