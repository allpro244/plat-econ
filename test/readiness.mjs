// FAST RELEASE READINESS.
//
// The full balance suite is intentionally deep and slow. This is the opposite:
// one command that exercises the player-facing failure classes most likely to
// ruin a session, then a short multi-strategy invariant campaign.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const checks = [
  ["attention and deadlines", "attention.mjs"],
  ["interruption load", "attention-load.mjs", { HZ: "240" }],
  ["deterministic save and resume", "stress/33-determinism.mjs", { SEEDS: "550991", HZ: "120" }],
  ["save migration", "save-migration.mjs"],
  ["continue path", "continue-path.mjs"],
  ["fundable foreclosure protection", "foreclose-funded.mjs"],
  ["atomic title transfer", "title-transfer.mjs"],
  ["rival construction and cure parity", "rival-parity.mjs"],
  ["anonymous city construction capital", "city-anonymous-capital.mjs"],
  ["delegated leasing mandate", "agent-mandate.mjs"],
  ["ground leases", "groundlease.mjs"],
  ["concurrent variances", "variance.mjs"],
  ["unified construction supply", "supplyqueue.mjs"],
  ["adaptive reuse", "reuse.mjs"],
  ["build-to-suit", "bts.mjs"],
  ["merchant exits", "merchant-exit.mjs"],
  ["property history", "property-history.mjs"],
  ["tax appeals", "tax-appeal.mjs"],
  ["rent causality", "rent-why.mjs"],
  ["finite demand", "demand-finite.mjs"],
  ["economy honesty", "economy-honesty.mjs"],
  ["rival intelligence", "rival-smart.mjs"],
  ["supply answers demand", "supply-answers.mjs", { SEEDS: "550991,12007,22,7", HZ: "1200" }],
  ["rent anchor", "rent-anchor.mjs", { SEEDS: "550991,12007,22,7", HZ: "1200" }],
  ["seller counters", "loi-counter.mjs"],
  ["development underwriting", "underwriting.mjs"],
  ["economy plausibility", "economy-plausibility.mjs", { HZ: "120", SEEDS: "3", CITY_SEEDS: "1" }],
  ["great city performance", "great-city-perf.mjs", { HZ: "12" }],
  ["multi-strategy invariant smoke", "invariants.mjs", { HORIZON: "240", SEEDS: "2" }],
  ["great city sim latency", "giant-perf.mjs", { BW_SIZE: "giant" }],
];

const results = [];
const started = performance.now();
for (const [label, file, extraEnv = {}] of checks) {
  const t0 = performance.now();
  const run = spawnSync(process.execPath, [join(HERE, file)], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  const ms = performance.now() - t0;
  const ok = run.status === 0;
  results.push({ label, ok, ms });
  if (!ok && run.error) console.error(run.error);
}

console.log(`\n${"=".repeat(68)}`);
console.log("RELEASE READINESS");
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(38)} ${(r.ms / 1000).toFixed(1).padStart(6)}s`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((performance.now() - started) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log(`failed: ${failed.map((x) => x.label).join(", ")}`);
  process.exit(1);
}
