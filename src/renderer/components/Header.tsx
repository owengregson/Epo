import { h, Fragment } from 'preact';
import type { BotStatus, Settings } from '../../types';
import type { View } from '../hooks/useBot';

interface Props {
  view: View;
  status: BotStatus;
  settings: Settings;
  onStart: () => void;
  onStop: () => void;
  onScrape: () => void;
}

const titles: Record<View, string> = {
  dashboard: 'Dashboard',
  settings: 'Settings',
  queue: 'Queue',
  log: 'Activity Log',
};

export function Header({ view, status, settings, onStart, onStop, onScrape }: Props) {
  let actions = null;
  if (view === 'dashboard') {
    if (status.running) {
      actions = (
        <button class="btn btn-danger btn-sm" onClick={onStop}>
          <i class="fa-solid fa-stop" /> Stop
        </button>
      );
    } else {
      actions = (
        <>
          <button class="btn btn-secondary btn-sm" onClick={onScrape} disabled={!settings.target}>
            <i class="fa-solid fa-arrows-rotate" /> Scrape
          </button>
          <button class="btn btn-success btn-sm" onClick={onStart} disabled={!settings.target}>
            <i class="fa-solid fa-play" /> Start
          </button>
        </>
      );
    }
  }

  return (
    <div class="content-header">
      <h1>{titles[view]}</h1>
      <div class="content-header-actions">{actions}</div>
    </div>
  );
}
