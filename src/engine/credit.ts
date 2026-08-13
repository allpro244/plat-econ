// The revolving line of credit: the facility that keeps a good portfolio from
// dying of a bad month. Sized at 35% of net worth, priced at the index plus
// 400bps, drawn and repaid at will — and drawn automatically before cash goes
// negative, because no real sponsor lets a rent cheque bounce while an
// undrawn line sits on the desk.
import type { ParcelTable } from "@/data/types";
import type { GameState } from "./types";
import { logBooks, cloneState} from "./types";
import { netWorth } from "./value";
import { sponsorStanding } from "./sponsor";

/**
 * THE ADVANCE RATE, against net worth.
 *
 * 35% was conservative to the point of being decorative: the line existed to
 * stop a bad month killing a good book, and at a third of equity it could not
 * do the other thing a revolver is for — bridging an acquisition or a fit-out
 * while a sale closes. Sixty per cent of net worth is a real corporate
 * facility, and it is a genuine two-sided change: it is also sixty per cent of
 * net worth that the bank can call when values fall and your equity with them.
 * The over-advance path below is what makes that a decision rather than a gift.
 */
export const LOC_LTV = 0.60;      // against net worth
export const LOC_SPREAD = 4.0;    // prime + 400bps
/**
 * Operating float left on hand when idle cash pays the revolver.
 * Everything above this goes to the most expensive money first.
 */
export const LOC_CASH_RESERVE = 250_000;

export function locRate(s: GameState): number {
  return +(s.econ.indexRate + LOC_SPREAD).toFixed(2);
}

/**
 * Pay the revolver with idle cash above {@link LOC_CASH_RESERVE}.
 *
 * Month-end already did this inside `tickLoc`, but a sale (or any other cash
 * inflow) used to leave the line drawn until the next Advance — millions in
 * the account, index+400 still running. Call this whenever firm cash jumps.
 * Returns dollars repaid.
 */
export function sweepLocIdleCash(
  s: GameState,
  opts?: { announce?: boolean },
): number {
  if (!s.loc || s.loc.balance <= 0) return 0;
  if (s.cash <= LOC_CASH_RESERVE) return 0;
  const sweep = Math.min(s.loc.balance, Math.floor(s.cash - LOC_CASH_RESERVE));
  if (sweep <= 0) return 0;
  s.loc.balance -= sweep;
  s.cash -= sweep;
  _locAvailCache = null;
  if (opts?.announce && sweep >= 25_000) {
    s.news.unshift({
      q: s.month, kind: "info",
      text: `Idle cash paid $${(sweep / 1e6).toFixed(2)}M down on the line`
        + (s.loc.balance > 0
          ? `. Balance $${(s.loc.balance / 1e6).toFixed(2)}M.`
          : " — clear."),
    });
  }
  return sweep;
}

// The lender re-sizes the line off your net worth — which includes what you've
// already drawn, so borrowing doesn't inflate your own borrowing base.
/**
 * The line is not a constant. Banks size a revolver against your equity AND
 * against their own appetite, and their appetite disappears in exactly the
 * quarter you need the money. Cutting the advance rate with the credit cycle
 * is what turns a downturn from an inconvenience into a doom loop: values
 * fall, so equity falls, so the line falls twice over, so the over-advance
 * gets called, so you sell into the bid you least wanted to hit.
 *
 * This is the single most important thing a levered owner has to survive, and
 * without it the whole game had no way to lose.
 */
export function locLimit(s: GameState, parcels: ParcelTable, nwPre?: number): number {
  // Optional precomputed net worth — the top bar used to call netWorth here
  // and again for the Net-worth readout on every render (including every nav
  // click and every FPS tick), which is what made ordinary UI clicks feel
  // heavy once the book grew.
  const nw = nwPre ?? netWorth(s, parcels);
  const ci = s.econ.creditIdx ?? 1;
  // The revolver is the most relationship-dependent money on the balance
  // sheet, so it is the first thing a bank pulls when your name goes bad —
  // and it is pulled at exactly the moment the rest of the stack needs it.
  const st = sponsorStanding(s);
  const advance = LOC_LTV * Math.max(0.35, Math.min(1.15, ci)) * (1 - Math.min(0.6, 1.6 * st.advanceCut));
  return Math.max(0, Math.round(nw * advance));
}

/**
 * Undrawn room on the line. Cached for the current (state, month, cash, drawn)
 * tuple because `fundableNow` / `fundCashNeed` can be asked once per loan per
 * month and each call used to re-walk the whole book through `netWorth`.
 */
let _locAvailCache: {
  s: GameState; month: number; cash: number; locBal: number; avail: number;
} | null = null;

export function locAvailable(s: GameState, parcels: ParcelTable): number {
  const locBal = s.loc?.balance ?? 0;
  const hit = _locAvailCache;
  if (
    hit && hit.s === s && hit.month === s.month
    && hit.cash === s.cash && hit.locBal === locBal
  ) return hit.avail;
  const avail = Math.max(0, locLimit(s, parcels) - locBal);
  _locAvailCache = { s, month: s.month, cash: s.cash, locBal, avail };
  return avail;
}

/**
 * DRAW THE LINE TO COVER A CASH NEED, THEN TAKE THE MONEY.
 *
 * Debt service and shortfalls used to look only at `s.cash`. A firm with an
 * undrawn revolver and a weak building therefore walked into foreclosure with
 * the line sitting unused — the exact wrong-number the owner reported (huge
 * cash flow / liquidity, one property filed on over a payment the firm could
 * trivially fund).
 *
 * Order is the real one: operating cash first, then the line (when allowed),
 * then whatever is still unpaid is unpaid. Workout cures (including covenant
 * equity cures) may draw the line — a sponsor who can reinstate from the
 * revolver does not lose the building. Pass `allowLoc: false` only for true
 * cash-only calls that are not about keeping a deed. LOC draws are NOT booked
 * to `borrowed` — that bucket is mortgage/facility principal; conserve already
 * sees the revolver through `Δloc.balance`. Returns the dollars successfully
 * funded (and already deducted from cash).
 */
export function fundCashNeed(
  s: GameState, parcels: ParcelTable, amount: number,
  opts?: { allowLoc?: boolean },
): number {
  const allowLoc = opts?.allowLoc ?? true;
  const need = Math.max(0, Math.ceil(amount));
  if (need <= 0) return 0;
  if (!s.loc) s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  const short = Math.max(0, need - Math.max(0, Math.floor(s.cash)));
  if (short > 0 && allowLoc) {
    const draw = Math.min(short, locAvailable(s, parcels));
    if (draw > 0) {
      s.loc.balance += draw;
      s.loc.drawnTotal += draw;
      s.cash += draw;
      _locAvailCache = null; // cash and drawn both moved
    }
  }
  const pay = Math.min(need, Math.max(0, Math.floor(s.cash)));
  if (pay > 0) {
    s.cash -= pay;
    _locAvailCache = null;
  }
  return pay;
}

/** How much the firm can fund right now (cash, plus undrawn line when allowed). */
export function fundableNow(
  s: GameState, parcels: ParcelTable,
  opts?: { allowLoc?: boolean },
): number {
  const allowLoc = opts?.allowLoc ?? true;
  return Math.max(0, Math.floor(s.cash)) + (allowLoc ? locAvailable(s, parcels) : 0);
}

/** Cover a negative cash balance from the line — same draw tickLoc used to do alone at month-end. */
export function coverCashShortfall(s: GameState, parcels: ParcelTable): number {
  if (s.cash >= 0) return 0;
  if (!s.loc) s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  const need = Math.ceil(-s.cash);
  const draw = Math.min(need, locAvailable(s, parcels));
  if (draw <= 0) return 0;
  s.loc.balance += draw;
  s.loc.drawnTotal += draw;
  s.cash += draw;
  _locAvailCache = null;
  // Micro-shorts still draw — a $8k interest hole is real — but they used to
  // spam "Short $0.01M" every month and drown the news while the firm died of
  // a thousand LOC cuts. Announce only when the cheque is big enough to read.
  if (need >= 25_000) {
    const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}k`);
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `Short ${fmt(need)} — the line covered ${fmt(draw)} at ${locRate(s).toFixed(2)}%.`,
    });
  }
  return draw;
}

export function drawLoc(s: GameState, parcels: ParcelTable, amount: number): { s: GameState; err?: string } {
  const next: GameState = cloneState(s);
  if (!next.loc) next.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  const avail = locAvailable(next, parcels);
  const amt = Math.round(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { s, err: "Name an amount." };
  if (amt > avail) {
    const st = sponsorStanding(next);
    return {
      s,
      err: `The line only has $${(avail / 1e6).toFixed(2)}M left.`
        + (st.mark > 0.3 ? ` The bank cut your advance rate — ${st.label}.` : " That's the bank's advance rate against your net worth."),
    };
  }
  next.loc.balance += amt;
  next.loc.drawnTotal += amt;
  next.cash += amt;
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Drew $${(amt / 1e6).toFixed(2)}M on the line at ${locRate(next).toFixed(2)}%. Balance $${(next.loc.balance / 1e6).toFixed(2)}M.`,
  });
  return { s: next };
}

export function repayLoc(s: GameState, amount: number): { s: GameState; err?: string } {
  const next: GameState = cloneState(s);
  if (!next.loc?.balance) return { s, err: "Nothing drawn." };
  const amt = Math.min(Math.round(amount), next.loc.balance, Math.max(0, next.cash));
  if (amt <= 0) return { s, err: "No cash to pay it down with." };
  next.loc.balance -= amt;
  next.cash -= amt;
  next.news.unshift({
    q: next.month, kind: "info",
    text: `Paid $${(amt / 1e6).toFixed(2)}M down on the line. Balance $${(next.loc.balance / 1e6).toFixed(2)}M.`,
  });
  return { s: next };
}

// Monthly: accrue interest, sweep idle cash against the balance, and cover a
// shortfall automatically rather than letting the run die with credit unused.
export function tickLoc(s: GameState, parcels: ParcelTable) {
  if (!s.loc) s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  const rate = locRate(s);

  if (s.loc.balance > 0) {
    const interest = Math.round((s.loc.balance * rate) / 100 / 12);
    s.cash -= interest;
    s.loc.interestPaid += interest;
    logBooks(s, "debtSvc", interest);
  }

  // a shortfall draws the line before it becomes insolvency (also called
  // earlier in the month, before workouts escalate — idempotent if already covered)
  coverCashShortfall(s, parcels);
  // idle cash pays the most expensive money down first
  sweepLocIdleCash(s);

  // a shrinking portfolio can put you over the line; the lender wants it back
  const over = s.loc.balance - locLimit(s, parcels);
  if (over > 0) {
    const pay = Math.min(over, Math.max(0, s.cash));
    if (pay > 0) {
      s.loc.balance -= pay;
      s.cash -= pay;
      _locAvailCache = null;
    }
    const stillOver = s.loc.balance - locLimit(s, parcels);
    if (stillOver > 1000) {
      // The bank does not accept "I'll pay you when a building sells." An
      // over-advance the borrower cannot clear in cash is a default on the
      // revolver, and it starts the insolvency clock like any other.
      s.locOverMs = (s.locOverMs ?? 0) + 1;
      s.news.unshift({
        q: s.month, kind: "warn",
        text: s.locOverMs >= 3
          ? `The line has been over-advanced for ${s.locOverMs} months. The bank wants $${(stillOver / 1e6).toFixed(2)}M back and has stopped asking politely.`
          : `The line is over-advanced — the bank wants $${(stillOver / 1e6).toFixed(2)}M back.`,
      });
      // After a quarter the shortfall is treated as cash owed — earlier than
      // the old six-month grace, because playthroughs showed firms dying on
      // micro-LOC while the street still said "expansion." Teeth belong here.
      //
      // AND IT IS A PAYMENT, SO IT GOES ON THE BOOKS. This took the cash and
      // told nobody: consecutive months of an over-advanced line moved money
      // out of the firm with no entry behind it, and `pnpm conserve` calls
      // that vanishing. It is default interest on a revolver the borrower
      // cannot clear — debt service, the expensive kind.
      if (s.locOverMs >= 3) {
        const penalty = Math.round(stillOver * 0.25);
        s.cash -= penalty;
        logBooks(s, "debtSvc", penalty);
      }
    } else s.locOverMs = 0;
  }
}
