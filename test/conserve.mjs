// CONSERVATION — every dollar came from somewhere.
//
//   pnpm conserve                 seven seeds, fifty years each
//   SEEDS=11,22 pnpm conserve     a subset
//   HZ=120 pnpm conserve          a quick pass
//
// The engine records a P&L through `logBooks` and it enforces nothing. There
// are eighty places that write `s.cash` against fifty-nine that write to the
// ledger, and for most of this project's life nobody had checked whether those
// two agree. They did not. A NaN once ate the player's entire bankroll in
// silence because there was nothing in the model whose job was to notice.
//
// This is that job. Every month, the change in cash must equal what the books
// say happened, plus the two balance-sheet movements that ARE cash and are not
// income or expense — drawing or repaying the revolver, and taking or handing
// back a tenant deposit:
//
//   Dcash  ==  (noi + sold + interest)
//            - (debtSvc + leasing + capex + dev + taxes + bought + ga)
//            + Dloc.balance
//            + Ddeposits
//
// Anything left over is a dollar that moved without telling anyone. The sign
// says what kind of fault it is: money DISAPPEARING is a payment nobody
// booked, money APPEARING is a liability released without recording the gain.
// Both were real and both were found by this file — the balloon shortfall at
// a maturity, which is the largest cheque a levered owner ever writes and was
// invisible on the Books page, and the forfeited deposit of a tenant who went
// dark, which improved net worth with no entry anywhere.
//
// It is a MEASUREMENT, not a runtime assertion. It belongs in the harnesses
// where it can run a hundred thousand months, not in the tick where it would
// cost every player a reconciliation they did not ask for.
import { assertFreshBundle } from "./fresh.mjs";
import { leaseAtMarket } from "./leasepolicy.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22,33,4242").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 600);
// A dollar is a dollar. The tolerance exists only for the rounding the engine
// does at the edges of a cent, not to give a real leak somewhere to hide.
const TOL = 1000;

// `borrowed` is net new mortgage/facility principal drawn into cash — the
// bucket that closes conserve's old blind spot on cash-out refinance and
// facility draws. See BooksYear.borrowed and engine/debt.ts / facility.ts.
// `lpCalled` / `lpDistributed` are fund equity in/out against the vehicle's
// second cash account — conserve reconciles Δ(cash + fund.cash).
const IN = ["noi", "sold", "interest", "borrowed", "lpCalled"];
const OUT = ["debtSvc", "leasing", "capex", "dev", "taxes", "bought", "ga", "lpDistributed"];
const M = (n) => `$${(n / 1e6).toFixed(3)}M`;

const bookTotals = (g) => {
  const t = {};
  for (const k of [...IN, ...OUT]) t[k] = 0;
  for (const y of g.books ?? []) for (const k of [...IN, ...OUT]) t[k] += y[k] ?? 0;
  return t;
};
const depositsHeld = (g) => {
  let d = 0;
  for (const h of Object.values(g.holdings ?? {})) for (const t of h.tenants ?? []) d += t.deposit ?? 0;
  return d;
};
const liquidity = (g) => g.cash + (g.fund?.cash ?? 0);

const rows = [];
let totalBreaks = 0, months = 0;
// WHAT THE RUN ACTUALLY TOUCHED. An identity is only worth what it is asked
// about: `Dcash == books + Dloc + Ddeposits` holds trivially for a player who
// does nothing, and this file spent a stretch proving exactly that. Every
// category the bot is supposed to exercise has to move, or the run is not a
// test of anything and says so.
const coverage = {};
for (const k of [...IN, ...OUT]) coverage[k] = 0;

for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const START = g.cash;
  let built = false;
  let prev = { cash: liquidity(g), books: bookTotals(g), loc: g.loc?.balance ?? 0, dep: depositsHeld(g) };
  const breaks = [];
  let worst = 0, cum = 0;

  for (let m = 0; m < HZ; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // A PLAYER WHO ACTUALLY DOES THINGS. An idle run exercises almost none of
    // the cash paths: no purchases, no debt, no leasing, no capex, no balloon.
    // Leasing at market and buying on a clock walks most of the ledger.
    for (const loi of [...g.lois]) {
      const rec = E.resolveRec(parcels, g, loi.bbl), h = g.holdings[loi.bbl];
      if (!rec || !h) continue;
      const ask = E.managedRentPsfYr(rec, g.econ, h, loi.use) * E.staleDiscount(h.darkMs);
      const r = E.respondLOI(g, parcels, loi.id, loi.rentPsf >= ask * 0.92 ? "accept" : "pass");
      if (!r.err) g = r.s;
    }
    // ...AND IT KEEPS A RESERVE, because a bot that buys on a clock regardless
    // of its balance is not exercising the ledger, it is racing to insolvency.
    //
    // This file stops at gameOver, so how long the bot lives IS how many
    // months get reconciled — and that fell from 3,385 to 1,987 across two
    // changes that stopped rents compounding. Diagnosed rather than assumed:
    // it died at year 4 to 17 every time with a POSITIVE net worth ($7M to
    // $105M peak) and cash of -$0.1M to -$2.5M. Not a firm the economy broke;
    // a levered buyer with no liquidity management, which used to be bailed
    // out by rent growth that was itself the bug.
    //
    // Fixing the bot rather than the economy is the whole point of the
    // distinction: conserve tests the LEDGER IDENTITY, and it needs the bot
    // alive to test it over fifty years, not to prove the bot is any good.
    // Nothing here touches an engine number.
    // WHAT IT TAKES TO GET THIS BOT TO TRANSACT, and why it is a fraction of
    // its own opening balance rather than a number of dollars.
    //
    // It used to be `g.cash > 4_000_000`, with a $2.5M working reserve behind
    // it — both sized to a $6M opening bankroll. The opening bankroll became a
    // choice of $1M / $2.5M / $5M, defaulting to $2.5M, and nobody came back
    // here. The gate on which every money-moving change in this repo is
    // validated then spent an unknown number of commits reconciling a player
    // who never bought a building: 8 of the 10 ledger categories were dead,
    // `interest` and `ga` were the only two that moved, and the identity had
    // quietly become `Dcash == interest - ga`. See the coverage assertion at
    // the bottom of this file, which exists so that cannot happen silently
    // again.
    if (m % 9 === 0 && g.cash > START * 0.6) {
      for (const li of [...g.listings].slice(0, 8)) {
        const rec = E.resolveRec(parcels, g, li.bbl);
        if (!rec || g.holdings[li.bbl] || rec.class === "land") continue;
        if (li.ask > E.assetValue(rec, g.econ, E.initialCondition(rec))) continue;
        // Leave a working balance behind, the way anybody solvent does.
        const q = E.buyQuote(g, parcels, li.bbl, li.ask, "senior", 1);
        if (q.equity > g.cash - START * 0.25) continue;
        const r = E.executePurchase(g, parcels, li.bbl, li.ask, "senior", false, 1);
        if (!r.err) { g = r.s; break; }
      }
    }
    // AND IT PUTS A CRANE UP, ONCE. Development is the largest and lumpiest
    // set of cash movements the player has — the draw schedule, the overrun,
    // the capital call, the completion — and conserve found real faults in it
    // before. A bot that never breaks ground leaves `dev` at zero and leaves
    // that whole arm of the ledger unreconciled, so it buys one cheap lot and
    // builds on it. One job, not a programme: the point is coverage, not a
    // developer strategy.
    if (!Object.keys(g.developments ?? {}).length && !built && g.cash > START * 0.8) {
      const lot = [...g.listings].find((li) => {
        const rec = E.resolveRec(parcels, g, li.bbl);
        return rec && rec.class === "land" && !g.holdings[li.bbl] && li.ask < g.cash * 0.25;
      });
      if (lot) {
        const r = E.executePurchase(g, parcels, lot.bbl, lot.ask, "cash", false, 1);
        if (!r.err) g = r.s;
      }
      const dirt = Object.keys(g.holdings).find((b) => {
        const rec = E.resolveRec(parcels, g, b);
        return rec && rec.class === "land" && !g.developments[b] && !g.holdings[b].sale;
      });
      if (dirt) {
        const d = E.startDevelopment(g, parcels, dirt, "office", 4);
        if (!d.err) { g = d.s; built = true; }
      }
    }

    // A LANDLORD SHORT OF CASH SELLS SOMETHING. Without an exit the bot can
    // only ever accumulate, so one bad decade ends it no matter how much
    // equity it is sitting on — which is a fact about the bot, not the world.
    if (g.cash < 1_200_000) {
      const own = Object.keys(g.holdings).filter((b) => !g.holdings[b].sale);
      if (own.length > 1) {
        const bbl = own[0];
        const rec = E.resolveRec(parcels, g, bbl);
        if (rec) {
          const r = E.listForSale(g, parcels, bbl, Math.round(E.assetValue(rec, g.econ, E.initialCondition(rec)) * 0.92));
          if (!r.err) g = r.s;
        }
      }
    }
    for (const bbl of Object.keys(g.holdings)) {
      const off = g.holdings[bbl].sale?.offer;
      if (off && g.cash < 3_000_000) {
        const r = E.acceptSaleOffer(g, parcels, bbl);
        if (!r.err) g = r.s;
      }
    }
    // A CASH-OUT REFINANCE, so `borrowed` is actually exercised. An identity
    // that never sees a principal draw cannot claim the debt gap is closed.
    // Once every few years on a stabilised income asset with room to lever.
    if (m > 36 && m % 48 === 0) {
      for (const bbl of Object.keys(g.holdings)) {
        const h = g.holdings[bbl];
        const rec = E.resolveRec(parcels, g, bbl);
        if (!h || !rec || rec.class === "land" || h.sale) continue;
        if ((h.tenants?.length ?? 0) < 1) continue;
        const r = E.refinance(g, parcels, bbl, "savings", 1);
        if (!r.err) { g = r.s; break; }
      }
    }
    // FUND EQUITY BUCKETS — plant a vehicle once and call/distribute so
    // `lpCalled` / `lpDistributed` are not decorative. Gates bypassed: this
    // is coverage of the identity, not a raise-worthiness test (see pnpm fund).
    if (m === 100 && !g.fund) {
      g = structuredClone(g);
      g.fund = {
        raisedM: g.month, size: 10_000_000, uncalled: 4_000_000, cash: 0,
        called: 0, distributed: 0, promotePaid: 0, prefAccrued: 0,
        investEndM: g.month + 60, lifeEndM: g.month + 120,
        pref: 0.08, promote: 0.20, gpCommit: 300_000,
      };
      const c = E.callFundCapital(g, 2_000_000);
      if (!c.err) g = c.s;
      const d = E.distributeFund(g, 400_000);
      if (!d.err) g = d.s;
    }
    // ESTATE TAX — plant a due bill so the Principal path hits `taxes` for a
    // reason that is not property tax. Do NOT mint cash to fund it — that is
    // a free residual. Pay only what is already on the books.
    if (m === 140 && !g.estateDue && g.cash >= 250_000) {
      g = structuredClone(g);
      const bill = Math.min(500_000, Math.round(g.cash * 0.25));
      g.estateDue = {
        gross: 40_000_000, tax: bill, remaining: bill,
        deadlineM: g.month, deathM: g.month - 1, decedentName: "coverage plant",
      };
      E.tickEstateBill(g);
    }

    const nb = bookTotals(g), nl = g.loc?.balance ?? 0, nd = depositsHeld(g);
    let inflow = 0, outflow = 0;
    for (const k of IN) inflow += nb[k] - prev.books[k];
    for (const k of OUT) outflow += nb[k] - prev.books[k];
    const explained = inflow - outflow + (nl - prev.loc) + (nd - prev.dep);
    const resid = (liquidity(g) - prev.cash) - explained;
    cum += resid;
    months++;
    if (Math.abs(resid) > TOL) {
      if (Math.abs(resid) > Math.abs(worst)) worst = resid;
      if (breaks.length < 6) {
        // WHICH COMPONENT MOVED. A residual says a dollar has no entry; it does
        // not say which line it should have been on. These are the raw deltas
        // for the failing month, so the next reader starts from evidence rather
        // than from a hypothesis about deposits.
        const parts = {};
        for (const k of [...IN, ...OUT]) { const d = nb[k] - prev.books[k]; if (d) parts[k] = Math.round(d); }
        breaks.push({
          m, resid,
          dCash: Math.round(liquidity(g) - prev.cash),
          dLoc: Math.round(nl - prev.loc),
          dDep: Math.round(nd - prev.dep),
          parts,
          news: (g.news ?? []).filter((n) => n.q === g.month).map((n) => n.text.slice(0, 90)),
        });
      }
    }
    prev = { cash: liquidity(g), books: nb, loc: nl, dep: nd };
    if (g.gameOver) break;
  }
  totalBreaks += breaks.length;
  for (const k of [...IN, ...OUT]) coverage[k] += Math.abs(bookTotals(g)[k] ?? 0);
  rows.push({ seed, breaks, worst, cum });
}

console.log(`\nCONSERVATION — does every dollar come from somewhere?`);
console.log(`${SEEDS.length} seeds x ${HZ} months, a player leasing at market and buying on a clock\n`);
console.log(`seed        out of balance   worst single month   cumulative unexplained`);
for (const r of rows) {
  console.log(`${String(r.seed).padEnd(12)}${String(r.breaks.length ? ">=" + r.breaks.length : "none").padEnd(17)}${M(r.worst).padStart(14)}${M(r.cum).padStart(24)}`);
  for (const b of r.breaks) {
    console.log(`   m${String(b.m).padStart(3)}  unexplained ${M(b.resid)}${b.resid > 0 ? "   (money APPEARED — a liability released with no entry)" : "   (money VANISHED — a payment nobody booked)"}`);
    console.log(`         dCash ${b.dCash}  dLoc ${b.dLoc}  dDeposits ${b.dDep}  books ${JSON.stringify(b.parts)}`);
    for (const n of b.news.slice(0, 4)) console.log(`         · ${n}`);
    for (const n of b.news) console.log(`        | ${n}`);
  }
}
console.log(`\n${"=".repeat(64)}`);

// DID THE RUN ASK THE QUESTION. Before reporting that every dollar came from
// somewhere, check that dollars went anywhere: an identity nothing exercises
// reports a pass it did not earn. `sold` is exempt — the bot only lists when it
// is short, so a run where it never had to is a healthy run, not a dead one.
const REQUIRED = ["noi", "interest", "debtSvc", "leasing", "capex", "taxes", "bought", "dev", "ga", "lpCalled", "lpDistributed"];
const dead = REQUIRED.filter((k) => coverage[k] === 0);
console.log(`ledger exercised: ${[...IN, ...OUT].map((k) => `${k} ${coverage[k] ? "yes" : "NO"}`).join("  ")}`);
if (dead.length) {
  console.log(`\nFAIL  the bot never moved ${dead.join(", ")} — this run proved nothing.`);
  console.log(`      An identity holds trivially for a player who does not transact. Check the`);
  console.log(`      bot's cash thresholds against the opening bankroll before reading anything`);
  console.log(`      else in this file: that is exactly how it broke last time.`);
  process.exit(1);
}

if (totalBreaks === 0) {
  console.log(`${months.toLocaleString()} months reconciled. Every dollar came from somewhere.`);
} else {
  console.log(`${totalBreaks} month(s) do not balance across ${months.toLocaleString()} reconciled.`);
  console.log(`A residual is not a rounding error — it is a cash movement with no entry behind it.`);
}
process.exit(totalBreaks === 0 ? 0 : 1);
