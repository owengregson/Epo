import { render } from 'preact';
import './styles/index.css';
import { App } from '@/renderer/app/App';

const root = document.getElementById('app');
if (root) {
  // `?gallery=1` mounts the dev component gallery instead of the shell (ADR
  // 1006). The import is dynamic so the gallery's module graph — its fixtures
  // included — is only EVALUATED behind the flag; esbuild inlines the chunk
  // (the bundle is not split), which costs ~13 KB and buys the same CSP, the
  // same tokens and the same cascade as the app for zero new dependencies.
  if (new URLSearchParams(window.location.search).get('gallery') === '1') {
    void import('@/renderer/gallery/Gallery').then(({ Gallery, primeGallery }) => {
      primeGallery();
      render(<Gallery />, root);
    });
  } else {
    render(<App />, root);
  }
}
