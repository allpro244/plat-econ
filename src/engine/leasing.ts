// Leasing: named tenants, inbound LOIs scaled by demand and the cycle,
// counters, TI/LC signing costs, renewals where the incumbent weighs the
// market against moving costs, and rollover risk that clusters.
// Multifamily skips all of this and runs aggregate occupancy.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { Approach, BuiltClass, Credit, GameState, Holding, Listing, LOI, Sector } from "./types";
import { logBooks, monthLabel, CAP_PLAN_RATE, serviceSpec, planSpec, SVC_SPEED, SVC_START, SECTOR_CLASSES, START_YEAR, cloneState, CREDIT_LABEL } from "./types";
import type { Tenant } from "./types";
import { rng, rrange, NATURAL_VAC, vacancyPull, industryStress, industryPull, INDUSTRY_LABEL, noteTenantSfChange } from "./market";

const clampL = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
import { managedRentPsfYr, useRentPsfYr, useOccupancy, resolveRec, opexPsf, TAX_RATE, recoveryOf, demandLinear,
  condGrade, initialCondIdx, condCeiling, COND_DECAY, COND_WEAR_REF, CONDITION_RENT_MULT, ownedHoldingValue, demandIdx } from "./value";
import { blendBy, commercialShare, dominantUse, mixOf, uses, useSf } from "./mix";
import type { Recovery } from "./value";
import { drawLoc, locAvailable } from "./credit";
import { recordPropertyEvent } from "./history";

import { leasingOdds, drawRequirementSf, supportableOcc, staleDiscount } from "./absorption";
import { penJudgment, penNegotiation, pmTenantCareMult, rentMultFor } from "./staff";

/** 0..1, for the net-effective trade in the prospect draw. */
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * A stable 0..1 from a string, same avalanched FNV-1a as demand.ts. Used where
 * an event must be able to fire without drawing from the RNG — a draw here
 * would shift the leasing stream for every seed-pinned number downstream.
 */
function hashChance(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * What a lease of this class looks like when it is signed. Office in this
 * market is mostly full-service with a base-year stop; retail and industrial
 * are triple-net; a minority of everything is flat gross.
 */
function rollRecovery(s: GameState, cls: string): Recovery {
  const r = rng(s, "leasing");
  switch (cls) {
    case "retail":     return r < 0.86 ? "nnn" : r < 0.95 ? "base" : "gross";
    case "industrial": return r < 0.92 ? "nnn" : "base";
    case "office":     return r < 0.30 ? "nnn" : r < 0.88 ? "base" : "gross";
    default:           return r < 0.45 ? "nnn" : r < 0.86 ? "base" : "gross";
  }
}

/** The expense level frozen into a base-year lease on the day it is signed. */
function stopPsfNow(rec: ParcelRecord, econ: GameState["econ"], h: Holding, use?: BuiltClass): number {
  const tax = (h.assessed ?? h.costBasis) * TAX_RATE / Math.max(1, rec.bldgArea);
  const sys = h.programsDone?.systems !== undefined;
  // A shop and an office in the same building do not have the same expense
  // stop — their expense loads are not the same and never were.
  const op = use ? opexPsf(use, econ, sys, h.service) : blendBy(rec, (u) => opexPsf(u, econ, sys, h.service));
  return op + tax;
}

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M`
  : n >= 10_000 ? `$${Math.round(n / 1000)}K`
  : `$${Math.round(n).toLocaleString()}`;

const POOL: Record<Sector, string[]> = {
  finance: ["Meridian Capital", "Harborline Securities", "Crown & Weir", "Bellamy Fund Group", "Quayside Partners"],
  law: ["Ashe & Porter LLP", "Calder Marsh", "Winslow Legal", "Tern & Rigging", "Foundry Law Group"],
  tech: ["Brightwater Systems", "Ledgerworks", "Spindrift Labs", "Cordage Software", "Beacon Analytics"],
  media: ["The Alden Ledger", "Harborcast Studios", "Gullwing Press", "Northside Signal"],
  insurance: ["Maritime Mutual", "Anchor Assurance", "Seawall Underwriters", "Garland Indemnity"],
  logistics: ["Freightline Co.", "Slipway Cargo", "Gantry Freight", "Blue Hull Shipping"],
  apparel: ["Tidewater Trading Co.", "Rowan Thread Works", "Salt & Selvedge", "Customs House Outfitters"],
  food: ["The Chandler Room", "Bell Slip Provisions", "Kiln Street Roasters", "Founders Market Hall"],
  medical: ["Harbor Medical Group", "Northside Clinic", "Beacon Dental", "Alden Diagnostics"],
  design: ["Marsh & Vane Architects", "Cooper Lane Studio", "Pier Four Design", "Whitlow Drafting"],
};

/**
 * WHO IS ACTUALLY LOOKING FOR SPACE.
 *
 * Not a uniform draw across the trades that can use this class. A booming
 * industry is expanding and touring; one in a bust is handing space back, not
 * taking it. So the mix of prospects at your door tilts toward whoever is
 * hiring — which is also how a landlord ends up concentrated without ever
 * deciding to be.
 */
function pickSector(s: GameState, cls: string): Sector {
  // One partition, shared with the swan side — see SECTOR_CLASSES in types.ts.
  const arr = SECTOR_CLASSES[cls as BuiltClass] ?? SECTOR_CLASSES.office!;
  const w = arr.map((k) => industryPull(s.econ, k));
  let roll = rng(s, "leasing") * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) { roll -= w[i]; if (roll <= 0) return arr[i]; }
  return arr[arr.length - 1];
}
function pickName(s: GameState, sector: Sector): string {
  const arr = POOL[sector];
  return arr[Math.floor(rng(s, "leasing") * arr.length) % arr.length];
}
function rollCredit(s: GameState, demand: number): Credit {
  const r = rng(s, "leasing") + demand / 250;
  return r > 0.95 ? 2 : r > 0.55 ? 1 : 0;
}

export function isCommercial(rec: ParcelRecord): boolean {
  // A block of flats with shops underneath has a commercial rent roll. It also
  // has apartments. Both are true, and the building is managed as both.
  return rec.class !== "land" && commercialShare(rec) > 0.02;
}

/** The commercial part of a building: the square feet with named tenants. */
export function commercialSf(rec: ParcelRecord): number {
  return (rec.bldgArea || 0) * commercialShare(rec);
}

/** Which uses in this building lease to named tenants. */
export function leasableUses(rec: ParcelRecord): BuiltClass[] {
  return uses(rec).filter((u) => u !== "multifamily");
}

// ---------------------------------------------------------------- the stack
// A building is not an undivided pile of square feet — it is a fixed number of
// leasable spaces, and that number is the thing a landlord actually manages.
// Everything downstream (the rent roll, inbound LOIs, occupancy on the
// portfolio) is expressed in whole suites, so "3 of 4 leased" is the truth
// rather than a rounding of some square-foot ratio.
//
// Typical suite by class, in sf. Bigger buildings get bigger suites — a
// 400,000 sf tower does not lease in 2,000 ft bites — but never so big that a
// tower becomes a single unit.
/** The smallest space anybody will take on a commercial lease here. */
export const COMMERCIAL_SUITE_MIN = 2_000;

export function useSuiteSf(rec: ParcelRecord, use: BuiltClass): number {
  // A building you programmed yourself is cut the way you cut it.
  const chosen = rec.suites?.[use as Exclude<BuiltClass, "land">];
  if (chosen && chosen > 0) return chosen;
  // Sized off the COMPONENT, not the building. Ground-floor retail under a
  // tower demises into shops, not into floors — sizing it off the tower gave
  // a 400,000 sf building 30,000 sf "shops", which is a department store.
  const a = Math.max(1, useSf(rec, use) || rec.bldgArea);
  switch (use) {
    case "multifamily": return 900;                                    // an apartment
    case "industrial":  return Math.max(12_000, Math.min(90_000, a / 2.2));
    // TWO THOUSAND FEET IS THE FLOOR FOR A COMMERCIAL TENANCY.
    //
    // Shops were demising to 1,400 and offices to 2,500, which produced towers
    // cut into forty tiny suites and a rent roll that read like a market stall.
    // Below about two thousand feet a commercial tenancy is not an asset —
    // it is a serviced office or a kiosk, and neither is what this game is
    // about. Flats keep their own floor, because a flat is a flat.
    case "retail":      return Math.max(Math.min(COMMERCIAL_SUITE_MIN, a), Math.min(14_000, a / 6));
    // ...AND TWENTY-EIGHT THOUSAND WAS THE WRONG CEILING AT THE OTHER END.
    //
    // The cap binds on everything sizeable: any office building over about
    // 340,000 sf could only be cut into 28,000 ft blocks, so a tower had no
    // small tenants at all. Measured on a 614,000 sf delivery, that is what
    // made a huge new building fill in fourteen leases averaging 36,000 ft and
    // reach 80% let inside two years — a whale-only rent roll and a lease-up
    // no real tower has ever had. Fifteen thousand is a large suite, not an
    // anchor floor: the same tower now needs the better part of thirty deals
    // and three to four years, which is what leasing a tower actually costs
    // and most of why merchant development is supposed to be frightening.
    default:            return Math.max(Math.min(COMMERCIAL_SUITE_MIN, a), Math.min(15_000, a / 12));  // office
  }
}

/**
 * THE SMALLEST SPACE THAT IS A TENANCY IN THIS BUILDING — which is not the
 * same number as the smallest space that is a tenancy in this CITY.
 *
 * `COMMERCIAL_SUITE_MIN` was doing both jobs and they are different quantities.
 * As a demise floor it is right: a tower cut into 1,400 ft suites is a market
 * stall, and that is the fault it was raised to fix. As a LETTABILITY floor it
 * condemned every building smaller than itself — a 1,634 ft office building or
 * a 1,397 ft shop at grade has no space above the floor, so `toSuites` refused
 * to place a tenant in it, and refused for ever.
 *
 * Measured on the shipped island: 203 of 739 commercial legs — 27% of every
 * shopfront and small office in the city — could not have a tenant in any
 * generated roll, in any year. That is a permanent, invisible drag on citywide
 * occupancy, on rent, on the demand surface that counts occupied feet, and on
 * the land under all of it.
 *
 * A shop is the size of the shop. So the floor is the market norm capped by
 * what the building actually is: a whole leg is always lettable, a REMNANT of
 * a bigger leg still has to clear the norm. That is what a floor is for.
 */
export function minTenancySf(rec: ParcelRecord, use: BuiltClass): number {
  if (use === "multifamily") return 450;
  // FLOORED, and it matters. Square footages here are floats — a 37.66% retail
  // share of 3,710 ft is 1,397.186 — while a lease is signed in whole feet. A
  // floor of 1,397.186 against a demise that rounds to 1,397 fails by a fifth
  // of a square foot, and the shop stays dark for the length of the game.
  return Math.floor(Math.min(COMMERCIAL_SUITE_MIN, useSuiteSf(rec, use)));
}
/** The building's headline suite size — its dominant leasable use. */
export function suiteSf(rec: ParcelRecord): number {
  return useSuiteSf(rec, leasableUses(rec)[0] ?? dominantUse(rec));
}

/**
 * THE AVERAGE FLAT, in square feet.
 *
 * Neither the demise above nor `rec.unitsRes`, and it is worth saying why. The
 * demise is what the building is cut TO; the flat count is that demise rounded
 * to a whole number of apartments, and the flats then occupy the whole
 * residential leg between them — so the average is the leg over the count, and
 * the rounding is the entire difference. Measured across the 522 buildings in
 * New Alden carrying a residential leg, 509 of them land more than a foot off
 * the 900-foot demise, running 840 to 973 feet at the fifth and ninety-fifth
 * percentiles and as low as 706 on a leg small enough that two flats is the
 * whole of it.
 *
 * `unitsRes` is the assessor's count and implies about a thousand feet a flat.
 * Nothing in this engine leases against it — the rent roll, the occupancy and
 * the vacancy on the same screen are all counted off the demise — so printing
 * it would put a number on the record that no other number on the record
 * agrees with.
 */
export function avgUnitSf(rec: ParcelRecord): number {
  const area = useSf(rec, "multifamily");
  if (area <= 0) return 0;
  return area / Math.max(1, Math.round(area / useSuiteSf(rec, "multifamily")));
}

// How many leasable spaces the building holds.
export function unitCount(rec: ParcelRecord): number {
  if (!rec.bldgArea) return 0;
  // The sum of the parts. A block of flats over shops has apartments AND
  // shops, and dividing the whole building by one suite size counted neither.
  let n = 0;
  for (const u of uses(rec)) {
    const sf = useSf(rec, u);
    if (sf <= 0) continue;
    n += Math.max(1, Math.round(sf / useSuiteSf(rec, u)));
  }
  return Math.max(1, n);
}

// How many of them a given lease occupies.
export function unitsOf(rec: ParcelRecord, sf: number): number {
  return Math.max(1, Math.round(sf / suiteSf(rec)));
}

/** Leased / total spaces, and the sf behind each — the tenancy at a glance. */
export interface UnitRow { use: BuiltClass; total: number; leased: number; vacant: number; notReady: number; sfPer: number }

/** Leased / total spaces per use — a mixed building has more than one answer. */
export function unitStatusByUse(rec: ParcelRecord, h: Holding, month: number): UnitRow[] {
  const out: UnitRow[] = [];
  for (const use of uses(rec)) {
    const sf = useSf(rec, use);
    if (sf <= 0) continue;
    const sfPer = useSuiteSf(rec, use);
    const total = Math.max(1, Math.round(sf / sfPer));
    if (use === "multifamily") {
      const leased = Math.min(total, Math.round((h.occ ?? 0) * total));
      out.push({ use, total, leased, vacant: total - leased, notReady: 0, sfPer });
      continue;
    }
    const leasedSf = h.tenants.filter((t) => (t.use ?? dominantUse(rec)) === use).reduce((n, t) => n + t.sf, 0);
    const leased = Math.min(total, Math.max(leasedSf > 0 ? 1 : 0, Math.round(leasedSf / sfPer)));
    // WHAT IS TURNING IN THIS LEG, ASKED DIRECTLY.
    //
    // This used to take the WHOLE building's make-ready and apportion it across
    // the commercial legs by floor area — while `notReadySf` has always been
    // able to answer per use. Measured over 827 rows sampled while something
    // was turning, the apportioned figure was wrong on 47.4% of them, and the
    // error lands hardest on retail because a retail leg is small: one case
    // showed 1,455 sf of a 4,036 sf shop front as "turning" when NOT ONE FOOT
    // of retail was. That is office space upstairs, smeared onto the shops.
    //
    // The consequence is the one a player reports as a bug in leasing: `vacant`
    // is `total - leased - nr`, so an inflated `nr` eats the row. You sign a
    // shop, the space is genuinely let, and the panel still shows the suite as
    // unavailable — the tenant moved in and the UI could not find them.
    const nr = Math.min(Math.max(0, total - leased), Math.round(notReadySf(h, month, use) / sfPer));
    out.push({ use, total, leased, vacant: Math.max(0, total - leased - nr), notReady: nr, sfPer });
  }
  return out;
}

export function unitStatus(rec: ParcelRecord, h: Holding, month: number): {
  total: number; leased: number; vacant: number; notReady: number; sfPer: number; byUse: UnitRow[];
} {
  const byUse = unitStatusByUse(rec, h, month);
  const sum = (f: (r: UnitRow) => number) => byUse.reduce((a, r) => a + f(r), 0);
  const total = sum((r) => r.total);
  return {
    total, leased: sum((r) => r.leased), vacant: sum((r) => r.vacant),
    notReady: sum((r) => r.notReady), sfPer: suiteSf(rec), byUse,
  };
}

/**
 * Round a requested area to whole suites, bounded by what is actually free.
 *
 * The remainder matters. A building with one and a half suites empty must
 * still be able to let the half — demising a suite is ordinary, and refusing
 * to means a building can never lease its last ten per cent and sits at 91%
 * occupancy for a century.
 */
function toSuites(rec: ParcelRecord, want: number, cap: number, use?: BuiltClass): number {
  const sfPer = use ? useSuiteSf(rec, use) : suiteSf(rec);
  // Flats have their own floor — 450 ft is a studio, not a closet. And a
  // building smaller than the market's smallest suite is not unlettable, it is
  // a small building: see minTenancySf.
  const floor = minTenancySf(rec, use ?? dominantUse(rec));
  const maxUnits = Math.floor(cap / sfPer + 0.02);
  // A REMNANT UNDER THE FLOOR IS NOT SPACE. This read
  // `Math.min(PART_SUITE_MIN, sfPer * 0.35)`, and the Math.min quietly
  // collapsed the 2,000 ft floor to 700 the moment the demise was already at
  // the floor — which is most small commercial buildings. Thirty per cent of
  // every inherited rent roll came out below the minimum because of it. A
  // sliver nobody will lease stays vacant; that is what a floor means.
  if (maxUnits < 1) return cap >= floor ? Math.round(cap) : 0;
  const n = Math.max(1, Math.min(maxUnits, Math.round(want / sfPer)));
  const taken = n * sfPer;
  // if letting whole suites would strand an unlettable sliver, take it too
  const left = cap - taken;
  // ...and never more than there is. The 0.02 slop above absorbs float error
  // when the space divides evenly, but it can also round a whole suite up past
  // what is actually vacant — which let buildings sign leases for a few dozen
  // square feet they did not have.
  const out = Math.min(Math.floor(cap), Math.round(left > 0 && left < Math.min(floor, sfPer * 0.35) ? cap : taken));
  // The 0.02 slop can allow a whole suite when the vacancy is a couple of per
  // cent short of one, and the clamp above then trims it back BELOW the floor.
  // That is where the last handful of 1,960 ft offices were coming from.
  return out >= floor ? out : 0;
}

// In-place rent roll at acquisition. Expirations cluster around a couple of
// anchor years — a building with everything rolling at once is a visibly
// riskier asset, and that's the point.
/**
 * THE DISCOUNT HAS TO BUY SOMETHING BROKEN.
 *
 * A distressed listing hit the tape at 72-90% of appraisal and then handed the
 * buyer a rent roll at market occupancy: the discount priced the seller's
 * urgency and the asset carried no corresponding impairment. Measured with a
 * flipper bot over 30 years x 3 seeds: 272 completed flips, median entry at
 * 0.76x appraisal, exit at 1.01x, and 117% of gross flip profit was entry
 * discount alone. That is an ATM, not a strategy.
 *
 * A receiver's building is cheap because the sponsor stopped leasing it a year
 * before he stopped paying, and stopped fixing it a year before that. So a
 * distressed deed now walks into the building that earned the discount: a
 * hole in the rent roll you must lease through this market's absorption
 * (4-166 months), on plant the last owner deferred. The discount is
 * compensation for work, and the 2-5x is earned over the years the work takes.
 */
/**
 * A BUILDING HAS ONE RENT ROLL, AND YOU CAN ALWAYS SEE IT BEFORE YOU BID.
 *
 * In this business nobody offers on a building without knowing the tenancy and
 * the NOI. Not on the tape, and not off-market either — an off-market offer is
 * made subject to diligence, the roll and the operating statements arrive, and
 * if they are not what you were told you retrade or you walk. There is real
 * information asymmetry in real estate and it is about the MARKET: what is
 * coming out of the ground, who else is bidding, what the block will do in ten
 * years. It is not about the subject property's own rent roll.
 *
 * So the roll is DETERMINISTIC PER BUILDING. Same seed, same parcel, same
 * roll — whenever it is asked for, by whichever path, however many times.
 * That makes "what the preview shows" and "what the deed conveys" the same
 * object by construction rather than by two code paths agreeing to be careful.
 *
 * It also closes a real hazard. ONE shared mulberry32 stream drives the whole
 * world (market.ts:15-19), and this function used to draw from it AT THE
 * MOMENT OF PURCHASE — so the century a player got depended on which buildings
 * they happened to buy and when. Rolls now draw from a private stream keyed on
 * the parcel, restored afterwards, and cost the shared stream nothing at all.
 *
 * @param settle  Whether the deposits move cash. TRUE at a closing, where the
 *   in-place deposits come across on the settlement statement. FALSE for a
 *   PREVIEW — that building is not yours, nobody has settled anything, and
 *   crediting the player for deposits on somebody else's tenants is cash out
 *   of thin air. pnpm conserve caught exactly that: 42 months of 4,200.
 */
/**
 * STAMP A LISTING WITH THE ROLL THE DEED WILL CONVEY.
 *
 * Every path that puts a building on the market goes through here, and there
 * are eight of them: refreshListings, the courthouse, the package desk, and
 * five separate places in rivals.ts where a firm sells, is squeezed, or dies.
 * Only ONE of them used to write a roll, so a building that reached the tape
 * via a rival's distress arrived with no disclosed tenancy at all — and the
 * panel then showed a market estimate that the deed did not honour. Measured:
 * 36 of 200 purchases disagreed on NOI, and every one of them came in through
 * a path that was not refreshListings.
 *
 * Centralised so a ninth path cannot forget. Cheap to call: the roll is
 * deterministic per building and drawn from a private stream, so this costs
 * the shared world PRNG nothing.
 */
export function stampListing(s: GameState, rec: ParcelRecord, li: Listing): Listing {
  if (rec.class === "land" || !rec.bldgArea || li.roll) return li;
  const distress = !!li.distress;
  // The grade the deed will convey: today's grade, less the notch a distressed
  // building takes at the closing. See executePurchase.
  const cond = distress
    ? condGrade(Math.max(0.30, (initialCondIdx(rec, s.month) ?? 0.7) - 0.10))
    : condGrade(initialCondIdx(rec, s.month));
  const vessel = { bbl: li.bbl, boughtM: s.month, costBasis: li.ask, loan: null,
    condition: cond, tenants: [], cfHistory: [] } as unknown as Holding;
  genRentRoll(s, rec, vessel, distress, false);   // no closing, no settlement
  li.cond = cond;
  li.roll = vessel.tenants;
  if (vessel.occ !== undefined) li.occ = vessel.occ;
  return li;
}

/**
 * STAMP AN OFF-MARKET CONVERSATION WITH THE ROLL THE DEED WILL CONVEY.
 *
 * The twin of `stampListing`, and it exists because an off-market deal is not
 * a blind one. You ring the owner, they take the call, and the rent roll and
 * the trailing twelve cross the table before anybody talks about price — that
 * IS diligence, and no seller who actually wants to trade refuses to send them.
 *
 * The panel used to write this roll at PREVIEW time instead, which looked
 * identical and was not: `genRentRoll` reads `s.month` for every lease start
 * and expiry and `s.econ` for the target occupancy, so previewing a building
 * in month 40 and closing it in month 43 handed over different paper against
 * a different market. That is the same fault the listing path already fixed —
 * 39 of 200 purchases differed on occupancy there and 84 on NOI — and it was
 * still live on every door the player knocked on.
 *
 * A refusal is not stamped: there is no conversation, so there is nothing
 * disclosed. Cheap to call, for the same reason `stampListing` is: the roll is
 * deterministic per building and drawn from a private stream, so it costs the
 * shared world PRNG nothing.
 */
export function stampApproach(s: GameState, rec: ParcelRecord, a: Approach): Approach {
  if (a.refused) return a;
  if (rec.class === "land" || !rec.bldgArea) return a;
  if (a.roll !== undefined || a.occ !== undefined) return a;
  // Nobody is in receivership on an off-market call — that building would be
  // on the tape with a distress flag. This is an ordinary owner and an
  // ordinary roll, which is why the `distressed` reading is not used here.
  const cond = condGrade(initialCondIdx(rec, s.month));
  const vessel = { bbl: rec.bbl, boughtM: s.month, costBasis: a.ask ?? 0, loan: null,
    condition: cond, tenants: [], cfHistory: [] } as unknown as Holding;
  genRentRoll(s, rec, vessel, false, false);   // no closing, no settlement
  a.cond = cond;
  a.roll = vessel.tenants;
  if (vessel.occ !== undefined) a.occ = vessel.occ;
  return a;
}

/**
 * The sweep, so a path that opens a conversation cannot forget. `approachOwner`
 * and the broker's call stamp at the moment they write the record; this catches
 * the rest — rivals.ts rings the player about a corner they were beaten on, and
 * that record is written deep inside tickRivals. Same shape and same reasoning
 * as the listing sweep in sim.ts.
 */
export function stampApproaches(s: GameState, parcels: ParcelTable) {
  for (const [bbl, a] of Object.entries(s.approaches ?? {})) {
    if (a.refused || a.roll !== undefined || a.occ !== undefined) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (rec) stampApproach(s, rec, a);
  }
}

export function genRentRoll(s: GameState, rec: ParcelRecord, holding: Holding, distressed = false, settle = true) {
  // The private stream, keyed on the parcel and on whether this is the
  // distressed reading of it — a receiver's building is a different roll, and
  // it has to be a STABLE different roll.
  const saved = s.rng;
  let hsh = 2166136261 ^ (s.seed >>> 0);
  const key = rec.bbl + (distressed ? "#d" : "");
  for (let i = 0; i < key.length; i++) { hsh ^= key.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
  s.rng = hsh >>> 0;
  try {
    buildRentRoll(s, rec, holding, distressed, settle);
  } finally {
    s.rng = saved;
  }
}

function buildRentRoll(s: GameState, rec: ParcelRecord, holding: Holding, distressed: boolean, settle: boolean) {
  if (!rec.bldgArea) return;
  const m = mixOf(rec);
  if ((m.multifamily ?? 0) > 0) {
    // A STANDING BUILDING, NOT A NEW ONE — so it opens near its market and the
    // spread around it is small. The floor here was 0.35 and is 0.12: a
    // receiver's block of flats genuinely can be a tenth full, and refusing to
    // represent that is refusing to represent the only reason it is cheap.
    // It is not zero because a building with nobody in it at all is not a
    // going concern being sold, it is a shell — and that is a different deal.
    holding.occ = Math.min(0.99, Math.max(0.12,
      useOccupancy(rec, s.econ, "multifamily") + (distressed ? rrange(s, -0.38, -0.16, "leasing") : rrange(s, -0.05, 0.04, "leasing"))));
  }
  if (!isCommercial(rec)) return;
  // A building in place has a rent roll per component: the shops at grade were
  // let to shopkeepers at retail rents on retail terms, and the floors above
  // to firms at office rents. One blended roll described neither.
  const anchors = [
    s.month + Math.round(rrange(s, 9, 36, "leasing")),
    s.month + Math.round(rrange(s, 39, 90, "leasing")),
  ];
  for (const use of leasableUses(rec)) {
  const legSf = useSf(rec, use);
  if (legSf < 400) continue;
  // wider than the market model on the downside: a building coming to market
  // is disproportionately one with a leasing problem
  const targetOcc = Math.max(0, Math.min(0.98,
    useOccupancy(rec, s.econ, use) + (distressed ? rrange(s, -0.52, -0.24, "leasing") : rrange(s, -0.14, 0.05, "leasing"))));
  const market = useRentPsfYr(rec, s.econ, holding.condition, use);
  // A LEG THAT IS ONE SPACE IS LET, OR IT IS NOT.
  //
  // Nobody leases 88% of a single shop. Where the whole leg demises to one
  // suite — the bay under a walk-up, a small office building — the loop below
  // asked for 88% of it, could not fit a whole suite inside that, and left the
  // space EMPTY; and since neither the leg nor the demise ever changes, it
  // stayed empty for the length of the game.
  //
  // For an indivisible space the target occupancy is not a fraction of floor to
  // fill. It is the CHANCE that the space is let, which is what it always meant
  // — and it gives a small building the honest binary outcome a small building
  // has, instead of an average nothing in the class can actually be.
  const whole = legSf < useSuiteSf(rec, use) * 1.5;
  const target = whole ? (rng(s, "leasing") < targetOcc ? legSf : 0) : legSf * targetOcc;
  let leased = 0;
  let guard = 0;
  while (leased < target && guard++ < 40) {
    // whole suites only: a tenant takes one space, or knocks a few together
    const free = target - leased;
    const want = useSuiteSf(rec, use) * Math.max(1, Math.round(rrange(s, 1, use === "industrial" ? 1.6 : 2.8, "leasing")));
    const sf = toSuites(rec, want, free, use);
    if (!sf) break;
    const sector = pickSector(s, use);
    const endM = rng(s, "leasing") < 0.6
      ? anchors[Math.floor(rng(s, "leasing") * anchors.length) % anchors.length] + Math.round(rrange(s, -3, 3, "leasing"))
      : s.month + Math.round(rrange(s, 6, 96, "leasing"));
    holding.tenants.push({
      name: pickName(s, sector),
      use,
      sector,
      credit: rollCredit(s, demandLinear(rec.demandScore)),
      sf,
      rentPsf: +(market * rrange(s, 0.82, 1.04, "leasing")).toFixed(2),
      net: use === "office" ? rng(s, "leasing") < 0.75 : rng(s, "leasing") < 0.4,
      recovery: rollRecovery(s, use),
      // Signed in the past, so the stop is frozen at the cheaper expense level
      // of that year — the older the lease, the bigger the gap the owner eats.
      baseStopPsf: +(stopPsfNow(rec, s.econ, holding, use) * rrange(s, 0.72, 0.98, "leasing")).toFixed(2),
      startM: s.month - Math.round(rrange(s, 0, 48, "leasing")),
      endM: Math.max(s.month + 1, endM),
      // The in-place deposits come across on the settlement statement — cash
      // in, liability up, no effect on net worth. What it does mean is that
      // buying a fully let building hands you real money you will have to
      // give back, which is exactly how the closing works.
      deposit: depositFor(s, market, sf, rollCredit(s, demandLinear(rec.demandScore))),
    });
    if (settle) s.cash += holding.tenants[holding.tenants.length - 1].deposit ?? 0;
    leased += sf;
  }
  }
}

export function vacantSf(rec: ParcelRecord, h: Holding): number {
  // Only the commercial part. The flats upstairs are not vacant office space,
  // and counting them as such let a mixed building lease its own apartments to
  // a law firm.
  return Math.max(0, commercialSf(rec) - h.tenants.reduce((sum, t) => sum + t.sf, 0));
}

/**
 * Vacant square feet in one component of a building. Space a departing tenant
 * left is NOT available until it has been turned — letting it twice was how a
 * building came to have more square feet under lease than it had floors.
 */
export function useVacantSf(rec: ParcelRecord, h: Holding, use: BuiltClass, month?: number): number {
  const taken = h.tenants.filter((t) => (t.use ?? dominantUse(rec)) === use).reduce((n, t) => n + t.sf, 0);
  const turning = month === undefined ? 0 : notReadySf(h, month, use);
  return Math.max(0, useSf(rec, use) - taken - turning);
}

// Space a departing tenant just left isn't leasable on day one — it's in
// make-ready (demo, paint, systems, demising) for a few months.
export function notReadySf(h: Holding, month: number, use?: BuiltClass): number {
  // `(m.use ?? use) === use` was the old test, and for an entry with no `use`
  // recorded it reduces to `use === use` — TRUE for every use asked about. One
  // untagged floor in make-ready therefore blocked every leg in the building at
  // once. Every path that writes make-ready today copies the tenant's `use`
  // (see the three writers in this file), so nothing in a fresh game hits it —
  // but a save written before the field existed is full of untagged entries,
  // and the failure is silent and total.
  //
  // An entry whose use is unknown is not evidence about any PARTICULAR leg, so
  // a per-use question does not count it; the building-wide question (no `use`
  // argument) still does. That under-states one leg on a legacy save instead of
  // over-stating all of them, which is the safe direction for a number whose
  // job is to say "you cannot let this yet".
  return (h.makeReady ?? []).reduce(
    (sum, m) => sum + (m.readyM > month && (use === undefined || m.use === use) ? m.sf : 0),
    0,
  );
}

export const MAKE_READY_PSF = 3.9; // turn cost, $/sf before cost inflation

// Anchor pre-lease for a development: one large credit tenant signed before
// delivery, long paper at a small discount to market for taking the risk.
/**
 * The anchor who signed before there was a building. They took delivery risk
 * and they priced it — `discount` is what that cost you, and it is locked in
 * for a decade and a half.
 */
/** Place a construction pre-let onto the rent roll. Returns false when the
 *  space will not demise — callers must not treat silence as success. */
export function genAnchorTenant(
  s: GameState, rec: ParcelRecord, h: Holding, sfWanted: number, discount = 1, forUse?: BuiltClass,
): boolean {
  if (!isCommercial(rec)) return false;
  // An anchor pre-lets COMMERCIAL space. In a stacked building the flats above
  // are not part of the deal, and letting the anchor take the whole building
  // put more square feet under lease than the building had.
  const use = (forUse && leasableUses(rec).includes(forUse) ? forUse : leasableUses(rec)[0]) ?? "office";
  const sfAnchor = Math.min(sfWanted, useVacantSf(rec, h, use, s.month));
  // The same floor every other tenancy obeys. This said 1,000 while the rest
  // of the engine says a commercial tenancy under 2,000 ft is not one — and
  // the invariant sweep caught a 1,634 ft anchor signed at a delivery.
  if (sfAnchor < minTenancySf(rec, use)) return false;
  const sector = pickSector(s, use);
  const market = useRentPsfYr(rec, s.econ, h.condition, use) * discount;
  h.tenants.push({
    name: pickName(s, sector),
    use,
    sector,
    credit: rng(s, "leasing") > 0.4 ? 2 : 1, // anchors are credit tenants
    sf: Math.round(sfAnchor),
    rentPsf: +(market * rrange(s, 0.9, 0.97, "leasing")).toFixed(2),
    net: true,
    recovery: "nnn",
    startM: s.month,
    endM: s.month + Math.round(rrange(s, 120, 180, "leasing")),
  });
  return true;
}

export function walt(h: Holding, q: number): number {
  const tot = h.tenants.reduce((sum, t) => sum + t.sf, 0);
  if (!tot) return 0;
  return h.tenants.reduce((sum, t) => sum + ((t.endM - q) / 12) * t.sf, 0) / tot;
}

/**
 * TENANT IMPROVEMENT, IN DOLLARS PER SQUARE FOOT PER YEAR OF TERM.
 *
 * This was a flat total-dollar band, and the level it produced was broadly
 * right — office asks averaged $37.50/sf against a real US range of $25-90.
 * The SHAPE was backwards. A fit-out is amortised across the lease, so a
 * three-year tenant gets paint and carpet and a twelve-year one gets a real
 * build-out; handing both the same total meant the short deal cost 10.5% of
 * its own lease value and the long one 5.3%. The landlord was paying most for
 * the tenants who were worth least.
 *
 * Per year of term, the arithmetic comes out at roughly 6-7% of lease value
 * across every term length, which is what a leasing agent would recognise.
 */
export const TI_ASK: Record<string, [number, number]> = {
  office: [2.6, 6.0], retail: [1.0, 2.9], industrial: [0.30, 0.95], multifamily: [0, 0.4],
};

/**
 * HOW HARD A TENANT CAN PUSH, from the state of the market they are in.
 *
 * Concessions used to key off the phase LABEL alone — 0.7 in an expansion,
 * 1.85 in a recession — which meant a class sitting at four per cent vacancy
 * in the middle of a boom still asked for half a year of free rent, because
 * the label said "expansion" and the label knew nothing about that class.
 *
 * Free rent and fit-out are the first things to move when a market turns and
 * they move long before face rents do, so they belong on the vacancy gap for
 * the tenant's OWN class. Below natural, a tenant takes what is offered and is
 * glad of it; a few points above, the landlord is buying the deal.
 *
 * Returns a multiplier on the asking concession: ~0.25 in a genuine squeeze,
 * 1 at natural, ~2.1 in a glut.
 */
export function concessionPressure(e: GameState["econ"], use: string): number {
  // ONE SOURCE OF TRUTH (ECONOMY.md): the market tick maintains the
  // concession dial (concIdx, chased at 0.25/mo off the vacancy gap and the
  // phase), the effective rent index is asking x (1 - 0.14 x concIdx), and
  // this function maps the SAME dial onto its historical 0.22..2.1 output
  // range — so the LOI terms, the tour depth, and the Economy tab can never
  // disagree about how much a tenant can extract this month.
  const k = (use === "office" || use === "retail" || use === "multifamily" || use === "industrial" ? use : "office") as keyof typeof NATURAL_VAC;
  const c = e.concIdx?.[k];
  if (c !== undefined) return 0.22 + 1.88 * c;
  const gap = (e.cityVac?.[k] ?? NATURAL_VAC[k]) - NATURAL_VAC[k];
  const phase = e.phase === "recession" ? 0.22 : e.phase === "depression" ? 0.16
    : e.phase === "recovery" ? 0.08 : e.phase === "peak" ? -0.04 : -0.10;
  return Math.max(0.22, Math.min(2.1, 1 + gap * 11 + phase));
}

/**
 * HOW FAR THE FIT-OUT MONEY MOVES WITH THE MARKET, which is not as far as
 * free rent does.
 *
 * Free rent doubles in a glut because it costs the landlord nothing today. A
 * fit-out is a construction cost, and the contractor has not heard about the
 * vacancy rate. What actually moves is how much of it the landlord funds
 * rather than the tenant — a much flatter curve. 2.10 becomes 1.55, 0.22
 * becomes 0.40, and 1.00 stays 1.00.
 */
export function tiPressure(concession: number): number {
  return Math.pow(Math.max(0.01, concession), 0.6);
}

/**
 * WHETHER THEY STAY, AND WHY.
 *
 * The renewal gate was one line — `rng(s, "leasing") < industryStress * 0.55` — and
 * industryStress is zero most of the time, so measured over four fifty-year
 * runs a renewal letter arrived essentially every time a lease rolled. 71% of
 * tenants renewed and the other 29% were the player declining. Nothing the
 * owner did to the building had any bearing on whether its tenants stayed,
 * which is the single largest thing an operator actually controls.
 *
 * Every term here is something the player has decided or can read: how the
 * building is run, what state it is in, whether they are over market, what
 * their own trade is doing, whether the space still fits them, their covenant,
 * and how long they have been sitting there. `why` is sorted by how much each
 * one hurt, so the news line and the rent roll can both name the real reason.
 *
 * Neutral settings on an ordinary building land at the 0.96 ceiling, which is
 * where this engine already was — the whole spread is downside, and it is
 * earned.
 */
export interface RenewalRead { p: number; why: string[] }
export function renewalIntent(s: GameState, rec: ParcelRecord, h: Holding, t: Tenant): RenewalRead {
  const svc = h.svcIdx ?? SVC_START;
  const cond = h.condIdx ?? 0.6;
  const use = t.use ?? (rec.class as BuiltClass);
  const market = Math.max(1, managedRentPsfYr(rec, s.econ, h, use));
  const over = t.rentPsf / market;
  const stress = industryStress(s.econ, t.sector);
  const boom = Math.max(0, s.econ.industryMom?.[t.sector] ?? 0);
  const need = t.sf * (t.staff ?? 1);
  const free = useVacantSf(rec, h, use, s.month);
  const fSvc = 0.74 + 0.48 * svc;
  const fCond = 0.84 + 0.30 * cond;
  const fRent = over > 1.12 ? 0.74 : over > 1.04 ? 0.88 : over < 0.88 ? 1.10 : 1;
  const fInd = clampL(1 - stress * 0.55 + boom * 5, 0.45, 1.15);
  const fFit = need > t.sf * 1.30 ? (free > COMMERCIAL_SUITE_MIN ? 0.86 : 0.55)
    : need < t.sf * 0.78 ? 0.88 : 1;
  const fCred = t.credit === 2 ? 1.06 : t.credit === 0 ? 0.94 : 1;
  const fTen = 1 + 0.05 * Math.min(2, (s.month - t.startM) / 120);
  // Location works on the way OUT as well as the way in. A tenant in a prime
  // building has nowhere better to go; a tenant on the fringe is one broker
  // lunch away from a nicer address, and every roll of their lease is a chance
  // to take it. This is what holds a fringe building's equilibrium occupancy
  // in the high-70s instead of letting it grind to full over a decade.
  const fLoc = clampL(0.88 + 0.20 * demandIdx(rec.demandScore), 0.88, 1.08);
  // AND A BUILDING CANNOT HOLD MORE THAN ITS CORNER SUPPORTS.
  //
  // supportableOcc caps who will MOVE IN; on its own that is only half an
  // equilibrium, and the acceptance run proved it — gated on arrivals alone
  // the worst corner in town still ground its way to 92% over twelve years,
  // one expansion and one renewal at a time, because nothing ever pushed back.
  // An equilibrium needs both sides: a building sitting above what its address
  // supports is holding tenants it did not really win, and it loses them at
  // the roll. That is what the number means — the occupancy where the people
  // arriving and the people leaving finally balance.
  const legSf = useSf(rec, use);
  const occNow = legSf > 0
    ? h.tenants.reduce((a, x) => a + ((x.use ?? rec.class) === use ? x.sf : 0), 0) / legSf
    : 0;
  const stretched = occNow - supportableOcc(s.econ, rec, use);
  const fFull = stretched > 0 ? clampL(1 - 1.7 * stretched, 0.55, 1) : 1;
  // THE RENEWAL REMEMBERS THE RELIEF LETTER. A tenant who asked for help and
  // was refused — or ignored — spends the rest of the term knowing exactly
  // who holds the paper over them, and when it finally rolls they take the
  // meeting across town first. Two years of memory, like the strain itself.
  const fStrain = t.strainedM !== undefined && s.month - t.strainedM < 24 ? 0.72 : 1;
  const why: { s: string; w: number }[] = [];
  if (fFull < 0.97) why.push({ s: "this address was always a reach for them", w: 1 - fFull });
  if (fStrain < 1) why.push({ s: "you turned them down when they asked for relief, and they did not forget", w: 1 - fStrain });
  if (fSvc < 0.95) why.push({ s: "the building is not being run to their standard", w: 1 - fSvc });
  if (fSvc > 1.10) why.push({ s: "they like the way the building is run", w: fSvc - 1 });
  if (fCond < 0.98) why.push({ s: `the plant is ${h.condition}`, w: 1 - fCond });
  if (fRent < 1) why.push({ s: `they are ${Math.round((over - 1) * 100)}% over market`, w: 1 - fRent });
  if (fInd < 0.95) why.push({ s: `${INDUSTRY_LABEL[t.sector].toLowerCase()} is contracting`, w: 1 - fInd });
  if (fFit < 0.95) why.push({ s: need > t.sf ? "they have outgrown the space and there is nothing to give them" : "they are paying for space they no longer use", w: 1 - fFit });
  if (fLoc < 0.97) why.push({ s: "a better building across town made them an offer", w: 1 - fLoc });
  why.sort((a, b) => b.w - a.w);
  let p = clampL(0.94 * fSvc * fCond * fRent * fInd * fFit * fCred * fTen * fLoc, 0.10, 0.96);
  const pBefore = p;
  const renewMult = s.holdings[rec.bbl]?.pmRenewalMult ?? s.pmRenewalMult ?? 1;
  const careMult = pmTenantCareMult(s, rec.bbl);
  p = clampL(p * renewMult * careMult, 0.10, 0.96);
  const whyLines = why.length ? why.map((x) => x.s) : ["they simply moved"];
  if (renewMult < 0.98 && p < pBefore - 0.03) {
    whyLines.push("renewals are slipping — the PM desk is behind");
  }
  if (careMult < 0.96 && p < pBefore - 0.03) {
    whyLines.push("tenant relationships are fraying at this building");
  }
  return { p, why: whyLines };
}

/** A plausible building the departing tenant is moving to, or null for "left town". */
function departureDestination(s: GameState, parcels: ParcelTable, from: ParcelRecord, use: BuiltClass): string | null {
  const live = (s.rivals ?? []).filter((r) => r.failedM === undefined && r.bbls.length);
  // sample a handful of candidates rather than scanning every deed in town
  for (let tries = 0; tries < 14 && live.length; tries++) {
    const r = live[Math.floor(rng(s, "leasing") * live.length) % live.length];
    const bbl = r.bbls[Math.floor(rng(s, "leasing") * r.bbls.length) % r.bbls.length];
    if (bbl === from.bbl) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec || rec.class !== use || !rec.bldgArea) continue;
    return `${rec.address} — ${r.name}'s building`;
  }
  // a third of unmatched departures leave the market entirely; the rest go
  // somewhere too small to name, and saying nothing is better than inventing
  return rng(s, "leasing") < 0.35 ? "smaller space outside the city" : null;
}

export function tickLeasing(s: GameState, parcels: ParcelTable) {
  const q = s.month;
  // The paper goes out on every open off-market conversation, including the
  // ones tickRivals opened earlier in this same tick. See stampApproaches.
  stampApproaches(s, parcels);
  // expire stale LOIs and LOIs on parcels no longer owned — and anything that
  // landed on a ground-leased fee. The lessee is the landlord; fee-owner LOIs
  // are not a soft bug, they are the game asking you to manage somebody else's
  // building.
  s.lois = s.lois.filter((l) => {
    const h = s.holdings[l.bbl];
    return l.expiresM > q && !!h && !h.groundLeased;
  });

  // A RELIEF ASK YOU LET LAPSE IS AN ANSWER. The tenant asked in writing and
  // heard nothing for three months — that is a no, and it carries the same
  // strain a spoken no carries. Silence is not a way out of the decision.
  if (s.asks?.length) {
    const lapsed = s.asks.filter((a) => {
      const h = s.holdings[a.bbl];
      return a.expiresM <= q || !h || h.groundLeased;
    });
    s.asks = s.asks.filter((a) => {
      const h = s.holdings[a.bbl];
      return a.expiresM > q && !!h && !h.groundLeased;
    });
    for (const a of lapsed) {
      const h = s.holdings[a.bbl];
      const t = h?.tenants.find((x) => x.name === a.name && x.startM === a.tenantStartM);
      if (!t) continue;
      t.strainedM = q;
      const rec = resolveRec(parcels, s, a.bbl);
      s.news.unshift({
        q, kind: "info",
        text: `${a.name}'s relief letter at ${rec?.address ?? a.bbl} has lapsed unanswered. They will finish the term at the full rate — watch the credit.`,
      });
    }
    if (!s.asks.length) delete s.asks;
  }

  // A LETTER FOR SPACE THAT IS GONE DOES NOT SIT ON YOUR DESK.
  //
  // Every letter is sized against the vacancy on the day it was written, and
  // more than one can be live on the same building at once — the tour sweeps
  // its own members when one signs, but two letters from DIFFERENT tours were
  // never each other's business. So you could sign the first, take the floor
  // down to a sliver, and be left holding a second letter for space that no
  // longer existed. Accepting it ran the clamp in signLoi, found less than a
  // demisable suite left, and returned without signing anything: the letter
  // vanished off the desk and no lease appeared. From the player's chair that
  // is the game quietly eating an input, which is the worst thing software can
  // do, and it is exactly what a playtester hit on a building they had just
  // finished developing.
  //
  // The fix is at the source. A prospect whose space got let while they were
  // deciding does not wait around — they go and look at somebody else's
  // building, and they say so on the way out.
  {
    const gone: LOI[] = [];
    s.lois = s.lois.filter((l) => {
      if (l.kind !== "new" && l.kind !== "expansion") return true;
      const rec = resolveRec(parcels, s, l.bbl);
      const h = s.holdings[l.bbl];
      if (!rec || !h) return true;
      const use = l.use ?? leasableUses(rec)[0] ?? "office";
      const floor = minTenancySf(rec, use);
      if (useVacantSf(rec, h, use, q) >= floor) return true;
      gone.push(l);
      return false;
    });
    for (const l of gone) {
      const rec = resolveRec(parcels, s, l.bbl);
      s.news.unshift({
        q, kind: "info",
        text: `${l.name} have withdrawn from ${rec?.address ?? "your building"} — the space they were looking at `
          + `let while they were deciding, and what is left will not demise.`,
      });
    }
  }

  // one relief ask citywide per month — each is a letter, not a queue
  let askIssued = false;
  for (const h of Object.values(s.holdings)) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    // ABSOLUTELY NET MEANS YOU DO NOT RUN THE BUILDING. After the lessee's
    // improvement opens, resolveRec correctly returns a tower — and without
    // this gate every landlord path (LOIs, renewals, capital plan, make-ready)
    // treated the fee owner as the operator. Skip the entire holding loop, and
    // strip any operating attachments left on older saves.
    if (h.groundLeased) {
      delete h.broker;
      delete h.leasingHold;
      delete h.specSuites;
      delete h.makeReady;
      delete h.planCutM;
      delete h.program;
      if (h.tenants.length) h.tenants = [];
      delete h.occ;
      continue;
    }

    // The flats in this building — whether it is a block of flats or a block
    // of flats with shops underneath — run on aggregate occupancy.
    const resShare = mixOf(rec).multifamily ?? 0;
    if (resShare > 0) {
      const target = useOccupancy(rec, s.econ, "multifamily");
      // THE FLOOR THAT MADE EVERY APARTMENT BUILDING THE SAME BUILDING.
      //
      // This line used to read Math.max(0.4, ...). No block of flats in this
      // city could be less than 40% let, ever — not a building delivered
      // yesterday, not one in a glut, not one whose owner had stopped paying
      // for two years. Measured over 4 seeds x 15 years, multifamily delivered
      // at 40.0% occupancy at p10, at the median AND at p90: not a
      // distribution, a rail. CLAUDE.md: a clamp the model rests on is
      // load-bearing and therefore a defect.
      //
      // It also made lease-up risk — the thing a residential developer is
      // actually paid for carrying — literally unrepresentable, because a job
      // that delivered at 10% was marked up to 40% the following month.
      //
      // The walk itself is the mechanism and it always was: occupancy closes a
      // share of the gap to the market each month. What that SHARE is depends
      // on the market, because filling a building in a tight market and
      // filling one in a glut are not the same job. At the natural vacancy the
      // pace is ~9%/mo of the remaining gap, which stabilises a new building in
      // about 18 months; in a soft market it halves, which is how a delivery
      // into a glut ends up in front of a workout desk.
      const slack = Math.max(0, (s.econ.cityVac.multifamily ?? 0.06) - NATURAL_VAC.multifamily);
      const pace = Math.max(0.030, 0.090 - 0.75 * slack);
      const now = h.occ ?? target;
      h.occ = Math.min(0.99, Math.max(0, now + (target - now) * pace + rrange(s, -0.006, 0.006, "leasing")));
    }
    const renovating = h.renovatingUntilM !== undefined && q < h.renovatingUntilM;

    // --- obsolescence --------------------------------------------------------
    //
    // THIS USED TO BE A COIN FLIP WITH A FLOOR, AND IT SAT BELOW THE COMMERCIAL
    // GUARD, WHICH MEANT APARTMENTS NEVER AGED AT ALL.
    //
    // The old rule: wait 240-320 months since the last capital, then roll a 2%
    // monthly chance of dropping one named grade, and reset the clock. Measured
    // over a 600-month hold that is two steps from `good`, one from `standard`
    // and — because the ladder returned null at the bottom — NONE from `worn`.
    // 55% of this city's built stock starts worn. Half the map was immune to
    // age, and because worn carries a +70bp cap spread it was also the cheapest,
    // highest-yielding half. Buy the best yield on the tape, hold it forever,
    // spend nothing: measured at a $158.9M median over twenty seeds against a
    // $218.4M median for a policy that did everything.
    //
    // The street has always had the right model — tickAssetManagement in
    // rivals.ts decays condIdx every month and arrests it with a capital plan of
    // about 30bps of gross assets a year, and its comment says the firms that
    // skip it "are marked down for it exactly the way the player is". They were
    // not. This is the player's half of that sentence.
    //
    // The plan is automatic and has no control anywhere, because a monthly
    // maintenance prompt is a chore and this is not one: it is debited like tax
    // and overhead, it lands on the `capex` line in the Books, and the only
    // thing that stops it is running out of money — which is exactly the doom
    // loop that should follow being over-levered into a downturn. The DECISION
    // is the capital programme in dev.ts, which the plan cannot substitute for.
    if (!renovating && rec.class !== "land" && rec.bldgArea > 0) {
      h.lastCapM = h.lastCapM ?? h.boughtM;
      if (h.condIdx === undefined) h.condIdx = initialCondIdx(rec, h.boughtM, h.condition);
      const was = h.condition;

      // The bricks go down every month. Old bones go down faster: the same
      // dollar of plan buys less on a 1928 building than on a 2015 one, which
      // is the whole reason a city has to keep rebuilding itself.
      const age = START_YEAR + Math.floor(q / 12) - rec.yearBuilt;
      const wear = (COND_DECAY[rec.class as BuiltClass] ?? 0.0024)
        * (1 + Math.min(0.50, age / 220))
        * (s.econ.phase === "recession" || s.econ.phase === "depression" ? 1.2 : 1);
      h.condIdx -= wear;

      // THE CAPITAL PLAN. 34bps of gross asset value a year, spent without being
      // asked. It is the first thing that goes when the money is short.
      // HOW THE BUILDING IS RUN, as the tenants experience it — which is not
      // the switch, it is the average of the switch over about three years. A
      // service cut shows up in NOI next month and in the rent roll in 2007.
      const svc = serviceSpec(h.service);
      h.svcIdx = (h.svcIdx ?? SVC_START) + (svc.aim - (h.svcIdx ?? SVC_START)) * SVC_SPEED;

      // THE CAPITAL PLAN, AND IT IS A DECISION NOW. It was a constant charged
      // on every building unconditionally, and this file said so: "the plan is
      // automatic and has no control anywhere". Measured over 1,046 building-
      // years, condition improved 44 times and slipped 9 — the automatic plan
      // out-ran decay on 83% of all movement, so there was no way to run a
      // building well and no way to run one badly except by going broke.
      //
      // Priced against what THIS building consumes, so an old office eats more
      // reserve than a new shed. Defer sets no planCutM: choosing not to spend
      // is not the same as being unable to, and the annual warning in sim.ts
      // is about the second thing.
      const plan = planSpec(h.plan);
      const gav = ownedHoldingValue(s, parcels, h);
      const want = Math.round((CAP_PLAN_RATE * plan.mult * gav * (wear / COND_WEAR_REF)) / 12);
      // A SWEEP TRAPS PROPERTY CASH FLOW — it does not freeze the firm's
      // chequebook. Charging the plan from firm cash while a deed is swept used
      // to be refused outright, which printed "capital plan went unfunded" on a
      // sponsor sitting on millions and left the bricks to rot for no reason a
      // lender would recognise. The sweep still takes surplus NOI to principal
      // in debt.ts; the reserve cheque is sponsor equity, same as a cure.
      // Fund this month when the firm can pay this month's bill — a 4× cash
      // buffer used to cut the plan while three months of runway were still in
      // the account, which read the same way to the player.
      if (want > 0 && s.cash >= want) {
        s.cash -= want;
        logBooks(s, "capex", want);
        h.condIdx += wear * plan.lift;
        h.lastCapM = q;
      } else if (want > 0) {
        h.planCutM = q;
      }
      // A building can never be made better than its bones allow — see
      // condCeiling. New construction is the only way to own the top of the
      // scale, which is most of what a developer is buying.
      h.condIdx = Math.max(0.20, Math.min(condCeiling(rec, q), h.condIdx));
      h.condition = condGrade(h.condIdx);
      if (h.condition !== was && CONDITION_RENT_MULT[h.condition] < CONDITION_RENT_MULT[was]) {
        s.news.unshift({
          q, kind: "warn",
          text: h.condition === "obsolete"
            ? `${rec.address} has aged out of the market. The plant is finished, the plan is not enough to bring it back, and until somebody spends real money on it nobody will lease it and no institution will lend on it.`
            : `${rec.address} has slipped to ${h.condition} condition — the systems are dated and the brokers have noticed. Rents will follow.`
              + (h.planCutM !== undefined && q - h.planCutM < 24 ? " The capital plan there has been going unfunded." : ""),
        });
      }
    }

    if (!isCommercial(rec)) continue;

    // move-outs: leases that reached expiry without a signed renewal.
    // The space goes into make-ready — a turn cost now, leasable in a few months.
    const movedOut = h.tenants.filter((t) => t.endM <= q);
    h.tenants = h.tenants.filter((t) => t.endM > q);
    if (movedOut.length) {
      const outSf = movedOut.reduce((sum, t) => sum + t.sf, 0);
      const turnCost = Math.round(outSf * MAKE_READY_PSF * s.econ.costIdx);
      s.cash -= turnCost;
      logBooks(s, "capex", turnCost);
      // THE DEPOSIT GOES BACK. It was never yours: it arrived as cash at
      // signing and sat as a liability against your net worth for the whole
      // term. A tenant who left owing you nothing takes it with them; one who
      // defaulted forfeited it when they went, and is not in this list.
      const returned = movedOut.reduce((sum, t) => sum + (t.deposit ?? 0), 0);
      if (returned > 0) s.cash -= returned;
      // Downtime is the expensive half of rollover and nobody underwrites it
      // honestly. A suite handed back in a soft office market is dark for the
      // better part of a year: demo, demise, permit, market, build out.
      const soft = s.econ.phase === "recession" ? 1.7 : s.econ.phase === "depression" ? 1.5
        : s.econ.phase === "recovery" ? 1.3 : s.econ.phase === "peak" ? 0.95 : 0.8;
      // Downtime is a property of the SPACE, not the building: a shop relets
      // faster than a floor, and each turns on its own clock.
      const lagFor = (u: BuiltClass | undefined) =>
        u === "office" ? 5.5 : u === "industrial" ? 2.5 : 3.5;
      const entries = movedOut.map((mo) => ({
        sf: mo.sf,
        use: mo.use,
        readyM: q + Math.max(1, Math.round(lagFor(mo.use ?? dominantUse(rec)) * soft * rrange(s, 0.7, 1.4, "leasing"))),
      }));
      const down = Math.max(...entries.map((e) => e.readyM - q));
      h.makeReady = [...(h.makeReady ?? []), ...entries];
      // City pool: material departures become searchers (or leave-town noise).
      for (const mo of movedOut) {
        noteTenantSfChange(s, (mo.use ?? dominantUse(rec)) as BuiltClass, mo.sf);
      }
      // THE ONE WORTH NAMING. Most departures leave through this aggregate
      // line, not the earlier "is not renewing" notice — a letter that sat
      // unanswered, a term that just ran out. The square footage is a
      // statistic; the firm that was here nineteen years, and where they
      // went, is the part a landlord actually repeats at dinner.
      const notable = [...movedOut].sort((a, b) =>
        (q - b.startM) * 2 + b.sf / 1000 - ((q - a.startM) * 2 + a.sf / 1000))[0];
      let gone = "";
      if (notable) {
        const yrsIn = Math.floor((q - notable.startM) / 12);
        if (yrsIn >= 8 || notable.sf >= 8000) {
          const dest = departureDestination(s, parcels, rec, notable.use ?? (rec.class as BuiltClass));
          gone = ` ${notable.name}${yrsIn >= 8 ? `, here ${yrsIn} years,` : ""} is gone`
            + (dest ? ` — to ${dest}.` : ".");
        }
      }
      s.news.unshift({
        q, kind: "info",
        text: `${(outSf / 1000).toFixed(1)}k sf back at ${rec.address} — $${(turnCost / 1000).toFixed(0)}K make-ready, ${down} months before it can be shown.${gone}`,
      });
    }
    // finished turns come off the books
    if (h.makeReady) {
      h.makeReady = h.makeReady.filter((m) => m.readyM > q);
      if (!h.makeReady.length) delete h.makeReady;
    }
    // A LEASING EXCLUSIVE IS NOT A RETAINER, and charging one had the
    // economics exactly backwards: the invoice was largest on the building
    // that was emptiest and nothing at all arrived on the day a lease was
    // finally signed. No house in the business works that way. They tour the
    // space for nothing for as long as it takes and are paid a commission at
    // the signing, which is charged where every other leasing commission in
    // this file is charged — inside loiSigningCost, at the rate
    // exclusiveFeeRate returns.
    //
    // The lapse survives the change and matters more without the retainer
    // than it did with one. An exclusive on a building with nothing left to
    // lease has no subject, and a free exclusive left on the file forever
    // would quietly take six points of every renewal in a full building for
    // work nobody did.
    if (h.broker && vacantSf(rec, h) <= 500) delete h.broker;

    // --- credit events ------------------------------------------------------
    // Tenants fail. They fail far more often in a downturn, far more often
    // when they were weak credit to begin with, and the space comes back
    // mid-term with no notice and no termination fee worth collecting. This is
    // the risk a rent roll of unrated startups is actually carrying, and the
    // reason a boring insurance company at a lower rent underwrites better.
    for (let i = h.tenants.length - 1; i >= 0; i--) {
      const t = h.tenants[i];
      if (q - t.startM < 6) continue;                       // give them a quarter to fail
      const cycle = s.econ.phase === "recession" ? 3.4 : s.econ.phase === "depression" ? 2.6
        : s.econ.phase === "recovery" ? 1.7 : s.econ.phase === "peak" ? 0.9 : 0.55;
      const grade = t.credit === 2 ? 0.14 : t.credit === 1 ? 0.55 : 1.6;   // investment grade rarely goes dark
      const sectorStress = Math.max(0, -(s.econ.sectorMom?.[rec.class as "office"] ?? 0)) * 40;
      // AND THE TENANT'S OWN TRADE. This is the whole point of modelling
      // industries: a technology bust does not take out one startup, it takes
      // out every startup you have, in every building, in the same eighteen
      // months. Concentration stops being a word and becomes a thing that
      // happens to you.
      const trade = industryStress(s.econ, t.sector) * 2.6;
      // A TENANT YOU REFUSED RELIEF TO is running on fumes by definition —
      // they told you so, in writing. For two years after a declined or
      // lapsed ask they go dark at three times the rate. This is the priced
      // half of saying no: you kept the face rent and you are carrying the
      // covenant risk you chose.
      const strain = t.strainedM !== undefined && q - t.strainedM < 24 ? 3 : 1;
      const pFail = 0.00035 * cycle * grade * strain * (1 + sectorStress + trade);
      if (rng(s, "leasing") >= pFail) continue;
      // FORFEITING A DEPOSIT IS NOT A CASH RECEIPT. It was collected at
      // signing and has been sitting in your account ever since as somebody
      // else's money; what changes on a default is that you stop owing it
      // back. This used to splice the tenant — correctly releasing the
      // liability, which is the whole forfeiture — and then ALSO credit three
      // months of contract rent as if the deposit were arriving now. You were
      // paid twice, and the news reported the phantom number as the deposit.
      const kept = Math.round(t.deposit ?? 0);
      h.tenants.splice(i, 1);
      // ...AND THE FORFEITURE IS INCOME, even though no cash moves.
      //
      // The correction above stopped the double-credit and left the books
      // silent. Releasing the liability IS the gain: the money has been in
      // your account since signing, and the entry that belongs here is against
      // the deposit you no longer owe, not against the bank. Without it a
      // forfeited deposit was a real improvement in net worth that the Books
      // page could not account for.
      //
      // Found by reconciling cash against the ledger every month for fifty
      // years — this was the residue left after the balloon cheque was fixed,
      // and it shows up as money APPEARING, which is the tell for a liability
      // being released rather than an asset arriving.
      if (kept > 0) logBooks(s, "noi", kept);
      const down = Math.max(2, Math.round((rec.class === "office" ? 6 : 4) * rrange(s, 0.8, 1.5, "leasing")));
      h.makeReady = [...(h.makeReady ?? []), { sf: t.sf, readyM: q + down, use: t.use }];
      noteTenantSfChange(s, (t.use ?? dominantUse(rec)) as BuiltClass, t.sf);
      // TENURE IS THE STORY. "A tenant failed" is a statistic; "the firm that
      // has been on your fourth floor since 2004 failed" is a month you
      // remember. The engine has always known how long they were there — it
      // just never said so.
      const yrsIn = Math.floor((q - t.startM) / 12);
      const tenure = yrsIn >= 8 ? `, ${yrsIn} years in the building,` : "";
      s.news.unshift({
        q, kind: "warn",
        text: `${t.name}${tenure} filed and went dark at ${rec.address} — ${(t.sf / 1000).toFixed(1)}k sf back with ${(t.endM - q) / 12 > 1 ? `${((t.endM - q) / 12).toFixed(1)} years` : `${t.endM - q} months`} left on the lease. You kept their $${(kept / 1000).toFixed(0)}K deposit — which is a month of the hole, not a year of it.`,
      });
    }

    // --- the tenant who asks --------------------------------------------------
    //
    // Before a weak tenant goes dark, they do the thing real tenants do: they
    // CALL. A firm in a contracting trade, paying over the market, with real
    // term left, asks to reopen the lease — a cut today for years of term
    // tomorrow, the blend-and-extend you could always offer them, proposed
    // from the other side of the table. It arrives as a letter on the desk
    // and a news line, never a pop-up (a thirty-tenant portfolio would be a
    // fire alarm every quarter), it waits three months, and both answers are
    // priced: grant it and the roll keeps its covenant at a lower number;
    // refuse it and the face rent survives while the tenant runs strained —
    // three times the default risk for two years, and they remember it at
    // the renewal. At most one ask arrives citywide per month, because the
    // point is that each one is a real letter from a real tenant, not a queue.
    // THE GIVEBACK. A tenant who has genuinely shrunk does not ask for a rent
    // cut — they are paying for floors nobody sits on, and before they go dark
    // they do the other thing real tenants do: offer the space back. Take it
    // and you have vacancy today plus a tenant who fits what they hold; hold
    // them to the lease and the face rent survives on a business carrying
    // empty floors, which is how defaults are made. Same discipline as the
    // relief letter: one ask citywide per month, a real letter, both answers
    // priced. Gated on a seed hash rather than the RNG so the leasing stream
    // is untouched and every seed-pinned number still reproduces.
    if (!askIssued) {
      for (let i = 0; i < h.tenants.length; i++) {
        const t = h.tenants[i];
        const left = t.endM - q;
        if (left < 12 || left > 60) continue;
        if (t.reliefAskedM !== undefined && q - t.reliefAskedM < 48) continue;
        if ((s.asks ?? []).some((a) => a.bbl === h.bbl && a.name === t.name && a.tenantStartM === t.startM)) continue;
        const needG = t.sf * (t.staff ?? 1);
        if (needG >= t.sf * 0.62) continue;                 // not shrunk enough to give a floor back
        const use = t.use ?? (rec.class as BuiltClass);
        const newSf = Math.max(minTenancySf(rec, use), toSuites(rec, needG, t.sf, use) || t.sf);
        const freed = t.sf - newSf;
        if (freed < t.sf * 0.15) continue;                  // nothing that demises cleanly
        if (hashChance(`gb:${s.seed}:${h.bbl}:${t.name}:${t.startM}:${q}`) >= 0.05) continue;
        t.reliefAskedM = q;
        askIssued = true;
        if (!s.asks) s.asks = [];
        const id = s.nextAskId ?? 1;
        s.nextAskId = id + 1;
        s.asks.push({
          id, bbl: h.bbl, name: t.name, tenantStartM: t.startM,
          sf: t.sf, currentPsf: t.rentPsf, askPsf: t.rentPsf, addM: 0,
          arrivedM: q, expiresM: q + 3, kind: "giveback", giveSf: freed,
        });
        const yrsIn = Math.floor((q - t.startM) / 12);
        s.news.unshift({
          q, kind: "warn",
          text: `${t.name}${yrsIn >= 8 ? `, your tenant of ${yrsIn} years at ${rec.address},` : ` at ${rec.address}`} `
            + `wants to hand back ${(freed / 1000).toFixed(1)}k sf — the headcount is gone and they are paying for empty floors. `
            + `Take the space and re-let it, or hold them to the paper and hope the business outlives the lease. `
            + `The letter is on your desk until ${monthLabel(q + 3)}.`,
        });
        break;
      }
    }
    if (!askIssued) {
      for (let i = 0; i < h.tenants.length; i++) {
        const t = h.tenants[i];
        const left = t.endM - q;
        if (left < 12 || left > 60) continue;
        if (t.credit === 2) continue;                       // investment grade does not beg
        if (t.reliefAskedM !== undefined && q - t.reliefAskedM < 48) continue;
        if ((s.asks ?? []).some((a) => a.bbl === h.bbl && a.name === t.name && a.tenantStartM === t.startM)) continue;
        const use = t.use ?? (rec.class as BuiltClass);
        const market = Math.max(1, managedRentPsfYr(rec, s.econ, h, use));
        const over = t.rentPsf / market;
        // WHAT MAKES A TENANT ASK. Measured over 1,596 tenant-months: a lease
        // materially over market essentially never exists here — escalations
        // run 2.5% against a market compounding faster, so sitting tenants
        // ride further UNDER market every year. The real trigger was never
        // the lease-versus-market spread anyway: a tenant asks for relief
        // when THEIR BUSINESS cannot make the rent — their trade is in a
        // bust, their headcount is shrinking, and the number on the lease is
        // the number they can no longer pay, wherever the market sits. Being
        // over market on top of that just makes them ask sooner and harder.
        const stress = industryStress(s.econ, t.sector);
        const shrinking = (t.staff ?? 1) < 0.85 ? 0.5 : 0;
        const squeeze = stress * 3
          + (s.econ.phase === "recession" ? 0.7 : s.econ.phase === "depression" ? 0.45 : 0)
          + shrinking + Math.max(0, over - 1) * 2;
        if (squeeze <= 0.65) continue;                      // healthy trades honour their paper
        if (rng(s, "leasing") >= Math.min(0.07, 0.022 * squeeze * (t.credit === 0 ? 1.6 : 1))) continue;
        t.reliefAskedM = q;
        askIssued = true;
        // The ask is a cut off the rent they PAY — their problem is the
        // cheque, not the comp sheet. If they are under market, granting it
        // means renting below a market you could re-let at... minus the
        // downtime, the fit-out, and the odds this tenant goes dark instead.
        // That arithmetic is the whole decision, and the card shows both numbers.
        const askPsf = +(t.rentPsf * (over > 1.1 || stress > 0.3 ? 0.85 : 0.90)).toFixed(2);
        const addM = Math.round(24 + 24 * Math.min(1, Math.max(0, over - 1)) + 24 * Math.min(1, stress * 2));
        if (!s.asks) s.asks = [];
        const id = s.nextAskId ?? 1;
        s.nextAskId = id + 1;
        s.asks.push({
          id, bbl: h.bbl, name: t.name, tenantStartM: t.startM,
          sf: t.sf, currentPsf: t.rentPsf, askPsf, addM,
          arrivedM: q, expiresM: q + 3,
        });
        const yrsIn = Math.floor((q - t.startM) / 12);
        s.news.unshift({
          q, kind: "warn",
          text: `${t.name}${yrsIn >= 8 ? `, your tenant of ${yrsIn} years at ${rec.address},` : ` at ${rec.address}`} `
            + `is asking for relief — ${INDUSTRY_LABEL[t.sector].toLowerCase()} has turned and the `
            + `$${t.rentPsf.toFixed(0)}/sf is more than the business can carry (the market here is $${market.toFixed(0)}). `
            + `They will sign to $${askPsf.toFixed(0)}/sf for ${Math.round(addM / 12)} more years of term. `
            + `The letter is on your desk until ${monthLabel(q + 3)}.`,
        });
        break;
      }
    }

    // contractual escalations — the bump on the paper, defaulting to the old
    // silent 2.5% so pre-negotiation leases keep compounding the same way.
    for (const t of h.tenants) {
      const age = q - t.startM;
      if (age > 0 && age % 12 === 0) {
        t.rentPsf = +(t.rentPsf * (1 + bumpOf(t) / 100)).toFixed(2);
        // AND THE COVENANT MIGRATES. Credit was frozen at signing, so a decade
        // of technology boom never improved a roll and a five-year bust never
        // degraded one — measured at zero credit changes across 163 tenancies.
        // It already drives default odds, deposit size, the renewal discount
        // and the quality spread a buyer pays. This is the only wire missing.
        const ph = s.econ.industryPhase?.[t.sector];
        if (ph === "boom" && t.credit < 2 && rng(s, "leasing") < 0.055) t.credit = (t.credit + 1) as Credit;
        else if (ph === "bust" && t.credit > 0 && rng(s, "leasing") < 0.075) t.credit = (t.credit - 1) as Credit;
      }
      // HEADCOUNT. Measured, a p95 boom compounds this to 1.65x over two years
      // and a bust runs it back down. Everything else in this block reads it.
      t.staff = clampL((t.staff ?? 1) * (1 + (s.econ.industryMom?.[t.sector] ?? 0) * 1.6 + rrange(s, -0.004, 0.004, "leasing")), 0.40, 2.6);
    }

    // --- the roll grows -----------------------------------------------------
    //
    // A tenant who has outgrown their suite has exactly two futures and you
    // choose which: they take the space next door, or they tour. If there is
    // room, a letter arrives and it is a real decision — the certain covenant
    // coterminous with a lease you already hold, against holding the suite for
    // a full-term tenant at a better number. If there is no room, nothing
    // arrives and renewalIntent quietly halves, which is why keeping a floor of
    // slack in a building with a growing anchor is asset management and not
    // sloppiness.
    for (let i = 0; i < h.tenants.length && !h.leasingHold && !renovating; i++) {
      const t = h.tenants[i];
      const need = t.sf * (t.staff ?? 1);
      if (need < t.sf * 1.30) continue;
      if (t.endM - q < 12) continue;              // inside a year it is a renewal question
      if (t.askedM !== undefined && q - t.askedM < 24) continue;
      if (s.lois.some((l) => l.bbl === h.bbl && l.tenantIdx === i)) continue;
      const use = t.use ?? leasableUses(rec)[0] ?? "office";
      const free = useVacantSf(rec, h, use, q);
      // A GROWING FIRM ON A WEAK CORNER MOVES; IT DOES NOT DOUBLE DOWN.
      // Expansion was the hole in the occupancy ceiling: it walked straight
      // past supportableOcc, so a fringe building filled itself one sitting
      // tenant at a time. Above what the address supports the space next door
      // stops being the obvious answer and a better building across town
      // starts being it — which is the same conversation fLoc is having at
      // the renewal, one lease earlier.
      const legAll = useSf(rec, use);
      const room = Math.max(0, free - (1 - supportableOcc(s.econ, rec, use)) * legAll);
      if (room < minTenancySf(rec, use)) continue;
      const wantSf = toSuites(rec, Math.min(free, room, need - t.sf), free, use);
      if (!wantSf || wantSf > room + useSuiteSf(rec, use) * 0.15) continue;
      if (rng(s, "leasing") > 0.16) continue;                // they get round to it
      t.askedM = q;
      const market = managedRentPsfYr(rec, s.econ, h, use);
      s.lois.push({
        id: s.nextLoiId++, arrivedM: q, bbl: h.bbl, kind: "expansion", use,
        name: t.name, sector: t.sector, credit: t.credit, sf: wantSf,
        rentPsf: +(market * rrange(s, 0.96, 1.06, "leasing")).toFixed(2),
        termM: Math.max(24, t.endM - q),          // coterminous with what they hold
        tiPsf: Math.round(rrange(s, 1, 5, "leasing") * concessionPressure(s.econ, use)),
        freeM: 0,
        // Coterminous paper keeps the escalator they already live under.
        bumpPct: bumpOf(t),
        net: t.net, recovery: recoveryOf(t),
        expiresM: q + 3, tenantIdx: i,
      });
      s.news.unshift({
        q, kind: "deal",
        text: `${t.name} has grown into their space at ${rec.address} and wants the ${(wantSf / 1000).toFixed(1)}k sf next door, coterminous with the lease they are on.`,
      });
    }

    // renewal talks open six months ahead of expiry — unless you have stopped
    // letting the building, in which case nobody is offered a renewal and the
    // roll simply runs off. That is how a building gets emptied for a
    // demolition, and it is slow and expensive on purpose.
    for (let i = 0; i < h.tenants.length && !h.leasingHold; i++) {
      const t = h.tenants[i];
      if (t.endM !== q + 6) continue;
      if (s.lois.some((l) => l.bbl === h.bbl && l.tenantIdx === i)) continue;
      // WHETHER THEY EVEN WRITE. This was `rng(s, "leasing") < industryStress * 0.55` and
      // industryStress is zero most months, so a renewal letter arrived every
      // time a lease rolled and nothing the owner did to the building had any
      // bearing on it. See renewalIntent: how it is run, what state it is in,
      // what you are charging, what their trade is doing, whether it still
      // fits them. And the notice says which of those it was.
      const ri = renewalIntent(s, rec, h, t);
      if (rng(s, "leasing") > ri.p) {
        t.nonRenewM = q;
        t.nonRenewWhy = ri.why[0];
        // WHERE THEY WENT. A tenant who leaves you does not evaporate — they
        // take space in somebody else's building, and knowing WHOSE turns
        // churn into rivalry. The destination is a plausible same-class
        // building from a named firm's book; when nobody in town fits, they
        // left the city, which is also a real thing tenants do.
        const dest = departureDestination(s, parcels, rec, t.use ?? (rec.class as BuiltClass));
        const yrsIn = Math.floor((q - t.startM) / 12);
        s.news.unshift({
          q, kind: "warn",
          text: `${t.name}${yrsIn >= 8 ? `, ${yrsIn} years in the building,` : ""} is not renewing at ${rec.address} — ${ri.why[0]}. `
            + `${(t.sf / 1000).toFixed(1)}k sf comes available ${monthLabel(t.endM)}.`
            + (dest ? ` They are taking space at ${dest}.` : ""),
        });
        continue;
      }
      // THE TENANT'S OWN MARKET, not the building's blended one. A renewal is
      // for the space this tenant is sitting in, and the shop on the ground
      // floor of an office building renews against shop rents. Passing no use
      // fell through to the area-weighted blend of every market in the stack —
      // see managedRentPsfYr, which says so — so the ironmonger under a tower
      // was quoted a renewal off a number that is mostly office.
      const market = managedRentPsfYr(rec, s.econ, h, t.use ?? leasableUses(rec)[0]);
      // A tenant sitting well below market knows what a move costs them and
      // renews near market. A tenant ABOVE market knows the same thing in
      // reverse and asks for a cut — and in a soft market they get it.
      const overMarket = t.rentPsf / Math.max(1, market);
      const leverage = overMarket > 1.05 ? 0.82 : overMarket < 0.9 ? 1.0 : 0.94;
      const soft = s.econ.phase === "recession" ? 0.88 : s.econ.phase === "depression" ? 0.90
        : s.econ.phase === "recovery" ? 0.95 : 1;
      // Credit tenants are worth keeping and they know it.
      const creditDisc = t.credit === 2 ? 0.97 : t.credit === 1 ? 1.0 : 1.02;
      // AND WHAT THEIR OWN TRADE IS DOING. A firm in a booming industry is
      // growing into its lease and will pay to stay; one in a bust is cutting
      // headcount and either wants a discount or wants out. The building's
      // market is only half of a renewal — the other half is the tenant's.
      const stress = industryStress(s.econ, t.sector);
      const boom = Math.max(0, (s.econ.industryMom?.[t.sector] ?? 0)) * 6;
      const trade = 1 - stress * 0.14 + boom;
      const ask = market * leverage * soft * creditDisc * clampL(trade, 0.78, 1.18);
      // Renewals are cheap to do: no downtime, a fraction of the TI, no free
      // rent worth the name. That gap is why renewal economics beat a new
      // lease at a higher face rent almost every time.
      s.lois.push({
        id: s.nextLoiId++,
        arrivedM: s.month,
        bbl: h.bbl,
        kind: "renewal",
        // A renewal is for the space the tenant is ALREADY in. This carried no
        // use at all, so signing one fell through to the building's dominant
        // use — and in a residential-leaning mixed building that is the flats,
        // which put a named commercial tenant in the housing.
        use: t.use ?? leasableUses(rec)[0] ?? "office",
        name: t.name, sector: t.sector, credit: t.credit,
        // A TENANT WHO HAS SHRUNK RENEWS FOR WHAT THEY NEED. Every renewal in
        // this engine was for exactly the space that was signed, however many
        // people had left in the meantime, so a recession could only ever take
        // whole tenants and never a floor off one. It gives back a suite at a
        // time, and the giveback lands in make-ready like any other vacancy.
        sf: (() => {
          const need = t.sf * (t.staff ?? 1);
          if (need >= t.sf * 0.78) return t.sf;
          return Math.max(minTenancySf(rec, t.use ?? "office"), toSuites(rec, need, t.sf, t.use ?? "office") || t.sf);
        })(),
        rentPsf: +(Math.max(market * 0.6, ask) * rentMultFor(s, h)).toFixed(2),
        termM: Math.round(rrange(s, 36, 84, "leasing")),
        // A sitting tenant asks for less than a new one — no fit-out, no
        // moving costs to cover — but the same market decides how far they get.
        tiPsf: Math.round(rrange(s, 2, 9, "leasing") * concessionPressure(s.econ, t.use ?? "office")),
        freeM: rng(s, "leasing") < 0.25 * concessionPressure(s.econ, t.use ?? "office")
          ? Math.round(rrange(s, 1, 3, "leasing") * concessionPressure(s.econ, t.use ?? "office")) : 0,
        // Renewals reopen the escalator a notch — incumbents usually ask to
        // flatten; a soft market helps them.
        bumpPct: Math.round(clampL(
          bumpOf(t) + rrange(s, -0.5, 0.25, "leasing")
            + (s.econ.phase === "recession" || s.econ.phase === "depression" ? -0.25 : 0),
          0, 5,
        ) * 4) / 4,
        net: t.net,
        recovery: recoveryOf(t),
        expiresM: t.endM,
        tenantIdx: i,
      });
    }

    // inbound demand for vacant, market-ready space
    const vac = vacantSf(rec, h) - notReadySf(h, q);
    // THE CLOCK ON EMPTY SPACE. Anything material and unlet ages; a signature
    // of any kind resets it, because a building that just did a deal is a
    // building whose ask the market has just validated. Apartments are exempt
    // and always have been — flats let themselves, and measured over 25 years
    // of a wholly passive owner a 21,397 sf building sat at a stable 62% while
    // the commercial ones went to zero. It is the commercial ask that never
    // moved. Held on the holding rather than derived, because "how long has
    // this been sitting" is a fact about the space and not about the roll:
    // a tenant leaving does not tell you when the FLOOR came free.
    if (vac >= minTenancySf(rec, dominantUse(rec)) && !h.leasingHold && !renovating) {
      h.darkMs = (h.darkMs ?? 0) + 1;
    } else if (h.darkMs) {
      h.darkMs = 0;
    }
    // TOURS, NOT LETTERS. Two parties chasing the same suite is ONE decision,
    // not two, so the cap counts conversations rather than envelopes — which
    // keeps the number of live decisions per building exactly where it was.
    const openTours = new Set(
      s.lois.filter((l) => l.bbl === h.bbl && l.kind === "new").map((l) => l.tourId ?? -l.id),
    ).size;
    // a big empty floorplate draws more than one prospect at a time
    const loiCap = vac > rec.bldgArea * 0.5 ? 3 : 2;
    // Same floor on the way in: a building does not go to market with 700 ft
    // of leftover, so nobody turns up asking for it.
    if (!renovating && !h.leasingHold && vac >= minTenancySf(rec, dominantUse(rec)) && openTours < loiCap) {
      // WHERE A LETTER COMES FROM — see absorption.ts. Not a coin flip per
      // building any more: the city has a finite quantity of requirement in the
      // market this month, every vacant foot in town is competing for it, and
      // this building takes its share. Everything that used to be a hand-tuned
      // adjustment on a probability — the phase, the condition, your rent
      // stance, the lobby, the broker, the sector, the jobs number, everyone
      // else's deliveries — is now either a named multiplier the player can
      // read on the panel or a term in the space market itself.
      // WHICH PART of the building is empty decides who walks through the
      // door. A tower with one empty shop at grade and full floors above is
      // being toured by shopkeepers, not law firms — and the shop competes in
      // the retail market, on retail momentum, against retail supply.
      const openLegs = leasableUses(rec)
        .map((u) => ({ u, free: useVacantSf(rec, h, u, q) }))
        .filter((x) => x.free > 400);
      if (!openLegs.length) continue;
      let pickWeight = rng(s, "leasing") * openLegs.reduce((a, x) => a + x.free, 0);
      let leg = openLegs[0];
      for (const x of openLegs) { pickWeight -= x.free; if (pickWeight <= 0) { leg = x; break; } }
      const use = leg.u;
      const legVac = leg.free;
      // TURNKEY SPACE LEASES. A tenant who can move in next month does not
      // tour the shell down the road, and the funnel widens for the use the
      // suites were built in — and only that one.
      const spec = h.specSuites;
      const specLive = spec !== undefined && spec.use === use && s.month >= spec.readyM;
      const odds = leasingOdds(s, parcels, rec, h, use);
      if (!odds) continue;
      const p = odds.loiOdds;
      if (rng(s, "leasing") < p) {
        const [tiLo, tiHi] = TI_ASK[use] ?? TI_ASK.office;
        const concession = concessionPressure(s.econ, use);
        // ...and at the rent THAT market pays, not a blend of markets the
        // tenant is not in.
        const market = managedRentPsfYr(rec, s.econ, h, use);
        // Warehouses lease whole: one operator takes the building, or most of
        // it. Offices and shops carve into suites.
        // Prospects ask for spaces, not square feet. Warehouses tend to want
        // the whole shed; offices and shops take one suite or a few.
        // HOW BIG THE REQUIREMENT IS, drawn from the city's own distribution
        // of requirements rather than from the size of your building. A firm
        // looking for eight thousand feet is looking for eight thousand feet
        // whoever owns the floor. Office rarely draws a consolidator above
        // 120k (see OFFICE_WHALE_* in absorption.ts) — still capped here by
        // what this address has left to demise.
        // ...capped by the pool this ADDRESS has left. Odds taper as a
        // building nears what its corner supports, but odds cannot stop a
        // deal already in flight: a letter sized against raw vacancy could
        // jump a fringe building from 67% straight to 92% in one signing and
        // the ceiling never got a vote. The requirement that actually tours
        // here is at most what is left of the address's own tenant pool.
        const legAll = useSf(rec, use);
        const poolSf = Math.max(0, legVac - (1 - supportableOcc(s.econ, rec, use)) * legAll);
        // toSuites never demises below one suite — pass it a starved `want`
        // and it hands back a full suite anyway, which is exactly how the
        // ceiling kept losing. When what is left of the pool will not fill
        // the smallest thing this building demises, nobody tours.
        if (poolSf < minTenancySf(rec, use)) continue;
        const want = Math.min(legVac, poolSf, drawRequirementSf(s, use));
        const sf = toSuites(rec, want, legVac, use);
        if (!sf) continue;
        // toSuites rounds to whole suites, and round() goes UP — a pool with
        // 8.4k sf left was minting 10k letters, which is the ceiling losing by
        // a suite every time it was tested. A demised ask may overshoot the
        // pool only by a sliver, never by the better part of a suite.
        if (sf > poolSf + useSuiteSf(rec, use) * 0.15) continue;
        // A TOUR, NOT A LETTER.
        //
        // Measured over 945 arriving letters across four fifty-year runs:
        // 94.4% of them, if signed, IMPROVED the building's cap-rate grade,
        // 99.8% were fundable from cash, and the expected wait for a
        // replacement prospect was 25.3 months. Against a two-year void even a
        // bad lease wins, so Accept was not a decision — it was the only move
        // on the board, and it was 52% of everything the player did.
        //
        // The answer is not to make signing worse. Filling space SHOULD be
        // good. It is to stop offering the space to one person at a time. A
        // vacant suite is being shown to two or three parties, they are not the
        // same shape, and you can have exactly one of them — which turns a
        // button into a choice without adding a single click.
        //
        // How deep the tour goes is the market's answer, not a constant. In a
        // squeeze you get to be picky; in a glut one party turns up and you had
        // better sign them.
        // Written against the old per-building coin flip, this read `vacancyPull`
        // directly. That helper still exists and still means the same thing —
        // how tight this class's market is, natural vacancy over actual — so it
        // is the right input here even though the arrival above no longer uses
        // it. Depth of tour is a question about the MARKET, not about the odds
        // this particular building drew.
        const marketPull = vacancyPull(s.econ, use);
        const pTwo = Math.max(0.05, Math.min(0.72, (marketPull - 0.55) * 0.62));
        const nTour = 1 + (rng(s, "leasing") < pTwo ? 1 : 0) + (rng(s, "leasing") < pTwo * 0.45 ? 1 : 0);
        const tourId = s.nextTourId ?? 1;
        s.nextTourId = tourId + 1;
        for (let k = 0; k < nTour; k++) {
        // THREE SHAPES, and the whole trade-off lives in the difference between
        // them. k=0 is what the market sent. k=1 is THE COVENANT: better
        // credit, long paper, a rent under the others, and it wants a fit-out —
        // it tightens waltSpread and creditSpread and it is 11x less likely to
        // go dark (see pFail: grade 0.14 against 1.6). k=2 is THE GROWTH STORY:
        // unrated, short, and it will pay over the odds — income today against
        // a mark on the building tomorrow. Both of those are already priced by
        // rollQualitySpread. The choice was simply never offered.
        const sector = pickSector(s, use);
        const drawnCredit = rollCredit(s, demandLinear(rec.demandScore));
        const credit: Credit = k === 1 ? (Math.min(2, drawnCredit + 1) as Credit)
          : k === 2 ? 0 : drawnCredit;
        const rentBias = k === 1 ? rrange(s, 0.86, 0.95, "leasing") : k === 2 ? rrange(s, 1.04, 1.16, "leasing") : 1;
        const termBias = k === 1 ? 1.35 : k === 2 ? 0.6 : 1;
        // term first: the free-rent ask is a function of how long they sign for
        const termM = Math.round(
          (credit === 2 ? rrange(s, 84, 144, "leasing") : credit === 1 ? rrange(s, 60, 108, "leasing") : rrange(s, 36, 60, "leasing"))
          * (sf > useSuiteSf(rec, use) * 2.5 ? 1.15 : 1)
          * (s.econ.phase === "recession" || s.econ.phase === "depression" ? 0.85 : 1) * termBias,
        );
        // WHAT THIS TENANT IS OFFERING against a fair ask for this space. Drawn
        // once because BOTH the rent and the allowance read it — a prospect
        // that lowballs the rent and asks for a full fit-out anyway is not a
        // negotiation, it is two independent dice. See tiPsf below.
        const bid = rng(s, "leasing") < 0.3 ? rrange(s, 0.68, 0.86, "leasing") : rrange(s, 0.9, 1.1, "leasing");
        s.lois.push({
          id: s.nextLoiId++,
          arrivedM: s.month,
          tourId,
          bbl: h.bbl,
          use,
          kind: "new",
          name: pickName(s, sector),
          sector,
          credit,
          sf,
          // A wide spread on purpose. If every prospect offers within a few
          // per cent of asking, the accept/counter/pass modal is a formality.
          // Some of these should be worth refusing, and refusing should hurt.
          // Turnkey space is worth a premium and asks for no allowance —
          // the fit-out is already standing there, paid for, in the suite the
          // tenant just walked through.
          // ...and space that has been sitting signs under the market, because
          // the agent cut the ask to move it. See staleDiscount: the same
          // markdown that brought this prospect through the door, seen from the
          // other side, and the reason the arrival factor is not a gift.
          rentPsf: +(market * (specLive ? 1.05 : 1) * rentBias * staleDiscount(h.darkMs)
            * bid * rentMultFor(s, h)).toFixed(2),
          // Term length is not random. A credit tenant taking a whole floor
          // signs long paper and expects to be paid for it; a small unrated
          // firm wants three years and an out. WALT is the thing a buyer
          // actually underwrites, and it has to be earned tenant by tenant.
          // Real terms: an investment-grade covenant signs seven to twelve
          // years, a solid mid-market firm five to nine, a small unrated one
          // three to five with a break. The old band ran to fifteen years as a
          // matter of course, which handed the player bond-like income on
          // ordinary space and made WALT a number nobody had to work for.
          termM,
          // Concessions are the first thing to move when a market turns, and
          // they move long before face rents do. A landlord holding headline
          // rent while giving away a year of free rent is the oldest tell in
          // the business.
          // Per year of term, softened against the market, and with a narrower
          // credit spread now that term carries the work the credit multiplier
          // was doing badly.
          // YOU DO NOT GET THE DISCOUNT AND THE FIT-OUT. `bid` is what this
          // tenant is offering against a fair ask for THIS space — the ask
          // already carries the stale markdown and the landlord's own bias, so
          // this is the tenant's own discount and nothing else. A tenant taking
          // space under the market is buying it cheap; the landlord is not also
          // building it out for them. That is the net-effective trade every
          // real negotiation is actually about, and the allowance was being
          // handed over regardless of what was being paid for the space.
          // Full allowance at the ask, nothing at 15% under it, straight line
          // between — so a lowball costs the tenant the fit-out, which is
          // usually the more expensive half of what they were asking for.
          tiPsf: Math.round(rrange(s, tiLo, tiHi, "leasing") * (termM / 12) * tiPressure(concession)
            * (credit === 2 ? 1.18 : credit === 1 ? 1.02 : 0.90) * (specLive ? 0.12 : 1)
            * clamp01((bid - 0.85) / 0.15)),
          // Free rent scales with the LENGTH of the deal, the way it does in
          // life — the rule of thumb is about a month a year, and it is the
          // concession a landlord gives before cutting the face rent. A flat
          // nought-to-six-and-a-half band handed a three-year tenant the same
          // holiday as a twelve-year one, and handed both of them one in a
          // market where nobody had to give anything away.
          freeM: Math.max(0, Math.round((termM / 12) * rrange(s, 0.25, 0.85, "leasing") * concession)),
          bumpPct: rollBumpPct(s, credit),
          net: use === "office" ? rng(s, "leasing") < 0.8 : rng(s, "leasing") < 0.4,
          recovery: rollRecovery(s, use),
          expiresM: q + 3,
        });
        }
        const cover = s.agent
          ? { who: "Your agent" as const }
          : deskCoverage(s, h.bbl);
        s.news.unshift({
          q, kind: "info",
          text: nTour > 1
            ? (cover
              ? `${nTour} parties are chasing the same ${(sf / 1000).toFixed(1)}k sf at ${rec.address} — ${cover.who.toLowerCase()} is picking a winner.`
              : `${nTour} parties are chasing the same ${(sf / 1000).toFixed(1)}k sf at ${rec.address} — you can only have one of them.`)
            : (cover
              ? `LOI in at ${rec.address} — ${cover.who.toLowerCase()} is working it.`
              : `LOI in at ${rec.address} — check the Deals desk.`),
        });
      }
    }
  }

  // Firm agent takes the whole book at 6%. Without them, exclusives and (when
  // you handed the book over) in-house leasing staff negotiate the buildings
  // they cover. Renewal management is the narrow middle option for renewals.
  // "Take leasing back" / teamLeasing off means the principal owns every letter
  // that is not on an exclusive or the renewal desk.
  if (s.agent) runAgent(s, parcels);
  else {
    runDelegatedLeasing(s, parcels);
    if (s.renewalMgmt) runRenewalDesk(s, parcels);
  }
}

/**
 * THIS MONTH'S DESK TALLY — see GameState.deskMonth.
 * Opens a fresh card when the month rolls so last month's quiet activity is not
 * mistaken for this month's silence.
 */
export function bumpDeskMonth(
  s: GameState,
  key: "signed" | "passed" | "referred" | "walked" | "countered",
) {
  if (!s.deskMonth || s.deskMonth.m !== s.month) {
    s.deskMonth = { m: s.month, signed: 0, passed: 0, referred: 0, walked: 0, countered: 0 };
  }
  s.deskMonth[key]++;
}

/** Live scorecard for the current month, or null if the desk has not acted yet. */
export function deskMonthNow(s: GameState): NonNullable<GameState["deskMonth"]> | null {
  if (!s.deskMonth || s.deskMonth.m !== s.month) return null;
  return s.deskMonth;
}

/** True when at least one leasing hire can cover buildings (firm desk or assigned). */
export function hasLeasingTeam(s: GameState): boolean {
  return (s.staff ?? []).some((x) => x.role === "leasing");
}

/**
 * Somebody else holds the pen on at least part of the book — firm agent,
 * your team (when handed over), exclusive broker, or renewal management.
 * Drives mandate UI and the quiet-desk scorecard.
 */
export function deskHoldsPen(s: GameState): boolean {
  if (s.agent || s.renewalMgmt) return true;
  if (s.teamLeasing && hasLeasingTeam(s)) return true;
  return Object.values(s.holdings).some((h) => !!h.broker);
}

/**
 * Does this letter still need the principal — popup, Deals queue, Skip stop?
 *
 * Referred paper always does. Otherwise the firm agent, a covering exclusive /
 * team hire, or (for renewals) management already owns the decision.
 */
export function loiNeedsPrincipal(s: GameState, l: LOI): boolean {
  // Fee owner is not the landlord — never interrupt for the lessee's paper.
  if (s.holdings[l.bbl]?.groundLeased) return false;
  if (l.referred) return true;
  if (s.agent) return false;
  if (deskCoverage(s, l.bbl)) return false;
  if (s.renewalMgmt && l.kind === "renewal") return false;
  return true;
}

// The leasing agent works the whole book for you: every LOI that clears a
// sane rent bar gets signed, at a 6% commission instead of the 4%/2% you'd
// pay negotiating it yourself. Lowballs still get passed on.
export const AGENT_FEE = 0.06;

/**
 * WHAT A LEASING EXCLUSIVE COSTS, AND WHEN.
 *
 * A house that takes a building on exclusively is paid the same way the
 * firm-wide agent is paid, because it is the same job done by the same
 * people: six percent of the base rent over the whole term — rentPsf × sf ×
 * termM/12 — handed over at the signing alongside the fit-out, and nothing
 * whatsoever in the months when the space does not move.
 *
 * It REPLACES the in-house rate rather than stacking on top of it. Signing a
 * letter yourself has always paid a commission inside loiSigningCost — 4% on
 * a new lease, 2% on a renewal — so an exclusive that added six on top would
 * be charging you twice for one transaction. The two or four extra points are
 * the entire price of the exclusive, and what they buy is the 45% lift in
 * tenant traffic that absorption.ts pays for it. Cheap to hold on a dead
 * building, expensive precisely when it works, which is the deal a landlord
 * actually signs.
 */
export function exclusiveFeeRate(h: Holding | undefined): number | undefined {
  return h?.broker ? AGENT_FEE : undefined;
}

// ------------------------------------------------------------- pre-built space
//
// The single biggest change in how office space has actually been leased in
// the last decade, and the game had no version of it: instead of handing a
// tenant an allowance and six months of drawings, you fit the space out first
// and rent it turnkey. It leases faster, it leases at a premium, and it
// carries the risk that you have just spent eighty dollars a foot on space
// nobody wants.
// Priced against TI_ASK, not against nothing. A tenant's allowance runs
// $15-40/sf on an office suite; pre-building the same space costs rather more
// per foot, because you are doing the whole job to a generic spec rather than
// contributing to theirs — and because you are doing it before anyone has
// signed. The premium over the allowance is what you pay for speed.
export const SPEC_COST_PSF: Record<string, number> = { office: 31.5, retail: 17, industrial: 5.9, multifamily: 0 };
export const SPEC_MONTHS = 4;

export function specSuiteQuote(s: GameState, rec: ParcelRecord, h: Holding, use: BuiltClass, sf: number) {
  const psf = SPEC_COST_PSF[use] ?? SPEC_COST_PSF.office;
  if (!psf) return null;
  const open = useVacantSf(rec, h, use, s.month);
  const take = Math.max(0, Math.min(Math.round(sf), Math.round(open)));
  // You cannot pre-build a closet either. 800 was a number from before the
  // floor existed.
  if (take < minTenancySf(rec, use)) return null;
  return { sf: take, cost: Math.round(take * psf * s.econ.costIdx), readyM: s.month + SPEC_MONTHS, use };
}

export function buildSpecSuites(
  s: GameState, parcels: ParcelTable, bbl: string, use: BuiltClass, sf: number,
): { s: GameState; err?: string; msg?: string } {
  const h = s.holdings[bbl];
  const rec = h ? resolveRec(parcels, s, bbl) : null;
  if (!h || !rec) return { s, err: "You don't own that." };
  if (h.groundLeased) return { s, err: "The ground lessee controls the improvement — you do not fit out their space." };
  if (h.specSuites) return { s, err: "There is already pre-built space going in here." };
  if (s.developments[bbl]) return { s, err: "Construction is already underway." };
  const q = specSuiteQuote(s, rec, h, use, sf);
  if (!q) return { s, err: "There is not enough open space to pre-build, or this class does not fit out." };
  if (s.cash < q.cost) return { s, err: `Pre-building that runs $${(q.cost / 1e6).toFixed(2)}M — you're short.` };
  const next: GameState = cloneState(s);
  next.cash -= q.cost;
  logBooks(next, "leasing", q.cost);
  next.holdings[bbl].specSuites = { sf: q.sf, readyM: q.readyM, use };
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Pre-building ${(q.sf / 1000).toFixed(0)}k sf of ${use} at ${rec.address} — $${(q.cost / 1e6).toFixed(2)}M, ready ${monthLabel(q.readyM)}. `
      + `Turnkey space leases faster and dearer, and it is your money sitting in an empty suite until it does.`,
  });
  return { s: next, msg: "Pre-build under way." };
}

/**
 * BLEND AND EXTEND.
 *
 * A sitting tenant with three years left is a lease expiry you can do
 * something about today. You go to them early, give up rent now, and take term
 * in exchange — which is either the cheapest WALT you will ever buy or a
 * discount you did not need to give, depending entirely on where their rent
 * sits against the market and what you think the market does next.
 *
 * They will only talk if there is something in it for them, which means a
 * tenant paying under market has no reason to pick up the phone.
 */
/**
 * ANSWER A TENANT'S RELIEF LETTER. Grant: the lease reprices to their number
 * and the term extends — a blend-and-extend signed from their side of the
 * table, with a lawyer's bill and no brokerage, because nobody toured
 * anything. Decline: the paper stands, the tenant runs strained (see pFail),
 * and the renewal will remember. Both outcomes are said out loud.
 */
export function answerAsk(
  s: GameState, parcels: ParcelTable, id: number, action: "grant" | "decline",
): { s: GameState; msg: string; err?: string } {
  const next: GameState = cloneState(s);
  const a = next.asks?.find((x) => x.id === id);
  if (!a) return { s, msg: "", err: "That letter is gone." };
  const held = next.holdings[a.bbl];
  if (held?.groundLeased) {
    return { s, msg: "", err: "The ground lessee lets that building — this relief letter is not yours to answer." };
  }
  next.asks = next.asks!.filter((x) => x.id !== id);
  if (!next.asks.length) delete next.asks;
  const h = next.holdings[a.bbl];
  const rec = h ? resolveRec(parcels, next, a.bbl) : null;
  const t = h?.tenants.find((x) => x.name === a.name && x.startM === a.tenantStartM);
  if (!h || !rec || !t) return { s: next, msg: "", err: "That tenant is no longer on the roll." };
  if (a.kind === "giveback") {
    if (action === "decline") {
      t.strainedM = next.month;
      next.news.unshift({
        q: next.month, kind: "info",
        text: `You held ${t.name} to the lease at ${rec.address} — all ${(t.sf / 1000).toFixed(1)}k sf of it, `
          + `to ${monthLabel(t.endM)}. They will keep paying for floors nobody sits on, for as long as the business lasts.`,
      });
      return { s: next, msg: "Declined. The lease stands, all of it." };
    }
    const freed = Math.min(a.giveSf ?? 0, t.sf - 1);
    if (freed <= 0) return { s: next, msg: "", err: "There is no space left to take back." };
    // the lawyer papers the surrender; the space turns like any other giveback
    const legal = Math.max(8_000, Math.round(t.rentPsf * freed * 0.01));
    if (next.cash < legal) return { s, msg: "", err: `Papering the surrender costs $${(legal / 1000).toFixed(0)}K — you're short.` };
    next.cash -= legal;
    logBooks(next, "leasing", legal);
    const use = (t.use ?? (rec.class as BuiltClass)) as BuiltClass;
    h.makeReady = [...(h.makeReady ?? []), { sf: freed, readyM: next.month + 3, use: t.use }];
    noteTenantSfChange(next, use, freed);
    const oldSf = t.sf;
    t.sf -= freed;
    // they now fit what they hold — the same headcount over less space
    t.staff = Math.min(1.05, (t.staff ?? 1) * oldSf / t.sf);
    delete t.strainedM;
    // and the deposit trues down to the smaller tenancy — cash out, liability down
    const dep = depositFor(next, t.rentPsf, t.sf, t.credit);
    if ((t.deposit ?? 0) > dep) {
      const back = (t.deposit ?? 0) - dep;
      next.cash -= back;
      t.deposit = dep;
    }
    next.news.unshift({
      q: next.month, kind: "deal",
      text: `Surrender signed at ${rec.address}: ${t.name} hands back ${(freed / 1000).toFixed(1)}k sf and keeps `
        + `${(t.sf / 1000).toFixed(1)}k at $${t.rentPsf.toFixed(0)}/sf. The space turns to make-ready — `
        + `a smaller covenant that fits beats a bigger one that fails.`,
    });
    return { s: next, msg: "Space taken back." };
  }
  if (action === "decline") {
    t.strainedM = next.month;
    next.news.unshift({
      q: next.month, kind: "info",
      text: `You held the paper on ${t.name} at ${rec.address} — the rent stays $${t.rentPsf.toFixed(0)}/sf `
        + `to ${monthLabel(t.endM)}. They will run lean to make it, and lean businesses have accidents.`,
    });
    return { s: next, msg: "Declined. The rent stands." };
  }
  // the lawyer papers the amendment; there is no broker on a deal nobody toured
  const legal = Math.max(8_000, Math.round(a.askPsf * a.sf * 0.01));
  if (next.cash < legal) return { s, msg: "", err: `Papering the amendment costs $${(legal / 1000).toFixed(0)}K — you're short.` };
  next.cash -= legal;
  logBooks(next, "leasing", legal);
  const oldRent = t.rentPsf;
  t.rentPsf = a.askPsf;
  t.endM = t.endM + a.addM;
  delete t.strainedM;
  if (recoveryOf(t) === "base") t.baseStopPsf = +stopPsfNow(rec, next.econ, h, t.use).toFixed(2);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Relief granted at ${rec.address}: ${t.name} goes to $${a.askPsf.toFixed(0)}/sf from $${oldRent.toFixed(0)} `
      + `and the lease runs to ${monthLabel(t.endM)}. You traded rent for term with a tenant who asked — `
      + `cheaper than the vacancy they were about to become, if you read them right.`,
  });
  return { s: next, msg: "Relief granted." };
}

export function blendExtendQuote(s: GameState, rec: ParcelRecord, h: Holding, idx: number) {
  const t = h.tenants[idx];
  if (!t) return null;
  const left = (t.endM - s.month) / 12;
  if (left <= 0.75 || left > 6) return null;   // too late to be early, too early to be relevant
  const market = managedRentPsfYr(rec, s.econ, h, t.use ?? (rec.class as BuiltClass));
  // What they will accept: a cut off today's rent, deeper the further over
  // market they are, and they want real term for it.
  const over = t.rentPsf / Math.max(1, market);
  if (over < 0.92) return null;                // already a bargain — they will not reopen it
  const newRent = +(Math.max(market * 0.94, t.rentPsf * (over > 1.15 ? 0.88 : over > 1.02 ? 0.94 : 0.975))).toFixed(2);
  const addM = Math.round(clampN(36 + 48 * (over - 0.95), 24, 96));
  const annualGive = Math.round((t.rentPsf - newRent) * t.sf * left);
  return {
    idx, name: t.name, sf: t.sf, current: t.rentPsf, market, newRent,
    addM, newEndM: t.endM + addM,
    giveUp: Math.max(0, annualGive),                       // rent forgone over the remaining term
    // no fit-out on a renewal in place, but the broker still gets paid
    cost: Math.round(newRent * t.sf * ((left * 12 + addM) / 12) * 0.02),
  };
}

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function blendExtend(
  s: GameState, parcels: ParcelTable, bbl: string, idx: number,
): { s: GameState; err?: string; msg?: string } {
  const h = s.holdings[bbl];
  const rec = h ? resolveRec(parcels, s, bbl) : null;
  if (!h || !rec) return { s, err: "You don't own that." };
  if (h.groundLeased) return { s, err: "The ground lessee lets that building — you have no lease to reopen." };
  const q = blendExtendQuote(s, rec, h, idx);
  if (!q) return { s, err: "There is no deal to do with that tenant right now." };
  if (s.cash < q.cost) return { s, err: "You cannot cover the commission on that." };
  const next: GameState = cloneState(s);
  const t = next.holdings[bbl].tenants[idx];
  next.cash -= q.cost;
  logBooks(next, "leasing", q.cost);
  t.rentPsf = q.newRent;
  t.endM = q.newEndM;
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Blend and extend at ${rec.address}: ${t.name} goes to $${q.newRent.toFixed(0)}/sf from $${q.current.toFixed(0)} `
      + `and adds ${(q.addM / 12).toFixed(0)} years, out to ${monthLabel(q.newEndM)}. `
      + `You bought term with rent — whether that was clever depends on what the market does next.`,
  });
  return { s: next, msg: "Extended." };
}
/**
 * THE MANDATE. What share of the market rent the desk may sign at without
 * coming back to you — the one instruction a principal actually gives a
 * leasing agent, and the one this game was giving on the player's behalf.
 *
 * It was a hardcoded 0.82 in two places, which is a real number for a real
 * instruction (an agent with a broad mandate signs a few points under asking
 * and refers anything materially worse) but it is not the PLAYER'S number, and
 * the whole point of hiring the desk is that you set the terms of the mandate
 * and they exercise judgement inside it. The default is now 0.90 on net
 * effective economics; older saves inherit that policy when the field is absent.
 *
 * The band is what a mandate can sensibly be. Above par the desk would refuse
 * everything the market offers and the mandate would be a way of not leasing;
 * below 0.65 you are not setting a floor, you are removing one.
 */
/**
 * WHAT A DOLLAR OF FIT-OUT ALLOWANCE IS WORTH TO THE TENANT, as a fraction of
 * a dollar of rent. Exported because the counter panel quotes the net
 * effective the tenant is judging, and two answers to one quantity is exactly
 * the fault this file has spent the most time on. See the long note in
 * respondLOI for what it is and why it is not one.
 */
export const TI_VALUE = 0.75;

/**
 * MARKET-STANDARD ANNUAL BUMP. Every lease used to escalate at this rate in
 * silence. It stays the baseline so putting bumps on the letter does not
 * rewrite every mandate score overnight — only a bump ABOVE or BELOW 2.5%
 * moves net effective.
 */
export const DEFAULT_BUMP_PCT = 2.5;

export function bumpOf(t: { bumpPct?: number } | null | undefined): number {
  const b = t?.bumpPct;
  return b === undefined || !Number.isFinite(b) ? DEFAULT_BUMP_PCT : b;
}

/** Average contractual face over the term at a constant annual bump. */
export function avgRentWithBump(startPsf: number, bumpPct: number, termM: number): number {
  const years = Math.max(1, termM / 12);
  const r = bumpPct / 100;
  if (Math.abs(r) < 1e-9) return startPsf;
  const full = Math.floor(years + 1e-9);
  const frac = years - full;
  let sum = 0;
  for (let i = 0; i < full; i++) sum += startPsf * Math.pow(1 + r, i);
  if (frac > 0.001) sum += startPsf * Math.pow(1 + r, full) * frac;
  return sum / years;
}

/**
 * What the negotiated bump is worth vs the market-standard 2.5% — positive
 * when the landlord got a steeper escalator, negative when they gave it away.
 */
export function bumpPremiumPsf(rentPsf: number, bumpPct: number, termM: number): number {
  return avgRentWithBump(rentPsf, bumpPct, termM)
    - avgRentWithBump(rentPsf, DEFAULT_BUMP_PCT, termM);
}

/** What a prospect opens at — credit tenants push for flatter paper. */
function rollBumpPct(s: GameState, credit: Credit): number {
  const soft = s.econ.phase === "recession" || s.econ.phase === "depression" ? -0.35
    : s.econ.phase === "recovery" ? -0.15 : 0;
  const base = credit === 2 ? rrange(s, 1.5, 2.5, "leasing")
    : credit === 1 ? rrange(s, 2.0, 3.0, "leasing")
    : rrange(s, 2.25, 3.5, "leasing");
  // Quarter-point steps so the counter dial and the letter agree.
  return Math.round(clampL(base + soft, 0, 5) * 4) / 4;
}

/**
 * THE NUMBER THE TENANT IS ACTUALLY DECIDING ON.
 *
 * Face rent paid over the term (free months take a straight-line bite), plus
 * the rent equivalent of whatever allowance you took off them (or added),
 * amortised over the term, plus whatever the annual bump is worth against the
 * market-standard 2.5%. Free rent, TI and the escalator are the same trade as
 * face rent — and the counter desk used to leave free months (and bumps) as
 * display-only while pricing only rent and TI.
 */
export function netEffectivePsf(
  loi: LOI, rentPsf: number, tiPsf: number, freeM?: number, bumpPct?: number,
): number {
  const years = Math.max(1, loi.termM / 12);
  const free = Math.max(0, freeM ?? loi.freeM ?? 0);
  // Cap the free-rent bite so a pathological letter cannot invert the axis.
  const paid = 1 - Math.min(0.45, free / Math.max(1, loi.termM));
  const openTi = loi.openTiPsf ?? loi.tiPsf ?? 0;
  const bump = bumpPct ?? bumpOf(loi);
  return rentPsf * paid
    + (TI_VALUE * (openTi - tiPsf)) / years
    + bumpPremiumPsf(rentPsf, bump, loi.termM);
}

/**
 * LEASING MANDATE — what you hand a desk when you stop reading every letter.
 *
 * Three bands, the way a real exclusive works:
 *   ≥ floor          auto-sign (within credit / TI caps)
 *   pass…floor       counter and negotiate toward the sign line
 *   < pass           kill it — not worth anyone's afternoon
 *
 * Soft letters used to bounce straight back to the principal "for a counter".
 * That is the desk's job. They counter; you only see expansions, tour dead
 * heats, credit/TI breaches, failed negotiations, and funding holes.
 *
 * The score is NET EFFECTIVE to the landlord (face after free months, less
 * amortised TI), against the market for THAT use. Face-only at 82% was how a
 * desk quietly filled buildings 18–20% under market while the principal thought
 * they had hired a professional. Default floor is now 90%.
 */
export const AGENT_FLOOR_DEFAULT = 0.90;
export const AGENT_FLOOR_MIN = 0.70;
export const AGENT_FLOOR_MAX = 1.00;
export const AGENT_PASS_DEFAULT = 0.78;
export const AGENT_PASS_MIN = 0.55;
export const AGENT_TI_MONTHS_DEFAULT = 9;
export const AGENT_TI_MONTHS_MIN = 0;
export const AGENT_TI_MONTHS_MAX = 18;
/** TI plus commission, expressed as months of the lease's face rent. */
export const AGENT_SIGNING_MONTHS_DEFAULT = 12;
export const AGENT_SIGNING_MONTHS_MIN = 3;
export const AGENT_SIGNING_MONTHS_MAX = 24;

export function agentFloor(s: GameState): number {
  const f = s.agentFloor;
  return f === undefined || !Number.isFinite(f)
    ? AGENT_FLOOR_DEFAULT
    : Math.min(AGENT_FLOOR_MAX, Math.max(AGENT_FLOOR_MIN, f));
}

export function agentPassBelow(s: GameState): number {
  const floor = agentFloor(s);
  const p = s.agentPassBelow;
  const raw = p === undefined || !Number.isFinite(p) ? AGENT_PASS_DEFAULT : p;
  // Pass line always sits strictly under the sign line.
  return Math.min(floor - 0.02, Math.max(AGENT_PASS_MIN, raw));
}

export function agentMinCredit(s: GameState): Credit {
  const c = s.agentMinCredit;
  if (c !== 0 && c !== 1 && c !== 2) return 0;
  return c;
}

export function agentMaxTiMonths(s: GameState): number {
  const m = s.agentMaxTiMonths;
  return m === undefined || !Number.isFinite(m)
    ? AGENT_TI_MONTHS_DEFAULT
    : Math.min(AGENT_TI_MONTHS_MAX, Math.max(AGENT_TI_MONTHS_MIN, m));
}

/** Fit-out expressed as months of the letter's face rent. */
export function loiTiMonths(loi: LOI): number {
  if (loi.rentPsf <= 0) return 0;
  return (loi.tiPsf / loi.rentPsf) * 12;
}

export function agentMaxSigningMonths(s: GameState): number {
  const m = s.agentMaxSigningMonths;
  return m === undefined || !Number.isFinite(m)
    ? AGENT_SIGNING_MONTHS_DEFAULT
    : Math.min(AGENT_SIGNING_MONTHS_MAX, Math.max(AGENT_SIGNING_MONTHS_MIN, m));
}

/** Upfront TI + commission as months of this lease's annual face rent. */
export function loiSigningMonths(loi: LOI, feeRate: number): number {
  if (!(loi.rentPsf > 0) || !(loi.sf > 0)) return Infinity;
  const years = Math.max(1, loi.termM / 12);
  return ((loi.tiPsf / loi.rentPsf) + years * feeRate) * 12;
}

/**
 * Cash the delegated desk may not spend. Six months of contractual debt
 * service, with a $250k operating floor. This is not a concession rule; it is
 * the elementary treasury control that stops a leasing agent from signing a
 * good lease and bankrupting the firm that owns it.
 */
export function agentCashReserve(s: GameState): number {
  const mortgages = Object.values(s.holdings)
    .reduce((a, h) => a + (h.loan?.monthlyPmt ?? 0), 0);
  const facility = s.facility
    ? (s.facility.balance * s.facility.ratePct) / 100 / 12
    : 0;
  const line = ((s.loc?.balance ?? 0) * ((s.econ.indexRate ?? 0) + 4)) / 100 / 12;
  return Math.max(250_000, Math.round(6 * (mortgages + facility + line)));
}

/**
 * Landlord-side score vs market: face after free rent, minus amortised TI.
 * Positive concessions pull the score down so a "market" face with a fat
 * allowance does not clear a tight mandate.
 */
export function loiMandateScore(loi: LOI, market: number): number {
  const years = Math.max(1, loi.termM / 12);
  const paid = 1 - Math.min(0.45, (loi.freeM ?? 0) / Math.max(1, loi.termM));
  const ne = loi.rentPsf * paid
    - (TI_VALUE * (loi.tiPsf ?? 0)) / years
    + bumpPremiumPsf(loi.rentPsf, bumpOf(loi), loi.termM);
  return ne / Math.max(1, market);
}

/**
 * THE MARKET A LETTER IS ACTUALLY MEASURED AGAINST.
 *
 * Both desks read `managedRentPsfYr(rec, econ, h)` with NO use, which is the
 * area-weighted blend of every market in the building. A letter is always for
 * ONE leg. In a tower with shops underneath, the blend is mostly office, so a
 * perfectly fair shop letter at the shop market read 30-40% "under the market"
 * and the agent binned it with a note saying so — which is exactly the
 * complaint that retail signs miles below market, seen from the other side.
 * The tenant was never the problem: one quantity had two answers, and the desk
 * was reading the wrong one.
 */
function loiMarket(s: GameState, rec: ParcelRecord, h: Holding, loi: LOI): number {
  return managedRentPsfYr(rec, s.econ, h, loi.use ?? leasableUses(rec)[0]);
}

type DeskVerdict = "sign" | "counter" | "refer" | "pass";

function deskVerdict(
  s: GameState, loi: LOI, market: number, feeRate: number,
  opts?: { ignoreTour?: boolean; cover?: "agent" | "exclusive" | "staff" | null },
): {
  verdict: DeskVerdict; score: number; floor: number; pass: number;
  adjFloor: number; adjPass: number; why?: string;
} {
  const floor = agentFloor(s);
  const pass = agentPassBelow(s);
  // Outside agent/exclusive is mid competence — they do not inherit payroll stars.
  const judgment = penJudgment(s, opts?.cover ?? "staff");
  const slack = ((judgment - 50) / 100) * 0.06;
  const adjFloor = Math.max(0.5, floor - slack);
  const adjPass = Math.max(0.35, pass - slack * 0.5);
  const score = loiMandateScore(loi, market);
  const minCred = agentMinCredit(s);
  const maxTiM = agentMaxTiMonths(s);
  const tiM = loiTiMonths(loi);
  const maxSigningM = agentMaxSigningMonths(s);
  const signingM = loiSigningMonths(loi, feeRate);
  const base = { score, floor, pass, adjFloor, adjPass };

  // A mandate may price routine paper; it cannot make the programming call on
  // an incumbent expansion. Tours are handled in runLeasingAgent as a group —
  // forcing every party back used to mean "hire the agent" still filled the
  // screen with every competing letter.
  if (loi.kind === "expansion") {
    return { ...base, verdict: "refer", why: "an incumbent expansion changes how you program the building" };
  }
  if (
    !opts?.ignoreTour
    && loi.tourId !== undefined
    && s.lois.filter((x) => x.tourId === loi.tourId).length > 1
  ) {
    return { ...base, verdict: "refer", why: "multiple tenants are competing for the same space; you choose the winner" };
  }
  if (loi.credit < minCred) {
    return { ...base, verdict: "refer", why: `credit below your ${CREDIT_LABEL[minCred]} minimum` };
  }
  if (tiM > maxTiM + 0.05) {
    // Fat TI: refer if the rent score is otherwise fine; pass if the letter is
    // also cheap — a desk does not auto-sign a capital hole.
    if (score >= adjFloor) {
      return { ...base, verdict: "refer", why: `fit-out is ${tiM.toFixed(1)} months of rent against your ${maxTiM}-month cap` };
    }
  }
  if (score < adjPass) return { ...base, verdict: "pass" };
  // Soft but workable — the desk counters toward the sign line instead of
  // dumping every mid-band letter on the principal.
  if (score < adjFloor) return { ...base, verdict: "counter" };
  if (tiM > maxTiM + 0.05) {
    return { ...base, verdict: "refer", why: `fit-out is ${tiM.toFixed(1)} months of rent against your ${maxTiM}-month cap` };
  }
  if (signingM > maxSigningM + 0.05) {
    return {
      ...base, verdict: "refer",
      why: `TI plus commission is ${signingM.toFixed(1)} months of rent against your ${maxSigningM}-month upfront-cost cap`,
    };
  }
  return { ...base, verdict: "sign" };
}

function agentCanFund(s: GameState, loi: LOI, feeRate: number = AGENT_FEE): boolean {
  return s.cash - loiSigningCost(loi, feeRate) >= agentCashReserve(s);
}

/**
 * Terms that lift a soft letter toward the mandate sign line: modest concession
 * cuts and the rent that gets net effective to `targetScore` of market.
 */
export function agentCounterTerms(
  loi: LOI, market: number, targetScore: number,
): { rentPsf: number; tiPsf: number; freeM: number; bumpPct: number } {
  const years = Math.max(1, loi.termM / 12);
  const openRent = loi.rentPsf;
  const openTi = loi.tiPsf ?? 0;
  const openFree = loi.freeM ?? 0;
  const openBump = bumpOf(loi);
  let freeM = Math.max(0, Math.round(openFree * 0.65));
  let tiPsf = Math.max(0, Math.round(openTi * 0.72));
  let bumpPct = Math.min(5, Math.round((Math.max(openBump, DEFAULT_BUMP_PCT) + 0.25) * 4) / 4);
  let rentPsf = openRent;
  for (let i = 0; i < 5; i++) {
    const paid = 1 - Math.min(0.45, freeM / Math.max(1, loi.termM));
    const bumpPrem = bumpPremiumPsf(rentPsf, bumpPct, loi.termM);
    const need = targetScore * market + (TI_VALUE * tiPsf) / years - bumpPrem;
    rentPsf = paid > 0.05 ? need / paid : need;
    rentPsf = Math.max(openRent, Math.min(market * 1.14, rentPsf));
  }
  rentPsf = +rentPsf.toFixed(2);
  // If still short of the target, squeeze concessions harder once.
  if (loiMandateScore({ ...loi, rentPsf, tiPsf, freeM, bumpPct }, market) < targetScore - 0.005) {
    freeM = Math.max(0, Math.round(freeM * 0.5));
    tiPsf = Math.max(0, Math.round(tiPsf * 0.55));
    bumpPct = Math.min(5, Math.round((bumpPct + 0.25) * 4) / 4);
    const paid = 1 - Math.min(0.45, freeM / Math.max(1, loi.termM));
    const bumpPrem = bumpPremiumPsf(Math.max(openRent, market), bumpPct, loi.termM);
    const need = targetScore * market + (TI_VALUE * tiPsf) / years - bumpPrem;
    rentPsf = +(Math.max(openRent, Math.min(market * 1.14, paid > 0.05 ? need / paid : need))).toFixed(2);
  }
  // Never open a counter that is weaker than the letter already on the table.
  if (rentPsf < openRent) rentPsf = openRent;
  if (tiPsf > openTi) tiPsf = openTi;
  if (freeM > openFree) freeM = openFree;
  return { rentPsf, tiPsf, freeM, bumpPct };
}

/**
 * Who holds the pen on this deed.
 *
 * Three covers, one model:
 *   1. You (null) — default
 *   2. Staff — only after an explicit handoff (`teamLeasing`); float hires
 *      cover the unassigned book, pinned hires only their buildings
 *   3. Outside — firm agent or a building exclusive (vendors, mid competence)
 *
 * Hiring staff alone does not take the pen.
 */
export function deskCoverage(
  s: GameState, bbl: string,
): { kind: "agent" | "exclusive" | "staff"; who: string } | null {
  if (s.agent) return { kind: "agent", who: "Your agent" };
  if (s.holdings[bbl]?.broker) return { kind: "exclusive", who: "Your exclusive" };
  if (!s.teamLeasing) return null;
  const leasing = (s.staff ?? []).filter((x) => x.role === "leasing");
  if (!leasing.length) return null;
  const assigned = leasing.some((st) => (st.assignedBbls ?? []).includes(bbl));
  const firmDesk = leasing.some((st) => !(st.assignedBbls?.length));
  if (!assigned && !firmDesk) return null;
  return { kind: "staff", who: "Your leasing desk" };
}

function deskFee(kind: "agent" | "exclusive" | "staff", loi?: LOI): number {
  if (kind === "staff") return loi?.kind === "renewal" ? 0.02 : 0.04;
  return AGENT_FEE;
}

/**
 * Tenant reaction to a counter — same math as the player path in respondLOI.
 * Does not sign. Mutates `loi` to the asked terms (and to their final
 * counter-back when that is the outcome).
 */
function tenantCounterOutcome(
  s: GameState, rec: ParcelRecord, h: Holding, loi: LOI,
  ask: { rentPsf: number; tiPsf: number; freeM: number; bumpPct: number },
): "took" | "walked" | "countered" {
  if (loi.openRentPsf === undefined) loi.openRentPsf = loi.rentPsf;
  if (loi.openTiPsf === undefined) loi.openTiPsf = loi.tiPsf;
  if (loi.openFreeM === undefined) loi.openFreeM = loi.freeM;
  if (loi.openBumpPct === undefined) loi.openBumpPct = bumpOf(loi);
  const openTi = loi.openTiPsf;
  const openFree = loi.openFreeM;
  const openBump = loi.openBumpPct;
  const openedAt = loi.openRentPsf;
  const askRent = ask.rentPsf;
  const askTi = ask.tiPsf;
  const askFree = ask.freeM;
  const askBump = ask.bumpPct;
  const market = managedRentPsfYr(rec, s.econ, h, loi.use);
  const years = Math.max(1, loi.termM / 12);
  const paidFrac = 1 - Math.min(0.45, askFree / Math.max(1, loi.termM));
  const tiRent = (TI_VALUE * (openTi - askTi)) / years;
  const neAsk = askRent * paidFrac + tiRent + bumpPremiumPsf(askRent, askBump, loi.termM);
  const f = neAsk / Math.max(1, market);
  const vacHere = (s.econ.cityVac?.[loi.use ?? "office"] ?? 0.1);
  const natHere = loi.use === "multifamily" ? 0.045 : loi.use === "retail" ? 0.085 : loi.use === "industrial" ? 0.07 : 0.115;
  const tight = Math.max(-0.3, Math.min(0.35, (natHere - vacHere) * 3));
  const SWITCH = 0.06;
  const stick = loi.kind === "renewal" ? 0.10 : 0;
  const softDrag = Math.max(0, -tight) * 0.12;
  const fStar = 1 + SWITCH + stick + tight * 0.35 - softDrag + loi.credit * 0.015
    + (s.econ.phase === "expansion" ? 0.05
      : s.econ.phase === "recession" || s.econ.phase === "depression" ? -0.06 : 0);
  const W = 0.085;
  const pAccept = Math.max(0.04, Math.min(0.95, 1 / (1 + Math.exp((f - fStar) / W))));
  loi.countered = true;
  loi.askedRentPsf = askRent;
  loi.askedTiPsf = askTi;
  loi.askedFreeM = askFree;
  loi.askedBumpPct = askBump;
  loi.rentPsf = askRent;
  loi.tiPsf = askTi;
  loi.freeM = askFree;
  loi.bumpPct = askBump;
  if (rng(s) < pAccept) return "took";
  const pWalk = Math.max(0.15, Math.min(0.92, 0.24 + (f - 1.0) * 2.2));
  if (rng(s) < pWalk) {
    loi.rentPsf = openedAt;
    loi.tiPsf = openTi;
    loi.freeM = openFree;
    loi.bumpPct = openBump;
    return "walked";
  }
  loi.stage = "countered";
  loi.counterRentPsf = +Math.min(
    askRent,
    Math.max(openedAt * 0.94, market * (0.95 + 0.04 * rng(s))),
  ).toFixed(2);
  loi.counterTiPsf = Math.round((askTi + openTi) / 2);
  loi.counterFreeM = Math.round((askFree + openFree) / 2);
  loi.counterBumpPct = Math.round(((askBump + openBump) / 2) * 4) / 4;
  loi.rentPsf = loi.counterRentPsf;
  loi.tiPsf = loi.counterTiPsf;
  loi.freeM = loi.counterFreeM;
  loi.bumpPct = loi.counterBumpPct;
  return "countered";
}

/**
 * Desk negotiates a soft letter toward the sign line. Returns whether the
 * letter was fully resolved (signed / walked / passed) so tour logic can stop.
 */
function agentNegotiateLoi(
  s: GameState, _parcels: ParcelTable, loi: LOI,
  rec: ParcelRecord, h: Holding, market: number,
  feeRate: number, adjFloor: number, adjPass: number,
  who: string,
  cover?: "agent" | "exclusive" | "staff" | null,
): boolean {
  const target = Math.min(1.02, adjFloor + 0.01);
  const terms = agentCounterTerms(loi, market, target);
  bumpDeskMonth(s, "countered");
  const outcome = tenantCounterOutcome(s, rec, h, loi, terms);
  if (outcome === "took") {
    if (!agentCanFund(s, loi, feeRate)) {
      agentReferLoi(s, loi, rec,
        `${who} got them to $${loi.rentPsf.toFixed(2)}/sf, but signing needs `
        + `${money(loiSigningCost(loi, feeRate))} against the ${money(agentCashReserve(s))} treasury reserve`,
        who);
      return true;
    }
    delete (s as GameState & { _signFailed?: string })._signFailed;
    const before = h.tenants.length;
    signLoi(s, rec, h, loi, feeRate);
    const failed = (s as GameState & { _signFailed?: string })._signFailed
      || (loi.kind === "new" && h.tenants.length <= before);
    delete (s as GameState & { _signFailed?: string })._signFailed;
    if (failed) {
      agentReferLoi(s, loi, rec, `${who} got a yes and could not demise the space`, who);
      return true;
    }
    bumpDeskMonth(s, "signed");
    s.lois = s.lois.filter((l) => l.id !== loi.id);
    s.news.unshift({
      q: s.month, kind: "deal",
      text: `${who} countered ${loi.name} at ${rec.address} up to $${loi.rentPsf.toFixed(2)}/sf`
        + (loi.freeM ? ` / ${loi.freeM} mo free` : "")
        + ` and they took it.`,
    });
    return true;
  }
  if (outcome === "walked") {
    bumpDeskMonth(s, "walked");
    s.lois = s.lois.filter((l) => l.id !== loi.id);
    s.news.unshift({
      q: s.month, kind: "info",
      text: `${who} pushed ${loi.name} at ${rec.address} and they walked — `
        + `$${terms.rentPsf.toFixed(2)}/sf was more than the space was worth to them.`,
    });
    return true;
  }
  // Final counter-back: take it when negotiation skill says the number clears
  // a softened bar; otherwise leave the improved letter on your desk once.
  const score = loiMandateScore(loi, market);
  const neg = penNegotiation(s, cover ?? "staff");
  const acceptBar = Math.max(adjPass + 0.01, adjFloor - ((neg - 50) / 100) * 0.08);
  if (score >= acceptBar && agentCanFund(s, loi, feeRate)) {
    delete (s as GameState & { _signFailed?: string })._signFailed;
    const before = h.tenants.length;
    signLoi(s, rec, h, loi, feeRate);
    const failed = (s as GameState & { _signFailed?: string })._signFailed
      || (loi.kind === "new" && h.tenants.length <= before);
    delete (s as GameState & { _signFailed?: string })._signFailed;
    if (!failed) {
      bumpDeskMonth(s, "signed");
      s.lois = s.lois.filter((l) => l.id !== loi.id);
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `${who} took ${loi.name}'s final at ${rec.address}: $${loi.rentPsf.toFixed(2)}/sf`
          + ` (${(score * 100).toFixed(0)}% of market net effective) — inside what negotiation skill can close.`,
      });
      return true;
    }
  }
  agentReferLoi(s, loi, rec,
    `${who} countered; they came back at $${loi.rentPsf.toFixed(2)}/sf `
    + `(${(score * 100).toFixed(0)}% of market net effective) — final, and it still needs you`,
    who);
  return true;
}

function agentPassLoi(
  s: GameState, loi: LOI, rec: { address?: string }, score: number, market: number, pass: number,
  who = "Your agent",
) {
  bumpDeskMonth(s, "passed");
  s.lois = s.lois.filter((l) => l.id !== loi.id);
  s.news.unshift({
    q: s.month, kind: "info",
    text: `${who} passed on ${loi.name} at ${rec.address} — net effective `
      + `${(score * 100).toFixed(0)}% of a $${market.toFixed(2)} market (pass below ${Math.round(pass * 100)}%).`,
  });
}

function agentReferLoi(
  s: GameState, loi: LOI, rec: { address?: string }, why: string, who = "Your agent",
) {
  bumpDeskMonth(s, "referred");
  loi.referred = true;
  s.news.unshift({
    q: s.month, kind: "warn",
    text: `${who} referred ${loi.name} at ${rec.address} back to you — ${why}. It is on your desk.`,
  });
}

/**
 * Work live letters under the player's mandate. Exported so hiring the desk
 * clears the open pile immediately — waiting until next month left every
 * existing LOI still popping.
 *
 * `onlyDelegated`: when the firm agent is off, exclusives and (when handed
 * the book) in-house leasing staff still counter/sign on buildings they cover.
 */
export function runLeasingAgent(
  s: GameState, parcels: ParcelTable, opts?: { onlyDelegated?: boolean },
) {
  const onlyDelegated = !!opts?.onlyDelegated;
  const coverOf = (bbl: string) => {
    if (!onlyDelegated) return { kind: "agent" as const, who: "Your agent" };
    return deskCoverage(s, bbl);
  };

  // --- TOURS FIRST ----------------------------------------------------------
  // Several parties on one suite is one decision, not N popups. If exactly one
  // letter clears the sign line and the cheque, the desk takes it and the rest
  // go elsewhere. Only a true dead heat comes back to you.
  const tourIds = [...new Set(
    s.lois.filter((l) => !l.referred && l.tourId !== undefined).map((l) => l.tourId!),
  )];
  for (const tid of tourIds) {
    const party = s.lois.filter((l) => l.tourId === tid && !l.referred);
    if (party.length <= 1) continue;
    const cover = coverOf(party[0].bbl);
    if (!cover) continue;
    const feeRate = deskFee(cover.kind, party[0]);
    const scored = party.map((loi) => {
      const h = s.holdings[loi.bbl];
      const rec = resolveRec(parcels, s, loi.bbl);
      if (!h || !rec) return null;
      const market = loiMarket(s, rec, h, loi);
      const v = deskVerdict(s, loi, market, feeRate, { ignoreTour: true, cover: cover.kind });
      return {
        loi, h, rec, market, ...v,
        fundable: v.verdict === "sign" && agentCanFund(s, loi, feeRate),
      };
    }).filter((x): x is NonNullable<typeof x> => !!x);

    const winners = scored.filter((x) => x.fundable);
    if (winners.length === 1) {
      const w = winners[0];
      const before = w.h.tenants.length;
      delete (s as GameState & { _signFailed?: string })._signFailed;
      signLoi(s, w.rec, w.h, w.loi, feeRate);
      const failed = (s as GameState & { _signFailed?: string })._signFailed
        || w.h.tenants.length <= before;
      delete (s as GameState & { _signFailed?: string })._signFailed;
      if (failed) {
        agentReferLoi(s, w.loi, w.rec, "the desk tried to sign the clear winner and could not demise the space", cover.who);
        for (const x of scored) {
          if (x.loi.id === w.loi.id) continue;
          if (x.verdict === "pass") agentPassLoi(s, x.loi, x.rec, x.score, x.market, x.pass, cover.who);
          else if (x.verdict === "counter") {
            agentNegotiateLoi(s, parcels, x.loi, x.rec, x.h, x.market, feeRate, x.adjFloor, x.adjPass, cover.who, cover.kind);
          } else {
            agentReferLoi(s, x.loi, x.rec,
              x.why ?? `net effective ${(x.score * 100).toFixed(0)}% of market, under your ${Math.round(x.floor * 100)}% sign line`,
              cover.who);
          }
        }
        continue;
      }
      bumpDeskMonth(s, "signed");
      const lost = party.filter((l) => l.id !== w.loi.id);
      s.lois = s.lois.filter((l) => l.tourId !== tid);
      if (lost.length) {
        s.news.unshift({
          q: s.month, kind: "info",
          text: `${cover.who} took ${w.loi.name} for the contested space at ${w.rec.address}; `
            + `${lost.map((l) => l.name).join(" and ")} ${lost.length > 1 ? "have" : "has"} gone elsewhere.`,
        });
      }
      continue;
    }
    if (winners.length > 1) {
      for (const x of scored) {
        if (x.fundable) {
          agentReferLoi(s, x.loi, x.rec,
            `clears your mandate with ${x.score >= 1 ? "par-or-better" : `${(x.score * 100).toFixed(0)}% of market`} net effective, and so does another party on the same suite — you choose`,
            cover.who);
        } else if (x.verdict === "pass") {
          agentPassLoi(s, x.loi, x.rec, x.score, x.market, x.pass, cover.who);
        } else {
          agentReferLoi(s, x.loi, x.rec,
            x.why ?? `net effective ${(x.score * 100).toFixed(0)}% of market, under your ${Math.round(x.floor * 100)}% sign line`,
            cover.who);
        }
      }
      continue;
    }
    // Nobody clears a sign — negotiate the strongest soft letter; pass junk.
    const soft = scored
      .filter((x) => x.verdict === "counter")
      .sort((a, b) => b.score - a.score);
    let tourResolved = false;
    for (const x of soft) {
      if (!s.lois.some((l) => l.id === x.loi.id)) continue;
      agentNegotiateLoi(s, parcels, x.loi, x.rec, x.h, x.market, feeRate, x.adjFloor, x.adjPass, cover.who, cover.kind);
      if (!s.lois.some((l) => l.tourId === tid && !l.referred)) {
        // Signed or walked the last open party — clear stragglers that passed.
        s.lois = s.lois.filter((l) => l.tourId !== tid || l.referred);
        tourResolved = true;
        break;
      }
      // Signed one mid-band into a real tenant — rest of the tour is gone.
      if (!s.lois.some((l) => l.id === x.loi.id) && x.h.tenants.some((t) => t.name === x.loi.name)) {
        const lost = party.filter((l) => l.id !== x.loi.id);
        s.lois = s.lois.filter((l) => l.tourId !== tid);
        if (lost.length) {
          s.news.unshift({
            q: s.month, kind: "info",
            text: `${cover.who} negotiated ${x.loi.name} onto the contested space at ${x.rec.address}; `
              + `${lost.map((l) => l.name).join(" and ")} ${lost.length > 1 ? "have" : "has"} gone elsewhere.`,
          });
        }
        tourResolved = true;
        break;
      }
    }
    if (tourResolved) continue;
    for (const x of scored) {
      if (!s.lois.some((l) => l.id === x.loi.id) || x.loi.referred) continue;
      if (x.verdict === "pass") agentPassLoi(s, x.loi, x.rec, x.score, x.market, x.pass, cover.who);
      else if (x.verdict === "counter") {
        // Already negotiated above and still live → referred inside negotiate.
      } else {
        agentReferLoi(s, x.loi, x.rec,
          x.why ?? `net effective ${(x.score * 100).toFixed(0)}% of market, under your ${Math.round(x.floor * 100)}% sign line`,
          cover.who);
      }
    }
  }

  for (const loi of [...s.lois]) {
    if (loi.referred) continue;
    if (
      loi.tourId !== undefined
      && s.lois.filter((x) => x.tourId === loi.tourId).length > 1
    ) continue;
    const cover = coverOf(loi.bbl);
    if (!cover) continue;
    const h = s.holdings[loi.bbl];
    const rec = resolveRec(parcels, s, loi.bbl);
    if (!h || !rec) continue;
    const feeRate = deskFee(cover.kind, loi);
    const market = loiMarket(s, rec, h, loi);
    const { verdict, score, floor, pass, adjFloor, adjPass, why } =
      deskVerdict(s, loi, market, feeRate, { cover: cover.kind });
    if (verdict === "pass") {
      agentPassLoi(s, loi, rec, score, market, pass, cover.who);
      continue;
    }
    if (verdict === "refer") {
      agentReferLoi(s, loi, rec,
        why ?? `net effective ${(score * 100).toFixed(0)}% of market, under your ${Math.round(floor * 100)}% sign line`,
        cover.who);
      continue;
    }
    if (verdict === "counter") {
      agentNegotiateLoi(s, parcels, loi, rec, h, market, feeRate, adjFloor, adjPass, cover.who, cover.kind);
      continue;
    }
    if (!agentCanFund(s, loi, feeRate)) {
      agentReferLoi(s, loi, rec,
        `signing needs ${money(loiSigningCost(loi, feeRate))} and would leave less than the ${money(agentCashReserve(s))} treasury reserve`,
        cover.who);
      continue;
    }
    const before = h.tenants.length;
    delete (s as GameState & { _signFailed?: string })._signFailed;
    signLoi(s, rec, h, loi, feeRate);
    const failed = (s as GameState & { _signFailed?: string })._signFailed
      || (loi.kind === "new" && h.tenants.length <= before);
    delete (s as GameState & { _signFailed?: string })._signFailed;
    if (failed) {
      agentReferLoi(s, loi, rec, "the desk tried to sign and could not demise the space", cover.who);
      continue;
    }
    bumpDeskMonth(s, "signed");
    s.lois = s.lois.filter((l) => l.id !== loi.id);
  }
}

/** @deprecated Prefer runLeasingAgent — kept as the tick's private name. */
function runAgent(s: GameState, parcels: ParcelTable) {
  runLeasingAgent(s, parcels);
}

/** Exclusives — negotiate without the firm-wide agent. */
function runDelegatedLeasing(s: GameState, parcels: ParcelTable) {
  runLeasingAgent(s, parcels, { onlyDelegated: true });
}

/**
 * Clear live letters under whoever currently holds the pen — hire path.
 * Same logic as the end of tickLeasing, so flipping agent / exclusive /
 * renewal management does not leave a month of popups on the open pile.
 * Hiring leasing staff alone does not clear the pile.
 */
export function workLeasingDesk(s: GameState, parcels: ParcelTable) {
  if (s.agent) runLeasingAgent(s, parcels);
  else {
    runDelegatedLeasing(s, parcels);
    if (s.renewalMgmt) runRenewalDesk(s, parcels);
  }
}

/**
 * PROPERTY MANAGEMENT SIGNS THE RENEWALS — see GameState.renewalMgmt.
 *
 * Only `kind: "renewal"`. A new-lease letter still lands on the player's desk,
 * because that is the decision worth having.
 *
 * WHAT IT COSTS, AND THE REASON THAT IS NOT ZERO. This handed the mandate over
 * at `loiSigningCost(loi)` — the plain in-house rate — and the comment that
 * used to be here said so approvingly: "at whatever leaseCosts already charges
 * for one, which is 2%." So did the button in the UI: "the same 2% a renewal
 * has always cost." Both were describing a service that was FREE. A desk that
 * signs your at-market renewals for you at no incremental cost is not a choice,
 * it is a strictly dominant one, and a dominant strategy is a thing this repo
 * has a harness looking for.
 *
 * A manager is a SECOND party and gets paid like one. The letter still carries
 * the ordinary renewal commission it has always carried, and the manager's
 * mandate is `RENEWAL_MGMT_FEE` of total lease value on top — so handing them
 * over costs exactly the 2% of lease value it says on the tin, and doing it
 * yourself still costs what it always did. Same shape as `AGENT_FEE`: an
 * exclusive that stacked six points on top of four would charge you twice for
 * one transaction, and this does not, because there are two people here.
 *
 * The floor is the same player-set net-effective sign line `runAgent` uses
 * (90% by default): a manager with a mandate
 * still will not sign a renewal well under the market — they refer it back, and
 * it becomes the owner's problem again, which is exactly what happens when the
 * number is bad enough to need a principal.
 */
/** The manager's cut of a renewal they sign, on total lease value. */
export const RENEWAL_MGMT_FEE = 0.02;
/** What a renewal letter has always cost to sign — see leaseCosts. */
const RENEWAL_SELF_FEE = 0.02;
function runRenewalDesk(s: GameState, parcels: ParcelTable) {
  for (const loi of [...s.lois]) {
    if (loi.kind !== "renewal") continue;
    if (loi.referred) continue;
    // Firm agent / exclusive / leasing staff already worked this letter.
    if (deskCoverage(s, loi.bbl)) continue;
    const h = s.holdings[loi.bbl];
    const rec = resolveRec(parcels, s, loi.bbl);
    if (!h || !rec) continue;
    const market = loiMarket(s, rec, h, loi);
    const rate = RENEWAL_SELF_FEE + RENEWAL_MGMT_FEE;
    // Renewal management is outside coverage — mid competence, not your leasing hire.
    const { verdict, score, floor, pass, adjFloor, adjPass, why } =
      deskVerdict(s, loi, market, rate, { cover: "exclusive" });
    if (verdict === "pass") {
      bumpDeskMonth(s, "passed");
      s.lois = s.lois.filter((l) => l.id !== loi.id);
      s.news.unshift({
        q: s.month, kind: "info",
        text: `Management passed on ${loi.name}'s renewal at ${rec.address} — net effective `
          + `${(score * 100).toFixed(0)}% of market (pass below ${Math.round(pass * 100)}%).`,
      });
      continue;
    }
    if (verdict === "refer") {
      bumpDeskMonth(s, "referred");
      loi.referred = true;
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `Management referred ${loi.name}'s renewal at ${rec.address} back to you — `
          + (why ?? `net effective ${(score * 100).toFixed(0)}% of market, under your ${Math.round(floor * 100)}% sign line`)
          + `.`,
      });
      continue;
    }
    if (verdict === "counter") {
      agentNegotiateLoi(s, parcels, loi, rec, h, market, rate, adjFloor, adjPass, "Management", "exclusive");
      continue;
    }
    // The letter's own commission plus the manager's mandate — see above.
    const cost = loiSigningCost(loi, rate);
    const reserve = agentCashReserve(s);
    if (s.cash - cost < reserve) {
      bumpDeskMonth(s, "referred");
      loi.referred = true;
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `Management would renew ${loi.name} at ${rec.address}, but signing needs `
          + `${money(cost)} and would breach the ${money(reserve)} treasury reserve. Back on your desk.`,
      });
      continue;
    }
    signLoi(s, rec, h, loi, rate);
    bumpDeskMonth(s, "signed");
    s.lois = s.lois.filter((l) => l.id !== loi.id);
  }
}

function leaseCosts(loi: LOI, feeRate?: number): { ti: number; lc: number } {
  const ti = loi.tiPsf * loi.sf;
  const rate = feeRate ?? (loi.kind === "new" ? 0.04 : 0.02);
  const lc = loi.rentPsf * loi.sf * (loi.termM / 12) * rate;
  return { ti: Math.round(ti), lc: Math.round(lc) };
}

export function loiSigningCost(loi: LOI, feeRate?: number): number {
  const { ti, lc } = leaseCosts(loi, feeRate);
  return ti + lc;
}

// Put a signed lease on the rent roll. Mutates — both the player's own
// response and the agent's automatic signing come through here.
/**
 * WHAT A LANDLORD HOLDS AGAINST THE SPACE.
 *
 * One to two months of rent, and which end of that you get is a credit
 * question: a covenant everybody has heard of writes one month and argues
 * about it, a start-up with no history writes two and is glad to. It is cash
 * in and a liability on the balance sheet, never income — see Tenant.deposit.
 */
export function depositFor(s: GameState, rentPsf: number, sf: number, credit: Credit): number {
  const monthly = (rentPsf * sf) / 12;
  const months = credit === 2 ? 1.0 : credit === 1 ? rrange(s, 1.2, 1.6, "leasing") : rrange(s, 1.6, 2.0, "leasing");
  return Math.round(monthly * months);
}

/**
 * THE DEPOSITS ON ONE BUILDING, handed to the buyer at the closing table.
 *
 * Deposits arrive as cash and leave as cash, and the one path that had neither
 * was a DISPOSAL: the holding disappeared, the liability with it, and the
 * money stayed in your account. Over fifty years of trading that is a slow,
 * invisible subsidy — and it was worth about three times the competent
 * player's median result before the invariant caught it.
 */
export function depositsOn(h: Holding): number {
  return h.tenants.reduce((a, t) => a + (t.deposit ?? 0), 0);
}

/** Every deposit you are sitting on. Cash you hold and do not own. */
export function depositsHeld(s: GameState): number {
  let n = 0;
  for (const h of Object.values(s.holdings)) {
    for (const t of h.tenants) n += t.deposit ?? 0;
  }
  return n;
}

export function signLoi(s: GameState, rec: ParcelRecord, h: Holding, l: LOI, feeRate?: number) {
  // A tenant moving into pre-built space USES IT UP. The suite is theirs now;
  // the next prospect tours a shell again unless you build more.
  if (l.kind === "new" && h.specSuites && h.specSuites.use === (l.use ?? rec.class) && s.month >= h.specSuites.readyM) {
    h.specSuites.sf -= l.sf;
    if (h.specSuites.sf < 800) delete h.specSuites;
  }
  const cost = loiSigningCost(l, feeRate);
  s.cash -= cost;
  logBooks(s, "leasing", cost);
  if (l.kind === "expansion" && l.tenantIdx !== undefined && h.tenants[l.tenantIdx]) {
    // THE SPACE NEXT DOOR. The old floor keeps its rent and the new floor takes
    // today's, so what the row shows afterwards is the blend — which is what a
    // rent roll actually shows after an expansion. Same clamp as a new lease:
    // if the other live letter took the suite first, this one lost it.
    const t = h.tenants[l.tenantIdx];
    const use = l.use ?? t.use ?? (rec.class as BuiltClass);
    const add = Math.min(l.sf, Math.max(0, useVacantSf(rec, h, use, s.month)));
    if (add < minTenancySf(rec, use)) {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `${l.name} lost the expansion space at ${rec.address} — the other letter signed first, and what is left will not demise.`,
      });
      // Same flag as the new-lease branch. An expansion that signs nothing has
      // to come back to the player as an error rather than as silence.
      (s as GameState & { _signFailed?: string })._signFailed =
        `${l.name} lost the expansion space — the other letter signed first, and `
        + `the ${Math.round(add).toLocaleString()} sf left will not demise.`;
      return;
    }
    t.rentPsf = +(((t.rentPsf * t.sf) + (l.rentPsf * add)) / (t.sf + add)).toFixed(2);
    t.sf += add;
    t.staff = Math.min(t.staff ?? 1, 1.05);
    // Expansion keeps one escalator on the blended lease — the letter's rate.
    t.bumpPct = bumpOf(l);
    noteTenantSfChange(s, use, -add);
    const top = depositFor(s, t.rentPsf, t.sf, t.credit) - (t.deposit ?? 0);
    s.cash += top;
    t.deposit = (t.deposit ?? 0) + top;
  } else if (l.kind === "renewal" && l.tenantIdx !== undefined && h.tenants[l.tenantIdx]) {
    const t = h.tenants[l.tenantIdx];
    // THEY ARE RENEWING FOR LESS. The space they hand back is space, and it
    // turns like any other giveback before anybody can be shown it.
    if (l.sf < t.sf) {
      const freed = t.sf - l.sf;
      h.makeReady = [...(h.makeReady ?? []), { sf: freed, readyM: s.month + 3, use: t.use }];
      noteTenantSfChange(s, (t.use ?? dominantUse(rec)) as BuiltClass, freed);
      t.sf = l.sf;
      t.staff = Math.min(t.staff ?? 1, 1);
    }
    t.rentPsf = l.rentPsf;
    t.endM = s.month + l.termM;
    t.bumpPct = bumpOf(l);
    // FREE MONTHS ON A RENEWAL ARE REAL. Letters were generating them and the
    // signing path only stamped freeUntilM on new leases, so a renewal that
    // "won" three months of free rent paid from day one. Same clock as a new
    // deal: base rent is on the roll, NOI waits.
    t.freeUntilM = l.freeM ? s.month + l.freeM : undefined;
    // A renewal RESETS the base year. That is the quiet half of every renewal
    // negotiation: the tenant gives up years of accumulated recovery, and the
    // owner gives up the rent they could have pushed. Rolling the stop forward
    // is often worth more than the spread on the rent.
    if (recoveryOf(t) === "base") t.baseStopPsf = +stopPsfNow(rec, s.econ, h, t.use).toFixed(2);
    // AND THE DEPOSIT IS TRUED UP. It was struck against the rent of the day it
    // was signed and then sat there while the rent escalated for twenty years
    // or got cut in a blend-and-extend — which is how a deposit ends up worth
    // four months of a reduced rent. Every renewal restates it, and the
    // difference moves in cash the way it does at a real renewal.
    const wanted = depositFor(s, t.rentPsf, t.sf, t.credit);
    s.cash += wanted - (t.deposit ?? 0);
    t.deposit = wanted;
  } else {
    // An LOI was sized against the vacancy on the day it was written. Two of
    // them can be live at once, so the second one signs against whatever is
    // left — you cannot lease the same floor twice.
    // Residential is modelled as OCCUPANCY, never as named tenants, so the
    // fallback has to come off the leasable (commercial) uses. dominantUse can
    // return multifamily, and did.
    const use = l.use ?? leasableUses(rec)[0] ?? "office";
    const sf = Math.min(l.sf, Math.max(0, useVacantSf(rec, h, use, s.month)));
    // AND THE FLOOR HOLDS HERE TOO. The clamp above shrinks a signed letter to
    // whatever is actually left after the other live one signed, and it only
    // guarded against zero — so a 4,000 ft letter could quietly become a 900 ft
    // lease against a floor that says 2,000. If what is left is not a suite,
    // the deal died when the other one signed; that is what "you cannot lease
    // the same floor twice" costs.
    const floorSf = minTenancySf(rec, use);
    if (sf < floorSf) {
      // AND IT IS SAID OUT LOUD. A news line scrolls past; what the player
      // needs is the thing they just clicked telling them why it did nothing.
      // signLoi cannot return an error, so it raises a flag the caller turns
      // into one — see respondLOI.
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `${l.name} lost the space at ${rec.address} — the other letter signed first and what is left `
          + `(${Math.round(sf).toLocaleString()} sf) is under the ${floorSf.toLocaleString()} sf minimum. `
          + `Two live letters on one floor is a race, and somebody always loses it.`,
      });
      (s as GameState & { _signFailed?: string })._signFailed =
        `${l.name} lost the space — the other letter signed first, and the `
        + `${Math.round(sf).toLocaleString()} sf left will not demise.`;
      return;
    }
    const deposit = depositFor(s, l.rentPsf, sf, l.credit);
    s.cash += deposit;
    h.tenants.push({
      name: l.name, use, sector: l.sector, credit: l.credit,
      sf, rentPsf: l.rentPsf, bumpPct: bumpOf(l), net: l.net,
      recovery: l.recovery ?? (l.net ? "nnn" : "gross"),
      baseStopPsf: +stopPsfNow(rec, s.econ, h, use).toFixed(2),
      startM: s.month, endM: s.month + l.termM,
      freeUntilM: l.freeM ? s.month + l.freeM : undefined,
      deposit,
    });
    noteTenantSfChange(s, use, -sf);
  }
  // Say what the roll looks like NOW. "Lease signed" with a free-rent period
  // and unchanged NOI was reading as a no-op — the tenant is on the roll and
  // the building is more full, even when the cheque has not started.
  const leasedSf = h.tenants.reduce((a, t) => a + t.sf, 0);
  const occPct = rec.bldgArea > 0 ? Math.min(100, (100 * leasedSf) / rec.bldgArea) : 0;
  const freeNote = l.freeM
    ? ` Free rent through ${monthLabel(s.month + l.freeM)} — base rent is on the roll but not yet in NOI.`
    : "";
  s.news.unshift({
    q: s.month, kind: "deal",
    text: `Signed${feeRate === AGENT_FEE ? " by your agent" : ""}: ${l.name} — ${l.sf.toLocaleString()} sf at ${rec.address}, $${l.rentPsf.toFixed(0)}/sf, ${(l.termM / 12).toFixed(0)} yrs, ${bumpOf(l).toFixed(2)}%/yr${l.kind === "renewal" ? " (renewal)" : ""}. `
      + `Building is ${occPct.toFixed(0)}% let. Upfront TI and commission: ${money(cost)}.${freeNote}`,
  });
  if (l.sf >= Math.max(25_000, rec.bldgArea * 0.15)) {
    recordPropertyEvent(s, l.bbl, {
      kind: "major-lease",
      party: l.name,
      sf: l.sf,
      amount: Math.round(l.rentPsf * l.sf),
      outcome: `${Math.round(l.termM / 12)}-year ${l.kind}`,
    });
  }
}

export type LOIAction = "accept" | "counter" | "decline";

/**
 * Answer a letter of intent.
 *
 * `fund` draws the shortfall on the line of credit as part of the same action.
 * It has to happen in here rather than as two calls from the UI: signing a
 * lease you cannot fund is the one path where the player has no move left, and
 * a draw that lands without the signature following it is worse than either.
 */
export function respondLOI(
  s: GameState, parcels: ParcelTable, id: number, action: LOIAction, fund = false,
  counter?: { rentPsf?: number; tiPsf?: number; freeM?: number; bumpPct?: number; bestFinal?: boolean },
): { s: GameState; msg: string; err?: string } {
  const next: GameState = cloneState(s);
  const loi = next.lois.find((l) => l.id === id);
  if (!loi) return { s, msg: "", err: "That LOI is gone." };
  const h = next.holdings[loi.bbl];
  const rec = resolveRec(parcels, next, loi.bbl);
  if (!h || !rec) return { s, msg: "", err: "You no longer control that building." };
  if (h.groundLeased) {
    next.lois = next.lois.filter((l) => l.id !== id);
    return { s: next, msg: "", err: "That fee is ground-leased — the lessee lets the building, not you." };
  }

  let drawn = 0;
  // Whoever holds the file the day the letter is signed is who gets paid, and
  // an exclusive on this building takes six points of the base rent over the
  // term instead of the 4%/2% your own leasing department costs.
  const fee = exclusiveFeeRate(h);
  const sign = (l: LOI): string | null => {
    const cost = loiSigningCost(l, fee);
    if (next.cash < cost) {
      const short = Math.ceil((cost - next.cash) / 1000) * 1000;
      if (!fund) return `Signing costs ${money(cost)} (TI + commission) — you're short ${money(short)}.`;
      const avail = locAvailable(next, parcels);
      if (short > avail) {
        return `Signing costs ${money(cost)}. You're short ${money(short)} and the line only has ${money(avail)} left.`;
      }
      const d = drawLoc(next, parcels, short);
      if (d.err) return d.err;
      // drawLoc returns a fresh clone. Assigning it over `next` replaces every
      // holding object — any `h` captured before this line is an orphan. The
      // playtester failure mode: Accept / "they took your counter" toasted a
      // signed lease (signLoi mutated the orphan, occ% was read off it) while
      // the real rent roll stayed empty and new letters kept arriving.
      Object.assign(next, d.s);
      drawn = short;
    }
    const holding = next.holdings[l.bbl];
    if (!holding) return "You no longer control that building.";
    const flagged = next as GameState & { _signFailed?: string };
    delete flagged._signFailed;
    signLoi(next, rec, holding, l, fee);
    // signLoi has one path that legitimately signs nothing — the space it was
    // written against went while the letter sat on the desk. That has to come
    // back as an ERROR the player sees, not as silence.
    if (flagged._signFailed) {
      const why = flagged._signFailed;
      delete flagged._signFailed;
      return why;
    }
    return null;
  };
  const drawNote = () => (drawn ? ` Drew ${money(drawn)} on the line to fund it.` : "");

  // TAKING ONE PARTY MEANS LOSING THE OTHERS. Everybody on this tour was
  // chasing the same square feet; the moment it is spoken for, the rest go and
  // look at somebody else's building. This is the cost that Accept never had —
  // not that signing is bad, but that you cannot sign all of them.
  const sweepTour = (l: LOI) => {
    if (l.tourId === undefined) return;
    const lost = next.lois.filter((o) => o.tourId === l.tourId && o.id !== l.id);
    if (!lost.length) return;
    next.lois = next.lois.filter((o) => o.tourId !== l.tourId || o.id === l.id);
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${lost.map((o) => o.name).join(" and ")} ${lost.length > 1 ? "were" : "was"} chasing the same space at `
        + `${rec.address}. You gave it to ${l.name}; they have gone elsewhere.`,
    });
  };

  if (action === "accept") {
    const err = sign(loi);
    if (err) return { s, msg: "", err };
    sweepTour(loi);
    next.lois = next.lois.filter((l) => l.id !== id);
    const roll = next.holdings[loi.bbl] ?? h;
    const leasedSf = roll.tenants.reduce((a, t) => a + t.sf, 0);
    const occPct = rec.bldgArea > 0 ? Math.min(100, (100 * leasedSf) / rec.bldgArea) : 0;
    const freeBit = loi.freeM
      ? ` Free rent for ${loi.freeM} month${loi.freeM === 1 ? "" : "s"} — occupancy is up; cash flow waits.`
      : "";
    return {
      s: next,
      msg: `Lease signed — ${rec.address} is ${occPct.toFixed(0)}% let.${freeBit}` + drawNote(),
    };
  }

  if (action === "counter") {
    // Once they have countered back, the number on the table is final —
    // accept it or lose them. No third round; nobody negotiates forever.
    if (loi.stage === "countered") return { s, msg: "", err: "Their counter was final. Take it or pass." };
    if (loi.countered) return { s, msg: "", err: "You already countered — they're deciding." };
    loi.countered = true;
    // GOING BACK TO ONE PARTY COSTS YOU THE PATIENCE OF THE OTHERS.
    //
    // Everybody on this tour knows they are being shopped. Push the one you
    // want and the fallbacks give you a month, not three — so pushing the
    // covenant for rent can leave you with the covenant gone AND the start-up
    // gone, and a 25-month wait for the next prospect. That wait used to be the
    // only outcome of being fussy; now it is the punishment for being greedy.
    for (const o of next.lois) {
      if (o.tourId !== undefined && o.tourId === loi.tourId && o.id !== loi.id) {
        o.expiresM = Math.min(o.expiresM, next.month + 1);
      }
    }
    if (loi.openRentPsf === undefined) loi.openRentPsf = loi.rentPsf;
    if (loi.openTiPsf === undefined) loi.openTiPsf = loi.tiPsf;
    if (loi.openFreeM === undefined) loi.openFreeM = loi.freeM;
    if (loi.openBumpPct === undefined) loi.openBumpPct = bumpOf(loi);
    // YOUR terms off the sliders — rent, TI, free months and the bump.
    // Defaults keep the old harness shape (+6% rent / −30% TI / free unchanged).
    const askRent = counter?.rentPsf !== undefined ? +counter.rentPsf.toFixed(2) : +(loi.rentPsf * 1.06).toFixed(2);
    const askTi = counter?.tiPsf !== undefined ? Math.round(counter.tiPsf) : Math.round(loi.tiPsf * 0.7);
    const askFree = counter?.freeM !== undefined
      ? Math.max(0, Math.round(counter.freeM))
      : loi.freeM;
    const askBump = counter?.bumpPct !== undefined
      ? Math.round(clampL(counter.bumpPct, 0, 5) * 4) / 4
      : bumpOf(loi);
    const market = managedRentPsfYr(rec, next.econ, h, loi.use);
    const openTi = loi.openTiPsf;
    const openFree = loi.openFreeM;
    const openBump = loi.openBumpPct;
    const openedAt = loi.openRentPsf;
    // NET EFFECTIVE — face after free months, TI delta, and bump vs the 2.5%
    // standard. Same quantity the counter card shows.
    const years = Math.max(1, loi.termM / 12);
    const paidFrac = 1 - Math.min(0.45, askFree / Math.max(1, loi.termM));
    const tiRent = (TI_VALUE * (openTi - askTi)) / years;    // + when you take fit-out away
    const neAsk = askRent * paidFrac + tiRent + bumpPremiumPsf(askRent, askBump, loi.termM);
    const f = neAsk / Math.max(1, market);                   // aggression vs the market
    const vacHere = (next.econ.cityVac?.[loi.use ?? "office"] ?? 0.1);
    const natHere = loi.use === "multifamily" ? 0.045 : loi.use === "retail" ? 0.085 : loi.use === "industrial" ? 0.07 : 0.115;
    const tight = Math.max(-0.3, Math.min(0.35, (natHere - vacHere) * 3));
    // BEST AND FINAL. Saying the number is firm is itself information: it
    // converts some hagglers, because a credible take-it-or-leave-it within
    // reach is easier to sign than to shop — and it hardens the rest, because
    // you have taken away their move. There is no counter-back branch at all:
    // one letter goes out, and the answer is a signature or an empty hallway.
    const bestFinal = counter?.bestFinal === true;
    // WHERE THE TENANT IS INDIFFERENT, WHICH IS NOT THE MARKET RENT.
    //
    //   SWITCH   what a mover pays to avoid moving on
    //   stick    an incumbent's premium on top — relocation, not just search
    //   tight    fewer alternatives, so more tolerance
    //   credit   better covenants are stickier here
    //
    // In a balanced market a new prospect countered AT the market signs about
    // 70% of the time; 20% over market is under a fifth.
    const SWITCH = 0.06;
    const stick = loi.kind === "renewal" ? 0.10 : 0;
    // Vacancy softens landlords in life AND stiffens tenants less — a soft
    // market also means the tenant has alternatives, so stickiness earns less.
    // The old curve only shifted fStar up in tight markets; a soft market now
    // pulls it down a notch so "push past market while half the block is empty"
    // is the losing ask it should be.
    const softDrag = Math.max(0, -tight) * 0.12;
    const fStar = 1 + SWITCH + stick + tight * 0.35 - softDrag + loi.credit * 0.015
      + (next.econ.phase === "expansion" ? 0.05
        : next.econ.phase === "recession" || next.econ.phase === "depression" ? -0.06 : 0);
    const W = 0.085;
    const pAccept = Math.max(0.04, Math.min(0.95,
      1 / (1 + Math.exp((f - fStar) / W)) + (bestFinal ? 0.05 : 0)));
    loi.askedRentPsf = askRent;
    loi.askedTiPsf = askTi;
    loi.askedFreeM = askFree;
    loi.askedBumpPct = askBump;
    loi.rentPsf = askRent;
    loi.tiPsf = askTi;
    loi.freeM = askFree;
    loi.bumpPct = askBump;
    // WHAT THEY SAID BACK, kept where you can read it after the card is gone.
    const reply = (
      outcome: "took" | "walked" | "countered",
      theirRent: number, theirTi: number, theirFree: number, theirBump: number,
    ) => {
      if (!next.leaseReplies) next.leaseReplies = [];
      next.leaseReplies.unshift({
        m: next.month, bbl: loi.bbl, address: rec.address, name: loi.name, outcome,
        askedRentPsf: askRent, theirRentPsf: +theirRent.toFixed(2),
        askedTiPsf: askTi, theirTiPsf: theirTi,
        askedFreeM: askFree, theirFreeM: theirFree,
        askedBumpPct: askBump, theirBumpPct: theirBump,
        sf: loi.sf, marketPsf: +market.toFixed(2),
      });
      next.leaseReplies = next.leaseReplies.slice(0, 8);
    };
    if (rng(next) < pAccept) {
      const err = sign(loi);
      if (err) {
        // They said yes — a funding shortfall kills the deal. A same-month
        // space race is not a funding failure; keep the letter (and any LOC
        // draw already on `next`) out of a false "could not fund" funeral.
        if (/lost the space|demise|lost the expansion|no longer control/i.test(err)) {
          return { s: next, msg: "", err };
        }
        next.lois = next.lois.filter((l) => l.id !== id);
        next.news.unshift({ q: next.month, kind: "warn", text: `${loi.name} took your counter at ${rec.address} and you could not fund the fit-out. The deal died.` });
        return { s: next, msg: "", err };
      }
      next.lois = next.lois.filter((l) => l.id !== id);
      sweepTour(loi);
      reply("took", askRent, askTi, askFree, askBump);
      const bits: string[] = [];
      if (askRent !== openedAt) bits.push(`${money((askRent - openedAt) * loi.sf)} a year ${askRent > openedAt ? "more" : "less"} face rent`);
      if (openTi !== askTi) bits.push(`${money(Math.abs(openTi - askTi) * loi.sf)} ${askTi < openTi ? "less" : "more"} fit-out`);
      if (openFree !== askFree) bits.push(`${Math.abs(openFree - askFree)} mo ${askFree < openFree ? "less" : "more"} free rent`);
      if (openBump !== askBump) bits.push(`${Math.abs(askBump - openBump).toFixed(2)} pts ${askBump > openBump ? "steeper" : "flatter"} bump`);
      next.news.unshift({
        q: next.month, kind: "deal",
        text: `${loi.name} took your counter at ${rec.address}: $${askRent.toFixed(2)}/sf`
          + (askFree > 0 ? ` with ${askFree} mo free` : "")
          + `, ${askBump.toFixed(2)}%/yr`
          + ` ($${neAsk.toFixed(2)}/sf net effective)`
          + (bits.length ? ` — ${bits.join(", ")}` : ".")
          + `.`,
      });
      return { s: next, msg: `${loi.name} took your counter — $${askRent.toFixed(2)}/sf net effective $${neAsk.toFixed(2)}.` + drawNote() };
    }
    // the further past market you pushed, the faster the door — and a firm
    // number leaves nowhere else for a refusal to go, so on best-and-final
    // everyone who does not take it walks.
    const pWalk = bestFinal ? 1 : Math.max(0.15, Math.min(0.92, 0.24 + (f - 1.0) * 2.2));
    if (rng(next) < pWalk) {
      next.lois = next.lois.filter((l) => l.id !== id);
      reply("walked", openedAt, openTi, openFree, openBump);
      next.news.unshift({
        q: next.month, kind: "warn",
        text: `${loi.name} walked on the counter at ${rec.address} — $${askRent.toFixed(2)}/sf`
          + (askFree !== openFree || tiRent > 0.005 || askBump !== openBump
            ? ` ($${neAsk.toFixed(2)}/sf net effective over ${years.toFixed(0)} years)`
            : "")
          + ` was more than the space was worth to them (market ~$${market.toFixed(2)}). `
          + `You had $${openedAt.toFixed(2)} on the table`
          + (openFree > 0 ? ` with ${openFree} mo free` : "")
          + `.`,
      });
      return { s: next, msg: `${loi.name} walked. You asked $${neAsk.toFixed(2)}/sf net effective against a $${market.toFixed(2)} market.` };
    }
    // they counter back once — final. Rent floor uses their OPENER, not the
    // ask we just wrote onto loi.rentPsf (that overwrite made every counter-
    // back floor at 94% of YOUR ask — almost no clawback).
    loi.stage = "countered";
    loi.counterRentPsf = +Math.min(
      askRent,
      Math.max(openedAt * 0.94, market * (0.95 + 0.04 * rng(next))),
    ).toFixed(2);
    loi.counterTiPsf = Math.round((askTi + openTi) / 2);
    // Free months split the same way — cutting them was previously free on
    // the counter-back branch because free rent was never part of the reply.
    loi.counterFreeM = Math.round((askFree + openFree) / 2);
    // Bump splits the same way: landlord pushes steeper, tenant pulls flatter.
    loi.counterBumpPct = Math.round(((askBump + openBump) / 2) * 4) / 4;
    loi.rentPsf = loi.counterRentPsf;
    loi.tiPsf = loi.counterTiPsf;
    loi.freeM = loi.counterFreeM;
    loi.bumpPct = loi.counterBumpPct;
    reply("countered", loi.counterRentPsf, loi.counterTiPsf, loi.counterFreeM, loi.counterBumpPct);
    next.news.unshift({
      q: next.month, kind: "info",
      text: `${loi.name} countered at ${rec.address}: you asked $${askRent.toFixed(2)}/sf`
        + (askFree > 0 || openFree > 0 ? ` / ${askFree} mo free` : "")
        + ` / ${askBump.toFixed(2)}%/yr`
        + `, they came back at $${loi.counterRentPsf.toFixed(2)}/sf with $${loi.counterTiPsf}/sf of TI`
        + (loi.counterFreeM > 0 ? ` and ${loi.counterFreeM} mo free` : "")
        + ` and ${loi.counterBumpPct.toFixed(2)}%/yr`
        + `. Final answer — take it or lose them.`,
    });
    return { s: next, msg: `${loi.name} came back at $${loi.counterRentPsf.toFixed(2)}/sf — final.` };
  }

  next.lois = next.lois.filter((l) => l.id !== id);
  return { s: next, msg: "Passed." };
}

// --------------------------------------------------------------- vacant possession
/**
 * BUYING A BUILDING EMPTY.
 *
 * There is no legal way to knock down an occupied building, and waiting out a
 * rent roll takes a decade. So you buy the leases: every sitting tenant is
 * offered the whole remaining value of their contract, plus a quarter again on
 * top for the inconvenience of moving a business they did not want to move.
 *
 * The premium is what makes this a decision rather than a button. A building
 * full of leases with eight years to run costs a fortune to empty, which is
 * precisely why the site under a well-let building is worth less than the site
 * under a half-empty one — and why the buildings that get redeveloped in real
 * cities are the ones whose leases were about to roll anyway.
 */
export const BUYOUT_PREMIUM = 1.25;

export function buyoutQuote(s: GameState, bbl: string): {
  cost: number; tenants: number; sf: number; deposits: number;
  rows: { name: string; monthsLeft: number; annual: number; cost: number }[];
} | null {
  const h = s.holdings[bbl];
  if (!h) return null;
  const rows = h.tenants.map((t) => {
    const monthsLeft = Math.max(0, t.endM - s.month);
    const annual = t.rentPsf * t.sf;
    return { name: t.name, monthsLeft, annual, cost: Math.round((annual / 12) * monthsLeft * BUYOUT_PREMIUM) };
  });
  return {
    cost: rows.reduce((a, r) => a + r.cost, 0),
    tenants: h.tenants.length,
    sf: h.tenants.reduce((a, t) => a + t.sf, 0),
    deposits: h.tenants.reduce((a, t) => a + (t.deposit ?? 0), 0),
    rows,
  };
}

export function buyOutTenants(
  s: GameState, parcels: ParcelTable, bbl: string,
): { s: GameState; err?: string; msg?: string } {
  const h0 = s.holdings[bbl];
  if (!h0) return { s, err: "You don't own that." };
  if (h0.groundLeased) return { s, err: "The ground lessee lets that building — there is no roll of yours to buy out." };
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const q = buyoutQuote(s, bbl);
  if (!q || (!q.tenants && !(h0.occ ?? 0))) return { s, err: "Nobody to buy out — it is already empty." };
  // Flats run on aggregate occupancy rather than named leases, so the cost of
  // clearing them is a year of the residential income at the same premium.
  const resSf = useSf(rec, "multifamily") * (h0.occ ?? 0);
  const resCost = Math.round(resSf * useRentPsfYr(rec, s.econ, h0.condition, "multifamily") * BUYOUT_PREMIUM);
  const total = q.cost + resCost;
  if (total <= 0) return { s, err: "Nobody to buy out — it is already empty." };
  if (s.cash < total) {
    return { s, err: `Clearing the building costs ${money(total)} — you're short ${money(total - s.cash)}.` };
  }
  const next: GameState = cloneState(s);
  const h = next.holdings[bbl]!;
  next.cash -= total;
  // The deposits go back with them; they were never yours.
  next.cash -= q.deposits;
  logBooks(next, "leasing", total);
  const n = h.tenants.length;
  const sf = q.sf + Math.round(resSf);
  h.tenants = [];
  h.occ = 0;
  h.makeReady = [];
  // Nobody is being let in behind them, or the whole exercise is pointless.
  h.leasingHold = true;
  next.lois = next.lois.filter((l) => l.bbl !== bbl);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Bought out every lease at ${rec.address}: ${n} tenant${n === 1 ? "" : "s"} and `
      + `${(sf / 1000).toFixed(1)}k sf for ${money(total)}, at ${((BUYOUT_PREMIUM - 1) * 100).toFixed(0)}% over the remaining contracts. `
      + `The building is empty and letting is stopped — it is a site now.`,
  });
  return { s: next, msg: `Empty. ${money(total)} to clear it.` };
}

/** Stop or restart letting a building — the switch you throw before a demolition. */
export function setLeasingHold(s: GameState, bbl: string, on: boolean): GameState {
  const h = s.holdings[bbl];
  if (!h || h.groundLeased) return s;
  const next: GameState = cloneState(s);
  next.holdings[bbl].leasingHold = on || undefined;
  if (on) next.lois = next.lois.filter((l) => l.bbl !== bbl);
  return next;
}
