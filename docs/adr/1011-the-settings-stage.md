# 1011 — The Settings stage: Easy and Advanced

Status: accepted

## Context

Settings lived in the left column as stacked accordions of sliders and steppers, most of them timings.
The owner asked for a separate Settings screen beside Graph and Prune, "an advanced mode and an easy mode
… in the easy mode … you don't get to the nitty-gritty of all the different timings", and a calmer, larger
console. The old UI also had structural faults the overhaul's settings core (ADR 0105, 0608) removed the
reason for:

- The renderer computed numbers itself (`settings-derive.ts`, `strategy-presets.ts`) and wrote whole v1
  partials on a 600 ms autosave, so a failed save could still read as saved and two quick list edits could
  overwrite each other.
- A hidden, always-mounted Settings view checked the starting account at every launch; any refusal read as
  "account not found".
- The Prune page edited the bulk-prune schedule, a daily limit and scan pacing that the plan now owns, and
  filtered candidates against the whitelist in the renderer.

## Decision

1. **One stage, two modes.** Settings is a lazily mounted stage tab. Easy is seven plain sections (Growth
   pace, When Epo works, Who to follow, Unfollowing, Protection, Boost, Practice & app): intent cards with
   live numbers from `SettingsView.options`, chips, switches, no sliders and no timings. Advanced is Easy
   plus a Fine-tune block under each section (nothing above it moves) and five Advanced-only sections
   (Timing, Finding new people, Limits & reading, Under the hood, Diagnostics). The mode is one `ui` op.
2. **Main computes every number.** Cards, ranges, the safety share, previews, recommendations, bounds and
   provenance come from the view main builds per revision; copy decks hold words only (a test fails on a
   digit in a deck). Advanced rows render generically from `ParamView`; Under the hood and Limits & reading
   render main's kernel catalog (`settingsBasis`). "Today's plan in detail" reads `status.plan.detail` and
   shows no digit without a built plan.
3. **Typed saves through one change queue.** Every control sends ops through `change-queue.ts`: an
   optimistic overlay per control, one send at a time, coalesced per key, no debounce; `saved` adopts the
   view by rev and offers main's inverse as Undo; `not-saved`/`refused` revert that control with
   "Not saved. Nothing was changed." and the header's Try again. Older pushes are ignored.
4. **Confirms carry the facts.** Turning pruning on, Reset to recommended (main's `previewSettings` diff,
   loosening lines marked) and the at-limit acknowledgement (once per app session) ask before sending.
5. **The starting account never checks itself.** The field reads `settingsFacts.seed`; a live check runs
   only after a different handle's save lands, or on Check now. Only an evidence-backed "doesn't exist" is
   red; busy, offline, queued and unreadable checks say what happened and keep the saved account.
6. **Search covers the old names.** Every v1 settings key maps to the row that holds it now, or to the row
   that explains why it is gone; a test pins the map to `SETTINGS_KEYS`.
7. **Prune reads, Settings writes.** The Prune page shows candidates as main annotates them (protected ones
   behind "Show protected (N)"), protection read only with a link to Settings, today's allowance read only,
   and one opt-in, "Unfollow these gradually", asked with the same census confirm.

## Consequences

- The old settings UI, its hooks, the renderer-side derivations, `settings.css`, the orphaned control atoms
  and the transitional `settings-transitional.ts` are deleted; `seed:check` answers `SeedCheckResult`.
- The tour gate, People queue windows and Start-without-seed check read the v2 view. The v1 IPC rows and
  shell signal are retired with the compatibility adapter; run stamps belong to the account store.
- The Diagnostics section exports `diagnosticsPanelSlot` for the sidebar stream's log panel.
- Practice & app shows the updater's honest states; "Up to date" needs a finished check.

## Alternatives rejected

- **Sliders for Easy.** They expose exactly the timings the owner asked to hide and invite values the
  envelope would clamp.
- **A renderer-side preview model.** It would duplicate the kernel and drift; every number shown is the one
  main resolves.
- **A debounced draft with one save.** A quit inside the window lost the change, and one failure hid
  which control failed.

## Amendment — search above Settings content (2026-11-03)

Native QA reproduced search results painting beneath the plan summary: raising the dropdown alone did not lift it
above the sibling sections' entrance-animation stacking contexts. The Settings header now has its own positioned
stacking level above those sections, so its search results remain visible over the page. The repair from `bd41d98`
is integrated at `d80c5dd`, whose full gate and normal-motion native search check passed. Search selection cleared
the query and scrolled to the requested setting. The full reduced-motion gallery also passed; the overhaul QA record
distinguishes that matrix from the native observations.
