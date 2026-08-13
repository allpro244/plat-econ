// DOES THE CYCLE RUN IN THE RIGHT ORDER.
//
//   pnpm leadlag                                 four towns, fifty years
//   N=8 HZ=720 pnpm leadlag                      more of both
//   ENGINE=test/.engine-base.mjs pnpm leadlag    the other arm of an A/B
//
// Every other harness in this repo measures a LEVEL — how far rent falls, what
// dirt costs, how many sites pencil. A level can be tuned. Somebody who wants a
// number to come out right can reach it from a dozen directions, and this repo
// has a file full of warnings about exactly that.
//
// An ORDERING cannot be tuned, because nobody sets it. It is a consequence of
// the wiring: construction takes time, space takes time to let, landlords take
// time to reprice, and buyers take time to notice. If those four delays are
// modelled, the peaks arrive in a fixed order with fixed gaps and no constant
// anywhere in the engine says so. If they are not modelled — if the loop is
// instantaneous — everything peaks in the same month and the "cycle" is the
// sampling frequency wearing a business cycle's clothes.
//
// So this is the cheapest honest test of whether the economy is simulated or
// arranged, and it is the one nobody has run.
//
// THE ORDER A PROPERTY CYCLE RUNS IN, and roughly the gaps:
//
//   starts      ->  deliveries   BUILD_MONTHS, 22-34 in this engine
//   deliveries  ->  vacancy      fast; space arrives empty
//   vacancy     ->  rent         6-18 months; leases roll, they do not reprice
//   rent        ->  value        0-6 months; the cap rate moves with the tape
//   value       ->  starts       long and loose, 12-36 months; this closes the
//                                loop and its length is what sets the period
//
// A NEGATIVE lag means the wire runs backwards, which CLAUDE.md calls worse
// than a broken one. A lag of ZERO on a pair that should be separated means the
// two are the same variable with two names.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = Number(process.env.N ?? 4);
const HZ = Number(process.env.HZ ?? 600);
const K = process.env.CLASS ?? "office";
const MAXLAG = 60;

const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

/**
 * Smooth, then difference, then z-score.
 *
 * The smoothing is not cosmetic and leaving it out gave a wrong answer. A
 * property cycle has a period of years; a monthly first difference of a series
 * that slow is almost entirely the high-frequency noise sitting on top of it,
 * and the cross-correlation then picks whichever spurious peak is largest. The
 * first run of this file reported vacancy leading rent by MINUS fifty-eight
 * months at r = 0.18 — which is not a finding, it is a coin landing on its
 * edge. A centred 12-month mean removes the month-to-month and leaves the
 * cycle, which is the thing being asked about.
 */
const SMOOTH = 12;
/**
 * ...AND A FLOW IS NOT A LEVEL. Differencing them both was the second thing
 * this file got wrong, and it broke the control leg, which is exactly what a
 * control is for.
 *
 * `starts` and `deliveries` are square feet PER MONTH — they are already rates
 * of change, and differencing them again asks when the ACCELERATION of
 * groundbreaking predicts the ACCELERATION of completion, which is a question
 * about noise. Vacancy, rent and the cap rate are levels, and their cycles live
 * in their changes. Treated correctly the control reads the build period back;
 * treated identically it reported r = 0.12 on a leg that is a literal clock.
 */
function prep(a, isFlow) {
  const sm = a.map((_, i) => {
    const lo = Math.max(0, i - SMOOTH / 2), hi = Math.min(a.length, i + SMOOTH / 2 + 1);
    let s = 0; for (let j = lo; j < hi; j++) s += a[j];
    return s / (hi - lo);
  });
  const d = [];
  if (isFlow) d.push(...sm);
  else for (let i = 1; i < sm.length; i++) d.push(sm[i] - sm[i - 1]);
  const m = d.reduce((x, y) => x + y, 0) / Math.max(1, d.length);
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, d.length)) || 1;
  return d.map((v) => (v - m) / sd);
}
const IS_FLOW = { orders: true, breaks: true, deliv: true, vac: false, rent: false, value: false };

/** Correlation of x at time t with y at time t+lag. Positive lag = x LEADS y. */
function xcorr(x, y, lag) {
  let s = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= y.length) continue;
    s += x[i] * y[j]; n++;
  }
  return n > 12 ? s / n : 0;
}

/**
 * The lag at which x leads y most strongly, searching both directions.
 *
 * `sign` is which way the pair is supposed to move together, and it is not a
 * detail — it was the third thing this file got wrong. Vacancy and rent are
 * NEGATIVELY related: space empties, rent falls. Searching for the largest
 * POSITIVE correlation therefore finds the anti-phase point half a cycle away
 * and pins against the search boundary, which is how this reported "vacancy
 * leads rent by minus sixty months" — a number that is just MAXLAG with a sign
 * on it. A lag pinned at the edge of the window is never a measurement.
 */
function bestLag(x, y, sign = 1) {
  let best = -Infinity, at = 0;
  for (let l = -MAXLAG; l <= MAXLAG; l++) {
    const c = xcorr(x, y, l) * sign;
    if (c > best) { best = c; at = l; }
  }
  return { lag: at, r: best };
}

/**
 * THE LAG, POOLED ACROSS TOWNS — AND HOW SHARPLY IT IS IDENTIFIED AT ALL.
 *
 * This file used to take the argmax in EACH town and then median the four
 * answers. That is only sound if each town's profile has a peak, and for at
 * least one leg it does not. Measured, `orders -> breaks`: the pooled profile
 * is a broad single hump from -24 to +36 months with r moving only between
 * 0.25 and 0.31, and the four per-town argmaxes came out at 1, 22, 7 and -31
 * months. Medianing four coin tosses is not an estimator, and it is why this
 * leg once read "-34mo BACKWARDS" under a change that could not plausibly have
 * inverted it — and why the TOTAL LOOP, which sums those same argmaxes,
 * inherited the noise and halved.
 *
 * Averaging the correlation over towns FIRST and then taking the argmax uses
 * every town to locate one peak, which is the ordinary way to estimate a lag
 * from several realisations of the same process.
 *
 * And the WIDTH is reported, because a peak that is not a peak must say so. The
 * plateau is every lag whose correlation is within `FLAT` of the maximum; when
 * that plateau is wider than the band being tested, the argmax inside it
 * carries no information and the verdict is UNIDENTIFIED rather than a number.
 */
const FLAT = 0.02;
function pooledLag(xs, ys, sign = 1) {
  let best = -Infinity, at = 0;
  const prof = [];
  for (let l = -MAXLAG; l <= MAXLAG; l++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xcorr(xs[i], ys[i], l) * sign;
    const r = s / xs.length;
    prof.push([l, r]);
    if (r > best) { best = r; at = l; }
  }
  const plateau = prof.filter(([, r]) => r >= best - FLAT).map(([l]) => l);
  return { lag: at, r: best, width: plateau.length ? Math.max(...plateau) - Math.min(...plateau) : 0 };
}

// THE CHAIN, AND "STARTS" IS TWO DIFFERENT THINGS.
//
// Using one series for both ends of it was the fifth thing this file got wrong.
// The DECISION to build (the order book, `e.starts`) and the SHOVEL going in
// (a job appearing in `cityJobs`) are separated by the queue, and they behave
// differently: orders are a smooth quota, groundbreaks are lumpy. Measuring the
// control leg off orders mixed in the teardown and rival paths that never touch
// the order book and read 53 months against a 34-month build; measuring the
// loop-closing leg off groundbreaks made it too sparse to identify at all
// (r = 0.21, pinned at the search boundary). Both legs are real and they need
// their own series.
//
// Deliveries are counted GROSS, off the job records, rather than as the change
// in stock — net stock change subtracts demolitions, and a month where the
// wrecking ball outpaced the cranes was being recorded as zero deliveries.
const series = { orders: [], breaks: [], deliv: [], vac: [], rent: [], value: [] };
for (let i = 0; i < N; i++) {
  const { parcels, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  let g = E.firstListings(E.newGame(9001 + i, parcels), parcels, bbls);
  const s = { orders: [], breaks: [], deliv: [], vac: [], rent: [], value: [] };
  const seen = new Set();
  const dueAt = new Map();
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ, cpi = e.cpi || 1;
    // ORDERS: square feet the market asked for this month, before a site is picked.
    s.orders.push(e.starts?.[K] ?? 0);
    // BREAKS / DELIVERIES off the authoritative deliveryQueue — player and
    // city jobs share one clock. Measuring cityJobs alone hid player supply
    // and disagreed with settleSupplyDeliveries (HANDOFF #1).
    let broke = 0;
    for (const p of g.econ.deliveryQueue ?? []) {
      if (!p.bbl || p.status === "cancelled") continue;
      const key = p.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const sf = Math.max(0, Math.round(p.sfByUse?.[K] ?? 0));
      if (sf > 0) {
        broke += sf;
        dueAt.set(p.deliverM, (dueAt.get(p.deliverM) ?? 0) + sf);
      }
    }
    s.breaks.push(broke);
    // DELIVERIES: gross from the queue's due dates. Completions12 is smoothed;
    // dueAt tracks the same projects as settleSupplyDeliveries.
    s.deliv.push(dueAt.get(g.month) ?? 0);
    s.vac.push(e.cityVac?.[K] ?? 0);
    s.rent.push((e.effRentIdx?.[K] ?? e.rentIdx[K]) / cpi);
    // THE ASSET MARKET HAS TO BE MEASURED BY SOMETHING RENT IS NOT MADE OF.
    // The first run of this used rentIdx / capRate and duly reported that rent
    // leads value by exactly zero months at r = 0.83 — which it must, because
    // that series IS rent divided by a slow-moving number. The cap rate is the
    // asset market's own variable and is free to lag. Inverted so "up" means
    // "value up" and the correlation signs still read as the table says.
    s.value.push(-e.capRate[K]);
  }
  for (const k of Object.keys(series)) series[k].push(prep(s[k], IS_FLOW[k]));
}

// [x, y, lo, hi, sign, why]. `sign` is which way the pair moves together — see
// bestLag. Vacancy against rent is the only negative one and getting it wrong
// cost this file two runs.
const [buildLo, buildHi] = E.BUILD_MONTHS[K];
const PAIRS = [
  ["value", "orders", 6, 42, +1, "the asset market tells the space market to order more"],
  ["orders", "breaks", 0, E.ENTITLE_MONTHS[1] + E.CONSTRUCTION_CLOSE_M, +1,
    "the queue: entitlement, design, a site, a lender, then closing"],
  // This is a literal clock, not a calibration band. Read the engine's
  // class-specific construction schedule so the harness cannot claim that a
  // 44-month office job is "too slow" while BUILD_MONTHS explicitly permits it.
  ["breaks", "deliv", buildLo, buildHi, +1, "the build period — a literal clock, and the control"],
  ["deliv", "vac", 0, 18, +1, "space arrives empty, so simultaneous is CORRECT here"],
  ["vac", "rent", 3, 24, -1, "leases roll; landlords do not reprice on a vacancy print"],
  ["rent", "value", 0, 12, +1, "the cap rate moves with the tape"],
];

console.log(`\nDOES THE CYCLE RUN IN THE RIGHT ORDER — ${K}, ${N} towns x ${HZ / 12} years\n`);
console.log(`  ${pad("x leads y", 22)}${rp("lag", 7)}${rp("r", 8)}${rp("expected", 12)}   verdict`);
let bad = 0;
for (const [a, b, lo, hi, sign, why] of PAIRS) {
  const { lag: med, r, width } = pooledLag(series[a], series[b], sign);
  // A weak correlation means the lag is not identified at all, and reporting a
  // number for it would be reporting the largest of sixty noise peaks.
  const verdict = Math.abs(r) < 0.25 ? "NO SIGNAL"
    : Math.abs(med) >= MAXLAG ? "UNIDENTIFIED"
    // A plateau wider than the band it is being judged against means the
    // argmax inside it is arbitrary. Report that rather than a number.
    : width > (hi - lo) + 12 ? "UNIDENTIFIED"
    : med < -1 ? "BACKWARDS"
    : Math.abs(med) <= 1 ? (lo === 0 ? "ok" : "SIMULTANEOUS")
    : med < lo ? "too fast" : med > hi ? "too slow" : "ok";
  if (verdict !== "ok") bad++;
  console.log(`  ${pad(a + " -> " + b, 22)}${rp(med + "mo", 7)}${rp(r.toFixed(2), 8)}${rp(lo + "-" + hi + "mo", 12)}   ${verdict}${width > 24 ? `   (plateau ${width}mo wide — weakly identified)` : ""}`);
  console.log(`  ${pad("", 22)}${pad("", 27)}   ${why}`);
}

// The loop length is the sum of the legs, and it is what sets the period of the
// whole cycle. Nothing in the engine states it; it can only be added up.
const loop = PAIRS.reduce((a, [x, y, , , sg]) => a + pooledLag(series[x], series[y], sg).lag, 0);
console.log(`\n  TOTAL LOOP: ${loop} months (${(loop / 12).toFixed(1)} years) from a start to its effect on the`);
console.log(`  decision to start again. Real property cycles run 7-12 years and the loop`);
console.log(`  length is why. No constant in this engine sets this number.`);
console.log(`\n  ${bad === 0 ? "Every leg is in order." : bad + " leg(s) out of order — see above."}`);
console.log(`  BACKWARDS is the serious one: a wire that transmits the wrong way is a`);
console.log(`  fake that also lies. SIMULTANEOUS means the two are one variable with`);
console.log(`  two names, and the cycle it produces is the sampling rate, not a market.\n`);
