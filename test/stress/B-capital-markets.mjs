// B. CAPITAL MARKETS — is the money side a simulation or a set of dials?
//
//   node test/stress/B-capital-markets.mjs
//   SEEDS=550991,12007 YRS=25 node test/stress/B-capital-markets.mjs   a cheap pass
//   SEEDS=... YRS=100 HOLD_Y=30 REFI_Y=50 node ...                     a deep one
//
// Five questions, and each one is a way this economy could be fake:
//
//   1. CAP RATE / RATE SPREAD.  If the yield on a building does not move against
//      the price of money, then fix-or-float, when-to-buy and whether-to-lever
//      are all weather rather than judgement. If the spread sits persistently
//      NEGATIVE, leverage is a law against itself rather than a phase of the
//      cycle, and the game has quietly banned a strategy instead of pricing it.
//   2. LEVERAGE.  The same building, the same seed, at three advance rates.
//      High leverage should win expansions and be destroyed in downturns. If it
//      ALWAYS wins, debt is underpriced. If it NEVER wins, debt is overpriced.
//      Either way the capital-structure decision is not a decision.
//   3. REFINANCE ARBITRAGE.  The classic exploit of this genre: buy, pull equity
//      out at every opportunity, never sell, and let a rising mark fund the next
//      draw. If net worth compounds faster with the refis than without them,
//      there is a positive-EV button with no offsetting cost on it.
//   4. DISTRESS.  A rate spike plus a demand shock, against a control that gets
//      neither. Do covenants trip, do sweeps engage, do marks fall, do buildings
//      actually leave? Is the loss legible? And does anybody on the street bid
//      for what falls out, or does distressed product vanish into nowhere?
//   5. THE CREDIT CYCLE.  Advance rates, spreads and appetite quoted against a
//      FIXED reference deal every month for a century. Constant terms means the
//      finance side is decorative — a lender that quotes the same sheet in 1931
//      and 1985 is a price list, not a credit market.
//
// TRAPS THIS FILE IS BUILT TO AVOID, all of which have cost this repo time:
//   · `advanceQuarter` returns state UNCHANGED once gameOver is set. The macro
//     probes resurrect; the PLAYER probes deliberately do not, because for a
//     levered owner being wiped out IS the measurement — they record the month
//     of death and stop.
//   · Two arms of a paired run must not share a parcel table. It is mutated in
//     place, so the shocked arm's construction would rewrite the control's city.
//     `branch()` clones both sides of the world.
//   · Everything in money is divided by `g.econ.cpi`. A nominal series in a
//     2%-inflation world rises sevenfold a century and means nothing.
//   · Constant cohort. Every leverage and refi comparison is the SAME building,
//     the SAME seed and the SAME calendar window across arms.
//   · A metric that cannot move is not evidence. Sections 1 and 5 print the
//     range and standard deviation of every series before drawing a conclusion
//     from its mean, and they print how often a series is resting on a clamp.
import { assertFreshBundle } from "../fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "../.engine.mjs"));
const { loadCity } = await import(join(HERE, "../city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);

const SEEDS  = (process.env.SEEDS ?? "550991,12007,73303").split(",").map(Number);
const YRS    = Number(process.env.YRS ?? 50);      // §1 and §5: the macro horizon
const HOLD_Y = Number(process.env.HOLD_Y ?? 20);   // §2: the leverage hold
const REFI_Y = Number(process.env.REFI_Y ?? 30);   // §3: the refi campaign
const SHK_Y  = Number(process.env.SHK_Y ?? 12);    // §4: run length after the book is built
const SHOCK_M = Number(process.env.SHOCK_M ?? 36); // §4: how long the shock is held on
const ONLY   = (process.env.ONLY ?? "1,2,3,4,5").split(",");

const HZ = YRS * 12, HOLD = HOLD_Y * 12, REFI_HZ = REFI_Y * 12, SHK_HZ = SHK_Y * 12;
const CLASSES = ["office", "retail", "multifamily", "industrial"];
// Every acquisition desk that will look at a standing building. `pelican` is in
// the list on purpose even though it refuses a tired one — a product that never
// wins is a fact about the sheet, not a reason to hide it from the test.
const BUY_PRODUCTS = ["savings", "savings25", "harbor", "conduit", "pelican", "cordage"];

// ---------------------------------------------------------------- small tools
const C = (x) => JSON.parse(JSON.stringify(x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return a.length ? Math.sqrt(mean(a.map((x) => (x - m) ** 2))) : NaN; };
const pct = (a, f) => (a.length ? (100 * a.filter(f).length) / a.length : NaN);
const M = (n) => `$${(n / 1e6).toFixed(2)}M`;
const p2 = (n, w = 6) => (Number.isFinite(n) ? n.toFixed(2) : "  n/a").padStart(w);
const p3 = (n, w = 7) => (Number.isFinite(n) ? n.toFixed(3) : "  n/a").padStart(w);
/** Longest consecutive run for which the predicate holds — "persistently" needs a number. */
const longestRun = (a, f) => { let b = 0, c = 0; for (const x of a) { c = f(x) ? c + 1 : 0; if (c > b) b = c; } return b; };
/** Pearson r, so "correlate terms against the cycle" is a number and not an adjective. */
function corr(xs, ys) {
  // Pairwise-complete: a single NaN in either series used to poison the whole
  // coefficient and print "n/a" over a relationship that was plainly there.
  const px = [], py = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { px.push(xs[i]); py.push(ys[i]); }
  }
  if (px.length < 3) return NaN;
  const mx = mean(px), my = mean(py);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < px.length; i++) { const a = px[i] - mx, b = py[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
/** The annual debt-service constant per $1 of principal — what actually decides
 *  whether leverage pays. A 6.4% coupon on a 25-year schedule is an 8.0%
 *  constant, so a 7% cap rate is negative leverage at a coupon comfortably
 *  BELOW it. See the header of src/engine/debt.ts. */
const mortConst = (ratePct, years) => { const i = ratePct / 100 / 12, n = years * 12; return 100 * (12 * i) / (1 - Math.pow(1 + i, -n)); };

/** A fresh world. The parcel table is MUTATED by the engine, so every run gets its own. */
function fresh(seed) {
  const parcels = C(P0);
  return { g: E.firstListings(E.newGame(seed, parcels), parcels, bbls), parcels };
}
/** Split a running world in two. Verified equivalent to replaying from month 0:
 *  the engine is state-complete (test 33's save/reload arm proves it), so a
 *  deep copy of {state, parcels} is the same thing as a re-run, at a fraction
 *  of the cost. adjacency and bbls are never written to. */
const branch = (g, parcels) => ({ g: C(g), parcels: C(parcels) });
const step = (g, parcels) => E.advanceQuarter(g, parcels, bbls, adjacency);
/** Real (CPI-deflated) net worth. Nominal is meaningless over these horizons. */
const realNW = (g, parcels) => E.netWorth(g, parcels) / (g.econ.cpi || 1);

console.log(`\nB. CAPITAL MARKETS — ${SEEDS.length} seed(s), ${YRS}y macro / ${HOLD_Y}y leverage / ${REFI_Y}y refi`);
console.log(`   seeds ${SEEDS.join(", ")}   city ${process.env.BW_CITY ?? "somewhere"}\n`);

// =============================================================================
// THE SHARED MACRO PASS — one null-player century per seed, feeding §1 and §5.
//
// No player, resurrected on gameOver, because both sections are asking about
// the WORLD's terms and not about anybody's balance sheet. Every month it
// records the marks and it quotes a FIXED reference deal at every desk on the
// street — same price, same NOI, same class, forever — so that any movement in
// the quote is movement in the credit market and not in the building.
//
// `street = true` on the quote drops the two things that are facts about the
// PLAYER rather than about lending (the sponsor record and the single-name
// concentration test), which is exactly what has to come out to isolate the
// cycle. See the comment on `quote` in src/engine/debt.ts.
// =============================================================================
const REF_PX = 20e6;          // a mid-market office building
const REF_NOI = REF_PX * 0.075;
const macro = [];             // one row per seed-month

if (ONLY.some((t) => t === "1" || t === "5")) {
  for (const seed of SEEDS) {
    let { g, parcels } = fresh(seed);
    for (let m = 0; m < HZ; m++) {
      if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
      g = step(g, parcels);
      const e = g.econ;
      const row = {
        seed, m, phase: e.phase, ci: e.creditIdx ?? 1, idx: e.indexRate,
        cyc: e.cycleDev, cpi: e.cpi, cap: { ...e.capRate },
        vac: { ...(e.cityVac ?? {}) }, terms: {},
        // What the revolver will advance against a dollar of equity today.
        locAdv: E.netWorth(g, parcels) > 0 ? E.locLimit(g, parcels) / E.netWorth(g, parcels) : NaN,
      };
      for (const p of E.PRODUCTS) {
        if (p.id === "land" || p.mezz) continue;
        const q = E.quote(g, p, REF_PX, REF_NOI, "office", true);
        row.terms[p.id] = {
          adv: q.principal / REF_PX,
          rate: q.ratePct,
          spread: q.ratePct - e.indexRate,
          open: E.windowOpen(g, p) ? 1 : 0,
          app: E.lenderAppetite(g, p.lender),
        };
      }
      // The senior coupon a real buyer would actually close at, used below as
      // the other leg of the cap-rate spread.
      row.coupon = row.terms.savings.rate;
      macro.push(row);
    }
  }
}

// =============================================================================
// 1. CAP RATE / RATE SPREAD
//
// WHAT IT IS FOR. A cap rate is a yield, and a yield only means something
// against the cost of money. The engine drags cap rates toward
// `CAP_BASE + 0.55*(indexRate - 5.4) + ...` (market.ts), so the spread to the
// index has a built-in slope of -0.45 per point of rate: it MUST compress as
// rates rise. The question is whether it compresses through zero and stays
// there, because a persistently negative spread is not a cycle — it is a
// standing prohibition on borrowing, dressed as a market.
//
// Three legs are reported, and only the third one decides anything:
//   vs indexRate       the loan index. Note this engine has no risk-free rate
//                      at all: `indexRate` is policy + a term premium that
//                      itself widens in a crunch, so this leg already contains
//                      part of the credit spread and understates the widening.
//   vs senior coupon   what a buyer actually signs.
//   vs mortgage const  coupon AND amortisation — the number that says whether
//                      a levered dollar is cash-flow positive on day one.
//
// IF IT FAILED: a spread that never moves means the timing of a levered
// purchase is noise. A spread permanently below zero in a class means that
// class can only ever be bought for cash, and the leverage decision in §2 is
// being answered by arithmetic rather than by the cycle.
// =============================================================================
if (ONLY.includes("1")) {
  console.log("=".repeat(78));
  console.log(`1. CAP RATE / RATE SPREAD — ${macro.length.toLocaleString()} seed-months`);
  console.log("=".repeat(78));
  const idx = macro.map((r) => r.idx);
  console.log(`\n   loan index: mean ${p2(mean(idx))}  range ${p2(Math.min(...idx))} .. ${p2(Math.max(...idx))}  sd ${p2(sd(idx))}`);
  console.log(`   senior coupon (Alden 7yr, street quote): mean ${p2(mean(macro.map((r) => r.coupon)))}\n`);

  console.log("   class         cap  sd    vs INDEX          vs COUPON         vs MORTGAGE CONSTANT");
  console.log("                            mean  %neg  run   mean  %neg  run   mean  %neg  run");
  const negRuns = {};
  for (const k of CLASSES) {
    const caps = macro.map((r) => r.cap[k]);
    const s1 = macro.map((r) => r.cap[k] - r.idx);
    const s2 = macro.map((r) => r.cap[k] - r.coupon);
    const s3 = macro.map((r) => r.cap[k] - mortConst(r.coupon, 30));
    negRuns[k] = [longestRun(s1, (x) => x < 0), longestRun(s2, (x) => x < 0), longestRun(s3, (x) => x < 0)];
    console.log(`   ${k.padEnd(12)}${p2(mean(caps), 5)} ${p2(sd(caps), 4)} `
      + ` ${p2(mean(s1), 6)} ${p2(pct(s1, (x) => x < 0), 5)}%${String(negRuns[k][0]).padStart(5)}`
      + ` ${p2(mean(s2), 6)} ${p2(pct(s2, (x) => x < 0), 5)}%${String(negRuns[k][1]).padStart(5)}`
      + ` ${p2(mean(s3), 6)} ${p2(pct(s3, (x) => x < 0), 5)}%${String(negRuns[k][2]).padStart(5)}`);
  }
  console.log(`   ("run" is the longest consecutive stretch of months below zero — "persistently" needs a number)\n`);

  // DOES IT COMPRESS AT PEAKS AND WIDEN IN DOWNTURNS? The cycle is a label the
  // engine already carries, so read the spread inside each label rather than
  // inventing a peak detector.
  console.log("   spread by cycle phase (office):");
  console.log("   phase          n    creditIdx  index  coupon    cap   vs index   vs coupon");
  const phases = ["expansion", "peak", "recession", "recovery"];
  const byPhase = {};
  for (const r of macro) (byPhase[r.phase] ??= []).push(r);
  for (const ph of phases) {
    const v = byPhase[ph] ?? [];
    if (!v.length) { console.log(`   ${ph.padEnd(13)}   0    (never occurred)`); continue; }
    console.log(`   ${ph.padEnd(13)}${String(v.length).padStart(5)}${p3(mean(v.map((r) => r.ci)), 11)}`
      + `${p2(mean(v.map((r) => r.idx)))}${p2(mean(v.map((r) => r.coupon)), 8)}${p2(mean(v.map((r) => r.cap.office)), 7)}`
      + `${p2(mean(v.map((r) => r.cap.office - r.idx)), 11)}${p2(mean(v.map((r) => r.cap.office - r.coupon)), 12)}`);
  }
  // ...and against the continuous cycle variable, not just the label.
  console.log(`\n   corr(office cap-vs-index spread, cycleDev)  ${p3(corr(macro.map((r) => r.cap.office - r.idx), macro.map((r) => r.cyc)))}`
    + `   (negative = compresses as the cycle runs hot)`);
  console.log(`   corr(office cap rate, loan index)          ${p3(corr(macro.map((r) => r.cap.office), macro.map((r) => r.idx)))}`
    + `   (the engine's designed beta is 0.55)`);

  // A RAIL THAT IS LOAD-BEARING IS A BUG. capRate is clamped to [3.4, 11].
  console.log(`\n   time resting on the cap-rate clamp [3.40 .. 11.00]:`);
  for (const k of CLASSES) {
    const caps = macro.map((r) => r.cap[k]);
    console.log(`     ${k.padEnd(12)} floor ${p2(pct(caps, (x) => x <= 3.41), 5)}%   ceiling ${p2(pct(caps, (x) => x >= 10.99), 5)}%   range ${p2(Math.min(...caps))} .. ${p2(Math.max(...caps))}`);
  }
  console.log();
}

// =============================================================================
// 2. LEVERAGE — the same building, the same seed, three advance rates.
//
// WHAT IT IS FOR. Capital structure is supposed to be the central decision of
// this business and it is supposed to be a TRADE: more debt buys more upside
// and costs you the right to be wrong. The test is a paired run in the
// strictest sense available — one scouted building, one entry month, three
// loans, identical worlds — held through a full cycle.
//
// Every arm is funded with EXACTLY the equity its own capital structure needs
// plus the same operating reserve as a share of price, so the arms differ in
// leverage and in nothing else. The multiple is real (CPI-deflated) net worth
// at the end over real net worth the moment before the purchase.
//
// TWO ENTRY POINTS PER SEED, because the whole claim is conditional: buying at
// a labelled PEAK and buying in a labelled RECESSION are different bets and a
// single entry cannot tell them apart.
//
// gameOver is NOT resurrected here. A wipeout is the answer, not an accident,
// and an arm that dies is scored as a total loss of equity.
//
// IF IT FAILED: if the top-leverage arm wins every cell, debt is underpriced
// and the capital-structure dial is a "more money" button. If it loses every
// cell, debt is overpriced and the dial is a tax. Either is a dead decision.
// =============================================================================

/** Warm a world forward with the player parked, holding cash constant so the
 *  scout's balance sheet cannot itself move the market it is scouting. */
function warm(g, parcels, months, cash) {
  for (let m = 0; m < months; m++) {
    if (g.gameOver) g = { ...g, gameOver: null };
    g = { ...g, cash };
    g = step(g, parcels);
  }
  return { ...g, cash };
}

/** The best levered deal on today's tape: biggest cheque among listings whose
 *  maximum advance clears `minLtv`. Biggest, not cheapest, because a small
 *  building is drowned by the firm's fixed overhead and measures that instead. */
function scoutDeal(g, parcels, minLtv) {
  let best = null;
  for (const li of g.listings) {
    const rec = E.resolveRec(parcels, g, li.bbl);
    if (!rec || rec.class === "land" || !(rec.bldgArea > 0)) continue;
    for (const p of BUY_PRODUCTS) {
      const q = E.buyQuote(g, parcels, li.bbl, li.ask, p, 1);
      const ltv = li.ask > 0 ? q.principal / li.ask : 0;
      if (ltv >= minLtv && (!best || li.ask > best.ask)) {
        best = { bbl: li.bbl, ask: li.ask, product: p, maxLtv: ltv, klass: rec.class, addr: rec.address };
      }
    }
  }
  return best;
}

if (ONLY.includes("2")) {
  console.log("=".repeat(78));
  console.log(`2. LEVERAGE — one building, three advance rates, ${HOLD_Y}-year hold`);
  console.log("=".repeat(78));
  const TARGETS = [0.40, 0.65, 0.80];
  const SCOUT_M = Number(process.env.SCOUT_M ?? 180);   // 15 years to find a real top and a real bottom
  const cells = [];
  const marksFor = {};  // seed -> the two entry months, chosen off cycleDev
  const ltvTape = [];   // every month's best attainable acquisition LTV, city-wide

  for (const seed of SEEDS) {
    // PASS ONE: walk fifteen years with the player parked and record the cycle.
    // The two entry points are the HOTTEST and COLDEST months on `cycleDev`,
    // not the first month wearing each label — "peak" and "recession" are
    // adjacent labels, and entering three months apart is one bet, not two.
    // The same walk records how much leverage the tape would actually finance,
    // which is the first thing this section has to establish: a target LTV that
    // no desk in the city will write is not an arm, it is a wish.
    {
      let { g, parcels } = fresh(seed);
      g = warm(g, parcels, 24, 300e6);
      const walk = [];
      for (let m = 0; m < SCOUT_M; m++) {
        let best = 0;
        for (const li of g.listings) {
          const rec = E.resolveRec(parcels, g, li.bbl);
          if (!rec || rec.class === "land" || !(rec.bldgArea > 0)) continue;
          for (const p of BUY_PRODUCTS) {
            const q = E.buyQuote(g, parcels, li.bbl, li.ask, p, 1);
            if (li.ask > 0) best = Math.max(best, q.principal / li.ask);
          }
        }
        if (best > 0) ltvTape.push(best);
        walk.push({ at: g.month, cyc: g.econ.cycleDev, phase: g.econ.phase });
        g = warm(g, parcels, 1, 300e6);
      }
      const hot = walk.reduce((a, b) => (b.cyc > a.cyc ? b : a));
      const cold = walk.reduce((a, b) => (b.cyc < a.cyc ? b : a));
      marksFor[seed] = [
        { ...hot, label: `TOP OF CYCLE (cycleDev ${hot.cyc.toFixed(2)}, ${hot.phase})` },
        { ...cold, label: `BOTTOM OF CYCLE (cycleDev ${cold.cyc.toFixed(2)}, ${cold.phase})` },
      ];
    }

    // PASS TWO: replay and branch at each mark. Branching is verified
    // equivalent to replaying, so one walk serves both entries.
    let { g, parcels } = fresh(seed);
    const wanted = marksFor[seed].slice().sort((a, b) => a.at - b.at);
    const entries = [];
    for (const w of wanted) {
      while (g.month < w.at) g = warm(g, parcels, 1, 300e6);
      // If nothing on today's tape is financeable, walk forward up to a year
      // rather than throwing the cell away — a shut tape is a fact about the
      // month, not about leverage.
      // Ask for real leverage first and only then settle. Scouting purely on
      // size picks the biggest building, and the biggest building is the one
      // debt yield bites hardest — which quietly collapsed the 65% and 80%
      // arms onto each other and turned a three-point sweep into a two-point
      // one. Walk the bar down instead of accepting whatever the largest lot
      // happens to finance at.
      let probe = null, deal = null;
      for (const bar of [0.66, 0.56, 0.45]) {
        const p = branch(g, parcels);
        for (let slip = 0; slip < 24 && !deal; slip++) {
          deal = scoutDeal(p.g, p.parcels, bar);
          if (!deal) p.g = warm(p.g, p.parcels, 1, 300e6);
        }
        if (deal) { probe = p; break; }
      }
      if (deal) entries.push({ phase: w.label, at: probe.g.month, world: branch(probe.g, probe.parcels), deal });
    }
    if (!entries.length) { console.log(`   seed ${seed}: no financeable listing at either entry — nothing measured.`); continue; }

    for (const en of entries) {
      const { deal } = en;
      const reserve = Math.round(deal.ask * 0.25);   // identical liquidity cushion in every arm
      const row = { seed, phase: en.phase, kind: en.phase.startsWith("TOP") ? "top" : "bottom", at: en.at, deal, arms: [] };
      for (const tgt of TARGETS) {
        const b = branch(en.world.g, en.world.parcels);
        let h = b.g; const pp = b.parcels;
        const lev = Math.min(1, tgt / deal.maxLtv);
        const q = E.buyQuote(h, pp, deal.bbl, deal.ask, deal.product, lev);
        h = { ...h, cash: q.equity + reserve };
        const cpi0 = h.econ.cpi, nw0 = realNW(h, pp);
        const rentIdx0 = h.econ.rentIdx[deal.klass] / cpi0, idx0 = h.econ.indexRate, cap0 = h.econ.capRate[deal.klass];
        const r = E.executePurchase(h, pp, deal.bbl, deal.ask, deal.product, false, lev);
        if (r.err) { row.arms.push({ tgt, err: r.err }); continue; }
        h = r.s;
        const gotLtv = deal.ask > 0 ? q.principal / deal.ask : 0;

        let sweepMs = 0, wkMs = 0, died = null, minNW = Infinity;
        for (let m = 0; m < HOLD; m++) {
          if (h.gameOver) { died = m; break; }
          h = step(h, pp);
          const hd = h.holdings[deal.bbl];
          if (hd?.loan?.sweep) sweepMs++;
          if (h.workouts?.[deal.bbl]) wkMs++;
          const nw = realNW(h, pp); if (nw < minNW) minNW = nw;
        }
        const nw1 = died !== null ? 0 : realNW(h, pp);
        row.arms.push({
          tgt, gotLtv, capped: tgt > deal.maxLtv + 0.005, rate: q.ratePct, equity: q.equity, nw0, nw1,
          mult: nw0 > 0 ? nw1 / nw0 : NaN,
          cagr: nw0 > 0 && nw1 > 0 ? (Math.pow(nw1 / nw0, 12 / HOLD) - 1) * 100 : -100,
          sweepMs, wkMs, died, minNW, still: !!h.holdings[deal.bbl],
          dRent: h.econ.rentIdx[deal.klass] / h.econ.cpi / rentIdx0,
          dIdx: h.econ.indexRate - idx0,
          dCap: h.econ.capRate[deal.klass] - cap0,
        });
      }
      cells.push(row);
    }
  }

  // HOW MUCH LEVERAGE THIS CITY WILL ACTUALLY WRITE. Printed before the arms,
  // because if the tape's ceiling is under 80% then the 80% arm is not an
  // experiment that failed — it is an experiment that could not be run.
  if (ltvTape.length) {
    const s = [...ltvTape].sort((a, b) => a - b);
    const qq = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    console.log(`\n   THE LEVERAGE CEILING — best advance rate available anywhere on the tape, by month`);
    console.log(`   (${s.length.toLocaleString()} months scouted across ${SEEDS.length} seed(s)):`);
    console.log(`     max ${p3(s[s.length - 1])}   p95 ${p3(qq(0.95))}   median ${p3(qq(0.5))}   p05 ${p3(qq(0.05))}   min ${p3(s[0])}`);
    console.log(`     months where 80% was attainable: ${p2(pct(s, (x) => x >= 0.80))}%   65%: ${p2(pct(s, (x) => x >= 0.65))}%   40%: ${p2(pct(s, (x) => x >= 0.40))}%`);
  }

  for (const row of cells) {
    console.log(`\n   seed ${row.seed} · entered at ${row.phase} · month ${row.at} · ${row.deal.klass} ${row.deal.addr} `
      + `${M(row.deal.ask)} · best advance available ${(row.deal.maxLtv * 100).toFixed(1)}% (${row.deal.product})`);
    console.log(`     targetLTV  gotLTV  coupon   equity   realNW start -> end   multiple   real/yr   sweepMs  wkMs  outcome`);
    for (const a of row.arms) {
      if (a.err) { console.log(`     ${(a.tgt * 100).toFixed(0)}%        —      (not financeable: ${a.err})`); continue; }
      const out = a.died !== null ? `WIPED OUT m${a.died}` : a.still ? "still owns it" : "lost the building";
      console.log(`     ${String((a.tgt * 100).toFixed(0) + "%" + (a.capped ? "*" : "")).padEnd(11)}${p3(a.gotLtv)} ${p2(a.rate)}  ${M(a.equity).padStart(8)}`
        + `   ${M(a.nw0).padStart(8)} -> ${M(a.nw1).padStart(8)}   ${p2(a.mult, 7)}x  ${p2(a.cagr, 7)}%`
        + `${String(a.sweepMs).padStart(8)}${String(a.wkMs).padStart(6)}  ${out}`);
    }
    if (row.arms.some((a) => a.capped)) console.log(`     * no desk in the city would write that advance — the arm ran at the ceiling instead.`);
    const w = row.arms.find((a) => a.dRent !== undefined);
    if (w) console.log(`     window: real ${row.deal.klass} rent x${w.dRent.toFixed(2)}, loan index ${w.dIdx >= 0 ? "+" : ""}${w.dIdx.toFixed(2)}pp, cap rate ${w.dCap >= 0 ? "+" : ""}${w.dCap.toFixed(2)}pp`);
  }

  // THE SCORECARD. Does high leverage always win, never win, or win
  // conditionally? "Conditionally" is the only healthy answer. Cells where the
  // top arm collapsed onto the 40% arm (nothing above 40% was writeable) are
  // excluded — they contain no leverage comparison at all.
  const pair = (r) => {
    const ok = r.arms.filter((a) => !a.err);
    const lo = ok.find((a) => a.tgt === 0.40), hi = ok[ok.length - 1];
    return lo && hi && hi.gotLtv > lo.gotLtv + 0.02 ? { lo, hi } : null;
  };
  const usable = cells.filter(pair);
  const winsHigh = usable.filter((r) => { const p = pair(r); return p.hi.mult > p.lo.mult; }).length;
  const wipes = cells.flatMap((r) => r.arms).filter((a) => !a.err && a.died !== null);
  console.log(`\n   SCORECARD: the top-leverage arm beat the 40% arm in ${winsHigh} of ${usable.length} comparable cells.`);
  console.log(`              ${wipes.length} wipeout(s) in total; by target LTV: `
    + TARGETS.map((t) => `${(t * 100).toFixed(0)}% -> ${wipes.filter((a) => a.tgt === t).length}`).join(", "));
  console.log(`              advantage (top-arm multiple minus 40% multiple), by where the money went in:`);
  for (const kind of ["top", "bottom"]) {
    const adv = usable.filter((r) => r.kind === kind).map((r) => { const p = pair(r); return p.hi.mult - p.lo.mult; });
    console.log(`                bought at the ${kind === "top" ? "TOP   " : "BOTTOM"}  n=${adv.length}  mean ${p2(mean(adv))}x  [${adv.map((x) => x.toFixed(2)).join(", ")}]`);
  }
  console.log(`\n   NOTE ON THE DENOMINATOR: unspent equity earns CASH_APY, a flat 1.0%/yr`);
  console.log(`   (src/engine/types.ts) regardless of a policy rate this engine runs from`);
  console.log(`   0.25% to 23%. The low-leverage arm therefore carries a real cash drag of`);
  console.log(`   roughly (1% - inflation) on its reserve in every rate environment. That is`);
  console.log(`   a thumb on this comparison and it is reported, not corrected for.\n`);
}

// =============================================================================
// 3. REFINANCE ARBITRAGE
//
// WHAT IT IS FOR. This is the money pump this genre is famous for. Buy one
// building, never sell it, and pull the maximum out at every opportunity for
// thirty years, letting each new mark fund the next draw. Against a control
// that buys the identical building on the identical month and then does
// nothing at all. Same seed, same world, same calendar.
//
// A refinance is a BALANCE-SHEET SWAP and should be net-worth-negative: you
// receive cash and you book an equal liability, minus origination points,
// minus a 1% refi fee, minus any prepayment penalty, and the new coupon is
// charged on a bigger balance for the rest of the hold. If the refi arm ends
// RICHER in real terms, some of those costs are not being charged.
//
// A second, sharper probe runs afterwards: refinance the same building N times
// inside ONE month. Every call after the first should be strictly value-
// destroying (a fee against no new proceeds). If net worth rises per call,
// there is a button that prints money and the loop is the whole exploit.
//
// IF IT FAILED: net worth compounding faster WITH the refis is EXPLOITABLE —
// a repeatable positive-EV action with no offsetting cost.
// =============================================================================
if (ONLY.includes("3")) {
  console.log("=".repeat(78));
  console.log(`3. REFINANCE ARBITRAGE — ${REFI_Y} years, buy and never sell`);
  console.log("=".repeat(78));
  const rows = [];
  for (const seed of SEEDS) {
    let { g, parcels } = fresh(seed);
    g = warm(g, parcels, 24, 300e6);
    let deal = null;
    for (let m = 0; m < 30 * 12 && !deal; m++) { deal = scoutDeal(g, parcels, 0.50); if (!deal) g = warm(g, parcels, 1, 300e6); }
    if (!deal) { console.log(`   seed ${seed}: never found a financeable building. Nothing measured.`); continue; }
    const world = branch(g, parcels);

    const out = {};
    for (const arm of ["never", "refi"]) {
      const b = branch(world.g, world.parcels);
      let h = b.g; const pp = b.parcels;
      const q = E.buyQuote(h, pp, deal.bbl, deal.ask, deal.product, 1);
      h = { ...h, cash: q.equity + Math.round(deal.ask * 0.25) };
      const nw0 = realNW(h, pp);
      const r0 = E.executePurchase(h, pp, deal.bbl, deal.ask, deal.product, false, 1);
      if (r0.err) { out[arm] = { err: r0.err }; continue; }
      h = r0.s;
      let refis = 0, tries = 0, cashOut = 0, feeImplied = 0, died = null, maxBal = 0;
      for (let m = 0; m < REFI_HZ; m++) {
        if (h.gameOver) { died = m; break; }
        h = step(h, pp);
        if (arm !== "refi" || !h.holdings[deal.bbl] || h.workouts?.[deal.bbl]) continue;
        // Every six months, which is as often as anybody would actually ring
        // a desk, take the biggest cheque on the street.
        if (m % 6) continue;
        tries++;
        const { quotes } = E.refiQuotes(h, pp, deal.bbl);
        const cands = quotes.filter((x) => x.available && x.id !== "mezz").sort((a, b2) => b2.maxProceeds - a.maxProceeds);
        for (const c of cands) {
          const cash0 = h.cash, bal0 = h.holdings[deal.bbl]?.loan?.balance ?? 0;
          const rr = E.refinance(h, pp, deal.bbl, c.id, 1);
          if (rr.err) continue;
          const dCash = rr.s.cash - cash0, dBal = (rr.s.holdings[deal.bbl]?.loan?.balance ?? 0) - bal0;
          if (dCash <= 0) break;                 // not accretive: do not pay a fee for nothing
          h = rr.s; refis++;
          cashOut += dCash / h.econ.cpi;
          feeImplied += (dBal - dCash) / h.econ.cpi;
          maxBal = Math.max(maxBal, h.holdings[deal.bbl]?.loan?.balance ?? 0);
          break;
        }
      }
      out[arm] = {
        nw0, nw1: died !== null ? 0 : realNW(h, pp), refis, tries, cashOut, feeImplied, died,
        bal: h.holdings[deal.bbl]?.loan?.balance ?? 0, maxBal,
        still: !!h.holdings[deal.bbl], sweep: !!h.holdings[deal.bbl]?.loan?.sweep,
      };
    }
    rows.push({ seed, deal, out });
  }

  console.log(`\n   seed      building                    arm      realNW start -> end   multiple   refis/tries  real cash out  fees+interest gap`);
  for (const r of rows) {
    for (const arm of ["never", "refi"]) {
      const a = r.out[arm];
      if (!a || a.err) { console.log(`   ${String(r.seed).padEnd(10)}${(r.deal.klass + " " + M(r.deal.ask)).padEnd(28)}${arm.padEnd(9)}(not financeable)`); continue; }
      console.log(`   ${String(r.seed).padEnd(10)}${(r.deal.klass + " " + M(r.deal.ask)).padEnd(28)}${arm.padEnd(9)}`
        + `${M(a.nw0).padStart(9)} -> ${M(a.nw1).padStart(9)}   ${p2(a.nw0 > 0 ? a.nw1 / a.nw0 : NaN, 7)}x`
        + `${String(a.refis + "/" + a.tries).padStart(13)}${M(a.cashOut).padStart(15)}${M(a.feeImplied).padStart(19)}`
        + (a.died !== null ? `  DIED m${a.died}` : a.still ? "" : "  lost the building"));
    }
  }
  const deltas = rows.filter((r) => r.out.never && r.out.refi && !r.out.never.err && !r.out.refi.err && r.out.never.nw1 > 0)
    .map((r) => r.out.refi.nw1 / r.out.never.nw1);
  if (deltas.length) {
    console.log(`\n   refi arm's ending real net worth as a multiple of the never-refi arm: `
      + deltas.map((x) => x.toFixed(3)).join(", ") + `   (mean ${mean(deltas).toFixed(3)})`);
    console.log(`   >1.00 on average would be the arbitrage. <1.00 means the fees and the extra`);
    console.log(`   coupon are being charged, which is what a refinance actually costs.`);
  }

  // ---- the same-month pump ------------------------------------------------
  // If a refinance leaves the borrower better off with no new proceeds, then
  // doing it ten times in an afternoon is the exploit in its purest form.
  console.log(`\n   SAME-MONTH PUMP — refinance the same building repeatedly inside one month:`);
  for (const seed of SEEDS.slice(0, 2)) {
    let { g, parcels } = fresh(seed);
    g = warm(g, parcels, 24, 300e6);
    let deal = null;
    for (let m = 0; m < 30 * 12 && !deal; m++) { deal = scoutDeal(g, parcels, 0.50); if (!deal) g = warm(g, parcels, 1, 300e6); }
    if (!deal) continue;
    const q = E.buyQuote(g, parcels, deal.bbl, deal.ask, deal.product, 1);
    let h = { ...g, cash: q.equity + Math.round(deal.ask * 0.25) };
    const r0 = E.executePurchase(h, parcels, deal.bbl, deal.ask, deal.product, false, 1);
    if (r0.err) continue;
    h = r0.s;
    for (let i = 0; i < 24; i++) h = step(h, parcels);   // let the covenant holiday run out
    const line = [];
    for (let i = 0; i < 8; i++) {
      const nwA = realNW(h, parcels), cashA = h.cash;
      const { quotes } = E.refiQuotes(h, parcels, deal.bbl);
      const c = quotes.filter((x) => x.available && x.id !== "mezz").sort((a, b2) => b2.maxProceeds - a.maxProceeds)[0];
      if (!c) { line.push("no quote"); break; }
      const rr = E.refinance(h, parcels, deal.bbl, c.id, 1);
      if (rr.err) { line.push(`refused: ${rr.err.slice(0, 34)}`); break; }
      h = rr.s;
      line.push(`#${i + 1} ${c.id} bal ${((h.holdings[deal.bbl]?.loan?.balance ?? 0) / 1e6).toFixed(2)}M `
        + `dCash ${((h.cash - cashA) / 1e3).toFixed(0)}K dNW ${((realNW(h, parcels) - nwA) / 1e3).toFixed(0)}K`);
    }
    console.log(`     seed ${seed}: ${line.join(" | ")}`);
  }
  console.log(`     (a positive dNW that repeats is the pump. A negative one is the fee.)\n`);
}

// =============================================================================
// 4. THE DISTRESS PATHWAY
//
// WHAT IT IS FOR. Everything above is about whether the money is priced. This
// is about whether it can BITE. A levered book is assembled — every financeable
// building on the tape at the maximum advance any desk will write — and then
// half of them get a rate spike and a demand shock and half do not, from the
// identical month, in identical worlds.
//
// The shock is injected as sustained macro state rather than as an event: the
// loan index is pinned six points above where it was, the credit window is held
// at 0.45 (near its 0.40 floor), the phase is held in recession, and citywide
// OCCUPIED square footage is bled 1.2% a month. Occupied is the right lever
// because `cityVac` is recomputed every month out of `occupied / stock`
// (market.ts) — writing the vacancy rate directly would be overwritten inside
// the same tick and would measure nothing.
//
// What is counted: covenant sweeps, workout files by cause, real portfolio
// marks, buildings actually lost, the cash trough, the revolver going over its
// advance, and whether the run ends. And separately: WHO BUYS. Every courthouse
// sale in the run is classified from the tape as taken by the player, by a
// named firm on the street, by out-of-town money, or struck to the lender as
// REO. A distress channel that produces sellers and no buyers is a leak.
//
// gameOver is not resurrected: dying is a legitimate outcome of a shock and
// resurrecting would make the test unable to see the worst thing that happens.
//
// IF IT FAILED: values that do not fall, covenants that do not trip, or a
// docket nobody bids on. Any of the three means the downside is decorative.
// =============================================================================
if (ONLY.includes("4")) {
  console.log("=".repeat(78));
  console.log(`4. DISTRESS PATHWAY — levered book, rate spike + demand shock vs control`);
  console.log("=".repeat(78));

  function buildBook(seed) {
    let { g, parcels } = fresh(seed);
    g = warm(g, parcels, 36, 250e6);
    let bought = 0;
    for (const li of [...g.listings]) {
      const rec = E.resolveRec(parcels, g, li.bbl);
      if (!rec || rec.class === "land" || !(rec.bldgArea > 0)) continue;
      let bp = null, bl = 0;
      for (const p of BUY_PRODUCTS) {
        const q = E.buyQuote(g, parcels, li.bbl, li.ask, p, 1);
        const l = li.ask > 0 ? q.principal / li.ask : 0;
        if (l > bl) { bl = l; bp = p; }
      }
      if (!bp || bl < 0.30) continue;
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, bp, false, 1);
      if (!r.err) { g = r.s; bought++; }
    }
    // A sponsor's real reserve, not a bottomless one: 15% of the debt stack.
    let debt = 0;
    for (const h of Object.values(g.holdings)) debt += h.loan?.balance ?? 0;
    g = { ...g, cash: Math.round(debt * 0.15) };
    return { world: branch(g, parcels), bought, debt };
  }

  function runArm(world, shocked) {
    const b = branch(world.g, world.parcels);
    let g = b.g; const parcels = b.parcels;
    const base = g.econ.indexRate;
    const nw0 = realNW(g, parcels);
    let pv0 = 0; for (const h of Object.values(g.holdings)) { const rec = E.resolveRec(parcels, g, h.bbl); if (rec) pv0 += E.holdingValue(rec, g.econ, h, g.month); }
    pv0 /= g.econ.cpi;
    const st = {
      sweepMs: 0, breached: new Set(), wk: {}, forced: 0, died: null, minNW: Infinity, minCash: Infinity,
      lots: 0, locOver: 0, toPlayer: 0, toRival: 0, toOutOfTown: 0, toRoom: 0, toREO: 0, pulled: 0, seized: 0,
      rivalFails: 0, pv: [], warns: new Set(),
    };
    for (let m = 0; m < SHK_HZ; m++) {
      if (g.gameOver) { st.died = m; break; }
      if (shocked && m < SHOCK_M) {
        const e = g.econ;
        e.indexRate = Math.min(22.9, base + 6);
        e.creditIdx = 0.45;
        e.phase = "recession";
        for (const k of Object.keys(e.occupied ?? {})) e.occupied[k] *= 0.988;
      }
      g = step(g, parcels);
      for (const h of Object.values(g.holdings)) if (h.loan?.sweep) { st.sweepMs++; st.breached.add(h.bbl); }
      for (const w of Object.values(g.workouts ?? {})) if (w.startM === g.month) st.wk[w.cause] = (st.wk[w.cause] ?? 0) + 1;
      if (g.auction) st.lots += g.auction.lots.length;
      if (g.locOverMs) st.locOver++;
      const nw = realNW(g, parcels); if (nw < st.minNW) st.minNW = nw;
      if (g.cash < st.minCash) st.minCash = g.cash;
      // WHO BOUGHT. Read off the tape, because the auction module is not on the
      // harness bundle's export surface — the news line is the public record.
      for (const n of g.news) {
        if (n.q !== g.month) continue;
        if (/The hammer fell to YOU/.test(n.text)) st.toPlayer++;
        else if (/ took .+ on the steps at /.test(n.text)) { if (/money from out of town/.test(n.text)) st.toOutOfTown++; else st.toRival++; }
        else if (/it is their REO now|No bid reached .+'s number on/.test(n.text)) st.toREO++;
        else if (/crossed the block at .+ to the room/.test(n.text)) st.toRoom++;
        else if (/pulled on the courthouse steps/.test(n.text)) st.pulled++;
        else if (/^The creditors took /.test(n.text)) st.seized++;   // sim.ts liquidation, not an auction
        if (n.kind === "warn") st.warns.add(n.text.replace(/\$[\d.,]+[MK]?/g, "$X").replace(/\d+/g, "N").slice(0, 64));
      }
      if (m % 12 === 0) {
        let v = 0;
        for (const h of Object.values(g.holdings)) { const rec = E.resolveRec(parcels, g, h.bbl); if (rec) v += E.holdingValue(rec, g.econ, h, g.month); }
        st.pv.push(v / g.econ.cpi);
      }
    }
    st.rivalFails = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
    st.forced = (g.exits ?? []).filter((x) => x.forced).length;
    // WHERE DID THE PLAYER'S LOST BUILDINGS ACTUALLY GO? A forced exit is a
    // transfer, and a transfer has a transferee. If a building leaves the
    // player's balance sheet and appears on NOBODY's, then the collateral did
    // not change hands — it evaporated, and the street is one building richer
    // in supply and zero firms richer in assets.
    const owners = new Map();
    for (const r of g.rivals ?? []) for (const b of r.bbls) owners.set(b, r.name);
    st.lostToRival = 0; st.lostToNobody = 0;
    for (const x of (g.exits ?? []).filter((e) => e.forced)) {
      if (owners.has(x.bbl)) st.lostToRival++; else st.lostToNobody++;
    }
    st.nw0 = nw0; st.nw1 = st.died !== null ? 0 : realNW(g, parcels);
    st.pv0 = pv0; st.held = Object.keys(g.holdings).length;
    return st;
  }

  const arms = [];
  for (const seed of SEEDS) {
    const { world, bought, debt } = buildBook(seed);
    const ctrl = runArm(world, false), shk = runArm(world, true);
    arms.push({ seed, bought, debt, ctrl, shk });
    console.log(`\n   seed ${seed} — bought ${bought} building(s) at maximum advance, ${M(debt)} of debt, ${M(debt * 0.15)} reserve`);
    console.log(`     arm      held  realNW start -> end     min realNW   min cash    sweepMs  buildings breached  forced exits  workouts`);
    for (const [nm, a] of [["control", ctrl], ["SHOCKED", shk]]) {
      console.log(`     ${nm.padEnd(9)}${String(a.held).padStart(4)}  ${M(a.nw0).padStart(9)} -> ${M(a.nw1).padStart(9)}`
        + `   ${M(a.minNW).padStart(10)} ${M(a.minCash).padStart(10)}${String(a.sweepMs).padStart(11)}`
        + `${String(a.breached.size).padStart(19)}${String(a.forced).padStart(14)}  ${JSON.stringify(a.wk)}`
        + (a.died !== null ? `  DIED m${a.died}` : ""));
    }
    const fmtPv = (a) => a.pv.map((v) => (v / 1e6).toFixed(0)).join(" ");
    console.log(`     real portfolio mark, one reading per year:`);
    console.log(`       control  ${fmtPv(ctrl)}`);
    console.log(`       SHOCKED  ${fmtPv(shk)}`);
    const whoBid = (a) => `player ${a.toPlayer}, named firm ${a.toRival}, out-of-town ${a.toOutOfTown}, anonymous room ${a.toRoom}, `
      + `struck to the lender (REO) ${a.toREO}, pulled ${a.pulled}  |  ${a.lots} lots docketed, ${a.seized} seized outside the auction`;
    console.log(`     who took the collateral   control: ${whoBid(ctrl)}`);
    console.log(`                               SHOCKED: ${whoBid(shk)}`);
    console.log(`     rival firms failed: control ${ctrl.rivalFails}, shocked ${shk.rivalFails}   revolver over-advanced (months): control ${ctrl.locOver}, shocked ${shk.locOver}`);
    console.log(`     your forced exits, by who ended up owning the building   control: a named firm ${ctrl.lostToRival}, nobody at all ${ctrl.lostToNobody}`);
    console.log(`                                                             SHOCKED: a named firm ${shk.lostToRival}, nobody at all ${shk.lostToNobody}`);
  }

  // IS THE LOSS LEGIBLE? A player who is being destroyed must be able to read
  // why. Count the distinct warning shapes the shocked arm produced that the
  // control never did — those are the sentences the shock is speaking in.
  const a0 = arms[0];
  if (a0) {
    const only = [...a0.shk.warns].filter((w) => !a0.ctrl.warns.has(w)).slice(0, 8);
    console.log(`\n   LEGIBILITY — warning lines the shocked arm printed and the control did not (seed ${a0.seed}):`);
    if (!only.length) console.log(`     none. The shock produced no distinct explanation of itself.`);
    for (const w of only) console.log(`     | ${w}`);
  }
  const sum = (k, arm) => arms.reduce((a, r) => a + r[arm][k], 0);
  for (const arm of ["ctrl", "shk"]) {
    const bid = sum("toRival", arm) + sum("toOutOfTown", arm) + sum("toPlayer", arm) + sum("toRoom", arm);
    const tot = bid + sum("toREO", arm);
    console.log(`\n   ACROSS ${arm === "shk" ? "SHOCKED" : "CONTROL"} ARMS: ${sum("lots", arm)} lots docketed · ${bid} found a bidder `
      + `(${sum("toRival", arm)} a named firm) · ${sum("toREO", arm)} struck to the lender`
      + (tot > 0 ? ` — a real bid cleared the credit bid ${(100 * bid / tot).toFixed(0)}% of the time.` : `.`));
    console.log(`   ${" ".repeat(arm === "shk" ? 15 : 15)}of ${sum("forced", arm)} building(s) taken off you, ${sum("lostToRival", arm)} ended up on a named firm's books `
      + `and ${sum("lostToNobody", arm)} ended up on nobody's.`);
  }
  console.log();
}

// =============================================================================
// 5. DOES CREDIT CYCLE?
//
// WHAT IT IS FOR. Terms, not rates. A credit market is loose at the top and
// shut at the bottom, and it is the ADVANCE RATE and the SPREAD that carry
// that, not the index. Every month of the shared macro pass quoted the same
// $20M building at 7.5% going-in yield at every desk on the street; anything
// that moves in those quotes is the cycle, because nothing about the building
// moved at all.
//
// Reported per desk: mean advance rate and mean spread over the index in each
// phase, how often the desk's window was open, and the correlation of both
// against `creditIdx` — the continuous variable, not the label.
//
// IF IT FAILED: flat advance rates and flat spreads across the cycle mean the
// finance side is decorative. A borrower who cannot be told "no, not this
// year" is not borrowing; they are withdrawing.
// =============================================================================
if (ONLY.includes("5")) {
  console.log("=".repeat(78));
  console.log(`5. DOES CREDIT CYCLE — a fixed ${M(REF_PX)} deal at ${(100 * REF_NOI / REF_PX).toFixed(1)}% going-in, quoted every month`);
  console.log("=".repeat(78));
  const ids = Object.keys(macro[0]?.terms ?? {});
  const phases = ["expansion", "peak", "recession", "recovery"];
  const byPhase = {};
  for (const r of macro) (byPhase[r.phase] ??= []).push(r);

  console.log(`\n   ADVANCE RATE (loan proceeds / price), by cycle phase:`);
  console.log(`   desk         ` + phases.map((p) => p.slice(0, 9).padStart(11)).join("") + `      range        sd    corr(creditIdx)`);
  for (const id of ids) {
    const all = macro.map((r) => r.terms[id].adv);
    console.log(`   ${id.padEnd(13)}`
      + phases.map((p) => p3(mean((byPhase[p] ?? []).map((r) => r.terms[id].adv)), 11)).join("")
      + `   ${p3(Math.min(...all), 5)}..${p3(Math.max(...all), 5)} ${p3(sd(all), 8)}`
      + p3(corr(all, macro.map((r) => r.ci)), 15));
  }

  console.log(`\n   SPREAD over the loan index (percentage points), by cycle phase:`);
  console.log(`   desk         ` + phases.map((p) => p.slice(0, 9).padStart(11)).join("") + `      range        sd    corr(creditIdx)`);
  for (const id of ids) {
    const all = macro.map((r) => r.terms[id].spread);
    console.log(`   ${id.padEnd(13)}`
      + phases.map((p) => p2(mean((byPhase[p] ?? []).map((r) => r.terms[id].spread)), 11)).join("")
      + `   ${p2(Math.min(...all), 5)}..${p2(Math.max(...all), 5)} ${p2(sd(all), 8)}`
      + p3(corr(all, macro.map((r) => r.ci)), 15));
  }

  console.log(`\n   APPETITE AND THE WINDOW — % of months this desk would quote at all:`);
  console.log(`   desk         ` + phases.map((p) => p.slice(0, 9).padStart(11)).join("") + `   mean appetite`);
  for (const id of ids) {
    console.log(`   ${id.padEnd(13)}`
      + phases.map((p) => (p2(100 * mean((byPhase[p] ?? []).map((r) => r.terms[id].open)), 10) + "%")).join("")
      + p3(mean(macro.map((r) => r.terms[id].app)), 14));
  }

  const locAdv = macro.map((r) => r.locAdv).filter(Number.isFinite);
  console.log(`\n   THE REVOLVER — advance against net worth (LOC_LTV is 0.60 before the cycle touches it):`);
  console.log(`   ` + phases.map((p) => `${p} ${p3(mean((byPhase[p] ?? []).map((r) => r.locAdv).filter(Number.isFinite)))}`).join("   "));
  console.log(`   range ${p3(Math.min(...locAdv))} .. ${p3(Math.max(...locAdv))}   corr(creditIdx) ${p3(corr(macro.map((r) => r.locAdv), macro.map((r) => r.ci)))}`);

  console.log(`\n   creditIdx itself: mean ${p3(mean(macro.map((r) => r.ci)))} range ${p3(Math.min(...macro.map((r) => r.ci)))} .. ${p3(Math.max(...macro.map((r) => r.ci)))}`
    + `  (clamped to [0.400, 1.250]; time on the floor ${p2(pct(macro.map((r) => r.ci), (x) => x <= 0.405))}%, on the ceiling ${p2(pct(macro.map((r) => r.ci), (x) => x >= 1.245))}%)`);
  console.log(`\n   A series with sd 0 cannot be evidence of anything. The sd column above is`);
  console.log(`   the check that these numbers CAN move before their means are read.`);
  console.log(`   NOTE: these are STREET quotes, so the desk hold size is skipped — First`);
  console.log(`   Harbor's real ceiling on one asset is $6M and Pelican's floor is $4M, so`);
  console.log(`   the advance rates above are the market's terms, not one borrower's.\n`);
}

console.log("=".repeat(78));
console.log(`done. This file measures; it changes nothing. Rerun after any change to`);
console.log(`debt.ts, credit.ts, lenders.ts, workout.ts or the cap-rate block in market.ts.`);
console.log("=".repeat(78));
