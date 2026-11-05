# 0703 — One table manifest; row types, upserts, DDL and the shape check derive from it

Status: accepted (2026-09-02)

## Context

`ACCOUNT_COLUMNS` already proved the idea on one table. Before it, four lists
had to agree by hand — the `INSERT` column list, the `VALUES` list, the
`ON CONFLICT … SET` list, and the bound parameters — and a test asserted the
array against `PRAGMA table_info(accounts)`.

It covered one of twelve tables. The other eleven had hand-written row
interfaces in `rows.ts`, hand-written upserts in their repos, and no shape
assertion at all — so a migration that added a column without touching the row
interface failed at whatever read first met the unknown shape, which on a
streaming hot path means "during a scan, on a user's machine".

## Decision

One manifest, `src/store/schema/tables.ts`, declaring every column of every
table once: SQL type, nullability, primary-key position, default literal, and
the SQLite⇄domain codec. Four things derive from it, and nothing else may
restate them:

- **Row and value types.** `RowOf<typeof ACCOUNTS>` is the raw `SELECT *`
  shape; `ValuesOf<typeof ACCOUNTS>` is the same row after the codecs. Nullable
  columns carry `T | null` or, via `.opt()`, the `T | undefined` the domain
  uses — the `sql-values.ts` rules, expressed in the type rather than remembered
  at each call site.
- **Upsert fragments.** `upsertSql(t, { columns, conflict, expr, tail })`. `expr`
  overrides one column's SET right-hand side, which is how the `COALESCE` and
  `MIN` defenses stop being folds hand-inlined into SQL where no test can see
  them. `tail` appends verbatim clauses — reserved for POLICY, like the
  enrichment-failure heal, which is not a column mapping and should not look
  like one.
- **`CREATE TABLE` for a NEW table.** `ddl(t)` generated migration 12's `timers`
  and `spans`.
- **A boot-time shape assertion over ALL tables.** `assertSchema(db)` runs after
  the migrations on every open and compares name, type, `notnull`, default and
  pk position for all fourteen tables. Drift throws at open, naming the table,
  the column and the field.

**ALTER migrations stay hand-written.** `ddl()` is for new tables only. The SQL
that changes an existing table is where intent lives, it is append-only
(ADR 0502), and generating it would let an edit to a def silently rewrite
history a live install already ran.

**Generated DDL is frozen once shipped.** A test pins the exact text of
`ddl(TIMERS)` and `ddl(SPANS)` and asserts migration 12 contains it. Changing a
def so that test fails means writing a new ALTER migration — the failure IS the
reminder.

One SQLite quirk is folded into `table()` rather than special-cased twice: a
single-column key declared inline (`TEXT PRIMARY KEY`) is reported by
`PRAGMA table_info` as **nullable**, while a composite key is a table
constraint over columns carrying their own `NOT NULL`. Normalising there means
the declaration is the truth for both `ddl()` and the drift check.

## Consequences

- A migration that adds a column without a manifest entry now fails at open,
  loudly, instead of at the first read that meets it.
- `ACCOUNT_COLUMNS` survives as the *write* mapping only — which part of an
  `AccountState` each column carries, the one thing a table def cannot know.
  The two are cross-checked at module load.
- `rows.ts`'s hand-written interfaces are now redundant with `RowOf<…>` for
  every table. Replacing them is mechanical and touches nine repos, so it is a
  wave-B cleanup, not a wave-A risk.
- The other four hand-written upserts (`edges`, `follow_records`, `targets`,
  `scrape_cursors`) are described and asserted by the manifest but still write
  their own SQL. Moving them onto `upsertSql` + `expr` is wave B, alongside the
  folds that replace those defenses outright.

## Alternatives rejected

- **A query builder / ORM.** Rejected in ADR 0501 and again in the v4 design.
  This is schema-as-code without the runtime: no generated-migration directory
  fighting append-only, no codegen against a live database, no dependency, and
  every `SELECT` stays raw SQL.
- **Keep hand-written row interfaces and add only the assertion.** Catches
  drift, but leaves four lists per table still agreeing by hand — which is the
  defect `ACCOUNT_COLUMNS` was written to remove.
- **Generate ALTER migrations too.** Directly contradicts ADR 0502.
