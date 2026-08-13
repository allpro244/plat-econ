// Player mortality + estate — Phase 5.
//   pnpm engine && node test/principal-estate.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

// Tax arithmetic.
{
  ok("under exclusion → $0", E.estateTaxOn(E.ESTATE_EXEMPTION) === 0);
  ok("under exclusion by $1 → $0", E.estateTaxOn(E.ESTATE_EXEMPTION - 1) === 0);
  const over = E.ESTATE_EXEMPTION + 10_000_000;
  ok("40% above exclusion", E.estateTaxOn(over) === Math.round(10_000_000 * 0.40));
}

// Start-life pairing.
{
  ok("1M → age 28", E.lifeForCash(1_000_000).age === 28);
  ok("20M → age 52", E.lifeForCash(20_000_000).age === 52);
  const g = E.newGame(1, parcels, 20_000_000);
  ok("newGame seats age 52", E.ageYears(g.principal, 0) === 52);
}

// Death → heir, no gameOver, phone book cleared, bench kept, step-up, bill.
{
  let g = E.firstListings(E.newGame(4242, parcels, 5_000_000), parcels, bbls);
  // Put a building on the book with a basis below mark.
  const bbl = bbls.find((b) => {
    const r = E.resolveRec(parcels, g, b);
    return r && r.class !== "land" && r.bldgArea > 20_000;
  });
  ok("have a building", !!bbl);
  const mark = E.ownedHoldingValue(g, parcels, {
    bbl, tenants: [], condition: "standard", boughtM: 0, costBasis: 1, deprTaken: 500_000,
  });
  g.holdings[bbl] = {
    bbl, tenants: [], condition: "standard", boughtM: 0,
    costBasis: Math.round(mark * 0.4), deprTaken: 500_000,
  };
  g.staff = [{
    id: 1, name: "Bench Partner", role: "pm", bornM: -40 * 12, diesM: 9999,
    attrs: { judgment: 70, urgency: 70, diligence: 70, relationships: 70, costControl: 70, tenantCare: 70 },
    obs: {}, salary: 120_000, hiredM: 0, band0: 12, seat: "employee",
  }];
  g.sponsor = { events: [{ m: 0, kind: "close", weight: 1 }] };
  g.lenderRel = { harbor: { score: 0.8 } };
  g.street = { r0: { deals: 2, beats: 0, insults: 0, lastM: 0 } };
  g.hireReputation = 0.2;

  const deadName = g.principal.name;
  const basisBefore = g.holdings[bbl].costBasis;
  g.principal.diesM = g.month;
  const rng0 = g.rng;
  E.settlePlayerEstate(g, parcels);

  ok("gameOver not set", g.gameOver == null);
  ok("decedent recorded", g.principal.name !== deadName);
  ok("heir seated", g.principal.seat === "you" && g.principal.diedM === undefined);
  ok("bench survived", (g.staff ?? []).length === 1 && g.staff[0].name === "Bench Partner");
  ok("sponsor wiped", (g.sponsor?.events ?? []).length === 0);
  ok("lenderRel wiped", Object.keys(g.lenderRel ?? {}).length === 0);
  ok("street wiped", Object.keys(g.street ?? {}).length === 0);
  ok("hireReputation reset", g.hireReputation === 0.55);
  ok("basis stepped up", g.holdings[bbl].costBasis > basisBefore);
  ok("deprTaken cleared", (g.holdings[bbl].deprTaken ?? 0) === 0);
  ok("estate bill present", !!g.estateDue && g.estateDue.remaining >= 0);
  ok("s.rng untouched", g.rng === rng0);
  ok("news names death and heir", (g.news ?? []).some((n) => /died/.test(n.text) && /continue as/i.test(n.text)));
}

// §6166 election + instalment ticks without gameOver.
{
  let g = E.firstListings(E.newGame(99, parcels, 20_000_000), parcels, bbls);
  // Inflate NW via cash so tax is positive even without a book.
  g.cash = 50_000_000;
  g.principal.diesM = g.month;
  E.settlePlayerEstate(g, parcels);
  ok("tax assessed on rich estate", (g.estateDue?.tax ?? 0) > 0, String(g.estateDue?.tax));
  const r = E.elect6166(g);
  ok("6166 elects", !r.err && r.s.estateDue?.elect6166);
  g = r.s;
  const before = g.estateDue.remaining;
  const cash0 = g.cash;
  E.tickEstateBill(g);
  ok("instalment paid", g.estateDue.remaining < before && g.cash < cash0);
  ok("still not game over", g.gameOver == null);
}

// Advance through a forced death — world keeps ticking.
{
  let g = E.firstListings(E.newGame(33, parcels), parcels, bbls);
  g.principal.diesM = 2;
  for (let i = 0; i < 6; i++) g = E.advanceMonth(g, parcels, bbls, adjacency);
  ok("month advanced past death", g.month === 6);
  ok("alive after succession", g.gameOver == null && g.principal.seat === "you");
}

console.log(`\n${fails === 0 ? "principal-estate pass" : `${fails} principal-estate failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
