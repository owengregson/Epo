# 0702 — `node:sqlite` behind a driver port, with a self-test and one fallback

Status: accepted (2026-09-02)

## Context

`better-sqlite3` was Epo's only native dependency, and it dragged a whole
apparatus behind it: `@electron/rebuild`, `@types/better-sqlite3` (v9 typing a
v13 runtime), the `rebuild:electron` / `rebuild:node` scripts prefixing six npm
scripts, a CI rebuild step, an `asarUnpack` entry, and ADR 0503's open question
about whether any of it still does anything. The failure it guards against —
*a packaged build cannot load its addon on a platform nobody tested* — is the
one class of failure in this layer that is unrecoverable in an afternoon.

Node ships `node:sqlite`. Electron 44.1.1 bundles Node 24.19.0, which has it.

## Measured, on this machine, on this repo's own binaries

```
host node 25.6.1                    node:sqlite present, SQLite 3.51.2
ELECTRON_RUN_AS_NODE electron 44.1.1  node 24.19.0, node:sqlite present, SQLite 3.53.3

                       node:sqlite   better-sqlite3
20,000 prepare()             26 ms         43 ms      (electron)
20,000 get() cached stmt     24 ms         16 ms      (electron)
20,000 insert, one tx         9 ms         12 ms      (electron)
```

Everything the store needs works on both: WAL, `synchronous = FULL`,
`foreign_keys = ON`, `user_version` get/set, multi-statement `exec`,
`PRAGMA table_info`, `BEGIN`/`SAVEPOINT`/`ROLLBACK TO`, named and positional
bindings, `iterate()`, and `json_extract` (which `spans.percentile` uses).

`get()` on a cached statement is the one place better-sqlite3 is faster (~8 µs
per 20k calls). Against it: `prepare()` is 1.6× faster, and the driver now
caches statements — which no repo did before — so the hot path does strictly
fewer prepares than it used to.

## Decision

Run on `node:sqlite`, reached only through a ~40-line `SqliteDriver` port
(`src/store/driver/driver.ts`). Four consequences, each deliberate:

**1. The port, not the engine, is what the store knows.** `exec`, `prepare`
(`run`/`get`/`all`/`iterate`, named and positional), `pragma`, `transaction`,
`close`, `path`. Nine repos, the migration runner and the test kit take
`SqliteDriver`; no file above `src/store/driver/` names a vendor type. That is
what makes the fallback one file and the next engine question a non-event.

**2. A boot self-test that REFUSES rather than degrades.** `node:sqlite` is
still marked experimental upstream, which means an Electron major could change
its behaviour with no compile error. A version check would not catch that; a
round trip does. Every open asserts WAL (or `memory`, for `:memory:`),
`synchronous = FULL`, `foreign_keys = ON`, a readable integer `user_version`, a
prepare/bind/write/read-back cycle on a TEMP table, that a miss reads back as
`undefined` rather than a fabricated row, and that a nested rollback spares the
outer transaction. Any failure throws and the handle is closed. **A database
that silently lost durability is worse than one that will not open**, because
the second failure is visible on the first launch.

**3. `transaction()` nests through SAVEPOINTs.** `DatabaseSync` ships no
`transaction()` helper, and Epo needs a reentrant one: `CensusRepo.ingest`
opens a transaction and calls `FollowRecordRepo.upsert`, which opens its own.
`BEGIN IMMEDIATE` at depth 0, `SAVEPOINT epo_spN` below it, `ROLLBACK TO` +
`RELEASE` on an inner throw. ~20 lines we want to own anyway.

**4. One fallback, one file, one env var.** `EPO_SQLITE_DRIVER=better-sqlite3`
selects `src/store/driver/better-sqlite3.ts`, which is `require`d lazily so the
default path never loads the native addon. An unrecognised value THROWS —
silently running a different engine than the operator asked for is precisely
the quiet degradation the self-test exists to prevent. The whole store suite
(115 tests) passes on both engines.

## API differences the port absorbs

| | `better-sqlite3` | `node:sqlite` |
|---|---|---|
| `db.pragma(k, {simple})` | yes | none — `prepare('PRAGMA k').get()` |
| `db.transaction(fn)` | yes, returns a callable | none — savepoint helper |
| `run()` counters | number \| bigint | number |
| missing row | `undefined` | `undefined` (same) |
| named params | bare keys | bare keys (allowed by default) |
| `:memory:` journal | `memory` | `memory` — WAL is a FILE property |
| unknown named param | throws | throws (bind exactly what the SQL uses) |
| `undefined` / `boolean` binding | throws | throws — `sql-values.ts` is why |

`PRAGMA table_info(?)` cannot be parameterised on either; table names are
internal literals from the manifest.

## Consequences

- ADR 0503's open question is answered by removing the thing being rebuilt.
- The following go **at integration**, once the fallback is dropped:
  `better-sqlite3` and `@types/better-sqlite3` from `package.json`, the
  `rebuild:electron` / `rebuild:node` scripts and their six prefixes,
  `@electron/rebuild`, the CI "Rebuild native modules" step, `asarUnpack` and
  `npmRebuild` in `electron-builder.yml`, the `better-sqlite3` entry in Biome's
  `noRestrictedImports`, and `src/store/driver/better-sqlite3.ts` itself. Every
  one of those is annotated in place today.
- Biome's restricted-import rule should be re-pointed at `node:sqlite`, scoped
  to `src/store/driver/**` — the same guarantee, one directory tighter.
- Jest and CI must run on Node ≥ 24 to match Electron's bundled Node.
- Node prints one `ExperimentalWarning` per process for `node:sqlite`. It is
  cosmetic; `NODE_OPTIONS=--no-warnings` on the jest script silences it.

## Alternatives rejected

- **Keep `better-sqlite3`.** Keeps the ABI failure mode and everything ADR 0503
  could not justify, for a `get()` difference measured in microseconds.
- **Swap without a port.** Nine repos would name `DatabaseSync` directly and
  the fallback would be a rewrite rather than a file.
- **Swap without a self-test.** The entire risk of an experimental API is
  behaviour changing silently. Unproven durability is the thing to refuse.
- **`kysely` / `drizzle`** — rejected in ADR 0501 and again in the v4 design;
  the painful statements land in `sql` escape hatches either way.
