// THE CENTURY RUNS — the expedition kit.
//
//   node tools/century.mjs                 the whole batch, writes the data
//   SEEDS=3 node tools/century.mjs         a quick pass
//   OUT=/tmp/foo node tools/century.mjs    somewhere else
//
// This is not a test. It runs the city for a hundred years, many times, with
// and without somebody trying to win, and writes down everything that happened
// so the analysis pass can go looking for the good bits.
//
// Two things the engine does that shape the capture. `s.comps` is a rolling
// window capped at MAX_COMPS and `s.news` at 120 — read either at the end of a
// century and you get the cap, not the history. Both are harvested every month.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leaseAtMarket } from "../test/leasepolicy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "..", "test", ".engine.mjs"));
const { makeCity } = await import(join(HERE, "..", "src", "citygen", "index.mjs"));

const MONTHS = Number(process.env.MONTHS ?? 1200);
const OUT = process.env.OUT ?? join(HERE, "..", "..", "century-data");
const CITY = process.env.BW_CITY ?? "somewhere";
const CITY_SEED = Number(process.env.CITY_SEED ?? 20261);
const USES = ["office", "retail", "multifamily", "industrial"];
mkdirSync(OUT, { recursive: true });

const cityCache = new Map();
function city(id, seed) {
  const k = `${id}:${seed}`;
  if (!cityCache.has(k)) {
    const built = makeCity(id, seed);
    E.normalizeParcels(built.parcels);
    cityCache.set(k, { parcels: built.parcels, adjacency: built.adjacency, bbls: Object.keys(built.parcels) });
  }
  return cityCache.get(k);
}

// ---------------------------------------------------------------------------
// THE PLAYERS. Deliberately simple and deliberately different — the point is
// not to find the optimal bot, it is to see what the city does with somebody
// in it. `null` is nobody playing at all.
// ---------------------------------------------------------------------------
const BOTS = {
  none: null,
  allcash: { ltv: 0, want: (r) => r.class !== "land", maxPrice: 0.96, build: false, sellAt: null },
  maxlev: { ltv: 0.80, want: (r) => r.class !== "land", maxPrice: 1.05, build: false, sellAt: null },
  merchant: { ltv: 0, want: (r) => r.class === "land", maxPrice: 1.0, build: true, sellAt: 60 },
  valueadd: { ltv: 0.68, want: (r) => r.class !== "land" && E.initialCondition(r) !== "good", maxPrice: 0.92, build: false, sellAt: 96 },
};

function playMonth(g, parcels, bot, mo) {
  if (!bot) return g;
  // leasing, identical for everyone
  for (const loi of [...g.lois]) {
    const rec = E.resolveRec(parcels, g, loi.bbl), h = g.holdings[loi.bbl];
    if (!rec || !h) continue;
    const ask = E.managedRentPsfYr(rec, g.econ, h, loi.use) * E.staleDiscount(h.darkMs);
    const r = E.respondLOI(g, parcels, loi.id, loi.rentPsf >= ask * 0.92 ? "accept" : "pass");
    if (!r.err) g = r.s;
  }
  for (const h of Object.values(g.holdings)) {
    if (!h.sale?.offer) continue;
    const r = E.acceptSaleOffer(g, parcels, h.bbl);
    if (!r.err) g = r.s;
  }
  const busy = bot.build
    && (Object.keys(g.developments).length > 0
      || Object.values(g.holdings).some((h) => (E.resolveRec(parcels, g, h.bbl)?.class) === "land"
        || (h.sale && (E.resolveRec(parcels, g, h.bbl)?.class) !== "land")));
  if (mo > 2 && !busy) {
    for (const li of [...g.listings].slice(0, 6)) {
      const rec = E.resolveRec(parcels, g, li.bbl);
      if (!rec || g.holdings[li.bbl] || !bot.want(rec, g)) continue;
      const worth = rec.class === "land" ? E.landValue(rec, g.econ) : E.assetValue(rec, g.econ, E.initialCondition(rec));
      if (li.ask > worth * bot.maxPrice) continue;
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, bot.ltv <= 0.01 ? "cash" : "senior",
        false, bot.ltv <= 0.01 ? 1 : bot.ltv / 0.65);
      if (!r.err) { g = r.s; break; }
    }
  }
  if (bot.build && mo > 6) {
    for (const h of Object.values(g.holdings)) {
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class !== "land" || g.developments[h.bbl]) continue;
      let best = null;
      for (const use of ["office", "multifamily", "retail", "industrial"]) {
        const fl = Math.max(1, Math.min(E.maxFloorsFor(rec, 0.6, use), 12));
        const plan = E.planDevelopment(g, parcels, h.bbl, use, fl, 0.6);
        if (!plan || !Number.isFinite(plan.yieldOnCost)) continue;
        const sp = plan.yieldOnCost - plan.exitCap;
        if (!best || sp > best.sp) best = { use, fl, sp };
      }
      if (best && best.sp >= 1.5) {
        const r = E.startDevelopment(g, parcels, h.bbl, best.use, best.fl, 0.6);
        if (!r.err) g = r.s;
      }
      break;
    }
  }
  if (bot.sellAt) {
    for (const h of Object.values(g.holdings)) {
      if (h.sale || g.developments[h.bbl]) continue;
      if (mo - (h.boughtM ?? 0) < bot.sellAt) continue;
      const rec = E.resolveRec(parcels, g, h.bbl);
      if (!rec || rec.class === "land") continue;
      const v = E.holdingValue(rec, g.econ, h, g.month);
      if (!Number.isFinite(v) || v <= 0) break;
      const r = E.listForSale(g, parcels, h.bbl, Math.round(v * 1.02));
      if (!r.err) g = r.s;
      break;
    }
  }
  return g;
}

// ---------------------------------------------------------------------------
function runCentury(marketSeed, botName, cityId = CITY, citySeed = CITY_SEED) {
  const base = city(cityId, citySeed);
  const parcels = JSON.parse(JSON.stringify(base.parcels));
  const bot = BOTS[botName];
  let g = E.firstListings(E.newGame(marketSeed, parcels), parcels, base.bbls);

  const macro = [];                     // one compact row a month
  const trades = [];                    // every deed that moved
  const events = [];                    // demolitions, deliveries, failures, notable news
  const parcelEv = new Map();           // bbl -> [{m, kind, ...}]
  const firmSeen = new Map();           // id -> {name, style, bornM, diedM}
  const firmSeries = [];                // firm table at each quarter-century
  const snapshots = [];                 // per-parcel state at 0/25/50/75/100
  const tenants = new Map();            // key -> {name, bbl, startM, endM, sf, rent} (player only)

  const noteParcel = (bbl, ev) => {
    if (!parcelEv.has(bbl)) parcelEv.set(bbl, []);
    parcelEv.get(bbl).push(ev);
  };

  const snapParcels = (m) => {
    const rows = [];
    for (const b of base.bbls) {
      const r = E.resolveRec(parcels, g, b);
      if (!r) continue;
      const land = E.landValue(r, g.econ);
      const av = r.class === "land" || !r.bldgArea ? land : E.assetValue(r, g.econ, E.initialCondition(r));
      rows.push([b, r.class, Math.round(r.bldgArea || 0), r.floors || 0, r.yearBuilt || 0,
        Math.round(land), Math.round(av), Math.round(r.demandScore ?? 0), r.district, r.address]);
    }
    snapshots.push({ yr: Math.round(m / 12), rows });
  };

  let prevBuilt = {}, prevRivals = new Set(), lastCompM = -1, seenNews = 0;
  snapParcels(0);

  for (let m = 0; m < MONTHS; m++) {
    const before = g;
    g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
    // THE OBSERVER IS A CAMERA, NOT A PARTICIPANT. A null player still carries
    // the firm's overhead and earns the deposit rate on an idle balance, so
    // around year 68 they go insolvent, the creditors take a portfolio they do
    // not have, and advanceQuarter freezes the whole city on gameOver — which
    // is correct for a game and useless for a natural history. Nobody is
    // playing in these runs; hold the empty chair solvent and let the town get
    // on with its century.
    if (!bot) { g.cash = 6_000_000; g.insolventMs = 0; g.gameOver = null; }
    g = playMonth(g, parcels, bot, m);
    const e = g.econ;

    // ---- macro row
    macro.push([
      m, e.phase,
      +e.rentIdx.office.toFixed(1), +e.rentIdx.retail.toFixed(1), +e.rentIdx.multifamily.toFixed(1), +e.rentIdx.industrial.toFixed(1),
      +(e.cityVac.office * 100).toFixed(2), +(e.cityVac.retail * 100).toFixed(2), +(e.cityVac.multifamily * 100).toFixed(2), +(e.cityVac.industrial * 100).toFixed(2),
      +e.capRate.office.toFixed(2), +e.indexRate.toFixed(2), +e.cpi.toFixed(3), +e.wageIdx.toFixed(3),
      e.population, e.jobs, +(e.unemployment * 100).toFixed(2), +(e.creditIdx ?? 1).toFixed(3),
      +e.landIdx.toFixed(3), +e.costIdx.toFixed(3),
      Math.round(USES.reduce((a, u) => a + e.stock[u], 0)),
      Math.round(USES.reduce((a, u) => a + (e.pipeline?.[u] ?? 0), 0)),
      bot ? Math.round(E.netWorth(g, parcels)) : 0,
      bot ? Object.keys(g.holdings).length : 0,
      +(e.nat?.unemp ?? 0).toFixed(4), +(e.nat?.infl ?? 0).toFixed(4), +(e.nat?.policy ?? 0).toFixed(2),
      g.demolished ?? 0, (g.cityBuilt ?? []).length,
    ]);

    // ---- trades, harvested incrementally (s.comps is a capped window)
    //
    // A HIGH-WATER MARK, NOT A COMPARISON AGAINST THE LOOP COUNTER. `g.month`
    // is one ahead of `m`, so `c.m < m` kept every print for two consecutive
    // ticks and every deed in this dataset was recorded exactly twice —
    // 156,209 rows for 78,105 sales, and a most-traded table with all its
    // counts doubled. Track the last month already harvested instead; it
    // cannot double-count whatever the offset turns out to be.
    for (const c of g.comps ?? []) {
      if (c.m <= lastCompM) continue;
      trades.push([c.m, c.bbl, c.cls, c.price, c.sf, +c.psf.toFixed(2), c.capRate,
        c.buyer, c.seller, c.distress ? 1 : 0, c.offMarket ? 1 : 0]);
      noteParcel(c.bbl, { m: c.m, kind: "trade", price: c.price, buyer: c.buyer, seller: c.seller, distress: !!c.distress });
    }
    lastCompM = Math.max(lastCompM, g.month);

    // ---- what got knocked down and what went up (s.built transitions)
    for (const [bbl, b] of Object.entries(g.built)) {
      const p = prevBuilt[bbl];
      const wasLand = !p ? null : (p.class === "land" || !p.bldgArea);
      const isLand = b.class === "land" || !b.bldgArea;
      if (!p && isLand) { noteParcel(bbl, { m, kind: "demolish" }); events.push([m, "demolish", bbl]); }
      else if (!p && !isLand) { noteParcel(bbl, { m, kind: "deliver", cls: b.class, sf: b.bldgArea, fl: b.floors }); events.push([m, "deliver", bbl, b.class, b.bldgArea, b.floors]); }
      else if (p && wasLand && !isLand) { noteParcel(bbl, { m, kind: "deliver", cls: b.class, sf: b.bldgArea, fl: b.floors }); events.push([m, "deliver", bbl, b.class, b.bldgArea, b.floors]); }
      else if (p && !wasLand && isLand) { noteParcel(bbl, { m, kind: "demolish" }); events.push([m, "demolish", bbl]); }
    }
    prevBuilt = JSON.parse(JSON.stringify(g.built));

    // ---- firms born and firms buried
    const live = new Set();
    for (const r of g.rivals ?? []) {
      live.add(r.id);
      if (!firmSeen.has(r.id)) firmSeen.set(r.id, { id: r.id, name: r.name, style: r.style, bornM: r.bornM ?? m, diedM: null, peakAum: 0, peakM: 0 });
      const f = firmSeen.get(r.id);
      const aum = r.aum ?? 0;
      if (aum > f.peakAum) { f.peakAum = aum; f.peakM = m; }
      if ((r.failedM !== undefined || r.dead) && f.diedM === null) {
        f.diedM = m; events.push([m, "firmfail", r.id, r.name, Math.round(f.peakAum), (r.bbls ?? []).length]);
      }
    }
    for (const id of prevRivals) if (!live.has(id)) { const f = firmSeen.get(id); if (f && f.diedM === null) { f.diedM = m; events.push([m, "firmgone", id, f.name, Math.round(f.peakAum), 0]); } }
    prevRivals = live;

    // ---- the player's tenants, for tenure records
    if (bot) {
      for (const h of Object.values(g.holdings)) {
        for (const t of h.tenants ?? []) {
          const key = `${h.bbl}:${t.name}:${t.startM}`;
          const rec = tenants.get(key);
          if (!rec) tenants.set(key, { name: t.name, bbl: h.bbl, sector: t.sector, startM: t.startM, lastM: m, sf: t.sf, rent: t.rentPsf });
          else { rec.lastM = m; rec.rent = t.rentPsf; }
        }
      }
    }

    // ---- news worth keeping
    for (const n of g.news ?? []) {
      if (n.q !== g.month) continue;
      if (n.kind === "warn" || n.kind === "event" || n.kind === "deal") events.push([m, "news", n.kind, n.text.slice(0, 190)]);
    }
    void seenNews; void before;

    if ([300, 600, 900, MONTHS - 1].includes(m)) {
      snapParcels(m);
      firmSeries.push({
        yr: Math.round((m + 1) / 12),
        firms: (g.rivals ?? []).filter((r) => r.failedM === undefined && !r.dead)
          .map((r) => ({ id: r.id, name: r.name, style: r.style, aum: Math.round(r.aum ?? 0), n: (r.bbls ?? []).length, cash: Math.round(r.cash ?? 0), debt: Math.round(r.debt ?? 0), bornM: r.bornM ?? 0 }))
          .sort((a, b) => b.aum - a.aum),
      });
    }
    if (g.gameOver) { events.push([m, "gameover", String(g.gameOver).slice(0, 140)]); break; }
  }

  return {
    meta: { marketSeed, bot: botName, city: cityId, citySeed, months: MONTHS, ended: !!g.gameOver },
    macro, trades, events, snapshots, firmSeries,
    firms: [...firmSeen.values()],
    parcelEv: [...parcelEv.entries()].map(([bbl, ev]) => [bbl, ev]),
    tenants: [...tenants.values()],
    final: bot ? { nw: Math.round(E.netWorth(g, parcels)), cash: Math.round(g.cash), holds: Object.keys(g.holdings).length, delivered: g.delivered ?? 0 } : null,
  };
}

// ---------------------------------------------------------------------------
const MARKET_SEEDS = [550991, 12007, 73303, 11, 22, 33, 4242, 90210, 313, 777,
  2468, 60613, 10001, 94110, 2020, 31337, 8675309, 424242, 133713, 1492, 246, 51423];
const N = Number(process.env.SEEDS ?? MARKET_SEEDS.length);
const PLAN = [];
for (const s of MARKET_SEEDS.slice(0, N)) PLAN.push([s, "none"]);
for (const [i, s] of MARKET_SEEDS.slice(0, Math.min(N, 12)).entries()) {
  PLAN.push([s, ["allcash", "maxlev", "merchant", "valueadd"][i % 4]]);
}

const t0 = Date.now();
const index = [];
for (const [seed, botName] of PLAN) {
  const a = Date.now();
  const out = runCentury(seed, botName);
  const file = `run-${botName}-${seed}.json`;
  writeFileSync(join(OUT, file), JSON.stringify(out));
  index.push({ file, seed, bot: botName, months: out.macro.length, trades: out.trades.length, events: out.events.length, final: out.final, ended: out.meta.ended });
  console.log(`${botName.padEnd(9)} seed ${String(seed).padEnd(8)} ${out.macro.length} months  ${out.trades.length} trades  ${out.events.length} events  ${((Date.now() - a) / 1000).toFixed(1)}s${out.final ? `  NW ${(out.final.nw / 1e6).toFixed(1)}M` : ""}${out.meta.ended ? "  [ENDED EARLY]" : ""}`);
}
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1));
console.log(`\n${PLAN.length} centuries in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min -> ${OUT}`);
