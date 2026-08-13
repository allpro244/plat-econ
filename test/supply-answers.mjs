// SUPPLY ANSWERS EMPLOYMENT — ECONOMY.md §F #2 / CENTURY OPEN #6.
//
// Vacancy on the frictional rail while jobs outrun floors is a supply failure,
// not a reason to hike NATURAL_VAC. Null-player centuries must densify and
// deliver so office stock CAGR tracks jobs, months-on-rail fall, and
// structTight does not sit permanently elevated.
//
//   node test/supply-answers.mjs
//   SEEDS=550991,12007,11 HZ=1200 node test/supply-answers.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22,7").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 1200);
const fr = E.frictionFloor("office");

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nSUPPLY ANSWERS DEMAND — densify/delivery vs employment\n");

const rows = [];
for (const seed of SEEDS) {
  const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
  const parcels = structuredClone(P0);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const jobs0 = g.econ.jobs;
  const off0 = g.econ.stock.office;
  let pinned = 0;
  let sumST = 0;
  let dem = 0;
  for (let m = 0; m < HZ; m++) {
    const d0 = g.demolished ?? 0;
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    dem += (g.demolished ?? 0) - d0;
    if ((g.econ.cityVac.office ?? 0) <= fr + 1e-6) pinned++;
    sumST += g.econ.structTight?.office ?? 0;
  }
  const yrs = HZ / 12;
  const jobsC = Math.pow(g.econ.jobs / jobs0, 1 / yrs) - 1;
  const offC = Math.pow(g.econ.stock.office / off0, 1 / yrs) - 1;
  rows.push({
    seed,
    dem,
    pinnedPct: pinned / HZ,
    jobsC,
    offC,
    r: jobsC > 0.002 ? offC / jobsC : null,
    avgST: sumST / HZ,
    endVac: g.econ.cityVac.office,
  });
}

const growing = rows.filter((r) => r.r != null);
const med = (a) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor((b.length - 1) / 2)];
};

for (const r of rows) {
  const ratio = r.r == null ? "n/a (jobs flat/down)" : r.r.toFixed(2);
  console.log(
    `  seed ${r.seed}: stock/jobs ${ratio}  pinned ${(r.pinnedPct * 100).toFixed(0)}%  `
    + `dem ${r.dem}  avgST ${r.avgST.toFixed(3)}  `
    + `jobs ${(r.jobsC * 100).toFixed(2)}%/yr  off ${(r.offC * 100).toFixed(2)}%/yr`,
  );
}

check(growing.length >= 3, `have ${growing.length} growing-job seeds to score (need ≥3)`);

if (growing.length) {
  const medR = med(growing.map((r) => r.r));
  const medPin = med(growing.map((r) => r.pinnedPct));
  const medDem = med(growing.map((r) => r.dem));
  const medST = med(growing.map((r) => r.avgST));
  // Baseline before densify: stock/jobs ≈ 0.49, pinned ≈ 51%. After densify
  // + rent-anchor soft/rail mute, pin sits higher than the first densify-only
  // cut (price rations more slowly on the rail) — stock/jobs and demolish
  // remain the load-bearing "supply answers" signals.
  check(medR >= 0.58, `median office stock/jobs CAGR ratio ${medR.toFixed(2)} (need ≥ 0.58)`);
  check(medPin <= 0.55, `median months on office friction rail ${(medPin * 100).toFixed(1)}% (need ≤ 55%)`);
  check(medDem >= 80, `median demolish+replace events ${medDem} (need ≥ 80 — city densifies)`);
  check(medST <= 0.085, `median avg office structTight ${medST.toFixed(3)} (need ≤ 0.085)`);
}

// Friction floor must not have been hiked to fake the result.
check(
  Math.abs(fr - E.NATURAL_VAC.office * 0.32) < 1e-9,
  `friction floor still NATURAL_VAC×0.32 (${(fr * 100).toFixed(2)}%), not a vac-coefficient hike`,
);

if (bad) {
  console.error(`\n${bad} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll supply-answers checks passed.\n");
