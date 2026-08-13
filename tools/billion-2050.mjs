// BILLION BY 2050 — multi-size, random-city playthroughs on the #57 tip.
//
//   node tools/billion-2050.mjs
//   RUNS=20 START_CASH=5000000 node tools/billion-2050.mjs
//
// Each run: random generated island, random size, fresh city seed + market seed.
// Sets game.citySize so rival powder / hold caps scale.
// Bot = buy/lease compounder from play100-story (aggressive income buyer).
// Horizon default 600 months → Dec 2049 / early 2050.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = await import(join(ROOT, "test/.engine.mjs"));
const { makeCity, cityName, PROCEDURAL } = await import(join(ROOT, "src/citygen/index.mjs"));

const RUNS = Number(process.env.RUNS ?? 18);
const MONTHS = Number(process.env.HORIZON ?? 600); // → 2050
const START_CASH = Number(process.env.START_CASH ?? 5_000_000);
const TARGET = 1_000_000_000;
const SIZES = ["hamlet", "town", "city", "metro", "giant"];
const ISLANDS = [PROCEDURAL];
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };

const M = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
};
const YR = (m) => 2000 + Math.floor(m / 12);

function mulberry32(a) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function board(g, parcels) {
  const rows = (g.rivals ?? []).filter((r) => r.failedM === undefined).map((r) => {
    const mk = E.markRival(g, parcels, r);
    return { name: r.name, style: r.style, eq: mk.aum - r.debt + r.cash, bldgs: r.bbls.length };
  });
  const nw = E.netWorth(g, parcels);
  rows.push({ name: "You", style: "player", eq: nw, bldgs: Object.keys(g.holdings).length });
  rows.sort((a, b) => b.eq - a.eq);
  return rows;
}

function play(cfg) {
  const { marketSeed, citySeed, island, size } = cfg;
  const built = makeCity(island, citySeed, { size });
  E.normalizeParcels(built.parcels);
  const parcels = built.parcels;
  const adjacency = built.adjacency;
  const bbls = Object.keys(parcels);
  const lots = bbls.length;
  const stockBldgs = bbls.filter((b) => parcels[b].class !== "land" && parcels[b].bldgArea > 0).length;

  let g = E.firstListings(E.newGame(marketSeed, parcels, START_CASH), parcels, bbls);
  g.citySize = size;
  g.cityIsland = island;
  g.citySeed = citySeed;

  const story = [];
  const push = (m, text) => {
    if (story.length < 80) story.push({ y: YR(m), text });
  };
  const st = {
    bought: 0, sold: 0, built: 0, leases: 0, declined: 0, refis: 0,
    land: 0, distress: 0, lowCash: 0,
  };
  let peakNW = START_CASH, troughFrom = 0;
  let hit1bM = null, everFirst = false, firstDealM = null;
  const decades = [];
  const phases = {};
  let vacTells = 0;
  let rivalFails = 0;
  let maxRivalBuilds = 0;
  const newsKinds = { rumor: 0, warn: 0, event: 0, info: 0 };

  push(0, `Opened with ${M(START_CASH)} on ${cityName(island, citySeed)} (${size}, ${lots} lots, ${stockBldgs} standing). Aim: ${M(TARGET)} by 2050.`);

  const t0 = Date.now();
  let demAnnounced = g.demolished ?? 0;
  for (let m = 0; m < MONTHS; m++) {
    const rivalsBefore = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    rivalFails += (g.rivals ?? []).filter((r) => r.failedM !== undefined).length - rivalsBefore;

    // Count fresh news this month
    for (const n of g.news ?? []) {
      if (n.q !== g.month) continue;
      newsKinds[n.kind] = (newsKinds[n.kind] ?? 0) + 1;
      if (n.kind === "rumor" && /vacancy is .+ points higher/.test(n.text ?? "")) {
        vacTells++;
        push(g.month, n.text.slice(0, 180));
      }
      if (n.kind === "event" || n.kind === "warn") {
        if (story.length < 60) push(g.month, (n.text ?? "").slice(0, 160));
      }
    }

    const e = g.econ;
    phases[e.phase] = (phases[e.phase] ?? 0) + 1;
    const loose = (k) => (e.cityVac?.[k] ?? NAT[k]) > NAT[k] + 0.02;
    const tight = (k) => (e.cityVac?.[k] ?? NAT[k]) < NAT[k] - 0.015;
    const softPhase = e.phase === "recession" || e.phase === "depression";
    const hot = e.phase === "peak" || e.phase === "expansion";

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
      } else if (softPhase || loi.rentPsf >= market * 0.88) {
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
          if (!tight("multifamily") && !tight("office") && !tight("retail") && !l.distress) continue;
          const score = rec.demandScore / 800 + (l.distress ? 0.04 : 0);
          if (!best || score > best.score) best = { l, score, isLand, rec };
          continue;
        }
        const cond = E.initialCondition(rec);
        const noi = E.noiAfterTaxYr(rec, e, cond, l.ask);
        const yld = l.ask > 0 ? noi / l.ask : 0;
        const coupon = (e.indexRate + (softPhase ? 0.9 : 1.5)) / 100;
        const want = (yld > coupon && !loose(rec.class))
          || (l.distress && yld > coupon * 0.85)
          || (softPhase && l.distress && rec.demandScore > 50 && yld > e.indexRate / 100);
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
          if (firstDealM === null) {
            firstDealM = g.month;
            push(g.month, `First closing: ${rec?.address ?? "a deed"} at ${M(t.agreedPrice ?? 0)}.`);
          } else if (st.bought <= 8 || st.bought % 10 === 0) {
            push(g.month, `Bought ${rec?.address ?? t.bbl} at ${M(t.agreedPrice ?? 0)}.`);
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

    if (m % 3 === 0 && cash > reserve * 1.6) {
      for (const h of Object.values(g.holdings)) {
        const rec = E.resolveRec(parcels, g, h.bbl) ?? parcels[h.bbl];
        if (!rec || rec.class !== "land" || g.developments?.[h.bbl]) continue;
        const use = tight("multifamily") ? "multifamily"
          : tight("office") ? "office"
          : tight("retail") ? "retail"
          : tight("industrial") ? "industrial" : null;
        if (!use) continue;
        // Fundable max-hurdle, not max floors — mid-rises were eating the
        // cheque while a 4–8 storey job would have cleared.
        const flMax = Math.min(E.maxFloorsFor(rec, 0.6), use === "multifamily" ? 12 : 10);
        let bestPlan = null, bestFl = 0;
        for (let fl = Math.min(flMax, 8); fl >= 2; fl--) {
          const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
          if (!plan || plan.hurdleRatio < 1.0) continue;
          if (plan.equityAtClose + plan.pointsCost > cash - reserve) continue;
          if (!bestPlan || plan.hurdleRatio > bestPlan.hurdleRatio) {
            bestPlan = plan; bestFl = fl;
          }
        }
        for (let fl = 9; fl <= flMax; fl++) {
          const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
          if (!plan || plan.hurdleRatio < 1.0) continue;
          if (plan.equityAtClose + plan.pointsCost > cash - reserve) continue;
          if (!bestPlan || plan.hurdleRatio > bestPlan.hurdleRatio) {
            bestPlan = plan; bestFl = fl;
          }
        }
        if (!bestPlan) continue;
        const r = E.startDevelopment(g, parcels, h.bbl, use, bestFl, 0.6, "gmp");
        if (!r.err) {
          g = r.s; st.built++;
          push(g.month, `Broke ground on ${use} at ${rec.address} — ${bestPlan.sf.toLocaleString()} sf, YoC ${bestPlan.yieldOnCost.toFixed(2)}%.`);
          break;
        }
      }
    }

    const nw = E.netWorth(g, parcels);
    peakNW = Math.max(peakNW, nw);
    troughFrom = Math.max(troughFrom, peakNW > 0 ? 1 - nw / peakNW : 0);
    if (g.cash < 500_000) st.lowCash++;
    if (hit1bM === null && nw >= TARGET) {
      hit1bM = g.month;
      push(g.month, `HIT $1B — ${M(nw)} in ${YR(g.month)}.`);
    }

    const cityJobs = (g.cityJobs ?? []).length;
    maxRivalBuilds = Math.max(maxRivalBuilds, cityJobs);

    if (m % 12 === 11) {
      const rows = board(g, parcels);
      const rank = rows.findIndex((r) => r.name === "You") + 1;
      if (rank === 1) everFirst = true;
      const leader = rows[0];
      decades.push({
        y: YR(g.month),
        nw,
        cash: g.cash,
        bldgs: Object.keys(g.holdings).length,
        phase: e.phase,
        offVac: e.cityVac?.office ?? 0,
        rank,
        nRivals: rows.length - 1,
        leader: leader?.name,
        leaderEq: leader?.eq,
        demolished: g.demolished ?? 0,
        cityJobs,
        listings: (g.listings ?? []).length,
      });
      if ((g.demolished ?? 0) >= demAnnounced + 5) {
        demAnnounced = g.demolished ?? 0;
        push(g.month, `Skyline churn — demolitions now ${demAnnounced} (rivals/city renewing).`);
      }
    }
  }

  const nw = E.netWorth(g, parcels);
  const rows = board(g, parcels);
  const rank = rows.findIndex((r) => r.name === "You") + 1;
  const realNw = typeof E.real === "function" ? E.real(nw, g.econ.cpi) : nw / (g.econ.cpi || 1);
  const aliveRivals = (g.rivals ?? []).filter((r) => r.failedM === undefined);
  const topRival = rows.find((r) => r.name !== "You");

  return {
    cfg: { ...cfg, islandName: cityName(island, citySeed), lots, stockBldgs },
    ms: Date.now() - t0,
    nw, realNw, peakNW, troughFrom, hit1bM,
    rank, nRivals: aliveRivals.length, everFirst,
    st, decades, story, phases, vacTells, rivalFails,
    demolished: g.demolished ?? 0,
    maxRivalBuilds,
    newsKinds,
    insolvent: !!g.gameOver,
    cpi: g.econ.cpi,
    phase: g.econ.phase,
    offVac: g.econ.cityVac?.office ?? 0,
    topRival,
    league: rows.slice(0, 6),
  };
}

// ---- batch -----------------------------------------------------------------
const masterSeed = Number(process.env.BATCH_SEED ?? (Date.now() >>> 0));
const rnd = mulberry32(masterSeed);
const results = [];

console.log(`\nBILLION-BY-2050  runs=${RUNS}  horizon=${MONTHS}m  cash=${M(START_CASH)}  batch=${masterSeed}`);
console.log(`engine tip: wishlist-top5 (#57 cityscale / vac tell / size coaching)\n`);

for (let i = 0; i < RUNS; i++) {
  // Cycle sizes so every size appears; shuffle within bands via seed.
  const size = SIZES[i % SIZES.length];
  const island = ISLANDS[Math.floor(rnd() * ISLANDS.length)];
  const citySeed = (Math.floor(rnd() * 0xffffffff) ^ (i * 2654435761)) >>> 0;
  const marketSeed = (Math.floor(rnd() * 0xffffffff) ^ (i * 1597334677)) >>> 0;
  const cfg = { i, size, island, citySeed, marketSeed };
  process.stdout.write(`#${i + 1}/${RUNS} ${size.padEnd(7)} ${island} … `);
  try {
    const r = play(cfg);
    results.push(r);
    const hit = r.hit1bM != null ? ` HIT@${YR(r.hit1bM)}` : "";
    console.log(`${M(r.nw).padStart(8)}  #${r.rank}/${r.nRivals + 1}  dem=${r.demolished}  vacTell=${r.vacTells}  ${Math.round(r.ms / 1000)}s${hit}${r.insolvent ? " DEAD" : ""}`);
  } catch (err) {
    console.log("FAIL", err.message);
    results.push({ cfg, error: String(err?.stack ?? err) });
  }
}

// ---- report ----------------------------------------------------------------
const ok = results.filter((r) => !r.error);
const hits = ok.filter((r) => r.hit1bM != null);
const bySize = {};
for (const r of ok) {
  (bySize[r.cfg.size] ??= []).push(r);
}

const lines = [];
const L = (s = "") => lines.push(s);
L(`# Billion by 2050 — sim report`);
L(``);
L(`Batch seed **${masterSeed}**. Runs **${ok.length}** (of ${RUNS}). Horizon **${MONTHS}** months (→ ${YR(MONTHS - 1)}). Start **${M(START_CASH)}**.`);
L(`Code: \`cursor/wishlist-top5-9786\` (#57) — size-scaled rival powder/holds, vac tell, honest equity refuse.`);
L(`Cities: generated islands only, size cycled hamlet→giant, fresh seeds every run.`);
L(``);
L(`## Scoreboard`);
L(``);
L(`| # | Size | Island | Lots | NW 2050 | Real NW | Hit $1B | Rank | Peak DD | Bought/Built/Sold | Demolish | Vac tells | Rival fails |`);
L(`|--:|------|--------|-----:|--------:|--------:|---------|-----:|--------:|------------------:|---------:|----------:|------------:|`);
ok.forEach((r, i) => {
  L(`| ${i + 1} | ${r.cfg.size} | ${r.cfg.islandName} | ${r.cfg.lots} | ${M(r.nw)} | ${M(r.realNw)} | ${r.hit1bM != null ? YR(r.hit1bM) : "—"} | #${r.rank}/${r.nRivals + 1} | ${(r.troughFrom * 100).toFixed(0)}% | ${r.st.bought}/${r.st.built}/${r.st.sold} | ${r.demolished} | ${r.vacTells} | ${r.rivalFails} |`);
});
L(``);
L(`**Hit $1B by 2050: ${hits.length}/${ok.length}** (${ok.length ? ((100 * hits.length) / ok.length).toFixed(0) : 0}%).`);
if (hits.length) {
  L(`Earliest: ${YR(Math.min(...hits.map((h) => h.hit1bM)))}. Median hit year: ${YR(hits.map((h) => h.hit1bM).sort((a, b) => a - b)[Math.floor(hits.length / 2)])}.`);
}
L(``);
L(`### By size`);
L(``);
for (const size of SIZES) {
  const rs = bySize[size] ?? [];
  if (!rs.length) continue;
  const nws = rs.map((r) => r.nw).sort((a, b) => a - b);
  const med = nws[Math.floor(nws.length / 2)];
  const h = rs.filter((r) => r.hit1bM != null).length;
  const dem = rs.reduce((a, r) => a + r.demolished, 0) / rs.length;
  const vt = rs.reduce((a, r) => a + r.vacTells, 0) / rs.length;
  L(`- **${size}** (n=${rs.length}): median NW ${M(med)}, $1B hits ${h}/${rs.length}, avg demolitions ${dem.toFixed(1)}, avg vac-tells ${vt.toFixed(1)}`);
}
L(``);
L(`## Does the city feel alive?`);
L(``);
{
  const avgDem = ok.reduce((a, r) => a + r.demolished, 0) / (ok.length || 1);
  const avgFails = ok.reduce((a, r) => a + r.rivalFails, 0) / (ok.length || 1);
  const avgJobs = ok.reduce((a, r) => a + r.maxRivalBuilds, 0) / (ok.length || 1);
  const avgTell = ok.reduce((a, r) => a + r.vacTells, 0) / (ok.length || 1);
  const avgEvent = ok.reduce((a, r) => a + (r.newsKinds.event ?? 0), 0) / (ok.length || 1);
  const avgWarn = ok.reduce((a, r) => a + (r.newsKinds.warn ?? 0), 0) / (ok.length || 1);
  L(`Across ${ok.length} fifty-year runs:`);
  L(`- Mean demolitions by 2050: **${avgDem.toFixed(1)}** (skyline renewal / rival redev)`);
  L(`- Mean rival firm failures: **${avgFails.toFixed(1)}**`);
  L(`- Mean peak concurrent cityJobs (cranes): **${avgJobs.toFixed(1)}**`);
  L(`- Mean vacancy-tell broker rumors: **${avgTell.toFixed(2)}**`);
  L(`- Mean event news / warn news: **${avgEvent.toFixed(0)}** / **${avgWarn.toFixed(0)}**`);
  L(``);
  L(`Alive if demolitions, rival failures, and cranes are non-trivial and differ by size; dead if every run is the same quiet landlord grind.`);
}
L(``);
L(`## What feels predictable`);
L(``);
{
  const ranks = ok.map((r) => r.rank);
  const firsts = ok.filter((r) => r.everFirst).length;
  const phaseDom = {};
  for (const r of ok) {
    let best = null, bn = 0;
    for (const [p, n] of Object.entries(r.phases)) if (n > bn) { best = p; bn = n; }
    phaseDom[best] = (phaseDom[best] ?? 0) + 1;
  }
  L(`- Ever #1 on the street before 2050: **${firsts}/${ok.length}**`);
  L(`- Final rank distribution: ${ranks.sort((a, b) => a - b).join(", ")}`);
  L(`- Dominant phase (most months) per run: ${Object.entries(phaseDom).map(([k, v]) => `${k}×${v}`).join(", ")}`);
  L(`- Bot pattern is stable: buy yield > coupon, lease near market, refi balloons, sell into heat — so *path variance* has to come from city size, tape, and rivals.`);
}
L(``);
L(`## Fun stories`);
L(``);
// Pick distinctive runs: biggest NW, earliest $1B, biggest drawdown survivor, most demolitions, a hamlet vs giant contrast
const picks = [];
const bestNw = [...ok].sort((a, b) => b.nw - a.nw)[0];
const worstNw = [...ok].sort((a, b) => a.nw - b.nw)[0];
const mostDem = [...ok].sort((a, b) => b.demolished - a.demolished)[0];
const earliest = [...hits].sort((a, b) => a.hit1bM - b.hit1bM)[0];
const deepDd = [...ok].sort((a, b) => b.troughFrom - a.troughFrom)[0];
for (const r of [bestNw, earliest, mostDem, deepDd, worstNw]) {
  if (r && !picks.includes(r)) picks.push(r);
}
for (const r of picks) {
  L(`### ${r.cfg.islandName} · ${r.cfg.size} · market ${r.cfg.marketSeed}`);
  L(``);
  L(`Finished **${M(r.nw)}** (real ${M(r.realNw)}), rank #${r.rank}/${r.nRivals + 1}, peak drawdown ${(r.troughFrom * 100).toFixed(0)}%, demolitions ${r.demolished}, vac tells ${r.vacTells}.${r.hit1bM != null ? ` **$1B in ${YR(r.hit1bM)}.**` : ""}`);
  L(``);
  L(`Decade path:`);
  L(``);
  L(`| Year | NW | Rank | Phase | Off vac | Cranes | Listings |`);
  L(`|-----:|---:|-----:|-------|--------:|-------:|---------:|`);
  for (const d of r.decades.filter((_, i) => i % 1 === 0)) {
    if (d.y % 10 !== 0 && d.y !== YR(MONTHS - 1)) continue;
    L(`| ${d.y} | ${M(d.nw)} | #${d.rank}/${d.nRivals + 1} | ${d.phase} | ${(d.offVac * 100).toFixed(1)}% | ${d.cityJobs} | ${d.listings} |`);
  }
  L(``);
  L(`Beats:`);
  for (const s of r.story.slice(0, 18)) L(`- **${s.y}:** ${s.text}`);
  if (r.league?.length) {
    L(``);
    L(`League (top): ${r.league.map((x) => `${x.name} ${M(x.eq)}`).join(" · ")}`);
  }
  L(``);
}

const outDir = join(ROOT, "..", "artifacts");
mkdirSync(outDir, { recursive: true });
const mdPath = join(outDir, "billion-2050-report.md");
const jsonPath = join(outDir, "billion-2050-report.json");
writeFileSync(mdPath, lines.join("\n"));
writeFileSync(jsonPath, JSON.stringify({ masterSeed, RUNS, MONTHS, START_CASH, results }, null, 2));
console.log(`\nWrote ${mdPath}`);
console.log(lines.join("\n"));
