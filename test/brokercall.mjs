// WHEN DOES THE PHONE FIRST RING?
//
// The owner's ruling: the first broker call must come no sooner than two years
// into the game. Nobody rings a name they have never heard, and a cold call in
// the first winter reads as the game handing you a deal rather than as the
// street noticing you exist.
//
// This MEASURES it rather than asserting the constant, because the gate is only
// half the mechanic: the drought clock (quietMs) drives the hazard, and a change
// anywhere in the inbound-channel accounting could either push the first call
// out to year six or — if the gate is ever lost in a refactor — let one through
// in month three. Both are regressions and neither shows up in a type check.
//
// The desk is deliberately IDLE here: no buying, no leasing, nothing at the
// door. That is the case where the drought floor is at its most generous, so
// these are the EARLIEST calls the engine can produce.
// Run: node test/brokercall.mjs   (bundle first, like every other harness)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);

const FLOOR = 24;      // the ruling: no call before the second anniversary
const PATIENCE = 84;   // and one must arrive inside seven years, or the phone is dead

const firsts = [];
for (const seed of [11, 22, 33, 44, 55, 66, 77, 88, 99, 110]) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  g = { ...g, cash: 8_000_000 };
  let first = null;
  for (let m = 0; m < PATIENCE && first === null; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    for (const a of Object.values(g.approaches)) {
      if (a.inbound && a.ask) { first = g.month; break; }
    }
  }
  firsts.push(first);
  console.log(`seed ${String(seed).padStart(3)}: first broker call at month ${first ?? `>${PATIENCE}`}`);
}

const got = firsts.filter((x) => x !== null);
const sorted = [...got].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
console.log(`\nearliest ${Math.min(...got)}  median ${median}  latest ${Math.max(...got)}`
  + `  ·  ${got.length}/${firsts.length} rang inside ${PATIENCE / 12} years`);

const fails = [];
const early = got.filter((m) => m < FLOOR);
if (early.length) fails.push(`${early.length} seeds rang before month ${FLOOR} (earliest ${Math.min(...early)})`);
if (got.length < firsts.length * 0.8) fails.push(`only ${got.length}/${firsts.length} rang at all inside ${PATIENCE} months — the phone is dead`);
if (fails.length) { console.log("\nFAIL: " + fails.join("; ")); process.exit(1); }
console.log(`\nPASS: no call before month ${FLOOR}, and the phone still rings.`);
