// HOW LONG DOES AN EMPTY BUILDING TAKE TO FILL?
//
// The one number that says whether leasing is a decision or a formality. Buy a
// handful of buildings, sign every letter of intent that arrives — so the only
// thing being measured is how many prospects come to the table at all — and
// count the months to eighty-five per cent leased.
//
//   pnpm leaseup            four seeds
//   SEEDS=8 pnpm leaseup
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);
const CITY = process.env.BW_CITY ?? "somewhere";

const SEEDS = Number(process.env.SEEDS ?? 4);
const HORIZON = Number(process.env.HORIZON ?? 240);
const rows = [];

for (let seed = 0; seed < SEEDS; seed++) {
  let g = E.firstListings(E.newGame(7000 + seed * 37, parcels), parcels, bbls);
  g = { ...g, cash: 800_000_000 };
  // COMMERCIAL ONLY. Flats do not have a rent roll in this model — they run on
  // aggregate occupancy — so measuring `tenants` on an apartment block measures
  // nothing, which is what the first cut of this harness did.
  const cands = bbls.filter((b) => {
    const r = E.resolveRec(parcels, g, b);
    return r && r.class !== "land" && r.bldgArea > 25_000 && E.isCommercial(r);
  });
  let errs = 0;
  for (let i = 0; i < cands.length && Object.keys(g.holdings).length < 8; i += 11) {
    const b = cands[i];
    const rec = E.resolveRec(parcels, g, b);
    const px = Math.round(E.assetValue(rec, g.econ, E.initialCondition(rec)));
    const r = E.executePurchase(g, parcels, b, px, "cash", false, 1);
    if (!r.err) g = r.s; else { errs++; if (errs < 3) console.log("  skip:", r.err); }
    // A BOUGHT BUILDING COMES WITH ITS ROLL — which is correct, and is not what
    // this harness is for. Empty it, so what gets measured is the thing a
    // developer actually lives through: a finished building with nobody in it.
    if (g.holdings[b]) { g.holdings[b].tenants = []; g.holdings[b].occ = 0; }
  }
  const owned = Object.keys(g.holdings);
  const startM = g.month;
  const hit = {};
  for (let m = 0; m < HORIZON; m++) {
    for (const loi of [...g.lois]) {
      const r = E.respondLOI(g, parcels, loi.id, "accept", true);
      if (!r.err) g = r.s;
    }
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    for (const b of owned) {
      if (hit[b] !== undefined) continue;
      const rec = E.resolveRec(parcels, g, b), h = g.holdings[b];
      if (!rec || !h) { hit[b] = null; continue; }
      const u = E.unitStatus(rec, h, g.month);
      if (u.total > 0 && u.leased / u.total >= 0.85) hit[b] = g.month - startM;
    }
  }
  for (const b of owned) rows.push({ m: hit[b] ?? null, use: E.dominantUse(E.resolveRec(parcels, g, b)) });
}

console.log(`${rows.length} buildings bought empty across ${SEEDS} seeds, every LOI signed on sight`);
const report = (label, set) => {
  const done = set.filter((x) => x.m !== null).map((x) => x.m).sort((a, b) => a - b);
  const q = (f) => done[Math.min(done.length - 1, Math.floor(done.length * f))];
  if (!set.length) return;
  console.log(`  ${label.padEnd(12)} n=${String(set.length).padStart(3)} · months to 85% let: `
    + (done.length ? `min ${done[0]} · p25 ${q(0.25)} · MEDIAN ${q(0.5)} · p75 ${q(0.75)} · max ${done[done.length - 1]}` : "—")
    + ` · still empty after ${(HORIZON / 12).toFixed(0)}yr: ${set.length - done.length}`);
};
report("all", rows);
for (const u of ["office", "retail", "industrial", "multifamily"]) report(u, rows.filter((r) => r.use === u));
