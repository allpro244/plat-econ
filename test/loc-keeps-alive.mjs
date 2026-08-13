// LOC KEEPS THE RUN ALIVE — undrawn credit is not insolvency.
//
//   pnpm engine && node test/loc-keeps-alive.mjs
//
// The insolvency clock used to tick before month-end drew the revolver, so a
// firm that covered every shortfall from the line still racked up twelve
// "underwater" months, lost buildings, and could end the run while credit
// remained. The line has to clear cash before the bailiff reads the balance.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nLOC KEEPS THE RUN ALIVE\n");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);

/**
 * Buy a free-and-clear building large enough that a cash hole does not erase
 * the borrowing base. A $400K deed against an $80M cheque left NW negative
 * the moment cash was set underwater — which correctly zeros the line, and
 * is not the bug this harness is about. Opening tapes vary by seed, so walk
 * until a real building shows up.
 */
function buyBuilding(seed, cash = 60_000_000) {
  for (let s = seed; s < seed + 250; s++) {
    let g = E.firstListings(E.newGame(s, parcels, cash), parcels, bbls);
    const listing = (g.listings ?? []).find((l) => {
      const r = E.resolveRec(parcels, g, l.bbl);
      return r && r.class !== "land" && r.bldgArea > 0
        && l.ask > 8_000_000 && l.ask < 35_000_000;
    });
    if (!listing) continue;
    const bought = E.executePurchase(g, parcels, listing.bbl, listing.ask, "cash", false, 1);
    if (bought.err) continue;
    return { g: bought.s, bbl: listing.bbl };
  }
  throw new Error("No substantial building to buy.");
}

// --- 1. Undrawn line clears a cash hole before the insolvency clock ticks ---
{
  let { g, bbl } = buyBuilding(61);
  g.cash = -500_000;
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  g.insolventMs = 11;
  const avail = E.locAvailable(g, parcels);
  check(avail > 1_000_000, `borrowing base survives the hole ($${(avail / 1e6).toFixed(2)}M undrawn)`);
  g = E.advanceMonth(g, parcels, bbls);
  check(!g.gameOver, "run does not end while the line can cover");
  check(g.cash >= 0, `cash non-negative after the draw (cash $${(g.cash / 1e6).toFixed(3)}M)`);
  check((g.insolventMs ?? 0) === 0, `insolvency clock resets when the line clears (was 11 → ${g.insolventMs})`);
  check((g.loc?.balance ?? 0) > 0, `line was drawn (balance $${((g.loc?.balance ?? 0) / 1e6).toFixed(2)}M)`);
  check(!!g.holdings[bbl], "creditors did not seize the building while credit remained");
}

// --- 2. Fourteen months of coverable holes never seize -------------------
{
  let { g, bbl } = buyBuilding(62);
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  g.insolventMs = 0;
  let seized = false;
  for (let i = 0; i < 14; i++) {
    // Keep the hole inside the borrowing base that remains after the draw.
    const room = E.locAvailable(g, parcels);
    if (room < 400_000) {
      // Pay the line down from a cash gift so the next month can still test cover.
      g.cash = Math.max(g.cash, 2_000_000);
      E.sweepLocIdleCash(g);
    }
    g.cash = -250_000;
    check(E.locAvailable(g, parcels) > 250_000, `month ${i + 1}: line can still cover the hole`);
    g = E.advanceMonth(g, parcels, bbls);
    if (!g.holdings[bbl]) { seized = true; break; }
    if (g.gameOver) break;
  }
  check(!g.gameOver, "fourteen coverable months do not end the run");
  check(!seized && !!g.holdings[bbl], "building survives fourteen months of holes the line can fill");
  check((g.insolventMs ?? 0) === 0, `clock stays clear when every hole is drawn (insolventMs=${g.insolventMs})`);
}

// --- 3. Empty book + exhausted line still ends the run -------------------
{
  let g = E.newGame(63, parcels, 100_000);
  g.holdings = {};
  g.developments = {};
  g.workouts = {};
  g.cash = -2_000_000;
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  g.insolventMs = 12;
  // Negative cash with no assets → NW negative → no advance rate left.
  check(E.locAvailable(g, parcels) === 0, "no borrowing base on an empty underwater book");
  g = E.advanceMonth(g, parcels, bbls);
  check(!!g.gameOver, "run ends when the line is empty and nothing remains to seize");
}

// --- 4. Workout-only book does not end while the line still advances -----
{
  let { g, bbl } = buyBuilding(64);
  const v = E.ownedHoldingValue(g, parcels, g.holdings[bbl]);
  const bal = Math.round(v * 0.5);
  // Park the only deed in workout so the general-creditor seizure list is
  // empty — the old path called that "nothing left" and ended the run even
  // when the revolver still advanced against the same collateral.
  g.holdings[bbl].loan = {
    product: "perm", principal: bal, balance: bal, ratePct: 6.5, margin: 0,
    ioUntilM: g.month + 60, amortYears: 25, maturityM: g.month + 60,
    monthlyPmt: Math.round(bal * 0.065 / 12),
    minDSCR: 1.2, maxLTV: 0.65, sweep: false, cleanQs: 0, recourse: false,
  };
  g.workouts = {
    [bbl]: {
      bbl, lender: "Test Bank", startM: g.month - 2,
      stage: "notice", cause: "covenant",
      cure: 50_000, decideM: g.month + 6, asks: 0, missedMs: 0,
    },
  };
  g.cash = -400_000;
  g.loc = { balance: 0, drawnTotal: 0, interestPaid: 0 };
  g.insolventMs = 12;
  check(E.locAvailable(g, parcels) > 0, "workout collateral still supports the line");
  g = E.advanceMonth(g, parcels, bbls);
  check(!g.gameOver, "workout-only book does not bankrupt while the line advances");
}

console.log(bad ? `\n${bad} FAILED\n` : "\nALL OK\n");
process.exit(bad ? 1 : 0);
