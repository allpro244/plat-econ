/**
 * Monthly cycle digest — measured fields only, no invented causality.
 * Pure: takes two snapshots (or one) and reports what moved.
 */
import type { GameState } from "./types";
import { monthLabel } from "./types";

export type CycleDigest = {
  month: number;
  label: string;
  phase: string;
  rumored: string | null;
  ratePct: number;
  dRateBp: number | null;
  caps: { cls: string; pct: number; dBp: number | null }[];
  vac: { cls: string; pct: number; dPp: number | null }[];
  balloons12: number;
  floatingShare: number;
  underConstruction: number;
};

function classKeys(): ("office" | "retail" | "multifamily" | "industrial")[] {
  return ["office", "retail", "multifamily", "industrial"];
}

export function cycleDigest(game: GameState, prev: GameState | null = null): CycleDigest {
  const e = game.econ;
  const pe = prev?.econ;
  const ratePct = e.indexRate;
  const dRateBp = pe ? Math.round((ratePct - pe.indexRate) * 100) : null;

  const caps = classKeys().map((cls) => {
    const pct = e.capRate[cls];
    const dBp = pe ? Math.round((pct - pe.capRate[cls]) * 100) : null;
    return { cls, pct, dBp };
  });

  const vac = classKeys().map((cls) => {
    const pct = (e.cityVac?.[cls] ?? 0) * 100;
    const dPp = pe && e.cityVac && pe.cityVac
      ? Math.round(((e.cityVac[cls] ?? 0) - (pe.cityVac[cls] ?? 0)) * 1000) / 10
      : null;
    return { cls, pct, dPp };
  });

  let balloons12 = 0;
  let floating = 0;
  let withLoan = 0;
  for (const h of Object.values(game.holdings)) {
    if (!h.loan) continue;
    withLoan++;
    if (h.loan.maturityM - game.month <= 12 && h.loan.maturityM > game.month) balloons12++;
    if (h.loan.floating || h.loan.product === "float") floating++;
  }
  const floatingShare = withLoan > 0 ? floating / withLoan : 0;
  const underConstruction = Object.keys(game.developments ?? {}).length
    + (game.cityJobs ?? []).filter((j) => !game.built?.[j.bbl] && !game.developments?.[j.bbl]).length;

  return {
    month: game.month,
    label: monthLabel(game.month),
    phase: e.phase,
    rumored: e.rumoredPhase && e.rumoredPhase !== e.phase ? e.rumoredPhase : null,
    ratePct,
    dRateBp,
    caps,
    vac,
    balloons12,
    floatingShare,
    underConstruction,
  };
}

/** Holdings that completed ground-up delivery this month. */
export function deliveriesThisMonth(prev: GameState, next: GameState): string[] {
  const out: string[] = [];
  for (const [bbl, h] of Object.entries(next.holdings)) {
    if (h.deliveredM !== next.month) continue;
    if (prev.developments?.[bbl]) out.push(bbl);
  }
  return out;
}

/** Rival / city jobs that left the pipeline this month (delivered or cancelled). */
export function cityDeliveriesThisMonth(prev: GameState, next: GameState): string[] {
  const before = new Set((prev.cityJobs ?? []).map((j) => j.bbl));
  const after = new Set((next.cityJobs ?? []).map((j) => j.bbl));
  const out: string[] = [];
  for (const bbl of before) {
    if (after.has(bbl)) continue;
    if (next.built?.[bbl]) out.push(bbl);
  }
  return out;
}
