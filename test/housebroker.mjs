// THE BROKER WHO CALLS YOU FIRST — is the first look real, and is it earned?
//
//   pnpm engine && pnpm housebroker
//
// Three named shops per campaign. Fees build a score, the score opens a
// private window on fresh listings, lapsed windows and years of silence close
// it again. Asserted here: the fee credit works; a principal with a book gets
// listings off-tape and NOBODY else can take one during the window; a
// principal the shops have never met gets nothing; and both decay paths
// (ignored looks, gone-quiet fade) actually reduce the score.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);
let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};
const advance = (g, n) => {
  for (let i = 0; i < n; i++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
  return g;
};

// ---- 1 · fees are credited to the parcel's own shop ------------------------
{
  const g = E.firstListings(E.newGame(31337, parcels), parcels, bbls);
  const bbl = bbls[0];
  const id = E.brokerIdFor(g, bbl);
  E.creditBrokerFee(g, bbl);
  E.creditBrokerFee(g, bbl);
  ok("fees accrue to the named shop", g.brokerRel?.[id]?.fees === 2 && !!g.brokerRel[id].name,
    `${g.brokerRel?.[id]?.name}: ${g.brokerRel?.[id]?.fees} fees`);
  ok("score below threshold gives no window yet", E.brokerScore(g, id) < E.EARLY_FEES);
}

// ---- 2 · a known name hears the address first ------------------------------
{
  let g = E.firstListings(E.newGame(31337, parcels), parcels, bbls);
  // a principal all three shops have closed with — five fees each, fresh
  for (const i of [0, 1, 2]) {
    const id = `b${i}`;
    g.brokerRel = g.brokerRel ?? {};
    g.brokerRel[id] = { name: E.houseBrokerName(g, i), fees: 5, lastFeeM: g.month, ignores: 0 };
  }
  const earlySeen = new Map(); // bbl -> {listedM, earlyUntilM}
  let stolenInWindow = 0;
  for (let m = 0; m < 60; m++) {
    const before = new Map(g.listings.filter((l) => l.earlyUntilM !== undefined && g.month < l.earlyUntilM).map((l) => [l.bbl, l.earlyUntilM]));
    g = advance(g, 1);
    for (const l of g.listings) {
      if (l.earlyUntilM !== undefined && !earlySeen.has(l.bbl)) earlySeen.set(l.bbl, { listedM: l.listedM, earlyUntilM: l.earlyUntilM });
    }
    // anything that was inside its window last month must still be on the tape
    // (or the window's over) — never absorbed by somebody else mid-window
    for (const [bbl, until] of before) {
      if (g.month < until && !g.listings.some((l) => l.bbl === bbl) && !g.holdings[bbl]) stolenInWindow++;
    }
  }
  ok("first looks arrive off-tape for a principal with a book", earlySeen.size >= 1, `${earlySeen.size} in 5 years`);
  ok("every look opens a real window", [...earlySeen.values()].every((x) => x.earlyUntilM > x.listedM));
  ok("nobody takes a building during your window", stolenInWindow === 0, `${stolenInWindow} stolen`);
  ok("lapsed looks are counted against you", Object.values(g.brokerRel).reduce((n, r) => n + r.ignores, 0) >= 1,
    `${Object.values(g.brokerRel).reduce((n, r) => n + r.ignores, 0)} ignores recorded`);
}

// ---- 3 · a stranger hears nothing ------------------------------------------
{
  let g = E.firstListings(E.newGame(31337, parcels), parcels, bbls);
  g = advance(g, 36);
  ok("no relationship, no first looks", !g.listings.some((l) => l.earlyUntilM !== undefined)
    && !Object.values(g.brokerRel ?? {}).some((r) => r.fees > 0));
}

// ---- 4 · decay: ignored looks and years of silence -------------------------
{
  const g = E.firstListings(E.newGame(31337, parcels), parcels, bbls);
  g.brokerRel = { b0: { name: E.houseBrokerName(g, 0), fees: 4, lastFeeM: g.month, ignores: 0 } };
  const fresh = E.brokerScore(g, "b0");
  g.brokerRel.b0.ignores = 2;
  const snubbed = E.brokerScore(g, "b0");
  ok("ignored looks decay the score", snubbed < fresh, `${fresh} -> ${snubbed}`);
  g.brokerRel.b0.ignores = 0;
  g.month += 100;
  ok("years of silence fade the score", E.brokerScore(g, "b0") < fresh, `${fresh} -> ${E.brokerScore(g, "b0")}`);
  ok("faded + snubbed drops below the window threshold", (g.brokerRel.b0.ignores = 1, E.brokerScore(g, "b0") < E.EARLY_FEES));
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
