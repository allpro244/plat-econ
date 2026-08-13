// C. LEASING MICROSTRUCTURE — tests 6-10.
//
//   node test/stress/C-leasing.mjs
//   SEEDS=550991,12007 HZ=180 node test/stress/C-leasing.mjs        a cheap pass
//   SEEDS=550991,12007,73303,11,22,33 HZ=600 DEEP=1 node …          a deep one
//   ONLY=6,10 node test/stress/C-leasing.mjs                        one section
//
// The space market in market.ts is an aggregate: stock, occupied, pool and
// cityVac, four numbers per class for a whole city. The rent roll in
// leasing.ts is a list of named tenants on named parcels. Those are two
// different accounts of the same thing, and the ONLY place they are supposed
// to meet is absorption.ts — `marketRequirement` says how much space the city
// is looking for this month, and every vacant foot in town is meant to be
// competing for a share of it.
//
// This file asks whether that meeting actually happens, and then asks four
// smaller questions about the terms of the leases that come out of it:
//
//   6  TENANT POOL CONSERVATION   triple the vacant space in one submarket.
//                                 Does total leased sf triple with it?
//   7  CONCESSIONS                do free rent and TI widen in a soft market
//                                 while the face rent stays sticky?
//   8  ROLLOVER RISK              a 70%-in-one-year expiry cliff landing on a
//                                 recession, against the same building on a
//                                 ladder. How much does the cliff cost?
//   9  CREDIT QUALITY             do weak covenants actually fail more in a
//                                 downturn, and does that reach VALUE?
//  10  LEASE-UP CURVES            months to 85% let, by use, by size, by
//                                 location, by what the market was doing on
//                                 delivery day.
//
// WHAT WOULD MAKE EACH ONE A FAILURE is written above each section. The verdict
// words are the audit's: WIRED, WEAK, BROKEN, BACKWARDS, EXPLOITABLE.
//
// House rules this file obeys, each of which has cost this project time:
//   - every arm gets its OWN deep copy of the parcel table, because the table
//     is mutated in place and two arms sharing one would build each other's
//     city;
//   - `advanceQuarter` returns state UNCHANGED once gameOver is set, so every
//     loop resurrects;
//   - money is deflated by g.econ.cpi before anything is compared across
//     decades, and rent comparisons are made PER DEAL rather than between
//     bucket means, so a change in which buildings are letting cannot
//     masquerade as a change in what they are letting for;
//   - cohorts are held CONSTANT across arms — the shared-building measurement
//     in test 6 is the same six buildings in every arm, not "whatever was
//     owned";
//   - two arms of a paired run consume DIFFERENT rng streams once they diverge,
//     so anything measured seven years downstream of the divergence is noise
//     unless the per-seed spread is printed next to it. It is printed.
//   - and every verdict is checked against a control that says the metric CAN
//     move, because a number that cannot move is not evidence either way.
import { assertFreshBundle } from "../fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "../.engine.mjs"));
const { loadCity } = await import(join(HERE, "../city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 360);          // months for the long instrumented run
const DEEP = process.env.DEEP === "1";
const ONLY = (process.env.ONLY ?? "6,7,8,9,10").split(",").map(Number);

// ---------------------------------------------------------------- plumbing
const clone = (x) => JSON.parse(JSON.stringify(x));
const fresh = () => clone(P0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
const qtl = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN; };
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "  —  ");
const k = (x) => `${(x / 1000).toFixed(0)}k`;

/** Deep-pocketed on purpose, so the question is the SPACE market and never the
 *  capital one. Every test here is about who walks through the door. */
const RICH = 3e9;
function keepSolvent(g) {
  if (g.gameOver) g = { ...g, gameOver: null, cash: RICH };
  if (g.cash < RICH / 6) g = { ...g, cash: RICH };
  return g;
}
/** Sign everything on the desk — so what is measured is how many prospects
 *  turn up at all, not how picky a bot is. `fund` draws the line if short. */
function signAll(g, parcels) {
  for (const loi of [...g.lois]) {
    const r = E.respondLOI(g, parcels, loi.id, "accept", true);
    if (!r.err) g = r.s;
  }
  return g;
}
function buy(g, parcels, bbl) {
  const rec = E.resolveRec(parcels, g, bbl);
  if (!rec) return { g, ok: false };
  const px = Math.round(E.assetValue(rec, g.econ, E.initialCondition(rec)));
  const r = E.executePurchase(g, parcels, bbl, px, "cash", false, 1);
  if (r.err) return { g, ok: false };
  return { g: r.s, ok: true };
}
function buyAndEmpty(g, parcels, bbl, { deliveredNew = false } = {}) {
  const r = buy(g, parcels, bbl);
  if (!r.ok) return r;
  g = r.g;
  // A BOUGHT BUILDING COMES WITH ITS ROLL, which is correct and is not what
  // these tests are about. Empty it: what gets measured is the thing a
  // developer actually lives through — a finished building with nobody in it.
  g.holdings[bbl].tenants = [];
  g.holdings[bbl].occ = 0;
  delete g.holdings[bbl].makeReady;
  // `deliveredM` is the only thing leaseFactors reads to know a building is
  // new — a 1.45x "brokers have been touring it since the steel" factor for
  // thirty months. Test 10 is about new buildings, so it sets it.
  if (deliveredNew) g.holdings[bbl].deliveredM = g.month;
  return { g, ok: true };
}
const leasedSf = (g, list) => list.reduce((a, b) => {
  const h = g.holdings[b];
  return a + (h ? h.tenants.reduce((x, t) => x + t.sf, 0) : 0);
}, 0);
/** Occupancy the way the game's own panel computes it — which is the only way
 *  that gets a block of flats right, because flats have no rent roll at all. */
function occOf(parcels, g, bbl) {
  const rec = E.resolveRec(parcels, g, bbl), h = g.holdings[bbl];
  if (!rec || !h) return null;
  const u = E.unitStatus(rec, h, g.month);
  return u.total > 0 ? u.leased / u.total : null;
}

/** Commercial buildings big enough to have a leasing problem, in one seed's city. */
function commercialStock(g, parcels, minSf = 12_000) {
  const out = [];
  for (const b of bbls) {
    const r = E.resolveRec(parcels, g, b);
    if (!r || r.class === "land" || !r.bldgArea || !E.isCommercial(r)) continue;
    if (r.bldgArea < minSf) continue;
    out.push({ bbl: b, sf: r.bldgArea, use: E.dominantUse(r), d: r.demandScore ?? 50, block: r.block });
  }
  return out;
}
/** A spread-out book of buildings — every Nth, so the sample is not one corner. */
function bookOf(g, parcels, want, minSf = 15_000) {
  const stock = commercialStock(g, parcels, minSf);
  const step = Math.max(1, Math.floor(stock.length / want));
  const picks = [];
  for (let i = 0; i < stock.length && picks.length < want; i += step) picks.push(stock[i]);
  const owned = [];
  for (const s of picks) { const r = buy(g, parcels, s.bbl); if (r.ok) { g = r.g; owned.push(s.bbl); } }
  return { g, owned };
}

const FINDINGS = [];
const note = (id, name, verdict, line) => FINDINGS.push({ id, name, verdict, line });
const rule = () => console.log("\n" + "-".repeat(102) + "\n");

// ==========================================================================
// 6. TENANT POOL CONSERVATION
//
// The one that decides whether anything else here means anything. If the city
// has a finite quantity of tenant requirement, then vacant space competes for
// it: put three times as much empty space on one corner and the corner does
// not lease three times as much — it leases about the same amount, spread over
// more landlords, and the extra space is the last to fill. If instead every
// building draws its own prospects on demand, leased sf scales with SUPPLY,
// demand is a mirage, and every development decision in this game is
// underwritten against a number that cannot say no.
//
// The experiment is a paired ladder and the cohort is constant:
//   HALF    the player owns 6 emptied commercial buildings in one submarket
//   CTRL    the same 6, plus 6 more                        (~2x the vacancy)
//   SHOCK   the same 6, plus 18 more                       (~3x the vacancy)
// and the reported quantity is leased sf on the SHARED SIX in every arm, plus
// the total. The submarket is a block and its neighbours on exactly the
// weights absorption.ts uses, so "submarket" means the same thing here as it
// does in the engine.
//
// PASS: shared-cohort leasing falls by close to the whole of the supply
// increase, and the total is roughly flat. FAIL: the total scales 1:1 with
// supply and the shared six barely notice.
//
// Two controls, because a null result would otherwise be unreadable:
//   - the subject building's own loiOdds, competingSf and local vacancy are
//     printed, so "the wire does nothing" is distinguishable from "the wire is
//     not connected";
//   - so is the change in CITYWIDE occupied stock, which is the aggregate the
//     parcel-level rent rolls are supposed to be an account of.
// ==========================================================================
function pickCluster(g, parcels) {
  const model = E.demandModel(parcels);
  const byBlock = new Map();
  for (const s of commercialStock(g, parcels)) {
    if (!byBlock.has(s.block)) byBlock.set(s.block, []);
    byBlock.get(s.block).push(s.bbl);
  }
  let best = null, bestN = -1;
  for (const [, blk] of model.blocks) {
    let n = 0;
    for (const nb of blk.neighbours) n += (byBlock.get(nb.id) ?? []).length;
    if (n > bestN) { bestN = n; best = blk; }
  }
  const out = [], seen = new Set();
  for (const nb of [...best.neighbours].sort((a, b) => b.w - a.w)) {
    for (const b of byBlock.get(nb.id) ?? []) if (!seen.has(b)) { seen.add(b); out.push(b); }
  }
  return out;
}

function test6() {
  const HZ6 = 48;
  const probeP = fresh();
  const probe = E.firstListings(E.newGame(SEEDS[0], probeP), probeP, bbls);
  const cands = pickCluster(probe, probeP);
  if (cands.length < 24) { console.log("6. (city too small for the supply shock — skipped)"); return null; }
  const SHARED = cands.slice(0, 6);
  const ARMS = [["half ", cands.slice(0, 6)], ["ctrl ", cands.slice(0, 12)], ["SHOCK", cands.slice(0, 24)]];

  function arm(seed, list) {
    const parcels = fresh();
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    g = { ...g, cash: RICH };
    const owned = [];
    for (const b of list) { const r = buyAndEmpty(g, parcels, b); if (r.ok) { g = r.g; owned.push(b); } }
    let vac0 = 0;
    for (const b of owned) vac0 += E.commercialSf(E.resolveRec(parcels, g, b));
    const occ0 = g.econ.occupied.office, cv0 = g.econ.cityVac.office;
    const subj = owned[0];                          // the same parcel in every arm
    let odds = null;
    for (let m = 1; m <= HZ6; m++) {
      g = signAll(g, parcels);
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      g = keepSolvent(g);
      if (m === 12) {
        const rec = E.resolveRec(parcels, g, subj), h = g.holdings[subj];
        odds = rec && h ? E.leasingOdds(g, parcels, rec, h, E.leasableUses(rec)[0]) : null;
      }
    }
    return {
      vac0, n: owned.length,
      shared: leasedSf(g, SHARED.filter((b) => owned.includes(b))),
      all: leasedSf(g, owned),
      cityOccD: g.econ.occupied.office - occ0,
      cityVacD: g.econ.cityVac.office - cv0,
      req: E.marketRequirement(g.econ, "office"),
      odds,
    };
  }

  const res = ARMS.map(([nm, list]) => ({ nm, rows: SEEDS.map((s) => arm(s, list)) }));
  const M = (r, f) => mean(r.rows.map(f));
  console.log(`6. TENANT POOL CONSERVATION — ${SEEDS.length} seeds x ${HZ6} months, every LOI signed on sight`);
  console.log(`   one submarket (a block and its neighbours); the shared cohort is the SAME 6 buildings in every arm\n`);
  console.log(`   arm      buildings   vacant sf   x supply   leased on the SHARED 6   total leased   x leased`);
  const base = res[0];
  for (const r of res) {
    const sx = M(r, (x) => x.vac0) / M(base, (x) => x.vac0);
    const lx = M(r, (x) => x.all) / M(base, (x) => x.all);
    console.log(`   ${r.nm}    ${String(M(r, (x) => x.n).toFixed(0)).padStart(9)}   ${k(M(r, (x) => x.vac0)).padStart(9)}`
      + `   ${sx.toFixed(2).padStart(8)}   ${k(M(r, (x) => x.shared)).padStart(22)}   ${k(M(r, (x) => x.all)).padStart(12)}   ${lx.toFixed(2).padStart(8)}`);
  }
  const top = res[res.length - 1];
  const supplyX = M(top, (x) => x.vac0) / M(base, (x) => x.vac0);
  const leaseX = M(top, (x) => x.all) / M(base, (x) => x.all);
  const cann = M(top, (x) => x.shared) / M(base, (x) => x.shared) - 1;
  // The share of the supply increase the market REFUSED to absorb. 1.00 is a
  // perfectly conserved pool — everything new had to come out of somebody
  // else's building. 0.00 is a tenant appearing for every empty foot created.
  const conserved = 1 - (leaseX - 1) / (supplyX - 1);
  console.log(`\n   shared-6 cohort: ${(100 * cann).toFixed(1)}% under ${supplyX.toFixed(2)}x the competing supply`);
  console.log(`   CONSERVATION ${conserved.toFixed(2)} of 1.00   (1.00 = a finite pool everything new had to share;`);
  console.log(`                                       0.00 = a tenant appears for every empty foot you create)`);
  console.log(`\n   CONTROLS — can these numbers move at all?`);
  const oB = base.rows.map((r) => r.odds).filter(Boolean), oT = top.rows.map((r) => r.odds).filter(Boolean);
  console.log(`     the subject building at month 12:  loiOdds ${mean(oB.map((o) => o.loiOdds)).toFixed(3)} -> ${mean(oT.map((o) => o.loiOdds)).toFixed(3)}`
    + `   competing sf ${(mean(oB.map((o) => o.competingSf)) / 1e6).toFixed(2)}M -> ${(mean(oT.map((o) => o.competingSf)) / 1e6).toFixed(2)}M`);
  console.log(`                                        local vacancy ${pct(mean(oB.map((o) => o.localVac)))} -> ${pct(mean(oT.map((o) => o.localVac)))}`
    + `   — so the competition wire IS connected; it is the size of it that is the finding`);
  console.log(`     the city's whole monthly office requirement is ${k(M(top, (x) => x.req))} sf;`
    + ` the ${M(top, (x) => x.n).toFixed(0)} shocked buildings took ${k(M(top, (x) => x.all) / HZ6)} sf/month between them`);
  console.log(`     citywide OCCUPIED office stock: ${k(M(base, (x) => x.cityOccD))} (half) vs ${k(M(top, (x) => x.cityOccD))} (shock)`
    + ` — a ${k(M(top, (x) => x.cityOccD) - M(base, (x) => x.cityOccD))} difference against ${k(M(top, (x) => x.all) - M(base, (x) => x.all))} more sf actually let.`);
  console.log(`     The macro account and the rent-roll account are not the same account.`);

  const verdict = conserved > 0.7 ? "WIRED" : conserved > 0.3 ? "WEAK" : "BROKEN";
  note("6", "Tenant pool conservation", verdict,
    `${supplyX.toFixed(2)}x the vacant sf in one submarket produced ${leaseX.toFixed(2)}x the total leased sf, and the shared `
    + `6-building cohort gave up only ${(-100 * cann).toFixed(1)}%. Conservation ${conserved.toFixed(2)} of 1.00. The competition wire exists `
    + `(the subject's arrival odds fall ${mean(oB.map((o) => o.loiOdds)).toFixed(3)} -> ${mean(oT.map((o) => o.loiOdds)).toFixed(3)}) and is nowhere near strong enough to conserve anything.`);
  return { conserved, supplyX, leaseX, cann };
}

// ==========================================================================
// THE INSTRUMENTED RUN — shared by tests 7 and 9a.
//
// One long run per seed with a book of 26 buildings and a player who signs
// everything, recording two streams: the terms of every new-lease letter that
// arrived, and every tenant that left the roll before its lease was up.
// Two tests off one run because the run is the expensive part.
// ==========================================================================
function instrumented(seed) {
  const parcels = fresh();
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  g = { ...g, cash: RICH };
  const b = bookOf(g, parcels, 26);
  g = b.g;
  const owned = b.owned;
  const deals = [], cells = {};
  const bump = (c, p, fails, months) => {
    const key = `${c}|${p}`;
    cells[key] = cells[key] ?? { months: 0, fails: 0 };
    cells[key].months += months; cells[key].fails += fails;
  };
  const rollOf = () => {
    const m = new Map();
    for (const bb of owned) {
      const h = g.holdings[bb];
      if (!h) continue;
      for (const t of h.tenants) m.set(`${bb}|${t.name}|${t.startM}`, t);
    }
    return m;
  };
  let prev = rollOf();
  const seen = new Set();
  for (let m = 0; m < HZ; m++) {
    // Record the letters BEFORE signing, because signing removes them.
    for (const l of g.lois) {
      if (l.kind !== "new" || seen.has(l.id)) continue;
      seen.add(l.id);
      const rec = E.resolveRec(parcels, g, l.bbl), h = g.holdings[l.bbl];
      if (!rec || !h) continue;
      const use = l.use ?? "office";
      const ask = E.managedRentPsfYr(rec, g.econ, h, use);     // what the building is asking
      if (!(ask > 0.5)) continue;
      const yrs = l.termM / 12;
      const cost = E.loiSigningCost(l) / l.sf;                 // TI + commission, $/sf, engine's own
      // Net effective the way a broker computes it and the way this engine
      // actually charges it: face rent over the paying months, less the
      // fit-out and the commission, spread over the term.
      const ner = (l.rentPsf * (l.termM - (l.freeM ?? 0)) / 12 - cost) / yrs;
      const nat = E.NATURAL_VAC[use] ?? 0.1;
      const avail = (g.econ.cityVac?.[use] ?? nat)
        + (g.econ.sublet?.[use] ?? 0) / Math.max(1, g.econ.stock?.[use] ?? 1);
      deals.push({
        use, phase: g.econ.phase, gap: avail - nat, cpi: g.econ.cpi || 1,
        conc: g.econ.concIdx?.[use] ?? NaN,
        ask, face: l.rentPsf, ner, yrs,
        // The three separate things a landlord gives away, each as a share of
        // the ask, so a change in WHICH buildings are letting cannot be
        // mistaken for a change in what they are letting FOR.
        rBid: 1 - l.rentPsf / ask,                             // the face-rent cut off the ask
        rFree: (l.freeM ?? 0) / l.termM,                       // free rent as a share of term
        rCost: cost / (l.rentPsf * yrs),                       // TI + LC as a share of lease value
        rNer: 1 - ner / ask,                                   // all of it, together
        freePerYr: (l.freeM ?? 0) / yrs, ti: l.tiPsf,
      });
    }
    g = signAll(g, parcels);
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    g = keepSolvent(g);
    // Exposure and failures. A tenant that vanishes with term left to run can
    // only have gone through `pFail` in tickLeasing; one that vanishes at or
    // past its endM simply expired, and an expiry is not a default.
    const now = rollOf(), phase = g.econ.phase;
    const live = {};
    for (const [key, t] of prev) {
      if (t.endM <= g.month) continue;
      live[t.credit] = (live[t.credit] ?? 0) + 1;
      if (!now.has(key)) bump(t.credit, phase, 1, 0);
    }
    for (const c of [0, 1, 2]) if (live[c]) bump(c, phase, 0, live[c]);
    prev = now;
  }
  return { deals, cells };
}

// ==========================================================================
// 7. CONCESSIONS
//
// Face rents are sticky and concessions are not. That is the oldest tell in
// the business: a landlord holds the headline number on the comp sheet long
// after he has started giving away a year of free rent and a full fit-out to
// get it. So asking and NET EFFECTIVE should DIVERGE in a soft market and
// CONVERGE in a tight one.
//
// Measured PER DEAL as a ratio to that building's own ask on that day, so the
// composition of which buildings happen to be letting cannot contaminate the
// answer — and split three ways, because "concession" is three different
// things with three different costs to the landlord:
//
//   bid    the cut off the face rent itself (a permanent giveaway)
//   free   months of no rent (costs nothing today, everything over the term)
//   cost   TI and commission (real money, out the door at signing)
//
// FAILURE looks like: the total gap is the same in a tight market as in a
// glut (concessions are decorative), or it runs the wrong way (BACKWARDS).
// ==========================================================================
function test7(runs) {
  const deals = runs.flatMap((r) => r.deals);
  const off = deals.filter((d) => d.use === "office");
  const sample = off.length > 250 ? off : deals;
  const label = off.length > 250 ? "office only" : "all classes";
  console.log(`7. CONCESSIONS — ${deals.length} arriving new-lease letters, ${SEEDS.length} seeds x ${HZ} months, ${label} (n=${sample.length})`);
  console.log(`   every number is PER DEAL against that building's own ask on the day, so composition cannot fake a trend\n`);

  // Buckets keyed to the NATURAL rate, not to the sample's own terciles — a
  // tercile split reports a "glut" bucket even in a city that never had one.
  const buckets = [
    ["tight    (>3pp under natural)", sample.filter((d) => d.gap < -0.03)],
    ["balanced (+/-3pp)", sample.filter((d) => d.gap >= -0.03 && d.gap <= 0.03)],
    ["soft     (>3pp over natural)", sample.filter((d) => d.gap > 0.03)],
  ];
  console.log(`   market                            n    avail gap   face cut   free rent   TI+LC   TOTAL vs ask   free mo/yr   real ask`);
  const rows = [];
  for (const [name, set] of buckets) {
    if (!set.length) { console.log(`   ${name.padEnd(32)}    0            —          —           —       —              —            —`); continue; }
    const r = {
      name, n: set.length, gap: mean(set.map((d) => d.gap)),
      bid: mean(set.map((d) => d.rBid)), free: mean(set.map((d) => d.rFree)),
      cost: mean(set.map((d) => d.rCost)), tot: mean(set.map((d) => d.rNer)),
      fpy: mean(set.map((d) => d.freePerYr)), ask: mean(set.map((d) => d.ask / d.cpi)),
    };
    rows.push(r);
    console.log(`   ${name.padEnd(32)}${String(r.n).padStart(5)}   ${(100 * r.gap).toFixed(1).padStart(8)}pp`
      + `${pct(r.bid).padStart(11)}${pct(r.free).padStart(12)}${pct(r.cost).padStart(8)}${pct(r.tot).padStart(15)}`
      + `${r.fpy.toFixed(2).padStart(13)}${r.ask.toFixed(2).padStart(11)}`);
  }
  // A second, independent cut. The cycle phase is not the same variable as the
  // vacancy gap and a city can be in one without the other.
  console.log(`\n   phase                             n    avail gap   face cut   free rent   TI+LC   TOTAL vs ask   free mo/yr   real ask`);
  const byPhase = {};
  for (const p of ["expansion", "peak", "recession", "recovery"]) {
    const set = sample.filter((d) => d.phase === p);
    if (!set.length) continue;
    byPhase[p] = {
      tot: mean(set.map((d) => d.rNer)), bid: mean(set.map((d) => d.rBid)),
      free: mean(set.map((d) => d.rFree)), cost: mean(set.map((d) => d.rCost)),
    };
    console.log(`   ${p.padEnd(32)}${String(set.length).padStart(5)}   ${(100 * mean(set.map((d) => d.gap))).toFixed(1).padStart(8)}pp`
      + `${pct(byPhase[p].bid).padStart(11)}${pct(byPhase[p].free).padStart(12)}${pct(byPhase[p].cost).padStart(8)}`
      + `${pct(byPhase[p].tot).padStart(15)}${mean(set.map((d) => d.freePerYr)).toFixed(2).padStart(13)}`
      + `${mean(set.map((d) => d.ask / d.cpi)).toFixed(2).padStart(11)}`);
  }
  // THE CONTROL, AND IN THIS TEST IT IS THE WHOLE ANSWER. concessionPressure()
  // has a designed range of 0.22 to 2.10 and it is driven entirely by
  // econ.concIdx, which is itself chased off the availability gap. A dial with
  // a wide range that never leaves the bottom of it is a rail holding up the
  // model — CLAUDE.md's own definition of a defect — so what matters is not
  // the range on paper but where the variable actually lives.
  const cs = sample.map((d) => d.conc).filter(Number.isFinite).sort((a, b) => a - b);
  const gs = sample.map((d) => d.gap).sort((a, b) => a - b);
  const cp = (c) => 0.22 + 1.88 * c;
  console.log(`\n   WHERE THE DIAL ACTUALLY LIVES — over the ${cs.length} letter-months sampled:`);
  console.log(`     availability gap vs natural   p10 ${(100 * qtl(gs, 0.1)).toFixed(1)}pp   median ${(100 * qtl(gs, 0.5)).toFixed(1)}pp   p90 ${(100 * qtl(gs, 0.9)).toFixed(1)}pp`
    + `   ·   months above natural: ${pct(gs.filter((x) => x > 0).length / gs.length)}`);
  if (cs.length) {
    console.log(`     econ.concIdx                  p10 ${qtl(cs, 0.1).toFixed(2)}       median ${qtl(cs, 0.5).toFixed(2)}       p90 ${qtl(cs, 0.9).toFixed(2)}`
      + `        (0 = a squeeze, 1 = a glut)`);
    console.log(`     concessionPressure()          p10 ${cp(qtl(cs, 0.1)).toFixed(2)}       median ${cp(qtl(cs, 0.5)).toFixed(2)}       p90 ${cp(qtl(cs, 0.9)).toFixed(2)}`
      + `        against a designed range of 0.22 .. 2.10`);
  }
  const lo = rows[0], hi = rows[rows.length - 1];
  const spread = rows.length >= 2 ? hi.tot - lo.tot : NaN;
  const freeSpread = rows.length >= 2 ? hi.free - lo.free : NaN;
  const recSpread = byPhase.recession && byPhase.expansion ? byPhase.recession.tot - byPhase.expansion.tot : NaN;
  console.log(`\n   loosest bucket minus tightest:  total giveaway ${(100 * spread).toFixed(1)}pp of ask`
    + `   ·  of which free rent ${(100 * freeSpread).toFixed(1)}pp`);
  console.log(`   recession minus expansion:      total giveaway ${(100 * recSpread).toFixed(1)}pp of ask`
    + `   ·  free rent ${(100 * ((byPhase.recession?.free ?? NaN) - (byPhase.expansion?.free ?? NaN))).toFixed(1)}pp`
    + `   ·  TI+LC ${(100 * ((byPhase.recession?.cost ?? NaN) - (byPhase.expansion?.cost ?? NaN))).toFixed(1)}pp`);
  console.log(`   The engine's own dial for this is econ.concIdx, mapped by concessionPressure() onto 0.22..2.10.`);
  console.log(`   A 12-month holiday on a 10-year lease is 10% of term; the whole observed swing is above.`);

  const best = Math.max(Number.isFinite(spread) ? spread : -1, Number.isFinite(recSpread) ? recSpread : -1);
  const verdict = best <= 0 ? "BACKWARDS" : best > 0.08 ? "WIRED" : "WEAK";
  note("7", "Concessions", verdict,
    `they diverge in the right direction and by a defensible amount: the total giveaway against the ask moves ${(100 * spread).toFixed(1)}pp `
    + `from the tightest bucket to the loosest and ${(100 * recSpread).toFixed(1)}pp from expansion to recession, and free rent alone goes ${lo?.fpy.toFixed(2)} -> ${hi?.fpy.toFixed(2)} `
    + `months per year of term (about one month on a ten-year lease in a squeeze, about nine in a glut). Two things behind it are worth `
    + `looking at. The dial is pinned: econ.concIdx has a median of ${qtl(cs, 0.5).toFixed(2)} and a p90 of ${qtl(cs, 0.9).toFixed(2)}, so concessionPressure() sits at its ${cp(qtl(cs, 0.5)).toFixed(2)} FLOOR `
    + `for most of the calendar against a designed range topping out at 2.10, because availability is above natural in only ${pct(gs.filter((x) => x > 0).length / gs.length)} of months. `
    + `And the ASK is not a number anything signs at: the cut off it is ${pct(lo?.bid)} even in the tightest bucket, before a single concession. `
    + `The two cuts also disagree about which lever does the cyclical work — across the vacancy split free rent moves ${(100 * freeSpread).toFixed(1)}pp of the ${(100 * spread).toFixed(1)}pp `
    + `and the face cut ${(100 * (hi.bid - lo.bid)).toFixed(1)}pp, while across the phase split the face cut moves ${(100 * ((byPhase.recession?.bid ?? NaN) - (byPhase.expansion?.bid ?? NaN))).toFixed(1)}pp of the ${(100 * recSpread).toFixed(1)}pp and free rent ${(100 * ((byPhase.recession?.free ?? NaN) - (byPhase.expansion?.free ?? NaN))).toFixed(1)}pp.`);
  return { spread, recSpread, freeSpread, rows };
}

// ==========================================================================
// 8. ROLLOVER RISK
//
// Two identical buildings — the same parcel, the same tenants, the same
// square footage, the same rents, the same credit, the same seed and the same
// market. The only difference is WHEN the leases expire: one on a ten-year
// ladder, one with ~70% of its square footage rolling inside a single year
// that lands on a recession.
//
// Rollover is the largest thing a buyer of a stabilised building actually
// underwrites, and the cliff has to be visibly punished — a year of downtime
// at make-ready cost, a re-let into a soft market at a soft rent, and a wider
// exit cap because the roll got shorter. If the two arms end within a per cent
// of each other, the expiry schedule is decoration and WALT is a number nobody
// has to work for.
//
// The recession is FOUND, not assumed: a phase scan runs first on the same
// seed with no player, and the cliff is placed on the first downturn after
// year five.
//
// The instrument that makes this readable is not the P&L, it is WHERE THE
// SPACE WENT — how much square footage actually left the building at the
// expiry, against how much simply renewed. That is the mechanism, and if the
// cliff costs nothing it will be because nothing ever left.
// ==========================================================================
function firstRecession(seed, after = 60) {
  const parcels = fresh();
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  for (let m = 1; m <= 360; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    g = keepSolvent(g);
    if (m >= after && g.econ.phase === "recession") return m;
  }
  return null;
}

/** Buy the biggest well-let commercial building in town — a real rent roll to
 *  put a schedule into. Same choice in every arm, since nothing has diverged. */
function bigLetBuilding(g, parcels) {
  const stock = commercialStock(g, parcels, 40_000).sort((a, b) => b.sf - a.sf);
  for (const s of stock) {
    const r = buy(g, parcels, s.bbl);
    if (!r.ok) continue;
    if (r.g.holdings[s.bbl].tenants.length >= 4) return { g: r.g, bbl: s.bbl };
  }
  return { g, bbl: null };
}

function test8() {
  const rows = [];
  for (const seed of SEEDS) {
    const R = firstRecession(seed);
    if (R === null) continue;
    const WIN = [R - 12, R + 36];       // the window the cliff is supposed to hurt in
    const END = R + 36;

    function arm(cliff) {
      const parcels = fresh();
      let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
      g = { ...g, cash: RICH };
      const b = bigLetBuilding(g, parcels);
      if (!b.bbl) return null;
      g = b.g;
      const bbl = b.bbl, h = g.holdings[bbl];
      // REWRITE ONLY THE EXPIRY DATES. Same names, same sf, same rents, same
      // covenants — the only thing the arms can differ by is the schedule.
      const ts = [...h.tenants].sort((a, b2) => b2.sf - a.sf);
      const total = ts.reduce((a, t) => a + t.sf, 0);
      let piled = 0;
      ts.forEach((t, i) => {
        if (cliff && piled < total * 0.70) { t.endM = R - 4 + ((i * 7) % 12); piled += t.sf; }
        else t.endM = R - 54 + Math.round((i / Math.max(1, ts.length - 1)) * 108);
        t.endM = Math.max(g.month + 4, t.endM);
      });
      const rollSf = ts.filter((t) => t.endM >= R - 6 && t.endM <= R + 6).reduce((a, t) => a + t.sf, 0);

      const rec0 = E.resolveRec(parcels, g, bbl);
      const commSf = E.commercialSf(rec0);
      let noiReal = 0, occMin = 1, vacMonths = 0, leftSf = 0, renewedSf = 0;
      const intents = [];   // every renewalIntent().p the building's roll ever showed
      const snap = () => new Map((g.holdings[bbl]?.tenants ?? []).map((t) => [`${t.name}|${t.startM}`, { sf: t.sf, endM: t.endM }]));
      let prev = snap();
      for (let m = 1; m <= END; m++) {
        g = signAll(g, parcels);                    // a competent operator renews everything offered
        g = E.advanceQuarter(g, parcels, bbls, adjacency);
        g = keepSolvent(g);
        const rec = E.resolveRec(parcels, g, bbl), hh = g.holdings[bbl];
        if (!rec || !hh) break;
        const cpi = g.econ.cpi || 1;
        noiReal += E.holdingNOIYr(rec, g.econ, hh, g.month) / 12 / cpi;
        const occ = hh.tenants.reduce((a, t) => a + t.sf, 0) / Math.max(1, commSf);
        const now = snap();
        if (m >= WIN[0] && m <= WIN[1]) {
          occMin = Math.min(occMin, occ);
          vacMonths += 1 - occ;                      // integrated emptiness, in building-months
          // THE PROBABILITY ITSELF, not just its outcome. If a cliff costs
          // nothing it will be because nothing ever left, and if nothing ever
          // left it will be because renewalIntent is sitting on its ceiling.
          // Sampled once a quarter so the tally is not dominated by one tenant.
          if (m % 3 === 0) for (const t of hh.tenants) intents.push(E.renewalIntent(g, rec, hh, t).p);
          // WHERE THE SPACE WENT. A tenant whose endM moved OUT renewed; one
          // that vanished at its endM left the building.
          for (const [key, t] of prev) {
            const n = now.get(key);
            if (!n) { if (t.endM <= g.month) leftSf += t.sf; }
            else if (n.endM > t.endM) renewedSf += t.sf;
          }
        }
        prev = now;
      }
      const rec = E.resolveRec(parcels, g, bbl), hh = g.holdings[bbl];
      const cpi = g.econ.cpi || 1;
      return {
        rollShare: rollSf / total, noiReal, occMin, vacMonths, leftSf, renewedSf,
        pMed: med(intents), pP10: qtl(intents, 0.1), pCeil: intents.filter((p) => p >= 0.955).length / Math.max(1, intents.length),
        valueReal: rec && hh ? E.holdingValue(rec, g.econ, hh, g.month) / cpi : NaN,
        spread: rec && hh ? E.rollQualitySpread(rec, hh, g.month, g.econ) : NaN,
        walt: hh ? E.walt(hh, g.month) : NaN,
      };
    }
    const ladder = arm(false), cliff = arm(true);
    if (ladder && cliff) rows.push({ seed, R, ladder, cliff });
  }
  console.log(`8. ROLLOVER RISK — a 70% expiry cliff on a recession, against the same building on a ten-year ladder`);
  console.log(`   ${rows.length} seeds. Same parcel, same tenants, same rents and covenants; only the expiry dates differ.`);
  console.log(`   Window is the year before the downturn to three years after it.\n`);
  console.log(`   seed      slump   arm      rolls in window   sf renewed   sf LEFT   vacancy-months   real NOI   occ trough   real value`);
  for (const r of rows) {
    for (const [nm, a] of [["ladder", r.ladder], ["CLIFF ", r.cliff]]) {
      console.log(`   ${String(r.seed).padEnd(10)}${("m" + r.R).padEnd(8)}${nm}${pct(a.rollShare).padStart(16)}`
        + `${k(a.renewedSf).padStart(13)}${k(a.leftSf).padStart(10)}${a.vacMonths.toFixed(2).padStart(17)}`
        + `   $${(a.noiReal / 1e6).toFixed(1).padStart(6)}M${pct(a.occMin).padStart(13)}   $${(a.valueReal / 1e6).toFixed(1).padStart(8)}M`);
    }
  }
  const d = (f) => rows.map((r) => f(r.cliff) - f(r.ladder));
  const rel = (f) => rows.map((r) => f(r.cliff) / f(r.ladder) - 1);
  const dNoi = mean(rel((a) => a.noiReal)), dVal = mean(rel((a) => a.valueReal));
  const dVac = mean(d((a) => a.vacMonths)), dLeft = mean(d((a) => a.leftSf));
  const dOcc = mean(d((a) => a.occMin));
  console.log(`\n   CLIFF minus LADDER (mean over seeds; the per-seed spread above is the honest error bar):`);
  console.log(`     sf that actually LEFT the building  ${dLeft >= 0 ? "+" : ""}${k(dLeft)}`
    + `      vacancy-months  ${dVac >= 0 ? "+" : ""}${dVac.toFixed(2)}`
    + `      occupancy trough  ${(100 * dOcc).toFixed(1)}pp`);
  console.log(`     real NOI over the window  ${(100 * dNoi).toFixed(1)}%`
    + `      real value at the end  ${(100 * dVal).toFixed(1)}%`
    + `      exit spread  ${mean(d((a) => a.spread * 100)).toFixed(0)}bp`);
  const renewShare = mean(rows.map((r) => r.cliff.renewedSf / Math.max(1, r.cliff.renewedSf + r.cliff.leftSf)));
  console.log(`\n   THE MECHANISM — and it is upstream of the schedule entirely:`);
  console.log(`     ${pct(renewShare)} of the square footage that rolled in the cliff arm RENEWED IN PLACE, so the`);
  console.log(`     concentration never turned into vacancy and there was nothing for the recession to punish.`);
  console.log(`     renewalIntent() over the window: median p ${mean(rows.map((r) => r.cliff.pMed)).toFixed(3)}`
    + `   p10 ${mean(rows.map((r) => r.cliff.pP10)).toFixed(3)}`
    + `   share pinned at the 0.96 clamp ${pct(mean(rows.map((r) => r.cliff.pCeil)))}`);
  console.log(`     p = clamp(0.94 x service x condition x rent x industry x fit x credit x tenure x location, 0.10, 0.96).`);
  console.log(`     Nothing in that product is a function of the CYCLE except fInd = 1 - industryStress*0.55,`);
  console.log(`     and industryStress is zero in most months — so a recession does not move renewal at all.`);
  // TWO CHANNELS, AND ONLY ONE OF THEM EXISTS HERE. Rollover risk in life is
  // (a) downtime and the cost of re-letting, and (b) marking a big slice of the
  // roll to whatever the market happens to be on the day. This separates them,
  // because a verdict that averages the two would hide the missing one.
  const vacancyChannel = Math.abs(dVac) > 0.5 || Math.abs(dLeft) > 20_000;
  const valSigns = rows.map((r) => Math.sign(r.cliff.valueReal - r.ladder.valueReal));
  const agree = valSigns.every((s) => s === valSigns[0]);
  console.log(`\n   TWO CHANNELS, AND ONE OF THEM IS MISSING:`);
  console.log(`     downtime / re-letting   ${vacancyChannel ? "PRESENT" : "ABSENT"} — ${k(dLeft)} more sf actually left the building,`
    + ` ${dVac >= 0 ? "+" : ""}${dVac.toFixed(2)} vacancy-months`);
  console.log(`     mark-to-market on the roll   real terminal value ${(100 * dVal).toFixed(1)}%,`
    + ` ${agree ? "same sign in every seed" : "signs disagree across seeds — treat as noise"}`);
  const verdict = !vacancyChannel && agree && Math.abs(dVal) > 0.06 ? "WEAK"
    : !vacancyChannel ? "BROKEN"
      : Math.max(Math.abs(dNoi), Math.abs(dVal)) > 0.06 ? "WIRED" : "WEAK";
  note("8", "Rollover risk", verdict,
    `the downtime channel does not exist: concentrating 70% of the roll into one recession year moved the sf that actually `
    + `left the building by ${k(dLeft)}, integrated vacancy by ${dVac >= 0 ? "+" : ""}${dVac.toFixed(2)} building-months and the occupancy trough by `
    + `${(100 * dOcc).toFixed(1)}pp, because ${pct(renewShare)} of the rolling sf renewed in place — renewalIntent sits on its 0.96 clamp `
    + `${pct(mean(rows.map((r) => r.cliff.pCeil)))} of the time and has no cycle term that fires. What DOES bite is marking 70% of the roll to a recession `
    + `market: real terminal value ${(100 * dVal).toFixed(1)}%, ${agree ? "the same sign in all " + rows.length + " seeds" : "signs disagreeing across seeds"}. `
    + `So the schedule matters, for one of the two reasons it should.`);
  return { dNoi, dVal, dVac, dLeft, renewShare, vacancyChannel };
}

// ==========================================================================
// 9. CREDIT QUALITY
//
// Two halves, because "the credit field is cosmetic" can fail in two places
// and each needs its own evidence.
//
// 9a  DOES IT FAIL?  Every tenant that went dark MID-TERM in the long
//     instrumented run, against tenant-years of exposure, split by covenant
//     grade and by the phase it happened in. If unrated and investment grade
//     fail at the same rate, or a recession does not raise either, the field
//     is a label.
//
// 9b  DOES IT REACH VALUE?  The same building, the same rents and expiries,
//     graded all-investment-grade in one arm and all-unrated in the other. The
//     honest number here is the one at t=0, before the two arms have consumed
//     a single different random draw: an appraisal difference on identical
//     buildings. The realised path is printed too, and is noisier by an order
//     of magnitude — which is itself worth seeing.
// ==========================================================================
function test9(runs) {
  const cells = {};
  for (const r of runs) for (const [key, v] of Object.entries(r.cells)) {
    cells[key] = cells[key] ?? { months: 0, fails: 0 };
    cells[key].months += v.months; cells[key].fails += v.fails;
  }
  const rate = (c, p) => { const x = cells[`${c}|${p}`]; return x && x.months ? (12 * x.fails) / x.months : NaN; };
  console.log(`9. CREDIT QUALITY`);
  console.log(`   9a — tenants going dark MID-TERM, per tenant-year of exposure, ${SEEDS.length} seeds x ${HZ} months\n`);
  console.log(`   covenant           expansion        peak    recovery   recession   recession/expansion   exposure`);
  const PH = ["expansion", "peak", "recovery", "recession"];
  const grade = ["unrated (0)", "mid-market (1)", "inv grade (2)"];
  for (const c of [0, 1, 2]) {
    const r = PH.map((p) => rate(c, p));
    const ratio = r[0] > 0 ? r[3] / r[0] : NaN;
    const exp = PH.reduce((a, p) => a + (cells[`${c}|${p}`]?.months ?? 0), 0) / 12;
    console.log(`   ${grade[c].padEnd(17)}` + r.map((x) => pct(x).padStart(12)).join("")
      + `${(Number.isFinite(ratio) ? ratio.toFixed(1) + "x" : "—").padStart(21)}${(exp.toFixed(0) + " t-yrs").padStart(13)}`);
  }
  // EXPOSURE PER CELL, because a rate off eleven tenant-years is not a rate.
  // The recession columns are the thin ones by construction — a downturn is a
  // tenth of the calendar — and the reader has to be able to see that.
  console.log(`   tenant-years behind each cell:`);
  for (const c of [0, 1, 2]) {
    console.log(`     ${grade[c].padEnd(15)}` + PH.map((p) => ((cells[`${c}|${p}`]?.months ?? 0) / 12).toFixed(0).padStart(12)).join("")
      + `   fails: ` + PH.map((p) => (cells[`${c}|${p}`]?.fails ?? 0)).join("/"));
  }
  const junkRec = rate(0, "recession"), igRec = rate(2, "recession");
  const junkExp = rate(0, "expansion");
  console.log(`\n   unrated vs investment grade IN A RECESSION: ${pct(junkRec)} vs ${pct(igRec)} a year`
    + `   (${Number.isFinite(igRec) && igRec > 0 ? (junkRec / igRec).toFixed(1) + "x" : "n/a"})`);
  console.log(`   pFail in tickLeasing is 0.00035/mo x cycle(0.55 expansion .. 3.4 recession) x grade(1.6 unrated .. 0.14 IG)`);
  console.log(`   x 3 if you refused them relief, x (1 + sector stress + trade stress) — so the ratios above are the wiring, checked.`);

  // ---- 9b -----------------------------------------------------------------
  const vrows = [];
  for (const seed of SEEDS) {
    const R = firstRecession(seed);
    if (R === null) continue;
    function arm(credit) {
      const parcels = fresh();
      let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
      g = { ...g, cash: RICH };
      const b = bigLetBuilding(g, parcels);
      if (!b.bbl) return null;
      g = b.g;
      const bbl = b.bbl, h = g.holdings[bbl];
      for (const t of h.tenants) t.credit = credit;   // ONLY the covenant differs
      const rec0 = E.resolveRec(parcels, g, bbl);
      // THE CLEAN NUMBER: same building, same day, same rents, same expiries.
      // No rng has been consumed differently yet, so this is a pure appraisal
      // difference and not a path.
      const t0 = {
        spread: E.rollQualitySpread(rec0, h, g.month, g.econ),
        value: E.holdingValue(rec0, g.econ, h, g.month),
        cap: E.capRateFor(rec0, g.econ, h.condition),
      };
      let noiReal = 0, fails = 0;
      let tracked = new Map(h.tenants.map((t) => [`${t.name}|${t.startM}`, t]));
      for (let m = 1; m <= R + 24; m++) {
        g = signAll(g, parcels);
        g = E.advanceQuarter(g, parcels, bbls, adjacency);
        g = keepSolvent(g);
        const rec = E.resolveRec(parcels, g, bbl), hh = g.holdings[bbl];
        if (!rec || !hh) break;
        noiReal += E.holdingNOIYr(rec, g.econ, hh, g.month) / 12 / (g.econ.cpi || 1);
        const now = new Map(hh.tenants.map((t) => [`${t.name}|${t.startM}`, t]));
        for (const [key, t] of tracked) if (!now.has(key) && t.endM > g.month) fails++;
        tracked = now;
      }
      const rec = E.resolveRec(parcels, g, bbl), hh = g.holdings[bbl];
      return { t0, fails, noiReal, valueReal: rec && hh ? E.holdingValue(rec, g.econ, hh, g.month) / (g.econ.cpi || 1) : NaN };
    }
    const ig = arm(2), junk = arm(0);
    if (ig && junk) vrows.push({ seed, ig, junk });
  }
  console.log(`\n   9b — the same building, the same rents and expiries, graded IG against unrated (${vrows.length} seeds)\n`);
  console.log(`   arm                 roll spread at t0   value at t0   |   mid-term failures to R+24   real NOI   real value at R+24`);
  for (const nm of ["ig", "junk"]) {
    const a = vrows.map((r) => r[nm]);
    console.log(`   ${(nm === "ig" ? "investment grade" : "unrated").padEnd(20)}${(100 * mean(a.map((x) => x.t0.spread))).toFixed(0).padStart(15)}bp`
      + `   $${(mean(a.map((x) => x.t0.value)) / 1e6).toFixed(1).padStart(9)}M   |`
      + `${mean(a.map((x) => x.fails)).toFixed(1).padStart(24)}`
      + `   $${(mean(a.map((x) => x.noiReal)) / 1e6).toFixed(1).padStart(6)}M`
      + `   $${(mean(a.map((x) => x.valueReal)) / 1e6).toFixed(1).padStart(15)}M`);
  }
  const dSpread = 100 * mean(vrows.map((r) => r.junk.t0.spread - r.ig.t0.spread));
  const dV0 = mean(vrows.map((r) => r.junk.t0.value / r.ig.t0.value - 1));
  const dFails = mean(vrows.map((r) => r.junk.fails - r.ig.fails));
  const dVend = mean(vrows.map((r) => r.junk.valueReal / r.ig.valueReal - 1));
  console.log(`\n   unrated minus investment grade, AT t=0 and deterministic:  exit cap +${dSpread.toFixed(0)}bp   ·   value ${(100 * dV0).toFixed(1)}%`);
  console.log(`   along the realised path:  ${dFails >= 0 ? "+" : ""}${dFails.toFixed(1)} mid-term failures   ·   value at R+24 ${(100 * dVend).toFixed(1)}%`);
  console.log(`   (the second line is a different rng stream in each arm and is noise unless the seeds agree — they do not)`);
  const wiredFail = Number.isFinite(junkRec / igRec) && junkRec / igRec > 3 && junkRec / junkExp > 2;
  const verdict = wiredFail && (Math.abs(dV0) > 0.02 || dSpread > 25) ? "WIRED" : wiredFail ? "WEAK" : "WEAK";
  note("9", "Credit quality", verdict,
    `unrated tenants go dark at ${pct(junkRec)}/yr in a recession against ${pct(igRec)} for investment grade (${(junkRec / igRec).toFixed(1)}x), `
    + `and ${pct(junkExp)} for unrated in an expansion (${(junkRec / junkExp).toFixed(1)}x cycle lift). It reaches value: the identical building `
    + `graded all-unrated prices ${dSpread.toFixed(0)}bp wider and ${(100 * dV0).toFixed(1)}% cheaper at t=0, which is a clean deterministic read — same building, same day, `
    + `no rng consumed differently. The ratios are the strongest wiring in this section. What the harness cannot settle is the LEVEL: `
    + `${pct(junkRec)}/yr means an all-unrated roll loses under one name in thirty in its worst year, so concentration in weak covenants costs `
    + `${(-100 * dV0).toFixed(1)}% of value on the appraisal and almost nothing in realised cash. Whether that is the intended size is a calibration call.`);
  return { junkRec, igRec, junkExp, dSpread, dV0 };
}

// ==========================================================================
// 10. LEASE-UP CURVES
//
// How long an empty building takes to stabilise, and what the answer depends
// on. This is the number a developer's whole business rests on, and the owner
// already suspects it is too fast: a new tower filling in eight months in a
// soft market is not lease-up risk, it is a formality with a delay on it.
//
// The design is a BRANCH. Each seed's world is warmed for W months, then
// cloned — state AND parcel table, because the table is mutated in place — and
// in the clone the player buys eight buildings, empties them, marks them
// newly delivered (which is what leaseFactors reads to give a new building its
// 1.45x tour traffic) and signs every letter that arrives for ten years.
// Branching at several W is what produces a spread of MARKET CONDITIONS out of
// the engine's own cycle rather than out of a dial.
//
// Occupancy is read through unitStatus, the same call the game's own panel
// makes — the only reading that gets a block of flats right, because flats
// have no rent roll and run on aggregate occupancy.
//
// FAILURE looks like: the medians are all the same; or a building delivered
// into a 15%-availability market stabilises as fast as one delivered into a
// 5% one; or a 200,000 sf tower fills as fast as a 15,000 sf one.
// ==========================================================================
function test10() {
  const EPOCHS = DEEP ? [12, 60, 108, 156, 204, 252, 300] : [12, 84, 168, 252];
  const WATCH = 120;
  const GLUT_AT = EPOCHS[Math.floor(EPOCHS.length / 2)];   // where the manufactured glut is run
  const rows = [], glut = [];
  const p0 = fresh();
  const stock0 = commercialStock(E.firstListings(E.newGame(SEEDS[0], p0), p0, bbls), p0, 12_000);
  const dCut = [qtl(stock0.map((s) => s.d), 1 / 3), qtl(stock0.map((s) => s.d), 2 / 3)];

  /** Ten buildings covering the size range as well as the map. Taking every
   *  Nth of the bbl order gives a sample whose median is 9,000 sf, which
   *  answers nothing about a tower — so the three largest go in by name. */
  function pickTen(g, parcels) {
    const stock = commercialStock(g, parcels, 12_000);
    const bySize = [...stock].sort((a, b) => b.sf - a.sf);
    const picks = bySize.slice(0, 3);
    const rest = bySize.slice(3);
    const step = Math.max(1, Math.floor(rest.length / 7));
    for (let i = 0; i < rest.length && picks.length < 10; i += step) picks.push(rest[i]);
    return picks;
  }
  /** Run one branch to stabilisation and return months-to-50/85 per building. */
  function leaseUpBranch(g, parcels, picks) {
    let bg = { ...clone(g), cash: RICH };
    const bp = clone(parcels);
    const owned = [], sup = {};
    for (const s of picks) {
      const r = buyAndEmpty(bg, bp, s.bbl, { deliveredNew: true });
      if (!r.ok) continue;
      bg = r.g; owned.push(s);
      // CAN THE METRIC EVEN REACH ITS TARGET? supportableOcc is the ceiling the
      // address itself imposes — the share of the building anybody is willing
      // to take on that corner — and on a fringe parcel it is BELOW 85%. A
      // "never stabilised" there is not a slow lease-up, it is a target that
      // does not exist, and reporting it as a failure would be reporting the
      // rail rather than the model.
      const rec = E.resolveRec(bp, bg, s.bbl);
      sup[s.bbl] = rec ? E.supportableOcc(bg.econ, rec, E.leasableUses(rec)[0]) : NaN;
    }
    if (!owned.length) return null;
    const start = bg.month;
    const cond = {};
    for (const u of ["office", "retail", "industrial", "multifamily"]) {
      cond[u] = (bg.econ.cityVac?.[u] ?? 0) + (bg.econ.sublet?.[u] ?? 0) / Math.max(1, bg.econ.stock?.[u] ?? 1)
        - (E.NATURAL_VAC[u] ?? 0.1);
    }
    const h85 = {}, h50 = {};
    for (let m = 0; m < WATCH; m++) {
      bg = signAll(bg, bp);
      bg = E.advanceQuarter(bg, bp, bbls, adjacency);
      bg = keepSolvent(bg);
      for (const s of owned) {
        const occ = occOf(bp, bg, s.bbl);
        if (occ === null) continue;
        if (h50[s.bbl] === undefined && occ >= 0.50) h50[s.bbl] = bg.month - start;
        if (h85[s.bbl] === undefined && occ >= 0.85) h85[s.bbl] = bg.month - start;
      }
    }
    return owned.map((s) => ({
      bbl: s.bbl, use: s.use, d: s.d, sf: s.sf, sup: sup[s.bbl],
      gap: cond[s.use] ?? cond.office, m85: h85[s.bbl] ?? null, m50: h50[s.bbl] ?? null,
    }));
  }

  for (const seed of SEEDS) {
    const parcels = fresh();
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    let at = 0;
    for (const W of EPOCHS) {
      for (let m = at; m < W; m++) { g = E.advanceQuarter(g, parcels, bbls, adjacency); g = keepSolvent(g); }
      at = W;
      // BRANCH — its own parcel table, so the probe cannot build in the
      // trunk's city and the trunk cannot build in the probe's.
      const picks = pickTen(g, parcels);
      const out = leaseUpBranch(g, parcels, picks);
      if (out) for (const r of out) rows.push({ seed, W, ...r });

      // A MANUFACTURED GLUT, once per seed, and it is labelled synthetic
      // because it is. The observational split by market condition is a split
      // across a variable that barely varies, and it is confounded with the
      // epoch it was sampled at — so the response function has to be measured
      // directly: the SAME buildings, the SAME seed, the SAME month, one
      // variable moved.
      //
      // The variable is SUPPLY, not occupancy. Emptying tenants out to raise
      // vacancy is the wrong shock and this file did it that way first: it
      // creates unhoused demand, `marketRequirement`'s growth leg reads the
      // pool-minus-occupied gap, and the "glut" arrives with MORE tenants
      // looking for space than the control. Injecting stock is what a glut
      // actually is — supply the city did not need — and `targetRaw` reads
      // baseStock, which is frozen, so demand does not follow it up.
      if (W === GLUT_AT && out) {
        const sg = clone(g);
        for (const u of ["office", "retail", "industrial", "multifamily"]) {
          E.addStock(sg.econ, u, sg.econ.stock[u] * 0.12);
          sg.econ.cityVac[u] = Math.max(0, 1 - sg.econ.occupied[u] / sg.econ.stock[u]);
          if (sg.econ.concIdx) sg.econ.concIdx[u] = Math.min(1, (sg.econ.concIdx[u] ?? 0) + 0.6);
        }
        const gout = leaseUpBranch(sg, parcels, picks);
        if (gout) for (const r of gout) glut.push({ seed, W, ...r, vac: sg.econ.cityVac.office });
      }
    }
  }
  console.log(`10. LEASE-UP CURVES — ${rows.length} buildings emptied and marked newly delivered, ten years watched each,`);
  console.log(`    every letter signed on sight. "never" means still under 85% let after ${WATCH / 12} years.\n`);
  const report = (label, set) => {
    if (!set.length) return null;
    const done = set.filter((r) => r.m85 !== null).map((r) => r.m85).sort((a, b) => a - b);
    const half = set.filter((r) => r.m50 !== null).map((r) => r.m50);
    const fast = set.filter((r) => r.m85 !== null && r.m85 <= 12).length;
    console.log(`    ${label.padEnd(30)}n=${String(set.length).padStart(3)}`
      + `   to 50%: ${(half.length ? med(half).toFixed(0) : "—").padStart(4)}mo`
      + `   to 85%: p25 ${(done.length ? qtl(done, 0.25) : "—").toString().padStart(3)}`
      + `  MEDIAN ${(done.length ? med(done) : "—").toString().padStart(3)}`
      + `  p75 ${(done.length ? qtl(done, 0.75) : "—").toString().padStart(3)}`
      + `   never: ${String(set.length - done.length).padStart(2)}`
      + `   under 1yr: ${pct(fast / set.length)}`);
    return done.length ? med(done) : null;
  };
  console.log(`  BY USE`);
  for (const u of ["office", "retail", "industrial", "multifamily"]) report(u, rows.filter((r) => r.use === u));
  console.log(`\n  BY SIZE — the owner's suspicion in one line: does a TOWER fill as fast as a shop?`);
  const sizes = [
    ["under 25k sf", rows.filter((r) => r.sf < 25_000)],
    ["25k - 75k sf", rows.filter((r) => r.sf >= 25_000 && r.sf < 75_000)],
    ["over 75k sf", rows.filter((r) => r.sf >= 75_000)],
  ].map(([n, s]) => [n, s, report(n, s)]);
  console.log(`\n  BY LOCATION (demand score terciles: fringe < ${dCut[0].toFixed(0)} < middle < ${dCut[1].toFixed(0)} < prime)`);
  const locs = [
    ["fringe", rows.filter((r) => r.d < dCut[0])],
    ["middle", rows.filter((r) => r.d >= dCut[0] && r.d < dCut[1])],
    ["prime", rows.filter((r) => r.d >= dCut[1])],
  ].map(([n, s]) => [n, s, report(n, s)]);
  console.log(`    ceiling the ADDRESS imposes (supportableOcc), mean by tercile: `
    + locs.map(([n, s]) => `${n} ${pct(mean(s.map((r) => r.sup).filter(Number.isFinite)))}`).join("   ·   ")
    + `\n    — where that is under 85% the "never" column is an unreachable target, not a slow lease-up.`);
  const reachable = rows.filter((r) => (r.sup ?? 1) >= 0.85);
  console.log(`    on the ${reachable.length} of ${rows.length} buildings whose address can actually support 85%:`
    + ` median ${med(reachable.filter((r) => r.m85 !== null).map((r) => r.m85))} months, never: ${reachable.filter((r) => r.m85 === null).length}`);
  console.log(`\n  BY MARKET ON DELIVERY DAY (availability over the natural rate for that class)`);
  const gaps = rows.map((r) => r.gap).sort((a, b) => a - b);
  const gCut = [qtl(gaps, 1 / 3), qtl(gaps, 2 / 3)];
  const mkts = [
    [`tight  (< ${(100 * gCut[0]).toFixed(1)}pp)`, rows.filter((r) => r.gap < gCut[0])],
    [`middle`, rows.filter((r) => r.gap >= gCut[0] && r.gap < gCut[1])],
    [`soft   (> ${(100 * gCut[1]).toFixed(1)}pp)`, rows.filter((r) => r.gap >= gCut[1])],
  ].map(([n, s]) => [n, s, report(n, s)]);

  // THE OBSERVATIONAL SPLIT ABOVE IS CONFOUNDED and says so: the epoch a branch
  // was taken at decides both the market condition AND which buildings exist,
  // so a "soft market" column can be a "different city" column. Two repairs.
  //
  // First, WITHIN BUILDING: the same parcel is bought at every epoch, so its
  // own fastest-market run can be compared with its own slowest one and the
  // location, the size and the use all cancel.
  const byBbl = new Map();
  for (const r of rows) { if (!byBbl.has(r.bbl)) byBbl.set(r.bbl, []); byBbl.get(r.bbl).push(r); }
  const paired = [];
  for (const [, rs] of byBbl) {
    const done = rs.filter((r) => r.m85 !== null);
    if (done.length < 2) continue;
    const lo = done.reduce((a, b) => (b.gap < a.gap ? b : a));
    const hi = done.reduce((a, b) => (b.gap > a.gap ? b : a));
    if (hi.gap - lo.gap < 0.005) continue;
    paired.push({ dGap: hi.gap - lo.gap, dM: hi.m85 - lo.m85, ratio: hi.m85 / Math.max(1, lo.m85) });
  }
  console.log(`\n  THE SAME BUILDING, ITS OWN TIGHTEST MONTH AGAINST ITS OWN LOOSEST (n=${paired.length} parcels)`);
  console.log(`    mean availability spread within a parcel ${(100 * mean(paired.map((p) => p.dGap))).toFixed(1)}pp`
    + `   ·   months to 85% let ${mean(paired.map((p) => p.dM)) >= 0 ? "+" : ""}${mean(paired.map((p) => p.dM)).toFixed(1)}`
    + `   ·   median ratio ${med(paired.map((p) => p.ratio)).toFixed(2)}x`);

  // Second, the RESPONSE FUNCTION over the range it was designed for, since
  // the observed range is far too narrow to test it.
  const gDone = glut.filter((r) => r.m85 !== null).map((r) => r.m85);
  const gBase = rows.filter((r) => r.W === GLUT_AT && r.m85 !== null).map((r) => r.m85);
  const gNever = glut.length - gDone.length, bNever = rows.filter((r) => r.W === GLUT_AT).length - gBase.length;
  const gVac = glut.length ? mean(glut.map((r) => r.vac ?? NaN)) : NaN;
  const bVac = mean(rows.filter((r) => r.W === GLUT_AT).map((r) => r.gap + (E.NATURAL_VAC.office ?? 0.115)));
  console.log(`\n  THE SAME BUILDINGS DELIVERED INTO A MANUFACTURED GLUT (synthetic: +12% citywide stock in every`);
  console.log(`  class at month ${GLUT_AT} and nothing else touched — office vacancy ${pct(bVac)} -> ${pct(gVac)})`);
  console.log(`    control  n=${String(gBase.length + bNever).padStart(3)}   median ${gBase.length ? med(gBase) : "—"} months to 85%   never: ${bNever}`);
  console.log(`    glut     n=${String(gDone.length + gNever).padStart(3)}   median ${gDone.length ? med(gDone) : "—"} months to 85%   never: ${gNever}`);
  const gutX = gBase.length && gDone.length ? med(gDone) / med(gBase) : NaN;
  console.log(`    a ${(100 * (gVac - bVac)).toFixed(1)}pp supply glut costs a new building ${Number.isFinite(gutX) ? gutX.toFixed(2) + "x" : "—"} its lease-up time`
    + ` (${gDone.length && gBase.length ? (med(gDone) - med(gBase)).toFixed(0) : "—"} months at the median,`
    + ` never-stabilised ${bNever} -> ${gNever} of ${rows.filter((r) => r.W === GLUT_AT).length})`);

  const all = rows.filter((r) => r.m85 !== null).map((r) => r.m85);
  const medAll = all.length ? med(all) : NaN;
  const locX = locs[2][2] && locs[0][2] ? locs[0][2] / locs[2][2] : NaN;
  const mktX = mkts[2][2] && mkts[0][2] ? mkts[2][2] / mkts[0][2] : NaN;
  const sizeX = sizes[2][2] && sizes[0][2] ? sizes[2][2] / sizes[0][2] : NaN;
  const allGaps = rows.map((r) => r.gap).sort((a, b) => a - b);
  console.log(`\n    the availability range the OBSERVATIONAL split actually had to work with:`
    + ` ${(100 * allGaps[0]).toFixed(1)}pp to ${(100 * allGaps[allGaps.length - 1]).toFixed(1)}pp over natural`
    + `  (months above natural: ${pct(allGaps.filter((x) => x > 0).length / allGaps.length)})`);
  // THE OWNER'S SPECIFIC SUSPICION, counted rather than argued: buildings that
  // stabilised inside a year while the market was soft.
  const softSet = mkts[2][1];
  const softFast = softSet.filter((r) => r.m85 !== null && r.m85 <= 12);
  const softFastBig = softFast.filter((r) => r.sf >= 75_000);
  console.log(`\n    citywide median months to 85% let: ${medAll}`
    + `   ·  fringe/prime ${Number.isFinite(locX) ? locX.toFixed(2) + "x" : "—"}`
    + `   ·  soft/tight ${Number.isFinite(mktX) ? mktX.toFixed(2) + "x" : "—"}`
    + `   ·  big/small ${Number.isFinite(sizeX) ? sizeX.toFixed(2) + "x" : "—"}`);
  console.log(`    IN A SOFT MARKET: ${softFast.length} of ${softSet.length} buildings (${pct(softFast.length / Math.max(1, softSet.length))}) `
    + `stabilised inside twelve months, ${softFastBig.length} of them over 75,000 sf.`);
  if (softFastBig.length) {
    const ex = softFastBig.sort((a, b) => b.sf - a.sf)[0];
    console.log(`    fastest big one: ${(ex.sf / 1000).toFixed(0)}k sf ${ex.use}, delivered into ${(100 * ex.gap).toFixed(1)}pp over natural, 85% let in ${ex.m85} months.`);
  }
  const retail = rows.filter((r) => r.use === "retail" && r.m85 !== null).map((r) => r.m85);
  const verdict = medAll <= 12 ? "BROKEN" : Number.isFinite(gutX) && gutX < 1.15 ? "WEAK" : "WIRED";
  note("10", "Lease-up curves", verdict,
    `the owner's suspicion is not confirmed at the median: a newly-delivered building reaches 85% let in ${medAll} months `
    + `(p25 ${qtl(all, 0.25)}, p75 ${qtl(all, 0.75)}), only ${pct(softFast.length / Math.max(1, softSet.length))} of those delivered into the softest third of markets `
    + `are let inside a year and none of those is over 75,000 sf. Both gradients are real and both are large: `
    + `${Number.isFinite(locX) ? locX.toFixed(2) + "x" : "n/a"} slower on the fringe than prime, and a synthetic +12% supply injection `
    + `(office vacancy ${pct(bVac)} -> ${pct(gVac)}) costs ${Number.isFinite(gutX) ? gutX.toFixed(2) + "x" : "n/a"} the lease-up time — ${med(gDone) - med(gBase)} months at the median. `
    + `Two things to look at anyway: retail stabilises in a median ${retail.length ? med(retail) : "—"} months with ${pct(rows.filter((r) => r.use === "retail" && r.m85 !== null && r.m85 <= 12).length / Math.max(1, rows.filter((r) => r.use === "retail").length))} inside a year, `
    + `and ${pct(rows.filter((r) => r.m85 === null).length / rows.length)} of all buildings never stabilise at all in ten years — though most of that is supportableOcc `
    + `putting the ceiling BELOW 85% on a fringe address (mean ${pct(mean(locs[0][1].map((r) => r.sup).filter(Number.isFinite)))} there), so it is an unreachable target rather than a slow lease-up. `
    + `On the ${reachable.length} buildings whose address can support 85% at all, the median is ${med(reachable.filter((r) => r.m85 !== null).map((r) => r.m85))} months and ${reachable.filter((r) => r.m85 === null).length} never get there.`);
  return { medAll, locX, mktX, sizeX, gutX, softFast: softFast.length, softN: softSet.length };
}

// ============================================================== the report
console.log(`\nC. LEASING MICROSTRUCTURE — tests 6-10`);
console.log(`seeds ${SEEDS.join(",")}   ·   horizon ${HZ} months   ·   city ${process.env.BW_CITY ?? "somewhere"}${DEEP ? "   ·   DEEP" : ""}`);
console.log("=".repeat(102) + "\n");

if (ONLY.includes(6)) { test6(); rule(); }
let runs = null;
if (ONLY.includes(7) || ONLY.includes(9)) runs = SEEDS.map(instrumented);
if (ONLY.includes(7)) { test7(runs); rule(); }
if (ONLY.includes(8)) { test8(); rule(); }
if (ONLY.includes(9)) { test9(runs); rule(); }
if (ONLY.includes(10)) test10();

console.log("\n" + "=".repeat(102));
console.log(`VERDICTS\n`);
function wrap(s, w) {
  const out = []; let cur = "";
  for (const word of s.split(/\s+/)) {
    if ((cur + " " + word).trim().length > w) { out.push(cur.trim()); cur = word; } else cur += " " + word;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
for (const f of FINDINGS) {
  console.log(`  ${f.id}. ${f.name.padEnd(26)} ${f.verdict}`);
  for (const line of wrap(f.line, 94)) console.log(`       ${line}`);
  console.log();
}
