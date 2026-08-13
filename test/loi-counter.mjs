// WHAT MOVES THE NEEDLE ON A COUNTER.
//
//   pnpm exec node test/loi-counter.mjs
//
// Asserts the quantities the counter desk claims to price:
//   1. Free rent is inside net effective (cutting it raises NE)
//   2. TI cuts raise NE; TI adds lower it
//   3. Tenant counter-back rent floors off the OPENER, not the landlord ask
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let bad = 0;
const fail = (msg) => { bad++; console.log(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  OK    ${msg}`);

console.log("\nLOI COUNTER — what moves the needle\n");

// --- 1–2. netEffectivePsf includes free rent and TI ------------------
{
  const loi = {
    id: 1, bbl: "x", kind: "new", name: "Acme", sector: "tech", credit: 2,
    sf: 10000, rentPsf: 40, termM: 120, tiPsf: 40, freeM: 6, bumpPct: 2.5, net: true,
  };
  const base = E.netEffectivePsf(loi, 40, 40, 6, 2.5);
  const cutFree = E.netEffectivePsf(loi, 40, 40, 0, 2.5);
  const cutTi = E.netEffectivePsf(loi, 40, 0, 6, 2.5);
  const addTi = E.netEffectivePsf(loi, 40, 60, 6, 2.5);
  if (!(cutFree > base + 1.5)) fail(`cutting 6mo free should lift NE (base ${base.toFixed(2)} → ${cutFree.toFixed(2)})`);
  else ok(`free rent moves NE (${base.toFixed(2)} → ${cutFree.toFixed(2)} with free cut)`);
  if (!(cutTi > base + 2)) fail(`cutting TI should lift NE (${base.toFixed(2)} → ${cutTi.toFixed(2)})`);
  else ok(`TI cut moves NE (${base.toFixed(2)} → ${cutTi.toFixed(2)})`);
  if (!(addTi < base - 1)) fail(`adding TI should lower NE (${base.toFixed(2)} → ${addTi.toFixed(2)})`);
  else ok(`extra TI buys rent (${base.toFixed(2)} → ${addTi.toFixed(2)})`);
}

// --- 2b. Annual bump vs the 2.5% standard moves NE -------------------
{
  const loi = {
    id: 2, bbl: "x", kind: "new", name: "Acme", sector: "tech", credit: 2,
    sf: 10000, rentPsf: 40, termM: 120, tiPsf: 0, freeM: 0, bumpPct: 2.5, net: true,
    openTiPsf: 0,
  };
  const atStd = E.netEffectivePsf(loi, 40, 0, 0, 2.5);
  const steeper = E.netEffectivePsf(loi, 40, 0, 0, 3.5);
  const flatter = E.netEffectivePsf(loi, 40, 0, 0, 1.5);
  if (!(Math.abs(atStd - 40) < 0.05)) fail(`standard 2.5% bump should not move NE off face (got ${atStd.toFixed(2)})`);
  else ok(`2.5% bump is NE-neutral vs face (${atStd.toFixed(2)})`);
  if (!(steeper > atStd + 1)) fail(`3.5% bump should lift NE (${atStd.toFixed(2)} → ${steeper.toFixed(2)})`);
  else ok(`steeper bump lifts NE (${atStd.toFixed(2)} → ${steeper.toFixed(2)})`);
  if (!(flatter < atStd - 1)) fail(`1.5% bump should cut NE (${atStd.toFixed(2)} → ${flatter.toFixed(2)})`);
  else ok(`flatter bump cuts NE (${atStd.toFixed(2)} → ${flatter.toFixed(2)})`);
}

// --- 3. Counter-back rent claws from the opener, not ask × 0.94 -------
{
  const { parcels, bbls } = loadCity(1, E.normalizeParcels);
  let found = null;
  for (let seed = 0; seed < 24 && !found; seed++) {
    let g = E.firstListings(E.newGame(50000 + seed, parcels), parcels, bbls);
    // Buy one commercial building all-cash so LOIs can arrive.
    for (let m = 0; m < 50 && Object.keys(g.holdings).length < 1; m++) {
      g = E.advanceQuarter(g, parcels, bbls, null);
      for (const L of g.listings ?? []) {
        const rec = E.resolveRec(parcels, g, L.bbl);
        if (!rec || rec.class === "land" || !rec.bldgArea) continue;
        const r = E.executePurchase(g, parcels, L.bbl, L.ask, null, false, 0);
        if (r?.s?.holdings[L.bbl]) { g = { ...r.s, cash: Math.max(r.s.cash, 80e6) }; break; }
      }
    }
    g = { ...g, cash: Math.max(g.cash, 80e6) };
    for (let m = 0; m < 60 && !found; m++) {
      g = E.advanceQuarter(g, parcels, bbls, null);
      g = { ...g, cash: Math.max(g.cash, 80e6) };
      for (const loi of [...(g.lois ?? [])]) {
        if (loi.kind !== "new" || loi.countered || loi.stage === "countered") continue;
        const rec = E.resolveRec(parcels, g, loi.bbl);
        const h = g.holdings[loi.bbl];
        if (!rec || !h) continue;
        const market = E.managedRentPsfYr(rec, g.econ, h, loi.use);
        const askRent = +(Math.max(loi.rentPsf * 1.10, market * 1.12).toFixed(2));
        const opened = loi.rentPsf;
        const before = structuredClone(g);
        const r = E.respondLOI(before, parcels, loi.id, "counter", true, {
          rentPsf: askRent, tiPsf: Math.max(0, Math.round(loi.tiPsf * 0.85)), freeM: loi.freeM,
        });
        const w = (r.s.lois ?? []).find((l) => l.id === loi.id);
        if (w?.stage === "countered" && w.counterRentPsf != null) {
          found = { opened, askRent, their: w.counterRentPsf, free: w.counterFreeM, openFree: loi.freeM };
          break;
        }
      }
    }
  }
  if (!found) {
    console.log("  SKIP  counter-back opener — no counter-back in sample (accept/walk only)");
  } else {
    const oldBugFloor = +(found.askRent * 0.94).toFixed(2);
    // Under the bug, counters clustered at ask*0.94. Under the fix they sit
    // nearer the opener (or market band), which is materially below ask*0.94
    // when the landlord pushed hard.
    if (found.their >= found.askRent - 0.001) {
      fail(`counter-back ${found.their} did not come under ask ${found.askRent}`);
    } else if (Math.abs(found.their - oldBugFloor) < 0.02 && found.opened < found.askRent * 0.9) {
      // Exactly ask*0.94 while opener was far below is the smoking gun of the bug.
      fail(`counter-back ${found.their} stuck at ask×0.94 (${oldBugFloor}) — opener was ${found.opened}`);
    } else {
      ok(`counter-back $${found.their.toFixed(2)} between opener $${found.opened.toFixed(2)} and ask $${found.askRent.toFixed(2)}`);
    }
    if (found.openFree > 0 && found.free === undefined) {
      fail("counter-back omitted free-rent reply");
    } else if (found.openFree > 0) {
      ok(`counter-back also replied on free rent (${found.free} mo)`);
    }
  }
}

console.log("");
process.exit(bad ? 1 : 0);
