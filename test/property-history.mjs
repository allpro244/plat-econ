// THE DEED KEEPS ITS HISTORY AFTER THE NEWS WIRE MOVES ON.
//
//   pnpm engine && pnpm exec node test/property-history.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels } = loadCity(0, E.normalizeParcels);
let g = E.newGame(90817, parcels, 100_000_000);
const seller = g.rivals.find((r) => r.bbls.length);
if (!seller) throw new Error("Need a rival-owned deed.");
const bbl = seller.bbls[0];
const rec = E.resolveRec(parcels, g, bbl);
const px = Math.max(100_000, Math.round(E.assetValue(rec, g.econ, "standard")));
const bought = E.executePurchase(g, parcels, bbl, px, "cash", true, 1);
if (bought.err) throw new Error(bought.err);
g = bought.s;

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nPERMANENT PROPERTY HISTORY\n");
let line = E.propertyTimeline(g, bbl);
check(line.some((e) => e.kind === "trade" && e.amount === px), "closed trade is stamped automatically");
check(line.some((e) => e.kind === "trade" && e.party), "trade preserves named counterparties");

E.recordPropertyEvent(g, bbl, { kind: "build-start", use: "office", sf: 80_000, floors: 10, party: "Test Builder" });
g.month++;
E.recordPropertyEvent(g, bbl, { kind: "delivered", use: "office", sf: 80_000, floors: 10, party: "Test Builder" });
g.month++;
E.recordPropertyEvent(g, bbl, { kind: "major-lease", party: "Anchor Tenant", sf: 30_000, amount: 1_200_000 });
line = E.propertyTimeline(g, bbl);
check(line.some((e) => e.kind === "build-start") && line.some((e) => e.kind === "delivered"),
  "construction start and delivery remain distinct events");
check(line[0].kind === "major-lease", "timeline is newest first");
check(E.describePropertyEvent(line[0]).detail.includes("30,000"), "structured events render into readable history");

for (let i = 0; i < 30; i++) {
  g.month++;
  E.recordPropertyEvent(g, bbl, { kind: "planning", outcome: `Decision ${i}` });
}
check(g.propertyLog[bbl].length === E.PROPERTY_HISTORY_CAP, "per-property cap bounds save growth");

console.log("");
process.exit(bad ? 1 : 0);
