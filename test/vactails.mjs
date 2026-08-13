// THE VACANCY TAILS — is either end a market, or is it a clamp?
//
//   pnpm vactails                          twelve seeds, fifty years
//   N=24 HZ=300 pnpm vactails              a wider, shorter sweep
//   ENGINE=test/.engine-base.mjs pnpm vactails    the other arm of an A/B
//
// The construction-market fix took the worst real rent drawdown from a 48%
// median to 69%. Availability runs 3.7% to 25% against a real office range of
// roughly 8-20%, and BOTH tails are suspect. This asks which one is a market.
//
// The tight tail is arithmetically a rail: `market.ts` clamps
//
//     e.cityVac[k] = clamp(1 - occupied/stock, friction, 0.45)
//     friction = NATURAL_VAC[k] * (0.22 industrial | 0.30 multifamily | 0.32 rest)
//
// which for office is 11.5% x 0.32 = 3.68% — the measured p05 to two decimals.
// CLAUDE.md rule 5: a clamp is fine as a guard and is a bug when it is
// load-bearing. A comment in market.ts records this rail binding 26.9% of all
// months once before, which is why the sublet channel was added to the
// AVAILABILITY measure. But `cityVac` itself is read raw by three things the
// sublet channel never reached — cap rates, the land residual's vacancy
// discount, and the demand pool's housable ceiling — so the rail can still be
// load-bearing for those even when availability looks healthy.
//
// The glut tail is the other half: `vacTerm`'s quadratic was calibrated at
// SEVEN TO NINE points over natural (1990-92, 2020-23, per its own comment).
// This counts how far past that the model now goes and how long it stays.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = Number(process.env.N ?? 12);
const HZ = Number(process.env.HZ ?? 600);
const CLASSES = ["office", "retail", "multifamily", "industrial"];
const SEEDS = Array.from({ length: N }, (_, i) => (2166136261 ^ ((i + 1) * 2654435761)) >>> 0 % 1e6);
const FRICTION_RATIO = { office: 0.32, retail: 0.32, multifamily: 0.30, industrial: 0.22 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
const pct = (x) => (x * 100).toFixed(2) + "%";
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
    const row = { m, cap: {}, vac: {}, avail: {} };
    for (const k of CLASSES) {
      row.vac[k] = e.cityVac?.[k] ?? 0;
      row.avail[k] = row.vac[k] + (e.sublet?.[k] ?? 0) / Math.max(1, e.stock?.[k] ?? 1);
      row.cap[k] = e.capRate?.[k] ?? 0;
    }
    row.rentO = e.rentIdx.office; row.cpi = e.cpi ?? 1; row.land = e.landIdx ?? 1;
    s.push(row);
  }
  runs.push({ seed, s });
}

console.log(`\nTHE VACANCY TAILS — ${process.env.ENGINE ?? "test/.engine.mjs"}  N=${N} x ${HZ}m\n`);

// ---- 1. does cityVac rest on its frictional rail? --------------------------
console.log("THE TIGHT TAIL — is `cityVac` sitting on its clamp?");
console.log("  class         floor    p01     p05   median      % of months ON the floor   longest stretch");
for (const k of CLASSES) {
  const floor = E.NATURAL_VAC[k] * FRICTION_RATIO[k];
  const all = runs.flatMap(({ s }) => s.map((r) => r.vac[k]));
  const on = all.filter((v) => v <= floor + 1e-9).length;
  let longest = 0;
  for (const { s } of runs) {
    let run = 0;
    for (const r of s) { if (r.vac[k] <= floor + 1e-9) { run++; longest = Math.max(longest, run); } else run = 0; }
  }
  console.log(`  ${k.padEnd(12)} ${pct(floor).padStart(6)} ${pct(q(all, 0.01)).padStart(7)} ${pct(q(all, 0.05)).padStart(7)}`
    + ` ${pct(q(all, 0.5)).padStart(8)} ${pct(on / all.length).padStart(24)} ${String(longest).padStart(14)}m`);
}

// availability sees the sublet channel; cityVac does not. Both matter, to
// different readers.
console.log("\n  ...and AVAILABILITY (cityVac + sublet), which is what rent reads:");
console.log("  class          p01     p05   median     p95     p99     max");
for (const k of CLASSES) {
  const all = runs.flatMap(({ s }) => s.map((r) => r.avail[k]));
  console.log(`  ${k.padEnd(12)} ${pct(q(all, 0.01)).padStart(7)} ${pct(q(all, 0.05)).padStart(7)} ${pct(q(all, 0.5)).padStart(8)}`
    + ` ${pct(q(all, 0.95)).padStart(7)} ${pct(q(all, 0.99)).padStart(7)} ${pct(Math.max(...all)).padStart(7)}`);
}

// ---- 2. how far past its calibration does the glut branch run? -------------
console.log("\nTHE GLUT TAIL — vacTerm's quadratic was fitted at 7-9 points over natural");
console.log("  class      %months >9pp over   %months >12pp   max gap   months/50y above 9pp   worst -%/yr at max gap");
for (const k of CLASSES) {
  const nat = E.NATURAL_VAC[k];
  const gaps = runs.flatMap(({ s }) => s.map((r) => r.avail[k] - nat));
  const over9 = gaps.filter((v) => v > 0.09).length;
  const over12 = gaps.filter((v) => v > 0.12).length;
  const mx = Math.max(...gaps);
  // MIRRORS market.ts's glut branch, saturating form included. If it drifts
  // from the engine this harness reports a decline the engine never delivers,
  // which is the same class of fault as a stale bundle.
  const glut = (gp) => gp * 0.070 + gp * gp * 0.85;
  const FIT_MAX = 0.09, SLOPE_AT_FIT = 0.070 + 2 * 0.85 * FIT_MAX, DEEP_RATE = 0.0155;
  const atFit = glut(FIT_MAX), span = DEEP_RATE - atFit;
  const rate = (gp) => (gp <= FIT_MAX
    ? glut(gp)
    : atFit + span * (1 - Math.exp(-SLOPE_AT_FIT * (gp - FIT_MAX) / span))) * 12;
  console.log(`  ${k.padEnd(10)} ${pct(over9 / gaps.length).padStart(16)} ${pct(over12 / gaps.length).padStart(15)}`
    + ` ${pct(mx).padStart(9)} ${f(over9 / runs.length, 0).padStart(21)} ${pct(-rate(mx)).padStart(23)}`);
}
console.log("  (the -%/yr column is the rent decline the glut branch delivers AT that gap,");
console.log("   before the capitulation clock; at 9pp it is -14.7%/yr, which matches 1990-92)");

// ---- 2b. THE RAIL STACK -----------------------------------------------------
// `cityVac` pinning is not the only saturation at the tight end, and it is not
// even the first one reached. Three separate readers of citywide vacancy each
// stop responding at their own threshold, and every one of those thresholds is
// ABOVE the frictional floor — so the model loses the ability to tell "tight"
// from "desperately tight" long before vacancy bottoms out:
//
//   cap rate    vacRisk = clamp(CAP_VAC_BETA * vacGap * 100, -0.6, 2.0)
//               office pins at 11.5% - 0.6/(0.12*100) = 6.5% vacancy
//   lease-up    vacancyPull = clamp(pow(NATURAL/vac, 0.9), 0.4, 1.7)
//               office pins at 11.5% / 1.7^(1/0.9) = 6.33% vacancy
//   vacancy     cityVac = clamp(1 - occupied/stock, friction, 0.45)
//               office pins at 3.68%
//
// A market below the first threshold is one where an investor cannot pay up
// any further for scarcity and a landlord's phone cannot ring any harder.
const CAP_VAC_BETA = { office: 0.12, retail: 0.09, multifamily: 0.06, industrial: 0.08 };
console.log("\nTHE RAIL STACK AT THE TIGHT END — where each tightness signal stops responding");
console.log("  class        capRate pins   leaseUp pins   vacancy pins      %months below the FIRST rail");
for (const k of CLASSES) {
  const nat = E.NATURAL_VAC[k];
  const capPin = nat - 0.6 / (CAP_VAC_BETA[k] * 100);
  const pullPin = nat / Math.pow(1.7, 1 / 0.9);
  const floor = nat * FRICTION_RATIO[k];
  const first = Math.max(capPin, pullPin, floor);
  const all = runs.flatMap(({ s }) => s.map((r) => r.vac[k]));
  console.log(`  ${k.padEnd(12)} ${pct(capPin).padStart(9)} ${pct(pullPin).padStart(14)} ${pct(floor).padStart(14)}`
    + ` ${pct(all.filter((v) => v <= first + 1e-9).length / all.length).padStart(33)}`);
}

// ---- 3. what does the rail do to the things that read cityVac raw? ---------
// Cap rates read `cityVac - NATURAL_VAC` directly, not availability. If the
// vacancy is pinned, so is the risk premium.
console.log("\nWHAT THE RAIL PINS — cap rate while office vacancy sits on its floor vs off it");
const floorO = E.NATURAL_VAC.office * FRICTION_RATIO.office;
const onRail = [], offRail = [];
for (const { s } of runs) for (const r of s) (r.vac.office <= floorO + 1e-9 ? onRail : offRail).push(r);
console.log(`  months on the floor : ${onRail.length}  cap rate ${f(mean(onRail.map((r) => r.cap.office)))}%`
  + `  real rent ${f(mean(onRail.map((r) => r.rentO / r.cpi)))}  land ${f(mean(onRail.map((r) => r.land)))}`);
console.log(`  months off it       : ${offRail.length}  cap rate ${f(mean(offRail.map((r) => r.cap.office)))}%`
  + `  real rent ${f(mean(offRail.map((r) => r.rentO / r.cpi)))}  land ${f(mean(offRail.map((r) => r.land)))}`);
console.log();
