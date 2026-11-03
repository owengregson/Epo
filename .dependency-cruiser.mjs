/**
 * The layering gate (`npm run boundaries`, ADR 1002).
 *
 * `docs/superpowers/specs/2026-09-02-epo-v4-framework-design.md` §1 states what
 * may import what. Biome's `noRestrictedImports` covers the coarse fences
 * (`better-sqlite3` → `src/store` only); the *layered* ones need a graph, and
 * this is it.
 *
 * Two tiers, deliberately:
 *
 *   error — the half of each §1 rule that already holds today. These can only
 *           be broken by a new import, so they are a real gate from day one.
 *   warn  — the full §1 rule. Each `warn` names the edges that exist today in
 *           its comment; as a wave deletes them the rule is promoted to
 *           `error`. Severity is the migration ledger, and it only ever moves
 *           one way.
 */

import { readFileSync } from 'node:fs';

/**
 * Modules deliberately unwired for now (`tests/tooling/pending-wiring.json`, each
 * naming the stream that wires it): `no-orphans` exceptions until that stream lands.
 * `pending-wiring.test.ts` fails once a listed module gains an importer.
 */
const PENDING_WIRING = JSON.parse(
  readFileSync(new URL('./tests/tooling/pending-wiring.json', import.meta.url), 'utf8'),
).pending.map((entry) => `^${entry.module.replace(/[.]/g, '[.]')}$`);

/** Every layer under `src/`, for allow-list rules that must name the complement. */
const BACKEND = [
  '^src/store',
  '^src/adapter',
  '^src/engine',
  '^src/rim',
  '^src/main',
  '^src/governors',
  '^src/kernel',
  '^src/capture',
  '^src/livetest',
  '^src/inspect',
  '^src/interaction',
];

export default {
  forbidden: [
    // ---------------------------------------------------------------- cycles
    {
      name: 'no-circular',
      comment:
        'A module cycle means neither module can be understood, tested, or moved alone. ' +
        'Existing cycles are listed in the wave-A report; break one per wave.',
      severity: 'warn',
      from: {},
      to: { circular: true },
    },

    // --------------------------------------------------------------- orphans
    {
      name: 'no-orphans',
      comment:
        'A module nothing imports is either dead or an undeclared entry point. Entry points are ' +
        'allow-listed below; everything else should be reachable or deleted (see `npm run knip`).',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '[.]d[.]ts$',
          // The kernel is landed BEFORE its consumers by design (spec §9, wave A:
          // "No consumers yet"). Drop this line once wave B wires it up.
          '^src/kernel/',
          '^src/main/(main|preload)[.]ts$',
          '^src/capture/capture-main[.]ts$',
          '^src/livetest/livetest-main[.]ts$',
          '^src/inspect/inspect-main[.]ts$',
          '^src/renderer/index[.]tsx$',
          '^src/adapter/page/index[.]ts$',
          '^src/tools/',
          ...PENDING_WIRING,
        ],
      },
      to: {},
    },

    // ---------------------------------------------------------------- kernel
    {
      name: 'kernel-imports-nothing',
      comment:
        '§1: the kernel IS the graph, not a node in it. It may import Node builtins and its own ' +
        'siblings — nothing else under src/.',
      severity: 'error',
      from: { path: '^src/kernel' },
      to: { path: '^src/', pathNot: '^src/kernel' },
    },

    // -------------------------------------------------------------- renderer
    {
      name: 'renderer-must-not-reach-backend',
      comment:
        '§1: the renderer is a sandboxed view. Every backend fact arrives over the IPC contract, ' +
        'never by importing the store, the adapter, an engine or the main process.',
      severity: 'error',
      from: { path: '^src/renderer' },
      to: { path: BACKEND },
    },
    {
      name: 'renderer-allow-list',
      comment:
        '§1 in full: renderer → shared, ipc contract, renderer. Today it also reaches src/types.ts ' +
        '(58 imports), src/timing/config (5) and src/settings (1). Promote to error once the ' +
        'shared/ types split lands.',
      severity: 'warn',
      from: { path: '^src/renderer' },
      to: {
        path: '^src/',
        pathNot: ['^src/renderer', '^src/shared', '^src/ipc/contract[.]ts$'],
      },
    },

    // ---------------------------------------------------------------- engine
    {
      name: 'engine-must-not-reach-shell',
      comment: '§1: an engine is driven by the shell; it never imports it, and never a view.',
      severity: 'error',
      from: { path: '^src/engine' },
      to: { path: ['^src/main', '^src/renderer'] },
    },
    {
      name: 'engine-must-not-reach-adapter',
      comment:
        '§1: engines speak to Instagram through the rim ports only. Today five engine modules ' +
        'import src/adapter directly. Promote to error when those move behind a port.',
      severity: 'warn',
      from: { path: '^src/engine' },
      to: { path: '^src/adapter' },
    },

    // --------------------------------------------------------------- adapter
    {
      name: 'adapter-must-not-reach-engine-or-shell',
      comment:
        '§1: the adapter is the versioned Instagram document plus a tab. It knows nothing about ' +
        'policy (engine) or process lifetime (main).',
      severity: 'error',
      from: { path: '^src/adapter' },
      to: { path: ['^src/engine', '^src/main'] },
    },
    {
      name: 'adapter-must-not-reach-store',
      comment:
        '§1: facts stream OUT of the adapter as values; persistence is the rim/engine side. Today ' +
        'three adapter modules import src/store. Promote to error when those invert.',
      severity: 'warn',
      from: { path: '^src/adapter' },
      to: { path: '^src/store' },
    },

    // ----------------------------------------------------------------- store
    {
      name: 'store-must-not-reach-upward',
      comment:
        '§1: SQL lives only in the store, and the store depends on nothing above it. Anything the ' +
        'store needs from a caller arrives as an argument.',
      severity: 'error',
      from: { path: '^src/store' },
      to: {
        path: [
          '^src/adapter',
          '^src/engine',
          '^src/rim',
          '^src/main',
          '^src/renderer',
          '^src/ipc',
          '^src/settings',
          '^src/interaction',
        ],
      },
    },
    {
      name: 'store-allow-list',
      comment:
        '§1 in full: store → shared, governors, store. Today it also reaches src/timing (2) and ' +
        'src/utils (5). Promote to error once those two are shared/ or injected.',
      severity: 'warn',
      from: { path: '^src/store' },
      to: {
        path: '^src/',
        pathNot: ['^src/store', '^src/shared', '^src/governors'],
      },
    },

    // ------------------------------------------------------------ hygiene
    {
      name: 'no-dev-dep-in-src',
      comment:
        'A devDependency imported from src/ ships broken or not at all. `electron` is the ' +
        'exception on purpose: it is a devDependency because the RUNTIME provides it (esbuild ' +
        'marks it external), so importing it from main/ and adapter/tab.ts is correct.',
      severity: 'error',
      from: { path: '^src/', pathNot: '[.]test[.]tsx?$' },
      to: { dependencyTypes: ['npm-dev'], pathNot: '^node_modules/electron(/|$)' },
    },
    {
      name: 'not-to-deprecated-core',
      comment: 'Deprecated Node core modules have supported replacements.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['core'], path: ['^(punycode|domain|constants|sys|_.*)$'] },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // Generated artifacts are outputs, not authored modules.
    exclude: { path: '[.]generated[.]ts$' },
    // Type-only imports are boundary crossings too: a renderer that imports a
    // store row type is still coupled to the store's shape.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
