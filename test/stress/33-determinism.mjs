// 33. DETERMINISM — run FIRST, because every paired experiment in this audit
// assumes that the same seed and the same inputs give the same world. If that
// is not true, every before/after number anybody has ever measured in this repo
// is noise wearing a decimal point.
//
//   node test/stress/33-determinism.mjs
//
// Three questions:
//   a) same seed twice, no player            -> identical state?
//   b) same seed twice, identical actions    -> identical state?
//   c) save -> serialise -> reload -> resume -> identical to never having saved?
import { assertFreshBundle } from "../fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "../.engine.mjs"));
const { loadCity } = await import(join(HERE, "../city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 360);

// A fingerprint that covers the parts of the world that matter, not just cash.
function print(g) {
  const e = g.econ;
  const round = (v) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(6) : v);
  return JSON.stringify({
    m: g.month, cash: round(g.cash), rng: g.rng,
    rent: Object.fromEntries(Object.entries(e.rentIdx ?? {}).map(([k, v]) => [k, round(v)])),
    cap: Object.fromEntries(Object.entries(e.capRate ?? {}).map(([k, v]) => [k, round(v)])),
    land: round(e.landIdx), cpi: round(e.cpi), jobs: round(e.jobs), pop: round(e.population),
    holdings: Object.keys(g.holdings ?? {}).sort(),
    listings: (g.listings ?? []).map((l) => `${l.bbl}:${l.ask}`).sort(),
    rivals: (g.rivals ?? []).map((r) => `${r.id}:${r.bbls.length}:${round(r.cash)}:${round(r.debt)}:${r.failedM ?? "-"}`),
    news: (g.news ?? []).length,
    built: Object.keys(g.built ?? {}).sort(),
    zone: JSON.stringify(g.zoneAdj ?? {}),
  });
}

// A deterministic scripted player, so (b) exercises the action paths too.
function act(g, parcels, m) {
  if (m % 9 === 0 && g.cash > 3_000_000) {
    for (const li of [...g.listings].slice(0, 5)) {
      const rec = E.resolveRec(parcels, g, li.bbl);
      if (!rec || g.holdings[li.bbl] || rec.class === "land") continue;
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, "senior", false, 1);
      if (!r.err) return r.s;
    }
  }
  for (const loi of [...g.lois]) {
    const rec = E.resolveRec(parcels, g, loi.bbl), h = g.holdings[loi.bbl];
    if (!rec || !h) continue;
    const mkt = E.managedRentPsfYr(rec, g.econ, h, loi.use);
    const r = E.respondLOI(g, parcels, loi.id, loi.rentPsf >= mkt * 0.92 ? "accept" : "pass");
    if (!r.err) g = r.s;
  }
  return g;
}

function run(seed, { player = false, saveAt = -1 } = {}) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    if (player) g = act(g, parcels, m);
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // The save path is a structured clone in the browser; JSON is the stricter
    // test because it also catches undefined, Map, Set and NaN.
    if (m === saveAt) g = JSON.parse(JSON.stringify(g));
  }
  return g;
}

const fails = [];
console.log(`33. DETERMINISM — ${SEEDS.length} seeds x ${HZ} months\n`);
for (const seed of SEEDS) {
  const a = print(run(seed));
  const b = print(run(seed));
  const ok1 = a === b;

  const c = print(run(seed, { player: true }));
  const d = print(run(seed, { player: true }));
  const ok2 = c === d;

  const e1 = print(run(seed, { player: true }));
  const e2 = print(run(seed, { player: true, saveAt: Math.floor(HZ / 2) }));
  const ok3 = e1 === e2;

  console.log(`  seed ${String(seed).padStart(7)}   no player ${ok1 ? "same" : "DIVERGED"}   `
    + `with player ${ok2 ? "same" : "DIVERGED"}   save/reload ${ok3 ? "same" : "DIVERGED"}`);
  if (!ok1) fails.push(`${seed}: idle runs diverge`);
  if (!ok2) fails.push(`${seed}: player runs diverge`);
  if (!ok3) fails.push(`${seed}: a save/reload changes the future`);
}

console.log();
if (fails.length) {
  console.log(`FAIL  ${fails.length} divergence(s):`);
  for (const f of fails) console.log(`      ${f}`);
  console.log(`      Every paired measurement in this repo rests on this. Nothing else in`);
  console.log(`      the audit means anything until it holds.`);
  process.exit(1);
}
console.log(`OK    the world is reproducible: same seed, same actions, same city —`);
console.log(`      and a save/reload does not change what happens next.`);
