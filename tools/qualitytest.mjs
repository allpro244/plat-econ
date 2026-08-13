// WHAT IS QUALITY ACTUALLY WORTH?
//
//   pnpm quality
//
// The owner's question, and it is the right one to ask before adding a slider
// that lets you buy quality: does the condition of a building move the rent it
// gets and the occupancy it holds, or is it a label?
//
// The control is strict. TWO PARCELS with the same demand score, the same lot,
// the same floor plate, the same use, the same year — cloned from one another
// so that literally the only difference is what condition they are in. Then
// the same city runs around both of them for twenty years and we read off what
// each one achieved.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "..", "test", ".engine.mjs"));
const { makeCity } = await import(join(HERE, "..", "src", "citygen", "index.mjs"));

const CITY_SEED = Number(process.env.CITY_SEED ?? 20261);
const SEEDS = [550991, 12007, 73303];
const YEARS = Number(process.env.YEARS ?? 20);
const GRADES = ["obsolete", "worn", "standard", "good"];
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor((b.length - 1) / 2)]; };
const pct = (x) => (x * 100).toFixed(1) + "%";

const built = makeCity(process.env.BW_CITY ?? "somewhere", CITY_SEED);
E.normalizeParcels(built.parcels);
const BASE = built.parcels, BBLS = Object.keys(BASE), ADJ = built.adjacency;

// Find a clean mid-market office building to be the template, and a set of
// twin lots with the SAME demand score to plant copies of it on.
function twins() {
  const byDemand = new Map();
  for (const b of BBLS) {
    const r = BASE[b];
    if (!r || r.class !== "office" || !r.bldgArea) continue;
    const k = Math.round(r.demandScore);
    if (!byDemand.has(k)) byDemand.set(k, []);
    byDemand.get(k).push(b);
  }
  let best = null;
  for (const [d, list] of byDemand) {
    if (list.length < GRADES.length) continue;
    if (!best || Math.abs(d - 62) < Math.abs(best.d - 62)) best = { d, list };
  }
  return best;
}

const t = twins();
if (!t) { console.log("no twin set found"); process.exit(1); }
console.log(`\nCONTROL: ${GRADES.length} office parcels, all at demand ${t.d}/100, made identical except for condition.`);

const rows = [];
for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(BASE));
  // make the twins literally identical
  const tmpl = parcels[t.list[0]];
  const lots = t.list.slice(0, GRADES.length);
  for (const b of lots) {
    const r = parcels[b];
    r.bldgArea = tmpl.bldgArea; r.floors = tmpl.floors; r.lotArea = tmpl.lotArea;
    r.yearBuilt = 1978; r.class = "office"; r.mix = undefined; r.unitsRes = 0;
    r.demandScore = t.d;
  }
  let g = E.firstListings(E.newGame(seed, parcels), parcels, BBLS);
  // buy all four, then pin each to a different condition and hold it there
  for (let i = 0; i < lots.length; i++) {
    const b = lots[i];
    const rec = E.resolveRec(parcels, g, b);
    const px = E.assetValue(rec, g.econ, "standard");
    g.cash = 5e9;
    const r = E.executePurchase(g, parcels, b, Math.round(px), "cash", true, 1);
    if (r.err) { console.log("buy failed", b, r.err); continue; }
    g = r.s;
  }
  const pin = () => {
    for (let i = 0; i < lots.length; i++) {
      const h = g.holdings[lots[i]];
      if (!h) continue;
      h.condition = GRADES[i];
      h.condIdx = [0.20, 0.42, 0.64, 0.90][i];
    }
  };
  pin();
  const acc = lots.map(() => ({ rent: [], occ: [], val: [], letters: 0, leased: 0 }));
  for (let m = 0; m < YEARS * 12; m++) {
    g = E.advanceQuarter(g, parcels, BBLS, ADJ);
    pin();                                     // hold the grade: this is the experiment
    // answer every letter at market so lease-up speed is the only variable
    for (const loi of [...g.lois]) {
      const idx = lots.indexOf(loi.bbl);
      if (idx >= 0) acc[idx].letters++;
      const r = E.respondLOI(g, parcels, loi.id, "accept");
      if (!r.err) { g = r.s; if (idx >= 0) acc[idx].leased++; }
    }
    if (m % 3 === 0) {
      for (let i = 0; i < lots.length; i++) {
        const rec = E.resolveRec(parcels, g, lots[i]);
        const h = g.holdings[lots[i]];
        if (!rec || !h) continue;
        acc[i].rent.push(E.managedRentPsfYr(rec, g.econ, h));
        const occ = h.tenants?.length
          ? h.tenants.reduce((a, x) => a + (x.sf ?? 0), 0) / Math.max(1, rec.bldgArea) : 0;
        acc[i].occ.push(occ);
        acc[i].val.push(E.assetValue(rec, g.econ, h.condition));
      }
    }
  }
  rows.push(acc);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`\n${YEARS} years, ${SEEDS.length} seeds, every letter accepted at market on all four.\n`);
console.log("grade      asking rent $/sf   occupancy achieved   letters drawn   value $/sf");
const out = [];
for (let i = 0; i < GRADES.length; i++) {
  const rent = med(rows.map((r) => mean(r[i].rent)));
  const occ = med(rows.map((r) => mean(r[i].occ)));
  const lets = med(rows.map((r) => r[i].letters));
  const val = med(rows.map((r) => mean(r[i].val)));
  out.push({ grade: GRADES[i], rent, occ, lets, val });
  console.log(`${GRADES[i].padEnd(10)} ${rent.toFixed(2).padStart(14)}   ${pct(occ).padStart(18)}   ${String(lets).padStart(13)}   ${(val / 1e3).toFixed(0).padStart(10)}k`);
}
const g0 = out[0], g3 = out[3];
console.log(`\nobsolete -> good:`);
console.log(`  asking rent  ${((g3.rent / Math.max(0.01, g0.rent) - 1) * 100).toFixed(1)}%`);
console.log(`  occupancy    ${((g3.occ - g0.occ) * 100).toFixed(1)}pp`);
console.log(`  letters      ${((g3.lets / Math.max(1, g0.lets) - 1) * 100).toFixed(1)}%   (does a better building get SHOWN more?)`);
console.log(`  value        ${((g3.val / Math.max(1, g0.val) - 1) * 100).toFixed(1)}%`);
console.log("");
