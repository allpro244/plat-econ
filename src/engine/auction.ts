// THE JULY AUCTION.
//
// A completed foreclosure does not hand anybody a building. It produces a
// SALE — and in this county the sale happens once a year, in July, on the
// courthouse steps, everything that finished the process crossing the block
// in one afternoon: the bank's REO, the receiver's leftovers, and your own
// seized collateral when you are the one holding the note.
//
// The rules are the real ones, because the real ones are the interesting ones:
//
//   CREDIT BID   the foreclosing lender bids what it is owed without writing a
//                cheque. Nobody buys a building below the debt unless the
//                lender lets it go — and an impaired lender does exactly that,
//                because cash today beats REO on an examined balance sheet.
//   PAID OFF     a cash bid above the debt does not fight the noteholder; it
//                RETIRES them. Principal, arrears, legal — all of it, in one
//                wire. Holding the mortgage never guaranteed you the keys;
//                it guaranteed you the money or the keys, whichever the room
//                decides. That is the whole reason paper is cheaper than brick.
//   SURPLUS      anything above the debt belongs to the borrower who just lost
//                the building. The law has no interest in punishing them twice.
//   AS-IS        ten per cent down the day you register, the balance at the
//                hammer, no diligence, no financing contingency, no warranty.
//
// WHY THIS IS NOT A CHORE. The docket is published when the calendar lands on
// July and the hammer falls one tick later. One card, once a year, that you
// can read or ignore — passing costs nothing but the bargain, and nothing
// here ever asks for a second click.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { AuctionLot, AuctionResultRow, GameState, Holding } from "./types";
import { logBooks, monthLabel, nextJulyAfter, cloneState} from "./types";
import { rng, rrange } from "./market";
import { openReoPortfolio } from "./portfoliosale";
import { collateralAsIs, ownedHoldingValue, resolveRec } from "./value";
import { lenderPressure, lenderByName, chargeLenderLoss } from "./lenders";
import { distressPrice, markSponsor } from "./sponsor";
import { recordComp } from "./comps";
import { firmShort } from "./firm";
import { genRentRoll, depositsOn } from "./leasing";
import { bumpLenderRel } from "./debt";
import { saleTaxQuote, transferGroundLeaseOffBook } from "./actions";
import { takeDeed, FILE_COST } from "./notes";
import { clearRivalClaims, forgetDeed } from "./rivals";
import { reinstateFundedForeclosures } from "./workout";

const clone = (s: GameState): GameState => cloneState(s);
const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

/** Down the day you register, forfeit if you cannot close. */
export const DEPOSIT_PCT = 0.10;
const MAX_LOTS = 8;

/**
 * What a bid actually puts down. On your own note's lot your debt already
 * bids for you — cash is only ever needed for the part ABOVE the debt.
 */
export function depositFor(lot: AuctionLot, amt: number): number {
  const cashPart = lot.kind === "note" ? Math.max(0, amt - lot.debt) : amt;
  return Math.round(cashPart * DEPOSIT_PCT);
}

// ---------------------------------------------------------------- the pipeline

/**
 * THE BANKS RUN THE SAME PROCESS ON THE STREET THAT THEY RUN ON YOU.
 *
 * A desk with a delinquency problem and a borrower six months into a squeeze
 * notices a sale — and then the interesting part happens: most of the firms
 * that recover, reinstate. Measured on the live tree, 23–56% of rival stress
 * episodes end in recovery, and every one of those is now a foreclosure that
 * QUIETLY DIES, which is what most foreclosures do. The docket in July is the
 * residue of the year's failures, not its scares.
 */
export function tickBankForeclosures(s: GameState, parcels: ParcelTable) {
  if (!s.bankFcls) s.bankFcls = [];

  // reinstatements and washouts first
  for (let i = s.bankFcls.length - 1; i >= 0; i--) {
    const f = s.bankFcls[i];
    const r = s.rivals?.find((x) => x.id === f.firmId);
    const rec = resolveRec(parcels, s, f.bbl);
    // the building moved, or the file is stale — it dies without a line
    if (!rec || !r || !r.bbls.includes(f.bbl) || s.holdings[f.bbl]) { s.bankFcls.splice(i, 1); continue; }
    // A DEAD BORROWER DOES NOT REINSTATE — the lot rides to July with the
    // receiver's paperwork instead of the firm's.
    if (r.failedM !== undefined) continue;
    // out of the squeeze: they catch up, the file closes, the docket thins.
    // And a firm STILL in the squeeze protects the building with a date on it
    // first — reinstating one mortgage is cheaper than losing one building,
    // and any borrower with the arrears in hand does exactly that.
    const cure = Math.max(1, Math.round(f.debt * 0.08));
    const canFund = r.cash >= cure;
    if (canFund && ((r.stressMs ?? 0) === 0 || rng(s) < 0.09)) {
      r.cash -= cure;
      s.bankFcls.splice(i, 1);
      s.news.unshift({
        q: s.month, kind: "info",
        text: `${r.name} paid $${(cure / 1000).toFixed(0)}K to reinstate at ${rec.address}; ${f.lender} has withdrawn the sale. `
          + `Most of the foreclosures this town starts end exactly like this, which is worth remembering in July.`,
      });
    }
  }

  // and a desk out of patience notices a new one — at most one a month citywide
  if (s.bankFcls.length >= 4) return;
  for (const l of s.lenders ?? []) {
    if (l.failedM !== undefined) continue;
    if (l.delinquent < 0.035 || rng(s) > 0.09) continue;
    const pool = (s.rivals ?? []).filter((r) =>
      r.failedM === undefined && (r.stressMs ?? 0) >= 4 && r.bbls.length > 0
      && r.debt / Math.max(1, r.aum ?? 1) > 0.7);
    if (!pool.length) return;
    const r = pool[Math.floor(rng(s) * pool.length)];
    const cands = r.bbls.filter((b) =>
      !s.holdings[b] && !s.bankFcls!.some((x) => x.bbl === b)
      && !(s.notes ?? []).some((n) => n.bbl === b)
      && !(s.rivalNotes ?? []).some((x) => x.bbl === b));
    if (!cands.length) return;
    const bbl = cands[Math.floor(rng(s) * cands.length)];
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class === "land") return;
    const asIs = collateralAsIs(rec, s.econ, Math.max(0.15, Math.min(0.95, r.occ ?? 0.6)));
    if (asIs < 600_000) return;
    const debt = Math.round(asIs * rrange(s, 0.75, 1.15));
    s.bankFcls.push({
      bbl, lender: l.name, firmId: r.id, firm: r.name, debt,
      noticedM: s.month, saleM: nextJulyAfter(s.month, 5),
    });
    s.news.unshift({
      q: s.month, kind: "event",
      text: `${l.name} has noticed a foreclosure sale on ${r.name}'s building at ${rec.address} — `
        + `${money(debt)} owed, down for the ${monthLabel(nextJulyAfter(s.month, 5))} auction. `
        + `${r.name} has until the hammer to find the arrears, and firms in a squeeze this deep usually do not.`,
    });
    return;
  }
}

// ------------------------------------------------------------------ the docket

function estimate(s: GameState, asIs: number): number {
  // the flyer's number: a drive-by appraisal with no access to the roll
  return Math.round(asIs * rrange(s, 0.92, 1.08) / 10_000) * 10_000;
}

function buildDocket(s: GameState, parcels: ParcelTable) {
  const lots: AuctionLot[] = [];
  const july = s.month;               // we ARE July; the hammer is next tick
  const push = (lot: AuctionLot) => { if (lots.length < MAX_LOTS) lots.push(lot); };

  // 1. Your paper, filed and ripe. Your debt is the credit bid.
  for (const n of s.notes ?? []) {
    if (n.perf !== "nonperforming" || n.filedM === undefined) continue;
    if (n.saleM === undefined || n.saleM > july) continue;
    const rec = resolveRec(parcels, s, n.bbl);
    if (!rec) continue;
    const r = s.rivals?.find((x) => x.id === n.obligorId);
    const occ = r ? Math.max(0.15, Math.min(0.95, r.occ ?? 0.6)) : 0.35;
    const debt = Math.round(n.face + (n.arrears ?? 0) + n.face * FILE_COST);
    push({
      id: `A${july}-${n.bbl}`, bbl: n.bbl, address: n.address, kind: "note",
      debt, holder: firmShort(s), borrowerId: n.obligorId, borrower: n.obligor,
      noteId: n.id, upset: debt,
      est: estimate(s, collateralAsIs(rec, s.econ, occ)),
    });
  }

  // 2. Your own building, if your lender got to the end of the process.
  for (const w of Object.values(s.workouts ?? {})) {
    if (w.stage !== "foreclosure" || w.saleM === undefined || w.saleM > july) continue;
    const h = s.holdings[w.bbl];
    const rec = resolveRec(parcels, s, w.bbl);
    if ((!h?.loan && !(h?.mezz && h.mezz.balance > 0)) || !rec) continue;
    const owed = Math.round(
      (h.loan?.balance ?? 0) + (h.mezz?.balance ?? 0) + (w.accrued ?? 0),
    );
    push({
      id: `A${july}-${w.bbl}`, bbl: w.bbl, address: rec.address, kind: "yours",
      debt: owed, holder: w.lender,
      borrower: firmShort(s), upset: owed,
      est: estimate(s, ownedHoldingValue(s, parcels, h)),
    });
  }

  // 3. The street. Banks that ran the process on a rival all year.
  for (const f of s.bankFcls ?? []) {
    if (f.saleM > july) continue;
    const rec = resolveRec(parcels, s, f.bbl);
    const r = s.rivals?.find((x) => x.id === f.firmId);
    if (!rec || !r || !r.bbls.includes(f.bbl)) continue;
    if (s.listings.some((l) => l.bbl === f.bbl)) continue;   // a receiver got there first
    const occ = Math.max(0.15, Math.min(0.95, r.occ ?? 0.6));
    push({
      id: `A${july}-${f.bbl}`, bbl: f.bbl, address: rec.address, kind: "bank",
      debt: f.debt, holder: f.lender, borrowerId: f.firmId, borrower: f.firm,
      upset: f.debt, est: estimate(s, collateralAsIs(rec, s.econ, occ)),
    });
  }

  // 4. The receiver's lots: a dead firm's buildings, up to two a year, sold
  //    for whatever they bring above the referee's floor.
  const dead = (s.rivals ?? []).filter((r) => r.failedM !== undefined && r.bbls.length > 0);
  let rc = 0;
  for (const r of dead) {
    if (rc >= 2) break;
    const cands = r.bbls.filter((b) =>
      !s.holdings[b] && !s.listings.some((l) => l.bbl === b)
      && !lots.some((x) => x.bbl === b) && !(s.notes ?? []).some((n) => n.bbl === b));
    if (!cands.length) continue;
    const bbl = cands[Math.floor(rng(s) * cands.length)];
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class === "land") continue;
    const asIs = collateralAsIs(rec, s.econ, Math.max(0.15, Math.min(0.95, r.occ ?? 0.5)));
    if (asIs < 400_000) continue;
    const share = Math.min(0.95 * asIs, r.aum ? r.debt * (asIs / Math.max(1, r.aum)) : 0.8 * asIs);
    push({
      id: `A${july}-${bbl}`, bbl, address: rec.address, kind: "receiver",
      debt: Math.round(share), holder: `the receiver for ${r.name}`,
      borrowerId: r.id, borrower: r.name,
      upset: Math.round(asIs * 0.55), est: estimate(s, asIs),
    });
    rc++;
  }

  if (!lots.length) return;
  s.auction = { m: july + 1, lots, deposit: 0 };
  s.news.unshift({
    q: july, kind: "event",
    text: `The county's foreclosure docket is out: ${lots.length} lot${lots.length === 1 ? "" : "s"} cross the block this month. `
      + `As-is, ten per cent down, no financing and no warranty — the hammer falls at the end of July.`,
  });
}

// ------------------------------------------------------------------ the hammer

/** Who shows up with money, and how hard they push. The room IS the cycle. */
function roomBid(s: GameState, est: number): { px: number; heads: number } {
  const ci = s.econ.creditIdx ?? 1;
  const hot = ci > 1.02 && (s.econ.phase === "expansion" || s.econ.phase === "peak");
  const crunch = ci < 0.92 || s.econ.phase === "recession";
  const heads = hot ? 2 + Math.floor(rng(s) * 4) : crunch ? Math.floor(rng(s) * 2) : 1 + Math.floor(rng(s) * 2);
  let best = 0;
  for (let i = 0; i < heads; i++) {
    best = Math.max(best, est * distressPrice(s) * rrange(s, 0.84, 1.02));
  }
  // fever: a crowded room forgets it is buying somebody's failure
  if (heads >= 4) best *= rrange(s, 1.03, 1.14);
  return { px: Math.round(best), heads };
}

/** A named buyer if one on the street can carry it; out-of-town money if not. */
function thirdPartyTakes(s: GameState, rec: ParcelRecord, px: number): string {
  const r = (s.rivals ?? []).filter((x) =>
    x.failedM === undefined && x.cash > px * 0.3
    && (x.style === "opportunistic" || x.style === "core"))
    .sort((a, b) => b.cash - a.cash)[0];
  if (r) {
    const equity = Math.min(r.cash, Math.round(px * 0.35));
    r.cash -= equity;
    r.debt += px - equity;
    r.bbls.push(rec.bbl);
    // WHEN THE DEED ARRIVED, and it arrived today. Without it the hold clock
    // falls back to `r.bornM` and reads a building bought at the courthouse
    // this morning as having been owned since the firm opened — older than
    // anything the firm legitimately holds, so it always won the "oldest
    // holding" contest and went straight back on the tape.
    (r.heldSince ??= {})[rec.bbl] = s.month;
    r.basis = Math.round((r.basis ?? 0) + px);
    return r.name;
  }
  return "money from out of town";     // the building leaves the street's books
}

/** The player takes a lot for cash: worn bones, the roll the borrower left. */
function playerTakes(s: GameState, parcels: ParcelTable, lot: AuctionLot, paid: number, occ: number) {
  const rec = resolveRec(parcels, s, lot.bbl)!;
  const h: Holding = {
    bbl: lot.bbl, boughtM: s.month, costBasis: paid,
    assessed: Math.round(collateralAsIs(rec, s.econ, occ)),
    loan: null, condition: "worn", tenants: [], cfHistory: [],
    ...(s.landmarks?.[lot.bbl] !== undefined ? { landmarked: true } : {}),
  };
  genRentRoll(s, rec, h);
  const total = h.tenants.reduce((a, t) => a + t.sf, 0);
  let cur = total, guard = 0;
  while (h.tenants.length && cur > total * occ && guard++ < 200) {
    const gone = h.tenants.splice(Math.floor(rng(s) * h.tenants.length), 1)[0];
    cur -= gone.sf;
    s.cash -= gone.deposit ?? 0;      // never handed across at a courthouse sale
  }
  if (h.occ !== undefined) h.occ = Math.min(h.occ, occ);
  clearRivalClaims(s, lot.bbl);
  s.holdings[lot.bbl] = h;
  s.listings = s.listings.filter((l) => l.bbl !== lot.bbl);
  delete s.approaches[lot.bbl];
  s.lastTradeM = s.lastTradeM ?? {};
  s.lastTradeM[lot.bbl] = s.month;
  recordComp(s, rec, paid, firmShort(s), lot.holder, true, "worn");
}

function resolveAuction(s: GameState, parcels: ParcelTable) {
  const a = s.auction!;
  delete s.auction;
  let sold = 0, reo = 0, pulled = 0;

  /**
   * WHAT HAPPENED TO YOUR NUMBER, recorded rather than only narrated.
   *
   * Everything below already decided whether you won, were outbid, were paid
   * off or could not close — and the only place any of it surfaced was the news
   * tape. A player who registered a bid closed the sheet and then had to go
   * reading the ticker to find out whether they owned a building. So each lot
   * the player had a number on writes a row here, the panel shows it once, and
   * `seenM` on the card retires it.
   */
  s.auctionResults = { m: s.month, rows: [] };
  const said = (bbl: string, address: string, outcome: AuctionResultRow["outcome"],
                yourBid: number, price: number, winner?: string, note?: string) => {
    s.auctionResults!.rows.push({ bbl, address, outcome, yourBid, price, winner, note });
  };

  for (const lot of a.lots) {
    const rec = resolveRec(parcels, s, lot.bbl);
    if (!rec) continue;
    const bid = lot.yourBid ?? 0;
    const deposit = bid > 0 ? depositFor(lot, bid) : 0;

    // ---- pulled from the docket: the borrower found the money -------------
    const note = lot.noteId ? (s.notes ?? []).find((n) => n.id === lot.noteId) : undefined;
    const w = lot.kind === "yours" ? s.workouts?.[lot.bbl] : undefined;
    const live =
      lot.kind === "note" ? !!note && note.perf === "nonperforming" && note.filedM !== undefined
      : lot.kind === "yours" ? !!w && w.stage === "foreclosure" && !!s.holdings[lot.bbl]?.loan
      : lot.kind === "bank" ? (s.bankFcls ?? []).some((f) => f.bbl === lot.bbl) && !s.holdings[lot.bbl]
        && !!s.rivals?.find((r) => r.id === lot.borrowerId)?.bbls.includes(lot.bbl)
      : !s.holdings[lot.bbl] && !!s.rivals?.find((r) => r.id === lot.borrowerId)?.bbls.includes(lot.bbl);
    if (!live) {
      pulled++;
      if (bid > 0) {
        s.cash += deposit; logBooks(s, "sold", deposit); // deposit back
        said(lot.bbl, lot.address, "pulled", bid, 0, undefined,
          `The borrower reinstated before the hammer. Your ${money(deposit)} deposit came back.`);
      }
      s.news.unshift({
        q: s.month, kind: "info",
        text: `Lot at ${lot.address} was pulled on the courthouse steps — the borrower reinstated, or the file died first. `
          + `That is most of what happens to foreclosures, and it happened to this one at the last minute.`,
      });
      continue;
    }

    // ---- the room, the credit bid, and your number ------------------------
    const { px: room, heads } = roomBid(s, lot.est);
    // an impaired holder does not protect its whole debt — cash beats REO
    const holderL = lot.kind === "yours" || lot.kind === "bank" ? lenderByName(s, lot.holder) : undefined;
    const protect = lot.kind === "note" ? lot.debt
      : lot.kind === "receiver" ? lot.upset
      : Math.round(lot.debt * (1 - 0.35 * lenderPressure(holderL)));
    // your bid only counts if you can actually close the balance — and on
    // your own note's lot the cash you owe is only the part above your debt
    const owedAtHammer = lot.kind === "note" ? Math.max(0, bid - lot.debt) : bid;
    let yours = bid;
    if (yours > 0 && s.cash + deposit < owedAtHammer) {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `You could not close on ${lot.address} — the balance was due at the hammer and the cash was not there. `
          + `The referee kept your ${money(deposit)} deposit, which is what the deposit is for.`,
      });
      said(lot.bbl, lot.address, "nocash", bid, 0, undefined,
        `The balance was due at the hammer and the cash was not there. The referee kept your ${money(deposit)} deposit.`);
      yours = 0;
    } else if (yours > 0) {
      s.cash += deposit;               // roll the deposit back in; winners pay in full below
      logBooks(s, "sold", deposit);
    }

    const bestCash = Math.max(room, yours);
    const youWin = yours > 0 && yours >= room && bestCash > protect
      && !(lot.kind === "note");       // your own lot: handled below, credit bid first
    const notePlayerWins = lot.kind === "note" && (yours >= Math.max(room, lot.debt) || room <= lot.debt);

    // ---- settle, by kind --------------------------------------------------
    if (lot.kind === "note") {
      const n = note!;
      const r = s.rivals?.find((x) => x.id === n.obligorId);
      if (!notePlayerWins) {
        // outbid over your debt: you are PAID OFF, they get the building
        const paid = Math.round(Math.max(room, lot.debt * 1.01));
        s.cash += lot.debt; logBooks(s, "sold", lot.debt);
        const surplus = Math.max(0, paid - lot.debt);
        const buyer = thirdPartyTakes(s, rec, paid);
        if (r) {
          r.bbls = r.bbls.filter((b) => b !== n.bbl);
          forgetDeed(r, n.bbl);
          r.debt = Math.max(0, r.debt - n.face);
          r.cash += surplus;           // the law hands the wiped borrower the rest
        }
        s.listings = s.listings.filter((l) => l.bbl !== n.bbl);
        s.lastTradeM = s.lastTradeM ?? {};
        s.lastTradeM[n.bbl] = s.month;
        recordComp(s, rec, paid, buyer, n.obligor, true, "worn");
        s.notes = s.notes!.filter((x) => x.id !== n.id);
        sold++;
        said(lot.bbl, lot.address, "paidoff", bid, paid, buyer,
          `Over your debt, so you were paid off in full — ${money(lot.debt)} against ${money(n.basis)} in.`);
        s.news.unshift({
          q: s.month, kind: "deal",
          text: `${buyer} took ${lot.address} on the steps at ${money(paid)} — over your debt, so you were paid off in full: `
            + `${money(lot.debt)} against ${money(n.basis)} in. ${surplus > 0 ? `The ${money(surplus)} above the debt went to ${n.obligor}, because that is the law. ` : ``}`
            + `You held the mortgage; the room decided you got the money, not the keys.`,
        });
      } else {
        // the room stopped under your debt — or you overbid to be sure
        const over = Math.max(0, yours - lot.debt);
        if (over > 0 && r) {
          s.cash -= over; logBooks(s, "bought", over);
          r.cash += over;
        }
        said(lot.bbl, lot.address, "won", bid, Math.max(yours, lot.debt), undefined,
          `The room stopped under your debt, so the credit bid took it. You did not buy a building at a discount; you bought a job.`);
        takeDeed(s, parcels, n, "foreclosure");
        s.notes = s.notes!.filter((x) => x.id !== n.id);
        sold++;
      }
      continue;
    }

    if (lot.kind === "yours") {
      const h = s.holdings[lot.bbl]!;
      const seniorBal = h.loan?.balance ?? 0;
      const mezzBal = h.mezz?.balance ?? 0;
      const bal = Math.round(seniorBal + mezzBal + (w?.accrued ?? 0));
      const recourse = h.loan?.recourse ?? false;
      // the lender credit-bids `protect`; the room may or may not clear it
      const gross = room > protect ? room : Math.round(protect);
      const toREO = room <= protect;
      // THE REFEREE IS PAID BEFORE ANYBODY ELSE IS. A sale on the courthouse
      // steps carries the same commission, stamps and legal as a sale across a
      // table — more, if anything — and they come off the hammer price before
      // the mortgage sees a cent. The surplus the law hands the borrower is
      // what is left after all of it, which is why a surplus is so rare.
      const { net } = saleTaxQuote(h, gross, s);
      const shortfall = Math.max(0, bal - net);
      const surplus = Math.max(0, net - bal);
      if (surplus > 0) { s.cash += surplus; logBooks(s, "sold", surplus); }
      if (shortfall > 0) {
        if (recourse) { s.cash -= shortfall; logBooks(s, "debtSvc", shortfall); }
        else {
          const seniorHole = Math.min(shortfall, seniorBal + (w?.accrued ?? 0));
          const mezzHole = shortfall - seniorHole;
          if (seniorHole > 0) chargeLenderLoss(s, lot.holder, seniorHole);
          if (mezzHole > 0) {
            chargeLenderLoss(s, h.mezz?.holder ?? "Cordage Debt Partners", mezzHole);
          }
        }
      }
      s.exits.push({
        bbl: lot.bbl, address: lot.address, boughtM: h.boughtM, soldM: s.month,
        price: gross, basis: h.costBasis, gain: gross - h.costBasis, forced: true,
      });
      recordComp(s, rec, gross, toREO ? lot.holder : "the courthouse steps", firmShort(s), true, h.condition);
      if (s.groundLeases?.[lot.bbl]) transferGroundLeaseOffBook(s, lot.bbl);
      s.cash -= depositsOn(h);
      s.lastTradeM = s.lastTradeM ?? {};
      s.lastTradeM[lot.bbl] = s.month;
      delete s.holdings[lot.bbl];
      delete s.workouts![lot.bbl];
      s.lois = s.lois.filter((l) => l.bbl !== lot.bbl);
      said(lot.bbl, lot.address, "lostyours", 0, gross, toREO ? lot.holder : "the room",
        shortfall > 0
          ? (recourse ? `You signed for this one — the ${money(shortfall)} shortfall came out of your account.`
                      : `Non-recourse, so ${lot.holder} ate the ${money(shortfall)}.`)
          : `It cleared the debt and ${money(surplus)} came back to you.`);
      markSponsor(s, shortfall > 0 && recourse ? "deficiency" : "seized", lot.address, shortfall);
      bumpLenderRel(s, lot.holder, -20);
      sold++;
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `${lot.address} crossed the block at ${money(gross)}${toREO ? ` — no bid met ${lot.holder}'s credit bid, so it is their REO now` : ` to the room`}. `
          + (shortfall > 0
            ? recourse
              ? `You signed for this one: the ${money(shortfall)} shortfall came out of your account.`
              : `The paper was non-recourse, so ${lot.holder} ate the ${money(shortfall)}.`
            : `It cleared the debt and ${money(surplus)} came back to you — the steps owe you nothing further.`),
      });
      continue;
    }

    // bank and receiver lots: a rival's building crosses the block
    const r = s.rivals?.find((x) => x.id === lot.borrowerId);
    if (youWin) {
      const paid = Math.max(yours, Math.round(lot.upset));
      s.cash -= paid; logBooks(s, "bought", paid);
      const occ = Math.max(0.15, Math.min(0.95, r?.occ ?? 0.4));
      if (r) {
        r.bbls = r.bbls.filter((b) => b !== lot.bbl);
        forgetDeed(r, lot.bbl);
        r.debt = Math.max(0, r.debt - lot.debt);
        r.cash += Math.max(0, paid - lot.debt);
      }
      if (lot.kind === "bank") s.bankFcls = (s.bankFcls ?? []).filter((f) => f.bbl !== lot.bbl);
      playerTakes(s, parcels, lot, paid, occ);
      sold++;
      said(lot.bbl, lot.address, "won", bid, paid, undefined,
        `${heads} other head${heads === 1 ? "" : "s"} in the room. It is worn and nobody is coming to fix that but you.`);
      const leased = s.holdings[lot.bbl]!.tenants.reduce((x, t) => x + t.sf, 0);
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `The hammer fell to YOU at ${lot.address} — ${money(paid)}, as-is, ${heads} other head${heads === 1 ? "" : "s"} in the room. `
          + `It is worn, ${rec.bldgArea > 0 ? `${Math.round(100 * leased / Math.max(1, rec.bldgArea))}% of it is let` : "it is a site"}, `
          + `and nobody is coming to fix either of those but you.`,
      });
      continue;
    }
    if (room > protect && room >= lot.upset) {
      const paid = room;
      const buyer = thirdPartyTakes(s, rec, paid);
      if (bid > 0) said(lot.bbl, lot.address, "outbid", bid, paid, buyer,
        `The room went past you. Your deposit came back.`);
      if (r) {
        r.bbls = r.bbls.filter((b) => b !== lot.bbl);
        forgetDeed(r, lot.bbl);
        r.debt = Math.max(0, r.debt - lot.debt);
        r.cash += Math.max(0, paid - lot.debt);
      }
      if (lot.kind === "bank") s.bankFcls = (s.bankFcls ?? []).filter((f) => f.bbl !== lot.bbl);
      s.listings = s.listings.filter((l) => l.bbl !== lot.bbl);
      s.lastTradeM = s.lastTradeM ?? {};
      s.lastTradeM[lot.bbl] = s.month;
      recordComp(s, rec, paid, buyer, lot.borrower ?? lot.holder, true, "worn");
      sold++;
      s.news.unshift({
        q: s.month, kind: "event",
        text: `${buyer} took ${lot.address} on the steps at ${money(paid)}${paid > lot.debt ? ` — ${money(paid - lot.debt)} over the debt, which goes to ${lot.borrower}` : ``}.`,
      });
    } else {
      // struck to the foreclosing party: REO, and the tape will see it again
      reo++;
      if (lot.kind === "bank") {
        const f = (s.bankFcls ?? []).find((x) => x.bbl === lot.bbl);
        if (f && r) {
          r.bbls = r.bbls.filter((b) => b !== lot.bbl);
          forgetDeed(r, lot.bbl);
          r.debt = Math.max(0, r.debt - lot.debt);
          s.bankFcls = s.bankFcls!.filter((x) => x.bbl !== lot.bbl);
          const lst = Math.round(lot.est * rrange(s, 0.78, 0.9) / 1000) * 1000;
          // the borrower may have listed it in the month between docket and
          // hammer — the REO desk replaces that ticket, it does not stack one
          s.listings = s.listings.filter((x) => x.bbl !== lot.bbl);
          s.listings.push({
            bbl: lot.bbl, ask: lst, listedM: s.month,
            expiresM: s.month + Math.round(rrange(s, 8, 14)), distress: true,
          });
          s.lastTradeM = s.lastTradeM ?? {};
          s.lastTradeM[lot.bbl] = s.month;
          s.news.unshift({
            q: s.month, kind: "event",
            text: `No bid reached ${lot.holder}'s number on ${lot.address}. It is their REO now, and it is already `
              + `back on the tape at ${money(lst)} — a bank is not in the landlord business and does not want to be.`,
          });
        }
      }
      // receiver lots that fail simply stay with the receiver for the drip
    }
  }
  // A BANK THAT TOOK MORE THAN ONE BUILDING OFF THE SAME BORROWER DOES NOT WANT
  // ELEVEN CLOSINGS. It wants the relationship off the balance sheet, and the
  // way that is actually done is one ticket for the whole book — put out a
  // little under the market and then cut, quarter after quarter, until somebody
  // takes it. See engine/portfoliosale.ts for the walk.
  {
    const byLender = new Map<string, { bbls: string[]; borrower?: string }>();
    for (const lot of a.lots) {
      if (lot.kind !== "bank") continue;
      const li = s.listings.find((x) => x.bbl === lot.bbl && x.distress);
      if (!li) continue;                        // it did not become REO this month
      const k = lot.holder;
      if (!byLender.has(k)) byLender.set(k, { bbls: [], borrower: lot.borrower });
      byLender.get(k)!.bbls.push(lot.bbl);
    }
    for (const [lender, g] of byLender) {
      if (g.bbls.length < 2) continue;
      openReoPortfolio(s, parcels, lender, g.bbls, g.borrower);
    }
  }
  if (sold + reo + pulled > 1) {
    s.news.unshift({
      q: s.month, kind: "info",
      text: `The July sale is done: ${sold} lot${sold === 1 ? "" : "s"} hammered${reo ? `, ${reo} struck to the lender` : ""}`
        + `${pulled ? `, ${pulled} pulled by reinstatement` : ""}. The county will do it all again next year.`,
    });
  }
}

// -------------------------------------------------------------------- the tick

/**
 * THE FIRST DOCKET OF THE CAMPAIGN, in the third July.
 *
 * A foreclosure is the end of a long process — a loan struck, a market turned,
 * arrears run up, a notice filed, a redemption period run out. None of that
 * can have happened to anybody in the first eighteen months of a run, so a
 * docket in the first July is the game showing you distress it has not yet
 * had time to produce. By the third summer the street has had a cycle to get
 * into trouble in, and the lots on the block have a story behind them.
 */
export const FIRST_DOCKET_M = 30;

export function tickAuction(s: GameState, parcels: ParcelTable) {
  tickBankForeclosures(s, parcels);
  // A funded reinstate pulls your building off the docket BEFORE the hammer.
  // The county used to settle first and let the workout desk run after NOI —
  // so a sponsor with the arrears in hand lost the building on the same tick
  // the cure cheque would have cleared.
  reinstateFundedForeclosures(s, parcels);
  // the hammer first — an auction resolved before July's docket is built
  if (s.auction && s.month >= s.auction.m) resolveAuction(s, parcels);
  if (s.month >= FIRST_DOCKET_M && s.month % 12 === 6 && !s.auction) buildDocket(s, parcels);
}

// ------------------------------------------------------------------ the action

/**
 * REGISTER YOUR BIDS — one call, replacing whatever you had down. Ten per
 * cent of each bid leaves your account today; losers get it back at the
 * hammer, winners see it credited, and a winner who cannot close forfeits it.
 */
export function registerAuctionBids(
  s: GameState, bids: Record<string, number>,
): { s: GameState; err?: string; msg?: string } {
  if (!s.auction) return { s, err: "There is no sale on the calendar. The county's docket comes out in July." };
  const next = clone(s);
  const a = next.auction!;
  // hand back whatever was already down
  next.cash += a.deposit; if (a.deposit) logBooks(next, "sold", a.deposit);
  a.deposit = 0;
  for (const lot of a.lots) lot.yourBid = undefined;
  let dep = 0, placed = 0;
  for (const [id, amt] of Object.entries(bids)) {
    const lot = a.lots.find((x) => x.id === id);
    if (!lot || !(amt > 0)) continue;
    if (lot.kind === "yours") {
      return { s, err: `That is your own foreclosure. You do not bid on it — you cure it, hand back the keys, or let the room decide.` };
    }
    if (lot.kind !== "note" && amt < lot.upset) {
      return { s, err: `The referee's minimum on ${lot.address} is ${money(lot.upset)}. Bid that or stay home.` };
    }
    lot.yourBid = Math.round(amt);
    dep += depositFor(lot, Math.round(amt));
    placed++;
  }
  if (dep > next.cash) {
    return { s, err: `Registering these bids takes ${money(dep)} down today — you are short ${money(dep - next.cash)}.` };
  }
  next.cash -= dep; if (dep) logBooks(next, "bought", dep);
  a.deposit = dep;
  return {
    s: next,
    msg: placed ? `${placed} bid${placed === 1 ? "" : "s"} registered — ${money(dep)} down.` : "Bids withdrawn.",
  };
}
