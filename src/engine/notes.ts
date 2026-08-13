// BUY THE DEBT.
//
// You can buy buildings. Now you can buy the loans against them, and the two
// are not the same business.
//
// A note is a claim on somebody else's rent, secured by a building you do not
// own and cannot manage. What you are actually underwriting is not the
// collateral — it is the borrower's ability to make you go away. A performing
// loan on a solvent firm is a bond: it pays its coupon and one day it is
// repaid, and the only decision is whether that beats the deposit rate. A
// defaulted loan on a half-empty office block is a building you have bid on
// privately, in an auction with one bidder, at a price the owner never agreed
// to — and if you win it you inherit two years of deferred maintenance and a
// rent roll nobody has renewed.
//
// WHERE THE PAPER COMES FROM is what makes this a system rather than a shop.
// Nothing here is generated for the player's benefit. A desk sells a loan for
// exactly two reasons, both already modelled in engine/lenders.ts:
//
//   1. It has stopped paying, and a lender with a regulator does not carry
//      non-performing paper through an examination. Odds off `delinquent`.
//   2. The desk needs the capital more than it needs the asset. Odds off
//      `capitalRatio` against the target its own kind of institution runs at.
//      You are buying because THEY are in trouble, and you could read it
//      coming on the Research page a year ago.
//
// THE PRICE IS THE SELLER'S PROBLEM, NOT THE COLLATERAL'S QUALITY. Measured
// over 24,000 lender-months, a desk is under real pressure 25.4% of the time
// and badly impaired 5.5%. When it is not, the ask is six per cent ABOVE fair
// and the correct move is to pass.
//
// AND IT IS NOT FREE MONEY. Measured over 324 offers across ten fifty-year
// runs: a bot that buys every note offered gets 0.99 back per dollar in. A bot
// that buys the CHEAPEST paper gets 0.88 — the worst policy in the table. Two
// bots that underwrite, one on the collateral and one on the borrower, get
// 1.11 and 1.08. Eight to eleven points for being right, and the 2.4x is in
// the stabilised value, which you only reach by fixing a worn building with
// half a rent roll over years.
//
// WHY THIS IS NOT A CHORE. Buying a note is a decision. Servicing one is not,
// and there is no button for it: tickNotes sweeps the coupon into your cash
// every month, silently, forever. A note speaks to you exactly twice — once
// when it stops paying and once when it resolves — and `toldM` guarantees it.
// Modify is capped at one per note; filing is a clock that runs itself;
// selling ends it. Nothing here can turn into a monthly rhythm of clicks.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { GameState, Holding, Note, Rival } from "./types";
import { logBooks, monthLabel, nextJulyAfter, cloneState} from "./types";
import { rng, rrange } from "./market";
import { assetValue, collateralAsIs, holdingValue, ownedHoldingValue, resolveRec } from "./value";
import { lenderByName, lenderPressure, chargeLenderLoss } from "./lenders";
import { assetGrade, clearRivalClaims, forgetDeed } from "./rivals";
import { genRentRoll } from "./leasing";
import { recordComp } from "./comps";
import { distressPrice, markSponsor } from "./sponsor";
import { firmShort } from "./firm";
import { productById, bumpLenderRel } from "./debt";
import { clearPrivateOrigination, creditBookRoom, releasePrivateStreetRecord } from "./privateCredit";

const clone = (s: GameState): GameState => cloneState(s);
const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;
const cl = (lo: number, hi: number, x: number) => Math.max(lo, Math.min(hi, x));

/** Three live at once, and they expire. An inventory is a chore; a shortlist is a decision. */
const MAX_OFFERS = 3;
/** Legal, as a share of face, paid the month you file. */
export const FILE_COST = 0.02;
/** How long a foreclosure takes once you have filed. You collect nothing through it. */
const FILE_MIN_M = 9, FILE_MAX_M = 17;
/** What a distressed-debt buyer charges for fourteen months of waiting. */
const TIME_DISC = Math.pow(1.13, -14 / 12);

// ---------------------------------------------------------------- reading it

function obligorOf(s: GameState, id: string): Rival | undefined {
  return s.rivals?.find((x) => x.id === id);
}

/** How well the obligor has been running the building. Already tracked; now it has a price. */
function ownerOcc(r: Rival | undefined): number {
  return r ? cl(0.15, 0.95, r.occ ?? 0.6) : 0.35;
}

/**
 * CAN THE BORROWER MAKE YOU GO AWAY? The whole underwriting, in one number.
 *
 * Every input is on a screen the player already reads: the street table has
 * their cash, their debt and their AUM; the stress counter is visible as "they
 * are selling under pressure"; the credit index is on the Economy page. A note
 * where this is 0.55 is a bond you are buying at a discount. One where it is
 * 0.03 is a building. They sit on the same list and want opposite underwriting.
 *
 * Measured across 324 offers: p10 0.03, p50 0.34, p90 0.56 — genuinely bimodal.
 */
export function pCure(s: GameState, r: Rival | undefined, face: number): number {
  if (!r || r.failedM !== undefined) return 0.02;
  const aum = r.aum ?? 0;
  const ltv = aum > 0 ? r.debt / aum : 2;
  return cl(0.03, 0.85,
    0.55
    - 0.45 * Math.min(1, (r.stressMs ?? 0) / 18)
    - 0.30 * Math.max(0, (ltv - 0.75) / 0.35)
    + 0.25 * Math.min(1, Math.max(0, r.cash) / Math.max(1, face))
    + 0.15 * ((s.econ.creditIdx ?? 1) - 1));
}

/**
 * WHAT THE PAPER IS WORTH, as a share of face.
 *
 * A blend of the two things that can happen. If they cure you get face; if
 * they do not you get the building, at what a building looks like the day you
 * take it off a receiver. Discounted fourteen months at a distressed buyer's
 * cost of capital, because that is how long the calendar takes.
 */
export function noteFairPct(
  s: GameState, rec: ParcelRecord, r: Rival | undefined, face: number,
  perf: "performing" | "nonperforming",
): number {
  if (perf === "performing") {
    // A performing loan is a bond. Its risk is that the collateral is thin.
    const cover = collateralAsIs(rec, s.econ, ownerOcc(r)) / Math.max(1, face);
    return cl(0.55, 1.0, 0.70 + 0.30 * Math.min(1, cover / 1.15));
  }
  const cure = pCure(s, r, face);
  const asIs = collateralAsIs(rec, s.econ, ownerOcc(r));
  return cl(0.08, 1.0,
    (cure * face + (1 - cure) * Math.min(face, asIs)) * TIME_DISC / Math.max(1, face));
}

/**
 * WHAT THEY WILL TAKE FOR IT.
 *
 * Fair, moved by how badly the desk needs the money. At zero pressure the ask
 * is six per cent ABOVE fair and you should not buy; at full pressure they
 * leave twenty points on the table. That gap is the entire business, and it is
 * only open in the months when somebody else's balance sheet is on fire.
 */
export function noteAskPct(
  s: GameState, rec: ParcelRecord, r: Rival | undefined, face: number,
  perf: "performing" | "nonperforming", lender: string,
): number {
  const p = lenderPressure(lenderByName(s, lender));
  return cl(0.08, 1.02, noteFairPct(s, rec, r, face, perf) * (1.06 - 0.20 * p));
}

/** In words, for the panel: why is this on the market at all? */
function sellingBecause(s: GameState, lender: string, perf: string): string {
  const l = lenderByName(s, lender);
  if (!l) return "";
  const p = lenderPressure(l);
  if (perf === "nonperforming" && p < 0.15) {
    return `${lender} is not in trouble — they simply will not carry a non-performing loan through an examination. `
      + `They are pricing it like people who do not have to sell.`;
  }
  if (p > 0.7) {
    return `${lender} is at ${(100 * (l.capital / Math.max(1, l.book))).toFixed(1)}% capital with `
      + `${(l.delinquent * 100).toFixed(1)}% of the book not paying. This is not a trade for them, it is a `
      + `capital ratio. They will take a number.`;
  }
  if (p > 0.25) {
    return `${lender} is shrinking the book — ${(l.delinquent * 100).toFixed(1)}% delinquent and the capital `
      + `will not carry it. There is some room in the price.`;
  }
  return `${lender} is comfortable and quoting like it. There is nothing in this for you at their number.`;
}

// ------------------------------------------------------------------ the tick

export function tickNotes(s: GameState, parcels: ParcelTable) {
  if (!s.notes) s.notes = [];
  if (!s.noteOffers) s.noteOffers = [];
  serviceNotes(s, parcels);
  takeRivalNotes(s, parcels);
  expireOffers(s, parcels);
  bringPaperToMarket(s, parcels);
}

/**
 * ONE MONTH OF OWNING PAPER, and it costs the player nothing to read.
 *
 * The coupon lands in cash. Nothing appears on screen. The only things that
 * generate a line of news are the four state changes — it stopped paying, they
 * paid you off, they handed you the keys, or the hammer fell — and each of
 * those happens once.
 */
function serviceNotes(s: GameState, parcels: ParcelTable) {
  for (let i = s.notes!.length - 1; i >= 0; i--) {
    const n = s.notes![i];
    const rec = resolveRec(parcels, s, n.bbl);
    if (!rec) { s.notes!.splice(i, 1); continue; }
    const r = obligorOf(s, n.obligorId);
    const dead = !r || r.failedM !== undefined;

    // THE COLLATERAL TRADED. A first mortgage is satisfied out of the proceeds
    // — all of it if the sale covered you, only what was there if it did not.
    // Sitting on a defaulted note while somebody else sells your building is
    // how a note buyer loses money without ever being wrong about the building.
    if (r && !r.bbls.includes(n.bbl)) {
      const got = n.perf === "performing"
        ? n.face
        : Math.min(n.face + (n.arrears ?? 0), Math.round(collateralAsIs(rec, s.econ, ownerOcc(r))));
      s.cash += got; logBooks(s, "sold", got);
      clearPrivateOrigination(s, n);
      s.news.unshift({
        q: s.month, kind: got >= n.basis ? "deal" : "warn",
        text: `${n.address} changed hands and your loan was paid off out of the proceeds — ${money(got)} `
          + `against ${money(n.face)} of face. You put ${money(n.basis)} in. `
          + (got >= n.basis
            ? `The paper did what paper does.`
            : `The sale did not cover you and there was nothing left to chase.`),
      });
      s.notes!.splice(i, 1); continue;
    }

    // --- the coupon, silently ------------------------------------------------
    if (n.perf === "performing" && n.filedM === undefined) {
      const cpn = Math.round((n.face * n.ratePct) / 100 / 12);
      s.cash += cpn; n.collected += cpn; logBooks(s, "interest", cpn);
      // it matures and they repay, or it does not and they do not
      if (s.month >= n.maturityM) {
        if (!dead && rng(s) < 0.55 + 0.4 * pCure(s, r, n.face)) {
          s.cash += n.face; logBooks(s, "sold", n.face);
          if (r) r.cash = Math.max(0, r.cash - n.face);
          clearPrivateOrigination(s, n);
          s.news.unshift({
            q: s.month, kind: "deal",
            text: `${n.obligor} repaid the loan on ${n.address} at maturity — ${money(n.face)} back against `
              + `${money(n.basis)} in and ${money(n.collected)} of coupon collected along the way. A bond is a bond.`,
          });
          s.notes!.splice(i, 1); continue;
        }
        goBad(s, n, `${n.obligor} could not repay the loan on ${n.address} at maturity`);
        continue;
      }
      // or it simply stops paying, because the obligor is in trouble
      if (dead || ((r!.stressMs ?? 0) > 0 && rng(s) < 0.09)) {
        goBad(s, n, `${n.obligor} has stopped paying on ${n.address}`);
      }
      continue;
    }

    // --- it is not paying ----------------------------------------------------
    // The coupon it is not paying piles up as arrears — a real claim, capped
    // at two years because a court will not let interest run forever.
    const cpn = Math.round((n.face * n.ratePct) / 100 / 12);
    n.arrears = Math.min(cpn * 24, (n.arrears ?? 0) + cpn);

    // THE BORROWER CAN COME BACK, and filing does not stop them — the right to
    // reinstate runs to the hammer itself. Odds are the underwriting, spread
    // over ~15 months, and most recoveries are exactly this: they find the
    // arrears, the file closes, and you own a performing loan again. The
    // rarer, better outcome is a full payoff — outside money refinancing you
    // out at face plus everything owed.
    if (!dead && rng(s) < pCure(s, r, n.face) / 15) {
      const legal = n.filedM !== undefined ? Math.round(n.face * FILE_COST) : 0;
      const reinstate = Math.round((n.arrears ?? 0) * 1.05) + legal;
      // Reinstating is what a borrower DOES with the money they can find — the
      // cheque is small next to the face, and a firm that is not buried draws
      // its line for it the way it draws its line for everything else.
      const ltvR = (r!.aum ?? 0) > 0 ? r!.debt / r!.aum! : 2;
      if (rng(s) < 0.72 && (r!.cash > reinstate || ltvR < 0.88)) {
        r!.cash -= reinstate;
        s.cash += reinstate; n.collected += reinstate; logBooks(s, "interest", reinstate);
        n.perf = "performing";
        n.arrears = 0;
        n.filedM = undefined; n.saleM = undefined; n.toldM = undefined;
        s.news.unshift({
          q: s.month, kind: "deal",
          text: `${n.obligor} has reinstated on ${n.address} — ${money(reinstate)} of arrears${legal ? " and your legal" : ""} `
            + `paid in one cheque, and the loan is current again. `
            + (legal ? `The foreclosure file is closed; there is nothing to sell in July. ` : ``)
            + `You are back to owning a bond, which was never the worst outcome.`,
        });
        continue;
      }
      // they could not fund the arrears, or they went and found a refinancing
      const px = Math.round(n.face * 1.02 + (n.arrears ?? 0));
      s.cash += px; logBooks(s, "sold", px);
      clearPrivateOrigination(s, n);
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `${n.obligor} has paid you out on ${n.address} — ${money(px)} against ${money(n.basis)} in, arrears and all. `
          + `You bought the building and got the money instead, which is the risk you take at that price.`,
      });
      s.notes!.splice(i, 1); continue;
    }

    // THE KEYS, OFFERED. A borrower who is hopelessly under water would rather
    // stop bleeding than fight you for eight months. No decision to make: it is
    // strictly better than what you were going to get.
    const ltv = r && (r.aum ?? 0) > 0 ? r.debt / r.aum! : 2;
    if (!dead && ltv > 1.02 && rng(s) < 0.03) {
      takeDeed(s, parcels, n, "deed");
      s.notes!.splice(i, 1); continue;
    }

    // The file you opened runs to the county's calendar now: the sale is the
    // July auction, the docket and the hammer live in engine/auction.ts, and
    // until that gavel the borrower can still reinstate — see above.
  }
}

/** It stopped paying. One line of news, once, and then it never speaks again. */
function goBad(s: GameState, n: Note, what: string) {
  n.perf = "nonperforming";
  if (n.toldM !== undefined) return;
  n.toldM = s.month;
  s.news.unshift({
    q: s.month, kind: "warn",
    text: `${what}. You hold ${money(n.face)} of face against it and you paid ${money(n.basis)}. `
      + `You can extend them once, you can file, or you can sell the paper on — and doing nothing is `
      + `a position too, until somebody else sells the building.`,
  });
}

/**
 * YOU OWN IT NOW.
 *
 * Worn bones and a rent roll culled to whatever the obligor was actually
 * running the building at, because a firm that stopped paying its mortgage
 * stopped leasing a year earlier. Measured, that is 0.43x a clean comparable —
 * and from here it is an ordinary building and every other system in the game
 * takes over.
 */
export function takeDeed(s: GameState, parcels: ParcelTable, n: Note, how: "foreclosure" | "deed") {
  const rec = resolveRec(parcels, s, n.bbl);
  if (!rec) return;
  const r = obligorOf(s, n.obligorId);
  const occ = ownerOcc(r);
  const h: Holding = {
    bbl: n.bbl,
    boughtM: s.month,
    costBasis: Math.round(n.basis + (how === "foreclosure" ? n.face * FILE_COST : 0)),
    assessed: Math.round(collateralAsIs(rec, s.econ, occ)),
    loan: null,
    condition: "worn",
    tenants: [],
    cfHistory: [],
    ...(s.landmarks?.[n.bbl] !== undefined ? { landmarked: true } : {}),
  };
  wreckedRoll(s, rec, h, occ);
  s.holdings[n.bbl] = h;
  if (r) {
    r.bbls = r.bbls.filter((b) => b !== n.bbl);
    forgetDeed(r, n.bbl);
    r.debt = Math.max(0, r.debt - n.face);   // the debt went with the deed
  }
  // Private-originated paper also drops the cityLoans row in your name.
  if (n.privateOriginated && s.cityLoans?.[n.bbl]) delete s.cityLoans[n.bbl];
  clearRivalClaims(s, n.bbl);
  s.listings = s.listings.filter((l) => l.bbl !== n.bbl);
  delete s.approaches[n.bbl];
  if (s.talks?.[n.bbl]) { delete s.talks[n.bbl]; if (!Object.keys(s.talks).length) delete s.talks; }
  s.lastTradeM = s.lastTradeM ?? {};
  s.lastTradeM[n.bbl] = s.month;
  const mark = Math.round(holdingValue(rec, s.econ, h, s.month));
  recordComp(s, rec, mark, firmShort(s), n.obligor, true, "worn");
  const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
  s.news.unshift({
    q: s.month, kind: "deal",
    text: how === "deed"
      ? `${n.obligor} handed you the deed to ${n.address} rather than fight the foreclosure. `
        + `It is yours at ${money(n.basis)} of basis, it is worn, and ${rec.bldgArea > 0 ? `${Math.round(100 * leased / Math.max(1, rec.bldgArea))}% of it is let` : "it is a site"}. `
        + `The mark today is ${money(mark)}.`
      : `The hammer fell on ${n.address} and nobody bid against you. It is yours at ${money(h.costBasis)} all in — `
        + `worn, ${rec.bldgArea > 0 ? `${Math.round(100 * leased / Math.max(1, rec.bldgArea))}% let` : "a site"}, and marked at ${money(mark)} today. `
        + `You did not buy a building at a discount; you bought a job.`,
  });
}

/**
 * THE ROLL YOU INHERIT.
 *
 * genRentRoll writes a market rent roll. This is what is left of one after two
 * years of a landlord who could not fund a tenant improvement or answer a
 * renewal — the tenants who could leave, left, and their deposits never came
 * across the settlement statement because there was no settlement statement.
 */
function wreckedRoll(s: GameState, rec: ParcelRecord, h: Holding, occ: number) {
  genRentRoll(s, rec, h);
  const total = h.tenants.reduce((a, t) => a + t.sf, 0);
  let cur = total;
  let guard = 0;
  while (h.tenants.length && cur > total * occ && guard++ < 200) {
    const i = Math.floor(rng(s) * h.tenants.length);
    const gone = h.tenants.splice(i, 1)[0];
    cur -= gone.sf;
    s.cash -= gone.deposit ?? 0;    // that money was never handed over
  }
  if (h.occ !== undefined) h.occ = Math.min(h.occ, occ);
}

// -------------------------------------------------------------- the offer sheet

function expireOffers(s: GameState, _parcels: ParcelTable) {
  for (let i = s.noteOffers!.length - 1; i >= 0; i--) {
    const o = s.noteOffers![i];
    if (s.month < o.expiresM) continue;
    s.noteOffers!.splice(i, 1);
    // SOMEBODY ELSE HAS MONEY. An opportunist takes what you passed on, and in
    // fourteen months the deed moves to them. That is what makes the window on
    // an offer mean something, and it is a way for the street to grow that is
    // not "they outbid you on the tape".
    const px = Math.round(o.face * o.askPct);
    // A fund does not buy paper out of its checking account; it buys on its
    // line, against a book that can carry it. The old test wanted 1.6x the
    // price in idle CASH from firms that distribute everything above a working
    // reserve — measured over eight fifty-year runs, 139 of 139 expired offers
    // were taken by NOBODY, which made passing on paper free. It is not free now.
    //
    // Phase C: performing paper can leave too — as a BOND. Core / PE / opportunistic
    // names take it; there is no deed chase, because the borrower is current.
    if (o.perf === "performing") {
      const bondBuyers = (s.rivals ?? []).filter((r) =>
        r.failedM === undefined && r.id !== o.obligorId
        && (r.style === "opportunistic" || r.style === "core" || r.style === "pe")
        && r.cash > px * 1.1);
      const bb = bondBuyers.length && rng(s) < 0.5
        ? bondBuyers[Math.floor(rng(s) * bondBuyers.length)] : undefined;
      if (!bb) continue;
      bb.cash -= px;
      if (s.cityLoans?.[o.bbl]) delete s.cityLoans[o.bbl];
      s.news.unshift({
        q: s.month, kind: "event",
        text: `${bb.name} bought the performing loan on ${o.address} off ${o.lender} at `
          + `${(100 * o.askPct).toFixed(0)} cents. A bond changed hands — ${o.obligor} still owns the deed.`,
      });
      continue;
    }
    const able = (s.rivals ?? []).filter((r) =>
      r.failedM === undefined && r.id !== o.obligorId
      && (r.style === "opportunistic")
      && (r.aum ?? 0) > px * 3 && r.debt / Math.max(1, r.aum ?? 1) < 0.78);
    const buyer = able.length && rng(s) < 0.55 ? able[Math.floor(rng(s) * able.length)] : undefined;
    if (!buyer) continue;
    const equity = Math.min(Math.max(0, buyer.cash), Math.round(px * 0.35));
    buyer.cash -= equity;
    if (s.cityLoans?.[o.bbl]) delete s.cityLoans[o.bbl];       // the record follows the paper
    buyer.debt += px - equity;
    if (!s.rivalNotes) s.rivalNotes = [];
    s.rivalNotes.push({
      bbl: o.bbl, firmId: buyer.id, firm: buyer.name, face: o.face,
      takeM: s.month + Math.round(rrange(s, FILE_MIN_M, FILE_MAX_M)),
    });
    s.news.unshift({
      q: s.month, kind: "event",
      text: `${buyer.name} bought the loan on ${o.address} off ${o.lender} at ${(100 * o.askPct).toFixed(0)} cents. `
        + `They are not buying a bond. ${o.obligor} has about a year to find the money.`,
    });
  }
}

function takeRivalNotes(s: GameState, parcels: ParcelTable) {
  if (!s.rivalNotes?.length) return;
  for (let i = s.rivalNotes.length - 1; i >= 0; i--) {
    const rn = s.rivalNotes[i];
    if (s.month < rn.takeM) continue;
    s.rivalNotes.splice(i, 1);
    const to = s.rivals?.find((x) => x.id === rn.firmId);
    const rec = resolveRec(parcels, s, rn.bbl);
    if (!to || to.failedM !== undefined || !rec || s.holdings[rn.bbl]) continue;
    const from = s.rivals?.find((x) => x.bbls.includes(rn.bbl));
    if (!from || from.id === to.id) continue;
    from.bbls = from.bbls.filter((b) => b !== rn.bbl);
    forgetDeed(from, rn.bbl);
    from.debt = Math.max(0, from.debt - rn.face);
    to.bbls.push(rn.bbl);
    // Taking title through the paper is still taking title today — see the
    // same line in auction.ts for what an undated deed does to the hold clock.
    (to.heldSince ??= {})[rn.bbl] = s.month;
    to.basis = Math.round((to.basis ?? 0) + rn.face * 0.7);
    s.lastTradeM = s.lastTradeM ?? {};
    s.lastTradeM[rn.bbl] = s.month;
    s.news.unshift({
      q: s.month, kind: "event",
      text: `${to.name} has taken ${rec.address} off ${from.name} through the paper. No auction, no listing, `
        + `and no chance for anybody else to bid — which is the whole reason to own somebody's mortgage.`,
    });
  }
}

/**
 * A DESK BRINGS SOMETHING TO MARKET.
 *
 * One a month at most, city-wide. Measured at 31.6 offers per fifty-year run —
 * 24.4 non-performing, 7.3 performing — which is a real decision about every
 * nineteen months and never an inbox.
 */
function bringPaperToMarket(s: GameState, parcels: ParcelTable) {
  if (s.noteOffers!.length >= MAX_OFFERS) return;
  for (const l of s.lenders ?? []) {
    // THE RECEIVER SELLS THE BOOK. A failed desk used to be skipped here
    // entirely, so a receivership sold nothing and a bank failure was a hole
    // in the market instead of a flood into it. What actually happens is the
    // opposite of quiet: the FDIC-equivalent empties the filing cabinet at
    // whatever the paper fetches, which is where a note buyer's best decade
    // comes from. lenderPressure is already 1 for a failed desk, so the ask
    // arrives at full distress without a special price path.
    if (l.failedM !== undefined) {
      if (rng(s) > 0.30) continue;
      const rows = Object.values(s.cityLoans ?? {}).filter((x) => x.lender === l.name);
      const sale = rows.filter((x) => {
        const r = obligorOf(s, x.obligorId);
        return r && r.failedM === undefined && x.balance >= 750_000
          && !s.holdings[x.bbl] && !s.notes!.some((n) => n.bbl === x.bbl)
          && !s.noteOffers!.some((o) => o.bbl === x.bbl)
          && !(s.rivalNotes ?? []).some((rn) => rn.bbl === x.bbl);
      });
      if (!sale.length) continue;
      // worst first — that is the paper the receiver wants gone
      sale.sort((a, b) => (a.status === b.status ? 0 : a.status === "current" ? 1 : -1));
      const x = sale[Math.floor(rng(s) * Math.min(2, sale.length))];
      const r = obligorOf(s, x.obligorId)!;
      const rec = resolveRec(parcels, s, x.bbl);
      if (!rec) continue;
      const kind: "performing" | "nonperforming" = x.status === "current" ? "performing" : "nonperforming";
      const id = "NO" + (s.nextNoteId = (s.nextNoteId ?? 1) + 1);
      s.noteOffers!.push({
        id, bbl: x.bbl, address: rec.address, lender: l.name,
        obligorId: r.id, obligor: r.name,
        face: x.balance, ratePct: x.ratePct, maturityM: x.maturityM,
        perf: kind,
        askPct: +noteAskPct(s, rec, r, x.balance, kind, l.name).toFixed(4),
        cure: +pCure(s, r, x.balance).toFixed(3),
        offeredM: s.month,
        expiresM: s.month + Math.round(rrange(s, 2, 4)),   // a receiver's window is short
        why: `${l.name} is in receivership. This is not a desk pricing a loan — it is a receiver emptying `
          + `a filing cabinet, and the ask is what that always is: the number that makes it somebody else's file.`,
      });
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `The receiver for ${l.name} is selling the loan on ${rec.address} — ${money(x.balance)} of face at `
          + `${(100 * s.noteOffers![s.noteOffers!.length - 1].askPct).toFixed(0)} cents. Nobody at that desk is `
          + `paid to wait any more.`,
      });
      return;
    }
    const p = lenderPressure(l);
    // A regulator makes you sell what is not paying. Above ~2.8% delinquency
    // the examiners start asking, and above 8% it is every other month.
    const nplOdds = Math.max(0, l.delinquent - 0.028) * 3.2;
    // Performing paper goes when the desk needs capital. Phase C widens the
    // window slightly (pressure from 0.22, and a separate capital-sale path
    // when delinquency is quiet but the book is tight) — still episodic, still
    // one offer a month city-wide. Measured, not invented volume.
    const perfOdds = p > 0.22 ? 0.085 * p : 0;
    const npl = rng(s) < nplOdds;
    const capitalSale = !npl && p > 0.42 && (l.delinquent ?? 0) < 0.04 && rng(s) < 0.14 * p;
    const perf = (!npl && rng(s) < perfOdds) || capitalSale;
    if (!npl && !perf) continue;

    const live = (s.rivals ?? []).filter((r) =>
      r.failedM === undefined && r.bbls.length && (r.aum ?? 0) > 0);
    if (!live.length) return;
    // A firm does not have to be dying to miss a payment on one building.
    const pool = npl
      ? live.filter((r) => (r.stressMs ?? 0) > 0 || r.debt / Math.max(1, r.aum!) > 0.62)
      : live;
    if (!pool.length) return;
    const r = pool[Math.floor(rng(s) * pool.length)];

    // THE CORNER YOU LOST. If this firm once came over the top of you on a
    // building, that is the one the desk shows you — because the game knows it
    // is the one you want, and because a note is the only way back into a
    // building whose owner will never list it.
    const beat = (s.beaten ?? []).find((b) => b.firmId === r.id && r.bbls.includes(b.bbl));
    // THE LOAN THE STATEMENT ALREADY SHOWS. The desk sells out of the same
    // mortgage record the Research page prints — this lender's own row on
    // this borrower where one exists — so the loan you watched go to
    // "watch" on a statement last spring is the loan that turns up here.
    const mine = r.bbls.filter((b) => s.cityLoans?.[b]?.lender === l.name);
    // Performing sales prefer a CURRENT row on this desk — real bank assets,
    // not a synthetic face invented for the offer.
    const currentMine = mine.filter((b) => s.cityLoans?.[b]?.status === "current");
    const kind: "performing" | "nonperforming" = npl ? "nonperforming" : "performing";
    const bbl = beat && rng(s) < 0.45 && r.bbls.includes(beat.bbl) ? beat.bbl
      : kind === "performing" && currentMine.length
        ? currentMine[Math.floor(rng(s) * currentMine.length)]
      : mine.length ? mine[Math.floor(rng(s) * mine.length)]
      : r.bbls[Math.floor(rng(s) * r.bbls.length)];
    if (s.holdings[bbl] || s.notes!.some((n) => n.bbl === bbl)) return;
    if (s.noteOffers!.some((o) => o.bbl === bbl)) return;
    if ((s.rivalNotes ?? []).some((x) => x.bbl === bbl)) return;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class === "land") return;

    const row = s.cityLoans?.[bbl];
    const clean = assetValue(rec, s.econ, assetGrade(r, rec));
    if (clean < 500_000) return;
    // Performing paper without a ledger row is not a bank asset — skip rather
    // than invent face (NPL can still use synthetic when the record is thin).
    if (kind === "performing" && !(row && row.lender === l.name)) continue;
    const face = row && row.lender === l.name ? row.balance
      : Math.round(clean * Math.min(1.4, r.debt / Math.max(1, r.aum!)));
    if (face < 750_000) return;
    const id = "NO" + (s.nextNoteId = (s.nextNoteId ?? 1) + 1);
    s.noteOffers!.push({
      id, bbl, address: rec.address, lender: l.name,
      obligorId: r.id, obligor: r.name,
      face,
      ratePct: row && row.lender === l.name ? row.ratePct : +(s.econ.indexRate + rrange(s, 1.6, 3.2)).toFixed(2),
      maturityM: row && row.lender === l.name ? Math.max(s.month + 3, row.maturityM) : s.month + Math.round(rrange(s, 6, 84)),
      perf: kind,
      askPct: +noteAskPct(s, rec, r, face, kind, l.name).toFixed(4),
      cure: +pCure(s, r, face).toFixed(3),
      offeredM: s.month,
      expiresM: s.month + Math.round(rrange(s, 3, 6)),
      why: sellingBecause(s, l.name, kind),
    });
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `${l.name} is offering the ${kind === "nonperforming" ? "defaulted " : ""}loan on ${rec.address} — `
        + `${money(face)} of face at ${(100 * s.noteOffers![s.noteOffers!.length - 1].askPct).toFixed(0)} cents. `
        + `The borrower is ${r.name}. You would not be buying a building; you would be buying their mortgage.`,
    });
    return;   // one a month, city-wide
  }
}

// --------------------------------------------------------------- the actions

export function buyNote(s: GameState, parcels: ParcelTable, id: string): { s: GameState; err?: string; msg?: string } {
  const o = s.noteOffers?.find((x) => x.id === id);
  if (!o) return { s, err: "That paper is gone." };
  const px = Math.round(o.face * o.askPct);
  if (s.cash < px) return { s, err: `That is ${money(px)} in cash — you are short ${money(px - s.cash)}. Nobody finances a note purchase.` };
  // Phase C — purchased paper counts against the combined credit book.
  const room = creditBookRoom(s, parcels);
  if (px > room) {
    return { s, err: `Your credit book will only carry another ${money(room)} — originated sleeve plus purchased notes share one rail.` };
  }
  const next = clone(s);
  next.cash -= px;
  logBooks(next, "bought", px);
  next.noteOffers = next.noteOffers!.filter((x) => x.id !== o.id);
  if (next.cityLoans?.[o.bbl]) delete next.cityLoans[o.bbl];   // off the bank's statement — it is your paper now
  next.notes!.push({
    id: "N" + (next.nextNoteId = (next.nextNoteId ?? 1) + 1),
    bbl: o.bbl, address: o.address, originator: o.lender,
    obligorId: o.obligorId, obligor: o.obligor,
    face: o.face, ratePct: o.ratePct, maturityM: o.maturityM,
    perf: o.perf, boughtM: next.month, basis: px, collected: 0, mods: 0,
  });
  bumpLenderRel(next, o.lender, 3);   // you took a problem off their book
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `${firmShort(next)} has bought the loan on ${o.address} from ${o.lender} — ${money(o.face)} of face for `
      + `${money(px)}. ${o.obligor} owes the money to you now, and they will find that out this month.`,
  });
  return { s: next, msg: `Bought at ${(100 * o.askPct).toFixed(0)} cents.` };
}

/**
 * BE THE PATIENT LENDER, ONCE.
 *
 * The exact mirror of requestForbearance in workout.ts, from the other chair.
 * Extend them, cut the coupon, take a paydown today. If their balance sheet
 * can carry it you own a performing note at a discount basis, which is the
 * best outcome in the business. If it cannot you have learned they are
 * finished and burned eighteen months of optionality finding out.
 */
export function modifyNote(s: GameState, _parcels: ParcelTable, id: string): { s: GameState; err?: string; msg?: string } {
  const n = s.notes?.find((x) => x.id === id);
  if (!n) return { s, err: "You do not hold that paper." };
  if (n.mods >= 1) return { s, err: "You have already restructured this one. Nobody extends twice — that is how a note buyer becomes a landlord by accident." };
  if (n.filedM !== undefined) return { s, err: "You have filed. That conversation is over." };
  const next = clone(s);
  const nn = next.notes!.find((x) => x.id === id)!;
  const r = obligorOf(next, nn.obligorId);
  nn.mods = 1;
  const paydown = Math.round(nn.face * 0.05);
  const canPay = !!r && r.failedM === undefined && r.cash > paydown;
  if (!canPay) {
    next.news.unshift({
      q: next.month, kind: "warn",
      text: `${nn.obligor} could not fund the five per cent paydown on ${nn.address}. There is no restructuring here — `
        + `they do not have the money, and now you know it.`,
    });
    return { s: next, msg: "They could not fund it." };
  }
  r!.cash -= paydown;
  next.cash += paydown; logBooks(next, "sold", paydown);
  nn.face = Math.max(0, nn.face - paydown);
  nn.ratePct = +Math.max(1, nn.ratePct - 1.5).toFixed(2);
  nn.maturityM = next.month + Math.round(rrange(next, 24, 36));
  nn.perf = "performing";
  nn.toldM = undefined;
  next.news.unshift({
    q: next.month, kind: "info",
    text: `You extended ${nn.obligor} on ${nn.address} to ${monthLabel(nn.maturityM)} — ${money(paydown)} down, `
      + `coupon to ${nn.ratePct.toFixed(2)}%. You are the patient lender now, which is a position and not a favour.`,
  });
  return { s: next, msg: "Restructured." };
}

/** File to foreclose. Legal money out, and then you wait. */
export function fileOnNote(s: GameState, _parcels: ParcelTable, id: string): { s: GameState; err?: string; msg?: string } {
  const n = s.notes?.find((x) => x.id === id);
  if (!n) return { s, err: "You do not hold that paper." };
  if (n.perf === "performing") return { s, err: "It is paying. You cannot foreclose on a loan that is current, however much you want the building." };
  if (n.filedM !== undefined) return { s, err: "You have already filed." };
  const cost = Math.round(n.face * FILE_COST);
  if (s.cash < cost) return { s, err: `Filing costs ${money(cost)} in legal — you are short.` };
  const next = clone(s);
  next.cash -= cost; logBooks(next, "ga", cost);
  const nn = next.notes!.find((x) => x.id === id)!;
  nn.filedM = next.month;
  // The process takes what it takes, and then it waits for the county: one
  // sale a year, in July, everything on the courthouse steps together.
  nn.saleM = nextJulyAfter(next.month, Math.round(rrange(next, FILE_MIN_M, FILE_MAX_M)) - 5);
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `You have filed to foreclose on ${nn.address}. The referee has set it down for the ${monthLabel(nn.saleM)} auction. `
      + `Between now and then you collect nothing, ${nn.obligor} can still reinstate right up to the hammer — `
      + `and if somebody outbids your debt on the steps, you get paid off and they get the building.`,
  });
  return { s: next, msg: "Filed." };
}

/** What a note is worth to somebody else today, and who would write the cheque. */
export function noteBid(s: GameState, parcels: ParcelTable, n: Note): { px: number; buyer: string | null } {
  const rec = resolveRec(parcels, s, n.bbl);
  if (!rec) return { px: 0, buyer: null };
  const r = obligorOf(s, n.obligorId);
  // A buyer pays fair less a spread, and only if they have the money. In a
  // crunch there is no bid at all, which is the correct lesson about paper.
  const px = Math.round(n.face * noteFairPct(s, rec, r, n.face, n.perf) * 0.94);
  const buyer = (s.rivals ?? []).find((x) =>
    x.failedM === undefined && x.id !== n.obligorId
    && (x.style === "opportunistic" || x.style === "core") && x.cash > px * 1.4);
  return { px, buyer: buyer?.name ?? null };
}

export function sellNote(s: GameState, parcels: ParcelTable, id: string): { s: GameState; err?: string; msg?: string } {
  const n = s.notes?.find((x) => x.id === id);
  if (!n) return { s, err: "You do not hold that paper." };
  const { px, buyer } = noteBid(s, parcels, n);
  if (!buyer) return { s, err: "There is no bid. Everybody who buys paper in this town is dealing with their own balance sheet this month." };
  const next = clone(s);
  const b = next.rivals!.find((x) => x.name === buyer)!;
  b.cash -= px;
  next.cash += px; logBooks(next, "sold", px);
  // Selling transfers the claim — do not forgive the obligor's debt.
  // Street record follows the paper so the deed does not look clear.
  releasePrivateStreetRecord(next, n, buyer);
  next.notes = next.notes!.filter((x) => x.id !== id);
  const g = px - n.basis;
  next.news.unshift({
    q: next.month, kind: g >= 0 ? "deal" : "warn",
    text: `You sold the ${n.address} paper to ${buyer} at ${money(px)} — ${g >= 0 ? "a" : "a"} `
      + `${g >= 0 ? "gain" : "loss"} of ${money(Math.abs(g))} on a ${money(n.basis)} basis. `
      + `They want the building; you wanted the money.`,
  });
  return { s: next, msg: `Sold at ${money(px)}.` };
}

// -------------------------------------------------------------- your own paper

/**
 * THE DISCOUNTED PAYOFF.
 *
 * The same arithmetic, pointed at you. A desk that would rather have cash than
 * your building will take less than it is owed to make the problem go away —
 * and it will only do that when its own capital is the reason. This converts
 * cash into equity at a discount in exactly the month when nobody has cash,
 * which is the entire lesson of the note desk learned from the wrong end.
 *
 * It is a credit event. It is reported, and the street remembers.
 */
export function payoffQuote(
  s: GameState, parcels: ParcelTable, bbl: string,
): { px: number; bal: number; why: string; open: boolean } | null {
  const h = s.holdings[bbl];
  const w = s.workouts?.[bbl];
  if (!h?.loan || !w) return null;
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return null;
  const lender = h.loan.holder ?? productById(h.loan.product).lender;
  const l = lenderByName(s, lender);
  const p = lenderPressure(l);
  const bal = Math.round(h.loan.balance);
  const value = ownedHoldingValue(s, parcels, h);
  const auction = value * distressPrice(s) * 0.86;
  const under = auction < bal;
  const open = p > 0.25 || under;
  const px = Math.round(Math.min(bal, Math.max(auction, bal * (0.98 - 0.26 * p)) * (1.04 - 0.10 * p)));
  return {
    px, bal, open,
    why: !open
      ? `${lender} has the capital to wait you out and the loan is inside the value. There is no discount here.`
      : `${lender} would get about ${money(Math.round(auction))} at an auction and it would take them two years. `
        + `They will take ${money(px)} today against ${money(bal)} owed — `
        + `${p > 0.5 ? "they need the capital more than they need your building." : "you are worth more to them as cash than as an asset."}`,
  };
}

export function discountedPayoff(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; err?: string; msg?: string } {
  const q = payoffQuote(s, parcels, bbl);
  const h = s.holdings[bbl];
  const w = s.workouts?.[bbl];
  if (!q || !h?.loan || !w) return { s, err: "There is nothing in default there." };
  if (!q.open) return { s, err: q.why };
  if (s.cash < q.px) return { s, err: `A discounted payoff is cash on the table: ${money(q.px)}. You are short ${money(q.px - s.cash)}.` };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const next = clone(s);
  const lender = h.loan.holder ?? productById(h.loan.product).lender;
  const discount = q.bal - q.px;
  next.cash -= q.px;
  logBooks(next, "debtSvc", q.px);
  next.holdings[bbl]!.loan = null;
  delete next.workouts![bbl];
  chargeLenderLoss(next, lender, discount);
  bumpLenderRel(next, lender, -18);
  markSponsor(next, "dpo", rec.address, discount);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `${lender} took ${money(q.px)} to release the mortgage on ${rec.address} — ${money(discount)} less than `
      + `you owed them. You kept the building and you wrote down somebody else's capital to do it, and the `
      + `next credit committee in this town will have read about it.`,
  });
  return { s: next, msg: `Paid off at ${(100 * q.px / q.bal).toFixed(0)} cents.` };
}

/**
 * A DESK SELLS YOUR LOAN.
 *
 * Called from tickNotes' sibling in the lender tick. One field changes and the
 * counterparty across the table becomes somebody else — which is the whole
 * point: a bank wants a performing loan, and a fund that bought your paper at
 * seventy cents wants your building.
 */
export function maybeSellYourLoan(s: GameState, parcels: ParcelTable) {
  for (const h of Object.values(s.holdings)) {
    if (!h.loan || h.loan.holder) continue;
    const from = productById(h.loan.product).lender;
    const l = lenderByName(s, from);
    const p = lenderPressure(l);
    if (p < 0.55 || rng(s) > 0.035) continue;
    const to = (s.lenders ?? []).find((x) => x.kind === "fund" && x.failedM === undefined && x.name !== from);
    if (!to) continue;
    h.loan.holder = to.name;
    const rec = resolveRec(parcels, s, h.bbl);
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `${from} has sold your loan on ${rec?.address ?? h.bbl} to ${to.name}. Same balance, same coupon, `
        + `different counterparty — and a fund that bought your mortgage at a discount is not in the business `
        + `of granting extensions.`,
    });
  }
}
