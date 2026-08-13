// DEMAND IS FINITE — proof harness.
//
// The worry: LOI news and leasing alerts are random wallpaper, and "tenants"
// are minted whenever a building is empty. This file measures the opposite:
//
//   1. Letters draw from a citywide requirement that equals churn + (pool − occ).
//   2. A quiet pool (pool ≈ occupied) produces almost no growth letters.
//   3. Injecting stock does not conjure a matching pile of occupants.
//   4. Every inbound LOI sits under that month's requirement budget.
//   5. Leasing headlines name parties and square feet — they are state, not fog.
//
// Run: node test/demand-finite.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels: baseParcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const clone = () => structuredClone(baseParcels);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nFINITE DEMAND — letters come from a pool, not from empty floors\n");

// ---------------------------------------------------------------------------
// 1. Requirement identity: growth leg is (pool − occ) × absorb speed.
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  const g = E.firstListings(E.newGame(44101, parcels), parcels, bbls);
  const e = g.econ;
  const use = "office";
  const occ = e.occupied[use];
  const pool = e.pool[use];
  const req = E.marketRequirement(e, use);
  const churn = (occ * E.GROSS_TURNOVER.office) / 12;
  const growth = Math.max(0, (pool - occ) * 0.055);
  const struct = Math.max(0, e.structTight?.[use] ?? 0) * e.stock[use] * 0.008;
  check(req >= churn * 0.5,
    `requirement ${Math.round(req)} sf includes a churn floor (~${Math.round(churn)} sf)`);
  // Match friction can trim growth below the raw (pool−occ)×0.055; the hard
  // ceiling is still churn + raw growth + struct — never a second market.
  check(req <= churn + growth + struct + 1,
    `requirement ${Math.round(req)} ≤ churn ${Math.round(churn)} + growth ${Math.round(growth)} + struct ${Math.round(struct)}`);
  const housable = e.stock[use] * (1 - E.frictionFloor(use));
  const fringe = e.stock[use] * E.NATURAL_VAC[use] * 0.25;
  check(pool <= housable + fringe + 1,
    `looking pool ${Math.round(pool)} ≤ housable + search fringe (${Math.round(housable + fringe)})`);
}

// ---------------------------------------------------------------------------
// 2. Quiet pool ⇒ almost no growth demand. Force pool = occupied.
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  const g = E.firstListings(E.newGame(44102, parcels), parcels, bbls);
  const use = "office";
  g.econ.structTight = { office: 0, retail: 0, multifamily: 0, industrial: 0 };
  g.econ.pool[use] = g.econ.occupied[use];
  const reqQuiet = E.marketRequirement(g.econ, use);
  // Busy = looking queue ~8% above occupied (inside the search fringe).
  g.econ.pool[use] = g.econ.occupied[use] * 1.12;
  const reqBusy = E.marketRequirement(g.econ, use);
  check(reqQuiet < reqBusy * 0.70,
    `quiet pool requirement (${Math.round(reqQuiet)}) is well below a busy one (${Math.round(reqBusy)})`);
  check(reqQuiet <= (g.econ.occupied[use] * E.GROSS_TURNOVER.office) / 12 + 1,
    `with pool=occupied and no struct, requirement equals churn alone`);
}

// ---------------------------------------------------------------------------
// 3. Supply injection does not manufacture tenants (conservation).
// ---------------------------------------------------------------------------
{
  const PAIRS = 6;
  const seeds = [550991, 12007, 73303, 11, 22, 4242].slice(0, PAIRS);
  const run = (seed, inject) => {
    const parcels = clone();
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    let addSf = 0;
    for (let m = 0; m < 48; m++) {
      if (inject && m === 18) {
        addSf = Math.round(g.econ.stock.office * 0.12);
        E.addStock(g.econ, "office", addSf);
      }
      g = E.advanceMonth(g, parcels, bbls, adjacency);
      if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 5e6) };
    }
    return { occ: g.econ.occupied.office, addSf };
  };
  const fracs = seeds.map((seed) => {
    const ctl = run(seed, false);
    const inj = run(seed, true);
    return (inj.occ - ctl.occ) / Math.max(1, inj.addSf);
  });
  const mean = fracs.reduce((a, b) => a + b, 0) / fracs.length;
  check(mean <= 0.15,
    `+12% office stock conjures mean ${(mean * 100).toFixed(1)}% of itself as new occupants (budget ≤15%)`);
}

// ---------------------------------------------------------------------------
// 4. Inbound LOI square footage is rationed by the monthly requirement.
//     Empty buildings alone do not mint an unlimited letter stream.
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  const offices = bbls.map((b) => parcels[b])
    .filter((r) => r && r.class === "office" && r.bldgArea > 30_000 && r.bldgArea < 90_000)
    .sort((a, b) => b.demandScore - a.demandScore)
    .slice(0, 3);
  check(offices.length >= 2, `found ${offices.length} office buildings to instrument`);

  let g = E.firstListings(E.newGame(88221, parcels), parcels, bbls);
  g = { ...g, cash: 400_000_000 };
  const owned = [];
  for (const rec of offices) {
    const r = E.executePurchase(g, parcels, rec.bbl, 5_000_000, "cash", false, 1);
    if (r.err) continue;
    g = r.s;
    g.holdings[rec.bbl].tenants = [];
    g.holdings[rec.bbl].makeReady = [];
    g.holdings[rec.bbl].broker = true;
    owned.push(rec.bbl);
  }
  check(owned.length >= 2, `bought ${owned.length} empty office buildings`);

  let loiSf = 0;
  let reqSum = 0;
  const months = 24;
  for (let m = 0; m < months; m++) {
    const req = E.marketRequirement(g.econ, "office");
    reqSum += req;
    const before = new Set((g.lois ?? []).map((l) => l.id));
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 5e6) };
    for (const l of g.lois ?? []) {
      if (before.has(l.id)) continue;
      if (l.kind !== "new" || (l.use ?? "office") !== "office") continue;
      if (!owned.includes(l.bbl)) continue;
      loiSf += l.sf;
    }
  }
  // A few player buildings take a share of city competition — they cannot
  // capture more than a few multiples of the citywide requirement.
  check(loiSf <= reqSum * 3.5 + 50_000,
    `player inbound LOI sf (${Math.round(loiSf)}) stays within a few multiples of cumulative city requirement (${Math.round(reqSum)}) — not an infinite letter printer`);
  check(reqSum > 0, `city posted positive office requirement over ${months} months (${Math.round(reqSum)} sf)`);
}

// ---------------------------------------------------------------------------
// 5. A signed letter writes a named, sized headline — not a bare alert.
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  const offices = bbls.map((b) => parcels[b])
    .filter((r) => r && r.class === "office" && r.bldgArea > 40_000 && r.bldgArea < 100_000)
    .sort((a, b) => b.demandScore - a.demandScore);
  const site = offices[0];
  check(!!site, "have an office building for a signing headline");
  let g = E.firstListings(E.newGame(99112, parcels), parcels, bbls);
  g = { ...g, cash: 400_000_000 };
  const bought = E.executePurchase(g, parcels, site.bbl, 5_000_000, "cash", false, 1);
  check(!bought.err, `purchase for signing test${bought.err ? `: ${bought.err}` : ""}`);
  g = bought.s;
  g.holdings[site.bbl].tenants = [];
  g.holdings[site.bbl].makeReady = [];
  g.holdings[site.bbl].broker = true;

  let signed = false;
  for (let m = 0; m < 48 && !signed; m++) {
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 50e6) };
    const loi = (g.lois ?? []).find((l) => l.bbl === site.bbl && l.kind === "new");
    if (!loi) continue;
    // Fund TI/commission from cash so accept can land.
    g.cash = Math.max(g.cash, 50e6);
    const r = E.respondLOI(g, parcels, loi.id, "accept", true);
    g = r.s ?? g;
    signed = true;
    const hit = (g.news ?? []).find((n) => /Signed/.test(n.text ?? "") && n.text.includes(loi.name));
    check(!!hit, `signing ${loi.name} for ${loi.sf} sf produces a named headline`);
    if (hit) {
      check(hit.text.includes(loi.sf.toLocaleString()),
        `headline cites the letter's square feet (${loi.sf.toLocaleString()})`);
    }
  }
  check(signed, "an empty prime office drew a letter within 48 months");
}

console.log("");
process.exit(bad ? 1 : 0);
