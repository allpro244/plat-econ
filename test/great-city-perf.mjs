// GREAT CITY PERFORMANCE — measured, not felt.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { makeCity } = await import("../src/citygen/index.mjs");

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nGREAT CITY PERFORMANCE\n");

const tBuild0 = performance.now();
const built = makeCity("somewhere", 20261, { size: "giant" });
if (E.normalizeParcels) E.normalizeParcels(built.parcels);
const buildMs = performance.now() - tBuild0;
const parcels = built.parcels;
const adjacency = built.adjacency;
const bbls = Object.keys(parcels);
console.log(`  city: ${bbls.length} parcels · build ${(buildMs / 1000).toFixed(2)}s`);

let g = E.firstListings(E.newGame(20261, parcels), parcels, bbls);
g.cash = 100_000_000;

const months = Number(process.env.HZ ?? 24);
const t0 = performance.now();
for (let i = 0; i < months && !g.gameOver; i++) {
  g = E.advanceMonth(g, parcels, bbls, adjacency);
}
const advanceMs = performance.now() - t0;
const perMonth = advanceMs / Math.max(1, months);

// Pure selectors used on click / portfolio redraws.
const tSel0 = performance.now();
for (let i = 0; i < 200; i++) {
  const bbl = bbls[i % bbls.length];
  E.resolveRec(parcels, g, bbl);
  E.ownerOf(g, bbl);
  E.assetValue(parcels[bbl], g.econ, 0.7);
}
const selMs = performance.now() - tSel0;

console.log(`  advance: ${months} months in ${(advanceMs / 1000).toFixed(2)}s · ${perMonth.toFixed(0)} ms/month`);
console.log(`  selectors: 200 resolve/owner/value passes in ${selMs.toFixed(0)} ms`);

// Soft ceilings for a giant city on a cloud VM. Fail only on pathological drift.
check(bbls.length >= 4000, "Great City has at least 4,000 parcels");
check(perMonth < 2500, `month advance under 2.5s (was ${perMonth.toFixed(0)} ms)`);
check(selMs < 4000, `click-path selectors under 4s for 200 passes (was ${selMs.toFixed(0)} ms)`);
check(buildMs < 90_000, `city generation under 90s (was ${(buildMs / 1000).toFixed(1)}s)`);

console.log("");
process.exit(bad ? 1 : 0);
