// WHAT A CENTURY OF THIS MARKET ACTUALLY LOOKS LIKE.
//
// The invariant sweep asks whether the state stays coherent. The balance
// harness asks whether a strategy can win or lose. Neither of them tells you
// what the WORLD does — how far rates travel, how long a class stays in a
// glut, how much of the city gets built, whether rents and costs stay in the
// same universe over a hundred years.
//
// This runs many centuries with nobody playing and reports distributions, so
// balance decisions come off numbers instead of off the last screenshot.
//
//   pnpm stats              12 seeds, 100 years
//   SEEDS=40 pnpm stats     more
//   HORIZON=600 pnpm stats  fifty years
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);
const CITY = process.env.BW_CITY ?? "somewhere";

const CLASSES = ["office", "retail", "multifamily", "industrial"];
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };
const SEEDS = Number(process.env.SEEDS ?? 12);
const MONTHS = Number(process.env.HORIZON ?? 1200);

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f1 = (n) => n.toFixed(1);

// ---------------------------------------------------------------- collection
const rates = [];
const vac = {}; for (const k of CLASSES) vac[k] = [];
const caps = {}; for (const k of CLASSES) caps[k] = [];
const rentEnd = {}; for (const k of CLASSES) rentEnd[k] = [];
const costRent = [];
const cityBuilt = [];        // buildings the market delivered per century
const jobsLive = [];         // sites under construction at any moment
const gluts = {}; for (const k of CLASSES) gluts[k] = [];   // longest run above natural+2.5pts
const tights = {}; for (const k of CLASSES) tights[k] = []; // longest run below natural-2pts
const sectorRuns = {}; for (const k of CLASSES) sectorRuns[k] = { boom: 0, bust: 0, steady: 0 };
const phaseMonths = { recovery: 0, expansion: 0, peak: 0, recession: 0 };
const employEnd = [];
const stockGrow = {}; for (const k of CLASSES) stockGrow[k] = [];
const targGrow = {}; for (const k of CLASSES) targGrow[k] = [];
const landEnd = [];

for (let seed = 1; seed <= SEEDS; seed++) {
  let g = E.firstListings(E.newGame(seed * 7919, parcels), parcels, bbls);
  const run = {}; for (const k of CLASSES) run[k] = { glut: 0, tight: 0, gMax: 0, tMax: 0 };
  let jobsPeak = 0;

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;
    rates.push(e.indexRate);
    phaseMonths[e.phase] = (phaseMonths[e.phase] ?? 0) + 1;
    jobsPeak = Math.max(jobsPeak, (g.cityJobs ?? []).length);
    for (const k of CLASSES) {
      const v = e.cityVac?.[k] ?? NAT[k];
      vac[k].push(v);
      caps[k].push(e.capRate[k]);
      if (e.sectorPhase?.[k]) sectorRuns[k][e.sectorPhase[k]]++;
      const r = run[k];
      // A GLUT IS NOT "SLIGHTLY ABOVE NATURAL". Equilibrium vacancy in a real
      // market sits a point or two over its theoretical natural rate — US
      // office has averaged about 13% against a natural nearer 10% for
      // decades — so a threshold of natural+2.5 was measuring the ordinary
      // condition and calling it a crisis. Five points over is a glut.
      if (v > NAT[k] + 0.05) { r.glut++; r.gMax = Math.max(r.gMax, r.glut); } else r.glut = 0;
      if (v < NAT[k] - 0.03) { r.tight++; r.tMax = Math.max(r.tMax, r.tight); } else r.tight = 0;
    }
  }
  const e = g.econ;
  for (const k of CLASSES) {
    stockGrow[k].push(e.stock[k] / Math.max(1, e.baseStock?.[k] ?? e.stock[k]));
    // what demand would want if nothing were built: the target's own growth
    const aff = Math.pow((e.rentIdx[k] / { office: 62, retail: 88, multifamily: 46, industrial: 16 }[k]) / Math.max(0.35, e.employIdx), k === "multifamily" ? -0.62 : -0.58);
    const elastic = k === "office" ? 1.0 : k === "industrial" ? 0.9 : k === "retail" ? 0.7 : 0.75;
    targGrow[k].push(Math.pow(e.employIdx, elastic) * (1 + (e.sectorMom[k] ?? 0) * 11) * aff);
    rentEnd[k].push(e.rentIdx[k]);
    gluts[k].push(run[k].gMax);
    tights[k].push(run[k].tMax);
  }
  costRent.push(e.costIdx / (e.rentIdx.office / 62));
  cityBuilt.push(g.cityBuilt.length);
  jobsLive.push(jobsPeak);
  employEnd.push(e.employIdx);
  landEnd.push(e.landIdx);
}

// ------------------------------------------------------------------- density
// What the city IS, before anybody plays: the shape the player inherits.
const built = bbls.map((b) => parcels[b]).filter((r) => r.class !== "land" && r.bldgArea > 0);
const far = built.map((r) => r.bldgArea / Math.max(1, r.lotArea));
const floors = built.map((r) => r.floors ?? 1);
const areas = built.map((r) => r.bldgArea);
const lots = bbls.map((b) => parcels[b].lotArea);
const byClass = {};
for (const r of built) byClass[r.class] = (byClass[r.class] ?? 0) + 1;
const tall = floors.filter((f) => f >= 8).length;
const veryTall = floors.filter((f) => f >= 15).length;

// --------------------------------------------------------------------- report
const YRS = MONTHS / 12;
console.log(`\n=== ${CITY.toUpperCase()} · ${SEEDS} runs x ${YRS} years ===\n`);

console.log("THE COST OF MONEY");
console.log(`  loan index   p5 ${f1(pct(rates, 5))}%  p25 ${f1(pct(rates, 25))}%  median ${f1(pct(rates, 50))}%  p75 ${f1(pct(rates, 75))}%  p95 ${f1(pct(rates, 95))}%`);
console.log(`               min ${f1(Math.min(...rates))}%  max ${f1(Math.max(...rates))}%`);

console.log("\nTHE CYCLE (share of months)");
const totPhase = Object.values(phaseMonths).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(phaseMonths)) console.log(`  ${k.padEnd(11)} ${f1((100 * v) / totPhase)}%`);

console.log("\nVACANCY BY CLASS");
for (const k of CLASSES) {
  console.log(`  ${k.padEnd(12)} p5 ${f1(100 * pct(vac[k], 5))}%  median ${f1(100 * pct(vac[k], 50))}%  p95 ${f1(100 * pct(vac[k], 95))}%   (natural ${f1(100 * NAT[k])}%)`);
}
console.log("\n  structural level (median against natural)");
for (const k of CLASSES) {
  const d = 100 * (pct(vac[k], 50) - NAT[k]);
  console.log(`  ${k.padEnd(12)} ${d >= 0 ? "+" : ""}${f1(d)} points`);
}
console.log("\n  longest unbroken GLUT (5+ points over) / SQUEEZE (3+ under), in months");
for (const k of CLASSES) {
  console.log(`  ${k.padEnd(12)} glut  median ${Math.round(pct(gluts[k], 50))}  worst ${Math.max(...gluts[k])}` +
    `    ·  squeeze median ${Math.round(pct(tights[k], 50))}  longest ${Math.max(...tights[k])}`);
}

console.log("\nSECTOR CYCLES (share of months in each state)");
for (const k of CLASSES) {
  const t = sectorRuns[k].boom + sectorRuns[k].bust + sectorRuns[k].steady || 1;
  console.log(`  ${k.padEnd(12)} boom ${f1((100 * sectorRuns[k].boom) / t)}%  steady ${f1((100 * sectorRuns[k].steady) / t)}%  bust ${f1((100 * sectorRuns[k].bust) / t)}%`);
}

console.log("\nCAP RATES");
for (const k of CLASSES) {
  console.log(`  ${k.padEnd(12)} p5 ${f1(pct(caps[k], 5))}%  median ${f1(pct(caps[k], 50))}%  p95 ${f1(pct(caps[k], 95))}%`);
}

console.log(`\nAFTER ${YRS} YEARS (median across runs)`);
for (const k of CLASSES) {
  const base = { office: 62, retail: 88, multifamily: 46, industrial: 16 }[k];
  console.log(`  ${k.padEnd(12)} rent $${pct(rentEnd[k], 50).toFixed(0)}/sf  (${f1(pct(rentEnd[k], 50) / base)}x its base)`);
}
console.log(`  build cost vs rent level: median ${pct(costRent, 50).toFixed(2)}x  (range ${pct(costRent, 5).toFixed(2)}-${pct(costRent, 95).toFixed(2)})`);
console.log(`  employment index: median ${pct(employEnd, 50).toFixed(2)}x`);
console.log(`  land index:       median ${pct(landEnd, 50).toFixed(2)}x`);

console.log("\nSUPPLY vs DEMAND OVER THE CENTURY (multiple of day one)");
for (const k of CLASSES) {
  const sg = pct(stockGrow[k], 50), tg = pct(targGrow[k], 50);
  console.log(`  ${k.padEnd(12)} stock ${sg.toFixed(2)}x   demand ${tg.toFixed(2)}x   ${sg > tg ? "OVERBUILT" : "undersupplied"} by ${f1(100 * Math.abs(sg / tg - 1))}%`);
}

console.log("\nTHE CITY BUILDS ITSELF");
console.log(`  buildings delivered per ${YRS} years: median ${Math.round(pct(cityBuilt, 50))}  (${f1(pct(cityBuilt, 50) / YRS)}/yr)  range ${Math.min(...cityBuilt)}-${Math.max(...cityBuilt)}`);
console.log(`  sites under construction at once, peak: median ${Math.round(pct(jobsLive, 50))}  max ${Math.max(...jobsLive)}`);
console.log(`  vacant lots at start: ${bbls.length - built.length} of ${bbls.length} (${f1((100 * (bbls.length - built.length)) / bbls.length)}%)`);

console.log("\nWHAT THE CITY LOOKS LIKE AT START");
console.log(`  lot area      median ${Math.round(pct(lots, 50)).toLocaleString()} sf   p95 ${Math.round(pct(lots, 95)).toLocaleString()} sf`);
console.log(`  building area median ${Math.round(pct(areas, 50)).toLocaleString()} sf   p95 ${Math.round(pct(areas, 95)).toLocaleString()} sf`);
console.log(`  FAR           p25 ${f1(pct(far, 25))}  median ${f1(pct(far, 50))}  p75 ${f1(pct(far, 75))}  p95 ${f1(pct(far, 95))}  max ${f1(Math.max(...far))}`);
console.log(`  floors        median ${Math.round(pct(floors, 50))}  p90 ${Math.round(pct(floors, 90))}  p99 ${Math.round(pct(floors, 99))}  max ${Math.max(...floors)}`);
console.log(`  8+ storeys: ${tall} buildings (${f1((100 * tall) / built.length)}%)   15+: ${veryTall} (${f1((100 * veryTall) / built.length)}%)`);
console.log(`  by class: ${Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
console.log("");
