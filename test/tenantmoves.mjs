// THE TENANT WHO OUTGROWS THE SUITE — and the one who shrinks out of it.
//
//   pnpm engine && pnpm tenantmoves
//
// t.staff has tracked growth and contraction for a while and the rent roll
// prints it. This asserts that something HAPPENS: a growing tenant writes for
// the space next door (an expansion letter you can sign), and a genuinely
// shrunk one writes to hand space back (a surrender you can take or refuse).
// Both are decisions with both answers priced, not flavour.
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

// a plain office building with room to grow into
const site = bbls.find((b) => {
  const r = parcels[b];
  return r?.class === "office" && r.bldgArea > 60_000 && r.bldgArea < 300_000;
});
if (!site) throw new Error("no suitable office building in the city fixture");
const rec0 = parcels[site];

/** A campaign with one holding and one tenant on half the building. */
function seedGame(seed, staff) {
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  g = { ...g, cash: 30_000_000 };
  const sfT = Math.round(rec0.bldgArea * 0.5);
  g.holdings[site] = {
    bbl: site, boughtM: g.month, costBasis: 20_000_000, assessed: 20_000_000,
    condition: "average", condIdx: 0.7, svcIdx: 0.7,
    tenants: [{
      name: "Meridian Underwriting", sector: "insurance", credit: 1,
      sf: sfT, rentPsf: 38, net: true, recovery: "nnn",
      startM: g.month, endM: g.month + 60, use: "office", staff, deposit: 0,
    }],
    loan: null, cfHistory: [], service: 0, plan: 1,
  };
  return g;
}
const advance = (g, n) => {
  for (let i = 0; i < n; i++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
  return g;
};

// ---- 1 · the grower writes for the floor above -----------------------------
{
  let g = seedGame(9001, 1.6);
  let offer = null;
  for (let m = 0; m < 48 && !offer; m++) {
    g = advance(g, 1);
    offer = (g.lois ?? []).find((l) => l.bbl === site && l.kind === "expansion");
  }
  ok("growing tenant writes an expansion letter", !!offer,
    offer ? `month ${g.month}, ${(offer.sf / 1000).toFixed(1)}k sf coterminous` : "none in 48 months");
  if (offer) {
    const h = g.holdings[site];
    const before = h.tenants[0].sf;
    const rec = E.resolveRec(parcels, g, site);
    E.signLoi(g, rec, h, offer);
    ok("accepting grows the suite", h.tenants[0].sf > before,
      `${(before / 1000).toFixed(1)}k -> ${(h.tenants[0].sf / 1000).toFixed(1)}k sf`);
  }
}

// ---- 2 · the shrinker writes to give space back ----------------------------
{
  let g = seedGame(9002, 0.45);
  let ask = null;
  for (let m = 0; m < 72 && !ask; m++) {
    g = advance(g, 1);
    ask = (g.asks ?? []).find((a) => a.bbl === site && a.kind === "giveback");
  }
  ok("shrunk tenant offers a surrender", !!ask,
    ask ? `month ${g.month}, ${((ask.giveSf ?? 0) / 1000).toFixed(1)}k sf back` : "none in 72 months");
  if (ask) {
    // decline first, on a fork: the lease stands and the tenant runs strained
    const declined = E.answerAsk(structuredClone(g), parcels, ask.id, "decline");
    const tD = declined.s.holdings[site].tenants[0];
    ok("declining strains the tenant (default risk is priced)", tD.strainedM === declined.s.month);
    ok("declining leaves the suite whole", tD.sf === g.holdings[site].tenants[0].sf);

    // grant on the main line: the suite shrinks and the space turns
    const before = g.holdings[site].tenants[0].sf;
    const cashBefore = g.cash;
    const granted = E.answerAsk(g, parcels, ask.id, "grant");
    ok("surrender signs", !granted.err, granted.err ?? "");
    if (!granted.err) {
      const h2 = granted.s.holdings[site];
      const t2 = h2.tenants[0];
      ok("suite shrinks by the surrendered space", t2.sf === before - (ask.giveSf ?? 0),
        `${(before / 1000).toFixed(1)}k -> ${(t2.sf / 1000).toFixed(1)}k sf`);
      ok("the space lands in make-ready", (h2.makeReady ?? []).some((m) => m.sf === ask.giveSf));
      ok("the lawyer was paid through the ledger", granted.s.cash < cashBefore);
      ok("the tenant now fits what they hold", (t2.staff ?? 1) * t2.sf <= t2.sf * 1.05 + 1);
    }
  }
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
