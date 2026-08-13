// NAMED FIRMS ACTUALLY BUILD.
//
// The street was claiming ~3% of city jobs and opening ~1 delivery per fifty
// years. Builders opened with zero vacant lots. This harness locks the fix:
// land banks at init, and a real named share of the pipeline.
//
//   pnpm engine && node test/rival-builders.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

let fails = 0;
const ok = (name, pass, detail) => {
  console.log(`  ${pass ? "OK   " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) fails++;
};

console.log("\nRIVAL BUILDERS — land banks and pipeline share\n");

// 1. Opening roster: developer/merchant firms hold vacant dirt.
{
  const g = E.firstListings(E.newGame(12007, parcels), parcels, bbls);
  const builders = (g.rivals ?? []).filter((r) => r.style === "developer" || r.style === "merchant");
  let withLand = 0;
  let totalLand = 0;
  for (const r of builders) {
    let land = 0;
    for (const bbl of r.bbls) {
      const rec = E.resolveRec(parcels, g, bbl);
      if (rec && (rec.class === "land" || !rec.bldgArea)) land++;
    }
    if (land > 0) withLand++;
    totalLand += land;
  }
  ok("builder-style firms exist on the opening roster", builders.length >= 3, `${builders.length} builders`);
  ok("most builders open with a land bank", withLand >= Math.ceil(builders.length * 0.5),
    `${withLand}/${builders.length} have vacant lots (${totalLand} lots)`);
}

// 2. Over 25 years, named firms claim a material share of groundbreaks.
{
  const SEEDS = [12007, 550991, 4242];
  const MONTHS = 300;
  let rivalStarts = 0, anonStarts = 0, deliveries = 0;
  for (const seed of SEEDS) {
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    const seen = new Set();
    const seenDel = new Set();
    for (let m = 0; m < MONTHS; m++) {
      const before = new Set((g.cityJobs ?? []).map((j) => j.bbl));
      g = E.advanceMonth(g, parcels, bbls, adjacency);
      if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 8e6) };
      for (const j of g.cityJobs ?? []) {
        if (before.has(j.bbl) || seen.has(j.bbl) || j.groundLease) continue;
        seen.add(j.bbl);
        if (j.firmId) rivalStarts++;
        else anonStarts++;
      }
      for (const r of g.rivals ?? []) {
        for (const bbl of Object.keys(r.deliveredM ?? {})) {
          if (seenDel.has(bbl)) continue;
          seenDel.add(bbl);
          deliveries++;
        }
      }
    }
  }
  const total = rivalStarts + anonStarts;
  const share = total ? rivalStarts / total : 0;
  ok("named firms claim a real share of groundbreaks (≥10%)",
    share >= 0.10 && rivalStarts >= 12,
    `${rivalStarts} rival / ${anonStarts} anon = ${(share * 100).toFixed(1)}% across ${SEEDS.length}×25yr`);
  ok("named firms deliver multiple buildings (≥10 across three 25yr runs)",
    deliveries >= 10, `${deliveries} deliveries`);
}

console.log(`\n${fails === 0 ? "rival-builders pass" : `${fails} rival-builders failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
