// GREAT CITY SIM LATENCY — map size must not block the main thread.
//
// A 5,900-lot island used to stall for seconds on advance because feasibility
// scanned every lot. The bounded sample keeps engine time predictable; this
// gate catches regressions without running a full browser profile.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

process.env.BW_SIZE = "giant";
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

console.log("\nGREAT CITY PERF\n");
let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

check(bbls.length >= 5000, `giant city has ${bbls.length.toLocaleString()} lots`);

let g = E.firstListings(E.newGame(55119, parcels), parcels, bbls);
const quarters = 16;
const t0 = performance.now();
for (let i = 0; i < quarters; i++) g = E.advanceQuarter(g, parcels, bbls, adjacency);
const perQ = (performance.now() - t0) / quarters;
check(perQ < 80, `quarter advance stays under 80ms (${perQ.toFixed(1)} ms avg over ${quarters} quarters)`);

console.log("");
process.exit(bad ? 1 : 0);
