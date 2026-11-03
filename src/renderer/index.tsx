import { render } from 'preact';
import './styles/index.css';
import { App } from '@/renderer/app/App';
import { BootGate } from '@/renderer/boot/BootGate';
import { DiagnosticsPanel } from '@/renderer/diagnostics/DiagnosticsPanel';
import { diagnosticsPanelSlot } from '@/renderer/settings/diagnostics-slot';

const root = document.getElementById('app');
if (root) {
  // Settings › Advanced › Diagnostics shows the log panel in its slot (in the app and in the gallery).
  diagnosticsPanelSlot.value = DiagnosticsPanel;
  // `?gallery=1` mounts the dev component gallery instead of the shell (ADR
  // 1006). The import is dynamic so the gallery's module graph — its fixtures
  // included — is only EVALUATED behind the flag; esbuild inlines the chunk
  // (the bundle is not split), which costs ~13 KB and buys the same CSP, the
  // same tokens and the same cascade as the app for zero new dependencies.
  if (new URLSearchParams(window.location.search).get('gallery') === '1') {
    // The gallery has no launch to wait for: the splash goes at once.
    document.getElementById('boot')?.remove();
    void import('@/renderer/gallery/Gallery').then(({ Gallery, primeGallery }) => {
      primeGallery();
      render(<Gallery />, root);
    });
  } else {
    // The app renders under the splash; the gate plays the intro once everything is ready.
    render(
      <BootGate>
        <App />
      </BootGate>,
      root,
    );
  }
}
