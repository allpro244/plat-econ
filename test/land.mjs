// WHAT LAND ACTUALLY DOES OVER A CAREER.
//
//   node test/land.mjs                 8 seeds, 100 years
//   SEEDS=11,22 YRS=50 node test/land.mjs
//
// The owner's report is that land prices "become too inflated and deflated".
// Land IS more volatile than buildings and that is not a bug — it is a
// residual, so a 10% move in rents against a fixed construction cost is a much
// larger move in what is left over for the dirt. Japanese urban land fell about
// 70% peak to trough after 1991; US land values in the worst 2008 markets fell
// 60-80%. So the question is not "does land swing" but whether it swings more
// than that, whether it compounds away in real terms over a century, and
// whether the swing is coming from the residual (which is real) or from a rail
// or a runaway (which is not).
//
// Everything here is REAL — deflated by the price level. A nominal land series
// in a 2%-inflation world rises sevenfold over a century and tells you nothing.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22,33,4242,90210").split(",").map(Number);
const YRS = Number(process.env.YRS ?? 100);
const HZ = YRS * 12;

// Drawdown of a series: the worst peak-to-trough fall, and how long it lasted.
function drawdown(xs) {
  let peak = -Infinity, worst = 0, peakAt = 0, troughAt = 0, curPeak = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > peak) { peak = xs[i]; curPeak = i; }
    const dd = peak > 0 ? 1 - xs[i] / peak : 0;
    if (dd > worst) { worst = dd; peakAt = curPeak; troughAt = i; }
  }
  return { worst, months: troughAt - peakAt };
}
const rise = (xs) => {
  let trough = Infinity, best = 0;
  for (const x of xs) { if (x < trough) trough = x; if (trough > 0 && x / trough - 1 > best) best = x / trough - 1; }
  return best;
};
const pct = (v) => (v * 100).toFixed(1) + "%";
const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

// Three lots that stay the same three lots for the whole run, so the series is
// a price and not a change of subject.
function pickLots(parcels) {
  const rows = bbls.map((b) => ({ b, d: parcels[b]?.demandScore ?? 0 })).filter((r) => r.d > 0)
    .sort((a, b) => a.d - b.d);
  return {
    fringe: rows[Math.floor(rows.length * 0.10)]?.b,
    ordinary: rows[Math.floor(rows.length * 0.50)]?.b,
    prime: rows[Math.floor(rows.length * 0.97)]?.b,
  };
}

const agg = { idxDD: [], idxRise: [], idxEnd: [], railLo: 0, railHi: 0, months: 0 };
const lotAgg = {};
const bldgDD = [];

for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const lots = pickLots(parcels);
  const series = { idx: [], bldg: [] };
  for (const k of Object.keys(lots)) (series[k] ??= []);

  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ, cpi = e.cpi || 1;
    series.idx.push(e.landIdx / cpi);
    agg.months++;
    if (e.landIdx <= 0.2501) agg.railLo++;
    if (e.landIdx >= 39.99) agg.railHi++;
    // THE UNDERWRITING BELIEFS ARE RAILS TOO, and new ones. `residualLandPsf`
    // prices dirt off the rent a developer EXPECTS and the cap they would exit
    // at, each carried as a ratio to spot and each bounded. Neither bound is
    // meant to bind — they are guards on ratios of two indices that track each
    // other — and a guard that binds in normal play is holding up the model.
    for (const k of ["office", "retail", "multifamily", "industrial"]) {
      agg.beliefN = (agg.beliefN ?? 0) + 1;
      const rb = (e.rentExp?.[k] ?? 0) / (e.rentIdx?.[k] || 1);
      const cb = (e.capExp?.[k] ?? 0) / (e.capRate?.[k] || 1);
      if (rb <= 0.5501 || rb >= 1.7499) agg.rentBeliefRail = (agg.rentBeliefRail ?? 0) + 1;
      if (cb <= 0.6001 || cb >= 1.6999) agg.capBeliefRail = (agg.capBeliefRail ?? 0) + 1;
    }
    // A standing building as the control: same city, same cycle, real terms.
    series.bldg.push((e.rentIdx.office / (e.capRate.office / 100)) / cpi);
    for (const [k, bbl] of Object.entries(lots)) {
      if (!bbl) continue;
      const rec = E.resolveRec(parcels, g, bbl);
      series[k].push(rec ? E.landPsfNow(rec, e) / cpi : 0);
    }
  }
  agg.idxDD.push(drawdown(series.idx).worst);
  agg.idxRise.push(rise(series.idx));
  agg.idxEnd.push(series.idx[series.idx.length - 1] / series.idx[0]);
  bldgDD.push(drawdown(series.bldg).worst);
  for (const k of ["fringe", "ordinary", "prime"]) {
    const s = series[k];
    if (!s?.length) continue;
    (lotAgg[k] ??= { dd: [], rise: [], end: [], lo: [], hi: [] });
    lotAgg[k].dd.push(drawdown(s).worst);
    lotAgg[k].rise.push(rise(s));
    lotAgg[k].end.push(s[s.length - 1] / Math.max(1e-9, s[0]));
    lotAgg[k].lo.push(Math.min(...s) / Math.max(1e-9, s[0]));
    lotAgg[k].hi.push(Math.max(...s) / Math.max(1e-9, s[0]));
  }
}

const med = (xs) => q(xs, 0.5);
console.log(`land, real terms — ${SEEDS.length} seeds x ${YRS}y\n`);
console.log(`CITY LAND INDEX (real)`);
console.log(`  worst drawdown      median ${pct(med(agg.idxDD))}   range ${pct(Math.min(...agg.idxDD))}..${pct(Math.max(...agg.idxDD))}`);
console.log(`  biggest run-up      median ${pct(med(agg.idxRise))}   range ${pct(Math.min(...agg.idxRise))}..${pct(Math.max(...agg.idxRise))}`);
console.log(`  end / start         median ${med(agg.idxEnd).toFixed(2)}x   range ${Math.min(...agg.idxEnd).toFixed(2)}..${Math.max(...agg.idxEnd).toFixed(2)}x`);
console.log(`  rails              floor 0.25 bound ${pct(agg.railLo / agg.months)} of months, ceiling 40 bound ${pct(agg.railHi / agg.months)}`);
console.log(`  underwriting rails rent belief bound ${pct((agg.rentBeliefRail ?? 0) / (agg.beliefN || 1))} of class-months,`
  + ` exit cap belief bound ${pct((agg.capBeliefRail ?? 0) / (agg.beliefN || 1))}`);
console.log(`\nA STANDING BUILDING, same cities (rent / cap, real) — the control`);
console.log(`  worst drawdown      median ${pct(med(bldgDD))}`);
console.log(`\nONE LOT, HELD THE WHOLE RUN (real $/sf)`);
for (const k of ["prime", "ordinary", "fringe"]) {
  const a = lotAgg[k]; if (!a) continue;
  console.log(`  ${k.padEnd(9)} drawdown ${pct(med(a.dd)).padStart(7)}   run-up ${pct(med(a.rise)).padStart(8)}   `
    + `end/start ${med(a.end).toFixed(2)}x   low ${med(a.lo).toFixed(2)}x  high ${med(a.hi).toFixed(2)}x`);
}
console.log(`\nreal-world anchors: Japanese urban land -70% (1991-2005); US land in the worst`);
console.log(`2008 markets -60..80%; a standing building in the same busts fell far less.`);
