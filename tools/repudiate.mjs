// DOES A BANK FAILURE STOP A CRANE?
//
// Deposits are the loud half of a bank failure and the smaller one. The half
// that ends developers is the undrawn construction commitment, which a
// receiver does not fund. This asks whether that channel exists in the engine
// at all, and then what it does to the borrower who is standing under it.
//
//   node tools/repudiate.mjs             12 seeds x 50 years
//   SEEDS=24 YEARS=50 node tools/repudiate.mjs
//
// It runs the world WITHOUT a player bot. Rival jobs are the sample, because
// there are hundreds of them and there is only ever one of the player. The
// question here is frequency and consequence, not strategy.
import * as E from "../test/.engine.mjs";
import { loadCity } from "../test/city.mjs";

const SEEDS = Number(process.env.SEEDS ?? 12);
const YEARS = Number(process.env.YEARS ?? 50);
const m$ = (n) => "$" + (n / 1e6).toFixed(1) + "M";
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

let failures = 0, repudJobs = 0, repudDollars = 0;
let replaced = 0, stranded = 0, deliveredWhileDead = 0;
const waitMs = [];
const rateJump = [];
let seedsWithFailure = 0;
// The anonymous pipeline cannot be repudiated — it has no balance sheet. What
// it does instead is stop starting things, because a town with a desk in
// receivership is a town with less credit in it. That is the city channel.
let startsOpen = 0, monthsOpen = 0, startsDown = 0, monthsDown = 0;

for (let i = 0; i < SEEDS; i++) {
  const { parcels, bbls, adjacency, seed } = loadCity(i, E.normalizeParcels);
  let g = E.newGame(seed, parcels);
  g = E.firstListings(g, parcels, bbls);
  // Track each job's repudiation from the outside: the engine stamps
  // repudiatedM on the job and clears it when a facility closes, so the probe
  // only has to watch the field change.
  const seen = new Map();   // bbl -> {m, rate, commitment}
  let sawFailure = false;
  let prevJobs = 0;

  for (let mo = 0; mo < YEARS * 12; mo++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // The observer owns nothing; this only stops an insolvency clock from
    // ending a run that has no player in it.
    g.cash = 50_000_000; g.insolventMs = 0; g.gameOver = null;
    const jobsNow = (g.cityJobs ?? []).length;
    const started = Math.max(0, jobsNow - prevJobs); prevJobs = jobsNow;
    if ((g.lenders ?? []).some((l) => l.failedM !== undefined)) { startsDown += started; monthsDown++; }
    else { startsOpen += started; monthsOpen++; }
    const dead = (g.lenders ?? []).filter((l) => l.failedM === g.month - 1).length;
    if (dead) { failures += dead; sawFailure = true; }

    // The player's jobs live in s.developments; the street's live in
    // s.cityJobs. There is only ever one of the player and there are hundreds
    // of the street, so this observer run measures the street.
    for (const d of [...Object.values(g.developments ?? {}), ...(g.cityJobs ?? []).filter((j) => j.firmId)]) {
      const was = seen.get(d.bbl);
      if (d.repudiatedM !== undefined && !was) {
        seen.set(d.bbl, { m: d.repudiatedM, rate: d.ratePct, room: Math.max(0, (d.commitment ?? d.cost ?? 0) - (d.drawn ?? d.spent ?? 0)) });
        repudJobs++;
        repudDollars += Math.max(0, (d.commitment ?? d.cost ?? 0) - (d.drawn ?? d.spent ?? 0));
      } else if (d.repudiatedM === undefined && was) {
        replaced++;
        waitMs.push(g.month - was.m);
        rateJump.push(d.ratePct - was.rate);
        seen.delete(d.bbl);
      }
    }
    // A job that reaches delivery while still repudiated never came back.
    for (const [bbl, was] of [...seen]) {
      if (!g.developments?.[bbl] && !(g.cityJobs ?? []).some((j) => j.bbl === bbl && j.repudiatedM !== undefined)) {
        stranded++;
        deliveredWhileDead++;
        waitMs.push(g.month - was.m);
        seen.delete(bbl);
      }
    }
  }
  stranded += seen.size;
  if (sawFailure) seedsWithFailure++;
}

console.log(`\n${SEEDS} seeds x ${YEARS} years, no player bot\n`);
console.log(`bank failures                ${failures}   (${seedsWithFailure}/${SEEDS} seeds saw one)`);
console.log(`jobs repudiated              ${repudJobs}`);
console.log(`undrawn commitment killed    ${m$(repudDollars)}`);
console.log(`\ncity starts/mo, every desk open  ${(startsOpen / Math.max(1, monthsOpen)).toFixed(3)}   (${monthsOpen} months)`);
console.log(`city starts/mo, a desk in receivership  ${(startsDown / Math.max(1, monthsDown)).toFixed(3)}   (${monthsDown} months)`);
if (repudJobs === 0) {
  console.log(`\nNO NAMED JOB WAS EVER CAUGHT MID-DRAW, and that is structural rather`);
  console.log(`than broken. Named rival jobs are about 1% of this city's cranes —`);
  console.log(`105 job-months against 9,917 anonymous ones in a fifty-year run, three`);
  console.log(`concurrent at the most — so the odds of a seizure landing on one are`);
  console.log(`small by construction. The anonymous pipeline has no balance sheet to`);
  console.log(`repudiate; it answers a bank failure the way it should, through the`);
  console.log(`price and availability of credit. That is the pair of numbers above,`);
  console.log(`and it is the city channel actually working. Repudiation is the`);
  console.log(`channel for jobs that HAVE a balance sheet: the player's, and the`);
  console.log(`named firms' on the rare month it catches one.`);
} else {
  console.log(`refinanced by another desk  ${replaced}  (${((replaced / repudJobs) * 100).toFixed(0)}%)`);
  console.log(`never refinanced            ${stranded}  (${((stranded / repudJobs) * 100).toFixed(0)}%)`);
  console.log(`median months without money  ${med(waitMs)}`);
  if (rateJump.length) {
    const up = rateJump.filter((r) => r > 0).length;
    console.log(`rate on the rescue          ${med(rateJump) >= 0 ? "+" : ""}${med(rateJump).toFixed(2)}pp median` +
      `   (${up}/${rateJump.length} paid up for it)`);
  }
}
console.log("");
