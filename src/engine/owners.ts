/**
 * WHO OWNS THE OTHER NINE HUNDRED BUILDINGS.
 *
 * A dozen named firms own a few hundred lots between them. Everything else in
 * this city belonged to "a partnership in dispute" or "an institutional owner"
 * — an archetype, correctly derived from the building's own record, and
 * entirely anonymous. Open the fifty biggest buildings in town and fifty
 * identical labels look back at you.
 *
 * That is not how a city feels to anybody who works in one. In a real market
 * the big private holdings have NAMES, and everyone in the business knows them:
 * the family that has owned the corner since the twenties and will not sell it
 * to you or anybody, the two brothers who fell out in 1998, the pension fund
 * that bought eleven buildings in one afternoon and has been trying to get out
 * of the sector ever since, the estate that is about to be settled. You do not
 * negotiate with an archetype. You negotiate with the Ainsworths, and what
 * happened the last time you dealt with the Ainsworths is the single most
 * important fact in the room.
 *
 * SO THIS IS A REGISTER OF DEEDS, and three things follow from it that could
 * not exist before:
 *
 *   ONE OWNER, MANY BUILDINGS. A holder is a person with a portfolio, so the
 *   same seller turns up across the map and behaves consistently everywhere.
 *   Their style is a fact about them, not a re-draw per building.
 *
 *   THEY REMEMBER YOU, ACROSS ALL OF IT. Lowball the Calloway estate on one
 *   building and you have not annoyed a building — you have annoyed a family
 *   with four of them, and the other three doors close too. This is the wire
 *   that makes reputation local and personal instead of a global mark, and it
 *   is the reason a careful buyer works a relationship rather than a listing.
 *
 *   THEY HAVE LIVES. Estates get settled, funds reach the end of a hold, an
 *   old man finally retires — and when that happens a NAMED holder's whole
 *   book comes to market at once, which is where the interesting stock in any
 *   real cycle actually comes from.
 *
 * HOW IT IS BUILT, AND WHY IT COSTS NOTHING. The register is generated from the
 * city's own deed table, and every deed is assigned to a holder by HASH — no
 * draw from the shared RNG stream, the same discipline `ledger.ts` follows for
 * lender assignment, because a register that consumed the stream would re-roll
 * the whole century the day anybody added a name to a list. It is therefore
 * derivable rather than stored: a save carries the holders' MEMORY of you, not
 * the map of who owns what, which cannot drift because it is recomputed from
 * the deeds every time.
 *
 * THE SHAPE OF OWNERSHIP IS A POWER LAW, and that is the part that has to be
 * right. Ownership of commercial property is far more concentrated than
 * ownership of anything else in a city: in any real downtown a handful of
 * families and institutions hold most of the square footage and a very long
 * tail holds one building each. Assignment is therefore banded by SIZE — the
 * towers land on a small set of major holders, the middle market on a wider
 * set, and the small stock on a tail — which produces the concentration
 * without anyone having to sort the city.
 */
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { GameState, SellerKind } from "./types";
import { START_YEAR } from "./types";
import { resolveRec, holdingValue } from "./value";
import { ownerOf } from "./rivals";

/** Deterministic 0..1 from a string. Never touches the RNG stream. */
function hash01(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

export type HolderTier = "major" | "middle" | "small";

export interface Holder {
  id: string;
  name: string;
  /** How they behave at the table — the same SellerKind the negotiation already reads. */
  kind: SellerKind;
  tier: HolderTier;
  /** The decade the family, fund or partnership got into this town. */
  since: number;
  /** One line a broker would tell you in the car on the way over. */
  note: string;
}

// The pools. Kept separate from `rivals.ts` on purpose: those are OPERATING
// firms with balance sheets that bid against you, and these are HOLDERS. A
// holder is not a competitor — most property in any city is owned by somebody
// who is not in your business at all, and conflating the two would put four
// hundred more bidders in every auction.
const SURNAMES = [
  "Ainsworth", "Battersby", "Calloway", "Devereaux", "Ellsworth", "Fairbairn",
  "Grantham", "Holloway", "Isherwood", "Jarrow", "Kestrel", "Lockridge",
  "Marchetti", "Nolan", "Ockenden", "Pemberly", "Quillan", "Radcliffe",
  "Sutcliffe", "Tarrant", "Ulverston", "Vandermeer", "Whitlock", "Yeardley",
  "Abernathy", "Braddock", "Cavanagh", "Delaney", "Emsworth", "Fitzhugh",
  "Gallagher", "Hargreaves", "Ivory", "Jessamine", "Kilcannon", "Lindquist",
  "Mowbray", "Northcote", "Orsini", "Pelletier", "Quintrell", "Rosewood",
  "Sandoval", "Thorne", "Umbridge", "Vasquez", "Wexley", "Yarborough",
];

const FAMILY_FORM = ["Family Trust", "& Sons", "Brothers", "Estate", "Holdings", "& Daughters"];
const PARTNER_FORM = ["Partners", "Associates", "Group", "Property Partners", "Realty Partners"];
const INSTITUTION_FORM = [
  "Life Assurance", "Pension Board", "Endowment", "Mutual Trust",
  "Insurance Company", "Investment Trust",
];
const DEVELOPER_FORM = ["Development Co.", "Builders", "Construction & Realty", "Development Partners"];
const PLACE = [
  "Harbour", "Northgate", "Old Mill", "Cathedral", "Stonebridge", "Fairhaven",
  "Kingsway", "Riverside", "Beacon", "Copperworks", "Guildhall", "Saltmarsh",
];

/**
 * WHAT KIND OF PEOPLE HOLD WHAT KIND OF BUILDING. The archetype logic that used
 * to live in `anonymousOwner` — which read it off the building every time — now
 * decides the composition of the REGISTER instead, once, so that the holder is
 * a person with a consistent nature rather than a property of whatever deed you
 * happen to be looking at.
 *
 * The mix by tier is the observed shape of who owns what. Towers belong to
 * institutions and to the two or three families that have been here longest;
 * the middle market is partnerships and local operators; the small stock is
 * families, estates, and the people who built it.
 */
const TIER_MIX: Record<HolderTier, { kind: SellerKind; w: number }[]> = {
  major: [
    { kind: "institution", w: 0.46 },
    { kind: "local", w: 0.22 },        // the old family that owns half the high street
    { kind: "partnership", w: 0.20 },
    { kind: "developer", w: 0.12 },
  ],
  middle: [
    { kind: "partnership", w: 0.34 },
    { kind: "local", w: 0.30 },
    { kind: "institution", w: 0.16 },
    { kind: "developer", w: 0.12 },
    { kind: "estate", w: 0.08 },
  ],
  small: [
    { kind: "local", w: 0.40 },
    { kind: "estate", w: 0.24 },
    { kind: "partnership", w: 0.22 },
    { kind: "developer", w: 0.14 },
  ],
};

function kindFor(tier: HolderTier, r: number): SellerKind {
  const mix = TIER_MIX[tier];
  let acc = 0;
  for (const m of mix) { acc += m.w; if (r < acc) return m.kind; }
  return mix[mix.length - 1].kind;
}

/**
 * A NAME, AND ENOUGH OF THEM THAT NOBODY IS CALLED THE SAME THING TWICE.
 *
 * `k` walks the name space deterministically when a name is taken — form
 * first, then surname — so a collision resolves without a draw and without the
 * register depending on the order it was built in. A partnership takes two
 * surnames, which is both how partnerships are actually named and what opens
 * the space wide enough for a long tail: forty-eight surnames give a few
 * hundred family names and a few thousand partnerships.
 */
function nameFor(kind: SellerKind, si: number, r: number, place: string, k: number): string {
  const sn = (i: number) => SURNAMES[((i % SURNAMES.length) + SURNAMES.length) % SURNAMES.length];
  const surname = sn(si + Math.floor(k / 6));
  switch (kind) {
    case "institution": {
      const f = INSTITUTION_FORM[(Math.floor(r * 1000) + k) % INSTITUTION_FORM.length];
      return r < 0.45 ? `${place} ${f}` : `${surname} ${f}`;
    }
    case "estate":
      return k % 2 === 0 ? `the ${surname} Estate` : `the ${surname} Family Estate`;
    case "developer":
      return `${surname} ${DEVELOPER_FORM[(Math.floor(r * 4801) + k) % DEVELOPER_FORM.length]}`;
    case "partnership": {
      const other = sn(si + 7 + k);
      const f = PARTNER_FORM[(Math.floor(r * 3313) + k) % PARTNER_FORM.length];
      return r < 0.5 ? `${surname} & ${other}` : `${surname} ${f}`;
    }
    default:
      return `${surname} ${FAMILY_FORM[(Math.floor(r * 2381) + k) % FAMILY_FORM.length]}`;
  }
}

function noteFor(kind: SellerKind, since: number, tier: HolderTier, r: number): string {
  const long = START_YEAR - since;
  switch (kind) {
    case "institution":
      return r < 0.5
        ? `Bought into this town in ${since} and has been quietly deciding whether to be here ever since. There is a committee, a mandate, and a hold period.`
        : `A ${long > 50 ? "very old" : "long-standing"} allocation to property that somebody at head office reviews every year.`;
    case "estate":
      return `Held in an estate since the last of them died. Executors, heirs, and a clock nobody in the family controls.`;
    case "developer":
      return r < 0.5
        ? `Built most of what they own, in ${since}. They are recyclers — everything is for sale at the right number.`
        : `A builder who kept a few. They know exactly what it cost and exactly what it is worth.`;
    case "partnership":
      return r < 0.45
        ? `Two partners who have not spoken since ${since + 20}. Nothing here gets agreed once.`
        : `A partnership put together in ${since}. Every decision needs more than one signature.`;
    default:
      return tier === "major"
        ? `They have owned this side of town since ${since} and they do not need the money.`
        : `A local family, in since ${since}. They will talk, but they know what the corner is worth.`;
  }
}

/**
 * HOW MANY HOLDERS A TOWN OF THIS SIZE HAS.
 *
 * Not a constant: a town with three hundred buildings and a town with two
 * thousand do not have the same number of landlords. The ratios are the shape
 * of concentration — roughly one major holder per fifty buildings, one middle
 * holder per twelve, and a tail sized so the small stock is genuinely
 * fragmented. Both bounds exist so a tiny generated town still has somebody in
 * it and a huge one does not run out of surnames.
 */
function counts(built: number): { major: number; middle: number; small: number } {
  return {
    major: Math.max(3, Math.min(12, Math.round(built / 60))),
    middle: Math.max(8, Math.min(55, Math.round(built / 9))),
    // THE TAIL HAS TO BE A TAIL. The first cut gave 48 small holders for five
    // hundred small buildings — ten each — and measured, only two names in the
    // whole town owned exactly one building while the top ten held 31% of the
    // floor area. That is not a city, it is a cartel. Real ownership of small
    // commercial stock is overwhelmingly one-building owners: the man who owns
    // the shop he trades from and the flat above it.
    small: Math.max(20, Math.min(150, Math.round(built / 3.2))),
  };
}

/**
 * The register, built from the deed table. Pure, deterministic in (parcels,
 * seed) and therefore identical on every load of the same town.
 */
export function buildRegister(parcels: ParcelTable, seed: number): Holder[] {
  let built = 0;
  for (const p of Object.values(parcels)) if (p.class !== "land" && p.bldgArea > 0) built++;
  const n = counts(built);
  const out: Holder[] = [];
  const used = new Set<string>();
  const make = (tier: HolderTier, i: number) => {
    const base = `${tier}:${i}:${seed}`;
    const r = hash01(base);
    const r2 = hash01(base + ":k");
    const r3 = hash01(base + ":y");
    const si = Math.floor(hash01(base + ":n") * SURNAMES.length);
    const kind = kindFor(tier, r2);
    const place = PLACE[Math.floor(hash01(base + ":p") * PLACE.length)];
    // A town does not have two firms with the same name on the door. Walk the
    // space rather than re-hashing, so the fallback is deterministic too.
    let name = nameFor(kind, si, r, place, 0);
    for (let k = 1; used.has(name) && k < 400; k++) name = nameFor(kind, si, r, place, k);
    used.add(name);
    // The old money is old. A major family holding predates the war; a small
    // developer bought in the eighties. This is what the note is written from
    // and it is what makes a register read like a place with a history.
    const since = kind === "institution"
      ? START_YEAR - Math.round(20 + r3 * 45)
      : tier === "major" ? START_YEAR - Math.round(45 + r3 * 60)
      : START_YEAR - Math.round(15 + r3 * 55);
    out.push({
      id: `${tier[0]}${i}`,
      name,
      kind, tier, since,
      note: noteFor(kind, since, tier, hash01(base + ":note")),
    });
  };
  for (let i = 0; i < n.major; i++) make("major", i);
  for (let i = 0; i < n.middle; i++) make("middle", i);
  for (let i = 0; i < n.small; i++) make("small", i);
  return out;
}

/**
 * WHICH TIER OF HOLDER OWNS A BUILDING OF THIS SIZE.
 *
 * Concentration by square footage, which is the observed shape: the towers are
 * held by a handful of names, the middle market by a few dozen, and the small
 * stock is fragmented across everybody else. The thresholds are the same ones
 * `anonymousOwner` used to read — 150k sf is where a building needs a
 * management company, 25-60k is where it needs a manager — so the composition
 * of the city's ownership has not moved; only its anonymity has.
 */
function tierOf(rec: ParcelRecord, r: number): HolderTier {
  const sf = rec.bldgArea ?? 0;
  if (sf >= 150_000) return "major";
  if (sf >= 60_000) return r < 0.72 ? "major" : "middle";
  if (sf >= 25_000) return r < 0.30 ? "major" : r < 0.85 ? "middle" : "small";
  if (sf >= 9_000) return r < 0.06 ? "major" : r < 0.52 ? "middle" : "small";
  return r < 0.14 ? "middle" : "small";
}

/**
 * The register for this game.
 *
 * MEMOISED IN THE MODULE, NOT ON THE STATE, and that is not a detail. The first
 * cut cached it onto `s.holders`, which meant `holderOf` — called from the
 * negotiation, from `sellerOf`, and from half a dozen UI render paths — MUTATED
 * the state it was handed. This engine's whole contract is that its functions
 * are pure over JSON state, and a reader that writes is the kind of thing that
 * works perfectly until the day something reads it during a render or from a
 * state that is about to be discarded.
 *
 * It costs nothing to drop: the register is a pure function of (deeds, seed),
 * both of which a save carries, so it is rebuilt identically on every load and
 * never needs to be stored at all. Only the HOLDERS' MEMORY of the player is
 * saved, because that is the only part that is not derivable.
 */
// Key by the parcel table itself. `register()` used to COUNT every built parcel
// on every lookup merely to construct `${seed}:${built}` as a cache key.
// holderOf is called inside map renders, negotiations and holdingsOf; on a
// 5,900-lot Great City that turned common clicks into an O(N²) walk and
// produced measured 3.3–3.6 second main-thread stalls. A city's parcel table
// is immutable and identity-stable for the run, so a WeakMap is the exact key
// and lets abandoned towns be collected without a manual size cap.
const REGISTRY = new WeakMap<ParcelTable, Map<number, Holder[]>>();
const TIER_POOLS = new WeakMap<Holder[], Record<HolderTier, Holder[]>>();
export function register(s: GameState, parcels: ParcelTable): Holder[] {
  let bySeed = REGISTRY.get(parcels);
  if (!bySeed) {
    bySeed = new Map<number, Holder[]>();
    REGISTRY.set(parcels, bySeed);
  }
  let reg = bySeed.get(s.seed);
  if (!reg) {
    reg = buildRegister(parcels, s.seed);
    bySeed.set(s.seed, reg);
  }
  return reg;
}

/**
 * WHO HOLDS THIS DEED. Null for a lot the player or a named firm owns, and for
 * bare land — dirt is held by somebody waiting for something, and the game
 * already says so without needing a family attached to it.
 */
export function holderOf(s: GameState, parcels: ParcelTable, bbl: string): Holder | null {
  const rec = resolveRec(parcels, s, bbl);
  if (!rec || rec.class === "land" || !(rec.bldgArea > 0)) return null;
  if (s.holdings[bbl] || ownerOf(s, bbl)) return null;
  const reg = register(s, parcels);
  if (!reg.length) return null;
  const r = hash01(bbl + ":t");
  const tier = tierOf(rec, r);
  let pools = TIER_POOLS.get(reg);
  if (!pools) {
    pools = { major: [], middle: [], small: [] };
    for (const h of reg) pools[h.tier].push(h);
    TIER_POOLS.set(reg, pools);
  }
  const pool = pools[tier];
  if (!pool.length) return reg[Math.floor(hash01(bbl) * reg.length)];
  // AND CONCENTRATED WITHIN THE TIER TOO. A uniform pick makes every holder in
  // a band the same size, which is the one shape ownership never has: inside
  // the small stock there is still a man with nine shops and four hundred with
  // one. Squaring the draw biases toward the front of the pool, so a few names
  // in every band hold a great deal and the rest hold one thing each — which
  // is the power law the whole register is trying to be.
  const u = hash01(bbl + ":h");
  return pool[Math.min(pool.length - 1, Math.floor(pool.length * u * u))];
}

/** Everything a holder owns today, which is a fact about the deed table. */
export function holdingsOf(s: GameState, parcels: ParcelTable, id: string): string[] {
  const out: string[] = [];
  for (const bbl of Object.keys(parcels)) {
    const h = holderOf(s, parcels, bbl);
    if (h?.id === id) out.push(bbl);
  }
  return out;
}

/** What a holder's book is worth, for the panel and for the life events. */
export function bookOf(s: GameState, parcels: ParcelTable, id: string): { bbls: string[]; value: number; sf: number } {
  const bbls = holdingsOf(s, parcels, id);
  let value = 0, sf = 0;
  for (const b of bbls) {
    const rec = resolveRec(parcels, s, b);
    if (!rec) continue;
    sf += rec.bldgArea ?? 0;
    value += holdingValue(rec, s.econ, {
      bbl: b, tenants: [], occ: 0, condition: "standard", boughtM: 0, costBasis: 0, programsDone: {},
    } as never, s.month);
  }
  return { bbls, value, sf };
}

// ---------------------------------------------------------------- the memory

export interface HolderRel {
  /** They will not take your call until this month. Set by an offence. */
  coldUntilM?: number;
  /** How many times you have insulted them. It does not reset. */
  offences?: number;
  /** Deals actually closed with this holder. The other half of a relationship. */
  deals?: number;
  /** The month of the last thing that happened between you, for the panel. */
  lastM?: number;
}

export function relOf(s: GameState, id: string): HolderRel {
  return s.holderRel?.[id] ?? {};
}

/** Shared copy for every acquire door that reads holder memory. */
export function coldRefuseMsg(held: Holder): string {
  return `${held.name} will not sell to you. Whatever happened between you, they have not forgotten it. `
    + `It is still for sale — just not to you.`;
}

/** Named holder of this deed who is refusing you today, or null. */
export function coldOnDeed(s: GameState, parcels: ParcelTable, bbl: string): Holder | null {
  const held = holderOf(s, parcels, bbl);
  if (held && isCold(s, held.id)) return held;
  return null;
}

/**
 * Hang up every open conversation with this holder across their book.
 *
 * An insult on one corner used to leave live asks and open talks on their
 * other deeds — so you could still buyOffMarket / acceptCounter elsewhere
 * while the register said they would not take your call. A family that has
 * just been lowballed does not carefully keep that opinion filed under one
 * address. Signed contracts (`talks.agreed`) stand; everything else dies.
 */
export function hangUpWithHolder(s: GameState, parcels: ParcelTable, id: string) {
  const until = relOf(s, id).coldUntilM ?? s.month + 1;
  for (const [bbl, a] of Object.entries(s.approaches)) {
    if (holderOf(s, parcels, bbl)?.id !== id) continue;
    s.approaches[bbl] = {
      ...a,
      refused: true,
      coldUntilM: Math.max(a.coldUntilM ?? 0, until),
    };
  }
  if (!s.talks) return;
  for (const [bbl, t] of Object.entries(s.talks)) {
    if (t.agreed) continue;
    if (holderOf(s, parcels, bbl)?.id !== id) continue;
    delete s.talks[bbl];
  }
}

/**
 * AN OFFENCE AGAINST A HOLDER IS AN OFFENCE AGAINST EVERY DEED THEY OWN.
 *
 * This is the whole point of the register. `shutDoor` in actions.ts closes one
 * conversation about one building; a family that has just been lowballed does
 * not carefully keep that opinion filed under the address. The cold period runs
 * on the HOLDER, every approach to any of their buildings reads it, and it
 * hardens with repetition — the second insult costs half again as long as the
 * first, because by then they have a view about you rather than about an offer.
 *
 * Pass `parcels` so the hang-up reaches every live conversation in their book;
 * tests that only assert the cold clock may omit it.
 */
export function offend(s: GameState, id: string, months: number, parcels?: ParcelTable) {
  if (!s.holderRel) s.holderRel = {};
  const rel = s.holderRel[id] ?? {};
  const n = (rel.offences ?? 0) + 1;
  const cold = Math.round(months * (1 + 0.5 * (n - 1)));
  s.holderRel[id] = {
    ...rel,
    offences: n,
    coldUntilM: Math.max(rel.coldUntilM ?? 0, s.month + cold),
    lastM: s.month,
  };
  if (parcels) hangUpWithHolder(s, parcels, id);
}

/** ...and a deal closed is the other half. A holder who has sold to you before
 *  answers the phone, which is most of what a track record is worth in this
 *  business. */
export function credit(s: GameState, id: string) {
  if (!s.holderRel) s.holderRel = {};
  const rel = s.holderRel[id] ?? {};
  s.holderRel[id] = { ...rel, deals: (rel.deals ?? 0) + 1, lastM: s.month };
}

/**
 * HOW A HOLDER FEELS ABOUT YOU, as a multiplier on their willingness to talk.
 * Above 1 means harder. A history of clean closings is worth about as much as
 * a single insult costs, which is the honest exchange rate: it takes several
 * good deals to undo one bad conversation and everybody in the business knows
 * it.
 */
export function relMult(s: GameState, id: string): number {
  const rel = relOf(s, id);
  const off = rel.offences ?? 0;
  const deals = rel.deals ?? 0;
  return Math.max(0.72, Math.min(1.9, 1 + 0.22 * off - 0.09 * deals));
}

/** Are they refusing to take your call at all today? */
export function isCold(s: GameState, id: string): boolean {
  return (relOf(s, id).coldUntilM ?? 0) > s.month;
}

/** One line for the panel: where you stand with these people. */
export function standingWith(s: GameState, id: string): string {
  const rel = relOf(s, id);
  if (isCold(s, id)) {
    return `They are not taking your call until ${START_YEAR + Math.floor((rel.coldUntilM ?? 0) / 12)}.`;
  }
  const off = rel.offences ?? 0, deals = rel.deals ?? 0;
  if (deals >= 3) return `You have closed ${deals} deals with them. They know you and they pick up.`;
  if (deals > 0 && off === 0) return `You have traded with them before, cleanly.`;
  if (off >= 2) return `You have insulted them ${off} times. They remember.`;
  if (off === 1) return `There was an offer they did not care for. It has not been forgotten.`;
  return "You have never done business with them.";
}


// ------------------------------------------------------------ the life of a holder
//
// WHY A NAMED HOLDER HAS TO BE ABLE TO LEAVE.
//
// The register would be decoration if the names never did anything. The most
// interesting stock in any real cycle does not arrive one building at a time
// from nobody in particular — it arrives because SOMEBODY'S CIRCUMSTANCES
// CHANGED: an estate was settled, a fund's hold period ended, a partnership
// finally split, the old man retired. When that happens the whole book comes to
// market at once, under a name everyone in town knows, and every buyer in the
// city reads the same headline on the same morning.
//
// That is the event this produces, and it produces it out of who the holder IS.
// A family that has been here since 1948 is not going to be liquidated by a
// committee; an insurance company is not going to have an estate settled. Each
// kind exits the way its kind exits, at a rate that puts a handful of these in
// front of the player over a career rather than one a month.
//
// THE HAZARDS ARE ANNUAL RATES EXPRESSED MONTHLY, and they are demographic
// rather than tuned. An estate settles when somebody dies: a holding family
// turns over roughly once a generation, so about 3% a year. An institutional
// hold period runs seven to twelve years and ends in a decision, so about 8% a
// year once it is mature — funds ARE sellers, that is what a hold period is. A
// partnership that has not spoken in twenty years splits eventually. A
// developer recycles constantly and is the least newsworthy of the four.
const EXIT_HAZARD: Record<string, number> = {
  estate: 0.030 / 12,
  local: 0.026 / 12,          // a family: a generation is thirty-odd years
  institution: 0.080 / 12,    // a hold period ends and somebody decides
  partnership: 0.045 / 12,
  developer: 0.070 / 12,      // they recycle; it is the business
  lender: 0,
};

/** How the tape reports it, in the holder's own terms. */
function exitStory(h: Holder, n: number): string {
  const many = n > 1 ? `${n} buildings` : "the building";
  switch (h.kind) {
    case "estate":
      return `${h.name} is being settled. The executors have instructed agents on ${many} — heirs in three places and none of them wants a shopping centre.`;
    case "local":
      return `${h.name} are getting out. After ${START_YEAR - h.since} years on this side of town the family has put ${many} up, which everybody in the business will read as the end of something.`;
    case "institution":
      return `${h.name} has taken the decision to exit the sector locally. ${many === "the building" ? "One building" : many} come to market, and a committee that has approved a sale does not change its mind.`;
    case "partnership":
      return `${h.name} has finally split. ${many === "the building" ? "The building goes" : many + " go"} to market because that is the only way two people who do not speak can divide anything.`;
    default:
      return `${h.name} is recycling. ${many === "the building" ? "One building" : many} to market — they built it, they leased it, and the equity is wanted elsewhere.`;
  }
}

/**
 * One month of the register's own life. Returns the buildings that should come
 * to market this month, which `refreshListings` lists on the seller's terms —
 * this file does not mint listings itself, because there is one place that
 * knows how to price an ask and it is not here.
 *
 * The RNG stream IS consumed here, and deliberately: an exit is an event in the
 * world with a date, not a property of a deed, and the alternative — hashing it
 * off the month — would make every town's estates settle in the same year.
 */
export function tickHolders(
  s: GameState, parcels: ParcelTable, rng: (s: GameState) => number,
): { bbls: string[]; distress: boolean; kind?: string } {
  // ONLY THE NAMES WITH BOOKS. A one-building owner selling their one building
  // is not an event, it is a listing, and the tape already generates those
  // from the same stock — dressing it up with a headline would be the news
  // page filing routine business as news, which this repo has already fixed
  // once. What is an event is a holder with a BOOK leaving the market, and
  // there are about sixty of those in a town this size rather than two
  // hundred.
  const reg = register(s, parcels).filter((h) => h.tier !== "small");
  if (!reg.length) return { bbls: [], distress: false };
  // ONE CANDIDATE A MONTH, SCALED. Walking the whole register every month
  // would consume the RNG stream in proportion to how many names a town
  // happens to have, so city size would re-roll the century — the exact fault
  // CLAUDE.md warns about. Testing one uniformly drawn holder against its own
  // hazard TIMES the register size is an unbiased estimator of the same
  // aggregate: E[h x N] over a uniform draw is the sum of the hazards, which
  // is the number of exits a year the demography actually implies. Two draws a
  // month, whatever the town's size.
  // `rng` here is a CALLBACK the caller passes — usually `s => marketRng(s, "owners")`.
  // It is not market.rng; do not add a channel argument.
  const h = reg[Math.floor(rng(s) * reg.length)];
  if (!h) return { bbls: [], distress: false };
  // A holder who has already been through this does not do it twice.
  if (s.holderExit?.[h.id] !== undefined) return { bbls: [], distress: false };
  const hz = (EXIT_HAZARD[h.kind] ?? 0.03 / 12) * (h.tier === "major" ? 0.7 : 1) * reg.length;
  if (rng(s) > hz) return { bbls: [], distress: false };
  const book = holdingsOf(s, parcels, h.id).filter((b) => !s.listings.some((l) => l.bbl === b));
  if (!book.length) return { bbls: [], distress: false, kind: h.kind };
  // Not the whole book at once in every case: an estate sells everything, a
  // fund trims. What comes is enough to be a story.
  const share = h.kind === "estate" ? 1 : h.kind === "institution" ? 0.7 : h.kind === "developer" ? 0.4 : 0.8;
  // ...AND NOBODY DUMPS FOURTEEN BUILDINGS ON A TUESDAY. Executors instruct
  // agents on a few at a time and a fund sells in tranches, because putting a
  // whole book on the tape at once is the surest way to be paid the least for
  // it — every buyer in town can see what you are doing. Six is the most that
  // comes at once; the rest of the book stays where it is and comes to market
  // through the ordinary listing flow like anything else.
  const take = Math.max(1, Math.min(book.length, 6, Math.round(book.length * share)));
  const bbls = book.slice(0, take);
  if (!s.holderExit) s.holderExit = {};
  s.holderExit[h.id] = s.month;
  s.news.unshift({ q: s.month, kind: "event", text: exitStory(h, bbls.length) });
  // WHO IS SELLING DECIDES WHETHER IT IS CHEAP. An estate and a split
  // partnership want it DONE and price it that way; a fund with a committee
  // and a developer recycling do not have to take a discount and will not.
  return {
    bbls,
    distress: h.kind === "estate" || h.kind === "partnership",
    kind: h.kind,
  };
}
