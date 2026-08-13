// CITY CLASS → RENT LEVEL.
//
//   pnpm cityclass
//
// Procedural islands are secondary markets as a rule of thumb. Opening office
// and year-50 real office should read as harbour / working-city money on
// Landing–Village fabric, and only Metropolis should sit in upper-secondary /
// primary-lite territory. This reports the ladder; it does not gate.
//
// Bands are judgments against observed secondary Class A (Providence ~$27–34
// ordinary) and the density elasticities already in market.ts — not targets
// the engine was hill-climbed to.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { makeCity, PROCEDURAL, DEVELOPMENT } = await import(join(ROOT, "src/citygen/index.mjs"));

const SEEDS = (process.env.SEEDS ?? "20261,550991,12007").split(",").map(Number);
const YEARS = +(process.env.YEARS ?? 50);
const TIERS = (process.env.TIERS ?? "landing,frontier,village,harbour,metropolis").split(",");

/** Intended day-one citywide office index bands (nominal = real at open). */
const OPEN_BAND = {
  landing:    [18, 32],
  frontier:   [22, 36],
  village:    [24, 40],
  harbour:    [28, 48],
  // Density × era can open a touch under the raw table; metro still leads the ladder.
  metropolis: [30, 55],
};
/** Year-50 REAL citywide office — secondary rule of thumb; metro may run hotter. */
const Y50_REAL_BAND = {
  landing:    [20, 55],
  frontier:   [22, 65],
  village:    [22, 75],
  harbour:    [35, 95],
  metropolis: [45, 120],
};

function pad(s, n) { return String(s).padEnd(n); }
function inBand(v, [lo, hi]) { return v >= lo && v <= hi; }

const rows = [];
for (const dens of TIERS) {
  for (const seed of SEEDS) {
    const city = makeCity(PROCEDURAL, seed, { density: dens, size: "standard" });
    const parcels = E.normalizeParcels(city.parcels);
    const bbls = Object.keys(parcels);
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    const open = g.econ.rentIdx.office;
    const far = E.cityFloorIntensity(parcels);
    const classF = E.cityClassFactor(g.econ.cityIntensity ?? far / E.REF_CITY_FAR);
    for (let m = 0; m < YEARS * 12; m++) {
      g = E.advanceQuarter(g, parcels, bbls, city.adjacency);
      if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    }
    const real = g.econ.rentIdx.office / g.econ.cpi;
    rows.push({
      dens, seed, far: +far.toFixed(2), classF: +classF.toFixed(2),
      open: +open.toFixed(1), y50real: +real.toFixed(1),
      vac: +((g.econ.cityVac.office) * 100).toFixed(1),
      pop: g.econ.population,
      openOk: inBand(open, OPEN_BAND[dens] ?? [0, 999]),
      y50Ok: inBand(real, Y50_REAL_BAND[dens] ?? [0, 999]),
    });
  }
}

console.log(`\nCITY CLASS RENTS — procedural islands × ${YEARS}y (secondary rule of thumb)\n`);
console.log(`  ${pad("tier", 12)}${pad("seed", 8)}${pad("FAR", 6)}${pad("classF", 8)}${pad("open$", 8)}${pad("y50 real$", 10)}${pad("vac", 6)}pop   open  y50`);
let bad = 0;
for (const r of rows) {
  if (!r.openOk || !r.y50Ok) bad++;
  console.log(
    `  ${pad(r.dens, 12)}${pad(r.seed, 8)}${pad(r.far.toFixed(2), 6)}${pad(r.classF.toFixed(2), 8)}` +
    `${pad(r.open.toFixed(1), 8)}${pad(r.y50real.toFixed(1), 10)}${pad(r.vac.toFixed(1) + "%", 6)}` +
    `${String(r.pop).padStart(6)}  ${r.openOk ? "OK" : "OUT"}  ${r.y50Ok ? "OK" : "OUT"}`,
  );
}

const byTier = (t) => rows.filter((r) => r.dens === t);
console.log("\n  median open / y50-real by tier:");
for (const t of TIERS) {
  const rs = byTier(t);
  if (!rs.length) continue;
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const o = med(rs.map((r) => r.open));
  const y = med(rs.map((r) => r.y50real));
  const [olo, ohi] = OPEN_BAND[t] ?? ["?", "?"];
  const [ylo, yhi] = Y50_REAL_BAND[t] ?? ["?", "?"];
  console.log(`    ${pad(t, 12)} open $${o.toFixed(1)} (want ${olo}–${ohi})   y${YEARS} real $${y.toFixed(1)} (want ${ylo}–${yhi})`);
}

console.log(`\n  ${bad === 0 ? "OK" : "NOTE"}  ${rows.length - bad}/${rows.length} seed×tier cells inside bands (report, not gate)`);
console.log("  Development ladder:", DEVELOPMENT.filter((d) => TIERS.includes(d.id)).map((d) => d.name).join(" · "));
console.log("");
process.exit(0);
