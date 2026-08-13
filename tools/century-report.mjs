// CENTURY REPORT — null-player 100-year runs across market seeds.
//
//   HORIZON=1200 SEEDS=6 node tools/century-report.mjs
//
// Writes a markdown report under /opt/cursor/artifacts (and locally) with
// rents, inflation, land, wages, vacancy, caps, construction, street activity,
// and notable storylines. This is measurement, not a gate.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFreshBundle } from "../test/fresh.mjs";
assertFreshBundle();

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, "../test/.engine.mjs"));
const { makeCity } = await import(join(HERE, "../src/citygen/index.mjs"));

const USES = ["office", "retail", "multifamily", "industrial"];
const LABELS = { office: "Office", retail: "Retail", multifamily: "Multifamily", industrial: "Industrial" };
const YEARS = Number(process.env.YEARS ?? 100);
const HZ = YEARS * 12;
const SEEDS = Number(process.env.SEEDS ?? 6);
const CITY_SEED = Number(process.env.CITY_SEED ?? 20261);
const MARKET_SEEDS = [550991, 12007, 73303, 11, 22, 4242, 90210, 313, 777, 2468].slice(0, SEEDS);
const SNAP_YEARS = [0, 10, 25, 50, 75, 100].filter((y) => y <= YEARS);

const cagr = (a, b, yrs) => (a > 0 && b > 0 && yrs > 0 ? Math.pow(b / a, 1 / yrs) - 1 : NaN);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const money = (n) => Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B`
  : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
  : `$${Math.round(n).toLocaleString()}`;
const med = (a) => {
  const b = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN;
};
const mean = (a) => {
  const b = a.filter(Number.isFinite);
  return b.length ? b.reduce((x, y) => x + y, 0) / b.length : NaN;
};
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : "—";

console.log(`\nCENTURY REPORT — ${SEEDS} seeds × ${YEARS} years · city ${CITY_SEED}\n`);
const t0 = performance.now();

const built = makeCity(process.env.BW_CITY ?? "somewhere", CITY_SEED);
E.normalizeParcels(built.parcels);
const parcels = built.parcels;
const adjacency = built.adjacency;
const bbls = Object.keys(parcels);
console.log(`City: ${bbls.length} parcels\n`);

function snap(g, parcels, extras = {}) {
  const e = g.econ;
  const builtLots = bbls.filter((b) => {
    const r = E.resolveRec(parcels, g, b);
    return r && r.class !== "land" && r.bldgArea > 0;
  });
  const vacantLots = bbls.length - builtLots.length;
  const builtSf = builtLots.reduce((a, b) => a + (E.resolveRec(parcels, g, b)?.bldgArea ?? 0), 0);
  const landPsf = (() => {
    let sum = 0, n = 0;
    for (const b of bbls.slice(0, 400)) {
      const r = parcels[b];
      if (!r) continue;
      sum += E.landValue(r, e) / Math.max(1, r.lotArea);
      n++;
    }
    return n ? sum / n : 0;
  })();
  const rivals = (g.rivals ?? []).filter((r) => r.failedM === undefined);
  const failed = (g.rivals ?? []).filter((r) => r.failedM !== undefined);
  const lendersAlive = (g.lenders ?? []).filter((l) => l.failedM === undefined).length;
  const lendersFailed = (g.lenders ?? []).filter((l) => l.failedM !== undefined).length;
  return {
    year: Math.floor((e.m ?? g.month) / 12),
    month: e.m ?? g.month,
    cpi: e.cpi ?? 1,
    wageIdx: e.wageIdx ?? 1,
    costIdx: e.costIdx ?? 1,
    landIdx: e.landIdx ?? 1,
    landPsf,
    inflExp: e.inflExp ?? 0,
    indexRate: e.indexRate ?? 0,
    creditIdx: e.creditIdx ?? 1,
    population: e.population ?? 0,
    jobs: e.jobs ?? 0,
    unemployment: e.unemployment ?? 0,
    phase: e.phase,
    rent: { ...e.rentIdx },
    effRent: { ...(e.effRentIdx ?? e.rentIdx) },
    vac: { ...(e.cityVac ?? {}) },
    cap: { ...(e.capRate ?? {}) },
    stock: { ...(e.stock ?? {}) },
    occupied: { ...(e.occupied ?? {}) },
    buildings: builtLots.length,
    vacantLots,
    builtSf,
    // Cumulative lifetime prints — not the rolling MAX_COMPS sheet buffer.
    comps: g.compsTotal ?? (g.comps ?? []).length,
    compsSheet: (g.comps ?? []).length,
    compsVolume: g.compsVolume ?? 0,
    listings: (g.listings ?? []).length,
    distressListings: (g.listings ?? []).filter((l) => l.distress).length,
    cityJobs: (g.cityJobs ?? []).filter((j) => !j.orphaned).length,
    orphanedJobs: (g.cityJobs ?? []).filter((j) => j.orphaned).length,
    rivalsAlive: rivals.length,
    rivalsFailed: failed.length,
    rivalAum: rivals.reduce((a, r) => a + (r.aum ?? 0), 0),
    rivalDebt: rivals.reduce((a, r) => a + (r.debt ?? 0), 0),
    lendersAlive,
    lendersFailed,
    ...extras,
  };
}

const runs = [];
for (const ms of MARKET_SEEDS) {
  const seedT0 = performance.now();
  let g = E.firstListings(E.newGame(ms, parcels), parcels, bbls);
  const snaps = new Map();
  snaps.set(0, snap(g, parcels));
  let peakVac = { office: 0, retail: 0, multifamily: 0, industrial: 0 };
  let troughVac = { office: 1, retail: 1, multifamily: 1, industrial: 1 };
  let peakRent = { office: 0, retail: 0, multifamily: 0, industrial: 0 };
  let minCredit = 99, maxCredit = 0;
  let maxRate = 0, minRate = 99;
  let bankFails = 0, rivalFails = 0;
  let maxOrphans = 0;
  let phases = new Map();
  let newsHits = { crash: 0, boom: 0, bank: 0, orphan: 0, appeal: 0 };
  const yearly = [];

  for (let m = 0; m < HZ && !g.gameOver; m++) {
    const beforeFails = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
    const beforeBanks = (g.lenders ?? []).filter((l) => l.failedM !== undefined).length;
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    // Null player: keep the world alive if the unplayed firm somehow dies.
    if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 5_000_000) };

    rivalFails += Math.max(0, (g.rivals ?? []).filter((r) => r.failedM !== undefined).length - beforeFails);
    bankFails += Math.max(0, (g.lenders ?? []).filter((l) => l.failedM !== undefined).length - beforeBanks);

    const e = g.econ;
    for (const u of USES) {
      peakVac[u] = Math.max(peakVac[u], e.cityVac?.[u] ?? 0);
      troughVac[u] = Math.min(troughVac[u], e.cityVac?.[u] ?? 1);
      peakRent[u] = Math.max(peakRent[u], e.rentIdx?.[u] ?? 0);
    }
    minCredit = Math.min(minCredit, e.creditIdx ?? 1);
    maxCredit = Math.max(maxCredit, e.creditIdx ?? 1);
    maxRate = Math.max(maxRate, e.indexRate ?? 0);
    minRate = Math.min(minRate, e.indexRate ?? 0);
    maxOrphans = Math.max(maxOrphans, (g.cityJobs ?? []).filter((j) => j.orphaned).length);
    phases.set(e.phase, (phases.get(e.phase) ?? 0) + 1);

    for (const n of (g.news ?? []).slice(0, 8)) {
      const t = (n.text ?? "").toLowerCase();
      if (t.includes("crash") || t.includes("crisis") || t.includes("seized")) newsHits.crash++;
      if (t.includes("boom") || t.includes("tight") || t.includes("record")) newsHits.boom++;
      if (t.includes("bank") && (t.includes("fail") || t.includes("seiz") || t.includes("receiver"))) newsHits.bank++;
      if (t.includes("stopped work") || t.includes("orphaned") || t.includes("stalled")) newsHits.orphan++;
      if (t.includes("tax appeal")) newsHits.appeal++;
    }

    const yr = Math.floor((m + 1) / 12);
    if ((m + 1) % 12 === 0) {
      const s = snap(g, parcels);
      yearly.push(s);
      if (SNAP_YEARS.includes(yr)) snaps.set(yr, s);
    }
  }
  if (!snaps.has(YEARS)) snaps.set(YEARS, snap(g, parcels));

  const s0 = snaps.get(0);
  const sEnd = snaps.get(YEARS) ?? snap(g, parcels);
  const run = {
    seed: ms,
    snaps,
    yearly,
    peakVac, troughVac, peakRent,
    minCredit, maxCredit, minRate, maxRate,
    bankFails, rivalFails, maxOrphans,
    phases: Object.fromEntries(phases),
    newsHits,
    elapsedMs: performance.now() - seedT0,
    end: sEnd,
    start: s0,
  };
  runs.push(run);
  console.log(
    `seed ${ms}: ${YEARS}y in ${(run.elapsedMs / 1000).toFixed(1)}s · `
    + `CPI ${fmt(sEnd.cpi, 2)}x · office rent $${fmt(sEnd.rent.office, 0)} · `
    + `vac ${pct(sEnd.vac.office)} · rival fails ${rivalFails} · bank fails ${bankFails}`,
  );
}

// ---------- aggregate tables ----------
const atYear = (y, pick) => runs.map((r) => pick(r.snaps.get(y) ?? r.end));
const cagrAcross = (pickStart, pickEnd, yrs) => runs.map((r) => cagr(pickStart(r.start), pickEnd(r.end), yrs));

const md = [];
const push = (...lines) => md.push(...lines);

push(`# Century Report — Broadway & Wall`);
push(``);
push(`Null-player simulations · **${SEEDS} market seeds** × **${YEARS} years** · city seed \`${CITY_SEED}\` (${bbls.length} parcels).`);
push(`Generated ${new Date().toISOString()} · wall time ${((performance.now() - t0) / 1000).toFixed(1)}s.`);
push(``);
push(`## Headline (median across seeds at year ${YEARS})`);
push(``);
push(`| Metric | Y0 (med) | Y100 (med) | Nominal CAGR | Real CAGR |`);
push(`|--------|----------|------------|--------------|-----------|`);
for (const [label, get, , realDef] of [
  ["CPI", (s) => s.cpi, null, null],
  ["Wage index", (s) => s.wageIdx, null, (s) => s.cpi],
  ["Cost index", (s) => s.costIdx, null, (s) => s.cpi],
  ["Land index", (s) => s.landIdx, null, (s) => s.cpi],
  ["Land $/sf", (s) => s.landPsf, null, (s) => s.cpi],
  ["Office rent $/sf", (s) => s.rent.office, null, (s) => s.cpi],
  ["Retail rent $/sf", (s) => s.rent.retail, null, (s) => s.cpi],
  ["MF rent $/sf", (s) => s.rent.multifamily, null, (s) => s.cpi],
  ["Industrial rent $/sf", (s) => s.rent.industrial, null, (s) => s.cpi],
  ["Population", (s) => s.population, null, null],
  ["Jobs", (s) => s.jobs, null, null],
  ["Office stock sf", (s) => s.stock.office, null, null],
  ["Rival AUM", (s) => s.rivalAum, null, (s) => s.cpi],
]) {
  const v0 = med(runs.map((r) => get(r.start)));
  const vN = med(runs.map((r) => get(r.end)));
  const nom = med(runs.map((r) => cagr(get(r.start), get(r.end), YEARS)));
  const real = realDef
    ? med(runs.map((r) => cagr(get(r.start) / realDef(r.start), get(r.end) / realDef(r.end), YEARS)))
    : NaN;
  const show = (v) => {
    if (!Number.isFinite(v)) return "—";
    if (label.includes("AUM") || label.includes("stock")) return money(v);
    if (label.includes("Population") || label.includes("Jobs")) return Math.round(v).toLocaleString();
    if (label.includes("rent") || label.includes("$/sf")) return `$${v.toFixed(1)}`;
    return v.toFixed(2);
  };
  push(`| ${label} | ${show(v0)} | ${show(vN)} | ${pct(nom, 2)} | ${Number.isFinite(real) ? pct(real, 2) : "—"} |`);
}

push(``);
push(`## Path by decade (median across seeds)`);
push(``);
push(`| Year | CPI | Office rent | Real off. rent | Off. vac | Land idx | Credit | Rate | Pop | Jobs | Rival AUM | Trades |`);
push(`|------|-----|-------------|----------------|----------|----------|--------|------|-----|------|-----------|--------|`);
for (const y of SNAP_YEARS) {
  const pick = (fn) => med(runs.map((r) => fn(r.snaps.get(y) ?? r.end)));
  const cpi = pick((s) => s.cpi);
  const rent = pick((s) => s.rent.office);
  const rent0 = med(runs.map((r) => r.start.rent.office));
  const cpi0 = med(runs.map((r) => r.start.cpi));
  const realRent = rent / Math.max(1e-9, cpi) / (rent0 / Math.max(1e-9, cpi0));
  push(
    `| ${y} | ${fmt(cpi, 2)} | $${fmt(rent, 1)} | ${fmt(realRent, 2)}x | ${pct(pick((s) => s.vac.office))} | ${fmt(pick((s) => s.landIdx), 2)} | ${fmt(pick((s) => s.creditIdx), 2)} | ${fmt(pick((s) => s.indexRate), 2)}% | ${Math.round(pick((s) => s.population)).toLocaleString()} | ${Math.round(pick((s) => s.jobs)).toLocaleString()} | ${money(pick((s) => s.rivalAum))} | ${Math.round(pick((s) => s.comps))} |`,
  );
}

push(``);
push(`## Space markets at year ${YEARS}`);
push(``);
push(`| Class | Vac (med) | Peak vac | Trough vac | Cap rate | Stock sf | Occupied | Rent $/sf | Real rent vs Y0 |`);
push(`|-------|-----------|----------|------------|----------|----------|----------|-----------|-----------------|`);
for (const u of USES) {
  const vac = med(runs.map((r) => r.end.vac[u]));
  const peak = med(runs.map((r) => r.peakVac[u]));
  const trough = med(runs.map((r) => r.troughVac[u]));
  const cap = med(runs.map((r) => r.end.cap[u]));
  const stock = med(runs.map((r) => r.end.stock[u]));
  const occ = med(runs.map((r) => r.end.occupied[u]));
  const rent = med(runs.map((r) => r.end.rent[u]));
  const real = med(runs.map((r) => {
    const r0 = r.start.rent[u] / r.start.cpi;
    const rN = r.end.rent[u] / r.end.cpi;
    return rN / Math.max(1e-9, r0);
  }));
  push(`| ${LABELS[u]} | ${pct(vac)} | ${pct(peak)} | ${pct(trough)} | ${fmt(cap, 2)}% | ${money(stock).replace("$", "")} sf | ${money(occ).replace("$", "")} sf | $${fmt(rent, 1)} | ${fmt(real, 2)}x |`);
}

push(``);
push(`## Credit, rates, and failures`);
push(``);
push(`| Seed | Min credit | Max credit | Min rate | Max rate | Rival fails | Bank fails | Max orphan frames | Live jobs @Y100 |`);
push(`|------|------------|------------|----------|----------|-------------|------------|-------------------|-----------------|`);
for (const r of runs) {
  push(`| ${r.seed} | ${fmt(r.minCredit, 2)} | ${fmt(r.maxCredit, 2)} | ${fmt(r.minRate, 2)}% | ${fmt(r.maxRate, 2)}% | ${r.rivalFails} | ${r.bankFails} | ${r.maxOrphans} | ${r.end.cityJobs} |`);
}

push(``);
push(`## Per-seed century outcomes`);
push(``);
push(`| Seed | CPI | Off rent | Real off CAGR | Land idx | Pop | Jobs | Buildings | Trades | Rival AUM |`);
push(`|------|-----|----------|---------------|----------|-----|------|-----------|--------|-----------|`);
for (const r of runs) {
  const realCagr = cagr(r.start.rent.office / r.start.cpi, r.end.rent.office / r.end.cpi, YEARS);
  push(`| ${r.seed} | ${fmt(r.end.cpi, 2)}x | $${fmt(r.end.rent.office, 0)} | ${pct(realCagr, 2)} | ${fmt(r.end.landIdx, 2)} | ${Math.round(r.end.population).toLocaleString()} | ${Math.round(r.end.jobs).toLocaleString()} | ${r.end.buildings} | ${r.end.comps} | ${money(r.end.rivalAum)} |`);
}

push(``);
push(`## Inflation decomposition (office, median)`);
push(``);
{
  const nom = med(runs.map((r) => cagr(r.start.rent.office, r.end.rent.office, YEARS)));
  const cpiC = med(runs.map((r) => cagr(r.start.cpi, r.end.cpi, YEARS)));
  const real = med(runs.map((r) => cagr(r.start.rent.office / r.start.cpi, r.end.rent.office / r.end.cpi, YEARS)));
  const wageReal = med(runs.map((r) => cagr(r.start.wageIdx / r.start.cpi, r.end.wageIdx / r.end.cpi, YEARS)));
  const landReal = med(runs.map((r) => cagr(r.start.landIdx / r.start.cpi, r.end.landIdx / r.end.cpi, YEARS)));
  push(`- Nominal office rent CAGR: **${pct(nom, 2)}**`);
  push(`- CPI CAGR: **${pct(cpiC, 2)}**`);
  push(`- Real office rent CAGR: **${pct(real, 2)}** (nominal − inflation)`);
  push(`- Real wage CAGR: **${pct(wageReal, 2)}**`);
  push(`- Real land-index CAGR: **${pct(landReal, 2)}**`);
  push(`- Cap rates @Y100 (office med): **${fmt(med(runs.map((r) => r.end.cap.office)), 2)}%** (Y0: ${fmt(med(runs.map((r) => r.start.cap.office)), 2)}%)`);
}

push(``);
push(`## Storylines & tidbits`);
push(``);

// Storyline detection
const stories = [];
{
  const vacSpread = runs.map((r) => r.peakVac.office - r.troughVac.office);
  stories.push(`Office vacancy swung **${pct(med(vacSpread))}** peak-to-trough across a typical century (median of seed swings) — cycles are large, not cosmetic.`);

  const hottest = [...runs].sort((a, b) => (b.end.rent.office / b.end.cpi) / (b.start.rent.office / b.start.cpi)
    - (a.end.rent.office / a.end.cpi) / (a.start.rent.office / a.start.cpi))[0];
  const coldest = [...runs].sort((a, b) => (a.end.rent.office / a.end.cpi) / (a.start.rent.office / a.start.cpi)
    - (b.end.rent.office / b.end.cpi) / (b.start.rent.office / b.start.cpi))[0];
  stories.push(`Hottest real-rent century: seed **${hottest.seed}** (real office ${fmt((hottest.end.rent.office / hottest.end.cpi) / (hottest.start.rent.office / hottest.start.cpi), 2)}x). Coldest: seed **${coldest.seed}** (${fmt((coldest.end.rent.office / coldest.end.cpi) / (coldest.start.rent.office / coldest.start.cpi), 2)}x).`);

  const mostFails = [...runs].sort((a, b) => b.rivalFails - a.rivalFails)[0];
  stories.push(`Most rival failures: seed **${mostFails.seed}** with **${mostFails.rivalFails}** firm deaths; bank failures in that world: **${mostFails.bankFails}**.`);

  const orphanKing = [...runs].sort((a, b) => b.maxOrphans - a.maxOrphans)[0];
  if (orphanKing.maxOrphans > 0) {
    stories.push(`Construction stress showed up as orphaned frames — seed **${orphanKing.seed}** peaked at **${orphanKing.maxOrphans}** stalled anonymous jobs (city construction pool binding).`);
  } else {
    stories.push(`No orphaned anonymous frames in these null-player centuries — the construction pool kept merchant builds funded without a player soaking capital.`);
  }

  const tradeMed = med(runs.map((r) => r.end.comps));
  stories.push(`Median closed prints over 100 years: **${Math.round(tradeMed)}** — the street trades without the player.`);

  const popCagr = med(runs.map((r) => cagr(r.start.population, r.end.population, YEARS)));
  const jobCagr = med(runs.map((r) => cagr(r.start.jobs, r.end.jobs, YEARS)));
  stories.push(`City scale: population CAGR **${pct(popCagr, 2)}**, jobs CAGR **${pct(jobCagr, 2)}**.`);

  // Decade that hurt most: largest real rent decline over any 10y window
  let worstDecade = null;
  for (const r of runs) {
    for (let i = 0; i + 10 < r.yearly.length; i++) {
      const a = r.yearly[i], b = r.yearly[i + 10];
      const realA = a.rent.office / a.cpi, realB = b.rent.office / b.cpi;
      const ch = realB / realA - 1;
      if (!worstDecade || ch < worstDecade.ch) worstDecade = { seed: r.seed, from: a.year, to: b.year, ch, vac: b.vac.office };
    }
  }
  if (worstDecade) {
    stories.push(`Worst real-office decade: seed **${worstDecade.seed}**, years **${worstDecade.from}–${worstDecade.to}**, real rents **${pct(worstDecade.ch, 1)}** (vacancy then ${pct(worstDecade.vac)}).`);
  }

  let bestDecade = null;
  for (const r of runs) {
    for (let i = 0; i + 10 < r.yearly.length; i++) {
      const a = r.yearly[i], b = r.yearly[i + 10];
      const realA = a.rent.office / a.cpi, realB = b.rent.office / b.cpi;
      const ch = realB / realA - 1;
      if (!bestDecade || ch > bestDecade.ch) bestDecade = { seed: r.seed, from: a.year, to: b.year, ch, vac: b.vac.office };
    }
  }
  if (bestDecade) {
    stories.push(`Best real-office decade: seed **${bestDecade.seed}**, years **${bestDecade.from}–${bestDecade.to}**, real rents **${pct(bestDecade.ch, 1)}** (vacancy ${pct(bestDecade.vac)}).`);
  }

  // Industrial vs office real rent divergence
  const indVsOff = med(runs.map((r) => {
    const off = (r.end.rent.office / r.end.cpi) / (r.start.rent.office / r.start.cpi);
    const ind = (r.end.rent.industrial / r.end.cpi) / (r.start.rent.industrial / r.start.cpi);
    return ind / off;
  }));
  stories.push(`Industrial vs office real-rent growth ratio (end/start): **${fmt(indVsOff, 2)}x** — values >1 mean sheds outran towers in real terms.`);

  const mfVac = med(runs.map((r) => r.end.vac.multifamily));
  const offVac = med(runs.map((r) => r.end.vac.office));
  stories.push(`End-state vacancy: office **${pct(offVac)}** vs multifamily **${pct(mfVac)}**.`);

  const aumEnd = med(runs.map((r) => r.end.rivalAum / r.end.cpi));
  stories.push(`Rival AUM at Y100 is **${money(med(runs.map((r) => r.end.rivalAum)))}** nominal (≈${money(aumEnd)} in Y0 dollars, median) — the street compounds without you. (Opening AUM is ~$0 before the roster books assets, so CAGR is not meaningful.)`);
  const sheetMed = med(runs.map((r) => r.end.compsSheet ?? Math.min(240, r.end.comps)));
  if (Number.isFinite(tradeMed) && tradeMed > 240.5) {
    stories.push(`Comps sheet keeps a rolling **${Math.round(sheetMed)}**-print window; cumulative century volume is **${Math.round(tradeMed)}** median (no longer clipped by \`MAX_COMPS\`).`);
  } else {
    stories.push(`Comps ledger reports cumulative closed prints (sheet buffer still rolls at \`MAX_COMPS\`).`);
  }
  const landPinned = runs.filter((r) => r.end.landIdx >= 79.99).length;
  if (landPinned) {
    stories.push(`Land index hit its hard rail (**80**) in **${landPinned}/${runs.length}** seeds by Y100 — late-century land growth is mechanically clipped (\`market.ts\` clamp).`);
  } else {
    const landHi = med(runs.map((r) => r.end.landIdx));
    stories.push(`Land index ends at **${fmt(landHi, 2)}** median — residual is rent/cost (degree 0 under pure CPI), so ordinary inflation no longer drives the rail.`);
  }
  const vacFloorish = med(runs.map((r) => r.end.vac.office));
  if (vacFloorish < 0.045) {
    stories.push(`Office vacancy ends at the frictional floor in the median seed (**${pct(vacFloorish)}**) — late centuries still look tight when stock cannot clear the employment path.`);
  } else {
    stories.push(`Office vacancy ends at **${pct(vacFloorish)}** median — not glued to the frictional floor across the board.`);
  }
}

for (const s of stories) push(`- ${s}`);

push(``);
push(`## Method`);
push(``);
push(`- Engine: null player (\`newGame\` + \`advanceMonth\`), no strategy bot.`);
push(`- Same city geometry for every market seed; market seed drives RNG streams.`);
push(`- Real series = nominal / CPI.`);
push(`- Land $/sf is a 400-parcel sample mean of \`landValue / lotArea\`.`);
push(`- If you re-run: \`YEARS=100 SEEDS=6 CITY_SEED=20261 node tools/century-report.mjs\`.`);
push(``);

const text = md.join("\n");
// Null-player measurement only — do not overwrite the narrative CENTURY_REPORT.md.
const localOut = join(HERE, "..", "CENTURY_NULLS_100Y.md");
writeFileSync(localOut, text);
try {
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  writeFileSync("/opt/cursor/artifacts/CENTURY_NULLS_100Y.md", text);
} catch { /* optional */ }

console.log(`\nWrote ${localOut}`);
console.log(`Total ${(performance.now() - t0) / 1000}s\n`);
console.log(text);
