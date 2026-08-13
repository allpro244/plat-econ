// Build-to-suit is a listing: listing does not mint a tenant; the tick does.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, bbls } = loadCity(0, E.normalizeParcels);

function ownVacant(g, bbl) {
  const rec = parcels[bbl];
  const price = Math.round(E.landValue(rec, g.econ) * 1.02);
  const next = structuredClone(g);
  next.cash -= price;
  next.holdings[bbl] = {
    bbl, boughtM: 0, costBasis: price, condition: "average",
    tenants: [], loan: null, assessed: price, condIdx: 0.55, svcIdx: 0.55,
    service: 0, stance: 0, plan: 1, cfHistory: [],
  };
  return next;
}

const vacant = bbls.find((b) => {
  const r = parcels[b];
  return r && r.class === "land" && r.lotArea >= 8000 && !r.bldgArea;
});
if (!vacant) {
  console.error("no vacant lot");
  process.exit(1);
}

let g = E.firstListings(E.newGame(19, parcels), parcels, bbls);
g = { ...g, cash: g.cash + 80e6 };
g = ownVacant(g, vacant);

const listed = E.proposeBuildToSuit(g, parcels, vacant, "office", 12, 0.62);
if (listed.err) {
  console.error("FAIL list", listed.err);
  process.exit(1);
}
g = listed.s;
if (!g.holdings[vacant].btsOffer) {
  console.error("FAIL no btsOffer after list");
  process.exit(1);
}
if (g.btsProspects?.[vacant]) {
  console.error("FAIL instant tenant on list click");
  process.exit(1);
}

// Force arrival by hammering the tick with a clone that always rolls in —
// or advance many months. Prefer exercising tickBuildToSuit until one lands
// or we hit a ceiling; seed/rng is deterministic so a long enough run works.
let arrived = false;
for (let i = 0; i < 240; i++) {
  const next = structuredClone(g);
  E.tickBuildToSuit(next, parcels);
  g = next;
  if (g.btsProspects?.[vacant]) {
    arrived = true;
    break;
  }
  // Month must advance so signedM / news make sense; offer.sinceM stays.
  g = { ...g, month: g.month + 1 };
}
if (!arrived) {
  console.error("FAIL no BTS tenant in 240 months", {
    offer: g.holdings[vacant]?.btsOffer,
    phase: g.econ.phase,
  });
  process.exit(1);
}
if (g.holdings[vacant].btsOffer) {
  console.error("FAIL offer still up after commitment");
  process.exit(1);
}
const bts = g.btsProspects[vacant];
if (!bts?.name || bts.use !== "office" || bts.sf <= 0) {
  console.error("FAIL bad commitment", bts);
  process.exit(1);
}

const cleared = E.clearBuildToSuit(g, vacant);
if (cleared.btsProspects?.[vacant] || cleared.holdings[vacant]?.btsOffer) {
  console.error("FAIL clear left residue");
  process.exit(1);
}

// Relist after clear, then pull without a tenant.
let g2 = E.proposeBuildToSuit(cleared, parcels, vacant, "industrial", 4, 0.7).s;
if (!g2.holdings[vacant].btsOffer || g2.holdings[vacant].btsOffer.use !== "industrial") {
  console.error("FAIL relist", g2.holdings[vacant]?.btsOffer);
  process.exit(1);
}
g2 = E.clearBuildToSuit(g2, vacant);
if (g2.holdings[vacant]?.btsOffer) {
  console.error("FAIL pull left offer");
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  vacant,
  tenant: bts.name,
  sf: bts.sf,
  waitM: bts.signedM,
}));
