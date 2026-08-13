// PRIVATE CREDIT — you are the expensive yes.
//
// Distressed notes let you BUY paper. This lets you WRITE it. Rivals who cannot
// clear a bank desk (hold, sponsor, speed, Cordage too rich) ask your sleeve
// for a short, expensive bridge. You fund from cash; the loan becomes a Note
// you own so tickNotes / foreclosure / July already work.
//
// Phase B flips the desk: when banks refuse or hold-cap YOUR takeout, a rival
// with dry powder quotes a Cordage-shaped bridge onto Holding.loan — same
// tickLoan / workout path as every other mortgage.
//
// Design contract: PRIVATE_CREDIT.md. Not a bank charter. Not multiplayer.
import type { ParcelTable } from "@/data/types";
import type { GameState, Loan, Note, PrivateBorrowQuote, PrivateCreditAsk, Rival } from "./types";
import { cloneState, logBooks, monthLabel } from "./types";
import { rng, rrange } from "./market";
import { assetValue, collateralAsIs, netWorth, resolveRec } from "./value";
import { assetGrade } from "./rivals";
import { firmShort } from "./firm";
import { lenderByName } from "./lenders";
import { coverCashShortfall, fundableNow, sweepLocIdleCash } from "./credit";
import { prepayPenalty, refiQuotes } from "./debt";

const clone = (s: GameState): GameState => cloneState(s);
const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;
const cl = (lo: number, hi: number, x: number) => Math.max(lo, Math.min(hi, x));

/** Leave this much cash after funding — G&A and a bad month. */
export const PRIVATE_CASH_RESERVE = 500_000;
/** Outstanding private-originated face ≤ this share of net worth. */
export const PRIVATE_BOOK_NW = 0.35;
/** Purchased + originated credit claims ≤ this share of NW (Phase C rail). */
export const CREDIT_BOOK_NW = 0.50;
/** Originated face to one rival ≤ this share of NW. */
export const PRIVATE_OBLIGOR_NW = 0.15;
/** At most this many live asks — a shortlist, not a marketplace. */
const MAX_ASKS = 2;
/** Ask lives two months; silence is a pass. */
const ASK_LIFE_M = 2;
/** At most this many live borrow quotes to you. */
const MAX_BORROW_QUOTES = 2;
/** Cheap desks — if these clear the balloon, private money stays quiet. */
const CHEAP_DESKS = new Set(["savings", "harbor", "pelican", "conduit"]);
/** Rival styles that will write short, expensive bridges. */
const PRIVATE_LENDER_STYLES = new Set(["opportunistic", "pe", "vulture", "merchant"]);

/** Face you have already written that is still on the book. */
export function privateBookFace(s: GameState): number {
  return (s.notes ?? [])
    .filter((n) => n.privateOriginated)
    .reduce((a, n) => a + n.face, 0);
}

/**
 * HOW MUCH MORE FACE YOU CAN WRITE. Cash sleeve + NW rail. Unlevered — the
 * LOC is for buildings, not for warehousing other people's mortgages.
 */
export function privateSleeveCapacity(s: GameState, parcels: ParcelTable): number {
  const nw = Math.max(0, netWorth(s, parcels));
  const byNw = Math.max(0, nw * PRIVATE_BOOK_NW - privateBookFace(s));
  const byCash = Math.max(0, s.cash - PRIVATE_CASH_RESERVE);
  const byBook = creditBookRoom(s, parcels);
  return Math.floor(Math.min(byNw, byCash, byBook));
}

/** Purchased notes at basis + originated face — the whole credit sleeve. */
export function creditBookFace(s: GameState): number {
  const purchased = (s.notes ?? [])
    .filter((n) => !n.privateOriginated)
    .reduce((a, n) => a + n.basis, 0);
  return privateBookFace(s) + purchased;
}

/** How much more credit face/basis you can still put on. */
export function creditBookRoom(s: GameState, parcels: ParcelTable): number {
  const nw = Math.max(0, netWorth(s, parcels));
  return Math.max(0, Math.floor(nw * CREDIT_BOOK_NW - creditBookFace(s)));
}

/** Originated face already out to one rival. */
export function privateObligorFace(s: GameState, rivalId: string): number {
  return (s.notes ?? [])
    .filter((n) => n.privateOriginated && n.obligorId === rivalId)
    .reduce((a, n) => a + n.face, 0);
}

/**
 * Drop or transfer the cityLoans row in your name.
 * Payoff / deed → delete. Sale of the note → rename the lender; the obligor's
 * debt stays — you transferred the claim, you did not forgive it.
 */
export function releasePrivateStreetRecord(s: GameState, n: Note, newLender?: string) {
  if (!n.privateOriginated) return;
  const row = s.cityLoans?.[n.bbl];
  if (!row || !s.cityLoans || row.lender !== firmShort(s)) return;
  if (newLender) row.lender = newLender;
  else delete s.cityLoans[n.bbl];
}

/** Extinguish the claim — rival debt down and street record cleared. */
export function clearPrivateOrigination(s: GameState, n: Note) {
  if (!n.privateOriginated) return;
  const r = s.rivals?.find((x) => x.id === n.obligorId);
  if (r) r.debt = Math.max(0, r.debt - n.face);
  releasePrivateStreetRecord(s, n);
}

function deedAlreadyLiens(s: GameState, bbl: string): boolean {
  if ((s.notes ?? []).some((n) => n.bbl === bbl)) return true;
  if (s.cityLoans?.[bbl]) return true;
  if (s.holdings[bbl]?.loan) return true;
  return false;
}

function rivalNeedsPrivate(
  s: GameState, r: Rival, asIs: number,
): { face: number; why: string } | null {
  if (r.failedM !== undefined || !r.bbls.length) return null;
  const stressed = (r.stressMs ?? 0) >= 3;
  const dry = r.cash < Math.max(200_000, 0.02 * Math.max(1, r.aum ?? 0));
  const balloonSoon = Object.values(r.extendedTo ?? {}).some((m) => m - s.month <= 6 && m >= s.month);
  if (!stressed && !dry && !balloonSoon) return null;

  // Size: bridge, not a permanent takeout — 55–68% of as-is, capped.
  const ltv = cl(0.55, 0.68, 0.55 + ((r.stressMs ?? 0) > 8 ? 0.08 : 0));
  let face = Math.round(asIs * ltv / 25_000) * 25_000;
  face = cl(250_000, 12_000_000, face);
  if (face < 250_000 || asIs < face / 0.7) return null;

  const alden = lenderByName(s, "Alden National");
  const cordage = lenderByName(s, "Cordage Debt Partners");
  const bankShut = !alden || (alden.appetite ?? 1) < 0.2 || alden.failedM !== undefined;
  const why = bankShut
    ? "The banks have stopped answering. They need a cheque that clears this month."
    : balloonSoon
      ? "A balloon is inside six months and the cheap desks will not re-paper it in time."
      : cordage && (s.econ.creditIdx ?? 1) < 0.85
        ? "Cordage would do it — at a coupon that eats the deal. They are asking if you will."
        : stressed
          ? "They are in a squeeze. Sponsor standing and cash both look wrong to a bank."
          : "Cash is thin against the book and they will not sell the trophy to raise it.";
  return { face, why };
}

/** Spawn / expire private asks. */
export function tickPrivateCredit(s: GameState, parcels: ParcelTable) {
  if (!s.privateAsks) s.privateAsks = [];

  // Expire
  for (let i = s.privateAsks.length - 1; i >= 0; i--) {
    const a = s.privateAsks[i];
    if (s.month < a.expiresM) continue;
    s.privateAsks.splice(i, 1);
    // They went somewhere — Cordage, a sale, or they ate the balloon.
    if (rng(s) < 0.4) {
      s.news.unshift({
        q: s.month, kind: "rumor",
        text: `${a.rivalName} found money elsewhere for ${a.address} — or did not. `
          + `The ask to ${firmShort(s)} lapsed.`,
      });
    }
  }

  if (s.privateAsks.length >= MAX_ASKS) return;
  const sleeve = privateSleeveCapacity(s, parcels);
  if (sleeve < 250_000) return;

  // One attempt per month — episodic, not a feed.
  if (rng(s) > 0.22) return;

  const candidates: { r: Rival; bbl: string; asIs: number; face: number; why: string }[] = [];
  for (const r of s.rivals ?? []) {
    if (r.failedM !== undefined) continue;
    for (const bbl of r.bbls) {
      if (deedAlreadyLiens(s, bbl)) continue;
      if (s.privateAsks.some((a) => a.bbl === bbl || a.rivalId === r.id)) continue;
      const rec = resolveRec(parcels, s, bbl);
      if (!rec || rec.class === "land" || !rec.bldgArea) continue;
      const asIs = Math.round(collateralAsIs(rec, s.econ, r.occ ?? 0.7)
        || assetValue(rec, s.econ, assetGrade(r, rec)));
      if (asIs < 400_000) continue;
      const need = rivalNeedsPrivate(s, r, asIs);
      if (!need) continue;
      if (need.face > sleeve) continue;
      candidates.push({ r, bbl, asIs, face: need.face, why: need.why });
    }
  }
  if (!candidates.length) return;
  const pick = candidates[Math.floor(rng(s) * candidates.length)];
  const rec = resolveRec(parcels, s, pick.bbl)!;
  const ratePct = +(s.econ.indexRate + rrange(s, 6.0, 9.0)).toFixed(2);
  const points = +rrange(s, 0.012, 0.028).toFixed(3);
  const termM = Math.round(rrange(s, 6, 18));
  const ask: PrivateCreditAsk = {
    id: "P" + (s.nextPrivateAskId = (s.nextPrivateAskId ?? 1) + 1),
    rivalId: pick.r.id,
    rivalName: pick.r.name,
    bbl: pick.bbl,
    address: rec.address,
    face: pick.face,
    ratePct,
    points,
    termM,
    ltv: pick.face / Math.max(1, pick.asIs),
    asIs: pick.asIs,
    why: pick.why,
    offeredM: s.month,
    expiresM: s.month + ASK_LIFE_M,
  };
  s.privateAsks.push(ask);
  s.news.unshift({
    q: s.month, kind: "rumor",
    text: `${ask.rivalName} is asking ${firmShort(s)} for ${money(ask.face)} against ${ask.address} `
      + `— ${ask.ratePct.toFixed(2)}%, ${(ask.points * 100).toFixed(1)} points, ${ask.termM} months. `
      + ask.why,
  });
}

/**
 * FUND THE ASK. Cash out, points in, rival gets the advance, you hold a Note.
 */
export function fundPrivateAsk(
  s: GameState, parcels: ParcelTable, id: string,
): { s: GameState; err?: string; msg?: string } {
  const ask = s.privateAsks?.find((a) => a.id === id);
  if (!ask) return { s, err: "That ask is gone." };
  if (s.month > ask.expiresM) return { s, err: "That ask has lapsed." };
  const r = s.rivals?.find((x) => x.id === ask.rivalId);
  if (!r || r.failedM !== undefined) return { s, err: "The borrower is no longer a going concern." };
  if (!r.bbls.includes(ask.bbl)) return { s, err: "They no longer own the collateral." };
  if (deedAlreadyLiens(s, ask.bbl)) return { s, err: "There is already a lien on that deed." };

  const pointsCost = Math.round(ask.face * ask.points);
  // You fund face from cash; points are paid by the borrower from the advance
  // (standard hard-money: net cheque = face × (1 − points)).
  const netToBorrower = ask.face - pointsCost;
  const sleeve = privateSleeveCapacity(s, parcels);
  if (ask.face > sleeve) {
    return { s, err: `Your private sleeve will only carry another ${money(sleeve)} of face.` };
  }
  if (s.cash < ask.face + PRIVATE_CASH_RESERVE) {
    return { s, err: `Funding ${money(ask.face)} would leave you under the ${money(PRIVATE_CASH_RESERVE)} cash reserve.` };
  }
  const nw = Math.max(0, netWorth(s, parcels));
  const obligorCap = Math.max(0, nw * PRIVATE_OBLIGOR_NW - privateObligorFace(s, ask.rivalId));
  if (ask.face > obligorCap) {
    return {
      s,
      err: `You already have enough paper on ${ask.rivalName} — single-obligor cap leaves ${money(obligorCap)}.`,
    };
  }

  const next = clone(s);
  const rival = next.rivals!.find((x) => x.id === ask.rivalId)!;
  const rec = resolveRec(parcels, next, ask.bbl);
  if (!rec) return { s, err: "The parcel is gone." };

  next.cash -= ask.face;
  logBooks(next, "bought", ask.face); // capital deployed into a claim
  // Points are fee income the month you close — borrower net is face − points.
  next.cash += pointsCost;
  logBooks(next, "interest", pointsCost);

  rival.cash += netToBorrower;
  rival.debt += ask.face;
  if ((rival.stressMs ?? 0) > 0) rival.stressMs = Math.max(0, (rival.stressMs ?? 0) - 2);

  if (!next.cityLoans) next.cityLoans = {};
  next.cityLoans[ask.bbl] = {
    bbl: ask.bbl,
    lender: firmShort(next),
    obligorId: rival.id,
    balance: ask.face,
    ratePct: ask.ratePct,
    originM: next.month,
    maturityM: next.month + ask.termM,
    origValue: ask.asIs,
    klass: rec.class,
    status: "current",
  };

  if (!next.notes) next.notes = [];
  next.notes.push({
    id: "N" + (next.nextNoteId = (next.nextNoteId ?? 1) + 1),
    bbl: ask.bbl,
    address: ask.address,
    originator: firmShort(next),
    obligorId: rival.id,
    obligor: rival.name,
    face: ask.face,
    ratePct: ask.ratePct,
    maturityM: next.month + ask.termM,
    perf: "performing",
    boughtM: next.month,
    basis: ask.face, // carry at face; points already taken as income
    collected: pointsCost,
    mods: 0,
    privateOriginated: true,
  });

  next.privateAsks = (next.privateAsks ?? []).filter((a) => a.id !== ask.id);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `${firmShort(next)} has written ${money(ask.face)} of private paper on ${ask.address} to ${rival.name} — `
      + `${ask.ratePct.toFixed(2)}%, ${(ask.points * 100).toFixed(1)} points, due ${monthLabel(next.month + ask.termM)}. `
      + `They cleared ${money(netToBorrower)} after points. You are the lender of record.`,
  });
  return {
    s: next,
    msg: `Funded ${money(ask.face)} · ${money(pointsCost)} points in.`,
  };
}

export function declinePrivateAsk(s: GameState, id: string): { s: GameState; err?: string; msg?: string } {
  const ask = s.privateAsks?.find((a) => a.id === id);
  if (!ask) return { s, err: "That ask is gone." };
  const next = clone(s);
  next.privateAsks = (next.privateAsks ?? []).filter((a) => a.id !== id);
  next.news.unshift({
    q: next.month, kind: "info",
    text: `${firmShort(next)} passed on ${ask.rivalName}'s ask against ${ask.address}. `
      + `They will try Cordage, sell something, or eat the balloon.`,
  });
  return { s: next, msg: "Passed." };
}

// ---------------------------------------------------------------------------
// Phase B — YOU borrow private
// ---------------------------------------------------------------------------

function rivalCanLend(r: Rival, need: number): boolean {
  if (r.failedM !== undefined) return false;
  if (!PRIVATE_LENDER_STYLES.has(r.style)) return false;
  // Keep a reserve so lending does not instantly insolvent them.
  return r.cash >= need + Math.max(250_000, 0.05 * Math.max(1, r.aum ?? 0));
}

/**
 * When cheap desks cannot clear a takeout (or a balloon file is open), a rival
 * with powder may quote. Cordage may still be open — this is episodic capital
 * from a named firm, not a fourth permanent product chip.
 */
function playerNeedsPrivateBorrow(
  s: GameState, parcels: ParcelTable, bbl: string,
): { principal: number; asIs: number; why: string } | null {
  const h = s.holdings[bbl];
  const rec = resolveRec(parcels, s, bbl);
  if (!h || !rec || rec.class === "land" || !rec.bldgArea) return null;
  if (s.facility?.bbls.includes(bbl)) return null;
  if (h.loan?.product === "cordage" && h.loan.holder && !h.loan.holder.includes("Cordage")) {
    // Already on private paper from a named holder — no stack.
    return null;
  }
  // Mezz must be cleared in a takeout — do not quote a bridge that would
  // orphan the junior (accept pays it; spawn waits until the stack is clean).
  if (h.mezz && h.mezz.balance > 0) return null;
  // Fresh paper — bank or private — is not re-bridged for a year. Stops the
  // bot (and a panicked player) from churning 6-month bridges every quarter.
  if (h.loan && s.month - h.loan.originM < 12) return null;
  // A private bridge on this deed cools for two years even if you take it out
  // with a bank — otherwise the desk becomes a revolving door.
  if (h.lastPrivateBridgeM !== undefined && s.month - h.lastPrivateBridgeM < 36) return null;

  const { quotes, value, payoff } = refiQuotes(s, parcels, bbl);
  if (value < 400_000) return null;
  const asIs = Math.round(value);

  const cheap = quotes.filter((q) => CHEAP_DESKS.has(q.id));
  const bestCheap = Math.max(0, ...cheap.filter((q) => q.available).map((q) => q.maxProceeds));
  const cordage = quotes.find((q) => q.id === "cordage");
  const cordagePx = cordage?.available ? cordage.maxProceeds : 0;

  const balloonFile = s.workouts?.[bbl]?.cause === "balloon";
  const dueSoon = !!h.loan && h.loan.maturityM - s.month <= 6;
  const cheapGap = payoff > 0 && bestCheap < payoff * 0.95;
  const shutOut = cheap.every((q) => !q.available);
  if (!balloonFile && !dueSoon && !cheapGap && !shutOut) return null;
  // If a cheap desk already clears you, private money has nothing to say.
  if (payoff > 0 && bestCheap >= payoff) return null;

  const ltv = cl(0.55, 0.68, 0.58 + (balloonFile ? 0.06 : 0));
  let principal = Math.round((asIs * ltv) / 25_000) * 25_000;
  principal = cl(250_000, 12_000_000, principal);
  // A quote that cannot touch the balloon is noise — size at least toward payoff.
  if (payoff > 0) principal = Math.max(principal, Math.min(Math.round(payoff / 25_000) * 25_000, Math.round(asIs * 0.7)));
  if (principal < 250_000) return null;

  const why = balloonFile
    ? "The balloon file is open and the cheap desks will not clear it."
    : shutOut
      ? "Institutional desks will not look at you. Somebody with a cheque still will."
      : cheapGap
        ? `The banks top out around ${money(bestCheap)} against ${money(payoff)} due — a hold size or a coverage wall.`
        : dueSoon
          ? "A maturity is inside six months and the permanent market is not covering the takeout."
          : "The cheap paper is gone; this is bridge money.";
  // Prefer not to spam when Cordage already fully covers — still allow if the
  // file is open (speed / certainty) or Cordage itself is short.
  if (!balloonFile && cordagePx >= payoff && payoff > 0 && rng(s) > 0.35) return null;
  return { principal, asIs, why };
}

/** Spawn / expire private borrow quotes to the player. */
export function tickPrivateBorrow(s: GameState, parcels: ParcelTable) {
  if (!s.privateBorrowQuotes) s.privateBorrowQuotes = [];

  for (let i = s.privateBorrowQuotes.length - 1; i >= 0; i--) {
    const q = s.privateBorrowQuotes[i];
    if (s.month < q.expiresM) continue;
    s.privateBorrowQuotes.splice(i, 1);
    if (rng(s) < 0.45) {
      s.news.unshift({
        q: s.month, kind: "rumor",
        text: `${q.lenderName}'s private quote on ${q.address} lapsed. `
          + `Cordage, a sale, or the cure cheque — those are what is left.`,
      });
    }
  }

  if (s.privateBorrowQuotes.length >= MAX_BORROW_QUOTES) return;
  if (rng(s) > 0.28) return;

  const candidates: {
    bbl: string; principal: number; asIs: number; why: string; lender: Rival;
  }[] = [];

  for (const h of Object.values(s.holdings)) {
    if (s.privateBorrowQuotes.some((q) => q.bbl === h.bbl)) continue;
    const need = playerNeedsPrivateBorrow(s, parcels, h.bbl);
    if (!need) continue;
    const lenders = (s.rivals ?? []).filter((r) => rivalCanLend(r, need.principal));
    if (!lenders.length) continue;
    const lender = lenders[Math.floor(rng(s) * lenders.length)];
    candidates.push({ bbl: h.bbl, ...need, lender });
  }
  if (!candidates.length) return;

  const pick = candidates[Math.floor(rng(s) * candidates.length)];
  const rec = resolveRec(parcels, s, pick.bbl)!;
  const ratePct = +(s.econ.indexRate + rrange(s, 6.0, 9.0)).toFixed(2);
  const points = +rrange(s, 0.012, 0.028).toFixed(3);
  const termM = Math.round(rrange(s, 6, 18));
  const quote: PrivateBorrowQuote = {
    id: "B" + (s.nextPrivateBorrowId = (s.nextPrivateBorrowId ?? 1) + 1),
    lenderId: pick.lender.id,
    lenderName: pick.lender.name,
    bbl: pick.bbl,
    address: rec.address,
    principal: pick.principal,
    ratePct,
    points,
    termM,
    ltv: pick.principal / Math.max(1, pick.asIs),
    asIs: pick.asIs,
    why: pick.why,
    offeredM: s.month,
    expiresM: s.month + ASK_LIFE_M,
  };
  s.privateBorrowQuotes.push(quote);
  s.news.unshift({
    q: s.month, kind: "rumor",
    text: `${quote.lenderName} will write ${money(quote.principal)} of private paper on ${quote.address} — `
      + `${quote.ratePct.toFixed(2)}%, ${(quote.points * 100).toFixed(1)} points, ${quote.termM} months. `
      + quote.why,
  });
}

function buildPrivateLoan(s: GameState, q: PrivateBorrowQuote): Loan {
  const pmt = Math.round((q.principal * q.ratePct) / 100 / 12);
  return {
    product: "cordage",
    holder: q.lenderName,
    floating: true,
    points: q.points,
    recourse: false,
    prepay: "open",
    prepayUntilM: s.month,
    principal: q.principal,
    balance: q.principal,
    ratePct: q.ratePct,
    spread: +(q.ratePct - s.econ.indexRate).toFixed(2),
    ioUntilM: s.month + q.termM,
    amortYears: 30,
    maturityM: s.month + q.termM,
    monthlyPmt: pmt,
    minDSCR: 0.90,
    maxLTV: 0.92,
    sweep: false,
    cleanQs: 0,
    originM: s.month,
    origValue: Math.round(q.asIs),
  };
}

/**
 * TAKE THE PRIVATE BRIDGE. Same conserve shape as refinance: pay off the old
 * lien, book net draw, put Cordage-shaped paper on the deed with the rival as
 * holder. Their cash funds the advance.
 */
export function acceptPrivateBorrowQuote(
  s: GameState, parcels: ParcelTable, id: string,
): { s: GameState; err?: string; msg?: string } {
  const quote = s.privateBorrowQuotes?.find((q) => q.id === id);
  if (!quote) return { s, err: "That quote is gone." };
  if (s.month > quote.expiresM) return { s, err: "That quote has lapsed." };
  const h = s.holdings[quote.bbl];
  const rec = resolveRec(parcels, s, quote.bbl);
  if (!h || !rec) return { s, err: "You don't own that." };
  if (s.facility?.bbls.includes(quote.bbl)) {
    return { s, err: "This deed is pledged to your facility. Release it first." };
  }
  const lender = s.rivals?.find((r) => r.id === quote.lenderId);
  if (!lender || lender.failedM !== undefined) {
    return { s, err: "That lender is no longer writing paper." };
  }
  if (!rivalCanLend(lender, quote.principal)) {
    return { s, err: `${lender.name} no longer has the powder to fund this.` };
  }

  const pointsFee = Math.round(quote.principal * quote.points);
  const seniorBal = h.loan?.balance ?? 0;
  const mezzBal = h.mezz?.balance ?? 0;
  const oldBal = seniorBal + mezzBal;
  const penalty = (h.loan ? prepayPenalty(h.loan, s.month) : 0)
    + (h.mezz ? prepayPenalty(h.mezz, s.month) : 0);
  // Bridge closes without a bank rate-cap tax — the coupon is already the hedge.
  const fee = pointsFee + penalty;
  const need = Math.max(0, oldBal + fee - quote.principal);
  if (need > 0 && fundableNow(s, parcels) < need) {
    return {
      s,
      err: penalty > 0
        ? `Proceeds don't cover the payoff after ${money(penalty)} to break the old paper.`
        : mezzBal > 0
          ? "Proceeds don't cover the senior and the mezz — you're underwater on this bridge."
          : "Proceeds don't cover the payoff — you're underwater on this bridge.",
    };
  }

  const next = clone(s);
  const holding = next.holdings[quote.bbl]!;
  const rival = next.rivals!.find((r) => r.id === quote.lenderId)!;
  const netToYou = quote.principal - pointsFee;
  const netDraw = quote.principal - oldBal;

  // Lender wires face; keeps points; borrower nets face − points before payoff maths.
  rival.cash -= netToYou;
  next.cash += netDraw - fee;
  coverCashShortfall(next, parcels);
  if (fee > 0) logBooks(next, "debtSvc", fee);
  if (netDraw > 0) logBooks(next, "borrowed", netDraw);
  else if (netDraw < 0) logBooks(next, "debtSvc", -netDraw);

  holding.loan = buildPrivateLoan(next, quote);
  holding.lastPrivateBridgeM = next.month;
  // Private takeout retires the whole stack — mezz does not float free.
  if (holding.mezz) holding.mezz = null;
  if (next.workouts?.[quote.bbl]) delete next.workouts[quote.bbl];
  next.privateBorrowQuotes = (next.privateBorrowQuotes ?? []).filter((q) => q.id !== id);
  // Player mortgages live on Holding.loan — cityLoans is the rival street
  // projection and would delete a "player" obligor on the next ledger tick.

  next.news.unshift({
    q: next.month, kind: "deal",
    text: `${quote.lenderName} has written ${money(quote.principal)} of private paper on ${quote.address} to ${firmShort(next)} — `
      + `${quote.ratePct.toFixed(2)}%, ${(quote.points * 100).toFixed(1)} points, due ${monthLabel(next.month + quote.termM)}. `
      + (penalty > 0 ? `Breaking the old loan cost ${money(penalty)}. ` : "")
      + `You cleared ${money(Math.max(0, netToYou - oldBal - penalty))} after the takeout.`,
  });
  sweepLocIdleCash(next, { announce: true });
  return {
    s: next,
    msg: `Borrowed ${money(quote.principal)} from ${quote.lenderName}.`,
  };
}

export function declinePrivateBorrowQuote(
  s: GameState, id: string,
): { s: GameState; err?: string; msg?: string } {
  const quote = s.privateBorrowQuotes?.find((q) => q.id === id);
  if (!quote) return { s, err: "That quote is gone." };
  const next = clone(s);
  next.privateBorrowQuotes = (next.privateBorrowQuotes ?? []).filter((q) => q.id !== id);
  next.news.unshift({
    q: next.month, kind: "info",
    text: `${firmShort(next)} passed on ${quote.lenderName}'s private quote against ${quote.address}. `
      + `The banks, Cordage, or the cure cheque — pick one before the file hardens.`,
  });
  return { s: next, msg: "Passed." };
}
