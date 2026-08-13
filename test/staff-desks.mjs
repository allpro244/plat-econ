// STAFF DESK OVERHAUL — assignment is load, outside coverage is not payroll.
//
//   pnpm engine && node test/staff-desks.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, bbls } = loadCity(0, E.normalizeParcels);
const clone = () => JSON.parse(JSON.stringify(P0));
let fails = 0;
const ok = (name, pass, detail) => {
  console.log(`  ${pass ? "OK   " : "FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) fails++;
};

const parcels = clone();
const g0 = E.firstListings(E.newGame(4242, parcels), parcels, bbls);

// Pick two sizeable operated buildings for assignment tests.
const ops = [];
for (const b of bbls) {
  const r = E.resolveRec(parcels, g0, b);
  if (!r || r.class === "land" || !r.bldgArea || r.bldgArea < 20_000) continue;
  if (r.class === "multifamily") continue;
  ops.push({ bbl: b, sf: r.bldgArea, address: r.address });
  if (ops.length >= 4) break;
}
if (ops.length < 2) {
  console.error("need two commercial buildings");
  process.exit(1);
}
const [a, b] = ops;

function bookWith(staff, extra = {}) {
  const holdings = {};
  for (const o of ops) {
    holdings[o.bbl] = {
      bbl: o.bbl, boughtM: 0, costBasis: 1, condition: "average",
      tenants: [], loan: null, assessed: 1, condIdx: 0.7, svcIdx: 0.7,
      service: 0, stance: 0, plan: 1, cfHistory: [],
    };
  }
  return { ...g0, holdings, staff, ...extra };
}

const star = (id, role, assignedBbls) => ({
  id, name: `Hire${id}`, role, hiredM: 0, salary: 120_000, band0: 26,
  attrs: {
    judgment: 90, urgency: 90, diligence: 90, relationships: 90,
    costControl: 90, tenantCare: 90, marketKnowledge: 90, negotiation: 90,
    scheduling: 90,
  },
  obs: {},
  assignedBbls,
});

console.log("\nSTAFF DESKS — load-bearing assignment, CM jobs, pen model\n");

// 1. Pin every leasing hire to building A → B is uncovered on the float.
{
  const g = bookWith([star(1, "leasing", [a.bbl])]);
  const float = E.floatRoleState(g, parcels, "leasing");
  const person = E.personRoleState(g, parcels, g.staff[0]);
  const coverA = E.deskCoverage({ ...g, teamLeasing: true }, a.bbl);
  const coverB = E.deskCoverage({ ...g, teamLeasing: true }, b.bbl);
  ok("assigned hire loads only their pinned SF", person.covered > 0 && person.covered === E.workSfAt(g, parcels, a.bbl, "leasing"));
  ok("unpinned building sits on float / owner", (float.uncoveredN ?? 0) >= 1);
  ok("team pen covers pinned building", !!coverA && coverA.kind === "staff");
  ok("team pen does NOT cover unpinned building when every hire is pinned", coverB === null);
}

// 2. Float hire covers the whole unassigned book.
{
  const g = bookWith([star(1, "leasing", undefined)]);
  const float = E.floatRoleState(g, parcels, "leasing");
  const coverB = E.deskCoverage({ ...g, teamLeasing: true }, b.bbl);
  ok("float hire covers unassigned book", float.covered > E.workSfAt(g, parcels, a.bbl, "leasing"));
  ok("float hire holds pen on unpinned deeds when handed over", !!coverB);
}

// 3. Construction assignment to a live job.
{
  const jobBbl = a.bbl;
  const g = bookWith([star(1, "construction", undefined)], {
    developments: {
      [jobBbl]: {
        bbl: jobBbl, use: "office", sf: 180_000, floors: 12,
        startM: 0, deliverM: 24, costTotal: 40_000_000, hardCost: 32_000_000,
        equityBudget: 12_000_000, equitySpent: 1, loanBalance: 0, ratePct: 7,
        contingency: 2_000_000, contingencyUsed: 0, events: 0, contract: "gmp",
      },
    },
  });
  const r = E.assignStaff(g, 1, jobBbl);
  ok("CM can be assigned to a live job", !r.err && r.s.staff[0].assignedBbls?.includes(jobBbl), r.err);
  const refuse = E.assignStaff(g, 1, b.bbl);
  ok("CM cannot be assigned where nothing is in the ground", !!refuse.err);
  const cover = E.coverRoleState(r.s, parcels, jobBbl, "construction");
  ok("assigned CM is the cover on that job", cover.staff?.id === 1);
}

// 4. Firing last leasing hire clears teamLeasing.
{
  const g = bookWith([star(1, "leasing", undefined)], { teamLeasing: true, cash: 5_000_000 });
  const r = E.fire(g, 1);
  ok("fire last leasing hire clears teamLeasing", !r.err && !r.s.teamLeasing, r.err);
}

// 5. Outside agent judgment is mid — not your star hire.
{
  const g = bookWith([star(1, "leasing", undefined)], { agent: true });
  ok("penJudgment for agent is mid", E.penJudgment(g, "agent") === E.OUTSIDE_DESK_JUDGMENT);
  ok("deskJudgment still reads the hire", E.deskJudgment(g, "leasing") > 80);
  ok("penJudgment for staff uses hire", E.penJudgment(g, "staff") > 80);
  ok("penNegotiation for exclusive is mid", E.penNegotiation(g, "exclusive") === E.OUTSIDE_DESK_NEGOTIATION);
}

// 6. Firm shape emerges from headcount when unset.
{
  const alone = bookWith([]);
  const platform = bookWith([1, 2, 3, 4, 5].map((i) => star(i, "pm", undefined)));
  ok("empty payroll reads hands-on", E.effectiveOwnerStyle(alone) === "handsOn");
  ok("five hires read platform", E.effectiveBenchStyle(platform) === "platform");
  const forced = bookWith([], { ownerStyle: "delegated" });
  ok("explicit ownerStyle overrides emergence", E.effectiveOwnerStyle(forced) === "delegated");
}

// 7. deskBacklog surfaces uncovered SF.
{
  const g = bookWith([star(1, "pm", [a.bbl])]);
  const bl = E.deskBacklog(g, parcels, "pm", 1_000_000);
  ok("backlog reports uncovered buildings when every PM is pinned", (bl.uncoveredN ?? 0) >= 1);
}

console.log(`\n${fails === 0 ? "staff-desks pass" : `${fails} staff-desks failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
