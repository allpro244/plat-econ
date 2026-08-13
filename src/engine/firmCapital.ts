/**
 * FIRM CAPITAL — what survives when a person dies.
 *
 * Not XP. Not a skill tree. A readout of institutional standing already earned
 * in hireReputation, lender relationships, clean exits, payroll shape, and
 * whether a vehicle is live. See ATTR_CONTRACT.md Phases 5–6.
 *
 * Process capacity: a mature shop covers slightly more float SF (playbooks,
 * reporting) — capped and earned, never a free dial. Heirs keep process;
 * they lose the principal's phone book (estate.ts already clears street /
 * lenderRel / hireReputation on death — process from exits/milestones remains).
 */
import type { GameState } from "./types";
import { ageYears, topCareerLines, type Person } from "./people";

/** Labels only — keep in sync with MILESTONES in sim.ts (avoid sim↔staff cycle). */
const MILESTONE_LABELS: Record<string, string> = {
  deed1: "First deed recorded",
  lease1: "First lease signed",
  tower1: "First development delivered",
  exit1: "First profitable exit",
  nw25: "Net worth $25M",
  nw100: "Net worth $100M",
  nw500: "Net worth $500M",
  nw1b: "The billion-dollar book",
  ten: "Ten buildings under management",
  twentyfive: "A quarter-hundred holdings",
  half: "Fifty years in town",
  nw5b: "Five billion under management",
  fifty: "Fifty buildings under management",
  hundred: "A hundred deeds recorded",
  builder: "Twenty-five buildings of your own making",
  share: "A twentieth of the city's built stock",
  diamond: "Seventy-five years in town",
  sesqui: "A hundred and fifty years in town",
  bicent: "Two centuries in town",
};

export interface FirmPillar {
  id: string;
  label: string;
  /** 0..1 contribution toward maturity. */
  score: number;
  detail: string;
}

export interface FirmCapital {
  /** Integer 0–5 for UI. */
  tier: number;
  label: string;
  /** 0..1 continuous maturity. */
  score: number;
  pillars: FirmPillar[];
  /**
   * Multiplier on owner float capacity from institutional process.
   * 1.00 at tier 0 → 1.08 at tier 5. Bandwidth still dominates.
   */
  processCapacityMult: number;
  milestonesHit: number;
  milestonesTotal: number;
}

const TIER_LABEL = [
  "Startup shop",
  "Known locally",
  "Established firm",
  "Institutional name",
  "City fixture",
  "Legacy house",
] as const;

function cleanExits(s: GameState): number {
  return (s.exits ?? []).filter((e) => !e.forced && e.gain > 0).length;
}

function meanLenderRel(s: GameState): number {
  const rel = s.lenderRel ?? {};
  const vals = Object.values(rel);
  if (!vals.length) return 20; // default desk standing
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Pure readout — no RNG, no mutation. Safe on every Staff page render.
 */
export function firmCapital(s: GameState): FirmCapital {
  const hire = s.hireReputation ?? 0.55;
  const lender = meanLenderRel(s);
  const exits = cleanExits(s);
  const staffN = (s.staff ?? []).length;
  const liveFund = !!(s.fund && !s.fund.settled);
  // Avoid netWorth(parcels) here — firmCapital is called from capacity paths that
  // sometimes lack a parcel table (harnesses). Last stamped NW or cash is enough.
  const nw = s.nwHistory?.length
    ? s.nwHistory[s.nwHistory.length - 1]!
    : (s.cash ?? 0);
  const holdingsN = Object.keys(s.holdings ?? {}).length;
  const milestonesHit = Object.keys(MILESTONE_LABELS)
    .filter((id) => s.milestones?.[id] !== undefined).length;

  const shape = staffN <= 1 ? "hands-on" : staffN >= 5 ? "platform" : "growing firm";
  const pillars: FirmPillar[] = [
    {
      id: "hire",
      label: "Hiring name",
      score: Math.max(0, Math.min(1, (hire - 0.15) / 0.80)),
      detail: hire < 0.45
        ? "Messy firings — shortlists read worse"
        : hire > 0.70
          ? "People take your calls about seats"
          : "Ordinary street standing on hires",
    },
    {
      id: "lender",
      label: "Lender standing",
      score: Math.max(0, Math.min(1, (lender - 20) / 80)),
      detail: valsDetail(lender),
    },
    {
      id: "exits",
      label: "Clean exits",
      score: Math.max(0, Math.min(1, exits / 8)),
      detail: exits === 0
        ? "No profitable voluntary exit on the record"
        : `${exits} clean exit${exits === 1 ? "" : "s"} — LPs and desks notice`,
    },
    {
      id: "bench",
      label: "Bench",
      score: Math.max(0, Math.min(1, staffN / 6)),
      detail: staffN === 0
        ? "You alone — no institutional bench"
        : `${staffN} on payroll · ${shape}`,
    },
    {
      id: "vehicle",
      label: "Vehicle",
      score: liveFund ? 1 : (s.fundFailedM !== undefined ? 0.15 : 0),
      detail: liveFund
        ? "Live fund — LP capital on a second account"
        : s.fundFailedM !== undefined
          ? "A prior vehicle failed — the street remembers"
          : "No fund raised yet",
    },
    {
      id: "book",
      label: "Book",
      score: Math.max(0, Math.min(1,
        0.55 * Math.min(1, Math.log10(Math.max(1, nw)) / 9)
        + 0.45 * Math.min(1, holdingsN / 40))),
      detail: nw >= 1e9
        ? "Billion-dollar book"
        : holdingsN >= 10
          ? `${holdingsN} deeds · building the book`
          : holdingsN === 0
            ? "No deeds yet"
            : "Still building the book",
    },
  ];

  const score = pillars.reduce((a, p) => a + p.score, 0) / pillars.length;
  const tier = Math.max(0, Math.min(5, Math.floor(score * 6 - 1e-9)));
  const processCapacityMult = 1 + 0.016 * tier; // ≤ 1.08

  return {
    tier,
    label: TIER_LABEL[tier],
    score,
    pillars,
    processCapacityMult,
    milestonesHit,
    milestonesTotal: Object.keys(MILESTONE_LABELS).length,
  };
}

function valsDetail(lender: number): string {
  if (lender >= 70) return "Desks know your name — paper prices it";
  if (lender >= 40) return "Ordinary banking relationships";
  return "Thin file with the lenders in town";
}

/** Career years + top lines for the leveling readout (person track). */
export function personProgress(person: Person | undefined, month: number): {
  age: number;
  careerYears: number;
  knows: string[];
  deathAge: number | null;
} {
  if (!person) {
    return { age: 0, careerYears: 0, knows: [], deathAge: null };
  }
  const age = ageYears(person, month);
  const classM = Object.values(person.career?.classM ?? {}).reduce((a, m) => a + (m ?? 0), 0);
  const careerYears = Math.round((classM / 12) * 10) / 10;
  const deathAge = person.diesM !== undefined
    ? Math.round(((person.diesM - person.bornM) / 12) * 10) / 10
    : null;
  return {
    age,
    careerYears,
    knows: topCareerLines(person.career, 3),
    deathAge,
  };
}

/** Named milestones already struck — for the Staff "leveling" panel. */
export function firmMilestonesHit(s: GameState): { id: string; label: string; atM: number }[] {
  const out: { id: string; label: string; atM: number }[] = [];
  for (const [id, label] of Object.entries(MILESTONE_LABELS)) {
    const at = s.milestones?.[id];
    if (at !== undefined) out.push({ id, label, atM: at });
  }
  return out.sort((a, b) => a.atM - b.atM);
}

/** Next milestone label not yet stamped (coaching line). */
export function nextFirmMilestone(s: GameState): { id: string; label: string } | null {
  for (const [id, label] of Object.entries(MILESTONE_LABELS)) {
    if (s.milestones?.[id] === undefined) return { id, label };
  }
  return null;
}
