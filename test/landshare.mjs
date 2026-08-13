// IS THE DIRT WORTH A SENSIBLE SHARE OF THE PROPERTY?
//
//   node test/landshare.mjs
//
// A ratio like "this lot is 96x its opening price" is not evidence on its own:
// a residual that starts near zero has unbounded upside in ratio terms and that
// is arithmetic, not a fault. The question that decides whether land is
// mispriced is the LEVEL — what fraction of a property's total value is the
// ground under it, and what does an acre actually cost.
//
// The real anchors. Across US metros land is roughly 30-50% of the value of
// improved commercial property; in prime CBD locations 60-80%; on cheap fringe
// industrial ground 10-20%. A land share pinned near 100% means the model
// believes the building is worth nothing, which happens in life only where the
// building genuinely is a teardown. If most of the city reads that way, the
// residual has run away.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11").split(",").map(Number);
const YRS = Number(process.env.YRS ?? 60);
const MARKS = [0, 10, 20, 30, 40, 50, 60, 80, 100].filter((y) => y <= YRS);

const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN; };
const rows = new Map();   // year -> samples

for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  // A fixed sample of BUILT lots, held for the whole run, so the population
  // does not change under the measurement.
  const sample = bbls.filter((b) => {
    const r = parcels[b];
    return r && r.class !== "land" && r.bldgArea > 0;
  }).filter((_, i) => i % 7 === 0);

  for (let m = 0; m <= YRS * 12; m++) {
    const yr = m / 12;
    if (MARKS.includes(yr)) {
      const e = g.econ, cpi = e.cpi || 1;
      const share = [], psf = [], acre = [];
      for (const b of sample) {
        const rec = E.resolveRec(parcels, g, b);
        if (!rec || !rec.lotArea) continue;
        const land = E.landValue(rec, e);
        const total = E.assetValue(rec, e, E.initialCondition(rec));
        if (!(total > 0) || !Number.isFinite(land)) continue;
        share.push(Math.min(2, land / total));
        psf.push(E.landPsfNow(rec, e) / cpi);
        acre.push((E.landPsfNow(rec, e) / cpi) * 43560);
      }
      if (!rows.has(yr)) rows.set(yr, { share: [], psf: [], acre: [], over: 0, n: 0 });
      const r = rows.get(yr);
      r.share.push(...share); r.psf.push(...psf); r.acre.push(...acre);
      r.over += share.filter((x) => x >= 1).length; r.n += share.length;
    }
    if (m === YRS * 12) break;
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
}

console.log(`land as a share of improved value, and the real price of an acre — ${SEEDS.length} seeds\n`);
console.log("year   land/total  p10    p50    p90     |  real $/sf land  p50      p90    |  land >= total");
for (const yr of MARKS) {
  const r = rows.get(yr); if (!r) continue;
  const pc = (v) => (v * 100).toFixed(0) + "%";
  console.log(
    String(yr).padStart(4) + "        " +
    pc(q(r.share, 0.1)).padStart(6) + pc(q(r.share, 0.5)).padStart(7) + pc(q(r.share, 0.9)).padStart(7) + "     |" +
    ("$" + q(r.psf, 0.5).toFixed(2)).padStart(14) + ("$" + q(r.psf, 0.9).toFixed(2)).padStart(10) + "    |" +
    pc(r.over / Math.max(1, r.n)).padStart(9),
  );
}
console.log(`\nanchors: US metros land is ~30-50% of improved commercial value, 60-80% prime CBD,`);
console.log(`10-20% cheap fringe. A share at or above 100% says the building is worth nothing.`);
