// STICKY ASSESSMENTS HAVE A REAL APPEAL PATH.
//
//   pnpm engine && pnpm exec node test/tax-appeal.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(61881, parcels, 50_000_000), parcels, bbls);
const listing = g.listings.find((l) => {
  const r = E.resolveRec(parcels, g, l.bbl);
  return r && r.class !== "land" && r.bldgArea > 0 && l.ask < g.cash;
});
if (!listing) throw new Error("No building to test a tax appeal on.");
const bought = E.executePurchase(g, parcels, listing.bbl, listing.ask, "cash", false, 1);
if (bought.err) throw new Error(bought.err);
g = bought.s;
const h = g.holdings[listing.bbl];
const market = Math.round(E.ownedHoldingValue(g, parcels, h));
h.assessed = market * 4;

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nPROPERTY-TAX APPEAL\n");
const q = E.taxAppealQuote(g, parcels, h.bbl);
check(!!q && q.target > 0 && q.target < q.assessed,
  "appeal compares the tax roll with canonical value after its tax burden");
check(q.annualSavings > 0 && q.fee > 0 && q.fee < q.annualSavings,
  "filing cost is less than one year of potential tax savings");

const cash0 = g.cash;
const filed = E.fileTaxAppeal(g, parcels, h.bbl);
check(!filed.err, "appeal files");
g = filed.s;
check(g.cash === cash0 - q.fee, "appraisal and counsel are paid at filing");
check(!!g.holdings[h.bbl].taxAppeal, "hearing remains pending on the property");

g.holdings[h.bbl].taxAppeal.odds = 1;
g.month = g.holdings[h.bbl].taxAppeal.decideM;
E.tickTaxAppeals(g, parcels);
check(!g.holdings[h.bbl].taxAppeal, "board resolves the hearing");
check(g.holdings[h.bbl].assessed <= market, "successful appeal reduces assessment to market evidence");
check(!E.taxAppealQuote(g, parcels, h.bbl), "three-year cooldown prevents serial refiling");

console.log("");
process.exit(bad ? 1 : 0);
