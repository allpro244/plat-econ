// ADAPTIVE REUSE RETIRES OLD SPACE AND DELIVERS THE NEW PROGRAMME ONCE.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);
let g = E.newGame(31917, parcels, 500_000_000);
g.econ.costIdx *= 0.55;
g.econ.rentIdx.multifamily *= 2.2;
g.econ.effRentIdx = { ...(g.econ.effRentIdx ?? g.econ.rentIdx), multifamily: g.econ.rentIdx.multifamily };

let chosen = null;
for (const bbl of bbls) {
  const rec = E.resolveRec(parcels, g, bbl);
  if (!rec || rec.class === "land" || rec.class === "multifamily" || rec.bldgArea < 5_000) continue;
  const basis = Math.round(E.assetValue(rec, g.econ, "standard"));
  g.holdings[bbl] = {
    bbl, boughtM: 0, costBasis: basis, assessed: basis, loan: null,
    condition: "standard", condIdx: 0.6, svcIdx: 0.55,
    service: 0, stance: 0, plan: 1, tenants: [], occ: 0, cfHistory: [],
  };
  const plan = E.planAdaptiveReuse(g, parcels, bbl, "multifamily");
  if (plan?.hurdleRatio >= 1) { chosen = { bbl, rec, plan }; break; }
  delete g.holdings[bbl];
}
if (!chosen) throw new Error("Could not find an economic reuse candidate.");

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nADAPTIVE REUSE\n");
const { bbl, rec, plan } = chosen;
const oldUse = rec.class;
const beforeOld = g.econ.stock[oldUse];
const beforeMf = g.econ.stock.multifamily;
check(E.adaptiveReuseEligibility(g, parcels, bbl).ok, "empty commercial shell is eligible");

const started = E.startAdaptiveReuse(g, parcels, bbl, "multifamily");
check(!started.err, "economic conversion starts");
g = started.s;
check(g.developments[bbl]?.mode === "reuse", "conversion uses existing development lifecycle");
check(g.econ.deliveryQueue.some((p) => p.bbl === bbl && p.source === "reuse"), "one reuse delivery is queued");
check(g.econ.stock[oldUse] < beforeOld, "old use is retired at conversion start");

// Site-risk can slip the schedule a few months; settle/clawback keep the
// queue honest, so wait for the physical delivery rather than a fixed clock.
const until = g.month + plan.months + 18;
while (g.developments[bbl] && g.month < until) {
  if (g.gameOver) g = { ...g, gameOver: null, cash: 500_000_000 };
  g = E.advanceMonth(g, parcels, bbls, adjacency);
  g.cash = Math.max(g.cash, 500_000_000);
}
const after = E.resolveRec(parcels, g, bbl);
console.log("  delivered programme", after.class, JSON.stringify(after.mix ?? {}));
check(!g.developments[bbl], "conversion completes");
check((after.mix?.multifamily ?? (after.class === "multifamily" ? 1 : 0)) > 0.5, "delivered shell is housing-dominant");
check(g.econ.stock.multifamily > beforeMf, "new housing enters city stock at delivery");
check(!g.econ.deliveryQueue.some((p) => p.bbl === bbl), "delivery queue clears exactly once");

console.log("");
process.exit(bad ? 1 : 0);
