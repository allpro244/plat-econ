// Lease commissions are a cut of today's rent. They must not be scaled by
// costIdx a second time — that double-count made late-century lease-up
// reserves larger than hard cost and blocked densify under a structural short.
//
//   pnpm engine && pnpm exec node test/lease-up-cost.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
const land = bbls.find((b) => parcels[b]?.class === "land" && parcels[b]?.lotArea >= 8_000
  && (parcels[b]?.demandScore ?? 0) >= 60);
if (!land) throw new Error("need a sizeable land site");

const g0 = E.firstListings(E.newGame(88117, parcels), parcels, bbls);
const floors = Math.min(12, E.maxFloorsFor(parcels[land], 0.62, "office"));

function planAt(costIdx, rentMult) {
  const g = structuredClone(g0);
  g.econ.costIdx = costIdx;
  for (const k of ["office", "retail", "multifamily", "industrial"]) {
    g.econ.rentIdx[k] *= rentMult;
    if (g.econ.effRentIdx) g.econ.effRentIdx[k] *= rentMult;
  }
  return E.underwriteDevelopment(g, parcels, land, "office", floors, 0.62)?.plan;
}

const lo = planAt(1.0, 1.0);
const hiCost = planAt(8.0, 1.0);
const hiBoth = planAt(8.0, 8.0);
if (!lo || !hiCost || !hiBoth) throw new Error("plans failed");

const share = (p) => p.leaseUp / Math.max(1, p.hardCost);
const bothRatio = hiBoth.leaseUp / Math.max(1, lo.leaseUp);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nLEASE-UP COST IDENTITY\n");
console.log(`  leaseUp/hard @ 1/1     ${share(lo).toFixed(2)}`);
console.log(`  leaseUp/hard @ 8/1     ${share(hiCost).toFixed(2)}  (cost alone — deficit swells)`);
console.log(`  leaseUp/hard @ 8/8     ${share(hiBoth).toFixed(2)}  (matched inflation)`);
console.log(`  leaseUp level @ 8/8    ${bothRatio.toFixed(2)}× baseline`);
console.log("");

// The fake was LC×costIdx with rent already inflated: matched 8× inflation
// then put ~64× commissions into the reserve and lease-up/hard blew out.
// Correct identity keeps lease-up/hard near the baseline ratio when cost and
// rent move together; a pure cost shock may still swell the deficit.
check(share(hiBoth) < share(lo) * 1.35,
  `matched cost+rent ×8 keeps lease-up/hard within 35% of baseline `
  + `(${share(hiBoth).toFixed(2)} vs ${share(lo).toFixed(2)})`);
check(bothRatio > 5 && bothRatio < 12,
  `matched inflation scales lease-up roughly with the price level (got ${bothRatio.toFixed(2)}×)`);
check(hiBoth.leaseUp < hiCost.leaseUp,
  "higher rents cut the lease-up deficit versus a cost-only shock");
check(share(hiBoth) < 0.55,
  "lease-up stays a fraction of hard cost under matched inflation");

// Bundle must use TI×costIdx + LC, not (TI+LC)×costIdx — same split as
// leaseUpValue's vacant fill cheque.
const src = await import("node:fs").then((fs) =>
  fs.readFileSync(join(HERE, "../src/engine/dev.ts"), "utf8"));
check(/openSf \* \(tiPsf \* s\.econ\.costIdx \+ lcPsf\)/.test(src),
  "planDevelopment applies costIdx to TI only");
check(!/openSf \* \(tiPsf \+ lcPsf\) \* s\.econ\.costIdx/.test(src),
  "planDevelopment no longer cost-indexes commissions");

console.log("");
process.exit(bad ? 1 : 0);
