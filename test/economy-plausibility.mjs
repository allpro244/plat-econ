// CHEAP MULTI-SEED PLAUSIBILITY BANDS — vacancy, rents, jobs, trades, defaults.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

const HZ = Number(process.env.HZ ?? 120);
const SEEDS = Number(process.env.SEEDS ?? 3);

console.log(`\nECONOMY PLAUSIBILITY — ${SEEDS} seeds × ${HZ} months\n`);

for (let i = 0; i < SEEDS; i++) {
  const { parcels, adjacency, bbls, seed } = loadCity(i, E.normalizeParcels);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  let trades = 0;
  let defaults = 0;
  let vacSum = 0;
  let vacN = 0;
  for (let m = 0; m < HZ && !g.gameOver; m++) {
    const beforeComps = (g.comps ?? []).length;
    const beforeFails = (g.rivals ?? []).filter((r) => r.failedM !== undefined).length;
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    trades += Math.max(0, (g.comps ?? []).length - beforeComps);
    defaults += Math.max(0, (g.rivals ?? []).filter((r) => r.failedM !== undefined).length - beforeFails);
    const v = g.econ.cityVac?.office;
    if (Number.isFinite(v)) { vacSum += v; vacN++; }
  }
  const avgVac = vacN ? vacSum / vacN : 0;
  const rent = g.econ.rentIdx.office;
  const jobs = g.econ.jobs ?? 0;
  console.log(`  seed ${seed}: vac ${(avgVac * 100).toFixed(1)}% · rent $${rent.toFixed(1)} · jobs ${Math.round(jobs / 1000)}k · trades ${trades} · rival fails ${defaults}`);
  check(avgVac > 0.02 && avgVac < 0.35, `seed ${seed}: office vacancy in 2–35% band`);
  check(rent > 10 && rent < 200, `seed ${seed}: office asking rent in plausible band`);
  check(jobs > 5_000, `seed ${seed}: employment still exists`);
  check(trades >= 1, `seed ${seed}: at least one print in ${HZ} months`);
}

console.log("");
process.exit(bad ? 1 : 0);
