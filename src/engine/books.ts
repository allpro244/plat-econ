/**
 * THE BOOKS — period views the statement and the sheet share.
 *
 * Year buckets already live on GameState via logBooks. Monthly income and a
 * year-end balance snapshot need their own stamps so the player can toggle
 * without inventing a second set of numbers.
 */
import type { ParcelTable } from "@/data/types";
import type { BalanceSnapshot, BooksMonth, BooksYear, GameState } from "./types";
import { logBooks } from "./types";
import { depositsHeld } from "./leasing";
import { locLimit, locRate } from "./credit";
import { collateralAsIs, ownedHoldingValue, netWorth, resolveRec } from "./value";

/** Re-export so harnesses that load `books` can dual-write without pulling all of types. */
export { logBooks };

export interface BalanceSheetView {
  m: number;
  label: string;
  cash: number;
  deposits: number;
  propGross: number;
  mortgages: number;
  landOnly: number;
  bldgCount: number;
  landCount: number;
  byClass: Record<string, { n: number; gross: number; debt: number }>;
  cip: number;
  cipDebt: number;
  cipN: number;
  notesVal: number;
  noteCount: number;
  locBal: number;
  locLim: number;
  facility: number;
  totalAssets: number;
  totalLiab: number;
  equity: number;
  nwEngine: number;
  rate: number;
  /** True when this is a frozen year-end stamp, not today's live sheet. */
  historical: boolean;
}

/** Live balance sheet from the same marks the TopBar and the lenders use. */
export function buildBalanceSheet(s: GameState, parcels: ParcelTable): BalanceSheetView {
  let propGross = 0, mortgages = 0, landOnly = 0, bldgCount = 0, landCount = 0;
  const byClass: Record<string, { n: number; gross: number; debt: number }> = {};
  for (const h of Object.values(s.holdings)) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    const v = ownedHoldingValue(s, parcels, h);
    const debt = h.loan?.balance ?? 0;
    propGross += v;
    mortgages += debt;
    // A leased fee resolves as the lessee's tower — it is still coupon paper,
    // not a building you operate. Keep it out of the office/retail count.
    const cls = h.groundLeased
      ? "leased fee"
      : (rec.class === "land" || !(rec.floors > 0) ? "land" : (rec.class ?? "other"));
    if (cls === "land" || cls === "leased fee") { landOnly += v; landCount++; }
    else { bldgCount++; }
    if (!byClass[cls]) byClass[cls] = { n: 0, gross: 0, debt: 0 };
    byClass[cls].n++;
    byClass[cls].gross += v;
    byClass[cls].debt += debt;
  }

  let cip = 0, cipDebt = 0, cipN = 0;
  for (const d of Object.values(s.developments ?? {})) {
    const sunk = (d.equitySpent ?? 0) + (d.drawn ?? 0) - (d.reserveUsed ?? 0);
    cip += Math.max(0, sunk);
    cipDebt += d.loanBalance ?? 0;
    cipN++;
  }

  let notesVal = 0;
  for (const n of s.notes ?? []) {
    if (n.perf === "performing") { notesVal += n.basis; continue; }
    const rec = resolveRec(parcels, s, n.bbl);
    if (!rec) continue;
    const r = s.rivals?.find((x) => x.id === n.obligorId);
    notesVal += Math.min(n.basis, Math.round(collateralAsIs(rec, s.econ, r?.occ ?? 0.5)));
  }

  const deposits = depositsHeld(s);
  const locBal = s.loc?.balance ?? 0;
  const locLim = locLimit(s, parcels);
  const facility = s.facility?.balance ?? 0;
  const cash = s.cash;
  const totalAssets = cash + propGross + Math.max(0, cip) + notesVal;
  const totalLiab = mortgages + cipDebt + facility + locBal + deposits;
  const equity = totalAssets - totalLiab;
  const nwEngine = netWorth(s, parcels);

  return {
    m: s.month,
    label: "today",
    cash, deposits, propGross, mortgages, landOnly, bldgCount, landCount,
    byClass, cip, cipDebt, cipN, notesVal, noteCount: (s.notes ?? []).length,
    locBal, locLim, facility, totalAssets, totalLiab, equity, nwEngine,
    rate: locRate(s),
    historical: false,
  };
}

/** Compact year-end stamp — enough to re-open last December without the rent roll. */
export function captureBalanceSnapshot(s: GameState, parcels: ParcelTable): BalanceSnapshot {
  const live = buildBalanceSheet(s, parcels);
  return {
    m: s.month,
    cash: live.cash,
    deposits: live.deposits,
    propGross: live.propGross,
    mortgages: live.mortgages,
    landOnly: live.landOnly,
    bldgCount: live.bldgCount,
    landCount: live.landCount,
    byClass: Object.fromEntries(
      Object.entries(live.byClass).map(([k, v]) => [k, { ...v }]),
    ),
    cip: live.cip,
    cipDebt: live.cipDebt,
    cipN: live.cipN,
    notesVal: live.notesVal,
    noteCount: live.noteCount,
    locBal: live.locBal,
    locLim: live.locLim,
    facility: live.facility,
    totalAssets: live.totalAssets,
    totalLiab: live.totalLiab,
    equity: live.equity,
    nwEngine: live.nwEngine,
    rate: live.rate,
  };
}

export function balanceSnapshotView(snap: BalanceSnapshot): BalanceSheetView {
  return { ...snap, label: "year-end", historical: true };
}

/** Stamp December of each game year. Keeps one entry per year. */
export function maybeStampYearEndBalance(s: GameState, parcels: ParcelTable) {
  // month 11, 23, 35… — December of each year (month 0 is January of year 0).
  if (s.month < 0 || s.month % 12 !== 11) return;
  const snap = captureBalanceSnapshot(s, parcels);
  if (!s.balanceHistory) s.balanceHistory = [];
  const yr = Math.floor(s.month / 12);
  const without = s.balanceHistory.filter((b) => Math.floor(b.m / 12) !== yr);
  without.push(snap);
  // A century of year-ends is 100 rows — fine; still cap so a long save stays lean.
  s.balanceHistory = without.slice(-120);
}

export function booksMonthAsYear(b: BooksMonth): BooksYear {
  const { m, ...flows } = b;
  return { yr: Math.floor(m / 12), ...flows };
}
