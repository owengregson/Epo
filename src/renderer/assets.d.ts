// Ambient declarations for non-TS assets the renderer imports for their
// side effects; esbuild bundles them (CSS graph + data:-URI fonts).
// TypeScript 6 (TS2882) requires an explicit declaration for these imports.
declare module '*.css';
declare module '*.woff2';
declare module '*.woff';
declare module '*.ttf';
