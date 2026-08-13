// THE BALANCE HARNESS. Five strategies x N seeds, a full century each,
// reporting the distribution rather than the anecdote.
//
//   pnpm balance                 five archetypes, 20 seeds, 100 years
//   ONLY=reckless N=60 pnpm balance    one archetype, more seeds
//   HORIZON=240 pnpm balance     twenty years
//
// This is the other half of `pnpm test`. The invariant harness asks whether
// the state is coherent; this asks whether the game is worth playing — whether
// leverage is priced, whether a downturn can hurt you, whether any strategy is
// strictly dominant. Read the tails, not the medians: a strategy whose p10 is
// close to its median is not taking risk, whatever it looks like it is doing.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
// Cities live in per-city dirs now; the harness runs against one of them.
// BW_CITY picks which island (default somewhere — generated).
const E = await import(process.env.ENGINE ?? join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);
const M = (n) => (Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : `${(n / 1e6).toFixed(0)}M`);

// --- the four archetypes ----------------------------------------------------
const STRATS = {
  // buys stabilised income, low leverage, holds forever
  core: { lev: 0.55, prod: (c, g) => "pelican", buyIf: (c) => c.built && c.yield > 0.055, dev: false, sell: (gainPct) => false },
  // levers up, buys anything with a story, refinances constantly
  yieldHog: { lev: 1.0, prod: (c, g) => (c.yield < 0.05 ? "cordage" : "cordage"), buyIf: (c) => c.built, dev: false, refi: true, sell: () => false },
  // builds
  developer: { lev: 0.9, prod: (c) => (c.built ? "savings" : "land"), buyIf: () => true, dev: true, sell: (gp) => gp > 0.6 },
  // maximum leverage, no reserve, buys every quarter it can — the archetype
  // that SHOULD be able to lose everything, and the test of whether it can
  reckless: { lev: 1.0, prod: () => "cordage", buyIf: (c) => c.built, dev: false, refi: true, sell: () => false, hungry: true },
  // trades: buy, stabilise, sell into strength
  trader: { lev: 0.85, prod: (c) => (c.built ? "savings" : "land"), buyIf: (c) => c.built, dev: false, sell: (gp) => gp > 0.35 },
};

function run(stratName, seed) {
  const S = STRATS[stratName];
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const st = { bought: 0, built: 0, sold: 0, leases: 0, lois: 0, passed: 0, defaults: 0, forced: 0,
    minNW: Infinity, maxNW: 0, negCash: 0, recap: 0, tax: 0, deadEnd: 0 };
  let lastNews = 0;
  const HORIZON = Number(process.env.HORIZON ?? 1200);
  for (let m = 0; m < HORIZON; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    for (const n of g.news.slice(0, 6)) {
      if (n.q !== g.month) break;
      if (/went dark/.test(n.text)) st.defaults++;
      if (/sold under pressure/.test(n.text)) st.forced++;
    }
    lastNews = g.news.length;
    const nw = E.netWorth(g, parcels);
    st.maxNW = Math.max(st.maxNW, nw); st.minNW = Math.min(st.minNW, nw);
    if (g.cash < 0) st.negCash++;
    if (g.gameOver) break;

    for (const loi of [...g.lois]) {
      st.lois++;
      const rec = E.resolveRec(parcels, g, loi.bbl); const h = g.holdings[loi.bbl];
      if (!rec || !h) continue;
      const mkt = E.managedRentPsfYr(rec, g.econ, h);
      // a competent operator refuses a bad lease; a gross lease is worth less
      const struct = (loi.recovery ?? (loi.net ? "nnn" : "gross"));
      const adj = struct === "nnn" ? 1 : struct === "base" ? 0.94 : 0.84;
      const worth = loi.rentPsf * adj;
      if (worth < mkt * 0.8 && !loi.countered) { g = E.respondLOI(g, parcels, loi.id, "counter").s; continue; }
      if (worth < mkt * 0.66) { g = E.respondLOI(g, parcels, loi.id, "decline").s; st.passed++; continue; }
      const r = E.respondLOI(g, parcels, loi.id, "accept", true);
      if (r.err) { g = E.respondLOI(g, parcels, loi.id, "decline").s; st.passed++; st.deadEnd++; }
      else { g = r.s; st.leases++; }
    }

    for (const bbl of Object.keys(g.holdings)) {
      const h = g.holdings[bbl];
      const off = h.sale?.offer;
      if (!off) continue;
      const q = E.saleTaxQuote(h, off.price);
      const gainPct = h.costBasis > 0 ? q.gain / h.costBasis : 0;
      if (h.sale?.unsolicited ? gainPct > 0.25 : S.sell(gainPct)) {
        const r = E.acceptSaleOffer(g, parcels, bbl);
        if (!r.err) { g = r.s; st.sold++; st.recap += q.recapture ?? 0; st.tax += q.tax; }
      }
    }

    if (m % (S.hungry ? 4 : 9) === 3) {
      const cands = g.listings.map((l) => ({ l, r: E.resolveRec(parcels, g, l.bbl) })).filter((x) => x.r)
        .map((x) => { const built = x.r.class !== "land" && x.r.bldgArea > 0;
          const noi = built ? E.noiYr(x.r, g.econ, E.initialCondition(x.r)) : 0;
          return { ...x, built, yield: built && x.l.ask > 0 ? noi / x.l.ask : 0 }; })
        .filter((c) => S.buyIf(c)).sort((a, b) => b.yield - a.yield);
      for (const c of cands.slice(0, 8)) {
        const r = E.buyListing(g, parcels, c.l.bbl, S.prod(c, g), S.lev, Math.round(c.l.ask * 0.96));
        if (!r.err) {
          g = r.s;
          if (!r.refused && g.holdings[c.l.bbl]) st.bought++;
          break;
        }
      }
    }

    if (S.dev && m % 14 === 5) {
      for (const bbl of Object.keys(g.holdings)) {
        const rec = E.resolveRec(parcels, g, bbl);
        if (!rec || rec.class !== "land" || g.developments[bbl]) continue;
        let done = false;
        // a developer who knows the business: pre-let a third of it, take the
        // guaranteed price when costs are running, and only build a spread
        const hot = g.econ.phase === "expansion" || g.econ.phase === "peak";
        const contract = hot ? "gmp" : "costplus";
        for (let fl = Math.min(E.maxFloorsFor(rec, 0.6), 26); fl >= 2 && !done; fl--) {
          const plan = E.planDevelopment(g, parcels, bbl, "office", fl, 0.6, contract);
          if (!plan || plan.commitment === 0) continue;
          if (plan.yieldOnCost - plan.exitCap < 1.0) continue;      // no spread, no shovel
          if (plan.equityAtClose > g.cash * 0.45) continue;
          const r = E.startDevelopment(g, parcels, bbl, "office", fl, 0.6, contract);
          if (!r.err) { g = r.s; st.built++; done = true; }
        }
        if (done) break;
      }
    }

    if (S.refi && m % 31 === 9) {
      for (const bbl of Object.keys(g.holdings)) {
        const h = g.holdings[bbl];
        if (!h.loan || g.month - h.loan.originM < 60) continue;
        const { quotes } = E.refiQuotes(g, parcels, bbl);
        const best = quotes.filter((q) => q.available).sort((a, b) => b.maxProceeds - a.maxProceeds)[0];
        if (best && best.maxProceeds > h.loan.balance * 1.2) {
          const r = E.refinance(g, parcels, bbl, best.id, 0.95);
          if (!r.err) g = r.s;
        }
        // NO break. The old harness stopped after the first eligible building,
        // so a "maximum leverage" bot with a hundred assets refinanced ONE of
        // them a decade — its portfolio LTV drifted from 38% to 20% over a
        // century. It was measuring a conservative hold with a levered entry
        // and calling it recklessness.
      }
    }
  }
  void lastNews;
  const nw = E.netWorth(g, parcels);
  // Physical occupancy of the whole book: commercial space under lease PLUS
  // residential space occupied. Counting only named tenants read a full block
  // of flats over shops as 45% empty.
  const occ = Object.entries(g.holdings).reduce((a, [b, h]) => {
    const rec = E.resolveRec(parcels, g, b);
    if (!rec || !rec.bldgArea) return a;
    const leased = h.tenants.reduce((n, t) => n + t.sf, 0)
      + E.useSf(rec, "multifamily") * (h.occ ?? 0);
    return { l: a.l + leased, t: a.t + rec.bldgArea };
  }, { l: 0, t: 0 });
  const walts = Object.entries(g.holdings).map(([b, h]) => E.walt(h, g.month)).filter((w) => w > 0);
  return { ...st, nw, holdings: Object.keys(g.holdings).length, over: g.gameOver ?? false,
    occ: occ.t ? occ.l / occ.t : 0, walt: walts.length ? walts.reduce((a, b) => a + b, 0) / walts.length : 0 };
}

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log("strategy    n   NW p10      NW med      NW p90    CAGR   occ   WALT  wipeouts  defaults  forced  passes  deadEnd");
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const N = Number(process.env.N ?? 20);
for (const name of Object.keys(STRATS).filter((k) => !ONLY || ONLY.includes(k))) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(run(name, 1000 + i * 37));
  const nws = runs.map((r) => r.nw);
  const YRS = Number(process.env.HORIZON ?? 1200) / 12;
  const cagr = (v) => (Math.pow(Math.max(1, v) / 6e6, 1 / YRS) - 1) * 100;
  const wipe = runs.filter((r) => r.nw < 6e6).length;
  const avg = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  process.stdout.write([
    name.padEnd(11),
    String(runs.length).padStart(2),
    M(pct(nws, 0.1)).padStart(9),
    M(pct(nws, 0.5)).padStart(11),
    M(pct(nws, 0.9)).padStart(11),
    (cagr(pct(nws, 0.5)).toFixed(1) + "%").padStart(6),
    ((avg((r) => r.occ) * 100).toFixed(0) + "%").padStart(5),
    avg((r) => r.walt).toFixed(1).padStart(6),
    String(wipe).padStart(9),
    avg((r) => r.defaults).toFixed(0).padStart(9),
    avg((r) => r.forced).toFixed(0).padStart(7),
    avg((r) => r.passed).toFixed(0).padStart(7),
    avg((r) => r.deadEnd).toFixed(0).padStart(8),
  ].join(" ") + "\n");
}
