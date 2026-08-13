// PLAYTEST HARNESS — ECONOMY + DEMAND OBSERVER (research only)
//
// 100-year passive run; harvests econ.history and block-demand dispersion.
// Reuse this for before/after demand tuning — do not fork a second century harness.
//
//   node tools/pt-econ.mjs '{"citySeed":1,"marketSeed":2,"size":"city"}'
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = await import(join(ROOT, "test/.engine.mjs"));
const { makeCity, cityName, PROCEDURAL } = await import(join(ROOT, "src/citygen/index.mjs"));

const cfg = JSON.parse(process.argv[2]);
const MONTHS = cfg.months ?? 1200;

const built = makeCity(PROCEDURAL, cfg.citySeed, { size: cfg.size });
E.normalizeParcels(built.parcels);
const parcels = built.parcels;
const adjacency = built.adjacency;
const bbls = Object.keys(parcels);

let g = E.firstListings(E.newGame(cfg.marketSeed, parcels, 5_000_000), parcels, bbls);
g.citySize = cfg.size;
g.citySeed = cfg.citySeed;

const landCohort = bbls.filter((b) => {
  const p = parcels[b];
  return p && p.lotArea > 0;
});

let resurrections = 0;
const landSnaps = [];
const demandSnaps = [];
const rivalFailM = [];
let rivalsAtStart = 0;

function demandStats() {
  const e = Object.values(g.blockE ?? {});
  const d = Object.values(g.blockD ?? {});
  if (!e.length) return { nE: 0, nD: 0, maxE: 0, spreadE: 0, meanE: 0, maxD: 0, spreadD: 0 };
  const maxE = Math.max(...e.map(Math.abs));
  const spreadE = Math.max(...e) - Math.min(...e);
  const meanE = e.reduce((a, b) => a + b, 0) / e.length;
  const maxD = d.length ? Math.max(...d.map(Math.abs)) : 0;
  const spreadD = d.length ? Math.max(...d) - Math.min(...d) : 0;
  return { nE: e.length, nD: d.length, maxE: +maxE.toFixed(2), spreadE: +spreadE.toFixed(2), meanE: +meanE.toFixed(2), maxD: +maxD.toFixed(2), spreadD: +spreadD.toFixed(2) };
}

for (let m = 0; m < MONTHS; m++) {
  const deadBefore = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
  g = E.advanceMonth(g, parcels, bbls, adjacency);
  if (m === 0) rivalsAtStart = (g.rivals ?? []).length;
  const deadAfter = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
  if (deadAfter > deadBefore) {
    for (const r of g.rivals ?? []) {
      if (r.failedM !== undefined && !rivalFailM.some((x) => x.name === r.name)) {
        rivalFailM.push({ name: r.name, style: r.style, m: r.failedM });
      }
    }
  }
  if (g.gameOver) { g = { ...g, gameOver: null, cash: 6e6 }; resurrections++; }

  if (m % 60 === 59) {
    const vals = [];
    for (const b of landCohort) {
      const rec = E.resolveRec(parcels, g, b) ?? parcels[b];
      if (!rec) continue;
      const v = E.landValue(rec, g.econ);
      if (Number.isFinite(v) && v > 0) vals.push(v / Math.max(1, rec.lotArea));
    }
    vals.sort((a, b) => a - b);
    const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
    landSnaps.push({
      m, n: vals.length,
      p10: q(0.10), p50: q(0.50), p90: q(0.90), p99: q(0.99),
      mean: vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length),
      cpi: g.econ.cpi,
    });
    demandSnaps.push({ m, ...demandStats(), lines: (g.lines ?? []).length });
  }
}

const hist = (g.econ.history ?? []).map((h) => ({
  q: h.q,
  rate: h.indexRate, regime: h.rateRegime,
  land: h.landIdx, cost: h.costIdx, cpi: h.cpi,
  cyc: h.cycleDev, credit: h.creditIdx, emp: h.employIdx,
  pop: h.population, jobs: h.jobs, unemp: h.unemployment,
  wage: h.wageIdx, out: h.outputIdx, infl: h.inflExp,
  vac: h.vac, rent: h.rent, effRent: h.effRent, cap: h.cap,
  abs: h.abs, comp: h.comp,
}));

process.stdout.write(JSON.stringify({
  kind: "econ",
  cfg: { ...cfg, cityName: cityName(PROCEDURAL, cfg.citySeed), lots: bbls.length },
  months: MONTHS,
  resurrections,
  rivalsAtStart,
  rivalFails: rivalFailM,
  rivalsAlive: (g.rivals ?? []).filter((r) => r.failedM === undefined).length,
  landSnaps,
  demandSnaps,
  demandFinal: demandStats(),
  hist,
  finalStock: g.econ.stock,
  built: g.built ?? 0,
  demolished: g.demolished ?? 0,
  cityBuilt: g.cityBuilt ?? 0,
}));
