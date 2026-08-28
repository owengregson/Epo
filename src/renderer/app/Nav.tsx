/** @jsx h */
import { h } from 'preact';
import type { ViewKey } from '../hooks/useView';
import { Icon } from '../ui/Icon';

const ITEMS: ReadonlyArray<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: 'gauge-high', label: 'Overview' },
  { key: 'chain', icon: 'link', label: 'Targets' },
  { key: 'queues', icon: 'layer-group', label: 'Queues' },
  { key: 'settings', icon: 'sliders', label: 'Settings' },
];

/** Platform modifier for the ⌘/Ctrl+1–4 shortcut hints (matches tour copy). */
const MOD =
  typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';

export interface NavProps {
  current: ViewKey;
  onGo(key: ViewKey): void;
}

/** The four-way view rail (Prune lives on the stage bar). Icon-only when the
 * console is very narrow (CSS). */
export function Nav({ current, onGo }: NavProps): h.JSX.Element {
  return (
    <nav class="nav" aria-label="Console views" data-tour="nav">
      {ITEMS.map((it, i) => (
        <button
          key={it.key}
          type="button"
          class={it.key === current ? 'active' : undefined}
          data-view={it.key}
          data-tip={`${it.label} · ${MOD}${i + 1}`}
          aria-current={it.key === current ? 'page' : undefined}
          aria-label={it.label}
          onClick={() => onGo(it.key)}
        >
          <Icon name={it.icon} />
          <span class="nlabel">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
