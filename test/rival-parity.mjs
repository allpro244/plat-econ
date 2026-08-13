// NAMED COMPETITORS PAY FOR CONSTRUCTION AND FORECLOSURE CURES.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels } = loadCity(0, E.normalizeParcels);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nRIVAL ECONOMIC PARITY\n");

{
  const g = E.newGame(98211, parcels);
  const r = g.rivals[0];
  r.cash = 0;
  r.debt = 100_000;
  g.month = 5;
  g.cityJobs = [{
    bbl: r.bbls[0] ?? Object.keys(parcels)[0],
    use: "office", sf: 20_000, floors: 5, startM: 0, deliverM: 10,
    firmId: r.id, cost: 1_000_000, spent: 0, equityLeft: 0,
    debt: 100_000, commitment: 100_000, ratePct: 8,
  }];
  E.fundJobs(g);
  check(g.cityJobs[0].orphaned === true,
    "rival job stops when commitment is exhausted and sponsor cannot fund the call");
  check((g.cityJobs[0].debt ?? 0) <= (g.cityJobs[0].commitment ?? 0),
    "rival construction debt never exceeds its commitment");
}

{
  const g = E.newGame(98212, parcels);
  const r = g.rivals.find((x) => x.bbls.length) ?? g.rivals[0];
  const bbl = r.bbls[0] ?? Object.keys(parcels)[0];
  if (!r.bbls.includes(bbl)) r.bbls.push(bbl);
  r.cash = 200_000;
  r.stressMs = 0;
  g.lenders = [];
  g.bankFcls = [{
    bbl, lender: "Harbor National", firmId: r.id, firm: r.name,
    debt: 1_000_000, noticedM: 20, saleM: 30,
  }];
  const before = r.cash;
  E.tickBankForeclosures(g, parcels);
  check(!g.bankFcls.some((x) => x.bbl === bbl), "funded rival foreclosure reinstates");
  check(before - r.cash === 80_000, "rival actually pays the 8% cure rather than winning a free lottery");
}

{
  const g = E.newGame(98213, parcels);
  const r = g.rivals[0];
  r.cash = 20_000_000;
  r.debt = 1_000_000;
  g.month = 1;
  g.cityJobs = [{
    bbl: r.bbls[0] ?? Object.keys(parcels)[0],
    use: "office", sf: 200_000, floors: 20, startM: 0, deliverM: 10,
    firmId: r.id, cost: 100_000_000, spent: 0, equityLeft: 0,
    debt: 1_000_000, commitment: 70_000_000, ratePct: 8,
    lender: "Regional Bank", repudiatedM: 0, replaceM: 0,
  }];
  E.fundJobs(g);
  check(g.cityJobs[0].repudiatedM !== undefined,
    "replacement lender refuses a facility whose total sources cannot finish the rival job");
}

{
  const g = E.newGame(98214, parcels);
  const r = g.rivals[0];
  r.mktOcc = 0.88;
  r.occ = 0.72;
  const source = Object.values(parcels).find((x) => x.class !== "land" && x.bldgArea > 0);
  const low = { ...source, demandScore: 12 };
  const high = { ...source, demandScore: 92 };
  const markedLow = E.markAsset(g, r, low);
  const markedHigh = E.markAsset(g, r, high);
  const baseLow = E.assetValue(low, g.econ, E.assetGrade(r, low));
  const baseHigh = E.assetValue(high, g.econ, E.assetGrade(r, high));
  const lowScale = markedLow.v / Math.max(1, baseLow);
  const highScale = markedHigh.v / Math.max(1, baseHigh);
  check(lowScale < highScale,
    "portfolio stress penalizes a weak rival asset more than a strong one");
}

console.log("");
process.exit(bad ? 1 : 0);
