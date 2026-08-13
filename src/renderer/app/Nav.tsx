/** @jsx h */
import { h } from 'preact';
import { Icon } from '../ui/Icon';
import type { ViewKey } from '../hooks/useView';

const ITEMS: ReadonlyArray<{ key: ViewKey; icon: string; label: string }> = [
  { key: 'overview', icon: 'gauge-high', label: 'Overview' },
  { key: 'chain', icon: 'link', label: 'Chain' },
  { key: 'queues', icon: 'layer-group', label: 'Queues' },
  { key: 'prune', icon: 'user-minus', label: 'Prune' },
  { key: 'settings', icon: 'sliders', label: 'Settings' },
];

export interface NavProps {
  current: ViewKey;
  onGo(key: ViewKey): void;
}

/** The five-way view rail. Icon-only when the console is very narrow (CSS). */
export function Nav({ current, onGo }: NavProps): h.JSX.Element {
  return (
    <nav class="nav" aria-label="Console views">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          class={it.key === current ? 'active' : undefined}
          data-view={it.key}
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
