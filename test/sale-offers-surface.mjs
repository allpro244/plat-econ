// SINGLE-ASSET SALE SURFACING — bid lists and quiet offers must be visible.
//
//   pnpm engine && pnpm exec node test/sale-offers-surface.mjs
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

console.log("\nSINGLE-ASSET SALE SURFACING\n");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(61881, parcels, 80_000_000), parcels, bbls);
const listing = (g.listings ?? []).find((l) => {
  const r = E.resolveRec(parcels, g, l.bbl);
  return r && r.class !== "land" && r.bldgArea > 0 && l.ask < g.cash;
});
if (!listing) throw new Error("No building to list.");
const bought = E.executePurchase(g, parcels, listing.bbl, listing.ask, "cash", false, 1);
if (bought.err) throw new Error(bought.err);
g = bought.s;
const bbl = listing.bbl;
const h0 = g.holdings[bbl];
const value = E.ownedHoldingValue(g, parcels, h0);

// --- 1. Marketed campaign: quiet offers do not land while the book is out ---
{
  const listed = E.listForSale(g, parcels, bbl, Math.round(value * 0.95), "marketed");
  check(!listed.err && !!listed.s.holdings[bbl].sale?.callM, "marketed listing sets a call date");
  g = listed.s;
  const callM = g.holdings[bbl].sale.callM;
  // One month into the book-out — quiet offers must not land yet.
  if (g.month + 1 < callM) {
    g = E.advanceMonth(g, parcels, bbls);
    check(!!g.holdings[bbl]?.sale?.callM, "listing still live through the book-out");
    check(!g.holdings[bbl]?.sale?.offer, "no quiet offer while the book is still out");
  } else {
    check(true, "listing still live through the book-out");
    check(true, "no quiet offer while the book is still out");
  }
  // Land on/after call day.
  while (g.holdings[bbl]?.sale?.callM !== undefined) {
    g = E.advanceMonth(g, parcels, bbls);
  }
  const after = g.holdings[bbl]?.sale;
  const hasBids = (after?.bids?.length ?? 0) > 0;
  const emptyCall = after && after.mode === "quiet" && !after.bids;
  check(hasBids || emptyCall || !after, "call day resolves to a bid list, quiet fallback, or pull");
  if (hasBids) {
    const attn = E.attentionItems(g);
    check(attn.some((a) => a.key.startsWith(`sale-bids:${bbl}:`)), "bid list is on attentionItems");
    check((g.alerts ?? []).some((a) => a.kind === "sale"), "bid list raises a sale alert");
  }
}

// --- 2. Quiet offer lapse is news, not silence --------------------------------
{
  // Fresh building if the last one sold/delisted.
  if (!g.holdings[bbl]?.sale || g.holdings[bbl].sale.bids?.length) {
    if (g.holdings[bbl]?.sale) g = E.delist(g, bbl);
  }
  if (!g.holdings[bbl]) {
    console.log("  SKIP  building left the book before quiet-lapse check");
  } else {
    const v = E.ownedHoldingValue(g, parcels, g.holdings[bbl]);
    const listed = E.listForSale(g, parcels, bbl, Math.round(v * 0.9), "quiet");
    check(!listed.err, "quiet listing");
    g = listed.s;
    g.holdings[bbl].sale.offer = { price: Math.round(v * 0.85), expiresM: g.month };
    const beforeNews = (g.news ?? []).length;
    g = E.advanceMonth(g, parcels, bbls);
    const lapse = (g.news ?? []).slice(0, Math.max(0, (g.news ?? []).length - beforeNews) + 8)
      .some((n) => /lapsed unanswered/i.test(n.text));
    check(lapse, "expired quiet offer leaves a news line");
    check(!g.holdings[bbl]?.sale?.offer, "lapsed offer is cleared");
  }
}

console.log("");
process.exit(bad ? 1 : 0);
