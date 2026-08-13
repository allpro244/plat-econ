// FIFTY YEARS, PLAYED PROPERLY.
//
// Not an archetype bot dialled to an extreme — a principal trying to compound
// equity: buy income below replacement when the market is loose, lever it
// where the spread is real, develop into shortages, sell into strength, and
// keep enough cash that a downturn is an opportunity rather than an ending.
//
//   pnpm play50            one run, 50 years
//   SEEDS=8 pnpm play50    a distribution
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);
const CITY = process.env.BW_CITY ?? "somewhere";

const SEEDS = Number(process.env.SEEDS ?? 1);
const MONTHS = Number(process.env.HORIZON ?? 600);
const M = (n) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };

function play(seed, verbose) {
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  // Capture the opening cheque once. A hard-coded $2.5M reserve equalled
  // DEFAULT_START_CASH, so `cash > reserve` was false from month one on the
  // standard bankroll — twelve century runs, twelve insolvencies, zero deeds.
  const openCash = g.cash;
  const log = [];
  const stat = { bought: 0, sold: 0, built: 0, leases: 0, refis: 0, lowCash: 0, gain: 0 };
  let peakNW = 0, troughFrom = 0;

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;
    const loose = (k) => (e.cityVac?.[k] ?? NAT[k]) > NAT[k] + 0.02;
    const tight = (k) => (e.cityVac?.[k] ?? NAT[k]) < NAT[k] - 0.01;
    const cash = g.cash;

    // ---- answer the tenants ------------------------------------------------
    for (const loi of [...g.lois]) {
      const rec = E.resolveRec(parcels, g, loi.bbl);
      if (!rec) continue;
      const h = g.holdings[loi.bbl];
      if (!h) continue;
      const market = E.managedRentPsfYr(rec, e, h, loi.use);
      // take anything at or near market; counter the cheeky ones once
      if (loi.rentPsf >= market * 0.94) {
        const r = E.respondLOI(g, parcels, loi.id, "accept");
        if (!r.err) { g = r.s; stat.leases++; }
      } else if (!loi.countered && loi.stage !== "countered") {
        const r = E.respondLOI(g, parcels, loi.id, "counter", false, { rentPsf: +(market * 0.99).toFixed(2), tiPsf: Math.round(loi.tiPsf * 0.7) });
        if (!r.err) g = r.s;
      } else {
        const r = E.respondLOI(g, parcels, loi.id, "pass");
        if (!r.err) g = r.s;
      }
    }

    // ---- take good offers on what you own ----------------------------------
    for (const h of Object.values(g.holdings)) {
      if (!h.sale?.offer) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec) continue;
      const v = E.holdingValue(rec, e, h, g.month);
      if (h.sale.offer.price >= v * 1.06) {
        const r = E.acceptSaleOffer(g, parcels, h.bbl);
        if (!r.err) { g = r.s; stat.sold++; }
      } else if (!h.sale.offer.countered) {
        const r = E.counterSale(g, parcels, h.bbl, Math.round(h.sale.offer.price * 1.07));
        if (!r.err) g = r.s;
      }
    }

    // ---- sell into strength -------------------------------------------------
    // trim the weakest asset when the market is hot and the gain is real
    if (m % 6 === 0 && (e.phase === "peak" || e.phase === "expansion")) {
      for (const h of Object.values(g.holdings)) {
        if (h.sale || g.developments[h.bbl]) continue;
        const rec = E.resolveRec(parcels, g, h.bbl);
        if (!rec || rec.class === "land") continue;
        const v = E.holdingValue(rec, e, h, g.month);
        if (v > h.costBasis * 1.75 && g.month - h.boughtM > 60) {
          const r = E.listForSale(g, parcels, h.bbl, Math.round(v * 1.04));
          if (!r.err) { g = r.s; break; }
        }
      }
    }

    // ---- negotiate for something worth owning -------------------------------
    // one deal at a time; keep ~a third of the opening cheque as dry powder
    const reserve = openCash * 0.35 + Object.keys(g.holdings).length * 4e5;
    if (!Object.keys(g.talks ?? {}).length && cash > reserve) {
      let best = null;
      for (const l of g.listings) {
        if (g.holdings[l.bbl]) continue;
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec) continue;
        const isLand = rec.class === "land";
        const noi = isLand ? 0 : E.noiAfterTaxYr(rec, e, E.initialCondition(rec), l.ask);
        const yieldOn = l.ask > 0 ? noi / l.ask : 0;
        // Spread over the coupon, not a 140bp wall that rejects the whole tape
        // at open (index ~8% → hurdle 9.4%, while listed yields sat at 7–9%).
        const want = isLand
          ? rec.demandScore > 62 && cash > reserve * 3
          : yieldOn > (e.indexRate + 0.4) / 100 && !loose(rec.class);
        if (!want) continue;
        const score = (isLand ? rec.demandScore / 900 : yieldOn) + (l.distress ? 0.01 : 0);
        if (!best || score > best.score) best = { l, score, isLand, rec };
      }
      if (best) {
        const q = E.buyQuote(g, parcels, best.l.bbl, Math.round(best.l.ask * 0.92), best.isLand ? "land" : "savings", 0.72);
        if (q.equity < cash - reserve * 0.5) {
          const r = E.negotiate(g, parcels, best.l.bbl, Math.round(best.l.ask * 0.92));
          if (!r.err) g = r.s;
        }
      }
    }
    // Every deal on the table gets worked, not just the one. A price agreed is
    // not a building bought — go and place the debt.
    for (const t of Object.values(g.talks ?? {})) {
      const rec = E.resolveRec(parcels, g, t.bbl);
      if (t.agreed) {
        const prod = rec && rec.class === "land" ? "land" : "savings";
        let r = E.closeDeal(g, parcels, t.bbl, prod, 0.72);
        if (r.err) r = E.closeDeal(g, parcels, t.bbl, "cash", 1);
        if (!r.err) { g = r.s; stat.bought++; }
        continue;
      }
      // take their counter if it is still a good deal
      const noi = rec && rec.class !== "land" ? E.noiAfterTaxYr(rec, e, E.initialCondition(rec), t.theirPrice) : 0;
      const ok = rec && (rec.class === "land" ? t.theirPrice < E.landValue(rec, e) * 1.06 : noi / t.theirPrice > (e.indexRate + 1.1) / 100);
      if (ok) { const r = E.acceptCounter(g, parcels, t.bbl); if (!r.err) g = r.s; }
      else if (t.final) { g = E.walkAway(g, parcels, t.bbl).s; }
      else {
        const r = E.negotiate(g, parcels, t.bbl, Math.round((t.yourPrice + t.theirPrice) / 2));
        if (!r.err) g = r.s;
      }
    }

    // ---- build into shortages ----------------------------------------------
    if (m % 3 === 0 && cash > reserve * 2.5) {
      for (const h of Object.values(g.holdings)) {
        const rec = parcels[h.bbl];
        if (!rec || rec.class !== "land" || g.developments[h.bbl]) continue;
        const use = tight("multifamily") ? "multifamily" : tight("office") ? "office" : tight("retail") ? "retail" : null;
        if (!use) continue;
        const fl = Math.min(E.maxFloorsFor(rec, 0.6), 10);
        const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
        if (!plan || plan.yieldOnCost < plan.exitCap + 0.9) continue;
        if (plan.equityAtClose > cash - reserve) continue;
        const r = E.startDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
        if (!r.err) { g = r.s; stat.built++; break; }
      }
    }

    const nw = E.netWorth(g, parcels);
    peakNW = Math.max(peakNW, nw);
    troughFrom = Math.max(troughFrom, peakNW > 0 ? 1 - nw / peakNW : 0);
    if (g.cash < 0) stat.lowCash++;
    if (verbose && m % 60 === 59) {
      log.push(`  yr ${String(Math.floor(m / 12) + 1).padStart(2)}  NW ${M(nw).padStart(8)}  cash ${M(g.cash).padStart(8)}` +
        `  ${String(Object.keys(g.holdings).length).padStart(2)} bldgs  ${e.phase.padEnd(9)} idx ${e.indexRate.toFixed(1)}%`);
    }
    if (g.gameOver) break;
  }
  // where the player finished against the firms who started alongside them
  const board = (g.rivals ?? []).filter((r) => r.failedM === undefined).map((r) => {
    const m = E.markRival(g, parcels, r);
    return { name: r.name, eq: m.aum - r.debt + r.cash };
  });
  const nwFinal = E.netWorth(g, parcels);
  board.push({ name: "You", eq: nwFinal });
  board.sort((a, b) => b.eq - a.eq);
  const rank = board.findIndex((b) => b.name === "You") + 1;
  const dead = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
  return { g, stat, nw: nwFinal, peakNW, drawdown: troughFrom, log,
    rank, field: board.length, top: board[0], dead };
}

const results = [];
for (let i = 1; i <= SEEDS; i++) {
  const r = play(i * 7919, SEEDS === 1 || i === 1);
  results.push(r);
  if (r.log.length) {
    console.log(`\n=== ${CITY} · seed ${i} · ${MONTHS / 12} years ===`);
    console.log(r.log.join("\n"));
  }
  console.log(`\nseed ${i}: net worth ${M(r.nw)}  (peak ${M(r.peakNW)}, worst drawdown ${(r.drawdown * 100).toFixed(0)}%)` +
    `  ${r.stat.bought} bought · ${r.stat.built} built · ${r.stat.sold} sold · ${r.stat.leases} leases` +
    (r.g.gameOver ? `  — RUN ENDED: ${r.g.gameOver.cause.slice(0, 60)}` : "") +
    `\n         street: ${r.rank} of ${r.field} by net worth · biggest ${r.top.name} ${M(r.top.eq)} · ${r.dead} firms failed`);
}
if (SEEDS > 1) {
  const nws = results.map((r) => r.nw).sort((a, b) => a - b);
  const med = nws[Math.floor(nws.length / 2)];
  console.log(`\nacross ${SEEDS} runs: worst ${M(nws[0])}  median ${M(med)}  best ${M(nws[nws.length - 1])}` +
    `  ·  ${results.filter((r) => r.g.gameOver).length} failed`);
}
console.log("");
