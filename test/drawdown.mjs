// THE DRAWDOWN PICTURE, AND HOW LONG THE FALL LASTS.
//
//   pnpm drawdown                                twelve seeds, fifty years
//   N=24 HZ=1200 pnpm drawdown                   a wider, longer sweep
//   ENGINE=test/.engine-base.mjs pnpm drawdown   the other arm of an A/B
//
// Two questions that look like one and are not. HOW FAR a market falls is the
// rate times the duration, and this repo had the rate right and the duration
// wrong for a long time: the glut branch of `vacTerm` is calibrated at
// -14.7%/yr at nine points over natural, which IS Manhattan 1990-92, and rents
// were then falling at that rate for eight and a half years because the
// capitulation clock ramped in over six months and held at full strength for as
// long as the oversupply lasted.
//
// Measured before the fix / after:
//
//   office asking rent drawdown      53.4%  ->  29.5%   (median)
//   office effective rent            57.9%  ->  36.6%   anchor: 35-40%
//   building value                   67.4%  ->  50.9%
//   longest unbroken real-rent fall   8.4y  ->   5.6y   anchor: 2-3y
//
// THE GLUT DURATION IS NOT THE FAULT and must not be "fixed": US office vacancy
// really did take seven to ten years to clear after 1990, after 2001 and after
// 2008, and this city's six-to-seven year median is right. What was wrong is a
// market that reprices for the whole of it. See `capitulation` in market.ts.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = Number(process.env.N ?? 12);
const HZ = Number(process.env.HZ ?? 600);
const K = "office";
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
const pct = (x) => (x * 100).toFixed(1) + "%";
const ddOf = (a) => { let pk = -Infinity, d = 0; for (const v of a) { pk = Math.max(pk, v); d = Math.max(d, 1 - v / pk); } return d; };
/** The worst fall, how many months it took, and whether it ever came back. */
function anatomy(a) {
  let pk = -Infinity, pi = 0, best = 0, bi = 0, bj = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > pk) { pk = a[i]; pi = i; }
    const x = 1 - a[i] / pk;
    if (x > best) { best = x; bi = pi; bj = i; }
  }
  let rec = -1;
  for (let i = bj; i < a.length; i++) if (a[i] >= a[bi]) { rec = i - bj; break; }
  return { d: best, fall: bj - bi, rec };
}

const R = { rent: [], eff: [], val: [], land: [], cap: [], fall: [], rec: [] };
const gluts = [], overM = [], declineYrs = [];
for (let i = 0; i < N; i++) {
  const seed = (2166136261 ^ ((i + 1) * 2654435761)) >>> 0 % 1e6;
  const { parcels: P0, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const lot = bbls.filter((b) => parcels[b]?.class === "land" && parcels[b].lotArea >= 1500)[0];
  const rent = [], eff = [], val = [], land = [], capv = [], gapS = [], overS = [];
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ, cpi = e.cpi || 1;
    rent.push(e.rentIdx[K] / cpi);
    eff.push((e.effRentIdx?.[K] ?? e.rentIdx[K]) / cpi);
    val.push((e.rentIdx[K] / (e.capRate[K] / 100)) / cpi);
    capv.push(e.capRate[K]);
    if (lot) land.push(E.landPsfNow(parcels[lot], e) / cpi);
    const avail = (e.cityVac?.[K] ?? 0) + (e.sublet?.[K] ?? 0) / Math.max(1, e.stock?.[K] ?? 1);
    gapS.push(avail - E.NATURAL_VAC[K]);
    overS.push(e.vacOverM?.[K] ?? 0);
  }
  const an = anatomy(val);
  R.rent.push(ddOf(rent)); R.eff.push(ddOf(eff)); R.val.push(ddOf(val));
  if (land.length) R.land.push(ddOf(land));
  R.cap.push(Math.max(...capv) / Math.min(...capv));
  R.fall.push(an.fall); R.rec.push(an.rec);
  // glut episodes, and the longest unbroken fall in a 13-month-smoothed series
  // so a month of noise is not read as a bottom.
  let run = 0;
  for (const gp of gapS) { if (gp > 0.015) run++; else { if (run > 6) gluts.push(run); run = 0; } }
  if (run > 6) gluts.push(run);
  overM.push(Math.max(...overS));
  const sm = rent.map((_, j) => {
    const a = rent.slice(Math.max(0, j - 6), j + 7);
    return a.reduce((x, y) => x + y, 0) / a.length;
  });
  let f = 0, bestF = 0;
  for (let j = 1; j < sm.length; j++) { if (sm[j] < sm[j - 1]) { f++; bestF = Math.max(bestF, f); } else f = 0; }
  declineYrs.push(bestF / 12);
}

const row = (n, a, f = pct) => console.log(`  ${n.padEnd(30)} ${f(q(a, 0.25)).padStart(9)} ${f(q(a, 0.5)).padStart(9)} ${f(q(a, 0.75)).padStart(9)} ${f(Math.max(...a)).padStart(9)}`);
console.log(`\nWORST PEAK-TO-TROUGH, REAL TERMS — ${N} seeds x ${HZ / 12} years\n`);
console.log(`  ${"".padEnd(30)} ${"p25".padStart(9)} ${"median".padStart(9)} ${"p75".padStart(9)} ${"worst".padStart(9)}`);
row("office asking rent", R.rent);
row("office EFFECTIVE rent", R.eff);
row("building value (rent/cap)", R.val);
if (R.land.length) row("one lot's land", R.land);
row("cap rate high/low (x)", R.cap, (v) => v.toFixed(2) + "x");

console.log(`\nHOW LONG THE MARKET FALLS\n`);
console.log(`  glut episodes (gap > 1.5pp), years:    p25 ${(q(gluts, 0.25) / 12).toFixed(1)}  median ${(q(gluts, 0.5) / 12).toFixed(1)}  p75 ${(q(gluts, 0.75) / 12).toFixed(1)}  longest ${(Math.max(...gluts) / 12).toFixed(1)}`);
console.log(`  longest UNBROKEN real-rent fall, yrs:  p25 ${q(declineYrs, 0.25).toFixed(1)}  median ${q(declineYrs, 0.5).toFixed(1)}  p75 ${q(declineYrs, 0.75).toFixed(1)}  longest ${Math.max(...declineYrs).toFixed(1)}`);
console.log(`  vacOverM peak, months:                 median ${q(overM, 0.5)} — the clock ramps in over 6, holds through`);
console.log(`                                         the repricing, then fades. See \`capitulation\`.`);
console.log(`  worst value fall took ${q(R.fall, 0.5)} months; ${R.rec.filter((x) => x >= 0).length}/${N} seeds recovered it`);

console.log(`\n  REAL WORLD, worst modern busts:`);
console.log(`    Manhattan office effective rent 1990-92   -35 to -40%   over 3 years`);
console.log(`    US office values 2008-10 (NCREIF)          -33%         over 2 years`);
console.log(`    Houston office rents 1983-87               -50 to -55%  over 4 years`);
console.log(`    Manhattan development sites 1989-93        -50 to -60%`);
console.log(`    Japan urban land 1991-2005 (a bubble)      -70 to -80%`);
console.log(`    ...and vacancy took 7-10 years to clear each time, while rent bottomed in 2-3.\n`);
