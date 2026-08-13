// PORTFOLIO SALE — who can bid, and when silence is a lie.
//
//   pnpm engine && pnpm exec node test/portfolio-sale.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nPORTFOLIO SALE — buyer depth and empty-room silence\n");

check(typeof E.portfolioBuyerDepth === "function", "portfolioBuyerDepth is exported");
check(E.portfolioBuyerDepth(1_500_000) === 0, "under $2M — no buyer can fund a portfolio");
check(E.portfolioBuyerDepth(2_500_000) >= 1, "above Riverside's floor — at least one private desk");
check(E.portfolioBuyerDepth(7_000_000) >= 2, "above Bellwether — more than one desk");
check(E.portfolioBuyerDepth(50_000_000) >= 4, "institutional cheque — deep room");

// Quote must not invent a buyer when the pool is empty.
{
  const { loadCity } = await import(join(HERE, "city.mjs"));
  const { parcels, bbls } = loadCity(0, E.normalizeParcels);
  let g = E.firstListings(E.newGame(61881, parcels, 5_000_000), parcels, bbls);
  // Buy two cheap buildings so the book can exist under the old $6M floor.
  const picks = [];
  for (const L of g.listings ?? []) {
    const rec = E.resolveRec(parcels, g, L.bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    if (L.ask > 1_200_000) continue;
    picks.push(L);
    if (picks.length >= 2) break;
  }
  if (picks.length < 2) {
    console.log("  SKIP  could not find two cheap buildings for the empty-room case");
  } else {
    for (const L of picks) {
      const r = E.executePurchase(g, parcels, L.bbl, L.ask, "cash", false, 1);
      if (r.err) throw new Error(r.err);
      g = r.s;
    }
    const bundle = Object.keys(g.holdings);
    const q = E.portfolioQuote(g, parcels, bundle);
    check(q.depth === E.portfolioBuyerDepth(q.sumOfParts), "quote depth matches portfolioBuyerDepth");
    check(Number.isFinite(q.depth) && q.depth >= 0, "depth is never invented above the real pool");
    // If the book is under $2M, listing must refuse rather than burn nine months.
    if (q.sumOfParts < 2_000_000) {
      const listed = E.listPortfolio(g, parcels, bundle, q.indicative);
      check(!!listed.err && !listed.s.portfolioSale, "sub-$2M book cannot go to market as a portfolio");
    } else {
      const listed = E.listPortfolio(g, parcels, bundle, Math.round(q.indicative * 0.95));
      check(!listed.err && !!listed.s.portfolioSale, "fundable book lists");
      g = listed.s;
      // Advance a few months — something should be able to arrive eventually,
      // or at least the process must still be alive with a non-empty pool.
      let sawBid = false;
      for (let i = 0; i < 24 && g.portfolioSale; i++) {
        g = E.advanceMonth(g, parcels, bbls);
        if ((g.portfolioSale?.bids?.length ?? 0) > 0) { sawBid = true; break; }
      }
      check(sawBid || !!g.portfolioSale, "process either draws a bid or is still live inside the run");
      if (sawBid) {
        check((g.alerts ?? []).some((a) => a.kind === "portfolio"), "indication raises a portfolio alert card");
      }
    }
  }
}

console.log("");
process.exit(bad ? 1 : 0);
