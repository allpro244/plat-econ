// DOES ANY OF IT ACTUALLY HAPPEN?
//
// A system that never fires is a comment. This walks long campaigns with a
// levered bot and counts the things the banking, workout and portfolio code
// are supposed to produce — defaults opened, how each one ended, lenders
// rationing and failing, and unsolicited portfolio approaches — so the answer
// to "is this in the game" is a number rather than a hope.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ?? join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

const HORIZON = Number(process.env.HORIZON ?? 600);
const SEEDS = Number(process.env.SEEDS ?? 12);

const tally = {
  workoutsOpened: 0, cured: 0, extended: 0, deeded: 0, auctioned: 0,
  lenderFails: 0, rationingMonths: 0, shutMonths: 0,
  portfolioApproaches: 0, portfolioClosed: 0,
  minCapRatio: 1, maxDelinq: 0, nw: [],
};

for (let seed = 0; seed < SEEDS; seed++) {
  let g = E.firstListings(E.newGame(1000 + seed, parcels), parcels, bbls);
  const seen = new Set();
  let lastPortfolio = false;
  for (let m = 0; m < HORIZON && !g.gameOver; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);

    // leases keep the buildings full enough to be worth owning
    for (const loi of [...g.lois]) {
      const r = E.respondLOI(g, parcels, loi.id, "accept", true);
      if (!r.err) g = r.s;
    }

    // BUY LEVERED. Maximum-leverage floating paper on a three-year balloon is
    // exactly the diet that produces defaults, which is what this is measuring.
    if (!Object.keys(g.talks ?? {}).length && m % 4 === 0 && g.cash > 1_000_000) {
      for (const l of g.listings) {
        if (g.holdings[l.bbl]) continue;
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec || rec.class === "land") continue;
        const r = E.negotiate(g, parcels, l.bbl, Math.round(l.ask * 0.94));
        if (!r.err) { g = r.s; break; }
      }
    }
    for (const t of Object.values(g.talks ?? {})) {
      if (t.agreed) {
        let r = E.closeDeal(g, parcels, t.bbl, "cordage", 1);
        if (r.err) r = E.closeDeal(g, parcels, t.bbl, "savings", 1);
        if (!r.err) g = r.s;
      } else {
        const r = E.acceptCounter(g, parcels, t.bbl);
        if (!r.err) g = r.s; else g = E.walkAway(g, parcels, t.bbl).s;
      }
    }

    // the workout table: cure if cheap, otherwise ask, otherwise hand it back
    for (const w of Object.values(g.workouts ?? {})) {
      if (!seen.has(w.bbl + "|" + w.startM)) { seen.add(w.bbl + "|" + w.startM); tally.workoutsOpened++; }
    }
    for (const w of Object.values(g.workouts ?? {})) {
      if (g.cash > w.cure * 1.6) {
        const r = E.cureWorkout(g, parcels, w.bbl);
        if (!r.err) { g = r.s; tally.cured++; continue; }
      }
      if (w.asks < 1 && w.stage !== "foreclosure") {
        const r = E.requestForbearance(g, parcels, w.bbl);
        if (!r.err) { g = r.s; if (g.workouts?.[w.bbl]?.stage === "forbearance") tally.extended++; continue; }
      }
      if (w.stage === "foreclosure" && Math.random() < 0.4) {
        const r = E.deedInLieu(g, parcels, w.bbl);
        if (!r.err) { g = r.s; tally.deeded++; }
      }
    }

    // the banks
    for (const l of g.lenders ?? []) {
      const cr = E.capitalRatio(l);
      if (cr < tally.minCapRatio) tally.minCapRatio = cr;
      if (l.delinquent > tally.maxDelinq) tally.maxDelinq = l.delinquent;
      if (l.failedM === m) tally.lenderFails++;
      if (l.appetite < 0.12) tally.shutMonths++;
      else if (l.appetite < 0.6) tally.rationingMonths++;
    }

    // portfolio approaches
    if (g.portfolioSale?.unsolicited && !lastPortfolio) tally.portfolioApproaches++;
    lastPortfolio = !!g.portfolioSale;
    if (g.portfolioSale?.bids?.length) {
      const r = E.acceptPortfolioBid(g, parcels, false);
      if (!r.err) { g = r.s; tally.portfolioClosed++; }
    }
  }
  tally.auctioned += g.exits.filter((e) => e.forced).length;
  tally.nw.push(g.nwHistory[g.nwHistory.length - 1] ?? 0);
}

const med = (a) => { const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
const M = (n) => `$${(n / 1e6).toFixed(1)}M`;
console.log(`${SEEDS} campaigns × ${HORIZON} months, levered bot\n`);
console.log(`  workouts opened        ${tally.workoutsOpened}`);
console.log(`    cured                ${tally.cured}`);
console.log(`    extended             ${tally.extended}`);
console.log(`    deed in lieu         ${tally.deeded}`);
console.log(`  forced exits total     ${tally.auctioned}`);
console.log(`  lender failures        ${tally.lenderFails}`);
console.log(`  lender-months shut     ${tally.shutMonths}`);
console.log(`  lender-months rationing ${tally.rationingMonths}`);
console.log(`  worst capital ratio    ${(tally.minCapRatio * 100).toFixed(1)}%`);
console.log(`  worst delinquency      ${(tally.maxDelinq * 100).toFixed(2)}%`);
console.log(`  portfolio approaches   ${tally.portfolioApproaches}`);
console.log(`  portfolios closed      ${tally.portfolioClosed}`);
console.log(`\n  median net worth       ${M(med(tally.nw))}`);
console.log(`  range                  ${M(Math.min(...tally.nw))} … ${M(Math.max(...tally.nw))}`);
