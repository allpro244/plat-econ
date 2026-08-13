/**
 * THE FUND — LP capital that is not yours.
 *
 * Second cash account: `s.fund.cash` is vehicle cash; `s.cash` remains GP
 * liquidity. The promote is a transfer between them (combined Δcash = 0), so
 * conserve on (cash + fund.cash) stays honest. See PRINCIPAL_CALLS.md #4 and
 * HANDOFF_PRINCIPAL.md §7.
 *
 * Calibrated industry constants (cited):
 *   pref 8% — typical closed-end CRE preferred return
 *   promote 20% — standard promote over pref
 *   investment period 5y / life 10y — common closed-end shape
 */
import type { GameState } from "./types";
import { cloneState, logBooks, monthLabel } from "./types";
import { markSponsor, sponsorStanding } from "./sponsor";

/** Preferred return — annual, accrued on contributed capital. Industry constant. */
export const FUND_PREF = 0.08;

/** Promote over pref — GP catch-up share of profits. Industry constant. */
export const FUND_PROMOTE = 0.20;

/** Investment period (months). Shape: typical closed-end CRE. */
export const FUND_INVEST_M = 60;

/** Fund life (months). Shape: ten-year closed-end. */
export const FUND_LIFE_M = 120;

/** GP co-invest as share of commitments. Shape: 2–5% practice; mid. */
export const FUND_GP_COINVEST = 0.03;

export interface PlayerFund {
  /** Vintage month. */
  raisedM: number;
  /** Total LP + GP commitments. */
  size: number;
  /** Still uncalled. */
  uncalled: number;
  /** Vehicle cash — second account. */
  cash: number;
  /** Cumulative capital called (LP + GP). */
  called: number;
  /** Cumulative distributions to LPs (ex-promote). */
  distributed: number;
  /** Promote paid to GP to date. */
  promotePaid: number;
  /** Pref accrued unpaid (simplified). */
  prefAccrued: number;
  investEndM: number;
  lifeEndM: number;
  pref: number;
  promote: number;
  gpCommit: number;
  /** Life settled — remaining cash distributed, outcome recorded. */
  settled?: boolean;
  /** True when LPs did not get their capital back. Blocks the next raise. */
  failed?: boolean;
}

/** Live vehicle still inside its life (not yet settled). */
export function fundIsLive(s: GameState): boolean {
  return !!s.fund && !s.fund.settled && s.month < s.fund.lifeEndM;
}

/** Purchases may draw vehicle cash during the investment period. */
export function fundCanBuy(s: GameState): boolean {
  return !!s.fund && !s.fund.settled && s.month <= s.fund.investEndM && s.fund.cash > 0;
}

/**
 * Can the street back a first/next fund? Earned, never a menu — standing,
 * phase, and a minimum track record of realised exits.
 */
export function fundRaiseQuote(s: GameState): {
  ok: boolean;
  size: number;
  reason: string;
} {
  if (s.fundFailedM !== undefined) {
    return {
      ok: false, size: 0,
      reason: "Nobody will back you again. The last vehicle did not return capital.",
    };
  }
  if (s.fund && !s.fund.settled && s.month < s.fund.lifeEndM) {
    return { ok: false, size: 0, reason: "You already have a live fund." };
  }
  const st = sponsorStanding(s);
  if (!st.institutional) {
    return { ok: false, size: 0, reason: `LPs will not back you while the street reads "${st.label}".` };
  }
  const phase = s.econ.phase;
  if (phase === "recession" || phase === "depression") {
    return { ok: false, size: 0, reason: "Nobody raised a real estate fund in a crunch. Wait for the thaw." };
  }
  const exits = (s.exits ?? []).filter((e) => !e.forced && e.gain > 0).length;
  if (exits < 2) {
    return { ok: false, size: 0, reason: "Realised returns come first — LPs want two clean exits on the record." };
  }
  // Size from standing and phase — not a menu. Cleaner mark → larger raise.
  const clean = Math.max(0, 1.6 - st.mark);
  const base = 8_000_000 + clean * 25_000_000;
  const phaseMult = phase === "expansion" ? 1.15 : phase === "peak" ? 0.85 : 1;
  const size = Math.round(base * phaseMult / 100_000) * 100_000;
  return { ok: true, size, reason: `A ${monthLabel(s.month)} vintage of $${(size / 1e6).toFixed(0)}M will clear.` };
}

/** Close a fund — commitments, GP co-invest cheque, uncalled reserve. */
export function raiseFund(s: GameState): { s: GameState; err?: string } {
  const q = fundRaiseQuote(s);
  if (!q.ok) return { s, err: q.reason };
  const next = cloneState(s);
  const gpCommit = Math.round(q.size * FUND_GP_COINVEST);
  if (next.cash < gpCommit) {
    return { s, err: `GP co-invest is $${(gpCommit / 1e6).toFixed(2)}M and you do not have it.` };
  }
  // First close: call GP co-invest + ~40% of LP immediately into the vehicle;
  // rest sits uncalled. Shape: 30–50% reserve practice (rivals.ts).
  const lpCommit = q.size - gpCommit;
  const uncalledShare = 0.40;
  const lpCalled0 = Math.round(lpCommit * (1 - uncalledShare));
  const gpCalled0 = gpCommit; // GP funds at close
  next.cash -= gpCalled0;
  logBooks(next, "lpCalled", lpCalled0); // LP equity in — not income
  // GP co-invest is a transfer from GP cash into the vehicle — combined
  // liquidity unchanged for the GP chip, but fund.cash rises. Book the LP
  // call only as lpCalled; GP move is cash→fund.cash with no income bucket.
  const fundCash = lpCalled0 + gpCalled0;
  next.fund = {
    raisedM: next.month,
    size: q.size,
    uncalled: lpCommit - lpCalled0,
    cash: fundCash,
    called: lpCalled0 + gpCalled0,
    distributed: 0,
    promotePaid: 0,
    prefAccrued: 0,
    investEndM: next.month + FUND_INVEST_M,
    lifeEndM: next.month + FUND_LIFE_M,
    pref: FUND_PREF,
    promote: FUND_PROMOTE,
    gpCommit,
  };
  next.fundPay = true; // new vintage buys from the vehicle by default
  next.news.unshift({
    q: next.month, kind: "event",
    text: `You have raised a $${(q.size / 1e6).toFixed(0)}M fund — vintage ${monthLabel(next.month)}. `
      + `$${(fundCash / 1e6).toFixed(1)}M is called; $${((lpCommit - lpCalled0) / 1e6).toFixed(1)}M sits uncalled. `
      + `The promote is ${(FUND_PROMOTE * 100).toFixed(0)}% over an ${(FUND_PREF * 100).toFixed(0)}% pref.`,
  });
  return { s: next };
}

/** Call more LP capital into the vehicle. */
export function callFundCapital(s: GameState, amount: number): { s: GameState; err?: string } {
  if (!s.fund || s.fund.settled) return { s, err: "No fund." };
  const want = Math.round(Math.min(amount, s.fund.uncalled));
  if (want <= 0) return { s, err: "Nothing left to call." };
  const next = cloneState(s);
  const f = next.fund!;
  f.uncalled -= want;
  f.cash += want;
  f.called += want;
  logBooks(next, "lpCalled", want);
  return { s: next };
}

/**
 * Pref-first waterfall, then promote on the remainder. Mutates `s` in place.
 * Returns LP dollars booked to `lpDistributed` (promote is a GP transfer).
 */
export function applyDistribute(s: GameState, amount: number): number {
  const f = s.fund;
  if (!f || f.settled) return 0;
  const want = Math.round(Math.min(amount, f.cash));
  if (want <= 0) return 0;
  f.cash -= want;
  let rest = want;
  // Pref first — LPs are whole on the hurdle before the GP takes a dollar.
  const prefPay = Math.min(rest, Math.max(0, Math.round(f.prefAccrued)));
  f.prefAccrued -= prefPay;
  f.distributed += prefPay;
  rest -= prefPay;
  let toGp = 0;
  if (rest > 0) {
    toGp = Math.round(rest * f.promote);
    const toLp = rest - toGp;
    f.distributed += toLp;
    f.promotePaid += toGp;
    s.cash += toGp;
  }
  const toLpTotal = want - toGp;
  if (toLpTotal > 0) logBooks(s, "lpDistributed", toLpTotal);
  return toLpTotal;
}

/**
 * Distribute to LPs from fund cash. Pref first, then promote crystallises to
 * GP cash on profits over pref.
 */
export function distributeFund(s: GameState, amount: number): { s: GameState; err?: string } {
  if (!s.fund || s.fund.settled) return { s, err: "No fund." };
  const want = Math.round(Math.min(amount, s.fund.cash));
  if (want <= 0) return { s, err: "The vehicle has no cash to distribute." };
  const next = cloneState(s);
  applyDistribute(next, want);
  return { s: next };
}

/** Charge equity from the vehicle. Mutates `s`. */
export function chargeFundEquity(s: GameState, amount: number): { err?: string } {
  if (!fundCanBuy(s)) {
    return { err: "The vehicle is not buying — investment period closed or no cash." };
  }
  const want = Math.round(amount);
  if ((s.fund?.cash ?? 0) < want) {
    return { err: `The vehicle is short $${((want - (s.fund?.cash ?? 0)) / 1e6).toFixed(2)}M.` };
  }
  s.fund!.cash -= want;
  return {};
}

/** Sale / operating proceeds into the vehicle. Mutates `s`. */
export function creditFundCash(s: GameState, amount: number): void {
  if (!s.fund || s.fund.settled) return;
  s.fund.cash += Math.round(amount);
}

/**
 * Monthly pref accrual; at life end, settle remaining cash and record whether
 * LPs got their capital back. A failed vehicle is the second death — you
 * survive, and nobody will back you again.
 */
export function tickFund(s: GameState): void {
  const f = s.fund;
  if (!f || f.settled) return;
  // Pref on net contributed capital still outstanding.
  const netOut = Math.max(0, f.called - f.distributed);
  f.prefAccrued += netOut * (f.pref / 12);

  if (s.month === f.lifeEndM) {
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `Your fund has reached the end of its life. Remaining vehicle cash is $${(f.cash / 1e6).toFixed(2)}M; `
        + `LPs expect distributions. A sponsor who cannot finish does not raise the next one.`,
    });
  }

  if (s.month >= f.lifeEndM) {
    settleFund(s);
  }
}

/** Wind the vehicle: distribute remaining cash, stamp success or the second death. */
export function settleFund(s: GameState): void {
  const f = s.fund;
  if (!f || f.settled) return;
  if (f.cash > 0) applyDistribute(s, f.cash);
  f.settled = true;
  s.fundPay = false;
  // DPI on contributed capital. Below 1.0x means LPs lost principal — failed.
  const dpi = f.called > 0 ? f.distributed / f.called : 1;
  if (dpi < 1.0) {
    f.failed = true;
    s.fundFailedM = s.month;
    markSponsor(s, "forced", "fund wind-down", Math.max(0, f.called - f.distributed));
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `The fund returned $${(f.distributed / 1e6).toFixed(2)}M against $${(f.called / 1e6).toFixed(2)}M called `
        + `(${(dpi * 100).toFixed(0)}¢ on the dollar). Nobody will back you again.`,
    });
  } else {
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `Fund wound down — LPs received $${(f.distributed / 1e6).toFixed(2)}M on $${(f.called / 1e6).toFixed(2)}M called `
        + `(${dpi.toFixed(2)}x). Promote to the house: $${(f.promotePaid / 1e6).toFixed(2)}M.`,
    });
  }
}

/** Combined liquidity for conserve — GP cash + vehicle cash. */
export function totalLiquidity(s: GameState): number {
  return s.cash + (s.fund?.cash ?? 0);
}
