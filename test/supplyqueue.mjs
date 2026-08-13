// ONE PHYSICAL PROJECT, ONE ECONOMIC DELIVERY.
//
//   pnpm engine && pnpm exec node test/supplyqueue.mjs
//
// Guards the seam that used to let the market absorb an anonymous cohort even
// when the corresponding frame stalled or disappeared from the map.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE
  ? join(HERE, "..", process.env.ENGINE)
  : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels } = loadCity(0, E.normalizeParcels);
const g = E.newGame(61803, parcels);
const bbl = Object.keys(parcels).find((x) => parcels[x]?.class === "land");
if (!bbl) throw new Error("No land parcel for supply-queue harness.");

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nONE CONSTRUCTION DELIVERY QUEUE\n");

// A mixed-use project is one row and both legs move together.
E.queueSupplyProject(g, {
  bbl,
  source: "city",
  deliverM: g.month + 24,
  sfByUse: { office: 80_000, retail: 20_000 },
});
check(g.econ.deliveryQueue.length === 1, "mixed-use start creates one project row");
check(g.econ.cohorts.office[0]?.sf === 80_000 && g.econ.cohorts.retail[0]?.sf === 20_000,
  "derived delivery schedule carries both use legs");

E.rescheduleSupplyProject(g, bbl, g.month + 30);
check(g.econ.cohorts.office[0]?.m === g.month + 30
  && g.econ.cohorts.retail[0]?.m === g.month + 30,
  "one schedule change moves every leg");

// A stalled physical frame must not enter city stock when its old date arrives.
E.stallSupplyProject(g, bbl);
g.month += 31;
let delivered = E.settleSupplyDeliveries(g);
check(delivered.office === 0 && delivered.retail === 0,
  "stalled frame delivers no ghost supply");
check(g.econ.deliveryQueue.length === 1, "stalled frame remains available to restart");

E.rescheduleSupplyProject(g, bbl, g.month + 6);
g.month += 6;
delivered = E.settleSupplyDeliveries(g);
check(delivered.office === 80_000 && delivered.retail === 20_000,
  "restarted mixed-use project delivers atomically");
check(g.econ.deliveryQueue.length === 0, "delivered project leaves the queue");

// A physical job rejected before opening is cancelled before economic delivery.
const g2 = E.newGame(61804, parcels);
E.queueSupplyProject(g2, {
  bbl,
  source: "city",
  deliverM: g2.month + 1,
  sfByUse: { office: 50_000 },
});
g2.cityJobs = [{
  bbl, use: "office", sf: 50_000, floors: 5,
  startM: g2.month, deliverM: g2.month + 1, orphaned: true,
}];
E.reconcileSupplyQueue(g2, parcels);
g2.month += 1;
delivered = E.settleSupplyDeliveries(g2);
check(delivered.office === 0, "orphaned city job is removed from dated deliveries");

console.log("");
process.exit(bad ? 1 : 0);
