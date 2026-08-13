// Phase C — mezz behind a bank senior; credit-book rails.
//
//   pnpm engine && node test/private-mezz.mjs
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
let g = E.firstListings(E.newGame(12007, parcels, 20_000_000), parcels, bbls);
g.citySize = "city";

const listing = g.listings?.[0];
check(!!listing, "have listing");
const bought = E.buyListing(g, parcels, listing.bbl, "cash");
check(!bought.err, `buy — ${bought.err ?? "ok"}`);
g = bought.s;
const bbl = listing.bbl;
const h = g.holdings[bbl];
const asIs = Math.round(E.ownedHoldingValue(g, parcels, h));

// Bank senior with room for mezz (60% LTV leaves headroom to 85%).
const senior = Math.round((asIs * 0.55) / 25_000) * 25_000;
h.loan = {
  product: "harbor",
  principal: senior,
  balance: senior,
  ratePct: 6.25,
  spread: 2.2,
  ioUntilM: g.month + 36,
  amortYears: 30,
  maturityM: g.month + 60,
  monthlyPmt: Math.round((senior * 6.25) / 100 / 12),
  minDSCR: 1.2,
  maxLTV: 0.8,
  sweep: false,
  cleanQs: 0,
  originM: g.month - 6,
  origValue: asIs,
  prepay: "open",
  prepayUntilM: g.month - 1,
};

const q0 = E.mezzQuote(g, parcels, bbl);
check(q0.available && q0.principal >= 250_000, `mezz quotes — ${q0.why ?? q0.principal}`);

// Private / Cordage senior refuses mezz (before we place one)
h.loan.product = "cordage";
h.loan.holder = "Kestrel Capital";
const qBad = E.mezzQuote(g, parcels, bbl);
check(!qBad.available, `mezz refused behind private — ${qBad.why}`);
h.loan.product = "harbor";
delete h.loan.holder;

const cash0 = g.cash;
const placed = E.placeMezz(g, parcels, bbl);
check(!placed.err, `place mezz — ${placed.err ?? placed.msg}`);
g = placed.s;
const h2 = g.holdings[bbl];
check(!!h2.mezz && h2.mezz.balance > 0, "mezz on holding");
check(h2.loan.balance === senior, "senior untouched");
const points = Math.round(h2.mezz.principal * h2.mezz.points);
check(g.cash === cash0 + h2.mezz.principal - points, `cash +net mezz (${g.cash})`);

// Second mezz refused
const q2 = E.mezzQuote(g, parcels, bbl);
check(!q2.available, `second mezz refused — ${q2.why}`);

// Credit book helpers
const book = E.creditBookFace(g);
const room = E.creditBookRoom(g, parcels);
check(Number.isFinite(book) && Number.isFinite(room), `credit book ${book} room ${room}`);

// Private borrow takeout must clear mezz (no orphaned junior)
const lender = (g.rivals ?? []).find((r) =>
  r.failedM === undefined
  && (r.style === "opportunistic" || r.style === "pe" || r.style === "merchant"));
check(!!lender, "lender for takeout");
lender.cash = Math.max(lender.cash, senior * 3);
const takeFace = Math.round((asIs * 0.65) / 25_000) * 25_000;
g.privateBorrowQuotes = [{
  id: "Bmezz",
  lenderId: lender.id,
  lenderName: lender.name,
  bbl,
  address: E.resolveRec(parcels, g, bbl).address,
  principal: takeFace,
  ratePct: 13,
  points: 0.02,
  termM: 12,
  ltv: takeFace / asIs,
  asIs,
  why: "Clear the stack.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];
// Age the senior so the spawn cooldown is irrelevant to accept.
h2.loan.originM = g.month - 24;
const took = E.acceptPrivateBorrowQuote(g, parcels, "Bmezz");
check(!took.err, `private takeout with mezz — ${took.err ?? "ok"}`);
g = took.s;
check(!g.holdings[bbl].mezz, "mezz cleared by private takeout");
check(g.holdings[bbl].loan?.holder === lender.name, "private senior in place");

console.log(fails ? `\n${fails} failed\n` : "\nprivate-mezz pass\n");
process.exit(fails ? 1 : 0);
