// A CENTURY AS THE PLAYER.
//
// Several real postures, each run for 100 years across many seeds. Not the
// lettered stress battery — a principal at the desk, compounding (or dying),
// with enough instrumentation to see exploits, dead bots, and absurd tails.
//
//   node tools/century-play.mjs
//   SEEDS=8 ONLY=principal,hog HORIZON=1200 node tools/century-play.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = await import(join(ROOT, "test/.engine.mjs"));
const { loadCity } = await import(join(ROOT, "test/city.mjs"));
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

const SEEDS = Number(process.env.SEEDS ?? 8);
const MONTHS = Number(process.env.HORIZON ?? 1200);
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const OUTDIR = process.env.OUTDIR ?? join(ROOT, "..", "artifacts", "century-play");
mkdirSync(OUTDIR, { recursive: true });

const M = (n) => {
  if (!Number.isFinite(n)) return String(n);
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };

/**
 * Postures a human might actually try. Shared leasing: take near-market LOIs.
 * Differences are acquisition, leverage, development, and sell discipline.
 */
const STRATS = {
  // Fixed play50: reserve is a FRACTION of opening cash, yield hurdle is
  // softer, and buyListing replaces the negotiate path that never fired.
  principal: {
    label: "disciplined principal",
    reserveFrac: 0.35,
    lev: 0.72,
    prod: () => "savings",
    buyIf: (c, e) => c.built && c.yield > (e.indexRate + 0.4) / 100 && !((e.cityVac?.[c.r.class] ?? 0) > (NAT[c.r.class] ?? 0) + 0.03),
    sellGain: 0.75,
    sellMinHold: 60,
    build: true,
    buildSpread: 0.9,
    refiCashout: false,
  },
  // Max leverage, buy anything standing, cash-out refinance when the desk will
  // advance more than the existing balance. The "how rich can I get" arm.
  hog: {
    label: "yield hog",
    reserveFrac: 0.12,
    lev: 1.0,
    prod: () => "cordage",
    buyIf: (c) => c.built,
    sellGain: null,
    build: false,
    refiCashout: true,
  },
  // All cash, no debt — stress test's strongest 50y arm, over a century.
  allcash: {
    label: "all-cash buyer",
    reserveFrac: 0.2,
    lev: 0,
    prod: () => "cash",
    buyIf: (c) => c.built && c.l.ask < 12e6,
    sellGain: null,
    build: false,
    refiCashout: false,
  },
  // Merchant builder: dirt → crane → lease → sell.
  merchant: {
    label: "merchant builder",
    reserveFrac: 0.25,
    lev: 0,
    prod: () => "cash",
    buyIf: (c, e, g) => {
      if (c.r.class !== "land" || c.r.lotArea < 2500) return false;
      if (Object.keys(g.developments).length || Object.keys(g.holdings).length) return false;
      const uses = ["multifamily", "office", "retail", "industrial"];
      let best = null;
      for (const use of uses) {
        const fl = Math.min(E.maxFloorsFor(c.r, 0.6), 12);
        const plan = E.planDevelopment(g, parcels, c.l.bbl, use, fl, 0.6, "gmp");
        if (!plan) continue;
        const spread = plan.yieldOnCost - plan.exitCap;
        if (!best || spread > best.spread) best = { spread, use, fl, plan };
      }
      c._plan = best;
      return !!best && best.spread >= 1.2;
    },
    sellGain: 0.15,
    sellMinHold: 30,
    build: true,
    buildSpread: 1.2,
    merchantOnly: true,
    refiCashout: false,
  },
  // Contrarian: only buy in recession / tight credit, hold through the cycle.
  contrarian: {
    label: "contrarian",
    reserveFrac: 0.3,
    lev: 0.65,
    prod: () => "savings",
    buyIf: (c, e) => c.built && (e.phase === "recession" || e.phase === "trough" || (e.creditIdx ?? 1) < 0.85),
    sellGain: null,
    build: false,
    refiCashout: false,
  },
  // Reckless: no reserve, max LTV, buy every quarter, never sell.
  reckless: {
    label: "reckless levered",
    reserveFrac: 0.02,
    lev: 1.0,
    prod: () => "cordage",
    buyIf: (c) => c.built,
    sellGain: null,
    build: false,
    hungry: true,
    refiCashout: true,
  },
};

function leaseBook(g) {
  let leases = 0, passed = 0;
  for (const loi of [...g.lois]) {
    const rec = E.resolveRec(parcels, g, loi.bbl);
    const h = g.holdings[loi.bbl];
    if (!rec || !h) continue;
    const market = E.managedRentPsfYr(rec, g.econ, h, loi.use);
    if (loi.rentPsf >= market * 0.9) {
      const r = E.respondLOI(g, parcels, loi.id, "accept", true);
      if (!r.err) { g = r.s; leases++; continue; }
    }
    if (!loi.countered && loi.stage !== "countered") {
      const r = E.respondLOI(g, parcels, loi.id, "counter", true, {
        rentPsf: +(market * 0.98).toFixed(2),
        tiPsf: Math.round(loi.tiPsf * 0.75),
      });
      if (!r.err) { g = r.s; continue; }
    }
    const acc = E.respondLOI(g, parcels, loi.id, "accept", true);
    if (!acc.err) { g = acc.s; leases++; }
    else {
      const p = E.respondLOI(g, parcels, loi.id, "pass");
      if (!p.err) g = p.s;
      passed++;
    }
  }
  return { g, leases, passed };
}

function play(name, seed) {
  const S = STRATS[name];
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const openCash = g.cash;
  const st = {
    bought: 0, sold: 0, built: 0, leases: 0, passed: 0, refis: 0,
    peakNW: openCash, troughFrom: 0, negCash: 0, maxHoldings: 0,
    years: [], anomalies: [],
  };
  let deathM = 0;

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    if (g.gameOver && !deathM) deathM = m + 1;

    // hygiene
    if (!Number.isFinite(g.cash) || !Number.isFinite(E.netWorth(g, parcels))) {
      st.anomalies.push(`m${m}: non-finite cash/NW`);
    }
    for (const u of ["office", "retail", "multifamily", "industrial"]) {
      const ri = g.econ.rentIdx?.[u];
      if (ri !== undefined && (!Number.isFinite(ri) || ri < 0 || ri > 1e6)) {
        st.anomalies.push(`m${m}: rentIdx.${u}=${ri}`);
      }
    }

    if (!g.gameOver) {
      const L = leaseBook(g);
      g = L.g; st.leases += L.leases; st.passed += L.passed;

      // take good sale offers
      for (const h of Object.values(g.holdings)) {
        if (!h.sale?.offer) continue;
        const rec = E.resolveRec(parcels, g, h.bbl);
        if (!rec) continue;
        const v = E.holdingValue(rec, g.econ, h, g.month);
        const take = S.sellGain == null
          ? h.sale.offer.price >= v * 0.97
          : h.sale.offer.price >= v * 1.02;
        if (take) {
          const r = E.acceptSaleOffer(g, parcels, h.bbl);
          if (!r.err) { g = r.s; st.sold++; }
        }
      }

      // list for sale on discipline
      if (S.sellGain != null && m % 6 === 0) {
        for (const h of Object.values(g.holdings)) {
          if (h.sale || g.developments[h.bbl]) continue;
          const rec = E.resolveRec(parcels, g, h.bbl);
          if (!rec || rec.class === "land") continue;
          const held = g.month - (h.boughtM ?? h.deliveredM ?? 0);
          if (held < (S.sellMinHold ?? 36)) continue;
          const v = E.holdingValue(rec, g.econ, h, g.month);
          const gain = h.costBasis > 0 ? (v - h.costBasis) / h.costBasis : 0;
          const occ = rec.bldgArea > 0
            ? h.tenants.reduce((a, t) => a + t.sf, 0) / rec.bldgArea
            : (h.occ ?? 0);
          if (S.merchantOnly && (held < 30 || occ < 0.8)) continue;
          if (gain >= S.sellGain || (S.merchantOnly && occ > 0.82 && held > 30)) {
            const r = E.listForSale(g, parcels, h.bbl, Math.round(v * 1.03));
            if (!r.err) { g = r.s; break; }
          }
        }
      }

      // cash-out refinance
      if (S.refiCashout && m % 24 === 11) {
        for (const bbl of Object.keys(g.holdings)) {
          const h = g.holdings[bbl];
          if (!h.loan || g.month - h.loan.originM < 48) continue;
          const { quotes } = E.refiQuotes(g, parcels, bbl);
          const best = (quotes ?? []).filter((q) => q.available !== false)
            .sort((a, b) => b.maxProceeds - a.maxProceeds)[0];
          if (best && best.maxProceeds > h.loan.balance * 1.15) {
            const r = E.refinance(g, parcels, bbl, best.id, 0.95);
            if (!r.err) { g = r.s; st.refis++; }
          }
        }
      }

      // buy
      const reserve = openCash * S.reserveFrac + Object.keys(g.holdings).length * 2e5
        + Object.values(g.developments).reduce((a, d) => a + Math.max(0, (d.equityBudget ?? 0) - (d.equitySpent ?? 0)), 0);
      const hungryEvery = S.hungry ? 3 : 8;
      if (m % hungryEvery === 2 && g.cash > reserve) {
        const cands = [];
        for (const l of g.listings) {
          if (g.holdings[l.bbl]) continue;
          const r = E.resolveRec(parcels, g, l.bbl);
          if (!r) continue;
          const built = r.class !== "land" && r.bldgArea > 0;
          const noi = built ? E.noiAfterTaxYr(r, g.econ, E.initialCondition(r), l.ask) : 0;
          const cand = { l, r, built, yield: built && l.ask > 0 ? noi / l.ask : 0 };
          if (S.buyIf(cand, g.econ, g)) cands.push(cand);
        }
        cands.sort((a, b) => (b.yield || b.r.demandScore / 500) - (a.yield || a.r.demandScore / 500));
        for (const c of cands.slice(0, 10)) {
          const px = Math.round(c.l.ask * (S.lev <= 0.01 ? 0.94 : 0.96));
          const prod = S.prod(c, g);
          const lev = S.lev <= 0.01 ? 1 : S.lev;
          let r;
          if (typeof E.buyListing === "function") {
            r = E.buyListing(g, parcels, c.l.bbl, prod, lev, px);
          } else {
            r = E.executePurchase(g, parcels, c.l.bbl, px, prod, false, lev);
          }
          // buyListing can update news / pull a listing on a refusal without
          // transferring a deed — count only real closings.
          if (!r.err) {
            g = r.s;
            if (r.refused) break;
            if (g.holdings[c.l.bbl]) { st.bought++; break; }
            break;
          }
        }
      }

      // build
      if (S.build && m % 4 === 0 && g.cash > reserve) {
        for (const h of Object.values(g.holdings)) {
          const rec = E.resolveRec(parcels, g, h.bbl);
          if (!rec || rec.class !== "land" || g.developments[h.bbl]) continue;
          const uses = S.merchantOnly
            ? ["multifamily", "office", "retail", "industrial"]
            : (["multifamily", "office", "retail"].filter((u) => (g.econ.cityVac?.[u] ?? 0.2) < (NAT[u] ?? 0.1)));
          let best = null;
          for (const use of (uses.length ? uses : ["multifamily"])) {
            const fl = Math.min(E.maxFloorsFor(rec, 0.6), S.merchantOnly ? 12 : 10);
            const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6, "gmp");
            if (!plan) continue;
            const spread = plan.yieldOnCost - plan.exitCap;
            if (spread < (S.buildSpread ?? 0.9)) continue;
            if (plan.equityAtClose > g.cash - reserve) continue;
            if (!best || spread > best.spread) best = { use, fl, spread, plan };
          }
          if (!best) continue;
          const r = E.startDevelopment(g, parcels, h.bbl, best.use, best.fl, 0.6, "gmp", S.merchantOnly ? 0.65 : undefined);
          if (!r.err) { g = r.s; st.built++; break; }
        }
      }

      // mini-perm takeout for anything we built
      if (S.build && m % 3 === 1) {
        for (const h of Object.values(g.holdings)) {
          const l = h.loan;
          if (!l || g.developments[h.bbl]) continue;
          if (l.maturityM - g.month > 15) continue;
          const { quotes } = E.refiQuotes(g, parcels, h.bbl);
          const payoff = l.balance;
          const best = (quotes ?? []).filter((qq) => qq.maxProceeds >= payoff * 0.9)
            .sort((a, b) => a.ratePct - b.ratePct)[0];
          if (!best) continue;
          const r = E.refinance(g, parcels, h.bbl, best.id, 1);
          if (!r.err) { g = r.s; st.refis++; }
        }
      }
    }

    const nw = E.netWorth(g, parcels);
    st.peakNW = Math.max(st.peakNW, nw);
    st.troughFrom = Math.max(st.troughFrom, st.peakNW > 0 ? 1 - nw / st.peakNW : 0);
    if (g.cash < 0) st.negCash++;
    st.maxHoldings = Math.max(st.maxHoldings, Object.keys(g.holdings).length);

    if (m % 60 === 59 || (g.gameOver && deathM === m + 1)) {
      st.years.push({
        yr: Math.floor(m / 12) + 1,
        nw, cash: g.cash,
        bldgs: Object.keys(g.holdings).length,
        phase: g.econ.phase,
        idx: g.econ.indexRate,
        cpi: g.econ.cpi,
        dead: !!g.gameOver,
      });
    }
    if (g.gameOver) break;
  }

  const nw = E.netWorth(g, parcels);
  const board = (g.rivals ?? []).filter((r) => r.failedM === undefined).map((r) => {
    const m = E.markRival(g, parcels, r);
    return { name: r.name, eq: m.aum - r.debt + r.cash };
  });
  board.push({ name: "You", eq: nw });
  board.sort((a, b) => b.eq - a.eq);
  const rank = board.findIndex((b) => b.name === "You") + 1;
  const cpi = g.econ.cpi || 1;
  const yrs = (deathM || MONTHS) / 12;
  const cagr = nw > 0 ? (Math.pow(nw / openCash, 1 / yrs) - 1) * 100 : -100;

  return {
    name, seed, label: S.label,
    nw, real: nw / cpi, peakNW: st.peakNW, drawdown: st.troughFrom,
    openCash, cpi, cagr, deathM, gameOver: g.gameOver?.cause ?? null,
    bought: st.bought, sold: st.sold, built: st.built, leases: st.leases,
    refis: st.refis, holdings: Object.keys(g.holdings).length,
    maxHoldings: st.maxHoldings, negCash: st.negCash,
    rank, field: board.length, top: board[0],
    deadRivals: (g.rivals ?? []).filter((r) => r.failedM !== undefined).length,
    years: st.years, anomalies: st.anomalies,
  };
}

const names = Object.keys(STRATS).filter((k) => !ONLY || ONLY.includes(k));
const all = [];
console.log(`Century play · ${MONTHS / 12} years · ${SEEDS} seeds · ${names.join(", ")}\n`);

for (const name of names) {
  const runs = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = 1000 + i * 7919;
    const r = play(name, seed);
    runs.push(r);
    all.push(r);
    const end = r.gameOver ? ` DIED m${r.deathM}: ${r.gameOver.slice(0, 50)}` : "";
    console.log(
      `${name.padEnd(11)} s${String(i + 1).padStart(2)}  NW ${M(r.nw).padStart(9)}  real ${M(r.real).padStart(9)}` +
      `  CAGR ${r.cagr.toFixed(1).padStart(5)}%  DD ${(r.drawdown * 100).toFixed(0).padStart(3)}%` +
      `  ${String(r.bought).padStart(3)} buy ${String(r.built).padStart(2)} bld ${String(r.sold).padStart(2)} sell` +
      `  rank ${r.rank}/${r.field}${end}`,
    );
    if (i === 0 && r.years.length) {
      console.log("  trajectory:");
      for (const y of r.years) {
        console.log(
          `    yr ${String(y.yr).padStart(3)}  NW ${M(y.nw).padStart(9)}  cash ${M(y.cash).padStart(8)}` +
          `  ${String(y.bldgs).padStart(2)} assets  ${y.phase.padEnd(10)} idx ${y.idx.toFixed(1)}%` +
          (y.dead ? "  †" : ""),
        );
      }
    }
  }
  const nws = runs.map((r) => r.nw).sort((a, b) => a - b);
  const reals = runs.map((r) => r.real).sort((a, b) => a - b);
  const med = (a) => a[Math.floor(a.length / 2)];
  const wipe = runs.filter((r) => r.deathM || r.nw < r.openCash).length;
  const inert = runs.filter((r) => r.bought + r.built === 0).length;
  const anom = runs.reduce((a, r) => a + r.anomalies.length, 0);
  console.log(
    `  › ${name}: worst ${M(nws[0])}  med ${M(med(nws))}  best ${M(nws[nws.length - 1])}` +
    `  · real med ${M(med(reals))}  · wipe/underwater ${wipe}/${SEEDS}` +
    `  · inert ${inert}  · anomalies ${anom}\n`,
  );
}

// Cross-strategy ranking by median real NW
const byStrat = new Map();
for (const r of all) {
  if (!byStrat.has(r.name)) byStrat.set(r.name, []);
  byStrat.get(r.name).push(r);
}
console.log("=== MEDIAN REAL NET WORTH AFTER A CENTURY ===");
const ranked = [...byStrat.entries()].map(([name, runs]) => {
  const reals = runs.map((r) => r.real).sort((a, b) => a - b);
  const nws = runs.map((r) => r.nw).sort((a, b) => a - b);
  const med = (a) => a[Math.floor(a.length / 2)];
  return {
    name,
    medReal: med(reals),
    medNW: med(nws),
    best: Math.max(...nws),
    worst: Math.min(...nws),
    wipe: runs.filter((r) => r.deathM).length,
    inert: runs.filter((r) => r.bought + r.built === 0).length,
    avgBuy: runs.reduce((a, r) => a + r.bought, 0) / runs.length,
    avgBuilt: runs.reduce((a, r) => a + r.built, 0) / runs.length,
  };
}).sort((a, b) => b.medReal - a.medReal);
for (const row of ranked) {
  console.log(
    `${row.name.padEnd(12)} medNW ${M(row.medNW).padStart(9)}  real ${M(row.medReal).padStart(9)}` +
    `  best ${M(row.best).padStart(9)}  worst ${M(row.worst).padStart(9)}` +
    `  deaths ${row.wipe}/${SEEDS}  inert ${row.inert}  avgBuy ${row.avgBuy.toFixed(1)}  avgBld ${row.avgBuilt.toFixed(1)}`,
  );
}

const report = {
  months: MONTHS, seeds: SEEDS, city: process.env.BW_CITY ?? "somewhere",
  ranked, runs: all.map(({ years, ...rest }) => ({ ...rest, yearMarks: years.length })),
  sampleTrajectories: Object.fromEntries(
    names.map((n) => [n, all.find((r) => r.name === n)?.years ?? []]),
  ),
};
writeFileSync(join(OUTDIR, "century-results.json"), JSON.stringify(report, null, 2));
console.log(`\nwrote ${join(OUTDIR, "century-results.json")}`);
