// A SHOP IS NOT PRICED OFF THE TOWER ABOVE IT.
//
//   pnpm legmatch
//
// The report was that retail signs "significantly below market" — that there
// is a gap between the market rent the game prints and what tenants will put
// their name to. There was, and no tenant was involved in it.
//
// `managedRentPsfYr(rec, econ, h)` called with no use returns the AREA-WEIGHTED
// BLEND of every market in the building, and its own comment says that is the
// right answer for an appraisal and the wrong one for a lease. A letter is
// always for one leg. Four places asked it the blended question and compared
// the answer to a one-leg number:
//
//   the leasing agent      binned any letter under 82% of the BLEND
//   the renewal desk       referred any renewal under 82% of the BLEND
//   the renewal generator  quoted the sitting tenant off the BLEND
//   the portfolio table    marked the rent roll against the BLEND
//
// In a building that is shops under offices the blend is mostly office, so a
// shop letter at the going shop rent reads as a lowball, gets refused with a
// note saying the rent was under the market, and the rent roll that does
// survive prints in red. Nothing in the space market was wrong.
//
// This measures the size of that gap directly: for every leasable leg of every
// building in the city, what its own market pays against what the building's
// blend says it should. No player, no bot, no cohort — it is a property of the
// stock and the price table, and it is the same on the first month as the last.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N || 3);
const CLASSES = ["office", "retail", "multifamily", "industrial"];

const rows = {};
for (const c of CLASSES) rows[c] = { legs: 0, mixed: 0, under: 0, gap: [] };

for (let seed = 0; seed < N; seed++) {
  const { parcels, bbls } = loadCity(seed % 4, E.normalizeParcels);
  const g = E.newGame(7000 + seed, parcels);
  for (const bbl of bbls) {
    const rec = E.resolveRec(parcels, g, bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    const uses = E.leasableUses(rec);
    const h = { bbl, tenants: [], occ: 0, condition: E.initialCondition(rec), boughtM: 0, costBasis: 0, programsDone: {} };
    const blend = E.managedRentPsfYr(rec, g.econ, h);
    for (const u of uses) {
      const leg = E.managedRentPsfYr(rec, g.econ, h, u);
      const r = rows[u];
      if (!r || !(leg > 0) || !(blend > 0)) continue;
      r.legs++;
      if (uses.length > 1) r.mixed++;
      const gap = leg / blend - 1;
      r.gap.push(gap);
      // 0.82 is the mandate both desks applied. A leg whose own market is more
      // than 18% under the blend is a leg where every honest letter was binned.
      if (leg < blend * 0.82) r.under++;
    }
  }
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const worst = (a) => (a.length ? Math.min(...a) : NaN);
const pad = (s, n) => String(s).padEnd(n);

console.log(`\nWHAT A LEG PAYS AGAINST WHAT THE BUILDING'S BLEND SAYS — ${N} towns\n`);
console.log(`  ${pad("class", 14)}${pad("legs", 8)}${pad("in mixed", 10)}${pad("median gap", 13)}${pad("worst", 9)}under the 82% mandate`);
let anyBroken = 0;
for (const c of CLASSES) {
  const r = rows[c];
  if (!r.legs) continue;
  const share = r.under / r.legs;
  if (r.under > 0) anyBroken += r.under;
  console.log(`  ${pad(c, 14)}${pad(r.legs, 8)}${pad(r.mixed, 10)}`
    + `${pad((med(r.gap) * 100).toFixed(1) + "%", 13)}${pad((worst(r.gap) * 100).toFixed(1) + "%", 9)}`
    + `${r.under} (${(share * 100).toFixed(1)}%)`);
}
console.log(`\n  ${anyBroken} leg(s) sit more than 18% under their own building's blend.`);
console.log("  Every one of those is a space where a letter at the going rate for that space read");
console.log("  as a lowball to a desk comparing it against the blend. The engine reads the leg now");
console.log("  everywhere a lease is priced or judged; this number is the size of what it was");
console.log("  reading before, and it is a fact about the stock rather than a regression to fix.\n");
