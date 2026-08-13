// SAVE MIGRATIONS ARE PURE, IDEMPOTENT AND TESTABLE WITHOUT INDEXEDDB.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels } = loadCity(0, E.normalizeParcels);

const g = E.newGame(55119, parcels);
const rival = g.rivals.find((r) => r.bbls.length);
const bbl = rival?.bbls[0] ?? Object.keys(parcels)[0];
g.varianceApp = { bbl, filedM: 1, decideM: 12, cost: 10_000, grant: 2, odds: 0.5 };
if (rival) {
  rival.heldSince ??= {};
  rival.heldSince[`ext|${bbl}`] = 36;
}

console.log("\nSAVE MIGRATION\n");
let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};
const migrated = E.migrateSaveState(structuredClone(g));
check(!migrated.varianceApp && migrated.varianceApps?.[bbl]?.grant === 2,
  "legacy singular variance becomes per-property application");
if (rival) {
  const mr = migrated.rivals.find((r) => r.id === rival.id);
  check(mr.extendedTo?.[bbl] === 36 && mr.heldSince?.[`ext|${bbl}`] === undefined,
    "legacy extension record moves out of heldSince");
}
const twice = E.migrateSaveState(structuredClone(migrated));
check(JSON.stringify(twice) === JSON.stringify(migrated), "migration is idempotent");

console.log("");
process.exit(bad ? 1 : 0);
