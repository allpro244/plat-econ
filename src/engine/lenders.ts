// THE BANKS ARE FIRMS TOO.
//
// Six lenders have had names, spreads and covenants since the beginning, and
// behind the names there was nothing: an infinite balance sheet that quoted
// the same terms in 2003 and 2009 except for a credit index nobody could see
// the inside of. So "the window slams shut" was a sentence in a blurb rather
// than something happening to somebody.
//
// A lender here now carries a book. It has capital behind it, loans out in
// front of it, borrowers who stop paying, and a capital ratio that decides
// whether it is lending this quarter or apologising. When the cycle turns and
// the delinquencies come, the ratio falls, the appetite goes with it, and the
// desk that was quoting 75% last year will not answer the phone — not because
// a global index moved, but because THAT BANK is in trouble, and you can open
// its books and see it coming.
//
// Which is the whole point: a credit crunch you can read a quarter early is a
// decision. One that arrives as a number going down is weather.
import type { GameState } from "./types";
import { logBooks, BUILT_CLASSES } from "./types";
import { PRODUCTS } from "./debt";
import { rng, rrange, RENT_BASE, NATURAL_VAC, CAP_BASE } from "./market";
import { DEPOSIT_INSURANCE, chooseEra } from "./regime";
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export type LenderKind = "bank" | "life" | "conduit" | "fund";

/**
 * WHOSE DEPOSITS THESE ARE — the liability side, which this model did not have.
 *
 * A bank in this game had a loan book and no depositors. It failed AT NOBODY:
 * the regulator walked in on a Friday, the paper went to a receiver, and not
 * one person in the city noticed. That is the half that was missing, and it is
 * the half the owner asked for.
 *
 * `uninsuredShare` is the fact that decides how much a failure hurts, and it is
 * a fact about WHO BANKS THERE rather than about the bank's size. A thrift full
 * of household savings is almost entirely insured and its failure travels by
 * the credit channel — the small businesses who cannot get a working-capital
 * line. A commercial bank full of business operating accounts is badly
 * uninsured, and when it fails payroll does not get made. Silicon Valley Bank
 * was ~94% uninsured in 2023, which is why a bank nobody had heard of nearly
 * took the payroll of half an industry with it; a community thrift runs nearer
 * a third.
 */
export interface Deposits {
  /** Household and business money on the books, in today's dollars. */
  total: number;
  /** Share of it above the insurance limit — see DEPOSIT_INSURANCE. */
  uninsuredShare: number;
}

export interface Lender {
  id: string;
  name: string;
  kind: LenderKind;
  /** Everything they have lent, to you and to everyone else. */
  book: number;
  /** The equity behind it. Losses come out of here. */
  capital: number;
  /** Share of the book that has stopped paying. */
  delinquent: number;
  /** Realised losses this year, and over the life of the firm. */
  chargeOffsYr: number;
  chargeOffsTotal: number;
  /** Interest earned less funding cost less losses, this year. */
  netIncomeYr: number;
  /** How much they want to lend right now, 0-1. Everything above decides it. */
  appetite: number;
  /** Out of the market entirely, and the month it happened. */
  /**
   * The panic surcharge on this desk's funding today, in points, while another
   * desk in town is in receivership. Zero the rest of the time. Stored rather
   * than recomputed so the Research page can show a player exactly what a
   * neighbour's failure is costing the desk they borrow from.
   */
  panicBps?: number;
  failedM?: number;
  /** How many months the receiver takes to sell the franchise on. */
  reopenM?: number;
  /** What they have lent to YOU — the part of the book you are. */
  yours: number;
  /** What the standing book yields — written over years, repricing only as loans roll. */
  bookYield?: number;
  /** What the money costs THIS month. Deposits lag the index; hot money does not. */
  fundCost?: number;
  /** Capital returned to the owners this year — a bank manages to a ratio, not a pile. */
  divYr?: number;
  /** Capital ratio, sampled quarterly. The statement's history. */
  capHist?: number[];
  /** What this desk holds against this town, by asset class. Rebuilt monthly by ledger.ts. */
  classBook?: Record<string, number>;
  /** The liability side. See Deposits. */
  dep?: Deposits;
  /** Where the PLAYER's cash sits, if it sits here. */
  playerDeposits?: number;
}

/**
 * Who each desk is, structurally. The kind decides how they are funded and
 * therefore how they behave when it goes wrong: a bank funded by deposits
 * takes losses slowly and survives; a conduit funded by selling paper into a
 * market stops existing the day that market closes.
 */
/**
 * `wholesale` is the share of the funding that is hot money — brokered CDs,
 * repo, bonds that must be rolled. Core deposits sleep through a rate shock;
 * wholesale money reprices the week the index moves, which is the S&L
 * mechanism and the reason the regional dies in a hiking cycle while the
 * hometown bank merely has a bad year.
 */
const KIND: Record<string, { kind: LenderKind; capitalRatio: number; brittle: number; wholesale: number; blurb: string }> = {
  "First Harbor Bank": {
    kind: "bank", capitalRatio: 0.11, brittle: 0.5, wholesale: 0.2,
    blurb: "Deposits fund the book, so the losses have to be very bad before the lights go out. Small, local, and they remember who paid them in the bad years.",
  },
  "Alden Savings & Trust": {
    kind: "bank", capitalRatio: 0.095, brittle: 0.8, wholesale: 0.65,
    blurb: "A regional with a regional's problem: big enough to have made every mistake in the cycle, small enough that three of them matter.",
  },
  "Pelican Life Insurance": {
    kind: "life", capitalRatio: 0.18, brittle: 0.25, wholesale: 0.1,
    blurb: "Insurance float against long paper. The most patient money in the city and the most conservative — they are never the reason a crunch happens and never the ones who end it.",
  },
  "Meridian Street Capital": {
    kind: "conduit", capitalRatio: 0.04, brittle: 2.4, wholesale: 1.0,
    blurb: "They do not hold the loan; they sell it. Which is fine until nobody is buying, and then this desk is not tightening — it is closed.",
  },
  "Cordage Debt Partners": {
    kind: "fund", capitalRatio: 0.22, brittle: 1.1, wholesale: 0.3,
    blurb: "A fund with committed capital and no depositors to answer to. They lend into a crisis at crisis prices, which is the entire business model.",
  },
};

/** Who writes construction paper in this town. */
export const CONSTRUCTION_LENDER = "Alden Savings & Trust";

export function lenderBlurb(name: string): string {
  return KIND[name]?.blurb ?? "";
}

/** Every distinct lender named on a loan product, in the order they appear. */
export function lenderNames(): string[] {
  return [...new Set(PRODUCTS.map((p) => p.lender))];
}

/**
 * THE SHARE OF THIS TOWN'S PROPERTY DEBT EACH DESK HOLDS.
 *
 * A conduit is enormous and fragile; a hometown bank is neither. These are the
 * relative weights the five original absolute books were in, kept because the
 * SHAPE of the lending market — one dominant securitiser, a patient life
 * company, a regional, a small local, a fund — is a fact about the business.
 * What is no longer asserted is how big the market is; see initLenders.
 */
const BOOK_SHARE: Record<LenderKind | "firstharbor", number> = {
  conduit: 900 / 2410, life: 640 / 2410, fund: 310 / 2410, bank: 420 / 2410, firstharbor: 140 / 2410,
};

/**
 * WHAT THE PROPERTY IN THIS TOWN IS WORTH, roughly, from its own rents.
 *
 * Income capitalised — the same way every other price in this engine is
 * discovered. Stock by class, at that class's opening rent net of a typical
 * operating load and its natural vacancy, divided by that class's opening cap
 * rate. It is an order-of-magnitude figure and it only ever has to be one:
 * nothing is priced off it, it only sets how big the banks are.
 */
function cityPropertyValue(stock: Record<string, number>): number {
  let v = 0;
  for (const k of BUILT_CLASSES) {
    const sf = stock[k] ?? 0;
    if (sf <= 0) continue;
    // ~35% of gross goes out as opex and non-recovered costs across classes.
    const noiPsf = RENT_BASE[k] * (1 - NATURAL_VAC[k]) * 0.65;
    v += (sf * noiPsf) / (CAP_BASE[k] / 100);
  }
  return v;
}

export function initLenders(stock?: Record<string, number>): Lender[] {
  // A CITY'S BANKS ARE THE SIZE OF THE CITY, AND THEY DERIVE IT.
  //
  // These five books were absolute numbers, which was fine while there was one
  // island at one size. The first fix was a scale factor against a reference
  // island — which worked, and was still an asserted number: it said "the
  // standard town has 15.35M sf" in a constant, so the engine only knew how
  // big a city was by comparing it to one particular city that happened to
  // ship. That is a label, not a mechanism, and it would have gone stale the
  // first time anybody retuned the generator.
  //
  // A property lender's book is a share of the property debt in its market,
  // and the property debt is a share of what the property is worth. So: value
  // the town from its own rents and cap rates, lend against it at a normal
  // system-wide loan-to-value, and split that between the desks in the
  // proportions their names imply. No reference city, nothing to keep in sync,
  // and a map the generator has never produced before still gets banks the
  // right size for it.
  //
  // 55% is the aggregate loan-to-value of a whole commercial property market
  // rather than of one deal — individual loans are written at 60-75%, plenty
  // of buildings are owned free and clear, and the two together land near
  // here. It reproduces the original $2.41bn on the standard island to within
  // a few per cent, which is the check that it is a restatement and not a
  // rebalance.
  const SYSTEM_LTV = 0.55;
  const total = stock ? cityPropertyValue(stock) * SYSTEM_LTV : 2_410_000_000;
  return lenderNames().map((name, i) => {
    const k = KIND[name] ?? { kind: "bank" as LenderKind, capitalRatio: 0.10, brittle: 1 };
    const share = name === "First Harbor Bank" ? BOOK_SHARE.firstharbor : BOOK_SHARE[k.kind];
    const book = Math.max(20_000_000, Math.round(total * share));
    return {
      id: "L" + i, name, kind: k.kind,
      book, capital: Math.round(book * k.capitalRatio),
      delinquent: 0.008, chargeOffsYr: 0, chargeOffsTotal: 0, netIncomeYr: 0,
      appetite: 1, yours: 0,
    };
  });
}

/**
 * The capital ratio this kind of institution is supposed to run at. A life
 * company at 12% is in trouble and a conduit at 12% is having its best year —
 * so "is this desk impaired" is only answerable against its own target.
 */
export function targetCapital(name: string): number {
  return KIND[name]?.capitalRatio ?? 0.1;
}

/**
 * HOW BADLY THIS DESK NEEDS THE MONEY, 0 to 1.
 *
 * Zero at 1.15x their target — comfortable, and they will sell you nothing at
 * a price worth paying. One at 0.30x — the regulator is in the building and
 * they are shrinking the book by any means available, which is where the note
 * desk gets its inventory. Measured over 24,000 lender-months: below target
 * 25.4% of the time, below 0.7x target 5.5%, in receivership 3.1%.
 */
export function lenderPressure(l: Lender | undefined): number {
  if (!l) return 0;
  if (l.failedM !== undefined) return 1;   // a receiver is a forced seller by definition
  const t = targetCapital(l.name);
  return Math.max(0, Math.min(1, (t * 1.15 - capitalRatio(l)) / (t * 0.85)));
}

export function lenderByName(s: GameState, name: string): Lender | undefined {
  return s.lenders?.find((l) => l.name === name);
}

/**
 * WHAT A LENDER ASKS FOR A BUILDING IT DID NOT WANT.
 *
 * A flush desk markets at the mark; an impaired one puts the asset out at loan
 * basis — the carrying value that clears the charge-off. `lenderPressure`
 * interpolates between the two.
 */
export function reoAsk(s: GameState, mark: number, basis: number, lender: string): number {
  const p = lenderPressure(lenderByName(s, lender));
  const clears = Math.min(mark, Math.max(0, basis));
  return Math.max(0, Math.round((mark * (1 - p) + clears * p) / 1000) * 1000);
}

/** Capital over book — the one number that decides whether a desk is open. */
/**
 * WHERE YOUR MONEY SITS, AND WHAT HAPPENS WHEN THE DOOR IS PADLOCKED.
 *
 * The firm's cash used to be one abstract number that lived nowhere. It sits
 * at a bank now, and a bank is a thing that can fail — which turns "who do I
 * bank with" from flavour into a decision a real treasurer makes every week.
 *
 * Above the insurance limit you are an UNSECURED CREDITOR of the receiver.
 * You do not lose it all: the receiver sells the assets and pays out over a
 * year or two, historically 60-90 cents on the dollar for uninsured
 * depositors, with an advance dividend early and the rest when the book is
 * cleared. What you lose immediately is the USE of it, which for a developer
 * with a capital call due next month is frequently worse than the haircut.
 *
 * THE REWARD FOR SPREADING DEPOSITS IS AVOIDED LOSS, NEVER YIELD. sim.ts is
 * explicit that cash must not become a strategy — the deposit rate is a flat,
 * deliberately dull 1% — and that stands. Splitting your balance across desks
 * costs nothing and earns nothing; it only means a Friday afternoon does not
 * take all of it. That is exactly the trade a real treasurer makes, and it is
 * free until the one week it is not.
 */
export function insuredLimit(s: GameState): number {
  // The era is not stored on econ — it is chosen deterministically from the
  // seed, so it can simply be re-derived. See chooseEra.
  const era = chooseEra(s.seed).key;
  return (DEPOSIT_INSURANCE[era] ?? 100_000) * (s.econ.costIdx ?? 1);
}

/** Which desk the firm banks with, defaulting to its deepest relationship. */
export function bankOf(s: GameState): Lender | undefined {
  const live = (s.lenders ?? []).filter((l) => l.failedM === undefined && l.kind !== "conduit");
  if (!live.length) return undefined;
  return live.find((l) => l.id === s.bankId) ?? live[0];
}

function seizeDeposits(s: GameState, l: Lender) {
  const here = Math.max(0, s.cash);
  if (here <= 0) return;
  const limit = insuredLimit(s);
  const insured = Math.min(here, limit);
  const exposed = Math.max(0, here - limit);
  if (exposed <= 0) {
    s.news.unshift({
      q: s.month, kind: "info",
      text: `Your balance at ${l.name} was under the ${usdShort(limit)} insurance limit. It is all covered, and it is available Monday.`,
    });
    return;
  }
  // The receiver's advance dividend lands with the insured money; the rest is
  // a certificate and a wait. Recovery drawn from the real range.
  const recovery = clamp(0.60 + rng(s, "lenders") * 0.30, 0.60, 0.90);
  const eventual = Math.round(exposed * recovery);
  const lost = exposed - eventual;
  s.cash = insured;
  // THE WHOLE UNINSURED BALANCE LEAVES THE ACCOUNT TODAY, not just the part
  // that never comes back. Booking only the haircut left the receiver's
  // eventual dividend as cash that walked out with no entry behind it —
  // six months out of balance across 3,546 the first time a seizure ever
  // actually fired, which it never had before the losses on the street
  // started reaching the desks that funded them. The dividend is booked back
  // as it arrives in tickReceivership, so the net expense over the whole
  // episode is exactly the haircut.
  logBooks(s, "ga", exposed);
  (s.receivership ??= []).push({ from: l.name, amount: eventual, payM: s.month + Math.round(rrange(s, 12, 36, "lenders")) });
  s.news.unshift({
    q: s.month, kind: "warn",
    text: `YOUR BANK HAS FAILED. ${usdShort(here)} of the firm's money was at ${l.name}. `
      + `${usdShort(insured)} is insured and available Monday; ${usdShort(exposed)} was over the limit and you are `
      + `an unsecured creditor of the receiver. They expect to return about ${(recovery * 100).toFixed(0)}c on the dollar — `
      + `${usdShort(eventual)} — but not for another year or two. The ${usdShort(lost)} difference is gone. `
      + `A balance split across two desks would have been split across two Fridays.`,
  });
}

/**
 * THE RECEIVER REPUDIATES THE UNDRAWN COMMITMENT.
 *
 * Deposits are the loud half of a bank failure and the smaller one. The half
 * that ends firms is this: a construction loan is a promise to advance against
 * work in place, and a receiver does not advance. Every job in the failed
 * desk's pipeline stops funding on the same Friday — not because the job went
 * wrong, but because the lender did.
 *
 * The borrower's position afterwards is genuinely brutal and entirely real.
 * The drawn balance stays outstanding and keeps accruing, and the interest
 * reserve inside the dead commitment is as unfundable as everything else, so
 * carry that was capitalising into the loan becomes cash out of the firm's
 * account every month. The contractor is still on site under a contract the
 * developer signed. And the only way out is a replacement facility, which
 * takes a season to paper because a new desk has to re-underwrite a job it did
 * not originate and the receiver has to sign an intercreditor.
 *
 * This is not applied only to the player's own bank — the desk that holds your
 * deposits and the desk that wrote your construction loan are usually not the
 * same desk, and it is the second one that matters here.
 *
 * IT DOES NOT YET REACH THE CITY'S OWN CRANES. Rival and anonymous jobs live
 * in econ.cityJobs, which carries a balance and a rate but no lender, so there
 * is nothing to match a failed name against. Until that is wired, a bank
 * failure stops the player's sites and not the town's, which understates it:
 * the reason a seizure moved a whole market was that every borrower on that
 * desk's book stopped in the same week. See tickRepudiation in dev.ts for what
 * the borrower can do about it.
 */
function repudiateCommitments(s: GameState, l: Lender) {
  let jobs = 0;
  let exposed = 0;
  let mine = 0;
  for (const d of Object.values(s.developments ?? {})) {
    const desk = d.lender ?? CONSTRUCTION_LENDER;
    if (desk !== l.name || d.repudiatedM !== undefined) continue;
    // A job that has already drawn everything it was ever going to draw is not
    // harmed by the promise dying — there was nothing left in it.
    const room = Math.max(0, d.commitment - d.drawn);
    if (room <= 0) continue;
    d.repudiatedM = s.month;
    d.replaceM = s.month + Math.round(rrange(s, 3, 9, "lenders"));
    jobs++;
    exposed += room;
    if (s.holdings[d.bbl]) mine++;
  }
  // AND THE STREET'S CRANES, WHICH ARE THE MAJORITY OF THEM. A rival's job
  // carries a balance and a rate but no commitment — they are modelled more
  // coarsely than the player's — so repudiation for them means one thing: the
  // draws stop and the sponsor funds it out of their own account or the
  // contractor walks off. See fundJobs in rivals.ts.
  let street = 0;
  for (const j of s.cityJobs ?? []) {
    if (!j.firmId || j.orphaned || j.repudiatedM !== undefined) continue;
    if ((j.lender ?? CONSTRUCTION_LENDER) !== l.name) continue;
    j.repudiatedM = s.month;
    j.replaceM = s.month + Math.round(rrange(s, 3, 9, "lenders"));
    street++;
  }
  if (street) {
    s.news.unshift({
      q: s.month, kind: "info",
      text: `${street} site${street > 1 ? "s" : ""} on the street ${street > 1 ? "were" : "was"} being funded by ${l.name}. `
        + `The draws stopped on Friday. Whoever cannot carry their own job out of pocket is going to leave a frame `
        + `standing, and a frame that stops is a frame that ends up on the tape.`,
    });
  }

  if (!jobs) return;
  s.news.unshift({
    q: s.month, kind: mine > 0 ? "warn" : "info",
    text: mine > 0
      ? `THE RECEIVER HAS STOPPED FUNDING YOUR JOB${mine > 1 ? "S" : ""}. ${l.name} had ${usdShort(exposed)} of undrawn `
        + `commitment across ${jobs} site${jobs > 1 ? "s" : ""} in this town, ${mine} of them your${mine > 1 ? "s" : " s"}. `
        + `A receiver liquidates a book; it does not advance against work in place. The balance you have already drawn `
        + `stays outstanding and its interest now comes out of your account instead of the reserve. `
        + `You have a season to find a desk that will take the job out, and a contractor on site the whole time.`
      : `${usdShort(exposed)} of undrawn construction commitment died with ${l.name}. `
        + `${jobs} site${jobs > 1 ? "s" : ""} in this town stopped funding on Friday — watch which of them come back.`,
  });
}

/**
 * THE ENGINE SAYING "THIS ONE" — re-exported, not reimplemented.
 *
 * There used to be a copy of this here and a byte-identical private copy in
 * swans.ts, each carrying a comment asking for the other to be deleted. The one
 * implementation now sits next to the `Alert` interface in types.ts, which is
 * where both comments said it belonged. This line keeps the existing importers
 * working and is the only thing left of the duplicate.
 */
export { raiseAlert } from "./types";
import { raiseAlert } from "./types";

const usdShort = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);

/**
 * The receiver pays out, eventually. Called once a month from tickLenders.
 *
 * THE ENTRY IS THERE AND THE CATEGORY IS STILL WRONG, and that is worth saying
 * plainly rather than leaving as a comfortable silence. Conservation holds:
 * `seizeDeposits` books the WHOLE uninsured balance out as `ga` on the Friday
 * and this books the dividend back as `interest` when it arrives, so the net
 * expense across the episode is exactly the haircut and `pnpm conserve`
 * reconciles. What it is not is true bookkeeping. A bank failure is not
 * overhead and a receiver's dividend is not interest income; both are transfers
 * on the balance sheet, and a player reading their own P&L sees a year of
 * enormous G&A followed eighteen months later by a year of enormous interest.
 *
 * The honest fix is a ledger bucket for a balance-sheet movement — the same
 * treatment `s.loc.balance` and tenant deposits already get in the identity —
 * and that means a new key in `BooksYear`, which lives in types.ts. This change
 * does not own that file. Flagged, not fixed.
 */
export function tickReceivership(s: GameState) {
  if (!s.receivership?.length) return;
  const due = s.receivership.filter((r) => s.month >= r.payM);
  if (!due.length) return;
  for (const r of due) {
    s.cash += r.amount;
    logBooks(s, "interest", r.amount);          // money coming back, not income earned — see above
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `The receiver for ${r.from} has finished selling the book. ${usdShort(r.amount)} of your money comes back — `
        + `later than you needed it, which was the whole cost of it.`,
    });
  }
  s.receivership = s.receivership.filter((r) => s.month < r.payM);
}

export function capitalRatio(l: Lender): number {
  return l.book > 0 ? l.capital / l.book : 1;
}

/** In words, for the panel. */
export function lenderHealth(l: Lender): { word: string; bad: boolean } {
  if (l.failedM !== undefined) {
    const back = Math.max(0, (l.failedM + (l.reopenM ?? 18)));
    return { word: `in receivership — the franchise is being sold, back around month ${back}`, bad: true };
  }
  const cr = capitalRatio(l);
  const target = KIND[l.name]?.capitalRatio ?? 0.1;
  if (cr < target * 0.45) return { word: "undercapitalised — not lending to anybody", bad: true };
  if (cr < target * 0.7) return { word: "impaired — rationing hard", bad: true };
  if (l.delinquent > 0.055) return { word: "working out problem loans", bad: true };
  if (cr > target * 1.25 && l.delinquent < 0.02) return { word: "flush and looking for paper", bad: false };
  return { word: "open for business", bad: false };
}

/**
 * WHAT THIS DESK WILL DO FOR YOU TODAY, as a multiplier on the advance rate.
 *
 * This is the whole payoff of giving them books. A lender whose capital is
 * intact lends at its stated terms; one that has just eaten losses cuts the
 * advance rate for everybody, and one that is genuinely broken quotes nothing
 * at all. It is not a hidden index — you can read exactly this on Research a
 * quarter before it bites.
 */
export function lenderAppetite(s: GameState, name: string): number {
  const l = lenderByName(s, name);
  if (!l) return 1;
  if (l.failedM !== undefined) return 0;
  return l.appetite;
}

/**
 * One month of being a bank.
 *
 * Interest comes in on the performing book. Borrowers go bad at a rate set by
 * the credit cycle and by how empty the city is — this is a property lender,
 * and its losses are property losses. What goes bad gets charged off against
 * capital over the following year. Capital decides appetite; appetite decides
 * what anybody in this city can borrow, which is what makes a crunch a real
 * event with a cause instead of a slider.
 */
export function tickLenders(s: GameState) {
  // The receiver pays out on its own clock, whatever the banks are doing.
  tickReceivership(s);
  // A save from before banks were sized to the city, or a state built without
  // parcels: the econ already knows the stock, so use it.
  if (!s.lenders?.length) {
    s.lenders = initLenders(s.econ?.stock);
  }
  recountYours(s);
  const e = s.econ;
  const vac = e.cityVac ?? {};
  // The average excess vacancy across the city: the single best predictor of
  // whether the loans behind those buildings are being paid.
  const nat = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 } as Record<string, number>;
  let stress = 0, n = 0;
  for (const k of Object.keys(nat)) { stress += Math.max(0, (vac[k as never] ?? nat[k]) - nat[k]); n++; }

  // --- CONTAGION: WHAT ONE FRIDAY COSTS EVERYBODY ELSE ----------------------
  //
  // A seizure was a private event between a desk and its regulator. It is not.
  // The morning after a regional property lender is closed, every OTHER
  // regional property lender in the same market discovers that its brokered
  // CDs, its repo and its bond investors have repriced it — not because rates
  // moved, but because the counterparty risk they had been ignoring was just
  // demonstrated on the front page. Comparable institutions paid roughly 50 to
  // 150 basis points more for hot money after a failure nearby, and the ones
  // that looked most like the deceased paid several hundred.
  //
  // Modelled through the two things that already exist and are already
  // justified, rather than as a penalty:
  //
  //   `wholesale` — how much of this desk is hot money at all. First Harbor
  //   funds itself with sleeping deposits and barely notices; the conduit IS
  //   the bond market and closes with it. That distribution is not invented
  //   here, it is the same table that makes a rate shock asymmetric.
  //
  //   capital against target — the market does not reprice everyone equally,
  //   it reprices whoever resembles the failure. A fat desk pays a token; a
  //   desk sitting on its own target pays real money.
  //
  // And it is a LIVE SURCHARGE, not a level fed through fundCost's slow
  // adjustment. Funding reprices up fast and down slowly because depositors
  // are like that; a panic reprices in a week, which is the entire difference
  // between a panic and a trend. It decays with distance from the failure and
  // holds a floor while the receiver is still selling the book, because a
  // receiver liquidating into your market is itself a live signal.
  //
  // The loop this closes: the surcharge lands on net interest margin, nimFac
  // cuts appetite the SAME month, and it eats capital every month it lasts —
  // so a failure genuinely can take the next desk with it, without anything
  // in the model being told to arrange that.
  const PANIC_PEAK = 1.5;      // pp on hot money at the moment of a seizure
  const PANIC_HALFLIFE = 9;    // months; spreads normalised inside a year or two
  const down = s.lenders.filter((l) => l.failedM !== undefined);
  let panic = 0;
  if (down.length) {
    const newest = Math.max(...down.map((l) => l.failedM ?? 0));
    const since = Math.max(0, s.month - newest);
    // A second name going down in the same crisis is worse than the first.
    panic = Math.max(0.25, Math.exp(-since / PANIC_HALFLIFE)) * Math.min(1.6, 0.75 + 0.45 * down.length);
  }
  stress = n ? stress / n : 0;

  for (const l of s.lenders) {
    // --- RESOLUTION ---------------------------------------------------------
    // A failed bank is not a hole in the market forever. A receiver sells the
    // franchise — the branches, the deposits and the name — and inside a year
    // or two somebody is lending out of the same building under new ownership,
    // recapitalised, smaller, and far more careful than the firm that died.
    // Without this the city loses a desk permanently every crisis and by year
    // forty there is nobody left to borrow from, which is not a hard game, it
    // is a broken one.
    if (l.failedM !== undefined) {
      if (s.month - l.failedM >= (l.reopenM ?? 18)) {
        const k = KIND[l.name] ?? { capitalRatio: 0.1 };
        l.book = Math.round(l.book * 0.55);
        l.capital = Math.round(l.book * k.capitalRatio * 1.15);   // a resolved bank opens overcapitalised
        l.delinquent = 0.004;                                     // the bad paper stayed with the receiver
        l.appetite = 0.75;
        l.chargeOffsYr = 0; l.netIncomeYr = 0;
        delete l.failedM; delete l.reopenM;
        s.news.unshift({
          q: s.month, kind: "info",
          text: `${l.name} is lending again. The receiver sold the franchise, the new owners put fresh capital `
            + `behind it and the bad paper stayed behind — the name on the door is the same and the credit `
            + `committee is not. Smaller book, tighter standards, and one more desk answering the phone.`,
        });
      }
      continue;
    }
    const k = KIND[l.name] ?? { capitalRatio: 0.1, brittle: 1, wholesale: 0.5 };
    const spread = 1.9;

    // --- the book earns WHAT IT WAS WRITTEN AT -------------------------------
    // The margin used to be arithmetic: the book earned index+1.9 and the
    // deposits cost index-2.2, both off the LIVE index, so the spread was a
    // constant 4.1 points in every month of every run and a rate shock was a
    // non-event for a bank. A real book was written over years and reprices
    // only as loans roll (~3%/mo here, a ~30-month lag) — which is the entire
    // asset-liability problem of banking, and the reason 1980 and 2023 have
    // the same obituaries.
    if (l.bookYield === undefined) l.bookYield = e.indexRate + spread;
    l.bookYield = +(l.bookYield + 0.025 * (e.indexRate + spread - l.bookYield)).toFixed(4);
    const performing = l.book * (1 - l.delinquent);
    const interest = (performing * l.bookYield) / 100 / 12;
    // --- and the funding reprices at the speed of its source -----------------
    // Core deposits sleep. Wholesale money — brokered CDs, repo, the bond
    // market — reprices the week the index moves, and when the index has run
    // up more than a point inside a year, even depositors wake up and chase
    // it. `hot` is that overflow; `wholesale` is how much of this desk is
    // exposed to it. Funding reprices UP fast and DOWN slowly, because that
    // asymmetry is what depositors are like.
    const baseFund = l.kind === "bank" ? Math.max(0, e.indexRate - 2.2)
      : l.kind === "life" ? Math.max(0, e.indexRate - 1.4)
      : l.kind === "conduit" ? e.indexRate + 0.3
      : e.indexRate + 1.1;
    const then = e.history[e.history.length - 13]?.indexRate ?? e.indexRate;
    const hot = Math.max(0, e.indexRate - then - 0.6);
    const fundTarget = baseFund + hot * k.wholesale;
    if (l.fundCost === undefined) l.fundCost = baseFund;
    l.fundCost = +(l.fundCost + (fundTarget > l.fundCost ? 0.22 : 0.07) * (fundTarget - l.fundCost)).toFixed(4);
    // The panic surcharge, priced off how much this desk resembles the one in
    // receivership. A desk at its capital target pays the base share; one at
    // half its target pays nearly three times that. See the block above.
    // The ratio the market can SEE — the one on the last statement, entering
    // this month. It cannot price a number the desk has not booked yet.
    const weak = Math.max(0, Math.min(1.5, 1 - capitalRatio(l) / Math.max(0.01, k.capitalRatio)));
    l.panicBps = panic > 0 ? +(PANIC_PEAK * panic * k.wholesale * (0.35 + weak)).toFixed(3) : 0;
    const allIn = Math.max(0, l.fundCost + (l.panicBps ?? 0));
    const funding = (l.book * allIn) / 100 / 12;

    // --- and it goes bad -----------------------------------------------------
    // Delinquency follows the property cycle with a lag: buildings empty, then
    // owners burn reserves, then they stop paying. A recession alone is not
    // enough — it is a recession with vacancy behind it that does this.
    const badTarget = 0.006 + stress * 0.55 * k.brittle
      + (e.phase === "recession" ? 0.018 : e.phase === "depression" ? 0.014
        : e.phase === "recovery" ? 0.008 : 0) * k.brittle
      + Math.max(0, 1 - (e.creditIdx ?? 1)) * 0.03 * k.brittle;
    l.delinquent = Math.max(0.002, Math.min(0.35, l.delinquent + 0.10 * (badTarget - l.delinquent) + rrange(s, -0.0015, 0.0015, "lenders")));

    // A third of what is delinquent is eventually written off, spread over a
    // year. That is the number that eats capital.
    const chargeOff = Math.round(l.book * l.delinquent * 0.33 / 12);
    l.chargeOffsYr += chargeOff;
    l.chargeOffsTotal += chargeOff;
    const net = Math.round(interest - funding - chargeOff);
    l.netIncomeYr += net;
    l.capital = Math.round(l.capital + net);

    // --- CAPITAL IS MANAGED, NOT HOARDED -------------------------------------
    // Measured before this existed: retained earnings compounded untouched for
    // a century, the three deposit-funded desks ended every 600-month run at
    // 60-72% capital against 9.5-18% targets, and their appetite sat pinned at
    // the 1.15 cap for an average of 1.15 over 2,400 lender-months — the
    // credit cycle only ever happened to the conduit. A bank above its buffer
    // pays the excess out, which is what keeps a loss in year forty as
    // dangerous as one in year four.
    const target = k.capitalRatio;
    const buffer = l.book * target * 1.15;
    if (l.capital > buffer) {
      const div = Math.round((l.capital - buffer) * 0.08);
      l.capital -= div;
      l.divYr = (l.divYr ?? 0) + div;
    }
    const cr = capitalRatio(l);
    // --- appetite ------------------------------------------------------------
    // Above target they lend freely; below it they ration; well below it they
    // stop. A conduit's "appetite" is really whether the bond market is open,
    // which is why it swings furthest.
    const raw = cr / Math.max(0.01, target);
    // A DESK RATIONS ON ITS MARGIN AS WELL AS ITS CAPITAL. Capital is the
    // slow variable — losses take years to eat it — but the margin can be
    // gone in eighteen months of hiking, and a bank earning 1.5 points over
    // funding that used to earn 4 does not write new loans at old advance
    // rates while it waits to find out which. At the normal ~4-point margin
    // this factor is 1 and nothing changes; it only exists for the squeeze.
    // ALL-IN, panic included — otherwise the surcharge eats capital for a year
    // and the desk goes on quoting as if its funding were free. The margin is
    // what it actually costs to hold the book this month, and that is the
    // number a credit committee rations on.
    const nim = (l.bookYield ?? e.indexRate + spread) - Math.max(0, (l.fundCost ?? 0) + (l.panicBps ?? 0));
    const nimFac = Math.max(0.25, Math.min(1, 0.35 + 0.65 * (nim - 0.8) / 2.8));
    l.appetite = Math.max(0, Math.min(1.15,
      (raw - 0.55) / 0.6 * nimFac * (l.kind === "conduit" ? Math.max(0.25, e.creditIdx ?? 1) : 1)));
    // Growth at 0.35%/mo compounded to an 8x book over fifty years while the
    // town's whole rival debt stayed under a quarter of one desk — the banks
    // outgrew the city they lend to. Half that pace keeps them in it.
    l.book = Math.max(20_000_000, Math.round(l.book * (1 + (l.appetite > 0.8 ? 0.0017 : l.appetite > 0.4 ? 0 : -0.006))));

    if (s.month % 12 === 0 && s.month > 0) { l.chargeOffsYr = 0; l.netIncomeYr = 0; l.divYr = 0; }

    // --- and sometimes it ends, ON A FRIDAY ----------------------------------
    // The regulator does not wait for zero. A desk critically under its own
    // target — a fifth of it — is operating on the examiners' patience, and
    // one Friday afternoon the patience ends. This is what makes failure a
    // cliff you can watch a desk walking toward on Research rather than an
    // asymptote it can hug forever.
    const seizable = l.kind === "bank" || l.kind === "life";   // the conduit dies by market, not by regulator
    if ((l.capital <= 0 && rng(s, "lenders") < 0.35) || (seizable && cr < target * 0.22 && rng(s, "lenders") < 0.09)) {
      // ASK WHOSE BANK THIS IS BEFORE YOU CLOSE IT. bankOf() only considers
      // LIVE desks, so calling seizeDeposits after failedM was set meant the
      // failing bank had already been filtered out of its own question and the
      // player's balance was never touched — measured at 8 failures across 8
      // runs and not one cut. Establish it first, then padlock the door.
      const wasOurs = bankOf(s)?.id === l.id;
      l.failedM = s.month;
      l.reopenM = Math.round(rrange(s, 12, 30, "lenders"));
      l.appetite = 0;
      if (wasOurs) seizeDeposits(s, l);
      // And whether or not you banked with them, their cranes stop.
      repudiateCommitments(s, l);
      // A DESK GOING DOWN IS NOT A LINE IN THE PAPER. Whether or not the
      // player banked here, this is the month their borrowing capacity in this
      // town changed: a receiver does not lend, does not extend, and does not
      // advance against work in place, and it is about to be selling a book at
      // whatever clears. The detail line is the one number that decides what
      // they do about it — what this desk was lending THEM.
      raiseAlert(s, {
        kind: "bank", tone: "bad",
        title: `${l.name} has been closed`,
        body: wasOurs
          ? `The regulators walked in on a Friday and the firm's operating account is inside the padlock. `
            + `Whatever was over the insurance limit is a claim on a receiver now, not money. `
            + `Every loan they had outstanding went with them, and a receiver is not a lender.`
          : `${l.kind === "conduit" ? "The securitisation market took them with it" : "The regulators walked in on a Friday afternoon"}. `
            + `Every loan they had outstanding is with a receiver now, and a receiver does not extend, does not advance `
            + `against work in place, and does not haggle when it sells. Watch the tape: the best buying in this business `
            + `comes off a broken bank's books, and it is about to.`,
        detail: l.yours > 0
          ? `They held ${usdShort(l.yours)} of your debt. ${(l.delinquent * 100).toFixed(1)}% of their book had stopped paying.`
          : `${(l.delinquent * 100).toFixed(1)}% of their book had stopped paying, against a ${(targetCapital(l.name) * 100).toFixed(1)}% capital target.`,
      });
      // THE SAME FAILURE, FILED TWICE, IN THE SAME MONTH. `raiseAlert` above
      // already unshifts a warn (types.ts:906) carrying this exact event in
      // more detail — measured, the two counts were identical by construction
      // and identical in fact, 58 and 58 over a passive run. A paper that says
      // the same thing twice is not twice as informative; it is a paper the
      // reader learns to skim.
    } else if (l.appetite < 0.15 && rng(s, "lenders") < 0.04) {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `${l.name} has stopped quoting. ${(l.delinquent * 100).toFixed(1)}% of their book is not paying and their capital will not carry new loans.`,
      });
    }
  }
  // The statement keeps a history — capital ratio, sampled quarterly, fifty
  // years deep. The chart of a bank walking toward its seizure is the single
  // most readable object in the game.
  if (s.month % 3 === 0) {
    for (const l of s.lenders) {
      (l.capHist ??= []).push(+capitalRatio(l).toFixed(4));
      if (l.capHist.length > 200) l.capHist.shift();
    }
  }
  // --- THE BANKS ARE THE CREDIT MARKET ---------------------------------------
  // creditIdx was pure macro weather: the phase set a target and the banks'
  // own capital never touched it, so five impaired balance sheets and a
  // boom-time credit index could coexist. The book-weighted appetite of the
  // live desks now drags the index — gently, at a third of the macro pull, so
  // the cycle still leads — which closes the loop the file promises at the
  // top: losses eat capital, capital is appetite, appetite IS the availability
  // of credit in this town.
  {
    const live = s.lenders.filter((l) => l.failedM === undefined);
    const wSum = live.reduce((a, l) => a + l.book, 0);
    const sysApp = wSum > 0 ? live.reduce((a, l) => a + l.appetite * l.book, 0) / wSum : 0.4;
    s.bankApp = +sysApp.toFixed(3);
    const pull = Math.max(0.45, Math.min(1.2, 0.45 + 0.6 * sysApp));
    e.creditIdx = Math.max(0.4, Math.min(1.25, e.creditIdx + 0.025 * (pull - e.creditIdx)));
  }
}

/**
 * How much of each book is YOU, counted rather than tracked.
 *
 * Deltas drift — a payoff missed here, a deed handed back there, and by year
 * thirty the number is fiction. This walks the holdings every month, which is
 * cheap and cannot be wrong, and it is the number that tells you whether you
 * are a customer of this desk or a concentration on it.
 */
function recountYours(s: GameState) {
  const by: Record<string, number> = {};
  for (const h of Object.values(s.holdings)) {
    if (!h.loan) continue;
    const lender = h.loan.holder ?? PRODUCTS.find((p) => p.id === h.loan!.product)?.lender;
    if (lender) by[lender] = (by[lender] ?? 0) + h.loan.balance;
  }
  // Construction paper has never carried a product id, but somebody writes it,
  // and in every city this size it is the regional bank — which is precisely
  // why regionals are the ones that die in a development bust.
  for (const d of Object.values(s.developments ?? {})) {
    const name = d.lender ?? CONSTRUCTION_LENDER;
    by[name] = (by[name] ?? 0) + d.loanBalance;
  }
  for (const l of s.lenders ?? []) l.yours = Math.round(by[l.name] ?? 0);
}

/**
 * YOUR DEFAULT IS THEIR LOSS.
 *
 * Handing back a building is not a private event — it lands on a specific
 * desk, eats a specific pot of capital, and that desk remembers. A big enough
 * hole moves their delinquency, their appetite and, if you are large enough
 * relative to them, whether they are still in business.
 */
export function chargeLenderLoss(s: GameState, lender: string, loss: number) {
  const l = lenderByName(s, lender);
  if (!l || loss <= 0) return;
  l.capital = Math.round(l.capital - loss);
  l.chargeOffsYr += loss;
  l.chargeOffsTotal += loss;
  l.yours = Math.max(0, l.yours - loss);
  l.delinquent = Math.min(0.4, l.delinquent + loss / Math.max(1, l.book) * 0.6);
}
