// Structured debt: fixed or floating at origination, IO periods, balloon
// maturities that must refinance or repay, DSCR/LTV covenants tested every
// quarter, and cash sweeps on breach. Proceeds gate on DSCR at underwriting,
// not just LTV — a lender lends against income, not hope.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import { resolveRec, concentration, industryConcentration } from "./value";
import type { Condition, Econ, GameState, Holding, Loan } from "./types";
import { logBooks, monthLabel, cloneState} from "./types";
import { openWorkout } from "./workout";
import { lenderAppetite } from "./lenders";
import {
  ownedHoldingNoiYr, ownedHoldingNoiYrFromRec, ownedHoldingValue,
  ownedHoldingValueFromRec, proFormaNOIYr, capRateFor,
  isVacantLandLoanCollateral,
} from "./value";
import { walt } from "./leasing";
import { INDUSTRY_LABEL } from "./market";
import { sponsorStanding } from "./sponsor";
import { fundCashNeed, fundableNow, coverCashShortfall, sweepLocIdleCash } from "./credit";
import { sizeAreaScale } from "./cityscale";

export type PrepayKind = "open" | "stepdown" | "yieldmaint";

export interface LoanProduct {
  /**
   * A TRANSITIONAL LENDER. Sizes on the stabilised business plan as well as on
   * the income in place, and takes the larger — see sizeRest. Only the debt
   * fund carries it, which is what a debt fund IS: the life company needs
   * stabilised income in hand and the conduit needs a rated pool, and neither
   * of them writes a lease-up. "They will lend on anything, at a price."
   */
  bridge?: boolean;
  id: string;
  label: string;
  lender: string;      // the institution behind the sheet
  blurb: string;       // what this money is FOR, in one line
  ltv: number;
  spread: number;      // over the index
  floating: boolean;
  ioM: number;
  amortYears: number;
  termM: number;       // balloon
  uwDscr: number;      // the coverage the desk underwrites to
  debtYield: number;   // minimum NOI ÷ loan proceeds — the post-2009 backstop
  points: number;      // origination fee, as a share of principal
  recourse: boolean;   // a personal guarantee, and a cheaper coupon for it
  prepay: PrepayKind;
  prepayM: number;     // months the penalty runs
  mezz?: boolean;      // sits behind a senior loan rather than replacing it
  kicker?: number;     // participating paper: the lender's share of the gain
  minDSCR: number;     // the covenant
  maxLTV: number;
  minLoan?: number;    // below this they do not underwrite anything
  maxLoan?: number;    // above this is past the desk's hold size
  minCondition?: "good";  // the life company does not finance tired buildings
  window?: boolean;    // a desk that CLOSES with the cycle instead of tightening
}

// THE DESKS, WITH NAMES ON THE DOORS.
//
// The old sheet was eight abstract products — "agency fixed", "floating IO" —
// which is how a spreadsheet thinks about debt and not how anybody borrows.
// You do not call a product; you call a PERSON at an institution with a
// balance sheet, a lending limit, a house view and a memory. Groundwork got
// this right and this desk is rebuilt on its pattern: five named lenders, each
// with a personality, a check size, standards, and a posture that moves with
// the cycle. The hometown bank answers the phone in a crunch — for friends.
// The life company writes the cheapest paper in town and will not look at a
// tired building. The conduit has the sharpest big-loan pricing on the street
// and the window slams shut the day markets wobble. The debt fund will lend on
// anything, at a price, in any market. The price is the point.
//
// Amortization is a choice, not a property of the product: the banks quote a
// 25-year schedule 25bps inside their 30-year sheet (faster paydown, less
// cash flow, safer loan — priced accordingly), and IO periods cost real
// THE MORTGAGE CONSTANT IS WHAT DECIDES WHETHER LEVERAGE PAYS, not the coupon,
// and every senior product here amortised from day one. At a 6.4% coupon over
// twenty-five years the constant is about 8.0%; against a going-in cap rate
// near 7% that is negative cash-on-cash even though the interest rate is
// comfortably BELOW the cap rate. The strategy tournament measured the
// consequence twice: maximum leverage returned -$0.1M with two wipeouts in
// four seeds while all-cash returned $117M, and raising cap rates alone did
// not touch it, because the gap was never the coupon.
//
// Real senior debt carries interest-only. One to three years is standard on a
// five-to-seven year term, a life company will write two, and the 2005-07
// conduit vintage was famously interest-only for its whole term. These are
// conservative against that.
//
// spread. Both are listed as separate lines because that is how a term sheet
// arrives.
export const PRODUCTS: LoanProduct[] = [
  {
    id: "harbor", label: "First Harbor Bank · 5 yr, 25-yr am", lender: "First Harbor Bank",
    blurb: "The hometown bank. Small checks, honest spreads, recourse — and they answer the phone in a crunch, for their friends.",
    ltv: 0.68, spread: 1.55, floating: false, ioM: 12, amortYears: 25, termM: 60,
    uwDscr: 1.25, debtYield: 0.09, points: 0.006, recourse: true, prepay: "stepdown", prepayM: 36,
    // The loose ongoing covenant is the community bank's real product: they do
    // not re-appraise you every quarter, they watch the payment arrive. The
    // sizing tests above are unchanged — this is the leash, not the cheque.
    minDSCR: 1.15, maxLTV: 0.82, maxLoan: 6_000_000,
  },
  /**
   * WHY THE REGIONAL NO LONGER STRICTLY DOMINATES THE HOMETOWN BANK.
   *
   * Measured at game start over 1,464 real listings: First Harbor won the
   * financing pick on ZERO of them, in every size band. The 25-year Alden
   * sheet beat it on rate, interest-only, advance, term, hold size AND
   * recourse simultaneously — a strictly dominated product, which is why the
   * lender choice never felt like a choice. Two facts about the actual market
   * were missing, and both are restored below rather than any number tuned:
   *
   * 1. BANK PAPER IS RECOURSE. A bank's portfolio CRE loan carries a personal
   *    guarantee — community and regional alike. Non-recourse money is
   *    institutional money: the life company, the conduit, the debt fund.
   *    Alden was writing $2M non-recourse at 72%, which is a product that
   *    does not exist anywhere. Now both banks sign you personally, and the
   *    way to keep your name off the paper is the way it is in life — good
   *    product to Pelican, $10M+ to the conduit, or Cordage's spread.
   *
   * 2. A REGIONAL'S CRE DESK HAS A MINIMUM. They will not get out of bed for
   *    a loan under a couple of million — the underwriting costs the same and
   *    the yield does not cover it. $1-3M minimums are standard; $2.5M is the
   *    middle of that band. Under it, the hometown bank IS the market, which
   *    is what "small checks" on its blurb has claimed all along.
   *
   * And the covenants now say what the blurb says. Alden was described as
   * "covenant-happy" while carrying the same 1.25 ongoing DSCR trigger as
   * Harbor; it now trips its sweep at 1.30. Harbor drops to 1.15 — a
   * community bank does not mark you to market, it cares whether the payment
   * arrives, and forbearance for its friends is already in the engine
   * (crunchEase). So the bank choice is now the real one: more proceeds on a
   * tighter leash, or fewer on a looser one.
   */
  {
    id: "savings", label: "Alden Savings & Trust · 7 yr, 30-yr am", lender: "Alden Savings & Trust",
    blurb: "The regional. Bigger checks, covenant-happy, recourse like every bank — and they tighten fast when the cycle turns.",
    ltv: 0.72, spread: 1.70, floating: false, ioM: 24, amortYears: 30, termM: 84,
    uwDscr: 1.25, debtYield: 0.085, points: 0.008, recourse: true, prepay: "stepdown", prepayM: 48,
    minDSCR: 1.30, maxLTV: 0.85, minLoan: 2_500_000, maxLoan: 25_000_000,
  },
  {
    // the 25-year sheet: same desk, sharper rate, faster paydown
    id: "savings25", label: "Alden Savings & Trust · 7 yr, 25-yr am · −25bps", lender: "Alden Savings & Trust",
    blurb: "Faster paydown buys a sharper rate. Less cash flow, more equity, and the bank sleeps better than you do.",
    ltv: 0.72, spread: 1.45, floating: false, ioM: 36, amortYears: 25, termM: 84,
    uwDscr: 1.25, debtYield: 0.085, points: 0.008, recourse: true, prepay: "stepdown", prepayM: 48,
    minDSCR: 1.30, maxLTV: 0.85, minLoan: 2_500_000, maxLoan: 25_000_000,
  },
  {
    id: "pelican", label: "Pelican Life Insurance · 15 yr, 30-yr am", lender: "Pelican Life Insurance",
    blurb: "Life-company money: the cheapest debt in town, for well-kept product only. Low leverage, long memory, brutal to leave early.",
    ltv: 0.58, spread: 1.15, floating: false, ioM: 24, amortYears: 30, termM: 180,
    uwDscr: 1.35, debtYield: 0.095, points: 0.008, recourse: false, prepay: "yieldmaint", prepayM: 144,
    minDSCR: 1.30, maxLTV: 0.80, minLoan: 4_000_000, minCondition: "good",
  },
  {
    id: "conduit", label: "Meridian Street conduit · 10 yr, 5 yr IO", lender: "Meridian Street Capital",
    blurb: "The CMBS desk. Sharp pricing on big loans, five interest-only years — and the window slams shut the day markets wobble.",
    ltv: 0.75, spread: 1.90, floating: false, ioM: 60, amortYears: 30, termM: 120,
    uwDscr: 1.20, debtYield: 0.08, points: 0.010, recourse: false, prepay: "yieldmaint", prepayM: 108,
    minDSCR: 1.15, maxLTV: 0.85, minLoan: 10_000_000, window: true,
  },
  {
    id: "cordage", label: "Cordage Debt Partners · 3 yr, floating IO", lender: "Cordage Debt Partners",
    blurb: "The debt fund. They will lend on anything, at a price, in any market. The price is the point.",
    ltv: 0.80, spread: 4.10, floating: true, ioM: 36, amortYears: 30, termM: 36,
    uwDscr: 0.90, debtYield: 0.055, points: 0.020, recourse: false, prepay: "open", prepayM: 0,
    minDSCR: 0.90, maxLTV: 0.92, bridge: true,
  },
  {
    id: "mezz", label: "Cordage mezzanine · behind the senior", lender: "Cordage Debt Partners",
    blurb: "Stacks to 85%. The coupon is why nobody does this twice.",
    ltv: 0.85, spread: 8.00, floating: false, ioM: 120, amortYears: 30, termM: 84,
    uwDscr: 1.05, debtYield: 0.055, points: 0.025, recourse: false, prepay: "stepdown", prepayM: 48,
    mezz: true, minDSCR: 1.00, maxLTV: 0.95,
  },
  {
    // Land has no income, so nobody else on this street will touch it. Small,
    // short, recourse — the hometown bank doing a favor it expects returned.
    id: "land", label: "First Harbor land loan · 3 yr, recourse", lender: "First Harbor Bank",
    blurb: "The only money that will look at dirt. Half the price, and you sign for it.",
    ltv: 0.50, spread: 3.60, floating: true, ioM: 36, amortYears: 30, termM: 36,
    uwDscr: 0, debtYield: 0, points: 0.015, recourse: true, prepay: "open", prepayM: 0,
    minDSCR: 0, maxLTV: 0.70,
  },
];

/**
 * Is this desk's window open at all today? The conduit is the one that closes
 * outright: securitization needs buyers for the bonds, and in a crunch or a
 * recession there are none, at any price. Banks tighten instead of closing —
 * the existing credit-cycle machinery already cuts their advance rates.
 */
export function windowOpen(s: GameState, p: LoanProduct): boolean {
  // A desk with no capital behind it is not "tightening" — it is shut, and a
  // failed one is a receiver with a phone that nobody answers. This is the
  // difference between a credit crunch that happens TO the city and one that
  // happens AT a named institution you could have watched coming.
  if (lenderAppetite(s, p.lender) < 0.12) return false;
  if (!p.window) return true;
  return (s.econ.creditIdx ?? 1) >= 0.78 && s.econ.phase !== "recession";
}

// ------------------------------------------------------- lender relationships
/**
 * A name they trust is worth basis points. Quiet, performing paper builds the
 * file; a closed loan opens it; a tripped covenant sours the coffee.
 *
 * WHAT IT IS WORTH DEPENDS ON WHO IS LENDING, and the spread between them is
 * the point. A commercial bank IS a relationship business — the whole reason
 * to keep deposits and a line with one desk is that the fourth loan prices
 * better than the first — so a great file there is worth a full forty basis
 * points. A life company is pricing off its own liabilities and its allocation
 * committee cares more about the asset than the sponsor, so the same file is
 * worth about thirty. A debt fund prices risk rather than friendship, and a
 * known sponsor gets twenty-five and no more. A conduit gives nothing at all:
 * the loan is going into a bond and the bond has never met you.
 *
 * And it is EARNED, not accrued. The curve is convex, so the first twenty
 * points of file barely move the quote and the last twenty move it a lot — a
 * borrower who has closed twice is not a relationship, and a borrower who has
 * closed eleven times and never missed a payment is.
 */
const REL_MAX: Record<string, number> = { bank: 0.40, life: 0.30, fund: 0.25, conduit: 0 };
export function lenderRelOf(s: GameState, lender: string): number {
  return s.lenderRel?.[lender] ?? 20;
}
export function relDiscount(s: GameState, p: LoanProduct): number {
  if (p.window || p.id === "cordage" || p.id === "mezz") return 0;
  const kind = s.lenders?.find((l) => l.name === p.lender)?.kind ?? "bank";
  const max = REL_MAX[kind] ?? 0.30;
  if (max <= 0) return 0;
  const t = Math.max(0, Math.min(1, (lenderRelOf(s, p.lender) - 20) / 80));
  return +(max * Math.pow(t, 1.35)).toFixed(4);
}
export function bumpLenderRel(s: GameState, lender: string | undefined, amt: number) {
  if (!lender) return;
  if (!s.lenderRel) s.lenderRel = {};
  s.lenderRel[lender] = Math.max(0, Math.min(100, (s.lenderRel[lender] ?? 20) + amt));
}

/**
 * FULL ON A NAME, FULL ON A CLASS.
 *
 * A credit committee runs two concentration tests that no amount of coverage
 * can argue with. The single-name test: one borrower cannot be more than a
 * fixed share of the book, so a desk that already holds a tenth of its book
 * against you has almost nothing left to write you regardless of the deal.
 * The class test, read off the mortgage record ledger.ts keeps: a bank whose
 * paper in this town is already half office does not want your office loan at
 * par, however good it is. Neither is a wall — proceeds taper, the quote says
 * why, and the answer is what it is in life: go to the desk that is NOT full.
 */
export function concentrationRoom(s: GameState, p: LoanProduct, klass?: string): { mult: number; capRoom: number; why?: string } {
  const l = lenderByNameLocal(s, p.lender);
  if (!l || l.book <= 0) return { mult: 1, capRoom: Infinity };
  const nameCap = l.kind === "bank" ? 0.12 : l.kind === "life" ? 0.08 : l.kind === "conduit" ? 0.30 : 0.35;
  const capRoom = Math.max(0, l.book * nameCap - l.yours);
  let mult = 1; let why: string | undefined;
  if (klass && klass !== "land" && l.classBook) {
    const tot = Object.values(l.classBook).reduce((a, b) => a + b, 0);
    const classCap = l.kind === "bank" ? 0.45 : l.kind === "life" ? 0.55 : l.kind === "conduit" ? 0.65 : 1;
    const share = tot > 0 ? (l.classBook[klass] ?? 0) / tot : 0;
    if (tot > 40_000_000 && classCap < 1 && share > classCap) {
      const over = (share - classCap) / Math.max(0.05, 1 - classCap);
      mult = Math.max(0.35, 1 - 0.8 * over);
      why = `${p.lender} is already ${(share * 100).toFixed(0)}% ${klass} in this town against a `
        + `${(classCap * 100).toFixed(0)}% concentration limit — they are full, and new ${klass} paper gets a haircut`;
    }
  }
  return { mult, capRoom, why };
}
// lenders.ts imports PRODUCTS from this file; resolve the lender locally to
// keep the existing one-way import for data and functions both.
function lenderByNameLocal(s: GameState, name: string) {
  return s.lenders?.find((l) => l.name === name);
}

export const productById = (id: string): LoanProduct => PRODUCTS.find((p) => p.id === id) ?? PRODUCTS[0];

const REFI_FEE = 0.01;

/**
 * WHAT TODAY'S MARKET DOES TO A DESK'S STATED ADVANCE RATE.
 *
 * Two things move it and they move together: the credit window (spreads widen,
 * advance rates come down) and THIS desk's own capital, which is the reason a
 * crunch has a name on it rather than being weather. Both were already in
 * `quote`; they are lifted out here because the street's refinancings have to
 * be underwritten by the same rule the player's are, and a second copy of this
 * arithmetic living in rivals.ts would be the same quantity with two answers.
 *
 * `ease` is the hometown bank cutting a friend slack in a crunch — see the
 * crunchEase term at the only call site that passes it.
 */
export function advanceFactor(s: GameState, lender: string, ease = 1): number {
  const tight = Math.max(0, 1 - (s.econ.creditIdx ?? 1));
  const app = lenderAppetite(s, lender);
  return (1 - 0.30 * tight * ease) * Math.min(1.02, 0.55 + 0.45 * app);
}

/**
 * WHAT THE MARKET WILL REFINANCE FOR A BORROWER WHO IS NOT YOU.
 *
 * A firm on this street with a balloon landing walks the same desks your own
 * balloon walks — the regional, the hometown bank, then hard money — and is
 * sized on the same three tests: advance rate against today's value, coverage
 * against today's income, and debt yield. It reads the same live lender
 * appetite, so when a desk is impaired the street cannot refinance either, and
 * that is the whole point of giving the banks books.
 *
 * The two things it does NOT apply are the two that are facts about the PLAYER
 * rather than about lending: `sponsorStanding`, which is your record and not
 * theirs, and the single-name concentration test, which is measured against
 * what this desk has lent to YOU. Hold size is skipped for the same reason — a
 * firm's book is spread across desks and is not one asset.
 *
 * `maxLtv` is the borrower's own covenant, a ceiling on top of whatever the
 * market would otherwise write.
 */
export function streetRefiProceeds(
  s: GameState, value: number, noiYr: number, maxLtv: number, stab?: StabView,
): { principal: number; binding: string; lender: string } {
  let best = 0, binding = "advance rate", lender = "";
  // WHICH DESKS EVEN LOOK AT IT. The three income desks — the regional, the
  // hometown bank, then hard money — walk any building. A SITE has no income,
  // so all three size it at zero on coverage, and the only money in this town
  // that will look at dirt is the land loan: half leverage, short, recourse.
  // That is not a special case invented for the street; it is the same split
  // `quote` already makes on `uwDscr <= 0`, read from the same product sheet.
  //
  // `stab` is the bridge leg the player's buyQuote already feeds Cordage. The
  // street used to call quote() without it, so a lease-up sized to nearly
  // nothing on in-place income while the player could finance the plan — an
  // asymmetry in the player's favour that nobody asked for.
  const desks = noiYr > 0 ? ["savings", "harbor", "cordage"] : ["land"];
  for (const p of desks.map(productById)) {
    if (!windowOpen(s, p)) continue;
    const q = quote(s, p, value, noiYr, undefined, true, p.bridge ? stab : undefined);
    const pr = Math.min(q.principal, Math.round(maxLtv * value));
    if (pr > best) {
      best = pr;
      binding = pr < q.principal ? "their own covenant"
        : q.stabConstrained ? "stab"
        : q.dyConstrained ? "debt yield" : q.dscrConstrained ? "coverage" : "advance rate";
      lender = p.lender;
    }
  }
  return { principal: Math.round(Math.max(0, best)), binding, lender };
}

/** Whether this desk will look at you at all today. */
export function productOpen(s: GameState, p: LoanProduct): boolean {
  if (sponsorStanding(s).institutional) return true;
  // hard money does not care about your history; it prices it
  return p.id === "cordage" || p.id === "mezz" || p.id === "land";
}

/**
 * What it costs to get out of a loan early.
 *  open        — nothing, walk away
 *  stepdown    — 5% of the balance, falling a point a year
 *  yieldmaint  — the lender is made whole on the coupon it was promised, which
 *                is brutal early in the term and the reason long money is a
 *                commitment rather than a preference
 */
export function prepayPenalty(loan: Loan, month: number): number {
  const p = loan.prepay ?? "open";
  const left = Math.max(0, (loan.prepayUntilM ?? 0) - month);
  if (p === "open" || left <= 0) return 0;
  if (p === "stepdown") {
    const yearsLeft = Math.ceil(left / 12);
    return Math.round(loan.balance * Math.min(0.05, 0.01 * yearsLeft));
  }
  // yield maintenance: the coupon the lender loses, discounted roughly
  const yrs = left / 12;
  return Math.round(loan.balance * (loan.ratePct / 100) * yrs * 0.62);
}

/** Balance + break cost to retire a mortgage today. */
/**
 * SENIOR + MEZZ AT THE CLOSING TABLE. Sale, seizure, facility, private
 * takeout and payoff all need the same stack maths — using only `h.loan`
 * left Cordage junior unpaid and leaked conserve.
 */
export function stackPayoff(h: Holding, month: number): {
  seniorBal: number; mezzBal: number; balance: number;
  seniorPenalty: number; mezzPenalty: number; penalty: number; due: number;
} {
  const senior = h.loan ? payOffDue(h.loan, month) : { balance: 0, penalty: 0, due: 0 };
  const mezz = h.mezz && h.mezz.balance > 0 ? payOffDue(h.mezz, month) : { balance: 0, penalty: 0, due: 0 };
  return {
    seniorBal: senior.balance,
    mezzBal: mezz.balance,
    balance: senior.balance + mezz.balance,
    seniorPenalty: senior.penalty,
    mezzPenalty: mezz.penalty,
    penalty: senior.penalty + mezz.penalty,
    due: senior.due + mezz.due,
  };
}

export function payOffDue(loan: Loan, month: number): { balance: number; penalty: number; due: number } {
  const balance = Math.max(0, Math.round(loan.balance));
  if (balance <= 0) return { balance: 0, penalty: 0, due: 0 };
  const penalty = prepayPenalty({ ...loan, balance }, month);
  return { balance, penalty, due: balance + penalty };
}

/**
 * RETIRE A MORTGAGE WITH CASH (and the line, if needed).
 *
 * The Debt page only offered Refi — so a vacant site with a crumb of land-loan
 * balance left ($26 on a $150M lot) could not be ground-leased, and the error
 * said "pay off the mortgage first" with no button that did it. This is that
 * button: balance plus any prepayment penalty, lien released, fee free and
 * clear for a ground lease or a clean sale.
 */
export function payOffLoan(
  s: GameState, parcels: ParcelTable, bbl: string,
): { s: GameState; err?: string; msg?: string } {
  const next = cloneState(s);
  const h = next.holdings[bbl];
  const rec = resolveRec(parcels, next, bbl);
  if (!h?.loan) return { s, err: "Nothing to pay off on that deed." };
  if (!rec) return { s, err: "Unknown parcel." };
  if (next.facility?.bbls.includes(bbl)) {
    return { s, err: "This deed is pledged to your facility. Release it there, or repay the facility — a mortgage payoff does not cut the crossed lien." };
  }
  const senior = payOffDue(h.loan, next.month);
  const mezz = h.mezz && h.mezz.balance > 0 ? payOffDue(h.mezz, next.month) : null;
  const balance = senior.balance + (mezz?.balance ?? 0);
  const penalty = senior.penalty + (mezz?.penalty ?? 0);
  const due = senior.due + (mezz?.due ?? 0);
  if (balance <= 0) {
    h.loan = null;
    if (h.mezz) h.mezz = null;
    if (next.workouts?.[bbl]) delete next.workouts[bbl];
    return { s: next, msg: "Cleared — nothing was left on the note." };
  }
  if (fundableNow(next, parcels) < due) {
    const short = due - fundableNow(next, parcels);
    return {
      s,
      err: penalty > 0
        ? `Need $${due.toLocaleString()} to retire this ($${balance.toLocaleString()} balance + $${penalty.toLocaleString()} to break the paper) — short $${short.toLocaleString()}.`
        : `Need $${due.toLocaleString()} cash to retire this loan — short $${short.toLocaleString()}.`,
    };
  }
  const lender = h.loan.holder ?? productById(h.loan.product).lender;
  const paid = fundCashNeed(next, parcels, due);
  if (paid < due) {
    return { s, err: `Could not raise the $${due.toLocaleString()} payoff.` };
  }
  logBooks(next, "debtSvc", due);
  h.loan = null;
  if (h.mezz) h.mezz = null;
  if (next.workouts?.[bbl]) delete next.workouts[bbl];
  // Paying as agreed is the quiet good file — not a celebration, not a ding.
  bumpLenderRel(next, lender, 0.5);
  if (mezz) bumpLenderRel(next, "Cordage Debt Partners", 0.5);
  const addr = rec.address ?? bbl;
  next.news.unshift({
    q: next.month, kind: "deal",
    text: penalty > 0
      ? `Paid off ${addr}: $${balance.toLocaleString()} to ${lender}`
        + (mezz ? " and Cordage mezz" : "")
        + ` plus $${penalty.toLocaleString()} to break the paper. The deed is free and clear.`
      : `Paid off ${addr}: $${balance.toLocaleString()} to ${lender}`
        + (mezz ? " and Cordage mezz" : "")
        + `. The deed is free and clear.`,
  });
  return {
    s: next,
    msg: penalty > 0
      ? `Paid off — $${due.toLocaleString()} (incl. $${penalty.toLocaleString()} break fee).`
      : `Paid off — $${due.toLocaleString()}.`,
  };
}

export function monthlyPayment(principal: number, ratePct: number, years: number): number {
  const i = ratePct / 100 / 12;
  const n = years * 12;
  return (principal * i) / (1 - Math.pow(1 + i, -n));
}

/** What a desk will actually write, and — as of the hold-size fix — why not more. */
export interface Quote {
  principal: number;
  ratePct: number;
  dscrConstrained: boolean;
  dyConstrained: boolean;
  debtYield: number;
  concWhy?: string;
  /** The advance was truncated by the DESK's limit, not by anything about the building. */
  holdCapped?: boolean;
  /** Sized on the business plan rather than on the income the building earns today. */
  stabConstrained?: boolean;
}

/**
 * WHAT A TRANSITIONAL ASSET IS WORTH WHEN THE PLAN IS DONE.
 *
 * The caller computes this because it is the only one holding the ParcelRecord.
 * `noiYr` is the pro-forma stabilised NOI — the engine's own `noiYr(stabilised)`
 * at market rents and the class's natural occupancy — and `value` is that
 * capitalised at the building's own cap rate.
 */
export interface StabView { noiYr: number; value: number }

/**
 * THE STABILISED VIEW a bridge desk underwrites — one place, so buyQuote and
 * the street's acquisition loan cannot invent two answers for the plan.
 */
export function stabViewFor(
  rec: ParcelRecord, econ: Econ, condition: Condition, basis: number,
): StabView | undefined {
  const stabNoi = proFormaNOIYr(rec, econ, condition, basis);
  const stabCap = capRateFor(rec, econ, condition);
  if (!(stabCap > 0 && stabNoi > 0)) return undefined;
  return { noiYr: stabNoi, value: (stabNoi / stabCap) * 100 };
}

/**
 * `street` sizes the loan for a borrower who is not the player: the sponsor
 * record and the single-name concentration test both drop out, because both
 * are measured against YOU. See streetRefiProceeds, the only caller that sets
 * it. Everything else — the window, the desk's appetite, the three tests — is
 * the same arithmetic, because it is the same credit market.
 */
export function quote(s: GameState, product: LoanProduct, price: number, noiYr: number, klass?: string, street = false, stab?: StabView): Quote {
  // Capital availability moves the terms, not just the index. When the credit
  // window closes, spreads widen, advance rates come down and the desk
  // underwrites to a fatter coverage — all at once, which is what makes a
  // crunch a crunch rather than a slightly worse quote.
  const ci = s.econ.creditIdx ?? 1;
  const tight = Math.max(0, 1 - ci);
  // Your name moves the price twice: the market-wide record (a foreclosure
  // follows you everywhere) and the file at THIS desk — quiet, performing
  // paper with one lender is worth up to 40bps with that lender and nothing
  // anywhere else, which is why real borrowers go back to the same banks.
  const st = street ? { advanceCut: 0, spreadAdd: 0 } : sponsorStanding(s);
  const rel = street ? 0 : relDiscount(s, product);
  // the hometown bank cuts its friends slack in a crunch instead of cutting them off
  const crunchEase = !street && product.id === "harbor" && lenderRelOf(s, product.lender) >= 55 ? 0.5 : 1;
  // THIS DESK'S OWN BALANCE SHEET, not the city's. A lender that has just
  // charged off a year of bad property loans rations everybody — including
  // the borrower who did nothing wrong — and a flush one stretches. Read it
  // on Research: the appetite number here is the same number shown there, a
  // quarter before it shows up in a quote.
  const app = lenderAppetite(s, product.lender);
  const conc = street ? { mult: 1, capRoom: Infinity, why: undefined as string | undefined } : concentrationRoom(s, product, klass);
  const ratePct = +(s.econ.indexRate + product.spread * (1 + 1.1 * tight * crunchEase) + 0.9 * tight * crunchEase
    + Math.max(0, 1 - app) * 0.8 + st.spreadAdd - rel).toFixed(2);
  const byLtv = Math.min(conc.capRoom,
    product.ltv * advanceFactor(s, product.lender, crunchEase) * (1 - st.advanceCut) * conc.mult * price);
  // a desk that is not in the market for this deal quotes nothing at all
  if (!windowOpen(s, product)) return { principal: 0, ratePct, dscrConstrained: false, dyConstrained: false, debtYield: 0, concWhy: conc.why };
  // A HOLD SIZE IS A LIMIT ON ONE ASSET. The street's books are spread across
  // desks and are not one asset, so the size tests are skipped for them.
  // Hold dollars scale with island area (k²) — the $6M/$25M constants were
  // written for the standard City; a Great City desk that will not hold past
  // $6M while its book is four times larger is a constant wearing a mechanism's
  // clothes.
  const holdMax = product.maxLoan
    ? Math.round(product.maxLoan * sizeAreaScale(s))
    : undefined;
  if (!street && holdMax && byLtv > holdMax) {
    // they participate up to the hold size rather than walking — a smaller
    // check from a lender who wants the file is still a real quote.
    //
    // AND IT HAS TO SAY SO. This branch silently truncated the advance and
    // then reported whichever of DSCR/debt-yield/LTV happened to bind the
    // stub, so a $700M tower asking First Harbor for money got a $6.0M quote
    // labelled "advance rate" — which is not the reason and is not fixable by
    // anything the player can do to the building. Three different walls
    // (standing, hold size, window) all read to the borrower as "pay money
    // in", and that is the whole defect: a quote with no reason is a dead
    // button. `holdCapped` carries the fact up to the panel.
    return {
      ...sizeRest(s, product, Math.min(byLtv, holdMax), price, noiYr, ratePct, tight, product.bridge ? stab : undefined),
      concWhy: conc.why,
      holdCapped: true,
    };
  }
  if (!street && product.minLoan && byLtv < product.minLoan) return { principal: 0, ratePct, dscrConstrained: false, dyConstrained: false, debtYield: 0, concWhy: conc.why };
  // A site produces no income, so a coverage test would size every land loan
  // at zero. This one is underwritten on the dirt alone, which is why it is
  // half-leverage, short, and comes with a guarantee.
  if (product.uwDscr <= 0) {
    return { principal: Math.max(0, Math.round(byLtv)), ratePct, dscrConstrained: false, dyConstrained: false, debtYield: 0, concWhy: conc.why };
  }
  return { ...sizeRest(s, product, byLtv, price, noiYr, ratePct, tight, product.bridge ? stab : undefined), concWhy: conc.why };
}

/**
 * A LENDER WHO SIZES A LEASE-UP ON ITS IN-PLACE INCOME IS NOT LENDING ON IT.
 *
 * Every desk here underwrote the rent roll the building has today, which is
 * right for permanent debt and wrong for a transitional asset. A 40%-let block
 * throws off almost no NOI, so coverage and debt yield both size to nearly
 * nothing and the quote comes back at a fraction of the price — while in life
 * that is precisely the deal a bridge lender writes, because they are lending
 * against the BUSINESS PLAN and pricing the risk that it fails.
 *
 * So a `bridge` product sizes a second way and takes whichever is larger:
 *
 *   in place    min(advance x basis, DSCR, debt yield)     — what it earns now
 *   stabilised  min(advance x basis, STAB_LTV x stab value) — what it will earn
 *
 * The larger of the two needs no occupancy threshold to decide which applies,
 * and that is why it is written this way rather than with a test for "is this
 * transitional": on a stabilised building the stabilised value is the value,
 * STAB_LTV is below the advance rate, and the in-place leg wins on its own. The
 * bridge leg can only ever bind on an asset whose income is below its potential,
 * which is the definition of the thing it exists for.
 *
 * The as-is advance still caps it. A lender lends against the lesser of cost and
 * appraisal whatever the plan says — you cannot borrow the upside twice.
 */
function sizeRest(s: GameState, product: LoanProduct, byLtv: number, price: number, noiYr: number, ratePct: number, tight: number, stab?: StabView) {
  void s; void price;
  // DSCR gate: size the loan so underwriting NOI covers debt service
  const maxAnnualDS = Math.max(0, noiYr) / (product.uwDscr + 0.25 * tight);
  const i = ratePct / 100;
  const byDscrIO = maxAnnualDS / i;
  const qp = monthlyPayment(1, ratePct, product.amortYears) * 12; // annual DS per $1
  const byDscrAmort = maxAnnualDS / qp;
  const byDscr = product.ioM >= 12 ? Math.min(byDscrIO, byDscrAmort * 1.08) : byDscrAmort;
  // DEBT YIELD. Coverage flatters a loan when rates are low and cap rates are
  // lower — you can cover 1.25x on a building yielding four points, and the
  // lender still has no equity underneath them. Since 2009 the desk also
  // sizes on NOI ÷ proceeds, and in a cheap-money market this is the binding
  // constraint far more often than LTV is.
  const dyFloor = product.debtYield * (1 + 0.35 * tight);
  const byDebtYield = dyFloor > 0 ? Math.max(0, noiYr) / dyFloor : Infinity;
  const inPlace = Math.max(0, Math.round(Math.min(byLtv, byDscr, byDebtYield)));
  // THE STABILISED LEG. Capped by the as-is advance as well, because the
  // collateral today is still the collateral.
  const byStab = stab && stab.value > 0
    ? Math.max(0, Math.round(Math.min(byLtv, STAB_LTV * stab.value)))
    : 0;
  const principal = Math.max(inPlace, byStab);
  const onPlan = byStab > inPlace;
  return {
    principal: product.minLoan && principal < product.minLoan ? 0 : principal,
    ratePct,
    // When the plan is what sized it, the in-place tests did not bind and
    // saying they did would send the borrower off to fix the wrong thing.
    dscrConstrained: !onPlan && byDscr < byLtv && byDscr <= byDebtYield,
    dyConstrained: !onPlan && byDebtYield < byLtv && byDebtYield < byDscr,
    stabConstrained: onPlan,
    debtYield: principal > 0 ? Math.max(0, noiYr) / principal : 0,
  };
}

/**
 * HOW FAR A BRIDGE LENDER WILL GO AGAINST A STABILISED VALUE.
 *
 * Sixty to sixty-five per cent of the value the building reaches when the plan
 * is done, against a pro forma struck at the class's natural occupancy. That is
 * the transitional/bridge market as it is actually quoted, and it is the number
 * a value-add borrower solves their equity cheque from. It sits BELOW the
 * as-is advance rate on purpose and by fact: a lender advances less against a
 * number that has not happened yet than against one that has.
 *
 * A fact about the business, in the same register as the advance rates above.
 * The upside it buys is bought at a price the engine already models — floating,
 * three years, interest-only, two points, and a balloon that lands whether or
 * not the building ever let.
 */
const STAB_LTV = 0.65;


// `lev` scales the loan down from the lender's maximum — the player's dial.
// Pass the same `stab` the quote screen used — without it, bridge paper sizes
// on in-place income at close after showing a stabilised takeout on the card.
export function originate(
  s: GameState, product: LoanProduct, price: number, noiYr: number, lev = 1,
  condition?: string, klass?: string, stab?: StabView,
): Loan | null {
  if (!productOpen(s, product)) return null;
  if (!windowOpen(s, product)) return null;
  if (product.minCondition === "good" && condition !== undefined && condition !== "good") return null;
  const full = quote(s, product, price, noiYr, klass, false, stab);
  const qd = { ...full, principal: Math.round(full.principal * Math.max(0, Math.min(1, lev))) };
  if (qd.principal < 100_000) return null;
  const pmt = product.ioM > 0
    ? Math.round((qd.principal * qd.ratePct) / 100 / 12)
    : Math.round(monthlyPayment(qd.principal, qd.ratePct, product.amortYears));
  // No lender writes floating paper without a cap in place at closing. The
  // premium is a real cost of choosing the cheaper coupon, and it comes out of
  // the same equity cheque — which is the honest way to compare a floater to a
  // fixed loan rather than pretending the coupon is the whole story.
  const capStrike = product.floating ? +(s.econ.indexRate + 1.0).toFixed(2) : undefined;
  const loanOut: Loan = {
    product: product.id,
    floating: product.floating,
    cap: capStrike !== undefined ? { strike: capStrike, expiresM: s.month + Math.min(product.termM, CAP_TERM_M) } : undefined,
    capPremium: capStrike !== undefined ? Math.round(qd.principal * 0.0125) : undefined,
    points: product.points,
    recourse: product.recourse,
    prepay: product.prepay,
    prepayUntilM: s.month + product.prepayM,
    kicker: product.kicker,
    principal: qd.principal,
    balance: qd.principal,
    ratePct: qd.ratePct,
    spread: product.spread,
    ioUntilM: s.month + product.ioM,
    amortYears: product.amortYears,
    maturityM: s.month + product.termM,
    monthlyPmt: pmt,
    minDSCR: product.minDSCR,
    maxLTV: product.maxLTV,
    sweep: false,
    cleanQs: 0,
    originM: s.month,
    origValue: Math.round(price),   // what it appraised for the day the desk signed — the statement's "LTV then"
  };
  bumpLenderRel(s, product.lender, 2);   // a closed loan starts a file
  return loanOut;
}

export function dscr(rec: ParcelRecord, s: GameState, h: Holding): number | null {
  if (!h.loan) return null;
  const ds = h.loan.monthlyPmt * 12;
  if (ds <= 0) return null;
  return ownedHoldingNoiYrFromRec(s, rec, h) / ds;
}

export function ltv(rec: ParcelRecord, s: GameState, h: Holding): number | null {
  if (!h.loan) return null;
  const v = ownedHoldingValueFromRec(s, rec, h);
  return v > 0 ? h.loan.balance / v : null;
}

/**
 * Principal a sponsor must inject to put covenants back onside — the named
 * equity-cure amount. Same maths the monthly cure cheque uses, so a workout
 * file never asks for a flat "12% of balance" when the real gap is smaller
 * (or larger).
 */
export function equityCureNeed(rec: ParcelRecord, s: GameState, h: Holding): number {
  const loan = h.loan;
  if (!loan) return 0;
  const d = dscr(rec, s, h);
  const l = ltv(rec, s, h);
  const value = ownedHoldingValueFromRec(s, rec, h);
  let target = loan.balance;
  if (d !== null && d < loan.minDSCR && d > 0) {
    target = Math.min(target, loan.balance * (d / loan.minDSCR));
  } else if (d !== null && d <= 0) {
    // No income against the test — cure is not a rounding error; demand a
    // meaningful paydown so the desk has something to underwrite against.
    target = Math.min(target, loan.balance * 0.88);
  }
  if (l !== null && l > loan.maxLTV && value > 0) {
    target = Math.min(target, loan.maxLTV * value);
  }
  return Math.max(0, Math.ceil(loan.balance - target));
}

// One quarter of debt life for a holding. Returns the cash the loan takes
// this quarter (debt service, plus any sweep of surplus cash flow).
export function tickLoan(
  s: GameState, parcels: ParcelTable, rec: ParcelRecord | null, h: Holding, assetCF: number,
): number {
  const loan = h.loan;
  if (!loan || !rec) return 0;
  const q = s.month;

  // AN ACCELERATED LOAN IS NOT SERVICED. Once the lender has filed, the whole
  // balance is due and nobody sends the monthly cheque any more — the meter
  // runs at the default rate against the COLLATERAL instead, which is why the
  // credit bid at the July sale is always bigger than the balance you
  // remember. Cash stops leaving; the hole grows where the building is.
  //
  // …unless the firm can still write the cure cheque. A foreclosure filing is
  // not a deed: until the hammer falls the arrears are payable, and a sponsor
  // with cash or an open line does not sit on both while the auction calendar
  // runs. Auto-cure lives in tickWorkouts; here we only accrue when the file
  // is still open after that desk has had its chance.
  const wFcl = s.workouts?.[h.bbl];
  if (wFcl?.stage === "foreclosure") {
    wFcl.accrued = Math.round((wFcl.accrued ?? 0) + (loan.balance * (loan.ratePct + 2)) / 100 / 12);
    return 0;
  }

  // floating: reprice off the live index — through the cap, if one was bought
  if (loan.floating ?? loan.product === "float") {
    if (loan.cap && q >= loan.cap.expiresM) {
      delete loan.cap;
      s.news.unshift({ q, kind: "info", text: `The rate cap at ${rec.address} expired — you're floating naked again.` });
    }
    const effIndex = loan.cap ? Math.min(s.econ.indexRate, loan.cap.strike) : s.econ.indexRate;
    loan.ratePct = +(effIndex + loan.spread).toFixed(2);
  }
  // The payment is re-cut every month, and it has to be: a loan that leaves
  // its interest-only period must start amortising. This used to recompute
  // only for floating paper, so every FIXED loan with an IO period — the bank
  // five-year, the participating paper, the mezzanine — quietly stayed
  // interest-only for its whole term, understating debt service for years.
  // Worse, the IO payment was rounded down, so the balance crept UPWARD a few
  // cents a month forever. Recomputing over the remaining amortisation term
  // reproduces the same schedule a level-payment loan would follow, and it
  // cannot drift below the interest.
  const io = q < loan.ioUntilM;
  {
    const yearsLeft = Math.max(1, loan.amortYears - (q - loan.originM) / 12);
    loan.monthlyPmt = io
      ? Math.ceil((loan.balance * loan.ratePct) / 100 / 12)
      : Math.round(monthlyPayment(loan.balance, loan.ratePct, yearsLeft));
  }

  const interest = (loan.balance * loan.ratePct) / 100 / 12;
  const principalPay = io ? 0 : Math.max(0, Math.min(loan.balance, loan.monthlyPmt - interest));
  if (!loan.sweep && s.month % 12 === 0) bumpLenderRel(s, productById(loan.product).lender, 0.6);
  loan.balance = Math.max(0, loan.balance - principalPay);
  let cashOut = loan.monthlyPmt;

  // covenants — after a 12-month stabilization holiday, so a building you
  // just bought with honest vacancy isn't in default before the ink dries
  const holiday = q < (loan.holidayUntilM ?? loan.originM + 12);
  const d = dscr(rec, s, h);
  const l = ltv(rec, s, h);
  let breached = !holiday && ((d !== null && d < loan.minDSCR) || (l !== null && l > loan.maxLTV));

  /**
   * THE EQUITY CURE — a sponsor with the money does not lose a building.
   *
   * The fault this fixes was the worst one in the game. A covenant breach on
   * ONE property walked to the workout desk after 24 months and on to
   * foreclosure, and nothing on that path ever looked at the firm. Measured
   * before this existed: 21 of 21 workout files opened while the firm was
   * holding more than $20M of cash, every one of them a covenant cause, and
   * files sat at stage=foreclosure for 321 months with the money in the bank.
   * The worst case was a firm with $221M losing a building whose loan payment
   * was $6,741 a month over a $90,000 cure.
   *
   * That is not a hard game, it is a wrong one. The payment was being made
   * every month — `cashOut` leaves whatever the covenants say — so the loan was
   * CURRENT, and no lender forecloses a current loan. What a lender does with a
   * technical default is trap the cash flow and demand a cure; what a sponsor
   * with capital does is write the cheque. It is a named clause in commercial
   * loan agreements — an equity cure right — and its absence here meant the
   * game modelled the trap without modelling the obvious answer to it.
   *
   * So: pay down principal to the covenant out of cash the firm actually has.
   * An equity cure is a sponsor cheque — paid-in capital, not a revolver draw;
   * the line is for operations and keeping other loans current, and cross-
   * default freezes using it to paper over a mortgage covenant. Rich firms
   * with cash still cure; thin levered firms must feel leverage. It is not free
   * and it is not a rail. It costs real money in the month it happens, it is
   * bounded by fundable cash, and a firm that cannot afford it breaches
   * exactly as before — sweep, workout desk, foreclosure.
   *
   * NO NEW CONSTANT. The cure target is the covenant itself. Debt service is
   * proportional to balance at a fixed rate and term — exactly so while
   * interest-only — so scaling the balance by `d / minDSCR` scales the payment
   * by the same factor and lands DSCR on its minimum; the LTV leg is
   * `maxLTV x value` by definition. Whichever binds, binds.
   */
  if (breached && fundableNow(s, parcels, { allowLoc: false }) > 0) {
    const need = equityCureNeed(rec, s, h);
    // Cash only — sponsor cheque, not a line draw. Taken immediately so two
    // breached buildings in the same month cannot both spend the same dollar.
    const pay = fundCashNeed(s, parcels, need, { allowLoc: false });
    if (pay > 0) {
      loan.balance = Math.max(0, loan.balance - pay);
      logBooks(s, "debtSvc", pay);
      const yearsLeft2 = Math.max(1, loan.amortYears - (q - loan.originM) / 12);
      loan.monthlyPmt = io
        ? Math.ceil((loan.balance * loan.ratePct) / 100 / 12)
        : Math.round(monthlyPayment(loan.balance, loan.ratePct, yearsLeft2));
      // Re-test against the loan as it now stands. A cure that covered the
      // whole gap ends the breach this month; a partial one does not, and the
      // sweep and the clock go on exactly as they did.
      const d2 = dscr(rec, s, h);
      const l2 = ltv(rec, s, h);
      const still = (d2 !== null && d2 < loan.minDSCR) || (l2 !== null && l2 > loan.maxLTV);
      if (!still) {
        if (loan.sweep || (loan.breachMs ?? 0) > 0) {
          s.news.unshift({
            q, kind: "info",
            text: `Covenant cured at ${rec.address} — ${pay >= 1e6 ? `$${(pay / 1e6).toFixed(2)}M` : `$${Math.round(pay / 1000)}K`} of equity into the loan, and the test passes again. `
              + `A sponsor with the money does not hand back a building over a technical default.`,
          });
        }
        loan.sweep = false;
        loan.breachMs = 0;
        loan.cleanQs = 0;
        breached = false;
      }
    }
  }

  if (breached) {
    if (!loan.sweep) {
      s.news.unshift({
        q, kind: "warn",
        text: `Covenant breach at ${rec.address} (${d !== null && d < loan.minDSCR ? `DSCR ${d.toFixed(2)}` : `LTV ${(100 * (l ?? 0)).toFixed(0)}%`}) — the lender trapped the cash flow.`,
      });
    }
    if (!loan.sweep) bumpLenderRel(s, productById(loan.product).lender, -3);  // a tripped covenant sours the coffee
    loan.sweep = true;
    loan.cleanQs = 0;
    loan.breachMs = (loan.breachMs ?? 0) + 1;
    // A SWEEP THAT NEVER CURES IS A DEFAULT.
    //
    // The breach counter reset to zero every month it was still broken, so a
    // building could sit in permanent breach for forty years, cash trapped,
    // and nothing further ever happened to it. That is not what a lender does.
    // Two clean quarters lifts the sweep; two straight YEARS of breach and the
    // file goes to the workout desk, which is where the covenant cause
    // declared in types.ts was always supposed to come from.
    if ((loan.breachMs ?? 0) >= 24 && !s.workouts?.[h.bbl]) {
      // Ask for the real equity-cure dollars, not a flat 12% of balance — a
      // file that demanded more cash than the covenant gap is how solvent
      // books were walked to foreclosure over a technical default.
      const cure = Math.max(equityCureNeed(rec, s, h), Math.round(loan.balance * 0.03));
      openWorkout(s, h.bbl, "covenant", cure);
      s.news.unshift({
        q, kind: "warn",
        text: `Two years of broken covenants at ${rec.address} and no sign of a cure. `
          + `${productById(loan.product).lender} has moved it to their workout desk — inject `
          + `${cure >= 1e6 ? `$${(cure / 1e6).toFixed(2)}M` : `$${Math.round(cure / 1000)}K`} of equity, ask them `
          + `to restructure, or hand back the deed. They will not file while the note stays current.`,
      });
    }
  } else if (loan.sweep) {
    loan.cleanQs++;
    bumpLenderRel(s, productById(loan.product).lender, 0.1);
    if (loan.cleanQs >= 2) {
      loan.sweep = false;
      loan.breachMs = 0;
      s.news.unshift({ q, kind: "info", text: `Covenants cured at ${rec.address} — the sweep is off.` });
    }
  }
  // sweep: surplus asset cash flow pays down principal instead of reaching you
  if (loan.sweep) {
    const surplus = Math.max(0, assetCF - loan.monthlyPmt);
    if (surplus > 0) {
      loan.balance = Math.max(0, loan.balance - surplus);
      cashOut += surplus;
    }
  }
  // ARREARS. The building does not cover its own debt service and the firm
  // cannot make up the difference from cash OR the undrawn line — so the
  // payment will not arrive. The monthly cheque still leaves via monthCF
  // (portfolio accounting); this clock only asks whether the sponsor could
  // fund it. One bad month is a timing problem; a quarter of them is a file.
  const gap = Math.max(0, Math.ceil(loan.monthlyPmt - assetCF));
  const short = gap > 0 && s.cash < 0 && fundableNow(s, parcels) < gap;
  loan.arrearsMs = short ? (loan.arrearsMs ?? 0) + 1 : 0;
  if ((loan.arrearsMs ?? 0) >= 3 && !s.workouts?.[h.bbl]) {
    openWorkout(s, h.bbl, "arrears", Math.round(loan.monthlyPmt * (loan.arrearsMs ?? 3)));
    s.news.unshift({
      q, kind: "warn",
      text: `Three months of missed payments at ${rec.address}. ${productById(loan.product).lender} has `
        + `opened a file — the arrears are ${Math.round(loan.monthlyPmt * (loan.arrearsMs ?? 3) / 1000)}K and they `
        + `want them, or they want the building.`,
    });
  }

  // Crumb balances from float math used to sit forever (IO land loans at a
  // dollar a month never amortise to exact zero). Under a dollar is noise —
  // clear the lien so a ground lease or sale is not blocked by rounding.
  if (loan.balance > 0 && loan.balance < 1) loan.balance = 0;
  if (loan.balance === 0) {
    h.loan = null;
    // Senior gone — mezz is still a claim; it does not vanish with the first lien.
    cashOut += serviceMezz(s, parcels, rec, h);
    return cashOut;
  }

  // the balloon. An automatic refi rolls the SAME balance — the bank isn't
  // in the business of handing you equity unasked. Cash-out is a choice you
  // make with the Refi button.
  // A loan already in workout is past its maturity by definition. The file is
  // the process now; the refinancing ladder does not get to run again every
  // month underneath it.
  if (q >= loan.maturityM && !s.workouts?.[h.bbl]) {
    const coll = debtCollateral(s, parcels, h, rec);
    const { value, noi, vacantDirt, quoteClass, hair, stab } = coll;
    // Walk DOWN the desk, not off a cliff. A maturing loan is refinanced by
    // whoever will write it: the agency first, then the bank, and if neither
    // will, hard money at hard-money prices. That last one is not a rescue —
    // it is a coupon that eats the building's cash flow — but it is what
    // actually happens, and it turns "you got unlucky at the balloon" into
    // "you are now paying for how you financed this".
    // A leased fee with a coupon walks the income desks; vacant dirt keeps
    // the land loan as its only takeout. Bridge gets the stabilised view the
    // same way the Refi card does — one underwriting, not two.
    const ladder = (vacantDirt ? ["land"] : ["savings", "harbor", "cordage"]).map(productById)
      .filter((p) => productOpen(s, p) && windowOpen(s, p));
    let product = ladder[ladder.length - 1] ?? PRODUCTS[0];
    let qd = { ...quote(s, product, value, noi, quoteClass, false, stab), principal: 0 };
    const fee = Math.round(loan.balance * REFI_FEE);
    for (const cand of ladder) {
      const raw = quote(s, cand, value, noi, quoteClass, false, stab);
      const sized = { ...raw, principal: Math.round(raw.principal * hair.mult) };
      product = cand; qd = sized;
      if (sized.principal >= loan.balance + fee) break;
    }
    if (qd.principal >= loan.balance + fee) {
      const rolled = loan.balance;
      h.loan = originate(s, product, value, noi, hair.mult, h.condition, quoteClass, stab);
      if (h.loan) {
        h.loan.balance = h.loan.principal = rolled;
        h.loan.monthlyPmt = Math.round(monthlyPayment(rolled, h.loan.ratePct, h.loan.amortYears));
      }
      const feePaid = fundCashNeed(s, parcels, fee);
      logBooks(s, "debtSvc", feePaid);
      s.news.unshift({
        q, kind: "deal",
        text: `Balloon at ${rec.address} rolled into new paper at ${qd.ratePct.toFixed(2)}% (fee $${(fee / 1000).toFixed(0)}K). Want equity out? That's a refi you choose.`,
      });
    } else {
      const payoff = loan.balance + fee;
      const shortfall = payoff - qd.principal;
      // Prefer retiring the note when liquidity covers the whole balloon —
      // cleaner than papering a scrap takeout. Then bridge a partial refi.
      // Only open a workout file when the firm cannot fund either path.
      const mezzDue = h.mezz?.balance ?? 0;
      if (fundableNow(s, parcels) >= payoff + mezzDue) {
        const paid = fundCashNeed(s, parcels, payoff + mezzDue);
        logBooks(s, "debtSvc", paid);
        h.loan = null;
        if (h.mezz) h.mezz = null;
        s.news.unshift({
          q, kind: "deal",
          text: `Balloon at ${rec.address}: no clean refinancing, so you retired the `
            + `$${(payoff / 1e6).toFixed(2)}M note${mezzDue ? ` and ${((mezzDue) / 1e6).toFixed(2)}M of mezz` : ""} out of firm liquidity. The building is free and clear.`,
        });
      } else if (fundableNow(s, parcels) >= shortfall) {
        const paid = fundCashNeed(s, parcels, shortfall);
        // AND IT GOES ON THE BOOKS. The branch above books its fee; this one
        // took the money and said nothing, so the largest single cheque a
        // levered owner ever writes — the gap at a balloon, when the market
        // will not refinance what it lent you — was invisible on the Books
        // page. Cash simply dropped. Found by reconciling cash against the
        // ledger month by month over fifty years: three of the four
        // unexplained movements in the sample were this line, matching the
        // news item to the penny, and it cost one seed $1.17M of silence.
        logBooks(s, "debtSvc", paid);
        // Size at the haircut quote the shortfall maths used — originating at
        // lev=1 with no hair (and the wrong class on land) used to write a
        // bigger loan than "today's market only refinances $X" claimed.
        h.loan = qd.principal > 100_000
          ? originate(s, product, value, noi, hair.mult, h.condition, quoteClass, stab)
          : null;
        if (h.loan && h.loan.balance !== qd.principal) {
          h.loan.balance = h.loan.principal = qd.principal;
          h.loan.monthlyPmt = Math.round(
            product.ioM > 0
              ? (qd.principal * h.loan.ratePct) / 100 / 12
              : monthlyPayment(qd.principal, h.loan.ratePct, h.loan.amortYears),
          );
        }
        s.news.unshift({
          q, kind: "warn",
          text: `Balloon at ${rec.address}: today's market only refinances $${(qd.principal / 1e6).toFixed(1)}M — you wrote a $${(shortfall / 1e6).toFixed(2)}M check to close the gap.`,
        });
      } else {
        // NOT A SALE — A DEFAULT, WHICH IS A CONVERSATION.
        openWorkout(s, h.bbl, "balloon", payoff);
        s.news.unshift({
          q, kind: "warn",
          text: `The balloon came due at ${rec.address} and there is no refinancing — today's market writes `
            + `$${(qd.principal / 1e6).toFixed(1)}M against a $${(loan.balance / 1e6).toFixed(2)}M balance and you cannot cover the gap. `
            + `${productById(loan.product).lender} has put it in workout: you have until ${monthLabel(s.month + 6)} to cure it, `
            + `ask them to extend, or hand back the deed before they file.`,
        });
      }
    }
  }
  cashOut += serviceMezz(s, parcels, rec, h);
  return cashOut;
}

/** Bank seniors that can carry Cordage mezz behind them — not bridge / private. */
const MEZZ_SENIOR_OK = new Set(["savings", "harbor", "pelican", "conduit"]);

/**
 * ONE MONTH OF MEZZ. Senior has already taken its coupon. Mezz is IO to the
 * balloon; miss → Cordage marks the file (workout on the deed if none open).
 */
function serviceMezz(
  s: GameState, parcels: ParcelTable, rec: ParcelRecord, h: Holding,
): number {
  const m = h.mezz;
  if (!m || m.balance <= 0) {
    if (m && m.balance <= 0) h.mezz = null;
    return 0;
  }
  if (m.floating) {
    m.ratePct = +(s.econ.indexRate + m.spread).toFixed(2);
  }
  m.monthlyPmt = Math.ceil((m.balance * m.ratePct) / 100 / 12);
  const pmt = m.monthlyPmt;
  if (fundableNow(s, parcels) >= pmt) {
    const paid = fundCashNeed(s, parcels, pmt);
    logBooks(s, "debtSvc", paid);
    m.arrearsMs = 0;
  } else {
    m.arrearsMs = (m.arrearsMs ?? 0) + 1;
    if ((m.arrearsMs ?? 0) >= 3 && !s.workouts?.[h.bbl]) {
      openWorkout(s, h.bbl, "arrears", m.balance);
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `Mezz at ${rec.address} has missed three coupons. ${m.holder ?? "Cordage Debt Partners"} `
          + `has opened a file — the senior is still current, but the junior is not.`,
      });
    }
  }
  if (s.month >= m.maturityM && !s.workouts?.[h.bbl]) {
    if (fundableNow(s, parcels) >= m.balance) {
      const paid = fundCashNeed(s, parcels, m.balance);
      logBooks(s, "debtSvc", paid);
      h.mezz = null;
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `Mezz balloon at ${rec.address} retired — $${(m.balance / 1e6).toFixed(2)}M back to `
          + `${m.holder ?? "Cordage Debt Partners"}.`,
      });
    } else {
      openWorkout(s, h.bbl, "balloon", m.balance);
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `The mezz balloon came due at ${rec.address} and you cannot clear `
          + `$${(m.balance / 1e6).toFixed(2)}M. Cordage has put the junior in workout.`,
      });
    }
  }
  return pmt;
}

export interface MezzQuote {
  available: boolean;
  principal: number;
  ratePct: number;
  points: number;
  termM: number;
  ltvCombined: number;
  why?: string;
}

/**
 * Cordage mezz behind YOUR bank senior only. Not a refinance replace — a
 * second lien on Holding.mezz. Refuses private/Cordage seniors, facility
 * pledges, workouts, and a second stack.
 */
export function mezzQuote(s: GameState, parcels: ParcelTable, bbl: string): MezzQuote {
  const h = s.holdings[bbl];
  const rec = resolveRec(parcels, s, bbl);
  const empty: MezzQuote = { available: false, principal: 0, ratePct: 0, points: 0.025, termM: 84, ltvCombined: 0 };
  if (!h || !rec) return { ...empty, why: "You don't own that." };
  if (!h.loan) return { ...empty, why: "Mezzanine sits behind a senior — put a first mortgage on first." };
  if (h.mezz && h.mezz.balance > 0) return { ...empty, why: "There is already mezz on this deed." };
  if (s.facility?.bbls.includes(bbl)) {
    return { ...empty, why: "This deed is pledged to your facility." };
  }
  if (s.workouts?.[bbl]) return { ...empty, why: "A workout file is open — nobody stacks behind a problem." };
  if (!MEZZ_SENIOR_OK.has(h.loan.product) || h.loan.holder) {
    return { ...empty, why: "Mezz only stacks behind clean bank seniors — not Cordage, not private holders." };
  }
  const product = productById("mezz");
  if (!productOpen(s, product) || !windowOpen(s, product)) {
    return { ...empty, why: "Cordage will not look at mezz for you right now." };
  }
  const value = ownedHoldingValueFromRec(s, rec, h);
  const room = Math.max(0, value * product.ltv - h.loan.balance);
  const principal = Math.floor(room / 25_000) * 25_000;
  if (principal < 250_000) {
    return { ...empty, why: "No room behind the senior to the 85% stack — pay down the first lien or wait for value." };
  }
  const ratePct = +(s.econ.indexRate + product.spread).toFixed(2);
  return {
    available: true,
    principal,
    ratePct,
    points: product.points,
    termM: product.termM,
    ltvCombined: (h.loan.balance + principal) / Math.max(1, value),
  };
}

export function placeMezz(
  s: GameState, parcels: ParcelTable, bbl: string,
): { s: GameState; err?: string; msg?: string } {
  const q = mezzQuote(s, parcels, bbl);
  if (!q.available || q.principal < 250_000) {
    return { s, err: q.why ?? "No mezz quote." };
  }
  const next = cloneState(s);
  const h = next.holdings[bbl]!;
  const rec = resolveRec(parcels, next, bbl)!;
  const points = Math.round(q.principal * q.points);
  const net = q.principal - points;
  next.cash += net;
  logBooks(next, "borrowed", q.principal);
  logBooks(next, "debtSvc", points);
  h.mezz = {
    product: "mezz",
    holder: "Cordage Debt Partners",
    floating: false,
    points: q.points,
    recourse: false,
    prepay: "stepdown",
    prepayUntilM: next.month + 48,
    principal: q.principal,
    balance: q.principal,
    ratePct: q.ratePct,
    spread: productById("mezz").spread,
    ioUntilM: next.month + productById("mezz").ioM,
    amortYears: 30,
    maturityM: next.month + q.termM,
    monthlyPmt: Math.round((q.principal * q.ratePct) / 100 / 12),
    minDSCR: productById("mezz").minDSCR,
    maxLTV: productById("mezz").maxLTV,
    sweep: false,
    cleanQs: 0,
    originM: next.month,
    origValue: Math.round(ownedHoldingValueFromRec(next, rec, h)),
  };
  bumpLenderRel(next, "Cordage Debt Partners", 2);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Cordage stacked $${(q.principal / 1e6).toFixed(2)}M of mezz behind the senior at ${rec.address} — `
      + `${q.ratePct.toFixed(2)}%, ${(q.points * 100).toFixed(1)} points, due ${monthLabel(next.month + q.termM)}. `
      + `You cleared $${(net / 1e6).toFixed(2)}M. The coupon is why nobody does this twice.`,
  });
  sweepLocIdleCash(next, { announce: true });
  return { s: next, msg: `Mezz closed — $${(q.principal / 1e6).toFixed(2)}M.` };
}
export const CAP_TERM_M = 36;
export function rateCapCost(loan: Loan): number {
  return Math.round(loan.balance * 0.0125);
}

export function buyRateCap(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; err?: string } {
  const next: GameState = cloneState(s);
  const h = next.holdings[bbl];
  const rec = resolveRec(parcels, next, bbl);
  if (!h || !rec) return { s, err: "You don't own that." };
  if (!h.loan || !(h.loan.floating ?? h.loan.product === "float")) return { s, err: "Caps hedge floating debt — this loan is fixed." };
  if (h.loan.cap) return { s, err: "This loan already carries a live cap." };
  const cost = rateCapCost(h.loan);
  if (next.cash < cost) return { s, err: `The cap desk wants $${(cost / 1e6).toFixed(2)}M premium — you're short.` };
  const strike = +(next.econ.indexRate + 0.5).toFixed(2);
  next.cash -= cost;
  logBooks(next, "debtSvc", cost);
  h.loan.cap = { strike, expiresM: next.month + CAP_TERM_M };
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Rate cap bought at ${rec.address}: index capped at ${strike.toFixed(2)}% for three years ($${(cost / 1e6).toFixed(2)}M premium).`,
  });
  return { s: next };
}

// What the desk will actually quote you today, per product, so the refinance
// screen can show real choices instead of two buttons.
export interface RefiQuote {
  id: string;
  label: string;
  blurb: string;
  ratePct: number;
  maxProceeds: number;
  ltvAtMax: number;
  dscrAtMax: number;
  debtYieldAtMax: number;
  /**
   * `maxLTV` is the covenant ceiling (breach test). `advanceLtv` is the sizing
   * advance rate — they are not the same number, and the panel used to label
   * the covenant as the advance. `noiUw` is the in-place income this quote was
   * sized against; bridge paper may still advance on a stabilised plan via
   * `binding: "stabilised plan"` without rewriting this NOI.
   */
  maxLTV: number;
  advanceLtv: number;
  noiUw: number;
  /** The coverage covenant this paper carries — what the ratio has to stay above. */
  minDSCR: number;
  binding: string;      // which of the three tests actually capped the loan
  ioM: number;
  termM: number;
  amortYears: number;
  points: number;
  recourse: boolean;
  prepay: PrepayKind;
  prepayM: number;
  kicker?: number;
  floating: boolean;
  available: boolean;
  why?: string;
}

/**
 * The haircut a lender takes for concentration and rollover.
 *
 * A credit committee does not lend against a rent roll — it lends against the
 * covenants in it. One tenant at eighty per cent of the income with three
 * years to run is a bullet loan against that tenant's credit, and it gets
 * sized like one. Long paper from a strong name earns most of it back, which
 * is why single-tenant net-lease deals can be financed to the eyebrows and
 * multi-tenant buildings with the same NOI cannot.
 */
export function collateralHaircut(h: Holding, month: number, econ?: Econ): { mult: number; why?: string } {
  if (!h.tenants.length) return { mult: 1 };
  const conc = concentration(h);
  const w = walt(h, month);
  let sfTot = 0, wCredit = 0, rollSf = 0;
  for (const t of h.tenants) {
    sfTot += t.sf;
    wCredit += t.credit * t.sf;
    if (t.endM - month <= 24) rollSf += t.sf;
  }
  const credit = sfTot ? wCredit / sfTot : 0;
  const rollShare = sfTot ? rollSf / sfTot : 0;
  // concentration bites past a third of the roll, and long strong paper undoes it
  const concHit = Math.max(0, conc - 0.35) / 0.65 * (credit >= 1.6 && w >= 8 ? 0.10 : credit >= 1.6 ? 0.20 : 0.32);
  // and the desk discounts income that walks out the door inside the term
  const rollHit = Math.max(0, rollShare - 0.3) / 0.7 * 0.18;
  // AND WHAT THE TENANTS DO FOR A LIVING. Five names in one trade is one
  // cycle, and a credit committee has seen what happens to a building let
  // entirely to an industry that is contracting. This is the same question the
  // single-name test asks, one level up, and it is the one that catches the
  // rent roll that looks diversified and is not.
  const ind = econ ? industryConcentration(h, econ) : { share: 0, sector: null, stressed: 0 };
  const indHit = Math.max(0, ind.share - 0.5) / 0.5 * 0.16 + ind.stressed * 0.26;
  const mult = Math.max(0.5, 1 - concHit - rollHit - indHit);
  const why = indHit > 0.08 && ind.sector
    ? `${(ind.share * 100).toFixed(0)}% of the income is ${INDUSTRY_LABEL[ind.sector].toLowerCase()}${ind.stressed > 0.25 ? ", and that trade is contracting" : ""}`
    : concHit > 0.08 && rollHit > 0.05
    ? `the biggest tenant is ${(conc * 100).toFixed(0)}% of the roll and ${(rollShare * 100).toFixed(0)}% of it rolls inside two years`
    : concHit > 0.08 ? `the biggest tenant is ${(conc * 100).toFixed(0)}% of the roll`
    : rollHit > 0.05 ? `${(rollShare * 100).toFixed(0)}% of the roll expires inside two years`
    : undefined;
  return { mult, why };
}

/**
 * ONE UNDERWRITING for the quote card, the close, and the balloon ladder.
 *
 * The Refi panel used to invent a lease-up "trust" schedule that inflated NOI
 * and value for every desk, while `refinance` sized on in-place income alone —
 * so a takeout that looked fat on the card failed at the button. Bridge paper
 * already has the real stabilised leg (`stabViewFor` → `sizeRest`); permanent
 * desks underwrite the roll you have. Both paths share this collateral view.
 */
export function debtCollateral(
  s: GameState, parcels: ParcelTable, h: Holding, rec: ParcelRecord,
): {
  value: number; noi: number; vacantDirt: boolean; quoteClass: string;
  hair: { mult: number; why?: string }; stab: StabView | undefined;
} {
  const vacantDirt = isVacantLandLoanCollateral(s, h, rec);
  const value = ownedHoldingValue(s, parcels, h);
  const noi = ownedHoldingNoiYr(s, parcels, h);
  const quoteClass = vacantDirt ? "land" : (rec.class === "land" ? "office" : rec.class);
  const hair = collateralHaircut(h, s.month, s.econ);
  const stab = (!vacantDirt && !h.groundLeased && rec.bldgArea > 0)
    ? stabViewFor(rec, s.econ, h.condition, value)
    : undefined;
  return { value, noi, vacantDirt, quoteClass, hair, stab };
}

export function refiQuotes(s: GameState, parcels: ParcelTable, bbl: string): { quotes: RefiQuote[]; value: number; payoff: number } {
  const h = s.holdings[bbl];
  const rec = resolveRec(parcels, s, bbl);
  if (!h || !rec) return { quotes: [], value: 0, payoff: 0 };
  const { value, noi, vacantDirt, quoteClass, hair, stab } = debtCollateral(s, parcels, h, rec);
  const onFacility = !!s.facility?.bbls.includes(bbl);
  const quotes = PRODUCTS.map((p) => {
    const raw = quote(s, p, value, noi, quoteClass, false, stab);
    const q = { ...raw, principal: Math.round(raw.principal * hair.mult) };
    const annualDs = p.ioM > 0
      ? (q.principal * q.ratePct) / 100
      : monthlyPayment(Math.max(1, q.principal), q.ratePct, p.amortYears) * 12;
    // Mezz is labeled as sitting behind a senior, but refinance replaces
    // `h.loan` — there is no junior lien. Do not offer a product the close
    // cannot actually stack.
    return {
      id: p.id,
      label: p.label,
      blurb: p.blurb,
      ratePct: q.ratePct,
      maxProceeds: q.principal,
      ltvAtMax: value > 0 ? q.principal / value : 0,
      dscrAtMax: annualDs > 0 ? noi / annualDs : 0,
      debtYieldAtMax: q.principal > 0 ? noi / q.principal : 0,
      // Covenant max LTV (breach test), not the advance rate used to size.
      maxLTV: p.maxLTV,
      advanceLtv: p.ltv,
      noiUw: noi,
      minDSCR: p.minDSCR,
      // HOLD SIZE OUTRANKS THE THREE UNDERWRITING TESTS, because it is not one
      // of them. DSCR, debt yield and advance rate are all things about the
      // BUILDING; a hold size is a thing about the LENDER, and telling a
      // borrower "advance rate" when the truth is "we don't write cheques that
      // big" sends them off to fix a building that is not broken.
      binding: q.holdCapped ? "their hold size"
        : q.stabConstrained ? "stabilised plan"
        : q.dyConstrained ? "debt yield"
        : q.dscrConstrained ? "coverage"
        : "advance rate",
      ioM: p.ioM,
      termM: p.termM,
      amortYears: p.amortYears,
      points: p.points,
      recourse: p.recourse,
      prepay: p.prepay,
      prepayM: p.prepayM,
      kicker: p.kicker,
      floating: p.floating,
      available: onFacility ? false
        : !productOpen(s, p) || !windowOpen(s, p) ? false
        : p.minCondition === "good" && h.condition !== "good" ? false
        : p.mezz ? false
        : p.uwDscr <= 0 ? vacantDirt
        : !vacantDirt && q.principal > 0,
      why: onFacility
        ? "This deed is pledged to your facility. Release it before you put a mortgage back on."
        : !productOpen(s, p)
        ? `This desk won't look at you — ${sponsorStanding(s).label}. It recovers with clean payments; bridge money will still talk in the meantime.`
        : !windowOpen(s, p)
        ? "The securitization window is closed — nobody is buying the bonds until markets reopen. Nothing about this building will change that."
        : p.minCondition === "good" && h.condition !== "good"
        ? "Life-company money wants a well-kept building. Renovate first."
        : p.mezz
        ? "Mezzanine sits behind a senior — use Place mezz on the refinance desk, do not replace the first lien."
        : p.minLoan && q.principal === 0 && !vacantDirt
        ? `Below their minimum check — ${p.lender} doesn't underwrite anything under $${((p.minLoan) / 1e6).toFixed(0)}M.`
        /* THE WALL THAT USED TO BE INVISIBLE. A desk's hold size is the most
           common reason a large, perfectly good building gets a small quote,
           and it was the one wall with nothing written on it. It also names
           the way out, because there is one: a bigger balance sheet, or a
           syndicate, or several desks at once. */
        : q.holdCapped
        ? `${p.lender} won't hold more than $${(((p.maxLoan ?? 0) * sizeAreaScale(s)) / 1e6).toFixed(0)}M on one asset — that is their limit, not this building's. `
          + `A building this size needs a balance-sheet lender, a conduit, or the debt split across desks.`
        : raw.concWhy && !p.mezz
        ? `${raw.concWhy}.`
        : hair.why && hair.mult < 0.95 && !p.mezz
        ? `Proceeds cut ${((1 - hair.mult) * 100).toFixed(0)}% — ${hair.why}.`
        : p.uwDscr <= 0 && !vacantDirt
        ? (h.groundLeased
          ? "Land money is for vacant dirt. This fee has a ground rent to underwrite — use an income desk."
          : "Land money is for dirt. This one has a building on it.")
        : p.uwDscr > 0 && vacantDirt ? "No income to underwrite — a vacant site only gets a land loan."
        : undefined,
    } satisfies RefiQuote;
  });
  return { quotes, value, payoff: (h.loan?.balance ?? 0) + (h.mezz?.balance ?? 0) };
}

// Player-initiated refinance at current rates and value. `lev` scales the new
// loan down from the lender's maximum — the dial on the refinance screen.
export function refinance(s: GameState, parcels: ParcelTable, bbl: string, productId: string, lev = 1): { s: GameState; err?: string } {
  const next: GameState = cloneState(s);
  const h = next.holdings[bbl];
  const rec = resolveRec(parcels, next, bbl);
  if (!h || !rec) return { s, err: "You don't own that." };
  if (next.facility?.bbls.includes(bbl)) {
    return { s, err: "This deed is pledged to your facility. Release it before you put a mortgage back on." };
  }
  const product = productById(productId);
  if (product.mezz) {
    return { s, err: "Mezzanine sits behind a senior — use Place mezz, do not replace the first lien." };
  }
  if (!productOpen(next, product)) {
    return { s, err: `${product.label} won't quote you — ${sponsorStanding(next).label}. Bridge money will still talk.` };
  }
  const { value, noi, vacantDirt, quoteClass, hair, stab } = debtCollateral(next, parcels, h, rec);
  if (product.uwDscr <= 0 && !vacantDirt) {
    return { s, err: h.groundLeased
      ? "Land money is for vacant dirt. This fee has a ground rent — take it to an income desk."
      : "Land money is for dirt. This one has a building on it." };
  }
  if (product.uwDscr > 0 && vacantDirt) {
    return { s, err: "No income to underwrite — a vacant site only gets a land loan." };
  }
  // Same quote the card showed — haircut, stabilised bridge leg, and all.
  const full = quote(next, product, value, noi, quoteClass, false, stab);
  const qd = { ...full, principal: Math.round(full.principal * hair.mult * Math.max(0, Math.min(1, lev))) };
  const seniorBal = h.loan?.balance ?? 0;
  const mezzBal = h.mezz?.balance ?? 0;
  const oldBal = seniorBal + mezzBal;
  const penalty = (h.loan ? prepayPenalty(h.loan, next.month) : 0)
    + (h.mezz ? prepayPenalty(h.mezz, next.month) : 0);
  const points = Math.round(qd.principal * product.points);
  const capPremium = product.floating ? Math.round(qd.principal * 0.0125) : 0;
  const fee = Math.round(Math.max(qd.principal, oldBal) * REFI_FEE) + points + penalty + capPremium;
  if (qd.principal < 100_000) return { s, err: "No lender will size a loan against this income." };
  // Cash-in (and fees) can draw the line the same way a balloon gap does — a
  // firm with an undrawn revolver is not underwater on a takeout it can fund.
  const need = Math.max(0, oldBal + fee - qd.principal);
  if (need > 0 && fundableNow(next, parcels) < need) {
    return {
      s,
      err: penalty > 0
        ? `Proceeds don't cover the payoff. Breaking the old loan early costs $${(penalty / 1e6).toFixed(2)}M in ${h.loan?.prepay === "yieldmaint" ? "yield maintenance" : "prepayment"}.`
        : mezzBal > 0
          ? "Proceeds don't cover the senior and the mezz — you're underwater on this refi."
          : "Proceeds don't cover the payoff — you're underwater on this refi.",
    };
  }
  const newLoan = originate(next, product, value, noi, lev * hair.mult, h.condition, quoteClass, stab);
  if (!newLoan) return { s, err: "No lender will size a loan against this income." };
  // PRINCIPAL INTO CASH IS A LEDGER EVENT. Fees stay in debtSvc; net new
  // principal that lands in the operating account is `borrowed` — the bucket
  // conserve needs to see cash-out refinances. Paying the old balance down
  // with cash (negative net draw) is principal repayment and goes to debtSvc.
  const netDraw = qd.principal - oldBal;
  next.cash += netDraw - fee;
  coverCashShortfall(next, parcels);
  logBooks(next, "debtSvc", fee);
  if (netDraw > 0) logBooks(next, "borrowed", netDraw);
  else if (netDraw < 0) logBooks(next, "debtSvc", -netDraw);
  h.loan = newLoan;
  // A takeout retires the stack — mezz does not survive a senior refinance.
  if (h.mezz) h.mezz = null;
  // A takeout is a cure. Leaving the workout file open made the desk keep
  // asking for a refinancing after you had just closed one — and refreshed
  // the cure against the NEW balance.
  if (next.workouts?.[bbl]) delete next.workouts[bbl];
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Refinanced ${rec.address}: $${(qd.principal / 1e6).toFixed(2)}M at ${qd.ratePct.toFixed(2)}% (${product.label})`
      + (mezzBal > 0 ? `, retiring $${(mezzBal / 1e6).toFixed(2)}M of mezz` : "")
      + (penalty > 0 ? `, after $${(penalty / 1e6).toFixed(2)}M to break the old paper` : "")
      + (capPremium > 0 ? `, plus $${(capPremium / 1e6).toFixed(2)}M for the rate cap` : "")
      + ".",
  });
  // Cash-out proceeds pay the revolver before they sit idle.
  sweepLocIdleCash(next, { announce: true });
  return { s: next };
}
