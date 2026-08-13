// VARIANCE APPLICATIONS ARE PER SITE, NOT PER FIRM.
//
//   pnpm engine && pnpm exec node test/variance.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.newGame(44119, parcels, 50_000_000);
const lots = bbls.filter((b) =>
  parcels[b]?.lotArea > 2_000 && !g.landmarks?.[b]).slice(0, 2);
if (lots.length < 2) throw new Error("Need two sites for variance harness.");

for (const bbl of lots) {
  const rec = parcels[bbl];
  const basis = Math.round(E.landValue(rec, g.econ));
  g.holdings[bbl] = {
    bbl, boughtM: g.month, costBasis: basis, assessed: basis,
    condition: "average", condIdx: 0.55, svcIdx: 0.55,
    tenants: [], loan: null, cfHistory: [], service: 0, stance: 0, plan: 1,
  };
}

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nCONCURRENT VARIANCE APPLICATIONS\n");

const baseFar0 = Math.max(parcels[lots[0]].farMaxComm, parcels[lots[0]].farMaxRes, 2);
const ordinary = E.varianceQuote(g, parcels, lots[0], baseFar0 * 1.34);
const tall = E.varianceQuote(g, parcels, lots[0], baseFar0 * 3);
check(tall.grant > ordinary.grant, "player can request materially more than the old one-third allowance");
check(tall.cost > ordinary.cost && tall.months > ordinary.months,
  "larger FAR asks cost more and take longer");
check(tall.odds < ordinary.odds, "larger FAR asks are harder to approve");

const first = E.fileVariance(g, parcels, lots[0], baseFar0 * 2);
check(!first.err, "first site files");
g = first.s;
const baseFar1 = Math.max(parcels[lots[1]].farMaxComm, parcels[lots[1]].farMaxRes, 2);
const second = E.fileVariance(g, parcels, lots[1], baseFar1 * 3);
check(!second.err, "second site files while the first is pending");
g = second.s;
check(Object.keys(g.varianceApps ?? {}).length === 2, "both hearings remain independently pending");

const duplicate = E.fileVariance(g, parcels, lots[0]);
check(!!duplicate.err, "the same site cannot file twice concurrently");

g.month = Math.max(...Object.values(g.varianceApps).map((a) => a.decideM));
E.tickPlanning(g, parcels, bbls);
check(Object.keys(g.varianceApps ?? {}).length === 0, "both due hearings resolve");
check(lots.every((b) => !!g.varianceLog?.[b]), "each site records its own board decision");

console.log("\nREFILE AFTER A GRANT\n");

// Force a grant on lot 0 so we can prove the board will hear a second ask.
const virgin = E.varianceQuote(g, parcels, lots[0], baseFar0 * 1.34);
g.variance = { ...(g.variance ?? {}), [lots[0]]: 2.5 };
g.varianceLog = {
  ...(g.varianceLog ?? {}),
  [lots[0]]: { m: g.month, granted: true, far: 2.5, cost: 200_000 },
};
const afterGrant = E.resolveRec(parcels, g, lots[0]);
const curFar = Math.max(afterGrant.farMaxComm, afterGrant.farMaxRes, 2);
const reQuote = curFar >= E.FAR_CEILING - 0.05
  ? null
  : E.varianceQuote(g, parcels, lots[0], Math.min(E.FAR_CEILING, curFar * 1.25));
check(!!reQuote, "board still quotes after a prior grant (until the city ceiling)");
if (reQuote && virgin) {
  check(reQuote.odds < virgin.odds, "second trip has worse odds than a first hearing");
  check(reQuote.cost > virgin.cost, "second trip costs more than a first hearing");
}
const refile = E.fileVariance(g, parcels, lots[0], reQuote?.targetFar);
check(!refile.err, `can file again after a grant${refile.err ? ` (${refile.err})` : ""}`);
g = refile.s;
check(!!g.varianceApps?.[lots[0]], "second application sits pending");

console.log("");
process.exit(bad ? 1 : 0);
