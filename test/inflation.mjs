// WHAT A DECADE DOES TO THE PRICE LEVEL, AND TO RENT ON TOP OF IT.
//
//   pnpm inflation
//
// The owner's report was that rents roughly quadruple in the first ten years of
// almost every game, and that land goes with them. Measured, they were right,
// and nothing in the repo could see it: `conserve` reconciles cash, the gate
// tests identities and city invariants, and the baseline records the rent index
// at year 15-25 as a LEVEL — so a level that was wrong everywhere, in every
// seed, from the first decade onward, was invisible to all of it. This is the
// harness shaped to notice.
//
// It measures two things and separates them, which is the whole point:
//
//   CPI          what the price level does. Nominal rent growth is mostly this
//                and it is not a property fact at all.
//   REAL RENT    what is left after deflating. THIS is the property market's
//                own number, and over a long horizon it is small: prime
//                commercial rent grows roughly with inflation and a little,
//                because supply answers demand. Anything compounding at 4% real
//                for decades is a model that has forgotten about supply.
//
// The bands are the observed world, not a target this engine was tuned to:
//
//   CPI 1-4%/yr           US CPI has averaged ~2.5% postwar, ~3.5% including
//                         the seventies. A city cannot have its own price
//                         level far from the country's.
//   real rent -1 to +2%   CBRE/NCREIF real rent series on US office and
//                         industrial run roughly flat to +1%/yr over long
//                         horizons; individual decades run much hotter or much
//                         colder, which is why this reports 25 years and not 5.
//
// WHAT WAS WRONG, for the next person reading this: employment demand
// (`employIdx`) was not constrained by the population that had to supply it.
// Hiring outran the town, the shortfall accumulated in `jobVac` — unfilled
// positions, which reached 24% OF THE LABOUR FORCE and never came back — and
// two separate wires then took that number seriously. Space demand was driven
// by jobs WANTED rather than jobs FILLED, so a fifth of the office demand
// pricing the city came from desks nobody sat at; and the local Phillips term
// multiplied the same unbounded number into the price level, adding 2-5%/yr of
// purely local inflation on top of a national 2-3%. Both are fixed at the
// source: demand for space reads `e.jobs`, unfilled demand drags on further
// hiring and pulls migration, and the tightness signal is expressed in units a
// labour market can actually reach.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N || 5);
const YEARS = +(process.env.YEARS || 25);
const HZ = YEARS * 12;

const cagr = (a, b, yrs) => Math.pow(b / a, 1 / yrs) - 1;
const pad = (s, n) => String(s).padEnd(n);
const pct = (x) => (x * 100).toFixed(2) + "%";

const rows = [];
for (let seed = 0; seed < N; seed++) {
  const { parcels, adjacency, bbls } = loadCity(seed % 4, E.normalizeParcels);
  let g = E.firstListings(E.newGame(30_000 + seed * 977, parcels), parcels, bbls);
  const at0 = { ...g.econ.rentIdx };
  let ten = null;
  for (let m = 0; m < HZ; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // The frozen world: an un-resurrected probe stops at gameOver and every
    // later month is a copy of the month it died in. See CLAUDE.md.
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    if (m === 119) ten = { rent: { ...g.econ.rentIdx }, cpi: g.econ.cpi ?? 1 };
  }
  const cpi = g.econ.cpi ?? 1;
  rows.push({
    seed,
    cpi10: ten.cpi, cpi25: cpi,
    off10: ten.rent.office / at0.office,
    off25: g.econ.rentIdx.office / at0.office,
    real10: (ten.rent.office / at0.office) / ten.cpi,
    real25: (g.econ.rentIdx.office / at0.office) / cpi,
    ret25: (g.econ.rentIdx.retail / at0.retail) / cpi,
    ind25: (g.econ.rentIdx.industrial / at0.industrial) / cpi,
  });
}

console.log(`\nTHE PRICE LEVEL AND WHAT RENT DOES ON TOP OF IT — ${N} towns x ${YEARS} years\n`);
console.log(`  ${pad("seed", 6)}${pad("CPI 10yr", 11)}${pad("CPI /yr", 10)}${pad("office x10", 12)}${pad("office x25", 12)}${pad("real x25", 11)}real rent /yr`);
for (const r of rows) {
  console.log(`  ${pad(r.seed, 6)}${pad(r.cpi10.toFixed(2) + "x", 11)}${pad(pct(cagr(1, r.cpi25, YEARS)), 10)}`
    + `${pad(r.off10.toFixed(2) + "x", 12)}${pad(r.off25.toFixed(2) + "x", 12)}`
    + `${pad(r.real25.toFixed(2) + "x", 11)}${pct(cagr(1, r.real25, YEARS))}`);
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const cpiRate = med(rows.map((r) => cagr(1, r.cpi25, YEARS)));
const realRate = med(rows.map((r) => cagr(1, r.real25, YEARS)));
const realRet = med(rows.map((r) => cagr(1, r.ret25, YEARS)));
const realInd = med(rows.map((r) => cagr(1, r.ind25, YEARS)));
const ten = med(rows.map((r) => r.off10));

console.log(`\n  median inflation            ${pct(cpiRate)}/yr        (band 1.0% - 4.0%)`);
console.log(`  median real office rent     ${pct(realRate)}/yr        (band -1.0% - 2.0%)`);
console.log(`  median real retail rent     ${pct(realRet)}/yr`);
console.log(`  median real industrial rent ${pct(realInd)}/yr`);
console.log(`  median nominal office, first ten years  ${ten.toFixed(2)}x`);

let bad = 0;
const check = (label, v, lo, hi) => {
  const ok = v >= lo && v <= hi;
  if (!ok) bad++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label}`);
};
console.log("");
check(`inflation ${pct(cpiRate)}/yr sits in 1.0%-4.0%`, cpiRate, 0.01, 0.04);
check(`real office rent ${pct(realRate)}/yr sits in -1.0%-2.0%`, realRate, -0.01, 0.02);
check(`real retail rent ${pct(realRet)}/yr sits in -1.5%-2.5%`, realRet, -0.015, 0.025);
check(`real industrial rent ${pct(realInd)}/yr sits in -1.5%-2.5%`, realInd, -0.015, 0.025);
console.log("");
console.log("  A REPORT, NOT A GATE — these are bands and a band is a matter of judgement, the");
console.log("  same call CLAUDE.md records for the lettered tests. What it must never do is go");
console.log("  quiet: a decade of 5% inflation is not visible from any identity in this repo,");
console.log("  and it is the fault this file exists for.");
console.log("");
process.exit(0);
