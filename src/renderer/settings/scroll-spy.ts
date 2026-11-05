import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SectionId } from '@/shared/settings-params';

/**
 * The section nearest the top of the stage's scroller, for the rail's current mark. Uses an
 * IntersectionObserver over the section elements; where none exists (jsdom) the first section stays
 * current, which is also what the page shows before any scroll.
 */
export function useScrollSpy(content: RefObject<HTMLElement>, sections: readonly SectionId[]): SectionId | null {
  const [active, setActive] = useState<SectionId | null>(sections[0] ?? null);
  const key = sections.join(',');

  useEffect(() => {
    const host = content.current;
    if (host === null || typeof IntersectionObserver === 'undefined') return;
    const root = host.closest('.stage-view');
    const seen = new Map<string, boolean>();
    const update = (): void => {
      // A short final section cannot reach the top band. At the end of a scrollable page it owns the rail.
      const atBottom = root !== null && root.clientHeight > 0 && root.scrollHeight > root.clientHeight
        && root.scrollHeight - root.scrollTop - root.clientHeight <= 1;
      const current = atBottom ? sections.at(-1) : sections.find((s) => seen.get(s) === true);
      if (current !== undefined) setActive(current);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set((e.target as HTMLElement).dataset.section ?? '', e.isIntersecting);
        update();
      },
      { root, rootMargin: '0px 0px -65% 0px' },
    );
    // Only section owners count; nested panels must not overwrite their parent's intersection state.
    for (const el of host.querySelectorAll<HTMLElement>(':scope > [data-section]')) io.observe(el);
    root?.addEventListener('scroll', update, { passive: true });
    return () => {
      io.disconnect();
      root?.removeEventListener('scroll', update);
    };
  }, [content, key]);

  return sections.includes(active as SectionId) ? active : (sections[0] ?? null);
}
