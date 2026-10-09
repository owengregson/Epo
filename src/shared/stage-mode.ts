/**
 * What fills the window region right of the console: the embedded IG tab, the
 * network graph, or the prune screen (both non-'tab' modes hide the native
 * tab view, which keeps running underneath). The shell (main) swaps the view;
 * the renderer asks for the swap — one value type, shared.
 */
export type StageMode = 'tab' | 'graph' | 'prune';
