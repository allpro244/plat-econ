// THE OTHER FIRMS ON THE STREET.
//
// Until now the market was a statistical process. Listings appeared from
// nowhere, an anonymous city built itself, and invisible buyers took deals out
// from under you with a line of news that said "another buyer". There was
// nobody to lose a deal TO, nobody whose overreach caused the crash, and
// nobody who wanted your corner because it finished their assemblage.
//
// So: five or six named firms with balance sheets. They own real parcels. They
// work the same tape you do, and their appetite is their dry powder times the
// credit window — which means in a boom you are bidding against people with
// too much money, and in a crunch you are the only bid in the room. They lever
// up when money is cheap because that is what wins in the short run, and the
// ones who levered hardest are the ones whose portfolios hit the tape at
// sixty cents when the window shuts.
//
// What is deliberately NOT modelled: rent rolls, per-asset loans and tenants
// for each firm. A rival carries an aggregate balance sheet and a list of what
// it owns. That is enough to compete, to fail, and to be read — and it keeps
// the save file the size of a save file.
//
// DEVELOPMENT IS MODELLED, because leaving it out made a liar of this file.
// Three of these firms are called developers and the style table said "buys
// dirt and puts buildings on it; the city's growth is partly theirs" — and
// then they only ever bought. Nobody could beat you to a site, no competitor's
// tower ever rose across the street and emptied your building, and no
// half-finished job ever came to market because its sponsor could not roll the
// construction loan, which is the best deal in the business. A developer here
// now claims jobs out of the city's own pipeline: buys the dirt, writes the
// equity, carries the loan through the cycle, and either owns a building at
// the end of it or hands a frame to a receiver.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { BuiltClass, Condition, DevUse, FounderBid, GameState, Rival, RivalStyle } from "./types";
import { CASH_APY, monthLabel, START_YEAR } from "./types";
import { rng, newsChance, rrange, frictionFloor, NATURAL_VAC, addStock, CITY_STOCK } from "./market";
import { assetValue, demandLinear, initialCondition, inPlace, landValue, noiAfterTaxYr, occupancy, resolveRec, worthTheCall } from "./value";
import type { DevPlan } from "./dev";
import { cityInfillCap, devMix, dominantOf, farMaxFor, MAX_FLOORS_BY_USE, retailWantsMixed, underwriteDevelopment, useForZone, noteRecordPlan, openConstructionDesks } from "./dev";
import { CONSTRUCTION_LENDER, chargeLenderLoss, lenderByName, lenderPressure, reoAsk } from "./lenders";
import { streetRefiProceeds, productById, stabViewFor } from "./debt";
import { stampApproach } from "./leasing";
import { deskWillExtend, extensionFeePct, extensionMonths, NOTICE_M, FORECLOSE_M } from "./workout";
import { recordComp } from "./comps";
import { programmeSf, queueSupplyProject, rescheduleSupplyProject, stallSupplyProject } from "./supply";
import { recordPropertyEvent } from "./history";
import { sizeAreaScale } from "./cityscale";
import { makeRivalPrincipal, rivalPrincipalOf, seatFounderAsRival } from "./people";

// Ashport is an old port town; its money has old-port-town names.
// A DOZEN FIRMS, NOT SIX. Six was enough to have somebody to lose a deal to;
// it was not enough for the street to have a texture — for there to be two old
// families who never sell and three levered shops racing each other into the
// same peak.
//
// NOBODY STARTS BIGGER THAN YOU BY MUCH. These ran to eighteen million against
// your six, which meant the largest firms opened the century with three times
// your buying power and never gave it back — you were not competing with them
// so much as watching them. Four to ten million now: some start behind you,
// the biggest starts at ten, and what they end up owning they earned inside
// the sim rather than at character creation.
//
// THIRTY-FIVE OF THEM, AND THE SIZE DISTRIBUTION IS THE POINT. A real property
// market is not a dozen equals; it is a power law. A handful of shops own most
// of what matters, a middle tier trades constantly, and a long tail of family
// holdings sit on four buildings and a parking lot and will not sell to anyone
// at any price. Twelve firms produced a market where every bid you lost, you
// lost to somebody you already knew; thirty-five produces one where the corner
// you want is quietly owned by a name you have never heard of, and where a
// self-inflicted glut has thirty-four other balance sheets to travel through
// before it comes back to yours.
//
// The cap stays at ten million. Nobody starts meaningfully bigger than you —
// what the big ones end up owning, they earn inside the sim.
const FIRMS: { name: string; style: RivalStyle; equity: number; ltv: number }[] = [
  // --- the establishment: patient money, low leverage, never a forced seller
  { name: "Calloway & Reed", style: "family", equity: 7_000_000, ltv: 0.32 },
  { name: "Harbor Point Partners", style: "core", equity: 9_000_000, ltv: 0.52 },
  { name: "Wentworth Trust", style: "family", equity: 10_000_000, ltv: 0.41 },
  { name: "Granite Mutual", style: "reit", equity: 10_000_000, ltv: 0.44 },
  { name: "Thorne & Boyle", style: "family", equity: 6_000_000, ltv: 0.28 },
  { name: "Wrenfield Brothers", style: "family", equity: 5_000_000, ltv: 0.35 },
  { name: "Ashcombe Estate Co.", style: "foreign", equity: 6_800_000, ltv: 0.26 },
  { name: "The Delancey Trust", style: "core", equity: 9_500_000, ltv: 0.38 },
  // --- the middle: the firms you will actually bid against, week in week out
  { name: "Meridian Yield Group", style: "pe", equity: 5_500_000, ltv: 0.71 },
  { name: "Alden Development Co.", style: "developer", equity: 8_000_000, ltv: 0.66 },
  { name: "Kestrel Capital", style: "opportunistic", equity: 4_000_000, ltv: 0.78 },
  { name: "Longwharf Realty", style: "merchant", equity: 6_500_000, ltv: 0.69 },
  { name: "Pell Street Holdings", style: "opportunistic", equity: 4_500_000, ltv: 0.82 },
  { name: "Tidewater Development", style: "developer", equity: 8_500_000, ltv: 0.72 },
  { name: "Barrowgate Realty", style: "reit", equity: 7_200_000, ltv: 0.55 },
  { name: "Fairlead Capital", style: "pe", equity: 5_200_000, ltv: 0.74 },
  { name: "Stonecutter Partners", style: "merchant", equity: 7_400_000, ltv: 0.70 },
  { name: "Mercer & Vane", style: "core", equity: 6_600_000, ltv: 0.49 },
  { name: "Rookery Investments", style: "vulture", equity: 4_800_000, ltv: 0.80 },
  { name: "Hollis Yard Group", style: "developer", equity: 5_800_000, ltv: 0.75 },
  { name: "Kingsbridge Realty", style: "core", equity: 8_200_000, ltv: 0.46 },
  { name: "Almond Court Capital", style: "opportunistic", equity: 3_800_000, ltv: 0.83 },
  // --- the tail: small, local, stubborn, and almost impossible to buy out
  { name: "Vasilis Brothers", style: "slumlord", equity: 3_200_000, ltv: 0.30 },
  { name: "O'Hare & Daughters", style: "family", equity: 2_800_000, ltv: 0.24 },
  { name: "Castellane Holdings", style: "owneruser", equity: 3_600_000, ltv: 0.33 },
  { name: "Brannock Property Co.", style: "slumlord", equity: 2_600_000, ltv: 0.22 },
  { name: "Ninth Ward Realty", style: "vulture", equity: 2_900_000, ltv: 0.79 },
  { name: "Tallow Lane Partners", style: "pe", equity: 3_100_000, ltv: 0.77 },
  { name: "Ferro Construction Co.", style: "merchant", equity: 3_400_000, ltv: 0.76 },
  { name: "Wexler Building Co.", style: "developer", equity: 4_100_000, ltv: 0.73 },
  { name: "Prosper Ridge Group", style: "reit", equity: 4_400_000, ltv: 0.51 },
  { name: "Anwar Estates", style: "owneruser", equity: 3_000_000, ltv: 0.27 },
  { name: "Chandler & Roe", style: "opportunistic", equity: 3_500_000, ltv: 0.81 },
  { name: "Marlowe Kimball", style: "foreign", equity: 5_000_000, ltv: 0.47 },
  { name: "Sixpenny Holdings", style: "family", equity: 2_500_000, ltv: 0.20 },
];

// What each kind of firm is FOR. These are the only behavioural differences,
// and every one of them is a real distinction between real shops.
const STYLE: Record<RivalStyle, {
  appetite: number;       // how often they are in the market at all
  procyclical: number;    // how much the credit window moves that appetite
  maxLtv: number;         // where they stop, or refuse to
  cashOut: number;        // how eagerly they refinance equity out in a boom
  classes: string[] | null;
  patience: number;       // how far above appraisal they will chase a deal
  /**
   * TARGET HOLD, IN MONTHS, and 0 means forever. This is the field that makes
   * a personality a personality rather than a leverage setting: a merchant
   * builder and a family office can want the same building for opposite
   * reasons and be on opposite sides of the trade three years later.
   */
  holdM: number;
  /**
   * WHICH WAY THE CREDIT WINDOW MOVES THEM. Almost everyone buys more when
   * money is cheap. A vulture buys when it is gone, and a family office quietly
   * buys the things nobody else can finance. Negative inverts `procyclical`.
   */
  contra: number;
  /** how far they will chase a DISTRESSED listing specifically */
  distressBias: number;
}> = {
  // Family money holds for a generation, not forever — estate, divorce, and
  // rebalancing put deeds on the tape. holdM: 0 used to mean "never sells",
  // and the century tape implied an 84-year average hold.
  family:        { appetite: 0.30, procyclical: 0.5, maxLtv: 0.50, cashOut: 0.00, classes: null, patience: 1.02, holdM: 300, contra: 0.25, distressBias: 1.1 },
  // institutional money: steady, disciplined, buys stabilised income
  core:          { appetite: 0.75, procyclical: 1.0, maxLtv: 0.65, cashOut: 0.20, classes: ["office", "multifamily"], patience: 1.06, holdM: 168, contra: 0, distressBias: 0.7 },
  // the ones who win the last three years of every cycle and lose the next one
  opportunistic: { appetite: 1.25, procyclical: 1.9, maxLtv: 0.88, cashOut: 0.85, classes: null, patience: 1.16, holdM: 72, contra: 0, distressBias: 1.4 },
  // buys dirt and puts buildings on it; the city's growth is partly theirs
  developer:     { appetite: 0.85, procyclical: 1.5, maxLtv: 0.78, cashOut: 0.55, classes: ["land", "industrial", "retail"], patience: 1.10, holdM: 120, contra: 0, distressBias: 0.9 },

  // --- and the seven the street was missing ---------------------------------

  // MERCHANT BUILDER. Builds to sell — the fee is in the delivery, not the
  // hold, and a merchant who is still holding a building at year four has made
  // a mistake and knows it. Buys land, almost nothing else.
  // holdM trimmed from 42→36 / 60→48 so the tape is not an 84-year average hold.
  merchant:      { appetite: 0.55, procyclical: 1.7, maxLtv: 0.80, cashOut: 0.30, classes: ["land"], patience: 1.08, holdM: 36, contra: 0, distressBias: 0.6 },
  // LOCAL PRIVATE EQUITY, on an IRR clock. Buy something tired, fix it, exit by
  // year five, because an IRR is a function of TIME and the fund has a life.
  // The clock is the whole personality: they will sell a good building into a
  // bad market because the deadline does not care what the market is doing.
  pe:            { appetite: 1.05, procyclical: 1.4, maxLtv: 0.75, cashOut: 0.70, classes: null, patience: 1.12, holdM: 48, contra: 0, distressBias: 1.2 },
  // LISTED REIT. Has to keep paying the dividend, which means it is never
  // out of the market and never truly patient — it must keep the yield up and
  // it cannot cut distributions without being punished for it.
  reit:          { appetite: 0.95, procyclical: 1.1, maxLtv: 0.58, cashOut: 0.45, classes: ["office", "retail", "multifamily"], patience: 1.05, holdM: 240, contra: 0, distressBias: 0.8 },
  // VULTURE. Dormant in a boom and ravenous in a bust — the only firm on this
  // street whose appetite RISES as credit closes, which is what makes a
  // receiver's book contested even in the worst year.
  vulture:       { appetite: 0.65, procyclical: 0.4, maxLtv: 0.60, cashOut: 0.20, classes: null, patience: 1.03, holdM: 96, contra: -1.6, distressBias: 2.6 },
  // OWNER-OCCUPIER. A company buying its own premises. It does not price the
  // building off a cap rate and it never sells, so every deed it takes leaves
  // the market permanently — which is exactly what a corporate headquarters
  // purchase does to a submarket's available stock.
  owneruser:     { appetite: 0.35, procyclical: 0.7, maxLtv: 0.55, cashOut: 0.00, classes: ["office", "industrial"], patience: 1.20, holdM: 0, contra: 0.2, distressBias: 0.5 },
  // Offshore capital repatriates on a long clock — not never.
  foreign:       { appetite: 0.50, procyclical: 1.3, maxLtv: 0.35, cashOut: 0.05, classes: ["office", "multifamily"], patience: 1.28, holdM: 216, contra: 0, distressBias: 0.4 },
  // THE MILKER. Buys the worst stock at the worst prices and spends nothing on
  // it, which works for years and then does not. When the milking stops they
  // dump — a twelve-year hold, not a forever husk.
  slumlord:      { appetite: 0.70, procyclical: 0.9, maxLtv: 0.72, cashOut: 0.60, classes: ["multifamily", "retail", "industrial"], patience: 0.96, holdM: 144, contra: 0.3, distressBias: 1.8 },
};

/** The style table, for modules that need to read a firm's temperament. */
export const STYLE_OF = (k: RivalStyle) => STYLE[k];

const RATE_SPREAD = 1.9;   // what a firm of this size pays over the index

// HOW MUCH OF THE BOOK IS ACTUALLY AMORTISING.
//
// Every firm used to pay down a thirtieth of its entire book every year, which
// at eighty per cent leverage is 2.7% of gross asset value a year on top of
// interest — enough on its own to make a levered shop structurally cash-flow
// negative. Measured consequence: opportunistic firms lived 5.3 years and
// developers 8.0, the street ran 0.61 living opportunistic shops and 0.77
// developers against three of each at the start, and the entire rival news
// feed became a rolling obituary.
//
// Family capital pays its buildings off, because that is what family capital
// is for. A core fund amortises most of its book. An opportunistic shop and a
// developer buy on interest-only paper, because the business plan is an exit
// in five years and nobody amortises through a hold they intend to sell out of.
const AMORT_SHARE: Record<RivalStyle, number> = {
  family: 1, core: 0.85, opportunistic: 0.25, developer: 0.35,
  // A merchant builder and a private-equity fund both intend to be gone before
  // the first principal payment matters. A REIT amortises because its lenders
  // and its rating make it. An owner-user pays its building off like a mortgage
  // on a house. Offshore capital barely borrows. A slumlord services what it
  // must and no more.
  merchant: 0.15, pe: 0.20, reit: 0.75, vulture: 0.45,
  owneruser: 1, foreign: 0.90, slumlord: 0.30,
};

// ---------------------------------------------------------------- building
//
// How much of the city's own pipeline each kind of firm is willing to own.
// A developer is in the business; an opportunistic shop builds when the money
// is free and regrets it; core and family capital does not take construction
// risk, because that is the entire point of core and family capital.
const BUILD_APPETITE: Record<RivalStyle, number> = {
  // Named builders have to actually build. Appetite used to leave the street
  // claiming ~3% of city jobs — noise, not "the rest" the docstring promised.
  developer: 1.15, opportunistic: 0.45, core: 0.08, family: 0,
  // A merchant builder is MORE of a builder than a developer is — building is
  // the entire business and the hold is an accident. Everybody else has a
  // reason not to take construction risk, and the reason differs.
  merchant: 1.35, pe: 0.50, reit: 0.14, vulture: 0.06,
  owneruser: 0.22, foreign: 0, slumlord: 0,
};
const CONSTR_SPREAD_R = 2.6;   // construction paper is dearer than term paper

/** Concurrent live frames a style will carry. Developers/merchants are shops. */
function maxLiveJobs(style: RivalStyle): number {
  if (style === "developer" || style === "merchant") return 3;
  if (style === "pe" || style === "opportunistic") return 2;
  return 1;
}

/**
 * ONE DEED, ONE OWNER.
 *
 * Every path that hands a parcel to a firm goes through here, because the ones
 * that did not each grew their own way of putting the same building on two
 * balance sheets — a receiver still listing a site the buyer had already
 * taken, a rescued frame added to the taker while the dead sponsor kept it.
 * Strip it from whoever has it, pay them if there is a price, then record it.
 */
function transferDeed(s: GameState, bbl: string, to: Rival, price: number) {
  for (const r of s.rivals ?? []) {
    if (r === to || !r.bbls.includes(bbl)) continue;
    r.bbls = r.bbls.filter((b) => b !== bbl);
    // The paper goes with the deed. Leaving a stale extension record behind
    // meant that if the same firm ever bought the same corner back, its first
    // month of ownership arrived with an expired forbearance already on file.
    forgetDeed(r, bbl);
    if (price > 0) {
      const relief = Math.min(r.debt, Math.round(price * r.targetLtv));
      r.debt -= relief;
      r.cash += price - relief;
    }
  }
  if (!to.bbls.includes(bbl)) to.bbls.push(bbl);
  // WHEN THE DEED ARRIVED. A hold period is the difference between a family
  // office and a private-equity fund, and it cannot be modelled without
  // knowing how long each building has actually been owned.
  (to.heldSince ??= {})[bbl] = s.month;
}

/**
 * IS THIS ABOUT THE PLAYER AT ALL?
 *
 * The rule actions.ts settled on for ordinary trades, applied to the two other
 * routine things a named firm does on the front page. A tape print is not news
 * — measured over twenty-five years, "Sold: X went to a 1031 buyer at $Y" was
 * the single most common line in the paper, and burying the sector turn and the
 * bank failure under it is the whole defect. Two things make a routine event
 * worth telling a principal about:
 *
 *   YOU HAVE A STAKE. It is on your block or in your submarket, so the price it
 *   sets is the comp your own building gets marked against and the space it
 *   opens is the space your tenant is about to tour.
 *
 *   YOU KNOW THEM. You have traded with, been beaten by, or insulted this firm,
 *   so what they are doing with their book is information about a counterparty
 *   rather than about a stranger.
 *
 * Everything else already goes where it belongs: a sale reaches the comps tape
 * through `recordComp`, and delivered square feet reach the market through the
 * cohort pipeline whether or not anybody reads about it.
 */
function stakeIn(s: GameState, parcels: ParcelTable, rec: ParcelRecord, firmId?: string): boolean {
  if (firmId && s.street?.[firmId]) return true;
  for (const b of Object.keys(s.holdings)) {
    const mine = resolveRec(parcels, s, b);
    if (mine && (mine.block === rec.block || mine.district === rec.district)) return true;
  }
  return false;
}

/**
 * SOMEBODY ON THE STREET TAKES THE SITE.
 *
 * Called from the city's growth loop the moment a job is conceived. A firm
 * with the appetite, the dry powder and a reason to like the corner buys the
 * dirt and puts its name on the job; if nobody bites, the anonymous city
 * builds it exactly as before. That is the honest split — most construction in
 * any city is done by people you have never heard of, and the rest is done by
 * the four names you compete with every month.
 *
 * Returns the claiming firm, or null.
 */
export function claimJob(
  s: GameState, parcels: ParcelTable, bbl: string,
  use: DevUse, sf: number, floors: number, deliverM: number,
  // WHETHER THIS CORNER IS NEXT DOOR TO SOMETHING YOU OWN. Computed at the
  // call site, where the adjacency table is already in scope.
  nearPlayer = false,
  underwriting?: DevPlan,
): Rival | null {
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return null;
  const ci = Math.max(0.4, Math.min(1.25, s.econ.creditIdx ?? 1));
  const shared = underwriting
    ? { plan: underwriting, clears: underwriting.hurdleRatio >= 1 && underwriting.ltcMax > 0 }
    : underwriteDevelopment(s, parcels, bbl, use, floors, 0.62);
  if (!shared?.clears) return null;
  const plan = shared.plan;
  const cost = plan.costTotal;
  const land = plan.landBasis;
  const ltc = plan.ltc;
  // LOAN-TO-COST MEANS COST, AND COST INCLUDES THE SITE.
  //
  // This required the dirt to be bought outright, in cash, on top of the equity
  // slice of the build — `cost * (1 - ltc) + land`. No construction lender
  // works that way and no developer would survive one that did. A construction
  // facility is sized against TOTAL project cost, land included; the sponsor
  // puts up its share of the whole and the loan advances against the rest, with
  // the site counted into the basis at what was paid for it.
  //
  // The old form was not a small conservatism, it was the reason the street
  // does not build. Measured over two towns and thirty years, named firms broke
  // ground on 9 of 307 jobs — 2.9% — while `claimJob`'s own docstring says the
  // split should be "most construction... done by people you have never heard
  // of, and the rest... by the four names you compete with every month". 2.9%
  // is not the rest, it is noise. The arithmetic: the city breaks ground on
  // sites whose median land is $8.5M, and the median firm holds $0.8M of cash.
  // Requiring all of the first from all of the second failed by an order of
  // magnitude, every time, for fifty years.
  // Sponsor equity against TOTAL project cost (land + hard). Day-one is a
  // first equity draw of that total — not "100% of the dirt PLUS 85% of
  // equity", which double-counted the site and left named firms at ~3% of
  // groundbreaks against median land of several million.
  const projectCost = cost + land;
  const equity = Math.round(projectCost * (1 - ltc));
  const dayOneEquity = Math.round(equity * 0.40);

  const runners = livingRivals(s).filter((r) => {
    const want = BUILD_APPETITE[r.style];
    if (want <= 0) return false;
    const live = (s.cityJobs ?? []).filter((j) => j.firmId === r.id && !j.orphaned).length;
    if (live >= maxLiveJobs(r.style)) return false;
    // A JOB HAS TO FIT THE FIRM. Nobody with twelve million of equity starts a
    // sixty-million-dollar tower, and a shop that does it anyway is not a
    // developer, it is a casualty.
    if (projectCost > (r.aum ?? 0) * 0.9 + r.cash * 5) return false;
    if (r.cash < dayOneEquity + Math.max(400_000, r.cash * 0.04)) return false;
    // Named builders should claim a real share of the pipeline. Near the
    // player is still hotter (comp + tenant risk), but far sites are no longer
    // a coin-flip against a 0.5× haircut that left them at ~3%.
    const p = Math.min(0.95, want * ci * (nearPlayer ? 2.6 : 1.35));
    return rng(s, "rivals") < p;
  });
  if (!runners.length) return null;

  // the hungriest of the firms that can actually fund it
  let best = runners[0], bestW = -Infinity;
  for (const r of runners) {
    const w = BUILD_APPETITE[r.style] * (r.cash / Math.max(1, dayOneEquity)) * (0.6 + rng(s, "rivals") * 0.8);
    if (w > bestW) { bestW = w; best = r; }
  }

  best.cash -= dayOneEquity;
  best.basis = Math.round((best.basis ?? 0) + land);
  transferDeed(s, bbl, best, land);
  const job = (s.cityJobs ?? []).find((j) => j.bbl === bbl);
  if (job) {
    job.firmId = best.id;
    job.cost = projectCost;
    // Day-one equity is in. Remaining work draws the construction facility —
    // leaving a multi-million equityLeft balance orphaned every claimed job
    // once sponsor cash ran dry before the loan ever advanced (debt stayed 0).
    job.spent = dayOneEquity;
    job.equityLeft = 0;
    job.debt = 0;
    // Facility covers the unpaid balance plus a thin interest reserve — without
    // it, capitalised interest fills the commitment and the next month orphans
    // a nearly finished frame.
    job.commitment = Math.round(Math.max(0, projectCost - dayOneEquity) * 1.12);
    job.ratePct = plan.ratePct;
    job.lender = plan.lender;
  }
  s.news.unshift({
    q: s.month, kind: "event",
    text: nearPlayer
      ? `${best.name} has broken ground at ${rec.address} — ${(sf / 1000).toFixed(0)}k sf of ${use}, ${(cost / 1e6).toFixed(1)}M, `
        + `due ${START_YEAR + Math.floor(deliverM / 12)}. That is next door to yours. Your corner is worth more the day it tops out and your tenants have somewhere else to go the day it opens.`
      : `${best.name} has broken ground at ${rec.address} — ${(sf / 1000).toFixed(0)}k sf of ${use}, `
        + `${(cost / 1e6).toFixed(1)}M, due ${START_YEAR + Math.floor(deliverM / 12)}. That space is coming whether you want it or not.`,
  });
  return best;
}

/**
 * The money going into every job the street has under way: equity first, then
 * the bank, interest capitalised into the balance. It is on their balance
 * sheet from the day the hole is dug, which is why a firm that started three
 * towers at the peak is carrying three towers' worth of debt against three
 * pieces of dirt when the market turns.
 */
/** Monthly capacity for anonymous merchant construction, from employment × credit. */
function replenishCityBuildPool(s: GameState) {
  const jobs = Math.max(20_000, s.econ.jobs ?? 100_000);
  const credit = Math.max(0.35, s.econ.creditIdx ?? 1);
  // ~$90 per employed resident per month of construction capacity. Generous
  // enough that a normal pipeline finishes; tight enough that a credit crunch
  // with many simultaneous frames can orphan work — the point of a pool.
  let monthly = Math.max(8_000_000, Math.round(jobs * 90 * credit));
  // SUPPLY MUST ANSWER EMPLOYMENT (ECONOMY.md §F #2). When office vacancy is
  // already on the frictional rail, the space market has asked for more stock.
  // Orphaning those frames because the pool was sized for a quiet year is how
  // stock CAGR falls behind jobs — and how the rent rail stays permanently
  // pinned. Service the live anonymous burn when the book is binding.
  let anonBurn = 0;
  for (const j of s.cityJobs ?? []) {
    if (j.orphaned || j.firmId || !(j.cost ?? 0)) continue;
    anonBurn += monthJobSpend(j, s.month);
  }
  const officeVac = s.econ.cityVac?.office ?? NATURAL_VAC.office;
  const pinned = officeVac <= frictionFloor("office") + 1e-6;
  if (pinned && anonBurn > monthly) monthly = anonBurn;
  const cap = monthly * 48;
  s.econ.cityBuildCash = Math.min(cap, (s.econ.cityBuildCash ?? monthly * 24) + monthly);
}

function monthJobSpend(
  j: { cost?: number; spent?: number; startM: number; deliverM: number },
  month: number,
): number {
  // Gap to the S-curve target — not a raw monthly increment. Prefunding day-one
  // equity (spent > 0 at groundbreak) used to leave the curve still demanding
  // 100% of cost on top, so commitment filled, debt stopped, and every claimed
  // job orphaned with the facility "fully drawn".
  const span = Math.max(1, j.deliverM - j.startM);
  const t1 = Math.min(1, (month - j.startM + 1) / span);
  const curve = (t: number) => t * t * (3 - 2 * t);
  const target = Math.round((j.cost ?? 0) * curve(t1));
  return Math.max(0, target - (j.spent ?? 0));
}

/** True when a thin pool should kill the job rather than slip the schedule. */
function anonShouldOrphan(s: GameState, j: NonNullable<GameState["cityJobs"]>[number]): boolean {
  const progress = (j.spent ?? 0) / Math.max(1, j.cost ?? 1);
  // A frame already in the air waits a month when the pool is thin — that is
  // schedule slippage, and it is how real jobs survive a funding pinch. Only
  // greenfield work with almost nothing spent orphans into a standing skeleton,
  // and only when credit is already frightened. Otherwise the pool was merely
  // short for a month and next month's replenishment covers the call.
  return progress < 0.12 && (s.econ.creditIdx ?? 1) < 0.70;
}

/** Orphan the frame and stall economic delivery in the same month — stock must not land while the map job dies. */
function orphanCityJob(s: GameState, j: NonNullable<GameState["cityJobs"]>[number]) {
  j.orphaned = true;
  if (j.bbl) stallSupplyProject(s, j.bbl);
}

/** Anonymous city jobs draw equity + capital calls from the city pool. */
function fundAnonymousCityJob(s: GameState, j: NonNullable<GameState["cityJobs"]>[number]) {
  // Legacy unstamped jobs keep the old free path so old saves do not mass-orphan.
  if (!(j.cost ?? 0)) return;
  const spend = monthJobSpend(j, s.month);
  if (spend <= 0) return;
  const fromEquity = Math.min(spend, Math.max(0, j.equityLeft ?? 0));
  const afterEquity = spend - fromEquity;
  const commitment = Math.max(j.debt ?? 0, j.commitment ?? (j.cost ?? 0));
  const debtRoom = Math.max(0, commitment - (j.debt ?? 0));
  const fromDebt = Math.min(afterEquity, debtRoom);
  const cashNeed = fromEquity + (afterEquity - fromDebt);
  const pool = s.econ.cityBuildCash ?? 0;
  if (pool < cashNeed) {
    if (anonShouldOrphan(s, j)) {
      orphanCityJob(s, j);
      s.news.unshift({
        q: s.month, kind: "event",
        text: `Merchant builders have stopped work — the city's construction pool could not fund `
          + `the remaining $${(cashNeed / 1e6).toFixed(2)}M call on an anonymous job.`,
      });
    } else {
      // Schedule slips with the funding month — otherwise a deferred job would
      // still "open" on the original deliverM with work unpaid, and the space
      // market would book stock that never topped out.
      j.deliverM = (j.deliverM ?? s.month) + 1;
      if (j.bbl) rescheduleSupplyProject(s, j.bbl, j.deliverM);
    }
    return;
  }
  s.econ.cityBuildCash = pool - cashNeed;
  j.equityLeft = Math.max(0, (j.equityLeft ?? 0) - fromEquity);
  j.debt = (j.debt ?? 0) + fromDebt;
  j.spent = (j.spent ?? 0) + spend;
  const cap = Math.round(((j.debt ?? 0) * (j.ratePct ?? 8)) / 100 / 12);
  if (cap > 0) {
    const room = Math.max(0, commitment - (j.debt ?? 0));
    const capitalised = Math.min(cap, room);
    const cashInterest = cap - capitalised;
    if (cashInterest > (s.econ.cityBuildCash ?? 0)) {
      // Capitalise what fits the commitment; forbear unpaid cash interest unless
      // this is a greenfield credit-crunch skeleton (same rule as a missed draw).
      j.debt = (j.debt ?? 0) + capitalised;
      const pay = Math.min(cashInterest, s.econ.cityBuildCash ?? 0);
      s.econ.cityBuildCash = (s.econ.cityBuildCash ?? 0) - pay;
      if (anonShouldOrphan(s, j)) {
        orphanCityJob(s, j);
        s.news.unshift({
          q: s.month, kind: "event",
          text: `An anonymous frame has stalled after exhausting interest carry in the city construction pool.`,
        });
      }
      return;
    }
    j.debt = (j.debt ?? 0) + capitalised;
    s.econ.cityBuildCash = (s.econ.cityBuildCash ?? 0) - cashInterest;
  }
}

export function fundJobs(s: GameState) {
  replenishCityBuildPool(s);
  // Near-delivery anonymous work takes the pool before greenfield claims can
  // starve it — otherwise a wave of starts orphans the frames closest to
  // adding stock, which is the opposite of how a thin capital pool behaves.
  const ordered = [...(s.cityJobs ?? [])].sort((a, b) => {
    const ap = (a.spent ?? 0) / Math.max(1, a.cost ?? 1);
    const bp = (b.spent ?? 0) / Math.max(1, b.cost ?? 1);
    return bp - ap;
  });
  for (const j of ordered) {
    if (j.orphaned) continue;
    if (!j.firmId) {
      fundAnonymousCityJob(s, j);
      continue;
    }
    const r = s.rivals.find((x) => x.id === j.firmId);
    if (!r || r.failedM !== undefined) { orphanCityJob(s, j); continue; }
    const spend = monthJobSpend(j, s.month);

    // THEIR BANK FAILED TOO. No draws, so the month's work in place comes out
    // of the sponsor's own account, and the receiver's interest comes out of
    // it as well instead of capitalising. A firm with a balance sheet carries
    // the job to the finish; a firm without one leaves a frame standing on the
    // corner, and orphanToTape puts that frame in front of the player at land
    // plus a fraction of the sunk cost. This is why a seizure is the best
    // buying window in the game — it is not a bonus, it is somebody's job.
    if (j.repudiatedM !== undefined) {
      const carry = Math.round(((j.debt ?? 0) * (j.ratePct ?? 8)) / 100 / 12);
      if (r.cash < spend + carry) {
        orphanCityJob(s, j);
        s.news.unshift({
          q: s.month, kind: "event",
          text: `${r.name} has stopped work. Their construction lender was seized, nobody would refinance the job, `
            + `and they have run out of cash to carry it themselves. The frame stands where it stands.`,
        });
        continue;
      }
      r.cash -= spend + carry;
      j.equityLeft = Math.max(0, (j.equityLeft ?? 0) - spend);
      j.spent = (j.spent ?? 0) + spend;

      // And the same way out the player has: another desk, once the paperwork
      // is done, and only if its advance rate on the whole cost clears what is
      // already owed to the receiver.
      if (s.month >= (j.replaceM ?? 0)) {
        const span = Math.max(1, j.deliverM - j.startM);
        const t1 = Math.min(1, (s.month - j.startM + 1) / span);
        const progress = t1 * t1 * (3 - 2 * t1);
        const toComplete = Math.max(0, (j.cost ?? 0) * (1 - progress));
        const equityLeft = Math.max(0, j.equityLeft ?? 0);
        const desk = openConstructionDesks(s)
          .filter((d) => d.name !== (j.lender ?? CONSTRUCTION_LENDER))
          .find((d) => {
            const gross = d.cap * (j.cost ?? 0);
            const newMoney = gross - (j.debt ?? 0);
            return newMoney > 0 && newMoney + equityLeft + Math.max(0, r.cash) >= toComplete;
          });
        if (desk) {
          j.lender = desk.name;
          // The premium a desk charges to step into a receiver's shoes — the
          // same one orphanToTape's takeover paper carries, for the same
          // reason. It is not a new number.
          j.ratePct = +(s.econ.indexRate + CONSTR_SPREAD_R + 0.6).toFixed(2);
          delete j.repudiatedM;
          delete j.replaceM;
        }
      }
      continue;
    }

    if (spend > 0) {
      const fromEquity = Math.min(spend, Math.max(0, j.equityLeft ?? 0));
      const afterEquity = spend - fromEquity;
      const commitment = Math.max(j.debt ?? 0, j.commitment ?? (j.cost ?? 0));
      const debtRoom = Math.max(0, commitment - (j.debt ?? 0));
      const fromDebt = Math.min(afterEquity, debtRoom);
      const capitalCall = afterEquity - fromDebt;
      const cashNeed = fromEquity + capitalCall;
      if (r.cash < cashNeed) {
        // Prefer a month of schedule slip over a standing skeleton when the
        // sponsor is only short this draw — orphans were eating most named
        // starts before they could deliver.
        if ((j.spent ?? 0) > (j.cost ?? 0) * 0.15) {
          j.deliverM = (j.deliverM ?? s.month) + 1;
          if (j.bbl) rescheduleSupplyProject(s, j.bbl, j.deliverM);
          continue;
        }
        orphanCityJob(s, j);
        s.news.unshift({
          q: s.month, kind: "event",
          text: `${r.name} has stopped work with the construction facility fully drawn. `
            + `The remaining $${(cashNeed / 1e6).toFixed(2)}M call was more than the sponsor could fund.`,
        });
        continue;
      }
      r.cash -= cashNeed;
      j.equityLeft = Math.max(0, (j.equityLeft ?? 0) - fromEquity);
      j.debt = (j.debt ?? 0) + fromDebt;
      r.debt += fromDebt;
      j.spent = (j.spent ?? 0) + spend;
    }
    // capitalised, the way construction interest actually works
    const cap = Math.round(((j.debt ?? 0) * (j.ratePct ?? 8)) / 100 / 12);
    if (cap > 0) {
      const commitment = Math.max(j.debt ?? 0, j.commitment ?? (j.cost ?? 0));
      const capitalised = Math.min(cap, Math.max(0, commitment - (j.debt ?? 0)));
      const cashInterest = cap - capitalised;
      if (cashInterest > r.cash) {
        // Capitalise the coupon into the facility and slip — same survival
        // path anonymous jobs get when the city pool is thin for a month.
        j.debt = (j.debt ?? 0) + cap;
        r.debt += cap;
        j.deliverM = (j.deliverM ?? s.month) + 1;
        if (j.bbl) rescheduleSupplyProject(s, j.bbl, j.deliverM);
        continue;
      }
      j.debt = (j.debt ?? 0) + capitalised;
      r.debt += capitalised;
      r.cash -= cashInterest;
    }
  }
}

/**
 * SOMEBODY LENT THEM THAT MONEY.
 *
 * A firm on this street dies two ways and the news says so both times — "the
 * debt outlived the portfolio", "the buildings go to the lenders" — and until
 * now not one dollar of it reached a lender's balance sheet. Thirty-two of
 * fifty firms failed across a fifty-year run and the two bank desks' worst
 * delinquency in the whole century was 4.89%, against a market whose office
 * vacancy peaked at 28.9%. Their capital never came within a point of their
 * target, so no bank could ever fail, so every consequence hanging off a bank
 * failure — the insured deposits, the receiver's dividend, the repudiated
 * construction commitments — was machinery that could not engage.
 *
 * That is the whole 1990 mechanism and it was open at one end. Developers go
 * under; the banks that financed them eat it; enough of that and the bank goes
 * under too. This closes it.
 *
 * WHOSE LOSS IT IS. Construction debt names its desk — a job carries the
 * lender that wrote it — so that part is known rather than guessed. The rest
 * is term paper, and the model does not track which desk wrote which mortgage
 * for a firm on the street. It is allocated across the live desks by book
 * share, because a bigger book holds more of this town's paper. That is an
 * allocation, not a fact the engine knows, and it is written here as one.
 */
function chargeSponsorFailure(s: GameState, parcels: ParcelTable, r: Rival): { desk: string; owed: number } {
  const none = { desk: "", owed: Math.max(0, r.debt) };
  if (r.debt <= 0) return none;
  // What the receiver gets back: the cash, and the buildings sold into the
  // market that killed the borrower — the same distressed band the firm was
  // already selling into on its way down, not a second invented number.
  let recovered = Math.max(0, r.cash);
  for (const bbl of r.bbls) {
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    recovered += assetValue(rec, s.econ, assetGrade(r, rec)) * rrange(s, 0.68, 0.88, "rivals");
  }
  const loss = Math.round(r.debt - recovered);
  if (loss <= 0) return none;

  const exposure: Record<string, number> = {};
  let known = 0;
  for (const j of s.cityJobs ?? []) {
    if (j.firmId !== r.id || !(j.debt ?? 0)) continue;
    const name = j.lender ?? CONSTRUCTION_LENDER;
    exposure[name] = (exposure[name] ?? 0) + (j.debt ?? 0);
    known += j.debt ?? 0;
  }
  const term = Math.max(0, r.debt - known);
  const live = (s.lenders ?? []).filter((l) => l.failedM === undefined);
  const books = live.reduce((a, l) => a + l.book, 0);
  if (term > 0 && books > 0) {
    for (const l of live) exposure[l.name] = (exposure[l.name] ?? 0) + term * (l.book / books);
  }
  const total = Object.values(exposure).reduce((a, x) => a + x, 0);
  if (total <= 0) return none;

  let worst = { name: "", amt: 0 };
  for (const [name, exp] of Object.entries(exposure)) {
    const share = Math.round((loss * exp) / total);
    chargeLenderLoss(s, name, share);
    if (share > worst.amt) worst = { name, amt: share };
  }
  // Only when it is big enough to be a story. A desk taking a hole worth more
  // than a twentieth of its book is news in this town.
  const wl = live.find((l) => l.name === worst.name);
  if (wl && worst.amt > wl.book * 0.02) {
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `${worst.name} is carrying the biggest piece of the ${r.name} failure — about `
        + `$${(worst.amt / 1e6).toFixed(1)}M of a $${(loss / 1e6).toFixed(1)}M hole. `
        + `Somebody lent them that money, and this is the month it stops being an asset.`,
    });
  }
  // WHOSE PROBLEM THE BOOK IS NOW. The desk with the largest exposure is the
  // one that leads the workout and puts the relationship out as one ticket —
  // see the receiver's package in tickRivals.
  return { desk: worst.name, owed: Math.max(0, r.debt) };
}

/**
 * The building opens and it is theirs. Called from the city's delivery loop so
 * there is exactly one place in the codebase where a building comes into
 * existence and exactly one place where its square feet enter the market.
 */
export function jobDelivered(s: GameState, parcels: ParcelTable, bbl: string, firmId: string, cost: number) {
  const r = s.rivals.find((x) => x.id === firmId);
  if (!r) return;
  transferDeed(s, bbl, r, 0);
  r.basis = Math.round((r.basis ?? 0) + cost);
  (r.deliveredM ??= {})[bbl] = s.month;
  const rec = resolveRec(parcels, s, bbl);
  // A ROUTINE OPENING IS NOT NEWS. "It is competing with you tomorrow" is only
  // true if it is anywhere near you — see stakeIn. The square feet reach the
  // market either way, through the delivery cohort.
  if (rec && stakeIn(s, parcels, rec, firmId) && rng(s, "rivals") < 0.7) {
    s.news.unshift({
      q: s.month, kind: "event",
      text: `${r.name} has opened ${rec.address}. It is empty today and it is competing with you tomorrow.`,
    });
  }
}

/**
 * THE FRAME NOBODY OWNS.
 *
 * A sponsor that dies mid-job leaves a part-built building standing on a site
 * the receiver has to clear. It goes to the tape at the land value plus a
 * fraction of what has been sunk — never all of it, because a stranger's
 * half-finished building is worth less than the money that went into it, and
 * because whoever buys it inherits a design they did not draw. This is the
 * best deal in development and the game could not previously produce one.
 */
function orphanToTape(s: GameState, parcels: ParcelTable) {
  for (const j of s.cityJobs ?? []) {
    if (!j.orphaned) continue;
    // A frame that did not sell goes back on the tape, cheaper. Standing steel
    // rusts and a stalled site is a story everybody in town knows — leaving it
    // listed once and then forever invisible meant an unsold frame simply
    // haunted the map for the rest of the century.
    if (j.listedM !== undefined && s.month - j.listedM < 24) continue;
    const rec = resolveRec(parcels, s, j.bbl);
    if (!rec || s.holdings[j.bbl] || s.listings.some((l) => l.bbl === j.bbl)) continue;
    const sunk = j.spent ?? 0;
    const progress = Math.min(0.95, sunk / Math.max(1, j.cost ?? 1));
    const stale = Math.max(0.45, 1 - (j.listedM === undefined ? 0 : (s.month - j.listedM) / 90));
    const ask = Math.round((landValue(rec, s.econ) + sunk * rrange(s, 0.45, 0.7, "rivals") * stale) / 1000) * 1000;
    if (ask <= 0) continue;
    const relist = j.listedM !== undefined;
    j.listedM = s.month;
    s.listings.push({
      bbl: j.bbl, ask, listedM: s.month, expiresM: s.month + Math.round(rrange(s, 8, 16, "rivals")), distress: true,
      halfBuilt: { use: j.use, sf: j.sf, floors: j.floors, progress, costToComplete: Math.max(0, (j.cost ?? 0) - sunk) },
    });
    s.news.unshift({
      q: s.month, kind: "event",
      text: relist
        ? `The stalled frame at ${rec.address} is back on the tape at $${(ask / 1e6).toFixed(2)}M. Nobody wanted it last time and the steel has not got any newer.`
        : `The receiver is clearing a half-finished building at ${rec.address} — ${(progress * 100).toFixed(0)}% complete, `
          + `$${(ask / 1e6).toFixed(2)}M for the site and the frame. Somebody else's problem is on the market.`,
    });
  }
}

/**
 * WHO ELSE IS IN THIS TOWN, and it should not be the same answer every time.
 *
 * FIRMS is the population of operators this city could have produced. It used
 * to be the roster, entire and identical in every game: the same thirty-five
 * names with the same capital and the same leverage, which is why a hundred
 * years later the same family office had won. Measured over twenty-two
 * unplayed centuries, Wentworth Trust finished first in eleven of them and
 * every single winner was one of five family offices — not an emergent dynasty
 * so much as the same race run twenty-two times.
 *
 * A city has the firms it happens to have. Some never got founded, some raised
 * more than others, and the one that ends up owning the place is not
 * determined on day one. So each game draws its own field: most of the
 * population turns up, a handful do not, and what they came to the table with
 * varies the way real capital raises vary.
 *
 * The bands are deliberately narrow on leverage and wide on equity. How much a
 * firm raised is a fact about its investors; how much it is willing to borrow
 * is a fact about its character, and character is what STYLE already encodes.
 */
function rosterFor(s: GameState): typeof FIRMS {
  // Powder scales with the map's land area (k²). Same RNG draws as before —
  // only the multiply after the raise changes — so Hamlet / Great City do not
  // re-roll the field, they resize the cheques against a bigger or smaller pond.
  const area = sizeAreaScale(s);
  const out: typeof FIRMS = [];
  for (const f of FIRMS) {
    // A quarter of the field, at most, never got off the ground in this city.
    if (rng(s, "rivals") < 0.14) continue;
    out.push({
      ...f,
      equity: Math.round(f.equity * rrange(s, 0.55, 1.75, "rivals") * area / 100_000) * 100_000,
      ltv: +Math.max(0.15, Math.min(0.82, f.ltv + rrange(s, -0.06, 0.06, "rivals"))).toFixed(3),
    });
  }
  // A town with four landlords is not a market. If the draw thinned the field
  // too far, take the population as it stands — still sized to this island.
  return out.length >= 22 ? out : FIRMS.map((f) => ({
    ...f,
    equity: Math.round(f.equity * area / 100_000) * 100_000,
  }));
}

export function initRivals(s: GameState, parcels: ParcelTable, bbls: string[]): Rival[] {
  const out: Rival[] = [];
  // The built stock that isn't yours has to belong to SOMEBODY. Handing a
  // slice of it to named firms costs nothing on the map and means the town has
  // owners you can go and talk to.
  const built = bbls.filter((b) => {
    const r = parcels[b];
    return r && r.class !== "land" && r.bldgArea > 0;
  });
  // Vacant dirt for the land bank. A developer who opens fully invested in
  // standing buildings never builds — measured: zero vacant lots on every
  // builder-style firm at month zero, and ~1.3 named deliveries per city in
  // fifty years. The land bank is not decoration; it is how they break ground.
  const vacant = bbls.filter((b) => {
    const r = parcels[b];
    return r && (r.class === "land" || !r.bldgArea) && (r.lotArea ?? 0) >= 2500;
  });
  const taken = new Set<string>();
  rosterFor(s).forEach((f, i) => {
    const r: Rival = {
      id: `r${i}`, name: f.name, style: f.style,
      // The reserve comes OUT of what they raised, it is not conjured on top
      // of it. A firm holding back a tenth of its fund has a tenth less to buy
      // with, exactly like you do.
      cash: 0, bbls: [], debt: 0, targetLtv: f.ltv, bornM: 0, basis: 0,
    };
    const builder = BUILD_APPETITE[f.style] >= 0.9;
    // Builders keep serious dry powder. A land bank without cash cannot break
    // ground — measured after the first land-bank pass: firms held 7–14 lots
    // and $1–4M, and still almost never started.
    const reserveShare = builder
      ? rrange(s, 0.34, 0.48, "rivals")
      : rrange(s, 0.06, 0.16, "rivals");
    r.cash = Math.round(f.equity * reserveShare);
    let spend = f.equity - r.cash;

    // LAND BANK FIRST for shops that build — a few sites, not the whole fund.
    // Cap lots so dirt does not immobilise the equity needed to verticalize.
    if (builder || f.style === "merchant" || f.style === "developer") {
      const landBudget = Math.round(spend * (f.style === "merchant" ? 0.40 : 0.22));
      const maxLots = f.style === "merchant" ? 4 : 3;
      let landSpend = 0;
      let lots = 0;
      let landGuard = 0;
      while (landSpend < landBudget && lots < maxLots && landGuard++ < 800) {
        const bbl = vacant[Math.floor(rng(s, "rivals") * vacant.length)];
        if (!bbl || taken.has(bbl)) continue;
        const rec = parcels[bbl];
        const v = landValue(rec, s.econ);
        if (v <= 0 || v > landBudget - landSpend + spend * 0.05) continue;
        // Prefer sites a first equity draw can actually verticalize.
        if (v > r.cash * 1.8) continue;
        if (v > spend - landSpend) continue;
        taken.add(bbl);
        r.bbls.push(bbl);
        r.basis = Math.round((r.basis ?? 0) + v);
        landSpend += v;
        lots++;
      }
      spend -= landSpend;
    }

    // buy income product until the remaining deployable equity is spent
    let guard = 0;
    while (spend > 0 && guard++ < 3000) {
      const bbl = built[Math.floor(rng(s, "rivals") * built.length)];
      if (!bbl || taken.has(bbl)) continue;
      const rec = parcels[bbl];
      const v = assetValue(rec, s.econ, initialCondition(rec));
      if (v <= 0) continue;
      const styleOk = STYLE[f.style].classes === null || STYLE[f.style].classes!.includes(rec.class);
      if (!styleOk && rng(s, "rivals") < 0.75) continue;
      /**
       * THE ROSTER'S DEBT IS SIZED BY THE TOWN'S OWN DESKS, not asserted.
       *
       * This wrote `v * f.ltv` on every building — the whole street at its
       * maximum leverage on day zero, against loans no lender ever tested.
       * Measured over ten towns: 59 firms died inside five game-years and
       * every one was an opening-roster firm (33 in year one alone; zero
       * later-raised funds died young). A town that supported thirty firms
       * yesterday does not bury a third of them the year you arrive — those
       * books were fabricated insolvent, and the wave of failures every new
       * game opened with was the init, not the market.
       *
       * `streetRefiProceeds` is the same advance/coverage/debt-yield walk the
       * street already uses for its refis and purchases. Seeding through it
       * means an incumbent's paper is paper this town's banks would actually
       * write at today's rates — a dear-money era seeds a lightly levered
       * street, which is who survives a dear-money era. The style's ltv is
       * still the cap; coverage is now the floor under it. Same fix the
       * player's side got in "devPencils must read what the desk reads".
       */
      const noi = noiAfterTaxYr(rec, s.econ, initialCondition(rec), v);
      const sized = Math.min(
        Math.round(v * f.ltv),
        streetRefiProceeds(s, v, Math.max(0, noi), f.ltv).principal,
      );
      const equityIn = v - sized;
      if (equityIn > spend) { if (spend < f.equity * 0.08) break; else continue; }
      taken.add(bbl);
      r.bbls.push(bbl);
      r.debt += sized;
      r.basis = Math.round((r.basis ?? 0) + v);
      spend -= equityIn;
    }
    out.push(r);
  });
  return out;
}

/** How a firm's stewardship reads, in words, for the balance sheet. */
export function rivalCondition(r: Rival): Condition {
  const c = r.condIdx ?? 0.8;
  return c > 0.78 ? "good" : c > 0.52 ? "standard" : "worn";
}

const GRADES: Condition[] = ["worn", "standard", "good"];

/**
 * WHAT A FIRM'S CARE DOES TO A BUILDING IT OWNS — which is move it a notch,
 * not replace its history.
 *
 * Reading a firm's stewardship as the building's condition outright meant a
 * disciplined core fund's 1904 warehouse appraised as new construction: twenty
 * per cent more rent and twenty per cent more value on every asset the moment
 * the firm bought it, which made well-run money unbeatable at the bid. A good
 * operator lifts a tired building one grade. A bad one runs a good building
 * down one. Neither of them changes when it was built.
 */
export function assetGrade(r: Rival, rec: ParcelRecord): Condition {
  const base = initialCondition(rec);
  const c = r.condIdx ?? 0.8;
  // RECENTRED ON WHAT THE INDEX ACTUALLY DOES. Measured over a hundred and
  // fifty firm-years: condIdx runs p25 0.73, p50 0.80, p75 0.89. Against the
  // old cuts a good operator's notch fired on 39% of the street's stock and a
  // bad one's on 0.2% — so "they let their buildings go" was a grade nobody
  // could reach, and the street was marked up on average. On the quartiles it
  // is a real spread: about a quarter of the city's firm-owned stock run down,
  // about a quarter kept properly, the rest exactly its age.
  const notch = c > 0.88 ? 1 : c > 0.70 ? 0 : -1;
  const i = Math.max(0, Math.min(2, GRADES.indexOf(base) + notch));
  return GRADES[i];
}

/**
 * WHAT GRADE THIS BUILDING IS ACTUALLY IN TODAY.
 *
 * Its year, moved one notch by whoever has been running it. This is the only
 * honest answer to "what condition is it in", and until now the game asked a
 * different question — `initialCondition(rec)`, which is a pure function of
 * yearBuilt — at every price it quoted: the tape's ask, the broker's whisper,
 * the lender's underwriting, and the deed itself. So a levered shop could
 * defer the roof for twenty years, the street table could print "worn · $0 of
 * capital spent this year" beside its name, and the building still sold at,
 * and arrived as, exactly what its birth year said. One grade is worth about a
 * third of the value of a building. That is not a detail to leave on the floor.
 *
 * A dead firm's book is the receiver's problem and reverts to the building's
 * own age — nobody has been running it at all.
 */
export function gradeOf(s: GameState, rec: ParcelRecord): Condition {
  const r = ownerOf(s, rec.bbl);
  return r && r.failedM === undefined ? assetGrade(r, rec) : initialCondition(rec);
}

/**
 * THE LEDGER BETWEEN YOU AND ONE FIRM, created on first contact.
 *
 * Every path that changes what a firm thinks of you goes through here, because
 * there are only three things that ever happen between two principals: you
 * traded, they beat you, or you insulted them.
 */
export function tie(s: GameState, firmId: string) {
  s.street = s.street ?? {};
  s.street[firmId] = s.street[firmId] ?? { deals: 0, beats: 0, insults: 0, lastM: s.month };
  s.street[firmId].lastM = s.month;
  return s.street[firmId];
}

/**
 * Gross asset value, annual NOI and leverage, marked today — through the
 * firm's own occupancy and the state of its buildings.
 *
 * Occupancy scales income one-for-one and value rather less, because a buyer
 * pays for the stabilised story as well as the rent that is arriving. That
 * split is the whole reason a half-empty building is worth more than half a
 * full one, and why a firm can be losing money and still look solvent for a
 * while — right up until the lender marks it.
 */
export function markRival(s: GameState, parcels: ParcelTable, r: Rival): { aum: number; noiYr: number; ltv: number; landV: number } {
  let aum = 0, noi = 0, landV = 0;
  for (const bbl of r.bbls) {
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const a = markAsset(s, r, rec);
    aum += a.v;
    noi += a.noi;
    // HOW MUCH OF THE BOOK IS DIRT. Carried out separately because a lender
    // does not advance against a vacant lot on an income test — see lineRoom,
    // where mixing the two made a developer's land bank look like an
    // income-property book that had stopped covering its debt service.
    if (rec.class === "land" || !rec.bldgArea) landV += a.v;
  }
  return { aum, noiYr: noi, landV, ltv: aum > 0 ? r.debt / aum : r.debt > 0 ? 9 : 0 };
}

/**
 * ONE BUILDING OUT OF A FIRM'S BOOK, marked the way the book is marked.
 *
 * Lifted out of `markRival` unchanged, because the refinancing cliff below has
 * to size a loan against a SINGLE asset and a second expression for "what is
 * this building of theirs worth and what does it earn" would be the same
 * quantity with two answers — the exact fault this file already documents in
 * `debtReleasedOnSale`. The sum of these over `r.bbls` is `markRival`, by
 * construction rather than by agreement.
 */
export function markAsset(s: GameState, r: Rival, rec: ParcelRecord): { v: number; noi: number } {
  const cond = assetGrade(r, rec);
  const v = assetValue(rec, s.econ, cond);
  if (rec.class === "land" || !rec.bldgArea) return { v, noi: noiAfterTaxYr(rec, s.econ, cond, v) };
  // Start with THIS building's modeled occupancy, then carry only the firm's
  // portfolio-wide operating delta onto it. A weak location stays weak even
  // when the rest of the book is full; a good operator can still outperform
  // the market by a few points across the portfolio.
  const bookMkt = Math.max(0.35, r.mktOcc ?? 0.88);
  const localMkt = Math.max(0.20, occupancy(rec, s.econ));
  const actual = Math.max(0.15, Math.min(0.995, localMkt + (r.occ ?? bookMkt) - bookMkt));
  const ratio = Math.max(0.35, Math.min(1.2, actual / localMkt));
  return {
    v: v * (0.42 + 0.58 * ratio),
    noi: noiAfterTaxYr(rec, s.econ, cond, v) * ratio,
  };
}

// How hard each kind of firm works its buildings. An institution runs a
// leasing team and a capital plan; a levered opportunistic shop defers the
// roof because the roof is not in this year's model.
const CARE: Record<RivalStyle, { lease: number; capex: number }> = {
  family:        { lease: 0.9,  capex: 1.15 },
  core:          { lease: 1.15, capex: 1.2 },
  opportunistic: { lease: 0.85, capex: 0.45 },
  developer:     { lease: 1.0,  capex: 0.8 },
  // A merchant builder's buildings are new, so there is nothing to spend on
  // yet. A private-equity fund spends HARD for three years and then stops,
  // because the capital plan is the business plan and it ends at the exit — it
  // is modelled here as high capex and hard leasing. A REIT keeps its assets
  // institutional because that is what the analysts look at. An owner-user
  // maintains its own house. A slumlord spends nothing at all, and its
  // buildings are where the city's obsolescence goes to live.
  merchant:      { lease: 1.0,  capex: 0.9 },
  pe:            { lease: 1.25, capex: 1.1 },
  reit:          { lease: 1.1,  capex: 1.15 },
  vulture:       { lease: 0.95, capex: 0.6 },
  owneruser:     { lease: 1.3,  capex: 1.05 },
  foreign:       { lease: 0.8,  capex: 0.95 },
  slumlord:      { lease: 0.7,  capex: 0.10 },
};

/**
 * MINIMUM GOING-IN SPREAD OVER THE STREET COUPON (index + RATE_SPREAD), in
 * percentage points. Closers used to fight over every ask by appetite alone —
 * junk and prime at the same weight. Core/family need a real spread; vultures
 * and distress buyers will cross below the coupon for a cheap ticket.
 */
const YIELD_OVER_COUPON: Record<RivalStyle, number> = {
  family: 1.40, core: 1.10, reit: 0.95, foreign: 0.85, owneruser: 0.40,
  pe: 0.70, opportunistic: 0.45, developer: 0.50, merchant: 0.30,
  slumlord: 1.60, vulture: -0.80,
};

/**
 * A YEAR IN THE LIFE OF A PORTFOLIO.
 *
 * Occupancy walks toward what the market is doing, but never arrives cleanly:
 * a firm can lose an anchor in a good year or fill a building in a bad one.
 * Condition decays every month and only stops decaying if somebody writes a
 * cheque — which is a real decision with a real cost, and the firms that skip
 * it are marked down for it exactly the way the player is.
 */
function tickAssetManagement(s: GameState, parcels: ParcelTable, r: Rival) {
  if (!r.bbls.length) { r.occ = undefined; return; }
  const care = CARE[r.style];
  // where the market says their book should sit
  let target = 0, n = 0;
  for (const bbl of r.bbls) {
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    target += occupancy(rec, s.econ); n++;
  }
  if (!n) { r.occ = undefined; return; }
  r.mktOcc = target / n;
  target = r.mktOcc * (0.965 + 0.05 * care.lease);
  if (r.occ === undefined) r.occ = target;
  r.occ += (target - r.occ) * 0.055 + rrange(s, -0.004, 0.004, "rivals");
  // AN ANCHOR WALKS. Rare, expensive, and the reason a portfolio occupancy is
  // a story rather than a number that tracks the index.
  if (rng(s, "rivals") < 0.006 / Math.max(1, Math.sqrt(r.bbls.length) / 2)) {
    r.occ -= rrange(s, 0.05, 0.14, "rivals");
    if (newsChance(s, "tenant:" + r.id, 0.35)) {
      s.news.unshift({
        q: s.month, kind: "event",
        text: `${r.name} has lost a major tenant. Their book is running at ${(Math.max(0, r.occ) * 100).toFixed(0)}% — somebody in this town is about to have space to fill.`,
      });
    }
  }
  r.occ = Math.max(0.2, Math.min(0.99, r.occ));

  // the bricks
  if (r.condIdx === undefined) r.condIdx = 0.72;
  // Buildings age faster than anyone budgets for, which is why 'well kept'
  // tops out just short of new rather than at it.
  r.condIdx -= 0.0024 * (s.econ.phase === "recession" || s.econ.phase === "depression" ? 1.25 : 1);
  const aum = r.aum ?? 0;
  // LEASING BEFORE BRICKS when the book is behind the market. Capex alone
  // could not fill empty floors — Wrenfield's century tutorial was a giant
  // that sat dark. A firm that is short of tenants spends on leasing first.
  const lag = (r.mktOcc ?? 0) - (r.occ ?? 0);
  if (lag > 0.03 && !r.stressMs && aum > 0) {
    const leaseSpend = Math.round((0.0018 * aum * care.lease * Math.min(1.2, lag / 0.08)) / 12);
    if (leaseSpend > 0 && r.cash > leaseSpend * 4) {
      r.cash -= leaseSpend;
      r.occ = Math.min(0.99, r.occ + 0.005 * care.lease * Math.min(1.5, lag / 0.06));
    }
  }
  // a capital plan is roughly 30bps of gross assets a year, and it is the
  // first line cut when a firm is short
  const want = Math.round((0.003 * aum * care.capex) / 12);
  if (want > 0 && r.cash > want * 6 && !r.stressMs) {
    r.cash -= want;
    r.capexYr = (r.capexYr ?? 0) + want;
    r.condIdx += 0.0026 * care.capex;
  }
  r.condIdx = Math.max(0.3, Math.min(0.97, r.condIdx));
  if (s.month % 12 === 0) r.capexYr = 0;
}

/** Firms still standing. */
export function livingRivals(s: GameState): Rival[] {
  return (s.rivals ?? []).filter((r) => r.failedM === undefined);
}

export const MERCHANT_MIN_LEASE_M = 18;
export const MERCHANT_MAX_HOLD_M = 42;
export function merchantExitReady(r: Rival, bbl: string, month: number): boolean {
  if (r.style !== "merchant" || r.deliveredM?.[bbl] === undefined) return false;
  const held = month - (r.deliveredM[bbl] ?? month);
  return held >= MERCHANT_MIN_LEASE_M
    && ((r.occ ?? 0) >= 0.80 || held >= MERCHANT_MAX_HOLD_M);
}

/**
 * How much competing money is in the room for a deal today.
 *
 * 1 is a normal market. Above 1 you are bidding against people with more dry
 * powder than ideas; below 1 the phone has stopped ringing for everyone and a
 * disciplined buyer gets to name their price. This is the number that makes
 * waiting for the bottom a skill rather than a formality.
 */
export function marketAppetite(s: GameState): number {
  const ci = Math.max(0.4, Math.min(1.25, s.econ.creditIdx ?? 1));
  let a = 0, n = 0;
  for (const r of livingRivals(s)) {
    const st = STYLE[r.style];
    // a firm with no dry powder is not a bidder, however loudly it talks
    const dry = Math.max(0, Math.min(1.5, r.cash / Math.max(1, 0.04 * Math.max(1, r.aum ?? r.debt))));
    a += st.appetite * Math.max(0.05, 1 + st.procyclical * (ci - 1) + st.contra * (1 - ci))
      * Math.min(1.15, 0.2 + dry);
    n++;
  }
  if (!n) return Math.max(0.25, ci);
  // normalised so a full street at a normal credit window reads 1.0 — the
  // number is meant to be compared to one, not to itself
  return Math.max(0.2, a / n / NEUTRAL_APPETITE);
}

// The reference a healthy street reads against, measured from play rather
// than derived: six firms at a normal credit window with normal dry powder.
// Getting this wrong is not cosmetic — appetite scales how fast listings are
// absorbed, and a number that sits below one all century means every building
// lingers on the tape and stale-reprices downward, which is a standing gift to
// whoever buys the most. It cost the audit its entire risk frontier once.
const NEUTRAL_APPETITE = 0.43;

/** The firm that owns this parcel, if any. */
export function ownerOf(s: GameState, bbl: string): Rival | null {
  for (const r of s.rivals ?? []) if (r.bbls.includes(bbl)) return r;
  return null;
}

/**
 * One month of the competition.
 *
 * Order matters and mirrors the real thing: mark the book, service the debt,
 * then decide whether you are a buyer or a seller — and if the answer is
 * neither because the bank is calling, you are a forced seller and the whole
 * market finds out.
 */
// Money that comes back. A firm that fails is replaced, because the buildings
// are still there and somebody always raises a fund to buy them — a city that
// loses three shops over a century and never gains one is not a city, it is a
// slow liquidation.
const NEW_FIRMS: { name: string; style: RivalStyle }[] = [
  { name: "Northgate Partners", style: "opportunistic" },
  { name: "Sable & Hale", style: "core" },
  { name: "Drydock Holdings", style: "merchant" },
  { name: "Ostrander Group", style: "vulture" },
  { name: "Bellweather Estates", style: "family" },
  { name: "Quarry Lane Capital", style: "reit" },
  { name: "Alden Municipal Pension", style: "core" },
  { name: "Fen & Marrow", style: "pe" },
  { name: "Corbin Whitlock", style: "opportunistic" },
  { name: "Saltmarsh Trust", style: "slumlord" },
  { name: "Ironbound Development", style: "developer" },
  { name: "Halyard Investors", style: "foreign" },
  { name: "Verity Street Capital", style: "pe" },
  { name: "Merrow & Sons", style: "family" },
  { name: "Pilotage Partners", style: "merchant" },
  { name: "Consolidated Wharf Co.", style: "core" },
  { name: "Redgrave Capital", style: "vulture" },
  { name: "Bexley Holdings", style: "reit" },
  { name: "Talbot Row Partners", style: "merchant" },
  { name: "Nakamura Realty", style: "owneruser" },
  { name: "Cormorant Bay Group", style: "opportunistic" },
  { name: "Fielding & Crane", style: "core" },
  { name: "Osgood Property Trust", style: "foreign" },
  { name: "Ravensworth Development", style: "developer" },
  { name: "Beaumont Ledger Co.", style: "slumlord" },
  { name: "Halloran Brothers", style: "pe" },
  { name: "Windlass Partners", style: "family" },
  { name: "Cheswick Estates", style: "developer" },
  { name: "Portland Row Capital", style: "core" },
  { name: "Ilyushin Development", style: "merchant" },
  { name: "Fairweather & Co.", style: "reit" },
  { name: "Sanderling Trust", style: "owneruser" },
  { name: "Okonkwo Holdings", style: "vulture" },
  { name: "Bridgewright Partners", style: "developer" },
];
// AND THE TOWN DOES NOT RUN OUT OF NAMES.
//
// `NEW_FIRMS` is thirty-four of them, which is a supply and therefore a rail.
// Measured over three unplayed centuries: 60.3 firms had ever existed by year
// 100 against a stock of about sixty-four, so the last two decades of a long
// career were entered by nobody — not because the market was crowded but
// because the game had run out of nouns, and no amount of opportunity could
// have brought a fund in. When the written list is spent the town coins one,
// the way a town does. The style is drawn from the same mix `NEW_FIRMS` already
// encodes rather than from a second table, so the composition of new capital is
// one distribution and not two.
const SURNAMES = [
  "Ashby", "Beckwith", "Coyne", "Dunmore", "Everleigh", "Fenwick", "Garrity",
  "Haverford", "Ingersoll", "Jessup", "Kilbride", "Lanterman", "Moresby",
  "Norrington", "Ovington", "Prentiss", "Quimby", "Rothwell", "Selkirk",
  "Thackeray", "Underhill", "Vance", "Wardlow", "Yarrow", "Ziegler",
];
const HOUSES = [
  "Partners", "Capital", "Holdings", "& Sons", "Realty",
  "Development Co.", "Trust", "Investors", "Property Group", "& Co.",
];

function coinFirm(s: GameState, used: Set<string>): { name: string; style: RivalStyle } | null {
  for (let i = 0; i < 40; i++) {
    const name = `${SURNAMES[Math.floor(rng(s, "rivals") * SURNAMES.length)]} ${HOUSES[Math.floor(rng(s, "rivals") * HOUSES.length)]}`;
    if (used.has(name)) continue;
    return { name, style: NEW_FIRMS[Math.floor(rng(s, "rivals") * NEW_FIRMS.length)].style };
  }
  return null;
}

// HOW LONG A FIRST FUND TAKES TO RAISE, and that is ALL it is.
//
// Twelve to eighteen months from "there is money to be made in this town" to a
// first close is what a first-time sponsor actually experiences: the meetings,
// the consultant, the legal, the first anchor. That is a fact about
// fundraising, and it belongs in a monthly hazard as a DENOMINATOR OF ONE — if
// the conditions for raising a fund hold every month, a fund arrives about
// every fourteen months.
//
// It used to be doing a second job, and the second job was a fake. The hazard
// read `spread / marketAppetite / RAISE_M`, in which the numerator is a number
// of PERCENTAGE POINTS: a spread of 1.2pp and an appetite of 1.2 produced "1.0
// units of opportunity", and dividing points by months to get a probability is
// a scale choice wearing a fact's label. RAISE_M was the only thing setting how
// big the answer was, and nothing in the expression could ever say no.
//
// Everything above the divide is a probability now. See maybeNewFirm.
const RAISE_M = 14;

// WHAT A FULL-STRENGTH LEVERAGE STORY LOOKS LIKE IN THIS TOWN.
//
// The pitch is "buildings yield more than the money costs", and how good that
// pitch is has to be expressed as a fraction of as-good-as-it-gets rather than
// as raw percentage points. Measured over 3,600 months of three unplayed
// centuries: the cap-rate spread over the coupon is positive in 59.4% of
// months, and conditional on being positive it runs p50 +1.20, p90 +1.71, p99
// +2.12, maximum +2.40. So 1.7 points is the ninetieth percentile of the good
// years — the number above which a sponsor is not pitching harder, he is
// pitching the same thing to people who already said yes. It is a shape
// parameter and it is anchored on that distribution, not turned until a firm
// count looked right.
const SPREAD_FULL = 1.7;

// HOW MUCH PRODUCT ONE SHOP NEEDS A YEAR TO BE A SHOP.
//
// A closed-end fund has a three-to-five year investment period and ends its
// life owning something like eight to twelve buildings. That is two
// acquisitions a year, and it is a fact about how funds are structured rather
// than a number chosen here: a sponsor who cannot deploy at that rate does not
// finish the fund, does not earn the promote, and does not raise a second one —
// and his investors work that out before the first one closes.
const DEPLOY_YR = 2;

/**
 * NEW CAPITAL ENTERS BECAUSE THERE IS MONEY TO BE MADE — AND STOPS WHEN THERE
 * IS NOTHING TO BUY.
 *
 * The old rule was a floor and a window: refill only while fewer than 24 firms
 * are standing, at 4.5% a month, and only when the credit index is above 0.88.
 * Both halves were backwards. The floor is a rail holding the model up — a firm
 * count is an OUTPUT of how good this business is, not an input — and the
 * credit gate shut the door in precisely the years a first fund gets raised.
 * Nobody raised a real estate fund in 1988. Everybody raised one in 1992.
 *
 * WHAT REPLACED IT WAS RIGHT ABOUT THE PITCH AND WRONG ABOUT THE CEILING, and
 * the comment that used to sit here asserted a plateau that had been measured
 * on a frozen world. Re-run alive, six unplayed centuries: living firms go
 * 32.3 · 31.2 · 30.5 · 30.7 · 28.2 · 30.5 · 28.3 · 32.2 · 33.3 · 35.2 by decade
 * — flatter than the frozen run made it look, but drifting UP by about three
 * firms a century with nothing in the rule capable of saying no. The mechanism
 * the old comment credited cannot say no either: capital arriving compresses
 * cap rates, but `marketAppetite` is a MEAN over firms — it is how hard the
 * AVERAGE firm is leaning in — so twice as many bidders with the same
 * temperament reads to it as exactly the same market. The number of shops in
 * the room does not appear in the expression at all.
 *
 * SO WHAT DOES LIMIT HOW MANY FIRMS A CITY THIS SIZE CARRIES? Not capital and
 * not spread. PRODUCT. Measured over 300 firm-years of three unplayed
 * centuries: the town turns over 7 to 21 buildings a year, with no trend across
 * a hundred years, while the number of firms drifts from 31 to 42 — so deal
 * flow per firm falls from 0.58 to 0.43 a year and the correlation between firm
 * count and deals per firm is −0.29. A shop on this street buys HALF A BUILDING
 * A YEAR. That is the ceiling, it is nameable, and it is the one a real market
 * runs into: you cannot raise a fund into a town where forty other people are
 * already fighting over fifteen trades, because the pitch meeting ends at "and
 * what exactly are you going to buy".
 *
 * The three terms below are therefore all fractions of one, they multiply, and
 * the clock is the clock:
 *
 *   LEVERAGE  — is the going-in yield above the coupon, and by how much of as
 *               good as it gets. Against the coupon rather than the mortgage
 *               constant because a first fund buys interest-only; see debt.ts.
 *   PRODUCT   — is there anything to deploy into, against what a fund needs to
 *               deploy. This is the term that closes behind the fund that
 *               raised on it, and it is monotone in firm count by construction.
 *   THIN      — is anybody bidding. `marketAppetite` normalised so an ordinary
 *               market reads 1.0; measured p10 0.79, p50 1.27, p90 1.68, so
 *               this runs about 0.6 in a hot market and 1.3 in a dead one. A
 *               thin market both makes the pitch and makes it true. The 1.5
 *               ceiling on it is a guard and not a rail — appetite would have
 *               to fall below 0.67 to touch it and its measured tenth
 *               percentile is 0.79.
 *
 * The old expression carried a `Math.min(0.5, ...)` on the answer, which is
 * what a rail looks like: a hazard that has to be clamped is a hazard nobody
 * can read. Three fractions of one and a fourteen-month clock cannot exceed
 * 1/14, so there is nothing left to clamp.
 *
 * WHAT IT PRODUCES, six unplayed centuries, world kept alive: living firms go
 * 27.7 · 23.3 · 21.0 · 21.0 · 19.8 · 17.7 · 17.3 · 17.3 · 17.7 · 18.2 by decade
 * and 38.3 have ever existed by year 100. It converges — the last five decades
 * sit inside a firm of each other — and it converges because the product term
 * is monotone in the count and nothing else in the rule is. The counterfactual
 * says which term is doing it: with `product` forced to 1 and everything else
 * unchanged the street runs 27.8 · 29.3 · 28.5 · 28.3 · 27.5 · 25.5 · 26.0 ·
 * 27.5 · 27.0 · 26.0 and 49.3 firms have ever existed. So this town carries
 * about eighteen shops, the number is an OUTPUT of how many trades a year there
 * are to go round, and it is not a floor, a cap or a target.
 */
/**
 * Entry pitch — leverage × product × thin, as a monthly hazard against RAISE_M.
 * Exported so `pnpm firms` can assert the raise is still able to say no.
 */
export function firmEntryPitch(s: GameState): {
  leverage: number; product: number; thin: number; pitch: number; traded: number; firms: number;
} {
  const c = s.econ.capRate;
  const cap = (c.office + c.retail + c.multifamily + c.industrial) / 4;
  const spread = cap - (s.econ.indexRate + RATE_SPREAD);
  const leverage = spread <= 0 ? 0 : Math.min(1, spread / SPREAD_FULL);
  let traded = 0;
  for (const m of Object.values(s.lastTradeM ?? {})) if (s.month - m < 12) traded++;
  for (const j of s.cityJobs ?? []) if (s.month - j.startM < 12) traded++;
  const firms = livingRivals(s).length;
  const product = Math.min(1, traded / Math.max(1, firms) / DEPLOY_YR);
  const thin = Math.min(1.5, 1 / Math.max(0.2, marketAppetite(s)));
  const pitch = Math.min(1, leverage * product * thin);
  return { leverage, product, thin, pitch, traded, firms };
}

function styleFromFounderRole(role: FounderBid["role"]): RivalStyle {
  if (role === "construction") return "developer";
  if (role === "leasing") return "opportunistic";
  return "pe";
}

function firmNameFromFounder(s: GameState, personName: string, used: Set<string>): string {
  const last = personName.trim().split(/\s+/).pop() || "Spinout";
  for (const house of HOUSES) {
    const name = `${last} ${house}`;
    if (!used.has(name)) return name;
  }
  // Fallback coins through the same surname table so we never stall.
  for (let i = 0; i < 20; i++) {
    const name = `${last} ${HOUSES[Math.floor(rng(s, "rivals") * HOUSES.length)]}`;
    if (!used.has(name)) return name;
  }
  return `${last} Capital ${s.month}`;
}

/**
 * THE NUMBER TWO WHO LEAVES. Spinouts were genealogy the street could only
 * get from the player's own staff walking out — an unplayed century produced
 * zero, which made "spinouts carry genealogy" a test that could not fail. But
 * the commonest spinout in this business has nothing to do with you: the
 * acquisitions head of a shop that has done well for a decade decides the
 * next fund should have their own name on it. About one such departure per
 * thriving firm per twenty years; the raise still has to clear firmEntryPitch
 * and the product term, so a crowded street refuses them like anybody else.
 *
 * Seed-hashed, no rng() draws — the rivals and people streams are untouched
 * and every seed-pinned number reproduces.
 */
function spinHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const SPIN_FIRSTS = ["Nora", "Elias", "Ruth", "Victor", "Ada", "Miles", "Iris", "Hugh", "Celia", "Amos"];
const SPIN_LASTS = ["Fenn", "Aldous", "Marek", "Trask", "Odell", "Bryce", "Hollis", "Ingram", "Wexler", "Danforth"];

function tickRivalSpinouts(s: GameState) {
  if (s.month % 12 !== 0 || s.month < 120) return;
  const yr = Math.floor(s.month / 12);
  for (const r of s.rivals ?? []) {
    if (r.failedM !== undefined || r.stressMs) continue;
    if (s.month - (r.bornM ?? 0) < 120 || r.bbls.length < 4) continue;
    if ((s.founderBids ?? []).some((b) => b.fromFirmId === r.id)) continue;
    const k = `spin:${s.seed}:${r.id}:${yr}`;
    if (spinHash(k) >= 0.05) continue;
    const nm = `${SPIN_FIRSTS[Math.floor(spinHash(k + ":f") * SPIN_FIRSTS.length)]} ${SPIN_LASTS[Math.floor(spinHash(k + ":l") * SPIN_LASTS.length)]}`;
    const tal = (o: string, lo: number, hi: number) => Math.round(lo + (hi - lo) * spinHash(k + o));
    const attrs = { judgment: tal(":j", 58, 84), urgency: tal(":u", 55, 82), diligence: tal(":d", 58, 84), relationships: tal(":r", 60, 86) };
    (s.founderBids ??= []).push({
      readyM: s.month + 3 + Math.floor(spinHash(k + ":w") * 7),
      name: nm,
      bornM: s.month - (12 * (34 + Math.floor(spinHash(k + ":a") * 14))),
      diesM: s.month + 12 * (30 + Math.floor(spinHash(k + ":m") * 20)),
      attrs,
      obs: { judgment: attrs.judgment - 8, urgency: attrs.urgency - 6, diligence: attrs.diligence - 7, relationships: attrs.relationships - 6 },
      band0: 16,
      role: "pm",
      fromFirmId: r.id,
      fromFirmName: r.name,
    });
    s.news.unshift({
      q: s.month, kind: "info",
      text: `${nm} is leaving ${r.name} after ${(Math.round((s.month - (r.bornM ?? 0)) / 12))} years to raise their own vehicle. `
        + `Whether the street clears a first close is another question.`,
    });
  }
}

function maybeNewFirm(s: GameState) {
  const { leverage, product, pitch } = firmEntryPitch(s);
  if (leverage <= 0 || product <= 0) return;

  // Genealogy proposes first. A ready founder bid takes this month's raise
  // slot — anonymous capital only enters when nobody is waiting to spin out.
  const bids = s.founderBids ?? [];
  const readyIdx = bids.findIndex((b) => b.readyM <= s.month);
  const founder = readyIdx >= 0 ? bids[readyIdx] : null;
  /** Months a ready founder keeps pitching before the street closes on them. */
  const FOUNDER_WINDOW_M = 18;

  if (rng(s, "rivals") > pitch / RAISE_M) {
    // Not this month. Founders keep the slot and try again — a single roll
    // must not erase a career. Only the window expiring (or a barren street
    // for the whole window) sends them elsewhere.
    if (founder && s.month - founder.readyM >= FOUNDER_WINDOW_M) {
      s.founderBids = bids.filter((_, i) => i !== readyIdx);
      s.news.unshift({
        q: s.month, kind: "info",
        text: `${founder.name} could not raise out of ${founder.fromFirmName} — `
          + `the street would not clear a first close. They took a seat elsewhere.`,
      });
    }
    return;
  }

  const used = new Set((s.rivals ?? []).map((r) => r.name));
  let name: string;
  let style: RivalStyle;
  let spawnedFrom: Rival["spawnedFrom"] | undefined;

  if (founder) {
    s.founderBids = bids.filter((_, i) => i !== readyIdx);
    name = firmNameFromFounder(s, founder.name, used);
    style = styleFromFounderRole(founder.role);
    spawnedFrom = {
      firmId: founder.fromFirmId,
      firmName: founder.fromFirmName,
      personName: founder.name,
    };
  } else {
    const pool = NEW_FIRMS.filter((f) => !used.has(f.name));
    const f = pool.length ? pool[Math.floor(rng(s, "rivals") * pool.length)] : coinFirm(s, used);
    if (!f) return;
    name = f.name;
    style = f.style;
  }

  // A NEW FUND IS A NEW FUND. This used to scale the raise by aggregate street
  // AUM — "sized to the era" — which sounds right and is not: once the twelve
  // incumbents crossed half a billion between them, every firm founded after
  // that came out of the gate at up to $15M, above the cap the whole roster is
  // built to. A firm's first close is set by what a first-time sponsor can
  // raise, not by how rich the people who started forty years earlier have
  // become. They compound their way up like everybody else.
  // Same band as before, then × island area — a Great City first close is not
  // a Hamlet first close. No extra rng() calls. `style` is set for both
  // genealogy spinouts and anonymous raises.
  const equity = Math.round(rrange(s, 4_000_000, 10_000_000, "rivals") * sizeAreaScale(s));
  const ltv = STYLE[style].maxLtv * rrange(s, 0.68, 0.88, "rivals");
  /**
   * A FIRST CLOSE IS COMMITMENTS, NOT CASH. The LPs sign for the fund; the
   * GP calls it as it deploys, and what has not been called yet is the
   * youngest firm's whole protection — a two-year-old fund has MORE dry
   * powder than a twenty-year-old one, not none.
   *
   * `pnpm mortality` measured the opposite in this engine: 55% of all firm
   * deaths were firms under five years old (hazard 3.74/100 firm-years
   * against 0.21-0.69 for every mature bucket), and the mechanism was that
   * `recallable()` read only recalled DISTRIBUTIONS — a well that is bone
   * dry until a firm is old enough to have distributed. The median arrears
   * episode that cured belonged to a 26.6-year-old firm; the median one that
   * killed, to a 2.0-year-old. Age was the whole difference, and the model
   * had the capital structure of a young fund exactly backwards.
   *
   * The reserve share is a shape parameter calibrated to practice, stated as
   * such: closed-end vehicles hold back 30-50% of commitments for follow-ons
   * and contingencies. It is drawn once at the raise, so no two funds carry
   * the same cushion, and it can only fall — capital calls burn it and
   * nothing refills it. When it is gone the firm is exactly where every firm
   * was before this existed.
   */
  const uncalled = Math.round(equity * rrange(s, 0.30, 0.50, "rivals"));
  // Cash is what has been CALLED. Uncalled is the reserve the LPs signed for —
  // it becomes cash only through callCapital. Handing both as spendable money
  // made every new fund 30–50% overcapitalised on day one.
  const id = `r${s.rivals.length}`;
  s.rivals.push({
    id, name, style,
    cash: equity - uncalled, debt: 0, bbls: [], targetLtv: +ltv.toFixed(2), bornM: s.month,
    uncalled,
    spawnedFrom,
  });
  // Operating principal — peopleRng only, after every rivals-stream draw above.
  (s.rivalPrincipals ??= {})[id] = founder
    ? seatFounderAsRival(s, id, founder)
    : makeRivalPrincipal(s, id, name);
  s.news.unshift({
    q: s.month, kind: "event",
    text: founder
      ? `${founder.name} has raised $${(equity / 1e6).toFixed(0)}M as ${name}, spinning out of ${founder.fromFirmName}. `
        + `There is competition on the tape again — and it knows your book.`
      : `${name} has raised $${(equity / 1e6).toFixed(0)}M and is looking for buildings. There is competition on the tape again.`,
  });
}

/**
 * THE SHARE OF AN AGGREGATE BASIS THAT ONE BUILDING OF n REPRESENTS.
 *
 * A rival's basis is aggregate — see the header — so the basis in any one
 * building is estimated by its share of the book. It is written down once
 * because THREE places need it and they were not agreeing: `gainsTax` divides
 * by `r.bbls.length`, the rival `deedInLieu` divides by `r.bbls.length + 1`
 * because it has already stripped the deed, and `marketAssetToRaise` did not
 * ask at all. The convention is the one `deedInLieu` reconstructs and the only
 * one that means anything: the building is one of the n the firm owns WHILE IT
 * STILL OWNS IT. Callers must therefore ask before the deed moves, which is
 * what `rivalBuys` and `sellToOutsider` now do.
 */
function basisShare(r: Rival): number {
  const basis = r.basis ?? 0;
  return Math.min(basis, basis / Math.max(1, r.bbls.length));
}

/**
 * WHAT THE REVENUE WOULD TAKE ON THIS SALE, without taking it.
 *
 * The pure half of `gainsTax`. It exists because a sponsor deciding WHICH
 * building to sell has to know what the closing actually puts in the account,
 * and the decision had been reading a different number from the settlement.
 * Measured over 1,385 forced sales on six unplayed centuries: the decision
 * believed it would net $5,092.8M and the settlements paid $3,385.3M, the
 * $1,684.1M difference being exactly this tax — the modelled proceeds were 50%
 * high, and 224 of the 843 sales that "covered the hole" settled short of it.
 * That is one quantity with two answers, and this is the one answer.
 */
function gainsTaxOn(r: Rival, price: number): number {
  return Math.round(Math.max(0, price - basisShare(r)) * 0.25);
}

/**
 * TAX ON A GAIN, the way the player pays it — and charged.
 *
 * The street used to compound capital gains tax-free for a hundred years while
 * the player paid on every disposal. Charged at the same rate the player pays.
 * Call it BEFORE the deed comes off `r.bbls`; see basisShare.
 */
function gainsTax(r: Rival, price: number): number {
  const share = basisShare(r);
  const tax = gainsTaxOn(r, price);
  r.basis = Math.max(0, Math.round((r.basis ?? 0) - share));
  r.taxPaid = (r.taxPaid ?? 0) + tax;
  return tax;
}

/**
 * A DEVELOPER PICKS UP SOMEBODY ELSE'S FRAME.
 *
 * You are not the only person in town who reads the receiver's list. A stalled
 * building that sits long enough gets taken out by a firm with the balance
 * sheet to finish it — which is what stops the map filling with permanent
 * monuments to dead sponsors, and what makes the good ones worth moving on.
 * They pay for the site and the steel and inherit the bill for the rest.
 */
function rescueOrphan(s: GameState, parcels: ParcelTable, ci: number) {
  const stalled = (s.cityJobs ?? []).filter((j) => j.orphaned && j.listedM !== undefined && s.month - j.listedM >= 6);
  if (!stalled.length) return;
  const j = stalled[Math.floor(rng(s, "rivals") * stalled.length)];
  if (s.holdings[j.bbl]) return;
  const listing = s.listings.find((l) => l.bbl === j.bbl);
  const price = listing?.ask ?? 0;
  if (price <= 0) return;
  const toFinish = Math.max(0, (j.cost ?? 0) - (j.spent ?? 0));
  const taker = livingRivals(s).find((r) =>
    BUILD_APPETITE[r.style] >= 0.3
    && r.cash > price + toFinish * 0.4 + 2_000_000
    && rng(s, "rivals") < 0.10 * BUILD_APPETITE[r.style] * ci);
  if (!taker) return;
  taker.cash -= price;
  taker.basis = Math.round((taker.basis ?? 0) + price);
  transferDeed(s, j.bbl, taker, price);
  j.orphaned = false;
  j.firmId = taker.id;
  j.equityLeft = Math.round(toFinish * 0.45);
  j.cost = (j.spent ?? 0) + toFinish;
  j.ratePct = +(s.econ.indexRate + CONSTR_SPREAD_R + 0.6).toFixed(2);
  // a restart is slow: new drawings, new contractor, a site that has weathered
  j.deliverM = s.month + Math.max(6, Math.round((j.deliverM - j.startM) * 0.5));
  s.listings = s.listings.filter((l) => l.bbl !== j.bbl);
  const rec = resolveRec(parcels, s, j.bbl);
  s.news.unshift({
    q: s.month, kind: "event",
    text: `${taker.name} has taken out the stalled building at ${rec?.address ?? j.bbl} for $${(price / 1e6).toFixed(2)}M. `
      + `The cranes are back and that space is coming after all.`,
  });
}

/**
 * A LAND BANK IS SUPPOSED TO BECOME BUILDINGS.
 *
 * Developer-style firms buy dirt off the tape — that is in their style config
 * and always was. What they never did was build on it, so a developer's land
 * bank was a vacant lot that bled 1.2% of its value a year forever, which is
 * not a strategy, it is a slow death. Once a month a firm looks at what it is
 * sitting on and puts up the best of it.
 */
function startOwnJob(s: GameState, parcels: ParcelTable, r: Rival, ci: number) {
  if (BUILD_APPETITE[r.style] <= 0) return;
  const live = (s.cityJobs ?? []).filter((j) => j.firmId === r.id && !j.orphaned).length;
  if (live >= maxLiveJobs(r.style)) return;
  // Vacant land first; when housable floor lags employment, densify worn or
  // obsolete stock they already own — same underwrite and order book as the
  // city's teardown desk (ECONOMY.md §F #2 / CENTURY OPEN #6).
  type Site = { bbl: string; rec: ParcelRecord; redev: boolean; score: number };
  let best: Site | null = null;
  const yrNow = START_YEAR + Math.floor(s.month / 12);
  for (const bbl of r.bbls) {
    if ((s.cityJobs ?? []).some((j) => j.bbl === bbl)) continue;
    if (s.developments[bbl] || s.holdings[bbl]) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.lotArea < 2500) continue;
    if (rec.class === "land") {
      const score = rec.demandScore + rng(s, "rivals") * 20;
      if (!best || score > best.score) best = { bbl, rec, redev: false, score };
      continue;
    }
    if (!rec.bldgArea) continue;
    const age = yrNow - (rec.yearBuilt || 1900);
    // 35 not 45 — century runs showed near-zero rival redevelopment; worn stock
    // at mid-life is exactly what densifies in a real city.
    if (age < 35) continue;
    const cond = assetGrade(r, rec);
    if (cond !== "obsolete" && cond !== "worn") continue;
    let useProbe = useForZone(rec.zoneDist, rec.demandScore, rng(s, "rivals"), s.econ);
    if (useProbe === "retail" && retailWantsMixed(rec)) useProbe = "mixed";
    const leadProbe = dominantOf(devMix(useProbe));
    const st = s.econ.structTight?.[leadProbe] ?? 0;
    const vac = s.econ.cityVac?.[leadProbe] ?? NATURAL_VAC[leadProbe];
    if (st < 0.05 && vac > frictionFloor(leadProbe) + 0.02) continue;
    const infillProbe = cityInfillCap(s, parcels, rec, Math.min(1, s.month / 780), leadProbe);
    const targetSf = rec.lotArea * 0.62 * infillProbe;
    if (targetSf < rec.bldgArea * 1.15) continue;
    const densify = targetSf / rec.bldgArea;
    const score = densify * (1 + 3 * st) * rec.demandScore + rng(s, "rivals") * 10;
    if (!best || score > best.score) best = { bbl, rec, redev: true, score };
  }
  if (!best) return;
  const { bbl, rec, redev } = best;
  let use = useForZone(rec.zoneDist, rec.demandScore, rng(s, "rivals"), s.econ);
  // Shops do not stack, and a corner that carries twenty floors does not get a
  // two-storey shop on it — it gets shops at grade with something above.
  if (use === "retail" && retailWantsMixed(rec)) use = "mixed";
  const lead = dominantOf(devMix(use));
  // Owning the dirt does not manufacture tenant demand. A named start drains
  // the same class order book as an anonymous one and cannot precede it.
  if ((s.econ.startOwed?.[lead] ?? 0) <= 0) return;
  // Preserve the draw order; apply it after this actual site has gone through
  // the shared parcel pro forma.
  const startsRoll = rng(s, "rivals");
  const farMax = farMaxFor(rec);
  const frac = Math.min(0.95, (redev ? 0.55 : 0.4) + rng(s, "rivals") * 0.45);
  let sf = Math.max(3000, Math.round((rec.lotArea * farMax * frac) / 100) * 100);
  let floors = Math.max(1, Math.round(sf / (rec.lotArea * 0.62)));
  // A named developer reads the same comps the anonymous city does: one
  // increment above the block's cornice datum, not the zoning envelope.
  const infill = cityInfillCap(s, parcels, rec, Math.min(1, s.month / 780), lead);
  if (floors > infill) {
    floors = infill;
    sf = Math.max(3000, Math.round((rec.lotArea * 0.62 * floors) / 100) * 100);
  }
  const cap = MAX_FLOORS_BY_USE[use];
  if (cap !== undefined && floors > cap) {
    floors = cap;
    sf = Math.max(3000, Math.round((rec.lotArea * 0.62 * floors) / 100) * 100);
  }
  if (redev && sf < rec.bldgArea * 1.12) return;
  const opp = redev
    ? (() => {
      const cond = assetGrade(r, rec);
      const hair = cond === "obsolete" ? 0.78 : cond === "worn" ? 0.86 : 0.93;
      return Math.max(landValue(rec, s.econ), assetValue(rec, s.econ, cond) * hair);
    })()
    : undefined;
  const underwriting = underwriteDevelopment(s, parcels, bbl, use, floors, 0.62, opp);
  if (!underwriting?.clears) return;
  // Land-bank starts were ~1%/month even for a full-appetite developer — so a
  // firm sitting on dirt still almost never broke ground. Raise the monthly
  // hazard so a funded land bank becomes buildings, not a slow bleed.
  // Redevelopment was rarer than land-bank starts; push densify harder so the
  // city renews itself (same roll count — higher gate pass rate only).
  const startGate = redev ? 0.12 : 0.055;
  if (startsRoll >= startGate * BUILD_APPETITE[r.style] * ci * underwriting.appetite) return;
  const plan = underwriting.plan;
  sf = plan.sf;
  floors = plan.floors;
  if (redev && sf < rec.bldgArea * 1.08) return;
  const cost = plan.costTotal;
  if (cost > (r.aum ?? 0) * 0.9 + r.cash * 5) return;
  // Dirt is already theirs — first equity draw only (loan follows over the job).
  const dayOneNeed = Math.round(plan.equity * 0.40);
  if (r.cash < dayOneNeed + Math.max(400_000, r.cash * 0.03)) return;
  const formerDurationRoll = rng(s, "rivals");
  void formerDurationRoll;
  const months = plan.months;
  const deliverM = s.month + months;
  if (!s.cityJobs) s.cityJobs = [];
  const oldSf = redev ? rec.bldgArea : 0;
  if (redev) {
    // Clear the standing improvement off the map and stock before replacement
    // — same as tickTeardowns; the firm funds the job through cost/equity.
    const oldCls = rec.class as BuiltClass;
    s.built[bbl] = { class: "land" as unknown as BuiltClass, bldgArea: 0, floors: 0, yearBuilt: 0 };
    if ((CITY_STOCK as Record<string, number>)[oldCls] !== undefined) {
      addStock(s.econ, oldCls as keyof typeof CITY_STOCK, -oldSf);
    }
    s.demolished = (s.demolished ?? 0) + 1;
    recordPropertyEvent(s, bbl, {
      kind: "demolished",
      sf: oldSf,
      use: oldCls,
      outcome: `${r.name} cleared for denser ${use}`,
    });
  }
  // A NAMED FIRM BUILDS THE SAME BUILDING THE CITY DOES — shops at grade where
  // the street carries them. Settled here and carried on the job so the
  // pipeline below and the delivery record cannot disagree.
  const prog = plan.mix;
  // First equity draw at groundbreak; the facility carries the rest. Funding
  // the entire sponsor equity out of monthly cash calls is what stalled land-
  // bank jobs with debt still at zero.
  const dayOne = dayOneNeed;
  r.cash -= dayOne;
  s.cityJobs.push({
    bbl, use, sf, floors, startM: s.month, deliverM, mix: prog,
    firmId: r.id, cost, spent: dayOne,
    equityLeft: 0, debt: 0,
    commitment: Math.round(Math.max(0, cost - dayOne) * 1.12),
    ratePct: plan.ratePct,
    lender: plan.lender,
  });
  noteRecordPlan(s, parcels, bbl, lead, sf, floors, r.name);
  // Into the one delivery queue the day the hole is dug, exactly like the city.
  const rivalProgramme = programmeSf(sf, prog);
  queueSupplyProject(s, {
    bbl,
    source: "rival",
    deliverM,
    sfByUse: rivalProgramme,
  });
  for (const [u, usf] of Object.entries(rivalProgramme)) {
    // ...AND OFF THE ORDER BOOK, WHICH THIS PATH ALONE WAS NOT DOING.
    // Four paths break ground in this city. Three of them net the delivered
    // square footage off `startOwed` so the space market stops asking for
    // space it is about to get — the anonymous starts (dev.ts:2646), the
    // teardown replacements (dev.ts:2393) and the player (dev.ts:978). A named
    // firm building on its own land pushed the cohort and skipped this line,
    // so the town carried a permanent phantom backlog for every tower the
    // street put up. The leak is one-sided downstream and it compounds:
    // `wanted = owed / TYPICAL_SF` orders an extra crane, and the same `owed`
    // feeds crew utilisation, which hires extra trades and raises the
    // construction cost index for everybody. dev.ts:2385 diagnosed this exact
    // fault on the teardown path and called it "the biggest of them".
    if (s.econ.startOwed) {
      s.econ.startOwed[u as BuiltClass] = Math.max(0, (s.econ.startOwed[u as BuiltClass] ?? 0) - usf);
    }
  }
  s.news.unshift({
    q: s.month, kind: "event",
    text: redev
      ? `${r.name} is tearing down ${rec.address} for ${(sf / 1000).toFixed(0)}k sf of ${use} `
        + `(was ${(oldSf / 1000).toFixed(0)}k). The book needed the floor area.`
      : `${r.name} is building on their own land at ${rec.address} — ${(sf / 1000).toFixed(0)}k sf of ${use}, `
        + `$${(cost / 1e6).toFixed(1)}M. They have been sitting on that corner waiting for this market.`,
  });
}

// ---------------------------------------------------------------- the cliff
//
// A NON-RECOURSE MORTGAGE DOES NOT ACCELERATE BECAUSE A VALUER MARKED THE
// BUILDING DOWN.
//
// What this file used to do instead: `stressed = ltvNow > maxLtv + 0.05`, and
// thirty months later the firm was dead. That is a mark-to-market solvency
// test, and no commercial mortgage in the world contains one. A borrower who
// makes every payment on time does not default because an appraiser's opinion
// of the collateral changed, and a lender who accelerated on that basis would
// be sued and would lose. Measured on the old test over four fifty-year runs:
// 89 of 162 firms died, the median one aged 13.8 years, and the constant cohort
// of the dying was HEALTHY five years out at 0.39 leverage with nine buildings
// and money in the bank. What killed them was the city's own repricing — a
// fixed basket of the same buildings at the same grade fell 44% across the same
// window, which is the market, not the borrower.
//
// Leverage still has to bite, or the whole business becomes safe. It bites in
// life at the REFINANCING CLIFF, which is a DATE and not a running appraisal:
// the balloon lands, the new loan is sized against today's value and today's
// lender appetite, and a sponsor who cannot cover the gap between the old
// balance and the new proceeds has to find the difference or give the building
// up. CLAUDE.md names it in the list of things that make this business hard.
//
// WHAT MATURITY MACHINERY THE STREET HAD: none. `r.debt` is a single number
// with an amortisation share and no term at all, so nothing on this street has
// ever come due. This is the smallest honest version of one.

// THE LADDER IS DERIVED, NOT STORED, and this is the reason why.
//
// A rival deliberately carries no per-asset loan record — see the header of
// this file — and inventing one would mean two numbers that both claim to be
// what the firm owes. But an origination date is already known: `heldSince`
// records the month each deed arrived, and a mortgage is written at the
// closing. So a firm's balloons are its acquisition dates plus a term, which
// gives a real, staggered ladder for nothing and cannot drift away from the
// book.
//
// The three desks that write term paper on standing income property in this
// town are the hometown bank, the regional and the conduit; the terms come
// from their own sheets rather than being restated here. Which of the three
// wrote any particular file is not recorded anywhere in this engine, so it is
// drawn deterministically per building — stable across a save, staggered
// across a book, and honest about being an allocation rather than a fact.
const TERM_DESKS = ["harbor", "savings", "conduit"];

function hash32(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The term of the paper on one building of one firm's, in months. */
function loanTermM(r: Rival, bbl: string): number {
  return productById(TERM_DESKS[hash32(r.id + "|" + bbl) % TERM_DESKS.length]).termM;
}

/**
 * WHEN THE PAPER ON THIS BUILDING WAS WRITTEN.
 *
 * `heldSince` when the deed moved inside the sim. The opening roster has no
 * such record — `initRivals` hands a firm nine buildings in month zero — and
 * dating all of them to month zero would land every balloon on the street in
 * the same month, which is an artefact of the setup and not a credit cycle. A
 * firm that opens the game owning nine buildings did not buy them all in
 * December: the opening book is spread back across the term it carries.
 */
function originM(r: Rival, bbl: string, term: number): number {
  const since = r.heldSince?.[bbl];
  if (since !== undefined) return since;
  return -(hash32(r.id + "~" + bbl) % term);
}

/**
 * WHEN THE EXTENDED PAPER ON THIS BUILDING COMES BACK.
 *
 * An extension has to be REMEMBERED or it buys a full term instead of two
 * years — that is the whole of F2 — and remembering it needs one number per
 * building on the firm. That number lives in `Rival.extendedTo`, keyed by BBL.
 *
 * IT USED TO LIVE INSIDE `heldSince` UNDER AN `ext|` PREFIX, and the note in
 * types.ts records what that cost: the sweep test scanned the map for any
 * prefixed key, and a record for a building the firm had since sold went on
 * suppressing its distributions with nothing behind it. Both halves of that
 * are fixed — the record has its own map, and the reader below derives the
 * sweep from what the firm actually OWNS, so a record that outlives its
 * building cannot be load-bearing even if some path forgets to clear it.
 *
 * The record also carries the "nobody extends twice" rule the player already
 * lives under (`workout.requestForbearance`: asks >= 1): once an entry exists
 * for a building it is never cleared while the paper is outstanding, so the
 * desk that already extended is not asked again. It is cleared when the balloon
 * is finally resolved — paid, called, or handed back — because that is new
 * paper and a new file.
 */
const extendedTo = (r: Rival, bbl: string): number | undefined => r.extendedTo?.[bbl];
const setExtended = (r: Rival, bbl: string, m: number) => { (r.extendedTo ??= {})[bbl] = m; };
const clearExtended = (r: Rival, bbl: string) => { if (r.extendedTo) delete r.extendedTo[bbl]; };

/**
 * THE PAPER GOES WITH THE DEED — the one place that says so, called by every
 * path that takes a building off a firm.
 *
 * Eight sites remove a BBL from a rival: a sale to the player, a sale to
 * another firm, a sale to Hartford, a deed in lieu, a note holder taking title,
 * four auction outcomes, and a portfolio trade. Three of them cleared the
 * firm's per-BBL records and five did not, which is how a firm ended up with
 * eleven files open on buildings it did not own. Chasing the five would have
 * left the ninth to be written wrong later; this is the call all of them make
 * now.
 */
export function forgetDeed(r: Rival, bbl: string) {
  if (r.heldSince) delete r.heldSince[bbl];
  if (r.extendedTo) delete r.extendedTo[bbl];
  if (r.deliveredM) delete r.deliveredM[bbl];
}

/**
 * A PLAYER DEED EXTINGUISHES EVERY STREET CLAIM.
 *
 * Legitimate settlement code pays the actual seller before calling this. This
 * is the title-office backstop: if an earlier path left a stale duplicate in a
 * second rival's book, recording the player's deed removes that impossible
 * claim rather than letting two firms finance and sell the same property.
 */
export function clearRivalClaims(s: GameState, bbl: string): void {
  for (const r of s.rivals ?? []) {
    if (!r.bbls.includes(bbl)) continue;
    r.bbls = r.bbls.filter((b) => b !== bbl);
    forgetDeed(r, bbl);
  }
}

/**
 * IS THIS FIRM'S CASH FLOW SWEPT — derived from the book, not from the file
 * drawer. A desk that re-papers a maturity takes the cash flow with it and the
 * borrower stops paying his partners until the file is closed; the question is
 * therefore whether any building the firm STILL OWNS is under extended paper.
 * Asking the record map instead let a ghost freeze a firm's distributions for
 * the rest of the century.
 */
function sweptNow(r: Rival): boolean {
  if (!r.extendedTo) return false;
  for (const bbl of r.bbls) if (r.extendedTo[bbl] !== undefined) return true;
  return false;
}

/**
 * ...AND THE DRAWER IS TIDIED ANYWAY, because a map that only grows is a save
 * file that only grows, and because a firm that owes nothing has no outstanding
 * paper by definition — no balloon will ever come back to close those files, so
 * nothing else would.
 */
function pruneExtensions(r: Rival) {
  if (!r.extendedTo) return;
  if (r.debt <= 0) { delete r.extendedTo; return; }
  const own = new Set(r.bbls);
  for (const bbl of Object.keys(r.extendedTo)) if (!own.has(bbl)) delete r.extendedTo[bbl];
  if (!Object.keys(r.extendedTo).length) delete r.extendedTo;
}

/**
 * ROOM LEFT ON THE FIRM'S OWN LINE — what it can still borrow against the book.
 *
 * A rival carries one debt number, so its revolver and its mortgages are the
 * same balance sheet seen from two sides; what a line draw actually buys is not
 * cheaper money but the fact that the firm did not have to do something worse.
 * Written down once because the balloon ladder and the cash-shortfall path were
 * both asking the question and only one of them was answering it.
 *
 * TWO WALLS, AND A BORROWER STOPS AT THE NEARER. The first is the firm's own
 * covenant: its style's maximum leverage, less two points, because touching a
 * covenant is a default and nobody draws to it. The second is the credit market
 * — `streetRefiProceeds` applied to the whole book, which is the same advance
 * rate, coverage and debt-yield walk the balloon itself has to pass. A firm
 * whose income has stopped covering its debt service cannot borrow more against
 * that income however much headroom its LTV shows, and leaving that test out
 * would repeat the fault `acquisitionLoan` documents two hundred lines down:
 * a borrowing capacity read out of a personality table with no lender in the
 * room.
 *
 * WHAT IS NOT MODELLED: a revolver is dearer than a mortgage, and this engine
 * prices all of a firm's debt at one spread (RATE_SPREAD). A firm running on
 * its line therefore pays less carry here than it would in life. Fixing that
 * needs a second rate on `Rival`, which is a field this change does not own.
 */
function lineRoom(s: GameState, r: Rival, aum: number, noiYr: number, landV: number): number {
  const st = STYLE[r.style];
  const covenant = Math.round((st.maxLtv - 0.02) * aum);
  // A BORROWING BASE ADVANCES AGAINST EACH KIND OF COLLATERAL ON ITS OWN
  // TERMS. Asking the income desks to underwrite a book with a land bank in it
  // charges the dirt with a coverage test it can never pass and reads the whole
  // firm as insolvent: measured before this split, 26 of 28 developers on the
  // street died across six unplayed centuries, because a developer's book is
  // exactly the book this gets wrong. So the income property is sized at the
  // income desks and the dirt at the land loan — half leverage, short, recourse
  // — which is the same two-way split `streetRefiProceeds` already makes when
  // it is handed a site.
  const income = Math.max(0, aum - landV);
  const market = streetRefiProceeds(s, income, noiYr, st.maxLtv).principal
    + (landV > 0 ? streetRefiProceeds(s, landV, 0, st.maxLtv).principal : 0);
  return Math.min(covenant, market) - r.debt;
}

/** What the investor base could be asked for today — WITHOUT asking. */
function recallable(r: Rival): number {
  // Uncalled commitments first — money the LPs already signed for. Recalled
  // distributions second, at the style's clause. The opening roster carries no
  // uncalled tranche (their vehicles are fully invested; that is what makes
  // them the incumbents), so for them this is exactly the old expression.
  return Math.floor((r.uncalled ?? 0) + Math.max(0, r.distributed ?? 0) * RECALL[r.style]);
}

/**
 * WHICH DESK HOLDS THE PAPER ON ONE OF THEIR BUILDINGS.
 *
 * The engine does not know, and says so — the same admission
 * `chargeSponsorFailure` already makes about a dead firm's term debt, and
 * allocated by the same rule so there is one story about whose paper this is:
 * a bigger book holds more of this town's mortgages. Deterministic per
 * building so the desk that grants an extension is the desk that eats the loss
 * if the extension is refused.
 */
function deskFor(s: GameState, r: Rival, bbl: string): string {
  const live = (s.lenders ?? []).filter((l) => l.failedM === undefined);
  if (!live.length) return CONSTRUCTION_LENDER;
  const books = live.reduce((a, l) => a + l.book, 0);
  if (books <= 0) return live[0].name;
  let t = ((hash32(r.id + "@" + bbl) % 100_000) / 100_000) * books;
  for (const l of live) { t -= l.book; if (t <= 0) return l.name; }
  return live[live.length - 1].name;
}

/**
 * WHICH DESK LEADS THE WORKOUT ON A DEAD FIRM'S BOOK.
 *
 * The one holding the largest piece of it, by the same per-building allocation
 * `deskFor` makes everywhere else — a bigger book holds more of this town's
 * paper — so the bank that ends up a landlord is the bank that lent the most.
 * Exported for `portfoliosale.tickPortfolios`, which is where a receiver puts a
 * whole relationship out as one ticket. It is exported in that direction and
 * not the other because rivals.ts must not import portfoliosale.ts: that file
 * already imports this one, and a cycle between them is a temporal-dead-zone
 * bug waiting for the first module-scope const either of them adds.
 */
export function receiverDeskFor(s: GameState, parcels: ParcelTable, r: Rival): { desk: string; owed: number } {
  const by: Record<string, number> = {};
  let book = 0, best = "", bestV = -1;
  for (const bbl of r.bbls) {
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const v = assetValue(rec, s.econ, initialCondition(rec));
    by[deskFor(s, r, bbl)] = (by[deskFor(s, r, bbl)] ?? 0) + v;
    book += v;
  }
  for (const [name, v] of Object.entries(by)) if (v > bestV) { bestV = v; best = name; }
  return { desk: best, owed: Math.max(0, r.debt) };
}

/**
 * RESCUE EQUITY, AND WHY IT IS RECALLED DISTRIBUTIONS.
 *
 * A capital call is the single most common outcome of a real workout and this
 * street had no way to make one. It is also the thing that separates patient
 * old money from a merchant builder: when the balloon lands, a family office
 * writes a cheque and a builder who was paid out at his last delivery has
 * nobody left to ring.
 *
 * The well is what the vehicle has already returned to its investors, because
 * that is what an investor base will fund a protective call out of. It is not
 * a metaphor — RECALLABLE DISTRIBUTIONS are a standing provision in nearly
 * every limited partnership agreement in this business, normally capped at
 * something near 100% of what has been distributed during the investment
 * period, and this is exactly that clause. It needs no new bookkeeping because
 * `distributed` is already tracked, and it is self-limiting by construction: a
 * sponsor who has never returned a dollar cannot raise a rescue round, which
 * is true and is why the youngest, most levered shops should be the ones that
 * die rather than the ones that get bailed out.
 *
 * The share is a fact about the VEHICLE, not a dial. At the top are the ones
 * with a standing pool and a partnership agreement that lets them recall it —
 * committed funds and family capital. At the bottom are the ones with no
 * vehicle at all: a merchant builder syndicates each job and dissolves it at
 * the sale, so there is no fund to call.
 *
 * Uncalled commitments live on `Rival.uncalled` and are drawn through
 * `callCapital` before recalled distributions.
 */
const RECALL: Record<RivalStyle, number> = {
  // it is their own money and always was; the point of the vehicle is to never
  // be a forced seller
  family: 1.0, owneruser: 1.0,
  // offshore capital defending a trophy: it comes, and it comes slowly
  foreign: 0.9,
  // closed-end funds with the recall clause written into the LPA
  opportunistic: 0.8, pe: 0.8, vulture: 0.75,
  // an open-ended institutional vehicle goes back to a board, which protects an
  // existing position but wants a paper on it first
  core: 0.7,
  // a listed company issues equity, which it can always do, never wants to, and
  // is punished for
  reit: 0.6,
  // a deal-by-deal sponsor rings the investors who happen to be in THAT deal,
  // and there is no fund behind them
  developer: 0.45,
  // built to sell: the investors were cashed out at the last delivery and the
  // partnership was wound up with them
  merchant: 0.25,
  // the partners are the principal and his brother-in-law
  slumlord: 0.2,
};

/**
 * Ring the investors. Returns what actually arrived.
 *
 * A SPONSOR DOES NOT CALL MONEY HE KNOWS WILL NOT CLOSE THE GAP. The well is
 * finite and it is recallable ONCE; drawing half of it, failing anyway and
 * handing the building back burns the only rescue the vehicle had. Measured
 * over 128 balloon capital calls on six unplayed centuries, 53 of them — 41% —
 * were exactly that: money out of the partners' pockets, the gap still open, a
 * deed in lieu the same month, and a well that could no longer be drawn when it
 * would have mattered. The sufficiency test therefore lives at the CALL SITES,
 * against `recallable` above, and this function only moves money once the
 * decision has been taken.
 */
function callCapital(r: Rival, want: number): number {
  if (want <= 0) return 0;
  const got = Math.min(Math.round(want), recallable(r));
  if (got < 100_000) return 0;   // nobody convenes a partnership for pocket money
  r.cash += got;
  // UNCALLED COMMITMENTS GO FIRST — calling capital the LPs signed for is a
  // capital call; clawing back money already distributed is a lawyer's letter,
  // and no GP sends the letter while the commitment line is open.
  const fromUncalled = Math.min(got, r.uncalled ?? 0);
  if (fromUncalled > 0) r.uncalled = Math.round((r.uncalled ?? 0) - fromUncalled);
  const rest = got - fromUncalled;
  // The clawback goes back where it came from. `distributed` becomes cash NET
  // returned to the partners, which is what it should always have meant, and
  // the well cannot be drawn twice.
  if (rest > 0) r.distributed = Math.round((r.distributed ?? 0) - rest);
  return got;
}

/**
 * SELL THE ONE THAT COVERS THE HOLE, not a building drawn out of a hat.
 *
 * The old stress path picked `r.bbls[floor(rng * length)]` — a random asset,
 * every other month, at a receiver's discount, forever. A sponsor working out
 * of trouble does the opposite: he sells the SMALLEST thing that raises what
 * he needs, because everything he sells is a building he wanted to keep and
 * the core of the book is the reason the vehicle exists. Only when nothing on
 * the list covers it does he put up the biggest one.
 *
 * The price band is unchanged — a seller with a deadline gets a seller's price
 * — because the fault here was never what these buildings fetched, it was
 * which one went and how often.
 *
 * AND WHAT "RAISES WHAT HE NEEDS" MEANS IS WHAT THE CLOSING PAYS.
 *
 * The decision used to read `price * (1 - leverage)` and the settlement paid
 * `price - debt released - capital gains tax`, and the comment above the line
 * claimed the two agreed. They did not: over 1,385 forced sales across six
 * unplayed centuries the decision underwrote $5,092.8M of proceeds against
 * $3,385.3M actually received — 50% high, the whole difference being the tax —
 * and 224 of the 843 sales that were chosen BECAUSE they covered the hole
 * settled short of it, so the firm sold a building it wanted to keep and was
 * still short the following month. There is now one expression for what a
 * disposal nets and both ends read it.
 *
 * A CONSEQUENCE WORTH SAYING OUT LOUD: at high leverage and a low basis the
 * answer is NEGATIVE. Eighty cents of the price goes to the lender and a
 * quarter of the gain goes to the revenue, and the sponsor writes a cheque at
 * his own closing. That is a real position — it is why over-levered owners of
 * long-held property are frozen rather than merely poor — and a sale that
 * raises nothing is not a way out of a cash squeeze, so this refuses to make
 * it. The ladder above then does the thing that IS available: hand the keys
 * back, which costs no cash and takes the loan with it.
 */
// What a sponsor under duress gets for a building, unchanged from the path this
// replaces. Written once because the decision reads its midpoint and the ask
// draws from it, and a hardcoded 0.78 beside a `rrange(0.68, 0.88)` is the same
// band written down twice.
const DURESS_BAND: [number, number] = [0.68, 0.88];
const DURESS_MID = (DURESS_BAND[0] + DURESS_BAND[1]) / 2;

function marketAssetToRaise(s: GameState, parcels: ParcelTable, r: Rival, need: number): boolean {
  // No local leverage figure here on purpose: the debt a sale retires is
  // `debtReleasedOnSale`'s answer and nobody else's. A second copy is how the
  // decision and the closing came to disagree on 134 of 135 sales.
  let pick: { bbl: string; rec: ParcelRecord; net: number } | null = null;
  let biggest: { bbl: string; rec: ParcelRecord; net: number } | null = null;
  for (const bbl of r.bbls) {
    if (s.holdings[bbl] || s.listings.some((l) => l.bbl === bbl)) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    // What the sale actually puts in the account: the price, less the debt it
    // retires, less the tax on the gain. Both legs CALL the functions the
    // closing calls rather than restating them.
    //
    // The debt leg was `px * (1 - lev)`, which re-derives what
    // `debtReleasedOnSale` decides and gets it wrong twice: it drops that
    // function's `Math.min(r.debt, ...)` cap, so a firm whose debt is smaller
    // than its implied share appears to net less than it will, and it reads a
    // `lev` that is already months stale by settlement. Measured over 135
    // forced sales, 134 of them disagreed with the closing by more than $1,000
    // and the sponsor UNDER-wrote disposals by 56% — so `sell.net <= 0` refused
    // sales that would in fact have covered the hole and the ladder fell
    // through to handing back keys.
    //
    // This is the third kind of fake number twice over: one quantity with two
    // answers, and a header claiming "there is now one expression for what a
    // disposal nets and both ends read it" while two expressions stood. The
    // agreement it reported (+0.01% over 291 sales) was the formula compared
    // against itself — a test that cannot fail.
    const px = markAsset(s, r, rec).v * DURESS_MID;
    const net = px - debtReleasedOnSale(r, px) - gainsTaxOn(r, px);
    if (!biggest || net > biggest.net) biggest = { bbl, rec, net };
    if (net >= need && (!pick || net < pick.net)) pick = { bbl, rec, net };
  }
  const sell = pick ?? biggest;
  // A closing the sponsor has to fund is not a source of cash. See the header.
  if (!sell || sell.net <= 0) return false;
  const v = markAsset(s, r, sell.rec).v;
  const px = Math.round(v * rrange(s, ...DURESS_BAND));
  r.dumped = (r.dumped ?? 0) + 1;
  // The deed stays with them until somebody buys it — a firm selling under
  // pressure is still the owner, and that is the whole point of the trade.
  s.listings.push({ bbl: sell.bbl, ask: px, listedM: s.month, expiresM: s.month + 8, distress: true, sellerId: r.id });
  // A FIRM SELLING UNDER PRESSURE IS ALWAYS RECORDED, AND INTERRUPTS WHEN IT IS
  // ABOUT YOU. This had no gate at all — every distress listing in the city
  // filed as an `event`, 0.81 a year, most of them buildings the player had
  // never looked at. The trade still goes on the tape, because a receiver's
  // book is exactly where the buying is; it goes to the badge when the firm is
  // one you have dealt with, or the building is on a block you own on.
  const yourStreet = Object.keys(s.holdings).some((b) => parcels[b]?.block === sell.rec.block);
  const known = !!s.street?.[r.id]?.deals;
  s.news.unshift({
    q: s.month, kind: (yourStreet || known) ? "event" : "info",
    text: (r.dumped ?? 1) <= 1
      ? `${r.name} is selling. ${sell.rec.address} hits the tape at ${(px / 1e6).toFixed(2)}M — ${Math.round((1 - px / Math.max(1, v)) * 100)}% under appraisal. They are short of cash and the market knows it.`
      : `${r.name}, again: ${sell.rec.address} at ${(px / 1e6).toFixed(2)}M. That is their ${r.dumped === 2 ? "second" : r.dumped === 3 ? "third" : `${r.dumped}th`} building on the tape this stretch.`,
  });
  return true;
}

/**
 * WHAT A LENDER ASKS FOR A BUILDING IT DID NOT WANT.
 *
 * A bank holding real estate owned is not a seller at market; it is a seller at
 * whatever clears its balance sheet, and how badly it needs to clear depends on
 * its capital position. That is the whole of it, and every term in it is a
 * number this engine already has rather than a haircut chosen here.
 *
 * The two ends are both real prices:
 *
 *   A FLUSH DESK ASKS THE MARKET. It can afford to hire a broker, run a proper
 *   marketing period and wait for the right buyer, so what it wants is the
 *   building's mark. `lenderHealth` calls this one "flush and looking for
 *   paper"; `deskWillExtend` says the same thing as a boolean.
 *
 *   AN IMPAIRED DESK ASKS THE LOAN BASIS. Not a cent less and not a cent more:
 *   selling at the carrying value is the number that makes the charge-off go
 *   away, and its regulator is reading the same page. Where the loan is
 *   underwater the basis is above the market and it takes the market anyway,
 *   because it needs the asset gone more than it needs the number — so the ask
 *   is bounded by the mark either way.
 *
 * `lenderPressure` interpolates: 0 at 1.15x the desk's own capital target, 1 at
 * 0.30x, and it sits below target 25.4% of the time and below 0.7x 5.5% (the
 * measurement is in lenders.ts). So the discount a buyer gets is
 * `pressure x (mark - basis)` and it is ZERO from a healthy bank — which is why
 * the buying window opens when the banks are broken and not before, and why the
 * fattest discounts come off the books of desks that foreclosed a CONSERVATIVE
 * borrower, whose loan basis was low to begin with.
 *
 * There is no floor and no invented band. The previous version asked
 * `mark x rrange(0.72, 0.88)` regardless of who was holding it, which is a
 * constant chosen to make a distress sale look like a distress sale.
 *
 * Measured over 317 receiver listings on three unplayed centuries: the discount
 * off the mark runs p50 0.0%, p90 11.9%, maximum 30.0%, and 66% of them carry
 * no discount at all because the desk behind them was fine. `lenderPressure` is
 * above zero 32.9% of lender-months and pinned at 1 in its top decile, so the
 * window is real, it is not always open, and it is widest in exactly the years
 * the whole street is failing. That is the shape a buying opportunity should
 * have: it is not a bonus, it is somebody's bank in trouble.
 */

/** How long a desk gives it. A bank with capital markets it properly; one with
 *  the examiners in the building wants it off the books this quarter. */
function reoWindow(s: GameState, lender: string): number {
  const p = lenderPressure(lenderByName(s, lender));
  return Math.round(rrange(s, 6, 12, "rivals") + (1 - p) * 6);
}

/**
 * HAND ONE BACK.
 *
 * The civilised exit, and the one thing a sponsor can always do that a forced
 * sale cannot: it needs no buyer, no marketing period and no cash. The keys go
 * to the desk that holds the paper, the loan goes with them, and because the
 * debt is non-recourse whatever the building is short by is the LENDER'S loss
 * — which is the entire economic content of non-recourse and was previously
 * something only the player could do (workout.deedInLieu).
 *
 * WHICH BUILDING: the one the market likes least. A sponsor keeps what he can
 * refinance and gives away what he cannot, so the choice is made on the ratio
 * of what a desk will lend against the asset today to what the asset is
 * marked at — the same `streetRefiProceeds` that decides the maturity itself,
 * asked of every building on the list.
 *
 * The building goes on the tape as the bank's, not the firm's: no `sellerId`,
 * because the firm no longer owns it and negotiating with them for it would be
 * negotiating with somebody who has nothing to sell.
 */
function deedInLieu(s: GameState, parcels: ParcelTable, r: Rival, why: string): boolean {
  const lev = (r.aum ?? 0) > 0 ? Math.max(0, r.debt / (r.aum as number)) : r.targetLtv;
  const st = STYLE[r.style];
  let worst: { bbl: string; rec: ParcelRecord; v: number; ratio: number } | null = null;
  for (const bbl of r.bbls) {
    if (s.holdings[bbl]) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const { v, noi } = markAsset(s, r, rec);
    if (v <= 0) continue;
    const ratio = streetRefiProceeds(s, v, noi, st.maxLtv).principal / v;
    if (!worst || ratio < worst.ratio) worst = { bbl, rec, v, ratio };
  }
  if (!worst) return false;
  const desk = deskFor(s, r, worst.bbl);
  const owed = Math.min(r.debt, Math.round(worst.v * lev));

  r.bbls = r.bbls.filter((b) => b !== worst!.bbl);
  forgetDeed(r, worst.bbl);
  r.debt = Math.max(0, r.debt - owed);
  // The book shrinks with it. Basis is aggregate, so it comes off by the share
  // this building was — the same estimate `gainsTax` makes on a sale.
  const basis = r.basis ?? 0;
  r.basis = Math.max(0, Math.round(basis - basis / Math.max(1, r.bbls.length + 1)));
  s.listings = s.listings.filter((l) => l.bbl !== worst!.bbl);
  // What the desk asks for it, and it is a fact about the DESK. See reoAsk: a
  // bank with capital markets it and wants the mark; one with a regulator in
  // the building wants the loan off the books at whatever it is carried at.
  const ask = reoAsk(s, worst.v, owed, desk);
  const loanBasis = Math.min(worst.v, Math.max(0, owed));
  s.listings.push({
    bbl: worst.bbl, ask, listedM: s.month,
    expiresM: s.month + reoWindow(s, desk), distress: true, receiverFor: desk, reason: "receiver",
    loanBasis,
  });
  chargeLenderLoss(s, desk, Math.max(0, owed - ask));
  const off = Math.max(0, 1 - ask / Math.max(1, worst.v));
  s.news.unshift({
    q: s.month, kind: "warn",
    text: `${r.name} has handed ${worst.rec.address} back to ${desk}. ${why} `
      + `The paper was non-recourse, so the ${(Math.max(0, owed - ask) / 1e6).toFixed(2)}M it is short is the bank's problem, not theirs. `
      + (off > 0.06
        ? `${desk} has put it straight out at ${(ask / 1e6).toFixed(2)}M — ${(off * 100).toFixed(0)}% under the mark, which is the loan and not the value. `
          + `They are not pricing the building, they are clearing the balance sheet. `
        : `${desk} has the capital to market it properly, so it goes out at ${(ask / 1e6).toFixed(2)}M and there is no bargain in it. `)
      + `They still own ${r.bbls.length} building${r.bbls.length === 1 ? "" : "s"}.`,
  });
  recordPropertyEvent(s, worst.bbl, {
    kind: "default",
    party: `${r.name} / ${desk}`,
    amount: owed,
    outcome: `deed in lieu; ${desk} took title`,
  });
  return true;
}

/**
 * THE BALLOONS THAT LAND THIS MONTH.
 *
 * Every building whose paper comes due gets sized again from scratch, at the
 * same three desks and on the same three tests the player's own balloon walks
 * — `streetRefiProceeds`, which is `quote` with the two tests that are facts
 * about the PLAYER lifted off. So when a bank is impaired the street cannot
 * refinance either, which is the entire reason the banks were given books.
 *
 * The gap between what is owed and what the market will write is real money
 * and it is due now. AND THE ORDER IS THE ORDER A SPONSOR ACTUALLY WORKS IT:
 * pay it out of cash, draw the corporate line, ask the desk to extend, ring the
 * investors, hand it back. Only the last of those loses a building, and none of
 * them is a failure — a firm that shrinks at a maturity is a firm that survived
 * one.
 *
 * THE LINE COMES BEFORE THE PHONE CALL, and it did not. The balloon was tested
 * against cash on hand alone, so a firm with room on its own covenant walked
 * the whole ladder — fee, capital call, keys — with the money sitting there
 * undrawn. Measured over 2,375 balloon gaps on six unplayed centuries: 515 of
 * them, 21.7%, reached the extension-or-worse rungs with enough covenant room
 * to have covered the gap outright. Nobody hands a building back while their
 * revolver is undrawn.
 *
 * AND MOST OF THAT ROOM TURNED OUT NOT TO BE THERE. Re-measured with `lineRoom`
 * asking the second question as well — what a desk would actually advance
 * against the book's own income — 17.7% of gaps still show covenant room and
 * only 3.0% clear both walls and get covered by the line. The other four fifths
 * are firms whose LTV looked fine and whose income had stopped supporting more
 * debt, which is the condition a revolver is supposed to detect and the reason
 * this rung is a real rung rather than a free pass.
 */
function tickMaturities(s: GameState, parcels: ParcelTable, r: Rival, aum: number, noiYr: number, landV: number) {
  if (r.debt <= 0 || aum <= 0 || !r.bbls.length) return;
  const st = STYLE[r.style];
  // The mortgage on one asset is the leverage actually on the book — the same
  // proxy `debtReleasedOnSale` uses at a closing, for the same reason, so a
  // building's loan is one number rather than two.
  const lev = Math.max(0, r.debt / aum);
  for (const bbl of [...r.bbls]) {
    const term = loanTermM(r, bbl);
    // WHICH CLOCK THIS BUILDING IS ON. Extended paper has a date of its own and
    // it is a short one; everything else sits on the term ladder derived from
    // when the deed arrived. See `extendedTo`.
    const ext = extendedTo(r, bbl);
    if (ext !== undefined) {
      if (s.month < ext) continue;                // inside the forbearance
    } else {
      const held = s.month - originM(r, bbl, term);
      if (held <= 0 || held % term !== 0) continue;
    }
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const { v, noi } = markAsset(s, r, rec);
    // A firm cannot owe more on one building than it owes altogether. That is
    // the only bound needed here — no cap on leverage, which would be a rail
    // rather than a fact, because a book marked below its debt is a real
    // condition and the whole point of this block is that it is survivable.
    const due = Math.min(r.debt, Math.round(v * lev));
    if (due <= 0) continue;
    const refi = streetRefiProceeds(s, v, noi, st.maxLtv);
    const gap = due - refi.principal;
    // Rolled, and nobody hears about it. If this was extended paper the file
    // closes with it: the loan has been refinanced and the building goes back
    // on the ordinary term ladder.
    if (gap <= 0) { clearExtended(r, bbl); continue; }

    // 1. WRITE THE CHEQUE. A balloon is paid before a reserve is kept.
    if (r.cash >= gap) { r.cash -= gap; r.debt = Math.max(0, r.debt - gap); clearExtended(r, bbl); continue; }

    // 2. DRAW THE LINE. A corporate facility against the whole book is not the
    //    same money as a mortgage against one building: the desk that would not
    //    write the balloon is underwriting THAT asset's coverage, and the line
    //    is underwritten on the firm's leverage. A sponsor with covenant room
    //    left draws it and re-papers the shortfall, because the alternatives on
    //    this list all cost him something and this one costs him headroom.
    //
    //    On these books that is the whole of it: a rival carries one debt
    //    number, so drawing the gap and paying the balloon with it nets to
    //    nothing on the balance sheet — the same total owed, moved from a
    //    mortgage to a line — and everything is in what did not happen: no fee,
    //    no capital call, no keys. The firm's cash is deliberately left alone,
    //    because a sponsor plugs a maturity out of the facility rather than
    //    running the operating account to zero and missing a payment next
    //    month. See `lineRoom` for the two walls, and for what this does NOT
    //    model, which is that a revolver is dearer than a mortgage.
    const room = lineRoom(s, r, aum, noiYr, landV);
    // What has to be found. `r.cash` and not `max(0, r.cash)`: an account that is
    // already overdrawn needs the overdraft covered too, and reading it as zero
    // meant a capital call sized to the balloon alone left the firm short by the
    // arrears it already had.
    const short = gap - r.cash;
    if (room >= gap) {
      r.revolver = (r.revolver ?? 0) + gap;
      clearExtended(r, bbl);
      continue;
    }

    // 3. ASK THE DESK. A bank with capital would far rather carry a performing
    //    loan than own a building; one that is impaired has a regulator
    //    reading the same balance sheet it is. That test is `deskWillExtend`
    //    and it is the same test the player's forbearance request runs.
    //
    //    ONCE PER BUILDING, which is the rule the player already lives under —
    //    `requestForbearance` refuses a second ask on the same file, because
    //    nobody extends twice. `ext !== undefined` means this paper has already
    //    been re-papered once and the desk is out of patience.
    const desk = deskFor(s, r, bbl);
    if (ext === undefined && deskWillExtend(s, desk)) {
      // Modification paper is not free, and the point the desk charges is the
      // point it charges the player — `extensionFeePct`, one answer for both
      // borrowers. It is capitalised, which is what a desk does when the
      // borrower plainly has no cash, and it is why an extended loan comes back
      // bigger than it went in.
      r.debt = Math.round(r.debt + due * extensionFeePct(s, desk));
      const until = s.month + extensionMonths(s);
      setExtended(r, bbl, until);
      // AND IT DOES NOT ALSO FORCE A FIRE SALE. This branch used to call
      // `marketAssetToRaise` on the spot — a distress listing, at a receiver's
      // discount, in the same tick as the extension that made it unnecessary,
      // on a firm that in 629 of 965 cases had cash in the bank and was not in
      // arrears at all. It was also the only path that could reach a firm with
      // positive cash, and `r.dumped` is only reset in the stressed arm, so the
      // counter ran to 22 on a healthy shop and the tape announced "their 22nd
      // building on the tape this stretch" about a firm that was not in one.
      // What an extension buys is TIME, and what a sponsor does with time is
      // sweep the cash flow — see the distribution test in tickRivals, which
      // stops paying the partners while any paper of theirs is extended.
      if (newsChance(s, "refi:" + r.id, 0.25)) {
        s.news.unshift({
          q: s.month, kind: "event",
          text: `${r.name} could not refinance ${rec.address} in full — ${desk} would write ${(refi.principal / 1e6).toFixed(1)}M against ${(due / 1e6).toFixed(1)}M outstanding, `
            + `bound by ${refi.binding}. The desk re-papered it to ${monthLabel(until)} rather than take the keys, and the cash flow is swept until then. `
            + `They are ${(gap / 1e6).toFixed(1)}M short and they have bought ${Math.round((until - s.month) / 12 * 10) / 10} years, not a solution.`,
        });
      }
      continue;
    }

    // 4. RING THE INVESTORS — and only for money that closes the gap. A
    //    protective call is the one rescue a vehicle gets and it is recallable
    //    once; see callCapital for what drawing it into a hole it cannot fill
    //    was costing.
    if (recallable(r) >= short) {
      const got = callCapital(r, short);
      if (got > 0 && r.cash >= gap) {
        r.cash -= gap;
        r.debt = Math.max(0, r.debt - gap);
        clearExtended(r, bbl);
        if (newsChance(s, "balloon:" + bbl, 0.4)) {
          s.news.unshift({
            q: s.month, kind: "event",
            text: `${r.name} has called ${(got / 1e6).toFixed(1)}M from their partners to clear the balloon on ${rec.address}. `
              + `The money that went out over the years is going back in. That is what an investor base is FOR, and it is why the old houses outlast the clever ones.`,
          });
        }
        continue;
      }
    }

    // 5. HAND IT BACK. No buyer needed, no cash needed, and the shortfall is
    //    the bank's — which is what non-recourse means.
    clearExtended(r, bbl);
    deedInLieu(s, parcels, r,
      `The balloon came due and nobody would refinance it: ${(refi.principal / 1e6).toFixed(1)}M against ${(due / 1e6).toFixed(1)}M outstanding.`);
    return;   // one workout at a time; the rest of the ladder is next month's problem
  }
}

export function tickRivals(s: GameState, parcels: ParcelTable) {
  if (!s.rivals?.length) return;
  const ci = Math.max(0.4, Math.min(1.25, s.econ.creditIdx ?? 1));
  const rate = s.econ.indexRate + RATE_SPREAD;
  tickRivalSpinouts(s);
  maybeNewFirm(s);
  // fundJobs runs earlier in tickMonth — before tickEcon settles deliveries —
  // so schedule slips and orphans are visible to the space market. Cash draws
  // already landed; the solvency test below reads the same balances.
  orphanToTape(s, parcels);
  rescueOrphan(s, parcels, ci);

  for (const r of s.rivals) {
    // THE WORKOUT. A failed firm does not evaporate — a receiver holds the
    // book and sells it down over years, because dumping a hundred buildings
    // into one month would clear at nothing and everybody knows it. Releasing
    // them a couple at a time is both what happens and what keeps a failure
    // from handing the whole market a year of free money: the first version of
    // this listed the entire portfolio at once, and the resulting flood of
    // sixty-cent buildings made the most reckless strategy in the audit the
    // best one again.
    if (r.failedM !== undefined) {
      if (!r.bbls.length) continue;
      // WHAT THE RECEIVER IS CARRYING IT AT. The desks took the whole book
      // against what was still owed, so the basis in any one building is its
      // share of that debt by value — the same allocation `chargeSponsorFailure`
      // uses to decide whose loss it was, because it is the same question.
      let book = 0;
      for (const b of r.bbls) {
        const rr = resolveRec(parcels, s, b);
        if (rr) book += assetValue(rr, s.econ, initialCondition(rr));
      }
      let release = 1 + Math.floor(rng(s, "rivals") * 2);
      while (release-- > 0 && r.bbls.length) {
        const bbl = r.bbls[Math.floor(rng(s, "rivals") * r.bbls.length)];
        // A building already inside a receiver's package is not also on the
        // tape on its own.
        if ((s.portfolios ?? []).some((pf) => pf.bbls.includes(bbl))) continue;
        // KEEP THE DEED UNTIL IT CLOSES. This stripped the building out of the
        // firm's book one line BEFORE pushing the listing, so ownerOf returned
        // null and the negotiation fell through to an anonymous hash. Measured:
        // of 348 distress listings a run, five carried a name. The two moments
        // a rival is most interesting — under duress, and dead — were the exact
        // two where the game took their name off the ticket.
        if (s.holdings[bbl] || s.listings.some((l) => l.bbl === bbl)) continue;
        const rec = resolveRec(parcels, s, bbl);
        if (!rec) continue;
        const v = assetValue(rec, s.econ, initialCondition(rec));
        // AND THE PRICE IS THE DESK'S, NOT A BAND. What a receiver asks is what
        // clears the balance sheet of the bank behind it, and how badly it needs
        // to clear is `lenderPressure` — see reoAsk. A flush desk holding a dead
        // firm's building markets it properly and there is no bargain in it; an
        // impaired one puts it out at the loan, which is where the best buying
        // in this business has always come from.
        const desk = deskFor(s, r, bbl);
        const basis = book > 0 ? Math.round(r.debt * (v / book)) : r.debt;
        const loanBasis = Math.min(v, Math.max(0, basis));
        s.listings.push({
          bbl, ask: reoAsk(s, v, basis, desk),
          listedM: s.month, expiresM: s.month + reoWindow(s, desk), distress: true,
          sellerId: r.id, receiverFor: r.name,
          reason: "receiver",
          loanBasis,
        });
      }
      continue;
    }
    const st = STYLE[r.style];
    tickAssetManagement(s, parcels, r);
    startOwnJob(s, parcels, r, ci);
    const { aum, noiYr, landV } = markRival(s, parcels, r);
    r.aum = Math.round(aum);
    // Absorption / rivalBuys used to call markRival again for every bidder on
    // every trade the same month — a second full walk of the street's book.
    // Publish the mark here; buyers read it off the firm.
    r.markNoi = noiYr;
    r.markLand = landV;

    // --- the money -------------------------------------------------------
    // NOI in, interest and amortisation out. A firm this size amortises on a
    // thirty-year schedule; nobody gets pure interest-only forever.
    const interest = (r.debt * rate) / 100 / 12;
    const amort = r.debt > 0 ? (r.debt * AMORT_SHARE[r.style]) / (30 * 12) : 0;
    // Their dry powder sits in the same bank yours does, at the same dull one
    // per cent. It was earning nothing at all before, which meant every month a
    // firm spent waiting for a cycle cost it something the player was not
    // paying — and dry powder is a real position on this street.
    const onDeposit = r.cash > 0 ? (r.cash * CASH_APY) / 12 : 0;
    r.cash += Math.round(noiYr / 12 - interest - amort + onDeposit);
    r.debt = Math.max(0, Math.round(r.debt - amort));

    // THE SAME OVERHEAD THE PLAYER CARRIES. Asset management, accounting,
    // audit, legal, somebody to answer the phone. It is not billable to a
    // building and it never goes away, and the street was not paying it —
    // which over a century is most of the reason their books outran yours.
    // Identical formula to the player's: a small fixed base plus ~28bps of
    // gross asset value a year, sub-linear because the tenth building is
    // cheaper to run than the first.
    if (r.bbls.length > 0) {
      r.cash -= Math.round((60_000 * s.econ.costIdx + 0.0028 * aum) / 12);
    }

    // AND THE SAME TAX. Once a year, on income after interest and
    // depreciation, at the rate the player pays. Depreciation is estimated off
    // the book rather than tracked per building — improvements are roughly
    // seven tenths of value over a blended life.
    if (s.month > 0 && s.month % 12 === 0) {
      const depr = (r.basis ?? aum) * 0.7 / 33;
      const taxable = noiYr - interest * 12 - depr;
      if (taxable > 0) {
        const tax = Math.round(taxable * 0.25);
        r.cash -= tax;
        r.taxPaid = (r.taxPaid ?? 0) + tax;
      }
    }

    // --- the refinancing cliff -------------------------------------------
    // Before anything is paid out, because a balloon landing this month is a
    // call on this month's cash and the partners are behind the bank.
    tickMaturities(s, parcels, r, aum, noiYr, landV);
    // The maturities are where a file gets closed; this closes the ones no
    // maturity will ever reach, because the building left or the debt did.
    pruneExtensions(r);
    // Leverage as it stands after the maturities, which is what everything
    // below has to read — a firm that just paid down a balloon or handed a
    // building back is not the firm `markRival` marked at the top of the tick.
    const lev = aum > 0 ? r.debt / aum : r.debt > 0 ? 9 : 0;

    // DISTRIBUTIONS. Every firm here answers to somebody — partners, a family,
    // a pension board — and none of them let a hundred years of free cash flow
    // sit in a bank account. A shop holds a working reserve and sends the rest
    // out the door, and that is why dry powder is a real constraint on a real
    // firm rather than an ever-growing number. Without it these balance sheets
    // compounded into tens of billions of idle cash, which made every firm
    // unkillable and every bidding war a foregone conclusion.
    // A DEVELOPER HOLDS POWDER, because a developer's product is a hole in the
    // ground that eats money for three years. Distributing down to a core
    // fund's working reserve is how a builder ends up unable to break ground
    // on anything — which is exactly what the street was doing.
    // Powder is held for the next job or two, not as a share of a book that
    // compounds forever — an unbounded ratio on a billion-dollar balance sheet
    // is a war chest nobody can outbid, which is not dry powder, it is a bug.
    const reserve = Math.min(
      r.style === "developer" ? 45_000_000 : 30_000_000,
      Math.max(2_000_000, aum * (
        r.style === "developer" ? 0.16 : r.style === "family" ? 0.09 : r.style === "core" ? 0.06 : 0.045)),
    );
    const building = (s.cityJobs ?? []).some((j) => j.firmId === r.id && !j.orphaned);
    // EXTENDED PAPER IS SWEPT PAPER, and it is swept here. The player's own
    // forbearance sets `loan.sweep = true` and the phrase in that news line is
    // the same phrase: a desk that re-papers a maturity it was not repaid takes
    // the cash flow with it, and the borrower stops paying his partners until
    // the file is closed. Without it an extension was time for nothing — the
    // firm went on distributing 35% of its surplus every month it was in
    // forbearance, which is not something a workout desk has ever allowed.
    const swept = sweptNow(r);
    if (r.cash > reserve && !r.stressMs && !building && !swept) {
      const out = Math.round((r.cash - reserve) * 0.35);
      r.cash -= out;
      r.distributed = (r.distributed ?? 0) + out;
    }

    // --- the overreach ---------------------------------------------------
    // Cheap money is a temptation and it is supposed to be taken. A firm that
    // refinances equity out at the top has more to buy with and less to lose
    // it with — which is exactly the trade that kills them two phases later.
    //
    // AND THE DESK HAS TO WRITE THE CHEQUE. This used to invent
    // `(maxLtv − lev) × aum` of debt with no lender — the same "personality
    // LTV, no coverage" bug acquisitionLoan already fixed for purchases.
    // Opportunistic/PE shops printed boom powder no desk would have funded,
    // then died on the coupon. Cap the cash-out at what `lineRoom` will still
    // advance against the book's own income.
    if (st.cashOut > 0 && ci > 1.02 && lev < st.maxLtv - 0.06 && rng(s, "rivals") < 0.06 * st.cashOut) {
      const styleRoom = Math.round((st.maxLtv - 0.04 - lev) * aum);
      const deskRoom = Math.max(0, lineRoom(s, r, aum, noiYr, landV));
      const room = Math.min(styleRoom, deskRoom);
      if (room > 1_000_000) {
        r.debt += room;
        r.cash += room;
      }
    }

    // --- taking profits --------------------------------------------------
    // Nobody accumulates for a hundred years without ever selling. A firm
    // trims into strength — it is where their returns are realised, it is what
    // their investors are waiting for, and it is why there is anything on the
    // tape in a good market at all. Without it the street simply ate the city.
    const hot = s.econ.phase === "peak" || s.econ.phase === "expansion";
    // THE CLOCK, and it is the loudest personality difference on this street.
    //
    // Trimming into strength is what every firm does. What a fund with a life
    // does INSTEAD is sell because the fund is five years old, and it will do
    // that into a bad market, at a bad price, because an internal rate of
    // return is a function of TIME and the deadline does not care what the
    // market is doing. A merchant builder is the same story on a shorter fuse:
    // the fee was in the delivery and a building he still owns at year four is
    // a mistake. That is what puts good assets on the tape in a downturn, and
    // it is why the patient money on the other side of these tables — the
    // family office, the owner-user, the offshore buyer, none of whom have a
    // clock at all — ends up owning the best of this city.
    const stH = STYLE[r.style];
    let forcedBbl = null;
    if (stH.holdM > 0 && !r.stressMs) {
      let oldest = -1;
      for (const bbl of r.bbls) {
        // TWO ANSWERS TO ONE QUESTION, and it is deliberate that only one of
        // them is being fixed here. `originM` dates an undated opening-roster
        // deed by spreading it back across the loan term; this reads `bornM`.
        // Both are guesses at a history the game does not model, and they do
        // not agree. Measured before leaving it: firm listings by year run
        // 2/16/17/64/42/87/62/89 over the first eight years with no spike where
        // the opening book crosses its hold clock, because this path lists one
        // building per firm per month and self-limits. Undated MID-GAME deeds
        // were the real fault — a courthouse purchase read as owned since the
        // firm opened — and those are dated at the source now.
        const since = r.heldSince?.[bbl] ?? r.bornM ?? 0;
        const held = s.month - since;
        const delivered = r.deliveredM?.[bbl];
        // Merchant-built product is sold when it has seasoned and the book is
        // stabilised, not on an arbitrary birthday. Eighteen months is the
        // minimum marketing/lease-up proof; 42 months remains the fund's hard
        // deadline if occupancy never reaches 80%. Acquired assets and every
        // other style keep their ordinary hold clocks.
        const mandateReady = r.style === "merchant" && delivered !== undefined
          ? merchantExitReady(r, bbl, s.month)
          : held >= stH.holdM;
        if (mandateReady && held > oldest && !s.holdings[bbl] && !s.listings.some((l) => l.bbl === bbl)) {
          oldest = held; forcedBbl = bbl;
        }
      }
    }
    if (forcedBbl) {
      const rec = resolveRec(parcels, s, forcedBbl);
      if (rec) {
        const v = assetValue(rec, s.econ, assetGrade(r, rec));
        // QUIET TREATY. Patient capital and offshore money often sell without
        // ever hitting the tape — the century report found 0/57k deeds flagged
        // off-market while the weighting branch sat dead. About two in five
        // mandate exits for those styles close privately to another firm.
        const quietStyle = r.style === "family" || r.style === "foreign" || r.style === "core";
        if (quietStyle && rng(s, "rivals") < 0.40) {
          const price = Math.round(v * rrange(s, 0.96, 1.06, "rivals") / 1000) * 1000;
          const buyer = rivalBuys(s, parcels, rec, price);
          if (buyer) {
            // rivalBuys already recorded a marketed comp — restamp the flag.
            const c = s.comps?.[s.comps.length - 1];
            if (c && c.bbl === rec.bbl && c.m === s.month) c.offMarket = true;
            if (stakeIn(s, parcels, rec, r.id) && rng(s, "rivals") < 0.25) {
              s.news.unshift({
                q: s.month, kind: "deal",
                text: `${r.name} sold ${rec.address} quietly to ${buyer.name} — never listed.`,
              });
            }
          } else {
            // Nobody would take it privately; fall through to the open tape.
            s.listings.push({
              bbl: forcedBbl,
              ask: Math.round(v * rrange(s, 0.94, 1.04, "rivals") / 1000) * 1000,
              listedM: s.month, expiresM: s.month + Math.round(rrange(s, 9, 16, "rivals")),
              sellerId: r.id,
              reason: "fund-life",
            });
          }
        } else {
          // A seller against a deadline does not get to hold out for a number.
          s.listings.push({
            bbl: forcedBbl,
            ask: Math.round(v * rrange(s, 0.94, 1.04, "rivals") / 1000) * 1000,
            listedM: s.month, expiresM: s.month + Math.round(rrange(s, 9, 16, "rivals")),
            sellerId: r.id,
            reason: r.style === "merchant" ? "merchant" : "fund-life",
          });
          // AND A ROUTINE LISTING IS NOT NEWS EITHER. A fund reaching the end of
          // its hold and putting a building up is the most ordinary thing on this
          // street; it was running at 3.1 items a year, every one of them about a
          // corner the player had never looked at. Same rule as the trades — see
          // stakeIn. The listing itself still appears on the tape, which is where
          // a buyer looks for buildings.
          if (stakeIn(s, parcels, rec, r.id) && rng(s, "rivals") < 0.30) {
            s.news.unshift({
              q: s.month, kind: "deal",
              text: `${r.name} has put ${rec.address} on the market. `
                + (r.style === "merchant"
                  ? "They build to sell; they were never going to keep it."
                  : `The fund is ${Math.round((s.month - (r.heldSince?.[forcedBbl] ?? 0)) / 12)} years into this one and the clock has run out — `
                    + `they are selling into ${s.econ.phase === "recession" || s.econ.phase === "depression" ? "a market that does not want it" : "this market"} because the mandate says so.`),
            });
          }
        }
      }
    }
    // Soft books trim harder — empty floors are a reason to sell, not a
    // reason to sit on 65 buildings like Wrenfield in the century report.
    const softBook = (r.occ ?? 1) < (r.mktOcc ?? 1) - 0.05;
    // Thicker tape: slightly higher trim hazard, and books of 5+ (was 7+) can
    // put a weak ticket out — same rng() call, lower length gate.
    const trimBase = (hot ? 0.07 : 0.018) * (softBook ? 1.85 : 1)
      * (r.style === "family" || r.style === "owneruser" || r.style === "foreign" ? 0.25 : 1);
    if (r.bbls.length > 4 && !r.stressMs && rng(s, "rivals") < trimBase) {
      // Sell the WEAKEST ticket, not a random one: lowest mark yield, and
      // off-mandate classes first. Random trim put good assets on the tape
      // while dogs stayed on the book.
      let bbl: string | null = null;
      let worst = Infinity;
      for (const b of r.bbls) {
        if (s.holdings[b] || s.listings.some((l) => l.bbl === b)) continue;
        const recB = resolveRec(parcels, s, b);
        if (!recB || recB.class === "land" || !recB.bldgArea) continue;
        const vB = Math.max(1, assetValue(recB, s.econ, assetGrade(r, recB)));
        const noiB = Math.max(0, noiAfterTaxYr(recB, s.econ, assetGrade(r, recB), vB));
        const yld = noiB / vB;
        const offMandate = st.classes && !st.classes.includes(recB.class) ? -0.04 : 0;
        const score = yld + offMandate;
        if (score < worst) { worst = score; bbl = b; }
      }
      if (!bbl) bbl = r.bbls[Math.floor(rng(s, "rivals") * r.bbls.length)];
      const rec = resolveRec(parcels, s, bbl);
      if (rec && !s.holdings[bbl] && !s.listings.some((l) => l.bbl === bbl)) {
        const v = assetValue(rec, s.econ, assetGrade(r, rec));
        // THE CORNER COMES BACK. If this is a building they took out from
        // under a live negotiation of yours, it does not hit the tape — they
        // ring you first, because a firm that knows you wanted it once knows
        // you are the shortest route to a clean close. This is the whole payoff
        // of losing a deal to somebody with a name.
        const beat = (s.beaten ?? []).find((b) => b.bbl === bbl && b.firmId === r.id);
        if (beat && !s.approaches[bbl]) {
          const ask = Math.round(v * rrange(s, 1.02, 1.16, "rivals") / 1000) * 1000;
          // THE SAME RULE THE BROKER'S PHONE OBEYS. This channel always prices
          // over appraisal — that is what the grudge is worth to them — so it
          // is exactly the one the owner's rule is about: never pitch a
          // principal above appraisal on an ordinary yield. If the number does
          // not stand up against the tape they still sell it, they just sell it
          // the ordinary way instead of ringing you first. See `worthTheCall`.
          //
          // Stamped before it is judged, for the reason written out in
          // tickBrokerCalls: the gate reads the disclosed roll, and judging
          // before stamping would underwrite the class model and then hand the
          // player the real one.
          s.approaches[bbl] = stampApproach(s, rec, { q: s.month, refused: false, ask, inbound: true });
          if (!worthTheCall(s, parcels, rec, bbl, ask, v)) { delete s.approaches[bbl]; continue; }
          s.news.unshift({
            q: s.month, kind: "deal",
            text: `${r.name} is letting go of ${rec.address} — the corner they came over the top of you for in ${monthLabel(beat.m)}. `
              + `They paid ${(beat.theirs / 1e6).toFixed(2)}M; they will take ${(ask / 1e6).toFixed(2)}M, and they are showing it to you before the tape.`,
          });
          continue;
        }
        // a willing seller asks a willing seller's price — and puts their name
        // on the listing, the same as a fund-life exit does.
        s.listings.push({
          bbl, ask: Math.round(v * rrange(s, 1.00, 1.14, "rivals") / 1000) * 1000,
          listedM: s.month, expiresM: s.month + Math.round(rrange(s, 6, 12, "rivals")),
          sellerId: r.id,
          reason: "voluntary",
        });
      }
    }

    // --- trouble ---------------------------------------------------------
    // ONE WAY TO DIE, AND IT IS THE ONLY ONE A LENDER CAN ACT ON: they stopped
    // paying. The mark-to-market test that used to sit here — `ltvNow >
    // maxLtv + 0.05` for thirty months and the firm was struck off — is not a
    // term in any mortgage. A borrower current on debt service does not
    // default because a valuer revised an opinion, and the measurement said
    // that is exactly what was happening: the dying cohort was at 0.39
    // leverage with money in the bank five years out and was killed by a 44%
    // fall in the whole city's marks. See the block above `TERM_DESKS`.
    //
    // What is left is the honest test and it is severe enough on its own: NOI
    // does not cover interest, the line has no room left on it, and nobody
    // will put more equity in. That is a firm that cannot pay, and the clock
    // that runs on it is the same statute and the same court calendar the
    // player's own default runs on — NOTICE_M to cure, FORECLOSE_M once they
    // have filed. There is not one foreclosure calendar for you and a
    // different invented one for them.
    // AND A FIRM WITH NOTHING LEFT TO SELL GOES ON THE SAME CLOCK, NOT OFF A
    // CLIFF.
    //
    // This used to strike a firm off the month its book emptied and its debt
    // exceeded its cash — no notice period, no cure, no missed payment. It was
    // written to close a real hole (a bookless firm escaped the old stress test
    // forever, because that test only ran while there were buildings to sell),
    // and it closed it by inventing a second way to die that the paragraph
    // above says does not exist.
    //
    // Measured, 6 seeds x 100 years with the world kept alive: 135 deaths, 75
    // through the notice-and-foreclose calendar and 60 — 44% — through that
    // line. THIRTY-THREE of those 60 had `stressMs === 0`: they had never
    // missed a payment. The route was direct, because deed-in-lieu fires while
    // a firm is current: 357 of 505 handbacks happened with cash at or above
    // zero, 105 of them on a firm holding exactly one building. Give the last
    // building back at a balloon and this line struck you off the same month.
    //
    // Swapping "your LTV got high" for "your book got small" is not what was
    // asked for, and the old test at least gave thirty months.
    //
    // A borrower with no collateral and money still owed is not dead. He is
    // unsecured, and unsecured debt is collected on a calendar: the same
    // NOTICE_M to cure and FORECLOSE_M to file that everyone else gets. With no
    // buildings there is no NOI, so interest and amortisation drain the account
    // every month (see the debt service above, which is charged whether or not
    // anything is standing) — the clock still runs out, and quickly. It is now
    // legible as a wind-up rather than a disappearance.
    // THE REVOLVER.
    //
    // A cash shortfall is not a failure while there is room on the book, and
    // no firm in this business has ever sold a building at sixty-eight cents
    // because it was forty thousand dollars short in March. It draws on its
    // line, up to its own covenant, and it deals with the problem when the
    // problem is a real one.
    //
    // Without this the stress path fired on `cash < 0` while a firm's LTV was
    // FALLING — a shop amortising itself into a squeeze was marked distressed,
    // fire-sold for thirty months and died solvent. Measured: twelve firms
    // failed per fifty-year run and the two styles that actually compete with
    // the player were extinct nine years in ten.
    //
    // AND THE ROOM IS `lineRoom`, which is now the same question asked in the
    // same place the balloon ladder asks it — two walls, the firm's covenant
    // and what the market will advance against the book's own income. It used
    // to be the covenant alone, which is a borrowing capacity read out of a
    // personality table with no lender in the room; a firm whose income has
    // stopped covering its debt service cannot draw a line either.
    if (r.cash < 0 && r.bbls.length) {
      const room = lineRoom(s, r, aum, noiYr, landV);
      const draw = Math.min(Math.max(0, room), Math.round(-r.cash + aum * 0.004));
      if (draw > 0) { r.debt += draw; r.cash += draw; r.revolver = (r.revolver ?? 0) + draw; }
    }
    // A NEGATIVE BALANCE AFTER THE LINE IS A MISSED PAYMENT. Not a mark, not a
    // covenant — money that was owed this month and did not go out. That is
    // the only thing that starts a clock in this business.
    if (r.cash < 0) {
      r.stressMs = (r.stressMs ?? 0) + 1;
      // 1. RING THE INVESTORS FIRST, because a protective call is cheaper than
      //    anything else on this list and it is what actually happens. A
      //    sponsor with a record to trade on covers the arrears and a month or
      //    two of running, and does not sell a building over a bad quarter.
      //    AND ONLY FOR MONEY THAT CURES THE ARREARS. The well is recallable
      //    once; a call that leaves the borrower still short has bought a month
      //    of nothing and spent the only rescue the vehicle had. So the test is
      //    the shortfall itself — cover the missed payment or do not convene.
      const need = -r.cash + Math.round(aum * 0.004);
      const got = recallable(r) >= -r.cash ? callCapital(r, need) : 0;
      if (got > 0 && r.cash >= 0 && newsChance(s, "call:" + r.id, 0.2)) {
        s.news.unshift({
          q: s.month, kind: "event",
          text: `${r.name} has called ${(got / 1e6).toFixed(1)}M from their partners. They were not going to sell a building over a bad year, and they did not have to.`,
        });
      }
      // 2. SELL SOMETHING. The one that covers the hole, not one drawn out of a
      //    hat — see marketAssetToRaise for what the old random pick cost.
      if (r.cash < 0 && r.stressMs % 2 === 0 && r.bbls.length) {
        marketAssetToRaise(s, parcels, r, need);
      }
      // 3. HAND ONE BACK once the desks have filed. This is the move that stops
      //    the spiral: a forced sale at seventy-eight cents retires debt at par
      //    against a book marked at a hundred, so every one of them RAISED
      //    leverage and cut the income that was servicing it — the firm could
      //    only ever accelerate. Giving the keys back removes the asset AND the
      //    loan AND the interest on it in one move, and on non-recourse paper
      //    the shortfall stops being the borrower's problem at the door.
      if ((r.stressMs === NOTICE_M || r.stressMs === NOTICE_M * 2) && r.bbls.length) {
        deedInLieu(s, parcels, r, `They have missed ${r.stressMs} months of debt service and could not cure.`);
      }
      // 4. AND WHEN THE CALENDAR RUNS OUT, the desks stop taking assets one at
      //    a time and take the relationship. Same clock as the player's.
      if (r.stressMs > NOTICE_M + FORECLOSE_M) {
        r.failedM = s.month;
        chargeSponsorFailure(s, parcels, r);
        s.news.unshift({
          q: s.month, kind: "warn",
          text: r.bbls.length
            ? `${r.name} is finished — ${r.bbls.length} building${r.bbls.length === 1 ? "" : "s"} go to the lenders. `
              + `They have not made a payment in ${r.stressMs} months, the partners stopped answering and no desk would extend again. The receiver will be selling for years.`
            : `${r.name} is wound up. They handed back the last building months ago and went on paying interest on what was left until they could not — `
              + `${r.stressMs} months in arrears with nothing behind it, and no collateral for the receiver to take.`,
        });
      }
    } else if (r.stressMs || r.dumped) {
      // THE STRETCH IS OVER, so the count of buildings dumped in it goes back
      // to zero. This used to be reachable only through `r.stressMs` being
      // truthy, which cannot happen for a firm that never went into arrears —
      // and the extension branch above could put a solvent firm's building on
      // the tape, so `dumped` ran to 22 on a shop with money in the bank and
      // the news line called it "their 22nd building on the tape this stretch".
      // The branch that did that is gone; this is the belt to its braces.
      r.stressMs = 0;
      r.dumped = 0;
    }

    // SOLVENT HUSKS RETIRE. A firm that has sold its last building, cleared
    // its debt, and is not in arrears used to sit on the leaderboard forever —
    // 52% of "alive" firms at year 100 in the century report. Failure only
    // ran through the notice calendar; solvent emptiness fell between both
    // tests. Give them two years to redeploy (or burn remaining dry powder),
    // then wind the vehicle up. New funds start empty: they are exempt until
    // they have either held a deed or exhausted their uncalled capital.
    if (r.failedM === undefined && r.bbls.length === 0 && (r.debt ?? 0) <= 0 && (r.cash ?? 0) >= 0 && !(r.stressMs)) {
      const everDeployed = (r.basis ?? 0) > 0 || (r.distributed ?? 0) > 0 || (r.aum ?? 0) > 0;
      const dryPowderGone = (r.uncalled ?? 0) <= 0 && (s.month - (r.bornM ?? 0)) > 36;
      if (everDeployed || dryPowderGone) {
        r.emptyMs = (r.emptyMs ?? 0) + 1;
        if (r.emptyMs > 24) {
          r.failedM = s.month;
          s.news.unshift({
            q: s.month, kind: "event",
            text: `${r.name} has wound up. The last building is gone, the debt is clear, `
              + `and after two years with nothing left to buy they returned what remained to their partners.`,
          });
        }
      } else {
        r.emptyMs = 0;
      }
    } else if (r.bbls.length > 0) {
      r.emptyMs = 0;
    }
  }
}

/**
 * Somebody else takes the deal. Called from listing absorption so the buyer
 * has a name — losing a building to Kestrel Capital twice in a year is
 * information, and "another buyer" was not.
 *
 * Returns the firm that bought it, or null if the money in the room today
 * could not close.
 */
/**
 * HOW MANY FIRMS COULD ACTUALLY CLOSE THIS, AT THIS PRICE, TODAY.
 *
 * Not how many would like to — how many pass the same two tests the player
 * passes: the equity is in the account with a working reserve left over, and
 * the debt is lendable against the book they already carry. This is the depth
 * of the bid, and it is the number that decides whether a discount survives
 * contact with the market.
 */
export function qualifiedBuyers(s: GameState, rec: ParcelRecord, price: number): number {
  const seller = ownerOf(s, rec.bbl);
  const ci = Math.max(0.4, Math.min(1.25, s.econ.creditIdx ?? 1));
  const loan = acquisitionLoan(s, rec, price);
  let n = 0;
  for (const r of livingRivals(s)) {
    if (r === seller) continue;
    const st = STYLE[r.style];
    if (st.classes && !st.classes.includes(rec.class)) continue;
    const equity = price - loan(r, ci);
    if (r.cash < equity + Math.max(500_000, r.cash * 0.05)) continue;
    const aumAfter = (r.aum ?? 0) + price;
    const debtAfter = r.debt + (price - equity);
    if (aumAfter > 0 && debtAfter / aumAfter > st.maxLtv) continue;
    n++;
  }
  return n;
}

/**
 * WHAT A DESK WILL ACTUALLY LEND THIS FIRM AGAINST THIS BUILDING, TODAY.
 *
 * The street used to borrow `price * min(targetLtv, maxLtv)` — a number out of
 * its own personality table, with no lender in the room at all. The player has
 * never been able to do that: every acquisition loan is sized on the advance
 * rate AND on coverage AND on debt yield, at a named desk with its own capital,
 * and is routinely smaller than the LTV alone would suggest. So an opportunistic
 * shop wrote itself 88% of the price of a building yielding 6.8% while paying
 * the index plus 190bps — debt service of about 7% of the asset against income
 * of 6.8%, structurally negative from the day of the closing, on paper no desk
 * in this engine would have written for anybody. That is not a risk appetite,
 * it is a credit market that only exists for one of the two borrowers, and it
 * is most of why the styles with committed rescue capital were the ones dying.
 *
 * The income underwritten is `inPlace`: the disclosed rent roll where the
 * building came to market with one, which is the same number the player's own
 * lender reads off the same offering memorandum. Measured across 7,284
 * rival-held buildings, the class model's estimate of a building's income runs
 * 45% above what a roll on it actually produces — 84.4% occupancy against
 * 72.6% — so underwriting the estimate is underwriting income nobody collects.
 *
 * Returned as a closure because the price and the roll are properties of the
 * DEAL and want computing once, while the covenant is a property of the FIRM.
 */
function acquisitionLoan(s: GameState, rec: ParcelRecord, price: number): (r: Rival, ci: number) => number {
  const noi = inPlace(rec, s, rec.bbl, price).noi;
  // THE SAME STAB VIEW THE PLAYER'S BRIDGE DESK READS. Without it Cordage
  // sized the street on in-place income alone and a lease-up was unfinanceable
  // for everyone but the player — see streetRefiProceeds. Grade is the
  // building's own condition (no firm owns it yet).
  const stab = stabViewFor(rec, s.econ, initialCondition(rec), price);
  return (r, ci) => {
    const st = STYLE[r.style];
    // In a shut credit market the loan is smaller, so the cheque is bigger —
    // which is exactly why a downturn is when a disciplined buyer with cash
    // gets to name their price.
    const cap = Math.min(r.targetLtv, st.maxLtv) * (ci < 0.8 ? 0.82 : 1);
    return Math.min(price, streetRefiProceeds(s, price, noi, cap, stab).principal);
  };
}

/**
 * Bandwidth × Access — how hard a principal contests the tape.
 * Mid temperament (=50/50) reads 1.0 so style appetite stays the centre.
 * No RNG. Does not change who can close — only who wins among closers.
 */
export function rivalTemperamentWeight(s: GameState, r: Rival): number {
  const p = rivalPrincipalOf(s, r.id);
  if (!p?.attrs) return 1;
  const band = 0.75 + 0.5 * ((p.attrs.urgency ?? 50) / 100);       // 0.75..1.25
  const access = 0.80 + 0.4 * ((p.attrs.relationships ?? 50) / 100); // 0.80..1.20
  return band * access;
}

export function rivalBuys(s: GameState, parcels: ParcelTable, rec: ParcelRecord, price: number): Rival | null {
  // A listing may already belong to somebody — a firm selling out of a
  // position, or a receiver clearing a failed one. Whoever holds the deed is
  // the seller, and they are obviously not also the buyer.
  const seller = ownerOf(s, rec.bbl);
  // THEY BUY WITH THEIR OWN MONEY, AND ONLY WHAT A LENDER WOULD FUND.
  //
  // The cash test was already here — a firm without the equity does not close.
  // What was missing is the other half of every real acquisition: the debt has
  // to be lendable. A firm already at its covenant cannot put another loan on
  // top just because it happens to have cash in the account, and no firm gets
  // a construction-era loan out of a shut credit market. Both are checks the
  // player has to pass on every deal; the street passes them now too.
  //
  // AND THE CORPORATE LINE, which is this street's facility. A firm with
  // covenant room and a thin operating account used to lose every contested
  // bid while the player could pledge the book and close. They draw the line
  // for the equity cheque the same way they already draw it for a balloon.
  const ci = Math.max(0.4, Math.min(1.25, s.econ.creditIdx ?? 1));
  const loan = acquisitionLoan(s, rec, price);
  const closing = Math.round(price * 0.02);
  const drawFor = (r: Rival) => {
    const debt = loan(r, ci);
    const equity = price - debt;
    const reserve = Math.max(500_000, Math.max(0, r.cash) * 0.05);
    // Prefer this month's tickRivals mark. Remaking the whole book here was
    // the cost of every contested sale and the main spike inside a Year click.
    let aum = r.aum, noiYr = r.markNoi, landV = r.markLand;
    if (aum === undefined || noiYr === undefined || landV === undefined) {
      const m = markRival(s, parcels, r);
      aum = m.aum; noiYr = m.noiYr; landV = m.landV;
    }
    const room = Math.max(0, lineRoom(s, r, aum, noiYr, landV));
    const need = equity + reserve + closing;
    return { debt, equity, reserve, need, draw: Math.max(0, Math.min(room, need - r.cash)), aum };
  };
  const candidates = livingRivals(s).filter((r) => {
    if (r === seller) return false;
    const st = STYLE[r.style];
    if (st.classes && !st.classes.includes(rec.class)) return false;
    const { debt, need, draw, aum } = drawFor(r);
    if (r.cash + draw < need) return false;
    const aumAfter = aum + price;
    const debtAfter = r.debt + debt + draw;
    if (aumAfter > 0 && debtAfter / aumAfter > st.maxLtv) return false;
    return true;
  });
  if (!candidates.length) return null;
  // WHO ACTUALLY WANTS IT — appetite and cycle still matter, but closers used
  // to fight over junk and prime at the same weight. Going-in yield vs the
  // street coupon, and where the building sits on the demand map, now decide
  // who raises their hand. `contra` / `distressBias` keep their jobs.
  const shut = 1 - (s.econ.creditIdx ?? 1);
  const isDistress = !!s.listings.find((l) => l.bbl === rec.bbl)?.distress;
  const goingInNoi = inPlace(rec, s, rec.bbl, price).noi;
  const goingInYld = price > 0 ? goingInNoi / price : 0;
  const coupon = (s.econ.indexRate + RATE_SPREAD) / 100;
  const spreadPp = (goingInYld - coupon) * 100;
  const loc = Math.max(0, Math.min(1, demandLinear(rec.demandScore) / 100));
  let best = candidates[0], bestW = -Infinity;
  for (const r of candidates) {
    const st = STYLE[r.style];
    const need = YIELD_OVER_COUPON[r.style] ?? 0.8;
    // Soft refuse: ordinary stock below the style's hurdle is not a deal for
    // this committee. Distress and vultures still clear below the coupon.
    if (!isDistress && spreadPp + 0.15 < need) continue;
    const cyc = 1 + st.procyclical * ((s.econ.creditIdx ?? 1) - 1) + st.contra * shut;
    const yieldFit = Math.max(0.15, 0.55 + (spreadPp - need) * 0.18);
    const locFit = 0.55 + 0.90 * loc;
    const w = st.appetite * Math.max(0.05, cyc)
      * (isDistress ? st.distressBias : 1)
      * yieldFit * locFit
      * rivalTemperamentWeight(s, r)
      * (0.65 + rng(s, "rivals") * 0.7);
    if (w > bestW) { bestW = w; best = r; }
  }
  // Every closer soft-refused the yield — leave it on the tape.
  if (!Number.isFinite(bestW) || bestW === -Infinity) return null;
  if (seller) {
    // The tax is struck while the building is still one of theirs — see
    // basisShare. Taking the deed off first made the remaining book one
    // building smaller and the estimated basis in the building that just sold
    // correspondingly larger, so the street was under-taxed on every disposal
    // by exactly the amount that made the decision and the settlement disagree.
    const tax = gainsTax(seller, price);
    seller.bbls = seller.bbls.filter((b) => b !== rec.bbl);
    forgetDeed(seller, rec.bbl);
    // Same event, same rule — a firm selling to another firm and a firm selling
    // to Hartford both retire the loan that was on the building. See
    // debtReleasedOnSale.
    const relief = debtReleasedOnSale(seller, price);
    seller.debt -= relief;
    seller.cash += price - relief - tax;
  }
  const fin = drawFor(best);
  // The corporate line funds any equity the operating account cannot cover —
  // same instrument they already draw at a balloon. Closing costs sit in
  // `closing` above.
  if (fin.draw > 0) {
    best.revolver = (best.revolver ?? 0) + fin.draw;
    best.debt += fin.draw;
    best.cash += fin.draw;
  }
  best.cash -= fin.equity + closing;
  best.debt += fin.debt;
  best.basis = Math.round((best.basis ?? 0) + fin.equity + closing);
  best.aum = Math.round((best.aum ?? 0) + price);
  transferDeed(s, rec.bbl, best, 0);   // the seller was already paid above
  recordComp(s, rec, price, best.name, seller?.name ?? "a private owner",
    s.listings.find((l) => l.bbl === rec.bbl)?.distress, seller ? assetGrade(seller, rec) : undefined);
  return best;
}

/**
 * A BUILDING SOLD TO SOMEBODY WE DO NOT MODEL IS STILL SOLD.
 *
 * When a listing is absorbed and no modelled firm wants it, the buyer is an
 * out-of-town name and the trade goes on the comps sheet. It did not, until
 * now, come off the seller. The rival kept the deed, kept collecting the rent,
 * and re-listed the same building a few months later — so 20 Sloop Alley
 * "sold" eighty-three times in one century while Tidewater Development owned it
 * from the first month to the last. Eighty-three prints of a sale that never
 * happened, on a comps sheet that sets land value for the whole district.
 *
 * The seller side is the same accounting `rivalBuys` already does for a firm
 * selling to another firm: the deed goes, the debt against it is retired out of
 * the proceeds, the gain is taxed, and what is left is cash. The only
 * difference is that the buyer has no balance sheet here, because the buyer is
 * an insurance company in Hartford and we do not model Hartford. `aum` is not
 * adjusted because `tickRivals` re-marks it from the portfolio every month.
 *
 * Returns whether a modelled firm actually lost a building — false means the
 * listing was the street's own and no deed had to move.
 */
export function sellToOutsider(s: GameState, bbl: string, price: number): boolean {
  const seller = (s.rivals ?? []).find((r) => r.bbls.includes(bbl));
  if (!seller) return false;
  const tax = gainsTax(seller, price);      // struck before the deed moves; see basisShare
  seller.bbls = seller.bbls.filter((b) => b !== bbl);
  forgetDeed(seller, bbl);
  const relief = debtReleasedOnSale(seller, price);
  seller.debt -= relief;
  seller.cash += price - relief - tax;
  return true;
}

/**
 * WHAT A SALE PAYS OFF is the loan that was on the building, not the loan the
 * firm wishes it had. Retiring `price * targetLtv` over-repays every firm that
 * is running below its target, and a firm that sells often ends up with no debt
 * at all — when the outsider sale started actually conveying the deed and
 * became the commonest way a building leaves a portfolio, aggregate firm debt
 * across the town fell from $1.26B to $108M by year 50, which is a market of
 * unlevered landlords and not a property market. Firms that could not borrow
 * stopped building, the city delivered 108 jobs instead of 128, and real office
 * rents rose 0.44pp a year faster for the whole fifty years on the resulting
 * shortage.
 *
 * The honest proxy for the mortgage on one asset is the leverage actually on
 * the book, so a sale leaves the firm at roughly the leverage it had. Target
 * LTV is the fallback only for a firm with nothing marked yet.
 */
function debtReleasedOnSale(r: Rival, price: number): number {
  const lev = (r.aum ?? 0) > 0
    ? Math.min(1, Math.max(0, r.debt / (r.aum as number)))
    : r.targetLtv;
  return Math.min(r.debt, Math.round(price * lev));
}

/** What a rival will take for a building of theirs, and why. */
export function rivalAsk(s: GameState, parcels: ParcelTable, r: Rival, bbl: string): { ask: number; note: string } {
  const rec = resolveRec(parcels, s, bbl);
  const v = rec ? assetValue(rec, s.econ, assetGrade(r, rec)) : 0;
  const { ltv } = markRival(s, parcels, r);
  // AND THEY QUOTE YOU, NOT A STRANGER. A principal who has closed with you
  // twice prices the certainty of closing with you a third time; one you have
  // insulted prices the memory of it; and one who took a corner out from under
  // you knows exactly how badly you wanted that block.
  const t = s.street?.[r.id];
  const known = t ? Math.min(0.05, 0.018 * t.deals) - Math.min(0.06, 0.03 * t.insults) : 0;
  const st = STYLE[r.style];
  if (r.stressMs && r.stressMs > 4) {
    return { ask: Math.round(v * rrange(s, 0.80, 0.95, "rivals") * (1 - known)), note: `${r.name} needs the money — they are inside appraisal and they know you know.` };
  }
  if (ltv < st.maxLtv * 0.6 && r.style === "family") {
    return { ask: Math.round(v * rrange(s, 1.18, 1.45, "rivals")), note: `${r.name} has owned it for two generations and does not need to sell. That is the number.` };
  }
  return {
    ask: Math.round(v * rrange(s, st.patience - 0.04, st.patience + 0.12, "rivals") * (1 - known)),
    note: (t?.deals ?? 0) >= 2
      ? `${r.name} have made money with you ${t!.deals === 2 ? "twice" : `${t!.deals} times`}. The number is friendlier than it needs to be, and they know it.`
      : (t?.insults ?? 0) > 0
        ? `${r.name} have not forgotten the last number you put to them. It is priced in.`
        : `${r.name} will trade at the right price.`,
  };
}
