// PLAY A CENTURY — $5M start, try to finish richest on the street.
//
//   node tools/play100-story.mjs
//   SEED=12007 CITY_SEED=0 node tools/play100-story.mjs
//   SEEDS=3 node tools/play100-story.mjs   # pick the best finish
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
  };
  let peakNW = START_CASH, troughFrom = 0;
  let wasRank = 999, everFirst = false, firstDealM = null;
  const decades = [];
  const milestones = [];

  push(0, `Opened the firm with ${M(START_CASH)} cash. The street already has named money.`);

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    st.months = m + 1;
    const e = g.econ;
    const loose = (k) => (e.cityVac?.[k] ?? NAT[k]) > NAT[k] + 0.02;
    const tight = (k) => (e.cityVac?.[k] ?? NAT[k]) < NAT[k] - 0.015;
    const softPhase = e.phase === "recession" || e.phase === "depression";
    const hot = e.phase === "peak" || e.phase === "expansion";

    // ---- lease aggressively; fund TI from the line when needed ------------
    for (const loi of [...(g.lois ?? [])]) {
      const rec = E.resolveRec(parcels, g, loi.bbl);
      const h = g.holdings[loi.bbl];
      if (!rec || !h) continue;
      const market = E.managedRentPsfYr(rec, e, h, loi.use ?? rec.class);
      if (loi.rentPsf >= market * 0.92) {
        const r = E.respondLOI(g, parcels, loi.id, "accept", true);
        if (!r.err) { g = r.s; st.leases++; }
      } else if (!loi.countered && loi.stage !== "countered") {
        const r = E.respondLOI(g, parcels, loi.id, "counter", true, {
          rentPsf: +(market * 0.98).toFixed(2),
          tiPsf: Math.round((loi.tiPsf ?? 0) * 0.75),
        });
        if (!r.err) g = r.s;
      } else {
        // Soft market: take the bird. Hot market: walk once.
        if (softPhase || loi.rentPsf >= market * 0.88) {
          const r = E.respondLOI(g, parcels, loi.id, "accept", true);
          if (!r.err) { g = r.s; st.leases++; }
          else {
            const d = E.respondLOI(g, parcels, loi.id, "decline");
            if (!d.err) { g = d.s; st.declined++; }
          }
        } else {
          const d = E.respondLOI(g, parcels, loi.id, "decline");
          if (!d.err) { g = d.s; st.declined++; }
        }
      }
    }

    // Brokers on empty space
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

    // ---- refinance balloons ------------------------------------------------
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

    // ---- take strong offers ------------------------------------------------
    for (const h of Object.values(g.holdings)) {
      if (!h.sale?.offer) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec) continue;
      const v = E.holdingValue(rec, e, h, g.month);
      if (h.sale.offer.price >= v * (hot ? 1.04 : 0.98)) {
        const r = E.acceptSaleOffer(g, parcels, h.bbl);
        if (!r.err) {
          g = r.s; st.sold++;
          push(g.month, `Sold ${rec.address} for ${M(h.sale.offer.price)} into ${e.phase}.`);
        }
      } else if (!h.sale.offer.countered) {
        const r = E.counterSale(g, parcels, h.bbl, Math.round(h.sale.offer.price * 1.06));
        if (!r.err) g = r.s;
      }
    }

    // ---- trim into strength / prune dogs -----------------------------------
    if (m % 6 === 0) {
      for (const h of Object.values(g.holdings)) {
        if (h.sale || g.developments?.[h.bbl]) continue;
        const rec = E.resolveRec(parcels, g, h.bbl);
        if (!rec || rec.class === "land") continue;
        const v = E.holdingValue(rec, e, h, g.month);
        const held = g.month - h.boughtM;
        const bigGain = v > h.costBasis * 1.85 && held > 72 && hot;
        const dog = held > 120 && v < h.costBasis * 0.85 && softPhase;
        if (bigGain || dog) {
          const r = E.listForSale(g, parcels, h.bbl, Math.round(v * (dog ? 0.96 : 1.04)));
          if (!r.err) { g = r.s; break; }
        }
      }
    }

    // ---- reserve & acquire -------------------------------------------------
    let committed = 0;
    for (const d of Object.values(g.developments ?? {})) {
      committed += Math.max(0, (d.equityBudget ?? 0) - (d.equitySpent ?? 0));
    }
    const nHold = Object.keys(g.holdings).length;
    const reserve = 1.8e6 + nHold * 3.5e5 + committed;
    const cash = g.cash;

    if (!Object.keys(g.talks ?? {}).length && cash > reserve) {
      let best = null;
      for (const l of g.listings ?? []) {
        if (g.holdings[l.bbl]) continue;
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec) continue;
        const isLand = rec.class === "land";
        if (isLand) {
          if (rec.lotArea < 3000 || rec.demandScore < 55) continue;
          // Only buy dirt when something is short — or dirt is distressed cheap.
          if (!tight("multifamily") && !tight("office") && !tight("retail") && !l.distress) continue;
          const score = rec.demandScore / 800 + (l.distress ? 0.04 : 0);
          if (!best || score > best.score) best = { l, score, isLand, rec };
          continue;
        }
        const cond = E.initialCondition(rec);
        const noi = E.noiAfterTaxYr(rec, e, cond, l.ask);
        const yld = l.ask > 0 ? noi / l.ask : 0;
        const coupon = (e.indexRate + (softPhase ? 0.9 : 1.5)) / 100;
        // Buy when yield clears the coupon, or when distressed in a soft market.
        const want = (yld > coupon && !loose(rec.class))
          || (l.distress && yld > coupon * 0.85)
          || (softPhase && l.distress && rec.demandScore > 50 && yld > (e.indexRate) / 100);
        if (!want) continue;
        const score = yld + (l.distress ? 0.03 : 0) + rec.demandScore / 5000;
        if (!best || score > best.score) best = { l, score, isLand, rec, yld };
      }
      if (best) {
        const bid = Math.round(best.l.ask * (best.l.distress ? 0.88 : 0.93));
        const prod = best.isLand ? "land" : "savings";
        const q = E.buyQuote(g, parcels, best.l.bbl, bid, prod, best.isLand ? 0.55 : 0.70);
        if (q.equity < cash - reserve * 0.55) {
          const r = E.negotiate(g, parcels, best.l.bbl, bid);
          if (!r.err) g = r.s;
        }
      }
    }

    for (const t of Object.values(g.talks ?? {})) {
      const rec = E.resolveRec(parcels, g, t.bbl);
      if (t.agreed) {
        const prod = rec && rec.class === "land" ? "land" : "savings";
        let r = E.closeDeal(g, parcels, t.bbl, prod, rec?.class === "land" ? 0.55 : 0.70);
        if (r.err) r = E.closeDeal(g, parcels, t.bbl, "cash", 1);
        if (!r.err) {
          g = r.s;
          st.bought++;
          if (rec?.class === "land") st.land++;
          if (g.listings?.some((l) => l.bbl === t.bbl && l.distress)
            || (t.agreedPrice && rec && t.agreedPrice < E.assetValue(rec, e, E.initialCondition(rec)) * 0.9)) {
            st.distress++;
          }
          if (firstDealM === null) {
            firstDealM = g.month;
            milestones.push(`First closing in ${YR(g.month)} — ${rec?.address ?? t.bbl} at ${M(t.agreedPrice ?? 0)}.`);
            push(g.month, `First closing: ${rec?.address ?? "a deed"} at ${M(t.agreedPrice ?? 0)}.`);
          }
        }
        continue;
      }
      const noi = rec && rec.class !== "land"
        ? E.noiAfterTaxYr(rec, e, E.initialCondition(rec), t.theirPrice) : 0;
      const ok = rec && (rec.class === "land"
        ? t.theirPrice < E.landValue(rec, e) * 1.08
        : noi / Math.max(1, t.theirPrice) > (e.indexRate + 1.0) / 100);
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

    // ---- build into shortages ----------------------------------------------
    if (m % 3 === 0 && cash > reserve * 2.2) {
      for (const h of Object.values(g.holdings)) {
        const rec = E.resolveRec(parcels, g, h.bbl) ?? parcels[h.bbl];
        if (!rec || rec.class !== "land" || g.developments?.[h.bbl]) continue;
        const use = tight("multifamily") ? "multifamily"
          : tight("office") ? "office"
          : tight("retail") ? "retail"
          : tight("industrial") ? "industrial" : null;
        if (!use) continue;
        const fl = Math.min(E.maxFloorsFor(rec, 0.6), use === "multifamily" ? 12 : 10);
        const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
        if (!plan || plan.hurdleRatio < 1.02) continue;
        if (plan.equityAtClose > cash - reserve) continue;
        const r = E.startDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
        if (!r.err) {
          g = r.s; st.built++;
          push(g.month, `Broke ground on ${use} at ${rec.address} — ${plan.sf.toLocaleString()} sf, YoC ${plan.yieldOnCost.toFixed(2)}%.`);
          break;
        }
      }
    }

    const nw = E.netWorth(g, parcels);
    peakNW = Math.max(peakNW, nw);
    troughFrom = Math.max(troughFrom, peakNW > 0 ? 1 - nw / peakNW : 0);
    if (g.cash < 500_000) st.lowCash++;

    // Rank vs street
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
        y: YR(g.month),
        nw,
        cash: g.cash,
        bldgs: Object.keys(g.holdings).length,
        phase: e.phase,
        vac: e.cityVac?.office,
        rent: e.rentIdx?.office,
        cpi: e.cpi,
        rank,
        field: rows.length,
        leader: top.name,
        leaderEq: top.eq,
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
    : [12007]);

const runs = [];
for (const seed of seedList) {
  console.log(`\nPlaying century · seed ${seed} · start ${M(START_CASH)} · ${MONTHS / 12}y target…`);
  const t0 = performance.now();
  const r = play(seed);
  console.log(`  finished in ${((performance.now() - t0) / 1000).toFixed(1)}s — NW ${M(r.nw)} · rank ${r.rank}/${r.field}${r.g.gameOver ? " · DEAD" : ""}`);
  runs.push(r);
}

runs.sort((a, b) => {
  // Prefer finished centuries, then rank, then NW
  const aDead = a.g.gameOver ? 1 : 0;
  const bDead = b.g.gameOver ? 1 : 0;
  if (aDead !== bDead) return aDead - bDead;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return b.nw - a.nw;
});
const best = runs[0];

// ---- narrative report -------------------------------------------------------
const lines = [];
const L = (s = "") => lines.push(s);

L(`# Century Play — Trying to Own the Street`);
L(``);
L(`Started with **${M(START_CASH)}**. City seed ${CITY_SEED}. Market seed **${best.seed}**.`);
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
L(`| Bought / built / sold | ${best.st.bought} / ${best.st.built} / ${best.st.sold} |`);
L(`| Leases signed | ${best.st.leases} |`);
L(`| Refis | ${best.st.refis} |`);
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
L(`| Year | NW | Cash | Bldgs | Phase | Off vac | Rank | Leader | Gap to #1 |`);
L(`|-----:|---:|-----:|------:|-------|--------:|-----:|--------|----------:|`);
for (const d of best.decades) {
  L(`| ${d.y} | ${M(d.nw)} | ${M(d.cash)} | ${d.bldgs} | ${d.phase} | ${((d.vac ?? 0) * 100).toFixed(1)}% | #${d.rank}/${d.field} | ${d.leader} | ${d.gap ? M(d.gap) : "—"} |`);
}
L(``);
L(`## Milestones`);
L(``);
if (best.milestones.length) for (const m of best.milestones) L(`- ${m}`);
else L(`- No major milestones recorded.`);
L(``);
L(`## Story beats`);
L(``);
for (const s of best.story.slice(0, 80)) {
  L(`- **${s.y}:** ${s.text}`);
}
if (best.story.length > 80) L(`- … (${best.story.length - 80} more beats omitted)`);
L(``);

// Portfolio snapshot
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
    const k = rec.class;
    byClass[k] = (byClass[k] ?? 0) + 1;
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
    L(`- seed ${r.seed}: NW ${M(r.nw)}, rank #${r.rank}/${r.field}${r.g.gameOver ? " (dead)" : ""}`);
  }
  L(``);
}

const out = join(ROOT, "PLAY100_STORY.md");
writeFileSync(out, lines.join("\n"));
console.log(`\nWrote ${out}`);
console.log(lines.join("\n"));
