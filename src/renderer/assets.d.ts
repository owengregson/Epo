// Ambient declaration for the stylesheet the renderer entry imports for its
// side effect; esbuild bundles the CSS graph.
// TypeScript 6 (TS2882) requires an explicit declaration for this import.
declare module '*.css';
