// THE ECONOMY AUDIT — instrumentation core.
//
// This file is the measuring apparatus: it knows how to run the engine
// headlessly, how to record every observable the economy has, and how to
// compare a treatment run against its own control. It knows nothing about
// which experiments to run — that is econaudit.mjs.
//
// The design constraint that shapes everything here: a paired run must differ
// from its control in EXACTLY ONE WAY. Same seed, same city, same call order.
// The engine's RNG is a single stream threaded through state.rng, so any
// injected change that consumes a random number desynchronises the streams and
// every subsequent difference is noise. Every injector below therefore mutates
// state WITHOUT drawing from the engine's RNG.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const E = await import(join(HERE, "..", "test", ".engine.mjs"));
const { makeCity } = await import(join(HERE, "..", "src", "citygen", "index.mjs"));

export const USES = ["office", "retail", "multifamily", "industrial"];
export const MONTHS = Number(process.env.HORIZON ?? 600);   // fifty years. Not negotiable.

// ---------------------------------------------------------------------------
// the city
// ---------------------------------------------------------------------------
const cityCache = new Map();
export function city(citySeed) {
  const key = String(citySeed);
  if (!cityCache.has(key)) {
    const built = makeCity(process.env.BW_CITY ?? "somewhere", citySeed);
    E.normalizeParcels(built.parcels);
    cityCache.set(key, { parcels: built.parcels, adjacency: built.adjacency, bbls: Object.keys(built.parcels) });
  }
  return cityCache.get(key);
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// SUBMARKETS. A "block" in the owner's sense is a submarket, and the generator
// already draws them: every parcel carries a district. Aggregating to district
// is what lets a LOCAL shock be distinguished from a citywide one, which is the
// entire point of half of these experiments.
// ---------------------------------------------------------------------------
export function districtsOf(parcels, bbls) {
  const d = new Map();
  for (const b of bbls) {
    const r = parcels[b];
    if (!r) continue;
    if (!d.has(r.district)) d.set(r.district, []);
    d.get(r.district).push(b);
  }
  return d;
}

/** Great-circle-ish metres between two parcel centroids. Flat earth is fine at this scale. */
export function metres(a, b) {
  const dx = (a[0] - b[0]) * 84_000, dy = (a[1] - b[1]) * 111_000;
  return Math.hypot(dx, dy);
}

/**
 * DISTANCE RINGS AROUND AN EPICENTRE — the grouping that makes a LOCAL shock
 * legible. Four districts is too coarse to see decay; 170 blocks is too fine to
 * read. Rings answer the actual question: did the effect fall off with
 * distance, or did it land evenly on the whole town (which would mean the shock
 * was never local at all)?
 */
export const RING_EDGES = [150, 400, 900, 1e9];
export const RING_NAMES = ["r0_150m", "r150_400m", "r400_900m", "r900m_plus"];
export function ringsAround(centre) {
  return (parcels, base) => {
    const g = new Map(RING_NAMES.map((n) => [n, []]));
    for (const b of base.bbls) {
      const r = parcels[b];
      if (!r?.centroid) continue;
      const d = metres(r.centroid, centre);
      for (let i = 0; i < RING_EDGES.length; i++) {
        if (d <= RING_EDGES[i]) { g.get(RING_NAMES[i]).push(b); break; }
      }
    }
    return g;
  };
}

/**
 * A plausible place to put a major employer — the busiest block that still has
 * ROOM to get busier.
 *
 * The first version picked the busiest block outright, which in every city is
 * already sitting at demand 100 out of 100. The shock then clipped against the
 * cap and did nothing at all, and the audit dutifully reported that the inner
 * ring — the one at the epicentre — responded LESS than the ring outside it.
 * That is not a finding about the economy, it is an experiment that shocked
 * nothing. `maxDemand` keeps the headroom.
 */
export function pickEpicentre(base, klass = "office", maxDemand = 68) {
  const byBlock = new Map();
  for (const b of base.bbls) {
    const r = base.parcels[b];
    if (!r || r.class === "land" || !r.bldgArea) continue;
    const k = r.block;
    if (!byBlock.has(k)) byBlock.set(k, { sf: 0, n: 0, cx: 0, cy: 0, demand: 0, block: k });
    const o = byBlock.get(k);
    o.sf += r.class === klass ? r.bldgArea : r.bldgArea * 0.25;
    o.n++; o.cx += r.centroid[0]; o.cy += r.centroid[1]; o.demand += r.demandScore;
  }
  let best = null;
  for (const o of byBlock.values()) {
    if (o.demand / o.n > maxDemand) continue;      // no headroom: shocking it is a no-op
    if (!best || o.sf > best.sf) best = o;
  }
  if (!best) for (const o of byBlock.values()) if (!best || o.sf > best.sf) best = o;
  return { block: best.block, centre: [best.cx / best.n, best.cy / best.n], demand: best.demand / best.n };
}

// ---------------------------------------------------------------------------
// THE RECORDER
// ---------------------------------------------------------------------------
// One row a month. Everything the owner listed — rents by use and by block,
// vacancy, absorption, land values, cap rates, starts, deliveries, tenant
// counts, firm behaviour, population, employment — plus the things that turned
// out to matter once the wires were traced.
function sampleDistrict(g, parcels, list) {  // g is the live state: land is priced off its econ
  // A district's rent and value are read off its actual buildings, at their
  // actual condition, through the same functions the game shows the player.
  const out = { rent: {}, occ: {}, n: {}, land: 0, landN: 0, age: 0, ageN: 0, cap: 0, capN: 0, val: 0 };
  for (const u of USES) { out.rent[u] = 0; out.occ[u] = 0; out.n[u] = 0; }
  for (const b of list) {
    // WHAT IS STANDING ON IT TODAY, not what the generator wrote in year zero.
    // `parcels[b]` is the birth record; `resolveRec` applies everything that
    // has happened since — demolitions, deliveries, assemblages. Reading the
    // raw table meant the mean-building-age trace could not see a teardown or
    // a replacement even in principle, so it reported "turnover IS NOT
    // HAPPENING" with total confidence and no ability to observe otherwise.
    // Same failure as the landPsf one: a measurement that cannot move.
    const rec = E.resolveRec(parcels, g, b) ?? parcels[b];
    if (!rec) continue;
    // LAND IS PRICED BY `landPsfNow`, NOT BY THE RAW FIELD.
    //
    // This sampled `rec.landPsf`, which is the parcel's static base — the
    // number the generator wrote once and nothing ever changes. So every land
    // measurement in the first audit came back "never moved", and it would
    // have come back "never moved" no matter what the economy did, because it
    // was reading a constant. A harness that cannot fail is not a harness. The
    // game prices dirt through landPsfNow (base x site quality x the land
    // index x the location level x the cycle), so that is what gets measured.
    out.land += E.landPsfNow(rec, g.econ) || 0; out.landN++;
    if (rec.class === "land" || !rec.bldgArea) continue;
    const cond = E.initialCondition(rec);
    const u = rec.class === "mixed" ? "office" : rec.class;
    if (!USES.includes(u)) continue;
    out.rent[u] += E.marketRentPsfYr(rec, g.econ, cond);
    out.occ[u] += E.occupancy(rec, g.econ);
    out.n[u]++;
    out.age += (g.econ.m ?? 0) / 12 + 2000 - (rec.yearBuilt || 2000); out.ageN++;
    out.cap += E.capRateFor(rec, g.econ, cond); out.capN++;
    out.val += E.assetValue(rec, g.econ, cond);
  }
  const r = { land: out.landN ? out.land / out.landN : 0, age: out.ageN ? out.age / out.ageN : 0,
              cap: out.capN ? out.cap / out.capN : 0, val: out.val, rent: {}, occ: {}, n: out.n };
  // A RING WITH TWO RETAIL BUILDINGS IN IT IS NOT A SUBMARKET. Reporting its
  // mean rent as a series produced the audit's silliest numbers — a "-150.7%"
  // divergence in a ring whose control mean was one building that got
  // demolished. Below the floor the series is NaN, which `diverge` skips, and
  // the experiment says so rather than printing noise with a percent sign.
  const MIN_N = 4;
  for (const u of USES) {
    r.rent[u] = out.n[u] >= MIN_N ? out.rent[u] / out.n[u] : NaN;
    r.occ[u] = out.n[u] >= MIN_N ? out.occ[u] / out.n[u] : NaN;
  }
  return r;
}

function record(g, parcels, dmap, prev) {
  const e = g.econ;
  const row = {
    m: e.m ?? 0,
    // --- money
    indexRate: e.indexRate, rateRegime: e.rateRegime, creditIdx: e.creditIdx,
    policy: e.nat?.policy ?? 0, natInfl: e.nat?.infl ?? 0, natUnemp: e.nat?.unemp ?? 0,
    natCred: e.nat?.credibility ?? 0, natRec: (e.nat?.recM ?? 0) > 0 ? 1 : 0,
    // --- the price level and the people
    cpi: e.cpi ?? 1, wageIdx: e.wageIdx ?? 1, costIdx: e.costIdx ?? 1, inflExp: e.inflExp ?? 0,
    population: e.population ?? 0, jobs: e.jobs ?? 0, unemployment: e.unemployment ?? 0,
    employIdx: e.employIdx ?? 1, phase: e.phase, landIdx: e.landIdx ?? 1,
    // --- the space market, citywide
    rent: {}, effRent: {}, vac: {}, stock: {}, occupied: {}, starts: {}, pipeline: {}, cap: {},
    // --- firms and desks
    rivalsAlive: 0, rivalAum: 0, rivalCash: 0, rivalDebt: 0,
    lendersAlive: 0, lendersFailed: 0,
    listings: g.listings?.length ?? 0, distressListings: (g.listings ?? []).filter((l) => l.distress).length,
    // --- the districts
    dist: {},
  };
  for (const u of USES) {
    row.rent[u] = e.rentIdx?.[u] ?? 0;
    row.effRent[u] = e.effRentIdx?.[u] ?? 0;
    row.vac[u] = e.cityVac?.[u] ?? 0;
    row.stock[u] = e.stock?.[u] ?? 0;
    row.occupied[u] = e.occupied?.[u] ?? 0;
    row.starts[u] = e.starts?.[u] ?? 0;
    row.pipeline[u] = e.pipeline?.[u] ?? 0;
    row.cap[u] = e.capRate?.[u] ?? 0;
  }
  // ABSORPTION is a flow and the engine only keeps stocks, so it is measured
  // the way a research department measures it: the month-on-month change in
  // occupied square feet. Deliveries likewise — stock only grows by completion.
  row.absorb = {}; row.deliver = {};
  for (const u of USES) {
    row.absorb[u] = prev ? row.occupied[u] - prev.occupied[u] : 0;
    row.deliver[u] = prev ? Math.max(0, row.stock[u] - prev.stock[u]) : 0;
  }
  for (const r of g.rivals ?? []) {
    if (r.failedM !== undefined || r.dead) continue;
    row.rivalsAlive++; row.rivalAum += r.aum ?? 0; row.rivalCash += r.cash ?? 0; row.rivalDebt += r.debt ?? 0;
  }
  for (const l of g.lenders ?? []) { if (l.failedM === undefined) row.lendersAlive++; else row.lendersFailed++; }
  for (const [name, list] of dmap) row.dist[name] = sampleDistrict(g, parcels, list);
  return row;
}

// ---------------------------------------------------------------------------
// THE RUNNER
// ---------------------------------------------------------------------------
/**
 * One headless run.
 *
 * `inject` is called AFTER each engine step with (state, parcels, month). It
 * must not draw from state.rng — see the note at the top of this file.
 * `sampleEvery` thins the district sampling, which is the expensive part;
 * the citywide series is always monthly.
 */
export function run(citySeed, marketSeed, { inject = null, sampleEvery = 1, groups = null } = {}) {
  const base = city(citySeed);
  const parcels = clone(base.parcels);
  let g = E.firstListings(E.newGame(marketSeed, parcels), parcels, base.bbls);
  const dmap = groups ? groups(parcels, base) : districtsOf(parcels, base.bbls);
  const series = [];
  let prev = null;
  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
    if (inject) inject(g, parcels, m, base);
    if (m % sampleEvery === 0 || m === MONTHS - 1) {
      const row = record(g, parcels, dmap, prev);
      series.push(row); prev = row;
    }
  }
  return { series, end: g, parcels, dmap, base };
}

// ---------------------------------------------------------------------------
// COMPARISON
// ---------------------------------------------------------------------------
export const pct = (x) => (x * 100).toFixed(1) + "%";
export const med = (a) => { const b = [...a].filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
export const mean = (a) => { const b = a.filter(Number.isFinite); return b.length ? b.reduce((x, y) => x + y, 0) / b.length : NaN; };

/** Pull one scalar path out of a series. `get` is a function of a row. */
export const path = (series, get) => series.map(get);

/**
 * THE DIVERGENCE MEASUREMENT, and the reason the owner asked for two windows.
 *
 * Over fifty years a paired run drifts apart from compounding alone, so a
 * late-horizon difference proves nothing about whether a wire transmitted. The
 * propagation window is the ten to fifteen years after injection, where a real
 * transmission shows up as a divergence that GROWS and then settles. Reported:
 * the relative divergence at the peak inside the window, the month it peaked
 * (the lag), and the divergence at the end of the full horizon.
 */
export function diverge(ctrl, treat, get, { from = 0, window = 180, impact = 36 } = {}) {
  const c = path(ctrl, get), t = path(treat, get);
  const n = Math.min(c.length, t.length);
  let peak = 0, lag = 0, firstMove = -1;
  const hi = Math.min(n, from + window);
  const scale = Math.max(1e-9, Math.abs(mean(c.slice(from, hi))));
  const rels = [];
  for (let i = from; i < hi; i++) {
    if (!Number.isFinite(c[i]) || !Number.isFinite(t[i])) { rels.push(NaN); continue; }
    const rel = (t[i] - c[i]) / scale;
    rels.push(rel);
    if (firstMove < 0 && Math.abs(rel) > 0.01) firstMove = i - from;
    if (Math.abs(rel) > Math.abs(peak)) { peak = rel; lag = i - from; }
  }
  // THE IMPACT WINDOW, and the reason it exists.
  //
  // Judging DIRECTION on the peak is a methodological trap this harness fell
  // into on its first run: cut employment 12% and office vacancy over the
  // following decade came out 62% LOWER than control, which reads as
  // BACKWARDS. It is not — it is the supply response arriving. Starts
  // collapsed, the pipeline emptied, and by year eight the market was tighter
  // than the one that never lost the jobs. Both facts are true and they are
  // different facts. So direction is judged on the first three years, where
  // only the demand side has had time to act, and the peak is reported beside
  // it as the eventual magnitude.
  const early = mean(rels.slice(0, impact));
  const mid = mean(rels.slice(impact, Math.min(rels.length, 96)));
  const endRel = Number.isFinite(c[n - 1]) && Math.abs(c[n - 1]) > 1e-9 ? (t[n - 1] - c[n - 1]) / Math.abs(c[n - 1]) : 0;
  // A relative number against a control mean of nearly nothing is not a
  // measurement. Starts spend most months at zero, so this flag stops a
  // "-275%" from being read as a strong wire.
  const thin = Math.abs(mean(c.slice(from, hi))) < 1e-6;
  return { peak, lag, firstMove, early, mid, endRel, thin,
           ctrlMean: mean(c.slice(from, hi)), treatMean: mean(t.slice(from, hi)) };
}

/**
 * A verdict, from the measured divergence and what we EXPECTED it to be.
 * Direction comes from the impact window; magnitude from the peak.
 */
export function verdict(d, expectSign, { weak = 0.02, strong = 0.06 } = {}) {
  const mag = Math.abs(d.peak);
  if (mag < weak) return "BROKEN";
  if (expectSign) {
    const dir = Math.abs(d.early) > weak * 0.5 ? Math.sign(d.early) : Math.sign(d.peak);
    if (dir !== Math.sign(expectSign)) return "BACKWARDS";
  }
  return mag < strong ? "WEAK" : "WIRED";
}

export const fmtDiv = (d) => `impact(0-3y) ${d.early >= 0 ? "+" : ""}${(d.early * 100).toFixed(1)}%` +
  ` · peak ${d.peak >= 0 ? "+" : ""}${(d.peak * 100).toFixed(1)}% @ ${d.lag}mo` +
  (d.firstMove >= 0 ? ` (first move ${d.firstMove}mo)` : " (never moved)") +
  ` · 50y ${d.endRel >= 0 ? "+" : ""}${(d.endRel * 100).toFixed(1)}%` + (d.thin ? "  [control near zero — ratio unreliable]" : "");
