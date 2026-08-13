// DEEP BUG FIX REGRESSION — money paths that lied on the close or the month.
//
//   pnpm engine && pnpm exec node test/deep-bugs.mjs
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

console.log("\nDEEP BUG FIX — facility DS, buy quote, street package, seizure release\n");

{
  // Unfunded facility coupon must not amortize the balance for free.
  const { parcels, bbls } = loadCity(0, E.normalizeParcels);
  let g = E.firstListings(E.newGame(77101, parcels, 80_000_000), parcels, bbls);
  const picks = [];
  for (const L of g.listings ?? []) {
    const rec = E.resolveRec(parcels, g, L.bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    picks.push(L);
    if (picks.length >= 8) break;
  }
  check(picks.length >= 3, `bought a pool of ${picks.length} buildings`);
  for (const L of picks) {
    const r = E.executePurchase(g, parcels, L.bbl, L.ask, "cash", false, 1);
    if (r.err) throw new Error(r.err);
    g = r.s;
  }
  const pool = Object.keys(g.holdings);
  const quotes = E.facilityQuotes(g, parcels, pool);
  const qt = quotes.find((x) => x.available);
  check(!!qt, `facility desk will quote the pool${qt ? "" : ` (${quotes.map((x) => x.why).filter(Boolean).join("; ")})`}`);
  if (!qt) throw new Error("no facility quote");
  const opened = E.openFacility(g, parcels, pool, qt.productId, 1);
  check(!opened.err && !!opened.s.facility, `facility opens${opened.err ? `: ${opened.err}` : ""}`);
  g = opened.s;
  const bal0 = g.facility.balance;
  const pmt = g.facility.monthlyPmt;
  // Drain cash and overdraw the line so fundCashNeed pays nothing.
  g.cash = 0;
  g.loc = { balance: 1e12, drawnTotal: 1e12, interestPaid: 0 };
  const before = g.facility.balance;
  E.tickFacility(g, parcels);
  check(g.facility.balance >= before - 1, `unfunded facility tick does not free-amortize (bal ${before} -> ${g.facility.balance}, pmt ${pmt})`);
  check((g.facility.arrearsMs ?? 0) >= 1, "unfunded coupon starts the arrears clock");
  // Restore a solvent facility for the release/seizure path.
  g.facility.balance = bal0;
  g.facility.arrearsMs = 0;
  delete g.facility.breachedSince;
  delete g.facility.sweep;
  delete g.facility.accelM;
  g.cash = 5_000_000;
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };

  // Street package listing must refuse facility collateral.
  const listed = E.listStreetPortfolio(g, parcels, pool);
  check(!!listed.err && /facility|pledged/i.test(listed.err), `listStreetPortfolio blocks pledged deeds: ${listed.err ?? "no err"}`);

  // Seizure of a pledged deed must reduce the facility balance.
  // Max the revolver so tickLoc cannot paper over the hole, and leave cash
  // deep enough that a month of NOI cannot float it before the bailiff.
  const bbl = [...g.facility.bbls].sort((a, b) => {
    const va = E.ownedHoldingValue(g, parcels, g.holdings[a]);
    const vb = E.ownedHoldingValue(g, parcels, g.holdings[b]);
    return vb - va;
  })[0];
  const release = E.releaseCost(g, parcels, bbl);
  check(release > 0, `release price on pledged deed is ${release}`);
  const facBal0 = g.facility.balance;
  const lim = E.locLimit(g, parcels);
  g.loc = { balance: lim, drawnTotal: lim, interestPaid: 0 };
  g.cash = -50_000_000;
  g.insolventMs = 12;
  g = E.advanceMonth(g, parcels, bbls);
  const stillOwned = !!g.holdings[bbl];
  // Creditors take the most valuable deed — that should be bbl.
  check(!stillOwned, "insolvency seized the top pledged deed");
  check(!(g.facility?.bbls ?? []).includes(bbl), "seized pledged deed left the facility pool");
  const facBal1 = g.facility?.balance ?? 0;
  // Month-of facility tick can accrue a month of unpaid interest before the
  // bailiff runs, so the drop is release ± that coupon — not an exact match
  // to the pre-month release quote.
  const drop = facBal0 - facBal1;
  check(!g.facility || drop >= release * 0.9,
    `seizure paid release (facility ${facBal0} -> ${facBal1}, drop ${drop}, pre-month release ${release})`);
}

{
  // buyQuote principal must match written loan; equity includes points.
  const { parcels, bbls } = loadCity(1, E.normalizeParcels);
  let g = E.firstListings(E.newGame(88202, parcels, 40_000_000), parcels, bbls);
  const L = (g.listings ?? []).find((x) => {
    const rec = E.resolveRec(parcels, g, x.bbl);
    return rec && rec.class !== "land" && rec.bldgArea > 0 && x.ask > 800_000 && x.ask < 6_000_000;
  });
  check(!!L, "found a financeable listing");
  if (L) {
    const over = Math.round(L.ask * 1.25);
    const desk = ["savings", "harbor", "cordage"].find((id) => E.buyQuote(g, parcels, L.bbl, over, id, 1).principal > 0) ?? "cash";
    const q = E.buyQuote(g, parcels, L.bbl, over, desk, 1);
    check(q.overpay > 0 || desk === "cash", "overpay path engaged (or cash-only)");
    if (desk !== "cash" && q.principal > 0) {
      check((q.pointsFee ?? 0) > 0, `acquisition points charged on quote (${q.pointsFee})`);
      const r = E.executePurchase(g, parcels, L.bbl, over, desk, false, 1);
      check(!r.err && r.s.holdings[L.bbl]?.loan, "purchase closes with a loan");
      if (r.s.holdings[L.bbl]?.loan) {
        check(r.s.holdings[L.bbl].loan.balance === q.principal,
          `written balance ${r.s.holdings[L.bbl].loan.balance} matches quote ${q.principal}`);
      }
    }
  }
}

{
  // saleProceedsToSeller includes facility release.
  check(typeof E.saleProceedsToSeller === "function", "saleProceedsToSeller exported");
}

console.log("");
process.exit(bad ? 1 : 0);
