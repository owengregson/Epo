/**
 * `npm run boundaries` — the layering gate (ADR 1002).
 *
 *   node scripts/boundaries.mjs             grouped report, exit 1 on any error
 *   node scripts/boundaries.mjs --verbose    list every warn edge, not just counts
 *   node scripts/boundaries.mjs --json       the raw dependency-cruiser result
 *
 * Why not the `depcruise` CLI: it asserts the host Node version against its own
 * `engines` field (`^22||^24||>=26`) and refuses to start on anything else. The
 * library underneath has no such gate, and what this gate tests is the rule set,
 * not the developer's Node. CI pins Node from `.node-version` either way.
 *
 * Errors fail the build; warnings are the migration ledger (see the two-tier
 * note at the top of `.dependency-cruiser.mjs`) and are printed as one line per
 * rule so a new one is visible without drowning in the seeded ones.
 */
import { cruise } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import extractTsConfig from 'dependency-cruiser/config-utl/extract-ts-config';

const CONFIG = './.dependency-cruiser.mjs';
const ROOTS = ['src'];

/** Cruise `src` against the committed rule set; resolves to the parsed JSON result. */
export async function runBoundaries() {
  const ruleSet = await extractDepcruiseConfig(CONFIG);
  const tsConfigFile = ruleSet.options?.tsConfig?.fileName;
  const tsConfig = tsConfigFile ? extractTsConfig(tsConfigFile) : {};
  const result = await cruise(
    ROOTS,
    { ...ruleSet.options, ruleSet, outputType: 'json', validate: true },
    {},
    { tsConfig },
  );
  return JSON.parse(result.output);
}

/** `{ [ruleName]: violations[] }`, insertion-ordered by first occurrence. */
export function groupByRule(report) {
  const groups = new Map();
  for (const violation of report.summary.violations) {
    const key = violation.rule.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(violation);
  }
  return groups;
}

const describe = (v) =>
  v.cycle ? `${v.from} → ${v.cycle.map((s) => s.name).join(' → ')}` : `${v.from} → ${v.to}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runBoundaries();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.error > 0 ? 1 : 0);
  }

  const verbose = process.argv.includes('--verbose');
  for (const [rule, violations] of groupByRule(report)) {
    const { severity } = violations[0].rule;
    console.log(`${severity === 'error' ? 'ERROR' : ' warn'}  ${rule} — ${violations.length}`);
    if (severity === 'error' || verbose) {
      for (const violation of violations) console.log(`         ${describe(violation)}`);
    }
  }

  const { error, warn, totalCruised, totalDependenciesCruised } = report.summary;
  console.log(
    `\nboundaries: ${error} error, ${warn} warn over ${totalCruised} modules / ${totalDependenciesCruised} dependencies.`,
  );
  process.exit(error > 0 ? 1 : 0);
}
