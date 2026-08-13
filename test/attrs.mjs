// Temperament contract — every attr bites; player is on the org chart.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels } = loadCity(0, E.normalizeParcels);

function ok(label, cond) {
  if (!cond) throw new Error(`FAIL  ${label}`);
  console.log(`  OK   ${label}`);
}

let g = E.firstListings(E.newGame(550991, parcels), parcels, Object.keys(parcels));
ok("principal seated", g.principal?.seat === "you");
ok("principal has four temperament attrs",
  ["judgment", "urgency", "diligence", "relationships"]
    .every((k) => typeof g.principal.attrs[k] === "number"));

ok("Deal sense label", E.ATTR_LABEL_PERSON.judgment === "Deal sense");
ok("Bandwidth label", E.ATTR_LABEL_PERSON.urgency === "Bandwidth");
ok("Rigor label", E.ATTR_LABEL_PERSON.diligence === "Rigor");
ok("Access label", E.ATTR_LABEL_PERSON.relationships === "Access");

const skillMid = E.principalDeskSkill(g, "pm");
const expected = E.meanAttrs(g.principal.attrs, ["diligence", "judgment"]);
ok("principalDeskSkill = Rigor+Deal sense mean", Math.abs(skillMid - expected) < 1e-9);
ok("float skill uses principal (not 42)",
  Math.abs(E.floatRoleState(g, parcels, "pm").skill - skillMid) < 1e-9);
ok("empty-book float is not hardcoded 42 when attrs ≠ 42",
  skillMid === 42 || Math.abs(E.floatRoleState(g, parcels, "pm").skill - 42) > 0.5);

g.principal.attrs.urgency = 50;
const style = E.effectiveOwnerStyle(g);
const shape = style === "handsOn" ? 1.35 : style === "delegated" ? 0.72 : 1;
const cap50 = E.ownerCapacitySf(g, "pm");
ok("Bandwidth 50 centres owner capacity", Math.abs(cap50 / (E.OWNER_SF * shape) - 1) < 0.02);
g.principal.attrs.urgency = 90;
const cap90 = E.ownerCapacitySf(g, "pm");
g.principal.attrs.urgency = 20;
const cap20 = E.ownerCapacitySf(g, "pm");
ok("Bandwidth 90 > 50 > 20", cap90 > cap50 && cap50 > cap20);

g.principal.attrs.judgment = 90;
ok("empty leasing pen uses Deal sense", E.deskJudgment(g, "leasing") === 90);
g.principal.attrs.judgment = 40;
g.principal.attrs.relationships = 60;
ok("empty negotiation = (Deal sense + Access) / 2",
  Math.abs(E.deskNegotiation(g) - 50) < 1e-9);

ok("tenantCare falls back to Rigor+Access",
  Math.abs(E.attrValue({ diligence: 80, relationships: 40 }, "tenantCare") - 60) < 1e-9);
ok("negotiation falls back to Deal sense+Access",
  Math.abs(E.attrValue({ judgment: 70, relationships: 50 }, "negotiation") - 60) < 1e-9);

const before = g.staffRng;
const c = E.generateCandidate(g, "pm", 18);
ok("new hire stores temperament only",
  !("costControl" in c.attrs) && typeof c.attrs.judgment === "number");
ok("new hire obs temperament only",
  !("tenantCare" in c.obs) && typeof c.obs.diligence === "number");
ok("staffRng advanced on hire generation", g.staffRng !== before);

const st = {
  id: 99, role: "pm", name: "Probe", salary: 1, askSalary: 1, seat: "employee",
  hiredM: 0,
  attrs: { judgment: 80, urgency: 50, diligence: 50, relationships: 50 },
  obs: { judgment: 40, urgency: 50, diligence: 50, relationships: 50 },
  band0: 20,
};
const at = 12; // twelve months watched
const slow = E.readAttr(st, "judgment", at, 20);
const fast = E.readAttr(st, "judgment", at, 90);
ok("higher Rigor narrows band faster", (fast.hi - fast.lo) < (slow.hi - slow.lo));
ok("higher Rigor mid closer to truth", Math.abs(fast.mid - 80) < Math.abs(slow.mid - 80));

// Phase 5 — firm capital
const fc = E.firmCapital(g);
ok("firm capital tier in 0..5", fc.tier >= 0 && fc.tier <= 5);
ok("process mult in [1, 1.08]", fc.processCapacityMult >= 1 && fc.processCapacityMult <= 1.08 + 1e-9);
ok("six pillars", fc.pillars.length === 6);
g.principal.attrs.urgency = 50;
const capBase = E.ownerCapacitySf(g, "pm");
// Bump firm capital score via fake clean exits + hire rep
g.hireReputation = 0.9;
g.exits = Array.from({ length: 8 }, (_, i) => ({
  bbl: `x${i}`, address: "x", boughtM: 0, soldM: 1, price: 2e6, basis: 1e6, gain: 1e6,
}));
const fc2 = E.firmCapital(g);
const capMature = E.ownerCapacitySf(g, "pm");
ok("mature firm process raises owner cover", capMature >= capBase);
ok("more exits raise firm capital score", fc2.score > fc.score);

// Phase 7 — rival temperament weight
const rival = (g.rivals ?? []).find((r) => r.failedM === undefined);
ok("have a living rival", !!rival);
if (rival) {
  const mid = E.rivalTemperamentWeight(
    { rivalPrincipals: { [rival.id]: { attrs: { urgency: 50, relationships: 50 } } } },
    rival,
  );
  const hot = E.rivalTemperamentWeight(
    { rivalPrincipals: { [rival.id]: { attrs: { urgency: 90, relationships: 90 } } } },
    rival,
  );
  const cold = E.rivalTemperamentWeight(
    { rivalPrincipals: { [rival.id]: { attrs: { urgency: 20, relationships: 20 } } } },
    rival,
  );
  ok("mid temperament weight ≈ 1", Math.abs(mid - 1) < 0.02);
  ok("hot principal contests harder than cold", hot > cold);
}

console.log("\nattrs pass");
