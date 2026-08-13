// ENDOGENOUS DEMAND.
//
// Until now a parcel's demandScore was stamped on at generation and never moved
// again. Everything downstream read it — rent, cap rate, land value, how many
// tenants toured — so the map was a backdrop with prices painted on it. You
// could fill a district with towers and the district would be worth exactly
// what it was worth before you started. That is not a city; it is a board.
//
// A block's desirability is now an ANCHOR plus an EMERGENCE.
//
//   anchor     — geography, the water, the street network, the stations. Fixed
//                at generation, and it is what the pipeline already computed.
//   emergence  — what is actually standing and occupied within a few hundred
//                metres, scored as jobs, residents and amenity, combined by a
//                GEOMETRIC MEAN so that a monoculture scores near zero and a
//                balanced neighbourhood compounds.
//
// The geometric mean is the whole idea. An office park with nowhere to live and
// nowhere to eat is worth less than the sum of its floors; the same floors with
// housing and shops around them are worth more. That is the actual finding from
// urban economics and it is the mechanic that makes building a place different
// from building a building.
//
// Demand is measured RELATIVE TO DAY ONE. Emergence at generation is computed
// once and subtracted, so a fresh campaign starts exactly where the generator
// put it and only moves as the neighbourhood genuinely changes. That keeps a
// hundred years of balance intact and makes the mechanic purely additive.
//
// What is stored per block is therefore a DRIFT in demand points, not a level.
// Every parcel keeps its own generated score and carries its block's drift on
// top, so the corner lot is still worth more than the mid-block lot after the
// district turns — the neighbourhood moves, the parcels keep their pecking
// order. On day one every drift is zero and the game is bit-for-bit unchanged.
//
// THREE AMENDMENTS, all measured, all in this file.
//
//   THE TANK WAS EMPTY. The response ran off a saturating index on its flat
//   part, so the whole plausible range of things that can happen to a
//   neighbourhood was worth a few points. The largest target any block ever
//   reached in 600 months was 7.5 against a cap of 34. It runs off the LOG of
//   neighbourhood intensity now, which has constant proportional gain.
//
//   IT IS NO LONGER PURELY ADDITIVE, AND MUST NOT BE. Location value is a
//   RELATIVE good and the city's total is set by the macro engine, so every
//   month's targets are centred on their land-value-weighted mean. Demand is
//   redistributed, never created. That is what lets the gain be real.
//
//   AND THREE THINGS FEED IT, not one. What is built and occupied nearby;
//   which trades a block's own tenants are in and whether those trades are
//   hiring; and whether the transit authority has funded a station within a
//   five-minute walk. None of the three asks the player for anything.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { BuiltClass, Econ, GameState } from "./types";
import { useOccupancy } from "./value";
import { START_YEAR } from "./types";
import { mixOf, type UseMix } from "./mix";
import { SECTORS, INDUSTRY_LABEL } from "./market";
import { BUILT_CLASSES, type Sector } from "./types";

/** What the neighbourhood panel can recommend: a use, or a mixed-use stack. */
export type WantsKey = BuiltClass | "mixed";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** How far a neighbourhood reaches, in metres. About two blocks. */
const REACH_M = 270;
/**
 * THE FUEL TANK WAS EMPTY, AND THIS IS WHY.
 *
 * The old response ran off `emergence`, a saturating index that sits at 0.53
 * for the median block. Its derivative there is tiny, so the whole plausible
 * range of things that can happen to a neighbourhood moved it by fractions of
 * a point. Measured over 600 months on 170 blocks with the street building 120
 * buildings: the largest target any block ever reached was 7.5 points against
 * a cap of 34, and putting a MILLION square feet of mixed use on one block
 * moved that block by 5.1. The model was right and its gain was a rounding
 * error.
 *
 * The drift now runs off the LOG of neighbourhood intensity, which has constant
 * proportional gain: doubling what stands and is occupied within two blocks is
 * worth the same number of points whether the corner started dead or busy.
 * `RESPONSE` is points per log unit — 52 makes a doubled neighbourhood worth
 * about 12 points, which is a corner going from ordinary to good.
 */
const RESPONSE = 52;
/** A neighbourhood can at most double, or halve, what it is made of. */
const LOG_CAP = 0.62;
/** A leg that is missing entirely is thin, not infinite. */
const LEG_FLOOR = 0.06;
/** How fast a block's desirability moves toward its target each month. */
const MOMENTUM = 0.07;
/** Active construction nearby — a fraction of eventual occupied pull, ramping with progress. */
const CONSTRUCTION_PTS_PER_100K = 3.2;
/** A neighbourhood can remake itself, but it cannot become somewhere else. */
const DRIFT_CAP = 34;
/** Anchor plus drift, kept inside what the invariant sweep will allow. */
const TOTAL_CAP = 36;
/**
 * The economy at mid-cycle, for the zero point only. `useOccupancy` reads
 * cityVac and vintageMean and tolerates both being absent, which is what mid-
 * cycle means: no boom, no slump, no flight to quality.
 */
const MID_CYCLE = { cycleDev: 0 } as unknown as Econ;

// ------------------------------------------------- THE FORTUNES OF A CENTRE
//
// A polycentric town starts with three or four centres of roughly equal
// standing and does not end that way. One becomes THE address and the others
// become somewhere you used to be able to buy — and which one it was going to
// be was not knowable at the start, only guessable, and then only by somebody
// paying attention early. That is the whole texture of holding land in a town
// that is still deciding what it is.
//
// The mechanic is a random walk with a hidden drift, which is the honest shape
// of this because it has the right INFORMATION structure. Each centre draws a
// long-run trajectory once, at the start of the campaign, and is never told
// what it is. Then it walks. Early on the monthly noise is several times the
// monthly drift, so a centre that is up in year five tells you very little.
// By year twenty-five the drift has accumulated linearly and the noise only as
// the square root of time, so the answer is plain to everybody — and being
// plain to everybody is exactly when it is too late to buy it.
//
// The centres are found from the surface itself rather than read off the city
// config, so this works on any map anybody ever adds without threading
// anything through: take the local maxima of the generator's own anchor, keep
// them apart, and those are the town's centres by construction.

/** How many centres a town has. Real towns of this size have three or four. */
const POLE_MAX = 4;
/** Two centres closer than this are one centre. */
const POLE_SPACING_M = 420;
/** How far a centre's fortune reaches. Matches the generator's own core radii. */
const POLE_RADIUS_M = 340;
/**
 * The hidden long-run trajectory, in demand points per month. Drawn once. Over
 * a fifty-year campaign this compounds to about 10 points — a real, legible
 * difference between neighbourhoods, and the same order as the drift the
 * density feedback produces, so a centre's luck never swamps what the player
 * actually does with it.
 */
const POLE_DRIFT_SD = 0.016;
/**
 * The monthly noise, and THE most important number in this mechanic — because
 * it is what decides WHEN the answer becomes knowable, which is the entire
 * design.
 *
 * Drift accumulates linearly in t and noise only as its square root, so the
 * date the signal overtakes the noise is fixed by the ratio of the two:
 * drift*t = noise*sqrt(t) crosses at t = (noise/drift)^2. At the first values
 * I tried — drift 0.019, noise 0.115 — that crossover was month THIRTY-SEVEN,
 * and measured over ten campaigns the leader at year five was already the
 * eventual winner 80% of the time against a 25% chance rate. The answer was
 * being handed over in year three, which is not a judgement, it is a table.
 *
 * At 0.26 the crossover is month 264 — year twenty-two. The first decade is
 * genuinely close to noise, the second is where reading the tape early pays,
 * and by the fourth everybody can see it and the ground is long gone.
 */
const POLE_NOISE_SD = 0.26;
/** Nothing runs away: a centre's fortune is bounded either side. */
const POLE_CAP = 16;

/**
 * Find the town's centres, once, from the generator's own demand anchor. Local
 * maxima kept POLE_SPACING_M apart, strongest first.
 */
function findPoles(s: GameState, model: DemandModel): NonNullable<GameState["poles"]> {
  const rows = [...model.blocks.values()].sort((a, b) => b.baseD - a.baseD);
  const out: NonNullable<GameState["poles"]> = [];
  for (const b of rows) {
    if (out.length >= POLE_MAX) break;
    if (out.some((p) => Math.hypot(p.cx - b.cx, p.cy - b.cy) < POLE_SPACING_M)) continue;
    // A centre is drawn from the CAMPAIGN seed, not the city's, so the same
    // town plays out differently every time you start over on it.
    const u1 = hash01(`pole:${s.seed}:${out.length}:a`);
    const u2 = hash01(`pole:${s.seed}:${out.length}:b`);
    // Box-Muller, so the drift is normal rather than uniform: most centres do
    // roughly nothing and the interesting ones are in the tails.
    const g = Math.sqrt(-2 * Math.log(Math.max(1e-9, u1))) * Math.cos(2 * Math.PI * u2);
    out.push({
      cx: b.cx, cy: b.cy, r: POLE_RADIUS_M,
      drift: +(g * POLE_DRIFT_SD).toFixed(5),
      level: 0,
      name: b.id,
    });
  }
  return out;
}

/** One-time bump when a tower tops out — the street feels it before lease-up. */
export function nudgeBlockDemand(s: GameState, block: string, pts: number) {
  s.blockE = s.blockE ?? {};
  s.blockD = s.blockD ?? {};
  const e = +clamp((s.blockE[block] ?? 0) + pts, -DRIFT_CAP, DRIFT_CAP).toFixed(2);
  if (e === 0) delete s.blockE[block];
  else s.blockE[block] = e;
  const anchor = s.blockA?.[block] ?? 0;
  const next = +clamp(anchor + e, -TOTAL_CAP, TOTAL_CAP).toFixed(2);
  if (next === 0) delete s.blockD[block];
  else s.blockD[block] = next;
}

/** Cranes and hoardings pull before the certificate of occupancy. */
function constructionLift(s: GameState, model: DemandModel, b: BlockGeom): number {
  let lift = 0;
  const add = (bbl: string | undefined, sf: number, startM: number, deliverM: number) => {
    if (!bbl || sf <= 0 || s.month >= deliverM) return;
    const id = model.ofBbl.get(bbl);
    if (!id) return;
    const g = model.blocks.get(id);
    if (!g) return;
    const dist = Math.hypot(b.cx - g.cx, b.cy - g.cy);
    if (dist > REACH_M) return;
    const span = Math.max(1, deliverM - startM);
    const prog = clamp((s.month - startM) / span, 0, 1);
    const w = clamp(1 - dist / REACH_M, 0, 1) * (0.25 + 0.75 * prog);
    lift += w * Math.min(CONSTRUCTION_PTS_PER_100K, (sf / 100_000) * CONSTRUCTION_PTS_PER_100K);
  };
  for (const d of Object.values(s.developments ?? {})) {
    add(d.bbl, d.sf, d.startM, d.deliverM);
  }
  for (const j of s.cityJobs ?? []) {
    if (j.orphaned) continue;
    add(j.bbl, j.sf, j.startM, j.deliverM);
  }
  return lift;
}

/** Walk every centre one month. Called from tickDemand before the targets. */
function tickPoles(s: GameState, model: DemandModel) {
  if (!s.poles?.length) s.poles = findPoles(s, model);
  for (let i = 0; i < s.poles.length; i++) {
    const p = s.poles[i];
    const u1 = hash01(`pw:${s.seed}:${i}:${s.month}:a`);
    const u2 = hash01(`pw:${s.seed}:${i}:${s.month}:b`);
    const g = Math.sqrt(-2 * Math.log(Math.max(1e-9, u1))) * Math.cos(2 * Math.PI * u2);
    p.level = +clamp(p.level + p.drift + g * POLE_NOISE_SD, -POLE_CAP, POLE_CAP).toFixed(3);
  }
}

/** What the town's centres are doing to this particular block, this month. */
function poleLift(s: GameState, b: BlockGeom): number {
  let v = 0;
  for (const p of s.poles ?? []) {
    const d = Math.hypot(p.cx - b.cx, p.cy - b.cy);
    v += p.level * Math.exp(-(d * d) / (2 * p.r * p.r));
  }
  return v;
}

// ------------------------------------------------------ EMPLOYMENT, IN PLACE
//
// The city has had a real labour market for a while — jobs, unemployment, ten
// industries on their own booms and busts — and every bit of it was CITYWIDE.
// A tech bust emptied tech leases everywhere and improved nothing about the
// shipyards. But jobs have addresses. The blocks around the exchange are
// finance and law; the sheds by the water are logistics and food; and when
// logistics has a decade the water gets better and the exchange does not.
//
// Every block carries a trade mix, derived from what is BUILT on and around it
// plus a stable hash, so two office blocks are not the same office block. Its
// employment advantage is the amount its own trades are out-hiring the city
// average, accumulated and then decayed — because an advantage does fade:
// firms follow it, rents rise to meet it, and in ten years the corner is
// expensive rather than cheap. Nothing here asks the player for anything. It
// is a number on the neighbourhood panel and a line in the news.
/** Points of demand per unit of a block's trades out-hiring the city. */
const EMP_RESPONSE = 70;
/** …and how fast that advantage is competed away. Ten-year half-life. */
const EMP_DECAY = 0.006;
const EMP_CAP = 16;
/** How specialised a block's trade mix is. 1 would be the city average. */
const EMP_CONC = 2.2;

// -------------------------------------------------------------- THE NEW LINE
//
// The one thing in this business you can see coming a decade out and buy ahead
// of. A line is announced, argued about for six years, and opens; the ground
// around the head-house reprices on the announcement, again when the hoarding
// goes up, and again on the day it runs. Nobody has to click anything: it is
// news, a lens on the map, and a number on the panel.
/** Odds of a civic work being rumoured in any given year. */
const LINE_ODDS = 1 / 14;
/** How far a station's pull reaches, in metres. */
const LINE_SIGMA = 380;
/** What the market prices before it opens: on the news, and once it is dug. */
const LINE_EARLY = 0.18, LINE_DIGGING = 0.45;
/**
 * The rumour stage. A plan circulates for two years before anything is funded,
 * and the market prices almost none of it — LINE_RUMOR is the smart-money
 * leak, not a consensus. That gap between what the paper says and what the
 * tape says is the trade: anybody reading the news can buy ahead of the
 * announcement, and the price they pay for the option is SHELVE_ODDS — a
 * quarter of these plans die at the hearing and the ground gives the leak
 * back. An early trade with no way to lose is not an early trade, it is a
 * coupon.
 */
const RUMOR_M = 24;
const LINE_RUMOR = 0.06;
const SHELVE_ODDS = 0.25;
/**
 * What each kind of work is worth and how far it reaches. Stations reach the
 * five-minute walk and carry the most; a park is loved closer in; a bridge
 * reprices a whole quarter because it changes what the quarter is attached to,
 * takes points from a wider base, and is the slowest to build after the vote.
 * Points spans are the same order as the old station-only draw (16-26), scaled
 * by kind rather than retuned.
 */
const WORK_KINDS = {
  station: { lo: 16, span: 10, sigma: 380, buildM: 72 },
  park:    { lo: 8,  span: 6,  sigma: 300, buildM: 36 },
  bridge:  { lo: 12, span: 8,  sigma: 520, buildM: 60 },
} as const;
type WorkKind = keyof typeof WORK_KINDS;

export interface BlockGeom {
  id: string;
  bbls: string[];
  cx: number; cy: number;      // centroid in local metres
  landArea: number;            // sf of lot area in the block
  baseD: number;               // the generator's anchor, lot-area weighted
  neighbours: { id: string; w: number }[];
  nbLandArea: number;          // neighbourhood land area, weight-adjusted
}

export interface DemandModel {
  blocks: Map<string, BlockGeom>;
  ofBbl: Map<string, string>;          // parcel -> block
  baseStock: Map<string, Partial<Record<BuiltClass, number>>>;
  /** emergence at generation, per block — the zero point */
  e0: Map<string, number>;
  /** neighbourhood intensity at generation — the zero point the DRIFT uses */
  mix0: Map<string, number>;
  /** what the tenants around each block do for a living, shares summing to 1 */
  trades: Map<string, Partial<Record<Sector, number>>>;
  /** land VALUE per block, and the city's total — the weights demand redistributes over */
  landW: Map<string, number>;
  landWTot: number;
  /** the densities that count as "a lot", learned from the city itself */
  refJobs: number; refPop: number; refAmen: number;
  /** what share of the city's payroll each trade is — see the block below `landWTot` */
  sectorShare: Partial<Record<Sector, number>>;
}

/**
 * Which trades live in which kind of building. Not a claim that a warehouse
 * cannot hold a law firm — a claim about where the mass of each trade sits.
 */
const TRADE_AFFINITY: Record<BuiltClass, Partial<Record<Sector, number>>> = {
  office:      { finance: 3, law: 3, tech: 2.4, media: 1.6, insurance: 2, design: 1.2, medical: 1, food: 0.4, apparel: 0.5, logistics: 0.2 },
  retail:      { apparel: 3, food: 3, design: 1.4, media: 1, medical: 0.8, finance: 0.4, law: 0.3, tech: 0.4, insurance: 0.3, logistics: 0.5 },
  industrial:  { logistics: 3.4, apparel: 1.6, food: 1.4, media: 0.8, design: 0.8, tech: 0.6, medical: 0.5, finance: 0.2, law: 0.2, insurance: 0.2 },
  multifamily: { food: 1.4, medical: 1.2, design: 1, law: 1, finance: 1, tech: 1, media: 1, insurance: 1, apparel: 1, logistics: 0.8 },
};

/**
 * A stable 0..1 from a string. The same city always has the same trades, and
 * the same campaign seed always gets the same railway.
 *
 * The avalanche at the end is load-bearing and was not obvious: plain FNV-1a
 * on strings that differ in their last character or two produces neighbouring
 * outputs, so `seed:line:2001`, `seed:line:2002`… came out clustered. Measured
 * without it, six campaign seeds out of eight got ZERO stations in fifty years
 * and the other two got six to ten. With it: 7.03% of years against a 7.14%
 * target, a median of 3 lines per campaign, and 6 campaigns in 200 with none.
 */
function hash01(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// One model per parcel table. Static geometry, so it is computed once.
const CACHE = new WeakMap<ParcelTable, DemandModel>();

const M_PER_DEG_LAT = 111_320;

/**
 * Jobs, residents and amenity implied by a square foot of each class. These are
 * the same ratios the employment layer uses, so the two agree about what an
 * office building is for.
 */
function contribution(cls: BuiltClass, sf: number): { j: number; r: number; a: number } {
  switch (cls) {
    case "office":      return { j: sf / 230, r: 0, a: 0 };
    case "industrial":  return { j: sf / 550, r: 0, a: 0 };
    case "retail":      return { j: sf / 420, r: 0, a: sf };
    case "multifamily": return { j: 0, r: sf / 900, a: 0 };
  }
}

// Mixed use used to be a case in that switch, hand-tuned to contribute all
// three at once. It no longer needs to be: a building that is part shops, part
// offices and part flats contributes its retail feet as retail and its
// residential feet as residential, and the geometric mean below does the rest.
// The reason a mixed-use building lifts a neighbourhood more per square foot
// than a tower is now EMERGENT rather than asserted, which is the only kind of
// answer worth having.

/** A canonical mixed-use stack, for the "what should I build here" probe. */
const MIXED_PROBE: UseMix = { retail: 0.15, office: 0.45, multifamily: 0.40 };

export function demandModel(parcels: ParcelTable): DemandModel {
  const hit = CACHE.get(parcels);
  if (hit) return hit;

  const bbls = Object.keys(parcels);
  if (!bbls.length) {
    const empty: DemandModel = { blocks: new Map(), ofBbl: new Map(), baseStock: new Map(), e0: new Map(), mix0: new Map(), trades: new Map(), landW: new Map(), landWTot: 1, refJobs: 1, refPop: 1, refAmen: 1, sectorShare: {} };
    CACHE.set(parcels, empty);
    return empty;
  }

  // a local metre grid centred on the city
  let lat0 = 0, lon0 = 0;
  for (const b of bbls) { lon0 += parcels[b].centroid[0]; lat0 += parcels[b].centroid[1]; }
  lon0 /= bbls.length; lat0 /= bbls.length;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);

  const blocks = new Map<string, BlockGeom>();
  const ofBbl = new Map<string, string>();
  const baseStock = new Map<string, Partial<Record<BuiltClass, number>>>();
  // The same roll-up, OCCUPIED at each building's own mid-cycle occupancy.
  const baseOcc = new Map<string, Partial<Record<BuiltClass, number>>>();
  const acc = new Map<string, { x: number; y: number; area: number; dw: number }>();

  for (const bbl of bbls) {
    const r = parcels[bbl];
    const id = r.block;
    ofBbl.set(bbl, id);
    const x = (r.centroid[0] - lon0) * mPerDegLon;
    const y = (r.centroid[1] - lat0) * M_PER_DEG_LAT;
    const a = acc.get(id) ?? { x: 0, y: 0, area: 0, dw: 0 };
    a.x += x * r.lotArea; a.y += y * r.lotArea;
    a.area += r.lotArea;
    a.dw += r.demandScore * r.lotArea;
    acc.set(id, a);
    if (r.class !== "land" && r.bldgArea > 0) {
      const st = baseStock.get(id) ?? {};
      const so = baseOcc.get(id) ?? {};
      // by component: the shops under a block of flats are retail feet, and
      // the block only has street life because of them
      const m = mixOf(r);
      for (const k of Object.keys(m) as BuiltClass[]) {
        const sf = r.bldgArea * (m[k] ?? 0);
        st[k] = (st[k] ?? 0) + sf;
        // THIS BUILDING'S OCCUPANCY, NOT ITS CLASS'S. See occupiedStock — the
        // zero point has to be measured the same way the live number is, and
        // the live number is now per building.
        so[k] = (so[k] ?? 0) + sf * useOccupancy(r, MID_CYCLE, k, true);
      }
      baseStock.set(id, st);
      baseOcc.set(id, so);
    }
  }

  for (const [id, a] of acc) {
    blocks.set(id, {
      id, bbls: [], cx: a.x / Math.max(1, a.area), cy: a.y / Math.max(1, a.area),
      landArea: a.area, baseD: a.dw / Math.max(1, a.area),
      neighbours: [], nbLandArea: 0,
    });
  }
  for (const bbl of bbls) blocks.get(ofBbl.get(bbl)!)!.bbls.push(bbl);

  // the neighbourhood: everything within reach, weighted down with distance
  const list = [...blocks.values()];
  for (const b of list) {
    let nbArea = 0;
    for (const o of list) {
      const d = Math.hypot(b.cx - o.cx, b.cy - o.cy);
      if (d > REACH_M) continue;
      const w = b === o ? 1 : clamp(1 - d / REACH_M, 0, 1);
      b.neighbours.push({ id: o.id, w });
      nbArea += o.landArea * w;
    }
    b.nbLandArea = Math.max(1, nbArea);
  }

  const model: DemandModel = { blocks, ofBbl, baseStock, e0: new Map(), mix0: new Map(), trades: new Map(), landW: new Map(), landWTot: 0, refJobs: 1, refPop: 1, refAmen: 1, sectorShare: {} };

  // Calibrate the "a lot of this" densities off the city as generated, so the
  // model travels to any city the pipeline can produce without hand-tuning.
  //
  // The zero point must be measured the same way the live number is, or the
  // difference is not zero on day one. The live model counts OCCUPIED feet, so
  // the baseline counts occupied feet too — at mid-cycle occupancy, since the
  // cycle is the one part of it that genuinely should register: a city with
  // its buildings half empty is a worse neighbourhood, and should say so.
  //
  // Per BUILDING, matching occupiedStock. It was `st[k] * refOcc(k)` — every
  // building in the city credited with its class average — so a block of
  // troubled buildings and a block of full ones were indistinguishable to the
  // surface that is supposed to be measuring exactly that difference.
  const dens = { j: [] as number[], r: [] as number[], a: [] as number[] };
  const raw = new Map<string, { j: number; r: number; a: number }>();
  for (const b of list) {
    let j = 0, r = 0, am = 0;
    for (const n of b.neighbours) {
      const st = baseOcc.get(n.id);
      if (!st) continue;
      for (const k of Object.keys(st) as BuiltClass[]) {
        const c = contribution(k, (st[k] ?? 0) * n.w);
        j += c.j; r += c.r; am += c.a;
      }
    }
    const acres = b.nbLandArea / 43_560;
    const v = { j: j / acres, r: r / acres, a: am / acres };
    raw.set(b.id, v);
    dens.j.push(v.j); dens.r.push(v.r); dens.a.push(v.a);
  }
  const p80 = (arr: number[]) => {
    const s = arr.slice().sort((x, y) => x - y);
    return Math.max(1e-6, s[Math.floor(s.length * 0.8)] ?? 1);
  };
  model.refJobs = p80(dens.j);
  model.refPop = p80(dens.r);
  model.refAmen = p80(dens.a);

  for (const b of list) {
    const v = raw.get(b.id)!;
    model.e0.set(b.id, emergenceOf(v.j / model.refJobs, v.r / model.refPop, v.a / model.refAmen));
    model.mix0.set(b.id, intensityOf(v.j / model.refJobs, v.r / model.refPop, v.a / model.refAmen));
  }

  // What each block is for a living, and what its dirt is worth. Both are
  // static, so both belong here rather than in the monthly tick.
  for (const b of list) {
    const sf: Partial<Record<BuiltClass, number>> = {};
    for (const n of b.neighbours) {
      const st = baseStock.get(n.id);
      if (!st) continue;
      for (const k of Object.keys(st) as BuiltClass[]) sf[k] = (sf[k] ?? 0) + (st[k] ?? 0) * n.w;
    }
    model.trades.set(b.id, tradesOf(b.id, sf));
    let lv = 0;
    for (const bbl of b.bbls) { const r = parcels[bbl]; if (r) lv += r.lotArea * r.landPsf; }
    model.landW.set(b.id, lv);
    model.landWTot += lv;
  }
  model.landWTot = Math.max(1, model.landWTot);

  // --- HOW BIG EACH TRADE IS IN THIS PARTICULAR CITY -----------------------
  //
  // Every block's trade mix, weighted by the payroll that block carries. A
  // trade's size is not a property of the trade, it is a property of what this
  // city built: `tradesOf` reads `TRADE_AFFINITY` per class and raises the
  // result to `EMP_CONC`, so a warehouse town and a banking town get different
  // tens. THIS IS THE QUANTITY TWO OTHER PLACES WERE ASSUMING WAS A FLAT 1/10 —
  // `tickEmployment` below, which compared a trade-weighted block against an
  // equal-weighted city, and `swanJobDrift` in swans.ts, which made losing the
  // logistics trade cost the city as many jobs as losing finance.
  //
  // It rides on the model rather than the state because it is static geometry
  // plus static stock, which is the same reason `trades` does.
  {
    const acc: Partial<Record<Sector, number>> = {};
    let tot = 0;
    for (const [id, w] of model.trades) {
      const st = baseStock.get(id);
      if (!st) continue;
      let jobs = 0;
      for (const c of Object.keys(st) as BuiltClass[]) jobs += contribution(c, st[c] ?? 0).j;
      if (jobs <= 0) continue;
      for (const k of SECTORS) { const v = jobs * (w[k] ?? 0); acc[k] = (acc[k] ?? 0) + v; tot += v; }
    }
    // A city with no employment at all — an all-residential test fixture — has
    // no shares to report, and an equal tenth is the honest answer to a
    // question with no evidence in it.
    for (const k of SECTORS) model.sectorShare[k] = tot > 0 ? (acc[k] ?? 0) / tot : 1 / SECTORS.length;
  }

  CACHE.set(parcels, model);
  return model;
}

/**
 * The mix term. A geometric mean of the three normalised densities, run through
 * a saturating curve so the tenth tower on a block is worth less than the
 * second. Everything below is dimensionless and lands in roughly 0..1.
 */
function emergenceOf(j: number, r: number, a: number): number {
  const mix = Math.cbrt(Math.max(0, j) * Math.max(0, r) * Math.max(0, a));
  return mix / (mix + 0.55);
}

/**
 * The same geometric mean WITHOUT the saturating curve, and with a floor under
 * each leg so a block with no shops at all is thin rather than zero. This is
 * what the drift is measured on, in logs — see RESPONSE.
 */
function intensityOf(j: number, r: number, a: number): number {
  return Math.cbrt((Math.max(0, j) + LEG_FLOOR) * (Math.max(0, r) + LEG_FLOOR) * (Math.max(0, a) + LEG_FLOOR));
}

/** What the tenants on and around a block do for a living. Shares sum to 1. */
function tradesOf(id: string, sf: Partial<Record<BuiltClass, number>>): Partial<Record<Sector, number>> {
  let tot = 0;
  for (const c of BUILT_CLASSES) tot += sf[c] ?? 0;
  tot = Math.max(1, tot);
  const w: Partial<Record<Sector, number>> = {};
  let sum = 0;
  for (const k of SECTORS) {
    let v = 0;
    for (const c of BUILT_CLASSES) v += ((sf[c] ?? 0) / tot) * (TRADE_AFFINITY[c][k] ?? 1);
    v = Math.pow(Math.max(0, v) * (0.35 + 1.3 * hash01(id + ":" + k)), EMP_CONC);
    w[k] = v; sum += v;
  }
  for (const k of SECTORS) w[k] = (w[k] ?? 0) / Math.max(1e-9, sum);
  return w;
}

/** Occupied square feet by class in every block, this month. */
/**
 * EVERY BUILDING'S OWN OCCUPANCY, NOT ITS CLASS'S.
 *
 * This credited unowned stock with `class average x square feet` and the
 * player's own buildings with their actual rent roll. Nothing about a building
 * changes at a closing — the roll was written when it came to market, the
 * tenants and the leases are the same on both sides of the signature — so
 * every purchase moved the neighbourhood's occupied stock by the gap between
 * one building's roll and its whole class's average.
 *
 * Measured at the instant of purchase, 261 closings with no month passing:
 * the block lost 13.5% of the building's floor area the moment the deed moved,
 * on 219 of them. That is the wire behind `pnpm stress --only=B` — buy up a
 * district and its demand score falls about 11%, which drags the land under it
 * down with it. The player's own money was making their neighbourhood worse by
 * arriving.
 *
 * The engine already knows each building's occupancy: `useOccupancy` is a pure
 * function of the parcel, and it is where the character hash, the trouble tail,
 * the vintage and the city vacancy wire all live. So there is no reason to use
 * a class average for anybody. Ownership now changes exactly one thing — an
 * owned building reports the roll it actually has instead of the roll the
 * model predicts for it — which is a real and much smaller difference, and one
 * the player can move by leasing well.
 *
 * It is also a better demand surface on its own terms. A block of troubled
 * buildings and a block of full ones were indistinguishable to a model whose
 * entire job is to tell those apart.
 *
 * STABILISED, AND THE FLAG IS LOAD-BEARING. `mix0` — the month-zero baseline
 * every block's drift is measured against — is a fixed snapshot with no
 * lease-up in it. So if the live number applied `leaseUpFactor` and the
 * baseline did not, every building the city delivered would depress its own
 * neighbourhood for its first three years against a baseline that never had a
 * lease-up in it, and since a working city is always building, the drag would
 * be permanent. That is not a slow wire, it is the same quantity measured two
 * different ways, and it cost 71% OF THE CITY'S MEDIAN LAND VALUE before
 * `pnpm baseline` caught it: land fell $288/sf -> $84/sf, the office cap rate
 * pinned against its 11% clamp in 7.0% of months against 1.8% before, and the
 * builder's and holder's bids on the median lot both went to ZERO — the land
 * market stopped having any income logic in it at all and sat on the texture
 * floor.
 *
 * It is also the right statistic on its own terms. This surface moves at
 * MOMENTUM = 0.055 a month; a district turns over years. A three-year lease-up
 * is a transient on that timescale, and a desirability model that chases
 * transients is measuring the calendar. What a neighbourhood IS made of is its
 * standing, stabilised capacity — and that is what both sides now measure.
 *
 * AND IT STAYS BLIND TO THE BLOCK'S LIVE DEMAND, which is what the class
 * average was protecting. `useOccupancy` reads `rec.demandScore`, and if that
 * were the DRIFTED score this loop would chase its own tail — a block that got
 * better would get better because it got better. It reads `parcels[bbl]`
 * directly rather than `resolveRec`, so the score here is the generated one and
 * `s.blockD` never re-enters. Do not swap in a resolved record: the whole
 * feedback structure of this file depends on that being the static number.
 */
function occupiedStock(s: GameState, parcels: ParcelTable, model: DemandModel): Map<string, Partial<Record<BuiltClass, number>>> {
  const out = new Map<string, Partial<Record<BuiltClass, number>>>();
  const bump = (id: string | undefined, cls: BuiltClass, sf: number) => {
    if (!id) return;
    const o = out.get(id) ?? {};
    o[cls] = (o[cls] ?? 0) + sf;
    out.set(id, o);
  };

  for (const [bbl, id] of model.ofBbl) {
    const base = parcels[bbl];
    if (!base) continue;
    // whatever is standing there NOW: a redevelopment replaces what it replaced
    const b = s.built?.[bbl];
    const rec = b && b.bldgArea > 0
      ? { ...base, class: b.class, bldgArea: b.bldgArea, floors: b.floors, yearBuilt: b.yearBuilt, mix: b.mix }
      : base;
    if ((rec.class as string) === "land" || !(rec.bldgArea > 0)) continue;
    const h = s.holdings[bbl];
    const m = mixOf(rec as ParcelRecord);
    for (const cls of Object.keys(m) as BuiltClass[]) {
      const compSf = rec.bldgArea * (m[cls] ?? 0);
      if (compSf <= 0) continue;
      // your empty floors are empty for the neighbourhood too — and each part
      // of a mixed building reports its own occupancy, because the shops can
      // be full while the offices above them are not
      const occ = h
        ? (cls === "multifamily"
          ? (h.occ ?? useOccupancy(rec as ParcelRecord, s.econ, cls, true))
          : Math.min(1, h.tenants.filter((tn) => (tn.use ?? cls) === cls).reduce((n, tn) => n + tn.sf, 0) / compSf))
        : useOccupancy(rec as ParcelRecord, s.econ, cls, true);
      bump(id, cls, compSf * occ);
    }
  }
  return out;
}


/**
 * One month of the neighbourhood. Every block's desirability walks toward what
 * its surroundings now justify, with enough momentum that a district turns over
 * years rather than overnight.
 */
/**
 * DENSITY AND DEMAND HAVE TO AGREE, AND AT GENERATION THEY DID NOT.
 *
 * The player noticed this before the model did: "in some parts of the city
 * there are large buildings and heavy density where it feels weird to have it,
 * and others there's very high density and very low demand."
 *
 * They were right, and it is a reconciliation bug rather than a taste one.
 * demandScore is computed in the generator from two Gaussian distance
 * functions — transit gravity and employment gravity — and NOTHING ELSE. The
 * buildings are placed by a separate process keyed off zoning and era. The two
 * were never reconciled, so a block can carry six hundred thousand feet of
 * offices and score 30 for demand, or sit nearly empty at 80. In a real city
 * that cannot happen for long, because density IS demand made physical: the
 * jobs, residents and shopfronts in those buildings are what make the corner
 * worth something.
 *
 * And nothing corrected it afterwards, because the runtime model only measures
 * CHANGE against the generated baseline — so the original mismatch was frozen
 * in for the whole run.
 *
 * This runs once, at newGame, and pins that gap. Every block is scored on what
 * is actually standing on and around it, compared against what its gravity
 * score implied, and the difference is written into blockD as a permanent
 * offset. A dense block in a low-gravity corner gets the lift its own buildings
 * earned; an empty block riding on a station it does not use gets the haircut.
 * Drift from that day forward still works exactly as before, on top of it.
 */
export function reconcileDemand(s: GameState, parcels: ParcelTable) {
  const model = demandModel(parcels);
  if (!model.blocks.size) return;
  s.blockD = s.blockD ?? {};

  // What the built environment says each block is worth, and what its gravity
  // score said. Both as percentile ranks, so we are comparing shapes rather
  // than units.
  const rows: { id: string; e: number; g: number }[] = [];
  for (const b of model.blocks.values()) {
    const e = model.e0.get(b.id);
    if (e === undefined) continue;
    // the gravity score the generator gave this block, averaged over its lots
    let g = 0, n = 0;
    for (const bbl of b.bbls ?? []) {
      const rec = parcels[bbl];
      if (rec) { g += rec.demandScore; n++; }
    }
    if (!n) continue;
    rows.push({ id: b.id, e, g: g / n });
  }
  if (rows.length < 8) return;

  const rank = (vals: number[]) => {
    const sorted = [...vals].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array<number>(vals.length);
    sorted.forEach((x, k) => { out[x.i] = k / Math.max(1, sorted.length - 1); });
    return out;
  };
  const er = rank(rows.map((r) => r.e));
  const gr = rank(rows.map((r) => r.g));

  // The correction is deliberately PARTIAL. Gravity is real — a station and a
  // job centre make a corner valuable whether or not anyone has built on it
  // yet — so this does not overwrite it, it argues with it. Two thirds gravity,
  // one third what is actually there.
  //
  // AND IT HAS TO BE PERMANENT, WHICH IT WAS NOT. This wrote into `blockD`,
  // and `blockD` is the same field the monthly drift walks toward its own
  // target — a target that knows nothing about this correction. So the tick
  // decayed it away at the momentum rate: measured, 91.5% of it survived one
  // month, 34% survived a year and 4.3% survived three. A reconciliation the
  // player asked for lasted three years of a campaign with no end date. It
  // lives in its own field now, is never walked, and `blockD` is the sum.
  const WEIGHT = 34;
  s.blockA = s.blockA ?? {};
  for (let i = 0; i < rows.length; i++) {
    const delta = +((er[i] - gr[i]) * WEIGHT).toFixed(2);
    if (Math.abs(delta) >= 0.5) { s.blockA[rows[i].id] = delta; s.blockD[rows[i].id] = delta; }
  }
}

/**
 * A block's employment advantage: how far its own trades are out-hiring the
 * city, accumulated month by month and competed away on a ten-year half-life.
 * Reads the industry cycle that already exists and adds no state to it.
 */
function tickEmployment(s: GameState, model: DemandModel) {
  const mom = s.econ.industryMom;
  if (!mom) return;
  // THE CITY, WEIGHTED THE SAME WAY THE BLOCK IS. `m` below is each block's own
  // trade mix against the industry cycle; this is the number it is measured
  // against, and for a long time it was the flat mean of the ten. That is a
  // different weighting of the same quantity, so a block full of the city's
  // BIG trades read as out-hiring a city that did not count them as big — a
  // standing advantage to finance-and-law blocks that nothing had decided to
  // give them. See `sectorShare`.
  let city = 0;
  for (const k of SECTORS) city += (model.sectorShare[k] ?? 1 / SECTORS.length) * (mom[k] ?? 0);
  s.blockJ = s.blockJ ?? {};
  for (const [id, w] of model.trades) {
    let m = 0;
    for (const k of SECTORS) m += (w[k] ?? 0) * (mom[k] ?? 0);
    const next = clamp((s.blockJ[id] ?? 0) * (1 - EMP_DECAY) + EMP_RESPONSE * (m - city), -EMP_CAP, EMP_CAP);
    if (Math.abs(next) < 0.005) delete s.blockJ[id];
    else s.blockJ[id] = +next.toFixed(3);
  }
}

/**
 * The transit authority. One line a decade or so, announced six years before
 * anybody rides it, put where a city actually puts one: ground that is cheap,
 * buildable and badly served, and not on top of the last line.
 */
/** The copy for each stage of each kind. `name` is the street the work sits on. */
const WORK_COPY: Record<WorkKind, { rumor: (n: string, yrs: number) => string; funded: (n: string, yrs: number) => string; shelved: (n: string) => string; opened: (n: string, since: number) => string }> = {
  station: {
    rumor: (n, y) => `City Hall is circulating plans for a new station near ${n}. Alignments are being argued over and nothing is funded — a decision is ${y} years out, and the ground has not moved yet. It will.`,
    funded: (n, y) => `The transit authority has funded the new station at ${n}. First trains in ${y} years. Everything within a five-minute walk of that head-house is about to be worth more than it is today — and the people who own it already know.`,
    shelved: (n) => `The station plan at ${n} died in committee this morning. Whoever bought the rumour owns ordinary dirt again.`,
    opened: (n, y) => `The ${n} station opened this morning. Years of hoardings, and the ground around it is not the ground it was in ${y}.`,
  },
  park: {
    rumor: (n, y) => `The parks department is sketching a new park at ${n}. It is a drawing, not a budget — the vote is ${y} years out — but the blocks that would face it are worth watching.`,
    funded: (n, y) => `The city has funded the new park at ${n}. Ground broken this year, gates open in ${y}. A front-row address on a park is a different kind of address.`,
    shelved: (n) => `The park at ${n} was cut from the budget. The drawing goes in a drawer, and the frontage goes back to being frontage.`,
    opened: (n, y) => `The park at ${n} opened its gates this morning. The blocks that face it have not been ordinary since ${y}, and now everybody can see why.`,
  },
  bridge: {
    rumor: (n, y) => `Engineers have been seen surveying at ${n} — the bridge is back on the table. Nothing is funded and the argument is ${y} years from a vote, but a crossing changes what a whole quarter is attached to.`,
    funded: (n, y) => `The bridge at ${n} is funded. ${y} years of falsework, and then a quarter that used to be the far side of the water stops being far.`,
    shelved: (n) => `The bridge at ${n} was voted down. The far bank stays the far bank, and the rumour money goes home.`,
    opened: (n, y) => `The ${n} bridge carried its first traffic this morning. The far side has been repricing since ${y}; today it finished.`,
  },
};

function tickTransit(s: GameState, model: DemandModel, parcels: ParcelTable) {
  if (s.month < 24 || s.month % 12 !== 0) return;

  // The hearing. A rumoured work reaches its decision date and is either
  // funded — the announcement, where most of the repricing starts — or
  // shelved, removed outright so the corridor is open to a later plan.
  for (const l of [...(s.lines ?? [])]) {
    if (l.rumorM === undefined || s.month !== l.annM) continue;
    const kind: WorkKind = l.kind ?? "station";
    if (hash01(`${s.seed}:shelve:${l.id}:${l.annM}`) < SHELVE_ODDS) {
      s.lines = (s.lines ?? []).filter((x) => x !== l);
      s.news.unshift({ q: s.month, kind: "warn", text: WORK_COPY[kind].shelved(l.name) });
    } else {
      s.news.unshift({ q: s.month, kind: "event",
        text: WORK_COPY[kind].funded(l.name, Math.round((l.openM - s.month) / 12)) });
    }
  }

  // Hashed off the campaign seed rather than drawn from `s.rng`, deliberately.
  // Drawing here would shift the RNG stream for everything downstream of this
  // tick — every rival decision, every tenant, every listing — which turns a
  // change about geography into a change about all of it, and makes every
  // seed-pinned number anybody else has measured stop reproducing. It also
  // means a save-scummer cannot reroll the line. Same hash keys as the old
  // announcement-only mechanic, so every seed keeps the corridor and the year
  // it always had — what changed is that the year now starts a rumour rather
  // than a funded work.
  const yr = Math.floor(s.month / 12);
  if (hash01(`${s.seed}:line:${yr}`) >= LINE_ODDS) return;
  const cand = [...model.blocks.values()].filter((b) =>
    b.baseD < 55 && !(s.lines ?? []).some((l) => Math.hypot(l.cx - b.cx, l.cy - b.cy) < 900));
  if (!cand.length) return;
  const b = cand[Math.min(cand.length - 1, Math.floor(hash01(`${s.seed}:where:${yr}`) * cand.length))];
  const rec = parcels[b.bbls[0]];
  const name = rec?.address?.replace(/^\d+\s+/, "") ?? "the north end";
  const kr = hash01(`${s.seed}:kind:${yr}`);
  const kind: WorkKind = kr < 0.55 ? "station" : kr < 0.8 ? "park" : "bridge";
  const spec = WORK_KINDS[kind];
  const line = {
    id: b.id, cx: b.cx, cy: b.cy, name, kind, sigma: spec.sigma,
    rumorM: s.month, annM: s.month + RUMOR_M, openM: s.month + RUMOR_M + spec.buildM,
    pts: +(spec.lo + spec.span * hash01(`${s.seed}:size:${yr}`)).toFixed(1),
  };
  s.lines = [...(s.lines ?? []), line];
  s.news.unshift({ q: s.month, kind: "event", text: WORK_COPY[kind].rumor(name, Math.round(RUMOR_M / 12)) });
}

/** What the market pays for a civic work: a leak on the rumour, some on the funding vote, more once it is dug, all of it on opening day. */
function transitLift(s: GameState, b: BlockGeom): number {
  let v = 0;
  for (const l of s.lines ?? []) {
    const priced = s.month >= l.openM ? 1
      : s.month >= l.openM - 24 ? LINE_DIGGING
      : s.month >= l.annM ? LINE_EARLY
      : l.rumorM !== undefined && s.month >= l.rumorM ? LINE_RUMOR
      : 0;
    if (!priced) continue;
    const sig = l.sigma ?? LINE_SIGMA;
    const d = Math.hypot(b.cx - l.cx, b.cy - l.cy);
    v += l.pts * priced * Math.exp(-(d * d) / (2 * sig * sig));
  }
  return v;
}

export function tickDemand(s: GameState, parcels: ParcelTable) {
  const model = demandModel(parcels);
  if (!model.blocks.size) return;
  const occ = occupiedStock(s, parcels, model);
  s.blockD = s.blockD ?? {};
  s.blockE = s.blockE ?? {};
  // Published for the readers that do not get the parcel table — swans.ts is
  // the one that matters, since how many jobs a departing trade takes with it
  // depends entirely on how big that trade was here.
  s.econ.sectorShare = model.sectorShare;

  tickEmployment(s, model);
  tickTransit(s, model, parcels);
  tickPoles(s, model);

  // Blocks you have money in. A district turning is the slowest and most
  // valuable thing in this business and it happens a tenth of a point at a
  // time — so it gets said out loud when it crosses a round number, once,
  // and only where you actually own something.
  const mine = new Map<string, string>();
  for (const bbl of [...Object.keys(s.holdings), ...Object.keys(s.developments ?? {})]) {
    const id = model.ofBbl.get(bbl);
    if (id && !mine.has(id)) mine.set(id, parcels[bbl]?.address ?? bbl);
  }

  // ---- what each block's surroundings now justify --------------------------
  const raw = new Map<string, number>();
  for (const b of model.blocks.values()) {
    let j = 0, r = 0, a = 0;
    for (const n of b.neighbours) {
      const st = occ.get(n.id);
      if (!st) continue;
      for (const k of Object.keys(st) as BuiltClass[]) {
        const c = contribution(k, (st[k] ?? 0) * n.w);
        j += c.j; r += c.r; a += c.a;
      }
    }
    const acres = b.nbLandArea / 43_560;
    const mix = intensityOf((j / acres) / model.refJobs, (r / acres) / model.refPop, (a / acres) / model.refAmen);
    const lr = clamp(Math.log(mix / Math.max(1e-6, model.mix0.get(b.id) ?? mix)), -LOG_CAP, LOG_CAP);
    raw.set(b.id, RESPONSE * lr + (s.blockJ?.[b.id] ?? 0) + transitLift(s, b) + poleLift(s, b) + constructionLift(s, model, b));
  }

  // ---- DEMAND IS REDISTRIBUTIVE, NOT ADDITIVE -----------------------------
  //
  // This is the whole answer to "why does turning the gain up not run the
  // economy away". Desirability is a RELATIVE good: a corner is worth
  // something because it beats the next corner, and the total rent the city
  // can pay for location is set by the macro engine — jobs, output, the
  // cycle — not by this model. So every month the raw targets are centred on
  // their LAND-VALUE-weighted mean and only the differences survive. Building
  // a tower in a dead quarter takes desirability from somewhere else. A new
  // station makes its own six blocks better and everywhere else a shade
  // worse. There is no aggregate degree of freedom left for a runaway to live
  // in.
  //
  // Measured, holding the state fixed and switching the surface off: total
  // city land value with the drift is 0.974-0.992x the same city without it,
  // and total market rent 0.985-1.000x, flat over 50 years on three seeds.
  // With the centring removed the same runs read 1.14-1.22x land and
  // 1.08-1.11x rent by year 50, and still climbing.
  let centre = 0;
  for (const [id, v] of raw) centre += v * (model.landW.get(id) ?? 0);
  centre /= model.landWTot;

  for (const b of model.blocks.values()) {
    const target = clamp((raw.get(b.id) ?? 0) - centre, -DRIFT_CAP, DRIFT_CAP);
    const was = s.blockE[b.id] ?? 0;
    const e = +(was + (target - was) * MOMENTUM).toFixed(2);
    if (e === 0) delete s.blockE[b.id];
    else s.blockE[b.id] = e;

    const anchor = s.blockA?.[b.id] ?? 0;
    const now = s.blockD[b.id] ?? 0;
    const next = +clamp(anchor + e, -TOTAL_CAP, TOTAL_CAP).toFixed(2);
    if (next === 0) delete s.blockD[b.id];
    else s.blockD[b.id] = next;

    // only on the way out from zero, so a block hovering on a round number
    // does not announce itself twice a year
    const addr = mine.get(b.id);
    if (addr && Math.abs(next) > Math.abs(now) && Math.floor(Math.abs(next) / 10) > Math.floor(Math.abs(now) / 10)) {
      const step = Math.floor(Math.abs(next) / 10) * 10;
      s.news.unshift(next > 0
        ? { q: s.month, kind: "deal", text: `The blocks around ${addr} have gained ${step} points of demand since you came in — rents, tenant quality and land are all repricing off it.` }
        : { q: s.month, kind: "warn", text: `The blocks around ${addr} have lost ${step} points of demand — space is emptying out around you, and the appraisal follows.` });
    }
  }

  // A civic work opening is the loudest thing that happens to a map. Say it once.
  for (const l of s.lines ?? []) {
    if (s.month !== l.openM) continue;
    s.news.unshift({ q: s.month, kind: "event",
      text: WORK_COPY[l.kind ?? "station"].opened(l.name, START_YEAR + Math.floor((l.rumorM ?? l.annM) / 12)) });
  }
}

/**
 * A parcel's live demand: what the generator gave it, plus whatever its
 * neighbourhood has become since. Clamped, because nothing in Ashport is
 * worthless and nothing is perfect.
 */
export function demandNow(s: GameState, rec: ParcelRecord): number {
  return clamp(rec.demandScore + (s.blockD?.[rec.block] ?? 0), 2, 100);
}

/**
 * What a block is made of right now, for the panel that shows you why a corner
 * is getting better. Nothing here is computed for the simulation — it is the
 * same numbers, phrased for a person.
 */
export function blockReport(s: GameState, parcels: ParcelTable, block: string): {
  jobs: number; residents: number; amenitySf: number; baseD: number; drift: number;
  /** the block's employment advantage right now, in demand points */
  hiring: number;
  /** the three trades most of the work around here is in */
  trades: { k: Sector; label: string; share: number }[];
  /** a funded line inside the walk, and how many months until it runs */
  line: { name: string; monthsOut: number; pts: number } | null;
  /** each leg against what counts as a full measure of it in this city, 0..1+ */
  mix: { jobs: number; residents: number; amenity: number };
  /** the programme that would lift this block most per square foot */
  wants: WantsKey;
  /** true when no use is meaningfully better than the next — the block is balanced */
  balanced: boolean;
} | null {
  const model = demandModel(parcels);
  const b = model.blocks.get(block);
  if (!b) return null;
  const occ = occupiedStock(s, parcels, model);
  let j = 0, r = 0, a = 0;
  for (const n of b.neighbours) {
    const st = occ.get(n.id);
    if (!st) continue;
    for (const k of Object.keys(st) as BuiltClass[]) {
      const c = contribution(k, (st[k] ?? 0) * n.w);
      j += c.j; r += c.r; a += c.a;
    }
  }
  const acres = b.nbLandArea / 43_560;
  const norm = (jj: number, rr: number, aa: number) =>
    emergenceOf((jj / acres) / model.refJobs, (rr / acres) / model.refPop, (aa / acres) / model.refAmen);
  const mix = {
    jobs: (j / acres) / model.refJobs,
    residents: (r / acres) / model.refPop,
    amenity: (a / acres) / model.refAmen,
  };
  // Which use would help most is NOT simply "whichever index reads lowest".
  // Retail brings jobs and a shopfront; a mixed stack brings all three at once.
  // So ask the model instead of guessing at it: add the same test floorplate as
  // each single use AND as a mixed-use building, and see which moves the block.
  const PROBE_SF = 60_000;
  const here = norm(j, r, a);
  const candidates: { key: WantsKey; mix: UseMix }[] = [
    { key: "office", mix: { office: 1 } },
    { key: "retail", mix: { retail: 1 } },
    { key: "multifamily", mix: { multifamily: 1 } },
    { key: "industrial", mix: { industrial: 1 } },
    { key: "mixed", mix: MIXED_PROBE },
  ];
  let wants: WantsKey = "mixed";
  let bestGain = -Infinity, secondGain = -Infinity;
  for (const cand of candidates) {
    let cj = 0, cr = 0, ca = 0;
    for (const u of Object.keys(cand.mix) as BuiltClass[]) {
      const c = contribution(u, PROBE_SF * (cand.mix[u] ?? 0));
      cj += c.j; cr += c.r; ca += c.a;
    }
    const gain = norm(j + cj, r + cr, a + ca) - here;
    if (gain > bestGain) { secondGain = bestGain; bestGain = gain; wants = cand.key; }
    else if (gain > secondGain) secondGain = gain;
  }
  return {
    jobs: Math.round(j), residents: Math.round(r), amenitySf: Math.round(a),
    baseD: b.baseD,
    // What has happened since 2000 — which is NOT the day-one reconciliation
    // between what is standing here and what the gravity score said.
    drift: +((s.blockD?.[block] ?? 0) - (s.blockA?.[block] ?? 0)).toFixed(2),
    hiring: +(s.blockJ?.[block] ?? 0).toFixed(1),
    trades: SECTORS
      .map((k) => ({ k, label: INDUSTRY_LABEL[k], share: model.trades.get(block)?.[k] ?? 0 }))
      .sort((x, y) => y.share - x.share).slice(0, 3),
    line: (() => {
      let best: { name: string; monthsOut: number; pts: number } | null = null;
      for (const l of s.lines ?? []) {
        const sig = l.sigma ?? LINE_SIGMA;
        const d = Math.hypot(b.cx - l.cx, b.cy - l.cy);
        if (d > sig * 1.6) continue;
        const p = l.pts * Math.exp(-(d * d) / (2 * sig * sig));
        if (!best || p > best.pts) best = { name: l.name, monthsOut: l.openM - s.month, pts: +p.toFixed(1) };
      }
      return best;
    })(),
    mix, wants,
    balanced: !(bestGain > secondGain * 1.35),
  };
}
