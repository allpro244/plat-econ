// THE COMPS SHEET.
//
// The game could tell you what the city's vacancy was doing and what your own
// buildings were worth, and it could not tell you what anything had actually
// traded for. That is backwards. An appraisal is an opinion; a closed sale is
// a fact, and forming a view out of facts is most of what this job is.
//
// Every deed that moves is recorded here — price, price per foot, the going-in
// cap rate on the price actually paid, who bought and who sold. Two things
// come out of it that nothing else in the game provides:
//
//   • A read on the market that is not the engine telling you the answer. If
//     office is trading at 5.1% this year and traded at 6.4% three years ago,
//     you can see the repricing in the prints rather than in a stat block.
//   • A read on the other firms. A shop that has bought nine buildings in
//     eighteen months is levering into the top and you can watch them do it;
//     one that has printed four sales in a row is getting out.
import type { ParcelRecord } from "@/data/types";
import type { Condition, GameState, Sector } from "./types";
import type { Disclosure } from "./value";
import { initialCondition, noiAfterTaxYr, holdingNOIYr, asIfOwned, disclosureFor, landPsfNow, resolveRec } from "./value";
import { industryStress } from "./market";
import { recordPropertyEvent } from "./history";

export interface Comp {
  m: number;            // month it closed
  bbl: string;
  address: string;
  cls: string;
  price: number;
  sf: number;           // building area; 0 for dirt
  psf: number;          // $/sf of building, or of LAND when there is no building
  capRate: number;      // going-in on the price actually paid; 0 for land
  buyer: string;
  seller: string;
  distress?: boolean;
  /**
   * NEVER EXPOSED TO THE MARKET. A deed is a deed and this one is real, but
   * the price was never tested — no marketing, no second bidder, no evidence
   * anybody else would have paid it. An appraiser takes an off-market print
   * and weights it down for exactly that reason; they do not throw it away,
   * because it is still somebody's money. See `tickLandComps`.
   */
  offMarket?: boolean;
  /**
   * THE APPRAISAL THIS LOT CARRIED ON THE DAY IT CLOSED — dirt only.
   *
   * A comp is a price at a date. Comparing it to an appraisal at a DIFFERENT
   * date measures the months in between and calls the answer location. See
   * `tickLandComps`, which divided by it and got the sign backwards for it.
   */
  mark?: number;
}

const MAX_COMPS = 240;

/**
 * Record a closed sale. Called from every path where a deed moves — the
 * player buying, the player selling, and the street trading with itself —
 * because a comps sheet with only some of the trades in it is worse than none.
 */
export function recordComp(
  s: GameState, rec: ParcelRecord, price: number,
  buyer: string, seller: string, distress?: boolean, condition?: Condition,
  offMarket?: boolean,
) {
  if (!rec || price <= 0) return;
  recordPropertyEvent(s, rec.bbl, {
    kind: "trade",
    party: buyer,
    otherParty: seller,
    amount: Math.round(price),
    outcome: distress ? "distress sale" : offMarket ? "off-market" : "marketed",
  });
  if (!s.comps) s.comps = [];
  const built = rec.class !== "land" && rec.bldgArea > 0;
  const cond = condition ?? initialCondition(rec);
  // A COMP IS A FACT, AND SO IS THE CAP RATE ON IT.
  //
  // "The going-in cap rate on the price actually paid" was half a promise: the
  // price was real and the income was the class model's guess, computed from a
  // ParcelRecord that cannot see a rent roll. Measured over 3,195 buildings,
  // that guess ran 89% occupancy against real rolls at 69% — so the comps
  // sheet, the only place in this game that reports facts rather than
  // opinions, was printing a market whose yields nobody had earned.
  //
  // The roll comes from whichever side of the trade has it: the deed that just
  // moved, or the offering memorandum it moved out of. Either way it is
  // re-assessed at the price actually paid, because a sale reassesses — which
  // is what makes this the GOING-IN cap and not the seller's in-place cap.
  const h = s.holdings[rec.bbl];
  const d: Disclosure | null = h
    ? { roll: h.tenants, occ: h.occ, cond: condition ?? h.condition }
    : disclosureFor(s, rec.bbl);
  const noi = !built ? 0
    : d ? holdingNOIYr(rec, s.econ, asIfOwned(s, rec.bbl, price, d, rec), s.month)
    : noiAfterTaxYr(rec, s.econ, cond, price);
  const px = Math.round(price);
  s.comps.push({
    m: s.month,
    bbl: rec.bbl,
    address: rec.address,
    cls: rec.class,
    price: px,
    sf: built ? rec.bldgArea : 0,
    psf: built ? price / Math.max(1, rec.bldgArea) : price / Math.max(1, rec.lotArea),
    capRate: built && price > 0 ? +((noi / price) * 100).toFixed(2) : 0,
    buyer, seller,
    distress: distress || undefined,
    offMarket: offMarket || undefined,
    // Stamped here because here is the only place that knows the date. Every
    // one of the twelve callers hands in a resolveRec'd record, so this is
    // bit-for-bit the number `tickLandComps` would have computed for this lot
    // this month — and unlike that one, it does not keep moving afterwards.
    mark: built ? undefined : landPsfNow(rec, s.econ) || undefined,
  });
  // Rolling sheet vs century volume. The buffer stays short for the UI; the
  // counters keep every print that ever closed so a long-horizon report is not
  // capped at MAX_COMPS (a fake ceiling on street activity — CLAUDE.md).
  s.compsTotal = (s.compsTotal ?? 0) + 1;
  s.compsVolume = (s.compsVolume ?? 0) + px;
  if (s.comps.length > MAX_COMPS) s.comps.splice(0, s.comps.length - MAX_COMPS);
}

/**
 * What the market has actually been paying for a class, over a window of
 * months. Returns null when there are too few prints to say anything — which
 * is itself the answer, and far more honest than averaging two trades and
 * calling it a market.
 */
export function compStats(s: GameState, cls: string, months = 36) {
  const since = s.month - months;
  // Dirt trades far more often than buildings do in a town still filling in,
  // and a comps sheet that silently dropped every land sale was hiding most
  // of the market. Land has no cap rate; it has a price per foot of LOT, and
  // that is exactly the number a developer is trying to read.
  const land = cls === "land";
  const rows = (s.comps ?? []).filter((c) => c.m >= since && c.cls === cls && (land ? c.sf === 0 : c.sf > 0));
  if (rows.length < 3) return null;
  const caps = rows.map((c) => c.capRate).filter((x) => x > 0).sort((a, b) => a - b);
  const psfs = rows.map((c) => c.psf).sort((a, b) => a - b);
  const mid = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : 0);
  return {
    n: rows.length,
    medCap: mid(caps),
    medPsf: mid(psfs),
    volume: rows.reduce((a, c) => a + c.price, 0),
    distressShare: rows.filter((c) => c.distress).length / rows.length,
  };
}

/**
 * Who has been buying and who has been selling, over a window.
 *
 * NAMED PARTICIPANTS ONLY. Half the counterparties in the ledger are
 * placeholders — "a private owner", "a listed seller", "a distressed buyer" —
 * and aggregating them produced a row for the anonymous public reading
 * "getting out, ask why before you buy what they are selling", which is
 * nonsense dressed as insight. A read on a firm is only worth having when
 * there is a firm to read.
 */
export function compFlows(s: GameState, months = 36) {
  const named = new Set<string>([s.firm?.short ?? "You", ...(s.rivals ?? []).map((r) => r.name)]);
  const since = s.month - months;
  const by = new Map<string, { bought: number; sold: number; boughtN: number; soldN: number }>();
  const at = (k: string) => {
    let e = by.get(k);
    if (!e) { e = { bought: 0, sold: 0, boughtN: 0, soldN: 0 }; by.set(k, e); }
    return e;
  };
  for (const c of s.comps ?? []) {
    if (c.m < since) continue;
    if (named.has(c.buyer)) { const e = at(c.buyer); e.bought += c.price; e.boughtN++; }
    if (named.has(c.seller)) { const e = at(c.seller); e.sold += c.price; e.soldN++; }
  }
  return [...by.entries()]
    .map(([name, v]) => ({ name, ...v, net: v.bought - v.sold }))
    .sort((a, b) => (b.bought + b.sold) - (a.bought + a.sold));
}

/**
 * WHAT YOUR RENT ROLL DOES FOR A LIVING, across the whole book.
 *
 * The single most important number a landlord can know about themselves and
 * the game had no way to compute it. Concentration is not a per-building
 * property: you can own twelve diversified buildings and still be sixty per
 * cent finance, and when finance turns you find that out all at once.
 */
export function portfolioIndustries(s: GameState) {
  const by = new Map<Sector, { income: number; sf: number; tenants: number }>();
  let total = 0;
  for (const h of Object.values(s.holdings)) {
    for (const t of h.tenants) {
      const annual = t.rentPsf * t.sf;
      total += annual;
      const e = by.get(t.sector) ?? { income: 0, sf: 0, tenants: 0 };
      e.income += annual; e.sf += t.sf; e.tenants++;
      by.set(t.sector, e);
    }
  }
  const rows = [...by.entries()]
    .map(([sector, v]) => ({
      sector,
      ...v,
      share: total > 0 ? v.income / total : 0,
      stress: industryStress(s.econ, sector),
      mom: s.econ.industryMom?.[sector] ?? 0,
      phase: s.econ.industryPhase?.[sector] ?? "steady",
    }))
    .sort((a, b) => b.income - a.income);
  // The share of your income sitting in trades that are currently contracting
  // — the number that says how bad the next two years are going to be.
  const atRisk = rows.reduce((a, r) => a + r.share * r.stress, 0);
  return { rows, total, top: rows[0] ?? null, atRisk };
}

/**
 * WHAT THE STREET IS ACTUALLY PAYING FOR DIRT.
 *
 * Land value in this engine was a label rather than a price. `landPsfNow`
 * reads a static seed off the parcel record, a citywide index, a site-quality
 * multiplier and the cycle — and nothing else. `s.landAdj`, the per-parcel
 * mark that every consumer already reads through `resolveBase`, was written by
 * exactly two things: a delivery, and a rezoning. Nothing anybody BOUGHT ever
 * moved the ground under it.
 *
 * That is the wrong way round for the most fundamental price in the business.
 * Dirt has no income and no replacement cost; the only way anybody knows what
 * a lot is worth is what the lots around it have been fetching. Comparable
 * sales are not a check on the appraisal, they ARE the appraisal.
 *
 * Measured before this existed (`pnpm stress --only=B`): a buyer taking 116 to
 * 142 lots out of one district over twenty-five years moved that district's
 * land value DOWN 6.6% relative to the rest of the same town. The player's
 * demand was not an input to the land market at all, so absorbing a third of a
 * district's dirt read to the appraiser as one fewer building trading there —
 * which is the sign it moves, backwards.
 *
 * How it works, and why it converges rather than running away: every land
 * print is compared to what this engine appraised that same lot at ON THE DAY
 * IT CLOSED, and the ratio is the market telling the appraiser it is wrong.
 * Aggregated to the district, because that is the submarket an appraiser
 * actually pulls comps from, and only when there are enough prints to be a
 * market rather than an anecdote. The mark then moves a fraction of the way
 * each quarter.
 *
 * What stops it is the NEXT print, not this one. A raised mark raises the
 * appraisal, the appraisal is what the next seller writes their ask off, and a
 * lot that clears at the ordinary denial band over the RAISED number scores a
 * ratio of one — no further push. A district that keeps clearing stronger than
 * the town keeps getting marked up, exactly as long as it keeps doing it, and
 * the day it stops it simply stops, without a correction it never earned. The
 * older arrangement compared against a moving mark and got that braking for
 * free, at the price of the sign: see the note at the ratio.
 *
 * It draws no random numbers, so every paired run in both audits stays in step.
 */
const LAND_WINDOW_M = 36;      // three years of prints — an appraiser's window
const LAND_MIN_PRINTS = 3;     // one sale is an anecdote, two is a coincidence
const LAND_SPEED = 0.07;       // per quarter, toward what the street is paying

export function tickLandComps(s: GameState, parcels: Record<string, ParcelRecord>) {
  // Appraisals are quarterly work. Nobody re-marks a book every month.
  if (s.month % 3 !== 0) return;
  if (!s.landAdj) s.landAdj = {};
  const since = s.month - LAND_WINDOW_M;
  const byDist = new Map<string, number[]>();
  for (const c of s.comps ?? []) {
    // LAND PRINTS ONLY. An improved sale is mostly a price for the building;
    // backing the dirt out of it is a residual, and a residual of two large
    // numbers is noise at this sample size.
    if (c.m < since || c.sf !== 0) continue;
    const rec = resolveRec(parcels, s, c.bbl);
    if (!rec?.lotArea) continue;
    // A PRICE AND ITS MARK MUST CARRY THE SAME DATE.
    //
    // This divided by `landPsfNow(rec, s.econ)` — TODAY'S appraisal — against
    // prints up to three years old. Write out what that measures. A print at
    // month t clears at roughly the mark on that date times the seller's denial
    // band; the denominator is the mark on THIS date. So the ratio is
    // `denial * (mark_then / mark_now)`, and the district term in it is not
    // location, it is the district's own growth over the window, INVERTED. A
    // district being marked up therefore read cheap, and the wire marked it
    // back down — which is why `pnpm stress --only=B` had a whale buying out a
    // district and moving its ground -34%. The comp sheet was measuring the
    // clock.
    //
    // Stamped at the closing, the ratio is `denial` and nothing else, which is
    // the one thing a comp is evidence about: did this lot clear over or under
    // what the book said it was worth, on the day.
    const appraised = c.mark ?? landPsfNow(rec, s.econ);
    if (!(appraised > 0) || !(c.psf > 0)) continue;
    const d = rec.district ?? "—";
    if (!byDist.has(d)) byDist.set(d, []);
    const ratio = c.psf / appraised;
    // AN OFF-MARKET PRINT IS EVIDENCE, NOT A CLEARING PRICE — and it is worth
    // asking which direction it points.
    //
    // A marketed sale is the market's answer: exposed, competed, and if it
    // cleared at that number then that is what the number is. A quiet deal
    // between two people is a real deed for real money and it is NOT the same
    // evidence, because nothing tested it — no second bidder, no proof anybody
    // else would have gone there. Appraisal practice screens for exactly this
    // and discounts what it cannot verify rather than discarding it.
    //
    // The asymmetry is the interesting part, and it is the reason to model
    // this at all rather than just weight it down. Somebody who pays OVER the
    // appraisal with no competition in the room wanted that specific lot, and
    // in this business there is usually one reason — they are assembling, and
    // the piece they still need is worth more to them than to anybody else.
    // That leaks. It is the whole holdout dynamic: as a buyer works down a
    // block, the neighbours read the prints and the last parcel is the dearest
    // one. So a premium paid off-market carries most of its weight.
    //
    // A quiet sale UNDER the appraisal says much less. Sellers go off-market
    // for speed, for privacy, to avoid a broker, to settle an estate — the
    // discount is the price of not being marketed, and reading it as the
    // market repricing downward would let anybody mark a district down by
    // doing a favour for a friend.
    const weight = !c.offMarket ? 1 : ratio >= 1 ? 0.75 : 0.35;
    const g = byDist.get(d)!;
    // Weighted by repetition, which keeps the median honest without needing a
    // weighted-median routine: a print counted twice is a print that speaks
    // twice, and a quarter-weight one only sometimes gets a vote at all.
    g.push(ratio);
    if (weight >= 0.75) g.push(ratio);
    if (weight >= 1) g.push(ratio, ratio);
  }
  if (!byDist.size) return;

  // AGAINST THE REST OF TOWN, NOT AGAINST THE APPRAISAL.
  //
  // The first cut of this compared each print to `landPsfNow` and marked the
  // district toward it. That is circular and it compounds. A land ask in this
  // engine IS the appraisal times a denial factor — refreshListings prices off
  // assetValue, and for dirt assetValue IS landValue — and dirt trades at the
  // ask. So the ratio was pinned above one BY CONSTRUCTION, at whatever the
  // seller's denial band happened to be, and every quarter the wire read that
  // premium as "the market pays over appraisal" and marked the whole city up
  // again. Compounding. Measured at the previous commit: only three of eight
  // strategies ended in the black, a competent operator survived one world in
  // four, and the tournament went BROKEN — because land was inflating under
  // everybody and the tax roll was chasing it.
  //
  // The signal a submarket mark should carry is RELATIVE: is this district
  // clearing stronger than the rest of the town, in the same window, under the
  // same denial band? That difference is real information about location and
  // it is what a comps sheet actually tells an appraiser. It also cannot drift,
  // because the citywide median is the reference — if every district clears 4%
  // over appraisal, no district is hot and nothing moves.
  const all: number[] = [];
  for (const rs of byDist.values()) all.push(...rs);
  if (all.length < LAND_MIN_PRINTS * 2) return;
  all.sort((a, b) => a - b);
  const town = all[Math.floor((all.length - 1) / 2)];
  if (!(town > 0)) return;

  const pull = new Map<string, number>();
  for (const [dist, ratios] of byDist) {
    if (ratios.length < LAND_MIN_PRINTS) continue;
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor((ratios.length - 1) / 2)];
    // A single wild print — a distressed clear-out, an assemblage premium —
    // is real but it is not the market. Bound what one quarter can conclude.
    if (Number.isFinite(median)) pull.set(dist, Math.max(0.6, Math.min(1.7, median / town)));
  }
  if (!pull.size) return;

  // Publish relative district heat for the residual land auction — builder-
  // clearing sites read this so comps discover dirt, not only the texture floor.
  s.econ.districtHeat = Object.fromEntries([...pull.entries()].map(([d, f]) => [d, +f.toFixed(4)]));

  for (const bbl of Object.keys(parcels)) {
    const p = parcels[bbl];
    const f = p ? pull.get(p.district ?? "—") : undefined;
    if (f === undefined) continue;
    const cur = s.landAdj[bbl] ?? 1;
    const next = cur * (1 + LAND_SPEED * (f - 1));
    s.landAdj[bbl] = +Math.max(0.25, Math.min(4, next)).toFixed(4);
  }
}
