// SIGNING ON THE LINE MUST LAND ON THE LIVE RENT ROLL.
//
// When cash is short, respondLOI draws the LOC (a fresh clone) and then signs.
// The lease has to be written onto the holding AFTER that clone — otherwise
// Accept toasts "signed" while the real roll stays empty and new letters keep
// arriving for the same space.
//
//   pnpm engine && pnpm exec node test/loi-fund-sign.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
const bbl = bbls.find((x) => {
  const r = parcels[x];
  return r && r.class === "office" && r.bldgArea > 40_000 && (r.mix?.office ?? 1) > 0.8;
});
if (!bbl) throw new Error("No office parcel for LOI fund-sign harness.");
const rec = parcels[bbl];

let g = E.newGame(72111, parcels);
const price = Math.round(E.assetValue(rec, g.econ, "good"));
// Fat equity (unlevered deed) so the line will advance enough — but cash on
// hand is deliberately just short of the signing cheque.
g.holdings[bbl] = {
  bbl, boughtM: 0, costBasis: price, condition: "good",
  tenants: [], loan: null, assessed: price, condIdx: 0.85, svcIdx: 0.7,
  service: 0, stance: 0, plan: 1, cfHistory: [],
};
g.lois = [{
  id: 1, arrivedM: 0, bbl, kind: "new", use: "office",
  name: "Acme Desk Co", sector: "tech", credit: 1,
  sf: 8_000, rentPsf: 36, termM: 72, tiPsf: 30, freeM: 2,
  bumpPct: 2.5, net: true, expiresM: 6,
}];
g.nextLoiId = 2;
const need = E.loiSigningCost(g.lois[0], E.exclusiveFeeRate(g.holdings[bbl]));
g.cash = Math.max(1_000, need - 40_000);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nLOI SIGN AFTER LOC DRAW\n");

check(need > g.cash, `signing costs ${Math.round(need)} against cash ${g.cash} — must draw`);
const line = E.locAvailable(g, parcels);
check(line >= need - g.cash, `line advances at least the shortfall (line ${Math.round(line)})`);

const beforeSf = g.holdings[bbl].tenants.reduce((a, t) => a + t.sf, 0);
const vacBefore = E.useVacantSf(E.resolveRec(parcels, g, bbl) ?? rec, g.holdings[bbl], "office", g.month);
const r = E.respondLOI(g, parcels, 1, "accept", true);
check(!r.err, r.err ? `accept returned error: ${r.err}` : "accept returned no error");
const h = r.s.holdings[bbl];
check(!!h?.tenants.some((t) => t.name === "Acme Desk Co"),
  "tenant is on the live holding after the LOC draw");
check((h?.tenants ?? []).reduce((a, t) => a + t.sf, 0) > beforeSf,
  "rent-roll square footage rose on the live holding");
check((r.s.loc?.balance ?? 0) > 0, "line of credit was drawn to fund TI + commission");
check(!(r.s.lois ?? []).some((l) => l.id === 1), "letter left the desk");
check(/let/i.test(r.msg ?? ""), `success message reports occupancy (${r.msg})`);

const vac = E.useVacantSf(E.resolveRec(parcels, r.s, bbl) ?? rec, h, "office", r.s.month);
check(vac < vacBefore, `vacant office sf fell on the live holding (${Math.round(vacBefore)} → ${Math.round(vac)})`);

console.log("");
process.exit(bad ? 1 : 0);
