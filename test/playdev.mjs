// CAN YOU WIN AS A PURE DEVELOPER?
//
// No existing buildings. Ever. Buy dirt, put a building on it, lease it up,
// and either hold it for the income or sell it into strength — which is the
// whole of what a merchant builder does, and a strategy the game should
// support if development is a real pillar rather than a decoration.
//
// The comparison is `pnpm play50`, which buys income as well. If the developer
// cannot get within reach of that, development is not paying for the risk it
// carries: two to four years of capital tied up, a market that can turn under
// you while the steel goes in, and a mini-perm clock at the end of it.
//
//   pnpm playdev              one run, 50 years
//   SEEDS=8 pnpm playdev      a distribution
//   HOLD=1 pnpm playdev       hold everything instead of trading out
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);
const CITY = process.env.BW_CITY ?? "somewhere";

const SEEDS = Number(process.env.SEEDS ?? 1);
const MONTHS = Number(process.env.HORIZON ?? 600);
const HOLD = process.env.HOLD === "1";
const M = (n) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };
const USES = ["multifamily", "office", "retail", "industrial"];

const GRANT = Number(process.env.GRANT ?? 0);

function play(seed, verbose) {
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  // GRANT separates two different questions. At $6M the question is whether a
  // developer can bootstrap; with capital handed to them it is whether ground
  // -up development is profitable AT ALL once it is not capital-constrained.
  if (GRANT > 0) g = { ...g, cash: g.cash + GRANT };
  const log = [];
  const st = { land: 0, built: 0, sold: 0, leases: 0, refis: 0, stalled: 0, noSite: 0, noPencil: 0, loisSeen: 0, countered: 0, passed: 0, emptyMo: 0, vacSf: 0 };
  let peakNW = 0, drawdown = 0;
  const trace = [];

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;

    // ---- lease what you have built ----------------------------------------
    st.loisSeen += g.lois.length;
    for (const loi of [...g.lois]) {
      const h = g.holdings[loi.bbl];
      const rec = E.resolveRec(parcels, g, loi.bbl);
      if (!h || !rec) continue;
      const market = E.managedRentPsfYr(rec, e, h, loi.use);
      // a developer with a mini-perm clock takes the deal
      if (loi.rentPsf >= market * 0.88) {
        const r = E.respondLOI(g, parcels, loi.id, "accept", true);
        if (!r.err) { g = r.s; st.leases++; continue; }
      }
      // ONE counter, then decide. Re-countering the same LOI every month is
      // not negotiating, it is holding the tenant hostage until the paper
      // expires — 140 counters and one signature.
      if (!loi.countered && loi.stage !== "countered") {
        const r = E.respondLOI(g, parcels, loi.id, "counter", true, { rentPsf: +(market * 0.96).toFixed(2), tiPsf: Math.round(loi.tiPsf * 0.8) });
        if (!r.err) { st.countered++; g = r.s; continue; }
      }
      // A developer with a mini-perm clock does not walk away from a tenant
      // over the fit-out cheque. fund=true draws the shortfall on the line of
      // credit, which is exactly what the line is for — the alternative was
      // passing on a hundred-odd tenants because the TI was short.
      const acc = E.respondLOI(g, parcels, loi.id, "accept", true);
      if (!acc.err) { g = acc.s; st.leases++; continue; }
      st.passed++;
      const p2 = E.respondLOI(g, parcels, loi.id, "pass");
      if (!p2.err) g = p2.s;
    }

    // ---- MARKET THE EMPTY SPACE -------------------------------------------
    // An exclusive leasing agent is worth 1.75x the prospect flow and an
    // aggressive stance is worth more again. A developer holding an empty
    // building and not doing either is not being disciplined, they are being
    // asleep.
    for (const h of Object.values(g.holdings)) {
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class === "land" || g.developments[h.bbl]) continue;
      const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
      const full = rec.bldgArea > 0 && leased > rec.bldgArea * 0.9;
      if (!full && !h.broker) { const r = E.setBroker(g, parcels, h.bbl, true); if (!r.err) g = r.s; }
      if (full && h.broker) { const r = E.setBroker(g, parcels, h.bbl, false); if (!r.err) g = r.s; }
      if (!full && h.stance !== 1) g = E.setStance(g, h.bbl, 1);
    }

    // ---- take the bid on anything you are selling --------------------------
    for (const h of Object.values(g.holdings)) {
      if (!h.sale?.offer) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec) continue;
      const v = E.holdingValue(rec, e, h, g.month);
      if (h.sale.offer.price >= v * 0.98) {
        const r = E.acceptSaleOffer(g, parcels, h.bbl);
        if (!r.err) { g = r.s; st.sold++; }
      } else if (!h.sale.offer.countered) {
        const r = E.counterSale(g, parcels, h.bbl, Math.round(h.sale.offer.price * 1.06));
        if (!r.err) g = r.s;
      }
    }

    // ---- TAKE OUT THE MINI-PERM -------------------------------------------
    // Delivery hands you a mini-perm that is interest-only for a year and
    // MATURES IN THREE. Stabilise the building and refinance it into permanent
    // paper, or the balloon arrives and the lender takes the building. Not
    // doing this is the single most expensive omission available to a
    // developer, and the bot was making it on every job it ever finished.
    for (const h of Object.values(g.holdings)) {
      const l = h.loan;
      if (!l || g.developments[h.bbl]) continue;
      const due = l.maturityM - g.month;
      if (due > 15) continue;                       // not yet
      const { quotes } = E.refiQuotes(g, parcels, h.bbl);
      if (!quotes?.length) continue;
      // the longest, cheapest paper that will cover the payoff
      // maxProceeds is what the lender will actually advance; a quote that
      // cannot cover the payoff is not a takeout, it is a capital call
      const payoff = l.balance;
      const best = quotes.filter((qq) => qq.maxProceeds >= payoff * 0.92)
        .sort((a, b) => a.ratePct - b.ratePct)[0]
        ?? quotes.slice().sort((a, b) => b.maxProceeds - a.maxProceeds)[0];
      if (!best || best.maxProceeds <= 0) continue;
      const r = E.refinance(g, parcels, h.bbl, best.id, 1);
      if (!r.err) { g = r.s; st.refis = (st.refis ?? 0) + 1; }
    }

    // ---- MERCHANT BUILD: sell the finished product -------------------------
    // A merchant developer's return is realised at the exit, not collected
    // over thirty years. Stabilised and past its lease-up, it goes.
    if (!HOLD && m % 3 === 0) {
      for (const h of Object.values(g.holdings)) {
        if (h.sale || g.developments[h.bbl]) continue;
        const rec = E.resolveRec(parcels, g, h.bbl);
        if (!rec || rec.class === "land" || h.deliveredM === undefined) continue;
        const seasoned = g.month - h.deliveredM > 30;
        // leased square feet over building area — the same thing the panel shows
        const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
        const occ = rec.bldgArea > 0 ? leased / rec.bldgArea : (h.occ ?? 0);
        if (seasoned && occ > 0.82) {
          const v = E.holdingValue(rec, e, h, g.month);
          const r = E.listForSale(g, parcels, h.bbl, Math.round(v * 1.03));
          if (!r.err) { g = r.s; break; }
        }
      }
    }

    // ---- BUY DIRT, AND ONLY DIRT -------------------------------------------
    // WHAT IS ALREADY COMMITTED. Every live job still has equity to draw on
    // its S-curve, and that money is spoken for. A developer who counts it as
    // dry powder is a developer who gets a capital call on three jobs in the
    // same quarter — which is how the last version of this bot died twice in
    // three runs.
    let committed = 0;
    for (const d of Object.values(g.developments)) {
      committed += Math.max(0, d.equityBudget - d.equitySpent);
    }
    const reserve = 2.5e6 + committed;
    if (!Object.keys(g.talks ?? {}).length && g.cash > reserve) {
      let best = null;
      for (const l of g.listings) {
        if (g.holdings[l.bbl]) continue;
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec || rec.class !== "land") continue;      // <-- the whole rule
        if (rec.lotArea < 2500) continue;
        // is there a use that pencils on this site today?
        let bestPlan = null;
        for (const use of USES) {
          const fl = Math.min(E.maxFloorsFor(rec, 0.6), 14);
          const plan = E.planDevelopment(g, parcels, l.bbl, use, fl, 0.6, "gmp");
          if (!plan) continue;
          const spread = plan.yieldOnCost - plan.exitCap;
          if (!bestPlan || spread > bestPlan.spread) bestPlan = { plan, spread, use };
        }
        if (!bestPlan || bestPlan.spread < 0.8) continue;
        const score = bestPlan.spread + rec.demandScore / 400;
        if (!best || score > best.score) best = { l, score, rec, ...bestPlan };
      }
      if (best) {
        const px = Math.round(best.l.ask * 0.9);
        const q = E.buyQuote(g, parcels, best.l.bbl, px, "land", 0.5);
        // and leave enough behind to actually build on it
        if (q.equity < Math.max(0, g.cash - reserve) * 0.45) {
          const r = E.negotiate(g, parcels, best.l.bbl, px);
          if (!r.err) g = r.s;
        }
      } else st.noSite++;
    }
    for (const t of Object.values(g.talks ?? {})) {
      if (t.agreed) {
        let r = E.closeDeal(g, parcels, t.bbl, "land", 0.5);
        if (r.err) r = E.closeDeal(g, parcels, t.bbl, "cash", 1);
        if (!r.err) { g = r.s; trace.push(`  m${g.month} BOUGHT SITE ${M(t.agreedPrice)} · cash ${M(g.cash)}`); st.land++; }
        continue;
      }
      const rec = E.resolveRec(parcels, g, t.bbl);
      const ok = rec && rec.class === "land" && t.theirPrice < E.landValue(rec, e) * 1.12;
      if (ok) { const r = E.acceptCounter(g, parcels, t.bbl); if (!r.err) g = r.s; }
      else if (t.final) { g = E.walkAway(g, parcels, t.bbl).s; }
      else {
        const r = E.negotiate(g, parcels, t.bbl, Math.round((t.yourPrice + t.theirPrice) / 2));
        if (!r.err) g = r.s;
      }
    }

    // ---- BREAK GROUND ------------------------------------------------------
    if (g.cash > reserve) {
      for (const h of Object.values(g.holdings)) {
        const rec = parcels[h.bbl];
        if (!rec || rec.class !== "land" || g.developments[h.bbl]) continue;
        let pick = null;
        // the whole equity of the new job, on top of everything already committed
        const budget = g.cash - reserve;
        for (const use of USES) {
          // Scale the job to the cheque. A developer with six million does not
          // start a twenty-million job and hope; they build what they can fund
          // and do it again next year.
          const maxFl = Math.min(E.maxFloorsFor(rec, 0.6), 14);
          for (let fl = maxFl; fl >= 1; fl--) {
            const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
            if (!plan) continue;
            // THE WHOLE EQUITY, not the first cheque. equityAtClose is 55% of
            // it; the rest is drawn on the S-curve over the next two years and
            // it has to be there. Reserving only the close is how a developer
            // gets seized in month fourteen with the frame up.
            if (plan.equity > budget) continue;   // cannot fund it — try smaller
            const gap = NAT[use] - (e.cityVac?.[use] ?? NAT[use]);
            const spread = plan.yieldOnCost - plan.exitCap;
            // Score by hurdle that clears, not by tallest plate — biggest
            // affordable mid-rises were starving the cheque while a shorter
            // job would have broken ground.
            const scoreP = plan.hurdleRatio + gap * 2 + spread * 0.05;
            if (plan.hurdleRatio >= 1 && spread >= 0.7 && (!pick || scoreP > pick.scoreP)) {
              pick = { plan, use, fl, scoreP };
            }
          }
        }
        if (!pick) { st.noPencil++; continue; }
        const r = E.startDevelopment(g, parcels, h.bbl, pick.use, pick.fl, 0.6, "gmp");
        if (!r.err) {
          g = r.s; st.built++;
          trace.push(`  m${g.month} BREAK GROUND ${pick.use} ${pick.fl}fl · cost ${M(pick.plan.costTotal)} · equity ${M(pick.plan.equity)} · at close ${M(pick.plan.equityAtClose)} · YoC ${pick.plan.yieldOnCost.toFixed(2)} vs exit ${pick.plan.exitCap.toFixed(2)} · cash after ${M(g.cash)}`);
          break;
        } else trace.push(`  m${g.month} start refused: ${r.err}`);
      }
    }

    for (const h of Object.values(g.holdings)) {
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class === "land" || h.deliveredM === undefined) continue;
      const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
      if (leased < rec.bldgArea * 0.2) st.emptyMo++;
      st.vacSf += Math.max(0, rec.bldgArea - leased);
    }
    const nw = E.netWorth(g, parcels);
    peakNW = Math.max(peakNW, nw);
    drawdown = Math.max(drawdown, peakNW > 0 ? 1 - nw / peakNW : 0);
    if (verbose && m % 12 === 11) {
      log.push(`  yr ${String(Math.floor(m / 12) + 1).padStart(2)}  NW ${M(nw).padStart(8)}  cash ${M(g.cash).padStart(8)}` +
        `  ${String(Object.keys(g.holdings).length).padStart(2)} held  ${String(Object.keys(g.developments).length)} building  ${e.phase}`);
    }
    if (g.gameOver) break;
  }

  const board = (g.rivals ?? []).filter((r) => r.failedM === undefined).map((r) => {
    const mk = E.markRival(g, parcels, r);
    return { name: r.name, eq: mk.aum - r.debt + r.cash };
  });
  const nwFinal = E.netWorth(g, parcels);
  board.push({ name: "You", eq: nwFinal });
  board.sort((a, b) => b.eq - a.eq);
  return {
    g, st, nw: nwFinal, peakNW, drawdown, log, trace,
    rank: board.findIndex((b) => b.name === "You") + 1, field: board.length, top: board[0],
  };
}

const out = [];
for (let i = 1; i <= SEEDS; i++) {
  const r = play(i * 7919, SEEDS === 1 || i === 1);
  out.push(r);
  if (r.trace?.length) console.log("\n" + r.trace.slice(0, 14).join("\n"));
  if (r.log.length) {
    console.log(`\n=== ${CITY} · DEVELOPER ONLY${HOLD ? " (hold)" : " (merchant)"} · seed ${i} · ${MONTHS / 12} years ===`);
    console.log(r.log.join("\n"));
  }
  console.log(`\nseed ${i}: net worth ${M(r.nw)}  (peak ${M(r.peakNW)}, drawdown ${(r.drawdown * 100).toFixed(0)}%)` +
    `  ${r.st.land} sites · ${r.st.built} built · ${r.st.sold} sold · ${r.st.leases} leases · ${r.st.refis} refis` +
    (r.g.gameOver ? `  — RUN ENDED: ${r.g.gameOver.cause}` : "") +
    `\n         street: ${r.rank} of ${r.field} · biggest ${r.top.name} ${M(r.top.eq)}` +
    `\n         leasing: ${r.st.loisSeen} LOI-months seen · ${r.st.leases} signed · ${r.st.countered} countered · ${r.st.passed} passed · ${r.st.emptyMo} building-months under 20% let`);
}
if (SEEDS > 1) {
  const nws = out.map((r) => r.nw).sort((a, b) => a - b);
  console.log(`\nDEVELOPER ONLY across ${SEEDS} runs: worst ${M(nws[0])}  median ${M(nws[Math.floor(nws.length / 2)])}  best ${M(nws[nws.length - 1])}` +
    `  ·  ${out.filter((r) => r.g.gameOver).length} failed  ·  median rank ${out.map((r) => r.rank).sort((a, b) => a - b)[Math.floor(out.length / 2)]}`);
}
console.log("");
