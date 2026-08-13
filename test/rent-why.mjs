// ASKING-RENT MOVES CARRY A CAUSAL SENTENCE.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nRENT WHY\n");

let g = E.firstListings(E.newGame(77221, parcels), parcels, bbls);
let saw = null;
for (let i = 0; i < 240 && !g.gameOver; i++) {
  g = E.advanceMonth(g, parcels, bbls, adjacency);
  const why = g.econ.rentWhy?.office;
  if (why) { saw = why; break; }
}
check(!!saw, "office rentWhy is written after a material asking-rent move");
check(!saw || /fell|rose/.test(saw), "rentWhy states direction");
check(!saw || /vacancy|income|employment|deliver|demand|pay|absorption|tenant/i.test(saw),
  "rentWhy names a dominant driver");

console.log("");
process.exit(bad ? 1 : 0);
