// LEASING MANDATE — sign / refer / pass bands on net effective.
//
//   pnpm exec node test/agent-mandate.mjs
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));

let bad = 0;
const fail = (m) => { bad++; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  OK    ${m}`);

console.log("\nLEASING MANDATE\n");

// Score: fat TI pulls net effective down vs face-only.
{
  const loi = {
    id: 1, bbl: "x", kind: "new", name: "Acme", sector: "tech", credit: 2,
    sf: 10000, rentPsf: 40, termM: 120, tiPsf: 60, freeM: 0, net: true,
  };
  const faceOnly = 40 / 40; // 1.0 if judged on face
  const score = E.loiMandateScore(loi, 40);
  if (!(score < 0.92)) fail(`fat TI should pull score under par (got ${score.toFixed(3)}, face would be ${faceOnly})`);
  else ok(`fat TI lowers mandate score (${score.toFixed(3)} vs face 1.00)`);
}

// Defaults: floor 90%, pass under it.
{
  const g = { agentFloor: undefined, agentPassBelow: undefined };
  const floor = E.agentFloor(g);
  const pass = E.agentPassBelow(g);
  if (Math.abs(floor - 0.90) > 0.001) fail(`default floor should be 90% (got ${(floor * 100).toFixed(0)}%)`);
  else ok(`default auto-sign floor is ${(floor * 100).toFixed(0)}% (was 82%)`);
  if (!(pass < floor - 0.015)) fail(`pass (${pass}) must sit under floor (${floor})`);
  else ok(`default counter band ${(pass * 100).toFixed(0)}%–${(floor * 100).toFixed(0)}% (desk negotiates)`);
}

// Total upfront cash includes commission, not only the line labelled TI.
{
  const loi = {
    id: 2, bbl: "x", kind: "new", name: "Long Paper", sector: "tech", credit: 2,
    sf: 10_000, rentPsf: 40, termM: 120, tiPsf: 20, freeM: 0, net: true,
  };
  const tiM = E.loiTiMonths(loi);
  const allM = E.loiSigningMonths(loi, E.AGENT_FEE);
  if (Math.abs(tiM - 6) > 0.01) fail(`TI should be 6.0 months (got ${tiM.toFixed(1)})`);
  else ok("TI is measured proportionately to face rent");
  if (!(allM > E.agentMaxSigningMonths({}) && allM > tiM)) {
    fail(`TI + commission should breach the default total cap (${allM.toFixed(1)} months)`);
  } else ok(`total upfront cash catches what TI-only misses (${allM.toFixed(1)} months)`);
}

// The desk protects operating liquidity even when one lease is individually fundable.
{
  const reserve = E.agentCashReserve({
    holdings: {
      a: { loan: { monthlyPmt: 40_000 } },
      b: { loan: { monthlyPmt: 20_000 } },
    },
    facility: null,
    loc: { balance: 0 },
    econ: { indexRate: 5 },
  });
  if (reserve !== 360_000) fail(`six months of $60K debt service should reserve $360K (got ${reserve})`);
  else ok("delegated desk protects six months of debt service");
}

// Refer leaves the letter; pass deletes it.
{
  const { loadCity } = await import(join(HERE, "city.mjs"));
  const { parcels, bbls } = loadCity(2, E.normalizeParcels);
  let g = E.firstListings(E.newGame(77001, parcels), parcels, bbls);
  g = { ...g, cash: 200e6, agent: true, agentFloor: 0.95, agentPassBelow: 0.80 };

  // Buy something and wait for an LOI.
  let loi = null;
  for (let m = 0; m < 90 && !loi; m++) {
    g = E.advanceQuarter(g, parcels, bbls, null);
    g = { ...g, cash: Math.max(g.cash, 200e6), agent: true, agentFloor: 0.95, agentPassBelow: 0.80 };
    for (const L of g.listings ?? []) {
      if (g.holdings[L.bbl]) continue;
      const rec = E.resolveRec(parcels, g, L.bbl);
      if (!rec || rec.class === "land" || !rec.bldgArea) continue;
      const r = E.executePurchase(g, parcels, L.bbl, L.ask, null, false, 0);
      if (r?.s?.holdings[L.bbl]) { g = { ...r.s, cash: 200e6, agent: true, agentFloor: 0.95, agentPassBelow: 0.80 }; break; }
    }
    loi = (g.lois ?? []).find((l) => l.kind === "new") ?? null;
  }
  if (!loi) {
    console.log("  SKIP  no LOI in window to exercise refer/pass");
  } else {
    // Force a mid-band letter: score between pass and floor by editing rent.
    const rec = E.resolveRec(parcels, g, loi.bbl);
    const h = g.holdings[loi.bbl];
    const market = E.managedRentPsfYr(rec, g.econ, h, loi.use);
    const mid = structuredClone(g);
    const target = mid.lois.find((l) => l.id === loi.id);
    target.rentPsf = +(market * 0.88).toFixed(2);
    target.tiPsf = 0;
    target.freeM = 0;
    target.referred = false;
    // One month of agent desk.
    mid.agent = true;
    mid.agentFloor = 0.95;
    mid.agentPassBelow = 0.80;
    // tickLeasing runs the agent — advance one month via advanceQuarter's internals
    // by calling through a month of sim if exported; else re-run via advanceQuarter.
    const after = E.advanceQuarter(mid, parcels, bbls, null);
    const still = (after.lois ?? []).find((l) => l.id === loi.id);
    const news = (after.news ?? []).slice(0, 12).map((n) => n.text).join(" ");
    const negotiated = !still
      || still.referred
      || still.countered
      || /countered|walked|referred|passed|took/i.test(news);
    if (negotiated) ok("mid-band letter was negotiated by the desk (not left untouched)");
    else fail("mid-band letter sat on the open pile with no desk action");

    // Even a permissive mandate may not choose between mutually-exclusive
    // tenants or commit adjacent space to an incumbent expansion.
    const choice = structuredClone(g);
    const base = choice.lois.find((l) => l.id === loi.id);
    base.tourId = 999;
    base.rentPsf *= 1.1;
    base.tiPsf = 0;
    base.freeM = 0;
    base.referred = false;
    const rival = { ...structuredClone(base), id: Math.max(...choice.lois.map((l) => l.id)) + 1, name: "Competing Tenant" };
    choice.lois = [base, rival];
    choice.agent = true;
    choice.agentFloor = 0.70;
    choice.agentPassBelow = 0.55;
    choice.agentMaxTiMonths = 18;
    choice.agentMaxSigningMonths = 24;
    const afterChoice = E.advanceQuarter(choice, parcels, bbls, null);
    const decided = afterChoice.lois.filter((l) => l.id === base.id || l.id === rival.id);
    if (decided.length === 2 && decided.every((l) => l.referred)) {
      ok("competitive tour is referred so the principal chooses the tenant");
    } else fail("agent chose a winner from a competitive tour");

    const expansion = structuredClone(g);
    const ex = expansion.lois.find((l) => l.id === loi.id);
    ex.kind = "expansion";
    ex.referred = false;
    ex.rentPsf *= 1.1;
    ex.tiPsf = 0;
    expansion.lois = [ex];
    expansion.agent = true;
    expansion.agentFloor = 0.70;
    expansion.agentPassBelow = 0.55;
    expansion.agentMaxSigningMonths = 24;
    const afterExpansion = E.advanceQuarter(expansion, parcels, bbls, null);
    if (afterExpansion.lois[0]?.referred) ok("incumbent expansion is referred to the principal");
    else fail("agent auto-signed an incumbent expansion");
  }
}

console.log("");
process.exit(bad ? 1 : 0);
