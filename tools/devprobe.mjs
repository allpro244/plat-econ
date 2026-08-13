// WHY DOES DEVELOPMENT PRINT MONEY?
//
// The owner took $6M to $200M in ten years by building, and named four
// suspects: buildings deliver pre-let, LOIs arrive over asking, land demand is
// too strong in good locations, and starting rents may be twice life. This
// measures the arc end to end and reports every number, including the ones
// that say a suspect is innocent.
//
//   node tools/devprobe.mjs                12 seeds x 25 years
//   SEEDS=6 YEARS=40 node tools/devprobe.mjs
//
// A MERCHANT BUILDER, and nothing else. It buys vacant dirt on the tape, builds
// to the envelope, holds, and never sells. That is not a strategy anybody would
// recommend — it is a MEASUREMENT INSTRUMENT, chosen because it isolates the
// development channel from trading. If this bot compounds, the compounding came
// out of the crane and not out of buying well.
//
// The bot is never tuned. If it loses money, that is a finding about the
// economy, and it gets reported as one.
import * as E from "../test/.engine.mjs";
import { loadCity } from "../test/city.mjs";

const SEEDS = Number(process.env.SEEDS ?? 12);
const YEARS = Number(process.env.YEARS ?? 25);
const p = (n, d = 1) => (n * 100).toFixed(d) + "%";
const m$ = (n) => "$" + (n / 1e6).toFixed(2) + "M";
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

/**
 * The best building this site will take, by development spread, that the firm
 * can actually write the cheque for.
 *
 * NOTE: plan.yieldOnCost and plan.exitCap are PERCENTAGE POINTS, not fractions.
 * Reading them as fractions is how the first draft of this probe printed a
 * 605% yield on cost and then built nothing at all.
 */
// FORCE_USE pins the class so the instrument can ask one question at a time —
// the free bot builds nothing but industrial, which tells you about industrial
// and nothing about the office towers the owner was building.
// START_CASH raises the firm's opening balance. It is a MEASUREMENT SETTING,
// not a balance change: with $6M nothing but a shed is fundable, so a probe
// that leaves it alone can only ever measure sheds. Every run says which.
const USES = process.env.FORCE_USE
  ? [process.env.FORCE_USE]
  : ["office", "multifamily", "retail", "industrial", "mixed"];
const START_CASH = Number(process.env.START_CASH ?? 0);
// A negative development spread is a deal a developer walks away from. The
// first bot took them because they were the least bad thing on the tape, which
// is not underwriting — it is a bot with nothing else to do.
const MIN_SPREAD = Number(process.env.MIN_SPREAD ?? 0.75);

function bestPlan(g, parcels, bbl, budget) {
  const rec = E.resolveRec(parcels, g, bbl);
  if (!rec || !rec.lotArea) return null;
  let best = null;
  // COVERAGE IS A DECISION AND THE PROBE HAS TO MAKE IT. Fixing it at 0.6 was
  // an instrument error worth recording: land is now priced at its highest and
  // best use, so a bot that always builds six-tenths of the lot pays for an
  // envelope it then declines to build and loses money on every site. A
  // developer sweeps the ladder; so does this.
  for (const use of USES) {
    for (const cov of [0.45, 0.6, 0.75, 0.9]) {
      const fl = E.maxFloorsFor(rec, cov, use);
      const plan = E.planDevelopment(g, parcels, bbl, use, fl, cov, "gmp", 1);
      if (!plan || !(plan.costTotal > 0)) continue;
      if (plan.equityAtClose + plan.pointsCost > budget) continue;
      const spread = plan.yieldOnCost - plan.exitCap;
      if (spread < MIN_SPREAD) continue;
      if (!best || spread > best.spread) best = { use, fl, cov, spread, plan };
    }
  }
  return best;
}

const deliveries = [];
const arcs = [];          // one per seed: what the firm did over the run
const preletLines = [];
const loiSpreads = [];    // signed rent vs the asking rent at that building

for (let run = 0; run < SEEDS; run++) {
  const { parcels, bbls, adjacency, seed } = loadCity(run, E.normalizeParcels);
  let g = E.newGame(seed, parcels);
  g = E.firstListings(g, parcels, bbls);
  if (START_CASH > 0) g.cash = START_CASH;
  const startCash = g.cash;
  const watching = new Map();

  for (let mo = 0; mo < YEARS * 12; mo++) {
    // --- BUY DIRT, THE WAY A BUILDER BUYS IT: not the cheapest lot, the lot
    // that underwrites best once you have drawn a building on it. The first
    // version of this bot bought cheap and built 27 identical industrial sheds
    // on the worst corners in town; it went broke, which is a fact about the
    // bot and not about the economy.
    if (Object.keys(g.developments ?? {}).length < 3) {
      let pick = null;
      for (const l of g.listings) {
        const r = E.resolveRec(parcels, g, l.bbl);
        if (!r || r.class !== "land" || r.lotArea < 4000 || g.holdings[l.bbl]) continue;
        if (l.ask > g.cash * 0.35) continue;
        const b = bestPlan(g, parcels, l.bbl, g.cash - l.ask);
        if (b && (!pick || b.spread > pick.spread)) pick = { bbl: l.bbl, spread: b.spread };
      }
      if (pick) {
        const r = E.buyListing(g, parcels, pick.bbl, "bank", 0.6);
        if (!r.err) g = r.s;
      }
    }

    // --- BREAK GROUND on anything vacant you own and are not already building.
    for (const h of Object.values(g.holdings)) {
      if (g.developments?.[h.bbl]) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class !== "land") continue;
      const best = bestPlan(g, parcels, h.bbl, g.cash);
      if (!best) continue;
      const r = E.startDevelopment(g, parcels, h.bbl, best.use, best.fl, 0.6, "gmp", 1);
      if (!r.err) {
        g = r.s;
        const d = g.developments[h.bbl];
        if (d) watching.set(h.bbl, {
          startM: g.month, cost: d.costTotal, sf: d.sf, use: d.use,
          equity: d.equityBudget, basis: best.plan.basisTotal,
          plannedYoC: best.plan.yieldOnCost / 100,
          plannedCap: best.plan.exitCap / 100, capAtStart: g.econ.capRate,
        });
      }
    }

    // --- SIGN EVERY LOI AT ASKING OR BETTER, and record the spread.
    for (const loi of g.lois ?? []) {
      const rec = E.resolveRec(parcels, g, loi.bbl);
      const h = g.holdings[loi.bbl];
      if (rec && h) {
        const ask = E.managedRentPsfYr(rec, g.econ, h);
        if (ask > 0) loiSpreads.push({ over: loi.rentPsf / ask - 1, use: loi.use ?? rec.class });
      }
    }
    if ((g.lois ?? []).length) {
      const r = E.respondLOI(g, parcels, 0, "accept");
      if (r && r.s) g = r.s;
    }

    const before = new Set(Object.keys(g.developments ?? {}));
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // The bot must not go broke mid-measurement — insolvency would stop the
    // pipeline and bias every number after it toward the jobs that finished.
    // Reported separately below so the rescue is never mistaken for a result.
    if (g.cash < 0) { arcs.rescued = (arcs.rescued ?? 0) + 1; g.cash = 2_000_000; }
    g.insolventMs = 0; g.gameOver = null;

    for (const bbl of before) {
      if (g.developments?.[bbl]) continue;
      const h = g.holdings[bbl];
      const w = watching.get(bbl);
      watching.delete(bbl);
      if (!h || !w) continue;
      const rec = E.resolveRec(parcels, g, bbl);
      if (!rec || !rec.bldgArea) continue;
      const occ = E.physicalOcc(rec, h);
      const noi = E.holdingNOIYr(rec, g.econ, h, g.month);
      const val = E.holdingValue(rec, g.econ, h, g.month);
      // What it is worth STABILISED — the number a merchant builder actually
      // exits at, because a buyer of a new building underwrites the lease-up.
      //
      // LIKE FOR LIKE, AND IT TOOK TWO GOES. The first draft compared the
      // desk's stabilised yield against the delivered building's AS-IS NOI and
      // reported a 431-622bp miss in every class. Most of that was the
      // instrument: a new building's market occupancy carries a lease-up
      // discount (see leaseUpFactor), so as-is is not the same quantity the
      // plan quoted. noiYr takes a `stabilised` flag; it is used here. Property
      // tax is the other half — planDevelopment charges a taxLoad and noiYr
      // does not, so the tax comes off explicitly.
      const stabNOI = E.noiYr(rec, g.econ, h.condition, true) - E.propertyTaxYr(rec, h);
      // THE MERCHANT'S EXIT, CAPITALISED DIRECTLY — and this is the THIRD
      // instrument error on this investigation, so it is worth naming.
      // assetValue is an AS-IS mark: it applies a lease-up discount to a new
      // building's occupancy, and it floors the answer at 92% of land value,
      // which is correct appraisal practice (a building worth less than its
      // cleared site is a teardown) and completely wrong as a measure of what
      // a stabilised job is worth. Once land was priced properly that floor
      // became the binding term on most new buildings and the probe started
      // reporting 2.67% "cap rates" — which is land, not income.
      // A merchant builder sells a STABILISED building at a market cap, so
      // that is what gets measured: the same NOI the desk underwrote, over the
      // same cap the desk quoted.
      const exitCapPct = E.capRateFor(rec, g.econ, h.condition);
      const stabVal = exitCapPct > 0 ? stabNOI / (exitCapPct / 100) : 0;
      deliveries.push({
        seed, bbl, use: w.use, sf: rec.bldgArea, months: g.month - w.startM,
        cost: w.basis || w.cost, equity: w.equity, occ, noi, val, stabNOI, stabVal,
        // Yield on cost is measured against BASIS — construction plus the land
        // it stands on — because a builder who leaves the dirt out of the
        // denominator is quoting a number nobody can invest at.
        yoc: w.basis > 0 ? stabNOI / w.basis : 0,
        yocAsIs: w.basis > 0 ? noi / w.basis : 0,
        plannedYoC: w.plannedYoC, plannedCap: w.plannedCap,
        exitCap: stabVal > 0 ? stabNOI / stabVal : 0,
        profit: stabVal - w.cost,
        eqMult: w.equity > 0 ? (stabVal - (h.loan?.balance ?? 0)) / w.equity : 0,
        tenants: h.tenants.length,
      });
    }
  }

  for (const n of g.news ?? []) {
    if (typeof n.text === "string" && n.text.startsWith("Let before it opens")) preletLines.push(n.text);
  }
  arcs.push({
    seed, nw: E.netWorth(g, parcels), startCash,
    built: deliveries.filter((d) => d.seed === seed).length,
    holdings: Object.keys(g.holdings).length,
  });
}

// ------------------------------------------------------------------ report
const byUse = {};
for (const d of deliveries) (byUse[d.use] ??= []).push(d);

console.log(`\nDEVELOPMENT, END TO END — ${SEEDS} seeds x ${YEARS} years, a pure merchant builder`);
console.log(`${deliveries.length} deliveries observed\n`);

console.log("  THE ARC — what the firm was worth after, starting from $" + (arcs[0]?.startCash / 1e6).toFixed(1) + "M");
console.log("  seed        net worth      x start   buildings   holdings");
for (const a of arcs) {
  console.log(`  ${String(a.seed).padEnd(10)} ${m$(a.nw).padStart(11)}   ${(a.nw / a.startCash).toFixed(1).padStart(6)}x` +
    `   ${String(a.built).padStart(9)}   ${String(a.holdings).padStart(8)}`);
}
const mults = arcs.map((a) => a.nw / a.startCash);
console.log(`  median ${med(mults).toFixed(1)}x over ${YEARS} years` +
  `  =  ${p(Math.pow(med(mults), 1 / YEARS) - 1, 1)} a year compounded`);
console.log(`  Real world: a good private developer compounds equity at 15-25% a year.`);
if (arcs.rescued) console.log(`  NOTE: the bot was recapitalised ${arcs.rescued} times to keep the pipeline running.`);
console.log("");

console.log("  DELIVERY OCCUPANCY — how full is it the day it opens?");
console.log("  use            n   median occ   mean occ     p10      p90   med tenants");
for (const [use, ds] of Object.entries(byUse)) {
  const occs = ds.map((d) => d.occ);
  const mean = occs.reduce((a, b) => a + b, 0) / occs.length;
  console.log(
    `  ${use.padEnd(12)} ${String(ds.length).padStart(3)}   ${p(med(occs)).padStart(9)}` +
    `   ${p(mean).padStart(8)}  ${p(pct(occs, 0.1)).padStart(7)}  ${p(pct(occs, 0.9)).padStart(7)}   ${String(med(ds.map((d) => d.tenants))).padStart(6)}`,
  );
}
console.log(`\n  Real world: spec office delivers 0-30% pre-let; spec multifamily 0% and`);
console.log(`  leases up over 12-24 months. Build-to-suit is 100% but is not spec.\n`);

console.log("  THE MERCHANT SPREAD — stabilised yield on cost against the exit cap");
console.log("  use            n   med YoC   med exit cap   spread (bp)   med profit   med cost");
for (const [use, ds] of Object.entries(byUse)) {
  const yoc = med(ds.map((d) => d.yoc));
  const cap = med(ds.map((d) => d.exitCap));
  console.log(
    `  ${use.padEnd(12)} ${String(ds.length).padStart(3)}   ${p(yoc, 2).padStart(7)}   ${p(cap, 2).padStart(12)}` +
    `   ${String(Math.round((yoc - cap) * 10000)).padStart(11)}   ${m$(med(ds.map((d) => d.profit))).padStart(10)}   ${m$(med(ds.map((d) => d.cost))).padStart(8)}`,
  );
}
console.log(`\n  Real world: merchant development earns 100-200bp of yield over the exit`);
console.log(`  cap. Anything much wider is a risk nobody is charging for, or a cost`);
console.log(`  line that is missing.\n`);

// THE PROMISE AGAINST THE BUILDING. planDevelopment quotes a yield on cost at
// the desk and the delivered building has one of its own. If they disagree the
// player was shown a decision that is not the decision they were taking — the
// same-quantity-two-answers fault, and the worst kind because it is the number
// the whole go/no-go rests on.
console.log("  WHAT THE DESK PROMISED vs WHAT OPENED");
console.log("  use            planned YoC   delivered YoC     miss   planned cap   delivered cap");
for (const [use, ds] of Object.entries(byUse)) {
  const pl = med(ds.map((d) => d.plannedYoC));
  const ac = med(ds.map((d) => d.yoc));
  const pc = med(ds.map((d) => d.plannedCap));
  const dc = med(ds.map((d) => d.exitCap));
  console.log(
    `  ${use.padEnd(12)} ${p(pl, 2).padStart(11)}   ${p(ac, 2).padStart(13)}` +
    `   ${String(Math.round((ac - pl) * 10000)).padStart(6)}bp   ${p(pc, 2).padStart(11)}   ${p(dc, 2).padStart(13)}`,
  );
}
console.log("");

console.log("  PROFIT ON COST, AND ON EQUITY");
for (const [use, ds] of Object.entries(byUse)) {
  const r = ds.map((d) => (d.cost > 0 ? d.stabVal / d.cost : 0));
  const e = ds.map((d) => d.eqMult).filter((x) => x > 0);
  console.log(
    `  ${use.padEnd(12)} value/cost ${med(r).toFixed(2)}x  (p10 ${pct(r, 0.1).toFixed(2)}  p90 ${pct(r, 0.9).toFixed(2)})` +
    `   equity multiple ${med(e).toFixed(2)}x   ${med(ds.map((d) => d.months))} months`,
  );
}
const losers = deliveries.filter((d) => d.stabVal < d.cost).length;
console.log(`\n  Jobs that delivered worth LESS than they cost: ${losers} of ${deliveries.length} (${p(losers / Math.max(1, deliveries.length))})`);
console.log(`  Real world: a healthy pipeline loses money on a real share of its jobs.`);
console.log(`  A development business where nothing ever loses is not a business.\n`);

if (loiSpreads.length) {
  const over = loiSpreads.map((x) => x.over);
  const aboveAsk = over.filter((x) => x > 0.005).length;
  console.log(`  LETTERS OF INTENT vs THE ASKING RENT — ${over.length} letters`);
  console.log(`  median ${p(med(over), 1)} over ask   p10 ${p(pct(over, 0.1), 1)}   p90 ${p(pct(over, 0.9), 1)}`);
  console.log(`  ${aboveAsk} of ${over.length} (${p(aboveAsk / over.length)}) came in ABOVE the quoted rent.`);
  console.log(`  Real world: a tenant offering over the asking rent is rare — it happens in`);
  console.log(`  a bidding war for the last block of space in a tight market, not routinely.\n`);
}

console.log(`  PRE-LET DESK FIRED ${preletLines.length} times across ${SEEDS} runs`);
for (const t of preletLines.slice(0, 3)) console.log("    " + t.slice(0, 140));
console.log("");
