// THE FOUR ECONOMY ACCEPTANCE TESTS.
//
// The owner's mandate, verbatim: "THE ECONOMY IS THE GAME, AND RIGHT NOW IT'S
// FAKE." These four tests are the permanent, headless statement of what a real
// market means here. They were written to FAIL against the engine as it stood
// on 2026-08-03, to prove the diagnosis; after the rebuild they are the
// regression suite that keeps it fixed. Run: node test/econ-accept.mjs
// (rebuilds nothing — bundle first like every other harness).
//
//   A. LOCATION SPREAD — identical buildings on the best and worst viable
//      blocks must stabilise ~2-3x apart in rent, with the bad location
//      materially emptier, slower.
//   B. SUPPLY SHOCK — dropping ~10% of a use's citywide stock in one place
//      must spike vacancy, cut effective rents 10-25%, take YEARS to lease,
//      and visibly wound the buildings around it.
//   C. CYCLE — across a recession, market rents for cyclical uses must
//      actually decline, not plateau.
//   D. CONSERVATION — occupied SF is tenants, and tenants are finite. Adding
//      buildings must not add occupied SF beyond a small induced factor.
//      If building space manufactures tenants, everything else is cosmetic.
//
// EVERY BAND IN THIS FILE IS NOW REPORTED RATHER THAN GATED — owner's
// decision, 2026-08-06. The arithmetic is untouched; see test/accept-lib.mjs
// for what that means and why, and ECONOMY.md for who decided it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSuite } from "./accept-lib.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const clone = () => JSON.parse(JSON.stringify(P0));
const { report, verdict } = makeSuite();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];

// Answer every letter at asking — the least-skilled landlord there is, so the
// numbers measure the MARKET, not the bot.
function acceptAll(g, parcels) {
  for (const l of [...g.lois]) {
    if (!g.lois.find((x) => x.id === l.id)) continue;
    const r = E.respondLOI(g, parcels, l.id, "accept", true);
    if (!r.err) g = r.s;
  }
  return g;
}
const rollOf = (g, bbl) => {
  const h = g.holdings[bbl];
  if (!h) return { sf: 0, rent: 0 };
  let sf = 0, wr = 0;
  for (const t of h.tenants) { sf += t.sf; wr += t.sf * t.rentPsf; }
  return { sf, rent: sf > 0 ? wr / sf : 0 };
};

// ---------------------------------------------------------------------------
// A. LOCATION SPREAD
// ---------------------------------------------------------------------------
// MEDIAN OF THREE SEEDS. This test flipped from pass to fail on IDENTICAL
// mechanics when an unrelated change reshuffled the RNG stream — a snapshot
// of two specific buildings on one specific seed is weather, not climate. The
// clauses now assert on the median across three seeds, so a single lucky or
// unlucky draw can neither pass a broken market nor fail a working one.
{
  const runs = [];
  let loD = 0, hiD = 0;
  for (const seed of [910117, 411133, 87019]) {
    const parcels = clone();
    // two identical office buildings, cloned onto the best and worst viable
    // office blocks in town — same plate, same area, same floors, same year
    const offices = bbls.map((b) => parcels[b])
      .filter((r) => r && r.class === "office" && r.bldgArea > 30000 && r.bldgArea < 90000)
      .sort((a, b) => a.demandScore - b.demandScore);
    const lo = offices[0], hi = offices[offices.length - 1];
    loD = lo.demandScore; hiD = hi.demandScore;
    const TPL = { bldgArea: 60000, floors: 8, yearBuilt: 1988, unitsRes: 0 };
    for (const r of [lo, hi]) Object.assign(parcels[r.bbl], TPL, { lotArea: 9000 });
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    g = { ...g, cash: 400_000_000 };
    for (const bbl of [lo.bbl, hi.bbl]) {
      const r = E.executePurchase(g, parcels, bbl, 5_000_000, "cash", false, 1);
      if (r.err) { console.log("A: buy failed", bbl, r.err); process.exit(2); }
      g = r.s;
      g.holdings[bbl].tenants = [];
      g.holdings[bbl].makeReady = [];
      g.holdings[bbl].broker = true;
    }
    const MO = 144;
    const to80 = { [lo.bbl]: null, [hi.bbl]: null };
    for (let m = 0; m < MO; m++) {
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      g = acceptAll(g, parcels);
      for (const bbl of [lo.bbl, hi.bbl]) {
        if (to80[bbl] === null && rollOf(g, bbl).sf >= 0.8 * 60000) to80[bbl] = m + 1;
      }
    }
    const L = rollOf(g, lo.bbl), H = rollOf(g, hi.bbl);
    runs.push({
      spread: L.rent > 0 ? H.rent / L.rent : Infinity,
      gap: H.sf / 60000 - L.sf / 60000,
      occL: L.sf / 60000, occH: H.sf / 60000,
      loTo80: to80[lo.bbl], hiTo80: to80[hi.bbl],
    });
  }
  const spread = med(runs.map((r) => r.spread));
  const gap = med(runs.map((r) => r.gap));
  report("A. LOCATION SPREAD (median of 3 seeds)", spread >= 2.0 && gap >= 0.08,
    [`demand ${loD} vs ${hiD} (same 60k sf, 8 fl, 1988 building)`,
     `achieved rent spread per seed: ${runs.map((r) => r.spread.toFixed(2) + "x").join("  ")}   median ${spread.toFixed(2)}x   (need >= 2.0x)`,
     `occupancy gap at yr 12 per seed: ${runs.map((r) => ((r.gap) * 100).toFixed(0) + "pp").join("  ")}   median ${(gap * 100).toFixed(0)}pp   (need >= 8pp)`,
     `worst-location occupancy per seed: ${runs.map((r) => (r.occL * 100).toFixed(0) + "%").join("  ")}   best: ${runs.map((r) => (r.occH * 100).toFixed(0) + "%").join("  ")}`,
     `months to 80%, worst location: ${runs.map((r) => r.loTo80 ?? ">144").join("  ")}   best: ${runs.map((r) => r.hiTo80 ?? ">144").join("  ")}`]);
}

// ---------------------------------------------------------------------------
// B. SUPPLY SHOCK
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  let g = E.firstListings(E.newGame(424243, parcels), parcels, bbls);
  g = { ...g, cash: 2_000_000_000 };
  const PRE = 24, POST = 120;
  for (let m = 0; m < PRE; m++) g = E.advanceQuarter(g, parcels, bbls, adjacency);
  const stock0 = g.econ.stock.office;
  const vac0 = g.econ.cityVac.office;
  const rent0 = g.econ.rentIdx.office;
  // the shock: one delivery equal to 10% of citywide office stock, placed on a
  // real mid-town lot — injected as a finished building with an empty roll
  const site = bbls.map((b) => parcels[b])
    .filter((r) => r && r.class === "land" && r.lotArea > 8000)
    .sort((a, b) => b.demandScore - a.demandScore)[2];
  const addSf = Math.round(stock0 * 0.10);
  const buy = E.executePurchase(g, parcels, site.bbl, 2_000_000, "cash", false, 1);
  if (buy.err) { console.log("B: land buy failed", buy.err); process.exit(2); }
  g = buy.s;
  g.built[site.bbl] = { class: "office", mix: { office: 1 }, bldgArea: addSf, floors: 20, yearBuilt: 2002 };
  g.holdings[site.bbl].tenants = [];
  g.holdings[site.bbl].broker = true;
  E.addStock(g.econ, "office", addSf);
  // occupancy of the standing office stock around it, before
  const nbhood = bbls.map((b) => E.resolveRec(parcels, g, b))
    .filter((r) => r && r.class === "office" && r.bbl !== site.bbl && r.bldgArea > 10000);
  const occBefore = nbhood.reduce((a, r) => a + E.occupancy(r, g.econ) * r.bldgArea, 0)
    / Math.max(1, nbhood.reduce((a, r) => a + r.bldgArea, 0));
  // THE COUNTERFACTUAL. This clause used to measure the rent trough against
  // the rent on the day of the shock — which was fine while rents had no
  // trend, and became meaningless the moment they gained one. Rents now grow
  // with the nominal wages that pay them (~3.4%/yr), so a shock can knock
  // 15% off where rents WOULD have been without ever pushing them below where
  // they started. What a supply shock does is depress rents relative to the
  // path the market would otherwise have taken, so that is what we measure:
  // the same seed, the same everything, without the building.
  const ctlPath = (() => {
    const cp = clone();
    let cg = E.firstListings(E.newGame(424243, cp), cp, bbls);
    cg = { ...cg, cash: 2_000_000_000 };
    for (let m = 0; m < PRE; m++) cg = E.advanceQuarter(cg, cp, bbls, adjacency);
    const out = [];
    for (let m = 0; m < POST; m++) {
      cg = E.advanceQuarter(cg, cp, bbls, adjacency);
      cg = acceptAll(cg, cp);
      out.push(cg.econ.rentIdx.office);
    }
    return out;
  })();
  let vacPeak = vac0, rentTrough = rent0, to80 = null, occAfter = occBefore;
  let worstGap = 0;
  for (let m = 0; m < POST; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    g = acceptAll(g, parcels);
    vacPeak = Math.max(vacPeak, g.econ.cityVac.office);
    rentTrough = Math.min(rentTrough, g.econ.rentIdx.office);
    worstGap = Math.max(worstGap, 1 - g.econ.rentIdx.office / Math.max(1, ctlPath[m]));
    if (to80 === null && rollOf(g, site.bbl).sf >= 0.8 * addSf) to80 = m + 1;
    // the WOUND is the trough, not the end state — over a ten-year window the
    // market is allowed (expected, even) to heal; it is not allowed to never bleed
    const occNow = nbhood.reduce((a, r) => a + E.occupancy(r, g.econ) * r.bldgArea, 0)
      / Math.max(1, nbhood.reduce((a, r) => a + r.bldgArea, 0));
    occAfter = Math.min(occAfter, occNow);
  }
  const rentCut = worstGap;
  // TWO CLAUSES CAME OUT OF THIS TEST ON 2026-08-06, BOTH FOR THE SAME REASON:
  // NEITHER COULD FAIL. CLAUDE.md's rule, applied to the file that enforces it.
  //
  // 1. `to80 <= 120` WAS A TAUTOLOGY. The lease-up clock is only ever set
  //    inside the POST loop, which runs m = 0..119 and assigns `m + 1`, so
  //    `to80` is drawn from [1, 120] by construction and the upper bound is
  //    the horizon restating itself. Everything it was meant to say — a
  //    building that never leases fails a queue test — is already carried by
  //    `to80 !== null`, which is the honest way to write "not inside ten
  //    years". The bound is gone and the horizon is named in the print.
  //
  // 2. THE NEIGHBOURS CLAUSE WAS THE VACANCY CLAUSE, TIMES 0.713. `occBefore`
  //    and `occAfter` are `E.occupancy` summed over a set of building records
  //    captured ONCE before the shock, so nothing varies between the two reads
  //    except `econ` — and `useOccupancy` touches econ through exactly one
  //    term, `(NATURAL_VAC - cityVac) * 0.85`, plus the vintage renormaliser.
  //    That is an affine map. Measured, holding the same 183 buildings and
  //    sweeping citywide office vacancy from 12.6% to 45%:
  //
  //        vacancy   12.6%  15.0%  17.0%  20.0%  24.0%  30.0%  40.0%  45.0%
  //        occupancy 78.16  76.42  74.99  72.85  70.00  65.72  58.64  55.18
  //        dOcc/dVac   —    0.713  0.713  0.713  0.713  0.713  0.711  0.708
  //
  //    A constant to three figures across the whole reachable range. So the
  //    clause `occBefore - occAfter >= 0.03` binds at 3.00 / 0.713 = 4.21pp of
  //    vacancy, and the clause above it already demands 5.00pp — and because
  //    occupancy is monotone decreasing in vacancy, the occupancy trough falls
  //    on exactly the month of the vacancy peak. Clause 1 is strictly stronger
  //    than clause 5 at every point. Clause 5 could not fail while clause 1
  //    passed; it was the same measurement wearing a second name, which is
  //    CLAUDE.md's third kind of fake.
  //
  //    It is still PRINTED, because what it shows is worth seeing — the wire
  //    from the citywide market to a single roll is the thing that took years
  //    to exist at all. It is no longer asserted, because an assertion that
  //    restates another assertion is decoration.
  //
  //    (One live caveat for whoever changes that wire: cityVac is clamped to
  //    0.45 in market.ts, so above 45% vacancy this metric stops moving. No
  //    clause here reaches it — the peak measured is 23.9% — but a future
  //    test that asks about a deeper glut would be reading the rail.)
  const implied = (occBefore - occAfter) / Math.max(1e-9, vacPeak - vac0);
  report("B. SUPPLY SHOCK (+10% of office stock in one building)",
    (vacPeak - vac0) >= 0.05 && rentCut >= 0.10 && to80 !== null && to80 >= 24,
    [`stock ${(stock0 / 1e6).toFixed(2)}M sf  + ${(addSf / 1e6).toFixed(2)}M sf delivered empty at demand ${site.demandScore}`,
     `citywide office vacancy ${(vac0 * 100).toFixed(1)}% -> peak ${(vacPeak * 100).toFixed(1)}%   (need +5pp)`,
     `office rents vs the same city WITHOUT the building: ${(rentCut * 100).toFixed(1)}% below the counterfactual at the worst   (need >= 10%)`,
     `   (nominal path ${rent0.toFixed(0)} -> trough ${rentTrough.toFixed(0)}; rents carry a wage-driven trend now, so the counterfactual is the only honest measure)`,
     `new building to 80% let: ${to80 === null ? "never, inside the " + POST + "-month window" : to80 + " months"}   (need >= 24 and inside the window: years, not forever)`,
     `standing office stock occupancy ${(occBefore * 100).toFixed(1)}% -> trough ${(occAfter * 100).toFixed(1)}%`,
     `   = ${implied.toFixed(3)} x the vacancy move. NOT A CLAUSE — it is the vacancy line above through an affine wire; see the note in this file.`]);
}

// ---------------------------------------------------------------------------
// C. CYCLE
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  let g = E.firstListings(E.newGame(550991, parcels), parcels, bbls);
  const rents = [], phases = [];
  for (let m = 0; m < 600; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // KEEP THE OBSERVER ALIVE. advanceQuarter returns the state UNCHANGED once
    // gameOver is set, and a firm that does nothing for fifty years still pays
    // its G&A out of $6M — this seed dies at month 506, so ninety-four of the
    // six hundred months counted here were the same frozen index repeated, and
    // both the drawdown and the recession count were reading it. See the note
    // on keepAlive in sim-accept.mjs, where four of seven seeds had it.
    g.cash = 50_000_000; g.insolventMs = 0; g.gameOver = null;
    rents.push(g.econ.rentIdx.office);
    phases.push(g.econ.phase);
  }
  // worst peak-to-trough drawdown, and the same measured only inside
  // recession windows (entering 6 months early, leaving 12 late)
  let peak = -Infinity, dd = 0;
  for (const r of rents) { peak = Math.max(peak, r); dd = Math.max(dd, 1 - r / peak); }
  let recDd = 0;
  for (let i = 0; i < rents.length; i++) {
    if (phases[i] !== "recession") continue;
    const j0 = Math.max(0, i - 6), j1 = Math.min(rents.length - 1, i + 12);
    const localPeak = Math.max(...rents.slice(j0, i + 1));
    const localTrough = Math.min(...rents.slice(i, j1 + 1));
    recDd = Math.max(recDd, 1 - localTrough / localPeak);
  }
  const recMonths = phases.filter((p) => p === "recession").length;
  report("C. CYCLE (50 years, office rent index)",
    recDd >= 0.05,
    [`recession months: ${recMonths} of 600`,
     `worst drawdown anywhere: ${(dd * 100).toFixed(1)}%`,
     `worst drawdown across a recession window: ${(recDd * 100).toFixed(1)}%   (need >= 5% — rents must actually FALL)`,
     `rent index start ${rents[0].toFixed(2)} end ${rents[rents.length - 1].toFixed(2)} (${(rents[rents.length - 1] / rents[0]).toFixed(2)}x over 50y)`]);
}

// ---------------------------------------------------------------------------
// D. CONSERVATION
// ---------------------------------------------------------------------------
{
  // paired runs, same seed: one gets +12% office stock injected at month 24,
  // the control does not. If tenants are conserved, the injected run's OCCUPIED
  // sf may exceed the control's only by a small induced-demand factor.
  //
  // THE MEAN OF TWELVE SEED-PAIRS, AND THE BUDGET IS UNCHANGED AT 15%.
  //
  // This took the median of THREE. The metric is a small difference of two
  // large numbers and the injection forks the RNG stream at month 24, so the
  // per-pair value is enormously dispersed — the note that used to be here
  // said "-34% to +20%" and undersold it. Measured over fifteen pairs on a
  // mechanically unchanged build: mean 3.7%, sd 21.9pp, range -53.9% to
  // +44.1%. The model conserves tenants comfortably. But a MEDIAN OF THREE
  // drawn from that distribution reads over the 15% budget 24% of the time —
  // so this gate failed roughly one run in four no matter what the engine did,
  // and it did exactly that at a merge, costing an afternoon proving the model
  // had not moved. Both trees measured: -2.5% before, +3.7% after.
  //
  // A test that fails at random tells you as little as one that cannot fail.
  // The fix is the estimator, not the threshold: induced demand is an
  // EXPECTATION, so take the mean, and take enough pairs that its standard
  // error is small against the thing it is compared to. At n=12 the SE is
  // about 6pp against a 15pp budget on a true value near 4.
  const PAIRS = Number(process.env.CONSERVE_PAIRS ?? 12);
  const run = (seed, inject) => {
    const parcels = clone();
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    let addSf = 0;
    for (let m = 0; m < 60; m++) {
      if (inject && m === 24) {
        addSf = Math.round(g.econ.stock.office * 0.12);
        E.addStock(g.econ, "office", addSf);
      }
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
    }
    return { occ: g.econ.occupied.office, stock: g.econ.stock.office, addSf };
  };
  const SEEDS_D = [133713, 51423, 900871, 550991, 12007, 73303, 11, 22, 4242,
    90210, 313, 777, 2468, 60613, 10001, 94110].slice(0, PAIRS);
  const pairs = SEEDS_D.map((seed) => {
    const ctl = run(seed, false), inj = run(seed, true);
    return { seed, ctl, inj, frac: (inj.occ - ctl.occ) / Math.max(1, inj.addSf) };
  });
  const fracs = pairs.map((p) => p.frac);
  const frac = fracs.reduce((a, b) => a + b, 0) / fracs.length;
  const sd = Math.sqrt(fracs.reduce((a, b) => a + (b - frac) ** 2, 0) / Math.max(1, fracs.length - 1));
  const se = sd / Math.sqrt(fracs.length);
  const sorted = [...fracs].sort((a, b) => a - b);
  report(`D. CONSERVATION (does supply manufacture tenants? mean of ${pairs.length} seed-pairs)`,
    frac <= 0.15,
    [`control occupied: ${pairs.slice(0, 3).map((p) => (p.ctl.occ / 1e6).toFixed(2) + "M").join("  ")} ... of ~${(pairs[0].ctl.stock / 1e6).toFixed(2)}M stock`,
     `injection: +${(pairs[0].inj.addSf / 1e6).toFixed(2)}M sf of office at month 24, per pair`,
     `conjured: mean ${(frac * 100).toFixed(1)}% +/- ${(se * 100).toFixed(1)}pp   (allowed <= 15% induced demand)`,
     `   spread across pairs: ${(sorted[0] * 100).toFixed(0)}% to ${(sorted[sorted.length - 1] * 100).toFixed(0)}%, sd ${(sd * 100).toFixed(1)}pp — which is why this is a mean over twelve and not a median over three`]);
}

// ---------------------------------------------------------------------------
// E. MID-GRADIENT (adopted from the design panel)
// ---------------------------------------------------------------------------
{
  // The extremes are easy to keep honest; the middle is where the game is
  // actually played and where tuning quietly re-flattens things. Two identical
  // empty buildings on ~demand-30 and ~demand-70 blocks, letters counted for
  // four years, nothing signed: the better block must draw >= 2x the letters.
  //
  // FIVE SEEDS, AND THE INFINITY BRANCH IS GONE.
  //
  // This ran on ONE seed and read `ratio = n30 > 0 ? n70 / n30 : Infinity`.
  // Both halves of that were wrong, and the second is the shape CLAUDE.md
  // already names: the tournament's dominance number divided by a bankrupt
  // strategy and reported 116770360.0x. Here, a demand-30 building that drew
  // NO letters at all — the strongest possible evidence that something has
  // gone wrong at the bottom of the gradient, or that the whole leasing pool
  // has gone quiet — produced `Infinity`, and Infinity >= 2.0, so the test
  // passed hardest exactly where it should have shouted. Measured over twelve
  // seeds the branch was one letter away from live: the thinnest bottom seen
  // was n30 = 1 (seed 94110, ratio 19.00x). It is now an explicit no-reading.
  //
  // And one seed could not resolve the bar it was checking. Over those twelve:
  // ratios 1.67 to 19.00, mean 4.92, sd 4.62 — a standard deviation more than
  // twice the 2.0x threshold, and 1 of 12 seeds below it. A single draw from
  // that is a coin with a bias, not a measurement. Five seeds and a median.
  const SEEDS_E = [777001, 550991, 12007, 73303, 11];
  const rows = [];
  for (const seed of SEEDS_E) {
    const parcels = clone();
    const offices = bbls.map((b) => parcels[b])
      .filter((r) => r && r.class === "office" && r.bldgArea > 30000 && r.bldgArea < 90000);
    const near = (t) => offices.slice().sort((a, b) => Math.abs(a.demandScore - t) - Math.abs(b.demandScore - t))[0];
    const mid30 = near(30);
    const mid70 = offices.filter((r) => r.bbl !== mid30.bbl)
      .sort((a, b) => Math.abs(a.demandScore - 70) - Math.abs(b.demandScore - 70))[0];
    const TPL = { bldgArea: 60000, floors: 8, yearBuilt: 1988, unitsRes: 0 };
    for (const r of [mid30, mid70]) Object.assign(parcels[r.bbl], TPL, { lotArea: 9000 });
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    g = { ...g, cash: 400_000_000 };
    for (const bbl of [mid30.bbl, mid70.bbl]) {
      const r = E.executePurchase(g, parcels, bbl, 5_000_000, "cash", false, 1);
      if (r.err) { console.log("E: buy failed", bbl, r.err); process.exit(2); }
      g = r.s;
      g.holdings[bbl].tenants = [];
      g.holdings[bbl].makeReady = [];
      g.holdings[bbl].broker = true;
    }
    const seen = { [mid30.bbl]: new Set(), [mid70.bbl]: new Set() };
    for (let m = 0; m < 48; m++) {
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      for (const l of g.lois) if (seen[l.bbl] && l.kind === "new") seen[l.bbl].add(l.id);
    }
    rows.push({ seed, d30: mid30.demandScore, d70: mid70.demandScore, n30: seen[mid30.bbl].size, n70: seen[mid70.bbl].size });
  }
  // A seed where the poor block drew nothing is NOT a gradient measurement —
  // it is a run with no denominator, and it is excluded and counted rather
  // than scored as an infinite pass.
  const scored = rows.filter((r) => r.n30 > 0);
  const dead = rows.length - scored.length;
  const ratio = scored.length ? med(scored.map((r) => r.n70 / r.n30)) : 0;
  const minN70 = Math.min(...rows.map((r) => r.n70));
  report(`E. MID-GRADIENT (letters at demand ~30 vs ~70, empty twins, 4 years, median of ${SEEDS_E.length})`,
    scored.length >= 3 && minN70 >= 2 && ratio >= 2.0,
    [`demand ${rows[0].d30} vs ${rows[0].d70}`,
     `letters per seed: ${rows.map((r) => `${r.n30}/${r.n70}`).join("  ")}   (poor block / good block)`,
     `ratio per seed: ${rows.map((r) => (r.n30 > 0 ? (r.n70 / r.n30).toFixed(2) + "x" : "no reading")).join("  ")}   median ${ratio.toFixed(2)}x   (need >= 2x — the middle of the gradient must not flatten)`,
     `seeds with no denominator (poor block drew zero letters): ${dead} of ${rows.length}   (these are excluded, not counted as infinite)`]);
}

// ---------------------------------------------------------------------------
verdict();
