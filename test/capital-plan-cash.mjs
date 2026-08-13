// CAPITAL PLAN FUNDS FROM FIRM CASH — EVEN ON A SWEPT DEED.
//
//   pnpm engine && node test/capital-plan-cash.mjs
//
// A cash-flow sweep traps property NOI surplus to principal. It used to also
// refuse the monthly reserve cheque from the firm's own cash, which printed
// "capital plan went unfunded" while the top bar showed millions and left the
// building to age for no reason a lender would recognise.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nCAPITAL PLAN / FIRM CASH\n");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(61882, parcels, 80_000_000), parcels, bbls);
const listing = (g.listings ?? []).find((l) => {
  const r = E.resolveRec(parcels, g, l.bbl);
  return r && r.class !== "land" && r.bldgArea > 0 && l.ask < g.cash * 0.4;
});
if (!listing) throw new Error("No building to buy.");
const bought = E.executePurchase(g, parcels, listing.bbl, listing.ask, "cash", false, 1);
if (bought.err) throw new Error(bought.err);
g = bought.s;
const bbl = listing.bbl;

// Force a Fund plan and a covenant sweep while the firm is flush.
g.holdings[bbl].plan = 1;
g.holdings[bbl].loan = {
  ...(g.holdings[bbl].loan ?? {
    balance: 1_000_000, ratePct: 6, monthlyPmt: 6_000, maturityM: g.month + 120,
    product: "savings", originM: g.month, minDSCR: 1.25, maxLTV: 0.75,
  }),
  sweep: true,
};
g.cash = 4_000_000;
delete g.holdings[bbl].planCutM;
const condBefore = g.holdings[bbl].condIdx ?? 0.7;
g.holdings[bbl].condIdx = condBefore;

g = E.advanceMonth(g, parcels, bbls);
const h = g.holdings[bbl];
const monthBooks = (g.booksMonthly ?? []).find((m) => m.m === g.month);
check(!!h, "still own the building");
check(h.planCutM !== g.month, "flush firm does not cut the plan on a swept deed");
check(
  !(E.attentionItems(g).some((a) => a.key === `capital-plan:${bbl}:${g.month}`)),
  "no 'unfunded capital plan' attention stop when cash covers the bill",
);
check(h.lastCapM === g.month, "capital plan stamped this month");
check((monthBooks?.capex ?? 0) > 0, "reserve cheque landed on the capex line");

// Truly short of cash: the plan must still cut and stop the clock.
{
  let thin = structuredClone(g);
  thin.cash = 100; // far below any real monthly reserve
  delete thin.holdings[bbl].planCutM;
  thin.holdings[bbl].plan = 1;
  thin.holdings[bbl].loan = { ...thin.holdings[bbl].loan, sweep: false };
  thin = E.advanceMonth(thin, parcels, bbls);
  const th = thin.holdings[bbl];
  check(th?.planCutM === thin.month, "short cash still cuts the capital plan");
  check(
    E.attentionItems(thin).some((a) => a.key === `capital-plan:${bbl}:${thin.month}`),
    "short-cash cut still stops Year/Skip",
  );
}

if (bad) {
  console.error(`\n${bad} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll capital-plan cash checks passed.\n");
