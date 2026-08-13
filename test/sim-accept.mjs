// THE SIMULATION ACCEPTANCE SUITE — the macro half of the economy.
//
// econ-accept.mjs asserts that the SPACE market is real: location matters,
// supply is felt, tenants are conserved. This file asserts the thing under
// it — that the economy those tenants live in is a closed system rather than
// a set of scripted drifts, and that RENT IS A BY-PRODUCT OF IT.
//
// The owner's words: "rent should be a by product of the economy, and the
// economy should be very complex and pulls on each other and intertwines and
// not have anything be fakely made up."
//
// Every test here is a loop that must close:
//   F. INCOME ANCHOR   rents are paid out of incomes, so they cannot durably
//                      outrun them. Real rent growth lands near productivity,
//                      not at 3.3x it. This is the $1,000/sf test.
//   G. POLICY RESPONDS the interest rate is not a script. It rises with
//                      inflation and falls when the city is in trouble.
//   H. THE GLUT IS SEEN a city drowning in empty space cannot be described as
//                      an expansion, and every extra point of vacancy has to
//                      cost something — no saturating term where more empty
//                      space is free.
//   I. BUILDING COSTS BITE a construction boom bids up the trades, which is
//                      what makes a real supply cycle self-limiting.
//
// Run: node test/sim-accept.mjs (bundle first, like every other harness).
//
// EVERY BAND IN THIS FILE IS NOW REPORTED RATHER THAN GATED — owner's
// decision, 2026-08-06. The arithmetic is untouched; see test/accept-lib.mjs
// for what that means and why, and ECONOMY.md for who decided it. This file
// is the one that earned the decision: F, G and H each had to have their
// estimator rebuilt this session before they could tell a real breach from
// their own sampling noise, and H breached on 13 of 30 NEUTRAL seeds while
// doing it.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSuite } from "./accept-lib.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const clone = () => JSON.parse(JSON.stringify(P0));
const { report, verdict } = makeSuite();
// TWENTY SEEDS, NOT SEVEN, AND THE OLD NOTE HERE WAS WRONG.
//
// It used to say seven was "the smallest number where the median stopped
// moving when the unrelated parts of the RNG stream shifted". Measured, it
// does not stop moving: office real rent came back +1.11%/yr, then +1.95%/yr
// after an unrelated change, and +0.62%/yr on twenty seeds of the same build.
// Its per-seed spread runs -5.21 to +3.63 and twelve of twenty seeds land
// outside the band the MEDIAN passes comfortably. A seven-seed median of that
// distribution is a coin flip, and it nearly cost a correct mechanism: the
// sector-exit ratchet was measured as making office WORSE when what it had
// actually done was resample the noise.
//
// The dispersion itself is not a fault — fifty-year rent paths in a cyclical
// city genuinely do run that wide. It is a fact about what this metric needs
// to be measured with.
const CLASSES = ["office", "retail", "multifamily", "industrial"];
// FORTY SEEDS, SHARED, AND MEMOISED. F needs twenty for a median it can trust
// and G needs forty for a proportion it can trust (see each). Running them
// separately would pay for sixty 600-month simulations to measure two things
// about the same forty economies, so macroRun caches and both read the list.
const SEEDS = [550991, 12007, 73303, 11, 22, 33, 4242, 777, 90210, 31337, 8080, 60601,
  10001, 4004, 5150, 271828, 161803, 99999, 123456, 2718, 313, 2468, 60613, 94110, 2020,
  1618, 4321, 8675, 90909, 5040, 7919, 104729, 3571, 22222, 65537, 82944, 11235, 31415,
  27182, 14142];
const SEEDS_F = SEEDS.slice(0, 20);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
const CAGR = (a, b, yrs) => (Math.pow(b / a, 1 / yrs) - 1) * 100;
const corr = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    sxy += a * b; sxx += a * a; syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
};

/**
 * KEEP THE OBSERVER ALIVE, OR THE WORLD STOPS AND THE TEST DOES NOT NOTICE.
 *
 * `advanceQuarter` opens with `if (prev.gameOver) return prev` — the state is
 * returned UNCHANGED. A macro run has no bot in it, so the firm does nothing,
 * pays its G&A every month out of $6M, and goes insolvent; from that month on
 * the run is a no-op and every index in it is frozen at the value it had when
 * the firm died. Nothing throws. Nothing is logged. The loop keeps counting to
 * 600 and the arrays keep filling with the same number.
 *
 * MEASURED: 15 of 20 seeds die before month 600, median at year 41, and four
 * of the seven seeds F and G actually use are among them — seed 11 simulates
 * SIXTEEN years and then reports a fifty-year trend from thirty-four years of
 * a frozen index. That is what produced real rent CAGRs of -22.9%/yr and
 * +13.0%/yr in the same test: they are not economies, they are a cliff
 * followed by a flat line, annualised.
 *
 * city-accept.mjs already does this and says why. sim-accept never did.
 *
 * The observer owns nothing and buys nothing, so handing it cash cannot
 * flatter any number this file measures — every one of them is read off
 * `econ`, which belongs to the city rather than to the firm.
 */
function keepAlive(g) {
  g.cash = 50_000_000;
  g.insolventMs = 0;
  g.gameOver = null;
  return g;
}

const MACRO_CACHE = new Map();
/** A plain 50-year run of the city with nobody playing. Memoised — see SEEDS. */
function macroRun(seed, months = 600) {
  const key = seed + ":" + months;
  if (MACRO_CACHE.has(key)) return MACRO_CACHE.get(key);
  const out = macroRunRaw(seed, months);
  MACRO_CACHE.set(key, out);
  return out;
}

function macroRunRaw(seed, months) {
  const parcels = clone();
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const t = [];
  let prevCpi = g.econ?.cpi ?? 1;
  for (let m = 0; m < months; m++) {
    g = keepAlive(E.advanceQuarter(g, parcels, bbls, adjacency));
    const e = g.econ;
    t.push({
      m: g.month,
      rent: e.rentIdx.office, eff: e.effRentIdx?.office ?? e.rentIdx.office,
      // ALL FOUR MARKETS, because the anchor is a claim about rent and there
      // are four rents. See F.
      rents: { office: e.rentIdx.office, retail: e.rentIdx.retail, multifamily: e.rentIdx.multifamily, industrial: e.rentIdx.industrial },
      cpi: e.cpi ?? 1, wage: e.wageIdx ?? 1, cost: e.costIdx,
      rate: e.indexRate, unemp: e.unemployment ?? 0.05,
      // THE POLICY RATE, separately from what a borrower pays. G needs both:
      // the bank's rate is the one that answers "did policy respond", and the
      // loan index carries a term premium that moves against it. And monthly
      // inflation, so a change-on-change correlation does not have to
      // reconstruct it from CPI levels twice.
      policy: e.nat?.policy ?? e.indexRate,
      inflMo: prevCpi > 0 ? ((e.cpi ?? 1) / prevCpi - 1) * 1200 : 0,
      vac: e.cityVac.office, phase: e.phase, jobs: e.jobs ?? 0,
    });
    prevCpi = e.cpi ?? 1;
  }
  return t;
}

// ---------------------------------------------------------------------------
// F. THE INCOME ANCHOR — the $1,000/sf test
// ---------------------------------------------------------------------------
// Rent is a payment out of somebody's income. Over fifty years a market's real
// rent per square foot may drift with productivity and with genuine scarcity,
// but it cannot triple in real terms while the wages of the city that pays it
// go nowhere — that is not a property market, it is a spreadsheet compounding.
// Real-world anchor: long-run real commercial rent growth is ~0%/yr, and the
// rent-to-income ratio is roughly trendless. We allow a dense, chronically
// tight city to earn a premium, which is why the band has room on the upside.
//
// IT USED TO CHECK ONE MARKET OUT OF FOUR.
//
// The claim in the title is about RENT, and this city has four rents. It read
// rentIdx.office and nothing else, so three quarters of the economy could
// compound away unwatched — and it was. Measured over four seeds and fifty
// years, real rent growth by class:
//
//   office       +2.03%/yr        retail       +2.62%/yr
//   multifamily  +1.70%/yr        industrial   +2.88%/yr
//
// The two worst are exactly the two the city cannot build: retail stock grows
// 0.04%/yr over fifty years and industrial 0.12%, because both are capped at
// two floors (correctly — a warehouse is single-storey and a parade of shops
// is not a tower) and industrial can only go on M-zoned land, of which this
// island has sixty-one vacant lots. Demand keeps growing against a frozen
// stock, and with a price elasticity of -0.4 the only variable left to move is
// rent. +2.88%/yr real is a 4.1x real rent over the run.
//
// Which is arithmetically correct and economically wrong, and the reason is
// the thing this test now exposes: a real city that cannot build industrial
// LOSES THE INDUSTRY. It rezones, the sector leaves, and the demand goes with
// it. This one's zoning never changes in fifty years, so the tenants stay and
// pay four times the rent forever.
//
// This is expected to FAIL until that is fixed. It is failing at the truth.
{
  const runs = SEEDS_F.map((seed) => {
    const t = macroRun(seed);
    // MEASURED FROM YEAR TEN, NOT FROM MONTH ZERO.
    //
    // Month zero is no longer a neutral position: a new game now draws a
    // starting era (see src/engine/regime.ts), so it can open in a Volcker
    // aftermath with the rent index at 40 or in a long expansion with it at
    // 72. Trend growth measured from a random point in the cycle is not trend
    // growth — a run that opens depressed shows high "growth" while it is
    // merely normalising, which is exactly what pushed this median to 1.67%.
    // Ten years of burn-in puts every seed past its opening draw before the
    // clock starts. The ratio clause below needs no burn-in and did not move:
    // it is a level, and a level is unaffected by where the measurement began.
    const a = t.find((x) => x.m >= 120) ?? t[0], b = t[t.length - 1];
    const yrs = (b.m - a.m) / 12;
    const infl = CAGR(a.cpi, b.cpi, yrs);
    const wageReal = CAGR(a.wage / a.cpi, b.wage / b.cpi, yrs);
    const real = {};
    for (const k of CLASSES) real[k] = CAGR(a.rents[k], b.rents[k], yrs) - infl;
    // the ratio that has to hold: real rent per sf against real income
    const r0 = (a.rent / a.cpi) / (a.wage / a.cpi);
    const r1 = (b.rent / b.cpi) / (b.wage / b.cpi);
    return { seed, infl, real, wageReal, ratio: r1 / r0, endRent: b.rent, endCpi: b.cpi };
  });
  const byClass = {};
  for (const k of CLASSES) byClass[k] = med(runs.map((r) => r.real[k]));
  const ratio = med(runs.map((r) => r.ratio));
  const realWage = med(runs.map((r) => r.wageReal));
  const infl = med(runs.map((r) => r.infl));
  // EVERY market has to hold the anchor, not the one that happens to be
  // behaving. The worst class is the test.
  const worst = CLASSES.reduce((w, k) => (Math.abs(byClass[k]) > Math.abs(byClass[w]) ? k : w), CLASSES[0]);
  const allInBand = CLASSES.every((k) => byClass[k] >= -1.0 && byClass[k] <= 1.5);
  report("F. INCOME ANCHOR — can rents outrun the wages that pay them?",
    allInBand && ratio <= 1.8 && realWage >= 0.0 && realWage <= 2.5
      && infl >= 0.8 && infl <= 4.5,
    [`real rent growth by class, median of ${runs.length} seeds   (every one needs -1.0 to +1.5)`,
     ...CLASSES.map((k) => `   ${k.padEnd(12)} ${byClass[k] >= 0 ? "+" : ""}${byClass[k].toFixed(2)}%/yr` +
       (byClass[k] >= -1.0 && byClass[k] <= 1.5 ? "" : `   <-- ${Math.pow(1 + byClass[k] / 100, 40).toFixed(1)}x real over the run`)),
     `   worst: ${worst}`,
     `office per seed: ${runs.map((r) => r.real.office.toFixed(2) + "%").join("  ")}`,
     `rent-to-income over 50y (office): ${runs.map((r) => r.ratio.toFixed(2) + "x").join("  ")}   median ${ratio.toFixed(2)}x   (need <= 1.8x)`,
     `real WAGE growth: ${runs.map((r) => r.wageReal.toFixed(2) + "%").join("  ")}   median ${realWage.toFixed(2)}%/yr   (need 0 to 2.5 — a city whose workers get poorer for 50 years is broken)`,
     `inflation: ${runs.map((r) => r.infl.toFixed(2) + "%").join("  ")}   median ${infl.toFixed(2)}%/yr   (need 0.8 to 4.5)`,
     `office asking at year 50: ${runs.map((r) => "$" + r.endRent.toFixed(0)).join("  ")} nominal (CPI ${runs.map((r) => r.endCpi.toFixed(1) + "x").join(" ")})`]);
}

// ---------------------------------------------------------------------------
// G. POLICY RESPONDS — the rate is not a script
// ---------------------------------------------------------------------------
// A central bank raises into inflation and cuts into unemployment. If the rate
// responds to neither, then "the rate era" is weather and the player's
// fix-or-float decision is a coin flip rather than a read on the economy.
//
// IT WAS ASKING ABOUT THE CENTRAL BANK AND MEASURING THE BORROWER'S RATE,
// IN LEVELS. Both halves of that were wrong, and together they buried a
// policy rule that works. Measured over 30 seeds:
//
//   unemployment vs POLICY RATE, in levels        -0.023   13/30 wrong sign
//   unemployment vs POLICY RATE, 12m changes      -0.119    6/30 wrong sign
//   unemployment vs LOAN INDEX,  12m changes      +0.060   20/30 wrong sign
//
// LEVELS: over fifty years the level of the policy rate is set by the era —
// a Volcker opening at 14%, a ZIRP decade at 0.5% — and those swings have
// nothing to do with this month's unemployment. They drown the cyclical
// response entirely. "Cuts into a weak labour market" is a claim about the
// CYCLE, so it has to be asked of changes.
//
// LOAN INDEX: the borrower's rate is the policy rate PLUS a term premium, and
// that premium widens when credit is frightened — which is exactly when
// unemployment is high. corr(unemployment, term premium) is +0.436. So the
// spread offsets the cut, and asking the loan index whether the bank eased
// gets an answer about the bond market instead. That offset is not a bug: it
// is why borrowers do not feel the whole of a rate cut in a crisis, and it is
// reported below rather than tested away.
//
// The rule itself was never broken. It is a Taylor rule with a 0.5 coefficient
// on the output gap, and the city has a real Phillips curve behind it —
// corr(unemployment, inflation) is -0.354 over 24 seeds — so the two terms
// reinforce rather than fight.
//
// A SIGN TEST NEEDS A MAJORITY, NOT A MEDIAN. The old gate asked whether a
// median cleared zero, and the per-seed spread runs -0.65 to +0.73, so it was
// testing the sign of a coin. Requiring two thirds of runs to agree is a
// statement about whether the relationship EXISTS, and it cannot be passed by
// a lucky draw. Two thirds is not fitted to the result: the measurements come
// back 30/30 and 24/30.
{
  const SEEDS_G = SEEDS;
  const d12 = (a) => a.slice(12).map((v, j) => v - a[j]);
  const smooth = (a) => a.map((_, j) => {
    const w = a.slice(Math.max(0, j - 11), j + 1);
    return w.reduce((x, y) => x + y, 0) / w.length;
  });
  const runs = SEEDS_G.map((seed) => {
    const t = macroRun(seed).filter((x) => x.m >= 120);   // past the opening era draw
    const pol = t.map((x) => x.policy);
    const loan = t.map((x) => x.rate);
    const un = t.map((x) => x.unemp * 100);
    const inf = smooth(t.map((x) => x.inflMo));
    return {
      seed,
      ri: corr(d12(inf), d12(pol)),
      ru: corr(d12(un), d12(pol)),
      rl: corr(d12(un), d12(loan)),
    };
  });
  const ri = med(runs.map((r) => r.ri));
  const ru = med(runs.map((r) => r.ru));
  const rl = med(runs.map((r) => r.rl));
  const upOnInfl = runs.filter((r) => r.ri > 0).length;
  const downOnUnemp = runs.filter((r) => r.ru < 0).length;
  // THE BAR COMES FROM THE NULL, NOT FROM THE ANSWER.
  //
  // Two thirds was the first attempt and it was a knife edge: measured on
  // forty neutral seeds the true proportion is 27/40, so a bar AT the true
  // value fails about half the time by construction — which is how this gate
  // first came back 24/30 on one seed list and 12/20 on another.
  //
  // What the test has to reject is "there is no relationship", which is a coin
  // at 20/40. Requiring 60% clears that at about the 8% level while passing
  // comfortably at the ~70% the model actually shows. Both numbers are
  // properties of the binomial and of the claim, not of the result: the same
  // bar was chosen before the ratchet A/B was run, and it passes on both sides
  // of it (27/40 with, 30/40 without).
  const need = Math.ceil(runs.length * 0.60);
  report("G. POLICY RESPONDS — does the rate read the economy?",
    upOnInfl >= need && downOnUnemp >= need,
    [`12-month CHANGES in the POLICY RATE, ${runs.length} seeds, past year ten`,
     `   raises into inflation:      ${upOnInfl}/${runs.length} runs   median r ${ri >= 0 ? "+" : ""}${ri.toFixed(3)}   (need ${need}/${runs.length})`,
     `   eases into unemployment:    ${downOnUnemp}/${runs.length} runs   median r ${ru >= 0 ? "+" : ""}${ru.toFixed(3)}   (need ${need}/${runs.length})`,
     `and what the BORROWER feels, same changes against the loan index:`,
     `   eases into unemployment:    ${runs.filter((r) => r.rl < 0).length}/${runs.length} runs   median r ${rl >= 0 ? "+" : ""}${rl.toFixed(3)}`,
     `   the term premium widens as the bank cuts, so a borrower does not get the whole of it —`,
     `   that gap is the mechanism, not a failure, and it is why this is reported and not gated`]);
}

// ---------------------------------------------------------------------------
// H. THE GLUT IS SEEN — a drowning city cannot be called an expansion
// ---------------------------------------------------------------------------
// The owner's cheat scenario, verbatim: flood the city with empty office and
// watch the top-left corner keep saying "expansion". Two clauses. The phase
// machine must see the slack; and the rent drift must never SATURATE — every
// extra point of vacancy has to keep costing rent, or a 45% glut is priced
// the same as a 20% one.
//
// ONE GLUT WAS NOT A MEASUREMENT. This ran a single seed, and the rate clause
// turned out to be a coin flip: across fifteen gluts the loan-index drift
// spans -2.9pp to +2.4pp, and on the engine as it stood when this note was
// written SEVEN of those fifteen breached the +0.5pp limit. The suite reported
// a pass because seed 910117 happened to land on the good side of its own
// distribution, and any change anywhere in the engine could flip it without
// touching what the test claims to measure.
//
// So the scenario now runs nine times and every clause is a median. Nothing
// about the standard moved — the thresholds are the ones that were here, and
// they are applied to an estimate that can actually resolve them. This is the
// same repair econ-accept's conservation test already carries, for the same
// reason: a gate that answers from one draw is not a gate, it is a coin.
{
  const GLUTS = [910117, 550991, 12007, 73303, 11, 22, 33, 4242, 90210];
  //
  // AND THE RATE CLAUSE IS MEASURED AGAINST A CONTROL.
  //
  // "Did the loan index rise over the twelve years after the glut" attributes
  // every basis point in that window to the glut, and that stopped being safe
  // when the neutral real rate started wandering on a multi-decade clock (see
  // regime.ts): a run can now contain a genuine secular rate rise that has
  // nothing whatever to do with 4M sf of empty office. So each glut is run
  // twice from the identical month-36 state — once with the space dropped in,
  // once without — and what is asserted is the DIFFERENCE. That is the same
  // counterfactual econ-accept's supply-shock test already uses, and for the
  // same reason: the only honest way to measure what a shock did is against
  // the city that did not receive it.
  const runs = GLUTS.map((seed) => {
    const parcels = clone();
    let g0 = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    for (let m = 0; m < 36; m++) g0 = keepAlive(E.advanceQuarter(g0, parcels, bbls, adjacency));
    const walk = (g, glut) => {
      const p = JSON.parse(JSON.stringify(parcels));
      let s2 = JSON.parse(JSON.stringify(g));
      if (glut) E.addStock(s2.econ, "office", 4_000_000);
      const t = [];
      for (let m = 0; m < 144; m++) {
        s2 = keepAlive(E.advanceQuarter(s2, p, bbls, adjacency));
        const policy = s2.econ.nat?.policy ?? s2.econ.indexRate;
        const loan = s2.econ.indexRate;
        t.push({
          vac: s2.econ.cityVac.office,
          phase: s2.econ.phase,
          rent: s2.econ.rentIdx.office,
          rate: loan,
          policy,
          prem: loan - policy,
          jobs: s2.econ.jobs ?? 0,
          unemp: s2.econ.unemployment ?? 0,
          credit: s2.econ.creditIdx ?? 1,
          conc: s2.econ.concIdx?.office ?? 0,
        });
      }
      return t;
    };
    const t = walk(g0, true), ctrl = walk(g0, false);
    const deep = t.filter((x) => x.vac > 0.25);
    const lying = deep.filter((x) => x.phase === "expansion" || x.phase === "peak").length;
    // A SEED WITH NO DEEP MONTHS HAS NOTHING TO SAY ABOUT THE PHASE MACHINE,
    // and it used to say the best possible thing. `share` was
    // `deep.length ? lying / deep.length : 0`, so a glut that never pushed
    // vacancy past 25% on that seed contributed a PERFECT 0% to the median of
    // the clause about lying — the one seed with no evidence voting hardest
    // for acquittal. The share is now `null` on those seeds and they are
    // excluded from the median and counted in the print. (Measured on this
    // build: 0 of 9 seeds land there, so this changes no number today. It is
    // the shape that is wrong, not the reading.)
    const win = (xs) => xs.slice(24, 96);
    const mean = (xs, f) => xs.reduce((a, x) => a + f(x), 0) / Math.max(1, xs.length);
    const dPolicy = mean(win(t), (x) => x.policy) - mean(win(ctrl), (x) => x.policy);
    const dPrem = mean(win(t), (x) => x.prem) - mean(win(ctrl), (x) => x.prem);
    const dLoan = mean(win(t), (x) => x.rate) - mean(win(ctrl), (x) => x.rate);
    const dJobs = t[48].jobs - ctrl[48].jobs;
    const dUnemp = t[48].unemp - ctrl[48].unemp;
    const dCredit = mean(win(t), (x) => x.credit) - mean(win(ctrl), (x) => x.credit);
    const dConc = mean(win(t), (x) => x.conc) - mean(win(ctrl), (x) => x.conc);
    return {
      peakVac: Math.max(...t.map((x) => x.vac)),
      deepMonths: deep.length,
      share: deep.length ? lying / deep.length : null,
      dPolicy, dPrem, dLoan, dJobs, dUnemp, dCredit, dConc,
      rentFall: 1 - Math.min(...t.map((x) => x.rent)) / t[0].rent,
    };
  });
  const peakVac = med(runs.map((r) => r.peakVac));
  const scored = runs.filter((r) => r.share !== null);
  const share = scored.length ? med(scored.map((r) => r.share)) : 1;
  const dPolicy = med(runs.map((r) => r.dPolicy));
  const dPrem = med(runs.map((r) => r.dPrem));
  const dJobs = med(runs.map((r) => r.dJobs));
  const dUnemp = med(runs.map((r) => r.dUnemp));
  const dCredit = med(runs.map((r) => r.dCredit));
  const dConc = med(runs.map((r) => r.dConc));
  // cityVac is clamped to 0.45 in market.ts. If the peak ever rests there the
  // vacancy clause is reading a rail rather than the market, so print the
  // headroom rather than trusting it.
  const atRail = runs.filter((r) => r.peakVac >= 0.4495).length;
  // ECONOMY.md H: the old clause tested loan-index drift and failed whenever
  // CRE spreads blew out into a glut — which is the documented fact, not a
  // bug. The separable claims are: policy must not tighten on the glut, the
  // risk premium must widen, and the space market must reach labour/credit
  // (jobs down or unemployment up; credit soft; concessions up).
  const labourHears = dJobs < -200 || dUnemp > 0.002;
  const creditHears = dCredit < -0.02;
  const concHears = dConc > 0.05;
  report("H. THE GLUT IS SEEN — 4M sf of empty office dropped on the city, 9 seeds",
    peakVac > 0.25 && scored.length >= 5 && share <= 0.15
      && dPolicy <= 0.35 && dPrem >= 0.05
      && labourHears && creditHears && concHears,
    [`office vacancy peaked at ${(peakVac * 100).toFixed(1)}% median   (per seed ${runs.map((r) => (r.peakVac * 100).toFixed(0) + "%").join(" ")})`,
     `   ${atRail} of ${runs.length} seeds peak ON the 45% cityVac clamp (market.ts) — at the clamp this number stops being a measurement`,
     `share of a >25%-vacant market called 'expansion' or 'peak': ${(share * 100).toFixed(0)}% median of ${scored.length} seeds   (need <= 15%)`,
     `   months above 25% vacancy per seed: ${runs.map((r) => r.deepMonths).join(" ")}   (a seed with none is excluded, not scored 0%)`,
     `POLICY drift attributable to the glut: ${dPolicy >= 0 ? "+" : ""}${dPolicy.toFixed(2)}pp median   (need <= +0.35 — bank must not tighten into empty floors)`,
     `term PREMIUM drift attributable to the glut: ${dPrem >= 0 ? "+" : ""}${dPrem.toFixed(2)}pp median   (need >= +0.05 — lenders charge for vacant collateral)`,
     `   loan-index net (reported, not gated): ${med(runs.map((r) => r.dLoan)) >= 0 ? "+" : ""}${med(runs.map((r) => r.dLoan)).toFixed(2)}pp — premium and policy are allowed to fight`,
     `labour hears the glut: Δjobs@48 ${Math.round(dJobs)}   ΔU@48 ${(dUnemp * 100).toFixed(2)}pp   (need jobs↓ or U↑)`,
     `credit / concessions: Δcredit ${dCredit.toFixed(3)}   Δconc ${(dConc * 100).toFixed(1)}pp`,
     `rent fell ${(med(runs.map((r) => r.rentFall)) * 100).toFixed(0)}% from the drop to the trough, median`]);
}

// ---------------------------------------------------------------------------
// I. BUILDING COSTS BITE — the supply cycle limits itself
// ---------------------------------------------------------------------------
// When everybody builds at once, the trades are busy and they charge for it.
// That is the brake that makes real construction booms end without anybody
// deciding they should. If costIdx is deaf to how much is being built, then
// the only thing stopping a boom is a number somebody typed.
{
  const runs = [550991, 12007, 73303, 11, 22].map((seed) => {
    const t = [];
    const parcels = clone();
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    for (let m = 0; m < 600; m++) {
      g = keepAlive(E.advanceQuarter(g, parcels, bbls, adjacency));
      const e = g.econ;
      const pipe = (e.pipeline?.office ?? 0) + (e.pipeline?.multifamily ?? 0)
        + (e.pipeline?.retail ?? 0) + (e.pipeline?.industrial ?? 0);
      const stock = e.stock.office + e.stock.multifamily + e.stock.retail + e.stock.industrial;
      t.push({ build: stock > 0 ? pipe / stock : 0, cost: e.costIdx, cpi: e.cpi ?? 1 });
    }
    // real construction cost (over CPI) against how much is under way, annually
    const bs = [], cs = [];
    for (let i = 60; i + 12 < t.length; i += 6) {
      bs.push(t[i].build);
      cs.push((t[i + 12].cost / t[i + 12].cpi) / (t[i].cost / t[i].cpi) - 1);
    }
    return { seed, c: corr(bs, cs) };
  });
  const c = med(runs.map((r) => r.c));
  report("I. BUILDING COSTS BITE — does a boom bid up the trades?",
    c >= 0.25,
    [`corr(share of stock under construction, next year's REAL cost growth): ${runs.map((r) => r.c.toFixed(2)).join("  ")}   median ${c.toFixed(2)}   (need >= 0.25)`,
     `a boom that does not raise costs is a boom with no brake but the calendar`]);
}

// ---------------------------------------------------------------------------
verdict();
