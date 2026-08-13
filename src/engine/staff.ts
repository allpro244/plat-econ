/**
 * THE PAYROLL.
 *
 * Everything in this game so far has been done by nobody. Buildings were
 * managed, space was leased, and expenses were controlled by an invisible
 * competence that came free with owning the deed. The firm's overhead line
 * (see sim.ts, the `ga` block) is the shape of that fiction: ~30bps of gross
 * asset value a year over a small fixed base, an office full of people you
 * could not see, hire, or lose.
 *
 * This module makes two of them real: a property manager and a leasing agent.
 *
 * THE MECHANISM IS CAPACITY, NOT A MULTIPLIER.
 *
 * A dial that reads "good manager: opex x0.94" is a difficulty setting wearing
 * a job title, and CLAUDE.md forbids it. What is actually true about the
 * business is that a person covers a certain amount of property and no more. A
 * landlord with two buildings manages them himself perfectly well. The same
 * landlord with twenty does not, and the failure is not that he becomes stupid
 * — it is that the roof inspection slips, the renewal conversation happens two
 * months late, and the vendor contract rolls over unexamined. Work that is not
 * done costs money.
 *
 * So every role has a CAPACITY in square feet, the portfolio has a LOAD, and
 * what degrades is the work, gradually and increasingly, the further past
 * capacity you are. Difficulty is an output of the arithmetic. Nobody typed it.
 *
 * WHAT THE NUMBERS ARE ANCHORED TO
 *
 * Capacity: IREM and BOMA portfolio surveys put a commercial property manager
 * at roughly 500,000-1,000,000 sf depending on asset type and tenant count,
 * and a residential manager at roughly 300-500 units. Leasing is a wider beat
 * because the unit of work is a deal, not a building. Residential does not
 * consume leasing capacity at all — the engine already says so in `setBroker`
 * ("brokers work commercial space — multifamily leases itself").
 *
 * Effect size: professionally managed buildings run roughly 5-15% below
 * absentee-owned ones on CONTROLLABLE expenses — the half of the stack that is
 * contracts, staffing and preventive maintenance — and a genuinely neglected
 * building runs 20-30% over. That band is the whole range of this system. It
 * cannot make a building free to run and it cannot bankrupt one; it moves the
 * controllable half by about a quarter, either way, which is what management
 * is worth in life.
 *
 * Salaries are quoted in year-2000 dollars and billed at `econ.costIdx`. A
 * fixed $200,000 salary in a simulation that runs a century at 5.4x inflation
 * is free money by year sixty, and a wage that ignores the price level is
 * exactly the kind of number this project does not ship.
 */
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { GameState, Holding } from "./types";
import { logBooks, cloneState} from "./types";
import { mulberry32Step } from "./market";
import { resolveRec } from "./value";
import {
  careerLoadMult, principalTemperament, queueFounderBid, stampEmployeeLife,
  type Person,
} from "./people";
import { firmCapital } from "./firmCapital";

export type StaffRole = "pm" | "leasing" | "construction";

/**
 * THE PAYROLL DRAWS FROM ITS OWN STREAM, AND THIS IS NOT A DETAIL.
 *
 * The engine has one shared mulberry32 state driving the macro walk, every
 * rival, every tenant and every demolition, so anything that calls rng() a
 * different number of times re-rolls the rest of the century. Generating a
 * hiring pool from that stream is exactly such a thing — measured, it moved
 * the loan-index drift through an engineered glut from -0.04pp to +0.97pp
 * across nine seeds and broke acceptance test H, with nothing about the
 * economy having changed at all.
 *
 * A hiring pool is not a fact about the property market and it must not be
 * able to move one. So it gets its own generator, seeded off the run seed and
 * stepped only by this module. The practical consequence is the one that
 * matters to a player: who is available to hire cannot change the weather, and
 * choosing to interview somebody cannot either.
 *
 * (The same fix is what CENTURY_REPORT.md section VI asks for on the macro
 * economy generally. This is the first piece of it.)
 */
function srng(s: GameState): number {
  const r = mulberry32Step(s.staffRng ?? (s.seed ^ 0x5741ff) | 0);
  s.staffRng = r.state;
  return r.value;
}
function srrange(s: GameState, lo: number, hi: number): number {
  return lo + srng(s) * (hi - lo);
}

/**
 * HOW MUCH OF THE OLD OVERHEAD WAS PEOPLE YOU CAN NOW HIRE.
 *
 * The `ga` line in sim.ts charged ~30bps of gross asset value for an office
 * nobody could see. Roughly 45% of a real estate firm's G&A is property and
 * asset management payroll — the seats this module makes explicit — so that
 * share comes out of the abstract charge and arrives as actual salaries. What
 * stays behind is audit, legal, insurance and the office lease, which no hire
 * removes. Without this split, hiring a manager would bill the player for the
 * same person twice.
 */
export const NON_PAYROLL_GA_SHARE = 0.55;

/**
 * Temperament — four attrs, every Person. Storage keys are save-stable;
 * display names live in ATTR_LABEL / ATTR_LABEL_PERSON (ATTR_CONTRACT.md).
 */
export const GENERAL_ATTRS = ["judgment", "urgency", "diligence", "relationships"] as const;
/** @deprecated Role chips retired — competence is career. Kept for old saves / harnesses. */
export const ROLE_ATTRS: Record<StaffRole, readonly string[]> = {
  pm: ["costControl", "tenantCare"],
  leasing: ["marketKnowledge", "negotiation"],
  construction: ["scheduling", "costControl"],
};
export const ATTR_LABEL: Record<string, string> = {
  judgment: "Deal sense",
  urgency: "Bandwidth",
  diligence: "Rigor",
  relationships: "Access",
  // Legacy labels — only shown if a save still carries the key in obs.
  costControl: "Cost control (legacy)",
  tenantCare: "Tenant care (legacy)",
  marketKnowledge: "Market knowledge (legacy)",
  negotiation: "Negotiation (legacy)",
  scheduling: "Scheduling (legacy)",
};

/**
 * Resolve an attr key against temperament, with legacy role-attr fallbacks.
 * New hires only store the four; old saves may still have costControl etc.
 */
export function attrValue(attrs: Record<string, number> | undefined, key: string): number {
  const a = attrs ?? {};
  if (typeof a[key] === "number") return a[key]!;
  const avg = (x: number, y: number) => (x + y) / 2;
  switch (key) {
    case "costControl": return a.diligence ?? 50;
    case "tenantCare": return avg(a.diligence ?? 50, a.relationships ?? 50);
    case "marketKnowledge": return a.judgment ?? 50;
    case "negotiation": return avg(a.judgment ?? 50, a.relationships ?? 50);
    case "scheduling": return avg(a.urgency ?? 50, a.diligence ?? 50);
    default: return a[key] ?? 50;
  }
}

export function meanAttrs(attrs: Record<string, number> | undefined, keys: readonly string[]): number {
  if (!keys.length) return 50;
  return keys.reduce((s, k) => s + attrValue(attrs, k), 0) / keys.length;
}
export const ROLE_LABEL: Record<StaffRole, string> = {
  pm: "Property Manager", leasing: "Leasing", construction: "Construction Manager",
};

/**
 * A hire is a Person with an employee seat and a payroll role. bornM / diesM
 * are stamped from peopleRng after staffRng work so the economy stream and the
 * hiring stream keep their step counts (see people.ts, HANDOFF_PRINCIPAL.md).
 */
export interface Staff extends Omit<Person, "seat" | "firmId"> {
  seat?: "employee";
  role: StaffRole;
  /** Year-2000 dollars a year. Billed at costIdx. */
  salary: number;
  hiredM: number;
  /**
   * Assets this person is on the hook for.
   * PM/leasing: operated holdings. Construction: live job BBLs (developments).
   * Empty/undefined = float desk — they cover whatever is not pinned to someone else.
   */
  assignedBbls?: string[];
}

export interface Candidate extends Staff {
  /** What they will accept. Hiring below it is not on offer. */
  askSalary: number;
}

const FIRST = ["Miriam", "Ellis", "Dorothy", "Frank", "Yolanda", "Arthur", "Rosa", "Clement",
  "Nadia", "Walter", "Imelda", "Gus", "Perry", "Cecile", "Otis", "Hannah", "Reuben", "Vera",
  "Marcus", "Junia", "Abel", "Winifred", "Solomon", "Greta", "Desmond", "Lorna"];
const LAST = ["Halloran", "Buckley", "Ferreira", "Okonkwo", "Vance", "Delacroix", "Mazur",
  "Whitcomb", "Ng", "Abernathy", "Sorrentino", "Kowal", "Bright", "Ashford", "Nakamura",
  "Salcedo", "Trent", "Villanueva", "Doyle", "Pike", "Emerson", "Radcliffe", "Osei"];

/**
 * SALARY IS A FUNCTION OF ABILITY, AND THE MARKET IS NOT BLIND.
 *
 * A candidate's ask tracks what they can actually do, because the rest of the
 * industry has been watching them work for a decade even though you have not.
 * That is what makes the noisy read a real problem rather than a free lunch:
 * you cannot simply buy the cheap one and expect to have found an edge, and
 * you cannot read ability off the price either, because the ask carries its own
 * spread. The band is $55k to $210k in year-2000 dollars, which is a real
 * range for a property manager through to a senior leasing director.
 */
function askFor(s: GameState, attrs: Record<string, number>, _role: StaffRole): number {
  void _role;
  const mean = meanAttrs(attrs, GENERAL_ATTRS);
  const rep = s.hireReputation ?? 0.55;
  const base = 55_000 + Math.pow(mean / 100, 1.9) * 155_000;
  const repAsk = base * (1 + (0.55 - rep) * 0.08);
  return Math.round(repAsk * srrange(s, 0.9, 1.12) / 1000) * 1000;
}

function drawAttrs(s: GameState, role: StaffRole): Record<string, number> {
  const rep = s.hireReputation ?? 0.55;
  const bias = (0.55 - rep) * 10;
  const out: Record<string, number> = {};
  // Temperament only — role chips retired (ATTR_CONTRACT.md).
  for (const k of GENERAL_ATTRS) {
    const v = (srng(s) + srng(s) + srng(s)) / 3;
    out[k] = Math.round(Math.max(8, Math.min(96, 8 + v * 88 - bias)));
  }
  // Burn the six uniforms ROLE_ATTRS used to consume (2 keys × 3) so a hire
  // cannot re-roll every stream that follows.
  for (const _k of ROLE_ATTRS[role]) {
    void _k;
    void (srng(s) + srng(s) + srng(s));
  }
  return out;
}

/**
 * WHAT AN INTERVIEW ACTUALLY TELLS YOU.
 *
 * `obs` is the first impression, drawn once and frozen. It is wrong by an
 * amount set by how much work you did before making the offer. Everything the
 * player is shown is derived from it, and the truth only arrives through the
 * results the person produces — see `readAttr`.
 *
 * Nobody interviews well on detail orientation. Communication and presence are
 * the things a room reads accurately and the things that matter least, so
 * `relationships` is observed tightly and `diligence` badly. That asymmetry is
 * the whole reason bad hires happen to real people.
 */
const OBS_HARDNESS: Record<string, number> = {
  relationships: 0.5, negotiation: 0.7, marketKnowledge: 0.8, judgment: 1.15,
  urgency: 1.2, tenantCare: 1.2, costControl: 1.3, diligence: 1.4,
};

function observe(
  s: GameState, attrs: Record<string, number>, band0: number, role: StaffRole,
): Record<string, number> {
  const rep = s.hireReputation ?? 0.55;
  const band = band0 * (1 + (0.55 - rep) * 0.35);
  const out: Record<string, number> = {};
  for (const k of GENERAL_ATTRS) {
    const v = attrs[k] ?? 50;
    const w = band * (OBS_HARDNESS[k] ?? 1);
    out[k] = Math.round(Math.max(1, Math.min(100, v + srrange(s, -w, w))));
  }
  // Burn two role-slot observations (legacy) without storing them.
  for (const k of ROLE_ATTRS[role]) {
    const v = attrValue(attrs, k);
    const w = band * (OBS_HARDNESS[k] ?? 1);
    void (v + srrange(s, -w, w));
  }
  return out;
}

/** How much search you paid for, in months of narrowing. Cheap looks cost more later. */
export const SEARCH_TIERS = [
  { key: "post", label: "Post the job", cost: 0, band: 26 },
  { key: "network", label: "Work your network", cost: 6_000, band: 18 },
  { key: "recruiter", label: "Retain a recruiter", cost: 22_000, band: 11 },
] as const;

export function generateCandidate(s: GameState, role: StaffRole, band0: number): Candidate {
  const attrs = drawAttrs(s, role);
  const name = `${FIRST[Math.floor(srng(s) * FIRST.length) % FIRST.length]} ${LAST[Math.floor(srng(s) * LAST.length) % LAST.length]}`;
  const ask = askFor(s, attrs, role);
  const cand = {
    id: s.nextStaffId ?? 1, name, role, attrs,
    obs: observe(s, attrs, band0, role),
    salary: ask, askSalary: ask, hiredM: -1, band0,
    seat: "employee" as const,
  } as Candidate;
  // peopleRng only — after every staffRng step for this candidate.
  stampEmployeeLife(s, cand);
  return cand;
}

/**
 * THE READ, AS IT STANDS TODAY.
 *
 * Before you hire, this is the interview. After you hire, months of watching
 * someone work move the estimate toward what is actually there and narrow the
 * band around it. Twelve months of results halve the error; five years all but
 * remove it. Nothing ever states the true number, because in life nothing does
 * — you infer it from whether the opex ratio and the renewal rate came in.
 */
/**
 * What you think an attr is, after months of watching. Truth stays hidden.
 * `observerRigor` (your diligence) shortens the learning half-life — Rigor is
 * how fast bands narrow, not a rent multiplier.
 */
export function readAttr(
  st: Staff, key: string, month: number, observerRigor = 50,
): { mid: number; lo: number; hi: number } {
  const truth = attrValue(st.attrs, key);
  const first = st.obs[key] ?? truth;
  const served = st.hiredM < 0 ? 0 : Math.max(0, month - st.hiredM);
  // At Rigor 50: τ = 12 months (legacy). Higher Rigor → faster learning.
  const tau = 12 * (1.4 - 0.8 * Math.max(0, Math.min(100, observerRigor)) / 100);
  const decay = 1 / (1 + served / Math.max(4, tau));
  const mid = truth + (first - truth) * decay;
  const w = (st.band0 * (OBS_HARDNESS[key] ?? 1)) * decay;
  return {
    mid: Math.round(Math.max(1, Math.min(100, mid))),
    lo: Math.round(Math.max(1, mid - w)),
    hi: Math.round(Math.min(100, mid + w)),
  };
}

// ---------------------------------------------------------------------------
// CAPACITY
// ---------------------------------------------------------------------------

/**
 * A manager covers 600,000 sf of commercial at ordinary ability — the middle
 * of the IREM/BOMA range — and residential eats capacity faster per foot
 * because a hundred apartments is a hundred tenancies where a hundred thousand
 * feet of warehouse is one. Urgency and detail set how much more or less than
 * ordinary this particular person gets through: the spread is 0.6x to 1.5x,
 * which is a real spread between a good manager and a poor one and is not
 * wide enough for anybody to cover a portfolio single-handed.
 */
export const PM_BASE_SF = 600_000;
export const LEASING_BASE_SF = 900_000;
/** Apartments are 2.4x the management work per foot. Turnover is the reason. */
export const MF_WORK_WEIGHT = 2.4;

/**
 * AND YOU, DOING IT YOURSELF.
 *
 * The firm starts as one person who is also underwriting, financing, and
 * walking buildings. 150,000 sf is about six small buildings — a real
 * one-person shop, and comfortably less than the portfolio the game expects
 * you to end up with, which is the point. You are never blocked from owning
 * more; you are just visibly worse at running it.
 */
export const OWNER_SF = 150_000;

/**
 * AND THE SEAT THAT WATCHES THE JOBS, whose denominator is not the book.
 *
 * A property manager and a leasing agent are loaded by the standing portfolio.
 * A construction manager is loaded by what is IN THE GROUND — a firm with
 * thirty stabilised buildings and nothing under construction has no work for
 * one, and a firm with one tower going up has a full-time job for somebody.
 * Measuring this seat against the book would have made it a tax on owning
 * buildings, which is the opposite of what it is.
 *
 * 350,000 sf of live construction is two or three concurrent mid-size jobs,
 * which is what one owner's representative actually carries. The owner's own
 * capacity is deliberately thin here — OWNER_CONSTRUCTION_SF, a single small
 * job — because supervising a build is not something a principal does in the
 * gaps between underwriting, and the game should say so before the change
 * orders do.
 */
export const CONSTRUCTION_BASE_SF = 350_000;
export const OWNER_CONSTRUCTION_SF = 60_000;

export type OwnerStyle = "handsOn" | "delegated";
export type BenchStyle = "boutique" | "platform";

/**
 * FIRM SHAPE EMERGES FROM THE PAYROLL.
 *
 * A one-person shop is hands-on and boutique. Four specialists and a float
 * desk is a platform. Forced ownerStyle / benchStyle overrides were free
 * capacity dials with no offsetting cost anywhere in the engine — deleted in
 * the Principal work (HANDOFF_PRINCIPAL.md). Inferred form stays: shape is an
 * OUTPUT of headcount, not a button.
 */
export function effectiveOwnerStyle(s: GameState): OwnerStyle | null {
  const n = (s.staff ?? []).length;
  if (n <= 1) return "handsOn";
  if (n >= 4) return "delegated";
  return null; // mid — original OWNER_SF constants
}

export function effectiveBenchStyle(s: GameState): BenchStyle | null {
  const n = (s.staff ?? []).length;
  if (n <= 2) return "boutique";
  if (n >= 5) return "platform";
  return null;
}

/** Human-readable firm shape for the Staff page. */
export function firmShapeLabel(s: GameState): string {
  const n = (s.staff ?? []).length;
  const owner = effectiveOwnerStyle(s);
  const bench = effectiveBenchStyle(s);
  const bits: string[] = [];
  if (owner === "handsOn") bits.push("hands-on");
  else if (owner === "delegated") bits.push("delegated");
  if (bench === "boutique") bits.push("boutique");
  else if (bench === "platform") bits.push("platform");
  if (!bits.length) bits.push(n === 0 ? "you alone" : "growing firm");
  return `${bits.join(" · ")} · ${n} on payroll`;
}

/**
 * Owner desk capacity before hires. Headcount shape (hands-on / delegated) still
 * applies; Bandwidth (urgency) scales the line the same way staff ability does —
 * centred at 1.0 when urgency is 50 so a mid principal matches the old constant.
 */
export function ownerCapacitySf(s: GameState, role: StaffRole): number {
  const style = effectiveOwnerStyle(s);
  const base = role === "construction" ? OWNER_CONSTRUCTION_SF : OWNER_SF;
  let cap = base;
  if (style === "handsOn") cap *= (role === "construction" ? 1.25 : 1.35);
  else if (style === "delegated") cap *= (role === "construction" ? 0.65 : 0.72);
  const urgency = principalTemperament(s).urgency;
  const band = 0.55 + (urgency / 100) * 0.9; // 0.55..1.45; = 1.0 at 50
  // Institutional process (firm capital tier) — earned, capped ≤ +8%.
  const process = firmCapital(s).processCapacityMult;
  return cap * band * process;
}

function abilityMult(s: GameState, st: Staff, month: number, keys: string[]): number {
  // Uses TRUE ability. The player's uncertainty is about what they can see,
  // not about what is happening to their buildings.
  void month;
  const mean = meanAttrs(st.attrs, keys);
  const bench = effectiveBenchStyle(s);
  if (bench === "boutique") return 0.55 + (mean / 100) * 1.05;   // star spread
  if (bench === "platform") return 0.75 + (mean / 100) * 0.65;   // flatter mid
  return 0.6 + (mean / 100) * 0.9;                               // original curve
}

function capacityKeys(role: StaffRole): string[] {
  return role === "leasing" ? ["urgency", "relationships"] : ["urgency", "diligence"];
}

/** Desk quality keys — temperament only (role chips retired). */
function skillKeys(role: StaffRole): string[] {
  return role === "pm" ? ["diligence", "judgment"]
    : role === "construction" ? ["diligence", "urgency"]
      : ["judgment", "relationships"];
}

/** Principal skill on a desk — same keys as staff, never the old hardcoded 42. */
export function principalDeskSkill(s: GameState, role: StaffRole): number {
  return meanAttrs(principalTemperament(s), skillKeys(role));
}

/** Personal capacity of one hire — what they can carry if that is their whole book. */
export function personCapacitySf(s: GameState, st: Staff): number {
  const base = st.role === "pm" ? PM_BASE_SF
    : st.role === "construction" ? CONSTRUCTION_BASE_SF
      : LEASING_BASE_SF;
  return base * abilityMult(s, st, s.month, capacityKeys(st.role));
}

/**
 * Work SF one asset puts on a desk.
 * Construction reads live jobs; PM/leasing read operated holdings.
 */
export function workSfAt(s: GameState, parcels: ParcelTable, bbl: string, role: StaffRole): number {
  if (role === "construction") {
    const d = s.developments?.[bbl];
    if (!d || d.deliverM <= s.month) return 0;
    return d.sf ?? 0;
  }
  const h = s.holdings[bbl];
  if (!h || h.groundLeased) return 0;
  const rec: ParcelRecord | null = resolveRec(parcels, s, bbl);
  if (!rec || !rec.bldgArea) return 0;
  const mix = rec.mix;
  const mfShare = mix ? (mix.multifamily ?? 0) : (rec.class === "multifamily" ? 1 : 0);
  const mfSf = rec.bldgArea * mfShare;
  const comSf = rec.bldgArea - mfSf;
  return role === "pm" ? comSf + mfSf * MF_WORK_WEIGHT : comSf;
}

/** Every BBL that can load this desk right now. */
export function deskAssetBbls(s: GameState, parcels: ParcelTable, role: StaffRole): string[] {
  if (role === "construction") {
    return Object.keys(s.developments ?? {}).filter((bbl) => workSfAt(s, parcels, bbl, role) > 0);
  }
  return Object.keys(s.holdings).filter((bbl) => workSfAt(s, parcels, bbl, role) > 0);
}

export function isFloatStaff(st: Staff): boolean {
  return !(st.assignedBbls?.length);
}

/**
 * HOW FAR PAST THE LINE YOU ARE, as a number between 0 (fine) and 1 (nothing
 * is getting done properly). Gradual and increasingly bad, never a cliff: at
 * 1.5x capacity roughly a quarter of the work is slipping, at 3x about half,
 * and it asymptotes rather than reaching zero because even an overwhelmed
 * owner still collects the rent.
 */
export function slip(load: number): number {
  if (load <= 1) return 0;
  const over = load - 1;
  return over / (over + 1.4);
}

export interface RoleState {
  capacity: number;
  covered: number;
  load: number;
  slip: number;
  skill: number;
  /** SF with nobody assigned while every hire in the role is pinned elsewhere. */
  uncoveredSf?: number;
  uncoveredN?: number;
}

function stateOf(capacity: number, covered: number, skill: number): RoleState {
  const load = capacity > 0 ? covered / capacity : (covered > 0 ? 99 : 0);
  return { capacity, covered, load, slip: slip(load), skill };
}

/** Load on one assigned person — only their pinned assets count. */
export function personRoleState(s: GameState, parcels: ParcelTable, st: Staff): RoleState {
  const capacity = personCapacitySf(s, st);
  let covered = 0;
  for (const bbl of st.assignedBbls ?? []) {
    const w = workSfAt(s, parcels, bbl, st.role);
    const rec = resolveRec(parcels, s, bbl);
    const mult = rec
      ? careerLoadMult((st as Person).career, rec.class, rec.district ?? "—")
      : 1;
    covered += w * mult;
  }
  const skill = meanAttrs(st.attrs, skillKeys(st.role));
  return stateOf(capacity, covered, skill);
}

/**
 * The float desk: owner cover + every unassigned hire, against every asset
 * that is not pinned to somebody. This is where assignment becomes load-bearing —
 * pin every leasing hire to Tower A and Tower B sits on you alone.
 */
export function floatRoleState(s: GameState, parcels: ParcelTable, role: StaffRole): RoleState {
  const hired = (s.staff ?? []).filter((x) => x.role === role);
  const floaters = hired.filter(isFloatStaff);
  let capacity = ownerCapacitySf(s, role);
  for (const st of floaters) capacity += personCapacitySf(s, st);

  const pinned = new Set<string>();
  for (const st of hired) {
    if (isFloatStaff(st)) continue;
    for (const bbl of st.assignedBbls ?? []) pinned.add(bbl);
  }
  let covered = 0;
  let uncoveredSf = 0;
  let uncoveredN = 0;
  // Float load: each floater's career weights their share; owner uses principal.
  const ownerCareer = s.principal?.career;
  for (const bbl of deskAssetBbls(s, parcels, role)) {
    if (pinned.has(bbl)) continue;
    const w = workSfAt(s, parcels, bbl, role);
    const rec = resolveRec(parcels, s, bbl);
    let mult = 1;
    if (rec) {
      if (floaters.length) {
        // Average floater familiarity — the float desk is a shared beat.
        mult = floaters.reduce((a, st) => (
          a + careerLoadMult((st as Person).career, rec.class, rec.district ?? "—")
        ), 0) / floaters.length;
      } else {
        mult = careerLoadMult(ownerCareer, rec.class, rec.district ?? "—");
      }
    }
    covered += w * mult;
    // Uncovered = on the float with ZERO hired float capacity (owner only still counts as cover).
    if (!floaters.length && hired.length > 0 && hired.every((st) => !isFloatStaff(st))) {
      uncoveredSf += w;
      uncoveredN++;
    }
  }
  const keys = skillKeys(role);
  const skill = floaters.length
    ? floaters.reduce((a, st) => a + meanAttrs(st.attrs, keys), 0) / floaters.length
    : principalDeskSkill(s, role);
  const rs = stateOf(capacity, covered, skill);
  if (uncoveredN > 0) {
    rs.uncoveredSf = uncoveredSf;
    rs.uncoveredN = uncoveredN;
  }
  return rs;
}

/** Total capacity still used by UI/harnesses — owner + every hire in the role. */
export function roleCapacitySf(s: GameState, role: StaffRole): number {
  let cap = ownerCapacitySf(s, role);
  for (const st of s.staff ?? []) {
    if (st.role === role) cap += personCapacitySf(s, st);
  }
  return cap;
}

/** Square feet each role is on the hook for (whole book / all live jobs). */
export function coveredSf(s: GameState, parcels: ParcelTable, role: StaffRole): number {
  let total = 0;
  for (const bbl of deskAssetBbls(s, parcels, role)) total += workSfAt(s, parcels, bbl, role);
  return total;
}

/**
 * Firm-level desk read for UI and firm stamps.
 *
 * Slip is SF-weighted across assigned people and the float — pin half the book
 * to an overloaded specialist and the firm number moves, instead of pretending
 * assignment is only a skill chip.
 */
export function roleState(s: GameState, parcels: ParcelTable, role: StaffRole): RoleState {
  const capacity = roleCapacitySf(s, role);
  const covered = coveredSf(s, parcels, role);
  const hired = (s.staff ?? []).filter((x) => x.role === role);
  const float = floatRoleState(s, parcels, role);
  let slipAcc = 0;
  let slipW = 0;
  let skillAcc = 0;
  let skillW = 0;
  for (const st of hired) {
    if (isFloatStaff(st)) continue;
    const pr = personRoleState(s, parcels, st);
    if (pr.covered <= 0) continue;
    slipAcc += pr.slip * pr.covered;
    slipW += pr.covered;
    skillAcc += pr.skill * pr.covered;
    skillW += pr.covered;
  }
  if (float.covered > 0 || !hired.length) {
    const w = Math.max(float.covered, hired.length ? 0 : 1);
    slipAcc += float.slip * w;
    slipW += w;
    skillAcc += float.skill * w;
    skillW += w;
  }
  const load = capacity > 0 ? covered / capacity : (covered > 0 ? 99 : 0);
  const keys = skillKeys(role);
  const skill = skillW > 0
    ? skillAcc / skillW
    : hired.length
      ? hired.reduce((a, st) => a + meanAttrs(st.attrs, keys), 0) / hired.length
      : principalDeskSkill(s, role);
  const rs = stateOf(capacity, covered, skill);
  // Prefer SF-weighted slip when assignment splits the book; else classic load slip.
  rs.slip = slipW > 0 ? slipAcc / slipW : slip(load);
  rs.load = load;
  if (float.uncoveredN) {
    rs.uncoveredSf = float.uncoveredSf;
    rs.uncoveredN = float.uncoveredN;
  }
  return rs;
}

/** Who's skill + slip stamps this asset. */
export function coverRoleState(
  s: GameState, parcels: ParcelTable, bbl: string, role: StaffRole,
): { staff?: Staff; rs: RoleState } {
  const assigned = (s.staff ?? []).find(
    (st) => st.role === role && st.assignedBbls?.includes(bbl),
  );
  if (assigned) return { staff: assigned, rs: personRoleState(s, parcels, assigned) };
  return { rs: floatRoleState(s, parcels, role) };
}

/**
 * Work that did not get done — priced in the units the player already reads.
 * Staff page shows these instead of only a slip bar.
 */
export interface DeskBacklog {
  role: StaffRole;
  slip: number;
  load: number;
  opexDragYr: number;
  renewalsMissPct: number;
  prospectsMissPct: number;
  siteRiskExtraPct: number;
  uncoveredSf: number;
  uncoveredN: number;
  unsupervisedJobSf: number;
}

export function deskBacklog(
  s: GameState, parcels: ParcelTable, role: StaffRole, opexBaseYr = 0,
): DeskBacklog {
  const rs = roleState(s, parcels, role);
  const kept = { ...rs, slip: 0 };
  const opexDragYr = role === "pm" ? Math.max(0, opexBaseYr * (pmOpexMult(rs) - pmOpexMult(kept))) : 0;
  const renewalsMissPct = role === "pm"
    ? Math.max(0, (1 - pmRenewalMult(rs) / Math.max(0.01, pmRenewalMult(kept))) * 100)
    : 0;
  const prospectsMissPct = role === "leasing"
    ? Math.max(0, (1 - leasingOddsMult(rs) / Math.max(0.01, leasingOddsMult(kept))) * 100)
    : 0;
  const siteRiskExtraPct = role === "construction"
    ? Math.max(0, (cmRiskMult(rs) / Math.max(0.01, cmRiskMult(kept)) - 1) * 100)
    : 0;
  let unsupervisedJobSf = 0;
  if (role === "construction" && rs.slip > 0.05) {
    for (const bbl of deskAssetBbls(s, parcels, "construction")) {
      const { rs: local } = coverRoleState(s, parcels, bbl, "construction");
      if (local.slip > 0.05) unsupervisedJobSf += workSfAt(s, parcels, bbl, "construction");
    }
  }
  return {
    role,
    slip: rs.slip,
    load: rs.load,
    opexDragYr,
    renewalsMissPct,
    prospectsMissPct,
    siteRiskExtraPct,
    uncoveredSf: rs.uncoveredSf ?? 0,
    uncoveredN: rs.uncoveredN ?? 0,
    unsupervisedJobSf,
  };
}

/**
 * WHAT MANAGEMENT IS WORTH, ON THE CONTROLLABLE HALF ONLY.
 *
 * Returns a multiplier on OPEX_CONTROLLABLE. Fixed costs — the tax bill, the
 * insurance premium, the ground rent — do not care who manages the building,
 * which is why the expense stack was already split in two before this existed.
 *
 * Range: a skill-90 manager inside capacity runs the controllable stack ~11%
 * under standard; an owner at 3x capacity runs it ~18% over. That spans the
 * 5-15% professional-management saving and the 20-30% neglect premium the
 * industry surveys report, and it cannot go further in either direction.
 */
export function pmOpexMult(rs: RoleState): number {
  const good = (rs.skill - 50) / 100 * 0.22;             // -0.11 .. +0.11
  const bad = rs.slip * 0.30;
  return Math.max(0.86, Math.min(1.34, 1 - good + bad));
}

/** Renewal conversations that happen on time. Same shape, smaller stakes. */
export function pmRenewalMult(rs: RoleState): number {
  const good = (rs.skill - 50) / 100 * 0.16;
  return Math.max(0.72, Math.min(1.15, 1 + good - rs.slip * 0.28));
}

/**
 * DEAL FLOW YOU CREATED RATHER THAN WAITED FOR.
 *
 * A leasing team does not change how many tenants exist in the city; it
 * changes how many of them tour YOUR building rather than the one across the
 * street. That is why this multiplies tour arrival and nothing else, and why
 * the upside is bounded: at skill 90 and inside capacity you see about 30%
 * more prospects than an owner answering his own phone. An owner three times
 * over capacity misses about a third of them.
 */
export function leasingOddsMult(rs: RoleState): number {
  const good = (rs.skill - 50) / 100 * 0.5;
  return Math.max(0.55, Math.min(1.35, 1 + good - rs.slip * 0.5));
}

/**
 * WHAT AN OWNER'S REPRESENTATIVE IS WORTH, ON SITE RISK ONLY.
 *
 * Returns a multiplier on the monthly hazard of the three things that go wrong
 * on a job — a change order, a weather-and-inspections slip, a subcontractor
 * default — and on the size of the two that cost money. It multiplies nothing
 * else. A construction manager does not make steel cheaper, does not shorten
 * the base build period, and cannot help a job whose problem is that the market
 * moved: cost escalation under cost-plus is the market repricing the unbuilt
 * balance, and the instrument against that is a guaranteed maximum price, which
 * is already in the game and already costs four points.
 *
 * WHAT THEY DO is the preconstruction work and the watching: scope the drawings
 * so the change order was priced before it was an order, pre-qualify the subs
 * so the one that goes under is not on your job, and be on site the week the
 * inspection is failed rather than the month after. Owner-driven change orders
 * run 5-10% of contract value on real jobs and good preconstruction is what
 * moves that number; professional CM fees of 1-3% of construction cost are paid
 * out of exactly this and nothing else.
 *
 * Range is the same register as the property manager's, and deliberately so:
 * roughly a fifth either way on the controllable part, floored and capped so
 * neither a brilliant hire nor a hopeless one can decide a project. Measured
 * off this function rather than asserted about it: a skill-90 manager inside
 * capacity runs site risk at 0.824 — about 18% fewer events and 18% smaller
 * change orders — and an owner supervising 300,000 sf with nobody in the seat
 * runs 1.287, about 29% more. The rails at 0.78 and 1.34 are guards on the
 * tails and are not reachable by a plausible hire inside capacity.
 */
export function cmRiskMult(rs: RoleState): number {
  const good = (rs.skill - 50) / 100 * 0.44;             // -0.22 .. +0.22
  return Math.max(0.78, Math.min(1.34, 1 - good + rs.slip * 0.34));
}

/** What the leasing hire gets on the rent, against a market they know better. */
export function leasingRentMult(rs: RoleState): number {
  const good = (rs.skill - 50) / 100 * 0.09;
  return Math.max(0.95, Math.min(1.05, 1 + good - rs.slip * 0.06));
}

// ---------------------------------------------------------------------------
// THE MONTH
// ---------------------------------------------------------------------------

/** Year-2000 salary dollars a month, at today's price level. */
export function payrollMonthly(s: GameState): number {
  let a = 0;
  for (const st of s.staff ?? []) a += st.salary;
  return Math.round((a * (s.econ.costIdx ?? 1)) / 12);
}

/**
 * SEVERANCE IS THREE MONTHS AND THE SEAT STAYS EMPTY.
 *
 * Firing is allowed and it costs what firing costs: three months of salary,
 * and a search that runs before anyone starts. The gap is the real penalty —
 * your coverage falls exactly when you have decided it was inadequate — and it
 * is why the interview is worth doing properly.
 */
export const SEVERANCE_MONTHS = 3;
export const SEARCH_MONTHS = 2;

export function severanceFor(s: GameState, st: Staff): number {
  return Math.round((st.salary * (s.econ.costIdx ?? 1) / 12) * SEVERANCE_MONTHS);
}

/**
 * The pool refreshes slowly. A hiring market that reshuffles every month is a
 * slot machine, and the decision it produces is "spin again", not "is this
 * person worth $140,000 a year".
 */
export const POOL_REFRESH_M = 6;
export const POOL_SIZE = 3;

export function refreshPool(s: GameState, force = false) {
  if (!s.hirePool) s.hirePool = { m: -999, band: 26, list: [] };
  if (!force && s.month - s.hirePool.m < POOL_REFRESH_M) return;
  s.nextStaffId = s.nextStaffId ?? 1;
  const list: Candidate[] = [];
  for (const role of ["pm", "leasing", "construction"] as StaffRole[]) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const c = generateCandidate(s, role, s.hirePool.band);
      c.id = s.nextStaffId++;
      list.push(c);
    }
  }
  s.hirePool = { m: s.month, band: s.hirePool.band, list };
}

/**
 * Once a month, work out what the desk is coping with and stamp the results
 * where the operating and leasing code can read them without being handed the
 * whole GameState. Doing it once a tick also means the player's statement, the
 * appraisal and the leasing panel all quote the SAME management — the fault
 * this project keeps finding is two functions answering one question
 * differently, and a single stamped number cannot do that.
 */
/**
 * UI shipped — capacity multipliers bind. Neutral pin kept when flag is false
 * and the desk is empty so saves without staff do not slip silently.
 */
export const HIRING_UI_SHIPPED = true;

function assignedForBbl(s: GameState, bbl: string, role: StaffRole): Staff | undefined {
  return (s.staff ?? []).find((st) => st.role === role && st.assignedBbls?.includes(bbl));
}

export function markStaff(s: GameState, parcels: ParcelTable) {
  const pm = roleState(s, parcels, "pm");
  const lease = roleState(s, parcels, "leasing");
  if (!HIRING_UI_SHIPPED && !(s.staff ?? []).length) {
    for (const h of Object.values(s.holdings)) {
      delete h.pmOpexMult;
      delete h.pmRenewalMult;
      delete h.leasingRentMult;
    }
    delete s.leasingOddsMult; delete s.pmRenewalMult; delete s.leasingRentMult;
    delete s.pmDeskSlip;
    return;
  }
  // Firm tour-odds / renewal defaults still come from the whole desk read.
  s.pmDeskSlip = +pm.slip.toFixed(4);
  s.leasingOddsMult = +leasingOddsMult(lease).toFixed(4);
  s.pmRenewalMult = +pmRenewalMult(pm).toFixed(4);
  s.leasingRentMult = +leasingRentMult(lease).toFixed(4);
  for (const h of Object.values(s.holdings)) {
    // Lessee runs the bricks — do not stamp PM/leasing multipliers onto a coupon fee.
    if (h.groundLeased) {
      delete h.pmOpexMult;
      delete h.pmRenewalMult;
      delete h.leasingRentMult;
      continue;
    }
    // Per-building stamps use the covering pool's slip AND skill — assignment
    // changes load, not only a quality chip on top of firm-wide overload.
    const pmCover = coverRoleState(s, parcels, h.bbl, "pm");
    h.pmOpexMult = +pmOpexMult(pmCover.rs).toFixed(4);
    h.pmRenewalMult = +pmRenewalMult(pmCover.rs).toFixed(4);
    const leaseCover = coverRoleState(s, parcels, h.bbl, "leasing");
    h.leasingRentMult = +leasingRentMult(leaseCover.rs).toFixed(4);
  }
}

export function tickStaff(s: GameState, parcels: ParcelTable) {
  refreshPool(s);
  markStaff(s, parcels);
  // Anyone whose search has finished takes their seat.
  if (s.pendingHires?.length) {
    const ready = s.pendingHires.filter((p) => s.month >= p.startM);
    if (ready.length) {
      s.staff = s.staff ?? [];
      for (const p of ready) {
        const st: Staff = { ...p.staff, hiredM: s.month };
        s.staff.push(st);
        s.news.unshift({
          q: s.month, kind: "info",
          text: `${st.name} starts today as ${ROLE_LABEL[st.role]} at $${Math.round(st.salary / 1000)}k. `
            + `What they are actually worth is something you will find out.`,
        });
      }
      s.pendingHires = s.pendingHires.filter((p) => s.month < p.startM);
    }
  }
  // Poaching — strong hires with tenure get called away; worse when your name
  // is mud. ALWAYS draw once per seat so a star on the payroll cannot change
  // how many staffRng steps the month takes (see the stream comment above).
  const poached: Staff[] = [];
  const access = principalTemperament(s).relationships;
  for (const st of s.staff ?? []) {
    const roll = srng(s);
    const mean = meanAttrs(st.attrs, GENERAL_ATTRS);
    const tenure = st.hiredM < 0 ? 0 : s.month - st.hiredM;
    if (mean < 72 || tenure < 24) continue;
    const rep = s.hireReputation ?? 0.55;
    // Access: a principal who keeps relationships burns fewer stars to poachers.
    const accessMult = 1.25 - 0.5 * (access / 100); // 1.0 at 50; 0.75 at 100
    const chance = 0.012 * (1 + (0.55 - rep) * 1.5) * accessMult;
    if (roll < chance) poached.push(st);
  }
  if (poached.length) {
    const ids = new Set(poached.map((x) => x.id));
    s.staff = (s.staff ?? []).filter((x) => !ids.has(x.id));
    // Strong people do not vanish into another payroll — they try to raise.
    // Genealogy proposes; the product-gated raise can still refuse.
    const house = s.firm?.name ?? "your firm";
    for (const st of poached) {
      queueFounderBid(s, st, "you", house);
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `${st.name} has left your ${ROLE_LABEL[st.role]} desk to raise. `
          + `There is no severance when they choose to leave — and if the pitch clears, they will bid against you.`,
      });
    }
  }
  // Burnout under overload; slow improvement when the desk has room.
  // Assigned people burn out on THEIR book; float hires on the float desk.
  for (const st of s.staff ?? []) {
    const roll = srng(s);
    const tenure = st.hiredM < 0 ? 0 : s.month - st.hiredM;
    const rs = isFloatStaff(st)
      ? floatRoleState(s, parcels, st.role)
      : personRoleState(s, parcels, st);
    if (rs.slip > 0.25 && roll < 0.07) {
      st.attrs.diligence = Math.max(8, (st.attrs.diligence ?? 50) - 1);
      st.attrs.urgency = Math.max(8, (st.attrs.urgency ?? 50) - 1);
    } else if (rs.slip === 0 && tenure > 12 && roll < 0.05) {
      // Temperament polish — Deal sense plus the desk's quality keys (unique).
      for (const k of new Set<string>(["judgment", ...skillKeys(st.role)])) {
        st.attrs[k] = Math.min(96, (st.attrs[k] ?? 50) + 1);
      }
    }
  }
  // Overload stories — once a month, if any desk is underwater.
  const pmRs = roleState(s, parcels, "pm");
  const leaseRs = roleState(s, parcels, "leasing");
  const cmRs = roleState(s, parcels, "construction");
  const slips: { role: StaffRole; slip: number }[] = [
    { role: "pm", slip: pmRs.slip },
    { role: "leasing", slip: leaseRs.slip },
    { role: "construction", slip: cmRs.slip },
  ];
  const worst = slips.reduce((a, b) => (b.slip > a.slip ? b : a));
  if (worst.slip > 0.2 && srng(s) < 0.12) {
    let addr = "your portfolio";
    for (const h of Object.values(s.holdings)) {
      const rec = resolveRec(parcels, s, h.bbl);
      if (rec?.address) { addr = rec.address; break; }
    }
    const slipText = worst.role === "pm"
      ? "renewals are being postponed"
      : worst.role === "leasing"
        ? "prospect calls are going unanswered"
        : "active jobs are going unsupervised";
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `The ${ROLE_LABEL[worst.role]} desk is overloaded — at ${addr}, ${slipText}.`,
    });
  }
}

export function hire(s: GameState, candidateId: number): { s: GameState; err?: string } {
  const pool = s.hirePool?.list ?? [];
  const c = pool.find((x) => x.id === candidateId);
  if (!c) return { s, err: "That candidate is no longer available." };
  const first = Math.round(c.askSalary * (s.econ.costIdx ?? 1) / 12);
  if (s.cash < first) return { s, err: "You cannot cover the first month's salary." };
  const next: GameState = cloneState(s);
  next.pendingHires = next.pendingHires ?? [];
  next.pendingHires.push({ staff: { ...c, salary: c.askSalary, hiredM: -1 }, startM: next.month + SEARCH_MONTHS });
  next.hirePool!.list = (next.hirePool!.list ?? []).filter((x) => x.id !== candidateId);
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Offer accepted: ${c.name} as ${ROLE_LABEL[c.role]}, $${Math.round(c.askSalary / 1000)}k. `
      + `They give notice and start in ${SEARCH_MONTHS} months.`,
  });
  return { s: next };
}

export function fire(s: GameState, staffId: number): { s: GameState; err?: string } {
  const st = (s.staff ?? []).find((x) => x.id === staffId);
  if (!st) return { s, err: "Nobody by that name works here." };
  const pay = severanceFor(s, st);
  if (s.cash < pay) return { s, err: `Severance is $${Math.round(pay / 1000)}k and you do not have it.` };
  const next: GameState = cloneState(s);
  next.staff = (next.staff ?? []).filter((x) => x.id !== staffId);
  // MONEY MOVES THROUGH THE LEDGER OR IT DOES NOT MOVE. This wrote severance
  // straight off the balance with no entry behind it — the only unbooked
  // payment left in the engine, and precisely the fault class pnpm conserve
  // exists to catch. It never caught this one because the conservation bot
  // has no staff and therefore never fires anybody, so a player who let
  // somebody go silently put the ledger out by three months of salary. It is
  // overhead, so it books where the rest of the office does.
  next.cash -= pay;
  logBooks(next, "ga", pay);
  // No leasing hire left → they cannot hold the pen. Leaving teamLeasing on
  // after the last seat emptied made coverage silently drop while the toggle
  // still said the team had the book.
  if (st.role === "leasing" && !(next.staff ?? []).some((x) => x.role === "leasing")) {
    delete next.teamLeasing;
  }
  const tenure = st.hiredM < 0 ? 0 : s.month - st.hiredM;
  const repHit = tenure < 12 ? 0.12 : 0.04;
  const rep = (next.hireReputation ?? 0.55) - repHit;
  next.hireReputation = Math.max(0.15, Math.min(0.95, rep));
  let repNote = "";
  if (repHit >= 0.12) repNote = " The market remembers a messy departure.";
  next.news.unshift({
    q: next.month, kind: "warn",
    text: `${st.name} is out. Severance $${Math.round(pay / 1000)}k, and the desk is empty until you fill it.${repNote}`,
  });
  return { s: next };
}

export function setSearchTier(
  s: GameState,
  key: typeof SEARCH_TIERS[number]["key"],
): { s: GameState; err?: string } {
  const tier = SEARCH_TIERS.find((t) => t.key === key);
  if (!tier) return { s, err: "That search tier does not exist." };
  // Same quality while the list is still fresh is a slot pull — refuse it.
  // Changing quality (or waiting out the half-year) is a real search.
  if (
    s.hirePool
    && s.hirePool.band === tier.band
    && s.month - s.hirePool.m < POOL_REFRESH_M
  ) {
    const wait = POOL_REFRESH_M - (s.month - s.hirePool.m);
    return { s, err: `That list is still up. ${wait} month${wait === 1 ? "" : "s"} until it ages out, or pay for a sharper search.` };
  }
  const cost = Math.round(tier.cost * (s.econ.costIdx ?? 1));
  if (cost > 0 && s.cash < cost) {
    return { s, err: `Search costs $${Math.round(cost / 1000)}k and you do not have it.` };
  }
  const next: GameState = cloneState(s);
  if (cost > 0) {
    next.cash -= cost;
    logBooks(next, "ga", cost);
  }
  if (!next.hirePool) next.hirePool = { m: -999, band: tier.band, list: [] };
  next.hirePool.band = tier.band;
  refreshPool(next, true);
  const quality = tier.band <= 12 ? "sharp reads on who is actually in the pool"
    : tier.band <= 20 ? "decent first impressions"
      : "rough interviews — you will learn more after they start";
  next.news.unshift({
    q: next.month, kind: "info",
    text: `${tier.label}. The candidate pool refreshes with ${quality}.`,
  });
  return { s: next };
}

/** @deprecated Free capacity dial removed — firm shape emerges from headcount. */
export function setOwnerStyle(s: GameState, _style: OwnerStyle): { s: GameState } {
  const next: GameState = cloneState(s);
  delete next.ownerStyle;
  return { s: next };
}

/** @deprecated Free capacity dial removed — firm shape emerges from headcount. */
export function setBenchStyle(s: GameState, _style: BenchStyle): { s: GameState } {
  const next: GameState = cloneState(s);
  delete next.benchStyle;
  return { s: next };
}

export function assignStaff(s: GameState, staffId: number, bbl: string): { s: GameState; err?: string } {
  const st = (s.staff ?? []).find((x) => x.id === staffId);
  if (!st) return { s, err: "Nobody by that name works here." };
  if (st.role === "construction") {
    const job = s.developments?.[bbl];
    if (!job || job.deliverM <= s.month) {
      return { s, err: "Assign construction managers to a live job — nothing is in the ground at that address." };
    }
  } else {
    if (!s.holdings[bbl]) return { s, err: "You do not own that building." };
    if (s.holdings[bbl].groundLeased) {
      return { s, err: "That fee is ground-leased — the lessee runs the building, not your desk." };
    }
  }
  const next: GameState = cloneState(s);
  for (const other of next.staff ?? []) {
    if (other.role === st.role && other.id !== staffId && other.assignedBbls?.length) {
      other.assignedBbls = other.assignedBbls.filter((x) => x !== bbl);
    }
  }
  const target = (next.staff ?? []).find((x) => x.id === staffId)!;
  target.assignedBbls = [...(target.assignedBbls ?? []).filter((x) => x !== bbl), bbl];
  return { s: next };
}

export function unassignStaff(s: GameState, staffId: number, bbl: string): { s: GameState; err?: string } {
  const st = (s.staff ?? []).find((x) => x.id === staffId);
  if (!st) return { s, err: "Nobody by that name works here." };
  if (!st.assignedBbls?.includes(bbl)) {
    return {
      s,
      err: st.role === "construction"
        ? "They were not assigned to that job."
        : "They were not assigned to that building.",
    };
  }
  const next: GameState = cloneState(s);
  const target = (next.staff ?? []).find((x) => x.id === staffId)!;
  target.assignedBbls = target.assignedBbls!.filter((x) => x !== bbl);
  return { s: next };
}

/**
 * Outside coverage (firm agent / exclusive) does not inherit your payroll.
 * Mid competence — they counter and sign, they do not secretly ride a star hire.
 */
export const OUTSIDE_DESK_JUDGMENT = 50;
export const OUTSIDE_DESK_NEGOTIATION = 50;

/** Mean Deal sense on a desk — your judgment when the seat is empty. */
export function deskJudgment(s: GameState, role: "leasing" | "pm"): number {
  const hired = (s.staff ?? []).filter((x) => x.role === role);
  if (!hired.length) return principalTemperament(s).judgment;
  return hired.reduce((a, st) => a + attrValue(st.attrs, "judgment"), 0) / hired.length;
}

/**
 * Judgment for whoever actually holds the pen on this letter.
 * Staff path uses your hires; outside agent/exclusive is mid, not your payroll.
 */
export function penJudgment(
  s: GameState,
  cover: "agent" | "exclusive" | "staff" | null | undefined,
): number {
  if (cover === "agent" || cover === "exclusive") return OUTSIDE_DESK_JUDGMENT;
  return deskJudgment(s, "leasing");
}

/**
 * Mean negotiation skill on the leasing desk.
 * Empty in-house desk floors at mid (50). Outside coverage never reads this —
 * see penNegotiation.
 */
export function deskNegotiation(s: GameState): number {
  const hired = (s.staff ?? []).filter((x) => x.role === "leasing");
  if (!hired.length) {
    const p = principalTemperament(s);
    return (p.judgment + p.relationships) / 2;
  }
  return hired.reduce((a, st) => a + attrValue(st.attrs, "negotiation"), 0) / hired.length;
}

export function penNegotiation(
  s: GameState,
  cover: "agent" | "exclusive" | "staff" | null | undefined,
): number {
  if (cover === "agent" || cover === "exclusive") return OUTSIDE_DESK_NEGOTIATION;
  return deskNegotiation(s);
}

/** Tenant-care multiplier from the PM on this building or the float desk. */
export function pmTenantCareMult(s: GameState, bbl?: string): number {
  let care: number;
  let localSlip = s.pmDeskSlip ?? 0;
  const you = () => {
    const p = principalTemperament(s);
    return (p.diligence + p.relationships) / 2;
  };
  if (bbl) {
    const assigned = assignedForBbl(s, bbl, "pm");
    if (assigned) {
      care = attrValue(assigned.attrs, "tenantCare");
    } else {
      const floaters = (s.staff ?? []).filter((x) => x.role === "pm" && isFloatStaff(x));
      care = floaters.length
        ? floaters.reduce((a, st) => a + attrValue(st.attrs, "tenantCare"), 0) / floaters.length
        : you();
    }
  } else {
    const hired = (s.staff ?? []).filter((x) => x.role === "pm");
    care = hired.length
      ? hired.reduce((a, st) => a + attrValue(st.attrs, "tenantCare"), 0) / hired.length
      : you();
  }
  return Math.max(0.90, Math.min(1.12, 1 + (care - 50) / 100 * 0.22 - localSlip * 0.12));
}

export function renewalMultFor(s: GameState, h: Holding): number {
  return h.pmRenewalMult ?? s.pmRenewalMult ?? 1;
}

export function rentMultFor(s: GameState, h: Holding): number {
  return h.leasingRentMult ?? s.leasingRentMult ?? 1;
}
