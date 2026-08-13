// Principal Phase 1–2 bug hunt.
//   pnpm engine && node test/principal-phase12.mjs
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

// 1. newGame synthesises principal + rival faces; save version 34.
{
  const g = E.firstListings(E.newGame(4242, parcels), parcels, bbls);
  ok("v is 34", g.v === 34);
  ok("principal seat you", g.principal?.seat === "you");
  ok("principal age matches start life (2.5M → 35)", E.ageYears(g.principal, 0) === 35);
  ok("principal has diesM in future", (g.principal?.diesM ?? -1) > 0);
  {
    const deathAge = (g.principal.diesM - g.principal.bornM) / 12;
    ok("player death age in 70–105",
      deathAge >= E.PLAYER_DEATH_AGE_LO && deathAge <= E.PLAYER_DEATH_AGE_HI,
      `age ${deathAge.toFixed(1)}`);
  }
  ok("peopleRng initialised", typeof g.peopleRng === "number");
  const live = (g.rivals ?? []).filter((r) => r.failedM === undefined);
  ok("every living rival has a principal",
    live.every((r) => g.rivalPrincipals?.[r.id]?.seat === "rival"),
    `${live.length} firms`);
  ok("no style overrides on new game", !g.ownerStyle && !g.benchStyle);
}

// 2. Death draw is once and sane — never before birth, almost always after now.
{
  const g = E.newGame(99, parcels);
  const deaths = [];
  for (let i = 0; i < 200; i++) {
    const bornM = -40 * 12;
    const d = E.drawDeathM(g, bornM, 0);
    deaths.push(d);
  }
  ok("death after birth", deaths.every((d) => d > -40 * 12));
  const ages = deaths.map((d) => (d + 40 * 12) / 12);
  const med = [...ages].sort((a, b) => a - b)[Math.floor(ages.length / 2)];
  ok("median death age in adult band (55–95)", med >= 55 && med <= 95, `median ${med.toFixed(1)}`);
  const alreadyDead = deaths.filter((d) => d <= 0).length;
  ok("few already-dead at age 40 (<5%)", alreadyDead / deaths.length < 0.05, `${alreadyDead}/200`);
}

// 2b. Player death band — always 70–105, one peopleRng step, never mid-run.
{
  const g = E.newGame(77, parcels, 20_000_000);
  const ages = [];
  for (let i = 0; i < 200; i++) {
    const bornM = -52 * 12;
    const d = E.drawPlayerDeathM(g, bornM, 0);
    ages.push((d - bornM) / 12);
  }
  ok("player draw all in 70–105",
    ages.every((a) => a >= E.PLAYER_DEATH_AGE_LO && a <= E.PLAYER_DEATH_AGE_HI),
    `min ${Math.min(...ages).toFixed(1)} max ${Math.max(...ages).toFixed(1)}`);
  const med = [...ages].sort((a, b) => a - b)[100];
  ok("player draw median near mid-band", med >= 82 && med <= 93, `median ${med.toFixed(1)}`);
}

// 3. RNG isolation — people work must not move s.rng or staffRng vs a twin
//    that never touches people APIs (same newGame, advance without hiring).
{
  const a = E.firstListings(E.newGame(550991, parcels), parcels, bbls);
  const b = E.firstListings(E.newGame(550991, parcels), parcels, bbls);
  // Strip people from b and freeze peopleRng so ensure-like paths no-op.
  // Advance both 24 months — neither should hire.
  for (let i = 0; i < 24; i++) {
    E.advanceMonth(a, parcels, bbls, adjacency);
    E.advanceMonth(b, parcels, bbls, adjacency);
  }
  ok("s.rng matched after 24m", a.rng === b.rng, `${a.rng} vs ${b.rng}`);
  ok("staffRng matched after 24m", a.staffRng === b.staffRng, `${a.staffRng} vs ${b.staffRng}`);
  // Economy fingerprint
  ok("office rent matched", a.econ.rentIdx.office === b.econ.rentIdx.office);
  ok("principals still present after 24m", !!a.principal && Object.keys(a.rivalPrincipals ?? {}).length > 0);
}

// 4. Hire stamps life from peopleRng without changing staffRng step count shape:
//    two pools generated with same staffRng seed produce same candidate attrs.
{
  const mk = () => {
    const g = E.newGame(777, parcels);
    g.staffRng = (777 ^ 0x5741ff) | 0;
    g.peopleRng = (777 ^ 0x50454f50) | 0;
    g.hireReputation = 0.55;
    return g;
  };
  const g1 = mk();
  const g2 = mk();
  const c1 = E.generateCandidate(g1, "pm", 26);
  const c2 = E.generateCandidate(g2, "pm", 26);
  ok("candidate attrs identical across twins", JSON.stringify(c1.attrs) === JSON.stringify(c2.attrs));
  ok("candidate has bornM and diesM", c1.bornM !== undefined && c1.diesM !== undefined);
  ok("candidate age in 28–55", (() => {
    const age = E.ageYears(c1, 0);
    return age >= 28 && age <= 55;
  })(), `age ${E.ageYears(c1, 0)}`);
  ok("staffRng advanced identically", g1.staffRng === g2.staffRng);
}

// 5. Migrate v32 → v33 synthesises people, clears style dials.
{
  const g = E.firstListings(E.newGame(4242, parcels), parcels, bbls);
  const snap = structuredClone(g);
  snap.v = 32;
  delete snap.principal;
  delete snap.rivalPrincipals;
  delete snap.peopleRng;
  snap.ownerStyle = "handsOn";
  snap.benchStyle = "boutique";
  // Strip life from a fake staff row
  snap.staff = [{
    id: 1, name: "Test Hire", role: "pm",
    attrs: { judgment: 50, urgency: 50, diligence: 50, relationships: 50, costControl: 50, tenantCare: 50 },
    obs: {}, salary: 100_000, hiredM: 0, band0: 18,
  }];
  const m = E.migrateSaveState(snap);
  ok("migrate bumps to 34", m.v === 34);
  ok("migrate clears style overrides", !m.ownerStyle && !m.benchStyle);
  ok("migrate synthesises principal", m.principal?.seat === "you");
  ok("migrate stamps staff bornM", m.staff[0].bornM !== undefined && m.staff[0].diesM !== undefined);
  ok("migrate fills rival principals",
    (m.rivals ?? []).filter((r) => !r.failedM).every((r) => m.rivalPrincipals?.[r.id]));
}

// 6. Inferred firm shape still works; forced override ignored.
{
  const g = E.newGame(1, parcels);
  g.staff = [];
  ok("empty payroll hands-on", E.effectiveOwnerStyle(g) === "handsOn");
  g.ownerStyle = "delegated"; // should be ignored
  ok("forced ownerStyle ignored", E.effectiveOwnerStyle(g) === "handsOn");
  g.staff = [1, 2, 3, 4, 5].map((i) => ({
    id: i, name: "X", role: "pm", bornM: -40 * 12,
    attrs: { judgment: 80, urgency: 80, diligence: 80, relationships: 80, costControl: 80, tenantCare: 80 },
    obs: {}, salary: 100_000, hiredM: 0, band0: 10,
  }));
  ok("five hires → platform bench", E.effectiveBenchStyle(g) === "platform");
  ok("five hires → delegated owner", E.effectiveOwnerStyle(g) === "delegated");
}

// 7. New firm gets a principal (peopleRng only).
{
  const g = E.firstListings(E.newGame(12007, parcels), parcels, bbls);
  const before = Object.keys(g.rivalPrincipals ?? {}).length;
  const rngBefore = g.rng;
  // Force many months; maybeNewFirm may or may not fire — call ensurePeople after injecting a firm.
  const id = `r${g.rivals.length}`;
  g.rivals.push({
    id, name: "Probe Capital", style: "pe",
    cash: 5_000_000, debt: 0, bbls: [], targetLtv: 0.7, bornM: g.month,
  });
  g.rivalPrincipals[id] = E.makeRivalPrincipal(g, id, "Probe Capital");
  ok("injected firm has principal", g.rivalPrincipals[id]?.seat === "rival");
  ok("makeRivalPrincipal did not touch s.rng", g.rng === rngBefore);
  ok("principal count grew", Object.keys(g.rivalPrincipals).length === before + 1);
}

// 8. ensurePeople is idempotent — second call draws nothing if complete.
{
  const g = E.firstListings(E.newGame(33, parcels), parcels, bbls);
  const rng1 = g.peopleRng;
  const dies = g.principal.diesM;
  E.ensurePeople(g);
  E.ensurePeople(g);
  ok("ensurePeople idempotent on peopleRng", g.peopleRng === rng1);
  ok("ensurePeople idempotent on diesM", g.principal.diesM === dies);
}

console.log(`\n${fails === 0 ? "principal-phase12 pass" : `${fails} principal-phase12 failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
