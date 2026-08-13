// DOES THE PRO FORMA COME TRUE?
//
// A bot playing fifty years tells you whether a strategy wins; it cannot tell
// you whether a single building did what its underwriting promised, because a
// portfolio launders every mistake into one number at the end. This does the
// opposite: one building at a time, unlimited cash, no strategy, no selling.
// Buy the dirt, build it, sign every letter that comes, and mark it at the
// day it opens and at three, five, ten and twenty years after.
//
// The column that matters is the multiple of basis against the multiple the
// pro forma promised. If a class delivers at half its underwriting on every
// site in the city, that is not a hard market — that is a broken valuation,
// and this harness is how it was caught: every commercial building in the
// game was being appraised as though its whole rent roll were still inside
// its free-rent period, forever.
//
//   pnpm devyield                 all four classes, four sites each
//   USE=office pnpm devyield      one class
//   DEEP=1 pnpm devyield          the value decomposition, line by line
//   SEED=7 HOLDY=30 pnpm devyield
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);
const M = (n) => `$${(n / 1e6).toFixed(1)}M`;

const USES = (process.env.USE ?? "office,multifamily,retail,industrial").split(",");
const SEED = Number(process.env.SEED ?? 3);
const HOLD_Y = Number(process.env.HOLDY ?? 20);
const PCTS = [0.0, 0.25, 0.5, 0.75];

function base() {
  let g = E.firstListings(E.newGame(SEED, parcels), parcels, bbls);
  return { ...g, cash: g.cash + 400e6 };
}

function rank(g, use) {
  const out = [];
  for (const bbl of bbls) {
    const rec = parcels[bbl];
    if (!rec.lotArea || rec.lotArea < 4000 || rec.bldgArea > 0) continue;
    const fl = Math.min(E.maxFloorsFor(rec, 0.6), 14);
    const plan = E.planDevelopment(g, parcels, bbl, use, fl, 0.6, "gmp");
    if (!plan || plan.yieldOnCost <= plan.exitCap) continue;   // only sites that pencil
    out.push({ bbl, fl, plan, spread: plan.yieldOnCost - plan.exitCap });
  }
  out.sort((a, b) => b.spread - a.spread);
  return out;
}

function run(use, site) {
  let g = base();
  const { bbl, fl, plan } = site;
  const rec0 = parcels[bbl];
  g = { ...g, holdings: { ...g.holdings, [bbl]: {
    bbl, costBasis: Math.round(E.landValue(rec0, g.econ)), boughtM: g.month,
    condition: "good", tenants: [], programsDone: {}, loan: null, cfHistory: [],
  } } };
  const r0 = E.startDevelopment(g, parcels, bbl, use, fl, 0.6, "gmp");
  if (r0.err) return { err: r0.err };
  g = r0.s;

  let deliveredM = null, atDeliver = null;
  const marks = {};
  for (let m = 0; m < (HOLD_Y + 8) * 12; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    for (const loi of [...g.lois]) {
      if (loi.bbl !== bbl) continue;
      const r = E.respondLOI(g, parcels, loi.id, "accept", true);
      g = r.err ? E.respondLOI(g, parcels, loi.id, "pass").s : r.s;
    }
    const h = g.holdings[bbl];
    if (!h) break;
    if (!deliveredM && h.deliveredM !== undefined) {
      deliveredM = g.month;
      atDeliver = { basis: h.costBasis, debt: h.loan?.balance ?? 0 };
    }
    if (deliveredM) {
      for (const y of [0, 3, 5, 10, HOLD_Y]) {
        if (g.month === deliveredM + y * 12 && !marks[y]) {
          const rec = E.resolveRec(parcels, g, bbl);
          const os = E.operatingStatement(rec, g.econ, h, g.month);
          marks[y] = {
            value: E.holdingValue(rec, g.econ, h, g.month),
            noi: E.holdingNOIYr(rec, g.econ, h, g.month),
            occ: os.leasedSf / Math.max(1, rec.bldgArea),
            cap: E.capRateFor(rec, g.econ, h.condition),
            spread: E.rollQualitySpread(rec, h, g.month),
            rent: os.baseRent / Math.max(1, os.leasedSf),
            mkt: E.marketRentPsfYr(rec, g.econ, h.condition),
            debt: h.loan?.balance ?? 0,
            noiYr: E.noiYr(rec, g.econ, h.condition),
            land: E.landValue(rec, g.econ),
            os,
          };
        }
      }
      if (g.month >= deliveredM + HOLD_Y * 12) break;
    }
  }
  return { plan, atDeliver, deliveredM, marks };
}

const g0 = base();
for (const use of USES) {
  const list = rank(g0, use);
  console.log(`\n=== ${use.toUpperCase()} — ${list.length} sites pencil of ${bbls.length}`);
  if (!list.length) continue;
  for (const p of PCTS) {
    const site = list[Math.min(list.length - 1, Math.floor(p * (list.length - 1)))];
    const r = run(use, site);
    if (r.err) { console.log(`  p${(p * 100).toFixed(0)} ${site.bbl}: ${r.err}`); continue; }
    const pl = r.plan;
    const proNoi = (pl.yieldOnCost / 100) * pl.basisTotal;
    console.log(`  p${(p * 100).toFixed(0)} ${site.bbl} ${pl.sf.toLocaleString()}sf/${pl.floors}fl · cost ${M(pl.costTotal)} + land ${M(pl.landBasis)} = basis ${M(pl.basisTotal)}`);
    console.log(`       pro forma: NOI ${M(proNoi)} · YoC ${pl.yieldOnCost.toFixed(2)}% vs exit ${pl.exitCap.toFixed(2)}% → value ${M(proNoi / (pl.exitCap / 100))} (${(proNoi / (pl.exitCap / 100) / pl.basisTotal).toFixed(2)}x)`);
    console.log(`       delivered m${r.deliveredM} basis ${M(r.atDeliver.basis)} debt ${M(r.atDeliver.debt)}`);
    for (const y of [0, 3, 5, 10, HOLD_Y]) {
      const k = r.marks[y];
      if (!k) continue;
      console.log(`       +${String(y).padStart(2)}y  value ${M(k.value).padStart(8)} (${(k.value / r.atDeliver.basis).toFixed(2)}x basis) · NOI ${M(k.noi).padStart(7)} · occ ${(k.occ * 100).toFixed(0)}% · rent ${k.rent.toFixed(0)} vs mkt ${k.mkt.toFixed(0)} · cap ${k.cap.toFixed(2)}+${k.spread.toFixed(2)} · debt ${M(k.debt)}`);
      if (process.env.DEEP) {
        const c = Math.max(0.028, Math.min(0.13, (k.cap + k.spread) / 100));
        console.log(`             inPlaceNOI ${(k.noi / 1e6).toFixed(2)}M/${(c * 100).toFixed(2)}% = ${(k.noi / c / 1e6).toFixed(2)}M · stabNOI ${(k.noiYr / 1e6).toFixed(2)}M → ${(k.noiYr / (c + 0.011) / 1e6).toFixed(2)}M · land*.92 ${(k.land * 0.92 / 1e6).toFixed(2)}M`);
        console.log(`             opex ${(k.os.opex / 1e6).toFixed(2)}M tax ${(k.os.tax / 1e6).toFixed(2)}M mgmt ${(k.os.mgmt / 1e6).toFixed(2)}M · base ${(k.os.baseRent / 1e6).toFixed(2)}M rec ${((k.os.recoveredOpex + k.os.recoveredTax) / 1e6).toFixed(2)}M · opexPsf ${k.os.opexPsf.toFixed(2)} taxPsf ${k.os.taxPsf.toFixed(2)}`);
      }
    }
  }
}
