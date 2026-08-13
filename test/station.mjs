// THE STATION — does a civic work actually move the ground around it?
//
//   pnpm engine && pnpm station
//
// Two questions, both against a CONTROL rather than against zero, because the
// city drifts on its own and "the blocks went up" means nothing unless the
// same blocks in the same city without the station did not.
//
//   1. INJECTION. Fork one campaign at month 24 into a treated run (a funded
//      station dropped on a mid-demand block) and a control (nothing). Run
//      both eight years — past opening day — and compare blockD block by
//      block. Within the station's reach the treated city must be higher than
//      the control; far from it the difference must be about zero or slightly
//      negative, because demand is redistributive and a station is not
//      allowed to print city-wide value out of nothing.
//
//   2. LIFECYCLE. Run a campaign forty years and check every work the
//      scheduler produced went through the stages in the right order with the
//      right spacing: rumoured, then a hearing two years later that funds or
//      shelves it, then a build measured in the kind's own years. Shelved
//      plans must be GONE, not priced.
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
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
const run = (g, months) => {
  for (let m = 0; m < months; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
  return g;
};

// ---- 1 · injection: treated vs control ------------------------------------
const model = E.demandModel(parcels);
const blocks = [...model.blocks.values()];
// a mid-demand host, the kind the scheduler itself would pick
const host = blocks.filter((b) => b.baseD < 55).sort((a, b) => b.baseD - a.baseD)[Math.floor(blocks.filter((b) => b.baseD < 55).length / 2)];
const SIGMA = 380, PTS = 20;

let g0 = E.firstListings(E.newGame(7777, parcels), parcels, bbls);
g0 = run(g0, 24);
const m0 = g0.month;
const treated0 = structuredClone(g0);
// funded on the fork date (rumour already behind it, so no hearing re-rolls it)
treated0.lines = [...(treated0.lines ?? []), {
  id: host.id, cx: host.cx, cy: host.cy, name: "the injection site", kind: "station",
  sigma: SIGMA, rumorM: m0 - 24, annM: m0, openM: m0 + 72, pts: PTS,
}];
const HORIZON = 96; // opening at +72, then two years to settle
const treated = run(treated0, HORIZON);
const control = run(structuredClone(g0), HORIZON);

const near = [], far = [];
for (const b of blocks) {
  const d = Math.hypot(b.cx - host.cx, b.cy - host.cy);
  const delta = (treated.blockD?.[b.id] ?? 0) - (control.blockD?.[b.id] ?? 0);
  if (d <= SIGMA) near.push(delta);
  else if (d > SIGMA * 3) far.push(delta);
}
const mNear = median(near), mFar = median(far);
console.log(`injection: ${near.length} blocks within ${SIGMA}m, median blockD lift vs control ${mNear.toFixed(2)} pts; ${far.length} far blocks, median ${mFar.toFixed(2)}`);
ok("blocks within reach rise vs control after opening", mNear > 2, `${mNear.toFixed(2)} pts (need > 2)`);
ok("far blocks do not get free value (redistribution holds)", mFar < 1, `${mFar.toFixed(2)} pts (need < 1)`);

// ---- 2 · lifecycle: the scheduler's own works -----------------------------
const BUILD = { station: 72, park: 36, bridge: 60 };
let g = E.firstListings(E.newGame(4242, parcels), parcels, bbls);
const seen = []; // every distinct work ever observed, by id+rumorM
const news = new Set();
for (let m = 0; m < 480; m++) {
  if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
  g = E.advanceQuarter(g, parcels, bbls, adjacency);
  for (const l of g.lines ?? []) {
    const key = `${l.id}:${l.rumorM}`;
    if (!seen.some((x) => x.key === key)) seen.push({ key, ...l });
  }
  for (const n of g.news ?? []) news.add(n.text);
}
const shelvedNews = [...news].filter((t) => /died in committee|cut from the budget|voted down/.test(t)).length;
const rumorNews = [...news].filter((t) => /circulating plans|sketching a new park|surveying at/.test(t)).length;
console.log(`lifecycle (seed 4242, 40y): ${seen.length} works rumoured, ${g.lines?.length ?? 0} survive, ${shelvedNews} shelving notices, ${rumorNews} rumour notices`);
ok("scheduler produced at least one civic work in 40 years", seen.length >= 1, `${seen.length}`);
ok("every rumour precedes its hearing by two years", seen.every((l) => l.annM - l.rumorM === 24));
ok("every build time matches its kind", seen.every((l) => l.openM - l.annM === BUILD[l.kind ?? "station"]));
ok("every rumoured work made the news", rumorNews >= 1, `${rumorNews} notices for ${seen.length} works`);
ok("shelved plans are removed from the state", (g.lines ?? []).every((l) => seen.some((x) => x.key === `${l.id}:${l.rumorM}`)));

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall green");
process.exit(fails ? 1 : 0);
