// SELLING A BOOK IN ONE TICKET.
//
// Everything in this game trades one building at a time, and that is not how
// the biggest transactions in this business happen. A fund winds down and sells
// eleven buildings to one buyer. A bank that has foreclosed on a borrower's
// whole relationship does not want eleven separate closings; it wants the
// problem off its balance sheet in one afternoon. And a principal who has spent
// twenty years assembling a portfolio does not liquidate it lot by lot into a
// market that will notice what he is doing by the third one.
//
// Two things follow, and they are the whole of this file.
//
// PORTFOLIOS TRADE AT A DISCOUNT, because the cheque is enormous and the number
// of people who can write it is small. That is the size discount, and it is
// real: a package of assets is worth less per building than the sum of its
// buildings, unless the buyer wants scale badly enough to pay for it.
//
// AND A RECEIVER'S BOOK WALKS ITS OWN PRICE DOWN. A bank that has taken a
// portfolio into receivership is not a landlord and does not want to be one. It
// puts the book out at a price a little under the market, and if nobody comes,
// it cuts — every quarter, forever, until somebody does. That is the mechanism
// by which bad debt eventually finds a clearing price instead of sitting on the
// tape at a number nobody will pay.
import type { GameState, PortfolioListing } from "./types";
import type { ParcelTable } from "../data/types";
import { rng, rrange } from "./market";
import { assetValue, capRateFor, collateralAsIs, inPlace, resolveRec } from "./value";
import { livingRivals, gradeOf, ownerOf, STYLE_OF, receiverDeskFor, forgetDeed } from "./rivals";
import { lenderByName, lenderPressure, raiseAlert } from "./lenders";
import { streetRefiProceeds } from "./debt";
import { acceptSaleOffer, executePurchase } from "./actions";
import { cloneState } from "./types";
import { sweepLocIdleCash } from "./credit";

const money = (n: number) =>
  Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}K`;

/**
 * THE SIZE DISCOUNT.
 *
 * Two buildings are a pair of deals. Eleven are a transaction with a shortlist
 * of maybe three counterparties in the city, and every one of them knows it.
 * Six per cent off at four buildings, widening toward eighteen at twenty — and
 * WIDER when credit is shut, because the number of people who can fund a
 * hundred-million-dollar cheque in a bad year is the whole story of what
 * distressed portfolios clear at.
 */
export function sizeDiscount(n: number, creditIdx: number): number {
  const base = Math.min(0.18, 0.02 + 0.016 * Math.max(0, n - 1));
  const shut = Math.max(0, 1 - creditIdx);
  return Math.min(0.34, base * (1 + 1.5 * shut));
}

/** What the individual buildings are worth, before the discount for buying them together. */
export function grossOf(s: GameState, parcels: ParcelTable, bbls: string[]): number {
  let v = 0;
  for (const b of bbls) {
    const rec = resolveRec(parcels, s, b);
    if (rec) v += assetValue(rec, s.econ, gradeOf(s, rec));
  }
  return v;
}

/** The debt riding on the player's own buildings in a package — it has to be paid off at close. */
export function playerDebtOn(s: GameState, bbls: string[]): number {
  let d = 0;
  for (const b of bbls) {
    const h = s.holdings[b];
    if (h?.loan) d += h.loan.balance ?? 0;
  }
  return d;
}

/**
 * WHAT A BUYER UNDERWRITES WHEN THEY OPEN A STREET / REO BOOK.
 *
 * The Marketplace card used to show ask, gross and a discount — three price
 * numbers and nothing about the income. A package is a going-in yield decision
 * against a cash cheque; without occupancy and NOI the discount is scenery.
 *
 * REO books use the same worn + borrower-occ basis the foreclosure auction
 * sheet already shows (`collateralAsIs` / `capRateFor(worn)`). Fund wind-downs
 * and player packages use `inPlace` — disclosed roll when one exists, market
 * model otherwise — so the card cannot invent a happier rent roll than the
 * engine will hand you at close.
 */
export type StreetBookAsset = {
  bbl: string;
  address: string;
  cls: string;
  sf: number;
  floors: number;
  yearBuilt: number;
  val: number;
  askShare: number;
  noi: number;
  occ: number;
  land: boolean;
  disclosed: boolean;
};

export type StreetBookStats = {
  totSf: number;
  leasedSf: number;
  /** SF-weighted occupancy across operated buildings; null if the book is all land. */
  occ: number | null;
  noi: number;
  yieldOnAsk: number | null;
  yieldOnGross: number | null;
  askPsf: number | null;
  byClass: { cls: string; n: number; sf: number; noi: number }[];
  assets: StreetBookAsset[];
  /** Where the income reading came from — drives the hint on the card. */
  basis: "receiver" | "disclosed" | "market" | "mixed";
};

export function streetBookStats(
  s: GameState, parcels: ParcelTable, p: PortfolioListing,
): StreetBookStats {
  const borrower = p.reoBorrower
    ? (s.rivals ?? []).find((r) => r.name === p.reoBorrower)
    : p.sellerId
      ? (s.rivals ?? []).find((r) => r.id === p.sellerId)
      : null;
  // Receiver books: underwrite worn at the borrower's book occupancy — the
  // same reading the July docket uses. A failed sponsor's `occ` is why the
  // package is cheap; pricing it at citywide market would lie.
  const receiverOcc = p.reo
    ? Math.max(0.15, Math.min(0.95, borrower?.occ ?? 0.4))
    : null;

  const vals = p.bbls.map((bbl) => {
    const rec = resolveRec(parcels, s, bbl);
    const val = rec ? Math.max(1, assetValue(rec, s.econ, gradeOf(s, rec))) : 1;
    return { bbl, rec, val };
  });
  const totV = vals.reduce((a, x) => a + x.val, 0) || 1;

  const assets: StreetBookAsset[] = [];
  let totSf = 0, leasedSf = 0, noi = 0;
  let anyDisc = false, anyMkt = false, anyRecv = false;
  const classMap = new Map<string, { n: number; sf: number; noi: number }>();

  for (const { bbl, rec, val } of vals) {
    const askShare = Math.max(1000, Math.round(p.ask * (val / totV)));
    if (!rec) {
      assets.push({
        bbl, address: bbl, cls: "?", sf: 0, floors: 0, yearBuilt: 0,
        val: 0, askShare, noi: 0, occ: 0, land: true, disclosed: false,
      });
      continue;
    }
    const land = rec.class === "land" || !rec.bldgArea;
    let assetNoi = 0, occ = 0, disclosed = false;
    if (land) {
      assetNoi = 0;
      occ = 0;
      disclosed = true;
    } else if (receiverOcc !== null) {
      const asIs = collateralAsIs(rec, s.econ, receiverOcc);
      const cap = capRateFor(rec, s.econ, "worn");
      assetNoi = cap > 0 ? Math.round(asIs * cap / 100) : 0;
      occ = receiverOcc;
      disclosed = true;
      anyRecv = true;
    } else {
      const ip = inPlace(rec, s, bbl, askShare);
      assetNoi = Math.round(ip.noi);
      occ = ip.occ;
      disclosed = ip.disclosed;
      if (disclosed) anyDisc = true;
      else anyMkt = true;
    }
    const sf = land ? 0 : rec.bldgArea;
    totSf += sf;
    leasedSf += Math.round(sf * occ);
    noi += assetNoi;
    const cls = land ? "land" : rec.class;
    const bucket = classMap.get(cls) ?? { n: 0, sf: 0, noi: 0 };
    bucket.n++; bucket.sf += sf; bucket.noi += assetNoi;
    classMap.set(cls, bucket);
    assets.push({
      bbl,
      address: rec.address ?? bbl,
      cls,
      sf,
      floors: rec.floors ?? 0,
      yearBuilt: rec.yearBuilt ?? 0,
      val,
      askShare,
      noi: assetNoi,
      occ,
      land,
      disclosed,
    });
  }

  assets.sort((a, b) => b.val - a.val);
  const byClass = [...classMap.entries()]
    .map(([cls, v]) => ({ cls, ...v }))
    .sort((a, b) => b.sf - a.sf || b.n - a.n);

  let basis: StreetBookStats["basis"] = "market";
  if (anyRecv && !anyDisc && !anyMkt) basis = "receiver";
  else if (anyDisc && !anyMkt && !anyRecv) basis = "disclosed";
  else if (anyMkt && !anyDisc && !anyRecv) basis = "market";
  else if (anyRecv || anyDisc || anyMkt) basis = "mixed";

  return {
    totSf,
    leasedSf,
    occ: totSf > 0 ? leasedSf / totSf : null,
    noi,
    yieldOnAsk: p.ask > 0 ? noi / p.ask : null,
    yieldOnGross: p.gross > 0 ? noi / p.gross : null,
    askPsf: totSf > 0 ? p.ask / totSf : null,
    byClass,
    assets,
    basis,
  };
}

// ---------------------------------------------------------------------------
// LISTING ONE (street book on game.portfolios — not portfolio.ts listPortfolio,
// which is the player's own marketed portfolioSale).
// ---------------------------------------------------------------------------
export function listStreetPortfolio(
  s: GameState, parcels: ParcelTable, bbls: string[], askOverride?: number,
): { s: GameState; err?: string; msg?: string } {
  const clean = [...new Set(bbls)].filter((b) => s.holdings[b] && !s.listings.some((l) => l.bbl === b));
  if (clean.length < 2) return { s, err: "A portfolio sale needs at least two buildings you own and have not already listed." };
  if ((s.portfolios ?? []).some((p) => p.player)) return { s, err: "You already have a package on the market. One at a time." };
  // Same crossed-deed wall as portfolio.listPortfolio — a package close is one
  // trade with no per-deed release table, so pledging facility collateral into
  // it used to walk the deeds off and leave the facility balance behind.
  const crossed = clean.filter((b) => s.facility?.bbls.includes(b));
  if (crossed.length > 0) {
    return { s, err: `${crossed.length} of these are pledged to your facility. Release them first, or sell them individually.` };
  }
  const inWorkout = clean.filter((b) => s.workouts?.[b]);
  if (inWorkout.length > 0) {
    return { s, err: `${inWorkout.length} of these are in workout. Cure or deed them back before packaging.` };
  }
  const gross = grossOf(s, parcels, clean);
  if (gross <= 0) return { s, err: "Those parcels are not worth anything to package." };
  const disc = sizeDiscount(clean.length, s.econ.creditIdx ?? 1);
  const guide = Math.round(gross * (1 - disc) / 1000) * 1000;
  const ask = askOverride && askOverride > 0 ? Math.round(askOverride / 1000) * 1000 : guide;
  s.portfolios ??= [];
  s.portfolios.push({
    id: `pf${s.nextPortfolioId = (s.nextPortfolioId ?? 1) + 1}`,
    bbls: clean, ask, gross, listedM: s.month,
    expiresM: s.month + 18, cuts: 0, player: true,
    reason: "Offered as one package.",
  });
  for (const b of clean) { const h = s.holdings[b]; if (h) h.inPackage = true; }
  s.news.unshift({
    q: s.month, kind: "deal",
    text: `You have taken ${clean.length} buildings to market as one package at ${money(ask)}. `
      + `The parts appraise at ${money(gross)}; a book this size trades ${(disc * 100).toFixed(0)}% back from that, `
      + `because the list of people who can close it in one go is short and every one of them knows it.`,
  });
  return { s, msg: `${clean.length} buildings offered as one package at ${money(ask)}.` };
}

export function withdrawPortfolio(s: GameState, id: string): GameState {
  const p = (s.portfolios ?? []).find((x) => x.id === id);
  if (!p) return s;
  for (const b of p.bbls) { const h = s.holdings[b]; if (h) delete h.inPackage; }
  s.portfolios = (s.portfolios ?? []).filter((x) => x.id !== id);
  return s;
}

/** The player buying somebody else's book, in one transaction. */
export function buyPortfolio(
  s: GameState, parcels: ParcelTable, id: string,
): { s: GameState; err?: string; msg?: string } {
  const p = (s.portfolios ?? []).find((x) => x.id === id);
  if (!p || p.player) return { s, err: "That package is no longer available." };
  // ONE CHEQUE, AND THERE IS NO FINANCING IT AT THE TABLE. That is the whole
  // reason a portfolio trades back from the sum of its parts, and making the
  // player raise the full amount in cash is what makes the discount earned
  // rather than free money.
  const closing = Math.round(p.ask * 0.02);
  if (s.cash < p.ask + closing) {
    return { s, err: `You are ${money(p.ask + closing - s.cash)} short. A package is one cheque — nobody lends against a book you do not own yet.` };
  }
  const seller = p.sellerId ? (s.rivals ?? []).find((r) => r.id === p.sellerId) : null;
  const sellerName = seller?.name ?? p.sellerLender ?? "a receiver";
  // Allocate the price across the buildings by what each is worth, so the
  // basis on each deed is honest and the tax on a later sale is right.
  const vals = p.bbls.map((b) => {
    const rec = resolveRec(parcels, s, b);
    return { b, v: rec ? Math.max(1, assetValue(rec, s.econ, gradeOf(s, rec))) : 1 };
  });
  const tot = vals.reduce((a, x) => a + x.v, 0) || 1;
  // ALL OR NOTHING. Skipping a blocked deed and still dropping the package
  // used to charge the full ask, convey a subset, and leave the rest with the
  // seller while the listing vanished — a partial close pretending to be one.
  let cur = s;
  const taken: string[] = [];
  for (const { b, v } of vals) {
    const share = Math.max(1000, Math.round(p.ask * (v / tot)));
    const r = executePurchase(cur, parcels, b, share, "cash", true, 1);
    if (r.err) {
      return {
        s,
        err: `Could not convey every deed in the package (${r.err}). Nothing has closed — raise the cash or leave the book.`,
      };
    }
    cur = r.s;
    taken.push(b);
  }
  if (!taken.length) return { s, err: "Nothing in that package could be conveyed." };
  cur.portfolios = (cur.portfolios ?? []).filter((x) => x.id !== id);
  cur.news.unshift({
    q: cur.month, kind: "deal",
    text: `You have bought ${taken.length} buildings from ${sellerName} in one transaction at ${money(p.ask)}. `
      + `The parts appraise at ${money(p.gross)} — ${((1 - p.ask / Math.max(1, p.gross)) * 100).toFixed(0)}% back. `
      + `Nobody else in town could write that cheque this month.`,
  });
  return { s: cur, msg: `${taken.length} buildings, one closing, ${money(p.ask)}.` };
}

// ---------------------------------------------------------------------------
// THE MONTHLY LIFE OF THE PACKAGE MARKET
// ---------------------------------------------------------------------------
export function tickPortfolios(s: GameState, parcels: ParcelTable) {
  s.portfolios ??= [];
  const ci = Math.max(0.4, Math.min(1.25, s.econ.creditIdx ?? 1));

  // --- 1. does anything on the tape find a buyer this month? ---------------
  for (const p of [...s.portfolios]) {
    // Re-mark: a package sitting unsold for three years is not still worth what
    // it was when it was listed, and the ask has to be read against today.
    p.gross = grossOf(s, parcels, p.bbls) || p.gross;

    // WHO CAN ACTUALLY CLOSE IT. The whole reason a portfolio trades back from
    // the sum of its parts is that this list is short: the buyer needs the
    // equity for the entire package at once, and the debt has to be lendable
    // against a book that just grew by eleven buildings.
    // Package NOI — what a desk would underwrite against the ticket, not a
    // personality LTV. Same hole acquisitionLoan closed for single assets.
    let packageNoi = 0;
    for (const b of p.bbls) {
      const rec = resolveRec(parcels, s, b);
      if (!rec || rec.class === "land" || !rec.bldgArea) continue;
      const share = p.ask / Math.max(1, p.bbls.length); // price allocation for inPlace
      packageNoi += Math.max(0, inPlace(rec, s, b, share).noi);
    }
    const packageDebt = (r: ReturnType<typeof livingRivals>[number]) => {
      const st = STYLE_OF(r.style);
      const cap = Math.min(r.targetLtv, st.maxLtv) * (ci < 0.8 ? 0.82 : 1);
      return Math.min(p.ask, streetRefiProceeds(s, p.ask, packageNoi, cap).principal);
    };
    const buyers = livingRivals(s).filter((r) => {
      if (r.id === p.sellerId) return false;
      const st = STYLE_OF(r.style);
      const debt = packageDebt(r);
      const equity = p.ask - debt;
      if (r.cash < equity + Math.max(1_000_000, r.cash * 0.05)) return false;
      const aumAfter = (r.aum ?? 0) + p.ask;
      if (aumAfter > 0 && (r.debt + debt) / aumAfter > st.maxLtv) return false;
      return true;
    });
    if (buyers.length) {
      // A rival buying a rival's book. Rare, and it is how the big get big.
      const hunger = buyers.map((r) => {
        const st = STYLE_OF(r.style);
        return { r, w: st.appetite * (1 + st.contra * (1 - ci)) * (p.reo ? st.distressBias : 1) * (0.5 + rng(s)) };
      }).sort((a, b) => b.w - a.w);
      const under = p.ask / Math.max(1, p.gross);
      // they take it when it is cheap enough relative to the parts
      if (rng(s) < 0.09 * hunger[0].w * (under < 0.86 ? 1.8 : under < 0.95 ? 1 : 0.35)) {
        const winner = hunger[0].r;
        const winDebt = packageDebt(winner);
        const winEq = p.ask - winDebt;
        // YOUR OWN PACKAGE CLEARING. Close each deed through acceptSaleOffer so
        // the mortgage payoff, facility release, prepay, tax, deposits and
        // Books lines match a single-asset sale. The old path deleted holdings
        // and credited ask − debt − 2% with no ledger and no release — a
        // facility-backed package walked the collateral off and left the loan.
        let toYou = 0, debtOff = 0, conveyed = 0;
        if (p.player) {
          // ALL OR NOTHING on your own package too. Closing some deeds and
          // leaving the rest on the listing was a partial package sale with
          // a full-ask news line — same class of fault as buyPortfolio used
          // to have the other direction.
          const cash0 = s.cash;
          const totV = p.bbls.reduce((a, b) => {
            const rec = resolveRec(parcels, s, b);
            return a + (rec ? Math.max(1, assetValue(rec, s.econ, gradeOf(s, rec))) : 1);
          }, 0) || 1;
          let work = cloneState(s);
          const owned = p.bbls.filter((b) => work.holdings[b]);
          if (!owned.length) continue;
          let ok = true;
          for (const b of owned) {
            const h = work.holdings[b]!;
            debtOff += h.loan?.balance ?? 0;
            const rec = resolveRec(parcels, work, b);
            const share = Math.max(1000, Math.round(p.ask * ((rec ? Math.max(1, assetValue(rec, work.econ, gradeOf(work, rec))) : 1) / totV)));
            work.holdings[b] = {
              ...work.holdings[b],
              sale: {
                ask: share, listedM: work.month,
                offer: { price: share, expiresM: work.month + 1, from: winner.name },
              },
            };
            const closed = acceptSaleOffer(work, parcels, b, false);
            if (closed.err) { ok = false; break; }
            work = closed.s;
            conveyed++;
          }
          if (!ok || conveyed !== owned.length) continue;
          Object.assign(s, work);
          toYou = Math.max(0, Math.round(s.cash - cash0));
          sweepLocIdleCash(s, { announce: true });
        }
        for (const b of p.bbls) {
          // Player deeds already left via acceptSaleOffer; rival-to-rival still
          // needs the register move below.
          if (p.player && !s.holdings[b]) {
            const rec = resolveRec(parcels, s, b);
            if (rec) {
              if (!winner.bbls.includes(b)) winner.bbls.push(b);
              (winner.heldSince ??= {})[b] = s.month;
              s.lastTradeM ??= {}; s.lastTradeM[b] = s.month;
            }
            continue;
          }
          const rec = resolveRec(parcels, s, b);
          if (!rec) continue;
          const prev = ownerOf(s, b);
          if (prev) { prev.bbls = prev.bbls.filter((x) => x !== b); forgetDeed(prev, b); }
          if (!winner.bbls.includes(b)) winner.bbls.push(b);
          (winner.heldSince ??= {})[b] = s.month;
          s.lastTradeM ??= {}; s.lastTradeM[b] = s.month;
        }
        if (p.player) {
          s.news.unshift({
            q: s.month, kind: "deal",
            text: `${winner.name} has bought your ${conveyed}-building package at ${money(p.ask)} — one closing, `
              + `${money(debtOff)} of debt retired out of the proceeds, ${money(toYou)} net cash movement. `
              + `You will not see those buildings on the tape again for a while.`,
          });
          winner.cash -= winEq; winner.debt += winDebt;
          winner.aum = Math.round((winner.aum ?? 0) + p.ask);
          s.portfolios = s.portfolios.filter((x) => x.id !== p.id);
          continue;
        }
        winner.cash -= winEq; winner.debt += winDebt;
        winner.aum = Math.round((winner.aum ?? 0) + p.ask);
        const seller = p.sellerId ? (s.rivals ?? []).find((r) => r.id === p.sellerId) : null;
        // Retire what the book was actually carrying, not personality LTV.
        if (seller) {
          const lev = (seller.aum ?? 0) > 0
            ? Math.min(1, Math.max(0, seller.debt / (seller.aum as number)))
            : seller.targetLtv;
          const relief = Math.min(seller.debt, Math.round(p.ask * lev));
          seller.debt -= relief;
          seller.cash += p.ask - relief;
        }
        s.portfolios = s.portfolios.filter((x) => x.id !== p.id);
        s.news.unshift({
          q: s.month, kind: "event",
          text: `${winner.name} has bought ${p.bbls.length} buildings from ${seller?.name ?? p.sellerLender ?? "a receiver"} in a single transaction at ${money(p.ask)}. `
            + `That is ${((1 - p.ask / Math.max(1, p.gross)) * 100).toFixed(0)}% back from what the buildings appraise at individually — the price of needing one cheque.`,
        });
        continue;
      }
    }

    // --- 2. THE PRICE WALK ------------------------------------------------
    // A receiver cuts every quarter until it clears. Everybody else has an
    // expiry and a floor: a fund selling into strength will take the book back
    // off the market rather than give it away.
    const age = s.month - p.listedM;
    if (age > 0 && age % 3 === 0) {
      if (p.reo) {
        // NO FLOOR, ONLY PATIENCE RUNNING OUT. This is the mechanism the whole
        // bad-debt story needed: a bank holding REO is losing money every month
        // it holds it, so the number comes down until somebody says yes. Cuts
        // accelerate — the first is a nudge, the sixth is an admission.
        const cut = 0.035 + 0.008 * Math.min(8, p.cuts);
        p.ask = Math.round(p.ask * (1 - cut) / 1000) * 1000;
        p.cuts++;
        p.expiresM = s.month + 12;
        if (p.cuts === 4 || p.cuts === 8) {
          s.news.unshift({
            q: s.month, kind: "warn",
            text: `${p.sellerLender} has cut the ${p.bbls.length}-building ${p.reoBorrower ? `${p.reoBorrower} ` : ""}book again, to ${money(p.ask)} — `
              + `${((1 - p.ask / Math.max(1, p.gross)) * 100).toFixed(0)}% under appraisal now. `
              + `They have been carrying it for ${Math.round(age / 12)} years and the examiners have noticed.`,
          });
        }
        // AND EVENTUALLY IT BREAKS UP. A book nobody wants whole gets sold in
        // pieces, which is worse for the bank and better for everyone else.
        if (p.cuts >= 10) {
          for (const b of p.bbls) {
            const rec = resolveRec(parcels, s, b);
            if (!rec || s.holdings[b] || s.listings.some((l) => l.bbl === b)) continue;
            const v = assetValue(rec, s.econ, gradeOf(s, rec));
            s.listings.push({
              bbl: b, ask: Math.round(v * rrange(s, 0.62, 0.78) / 1000) * 1000,
              listedM: s.month, expiresM: s.month + 12, distress: true,
            });
          }
          s.portfolios = s.portfolios.filter((x) => x.id !== p.id);
          s.news.unshift({
            q: s.month, kind: "warn",
            text: `${p.sellerLender} has given up on selling the ${p.reoBorrower ?? "receivership"} book whole. `
              + `All ${p.bbls.length} buildings are on the tape individually now, and they are priced to go.`,
          });
        }
      } else if (p.ask > p.gross * 0.72) {
        p.ask = Math.round(p.ask * 0.972 / 1000) * 1000;
        p.cuts++;
      }
    }

    // --- 3. expiry ---------------------------------------------------------
    if (!p.reo && s.month >= p.expiresM) {
      if (p.player) {
        for (const b of p.bbls) { const h = s.holdings[b]; if (h) delete h.inPackage; }
        s.news.unshift({
          q: s.month, kind: "info",
          text: `Your ${p.bbls.length}-building package came off the market unsold. Nobody in town could write that cheque this year.`,
        });
      }
      s.portfolios = s.portfolios.filter((x) => x.id !== p.id);
    }
  }

  // --- 3b. A COMPETITOR'S WHOLE RELATIONSHIP, TAKEN BACK IN ONE MONTH ------
  //
  // This is the supply the file's header promised and the game had no way to
  // produce. A firm on this street that fails does not hand back a building —
  // it hands back everything it still owns, in one Friday, to the desks that
  // financed it, and the desk with the largest piece of it leads the workout.
  // A bank does not want to be a landlord eleven times over, so the book goes
  // out whole, priced at what clears the balance sheet rather than at what the
  // buildings are worth: see `openReoPortfolio`. It then walks its own number
  // down every quarter until somebody says yes, which is the whole of section 2
  // above.
  //
  // Four buildings is the floor, because two is a pair of deals and the point
  // of a package is that the list of people who can write the cheque is short.
  for (const r of s.rivals ?? []) {
    if (r.failedM !== s.month || r.bbls.length < 4) continue;
    if (s.portfolios.some((pf) => pf.reoBorrower === r.name)) continue;
    const { desk, owed } = receiverDeskFor(s, parcels, r);
    if (!desk) continue;
    const take = r.bbls.filter((b) => !s.holdings[b]);
    if (take.length < 4) continue;
    openReoPortfolio(s, parcels, desk, take, r.name, owed);
    // AND IT IS AN ALERT, NOT A LINE IN THE PAPER. A failure takes one hundred
    // per cent of what the firm still owned — everything left goes to the
    // desks in the same month, which clears the ">=75% of a portfolio
    // foreclosed" bar by construction — and it is simultaneously the single
    // best buying window in this business and a warning about the desk that
    // just ate the loss. Four buildings is the floor so a two-building shop
    // winding up does not interrupt anybody.
    const p = s.portfolios.find((x) => x.reoBorrower === r.name);
    raiseAlert(s, {
      kind: "portfolio", tone: "bad",
      title: `${desk} has taken back the whole of ${r.name}`,
      body: `${take.length} buildings went to the lenders this month — everything ${r.name} still owned. `
        + `${desk} is not a landlord and does not want to be one, so the book is out whole rather than one at a time, `
        + `and the number it opens at is the loan and not the value. `
        + `The package is on Marketplace under Books for sale — one cheque, cash, no financing at the table. `
        + `If nobody bids it comes down every quarter until somebody does.`,
      detail: p
        ? `${money(p.ask)} for the package against ${money(p.gross)} of buildings — ${((1 - p.ask / Math.max(1, p.gross)) * 100).toFixed(0)}% back from the sum of the parts.`
        : `${money(owed)} of debt against ${take.length} buildings.`,
    });
  }

  // --- 4. a rival winds a book down as one ticket --------------------------
  // Rare, and it is the other side of the hold clock: a fund at the end of its
  // life would rather do one closing than eleven.
  if (s.portfolios.filter((p) => !p.player).length < 3 && rng(s) < 0.010) {
    const cands = livingRivals(s).filter((r) => r.bbls.length >= 4 && !r.stressMs
      && STYLE_OF(r.style).holdM > 0 && s.month - (r.bornM ?? 0) > STYLE_OF(r.style).holdM);
    if (cands.length) {
      const r = cands[Math.floor(rng(s) * cands.length)];
      const take = r.bbls.filter((b) => !s.holdings[b] && !s.listings.some((l) => l.bbl === b)).slice(0, 3 + Math.floor(rng(s) * 6));
      if (take.length >= 3) {
        const gross = grossOf(s, parcels, take);
        const disc = sizeDiscount(take.length, ci);
        s.portfolios.push({
          id: `pf${s.nextPortfolioId = (s.nextPortfolioId ?? 1) + 1}`,
          bbls: take, ask: Math.round(gross * (1 - disc) / 1000) * 1000, gross,
          listedM: s.month, expiresM: s.month + 18, cuts: 0, sellerId: r.id,
          reason: `${r.name} is winding the fund down and would rather do one closing than ${take.length}.`,
        });
        s.news.unshift({
          q: s.month, kind: "deal",
          text: `${r.name} has put ${take.length} buildings on the market as one package at ${money(Math.round(gross * (1 - disc)))}. `
            + `The fund is at the end of its life. Whoever can write that cheque gets ${(disc * 100).toFixed(0)}% off the sum of the parts.`,
        });
      }
    }
  }
}

/**
 * A BANK TAKES A BORROWER'S WHOLE RELATIONSHIP INTO RECEIVERSHIP.
 *
 * Called when a lender ends up holding more than one building off the same
 * failed borrower. It does not want to be a landlord eleven times over, so the
 * book goes out as one ticket, a little under the market — and then it walks
 * its own price down, quarter after quarter, until somebody takes it. That is
 * the whole answer to "what happens when nobody bids".
 */
export function openReoPortfolio(
  s: GameState, parcels: ParcelTable, lender: string, bbls: string[], borrower?: string,
  // WHAT THE DESK IS CARRYING THE BOOK AT. Supplied when the caller knows —
  // a failed sponsor's remaining debt is exactly what the desks took the book
  // against — and omitted when it does not, which is the player's own
  // foreclosures coming off the July docket in auction.ts.
  basis?: number,
) {
  const clean = bbls.filter((b) => !s.holdings[b]);
  if (clean.length < 2) return;
  const gross = grossOf(s, parcels, clean);
  if (gross <= 0) return;
  // WHERE A BANK STARTS, and it depends on the bank.
  //
  // With a known basis this is the same rule the single-asset receiver listings
  // use (rivals.reoAsk): a desk with capital markets the book properly and
  // wants the mark; one with its regulator in the building wants the loan off
  // the balance sheet at what it is carried at, and takes the market when the
  // loan is above it. `lenderPressure` interpolates and is zero for a healthy
  // desk, so there is no discount to be had from a bank that does not need one.
  // Without a basis it opens at 80-100% of the parts and finds out from there,
  // which is what it always did.
  //
  // AND ON A FAILED SPONSOR'S BOOK THE OPENING NUMBER IS USUALLY THE MARK, not
  // a bargain: measured over 28 receivership packages on three unplayed
  // centuries the opening discount off the sum of the parts is 0.0% at the
  // median. That is the right answer and it is worth being explicit about it.
  // A firm that failed is a firm whose debt had caught its buildings, so the
  // desk's basis is ABOVE the market and there is nothing in the basis to give
  // away. The discount on a dead borrower's book is not in the opening price,
  // it is in section 2 — the quarterly walk down, which is the only thing that
  // finds out what a book nobody wants is actually worth.
  const p = basis !== undefined ? lenderPressure(lenderByName(s, lender)) : 0;
  const open = basis !== undefined
    ? Math.max(1000, Math.round((gross * (1 - p) + Math.min(gross, Math.max(0, basis)) * p) / 1000) * 1000)
    : Math.round(gross * rrange(s, 0.80, 1.00) / 1000) * 1000;
  s.listings = s.listings.filter((l) => !clean.includes(l.bbl));
  s.portfolios ??= [];
  s.portfolios.push({
    id: `pf${s.nextPortfolioId = (s.nextPortfolioId ?? 1) + 1}`,
    bbls: clean, ask: open, gross, listedM: s.month, expiresM: s.month + 12,
    cuts: 0, reo: true, sellerLender: lender, reoBorrower: borrower,
    reason: `${lender} took the whole relationship. They are not landlords and they are carrying it at a loss every month.`,
  });
  s.news.unshift({
    q: s.month, kind: "warn",
    text: `${lender} has taken ${clean.length} buildings${borrower ? ` off ${borrower}` : ""} into receivership and put the book out whole at ${money(open)}. `
      + `A bank does not want to own buildings — the package is on Marketplace under Books for sale. `
      + `If nobody bids, that number comes down every quarter until somebody does.`,
  });
}
