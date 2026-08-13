// RECORDING THE PLAYER'S DEED EXTINGUISHES EVERY RIVAL CLAIM.
//
//   pnpm engine && pnpm exec node test/title-transfer.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels } = loadCity(0, E.normalizeParcels);
let g = E.newGame(4053, parcels, 100_000_000);
const seller = g.rivals.find((r) => r.bbls.length);
const duplicate = g.rivals.find((r) => r !== seller);
if (!seller || !duplicate) throw new Error("Need two rival firms with one deed.");
const bbl = seller.bbls[0];
duplicate.bbls.push(bbl); // deliberately recreate the historical corrupt state
(duplicate.heldSince ??= {})[bbl] = g.month;

const rec = E.resolveRec(parcels, g, bbl);
const price = Math.max(100_000, Math.round(E.assetValue(rec, g.econ, "standard")));
const bought = E.executePurchase(g, parcels, bbl, price, "cash", true, 1);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nATOMIC TITLE TRANSFER\n");
check(!bought.err, "player purchase closes");
g = bought.s;
check(!!g.holdings[bbl], "player holds the recorded deed");
check(!g.rivals.some((r) => r.bbls.includes(bbl)), "every stale rival claim is extinguished");
check(!g.rivals.some((r) => r.heldSince?.[bbl] !== undefined), "rival hold clocks leave with the deed");
check(!E.checkInvariants(g, parcels).some((v) => v.code === "rival"), "title invariant is clean after closing");

console.log("");
process.exit(bad ? 1 : 0);
