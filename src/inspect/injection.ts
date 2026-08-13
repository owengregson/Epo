/**
 * In-page instrumentation for the DOM element inspection harness.
 *
 * Everything here is emitted as SOURCE STRINGS that `InstagramTab.evaluate`
 * runs inside the Instagram page context. The strings are hand-written (not a
 * serialized function) so the runtime code stays plain ES5-ish JS that runs in
 * any page state, survives IG's SPA re-renders, and never depends on our TS
 * lexical scope. Keep it dependency-free and defensive: it must never throw in
 * a way that breaks the page.
 *
 * Two concerns:
 *   1. INSTALL — idempotently attach a capture-phase click recorder plus a
 *      floating mode toggle and a top instruction banner. Guarded by
 *      `window.__epoInspectInstalled` so it re-installs after a full page
 *      navigation, and re-injects the UI each tick if IG wiped it.
 *   2. DRAIN — splice out the records buffered since the last tick and return
 *      them to the Node side for logging + persistence.
 *
 * The `buildInspectTickScript` output does BOTH per tick (install-if-missing,
 * then drain-and-return), so one `evaluate` call per poll is enough.
 */

/** One captured ancestor in a record's chain (nearest-first, up to 8 deep). */
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

/**
 * The on-tab instruction banner. Verbatim wording the user reads while
 * clicking, per the harness spec.
 */
export const INSPECT_BANNER_TEXT =
  "EPO INSPECT — click any element to capture it for the developer. " +
  "Default RECORD-ONLY: the click is intercepted, nothing happens (safe). " +
  "Toggle PASS-THROUGH (bottom-right) only when you must open a menu/dialog first. " +
  "Please click, in RECORD-ONLY: (1) the 'followers' count on a profile, " +
  "(2) a Follow button, (3) a Following button, " +
  "(4) 'Unfollow' inside the confirm menu (open the menu in PASS-THROUGH first). " +
  "Saved to docs/adapter/inspect/clicks.jsonl.";

/**
 * A lightweight, pre-login banner (pointer-events:none, no click interception).
 * Used before the instrumentation is installed so the user can still log in.
 */
export function buildPreLoginBannerScript(text: string): string {
  return `(function () {
    try {
      var id = '__epo_inspect_prelogin';
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.setAttribute('data-epo-inspect', '1');
        el.style.cssText = [
          'position:fixed','top:0','left:0','right:0','z-index:2147483647',
          'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
          'background:rgba(14,14,16,0.92)','color:#f5f5f7','padding:6px 12px',
          'border-bottom:1px solid #333','pointer-events:none','letter-spacing:0.2px'
        ].join(';');
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = ${JSON.stringify(`Epo inspect: ${text}`)};
      return true;
    } catch (e) { return false; }
  })()`;
}

/**
 * Build the per-tick script: install instrumentation if absent, refresh the
 * injected UI, then splice-and-return the buffered records.
 *
 * The returned string is an IIFE whose completion value is `InspectRecord[]`.
 */
export function buildInspectTickScript(bannerText: string): string {
  const bannerJson = JSON.stringify(bannerText);
  return `(function () {
    try {
      var PREFIX = '__epo_inspect_';

      // --- INSTALL (once per page document) -------------------------------
      if (!window.__epoInspectInstalled) {
        window.__epoInspectRecords = [];
        window.__epoInspectMode = 'record-only';

        var isOwnUi = function (node) {
          var n = node;
          while (n && n.nodeType) {
            if (n.id && String(n.id).indexOf(PREFIX) === 0) return true;
            if (n.getAttribute && n.getAttribute('data-epo-inspect')) return true;
            n = n.parentNode;
          }
          return false;
        };

        var truncate = function (s, n) {
          s = (s === null || s === undefined) ? '' : String(s);
          return s.length > n ? s.slice(0, n) : s;
        };

        var describeAncestor = function (node) {
          var tag = (node.tagName || '').toLowerCase();
          var role = node.getAttribute ? (node.getAttribute('role') || '') : '';
          return {
            tag: tag,
            id: node.id || '',
            role: role,
            ariaLabel: (node.getAttribute && node.getAttribute('aria-label')) || '',
            href: (node.getAttribute && node.getAttribute('href')) || '',
            classCount: node.classList ? node.classList.length : 0,
            isButtonish: tag === 'a' || tag === 'button' || role === 'button' || role === 'link'
          };
        };

        var buildRecord = function (el) {
          var tag = (el.tagName || '').toLowerCase();
          var attrs = {};
          if (el.attributes) {
            for (var i = 0; i < el.attributes.length; i++) {
              var a = el.attributes[i];
              attrs[a.name] = a.value;
            }
          }
          var dataset = {};
          if (el.dataset) {
            for (var k in el.dataset) {
              if (Object.prototype.hasOwnProperty.call(el.dataset, k)) dataset[k] = el.dataset[k];
            }
          }
          var classes = [];
          if (el.classList) {
            for (var c = 0; c < el.classList.length; c++) classes.push(el.classList[c]);
          }
          var role = el.getAttribute ? (el.getAttribute('role') || '') : '';
          var ancestors = [];
          var p = el.parentElement;
          var depth = 0;
          while (p && depth < 8) {
            ancestors.push(describeAncestor(p));
            p = p.parentElement;
            depth++;
          }
          return {
            tag: tag,
            id: el.id || '',
            classes: classes,
            attributes: attrs,
            text: truncate((el.textContent || '').trim(), 120),
            href: (el.getAttribute && el.getAttribute('href')) || '',
            role: role,
            ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || '',
            type: (el.getAttribute && el.getAttribute('type')) || '',
            dataset: dataset,
            outerHTML: truncate(el.outerHTML || '', 400),
            ancestors: ancestors,
            url: location.href,
            ts: new Date().toISOString()
          };
        };

        var handler = function (event) {
          var el = null;
          if (typeof event.composedPath === 'function') {
            var path = event.composedPath();
            if (path && path.length) el = path[0];
          }
          if (!el) el = event.target;
          if (el && el.nodeType !== 1) el = el.parentElement;
          if (!el || el.nodeType !== 1) return;
          if (isOwnUi(el)) return; // never capture or intercept our own UI
          try {
            window.__epoInspectRecords.push(buildRecord(el));
          } catch (e) {
            window.__epoInspectRecords.push({
              tag: '', id: '', classes: [], attributes: {}, text: '', href: '',
              role: '', ariaLabel: '', type: '', dataset: {}, outerHTML: '',
              ancestors: [], url: location.href, ts: new Date().toISOString(),
              error: String(e)
            });
          }
          if (window.__epoInspectMode === 'record-only') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
          }
        };
        document.addEventListener('click', handler, true);

        window.__epoInspectInstalled = true;
      }

      // --- UI (re)injection (survives IG SPA re-renders) ------------------
      var setToggleLabel = function (btn) {
        if (window.__epoInspectMode === 'pass-through') {
          btn.textContent = 'MODE: PASS-THROUGH';
          btn.style.background = '#b45309';
        } else {
          btn.textContent = 'MODE: RECORD-ONLY';
          btn.style.background = '#15803d';
        }
      };

      var bannerId = PREFIX + 'banner';
      var banner = document.getElementById(bannerId);
      if (!banner) {
        banner = document.createElement('div');
        banner.id = bannerId;
        banner.setAttribute('data-epo-inspect', '1');
        banner.style.cssText = [
          'position:fixed','top:0','left:0','right:0','z-index:2147483647',
          'font:600 12px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
          'background:rgba(14,14,16,0.94)','color:#f5f5f7','padding:7px 14px',
          'border-bottom:1px solid #333','pointer-events:none','letter-spacing:0.2px'
        ].join(';');
        (document.body || document.documentElement).appendChild(banner);
      }
      banner.textContent = ${bannerJson};

      var toggleId = PREFIX + 'toggle';
      var toggle = document.getElementById(toggleId);
      if (!toggle) {
        toggle = document.createElement('button');
        toggle.id = toggleId;
        toggle.type = 'button';
        toggle.setAttribute('data-epo-inspect', '1');
        toggle.style.cssText = [
          'position:fixed','bottom:16px','right:16px','z-index:2147483647',
          'font:700 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
          'color:#fff','border:none','border-radius:8px','padding:10px 14px',
          'cursor:pointer','box-shadow:0 2px 10px rgba(0,0,0,0.4)','pointer-events:auto',
          'letter-spacing:0.3px'
        ].join(';');
        toggle.addEventListener('click', function (ev) {
          ev.stopPropagation();
          window.__epoInspectMode =
            window.__epoInspectMode === 'record-only' ? 'pass-through' : 'record-only';
          setToggleLabel(toggle);
        }, false);
        (document.body || document.documentElement).appendChild(toggle);
      }
      setToggleLabel(toggle);

      // --- DRAIN ----------------------------------------------------------
      var recs = window.__epoInspectRecords.splice(0);
      return recs;
    } catch (e) {
      return [{
        tag: '', id: '', classes: [], attributes: {}, text: '', href: '',
        role: '', ariaLabel: '', type: '', dataset: {}, outerHTML: '',
        ancestors: [], url: (typeof location !== 'undefined' ? location.href : ''),
        ts: new Date().toISOString(), error: String(e)
      }];
    }
  })()`;
}
