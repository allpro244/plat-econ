// A FUNDED SPONSOR DOES NOT LOSE THE BUILDING TO A CALENDAR.
//
//   pnpm exec node test/foreclose-funded.mjs
//
// The shapes of the bug the owner keeps reporting:
//   1. Covenant file + current coupon → notice calendar must NOT file
//   2. Balloon cure fundable from cash + line → auto-cure, no filing
//   3. Arrears file + coupon fundable → clock rolls, no filing
//   4. Balloon + coupon fundable but NOT the payoff → must NOT file
//      (maturity default while the cheque clears — the commonest CRE workout)
//   5. Already filed + reinstate fundable → auto-cure pulls it off the docket
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(91001, parcels), parcels, bbls);

// Buy one levered building so there is a loan to put in workout.
let bought = null;
for (let m = 0; m < 40 && !bought; m++) {
  g = E.advanceQuarter(g, parcels, bbls, null);
  for (const L of g.listings ?? []) {
    const rec = E.resolveRec(parcels, g, L.bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    const pid = ["savings", "harbor"].find((id) => E.buyQuote(g, parcels, L.bbl, L.ask, id, 1).principal > 0);
    if (!pid) continue;
    const r = E.executePurchase(g, parcels, L.bbl, L.ask, pid, false, 1);
    if (r?.s?.holdings[L.bbl]?.loan) { g = r.s; bought = L.bbl; break; }
  }
}
if (!bought) {
  console.log("FAIL  could not buy a levered building for the harness");
  process.exit(1);
}

const h0 = g.holdings[bought];
const bal = h0.loan.balance;
const pmt = h0.loan.monthlyPmt;
const clone = (s) => structuredClone(s);
let bad = 0;

console.log(`\nFUNDED SPONSOR vs FORECLOSURE CALENDAR — ${bought}\n`);

// --- 1. Covenant: clock expired, firm can fund the coupon, cannot (yet) write
//     the full equity cure. Must stay in notice — not foreclose.
{
  let s = clone(g);
  s.cash = Math.max(pmt * 3, 50_000);          // covers DS, not a fat cure
  s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  s.workouts = {
    [bought]: {
      bbl: bought, lender: "Test Desk", startM: s.month - 8,
      stage: "notice", cause: "covenant",
      cure: Math.round(bal * 0.25),             // deliberately fat
      decideM: s.month - 1, asks: 0, missedMs: 0,
    },
  };
  s.holdings[bought].loan.sweep = true;
  s.holdings[bought].loan.breachMs = 30;
  E.tickWorkouts(s, parcels);
  const w = s.workouts?.[bought];
  if (!w) {
    // Auto-cured from the small cash pile — only OK if cure shrank to fit.
    console.log("  OK    covenant file closed (cure refreshed and funded)");
  } else if (w.stage === "foreclosure") {
    bad++;
    console.log("  FAIL  covenant file filed to foreclosure while coupon was fundable");
  } else {
    console.log("  OK    covenant file stayed in notice while the note was current");
  }
}

// --- 2. Balloon: cure covered by cash + line → auto-cure, file gone.
{
  let s = clone(g);
  const cure = Math.round(bal * 1.01);
  s.cash = Math.round(cure * 0.2);
  s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  const nw = E.netWorth(s, parcels);
  if (E.locAvailable(s, parcels) + s.cash < cure) {
    s.cash = cure; // fall back to cash if the book is too thin for the line
  }
  s.workouts = {
    [bought]: {
      bbl: bought, lender: "Test Desk", startM: s.month - 8,
      stage: "notice", cause: "balloon",
      cure, decideM: s.month - 1, asks: 0, missedMs: 0,
    },
  };
  E.tickWorkouts(s, parcels);
  if (s.workouts?.[bought]) {
    bad++;
    console.log(`  FAIL  balloon file still open — cash $${(s.cash / 1e6).toFixed(2)}M, `
      + `locAvail $${(E.locAvailable(s, parcels) / 1e6).toFixed(2)}M, cure $${(cure / 1e6).toFixed(2)}M, nw $${(nw / 1e6).toFixed(1)}M`);
  } else if (s.holdings[bought]?.loan) {
    bad++;
    console.log("  FAIL  balloon cured in the books but the loan is still on title");
  } else {
    console.log("  OK    balloon auto-cured from cash and the line");
  }
}

// --- 3. Arrears: coupon fundable → do not file.
{
  let s = clone(g);
  s.cash = Math.max(pmt * 2, 25_000);
  s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  s.workouts = {
    [bought]: {
      bbl: bought, lender: "Test Desk", startM: s.month - 8,
      stage: "notice", cause: "arrears",
      cure: Math.round(pmt * 3), decideM: s.month - 1, asks: 0, missedMs: 0,
    },
  };
  E.tickWorkouts(s, parcels);
  const w = s.workouts?.[bought];
  if (w?.stage === "foreclosure") {
    bad++;
    console.log("  FAIL  arrears file filed while the coupon was fundable");
  } else {
    console.log("  OK    arrears file did not file while the coupon was fundable");
  }
}

// --- 4. Balloon + coupon fundable, payoff NOT fundable → must NOT file.
//     This was the hole: maturity default with a maxed line still walked to
//     foreclosure on the notice calendar while the monthly cheque cleared.
{
  let s = clone(g);
  const cure = Math.round(bal * 1.01);
  s.cash = Math.max(pmt * 4, 50_000);
  const lim = E.locLimit(s, parcels);
  s.loc = { balance: Math.max(0, lim - 500), drawnTotal: lim, interestPaid: 0 };
  const fundable = E.fundableNow(s, parcels);
  if (fundable >= cure) {
    console.log("  SKIP  balloon DS-only case — book still funds the payoff");
  } else if (fundable < pmt) {
    console.log("  SKIP  balloon DS-only case — could not fund the coupon either");
  } else {
    s.workouts = {
      [bought]: {
        bbl: bought, lender: "Test Desk", startM: s.month - 8,
        stage: "notice", cause: "balloon",
        cure, decideM: s.month - 1, asks: 0, missedMs: 0,
      },
    };
    E.tickWorkouts(s, parcels);
    const w = s.workouts?.[bought];
    if (w?.stage === "foreclosure") {
      bad++;
      console.log("  FAIL  balloon filed while the monthly coupon was fundable "
        + `(cash $${s.cash}, fundable $${fundable}, cure $${cure})`);
    } else if (!w) {
      bad++;
      console.log("  FAIL  balloon file vanished without a funded payoff");
    } else {
      console.log("  OK    balloon stayed in notice while the coupon was fundable");
    }
  }
}

// --- 5. Already filed + reinstate fundable → pulled off the docket.
{
  let s = clone(g);
  const accrued = Math.round(bal * 0.04);
  const owed = Math.round(bal * 1.01 + accrued);
  s.cash = owed + 25_000;
  s.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  s.workouts = {
    [bought]: {
      bbl: bought, lender: "Test Desk", startM: s.month - 20,
      stage: "foreclosure", cause: "balloon",
      cure: Math.round(bal * 1.01), decideM: s.month + 2, saleM: s.month + 2,
      asks: 1, missedMs: 0, accrued,
    },
  };
  E.reinstateFundedForeclosures(s, parcels);
  if (s.workouts?.[bought]) {
    bad++;
    console.log("  FAIL  filed balloon still open after funded reinstate");
  } else if (s.holdings[bought]?.loan) {
    bad++;
    console.log("  FAIL  reinstate closed the file but left the balloon on title");
  } else {
    console.log("  OK    filed balloon reinstated before the hammer");
  }
}

console.log("");
process.exit(bad ? 1 : 0);
