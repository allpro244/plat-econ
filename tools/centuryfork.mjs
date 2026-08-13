// THE COUNTERFACTUALS — one decision in year three, ninety-seven years to run.
//
//   node tools/centuryfork.mjs              five seeds, six branches each
//   SEEDS=2 node tools/centuryfork.mjs      a quick pass
//
// Run the city to month 36, freeze it, then let the same frozen city live out
// six different centuries that differ only in what the player did on that one
// morning. Everything downstream — every rival's draw, every tenant's renewal,
// every cycle turn — is deterministic given the state, so any difference at
// year 100 was CAUSED by that morning.
//
// Caused, but not necessarily explained. The engine draws its randomness from
// the state, so touching the state at all reshuffles every draw after it. A
// decision that matters economically and a decision that matters not at all
// both produce a different year 100. That is why the PENNY branch exists: it
// adds one dollar to the player's chequing account at the fork and changes
// nothing else in the world. Whatever the penny moves by year 100 is the noise
// floor, and a real counterfactual has to beat it to mean anything.
//
// This is the same reason the answer is averaged over seeds instead of told as
// a story about one. One city is an anecdote. Five cities with the same sign
// is a finding.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leaseAtMarket } from "../test/leasepolicy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "..", "test", ".engine.mjs"));
const { makeCity } = await import(join(HERE, "..", "src", "citygen", "index.mjs"));

const MONTHS = Number(process.env.MONTHS ?? 1200);
const FORK_M = Number(process.env.FORK_M ?? 36);         // year 3
const OUT = process.env.OUT ?? join(HERE, "..", "..", "century-data");
const CITY_SEED = Number(process.env.CITY_SEED ?? 20261);
const USES = ["office", "retail", "multifamily", "industrial"];
mkdirSync(OUT, { recursive: true });

const built = makeCity(process.env.BW_CITY ?? "somewhere", CITY_SEED);
E.normalizeParcels(built.parcels);
const BASE = { parcels: built.parcels, adjacency: built.adjacency, bbls: Object.keys(built.parcels) };
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// THE PROTAGONIST. One buyer on ordinary bank leverage, taking anything that
// appraises above the ask — the least clever strategy that still does
// something, chosen so the branches differ by the branch and not by the bot's
// own cleverness.
//
// 55% is not a balance dial, it is what a bank lends a private owner against
// stabilised income. It also leaves the firm with dry powder, which matters
// here: an all-cash version of this bot is fully invested by month 30, and a
// branch called "took the deal on the table" cannot take anything.
// ---------------------------------------------------------------------------
const BASE_LTV = 0.55;
const BASE_MAXP = 0.88;                                   // buys only at a discount
// AND A CUSHION. A firm that deploys its last dollar has no fork in it: it
// cannot take the deal on the table because it cannot take any deal. Real
// owners hold working capital against a roof, a vacancy and a tax bill, and
// holding it is what makes "stretch for this one" an actual decision.
const RESERVE = 2_000_000;
//
// Those three numbers are not tuned to a target, they are the cheapest
// specification of a firm that is still trading in year 100. It took one sweep
// to find out that most specifications are not. Buying at 96% of appraisal on
// the same leverage is foreclosed by month 54 and dead by month 587; buying all
// cash never assembles enough income to carry the firm's own overhead and dies
// at month 408 holding nothing. The surviving operator is levered, patient and
// only ever buys at a discount, which is roughly what the survivors look like
// in life too.
function lease(g, parcels) {
  for (const loi of [...g.lois]) {
    const rec = E.resolveRec(parcels, g, loi.bbl), h = g.holdings[loi.bbl];
    if (!rec || !h) continue;
    const ask = E.managedRentPsfYr(rec, g.econ, h, loi.use) * E.staleDiscount(h.darkMs);
    const r = E.respondLOI(g, parcels, loi.id, loi.rentPsf >= ask * 0.92 ? "accept" : "pass");
    if (!r.err) g = r.s;
  }
  // No unsolicited sales. The protagonist is a holder — letting it take every
  // offer that crossed the desk sold it down from four buildings to one inside
  // fifteen years, which is a different experiment than this one.
  return g;
}

// The one deal on the table this month: cheapest ask relative to appraisal.
function bestBuy(g, parcels) {
  let best = null;
  for (const li of g.listings) {
    const rec = E.resolveRec(parcels, g, li.bbl);
    if (!rec || g.holdings[li.bbl] || rec.class === "land" || !rec.bldgArea) continue;
    const worth = E.assetValue(rec, g.econ, E.initialCondition(rec));
    if (!Number.isFinite(worth) || worth <= 0) continue;
    const disc = li.ask / worth;
    if (!best || disc < best.disc) best = { bbl: li.bbl, ask: li.ask, worth, disc, rec };
  }
  return best;
}

function buyRound(g, parcels, mo, arm, st = {}) {
  if (arm.freezeUntil && mo < arm.freezeUntil) return g;          // "hoard" — out for good
  const b = bestBuy(g, parcels);
  if (!b || b.disc > (arm.maxPrice ?? BASE_MAXP)) return g;
  const ltv = arm.ltvFrom !== undefined && mo >= arm.ltvFrom ? arm.ltv : BASE_LTV;
  if (g.cash - (b.ask * (1 - ltv) + b.ask * 0.03) < RESERVE) return g;   // keeps the cushion
  // "pass" — the mirror of the stretch. Not a date on the calendar: a firm
  // that sits out two calendar years when it had no deal in front of it has
  // not made a decision, and the first draft of this branch was measuring
  // exactly that nothing. This one lets the next real deal go, whenever it
  // turns up.
  if (st.skipsLeft > 0) { st.skipsLeft--; st.skipped = { m: mo, bbl: b.bbl, ask: b.ask, disc: +b.disc.toFixed(3) }; return g; }
  const r = E.executePurchase(g, parcels, b.bbl, b.ask, ltv <= 0.01 ? "cash" : "senior", false,
    ltv <= 0.01 ? 1 : ltv / 0.65);
  return r.err ? g : r.s;
}

// ---------------------------------------------------------------------------
// THE BRANCHES. Each is one sentence about a morning in year three.
// ---------------------------------------------------------------------------
const ARMS = {
  base:  { label: "carried on as usual" },
  penny: { label: "found a dollar on the pavement", penny: true },
  buy:   { label: "took the deal on the table that morning", forceBuy: true },
  pass:  { label: "let the next deal go by", skipNext: 1 },
  lever: { label: "started using debt at 80%", ltv: 0.80, ltvFrom: FORK_M },
  hoard: { label: "stopped buying for good, kept what they had", freezeUntil: 1e9 },
};

// STRETCHING FOR IT. The branch spends the cushion, not the imagination: it
// works down the tape by discount and takes the best one it can actually fund.
// The first version reached for the keenest price on the board, which needed
// $2.7M of equity against $1.8M of cash, and quietly bought nothing at all —
// a counterfactual that never happened, reported as a counterfactual that
// changed nothing.
function forceOneBuy(g, parcels) {
  const tape = [];
  for (const li of g.listings) {
    const rec = E.resolveRec(parcels, g, li.bbl);
    if (!rec || g.holdings[li.bbl] || rec.class === "land" || !rec.bldgArea) continue;
    const worth = E.assetValue(rec, g.econ, E.initialCondition(rec));
    if (!Number.isFinite(worth) || worth <= 0) continue;
    tape.push({ bbl: li.bbl, ask: li.ask, disc: li.ask / worth, rec });
  }
  tape.sort((a, b) => a.disc - b.disc);
  for (const t of tape) {
    const r = E.executePurchase(g, parcels, t.bbl, t.ask, "senior", false, BASE_LTV / 0.65);
    if (r.err) continue;
    return { g: r.s, took: { bbl: t.bbl, ask: t.ask, disc: +t.disc.toFixed(3), cls: t.rec.class, sf: t.rec.bldgArea, addr: t.rec.address } };
  }
  return { g, took: null };
}

// A compact fingerprint of the whole city, so two centuries can be compared
// month by month without keeping two centuries in memory.
function pulse(g, parcels) {
  const e = g.econ;
  return {
    rentO: e.rentIdx.office, rentR: e.rentIdx.retail, rentM: e.rentIdx.multifamily,
    vacO: e.cityVac.office, vacM: e.cityVac.multifamily,
    stock: USES.reduce((a, u) => a + e.stock[u], 0),
    pop: e.population, jobs: e.jobs, cap: e.capRate.office, rate: e.indexRate,
    nw: E.netWorth(g, parcels), cash: g.cash, holds: Object.keys(g.holdings).length,
  };
}

function runArm(prefixG, prefixP, armName) {
  const arm = ARMS[armName];
  const parcels = clone(prefixP);
  let g = clone(prefixG);
  let took = null;

  if (arm.penny) g.cash += 1;
  if (arm.forceBuy) { const r = forceOneBuy(g, parcels); g = r.g; took = r.took; }

  const series = [];
  const marks = {};
  const st = { skipsLeft: arm.skipNext ?? 0, skipped: null };
  for (let m = FORK_M; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, BASE.bbls, BASE.adjacency);
    g = lease(g, parcels);
    g = buyRound(g, parcels, m, arm, st);
    if (m % 3 === 0) series.push([m, pulse(g, parcels)]);
    if ([300, 600, 900, MONTHS - 1].includes(m)) marks[Math.round((m + 1) / 12)] = pulse(g, parcels);
    if (g.gameOver) { marks.dead = m; break; }
  }
  const e = g.econ;
  return {
    arm: armName, label: arm.label, took, skipped: st.skipped, marks,
    end: {
      ...pulse(g, parcels),
      demolished: g.demolished ?? 0, cityBuilt: (g.cityBuilt ?? []).length,
      firmsAlive: (g.rivals ?? []).filter((r) => r.failedM === undefined && !r.dead).length,
      landIdx: e.landIdx, costIdx: e.costIdx, cpi: e.cpi,
      gameOver: g.gameOver ? String(g.gameOver).slice(0, 120) : null,
    },
    series,
  };
}

// ---------------------------------------------------------------------------
const MARKET_SEEDS = [550991, 12007, 73303, 11, 22];
const N = Number(process.env.SEEDS ?? MARKET_SEEDS.length);
const out = [];
const t0 = Date.now();

for (const seed of MARKET_SEEDS.slice(0, N)) {
  // The shared past. Identical for every branch, by construction.
  const parcels = clone(BASE.parcels);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, BASE.bbls);
  for (let m = 0; m < FORK_M; m++) {
    g = E.advanceQuarter(g, parcels, BASE.bbls, BASE.adjacency);
    g = lease(g, parcels);
    g = buyRound(g, parcels, m, ARMS.base);
  }
  const at = pulse(g, parcels);
  console.log(`\nseed ${seed} — fork at month ${FORK_M}: NW ${(at.nw / 1e6).toFixed(2)}M, ${at.holds} buildings, cash ${(at.cash / 1e6).toFixed(2)}M`);

  const arms = [];
  for (const a of Object.keys(ARMS)) {
    const s = Date.now();
    const r = runArm(g, parcels, a);
    arms.push(r);
    console.log(`  ${a.padEnd(6)} ${r.label.padEnd(42)} yr100 NW ${(r.end.nw / 1e6).toFixed(1).padStart(8)}M  ` +
      `rentO ${r.end.rentO.toFixed(1).padStart(6)}  stock ${(r.end.stock / 1e6).toFixed(1)}M  pop ${Math.round(r.end.pop / 1000)}k` +
      `${r.end.gameOver ? "  [BUST]" : ""}  ${((Date.now() - s) / 1000).toFixed(0)}s`);
  }
  out.push({ seed, forkM: FORK_M, at, arms });
  writeFileSync(join(OUT, "forks.json"), JSON.stringify(out));
}
console.log(`\n${out.length} seeds x ${Object.keys(ARMS).length} branches in ${((Date.now() - t0) / 60000).toFixed(1)} min -> ${join(OUT, "forks.json")}`);
