// WHAT A CLASS MUST EARN TO BE BUILT, AGAINST WHAT IT EARNS.
//
//   pnpm breakeven                                one town, stratified by demand
//   N=3 pnpm breakeven                            three towns
//   ENGINE=test/.engine-base.mjs pnpm breakeven   the other arm of an A/B
//
// This is an IDENTITY, not a band, and it is the one that was never checked.
// `HARD_COST_PSF` in value.ts carries in its own comments the net rent each
// class needs to justify its cost — $62 for office, $97 for retail, $37 for
// multifamily, $17 for industrial. `RENT_BASE` in market.ts carries what each
// class earns: 43.65, 42.91, 30.22, 18.00. Nobody had put the two columns next
// to each other, and three of the four classes are underwater against numbers
// written down in the same repository.
//
// Those comment figures are also not checkable — they are assertions beside a
// constant. So this does not copy them. It INVERTS THE ENGINE'S OWN RESIDUAL:
// `residualScheme(rec, econ, rentMult)` already takes a rent multiplier, so
// bisecting on it finds the rent at which a use's bid for the dirt crosses
// zero, through the real code path, including the height premium, the plate
// efficiency, the fit-out, the tax solve, the developer's margin and the wait
// discount. There is one answer because there is one calculation.
//
// Read it as: a break-even at or below the market rent means the class can be
// built HERE. Above it means it cannot, at any land price, because land is the
// last claim on the money and not the first.
//
// The right shape is NOT "everything pencils". It is the good corners pencilling
// and the fringe not, for every class — a city where one class can be built
// everywhere and three can be built nowhere is a city with one industry.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = Number(process.env.N ?? 1);
const HZ = Number(process.env.HZ ?? 120);
const USES = ["office", "retail", "multifamily", "industrial"];
const MAX_MULT = 12;   // above this the answer is "never", not a number

const q = (a, p) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

/** The rent multiple at which this use's bid for the dirt crosses zero. */
function breakEvenMult(rec, econ, use) {
  const bidAt = (m) => (E.residualScheme(rec, econ, m)?.all ?? []).find((c) => c.use === use)?.psf ?? -1;
  if (bidAt(1) > 0) return 1;                 // already pencils at today's rent
  if (bidAt(MAX_MULT) <= 0) return Infinity;  // never, at any rent
  let lo = 1, hi = MAX_MULT;
  for (let k = 0; k < 26; k++) { const mid = (lo + hi) / 2; if (bidAt(mid) > 0) hi = mid; else lo = mid; }
  return hi;
}

const STRATA = [
  { key: "best decile", lo: 0.90, hi: 1.00 },
  { key: "median", lo: 0.45, hi: 0.55 },
  { key: "worst decile", lo: 0.00, hi: 0.10 },
];

const need = {}, gets = {}, dead = {};
for (const s of STRATA) { need[s.key] = {}; gets[s.key] = {}; dead[s.key] = {}; for (const u of USES) { need[s.key][u] = []; gets[s.key][u] = []; dead[s.key][u] = 0; } }

for (let i = 0; i < N; i++) {
  const { parcels, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  let g = E.firstListings(E.newGame(31 + i, parcels), parcels, bbls);
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
  const lots = bbls.filter((b) => parcels[b]?.class === "land" && parcels[b].lotArea > 1500);
  lots.sort((a, b) => (parcels[a].demandScore ?? 0) - (parcels[b].demandScore ?? 0));
  for (const s of STRATA) {
    const slice = lots.slice(Math.floor(s.lo * lots.length), Math.max(1, Math.floor(s.hi * lots.length)));
    for (const b of slice) {
      const rec = parcels[b];
      for (const u of USES) {
        const mult = breakEvenMult(rec, g.econ, u);
        const rent = E.useRentPsfYr(rec, g.econ, "good", u);
        gets[s.key][u].push(rent);
        if (Number.isFinite(mult)) need[s.key][u].push(rent * mult);
        else dead[s.key][u]++;
      }
    }
  }
}

console.log(`\nTHE RENT A NEW BUILDING NEEDS, AGAINST THE RENT IT WOULD GET`);
console.log(`${N} town(s), year ${HZ / 12}, inverted from the engine's own residual\n`);
for (const s of STRATA) {
  console.log(`  ${s.key.toUpperCase()} of lots by demand`);
  console.log(`  ${pad("use", 15)}${rp("market rent", 13)}${rp("needs", 10)}${rp("gap", 9)}${rp("buildable", 12)}`);
  for (const u of USES) {
    const got = q(gets[s.key][u], 0.5);
    const nd = need[s.key][u];
    const n = q(nd, 0.5);
    const total = nd.length + dead[s.key][u];
    const ok = nd.filter((x, j) => x <= gets[s.key][u][j]).length;
    const gap = Number.isFinite(n) ? n / got - 1 : NaN;
    console.log(`  ${pad(u, 15)}${rp("$" + got.toFixed(2), 13)}${rp(nd.length ? "$" + n.toFixed(2) : "never", 10)}`
      + `${rp(Number.isFinite(gap) ? (gap >= 0 ? "+" : "") + (100 * gap).toFixed(0) + "%" : "—", 9)}`
      + `${rp(((100 * ok) / Math.max(1, total)).toFixed(0) + "%", 12)}`);
  }
  console.log("");
}
console.log(`  "needs" is the rent at which this use's bid for the dirt crosses zero — land`);
console.log(`  worth nothing, developer earning exactly DEV_MARGIN and no more. A class`);
console.log(`  needing more than it gets cannot be built at ANY land price.`);
console.log(`\n  A healthy table has every class buildable in the best decile and none of`);
console.log(`  them buildable in the worst. One class at 100% everywhere means that class`);
console.log(`  outbids the others for every site in the city, including the ones it has`);
console.log(`  no business on.\n`);
