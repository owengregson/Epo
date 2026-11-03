# 0105 — Settings v2: one global document, one writer, persist-first saves

**Status:** draft (SC stream; finalized in Phase I) · **Area:** `src/settings/{doc,doc-rules,ops,ops-protection,persist,
migrate-v1,effective,view,v1-adapter}.ts`, `src/main/modules/{settings-service,settings-reload}.ts`

## Context

v1 wrote `epo-settings.json` from several places, swallowed failed writes and showed them as saved
(`foundation-wiring.ts:1762-1773`), rewrote the whole file 2–4 times an hour for run stamps, replaced protection lists
wholesale (a lost update between two windows), and re-derived every number on save.

## Decision

1. **One global document**, `userData/epo-settings-v2.json` (`SettingsDocV2`): intent, sparse overrides, seed,
   protection, preferences, app state, the migration record and the transitional legacy carry. v1 is never written
   again; older builds keep reading it.
2. **One writer**, `SettingsService.apply(ops, origin)`: ops apply atomically and in order, coerced to the nearest
   safe value (ADR 0103); every result is typed (`saved` with its undo, `not-saved` when nothing changed, `refused`).
   `protect-link` and `consume-bookkeeping` are system-only.
3. **Persist first**: copy to `.bak` → write and fsync `.tmp` → rename → fsync the directory; any failure before the
   rename is `not-saved` with no swap, no reload and no push. The first write leaves the never-deleted
   `epo-settings-v2.created` marker.
4. **The read table** (spec §6.6): an unreadable file is set aside as `epo-settings-v2.corrupt-<epoch>.json`; a
   missing file with evidence of a previous one restores the backup or re-migrates **under review** — never a silent
   re-migration that would drop protection added since.
5. **Migration** (spec §6.10) runs once, from the raw v1 text: overrides only where v1 differs from the frozen v1
   derivation, timing rows only slower, both lists raw with every item counted, and an effective-equality
   post-condition. A refusal keeps serving v1's own numbers and lists, carries practice mode, pauses unfollows and
   writes nothing until a recovery op.
6. **Keyed list ops** (`protect-add`/`protect-remove`/`word-add`/…) replace whole-list writes.
7. **Transitional**: until the old Settings UI is deleted, `getSettings/updateSettings/resetSettings` go through a v1
   adapter (`toV1Settings`, `opsFromV1Partial`); a failed save rejects so the old UI shows "Not saved".

## Consequences

- A failed save can no longer read as saved; a crash mid-write leaves the previous file or its backup.
- Run stamps leave Settings once the reopen state holds them (`takeBookkeeping` → `consume-bookkeeping`).
- Deleting the v2 file is not a reset: the backup or the older version's settings return under review.

## Alternatives rejected

- **Per-account settings**: protection by pk is safe across accounts; run state already lives in each account's store.
- **A meta key for run stamps**: two homes for one fact would drift (spec C13).
- **Debounced saves**: a loss window at quit; every control now commits on its own gesture.
