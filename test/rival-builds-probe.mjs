// Observer probe: how many buildings do rival firms build, and how big?
//
//   pnpm engine && SEEDS=6 HORIZON=600 node test/rival-builds-probe.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

const SEEDS = (process.env.SEEDS ?? "12007,550991,4242,777,91,44101")
  .split(",").map(Number).filter(Number.isFinite);
const MONTHS = Number(process.env.HORIZON ?? 600); // 50 years

const bucket = (sf) => {
  if (sf < 15_000) return "<15k";
  if (sf < 40_000) return "15–40k";
  if (sf < 80_000) return "40–80k";
  if (sf < 150_000) return "80–150k";
  if (sf < 300_000) return "150–300k";
  return "300k+";
};

function run(seed) {
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const seen = new Map(); // bbl -> delivery record
  const starts = [];

  for (let m = 0; m < MONTHS; m++) {
    // Snapshot live rival jobs before the tick (starts show up mid-month).
    const beforeJobs = new Set((g.cityJobs ?? []).filter((j) => j.firmId).map((j) => j.bbl));
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 8e6) };

    for (const j of g.cityJobs ?? []) {
      if (!j.firmId || beforeJobs.has(j.bbl) || starts.some((x) => x.bbl === j.bbl && x.seed === seed)) continue;
      const r = (g.rivals ?? []).find((x) => x.id === j.firmId);
      starts.push({
        seed, bbl: j.bbl, firmId: j.firmId, firm: r?.name ?? j.firmId,
        style: r?.style ?? "?", use: j.use, sf: j.sf, floors: j.floors,
        startM: j.startM, deliverM: j.deliverM,
      });
    }

    for (const r of g.rivals ?? []) {
      for (const [bbl, dm] of Object.entries(r.deliveredM ?? {})) {
        if (seen.has(bbl)) continue;
        const rec = E.resolveRec(parcels, g, bbl);
        const built = g.built?.[bbl];
        const sf = built?.bldgArea || rec?.bldgArea || 0;
        const floors = built?.floors || rec?.floors || 0;
        const use = built?.class || rec?.class || "?";
        seen.set(bbl, {
          seed, bbl, firmId: r.id, firm: r.name, style: r.style,
          month: dm, year: 2000 + Math.floor(dm / 12),
          sf, floors, use, address: rec?.address ?? bbl,
        });
      }
    }
  }

  // Anonymous city deliveries over the window: jobs that finished without firmId
  // are harder to catch after the fact — count supply projects / stock growth
  // via rival vs anonymous starts still live or recorded above.
  const anonLive = (g.cityJobs ?? []).filter((j) => !j.firmId && !j.orphaned && !j.groundLease);
  const rivalLive = (g.cityJobs ?? []).filter((j) => j.firmId && !j.orphaned);

  return {
    seed,
    delivered: [...seen.values()].filter((d) => d.seed === seed),
    starts: starts.filter((s) => s.seed === seed),
    rivalsEnd: (g.rivals ?? []).map((r) => ({
      name: r.name, style: r.style,
      delivered: Object.keys(r.deliveredM ?? {}).length,
      owned: r.bbls?.length ?? 0,
      liveJobs: (g.cityJobs ?? []).filter((j) => j.firmId === r.id && !j.orphaned).length,
    })),
    anonLive: anonLive.length,
    rivalLive: rivalLive.length,
    month: g.month,
  };
}

const rows = [];
for (const seed of SEEDS) {
  process.stderr.write(`seed ${seed}…\n`);
  rows.push(run(seed));
}

const allDel = rows.flatMap((r) => r.delivered);
const allStarts = rows.flatMap((r) => r.starts);
const yrs = MONTHS / 12;

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
const med = (a) => {
  const b = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  if (!b.length) return NaN;
  return b[Math.floor((b.length - 1) / 2)];
};
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

console.log(`\nRIVAL BUILD PIPELINE — ${SEEDS.length} seeds × ${yrs} years (passive observer)\n`);
console.log(`Seeds: ${SEEDS.join(", ")}`);
console.log(`Rival deliveries (opened): ${allDel.length}  ·  ${(allDel.length / SEEDS.length).toFixed(1)} per city`);
console.log(`Rival groundbreaks tracked: ${allStarts.length}  ·  ${(allStarts.length / SEEDS.length).toFixed(1)} per city`);
console.log(`Still in ground at horizon — rival jobs: ${rows.reduce((a, r) => a + r.rivalLive, 0) / SEEDS.length | 0} avg · anon: ${rows.reduce((a, r) => a + r.anonLive, 0) / SEEDS.length | 0} avg`);

console.log("\n— Per seed —");
for (const r of rows) {
  const sfs = r.delivered.map((d) => d.sf);
  console.log(
    `  seed ${r.seed}: ${r.delivered.length} delivered, ${r.starts.length} starts`
    + (sfs.length
      ? ` · median ${Math.round(med(sfs)).toLocaleString()} sf · mean ${Math.round(mean(sfs)).toLocaleString()} sf`
      : " · (none opened)"),
  );
}

console.log("\n— Size of delivered rival buildings —");
const buckets = ["<15k", "15–40k", "40–80k", "80–150k", "150–300k", "300k+"];
const byBucket = Object.fromEntries(buckets.map((k) => [k, 0]));
for (const d of allDel) byBucket[bucket(d.sf)]++;
for (const k of buckets) {
  const n = byBucket[k];
  console.log(`  ${k.padEnd(10)} ${String(n).padStart(4)}  ${pct(n, allDel.length).padStart(4)}  ${"█".repeat(Math.round((n / Math.max(1, allDel.length)) * 40))}`);
}
if (allDel.length) {
  const sfs = allDel.map((d) => d.sf);
  const fl = allDel.map((d) => d.floors).filter((x) => x > 0);
  console.log(`  median ${Math.round(med(sfs)).toLocaleString()} sf · p25 ${Math.round(med(sfs.filter((x) => x <= med(sfs)))).toLocaleString()} · mean ${Math.round(mean(sfs)).toLocaleString()} · max ${Math.max(...sfs).toLocaleString()}`);
  if (fl.length) console.log(`  floors: median ${med(fl).toFixed(0)} · mean ${mean(fl).toFixed(1)} · max ${Math.max(...fl)}`);
}

console.log("\n— By use (delivered) —");
const byUse = {};
for (const d of allDel) byUse[d.use] = (byUse[d.use] ?? 0) + 1;
for (const [u, n] of Object.entries(byUse).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${u.padEnd(14)} ${String(n).padStart(4)}  ${pct(n, allDel.length)}`);
}

console.log("\n— By rival style (delivered) —");
const byStyle = {};
for (const d of allDel) {
  byStyle[d.style] ??= { n: 0, sf: [] };
  byStyle[d.style].n++;
  byStyle[d.style].sf.push(d.sf);
}
for (const [st, v] of Object.entries(byStyle).sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `  ${st.padEnd(14)} ${String(v.n).padStart(4)} buildings  median ${Math.round(med(v.sf)).toLocaleString()} sf  mean ${Math.round(mean(v.sf)).toLocaleString()} sf`,
  );
}

console.log("\n— Busiest rival firms (delivered, across seeds) —");
const byFirm = {};
for (const d of allDel) {
  const k = `${d.firm} (${d.style})`;
  byFirm[k] ??= { n: 0, sf: [], seeds: new Set() };
  byFirm[k].n++;
  byFirm[k].sf.push(d.sf);
  byFirm[k].seeds.add(d.seed);
}
const top = Object.entries(byFirm).sort((a, b) => b[1].n - a[1].n).slice(0, 12);
for (const [name, v] of top) {
  console.log(
    `  ${v.n}×  ${name}  · med ${Math.round(med(v.sf)).toLocaleString()} sf · across ${v.seeds.size} seed(s)`,
  );
}

console.log("\n— Starts that have not yet delivered (still in pipeline or failed) —");
const opened = new Set(allDel.map((d) => `${d.seed}:${d.bbl}`));
const unfinished = allStarts.filter((s) => !opened.has(`${s.seed}:${s.bbl}`));
console.log(`  ${unfinished.length} rival starts without a delivery stamp by year ${2000 + yrs}`);
if (unfinished.length) {
  const sfs = unfinished.map((s) => s.sf);
  console.log(`  those starts: median ${Math.round(med(sfs)).toLocaleString()} sf · mean ${Math.round(mean(sfs)).toLocaleString()} sf`);
}

console.log("\n— Sample deliveries —");
for (const d of allDel.slice(0, 15)) {
  console.log(
    `  ${d.year}  ${d.sf.toLocaleString().padStart(8)} sf / ${String(d.floors).padStart(2)} fl  ${String(d.use).padEnd(12)}  ${d.firm} (${d.style})  · ${d.address}`,
  );
}
if (allDel.length > 15) console.log(`  … +${allDel.length - 15} more`);
