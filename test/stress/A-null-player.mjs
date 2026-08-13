// A. THE NULL PLAYER, AND ITS MIRROR.
//
//   node test/stress/A-null-player.mjs
//
// Two failure modes, and they are opposites. A world that only moves because
// the player moves it is a response function, not a simulation. A world that
// cannot feel the player at all is a diorama. Both are measured here on the
// same seeds: an empty chair, and a bot deploying capital as hard as it can.
import { assertFreshBundle } from "../fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "../.engine.mjs"));
const { loadCity } = await import(join(HERE, "../city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11").split(",").map(Number);
const YRS = Number(process.env.YRS ?? 50);
const MARKS = [0, 25, 50].filter((y) => y <= YRS);

const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function snapshot(g, parcels) {
  const e = g.econ, cpi = e.cpi || 1;
  let built = 0, vacantLots = 0, sf = 0, maxFl = 0;
  const fl = [];
  for (const b of bbls) {
    const r = E.resolveRec(parcels, g, b);
    if (!r) continue;
    if (r.class === "land" || !(r.floors > 0)) { vacantLots++; continue; }
    built++; fl.push(r.floors); sf += r.bldgArea ?? 0;
    if (r.floors > maxFl) maxFl = r.floors;
  }
  const live = (g.rivals ?? []).filter((r) => r.failedM === undefined);
  return {
    built, vacantPct: vacantLots / bbls.length, medFl: q(fl, 0.5), maxFl, sfM: sf / 1e6,
    rentOff: e.rentIdx.office / cpi, vacOff: e.cityVac?.office ?? 0, land: e.landIdx / cpi,
    firms: live.length, failed: (g.rivals ?? []).length - live.length,
    rivalSf: live.reduce((a, r) => a + r.bbls.length, 0),
    delivered: Object.keys(g.built ?? {}).length + (g.cityBuilt ?? []).length,
  };
}

// The mirror: a bot that deploys as hard as the rules allow.
function greedy(g, parcels) {
  let guard = 0;
  while (g.cash > 2_000_000 && guard++ < 6) {
    let did = false;
    for (const li of [...g.listings]) {
      if (g.holdings[li.bbl]) continue;
      const rec = E.resolveRec(parcels, g, li.bbl);
      if (!rec) continue;
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, rec.class === "land" ? "cash" : "senior", false, 1);
      if (!r.err) { g = r.s; did = true; break; }
    }
    if (!did) break;
  }
  for (const b of Object.keys(g.holdings)) {
    const rec = E.resolveRec(parcels, g, b);
    if (rec && rec.class === "land" && !g.developments[b] && g.cash > 6_000_000) {
      const d = E.startDevelopment(g, parcels, b, "office", 8);
      if (!d.err) g = d.s;
    }
  }
  for (const loi of [...g.lois]) {
    const rec = E.resolveRec(parcels, g, loi.bbl), h = g.holdings[loi.bbl];
    if (!rec || !h) continue;
    const r = E.respondLOI(g, parcels, loi.id, "accept");
    if (!r.err) g = r.s;
  }
  return g;
}

const arms = { null: [], greedy: [] };
for (const seed of SEEDS) {
  for (const arm of ["null", "greedy"]) {
    const parcels = JSON.parse(JSON.stringify(P0));
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    // The greedy arm is given deep pockets on purpose: the question is whether
    // UNLIMITED capital leaves a dent, not whether $2.5M does.
    if (arm === "greedy") g = { ...g, cash: 250_000_000 };
    const snaps = {};
    for (let m = 0; m <= YRS * 12; m++) {
      const yr = m / 12;
      if (MARKS.includes(yr)) snaps[yr] = snapshot(g, parcels);
      if (m === YRS * 12) break;
      if (g.gameOver) g = { ...g, gameOver: null, cash: arm === "greedy" ? 250_000_000 : 6e6 };
      if (arm === "greedy") { g = greedy(g, parcels); if (g.cash < 50_000_000) g = { ...g, cash: 250_000_000 }; }
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
    }
    arms[arm].push({ seed, snaps, held: Object.keys(g.holdings).length });
  }
}

const col = (arm, yr, k) => mean(arms[arm].map((r) => r.snaps[yr]?.[k]).filter(Number.isFinite));
console.log(`A. NULL PLAYER vs MAXIMALLY ACTIVE — ${SEEDS.length} seeds x ${YRS}y\n`);
for (const arm of ["null", "greedy"]) {
  console.log(`${arm === "null" ? "NO PLAYER AT ALL" : "A PLAYER WITH $250M AND NO PATIENCE"}`);
  console.log(`  year  buildings  vacantLots  medFl  maxFl   builtSF(M)  realRentOff  vacOff  realLand  firms  failed`);
  for (const yr of MARKS) {
    console.log(
      String(yr).padStart(6) + String(Math.round(col(arm, yr, "built"))).padStart(11) +
      (col(arm, yr, "vacantPct") * 100).toFixed(1).padStart(11) + "%" +
      col(arm, yr, "medFl").toFixed(1).padStart(7) + col(arm, yr, "maxFl").toFixed(0).padStart(7) +
      col(arm, yr, "sfM").toFixed(1).padStart(13) + col(arm, yr, "rentOff").toFixed(1).padStart(13) +
      (col(arm, yr, "vacOff") * 100).toFixed(1).padStart(8) + "%" +
      col(arm, yr, "land").toFixed(2).padStart(10) + col(arm, yr, "firms").toFixed(1).padStart(7) +
      col(arm, yr, "failed").toFixed(1).padStart(8));
  }
  console.log();
}
console.log(`THE PLAYER'S DENT — greedy minus null at year ${YRS}, on identical seeds:`);
for (const k of ["built", "sfM", "rentOff", "vacOff", "land", "firms"]) {
  const a = col("null", YRS, k), b = col("greedy", YRS, k);
  const d = k === "vacOff" ? `${((b - a) * 100).toFixed(2)}pp` : `${(((b - a) / Math.abs(a || 1)) * 100).toFixed(1)}%`;
  console.log(`  ${k.padEnd(10)} ${String(a.toFixed(2)).padStart(10)} -> ${String(b.toFixed(2)).padStart(10)}   ${d}`);
}
console.log(`  the greedy arm ended holding ${mean(arms.greedy.map((r) => r.held)).toFixed(0)} buildings`);
