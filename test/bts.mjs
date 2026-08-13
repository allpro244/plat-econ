// BUILD-TO-SUIT: LOWER RENT, STRONGER FINANCING, DAY-ONE OCCUPANCY.
//
//   pnpm engine && pnpm exec node test/bts.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.newGame(71191, parcels, 500_000_000);
const bbl = bbls.find((b) => parcels[b]?.class === "land" && parcels[b]?.lotArea > 4_000);
if (!bbl) throw new Error("No BTS site.");
const rec = parcels[bbl];
const basis = Math.round(E.landValue(rec, g.econ));
g.holdings[bbl] = {
  bbl, boughtM: 0, costBasis: basis, assessed: basis, loan: null,
  condition: "average", condIdx: 0.55, svcIdx: 0.55,
  service: 0, stance: 0, plan: 1, tenants: [], cfHistory: [],
};
const floors = Math.min(4, E.maxFloorsFor(rec, 0.62, "industrial"));
const spec = E.planDevelopment(g, parcels, bbl, "industrial", floors, 0.62, "gmp");
const proposed = E.proposeBuildToSuit(g, parcels, bbl, "industrial", floors, 0.62);
if (proposed.err) throw new Error(proposed.err);
g = proposed.s;
const bts = g.btsProspects[bbl];
const anchored = E.planDevelopment(g, parcels, bbl, "industrial", floors, 0.62, "gmp",
  undefined, { bts });

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nBUILD-TO-SUIT DEVELOPMENT\n");
check(bts.credit >= 1 && bts.termM >= 180, "bankable tenant signs long paper before groundbreak");
check(bts.rentPsf > 0, "commitment carries fixed rent");
check(anchored.leaseUp < spec.leaseUp, "anchor reduces speculative lease-up reserve");
check(anchored.ltcMax >= spec.ltcMax, "signed lease supports at least as much construction financing");

const started = E.startDevelopment(g, parcels, bbl, "industrial", floors, 0.62, "gmp",
  anchored.ltcMax, { bts });
check(!started.err, "BTS project breaks ground");
g = started.s;
check(g.developments[bbl].bts?.name === bts.name, "named commitment is frozen on the job");
check(!g.btsProspects?.[bbl], "prospect leaves the pre-development desk at closing");

const d = g.developments[bbl];
g.month = d.deliverM;
E.tickDevelopments(g, parcels);
const tenant = g.holdings[bbl].tenants.find((t) => t.name === bts.name);
check(!!tenant, "named tenant takes possession at delivery");
check(tenant?.sf === bts.sf && tenant?.rentPsf === bts.rentPsf, "delivered lease matches signed BTS terms");
check(!g.developments[bbl], "completed BTS leaves construction");

console.log("");
process.exit(bad ? 1 : 0);
