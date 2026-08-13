// LOC AUTO-PAYDOWN — idle cash clears the revolver when able.
//
//   pnpm engine && node test/loc-auto-paydown.mjs
//
// Month-end already swept idle cash above $250K. A sale used to leave the line
// drawn until the next Advance, so the top bar could show millions of cash
// next to an expensive drawn balance. Sale proceeds (and the month tick) must
// pay it down immediately.
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

console.log("\nLOC AUTO-PAYDOWN\n");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);

// --- 1. Month tick still sweeps idle cash above the reserve -----------------
{
  let g = E.newGame(42, parcels, 5_000_000);
  g.loc = { balance: 1_000_000, drawnTotal: 1_000_000, interestPaid: 0 };
  g.cash = 2_000_000;
  g = E.advanceMonth(g, parcels, bbls);
  check((g.loc?.balance ?? 0) === 0, "month tick clears the line when cash covers it");
  check(g.cash >= E.LOC_CASH_RESERVE * 0.5, "operating float remains after the sweep");
}

// --- 2. Sale proceeds pay the line immediately (no Advance required) --------
{
  let g = E.firstListings(E.newGame(43, parcels, 80_000_000), parcels, bbls);
  const listing = (g.listings ?? []).find((l) => {
    const r = E.resolveRec(parcels, g, l.bbl);
    return r && r.class !== "land" && r.bldgArea > 0 && l.ask < 25_000_000;
  });
  if (!listing) throw new Error("No building to buy.");
  const bought = E.executePurchase(g, parcels, listing.bbl, listing.ask, "cash", false, 1);
  if (bought.err) throw new Error(bought.err);
  g = bought.s;
  const bbl = listing.bbl;
  // Drawn line larger than the operating float but smaller than sale proceeds,
  // so the close must clear it without waiting for Advance.
  g.loc = { balance: 500_000, drawnTotal: 500_000, interestPaid: 0 };
  g.cash = 100_000;
  const v = E.ownedHoldingValue(g, parcels, g.holdings[bbl]);
  const listed = E.listForSale(g, parcels, bbl, Math.round(v * 0.95), "quiet");
  if (listed.err) throw new Error(listed.err);
  g = listed.s;
  // Price at a round cash-in that covers the drawn line after friction/tax.
  g.holdings[bbl].sale.offer = {
    price: Math.max(Math.round(v * 0.9), 1_200_000),
    expiresM: g.month + 2,
    from: "Test Buyer",
  };
  const locBefore = g.loc.balance;
  const closed = E.acceptSaleOffer(g, parcels, bbl, false);
  if (closed.err) throw new Error(closed.err);
  g = closed.s;
  check((g.loc?.balance ?? 0) === 0, "sale proceeds clear the line without advancing");
  check(g.cash >= E.LOC_CASH_RESERVE, "sale leaves the $250K operating float");
  check(
    (g.news ?? []).some((n) => /Idle cash paid .* down on the line/.test(n.text)),
    `paydown is written into the news tape (was drawn $${(locBefore / 1e6).toFixed(2)}M)`,
  );
}

// --- 3. Helper itself respects the reserve ----------------------------------
{
  const g = E.newGame(44, parcels, 1_000_000);
  g.loc = { balance: 500_000, drawnTotal: 500_000, interestPaid: 0 };
  g.cash = E.LOC_CASH_RESERVE + 80_000;
  const paid = E.sweepLocIdleCash(g);
  check(paid === 80_000, "sweep pays only the dollars above the reserve");
  check(g.loc.balance === 420_000, "line balance falls by the same amount");
  check(g.cash === E.LOC_CASH_RESERVE, "cash lands on the reserve floor");
}

if (bad) {
  console.error(`\n${bad} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll LOC auto-paydown checks passed.\n");
