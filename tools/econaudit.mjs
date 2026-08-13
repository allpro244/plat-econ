// THE ECONOMY AUDIT.
//
//   pnpm audit                    the whole battery, writes ECONOMY_AUDIT.md
//   pnpm audit --only=4,5,13      a subset, by experiment number
//   SEEDS=5 pnpm audit            more seeds
//   AUDIT_JOBS=6 pnpm audit       parallelism across worker processes
//
// The brief this answers: prove the simulation is intertwined, or show exactly
// where it is not. Every experiment is a CONTROL and a TREATMENT on the same
// seed and the same city, differing in one injected change, run for fifty
// years. Propagation is measured in the fifteen years after injection, because
// over fifty years paired runs drift apart from compounding alone and the
// signal drowns; the full-horizon number is reported beside it so you can see
// whether the city also ended up somewhere sensibly different.
//
// It is written to be adversarial. Where a wire does not transmit, the verdict
// is BROKEN and the number is printed; where it transmits the wrong way, the
// verdict is BACKWARDS, which is worse.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  E, USES, MONTHS, run, city, diverge, verdict, fmtDiv, med, mean, pct, path,
  ringsAround, pickEpicentre, RING_NAMES, districtsOf,
} from "./econaudit-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "ECONOMY_AUDIT.md");
const SEEDS = Number(process.env.SEEDS ?? 3);
const CITY_SEED = Number(process.env.CITY_SEED ?? 20261);
const MARKET_SEEDS = [550991, 12007, 73303, 11, 22, 4242, 90210].slice(0, SEEDS);
const INJECT_AT = 120;                     // year 10: past the opening transient
const WINDOW = 180;                        // fifteen years of propagation
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7)
  .split(",").filter(Boolean).map(Number);
const wanted = (n) => !only.length || only.includes(n);

const log = (...a) => console.log(...a);
const md = [];
const say = (s) => { md.push(s); };

// ---------------------------------------------------------------------------
// control runs, cached: every experiment on a seed diffs against the same one
// ---------------------------------------------------------------------------
const controls = new Map();
function control(ms, groups) {
  const key = ms + ":" + (groups ? "rings" : "dist");
  if (!controls.has(key)) controls.set(key, run(CITY_SEED, ms, { sampleEvery: 1, groups }));
  return controls.get(key);
}

// ---------------------------------------------------------------------------
// THE OBSERVABLES, named once so the elasticity table and the experiments agree
// ---------------------------------------------------------------------------
const OBS = {
  "office rent": (r) => r.rent.office,
  "office eff rent": (r) => r.effRent.office,
  "office vacancy": (r) => r.vac.office,
  "office absorption": (r) => r.absorb.office,
  "office stock": (r) => r.stock.office,
  "office starts": (r) => r.starts.office,
  "office pipeline": (r) => r.pipeline.office,
  "mf rent": (r) => r.rent.multifamily,
  "mf vacancy": (r) => r.vac.multifamily,
  "mf starts": (r) => r.starts.multifamily,
  "retail rent": (r) => r.rent.retail,
  "retail vacancy": (r) => r.vac.retail,
  "land index": (r) => r.landIdx,
  "office cap rate": (r) => r.cap.office,
  "loan index": (r) => r.indexRate,
  "credit index": (r) => r.creditIdx,
  "construction cost": (r) => r.costIdx,
  "population": (r) => r.population,
  "jobs": (r) => r.jobs,
  "unemployment": (r) => r.unemployment,
  "wage index": (r) => r.wageIdx,
  "CPI": (r) => r.cpi,
  "firms alive": (r) => r.rivalsAlive,
  "street AUM": (r) => r.rivalAum,
  "distress listings": (r) => r.distressListings,
};
// district/ring observables, resolved against a named group
const gObs = (name, f) => (r) => (r.dist[name] ? f(r.dist[name]) : NaN);

const ELASTICITY = [];   // {input, output, dir, mag, lag, verdict}
const cell = (input, output, d, expect, opts) => {
  const v = verdict(d, expect, opts);
  ELASTICITY.push({ input, output, peak: d.peak, lag: d.lag, endRel: d.endRel, verdict: v });
  return v;
};

const EXP = [];   // {n, title, verdict, lines[]}
const push = (n, title, v, lines) => { EXP.push({ n, title, verdict: v, lines }); log(`\n[${n}] ${title}: ${v}`); for (const l of lines) log("   " + l); };

// ---------------------------------------------------------------------------
// helper: run a treatment on every seed and median the divergences
// ---------------------------------------------------------------------------
function paired(inject, groups) {
  const rows = [];
  for (const ms of MARKET_SEEDS) {
    const c = control(ms, groups);
    const t = run(CITY_SEED, ms, { sampleEvery: 1, groups, inject });
    rows.push({ ms, c: c.series, t: t.series, cEnd: c.end, tEnd: t.end, cP: c.parcels, tP: t.parcels });
  }
  return rows;
}
function medDiv(rows, get, opts = {}) {
  const ds = rows.map((r) => diverge(r.c, r.t, get, { from: INJECT_AT, window: WINDOW, ...opts }));
  const pick = (k) => med(ds.map((d) => d[k]));
  const anyThin = ds.some((d) => d.thin);
  // the median divergence is reported with the lag of the seed nearest that median
  const target = pick("peak");
  let best = ds[0];
  for (const d of ds) if (Math.abs(d.peak - target) < Math.abs(best.peak - target)) best = d;
  return { peak: target, lag: best.lag, firstMove: pick("firstMove"), early: pick("early"),
           mid: pick("mid"), endRel: pick("endRel"), thin: anyThin, all: ds };
};

// ===========================================================================
// 1. LOCAL DEMAND SHOCK — a major employer lands on one block
// ===========================================================================
if (wanted(1)) {
  const base = city(CITY_SEED);
  const epi = pickEpicentre({ parcels: base.parcels, bbls: base.bbls }, "office");
  const groups = ringsAround(epi.centre);
  // A major employer is, in this model's own terms, a large and durable rise in
  // the demand a location can support. Applied to every parcel inside 400m,
  // decaying with distance, and HELD — a headquarters does not leave next year.
  const inject = (g, parcels, m, b) => {
    if (m < INJECT_AT) return;
    if (m === INJECT_AT) {
      for (const bb of b.bbls) {
        const r = parcels[bb];
        if (!r?.centroid) continue;
        const dx = (r.centroid[0] - epi.centre[0]) * 84_000, dy = (r.centroid[1] - epi.centre[1]) * 111_000;
        const dist = Math.hypot(dx, dy);
        if (dist > 400) continue;
        const k = 1 - dist / 400;
        r.demandScore = Math.min(100, r.demandScore + 26 * k);
        r._shocked = true;
      }
    }
  };
  const rows = paired(inject, groups);
  const lines = [`epicentre block ${epi.block}, mean demand ${epi.demand.toFixed(0)}/100 before the shock`];
  const rentD = {}, occD = {}, landD = {};
  for (const ring of RING_NAMES) {
    rentD[ring] = medDiv(rows, gObs(ring, (d) => d.rent.office));
    occD[ring] = medDiv(rows, gObs(ring, (d) => d.occ.office));
    landD[ring] = medDiv(rows, gObs(ring, (d) => d.land));
    lines.push(`${ring.padEnd(11)} rent ${fmtDiv(rentD[ring])}`);
    lines.push(`${" ".repeat(11)} occ  ${fmtDiv(occD[ring])}`);
    lines.push(`${" ".repeat(11)} land ${fmtDiv(landD[ring])}`);
  }
  const startsD = medDiv(rows, (r) => r.starts.office);
  lines.push(`citywide office starts ${fmtDiv(startsD)}`);
  // Judged on the IMPACT window, like every other direction call. Comparing
  // peaks compares late-horizon compounding drift, which has nothing to do with
  // whether the shock was local — it reported "not local" on a run whose inner
  // ring moved three times as hard as the outer one in the first three years.
  const decay = Math.abs(rentD.r0_150m.early) > Math.abs(rentD.r400_900m.early) * 1.25;
  lines.push(`distance decay present: ${decay ? "yes" : "NO — the effect is not local"}`);
  const vNear = cell("local demand +26", "local office rent", rentD.r0_150m, +1);
  cell("local demand +26", "local occupancy", occD.r0_150m, +1);
  const vLand = cell("local demand +26", "local land value", landD.r0_150m, +1);
  cell("local demand +26", "office starts", startsD, +1);
  const v = vNear === "WIRED" && vLand === "WIRED" ? "WIRED" : vNear === "BROKEN" ? "BROKEN" : "WEAK";
  push(1, "LOCAL DEMAND SHOCK", v, lines);
}

// ===========================================================================
// 2. NEGATIVE DEMAND SHOCK — a chunk of employment leaves
// ===========================================================================
if (wanted(2)) {
  // 12% of the city's jobs, gone and staying gone. employIdx is the engine's own
  // employment level and everything downstream of jobs reads it.
  const inject = (g, parcels, m) => {
    if (m === INJECT_AT) g.econ.employIdx *= 0.88;
    if (m > INJECT_AT) g.econ.employIdx = Math.min(g.econ.employIdx, g.econ.employIdx);
  };
  const rows = paired(inject);
  const dVac = medDiv(rows, (r) => r.vac.office);
  const dRent = medDiv(rows, (r) => r.rent.office);
  const dEff = medDiv(rows, (r) => r.effRent.office);
  const dPop = medDiv(rows, (r) => r.population);
  const dStarts = medDiv(rows, (r) => r.starts.office);
  const dLand = medDiv(rows, (r) => r.landIdx);
  const dDistress = medDiv(rows, (r) => r.distressListings);
  const lines = [
    `office vacancy   ${fmtDiv(dVac)}`,
    `office rent      ${fmtDiv(dRent)}`,
    `effective rent   ${fmtDiv(dEff)}   (should move FIRST and further than asking)`,
    `population       ${fmtDiv(dPop)}   (people leave a city with no work)`,
    `office starts    ${fmtDiv(dStarts)}`,
    `land index       ${fmtDiv(dLand)}`,
    `distress listings${fmtDiv(dDistress)}`,
    `effective led asking: ${Math.abs(dEff.peak) >= Math.abs(dRent.peak) ? "yes" : "NO — asking moved as much as effective, so concessions are not the shock absorber"}`,
  ];
  cell("employment -12%", "office vacancy", dVac, +1);
  cell("employment -12%", "office rent", dRent, -1);
  cell("employment -12%", "office eff rent", dEff, -1);
  cell("employment -12%", "population", dPop, -1);
  cell("employment -12%", "office starts", dStarts, -1);
  const vLand = cell("employment -12%", "land index", dLand, -1);
  const v = verdict(dVac, +1) === "WIRED" && verdict(dRent, -1) !== "BROKEN" ? (vLand === "BROKEN" ? "WEAK" : "WIRED") : "WEAK";
  push(2, "NEGATIVE DEMAND SHOCK", v, lines);
}

// ===========================================================================
// 3. SUPPLY SHOCK — 10% of citywide office dropped into one submarket
// ===========================================================================
if (wanted(3)) {
  const base = city(CITY_SEED);
  const epi = pickEpicentre({ parcels: base.parcels, bbls: base.bbls }, "office");
  const groups = ringsAround(epi.centre);
  const inject = (g, parcels, m, b) => {
    if (m !== INJECT_AT) return;
    const sf = Math.round((g.econ.stock.office ?? 6e6) * 0.10);
    // The building is REAL — it goes on a lot near the epicentre so the local
    // market sees it — and the citywide stock is told about it too, because a
    // submarket's glut is the city's glut when the submarket is the CBD.
    let host = null, hostD = 1e9;
    for (const bb of b.bbls) {
      const r = parcels[bb];
      if (!r?.centroid || (r.class !== "land" && r.bldgArea > 0)) continue;
      const dx = (r.centroid[0] - epi.centre[0]) * 84_000, dy = (r.centroid[1] - epi.centre[1]) * 111_000;
      const d = Math.hypot(dx, dy);
      if (d < hostD) { hostD = d; host = r; }
    }
    if (host) {
      host.class = "office"; host.bldgArea = sf; host.floors = 40;
      host.yearBuilt = 2000 + Math.floor(m / 12); host.mix = undefined;
    }
    E.addStock(g.econ, "office", sf);
  };
  const rows = paired(inject, groups);
  const lines = [];
  for (const ring of RING_NAMES.slice(0, 3)) {
    lines.push(`${ring.padEnd(11)} vac  ${fmtDiv(medDiv(rows, gObs(ring, (d) => 1 - d.occ.office)))}`);
    lines.push(`${" ".repeat(11)} rent ${fmtDiv(medDiv(rows, gObs(ring, (d) => d.rent.office)))}`);
    lines.push(`${" ".repeat(11)} land ${fmtDiv(medDiv(rows, gObs(ring, (d) => d.land)))}`);
  }
  const dVac = medDiv(rows, (r) => r.vac.office);
  const dEff = medDiv(rows, (r) => r.effRent.office);
  const dStarts = medDiv(rows, (r) => r.starts.office);
  const dMfStarts = medDiv(rows, (r) => r.starts.multifamily);
  lines.push(`citywide office vacancy ${fmtDiv(dVac)}`);
  lines.push(`citywide effective rent ${fmtDiv(dEff)}`);
  lines.push(`office starts           ${fmtDiv(dStarts)}   (nobody should build into this)`);
  lines.push(`multifamily starts      ${fmtDiv(dMfStarts)}   (control: a different use should be roughly unaffected)`);
  // FLIGHT TO QUALITY: does the OLDEST stock bleed most?
  const fq = [];
  for (const r of rows) {
    const oldOcc = { c: 0, t: 0, n: 0 }, newOcc = { c: 0, t: 0, n: 0 };
    for (const bb of Object.keys(r.cP)) {
      const cr = r.cP[bb], tr = r.tP[bb];
      if (!cr || !tr || cr.class !== "office" || !cr.bldgArea || tr._shocked) continue;
      const bucket = cr.yearBuilt < 1940 ? oldOcc : cr.yearBuilt > 1985 ? newOcc : null;
      if (!bucket) continue;
      bucket.c += E.occupancy(cr, r.cEnd.econ); bucket.t += E.occupancy(tr, r.tEnd.econ); bucket.n++;
    }
    if (oldOcc.n && newOcc.n) fq.push({ old: oldOcc.t / oldOcc.n - oldOcc.c / oldOcc.n, neu: newOcc.t / newOcc.n - newOcc.c / newOcc.n });
  }
  const oldHit = med(fq.map((x) => x.old)), newHit = med(fq.map((x) => x.neu));
  lines.push(`flight to quality at year 50: pre-1940 stock occupancy ${(oldHit * 100).toFixed(2)}pp vs post-1985 ${(newHit * 100).toFixed(2)}pp`);
  lines.push(`  the old stock bled more: ${oldHit < newHit ? "yes" : "NO — vintage does not decide who loses the tenant"}`);
  cell("+10% office stock", "office vacancy", dVac, +1);
  cell("+10% office stock", "office eff rent", dEff, -1);
  cell("+10% office stock", "office starts", dStarts, -1);
  const v = verdict(dVac, +1) === "WIRED" && verdict(dStarts, -1) !== "BROKEN" ? "WIRED" : "WEAK";
  push(3, "SUPPLY SHOCK", v, lines);
}

// ===========================================================================
// 4. RATE SHOCK — +300bps on the policy rate, held
// ===========================================================================
if (wanted(4)) {
  const inject = (g, parcels, m) => {
    if (m < INJECT_AT) return;
    const n = g.econ.nat;
    if (n) n.policy = Math.max(n.policy, (g.econ._shockFloor ??= n.policy + 3.0));
    g.econ.indexRate = Math.max(g.econ.indexRate, (g.econ._shockFloor ?? 0) + 1.55);
  };
  const rows = paired(inject);
  const dRate = medDiv(rows, (r) => r.indexRate);
  const dCap = medDiv(rows, (r) => r.cap.office);
  const dStarts = medDiv(rows, (r) => r.starts.office);
  const dPipe = medDiv(rows, (r) => r.pipeline.office);
  const dStock = medDiv(rows, (r) => r.stock.office);
  const dVac = medDiv(rows, (r) => r.vac.office);
  const dRent = medDiv(rows, (r) => r.rent.office);
  // THE ECHO. The whole test: does a financial shock reach future RENTS through
  // the supply pipeline? Measured late in the window, where the missing
  // deliveries should finally show up as a tighter market.
  const late = { from: INJECT_AT + 84, window: 96 };
  const dVacLate = medDiv(rows, (r) => r.vac.office, late);
  const dRentLate = medDiv(rows, (r) => r.rent.office, late);
  const lines = [
    `loan index       ${fmtDiv(dRate)}`,
    `office cap rate  ${fmtDiv(dCap)}   (cap rates must widen)`,
    `office starts    ${fmtDiv(dStarts)}   (development stops penciling)`,
    `pipeline         ${fmtDiv(dPipe)}`,
    `office stock     ${fmtDiv(dStock)}   (deliveries thin out, 2-3 yrs later)`,
    `--- the echo, years 7-15 after the shock ---`,
    `office vacancy   ${fmtDiv(dVacLate)}   (should TIGHTEN: negative)`,
    `office rent      ${fmtDiv(dRentLate)}   (should FIRM: positive)`,
    `whole-window vacancy ${fmtDiv(dVac)} · rent ${fmtDiv(dRent)}`,
    `ordering: starts moved at ${dStarts.firstMove}mo, stock at ${dStock.firstMove}mo, vacancy at ${dVacLate.firstMove}mo`,
  ];
  cell("policy +300bps", "office cap rate", dCap, +1);
  cell("policy +300bps", "office starts", dStarts, -1);
  cell("policy +300bps", "office stock", dStock, -1);
  const vEcho = cell("policy +300bps", "office vacancy (echo)", dVacLate, -1);
  cell("policy +300bps", "office rent (echo)", dRentLate, +1);
  const v = verdict(dStarts, -1) === "WIRED" && verdict(dStock, -1) !== "BROKEN"
    ? (vEcho === "WIRED" || vEcho === "WEAK" ? "WIRED" : "WEAK") : "WEAK";
  push(4, "RATE SHOCK AND THE SUPPLY ECHO", v, lines);
}

// ===========================================================================
// 5. CONSTRUCTION COST SHOCK — +30% hard costs
// ===========================================================================
if (wanted(5)) {
  const inject = (g, parcels, m) => { if (m === INJECT_AT) g.econ.costIdx *= 1.30; };
  const rows = paired(inject);
  const dCost = medDiv(rows, (r) => r.costIdx);
  const dStarts = medDiv(rows, (r) => r.starts.office);
  const dLand = medDiv(rows, (r) => r.landIdx);
  const dStock = medDiv(rows, (r) => r.stock.office);
  const late = { from: INJECT_AT + 84, window: 96 };
  const dVacLate = medDiv(rows, (r) => r.vac.office, late);
  const dRentLate = medDiv(rows, (r) => r.rent.office, late);
  // land as a residual, measured on the parcels themselves
  const landPsf = [];
  for (const r of rows) {
    let c = 0, t = 0, n = 0;
    for (const bb of Object.keys(r.cP)) {
      const cr = r.cP[bb], tr = r.tP[bb];
      if (!cr || !tr) continue;
      c += cr.landPsf || 0; t += tr.landPsf || 0; n++;
    }
    if (n) landPsf.push(t / c - 1);
  }
  const lines = [
    `construction cost ${fmtDiv(dCost)}`,
    `office starts     ${fmtDiv(dStarts)}`,
    `land index        ${fmtDiv(dLand)}   (RESIDUAL: cost up must push land down)`,
    `parcel landPsf at year 50, treatment vs control: ${(med(landPsf) * 100).toFixed(2)}%`,
    `office stock      ${fmtDiv(dStock)}`,
    `--- the missing supply, years 7-15 ---`,
    `office vacancy    ${fmtDiv(dVacLate)}   (should tighten)`,
    `office rent       ${fmtDiv(dRentLate)}   (should firm)`,
  ];
  cell("hard costs +30%", "office starts", dStarts, -1);
  const vLand = cell("hard costs +30%", "land index", dLand, -1);
  cell("hard costs +30%", "office stock", dStock, -1);
  cell("hard costs +30%", "office rent (echo)", dRentLate, +1);
  const v = verdict(dStarts, -1) === "BROKEN" ? "BROKEN" : vLand === "BROKEN" ? "WEAK" : "WIRED";
  push(5, "CONSTRUCTION COST SHOCK", v, lines);
}

// ===========================================================================
// 6. POPULATION SHOCK, both directions
// ===========================================================================
if (wanted(6)) {
  for (const [name, k, sign] of [["population +18%", 1.18, +1], ["population -18%", 0.82, -1]]) {
    const inject = (g, parcels, m) => { if (m === INJECT_AT) g.econ.population = Math.round(g.econ.population * k); };
    const rows = paired(inject);
    const dPop = medDiv(rows, (r) => r.population);
    const dMfVac = medDiv(rows, (r) => r.vac.multifamily);
    const dMfRent = medDiv(rows, (r) => r.rent.multifamily);
    const dMfStarts = medDiv(rows, (r) => r.starts.multifamily);
    const dRetRent = medDiv(rows, (r) => r.rent.retail);
    const dOffRent = medDiv(rows, (r) => r.rent.office);
    const dUnemp = medDiv(rows, (r) => r.unemployment);
    const lines = [
      `population      ${fmtDiv(dPop)}`,
      `unemployment    ${fmtDiv(dUnemp)}   (more people, same jobs, more slack)`,
      `mf vacancy      ${fmtDiv(dMfVac)}`,
      `mf rent         ${fmtDiv(dMfRent)}   (housing should answer FIRST)`,
      `mf starts       ${fmtDiv(dMfStarts)}`,
      `retail rent     ${fmtDiv(dRetRent)}   (people shop where they live — should follow, later)`,
      `office rent     ${fmtDiv(dOffRent)}   (should be the weakest of the three)`,
      `ordering: mf rent at ${dMfRent.firstMove}mo, retail rent at ${dRetRent.firstMove}mo`,
    ];
    cell(name, "mf rent", dMfRent, sign);
    cell(name, "mf starts", dMfStarts, sign);
    cell(name, "retail rent", dRetRent, sign);
    cell(name, "unemployment", dUnemp, sign);
    const v = verdict(dMfRent, sign) === "BROKEN" ? "BROKEN"
      : verdict(dRetRent, sign) === "BROKEN" ? "WEAK" : "WIRED";
    push(6, `POPULATION SHOCK · ${name}`, v, lines);
  }
}

// ===========================================================================
// 7. CROSS-ASSET SPILLOVERS
// ===========================================================================
if (wanted(7)) {
  // 7a. new multifamily in one place -> nearby retail should strengthen
  {
    const base = city(CITY_SEED);
    const epi = pickEpicentre({ parcels: base.parcels, bbls: base.bbls }, "retail");
    const groups = ringsAround(epi.centre);
    const inject = (g, parcels, m, b) => {
      if (m !== INJECT_AT) return;
      const sf = Math.round((g.econ.stock.multifamily ?? 4e6) * 0.12);
      let placed = 0;
      for (const bb of b.bbls) {
        const r = parcels[bb];
        if (!r?.centroid || (r.class !== "land" && r.bldgArea > 0)) continue;
        const dx = (r.centroid[0] - epi.centre[0]) * 84_000, dy = (r.centroid[1] - epi.centre[1]) * 111_000;
        if (Math.hypot(dx, dy) > 350) continue;
        r.class = "multifamily"; r.bldgArea = Math.round(sf / 4); r.floors = 14;
        r.unitsRes = Math.round(r.bldgArea / 900); r.yearBuilt = 2000 + Math.floor(m / 12);
        if (++placed >= 4) break;
      }
      E.addStock(g.econ, "multifamily", sf);
      g.econ.population = Math.round(g.econ.population * 1.06);   // the flats get filled
    };
    const rows = paired(inject, groups);
    const dRet = medDiv(rows, gObs("r0_150m", (d) => d.rent.retail));
    const dRetFar = medDiv(rows, gObs("r900m_plus", (d) => d.rent.retail));
    const dRetCity = medDiv(rows, (r) => r.rent.retail);
    const lines = [
      `nearby retail rent (<150m) ${fmtDiv(dRet)}`,
      `far retail rent (>900m)    ${fmtDiv(dRetFar)}`,
      `citywide retail rent       ${fmtDiv(dRetCity)}`,
      `local premium over far: ${(dRet.early - dRetFar.early > 0.01) ? "yes" : "NO — the spillover is not spatial"}`,
    ];
    const v = cell("+12% mf stock local", "nearby retail rent", dRet, +1);
    push(7, "SPILLOVER · housing → nearby retail", v, lines);
  }
  // 7b. empty the office district -> its street retail should suffer
  {
    const base = city(CITY_SEED);
    const epi = pickEpicentre({ parcels: base.parcels, bbls: base.bbls }, "office");
    const groups = ringsAround(epi.centre);
    const inject = (g, parcels, m, b) => {
      if (m < INJECT_AT) return;
      if (m === INJECT_AT) {
        for (const bb of b.bbls) {
          const r = parcels[bb];
          if (!r?.centroid || r.class !== "office") continue;
          const dx = (r.centroid[0] - epi.centre[0]) * 84_000, dy = (r.centroid[1] - epi.centre[1]) * 111_000;
          if (Math.hypot(dx, dy) > 400) continue;
          r.demandScore = Math.max(4, r.demandScore - 34);
        }
      }
      g.econ.employIdx *= m === INJECT_AT ? 0.93 : 1;
    };
    const rows = paired(inject, groups);
    const dOff = medDiv(rows, gObs("r0_150m", (d) => d.rent.office));
    const dRet = medDiv(rows, gObs("r0_150m", (d) => d.rent.retail));
    const dRetOcc = medDiv(rows, gObs("r0_150m", (d) => d.occ.retail));
    const lines = [
      `local office rent      ${fmtDiv(dOff)}`,
      `local retail rent      ${fmtDiv(dRet)}   (the lunch trade goes with the offices)`,
      `local retail occupancy ${fmtDiv(dRetOcc)}`,
      `ordering: office at ${dOff.firstMove}mo, retail at ${dRet.firstMove}mo`,
    ];
    const v = cell("local office demand -34", "nearby retail rent", dRet, -1);
    push(7, "SPILLOVER · office district emptied → street retail", v, lines);
  }
}

// ===========================================================================
// 8. CONTRADICTION SCAN
// ===========================================================================
if (wanted(8)) {
  const counts = { vacUpRentUp: 0, negAbsRentUp: 0, buildIntoGlut: 0, landUpDemandDown: 0, total: 0 };
  for (const ms of MARKET_SEEDS) {
    const c = control(ms);
    for (let i = 13; i < c.series.length; i++) {
      const a = c.series[i], b = c.series[i - 12];
      for (const u of USES) {
        counts.total++;
        const vacUp = a.vac[u] - b.vac[u] > 0.02;
        const rentUp = a.effRent[u] / Math.max(1e-9, b.effRent[u]) - 1 > 0.02;
        if (vacUp && a.vac[u] > 0.16 && rentUp) counts.vacUpRentUp++;
        const abs12 = a.occupied[u] - b.occupied[u];
        if (abs12 < 0 && rentUp) counts.negAbsRentUp++;
        if (a.starts[u] > 0 && a.vac[u] > 0.18) counts.buildIntoGlut++;
      }
      if (a.landIdx > b.landIdx * 1.02 && a.employIdx < b.employIdx && a.starts.office === 0) counts.landUpDemandDown++;
    }
  }
  const rate = (n) => `${n} (${((n / counts.total) * 100).toFixed(2)}% of use-months)`;
  const lines = [
    `use-months examined: ${counts.total} across ${MARKET_SEEDS.length} unshocked 50-year runs`,
    `vacancy >16% AND rising AND effective rent rising yoy : ${rate(counts.vacUpRentUp)}`,
    `negative 12-month absorption AND effective rent rising: ${rate(counts.negAbsRentUp)}`,
    `construction starting into >18% local-use vacancy    : ${rate(counts.buildIntoGlut)}`,
    `land index rising while employment falls and nothing starts: ${counts.landUpDemandDown}`,
  ];
  const worst = Math.max(counts.vacUpRentUp, counts.negAbsRentUp, counts.buildIntoGlut) / counts.total;
  push(8, "CONTRADICTION SCAN", worst > 0.06 ? "BROKEN" : worst > 0.02 ? "WEAK" : "WIRED", lines);
}

// ===========================================================================
// 9. CYCLE COHERENCE
// ===========================================================================
if (wanted(9)) {
  const lines = [];
  const lagStats = [], rentFall = [], deliverInBust = [];
  for (const ms of MARKET_SEEDS) {
    const c = control(ms).series;
    // cross-correlate starts against rent at lags 0..48: where does starts peak
    // relative to the rent peak?
    const rent = path(c, (r) => r.rent.office), starts = path(c, (r) => r.starts.office);
    const z = (a) => { const m = mean(a), s = Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1; return a.map((x) => (x - m) / s); };
    const zr = z(rent), zs = z(starts);
    let best = -2, bestLag = 0;
    for (let L = -24; L <= 36; L++) {
      let acc = 0, n = 0;
      for (let i = Math.max(0, -L); i < c.length - Math.max(0, L); i++) { acc += zr[i + Math.max(0, L)] * zs[i + Math.max(0, -L)]; n++; }
      const r = acc / n;
      if (r > best) { best = r; bestLag = L; }
    }
    lagStats.push(bestLag);
    // do effective rents actually fall in recessions?
    let inRec = 0, recFall = 0;
    for (let i = 12; i < c.length; i++) {
      if (c[i].phase !== "recession") continue;
      inRec++;
      if (c[i].effRent.office < c[i - 12].effRent.office) recFall++;
    }
    rentFall.push(inRec ? recFall / inRec : NaN);
    // do deliveries land in the downturn?
    let dRec = 0, dAll = 0;
    for (let i = 1; i < c.length; i++) { const d = c[i].deliver.office; dAll += d; if (c[i].phase === "recession" || c[i].phase === "peak") dRec += d; }
    deliverInBust.push(dAll ? dRec / dAll : NaN);
  }
  lines.push(`starts lead/lag vs rent: median ${med(lagStats)} months (positive = starts LEAD the rent peak, which is what a pro forma written on last year's rent produces)`);
  lines.push(`months in recession where 12-month effective rent change was NEGATIVE: ${pct(med(rentFall))}`);
  lines.push(`share of all deliveries landing in peak or recession: ${pct(med(deliverInBust))} (supply SHOULD overshoot into the downturn)`);
  const ok = med(rentFall) > 0.5 && med(deliverInBust) > 0.2;
  push(9, "CYCLE COHERENCE", ok ? "WIRED" : "WEAK", lines);
}

// ===========================================================================
// 11. DEAD KNOB AUDIT
// ===========================================================================
const KNOBS = [
  ["econ.indexRate", (g) => { g.econ.indexRate *= 1.5; }],
  ["econ.creditIdx", (g) => { g.econ.creditIdx *= 0.6; }],
  ["econ.costIdx", (g) => { g.econ.costIdx *= 1.3; }],
  ["econ.cpi", (g) => { g.econ.cpi *= 1.3; }],
  ["econ.wageIdx", (g) => { g.econ.wageIdx *= 1.3; }],
  ["econ.employIdx", (g) => { g.econ.employIdx *= 0.85; }],
  ["econ.population", (g) => { g.econ.population = Math.round(g.econ.population * 1.2); }],
  ["econ.unemployment", (g) => { g.econ.unemployment = Math.min(0.25, g.econ.unemployment * 1.8); }],
  ["econ.landIdx", (g) => { g.econ.landIdx *= 1.4; }],
  ["econ.cycleDev", (g) => { g.econ.cycleDev = -0.9; }],
  ["econ.tightEma", (g) => { g.econ.tightEma = 0.5; }],
  ["econ.slackEma (derived)", (g) => { g.econ.slackEma = 0.08; }, true],
  ["econ.inflExp", (g) => { g.econ.inflExp = 0.09; }],
  ["econ.rateEma", (g) => { g.econ.rateEma = (g.econ.rateEma ?? 5) * 2; }],
  // WAS `econ.buildEma`, WHICH IS NO LONGER THE WIRE. The cost of building
  // used to price off the share of stock under construction; that quantity was
  // rationed by a hard crew ceiling before it reached the price, so it could
  // not tell a boom from an ordinary year. The trades now price off how booked
  // they are, and these are the two knobs that carry it: how oversubscribed the
  // order book is, and how many crews the town has attracted.
  ["econ.crewUtil", (g) => { g.econ.crewUtil = 1.8; }],
  ["econ.crewIdx", (g) => { g.econ.crewIdx = 2.0; }],
  ["econ.rentExp.office", (g) => { g.econ.rentExp.office *= 1.4; }],
  ["econ.sectorMom.office", (g) => { g.econ.sectorMom.office = -0.01; }],
  ["econ.concIdx.office", (g) => { g.econ.concIdx.office = 0.6; }],
  // DERIVED, NOT STATE — and therefore not a knob at all.
  //
  // These three are recomputed from other state at the TOP of every tick,
  // before anything reads them: slackEma from the stock-weighted vacancy gap,
  // supplyPress from deliveries over stock, vacOverM from the vacancy gap.
  // Perturbing them is overwritten before it can influence a single decision,
  // which is why they came back at exactly 0.00% even when the perturbation
  // was HELD for three years. That is not a dead wire, it is a value that
  // cannot be poked, and calling it dead is a false accusation in a report
  // whose entire worth is that its accusations are true. What actually needs
  // testing is the input each is computed from, and each of those is tested
  // elsewhere in this battery: vacancy in experiments 2 and 3, deliveries in
  // 4 and 5. Marked so the sweep reports them honestly instead of loudly.
  ["econ.vacOverM.office (derived)", (g) => { g.econ.vacOverM.office = 24; }, true],
  ["econ.supplyPress (derived)", (g) => { if (g.econ.supplyPress) for (const u of USES) g.econ.supplyPress[u] = 0.5; }, true],
  ["econ.affordEff", (g) => { if (g.econ.affordEff) for (const u of USES) g.econ.affordEff[u] = 0.6; }],
  ["econ.pool", (g) => { if (g.econ.pool) for (const u of USES) g.econ.pool[u] *= 1.5; }],
  ["econ.nat.credibility", (g) => { if (g.econ.nat) g.econ.nat.credibility = 0.12; }],
  ["econ.nat.neutralReal", (g) => { if (g.econ.nat) g.econ.nat.neutralReal = 0.028; }],
  ["econ.industryMom", (g) => { if (g.econ.industryMom) for (const k of Object.keys(g.econ.industryMom)) g.econ.industryMom[k] = -0.3; }],
  ["econ.vintageMean", (g) => { if (g.econ.vintageMean !== undefined) g.econ.vintageMean -= 30; }],
  ["econ.locIdxMean", (g) => { if (g.econ.locIdxMean !== undefined) g.econ.locIdxMean *= 1.4; }],
  ["parcel.demandScore", (g, p, m, b) => { for (const bb of b.bbls) if (p[bb]) p[bb].demandScore = Math.min(100, p[bb].demandScore * 1.35); }],
  ["parcel.landPsf", (g, p, m, b) => { for (const bb of b.bbls) if (p[bb]) p[bb].landPsf *= 1.5; }],
  ["parcel.yearBuilt", (g, p, m, b) => { for (const bb of b.bbls) if (p[bb]?.yearBuilt) p[bb].yearBuilt = Math.max(1886, p[bb].yearBuilt - 45); }],
  ["parcel.floors", (g, p, m, b) => { for (const bb of b.bbls) if (p[bb]?.floors) p[bb].floors = Math.max(1, Math.round(p[bb].floors * 0.6)); }],
  ["parcel.farMaxComm", (g, p, m, b) => { for (const bb of b.bbls) if (p[bb]) p[bb].farMaxComm *= 1.8; }],
  ["parcel.lotArea", (g, p, m, b) => { for (const bb of b.bbls) if (p[bb]) p[bb].lotArea *= 1.4; }],
];
if (wanted(11)) {
  const DEAD_SEEDS = MARKET_SEEDS.slice(0, 2);
  const results = [];
  for (const [name, fn, derived] of KNOBS) {
    const ds = [];
    for (const ms of DEAD_SEEDS) {
      const c = control(ms);
      // HELD FOR THREE YEARS, NOT POKED ONCE.
      //
      // Four fields came back "dead" in the first sweep and two of them —
      // vacOverM and supplyPress — are recomputed unconditionally from other
      // state on the very next tick (`supplyPress[k] = delivered / stk`), so a
      // one-shot perturbation is erased before it can influence anything. That
      // is not a dead knob, it is an untestable one, and reporting it as dead
      // is a false failure in a report whose whole value is that its failures
      // are real. Holding the perturbation asks the question that actually
      // matters — does this value influence anything downstream while it is
      // held? — and it is the right question for the EMAs too, whose one-shot
      // perturbation decays away before the slow parts of the economy notice.
      const t = run(CITY_SEED, ms, {
        sampleEvery: 1,
        inject: (g, p, m, b) => { if (m >= INJECT_AT && m < INJECT_AT + 36) fn(g, p, m, b); },
      });
      // "did ANYTHING downstream move" — the widest net we can cast
      const probes = ["office rent", "office vacancy", "office starts", "land index",
                      "mf rent", "retail rent", "office cap rate", "jobs", "population",
                      "construction cost", "street AUM"];
      // MAGNITUDE IS NOT THE POINT HERE and it is not trustworthy: starts sit
      // at zero most months, so a relative divergence against a near-zero
      // control mean reads as 275% and means "it moved". The only question
      // this experiment asks is DID ANYTHING MOVE AT ALL, so thin series are
      // skipped when a thicker one also responded.
      let best = 0, bestName = "", bestThick = 0, bestThickName = "";
      for (const p of probes) {
        const d = diverge(c.series, t.series, OBS[p], { from: INJECT_AT, window: WINDOW });
        if (Math.abs(d.peak) > Math.abs(best)) { best = d.peak; bestName = p; }
        if (!d.thin && Math.abs(d.peak) > Math.abs(bestThick)) { bestThick = d.peak; bestThickName = p; }
      }
      if (bestThickName) { best = bestThick; bestName = bestThickName; }
      ds.push({ best, bestName });
    }
    const m = med(ds.map((d) => Math.abs(d.best)));
    results.push({ name, mag: m, via: ds[0].bestName, derived: !!derived, dead: !derived && m < 0.004 });
    log(`   knob ${name.padEnd(24)} ${(m * 100).toFixed(2)}% via ${ds[0].bestName}${m < 0.004 ? "   <-- DEAD" : ""}`);
  }
  const dead = results.filter((r) => r.dead);
  const derivedN = results.filter((r) => r.derived).length;
  push(11, "DEAD KNOB AUDIT", dead.length === 0 ? "WIRED" : dead.length < 4 ? "WEAK" : "BROKEN",
    [`${KNOBS.length} fields perturbed and held for 3 years · ${dead.length} moved nothing measurable · ${derivedN} are derived intra-tick and cannot be perturbed at all (their inputs are tested elsewhere)`,
     ...results.map((r) => `${r.derived ? "deriv " : r.dead ? "DEAD  " : "live  "} ${r.name.padEnd(24)} peak downstream ${(r.mag * 100).toFixed(2)}% (via ${r.via})`)]);
  globalThis.__deadKnobs = results;
}

// ===========================================================================
// 13. LONG-HORIZON STABILITY (and 12's narrative data)
// ===========================================================================
if (wanted(13) || wanted(12)) {
  const traces = [];
  const rails = [];
  for (const ms of MARKET_SEEDS) {
    const c = control(ms).series;
    const first = c[0], last = c[c.length - 1];
    const yrs = MONTHS / 12;
    const cagr = (a, b) => (Math.pow(b / Math.max(1e-9, a), 1 / yrs) - 1) * 100;
    const realRent = cagr(first.rent.office / first.cpi, last.rent.office / last.cpi);
    traces.push({
      ms,
      cpi: last.cpi, realOfficeRent: realRent,
      realLand: cagr(first.landIdx / first.cpi, last.landIdx / last.cpi),
      realCost: cagr(first.costIdx / first.cpi, last.costIdx / last.cpi),
      vacMin: Math.min(...c.map((r) => r.vac.office)), vacMax: Math.max(...c.map((r) => r.vac.office)),
      vacMean: mean(c.map((r) => r.vac.office)),
      ageStart: mean(Object.values(first.dist).map((d) => d.age)),
      ageEnd: mean(Object.values(last.dist).map((d) => d.age)),
      stockGrowth: last.stock.office / first.stock.office - 1,
      firmsStart: first.rivalsAlive, firmsEnd: last.rivalsAlive,
      aumSpread: last.rivalAum,
      lendersFailed: last.lendersFailed,
    });
    // RAIL CHECK: a variable pinned at its own bound for years is a dead
    // simulation wearing a live one's clothes.
    const railed = [];
    const checks = [["office vac", (r) => r.vac.office, 0.0, 0.60], ["mf vac", (r) => r.vac.multifamily, 0.0, 0.60],
                    ["credit idx", (r) => r.creditIdx, 0.40, 1.25], ["loan index", (r) => r.indexRate, 1.45, 23.0],
                    ["unemployment", (r) => r.unemployment, 0.015, 0.26], ["employ idx", (r) => r.employIdx, 0.55, 12]];
    for (const [nm, f, lo, hi] of checks) {
      const v = path(c, f);
      let stuckLo = 0, stuckHi = 0, runLo = 0, runHi = 0;
      for (const x of v) {
        runLo = Math.abs(x - lo) < 1e-6 ? runLo + 1 : 0; stuckLo = Math.max(stuckLo, runLo);
        runHi = Math.abs(x - hi) < 1e-6 ? runHi + 1 : 0; stuckHi = Math.max(stuckHi, runHi);
      }
      if (stuckLo > 24 || stuckHi > 24) railed.push(`${nm} stuck at ${stuckLo > 24 ? "floor" : "ceiling"} for ${Math.max(stuckLo, stuckHi)} months`);
    }
    rails.push(...railed);
  }
  const lines = [
    `real office rent growth, 50y: ${traces.map((t) => t.realOfficeRent.toFixed(2) + "%").join("  ")}  median ${med(traces.map((t) => t.realOfficeRent)).toFixed(2)}%/yr`,
    `real land index growth:       ${traces.map((t) => t.realLand.toFixed(2) + "%").join("  ")}  median ${med(traces.map((t) => t.realLand)).toFixed(2)}%/yr`,
    `real construction cost:       ${traces.map((t) => t.realCost.toFixed(2) + "%").join("  ")}  median ${med(traces.map((t) => t.realCost)).toFixed(2)}%/yr`,
    `CPI at year 50:               ${traces.map((t) => t.cpi.toFixed(2) + "x").join("  ")}`,
    `office vacancy min/mean/max:  ${traces.map((t) => `${pct(t.vacMin)}/${pct(t.vacMean)}/${pct(t.vacMax)}`).join("  ")}`,
    `office stock growth:          ${traces.map((t) => pct(t.stockGrowth)).join("  ")}`,
    `mean building age yr0 -> yr50:${traces.map((t) => `${t.ageStart.toFixed(0)}->${t.ageEnd.toFixed(0)}`).join("  ")}  (should NOT rise by ~50)`,
    `firms alive start -> end:     ${traces.map((t) => `${t.firmsStart}->${t.firmsEnd}`).join("  ")}`,
    `lender seizures over 50y:     ${traces.map((t) => t.lendersFailed).join("  ")}`,
    rails.length ? `RAILS HIT: ${[...new Set(rails)].join(" · ")}` : `no variable stuck at a rail for more than 2 years`,
  ];
  const ageRise = med(traces.map((t) => t.ageEnd - t.ageStart));
  const realRentOk = Math.abs(med(traces.map((t) => t.realOfficeRent))) < 2.5;
  const vacOk = traces.every((t) => t.vacMean > 0.03 && t.vacMean < 0.30);
  const firmsOk = traces.every((t) => t.firmsEnd > 3);
  const v = realRentOk && vacOk && firmsOk && !rails.length && ageRise < 40 ? "WIRED"
    : realRentOk && vacOk && firmsOk ? "WEAK" : "BROKEN";
  lines.push(`mean building age rose ${ageRise.toFixed(0)} years over 50 — turnover ${ageRise > 40 ? "IS NOT HAPPENING" : "is happening"}`);
  push(13, "LONG-HORIZON STABILITY", v, lines);
  globalThis.__traces = traces;
}

// ===========================================================================
// 12. NARRATIVE — the three most eventful districts, told from the data
// ===========================================================================
if (wanted(12)) {
  const c = control(MARKET_SEEDS[0]);
  const s = c.series;
  const names = Object.keys(s[0].dist);
  const score = names.map((n) => {
    const rent = s.map((r) => r.dist[n].rent.office).filter(Number.isFinite);
    const land = s.map((r) => r.dist[n].land);
    const rng = (a) => (Math.max(...a) - Math.min(...a)) / Math.max(1e-9, mean(a));
    return { n, sc: rng(rent) + rng(land) };
  }).sort((a, b) => b.sc - a.sc);
  const narr = [];
  for (const { n } of score.slice(0, 3)) {
    const at = (i) => s[Math.min(i, s.length - 1)];
    const d = (i) => at(i).dist[n];
    const peakI = s.reduce((bi, r, i) => (r.dist[n].rent.office > s[bi].dist[n].rent.office ? i : bi), 0);
    const troughAfter = s.slice(peakI).reduce((bi, r, i) => (r.dist[n].rent.office < s[peakI + bi].dist[n].rent.office ? i : bi), 0) + peakI;
    narr.push({
      name: n,
      y0: { rent: d(0).rent.office, occ: d(0).occ.office, land: d(0).land, age: d(0).age },
      peak: { y: (peakI / 12).toFixed(0), rent: d(peakI).rent.office, occ: d(peakI).occ.office, land: d(peakI).land, phase: at(peakI).phase, vac: at(peakI).vac.office, starts12: mean(s.slice(Math.max(0, peakI - 12), peakI).map((r) => r.starts.office)) },
      trough: { y: (troughAfter / 12).toFixed(0), rent: d(troughAfter).rent.office, occ: d(troughAfter).occ.office, land: d(troughAfter).land, phase: at(troughAfter).phase },
      end: { rent: d(s.length - 1).rent.office, occ: d(s.length - 1).occ.office, land: d(s.length - 1).land, age: d(s.length - 1).age },
      cpiEnd: s[s.length - 1].cpi,
    });
  }
  globalThis.__narr = narr;
  push(12, "NARRATIVE TEST", "see ECONOMY_AUDIT.md", narr.map((x) =>
    `${x.name}: rent ${x.y0.rent.toFixed(0)} -> peak ${x.peak.rent.toFixed(0)} (yr ${x.peak.y}) -> trough ${x.trough.rent.toFixed(0)} (yr ${x.trough.y}) -> ${x.end.rent.toFixed(0)}; land ${x.y0.land.toFixed(0)} -> ${x.end.land.toFixed(0)}`));
}

// ===========================================================================
// THE REPORT
// ===========================================================================
{
  const now = new Date(0).toISOString();
  say(`# ECONOMY AUDIT — Broadway & Wall`);
  say(``);
  say(`Generated by \`pnpm audit\` · ${MARKET_SEEDS.length} market seeds × ${MONTHS / 12} sim years · city seed ${CITY_SEED} · shocks injected at month ${INJECT_AT} (year ${INJECT_AT / 12}) · propagation window ${WINDOW / 12} years.`);
  say(``);
  say(`Every experiment is a paired run: a CONTROL and a TREATMENT on the same seed and the same city, differing in exactly one injected change. Divergence is reported as the peak relative difference inside the propagation window, the month it peaked (the lag), and the difference at the end of the full fifty years.`);
  say(``);
  say(`**Verdicts.** WIRED — transmits in the right direction with material magnitude. WEAK — transmits but barely. BROKEN — nothing moved. BACKWARDS — moved the wrong way, which is worse than nothing.`);
  say(``);

  say(`## Elasticity table`);
  say(``);
  say(`Rows are what was shocked; columns are what moved. Each cell is peak relative change / lag in months. Empty means nothing propagated.`);
  say(``);
  const inputs = [...new Set(ELASTICITY.map((e) => e.input))];
  const outputs = [...new Set(ELASTICITY.map((e) => e.output))];
  say(`| shock \\ response | ${outputs.join(" | ")} |`);
  say(`|---|${outputs.map(() => "---").join("|")}|`);
  for (const i of inputs) {
    const cells = outputs.map((o) => {
      const e = ELASTICITY.find((x) => x.input === i && x.output === o);
      if (!e) return "";
      if (e.verdict === "BROKEN") return "· none";
      const mark = e.verdict === "BACKWARDS" ? " **BACKWARDS**" : e.verdict === "WEAK" ? " _weak_" : "";
      return `${e.peak >= 0 ? "+" : ""}${(e.peak * 100).toFixed(1)}% / ${e.lag}mo${mark}`;
    });
    say(`| ${i} | ${cells.join(" | ")} |`);
  }
  say(``);

  say(`## Experiments`);
  for (const e of EXP) {
    say(``);
    say(`### ${e.n}. ${e.title} — **${e.verdict}**`);
    say(``);
    say("```");
    for (const l of e.lines) say(l);
    say("```");
  }

  if (globalThis.__narr) {
    say(``);
    say(`## Narrative test — three districts, told from the data alone`);
    for (const x of globalThis.__narr) {
      say(``);
      say(`**${x.name}.** Office asking rent opened at $${x.y0.rent.toFixed(0)}/sf against ${pct(x.y0.occ)} occupancy, on land assessed at $${x.y0.land.toFixed(0)}/sf, in a district whose buildings already averaged ${x.y0.age.toFixed(0)} years old. `
        + `It ran to $${x.peak.rent.toFixed(0)} by year ${x.peak.y} with occupancy at ${pct(x.peak.occ)} and citywide office vacancy down at ${pct(x.peak.vac)} — the market was in ${x.peak.phase}, and the city had been starting ${Math.round(x.peak.starts12).toLocaleString()} sf a month of office into it for the previous year. `
        + `That supply arrived: by year ${x.trough.y} the rent was $${x.trough.rent.toFixed(0)} and occupancy ${pct(x.trough.occ)}, with the market in ${x.trough.phase}. `
        + `Land followed the income it could support, from $${x.y0.land.toFixed(0)}/sf to $${x.end.land.toFixed(0)}/sf across the fifty years. `
        + `It finished at $${x.end.rent.toFixed(0)}/sf and ${pct(x.end.occ)} occupancy against a price level ${x.cpiEnd.toFixed(2)}x its opening, with an average building age of ${x.end.age.toFixed(0)} years.`);
    }
  }

  if (globalThis.__deadKnobs) {
    const dead = globalThis.__deadKnobs.filter((k) => k.dead);
    say(``);
    say(`## Dead knobs`);
    say(``);
    if (!dead.length) say(`None — every perturbed field moved something downstream.`);
    else { say(`| field | peak downstream response |`); say(`|---|---|`); for (const k of dead) say(`| \`${k.name}\` | ${(k.mag * 100).toFixed(2)}% — nothing |`); }
  }

  say(``);
  say(`## Ranked gaps`);
  say(``);
  const gaps = [];
  for (const e of EXP) if (e.verdict === "BACKWARDS") gaps.push([0, `**${e.title}** transmits BACKWARDS.`]);
  for (const e of EXP) if (e.verdict === "BROKEN") gaps.push([1, `**${e.title}** does not transmit at all.`]);
  for (const c of ELASTICITY) if (c.verdict === "BACKWARDS") gaps.push([0, `\`${c.input}\` → \`${c.output}\` moves the WRONG WAY (${(c.peak * 100).toFixed(1)}%).`]);
  for (const c of ELASTICITY) if (c.verdict === "BROKEN") gaps.push([2, `\`${c.input}\` → \`${c.output}\` is a dead wire.`]);
  for (const e of EXP) if (e.verdict === "WEAK") gaps.push([3, `**${e.title}** transmits, but barely.`]);
  gaps.sort((a, b) => a[0] - b[0]);
  if (!gaps.length) say(`None found by this battery.`);
  else gaps.forEach((g, i) => say(`${i + 1}. ${g[1]}`));
  say(``);

  writeFileSync(OUT, md.join("\n") + "\n");
  log(`\nwrote ${OUT}`);
}
