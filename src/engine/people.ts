/**
 * THE PRINCIPAL — one person type for the player, every hire, every heir, and
 * every rival firm's operating principal.
 *
 * Phase 1 lands the type inert: existing staff behaviour is re-pointed at the
 * same fields unchanged, a principal is synthesised for old saves, and nothing
 * yet dies, raises a fund, or earns a career. See HANDOFF_PRINCIPAL.md.
 *
 * RNG: this module owns `s.peopleRng`, seeded `s.seed ^ 0x50454f50` ("PEOP").
 * A hiring pool must not re-roll the economy (staff.ts); a man's date of death
 * must not either. Draw the death month ONCE at creation — never a monthly
 * hazard — so the draw count is auditable and foreshadowing stays honest.
 */
import type { ParcelTable } from "@/data/types";
import type { FounderBid, GameState } from "./types";
import { START_YEAR } from "./types";
import { mulberry32Step } from "./market";
import { assetValue, initialCondition, resolveRec } from "./value";

export type PersonSeat = "you" | "employee" | "partner" | "rival" | "none";

/**
 * One human being. Staff are Persons with seat "employee" plus payroll fields
 * (see staff.ts). The player is seat "you". Rival firms carry seat "rival".
 */
/** Asset classes a career can specialise in. Land accrues slowly (assemblage). */
export type CareerClass = "office" | "retail" | "multifamily" | "industrial" | "land";

/**
 * What someone has actually done — month-equivalents of operating exposure.
 * Competence is a readout of this, not a purchased skill chip.
 */
export interface CareerLog {
  classM: Partial<Record<CareerClass, number>>;
  /** District (submarket) exposure. */
  districtM: Record<string, number>;
}

export interface Person {
  id: number;
  name: string;
  /**
   * Birth month on the campaign clock. May be negative (born before month 0).
   * Age arithmetic always goes through ageYears() so START_YEAR stays single-
   * sourced — do not invent `2000 + month/12` beside this.
   */
  bornM: number;
  /**
   * Death month on the campaign clock, drawn once at creation from a period
   * life table (drawDeathM). Absent on legacy staff synthesised without a
   * draw; filled on the next ensurePeople pass.
   */
  diesM?: number;
  /** Month the death was processed (estate fired). Absent while alive. */
  diedM?: number;
  /** TRUE ability, 1-100. Shown only for seat "you". Never for anyone else. */
  attrs: Record<string, number>;
  /** Noisy first read — interview / dealing history. */
  obs: Record<string, number>;
  /** How wide the initial read was. */
  band0: number;
  seat: PersonSeat;
  /** Rival.firm id when seat === "rival". */
  firmId?: string;
  /** Earned by doing. Absent on legacy rows until ensurePeople / tickCareers. */
  career?: CareerLog;
}

/** peopleRng seed mix — distinct from staff's 0x5741ff. */
export const PEOPLE_RNG_XOR = 0x50454f50;

export function prng(s: GameState): number {
  const r = mulberry32Step(s.peopleRng ?? (s.seed ^ PEOPLE_RNG_XOR) | 0);
  s.peopleRng = r.state;
  return r.value;
}

export function prrange(s: GameState, lo: number, hi: number): number {
  return lo + prng(s) * (hi - lo);
}

/**
 * US SSA Period Life Table 2019, male — selected ages, annual death probability qx.
 * Source: https://www.ssa.gov/oact/STATS/table4c6.html (period life table).
 * Shape parameter: male table (CRE principals historically skew male; a later
 * pass can sex-mix without changing the draw contract — one U per person).
 *
 * Calibrated industry constant, not a balance dial. Hardcoded with citation.
 */
const QX_MALE: ReadonlyArray<readonly [age: number, qx: number]> = [
  [20, 0.00115], [25, 0.00135], [30, 0.00152], [35, 0.00178],
  [40, 0.00234], [45, 0.00348], [50, 0.00528], [55, 0.00812],
  [60, 0.01248], [65, 0.01872], [70, 0.02915], [75, 0.04682],
  [80, 0.07591], [85, 0.12140], [90, 0.18870], [95, 0.28750],
  [100, 0.41450], [105, 0.55100], [110, 0.68000],
];

function qxAt(age: number): number {
  if (age <= QX_MALE[0][0]) return QX_MALE[0][1];
  if (age >= QX_MALE[QX_MALE.length - 1][0]) return QX_MALE[QX_MALE.length - 1][1];
  for (let i = 1; i < QX_MALE.length; i++) {
    const [a1, q1] = QX_MALE[i - 1];
    const [a2, q2] = QX_MALE[i];
    if (age <= a2) {
      const t = (age - a1) / (a2 - a1);
      return q1 + t * (q2 - q1);
    }
  }
  return QX_MALE[QX_MALE.length - 1][1];
}

/**
 * Draw the death month ONCE. One uniform from peopleRng; invert residual
 * lifetime from current age against the period table. Contract: exactly one
 * peopleRng step per call.
 *
 * Used for rivals, staff, and heirs-as-rivals. The player uses
 * `drawPlayerDeathM` — a late-career band, not the open table.
 */
export function drawDeathM(s: GameState, bornM: number, atMonth: number = s.month): number {
  const age0 = Math.max(18, (atMonth - bornM) / 12);
  const u = prng(s);
  let cdf = 0;
  let surv = 1;
  const start = Math.floor(age0);
  for (let age = start; age < 110; age++) {
    const qx = qxAt(age + 0.5);
    const pDie = surv * qx;
    if (u < cdf + pDie) {
      const within = pDie > 0 ? (u - cdf) / pDie : 0.5;
      return Math.round(bornM + (age + within) * 12);
    }
    cdf += pDie;
    surv *= (1 - qx);
  }
  return Math.round(bornM + 110 * 12);
}

/**
 * Player death age band. Succession is a late-career event — not mid-run.
 * Inclusive bounds on calendar age at death. One peopleRng step.
 */
export const PLAYER_DEATH_AGE_LO = 70;
export const PLAYER_DEATH_AGE_HI = 105;

/**
 * Draw the player principal's death month ONCE into [70, 105].
 * Contract: exactly one peopleRng step per call — same discipline as drawDeathM.
 * If the principal is already past the floor (should not happen on a fresh
 * start), the band begins at next birthday so diesM stays in the future.
 */
export function drawPlayerDeathM(s: GameState, bornM: number, atMonth: number = s.month): number {
  const ageNow = Math.max(0, (atMonth - bornM) / 12);
  const lo = Math.max(PLAYER_DEATH_AGE_LO, ageNow + 1 / 12);
  const hi = Math.max(lo, PLAYER_DEATH_AGE_HI);
  const u = prng(s);
  const age = lo + u * (hi - lo);
  return Math.round(bornM + age * 12);
}

/** Calendar age in whole years at the current (or given) month. */
export function ageYears(p: Pick<Person, "bornM">, month: number): number {
  return Math.max(0, Math.floor((month - p.bornM) / 12));
}

/** Calendar year of birth for display. */
export function birthYear(p: Pick<Person, "bornM">): number {
  return START_YEAR + Math.floor(p.bornM / 12);
}

export const GENERAL_PERSON_ATTRS = [
  "judgment", "urgency", "diligence", "relationships",
] as const;

/** Default opening age when the start-menu trade (Phase 5) is not yet live. */
export const DEFAULT_PRINCIPAL_AGE = 40;

function drawGeneralAttrs(s: GameState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of GENERAL_PERSON_ATTRS) {
    const v = (prng(s) + prng(s) + prng(s)) / 3;
    out[k] = Math.round(Math.max(8, Math.min(96, 8 + v * 88)));
  }
  return out;
}

function observeSelf(attrs: Record<string, number>): Record<string, number> {
  // A person knows themselves — obs equals truth, band collapsed for display.
  // Others never see attrs; Phase 2 shows these for seat "you" only.
  return { ...attrs };
}

const FIRST = ["Halloran", "Edmund", "Miriam", "Clement", "Vera", "Solomon", "Greta",
  "Desmond", "Nadia", "Walter", "Imelda", "Perry", "Junius", "Lorna", "Abel"];
const LAST = ["Voss", "Boyle", "Whitcomb", "Ashford", "Hale", "Mercer", "Quincy",
  "Trent", "Alden", "Crowley", "Beckett", "Moss", "Pryor", "Shaw"];

function pickName(s: GameState): string {
  const f = FIRST[Math.floor(prng(s) * FIRST.length) % FIRST.length];
  const l = LAST[Math.floor(prng(s) * LAST.length) % LAST.length];
  return `${f} ${l}`;
}

export function nextPersonId(s: GameState): number {
  const id = s.nextPersonId ?? 1;
  s.nextPersonId = id + 1;
  return id;
}

/**
 * Opening principal for a new run. Age is fixed until Phase 5's start-menu
 * trade; death is drawn once. Attrs use peopleRng only — never s.rng / staffRng.
 */
export function makePlayerPrincipal(s: GameState, ageYrs: number = DEFAULT_PRINCIPAL_AGE): Person {
  const bornM = s.month - Math.round(ageYrs * 12);
  const attrs = drawGeneralAttrs(s);
  const p: Person = {
    id: 0,
    name: s.firm?.name ? principalNameFromFirm(s.firm.name, s) : pickName(s),
    bornM,
    attrs,
    obs: observeSelf(attrs),
    band0: 0,
    seat: "you",
  };
  p.diesM = drawPlayerDeathM(s, bornM, s.month);
  p.career = seedCareer(s, ageYrs);
  return p;
}

function principalNameFromFirm(firmName: string, s: GameState): string {
  // Prefer a human name; firm name stays on FirmIdentity.
  void firmName;
  return pickName(s);
}

/**
 * Queue a departed employee as a founder bid. They try to raise in
 * ~3–9 months; rivals.ts can still refuse. peopleRng for the delay only.
 */
export function queueFounderBid(
  s: GameState,
  st: {
    name: string;
    bornM: number;
    diesM?: number;
    attrs: Record<string, number>;
    obs: Record<string, number>;
    band0: number;
    career?: CareerLog;
    role: "pm" | "leasing" | "construction";
  },
  fromFirmId: string,
  fromFirmName: string,
): void {
  const delay = 3 + Math.floor(prng(s) * 7); // 3–9 months to raise
  const bid: FounderBid = {
    readyM: s.month + delay,
    name: st.name,
    bornM: st.bornM,
    diesM: st.diesM,
    attrs: { ...st.attrs },
    obs: { ...st.obs },
    band0: st.band0,
    career: st.career ? {
      classM: { ...st.career.classM },
      districtM: { ...st.career.districtM },
    } : undefined,
    role: st.role,
    fromFirmId,
    fromFirmName,
  };
  (s.founderBids ??= []).push(bid);
}

/** Seat a founder bid as the operating principal of a new rival. */
export function seatFounderAsRival(s: GameState, firmId: string, bid: FounderBid): Person {
  const p: Person = {
    id: nextPersonId(s),
    name: bid.name,
    bornM: bid.bornM,
    diesM: bid.diesM,
    attrs: { ...bid.attrs },
    obs: { ...bid.obs },
    band0: bid.band0,
    seat: "rival",
    firmId,
    career: bid.career ? {
      classM: { ...bid.career.classM },
      districtM: { ...bid.career.districtM },
    } : undefined,
  };
  if (p.diesM === undefined) p.diesM = drawDeathM(s, p.bornM, s.month);
  return p;
}

/** Rival operating principal. */
export function makeRivalPrincipal(s: GameState, firmId: string, firmName: string, ageYrs?: number): Person {
  // Age band 38–72: working principals, not the opening associate class.
  const age = ageYrs ?? Math.round(prrange(s, 38, 72));
  const bornM = s.month - Math.round(age * 12);
  const attrs = drawGeneralAttrs(s);
  // Noisy read of a rival — wide band; never shown as truth.
  const band0 = 22;
  const obs: Record<string, number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    obs[k] = Math.round(Math.max(1, Math.min(100, v + prrange(s, -band0, band0))));
  }
  void firmName;
  const p: Person = {
    id: nextPersonId(s),
    name: pickName(s),
    bornM,
    attrs,
    obs,
    band0,
    seat: "rival",
    firmId,
  };
  p.diesM = drawDeathM(s, bornM, s.month);
  p.career = seedCareer(s, age);
  return p;
}

/**
 * Birth month for a new hire, drawn from peopleRng AFTER staffRng work is done
 * so the staff stream's step count is unchanged. Age 28–55 at hire.
 */
export function stampEmployeeLife(
  s: GameState,
  st: { bornM?: number; diesM?: number; hiredM?: number; career?: CareerLog },
): void {
  if (st.bornM === undefined) {
    const age = Math.round(prrange(s, 28, 55));
    // Anchor age at hire month when known so a migrated decade-old desk
    // does not become "thirty today" on load.
    const at = typeof st.hiredM === "number" && st.hiredM >= 0 ? st.hiredM : s.month;
    st.bornM = at - age * 12;
  }
  if (st.diesM === undefined) {
    st.diesM = drawDeathM(s, st.bornM, s.month);
  }
  if (!st.career) {
    st.career = seedCareer(s, ageYears({ bornM: st.bornM }, s.month));
  }
}

/**
 * Idempotent: ensure the player principal and every living rival have a Person,
 * and every staff row has bornM/diesM. Uses peopleRng only. Safe on every load.
 */
export function ensurePeople(s: GameState): void {
  if (s.peopleRng === undefined) {
    s.peopleRng = (s.seed ^ PEOPLE_RNG_XOR) | 0;
  }
  if (!s.principal || s.principal.seat !== "you") {
    s.principal = makePlayerPrincipal(s, DEFAULT_PRINCIPAL_AGE);
  } else if (s.principal.diesM === undefined) {
    s.principal.diesM = drawPlayerDeathM(s, s.principal.bornM, s.month);
  } else {
    // Clamp legacy / SSA-drawn player deaths into the product band so a save
    // from before the floor does not kill at 55.
    const deathAge = (s.principal.diesM - s.principal.bornM) / 12;
    if (deathAge < PLAYER_DEATH_AGE_LO || deathAge > PLAYER_DEATH_AGE_HI) {
      s.principal.diesM = drawPlayerDeathM(s, s.principal.bornM, s.month);
    }
  }
  s.rivalPrincipals ??= {};
  for (const r of s.rivals ?? []) {
    if (r.failedM != null) continue;
    if (!s.rivalPrincipals[r.id]) {
      s.rivalPrincipals[r.id] = makeRivalPrincipal(s, r.id, r.name);
    } else if (s.rivalPrincipals[r.id].diesM === undefined) {
      const p = s.rivalPrincipals[r.id];
      p.diesM = drawDeathM(s, p.bornM, s.month);
    }
  }
  if (s.principal && !s.principal.career) {
    s.principal.career = seedCareer(s, ageYears(s.principal, s.month));
  }
  for (const id of Object.keys(s.rivalPrincipals)) {
    const p = s.rivalPrincipals[id];
    if (p && !p.career) p.career = seedCareer(s, ageYears(p, s.month));
  }
  for (const st of s.staff ?? []) {
    stampEmployeeLife(s, st as { bornM?: number; diesM?: number; career?: CareerLog });
  }
  for (const c of s.hirePool?.list ?? []) {
    stampEmployeeLife(s, c as { bornM?: number; diesM?: number; career?: CareerLog });
  }
}

/** Drop the free capacity dials. Inferred firm shape from headcount stays. */
export function clearStyleOverrides(s: GameState): void {
  delete s.ownerStyle;
  delete s.benchStyle;
}

export function rivalPrincipalOf(s: GameState, firmId: string): Person | undefined {
  return s.rivalPrincipals?.[firmId];
}

/** Short league-table line: "Halloran Voss, 44". Never attributes. */
export function principalTag(s: GameState, firmId: string): string | null {
  const p = rivalPrincipalOf(s, firmId);
  if (!p) return null;
  return `${p.name}, ${ageYears(p, s.month)}`;
}

/**
 * Display names for the four temperament attrs. Storage keys stay forever
 * (judgment / urgency / diligence / relationships) so saves and harnesses do
 * not re-roll — see ATTR_CONTRACT.md.
 */
export const ATTR_LABEL_PERSON: Record<string, string> = {
  judgment: "Deal sense",
  urgency: "Bandwidth",
  diligence: "Rigor",
  relationships: "Access",
};

/** Neutral mid when a principal row is missing (should not happen after ensurePeople). */
export function neutralTemperament(): Record<string, number> {
  return { judgment: 50, urgency: 50, diligence: 50, relationships: 50 };
}

export function principalTemperament(s: GameState): Record<string, number> {
  const a = s.principal?.attrs;
  if (!a) return neutralTemperament();
  return {
    judgment: a.judgment ?? 50,
    urgency: a.urgency ?? 50,
    diligence: a.diligence ?? 50,
    relationships: a.relationships ?? 50,
  };
}

const CAREER_CLASSES: CareerClass[] = ["office", "retail", "multifamily", "industrial"];

export function emptyCareer(): CareerLog {
  return { classM: {}, districtM: {} };
}

/**
 * Prior career from years in the business. Drawn from peopleRng — one primary
 * class, a secondary, a handful of districts. Shape parameter: working life
 * starts ~22; months of exposure ≈ (age − 22) × 12 × 0.55 (not every month
 * is operating a book).
 */
export function seedCareer(s: GameState, ageYrs: number): CareerLog {
  const years = Math.max(0, ageYrs - 22);
  const months = Math.round(years * 12 * 0.55);
  const log = emptyCareer();
  if (months <= 0) return log;
  const primary = CAREER_CLASSES[Math.floor(prng(s) * CAREER_CLASSES.length) % CAREER_CLASSES.length];
  const secondary = CAREER_CLASSES[Math.floor(prng(s) * CAREER_CLASSES.length) % CAREER_CLASSES.length];
  log.classM[primary] = Math.round(months * (primary === secondary ? 1 : 0.7));
  if (primary !== secondary) log.classM[secondary] = Math.round(months * 0.3);
  // 2–4 districts share the primary book.
  const nDist = 2 + Math.floor(prng(s) * 3);
  for (let i = 0; i < nDist; i++) {
    const d = `d${Math.floor(prng(s) * 40)}`;
    log.districtM[d] = (log.districtM[d] ?? 0) + Math.round(months / nDist);
  }
  return log;
}

/**
 * 0 = stranger, 1 = deep specialist. Exponential saturation — ~36 months in
 * class and ~24 in district approaches competent; never a purchased max.
 */
export function familiarity(
  career: CareerLog | undefined,
  cls: string,
  district: string,
): number {
  if (!career) return 0.5; // unset → neutral (staff harness / legacy)
  const hasExposure = Object.values(career.classM).some((m) => (m ?? 0) > 0)
    || Object.values(career.districtM).some((m) => (m ?? 0) > 0);
  if (!hasExposure) return 0.5;
  const cM = career.classM[cls as CareerClass] ?? 0;
  const dM = career.districtM[district] ?? 0;
  const classFit = 1 - Math.exp(-cM / 36);
  const distFit = 1 - Math.exp(-dM / 24);
  return Math.min(1, 0.55 * classFit + 0.45 * distFit);
}

/**
 * CAPACITY axis — unfamiliar work costs more desk per foot. Range centred so
 * a seeded mid-career generalist ≈ 1.0: novice 1.15, specialist 0.85.
 * Never multiplies rent, opex, or price — only how much load a building is.
 */
export function careerLoadMult(
  career: CareerLog | undefined,
  cls: string,
  district: string,
): number {
  const f = familiarity(career, cls, district);
  return 1.15 - 0.30 * f;
}

export function topCareerLines(career: CareerLog | undefined, n = 2): string[] {
  if (!career) return [];
  const classes = Object.entries(career.classM)
    .filter(([, m]) => (m ?? 0) > 6)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, n)
    .map(([c, m]) => `${c} (${Math.round((m ?? 0) / 12)}y)`);
  return classes;
}

export function accrueCareer(
  career: CareerLog,
  cls: string,
  district: string,
  months = 1,
): void {
  const c = (CAREER_CLASSES as string[]).includes(cls) || cls === "land" ? cls as CareerClass : null;
  if (c) career.classM[c] = (career.classM[c] ?? 0) + months;
  if (district) career.districtM[district] = (career.districtM[district] ?? 0) + months;
}

function ensureCareer(s: GameState, p: Person): CareerLog {
  if (!p.career) p.career = seedCareer(s, ageYears(p, s.month));
  return p.career;
}

/**
 * Earn competence by operating — one month of exposure per building on the
 * person's book (assigned staff) or on the float (principal). peopleRng is
 * NOT stepped here; accrual is deterministic from the book.
 */
export function tickCareers(s: GameState, parcels: ParcelTable): void {
  if (s.principal) ensureCareer(s, s.principal);
  for (const st of s.staff ?? []) {
    const person = st as Person & { role?: string; assignedBbls?: string[] };
    if (!person.career) {
      stampEmployeeLife(s, st as { bornM?: number; diesM?: number; career?: CareerLog; hiredM?: number });
    }
    const career = (st as { career?: CareerLog }).career ?? emptyCareer();
    (st as { career?: CareerLog }).career = career;
    for (const bbl of st.assignedBbls ?? []) {
      const rec = resolveRec(parcels, s, bbl);
      if (!rec) continue;
      accrueCareer(career, rec.class, rec.district ?? "—", 1);
    }
  }
  // Principal earns on every operated holding nobody else is pinned to for PM
  // (the float). Construction/leasing specialisation lands with the hire.
  if (s.principal) {
    const pinned = new Set<string>();
    for (const st of s.staff ?? []) {
      for (const bbl of st.assignedBbls ?? []) pinned.add(bbl);
    }
    const career = ensureCareer(s, s.principal);
    for (const bbl of Object.keys(s.holdings)) {
      if (pinned.has(bbl)) continue;
      const h = s.holdings[bbl];
      if (!h || h.groundLeased) continue;
      const rec = resolveRec(parcels, s, bbl);
      if (!rec) continue;
      accrueCareer(career, rec.class, rec.district ?? "—", 1);
    }
  }
}

/**
 * Rival principals whose diesM has arrived — estate sales via reason:"estate",
 * heir takes the seat, player–firm StreetTie clears (relationships attach to
 * the person). Uses peopleRng for ask noise ONLY — never s.rng.
 *
 * Iteration order: sorted firm ids so draw count does not depend on object
 * key insertion order when several die the same month.
 */
export function tickRivalMortality(s: GameState, parcels: ParcelTable): void {
  const ids = Object.keys(s.rivalPrincipals ?? {}).sort();
  for (const firmId of ids) {
    const p = s.rivalPrincipals![firmId];
    if (!p || p.seat !== "rival") continue;
    if (p.diedM !== undefined) continue;
    if (p.diesM === undefined || s.month < p.diesM) continue;
    p.diedM = s.month;
    beginRivalEstate(s, parcels, firmId, p);
  }
}

function beginRivalEstate(
  s: GameState,
  parcels: ParcelTable,
  firmId: string,
  dead: Person,
): void {
  const r = (s.rivals ?? []).find((x) => x.id === firmId);
  if (!r || r.failedM !== undefined) return;

  // Relationships attached to the person — the firm's street file was theirs.
  if (s.street?.[firmId]) delete s.street[firmId];

  const book = r.bbls.filter(
    (bbl) => !s.holdings[bbl] && !s.listings.some((l) => l.bbl === bbl),
  );
  // Estates do not dump the whole book on a Tuesday — same six-at-a-time
  // discipline as owners.tickHolders.
  const take = Math.min(6, book.length);
  let listed = 0;
  for (let i = 0; i < take; i++) {
    const bbl = book[i];
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const v = assetValue(rec, s.econ, initialCondition(rec));
    if (v <= 0) continue;
    // peopleRng — estate pricing must not re-roll the century.
    const haircut = 0.78 + prng(s) * 0.15;
    const ask = Math.round((v * haircut) / 1000) * 1000;
    s.listings.push({
      bbl,
      ask,
      listedM: s.month,
      expiresM: s.month + 9, // estate filing clock — nine months (calibrated)
      distress: true,
      sellerId: r.id,
      reason: "estate",
    });
    listed++;
  }

  // Heir continues the firm — younger, thin on relationships, keeps the book.
  const heirAge = Math.round(prrange(s, 28, 48));
  const heir = makeRivalPrincipal(s, firmId, r.name, heirAge);
  s.rivalPrincipals![firmId] = heir;

  const age = ageYears(dead, s.month);
  s.news.unshift({
    q: s.month,
    kind: "event",
    text: listed > 0
      ? `${dead.name} of ${r.name} has died at ${age}. The estate is listing ${listed} building${listed === 1 ? "" : "s"}; ${heir.name} takes the firm.`
      : `${dead.name} of ${r.name} has died at ${age}. ${heir.name} inherits a book with nothing left to put on the tape.`,
  });
}

/** Monthly people tick — careers, rival mortality, then player estate. */
export function tickPeople(s: GameState, parcels: ParcelTable): void {
  tickCareers(s, parcels);
  tickRivalMortality(s, parcels);
  // Player mortality lives in estate.ts so the tax spine stays one file.
  // Imported lazily inside the call site in sim to keep people↔estate acyclic
  // at module load; sim calls tickPlayerMortality directly after tickPeople.
}
