// THE PAIRED FORK — what a level event actually delivers, against a control
// that is the same city on the same RNG stream with the event switched off.
//
//   node test/swanfork.mjs                 finance to 0.65
//   MULT=1.35 node test/swanfork.mjs       the white mirror
//   TRADE=logistics node test/swanfork.mjs a small trade
//
// Warm a city fifteen years. Clone it. Force one trade in the clone only, over
// five years. Run both fifteen more years. Average the last ten of those.
//
// THE CONTROL IS THE POINT. The first attempt at measuring swans compared the
// city before an event with the city after it and reported that black swans
// RAISED employment 4.16% — which was the city's growth trend, not the swan.
// A fork shares the trend; the difference between the arms is the event.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const TRADE = process.env.TRADE ?? "finance";
const MULT = Number(process.env.MULT ?? 0.65);
const GLIDE = 60;                     // five years
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22").split(",").map(Number);
const WARM = 180, AFTER = 180, AVG = 120;

const c = loadCity(0, E.normalizeParcels);
const avail = (g, cls) => g.econ.cityVac?.[cls];
const stress = (g, k) => E.industryStress(g.econ, k);

const acc = { ctrl: {}, shock: {} };
const add = (bag, k, v) => { if (v !== undefined && Number.isFinite(v)) (bag[k] ??= []).push(v); };
let share = 0;

for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(c.parcels));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, c.bbls);
  for (let m = 0; m < WARM; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, c.bbls, c.adjacency);
  }
  share = g.econ.sectorShare?.[TRADE] ?? 0;

  const arms = { ctrl: JSON.parse(JSON.stringify(g)), shock: JSON.parse(JSON.stringify(g)) };
  arms.shock.econ.swanTradeTo[TRADE] = MULT;
  arms.shock.econ.swanTradeM[TRADE] = GLIDE;

  for (const [name, arm] of Object.entries(arms)) {
    // Each arm gets its OWN parcel table: the tables are mutated in place, so
    // sharing one would let the shocked arm's construction rewrite the control's
    // city — which would not be a control.
    const p = JSON.parse(JSON.stringify(c.parcels));
    let a = arm;
    for (let m = 0; m < AFTER; m++) {
      if (a.gameOver) a = { ...a, gameOver: null, cash: 6e6 };
      a = E.advanceQuarter(a, p, c.bbls, c.adjacency);
      if (m < AFTER - AVG) continue;
      const bag = acc[name];
      add(bag, `stress:${TRADE}`, stress(a, TRADE));
      add(bag, "stress:law", stress(a, "law"));
      for (const cls of ["office", "retail", "industrial", "multifamily"]) add(bag, `avail:${cls}`, avail(a, cls));
      add(bag, "jobs", a.econ.jobs);
      add(bag, "officeRentReal", (a.econ.rentIdx?.office ?? 0) / (a.econ.cpi || 1));
    }
  }
}

const mean = (xs) => (xs?.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const keys = Object.keys(acc.ctrl);
console.log(`${TRADE} x${MULT} over ${GLIDE}m — ${SEEDS.length} paired forks, ${WARM}m warm, mean of the last ${AVG}m of ${AFTER}m`);
console.log(`${TRADE} is ${(share * 100).toFixed(1)}% of this city's payroll\n`);
for (const k of keys) {
  const a = mean(acc.ctrl[k]), b = mean(acc.shock[k]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) { console.log(`  ${k.padEnd(22)} (not exported)`); continue; }
  const isPct = k.startsWith("avail:");
  const fmt = (v) => (isPct ? (v * 100).toFixed(2) + "%" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(3));
  const delta = isPct ? `(${b > a ? "+" : ""}${((b - a) * 100).toFixed(2)}pp)` : `(${b > a ? "+" : ""}${(((b - a) / Math.abs(a)) * 100).toFixed(1)}%)`;
  console.log(`  ${k.padEnd(22)} ${fmt(a).padStart(10)} -> ${fmt(b).padStart(10)}   ${delta}`);
}
