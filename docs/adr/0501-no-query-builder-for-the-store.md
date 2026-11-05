# 0501 — A column manifest and repo split, not kysely or drizzle

Status: accepted (2026-09-02)

## Context

`KnowledgeStore` was one 1,614-line class: 64 methods, 12 tables, 72
`db.prepare()` sites. Adding a single column (`bio`) touched ten places, four
of them the same column repeated inside one upsert's `INSERT` list, `VALUES`
list, `ON CONFLICT SET` list and parameter object. TypeScript caught none of
it — a mistyped column name in a SQL string is a runtime error the compiler
cannot see. That is the real cost, and it is exactly what a typed query builder
advertises fixing.

## Decision

No query builder. Instead:

- `src/store/repos/account-columns.ts` declares `ACCOUNT_COLUMNS` once, and the
  upsert's four lists plus its bound parameters are generated from it. A test
  asserts the manifest against `PRAGMA table_info(accounts)`, so a migration
  that adds a column without a manifest entry fails loudly.
- The class became a facade over nine single-table repos under
  `src/store/repos/`, plus `CensusRepo` for the two write paths that genuinely
  span tables. Every public method, signature and return shape is unchanged;
  22 consumers were not touched.

Four things outweighed `kysely` (the closest fit — its `SqliteDialect` wraps
`better-sqlite3` directly, so the driver would not change):

1. **Coverage is worst where the pain is.** `healAbandonedInWindow` composes SQL
   from interpolated fragments around a `COALESCE` and a correlated subquery;
   `netGrowthSeries` is a `UNION ALL`; `graphSourceRows` orders by the
   expression `chain_index IS NULL`. All three land in `` sql`` `` escape
   hatches — you pay for the abstraction and keep the raw strings.
2. **The types are hand-written either way.** Kysely needs a `Database`
   interface you maintain by hand, or `kysely-codegen`: another dependency plus
   a generation step against a live database. That is the manifest above, minus
   a runtime dependency and a rewrite of 72 statements.
3. **Perf is not the motive.** Measured: 20k `db.prepare()` compiles = 78 ms
   (~4 µs each) against 20k `run()` calls on a cached statement = 27 ms —
   ~60 ms across a 5,000-row walk. Prepared-per-call is not a bottleneck, and
   inline SQL at the call site is the most readable thing about these files.
4. **The suite had never type-checked itself** until this same pass. Rewriting
   persistence first would have been backwards.

## Consequences

- `better-sqlite3` stays confined to `src/store/**`, enforced by Biome's
  `noRestrictedImports` with a `src/store/**` override. Every repo lives inside
  that boundary.
- Adding a column is now: a migration, one `ACCOUNT_COLUMNS` line, one field on
  the domain type. The manifest test fails if you forget the middle step.
- Revisit `kysely` only if column drift still bites after this. It should not:
  the accounts upsert was where all four repetitions lived.
