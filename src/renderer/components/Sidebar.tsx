import { h } from 'preact';
import type { BotStatus } from '../../types';
import type { View } from '../hooks/useBot';

interface Props {
  view: View;
  setView: (v: View) => void;
  status: BotStatus;
}

export function Sidebar({ view, setView, status }: Props) {
  const statusClass = status.busy ? 'busy' : status.running ? 'active' : '';

  const nav = (v: View, icon: string, label: string) => (
    <button class={`nav-item ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
      <i class={`fa-solid ${icon}`} /><span>{label}</span>
    </button>
  );

  return (
    <div class="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-brand-icon"><i class="fa-solid fa-seedling" /></div>
        <span class="sidebar-brand-text">Peanut</span>
        <span class="sidebar-brand-version">v2.0</span>
      </div>
      <div class="sidebar-nav">
        {nav('dashboard', 'fa-gauge-high', 'Dashboard')}
        {nav('settings', 'fa-gear', 'Settings')}
        {nav('queue', 'fa-users', 'Queue')}
        {nav('log', 'fa-terminal', 'Log')}
      </div>
      <div class="sidebar-footer">
        <div class="sidebar-status">
          <span class={`status-dot ${statusClass}`} />
          <span>{status.busy ? 'Working...' : status.running ? 'Running' : 'Stopped'}</span>
        </div>
      </div>
    </div>
  );
}
