/**
 * Read-only page probes: is the list modal up, and what does the page SAY.
 */

export interface DialogCfg {
  sel: string;
}

export interface BlockTextCfg {
  /** Dialog / alert containers — where a block interstitial renders. */
  containerSel: string;
  /** Top-level headings — where one that takes over the page renders. */
  headingSel: string;
}

/** Whether the list modal is on screen. */
export function dialogPresent(cfg: DialogCfg): { present: boolean } {
  return { present: !!document.querySelector(cfg.sel) };
}

/**
 * The page's block-relevant text.
 *
 * NOT the whole body: during actions the tab sits on a CANDIDATE's profile,
 * whose bio, captions and comments are stranger-controlled text — a bio saying
 * "try again later" would otherwise halt the engine permanently. Block
 * interstitials render as dialogs/alerts or headline the page, so only those
 * containers are read.
 */
export function blockText(cfg: BlockTextCfg): string {
  const parts: string[] = [];
  const push = (el: Element): void => {
    const text = (el as HTMLElement).innerText;
    if (text) parts.push(text);
  };
  for (const el of Array.from(document.querySelectorAll(cfg.containerSel))) push(el);
  for (const el of Array.from(document.querySelectorAll(cfg.headingSel))) push(el);
  return parts.join('\n');
}
