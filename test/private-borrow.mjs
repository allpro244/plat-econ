// Private credit Phase B — accept a rival bridge when banks won't clear.
//
//   pnpm engine && node test/private-borrow.mjs
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

const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(12007, parcels, 10_000_000), parcels, bbls);
g.citySize = "city";

// Put a financed building in the player's book with a near balloon the cheap
// desks cannot clear — inject a private borrow quote and accept it.
const listing = g.listings?.[0] ?? null;
check(!!listing, `have a listing to buy (${listing?.bbl ?? "none"})`);
const bbl = listing.bbl;
const bought = E.buyListing(g, parcels, bbl, "cash");
check(!bought.err, `buy cash — ${bought.err ?? "ok"}`);
g = bought.s;
const h = g.holdings[bbl];
check(!!h, "holding on book");
const rec = E.resolveRec(parcels, g, bbl);
const asIs = Math.round(E.ownedHoldingValue(g, parcels, h));
const face = Math.round(Math.min(asIs * 0.6, 2_000_000) / 25_000) * 25_000;

// Seed an existing bank loan we need to take out.
h.loan = {
  product: "harbor",
  principal: face,
  balance: face,
  ratePct: 6.5,
  spread: 2.5,
  ioUntilM: g.month + 24,
  amortYears: 30,
  maturityM: g.month + 2,
  monthlyPmt: Math.round((face * 6.5) / 100 / 12),
  minDSCR: 1.2,
  maxLTV: 0.8,
  sweep: false,
  cleanQs: 0,
  originM: g.month - 12,
  origValue: asIs,
  prepay: "open",
  prepayUntilM: g.month - 1,
};
g.workouts = {
  [bbl]: {
    bbl,
    lender: "First Harbor Bank",
    startM: g.month,
    stage: "notice",
    cause: "balloon",
    cure: face,
    decideM: g.month + 6,
    asks: 0,
  },
};

const lender = (g.rivals ?? []).find((r) =>
  r.failedM === undefined
  && (r.style === "opportunistic" || r.style === "pe" || r.style === "vulture" || r.style === "merchant"));
check(!!lender, `have a private lender rival (${lender?.name ?? "none"})`);
lender.cash = Math.max(lender.cash, face * 2);

g.privateBorrowQuotes = [{
  id: "Btest",
  lenderId: lender.id,
  lenderName: lender.name,
  bbl,
  address: rec.address,
  principal: face,
  ratePct: 13.25,
  points: 0.02,
  termM: 12,
  ltv: face / asIs,
  asIs,
  why: "Test bridge.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];

const attn = E.attentionItems(g);
check(attn.some((a) => a.key === "private-borrow:Btest"), "attention lists private borrow");

const cash0 = g.cash;
const lenderCash0 = lender.cash;
const accepted = E.acceptPrivateBorrowQuote(g, parcels, "Btest");
check(!accepted.err, `accept succeeds — ${accepted.err ?? accepted.msg}`);
g = accepted.s;
const h2 = g.holdings[bbl];
const r2 = g.rivals.find((x) => x.id === lender.id);
check(!!h2.loan, "holding has a loan");
check(h2.loan.holder === lender.name, `holder is rival (${h2.loan.holder})`);
check(h2.loan.balance === face, `balance is face`);
check(Math.abs(h2.loan.ratePct - 13.25) < 0.01, `rate preserved`);
check(!g.workouts?.[bbl], "balloon workout cleared");
check((g.privateBorrowQuotes ?? []).length === 0, "quote consumed");
const points = Math.round(face * 0.02);
check(r2.cash === lenderCash0 - (face - points), `lender cash out net of points (${r2.cash} vs ${lenderCash0 - (face - points)})`);
// Net draw was ~0 (same face payoff) minus points — cash should drop by points.
check(g.cash === cash0 - points, `borrower paid points (${g.cash} vs ${cash0 - points})`);

// Decline path
g.privateBorrowQuotes = [{
  id: "Bpass",
  lenderId: lender.id,
  lenderName: lender.name,
  bbl,
  address: rec.address,
  principal: 500_000,
  ratePct: 14,
  points: 0.02,
  termM: 9,
  ltv: 0.2,
  asIs,
  why: "Pass me.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];
const declined = E.declinePrivateBorrowQuote(g, "Bpass");
check(!declined.err, "decline ok");
g = declined.s;
check((g.privateBorrowQuotes ?? []).length === 0, "declined quote removed");

// Coupon month on private paper
const cash1 = g.cash;
g = E.advanceMonth(g, parcels, bbls, adjacency);
const cpn = Math.round((face * 13.25) / 100 / 12);
check(g.cash <= cash1 - cpn + 50_000, `coupon roughly left cash (was ${cash1}, now ${g.cash}, cpn ${cpn})`);

console.log(fails ? `\n${fails} failed\n` : "\nprivate-borrow pass\n");
process.exit(fails ? 1 : 0);
