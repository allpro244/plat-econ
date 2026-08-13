// PLAY A CENTURY AS A DEVELOPER ONLY — buy dirt, build, lease, recycle.
// No income-building acquisitions. Compare to tools/play100-story.mjs.
//
//   node tools/play100-developer.mjs
//   SEEDS=3 node tools/play100-developer.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = await import(join(ROOT, "test/.engine.mjs"));
const { loadCity } = await import(join(ROOT, "test/city.mjs"));
const CITY_SEED = Number(process.env.CITY_SEED ?? 0);
const { parcels, adjacency, bbls } = loadCity(CITY_SEED, E.normalizeParcels);

const START_CASH = 5_000_000;
const MONTHS = Number(process.env.HORIZON ?? 1200);
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };
const M = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
};
const YR = (m) => 2000 + Math.floor(m / 12);

function board(g) {
  const rows = (g.rivals ?? []).filter((r) => r.failedM === undefined).map((r) => {
    const mk = E.markRival(g, parcels, r);
    return { name: r.name, style: r.style, eq: mk.aum - r.debt + r.cash, aum: mk.aum, bldgs: r.bbls.length };
  });
  const nw = E.netWorth(g, parcels);
  rows.push({ name: "You", style: "player", eq: nw, aum: nw, bldgs: Object.keys(g.holdings).length });
  rows.sort((a, b) => b.eq - a.eq);
  return rows;
}

function play(seed) {
  let g = E.firstListings(E.newGame(seed, parcels, START_CASH), parcels, bbls);
  const story = [];
  const push = (m, text) => story.push({ m, y: YR(m), text });
  const st = {
    bought: 0, sold: 0, built: 0, leases: 0, declined: 0, refis: 0,
    land: 0, distress: 0, lowCash: 0, months: 0,
    // Developer diagnostics
    tapeGood: 0, tapeN: 0, landTried: 0, landBought: 0,
    buildTried: 0, buildCleared: 0, buildStarted: 0,
    sellRecycle: 0, incomeSkipped: 0,
  };
  let peakNW = START_CASH, troughFrom = 0;
  let wasRank = 999, everFirst = false, firstDealM = null;
  const decades = [];
  const milestones = [];

  push(0, `Opened a development shop with ${M(START_CASH)}. Mandate: dirt and cranes only — no buying standing income.`);

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    st.months = m + 1;
    const e = g.econ;
    const loose = (k) => (e.cityVac?.[k] ?? NAT[k]) > NAT[k] + 0.02;
    const tight = (k) => (e.cityVac?.[k] ?? NAT[k]) < NAT[k] - 0.015;
    const softPhase = e.phase === "recession" || e.phase === "depression";
    const hot = e.phase === "peak" || e.phase === "expansion";

    // Lease the buildings we just delivered.
    for (const loi of [...(g.lois ?? [])]) {
      const rec = E.resolveRec(parcels, g, loi.bbl);
      const h = g.holdings[loi.bbl];
      if (!rec || !h) continue;
      const market = E.managedRentPsfYr(rec, e, h, loi.use ?? rec.class);
      if (loi.rentPsf >= market * 0.90) {
        const r = E.respondLOI(g, parcels, loi.id, "accept", true);
        if (!r.err) { g = r.s; st.leases++; }
      } else if (!loi.countered && loi.stage !== "countered") {
        const r = E.respondLOI(g, parcels, loi.id, "counter", true, {
          rentPsf: +(market * 0.97).toFixed(2),
          tiPsf: Math.round((loi.tiPsf ?? 0) * 0.8),
        });
        if (!r.err) g = r.s;
      } else if (softPhase || loi.rentPsf >= market * 0.88) {
        const r = E.respondLOI(g, parcels, loi.id, "accept", true);
        if (!r.err) { g = r.s; st.leases++; }
      } else {
        const d = E.respondLOI(g, parcels, loi.id, "decline");
        if (!d.err) { g = d.s; st.declined++; }
      }
    }

    for (const h of Object.values(g.holdings)) {
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class === "land" || g.developments?.[h.bbl]) continue;
      const leased = (h.tenants ?? []).reduce((a, t) => a + t.sf, 0);
      const full = rec.bldgArea > 0 && leased > rec.bldgArea * 0.88;
      if (!full && !h.broker) {
        const r = E.setBroker(g, parcels, h.bbl, true);
        if (!r.err) g = r.s;
      }
      if (full && h.broker) {
        const r = E.setBroker(g, parcels, h.bbl, false);
        if (!r.err) g = r.s;
      }
    }

    // Refi performing completed stock so equity can fund the next job.
    for (const h of Object.values(g.holdings)) {
      const l = h.loan;
      if (!l || g.developments?.[h.bbl]) continue;
      if (l.maturityM - g.month > 18) continue;
      const { quotes } = E.refiQuotes(g, parcels, h.bbl);
      if (!quotes?.length) continue;
      const payoff = l.balance;
      const best = quotes.filter((q) => q.maxProceeds >= payoff * 0.9)
        .sort((a, b) => a.ratePct - b.ratePct)[0]
        ?? quotes.slice().sort((a, b) => b.maxProceeds - a.maxProceeds)[0];
      if (!best) continue;
      const r = E.refinance(g, parcels, h.bbl, best.id, 1);
      if (!r.err) { g = r.s; st.refis++; }
    }

    // Take strong offers / recycle completed product.
    for (const h of Object.values(g.holdings)) {
      if (!h.sale?.offer) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class === "land") continue;
      const v = E.holdingValue(rec, e, h, g.month);
      // Developer: sell into strength more eagerly to recycle into the next site.
      if (h.sale.offer.price >= v * (hot ? 0.98 : 0.94)) {
        const r = E.acceptSaleOffer(g, parcels, h.bbl);
        if (!r.err) {
          g = r.s; st.sold++; st.sellRecycle++;
          push(g.month, `Sold completed ${rec.address} for ${M(h.sale.offer.price)} — recycle into dirt.`);
        }
      } else if (!h.sale.offer.countered) {
        const r = E.counterSale(g, parcels, h.bbl, Math.round(h.sale.offer.price * 1.04));
        if (!r.err) g = r.s;
      }
    }

    // List stabilized deliveries for sale (merchant recycle). Keep at most a
    // small hold book so capital is not trapped in landlord mode.
    if (m % 4 === 0) {
      const income = Object.values(g.holdings).filter((h) => {
        const rec = E.resolveRec(parcels, g, h.bbl);
        return rec && rec.class !== "land" && !g.developments?.[h.bbl] && !h.sale;
      });
      const landBank = Object.values(g.holdings).filter((h) => {
        const rec = E.resolveRec(parcels, g, h.bbl);
        return rec && rec.class === "land";
      }).length;
      // Hold at most 4 completed buildings; list the oldest stabilized ones.
      if (income.length > 4 || (landBank === 0 && income.length > 2)) {
        const ranked = income.map((h) => {
          const rec = E.resolveRec(parcels, g, h.bbl);
          const leased = (h.tenants ?? []).reduce((a, t) => a + t.sf, 0);
          const occ = rec && rec.bldgArea > 0 ? leased / rec.bldgArea : 0;
          return { h, rec, occ, held: g.month - h.boughtM };
        }).filter((x) => x.rec && x.occ >= 0.70 && x.held >= 24)
          .sort((a, b) => b.held - a.held);
        for (const x of ranked.slice(0, 2)) {
          const v = E.holdingValue(x.rec, e, x.h, g.month);
          const r = E.listForSale(g, parcels, x.h.bbl, Math.round(v * 1.02));
          if (!r.err) {
            g = r.s;
            push(g.month, `Listed ${x.rec.address} to recycle development capital.`);
            break;
          }
        }
      }
    }

    // Tape diagnostics each year — how often standing stock beats the coupon.
    if (m % 12 === 11) {
      const coupon = (e.indexRate + 1.5) / 100;
      for (const l of g.listings ?? []) {
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec || rec.class === "land") continue;
        st.tapeN++;
        const noi = E.noiAfterTaxYr(rec, e, E.initialCondition(rec), l.ask);
        const yld = l.ask > 0 ? noi / l.ask : 0;
        if (yld > coupon) st.tapeGood++;
      }
    }

    let committed = 0;
    for (const d of Object.values(g.developments ?? {})) {
      committed += Math.max(0, (d.equityBudget ?? 0) - (d.equitySpent ?? 0));
    }
    const nHold = Object.keys(g.holdings).length;
    const liveJobs = Object.keys(g.developments ?? {}).length;
    const reserve = 1.5e6 + nHold * 2.5e5 + committed;
    const cash = g.cash;

    // BUY LAND ONLY. Count (and skip) income listings that the landlord bot would take.
    if (!Object.keys(g.talks ?? {}).length && cash > reserve) {
      const coupon = (e.indexRate + (softPhase ? 0.9 : 1.5)) / 100;
      let best = null;
      for (const l of g.listings ?? []) {
        if (g.holdings[l.bbl]) continue;
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec) continue;
        if (rec.class !== "land") {
          // Would the buy/lease bot have wanted this?
          const noi = E.noiAfterTaxYr(rec, e, E.initialCondition(rec), l.ask);
          const yld = l.ask > 0 ? noi / l.ask : 0;
          if ((yld > coupon && !loose(rec.class)) || (l.distress && yld > coupon * 0.85)) {
            st.incomeSkipped++;
          }
          continue;
        }
        if (rec.lotArea < 2500 || rec.demandScore < 40) continue;
        st.landTried++;
        // Prefer sites that already pencil a programme, or distressed dirt.
        let bestUse = null, bestPlan = null, bestScore = -Infinity;
        for (const use of ["multifamily", "office", "retail", "industrial"]) {
          if (loose(use) && !tight(use) && !l.distress) continue;
          const fl = Math.min(E.maxFloorsFor(rec, 0.62, use),
            use === "multifamily" ? 14 : use === "industrial" ? 2 : 12);
          const plan = E.planDevelopment(g, parcels, l.bbl, use, fl, 0.62, "gmp");
          if (!plan) continue;
          const score = plan.hurdleRatio + (l.distress ? 0.15 : 0) + rec.demandScore / 500
            + (tight(use) ? 0.2 : 0);
          if (score > bestScore) { bestScore = score; bestUse = use; bestPlan = plan; }
        }
        // Also take land when the market is short even if today's pencil is thin —
        // hold for the cycle — but only if ask is not absurd vs landValue.
        const landV = E.landValue(rec, e);
        const cheap = l.ask <= landV * 1.10 || l.distress;
        if (!bestPlan && !(cheap && (tight("multifamily") || tight("office") || tight("retail")))) continue;
        if (bestPlan && bestPlan.hurdleRatio < 0.92 && !l.distress && !cheap) continue;
        const score = (bestPlan?.hurdleRatio ?? 0.85) + (l.distress ? 0.2 : 0) + rec.demandScore / 400;
        if (!best || score > best.score) best = { l, rec, score, plan: bestPlan, use: bestUse };
      }
      if (best) {
        const bid = Math.round(best.l.ask * (best.l.distress ? 0.90 : 0.96));
        const q = E.buyQuote(g, parcels, best.l.bbl, bid, "land", 0.55);
        if (q.equity < cash - reserve * 0.5) {
          const r = E.negotiate(g, parcels, best.l.bbl, bid);
          if (!r.err) g = r.s;
        }
      }
    }

    for (const t of Object.values(g.talks ?? {})) {
      const rec = E.resolveRec(parcels, g, t.bbl);
      if (rec && rec.class !== "land") {
        // Should never happen under this mandate — walk.
        g = E.walkAway(g, parcels, t.bbl).s;
        continue;
      }
      if (t.agreed) {
        let r = E.closeDeal(g, parcels, t.bbl, "land", 0.55);
        if (r.err) r = E.closeDeal(g, parcels, t.bbl, "cash", 1);
        if (!r.err) {
          g = r.s;
          st.bought++; st.land++; st.landBought++;
          if (firstDealM === null) {
            firstDealM = g.month;
            milestones.push(`First dirt in ${YR(g.month)} — ${rec?.address ?? t.bbl} at ${M(t.agreedPrice ?? 0)}.`);
            push(g.month, `First dirt: ${rec?.address ?? "a lot"} at ${M(t.agreedPrice ?? 0)}.`);
          }
        }
        continue;
      }
      const ok = rec && t.theirPrice < E.landValue(rec, e) * 1.12;
      if (ok) {
        const r = E.acceptCounter(g, parcels, t.bbl);
        if (!r.err) g = r.s;
      } else if (t.final) {
        g = E.walkAway(g, parcels, t.bbl).s;
      } else {
        const mid = Math.round((t.yourPrice + t.theirPrice) / 2);
        const r = E.negotiate(g, parcels, t.bbl, mid);
        if (!r.err) g = r.s;
      }
    }

    // BUILD — every month if cash and crew room allow. Cap concurrent jobs.
    if (liveJobs < 3 && cash > reserve * 1.4) {
      let bestJob = null;
      for (const h of Object.values(g.holdings)) {
        const rec = E.resolveRec(parcels, g, h.bbl) ?? parcels[h.bbl];
        if (!rec || rec.class !== "land" || g.developments?.[h.bbl]) continue;
        const uses = [];
        if (tight("multifamily") || !loose("multifamily")) uses.push("multifamily");
        if (tight("office") || !loose("office")) uses.push("office");
        if (tight("retail")) uses.push("retail");
        if (tight("industrial")) uses.push("industrial");
        if (!uses.length) uses.push("multifamily", "office");
        for (const use of uses) {
          st.buildTried++;
          const fl = Math.min(E.maxFloorsFor(rec, 0.62, use), use === "multifamily" ? 14 : 12);
          const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.62, "gmp");
          if (!plan) continue;
          if (plan.hurdleRatio >= 1.0) st.buildCleared++;
          if (plan.hurdleRatio < 1.0) continue; // still require a clearing pencil
          if (plan.equityAtClose > cash - reserve) continue;
          const score = plan.hurdleRatio + (tight(use) ? 0.25 : 0);
          if (!bestJob || score > bestJob.score) bestJob = { h, rec, use, fl, plan, score };
        }
      }
      if (bestJob) {
        const r = E.startDevelopment(g, parcels, bestJob.h.bbl, bestJob.use, bestJob.fl, 0.62, "gmp");
        if (!r.err) {
          g = r.s; st.built++; st.buildStarted++;
          push(g.month, `Broke ground on ${bestJob.use} at ${bestJob.rec.address} — `
            + `${bestJob.plan.sf.toLocaleString()} sf, YoC ${bestJob.plan.yieldOnCost.toFixed(2)}%, `
            + `hurdle ${bestJob.plan.hurdleRatio.toFixed(2)}.`);
        }
      }
    }

    const nw = E.netWorth(g, parcels);
    peakNW = Math.max(peakNW, nw);
    troughFrom = Math.max(troughFrom, peakNW > 0 ? 1 - nw / peakNW : 0);
    if (g.cash < 500_000) st.lowCash++;

    if (m % 12 === 11) {
      const rows = board(g);
      const rank = rows.findIndex((r) => r.name === "You") + 1;
      if (rank === 1 && !everFirst) {
        everFirst = true;
        milestones.push(`Hit #1 on the street in ${YR(g.month)} at ${M(nw)}.`);
        push(g.month, `Took the top of the league table at ${M(nw)}.`);
      } else if (wasRank <= 3 && rank > 5) {
        push(g.month, `Slipped to #${rank} — ${rows[0].name} leads at ${M(rows[0].eq)}.`);
      }
      wasRank = rank;
    }

    if (m % 120 === 119 || m === MONTHS - 1 || g.gameOver) {
      const rows = board(g);
      const rank = rows.findIndex((r) => r.name === "You") + 1;
      const top = rows[0];
      const you = rows.find((r) => r.name === "You");
      decades.push({
        y: YR(g.month), nw, cash: g.cash,
        bldgs: Object.keys(g.holdings).length,
        phase: e.phase, vac: e.cityVac?.office, rent: e.rentIdx?.office, cpi: e.cpi,
        rank, field: rows.length, leader: top.name, leaderEq: top.eq,
        gap: (top.name === "You" ? 0 : top.eq - (you?.eq ?? 0)),
        bought: st.bought, sold: st.sold, built: st.built, leases: st.leases,
      });
    }

    if (g.gameOver) {
      push(g.month, `FIRM ENDED — ${g.gameOver.cause}`);
      milestones.push(`Ended in ${YR(g.month)}: ${g.gameOver.cause}`);
      break;
    }
  }

  const rows = board(g);
  const rank = rows.findIndex((r) => r.name === "You") + 1;
  const nw = E.netWorth(g, parcels);
  return {
    seed, g, st, story, decades, milestones,
    nw, peakNW, drawdown: troughFrom, rank, field: rows.length,
    board: rows.slice(0, 8),
    everFirst, firstDealM,
    dead: (g.rivals ?? []).filter((r) => r.failedM !== undefined).length,
    years: st.months / 12,
  };
}

const seedList = process.env.SEED
  ? [Number(process.env.SEED)]
  : (process.env.SEEDS
    ? Array.from({ length: Number(process.env.SEEDS) }, (_, i) => 550991 + i * 104729)
    : [655720, 760449, 550991]); // same seeds as the buy/lease story

const runs = [];
for (const seed of seedList) {
  console.log(`\nDeveloper century · seed ${seed} · start ${M(START_CASH)} · ${MONTHS / 12}y…`);
  const t0 = performance.now();
  const r = play(seed);
  console.log(`  finished in ${((performance.now() - t0) / 1000).toFixed(1)}s — NW ${M(r.nw)} · rank #${r.rank}/${r.field}`
    + `${r.g.gameOver ? " · DEAD" : ""} · built ${r.st.built} · land ${r.st.land} · sold ${r.st.sold}`);
  console.log(`  tape good deals skipped: ${r.st.incomeSkipped} · tape yield>coupon ${(r.st.tapeN ? 100 * r.st.tapeGood / r.st.tapeN : 0).toFixed(0)}%`
    + ` · build clear rate ${(r.st.buildTried ? 100 * r.st.buildCleared / r.st.buildTried : 0).toFixed(0)}%`);
  runs.push(r);
}

runs.sort((a, b) => {
  const aDead = a.g.gameOver ? 1 : 0;
  const bDead = b.g.gameOver ? 1 : 0;
  if (aDead !== bDead) return aDead - bDead;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return b.nw - a.nw;
});
const best = runs[0];

const lines = [];
const L = (s = "") => lines.push(s);

L(`# Century Play — Developer Only`);
L(``);
L(`Started with **${M(START_CASH)}**. City seed ${CITY_SEED}. Market seed **${best.seed}**.`);
L(`Mandate: **buy dirt, build, lease, recycle** — never buy standing income.`);
L(`Played **${best.years.toFixed(0)} years**${best.g.gameOver ? " (firm ended early)" : " to 2100"}.`);
L(``);
L(`## Final standing`);
L(``);
L(`| | |`);
L(`|--|--|`);
L(`| Net worth | **${M(best.nw)}** |`);
L(`| Peak NW | ${M(best.peakNW)} |`);
L(`| Worst drawdown | ${(best.drawdown * 100).toFixed(0)}% |`);
L(`| Rank | **#${best.rank} of ${best.field}** |`);
L(`| Ever #1? | ${best.everFirst ? "Yes" : "No"} |`);
L(`| Land bought / built / sold | ${best.st.land} / ${best.st.built} / ${best.st.sold} |`);
L(`| Leases signed | ${best.st.leases} |`);
L(`| Refis | ${best.st.refis} |`);
L(`| Income listings skipped (would have cleared buy/lease screen) | ${best.st.incomeSkipped} |`);
L(`| Tape share with yield > coupon | ${best.st.tapeN ? ((100 * best.st.tapeGood / best.st.tapeN).toFixed(0) + "%") : "—"} (${best.st.tapeGood}/${best.st.tapeN}) |`);
L(`| Build pencils cleared / tried | ${best.st.buildCleared} / ${best.st.buildTried} |`);
L(`| Rival failures seen | ${best.dead} |`);
L(``);
L(`### League table at the end`);
L(``);
L(`| Rank | Name | Style | Equity | Buildings |`);
L(`|-----:|------|-------|-------:|----------:|`);
best.board.forEach((r, i) => {
  L(`| ${i + 1} | ${r.name}${r.name === "You" ? " **" : ""} | ${r.style} | ${M(r.eq)} | ${r.bldgs} |`);
});
L(``);
L(`## Decade by decade`);
L(``);
L(`| Year | NW | Cash | Bldgs | Phase | Off vac | Rank | Leader | Gap to #1 | Built cum |`);
L(`|-----:|---:|-----:|------:|-------|--------:|-----:|--------|----------:|----------:|`);
for (const d of best.decades) {
  L(`| ${d.y} | ${M(d.nw)} | ${M(d.cash)} | ${d.bldgs} | ${d.phase} | ${((d.vac ?? 0) * 100).toFixed(1)}% | #${d.rank}/${d.field} | ${d.leader} | ${d.gap ? M(d.gap) : "—"} | ${d.built} |`);
}
L(``);
L(`## Compared to the buy/lease century (PLAY100_STORY.md)`);
L(``);
L(`| | Buy / lease (seed 655720) | Developer only (this run) |`);
L(`|--|--:|--:|`);
L(`| Net worth | $80.28B | ${M(best.nw)} |`);
L(`| Rank | #1 of 10 | #${best.rank} of ${best.field} |`);
L(`| Bought / built / sold | 332 / 9 / 105 | ${best.st.bought} / ${best.st.built} / ${best.st.sold} |`);
L(`| Worst drawdown | 25% | ${(best.drawdown * 100).toFixed(0)}% |`);
L(``);
L(`## Why development lost (or won)`);
L(``);
L(`- Standing stock on the tape cleared the buy screen often: **${best.st.incomeSkipped}** income listings this mandate refused that a landlord bot would have bid.`);
L(`- Annual tape scans: **${best.st.tapeN ? ((100 * best.st.tapeGood / best.st.tapeN).toFixed(0)) : "—"}%** of building listings showed going-in yield above coupon.`);
L(`- Of ${best.st.buildTried} site/use underwrites on owned dirt, **${best.st.buildCleared}** cleared hurdle (≥1.0) and **${best.st.buildStarted}** actually broke ground.`);
L(``);
L(`## Milestones`);
L(``);
if (best.milestones.length) for (const m of best.milestones) L(`- ${m}`);
else L(`- No major milestones recorded.`);
L(``);
L(`## Story beats`);
L(``);
for (const s of best.story.slice(0, 80)) L(`- **${s.y}:** ${s.text}`);
if (best.story.length > 80) L(`- … (${best.story.length - 80} more beats omitted)`);
L(``);

{
  const holds = Object.values(best.g.holdings);
  let noi = 0, debt = 0, value = 0;
  const byClass = {};
  for (const h of holds) {
    const rec = E.resolveRec(parcels, best.g, h.bbl);
    if (!rec) continue;
    const v = E.holdingValue(rec, best.g.econ, h, best.g.month);
    value += v;
    debt += h.loan?.balance ?? 0;
    noi += E.holdingNOIYr(rec, best.g.econ, h, best.g.month);
    byClass[rec.class] = (byClass[rec.class] ?? 0) + 1;
  }
  L(`## Closing book`);
  L(``);
  L(`- Holdings: **${holds.length}** deeds (${Object.entries(byClass).map(([k, n]) => `${n} ${k}`).join(", ") || "none"})`);
  L(`- Portfolio value ~ ${M(value)} · debt ${M(debt)} · LTV ${value > 0 ? ((debt / value) * 100).toFixed(0) : "—"}%`);
  L(`- In-place NOI ~ ${M(noi)}/yr`);
  L(`- Cash ${M(best.g.cash)} · CPI ${best.g.econ.cpi?.toFixed(2)}x · office rent $${best.g.econ.rentIdx.office.toFixed(0)}/sf`);
  L(``);
}

if (runs.length > 1) {
  L(`## Other seeds tried`);
  L(``);
  for (const r of runs) {
    L(`- seed ${r.seed}: NW ${M(r.nw)}, rank #${r.rank}/${r.field}, built ${r.st.built}, land ${r.st.land}, sold ${r.st.sold}`
      + `${r.g.gameOver ? " (dead)" : ""}`);
  }
  L(``);
}

const out = join(ROOT, "PLAY100_DEVELOPER.md");
writeFileSync(out, lines.join("\n"));
console.log(`\nWrote ${out}`);
