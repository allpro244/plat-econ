// Ground-up development (Groundwork's core loop, simplified for v1) plus
// building management: capital programs and rent stance.
//
// Development: on an owned vacant lot, choose use and FAR up to the zoning
// max, pay hard+soft cost per sf, fund with a 60% interest-only construction
// loan, wait 4-6 quarters while the building rises on the map, then lease up
// from empty. A modest random cost/schedule overrun keeps it honest.
import type { ParcelTable } from "@/data/types";
import type { BtsCommitment, BuiltClass, Contract, DevUse, Development, Econ, GameState, UseMix } from "./types";
import { BUILT_CLASSES, cloneState} from "./types";
import { logBooks, monthLabel, serviceSpec, planSpec, START_YEAR } from "./types";
import { demandNow, demandModel, nudgeBlockDemand } from "./demand";
import { rng, rrange, NATURAL_VAC, RENT_BASE, CITY_STOCK, BUILD_MONTHS, SECTOR_LABEL, devPencils, addStock, REF_PIPE_SHARE, frictionFloor } from "./market";
import { coverRoleState, cmRiskMult } from "./staff";
import { firmShort } from "./firm";
import { resolveRec, marketRentPsfYr, opexPsf, TAX_RATE, capRateFor, landValue, landRead, assetValue, ownedHoldingValue, RECOVERY_RATE, demandLinear, plateEfficiency, physicalMaxFloors, condGrade, condCeiling,
  developmentHurdle, HARD_COST_PSF, SOFT_COST, CONTINGENCY, RETAIL_FLOORS_MAX, INDUSTRIAL_FLOORS_MAX, heightPremium, MGMT_FEE,
  noiYr, taxBorneShare } from "./value";
// The massing curve moved to value.ts, because land pricing needs to ask what
// a lot can physically carry and value.ts cannot import this file. Re-exported
// so it is still `physicalMaxFloors` from "@/engine/dev" everywhere else.
export { physicalMaxFloors, plateEfficiency } from "./value";
import { depositFor, depositsOn, genAnchorTenant, COMMERCIAL_SUITE_MIN, minTenancySf, useVacantSf } from "./leasing";
import { claimJob, jobDelivered, ownerOf, gradeOf } from "./rivals";
import { locAvailable } from "./credit";
import { mixOf, useSf } from "./mix";
import { lenderAppetite, lenderByName, CONSTRUCTION_LENDER } from "./lenders";
import { lenderRelOf, bumpLenderRel } from "./debt";
import {
  cancelSupplyProject,
  programmeSf,
  queueSupplyProject,
  rescheduleSupplyProject,
} from "./supply";
import { recordPropertyEvent } from "./history";

const clone = (s: GameState): GameState => cloneState(s);

// hard cost $/sf by use, before the height premium and soft costs.
// Sized so stabilized yield-on-cost lands ~150-250bps over the exit cap —
// a real development margin, not free money.
/**
 * Hard cost per square foot, before the height premium and the contract.
 *
 * These must be read against RENT_BASE, because the ratio between them decides
 * whether a class is buildable at all — and it was wildly out. Retail cost 3.4
 * times its annual rent to build and penciled on literally every site in the
 * city; industrial cost 10.3 times its rent and penciled on none. Real
 * construction runs roughly seven times stabilised rent across the board, and
 * the differences between classes should come from cap rates and location, not
 * from one class being free to build.
 */
/**
 * Calibrated against NET stabilised rent, not gross.
 *
 * The old table was set at roughly seven times each class's headline rent,
 * which sounds disciplined and is not: the classes do not carry remotely the
 * same expense load, and they do not recover it the same way. Triple-net
 * retail keeps almost every dollar it bills; an apartment building keeps
 * fifty-five cents on the dollar after payroll, turns and utilities. Pricing
 * both at seven times the number on the sign made retail free money to build
 * — a sixteen per cent yield on cost against a six per cent exit — while
 * apartments barely cleared.
 *
 * These are solved instead: the cost at which a NEW building on a MEDIAN site
 * yields about 150bp over its own exit cap, after operating cost, after what
 * a typical lease bills back, and after the property tax the owner carries.
 * A better corner still beats the hurdle comfortably; a poor one does not
 * pencil, which is why most land in a real city stays empty.
 */
// THE NUMBERS MOVED DOWN A LAYER. Land is now priced as a residual — what a
// building on this envelope is worth, less what it costs to build — and a
// residual cannot be computed without the cost of construction. value.ts sits
// below this module and cannot import it, so the constants live there and are
// re-exported here, where every existing caller still finds them.
export { HARD_COST_PSF, SOFT_COST, CONTINGENCY } from "./value";

/**
 * A PROGRAMME, not a class. You do not build "mixed use" — you build shops at
 * grade with offices and flats above, and the budget is the sum of those three
 * jobs. "mixed" here is shorthand for a canonical stack, and the whole of what
 * it means is the mix below: cost, rent, lease-up, lender appetite and
 * neighbourhood effect all follow from the components.
 */
export const MIXED_STACK: UseMix = { retail: 0.15, office: 0.45, multifamily: 0.40 };
/**
 * YOU DECIDE THE STACK.
 *
 * "Mixed use" used to mean one canonical 15/45/40 building and nothing else,
 * which is not a programme — it is a preset. A developer picking mixed use is
 * making the most consequential decision on the site: how much retail the
 * frontage will actually carry, whether the middle is offices or flats, and
 * what that does to the cost, the exit cap and the lender's appetite. All of
 * which already fall out of the mix; there was simply no way to choose it.
 *
 * The custom split is normalised and floored — a leg under three per cent is
 * not a use, it is a lobby — and the canonical stack remains the default so
 * the decision is opt-in rather than homework.
 */
export function normalizeMix(m: UseMix): UseMix {
  const keys = (Object.keys(m) as BuiltClass[]).filter((k) => (m[k] ?? 0) >= 0.03);
  const tot = keys.reduce((a, k) => a + (m[k] ?? 0), 0);
  if (!keys.length || tot <= 0) return { ...MIXED_STACK };
  const out: UseMix = {};
  for (const k of keys) out[k] = +((m[k] ?? 0) / tot).toFixed(4);
  return out;
}
export function devMix(use: DevUse, custom?: UseMix): UseMix {
  if (use !== "mixed") return { [use]: 1 };
  return custom ? normalizeMix(custom) : { ...MIXED_STACK };
}
export function dominantOf(mix: UseMix): BuiltClass {
  return (Object.keys(mix) as BuiltClass[]).sort((a, b) => (mix[b] ?? 0) - (mix[a] ?? 0))[0] ?? "office";
}
/** Weighted average of a per-use number across a programme. */
function overMix(mix: UseMix, f: (u: BuiltClass) => number): number {
  let sum = 0, w = 0;
  for (const u of Object.keys(mix) as BuiltClass[]) { const s = mix[u] ?? 0; sum += f(u) * s; w += s; }
  return w > 0 ? sum / w : 0;
}
/** How much of a programme carries genuine leasing risk before it is built. */
/** Share of the job that can take a named commercial pre-let. Industrial is
 *  named-tenant space too — excluding it made every shed open empty no matter
 *  how tight the market was while the shell went up. Flats still lease after
 *  C of O, not off a hole in the ground. */
function specShare(mix: UseMix): number {
  return (mix.office ?? 0) + (mix.retail ?? 0) + (mix.industrial ?? 0);
}
const CONSTR_SPREAD = 2.4;     // over the index, interest-only

/**
 * THE CONTRACT.
 *
 * Cost-plus is cheaper on paper and leaves you holding the bag: the price
 * moves with the market between groundbreak and topping out, and every change
 * order is yours. A guaranteed maximum price costs four points more and buys
 * the contractor's balance sheet — escalation stops being your problem and
 * most overruns die at the GMP line.
 *
 * In a boom, when costs are running, the GMP premium is the cheapest money on
 * the board. In a flat market it is four points of nothing. Reading which one
 * you are in is the job.
 */
export const CONTRACT_PREMIUM: Record<Contract, number> = { gmp: 0.04, costplus: 0 };

/**
 * Construction lenders underwrite lease risk, not blueprints, and they
 * underwrite it in a straight line: the more of the building that is already
 * spoken for, the more of the cost they will fund. Spec commercial in a
 * recession gets nothing at all. Residential and industrial carry less lease
 * risk because the space is fungible.
 */
// EVERYTHING IS BUILT ON SPEC.
//
// The old model made you buy anchors before a slab was poured, and paid you
// for it in leverage and punished you for it in months. That is a real thing
// that happens on a minority of large single-tenant jobs, and it was wrong as
// the universal precondition for putting up a building: the overwhelming
// majority of commercial development is started empty, on the developer's read
// of the market, and let while it is going up. Leasing during construction is
// now the mechanic — see tickConstructionLeasing — which is both what actually
// happens and a far more interesting decision, because the market can turn
// underneath you while the steel is going in.
//
// Credit tightens the ceiling in a downturn, and industrial and housing carry
// more than offices and shops, because they always have.
function constructionLtc(mix: UseMix, phase: string, creditIdx: number, appetite = 1, spaceTight = 1): number {
  const spec = specShare(mix);
  // flats and sheds are the financeable end of the market
  const safeLtc = 0.70;
  const specLtc = 0.70;
  const base = specLtc * spec + safeLtc * (1 - spec);
  const tight = phase === "recession" || phase === "depression" ? 0.72 : phase === "peak" ? 0.94 : 1;
  // Construction paper in this town is written by the regional bank, and the
  // regional bank has a balance sheet you can read on Research. When it is
  // eating losses it does not tighten the market's terms — it tightens YOURS,
  // and a bank that has stopped lending stops financing buildings first,
  // because a half-built tower is the worst collateral there is.
  const app = Math.min(1.05, 0.5 + 0.5 * appetite);
  // Space-market tightness (vacancy below natural / unmet structural demand)
  // is why banks fund into a shortage — same signal classAppetite already
  // reads. Caps keep this from becoming free leverage in a boom label alone.
  const space = Math.max(0.9, Math.min(1.12, spaceTight));
  return Math.max(0, Math.min(0.72, base * tight * app * space * Math.min(1.12, Math.max(0.55, creditIdx))));
}

/** Mix-weighted construction advance boost from class vacancy / structural tightness. */
function constructionSpaceTight(e: Econ, mix: UseMix): number {
  let w = 0, t = 0;
  for (const u of BUILT_CLASSES) {
    const share = mix[u] ?? 0;
    if (share <= 0) continue;
    const vac = e.cityVac?.[u] ?? NATURAL_VAC[u];
    const gap = vac - NATURAL_VAC[u]; // negative = tight
    const struct = e.structTight?.[u] ?? 0;
    // Up to ~12% more advance when the class is short space; asymptotic cap
    // replaces a hard rail that bound 73% of calls at 1.12 (pnpm rails).
    const tightSignal = -gap * 6 + struct * 1.4;
    const boost = Math.max(0.9, 1 + 0.12 * Math.tanh(tightSignal / 0.22));
    t += share * boost;
    w += share;
  }
  return w > 0 ? t / w : 1;
}

/**
 * THE CONSTRUCTION DESKS.
 *
 * Alden wrote every construction loan in this town by fiat, which made the
 * most dangerous paper in banking the one loan you could not shop. Three desks
 * quote it now, priced off the same balance sheets everything else reads: the
 * hometown bank writes small jobs cheaply for names it knows and stops at its
 * hold size, the regional remains the volume desk, and the debt fund will
 * finance a hole in the ground in any market — at fund prices, which is the
 * whole business model. Personality is not invented here: appetite comes off
 * each desk's capital, the relationship discount off the same file the perm
 * quotes read, and a desk in receivership quotes nothing at all.
 */
export interface ConstructionQuote {
  lender: string;
  ratePct: number;
  ltcMax: number;
  points: number;   // origination, as a share of the commitment — cash at close
  open: boolean;
  why?: string;
}

const CONSTRUCTION_DESKS: { name: string; spread: number; points: number; scale: number; cap: number; holdShare?: number; fund?: boolean }[] = [
  // Small, cheap, and they remember you: the hometown bank's hold stops at
  // $9M, so on anything bigger it funds its piece and no more.
  // A HOLD LIMIT IS A SHARE OF A BALANCE SHEET, not a number of dollars.
  // This was a flat $9M, which is right for a small local desk in the town
  // that shipped and meaningless in a town four times the size — the same
  // hometown bank, still the hometown bank, but a $9M hold against jobs that
  // cost ten times that is not "they only fund their piece", it is a desk that
  // never appears. 6.4% of its own book is what $9M was against the $140M it
  // used to carry, and the book is now derived from the city (see initLenders),
  // so this follows the town without being told about it.
  { name: "First Harbor Bank", spread: 2.15, points: 0.008, scale: 0.92, cap: 0.65, holdShare: 0.064 },
  // The regional — the historical monopoly desk, and still the volume quote.
  { name: CONSTRUCTION_LENDER, spread: CONSTR_SPREAD, points: 0.010, scale: 1, cap: 0.70 },
  // Committed capital and no depositors: they quote through the cycle, and the
  // coupon is why nobody borrows from them twice unless they have to.
  { name: "Cordage Debt Partners", spread: 4.00, points: 0.020, scale: 1.05, cap: 0.75, fund: true },
];

/**
 * WHICH DESK WROTE THE PAPER, for a job the player did not underwrite.
 *
 * Rival and city jobs never named a lender, which was fine while nothing ever
 * asked — and stopped being fine the moment a bank failure had to know whose
 * borrowers had just lost their funding. A developer on this street borrows
 * from one of the same three desks the player does, and they go where the
 * money is: a desk with no appetite is not writing the loan.
 *
 * THE DRAW IS PRIVATE, keyed off the site. The shared PRNG drives every other
 * outcome in the world, so one extra call to it from every groundbreaking
 * would have re-rolled fifty years of history for a change that is supposed to
 * be additive. Same technique, and the same reason, as genRentRoll.
 */
export function openConstructionDesks(s: GameState): { name: string; cap: number; appetite: number }[] {
  return CONSTRUCTION_DESKS
    .map((d) => ({ name: d.name, cap: d.cap, appetite: lenderAppetite(s, d.name) }))
    .filter((d) => d.appetite >= 0.12);
}

export function pickConstructionDesk(s: GameState, key: string): string | undefined {
  const open = openConstructionDesks(s);
  if (!open.length) return undefined;
  const total = open.reduce((a, d) => a + d.appetite, 0);
  let h = 2166136261 ^ (s.seed >>> 0);
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  let u = (((h >>> 0) % 1_000_003) / 1_000_003) * total;
  for (const d of open) { u -= d.appetite; if (u <= 0) return d.name; }
  return open[open.length - 1].name;
}

export function constructionQuotes(s: GameState, mix: UseMix, costTotal: number): ConstructionQuote[] {
  const e = s.econ;
  const tight = Math.max(0, 1 - (e.creditIdx ?? 1));
  const space = constructionSpaceTight(e, mix);
  return CONSTRUCTION_DESKS.map((d) => {
    const app = lenderAppetite(s, d.name);
    const bank = lenderByName(s, d.name);
    // The fund prices the cycle instead of leaving it: its advance rate reads
    // through a recession the way its perm sheet does, at its coupon.
    const base = d.fund
      ? constructionLtc(mix, "expansion", Math.max(0.85, e.creditIdx ?? 1), Math.max(0.5, app), space)
      : constructionLtc(mix, e.phase, e.creditIdx ?? 1, app, space);
    const uncapped = Math.min(d.cap, base * d.scale);
    // The 1.1 approximates the interest-reserve gross-up, so the solved
    // commitment lands at the hold size rather than a tenth over it.
    const maxCommit = d.holdShare && bank ? bank.book * d.holdShare : undefined;
    const ltcMax = maxCommit && costTotal > 0 ? Math.min(uncapped, maxCommit / (costTotal * 1.1)) : uncapped;
    const rel = d.fund ? 0 : Math.min(0.4, Math.max(0, (lenderRelOf(s, d.name) - 20) * 0.005));
    const ratePct = +(e.indexRate + d.spread * (1 + (d.fund ? 0 : 0.9 * tight)) + Math.max(0, 1 - app) * (d.fund ? 0.3 : 0.8) - rel).toFixed(2);
    const open = app >= 0.12 && ltcMax > 0.02;
    const why = bank?.failedM !== undefined ? `${d.name} is in receivership — nobody is answering the phone.`
      : app < 0.12 ? `${d.name} has stopped writing new paper — their capital will not carry it.`
      : ltcMax <= 0.02 ? `${d.name} will not touch spec construction in this market.`
      : maxCommit && ltcMax < uncapped - 0.005 ? `A job this size is past ${d.name}'s hold — they will only fund $${(maxCommit / 1e6).toFixed(0)}M of it.`
      : undefined;
    return { lender: d.name, ratePct, ltcMax: +Math.max(0, ltcMax).toFixed(3), points: d.points, open, why };
  });
}

/**
 * What a lender sets aside to carry a construction loan to delivery.
 *
 * Average outstanding across an S-curve draw is a bit over half the
 * commitment; the 1.16 gross-up covers interest compounding on itself and the
 * schedule contingency every lender builds in, because a job that opens four
 * months late still has to be carried for those four months.
 */
export function reserveFor(commitment: number, ratePct: number, months: number): number {
  return commitment * 0.58 * (ratePct / 100) * (months / 12) * 1.16;
}

export interface DevPlan {
  use: DevUse;
  mix: UseMix;
  floors: number;
  coverage: number;   // share of the lot the floorplate covers
  contract: Contract;
  sf: number;
  far: number;
  farMax: number;
  hardCost: number;
  softCost: number;
  contingency: number;
  demo: number;
  landBasis: number;    // what the site cost you — sunk, but in the yield
  basisTotal: number;   // construction plus land: the denominator of yield on cost
  leaseUp: number;    // fit-out, commissions and carry until it is full
  costTotal: number;
  ltc: number;
  ltcMax: number;
  commitment: number;
  interestReserve: number;
  ratePct: number;
  lender: string;         // whose commitment this is — the desk you picked
  points: number;         // their origination fee, as a share of the commitment
  pointsCost: number;     // ...in dollars, cash at close, on top of the equity
  equity: number;         // the whole equity budget
  equityAtClose: number;  // what you actually write on day one
  months: number;
  yieldOnCost: number;    // stabilised NOI ÷ total cost — the developer's number
  exitCap: number;
  /** Exit yield grossed up by the same developer margin the land residual uses. */
  requiredYield: number;
  /** YoC / requiredYield. Below 1 destroys value; above 1 clears the hurdle. */
  hurdleRatio: number;
  /** 0..1, 0.5 = market standard. What you chose to build to. */
  spec: number;
  bts?: BtsCommitment;
  btsShare?: number;
  lenderNote?: string;
}

/**
 * THE SPECIFICATION PREMIUM.
 *
 * A budget building and a trophy building on the same lot are not the same
 * project, and the difference is mostly hard cost: the curtain wall, the
 * floor-to-floor, the lift count, the lobby, the plant. Roughly thirty per cent
 * either side of market standard, which is about the real spread between a
 * value-engineered box and a building people want their name on.
 *
 * What the money buys is in `condCeiling` and it is PERMANENT — the building
 * ages more slowly and keeps a higher ceiling forever — plus a better roll,
 * because the tenants who pay the top of the market will not take space in a
 * building that leaks.
 */
export const specCostMult = (spec: number) => 1 + 0.62 * (clamp01(spec) - 0.5);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x ?? 0.5));

// The buildable envelope, and nothing else. Ashport has no use districts —
// any class on any lot — so the only limit is how much floor area the FAR
// allows, and how much of the lot you choose to cover with it.
export function farMaxFor(rec: { farMaxComm: number; farMaxRes: number }): number {
  return Math.max(rec.farMaxComm, rec.farMaxRes, 2);
}
/**
 * How high a building can PHYSICALLY go on this floor plate — zoning is one
 * limit, engineering is the other, and the old code only knew about zoning,
 * which is how a 216-storey needle ended up permitted on a 414 sf lot.
 *
 * Real New York numbers: an ordinary residential tower runs a 7-12k sf plate;
 * an office tower 20-40k; the pencil towers on 57th Street stand on ~6k sf
 * plates at about 1:15 slenderness with hundred-million-dollar damping
 * systems, and they are the outer limit of what money can do. So:
 *
 *   - anything needs ~600 sf of plate to be a building at all
 *   - a walk-up (≤6 floors) needs 1,200 sf — a Manhattan townhouse plate
 *   - going past 6 floors takes a 4,000 sf plate — you need a core
 *   - past that, slenderness governs: height ≈ 12.5 ft/floor against a plate
 *     ~sqrt(plate) wide at ~15:1 gives floors ≤ 1.2·√plate
 *   - and 90 floors is the ceiling money has actually reached
 */
/** Floor to floor, feet. */
export const FLOOR_HEIGHT_FT = 12.5;
/** Height : plate width. The 57th Street limit, and about where money stops. */
export const MAX_SLENDERNESS = 15;
export const ABS_MAX_FLOORS = 90;

/**
 * HOW TALL THE STRUCTURE WILL GO, and why it was a cliff.
 *
 * This was a staircase — under 600 ft², one floor; under 1,200, three; under
 * 4,000, six; and then, at 4,000 exactly, `1.2·√plate`. On a 6,170 ft² lot the
 * footprint dial crosses 4,000 ft² of plate at 65% coverage, and one
 * percentage point of the slider took the building from six floors to
 * forty-five: 7.5x the floors, 7.6x the area, an $18.6M job becoming a $177.7M
 * one. The player noticed, and they were right.
 *
 * Two real constraints, both smooth, both INCREASING in plate size:
 *
 *   SLENDERNESS. A square-equivalent plate is √plate feet wide, and a tower
 *   stops being buildable past a height-to-width ratio of about fifteen. That
 *   is 15·√plate feet of height, or 1.2·√plate floors — the old formula was
 *   right, it was just fenced off behind a step.
 *
 *   THE CORE. Lifts, stairs, risers and a second means of egress take a fixed
 *   bite out of every floor. A very small plate cannot carry enough of them to
 *   serve height at all, which is what the staircase was standing in for. It
 *   belongs as a ramp, not a step.
 *
 * Zoning (farMax/coverage) is the third constraint and it DECREASES in
 * footprint. The minimum of one falling curve and two rising ones is
 * continuous and unimodal: floors climb while the plate is still too small to
 * build tall on, peak where the curves cross, then fall away as the envelope
 * spreads out. No cliffs anywhere on the dial.
 */
// (the function itself now lives in value.ts and is re-exported at the top of
// this file — see the import block. It had to move so that land pricing could
// ask the same question about a lot that the massing dial asks about a plate.)
/**
 * SHOPS DO NOT STACK.
 *
 * Zoning and structure were the only two things limiting height, and neither
 * of them knows what the building is FOR. Retail does: a shop needs the street
 * to walk into it, the second floor already trades at a discount to the first,
 * and above that nobody goes. There is no such thing as a sixty-storey shop —
 * and the planner was happily approving one, at a 6.89% yield on cost, on the
 * best corner in the city. The city's own growth loop was building them at
 * fifty and forty-eight floors, and every retail job it started in a fifty
 * year run came out over two storeys.
 *
 * What DOES stack is retail underneath something else, and the game already
 * models that as the mixed-use programme: shops at grade, offices and flats
 * above. So the cap belongs on the pure-retail programme only, and a site that
 * can carry more than two floors should be getting a mixed building rather
 * than a squashed one — see `useForZone` and `retailWantsMixed`.
 */
export { RETAIL_FLOORS_MAX } from "./value";
/**
 * AND A SHED IS NOT A TOWER EITHER.
 *
 * Industrial had no cap at all: the envelope allowed 66 storeys and the
 * planner's optimum on a median vacant lot came out at 13, which is a
 * thirteen-storey warehouse. Modern distribution is single-storey with 32-40ft
 * clear heights because forklifts do not use lifts; multi-storey industrial
 * exists only where land is so dear that nothing else pencils, and even then it
 * is two or three levels with ramps. Two floors is the same allowance retail
 * gets and for the same reason — the use has a shape, and the shape is flat.
 */
export { INDUSTRIAL_FLOORS_MAX } from "./value";
export const MAX_FLOORS_BY_USE: Partial<Record<DevUse, number>> = {
  retail: RETAIL_FLOORS_MAX,
  industrial: INDUSTRIAL_FLOORS_MAX,
};

/**
 * THE SAME CAP, STATED AS A SHARE, so the dial and the planner cannot hold
 * two opinions about it. Two floor plates of shops is the whole allowance, so
 * in a building of any height the shops are 2/n of it — a quarter of an eight
 * storey stack, eight per cent of a twenty-five storey one. `capRetail`
 * enforces it on the programme after the fact; the development card reads it
 * to bound the dial before the fact, because a slider that offered 95% shops
 * on a twenty-five storey stack was describing a building — 88,730 sf of
 * retail on a 4,218 sf lot, twenty-one FAR of shops — that the planner then
 * quietly rebuilt as 7,472 sf under an office tower.
 */
export function maxRetailShare(floors: number): number {
  return floors > 0 ? Math.min(1, RETAIL_FLOORS_MAX / floors) : 1;
}

/**
 * THE GROUND FLOOR IS SHOPS, AND THAT IS WHERE URBAN RETAIL COMES FROM.
 *
 * Nobody builds a parade of standalone shops in a city with land worth
 * building on — they build the offices and the flats the market wants and put
 * the retail at grade underneath, because the ground floor of a tower is worth
 * more as a shop than as a lobby and the tenants upstairs want somewhere to
 * buy lunch. Almost all the retail floor space added to a dense city in the
 * last century arrived this way.
 *
 * The model had every piece of this and never joined them. `MIXED_STACK` put
 * 15% retail in a building only when a developer explicitly chose "mixed";
 * `capRetail` and `maxRetailShare` already knew retail is a ground-floor thing
 * capped at two plates. But an office or a housing programme carried no retail
 * at all, so the only shops the city ever built were standalone ones — capped
 * at two storeys, and therefore tiny. Measured over fifty years: 27 retail
 * groundbreakings averaging 13,300 sf, against office at 70,200. Retail stock
 * grew 0.04%/yr.
 *
 * MORE LAND DOES NOT FIX THAT, and it was worth checking before building
 * anything, because it was the obvious first idea. The size dial IS more land.
 * Retail stock growth over fifty years: -0.12%/yr on a Hamlet, -0.04% on the
 * standard island, +0.05% on a Great City, and +0.04% on a Great City opened
 * at 42% vacant — four times the island and half again the dirt, and the line
 * does not move. It was never a land constraint. It was a form constraint.
 *
 * THE SHARE IS ONE FLOOR OUT OF N, which is the mechanism rather than a
 * number: a four-storey walk-up is a quarter shops, a forty-storey tower is
 * two and a half per cent, and it falls out of the geometry with nothing to
 * tune. The 1.25 is real — a retail ground floor is taller and deeper than the
 * plates above it, typically 18-22 feet against 11-14, so it is worth more
 * than its share of the stack.
 *
 * IT IS NOT EVERY STREET. Shops need footfall, so this reads the same demand
 * score the rest of the engine prices off. A quiet residential block gets a
 * lobby, which is what a quiet residential block has.
 */
const STREET_RETAIL_DEMAND = 38;   // below this a shop at grade has no trade
export function withStreetRetail(mix: UseMix, floors: number, demand: number): UseMix {
  const lead = dominantOf(mix);
  if (lead !== "office" && lead !== "multifamily") return mix;
  if ((mix.retail ?? 0) > 0) return mix;                 // already a mixed programme
  if (floors < 2 || demand < STREET_RETAIL_DEMAND) return mix;
  const share = Math.min(maxRetailShare(floors), 1.25 / floors);
  if (share <= 0.01) return mix;
  const out: UseMix = { retail: +share.toFixed(4) };
  const rest = 1 - share;
  const others = Object.entries(mix).filter(([k]) => k !== "retail") as [BuiltClass, number][];
  const tot = others.reduce((a, [, v]) => a + v, 0) || 1;
  for (const [k, v] of others) out[k] = +((v / tot) * rest).toFixed(4);
  return out;
}

/**
 * AND THEY DO NOT STACK INSIDE A MIXED BUILDING EITHER.
 *
 * The two-storey cap was enforced on the pure-retail PROGRAMME — a label —
 * and never on the retail floor AREA. So a mixed-use building dialled to a
 * high retail share sailed straight past it. Measured across 400 vacant lots:
 * at the default 15/45/40 stack, untouched by the player, 55 plans breached
 * the cap and the worst carried nine floors of shops; at a 50% dial every
 * single plan breached; at 100% the worst was a sixty-one storey shop, thirty
 * times over, which delivered as class "retail", 61 floors, and tripped the
 * massing invariant in a live save.
 *
 * The cap belongs on the area: retail floor area may not exceed two floor
 * plates. Anything over that is redistributed to the other uses, because a
 * developer who cannot put shops on the ninth floor puts offices there — they
 * do not shrink the building.
 */
export function capRetail(mix: UseMix, floors: number): UseMix {
  const share = mix.retail ?? 0;
  if (share <= 0 || floors <= 0) return mix;
  const maxShare = maxRetailShare(floors);
  if (share <= maxShare) return mix;
  const others = Object.entries(mix).filter(([k]) => k !== "retail") as [BuiltClass, number][];
  const rest = others.reduce((a, [, v]) => a + v, 0);
  // A programme that is nothing BUT shops has nowhere to put the overflow —
  // that is a two-storey shop building, and the caller caps the floors.
  if (rest <= 0) return { retail: 1 };
  const out: UseMix = { retail: +maxShare.toFixed(4) };
  const scale = (1 - maxShare) / rest;
  for (const [k, v] of others) out[k] = +(v * scale).toFixed(4);
  return out;
}

/**
 * WHAT IT WOULD COST TO BUILD THIS BUILDING AGAIN, TODAY.
 *
 * The single most important number in development economics, and the game did
 * not have it anywhere. It is the hinge of the whole cycle:
 *
 *   When buildings trade ABOVE what it costs to replace them, you build —
 *   because you can create a dollar of value for less than a dollar. Everybody
 *   works that out at once, which is what produces a glut.
 *
 *   When they trade BELOW replacement cost, nobody builds, at any interest
 *   rate, because you would be manufacturing a loss. That is what ENDS a glut,
 *   and it is the only thing that does. Not sentiment, not the cycle turning —
 *   arithmetic.
 *
 * Without it the development cycle had no self-correcting mechanism: a class
 * could sit at 25% vacancy and construction was still governed only by yield
 * on cost against an exit cap. Now the floor is real, and it is readable — a
 * player who can see value at 0.75x replacement knows two things at once: do
 * not build, and every building you buy is worth less than the bricks in it,
 * which is the best moment in the cycle to be an owner.
 *
 * Excludes land, deliberately. Replacement cost is about the BUILDING; land is
 * what you argue about separately, and mixing them is how people talk
 * themselves into bad sites.
 */
export function replacementCostPsf(rec: { class: string; mix?: UseMix; floors: number }, econ: GameState["econ"]): number {
  const mix = rec.mix && Object.keys(rec.mix).length ? rec.mix : ({ [rec.class]: 1 } as UseMix);
  const base = overMix(mix, (u) => HARD_COST_PSF[u]);
  const fl = Math.max(1, rec.floors || 1);
  const hard = base * econ.costIdx * heightPremium(fl);
  return Math.round(hard * (1 + SOFT_COST) * (1 + CONTINGENCY));
}

/** The whole building, to build again from a cleared site. */
export function replacementCost(rec: { class: string; mix?: UseMix; floors: number; bldgArea: number }, econ: GameState["econ"]): number {
  if (!rec.bldgArea || rec.class === "land") return 0;
  return Math.round(replacementCostPsf(rec, econ) * rec.bldgArea);
}

/**
 * WHAT THE WHOLE CITY'S FINISHED PRODUCT TRADES AT, against what it would cost
 * to build it. Above 1.0 the town builds; below it, the town stops.
 *
 * Value per foot is derived the way a developer would: stabilised rent at
 * natural vacancy, capitalised at the class's current cap rate. Weighted by
 * how much of the pipeline each class represents, because a glut in offices
 * does not stop anyone building sheds.
 */
export function cityValueToReplacement(s: GameState): number {
  const e = s.econ;
  let vsum = 0, csum = 0;
  for (const k of BUILT_CLASSES) {
    // STABILISED NOI, COMPUTED THE WAY THIS ENGINE COMPUTES NOI.
    //
    // This was `rentIdx[k] * occ * 0.62` — one flat rent-to-NOI margin for four
    // classes whose recovery rates are 0.88 / 0.92 / 0.50 / 0 and whose
    // operating cost spans $0.80 to $8.22 a foot. Checked against the engine's
    // own NOI expression at base rents, the flat margin understated every class
    // and by wildly different amounts: office -32%, retail -37%, multifamily
    // -13%, industrial -38%. The error is not a level shift that a centring
    // constant can absorb, it is twenty-five points of spread ACROSS classes —
    // and the ratio is stock-weighted, so the size of the mistake depended on
    // what the town happened to be made of.
    //
    // It also read ASKING rent, where value.ts:757 states flatly that
    // everything which prices a deal or values an asset reads what deals
    // actually sign at; and it ignored the property tax entirely, which is a
    // real claim on a real building and is capitalised into every other value
    // in this engine.
    const rent = e.effRentIdx?.[k] ?? e.rentIdx[k];
    const occ = 1 - NATURAL_VAC[k];
    const opex = opexPsf(k, e, false);
    const recov = RECOVERY_RATE[k] ?? 0;
    const egi = rent * occ + opex * recov * occ;
    const noiPsf = egi - opex - egi * MGMT_FEE;
    // Same tax solve as the land residual: value and the tax bill define each
    // other, so V = NOI / (cap + t(1 - recovery)) rather than NOI / cap.
    const cap = Math.max(3, e.capRate[k]) / 100;
    const valuePsf = noiPsf / (cap + TAX_RATE * (1 - recov));
    // The low-rise base, deliberately: this is a citywide average against a
    // citywide stock, and weighting the height premium would need a height
    // distribution nobody has measured. It biases the ratio UP for a tall town
    // and that is worth knowing rather than papering over.
    const costPsf = HARD_COST_PSF[k] * e.costIdx * (1 + SOFT_COST) * (1 + CONTINGENCY);
    // weight by the class's share of citywide stock, so the blend reflects
    // what this town is actually made of
    const w = Math.max(1, (e.stock?.[k] ?? 1));
    vsum += valuePsf * w;
    csum += costPsf * w;
  }
  return csum > 0 ? vsum / csum : 1;
}

/**
 * HOW HARD THE CITY BUILDS, GIVEN WHAT FINISHED PRODUCT IS WORTH AGAINST WHAT
 * IT COSTS TO MAKE. One copy, because there were two.
 *
 * This expression was written out twice — dev.ts, governing every start in the
 * city, and actions.ts, governing how often somebody turns up wanting a ground
 * lease. Two copies of one brake, free to drift, and neither knew about the
 * other.
 *
 * It is Tobin's q for buildings, and the mechanism is the only thing that has
 * ever ended a glut: when finished product trades below replacement cost,
 * development stops at any interest rate in any phase, because you would be
 * manufacturing a loss.
 *
 * THE OLD SHAPE WAS `(vtr - 0.55) / 0.45`, AND THE 0.55 IS A CONFESSION. Its
 * own comment: "The first cut of this braked on (vtr - 0.80)/0.25, which reads
 * fine until you measure where the ratio actually sits: median 0.71 across real
 * runs, so the brake pinned at its 0.05 floor... centred where the game lives."
 * That is a constant moved to make an outcome come out right, and it was moved
 * to accommodate a valuation that was wrong by 13-38% by class. Fix the
 * valuation and the ratio moves to a median of 1.13 — parity, which is where a
 * value-to-replacement ratio belongs, because a market that persistently traded
 * below its own replacement cost would never have been built.
 *
 * So the centring is gone; there is nothing left to centre. What remains is the
 * ELASTICITY of construction to q, which is a measured quantity rather than a
 * fitted one: the housing-supply literature puts it between about 0.6 and 5
 * across metros with a central value near 1.5, and a land-constrained harbour
 * peninsula sits at the low end of that. Expressed as a power, which is what an
 * elasticity is, so a 10% move in q is a 12% move in starts.
 *
 * The rails are guards again rather than structure. Measured over 3 towns x 50
 * years the floor binds in 0% of months and the cap in 3%, against the old
 * form's floor binding whenever the market turned.
 */
const Q_ELASTICITY = 1.2;
export function buildClimate(s: GameState): number {
  const vtr = cityValueToReplacement(s);
  return Math.max(0.10, Math.min(2.5, Math.pow(Math.max(0.05, vtr), Q_ELASTICITY)));
}

export function maxFloorsFor(
  rec: { farMaxComm: number; farMaxRes: number; lotArea?: number }, coverage: number, use?: DevUse,
): number {
  // THE TOP FLOOR DOES NOT HAVE TO BE A FULL PLATE, AND ROUNDING IT AWAY MADE A
  // BIGGER FOOTPRINT BUILD A SMALLER BUILDING.
  //
  // This was `floor(FAR / coverage)`, which discards the fractional top floor.
  // The floor count then multiplies the footprint, so the loss lands on the
  // area — and because the discarded fraction depends on how coverage divides
  // into FAR, the area is not monotone in coverage at all. On a 10,000 sf lot
  // at FAR 4 it went:
  //
  //     coverage 0.50  ->  8 floors  ->  40,000 sf
  //     coverage 0.60  ->  6 floors  ->  36,000 sf
  //     coverage 0.70  ->  5 floors  ->  35,000 sf
  //     coverage 0.80  ->  5 floors  ->  40,000 sf
  //
  // Widening the footprint from half the lot to seven tenths cost 5,000 sf of
  // building. That is not a trade-off anybody chose; it is a rounding artefact
  // wearing the costume of a design decision, and it is what the owner reported
  // as "the higher of a footprint you use, the smaller the building will be".
  //
  // Zoning caps AREA, not floors. A builder allowed 4.0 FAR who wants a plate
  // covering 70% of the site puts up five full floors and a sixth that is
  // partially set back — which is what the top of a real building looks like
  // and why setbacks exist. So the storey allowance rounds UP, and
  // `planDevelopment` caps the resulting area at the envelope, so the last
  // floor is the part that gives way rather than the whole building.
  const zoning = Math.max(1, Math.ceil(farMaxFor(rec) / Math.max(0.08, coverage)));
  const plate = (rec.lotArea ?? 0) * Math.max(0.08, coverage);
  const physical = rec.lotArea ? Math.max(1, Math.min(zoning, physicalMaxFloors(plate))) : zoning;
  const byUse = use ? MAX_FLOORS_BY_USE[use] : undefined;
  return byUse === undefined ? physical : Math.min(physical, byUse);
}

/**
 * A site that wants to be taller than a shop can be. Anything the market would
 * put more than two floors on is a mixed building with retail at grade, not a
 * two-storey shop wasting a fifteen-FAR corner.
 */
export function retailWantsMixed(rec: { farMaxComm: number; farMaxRes: number; lotArea?: number }, coverage = 0.6): boolean {
  return maxFloorsFor(rec, coverage) > RETAIL_YIELDS_ABOVE;
}
// Where standalone shops stop making sense. The median vacant lot in this
// city carries six floors — a small plate tops out there on slenderness — so
// a threshold any lower converted literally every site to mixed and the town
// stopped building standalone retail at all. Above six the envelope is worth
// too much to spend on a two-storey shop; at or below it, a shop building is
// what actually gets built, and giving up the unused FAR is the price of the
// use, which is exactly the trade a real developer weighs.
const RETAIL_YIELDS_ABOVE = 6;

// The parcel as it will exist once the building is up — what the rent, the
// cap rate and the leasing costs all have to be read against.
function asBuiltRec(rec: unknown, use: DevUse, sf: number, floors: number) {
  const mix = devMix(use);
  return { ...(rec as object), class: dominantOf(mix), mix, bldgArea: sf, floors } as never;
}

export function planDevelopment(
  s: GameState, parcels: ParcelTable, bbl: string, use: DevUse,
  floors: number, coverage = 0.6,
  contract: Contract = "gmp", ltcWanted?: number,
  custom?: { mix?: UseMix; suites?: Partial<Record<BuiltClass, number>>; bts?: BtsCommitment },
  lender?: string,
  spec = 0.5,
  landBasisOverride?: number,
): DevPlan | null {
  // THE ENVELOPE YOU ACTUALLY HAVE. Zoning moves, variances are won and lots
  // are assembled — all of which live on the resolved record. Planning against
  // the static one meant the upzoning you read about on the news, and the
  // variance you paid a year of hearings for, bought you nothing at the desk.
  const rec = resolveRec(parcels, s, bbl);
  if (!rec || !rec.lotArea) return null;
  // A NUMBER THAT IS NOT A NUMBER IS NOT A DESIGN.
  //
  // NaN does not throw here, it propagates, and every guard downstream is a
  // COMPARISON — which against NaN is false, so each one waves it through. A
  // NaN floor count becomes a NaN square footage; `if (sf < 2000) return null`
  // does not fire; the budget, the commitment and the equity are all NaN; both
  // funding tests in startDevelopment ("can you fund it", "is the cheque in the
  // account") pass because NaN is neither less than nor greater than anything;
  // and the close does `cash -= NaN`. The state is JSON-cloned every tick, so
  // NaN comes back as null, the next `cash += x` turns null into x, and the
  // firm's entire bankroll has silently vanished with no error anywhere in the
  // chain. That is precisely what happened: it cost a merchant builder its
  // whole fund on the first groundbreak, in four seeds out of four, and read
  // as "ground-up development is value-destructive".
  //
  // ltcWanted was already defended against this below. It was never the only
  // way in — the caller supplies floors, coverage and spec too.
  if (!Number.isFinite(floors) || !Number.isFinite(coverage) || !Number.isFinite(spec)) return null;
  const cov = Math.max(0.08, Math.min(0.9, coverage));
  const farMax = farMaxFor(rec);
  // The mix has to be known before the height, because a programme that is
  // all shops is a two-storey building whatever the envelope allows.
  const raw = devMix(use, custom?.mix);
  const retailOnly = Object.entries(raw).every(([k, v]) => k === "retail" || !v);
  const fl = Math.max(1, Math.min(Math.round(floors), maxFloorsFor(rec, cov, retailOnly ? "retail" : use)));
  // GROSS AND RENTABLE ARE NOT THE SAME NUMBER, and treating them as one was
  // why assembling paid nothing. Zoning counts gross and the contractor bills
  // gross; you let rentable. The core, the two stairs, the risers and the
  // corridor take a bite out of every floor that is mostly FIXED — so a big
  // plate gives up a tenth of itself and a narrow one gives up a third.
  const plate = rec.lotArea * cov;
  const eff = plateEfficiency(plate);
  // ...AND THE ENVELOPE IS THE CAP, so the partial top floor `maxFloorsFor` now
  // allows cannot overrun the zoning. Coverage x floors can exceed the FAR by
  // up to one storey's worth; this is where that comes back off, and it comes
  // off the top floor rather than off the building. See the note on
  // `maxFloorsFor`: together these make building area depend on the ENVELOPE
  // and not on how neatly the coverage happened to divide into it.
  const envelope = rec.lotArea * farMaxFor(rec);
  const gsf = Math.round(Math.min(rec.lotArea * cov * fl, envelope) / 100) * 100;
  const sf = Math.round((gsf * eff) / 100) * 100;
  if (sf < 2000) return null;

  // Shops at grade wherever the street will carry them — see withStreetRetail.
  // Applied before the cap, so the cap still has the last word.
  const mix = capRetail(withStreetRetail(raw, fl, rec.demandScore ?? 50), fl);
  const proposedBts = custom?.bts;
  const bts = proposedBts
    && proposedBts.use !== "multifamily"
    && proposedBts.use in mix
    && proposedBts.sf > 0
    ? { ...proposedBts, sf: Math.min(sf * (mix[proposedBts.use] ?? 0), proposedBts.sf) }
    : undefined;
  const btsShare = bts ? Math.max(0, Math.min(1, bts.sf / Math.max(1, sf))) : 0;

  // the budget is the sum of the jobs, not a number attached to a label
  // ...priced on GROSS. You pay for the core; you do not let it.
  const specK = specCostMult(spec);
  const hardCost = Math.round(gsf * overMix(mix, (u) => HARD_COST_PSF[u]) * s.econ.costIdx * heightPremium(fl) * (1 + CONTRACT_PREMIUM[contract]) * specK);
  const softCost = Math.round(hardCost * SOFT_COST);
  const demo = rec.bldgArea > 0 ? Math.round(rec.bldgArea * 12 * s.econ.costIdx) : 0;
  const contingency = Math.round((hardCost + softCost) * CONTINGENCY);

  // THE LEASE-UP RESERVE.
  //
  // A building is not finished when the scaffolding comes down; it is finished
  // when it is full, and getting there costs money that never appears in the
  // headline budget: fit-out for every tenant, commissions to the brokers who
  // found them, and the carry on an empty building for months. Every job is
  // spec, so the whole building carries this — letting it during construction
  // is what claws it back.
  // AND THE OPERATING DEFICIT, WHICH IS THE PART THAT KILLED PEOPLE.
  //
  // The old reserve carried TEN MONTHS of operating cost. A commercial
  // building takes thirty-eight months to fill — that is the lease-up curve
  // the space market itself runs — and for every one of those months the
  // mini-perm charges interest on the whole balance. Ten months of opex on a
  // job carrying a $620k-a-year coupon is not a reserve, it is a down payment
  // on one.
  //
  // Traced end to end: a $11.5M office job delivered on programme, on budget,
  // with $0.6M of contingency handed back. Its reserve ran dry sixteen months
  // later, with the building 65% empty and still filling exactly as the model
  // said it would. The lender took it. Nothing had gone wrong — the budget
  // simply did not contain the cost of owning the thing until it earned.
  //
  // A real development budget carries an operating deficit reserve sized to
  // the gap between debt service and income across the whole absorption
  // period. It is expensive, it is financed, and it is the single biggest
  // reason a marginal deal does not pencil. That is the point.
  const openSf = sf;
  // apartments have no fit-out, but they do have concessions and marketing
  const tiPsf = overMix(mix, (u) => (u === "office" ? 32 : u === "retail" ? 22 : u === "industrial" ? 5 : 7));
  const asBuilt0 = asBuiltRec(rec, use, sf, fl);
  // Underwrite the rent tenants are actually paying after market-wide
  // concessions, not the asking-rent headline. This is the same effective-rent
  // index the class order pro forma reads.
  const effectiveRentFactor = overMix(mix, (u) =>
    (s.econ.effRentIdx?.[u] ?? s.econ.rentIdx[u]) / Math.max(1, s.econ.rentIdx[u]));
  const rentPsf0 = marketRentPsfYr(asBuilt0, s.econ, "good") * effectiveRentFactor;
  const lcPsf = overMix(mix, (u) => (u === "multifamily" ? 0 : 1)) * rentPsf0 * 6 * 0.045;
  // LEASE-UP DURATION IS A MARKET NUMBER. The old reserve assumed 19 months
  // for every apartment project and 38 for every commercial project, whether
  // vacancy was 2% or 20%. Scale that observed base duration by availability
  // against natural vacancy: tight markets fill faster; gluts take longer.
  const baseCarryMonths = overMix(mix, (u) => (u === "multifamily" ? 19 : 38));
  const availability = overMix(mix, (u) =>
    (s.econ.cityVac?.[u] ?? NATURAL_VAC[u])
      + (s.econ.sublet?.[u] ?? 0) / Math.max(1, s.econ.stock?.[u] ?? CITY_STOCK[u]));
  const naturalAvailability = overMix(mix, (u) => NATURAL_VAC[u]);
  // Floor used to be 0.5 — even a bone-dry street kept half a glut's lease-up
  // budget. Structural unmet demand shortens the curve further: the looking
  // book is already there. Cap still 2× in a real glut.
  const struct = overMix(mix, (u) => s.econ.structTight?.[u] ?? 0);
  const leaseRaw = availability / Math.max(0.001, naturalAvailability) - struct * 2.2;
  // Logistic curve to ~[0.35, 2] — the old clamp pinned the floor 50% of months.
  const leaseUpMarket = 0.35 + 1.65 / (1 + Math.exp(-(leaseRaw - 1) / 0.4));
  const carryMonths = Math.round(baseCarryMonths * leaseUpMarket);
  const opex0 = overMix(mix, (u) => opexPsf(u, s.econ, false));
  const recovery0 = overMix(mix, (u) => RECOVERY_RATE[u]);
  const stabOcc0 = overMix(mix, (u) => (u === "multifamily" ? 0.95 : 0.9));
  // Mean occupancy across the absorption curve the market actually runs
  // (0.2 + 0.8·t^0.75 over the span) is 0.657 of stabilised. Useful for the
  // opex carry, which is a total; useless for the deficit, which is not.
  const fillOcc = stabOcc0 * 0.657;
  // Debt service during lease-up is interest-only on the takeout, which is
  // sized off construction cost — a circular reference resolved the honest
  // way, by estimating it off the cost known so far rather than pretending it
  // is zero.
  const preReserve = hardCost + softCost + demo + contingency;

  // The construction lender funds construction. It does not refinance the
  // equity you already sank into the ground.
  // The lender's max is the ceiling; how much of it you TAKE is your call.
  // Less debt is a slower clock and a smaller reserve; more is more building
  // per dollar of equity and a harder landing if lease-up runs long.
  // The quote is the chosen desk's, not the town's. Rival and city jobs never
  // pass a lender, so they land on the regional — the historical default.
  //
  // Quoted on the construction cost before the reserves, because the reserves
  // are sized off the leverage and the leverage cannot wait for them. The
  // difference to the desk's own sizing is a rounding error; the difference to
  // the borrower of getting the reserve wrong is the building.
  const cqs = constructionQuotes(s, mix, preReserve);
  const cq = cqs.find((q) => q.lender === lender) ?? cqs.find((q) => q.lender === CONSTRUCTION_LENDER)!;
  let ltcMax = cq.open ? cq.ltcMax : 0;
  // A bankable lease turns speculative construction into contracted credit.
  // The boost is bounded by anchor share and covenant; it cannot exceed an
  // ordinary senior construction advance.
  if (bts && bts.credit >= 1) {
    const btsAdvance = (bts.credit === 2 ? 0.68 : 0.58) * btsShare;
    ltcMax = Math.max(ltcMax, btsAdvance);
  }
  // Math.min(x, undefined) is NaN, and a NaN here does not throw — it becomes
  // the commitment, then the equity, then the firm's cash, and the first thing
  // anyone sees is a balance sheet reading NaN twenty months later. Anything
  // that is not a real number is simply not a request.
  const wanted = Number.isFinite(ltcWanted as number) ? (ltcWanted as number) : ltcMax;
  const ltc = Math.max(0, Math.min(ltcMax, wanted));
  const ratePct = cq.ratePct;

  // THE DEFICIT IS AN INTEGRAL, NOT AN AVERAGE.
  //
  // Averaging income across the whole lease-up and comparing it to average
  // debt service reserves nothing, because the stream is deeply negative for
  // eighteen months and positive for twenty, and the two cancel. A reserve
  // sized that way is exactly zero on a job that needs half a million dollars
  // — which is the arithmetic that took the first building. What the reserve
  // has to cover is the SHORTFALL WHILE THERE IS ONE: sum the months the
  // building cannot pay its own coupon, and ignore the months it can, because
  // by then the money has already been spent.
  const dsMonthly = (preReserve * ltc * ((s.econ.indexRate + 2.1) / 100)) / 12;
  let deficit = 0;
  for (let t = 0; t < carryMonths; t++) {
    const occT = stabOcc0 * Math.min(1, 0.2 + 0.8 * Math.pow(t / carryMonths, 0.75));
    const noiT = (openSf * (rentPsf0 * occT - opex0 * (1 - recovery0 * occT))) / 12;
    deficit += Math.max(0, dsMonthly - noiT);
  }
  deficit = Math.round(deficit);
  const carry = Math.round(openSf * opex0 * (1 - fillOcc) * (carryMonths / 12));
  // TI tracks construction cost. Lease commissions are already a fraction of
  // today's rent (months × rate) — multiplying them by costIdx double-counts
  // a century of rent inflation and made lease-up reserves larger than hard
  // cost late-century, so densify could not clear a structural office short
  // even when stab NOI / build cost cleared the hurdle. Same split
  // `leaseUpValue` already uses for the vacant-building fill cheque.
  const specLeaseUp = Math.round(openSf * (tiPsf * s.econ.costIdx + lcPsf)) + carry + deficit;
  const anchorCost = bts
    ? Math.round(bts.sf * bts.tiPsf * s.econ.costIdx
      + bts.rentPsf * bts.sf * (bts.termM / 12) * 0.02)
    : 0;
  const leaseUp = Math.round(specLeaseUp * (1 - btsShare));

  // THE DIRT IS PART OF THE DEAL.
  //
  // Yield on cost was computed against construction cost alone, as if the site
  // had been free. It is not: it is the first and least recoverable dollar in
  // any development, and it is the whole reason a corner that rents for twice
  // as much does not automatically build for twice the profit. Leaving it out
  // made nearly four sites in five clear a hundred-basis-point hurdle — in a
  // business where most land sits vacant precisely because it does not pencil.
  //
  // It is NOT charged as cash — you already paid for it, and charging twice
  // would be its own lie — but it belongs in the denominator, because that is
  // what yield on cost means.
  const landBasis = Math.round(
    landBasisOverride ?? s.holdings[bbl]?.costBasis ?? landValue(rec, s.econ),
  );
  const buildCost = hardCost + softCost + demo + contingency + leaseUp + anchorCost;
  const costTotal = buildCost;
  const basisTotal0 = buildCost + landBasis;

  // Foundations, core, facade and fit-out: use the same class schedule the
  // market's delivery controls are calibrated to, then move toward its slow
  // end as height rises. The old player-only `10 + floors*0.85` made a
  // fourteen-storey office a 22-month job while every other office builder
  // took 30–44; after unifying the hurdle that split showed up immediately as
  // a 21-month breaks→deliveries cycle.
  const scheduleClass = dominantOf(mix);
  const [monthsLo, monthsHi] = BUILD_MONTHS[scheduleClass];
  const heightShare = Math.max(0, Math.min(1, (fl - 1) / 20));
  const months = Math.round(monthsLo + (monthsHi - monthsLo) * heightShare);

  // THE INTEREST RESERVE, SIZED TO ACTUALLY DO ITS JOB.
  //
  // A construction lender does not send the borrower a bill. It sizes a pot
  // inside its own commitment, advances the interest to itself out of that pot
  // every month, and takes the whole thing out — principal and capitalised
  // interest together — when the perm lender refinances it at delivery. The
  // borrower's cash goes into the building, not into carry. That is the
  // standard structure and it was not what this was doing.
  //
  // The old figure was simple interest on 55% of the commitment for the
  // scheduled term. But interest here CAPITALISES — it is added to the balance
  // and earns interest itself — and the schedule slips, sometimes by months,
  // and the reserve was never resized when it did. So it ran dry on nearly
  // every job and dumped carry on the player mid-build, which is exactly the
  // thing that does not happen in the real world.
  //
  // Sized on the average outstanding balance, grossed up for compounding and
  // for a schedule that runs long. Anything left over is released at delivery.
  //
  // The reserve is part of the project's cost, and the commitment has to cover
  // its own carry as well as the building — otherwise the loan funds
  // (commitment - reserve) of construction, the equity funds the rest, and the
  // two together come up exactly one reserve short of paying for the job. That
  // shortfall was landing on the player as a capital call at the worst point
  // of the S-curve.
  //
  // Since the reserve is a function of the commitment and the commitment is a
  // function of the reserve, solve it rather than iterate:
  //     C = ltc * (cost + rC)  =>  C = ltc*cost / (1 - ltc*r)
  const rFrac = costTotal > 0 ? reserveFor(1, ratePct, months) : 0;
  const commitment = Math.round((ltc * costTotal) / Math.max(0.35, 1 - ltc * rFrac));
  const interestReserve = Math.round(reserveFor(commitment, ratePct, months));
  // financing cost is a line in every development budget, and it belongs in
  // the basis the yield is measured against
  const projectCost = costTotal + interestReserve;

  // Yield on cost against today's stabilised rents — the number a developer
  // actually lives by, and the spread to the exit cap is the whole margin.
  const asBuilt = asBuiltRec(rec, use, sf, fl);
  // ORIGINATION IS A COST OF THE PROJECT, not a fee that happens next to it.
  // The interest reserve was already in here for exactly this reason; the
  // points are the same kind of money — a line in every development budget,
  // paid in cash at close, capitalised into project cost by every developer
  // who has ever filled one in. Leaving them out understated the basis by
  // about a point of the loan and made yield on cost fractionally generous on
  // every deal in the game. It is computed here rather than added to
  // costTotal because the commitment is sized off costTotal — putting it
  // upstream would be circular.
  const pointsCost = commitment > 0 ? Math.round(commitment * cq.points) : 0;
  const basisTotal = basisTotal0 + interestReserve + pointsCost;
  // ONE VALUATION IDENTITY. The pro forma used to invent a parallel NOI
  // (flat 90% occ, tax stripped off basis, capitalised at a bare exit cap)
  // while `assetValue` / `holdingValue` marked the same finished building a
  // third lower — ECONOMY.md open finding #3. Stabilised NOI is now the same
  // stack the street marks with (`noiYr(..., true)`), and the exit yield is
  // the same tax-loaded capitalisation `assetValue` uses. BTS overlays the
  // committed share on top of that market read.
  const marketStabNoi = noiYr(asBuilt, s.econ, "good", true);
  let stabNoi = marketStabNoi;
  if (btsShare > 0 && bts) {
    const opex = overMix(mix, (u) => opexPsf(u, s.econ, false));
    const recovery = overMix(mix, (u) => RECOVERY_RATE[u]);
    const egiPsf = bts.rentPsf + opex * recovery;
    const btsNoi = sf * (egiPsf - opex - egiPsf * MGMT_FEE);
    stabNoi = marketStabNoi * (1 - btsShare) + btsNoi * btsShare;
  }
  const exitCap = capRateFor(asBuilt, s.econ, "good");
  const exitYieldPct = exitCap + TAX_RATE * 100 * taxBorneShare(asBuilt);
  const yieldOnCost = basisTotal > 0 ? (stabNoi / basisTotal) * 100 : 0;
  // Hurdle against the tax-loaded exit the mark will actually use — not a
  // bare cap that made every tower look like 1.78x on a job that marks at 1.03x.
  const { requiredYield, hurdleRatio } = developmentHurdle(yieldOnCost, exitYieldPct);

  const lenderNote = ltc === 0
    ? "No construction lender will touch spec commercial in a recession. Pre-lease it, or fund the whole thing yourself."
    : hurdleRatio < 1
      ? `Yield on cost is ${yieldOnCost.toFixed(2)}% against a ${requiredYield.toFixed(2)}% required yield `
        + `(${exitCap.toFixed(2)}% exit, tax-loaded to ${exitYieldPct.toFixed(2)}%, plus the developer margin). `
        + `That is a way to build a building for more than it is worth.`
      : undefined;

  const plan: DevPlan = {
    use, mix, floors: fl, coverage: cov, contract, sf,
    far: +(gsf / rec.lotArea).toFixed(1), farMax,
    hardCost, softCost, contingency, demo, leaseUp, costTotal, landBasis, basisTotal,
    ltc, ltcMax, commitment, interestReserve, ratePct,
    lender: cq.lender, points: cq.points, pointsCost,
    equity: projectCost - commitment,
    // Equity funds FIRST. The bank does not release a dollar until yours are
    // in the ground, which is why a development eats your balance sheet at the
    // start rather than in even slices.
    equityAtClose: Math.round((projectCost - commitment) * 0.55),
    // `exitCap` on the plan is the tax-loaded exit yield the hurdle uses —
    // the same capitalisation `assetValue` applies — so reuse / residual
    // readers that call developmentHurdle(yoc, plan.exitCap) stay consistent.
    months, yieldOnCost, exitCap: exitYieldPct, requiredYield, hurdleRatio, spec: clamp01(spec), bts, btsShare, lenderNote,
  };
  // The second half of the NaN gate above. Bad inputs are one way to get a
  // plan full of nonsense; a divide by a zero lot, a mix that sums to nothing,
  // or an arithmetic path nobody anticipated are others. No plan leaves this
  // function unless every number in it is a number — a null here reads to the
  // caller as "this site cannot be planned", which is the truth.
  for (const v of Object.values(plan)) {
    if (typeof v === "number" && !Number.isFinite(v)) return null;
  }
  return plan;
}

export interface DevelopmentUnderwriting {
  plan: DevPlan;
  clears: boolean;
  financeable: boolean;
  appetite: number;
  why?: string;
}

export function adaptiveReuseEligibility(
  s: GameState, parcels: ParcelTable, bbl: string,
): { ok: boolean; why?: string; occupancy?: number } {
  const h = s.holdings[bbl];
  const rec = h ? resolveRec(parcels, s, bbl) : null;
  if (!h || !rec) return { ok: false, why: "You do not own that building." };
  if (rec.class === "land" || !rec.bldgArea) return { ok: false, why: "There is no shell to convert." };
  if (rec.class === "multifamily" || (mixOf(rec).multifamily ?? 0) > 0.5) {
    return { ok: false, why: "This is already predominantly housing." };
  }
  if (s.landmarks?.[bbl] !== undefined) return { ok: false, why: "Landmark controls do not permit this conversion." };
  if (s.developments[bbl]) return { ok: false, why: "A project is already under way." };
  if (h.groundLeased || s.groundLeases?.[bbl]) return { ok: false, why: "The ground lessee controls the improvement." };
  if (h.sale) return { ok: false, why: "Pull the sale process before starting a conversion." };
  if (h.loan || (h.mezz?.balance ?? 0) > 0 || s.facility?.bbls.includes(bbl)) {
    return { ok: false, why: "Existing secured debt must be paid off or released before a conversion loan closes." };
  }
  const occupied = h.tenants.reduce((a, t) => a + t.sf, 0)
    + (h.occ ?? 0) * useSf(rec, "multifamily");
  const occupancy = occupied / Math.max(1, rec.bldgArea);
  if (occupancy > 0.20) {
    return { ok: false, why: `The building is ${(occupancy * 100).toFixed(0)}% occupied. Stop leasing and obtain vacant possession first.`, occupancy };
  }
  return { ok: true, occupancy };
}

export function planAdaptiveReuse(
  s: GameState, parcels: ParcelTable, bbl: string,
  target: "multifamily" | "mixed" = "multifamily",
  customMix?: UseMix,
): DevPlan | null {
  const eligible = adaptiveReuseEligibility(s, parcels, bbl);
  if (!eligible.ok) return null;
  const rec = resolveRec(parcels, s, bbl)!;
  const coverage = Math.max(0.08, Math.min(0.9,
    rec.bldgArea / Math.max(1, rec.lotArea * rec.floors)));
  const opportunity = ownedHoldingValue(s, parcels, s.holdings[bbl]);
  // A housing conversion keeps a small active ground-floor allowance but does
  // not let the generic new-build rule turn a two-storey shell into mostly
  // shops (its 1.25-floor retail assumption is for ground-up podium design).
  const reuseMix = customMix ?? (target === "multifamily"
    ? { multifamily: 0.95, retail: 0.05 }
    : { multifamily: 0.70, office: 0.20, retail: 0.10 });
  const planUse: DevUse = "mixed"; // custom programme must travel through devMix
  const base = planDevelopment(
    s, parcels, bbl, planUse, rec.floors, coverage, "gmp",
    undefined, { mix: reuseMix }, undefined, 0.5, opportunity,
  );
  if (!base) return null;
  // Reuse keeps structure and much of the envelope, but replaces interiors,
  // risers, services and life-safety systems. Cost and time are materially
  // below demolition/new-build; lease-up remains the target programme's risk.
  const hardCost = Math.round(base.hardCost * 0.58);
  const softCost = Math.round(base.softCost * 0.70);
  const demo = Math.round(base.demo * 0.30);
  const contingency = Math.round((hardCost + softCost) * CONTINGENCY);
  const costTotal = hardCost + softCost + demo + contingency + base.leaseUp;
  const scale = costTotal / Math.max(1, base.costTotal);
  const commitment = Math.round(base.commitment * scale);
  const interestReserve = Math.round(base.interestReserve * scale);
  const pointsCost = Math.round(base.pointsCost * scale);
  const equity = Math.max(0, costTotal + interestReserve - commitment);
  const basisTotal = opportunity + costTotal + interestReserve + pointsCost;
  const stabilizedNoi = base.yieldOnCost / 100 * base.basisTotal;
  const yieldOnCost = stabilizedNoi / Math.max(1, basisTotal) * 100;
  const { requiredYield, hurdleRatio } = developmentHurdle(yieldOnCost, base.exitCap);
  return {
    ...base,
    hardCost, softCost, demo, contingency, costTotal,
    commitment, interestReserve, pointsCost,
    equity, equityAtClose: Math.round(equity * 0.55),
    basisTotal, yieldOnCost, requiredYield, hurdleRatio,
    months: Math.max(9, Math.round(base.months * 0.70)),
    lenderNote: hurdleRatio < 1
      ? `Conversion yield is ${yieldOnCost.toFixed(2)}% against ${requiredYield.toFixed(2)}% required.`
      : base.lenderNote,
  };
}

export function startAdaptiveReuse(
  s: GameState, parcels: ParcelTable, bbl: string,
  target: "multifamily" | "mixed" = "multifamily", customMix?: UseMix,
): { s: GameState; err?: string; msg?: string } {
  const eligible = adaptiveReuseEligibility(s, parcels, bbl);
  if (!eligible.ok) return { s, err: eligible.why };
  const rec = resolveRec(parcels, s, bbl)!;
  const plan = planAdaptiveReuse(s, parcels, bbl, target, customMix);
  if (!plan) return { s, err: "That conversion cannot be planned." };
  if (plan.hurdleRatio < 1) return { s, err: plan.lenderNote ?? "The conversion does not clear its economic hurdle." };
  const margin = Math.round(plan.costTotal * 0.06);
  if (s.cash + locAvailable(s, parcels) < plan.equity + plan.pointsCost + margin) {
    return { s, err: `The conversion requires $${(plan.equity / 1e6).toFixed(2)}M of equity plus a change-order margin.` };
  }
  if (s.cash < plan.equityAtClose + plan.pointsCost) {
    return { s, err: `$${((plan.equityAtClose + plan.pointsCost) / 1e6).toFixed(2)}M is due at closing.` };
  }
  const next = clone(s);
  const nh = next.holdings[bbl];
  next.cash -= plan.equityAtClose + plan.pointsCost;
  logBooks(next, "dev", plan.equityAtClose + plan.pointsCost);
  const oldMix = mixOf(rec);
  for (const use of BUILT_CLASSES) {
    const oldSf = useSf(rec, use);
    if (oldSf > 0) addStock(next.econ, use, -oldSf);
  }
  next.cash -= depositsOn(nh);
  nh.tenants = [];
  nh.occ = 0;
  queueSupplyProject(next, {
    bbl, source: "reuse", deliverM: next.month + plan.months,
    sfByUse: programmeSf(plan.sf, plan.mix),
  });
  next.developments[bbl] = {
    bbl, use: target, mix: plan.mix, sf: plan.sf, floors: plan.floors,
    coverage: plan.coverage, costTotal: plan.costTotal, hardCost: plan.hardCost,
    contract: "gmp", landBasis: plan.landBasis,
    contingency: plan.contingency, contingencyUsed: 0,
    lender: plan.lender, commitment: plan.commitment, drawn: 0, loanBalance: 0,
    interestReserve: plan.interestReserve, reserveUsed: 0,
    leaseUpReserve: plan.leaseUp, equityBudget: plan.equity,
    equitySpent: plan.equityAtClose, equityPrefunded: plan.equityAtClose,
    ratePct: plan.ratePct, startM: next.month, deliverM: next.month + plan.months,
    baseMonths: plan.months, piped: true, signed: [], events: 0,
    mode: "reuse", reuseFrom: oldMix,
    reuseOldSf: rec.bldgArea,
  };
  recordPropertyEvent(next, bbl, {
    kind: "build-start", use: target, sf: plan.sf, floors: plan.floors,
    party: firmShort(next), outcome: `Adaptive reuse from ${rec.class}`,
  });
  next.news.unshift({
    q: next.month, kind: "deal", bbl,
    text: `Conversion underway at ${rec.address}: ${rec.class} shell to ${target}, `
      + `${Math.round(plan.sf).toLocaleString()} sf, delivery ${monthLabel(next.month + plan.months)}.`,
  });
  return { s: next, msg: "Conversion started." };
}

/**
 * THE SAME SITE-LEVEL UNDERWRITING FOR EVERY NON-PLAYER BUILDER.
 *
 * `planDevelopment` is the complete pro forma: site rent and vacancy, hard and
 * soft cost, demolition, lease-up, land basis, construction rate, points,
 * interest reserve, stabilized NOI and exit cap. The player sees it directly;
 * city and rival starts used to substitute class indices and phase labels.
 *
 * The player may deliberately build a bad or all-cash project. Autonomous
 * builders may not: they require both the common economic hurdle and an open
 * construction desk.
 */
export function underwriteDevelopment(
  s: GameState, parcels: ParcelTable, bbl: string, use: DevUse,
  floors: number, coverage = 0.62, landBasisOverride?: number,
): DevelopmentUnderwriting | null {
  const plan = planDevelopment(
    s, parcels, bbl, use, floors, coverage, "gmp",
    undefined, undefined, undefined, 0.5, landBasisOverride,
  );
  if (!plan) return null;
  const financeable = plan.ltcMax > 0 && plan.commitment > 0;
  const clears = financeable && plan.hurdleRatio >= 1;
  return {
    plan,
    clears,
    financeable,
    // Same land-constrained supply elasticity used by devPencils. No floor:
    // a project below its required yield has zero autonomous appetite.
    appetite: clears ? Math.min(3, Math.pow(plan.hurdleRatio, 1.2)) : 0,
    why: !financeable
      ? "No construction desk is open."
      : plan.hurdleRatio < 1
        ? `${plan.yieldOnCost.toFixed(2)}% yield on cost is below the ${plan.requiredYield.toFixed(2)}% required yield.`
        : undefined,
  };
}

/**
 * Publish what the order desk can actually build on real parcels.
 *
 * The city examines 36 candidate lots for each crane and takes the best.
 * The expected best observation is therefore about the 36/37 = 97th
 * percentile, so this is not a tuned percentile. It closes the last dual-pencil
 * seam: macro orders now know whether the same full parcel pro forma that will
 * judge the eventual groundbreak clears anywhere the city is likely to find.
 */
export function refreshDevelopmentFeasibility(
  s: GameState, parcels: ParcelTable, bbls: string[],
): void {
  if (s.econ.sitePencil && s.month % 12 !== 0) return;
  const scores: Record<BuiltClass, number[]> = {
    office: [], retail: [], multifamily: [], industrial: [],
  };
  // DO NOT WALK THE WHOLE CITY WITH A FULL PRO FORMA. A Great City has nearly
  // six thousand lots; four plans per lot blocked the browser's main thread
  // for seconds on every annual advance. The actual city examines 36 lots for
  // one crane. Four independent crane samples (144 valid sites) estimate its
  // P97 tail without making map size a UI-latency multiplier.
  //
  // Local LCG, not the game's RNG stream: measuring feasibility must not
  // re-roll the economy. Month changes the sample each annual refresh.
  //
  // AND REDEVELOPMENT SITES COUNT. Macro orders used to sample vacant dirt
  // only, so a built-out town under chronic `structTight` looked like it had
  // nowhere to build — while worn FAR-rich lots sat unexamined. The order
  // book must see densify candidates too — but in SEPARATE quotas. A first
  // cut that mixed them filled all 144 slots with worn buildings (plentiful)
  // and zeroed the office pencil because those lots only cleared as housing.
  // Appetite is multiplicative on sitePencil; a zero pencil is a shut class.
  const LAND_N = 96;
  const REDEV_N = 72;
  const chosen = new Set<string>();
  let x = (s.seed ^ Math.imul(s.month + 1, 0x9e3779b1)) >>> 0;
  const yrNow = START_YEAR + Math.floor(s.month / 12);
  let landCount = 0, redevCount = 0;
  const maxAttempts = Math.min(bbls.length * 3, (LAND_N + REDEV_N) * 24);
  for (let attempt = 0; attempt < maxAttempts && (landCount < LAND_N || redevCount < REDEV_N); attempt++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const bbl = bbls[x % bbls.length];
    if (!bbl || chosen.has(bbl)) continue;
    if (s.holdings[bbl] || s.developments[bbl] || (s.cityJobs ?? []).some((j) => j.bbl === bbl)) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.lotArea < 1_500 || ownerOf(s, bbl)) continue;
    if (rec.class === "land") {
      if (landCount >= LAND_N) continue;
      chosen.add(bbl);
      landCount++;
      for (const use of BUILT_CLASSES) {
        const floors = Math.min(14, maxFloorsFor(rec, 0.62, use));
        const u = underwriteDevelopment(s, parcels, bbl, use, floors, 0.62);
        // Only clearing pencils. Pushing appetite-zero failures from densify
        // sites diluted the P97 and zeroed whole classes (office went to 0
        // while multifamily stayed live — the order book then starved office).
        if (u?.clears && u.appetite > 0) scores[use].push(u.appetite);
      }
      continue;
    }
    if (redevCount >= REDEV_N) continue;
    if (!rec.bldgArea) continue;
    const age = yrNow - (rec.yearBuilt || 1900);
    if (age < 45) continue;
    const cond = gradeOf(s, rec);
    if (cond !== "obsolete" && cond !== "worn" && cond !== "standard") continue;
    // Only sites that can grow housable floor under today's cornice/shortage.
    const leadGuess = rec.class as BuiltClass;
    const infill = cityInfillCap(s, parcels, rec, Math.min(1, s.month / 780), leadGuess);
    const targetSf = rec.lotArea * 0.62 * infill;
    if (targetSf < rec.bldgArea * 1.12) continue;
    chosen.add(bbl);
    redevCount++;
    // Same basis tickTeardowns uses for unowned fabric: land (+ demo in plan).
    const opp = landValue(rec, s.econ);
    for (const use of BUILT_CLASSES) {
      const floors = Math.min(infill, maxFloorsFor(rec, 0.62, use));
      if (rec.lotArea * 0.62 * floors < rec.bldgArea * 1.08) continue;
      const u = underwriteDevelopment(s, parcels, bbl, use, floors, 0.62, opp);
      if (u?.clears && u.appetite > 0) scores[use].push(u.appetite);
    }
  }
  s.econ.sitePencil = { office: 0, retail: 0, multifamily: 0, industrial: 0 };
  for (const use of BUILT_CLASSES) {
    const xs = scores[use].sort((a, b) => a - b);
    const at = xs.length ? Math.floor((xs.length - 1) * (36 / 37)) : 0;
    s.econ.sitePencil[use] = xs[at] ?? 0;
  }
}

const BTS_NAMES = [
  "Northstar Logistics", "Harbour Medical", "Alden Foods", "Copperline Data",
  "Mariner Components", "Union Market", "Beacon Systems", "Drydock Supply",
];

/**
 * LIST THE SITE FOR A BUILD-TO-SUIT OCCUPIER.
 *
 * This used to mint a named tenant on the click — a headquarters for free, any
 * month you wanted one. Real BTS is a listing: you put a shell on the street
 * and wait for an anchor whose programme fits. The counterparty arrives
 * through tickBuildToSuit at odds set by demand, climate and how much space
 * you are asking someone to take.
 */
export function proposeBuildToSuit(
  s: GameState, parcels: ParcelTable, bbl: string, use: DevUse,
  floors: number, coverage = 0.62,
): { s: GameState; err?: string; msg?: string } {
  if (use !== "office" && use !== "retail" && use !== "industrial") {
    return { s, err: "Build-to-suit is for an office headquarters, anchor retail or an industrial user." };
  }
  if (!s.holdings[bbl]) return { s, err: "Buy the site before shopping it to an occupier." };
  if (s.developments[bbl]) return { s, err: "Construction is already under way." };
  if (s.btsProspects?.[bbl]) {
    return { s, err: "You already have signed terms on this site. Take them or return to spec before shopping it again." };
  }
  if (s.holdings[bbl].sale) return { s, err: "It's on the market — pull the sale listing before you shop it to an occupier." };
  if (s.holdings[bbl].groundOffer) return { s, err: "It is on offer for a ground lease. Pull that before you shop a build-to-suit." };
  if (s.groundLeases?.[bbl]) return { s, err: "That site is ground-leased. Somebody else builds on it." };
  if (s.merged?.[bbl]) return { s, err: "That lot is part of an assemblage — shop the whole site." };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec || rec.class !== "land" || rec.bldgArea > 0) return { s, err: "Build-to-suit starts on clear land." };
  const plan = planDevelopment(s, parcels, bbl, use, floors, coverage, "gmp");
  if (!plan) return { s, err: "That programme cannot be built on this site." };
  const next = clone(s);
  const prev = next.holdings[bbl].btsOffer;
  const same = prev
    && prev.use === use
    && prev.floors === plan.floors
    && Math.abs(prev.coverage - coverage) < 0.001;
  next.holdings[bbl].btsOffer = {
    use, floors: plan.floors, coverage, sinceM: same ? prev!.sinceM : next.month,
  };
  return {
    s: next,
    msg: same
      ? "Still on the book — an anchor comes when one comes."
      : `Listed ${plan.floors} fl of ${use} (${Math.round(plan.sf).toLocaleString()} sf) for a build-to-suit. Now you wait.`,
  };
}

/** Withdraw the BTS listing, or decline signed terms and go back to spec. */
export function clearBuildToSuit(s: GameState, bbl: string): GameState {
  const hadOffer = !!s.holdings[bbl]?.btsOffer;
  const hadProspect = !!s.btsProspects?.[bbl];
  if (!hadOffer && !hadProspect) return s;
  const next = clone(s);
  if (next.holdings[bbl]?.btsOffer) delete next.holdings[bbl].btsOffer;
  if (next.btsProspects?.[bbl]) {
    delete next.btsProspects[bbl];
    if (!Object.keys(next.btsProspects).length) delete next.btsProspects;
  }
  return next;
}

function mintBtsCommitment(
  s: GameState, parcels: ParcelTable, bbl: string,
  use: BuiltClass, floors: number, coverage: number,
): BtsCommitment | null {
  const plan = planDevelopment(s, parcels, bbl, use, floors, coverage, "gmp");
  if (!plan) return null;
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return null;
  const credit = (rng(s, "leasing") < 0.58 ? 2 : 1) as 1 | 2;
  const sector = (use === "industrial" ? "logistics"
    : use === "retail" ? "food" : rng(s, "leasing") < 0.5 ? "tech" : "finance") as import("./types").Sector;
  const name = BTS_NAMES[Math.floor(rng(s, "leasing") * BTS_NAMES.length)];
  const built = {
    ...rec, class: use, mix: { [use]: 1 }, bldgArea: plan.sf, floors: plan.floors,
  } as never;
  const market = marketRentPsfYr(built, s.econ, "good");
  const discount = credit === 2 ? rrange(s, 0.82, 0.88, "leasing") : rrange(s, 0.78, 0.85, "leasing");
  const useSfArea = plan.sf * (plan.mix[use] ?? 1);
  return {
    name,
    sector,
    credit,
    use,
    sf: Math.round(useSfArea),
    rentPsf: +(market * discount).toFixed(2),
    termM: credit === 2 ? 240 : 180,
    tiPsf: use === "office" ? 35 : use === "retail" ? 24 : 8,
    recovery: use === "office" ? "base" : "nnn",
    signedM: s.month,
  };
}

/**
 * Anchors arrive on BTS listings. Scarce on purpose — a named credit tenant
 * committing before groundbreak is rarer than a speculative lease after delivery,
 * and the button used to pretend otherwise.
 */
export function tickBuildToSuit(s: GameState, parcels: ParcelTable) {
  for (const h of Object.values(s.holdings)) {
    const offer = h.btsOffer;
    if (!offer) continue;
    const rec = resolveRec(parcels, s, h.bbl);
    // The listing dies quietly when the lot stops being shoppable.
    if (!rec || rec.class !== "land" || rec.bldgArea > 0
      || s.developments[h.bbl] || s.merged?.[h.bbl] || h.sale
      || h.groundOffer || s.groundLeases?.[h.bbl]
      || s.btsProspects?.[h.bbl]
      || (s.built?.[h.bbl]?.bldgArea ?? 0) > 0) {
      delete h.btsOffer;
      continue;
    }
    const plan = planDevelopment(s, parcels, h.bbl, offer.use, offer.floors, offer.coverage, "gmp");
    if (!plan) { delete h.btsOffer; continue; }
    const climate = buildClimate(s);
    const demand = demandNow(s, rec) / 100;
    // Bigger shells need rarer anchors. A 40k pad turns over; a 250k HQ does not.
    const sizeHard = Math.max(0.55, Math.min(2.4, plan.sf / 90_000));
    const phaseHit = s.econ.phase === "depression" ? 0.45
      : s.econ.phase === "recession" ? 0.55
      : s.econ.phase === "recovery" ? 0.8
      : s.econ.phase === "peak" ? 1.1
      : 1;
    const p = Math.min(0.09, (0.004 + 0.045 * demand * climate) * phaseHit / sizeHard);
    if (rng(s, "leasing") >= p) continue;
    const bts = mintBtsCommitment(s, parcels, h.bbl, offer.use, offer.floors, offer.coverage);
    if (!bts) continue;
    delete h.btsOffer;
    if (!s.btsProspects) s.btsProspects = {};
    s.btsProspects[h.bbl] = bts;
    const waited = Math.max(1, s.month - offer.sinceM);
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `Build-to-suit at last: ${bts.name} will take ${Math.round(bts.sf).toLocaleString()} sf `
        + `of ${bts.use} at ${rec.address} for ${Math.round(bts.termM / 12)} years at $${bts.rentPsf.toFixed(2)}/sf `
        + `(credit ${bts.credit === 2 ? "strong" : "solid"}), after `
        + `${waited >= 24 ? `${Math.round(waited / 12)} years` : `${waited} month${waited === 1 ? "" : "s"}`} on the book. `
        + `Break ground on their shell, or send them away and go back to spec.`,
    });
  }
}

export function startDevelopment(
  s: GameState, parcels: ParcelTable, bbl: string, use: DevUse,
  floors: number, coverage = 0.6,
  contract: Contract = "gmp", ltcWanted?: number,
  custom?: { mix?: UseMix; suites?: Partial<Record<BuiltClass, number>>; bts?: BtsCommitment },
  lender?: string,
  spec = 0.5,
): { s: GameState; err?: string } {
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  if (!s.holdings[bbl]) return { s, err: "Buy the dirt first." };
  if (rec.class !== "land") return { s, err: "Clear the site first — demolish what's standing before you build." };
  if (s.developments[bbl]) return { s, err: "Construction is already underway." };
  // You cannot break ground on a site you are trying to sell. Somebody is
  // marketing this lot to buyers right now.
  if (s.holdings[bbl].sale) return { s, err: "It's on the market — pull the listing before you put a crane on it." };
  if (s.landmarks?.[bbl] !== undefined) return { s, err: "It is landmarked — the envelope is what is already standing." };
  if (s.groundLeases?.[bbl]) return { s, err: "That site is ground-leased. Somebody else builds on it until the term runs out." };
  if (s.merged?.[bbl]) return { s, err: "That lot is part of an assemblage — build on the site, not the piece." };
  const plan = planDevelopment(s, parcels, bbl, use, floors, coverage, contract, ltcWanted, custom, lender, spec);
  if (!plan) return { s, err: "That's too small to be worth building — add floors or cover more of the lot." };
  // AND NOTHING UNPRICEABLE CLOSES. planDevelopment refuses a design it cannot
  // draw; this refuses a budget it cannot add up, whatever made it unaddable.
  // Every test below this line is a comparison, and a comparison is exactly
  // what a NaN walks through — so the arithmetic is checked once, here, before
  // any of them run.
  const unpriced = [plan.sf, plan.floors, plan.costTotal, plan.commitment, plan.interestReserve,
    plan.equity, plan.equityAtClose, plan.pointsCost, plan.months, plan.ratePct]
    .some((n) => !Number.isFinite(n));
  if (unpriced) return { s, err: "The numbers on that job do not add up — nobody can price it, so nobody will fund it." };
  // YOU HAVE TO BE ABLE TO FUND THE WHOLE THING.
  //
  // This used to test only the day-one cheque, which is 55% of the equity —
  // so a player with exactly that much could break ground on a job whose
  // remaining 45% was going to be drawn out of an account that did not have
  // it, month after month, while the building went up. That is not a hard
  // decision, it is a trap: the number on the button was not the number, and
  // the rest arrived without warning.
  //
  // No construction lender on earth closes without evidence the sponsor can
  // fund its whole share — that is the first thing they ask for. The line of
  // credit counts, because it is committed money and that is what it is for.
  const commitCap = plan.equity + plan.pointsCost + Math.round(plan.costTotal * 0.06);   // and a margin for change orders — origination is cash at close too
  const fundable = s.cash + locAvailable(s, parcels);
  if (fundable < commitCap) {
    const short = commitCap - fundable;
    return {
      s,
      err: `Equity short $${(short / 1e6).toFixed(2)}M to finish this job. `
        + `Needs $${(plan.equity / 1e6).toFixed(2)}M equity all-in ($${(plan.equityAtClose / 1e6).toFixed(2)}M at close) `
        + `plus change-order margin; you can fund $${(fundable / 1e6).toFixed(2)}M including the line. `
        + `Cut floors or coverage, buy cash-flowing buildings first, or bring more capital — no lender closes without evidence you can finish.`,
    };
  }
  if (s.cash < plan.equityAtClose + plan.pointsCost) {
    const dayOne = plan.equityAtClose + plan.pointsCost;
    const short = dayOne - s.cash;
    return {
      s,
      err: `Equity short $${(short / 1e6).toFixed(2)}M at close. `
        + `The bank funds nothing until $${(dayOne / 1e6).toFixed(2)}M is in the ground (equity plus origination) `
        + `of $${((plan.equity + plan.pointsCost) / 1e6).toFixed(2)}M total. Cut the massing or raise cash first.`,
    };
  }
  const next = clone(s);
  // The origination fee is the lender's, paid at close and never part of the
  // job's own budget — folding it into the prefund would hand it back later as
  // free construction money.
  next.cash -= plan.equityAtClose + plan.pointsCost;
  logBooks(next, "dev", plan.equityAtClose + plan.pointsCost);
  if (plan.commitment > 0) bumpLenderRel(next, plan.lender, 2);   // a closed loan starts a file
  noteRecordPlan(next, parcels, bbl, dominantOf(plan.mix), plan.sf, plan.floors, firmShort(next));
  // YOUR CRANE IS IN THE SAME SKY AS EVERYBODY ELSE'S. A city job enters
  // econ.cohorts the month the hole is dug (tickCityGrowth), and a rival's own
  // job does too (startOwnJob) — but the player's never did. Two million
  // square feet of your office appeared in no delivery schedule, moved no
  // projected vacancy, and then landed on the market as a surprise the month
  // it opened. Same queue as everyone now, tagged with the parcel so a
  // schedule slip can move it and an abandoned job can pull it back out; and
  // it fills part of the order the space market has already placed
  // (startOwed), exactly as an anonymous start on the same corner would have.
  const playerProgramme = programmeSf(plan.sf, plan.mix);
  queueSupplyProject(next, {
    bbl,
    source: "player",
    deliverM: next.month + plan.months,
    sfByUse: playerProgramme,
  });
  for (const [u, usf] of Object.entries(playerProgramme)) {
    if (next.econ.startOwed) {
      next.econ.startOwed[u as BuiltClass] = Math.max(0, (next.econ.startOwed[u as BuiltClass] ?? 0) - usf);
    }
  }
  next.developments[bbl] = {
    spec: plan.spec,
    bbl, use, mix: plan.mix, sf: plan.sf, floors: plan.floors,
    coverage: plan.coverage,
    suites: custom?.suites,
    costTotal: plan.costTotal, hardCost: plan.hardCost, contract,
    landBasis: plan.landBasis,
    contingency: plan.contingency, contingencyUsed: 0,
    lender: plan.lender,
    commitment: plan.commitment, drawn: 0, loanBalance: 0,
    interestReserve: plan.interestReserve, reserveUsed: 0,
    leaseUpReserve: plan.leaseUp,
    equityBudget: plan.equity, equitySpent: plan.equityAtClose,
    // paid on day one, not yet applied against any work
    equityPrefunded: plan.equityAtClose,
    ratePct: plan.ratePct,
    startM: next.month, deliverM: next.month + plan.months, baseMonths: plan.months,
    piped: true,   // its cohort is in the market's queue, pushed above
    signed: [],
    bts: plan.bts,
    events: 0,
  } satisfies Development;
  if (next.btsProspects?.[bbl]) delete next.btsProspects[bbl];
  if (next.holdings[bbl]?.btsOffer) delete next.holdings[bbl].btsOffer;
  recordPropertyEvent(next, bbl, {
    kind: "build-start",
    use,
    sf: plan.sf,
    floors: plan.floors,
    party: firmShort(next),
  });
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Ground broken at ${rec.address}: ${plan.floors} floors, ${(plan.sf / 1000).toFixed(0)}k sf of ${use === "mixed" ? "mixed-use" : use} at ${plan.far} FAR on a ${contract === "gmp" ? "guaranteed max price" : "cost-plus"} contract. $${(plan.costTotal / 1e6).toFixed(1)}M budget, ${(plan.ltc * 100).toFixed(0)}% funded by ${plan.lender}, ${plan.bts ? `for ${plan.bts.name} on a ${Math.round(plan.bts.termM / 12)}-year build-to-suit` : "on spec"}. Delivery ${monthLabel(next.month + plan.months)}.`,
  });
  return { s: next };
}

/**
 * YOU BOUGHT SOMEBODY ELSE'S HALF-FINISHED BUILDING.
 *
 * The frame is up, the sponsor is gone, and the receiver has taken your money
 * for the site and the steel on it. What you inherit is a job in progress: the
 * schedule that is left, the cost that is left, and a design you did not draw.
 * This is the cheapest way to own a new building and the reason a developer
 * watches the obituaries — and until the street could actually fail mid-job,
 * the game had no way to put one in front of you.
 *
 * Called from the closing, not by the player: buying the site IS taking the
 * job on. Mutates in place; the caller already cloned.
 */
export function takeoverDevelopment(
  s: GameState, parcels: ParcelTable, bbl: string,
  half: { use: string; sf: number; floors: number; progress: number; costToComplete: number },
) {
  const rec = resolveRec(parcels, s, bbl);
  if (!rec || !rec.lotArea || s.developments[bbl]) return;
  const use = half.use as DevUse;
  const floors = Math.max(1, Math.round(half.floors));
  const coverage = Math.max(0.08, Math.min(0.9, half.sf / Math.max(1, rec.lotArea * floors)));
  const plan = planDevelopment(s, parcels, bbl, use, floors, coverage, "gmp");
  if (!plan) return;
  const done = Math.max(0, Math.min(0.95, half.progress));
  // What is left to build, plus the lease-up money — which the dead sponsor's
  // budget no longer contains, because they spent it staying alive.
  const remaining = Math.max(0, Math.round(half.costToComplete)) + plan.leaseUp;
  const months = Math.max(3, Math.round(plan.months * (1 - done)) + 2);   // a stalled job restarts slowly
  // A takeover is financed, but not on construction-loan terms: the lender is
  // pricing a job somebody already failed at, so less of it and dearer.
  const commitment = Math.round(remaining * Math.max(0.35, plan.ltc - 0.12));
  s.developments[bbl] = {
    bbl, use, mix: plan.mix, sf: half.sf, floors,
    costTotal: remaining, hardCost: Math.round(remaining * 0.8), contract: "gmp",
    // A takeover buys the frame; what the buyer paid for the site IS their land basis.
    landBasis: s.holdings[bbl]?.costBasis ?? plan.landBasis,
    contingency: Math.round(remaining * CONTINGENCY), contingencyUsed: 0,
    commitment, drawn: 0, loanBalance: 0,
    interestReserve: Math.round(commitment * 0.05), reserveUsed: 0,
    leaseUpReserve: plan.leaseUp,
    equityBudget: Math.max(0, remaining - commitment), equitySpent: 0,
    equityPrefunded: 0,   // a takeover writes no cheque at close
    ratePct: +(s.econ.indexRate + 3.2).toFixed(2),
    startM: s.month, deliverM: s.month + months, baseMonths: months,
    // the dead sponsor's start already queued this building's square feet in
    // deliveryQueue; reschedule to the takeover finish date.
    piped: true,
    signed: [],
    events: 0,
  } satisfies Development;
  rescheduleSupplyProject(s, bbl, s.month + months);
  s.cityJobs = (s.cityJobs ?? []).filter((j) => j.bbl !== bbl);
  s.news.unshift({
    q: s.month, kind: "deal",
    text: `You have taken over the job at ${rec.address} — ${(done * 100).toFixed(0)}% built, `
      + `$${(remaining / 1e6).toFixed(1)}M to finish and open, delivery ${monthLabel(s.month + months)}. `
      + `Somebody else paid for the hole in the ground.`,
  });
}

// Take a building down to clean dirt. The rubble costs real money, but a
// three-storey walk-up on a site that carries thirty floors is worth more as
// a hole in the ground.
export function demolitionCost(rec: { bldgArea: number }, s: GameState): number {
  return Math.round(Math.max(60_000, rec.bldgArea * 14 * s.econ.costIdx));
}

export function demolish(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; err?: string } {
  const h = s.holdings[bbl];
  const rec = resolveRec(parcels, s, bbl);
  if (!h || !rec) return { s, err: "You don't own that." };
  if (h.groundLeased || s.groundLeases?.[bbl]) {
    return { s, err: "The ground lessee controls the improvement. You cannot demolish their building." };
  }
  if (rec.class === "land" || !rec.bldgArea) return { s, err: "There's nothing standing on it." };
  if (s.landmarks?.[bbl] !== undefined) return { s, err: "It is landmarked. Nobody knocks that down, including you." };
  if (s.developments[bbl]) return { s, err: "Construction is already underway." };
  if (h.sale) return { s, err: "It's on the market — pull the listing first." };
  if (h.loan || (h.mezz?.balance ?? 0) > 0) {
    return { s, err: "Pay off the mortgage first — nobody demolishes under a lien." };
  }
  // OCCUPIED SPACE IS OCCUPIED SPACE — including the flats, which this used to
  // ignore entirely, so a full apartment block with no commercial roll could be
  // knocked down with people living in it.
  const leased = h.tenants.reduce((sum, t) => sum + t.sf, 0)
    + useSf(rec, "multifamily") * (h.occ ?? 0);
  if (leased / Math.max(1, rec.bldgArea) > 0.2) {
    return {
      s,
      err: "You can't demolish over occupied space. Stop letting it and wait the roll out, or buy the leases out — both are on the leasing desk.",
    };
  }
  const cost = demolitionCost(rec, s);
  if (s.cash < cost) return { s, err: `Demolition runs $${(cost / 1e6).toFixed(2)}M — you're short.` };
  const next = clone(s);
  next.cash -= cost;
  logBooks(next, "capex", cost);
  next.built[bbl] = { class: "land" as unknown as BuiltClass, bldgArea: 0, floors: 0, yearBuilt: 0 };
  const nh = next.holdings[bbl];
  nh.tenants = [];
  delete nh.occ;
  delete nh.makeReady;
  delete nh.deliveredM;
  nh.condition = "standard";
  nh.lastCapM = s.month;
  next.lois = next.lois.filter((l) => l.bbl !== bbl);
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `${rec.address} came down — $${(cost / 1e6).toFixed(2)}M to clear it. The site is dirt again.`,
  });
  return { s: next };
}

/**
 * ONE MONTH OF CONSTRUCTION.
 *
 * A job is not a timer with a cheque at the end. Money goes out on an S-curve
 * — slow while the hole is dug, fast through the structure, slow through
 * fit-out — and the bank funds its share against work actually in place, after
 * your equity is in. Interest runs on what has been drawn and is paid from a
 * reserve inside the loan until the reserve is gone, and then it is your
 * problem. Costs move under you unless you bought a guaranteed price. And
 * things go wrong on their own schedule, not at a convenient midpoint.
 */
/**
 * REPLACING A FACILITY THAT DIED WITH ITS BANK.
 *
 * The only way off a repudiated construction loan is another desk, and what
 * that desk is buying is not a business plan — it is a half-finished building
 * with a receiver's lien on it. So it underwrites the whole job at its own
 * advance rate against total cost, uses the first draw to retire the
 * receiver's balance so it holds a clean first lien, and what is left over is
 * the money to finish. If its advance rate on the whole cost does not clear
 * the balance already outstanding, there is no deal at any price — which is
 * why a job that overran BEFORE its bank failed is usually the one that never
 * comes back.
 *
 * Nothing here rolls a die on whether a rescue "happens". The desks are the
 * same three desks, their appetite is the same appetite off the same capital,
 * and a market that has just seized a bank is a market where two of the three
 * have stopped quoting. The only thing drawn is how long the paperwork takes,
 * and that is drawn once, at repudiation.
 */
function tickRepudiation(s: GameState, d: Development, rec: { address: string }, progress: number) {
  const monthsLeft = Math.max(2, d.deliverM - s.month);
  const open = constructionQuotes(s, d.mix ?? devMix(d.use), d.costTotal)
    .filter((q) => q.open && q.lender !== (d.lender ?? CONSTRUCTION_LENDER))
    .sort((a, b) => a.ratePct - b.ratePct);

  // WHAT IT STILL COSTS TO GET A BUILDING OUT OF THIS. The S-curve has spent
  // `progress` of the construction budget; the lease-up reserve has not been
  // touched and is still ahead of the job.
  const toComplete = Math.max(0, d.costTotal - (d.leaseUpReserve ?? 0)) * (1 - progress) + (d.leaseUpReserve ?? 0);
  const equityLeft = Math.max(0, d.equityBudget - d.equitySpent) + (d.equityPrefunded ?? 0);

  let deal: { q: ConstructionQuote; gross: number; reserve: number } | undefined;
  let short = false;
  for (const q of open) {
    const gross = q.ltcMax * d.costTotal;
    const reserve = reserveFor(gross, q.ratePct, monthsLeft);
    // It has to take the receiver out AND carry itself to delivery before a
    // single dollar of it buys any steel.
    if (gross <= d.loanBalance + reserve) continue;
    // AND SOURCES HAVE TO MEET USES. This is the first test on any
    // construction loan and it was missing here: the hometown bank stops at a
    // $9M hold, and without this it would happily "rescue" a $330M job with
    // $4M of new money — a facility that pays points, retires the receiver,
    // and still leaves the building unfinished. Neither side signs that. The
    // borrower's own cash counts, because a developer with money in the bank
    // genuinely can finish a job that the bank alone cannot.
    const newMoney = gross - reserve - d.loanBalance;
    if (newMoney + equityLeft + Math.max(0, s.cash) < toComplete) { short = true; continue; }
    deal = { q, gross, reserve };
    break;
  }

  if (!deal) {
    // Report it, but not every month — the borrower already knows.
    if ((s.month - (d.repudiatedM ?? s.month)) % 6 === 0 && s.holdings[d.bbl]) {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: short
          ? `The desks will look at ${rec.address} and none of them will write enough. The job is `
            + `${(progress * 100).toFixed(0)}% built, $${(d.loanBalance / 1e6).toFixed(1)}M is owed to a receiver and `
            + `$${(toComplete / 1e6).toFixed(1)}M of cost is still ahead of it — a facility that does not cover both `
            + `buys nobody a building. Find the difference or find a partner.`
          : `Nobody will refinance ${rec.address}. The job is ${(progress * 100).toFixed(0)}% built with `
            + `$${(d.loanBalance / 1e6).toFixed(1)}M outstanding to a receiver, and no desk in town is quoting `
            + `against that at any price. Until one is, every dollar of work in place is yours.`,
      });
    }
    return;
  }

  const { q, gross, reserve } = deal;
  const payoff = d.loanBalance;
  const points = Math.round(gross * q.points);
  // Points are cash at close, exactly as they were the first time.
  s.cash -= points;
  logBooks(s, "dev", points);
  // The takeout itself never touches the borrower's account: the new desk pays
  // the receiver directly and books the same number as its own first draw.
  d.commitment = Math.round(gross);
  d.interestReserve = Math.round(reserve);
  d.reserveUsed = 0;
  d.drawn = Math.round(payoff);
  d.loanBalance = Math.round(payoff);
  d.ratePct = q.ratePct;
  d.lender = q.lender;
  delete d.repudiatedM;
  delete d.replaceM;
  bumpLenderRel(s, q.lender, 3);   // you are their borrower now, and they took a job nobody wanted

  const toBuild = Math.round(gross - reserve - payoff);
  if (s.holdings[d.bbl]) {
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `${q.lender} has refinanced ${rec.address} at ${q.ratePct.toFixed(2)}% — $${(gross / 1e6).toFixed(1)}M, of which `
        + `$${(payoff / 1e6).toFixed(1)}M goes straight to the receiver and $${(toBuild / 1e6).toFixed(1)}M is left to finish with. `
        + `$${(points / 1e3).toFixed(0)}k of points, and a coupon you would not have signed a year ago. The crane turns again.`,
    });
  }
}

export function tickDevelopments(s: GameState, parcels: ParcelTable) {
  for (const d of Object.values(s.developments)) {
    const rec = parcels[d.bbl];
    if (!rec || !s.holdings[d.bbl]) {
      // The job dies with the deed — pull its square feet back out of the
      // pipeline too, or the market absorbs a building nobody is building.
      cancelSupplyProject(s, d.bbl);
      // A conversion retires the old shell from economic stock at start. If
      // the project dies before delivery, that standing shell still exists and
      // must return to the market rather than vanish with the cancelled queue.
      if (d.mode === "reuse" && d.reuseFrom && d.reuseOldSf) {
        for (const [use, share] of Object.entries(d.reuseFrom)) {
          if ((share ?? 0) > 0) addStock(s.econ, use as BuiltClass, d.reuseOldSf * (share ?? 0));
        }
      }
      delete s.developments[d.bbl];
      continue;
    }
    // SELF-HEAL, once, for jobs in flight from saves written before player
    // starts entered the pipeline: register the square feet now, tagged. New
    // jobs are marked at the desk (startDevelopment) or already covered by
    // their original sponsor's cohort (takeoverDevelopment). If the schedule
    // is already due, the cohort matures on the next econ tick — deliver() no
    // longer adds stock itself, so it still lands exactly once.
    if (!d.piped) {
      d.piped = true;
      queueSupplyProject(s, {
        bbl: d.bbl,
        source: d.mode === "reuse" ? "reuse" : "player",
        startM: d.startM,
        deliverM: d.deliverM,
        sfByUse: programmeSf(d.sf, d.mix ?? devMix(d.use)),
      });
    }
    const span = Math.max(1, d.deliverM - d.startM);
    const t0 = Math.max(0, Math.min(1, (s.month - 1 - d.startM) / span));
    const t1 = Math.max(0, Math.min(1, (s.month - d.startM) / span));
    // the classic S-curve of spend against time
    const curve = (t: number) => t * t * (3 - 2 * t);
    const spendShare = Math.max(0, curve(t1) - curve(t0));
    // The lease-up reserve is in the budget and financed with everything else,
    // but it is NOT construction spend — it does not buy steel, it buys
    // tenants, and it is released at delivery. Pouring it into the S-curve is
    // why a developer arrived at handover with an empty building and no money
    // to fit anybody out: the reserve existed on the pro forma and had already
    // been spent on the building it was supposed to fill.
    const buildSpend = Math.max(0, d.costTotal - (d.leaseUpReserve ?? 0));
    const spendNow = Math.round(buildSpend * spendShare);

    // FINDING A DESK THAT WILL TAKE THE JOB OUT. See repudiateCommitments in
    // lenders.ts for how the job got here.
    if (d.repudiatedM !== undefined && s.month >= (d.replaceM ?? 0)) {
      tickRepudiation(s, d, rec, curve(t1));
    }

    if (spendNow > 0) {
      // THE CHEQUE YOU ALREADY WROTE PAYS FIRST, and it costs nothing further.
      // Without this the S-curve spent the full build cost ON TOP of the
      // day-one equity, and the gap surfaced as a silent capital call at 90%
      // complete — the single worst bug in the game, because it emptied your
      // account in the three months before a building you were about to have
      // to fit out.
      const fromPre = Math.min(d.equityPrefunded ?? 0, spendNow);
      d.equityPrefunded = (d.equityPrefunded ?? 0) - fromPre;
      const rest = spendNow - fromPre;
      // equity next, to the extent any is left; the bank funds the remainder
      const equityLeft = Math.max(0, d.equityBudget - d.equitySpent);
      const fromEquity = Math.min(equityLeft, rest);
      // the loan's construction bucket is the commitment LESS the reserve it
      // is holding back for its own interest; interest draws are tracked in
      // reserveUsed, so construction-to-date is drawn minus that.
      // A REPUDIATED FACILITY HAS NO ROOM IN IT. The commitment is still on
      // the books of a receiver who will not fund it, so every dollar of work
      // in place falls through to the borrower as a capital call — which is
      // exactly what a developer whose bank failed woke up to.
      const hardRoom = d.repudiatedM !== undefined
        ? 0
        : Math.max(0, (d.commitment - d.interestReserve) - (d.drawn - d.reserveUsed));
      const fromLoan = Math.min(hardRoom, rest - fromEquity);
      const unfunded = rest - fromEquity - fromLoan;
      d.equitySpent += fromEquity;
      d.drawn += fromLoan;
      d.loanBalance += fromLoan;
      // anything neither side will fund is a capital call, today. On a job that
      // runs to plan this is now zero; it fires for overruns, which is what a
      // capital call is actually for.
      s.cash -= fromEquity + unfunded;
      logBooks(s, "dev", fromEquity + unfunded);
      if (unfunded > 0) {
        d.equitySpent += unfunded;
        d.lastCapitalCall = unfunded;
        d.lastCapitalCallM = s.month;
        s.news.unshift({
          q: s.month,
          kind: "warn",
          text: `${rec.address} called ${unfunded >= 1_000_000
            ? `$${(unfunded / 1_000_000).toFixed(2)}M`
            : `$${Math.round(unfunded / 1000)}K`} of additional equity this month. `
            + `The construction budget has outrun its remaining equity and loan commitment; cash funded the gap.`,
        });
      }
    }

    // INTEREST, AND WHO PAYS IT BEFORE THE BUILDING OPENS. Nobody. It accrues
    // on the drawn balance, capitalises into the loan, and is advanced by the
    // lender out of the reserve it sized for exactly this. Not one dollar of
    // the player's cash leaves for construction carry, which is how these are
    // structured: the whole balance, interest included, is taken out by the
    // perm lender at delivery.
    //
    // If the schedule slips far enough to exhaust the reserve, the lender
    // re-sizes it rather than calling the borrower — it wants the building
    // finished at least as much as you do — and it charges for the privilege
    // by adding it to the balance you have to refinance.
    if (d.loanBalance > 0 && d.repudiatedM !== undefined) {
      // A RECEIVER TAKES INTEREST AND ADVANCES NOTHING. The reserve that was
      // paying this carry lived inside the commitment, and the commitment is
      // dead — so the loan stops paying its own interest and the borrower
      // starts. It does not capitalise, because nobody is lending it: it is a
      // cheque, every month, on a building that is not earning anything yet.
      // On a $40M job at 9% that is $300k a month against no income, which is
      // the number that actually ended developers.
      const interest = Math.round((d.loanBalance * d.ratePct) / 100 / 12);
      s.cash -= interest;
      logBooks(s, "debtSvc", interest);
    } else if (d.loanBalance > 0) {
      const interest = Math.round((d.loanBalance * d.ratePct) / 100 / 12);
      if (d.reserveUsed + interest > d.interestReserve) {
        const extra = Math.round(reserveFor(d.commitment, d.ratePct, Math.max(3, d.deliverM - s.month)) * 0.5) + interest;
        d.interestReserve += extra;
        d.commitment += extra;
        s.news.unshift({
          q: s.month, kind: "info",
          text: `The schedule at ${rec.address} has run past its interest reserve. The lender topped it up — it goes on the balance the takeout has to cover, not on your cheque book.`,
        });
      }
      d.reserveUsed += interest;
      d.loanBalance += interest;   // capitalised, repaid by the mini-perm
      d.drawn += interest;         // and it is a draw against the commitment
    }

    // COST ESCALATION. Under cost-plus the unspent balance of the job moves
    // with the market; under a guaranteed maximum price it does not, and that
    // is what the four-point premium bought.
    if (d.contract === "costplus" && s.month > d.startM) {
      const remaining = Math.max(0, d.hardCost * (1 - curve(t1)));
      const drift = s.econ.phase === "expansion" || s.econ.phase === "peak" ? rrange(s, 0.0012, 0.0038, "dev") : rrange(s, -0.001, 0.0016, "dev");
      const escal = Math.round(remaining * drift);
      if (escal > 0) { d.costTotal += escal; d.hardCost += escal; d.equityBudget += escal; }
    }

    // SITE RISK, month by month. Each is rare; a two-year job runs the gauntlet
    // twenty-odd times, which is why schedules slip and budgets grow.
    const progress = curve(t1);
    if (progress > 0.04 && progress < 0.97) {
      const roll = rng(s, "dev");
      const gmpShield = d.contract === "gmp" ? 0.35 : 1;   // the GC eats most of it
      // AND WHETHER ANYBODY IS WATCHING THE JOB. `cmRiskMult` is the owner's
      // representative: it scales the hazard of all three site events and the
      // size of the two that cost money, and nothing else — see its comment for
      // what a construction manager is and is not worth. Scaling the thresholds
      // rather than the draw is deliberate: `rng` is called the same number of
      // times whoever is on the payroll, so hiring somebody cannot re-roll the
      // rest of the century. That fault is documented at the top of staff.ts
      // and it cost an acceptance test once already.
      // Per-job cover: an assigned CM carries this site; otherwise the float desk.
      const cm = cmRiskMult(coverRoleState(s, parcels, d.bbl, "construction").rs);
      const cmNote = cm > 1.08 ? " The construction desk was underwater and the job went unsupervised." : "";
      if (roll < 0.028 * gmpShield * cm) {
        // change order
        const bump = rrange(s, 0.015, 0.07, "dev") * cm;
        const extra = Math.round(d.costTotal * bump);
        const fromContingency = Math.min(Math.max(0, d.contingency - d.contingencyUsed), extra);
        d.contingencyUsed += fromContingency;
        const overrun = extra - fromContingency;
        d.costTotal += overrun;
        d.hardCost += overrun;
        d.equityBudget += overrun;
        d.events++;
        s.news.unshift({
          q: s.month, kind: overrun > 0 ? "warn" : "info",
          text: overrun > 0
            ? `Change orders at ${rec.address}: $${(extra / 1e6).toFixed(2)}M, of which $${(overrun / 1e6).toFixed(2)}M is past the contingency and lands on you.${cmNote}`
            : `Change orders at ${rec.address}: $${(extra / 1e6).toFixed(2)}M, absorbed by the contingency.${cmNote}`,
        });
      } else if (roll < 0.055 * cm) {
        d.deliverM += 1 + Math.round(rng(s, "dev"));
        syncDevCohorts(s, d);
        d.events++;
        s.news.unshift({ q: s.month, kind: "warn", text: `Weather and inspections at ${rec.address} — delivery moves to ${monthLabel(d.deliverM)}.${cmNote}` });
      } else if (roll < 0.062 * cm) {
        // a sub goes under: time AND money, and the GMP does not help much.
        // Pre-qualification is most of what stops this one, which is why the
        // manager's multiplier reaches it where the GMP barely does.
        const extra = Math.round(d.costTotal * rrange(s, 0.03, 0.09, "dev") * cm);
        const fromContingency = Math.min(Math.max(0, d.contingency - d.contingencyUsed), extra);
        d.contingencyUsed += fromContingency;
        const overrun = extra - fromContingency;
        d.costTotal += overrun; d.hardCost += overrun; d.equityBudget += overrun;
        d.deliverM += 2 + Math.round(rng(s, "dev") * 3);
        syncDevCohorts(s, d);
        d.events++;
        s.news.unshift({
          q: s.month, kind: "warn",
          text: `A subcontractor at ${rec.address} defaulted. Re-tendering costs $${(extra / 1e6).toFixed(2)}M and pushes delivery to ${monthLabel(d.deliverM)}.${cmNote}`,
        });
      }
    }

    if (s.month >= d.deliverM) deliver(s, parcels, d, rec);
  }
}

/**
 * LEASING A BUILDING THAT DOES NOT EXIST YET.
 *
 * This is the mechanic that replaces pre-letting, and it is the one that
 * actually happens. Nobody signs against a drawing, but once the structure is
 * up and a tenant can walk a floor, space in a building with a delivery date
 * lets perfectly well — at a discount, because the tenant is carrying the risk
 * that you are late, and that discount narrows as the date gets close.
 *
 * It makes the whole development arc a live decision instead of a wait. A job
 * started into a strong market and delivered into a weak one lets nothing on
 * the way up and opens empty against a mini-perm clock; one whose market holds
 * opens half-full and covers itself from month one.
 */
/**
 * HOW MUCH OF A BUILDING IS SPOKEN FOR ON THE DAY IT OPENS, by class.
 *
 * These are the two facts about pre-letting that the old model got by
 * accident and mostly got wrong. It ran one probability for every class, so
 * how full a building opened was decided by HOW LONG IT TOOK TO BUILD: a
 * 31-month office tower got twenty-odd chances to sign somebody and opened a
 * median 66% let, while a 12-month shed got eight and opened empty every
 * single time. Duration is a real influence — a longer build genuinely has
 * more time to lease — but it is not the reason retail pre-lets and sheds do
 * not, and it produced an office market where spec towers open two-thirds
 * full. Real spec office opens 0-30% pre-let.
 *
 * `rate` scales the monthly odds a prospect signs. `ceiling` is the share of
 * the building that can be spoken for at delivery, and it is a fact about how
 * each product is actually let:
 *
 *   retail      Anchors sign before ground breaks — that is what an anchor IS,
 *               and it is how the centre gets financed. An anchored scheme is
 *               well over half pre-let on opening day.
 *   office      A tenant with a lease expiring in two years will take space in
 *               a building they can walk. Most will not sign against a hole in
 *               the ground, so the honest spec number is a third at the very
 *               best and usually much less.
 *   industrial  Bimodal in life: a shed is either build-to-suit and 100% let
 *               before a spade goes in, or it is pure spec and opens empty.
 *               Build-to-suit is a different product and is not modelled yet,
 *               so what is left here is the spec leg — thin.
 *   multifamily Flats do not pre-let in the commercial sense. They lease from
 *               a trailer thirty days out, which arrives as h.occ at delivery
 *               rather than as signed leases. Nearly nothing here.
 */
const PRELET: Record<BuiltClass, { rate: number; ceiling: number }> = {
  retail: { rate: 1.15, ceiling: 0.62 },
  office: { rate: 0.55, ceiling: 0.32 },
  industrial: { rate: 0.45, ceiling: 0.22 },
  multifamily: { rate: 0.10, ceiling: 0.08 },
};

export function tickConstructionLeasing(s: GameState, parcels: ParcelTable) {
  for (const d of Object.values(s.developments)) {
    if (d.bts) continue; // named anchor already committed the building
    const rec = parcels[d.bbl];
    if (!rec) continue;
    const span = Math.max(1, d.deliverM - d.startM);
    const t = (s.month - d.startM) / span;
    // you cannot show space that is not enclosed
    if (t < 0.35) continue;
    if (!d.signed) d.signed = [];
    const takenSf = d.signed.reduce((a, x) => a + x.sf, 0);
    const leasable = Math.round(d.sf * specShare(d.mix ?? devMix(d.use)));

    const lead = dominantOf(d.mix ?? devMix(d.use));
    const pre = PRELET[lead] ?? PRELET.office;
    // THE CEILING BINDS BEFORE THE DICE DO. Past it, the space that is left is
    // the space that gets let after the building opens — which is the lease-up
    // risk the developer is being paid to carry, and the thing this model
    // exists to make real.
    const openSf = Math.round(leasable * pre.ceiling) - takenSf;
    // Same floor delivery uses when it converts `signed` into a rent-roll row.
    // This used to accept 1,500 sf deals that genAnchorTenant then silently
    // dropped at C of O (commercial minimum 2,000) — news said the building
    // was spoken for, the roll opened empty.
    const floor = COMMERCIAL_SUITE_MIN;
    if (openSf < floor) continue;

    // a tight market lets a building before it opens; a glut does not
    const appetite = classAppetite(s, lead);
    const months = Math.max(1, d.deliverM - s.month);
    // interest builds as the date approaches — the risk a tenant is taking
    // shrinks, and so does what they will hold out for
    const near = clamp(1.35 - months / 18, 0.35, 1.35);
    const p = clamp(0.055 * pre.rate * appetite * near * (0.55 + demandLinear(rec.demandScore) / 130), 0, 0.42);
    if (rng(s, "dev") >= p) continue;

    const want = Math.round(openSf * rrange(s, 0.16, 0.5, "dev"));
    if (want < floor) continue;
    // The delivery-risk discount: steep when the building is a frame and a
    // promise, nearly gone by the time the scaffolding comes down.
    const discount = clamp(1 - (0.16 * (months / Math.max(1, span))), 0.86, 0.99);
    d.signed.push({ sf: want, use: lead, discount, name: "" });
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `Let before it opens: ${(want / 1000).toFixed(0)}k sf at ${rec.address}, ${((1 - discount) * 100).toFixed(0)}% under market for taking delivery risk. `
        + `${(((takenSf + want) / Math.max(1, leasable)) * 100).toFixed(0)}% of the building is spoken for.`,
    });
  }
}

/**
 * A SLIPPED JOB SLIPS ITS COHORT TOO. The month ground broke, the job's square
 * feet entered econ.cohorts tagged with this parcel; when weather or a dead
 * subcontractor moves deliverM, the pipeline's date moves with it.
 */
function syncDevCohorts(s: GameState, d: Development) {
  rescheduleSupplyProject(s, d.bbl, d.deliverM);
}

function deliver(s: GameState, parcels: ParcelTable, d: Development, rec: { address: string }) {
  // Buildings you have put up. The city notices a developer.
  s.delivered = (s.delivered ?? 0) + 1;
  const dmix = d.mix ?? devMix(d.use);
  s.built[d.bbl] = { class: dominantOf(dmix), mix: dmix, bldgArea: d.sf, floors: d.floors, yearBuilt: START_YEAR + Math.floor(s.month / 12), suites: d.suites, cov: d.coverage };
  const dBlock = demandModel(parcels).ofBbl.get(d.bbl);
  if (dBlock) nudgeBlockDemand(s, dBlock, Math.min(4, 1 + d.sf / 150_000));
  recordPropertyEvent(s, d.bbl, {
    kind: "delivered",
    use: dominantOf(dmix),
    sf: d.sf,
    floors: d.floors,
    party: firmShort(s),
  });
  // YOUR BUILDING IS SUPPLY TOO. A tower you deliver competes with everybody
  // else's space, including your own — and if you build enough of one class
  // you will move its vacancy against yourself, which is the correct lesson.
  // NOTE: no addStock here — the same rule as city deliveries in
  // tickCityGrowth. The square feet went into econ.cohorts the month ground
  // broke (startDevelopment), or with the original sponsor's start for a
  // takeover, and the cohort matures into citywide stock on its own in
  // tickEcon. Adding it again on delivery double-counted the building:
  // measured at exactly 2x the job's sf landing in stock across the delivery
  // month.
  const h = s.holdings[d.bbl];
  h.condition = "good";
  // NEW BONES. Ground-up is the only way to own the top of the condition scale —
  // see condCeiling: no amount of capital gets an old building here. That is a
  // real part of what a developer is buying and it was not modelled at all.
  // WHAT YOU BUILT IT TO. The specification is stamped on the PARCEL, not the
  // holding, because it outlives your ownership: whoever buys this building in
  // 2040 is buying the floor-to-floor and the curtain wall you paid for, and
  // condCeiling reads it forever.
  const built = parcels[d.bbl] ?? rec;
  if (built) built.buildSpec = d.spec ?? 0.5;
  h.condIdx = Math.min(condCeiling(built ?? { yearBuilt: 2000 }, s.month), 0.90 + 0.09 * ((d.spec ?? 0.5)));
  h.service = s.opsPolicy?.service ?? 0;
  h.stance = s.opsPolicy?.stance ?? 0;
  h.plan = s.opsPolicy?.plan ?? 1;
  h.svcIdx = 0.70;   // a building that opens this year opens well run
  h.lastCapM = s.month;
  h.tenants = [];
  h.deliveredM = s.month;
  if (d.bts) {
    const deposit = depositFor(s, d.bts.rentPsf, d.bts.sf, d.bts.credit);
    s.cash += deposit;
    h.tenants.push({
      name: d.bts.name,
      use: d.bts.use,
      sector: d.bts.sector,
      credit: d.bts.credit,
      sf: d.bts.sf,
      rentPsf: d.bts.rentPsf,
      net: d.bts.recovery === "nnn",
      recovery: d.bts.recovery,
      startM: s.month,
      endM: s.month + d.bts.termM,
      deposit,
      staff: 1,
    });
    recordPropertyEvent(s, d.bbl, {
      kind: "major-lease",
      party: d.bts.name,
      sf: d.bts.sf,
      amount: Math.round(d.bts.rentPsf * d.bts.sf),
      outcome: `${Math.round(d.bts.termM / 12)}-year build-to-suit`,
    });
  }
  // FLATS LEASE FROM A TRAILER. A block of flats does not pre-let the way an
  // office does — there are no leases signed against a hole in the ground —
  // but a leasing office opens thirty to sixty days before the certificate of
  // occupancy and the first residents move in on day one. In a tight market
  // that is a fifth of the building; into a glut it is nearly nobody. This was
  // a flat 0.1 and then, one month later, the 0.4 floor in tickLeasing threw it
  // away entirely — see the note there.
  if ((dmix.multifamily ?? 0) > 0) {
    const slack = Math.max(0, (s.econ.cityVac.multifamily ?? 0.06) - NATURAL_VAC.multifamily);
    h.occ = Math.max(0.01, Math.min(0.22, 0.17 - 1.4 * slack + rrange(s, -0.04, 0.04, "dev")));
  }
  h.costBasis += d.costTotal;
  h.assessed = (h.assessed ?? h.costBasis - d.costTotal) + d.costTotal;

  // unspent contingency is a rebate, not a rounding error
  const saved = Math.max(0, d.contingency - d.contingencyUsed);
  if (saved > 0) {
    s.cash += saved;
    logBooks(s, "dev", -saved);
  }

  // THE LEASE-UP RESERVE IS RELEASED. This is the money that fills the
  // building — fit-out, commissions and the carry until it is full. It was
  // financed on day one along with everything else, and now that there is a
  // building to lease it comes across as cash. Without this a developer who
  // had spent correctly to plan still could not afford the TI on the first
  // tenant through the door.
  // AND IT IS FINANCED, NOT MINTED. The reserve was handed over as free cash,
  // which quietly conjured money into the game. It is part of the loan
  // commitment — the bank is advancing it now that there is a building to
  // lease — so it draws like any other advance and the balance goes up.
  // AND ONLY WHAT THE BANK ACTUALLY ADVANCES ARRIVES. This handed over the
  // full reserve while drawing only what was left in the commitment, so any
  // gap between the two was cash from nowhere. It never showed up, because
  // the conserve identity nets it against the dev bucket and balances either
  // way — and on a job that ran to plan the gap was always exactly zero. The
  // room was a rail holding the model up. A repudiated facility has no room in
  // it at all, and a developer whose bank failed is not handed the fit-out
  // money on the way out the door.
  const lease = d.leaseUpReserve ?? 0;
  if (lease > 0) {
    const room = Math.max(0, d.commitment - d.drawn);
    const advance = Math.min(lease, room);
    d.drawn += advance;
    d.loanBalance += advance;
    s.cash += advance;
    logBooks(s, "dev", -advance);
    s.news.unshift({
      q: s.month, kind: advance < lease ? "warn" : "info",
      text: advance < lease
        ? `The lease-up reserve at ${rec.address} was $${(lease / 1e6).toFixed(2)}M, and only $${(advance / 1e6).toFixed(2)}M of it `
          + `is still fundable. The fit-out and the leasing commissions on the rest come out of your own account.`
        : `The lease-up reserve at ${rec.address} — $${(lease / 1e6).toFixed(2)}M — is released. That is what fits out the first tenants.`,
    });
  }

  // TENANTS WHO SIGNED WHILE IT WAS GOING UP. They took delivery risk on a
  // hole in the ground and were paid for it in rent; now the building exists
  // and they move in. A job that let well during construction opens part-full
  // and covers its mini-perm; one that let nothing opens empty, which is the
  // developer's real risk and always was.
  //
  // Conversion used to call genAnchorTenant and ignore a void return — any
  // pre-let under the commercial floor, or against a leg that would not
  // demise, vanished without a word. Surface it, and try the floor size when
  // the vacancy can still take a real suite.
  let placed = 0, lostSf = 0;
  for (const sg of d.signed ?? []) {
    const built = resolveRec(parcels, s, d.bbl);
    if (!built) { lostSf += sg.sf; continue; }
    const use = sg.use as BuiltClass;
    if (genAnchorTenant(s, built, h, sg.sf, sg.discount, use)) { placed++; continue; }
    const floor = minTenancySf(built, use);
    const vac = useVacantSf(built, h, use, s.month);
    if (vac >= floor && genAnchorTenant(s, built, h, Math.min(vac, Math.max(floor, sg.sf)), sg.discount, use)) {
      placed++;
      continue;
    }
    lostSf += sg.sf;
  }
  if (lostSf > 0) {
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `${rec.address} opened with ${(lostSf / 1000).toFixed(1)}k sf of construction pre-lets that could not take possession — `
        + `the space will not demise under the floor. ${placed} pre-let${placed === 1 ? "" : "s"} did move in.`,
    });
  }

  // THE TAKEOUT. The construction loan does not evaporate — it rolls into a
  // mini-perm that is interest-only for a year and matures in three, and the
  // whole job now is to stabilise the building before that clock runs out.
  // A developer's real risk is not building it. It is owning it empty.
  h.loan = {
    product: "cordage",
    floating: true,
    principal: d.loanBalance,
    balance: d.loanBalance,
    ratePct: +(s.econ.indexRate + 2.1).toFixed(2),
    spread: 2.1,
    // A THREE-YEAR CLOCK WAS TOO SHORT. Filling a building at this market's
    // pace takes longer than that, so every job arrived at its balloon still
    // half empty and un-refinanceable. A construction takeout is a three-plus
    // -two or a five-year in practice, and interest-only while it fills.
    ioUntilM: s.month + 24,
    amortYears: 30,
    maturityM: s.month + 60,
    monthlyPmt: Math.round((d.loanBalance * (s.econ.indexRate + 2.1)) / 100 / 12),
    minDSCR: 1.05,
    maxLTV: 0.9,
    sweep: false,
    cleanQs: 0,
    originM: s.month,
    // A building that delivered empty cannot cover anything, and every lender
    // who writes construction paper knows it. The holiday runs three years —
    // long enough to fill it, short enough that failing to is fatal.
    holidayUntilM: s.month + 36,
    prepay: "open",
    prepayUntilM: s.month,
    // The mini-perm is the construction lender rolling its own facility — the
    // balance stays on the desk that carried the job, which is what its
    // statement on Research shows and whose capital a default would eat.
    holder: d.lender ?? CONSTRUCTION_LENDER,
  };
  bumpLenderRel(s, d.lender ?? CONSTRUCTION_LENDER, 2);   // a job delivered is the best line in the file
  delete s.developments[d.bbl];
  bumpLand(s, d.bbl, 1.06);

  const over = d.costTotal - (d.hardCost + Math.round(d.hardCost * SOFT_COST));
  void over;
  s.news.unshift({
    q: s.month, kind: "deal",
    text: `Delivered: ${(d.sf / 1000).toFixed(0)}k sf of ${d.use} at ${rec.address}, ${d.events === 0 ? "on programme" : `after ${d.events} problem${d.events > 1 ? "s" : ""}`}, $${(d.costTotal / 1e6).toFixed(1)}M all in`
      + (saved > 0 ? `, with $${(saved / 1e6).toFixed(2)}M of contingency returned` : "")
      + `. The mini-perm matures ${monthLabel(s.month + 60)} — stabilise it before then.`,
  });
}

// ---- building management ---------------------------------------------------
export interface CapProgram {
  id: string;
  label: string;
  costPsf: number;
  months: number;
  blurb: string;
}
export const PROGRAMS: CapProgram[] = [
  { id: "lobby", label: "Lobby refresh", costPsf: 14, months: 3, blurb: "+4% new-lease rents, more LOIs" },
  { id: "systems", label: "Systems & HVAC", costPsf: 22, months: 6, blurb: "−15% operating costs" },
  { id: "facade", label: "Facade program", costPsf: 30, months: 6, blurb: "+8% new-lease rents" },
];

/**
 * WHAT A PROGRAMME IS WORTH TO THE BRICKS.
 *
 * These were three permanent stat buffs that did nothing whatever to condition
 * and did not even reset the neglect clock, which meant there was no way to
 * improve a building you actually operate: the only route back up was a gut,
 * and startRenovation refuses one until the roll burns below 35% leased. On a
 * stabilised 98k sf office that is a $20.5M job you are not allowed to do.
 *
 * A facade or a plant replacement moves a grade on its own — and at $30 and $22
 * a foot against a $210/sf gut, that is the correct real-world arithmetic: a
 * repositioning is a fraction of a rebuild. A lobby is a first impression and
 * buys a third of a grade. This is now the whole answer to age, and it is a
 * decision taken once a decade per building, not once a month.
 */
export const PROGRAM_LIFT: Record<string, number> = { lobby: 0.08, systems: 0.17, facade: 0.21 };

/** How long each job holds before the same one is due again. */
export const PROGRAM_CYCLE_M: Record<string, number> = { lobby: 180, systems: 300, facade: 420 };

export function programCost(rec: { bldgArea: number }, s: GameState, p: CapProgram): number {
  return Math.round(rec.bldgArea * p.costPsf * s.econ.costIdx);
}

export function startProgram(s: GameState, parcels: ParcelTable, bbl: string, programId: string): { s: GameState; err?: string } {
  const h = s.holdings[bbl];
  const rec = resolveRec(parcels, s, bbl);
  const p = PROGRAMS.find((x) => x.id === programId);
  if (!h || !rec || !p) return { s, err: "No such program." };
  if (h.groundLeased || s.groundLeases?.[bbl]) {
    return { s, err: "The ground lessee controls the improvement — their capital plan, not yours." };
  }
  if (rec.class === "land" || !rec.bldgArea) return { s, err: "Nothing to improve on a vacant lot." };
  if (h.program) return { s, err: "A capital program is already running." };
  // A PROGRAMME COMES ROUND AGAIN. These were once-per-building-forever, which
  // over a century is three capital decisions and then nothing — no answer to
  // age, and a building whose menu was spent had only a gut left, which a full
  // rent roll forbids. Real capital is a cycle, and this is its period.
  const last = h.programsDone?.[programId];
  if (last !== undefined && s.month - last < (PROGRAM_CYCLE_M[programId] ?? 240)) {
    return { s, err: `${p.label} was done here in ${monthLabel(last)}. It does not need doing again yet.` };
  }
  const cost = programCost(rec, s, p);
  if (s.cash < cost) return { s, err: `${p.label} costs $${(cost / 1e6).toFixed(2)}M — you're short.` };
  const next = clone(s);
  next.cash -= cost;
  logBooks(next, "capex", cost);
  const nh = next.holdings[bbl];
  nh.program = { id: programId, untilM: next.month + p.months };
  next.news.unshift({ q: next.month, kind: "info", text: `${p.label} underway at ${rec.address} ($${(cost / 1e6).toFixed(2)}M).` });
  return { s: next };
}

export function tickPrograms(s: GameState, parcels: ParcelTable) {
  for (const h of Object.values(s.holdings)) {
    if (h.program && s.month >= h.program.untilM) {
      h.programsDone = { ...(h.programsDone ?? {}), [h.program.id]: s.month };
      const rec = resolveRec(parcels, s, h.bbl);
      const p = PROGRAMS.find((x) => x.id === h.program!.id);
      // THE MONEY BUYS THE BRICKS BACK. New plant, a new skin or a new front
      // door is the difference between a building the market still rings about
      // and one it has stopped calling — capped by what the bones will carry,
      // because you cannot make a 1928 walk-up read as new construction.
      if (rec) {
        h.condIdx = Math.min(condCeiling(rec, s.month), (h.condIdx ?? 0.7) + (PROGRAM_LIFT[h.program!.id] ?? 0));
        h.condition = condGrade(h.condIdx);
        h.lastCapM = s.month;
      }
      if (rec && p) s.news.unshift({ q: s.month, kind: "info", text: `${p.label} complete at ${rec.address} — the building reads as ${h.condition} now.` });
      delete h.program;
    }
  }
}

export function setStance(s: GameState, bbl: string, stance: -1 | 0 | 1): GameState {
  const next = clone(s);
  const h = next.holdings[bbl];
  // Lessee sets the ask on their building — stamping yours on a leased fee is a no-op.
  if (!h || h.groundLeased) return next;
  h.stance = stance;
  return next;
}

/**
 * HOW THIS BUILDING IS RUN. Free to change and slow to matter, which is the
 * honest shape: you can switch the service level this afternoon and the
 * tenants will not have noticed for three years.
 */
export function setOps(
  s: GameState, bbl: string, ops: { service?: -1 | 0 | 1; plan?: 0 | 1 | 2 },
): GameState {
  const next = clone(s);
  const h = next.holdings[bbl];
  if (!h || h.groundLeased) return next;
  if (ops.service !== undefined) h.service = ops.service;
  if (ops.plan !== undefined) h.plan = ops.plan;
  return next;
}

/**
 * THE HOUSE POLICY, and it applies to the book you already own.
 *
 * This is the one control that keeps the whole system out of chore territory.
 * Set it once and every deed you close after it arrives configured; set it
 * again and the existing book follows, because a firm that decides to start
 * running its buildings properly does not do it one address at a time.
 */
export function setOpsPolicy(
  s: GameState, ops: { service: -1 | 0 | 1; plan: 0 | 1 | 2; stance?: -1 | 0 | 1 }, applyToBook = true,
): GameState {
  const next = clone(s);
  next.opsPolicy = ops;
  if (applyToBook) {
    const st = ops.stance ?? 0;
    for (const h of Object.values(next.holdings)) {
      // Lessee runs the bricks — stamping your capital plan onto a leased fee
      // used to charge YOUR cash for THEIR building once resolveRec showed SF.
      if (h.groundLeased) continue;
      h.service = ops.service; h.plan = ops.plan; h.stance = st;
    }
    // THE ASK IS PART OF HOW YOU RUN A BUILDING, and it was the one standing
    // decision this policy did not carry — so a principal could set service and
    // the capital plan for the whole book in one move and still had to open
    // twenty buildings to say "push rents". It is the same kind of decision as
    // the other two: taken once, lived with for years, overridden per asset
    // where one building needs different treatment.
    next.news.unshift({
      q: next.month, kind: "info",
      text: `House policy: ${st > 0 ? "push rents" : st < 0 ? "fill space" : "ask the market"}, `
        + `buildings run ${serviceSpec(ops.service).label.toLowerCase()}, capital plan ${planSpec(ops.plan).label.toLowerCase()}. `
        + `It applies to everything on the book from this month.`,
    });
  }
  return next;
}

// ---- the city builds itself ------------------------------------------------
// Over a lifetime the market fills in the vacant lots around you — fastest in
// booms, near-stalled in recessions, always working outward from the demand
// peaks. Every delivery lifts land values on its block, so watching where the
// cranes go is a market signal.
//
// TWO THINGS WERE WRONG WITH THIS.
//
// It ran at 0.88 deliveries a MONTH in an expansion — better than ten new
// buildings a year in a town of sixteen hundred lots, which is a construction
// boom in perpetuity and nothing like a real small city, where two or three a
// year is a busy market and a bad year has none.
//
// And a building appeared the instant it was decided, its square feet landing
// on the market complete. Nothing works that way. The decision to build is
// taken in one market and the building arrives in a different one, two or
// three years later, and that lag is the entire reason property cycles
// overshoot: everybody starts at the top and everybody delivers into the
// bottom. Now a city start is a hole in the ground with a delivery date, its
// space enters the pipeline the day it starts, and it competes with you only
// when it opens.
// How often anybody breaks ground now falls out of the economic order book and
// the physical crew pool. There is no phase-specific start rate here: adding
// one would be a second answer layered over the common pro forma.

/**
 * THE BLOCK'S CORNICE DATUM, ENGINE SIDE.
 *
 * The citygen has a cornice-datum machine that makes the GENERATED town read
 * as a town; the engine had nothing, so infill was sized off the ZONING
 * envelope. Under the default "village" preset the standing city is p50 3
 * floors, p99 8, max 14 — while vacant-lot farMax is p50 15.6, p90 30.5.
 * Measured over 20 years x 2 seeds: 51 city/rival groundbreaks per run at
 * MEDIAN 15-17 floors, max 32, with 26-35 of them more than twice the tallest
 * standing neighbour. A village sprouted a forest of towers in a decade.
 *
 * No speculative builder does that. Infill is priced off the block's comps,
 * and the comp set is what is standing: a developer builds one increment above
 * the cornice line, because the increment is what the lenders and the tenants
 * have already underwritten. Tall arrives the way it arrives in life — block
 * by block, each cycle ratcheting the datum a few floors, over decades.
 *
 * The PLAYER is deliberately not capped: zoning is their envelope and
 * overbuilding their own market is their risk to take.
 */
export function blockDatumFloors(s: GameState, parcels: ParcelTable, block: string): number {
  let datum = 0;
  for (const bbl in parcels) {
    const p = parcels[bbl];
    if (!p || p.block !== block) continue;
    const r = resolveRec(parcels, s, bbl);
    if (r && r.class !== "land" && r.floors > datum) datum = r.floors;
  }
  return datum;
}

/** How high the market will speculatively build on this lot TODAY. */
export function cityInfillCap(
  s: GameState, parcels: ParcelTable,
  rec: { block: string; lotArea: number; farMaxComm?: number; farMaxRes?: number },
  maturity: number,
  use: BuiltClass = "office",
): number {
  const datum = blockDatumFloors(s, parcels, rec.block);
  // one increment above the datum; the increment itself grows as the town
  // matures and its comps deepen — 2 floors in year one, 6 by year 65
  //
  // ...AND CONTEXT YIELDS TO ECONOMICS. This was the whole story, and it meant
  // the city answered a shortage with MORE buildings and never with TALLER
  // ones: a district at 3.7% vacancy with rents tripling got exactly as much
  // height over its cornice line as one sitting half empty. That is the reason
  // supply could not answer price anywhere in this model — the crane count
  // responds to demand through startOwed, the envelope on each crane did not,
  // so the median city building stayed at 26,000 sf however desperate the
  // market got. `sim:accept` F and H are both downstream of it.
  //
  // A cornice datum is real — most of any city is uniform height because
  // building in context is cheaper, easier to finance and easier to permit.
  // But it is a behavioural cap sitting well below the LEGAL one (farMaxFor
  // times the district's zoneAdj, which the return below still enforces), and
  // what breaks it is scarcity. When land is dear enough somebody builds the
  // tower that ignores the street, and then the street has a new datum. That
  // is how every skyline that exists got made.
  //
  // Neutral by construction: at natural vacancy with rent at parity to income
  // the push is zero and nothing about the old calibration moves.
  const ez = s.econ;
  // THE PROJECT'S MARKET, not office by default. Apartment supply was reading
  // office vacancy and office rent here, so a housing shortage raised the
  // number of apartment orders but never the size of an apartment building.
  // The result was multifamily vacancy sitting on its frictional floor for
  // more than a third of measured months while perfectly usable FAR went
  // untouched.
  const natural = NATURAL_VAC[use];
  const tight = clamp(
    (natural - (ez.cityVac?.[use] ?? natural)) / natural, -1, 1);
  const rentPress = clamp(
    (ez.rentIdx[use] / RENT_BASE[use]) / Math.max(0.35, ez.wageIdx ?? 1) - 1, -0.5, 1.5);
  // When vacancy is pinned, vacancy-tightness alone saturates — structural
  // capacity shortage (desired demand vs housable) still says "build taller."
  const struct = clamp(ez.structTight?.[use] ?? 0, 0, 0.45);
  const push = clamp(tight * 0.9 + rentPress * 0.5 + struct * 1.1, -0.35, 2.0);
  const step = Math.max(1, Math.round((2 + maturity * 4) * (1 + push)));
  const physical = physicalMaxFloors(rec.lotArea * 0.62);
  let cap = Math.max(2, Math.min(Math.max(1, datum) + step, physical));
  // CHRONIC EMPLOYMENT SHORTAGE BREAKS THE CORNICE. ECONOMY.md §F #2: stock
  // grew at half the jobs rate because each crane stayed cornice-bound while
  // `structTight` said the market needed more housable floor. Scarcity that
  // has already saturated the vacancy rail is exactly when real cities put up
  // the building that ignores the street — the legal envelope, not another
  // two floors of context. Blend toward zoning/physical; do not free the
  // friction floor or mint demand.
  if (struct > 0.08 && tight > 0.45
      && rec.farMaxComm !== undefined && rec.farMaxRes !== undefined) {
    const legal = Math.ceil(farMaxFor({
      farMaxComm: rec.farMaxComm, farMaxRes: rec.farMaxRes,
    }) / 0.62);
    const ceiling = Math.min(physical, Math.max(cap, legal));
    const reach = clamp((struct - 0.08) / 0.22, 0, 1);
    cap = Math.max(cap, Math.round(cap + (ceiling - cap) * reach));
  }
  return Math.max(2, Math.min(cap, physical));
}

/**
 * WHAT GETS BUILT HERE — AND THE CITY REZONES WHEN A SECTOR LEAVES.
 *
 * This was five lines of pure zoning, and the first one, `M -> industrial`,
 * was a life sentence: a cleared lot on M-zoned land rebuilt an industrial
 * building forever, however much industry was left in the town.
 *
 * That is the missing half of the sector-exit ratchet in market.ts, and it was
 * the expensive half. The ratchet models tenants being priced out and never
 * coming back — measured over 50 years it takes the demand anchor to 0.63x for
 * office, 0.62x for industrial and 0.78x for retail — while the buildings they
 * left go on standing and the city goes on replacing them in kind. Office stock
 * reached 1.38x against demand of 0.63x. A 2.2x permanent overhang impairs every
 * landlord in the class for good, which is most of why 90% of rival firms died
 * and the street fell from 31 firms to 9.
 *
 * The ratchet's own comment cites the right fact and the code implemented half
 * of it: New York, San Francisco and London each lost more than half their
 * manufacturing FLOOR SPACE between 1970 and 2010. The floor space left. It was
 * converted and rebuilt — Long Island City, Williamsburg, the Brooklyn
 * waterfront, SoMa, the Docklands — because when the industry went, the city
 * rezoned the land it had been sitting on. None of it was kept zoned for
 * manufacturing and held empty for forty years.
 *
 * SO THE REZONED SHARE IS THE SECTOR-EXIT SHARE. Not a new constant: the same
 * quantity the ratchet already wrote down, read back. A sector that has lost a
 * third of its demand has a third of its land rezoned as that land turns over.
 * With nothing shed the weights below reduce to exactly the old thresholds, so
 * this is a strict generalisation of what was here.
 *
 * INDUSTRIAL HAS A SECOND EXIT CHANNEL — and this used to be blind to it.
 * Manufacturing's secular decline is carried by `industComp` in market.ts
 * (NY/SF/London floor-space half-life), not by the price ratchet. Measured on
 * null-player centuries before this wire: `industComp` fell to ~0.42 while
 * `baseStock` stayed at 1.0× forever, because falling demand MADE space cheap
 * and the price ratchet only fires on dear space. `gone()` read only
 * baseStock, so M-land stayed a life sentence, sheds sat at 20–35% vacancy
 * for decades, and real industrial rent ran about −2%/yr. The composition
 * index IS the sector-exit share for sheds; rezoning must read it. Cap and
 * residual floor unchanged — somebody still needs a last-mile bay.
 *
 * WHERE THE REZONED LAND GOES is multifamily, and that is the mechanism being
 * right rather than a preference. Housing is the one class the ratchet exempts,
 * for the reason stated there: people priced out of a city's housing leave and
 * the housing does not — demand for shelter in a place is not a footprint that
 * can relocate. So it is the one demand still standing when a sector goes, and
 * it is what the lofts, the warehouses and the emptied office floors became.
 */
export function useForZone(zone: string, demand: number, r: number, e?: Econ): DevUse {
  // The share of a sector that has structurally left. Capped below 1 because a
  // city never rezones the last of anything — somebody still needs a garage.
  const gone = (k: BuiltClass) => {
    const b0 = e?.baseStock0?.[k], b = e?.baseStock?.[k];
    const fromBase = b0 && b ? clamp(1 - b / b0, 0, 0.8) : 0;
    // Composition decline is sector exit for sheds — see block comment above.
    const fromComp = k === "industrial"
      ? clamp(1 - (e?.industComp ?? 1), 0, 0.8)
      : 0;
    return Math.max(fromBase, fromComp);
  };
  const here = (k: BuiltClass) => 1 - gone(k);
  /**
   * THE CRANE FILLS THE ORDER BOOK. Which is what an order book is for.
   *
   * The weights below are a programme mix — what a city of this demand level
   * builds on average — and until now they were the whole decision. The draw
   * never once asked which class the market was actually short of. Measured,
   * `pnpm mixmatch` read three of four classes at a NEGATIVE correlation
   * between what was ordered and what went in the ground, and industrial at a
   * third of every order and two per cent of every groundbreak. The book was
   * decoration, and the `orders -> breaks` leg of `pnpm leadlag` could only
   * ever be identified through the rent term that drove both ends of it.
   *
   * `econ.startOwed` is the queue: square feet ordered by the space market, per
   * class, expiring after eighteen months, decremented by every groundbreak.
   * `tickCityDev` already reads its TOTAL to size the crane count. This reads
   * its COMPOSITION to pick the use, which is the other half of the same
   * sentence, and it makes the leg a genuine fill relationship — breaks respond
   * to the book and then DRAIN it, so the feedback is negative and the lag is
   * the queue's own.
   *
   * NO CONSTANT ENTERS HERE. `pick` normalises, so only the ratios matter, and
   * the ratios are the order book's own. Two earlier attempts got that wrong in
   * opposite directions and both are worth keeping in mind:
   *
   *   - Weighting by each class's share of the book CLAMPED to [0.33, 2.5].
   *     Instrumented over 9,084 draws the clamp bound 52.7% of the time, so in
   *     half the city's decisions the mechanism was the clamp — CLAUDE.md fake
   *     number five, a rail that is load-bearing rather than a guard.
   *   - Weighting by `classAppetite` instead. That reads far better on the
   *     headline numbers and is still wrong, because `e.starts` — the thing
   *     that FILLED the book in that experiment — was itself
   *     `vacGate(vacancy) x credit x margin`
   *     and `classAppetite` is `tight(vacancy) x credit x devPencils`. They are
   *     the same formula. Wiring one to the other does not build a mechanism,
   *     it builds a mirror: `orders -> breaks` duly went to r 0.39 and BACKWARDS
   *     at -17 months, which is two copies of one series arguing about phase.
   *     That is the exact fault this whole line of work exists to find.
   */
  const owed = (u: DevUse): number =>
    Math.max(0, e?.startOwed?.[dominantOf(devMix(u))] ?? 0);
  // Weighted pick over [0,1), so a class's mass shrinks by exactly what has
  // left and the remainder falls to housing. One draw, same as before.
  //
  // If the book is empty of everything this zone permits there is nothing to
  // normalise, and the programme weights stand alone. That is a guard rather
  // than a rail — an empty book means the market has not asked for anything,
  // and the appetite gate in the caller rejects the site a line later anyway,
  // so what this returns in that case rarely reaches a shovel.
  const pick = (w0: [DevUse, number][]): DevUse => {
    const wo = w0.map(([u, x]) => [u, x * owed(u)] as [DevUse, number]);
    const w = wo.reduce((t, [, x]) => t + x, 0) > 0 ? wo : w0;
    const total = w.reduce((t, [, x]) => t + x, 0);
    let acc = 0;
    for (const [use, x] of w) { acc += x / total; if (r < acc) return use; }
    return w[w.length - 1][0];
  };
  if (zone.startsWith("R")) return "multifamily";
  if (zone.startsWith("M")) {
    return pick([["industrial", here("industrial")], ["multifamily", gone("industrial")]]);
  }
  if (demand > 70) {
    return pick([["office", 0.55 * here("office")], ["mixed", 0.30], ["retail", 0.15 * here("retail")],
                 ["multifamily", 0.55 * gone("office") + 0.15 * gone("retail")]]);
  }
  if (demand > 45) {
    return pick([["mixed", 0.40], ["multifamily", 0.40 + 0.20 * gone("retail")], ["retail", 0.20 * here("retail")]]);
  }
  return pick([["multifamily", 0.70 + 0.30 * gone("retail")], ["retail", 0.30 * here("retail")]]);
}

/**
 * Would anybody sensibly break ground in this class right now?
 *
 * Vacancy against its natural rate, softened by what is already coming. A
 * class three points tight gets built hard; a class in a glut with a full
 * pipeline does not get built at all, which is what stops the city cheerfully
 * paving itself through a downturn.
 */
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// Split from `classAppetite` so `useForZone` can read it: the whole computation
// only ever touched `s.econ`, and the use-picker has the Econ but not the state.
// Same function, one caller deeper — nothing about the number changed.
function classAppetiteE(e: Econ, k: BuiltClass): number {
  const vac = e.cityVac?.[k] ?? NATURAL_VAC[k];
  const gap = vac - NATURAL_VAC[k];
  const stk = e.stock?.[k] ?? CITY_STOCK[k];
  const coming = (e.pipeline?.[k] ?? 0) / Math.max(1, stk);   // pipeline as a share of stock
  const tight = clamp(1 - gap * 13 - coming * 5, 0, 2.1);
  // ...AND WHETHER IT PENCILS. The city's own infill read vacancy, the
  // pipeline and the credit window, and never once read what money cost — so
  // a three-hundred-basis-point shock left the municipal cranes turning at
  // exactly the same rate. See market.devPencils: one hurdle, read by the
  // quota, by the street, and by the city.
  return tight * clamp(e.creditIdx ?? 1, 0.25, 1.25) * devPencils(e, k);
}

function classAppetite(s: GameState, k: BuiltClass): number {
  return classAppetiteE(s.econ, k);
}

/**
 * A RECORD GOES ON THE TAPE, AND THE TAPE TAKES YOU THERE.
 *
 * A city notices when somebody plans the biggest office building it has ever
 * seen — that is front-page news in any real town, and it is exactly the event
 * a principal wants to fly to and stare at, because the supply it represents is
 * pointed at their rent roll. The record is seeded LAZILY from the standing
 * stock, so the first two-storey shop of a young campaign does not make the
 * tape: a plan is only news when it beats everything built as well as
 * everything planned.
 */
export function noteRecordPlan(
  s: GameState, parcels: ParcelTable, bbl: string, use: BuiltClass, sf: number, floors: number, who: string,
) {
  if (!s.recordPlan) {
    s.recordPlan = { office: 0, retail: 0, multifamily: 0, industrial: 0 };
    for (const b in parcels) {
      const r = parcels[b];
      if (!r || r.class === "land" || !r.bldgArea) continue;
      const k = r.class as BuiltClass;
      if (k in s.recordPlan && r.bldgArea > s.recordPlan[k]) s.recordPlan[k] = r.bldgArea;
    }
  }
  if (sf <= (s.recordPlan[use] ?? 0)) return;
  s.recordPlan[use] = sf;
  const rec = resolveRec(parcels, s, bbl);
  s.news.unshift({
    q: s.month, kind: "event", bbl,
    text: `${who} filed plans for the largest ${SECTOR_LABEL[use].toLowerCase()} building this city has ever ` +
      `seen: ${Math.round(sf).toLocaleString()} sf, ${floors} floors, at ${rec?.address ?? bbl}. ` +
      `Every landlord in the class just read the same paragraph you did.`,
  });
}

/**
 * THE CITY TEARS ITS WORST BUILDINGS DOWN.
 *
 * Nothing in this town was ever demolished. The audit put it in one line:
 * mean building age rose fifty years over fifty years, in every seed, which
 * means the 1890 walk-up standing at the start is the 1890 walk-up standing at
 * the end and the stock is a museum rather than a market. Real cities lose
 * about half a per cent of their building stock a year to the wrecking ball,
 * and they lose a very specific half per cent: the buildings whose LAND is
 * worth conspicuously more than the building standing on it. That is the
 * teardown test, it is the oldest calculation in this business, and it is what
 * turns a neighbourhood over.
 *
 * Player buildings are never touched — your asset is yours to run into the
 * ground or not. Everything else is fair game, and what goes is what fails the
 * test worst: obsolete, old, and sitting on dirt that wants a better building.
 */
/**
 * HOW MANY JOBS THIS TOWN CAN HAVE IN THE GROUND AT ONCE. General contractors,
 * tower cranes and steel crews are finite and they are shared: the teardown
 * pipeline, the quota and a rival's tower all draw on the same pool.
 *
 * IT SCALES WITH THE TOWN, AND IT DID NOT BEFORE. This was `bbls.length / 165`
 * and the comment claimed it was "scaled to the size of the town" — but the lot
 * count is a property of the PLAT, fixed the day the map is drawn. A city that
 * doubled its population and its built stock had exactly the same number of
 * cranes it started with, for ever.
 *
 * That constant was the binding constraint on the whole city's construction,
 * and it is the third mechanism behind the owner's report that land prices run
 * away. Measured on the shipped island over sixty years, before this change:
 *
 *   cranes in the ground   8 -> 9      pinned at capacity for 55 of 60 years
 *   population         43,451 -> 80,813   (+86%)
 *   housing stock        4.62M -> 6.45M sf  (+40%)
 *   housing sf a head      106 -> 73       (-31%)
 *   multifamily vacancy   7.06% -> 1.35%   and pinned on its frictional floor
 *                                          for 50 of those 60 years
 *   real housing rent     24.8 -> 82.6     (3.3x)
 *
 * Unmet demand was NOT accumulating — `startOwed` sat flat at about 0.3M sf —
 * so this was not a market that failed to ask for housing. It asked every
 * month and the trade could not answer, because the trade was a constant. Rents
 * then compounded, and since land is the residual after construction cost,
 * compounding rents are what detonate land prices.
 *
 * A real construction industry grows with the economy it serves: more people
 * and more buildings mean more firms, more crews and more equipment. So the
 * plat sets the starting scale and the town's own growth carries it from there.
 * The bounds are wide and are guards, not policy — a town cannot lose its
 * builders entirely, and it cannot conjure a boomtown's worth of them overnight.
 */
function crewCapacity(bbls: string[], e?: Econ): number {
  // WHAT A TOWN THIS SIZE CARRIES IN AN ORDINARY YEAR, IN SIMULTANEOUS JOBS.
  //
  // This was `lots / 165` scaled by population growth: a proxy for the size of
  // the place, with no units and nothing real behind the divisor. The quantity
  // it is trying to name has a definition. A city has some floor area standing
  // and some share of it under construction at any moment, and that share is
  // just how fast the stock turns over multiplied by how long a building takes:
  // a growing US metro delivers on the order of 1.8% of its stock a year, and
  // the stock-weighted build here runs about two and a half years (BUILD_MONTHS
  // — office 30-44, retail 18-28, multifamily 22-34, industrial 12-20). So
  // roughly four and a half per cent of a real city's floor area is in the air,
  // and divided by what a building here weighs, that is the crew count.
  //
  // Measured, the difference is the whole of the fault: the lot-count base gave
  // this town 8-10 crews and it wanted 26. `crewIdx` then ran to its ceiling
  // and STAYED there in 26-57% of months — the same load-bearing rail one level
  // up, which is what a base number that is wrong by a factor of three looks
  // like from the inside.
  let stock = 0;
  for (const k of BUILT_CLASSES) stock += e?.stock?.[k] ?? 0;
  // The lot count is the fallback before the first tick has set a stock, and
  // the floor of 4 is a guard for the smallest island.
  const base = stock > 0 ? (stock * NORMAL_PIPE_SHARE) / TYPICAL_SF : bbls.length / 165;
  // ...AND THE TRADES FOLLOW THE WORK — see `tickCrews`. `crewIdx` is how far
  // the town's construction workforce sits above or below ordinary because of
  // how busy it has been.
  return Math.max(4, Math.round(base * clamp(e?.crewIdx ?? 1, CREW_MIN, CREW_MAX)));
}

/**
 * Share of a city's floor area under construction in an ordinary year — the
 * delivery rate times the build duration, both measured above.
 *
 * The same quantity `market.ts` calls `REF_PIPE_SHARE`, and it is imported from
 * there rather than restated. These used to be two constants — 0.045 here from
 * the world, 0.018 there measured off this model while the old crew wall was
 * suppressing the pipeline — and the note that used to sit here explained the
 * gap as "the factor the wall was suppressing". The wall is gone; the gap was a
 * bug waiting for somebody to notice, and it was pinning the construction
 * employment term on its ceiling in 56.6% of all months.
 */
const NORMAL_PIPE_SHARE = REF_PIPE_SHARE;

/**
 * Repair, renovation and fit-out as a share of all construction work — the part
 * of the trades' order book that is not speculative new build and does not stop
 * when the cranes do. Roughly 45% of US construction spend.
 */
const MAINTENANCE_SHARE = 0.45;

// A town cannot lose its builders entirely and cannot conjure a boomtown's
// worth of them overnight. These are guards on the workforce index, not
// policy — `tickCrews` reports how often they bind and they are not meant to.
const CREW_MIN = 0.5;
const CREW_MAX = 3.0;

/**
 * THE BUILDING TRADES ARE A STOCK, AND IT ANSWERS THE ORDER BOOK.
 *
 * The crew count used to be a fixed function of lots and population, which
 * made it a hard quantity ceiling on everything the city could build. That is
 * a real constraint modelled as the wrong KIND of thing. There genuinely are
 * only so many general contractors in a harbour town — but when they are all
 * booked and there is a queue out the door, two things happen and this engine
 * modelled neither: their price goes up, and more of them show up.
 *
 * What it cost, measured before this existed:
 *
 *   - the town wanted 1.5-2.8x the cranes it could run, in 69-97% of months,
 *     with an order book of ~0.7M sf standing permanently unbuilt;
 *   - stock grew 0.4-0.65%/yr for fifty years against a population growing
 *     24-96%, so square feet per resident fell from 261 to as low as 170;
 *   - and REAL construction cost FELL 0.3-2.2%/yr across half a century in a
 *     town that was desperate to build, because the cost index reads how much
 *     IS being built and the wall made that number nearly constant. Excess
 *     demand accumulated in `startOwed`, sat at its 18-month cap, and was
 *     thrown away without ever touching a price.
 *
 * A market that cannot clear on quantity clears on price, and the price it
 * reached for was rent: real office rent ran a ~30-year cycle with a 40-70%
 * drawdown, against a real office cycle of ~10-12 years. The rent oscillation
 * was the symptom; this was the cause.
 *
 * So the trades migrate. The workforce grows toward the size that would clear
 * the book and shrinks when there is nothing to do, at about a per cent a
 * month per unit of excess utilisation — a workforce that doubles in six years
 * under a sustained doubling of the order book, and sheds 6%/yr when half its
 * men are idle. US construction employment rose 45% over 2011-2019 and fell
 * 30% over 2006-2011, which is that order of speed.
 */
function tickCrews(s: GameState, bbls: string[]) {
  const e = s.econ;
  const owed = e.startOwed ? Object.values(e.startOwed).reduce((a, v) => a + Math.max(0, v), 0) : 0;
  const live = (s.cityJobs ?? []).filter((j) => !j.orphaned).length;
  const capacity = crewCapacity(bbls, e);
  // Everything the town is trying to have built — the jobs running plus the
  // floor area ordered and not yet broken ground on — against what it can
  // carry at once. One means the trades are exactly fully employed.
  //
  // ...OVER A FLOOR OF WORK THAT IS NOT SPECULATIVE NEW BUILD. Measured
  // against new construction alone this ran to 0.05 at the p05, which says a
  // town's entire building industry stands idle in a downturn, and no town's
  // does: repair, renovation and fit-out are about 45% of all construction
  // work and they do not stop when the cranes do. Carrying that load means the
  // trades bottom out around 45% employed rather than at nothing, which is
  // both the real number and the reason construction costs do not swing as
  // violently as new-build volume does.
  const steady = capacity * (MAINTENANCE_SHARE / (1 - MAINTENANCE_SHARE));
  const util = (live + owed / TYPICAL_SF + steady) / Math.max(1, capacity + steady);
  // A year's memory: a contractor hires on a book, not on a month.
  e.crewUtil = (e.crewUtil ?? util) + 0.08 * (util - (e.crewUtil ?? util));
  // The workforce that WOULD clear the book is the current one times how
  // oversubscribed it is; the industry walks toward it rather than jumping.
  const idx = clamp(e.crewIdx ?? 1, CREW_MIN, CREW_MAX);
  e.crewIdx = clamp(idx * (1 + 0.010 * ((e.crewUtil ?? 1) - 1)), CREW_MIN, CREW_MAX);
}

/**
 * Floor area of a typical building here, so the order book converts to a crane
 * count. 42,000 sf was right when infill was sized off the zoning envelope;
 * under the cornice-datum cap the measured median city building is ~26,000 sf,
 * and leaving the old figure in place silently halved the square footage the
 * space market ordered. The market's demand arrives as more, smaller buildings
 * now — which is what a low town growing visibly looks like.
 */
const TYPICAL_SF = 26_000;

/**
 * Frictional rail binding AND the order book still wants floor of this class.
 * `structTight` alone missed seeds where vacancy sat on the rail with a full
 * startOwed book but employment-gap stayed under the old 0.06 gate — densify
 * cleared underwriting and still never broke ground.
 */
function classPinnedOwed(e: Econ, k: BuiltClass, slack = 0.02): boolean {
  const vac = e.cityVac?.[k] ?? NATURAL_VAC[k];
  return vac <= frictionFloor(k) + slack && (e.startOwed?.[k] ?? 0) > 0;
}

function tickTeardowns(s: GameState, parcels: ParcelTable, bbls: string[]) {
  // A slow clock. Roughly one candidate examined a month, and only the worst
  // offender in a sample gets the notice — a city does not clear a block a
  // month, it clears one building every year or two.
  // Calibrated against the real rate of loss. A city demolishes something like
  // half a per cent of its building stock a year; at the first cut of these
  // numbers the mean building age still rose forty-one years over fifty, which
  // is a town that replaces a tenth of itself in half a century and is still
  // mostly a museum.
  const e = s.econ;
  // Chronic shortage: examine more often. Employment gap (`structTight`) OR
  // a pinned class with unpaid orders — both mean the wrecking ball is how a
  // built-out city answers. Not a vac-coefficient hike.
  const chronicShort = BUILT_CLASSES.some((k) => {
    const pinned = (e.cityVac?.[k] ?? NATURAL_VAC[k]) <= frictionFloor(k) + 0.015;
    return pinned && ((e.structTight?.[k] ?? 0) > 0.08 || (e.startOwed?.[k] ?? 0) > 0);
  });
  if (rng(s, "dev") > (chronicShort ? 0.50 : 0.85)) return;
  // A REPLACEMENT IS BUILT BY THE SAME CREWS AS EVERYTHING ELSE.
  //
  // This path is 96% of all the square footage this city builds, and it broke
  // ground without ever asking whether there was a contractor free. The quota
  // below it does ask — `Math.max(0, capacity - live)` — so teardowns were
  // spending the town's construction capacity from OUTSIDE the budget that was
  // supposed to ration it. The quota was therefore clipped to zero most
  // months by jobs it had no say over, which is why the vacancy gate on
  // starts — the line market.ts calls "the real control" — was measurably
  // inert: halving its gain produced byte-identical output over three seeds
  // and fifty years, because the thing it controlled was already pinned at
  // zero and the building was happening somewhere else.
  //
  // There is one crane pool in a town this size and every job queues in it.
  // Measured over 6 seeds x 50 years, this line plus the order-book fix below:
  // the share of stock under construction goes from a 0.0214 median with a
  // 0.126 maximum to a 0.0185 median with a 0.064 maximum — i.e. onto the
  // 0.018 the rest of the engine says this town builds at — the construction
  // employment term stops sitting on its clamp (31.5% of months -> 5.5%), and
  // starts stop being a relay pinned at hard zero (45.2% of months -> 12.7%).
  // Office sd(log) of real effective rent moves 0.356 -> 0.263 with it, and
  // retail 0.497 -> 0.259.
  if ((s.cityJobs ?? []).filter((j) => !j.orphaned).length >= crewCapacity(bbls, s.econ)) return;
  // Score by DENSIFICATION SURPLUS, not land/building alone. A cash-flowing
  // worn walk-up on a FAR-rich corner is the real redevelopment candidate in
  // a shortage; the old land/built ratio only found husks, and century nulls
  // rebuilt ~zero lots while jobs outran floors (ECONOMY.md §F #2 / CENTURY #6).
  let worst: {
    bbl: string; rec: NonNullable<ReturnType<typeof resolveRec>>; ratio: number; score: number;
  } | null = null;
  const sampleN = chronicShort ? 40 : 26;
  for (let i = 0; i < sampleN; i++) {
    const bbl = bbls[Math.floor(rng(s, "dev") * bbls.length)];
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    if (s.holdings[bbl] || s.developments[bbl]) continue;        // never yours
    if (s.cityGroundLeases?.[bbl]) continue;                     // leased fee sold off-book — lessee still controls
    if (s.landmarks?.[bbl] !== undefined) continue;              // and never a landmark
    if ((s.cityJobs ?? []).some((j) => j.bbl === bbl)) continue;
    if (ownerOf(s, bbl)) continue;                               // named firm path is startOwnJob
    const age = START_YEAR + Math.floor(s.month / 12) - (rec.yearBuilt || 1900);
    if (age < 45) continue;                                      // nobody knocks down a young building
    // `gradeOf` is the OWNER'S stewardship, not the building's birthday — a
    // shed a slumlord has milked for thirty years is a teardown at sixty and
    // the same shed in a core fund is not.
    const cond = gradeOf(s, rec);
    if (cond !== "obsolete" && cond !== "worn" && cond !== "standard") continue;
    const land = landValue(rec, e);
    const built = Math.max(1, assetValue(rec, e, cond));
    const ratio = land / built;
    const probeUse = useForZone(rec.zoneDist ?? "C", rec.demandScore, rng(s, "dev"), e);
    const probeLead = dominantOf(devMix(probeUse));
    const infill = cityInfillCap(s, parcels, rec, 1, probeLead);
    const targetSf = Math.max(3000, Math.round(rec.lotArea * 0.62 * infill));
    const densify = targetSf / Math.max(1, rec.bldgArea);
    const st = e.structTight?.[probeLead] ?? 0;
    const condW = cond === "obsolete" ? 1.35 : cond === "worn" ? 1.15 : 1.0;
    // Land/built still matters (option value of dirt), but unused legal FAR
    // under a chronic short is the densify pressure the century was missing.
    // Structural manufacturing exit is NOT scored here — boosting soft sheds
    // into this sample wasted densify months on fringe sites whose MF/office
    // replacement does not pencil (measured: office pin and structTight
    // regressed). Surplus empty sheds clear via tickIndustrialExit instead.
    const score = (0.35 + Math.max(0, ratio)) * densify * condW * (1 + 2.2 * st);
    if (!worst || score > worst.score) worst = { bbl, rec, ratio, score };
  }
  if (!worst) return;
  const { rec, ratio } = worst;
  // WHAT WOULD GO UP HERE IS DECIDED BEFORE THE BUILDING COMES DOWN, because
  // the only question that licenses a teardown is whether the REPLACEMENT
  // pencils, and that is a question about the replacement's class.
  //
  // This read `devPencils(e)` — and the signature is `devPencils(e, k =
  // "office")`, so the whole city's wrecking ball was gated on office
  // economics by an accident of a default argument. A glut in one class
  // therefore froze the recycling of every other, which is the wire running
  // backwards: a glut should raise the pressure to clear obsolete space, not
  // switch off the only mechanism that can clear it. Measured by decade over
  // five seeds, teardowns tracked office pencilling and nothing else —
  //
  //   teardowns          66.2  24.6  37.8  66.6  12.2
  //   devPencils(office)  1.22  0.48  0.72  1.38  0.22
  //
  // — while industrial demand fell to 0.62x with its stock sitting at 1.04x,
  // untouched, because office happened to be soft at the time.
  const yr0 = START_YEAR + Math.floor(s.month / 12);
  let nextUse = useForZone(rec.zoneDist ?? "C", rec.demandScore, rng(s, "dev"), e);
  let lead = dominantOf(devMix(nextUse));
  const teardownRoll = rng(s, "dev");
  const bbl = rec.bbl;
  const oldSf = rec.bldgArea;
  // Standing use before teardown — BuiltClass excludes "land", so keep the
  // raw class for the stock-removal path below. Candidates above already skip
  // vacant lots; the `!== "land"` check also narrows AssetClass → BuiltClass.
  const cls = rec.class;
  // When the standing class is pinned with unpaid orders, densify IN KIND.
  // useForZone's programme mix was converting short office into multifamily
  // while the office book stayed full — supply answering the wrong demand.
  // Gate on the rail + startOwed, not only structTight: moderate employment
  // gaps still leave vacancy on the frictional floor with a live order book.
  if (cls !== "land" && (CITY_STOCK as Record<string, number>)[cls] !== undefined) {
    const standing = cls;
    const stStand = e.structTight?.[standing] ?? 0;
    if (classPinnedOwed(e, standing)) {
      if (rng(s, "dev") < Math.min(0.85, 0.50 + stStand * 1.5)) {
        nextUse = standing;
        lead = standing;
      }
    }
  }
  // A replacement is still supply. It may satisfy an existing order, but it
  // cannot create a class of space the market has not ordered at all.
  if ((e.startOwed?.[lead] ?? 0) <= 0) return;
  const leadShort = classPinnedOwed(e, lead)
    || ((e.structTight?.[lead] ?? 0) > 0.06
      && (e.cityVac?.[lead] ?? NATURAL_VAC[lead]) <= frictionFloor(lead) + 0.02);

  // NOBODY DEMOLISHES A BUILDING AND LEAVES A HOLE.
  //
  // A wrecking ball is the first line item of a development budget, not an end
  // in itself: you clear a site BECAUSE you have a project, financing and a
  // contractor, and the hoarding goes up the same season. This used to clear
  // the lot and trust that "the existing city and street builders will find it
  // like any other site" — and measured over 50 years with no player, they did
  // not. The city tore down 343 buildings and delivered 115, and the standing
  // stock fell from 1,030 to 802. That is not a city recycling itself, it is a
  // city being quietly dismantled.
  //
  // So the teardown IS the groundbreaking. The replacement is sized off the
  // envelope the site can now reach rather than off what stood here — which is
  // the entire reason the old building came down — and it is bound by the same
  // cornice datum and per-use floor caps every other city job respects, so a
  // three-storey town does not sprout a tower on one cleared lot.
  const yr = yr0;
  const farMax = farMaxFor(rec);
  // A redevelopment goes bigger than what it replaced — that is the arithmetic
  // that condemned the old building — but HOW MUCH BIGGER IS A MARKET
  // QUESTION, and the first cut of this did not ask it. It took 45-80% of the
  // envelope unconditionally, so every teardown added floor area whether or
  // not anybody wanted the space. Measured: the city grew its floor area
  // ~50% in fifty years regardless of vacancy, and sim:accept F went bimodal —
  // office rent at year 50 landed anywhere from $34 to $505 across seven
  // seeds, because in half the runs the supply response ran away from demand
  // and real rents fell 3-5% a year for half a century.
  //
  // Nobody builds fifty per cent more space into a glut. A developer facing
  // slack takes the smallest building that justifies clearing the site — or
  // walks — and the same site in a shortage gets the full envelope. So the
  // share is read off how far this class's vacancy sits from its natural
  // rate, which is the same signal the rest of the pipeline already uses.
  //
  // These two are SHAPE PARAMETERS and, per CLAUDE.md, they get to say which.
  // The elasticity (7) is anchored on how hard real starts respond to slack:
  // about five points of vacancy above natural roughly halves them, and ten
  // points very nearly stops them — 1 - 7*slack reads 0.65 and 0.30 at those
  // two points, which is the right shape. The 0.30 floor is the smallest
  // building that still justifies mobilising a site at all. Neither was
  // iterated against a test: they were chosen once from that anchor. What DID
  // come from measurement is that the previous unconditional 0.45-0.80 share
  // was wrong, and the evidence is in the paragraph above.
  const slack = Math.max(0, (e.cityVac[lead] ?? NATURAL_VAC[lead]) - NATURAL_VAC[lead]);
  const appetite = Math.max(0.18, Math.min(1, 1 - slack * 7));
  // Shortage asks for more of the legal envelope; glut still walks small.
  const shareFloor = leadShort ? 0.55 : 0.30;
  const share = shareFloor + (0.80 - shareFloor) * appetite * (0.75 + rng(s, "dev") * 0.5);
  let nsf = Math.max(3000, Math.round((rec.lotArea * farMax * Math.min(0.95, share)) / 100) * 100);
  let nfl = Math.max(1, Math.round(nsf / (rec.lotArea * 0.62)));
  const infill = cityInfillCap(s, parcels, rec, 1, lead);
  if (nfl > infill) { nfl = infill; nsf = Math.max(3000, Math.round((rec.lotArea * 0.62 * nfl) / 100) * 100); }
  const ucap = MAX_FLOORS_BY_USE[nextUse];
  if (ucap !== undefined && nfl > ucap) { nfl = ucap; nsf = Math.max(3000, Math.round((rec.lotArea * 0.62 * nfl) / 100) * 100); }
  // When the class is short of housable floor, refuse teardowns that do not
  // grow stock — clearing to a same-size box is how the century stayed pinned.
  if (leadShort && nsf < oldSf * 1.12) {
    const needFl = Math.min(
      infill,
      ucap ?? infill,
      Math.ceil((oldSf * 1.15) / Math.max(1, rec.lotArea * 0.62)),
    );
    if (needFl > nfl) {
      nfl = needFl;
      nsf = Math.max(3000, Math.round((rec.lotArea * 0.62 * nfl) / 100) * 100);
    }
    if (nsf < oldSf * 1.08) return;
  }

  // The wrecking ball does not move until the replacement clears the same full
  // site-level pro forma as every other builder. Because the existing building
  // is still resolved here, the shared plan includes demolition cost.
  //
  // Opportunity cost is what a REDEVELOPER must pay the owner — not full
  // stabilized income value. A buyer who will darken and demolish the building
  // never pays the keep-operating mark: obsolete fabric, vacancy during the
  // wipe, and demo risk are real discounts. The old gate required land/building
  // >= 0.85 then put only LAND in the basis (two different questions). Charging
  // undiscounted assetValue after that fix made densify almost never clear
  // (≈5% of FAR-rich office candidates in a shortage) while jobs outran floors
  // for a century — ECONOMY.md §F #2. Haircut by condition; still take the
  // max of dirt and the discounted as-is bid.
  // Unowned fabric only on this path (player / named firms skipped above).
  // Full assetValue was an owner's forgoing applied to a building with no
  // owner — densify cleared on ≈5% of FAR-rich office candidates while jobs
  // outran floors (ECONOMY.md §F #2). Land is the opportunity cost; demo is
  // inside the shared plan. Rival-owned densify keeps the discounted as-is
  // bid in startOwnJob.
  const opportunityCost = landValue(rec, e);
  const underwriting = underwriteDevelopment(
    s, parcels, bbl, nextUse, nfl, 0.62, opportunityCost,
  );
  // Soften the stochastic walk under chronic shortage — still requires a
  // clearing pro forma; does not free-build.
  const rollGate = leadShort ? 0.88 : 0.62;
  if (!underwriting?.clears || teardownRoll > rollGate * underwriting.appetite) return;
  const plan = underwriting.plan;
  nsf = plan.sf;
  nfl = plan.floors;
  if (leadShort && nsf < oldSf * 1.05) return;
  const tprog = plan.mix;
  // Preserve both historical duration draws. The date itself now comes from
  // the common schedule rather than a teardown-only clock.
  const formerBuildRoll = rng(s, "dev");
  const formerDemoRoll = rng(s, "dev");
  void formerBuildRoll; void formerDemoRoll;
  const months = plan.months;

  // Off the record and off the stock only AFTER the replacement is funded.
  s.built[bbl] = { class: "land" as unknown as BuiltClass, bldgArea: 0, floors: 0, yearBuilt: 0 };
  const stoodAs = rec.class !== "land" ? (rec.class as BuiltClass) : null;
  if (stoodAs && (CITY_STOCK as Record<string, number>)[stoodAs] !== undefined) {
    addStock(e, stoodAs as keyof typeof CITY_STOCK, -oldSf);
  }
  s.demolished = (s.demolished ?? 0) + 1;
  recordPropertyEvent(s, bbl, {
    kind: "demolished",
    sf: oldSf,
    use: stoodAs ?? undefined,
    outcome: `${rec.yearBuilt || "Older"} building cleared for ${nextUse}`,
  });

  (s.cityJobs ??= []).push({ bbl, use: nextUse, sf: nsf, floors: nfl, startM: s.month, deliverM: s.month + months, mix: tprog });
  recordPropertyEvent(s, bbl, {
    kind: "build-start",
    use: nextUse,
    sf: nsf,
    floors: nfl,
    party: "The city",
  });
  // ...and the one delivery queue carries that same programme, whole.
  const teardownProgramme = programmeSf(nsf, tprog);
  queueSupplyProject(s, {
    bbl,
    source: "teardown",
    deliverM: s.month + months,
    sfByUse: teardownProgramme,
  });
  for (const [u, usf] of Object.entries(teardownProgramme)) {
    // ...AND THE ORDER BOOK IS TOLD. `startOwed` is the square footage the space
    // market has asked for and not yet seen broken ground on, and the quota
    // block downstream spends it. A replacement that goes up on this path fills
    // exactly the same order — it is the same crews, the same class, the same
    // month — and it was never netted off, so the city carried a permanent
    // phantom backlog and kept ordering cranes against demand it had already
    // met. Every other start path in this file already does this; this one did
    // not, and it is the biggest of them.
    if (s.econ.startOwed) {
      s.econ.startOwed[u as BuiltClass] = Math.max(0, (s.econ.startOwed[u as BuiltClass] ?? 0) - usf);
    }
  }

  {
    // A COIN FLIP IS NOT A RELEVANCE TEST, AND IT WAS STANDING IN FOR ONE.
    //
    // This read `rng(s, "dev") < 0.30`: file three teardowns in ten, chosen at random.
    // That number is not a fact about the world — it is a volume dial, put here
    // so the paper would not overflow, and it throttles the SIGNAL at exactly
    // the same rate as the noise. The city tears down about 6.4 buildings a
    // year and this printed a random 1.9 of them, which made it the single
    // loudest line on the tape while still managing to miss two thirds of the
    // demolitions on the player's own street.
    //
    // Every teardown is recorded now — the tape gets MORE complete, not less —
    // and it interrupts only when the wrecking ball is on a block the player
    // owns something on. Block, not district: the city has four districts, so
    // "somewhere in your district" is true of half the parcels in town and gets
    // truer as the player grows, which is why the paper was noisiest for the
    // busiest players. A block is about 3% of the city and is what a person
    // means by "near me".
    const yoursHere = Object.keys(s.holdings).some((b) => parcels[b]?.block === rec.block);
    const densifyX = nsf / Math.max(1, oldSf);
    const why = densifyX >= 1.25
      ? `the site densifies ${(densifyX).toFixed(1)}x under a ${lead} shortage`
      : ratio >= 0.85
        ? `the land under it is worth ${ratio.toFixed(1)}x the standing building`
        : `the replacement clears its full hurdle after charging $${(opportunityCost / 1e6).toFixed(1)}M for the building being sacrificed`;
    s.news.unshift({
      q: s.month, kind: yoursHere ? "event" : "info",
      text: `${rec.address} is coming down. It went up in ${rec.yearBuilt}, and ${why}. `
        + `${(nsf / 1000).toFixed(0)}k sf of ${nextUse} replaces it, opening ${monthLabel(s.month + months)}.`,
    });
  }
  void yr;
}

/**
 * STRUCTURAL INDUSTRIAL EXIT — the mothballing half of manufacturing's leave.
 *
 * `industComp` (market.ts) declines at the NY/SF/London manufacturing
 * floor-space half-life. Rezoning via `useForZone` reads that decline, but
 * conversion still requires a replacement that pencils — and on this island's
 * M-land fringe, multifamily often does not. Measured before this path, on
 * five of six century seeds: industComp → 0.42, baseStock stuck at 1.0×,
 * physical stock −0.1%/yr, industrial vacancy soft 84% of months, real rent
 * ≈ −2.2%/yr. The composition index said the floor space had left; the map
 * kept every shed.
 *
 * Real cities did not wait for a midrise pro forma on every bay. Surplus empty
 * manufacturing stock was cleared to land (and later rebuilt when housing
 * penciled) — LIC, Williamsburg, Docklands. This retires EMPTY surplus toward
 * the composition envelope at the same historical rate industComp already
 * uses. It does not touch occupied space, player/rival holdings, or require a
 * replacement project. Teardown-for-replacement remains the conversion path
 * when a project clears.
 */
function tickIndustrialExit(s: GameState, parcels: ParcelTable, bbls: string[]) {
  const e = s.econ;
  const ic = e.industComp ?? 1;
  if (ic > 0.92) return;
  // DEFER TO EMPLOYMENT SHORTAGE, DON'T FREEZE. Clearing sheds onto the plat
  // while office cannot house its jobs hands vacant M-lots to multifamily
  // (useForZone reads industComp) and the shared crane pool follows them —
  // measured office structTight and real rent both worsened under a full-rate
  // clear. A hard freeze while office is pinned (~half a century) left
  // industrial soft 61% of months. Trickle clearance (~1/8 the ordinary rate)
  // still retires surplus floor space; densify keeps the crane priority.
  const officeShort = (e.structTight?.office ?? 0) > 0.08
    && (e.cityVac?.office ?? NATURAL_VAC.office) <= frictionFloor("office") + 0.015;
  const stock = e.stock?.industrial ?? 0;
  const occ = e.occupied?.industrial ?? 0;
  const vac = e.cityVac?.industrial ?? NATURAL_VAC.industrial;
  if (vac <= NATURAL_VAC.industrial + 0.015) return;
  // Envelope from OCCUPIED demand: stock that would put vacancy at natural
  // given today's tenants. Composition has already cut the looking pool;
  // what remains empty above natural is the surplus floor space that left
  // with manufacturing. (An absolute `stock0 × industComp` envelope ignored
  // job growth and aimed at a level the residual logistics market still
  // needed — clearance then either stalled or overshot.)
  const need = occ / Math.max(0.5, 1 - NATURAL_VAC.industrial);
  const empty = Math.max(0, stock - occ);
  const surplus = Math.min(Math.max(0, stock - need * 1.03), empty);
  if (surplus < 4000) return;
  // Clearance is lumpy (one building). Own RNG channel — must not steal
  // draws from teardown densify (`dev`).
  if (rng(s, "indust") > (officeShort ? 0.12 : 0.55)) return;

  // Pick the worst empty-ish anon shed: old, worn, low demand, preferably M.
  let worst: { bbl: string; rec: NonNullable<ReturnType<typeof resolveRec>>; score: number } | null = null;
  for (let i = 0; i < 36; i++) {
    const bbl = bbls[Math.floor(rng(s, "indust") * bbls.length)];
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class !== "industrial" || !rec.bldgArea) continue;
    // Never scrap more empty surplus than exists — a single large bay can
    // overshoot; skip if it would cut into occupied stock.
    if (rec.bldgArea > surplus * 1.05) continue;
    if (s.holdings[bbl] || s.developments[bbl]) continue;
    if (s.cityGroundLeases?.[bbl]) continue;
    if (s.landmarks?.[bbl] !== undefined) continue;
    if ((s.cityJobs ?? []).some((j) => j.bbl === bbl)) continue;
    if (ownerOf(s, bbl)) continue;
    const age = START_YEAR + Math.floor(s.month / 12) - (rec.yearBuilt || 1900);
    if (age < 35) continue;
    const cond = gradeOf(s, rec);
    if (cond !== "obsolete" && cond !== "worn" && cond !== "standard") continue;
    const condW = cond === "obsolete" ? 1.4 : cond === "worn" ? 1.15 : 1.0;
    const mZone = (rec.zoneDist ?? "").startsWith("M") ? 1.25 : 1.0;
    const score = condW * mZone * age * (1.15 - Math.min(1, rec.demandScore / 80));
    if (!worst || score > worst.score) worst = { bbl, rec, score };
  }
  if (!worst) return;
  const { bbl, rec } = worst;
  const oldSf = rec.bldgArea;
  s.built[bbl] = { class: "land" as unknown as BuiltClass, bldgArea: 0, floors: 0, yearBuilt: 0 };
  addStock(e, "industrial", -oldSf);
  // Vacancy accounting: we cleared empty surplus. Keep occupied; next market
  // tick recomputes cityVac from occ/stock. Clamp occupied into housable if
  // a large shed somehow overshot (guard only).
  const house = (e.stock.industrial ?? 0) * (1 - frictionFloor("industrial"));
  if ((e.occupied?.industrial ?? 0) > house) {
    e.occupied!.industrial = house;
  }
  s.demolished = (s.demolished ?? 0) + 1;
  recordPropertyEvent(s, bbl, {
    kind: "demolished",
    sf: oldSf,
    use: "industrial",
    outcome: `${rec.yearBuilt || "Older"} industrial cleared — manufacturing footprint has left`,
  });
  if (rng(s, "indust") < 0.18) {
    s.news.unshift({
      q: s.month, kind: "info",
      text: `${rec.address} is coming down empty. The manufacturing that filled it is gone, `
        + `and nothing has taken the bay. The lot waits.`,
    });
  }
}

export function tickCityGrowth(
  s: GameState, parcels: ParcelTable, bbls: string[], adjacency: Record<string, string[]> | null,
) {
  if (!s.cityJobs) s.cityJobs = [];
  // The trades read their own order book before the month's work is placed, so
  // the crew count this month reflects the queue they have been staring at.
  tickCrews(s, bbls);
  tickIndustrialExit(s, parcels, bbls);
  tickTeardowns(s, parcels, bbls);
  // Extra densify passes when the book is pinned short — one wrecking ball a
  // month cannot catch a multi-decade capacity shortfall.
  {
    const e2 = s.econ;
    const bookShort = BUILT_CLASSES.some((k) => classPinnedOwed(e2, k, 0.015));
    const shortOf = (th: number) => BUILT_CLASSES.some((k) => (e2.structTight?.[k] ?? 0) > th
      && (e2.cityVac?.[k] ?? NATURAL_VAC[k]) <= frictionFloor(k) + 0.015);
    if (bookShort || shortOf(0.08)) tickTeardowns(s, parcels, bbls);
    if (shortOf(0.16)) tickTeardowns(s, parcels, bbls);
  }

  // ---- deliveries first: today's opening was somebody's decision years ago --
  const still: NonNullable<GameState["cityJobs"]> = [];
  for (const j of s.cityJobs) {
    // An orphaned frame does not finish itself. It stands there until the
    // receiver sells it, and the buyer decides whether it ever opens.
    if (j.orphaned) { if (!s.built[j.bbl] && !s.holdings[j.bbl]) still.push(j); continue; }
    if (s.month < j.deliverM) { still.push(j); continue; }
    const rec = parcels[j.bbl];
    // A CLEARED LOT IS NOT A BUILT ONE. This read `s.built[j.bbl]` as "somebody
    // has already put something here" — but tickTeardowns writes a CLEARED
    // marker into exactly that map ({class:"land", bldgArea:0}) to take the old
    // building off the record. So every redevelopment job died silently on the
    // day it was due to open: measured, the city started 200-odd replacements
    // over fifty years and delivered eight. Test the square footage, not the
    // presence of a key.
    const standing = s.built[j.bbl];
    // A ground lessee builds on YOUR deed — the holding stays; the improvement
    // is theirs until reversion. Ordinary city jobs still refuse to deliver
    // onto a holding (that would gift the player a free building).
    if (!rec || (s.holdings[j.bbl] && !j.groundLease) || (standing && standing.bldgArea > 0)) continue;
    // THE CITY'S BUILDINGS GET THEIR GROUND FLOOR TOO. This is where the
    // volume is — the street starts 250-odd jobs a century against the
    // player's handful — so a shops-at-grade rule the city did not follow
    // would supply almost no retail at all.
    const cmix = j.mix ?? capRetail(
      withStreetRetail(devMix(j.use as DevUse), j.floors, rec.demandScore ?? 50), j.floors);
    s.built[j.bbl] = {
      class: dominantOf(cmix), mix: cmix, bldgArea: j.sf, floors: j.floors,
      yearBuilt: START_YEAR + Math.floor(s.month / 12),
    };
    const cBlock = demandModel(parcels).ofBbl.get(j.bbl);
    if (cBlock) nudgeBlockDemand(s, cBlock, Math.min(3, 0.8 + j.sf / 180_000));
    recordPropertyEvent(s, j.bbl, {
      kind: "delivered",
      use: dominantOf(cmix),
      sf: j.sf,
      floors: j.floors,
      party: j.groundLease
        ? (s.groundLeases?.[j.bbl]?.tenant
          ?? s.cityGroundLeases?.[j.bbl]?.tenant
          ?? "Ground lessee")
        : j.firmId
          ? (s.rivals.find((r) => r.id === j.firmId)?.name ?? "Developer")
          : "The city",
    });
    s.cityBuilt.push(j.bbl);
    if (j.groundLease) {
      const gl = s.groundLeases?.[j.bbl] ?? s.cityGroundLeases?.[j.bbl];
      if (gl) {
        gl.builtM = s.month;
        gl.sf = j.sf;
        gl.floors = j.floors;
        gl.use = dominantOf(cmix);
      }
      // Only news when the fee is still yours — an off-book leased fee topping
      // out is the buyer's story, not a line in your paper.
      if (s.groundLeases?.[j.bbl]) {
        s.news.unshift({
          q: s.month, kind: "info",
          text: `Your ground lessee topped out at ${rec.address}: ${j.floors} fl of ${dominantOf(cmix)} `
            + `(${Math.round(j.sf).toLocaleString()} sf). The coupon does not change — the bones revert with the land.`,
        });
      }
    } else if (j.firmId) {
      // If it had a name on it, the name now owns a building.
      jobDelivered(s, parcels, j.bbl, j.firmId, j.cost ?? 0);
    }
    // NOTE: no addStock here. The square feet went into the econ pipeline the
    // month the job STARTED and land in the citywide stock when its cohort
    // matures — counting them again on delivery would double the building.
    bumpLand(s, j.bbl, 1.05);
    for (const nb of adjacency?.[j.bbl] ?? []) bumpLand(s, nb, 1.03);
    // AND AN ORDINARY BUILDING OPENING IS NOT NEWS EITHER. Same reasoning as
    // the sale line in actions.ts: the city delivers 115-150 buildings in fifty
    // years and printing every one of them crowds out the paper. What stays is
    // what a principal would be told — supply landing in a submarket where you
    // own something and will be competing with it for tenants, or a building
    // tall enough to be the tallest thing anyone has put up lately.
    const near = Object.keys(s.holdings).some((b2) => {
      const r2 = resolveRec(parcels, s, b2);
      return r2 && r2.district === rec.district;
    });
    const tall = j.floors >= 8 && !(s.cityJobs ?? []).some((o) => o.bbl !== j.bbl && (o.floors ?? 0) > j.floors);
    // Ground-lessee toppings already filed their own line above.
    if (!j.firmId && !j.groundLease && (near || tall)) {
      s.news.unshift({
        q: s.month, kind: "info",
        text: near
          ? `${j.floors} floors of ${j.use} opened at ${rec.address}, in ${rec.district} — that is space competing with yours.`
          : `A ${j.floors}-story ${j.use} building opened at ${rec.address}, the tallest thing to top out in a while.`,
      });
    }
  }
  s.cityJobs = still;

  // ---- starts --------------------------------------------------------------
  // WHAT THE MARKET ASKED FOR, SPENT ON ACTUAL LOTS.
  //
  // The rate above used to be the whole story, and it had nothing to do with
  // the square footage the space market was simultaneously adding to rents in
  // an anonymous queue. Now that queue is a debt (econ.startOwed) and this is
  // where it gets worked off: enough cranes to cover the floor area the market
  // has demanded, at whatever size the sites around here actually carry.
  //
  const owed = s.econ.startOwed
    ? Object.values(s.econ.startOwed).reduce((a, v) => a + Math.max(0, v), 0) : 0;
  // ...converted to a crane count at the size of a typical building here.
  const wanted = owed / TYPICAL_SF;
  // AND THE TOWN ONLY HAS SO MANY CONTRACTORS.
  //
  // A backlog cleared at full speed put twenty-nine cranes up at once, which
  // is a boomtown, not a harbour city of sixteen hundred lots. The real
  // constraint is not demand, it is capacity: there are only so many general
  // contractors, tower cranes and steel crews in a town this size, and when
  // they are all working the next job waits its turn. That is why real
  // construction booms show up as cost escalation and schedule slippage rather
  // than as unlimited simultaneous starts.
  //
  // Scaled to the size of the place, so a bigger city carries more of them.
  const capacity = crewCapacity(bbls, s.econ);
  const live = (s.cityJobs ?? []).filter((j) => !j.orphaned).length;
  // No phase metronome and no second replacement-cost brake. The order book
  // was written by the shared pro forma; actual sites are checked against the
  // full parcel pro forma below. Physical crew capacity is the only separate
  // quantity constraint. Named rival starts already occupy a live crew slot,
  // so `startDebt` would subtract them twice.
  let n = Math.min(wanted, Math.max(0, capacity - live));
  n = Math.floor(n) + (rng(s, "dev") < n % 1 ? 1 : 0);
  // the town matures: later buildings are bigger than the first ones
  const maturity = Math.min(1, s.month / 780);

  while (n-- > 0) {
    // sample a handful of candidates, build on the most in-demand of them
    let best: { bbl: string; rec: (typeof parcels)[string] } | null = null;
    let bestScore = -1;
    for (let i = 0; i < 36; i++) {
      const bbl = bbls[Math.floor(rng(s, "dev") * bbls.length)];
      if (s.holdings[bbl] || s.built[bbl] || s.developments[bbl]) continue;
      if (s.cityJobs.some((j) => j.bbl === bbl)) continue;
      // A NAMED FIRM'S DIRT IS NOT THE CITY'S TO BUILD ON. Two owners on one
      // parcel is the invariant this broke: the anonymous picker took any
      // vacant lot, a developer then claimed the job on it, and the deed was
      // suddenly on two balance sheets. Their own land is built on by them,
      // in `startOwnJob`, which is where a land bank is supposed to go.
      if (ownerOf(s, bbl)) continue;
      // Resolved, not static: a lot that has had a building DELIVERED on it is
      // no longer vacant, and the static table still says it is.
      const rec = resolveRec(parcels, s, bbl);
      if (!rec || rec.class !== "land" || rec.lotArea < 1500) continue;
      // THE CITY PICKED THE MOST EXPENSIVE DIRT IN THE SAMPLE, EVERY TIME.
      //
      // This scored candidates on DEMAND — "the city builds where the
      // neighbourhood has become good" — which is the numerator of a
      // development decision with the denominator left out. A high-demand
      // corner is also the dearest corner, and the dearest corners are exactly
      // the ones where the option holder outbids the builder, so the city
      // systematically broke ground on the sites where building pencils least.
      //
      // It showed up from two directions at once. The sites the city started
      // had a median land value of $8.5M against a median firm cash balance of
      // $0.8M, so the street could not fund a single one of them and named
      // firms took 9 of 307 jobs in thirty years. And when `claimJob` was given
      // the pro forma test it had never had, it refused 99.7% of what it was
      // offered — correctly, because `landValue` exceeded what any builder
      // could bear on essentially every site being offered.
      //
      // A developer does not chase demand, it chases SURPLUS: what the finished
      // building is worth, less what it costs to build, less what the dirt
      // costs, and the last of those three is what demand had been standing in
      // for. `landRead` already computes both halves — the builder's residual
      // and the price the market is asking — so this is the existing model
      // being read rather than a new one being invented. Demand stays in the
      // expression through the residual, which is where it belongs: a better
      // corner earns more rent, and that is already why its residual is higher.
      // PER SQUARE FOOT, not per site. Scoring TOTAL surplus was tried first
      // and it selects for BIGNESS: surplus scales with lot area, so the
      // biggest lots win regardless of whether they are the best deals, and
      // the median site the city broke ground on went from $8.5M of land to
      // $32.8M. That is the same fault as scoring on demand, reached from the
      // other side. A developer comparing two sites compares the return on the
      // dirt, which is scale-free, and then the firm-size filters in
      // `claimJob` decide who can actually carry the job.
      const read = landRead(rec, s.econ);
      const score = read.builder - read.psf + rng(s, "dev") * 12;
      if (score > bestScore) { bestScore = score; best = { bbl, rec }; }
    }
    if (!best) continue;
    const { bbl, rec } = best;
    const dNow = demandNow(s, rec);
    let use = useForZone(rec.zoneDist, dNow, rng(s, "dev"), s.econ);
    // A corner that carries twenty floors does not get a two-storey shop on
    // it: it gets shops at grade with something above them.
    if (use === "retail" && retailWantsMixed(rec)) use = "mixed";
    const cmix = devMix(use);
    const lead = dominantOf(cmix);
    // Preserve the established RNG draw count while retiring the duplicate
    // classAppetite verdict. The order book has already passed the class-level
    // pro forma; the actual parcel gets the full shared underwriting below.
    const formerAppetiteRoll = rng(s, "dev");
    void formerAppetiteRoll;

    const farMax = farMaxFor(rec);
    // young town builds small; a mature one builds to the envelope
    const frac = Math.min(0.95, 0.22 + 0.45 * maturity + 0.3 * (dNow / 100) * maturity + rng(s, "dev") * 0.15);
    let sf = Math.max(3000, Math.round((rec.lotArea * farMax * frac) / 100) * 100);
    let floors = Math.max(1, Math.round(sf / (rec.lotArea * 0.62)));
    // THE CITY BUILDS TO ITS OWN CORNICE LINE. Sized off the envelope alone, a
    // three-storey town broke ground at a median of fifteen floors. The datum
    // cap is what makes twenty years of growth read like twenty years.
    const infill = cityInfillCap(s, parcels, rec, maturity, lead);
    if (floors > infill) {
      floors = infill;
      sf = Math.max(3000, Math.round((rec.lotArea * 0.62 * floors) / 100) * 100);
    }
    // …and where it IS a shop, it is two storeys, with the area cut to match
    // rather than the same square footage squeezed into a taller-than-legal
    // plate. Capping floors alone would have kept the absurd density.
    const cap = MAX_FLOORS_BY_USE[use];
    if (cap !== undefined && floors > cap) {
      floors = cap;
      sf = Math.max(3000, Math.round((rec.lotArea * 0.62 * floors) / 100) * 100);
    }
    // THE ACTUAL SITE GETS THE ACTUAL DESK. Same rent, vacancy, cost, land,
    // financing, lease-up reserve, NOI and required margin the player sees.
    const underwriting = underwriteDevelopment(s, parcels, bbl, use, floors, 0.62);
    if (!underwriting?.clears) continue;
    const plan = underwriting.plan;
    sf = plan.sf;
    floors = plan.floors;
    const prog = plan.mix;
    // Preserve the old duration draw count. Duration itself now comes from the
    // same massing/schedule calculation as the player's project.
    const formerDurationRoll = rng(s, "dev");
    void formerDurationRoll;
    const months = plan.months;
    const deliverM = s.month + months;
    s.cityJobs.push({ bbl, use, sf, floors, startM: s.month, deliverM, mix: prog });
    noteRecordPlan(s, parcels, bbl, lead, sf, floors, "The city");

    // Into the pipeline the day the hole is dug: the Economy page's delivery
    // schedule and forward vacancy are reading this queue, so what is coming
    // is visible for years before it lands.
    const cityProgramme = programmeSf(sf, prog);
    queueSupplyProject(s, {
      bbl,
      source: "city",
      deliverM,
      sfByUse: cityProgramme,
    });
    for (const [u, usf] of Object.entries(cityProgramme)) {
      // and the market's order is that much closer to filled
      if (s.econ.startOwed) {
        s.econ.startOwed[u as BuiltClass] = Math.max(0, (s.econ.startOwed[u as BuiltClass] ?? 0) - usf);
      }
    }

    // Before it is anonymous, it is offered to the street. A developer with
    // the dry powder buys the dirt and puts their name on the crane; if
    // nobody takes it, the city builds it the way it always did.
    const nearPlayer = (adjacency?.[bbl] ?? []).some((a) => !!s.holdings[a]);
    const claimed = claimJob(s, parcels, bbl, use, sf, floors, deliverM, nearPlayer, plan);
    // ANONYMOUS IS NOT FREE. Named firms already stamp cost/equity/commitment
    // in claimJob. An unclaimed job used to deliver on schedule with no capital
    // at all — the largest remaining competitor asymmetry. Stamp the same
    // underwriting ledger; fundJobs draws it from the city construction pool.
    if (!claimed) {
      const job = (s.cityJobs ?? []).find((j) => j.bbl === bbl);
      if (job && !(job.cost ?? 0)) {
        job.cost = plan.costTotal;
        job.spent = 0;
        job.equityLeft = Math.round(plan.costTotal * (1 - plan.ltc));
        job.commitment = plan.commitment;
        job.ratePct = plan.ratePct;
        job.lender = "Merchant builders";
      }
    }
    recordPropertyEvent(s, bbl, {
      kind: "build-start",
      use,
      sf,
      floors,
      party: claimed?.name ?? "The city",
    });
    if (!claimed && rng(s, "dev") < 0.4) {
      s.news.unshift({
        q: s.month, kind: "info",
        text: `Ground broken at ${rec.address} — ${(sf / 1000).toFixed(0)}k sf of ${use}, due ${monthLabel(deliverM)}.`,
      });
    }
  }
}

export function bumpLand(s: GameState, bbl: string, mult: number) {
  s.landAdj[bbl] = Math.min(4, (s.landAdj[bbl] ?? 1) * mult);
}

/**
 * HOW SMALL AND HOW LARGE A SPACE CAN BE.
 *
 * Setting the unit count is a real programming decision and it has physical
 * bounds. You cannot put ten shops in three thousand square feet — a shop
 * needs frontage, a lavatory, a back of house and a door onto the street, and
 * two thousand feet is the floor for any commercial tenancy. Nor can you sell a single
 * "unit" that is an entire two-hundred-thousand-foot tower and call it a
 * building of one: at the top end you are describing a single-tenant
 * headquarters, which is a real product and a rare one.
 *
 * Flats are the tightest band in the book, because a flat is a flat: a studio
 * is about four hundred and fifty feet and anything past two thousand is a
 * penthouse, not a unit type you programme a whole building around.
 */
export const SUITE_BOUNDS: Record<BuiltClass, { min: number; max: number; typical: number }> = {
  // 2,000 sf is the floor for any commercial tenancy — see COMMERCIAL_SUITE_MIN
  // in leasing.ts. Below it you are describing a kiosk or a serviced desk.
  office:      { min: 2_000, max: 60_000,  typical: 4_500 },
  retail:      { min: 2_000, max: 30_000,  typical: 3_200 },
  industrial:  { min: 5_000, max: 200_000, typical: 25_000 },
  multifamily: { min: 450,   max: 2_200,   typical: 850 },
};

/** The legal range of unit counts for a given amount of floor area in a use. */
export function unitRange(useSfArea: number, use: BuiltClass): { min: number; max: number; typical: number } {
  const b = SUITE_BOUNDS[use];
  const sfArea = Math.max(0, useSfArea);
  return {
    min: Math.max(1, Math.floor(sfArea / b.max)),
    max: Math.max(1, Math.floor(sfArea / b.min)),
    typical: Math.max(1, Math.round(sfArea / b.typical)),
  };
}

/**
 * A unit count, turned back into the sf-per-space the engine actually uses,
 * clamped to what is physically possible.
 */
export function suiteSfForUnits(useSfArea: number, use: BuiltClass, units: number): number {
  const b = SUITE_BOUNDS[use];
  const r = unitRange(useSfArea, use);
  const n = Math.max(r.min, Math.min(r.max, Math.round(units)));
  return Math.max(b.min, Math.min(b.max, Math.round(useSfArea / Math.max(1, n))));
}
