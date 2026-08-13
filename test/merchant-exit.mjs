// MERCHANT BUILDERS SELL STABILIZED PRODUCT, NOT A BIRTHDAY.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));

const bbl = "x";
const merchant = {
  id: "m", name: "Merchant Test", style: "merchant",
  cash: 1e6, debt: 0, bbls: [bbl], targetLtv: 0.7, bornM: 0,
  heldSince: { [bbl]: 0 }, deliveredM: { [bbl]: 0 }, occ: 0.75,
};
let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nMERCHANT EXIT CLOCK\n");
check(!E.merchantExitReady(merchant, bbl, 17), "merchant cannot sell before 18 months");
check(!E.merchantExitReady(merchant, bbl, 24), "unstabilized product waits inside the mandate");
merchant.occ = 0.82;
check(E.merchantExitReady(merchant, bbl, 24), "stabilized product is ready for marketed exit");
merchant.occ = 0.60;
check(E.merchantExitReady(merchant, bbl, 42), "hard fund deadline forces exit even if lease-up disappointed");
E.forgetDeed(merchant, bbl);
check(merchant.deliveredM[bbl] === undefined, "merchant delivery clock leaves with the deed");

console.log("");
process.exit(bad ? 1 : 0);
