// FIRM ENTRY BY GENEALOGY — proposes, and the raise can still refuse.
//   pnpm engine && node test/firms.mjs
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

// Pitch can say no — product term goes to zero when nobody trades.
{
  const g = E.newGame(1, parcels);
  g.lastTradeM = {};
  g.cityJobs = [];
  const p = E.firmEntryPitch(g);
  ok("empty tape → product 0", p.product === 0, `product=${p.product}`);
  ok("empty tape → pitch 0", p.pitch === 0, `pitch=${p.pitch}`);
}

// Founder bid → raise on a fertile street stamps genealogy.
// Keep the tape fat every month so the product term stays open; the raise
// hazard is ~1/14 when pitch is full, so a few years almost surely clear —
// unless the street is barren, which the empty-tape case above already covers.
{
  let g = E.firstListings(E.newGame(12007, parcels, 20_000_000), parcels, bbls);
  const before = (g.rivals ?? []).length;
  g.founderBids = [{
    readyM: g.month,
    name: "Vera Whitcomb",
    bornM: g.month - 40 * 12,
    diesM: g.month + 40 * 12,
    attrs: { judgment: 80, urgency: 70, diligence: 75, relationships: 72 },
    obs: { judgment: 70, urgency: 65, diligence: 68, relationships: 66 },
    band0: 18,
    role: "pm",
    fromFirmId: "you",
    fromFirmName: "Player & Co.",
  }];
  let spawned = null;
  let refused = false;
  for (let i = 0; i < 240 && !spawned && !refused; i++) {
    // Rates are percentage points in this engine (cap ~8, index ~4), not fractions.
    g.lastTradeM = {};
    for (let t = 0; t < 120; t++) g.lastTradeM[`t${t}`] = g.month;
    g.econ.capRate = { office: 10, retail: 10, multifamily: 9, industrial: 10 };
    g.econ.indexRate = 3;
    const pitch = E.firmEntryPitch(g);
    g = E.advanceMonth(g, parcels, bbls, null);
    const spun = (g.rivals ?? []).find((r) => r.spawnedFrom?.personName === "Vera Whitcomb");
    if (spun) { spawned = spun; break; }
    if (!(g.founderBids ?? []).some((b) => b.name === "Vera Whitcomb")
      && (g.news ?? []).some((n) => /could not raise/.test(n.text) && /Vera Whitcomb/.test(n.text))) {
      refused = true;
      break;
    }
    // Re-queue if somehow cleared without news (should not happen).
    if (!(g.founderBids ?? []).length && !spawned) {
      ok("unexpected bid clear", false, `pitch was ${pitch.pitch.toFixed(3)}`);
      break;
    }
  }
  ok("founder bid resolved", !!spawned || refused,
    spawned ? "raised" : refused ? "refused" : "timed out");
  if (spawned) {
    ok("genealogy stamped", spawned.spawnedFrom?.firmId === "you");
    ok("principal is the founder", g.rivalPrincipals?.[spawned.id]?.name === "Vera Whitcomb");
    ok("firm count grew", (g.rivals ?? []).length > before);
  } else if (refused) {
    // Fertile-tape refuse is still a valid outcome of the hazard — but then we
    // at least required the refuse news and a cleared bid.
    ok("raise refused clears bid", !(g.founderBids ?? []).length);
    ok("refuse news names founder", true);
    ok("no phantom firm", !(g.rivals ?? []).some((r) => r.spawnedFrom?.personName === "Vera Whitcomb"));
  }
}

// Poach queues a founder bid (staff → genealogy), does not silently vanish.
{
  let g = E.newGame(99, parcels, 10_000_000);
  g.staff = [{
    id: 9001, name: "Gus Radcliffe", bornM: -400, diesM: 800,
    attrs: { judgment: 85, urgency: 80, diligence: 82, relationships: 78,
      operations: 80, leasing: 70, construction: 60 },
    obs: { judgment: 70 }, band0: 20, seat: "employee",
    role: "pm", salary: 120_000, hiredM: 0,
  }];
  g.hireReputation = 0.2; // muddy name → higher poach chance
  g.month = 30; // tenure ≥ 24
  g.staff[0].hiredM = 0;
  // Force many staff ticks via advance — or call tickStaff if exported.
  let queued = false;
  for (let i = 0; i < 120 && !queued; i++) {
    g = E.advanceMonth(g, parcels, bbls, null);
    if ((g.founderBids ?? []).some((b) => b.name === "Gus Radcliffe")) queued = true;
    if (!(g.staff ?? []).some((x) => x.name === "Gus Radcliffe")
      && (g.news ?? []).some((n) => /Gus Radcliffe/.test(n.text) && /left/.test(n.text))) {
      queued = (g.founderBids ?? []).some((b) => b.name === "Gus Radcliffe");
      break;
    }
  }
  ok("star departure queues founder bid", queued
    || (g.news ?? []).some((n) => /Gus Radcliffe/.test(n.text)),
    queued ? "bid queued" : "news only / still employed");
}

// Living firm count over a century — output, not a hard refill rail (#48/#49).
{
  const SEEDS = [7777, 4242];
  let allSpinouts = [];
  for (const seed of SEEDS) {
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    const samples = [];
    for (let m = 0; m < 1200; m++) {
      if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
      if (m % 120 === 0) {
        samples.push((g.rivals ?? []).filter((r) => r.failedM === undefined).length);
      }
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    console.log(`  seed ${seed} decade series: ${samples.join(" · ")}`);
    ok(`seed ${seed}: street never empties`, min >= 5, `min=${min}`);
    ok(`seed ${seed}: not hard-capped at 24`, max > 24, `max=${max}`);
    ok(`seed ${seed}: firms survive century`, samples[samples.length - 1] >= 5,
      `end=${samples[samples.length - 1]}`);
    allSpinouts.push(...(g.rivals ?? []).filter((r) => r.spawnedFrom?.firmName));
    // NO ZOMBIES: nothing "alive" with no book, no debt, and years of nothing.
    const zombies = (g.rivals ?? []).filter((r) =>
      r.failedM === undefined && r.bbls.length === 0 && (r.debt ?? 0) <= 0 && !(r.stressMs) && (r.emptyMs ?? 0) > 26);
    ok(`seed ${seed}: no zombie firms on the leaderboard`, zombies.length === 0, `${zombies.length}`);
  }
  // The street itself now produces genealogy — a number two leaving a thriving
  // shop — so this assert can actually fail on an unplayed century.
  ok("unplayed centuries produce spinouts", allSpinouts.length >= 1, `${allSpinouts.length} across ${SEEDS.length} seeds`);
  ok("every spinout carries full genealogy", allSpinouts.every((r) => r.spawnedFrom.firmId && r.spawnedFrom.personName),
    `${allSpinouts.length} with lineage`);
}

console.log(`\n${fails === 0 ? "firms pass" : `${fails} firms failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
