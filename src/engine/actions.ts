// Player actions: buy listed or off-market (cash / fixed / floating IO),
// approach owners with assemblage pressure, sell, renovate. Pure — each
// returns a new state or an error string, never mutates the input.
import type { Adjacency, ParcelRecord, ParcelTable } from "@/data/types";
import type { Bid, BuiltClass, Econ, GameState, GroundLease, GroundReview, Holding, RivalStyle } from "./types";
import { logBooks, monthLabel, raiseAlert, SVC_START, START_YEAR, cloneState } from "./types";
import { recentLowballs, sellerOf, strikeDeal } from "./acquire";
import { creditBrokerFee, tickEarlyLooks } from "./broker";
import { firmShort, describeFirm } from "./firm";
import { rng, rrange, newsChance, BUILD_MONTHS } from "./market";
import { assetValue, condGrade, initialCondition, initialCondIdx, ownedHoldingValue, landValue, renovationCost, RENO_MONTHS, resolveRec, inPlace, demandLinear, landPsfNow, worthTheCall, bareLandRec } from "./value";
import { locAvailable, sweepLocIdleCash } from "./credit";
import { clearRivalClaims, marketAppetite, ownerOf, rivalAsk, rivalBuys, qualifiedBuyers, livingRivals, gradeOf, tie, sellToOutsider, forgetDeed } from "./rivals";
import { genRentRoll, isCommercial, depositsOn, stampApproach } from "./leasing";
import { releaseCost, RELEASE_PREMIUM } from "./facility";
import { holderOf, offend, credit, isCold, relOf, relMult, coldOnDeed, coldRefuseMsg } from "./owners";
import { originate, quote, productById, stabViewFor, monthlyPayment, stackPayoff } from "./debt";
import { takeoverDevelopment, buildClimate, farMaxFor, replacementCost } from "./dev";
import { demandNow } from "./demand";
import { recordComp } from "./comps";
import { cancelSupplyProject, queueSupplyProject } from "./supply";
import { recordPropertyEvent } from "./history";

/**
 * WHO BUYS THE BUILDINGS THE PLAYER DOES NOT.
 *
 * The tape had exactly one anonymous buyer — "a buyer from out of town" — and
 * printed it for 86% of every closed sale in the city. A market in which one
 * unnamed party buys everything is not a market, it is a placeholder. These
 * are the kind of counterparty that actually clears a small city's product:
 * out-of-state capital, a family office, a 1031 buyer chasing a deadline.
 */
const OUT_OF_TOWN = [
  "a pension fund out of Hartford", "a family office from Providence",
  "an insurance company out of Springfield", "a 1031 buyer on a deadline",
  "a syndicator from the city", "an out-of-state REIT",
  "a private buyer, name withheld", "a doctors' partnership",
  "a foreign buyer through a nominee", "a local family trust",
  "a bank's own real estate arm", "an owner-occupier buying their own premises",
];

const CLOSING_PCT = 0.02;
const SALE_FRICTION = 0.012;  // legal, title, diligence — the unavoidable rest
export const CAP_GAINS_RATE = 0.2;    // long-term rate on true appreciation
export const RECAPTURE_RATE = 0.25;   // §1250: depreciation comes back at 25%
export const SALE_BROKERAGE = 0.015;  // the sell-side fee
export const TRANSFER_TAX = 0.006;    // deed stamps, paid at the closing table
export const EXCHANGE_WINDOW_M = 6;  // 1031: redeploy within six months or the tax comes due

export type BuyProduct = string;   // "cash", or any id from debt.PRODUCTS

function clone(s: GameState): GameState {
  return cloneState(s);
}

export function buyQuote(s: GameState, parcels: ParcelTable, bbl: string, price: number, product: BuyProduct, lev = 1) {
  // THE RESOLVED RECORD, ALWAYS. The static table is what the lot looked like
  // at generation; `resolveRec` is what is standing on it today, after
  // deliveries, rezonings, variances and assemblage. Sizing a loan against the
  // static one underwrote a delivered tower as the vacant lot it used to be.
  const rec = resolveRec(parcels, s, bbl);
  const closing = Math.round(price * CLOSING_PCT);
  if (product === "cash" || !rec) {
    return { principal: 0, ratePct: 0, equity: price + closing, capPremium: 0, pointsFee: 0, bind: "none" as const, ltvCap: 0, uwDscr: 0, appraised: 0, uwBasis: price, overpay: 0 };
  }
  const prod = productById(product);
  // the life company will not finance a tired building, and the quote screen
  // has to say so before the closing table does
  if (prod.minCondition === "good" && gradeOf(s, rec) !== "good") {
    return { principal: 0, ratePct: 0, equity: price + closing, capPremium: 0, pointsFee: 0, bind: "condition" as const, ltvCap: prod.ltv, uwDscr: prod.uwDscr, appraised: 0, uwBasis: price, overpay: 0 };
  }
  // THE LESSER OF COST OR VALUE — the single most important rule in
  // acquisition underwriting, and it was entirely absent.
  //
  // This sized the loan on the PRICE PAID and nothing else, so overpaying by
  // forty per cent borrowed forty per cent more. That is exactly backwards. A
  // lender orders their OWN appraisal and advances against the LESSER of that
  // appraisal and the purchase price, because their collateral is the
  // building, not your enthusiasm for it. Every dollar above the appraisal is
  // funded with equity — which is what makes overpaying hurt at the closing
  // table rather than five years later, and is the reason a bidding war is a
  // real decision instead of a free one.
  //
  // The NOI is underwritten off the same basis for the same reason: a
  // coverage test struck against a price nobody but you believes in is not a
  // test. And it cuts only one way — pay UNDER the appraisal and the lender
  // still only lends against what you paid, because the deal is the best
  // evidence of value there is. That asymmetry is the rule, not a penalty.
  const appraised = assetValue(rec, s.econ, gradeOf(s, rec));
  const uwBasis = appraised > 0 ? Math.min(price, appraised) : price;
  const overpay = Math.max(0, price - uwBasis);
  // A LENDER UNDERWRITES THE INCOME THE BUILDING ACTUALLY EARNS.
  //
  // This sized coverage and debt yield off `noiAfterTaxYr` — the class model's
  // opinion of what a building like this one ought to make, computed from a
  // ParcelRecord that structurally cannot see a rent roll. Measured over 3,195
  // listings, that estimate ran 89% occupancy against a real roll of 69%, and
  // the gap was WIDEST on the highest quoted yields. So every credit committee
  // in the city was advancing against income that did not exist, hardest on
  // exactly the deals where it existed least.
  //
  // A real desk underwrites T-12 and in-place rent roll, takes the stabilised
  // pro-forma as a separate schedule, and haircuts it. `inPlace` is the roll
  // the seller disclosed — the same number the panel quotes and the same number
  // the deed conveys. When nothing has been disclosed (a building nobody has
  // listed and nobody has rung about) it falls back to the model, which is
  // correct, because there is also no loan to size: you cannot buy it.
  // AND THE PLAN, FOR THE ONE DESK THAT LENDS ON PLANS. The pro forma at the
  // class's own natural occupancy — the engine's `noiYr(stabilised)`, not a
  // second opinion about what this building could do — capitalised at the
  // building's own cap rate. `quote` ignores it for every product but the debt
  // fund, and even there it only binds when the income in place cannot support
  // more, which is the definition of a lease-up. See sizeRest.
  const stab = stabViewFor(rec, s.econ, gradeOf(s, rec), uwBasis);
  const q = quote(s, prod, uwBasis, inPlace(rec, s, bbl, uwBasis).noi, rec.class, false, stab);
  const principal = Math.round(q.principal * Math.max(0, Math.min(1, lev)));
  // WHAT ACTUALLY LIMITED THE LOAN. The desk sizes on three tests and takes
  // the smallest: the advance rate, the coverage ratio, and the debt yield.
  // The engine has always known which one bound and never told anybody, which
  // is why a 72% lender quoting 47% looked arbitrary rather than arithmetical.
  const capped = prod.ltv * uwBasis;
  // Floating paper closes with a rate cap the lender insists on, and the
  // premium is part of the equity cheque — the cheaper coupon is not free.
  const prod2 = productById(product);
  const capPremium = prod2.floating ? Math.round(principal * 0.0125) : 0;
  // Origination points — refi and facility already charge them; acquisition
  // used to leave 0.6–2% of principal uncharged at the table.
  const pointsFee = Math.round(principal * prod2.points);
  return {
    principal, ratePct: q.ratePct, equity: price - principal + closing + capPremium + pointsFee, capPremium, pointsFee,
    // APPRAISAL OUTRANKS THE THREE UNDERWRITING TESTS when it is what bound,
    // because it is not a fact about the building — it is a fact about what
    // you agreed to pay. Telling somebody "advance rate" when the truth is
    // "you are over the appraisal" sends them off to fix the wrong thing.
    bind: overpay > price * 0.005 ? "appraisal"
      : q.stabConstrained ? "stab"
      : q.dscrConstrained ? "dscr"
      : q.dyConstrained ? "dy"
      : q.principal < capped * 0.995 ? "credit"
      : "ltv",
    ltvCap: prod.ltv, uwDscr: prod.uwDscr,
    /** What the lender underwrote, and how far over it you are going. */
    appraised, uwBasis, overpay,
  };
}

export function executePurchase(
  s: GameState, parcels: ParcelTable, bbl: string, price: number, product: BuyProduct, offMarket: boolean, lev = 1,
): { s: GameState; err?: string } {
  if (s.cityGroundLeases?.[bbl]) {
    return { s, err: "That fee is still subject to a ground lease. It is not freehold inventory." };
  }
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  if (s.holdings[bbl]) return { s, err: "You already own it." };
  const bq = buyQuote(s, parcels, bbl, price, product, lev);
  // Vehicle path: fundPay + live investment period draws `fund.cash`.
  // Otherwise GP cash — the balance-sheet default.
  const fromFund = !!(s.fundPay && s.fund && !s.fund.settled
    && s.month <= s.fund.investEndM);
  const purse = fromFund ? (s.fund?.cash ?? 0) : s.cash;
  if (purse < bq.equity) {
    return {
      s,
      err: fromFund
        ? `This deal needs $${(bq.equity / 1e6).toFixed(2)}M from the vehicle — you're short.`
        : `This deal needs $${(bq.equity / 1e6).toFixed(2)}M ${product === "cash" ? "all-cash" : "of equity"} — you're short.`,
    };
  }
  const next = clone(s);
  if (fromFund && next.fund) next.fund.cash -= bq.equity;
  else next.cash -= bq.equity;
  // Points are a financing cost, not purchase consideration — same split
  // refinance and the facility use (debtSvc vs borrowed/bought).
  const pointsFee = bq.pointsFee ?? 0;
  logBooks(next, "bought", bq.equity - pointsFee);
  // the fee found its way to a named shop, and the shop will remember
  creditBrokerFee(next, bbl);
  if (pointsFee > 0) logBooks(next, "debtSvc", pointsFee);
  // If a named firm owned it, they are the seller — the money and the deed
  // both move, and their balance sheet is one building lighter.
  {
    const seller = ownerOf(next, bbl);
    if (seller) {
      seller.bbls = seller.bbls.filter((b) => b !== bbl);
      forgetDeed(seller, bbl);
      const relief = Math.min(seller.debt, Math.round(price * seller.targetLtv));
      seller.debt -= relief;
      seller.cash += price - relief;
    }
  }
  clearRivalClaims(next, bbl);
  // A DEAL IS A RELATIONSHIP. You closed with a name, they got paid, and both
  // of you will remember it the next time either of you picks up the phone.
  { const seller = ownerOf(s, bbl); if (seller) tie(next, seller.id).deals++; }
  const holding: Holding = {
    bbl,
    boughtM: next.month,
    costBasis: price + Math.round(price * CLOSING_PCT),
    assessed: price, // the sale reassesses the property at the deal price
    loan: null,
    condition: gradeOf(s, rec),
    // The bricks, as a number, from the day the deed moves — the age of the
    // building plus what the last owner did about it. From here it is on you.
    condIdx: initialCondIdx(rec, next.month, gradeOf(s, rec)),
    // IT CLOSES ON THE HOUSE POLICY. A principal decides how they run buildings
    // once; a building that needs different treatment gets it on the panel.
    service: s.opsPolicy?.service ?? 0,
    stance: s.opsPolicy?.stance ?? 0,
    plan: s.opsPolicy?.plan ?? 1,
    svcIdx: SVC_START,
    tenants: [],
    cfHistory: [],
    // Vehicle deed — NOI and sale proceeds stay in fund.cash.
    ...(fromFund ? { fundOwned: true } : {}),
    // A landmark stays a landmark when the deed moves.
    ...(s.landmarks?.[bbl] !== undefined ? { landmarked: true } : {}),
  };
  // Whatever diligence did not find, you now own. It does not appear on the
  // closing statement; it appears eighteen months later as a roof.
  if (product !== "cash") {
    const prod = productById(product);
    // Same underwriting buyQuote used for the term sheet — lesser of cost or
    // value, in-place NOI on that basis, and the bridge stabilised view.
    // Originating on full `price` (and inPlace(..., price) which reassesses
    // tax off the deal) wrote a smaller loan than the card promised and left
    // free equity in the deal.
    const uwBasis = bq.uwBasis ?? price;
    const stab = stabViewFor(rec, next.econ, holding.condition, uwBasis);
    holding.loan = originate(
      next, prod, uwBasis, inPlace(rec, next, bbl, uwBasis).noi, lev,
      holding.condition, rec.class, stab,
    );
    // Belt: if float still drifts a dollar, the written balance is the quoted one.
    if (holding.loan && bq.principal > 0 && holding.loan.balance !== bq.principal) {
      holding.loan.balance = holding.loan.principal = bq.principal;
      holding.loan.monthlyPmt = prod.ioM > 0
        ? Math.round((bq.principal * holding.loan.ratePct) / 100 / 12)
        : Math.round(monthlyPayment(bq.principal, holding.loan.ratePct, holding.loan.amortYears));
    }
  }
  // a live 1031: this purchase completes the exchange if it's big enough
  if (next.exchange && price >= next.exchange.minPrice * 0.8) {
    holding.costBasis -= next.exchange.rolledGain; // deferred gain carries into the new basis
    next.news.unshift({
      q: next.month, kind: "deal",
      text: `1031 completed: $${(next.exchange.rolledGain / 1e6).toFixed(2)}M of gain rolled into ${rec.address} — $${(next.exchange.deferredTax / 1e6).toFixed(2)}M of tax deferred.`,
    });
    next.exchange = null;
  }
  // A DISTRESSED DEED ARRIVES DISTRESSED. The seller's urgency was priced in
  // the ask; what the buyer takes over is the reason for it — empty floors and
  // deferred plant. See genRentRoll for the measurement that forced this.
  const wasListing = s.listings.find((l) => l.bbl === bbl);
  const wasDistress = !!wasListing?.distress;
  if (wasDistress && rec.class !== "land" && rec.bldgArea > 0) {
    holding.condIdx = Math.max(0.30, (holding.condIdx ?? 0.7) - 0.10);
    holding.condition = condGrade(holding.condIdx);
  }
  // WHAT THE OFFERING MEMORANDUM SHOWED IS WHAT THE DEED CONVEYS.
  //
  // This used to call genRentRoll at the CLOSING, so the tape quoted market
  // occupancy, the player bought against that, and the deed handed over
  // whatever roll the dice then wrote. Both numbers were honest; they were not
  // the same number; and the one on screen at the moment of decision was the
  // wrong one. That is the whole of the "my building loses half its value the
  // second I buy it" complaint.
  //
  // A marketed building now carries its roll from the day it is listed (see
  // refreshListings), and the closing takes it over verbatim.
  //
  // SO DOES AN OFF-MARKET ONE. That used to be the exception here — "there is
  // no offering memorandum on a lot you cold-called about" — and it is not
  // true of this business. An off-market approach is made subject to
  // diligence: the roll and the operating statements arrive before anybody
  // signs, and if they are not what you were told you retrade or you walk.
  // Leaving it out meant the panel wrote a preview roll off today's `s.month`
  // and today's `s.econ` and the deed wrote a different one three months later
  // — the same fault the listing path fixed, still live on every door the
  // player knocked on. See Approach.roll and stampApproach.
  // A CLOSED DEAL IS THE OTHER HALF OF THE RELATIONSHIP, and it is filed
  // against the person you bought from before the deed changes hands and they
  // stop being that person. See owners.credit: a holder who has sold to you
  // once picks up the phone the next time, which is most of what a track
  // record buys anybody in this business.
  {
    const held = holderOf(next, parcels, bbl);
    if (held) credit(next, held.id);
  }
  const wasApproach = next.approaches[bbl];
  const paper = wasListing?.roll !== undefined || wasListing?.occ !== undefined ? wasListing
    : wasApproach && !wasApproach.refused && (wasApproach.roll !== undefined || wasApproach.occ !== undefined) ? wasApproach
    : null;
  if (paper) {
    holding.tenants = paper.roll ?? [];
    if (paper.occ !== undefined) holding.occ = paper.occ;
    // ...and the grade the memorandum was priced at. The distress knock above
    // has already been applied to this value at listing time, so taking it
    // verbatim is what makes the NOI on the tape the NOI on the deed.
    if (paper.cond) { holding.condition = paper.cond; holding.condIdx = initialCondIdx(rec); }
    // THE DEPOSITS SETTLE HERE INSTEAD. genRentRoll normally credits them as it
    // writes the roll, because that is a closing; a roll written for a listing
    // passes settle=false, so the money moves at the deed rather than at the
    // advertisement. Cash in, liability up, no change in net worth.
    // Vehicle deed: deposits sit with the vehicle — same purse as the equity.
    const dep = depositsOn(holding);
    if (fromFund && next.fund) next.fund.cash += dep;
    else next.cash += dep;
  } else {
    genRentRoll(next, rec, holding, wasDistress);
    // genRentRoll settles deposits onto GP cash; a vehicle deed moves them over.
    if (fromFund && next.fund) {
      const dep = depositsOn(holding);
      next.cash -= dep;
      next.fund.cash += dep;
    }
  }
  next.holdings[bbl] = holding;
  // A RECEIVER'S SITE MAY HAVE A BUILDING HALF ON IT. If it does, what you
  // just bought is a job, not a lot, and you take it on at the closing.
  const halfBuilt = next.listings.find((l) => l.bbl === bbl)?.halfBuilt;
  next.listings = next.listings.filter((l) => l.bbl !== bbl);
  delete next.approaches[bbl];
  next.news.unshift({
    q: next.month, kind: "deal",
    // REPORTED, NOT NARRATED. This said "Deed recorded" in the passive voice of
    // a clerk. The same trade by a rival reads like a newspaper — name, an
    // appositive clause about who they are, and the number. The player got a
    // filing receipt. Now the paper covers them too, and the clause is earned:
    // every epithet behind it is a fact the player could have looked up.
    text: `${describeFirm(s)} has taken ${rec.address} at $${(price / 1e6).toFixed(2)}M`
      + `${holding.loan ? ` on $${(holding.loan.principal / 1e6).toFixed(1)}M of ${productById(holding.loan.product).lender} paper at ${holding.loan.ratePct}%` : ", all cash"}`
      + `${offMarket ? ", off-market" : ""}.`,
  });
  if (halfBuilt) takeoverDevelopment(next, parcels, bbl, halfBuilt);
  recordComp(next, rec, price, firmShort(s), ownerOf(s, bbl)?.name ?? (offMarket ? "a private owner" : "a listed seller"),
    s.listings.find((l) => l.bbl === bbl)?.distress, holding.condition, offMarket);
  return { s: next };
}

// Nobody pays the ask without asking. `bid` is what you're offering against
// the asking price; the seller weighs it against how motivated they are and
// how hot the market is. Push too far and the deal dies rather than merely
// being refused — a listing you blew up goes to somebody else.
/**
 * WILL THEY TAKE IT. A SELLER HAS A NUMBER, AND YOU CANNOT SEE IT.
 *
 * This was linear in the discount with a floor: `max(0.02, 1.02 - disc*6.2 + …)`.
 * The floor is the fault. Past about 80% of the ask the linear term has gone
 * negative and every offer below it — 70%, half, ONE DOLLAR — comes out at the
 * same 2%. So a bid of $1 on a $5M building closed one time in fifty, and the
 * dominant play was to put a dollar on every listing in town every month and
 * wait. That is a money pump, and it is the textbook shape of a rail holding
 * up a model: the floor was there so there would "always be a chance", and it
 * ended up deciding the whole lowball range.
 *
 * A seller does not roll dice against the discount. They have a reservation
 * price they will not go under, it is private, and it is not the same number
 * from one owner to the next. So the honest object is the CDF of that
 * reservation: the chance the person on the other side of this particular
 * table happens to be at or below what you offered. Logistic rather than
 * normal, because the tail is real — somewhere in a city there is always an
 * estate that wants it done this week — but it is a TAIL and it thins, instead
 * of levelling off into a free option.
 *
 * Calibrated on sale-to-list: commercial deals close at a median near 95% of
 * ask, so a bid at 95% is close to a coin flip, and that is where the centre
 * goes. The curve that comes out tracks the old one from full ask down to
 * ~80% — 0.57 vs 0.71 at 95%, 0.018 vs 0.020 at 80% — and then keeps falling
 * where the old one flattened: 1-in-950 at 70% of ask, and effectively never
 * for a dollar.
 */
const RESERVE_MID = 0.94;      // the median seller's reservation, as a share of their own ask
const RESERVE_SD = 0.035;      // spread across owners; distress widens it, below
export function bidOdds(
  s: GameState, parcels: ParcelTable, bbl: string,
  listing: { ask: number; distress?: boolean; reason?: string; receiverFor?: string; loanBasis?: number }, bid: number,
): number {
  const held = holderOf(s, parcels, bbl);
  if (held && isCold(s, held.id)) return 0;
  const r = bid / Math.max(1, listing.ask);               // 1 at full ask
  // The same three forces as before, moved from the probability onto the
  // seller's NUMBER, which is where they act. A recession does not make a
  // seller likelier to accept a given discount by some fixed amount of luck —
  // it lowers what they will settle for.
  const phase = s.econ.phase === "recession" ? -0.035 : s.econ.phase === "expansion" ? +0.025 : 0;
  const lenderSale = !!listing.distress && (listing.reason === "receiver" || !!listing.receiverFor || !!listing.loanBasis);
  const motivated = listing.distress ? (lenderSale ? -0.10 : -0.075) : 0;
  // A seller refuses a lowball because somebody else will pay more. How much
  // that is true depends on who else has money today — which is the whole
  // reason to know what the other firms on the street are doing.
  const room = (marketAppetite(s) - 1) * 0.05;
  let mid = RESERVE_MID + phase + motivated + room;
  if (held) mid -= (relMult(s, held.id) - 1) * 0.04;
  // A forced sale is not just cheaper, it is less predictable: a receiver with
  // a deadline and an estate with a lawyer settle in very different places.
  const sd = listing.distress ? (lenderSale ? 0.075 : 0.060) : RESERVE_SD;
  return Math.max(0, Math.min(0.98, 1 / (1 + Math.exp(-(r - mid) / sd))));
}

export function buyListing(
  s: GameState, parcels: ParcelTable, bbl: string, product: BuyProduct, lev = 1, bid?: number,
): { s: GameState; err?: string; msg?: string; refused?: boolean } {
  const listing = s.listings.find((l) => l.bbl === bbl);
  if (!listing) return { s, err: "That property is no longer on the market." };
  const cold = coldOnDeed(s, parcels, bbl);
  if (cold) return { s, err: coldRefuseMsg(cold) };
  const price = Math.round(bid ?? listing.ask);
  // THE AS-IS PATH. This is a real offer — full price, no contingencies, close
  if (price >= listing.ask) {
    const st = clone(s);
    return executePurchase(st, parcels, bbl, listing.ask, product, false, lev);
  }

  // check the money is there before spending a negotiation on it
  const q = buyQuote(s, parcels, bbl, price, product, lev);
  if (s.cash < q.equity) return { s, err: `That bid still needs $${(q.equity / 1e6).toFixed(2)}M of equity — you're short.` };

  const next = clone(s);
  const p = bidOdds(next, parcels, bbl, listing, price);
  const roll = rng(next);
  if (roll < p) {
    const done = executePurchase(next, parcels, bbl, price, product, false, lev);
    if (done.err) return { s, err: done.err };
    return { s: done.s, msg: `They took $${(price / 1e6).toFixed(2)}M.` };
  }
  // Refusal is not a purchase. Callers (and the toast path) used to treat a
  // missing `err` as "deed recorded," so a lowball that the seller waved off
  // still printed as a closing. `refused` carries the news / listing pull
  // without pretending the deed changed hands — same shape as approachOwner.
  if (roll < p + 0.45) {
    next.news.unshift({ q: next.month, kind: "info", text: `Your $${(price / 1e6).toFixed(2)}M on ${parcels[bbl]?.address} was refused — the ask stands.` });
    return { s: next, msg: "Refused. The ask stands.", refused: true };
  }
  // insulted: the listing goes away — and the person remembers across their book
  {
    const held = holderOf(next, parcels, bbl);
    if (held) offend(next, held.id, 14, parcels);
  }
  next.listings = next.listings.filter((l) => l.bbl !== bbl);
  next.news.unshift({ q: next.month, kind: "warn", text: `The seller at ${parcels[bbl]?.address} took the listing elsewhere after your offer.` });
  return { s: next, msg: "They walked, and pulled the listing.", refused: true };
}

// ---- off-market: approach the owner ---------------------------------------
// Not everything is for sale. Refusal odds and premiums rise with assemblage
// pressure: the more neighbors you own, the harder the holdout squeezes.
export function assemblagePressure(s: GameState, adjacency: Adjacency, bbl: string): number {
  const nbrs = adjacency[bbl] ?? [];
  if (!nbrs.length) return 0;
  return nbrs.filter((n) => s.holdings[n]).length / nbrs.length;
}

/**
 * MERGE THE LOTS YOU HAVE BEEN BUYING.
 *
 * Assemblage pressure has been in this file since the beginning: the more of a
 * block you own, the harder the last holdout squeezes, and every approach you
 * make gets dearer. That was a tax with no payoff — you could pay the premium
 * and still only ever build on one lot at a time.
 *
 * This is the payoff, and it is the whole reason anyone assembles: three lots
 * that carry six floors each carry one building of eighteen, on a plate three
 * times the size, with one core and one lobby instead of three. The envelope
 * is the sum of the deeds; the address is the biggest of them.
 *
 * Cost is real but small — survey, title, the lawyers who write it — because
 * the expensive part already happened at the closing table.
 */
export function mergeCost(s: GameState, lots: number): number {
  return Math.round((45_000 + 30_000 * lots) * s.econ.costIdx);
}

/** The parent of an assemblage, or the deed itself if it stands alone. */
export function siteRoot(s: GameState, bbl: string): string {
  return s.merged?.[bbl] ?? bbl;
}

/** Children folded into each parent — one scan of `merged`, not per call. */
function childrenIndex(s: GameState): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const [child, parent] of Object.entries(s.merged ?? {})) {
    const arr = idx.get(parent);
    if (arr) arr.push(child);
    else idx.set(parent, [child]);
  }
  return idx;
}

/** Every deed in a site — the root plus every child folded into it. */
export function siteDeeds(s: GameState, bbl: string, kids?: Map<string, string[]>): string[] {
  const root = siteRoot(s, bbl);
  return [root, ...(kids ?? childrenIndex(s)).get(root) ?? []];
}

/** Static lot area of an entire site (root + every child's original dirt). */
export function siteLotArea(
  s: GameState, parcels: ParcelTable, bbl: string, kids?: Map<string, string[]>,
): number {
  return siteDeeds(s, bbl, kids).reduce((a, d) => a + (parcels[d]?.lotArea ?? 0), 0);
}

/**
 * Cheap gate for the land desk: is there ANY owned site touching this one?
 * O(neighbours of this site), not a walk of the whole owned block. The desk
 * used to BFS the contiguous component on every render of every selected
 * parcel — including buildings with nothing to assemble — and every click
 * hitching on that walk is what the player felt.
 */
export function hasOwnedSiteNeighbor(
  s: GameState, adjacency: Adjacency, bbl: string,
): boolean {
  if (!s.holdings[bbl]) return false;
  const root = siteRoot(s, bbl);
  const touch = (d: string): boolean => {
    for (const n of adjacency[d] ?? []) {
      if (!s.holdings[n]) continue;
      if ((s.merged?.[n] ?? n) !== root) return true;
    }
    return false;
  };
  if (touch(root)) return true;
  for (const [child, parent] of Object.entries(s.merged ?? {})) {
    if (parent === root && touch(child)) return true;
  }
  return false;
}

/**
 * Site roots that share a property line with this site — adjacency walks
 * every deed in the assemblage, so a neighbour that only touches a folded
 * child still counts as contiguous. Roots, not children, so the caller can
 * treat already-assembled sites as single nodes.
 */
export function siteNeighborRoots(
  s: GameState, adjacency: Adjacency, bbl: string, kids?: Map<string, string[]>,
): string[] {
  const index = kids ?? childrenIndex(s);
  const mine = new Set(siteDeeds(s, bbl, index));
  const roots = new Set<string>();
  for (const d of mine) {
    for (const n of adjacency[d] ?? []) {
      if (mine.has(n)) continue;
      if (!s.holdings[n]) continue;
      roots.add(siteRoot(s, n));
    }
  }
  return [...roots];
}

/**
 * Owned contiguous sites reachable from `bbl` — the whole block of dirt you
 * can legally fold into one assemblage from this corner, as site roots.
 */
export function contiguousOwnedRoots(
  s: GameState, adjacency: Adjacency, bbl: string,
): string[] {
  if (!s.holdings[bbl]) return [];
  const kids = childrenIndex(s);
  const start = siteRoot(s, bbl);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of siteNeighborRoots(s, adjacency, cur, kids)) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return [...seen];
}

function assembleBlocker(
  s: GameState, parcels: ParcelTable, bbl: string,
): string | null {
  const root = siteRoot(s, bbl);
  for (const d of siteDeeds(s, root)) {
    if (!s.holdings[d]) return "You have to own every lot in the assemblage.";
    const rec = resolveRec(parcels, s, d);
    // Children already have lotArea 0 on the resolved record — vacancy is
    // judged on the ROOT of each site being folded in. A child of another
    // assemblage is reached via its root, never alone.
    if (d !== root) continue;
    if (!rec) return "Unknown parcel.";
    if (rec.class !== "land" || rec.bldgArea > 0) {
      return `${rec.address} still has a building on it. Clear the site before folding the deeds together.`;
    }
    if (s.landmarks?.[d] !== undefined) {
      return `${rec.address} is landmarked. Its envelope is frozen and it cannot be folded into a bigger site.`;
    }
    if (s.developments[d]) return `Construction is already underway at ${rec.address}.`;
    if (s.holdings[d].sale) return `${rec.address} is on the market — pull the listing first.`;
    if (s.groundLeases?.[d]) return `${rec.address} is under a ground lease. It is not yours to build on.`;
    if (s.holdings[d].loan || (s.holdings[d].mezz?.balance ?? 0) > 0) {
      return `${rec.address} still has a mortgage. Pay it off before you fold the title.`;
    }
    if (s.facility?.bbls?.includes(d)) {
      return `${rec.address} is in the portfolio facility. Release it before assembling.`;
    }
  }
  return null;
}

export function assembleLots(
  s: GameState, parcels: ParcelTable, adjacency: Adjacency, bbls: string[],
): { s: GameState; err?: string; msg?: string } {
  // Normalise to site roots. Passing a child, or the same site twice, or two
  // already-assembled parents that touch, all collapse to one node per site.
  const roots = [...new Set(bbls.map((b) => siteRoot(s, b)))];
  if (roots.length < 2) return { s, err: "Assemblage takes at least two lots." };
  for (const r of roots) {
    if (!s.holdings[r]) return { s, err: "You have to own every lot in the assemblage." };
    const why = assembleBlocker(s, parcels, r);
    if (why) return { s, err: why };
  }

  // CONTIGUOUS across site footprints — a neighbour that only touches a
  // folded child of an existing assemblage still joins the site. Walk the
  // root graph with site-aware adjacency.
  const set = new Set(roots);
  const seen = new Set([roots[0]]);
  const queue = [roots[0]];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of siteNeighborRoots(s, adjacency, cur)) {
      if (set.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
    }
  }
  if (seen.size !== roots.length) {
    return { s, err: "Those lots do not touch. An assemblage has to be one contiguous site." };
  }

  // Fee is on the number of DEEDS changing hands in the filing, not just the
  // number of already-assembled sites — three lots already folded once still
  // cost three when you pull in a fourth.
  const allDeeds = roots.flatMap((r) => siteDeeds(s, r));
  const cost = mergeCost(s, allDeeds.length);
  if (s.cash < cost) {
    return { s, err: `The survey, the title work and the lawyers run $${(cost / 1e3).toFixed(0)}k — you're short.` };
  }

  // Parent = largest site by total dirt (not just the root's original lot),
  // so growing a strip does not keep demoting a carefully built assemblage
  // to a child of a newly attached scrap.
  const sorted = [...roots].sort((a, b) => siteLotArea(s, parcels, b) - siteLotArea(s, parcels, a));
  const parent = sorted[0];
  const next = clone(s);
  next.cash -= cost;
  logBooks(next, "dev", cost);
  if (!next.merged) next.merged = {};

  for (const root of sorted.slice(1)) {
    // Fold every deed of the demoted site onto the new parent — including
    // the root itself and any children it already had. Leaving children
    // pointed at a demoted parent was the chain-merge bug: invariants
    // forbade parent-of-parent, and resolveRec dropped the orphaned area.
    for (const d of siteDeeds(next, root)) {
      if (d === parent) continue;
      next.merged[d] = parent;
      next.holdings[parent].costBasis += next.holdings[d].costBasis;
      next.holdings[d].costBasis = 0;
    }
  }

  const rec = resolveRec(parcels, next, parent)!;
  const deedsN = siteDeeds(next, parent).length;
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Assembled: ${deedsN} lots at ${rec.address} are now one site of ${Math.round(rec.lotArea).toLocaleString()} sf, `
      + `${(rec.lotArea * Math.max(rec.farMaxComm, rec.farMaxRes) / 1000).toFixed(0)}k sf buildable on a `
      + `${Math.round(rec.lotArea * 0.7).toLocaleString()} sf plate. One core, one lobby, and a floor somebody will take `
      + `a whole of. The dirt underneath reprices this morning at ${landPsfNow(rec, next.econ).toFixed(0)}/sf. `
      + `That is what all those premiums were for.`,
  });
  return { s: next, msg: `${deedsN} lots merged into one site at ${rec.address}.` };
}

/**
 * GRANT A GROUND LEASE ON A LOT YOU ARE NOT GOING TO BUILD ON.
 *
 * Land costs 1.2% a year to hold vacant. A ground lease is the real answer:
 * somebody else puts a building on your dirt, you take a coupon with a chosen
 * review structure and no operating risk, and you do not get the site back
 * for a very long time. The trade is income now against every cycle you will
 * sit through unable to build on it — and against the improvement reverting
 * to you at the end, aged.
 */
export const GROUND_REVIEW_LABEL: Record<GroundReview, string> = {
  fixed: "Fixed bumps",
  cpi: "CPI indexed",
  fmv: "FMV reappraisal",
};

/**
 * HOW LONG A GROUND LEASE HAS TO BE.
 *
 * Pads (shops, storage, dealerships) clear from 49 years — still a generation,
 * not a construction loan horizon. Full office / multifamily towers need 75+,
 * which is what leasehold lenders actually underwrite. Shorter paper used to
 * plant a max-FAR tower on $2M of dirt and hand the bones back for free.
 */
export const GROUND_TERM_MIN = 49;
/** Minimum term before a tower-scale lessee program is allowed. */
export const GROUND_TOWER_TERM_MIN = 75;

function isTowerGroundUse(use: BuiltClass): boolean {
  return use === "office" || use === "multifamily";
}

/**
 * THE FEE OWNER'S CASH FLOW ON AN ABSOLUTELY-NET GROUND LEASE.
 *
 * This game's form puts every property-level and transaction-level obligation
 * on the lessee: taxes, insurance, operation, construction, TI and the brokers
 * and lawyers who paper their leasehold. That is a specific deal structure,
 * not a claim that every ground lease in the world closes for free. It is the
 * structure quoted by this desk, and the player must be able to audit it.
 */
export function groundLeaseExpenseBreakdown(rentYr: number) {
  return {
    grossRentYr: Math.max(0, Math.round(rentYr)),
    propertyTaxYr: 0,
    insuranceYr: 0,
    operatingYr: 0,
    tiAtSigning: 0,
    brokerageAtSigning: 0,
    legalAtSigning: 0,
    netRentYr: Math.max(0, Math.round(rentYr)),
  };
}

export function groundLeaseQuote(
  s: GameState, parcels: ParcelTable, bbl: string, years: number, review: GroundReview = "fixed",
) {
  const raw = parcels[bbl];
  if (!raw || raw.class !== "land" || (raw.bldgArea ?? 0) > 0) return null;
  if ((s.built?.[bbl]?.bldgArea ?? 0) > 0) return null;
  if (years < GROUND_TERM_MIN) return null;
  const bare = bareLandRec(parcels, s, bbl);
  if (!bare || !bare.lotArea) return null;
  const land = landValue(bare, s.econ);
  // Base land yield: risk-free-ish plus a property spread. Longer terms pay
  // less starting rent (more optionality for the lessee). Review structure
  // moves the opening coupon the way the market does: FMV is cheapest to the
  // lessee up front (and hardest to place), fixed is dearest.
  //
  // RESIDUAL IN THE COUPON. Paper short of tower term leaves a valuable
  // reversion cliff the old quote never priced — a few land-yield points for
  // thirty years, then a free building. Compress that cliff into a higher
  // opening coupon and a harder place rate so short pad leases still clear
  // and mispriced short tower paper mostly does not.
  const termMult = years >= GROUND_TOWER_TERM_MIN ? 0.9
    : years >= 60 ? 1.02
    : 1.12;
  const residualPremium = years >= GROUND_TOWER_TERM_MIN ? 1
    : 1 + 0.55 * ((GROUND_TOWER_TERM_MIN - years) / (GROUND_TOWER_TERM_MIN - GROUND_TERM_MIN));
  const reviewMult = review === "fmv" ? 0.88 : review === "cpi" ? 0.95 : 1.0;
  let takeMult = review === "fmv" ? 0.55 : review === "cpi" ? 0.85 : 1.0;
  if (years < GROUND_TOWER_TERM_MIN) {
    takeMult *= 0.45 + 0.55 * ((years - GROUND_TERM_MIN) / (GROUND_TOWER_TERM_MIN - GROUND_TERM_MIN));
  }
  const capPct = Math.max(3.2, s.econ.indexRate * 0.62 + 2.5) * termMult * reviewMult * residualPremium;
  const rentYr = Math.round(land * (capPct / 100));
  // Short fixed paper steps harder — two polite +10%s over a pad life never
  // tracked the residual the fee owner was giving up.
  const stepPct = review === "fixed"
    ? (years >= GROUND_TOWER_TERM_MIN ? 12 : years >= 60 ? 14 : 16)
    : 0;
  const stepEveryM = review === "fixed" ? 120 : review === "cpi" ? 12 : 240;
  const padOnly = years < GROUND_TOWER_TERM_MIN;
  return {
    land, rentYr, capPct: +capPct.toFixed(2), years, review,
    stepPct, stepEveryM, takeMult, fmvCapPct: 3.5,
    /** Shorter than tower term: only pad uses will take. */
    padOnly,
    cashFlow: groundLeaseExpenseBreakdown(rentYr),
    reviewNote: review === "fixed"
      ? `+${stepPct}% every ten years — the leasehold lender's favourite`
      : review === "cpi"
        ? "Annual CPI (2% floor, 4% cap) — you keep up with inflation, not with the corner"
        : "FMV reset every 20 years, capped at 3.5%/yr compounded from day one — you share the land's appreciation",
    termNote: padOnly
      ? `Under ${GROUND_TOWER_TERM_MIN} years: pads only (shops, storage, dealerships). Towers need a longer lease — and at term the bones do not come free.`
      : `${GROUND_TOWER_TERM_MIN}+ years: a tower can rise, and the aged improvement reverts with the dirt.`,
  };
}

/**
 * OFFERING IS A LISTING, NOT A CLOSING. The offer sits on the holding; the
 * counterparty arrives through tickGroundLeases at odds set by demand, the
 * build climate, and how hard the review structure is to underwrite.
 */
export function offerGroundLease(
  s: GameState, parcels: ParcelTable, bbl: string, years: number, review: GroundReview = "fixed",
): { s: GameState; err?: string; msg?: string } {
  if (!s.holdings[bbl]) return { s, err: "You don't own that." };
  if (s.groundLeases?.[bbl]) return { s, err: "It is already ground-leased." };
  if (s.holdings[bbl].groundOffer) return { s, err: "It is already on offer. A ground lessee comes when one comes." };
  if (s.holdings[bbl].btsOffer || s.btsProspects?.[bbl]) {
    return { s, err: "It is being shopped for a build-to-suit. Pull that before you offer a ground lease." };
  }
  if (s.holdings[bbl].sale) return { s, err: "It's on the market — pull the listing before you encumber it." };
  if (s.developments[bbl]) return { s, err: "Construction is already underway." };
  if (s.merged?.[bbl]) return { s, err: "That lot is part of an assemblage — lease the whole site or none of it." };
  // A land loan and a ground lease cannot share the same dirt: the land desk
  // underwrites vacant carry, and the moment a coupon appears the collateral
  // is income paper. Clear the lien before you encumber the fee.
  if (s.holdings[bbl].loan || (s.holdings[bbl].mezz?.balance ?? 0) > 0) {
    const bal = Math.round(
      (s.holdings[bbl].loan?.balance ?? 0) + (s.holdings[bbl].mezz?.balance ?? 0),
    );
    return {
      s,
      err: `Pay off the mortgage first (Debt → Pay off — $${bal.toLocaleString()} left) — a land lender will not sit under a ground lease.`,
    };
  }
  if (s.facility?.bbls?.includes(bbl)) {
    return { s, err: "Release it from the facility first — the line is secured by vacant dirt, not a leased fee." };
  }
  const term = Math.round(years);
  if (term < GROUND_TERM_MIN) {
    return {
      s,
      err: `A ground lease has to run at least ${GROUND_TERM_MIN} years — shorter paper is a construction loan, not a ground lease.`,
    };
  }
  const q = groundLeaseQuote(s, parcels, bbl, term, review);
  if (!q || q.rentYr <= 0) return { s, err: "Nobody will ground-lease that." };
  const next = clone(s);
  next.holdings[bbl].groundOffer = { years: term, sinceM: next.month, review };
  return {
    s: next,
    msg: `Offered a ${term}-year ground lease (${GROUND_REVIEW_LABEL[review]})`
      + (q.padOnly
        ? ` — pads only until year ${GROUND_TOWER_TERM_MIN}; the bones will not revert for free.`
        : ` — long enough for a tower, and the aged improvement comes back with the dirt.`)
      + ` Now you wait for somebody who wants this corner that badly.`,
  };
}

/**
 * THE LEASED FEE LEFT YOUR BOOK.
 *
 * Selling or losing a leased fee does not cancel the lease. The coupon and
 * the reversion go with the deed. We keep the encumbrance on
 * `cityGroundLeases` so the site cannot reappear as freehold inventory (or get
 * torn down under the lessee) until the term ends.
 */
export function transferGroundLeaseOffBook(s: GameState, bbl: string): void {
  const gl = s.groundLeases?.[bbl];
  if (!gl) return;
  (s.cityGroundLeases ??= {})[bbl] = { ...gl };
  delete s.groundLeases![bbl];
  if (s.groundLeases && !Object.keys(s.groundLeases).length) delete s.groundLeases;
  const h = s.holdings[bbl];
  if (h) delete h.groundLeased;
}

/** Live ground lease on a parcel — yours, or one that left with a sold fee. */
export function liveGroundLease(s: GameState, bbl: string): GroundLease | undefined {
  return s.groundLeases?.[bbl] ?? s.cityGroundLeases?.[bbl];
}

/** Withdraw the offer. Nothing has signed, so nothing unwinds. */
export function pullGroundOffer(s: GameState, bbl: string): { s: GameState; err?: string; msg?: string } {
  if (!s.holdings[bbl]?.groundOffer) return { s, err: "It is not on offer." };
  const next = clone(s);
  delete next.holdings[bbl].groundOffer;
  return { s: next, msg: "Offer withdrawn. The dirt goes back to plain carry." };
}

const GROUND_TENANTS: { name: string; use: BuiltClass; lead: "fast" | "mid" | "slow" }[] = [
  { name: "a hotel operator", use: "multifamily", lead: "mid" },
  { name: "a grocery chain", use: "retail", lead: "fast" },
  { name: "a self-storage operator", use: "industrial", lead: "fast" },
  { name: "a hospital system", use: "office", lead: "slow" },
  { name: "a car dealership group", use: "retail", lead: "fast" },
  { name: "a data-centre developer", use: "industrial", lead: "mid" },
  { name: "a church", use: "office", lead: "mid" },
  { name: "a university", use: "office", lead: "slow" },
];

/** Weight lessees by whether their product fits the envelope and the term. */
function pickGroundTenant(s: GameState, parcels: ParcelTable, bbl: string, years: number) {
  const bare = bareLandRec(parcels, s, bbl);
  const far = bare ? farMaxFor(bare) : 3;
  const demand = parcels[bbl]?.demandScore ?? 50;
  const padOnly = years < GROUND_TOWER_TERM_MIN;
  let total = 0;
  const weights = GROUND_TENANTS.map((t) => {
    let w = 1;
    // Short paper: shops and sheds only. Hotels / hospitals / universities
    // need a leasehold a lender will amortise — that is the tower floor.
    if (padOnly && isTowerGroundUse(t.use)) w = 0;
    if (t.use === "industrial") w *= far > 6 ? 0.25 : far > 3.5 ? 0.55 : 1.15;
    if (t.use === "retail") w *= far > 8 ? 0.35 : demand < 35 ? 0.55 : 1.1;
    if (t.use === "office") w *= far < 2 ? 0.35 : far >= 4 ? 1.15 : 0.9;
    if (t.use === "multifamily") w *= far < 2.5 ? 0.4 : far >= 4 ? 1.2 : 1;
    if (t.name.includes("hotel")) w *= far < 3 || demand < 40 ? 0.25 : 1.1;
    if (t.name.includes("church")) w *= far > 5 || demand > 70 ? 0.3 : 1;
    if (t.name.includes("university") || t.name.includes("hospital")) w *= far < 2.5 ? 0.4 : 1;
    total += w;
    return w;
  });
  if (total <= 0) {
    // Degenerate lot under a short term — force a pad use that can still build.
    return GROUND_TENANTS.find((t) => t.use === "retail" || t.use === "industrial") ?? GROUND_TENANTS[1]!;
  }
  let r = rng(s, "sales") * Math.max(1e-9, total);
  for (let i = 0; i < GROUND_TENANTS.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return GROUND_TENANTS[i]!;
  }
  return GROUND_TENANTS[GROUND_TENANTS.length - 1]!;
}

/**
 * Gross SF a ground lessee may build under zoning — same envelope clamp as
 * `planDevelopment`. Exported so the harness can lock the FAR bug closed.
 */
export function groundLesseeBuildableSf(
  s: GameState, parcels: ParcelTable, bbl: string, use: BuiltClass,
): { sf: number; floors: number; far: number; envelope: number } | null {
  const bare = bareLandRec(parcels, s, bbl);
  if (!bare || !bare.lotArea) return null;
  const far = farMaxFor(bare);
  const cov = use === "industrial" ? 0.72 : use === "retail" ? 0.55 : 0.62;
  const floors = Math.max(1, Math.min(use === "retail" ? 2 : use === "industrial" ? 4 : 18,
    Math.ceil(far / Math.max(0.08, cov))));
  // SAME ENVELOPE CAP AS PLAYER DEVELOPMENT. Coverage × floors used to overrun
  // legal FAR whenever the top storey was a partial plate — the lessee planted
  // a bigger building than zoning allowed. Cap gross area at lot × FAR.
  // Do NOT floor at 4,000 sf afterward: on a small lot that punched back
  // through the envelope and recreated the bug.
  const envelope = bare.lotArea * far;
  const gsf = Math.min(bare.lotArea * cov * floors, envelope);
  if (gsf < 2000) return null;
  const sf = Math.round(gsf / 100) * 100;
  return { sf, floors, far, envelope };
}

function lesseeProgram(
  s: GameState, parcels: ParcelTable, bbl: string, use: BuiltClass, lead: "fast" | "mid" | "slow", years: number,
) {
  // Tower programs refuse short paper — caller should have filtered, but belt.
  if (years < GROUND_TOWER_TERM_MIN && isTowerGroundUse(use)) return null;
  const built = groundLesseeBuildableSf(s, parcels, bbl, use);
  if (!built) return null;
  const [bLo, bHi] = BUILD_MONTHS[use];
  const stretch = lead === "slow" ? 1.2 : lead === "mid" ? 1.05 : 1;
  const months = Math.round((bLo + rng(s, "dev") * (bHi - bLo)) * stretch);
  return { sf: built.sf, floors: built.floors, months, use };
}

/**
 * What it costs the fee owner to TAKE the leasehold improvement on short paper.
 * Depreciated replacement, haircut for leasehold buyout — not a free skyline.
 */
export function groundLeaseImprovementBuyout(
  s: GameState, parcels: ParcelTable, bbl: string,
  standing: { class: BuiltClass; bldgArea: number; floors: number; yearBuilt: number; mix?: ParcelRecord["mix"] },
): number {
  const raw = parcels[bbl];
  if (!raw || standing.bldgArea <= 0) return 0;
  const asRec = { ...raw, ...standing, yearBuilt: standing.yearBuilt };
  const repl = replacementCost(asRec, s.econ);
  const ageYrs = Math.max(0, START_YEAR + Math.floor(s.month / 12) - standing.yearBuilt);
  const life = standing.class === "industrial" ? 40 : standing.class === "retail" ? 35 : 50;
  const remaining = Math.max(0.18, 1 - ageYrs / life);
  // Leasehold buyout, not a freehold construction invoice.
  return Math.max(0, Math.round(repl * remaining * 0.55));
}

/** Long paper earns free reversion; shorter paper does not. */
export function groundLeaseFreeReversion(gl: GroundLease): boolean {
  const years = (gl.endM - gl.startM) / 12;
  return years + 1e-6 >= GROUND_TOWER_TERM_MIN;
}

function startLesseeJob(s: GameState, bbl: string, use: BuiltClass, sf: number, floors: number, months: number) {
  const deliverM = s.month + months;
  (s.cityJobs ??= []).push({
    bbl, use, sf, floors, startM: s.month, deliverM, groundLease: true,
    mix: { [use]: 1 } as never,
  });
  queueSupplyProject(s, {
    bbl,
    source: "ground-lease",
    deliverM,
    sfByUse: { [use]: sf },
  });
}

/**
 * Hand a standing lessee improvement back to the fee owner — vacant, aged from
 * when it actually opened, not marked as a delivery that just topped out.
 */
function revertLesseeImprovement(
  s: GameState, parcels: ParcelTable, bbl: string, h: Holding,
  standing: { class: BuiltClass; bldgArea: number; floors: number; yearBuilt: number; mix?: ParcelRecord["mix"] },
  gl: GroundLease,
) {
  const raw = parcels[bbl];
  const asRec = { ...(raw!), ...standing, yearBuilt: standing.yearBuilt };
  h.condIdx = initialCondIdx(asRec, s.month);
  h.condition = condGrade(h.condIdx);
  // Opened when the lessee topped out — not today. An aged shell is vacant
  // work, not a brand-new delivery with a four-year lease-up mark.
  h.deliveredM = gl.builtM ?? Math.max(0, (standing.yearBuilt - START_YEAR) * 12);
  h.tenants = [];
  h.occ = 0;
  h.service = h.service ?? 0;
  h.stance = h.stance ?? 0;
  h.plan = h.plan ?? 1;
}

/**
 * TERMINATE A DEFAULTED GROUND LEASE.
 *
 * Long paper (≥75y): the leasehold is the fee owner's security — dirt and
 * standing bones revert vacant, free. Short paper: default is not a free
 * tower. Mid-build always clears to dirt. Opened short leases clear the
 * improvement unless the fee owner can fund a leasehold buyout this month.
 */
export function defaultGroundLease(
  s: GameState, parcels: ParcelTable, bbl: string,
): boolean {
  const gl = s.groundLeases?.[bbl];
  const h = s.holdings[bbl];
  if (!gl || !h) return false;
  const standing = s.built?.[bbl];
  const address = parcels[bbl]?.address ?? bbl;
  const duringBuild = gl.builtM === undefined
    && (s.cityJobs ?? []).some((j) => j.bbl === bbl && j.groundLease);
  const freeBones = groundLeaseFreeReversion(gl);

  delete s.groundLeases![bbl];
  if (s.groundLeases && !Object.keys(s.groundLeases).length) delete s.groundLeases;
  delete h.groundLeased;
  // A default after opening should have no live frame, but cancelling here
  // makes the ownership transition correct for old saves and edge cases too.
  s.cityJobs = (s.cityJobs ?? []).filter((j) => !(j.bbl === bbl && j.groundLease));
  cancelSupplyProject(s, bbl);

  if (standing && standing.bldgArea > 0) {
    if (freeBones) {
      revertLesseeImprovement(s, parcels, bbl, h, standing, gl);
      recordPropertyEvent(s, bbl, {
        kind: "default",
        party: gl.tenant,
        outcome: `Ground lease terminated; ${Math.round(standing.bldgArea).toLocaleString()} sf improvement reverted vacant`,
      });
      raiseAlert(s, {
        kind: "ground",
        tone: "bad",
        title: `${gl.tenant} defaulted at ${address}`,
        body: `The ground rent has stopped and the lease has terminated. You now control the land and the `
          + `${standing.floors}-floor ${standing.class} building standing on it — that is what long paper secured.`,
        detail: `${Math.round(standing.bldgArea).toLocaleString()} sf reverted vacant`
          + ` (${standing.yearBuilt} building). It is now yours to operate, lease, finance, sell or redevelop.`,
      });
    } else {
      const buyout = groundLeaseImprovementBuyout(s, parcels, bbl, standing);
      if (buyout > 0 && s.cash >= buyout) {
        s.cash -= buyout;
        logBooks(s, "bought", buyout);
        revertLesseeImprovement(s, parcels, bbl, h, standing, gl);
        recordPropertyEvent(s, bbl, {
          kind: "default",
          party: gl.tenant,
          outcome: `Short ground lease terminated; paid ${Math.round(buyout).toLocaleString()} leasehold buyout for vacant shell`,
        });
        raiseAlert(s, {
          kind: "ground",
          tone: "bad",
          title: `${gl.tenant} defaulted at ${address}`,
          body: `Short ground paper does not gift the tower. You funded a $${(buyout / 1e6).toFixed(2)}M leasehold buyout `
            + `and took the ${standing.floors}-floor ${standing.class} vacant.`,
          detail: `${Math.round(standing.bldgArea).toLocaleString()} sf at depreciated replacement — the residual was never free on this term.`,
        });
      } else {
        delete s.built[bbl];
        recordPropertyEvent(s, bbl, {
          kind: "default",
          party: gl.tenant,
          outcome: buyout > 0
            ? `Short ground lease terminated; improvement cleared (buyout $${Math.round(buyout).toLocaleString()} unaffordable)`
            : "Short ground lease terminated; improvement cleared",
        });
        raiseAlert(s, {
          kind: "ground",
          tone: "bad",
          title: `${gl.tenant} defaulted at ${address}`,
          body: buyout > 0
            ? `The ground rent has stopped. Short paper does not hand you the building — a $${(buyout / 1e6).toFixed(2)}M `
              + `leasehold buyout was due and you could not fund it, so the improvement is gone and the vacant site is yours.`
            : "The ground rent has stopped. Short paper does not hand you the building — the vacant site is yours.",
          detail: "Carry resumes on dirt. Offer a longer ground lease next time if you want the reversion.",
        });
      }
    }
  } else {
    if (s.built?.[bbl]) delete s.built[bbl];
    recordPropertyEvent(s, bbl, {
      kind: "default",
      party: gl.tenant,
      outcome: duringBuild
        ? "Ground lease terminated mid-build; vacant land returned to fee-owner control"
        : "Ground lease terminated; vacant land returned to fee-owner control",
    });
    raiseAlert(s, {
      kind: "ground",
      tone: "bad",
      title: `${gl.tenant} defaulted at ${address}`,
      body: duringBuild
        ? "They walked the job. The ground rent has stopped, the frame is cancelled, and full control of the site is back with you."
        : "The ground rent has stopped and the lease has terminated. Full control of the site is back with you.",
      detail: duringBuild
        ? "No completed improvement stood on the land. The vacant site is yours again — carry resumes."
        : "No completed improvement stood on the land. The vacant site is yours to lease, sell or develop.",
    });
  }
  return true;
}

/** End a city-held ground lease (fee sold off-book). Building stays as city fabric. */
function defaultCityGroundLease(s: GameState, bbl: string, gl: GroundLease): void {
  delete s.cityGroundLeases![bbl];
  if (s.cityGroundLeases && !Object.keys(s.cityGroundLeases).length) delete s.cityGroundLeases;
  s.cityJobs = (s.cityJobs ?? []).filter((j) => !(j.bbl === bbl && j.groundLease));
  cancelSupplyProject(s, bbl);
  const standing = s.built?.[bbl];
  if (!(standing && standing.bldgArea > 0)) {
    if (s.built?.[bbl]) delete s.built[bbl];
  }
  recordPropertyEvent(s, bbl, {
    kind: "default",
    party: gl.tenant,
    outcome: standing && standing.bldgArea > 0
      ? "Off-book ground lease terminated; improvement remains as city fabric"
      : "Off-book ground lease terminated mid-build; site cleared",
  });
}

function groundDefaultOdds(s: GameState, duringBuild: boolean): number {
  const cycle = s.econ.phase === "recession" ? 3.5
    : s.econ.phase === "recovery" ? 1.4
      : s.econ.phase === "peak" ? 0.75 : 1;
  const credit = Math.max(0.75, Math.min(2, 1 / Math.max(0.5, s.econ.creditIdx ?? 1)));
  // Construction is riskier than a stabilised leasehold; operating defaults
  // stay rare because losing the improvement is catastrophic for the lessee.
  const annual = duringBuild ? 0.018 : 0.006;
  return (annual * cycle * credit) / 12;
}

function stepGroundRent(s: GameState, parcels: ParcelTable, bbl: string, gl: GroundLease, announce: boolean) {
  if (gl.openRentYr === undefined) gl.openRentYr = gl.rentYr;
  const review: GroundReview = gl.review ?? "fixed";
  if (s.month - gl.lastStepM < gl.stepEveryM) return;
  const prev = gl.rentYr;
  if (review === "cpi") {
    const infl = Math.max(0.02, Math.min(0.04, s.econ.inflExp ?? s.econ.nat?.inflExp ?? 0.025));
    gl.rentYr = Math.round(gl.rentYr * (1 + infl));
  } else if (review === "fmv") {
    const bare = bareLandRec(parcels, s, bbl);
    const land = bare ? landValue(bare, s.econ) : 0;
    const yld = Math.max(3.2, s.econ.indexRate * 0.62 + 2.5) * 0.88;
    const uncapped = Math.round(land * (yld / 100));
    const yrs = (s.month - gl.startM) / 12;
    const cap = Math.round((gl.openRentYr ?? gl.rentYr) * Math.pow(1 + (gl.fmvCapPct ?? 3.5) / 100, yrs));
    // Ratchet: FMV can lift the coupon, never cut a performing lease.
    gl.rentYr = Math.max(gl.rentYr, Math.min(uncapped, cap));
  } else {
    gl.rentYr = Math.round(gl.rentYr * (1 + gl.stepPct / 100));
  }
  gl.lastStepM = s.month;
  if (announce && gl.rentYr !== prev) {
    const rec = parcels[bbl];
    const word = review === "cpi" ? "CPI review" : review === "fmv" ? "FMV reappraisal" : "Rent review";
    s.news.unshift({
      q: s.month, kind: "info",
      text: `${word} at ${rec?.address ?? bbl}: the ground rent moves to $${(gl.rentYr / 1e6).toFixed(2)}M`
        + (gl.rentYr > prev ? ` (+${(((gl.rentYr / prev) - 1) * 100).toFixed(1)}%)` : "") + `.`,
    });
  }
}

/**
 * Offer book, then construction, then coupons and reviews. Called once a month.
 */
export function tickGroundLeases(s: GameState, parcels: ParcelTable) {
  for (const h of Object.values(s.holdings)) {
    const offer = h.groundOffer;
    if (!offer) continue;
    const rec = parcels[h.bbl];
    // The offer dies quietly when the lot stops being offerable.
    if (!rec || rec.class !== "land" || rec.bldgArea > 0 || s.developments[h.bbl]
      || s.merged?.[h.bbl] || h.sale || s.groundLeases?.[h.bbl] || h.loan
      || s.facility?.bbls?.includes(h.bbl)
      || (s.built?.[h.bbl]?.bldgArea ?? 0) > 0) { delete h.groundOffer; continue; }
    const review: GroundReview = offer.review ?? "fixed";
    const q = groundLeaseQuote(s, parcels, h.bbl, offer.years, review);
    if (!q) { delete h.groundOffer; continue; }
    const climate = buildClimate(s);
    const p = Math.min(0.14, (0.006 + 0.075 * (demandNow(s, rec) / 100) * climate) * q.takeMult);
    if (rng(s, "sales") >= p) continue;
    const who = pickGroundTenant(s, parcels, h.bbl, offer.years);
    const prog = lesseeProgram(s, parcels, h.bbl, who.use, who.lead, offer.years);
    if (!prog) continue;
    delete h.groundOffer;
    h.groundLeased = true;
    // You are no longer the landlord — drop every operating attachment that
    // would otherwise keep firing LOIs, exclusives, capital-plan cuts, etc.
    delete h.broker;
    delete h.leasingHold;
    delete h.specSuites;
    delete h.makeReady;
    delete h.planCutM;
    delete h.program;
    h.tenants = [];
    delete h.occ;
    s.lois = (s.lois ?? []).filter((l) => l.bbl !== h.bbl);
    if (s.asks) s.asks = s.asks.filter((a) => a.bbl !== h.bbl);
    if (!s.groundLeases) s.groundLeases = {};
    s.groundLeases[h.bbl] = {
      bbl: h.bbl, startM: s.month, endM: s.month + offer.years * 12,
      rentYr: q.rentYr, openRentYr: q.rentYr,
      stepPct: q.stepPct, stepEveryM: q.stepEveryM, lastStepM: s.month,
      tenant: who.name, review, fmvCapPct: q.fmvCapPct,
      use: prog.use, sf: prog.sf, floors: prog.floors,
    };
    startLesseeJob(s, h.bbl, prog.use, prog.sf, prog.floors, prog.months);
    const waited = Math.max(1, s.month - offer.sinceM);
    const revWord = review === "fixed" ? `+${q.stepPct}% every ten`
      : review === "cpi" ? "CPI each year (2–4%)"
      : "FMV every twenty, capped";
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `A ground lessee at last: ${who.name} signs at ${rec.address} — `
        + `$${(q.rentYr / 1e6).toFixed(2)}M a year for ${offer.years} years (${revWord}), `
        + `after ${waited >= 24 ? `${Math.round(waited / 12)} years` : `${waited} month${waited === 1 ? "" : "s"}`} on the offer book. `
        + `They break ground on ${prog.floors} fl of ${prog.use} (${Math.round(prog.sf).toLocaleString()} sf); `
        + `you do not touch the dirt again until ${monthLabel(s.month + offer.years * 12)}.`,
    });
  }

  for (const [bbl, gl] of Object.entries(s.groundLeases ?? {})) {
    if (!s.holdings[bbl]) {
      // Safety net: a deed that left without going through the sale helper
      // still carries its encumbrance off-book instead of vanishing.
      transferGroundLeaseOffBook(s, bbl);
      continue;
    }
    const h = s.holdings[bbl]!;

    if (s.month >= gl.endM) {
      const rec = parcels[bbl];
      delete s.groundLeases![bbl];
      if (s.groundLeases && !Object.keys(s.groundLeases).length) delete s.groundLeases;
      delete h.groundLeased;
      // Cancel any unfinished lessee frame — the term ran out on a hole.
      s.cityJobs = (s.cityJobs ?? []).filter((j) => !(j.bbl === bbl && j.groundLease));
      cancelSupplyProject(s, bbl);
      const standing = s.built?.[bbl];
      if (standing && standing.bldgArea > 0) {
        const ageYrs = Math.max(0, START_YEAR + Math.floor(s.month / 12) - standing.yearBuilt);
        if (groundLeaseFreeReversion(gl)) {
          // Long paper: aged vacant reversion — the ground-lease fantasy.
          revertLesseeImprovement(s, parcels, bbl, h, standing, gl);
          s.news.unshift({
            q: s.month, kind: "event",
            text: `The ground lease at ${rec?.address ?? bbl} has run out. `
              + `${standing.floors} floors of ${standing.class} (${Math.round(standing.bldgArea).toLocaleString()} sf`
              + (ageYrs >= 1 ? `, ${ageYrs}-year-old` : "")
              + `) revert with the land — vacant, and yours to let.`,
          });
        } else {
          // Short paper: residual is not a gift. Fund the leasehold buyout or
          // the improvement clears and you get the dirt back alone.
          const buyout = groundLeaseImprovementBuyout(s, parcels, bbl, standing);
          if (buyout > 0 && s.cash >= buyout) {
            s.cash -= buyout;
            logBooks(s, "bought", buyout);
            revertLesseeImprovement(s, parcels, bbl, h, standing, gl);
            s.news.unshift({
              q: s.month, kind: "event",
              text: `The ground lease at ${rec?.address ?? bbl} has run out. `
                + `Short paper — you paid $${(buyout / 1e6).toFixed(2)}M for the leasehold and took `
                + `${standing.floors} floors of ${standing.class} vacant`
                + (ageYrs >= 1 ? ` (${ageYrs}-year-old)` : "")
                + `.`,
            });
          } else {
            delete s.built[bbl];
            s.news.unshift({
              q: s.month, kind: "event",
              text: `The ground lease at ${rec?.address ?? bbl} has run out. `
                + (buyout > 0
                  ? `Short paper does not gift the building — a $${(buyout / 1e6).toFixed(2)}M leasehold buyout `
                    + `went unfunded, so the improvement is gone and the vacant land is yours again.`
                  : `Short paper does not gift the building — the vacant land is yours again.`),
            });
          }
        }
      } else {
        if (s.built?.[bbl]) delete s.built[bbl];
        s.news.unshift({
          q: s.month, kind: "event",
          text: `The ground lease at ${rec?.address ?? bbl} has run out. The land is yours again — they never finished a building on it.`,
        });
      }
      continue;
    }

    // LEASEHOLD DEFAULT — mid-build walkaways, then rare operating defaults
    // after the improvement has been open a year. Hash randomness
    // (`newsChance`) avoids changing any economic RNG stream.
    const duringBuild = gl.builtM === undefined;
    const canDefault = duringBuild || (gl.builtM !== undefined && s.month - gl.builtM >= 12);
    if (canDefault && newsChance(s, `ground-default:${bbl}`, groundDefaultOdds(s, duringBuild))) {
      defaultGroundLease(s, parcels, bbl);
      continue;
    }

    stepGroundRent(s, parcels, bbl, gl, true);
    // Rent is booked in the holdings loop via ownedMonthlyNoi — same path as
    // every other deed — so a performing leased fee cannot vanish from CF / yr,
    // cfHistory, or the debt page while still hitting the cash ledger here.
  }

  // Off-book leased fees: no cash to you, but the encumbrance and the lessee
  // keep running until term, default, or (if you somehow reacquire) reattach.
  for (const [bbl, gl] of Object.entries(s.cityGroundLeases ?? {})) {
    if (s.holdings[bbl]) {
      (s.groundLeases ??= {})[bbl] = gl;
      s.holdings[bbl].groundLeased = true;
      delete s.cityGroundLeases![bbl];
      continue;
    }
    if (s.month >= gl.endM) {
      delete s.cityGroundLeases![bbl];
      s.cityJobs = (s.cityJobs ?? []).filter((j) => !(j.bbl === bbl && j.groundLease));
      cancelSupplyProject(s, bbl);
      // Improvement stays as ordinary city fabric once the fee term ends.
      continue;
    }
    const duringBuild = gl.builtM === undefined;
    const canDefault = duringBuild || (gl.builtM !== undefined && s.month - gl.builtM >= 12);
    if (canDefault && newsChance(s, `city-ground-default:${bbl}`, groundDefaultOdds(s, duringBuild))) {
      defaultCityGroundLease(s, bbl, gl);
      continue;
    }
    stepGroundRent(s, parcels, bbl, gl, false);
  }
  if (s.cityGroundLeases && !Object.keys(s.cityGroundLeases).length) delete s.cityGroundLeases;
}

/**
 * HOW OLD THE OWNER'S OPINION OF VALUE IS, in months, by who they are.
 *
 * One number, deciding both halves of an off-market conversation, and it is
 * one number on purpose. An owner who marks their book has a figure to give
 * you AND that figure is current. An owner who never has to value anything has
 * neither: they ask YOU for a number, and the anchor in their head is whatever
 * the building was worth the last time they had a reason to care. Rolling
 * "do they quote" and "is the quote stale" separately would let a family trust
 * hand you a crisp, current, defensible figure, which is the one thing that
 * kind of owner never does.
 *
 * The means are the real valuation cycles. An open-end core fund and a listed
 * REIT mark quarterly, because investors redeem at NAV and the auditors ask.
 * A closed-end fund and offshore capital carry an annual third-party
 * appraisal. Anyone whose business plan is an exit — opportunistic, merchant,
 * developer, vulture — runs the model continuously, because the model IS the
 * business. Against that: a family trust's last appraisal was written for an
 * estate tax return, an owner-occupier's for the mortgage, and a slumlord has
 * never commissioned one in his life.
 */
const VALUATION_AGE_M: Record<RivalStyle, number> = {
  core: 3, reit: 3, pe: 12, foreign: 12,
  opportunistic: 6, developer: 9, merchant: 6, vulture: 6,
  family: 168, owneruser: 120, slumlord: 96,
};
/**
 * And the owner with no name on this street — which is most of the map. A
 * private holder of a small building is not an institution and does not behave
 * like one: private and individual CRE owners hold for a decade and more, and
 * the last time they had a professional opinion of value was the day they
 * signed for it. Eleven years is the middle of the reported private-investor
 * hold, and it is a MEAN, not a constant — the draw below is exponential,
 * which is the right shape for "time since the last event" and puts plenty of
 * owners at two years and a long tail at thirty.
 */
const PRIVATE_VALUATION_AGE_M = 132;

/** Box-Muller, the same way demand.ts draws its normals. */
function gauss(s: GameState): number {
  const u1 = Math.max(1e-9, rng(s, "sales"));
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng(s, "sales"));
}

function valuationAgeM(s: GameState, style: RivalStyle | null, stressed: boolean): number {
  // A firm in trouble has had a broker through the building THIS quarter,
  // because that is what being in trouble looks like from the inside: you are
  // getting opinions of value whether you want them or not.
  const mean = stressed ? 2 : (style ? VALUATION_AGE_M[style] : PRIVATE_VALUATION_AGE_M);
  return -mean * Math.log(Math.max(1e-9, rng(s, "sales")));
}

/**
 * WHAT THE MARKET DID SINCE THEY LAST LOOKED, as a ratio of the value level
 * then to the value level now. Above 1 means the market has FALLEN since —
 * their memory is of a better day.
 *
 * Built stock reads rent over cap, which is the market half of every appraisal
 * in this engine; dirt reads the land index. Both series are already recorded
 * every month by recordHistory, so this is a reading of the city's own record
 * rather than a second opinion about it.
 *
 * THE LIMIT, said out loud: the record starts at month zero and the buildings
 * do not. An owner in year three cannot be anchored on year minus twelve
 * because that year was never simulated, so staleness ramps in over the first
 * decade of a run and the early game leans on the dispersion term below
 * instead. Inventing a pre-game price series to fix that would be inventing
 * prices, which is the thing this codebase does not do.
 */
function levelRatioSinceLooking(econ: Econ, rec: ParcelRecord, ageM: number): number {
  const hist = econ.history;
  if (!hist || hist.length < 13) return 1;
  const now = hist.length - 1;
  const then = Math.max(0, now - Math.round(ageM));
  if (then >= now) return 1;
  const level = (i: number): number => {
    const h = hist[i];
    if (!h) return NaN;
    if (rec.class === "land" || !rec.bldgArea) return h.landIdx;
    const rent = h.effRent?.[rec.class] ?? h.rent?.[rec.class];
    const cap = h.cap?.[rec.class];
    return rent && cap ? rent / cap : h.landIdx;
  };
  const a = level(then), b = level(now);
  if (!(a > 0) || !(b > 0)) return 1;
  return a / b;
}

/**
 * WHAT THE OWNER PRIVATELY THINKS IT IS WORTH — before any premium for the
 * trouble of selling it to you. Two things move it off the appraisal and both
 * are documented behaviour rather than flavour.
 *
 * ANCHORING, ASYMMETRICALLY. An owner updates a stale opinion upward readily
 * and downward barely: the neighbour's closing price and the assessor's notice
 * both arrive uninvited when the market runs, and neither arrives when it
 * falls. This engine already carries the same asymmetry one file over — sim.ts
 * moves an assessment 32% of the way up and 9% of the way down each January.
 *
 * The DOWNWARD exponent is not a feel. Genesove & Mayer (QJE 2001) measured it
 * on sellers carrying a nominal loss: they set asking prices 25-35% of that
 * loss above market. Halve a market and the loss is the whole of today's
 * value, so the ask lands near 1.30x — and 2^0.38 = 1.30, which is where the
 * exponent comes from. At 0.55, where this first landed, the same halving
 * produced 1.46x and the median named ask in a thirty-year run came out at
 * 1.40x appraisal against 1.20x before the rewrite: the asymmetry was doing
 * more work than the study it was borrowed from supports. Caveat worth
 * knowing: G&M measured people who WERE selling, so the extra premium for an
 * owner who was not selling at all lives in `markup` below, not in here.
 *
 * DISPERSION. An owner with no broker is not merely biased, they are noisy:
 * self-assessed values run a few points above appraisal on average with a
 * standard deviation in the mid-teens (Goodman & Ittner, JHE 1992, measured on
 * owner-occupiers; the dispersion is the part that carries over). That noise
 * is where a genuinely cheap number comes from, and it is why the man who
 * names one is the man who does not know what he has.
 *
 * Note that staleness cuts both ways at once and is supposed to: an owner who
 * has not looked in twenty years both thinks it is worth less than it is AND
 * wants a bigger premium to part with it (see DREAM_MAX). Which of those wins
 * depends on what the city did in the meantime, and that is the whole reason a
 * below-market number is rare rather than impossible.
 */
const ANCHOR_STICKY_DOWN = 0.38;   // of a stale HIGH view survives the news
const ANCHOR_STICKY_UP = 0.25;     // of a stale LOW view does
const OPINION_SD = 0.16;           // lognormal sigma, from the self-assessment spread

function ownersView(s: GameState, rec: ParcelRecord, value: number, ageM: number): number {
  const r = levelRatioSinceLooking(s.econ, rec, ageM);
  const anchored = value * Math.pow(r, r > 1 ? ANCHOR_STICKY_DOWN : ANCHOR_STICKY_UP);
  return anchored * Math.exp(OPINION_SD * gauss(s));
}

/**
 * WHETHER THEY SAY IT OUT LOUD. Same draw, other half: a number that came out
 * of a file gets named, and a number that came out of somebody's head does
 * not, because its owner knows it will not survive being written down. That is
 * the whole difference between "we'd take nine-two" and "make me an offer",
 * and it is why the two outcomes cannot be a coin flip layered on top — the
 * kind of owner who deflects is the same kind whose private number is wild.
 *
 * The half-way point is five years of not having looked: an owner whose last
 * opinion of value predates the last cycle is as likely to deflect as to
 * quote. That is a judgement about how people negotiate when they cannot
 * defend their figure, not a measurement, and it is stated as one.
 */
const QUOTE_HALF_M = 60;

/**
 * HOW FAR OFF A PROFESSIONAL LEASH THE NUMBER IS, 0 to 1.
 *
 * A figure that has to be justified to an investment committee, a lender or an
 * auditor is disciplined by having to be justified. A figure nobody has ever
 * asked about is disciplined by nothing, and this is the term that lets it run
 * — mostly a little, occasionally to somewhere no buyer will follow. The cubed
 * draw is the shape of a holdout price: negligible for most of the range and
 * enormous in the tail, the same reason assemblage pressure is cubed sixty
 * lines below.
 */
const DREAM_MAX = 1.5;
/**
 * And the extra rope an UNSAID number gets. Saying a figure to a professional
 * is a discipline all by itself — you have to hear yourself say it, and a
 * broker's face does the rest. Keep it in your head and nothing edits it. This
 * is why the silly numbers in this game live behind "make me an offer" rather
 * than being sprayed across both outcomes: it is a property of not having said
 * it, so it belongs to the channel where nothing was said.
 */
const BLIND_LICENCE = 0.6;

/**
 * AND THE FLOOR UNDER ALL OF IT, which is the one this function had before and
 * for the same reason. Nobody in this city is unaware to an unlimited degree:
 * the tax bill arrives every January with the city's own opinion of value
 * printed on it, and sim.ts moves that opinion a third of the way up to market
 * every year. An owner can be years behind. They cannot be lost.
 */
const OWNER_FLOOR = 0.80;

/**
 * HOW LONG A DOOR STAYS SHUT, by how it was shut.
 *
 * `offence` is 0 for a conversation that simply ended and 1 for one you blew
 * up — the engine computes it at each refusal from what it already knows, and
 * nothing new is measured to produce it.
 *
 * Six months is the floor and it is the number that was already here: the
 * uniform cooldown every refusal used to get. Thirty months is the ceiling, and
 * it is a shape parameter rather than a fact about the business — there is no
 * industry figure for how long a seller stays annoyed. What is a fact is the
 * SHAPE: a polite no is not a closed door and an insult is, and a model where
 * both reopen on the same morning is wrong about the only thing that separates
 * them. Calibrated so that a merely-low bid costs you a year and a genuinely
 * insulting one costs you most of a cycle, which is when a seller's
 * circumstances have changed enough for it not to be the same conversation.
 */
const DOOR_MIN_M = 6;
const DOOR_MAX_M = 30;
function shutDoor(na: { refused: boolean; coldUntilM?: number }, month: number, offence: number) {
  const o = Math.max(0, Math.min(1, offence));
  na.refused = true;
  na.coldUntilM = month + Math.round(DOOR_MIN_M + (DOOR_MAX_M - DOOR_MIN_M) * o);
}

/**
 * ...AND THE PERSON REMEMBERS IT, NOT JUST THE BUILDING.
 *
 * `shutDoor` closes one conversation about one address. A family that has just
 * been lowballed does not carefully file that opinion under the street number:
 * they have a view about YOU now, and it applies to the other three corners
 * they own. This is what the register in owners.ts is for, and it is the
 * difference between a market of buildings and a market of people.
 *
 * Both are recorded because both are real and they run on different clocks: the
 * building is shut for a stated period, and the relationship is a standing fact
 * that hardens with repetition and softens with deals closed.
 */
function shutDoorWithOwner(
  s: GameState, parcels: ParcelTable, bbl: string,
  na: { refused: boolean; coldUntilM?: number }, offence: number,
) {
  shutDoor(na, s.month, offence);
  const held = holderOf(s, parcels, bbl);
  if (held) {
    offend(
      s, held.id,
      Math.round(DOOR_MIN_M + (DOOR_MAX_M - DOOR_MIN_M) * Math.max(0, Math.min(1, offence))),
      parcels,
    );
  }
}

export function approachOwner(
  s: GameState, parcels: ParcelTable, adjacency: Adjacency, bbl: string,
): { s: GameState; err?: string; refused?: boolean; ask?: number; blind?: boolean } {
  // THE LIVE RECORD. Pricing an owner's ask off the STATIC table is what
  // produced asks at a fraction of the appraisal on this panel: a lot that has
  // had a building delivered on it, or that was reclassified, was quoted as
  // the dirt it used to be while the card beside it appraised the building.
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  if (s.holdings[bbl]) return { s, err: "You own it." };
  if (s.listings.some((l) => l.bbl === bbl)) return { s, err: "It's already listed — hit the Market tab." };
  const prior = s.approaches[bbl];
  // A refusal runs its OWN clock when it recorded one; everything else, and
  // every save written before doors had lengths, keeps the flat six months.
  const shutUntil = prior?.refused && prior.coldUntilM !== undefined ? prior.coldUntilM : (prior?.q ?? 0) + 6;
  if (prior && s.month < Math.max(shutUntil, prior.q + 6)) {
    const yrs = (shutUntil - s.month) / 12;
    return {
      s,
      err: prior.refused
        ? yrs > 1.5
          ? "That conversation ended badly and they have not forgotten it. This one is shut for years, not months."
          : "You knocked recently — the owner hasn't changed their mind."
        // Ringing again does not get you a number they already declined to
        // give. The conversation is open; the move is a bid, not another call.
        : prior.ask === undefined ? "You already have them. They are waiting on YOUR number, not another call."
        : "You already have their number — it's good for a while.",
    };
  }
  const next = clone(s);
  const pressure = assemblagePressure(next, adjacency, bbl);
  // WHO OWNS IT DECIDES THE ANSWER, and this function never asked.
  //
  // Refusal was a flat 0.34 and the premium a flat 1.06-1.78x whether the lot
  // belonged to a family trust at 12% leverage that has held it for two
  // generations, to an opportunistic shop three months from a margin call, or
  // to nobody at all. The four styles behave measurably differently — family
  // firms sit at 0.12 LTV and never fail, opportunistic shops at 0.71 and fail
  // 70% of the time — and none of that reached the one table where the player
  // meets them.
  //
  // Now it does, and the holdout is real: a family firm that knows what you
  // are assembling will not sell at any sane price, for years. That is the
  // single most interesting thing a competitor can do, and it is only fair
  // because there are three ways out of it that already exist — build the
  // L-shaped site, wait for their cycle to break, or buy their whole position
  // as a bundle.
  //
  // The holdout since MOVED, from the gate to the number, and it is stronger
  // for it. A family trust used to be a 96% refusal — a closed door with
  // nothing behind it. Now they take your call 62% of the time, decline to
  // name a price in 63% of those, and the figure they are sitting on runs a
  // median 1.78x appraisal with three quarters of it over 1.35x. You get to
  // have the conversation. You still do not get the building.
  const owner = ownerOf(next, bbl);
  const stressed = (owner?.stressMs ?? 0) > 4;
  // WHERE YOU STAND WITH THESE PEOPLE, which until the register existed was
  // nowhere: every approach was a cold call to a stranger, however many of
  // their buildings you had already been thrown out of. A holder you have
  // insulted will not take the call at all while the memory is fresh, and one
  // who has sold to you cleanly is materially easier to reach — which is what
  // a track record is actually worth in this business, and the reason a
  // careful buyer works a relationship instead of a listing.
  const held = holderOf(next, parcels, bbl);
  if (held && isCold(next, held.id)) {
    const yrs = ((relOf(next, held.id).coldUntilM ?? 0) - next.month) / 12;
    return {
      s,
      err: yrs > 1.5
        ? `${held.name} will not take your call. Whatever happened between you, they own more than this one building and they have not forgotten it.`
        : `${held.name} are not taking your call at the moment.`,
    };
  }
  const styleHold = owner
    ? (owner.style === "family" ? 0.30 : owner.style === "core" ? 0.14 : owner.style === "developer" ? 0.05 : -0.04)
    : 0;
  // ANSWERING THE PHONE AND NAMING A WORKABLE NUMBER ARE DIFFERENT EVENTS, and
  // this gate was doing the work of both.
  //
  // The history is worth keeping straight because it looks like a reversal and
  // is not. The base was 0.34, measured at 67.3% get-through, and it went to
  // 0.78 — a measured 23.2% get-through — against the industry figure that
  // brokers get through on single digits to about 20% of cold approaches. It
  // is now 0.26, which is a third of the refusals, and that is the same
  // instruction the 0.78 came from, aimed at the right event this time.
  //
  // What the 0.78 bought was the RIGHT HEADLINE AND THE WRONG WORLD. Measured
  // across 8,519 approaches over six seeds and thirty years each, 23.2% got
  // through — and 0.3% of approaches ended with a number a rational buyer
  // would take. Not 10%, not 5%: three in a thousand, because the ask could
  // not be priced under 1.06x appraisal unless the owner was in distress. The
  // gate was rationing conversations that were worthless anyway: two hundred
  // cold calls bought you a hundred and fifty-four flat no's, forty-six
  // numbers, and — on the measured rate — less than one number worth taking.
  // Same six seeds after the rewrite: a hundred and fifty conversations, and
  // eighteen numbers at or inside appraisal.
  //
  // So the door opens and the numbers behind it do the rationing, which is
  // what happens in life: owners take the call, and most of them say something
  // silly. Refusal is now the narrow case — someone who genuinely will not
  // discuss it — and the useful-contact rate is measured downstream of the
  // whole conversation rather than asserted at its door.
  //
  // THE MODIFIERS ARE RATIOS NOW, NOT POINTS. Each was calibrated as a
  // probability shift against a 0.78 base; subtracting the same points from a
  // 0.26 base drives half of them into the clamp, and a clamp that binds in
  // normal play is holding up the model. Each multiplier below is the old
  // additive term expressed as what it did to the old base — stressed took
  // 0.78 to 0.36, so it is 0.46 — which preserves every modifier's meaning and
  // makes all of them matter more against a smaller base, not less.
  const REFUSE_BASE = 0.26;
  const refuseP = Math.min(0.92, Math.max(0.02,
    REFUSE_BASE
    * (1 + 0.449 * pressure)                              // was +0.35 x pressure
    * (1 + styleHold / 0.78)                              // was +0.30 family ... -0.04
    // A firm that needs money answers the phone. A firm that does not, does not.
    * (stressed ? 0.46 : 1)                               // was -0.42
    * (owner && owner.cash < 0 ? 0.81 : 1)                // was -0.15
    * (rec.class === "land" ? 0.85 : 1)                   // was -0.12
    * (next.econ.phase === "recession" ? 0.87 : 1)        // was -0.10
    * (1 + (demandLinear(rec.demandScore) - 50) / 390)    // was +(d-50)/500
    // ...and who you are to THEM. Above 1 is harder. See owners.relMult: it
    // takes several clean closings to undo one bad conversation, which is the
    // honest exchange rate and the reason the register has a memory at all.
    * (held ? relMult(next, held.id) : 1),
  ));
  if (rng(next) < refuseP) {
    next.approaches[bbl] = { q: next.month, refused: true };
    next.news.unshift({
      q: next.month, kind: "info",
      text: owner
        ? `${rec.address}: ${owner.name} is not selling`
          + (pressure > 0.4 ? " — and they know exactly what you are assembling." : ".")
          + (owner.style === "family" ? " They have owned it for two generations and do not need the money." : "")
        : held
          ? `${rec.address}: ${held.name} is not selling`
            + (pressure > 0.4 ? " — and they know exactly what you are assembling." : ".")
            + (held.kind === "local" ? ` They have been on this side of town since ${held.since} and do not need the money.` : "")
          : `${rec.address}: the owner isn't selling${pressure > 0.4 ? " — they know what you're assembling" : ""}.`,
    });
    return { s: next, refused: true };
  }
  // THEY ARE WILLING TO TALK. Now: what is in their head, and will they say it.
  //
  // One draw decides both, because in life it is one fact about the owner. How
  // long since anybody valued this building tells you how far their number has
  // drifted from the market, how far off any professional leash it has run,
  // and whether they have anything they are prepared to put a figure on.
  const value = assetValue(rec, next.econ, initialCondition(rec));
  const ageM = valuationAgeM(next, owner?.style ?? null, stressed);
  const view = ownersView(next, rec, value, ageM);
  // What they want ON TOP for the trouble, and who they are is most of it. A
  // family firm that has finally decided to sell names a number that reflects
  // two generations of not needing to; a stressed shop takes what clears the
  // loan.
  // WHAT THEY WANT ON TOP, AND WHO THEY ARE IS MOST OF IT. A named firm's
  // style did this and a private holder's got a flat zero, because there was
  // no private holder — only an archetype re-derived per building. There is
  // one now, with a nature that does not change between their four corners, so
  // the premium is theirs: a family that does not need the money asks for two
  // generations of not needing it, and an estate with executors and a clock
  // asks for less than the market because what they want is a closing date.
  const HOLDER_ASK: Record<string, number> = {
    local: 0.13, estate: -0.08, institution: 0.05, partnership: 0.07, developer: 0.02, lender: -0.04,
  };
  const styleAsk = owner
    ? (owner.style === "family" ? 0.20 : owner.style === "core" ? 0.06 : owner.style === "opportunistic" ? 0.10 : 0.04)
    : held ? (HOLDER_ASK[held.kind] ?? 0)
    : 0;
  const markup =
    // The LAST deed is the expensive one. A linear premium is a toll; a holdout
    // is a wall, and the difference is entirely in the tail. Cubed, this is
    // negligible while you are buying the first neighbours on a block and
    // ruinous on the one that completes the site — which is the only thing
    // stopping assemblage from being free money now that it pays.
    1.06 + 0.5 * Math.pow(rng(next), 2) + 0.22 * pressure + 0.55 * Math.pow(pressure, 3) + styleAsk
    - (stressed ? rrange(next, 0.16, 0.30) : 0);
  const unadvised = 1 - 1 / (1 + ageM / 24);
  const quotes = rng(next) < 1 / (1 + Math.pow(ageM / QUOTE_HALF_M, 1.2));
  const dream = 1 + DREAM_MAX * unadvised * (quotes ? 1 : 1 + BLIND_LICENCE) * Math.pow(rng(next), 3);
  const number = Math.round(Math.max(value * OWNER_FLOOR, view * markup * dream) / 1000) * 1000;

  if (!quotes) {
    // MAKE ME AN OFFER. They will trade and they will not anchor, so the number
    // above stays in their head and the player's only instrument is a bid. The
    // record deliberately carries no ask: everything downstream keys off that
    // absence, and there is nothing here for a panel to leak.
    // THE PAPER GOES OUT WITH THE CONVERSATION. An owner who will not name a
    // price will still send the roll — refusing to anchor is a negotiating
    // position, not a refusal of diligence. See stampApproach.
    next.approaches[bbl] = stampApproach(next, rec, { q: next.month, refused: false, mode: "offer", reserve: number });
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${rec.address}: ${(owner?.name ?? held?.name ?? "the owner")} will talk — and will not put a number on it. `
        + `"Make me an offer." `
        + (ageM > 120 ? "Nobody has valued that building in a very long time, which cuts both ways. " : "")
        + `They will listen for six months.`,
    });
    return { s: next, blind: true };
  }
  next.approaches[bbl] = stampApproach(next, rec, { q: next.month, refused: false, mode: "ask", ask: number });
  next.news.unshift({
    q: next.month, kind: "info",
    text: `${rec.address}: ${(owner?.name ?? held?.name ?? "the owner")} would take $${(number / 1e6).toFixed(2)}M`
      + (stressed ? " — they are under pressure and it shows in the number."
        : number > value * 1.5 ? " — which is not a price, it is a way of saying no politely."
        : "")
      + " The number holds for six months.",
  });
  return { s: next, ask: number };
}

/**
 * BIDDING AGAINST A NUMBER YOU CANNOT SEE.
 *
 * The owner said "make me an offer", which means the only instrument the
 * player has is the offer itself, and the only feedback is what the owner does
 * with it. That is the mechanic, and it is worth being careful about what each
 * outcome tells them:
 *
 *   OVER THE RESERVE  — done, at YOUR number, not theirs. This is the honest
 *     cost of bidding blind and it is the reason the mechanic has teeth: bid
 *     over a low reserve and you have overpaid and nobody will say so. What
 *     the game gives you instead is the tell every buyer in this business
 *     knows — an owner who takes the first number without a murmur was never
 *     going to hold out — plus the comp, which recordComp files at the close
 *     like any other trade, for you to look at against the ones beside it.
 *
 *   UNDER IT, CLOSE     — they name their figure. A bid that lands near the
 *     reserve proves you are a real buyer, and at that point deflecting costs
 *     them the deal. This is how the hidden number becomes a visible one, and
 *     it is not free: they know now that you want it, and the figure that
 *     comes back has that in it.
 *
 *   UNDER IT, WELL UNDER — they say no and do not say what yes is. You have
 *     learned almost nothing and spent one of a small number of goes.
 *
 *   INSULTING            — they end the conversation, same as the named-ask
 *     path has always done.
 *
 * Patience runs down with every bid, which is what stops the whole thing being
 * a free binary search for the reserve. Measured over 1,403 blind
 * conversations, a player who opens at 0.9x appraisal and escalates until
 * something happens gets the number out of 13.5% of them, gets hung up on in
 * 30.7%, and buys 28.1% — at a median of 1.60x appraisal, because escalating
 * blind is how you find the top of somebody's range and then pay it. Against
 * that, one honest bid at appraisal and no more buys 7.4% at exactly
 * appraisal. The search works and it is not free, which is the whole design.
 */
/**
 * BLIND BID — a number, and nothing else.
 *
 * The stack used to sit in front of this: Thesis → Structure → Commit before
 * the seller ever saw a figure. Nobody bids that way. You name a price; if
 * they take it you go under contract and then find the money. Probing a soft
 * "no" never required a loan product.
 */
export function submitBlindBid(
  s: GameState, parcels: ParcelTable, bbl: string, bid: number,
): { s: GameState; err?: string; msg?: string } {
  const cold = coldOnDeed(s, parcels, bbl);
  if (cold) return { s, err: coldRefuseMsg(cold) };
  const a = s.approaches[bbl];
  if (!a || a.refused || a.ask !== undefined || a.reserve === undefined) {
    return { s, err: "There is no live 'make me an offer' conversation on that building." };
  }
  if (s.month > a.q + 6) return { s, err: "That conversation has gone cold." };
  return bidBlind(s, parcels, bbl, bid);
}

function bidBlind(
  s: GameState, parcels: ParcelTable, bbl: string, bid: number,
): { s: GameState; err?: string; msg?: string } {
  const a = s.approaches[bbl]!;
  const reserve = a.reserve!;
  const price = Math.round(bid ?? 0);
  if (!Number.isFinite(price) || price <= 0) return { s, err: "They asked you for a number. Name one." };
  const next = clone(s);
  const na = next.approaches[bbl];
  na.lastBid = price;
  na.probes = (na.probes ?? 0) + 1;
  const addr = parcels[bbl]?.address ?? bbl;
  const rec = resolveRec(parcels, next, bbl);

  if (price >= reserve) {
    // Handshake first — earnest money only. The capital stack is a later act,
    // the same way a listed Offer desk works. Instant deed+loan here was what
    // forced Structure-the-stack before the seller had even accepted a number.
    if (!rec) return { s, err: "Unknown parcel." };
    const seller = sellerOf(next, parcels, bbl);
    const struck = strikeDeal(next, bbl, price, { kind: seller.kind, name: seller.name }, rec.address);
    if (struck.err) return { s, err: struck.err };
    delete struck.s.approaches[bbl];
    const eager = price >= reserve * 1.15;
    struck.s.news.unshift({
      q: struck.s.month, kind: eager ? "warn" : "deal",
      text: eager
        ? `${addr}: they took your number the same afternoon, without a counter and without a lawyer's argument. `
          + `Nobody does that on a number that hurt. You are under contract — place the debt and close.`
        : `${addr}: they took it, after a week of thinking about it. Under contract — fund it.`,
    });
    return {
      s: struck.s,
      msg: `Under contract at $${(price / 1e6).toFixed(2)}M — now structure the stack and close.`,
    };
  }

  const gap = 1 - price / reserve;
  const probes = na.probes;
  // A serious bid draws the number out; each further attempt draws it less,
  // because by the third number you have stopped being a buyer and started
  // being a process.
  //
  // The slope is where a bid stops reading as a counterparty and starts
  // reading as a tyre-kicker, and it runs out around a third under. The first
  // cut of this was 3.4, dead by a quarter under — and since a blind reserve
  // runs a median 1.57x appraisal, a player bidding a fair price for the
  // building is 36% under it by construction. Measured on 1,403 blind
  // conversations that left the "they finally name it" branch reachable 6-10%
  // of the time no matter what the player did, which is not a mechanic, it is
  // a rounding error with prose attached.
  const pName = Math.max(0, Math.min(0.80, 0.86 - gap * 2.2)) * Math.pow(0.55, probes - 1);
  // And the door: an insulting bid closes it at once, a merely low one wears
  // the welcome through.
  const pWalk = Math.min(0.85, 0.05 + Math.max(0, gap - 0.20) * 1.4 + 0.18 * (probes - 1));
  const roll = rng(next);
  if (roll < Math.min(pName, 1 - pWalk)) {
    // THEY NAME IT. The premium on the way out is what showing your hand
    // costs — they are answering a bid, not a survey.
    na.ask = Math.round(reserve * rrange(next, 1.01, 1.05) / 1000) * 1000;
    delete na.reserve;
    // A NUMBER IS A NUMBER, AND YOU MAY ANSWER IT.
    //
    // This set `countered`, with the note "the bid WAS the counter; there is
    // not a second one", and that closed the negotiation the moment it finally
    // opened: the owner names a figure in answer to your bid and the only
    // moves left are pay it or walk. No buyer in this business takes the first
    // number a seller finally says out loud, and nothing about having bid
    // blind makes the figure that came back a final one.
    //
    // What bidding blind actually cost you is INFORMATION, and that is priced
    // where it belongs — in counterOffMarket, off this flag. They know you
    // want it, and the figure they named already has that in it.
    na.named = true;
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${addr}: your $${(price / 1e6).toFixed(2)}M got a real answer out of them at last — `
        + `$${(na.ask / 1e6).toFixed(2)}M, and now they know you want it.`,
    });
    return { s: next, msg: "They finally named a number." };
  }
  if (roll < 1 - pWalk) {
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${addr}: no. They did not say what yes would be, either.`,
    });
    return { s: next, msg: "They said no, and nothing else." };
  }
  // HOW BADLY IT ENDED, out of the two numbers this branch already has: how
  // far under their reserve the bid was, and how many times you had been back.
  // A bid a fifth under closes the door for a year; one at half their number
  // after three visits closes it for most of a cycle.
  shutDoorWithOwner(next, parcels, bbl, na, Math.max(0, gap - 0.10) * 2.0 + 0.15 * (probes - 1));
  delete na.reserve;
  delete na.ask;
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `${addr}: the owner ended the conversation`
      + ((na.coldUntilM ?? 0) - next.month > 18 ? ", and they will not be taking your call again for a long time." : "."),
  });
  return { s: next, msg: "They ended the conversation." };
}

export function buyOffMarket(
  s: GameState, parcels: ParcelTable, bbl: string, product: BuyProduct, lev = 1, bid?: number,
): { s: GameState; err?: string; msg?: string } {
  const cold = coldOnDeed(s, parcels, bbl);
  if (cold) return { s, err: coldRefuseMsg(cold) };
  const a = s.approaches[bbl];
  if (!a || a.refused) return { s, err: "No live ask — approach the owner first." };
  // Blind "make me an offer" is a bid, not a financed close. The stack comes
  // after they take a number (under contract → closeDeal).
  if (a.ask === undefined && a.reserve !== undefined) {
    return submitBlindBid(s, parcels, bbl, bid ?? 0);
  }
  if (!a.ask) return { s, err: "No live ask — approach the owner first." };
  if (s.month > a.q + 6) return { s, err: "That number expired." };
  const price = Math.round(bid ?? a.ask);
  if (price >= a.ask) return executePurchase(s, parcels, bbl, a.ask, product, true, lev);

  const q = buyQuote(s, parcels, bbl, price, product, lev);
  if (s.cash < q.equity) return { s, err: `That bid still needs $${(q.equity / 1e6).toFixed(2)}M of equity — you're short.` };
  const next = clone(s);
  // an owner who wasn't selling in the first place has no reason to bend:
  // off-market discounts come much harder than they do on the open tape
  const disc = 1 - price / Math.max(1, a.ask);
  const p = Math.max(0.02, Math.min(0.9, 0.92 - disc * 11.0 + (next.econ.phase === "recession" ? 0.12 : 0)));
  const roll = rng(next);
  if (roll < p) {
    const done = executePurchase(next, parcels, bbl, price, product, true, lev);
    if (done.err) return { s, err: done.err };
    return { s: done.s, msg: `Done at $${(price / 1e6).toFixed(2)}M, off-market.` };
  }
  if (roll < p + 0.4) {
    next.news.unshift({ q: next.month, kind: "info", text: `${parcels[bbl]?.address}: the owner didn't move off $${(a.ask / 1e6).toFixed(2)}M.` });
    return { s: next, msg: "They held their number." };
  }
  const na = next.approaches[bbl];
  // `disc` is how far under their own stated number you came, which is the
  // whole of the offence when they have already told you what they want.
  shutDoorWithOwner(next, parcels, bbl, na, Math.max(0, disc - 0.10) * 2.2);
  delete na.ask;
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `${parcels[bbl]?.address}: the owner ended the conversation`
      + ((na.coldUntilM ?? 0) - next.month > 18 ? " and took the building off the table for good." : "."),
  });
  return { s: next, msg: "They ended the conversation." };
}

// One counter per approach, at YOUR number off the slider. The deeper you
// cut, the worse the odds — they take it, hold firm, or hang up entirely.
export function counterOffMarket(
  s: GameState, parcels: ParcelTable, adjacency: Adjacency, bbl: string, offerPx?: number,
): { s: GameState; err?: string; msg?: string } {
  const cold = coldOnDeed(s, parcels, bbl);
  if (cold) return { s, err: coldRefuseMsg(cold) };
  const a = s.approaches[bbl];
  const rec = resolveRec(parcels, s, bbl);
  // YOU CANNOT COUNTER A NUMBER NOBODY GAVE YOU. An owner who deflected is
  // waiting for a bid, and the bid is the whole negotiation — routing them
  // through here would quietly invent an ask for the counter to cut against.
  if (a && !a.refused && a.ask === undefined && a.reserve !== undefined) {
    return { s, err: "There is nothing to counter — they asked YOU for a number. Put a bid in." };
  }
  if (!a || a.refused || !a.ask || !rec) return { s, err: "No live ask to counter." };
  if (a.countered) return { s, err: "You already countered — the number on the table is the number." };
  if (s.month > a.q + 6) return { s, err: "That number expired." };
  const next = clone(s);
  const na = next.approaches[bbl];
  na.countered = true;
  const px = Math.round(offerPx ?? a.ask * 0.88);
  const cut = Math.max(0, 1 - px / a.ask);                     // how deep you went
  const pressure = assemblagePressure(next, adjacency, bbl);
  // A NUMBER DRAGGED OUT OF THEM BY A BID IS NOT AN OPENING ASK.
  //
  // Two things are different about it and they pull opposite ways. It is close
  // to their floor already — bidBlind names it at 1.01-1.05x the reserve — so
  // the room underneath is a few per cent, not the twelve an opening ask
  // carries; and they know you want the building, because you asked first and
  // then bid. So the reference cut tightens and the whole curve comes down.
  // Cutting three per cent off a number they named under pressure is a real
  // negotiation; cutting fifteen is asking them to forget the last six months.
  const named = a.named === true;
  const ref = named ? 0.03 : 0.12;
  const pTake = Math.max(0.05, Math.min(0.8,
    0.48
    - (named ? 0.10 : 0)                                       // they know you want it
    - (cut - ref) * 2.6                                        // the reference cut
    - 0.35 * pressure                                          // holdouts don't blink
    + (next.econ.phase === "recession" ? 0.18 : 0)             // fear is your friend
    - (next.econ.phase === "expansion" ? 0.08 : 0),
  ));
  // Split the old "hold firm" mass into a real soft counter and a true hold.
  // Owners who will not take your number still often move a little — that is
  // what a counter is. Binary take/hold/hang-up made every refusal read as
  // stubbornness and hid the only information a counter is for.
  const pSoft = Math.max(0.12, Math.min(0.40, 0.34 - (cut - ref) * 0.9 - (named ? 0.06 : 0)));
  const pHold = Math.max(0.10, 0.45 - pSoft);
  const roll = rng(next);
  if (roll < pTake) {
    na.ask = Math.round(px / 1000) * 1000;
    next.news.unshift({ q: next.month, kind: "deal", text: `${rec.address}: the owner grumbled and took your number — $${(na.ask / 1e6).toFixed(2)}M.` });
    return { s: next, msg: "They took it." };
  }
  if (roll < pTake + pSoft) {
    // Meet partway: more of the gap on an open ask, less once they have already
    // named a number under pressure. Never go below your offer or above ask.
    const give = (named ? 0.22 : 0.38) * (0.55 + 0.45 * rng(next));
    const mid = Math.round(a.ask - (a.ask - px) * give);
    const softened = Math.round(Math.min(a.ask - 1000, Math.max(px + 1000, mid)) / 1000) * 1000;
    if (softened < a.ask && softened > px) {
      na.ask = softened;
      next.news.unshift({
        q: next.month, kind: "info",
        text: `${rec.address}: the owner came off $${(a.ask / 1e6).toFixed(2)}M to $${(softened / 1e6).toFixed(2)}M. `
          + `That is their number now — one counter is all you get.`,
      });
      return { s: next, msg: `They came down to $${(softened / 1e6).toFixed(2)}M.` };
    }
    // Degenerate gap (you were already a rounding error under) — fall through to hold.
  }
  if (roll < pTake + pSoft + pHold) {
    next.news.unshift({ q: next.month, kind: "info", text: `${rec.address}: the owner didn't move. $${(a.ask / 1e6).toFixed(2)}M stands.` });
    return { s: next, msg: "They held firm." };
  }
  // `cut` is how deep the counter went off their own ask. A shave they will
  // forgive; halving their number in a single counter they will not.
  shutDoorWithOwner(next, parcels, bbl, na, Math.max(0, cut - 0.12) * 2.4);
  delete na.ask;
  const shutFor = (na.coldUntilM ?? 0) - next.month;
  next.news.unshift({
    q: next.month, kind: shutFor > 18 ? "warn" : "info",
    text: `${rec.address}: the owner hung up. `
      + (shutFor > 18
        ? "That number insulted them and they will remember it — do not expect to be able to ring back."
        : "The door is closed for a while."),
  });
  return { s: next, msg: "They walked." };
}

// Selling is a process, not a button: list at an ask, wait for offers, and
// decide. Overprice it and the phone stays quiet.
export function listForSale(
  s: GameState, parcels: ParcelTable, bbl: string, ask: number, mode: "quiet" | "marketed" = "quiet",
): { s: GameState; err?: string } {
  // A merged deed has no land left in it — selling it alone would hand over a
  // piece of paper and keep the dirt. The site sells as a site.
  if (s.merged?.[bbl]) return { s, err: "That deed is part of an assemblage. Sell the site, not the piece." };
  // The leased fee trades — it is a bond with a deed attached. What you cannot
  // do is pretend the lot is free and clear; the ask is against leasedFeeValue.
  const h = s.holdings[bbl];
  if (!h) return { s, err: "You don't own that parcel." };
  if (h.renovatingUntilM !== undefined && s.month < h.renovatingUntilM) {
    return { s, err: "Can't market it mid-renovation — finish the work first." };
  }
  if (s.developments[bbl]) return { s, err: "Can't sell with cranes on site — deliver the building first." };
  // It cannot be in two processes at once. A building shown to the market both
  // on its own and inside a bundle is a building whose seller does not know
  // what he is selling, and every buyer works that out in an afternoon.
  if (s.portfolioSale?.bbls.includes(bbl)) {
    return { s, err: "That one is inside the portfolio you have in the market. Pull it out of the bundle first." };
  }
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  if (!Number.isFinite(ask) || ask <= 0) return { s, err: "Name a real number." };
  const next = clone(s);
  if (mode === "marketed") {
    // A campaign takes as long as it takes to get the book in front of
    // everybody who might buy it. Two to four months, then offers are due on a
    // date everyone knows, which is the entire mechanism by which a marketed
    // sale finds a price a quiet one never will.
    // A CAMPAIGN IS NOT A FREE OPTION ON SIX DRAWS.
    //
    // Listing cost nothing and delisting cost nothing — the fee only bit on a
    // close. So the optimal play was to run a process, read up to six bids,
    // walk away unless one landed in the tail, and rerun it next year.
    // Measured: 557 campaigns, 427 walked away from at zero cost, 98 sales at
    // a realised median 1.21x appraisal. You sold at the ceiling of the
    // distribution every single time and paid nothing for the misses.
    //
    // In life you pay the broker's marketing budget up front — the book, the
    // photography, the mailing — and you pay it whether or not it trades. And
    // a building the market has already been shown twice is a building
    // everyone has already passed on.
    const since = next.month - (next.holdings[bbl].lastCampaignM ?? -999);
    if (since < 24) {
      return { s, err: `You ran a process on this one ${since} months ago and pulled it. `
        + `Every buyer in town has seen the book — going back out now tells them only that nobody bid. `
        + `Wait until ${monthLabel((next.holdings[bbl].lastCampaignM ?? 0) + 24)}, or sell it quietly.` };
    }
    const marketing = Math.round(ask * 0.0035);
    if (next.cash < marketing) return { s, err: `A campaign costs $${(marketing / 1000).toFixed(0)}K in marketing up front. You do not have it.` };
    next.cash -= marketing;
    logBooks(next, "ga", marketing);
    const weeks = Math.round(rrange(next, 2, 4));
    next.holdings[bbl].sale = {
      ask: Math.round(ask), listedM: next.month, mode: "marketed",
      callM: next.month + weeks, round: 0,
    };
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${rec.address} is on the market properly: a whisper of $${(ask / 1e6).toFixed(2)}M, `
        + `offers due ${monthLabel(next.month + weeks)}. The broker takes 2.5% and earns it if the book is any good.`,
    });
    return { s: next };
  }
  next.holdings[bbl].sale = { ask: Math.round(ask), listedM: next.month, mode: "quiet" };
  next.news.unshift({ q: next.month, kind: "info", text: `${rec.address} goes to market at $${(ask / 1e6).toFixed(2)}M. No broker, no campaign — you wait for the phone.` });
  return { s: next };
}

/**
 * THE SELL-SIDE FEE — and the quiet one is what your name is worth.
 *
 * A run process costs two and a half points and gets you every buyer in the
 * city in the same room on the same day. That fee is a fact about the business
 * and it does not move.
 *
 * The quiet sale is a different trade and it was priced as if it were the same
 * one. Selling off-market means somebody already knew you had it and rang you,
 * or you rang them — and if you are the one who found the buyer there is no
 * broker in the room to pay. The owner asked for that to be free, and the
 * condition they attached is exactly right: it should depend on your standing,
 * because standing is the only thing that produces a buyer without a broker.
 * A firm nobody has dealt with cannot sell a building off-market; they have no
 * phone to pick up. They pay the point and a half and get a sign on the door.
 *
 * So the quiet fee runs from the full point and a half down to nothing, on two
 * things that already exist and are already how this game keeps score:
 *
 *   `street`      the named firms who have traded with you. Every one of them
 *                 is somebody who might take the call, and the share of the
 *                 living firms who know you is the cleanest reading of reach
 *                 this engine has.
 *   `lowballs`    the market-wide bill for being the sixty-per-cent guy, which
 *                 `repFloorMult` already charges on the buy side. A reputation
 *                 that raises every seller's floor against you also means
 *                 nobody takes your call when you are the one selling.
 *
 * This is deliberately a HOOK and not a system: when the reputation tab is
 * built, it replaces the body of this function and nothing else changes,
 * because every caller asks the same question — what does this sale cost.
 */
export function quietFeeRate(s: GameState): number {
  const firms = livingRivals(s);
  if (!firms.length) return SALE_BROKERAGE;
  let known = 0;
  for (const r of firms) if ((s.street?.[r.id]?.deals ?? 0) > 0) known++;
  // Reach is the share of the street that has actually traded with you. Half
  // the firms in town is a name that sells a building without a broker.
  const reach = Math.min(1, (known / firms.length) / 0.5);
  // ...and a lowballing reputation takes it straight back off. Three stories in
  // three years is the threshold `repFloorMult` already uses.
  const burnt = Math.min(1, recentLowballs(s) / 3);
  // No reach: the full point and a half. Full reach and a clean name: nothing.
  // Full reach and a burnt name: the full fee again, because the phone that
  // would have saved it is the phone nobody is answering.
  return SALE_BROKERAGE * (1 - reach * (1 - burnt));
}

export function saleFeeRate(h: Holding, s?: GameState): number {
  if (h.sale?.mode === "marketed") return 0.025;
  return s ? quietFeeRate(s) : SALE_BROKERAGE;
}

const BIDDER_NAMES = [
  "a pension fund adviser", "a family office", "a listed REIT", "an overseas buyer",
  "a local operator", "a debt fund taking equity risk", "a 1031 buyer on a clock",
  "an insurance company", "a private syndicate",
];

/**
 * OFFERS ARE DUE TODAY.
 *
 * Every buyer who was going to bid, bidding at once. The depth of the list is
 * the market: in a hot cycle with money everywhere you get five names and the
 * top one is well over the whisper; in a crunch you get one, or none, and the
 * whisper was a work of fiction.
 *
 * The spread across the list is the information. A tight list means the market
 * agrees with your number and there is nothing more to get. A wide one means
 * the top bidder wants it much more than the rest — which is exactly when best
 * and final is worth the risk of losing them.
 */
function runCallForOffers(s: GameState, parcels: ParcelTable, h: Holding) {
  const rec = resolveRec(parcels, s, h.bbl);
  const sale = h.sale;
  if (!rec || !sale) return;
  const value = ownedHoldingValue(s, parcels, h);
  const ratio = sale.ask / Math.max(1, value);
  const appetite = marketAppetite(s);
  const phase = s.econ.phase === "peak" ? 1.5 : s.econ.phase === "expansion" ? 1.25
    : s.econ.phase === "recovery" ? 0.8 : 0.35;
  // how many people actually turned up
  const expected = Math.max(0, 3.4 * phase * Math.max(0.3, appetite) * Math.max(0.25, 2.1 - ratio));
  let n = Math.floor(expected) + (rng(s, "sales") < expected % 1 ? 1 : 0);
  n = Math.min(6, n);
  const bids: Bid[] = [];
  const used = new Set<string>();
  // THE PEOPLE YOU COMPETE WITH ALL CENTURY SHOULD TURN UP WHEN YOU SELL.
  //
  // Measured over six fifty-year runs: rival bids in the player's own sale
  // process, zero. Not rare — zero. The pool was nine anonymous strings and
  // the twelve named firms were not in it, so you could run a best-and-final
  // every year for fifty years and never once see a name you recognised.
  // Losing to "a family office" is a dice roll; losing to Kestrel Capital,
  // who outbid you on the Drydock block in 2009, is a story.
  //
  // Who actually turns up is filtered by who can pay: a firm bids on your
  // building only if it has the cash and is not already in trouble.
  const live = livingRivals(s).filter((r) => !r.stressMs && r.cash > value * 0.22);
  for (let i = 0; i < n; i++) {
    // roughly half the room is the street, by name, when the street is liquid
    const firm = live.length && rng(s, "sales") < 0.55
      ? live[Math.floor(rng(s, "sales") * live.length)] : null;
    let name = firm && !used.has(firm.name)
      ? firm.name
      : BIDDER_NAMES[Math.floor(rng(s, "sales") * BIDDER_NAMES.length)];
    let guard = 0;
    while (used.has(name) && guard++ < 12) name = BIDDER_NAMES[Math.floor(rng(s, "sales") * BIDDER_NAMES.length)];
    used.add(name);
    // Bids cluster around value with a real tail. The outlier at the top of a
    // good list is the whole reason to run a process.
    // The point of a process is the TOP of the list, not its middle. A single
    // buyer who happens to ring bids around the mark; the best of five bids in
    // a live market bids over it, and that gap — not the fee, not the speed —
    // is the entire reason anyone runs a campaign. Calibrated so a normal
    // three-bid list clears a per cent or two above appraisal and a thin
    // one-bid market clears just under it, which is the honest trade.
    const enthusiasm = rng(s, "sales");
    // CENTRED ON APPRAISAL, NOT ABOVE IT.
    //
    // This ran [0.90, 1.251] at the top of the cycle: the mean single bid was
    // 1.076x appraisal and the expected MAX OF SIX was 1.201x. The comment two
    // lines up claims a normal three-bid list clears "a per cent or two above
    // appraisal" — it was clearing sixteen. Since the tape sells to you at a
    // median 0.951x, that is a structural eighteen-point round trip against
    // appraisal, repeatable, on 29% equity.
    //
    // Measured: bolted onto an ordinary bot it took the 50-year median from
    // $73M to $619M, and with the 1031 to $706M with ZERO failures — the tenth
    // percentile of the exploit beat the disciplined reference median by 40%.
    // Now [0.86, 1.09] at peak: E[max of 3] ~1.03, E[max of 6] ~1.06, which is
    // what the calibration always claimed.
    const price = Math.round(value * (0.86 + 0.20 * enthusiasm * Math.max(0.55, Math.min(1.15, phase))));
    // A buyer stretching past the pack is the one most likely to find a reason
    // to come back to you about it later.
    const credibility = Math.max(0.2, Math.min(0.97, 1.0 - 0.55 * enthusiasm + (rng(s, "sales") - 0.5) * 0.3));
    bids.push({
      name, price, credibility,
      note: credibility > 0.75 ? "Cash to close, no financing condition."
        : credibility > 0.5 ? "Financed, but the lender is known."
        : "Aggressive number. Read the covenant before you count on it.",
    });
  }
  bids.sort((a, b) => b.price - a.price);
  sale.bids = bids;
  delete sale.callM;
  if (!bids.length) {
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `Offers were due at ${rec.address} and nobody bid. The book went out to the whole market and the whole market passed — that is information about your number, or about the building.`,
    });
    return;
  }
  const top = bids[0].price;
  // A BID LIST IS A DECISION WITH A FUSE. It used to arrive as news only —
  // attention, the Deals badge and the interrupt modal all keyed off quiet
  // `sale.offer`, so a marketed campaign could land three names, sit unread
  // on the property card, and wipe the listing at month 14 with the player
  // still thinking nothing had happened.
  raiseAlert(s, {
    kind: "sale", tone: "good",
    title: `${bids.length} bid${bids.length === 1 ? "" : "s"} in at ${rec.address}`,
    body: `Best is $${(top / 1e6).toFixed(2)}M from ${bids[0].name}`
      + (bids.length > 1 ? `, against $${(bids[1].price / 1e6).toFixed(2)}M second` : "")
      + `. ${top >= sale.ask ? "Over the whisper." : `${Math.round((1 - top / Math.max(1, sale.ask)) * 100)}% under the whisper.`} `
      + `The list is on Deals and on the property — it will not wait forever.`,
    detail: `$${(top / 1e6).toFixed(2)}M`,
  });
}

/**
 * BEST AND FINAL.
 *
 * Go back to the top of the list and tell them there is another number they
 * have to beat. Most of them sharpen. Some of them, correctly, tell you they
 * were at their best the first time and walk — and if the one who walks was
 * your top bid, you have just talked yourself down the list. One round only,
 * because a second is how a seller becomes a story.
 */
export function bestAndFinal(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; err?: string; msg?: string } {
  const h = s.holdings[bbl];
  const sale = h?.sale;
  if (!sale?.bids?.length) return { s, err: "There is no bid list to go back to." };
  if ((sale.round ?? 0) > 0) return { s, err: "You have already been back to them once. Twice and you are the story, not the building." };
  const next = clone(s);
  const ns = next.holdings[bbl].sale!;
  const live = (ns.bids ?? []).filter((b) => !b.dropped).slice(0, 3);
  const rec = resolveRec(parcels, next, bbl);
  let walked = 0, lifted = 0;
  for (const b of live) {
    // The ones who can afford to be patient are the ones who walk.
    const pWalk = 0.30 * (1 - b.credibility) + (next.econ.phase === "recession" ? 0.18 : 0);
    if (rng(next) < pWalk) { b.dropped = true; walked++; continue; }
    const bump = 1 + rrange(next, 0.005, 0.055) * b.credibility;
    const before = b.price;
    b.price = Math.round(b.price * bump);
    if (b.price > before) lifted++;
  }
  ns.round = 1;
  ns.bids = (ns.bids ?? []).sort((a, b) => (a.dropped ? 1 : 0) - (b.dropped ? 1 : 0) || b.price - a.price);
  const best = ns.bids.find((b) => !b.dropped);
  next.news.unshift({
    q: next.month, kind: best ? "deal" : "warn",
    text: `Best and final at ${rec?.address ?? bbl}: ${lifted} sharpened, ${walked} walked. `
      + (best ? `The number to beat is $${(best.price / 1e6).toFixed(2)}M from ${best.name}.`
        : `Everybody left the table. That was the risk and it came in.`),
  });
  return { s: next, msg: best ? "Bids refreshed." : "They all walked." };
}

/**
 * TAKE A BID — and find out whether they meant it.
 *
 * A number on a bid list is not a closing. The weaker the covenant behind it,
 * the likelier the buyer comes back after they have been through the building
 * with a reason the price should be lower. A retrade is not a refusal; it is a
 * new offer at a worse number, and you already have the machinery to accept it,
 * counter it, or tell them to go away.
 */
export function acceptBid(s: GameState, parcels: ParcelTable, bbl: string, index: number): { s: GameState; err?: string; msg?: string } {
  const h = s.holdings[bbl];
  const sale = h?.sale;
  const bid = sale?.bids?.[index];
  if (!bid || bid.dropped) return { s, err: "That bid is not on the table." };
  const next = clone(s);
  const ns = next.holdings[bbl].sale!;
  const b = ns.bids![index];
  const rec = resolveRec(parcels, next, bbl);
  const pRetrade = 0.42 * (1 - b.credibility);
  if (rng(next) < pRetrade) {
    const cut = rrange(next, 0.02, 0.08);
    const price = Math.round(b.price * (1 - cut));
    const reasons = [
      "their engineer found the roof",
      "their lender resized the loan",
      "they read the rent roll properly and did not like the rollover",
      "their committee would not approve the number",
      "the environmental report came back with a question",
    ];
    const reason = reasons[Math.floor(rng(next) * reasons.length)];
    ns.offer = { price, expiresM: next.month + 2, from: b.name, retrade: reason };
    delete ns.bids;
    next.news.unshift({
      q: next.month, kind: "warn",
      text: `${b.name} has retraded ${rec?.address ?? bbl} — ${reason}. `
        + `They are at $${(price / 1e6).toFixed(2)}M now, down from $${(b.price / 1e6).toFixed(2)}M. Take it, counter it, or tell them no.`,
    });
    return { s: next, msg: "They retraded you." };
  }
  ns.offer = { price: b.price, expiresM: next.month + 2, from: b.name };
  delete ns.bids;
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `${b.name} is under contract at ${rec?.address ?? bbl} for $${(b.price / 1e6).toFixed(2)}M, clean. Close it.`,
  });
  return { s: next, msg: "Under contract." };
}

/**
 * WHO WANTS IT, AND WHAT THAT IS WORTH.
 *
 * An unsolicited approach is not a random number — it is a specific firm with
 * a specific reason, and the reason is the price. A neighbour assembling a
 * site will pay well over the mark because the lot is worth more to them than
 * it is to the market; a fund adding to a position pays a modest premium for
 * not having to compete for it; an opportunist who noticed your building is
 * half empty is not paying a premium at all.
 *
 * This is the same assemblage logic that has been making YOUR approaches
 * dearer since the first one, pointed back at you — which is exactly how it
 * works from the other side of the table.
 */
function unsolicitedBidder(
  s: GameState, parcels: ParcelTable, adjacency: Adjacency | null, rec: ParcelRecord, h: Holding,
): { name: string; why: string; mult: number } {
  const firms = livingRivals(s).filter((r) => !r.stressMs);
  // Does anybody own the lots around this one?
  const nbrs = new Set(adjacency?.[rec.bbl] ?? []);
  const neighbour = nbrs.size ? firms.find((r) => r.bbls.filter((b) => nbrs.has(b)).length >= 2) : undefined;
  if (neighbour && rec.class === "land") {
    return {
      name: neighbour.name,
      why: `They own ${neighbour.bbls.filter((b) => nbrs.has(b)).length} of the lots around it and they are assembling a site. `
        + `This is the number somebody pays when your dirt is the last piece.`,
      mult: rrange(s, 1.22, 1.55, "sales"),
    };
  }
  if (neighbour) {
    return {
      name: neighbour.name,
      why: `They have the deeds either side. A building on the corner of somebody else's assemblage is worth more to `
        + `them than it is to the market, and they have just told you how much more.`,
      mult: rrange(s, 1.12, 1.34, "sales"),
    };
  }
  // Somebody accumulating this asset class, who would rather not bid against
  // the whole city for the next one.
  const collector = firms
    .map((r) => ({
      r, n: r.bbls.filter((b) => (resolveRec(parcels, s, b)?.class ?? "") === rec.class).length,
    }))
    .filter((x) => x.n >= 3)
    .sort((a, b) => b.n - a.n)[0];
  if (collector && rng(s, "sales") < 0.7) {
    return {
      name: collector.r.name,
      why: `They already own ${collector.n} like it and would rather buy yours quietly than bid against the city for the next one.`,
      mult: rrange(s, 1.04, 1.16, "sales"),
    };
  }
  // The opportunist. Reads the rent roll, notices the vacancy, and prices it.
  const occ = rec.bldgArea > 0
    ? Math.min(1, h.tenants.reduce((a, t) => a + t.sf, 0) / rec.bldgArea + (h.occ ?? 0) * 0.5) : 1;
  const who = firms.length ? firms[Math.floor(rng(s, "sales") * firms.length)].name : "An out-of-town buyer";
  return occ < 0.7
    ? { name: who, why: "They have read the rent roll and they are pricing the empty floors, not the building.", mult: rrange(s, 0.84, 0.96, "sales") }
    : { name: who, why: "No particular reason beyond wanting it. Those are the ones worth listening to.", mult: rrange(s, 0.98, 1.14, "sales") };
}

export function delist(s: GameState, bbl: string): GameState {
  const next = clone(s);
  const h = next.holdings[bbl];
  if (h?.sale) {
    // A pulled campaign is remembered. The market saw the book.
    if (h.sale.mode === "marketed") h.lastCampaignM = next.month;
    delete h.sale;
  }
  return next;
}

// What a sale nets and owes. Friction first — sell-side brokerage, transfer
// tax, legal and title all come off the top before anyone computes a gain.
export function saleTaxQuote(h: Holding, price: number, s?: GameState): { net: number; gain: number; tax: number; recapture: number; appreciation: number } {
  // A run process costs a point more in fees than a sign on the door, and that
  // point is the price of finding out what the market would actually pay.
  const net = Math.round(price * (1 - saleFeeRate(h, s) - TRANSFER_TAX - SALE_FRICTION));
  const depr = h.deprTaken ?? 0;
  const adjBasis = h.costBasis - depr;
  const gain = net - adjBasis;
  // Depreciation is a loan from the government, not a gift. On the way out,
  // every dollar of it comes back at 25% before a cent of the real
  // appreciation is taxed at the long-term rate. A player who levers hard and
  // depreciates fast has been borrowing against this the whole time.
  const recapture = Math.max(0, Math.min(depr, gain));
  const appreciation = Math.max(0, gain - recapture);
  const tax = Math.round(recapture * RECAPTURE_RATE + appreciation * CAP_GAINS_RATE);
  return { net, gain, tax, recapture, appreciation };
}

/**
 * WHAT REACHES THE SELLER — one helper for the offer modal and the close.
 *
 * The modal used to show `saleTaxQuote.net − loan − tax` and omit the
 * participating kicker, prepayment break fee, and facility release. Accepting
 * then took those off at the table, so "Net to you" lied by up to the release
 * premium on a crossed deed.
 */
export function saleProceedsToSeller(
  s: GameState, parcels: ParcelTable, h: Holding, price: number,
): {
  net: number; gain: number; tax: number; kick: number; breakFee: number;
  release: number; loanPayoff: number; toSeller: number;
} {
  const { net, gain, tax } = saleTaxQuote(h, price, s);
  const kick = h.loan?.kicker && gain > 0 ? Math.round(gain * h.loan.kicker) : 0;
  const stack = stackPayoff(h, s.month);
  const breakFee = stack.penalty;
  const release = releaseCost(s, parcels, h.bbl);
  const loanPayoff = stack.balance;
  const toSeller = net - loanPayoff - kick - breakFee - release;
  return { net, gain, tax, kick, breakFee, release, loanPayoff, toSeller };
}

export function acceptSaleOffer(s: GameState, parcels: ParcelTable, bbl: string, exchange = false): { s: GameState; err?: string } {
  const h = s.holdings[bbl];
  const offer = h?.sale?.offer;
  if (!h || !offer) return { s, err: "No live offer." };
  if (s.month > offer.expiresM) return { s, err: "That offer lapsed." };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const { gain, tax } = saleTaxQuote(h, offer.price, s);
  if (exchange && s.exchange) return { s, err: "One exchange at a time — close the live 1031 first." };
  if (exchange && tax <= 0) return { s, err: "No gain to shelter — just take the cash." };
  const next = clone(s);
  // Participating paper takes its cut here, and only here. That is the whole
  // trade: you borrowed at a third of a point over the index for years, and
  // the lender collects on the way out.
  // Same stack maths as saleProceedsToSeller — mezz comes off the table too.
  const px = saleProceedsToSeller(next, parcels, h, offer.price);
  const kick = px.kick;
  const breakFee = px.breakFee;
  const release = px.release;
  const toSeller = px.toSeller;
  // Vehicle deed: proceeds and tax sit on fund.cash so the promote has a
  // counterparty. GP cash is untouched on a fund exit.
  const intoFund = !!(h.fundOwned && next.fund && !next.fund.settled);
  if (intoFund && next.fund) next.fund.cash += toSeller;
  else next.cash += toSeller;
  // THE FEE COMES OUT OF THE PROCEEDS ONCE, NOT TWICE.
  //
  // The kicker and the break fee are already deducted from `toSeller` — they
  // are settled at the closing table out of the sale price — and they were
  // ALSO booked as debt service. So the ledger deducted them a second time and
  // the conservation identity showed money APPEARING by exactly their amount.
  // Measured at $0.027M on a sale whose news line read "$0.03M to break the
  // loan early", which is the same number twice.
  //
  // Booking the proceeds GROSS of the fee and the fee as the expense it is
  // balances the identity and is the better statement besides: a player who
  // paid a prepayment penalty should see a prepayment penalty, not a smaller
  // sale. The loan PRINCIPAL stays out of both — repaying a balance is a
  // balance-sheet movement, not income and not expense.
  //
  // This survived because conserve's bot never sold anything. It sells now.
  logBooks(next, "sold", toSeller + kick + breakFee);
  if (kick + breakFee > 0) logBooks(next, "debtSvc", kick + breakFee);
  // The release is a repayment of principal, not an expense — it comes out of
  // the proceeds and goes against the balance, so `sold` is struck net of it
  // for the same reason it is struck net of the mortgage payoff.
  if (release > 0 && next.facility) {
    next.facility.balance = Math.max(0, next.facility.balance - release);
    next.facility.bbls = next.facility.bbls.filter((b: string) => b !== bbl);
    next.news.unshift({
      q: next.month, kind: "info",
      text: `$${(release / 1e6).toFixed(2)}M of the sale went to release ${rec.address} from the facility — `
        + `its allocated share at ${Math.round((RELEASE_PREMIUM - 1) * 100)}% over. Balance $${(next.facility.balance / 1e6).toFixed(1)}M.`,
    });
    if (next.facility.balance <= 0) delete next.facility;
  }
  if (exchange) {
    next.exchange = { deferredTax: tax, rolledGain: gain, minPrice: offer.price, deadlineM: next.month + EXCHANGE_WINDOW_M };
  } else if (tax > 0) {
    if (intoFund && next.fund) next.fund.cash -= tax;
    else next.cash -= tax;
    next.taxesPaid = (next.taxesPaid ?? 0) + tax;
    logBooks(next, "taxes", tax);
  }
  next.exits = next.exits ?? [];
  next.exits.push({ bbl, address: rec.address, boughtM: h.boughtM, soldM: next.month, price: offer.price, basis: h.costBasis, gain });
  recordComp(next, rec, offer.price, "a buyer", firmShort(next), undefined, h.condition);
  if (next.exits.length > 200) next.exits.shift();
  // AN ASSEMBLED SITE SELLS AS ONE SITE. The child deeds go with it — their
  // land, their basis and their value were folded into this one the day it was
  // assembled, and the buyer is paying for all of it.
  for (const [child, parent] of Object.entries(next.merged ?? {})) {
    if (parent !== bbl) continue;
    delete next.merged![child];
    // ...AND THEIR TENANTS' DEPOSITS GO WITH THEM. This deleted the child deed
    // and left the deposits behind as a liability that simply stopped existing:
    // money the player was holding for somebody else, released with no entry
    // and no cash moving. `pnpm conserve` caught it as a positive residual —
    // "money APPEARED" — on 7 of 3,267 reconciled months, $5K-$49K each, which
    // is exactly the size of a small building's roll. The parent's deposits
    // were handed over correctly a few lines below; the children's were not.
    const childDep = depositsOn(next.holdings[child]);
    if (intoFund && next.fund) next.fund.cash -= childDep;
    else next.cash -= childDep;
    delete next.holdings[child];
    if (next.workouts?.[child]) delete next.workouts[child];
  }
  // The leased fee leaves with the deed, HERE, not on the next tick. The
  // invariant sweep reads the state the moment the sale returns — the lease
  // must not still be keyed as yours for even one call. It continues off-book
  // as the buyer's encumbrance (see transferGroundLeaseOffBook).
  if (next.groundLeases?.[bbl]) transferGroundLeaseOffBook(next, bbl);
  // The security deposits go with the deed — they were the tenants' money and
  // they are the buyer's obligation now.
  {
    const dep = depositsOn(next.holdings[bbl]);
    if (intoFund && next.fund) next.fund.cash -= dep;
    else next.cash -= dep;
  }
  // Somebody owns it now, and they will hold it for years — the tape does
  // not get it back next quarter.
  next.lastTradeM = next.lastTradeM ?? {};
  next.lastTradeM[bbl] = next.month;
  delete next.holdings[bbl];
  // A SALE OUT OF DEFAULT CLOSES THE FILE. It is the best outcome available in
  // a workout — the lender is repaid at closing and nobody takes a loss — and
  // the file has to die with the deed, not linger and foreclose on a building
  // somebody else owns.
  if (next.workouts?.[bbl]) delete next.workouts[bbl];
  next.lois = next.lois.filter((l) => l.bbl !== bbl);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Closed: ${rec.address} at $${(offer.price / 1e6).toFixed(2)}M — ${gain >= 0 ? "a gain" : "a loss"} of $${(Math.abs(gain) / 1e6).toFixed(2)}M against basis`
      + (kick > 0 ? `. Your lender took $${(kick / 1e6).toFixed(2)}M of the gain` : "")
      + (breakFee > 0 ? `, and $${(breakFee / 1e6).toFixed(2)}M to break the loan early` : "")
      + (exchange ? `. 1031 clock running: buy for ≥ $${(offer.price * 0.8 / 1e6).toFixed(1)}M by ${monthLabel(next.month + EXCHANGE_WINDOW_M)} or $${(tax / 1e6).toFixed(2)}M of tax comes due.`
        : tax > 0 ? ` ($${(tax / 1e6).toFixed(2)}M capital-gains tax withheld).` : "."),
  });
  // Sale proceeds pay the revolver now — not on the next Advance.
  sweepLocIdleCash(next, { announce: true });
  return { s: next };
}

export function declineSaleOffer(s: GameState, bbl: string): GameState {
  const next = clone(s);
  const sale = next.holdings[bbl]?.sale;
  if (sale?.offer) delete sale.offer;
  return next;
}

// Monthly: buyers circle listed assets. Offer flow scales with how honest
// the ask is, the market phase, and how long it has sat. A live offer on a
// well-priced asset sometimes draws a second bidder who pushes the number.
/**
 * INBOUND BROKERAGE.
 *
 * Twenty years of play produced five decisions. Not because the simulation was
 * wrong — a two-tenant building genuinely does not generate much — but because
 * the only deal flow that reached the player was a public tape they had to go
 * and read. That is not how this business works. Brokers call you, unprompted,
 * about a building that is not for sale, because they know what you own and
 * they want the fee.
 *
 * This is the existing off-market channel run in the other direction: it
 * writes an Approach exactly as walking up to an owner would, so the same
 * counter-and-close path applies. Nothing new to learn, and something to
 * think about most quarters instead of most decades.
 */
/**
 * How long the town takes to learn your name. No off-market call reaches a
 * principal before this, whatever the hazard says.
 */
export const FIRST_CALL_M = 24;

export function tickBrokerCalls(s: GameState, parcels: ParcelTable, bbls: string[]) {
  // NOBODY RINGS A STRANGER.
  //
  // An off-market call is a favour, and a favour is something you are owed.
  // A broker sitting on a file they can only show to one buyer shows it to a
  // name they have closed with — not to somebody who arrived in town in
  // January with six million dollars and no record. A record takes a couple of
  // years of closings, of listings walked and lunches taken, before anybody
  // thinks of you when a file lands on their desk — so the first two years are
  // the ones where you work the public tape like everybody else, and the phone
  // starting to ring is the first sign that the street has noticed you exist.
  //
  // The drought clock (quietMs) runs from month one regardless, so the hazard
  // is already sitting at its ceiling when this gate lifts: the first call
  // arrives soon AFTER the second anniversary rather than years later.
  // Measured across ten seeds with an idle desk: earliest month 27, median 36,
  // all ten inside six years. See test/brokercall.mjs, which is the gate.
  if (s.month < FIRST_CALL_M) return;
  // A broker's interest in you scales with what you already own — the first
  // deal is the hard one, and after that the phone does not stop.
  const owned = Object.keys(s.holdings).length;
  const hot = s.econ.phase === "expansion" || s.econ.phase === "peak";
  // A real broker with a real off-market file calls a few times a YEAR, not
  // most months. The old rate — up to 30% a month — meant the phone rang
  // thirty-odd times a decade and the calls stopped being events. A fifth of
  // that: an occasional knock, worth picking up.
  const base = Math.min(0.06, (0.011 + 0.004 * Math.min(8, owned)) * (hot ? 1.25 : 0.7) * Math.max(0.5, s.econ.creditIdx ?? 1));
  // ...AND HOW QUIET YOUR DESK IS.
  //
  // Every other inbound channel in this engine is gated on the size of your
  // book, which is why owning little means hearing nothing and the first
  // decade of a fifty-year campaign is a solitaire. This one is gated on the
  // opposite, because that is how the business works: a broker with a file and
  // an afternoon rings the principal who has money and time, not the one who
  // is already in three negotiations. The drought is its own trigger, so
  // silence is self-limiting — measured, it takes the longest run of nothing
  // from 41 months to 15 for 1.46 extra calls a year.
  //
  // Dry powder gates it, because a broker rings buyers, not spectators.
  const quiet = s.quietMs ?? 0;
  // WHO A BROKER ACTUALLY SKIPS. This tested cash on hand — and measured over
  // 2,400 months of competent play, a principal sits under two million dollars
  // SEVENTY-FIVE PER CENT of the time, because the money is in buildings,
  // which is the entire point of the game. So the floor that exists to break a
  // drought was being scaled to three tenths in three months out of four, and
  // the drought survived it: 0.72 calls a year against the 1.46 the mechanic
  // was calibrated for.
  //
  // A broker does not ask what is in your current account. They ask whether
  // you can close — and cash, the undrawn line, and the equity you could pull
  // out of what you already own all answer that. A principal with a book has
  // all three, and a principal with nothing has none of them, which is the
  // distinction this was reaching for in the first place.
  let power = s.cash + locAvailable(s, parcels);
  for (const h of Object.values(s.holdings)) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    power += Math.max(0, ownedHoldingValue(s, parcels, h) - (h.loan?.balance ?? 0)) * 0.14;
  }
  const dry = power > 2_000_000 ? 1 : 0.3;
  // A BROKER RINGS THE BUYER WHO CLOSES. Serial lowballing is the one story
  // that travels faster than money in this business, and the first person to
  // act on it is the broker deciding whose afternoon gets the call.
  const rep = 1 - 0.18 * Math.min(4, Math.max(0, recentLowballs(s) - 1));
  // FOUR TIMES QUIETER, BY REQUEST. The playtest verdict was that the phone
  // rings too often — and the player can also simply tell the brokers to stop
  // calling, which is a real thing a principal does. The hazard keeps its
  // shape (the drought floor still ramps, reputation still gates); only the
  // level drops. One consistent RNG draw either way, so a save replays the
  // same whether or not the phone is switched on.
  const QUIETER = 0.25;
  const p = (quiet > 0
    ? Math.min(0.85, Math.max(base, 0.12 * (1 + quiet / 1.6)) * dry)
    : base) * rep * QUIETER;
  const roll = rng(s, "sales");
  if (s.brokersOff) return;
  if (roll >= p) return;

  // they pitch near what you already buy: same class, similar size, better corner
  const ref = Object.values(s.holdings).map((h) => resolveRec(parcels, s, h.bbl)).filter(Boolean) as ParcelRecord[];
  const wantClass = ref.length && rng(s, "sales") < 0.65 ? ref[Math.floor(rng(s, "sales") * ref.length) % ref.length].class : null;
  // WHOSE BUILDINGS THE PHONE RINGS ABOUT.
  //
  // Measured: sixteen off-market calls a fifty-year run and 2% of them on a
  // building anybody could name, because this drew uniformly from sixteen
  // hundred lots and the named firms own about three per cent of them. That is
  // not how an off-market call works. A broker with a file he can show to one
  // buyer shows it to the buyer who has closed with that seller before — so
  // most of the time the pool is the stock of the firms you actually know, and
  // the rest of the time it is the whole town.
  const known = Object.keys(s.street ?? {});
  const insidePool: string[] = [];
  if (known.length) {
    for (const r of s.rivals ?? []) {
      if (r.failedM !== undefined || !s.street?.[r.id]) continue;
      for (const b of r.bbls) insidePool.push(b);
    }
  }
  // PRIVATE RELATIONSHIPS ARE AN ASSET TOO. A family or partnership you have
  // closed with before is exactly who gives your broker the first look at the
  // next deed in their book. The register and relationship memory already
  // existed; broker calls ignored both and made decades of clean closings
  // irrelevant outside the original approach.
  const related: string[] = [];
  for (const bbl of bbls) {
    const held = holderOf(s, parcels, bbl);
    if (!held || isCold(s, held.id) || (relOf(s, held.id).deals ?? 0) <= 0) continue;
    related.push(bbl);
  }
  const relationshipPool = [...new Set([...insidePool, ...related])];
  const inside = relationshipPool.length > 0 && rng(s, "sales") < 0.65;
  const pool = inside ? relationshipPool : bbls;
  let best: ParcelRecord | null = null;
  for (let i = 0; i < 90; i++) {
    const bbl = pool[Math.floor(rng(s, "sales") * pool.length)];
    if (s.holdings[bbl] || s.approaches[bbl] || s.listings.some((l) => l.bbl === bbl)) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    const pitchHeld = holderOf(s, parcels, bbl);
    if (pitchHeld && isCold(s, pitchHeld.id)) continue;
    if (wantClass && rec.class !== wantClass && rng(s, "sales") < 0.7) continue;
    const v = assetValue(rec, s.econ, gradeOf(s, rec));
    // THE FLOOR MOVES WITH YOUR BOOK.
    //
    // There was a ceiling here and no floor, so a firm running a hundred
    // million kept getting rung about three-million-dollar walk-ups. No broker
    // does that twice: the file you get shown is the file that matches the
    // cheque you can write, and pitching a principal a deal that would move
    // their net worth by three per cent is how you stop being called back.
    // Roughly a twentieth of net worth at the bottom, capped so it never
    // filters out the whole city early on.
    const nw = netWorthLike(s);
    const floor = Math.min(20_000_000, Math.max(0, nw * 0.05));
    if (v <= 0 || v < floor || v > Math.max(6_000_000, nw * 1.6)) continue;
    best = rec;
    break;
  }
  if (!best) return;

  // An unsolicited pitch is rarely cheap — you are paying for not competing.
  // In a soft market the whisper number gets a good deal more reasonable. And
  // if the building belongs to a firm you can name, the number is THEIR
  // number: a family trust that owns it outright quotes a silly price, and a
  // shop that is three months from a margin call quotes inside appraisal.
  // A BROKER'S CALL IS A FILTER, NOT A FIREHOSE. The reason to pick up the
  // phone for an off-market pitch is that it is priced to move — an owner who
  // wants retail-plus for their building lists it like everybody else. So the
  // broker only rings when the whisper number is a real discount to value:
  // an estate that wants out, a fund past its hold period, a rival that needs
  // the cash. If today's file has nothing under 92 cents on the dollar, the
  // phone stays quiet.
  const owner = ownerOf(s, best.bbl);
  const held = owner ? null : holderOf(s, parcels, best.bbl);
  const value = assetValue(best, s.econ, gradeOf(s, best));
  let ask: number;
  let who: string;
  if (owner) {
    const q = rivalAsk(s, parcels, owner, best.bbl);
    ask = Math.round(q.ask / 1000) * 1000;
    who = q.note;
  } else {
    // A CALL YOU EARNED BY BEING FREE IS NOT A CALL YOU EARNED BY BEING RIGHT.
    //
    // When the phone rings because your desk was empty rather than because the
    // file was hot, the broker is filling an afternoon, not clearing a fire,
    // and the whisper number is correspondingly nearer the mark. Without this
    // the quiet-desk hazard would be a free seven-point discount handed to
    // whoever does the least.
    const idle = (s.quietMs ?? 0) > 2 ? 0.07 : 0;
    const motivated = (s.econ.phase === "recession" ? rrange(s, 0.78, 0.90, "sales") : rrange(s, 0.84, 0.92, "sales")) + idle;
    ask = Math.round(value * motivated / 1000) * 1000;
    who = held && (relOf(s, held.id).deals ?? 0) > 0
      ? `${held.name} gave your broker the first look because you have closed together before.`
      : "Their client needs it done this quarter — that is why you are hearing about it.";
  }
  // A GATE THAT REJECTED EVERYTHING. This asked for a price under 92% of
  // appraisal, and measured across 150 live rival-owned buildings the asks
  // came in at 1.10x to 1.29x — so it passed ZERO of them, ever. rivalAsk is
  // the only function in the codebase that gives a firm a personality at a
  // negotiating table, and it was unreachable.
  //
  // A broker calling about somebody's building is not necessarily calling
  // with a bargain — they are calling because it is AVAILABLE, which is worth
  // hearing on a building that never comes to market. An owner's number is
  // where the conversation starts, not where it ends. Only a genuinely silly
  // ask gets filtered, and a stressed seller still has to be a real discount
  // to be worth the call.
  const cap = owner ? (owner.stressMs ? 0.97 : 1.34) : 0.92;
  if (ask > value * cap) return;
  // A broker with a file has the file. tickBrokerCalls runs AFTER tickLeasing,
  // so the sweep there would not catch this record until next month — and the
  // player can read it tonight. Stamped where it is written. See stampApproach.
  //
  // ...AND THE STAMP HAS TO COME FIRST, which is the whole reason this is
  // written in this order. The yield gate below underwrites the building, and
  // `inPlace` reads the DISCLOSED rent roll when there is one and falls back to
  // the class model when there is not. Testing before stamping meant the gate
  // underwrote the class model — measured across 3,195 listings elsewhere in
  // this file, the model reads ~89% occupancy where real rolls run ~69% — and
  // then handed the player a file with the real roll on it. Same building, two
  // answers, and the optimistic one doing the deciding. So the roll is
  // generated, the pitch is judged on it, and a pitch that fails is withdrawn.
  // `genRentRoll` runs on a private stream keyed to the parcel, so writing and
  // withdrawing costs nothing and moves no other dice.
  s.approaches[best.bbl] = stampApproach(s, best, { q: s.month, refused: false, ask, inbound: true });
  // IF IT IS OVER APPRAISAL IT HAS TO EARN THE CALL ON YIELD. The rule and the
  // reason are in `worthTheCall`; it is shared with the grudge payoff in
  // rivals.ts so the two channels that ring the player cannot drift apart.
  if (!worthTheCall(s, parcels, best, best.bbl, ask, value)) {
    delete s.approaches[best.bbl];
    return;
  }
  s.news.unshift({
    q: s.month, kind: "deal",
    text: `A broker called about ${best.address} — ${best.bldgArea.toLocaleString()} sf, off market, whisper number $${(ask / 1e6).toFixed(2)}M against roughly $${(value / 1e6).toFixed(2)}M of value. ${who}`,
  });
}

// net worth without importing the whole valuation graph — cash plus equity
function netWorthLike(s: GameState): number {
  let n = s.cash;
  for (const h of Object.values(s.holdings)) n += Math.max(0, h.costBasis - (h.loan?.balance ?? 0));
  return n;
}

/**
 * COUNTER A BID ON YOUR OWN BUILDING.
 *
 * Selling was accept-or-decline, which is not selling — declining a bid you
 * would have taken five per cent higher just throws the buyer away, and every
 * seller in the world picks up the phone instead.
 *
 * The buyer has a reservation price: what the building is worth to them, which
 * is what it appraises at, adjusted for how badly the market wants product
 * right now and for who they turned out to be. Counter inside it and they take
 * it. Counter a little over and they split the difference, because a deal in
 * hand is worth the last two per cent. Counter well over and they are gone —
 * and if they came to you unbidden, so is the whole approach.
 *
 * One round per offer. Grinding is not a mechanic.
 */
export function counterSale(
  s: GameState, parcels: ParcelTable, bbl: string, price: number,
): { s: GameState; err?: string; msg?: string } {
  const h0 = s.holdings[bbl];
  if (!h0?.sale?.offer) return { s, err: "There is no offer to counter." };
  if (h0.sale.offer.countered) return { s, err: "You have already been back to them once on this offer." };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const px = Math.round(price);
  const next = clone(s);
  const h = next.holdings[bbl]!;
  const sale = h.sale!;
  const offer = sale.offer!;
  if (px <= offer.price) return { s, err: "That is not a counter — it is an acceptance at a worse price." };

  const value = ownedHoldingValue(next, parcels, h);
  // how far a buyer will stretch past appraisal: a boom with open credit buys
  // aggressively, a downturn with shut credit does not buy at all
  const hot = next.econ.phase === "expansion" || next.econ.phase === "peak";
  const money = Math.max(0.4, next.econ.creditIdx ?? 1);
  const stretch = (hot ? 1.10 : 0.99) * (0.94 + 0.12 * money);
  const reservation = Math.max(offer.price, Math.round(value * stretch * rrange(next, 0.97, 1.05)));

  if (px <= reservation) {
    const was = offer.price;
    offer.price = px;
    offer.countered = true;
    offer.expiresM = next.month + 2;
    next.news.unshift({
      q: next.month, kind: "deal",
      text: `They took your counter at ${rec.address}: $${(px / 1e6).toFixed(2)}M, up from $${(was / 1e6).toFixed(2)}M.`,
    });
    return { s: next, msg: `Countered and taken — $${(px / 1e6).toFixed(2)}M.` };
  }
  if (px <= reservation * 1.06) {
    const split = Math.round((px + reservation) / 2);
    offer.price = split;
    offer.countered = true;
    offer.expiresM = next.month + 2;
    next.news.unshift({
      q: next.month, kind: "deal",
      text: `They came back at ${rec.address}: $${(split / 1e6).toFixed(2)}M and no further. Good until ${monthLabel(offer.expiresM)}.`,
    });
    return { s: next, msg: `They split it — $${(split / 1e6).toFixed(2)}M.` };
  }
  // too far. They are gone.
  const wasUnsolicited = sale.unsolicited;
  delete sale.offer;
  if (wasUnsolicited) delete h.sale;
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `Your counter at ${rec.address} ended it — they walked.`
      + (wasUnsolicited ? " They were never on the market for it; they just wanted the building." : ""),
  });
  return { s: next, msg: "They walked." };
}

export function tickSales(s: GameState, parcels: ParcelTable, adjacency: Adjacency | null = null) {
  for (const h of Object.values(s.holdings)) {
    // UNSOLICITED APPROACHES. Nobody in this business only sells when they
    // decide to — the phone rings on the building you were not thinking about,
    // usually at a number that is almost enough. Holding becomes a decision
    // rather than the absence of one.
    if (!h.sale && !s.developments[h.bbl]) {
      const rec0 = resolveRec(parcels, s, h.bbl);
      // RARE, AND RARE ACROSS THE WHOLE BOOK. The per-building odds were 1% a
      // month in a boom, which sounds small until you own twenty buildings and
      // it becomes a call every three months, then every six weeks as the book
      // grows — the phone ringing constantly is not the feeling. It should be
      // the unusual event it is in life: a handful of times in a career, on the
      // building you were not thinking about.
      //
      // So: a fifth of the old per-building rate, only one live approach at a
      // time across the portfolio, and a cooling-off period afterwards. The
      // odds no longer scale with how much you own.
      const anyLive = Object.values(s.holdings).some((x) => x.sale?.unsolicited)
        || (s.portfolioSale?.bbls.includes(h.bbl) ?? false);
      const quiet = s.month - (s.lastUnsolicitedM ?? -60) > 30;
      if (rec0 && s.month - h.boughtM > 18 && !anyLive && quiet) {
        const hot = s.econ.phase === "expansion" || s.econ.phase === "peak";
        const money = Math.max(0.4, s.econ.creditIdx ?? 1);
        const p = (hot ? 0.0020 : 0.0006) * money * (1 + rec0.demandScore / 140);
        if (rng(s, "sales") < p) {
          s.lastUnsolicitedM = s.month;
          const v = ownedHoldingValue(s, parcels, h);
          // WHO IS CALLING, AND WHY.
          //
          // "An unsolicited offer" arrived from nobody, for no reason, at a
          // number drawn out of the phase. That is a dice roll wearing a
          // sentence. Every real approach has a name attached and a motive
          // behind it, and the motive is the whole content of the call: the
          // firm that owns the two lots either side of you is not paying the
          // same number as a fund rebalancing into your asset class, because
          // they are not buying the same thing. They are buying the block.
          const bidder = unsolicitedBidder(s, parcels, adjacency, rec0, h);
          const px = Math.round(v * bidder.mult * (hot ? rrange(s, 1.00, 1.10, "sales") : rrange(s, 0.86, 0.98, "sales")));
          h.sale = { ask: px, listedM: s.month, unsolicited: true };
          h.sale.offer = { price: px, expiresM: s.month + 2, from: bidder.name };
          s.news.unshift({
            q: s.month, kind: "deal",
            text: `${bidder.name} rang about ${rec0.address}: $${(px / 1e6).toFixed(2)}M, `
              + `${px >= v ? `${Math.round((px / Math.max(1, v) - 1) * 100)}% over` : `${Math.round((1 - px / Math.max(1, v)) * 100)}% under`} appraisal. `
              + `${bidder.why} It's good for two months.`,
          });
        }
      }
    }
    const sale = h.sale;
    if (!sale) continue;
    // The date everybody was told about arrives and the bids land at once.
    if (sale.callM !== undefined && s.month >= sale.callM) runCallForOffers(s, parcels, h);
    // A bid list is a decision sitting on your desk, not a queue to be topped
    // up: while it is live nothing else happens to this building.
    if (sale.bids && !sale.bids.length) {
      // Nobody bid. The campaign is over; the building stays on the market the
      // quiet way, because a late call from somebody who missed the date is a
      // real thing and the alternative is a listing that can never sell.
      delete sale.bids;
      sale.mode = "quiet";
    }
    if (sale.bids?.length) {
      // …but it goes stale. Nobody holds a number open forever.
      if (s.month - sale.listedM > 14) {
        const rec0 = resolveRec(parcels, s, h.bbl);
        delete sale.bids;
        delete h.sale;
        s.news.unshift({
          q: s.month, kind: "warn",
          text: `The bids on ${rec0?.address ?? h.bbl} have expired. You sat on the list too long and the buyers moved on.`,
        });
      }
      continue;
    }
    if (sale.offer && s.month > sale.offer.expiresM) {
      const rec0 = resolveRec(parcels, s, h.bbl);
      const px = sale.offer.price;
      delete sale.offer;
      if (sale.unsolicited) delete h.sale;      // they were never on the market
      // A LAPSE USED TO BE SILENT. Deferred the card, or pop-ups off, and the
      // offer vanished with no tape line — so "I never got an offer" and
      // "I got one and it expired unread" were the same experience.
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `The $${(px / 1e6).toFixed(2)}M offer on ${rec0?.address ?? h.bbl} lapsed unanswered.`
          + (sale.unsolicited || !h.sale
            ? " They were never on the market for it."
            : " The listing is still live — cut the ask or wait for the next call."),
      });
      continue;
    }
    if (sale.unsolicited && !sale.offer) { delete h.sale; continue; }
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    if (sale.offer) {
      const value = ownedHoldingValue(s, parcels, h);
      if (sale.offer.price < sale.ask && sale.ask / Math.max(1, value) < 1.1 && rng(s, "sales") < 0.12) {
        const bumped = Math.min(sale.ask, Math.round(sale.offer.price * rrange(s, 1.02, 1.06, "sales")));
        if (bumped > sale.offer.price) {
          sale.offer = { price: bumped, expiresM: s.month + 2 };
          s.news.unshift({
            q: s.month, kind: "deal",
            text: `A second bidder surfaced at ${rec.address} — the offer moves to $${(bumped / 1e6).toFixed(2)}M.`,
          });
        }
      }
      continue;
    }
    // THE BOOK IS STILL OUT. ParcelDesk promises nothing happens until offers
    // are due — and a quiet offer landing mid-campaign used to leave both a
    // frozen phone call and a bid list on the same building.
    if (sale.callM !== undefined && s.month < sale.callM) continue;
    const value = ownedHoldingValue(s, parcels, h);
    const ratio = sale.ask / Math.max(1, value);
    // WHO IS IN THE ROOM, NOT WHICH LABEL THE MONTH CARRIES.
    //
    // This read `expansion ? 1.3 : recession ? 0.5 : 1`, so PEAK AND RECOVERY
    // both fell through to 1.0 — and a market peak is the moment of maximum
    // liquidity in a real cycle, when capital is most abundant and most
    // confident and volume is at its highest.
    //
    // Measured as a HAZARD — offers arriving per building-month on the market,
    // bucketed by that month's phase, which is the only read with no
    // survivorship in it and nothing outliving its own label:
    //
    //                  constants     derived
    //   expansion         3.53%       4.09%   a month
    //   peak              1.88%       3.95%
    //   recession         0.90%       1.91%
    //   recovery          2.45%       2.71%
    //   expansion/recession  3.92x       2.14x
    //
    // Selling into the top of the market drew offers at HALF the rate of the
    // expansion that led to it. And the cyclical swing was 3.92x, against a
    // business where transaction volume roughly halves in a downturn.
    //
    // `marketAppetite` is the quantity this wanted all along: it aggregates who
    // actually has dry powder, scaled by the credit window, normalised so a
    // healthy street reads 1.0 — and `bidOdds` in this same file already uses
    // it for exactly this judgement, which is how much competition a seller
    // faces. Three hand-set constants become one number the engine already
    // computes, the peak stops being punished, and the swing lands at 2.14x.
    //
    // A NOTE ON HOW THIS WAS FOUND, because the first two instruments lied.
    // Timing episodes by the phase they OPENED in said peak was slow, and that
    // is contaminated: the median wait is 16 months and a peak is followed by a
    // bust, so a peak listing rides into it. Timing them by the phase they
    // CLOSED in said every phase was identical, and that is worse — it
    // conditions on success, so the recession column holds only the buildings
    // that managed to sell in a recession. Only the hazard asks the question
    // without answering part of it first. See test/liquidity.mjs.
    const phaseAdj = marketAppetite(s);
    const staleness = Math.min(0.06, (s.month - sale.listedM) * 0.004); // word gets around
    const p = Math.max(0.01, Math.min(0.5, (0.55 - 0.42 * ratio) * phaseAdj + staleness));
    if (rng(s, "sales") < p) {
      const bid = Math.min(sale.ask, value * (0.9 + rng(s, "sales") * 0.13));
      sale.offer = { price: Math.round(bid), expiresM: s.month + 2 };
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `Offer in: $${(sale.offer.price / 1e6).toFixed(2)}M for ${rec.address} (ask $${(sale.ask / 1e6).toFixed(2)}M). Good for two months.`,
      });
    }
  }
}

// Monthly: other buyers work the same tape you do. Fairly-priced listings get
// taken out from under you — dawdle and the deal is gone.
export function tickListingAbsorption(s: GameState, parcels: ParcelTable) {
  // settle any private windows that closed with nothing to show for them
  tickEarlyLooks(s);
  const base = s.econ.phase === "expansion" ? 0.10 : s.econ.phase === "peak" ? 0.07 : s.econ.phase === "recovery" ? 0.05 : 0.02;
  const survivors: typeof s.listings = [];
  for (const li of s.listings) {
    const rec = resolveRec(parcels, s, li.bbl);
    if (!rec) continue;
    // A building you are under contract on is not on the market. Somebody else
    // buying it out from under a signed contract is not competition, it is a
    // bug — and it was the one thing that could make the funding window
    // unwinnable through no fault of the player.
    const talk = s.talks?.[li.bbl];
    if (talk?.agreed) { survivors.push(li); continue; }
    // A first look is yours alone: nobody else in town has heard the address yet.
    if (li.earlyUntilM !== undefined && s.month < li.earlyUntilM) { survivors.push(li); continue; }
    const value = assetValue(rec, s.econ, gradeOf(s, rec));
    const ratio = li.ask / Math.max(1, value);
    const priceFactor = Math.max(0.3, Math.min(1.8, 1.9 - ratio)); // bargains go first
    // A LIVE CONVERSATION IS NOT A CLAIM ON THE BUILDING.
    //
    // Measured over three fifty-year runs with three deals on the table at
    // once: a listing was taken out from under an unagreed negotiation ZERO
    // times. Nobody ever competed for a specific building the player was
    // chasing, so the dominant play was to grind the counter loop for free.
    // Your number is on the street the day you make it, and a broker with a
    // live bid in hand rings everybody else in town — which is why an open
    // negotiation makes a building MORE likely to go, not less.
    // A RECEIVER'S BOOK IS NOT A PRIVATE SALE — IT IS A PROCESS.
    //
    // A failed firm's buildings came onto the tape at a twenty-five per cent
    // haircut and cleared at exactly that haircut, every time, no matter how
    // many firms in town had the cash to turn up. That is not what happens to
    // distressed paper: a receiver's job is to run a marketing period and take
    // the best number in the room, and a building marked a quarter under fair
    // value is precisely the thing every opportunistic shop with dry powder
    // shows up for. So the discount is now a STARTING point that has to
    // survive the depth of the bid.
    //
    // What this preserves is the thing that makes distress worth chasing: when
    // credit is shut and nobody else can close, the depth is one or zero and
    // the discount stands. The player's edge in a crisis is not that the
    // receiver likes them; it is that they are the only cheque in the room.
    const depth = li.distress ? qualifiedBuyers(s, rec, li.ask) : 0;
    const contested = li.distress && depth > 1 ? 1 + 0.22 * Math.min(4, depth - 1) : 1;
    if (rng(s, "sales") < base * priceFactor * contested * Math.max(0.25, marketAppetite(s)) * (talk ? 1.7 : 1)) {
      // And whoever comes over the top pays for the privilege of ending it.
      let px = talk ? Math.max(li.ask, Math.round(talk.yourPrice * rrange(s, 1.04, 1.12, "sales"))) : li.ask;
      if (!talk && li.distress && depth > 1) {
        // Each additional real bidder closes part of the gap between the
        // receiver's number and what the building is worth. Five serious
        // bidders take most of it; two take a fifth of it; one takes none.
        const gap = Math.max(0, value / Math.max(1, li.ask) - 1);
        px = Math.round(li.ask * (1 + gap * Math.min(0.85, 0.22 * (depth - 1))));
      }
      // Somebody takes it, and somebody has a name. Losing the same corner to
      // the same firm twice in a year is information; "another buyer" was not.
      const buyer = rivalBuys(s, parcels, rec, px);
      if (talk && buyer) {
        delete s.talks![li.bbl];
        if (!Object.keys(s.talks!).length) delete s.talks;
        s.beaten = s.beaten ?? [];
        s.beaten.unshift({ bbl: li.bbl, firmId: buyer.id, firm: buyer.name, m: s.month, yours: talk.yourPrice, theirs: px });
        if (s.beaten.length > 24) s.beaten.length = 24;
        tie(s, buyer.id).beats++;
        s.lastTradeM = s.lastTradeM ?? {};
        s.lastTradeM[li.bbl] = s.month;
        s.news.unshift({
          q: s.month, kind: "warn",
          text: `${buyer.name} came over the top of you at ${rec.address} — ${(px / 1e6).toFixed(2)}M against your ${(talk.yourPrice / 1e6).toFixed(2)}M. `
            + `Your number was on the street the day you made it. It is their corner now.`,
        });
        continue;
      }
      // A BUILDING THAT SELLS STAYS SOLD. Absorption used to take the listing
      // off the tape and record nothing, so refreshListings could pick the
      // same parcel again next quarter — 68 E 10th St sold "to a buyer from
      // out of town" thirty-one times in fifty years, and 116 W 4th St
      // twenty-nine. Stamp the trade and it is somebody's building now.
      s.lastTradeM = s.lastTradeM ?? {};
      s.lastTradeM[li.bbl] = s.month;
      if (buyer) {
        // YOU DID NOT WATCH IT HAPPEN.
        //
        // This printed on every trade a named firm made anywhere in the city:
        // 162 lines a fifty-year run, of which 89% concerned a building the
        // player had never looked at, on a block they owned nothing on, bought
        // by a firm they had never dealt with. That is the precise definition
        // of wallpaper. The trade still goes on the comps sheet — recordComp
        // runs inside rivalBuys — which is where "a building traded somewhere"
        // belongs. The news feed is for things that are about you.
        const yours = new Set(Object.values(s.holdings).map((h) => resolveRec(parcels, s, h.bbl)?.block));
        const stake = yours.has(rec.block) || !!s.street?.[buyer.id];
        if (stake) {
          s.news.unshift({
            q: s.month, kind: "info",
            text: yours.has(rec.block)
              ? `${buyer.name} took ${rec.address} at ${(px / 1e6).toFixed(2)}M — that is your block.`
              : `${buyer.name} took ${rec.address} at ${(px / 1e6).toFixed(2)}M. You have dealt with them before.`,
          });
        }
      } else {
        // AND THE BUYER HAS A NAME. "A buyer from out of town" is what a
        // newspaper writes when it has not made the call; it is not what a
        // newspaper writes eight times a year. These are real counterparties
        // with an address, and the trade goes on the comps sheet like any
        // other, which is what makes an anonymous market legible instead of
        // just noisy.
        const b = OUT_OF_TOWN[Math.floor(rng(s, "sales") * OUT_OF_TOWN.length)];
        // AND THE SELLER LOSES THE BUILDING. Recording the comp without
        // conveying the deed left the seller owning a building they had just
        // sold, free to list it again next quarter and print the sale a second
        // time, and a third. See sellToOutsider.
        sellToOutsider(s, li.bbl, li.ask);
        recordComp(s, rec, li.ask, b, "a listed seller", li.distress, initialCondition(rec));
        // THE TAPE IS NOT NEWS. Measured over 25 years, "Sold: X went to a 1031
        // buyer at $Y" was the single most common line in the paper — 23.6 news
        // items a year and ordinary trades were the largest bucket of them,
        // which buries the sector turn and the bank failure that actually
        // matter. Nothing is lost by dropping them: `recordComp` above files
        // every one of these on the comps tape, which is where a buyer reads
        // closed prices anyway, and it is the tape that prices the market.
        //
        // Two kinds of trade stay news, and they are the two a principal would
        // actually be told about. One you have a stake in: somebody just set a
        // price in a submarket where you own something, which is the comp your
        // own building will be marked against. And one that is a RECORD — the
        // biggest number the market has seen lately, which is news in any town.
        const mine = Object.keys(s.holdings).some((b2) => {
          const r2 = resolveRec(parcels, s, b2);
          return r2 && r2.district === rec.district;
        });
        const record = !(s.comps ?? []).some((c) => c.bbl !== li.bbl && c.price > li.ask);
        if (mine || record) {
          s.news.unshift({
            q: s.month, kind: "info",
            text: record && !mine
              ? `A record: ${rec.address} went to ${b} at $${(li.ask / 1e6).toFixed(2)}M, the largest trade on the tape.`
              : `Sold in ${rec.district}: ${rec.address} went to ${b} at $${(li.ask / 1e6).toFixed(2)}M — a comp your own building will be read against.`,
          });
        }
      }
      continue; // absorbed — off the tape
    }
    survivors.push(li);
  }
  s.listings = survivors;
}

// Toggle a leasing broker exclusive on an owned commercial building.
export function setBroker(s: GameState, parcels: ParcelTable, bbl: string, on: boolean): { s: GameState; err?: string } {
  const h = s.holdings[bbl];
  const rec = resolveRec(parcels, s, bbl);
  if (!h || !rec) return { s, err: "You don't own that." };
  if (h.groundLeased) return { s, err: "The ground lessee lets that building — you have no exclusive to grant." };
  if (on && !isCommercial(rec)) return { s, err: "Brokers work commercial space — multifamily leases itself." };
  const next = clone(s);
  const nh = next.holdings[bbl];
  if (on) nh.broker = true; else delete nh.broker;
  next.news.unshift({
    q: next.month, kind: "info",
    text: on
      ? `Leasing exclusive signed at ${rec.address} — the house works the phones for nothing and takes 6% of the base rent over the term of everything it signs, at the signing.`
      : `Broker dismissed at ${rec.address} — what you sign from here costs the ordinary 4% on a new lease, 2% on a renewal.`,
  });
  return { s: next };
}

/**
 * THE EXCLUSIVE, ACROSS THE WHOLE BOOK.
 *
 * The same argument as `setOpsPolicy`: whether the house works your phones is a
 * standing decision about how you run buildings, and a principal with twenty
 * deeds takes it once. Doing it per building meant twenty clicks for one policy,
 * and it is the same fee on every one of them.
 *
 * Multifamily is skipped rather than refused, because a mixed book is the normal
 * case and an error on the one apartment block should not stop the other
 * nineteen — the engine already says a broker does not work flats.
 */
export function setBrokerAll(s: GameState, parcels: ParcelTable, on: boolean): { s: GameState; err?: string; msg?: string } {
  const next = clone(s);
  let n = 0, skipped = 0;
  for (const h of Object.values(next.holdings)) {
    const rec = resolveRec(parcels, next, h.bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    // Ground-leased fees look built after the lessee opens — they are not yours to let.
    if (h.groundLeased) { skipped++; continue; }
    if (!isCommercial(rec)) { skipped++; continue; }
    if (on === !!h.broker) continue;
    if (on) h.broker = true; else delete h.broker;
    n++;
  }
  if (!n) return { s, err: on ? "Every commercial building already has the house on it." : "Nobody is on an exclusive." };
  next.news.unshift({
    q: next.month, kind: "info",
    text: on
      ? `Leasing exclusive signed across the book — ${n} building${n === 1 ? "" : "s"} to the house, no retainer, 6% of the base rent over the term of everything they sign.`
        + (skipped ? ` The ${skipped} residential building${skipped === 1 ? "" : "s"} ${skipped === 1 ? "is" : "are"} not on it: flats let themselves.` : "")
      : `Exclusives ended on ${n} building${n === 1 ? "" : "s"}. What you sign from here costs the ordinary 4% on a new lease, 2% on a renewal.`,
  });
  return { s: next, msg: on ? `${n} building${n === 1 ? "" : "s"} on the house.` : `${n} exclusive${n === 1 ? "" : "s"} ended.` };
}

export function startRenovation(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; err?: string } {
  const h = s.holdings[bbl];
  if (!h) return { s, err: "You don't own that parcel." };
  const rec = resolveRec(parcels, s, bbl);
  if (h.groundLeased || s.groundLeases?.[bbl]) {
    return { s, err: "The ground lessee controls the improvement — you do not gut their building." };
  }
  if (!rec || rec.class === "land" || !rec.bldgArea) return { s, err: "Nothing to renovate on this lot." };
  if (h.condition === "good") return { s, err: "Already in top condition." };
  if (h.renovatingUntilM !== undefined) return { s, err: "Crews are already on site." };
  if (isCommercial(rec)) {
    const leased = h.tenants.reduce((sum, t) => sum + t.sf, 0);
    if (leased / rec.bldgArea > 0.35) {
      return { s, err: "Too much of the building is under lease to gut it — let the roll burn down below 35% first." };
    }
  }
  const cost = renovationCost(rec, s.econ);
  if (s.cash < cost) return { s, err: `Renovation costs $${(cost / 1e6).toFixed(2)}M cash — you're short.` };
  const next = clone(s);
  next.cash -= cost;
  logBooks(next, "capex", cost);
  const nh = next.holdings[bbl];
  nh.renovatingUntilM = next.month + RENO_MONTHS;
  nh.tenants = []; // remaining tenants are bought out as part of the job
  if (rec.class === "multifamily") nh.occ = 0;
  next.lois = next.lois.filter((l) => l.bbl !== bbl);
  next.news.unshift({
    q: next.month, kind: "info",
    text: `Scaffolding up at ${rec.address} — $${(cost / 1e6).toFixed(2)}M gut renovation, ${RENO_MONTHS} quarters.`,
  });
  return { s: next };
}

export { assetValue };

// ---------------------------------------------------------------- acquisition


/**
 * GOING BACK TO ONE BIDDER.
 *
 * Best-and-final puts the whole list in the room on the same day and is the
 * blunt instrument. This is the other move every seller makes: the private
 * call to the one number you would take five per cent more of. It risks
 * exactly that bidder — the rest of the list never hears about it — and a
 * credible buyer who is already at their limit simply leaves.
 *
 * One per bid. Grinding the same buyer is not negotiating.
 */
export function counterBid(
  s: GameState, parcels: ParcelTable, bbl: string, index: number, price: number,
): { s: GameState; err?: string; msg?: string } {
  const h0 = s.holdings[bbl];
  const b0 = h0?.sale?.bids?.[index];
  if (!h0?.sale || !b0) return { s, err: "There is no bid there." };
  if (b0.dropped) return { s, err: "They already walked." };
  if (b0.countered) return { s, err: "You have been back to them once. That is what the etiquette allows." };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const px = Math.round(price);
  if (px <= b0.price) return { s, err: "That is not a counter — it is an acceptance at a worse price." };

  const next = clone(s);
  const bid = next.holdings[bbl]!.sale!.bids![index];
  bid.countered = true;

  // How far this buyer will actually stretch. Credibility is the whole read:
  // the institution that bid with a committee behind it has room, and the
  // syndicate that bid to be in the running does not.
  const value = ownedHoldingValue(next, parcels, next.holdings[bbl]!);
  const hot = next.econ.phase === "expansion" || next.econ.phase === "peak";
  const headroom = (0.02 + b0.credibility * 0.09) * (hot ? 1.25 : 0.85);
  const limit = Math.round(Math.max(b0.price, Math.min(value * 1.18, b0.price * (1 + headroom))));

  if (px <= limit) {
    bid.price = px;
    bid.note = "Came up on a private call.";
    next.news.unshift({
      q: next.month, kind: "deal",
      text: `${b0.name} came up to $${(px / 1e6).toFixed(2)}M at ${rec.address}, from $${(b0.price / 1e6).toFixed(2)}M.`,
    });
    return { s: next, msg: `They came up — $${(px / 1e6).toFixed(2)}M.` };
  }
  if (px <= limit * 1.05) {
    const split = Math.round((px + limit) / 2);
    bid.price = split;
    bid.note = "Split the difference and stopped.";
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${b0.name} split it at ${rec.address}: $${(split / 1e6).toFixed(2)}M and no further.`,
    });
    return { s: next, msg: `They split it — $${(split / 1e6).toFixed(2)}M.` };
  }
  bid.dropped = true;
  bid.note = "Walked when you went back to them.";
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `${b0.name} walked at ${rec.address}. You went back to them for $${(px / 1e6).toFixed(2)}M and they were done.`,
  });
  return { s: next, msg: `${b0.name} walked.` };
}

/**
 * A NEW NUMBER ON THE SAME SIGN.
 *
 * Repricing used to mean delisting and relisting, which throws away the
 * campaign, the bid list and every month the building has been on the market.
 * No seller does that; they ring the broker. What it costs is what it costs in
 * life: a cut tells every bidder you are motivated, and a raise mid-campaign
 * loses the buyers who were nearly there.
 */
export function repriceListing(
  s: GameState, parcels: ParcelTable, bbl: string, ask: number,
): { s: GameState; err?: string; msg?: string } {
  const h0 = s.holdings[bbl];
  if (!h0?.sale) return { s, err: "That is not on the market." };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const px = Math.round(ask);
  if (!Number.isFinite(px) || px <= 0) return { s, err: "Name a real number." };
  if (px === h0.sale.ask) return { s, err: "That is the number you are already asking." };

  const next = clone(s);
  const sale = next.holdings[bbl]!.sale!;
  const was = sale.ask;
  const cut = px < was;
  sale.ask = px;
  // A cut restarts the clock the market judges you on — a repriced listing is
  // a fresher listing, and that is most of why sellers cut.
  if (cut) sale.listedM = next.month;
  // Raising mid-campaign costs you the bidders who were close to the old ask.
  if (!cut && sale.bids?.length) {
    for (const b of sale.bids) {
      if (b.dropped) continue;
      if (b.price < px * 0.9 && rng(next) < 0.5) { b.dropped = true; b.note = "Left when the ask went up."; }
    }
  }
  if (!cut && sale.offer && sale.offer.price < px * 0.92 && rng(next) < 0.45) {
    delete sale.offer;
  }
  next.news.unshift({
    q: next.month, kind: cut ? "info" : "warn",
    text: cut
      ? `Cut the ask at ${rec.address} to $${(px / 1e6).toFixed(2)}M from $${(was / 1e6).toFixed(2)}M. The phone starts again — and everybody now knows you want out.`
      : `Raised the ask at ${rec.address} to $${(px / 1e6).toFixed(2)}M from $${(was / 1e6).toFixed(2)}M. Anyone who was close to the old number has other buildings to look at.`,
  });
  return { s: next, msg: cut ? "Repriced down." : "Repriced up." };
}
