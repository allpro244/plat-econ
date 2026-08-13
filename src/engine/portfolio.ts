// SELLING MORE THAN ONE BUILDING AT A TIME.
//
// Everything on this desk has been a one-asset business: one sign, one run,
// one buyer, one closing. That is how a broker sells a building and it is not
// how anybody exits a book. The two transactions that actually move real
// estate at scale are the portfolio trade and the entity trade, and both work
// on a principle that is almost the opposite of a single sale:
//
//   YOU ARE NOT SELLING THE AVERAGE. YOU ARE SELLING THE WORST ONE.
//
// A bundle prices off its weakest member, because the buyer is being made to
// take the half-empty office to get the two stabilised apartment blocks, and
// they will price that risk rather than accept it. Which is exactly why
// sellers bundle: it is the only way the half-empty office ever trades at all.
// The premium for scale is real but small — an institution will pay a couple
// of points for size, homogeneity and one management platform. The discount
// for a mixed bag is much larger than the premium, and the discount for size
// itself past a certain cheque is larger still, because in a city this size
// there are perhaps four buyers who can write it.
//
// So the decision this creates is a genuine one and it is not obvious: sell
// them one at a time and take three years and the best price on each, or
// clear the whole position in a quarter and pay for the privilege. In a
// falling market the second one is right, and it stops being right about six
// months after everybody has worked that out.
import type { ParcelTable } from "@/data/types";
import type { GameState, Holding } from "./types";
import { logBooks, monthLabel, raiseAlert, cloneState} from "./types";
import { firmShort } from "./firm";
import { rng, rrange } from "./market";
import { sweepLocIdleCash } from "./credit";
import { ownedHoldingValue, ownedHoldingNoiYr, resolveRec, holdingNOIYr, asIfOwned } from "./value";
import { depositsOn } from "./leasing";
import { useSf } from "./mix";
import { prepayPenalty } from "./debt";
import { recordComp } from "./comps";
import { saleTaxQuote, EXCHANGE_WINDOW_M, transferGroundLeaseOffBook } from "./actions";
import { releaseCost } from "./facility";
import { sponsorStanding } from "./sponsor";

const clone = (s: GameState): GameState => cloneState(s);

/** How full a building physically is, counting flats and commercial together. */
function occOf(rec: { bldgArea: number }, h: Holding): number {
  if (!rec.bldgArea) return 0;
  const comm = h.tenants.reduce((a, t) => a + t.sf, 0);
  const res = useSf(rec as never, "multifamily") * (h.occ ?? 0);
  return Math.min(1, (comm + res) / rec.bldgArea);
}
const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

/** How long a portfolio stays on the market before the process goes stale. */
const RUN_M = 9;

/**
 * The desks that write portfolio cheques in this town.
 *
 * Ordered loosely by patience (how close to indicative they will bid). The
 * floor used to be $6M — Bellwether — so a two-building book under that mark
 * could sit the full nine months with a rolled die and an empty pool, while
 * the quote lied that "1 buyer" could fund it. Riverside is the private desk
 * that still writes smaller tickets; below its min there is simply no market
 * for a bundle, and the desk has to say so.
 */
const BUYERS = [
  { name: "Kestrel Core Fund", min: 45_000_000, patience: 1.04 },
  { name: "Marchpane Institutional", min: 30_000_000, patience: 1.02 },
  { name: "Hollis Sterling Partners", min: 12_000_000, patience: 0.98 },
  { name: "The Ashgrove Trust", min: 8_000_000, patience: 0.95 },
  { name: "Bellwether Opportunity", min: 6_000_000, patience: 0.88 },
  { name: "Riverside Private Capital", min: 2_000_000, patience: 0.84 },
];

/** How many named buyers can underwrite a book of this size. */
export function portfolioBuyerDepth(sumOfParts: number): number {
  const raw = BUYERS.filter((b) => sumOfParts >= b.min).length;
  // Past a certain cheque the room thins — the same three institutions who
  // could write $40M cannot all write $200M in the same city the same year.
  const crowdedOut = sumOfParts > 200_000_000 ? 2 : sumOfParts > 90_000_000 ? 1 : 0;
  return Math.max(0, raw - crowdedOut);
}

export interface PortfolioQuote {
  /** What the buildings are worth one at a time, added up. */
  sumOfParts: number;
  /** What a bundle of exactly these buildings is worth. */
  indicative: number;
  /** indicative ÷ sumOfParts − 1. Usually negative, and that is the point. */
  spreadPct: number;
  /** Every adjustment, in the words a broker would use. */
  why: { label: string; pct: number }[];
  /** Roughly how many buyers in this city can write this cheque. */
  depth: number;
  count: number;
  /**
   * THE NUMBER THE BUYER CONVERTS THE ASK INTO, for the bundle as one ticket.
   *
   * A portfolio is quoted as a cap rate, not as a price — an institution's
   * committee paper has one going-in yield on it and the price is whatever
   * that yield implies. The desk was showing the ask in dollars and the spread
   * against the sum of the parts, neither of which is the number the buyer is
   * actually underwriting to, so a player could take a book to market with no
   * idea whether they were asking a 5% or an 8%.
   *
   * Aggregate NOI, not an average of per-building cap rates: yields do not
   * average, and blending them by anything other than income is one of the
   * standard ways to be wrong about a portfolio. Struck the same way the
   * single-building card strikes it — re-assessed AT THE ASK through
   * `asIfOwned`, because the tax bill a buyer inherits is set by what they pay
   * and not by what the seller paid.
   */
  noiYr: number;
  /** The going-in cap the CURRENT ask implies, in percent. 0 when unknowable. */
  capAtAsk(ask: number): number;
}

/**
 * WHAT A BUNDLE IS WORTH, and why it is not the sum of the parts.
 *
 * Each term below is a real thing an acquisitions committee does to a rent
 * roll, and every one of them is readable in the UI before you commit, because
 * a discount you cannot see coming is a punishment rather than a decision.
 */
export function portfolioQuote(s: GameState, parcels: ParcelTable, bbls: string[]): PortfolioQuote {
  const rows = bbls
    .map((b) => ({ bbl: b, h: s.holdings[b], rec: resolveRec(parcels, s, b) }))
    .filter((r) => r.h && r.rec) as { bbl: string; h: Holding; rec: NonNullable<ReturnType<typeof resolveRec>> }[];
  const vals = rows.map((r) => ownedHoldingValue(s, parcels, r.h));
  const sumOfParts = Math.round(vals.reduce((a, v) => a + v, 0));
  const why: { label: string; pct: number }[] = [];
  if (!rows.length || sumOfParts <= 0) {
    return { sumOfParts: 0, indicative: 0, spreadPct: 0, why, depth: 0, count: 0, noiYr: 0, capAtAsk: () => 0 };
  }

  // --- scale ---------------------------------------------------------------
  // An institution pays a little for size: one diligence, one closing, one
  // property-management contract instead of nine. It is worth two or three
  // points and no more, and it is the only term here that is ever positive.
  const scale = Math.min(0.035, 0.006 * Math.log2(Math.max(2, rows.length)) + Math.min(0.018, sumOfParts / 4e9));
  if (rows.length > 1) why.push({ label: `Scale — one diligence, one closing, ${rows.length} deeds`, pct: scale });

  // --- homogeneity ---------------------------------------------------------
  // A clean single-class portfolio in one submarket underwrites itself. A
  // scattered mixed bag is nine separate underwritings sold as one, and the
  // buyer charges for every one of them.
  const byClass = new Map<string, number>();
  const byDistrict = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = r.rec.class;
    byClass.set(k, (byClass.get(k) ?? 0) + vals[i]);
    const d = r.rec.district ?? "?";
    byDistrict.set(d, (byDistrict.get(d) ?? 0) + vals[i]);
  });
  const topClass = Math.max(...byClass.values()) / sumOfParts;
  const topDist = Math.max(...byDistrict.values()) / sumOfParts;
  // 100% one class is clean; a four-way split is a car boot sale
  const mixed = -(1 - topClass) * 0.075 - (1 - topDist) * 0.03;
  if (mixed < -0.002) {
    why.push({
      label: topClass < 0.6
        ? `Mixed asset classes — ${byClass.size} of them, no majority`
        : `Not quite one story — ${(topClass * 100).toFixed(0)}% ${[...byClass.entries()].sort((a, b) => b[1] - a[1])[0][0]}, ${byDistrict.size} districts`,
      pct: mixed,
    });
  }

  // --- THE WEAKEST MEMBER --------------------------------------------------
  // The whole reason a portfolio trade exists. The buyer underwrites the
  // problems, not the average, and the more of the value that sits in a
  // half-empty or tired building the harder the blend gets marked. This is
  // simultaneously why you bundle — that building has no bid on its own — and
  // why it costs you on the ones that did.
  let weak = 0;
  rows.forEach((r, i) => {
    // A performing leased fee is income paper — do not haircut it as a vacant
    // shell just because resolveRec shows the lessee's building empty of YOUR tenants.
    if (r.h.groundLeased) return;
    const built = r.rec.class !== "land" && r.rec.bldgArea > 0;
    const occ = built ? occOf(r.rec, r.h) : 1;
    const share = vals[i] / sumOfParts;
    let d = 0;
    if (built && occ < 0.82) d += (0.82 - occ) * 0.42;
    if (r.h.condition === "standard") d += 0.03;
    if (r.h.condition === "worn") d += 0.09;
    if (r.h.condition === "obsolete") d += 0.20;   // they are pricing a rebuild, not a building
    if (!built) d += 0.06;                       // dirt in an income portfolio is a rounding error nobody wants
    weak += share * d;
  });
  if (weak > 0.002) {
    why.push({ label: "Underwritten off the weakest buildings, not the average", pct: -weak });
  }

  // --- who can actually write this cheque ----------------------------------
  const depth = portfolioBuyerDepth(sumOfParts);
  if (depth <= 0) {
    why.push({
      label: "No buyer in this city can fund a book this small as a portfolio — sell them one at a time",
      pct: -0.08,
    });
  } else {
    const thin = depth === 1 ? -0.06 : depth === 2 ? -0.025 : 0;
    if (thin < 0) {
      why.push({
        label: `Thin bidder pool — ${depth} buyer${depth === 1 ? "" : "s"} in this city can fund it`,
        pct: thin,
      });
    }
  }

  // --- the cycle -----------------------------------------------------------
  // A portfolio bid is a leveraged bid. When the debt markets are shut there
  // is no such thing as a big cheque, at any cap rate — this is the single
  // largest term in a real downturn and the reason distressed sellers sell one
  // building at a time.
  const ci = s.econ.creditIdx ?? 1;
  const credit = -Math.max(0, 1 - ci) * 0.18 - (s.econ.phase === "recession" ? 0.035 : 0);
  if (credit < -0.004) {
    why.push({ label: ci < 0.8 ? "Credit is tight — nobody is funding a portfolio right now" : "Financing markets are soft", pct: credit });
  }

  // --- your name -----------------------------------------------------------
  const st = sponsorStanding(s);
  if (st.advanceCut > 0) {
    why.push({ label: "Your record — buyers price a forced seller", pct: -Math.min(0.05, st.advanceCut * 0.6) });
  }

  // --- how much of your book this is ---------------------------------------
  // Selling everything you own tells the market something, and the market
  // charges you for telling it.
  const bookShare = sumOfParts / Math.max(1, Object.keys(s.holdings).reduce((a, b) => {
    const rec = resolveRec(parcels, s, b); const h = s.holdings[b];
    return a + (rec && h ? ownedHoldingValue(s, parcels, h) : 0);
  }, 0));
  if (bookShare > 0.75 && rows.length >= 3) {
    why.push({ label: "This is essentially your whole book — everybody knows why you are selling", pct: -0.02 });
  }

  // A FLOOR UNDER THE BLEND. Every term above is defensible on its own and
  // they compound: an empty mixed bag, in a crunch, from a sponsor with a
  // record, too big for the room, arrives at eighty points of discount, and
  // there is no such trade. Past about forty points a real seller stops
  // bundling and sells them one at a time, because that is strictly better —
  // so the model has to stop there too. In a genuine crunch the bundle does
  // not get cheaper; it simply gets no bid at all, which is what the arrival
  // rate in tickPortfolio already does.
  const total = Math.max(-0.40, why.reduce((a, x) => a + x.pct, 0));
  const indicative = Math.round(sumOfParts * (1 + total));
  // Income for the bundle, each building re-assessed at its share of the ask.
  // Land and anything unbuilt contributes nothing and is not an error: a site
  // in a portfolio is sold on the dirt, and dividing by an ask that includes it
  // is exactly what depresses a mixed book's quoted yield in life.
  const noiAt = (ask: number) => rows.reduce((a, r, i) => {
    // Ground coupon is deed income even when the resolved class is still land
    // (lessee mid-build) or a vacant shell of theirs.
    if (r.h.groundLeased) return a + Math.max(0, ownedHoldingNoiYr(s, parcels, r.h));
    if (r.rec.class === "land" || !r.rec.bldgArea) return a;
    const share = sumOfParts > 0 ? vals[i] / sumOfParts : 1 / rows.length;
    const px = Math.max(1, Math.round(ask * share));
    const n = holdingNOIYr(r.rec, s.econ,
      asIfOwned(s, r.bbl, px, { roll: r.h.tenants, occ: r.h.occ, cond: r.h.condition }, r.rec), s.month);
    return a + Math.max(0, n);
  }, 0);
  return {
    sumOfParts, indicative, spreadPct: total, why, depth, count: rows.length,
    noiYr: Math.round(noiAt(indicative)),
    capAtAsk: (ask: number) => (ask > 0 ? (noiAt(ask) / ask) * 100 : 0),
  };
}

/** Take a bundle to market. */
export function listPortfolio(
  s: GameState, parcels: ParcelTable, bbls: string[], ask: number,
): { s: GameState; err?: string; msg?: string } {
  if (s.portfolioSale) return { s, err: "You already have a portfolio in the market. One process at a time." };
  const clean = [...new Set(bbls)].filter((b) => s.holdings[b]);
  if (clean.length < 2) return { s, err: "A portfolio is two buildings or more. One building is a listing." };
  if (clean.some((b) => s.workouts?.[b])) {
    return { s, err: "One of these is in default. A lender in a workout controls that deed — clear the file first." };
  }
  // A CROSSED DEED CANNOT BE SOLD IN A BUNDLE. The facility is released one
  // building at a time against payment of its allocated share at a premium —
  // see engine/facility.ts — and a bundle sale settles as one trade with no
  // room for twelve separate release calculations at the same closing. Sell it
  // out of the pool first, or sell it on its own where the release is
  // collected at the table.
  const crossed = clean.filter((b) => s.facility?.bbls.includes(b));
  if (crossed.length > 0) {
    return { s, err: `${crossed.length} of these are pledged to your facility. Release them first, or sell them individually.` };
  }
  const q = portfolioQuote(s, parcels, clean);
  if (ask <= 0) return { s, err: "Name a price." };
  // AN EMPTY ROOM IS NOT A PROCESS. Rolling the arrival die against zero
  // buyers used to burn nine months of silence and then call the book stale —
  // which reads as "the market passed" when the truth is nobody was ever
  // invited. Say so at the door.
  if (q.depth <= 0) {
    return {
      s,
      err: `No buyer in this city can underwrite a ${money(q.sumOfParts)} portfolio. `
        + `Sell them one at a time, or bundle enough value that a private desk will take the ticket `
        + `(roughly $2M of marks and up).`,
    };
  }
  const next = clone(s);
  // A building cannot be in two processes at once.
  for (const b of clean) if (next.holdings[b]?.sale) delete next.holdings[b].sale;
  next.portfolioSale = { bbls: clean, ask: Math.round(ask), listedM: next.month, sumOfParts: q.sumOfParts, bids: [] };
  const eager = Math.min(1, q.indicative / Math.max(1, ask));
  const richAsk = ask > q.indicative * 1.05;
  next.news.unshift({
    q: next.month, kind: "info",
    text: `Took ${clean.length} buildings to market as a portfolio at ${money(ask)} — `
      + `${money(q.sumOfParts)} of individual marks, so you are asking `
      + `${ask >= q.sumOfParts ? "a premium" : `${((1 - ask / q.sumOfParts) * 100).toFixed(0)}% under the sum of the parts`}. `
      + `${q.depth} buyer${q.depth === 1 ? "" : "s"} can fund it. `
      + (richAsk
        ? `The ask sits above what a bundle is indicated at (${money(q.indicative)}) — interest will be thin until you cut it. `
        : eager >= 0.95
          ? `Priced at the indication — expect a call inside a quarter if the book holds. `
          : "")
      + `Indications inside ${RUN_M} months or the process goes stale.`,
  });
  return { s: next, msg: richAsk ? "In the market — ask is rich against the indication." : "In the market." };
}

export function delistPortfolio(s: GameState): GameState {
  const next = clone(s);
  delete next.portfolioSale;
  return next;
}

/** Move the ask. A portfolio that has sat for six months is telling you something. */
export function repricePortfolio(s: GameState, ask: number): { s: GameState; err?: string; msg?: string } {
  if (!s.portfolioSale) return { s, err: "Nothing in the market." };
  if (ask <= 0) return { s, err: "Name a price." };
  const next = clone(s);
  const old = next.portfolioSale!.ask;
  next.portfolioSale!.ask = Math.round(ask);
  // Cutting the number restarts interest; raising it into a live process ends it.
  if (ask > old * 1.02) {
    next.portfolioSale!.bids = [];
    next.news.unshift({
      q: next.month, kind: "warn",
      text: `Raised the portfolio ask to ${money(ask)} mid-process. Every indication in hand just went away — `
        + `moving the goalposts on an institutional buyer is how you get taken off their list.`,
    });
  } else {
    next.portfolioSale!.listedM = next.month - 1;
    next.news.unshift({ q: next.month, kind: "info", text: `Portfolio repriced to ${money(ask)}.` });
  }
  return { s: next, msg: "Repriced." };
}

/** Answer a bid with a number of your own. */
/**
 * HOW MUCH ROOM THIS BUYER HAS ABOVE ITS OWN BID.
 *
 * Every institution used to have the same one — an 11% ceiling, hardcoded and
 * identical for all of them — which made countering a rule to be learnt once
 * rather than a read on the counterparty. Committee-approved numbers are not
 * all the same distance from the opening bid: some desks open near their limit
 * because they want to look serious, some open low because they expect to be
 * countered. Four to sixteen per cent is that spread.
 */
function bidderLimit(s: GameState): number {
  return +(1 + rrange(s, 0.04, 0.16)).toFixed(3);
}

/**
 * ANSWERING A BUNDLE BID, AND THE THREE THINGS A BUYER CAN DO.
 *
 * Reported by the owner: "when you get an offer on your portfolio you have
 * listed, it seems if you counter it that they always reject the counter, no
 * matter what." Confirmed, and it was worse than that. The odds were:
 *
 *     counter +1%    36% they walk        +8%    81% they walk
 *     counter +5%    62% they walk       +11%   100% they walk
 *     anything at or beyond +11%         100%, always, with no exception
 *
 * `give = max(0, 1 - (stretch - 1) / 0.11)` reaches zero at exactly 11% and
 * stays there, so every counter past that point was a certainty rather than a
 * risk. And there were only two outcomes — they move, or they WITHDRAW and the
 * bid is deleted — so a failed counter did not fail, it destroyed the offer.
 *
 * That is not how a bid gets answered. A buyer who will not meet your number
 * usually restates their own and waits; walking away entirely is what happens
 * when you push far past their limit, not when you push past it at all. So
 * there are three outcomes now, which is what the table actually has:
 *
 *   THEY MOVE   inside their limit, and they split the difference.
 *   THEY HOLD   past it but not absurdly. Their number stands and stays on the
 *               table; you have had your go and can still take it.
 *   THEY WALK   far past it, or the bundle was never worth the trouble.
 *
 * And the limit is per-bidder now (see `bidderLimit`), so the question is what
 * THIS buyer will bear rather than what the rule says.
 */
export function counterPortfolio(s: GameState, price: number): { s: GameState; err?: string; msg?: string } {
  const ps = s.portfolioSale;
  const best = ps?.bids?.[0];
  if (!ps || !best) return { s, err: "Nothing to answer." };
  if (best.countered) return { s, err: "You have already been back to them once on this one." };
  const next = clone(s);
  const nb = next.portfolioSale!.bids[0];
  const stretch = price / Math.max(1, best.price);
  nb.countered = true;
  if (stretch <= 1.005) return { s, err: "That is their number. Take it or leave it." };

  const limit = best.limit ?? 1.11;
  if (stretch <= limit) {
    // Inside the committee's room. They still do not simply pay it — they split
    // the difference, which is what the room was for.
    const meet = Math.round(best.price + (price - best.price) * rrange(next, 0.45, 0.9));
    nb.price = meet;
    next.news.unshift({
      q: next.month, kind: "deal",
      text: `${best.name} came up to ${money(meet)} on the portfolio. That is their committee number and there is nothing behind it.`,
    });
    return { s: next, msg: "They moved." };
  }

  // Past the limit. How far past decides whether this is a no or a goodbye —
  // a bundle is a discretionary purchase and there is always another one, but
  // nobody abandons a live file over a few per cent.
  const over = (stretch - limit) / Math.max(0.01, limit - 1);
  if (over < 1 && rng(next) > 0.30) {
    next.news.unshift({
      q: next.month, kind: "warn",
      text: `${best.name} would not chase ${money(price)}. Their ${money(best.price)} stands, and they have told you it is final.`,
    });
    return { s: next, msg: "They held their number." };
  }
  next.portfolioSale!.bids = next.portfolioSale!.bids.filter((b) => b.name !== best.name);
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `${best.name} withdrew from the portfolio rather than chase ${money(price)}. `
      + `A bundle is a discretionary purchase — there is always another one next quarter.`,
  });
  return { s: next, msg: "They walked." };
}

/**
 * CLOSE IT. Every building settles individually, because that is what actually
 * happens at the table: one price for the portfolio, allocated across the
 * deeds pro rata to value, and then nine separate loan payoffs, nine separate
 * gain calculations and nine separate tax bills.
 */
export function acceptPortfolioBid(
  s: GameState, parcels: ParcelTable, exchange = false,
): { s: GameState; err?: string; msg?: string } {
  const ps = s.portfolioSale;
  const bid = ps?.bids?.[0];
  if (!ps || !bid) return { s, err: "No live indication." };
  if (s.month > bid.expiresM) return { s, err: "That indication lapsed." };
  if (exchange && s.exchange) return { s, err: "One exchange at a time — close the live 1031 first." };
  const next = clone(s);
  const live = ps.bbls.filter((b) => next.holdings[b]);
  const marks = live.map((b) => ownedHoldingValue(next, parcels, next.holdings[b]));
  const totalMark = marks.reduce((a, v) => a + v, 0);
  if (totalMark <= 0) return { s, err: "There is nothing left in that portfolio." };

  // Same waterfall as acceptSaleOffer, deed by deed: loan, kicker, break fee,
  // facility release, deposits (including assemblage children). The old path
  // booked kick/break as debtSvc while also netting them out of sold — conserve
  // saw money appear — and skipped release + child deposits entirely.
  let cashToYou = 0, soldGross = 0, feeExp = 0, taxTotal = 0, gainTotal = 0;
  live.forEach((bbl, i) => {
    const h = next.holdings[bbl];
    const rec = resolveRec(parcels, next, bbl)!;
    // PURCHASE PRICE ALLOCATION. The bundle price lands on each deed in
    // proportion to what it was worth, which is how the schedule gets written
    // and why one weak building drags the tax basis of every strong one.
    const price = Math.round(bid.price * (marks[i] / totalMark));
    const { net, gain, tax } = saleTaxQuote(h, price, next);
    const kick = h.loan?.kicker && gain > 0 ? Math.round(gain * h.loan.kicker) : 0;
    const breakFee = h.loan ? prepayPenalty(h.loan, next.month) : 0;
    const release = releaseCost(next, parcels, bbl);
    const toSeller = net - (h.loan?.balance ?? 0) - kick - breakFee - release;
    cashToYou += toSeller;
    soldGross += toSeller + kick + breakFee;
    feeExp += kick + breakFee;
    if (release > 0 && next.facility) {
      next.facility.balance = Math.max(0, next.facility.balance - release);
      next.facility.bbls = next.facility.bbls.filter((b) => b !== bbl);
      if (next.facility.balance <= 0) delete next.facility;
    }
    gainTotal += gain;
    taxTotal += tax;
    next.exits.push({
      bbl, address: rec.address, boughtM: h.boughtM, soldM: next.month,
      price, basis: h.costBasis, gain,
    });
    recordComp(next, rec, price, bid.name, firmShort(next), undefined, h.condition);
    if (next.groundLeases?.[bbl]) transferGroundLeaseOffBook(next, bbl);
    next.cash -= depositsOn(h);
    for (const [child, parent] of Object.entries(next.merged ?? {})) {
      if (parent !== bbl) continue;
      delete next.merged![child];
      next.cash -= depositsOn(next.holdings[child]);
      delete next.holdings[child];
      if (next.workouts?.[child]) delete next.workouts[child];
    }
    next.lastTradeM = next.lastTradeM ?? {};
    next.lastTradeM[bbl] = next.month;
    delete next.holdings[bbl];
    if (next.workouts?.[bbl]) delete next.workouts[bbl];
    next.lois = next.lois.filter((l) => l.bbl !== bbl);
  });
  while (next.exits.length > 200) next.exits.shift();
  next.cash += cashToYou;
  logBooks(next, "sold", soldGross);
  if (feeExp > 0) logBooks(next, "debtSvc", feeExp);
  if (exchange && taxTotal > 0) {
    next.exchange = {
      deferredTax: taxTotal, rolledGain: gainTotal, minPrice: bid.price,
      deadlineM: next.month + EXCHANGE_WINDOW_M,
    };
  } else if (taxTotal > 0) {
    next.cash -= taxTotal;
    next.taxesPaid = (next.taxesPaid ?? 0) + taxTotal;
    logBooks(next, "taxes", taxTotal);
  }
  delete next.portfolioSale;
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Closed the portfolio: ${live.length} buildings to ${bid.name} at ${money(bid.price)}, `
      + `${money(cashToYou)} to you after payoffs. `
      + (exchange
        ? `1031 clock running — redeploy ${money(bid.price * 0.8)} by ${monthLabel(next.month + EXCHANGE_WINDOW_M)} or ${money(taxTotal)} of tax comes due.`
        : taxTotal > 0 ? `${money(taxTotal)} of tax withheld.` : "No gain, no tax."),
  });
  sweepLocIdleCash(next, { announce: true });
  return { s: next, msg: "Portfolio closed." };
}

/**
 * The process, month by month. Indications arrive, they are never as good as
 * the ask, and a bundle nobody bids on is the market telling you what it
 * thinks of the weakest building in it.
 */
export function tickPortfolio(s: GameState, parcels: ParcelTable) {
  const ps = s.portfolioSale;
  if (ps) {
    // buildings can leave the bundle by any route — foreclosure, a child deed
    // folded into an assemblage — and a process on nothing is not a process
    ps.bbls = ps.bbls.filter((b) => s.holdings[b]);
    if (ps.bbls.length < 2) {
      delete s.portfolioSale;
      s.news.unshift({ q: s.month, kind: "warn", text: "The portfolio process collapsed — there are not two buildings left in it." });
    }
  }
  const live = s.portfolioSale;
  if (live) {
    live.bids = (live.bids ?? []).filter((b) => s.month <= b.expiresM);
    const age = s.month - live.listedM;
    if (age > RUN_M && !live.bids.length) {
      delete s.portfolioSale;
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `Nine months and no indication on the portfolio at ${money(live.ask)}. The process is stale — `
          + `every buyer in town has now seen it and passed, which is worth knowing and expensive to have learned.`,
      });
    } else {
      const q = portfolioQuote(s, parcels, live.bbls);
      const pool = BUYERS.filter((b) => q.sumOfParts >= b.min && !live.bids.some((x) => x.name === b.name));
      // No desk left to call — do not burn months on a die that can never land.
      if (!pool.length && !live.bids.length) {
        if (age > 0 && age % 3 === 0) {
          s.news.unshift({
            q: s.month, kind: "warn",
            text: `Still no desk that can fund the portfolio at ${money(q.sumOfParts)} of marks. `
              + `Pull it and sell the deeds one at a time, or the process will go stale on an empty room.`,
          });
        }
      } else {
        const eager = Math.min(1, q.indicative / Math.max(1, live.ask));
        // Interest is a function of how far under the indicative your ask is,
        // and it thins fast the longer it sits.
        const arrive = 0.30 * Math.pow(eager, 3.2) * Math.max(0.25, 1 - age / (RUN_M + 3));
        if (pool.length && rng(s) < arrive && live.bids.length < 3) {
          const who = pool[Math.floor(rng(s) * pool.length)];
          const price = Math.round(Math.min(live.ask, q.indicative * who.patience * rrange(s, 0.88, 1.02)));
          live.bids.push({ name: who.name, price, expiresM: s.month + 3, limit: bidderLimit(s) });
          live.bids.sort((a, b) => b.price - a.price);
          // EVERY indication is a decision with a fuse. The first one answers
          // whether anybody wanted the book; the second and third used to land
          // as news only, so a player with pop-ups off (or who missed the first
          // card) could watch three months of silence and never know a bid was
          // sitting on Deals until it lapsed.
          raiseAlert(s, {
            kind: "portfolio", tone: "good",
            title: `${who.name} has indicated on your portfolio`,
            body: `${money(price)} for the ${live.bbls.length}-building book, `
              + `${((1 - price / Math.max(1, q.sumOfParts)) * 100).toFixed(0)}% inside the sum of the individual marks. `
              + `That spread is what you are paying to clear ${live.bbls.length} buildings in one closing. `
              + `It is on the Deals desk and it lapses ${monthLabel(s.month + 3)}.`,
            detail: money(price),
          });
          s.news.unshift({
            q: s.month, kind: "deal",
            text: `${who.name} indicated ${money(price)} on the portfolio — `
              + `${((1 - price / Math.max(1, q.sumOfParts)) * 100).toFixed(0)}% inside the sum of the individual marks. `
              + `That spread is what you are paying to clear ${live.bbls.length} buildings in one closing.`,
          });
        }
      }
    }
  }

  // --- THE UNSOLICITED APPROACH -------------------------------------------
  // Somebody has been watching you accumulate. Once in a great while an
  // institution comes to you with a number for a coherent slice of the book —
  // never for the whole thing, never for the bad ones, and always for the
  // assets you would least like to part with, because those are the ones worth
  // buying.
  if (!s.portfolioSale && Object.keys(s.holdings).length >= 5 && rng(s) < 0.012) {
    const byClass = new Map<string, string[]>();
    for (const bbl of Object.keys(s.holdings)) {
      if (s.workouts?.[bbl] || s.holdings[bbl].sale) continue;
      const rec = resolveRec(parcels, s, bbl);
      if (!rec || rec.class === "land") continue;
      const h = s.holdings[bbl];
      if (occOf(rec, h) < 0.8) continue;   // they want the good ones
      const arr = byClass.get(rec.class) ?? [];
      arr.push(bbl); byClass.set(rec.class, arr);
    }
    const best = [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    if (best && best[1].length >= 3) {
      const bbls = best[1].slice(0, 6);
      const q = portfolioQuote(s, parcels, bbls);
      const who = BUYERS.filter((b) => q.sumOfParts >= b.min);
      if (who.length) {
        const buyer = who[Math.floor(rng(s) * who.length)];
        // An unsolicited approach is a real bid, not a lowball — they are
        // paying for the right to not compete for it. That premium is the
        // entire reason to answer the phone.
        const price = Math.round(q.indicative * rrange(s, 1.0, 1.09));
        s.portfolioSale = {
          bbls, ask: price, listedM: s.month, sumOfParts: q.sumOfParts, unsolicited: true,
          bids: [{ name: buyer.name, price, expiresM: s.month + 4, limit: bidderLimit(s) }],
        };
        // AN OFFER FOR A BOOK OF BUILDINGS IS NOT A NEWS LINE.
        //
        // This wrote to the feed and stopped, so the single largest unsolicited
        // number the game can put in front of a player arrived as one of a
        // hundred and twenty rolling lines and expired four months later
        // whether or not it was ever read. The alert card already carries a
        // `portfolio` kind — the lender's seizure raises one — and this is the
        // other thing that happens to a book of buildings.
        raiseAlert(s, {
          kind: "portfolio", tone: "good",
          title: `${buyer.name} wants ${bbls.length} of your buildings`,
          body: `They rang unprompted with ${money(price)} for ${bbls.length} of your ${best[0]} buildings, `
            + `${price >= q.sumOfParts ? "above" : `${((1 - price / q.sumOfParts) * 100).toFixed(0)}% inside`} the sum of the `
            + `individual marks. Nobody offers on a portfolio they have not already underwritten. It is on the `
            + `Deals desk, and it lapses ${monthLabel(s.month + 4)}.`,
          detail: money(price),
        });
        s.news.unshift({
          q: s.month, kind: "deal",
          text: `${buyer.name} rang unprompted with ${money(price)} for ${bbls.length} of your ${best[0]} buildings — `
            + `${price >= q.sumOfParts ? "above" : `${((1 - price / q.sumOfParts) * 100).toFixed(0)}% inside`} the sum of the individual marks. `
            + `Nobody offers on a portfolio they have not already underwritten, so this number is real. It is also `
            + `for the buildings you would least like to sell, which is how you know they did the work.`,
        });
      }
    }
  }
}
