/**
 * Which Settings sections show (spec §6.3–§6.5): the seven Easy sections in order, then the five
 * Advanced-only ones. A section whose capability is not wired yet stays hidden (Boost until the plan's
 * Boost lands; Timing until the plan-backed tempo). Pure.
 */
import { EASY_SECTIONS, type SectionId } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';

export type SettingsMode = 'easy' | 'advanced';

export const ADVANCED_ONLY = ['timing', 'explore', 'limits', 'technical', 'diagnostics'] as const satisfies readonly SectionId[];

/** The sections on the page for this view and mode, in page order. */
export function visibleSections(view: SettingsView, mode: SettingsMode): SectionId[] {
  const easy = EASY_SECTIONS.filter((s) => s !== 'boost' || view.capabilities.boost);
  if (mode === 'easy') return [...easy];
  return [...easy, ...ADVANCED_ONLY.filter((s) => s !== 'timing' || view.capabilities.tempo)];
}

export function isAdvancedOnly(section: SectionId): boolean {
  return (ADVANCED_ONLY as readonly SectionId[]).includes(section);
}

/** The page element id of a section (the rail, search and deep links scroll to it). */
export const sectionDomId = (section: SectionId): string => `settings-${section}`;

/** Where a deep link lands: a known section id, or null for anything else. */
export function sectionOf(name: string | undefined, view: SettingsView): SectionId | null {
  const all = visibleSections(view, 'advanced');
  return all.find((s) => s === name) ?? null;
}
