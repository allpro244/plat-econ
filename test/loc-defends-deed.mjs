// LOC / cash that can fund a cure OR monthly DS never loses the deed.
//
//   pnpm engine && node test/loc-defends-deed.mjs
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

console.log("\nLOC DEFENDS THE DEED\n");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);

function buyLevered(seed) {
  for (let s = seed; s < seed + 400; s++) {
    let g = E.firstListings(E.newGame(s, parcels, 80_000_000), parcels, bbls);
    const listing = (g.listings ?? []).find((l) => {
      const r = E.resolveRec(parcels, g, l.bbl);
      return r && r.class !== "land" && r.bldgArea > 0
        && l.ask > 5_000_000 && l.ask < 25_000_000;
    });
    if (!listing) continue;
    const bought = E.executePurchase(g, parcels, listing.bbl, listing.ask, "savings", false, 0.65);
    if (bought.err || !bought.s.holdings[listing.bbl]?.loan) continue;
    return { g: bought.s, bbl: listing.bbl };
  }
  throw new Error("No levered building.");
}

// --- 1. Covenant cure may draw the line -----------------------------------
{
  let { g, bbl } = buyLevered(71);
  const h = g.holdings[bbl];
  const lender = h.loan.holder ?? "Savings Bank";
  g.workouts = {
    [bbl]: {
      bbl, lender, cause: "covenant", stage: "notice",
      startM: g.month, decideM: g.month + 1, cure: 400_000, asks: 0,
    },
  };
  g.cash = 50_000;
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  check(E.fundableNow(g, parcels) >= 400_000, "line + cash can fund the covenant cure");
  const cured = E.cureWorkout(g, parcels, bbl);
  check(!cured.err, `covenant cure from the line succeeds${cured.err ? ` (${cured.err})` : ""}`);
  g = cured.s;
  check(!g.workouts?.[bbl], "covenant file closed after LOC-funded cure");
  check((g.loc?.balance ?? 0) > 0, "line was drawn for the cure");
}

// --- 2. Coupon-current foreclosure is pulled off the steps ----------------
{
  let { g, bbl } = buyLevered(72);
  const h = g.holdings[bbl];
  const pmt = h.loan.monthlyPmt;
  const lender = h.loan.holder ?? "Savings Bank";
  // Deep arrears so the refreshed cure dwarfs liquidity; cash covers ~1.5 coupons
  // and the line is fully drawn so undrawn room is zero.
  h.loan.arrearsMs = 120;
  g.cash = Math.round(pmt * 1.5);
  const limit = E.locLimit(g, parcels);
  g.loc = { balance: limit, drawnTotal: limit, interestPaid: 0 };
  g.workouts = {
    [bbl]: {
      bbl, lender, cause: "arrears", stage: "foreclosure",
      startM: g.month - 10, decideM: g.month, saleM: g.month,
      cure: pmt * 120, asks: 0, accrued: 0,
    },
  };
  const have = E.fundableNow(g, parcels);
  check(have >= pmt, `coupon is fundable (have $${(have / 1e3).toFixed(0)}k)`);
  check(have < pmt * 120, `full arrears cure is NOT fundable (have $${(have / 1e6).toFixed(2)}M)`);
  check(E.couponFundable(g, parcels, g.holdings[bbl]), "couponFundable is true");
  E.reinstateFundedForeclosures(g, parcels);
  check(g.workouts?.[bbl]?.stage === "notice", "foreclosure pulled back to notice while coupon fundable");
  check(g.workouts?.[bbl]?.saleM === undefined, "sale date cleared");
  check(!!g.holdings[bbl], "deed still yours");
}

// --- 3. Auto-cure on arrears uses the line --------------------------------
{
  let { g, bbl } = buyLevered(73);
  const h = g.holdings[bbl];
  const pmt = h.loan.monthlyPmt;
  const lender = h.loan.holder ?? "Savings Bank";
  const cure = Math.round(pmt * 3);
  g.workouts = {
    [bbl]: {
      bbl, lender, cause: "arrears", stage: "foreclosure",
      startM: g.month - 8, decideM: g.month, saleM: g.month,
      cure, asks: 0, accrued: 0,
    },
  };
  g.cash = 10_000;
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  check(E.fundableNow(g, parcels) >= cure, "line can fund the arrears cure");
  E.reinstateFundedForeclosures(g, parcels);
  check(!g.workouts?.[bbl], "auto-cure closed the foreclosure from the line");
  check(!!g.holdings[bbl], "deed still yours after reinstate");
}

console.log("");
process.exit(bad ? 1 : 0);
