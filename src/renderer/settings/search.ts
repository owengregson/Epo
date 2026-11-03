/**
 * Settings search (spec §6.5): titles, labels, help, options, everyday words and every older-version
 * setting name, over the sections this view shows. Every query word must match; a title match ranks
 * above a word in the help. In Easy, a hit that only Advanced shows says so. Pure.
 */
import { INTENT_ROW_COPY } from '@/renderer/settings/copy/choices';
import type { SectionId } from '@/shared/settings-params';
import type { SettingsView } from '@/shared/settings-view';
import { PARAM_COPY } from './copy/params';
import { SECTION_COPY } from './copy/sections';
import { ROWS, type SearchTarget, SYNONYMS, V1_HOMES, V1_RETIRED } from './search-index';
import { isAdvancedOnly, type SettingsMode, visibleSections } from './sections';

export interface SearchHit {
  readonly target: SearchTarget;
  readonly title: string;
  readonly sectionTitle: string;
  /** Easy is showing and only Advanced has this row. */
  readonly inAdvanced: boolean;
  /** Why an older setting changed, when the hit came from its old name. */
  readonly note?: string;
}

interface Entry {
  readonly target: SearchTarget;
  readonly title: string;
  readonly hay: string;
  readonly names: readonly string[];
  readonly advanced: boolean;
  readonly note?: string;
}

/** Lowercase, accents and punctuation gone, camelCase split: "dailyHardCeiling" → "daily hard ceiling". */
export function fold(text: string): string {
  return text.replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The anchors Easy shows; every other row (each parameter, the Fine-tune and Advanced extras) is Advanced. */
const EASY_ROWS = new Set([
  'pace.cards', 'schedule.shape', 'quietHours', 'daysOff', 'schedule.rhythm', 'seed', 'audience.size', 'audience.focus',
  'preferPrivate', 'acceptRequests', 'patience', 'unfollow.mutuals', 'unfollow.cleanup', 'protection.people',
  'protection.words', 'protection.verified', 'boost.hours', 'boost.acceptRequests', 'practice', 'updates', 'replayTour',
  'reset', 'clearData',
]);
const advancedRow = (t: SearchTarget): boolean => isAdvancedOnly(t.section) || (t.row !== undefined && !EASY_ROWS.has(t.row));

function titleOf(t: SearchTarget, view: SettingsView): string {
  const p = view.params.find((x) => x.key === t.row);
  if (p !== undefined) return PARAM_COPY[p.key].label;
  const row = ROWS.find((r) => r.row === t.row && r.section === t.section);
  if (row !== undefined) return row.title;
  if (t.row?.startsWith('intent:')) return INTENT_ROW_COPY[t.row.slice('intent:'.length) as keyof typeof INTENT_ROW_COPY] ?? SECTION_COPY[t.section].title;
  return SECTION_COPY[t.section].title;
}

function entries(view: SettingsView): Entry[] {
  const out: Entry[] = [];
  const add = (target: SearchTarget, title: string, words: string, names: readonly string[] = [], note?: string): void => {
    out.push({ target, title, hay: fold(`${title} ${words}`), names: names.map(fold), advanced: advancedRow(target), note });
  };
  for (const id of Object.keys(SECTION_COPY) as SectionId[]) {
    const c = SECTION_COPY[id];
    add({ section: id }, c.title, 'question' in c ? c.question : '');
  }
  for (const r of ROWS) add({ section: r.section, row: r.row }, r.title, r.words);
  for (const p of view.params) add({ section: p.section, row: p.key }, PARAM_COPY[p.key].label, `${PARAM_COPY[p.key].help} ${p.key}`);
  for (const key of ['activity', 'caution', 'consistency', 'weeklyShape'] as const) {
    add({ section: key === 'weeklyShape' ? 'schedule' : 'pace', row: `intent:${key}` }, INTENT_ROW_COPY[key], key);
  }
  for (const [name, t] of Object.entries(V1_HOMES)) add(t, titleOf(t, view), '', [name]);
  for (const [name, t] of Object.entries(V1_RETIRED)) add({ section: t.section, row: t.row }, titleOf(t, view), '', [name], t.why);
  for (const [word, t] of SYNONYMS) add(t, titleOf(t, view), '', [word]);
  return out;
}

function score(e: Entry, q: string, words: readonly string[]): number {
  const title = fold(e.title);
  if (e.names.includes(q)) return 90;
  if (title === q) return 100;
  const all = `${e.hay} ${e.names.join(' ')}`;
  if (!words.every((w) => all.split(' ').some((x) => x.startsWith(w)) || all.includes(w))) return 0;
  if (title.startsWith(q)) return 80;
  if (title.includes(q)) return 60;
  if (e.names.some((n) => n.includes(q))) return 50;
  return 20;
}

const MAX_HITS = 8;

/** The rows matching a query, best first, at most a handful; nothing for an empty query. */
export function searchSettings(query: string, view: SettingsView, mode: SettingsMode): SearchHit[] {
  const q = fold(query);
  if (q === '') return [];
  const words = q.split(' ');
  const shown = new Set(visibleSections(view, 'advanced'));
  const order = visibleSections(view, 'advanced');
  const best = new Map<string, { e: Entry; s: number }>();
  for (const e of entries(view)) {
    if (!shown.has(e.target.section)) continue;
    const s = score(e, q, words);
    if (s === 0) continue;
    const id = `${e.target.section}|${e.target.row ?? ''}`;
    const prev = best.get(id);
    if (prev === undefined || s > prev.s || (s === prev.s && e.note !== undefined)) best.set(id, { e, s });
  }
  return [...best.values()]
    .sort((a, b) => b.s - a.s || order.indexOf(a.e.target.section) - order.indexOf(b.e.target.section))
    .slice(0, MAX_HITS)
    .map(({ e }) => ({
      target: e.target, title: e.title, sectionTitle: SECTION_COPY[e.target.section].title,
      inAdvanced: mode === 'easy' && e.advanced, note: e.note,
    }));
}
