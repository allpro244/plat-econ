// PROPERTY-TAX APPEALS.
//
// The assessor chases rising values quickly and falling ones slowly. That is
// realistic only if the other half exists: an owner can pay for an appraisal,
// file a challenge, wait for the board, and sometimes force the roll back to
// market. Without this file a downturn's tax bill was deliberately sticky and
// the player had no counterplay to the mechanism the comments described.
import type { ParcelTable } from "@/data/types";
import type { GameState } from "./types";
import { cloneState, logBooks } from "./types";
import { rng } from "./market";
import { ownedHoldingValue, TAX_RATE } from "./value";
import { recordPropertyEvent } from "./history";

const COOLDOWN_M = 36;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

export function taxAppealQuote(s: GameState, parcels: ParcelTable, bbl: string): {
  assessed: number;
  target: number;
  annualSavings: number;
  fee: number;
  months: number;
  odds: number;
} | null {
  const h = s.holdings[bbl];
  if (!h || h.groundLeased || h.taxAppeal) return null;
  if ((h.lastTaxAppealM ?? -Infinity) + COOLDOWN_M > s.month) return null;
  const assessed = Math.round(h.assessed ?? h.costBasis);
  const target = Math.round(ownedHoldingValue(s, parcels, h));
  if (!(target > 0) || assessed <= target * 1.05) return null;
  const over = assessed / target - 1;
  const annualSavings = Math.round((assessed - target) * TAX_RATE);
  // Tax counsel commonly works for roughly a quarter to two fifths of first-
  // year savings. Use 35%, with a minimum that pays for the appraisal and
  // filing even on a small building.
  const fee = Math.round(Math.max(7_500, annualSavings * 0.35));
  const months = Math.round(8 + Math.min(10, over * 20));
  const odds = clamp(0.25 + over * 1.8, 0.15, 0.90);
  return { assessed, target, annualSavings, fee, months, odds };
}

export function fileTaxAppeal(
  s: GameState, parcels: ParcelTable, bbl: string,
): { s: GameState; err?: string; msg?: string } {
  const h = s.holdings[bbl];
  if (!h) return { s, err: "You do not own that property." };
  if (h.taxAppeal) return { s, err: "That assessment is already under appeal." };
  const q = taxAppealQuote(s, parcels, bbl);
  if (!q) return { s, err: "The assessment is not materially above today's market evidence, or the last appeal is too recent." };
  if (s.cash < q.fee) return { s, err: `The appraisal and tax counsel require ${money(q.fee)} up front.` };
  const next = cloneState(s);
  const nh = next.holdings[bbl];
  next.cash -= q.fee;
  logBooks(next, "taxes", q.fee);
  nh.taxAppeal = {
    filedM: next.month,
    decideM: next.month + q.months,
    assessedAtFile: q.assessed,
    target: q.target,
    fee: q.fee,
    odds: q.odds,
  };
  next.news.unshift({
    q: next.month, kind: "info", bbl,
    text: `Tax appeal filed: ${money(q.assessed)} assessment against ${money(q.target)} of market evidence. `
      + `${money(q.fee)} spent; the board sits in ${q.months} months.`,
  });
  return { s: next, msg: "Assessment appealed." };
}

/** Monthly board decisions. Mutates the monthly tick's cloned state. */
export function tickTaxAppeals(s: GameState, parcels: ParcelTable): void {
  for (const h of Object.values(s.holdings)) {
    const app = h.taxAppeal;
    if (!app || s.month < app.decideM) continue;
    delete h.taxAppeal;
    h.lastTaxAppealM = s.month;
    if (h.groundLeased) continue; // the lessee carries the bill now
    const won = rng(s, "owners") < app.odds;
    if (won) {
      const currentEvidence = Math.round(ownedHoldingValue(s, parcels, h));
      const target = Math.min(app.target, currentEvidence || app.target);
      const before = Math.round(h.assessed ?? app.assessedAtFile);
      h.assessed = Math.min(before, target);
      const annual = Math.max(0, Math.round((before - h.assessed) * TAX_RATE));
      s.news.unshift({
        q: s.month, kind: "deal", bbl: h.bbl,
        text: `Tax appeal won: ${money(before)} assessment reduced to ${money(h.assessed)}. `
          + `About ${money(annual)} a year comes off the property-tax bill.`,
      });
      recordPropertyEvent(s, h.bbl, {
        kind: "planning",
        amount: h.assessed,
        outcome: `Tax appeal won; assessment reduced from ${money(before)} to ${money(h.assessed)}`,
      });
    } else {
      s.news.unshift({
        q: s.month, kind: "warn", bbl: h.bbl,
        text: `Tax appeal denied. The ${money(h.assessed ?? app.assessedAtFile)} assessment stands and the filing cost is spent.`,
      });
      recordPropertyEvent(s, h.bbl, {
        kind: "planning",
        amount: h.assessed ?? app.assessedAtFile,
        outcome: "Tax appeal denied; assessment stands",
      });
    }
  }
}
