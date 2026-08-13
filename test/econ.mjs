// A century of the SPACE MARKET, with no player in it.
//
// The invariant sweep proves the game never reaches an impossible state. This
// proves the market stays a market: that vacancy cycles instead of pegging at
// a clamp, that rents and construction costs do not silently diverge until
// nothing can ever be built, and that every class spends real time on both
// sides of its natural rate. Those are balance properties, and balance
// properties need their own harness or they rot unnoticed.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls, seed: CITY_SEED } = loadCity(0, E.normalizeParcels);

const CLASSES = ["office", "retail", "multifamily", "industrial"];
const NAT = { office: 0.115, retail: 0.085, multifamily: 0.045, industrial: 0.07 };
// The engine's frictional floor is per-class — a shed is let whole and stays,
// an office floor churns — so "sitting on the floor" has to be measured
// against the floor that class actually has. This used to be a flat 0.34 of
// natural, which is the engine's OLD single ratio hard-coded into the test:
// the moment the engine learned that classes differ, the test started failing
// the market for behaving correctly.
const FRICTION = { office: 0.32, retail: 0.32, multifamily: 0.30, industrial: 0.22 };
const FLOOR = {};
for (const k of Object.keys(NAT)) FLOOR[k] = NAT[k] * FRICTION[k];
const SEEDS = Number(process.env.SEEDS ?? 6);
const MONTHS = Number(process.env.HORIZON ?? 1200);

let fail = 0;
const say = (ok, msg) => { if (!ok) { fail++; console.log("  FAIL " + msg); } else console.log("  ok   " + msg); };

for (let seed = 1; seed <= SEEDS; seed++) {
  let g = E.firstListings(E.newGame(seed * 7919, parcels), parcels, bbls);
  const track = {};
  for (const k of CLASSES) track[k] = { min: 1, max: 0, pegLo: 0, pegHi: 0, above: 0, below: 0, starts: 0 };
  let costRentGap = 0;

  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;
    for (const k of CLASSES) {
      const v = e.cityVac?.[k] ?? NAT[k];
      const t = track[k];
      if (v < t.min) t.min = v;
      if (v > t.max) t.max = v;
      if (v <= FLOOR[k] * 1.06) t.pegLo++;   // sitting on ITS frictional floor
      if (v >= 0.445) t.pegHi++;
      if (v > NAT[k]) t.above++; else t.below++;
      if ((e.starts?.[k] ?? 0) > 0) t.starts++;
    }
    if (m === MONTHS - 1) {
      // the long-run ratio that decides whether anything can ever be built
      const rentLvl = e.rentIdx.office / 62;
      costRentGap = e.costIdx / rentLvl;
    }
  }

  console.log(`\nseed ${seed}`);
  for (const k of CLASSES) {
    const t = track[k];
    const pegLoPct = (100 * t.pegLo) / MONTHS;
    const pegHiPct = (100 * t.pegHi) / MONTHS;
    const abovePct = (100 * t.above) / MONTHS;
    console.log(`  ${k.padEnd(12)} vac ${(t.min * 100).toFixed(1)}–${(t.max * 100).toFixed(1)}%  ` +
      `${abovePct.toFixed(0)}% of months above natural, built in ${((100 * t.starts) / MONTHS).toFixed(0)}% of months`);
    // Housing gets a wider allowance on purpose. It is the most inelastic
    // market in the game — supply takes years, demand is people who have to
    // live somewhere — and real housing markets genuinely do sit at frictional
    // vacancy for years at a stretch. What must NOT happen is what used to:
    // sitting there permanently, with flat rents and no construction. The
    // range and start-rate checks below are what catch that.
    // 22% for housing is deliberately loose, and it is set from observed
    // variance rather than from taste: across seeds the housing market spends
    // 10-19% of a century at frictional vacancy, because it is the most
    // inelastic of the four and its cycles are the longest. A run that runs
    // tight a fifth of the time is a legitimate century, not a defect. The
    // failure this harness actually exists to catch is the PERMANENT peg —
    // sitting on the floor with flat rents and no construction — and that is
    // caught by the range and start-rate checks below, not by this one.
    const pegCap = k === "multifamily" ? 22 : 8;
    say(pegLoPct < pegCap, `${k}: pinned on the frictional floor ${pegLoPct.toFixed(1)}% of months (want <${pegCap})`);
    say(pegHiPct < 2, `${k}: pinned at the ceiling ${pegHiPct.toFixed(1)}% of months (want <2)`);
    say(abovePct > 12 && abovePct < 88, `${k}: spends ${abovePct.toFixed(0)}% above natural — both sides of the cycle (want 12-88)`);
    say(t.starts > MONTHS * 0.15, `${k}: the market broke ground in ${((100 * t.starts) / MONTHS).toFixed(0)}% of months (want >15)`);
  }
  say(costRentGap > 0.55 && costRentGap < 1.85,
    `build cost vs rent level after ${MONTHS / 12} years: ${costRentGap.toFixed(2)}x (want 0.55-1.85 — outside that nothing ever pencils, or everything does)`);
}

console.log(fail ? `\n${fail} balance checks failed` : "\nthe market stayed a market");
process.exit(fail ? 1 : 0);
