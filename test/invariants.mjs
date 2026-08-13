// Run the invariant checks against every month of full campaigns, across
// strategies chosen to stress different parts of the engine. Reports the FIRST
// month each distinct violation appears, because that is the month with the
// bug in it.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
// Cities live in per-city dirs now; the harness runs against one of them.
// BW_CITY picks which island (default somewhere — generated).
const E = await import(process.env.ENGINE ?? join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);

const HORIZON = Number(process.env.HORIZON ?? 1200);
const SEEDS = Number(process.env.SEEDS ?? 8);

// Each bot is chosen to walk a different code path to its edges.
const BOTS = {
  // maximum leverage, never sells: drives loans to breach, sweep and balloon
  levered: {
    buy: (c) => c.built, lev: 1, prod: () => "cordage", refi: true, sell: () => false, every: 5,
  },
  // builds constantly: exercises draws, reserves, contingency, delivery
  builder: { buy: () => true, lev: 0.9, prod: (c) => (c.built ? "savings" : "land"), dev: true, land: true, sell: (g) => g > 0.5, every: 7 },
  // churns: exercises sale, tax, 1031, exits
  churner: { buy: (c) => c.built, lev: 0.7, prod: () => "savings", sell: (g) => g > 0.15, every: 3 },
  // SYNDICATOR. Buys with debt AND somebody else's equity, recapitalising
  // everything it can and trading out — which is the only bot that drives the
  // preferred return, the capital calls, the promote and the waterfall on the
  // way out. Without it the whole equity stack went unswept.
  // was the JV bot; outside equity is gone, so it is now the one that trades
  // hardest — buys everything built, levers it, and sells on any real gain
  syndicator: { buy: (c) => c.built, lev: 0.75, prod: () => "savings", sell: (g) => g > 0.25, every: 4 },
  // mezz + participating + caps: the exotic end of the desk
  exotic: { buy: (c) => c.built, lev: 1, prod: (c) => (c.yield > 0.06 ? "pelican" : "cordage"), refi: true, mezz: true, sell: () => false, every: 6 },
};

const firstSeen = new Map();   // code|where-kind -> {month, seed, bot, detail}
let checks = 0;

function record(bot, seed, month, v) {
  const key = `${bot}|${v.code}|${v.where.replace(/\d+/g, "#")}`;
  if (!firstSeen.has(key)) firstSeen.set(key, { month, seed, bot, ...v });
}

function run(botName, seed) {
  const B = BOTS[botName];
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  for (let m = 0; m < HORIZON; m++) {
    // The book as it stood before the tick, so the month-over-month checks —
    // the levy waterfall above all — measure the engine's own month and not
    // the bot's decisions on top of it.
    const before = g;
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    checks++;
    for (const v of E.checkInvariants(g, parcels, before)) record(botName, seed, g.month, v);
    if (g.gameOver) break;

    for (const loi of [...g.lois]) {
      const r = E.respondLOI(g, parcels, loi.id, m % 7 === 0 ? "counter" : "accept", true);
      g = r.err ? E.respondLOI(g, parcels, loi.id, "decline").s : r.s;
    }
    for (const v of E.checkInvariants(g, parcels)) record(botName, seed, g.month, v);

    // PUT SOMETHING ON THE MARKET, both ways. The bots only ever responded to
    // unsolicited approaches, so the whole sell side — campaigns, bid lists,
    // best and final, retrades — was never once swept.

    // EMPTYING A BUILDING, both ways. Stopping the letting and buying the
    // leases out are the two paths to a demolition, and both leave the state in
    // shapes nothing else in this harness produces: a holding with a hold on
    // it, a roll cleared mid-term, deposits returned in bulk.
    if (m % 47 === 19) {
      for (const bbl of Object.keys(g.holdings)) {
        const h0 = g.holdings[bbl];
        if (h0.sale || g.developments[bbl] || h0.leasingHold) continue;
        g = E.setLeasingHold(g, bbl, true);
        break;
      }
    }
    if (m % 53 === 31) {
      for (const bbl of Object.keys(g.holdings)) {
        const h0 = g.holdings[bbl];
        if (h0.sale || g.developments[bbl] || !h0.tenants.length) continue;
        const r = E.buyOutTenants(g, parcels, bbl);
        if (!r.err) { g = r.s; break; }
      }
    }
    // ...and let it again, so a hold is not a one-way door in the sweep.
    if (m % 61 === 44) {
      for (const bbl of Object.keys(g.holdings)) {
        if (!g.holdings[bbl].leasingHold) continue;
        g = E.setLeasingHold(g, bbl, false);
        break;
      }
    }

    // Go to the planning board now and then — the variance path moves the
    // envelope, which moves land value, which moves net worth.
    if (m % 31 === 11 && !g.varianceApp) {
      for (const bbl of Object.keys(g.holdings)) {
        const r = E.fileVariance(g, parcels, bbl);
        if (!r.err) { g = r.s; break; }
      }
    }

    if (m % 13 === 6) {
      for (const bbl of Object.keys(g.holdings)) {
        const h0 = g.holdings[bbl];
        if (h0.sale || g.developments[bbl] || g.merged?.[bbl] || g.groundLeases?.[bbl]) continue;
        const rec0 = E.resolveRec(parcels, g, bbl);
        if (!rec0) continue;
        const v = E.holdingValue(rec0, g.econ, h0, g.month);
        if (v <= 0) continue;
        const r = E.listForSale(g, parcels, bbl, Math.round(v * 1.05), m % 2 ? "marketed" : "quiet");
        if (!r.err) { g = r.s; break; }
      }
    }

    for (const bbl of Object.keys(g.holdings)) {
      const h = g.holdings[bbl];
      // A MARKETED SALE is a process with state: a campaign, a bid list, best
      // and final, a retrade. None of it was swept until a bot ran one.
      if (h.sale?.bids?.length) {
        if ((h.sale.round ?? 0) === 0 && h.sale.bids.filter((b) => !b.dropped).length > 1 && m % 3 === 0) {
          const bf = E.bestAndFinal(g, parcels, bbl);
          if (!bf.err) g = bf.s;
        }
        const live = (g.holdings[bbl]?.sale?.bids ?? []).findIndex((b) => !b.dropped);
        if (live >= 0) {
          const ab = E.acceptBid(g, parcels, bbl, live);
          if (!ab.err) g = ab.s;
        }
        continue;
      }
      if (!h.sale?.offer) continue;
      const q = E.saleTaxQuote(h, h.sale.offer.price);
      const gp = h.costBasis > 0 ? q.gain / h.costBasis : 0;
      if (B.sell(gp) || h.sale.unsolicited) {
        const r = E.acceptSaleOffer(g, parcels, bbl);
        if (!r.err) g = r.s;
      }
    }

    if (m % B.every === 2) {
      const cands = g.listings.map((l) => ({ l, r: E.resolveRec(parcels, g, l.bbl) })).filter((x) => x.r)
        .map((x) => {
          const built = x.r.class !== "land" && x.r.bldgArea > 0;
          const noi = built ? E.noiYr(x.r, g.econ, E.initialCondition(x.r)) : 0;
          return { ...x, built, yield: built && x.l.ask > 0 ? noi / x.l.ask : 0 };
        }).filter(B.buy);
      for (const c of cands.slice(0, 6)) {
        const r = E.buyListing(g, parcels, c.l.bbl, B.prod(c), B.lev, Math.round(c.l.ask * 0.97));
        if (!r.err) { g = r.s; break; }
      }
    }

    // LAND PLAYS. Merge contiguous dirt into one site, and ground-lease what
    // is left over — both of them move land area and land value around, which
    // is exactly the kind of bookkeeping that quietly counts a lot twice.
    if (B.land && m % 9 === 5) {
      for (const bbl of Object.keys(g.holdings)) {
        if (g.merged?.[bbl] || g.groundLeases?.[bbl]) continue;
        const rec = E.resolveRec(parcels, g, bbl);
        if (!rec || rec.class !== "land" || rec.bldgArea > 0) continue;
        const nbrs = (adjacency[bbl] ?? []).filter((n) => {
          if (!g.holdings[n] || g.merged?.[n] || g.groundLeases?.[n] || g.developments[n]) return false;
          const r = E.resolveRec(parcels, g, n);
          return r && r.class === "land" && r.bldgArea === 0;
        });
        if (nbrs.length) {
          const r = E.assembleLots(g, parcels, adjacency, [bbl, ...nbrs.slice(0, 2)]);
          if (!r.err) { g = r.s; break; }
        } else if (m % 27 === 5) {
          // grantGroundLease conjured a tenant on click; the reshaped flow
          // OFFERS the ground and a counterparty arrives (or not) in the tick
          // Floor is GROUND_TERM_MIN (49); tower reversion needs 75+.
          const r = E.offerGroundLease(g, parcels, bbl, 49 + (m % 4) * 15);
          if (!r.err) { g = r.s; break; }
        }
      }
    }

    if (B.dev && m % 11 === 4) {
      for (const bbl of Object.keys(g.holdings)) {
        const rec = E.resolveRec(parcels, g, bbl);
        if (!rec || rec.class !== "land" || g.developments[bbl]) continue;
        for (let fl = Math.min(E.maxFloorsFor(rec, 0.6), 20); fl >= 2; fl--) {
          const plan = E.planDevelopment(g, parcels, bbl, m % 3 === 0 ? "multifamily" : "office", fl, 0.6, m % 2 ? "gmp" : "costplus");
          if (!plan || plan.commitment === 0 || plan.equityAtClose > g.cash * 0.5) continue;
          const r = E.startDevelopment(g, parcels, bbl, m % 3 === 0 ? "multifamily" : "office", fl, 0.6, m % 2 ? "gmp" : "costplus");
          if (!r.err) { g = r.s; break; }
        }
        break;
      }
    }


    // PRE-BUILD and BLEND-AND-EXTEND. Both move money and both rewrite the
    // rent roll in place, which is exactly where a bad index quietly corrupts
    // a building.
    if (m % 8 === 2) {
      for (const bbl of Object.keys(g.holdings)) {
        const h0 = g.holdings[bbl];
        const rec0 = E.resolveRec(parcels, g, bbl);
        if (!rec0 || rec0.class === "land" || h0.specSuites || g.developments[bbl]) continue;
        const r = E.buildSpecSuites(g, parcels, bbl, rec0.class, 5000);
        if (!r.err) { g = r.s; break; }
      }
    }
    if (m % 10 === 6) {
      for (const bbl of Object.keys(g.holdings)) {
        const h0 = g.holdings[bbl];
        if (!h0.tenants?.length) continue;
        let done = false;
        for (let i = 0; i < h0.tenants.length && !done; i++) {
          const r = E.blendExtend(g, parcels, bbl, i);
          if (!r.err) { g = r.s; done = true; }
        }
        if (done) break;
      }
    }

    if (B.refi && m % 29 === 7) {
      for (const bbl of Object.keys(g.holdings)) {
        const h = g.holdings[bbl];
        if (!h.loan || g.month - h.loan.originM < 40) continue;
        const { quotes } = E.refiQuotes(g, parcels, bbl);
        const pick = B.mezz
          ? quotes.find((q) => q.available && q.id === "mezz") ?? quotes.filter((q) => q.available)[0]
          : quotes.filter((q) => q.available).sort((a, b) => b.maxProceeds - a.maxProceeds)[0];
        if (pick) {
          const r = E.refinance(g, parcels, bbl, pick.id, 1);
          if (!r.err) g = r.s;
        }
        break;
      }
      // and buy a cap now and then, because that path has money in it
      for (const bbl of Object.keys(g.holdings)) {
        const r = E.buyRateCap(g, parcels, bbl);
        if (!r.err) { g = r.s; break; }
      }
    }
    for (const v of E.checkInvariants(g, parcels)) record(botName, seed, g.month, v);
  }
}

const t0 = process.hrtime.bigint();
for (const bot of Object.keys(BOTS)) {
  for (let i = 0; i < SEEDS; i++) run(bot, 4000 + i * 53);
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`${checks.toLocaleString()} months checked across ${Object.keys(BOTS).length} bots × ${SEEDS} seeds · ${(ms / 1000).toFixed(1)}s`);
if (!firstSeen.size) {
  console.log("no violations");
} else {
  console.log(`${firstSeen.size} distinct violation(s), first appearance each:`);
  for (const v of [...firstSeen.values()].sort((a, b) => a.month - b.month)) {
    console.log(`  m${String(v.month).padStart(4)} ${v.bot.padEnd(8)} seed ${v.seed}  [${v.code}] ${v.where}: ${v.detail}`);
  }
  process.exitCode = 1;
}
