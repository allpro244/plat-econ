// HOW LONG THE MONEY IS TRAPPED, AND WHAT A ROUND TRIP COSTS.
//
// CLAUDE.md names ten things that are supposed to make this game hard, and puts
// these two first: "illiquidity and the months a sale actually takes" and
// "transaction costs and transfer tax on both ends". Across forty-four harness
// scripts, NOTHING MEASURED EITHER. Both are modelled — SALE_BROKERAGE,
// TRANSFER_TAX, listings with real clocks — and no check has ever asked whether
// the months-to-sell distribution is plausible or what the friction costs over
// a career.
//
// That is the most expensive kind of gap. Illiquidity is the defining property
// of real estate against every other asset class: it is why leverage is
// dangerous here and merely expensive elsewhere, why a downturn traps you
// instead of costing you, and why the exit is a decision rather than a click.
// If the time-to-sell is wrong the entire risk profile is wrong — and the
// ledger would still reconcile, every band would still pass, and no harness in
// the repo would say a word.
//
// WHAT THIS MEASURES, and each against something real rather than against
// taste:
//
//   months from listing to closing        real CRE marketing periods run
//                                         6-12 months to a closing, longer in
//                                         a soft market and for secondary
//                                         assets
//   share that never sell at all          a real listing can be withdrawn; a
//                                         market where everything clears is
//                                         not illiquid at any speed
//   DOES IT GET WORSE IN A DOWNTURN       the important one. Liquidity is
//                                         pro-cyclical and it is the mechanism
//                                         that turns a paper loss into a
//                                         forced sale. A constant time-to-sell
//                                         is a market with no liquidity risk
//                                         in it at all, whatever its mean.
//   round-trip friction                   buy-side closing + sell-side
//                                         brokerage + transfer tax, as a share
//                                         of price. Real round trips run 4-8%.
import { assertFreshBundle } from "./fresh.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leaseAtMarket } from "./leasepolicy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
assertFreshBundle();
const E = await import(join(HERE, ".engine.mjs"));
const { makeCity } = await import(join(HERE, "..", "src", "citygen", "index.mjs"));

const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22").split(",").map(Number);
const MONTHS = Number(process.env.HZ ?? 600);
const q = (a, p) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/**
 * A patient owner who buys what it can, holds until the building is seasoned,
 * then puts it on the market and TAKES THE BEST OFFER IT GETS. It never walks
 * away from a bid, because the subject here is how long the market takes to
 * produce one — a bot that haggles would be measuring its own patience.
 */
function run(seed) {
  const b = makeCity("somewhere", 1);
  E.normalizeParcels(b.parcels);
  const parcels = JSON.parse(JSON.stringify(b.parcels));
  const bbls = Object.keys(parcels);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  g = { ...g, cash: 60e6 };

  const sales = [];                       // every completed round trip
  const listedAt = new Map();             // bbl -> { m, phase, ask }
  const boughtFor = new Map();            // bbl -> price paid
  let listings = 0, withdrawn = 0, relists = 0, episodes = 0;
  const hazard = {}, offered = new Set();

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, b.adjacency);
    if (g.gameOver) g = { ...g, gameOver: null, cash: 60e6 };
    g = { ...g, cash: Math.max(g.cash, 20e6) };   // never blocked for equity
    g = leaseAtMarket(E, g, parcels);

    // ---- buy, so there is always something to sell
    if (Object.keys(g.holdings).length < 8) {
      for (const li of [...g.listings]) {
        if (g.holdings[li.bbl]) continue;
        const rec = E.resolveRec(parcels, g, li.bbl);
        if (!rec || rec.class === "land" || !(rec.bldgArea > 0)) continue;
        const r = E.executePurchase(g, parcels, li.bbl, li.ask, "cash", false, 1);
        if (!r.err) { g = r.s; boughtFor.set(li.bbl, li.ask); break; }
      }
    }

    // ---- list anything seasoned and not already on the market
    for (const h of Object.values(g.holdings)) {
      if (h.sale || m - (h.boughtM ?? 0) < 24) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec) continue;
      const ask = Math.round(E.holdingValue(rec, g.econ, h, g.month));
      const r = E.listForSale(g, parcels, h.bbl, ask, "marketed");
      if (!r.err) {
        g = r.s;
        listings++;
        // FROM WHEN THE OWNER FIRST TRIED TO SELL, NOT FROM THE LATEST ATTEMPT.
        //
        // A player's sale record LAPSES — the offer window closes and `h.sale`
        // clears — so a building nobody bids on comes back to this loop and is
        // listed again. Overwriting the start month each time measured the wait
        // from the last re-listing and reported a median of two months on a
        // building that had in fact been on the market for years. 593 listings
        // produced 163 sales and 18 still sitting; the missing 412 were the
        // same buildings being re-listed, and each re-listing was resetting the
        // clock this harness exists to read.
        // AN EPISODE IS ONE ATTEMPT TO SELL, NOT ONE CALL TO listForSale. The
        // engine clears `h.sale` on some paths, so this owner lists the same
        // building again and again; counting those as separate episodes made
        // "share that ever found a buyer" a ratio of closings to KEYSTROKES.
        if (!listedAt.has(h.bbl)) { listedAt.set(h.bbl, { m, phase: g.econ.phase, ask }); episodes++; }
        relists++;
      }
    }

    // THE HAZARD — the only unbiased read of liquidity in here.
    //
    // Both tables above are conditioned on something. Attributing an episode to
    // the phase it OPENED in is contaminated, because the median episode
    // outlives its phase and a peak listing rides into the bust behind it.
    // Attributing it to the phase it CLOSED in is worse: it conditions on
    // SUCCESS, so a recession column contains only the buildings that managed
    // to sell in a recession and the ones still stuck are invisible.
    //
    // This asks the question directly instead. For every building-month on the
    // market, what phase was it, and did an offer arrive? That is the monthly
    // arrival rate, with no survivorship in it and nothing outliving anything,
    // and it is exactly the quantity `phaseAdj` scales.
    //
    // IT HAS TO RUN BEFORE THE ACCEPT LOOP. The first cut sat after it and
    // counted ZERO offers over 9,661 building-months — every one had already
    // been taken and the holding was gone by the time this looked. A hazard of
    // exactly zero is not a finding, it is a harness reading a state its own
    // bot had already consumed.
    for (const bbl of listedAt.keys()) {
      const h = g.holdings[bbl];
      if (!h?.sale) continue;
      const ph = g.econ.phase;
      hazard[ph] ??= { months: 0, offers: 0 };
      hazard[ph].months++;
      if (h.sale.offer && !offered.has(bbl)) { hazard[ph].offers++; offered.add(bbl); }
      if (!h.sale.offer) offered.delete(bbl);
    }

    // ---- take the best offer on the table, whatever it is
    for (const h of Object.values(g.holdings)) {
      if (!h.sale?.offer) continue;
      const info = listedAt.get(h.bbl);
      const price = h.sale.offer.price;
      const paid = boughtFor.get(h.bbl);
      const r = E.acceptSaleOffer(g, parcels, h.bbl);
      if (r.err) continue;
      g = r.s;
      if (info) {
        sales.push({ months: m - info.m, phase: info.phase, closePhase: g.econ.phase, ask: info.ask, price, paid });
        listedAt.delete(h.bbl);
      }
    }

    // A lapsed sale record is NOT the owner giving up — this bot re-lists next
    // month. The episode stays open; only a closing ends it.
    for (const bbl of [...listedAt.keys()]) if (!g.holdings[bbl]) { listedAt.delete(bbl); withdrawn++; }
  }
  // STILL ON THE MARKET WHEN THE MUSIC STOPPED. The first cut of this counted
  // only completed sales and reported "0 came off unsold", which made the
  // market look like it always clears. It does not: a player's listing has no
  // expiry, so a building nobody bids on simply sits, and those are the most
  // illiquid assets in the game and were invisible.
  const stuck = [...listedAt.values()].map((info) => MONTHS - info.m);
  return { sales, listings, withdrawn, stuck, relists, episodes, hazard };
}

const all = [], byPhase = {}, byClose = {}, stuck = [], haz = {};
let listings = 0, withdrawn = 0, episodes = 0, relists = 0;
for (const s of SEEDS) {
  const r = run(s);
  all.push(...r.sales); listings += r.listings; withdrawn += r.withdrawn; stuck.push(...r.stuck); episodes += r.episodes; relists += r.relists;
  for (const [k, v] of Object.entries(r.hazard)) { haz[k] ??= { months: 0, offers: 0 }; haz[k].months += v.months; haz[k].offers += v.offers; }
  for (const x of r.sales) { (byPhase[x.phase] ??= []).push(x.months); (byClose[x.closePhase] ??= []).push(x.months); }
}

console.log(`\n  ILLIQUIDITY — ${SEEDS.length} seeds x ${MONTHS / 12} years, a patient owner who takes every bid\n`);
console.log(`  ${episodes} selling episodes (${relists} listing actions — the engine clears the sale record and this owner re-lists),`);
console.log(`  ${all.length} closed, ${withdrawn} left the book another way,`);
console.log(`  ${stuck.length} STILL SITTING at the end — median ${q(stuck, 0.5)} months on the market, worst ${stuck.length ? Math.max(...stuck) : 0}`);
console.log(`  so ${(100 * all.length / Math.max(1, episodes)).toFixed(0)}% of selling episodes ever found a buyer`);
console.log(`  (the sale record lapses and this owner re-lists — the clock below runs from the FIRST attempt)`);
if (!all.length) { console.error("\n  NOTHING SOLD. The bot never got an offer — fix the harness before reading anything into that.\n"); process.exit(1); }

const mo = all.map((x) => x.months);
console.log(`\n  months from listing to closing`);
console.log(`    p10 ${q(mo, 0.1)}   p25 ${q(mo, 0.25)}   MEDIAN ${q(mo, 0.5)}   p75 ${q(mo, 0.75)}   p90 ${q(mo, 0.9)}   max ${Math.max(...mo)}`);
console.log(`    real marketing periods run 6-12 months to a closing`);

// BY THE PHASE THE EPISODE OPENED IN — AND THAT IS NOT THE PHASE IT LIVED IN.
//
// This table looked like it had found a bug: peak episodes took 31 months
// against 16 for expansion, which reads as "selling at the top is hard" and is
// backwards. It is not backwards. The median episode runs 16 months and a peak
// is immediately followed by a downturn, so an episode OPENED at the peak
// spends nearly all of its life in the recession after it. Read down the
// column and the sequence is exactly right: expansion 16 (rides into the
// peak), peak 31 (rides into the bust), recession 31 (in it), recovery 17
// (rides into the expansion). The label is the start of the wait, not the
// weather during it.
console.log(`\n  DOES IT GET WORSE IN A DOWNTURN — the one that matters`);
for (const p of ["expansion", "peak", "recession", "recovery"]) {
  const v = byPhase[p];
  if (!v?.length) { console.log(`    ${p.padEnd(11)} no sales`); continue; }
  console.log(`    ${p.padEnd(11)} median ${String(q(v, 0.5)).padStart(3)}mo   p90 ${String(q(v, 0.9)).padStart(3)}mo   n=${v.length}`);
}
console.log(`\n  ...and by the phase it CLOSED in, which is the weather that actually sold it`);
for (const p of ["expansion", "peak", "recession", "recovery"]) {
  const v = byClose[p];
  if (!v?.length) { console.log(`    ${p.padEnd(11)} no sales`); continue; }
  console.log(`    ${p.padEnd(11)} median ${String(q(v, 0.5)).padStart(3)}mo   p90 ${String(q(v, 0.9)).padStart(3)}mo   n=${v.length}`);
}
console.log(`\n  THE HAZARD — offers arriving per building-month on the market, by that month's`);
console.log(`  phase. No survivorship, nothing outliving its label; this is the real read.`);
for (const p of ["expansion", "peak", "recession", "recovery"]) {
  const v = haz[p];
  if (!v?.months) { console.log(`    ${p.padEnd(11)} no listing-months`); continue; }
  console.log(`    ${p.padEnd(11)} ${(100 * v.offers / v.months).toFixed(2)}% a month   (${v.offers} offers over ${v.months} building-months)`);
}
const hb = haz.expansion, hr = haz.recession;
if (hb?.months && hr?.months) {
  const rate = (x) => x.offers / x.months;
  console.log(`\n    expansion / recession = ${(rate(hb) / Math.max(1e-9, rate(hr))).toFixed(2)}x on the arrival rate`);
  console.log(`    liquidity is pro-cyclical: offers should be MEASURABLY scarcer in a downturn.`);
  console.log(`    A flat rate is a market with no liquidity risk in it, whatever its mean.`);
}

const rt = all.filter((x) => x.paid > 0);
if (rt.length) {
  const friction = rt.map((x) => (x.paid * 0.02 + x.price * (0.015 + 0.006)) / x.price);
  console.log(`\n  ROUND-TRIP FRICTION (buy-side 2 points + sell-side 1.5% + 0.6% transfer tax)`);
  console.log(`    median ${(100 * q(friction, 0.5)).toFixed(2)}% of price   —   real round trips run 4-8%`);
}
// SALE-TO-LIST IS NOT MEASURED HERE, AND IT IS WORTH SAYING WHY RATHER THAN
// PRINTING A WRONG NUMBER. This owner re-lists at a fresh appraisal every time
// the record lapses, so the ask that finally clears is not the ask the episode
// opened at — comparing the closing price to the FIRST ask reported 100.0% and
// was measuring years of value growth, not a negotiation. Reading it properly
// needs the ask live at the moment the bid lands, which means instrumenting the
// engine's own sale loop rather than the bot's memory of it.
console.log(`\n  NOT MEASURED: sale-to-list. This owner re-lists at a fresh appraisal, so`);
console.log(`  the closing price against the OPENING ask reads value growth, not haggling.\n`);
console.log(`  CAVEAT ON THE PHASE TABLE: an episode is attributed to the phase it OPENED`);
console.log(`  in, and the median episode outlives the phase it began in — so the`);
console.log(`  recession/expansion ratio understates a mechanism that is much stronger at`);
console.log(`  the source (offer arrival is scaled 1.3x in expansion against 0.5x in a`);
console.log(`  recession, a 2.6x swing). Read the ORDERING, not the size.\n`);
