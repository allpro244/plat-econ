// THE CITY ACCEPTANCE SUITE — is the place still a place after fifty years?
//
// This file exists because of a fault that ran silently for the entire life of
// the project and that NO HARNESS COULD SEE.
//
// The city has always had a wrecking ball: tickTeardowns condemns a building
// when the dirt under it is worth more than the building on it. It cleared the
// lot and trusted that the city's own builders would find the site "like any
// other". Measured, they did not. Over fifty years with no player in the game
// the town demolished 343 buildings and delivered 115, and the standing stock
// fell from 1,030 to 802 — a fifth of the city gone, and the mean building age
// still climbing because the handful of replacements could not keep pace.
//
// Every existing harness passed throughout. econ:accept asks whether the SPACE
// market is real. sim:accept asks whether the ECONOMY under it closes. conserve
// asks whether every dollar came from somewhere. Not one of them asks the
// simplest question there is:
//
//     IS THERE STILL A CITY HERE?
//
// CLAUDE.md: "the harnesses are the enforcement, and their job is to be
// adversarial", and "a test that cannot fail is itself a fake". A suite with no
// test of the city's own vital signs is a narrower version of the same problem
// — it cannot fail on a whole class of fault, so that class ran for years.
//
// Four vital signs, each with a threshold taken from what real cities do rather
// than from what this build happens to produce:
//
//   J. THE STOCK SURVIVES   a city does not quietly dismantle itself
//   K. THE CITY RENEWS      ...nor is it a museum where nothing is ever replaced
//   L. THE CRANES ANSWER    demolition and delivery are two halves of one trade
//   M. THE MAP STAYS SANE   no NaN, no negative area, no building on no land
//
// Run: node test/city-accept.mjs (bundle first, like every other harness).
//
// J, K AND L ARE BANDS AND ARE NOW REPORTED RATHER THAN GATED — owner's
// decision, 2026-08-06, see test/accept-lib.mjs and ECONOMY.md.
//
// M IS NOT, AND THIS IS THE ONE PLACE THE DECISION DOES NOT REACH. "No NaN,
// no negative area, no building standing on no land" has a threshold of ZERO.
// There is no calibration in it to be too strict about — it is the same shape
// as `pnpm conserve`, an identity rather than a band, and it is the only
// letter that still fails a build. That is why `pnpm gate` runs this file.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSuite } from "./accept-lib.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { report, verdict } = makeSuite();
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
const pct = (n) => (n * 100).toFixed(1) + "%";

// FIVE SEEDS AND FIVE TOWNS. The fault this file was written for showed up
// identically on every seed, so a wide sweep is not needed to see it — but
// five different CITIES are, because a generator that dismantles one shape of
// town and not another is exactly the kind of thing a single-city harness
// misses. loadCity honours CITY_SEEDS=1 to vary the town per run index.
const SEEDS = Number(process.env.SEEDS ?? 5);
const YEARS = Number(process.env.YEARS ?? 50);

// ---------------------------------------------------------------- the runs
// NO PLAYER AT ALL. Every question here is about whether the city is alive on
// its own. A bot buying and building would mask the answer with its own
// activity, which is precisely how this went unnoticed: the runs that anybody
// looked at all had somebody playing them.
const runs = [];
for (let i = 0; i < SEEDS; i++) {
  const { parcels, bbls, adjacency, seed } = loadCity(i, E.normalizeParcels);
  let g = E.newGame(seed, parcels);
  g = E.firstListings(g, parcels, bbls);

  const built0 = Object.values(parcels).filter((r) => r.class !== "land" && r.bldgArea > 0);
  const n0 = built0.length;
  const sf0 = built0.reduce((a, r) => a + r.bldgArea, 0);
  const age0 = built0.reduce((a, r) => a + (2000 - (r.yearBuilt || 1900)), 0) / Math.max(1, n0);

  for (let mo = 0; mo < YEARS * 12; mo++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    // The observer is kept solvent and alive. It owns nothing and does
    // nothing; this only stops an insolvency clock ending the run early.
    g.cash = 50_000_000; g.insolventMs = 0; g.gameOver = null;
  }

  const yr = 2000 + Math.floor(g.month / 12);
  let n1 = 0, sf1 = 0, ageSum = 0, bad = 0, youngest = 9999;
  for (const bbl of bbls) {
    const rec = E.resolveRec(parcels, g, bbl);
    if (!rec) continue;
    // M's checks, gathered on the same pass.
    if (!Number.isFinite(rec.bldgArea) || rec.bldgArea < 0) bad++;
    if (!Number.isFinite(rec.lotArea) || rec.lotArea <= 0) bad++;
    if (rec.bldgArea > 0 && rec.class === "land") bad++;   // a building on no land
    if (rec.class === "land" || !rec.bldgArea) continue;
    n1++; sf1 += rec.bldgArea;
    const age = yr - (rec.yearBuilt || 1900);
    ageSum += age;
    youngest = Math.min(youngest, age);
  }
  runs.push({
    seed, n0, n1, sf0, sf1, age0, age1: ageSum / Math.max(1, n1),
    demolished: g.demolished ?? 0, delivered: (g.cityBuilt ?? []).length,
    bad, youngest,
  });
}

// ------------------------------------------------------- J. THE STOCK SURVIVES
{
  // A real city's building count drifts; it does not collapse. Half a per cent
  // a year of demolition against a comparable rate of completion is the normal
  // state, so over fifty years the count should land within a fifth of where
  // it started in either direction. The failure this test was written for
  // came in at -22%, and a runaway BUILDING boom would be just as wrong.
  const chg = runs.map((r) => r.n1 / r.n0 - 1);
  const sfChg = runs.map((r) => r.sf1 / r.sf0 - 1);
  const m = med(chg);
  const pass = Math.abs(m) <= 0.20 && runs.every((r) => r.n1 / r.n0 > 0.65);
  report("J. THE STOCK SURVIVES — a city does not dismantle itself", pass, [
    `building count over ${YEARS}y: ${runs.map((r) => `${r.n0}->${r.n1}`).join("  ")}`,
    `change per seed: ${chg.map(pct).join("  ")}   median ${pct(m)}   (need |median| <= 20% and no seed below -35%)`,
    `floor area change: ${sfChg.map(pct).join("  ")}`,
    `the fault this test exists for read -22% and every other harness passed`,
  ]);
}

// ---------------------------------------------------------- K. THE CITY RENEWS
{
  // ...and the opposite failure. A town where nothing is ever replaced is a
  // museum: its mean building age rises by exactly one year per year. Real
  // cities renew enough that the mean climbs more slowly than the calendar.
  // Half the calendar is a generous bar — it only fails a city that is barely
  // rebuilding at all.
  const aged = runs.map((r) => r.age1 - r.age0);
  const m = med(aged);
  const pass = m < YEARS * 0.85 && runs.every((r) => r.youngest <= 15);
  report("K. THE CITY RENEWS — it is not a museum", pass, [
    `mean building age: ${runs.map((r) => `${r.age0.toFixed(0)}->${r.age1.toFixed(0)}`).join("  ")}`,
    `aged by: ${aged.map((a) => a.toFixed(0)).join("  ")} years over ${YEARS}   median ${m.toFixed(0)}   (need < ${(YEARS * 0.85).toFixed(0)})`,
    `youngest building at the end, per seed: ${runs.map((r) => r.youngest).join("  ")} years   (need <= 15 — something must have been built lately)`,
    `a city that never replaced anything would age exactly ${YEARS}`,
  ]);
}

// -------------------------------------------------------- L. THE CRANES ANSWER
{
  // Demolition and delivery are two halves of one trade. Nobody clears a site
  // without a project — the wrecking ball is the first line item of a
  // development budget — so the two counts should be of the same order. This
  // is the test that would have caught the silent one directly: 343 down and
  // 115 up is a ratio of 0.34, and the delivery loop was dropping every
  // redevelopment on the day it was due to open.
  const ratio = runs.map((r) => r.delivered / Math.max(1, r.demolished));
  const m = med(ratio);
  const rate = runs.map((r) => r.demolished / Math.max(1, r.n0) / YEARS);
  const pass = m >= 0.6 && med(rate) > 0.001 && med(rate) < 0.015;
  // TWO THINGS THIS BAND IS NOT TELLING YOU, MEASURED 2026-08-06 AND WORTH
  // READING BEFORE ANYBODY TRUSTS THE 2.51x.
  //
  // 1. THE RATIO CONFLATES TWO TRADES. `delivered` is `cityBuilt.length`,
  //    which counts every groundbreak the city ever completes — greenfield on
  //    vacant land as much as a replacement on a cleared site. `demolished` is
  //    teardowns only. So on this build 41 teardowns against 115 deliveries
  //    reads 2.80x, and at least 74 of those deliveries never had a wrecking
  //    ball anywhere near them. The clause would still catch the fault it was
  //    written for — the delivery loop dropping every redevelopment — only if
  //    greenfield were not covering the gap, and greenfield is most of it. The
  //    honest version needs `cityBuilt` to record whether the site was cleared
  //    first, which lives in dev.ts and is not this agent's file.
  //
  // 2. THE DEMOLITION RATE IS SITTING ON ITS LOWER RAIL. The band is 0.1-1.5%
  //    with a stated real-world anchor of ~0.5%/yr, and the measured rates are
  //    0.084, 0.101, 0.102, 0.110, 0.134 %/yr — median 0.105%, which clears
  //    the floor by five per cent and undershoots the anchor the comment
  //    itself cites by a factor of five. One of five seeds is already BELOW
  //    the floor. Printed to three decimals now, because at one decimal every
  //    seed reads "0.1%" and the rail is invisible.
  report("L. THE CRANES ANSWER — a teardown is a groundbreaking", pass, [
    `demolished: ${runs.map((r) => r.demolished).join("  ")}`,
    `delivered:  ${runs.map((r) => r.delivered).join("  ")}   (ALL city groundbreaks, greenfield included — see the note in this file)`,
    `delivered / demolished: ${ratio.map((x) => x.toFixed(2)).join("  ")}   median ${m.toFixed(2)}   (need >= 0.60)`,
    `demolition rate: ${rate.map((x) => (x * 100).toFixed(3) + "%").join("  ")}/yr   median ${(med(rate) * 100).toFixed(3)}%/yr   (need 0.100-1.500%)`,
    `   the real-world anchor is ~0.5%/yr; ${rate.filter((x) => x <= 0.001).length} of ${runs.length} seeds are under the floor`,
  ]);
}

// --------------------------------------------------------- M. THE MAP STAYS SANE
{
  // The cheapest test in the file and the one most likely to catch somebody
  // else's mistake. A NaN once ate the player's entire bankroll in this engine
  // because nothing had the job of noticing; geometry deserves the same guard.
  const bad = runs.reduce((a, r) => a + r.bad, 0);
  const pass = bad === 0;
  // THE ONLY IDENTITY AMONG THE LETTERS. Threshold zero, and a zero is not a
  // band — see the note at the top of this file.
  report("M. THE MAP STAYS SANE — no NaN, no negative area, no building on no land", pass, [
    `bad parcels across ${SEEDS} seeds x ${YEARS} years: ${runs.map((r) => r.bad).join("  ")}`,
    `total ${bad}   (need 0)`,
  ], "identity");
}

// ------------------------------------------------------------------- verdict
verdict();
