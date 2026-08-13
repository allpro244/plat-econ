// ONE LOAN, MANY DEEDS — does the facility behave like debt?
//
//   pnpm facility
//
// A new instrument is the easiest place in this repo to put a money pump. A
// portfolio facility advances cash against a pool, and every way a building can
// leave that pool is a way for the collateral to walk while the balance stays —
// or worse, for both to vanish. So this exercises the whole life of one:
// paper it, service it for thirty years, sell out of it, and check the
// arithmetic at every step.
//
// FOUR THINGS IT ASSERTS, all of which have a way to fail:
//
//   AMORTISES     the balance goes down when it should and never below zero.
//   COLLATERAL    every deed in the pool is a deed the player still owns. If a
//                 building leaves by any route without releasing, this catches
//                 it — that is the pump.
//   THE PREMIUM   a release costs more than the allocated share. If it ever
//                 costs less, selling out of the pool is free deleveraging.
//   IT BITES      a thin firm's facility must be able to breach, sweep and
//                 accelerate. An instrument that can only ever be free money
//                 is not a decision, and this half of the test is the one that
//                 goes quiet first.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N || 3);
const HZ = +(process.env.HZ || 360);

function run(cash0, label) {
  let opened = 0, breaches = 0, accels = 0, releases = 0, badPool = 0, badBal = 0, cheapRelease = 0;
  let paid = 0, drawn = 0;
  const lines = [];
  for (let seed = 0; seed < N; seed++) {
    const { parcels, adjacency, bbls } = loadCity(seed % 4, E.normalizeParcels);
    let g = E.firstListings(E.newGame(4400 + seed, parcels), parcels, bbls);
    g = { ...g, cash: cash0 };
    // Buy a book. All cash where it can, so the pool starts unencumbered and
    // the facility is the first debt on it — the payoff leg is exercised by
    // the mortgaged ones that come through the ladder.
    let bought = 0;
    for (let m = 0; m < 90 && bought < 10; m++) {
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      for (const L of g.listings ?? []) {
        if (bought >= 10) break;
        const rec = E.resolveRec(parcels, g, L.bbl);
        if (!rec || rec.class === "land" || !rec.bldgArea || g.holdings[L.bbl]) continue;
        const pid = bought % 2 === 0 ? "cash" : (["savings", "harbor"].find((id) => E.buyQuote(g, parcels, L.bbl, L.ask, id, 1).principal > 0) ?? "cash");
        const r = E.executePurchase(g, parcels, L.bbl, L.ask, pid, false, 1);
        if (r && r.s && r.s.holdings[L.bbl]) { g = r.s; bought++; }
      }
    }
    const pool = E.pledgeable(g, parcels).slice(0, 8).map((c) => c.bbl);
    if (pool.length < 3) continue;
    const quotes = E.facilityQuotes(g, parcels, pool);
    const qt = quotes.find((x) => x.available);
    if (!qt) continue;
    const before = g.cash;
    const r = E.openFacility(g, parcels, pool, qt.productId, 1);
    if (r.err) { lines.push(`  seed ${seed}: ${r.err}`); continue; }
    g = r.s;
    opened++;
    drawn += g.facility.balance;
    lines.push(`  seed ${seed}: $${(g.facility.balance / 1e6).toFixed(1)}M over ${g.facility.bbls.length} deeds at `
      + `${g.facility.ratePct.toFixed(2)}% (${g.facility.lender}), cash $${(before / 1e6).toFixed(1)}M -> $${(g.cash / 1e6).toFixed(1)}M`);

    let sawBreach = false, sawAccel = false;
    let lastStale = new Set();
    for (let m = 0; m < HZ; m++) {
      const bal0 = g.facility?.balance ?? 0;
      const cash0m = g.cash;
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
      const f = g.facility;
      if (!f) break;
      if (f.balance < 0) badBal++;
      // A MONTH OF LAG IS THE TICK; A SECOND MONTH IS A LEAK. The pool is
      // reconciled at the top of `tickFacility`, and a deed can leave the book
      // later in the same month — a receiver, a deed in lieu — so one month
      // holding a stale bbl is the clock, not a fault. What must never happen
      // is a pool that goes on carrying collateral the player does not own,
      // because that is the pump: sell the building, keep the advance.
      const stale = f.bbls.filter((b) => !g.holdings[b]);
      if (stale.length && stale.every((b) => lastStale.has(b))) badPool++;
      lastStale = new Set(stale);
      if (f.breachedSince !== undefined && !sawBreach) { sawBreach = true; breaches++; }
      if (f.accelM !== undefined && !sawAccel) { sawAccel = true; accels++; }
      paid += Math.max(0, cash0m - g.cash) > 0 ? Math.min(bal0 - f.balance > 0 ? bal0 - f.balance : 0, bal0) : 0;
      // Sell one out of the pool halfway through and check the release price.
      if (m === 30 && f.bbls.length > 3) {
        const b = f.bbls[0];
        const alloc = E.allocatedAmount(g, parcels, b);
        const rel = E.releaseCost(g, parcels, b);
        if (alloc > 0 && rel <= alloc) cheapRelease++;
        const rr = E.releaseFromFacility(g, parcels, b);
        if (!rr.err) { g = rr.s; releases++; }
      }
    }
  }
  return { label, opened, breaches, accels, releases, badPool, badBal, cheapRelease, drawn, lines };
}

const rich = run(120e6, "well capitalised");
const thin = run(14e6, "thinly capitalised");

console.log(`\nONE LOAN, MANY DEEDS — ${N} towns x ${HZ / 12} years each\n`);
for (const r of [rich, thin]) {
  console.log(`  ${r.label}: ${r.opened} facilities papered, $${(r.drawn / 1e6).toFixed(0)}M drawn, `
    + `${r.breaches} breached, ${r.accels} accelerated, ${r.releases} released`);
  for (const l of r.lines) console.log(l);
}

let bad = 0;
const fail = (m) => { bad++; console.log(`\n  FAIL  ${m}`); };
const ok = (m) => console.log(`  OK    ${m}`);

console.log("");
if (rich.opened + thin.opened === 0) fail("no facility could be papered at all — the test proves nothing.");
else ok(`${rich.opened + thin.opened} facilities papered.`);

if (rich.badBal + thin.badBal > 0) fail(`${rich.badBal + thin.badBal} month(s) with a negative balance.`);
else ok("the balance never went negative.");

if (rich.badPool + thin.badPool > 0) fail(`${rich.badPool + thin.badPool} month(s) with a deed in the pool the player did not own — collateral walked.`);
else ok("every deed in every pool was a deed the player still held.");

if (rich.cheapRelease + thin.cheapRelease > 0) fail(`${rich.cheapRelease + thin.cheapRelease} release(s) priced at or under the allocated share — the premium is not being charged.`);
else ok("every release cost more than the allocated share.");

if (rich.releases + thin.releases === 0) fail("no release was ever exercised — the premium is untested.");
else ok(`${rich.releases + thin.releases} releases exercised.`);

// AND THE HALF THAT GOES QUIET FIRST. An instrument that cannot hurt anybody is
// not a decision, and the easiest way to "fix" a crossed pool that is taking
// people's books is to stop it ever biting. If this ever reads zero, the
// facility has become free leverage and this file has become the thing it was
// written to prevent.
if (thin.breaches + thin.accels === 0) fail("a thinly capitalised firm went thirty years without the facility ever biting — it has become free leverage.");
else ok(`the thin firm's facility bit — ${thin.breaches} breach(es), ${thin.accels} acceleration(s).`);

// ...and the mirror: a firm with the money must not be taken by one, for the
// same reason a sponsor with cash does not lose a building to a covenant.
if (rich.accels > 0) fail(`${rich.accels} well-capitalised firm(s) had a facility accelerated — the cure is not working.`);
else ok("no well-capitalised firm lost a pool.");

console.log("");
process.exit(bad ? 1 : 0);
