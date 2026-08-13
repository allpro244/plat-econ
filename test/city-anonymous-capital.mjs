// ANONYMOUS CITY JOBS ARE NOT FREE CAPITAL.
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

console.log("\nANONYMOUS CITY CONSTRUCTION CAPITAL\n");

{
  const g = E.newGame(44101, parcels);
  g.month = 5;
  // Replenish adds one month of capacity first; a mid-curve $200M job still
  // outruns that injection when the pool starts empty.
  g.econ.jobs = 25_000;
  g.econ.creditIdx = 0.4;
  g.econ.cityBuildCash = 0;
  g.cityJobs = [{
    bbl: Object.keys(parcels)[0],
    use: "office", sf: 400_000, floors: 40, startM: 0, deliverM: 12,
    cost: 200_000_000, spent: 0, equityLeft: 60_000_000,
    debt: 0, commitment: 140_000_000, ratePct: 8,
    lender: "Merchant builders",
  }];
  E.fundJobs(g);
  check(g.cityJobs[0].orphaned === true,
    "anonymous job orphans when the city construction pool cannot fund the month");
  check((g.news[0]?.text ?? "").toLowerCase().includes("construction pool")
    || (g.news[0]?.text ?? "").toLowerCase().includes("merchant"),
    "orphan news names the construction-pool failure");
}

{
  const g = E.newGame(44102, parcels);
  g.month = 5;
  g.econ.cityBuildCash = 80_000_000;
  g.cityJobs = [{
    bbl: Object.keys(parcels)[0],
    use: "office", sf: 20_000, floors: 5, startM: 0, deliverM: 10,
    cost: 5_000_000, spent: 0, equityLeft: 1_500_000,
    debt: 0, commitment: 3_500_000, ratePct: 8,
    lender: "Merchant builders",
  }];
  const before = g.econ.cityBuildCash;
  E.fundJobs(g);
  check(!g.cityJobs[0].orphaned, "funded anonymous job continues when the pool can carry it");
  check((g.cityJobs[0].spent ?? 0) > 0, "anonymous job books work-in-place against the pool");
  check((g.econ.cityBuildCash ?? 0) < before + 20_000_000,
    "city construction pool is drawn (replenish does not erase the spend)");
}

{
  const g = E.newGame(44103, parcels);
  g.month = 5;
  // Legacy unstamped anonymous jobs keep the free path so old saves survive.
  g.econ.cityBuildCash = 0;
  g.cityJobs = [{
    bbl: Object.keys(parcels)[0],
    use: "retail", sf: 8_000, floors: 2, startM: 0, deliverM: 8,
  }];
  E.fundJobs(g);
  check(!g.cityJobs[0].orphaned, "legacy unstamped anonymous jobs are not mass-orphaned");
}

console.log("");
process.exit(bad ? 1 : 0);
