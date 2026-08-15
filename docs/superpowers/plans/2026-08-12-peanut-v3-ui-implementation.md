# Peanut v3 — Command Console UI Implementation Plan

> **For agentic workers:** this is the build contract for porting the approved
> `docs/mockups/command-console.html` mockup into the real Preact renderer as a
> modular, expandable framework, and wiring the new live data paths. Follow the
> primitive/API contracts and the data-binding map exactly. Steps use `- [ ]`.

**Goal:** Replace the placeholder Preact dashboard with the finalized "Command
Console" UI — built as a layered design-system framework (tokens → primitives →
cards → views → shell) — bound live to the real engine, with a native overlay
"activity veil" on the Instagram tab.

**Architecture:** The renderer renders ONLY the left console (the Electron window
supplies the frame; the Instagram tab + the veil are native `WebContentsView`s in
the main process). UI is composed bottom-up: data-agnostic **primitives** in
`ui/`, **cards** that bind one primitive-composition to one typed data hook,
**views** that stack cards, and an **`App` shell** that owns the single status
subscription, settings draft, toasts, view routing, and control handlers. All
live data flows through the existing `window.peanut` bridge plus four new
read-only channels.

**Tech Stack:** TypeScript (strict), Preact + hooks (`h`/`Fragment` pragma),
esbuild (bundles TSX + CSS + embeds fonts as data URIs), self-hosted
`@fortawesome/fontawesome-free@7.3.1`, better-sqlite3 store (unchanged boundary).

## Global Constraints (verbatim, apply to every task)

- **Renderer = console only.** No faux titlebar, no `.igpane`, no in-DOM veil.
  The mockup's `.window`/`.body` frame and right pane are provided natively.
- **Palette + spacing tokens are the mockup's, verbatim** (`docs/mockups/command-console.html`
  `:root`). Do not retune colors. The 4px fluid `--sp-*` scale and the console
  container-query `--sp-*` override are both kept.
- **Icons are real FontAwesome** `<i class="fa-solid fa-…">` via the self-hosted
  package; fonts are embedded as `data:` URIs by esbuild. No CDN. No hand-rolled
  icon SVGs (the peanut brand glyph is the ONLY inline SVG, an intentional logo).
- **CSP:** `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:;`.
- **Push-first status** (spec §4): one `on('status')` subscription + one `status()`
  pull on mount + slow keepalive; never a competing poll. All `on()` torn down on
  unmount. Every async control shows pending + surfaces typed failures as a toast.
- **Bind to real state, never index arithmetic.** Counts from `EngineStatus`; lists
  lazy-loaded per tab from `queue:list`; settings from `settings:get/update`.
- **`prefers-reduced-motion`** collapses every animation (matches the mockup).
- **strict TypeScript**, no `any` on public APIs, no silent `catch {}`.
- Commit after each green phase. Conventional-commit messages.

---

## File Structure

```
src/renderer/
  index.html                # console mount; links bundled index.css; CSP
  index.tsx                 # imports styles/index.css; render <App/>
  app/
    App.tsx                 # shell: status sub, settings draft, toasts, routing, controls
    Header.tsx              # brand mark (breathing ring) + tagline
    Transport.tsx           # Start / Pause·Resume / Cancel trio; expresses state
    Nav.tsx                 # 4-way view rail
    ViewStage.tsx           # animated view host (enter/exit scale+fade, stagger)
    Ticker.tsx              # docked activity ticker (latest log line)
    ConfirmHost.tsx         # renders the single confirm modal from useConfirm
    TooltipHost.tsx         # renders the single [data-tip] popover from useTooltip
  views/
    OverviewView.tsx  ChainView.tsx  QueuesView.tsx  SettingsView.tsx
  cards/
    overview/ LiveStatusCard NowTargetingCard RateSafetyCard ActivityCard GrowthCard
    settings/ SeedSessionCard StrategyCard ProjectionCard TargetingCard
              LifecycleCard SafetyCard CadenceCard DryRunCard
  ui/                       # PRIMITIVES — data-agnostic, reusable, documented props
    Icon.tsx Card.tsx Button.tsx Field.tsx KeyValue.tsx Badge.tsx
    Slider.tsx DualRange.tsx Stepper.tsx Segmented.tsx Chips.tsx Toggle.tsx
    Select.tsx NumberInput.tsx TextInput.tsx Meter.tsx RadialRing.tsx Clock24.tsx
    Modal.tsx Tooltip.tsx
  charts/
    growth-model.ts         # pure projection math (projP/projNet/pnoise) — unit-tested
    catmull-rom.ts          # smooth() path builder — unit-tested
    GrowthChart.tsx         # net-growth line: reveal (leading dot + clip fill)
    ProjectionChart.tsx     # 3-scenario projected growth; live recompute
    useSvgReveal.ts         # shared rAF reveal hook (dashoffset + dot + clip)
  hooks/
    useEngineStatus.ts (exists)  useToasts.ts (exists)
    useSettingsDraft.ts     # draft + dirty + save via updateSettings, preset lock
    useView.ts              # active view + transition orchestration (reduced-motion aware)
    useConfirm.ts           # promise-based confirm modal controller
    useTooltip.ts           # global [data-tip] hover controller (portal popover)
    useCountdown.ts         # next-action ETA from lastActionAt + delay band
    useChainList.ts useQueue.ts useGrowthSeries.ts useSeedCheck.ts useLogFeed.ts
  lib/
    format.ts (exists, extend)  # commas, clock, relative, ratio, duration, monogram
    motion.ts               # durations, easings, reduced-motion helper
    engine-view.ts          # PeanutStatus -> view-models (state label, next action, meters)
    settings-derive.ts      # ceilFor/planFor, yieldMult, follower/ratio formatting
    strategy-presets.ts     # AGG presets -> Settings patch + locked-field set
  styles/
    index.css               # @layer order + @imports (FA + tokens+base+layout+primitives+cards)
    tokens.css  base.css  layout.css  primitives.css  cards.css
src/main/
  main.ts                   # + mount overlay veil view; push status -> veil
  overlay/
    veil-view.ts            # OverlayVeil: WebContentsView above IG tab; show/hide by state
    veil.html veil.css veil.ts  # frosted veil content (diagonal double-wipe shine)
```

## New backend data paths (Phase A — signatures finalized against the scout report)

Four new read-only channels, wired end-to-end (types → preload → ipc → foundation),
each following the `chain:list` template:

1. `growth:series` → `GrowthSeries` — `{ points: { dayStartMs: number; cumulativeNet: number }[] }`.
   Source: new `KnowledgeStore.netGrowthSeries(days, ownPk)` (own follow_records
   reaching `followed_back` per day minus churn/unfollows per day, cumulative).
2. `EngineStatus` gains `sessionStartedAt: number | null` and `netToday: number`
   (no new channel — flows through the existing `status`/push path; `PeanutStatus`
   inherits automatically). Session start set on idle→running, cleared on stop.
3. `seed:check` → `SeedCheck` — `{ ok, exists, followersVisible, reason? }` from
   `Foundation.checkSeed(username)` (a single lightweight profile/followers-head read).

If Phase A reveals a source is genuinely underivable, that ONE hook returns a typed
`null`/`unavailable` and the card shows its designed empty state — the seam stays
identical, so it goes live later by filling the hook.

## Primitive API contracts (the parts cards depend on — keep stable)

- `Icon({ name, brand?, spin?, class? })` → `<i class="fa-solid|fa-brands fa-${name}">`, `aria-hidden`.
- `Card({ raised?, index?, class?, children })` — `--i` stagger var from `index`; `Card.Header`, `Card.Body`.
- `Button({ variant: 'transport'|'wide'|'chip', danger?, active?, pending?, icon?, disabled?, onClick, children })`.
- `Field({ label, value?, tip?, locked?, hint?, hintKind?, children })` — settings row wrapper (`.field`).
- `Slider({ min,max,step,value,format,onInput,disabled?,ticks? })` — filled track (`--pct`) + readout.
- `DualRange({ min,max,step,gap,lo,hi,peak?,scaleFmt,ariaFmt,onChange,disabled? })` — pointer+keyboard; band+peak.
- `Stepper({ min,max,step,value,dec?,suffix?,onChange })`.
- `Segmented({ options,value,onChange })` / `Chips({ options,value,onChange })` — radiogroup semantics.
- `Toggle({ checked,onChange,label })` / `Select({ options,value,onChange })`.
- `Meter({ pct, brass? })` / `RadialRing({ frac, size, glyph? })` / `Clock24({ start,end,onChange })`.
- `Modal` rendered by `ConfirmHost`; opened via `useConfirm().confirm({title,body,confirm,dismiss,danger})→Promise<boolean>`.
- Tooltips: any element gets `data-tip="…"`; `TooltipHost` + `useTooltip` show the single popover.

## Data-binding map (card → source)

- LiveStatus: `useCountdown` (ring+count) · `engine-view.nextAction(status,chain)` · today meter from `actionsToday/remainingToday/atHardCeiling` · cells from `netToday`,`sessionStartedAt`,`lastStep`.
- Growth: `useGrowthSeries()` → `GrowthChart`.
- NowTargeting: `status.currentTargetUsername/chainIndex` + matching `useChainList()` yield.
- RateSafety: `actionsToday/dailyOperatingRate`, `requestBudgetRemaining/requestBudgetMaxPerWindow`, active-hours from settings + clock.
- Activity/Ticker: `useLogFeed()` (buffered `on('log')`, level filter).
- Chain: `useChainList()`; Queues: `useQueue(state)` (`queue:list`, per-tab lazy, cap+truncation note).
- Settings cards: `useSettingsDraft()` over `Settings`; Projection: `growth-model` from the draft; Strategy: `strategy-presets`; Seed: `useSeedCheck`.

## Phases

- **A. Backend data paths** — store series query + engine session/netToday + adapter seed check + 3-channel wiring + types; extend/adjust tests; `npm test` green.
- **B. UI foundation** — esbuild CSS+font bundling; CSP; `styles/` layers + tokens/base; `Icon`; `App` shell + `Header`/`Transport`/`Nav`/`ViewStage`/`Ticker`; `useView`,`useConfirm`,`useTooltip`,`useSettingsDraft`; `lib/*`. `npm run build` green, shell renders + routes.
- **C. Primitives** — all `ui/*` with `primitives.css`; a lightweight props smoke via typecheck.
- **D. Views/cards** — Overview, Chain, Queues, Settings composed on primitives + hooks (parallelizable per view).
- **E. Charts** — `growth-model`/`catmull-rom` (+ unit tests), `GrowthChart`, `ProjectionChart`, `useSvgReveal`.
- **F. Native veil** — `overlay/veil-view.ts` + `veil.*`; mount above IG tab; toggle by state with fade; blocks interaction.
- **G. Integration** — retire old components; typecheck; build; test; manual `npm run dev` pass; commit.

## Self-review gates

Per phase: `npx tsc --noEmit` clean, `npm run build` clean, `npm test` green (A/E),
no dead refs to removed old components, CSP unchanged from the constraint above,
reduced-motion honored, every panel has its designed empty/logged-out state.
