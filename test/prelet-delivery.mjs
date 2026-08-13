// Construction pre-lets must land on the rent roll at delivery — never vanish.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);

let lost = 0, checked = 0, underFloor = 0;
for (const seed of [1, 2, 3, 7, 11, 19, 29, 41, 53, 59, 67, 71, 83, 97]) {
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  g = { ...g, cash: g.cash + 100e6 };
  let lot = null, use = null, fl = null;
  for (const bbl of bbls) {
    const rec = parcels[bbl];
    if (!rec || rec.class !== "land" || rec.lotArea < 4000) continue;
    if (g.holdings[bbl] || g.built?.[bbl]) continue;
    for (const u of ["office", "retail", "industrial"]) {
      for (const f of [6, 8, 4, 10]) {
        const p = E.planDevelopment(g, parcels, bbl, u, f, 0.65, "gmp");
        if (p && p.sf > 10000 && p.equity < 80e6) { lot = bbl; use = u; fl = f; break; }
      }
      if (lot) break;
    }
    if (lot) break;
  }
  if (!lot) continue;
  const price = Math.round(E.landValue(parcels[lot], g.econ) * 1.02);
  g = {
    ...g,
    cash: g.cash - price,
    holdings: {
      ...g.holdings,
      [lot]: {
        bbl: lot, boughtM: 0, costBasis: price, condition: "average",
        tenants: [], loan: null, assessed: price, condIdx: 0.55, svcIdx: 0.55,
        service: 0, stance: 0, plan: 1, cfHistory: [],
      },
    },
  };
  const started = E.startDevelopment(g, parcels, lot, use, fl, 0.65, "gmp");
  if (started.err) continue;
  g = started.s;
  const signed = [];
  for (let i = 0; i < 80 && g.developments[lot]; i++) {
    const before = (g.developments[lot].signed || []).length;
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const after = g.developments[lot]?.signed || [];
    if (after.length > before) {
      for (const sg of after.slice(before)) {
        signed.push(sg);
        if (sg.sf < 2000) underFloor++;
      }
    }
  }
  if (!g.built?.[lot] || !signed.length) continue;
  checked++;
  const h = g.holdings[lot];
  const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
  const spoken = signed.reduce((a, x) => a + x.sf, 0);
  // Every pre-let sf should be on the roll (allowing small rounding).
  if (leased + 50 < spoken) {
    lost++;
    console.log("FAIL seed", seed, { spoken, leased, tenants: h.tenants.map((t) => `${t.use}:${t.sf}`), signed });
  }
}

console.log(JSON.stringify({ checked, lost, underFloorCreated: underFloor }, null, 2));
if (lost > 0 || underFloor > 0) process.exit(1);
console.log("ok");
