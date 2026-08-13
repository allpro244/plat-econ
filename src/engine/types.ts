// The simulation state. Everything the game knows that isn't static parcel
// data lives here, and it must stay JSON-serializable — saves are snapshots.
import type { AssetClass } from "@/data/types";
import type { Lender } from "./lenders";

/**
 * THE CYCLE THE PLAYER READS ON THE HUD.
 *
 * `depression` is not a synonym for recovery. Recovery is the healing phase
 * after a recession; depression is what the machine used to mis-label as
 * recovery when slack was still a year of empty space and rents were still
 * falling — see CENTURY_REPORT.md §VIII.
 */
export type MarketPhase = "recovery" | "expansion" | "peak" | "recession" | "depression";

export type BuiltClass = Exclude<AssetClass, "land">;

export type SupplySource =
  | "city"
  | "teardown"
  | "reuse"
  | "rival"
  | "player"
  | "ground-lease"
  | "legacy";

/** One physical project in the city's authoritative delivery queue. */
export interface SupplyProject {
  id: string;
  bbl?: string;
  source: SupplySource;
  startM: number;
  deliverM: number;
  sfByUse: Partial<Record<BuiltClass, number>>;
  status: "active" | "stalled" | "cancelled";
}
export const BUILT_CLASSES: BuiltClass[] = ["office", "retail", "multifamily", "industrial"];

/**
 * FOUR GRADES, NOT THREE, because three had a floor and a floor is a free lunch.
 *
 * `worn` was the terminal state of neglect — the decay ladder in leasing.ts
 * returned null there — so a building that reached it could never get worse.
 * Measured on New Alden: 571 of 1,042 built parcels, 55% of the stock, START
 * worn, because initialCondition calls anything built before 1965 worn and the
 * campaign opens in 2000. Worn also carries a +70bp cap spread, so it is the
 * highest-YIELDING stock in the city. Buy the best yield on the tape and never
 * spend a dollar was, quite literally, the strategy of buying the assets the
 * engine had promised never to punish.
 *
 * `obsolete` is what actually happens to a building nobody puts money into: the
 * plant is finished, the market has stopped calling, and what is left is worth
 * the dirt. Nothing STARTS obsolete — initialCondition never returns it and
 * initialCondIdx floors above it. You have to earn it.
 */
export type Condition = "obsolete" | "worn" | "standard" | "good";

/** Shares of a building's floor area by use. Sums to 1. See engine/mix.ts. */
export type UseMix = Partial<Record<BuiltClass, number>>;
/** What you can choose to build: a single use, or a mixed-use stack. */
export type DevUse = BuiltClass | "mixed";

export type Sector =
  | "finance" | "law" | "tech" | "media" | "insurance"
  | "logistics" | "apparel" | "food" | "medical" | "design";

export type Credit = 0 | 1 | 2; // C, B, A
export const CREDIT_LABEL = ["C", "B", "A"];

export interface Tenant {
  name: string;
  // Which part of the building they are in. A shop under a block of flats is
  // a retail lease in a retail market, not a "mixed-use" lease.
  use?: BuiltClass;
  sector: Sector;
  credit: Credit;
  sf: number;
  rentPsf: number;     // $/sf/yr
  /**
   * ANNUAL CONTRACTUAL BUMP, percent. Applied on each lease anniversary.
   * Optional on old saves — the engine treats a missing field as 2.5%, which
   * is what every lease used to get in silence.
   */
  bumpPct?: number;
  net: boolean;        // legacy flag; `recovery` is the real answer
  recovery?: "nnn" | "base" | "gross";
  baseStopPsf?: number;   // base-year expense stop, $/sf — frozen at signing
  startM: number;
  endM: number;        // lease expiration
  freeUntilM?: number; // free-rent concession
  defaulted?: boolean;
  /**
   * SECURITY. One to two months of rent, taken at signing and held against the
   * space coming back damaged or the tenant walking. It arrives as cash and it
   * is NOT income — it is a liability that sits on your balance sheet until
   * the lease ends, and net worth is quoted net of it. A landlord with a
   * hundred tenants is holding a real number here, and it flatters the bank
   * balance of anybody who forgets that.
   *
   * Forfeited on a default, returned on an ordinary expiry, and handed to the
   * buyer when the building trades.
   */
  deposit?: number;
  /**
   * HEADCOUNT, INDEXED TO THE DAY THEY SIGNED, and it drifts with their trade.
   *
   * A tenant was a row: the same square feet at the same desk until the lease
   * ran out. Measured over 163 distinct tenancies and 15,448 tenant-months
   * across four fifty-year runs, not one tenant ever changed size, and not one
   * ever changed credit — so a ten-industry cycle reached the rent roll twice,
   * both times to decide whether somebody went bust.
   *
   * Above about 1.30 of their space they have outgrown the suite and either
   * take the floor next door or start touring; below 0.78 they are paying for
   * space they do not use and hand it back at the renewal.
   */
  staff?: number;
  /** When they last asked for more room, so nobody asks twice in two years. */
  askedM?: number;
  /** When they last asked for rent relief — nobody re-opens a lease twice in four years. */
  reliefAskedM?: number;
  /** Month the tenant gave notice that it will not renew. */
  nonRenewM?: number;
  /** The principal economic reason given with that notice. */
  nonRenewWhy?: string;
  /**
   * THE MONTH YOU TURNED THEM DOWN. A tenant who asked for relief and did not
   * get it does not forget it: they run leaner, they fail more (see pFail),
   * and when the lease finally rolls they remember who held the paper over
   * them. Clears from relevance after two years — businesses recover, and so
   * do relationships.
   */
  strainedM?: number;
}

/**
 * A TENANT ASKING, MID-LEASE. The one thing a rent roll never used to do was
 * SPEAK — tenants signed, paid, and left. This is the anchor whose trade has
 * turned, three years left on the paper, asking for a blend-and-extend from
 * the weak side of the table: a cut today for term tomorrow. It sits on the
 * desk like a letter (never a pop-up — with thirty tenants that would be a
 * fire alarm every quarter), it expires like one, and both answers are real:
 * take the haircut and keep the covenant, or hold the paper and carry the
 * default risk you just chose.
 */
export interface TenantAsk {
  id: number;
  bbl: string;
  /** tenant identity — name + original start month, because roll indexes shift */
  name: string;
  tenantStartM: number;
  sf: number;
  currentPsf: number;
  askPsf: number;
  /** months of term they will add for the cut */
  addM: number;
  arrivedM: number;
  expiresM: number;
  /** what kind of letter this is. Absent = "relief" (a rent cut for term, the original ask). */
  kind?: "relief" | "giveback";
  /** giveback only: the space they want to surrender, in sf */
  giveSf?: number;
}

export interface LOI {
  id: number;
  bbl: string;
  use?: BuiltClass;    // the component of the building they want
  /**
   * `expansion` is the sitting tenant asking for the space next door. It is a
   * major leasing decision and it deliberately arrives in the channel that
   * already exists: take the certain covenant coterminously, or hold the suite
   * back for a full-term tenant at a better number and risk the incumbent
   * outgrowing you and leaving at the roll.
   */
  kind: "new" | "renewal" | "expansion";
  name: string;
  sector: Sector;
  credit: Credit;
  sf: number;
  rentPsf: number;
  termM: number;
  tiPsf: number;       // tenant-improvement allowance, $/sf at signing
  freeM: number;       // free-rent months (not quarters)
  /**
   * ANNUAL RENT BUMP on the paper, percent. Negotiable with rent / TI / free
   * months. Missing on old letters — treated as the market standard 2.5%.
   */
  bumpPct?: number;
  net: boolean;
  recovery?: "nnn" | "base" | "gross";
  expiresM: number;
  // WHEN IT LANDED, which is not the same question as when it dies. A letter
  // you have had on the desk since spring is not somebody at the door — it is
  // your own unfinished business — and the broker who decides whose afternoon
  // is free does not count it as one.
  arrivedM?: number;
  countered?: boolean;
  // The negotiation: you counter with rent, TI, free rent and the bump; they
  // take it, walk, or counter back ONCE — and that one is final.
  stage?: "open" | "countered";
  counterRentPsf?: number;
  counterTiPsf?: number;
  counterFreeM?: number;
  counterBumpPct?: number;
  tenantIdx?: number;  // renewals: index into holding.tenants
  // What YOU asked for, kept so the card can show the conversation rather than
  // silently overwriting the opening terms with the answer.
  askedRentPsf?: number;
  askedTiPsf?: number;
  askedFreeM?: number;
  askedBumpPct?: number;
  openRentPsf?: number;   // their original number, before any of this
  openTiPsf?: number;
  openFreeM?: number;
  openBumpPct?: number;
  /**
   * WHICH TOUR THIS PARTY IS ON.
   *
   * A vacant suite in a tight market is being shown to two or three people at
   * once, and you can only have one of them. Letters sharing a tourId are
   * chasing the SAME square feet: signing one sends the others elsewhere, and
   * going back to one with a counter makes the others impatient. Undefined on
   * renewals (the incumbent is not competing with anybody) and on anything
   * written before this existed.
   */
  tourId?: number;
  /**
   * THE DESK SENT THIS BACK. Agent / renewal management left it on your desk
   * because it missed the auto-sign mandate but cleared the pass line. The
   * interrupt modal shows these even while the agent holds the book.
   */
  referred?: boolean;
}

/**
 * HOW THE TENANT ANSWERED.
 *
 * A counter used to resolve into a three-second toast and a card that vanished
 * off the grid, so the single most consequential leasing decision in the game
 * gave no account of itself. The reply is a record now: what you asked, what
 * they did about it, and what it cost or saved — and it sits on the deals
 * screen until you have read a few more of them.
 */
export interface LeaseReply {
  m: number;
  bbl: string;
  address: string;
  name: string;
  outcome: "took" | "walked" | "countered";
  askedRentPsf: number;
  theirRentPsf: number;   // what they had offered, or came back with
  askedTiPsf: number;
  theirTiPsf: number;
  askedFreeM?: number;
  theirFreeM?: number;
  askedBumpPct?: number;
  theirBumpPct?: number;
  sf: number;
  marketPsf: number;
}

/**
 * THE PORTFOLIO FACILITY — one loan against a pool of deeds. See
 * engine/facility.ts, which is where all of its behaviour lives; this is the
 * record it keeps.
 *
 * It is deliberately shaped like `Loan`, field for field where the fields
 * mean the same thing, because it IS a loan and a borrower reading the two
 * should not have to translate. What it adds is the pool (`bbls`), the
 * cross-default clock (`breachedSince`, `accelM`) and the fact that it is
 * signed personally.
 */
export interface Facility {
  /** Every deed the lender has a lien on. Sell one and the release price falls due. */
  bbls: string[];
  balance: number;
  /** What was drawn at closing, kept so the page can show how far it has amortised. */
  drawn: number;
  ratePct: number;
  lender: string;
  productId: string;
  originM: number;
  maturityM: number;
  ioUntilM: number;
  amortYears: number;
  monthlyPmt: number;
  /** The covenants, tested on the POOL rather than on any one building. */
  minDSCR: number;
  maxLTV: number;
  recourse: boolean;
  /** Set the month a pool-wide covenant test first failed; cleared when cured. */
  breachedSince?: number;
  /** The lender is trapping the cash flow of every building in the pool. */
  sweep?: boolean;
  /** Consecutive months the contractual coupon was not fully funded. */
  arrearsMs?: number;
  /** The month they accelerated. A receiver sells the whole pool three months later. */
  accelM?: number;
}

export interface Loan {
  /** The appraisal the desk lent against at closing — "LTV then" on the bank statement. */
  origValue?: number;
  product: string;
  floating?: boolean;
  points?: number;
  recourse?: boolean;         // a personal guarantee: a deficiency follows you
  prepay?: "open" | "stepdown" | "yieldmaint";
  prepayUntilM?: number;
  kicker?: number;            // participating paper: the lender's cut of the gain
  principal: number;
  balance: number;
  ratePct: number;       // current coupon (floating reprices each quarter)
  spread: number;        // over the index, for floating
  ioUntilM: number;      // interest-only through this quarter
  amortYears: number;
  maturityM: number;     // the balloon
  monthlyPmt: number;
  capPremium?: number;   // paid at closing on floating paper
  minDSCR: number;       // covenants, tested quarterly
  maxLTV: number;
  sweep: boolean;        // breach: cash flow trapped to principal until cured
  cleanQs: number;
  /**
   * MONTHS IN BREACH, CONSECUTIVELY.
   *
   * A swept loan used to be able to sit broken forever — the counter reset
   * every month it was still broken, so nothing downstream of a covenant
   * breach ever happened. Two years of this and the lender stops waiting and
   * opens a file, which is the covenant cause the workout desk declares and
   * previously had no way to reach.
   */
  breachMs?: number;
  /**
   * MONTHS THE PAYMENT DID NOT ACTUALLY GET MADE.
   *
   * `arrears` was declared as a workout cause in this file and could never
   * happen: nothing anywhere detected a missed payment, because debt service
   * is taken centrally and the player's cash simply goes negative. So the
   * workout desk's own copy about arrears was dead text, and the only route to
   * a foreclosure file was a blown balloon.
   *
   * A lender does not see your other buildings. What they see is a payment
   * that did not arrive — which is this building failing to cover its own debt
   * service while the borrower has no cash to make up the difference.
   */
  arrearsMs?: number;
  originM: number;
  holidayUntilM?: number;  // covenants do not bite until this month
  /**
   * WHO IS ACTUALLY HOLDING IT.
   *
   * The product says who wrote the loan. This says who owns it today, and they
   * are not always the same institution: a desk under capital pressure sells
   * paper, and the buyer of a discounted loan is not in the business of being
   * patient. Absent means the originator still has it. See engine/notes.ts.
   */
  holder?: string;
  cap?: { strike: number; expiresM: number }; // purchased rate cap: index capped at strike
}

export interface Holding {
  /** this building is part of a package you have taken to market as one ticket */
  inPackage?: boolean;
  /**
   * Bought with vehicle cash — NOI and sale proceeds route to `s.fund.cash`,
   * not GP liquidity. See fund.ts / PRINCIPAL_CALLS.md #4.
   */
  fundOwned?: boolean;
  bbl: string;
  boughtM: number;
  costBasis: number;
  deprTaken?: number;  // accumulated depreciation — reduces basis on sale
  assessed?: number;   // property-tax assessed value; steps up on reassessment
  /** A property-tax challenge pending before the assessor. */
  taxAppeal?: {
    filedM: number;
    decideM: number;
    assessedAtFile: number;
    target: number;
    fee: number;
    odds: number;
  };
  /** Month the last challenge was decided; another requires a later cycle. */
  lastTaxAppealM?: number;
  loan: Loan | null;
  /**
   * JUNIOR PAPER BEHIND YOUR SENIOR. Cordage mezz only — never a second first
   * lien. Absent unless you closed a Phase C stack. See debt.placeMezz and
   * PRIVATE_CREDIT.md.
   */
  mezz?: Loan | null;
  /** Month you last closed a private bridge on this deed — cooldown for re-quotes. */
  lastPrivateBridgeM?: number;
  /**
   * The label. It is a READING of condIdx below, recomputed every month — see
   * condGrade in value.ts. Kept as a string because every consumer in the
   * engine (rent multiplier, cap spread, lender minimums, leasing odds, bundle
   * discount) reads a grade, and a grade is what a broker actually says.
   */
  condition: Condition;
  /**
   * THE BRICKS, 0.20 to 0.97. Falls every month; a capital plan and a capital
   * programme push it back up. This is the player's half of the model the
   * street has always had — see tickAssetManagement in rivals.ts, whose own
   * comment claims the firms that skip the plan are "marked down for it exactly
   * the way the player is". They were not. Now they are.
   */
  condIdx?: number;
  /** Last month the capital plan went unfunded — firm cash could not cover the bill. */
  planCutM?: number;
  /**
   * HOW YOU HAVE DECIDED TO RUN IT — the two standing decisions, taken once
   * and lived with for years, which is how an operator actually sets a policy.
   *
   * `service` is what you spend on the people: cleaning, security, the front
   * desk, how fast anybody answers when a tenant rings. It moves the
   * controllable half of the operating bill by about a tenth either way —
   * measured at 1.2% of NOI down and 2.1% of NOI up, which is a rounding
   * error — and it decides who renews.
   *
   * `plan` is what you put back into the bones. Defer is free and the building
   * goes off; Fund holds the line; Reposition turns it round over a decade at
   * nearly twice the money.
   *
   * Both default to the middle, so a player who never opens the panel is
   * running exactly the building this game shipped with. See OPS_SERVICE and
   * OPS_PLAN below, and GameState.opsPolicy for the house default applied on
   * the day a deed closes.
   */
  service?: -1 | 0 | 1;
  plan?: 0 | 1 | 2;
  /**
   * HOW THE BUILDING IS RUN, AS THE TENANTS EXPERIENCE IT — a 31-month
   * exponential average of the service level rather than the switch itself.
   *
   * This is the whole reason cutting service is a trap and not a lever. The
   * saving lands on the first of next month; the consequence takes three years
   * to arrive, and by then it takes another three to undo. An operator who
   * under-spends looks fine for three years and then loses an anchor.
   */
  svcIdx?: number;
  lastCapM?: number;   // when this asset last had money spent on its bones
  renovatingUntilM?: number;
  tenants: Tenant[];   // commercial rent roll
  makeReady?: { sf: number; readyM: number; use?: BuiltClass }[]; // vacated space being turned; unleasable until ready
  /**
   * WHAT YOUR MANAGEMENT IS DOING TO THIS BUILDING'S CONTROLLABLE COSTS.
   * Stamped once a month by tickStaff so the operating functions can read a
   * plain number without being handed the whole GameState. 1 is the market
   * standard; below is a manager earning their salary, above is work that is
   * not getting done. It moves the OWNER'S result only — `assetValue` still
   * underwrites at market opex, because a buyer prices their own management,
   * not yours. That is appraisal practice and it is also the difference
   * between this and the same-quantity-two-answers fault in `holdingValue`.
   */
  pmOpexMult?: number;
  /** Stamped by markStaff — assigned PM skill on this building's renewals. */
  pmRenewalMult?: number;
  /** Stamped by markStaff — assigned leasing skill on rent at this building. */
  leasingRentMult?: number;
  // A leasing exclusive. The house works the phones for nothing and is paid
  // 6% of the base rent over the term of every lease signed while they hold
  // the file, in place of the 4%/2% you pay doing it yourself — see
  // exclusiveFeeRate in leasing.ts. It lapses when the building fills.
  broker?: boolean;
  // Somebody else's building stands on this dirt. It earns ground rent instead
  // of costing carry, and it is not yours to build on until the term is up.
  groundLeased?: boolean;
  // The lot is on OFFER for a ground lease — a listing, not a deal. Ground
  // lessees are scarce, so a counterparty arrives stochastically through
  // tickGroundLeases, at odds set by the corner's live demand and the same
  // development climate that governs the city's own starts. Optional, with
  // fallbacks everywhere it is read, so old saves load untouched.
  groundOffer?: { years: number; sinceM: number; review?: GroundReview };
  /**
   * Shopping the site for a build-to-suit occupier — a listing, not a signed
   * commitment. Anchors arrive through tickBuildToSuit the way ground lessees
   * arrive through tickGroundLeases; the programme on the offer is the shell
   * you are selling them. See proposeBuildToSuit / BtsCommitment.
   */
  btsOffer?: { use: BuiltClass; floors: number; coverage: number; sinceM: number };
  // Designated. No demolition, no bigger building, a rent premium forever.
  landmarked?: boolean;
  // PRE-BUILT SPACE. Suites fitted out speculatively, before anyone has signed
  // for them: the fastest-leasing product in the market, because a tenant who
  // can move in next month does not need six months of drawings and a fit-out
  // allowance. It costs the fit-out up front on space that may sit.
  specSuites?: { sf: number; readyM: number; use: BuiltClass };
  occ?: number;        // multifamily aggregate occupancy
  stance?: -1 | 0 | 1; // rent posture: push / market / fill
  /**
   * HOW LONG THIS SPACE HAS BEEN SITTING, in months, reset by any signature.
   *
   * The price of empty space falls until it clears. That is the oldest fact in
   * leasing and the model did not have it: `stance` is a switch the PLAYER
   * throws and nothing moved the ask on its own, so a building whose owner did
   * nothing asked the same rent forever and never let another foot.
   *
   * Measured over 25 years with an owner who accepted nothing: an 8,195 sf
   * office went 81% let to 0% and then drew FIVE prospects in twenty-five
   * years; a retail building went 73% to 0% and the receiver took it. Every
   * multiplier was individually defensible — condition 0.48 once it had gone
   * obsolete, the dark-building factor 0.85, location cubed, and no broker or
   * turnkey suites to offset any of it — and their product was a share of the
   * city's requirement indistinguishable from zero. Apartments were fine at a
   * stable 62%, because flats let themselves.
   *
   * So this is not a passivity penalty being softened. It is the missing half
   * of the price mechanism, and it costs what it costs in life: the space lets,
   * and it lets cheap, for the whole of a ten-year term.
   */
  darkMs?: number;
  /**
   * STOP LETTING IT.
   *
   * You cannot knock a building down with people in it, and you cannot empty
   * it by accident — an owner heading for a demolition or a gut stops signing
   * anybody new and stops renewing anybody rolling, and then waits out the
   * roll. It is a real and painful decision: the building bleeds income for
   * years before it is worth anything as a site.
   */
  leasingHold?: boolean;
  /** When a marketed campaign on this deed was last pulled. The market remembers. */
  lastCampaignM?: number;
  deliveredM?: number; // ground-up completion: new space leases with momentum
  // On the market. `countered` records that you have already been back to this
  // buyer once — a counter is a real move with a real cost, not a slider you
  // can grind, and one round per offer is what the etiquette actually allows
  // before you are wasting their afternoon.
  /**
   * ON THE MARKET — and how.
   *
   * `quiet` is what this used to be and all it used to be: put a number on the
   * building and wait for somebody to ring. It is cheap, it is slow, and one
   * bidder at a time means you never find out what the best buyer in the city
   * would actually have paid.
   *
   * `marketed` is a process. You appoint a broker, publish a whisper price,
   * run a campaign for a few months, and set a date for offers. On that date
   * you get a BID LIST — names and numbers, all at once — and you can take the
   * best of it or go back to the top of it for best and final, which usually
   * lifts the number and sometimes loses you a bidder. It costs a point more
   * in fees and it is the only way to find the top of the market.
   */
  sale?: {
    ask: number; listedM: number; unsolicited?: boolean;
    mode?: "quiet" | "marketed";
    callM?: number;                    // when offers are due
    bids?: Bid[];                      // the list, once they are in
    round?: number;                    // 0 first round, 1 best and final
    offer?: { price: number; expiresM: number; countered?: boolean; from?: string; retrade?: string };
  };
  program?: { id: string; untilM: number };  // capital program underway
  programsDone?: Record<string, number>;     // id -> completed quarter
  cfHistory: number[];
  /**
   * THE ASSET'S OWN TRACK RECORD — occupancy, in-place rent and NOI, stamped
   * every quarter for as long as you hold it.
   *
   * A building's history was invisible: the panel showed today's occupancy and
   * today's NOI, and the only way to know whether either was going the right
   * way was to remember. That is the one thing an operator actually has that a
   * buyer does not — you have watched it, and the trend is the reason you hold
   * or sell.
   *
   * Stored as a flat tuple rather than an object because saves are snapshots
   * and this is the only per-month array in the game that never stops growing:
   * [month, occ×1000, rent psf ×100, NOI/yr]. Quarterly, not monthly, because
   * quarterly is how the business reports and it keeps a century's hold to 400
   * rows instead of 1,200 — the whole state is deep-cloned every tick.
   */
  hist?: number[][];
}

// Ground-up development on an owned vacant lot (Groundwork, simplified):
// pick use and FAR up to zoning, 60% construction loan, the building rises
// over 4-6 quarters, then leases up from empty.
export type Contract = "gmp" | "costplus";

export interface BtsCommitment {
  name: string;
  sector: Sector;
  credit: Credit;
  use: BuiltClass;
  sf: number;
  rentPsf: number;
  termM: number;
  tiPsf: number;
  recovery: "nnn" | "base" | "gross";
  signedM: number;
}

export interface Development {
  bbl: string;
  /** what it is being built to, 0..1 with 0.5 as market standard */
  spec?: number;
  use: DevUse;
  mix: UseMix;
  sf: number;
  floors: number;
  /** Share of the lot the floorplate covers. Carried from the plan to delivery
   *  and on to the built record, because the MAP draws the building from it —
   *  see BuiltOverride.cov. */
  coverage?: number;
  /** How you chose to demise it, sf per space per use. Carried to delivery. */
  suites?: Partial<Record<BuiltClass, number>>;
  costTotal: number;      // the budget as it stands today, escalation included
  hardCost: number;       // the part exposed to escalation under cost-plus
  contract: Contract;
  contingency: number;    // held back against change orders; unspent is yours
  contingencyUsed: number;

  // The loan does not land in your account on day one. Equity goes in first,
  // then the bank funds draws against work in place, and the interest on what
  // has been drawn is paid out of a reserve inside the loan until it runs dry.
  /**
   * WHAT THE DIRT COST, frozen at groundbreak.
   *
   * The plan underwrites yield on cost against land plus construction, and
   * once the job is running the holding's costBasis is the only record of the
   * land half — which stops being true the moment the building delivers and
   * the construction cost is added to it. Carrying it on the job means the
   * all-in figure on a half-built building is the same all-in figure the deal
   * was approved on, plus whatever the budget has drifted since.
   */
  landBasis?: number;
  /** Which desk wrote the facility. Older saves carry none — the regional, the historical default. */
  lender?: string;
  /**
   * THE DAY THE MONEY STOPPED.
   *
   * A construction loan is not cash — it is a promise to advance, month by
   * month, against work in place. When the regulator closes the desk that
   * made the promise, the promise dies with it: a receiver's job is to
   * liquidate a book, not to fund a half-built building. The borrower is left
   * with a hole in the ground, a balance that still accrues, and a
   * construction contract they are personally on the hook for.
   *
   * This is the channel that made 1990 what it was. The seizure of a bank was
   * never mainly about the depositors — they were insured. It was about every
   * job in that bank's pipeline stopping in the same week.
   *
   * Set when the desk is seized; cleared when a replacement facility closes.
   */
  repudiatedM?: number;
  /**
   * When a replacement facility could realistically close. Drawn once at
   * repudiation: a new bank has to re-underwrite a job it did not originate,
   * and the receiver has to consent to the intercreditor. Three to nine
   * months is what that paperwork takes, and the job burns the developer's
   * own cash for every one of them.
   */
  replaceM?: number;
  commitment: number;     // the lender's total commitment
  drawn: number;          // funded to date
  loanBalance: number;    // drawn + capitalised interest
  interestReserve: number;
  reserveUsed: number;
  // THE LEASE-UP RESERVE, held back rather than poured into the slab. It is
  // financed with the rest of the job but it is not spent building anything —
  // it is the fit-out, the commissions and the carry that fill the building
  // after it opens, and it is released as cash on the day it does.
  leaseUpReserve?: number;
  equityBudget: number;   // your share of the budget
  equitySpent: number;
  /** Most recent borrower capital call caused by a construction funding gap. */
  lastCapitalCall?: number;
  lastCapitalCallM?: number;
  /**
   * THE DAY-ONE CHEQUE, STILL SITTING IN THE JOB.
   *
   * startDevelopment takes equityAtClose out of your account and marked it as
   * equity SPENT — which retired budget without paying for a single hour of
   * work. The S-curve then went on to spend the whole build cost on top of it,
   * so uses exceeded sources by exactly (equityAtClose − leaseUpReserve) and
   * that difference fell through as an unannounced capital call in the last
   * months before delivery. Measured at 1.33x to 1.51x the equity the panel
   * promised, and 2.43x to 2.75x the day-one figure.
   *
   * The cheque is money ON DEPOSIT against the budget. This is how much of it
   * the job has not yet drawn down.
   */
  equityPrefunded?: number;
  /**
   * WHETHER THIS JOB'S SQUARE FEET ARE ALREADY IN THE MARKET'S PIPELINE.
   * True from the desk for a new start (startDevelopment pushes its cohort the
   * month ground breaks) and for a takeover (the original sponsor's start
   * already queued it). Absent only on saves from before player construction
   * entered econ.cohorts — tickDevelopments registers those once and sets it.
   */
  piped?: boolean;
  ratePct: number;

  startM: number;
  deliverM: number;
  baseMonths: number;     // schedule at groundbreak, before slips
  // Tenants who signed while it was going up. Everything is built on spec now,
  // so this is earned during construction rather than bought before it — the
  // building that lets well on the way up opens covering its mini-perm, and
  // the one that lets nothing opens empty.
  signed?: { sf: number; use: string; discount: number; name: string }[];
  /** Named tenant committed before groundbreak; absent means ordinary spec. */
  bts?: BtsCommitment;
  mode?: "ground" | "reuse";
  reuseFrom?: UseMix;
  reuseOldSf?: number;
  events: number;         // how many things have gone wrong
}

// A delivered development overrides the static parcel record.
export interface BuiltOverride {
  class: BuiltClass;
  mix?: UseMix;
  bldgArea: number;
  floors: number;
  yearBuilt: number;
  /** sf per leasable space, per use — the programming decision you made. */
  suites?: Partial<Record<BuiltClass, number>>;
  /**
   * SITE COVERAGE — the share of the lot the building actually stands on.
   *
   * Carried so the MAP can draw the building the player designed. Without it the
   * renderer insets every lot by a constant 0.78 and draws the same footprint
   * whatever coverage was chosen, so the only way coverage reaches the picture
   * is through the floor count — backwards. Two buildings of identical square
   * footage, one wide and one tall, were drawn with a 2:1 difference in volume.
   */
  cov?: number;
}

export interface Listing {
  bbl: string;
  ask: number;
  listedM: number;
  expiresM: number;
  /** A house broker's first look: until this month, nobody else in town can take it. */
  earlyUntilM?: number;
  /** which shop rang you — a brokerRel key, while the window is open */
  via?: string;
  distress?: boolean;  // motivated seller — priced under appraisal, goes fast
  /** Why ordinary product reached the tape; makes turnover legible. */
  reason?: "fund-life" | "merchant" | "estate" | "voluntary" | "receiver";
  // A SITE WITH A FRAME ON IT. The sponsor could not finish, the receiver is
  // clearing it, and whoever buys inherits the steel that is already up and
  // the bill for the rest. Buying one starts a development at that progress
  // rather than at a hole in the ground.
  halfBuilt?: { use: string; sf: number; floors: number; progress: number; costToComplete: number };
  /**
   * THE RENT ROLL, DISCLOSED BEFORE YOU BID — which is what due diligence IS.
   *
   * This building's actual leases used to be conjured at the CLOSING. The tape
   * quoted market occupancy, you bought against that, and the deed handed you
   * whatever roll the dice wrote — which is why a building's value appeared to
   * collapse the moment it became yours. Both numbers were honest and they
   * were not the same number, and the player was shown the wrong one at the
   * only moment a decision was being taken.
   *
   * No seller in this business refuses to show a rent roll. It is the first
   * thing in the offering memorandum, and a buyer who is not given one walks.
   * So the roll is written when the building comes to market, it travels with
   * the listing, and the deed hands over exactly what the panel showed.
   *
   * `occ` carries the residential leg, which has no per-lease roll.
   */
  roll?: Tenant[];
  occ?: number;
  /**
   * The condition the roll was written against, and the condition the deed
   * conveys. Without this the panel priced the disclosed roll at "good" while
   * the closing graded the building and knocked a distressed one down a
   * notch — so occupancy matched across the closing and NOI did not, on 17 of
   * 40 measured purchases, by as much as 62%. One quantity, one answer.
   */
  cond?: Condition;
  /**
   * WHOSE BUILDING THIS IS, while it is on the market.
   *
   * The distress paths used to strip the deed out of a firm's book before
   * pushing the listing, so the most interesting sellers in the game — the
   * ones under pressure, and the dead ones being wound up — arrived at the
   * table as "a special servicer clearing a book". The news would say Kestrel
   * Capital was selling and then you negotiated with nobody.
   */
  sellerId?: string;
  /** Set when a receiver is clearing a failed firm's book, so it still reads. */
  receiverFor?: string;
  /** Outstanding loan the desk is clearing — the ask is anchored here, not appraisal. */
  loanBasis?: number;
}

/**
 * A BOOK ON THE MARKET AS ONE TICKET.
 *
 * The biggest transactions in this business are not buildings, they are
 * portfolios: a fund winding down, a bank clearing a borrower's whole
 * relationship, a principal exiting twenty years of assembly without letting
 * the market watch him do it lot by lot. They price differently from the sum of
 * their parts, because the list of counterparties who can close one is short.
 */
export interface PortfolioListing {
  id: string;
  bbls: string[];
  /** the number being asked for the whole book, today */
  ask: number;
  /** what the buildings appraise at individually — the ask is read against this */
  gross: number;
  listedM: number;
  expiresM: number;
  /** how many times the price has been cut. A receiver's cuts accelerate. */
  cuts: number;
  /** the player is the seller */
  player?: boolean;
  /** a rival is the seller */
  sellerId?: string;
  /** a bank is the seller, and it took this book into receivership */
  sellerLender?: string;
  reo?: boolean;
  reoBorrower?: string;
  reason: string;
}


import type { Comp } from "./comps";

/**
 * HOW THE COUPON KEEPS UP WITH THE WORLD.
 *
 * A fixed schedule is predictable for the leasehold lender; CPI indexing keeps
 * the landlord whole in inflation; an FMV reappraisal lets the landlord share
 * land appreciation — and is the structure lessees and their lenders fight,
 * which is why it opens at a lower coupon and takes longer to place.
 */
export type GroundReview = "fixed" | "cpi" | "fmv";

/**
 * A GROUND LEASE ON A FEE.
 *
 * Somebody else's building on the dirt, for a very long time. The fee owner
 * takes a coupon with reviews and no operating risk — and the site is not
 * theirs to build on until the term runs out. The leased fee CAN trade (it is
 * a bond with a deed attached): when it leaves your book the lease moves to
 * `cityGroundLeases` so the encumbrance survives the closing. The lessee
 * builds; the improvement sits in `built` until reversion hands the bones
 * back with the dirt.
 */
export interface GroundLease {
  bbl: string;
  startM: number;
  endM: number;
  rentYr: number;       // today's ground rent, before the next step
  /** Opening rent — FMV cumulative caps compound from this number. */
  openRentYr?: number;
  stepPct: number;      // fixed bump %; unused for cpi/fmv annual path
  stepEveryM: number;
  lastStepM: number;
  tenant: string;
  /** Review structure. Absent on old saves → treated as fixed. */
  review?: GroundReview;
  /** Annualised ceiling on FMV resets from openRentYr (e.g. 3.5). */
  fmvCapPct?: number;
  /** What they are putting up / put up. */
  use?: BuiltClass;
  sf?: number;
  floors?: number;
  /** Month the improvement opened. Absent while the frame is still rising. */
  builtM?: number;
}

export interface VarianceApplication {
  bbl: string;
  filedM: number;
  decideM: number;
  cost: number;
  grant: number;
  odds: number;
}

/**
 * One name on a bid list. `credibility` is the thing a seller is actually
 * judging: an aggressive number from a buyer who cannot fund it, or who reads
 * the building harder after they win, is worth less than a slightly lower one
 * that closes. It is what decides whether they retrade you.
 */
/**
 * A PORTFOLIO IN THE MARKET.
 *
 * One process, many deeds. The ask is for the bundle; the indications are for
 * the bundle; and at the closing table the number is allocated across the
 * deeds pro rata to value, because that is what the schedule to a purchase and
 * sale agreement actually looks like.
 */
export interface PortfolioSale {
  bbls: string[];
  ask: number;
  listedM: number;
  /** What the buildings were worth one at a time on the day it was listed. */
  sumOfParts: number;
  bids: {
    name: string; price: number; expiresM: number; countered?: boolean;
    /**
     * HOW FAR PAST THEIR NUMBER THIS PARTICULAR BUYER WILL GO, as a multiple of
     * their bid. Drawn per bidder rather than shared, because a single figure
     * for every institution in the city makes countering a rule the player
     * learns once instead of a judgement about the counterparty in front of
     * them. See `counterPortfolio`.
     */
    limit?: number;
  }[];
  /** They came to you. Those bids carry a premium and a short fuse. */
  unsolicited?: boolean;
}

export interface Bid {
  name: string;
  price: number;
  credibility: number;   // 0-1
  note: string;
  dropped?: boolean;     // walked at best and final
  countered?: boolean;   // you have already been back to this one privately
}

/**
 * ONE OFF-MARKET CONVERSATION, and there are exactly three ways it can be
 * standing when the panel reads it. Everything a screen needs is in this
 * comment; nothing downstream should have to open `approachOwner` to find out
 * what state it is in.
 *
 *   1. `refused === true`      — they turned you away. The door is shut until
 *                                `q + 6`; `approachOwner` enforces that itself
 *                                and returns an error before then.
 *   2. `ask !== undefined`     — there is a number on the table. Buy at it, or
 *                                counter once (`countered` says whether that
 *                                shot is spent). This is the old behaviour and
 *                                the only state old saves can be in.
 *   3. neither of those        — MAKE ME AN OFFER. The owner is willing to
 *                                trade and has refused to name a price. There
 *                                is nothing to display, because there is
 *                                nothing they told you. The only move is
 *                                `buyOffMarket(..., bid)` with a real number.
 *
 * `mode` records which kind of conversation it STARTED as and never changes;
 * `ask` records where it is NOW. So `mode === "offer"` with an `ask` present
 * means the owner finally named a figure after the player bid at them, which
 * is worth saying out loud on the panel because it is the only way that number
 * could have got there.
 *
 * Absent `mode` means the record predates this shape: treat it as `"ask"`, and
 * every old save reads exactly as it did before.
 */
export interface Approach {
  q: number;           // when the owner was approached
  refused: boolean;
  /**
   * HOW LONG THIS ONE IS SHUT FOR, and it is not the same for everybody.
   *
   * Every refusal used to expire on the same six-month clock, so a seller who
   * had politely declined and a seller you had insulted were back on the phone
   * in exactly the same month — which is how "you can keep coming back to the
   * same seller" and "sometimes it correctly refuses" ended up being the same
   * mechanism seen at two different points on one timer.
   *
   * The engine already knew how badly each conversation ended — how far under
   * their reserve the bid was, and how many times you had been back — and threw
   * both away at the moment of refusal. This carries it. Absent on saves written
   * before it existed, and on those the old six-month rule still applies.
   */
  coldUntilM?: number;
  ask?: number;        // if willing: their number, good for 4 quarters
  countered?: boolean; // you get one counter per approach
  /**
   * They would not name a price, you bid, and the bid drew the number out of
   * them. You may still counter it — see counterOffMarket, where the cost of
   * having shown your hand is priced — but the room is a few per cent, because
   * the figure they named is already within a whisker of their reserve.
   * Absent on saves written before it existed, where such a conversation was
   * closed with `countered` and stays closed.
   */
  named?: boolean;
  inbound?: boolean;   // they called you, not the other way round
  /** How this conversation opened. Absent on saves written before it existed. */
  mode?: "ask" | "offer";
  /**
   * THE RENT ROLL, DISCLOSED WHEN THE CONVERSATION OPENS — the off-market twin
   * of `Listing.roll`, and it exists for exactly the same reason.
   *
   * An off-market deal is not a blind one. You ring the owner, they take the
   * call, and the first thing that crosses the table is the roll and the
   * trailing twelve. Nobody in this business offers on a building without
   * them, and no seller who actually wants to trade refuses to send them.
   *
   * Without this field the panel had to write a roll at PREVIEW time, and
   * `genRentRoll` reads two things that move underneath it: `s.month`, which
   * stamps every lease start and expiry, and `s.econ`, which sets the target
   * occupancy. So the same building previewed in month 40 and closed in month
   * 43 handed over different paper — the same fault the listing path already
   * fixed, measured there at 39 of 200 purchases differing on occupancy and 84
   * on NOI. Stamped once, when the owner agrees to talk, and conveyed verbatim.
   *
   * `occ` is the residential leg, which has no per-lease roll; `cond` is the
   * grade the roll was priced against and the deed will convey. NOT set on a
   * refusal — there is no conversation, and therefore no disclosure.
   */
  roll?: Tenant[];
  occ?: number;
  cond?: Condition;
  /**
   * WHAT THEY WILL ACTUALLY TAKE, AND THE PLAYER MUST NEVER SEE IT.
   *
   * Only set while `mode === "offer"` and no `ask` has been drawn out yet. It
   * is the whole point of the mechanic that this number is private: an owner
   * who says "make me an offer" is refusing to anchor the negotiation, and a
   * panel that renders their floor — as a figure, a bar, a "you're close"
   * hint, a disabled slider that stops at it, anything — hands back the exact
   * information the refusal withheld. The player learns it by bidding and by
   * nothing else. It lives on state only because a save has to survive being
   * closed mid-negotiation.
   */
  reserve?: number;
  /** Blind bids made against `reserve` so far. Their patience is finite and it
   *  runs down with this — the panel may warn, and should not pretend to know
   *  how much is left. */
  probes?: number;
  /** The last number the player put in, so the panel can show them their own
   *  side of a conversation with no other numbers in it. */
  lastBid?: number;
  /**
   * YOU INSULTED THEM, AND WHEN THEY WILL TAKE YOUR CALL AGAIN.
   *
   * The lowball penalty used to be a news item and nothing else: talks were
   * deleted, the seller "ended it", and the player pressed Offer again in the
   * same month and went under contract at 94. A cost you can undo in one click
   * is not a cost. This is the month the door reopens, and until it does no
   * offer on this building is answered by anybody.
   */
  insultedUntilM?: number;
  /** How much their floor moved because of it, and it does not move back. */
  soured?: number;
}

/** A claim the city makes about you, computed from state, with a date on it. */
export interface Epithet {
  id: string;
  text: string;
  sinceM: number;   // the month it first became true
  weight: number;   // 0-1, how quotable
}

/**
 * WHO YOU ARE, AND HOW WELL THE TOWN KNOWS IT.
 *
 * The player was the string "You" — in the comps sheet, on the league table,
 * in every news item. Twelve rival firms had names and a paper trail; the
 * protagonist had a pronoun, which is why thirty years in the game still
 * sounded like year one.
 */
export interface FirmIdentity {
  name: string;       // "Corbin & Co."
  short: string;      // "Corbin" — for tables and comps
  foundedM: number;
  epithets: Epithet[];
}

export interface NewsItem {
  q: number;
  kind: "rumor" | "event" | "deal" | "info" | "warn";
  text: string;
  /** A story about a place can put the camera on the place. */
  bbl?: string;
}

export type PropertyEventKind =
  | "trade"
  | "build-start"
  | "delivered"
  | "demolished"
  | "default"
  | "major-lease"
  | "planning";

/** Sparse permanent deed history; rolling news remains prose and may expire. */
export interface PropertyEvent {
  m: number;
  kind: PropertyEventKind;
  use?: string;
  sf?: number;
  floors?: number;
  party?: string;
  otherParty?: string;
  amount?: number;
  outcome?: string;
}

/**
 * SOMETHING HAPPENED THAT THE TAPE IS NOT LOUD ENOUGH FOR.
 *
 * The news feed is a hundred and twenty rolling lines and most of them are
 * weather. A few things a century are not weather — a trade leaving town, a
 * bank going down, a book of buildings taken back at once — and a player who
 * scrolls past those has been told nothing. An Alert is the engine saying THIS
 * ONE, at the moment it fires.
 *
 * The engine RAISES and the UI RENDERS: `tone` is the only styling instruction
 * and it is an economic fact rather than a colour, `title` is a headline and
 * not a label, `body` is the two or three sentences a person would actually
 * say, and `detail` is the one number that decides what you do about it. The
 * UI shifts each alert off `game.alerts` as it shows it, so an engine that
 * raises nothing costs the UI nothing.
 */
export interface Alert {
  id: number;
  q: number;                 // the month it fired
  kind: "swan" | "bank" | "portfolio" | "ground" | "sale";
  tone: "bad" | "good";      // a black swan or a white one
  title: string;
  body: string;
  detail?: string;
}

/**
 * ...AND THE ONE WAY TO RAISE ONE. It lives here, beside the interface, because
 * three files raise alerts and none of them owns the other two. There were two
 * byte-identical copies of this — `lenders.raiseAlert` and a private `raise` in
 * swans.ts — each with a comment saying the other should be deleted. Two copies
 * of one thing is the third kind of fake number by this codebase's own
 * definition, so this is the copy and the others are gone.
 *
 * A runtime function in a types file is not the usual thing. It is safe here
 * for a checkable reason: every import in this file is `import type`, so the
 * module has no runtime dependencies and cannot be part of a cycle.
 */
export function raiseAlert(s: GameState, a: Omit<Alert, "id" | "q">) {
  const id = s.nextAlertId ?? 1;
  s.nextAlertId = id + 1;
  if (!s.alerts) s.alerts = [];
  s.alerts.push({ id, q: s.month, ...a });
  // AND IT GOES IN THE PAPER TOO, WHICH IS WHAT MAKES THE CARD OPTIONAL.
  //
  // The alert card was deliberately exempt from the pop-up switch, and the
  // reason given was exact: the decision cards are safe to silence because
  // every one of them also lives on a page, and these three did not live
  // anywhere, so suppressing one would either lose it outright or queue it to
  // ambush the player later. That reasoning is right, and the answer to it is
  // to give them a page rather than to refuse the switch. A bank going down is
  // news by any definition, so it is filed as news at the moment it fires,
  // whether or not anybody is shown a card. Now silencing the card costs
  // exactly what silencing the others costs: the interruption, and nothing
  // else.
  if (!s.news) s.news = [];
  s.news.unshift({ q: s.month, kind: a.tone === "bad" ? "warn" : "event", text: `${a.title} — ${a.body}` });
  // A queue the UI never drained would otherwise grow for a century. Eight is
  // more than anything realistic can raise between two renders.
  if (s.alerts.length > 8) s.alerts.splice(0, s.alerts.length - 8);
}

/**
 * WHICH KINDS OF SPACE EACH TRADE OCCUPIES.
 *
 * This is the same partition `leasing.ts` draws its prospects from — a shed is
 * let to logistics, food and apparel; an office floor to the six trades that
 * sit at desks — and it lives here because BOTH the leasing side and the swan
 * side need it and neither owns the other. `leasing.ts` still holds a private
 * copy called SECTORS_BY_CLASS; the two are identical today and the leasing
 * one should be deleted in favour of this import the next time that file is
 * open. Two lists with one meaning is exactly the third kind of fake number,
 * and this comment is the only thing currently stopping it.
 *
 * Multifamily has no entry on purpose. Flats are let to HOUSEHOLDS, not to
 * trades, so a trade leaving town reaches housing the way it reaches it in
 * life — through the jobs, and then through the people — and not through a
 * rent roll.
 */
export const SECTOR_CLASSES: Partial<Record<BuiltClass, Sector[]>> = {
  office: ["finance", "law", "tech", "media", "insurance", "design"],
  retail: ["apparel", "food", "medical"],
  industrial: ["logistics", "food", "apparel"],
};

/**
 * A LEVEL EVENT, written down so it can be read back.
 *
 * Not for the simulation — the simulation reads `Econ.swanTrade` and
 * `Econ.swanUse` — but for the history panel, for the harnesses that count
 * frequency, and for the player who wants to know what happened to this town
 * in 2038 and why the office market never came back.
 */
export interface SwanRecord {
  m: number;                       // the month it was announced
  family: "trade" | "use";
  key: string;                     // the sector, or the use class
  dir: 1 | -1;                     // white or black
  /** the level multiplier this event applied, once fully arrived */
  mult: number;
  glideM: number;                  // how long it takes to land
  title: string;
}

export interface EconHistoryPoint {
  q: number;
  indexRate: number;
  /** The secular level money is being pulled toward. See recordHistory. */
  rateRegime?: number;
  population?: number;
  jobs?: number;
  unemployment?: number;
  wageIdx?: number;
  outputIdx?: number;
  cpi?: number;
  landIdx: number;
  cycleDev: number;
  capOffice: number;
  rentOffice: number;
  creditIdx?: number;
  employIdx?: number;
  vac?: Record<BuiltClass, number>;
  rent?: Record<BuiltClass, number>;
  /** effective rent — asking net of concessions; the gap to `rent` is the market */
  effRent?: Record<BuiltClass, number>;
  /** construction & operating cost level — the cost-push term reads it */
  costIdx?: number;
  /** expected inflation, annualised — the anchor of the wage-price system */
  inflExp?: number;
  cap?: Record<BuiltClass, number>;
  abs?: Record<BuiltClass, number>;    // net absorption that month, sf
  comp?: Record<BuiltClass, number>;   // completions that month, sf
}

export interface Econ {
  indexRate: number;
  /**
   * THE CITY, NOT THE ASSET CLASSES.
   *
   * The sector breakdowns were good and the thing underneath them was a single
   * `employIdx` nobody could see. A property market is downstream of a real
   * economy — how many people live here, how many of them work, what they earn
   * in real terms, and what the place produces. Those four numbers explain
   * every rent in the game and none of them were on a screen.
   *
   * All of it is derived from the cycle rather than simulated separately: jobs
   * follow the phase, wages follow jobs with a lag and a productivity drift,
   * population follows jobs slowly because people move for work and move back
   * reluctantly, and output is the product of the two. They are honest
   * consequences, not decoration — the demand behind every lease you sign.
   */
  population?: number;        // souls in the city
  jobs?: number;              // filled positions
  unemployment?: number;      // 0-1, of the labour force
  wageIdx?: number;           // real wage, 1.0 at the start of the century
  outputIdx?: number;         // real output; jobs x productivity
  cpi?: number;               // the price level, for turning nominal into real
  phase: MarketPhase;
  phaseMLeft: number;
  rumoredPhase: MarketPhase | null;
  cycleDev: number;
  landIdx: number;
  capRate: Record<BuiltClass, number>;
  /** THE ASKING INDEX — the sticky face rate landlords quote. See effRentIdx. */
  rentIdx: Record<BuiltClass, number>;
  /**
   * Structural asking at campaign open (density + era). The income anchor
   * measures rent-to-wage against THIS, not the global RENT_BASE table —
   * otherwise a town that opens soft against the table looks "cheap" and
   * the anchor HELPS rents double before it ever pulls down.
   */
  rentAnchor?: Record<BuiltClass, number>;
  /**
   * Morphological density intensity (city FAR / REF_CITY_FAR), updated as
   * built stock grows. Feeds `cityClassFactor` — how much primary-market rent
   * machinery this fabric has earned. Secondary harbour towns stay the rule
   * of thumb; Metropolis fabric can earn the full chronic-tightness channel.
   */
  cityIntensity?: number;
  /** Opening `cityIntensity`, so stock growth can scale the live reading. */
  cityIntensity0?: number;
  /** Sum of opening stock by use — denominator for intensity growth. */
  builtSf0?: number;
  /**
   * THE MARKET REBUILD (ECONOMY.md). Tenants are finite and supply cannot
   * mint them; location has teeth in both rent and pace; asking rents are
   * sticky while effective rents move through concessions.
   */
  /** The finite pool: SF the city's tenants actually want, per use. Supply
   *  never touches it — demand forms from employment, sectors and (slowly)
   *  price, and unhousable demand stops looking within months. */
  pool?: Record<BuiltClass, number>;
  /**
   * Capacity shortage: (desired demand − housable) / stock. Distinct from the
   * absorption queue. Honest rent scarcity reads this; `unmet` is physical
   * unhousable looking demand only.
   */
  structTight?: Record<BuiltClass, number>;
  /**
   * Prior-month `structTight`, so rent scarcity can price the FLOW of a
   * capacity shortfall (worsening unmet demand) rather than a permanent tax
   * on a pinned vacancy rail. See market.ts rent formation / ECONOMY.md §F.
   */
  structTightPrev?: Record<BuiltClass, number>;
  /**
   * District land heat from comps (relative to town median). Written by
   * tickLandComps; read by landRead so builder-clearing sites still discover
   * street prints.
   */
  districtHeat?: Record<string, number>;
  /** Damped affordability multiplier (half-life ~6y). A three-year rent swing
   *  cannot conjure or destroy a fifth of the tenant base. */
  affordEff?: Record<BuiltClass, number>;
  /** Concession dial 0..1 — how much of the maximum giveaway (free rent +
   *  funded TI) the market currently hands tenants. Moves in months. */
  concIdx?: Record<BuiltClass, number>;
  /** Months vacancy has sat >1.5pp over natural — the capitulation clock.
   *  Asking rents do not fall until the landlord has stared at the empty
   *  floor for half a year. */
  vacOverM?: Record<BuiltClass, number>;
  /** EMA of vacTerm+scarcity that feeds the rent index — lease-quote lag.
   *  Market pressure forms instantly; landlords adjust asking rents only after
   *  trailing vacancy and unmet demand have sat on the quote sheet for months. */
  rentPress?: Record<BuiltClass, number>;
  /** EFFECTIVE rent = asking x (1 - 0.14 x concIdx). Everything that PRICES a
   *  deal or VALUES an asset reads this; everything that reports the market
   *  headline reads rentIdx. */
  effRentIdx?: Record<BuiltClass, number>;
  /** sf-weighted mean demandIdx of the built stock, measured once per city at
   *  init — the pivot that keeps the location curves mean-neutral on any map. */
  /** Which decade this game opened in. See regime.ts. */
  eraKey?: string;
  eraLabel?: string;
  eraBlurb?: string;
  locIdxMean?: number;
  /** Per-class location pivots — a shed competes with sheds, not with towers. */
  locIdxMeanBy?: Record<BuiltClass, number>;
  /** The ninth decile of the town's BUILDABLE lots by location — where a city
   *  actually builds, as opposed to where its average building already is.
   *  Set once from the parcel table; see `devPencils`. */
  locIdxDevP90?: number;

  // --- THE CLOSED LOOPS -----------------------------------------------------
  // Everything below is derived state for an economy that pulls on itself.
  // All optional with computed fallbacks, so an old save loads and simply
  // starts keeping these the month it is opened.

  /**
   * THE NATION THIS CITY SITS IN, and the central bank that sets the price of
   * money for all of it. Cities do not set interest rates; countries do — and
   * getting that wrong had a consequence beyond pedantry. With the policy rate
   * keyed to LOCAL unemployment, a player who cheated the money, overbuilt the
   * city and destroyed its labour market was rewarded with a rate cut aimed
   * squarely at his own mistake. A self-inflicted glut has to be a disaster,
   * and it cannot be one while the central bank is underwriting it.
   *
   * So the city is a small open economy inside a national one. It contributes
   * about a percent of national conditions and inherits all of national
   * monetary policy — which is exactly the position a real city is in.
   */
  nat?: {
    /** national inflation, annualised */
    infl: number;
    /** what the nation EXPECTS — the anchor, and what a credible bank defends */
    inflExp: number;
    /** national unemployment */
    unemp: number;
    /** the central bank's policy rate, percent */
    policy: number;
    /** r*, the neutral real rate — slow, secular, and itself a regime */
    neutralReal: number;
    /** months left in a supply shock (an oil embargo is not a demand story) */
    shockM: number;
    /** the size of that shock while it runs, in annual inflation points */
    shockSev: number;
    /**
     * How much the bank's word is worth, 0..1. A bank that has held inflation
     * near target for a decade has anchored expectations and can cut without
     * being disbelieved; one that let the 1970s happen has to break the
     * economy to be taken seriously again. This is the Volcker mechanism.
     */
    credibility: number;
    /**
     * WHAT THE BANK IS AIMING AT, which is not a constant of nature. The
     * Taylor rule used a hardcoded 0.02 and so every century converged on the
     * same monetary world — measured, twelve of twenty-two never once saw an
     * 11% loan. Before 1990 no central bank published a target at all and the
     * implicit one drifted with the politics. See regime.ts.
     */
    inflTarget?: number;
    /**
     * Where the neutral real rate is heading on a multi-decade clock. r* is
     * not a constant — roughly 3.5% in the 1960s, roughly 0.5% after 2010
     * (Laubach-Williams). Reverting to a fixed 1.2% is what collapsed every
     * century into the same monetary world. See regime.ts.
     */
    neutralAnchor?: number;
    /**
     * Months left in a NATIONAL recession, 0 while the country is expanding.
     * The nation has its own cycle and it is not the city's: what makes this
     * layer worth having is that tight money CAUSES the downturn that ends the
     * inflation, which is the loop the whole Volcker episode is made of.
     */
    recM?: number;
    /** months the current national expansion has run — the hazard clock */
    expM?: number;
    /** true while this recession is a depression rather than a downturn */
    deep?: boolean;
    /** where THIS recession is headed — drawn at onset, approached, not exceeded */
    uPeak?: number;
    /** what the bank THINKS trend inflation is: smoothed, and it looks through shocks */
    inflSm?: number;
    /** how much easier than neutral money has been, smoothed — the 1970s in one number */
    easeEma?: number;
    /** months of elevated supply-shock hazard: shocks cluster, 1973 and 1979 did */
    shockClusterM?: number;
    /**
     * Where the bank BELIEVES full employment is. Wrong, drifting, and the
     * single largest source of policy error in the historical record — the Fed
     * of the 1970s thought the natural rate was 4% when it was nearly 6%.
     */
    uStarBelief?: number;
    /**
     * Months the bank is not free to act. Both of the century's real
     * inflations happened to a central bank under political and fiscal
     * pressure not to raise rates — the Treasury needed cheap money for a war
     * and got it, formally until the 1951 Accord and informally into the
     * seventies. A model of monetary policy with no politics in it cannot
     * produce either of them.
     */
    pressureM?: number;
  };

  /**
   * EXPECTED INFLATION, annualised. The single most important number in a
   * macro model and the one this game did not have: inflation was a scripted
   * constant per phase, so nothing could be persistent, nothing could be
   * anchored, and the central bank had nothing to lean against. Wages, the
   * policy rate and construction costs all read this.
   */
  inflExp?: number;
  /**
   * THE RAISE THAT WAS NOT GIVEN, CARRIED FORWARD.
   *
   * Nominal pay does not get cut, it gets frozen — see the wage block in
   * market.ts. But a floor that simply discards the months when pay "should"
   * have fallen is not rigidity, it is a subsidy: truncating the bottom of a
   * noisy series and keeping the top raises its mean. Measured, that lifted
   * trend real wage growth from 1.18%/yr to 1.71% and pushed industrial real
   * rent to +1.77% against a +1.5 band, purely as an artefact of the clamp.
   *
   * What actually happens is pent-up wage deflation: the adjustment a firm
   * could not make by cutting is made by under-granting the next increase, and
   * it can sit unpaid for years. So the shortfall accumulates here and is
   * worked off against later raises, which gives rigidity its real shape — pay
   * that plateaus for a long time rather than pay that ratchets — without
   * changing where the trend ends up.
   */
  wageDebt?: number;
  /** Unfilled positions as a share of the labour force — what employers wanted
   *  and could not staff. Zero whenever the market is slack. Together with
   *  `unemployment` this is the tightness the wage curve reads; on its own it is
   *  the half that used to be thrown away when employment was allowed to exceed
   *  the people available to do it. */
  jobVac?: number;
  /**
   * The loan index a developer actually underwrites to — smoothed over about a
   * year, because a groundbreak is a two-year decision and is neither killed
   * by one bad print nor rescued by one good one.
   */
  rateEma?: number;
  /**
   * The property market's slack, stock-weighted across classes and smoothed
   * with roughly an eight-month half-life. This is what the phase machine
   * reads so that it can no longer call a 45%-vacant city an expansion.
   */
  slackEma?: number;
  /** When slack last forced a turn, so one glut cannot rattle the cycle. */
  forcedTurnM?: number;
  /**
   * Share of citywide stock under construction, smoothed. An observable, and
   * no longer the input to anything: it is what the town MANAGED to build,
   * which is the demand for construction after a hard crew ceiling has already
   * rationed it. `crewUtil` is what the trades actually price off.
   */
  buildEma?: number;
  /**
   * HOW BOOKED THE BUILDING TRADES ARE — jobs running plus orders not yet
   * started, over the crews available to take them, smoothed on about a year.
   * One means exactly fully employed, which is why it is the pivot the cost
   * of construction is priced around: unlike an observed equilibrium share it
   * cannot go stale.
   */
  crewUtil?: number;
  /**
   * THE WORST THIS GLUT HAS BEEN, per class, while it lasts.
   *
   * A capitulation is renewed when the market deteriorates materially past
   * anything it has already repriced for. Without this the clock only knew how
   * LONG a glut had run, and gluts build slowly — measured, the deepest gap
   * arrives 43 to 117 months in, by which time the repricing window has closed
   * and the market takes its worst quarter with no reaction at all. Cleared
   * with `vacOverM` when the class comes back inside its threshold.
   */
  vacWorst?: Record<BuiltClass, number>;
  /**
   * The size of the town's construction workforce against what a place this
   * size carries in an ordinary year. Trades migrate to work: this grows while
   * the order book is oversubscribed and shrinks while it is not. It is the
   * reason the crew count is a market rather than a wall.
   */
  crewIdx?: number;
  /**
   * How chronically short of space this city has been, over about a
   * twenty-year memory. A city that has been tight for a generation earns a
   * higher sustainable rent-to-income ratio — this is the Manhattan premium,
   * and it has to be EARNED rather than assumed.
   */
  tightEma?: number;
  /**
   * What developers believe rents are, as opposed to what they are. Adaptive
   * and lagging, so a run of rising rents gets extrapolated into pro formas —
   * which is what actually causes overbuilding in every real cycle.
   */
  rentExp?: Record<BuiltClass, number>;
  /**
   * THE EXIT CAP A DEVELOPER UNDERWRITES — a slow memory of the spot cap rate,
   * on about a four-year clock because that is the horizon a land buyer is
   * pricing. The land residual reads this rather than the spot yield, so a peak
   * rent is not capitalised at a peak-compressed cap inside what is already a
   * difference of two large numbers.
   */
  capExp?: Record<BuiltClass, number>;
  /** sf-weighted mean vintage factor, same job for the quality tilt. */
  vintageMean?: number;
  costIdx: number; // construction & operating cost inflation
  // Sectors do not move together. Each class carries its own momentum, so
  // office can be in a bear market while sheds are the best trade in town —
  // which is the whole reason to hold more than one kind of building.
  sectorMom: Record<BuiltClass, number>;
  // WHAT THE TENANTS DO FOR A LIVING.
  //
  // The classes have had their own cycles for a while. The INDUSTRIES inside
  // them did not — ten sectors existed and the engine read them exactly twice,
  // both times to copy a name onto a lease. So a rent roll seventy per cent
  // let to finance was not a bet on finance, a tech bust took nobody with it,
  // and concentration was a word with no mechanism behind it.
  //
  // Each industry now runs its own boom / steady / bust clock on its own
  // volatility — tech and media swing hard, insurance and medical barely move
  // — independent of the asset class that houses them. An office building let
  // to five law firms and one let to five startups are different assets, and
  // this is the difference.
  industryMom?: Record<Sector, number>;
  industryPhase?: Record<Sector, "boom" | "steady" | "bust">;
  industryPhaseM?: Record<Sector, number>;
  // ---------------------------------------------------------------------
  // AND THE LEVEL THE CYCLE RIDES ON. See swans.ts.
  //
  // Everything above this line is a CYCLE: it turns, it comes back, and its
  // long-run mean is the number it started at. A city's actual history is not
  // made of cycles. Kodak leaving Rochester was not a bust in imaging, it was
  // a permanent restatement of how much imaging Rochester holds, and it did
  // not reverse when the next expansion arrived. So the trade level and the
  // use level are separate terms, they only ever move on an event, and they
  // never revert. `swanTradeRef` is a two-year memory of what normal was,
  // which is what turns a moving level into felt distress and — crucially —
  // what lets the distress END while the level stays where the event put it.
  /** how much of each trade this city holds, 1.0 at the opening; never reverts */
  swanTrade?: Record<Sector, number>;
  /** where each trade level is heading, and the months left to get there */
  swanTradeTo?: Record<Sector, number>;
  swanTradeM?: Record<Sector, number>;
  /** a two-year memory of each trade's level: the yardstick distress is felt against */
  swanTradeRef?: Record<Sector, number>;
  /** how much of each kind of space this city wants, 1.0 at the opening; never reverts */
  swanUse?: Record<BuiltClass, number>;
  swanUseTo?: Record<BuiltClass, number>;
  swanUseM?: Record<BuiltClass, number>;
  /** this month's employment consequence of the trade levels moving, as a drift */
  swanJobDrift?: number;
  /**
   * HOW BIG THIS TOWN IS AT MONTH ZERO — jobs and people, derived from the
   * buildings actually standing on the map rather than asserted.
   *
   * These were the constants 132,000 and 240,000, written into `initEcon` and
   * into four other expressions, and they did not move when the map did: a
   * 393-lot Hamlet and a 5,897-lot Great City both told the player they had
   * 240,000 residents. On a Hamlet that works out at about ten square feet of
   * office space per office job.
   *
   * `jobs0` is the stock divided by the same square-feet-per-worker the demand
   * model uses, so the two agree about what an office building is for. `pop0`
   * follows from it through the participation rate and the opening
   * unemployment, which is the relationship the old pair already encoded —
   * 132,000 / 0.948 / 0.58 = 240,069 — except that it was solved by hand once
   * and then frozen. Everything downstream runs on INDEXES against these, so
   * the dynamics are unchanged and only the levels now describe the town.
   */
  jobs0?: number;
  pop0?: number;
  /**
   * INDUSTRIAL SHARE OF EMPLOYMENT, indexed to 1.0 at game start.
   *
   * Shed demand used to track total `jobIdx`. That is the wrong wire: total
   * employment rises with the city while manufacturing's SHARE of employment
   * (and of floor space) falls secularly. Measured before this field existed,
   * industrial vacancy sat on its frictional floor most months and
   * `AFFORD_BAND`'s lower rail was load-bearing for the class — CLAUDE.md fake
   * #5. See `INDUST_COMP_MONTH` in market.ts for the historical sizing.
   *
   * Optional so an old save loads at 1.0 and then declines from the month it
   * is opened, which is the least surprising migration.
   */
  industComp?: number;
  /**
   * WHAT SHARE OF THE CITY'S PAYROLL EACH TRADE IS. Published by the demand
   * model, which is the only thing that knows: a trade's size is its affinity
   * for the classes this particular city actually built, so a warehouse town
   * and a banking town do not have the same ten shares. Shares sum to 1.
   *
   * Two places used to assume a flat tenth each, and one of them said so in a
   * comment that gave the reason as "nothing anywhere weights one trade above
   * another" — which was not true when it was written. `TRADE_AFFINITY` in
   * demand.ts weights every trade by building class and `EMP_CONC` raises the
   * result to the 2.2, so the spread is structural and large.
   */
  sectorShare?: Partial<Record<Sector, number>>;
  // Everything the rest of the market is building, by class, in square feet.
  // Starts respond to profit; deliveries land ~30 months later and take the
  // rent with them. This is the supply half of the cycle, and without it a
  // boom never ends of its own accord.
  pipeline: Record<BuiltClass, number>;
  starts: Record<BuiltClass, number>;
  supplyPress?: Partial<Record<BuiltClass, number>>;
  /**
   * P97 site-level underwriting appetite by class, refreshed annually from
   * actual vacant parcels. P97 is the expected best site in the 36-lot sample
   * the city examines for each crane (36/37 ≈ 97th percentile).
   */
  sitePencil?: Record<BuiltClass, number>;
  // THE PIPELINE AS A QUEUE, not a number. Every start is a cohort with a
  // month it will deliver in, so the game can answer the question every
  // developer actually asks — "what is coming, and when" — instead of only
  // "how much is out there somewhere". This is what makes the supply side
  // legible: you can see the wave before it lands on you.
  cohorts?: Record<BuiltClass, { m: number; sf: number; bbl?: string }[]>;
  /**
   * THE AUTHORITATIVE CONSTRUCTION QUEUE. One row per physical project, with
   * every use leg and one delivery date. `cohorts` and `pipeline` are derived
   * views retained for charts and old saves; starts write here through
   * engine/supply.ts.
   */
  deliveryQueue?: SupplyProject[];
  /**
   * SQUARE FEET THE SPACE MARKET HAS ASKED FOR AND THE MAP HAS NOT YET BUILT.
   *
   * The economy used to decide how much the city should build and drop it
   * straight into an anonymous cohort queue, while the map placed buildings by
   * a completely separate rule. Over fifty years the market grew the city 60%
   * and the map gained four buildings — twenty-eight times more floor area
   * existed in the rents than on the ground.
   *
   * Now it is a debt the map owes, worked off lot by lot. A burst of demand is
   * followed by a burst of cranes and then a quiet stretch, which is also how
   * a real pipeline behaves.
   */
  startOwed?: Record<BuiltClass, number>;
  /**
   * Working capital for anonymous merchant construction. Named rivals fund
   * jobs from their own cash; unclaimed city jobs draw from this pool and
   * orphan when it cannot carry the month's spend. Replenished each month in
   * `fundJobs` from city employment and credit conditions.
   */
  cityBuildCash?: number;
  /**
   * One-line causal read for the latest material asking-rent move per class —
   * vacancy pressure, income anchor, jobs, or supply. Written by `tickEcon`
   * and shown on the Economy class cards.
   */
  rentWhy?: Partial<Record<BuiltClass, string>>;
  /**
   * WHAT HAS BEEN DECIDED ON BUT CANNOT BE DUG YET.
   *
   * `startOwed` is the order book a crane can actually be pointed at. It used
   * to be written the same month the space market decided it wanted the space,
   * and `tickCityGrowth` spent it that same month — so the entire distance
   * between "this city needs four hundred thousand feet of office" and a hole
   * in the ground was zero. Measured, that is exactly what `pnpm leadlag` saw:
   * `orders -> breaks` came out CONTEMPORANEOUS, and negative once the draining
   * of the book was accounted for, against a leg that should run 0-18 months.
   *
   * A decision to build is not a groundbreak. Site control, design, entitlement
   * and a construction lender take six to eighteen months on a by-right
   * commercial project in the United States, and considerably longer where the
   * approval is discretionary. That is the queue this holds: dated orders that
   * mature into `startOwed` when their pre-development is done. Same idiom as
   * `cohorts`, one stage earlier in the pipeline.
   */
  entitling?: Record<BuiltClass, { m: number; sf: number }[]>;
  completions12?: Record<BuiltClass, number>;   // trailing 12-month deliveries
  // THE MONETARY ERA. The loan index used to mean-revert at 0.03/month toward
  // a phase target between 5.0 and 7.0, clamped to 4.2-9.2 — so over a whole
  // century it never left a two-point band and rates were, in practice, a
  // constant. Real money does not behave like that: there are decades of cheap
  // money and decades of dear money, and the cycle rides ON TOP of whichever
  // era you happen to be in. rateRegime is that era; the phase supplies only a
  // deviation from it.
  rateRegime?: number;    // the secular level of money
  rateAimTo?: number;     // where the era is heading
  rateAimM?: number;      // month the era next re-rolls
  // Capital availability, 1 = normal. In a crunch this falls, spreads widen,
  // lenders size smaller, and cap rates gap out — independent of the index.
  // What month it is. The space market needs the calendar to tell a building
  // that opened last year from one that opened in 1928.
  m?: number;
  creditIdx: number;
  // The demand driver behind leasing velocity.
  employIdx: number;
  // THE SPACE MARKET, class by class. Stock is every square foot standing;
  // occupied is every square foot with a tenant in it; their ratio is the
  // citywide vacancy that decides which side of the table has the leverage.
  // Employment pulls occupancy up, deliveries push vacancy up, and rents move
  // on the GAP between vacancy and its natural rate — the classic four-
  // quadrant model, run monthly.
  stock: Record<BuiltClass, number>;
  // what was standing on day one — the anchor the demand target is measured
  // against, so a century of building does not drag the target along with it
  baseStock?: Record<BuiltClass, number>;
  // ...and the same thing FROZEN, because baseStock is not frozen: the
  // sector-exit ratchet in market.ts writes it down as tenants are priced out
  // and never return. The difference between the two IS how much of a sector
  // has left the city, and the city's zoning has to be able to read it — land
  // zoned for an industry that is half gone does not stay zoned for it.
  // Optional so a save written before this existed still loads; absent, no
  // sector has left as far as the zoning is concerned, which is the old
  // behaviour exactly.
  baseStock0?: Record<BuiltClass, number>;
  occupied: Record<BuiltClass, number>;
  cityVac: Record<BuiltClass, number>;
  /**
   * Month the "vacancy up 2pp YoY" broker tell last fired. Debounces the news
   * line so a long soft market does not spam the paper every month.
   */
  vacTellM?: number;
  absorb12: Record<BuiltClass, number>;   // trailing 12-month net absorption, sf
  // EACH CLASS HAS ITS OWN CYCLE. sectorMom was an AR walk with a +/-0.02 cap
  // and noise so small it sat at a tenth of that forever — the classes moved
  // together, as one market wearing four labels. Now every class runs an
  // explicit boom / steady / bust clock of its own, so office can be three
  // years into a bust while apartments are booming, which is the ordinary
  // condition of a real property market.
  sectorPhase?: Record<BuiltClass, "boom" | "steady" | "bust">;
  sectorPhaseM?: Record<BuiltClass, number>;   // months left in it
  history: EconHistoryPoint[];
}

// One year of the ledger: every dollar in or out, bucketed. The Books page
// renders these; actions and the tick both write into the current year.
export interface BooksYear {
  yr: number;       // 0-based game year
  noi: number;      // property NOI collected (pre-debt)
  debtSvc: number;  // debt service + refi fees + cap premiums + voluntary principal paydowns
  leasing: number;  // TI and leasing commissions, including the 6% an exclusive takes
  capex: number;    // programs, renovations, make-ready turns
  dev: number;      // development equity, construction interest, overruns
  taxes: number;    // income + capital gains + property (property is inside NOI)
  bought: number;   // equity out the door on acquisitions
  sold: number;     // net proceeds in from dispositions
  ga: number;       // firm overhead — asset management, accounting, legal
  interest: number; // what the bank paid you on idle cash — never property income
  /**
   * Net new mortgage / facility principal drawn into cash (cash-out refinance,
   * facility proceeds above the mortgages they repay). The conservation
   * identity used to be blind to these — they raised cash with no books entry.
   * Monthly amortisation still travels through `debtSvc`; this bucket is only
   * the balance-sheet draws that land in the operating account.
   */
  borrowed?: number;
  /**
   * LP capital called into the fund vehicle — equity IN, not income.
   * See fund.ts; conserve tracks this with `lpDistributed` against
   * Δ(cash + fund.cash).
   */
  lpCalled?: number;
  /**
   * Distributions to LPs from the vehicle — equity OUT, not expense.
   */
  lpDistributed?: number;
}

/** Same flow buckets as BooksYear, stamped once per game month for the monthly statement. */
export interface BooksMonth {
  m: number;
  noi: number;
  debtSvc: number;
  leasing: number;
  capex: number;
  dev: number;
  taxes: number;
  bought: number;
  sold: number;
  ga: number;
  interest: number;
  borrowed?: number;
  lpCalled?: number;
  lpDistributed?: number;
}

/**
 * A December close of the balance sheet. Enough to re-open last year's sheet
 * without keeping every deed's rent roll forever.
 */
export interface BalanceSnapshot {
  m: number;
  cash: number;
  deposits: number;
  propGross: number;
  mortgages: number;
  landOnly: number;
  bldgCount: number;
  landCount: number;
  byClass: Record<string, { n: number; gross: number; debt: number }>;
  cip: number;
  cipDebt: number;
  cipN: number;
  notesVal: number;
  noteCount: number;
  locBal: number;
  locLim: number;
  facility: number;
  totalAssets: number;
  totalLiab: number;
  equity: number;
  nwEngine: number;
  rate: number;
}

export interface Exit {
  bbl: string;
  address: string;
  boughtM: number;
  soldM: number;
  price: number;
  basis: number;
  gain: number;
  forced?: boolean;
}

/**
 * A black mark on the sponsor's record. Real estate is a small business at the
 * top: the same twenty lenders see every deal, and a foreclosure follows a
 * name around for a decade. This is how leverage acquires a memory — without
 * it, maximum leverage was a free option, because handing back a non-recourse
 * asset cost you the asset and nothing else.
 */
export interface SponsorEvent {
  m: number;
  kind: "forced" | "deficiency" | "seized" | "dpo";
  address: string;
  amount: number;      // the hole left behind, if any
}

/**
 * WHAT KIND OF FIRM THIS IS — and it is a personality, not a difficulty dial.
 *
 * Four archetypes described a street where every firm wanted the same thing at
 * the same time and differed only in how much leverage it used to get it. That
 * is not a market; a market is a room where the reason one bidder is in it is
 * the reason another one is not. These eleven each answer a different question
 * — do I hold or sell, do I buy when money is cheap or when it is gone, do I
 * spend on the building or milk it, am I here for the yield or the exit — and
 * the answers put them on opposite sides of the same trade.
 */
export type RivalStyle =
  | "core"           // institutional: stabilised income, disciplined, patient
  | "opportunistic"  // wins the last three years of every cycle, loses the next
  | "developer"      // buys dirt and puts buildings on it
  | "family"         // holds forever, no debt, will not sell to you at any price
  | "merchant"       // merchant builder: builds to SELL, never holds the finish
  | "pe"             // local private equity on an IRR clock: buy, fix, exit by year five
  | "reit"           // listed: must keep paying the dividend, in the market always
  | "vulture"        // distressed specialist: dormant in a boom, ravenous in a bust
  | "owneruser"      // a company buying its own premises: never sells, never prices
  | "foreign"        // offshore capital buying safety: trophy assets, low yield, no debt
  | "slumlord";      // buys the worst stock cheap and spends nothing on it

/**
 * A competing firm. Aggregate balance sheet, real portfolio — enough to bid
 * against you, to overreach, and to fail, without carrying a rent roll and a
 * loan stack for every building in town.
 */
export interface Rival {
  /**
   * LP CAPITAL COMMITTED AND NOT YET CALLED — the young fund's cushion.
   * Set once at the raise (30-50% of the first close, drawn per fund),
   * burned by capital calls, never refilled. Absent on the opening roster
   * and on saves written before it existed: both mean a fully-invested
   * vehicle, which is what the old model assumed for everybody.
   */
  uncalled?: number;
  /**
   * When each deed arrived, by BBL. The hold clock: a private-equity fund on
   * an IRR mandate and a family office holding for a generation both own
   * buildings, and the only thing that distinguishes them is this number.
   */
  heldSince?: Record<string, number>;
  /** Delivery month of buildings this firm constructed, for merchant exits. */
  deliveredM?: Record<string, number>;
  /**
   * WHEN THE EXTENDED PAPER ON A BUILDING COMES BACK, by BBL. Present only for
   * a building whose balloon the desk re-papered rather than took the keys on;
   * absent is the ordinary case and means the loan sits on the term ladder.
   *
   * This used to live inside `heldSince` under an `ext|` prefix because this
   * file was not open at the time. It is its own map now for a reason that
   * cost something: the sweep test read "does this firm have ANY key with that
   * prefix", eight sites take a deed off a rival and only three cleared the
   * prefixed key, and a record left behind for a building the firm no longer
   * owned went on stopping its distributions. Measured before the fix: 58.6%
   * of extension records outlived their building, and 54% of all swept
   * firm-months were held up by one of them.
   */
  extendedTo?: Record<string, number>;
  id: string;
  name: string;
  style: RivalStyle;
  cash: number;
  debt: number;
  bbls: string[];        // what they own
  targetLtv: number;
  bornM: number;
  aum?: number;          // marked each month, for display
  /** Last mark's annual NOI — kept so absorption can size a line without re-walking the book. */
  markNoi?: number;
  /** Last mark's vacant-land value — same reason as markNoi. */
  markLand?: number;
  stressMs?: number;     // consecutive months in trouble
  /**
   * Months with an empty book while solvent. A firm that sells its last
   * building and still has cash used to sit on the leaderboard forever as a
   * husk — half the "alive" firms at year 100 in the century report. The
   * clock retires them once they have had a fair window to redeploy.
   */
  emptyMs?: number;
  // Cost basis of the book, in aggregate. Not per building — that is the one
  // thing about a rival's accounts nobody needs to see — but enough to tax a
  // gain honestly when they sell, which is a cost the player has always paid
  // and the street never did.
  basis?: number;
  // WHAT THEIR BUILDINGS ARE ACTUALLY DOING. A rival's assets used to be
  // marked at market occupancy in birth condition forever, which meant the
  // street could only ever be hurt by the macro cycle — no rival ever lost a
  // tenant, ran a building into the ground, or had a bad leasing year, and the
  // player was the only participant in the city exposed to asset management.
  // One occupancy and one condition index across the book is enough to make
  // them mortal without giving twelve firms a rent roll each.
  occ?: number;          // portfolio occupancy, 0-1
  mktOcc?: number;       // what the market says their book should run at
  condIdx?: number;      // how well they look after the bricks, 0-1
  capexYr?: number;      // what they spent on the buildings this year
  dumped?: number;       // buildings hit the tape in the CURRENT stress episode
  taxPaid?: number;      // lifetime income + gains tax
  distributed?: number;  // lifetime cash sent out to their partners
  failedM?: number;      // the month they stopped existing
  // A CASH SHORTFALL IS NOT A FAILURE WHILE THERE IS ROOM ON THE BOOK.
  // Lifetime draw on their own credit, for the street table — a firm running
  // on its revolver is a firm you should be watching.
  revolver?: number;
  /**
   * Genealogy — who walked out of where to found this shop. Absent on the
   * opening roster and on anonymous capital entry. See HANDOFF_PRINCIPAL.md §5.
   */
  spawnedFrom?: {
    firmId: string;
    firmName: string;
    personName: string;
  };
}

/**
 * A person who left a firm and is trying to raise. Genealogy proposes; the
 * product-gated raise in rivals.ts can still refuse (owner call #7).
 */
export interface FounderBid {
  readyM: number;
  name: string;
  bornM: number;
  diesM?: number;
  attrs: Record<string, number>;
  obs: Record<string, number>;
  band0: number;
  career?: import("./people").CareerLog;
  role: "pm" | "leasing" | "construction";
  fromFirmId: string;
  fromFirmName: string;
}

/**
 * WHAT YOU AND A FIRM HAVE ACTUALLY DONE TO EACH OTHER.
 *
 * Measured: in a fifty-year run the player closes with nine distinct named
 * firms and deals with five of them more than once — and none of it was
 * written down anywhere, so every conversation started from nothing and the
 * street stayed a set of strangers who happened to keep appearing.
 *
 * This is the ledger. It moves on actions the player already takes, it is
 * never asked about, and it changes their number and whose buildings the
 * broker rings about.
 */
export interface StreetTie {
  deals: number;      // buildings traded between you, in either direction
  beats: number;      // times they came over the top of you on a live deal
  insults: number;    // times you opened a conversation with a number they refused
  lastM: number;
}

/**
 * A SPECIFIC CORNER A SPECIFIC FIRM TOOK OFF YOU.
 *
 * Kept so that when they finally let it go — ten years later, into strength or
 * out of a receivership — the game can put it in front of you before the tape
 * and say whose it was and what they paid. That is the difference between a
 * rival and a name in a news line.
 */
export interface Beat {
  bbl: string;
  firmId: string;
  firm: string;
  m: number;
  yours: number;      // your last offer
  theirs: number;     // what they paid to end the conversation
}

/** Who is on the other side of the table, and therefore what they want. */
export type SellerKind = "estate" | "institution" | "partnership" | "developer" | "local" | "lender";



export interface GameState {
  /** Which desk the firm banks with. See bankOf in lenders.ts. */
  bankId?: string;
  /**
   * Money owed to you by the receiver of a failed bank — uninsured deposits
   * that will come back at 60-90c, in a year or two. It is not cash and it is
   * not net worth you can spend; it is a certificate and a wait.
   */
  receivership?: { from: string; amount: number; payM: number }[];
  /**
   * The months a desk in this town was seized, most recent last, trimmed to
   * the last three years. What the funding market prices contagion off — see
   * the panic block in lenders.ts. It is a list of EVENTS rather than a count
   * of desks currently in receivership, because a receivership lasts one to
   * three years and a panic does not.
   */
  seizures?: number[];
  /** how many buildings the wrecking ball has taken — the stock turns over */
  demolished?: number;
  /** books on the market as one ticket — see engine/portfoliosale.ts */
  portfolios?: PortfolioListing[];
  nextPortfolioId?: number;
  v: 34;
  seed: number;
  /**
   * WHICH TOWN THIS WAS PLAYED IN.
   *
   * The island is fixed and the town on it is generated from this number:
   * every block, every lot line, every building. A save without it refers to
   * deeds in a city that no longer exists, so it travels with the game and
   * the city is rebuilt from it on load — six digits instead of two megabytes
   * of parcel table.
   */
  citySeed?: number;
  /**
   * Which island the town was cut on. Named saves need this to Continue after
   * a reload — the seed alone is not an address without the coast it was
   * rolled against. Absent on older saves; those fall back to this browser's
   * last island choice.
   */
  cityIsland?: string;
  /**
   * How big the island was built. The seed alone does not identify a town any
   * more — the same seed at Hamlet and at Great City are different places with
   * different deeds — so this travels with the game for the same reason the
   * seed does. Absent on saves written before sizes existed, which means the
   * standard island, which is what they were.
   */
  citySize?: string;
  /**
   * How built-up the town was generated. Third half of the address: the same
   * island, seed and size at Frontier and at Metropolis are different towns
   * with different deeds. Absent means the standard opening.
   */
  cityDev?: string;
  rng: number;
  /**
   * Named RNG streams so a change in how often leasing rolls the dice does not
   * re-roll the century's rival bids, sales, and construction. Absent on old
   * saves — those keep the single `rng` stream. Keys are RngChannel strings
   * from market.ts (`econ` | `leasing` | `rivals` | `sales` | `dev` | …).
   */
  streams?: Partial<Record<string, number>>;
  month: number;
  cash: number;
  econ: Econ;
  holdings: Record<string, Holding>;
  listings: Listing[];
  lois: LOI[];
  /** Tenants asking mid-lease — see TenantAsk. Optional so old saves load. */
  asks?: TenantAsk[];
  nextAskId?: number;
  leaseReplies?: LeaseReply[];               // the last few answers to your counters
  nextLoiId: number;
  /** Source of tour ids — see LOI.tourId. Letters on one tour share a number. */
  nextTourId?: number;
  /**
   * THE PAYROLL. See staff.ts. `staff` are the people at their desks;
   * `pendingHires` have accepted and are working out their notice; `hirePool`
   * is who is on the market this half-year. All of it is plain data so the
   * save file round-trips like everything else.
   */
  staff?: import("./staff").Staff[];
  /**
   * Stamped once a month by markStaff so leasing, renewals and the operating
   * statement all quote the same desk. See staff.ts.
   */
  leasingOddsMult?: number;
  pmRenewalMult?: number;
  leasingRentMult?: number;
  /** PM desk overload, stamped by markStaff for tenant-care reads without parcels. */
  pmDeskSlip?: number;
  /** How the market reads your hiring history — 0..1, default 0.55. */
  hireReputation?: number;
  /**
   * @deprecated Free capacity dial — ignored. Firm shape emerges from headcount
   * via effectiveOwnerStyle(). Cleared on migrate to v33.
   */
  ownerStyle?: "handsOn" | "delegated";
  /**
   * @deprecated Free capacity dial — ignored. Cleared on migrate to v33.
   */
  benchStyle?: "boutique" | "platform";
  pendingHires?: { staff: import("./staff").Staff; startM: number }[];
  hirePool?: { m: number; band: number; list: import("./staff").Candidate[] };
  nextStaffId?: number;
  /** A generator of its own, so hiring cannot re-roll the economy. See staff.ts. */
  staffRng?: number;
  /**
   * People stream — mortality, principal synthesis, hire life stamps.
   * Seeded `seed ^ 0x50454f50`. Must not step s.rng. See people.ts.
   */
  peopleRng?: number;
  /** The participant the player controls — a Person, seat "you". */
  principal?: import("./people").Person;
  /** Operating principal per living rival firm id. */
  rivalPrincipals?: Record<string, import("./people").Person>;
  /** Ids for non-staff persons (rival principals, heirs). Staff keep nextStaffId. */
  nextPersonId?: number;
  /**
   * Outstanding estate tax after the principal's death. Absent while alive or
   * once paid. See estate.ts — must never set gameOver on its own.
   */
  estateDue?: {
    gross: number;
    tax: number;
    remaining: number;
    deadlineM: number;
    deathM: number;
    decedentName: string;
    elect6166?: boolean;
    installmentMo?: number;
  };
  /** Opening age chosen on the start menu (Phase 5). */
  startAge?: number;
  /**
   * Player fund vehicle — second cash account. Absent = balance-sheet path
   * (the default). See fund.ts / PRINCIPAL_CALLS.md.
   */
  fund?: import("./fund").PlayerFund | null;
  /**
   * When true, new purchases draw equity from the live fund during its
   * investment period. Opt-in path; balance-sheet remains the default until
   * a raise flips this on.
   */
  fundPay?: boolean;
  /**
   * Month the last vehicle failed LPs — the second death. Cleared on
   * succession with the rest of the phone book.
   */
  fundFailedM?: number;
  /**
   * People who left a firm and are waiting to raise. Consumed by maybeNewFirm
   * — the raise can still refuse. See FounderBid / HANDOFF_PRINCIPAL.md.
   */
  founderBids?: FounderBid[];
  /**
   * HOW MANY MONTHS RUNNING NOBODY HAS BEEN AT THE DOOR.
   *
   * Measured over six fifty-year runs of competent play, 69.8% of months had
   * nothing new arrive, the first decade ran at 87%, and the longest silence
   * was 41 consecutive months — because every inbound channel in this engine
   * is gated on the SIZE of your book. This is the counter that lets one
   * channel be gated on the opposite: a broker rings the principal who has
   * money and an empty afternoon. Reset by a letter, an offer, a bid list, an
   * off-market call or a live negotiation — not by a balloon you have known
   * about since spring, which is your own book, not somebody at the door.
   */
  quietMs?: number;
  approaches: Record<string, Approach>;
  /**
   * THE HOUSE POLICY. Applied to every building on the day you close, so a
   * principal with thirty deeds decides how they run buildings ONCE rather
   * than thirty times. Per-building overrides live on the Holding, and are
   * what you reach for when one asset needs different treatment.
   */
  /**
   * `stance` is optional because saves written before it existed do not carry
   * one, and a missing house posture means "market" — which is what every
   * building in those saves is already doing. Widening it is free; defaulting
   * it to anything else would silently reprice somebody's whole book on load.
   */
  opsPolicy?: { service: -1 | 0 | 1; plan: 0 | 1 | 2; stance?: -1 | 0 | 1 };
  /**
   * WHEN EACH BUILDING LAST CHANGED HANDS.
   *
   * refreshListings picked a random parcel with no memory of what had just
   * traded, so a building absorbed by the market came straight back onto the
   * tape. Instrumented over fifty years: 68 E 10th St was "sold to a buyer
   * from out of town" THIRTY-ONE TIMES, 116 W 4th St twenty-nine — the same
   * addresses, sold by nobody to nobody, forever. That is the single loudest
   * reason the news tape reads as a generator rather than as a city.
   *
   * Buildings are held for years. This is the month one last traded, and
   * refreshListings will not put it back on the market until somebody could
   * plausibly have owned it and moved on.
   */
  lastTradeM?: Record<string, number>;
  /**
   * The largest building PLANNED in each class so far this campaign — seeded
   * from the standing stock, so the first two-storey shop of the run does not
   * make the tape. When a groundbreaking beats it, that is a record and the
   * city says so.
   */
  recordPlan?: Record<string, number>;
  /**
   * THE STREET KEEPS ONE SCORE, NOT ONE PER BUILDING. Every broker in a town
   * this size drinks at the same two bars, and a buyer who opens at sixty per
   * cent three times in two years is a story everybody has heard. Insults are
   * stamped with the month they happened and roll off after three years —
   * reputations heal, slowly, the way they do.
   */
  lowballMs?: number[];
  developments: Record<string, Development>;
  /** Signed build-to-suit terms waiting for groundbreak on owned land. */
  btsProspects?: Record<string, BtsCommitment>;
  built: Record<string, BuiltOverride>;      // delivered buildings, yours and the city's
  cityBuilt: string[];                       // bbls the market built, not you
  lastUnsolicitedM?: number;                 // when somebody last rang unbidden
  // A LIVE NEGOTIATION TO BUY. One at a time, like escrow, because that is how
  // many deals a principal is actually working at this size.
  /**
   * EVERY CONVERSATION YOU ARE IN, keyed by BBL.
   *
   * This was one Talks, singular, and negotiate() opened with a hard refusal:
   * "You are mid-negotiation at 42 Pearl St. Finish it or walk away first."
   * Nobody buys buildings that way. A principal is in four conversations at
   * once, drops the two that will not move, and takes whichever of the rest
   * comes back at a number worth funding — the CHOOSING is the job, and the
   * old model deleted it by only ever offering one option.
   */
  talks?: Record<string, Talks>;
  // THE CITY'S OWN SITES. Other people's buildings used to appear finished,
  // the month they were decided, adding their square feet to the market on the
  // spot. Nothing in a city works that way: the decision to build is taken in
  // one market and the building arrives in a different one, and that lag is
  // the entire reason property cycles overshoot. A city job is a hole in the
  // ground with a delivery date, and its space is in the pipeline from the day
  // it starts — visible on the Economy page long before it competes with you.
  // EVERY CRANE IN THE CITY, INCLUDING THE ONES WITH A NAME ON THEM.
  //
  // This was the anonymous city's pipeline. It still is — most jobs belong to
  // nobody in particular — but a developer on the street can now claim one:
  // they buy the dirt, write the equity, carry the construction loan, and own
  // the building on the day it opens. `firmId` is the difference between "a
  // building went up" and "Alden Development Co. got to that corner first".
  cityJobs?: {
    bbl: string; use: string; sf: number; floors: number; startM: number; deliverM: number;
    /**
     * The programme, settled at groundbreak. Shops at grade depend on the final
     * floor count and on the demand score of the day, and the pipeline books
     * square feet by class the month the hole is dug — so the answer is decided
     * once and carried, rather than recomputed at delivery against a city that
     * has moved. Absent on jobs from older saves, which had no ground floor.
     */
    mix?: UseMix;
    /**
     * A ground lessee's frame on YOUR deed. Ordinary city jobs refuse to
     * deliver onto a holding; this one must, because the fee is yours and the
     * leasehold improvement is theirs until reversion.
     */
    groundLease?: boolean;
    firmId?: string;      // whose job it is; absent means the anonymous city
    cost?: number;        // the budget, for a firm's job
    spent?: number;       // work in place to date
    equityLeft?: number;  // their equity still to go in
    debt?: number;        // construction balance, drawn plus capitalised interest
    commitment?: number;  // hard construction-loan ceiling
    ratePct?: number;
    /** Which desk wrote it. See pickConstructionDesk — they borrow where you do. */
    lender?: string;
    /**
     * Their bank was seized and their draws stopped, same as yours. A rival
     * carries it out of their own account or the contractor walks off, and a
     * frame that stops is a frame that goes on the tape — which is why a bank
     * failure is the best buying window in the game and always was.
     */
    repudiatedM?: number;
    replaceM?: number;
    orphaned?: boolean;   // the sponsor died and the frame is standing there
    listedM?: number;     // when the receiver put the frame on the tape
  }[];
  // Named starts owed back against the city's calibrated build rate — see
  // tickCityGrowth. A month with two rival groundbreakings is followed by
  // quiet ones, so the town grows at the pace its vacancy supports.
  startDebt?: number;
  // ASSEMBLAGE. Child parcel -> the lot it has been merged into. The child
  // keeps its deed and its shape on the map; its land area, its value and its
  // buildable envelope have all moved to the parent, which is what assembling
  // a site actually does. See actions.assembleLots.
  merged?: Record<string, string>;
  // GROUND LEASES you have granted on your own dirt, by parcel.
  groundLeases?: Record<string, GroundLease>;
  /**
   * GROUND LEASES ON FEES YOU NO LONGER OWN.
   *
   * Selling (or losing) a leased fee does not cancel the lease — the buyer
   * takes the coupon and the reversion. We do not simulate the NPC fee owner's
   * cash, but the encumbrance stays here so the site cannot reappear as
   * freehold inventory or get torn down under the lessee until the term ends.
   */
  cityGroundLeases?: Record<string, GroundLease>;
  // ZONING MOVES. A district's envelope multiplier, an extra FAR you won at a
  // hearing on one site, an application waiting on the board, and the
  // buildings nobody is allowed to knock down. See engine/zoning.ts.
  zoneAdj?: Record<string, number>;          // district -> FAR multiplier
  /** the last rezoning each district saw — month, direction, and where the envelope landed. A value event you can read, not just a news line that scrolled away. */
  zoneLog?: Record<string, { m: number; dir: 1 | -1; adj: number }>;
  variance?: Record<string, number>;         // bbl -> extra FAR granted
  /**
   * WHAT THE BOARD SAID, and when.
   *
   * A hearing is a year of your life and several hundred thousand dollars, and
   * the answer used to arrive as one line of news that scrolled away in a
   * quarter. It is a fact about the site now: recorded on the parcel and shown
   * on the land panel for years afterwards, the way a refusal actually sits
   * over a property while everybody waits for the board to change its mind.
   */
  varianceLog?: Record<string, { m: number; granted: boolean; far: number; cost: number }>;
  /** Pending hearings keyed by property; separate sites may run concurrently. */
  varianceApps?: Record<string, VarianceApplication>;
  /** @deprecated legacy single-application save; migrated on the next filing/tick. */
  varianceApp?: VarianceApplication;
  landmarks?: Record<string, number>;        // bbl -> month designated
  landAdj: Record<string, number>;           // per-parcel land value multiplier
  // THE DEMAND SURFACE. `blockD` is the live offset every economic reader uses;
  // it is the SUM of the two things below and is the only one anybody outside
  // engine/demand.ts should touch.
  blockD: Record<string, number>;            // per-block demand offset, in points off the generated score
  /** the day-one reconciliation between what is standing and what gravity said. PERMANENT. */
  blockA?: Record<string, number>;
  /** the emergent drift since 2000: what has been built, who is hiring, what opened. */
  blockE?: Record<string, number>;
  /** a block's employment advantage in demand points — its trades against the city's */
  blockJ?: Record<string, number>;
  /**
   * Civic works. A station, a park, a bridge — rumoured first, argued over,
   * funded, opened; the ground reprices at each step, and buying on the rumour
   * is the oldest trade in the business. `kind`/`rumorM`/`sigma` are absent on
   * saves from before the rumour stage existed: those events load as already-
   * announced stations and behave exactly as they always did.
   */
  lines?: { id: string; cx: number; cy: number; name: string; annM: number; openM: number; pts: number;
    kind?: "station" | "park" | "bridge"; rumorM?: number; sigma?: number }[];
  /**
   * THE FORTUNES OF THE NEIGHBOURHOODS.
   *
   * A polycentric town starts with three or four centres of roughly equal
   * standing and does not end that way. One of them becomes the address and
   * the others become somewhere you used to be able to buy — and which one it
   * is was not knowable at the start, only guessable, and then only by
   * somebody paying attention early.
   *
   * `drift` is that centre's hidden long-run trajectory, drawn once at the
   * start of the campaign and never shown. `level` is where it has actually
   * got to, which is drift plus everything that has happened since. Early on
   * the noise is larger than the drift, so a centre that is up in year five
   * tells you very little; by year twenty-five the drift has accumulated and
   * the noise has not, and the answer is obvious to everybody — which is far
   * too late to buy it.
   */
  poles?: { cx: number; cy: number; r: number; drift: number; level: number; name: string }[];
  // What the lending market remembers about you. A sponsor who hands back keys
  // does not get to walk into the next credit committee unrecognised.
  sponsor: { events: SponsorEvent[] };
  rivals: Rival[];                           // the other firms on the street
  /** What has passed between you and each firm. See StreetTie. */
  street?: Record<string, StreetTie>;
  /** Corners the street took off you, newest first, capped at 24. */
  beaten?: Beat[];
  /** The desks, with books you can open. See engine/lenders.ts. */
  lenders?: Lender[];
  /**
   * THE MORTGAGE RECORD — every loan a desk holds against a deed in this
   * town, keyed by BBL. Built and reconciled by engine/ledger.ts; the note
   * desk sells out of it and the bank statement on Research is a view of it.
   */
  cityLoans?: Record<string, CityLoan>;
  /** Book-weighted appetite of the live desks — the banking system in one number. */
  bankApp?: number;
  /** Loans in default and what is being done about them. See engine/workout.ts. */
  workouts?: Record<string, Workout>;
  /**
   * WHAT THE NAMED PRIVATE HOLDERS THINK OF YOU. An insult is filed against the
   * HOLDER, not the building, so a family with four corners closes all four.
   * This is the half that must be saved, because it is the only part of the
   * register that is not a pure function of the deeds.
   */
  holderRel?: Record<string, import("./owners").HolderRel>;
  /**
   * The month a named holder left the market, so nobody's estate is settled
   * twice. See tickHolders.
   */
  holderExit?: Record<string, number>;
  /**
   * ONE LOAN, MANY DEEDS. Absent until the player papers one, and there is at
   * most one at a time — a second facility would be a second first lien on the
   * same collateral, which is not a thing. See engine/facility.ts.
   */
  facility?: Facility;
  /** Loans you have bought. Servicing is automatic. See engine/notes.ts. */
  notes?: Note[];
  /** Paper on the market this month. Three at most, and they expire. */
  noteOffers?: NoteOffer[];
  nextNoteId?: number;
  /**
   * RIVALS ASKING YOU FOR HARD MONEY. Shortlist, expires — same choreography
   * as note offers. See engine/privateCredit.ts and PRIVATE_CREDIT.md.
   */
  privateAsks?: PrivateCreditAsk[];
  nextPrivateAskId?: number;
  /**
   * HARD-MONEY OFFERS TO YOU. Shortlist, expires — when banks refuse or
   * hold-cap a takeout. See engine/privateCredit.ts Phase B.
   */
  privateBorrowQuotes?: PrivateBorrowQuote[];
  nextPrivateBorrowId?: number;
  /**
   * PAPER YOU PASSED ON.
   *
   * An offer that expires unbought is taken by somebody with money, and
   * fourteen months later the deed moves. Three fields, one line of news at
   * each end, and the expiry window on an offer suddenly means something.
   */
  rivalNotes?: { bbl: string; firmId: string; firm: string; takeM: number; face: number }[];
  /**
   * THE JULY AUCTION. Docket published when the tick lands on July; the hammer
   * falls on the August tick, so the player holds the flyer for exactly one
   * month — long enough to register bids, never long enough to become a chore.
   * See engine/auction.ts.
   */
  auction?: { m: number; lots: AuctionLot[]; deposit: number };
  /** Sales the banks have noticed on the street — the pipeline into July. */
  bankFcls?: BankForeclosure[];
  /** A bundle of buildings in the market as one trade. See engine/portfolio.ts. */
  portfolioSale?: PortfolioSale;
  /** Your firm's name, and what the city has worked out about it. See engine/firm.ts. */
  firm?: FirmIdentity;
  /** Buildings you have put up. Drives the "builder" epithet. */
  delivered?: number;
  lenderRel: Record<string, number>;         // lender name -> relationship 0-100; a trusted name is worth basis points
  totalLots: number;
  builtAtStart: number;
  // a 1031 exchange in flight: sale gain rolled, tax deferred until the clock runs out
  exchange: { deferredTax: number; rolledGain: number; minPrice: number; deadlineM: number } | null;
  taxesPaid: number;
  // Leasing agent on retainer: signs every LOI for you at a 6% commission
  // instead of the 4%/2% you'd pay doing it yourself.
  agent: boolean;
  /**
   * YOUR IN-HOUSE LEASING TEAM HAS THE PEN.
   *
   * Separate from `agent` (the 6% outside firm). When this is on and you have
   * at least one leasing hire, they sign/counter/pass inside your mandate at
   * the ordinary 4%/2% rates and LOIs stop interrupting — same quiet desk as
   * the firm agent, your people instead of theirs. Off by default so hiring
   * staff alone does not silently take the book; you hand it over on Leasing.
   */
  teamLeasing?: boolean;
  /**
   * WHAT THE DESK DID THIS MONTH while you were quiet.
   *
   * When the firm agent, your team, or an exclusive holds the pen, letters stop
   * interrupting you — only referrals do. Without a scorecard a quiet month
   * looks identical to a desk that is turning everyone away. Counts roll with
   * `m`; readers treat a stale month as empty.
   */
  deskMonth?: {
    m: number;
    signed: number;
    passed: number;
    referred: number;
    walked: number;
    countered: number;
  };
  /**
   * PROPERTY MANAGEMENT HAS THE RENEWALS, at the 2% the roll already pays.
   *
   * Narrower than `agent` above and deliberately so. The agent takes the whole
   * book at 6% and signs everything, including the new leases — which is the
   * interesting half, where you trade term for allowance and decide whether a
   * covenant is worth a discount. This hands over only the RENEWALS: the sitting
   * tenant, the paper that rolls whether you are paying attention or not.
   *
   * The 2% is not a new number. `leaseCosts` has always priced a renewal at 2%
   * against a new lease's 4%, because a renewal is genuinely less work — no
   * fit-out to negotiate, no tour, no covenant to underwrite. Engaging the desk
   * does not change the commission; it changes who does the signing.
   *
   * The trade is a real one: a manager signs AT the market and never above it,
   * so an owner who works their own renewals still beats one who does not — they
   * just have to be there when the letter arrives.
   */
  renewalMgmt?: boolean;
  /**
   * THE MANDATE YOU GAVE THE DESK — see agentPolicy in leasing.ts.
   *
   * `agentFloor` is the lowest net-effective share of market they may AUTO-
   * SIGN. Below that and above `agentPassBelow` they refer the letter back to
   * you; under the pass line they kill it. Undefined fields keep the defaults
   * in leasing.ts so older saves stay coherent.
   */
  agentFloor?: number;
  /** Auto-pass (kill) letters scoring under this share of market. */
  agentPassBelow?: number;
  /** Minimum tenant credit the desk may auto-sign (0 any · 1 solid · 2 strong). */
  agentMinCredit?: Credit;
  /**
   * Cap on fit-out the desk may fund, as months of face rent
   * (`tiPsf / rentPsf * 12`). Undefined = generous default in leasing.ts.
   */
  agentMaxTiMonths?: number;
  /**
   * Cap on total upfront leasing cash (TI + commission), expressed as months
   * of the letter's face rent. Prevents long-term commission plus TI packages
   * from clearing a TI-only mandate.
   */
  agentMaxSigningMonths?: number;
  /** The player told the brokers to stop ringing. Nothing else changes. */
  brokersOff?: boolean;
  /**
   * THE HOUSE BROKERS' MEMORY. Three named shops per campaign; every closing
   * pays a fee through the shop that had the seller's ear, and a shop that has
   * earned enough of your fees starts ringing you before the tape. Looks you
   * let lapse count against you; going quiet for years fades the score.
   */
  brokerRel?: Record<string, { name: string; fees: number; lastFeeM: number; ignores: number }>;
  /**
   * The player does not want the July docket thrown in their face. The auction
   * still happens, on the same day, with the same lots — this only stops the
   * card. The docket is on Marketplace either way, and so is the switch.
   */
  auctionQuiet?: boolean;
  /** Last docket's outcomes on lots you bid on. Cleared once read. */
  auctionResults?: { m: number; rows: AuctionResultRow[] };
  // Revolving line against the portfolio: 35% of net worth at index + 400bps.
  loc: { balance: number; drawnTotal: number; interestPaid: number };
  books: BooksYear[];                        // the ledger, one entry per year
  /** Monthly flow buckets for the income statement's month view. Optional for old saves. */
  booksMonthly?: BooksMonth[];
  /** December balance-sheet stamps — one per game year. Optional for old saves. */
  balanceHistory?: BalanceSnapshot[];
  nwHistory: number[];                       // net worth at each month, for the chart
  /** Last month's gross asset value — overhead sizes off this so the tick does not appraise twice. */
  prevGav?: number;
  exits: Exit[];                             // every disposition, forced or chosen
  milestones: Record<string, number>;        // milestone id -> month achieved
  /** Permanent per-deed events, capped per BBL by engine/history.ts. */
  propertyLog?: Record<string, PropertyEvent[]>;
  // Every deed that has moved in this city, with the price. See comps.ts —
  // an appraisal is an opinion and a closed sale is a fact.
  comps?: Comp[];
  /**
   * Lifetime closed-print count. The rolling `comps` buffer is capped for the
   * sheet UI; this counter is not, so a century report can tell cumulative
   * trade volume from the last 240 stamps.
   */
  compsTotal?: number;
  /** Lifetime closed consideration (nominal $). Same reason as `compsTotal`. */
  compsVolume?: number;
  news: NewsItem[];
  /**
   * UNREAD interruptions. The engine pushes; the UI shifts them off as it
   * shows them. Optional because a save written before any of this existed has
   * to keep loading, and because a run in which nothing extraordinary happens
   * should carry no field at all.
   */
  alerts?: Alert[];
  nextAlertId?: number;
  /** Every level event this city has had, oldest first. See SwanRecord. */
  swanLog?: SwanRecord[];
  gameOver: { cause: string; complete?: boolean } | null;
  insolventMs: number;
  /** Months with cash below zero this run — never reset by a seizure. */
  underwaterMs?: number;
  locOverMs?: number;
}

// Write a cash flow into the current year's ledger bucket — and the month's.
export function logBooks(s: GameState, key: keyof Omit<BooksYear, "yr">, amt: number) {
  if (!s.books) s.books = [];
  const yr = Math.floor(s.month / 12);
  let e = s.books[s.books.length - 1];
  if (!e || e.yr !== yr) {
    e = {
      yr, noi: 0, debtSvc: 0, leasing: 0, capex: 0, dev: 0, taxes: 0,
      bought: 0, sold: 0, ga: 0, interest: 0, borrowed: 0, lpCalled: 0, lpDistributed: 0,
    };
    s.books.push(e);
  }
  e[key] = ((e[key] as number) ?? 0) + amt;
  // MONTHLY TOO. The year bucket answers "how did the firm do this year"; the
  // month bucket answers "what just happened". Dual-write keeps them on the
  // same dollars without a second call site at every cheque.
  if (!s.booksMonthly) s.booksMonthly = [];
  let me = s.booksMonthly[s.booksMonthly.length - 1];
  if (!me || me.m !== s.month) {
    me = {
      m: s.month, noi: 0, debtSvc: 0, leasing: 0, capex: 0, dev: 0, taxes: 0,
      bought: 0, sold: 0, ga: 0, interest: 0, borrowed: 0, lpCalled: 0, lpDistributed: 0,
    };
    s.booksMonthly.push(me);
    while (s.booksMonthly.length > 48) s.booksMonthly.shift();
  }
  me[key] = ((me[key] as number) ?? 0) + amt;
}

/**
 * DEEP-CLONE GAME STATE. Prefer `structuredClone` (same semantics, faster than
 * JSON round-trip). Falls back so older hosts still work. Every action path
 * that used to say `JSON.parse(JSON.stringify(s))` should call this instead —
 * one quantity, one implementation.
 */
export function cloneState<T>(s: T): T {
  if (typeof structuredClone === "function") return structuredClone(s);
  return JSON.parse(JSON.stringify(s)) as T;
}

/**
 * A NEGOTIATION IN PROGRESS.
 *
 * Buying used to be one roll of a die: you named a number, an invisible seller
 * rolled against it, and a refusal told you nothing and left you nothing to do
 * except name another number and roll again. There was no counterparty in the
 * room and no way to read one.
 *
 * A negotiation is a conversation with a state: their number, your number, how
 * many times you have been round, and how much patience is left. You can see
 * the gap closing or not closing, which is the whole skill.
 */
export interface Talks {
  bbl: string;
  sellerKind: SellerKind;
  sellerName: string;
  yourPrice: number;       // your last offer
  theirPrice: number;      // their last counter — their ask, until they move
  round: number;           // how many times you have been back
  maxRounds: number;       // what this seller will tolerate
  openedM: number;
  final?: boolean;         // they have said take it or leave it
  /**
   * HOW MANY TIMES YOU HAVE COME BACK WITH THE SAME NUMBER.
   *
   * `round` counts the conversation; this counts the part of it where you said
   * nothing new. A seller reads a repeated offer as what it is — a buyer who is
   * not negotiating but waiting to be worn down — and the concession machinery
   * has no way to notice that without it. See `stallRisk` in acquire.ts.
   */
  stalls?: number;
  note: string;            // what they said, in words
  // UNDER CONTRACT. A price is agreed and nothing has moved yet: the deed is
  // reserved, the property is off everybody else's tape, and you have until
  // `closeByM` to place the debt and fund the equity. This is the whole reason
  // the negotiation no longer asks for a lender — you do not arrange financing
  // to make an offer, you arrange it because you have a deal.
  agreed?: boolean;
  agreedPrice?: number;
  closeByM?: number;
  /**
   * EARNEST MONEY, AND IT IS HARD.
   *
   * The expiry notice already said the seller "kept the deposit's worth of
   * goodwill" — describing a deposit that did not exist. Nothing was ever
   * posted, so signing a contract cost nothing and failing to fund one cost
   * nothing either, which is the whole reason you could not be trusted with
   * more than one at a time: the game had to stop you at the door because it
   * had no way to make the consequence real once you were through it.
   *
   * Post it and both problems go away. You can chase four buildings at once,
   * as anybody in this business does — and you can only sign what you can put
   * money behind, and only fund what you can actually fund. It is credited at
   * closing and gone if the clock runs out.
   */
  deposit?: number;
}

/**
 * WHAT YOU START WITH, AND IT IS A CHOICE NOW.
 *
 * The game shipped one number, $6M, which made the opening the same opening
 * every time. These three are different games rather than three difficulty
 * settings, which is the distinction CLAUDE.md draws: the money does not scale
 * anything, it decides how many mistakes you get before overhead eats you.
 *
 * The scale that makes them mean something: firm overhead measured $57K/yr at
 * the start and $131K by year seventeen, and a small building trades around
 * $0.5-2.5M. So $1M is one building outright or two levered with almost no
 * reserve; $5M is a real first fund with room to be wrong once. $10M and $20M
 * are institutional openings: enough to begin with a diversified book, but
 * still finite capital rather than a sandbox. An idle firm with $6M went
 * insolvent in year fifteen on overhead alone — at $1M it has closer to five,
 * which is why this is a starting choice and not a slider.
 */
export const START_CASH_CHOICES = [
  1_000_000,
  2_500_000,
  5_000_000,
  10_000_000,
  20_000_000,
] as const;
export type StartCash = (typeof START_CASH_CHOICES)[number];
export const DEFAULT_START_CASH: StartCash = 2_500_000;
/** @deprecated the opening bankroll is chosen — see START_CASH_CHOICES. */
export const START_CASH = DEFAULT_START_CASH;
/**
 * THE CALENDAR HAS TO AGREE WITH THE PRICE TABLE.
 *
 * Reported: office rents reaching $2,000/sf by 2060. Measured over five seeds
 * at year 60 the quoted office rent runs $258-721 median and $386-1,122 at the
 * top — so $2,000 is the tail rather than the middle, but the direction of the
 * complaint is right and the reason is not the rent model.
 *
 * IN REAL TERMS THE MODEL IS CORRECT. Deflated by the engine's own CPI, the
 * dearest office in town at year 60 runs $111-220/sf across those seeds, which
 * is exactly where prime office sits in life. Real growth is about 1.2% a year
 * and inflation is 2-3%. Neither is aggressive; sixty years of compounding is.
 *
 * Every constant in this engine is calibrated against OBSERVED 2024 data and
 * says so — RENT_BASE cites JLL 2024 and Providence Class A asks, HARD_COST
 * cites current build costs. The campaign clock nevertheless opens in January
 * 2000: that is the fiction the game is written in (a century from the
 * millennium, the package README, the century harnesses). Nominal dollars are
 * therefore today's market wearing a 2000 date — a known labelling tension,
 * kept because the owner wants the century to read 2000→2100 and every stray
 * `2000 + month/12` copy in the tree agrees. Age maths and the month label
 * both read this single constant.
 *
 * Saved games carry a month index, not a year, so they reopen fine — the same
 * month simply prints against whatever START_YEAR is now.
 */
export const START_YEAR = 2000;
/**
 * WHAT A BANK BALANCE EARNS. One per cent a year, on positive balances, for
 * everybody in this city — you and every firm on the street.
 *
 * It used to float with the loan index, two and a half points under it, which
 * was defensible and wrong for what this game is about: in a high-rate decade
 * the safest position in the model quietly became one of the best, and the
 * player who did nothing compounded against the player who underwrote. A flat,
 * unexciting deposit rate is the point. Cash is a place to stand between
 * decisions, not a position — and the whole thesis of owning buildings is that
 * a bank account does not keep up.
 */
export const CASH_APY = 0.01;

/**
 * THE CAPITAL PLAN, as a share of gross asset value a year.
 *
 * Roofs, lifts, plant, the things that do not appear in an operating statement
 * and do not stop needing doing. It is charged automatically, every month, on
 * every building, because no owner writes this cheque one line item at a time
 * and asking the player to would be a chore rather than a decision. It lands on
 * the existing `capex` line in the Books.
 *
 * It is deliberately NOT enough on its own to hold an old building level. It
 * buys you time; the programmes in dev.ts buy you a grade. That is the whole
 * shape of the decision — the plan is the floor, the programme is the choice.
 */
export const CAP_PLAN_RATE = 0.0034;

/**
 * THE SERVICE LEVEL, and why it is a decision rather than a chore.
 *
 * One choice per building, never asked about again. `opex` multiplies the
 * CONTROLLABLE half of the operating bill only — the fixed half (insurance,
 * the rates, the lift contract) does not care how well you run the place.
 * Measured against the actual owned book that is -1.2% of NOI at Lean and
 * +2.1% at Institutional: almost nothing.
 *
 * `aim` is where svcIdx settles, and svcIdx is where the money actually goes —
 * into whether tenants renew. A landlord who takes a point of NOI back off the
 * cleaning contract and loses a floor to it has made the oldest mistake in
 * this business, and until now the game could not represent it.
 */
export const OPS_SERVICE = [
  { key: -1 as const, label: "Lean", opex: 0.90, aim: 0.22,
    blurb: "the lease minimum and no more — a point of NOI back, and the tenants notice within three years" },
  { key: 0 as const, label: "Market", opex: 1.00, aim: 0.55,
    blurb: "what a competent third-party manager delivers" },
  { key: 1 as const, label: "Institutional", opex: 1.12, aim: 0.90,
    blurb: "staffed, answered and immaculate — two points of NOI, and it keeps the covenants you want" },
];
export function serviceSpec(v?: -1 | 0 | 1) { return OPS_SERVICE[(v ?? 0) + 1]; }

/**
 * THE CAPITAL PLAN, ON A DIAL.
 *
 * `mult` is what you spend against CAP_PLAN_RATE; `lift` is what it buys,
 * in multiples of the month's wear. Fund at 1.15 is a shade ahead of decay,
 * which is what a properly funded reserve does and what this engine already
 * did before there was a choice — so the default changes nothing. Reposition
 * costs 1.8x and lifts 1.75x, deliberately sub-linear: the first dollar of
 * capital buys the most, and turning a building round through the reserve is
 * the slow, expensive way to do it. The sharp instrument is a programme.
 *
 * Deferring is free and it is sometimes right — for a three-year flip, for a
 * building you are emptying for demolition, for a month when the bank is on
 * you. It is ruinous over a twenty-year hold. That is the entire decision, and
 * it is the first time hold period has been a strategic variable.
 */
export const OPS_PLAN = [
  { key: 0 as const, label: "Defer", mult: 0, lift: 0,
    blurb: "nothing goes back in — free today, and the building goes off" },
  { key: 1 as const, label: "Fund", mult: 1, lift: 1.15,
    blurb: "roofs, lifts and plant on schedule — holds the line" },
  { key: 2 as const, label: "Reposition", mult: 1.8, lift: 1.75,
    blurb: "ahead of the wear — a grade back over a decade, at nearly twice the money" },
];
export function planSpec(v?: 0 | 1 | 2) { return OPS_PLAN[v ?? 1]; }

/** How fast tenants notice a change of service. 0.022/month is a 31-month half-life. */
export const SVC_SPEED = 0.022;
export const SVC_START = 0.55;
// The century is a MILESTONE, not a wall. A hundred years used to end the run
// on the spot, which turned the back half of a good campaign into a countdown
// and threw away the most interesting book in the game the moment it was
// finished being built. The clock keeps running; the century is something you
// pass, and the ledger closes when you lose it or choose to stop.
export const CENTURY_MONTHS = 1200; // Jan 2000 to Jan 2100

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(m: number): string {
  return `${MONTH_NAMES[((m % 12) + 12) % 12]} ${START_YEAR + Math.floor(m / 12)}`;
}

/**
 * The first July at least `minGap` months after `m`. Foreclosure sales do not
 * happen when the process finishes; they happen when the county holds its
 * sale, and the county holds one sale a year. (July is month index 6.)
 */
export function nextJulyAfter(m: number, minGap: number): number {
  const earliest = m + minGap;
  const intoYear = ((earliest % 12) + 12) % 12;
  return intoYear <= 6 ? earliest + (6 - intoYear) : earliest + (18 - intoYear);
}

/**
 * A LOAN THAT HAS STOPPED WORKING, and the conversation that follows.
 *
 * A default used to be an event: the balloon came due, you could not pay, the
 * building was sold at a distress price in the same tick and it went on your
 * record. That is the ENDING of a foreclosure, not a foreclosure — everything
 * interesting about being in trouble happens in the eighteen months before it,
 * across a table, with a lender who has their own problems.
 */
/**
 * A LOAN SOMEBODY IS SELLING, and the reason they are selling it.
 *
 * Nothing here is generated for the player's benefit. A desk brings paper to
 * market because it has stopped paying, or because the desk needs the capital
 * more than it needs the asset — and both of those are numbers you could have
 * read on the Research page a year earlier. See engine/notes.ts.
 */
export interface NoteOffer {
  id: string;
  bbl: string;
  address: string;
  lender: string;          // the desk selling it, and whose problem this is
  obligorId: string;       // whose loan it is
  obligor: string;
  face: number;            // unpaid principal
  ratePct: number;
  maturityM: number;
  perf: "performing" | "nonperforming";
  askPct: number;          // of face — the whole trade is in this number
  cure: number;            // the desk's own read on whether it gets repaid, 0-1
  offeredM: number;
  expiresM: number;
  why: string;             // why this desk is selling, in words
}

/**
 * PAPER YOU OWN.
 *
 * A claim on somebody else's rent, secured by a building you do not own and
 * cannot manage. It pays a coupon into your cash every month with no screen
 * and no button; it speaks to you exactly twice, when it stops paying and when
 * it resolves.
 */
export interface Note {
  id: string;
  bbl: string;
  address: string;
  originator: string;      // whose book it came off
  obligorId: string;
  obligor: string;
  face: number;
  ratePct: number;
  maturityM: number;
  perf: "performing" | "nonperforming";
  boughtM: number;
  basis: number;           // what you paid, which is what it carries at
  collected: number;       // coupon received to date
  mods: number;            // times you have modified it; one is the limit
  /**
   * YOU WROTE THIS PAPER. Not bought off a bank — originated from the private
   * credit sleeve. Maturity / sale payoff must clear the rival's debt and the
   * cityLoans row; purchased notes already left the bank ledger at buy.
   */
  privateOriginated?: boolean;
  /**
   * MISSED COUPON, ACCUMULATING. From the month it stops paying, the coupon it
   * is not paying piles up here — and it is a real claim: a borrower who
   * reinstates pays it all, with a penalty, and a sale that clears above the
   * principal owes you this on top before the borrower sees a cent.
   */
  arrears?: number;
  filedM?: number;         // you have filed to foreclose
  saleM?: number;          // the July it crosses the block — see engine/auction.ts
  /** The month it last told you something, so it cannot tell you twice. */
  toldM?: number;
}

/**
 * A RIVAL WANTS YOUR MONEY. Hard-money bridge — not a permanent bank product.
 * See PRIVATE_CREDIT.md.
 */
export interface PrivateCreditAsk {
  id: string;
  rivalId: string;
  rivalName: string;
  bbl: string;
  address: string;
  face: number;
  ratePct: number;
  /** Origination fee as a share of face — cash to you at close. */
  points: number;
  termM: number;
  ltv: number;
  asIs: number;
  why: string;
  offeredM: number;
  expiresM: number;
}

/**
 * A RIVAL (OR CORDAGE-LIKE DESK) WILL LEND TO YOU. Mirror of PrivateCreditAsk
 * with the obligor flipped — closes into Holding.loan so tickLoan / workouts
 * already apply. See PRIVATE_CREDIT.md Phase B.
 */
export interface PrivateBorrowQuote {
  id: string;
  lenderId: string;
  lenderName: string;
  bbl: string;
  address: string;
  principal: number;
  ratePct: number;
  /** Origination fee as a share of principal — keeps with the lender. */
  points: number;
  termM: number;
  ltv: number;
  asIs: number;
  why: string;
  offeredM: number;
  expiresM: number;
}

/**
 * A LOAN ON THE PUBLIC RECORD. Not yours — the street's. One row per
 * mortgaged rival building: who wrote it, what is owed, what the collateral
 * appraised for the day it was written. The balance is reconciled monthly
 * against the borrower's aggregate debt, so the record and the street table
 * cannot disagree. See engine/ledger.ts.
 */
export interface CityLoan {
  bbl: string;
  lender: string;
  obligorId: string;
  balance: number;
  ratePct: number;
  originM: number;
  maturityM: number;
  /** The appraisal at origination — LTV-then against LTV-now is the statement's whole story. */
  origValue: number;
  /** Asset class at origination, for the concentration ledger. */
  klass: string;
  status: "current" | "watch" | "workout";
}

export interface Workout {
  bbl: string;
  lender: string;
  startM: number;
  /** notice -> the clock is running; forbearance -> you bought time; foreclosure -> they have filed. */
  stage: "notice" | "forbearance" | "foreclosure";
  cause: "balloon" | "covenant" | "arrears";
  /** What has to be paid, or the loan balance if it is the whole thing. */
  cure: number;
  /** The month it is decided one way or the other. */
  decideM: number;
  /** How many times you have been to them about this building. */
  asks: number;
  /**
   * KEEPING IT CURRENT OUT OF THE OTHER BUILDINGS.
   *
   * A maturity default where the borrower keeps paying is the commonest
   * situation in commercial real estate and it almost never goes to the steps:
   * the lender has a performing loan they would rather not own, the borrower
   * has income elsewhere, and the two of them let it run month to month while
   * a refinancing or a sale is arranged. That is what this flag is. It costs
   * the ordinary payment plus default-rate interest, it holds the clock only
   * while the cheque actually clears, and it stops working the moment they
   * file — once it is with the court a payment is not a cure, the arrears are.
   */
  servicing?: boolean;
  /** Months the player has held it off this way, for the news and the panel. */
  servicedMs?: number;
  missedMs: number;
  /** They have noticed the sale: the July your building crosses the block. */
  saleM?: number;
  /**
   * DEFAULT-RATE INTEREST, ACCRUING. An accelerated loan is not serviced — the
   * cheque stops and the meter runs against the collateral instead, which is
   * why the credit bid in July is bigger than the balance you remember.
   */
  accrued?: number;
}

/**
 * ONE LOT ON THE JULY DOCKET.
 *
 * A completed foreclosure does not hand anybody a deed. It produces a sale —
 * once a year, in July, on the courthouse steps, everything in the county that
 * has finished the process crosses the block together. The noteholder credit-
 * bids up to what it is owed; cash bids above that pay the noteholder off in
 * full and take the building; anything above the debt goes to the borrower who
 * just lost it, because that is the law.
 */
/** One line of what the hammer did to a number you registered. */
export interface AuctionResultRow {
  bbl: string;
  address: string;
  /** won · outbid · paidoff (your debt cleared) · nocash · pulled · lostyours */
  outcome: "won" | "outbid" | "paidoff" | "nocash" | "pulled" | "lostyours";
  yourBid: number;
  price: number;
  winner?: string;
  note?: string;
}

export interface AuctionLot {
  id: string;
  bbl: string;
  address: string;
  /**
   * note        — you hold the mortgage; your debt is the credit bid.
   * bank        — a lender foreclosing on somebody on the street.
   * receiver    — a dead firm's building, sold for whatever it brings.
   * yours       — YOUR building; your lender is the one credit-bidding.
   */
  kind: "note" | "bank" | "receiver" | "yours";
  /** Everything owed: principal, arrears, legal. The credit-bid ceiling. */
  debt: number;
  /** Who is foreclosing — a lender name, a receiver, or your own shop. */
  holder: string;
  borrowerId?: string;
  borrower?: string;
  noteId?: string;          // kind "note": which of your notes this settles
  /** The referee's minimum. Below this the lot is struck to the foreclosing party. */
  upset: number;
  /** What the flyer says it might be worth, as-is. No diligence, no warranty. */
  est: number;
  /** Your registered bid, if any. Ten per cent is down the day you register. */
  yourBid?: number;
}

/**
 * A LENDER'S FILE ON SOMEBODY ELSE. A bank that has run out of patience with a
 * firm on the street notices a sale; the borrower has until the July auction
 * to catch up, and most of the ones who recover do — which is why watching
 * this list is not the same as owning it.
 */
export interface BankForeclosure {
  bbl: string;
  lender: string;
  firmId: string;
  firm: string;
  debt: number;
  noticedM: number;
  saleM: number;
}
