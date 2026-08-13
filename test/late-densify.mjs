// Late-century office shortage must still densify — pin on the frictional
// rail with a live startOwed book cannot freeze the wrecking ball for decades.
//
//   pnpm engine && pnpm exec node test/late-densify.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const keepAlive = (g) => (g.gameOver ? { ...g, gameOver: null, cash: 6e6 } : g);
const fr = E.frictionFloor("office");
const SEEDS = [11, 42, 12007];

function run(seed) {
  const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
  const parcels = structuredClone(P0);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  let dem50 = 0;
  let pinLate = 0;
  let pipeMonths = 0;
  for (let m = 0; m < 1200; m++) {
    g = keepAlive(E.advanceMonth(g, parcels, bbls, adjacency));
    if (m === 599) dem50 = g.demolished ?? 0;
    if (m >= 600) {
      if ((g.econ.cityVac?.office ?? 1) <= fr + 0.005) pinLate++;
      if ((g.econ.pipeline?.office ?? 0) > 5_000
        || (g.cityJobs ?? []).some((j) => !j.orphaned && (j.mix?.office ?? (j.use === "office" ? 1 : 0)) > 0)) {
        pipeMonths++;
      }
    }
  }
  return {
    seed,
    demLate: (g.demolished ?? 0) - dem50,
    pinLatePct: pinLate / 600,
    pipeMonths,
    ST: g.econ.structTight?.office ?? 0,
  };
}

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nLATE-CENTURY OFFICE DENSIFY\n");
const rows = SEEDS.map(run);
for (const r of rows) {
  console.log(`  seed ${r.seed}: demLate=${r.demLate}  pin=${(r.pinLatePct * 100).toFixed(0)}%  `
    + `pipeMonths=${r.pipeMonths}  ST100=${r.ST.toFixed(3)}`);
}
console.log("");

const med = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

check(med(rows.map((r) => r.demLate)) >= 40,
  `median demolitions in years 50–100 ≥ 40 (got ${med(rows.map((r) => r.demLate))})`);
check(rows.every((r) => r.demLate >= 12 || r.pipeMonths >= 240),
  "no hot seed freezes both densify and the office pipeline");
check(med(rows.map((r) => r.pipeMonths)) >= 240,
  `median months with office pipeline/live work in y50–100 ≥ 240 (got ${med(rows.map((r) => r.pipeMonths))})`);

console.log("");
process.exit(bad ? 1 : 0);
