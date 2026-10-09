# 0502 — Migrations are data, append-only, and refuse the future

Status: accepted (2026-09-02)

## Context

`MIGRATIONS` was a `string[]`. A migration's number lived only in the comment
above it, and two entries had already lost theirs ("`--- Migration: profile bio
text`"). The binding from "migration N" to "index N" was manual counting, and
nothing checked it. Inserting an entry anywhere but the end, or renumbering one,
would have applied the wrong SQL to the wrong `user_version` silently — on a
user's real database.

## Decision

`MIGRATIONS: Migration[]` where `Migration = { id, name, sql }`, and
`runMigrations` throws if `migration.id !== version` at the position it is
about to apply. The append-only rule is now mechanically checked rather than
documented: an inserted, reordered or renumbered entry fails at open, in the
first line of every test run, instead of corrupting a schema.

Kept as-is, deliberately:

- **`user_version`-gated, one transaction per migration.** Already correct.
- **The refusal to open a future-versioned database** (`current >
  MIGRATIONS.length`). A database written by a newer build has a schema this
  code does not know; running old SQL against new tables is worse than
  refusing. Downgrade must be a deliberate act, not a silent partial write.
- **`schema.ts` IS the migration list.** There is no separate "current schema"
  file, so schema↔migration drift is structurally impossible — the fresh-install
  path and the upgrade path are the same array.

`name` is logged when a migration applies, so an upgrade's log reads as a list
of what changed rather than a list of integers.

## Consequences

- A new migration is one appended object. Never edit, reorder or renumber a
  shipped entry — the runner now enforces this and a test proves the runner
  does (`tests/store/migrations.test.ts` renumbers entry 0 and expects a throw).
- Three suites build a database frozen at an older version to prove an upgrade;
  they share `tests/kit/store-legacy-db.ts` (`withLegacyDb(version, fn)`), which
  owns the temp directory, the raw handle and the cleanup.
