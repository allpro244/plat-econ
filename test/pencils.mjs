// CAN ANYTHING IN THIS CITY BE BUILT, AND BY WHOM.
//
//   pnpm pencils                                 two towns, thirty years
//   N=4 HZ=480 pnpm pencils                      wider and longer
//   ENGINE=test/.engine-base.mjs pnpm pencils    the other arm of an A/B
//
// The development desk and the land market are the same question asked from
// two ends, and for a long time this repo answered it two different ways
// without either answer being able to see the other.
//
// From the desk's end, `pnpm devyield` had been reporting 0 office sites
// pencil of 1,363, 0 retail, 3 multifamily and 21 industrial — in a city whose
// office stock grows about 1% a year. From the land market's end, the price of
// dirt ran 1.24x to 1.37x the best builder's residual, and the number of lots
// out of 1,109 where a builder could pay the asking price was ZERO. The
// residual IS the price at which a builder earns exactly DEV_MARGIN, so a
// market permanently above it is a market where development never clears its
// hurdle, anywhere, in any year.
//
// The city kept building through all of it, because `devPencils` — which
// decides city supply — works from index ratios and never looks at what land
// costs or what a square foot costs to put up. The player's desk does look.
// Same quantity, two answers, and the one the player was shown was the one
// that said no.
//
// Three things are measured here and the third is the one that matters.
//
// WHO BIDS       which of the three bids in `landRead` sets the price. If the
//                holder's option wins nearly everywhere, then PEAK_RENT_MULT
//                and WAIT_DISCOUNT are the land market and the builder's
//                residual is decoration.
// PRICE/RESIDUAL the ratio, across every vacant lot. It should STRADDLE 1.0.
//                All of it above 1.0 is a city that cannot be built; all of it
//                below is a city where every lot is a development site.
// STOCK GROWTH   what each class actually added, per year.
//
// This file used to carry a third table comparing RENT_BASE against a
// "needs net" column COPIED OUT OF THE COMMENTS beside HARD_COST_PSF. That
// table found the original fault and then became the fault: the cost table was
// replaced with observed numbers, the comments went with it, and this harness
// carried on printing $62 / $97 / $37 / $17 as though they still meant
// something. A number copied from a comment is a second answer with extra
// steps. The break-even is COMPUTED now, by inverting the engine's own
// residual — see `pnpm breakeven`.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = Number(process.env.N ?? 2);
const HZ = Number(process.env.HZ ?? 360);
const USES = ["office", "retail", "multifamily", "industrial"];

const q = (a, p) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

const who = { builder: 0, holder: 0, texture: 0 };
const wins = {}, bids = {};
for (const u of USES) { wins[u] = 0; bids[u] = []; }
const ratio = [], price = [], resid = [];
const grew = {}; for (const u of USES) grew[u] = [];

for (let i = 0; i < N; i++) {
  const { parcels, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  let g = E.firstListings(E.newGame(31 + i, parcels), parcels, bbls);
  const s0 = {}; for (const u of USES) s0[u] = g.econ.stock[u];
  for (let m = 0; m < HZ; m++) {
    // The frozen world: advanceQuarter returns state unchanged once gameOver
    // is set, so an un-resurrected probe stops and copies its last month.
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
  for (const u of USES) grew[u].push(Math.pow(g.econ.stock[u] / Math.max(1, s0[u]), 12 / HZ) - 1);
  for (const b of bbls) {
    const r = parcels[b];
    if (r?.class !== "land" || !(r.lotArea > 1500)) continue;
    const read = E.landRead(r, g.econ);
    if (!(read.psf > 0)) continue;
    who[read.winner]++;
    if (read.scheme) {
      wins[read.scheme.use]++;
      for (const c of read.scheme.all) bids[c.use].push(c.psf);
    }
    price.push(read.psf); resid.push(read.builder);
    if (read.builder > 0) ratio.push(read.psf / read.builder);
  }
}

const n = who.builder + who.holder + who.texture;
console.log(`\nWHO IS THE HIGH BIDDER FOR DIRT — ${n} vacant lots, ${N} towns, year ${HZ / 12}\n`);
console.log(`  builder      ${rp(((100 * who.builder) / n).toFixed(1) + "%", 7)}   what can be built today`);
console.log(`  holder       ${rp(((100 * who.holder) / n).toFixed(1) + "%", 7)}   the option on the next peak`);
console.log(`  the street   ${rp(((100 * who.texture) / n).toFixed(1) + "%", 7)}   neither bid reaches the comparison floor`);

const tw = Object.values(wins).reduce((a, v) => a + v, 0) || 1;
console.log(`\nAND WHAT THE BUILDER WOULD PUT UP — every use the residual considered\n`);
console.log(`  ${pad("use", 14)}${rp("best use", 10)}${rp("bids > 0", 10)}${rp("median bid $/sf land", 22)}`);
for (const u of USES) {
  const ok = bids[u].filter((x) => x > 0).length;
  console.log(`  ${pad(u, 14)}${rp(((100 * wins[u]) / tw).toFixed(1) + "%", 10)}${rp(((100 * ok) / Math.max(1, bids[u].length)).toFixed(1) + "%", 10)}${rp(q(bids[u], 0.5).toFixed(0), 22)}`);
}

console.log(`\nWHAT DIRT COSTS AGAINST WHAT A BUILDER CAN PAY FOR IT\n`);
console.log(`  ${pad("", 22)}${rp("p25", 9)}${rp("median", 9)}${rp("p75", 9)}`);
console.log(`  ${pad("land price $/sf", 22)}${rp(q(price, 0.25).toFixed(0), 9)}${rp(q(price, 0.5).toFixed(0), 9)}${rp(q(price, 0.75).toFixed(0), 9)}`);
console.log(`  ${pad("builder's residual", 22)}${rp(q(resid, 0.25).toFixed(0), 9)}${rp(q(resid, 0.5).toFixed(0), 9)}${rp(q(resid, 0.75).toFixed(0), 9)}`);
console.log(`  ${pad("price / residual", 22)}${rp(q(ratio, 0.25).toFixed(2) + "x", 9)}${rp(q(ratio, 0.5).toFixed(2) + "x", 9)}${rp(q(ratio, 0.75).toFixed(2) + "x", 9)}`);
console.log(`\n  lots a builder could pay the asking price for: ${((100 * ratio.filter((x) => x <= 1).length) / Math.max(1, ratio.length)).toFixed(1)}%`);
console.log(`  This should STRADDLE 1.0. At 0% the city cannot be built and the`);
console.log(`  supply the player sees is coming from a model that never looks at cost.`);

console.log(`\nWHAT THE CITY ACTUALLY ADDED\n`);
console.log(`  ${pad("use", 14)}${rp("hard $/sf", 11)}${rp("base rent", 11)}${rp("stock", 11)}`);
for (const u of USES) {
  console.log(`  ${pad(u, 14)}${rp(E.HARD_COST_PSF[u], 11)}${rp("$" + E.RENT_BASE[u].toFixed(2), 11)}`
    + `${rp((100 * q(grew[u], 0.5)).toFixed(2) + "%/yr", 11)}`);
}
console.log(`\n  A class the residual says cannot be built anywhere, whose stock grows`);
console.log(`  anyway, means city supply and the desk are still two different models.`);
console.log(`  For the rent each class NEEDS against the rent it gets, run pnpm breakeven —`);
console.log(`  it inverts this engine's own residual instead of quoting a comment at you.\n`);
