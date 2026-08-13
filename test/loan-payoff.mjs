// Voluntary mortgage payoff — crumb balances must not block ground leases.
//
//   pnpm engine && node test/loan-payoff.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let fails = 0;
const ok = (name, pass, detail) => {
  console.log(`  ${pass ? "OK   " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) fails++;
};

console.log("\nLOAN PAYOFF — retire a crumb mortgage\n");

let g = E.firstListings(E.newGame(12007, parcels), parcels, bbls);

// Find vacant land the player can own.
let land = null;
for (const b of bbls) {
  const r = E.resolveRec(parcels, g, b);
  if (r && (r.class === "land" || !r.bldgArea) && r.lotArea > 5000) { land = b; break; }
}
if (!land) { console.error("no land"); process.exit(1); }

g.holdings[land] = {
  bbl: land, boughtM: 0, costBasis: 1e6, condition: "average",
  tenants: [], loan: null, assessed: 1e6, condIdx: 0.7, svcIdx: 0.7,
  service: 0, stance: 0, plan: 1, cfHistory: [],
};
g.cash = 5_000_000;

// Crumb IO land loan — the screenshot case.
g.holdings[land].loan = {
  product: "harbor",
  floating: false,
  points: 0,
  recourse: true,
  prepay: "open",
  prepayUntilM: 0,
  principal: 26,
  balance: 26,
  ratePct: 5.5,
  spread: 2,
  ioUntilM: g.month + 60,
  amortYears: 25,
  maturityM: g.month + 120,
  monthlyPmt: 1,
  minDSCR: 1.2,
  maxLTV: 0.65,
  sweep: false,
  cleanQs: 0,
  originM: 0,
  origValue: 1e6,
};

const blocked = E.offerGroundLease(g, parcels, land, 75, "fixed");
ok("ground lease blocked while crumb loan sits", !!blocked.err, blocked.err);

const due = E.payOffDue(g.holdings[land].loan, g.month);
ok("payoff due is the $26 balance", due.due === 26 && due.penalty === 0, JSON.stringify(due));

const paid = E.payOffLoan(g, parcels, land);
ok("payoff succeeds", !paid.err && !!paid.s.holdings[land] && !paid.s.holdings[land].loan, paid.err ?? paid.msg);
ok("cash dropped by $26", Math.abs((paid.s.cash ?? 0) - (5_000_000 - 26)) < 1, `cash=${paid.s.cash}`);

const offered = E.offerGroundLease(paid.s, parcels, land, 75, "fixed");
ok("ground lease opens after payoff", !offered.err && !!offered.s.holdings[land].groundOffer, offered.err ?? offered.msg);

// Break fee path
g = paid.s;
g.holdings[land].loan = {
  product: "harbor", floating: false, points: 0, recourse: true,
  prepay: "stepdown", prepayUntilM: g.month + 36,
  principal: 1_000_000, balance: 1_000_000, ratePct: 6, spread: 2,
  ioUntilM: g.month, amortYears: 25, maturityM: g.month + 120,
  monthlyPmt: 5000, minDSCR: 1.2, maxLTV: 0.65, sweep: false,
  cleanQs: 0, originM: g.month, origValue: 2e6,
};
g.cash = 2_000_000;
const due2 = E.payOffDue(g.holdings[land].loan, g.month);
ok("stepdown break fee is positive", due2.penalty > 0 && due2.due === due2.balance + due2.penalty, JSON.stringify(due2));
const paid2 = E.payOffLoan(g, parcels, land);
ok("payoff with break fee clears lien", !paid2.err && !paid2.s.holdings[land].loan, paid2.err ?? paid2.msg);

console.log(fails ? `\n${fails} failed\n` : "\nloan-payoff pass\n");
process.exit(fails ? 1 : 0);
