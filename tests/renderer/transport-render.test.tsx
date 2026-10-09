/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * The transport trio is the state readout: which buttons are live, what they
 * are labelled, and — while a prune holds the tab — which driver they address.
 */
import { fireEvent, render, screen } from '@testing-library/preact';
import { Transport, type TransportProps } from '@/renderer/app/Transport';

const props = (over: Partial<TransportProps> = {}): TransportProps => ({
  state: 'idle',
  driver: 'growth',
  pruneScanning: false,
  pending: null,
  onStart: () => {},
  onPauseResume: () => {},
  onCancel: () => {},
  ...over,
});

const btn = (id: string): HTMLButtonElement =>
  document.getElementById(id) as HTMLButtonElement;

describe('Transport — enablement follows the unified state', () => {
  it('idle: only Start is live', () => {
    render(<Transport {...props()} />);
    expect(btn('btnStart').disabled).toBe(false);
    expect(btn('btnPause').disabled).toBe(true);
    expect(btn('btnStop').disabled).toBe(true);
  });

  it('running: Start locks, Pause and Cancel open', () => {
    render(<Transport {...props({ state: 'running' })} />);
    expect(btn('btnStart').disabled).toBe(true);
    expect(btn('btnPause').disabled).toBe(false);
    expect(btn('btnStop').disabled).toBe(false);
  });

  it('paused: the Start button becomes Resume and routes to pause/resume', () => {
    let resumed = 0;
    let started = 0;
    render(
      <Transport
        {...props({ state: 'paused', onPauseResume: () => resumed++, onStart: () => started++ })}
      />,
    );
    screen.getByText('Resume');
    fireEvent.click(btn('btnStart'));
    expect([resumed, started]).toEqual([1, 0]);
  });

  it('a prune scan locks Pause (no between-action boundary) but leaves Cancel', () => {
    render(
      <Transport {...props({ state: 'running', driver: 'prune', pruneScanning: true })} />,
    );
    expect(btn('btnPause').disabled).toBe(true);
    expect(btn('btnStop').disabled).toBe(false);
    expect(btn('btnPause').title).toBe('A scan stops clean — use Cancel');
  });

  it('a prune driver retitles the trio so the buttons say whose run they end', () => {
    render(<Transport {...props({ state: 'running', driver: 'prune' })} />);
    expect(btn('btnStop').title).toBe('Stop the prune');
    expect(btn('btnPause').title).toBe('Pause the prune after the current unfollow');
  });

  it('a pending control disables the whole trio and spins its own glyph', () => {
    render(<Transport {...props({ state: 'running', pending: 'stop' })} />);
    expect(btn('btnStop').disabled).toBe(true);
    expect(btn('btnPause').disabled).toBe(true);
    expect(btn('btnStop').querySelector('.icon-spin')).not.toBeNull();
  });
});
