# 0105 — Settings v2: one global document, one writer, persist-first saves

**Status:** accepted · **Area:** `src/settings/{doc,doc-rules,ops,ops-protection,persist,
migrate-v1,effective,view}.ts`, `src/main/modules/{settings-service,settings-reload}.ts`

## Context

v1 wrote `epo-settings.json` from several places, swallowed failed writes and showed them as saved
(`foundation-wiring.ts:1762-1773`), rewrote the whole file 2–4 times an hour for run stamps, replaced protection lists
wholesale (a lost update between two windows), and re-derived every number on save.

## Decision

1. **One global document**, `userData/epo-settings-v2.json` (`SettingsDocV2`): intent, sparse overrides, seed,
   protection, preferences, app state and the migration record. v1 is never written
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
   writes nothing until a recovery op. When an older build rewrites v1 later, the file's `{mtimeMs, sha256}` shows it
   at launch, and only its additions to the two lists are offered back (`import-older-version`, or a dismissed
   notice). Removals made there never apply.
6. **Keyed list ops** (`protect-add`/`protect-remove`/`word-add`/…) replace whole-list writes.
7. **One live interface.** Renderer changes use typed v2 operations. The frozen v1 model remains only for migration
   and compatibility evidence; it is not a second writable settings interface.

## Consequences

- A failed save can no longer read as saved; a crash mid-write leaves the previous file or its backup.
- Run stamps leave Settings before the reopen state adopts them (`takeBookkeeping` → durable `consume-bookkeeping`
  → seed); a failed save leaves the carried timestamp unused.
- Deleting the v2 file is not a reset: the backup or the older version's settings return under review.

## Alternatives rejected

- **Per-account settings**: protection by pk is safe across accounts; run state already lives in each account's store.
- **A meta key for run stamps**: two homes for one fact would drift (spec C13).
- **Debounced saves**: a loss window at quit; every control now commits on its own gesture.

## Amendment — pre-live review: refused migration still constrains the plan

A refused migration preserves v1's active-hours window, slower check/scan choices and custom cleanup/census limits
in the effective plan inputs. Raw protection drop counts remain visible for review, and a completed intro stays
completed through refusal and the explicit recovery choice. A non-object JSON value is unreadable settings, not a
usable v1 document. Refusal keeps protection paused and writes no v2 file until recovery succeeds.

## Amendment — pre-live review: account ownership survives failed saves and backup restoration

The first account reading an unowned migration stamp claims it in memory. Consumption first persists that account's
pk, then clears the stamp, and only a successful clear permits the account store to adopt it. This preserves explicit
ownership in the normal settings backup. A failed write cannot mark two accounts freshly checked, and restoring a
backup cannot turn an already-used stamp into an unowned one. The account store's own legacy lifecycle timestamp can
still seed independently. A crash after consumption but before store seeding loses an optimization and causes a
conservative check; it does not invent freshness.
