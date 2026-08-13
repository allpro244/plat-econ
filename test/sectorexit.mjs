// DOES THE SECTOR-EXIT RATCHET FIRE ON SHORTAGES?
//
//   pnpm sectorexit                                twelve seeds, fifty years
//   ENGINE=test/.engine-base.mjs pnpm sectorexit   the other arm of an A/B
//
// The ratchet in market.ts sheds a sector's base demand when its rent-to-income
// burden runs a fifth above where it started:
//
//     burden = (rentIdx[k] / RENT_BASE[k]) / wageIdx
//     if (burden > 1.20) baseStock[k] *= 1 - (1/8 * min(1, over*0.80)) / 12
//
// That is a PRICE signal and nothing else. But high rent has two opposite
// causes and they are distinguished by exactly one observable:
//
//   priced out  — firms leave, hand space back, and vacancy RISES
//   starved     — firms want more and cannot get it, vacancy sits on its FLOOR
//
// The ratchet cannot tell them apart, and `useForZone` in dev.ts then converts
// M-zoned land to housing in proportion to `gone(industrial) = 1 - baseStock /
// baseStock0` — one way, never back. If the ratchet is firing on shortages the
// loop is: shortage -> rent up -> ratchet -> less land for the starved use ->
// deeper shortage. Industrial is pinned at its vacancy floor 33.4% of months
// and is the only class whose stock shrinks over fifty years, which is what
// that loop would look like from outside.
//
// This asks the one question that settles it: WHEN THE RATCHET FIRES, WHAT IS
// VACANCY DOING? Measured before the fix, it was below natural on 91.3% of
// office firings, 84.7% of retail and 93.4% of industrial — so nine times in
// ten the mechanism was modelling a shortage and calling it an exodus. Exit is
// now net of the queue: a departure another firm is waiting to backfill is a
// tenant swap, not a sector leaving, and you cannot have a waiting list and an
// exodus at once. The "%months firing" column below still counts the RAW price
// trigger, so the gap between it and what `gone` reaches is the fix working.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = Number(process.env.N ?? 12);
const HZ = Number(process.env.HZ ?? 600);
const CLASSES = ["office", "retail", "industrial"];   // multifamily is exempt
const FRICTION_RATIO = { office: 0.32, retail: 0.32, multifamily: 0.30, industrial: 0.22 };
const SEEDS = Array.from({ length: N }, (_, i) => (2166136261 ^ ((i + 1) * 2654435761)) >>> 0 % 1e6);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
const pct = (x) => (x * 100).toFixed(1) + "%";
const f = (x, n = 2) => x.toFixed(n);

const runs = [];
for (const [i, seed] of SEEDS.entries()) {
  const { parcels: P0, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const s = [];
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;
    const row = { m, burden: {}, vac: {}, gone: {}, avail: {}, stock: {} };
    for (const k of CLASSES) {
      row.burden[k] = (e.rentIdx[k] / E.RENT_BASE[k]) / Math.max(0.35, e.wageIdx ?? 1);
      row.vac[k] = e.cityVac?.[k] ?? 0;
      row.avail[k] = row.vac[k] + (e.sublet?.[k] ?? 0) / Math.max(1, e.stock?.[k] ?? 1);
      const b0 = e.baseStock0?.[k], b = e.baseStock?.[k];
      row.gone[k] = b0 && b ? Math.max(0, Math.min(0.8, 1 - b / b0)) : 0;
      row.stock[k] = e.stock?.[k] ?? 0;
    }
    s.push(row);
  }
  runs.push({ seed, s });
}

console.log(`\nDOES THE EXIT RATCHET FIRE ON SHORTAGES? — ${N} seeds x ${HZ}m\n`);

// ---- the decisive table ----------------------------------------------------
console.log("WHEN THE RATCHET IS FIRING (burden > 1.20), WHAT IS VACANCY DOING?");
console.log("  class       %months firing   ...of those, vacancy is:");
console.log("                                BELOW natural   AT the frictional floor   median vac   median avail");
for (const k of CLASSES) {
  const nat = E.NATURAL_VAC[k];
  const floor = nat * FRICTION_RATIO[k];
  const all = runs.flatMap(({ s }) => s);
  const firing = all.filter((r) => r.burden[k] > 1.20);
  if (!firing.length) { console.log(`  ${k.padEnd(12)} never fires`); continue; }
  const below = firing.filter((r) => r.vac[k] < nat).length;
  const onFloor = firing.filter((r) => r.vac[k] <= floor + 1e-9).length;
  console.log(`  ${k.padEnd(12)} ${pct(firing.length / all.length).padStart(12)}`
    + ` ${pct(below / firing.length).padStart(20)} ${pct(onFloor / firing.length).padStart(21)}`
    + ` ${pct(q(firing.map((r) => r.vac[k]), 0.5)).padStart(15)} ${pct(q(firing.map((r) => r.avail[k]), 0.5)).padStart(14)}`);
}
console.log("\n  A sector that is genuinely LEAVING hands space back: vacancy rises above");
console.log("  natural. A sector that is STARVED cannot: it sits at the frictional floor.");

// ---- how far does the ratchet get? -----------------------------------------
console.log("\nHOW MUCH OF EACH SECTOR THE RATCHET HAS REMOVED  (gone = 1 - baseStock/baseStock0)");
console.log("  class        yr10    yr20    yr30    yr40    yr50    %seeds at the 0.8 cap");
for (const k of CLASSES) {
  const at = (y) => mean(runs.map(({ s }) => s[Math.min(s.length - 1, y * 12 - 1)].gone[k]));
  const capped = runs.filter(({ s }) => s.at(-1).gone[k] >= 0.799).length;
  console.log(`  ${k.padEnd(12)} ${pct(at(10)).padStart(6)} ${pct(at(20)).padStart(7)} ${pct(at(30)).padStart(7)}`
    + ` ${pct(at(40)).padStart(7)} ${pct(at(50)).padStart(7)} ${pct(capped / runs.length).padStart(22)}`);
}

// ---- the loop: does shedding demand precede a deeper shortage? --------------
console.log("\nTHE LOOP — industrial stock and vacancy as the ratchet advances");
console.log("  decade   mean gone   mean cityVac   mean avail   mean stock (M sf)   mean burden");
for (let d = 0; d < Math.floor(HZ / 120); d++) {
  const seg = runs.flatMap(({ s }) => s.slice(d * 120, (d + 1) * 120));
  console.log(`  ${String(d * 10).padStart(2)}-${String(d * 10 + 10).padStart(2)}y`
    + ` ${pct(mean(seg.map((r) => r.gone.industrial))).padStart(10)}`
    + ` ${pct(mean(seg.map((r) => r.vac.industrial))).padStart(14)}`
    + ` ${pct(mean(seg.map((r) => r.avail.industrial))).padStart(12)}`
    + ` ${f(mean(seg.map((r) => r.stock.industrial)) / 1e6).padStart(19)}`
    + ` ${f(mean(seg.map((r) => r.burden.industrial))).padStart(13)}`);
}

// ---- what the discriminator would say --------------------------------------
// If the ratchet gated on "vacancy at or above natural", how much of its
// current firing would survive?
console.log("\nWHAT A VACANCY GATE WOULD CHANGE");
console.log("  class      firing now   firing if gated on vac >= natural   share suppressed");
for (const k of CLASSES) {
  const nat = E.NATURAL_VAC[k];
  const all = runs.flatMap(({ s }) => s);
  const firing = all.filter((r) => r.burden[k] > 1.20);
  const gated = firing.filter((r) => r.vac[k] >= nat);
  if (!firing.length) { console.log(`  ${k.padEnd(12)} never fires`); continue; }
  console.log(`  ${k.padEnd(12)} ${pct(firing.length / all.length).padStart(9)} ${pct(gated.length / all.length).padStart(33)}`
    + ` ${pct(1 - gated.length / firing.length).padStart(19)}`);
}
console.log();
