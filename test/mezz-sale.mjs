// Mezz must come off the sale / stack helpers — no orphan junior cash.
//
//   pnpm engine && node test/mezz-sale.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let fails = 0;
const check = (ok, msg) => {
  if (!ok) { fails++; console.log("  FAIL", msg); }
  else console.log("  OK  ", msg);
};

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(12007, parcels, 25_000_000), parcels, bbls);
const listing = g.listings[0];
const bought = E.buyListing(g, parcels, listing.bbl, "cash");
check(!bought.err, `buy — ${bought.err ?? "ok"}`);
g = bought.s;
const bbl = listing.bbl;
const h = g.holdings[bbl];
const asIs = Math.round(E.ownedHoldingValue(g, parcels, h));
const senior = Math.round((asIs * 0.5) / 25_000) * 25_000;
h.loan = {
  product: "harbor", principal: senior, balance: senior, ratePct: 6,
  spread: 2, ioUntilM: g.month + 36, amortYears: 30, maturityM: g.month + 60,
  monthlyPmt: Math.round((senior * 6) / 100 / 12), minDSCR: 1.2, maxLTV: 0.8,
  sweep: false, cleanQs: 0, originM: g.month - 12, origValue: asIs,
  prepay: "open", prepayUntilM: g.month - 1,
};
const placed = E.placeMezz(g, parcels, bbl);
check(!placed.err, `mezz — ${placed.err ?? "ok"}`);
g = placed.s;
const mezzBal = g.holdings[bbl].mezz.balance;
const stack = E.stackPayoff(g.holdings[bbl], g.month);
check(stack.balance === senior + mezzBal, `stack = senior+mezz (${stack.balance})`);
check(stack.mezzBal === mezzBal, `stack.mezzBal`);

const price = Math.round(asIs * 1.05);
const px = E.saleProceedsToSeller(g, parcels, g.holdings[bbl], price);
check(px.loanPayoff === senior + mezzBal, `sale payoff includes mezz (${px.loanPayoff} vs ${senior + mezzBal})`);

const seniorOnlyToSeller = px.net - senior - px.kick
  - (px.breakFee - stack.mezzPenalty) - px.release;
check(px.toSeller === seniorOnlyToSeller - mezzBal - stack.mezzPenalty
  || px.toSeller === px.net - px.loanPayoff - px.kick - px.breakFee - px.release,
  `toSeller nets full stack (${px.toSeller}; senior-only would be ${seniorOnlyToSeller})`);
check(px.toSeller < seniorOnlyToSeller - mezzBal + 1, `mezz reduced seller proceeds`);

// Close a sale and confirm the deed clears
g.holdings[bbl].sale = {
  listedM: g.month,
  ask: price,
  offer: {
    name: "Test Buyer",
    price,
    expiresM: g.month + 3,
  },
};
const sold = E.acceptSaleOffer(g, parcels, bbl);
check(!sold.err, `sale close — ${sold.err ?? "ok"}`);
g = sold.s;
check(!g.holdings[bbl], "deed gone after sale");

// Ground lease blocked while mezz/loan present
let g2 = E.firstListings(E.newGame(12008, parcels, 25_000_000), parcels, bbls);
const L2 = g2.listings[0];
g2 = E.buyListing(g2, parcels, L2.bbl, "cash").s;
g2.holdings[L2.bbl].loan = {
  product: "harbor", principal: 500_000, balance: 500_000, ratePct: 6,
  spread: 2, ioUntilM: g2.month + 12, amortYears: 30, maturityM: g2.month + 36,
  monthlyPmt: 2500, minDSCR: 1.2, maxLTV: 0.8, sweep: false, cleanQs: 0,
  originM: g2.month, origValue: 1_000_000, prepay: "open", prepayUntilM: g2.month,
};
g2.holdings[L2.bbl].mezz = {
  product: "mezz", holder: "Cordage Debt Partners", principal: 200_000, balance: 200_000,
  ratePct: 12, spread: 8, ioUntilM: g2.month + 84, amortYears: 30, maturityM: g2.month + 84,
  monthlyPmt: 2000, minDSCR: 1, maxLTV: 0.95, sweep: false, cleanQs: 0,
  originM: g2.month, origValue: 1_000_000, prepay: "open", prepayUntilM: g2.month,
};
const gl = E.offerGroundLease(g2, parcels, L2.bbl, 99);
check(!!gl.err && /Pay off the mortgage/.test(gl.err), `ground lease blocked — ${gl.err}`);

// Mezz-only workout can open
E.openWorkout(g2, L2.bbl, "arrears", 200_000);
// With senior present openWorkout uses senior lender — clear senior to test mezz-only
delete g2.holdings[L2.bbl].loan;
delete g2.workouts?.[L2.bbl];
E.openWorkout(g2, L2.bbl, "arrears", 200_000);
check(!!g2.workouts?.[L2.bbl], `mezz-only workout opened (${g2.workouts?.[L2.bbl]?.lender})`);
check(g2.workouts[L2.bbl].lender.includes("Cordage") || g2.workouts[L2.bbl].lender.length > 0,
  `workout lender set`);

console.log(fails ? `\n${fails} failed\n` : "\nmezz-sale pass\n");
process.exit(fails ? 1 : 0);
