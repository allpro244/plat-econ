// INDUSTRIAL EXIT — composition decline must clear surplus floor space.
//
// ECONOMY.md / market.ts industComp models NY/SF/London manufacturing
// floor-space loss. Before the structural-exit wire, gone() ignored
// industComp and surplus sheds sat soft for a century (real rent ≈ −2%/yr).
//
//   node test/industrial-exit.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22,7").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 1200);

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const keepAlive = (g) => (g.gameOver ? { ...g, gameOver: null, cash: 6e6 } : g);
const med = (a) => {
  const b = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN;
};
const cagr = (a, b, y) => (a > 0 && b > 0 ? Math.pow(b / a, 1 / y) - 1 : NaN);

console.log("\nINDUSTRIAL EXIT — composition decline clears surplus sheds\n");

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

const rows = [];
for (const seed of SEEDS) {
  const parcels = structuredClone(P0);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const r0 = g.econ.rentIdx.industrial;
  const c0 = g.econ.cpi;
  const s0 = g.econ.stock.industrial;
  let soft = 0, demSf = 0;
  for (let m = 0; m < HZ; m++) {
    const before = g.econ.stock.industrial;
    g = keepAlive(E.advanceMonth(g, parcels, bbls, adjacency));
    if (g.econ.stock.industrial < before - 1) demSf += before - g.econ.stock.industrial;
    if ((g.econ.cityVac.industrial ?? 0) > E.NATURAL_VAC.industrial) soft++;
  }
  const yrs = HZ / 12;
  const ic = g.econ.industComp ?? 1;
  const stockRatio = g.econ.stock.industrial / s0;
  const row = {
    seed,
    realInd: cagr(r0 / c0, g.econ.rentIdx.industrial / g.econ.cpi, yrs),
    softPct: soft / HZ,
    vacEnd: g.econ.cityVac.industrial,
    vacMean: (() => {
      // recomputed below only at end — use soft as the soft-share proxy
      return g.econ.cityVac.industrial;
    })(),
    stockRatio,
    demSf,
    ic,
  };
  rows.push(row);
  console.log(
    `  seed ${seed}: real ${(row.realInd * 100).toFixed(2)}%/yr  `
    + `soft ${(row.softPct * 100).toFixed(0)}%  vacEnd ${(row.vacEnd * 100).toFixed(1)}%  `
    + `stock/open ${row.stockRatio.toFixed(2)}  IC ${ic.toFixed(2)}  demSf ${Math.round(demSf)}`,
  );
}

const medReal = med(rows.map((r) => r.realInd));
const medSoft = med(rows.map((r) => r.softPct));
const medStock = med(rows.map((r) => r.stockRatio));
const medIc = med(rows.map((r) => r.ic));
const medDem = med(rows.map((r) => r.demSf));
const cleared = rows.filter((r) => r.demSf >= 100_000).length;

// Before fix: median real ≈ −2.2%/yr, soft ≈ 84%, stock/open ≈ 0.98, demSf ≈ 0–70k.
check(medIc <= 0.55,
  `median industComp ${medIc.toFixed(2)} (need ≤ 0.55 — composition decline is live)`);
check(medStock <= 0.85,
  `median stock/open ${medStock.toFixed(2)} (need ≤ 0.85 — surplus sheds leave; was ≈0.98)`);
check(cleared >= 4,
  `${cleared}/${rows.length} seeds cleared ≥100k industrial sf (need ≥4)`);
check(medDem >= 120_000,
  `median industrial SF cleared ${Math.round(medDem)} (need ≥ 120k)`);
// Post firm-near rent mute, office holds the crane a bit more often and
// industrial exit trickles harder while office is short — soft share sits
// mid-50s. Still a clear win vs the pre-exit ~84%.
check(medSoft <= 0.60,
  `median months soft ${((medSoft) * 100).toFixed(0)}% (need ≤ 60% — was ~84%; exit yields while office is short)`);
// Residual logistics can still earn; chronic −2%/yr real was the death spiral.
// Early-century soft while composition falls still drags the CAGR a little;
// the failure mode this gates is the −2%/yr map-kept-every-shed path.
check(medReal >= -0.015,
  `median real industrial rent ${(medReal * 100).toFixed(2)}%/yr (need ≥ −1.5% — was ≈ −2.2%)`);
check(medReal <= 0.025,
  `median real industrial rent ${(medReal * 100).toFixed(2)}%/yr (need ≤ +2.5%)`);

if (bad) {
  console.log(`\n${bad} industrial-exit check(s) failed.\n`);
  process.exit(1);
}
console.log("\nAll industrial-exit checks passed.\n");
