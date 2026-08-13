/**
 * THE ESTATE — player mortality, the tax bill, continue-as-heir.
 *
 * Rate and exemption are facts about the world (IRC §2001 / basic exclusion),
 * not difficulty dials. Counterplay is step-up at death, §6166 instalments,
 * and the existing liquidity model. See HANDOFF_PRINCIPAL.md / PRINCIPAL_CALLS.md.
 *
 * Succession must NEVER set gameOver — that freezes the world and every later
 * month becomes a copy (the century "plateau" false-bug).
 */
import type { ParcelTable } from "@/data/types";
import type { GameState } from "./types";
import { cloneState, logBooks, monthLabel } from "./types";
import { netWorth, ownedHoldingValue } from "./value";
import {
  ageYears, makePlayerPrincipal, prng, seedCareer, type Person,
} from "./people";

/**
 * Top federal estate tax rate — IRC §2001. Calibrated industry constant.
 * Source: 40% rate under current law (post-2001 / TCJA structure).
 */
export const ESTATE_TAX_RATE = 0.40;

/**
 * Basic exclusion amount, 2024 dollars. Cited: IRS Rev. Proc. 2023-34 /
 * inflation-adjusted exclusion for 2024 ($13.61M). Shape parameter: federal
 * basic exclusion; not a balance dial.
 */
export const ESTATE_EXEMPTION = 13_610_000;

/** Nine months to file — IRC §6075. */
export const ESTATE_FILE_M = 9;

/**
 * §6166 closely-held business instalment — tax payable over fourteen years
 * after a 5-year deferral of principal (interest accrues). We model the
 * fourteen-year amortisation of the bill; the deferral detail is Phase 5.1.
 * Source: IRC §6166.
 */
export const SECTION_6166_YEARS = 14;

/**
 * Opening age traded against bankroll. Not a difficulty dial — the real trade
 * every person in this business makes. Paired with START_CASH_CHOICES order.
 */
export const START_LIFE_CHOICES = [
  { age: 28, cash: 1_000_000 as const },
  { age: 35, cash: 2_500_000 as const },
  { age: 42, cash: 5_000_000 as const },
  { age: 48, cash: 10_000_000 as const },
  { age: 52, cash: 20_000_000 as const },
] as const;

export type StartLife = (typeof START_LIFE_CHOICES)[number];

export function lifeForCash(cash: number): StartLife {
  return START_LIFE_CHOICES.find((c) => c.cash === cash) ?? START_LIFE_CHOICES[1];
}

export interface EstateBill {
  /** Gross estate at death (firm equity). */
  gross: number;
  /** Tax assessed. */
  tax: number;
  /** Month the return is due (death + 9). */
  deadlineM: number;
  /** Still outstanding. */
  remaining: number;
  /** §6166 election — amortise remaining over SECTION_6166_YEARS. */
  elect6166?: boolean;
  /** Monthly principal under 6166 once elected. */
  installmentMo?: number;
  deathM: number;
  decedentName: string;
}

/** One quantity: estate tax on firm equity above the exclusion. */
export function estateTaxOn(gross: number): number {
  return Math.round(Math.max(0, gross - ESTATE_EXEMPTION) * ESTATE_TAX_RATE);
}

/**
 * Step-up in basis at death — IRC §1014. Heirs take FMV; depreciation
 * recapture clock resets. Uses the same marks netWorth uses so the step-up
 * and the estate gross cannot disagree.
 */
export function stepUpBases(s: GameState, parcels: ParcelTable): void {
  for (const h of Object.values(s.holdings)) {
    const v = ownedHoldingValue(s, parcels, h);
    h.costBasis = Math.round(v);
    h.deprTaken = 0;
  }
}

/**
 * Continue as the heir: portfolio and bench survive; the phone book resets.
 * Returns the new principal (already seated on s.principal).
 */
export function succeedAsHeir(s: GameState, decedent: Person): Person {
  const heirAge = 28 + Math.floor(prng(s) * 20); // 28–47
  const heir = makePlayerPrincipal(s, heirAge);
  // Inherit a thin slice of the decedent's career — the buildings teach, the
  // phone book does not. Half the class months, no districts (new markets).
  const inherited = seedCareer(s, heirAge);
  if (decedent.career) {
    for (const [cls, m] of Object.entries(decedent.career.classM)) {
      inherited.classM[cls as keyof typeof inherited.classM] =
        Math.round(((inherited.classM[cls as keyof typeof inherited.classM] ?? 0) + (m ?? 0) * 0.35));
    }
  }
  heir.career = inherited;
  heir.name = heir.name; // already drawn
  s.principal = heir;

  // Relationships attached to the PERSON.
  s.sponsor = { events: [] };
  s.lenderRel = {};
  s.street = {};
  s.hireReputation = 0.55;
  // A failed fund was the dead principal's name. The heir is not that name.
  delete s.fundFailedM;
  // Bench survives — staff stay on payroll with their own ties.

  return heir;
}

/**
 * Process player death. Does NOT set gameOver. Assesses estate tax, steps up
 * bases, seats the heir, schedules the bill. peopleRng for heir draws only.
 */
export function settlePlayerEstate(s: GameState, parcels: ParcelTable): void {
  const dead = s.principal;
  if (!dead || dead.seat !== "you" || dead.diedM !== undefined) return;
  if (dead.diesM === undefined || s.month < dead.diesM) return;

  dead.diedM = s.month;
  const gross = netWorth(s, parcels);
  const tax = estateTaxOn(gross);
  stepUpBases(s, parcels);
  const heir = succeedAsHeir(s, dead);

  s.estateDue = {
    gross,
    tax,
    remaining: tax,
    deadlineM: s.month + ESTATE_FILE_M,
    deathM: s.month,
    decedentName: dead.name,
  };

  const age = ageYears(dead, s.month);
  s.news.unshift({
    q: s.month,
    kind: "event",
    text: tax > 0
      ? `${dead.name} has died at ${age}. The estate is $${(gross / 1e6).toFixed(1)}M; `
        + `tax of $${(tax / 1e6).toFixed(2)}M is due by ${monthLabel(s.month + ESTATE_FILE_M)}. `
        + `You continue as ${heir.name}. The buildings stay. The phone book does not.`
      : `${dead.name} has died at ${age}. The estate sits under the exclusion — no tax due. `
        + `You continue as ${heir.name}. The buildings stay. The phone book does not.`,
  });
}

/** Elect §6166 — stretch remaining tax over fourteen years. */
export function elect6166(s: GameState): { s: GameState; err?: string } {
  const next = cloneState(s);
  const bill = next.estateDue;
  if (!bill || bill.remaining <= 0) return { s, err: "There is no estate tax to elect on." };
  if (bill.elect6166) return { s, err: "§6166 is already elected." };
  bill.elect6166 = true;
  bill.installmentMo = Math.round(bill.remaining / (SECTION_6166_YEARS * 12));
  next.news.unshift({
    q: next.month, kind: "info",
    text: `§6166 election filed — estate tax of $${(bill.remaining / 1e6).toFixed(2)}M `
      + `stretches over ${SECTION_6166_YEARS} years `
      + `(~$${(bill.installmentMo / 1000).toFixed(0)}k/mo).`,
  });
  return { s: next };
}

/**
 * Pay estate tax — lump at deadline, or monthly under 6166. Uses cash; books
 * to taxes. Does not set gameOver if unpaid — the bill remains and bites cash.
 */
export function tickEstateBill(s: GameState): void {
  const bill = s.estateDue;
  if (!bill || bill.remaining <= 0) {
    if (bill && bill.remaining <= 0) delete s.estateDue;
    return;
  }

  let dueNow = 0;
  if (bill.elect6166 && bill.installmentMo) {
    dueNow = Math.min(bill.remaining, bill.installmentMo);
  } else if (s.month >= bill.deadlineM) {
    dueNow = bill.remaining;
  } else {
    return; // waiting for the filing date
  }

  const pay = Math.min(s.cash, dueNow);
  if (pay > 0) {
    s.cash -= pay;
    bill.remaining = Math.round(bill.remaining - pay);
    logBooks(s, "taxes", pay);
  }
  if (bill.remaining <= 0) {
    s.news.unshift({
      q: s.month, kind: "info",
      text: `Estate tax for ${bill.decedentName} is paid in full.`,
    });
    delete s.estateDue;
    return;
  }
  // Unpaid at deadline without 6166 — keep dunning; force is the liquidity model.
  if (!bill.elect6166 && s.month === bill.deadlineM && pay < dueNow) {
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `Estate tax of $${((dueNow - pay) / 1e6).toFixed(2)}M is past due and unpaid. `
        + `Elect §6166 or sell buildings — the bill does not go away.`,
    });
  }
}

export function tickPlayerMortality(s: GameState, parcels: ParcelTable): void {
  settlePlayerEstate(s, parcels);
  tickEstateBill(s);
}
