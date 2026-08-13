// ONE FIXED RUN OF THE WORLD, REDUCED TO FIFTEEN NUMBERS.
//
// This is the measuring instrument for `tools/constants.mjs`. It takes a tree
// containing a built engine and a citygen, runs the same city for the same
// number of months with no player in it, and prints a JSON vector. Nothing
// here is a judgement — it is a ruler, and the audit reads it twice: once
// against the engine as written and once against an engine with a single
// number moved.
//
//   node tools/constants-probe.mjs <root>
//
// <root> holds test/.engine.mjs, test/city.mjs and src/. Determinism is the
// whole point: same root, same seeds, same output, to the last digit. If this
// file ever samples anything the audit cannot tell a moved constant from noise.
import { join } from "node:path";

const ROOT = process.argv[2];
if (!ROOT) { console.error("usage: constants-probe.mjs <root>"); process.exit(2); }

const SEEDS = Number(process.env.PROBE_SEEDS ?? 2);
const HZ = Number(process.env.PROBE_HZ ?? 200);
const SIZE = process.env.PROBE_SIZE ?? "town";

process.env.BW_SIZE = SIZE;
process.env.CITY_SEEDS = "1";

const E = await import(join(ROOT, "test", ".engine.mjs"));
const { loadCity } = await import(join(ROOT, "test", "city.mjs"));

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const ddOf = (a) => { let pk = -Infinity, d = 0; for (const v of a) { pk = Math.max(pk, v); d = Math.max(d, 1 - v / pk); } return d; };

/** One town, one market, no player. Returns the fifteen numbers. */
function run(i) {
  const { parcels: P0, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  const parcels = JSON.parse(JSON.stringify(P0));
  const seed = (2166136261 ^ ((i + 1) * 2654435761)) >>> 0;
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  // A fixed lot to watch land on — the largest vacant one, so the choice does
  // not itself move when a constant moves.
  const lot = bbls.filter((b) => parcels[b]?.class === "land")
    .sort((a, b) => (parcels[b].lotArea ?? 0) - (parcels[a].lotArea ?? 0))[0];

  const rent = [], eff = [], cap = [], vacO = [], vacR = [], land = [], unemp = [];
  let stock0 = 0, rent0 = 0, cost0 = 0, land0 = 0;
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ, cpi = e.cpi || 1;
    rent.push(e.rentIdx.office / cpi);
    eff.push((e.effRentIdx?.office ?? e.rentIdx.office) / cpi);
    cap.push(e.capRate.office);
    vacO.push(e.cityVac?.office ?? 0);
    vacR.push(e.cityVac?.retail ?? 0);
    unemp.push(e.unemployment ?? 0);
    if (lot) land.push(E.landPsfNow(parcels[lot], e) / cpi);
    if (m === 0) {
      stock0 = Object.values(e.stock ?? {}).reduce((a, v) => a + v, 0);
      rent0 = rent[0]; cost0 = e.costIdx / cpi; land0 = land[0] ?? 1;
    }
  }
  const e = g.econ, cpi = e.cpi || 1;
  const stockE = Object.values(e.stock ?? {}).reduce((a, v) => a + v, 0);
  const alive = (g.rivals ?? []).filter((r) => (r.aum ?? 0) > 0 || (r.bbls ?? []).length > 0);
  return {
    rentReal: rent[rent.length - 1] / rent0,
    rentDD: ddOf(rent),
    effReal: eff[eff.length - 1] / (eff[0] || 1),
    capMean: mean(cap),
    vacOffice: mean(vacO),
    vacRetail: mean(vacR),
    stockGrowth: stockE / Math.max(1, stock0),
    costReal: (e.costIdx / cpi) / (cost0 || 1),
    landReal: land.length ? land[land.length - 1] / (land0 || 1) : 1,
    landDD: land.length ? ddOf(land) : 0,
    firms: alive.length,
    aum: alive.reduce((a, r) => a + (r.aum ?? 0), 0) / cpi,
    cpi,
    unemp: mean(unemp),
    rate: e.indexRate,
  };
}

const out = {};
for (let i = 0; i < SEEDS; i++) {
  const v = run(i);
  for (const [k, x] of Object.entries(v)) (out[k] ??= []).push(x);
}
// Average across towns. A constant that only bites in one town still shows,
// because the average of a moved number and an unmoved one is still moved.
const vec = {};
for (const [k, a] of Object.entries(out)) vec[k] = mean(a);
console.log(JSON.stringify(vec));
