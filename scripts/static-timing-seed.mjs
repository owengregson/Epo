/**
 * How `gen-static-timing-allow.mjs --seed` classes a finding (spec §20.4, §17): HARNESS for dev
 * harness code, GEOM for geometry, protocol, numeric grids and units, PENDING (naming the stream
 * that removes it) for everything else. Deterministic: first matching rule wins, then file owner.
 */

/** Dev harnesses (spec §20.4): in scope, and nothing outside them imports them. */
const HARNESS_ROOTS = [
  [/^src\/probe\//, 'the supervised probe (npm run probe)'],
  [/^src\/livetest\//, 'the live test (npm run livetest)'],
  [/^src\/capture\//, 'the capture tool (npm run capture)'],
  [/^src\/inspect\//, 'the inspector (npm run inspect)'],
  [/^src\/tools\//, 'the README chart tooling (src/tools)'],
  [/^src\/surface-lab\//, 'the surface lab (npm run surface)'],
];

const P = (stream, reason) => ({ class: 'PENDING', stream, reason: `${stream}: ${reason}` });
const G = (reason) => ({ class: 'GEOM', reason });

/** Specific dispositions (spec §17 rows), checked before the generic families. */
const RULES = [
  { file: /^src\/timing\/session-planner\.ts$/, as: P('PR', 'S1 deletes session-planner.ts when PlanService replaces SessionPlanner (spec §5.13)') },
  { file: /^src\/timing\/primitives\.ts$/, kind: 'random', as: P('PR', "sample()'s default takes a launch stream once tests/main/runtime-lifecycle.test.ts stops pinning Math.random") },
  { file: /^src\/timing\/page-pacing\.ts$/, kind: 'random', as: P('PR', 'pause.retry takes a launch stream once tests/main/profile-landing-pacing.test.ts stops pinning Math.random') },
  { file: /^src\/timing\/primitives\.ts$/, as: P('PR', 'S2 deletes the jitter clamp and percent band with the legacy pacer (spec §17.6)') },
  { file: /^src\/timing\/cycle-plan\.ts$/, as: P('PR', 'S1 deletes cycle-plan.ts; its draw moves into the plan (spec §5.13)') },
  { file: /^src\/timing\/action-gap\.ts$/, as: P('PR', 'S2 deletes action-gap.ts with the legacy pacer (spec §17.6)') },
  { file: /^src\/timing\/noise\.ts$/, text: /^0\.999999$/, as: G('the rest-stride clamp just under 1, a numeric guard (spec §17.6)') },
  { file: /^src\/timing\/noise\.ts$/, scope: /^jitterBoundary$/, as: P('PR', 'S2r deletes the daily-boundary jitter; its parks become exact (spec §17.6)') },
  { file: /^src\/timing\/noise\.ts$/, kind: 'prior', as: P('PR', 'noisify and the rest stride read pause.retry and walk.rest-every through TempoSource') },
  { file: /^src\/timing\/circadian\.ts$/, as: P('PC', 'intensityAt moves to src/kernel/plan/circadian.ts and the samplers are deleted (spec §17.6)') },
  { file: /^src\/timing\/distributions\.ts$/, scope: /^normal01$/, as: G('Box-Muller transform constants, numeric') },
  { file: /^src\/timing\/distributions\.ts$/, scope: /^(weibull|pareto)/, as: P('PC', 'deletes the unused weibull and pareto samplers (spec §17.6)') },
  { file: /^src\/timing\/distributions\.ts$/, as: P('PC', 'the clamp re-draw count becomes a named numeric bound (spec §17.6)') },
  { file: /^src\/timing\/units\.ts$/, as: G('unit definitions: milliseconds per minute, hour and day') },
  { file: /^src\/timing\/config\.ts$/, scope: /^HARNESS$/, as: { class: 'HARNESS', reason: 'ADR 0605: the HARNESS registry keys pace the dev harnesses only and never derive' } },
  { file: /^src\/engine\/engine\.ts$/, scope: /^ACTIONS_FAILING_HALT$/, as: P('PR', 'the halt reads the D5 coldFailingThreshold() (7) instead of 8 (spec §17.8)') },
  { file: /^src\/engine\/engine\.ts$/, scope: /^REFILL_PACING_/, as: P('PR', 'S2b retires the refill beat (pause.after-task) with the activity clock (spec §5.11)') },
  { file: /^src\/engine\/(engine|engine-actions|target-pipeline)\.ts$/, kind: 'prior', as: P('PR', 'beat.transient reaches the engine through TempoSource; idle waits become exact parks (spec §17.8)') },
  { file: /^src\/engine\/prune-engine\.ts$/, kind: 'prior', as: P('PR', 'park.blocked reaches the prune engine through TempoSource (spec §5.11)') },
  { file: /^src\/engine\/prune-engine\.ts$/, scope: /^PRUNE_CONSECUTIVE_FAIL_HALT$/, as: P('PR', 'becomes the named override PRUNE.CONSECUTIVE_FAIL_HALT (spec §17.3)') },
  { file: /^src\/engine\/prune-engine\.ts$/, scope: /^PRUNE_CONSECUTIVE_BLOCK_HALT$/, as: P('PR', 'reads the D5 blockedStreakThreshold() (spec §17.8)') },
  { file: /^src\/engine\/prune-engine\.ts$/, scope: /^PRUNE_PROGRESS_EMIT_MS$/, as: P('PR', 'reads POLL.GRAPH_PUSH_THROTTLE_MS (spec §17.8)') },
  { file: /^src\/engine\/effect-policy\.ts$/, as: P('PR', 'READ_RETRY base and cap derive from timeoutFor(fetchEnvelope) (spec §17.8)') },
  { file: /^src\/engine\/recovery\.ts$/, scope: /driftConfirmed/, as: P('PR', 'drift confirmation reads the D5 driftConfirmThreshold() (spec §17.8)') },
  { file: /^src\/engine\/churn-pick\.ts$/, as: P('PR', 'the consecutive-cleanup cap gives way to the plan mix (spec §17.8)') },
  { file: /^src\/engine\/target-pipeline\.ts$/, as: P('PR', 'ACQUIRE_SKIP_POOL_FACTOR reads EXPLORATION_POLICY.skipPoolFactor (spec §17.6)') },
  { file: /^src\/rim\/follower-acquisition\.ts$/, as: P('PR', 'ACQUISITION_DEFAULTS reads EXPLORATION_POLICY (spec §17.8)') },
  { file: /^src\/rim\/own-followers-target-source\.ts$/, as: P('PR', 'the pick cap and the pool fallback read EXPLORATION_POLICY and settings (spec §17.8)') },
  { file: /^src\/rim\/profile-enricher\.ts$/, as: P('PR', 'deletes DEFAULT_BATCH_CAP; enrich slices follow the plan (spec §17.8)') },
  { file: /^src\/main\/foundation-reads\.ts$/, as: P('PR', 'QUEUE_ROW_CAP and the runway window become named bounds; the runway pace reads the plan (spec §17.9)') },
  { file: /^src\/settings\/mappers\.ts$/, as: P('PR', 'S1 retires toPacingConfig with SessionPlanner; gap.action owns the gap shape') },
  { file: /^src\/engine\/runtime-health\.ts$/, as: P('BL', 'RuntimeHealth bounds move to RUNTIME_BOUNDS (spec §17.8)') },
  { file: /^src\/engine\/churn-types\.ts$/, as: P('UD', 'deletes CHURN_DEFAULTS; tests build configs from tests/kit/configs.ts (spec §17.8)') },
  { file: /^src\/engine\/reconciliation-runner\.ts$/, as: P('UD', 'deletes reconciliation-runner.ts (verify-at-act, spec §9.7)') },
  { file: /^src\/engine\/followback-types\.ts$/, as: P('RO', 'deletes FOLLOWBACK_DEFAULTS (spec §17.8)') },
  { file: /^src\/engine\/followback-watcher\.ts$/, as: P('RO', 'deletes the watcher; its retries become plan parks (spec §17.8)') },
  { file: /^src\/engine\/reentry\.ts$/, as: P('RO', 'deletes reentry.ts and REENTRY_POLICY (spec §17.8)') },
  { file: /^src\/(engine\/reconcile-followback-cohort|rim\/effect-reconciliation)\.ts$/, as: P('RO', 'deletes this pre-read module (verify-at-act, spec §9.7)') },
  { file: /^src\/engine\/scanner\.ts$/, as: P('SC', 'deletes SCANNER_DEFAULTS (spec §17.8)') },
  { file: /^src\/engine\/scorer\.ts$/, as: P('SC', 'SCORER_DEFAULTS becomes one declaration reading SETTINGS_POLICY (spec §17.8)') },
  { file: /^src\/engine\/chain-controller\.ts$/, as: P('SC', 'CHAIN_DEFAULTS reads SETTINGS_POLICY; the frontier refill reads EXPLORATION_POLICY (spec §17.6)') },
  { file: /^src\/engine\/source-frontier\.ts$/, as: P('SC', 'the source-utility numbers read EXPLORATION_POLICY (spec §17.6)') },
  { file: /^src\/rim\/target-discovery\.ts$/, as: P('SC', 'MAX_DISCOVERED and the discovery weights read EXPLORATION_POLICY (spec §17.6)') },
  { file: /^src\/settings\/v1\//, as: G('the frozen v1 settings format (spec §16.4): what older builds read, never edited') },
  { file: /^src\/main\/modules\/settings-transitional\.ts$/, as: P('SU', 'deletes the transitional settings adapter with the old settings UI') },
  { file: /^src\/rim\/list-page-walker\.ts$/, context: /^if$/, text: /^2$/, as: P('PP', 'the fetch retry reads RIM.LIST_WALK_FETCH_RETRIES (spec §17.8)') },
  { file: /^src\/rim\/(followers-page-reader|profile-observer|list-page-walker)\.ts$/, text: /^400$/, as: G('an HTTP status code: 400 and above is a refusal (protocol)') },
  { file: /^src\/adapter\/(envelope|mutation-classify)\.ts$/, as: G('an HTTP status code (protocol)') },
  { file: /^src\/main\/connectivity\.ts$/, as: G('the HTTP success range (protocol)') },
  { file: /^src\/adapter\/mutation-watch\.ts$/, scope: /^UNMATCHED_POSTS_KEPT$/, as: P('PP', 'becomes SURFACE_BOUNDS.unmatchedPostsKept (spec §17.8)') },
  { file: /^src\/adapter\/actor\.ts$/, scope: /openListDialog/, as: P('CF', 'becomes ADAPTER.OPEN_LIST_ATTEMPTS (spec §17.8)') },
  { file: /^src\/adapter\/(actor|identity)\.ts$/, context: /^(if|return|cx|cy)$/, as: G('on-screen rect geometry: the 2 px usable threshold and centres (spec §17.8)') },
  { file: /^src\/adapter\/tab\.ts$/, scope: /goto/, as: G('the Chromium net error ERR_ABORTED (-3), protocol') },
  { file: /^src\/adapter\/tab\.ts$/, scope: /probeInput/, as: G('where the input probe points, in px (geometry)') },
  { file: /^src\/adapter\/tab\.ts$/, scope: /checkHealth/, as: G('the evaluate round-trip check (1 + 1 is 2)') },
  { file: /^src\/adapter\/browser-identity\.ts$/, as: G('capture-group indices of the user-agent parse') },
  { file: /^src\/main\/services\/(runtime-coordinator|runtime-log|dashboard-recovery|startup-failure)\.ts$/, text: /^[^0]|^0[.]/, as: P('BL', 'these bounds move to RUNTIME_BOUNDS in src/kernel/runtime-bounds.ts (spec §17.9)') },
  { file: /^src\/main\/bootstrap\.ts$/, scope: /^ORIGIN_SETTLE_MS$/, as: P('BL', 'becomes RUNTIME_BOUNDS.ORIGIN_SETTLE_MS (spec §17.9)') },
  { file: /^src\/main\/bootstrap\.ts$/, scope: /^openToolWindow$/, as: G('the dev tool window size in px (geometry)') },
  { file: /^src\/main\/app-identity\.ts$/, context: /SharedArrayBuffer/, as: G('four bytes: one Int32 cell for Atomics.wait') },
  { file: /^src\/main\/app-identity\.ts$/, as: P('BL', 'the legacy userData rename retry becomes a named runtime bound') },
  { file: /^src\/main\/modules\/startup-steps\.ts$/, as: P('BL', 'becomes ADAPTER.PROFILE_LAND_CLICK_ATTEMPTS (spec §17.9)') },
  { file: /^src\/main\/overlay\/veil-view\.ts$/, as: P('BL', 'the veil fade derives from BOOT: four perception units and one frame (spec §17.9)') },
  { file: /^src\/main\/window\/shell\.ts$/, as: P('TK', 'shell geometry and its persist delay move to SHELL_GEOMETRY (spec §17.9)') },
  { file: /^src\/main\/foundation-wiring\.ts$/, scope: /growthSeries/, as: P('SH', 'the default chart span becomes CHART_DEFAULT_DAYS (spec §17.9)') },
  { file: /^src\/main\/window-state\.ts$/, as: G('window geometry in px and the state file indentation') },
  { file: /^src\/main\/updater\.ts$/, context: /^percent$/, as: G('a percent scale (unit)') },
  { file: /^src\/store\/types\.ts$/, scope: /^SOURCE_CONFIDENCE$/, as: G('an ordinal merge-precedence table, not a quantity (spec §17.9)') },
  { file: /^src\/store\/(schema\.ts|schema\/)/, context: /^id$/, as: G('a migration id: an append-only sequence number') },
  { file: /^src\/store\/schema\//, context: /[.]key$/, as: G('a primary-key column position in the table manifest') },
  { file: /^src\/store\/driver\/self-test\.ts$/, as: G('round-trip values of the driver durability self-test') },
  { file: /^src\/store\/spans\.ts$/, scope: /^(enc|SpanSink\.mint)$/, as: G('Crockford base-32 span ids: the radix and digit widths') },
  { file: /^src\/store\/repos\/analytics\.ts$/, as: G('median index arithmetic (halving), numeric') },
  { file: /^src\/surface\/meter\.ts$/, scope: /^RESERVOIR$/, as: P('PH', 'the latency reservoir size becomes a SURFACE_BOUNDS entry (spec §10.9)') },
  { file: /^src\/surface\/meter\.ts$/, as: G('quantile definitions (p50, p95), numeric') },
  { file: /^src\/surface\/shadow\.ts$/, as: G('how many shadow issues one log line quotes (an excerpt length)') },
  { file: /^src\/surface\/schema\/surface\.ts$/, as: G('a schema bound of the surface document (protocol)') },
  { file: /^src\/(shared\/projections|types)\.ts$/, as: P('lead', 'a display threshold with no spec §17 row; the lead names its home') },
  { file: /^src\/utils\/logger\.ts$/, scope: /^RANK$/, as: G('ordinal log-level ranks, not quantities') },
  { file: /^src\/interaction\/interactor\.ts$/, scope: /moveTo/, as: G('the dev probe target width in px (spec §17.5)') },
];

/** Generic families, after the specific rules; `guard` skips anything whose names say time. */
const FAMILIES = [
  { file: /^src\/(surface|adapter)\/versions\//, guard: true, as: G('a fact of the versioned Instagram surface: ids, page sizes, locate bounds (spec §17.8)') },
  { file: /^src\/adapter\/page\//, guard: true, as: G('in-page DOM geometry: rect thresholds, aim grid, probe fractions (spec §17.8)') },
  { file: /^src\/interaction\//, guard: true, as: G('pointer geometry and distribution-shape constants (spec §17.5)') },
  { file: /^src\/ipc\//, guard: true, as: G('an IPC guard bound: the largest value a renderer message may carry (protocol)') },
  { text: /^0x/i, as: G('a 32-bit mask or hash-mixing constant, numeric') },
  { text: /^0o/, as: G('a file permission mode: owner read and write') },
  { text: /e-\d+$/, as: G('a numeric epsilon guard') },
  { context: /(^|[.])(padStart|padEnd|toFixed|toPrecision|toString)$/, as: G('a formatting width or radix') },
  { context: /^JSON[.]stringify$/, as: G('JSON indentation width') },
  { context: /^String[.]fromCharCode$/, as: G('character-code arithmetic over an alphabet') },
  { context: /^Math[.](sqrt|cos|sin|exp|log)$/, guard: true, as: G('a constant of a closed-form formula, numeric') },
  { context: /[.]slice$/, text: /^\d+$/, guard: true, as: G('an excerpt length for a log or diagnostic line') },
];

/** Appendix B of the workplan: which stream owns a file after Phase F (first match wins). */
const OWNERS = [
  [/^src\/governors\/plan-(state|view|service|projection|preview|boost|day-clock)\.ts$/, 'PC'],
  [/^src\/(timing\/(tempo-source|circadian|distributions)|settings\/plan-intent|main\/modules\/boost-control|main\/ipc-plan|shared\/(plan-projection|boost))\.ts$/, 'PC'],
  [/^src\/main\/services\/(plan-wiring|mutation-cadence|mutation-admission|mutation-policy)\.ts$/, 'PR'],
  [/^src\/main\/(modules\/(plan-control|prune-control|prune-schedule)|foundation-reads)\.ts$/, 'PR'],
  [/^src\/(governors\/(rate-governor|read-budget)|settings\/(read-allowance|legacy-pacing-migration))\.ts$/, 'PR'],
  [/^src\/engine\/(pacers|decisions|engine-waits|facts-plan|plan-mix|plan-port|engine-actions|engine|status-projection|status|facts|prune-pacing|target-pipeline|target-recovery|exploration-policy)\.ts$/, 'PR'],
  [/^src\/rim\/(ig-activity-clock|profile-enricher|follower-acquisition|own-followers-target-source)\.ts$/, 'PR'],
  [/^src\/timing\/(session-planner|cycle-plan|action-gap|primitives|noise|page-pacing|delay-manager|schedule-manager|wait-runner)\.ts$/, 'PR'],
  [/^src\/settings\/(resolve|params.*|view|view-options|basis|ops|ops-protection|persist|v1-adapter|doc|doc-rules|migrate-v1|migrate-v1-lists|effective|mappers|settings)\.ts$/, 'SC'],
  [/^src\/main\/(modules\/(settings-service|settings-reload|settings-facts|seed-check|protection-linker)|ipc-settings)\.ts$/, 'SC'],
  [/^src\/(store\/repos\/protection-facts|engine\/(scorer|chain-controller|source-frontier|scanner)|rim\/target-discovery)\.ts$/, 'SC'],
  [/^src\/shared\/(settings-[a-z-]+|seed-check)\.ts$/, 'SC'],
  [/^src\/shared\/(unfollow-protection|click-verdict)\.ts$/, 'UD'],
  [/^src\/engine\/(protection-[a-z]+|click-verdict|journal|churn-[a-z]+|prune-(candidate|feed|engine|whitelist|bio-filter)|rules|lifecycle-rules|rules-prune|engine-journal-effects|facts-journal|recovery-healer|reconciliation-runner)\.ts$/, 'UD'],
  [/^src\/(rim\/(journal-settlement|churn-actions)|main\/services\/(click-review|unfollow-wiring|prepare-mutation)|store\/repos\/(follow-records|effect-intents))\.ts$/, 'UD'],
  [/^src\/store\/(repos\/(growth|reopen-state|relationships|analytics|census)|folds\/growth|knowledge-store|knowledge-store-base)\.ts$/, 'RO'],
  [/^src\/shared\/(followback-outcome|reopen-view)\.ts$/, 'RO'],
  [/^src\/engine\/(source-quality|sweep-plan|frontier-sweep|followback-[a-z]+|facts-cadence|engine-sweep-effects|ports|reentry|reconcile-followback-cohort|managed-relationships)\.ts$/, 'RO'],
  [/^src\/rim\/(feed-watermark|followers-head|following-check|feed-capture|follow-notifications|request-acceptance|walk-own-list|effect-reconciliation|managed-relationships)\.ts$/, 'RO'],
  [/^src\/main\/(services\/reopen-wiring|modules\/catch-up)\.ts$/, 'RO'],
  [/^src\/surface\/(lab\/|versions\/[^/]+\/scrub-shapes\.ts$)/, 'PH'],
  [/^src\/surface\/versions\/[^/]+\/(controls|literals-dom)\.ts$/, 'CF'],
  [/^src\/surface\/(read|transport|recovery|schema|versions)\//, 'PP'],
  [/^src\/surface\/(index|parse|health|shadow)\.ts$/, 'PP'],
  [/^src\/adapter\/(reader|reader-shadow|reader-relationships|observed-reads|fetch-json|envelope|mutation-classify|surface-types|ig-surface|mutation-watch|drawer-read)\.ts$/, 'PP'],
  [/^src\/adapter\/versions\//, 'PP'],
  [/^src\/rim\/(list-page-walker|list-walk-end|list-walk-types|followers-page-reader|profile-observer|profile-visit|profile-visit-port|relationship-reconciler)\.ts$/, 'PP'],
  [/^src\/(engine\/(census-authority|prune-scan-guards)|main\/services\/own-stats|shared\/observed-relation)\.ts$/, 'PP'],
  [/^src\/surface\/(sink|health-view|meter)\.ts$/, 'PH'],
  [/^src\/(store\/repos\/surface-drift|main\/services\/(surface-wiring|surface-health-sink|surface-report)|main\/ipc-surface|shared\/(surface-health|surface-gate))\.ts$/, 'PH'],
  [/^src\/adapter\/(action-admission|unfollow-flow|actor|actor-scroll|response-watch|confirm-capture)\.ts$/, 'CF'],
  [/^src\/(adapter\/page\/|engine\/mutation-outcome\.ts$)/, 'CF'],
  [/^src\/main\/(window\/(shell|stage-controller|app-menu)|launch|main|app-identity|bootstrap|foundation-wiring|ipc-boot|ipc)\.ts$/, 'BL'],
  [/^src\/main\/modules\/(boot-sequencer|startup-steps|session|status-compose|not-built)\.ts$/, 'BL'],
  [/^src\/main\/overlay\//, 'BL'],
  [/^src\/main\/services\/(tab-lease|runtime-coordinator|dashboard-recovery|runtime-log|startup-failure|graph-builder|graph-types|ig-session)\.ts$/, 'BL'],
  [/^src\/(store\/open-error|shared\/(boot|stage-mode|status-fields|live-op))\.ts$/, 'BL'],
  [/^src\/main\/(modules\/(activity-relay|feed-projection|log-ring|projections|updater)|update-core|updater|services\/live-wiring|ipc-live)\.ts$/, 'LD'],
  [/^src\/(store\/repos\/feed-reads|shared\/(feed|update-status)|engine\/resume-target)\.ts$/, 'LD'],
  [/^src\/shared\/brand-mark\.ts$/, 'TK'],
  [/^src\/shared\/(posture|attention)\.ts$/, 'SB'],
  [/^src\/(probe\/|capture\/classify\.ts$)/, 'PP'],
  [/^src\/surface-lab\//, 'PH'],
  [/^src\/tools\/readme\/live-charts\.ts$/, 'PR'],
];

/** The stream that owns `file` after Phase F; frozen Phase F files and unlisted ones go to the lead. */
export const ownerOf = (file) => OWNERS.find(([re]) => re.test(file))?.[1] ?? 'lead';

/** Words that name a duration: a generic GEOM family never swallows a finding they describe. */
const TIME_WORDS = new Set(['ms', 'timeout', 'sleep', 'wait', 'delay', 'settle', 'interval', 'pause', 'retry', 'backoff', 'jitter', 'hold', 'park', 'poll']);
const saysTime = (...names) =>
  names.some((n) => n.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).some((w) => TIME_WORDS.has(w.toLowerCase())));

/** A rule that excuses (GEOM, HARNESS) covers only literals unless it names its kind. */
const matches = (rule, f) =>
  (rule.file === undefined || rule.file.test(f.file)) &&
  (rule.kind === undefined ? rule.as.class === 'PENDING' || f.kind === 'literal' : rule.kind === f.kind) &&
  (rule.scope === undefined || rule.scope.test(f.scope)) &&
  (rule.context === undefined || rule.context.test(f.context)) &&
  (rule.text === undefined || rule.text.test(f.text)) &&
  !(rule.guard && saysTime(f.scope, f.context));

const FALLBACK = {
  literal: 'no spec §17 row names this value; derive it in src/kernel, inject it, or argue it GEOM',
  prior: 'read this prior through a TempoSource (src/kernel/tempo), never directly',
  random: 'draw from a launch stream of the entropy root (src/utils/entropy.ts) instead',
};

/** `{class, stream?, reason}` for one finding (`{file, scope, context, text, kind}`). */
export function classify(f) {
  const harness = HARNESS_ROOTS.find(([re]) => re.test(f.file));
  if (harness && f.kind === 'literal') {
    return { class: 'HARNESS', reason: `harness: ${harness[1]} is dev-only; its values never reach production` };
  }
  const rule = RULES.find((r) => matches(r, f)) ?? FAMILIES.find((r) => matches(r, f));
  return rule ? { ...rule.as } : P(ownerOf(f.file), FALLBACK[f.kind]);
}
