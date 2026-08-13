// THE MORTGAGE RECORD — every loan in this town, written against a deed.
//
// The banks had balance sheets and the balance sheets had no insides. A
// lender carried `book: $3.4B` and `delinquent: 2.9%` and not one loan you
// could point at — so "open its books and see it coming" meant reading two
// aggregates, the note desk conjured a face value out of thin air the month
// it decided to sell, and the player asking "which properties has this bank
// lent against?" had no answer anywhere in the state.
//
// This is the answer. Every rival-owned building carrying debt gets a row on
// the public record: whose loan it is, which desk wrote it, the balance, the
// coupon, the maturity, and what the building appraised for the day it was
// written — which is the number that makes "LTV then vs. LTV now" a readable
// fact instead of a vibe. The player's own loans and the construction book
// already exist on Holding/Development; together the three are a full
// statement for every desk in town.
//
// IT IS A PROJECTION, NOT A SECOND SIMULATION. Rivals carry one aggregate
// `debt` number, and that stays true: the record allocates that debt across
// their financed buildings by value and reconciles every month, so it can
// never disagree with the street table. Statuses come off the borrower —
// a firm eight months into a squeeze has every loan on watch, which is what
// cross-default means. Nothing here draws on the RNG stream: lender
// assignment, coupons and maturities are hashed off the deed, so the record
// is deterministic decoration on top of dynamics that already existed.
import type { ParcelTable } from "@/data/types";
import type { CityLoan, GameState, Rival } from "./types";
import { assetValue, resolveRec } from "./value";
import { assetGrade } from "./rivals";
import { PRODUCTS } from "./debt";
import { CONSTRUCTION_LENDER } from "./lenders";

/** Deterministic 0..1 from a string — the record must not perturb the RNG. */
function hash01(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * WHO WROTE THIS LOAN. The same logic a borrower uses, run backwards: small
 * checks go to the hometown bank, big well-kept buildings to the life company,
 * the biggest paper to the conduit, tired buildings to the fund, and the
 * regional takes the middle of everything — which is why the regional is the
 * one a property bust kills.
 */
function pickLender(bbl: string, value: number, worn: boolean): string {
  const h = hash01(bbl + ":led");
  if (worn && h < 0.45) return "Cordage Debt Partners";
  if (value < 4_000_000) return h < 0.62 ? "First Harbor Bank" : "Alden Savings & Trust";
  if (value > 14_000_000) {
    if (h < 0.38) return "Meridian Street Capital";
    if (h < 0.72) return "Pelican Life Insurance";
    return "Alden Savings & Trust";
  }
  return h < 0.55 ? "Alden Savings & Trust" : h < 0.78 ? "Pelican Life Insurance" : "First Harbor Bank";
}

/** Is this deed's paper already outside the banking system? */
function paperElsewhere(s: GameState, bbl: string): boolean {
  return !!s.notes?.some((n) => n.bbl === bbl)
    || !!s.noteOffers?.some((o) => o.bbl === bbl)
    || !!(s.rivalNotes ?? []).some((x) => x.bbl === bbl);
}

/** One month of keeping the record true. Runs after the street, before the note desk. */
export function tickLedger(s: GameState, parcels: ParcelTable) {
  if (!s.cityLoans) s.cityLoans = {};
  const led = s.cityLoans;
  const live = (s.rivals ?? []).filter((r) => r.failedM === undefined);
  const owner: Record<string, Rival> = {};
  for (const r of live) for (const b of r.bbls) owner[b] = r;

  // A deed that changed hands, a borrower that died, or paper that left the
  // banks for the note market comes off the record.
  for (const bbl of Object.keys(led)) {
    const o = owner[bbl];
    if (!o || o.id !== led[bbl].obligorId || paperElsewhere(s, bbl)) delete led[bbl];
  }

  for (const r of live) {
    // The record of this firm's mortgages, written where missing.
    if (r.debt > 1000) {
      for (const bbl of r.bbls) {
        if (led[bbl] || paperElsewhere(s, bbl)) continue;
        const rec = resolveRec(parcels, s, bbl);
        if (!rec || rec.class === "land" || rec.bldgArea <= 0) continue;
        const grade = assetGrade(r, rec);
        const v = assetValue(rec, s.econ, grade);
        if (v < 400_000) continue;
        const h = hash01(bbl + ":" + r.id);
        // At campaign start the record is backdated — the town did not take
        // out all its mortgages the day you arrived.
        const originM = s.month <= 1 ? -Math.round(h * 96) : s.month;
        led[bbl] = {
          bbl,
          lender: pickLender(bbl, v, grade === "worn" || grade === "obsolete"),
          obligorId: r.id,
          balance: 0,   // reconciled below
          ratePct: +(s.econ.indexRate + 1.6 + 1.6 * hash01(bbl + ":cpn")).toFixed(2),
          originM,
          maturityM: originM + 60 + Math.round(60 * hash01(bbl + ":mat")),
          origValue: v,
          klass: rec.class,
          status: "current",
        };
      }
    }
    // RECONCILE: the rows always sum to the firm's actual debt, weighted by
    // what each building appraised for at origination. The street table and
    // the statement can never tell two stories.
    const rows = r.bbls.map((b) => led[b]).filter(Boolean) as CityLoan[];
    if (!rows.length) continue;
    const wSum = rows.reduce((a, x) => a + x.origValue, 0);
    const debt = Math.max(0, Math.round(r.debt));
    for (const x of rows) x.balance = Math.round(debt * (x.origValue / Math.max(1, wSum)));

    // Status is the borrower's, because that is what cross-default means.
    const ltv = (r.aum ?? 0) > 0 ? r.debt / r.aum! : 0;
    const status: CityLoan["status"] =
      (r.stressMs ?? 0) >= 6 ? "workout"
        : (r.stressMs ?? 0) > 0 || ltv > 0.85 ? "watch" : "current";
    for (const x of rows) {
      x.status = status;
      // A balloon that comes due on a solvent borrower rolls at today's rate —
      // which is why the record's coupons follow the rate era instead of
      // fossilising at whatever 2000 looked like.
      if (s.month >= x.maturityM && status === "current") {
        const rec = resolveRec(parcels, s, x.bbl);
        x.originM = s.month;
        x.maturityM = s.month + 60 + Math.round(60 * hash01(x.bbl + ":m" + s.month));
        x.ratePct = +(s.econ.indexRate + 1.6 + 1.6 * hash01(x.bbl + ":c" + s.month)).toFixed(2);
        if (rec) x.origValue = assetValue(rec, s.econ, assetGrade(r, rec));
      }
    }
  }

  // WHAT EACH DESK IS HOLDING IN THIS TOWN, BY CLASS — the number the quote
  // desk checks before it adds another office loan to an office book. Yours,
  // the street's, and the construction paper, counted the same way.
  for (const l of s.lenders ?? []) l.classBook = {};
  const add = (lender: string, klass: string, amt: number) => {
    const l = s.lenders?.find((x) => x.name === lender);
    if (!l || amt <= 0) return;
    l.classBook![klass] = (l.classBook![klass] ?? 0) + Math.round(amt);
  };
  for (const x of Object.values(led)) add(x.lender, x.klass, x.balance);
  for (const h of Object.values(s.holdings)) {
    if (!h.loan) continue;
    const lender = h.loan.holder ?? PRODUCTS.find((p) => p.id === h.loan!.product)?.lender;
    const rec = resolveRec(parcels, s, h.bbl);
    if (lender && rec) add(lender, rec.class, h.loan.balance);
  }
  for (const d of Object.values(s.developments ?? {})) {
    add(d.lender ?? CONSTRUCTION_LENDER, "construction", d.loanBalance);
  }
}
