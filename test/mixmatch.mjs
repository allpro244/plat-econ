// DOES THE CITY BUILD WHAT THE MARKET ORDERED?
//
//   pnpm mixmatch                              four towns, fifty years
//   N=8 HZ=720 pnpm mixmatch                   more of both
//
// `pnpm leadlag` asks whether the cycle runs in the right ORDER. This asks a
// different question about the same leg, and the two are not substitutes.
//
// The space market keeps an order book: `econ.startOwed`, square feet asked for
// and not yet delivered, PER CLASS. The crane count reads the total of it — the
// backlog in tickCityDev sizes the pipeline off the sum. But the sum is all it
// reads. Which class each crane then builds is picked by `useForZone` from the
// zone, a demand score and a die.
//
// So the order book can say "office is four hundred thousand feet short" and
// the city can answer with flats, and nothing anywhere notices. That is the
// difference between a queue and a quota: a queue is filled in order.
//
// WHAT THIS MEASURES is composition, not timing. For each month and each class:
//
//     owedShare[k]  = owed[k]  / sum(owed)         what was asked for
//     brokeShare[k] = broke[k] / sum(broke)        what went in the ground
//
// and the Pearson correlation between the two series, per class and pooled.
// Groundbreaks are lumpy — a single tower is a whole month's output in one
// parcel — so the break shares are taken over a trailing window wide enough
// that a month with two jobs in it is not being compared against a quota.
//
// A correlation near zero means the order book is decoration: the city builds
// its usual mix regardless of what is short. Near one means composition is
// respected and the queue is real. This is the direct test of the mechanism;
// the lead-lag r on `orders -> breaks` is a noisy shadow of it, because that
// leg mixes composition and timing into one number and cannot say which failed.
//
// WHAT IT FOUND, which is why the file exists:
//
//   BEFORE                                     AFTER (useForZone reads the book)
//   office       r  0.09   ord 28.4  blt 30.4    r  0.42   ord 36.6  blt 31.9
//   retail       r -0.03   ord  6.0  blt 18.3    r  0.22   ord  6.5  blt 17.3
//   industrial   r -0.09   ord 29.6  blt  2.0    r  0.04   ord 33.5  blt  3.4
//   multifamily  r -0.09   ord 35.9  blt 49.2    r  0.34   ord 23.3  blt 47.4
//
// Three of four were NEGATIVE. A class being short did not make the city likelier
// to build it, and industrial — a third of every order — was two per cent of every
// groundbreak. `useForZone` now weights its draw by the order book's composition,
// which is `econ.startOwed`, the same queue whose TOTAL already sizes the crane
// count. No constant was added: `pick` normalises, so only ratios matter and the
// ratios are the book's own.
//
// TWO EARLIER ATTEMPTS FAILED, and both failures are more instructive than the fix.
//
//   Weighting by the book's share CLAMPED to [0.33, 2.5]. Instrumented over 9,084
//   draws the clamp bound 52.7% of the time — retail sat on the low rail 63.6% of
//   the time and never reached the high one. CLAUDE.md fake number five: in half
//   the city's decisions the mechanism was the clamp, not the market. It bound
//   because the book is spiky — office swings 1k to 298k sf across a cycle while
//   industrial rests on a permanent ~40k floor it can never work off, M-zoned land
//   being scarce enough that those orders are structurally unfillable. Any bounded
//   ratio taken over that spends its life against a stop.
//
//   Weighting by `classAppetite` instead. This read BEST of the three on the
//   headline numbers — office vacancy 22.0% -> 12.0%, dead lease legs -23%,
//   volume-neutral — and it is a mirror, not a mechanism. `e.starts`, which FILLS
//   the book, is `vacGate(vacancy) x credit x margin`; `classAppetite` is
//   `tight(vacancy) x credit x devPencils`. Same formula. `orders -> breaks` duly
//   went to r 0.39 and BACKWARDS at -17 months, which is two copies of one series
//   arguing about phase. Shipping it on those numbers would have been fitting the
//   test — and the test in question is the one that exists to catch exactly this.
//
// WHAT SHIPPING IT DID, measured paired on identical seeds. Total groundbreaks
// 35.26M -> 41.00M sf, and the city ends bigger: 34,115 jobs against 32,331. Real
// office rent and median land both rise sharply, and the reason is amplitude
// rather than level — office vacancy now runs 3.8% to 21.1% across the cycle where
// it used to sit in a permanently soft 11.5-18.3% band. Concentrating cranes on
// whichever class is short means overshooting that class, and overshoot is what a
// property cycle IS. A blind mix diversifies the cycle away, which is precisely
// why the leg could not be identified before.
//
// STILL BROKEN, and now cleanly: `orders -> breaks` reads -5mo, r 0.48, BACKWARDS.
// The queue has no DURATION. A groundbreak happens the month its order is booked
// and drains the book on the way past, so the two series are contemporaneous and
// the drain makes the residual correlation negative. In life, entitlement, design,
// a site and a lender take six to eighteen months, which is what the expected band
// on that leg is measuring. That lag does not exist in this engine yet.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N || 4);
const HZ = +(process.env.HZ || 600);
const WIN = +(process.env.WIN || 12);   // trailing months the break mix is read over
// HOW FAR BACK THE BOOK IS READ, separately from how wide the break window is.
// These were one number and should never have been: WIN is a smoothing width
// set by how lumpy groundbreaks are, OFF is a causal lag set by how long the
// engine takes to turn an order into a shovel. Tying them together meant that
// adding the entitlement queue — which sits BEFORE the book, so `startOwed`
// became the immediately-spendable queue rather than the raw order flow — made
// the harness read the book a year too early and report a mechanism getting
// worse when it had not moved. Contemporaneous is the right default now: the
// waiting happens upstream of `startOwed`, not between it and the crane.
const OFF = +(process.env.OFF ?? 0);
const CLASSES = ["office", "retail", "industrial", "multifamily"];

const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 8) return NaN;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

// Per class: every (town, month) pair that had both an order book and a crane.
const owedS = Object.fromEntries(CLASSES.map((k) => [k, []]));
const brokeS = Object.fromEntries(CLASSES.map((k) => [k, []]));
// Shares cannot tell you whether a class got MORE space or the others got less,
// and that is the difference between a mix that moved and a city that grew. The
// absolute square footage broken per class is the level behind the share.
const brokeTot = Object.fromEntries(CLASSES.map((k) => [k, 0]));
let months = 0, live = 0;

for (let i = 0; i < N; i++) {
  const { parcels, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  let g = E.firstListings(E.newGame(9001 + i, parcels), parcels, bbls);
  const seen = new Set();
  const hist = [];                       // trailing per-class groundbreak sf
  const owedAt = [];
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const owed = g.econ.startOwed ?? {};
    owedAt.push(Object.fromEntries(CLASSES.map((k) => [k, Math.max(0, owed[k] ?? 0)])));
    const broke = Object.fromEntries(CLASSES.map((k) => [k, 0]));
    for (const j of g.cityJobs ?? []) {
      const key = j.bbl + "#" + j.startM;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const k of CLASSES) {
        const share = j.mix?.[k] ?? (j.use === k ? 1 : 0);
        if (share > 0) { broke[k] += j.sf * share; brokeTot[k] += j.sf * share; }
      }
    }
    hist.push(broke);
    if (hist.length < WIN) continue;
    months++;
    // Break mix over the trailing window; order book as of the window's START,
    // because a crane going in this month was picked against the book that
    // existed when the site was chosen, not the one it just decremented.
    const win = hist.slice(-WIN);
    const bTot = CLASSES.reduce((a, k) => a + win.reduce((t, h) => t + h[k], 0), 0);
    const o0 = owedAt[Math.max(0, owedAt.length - 1 - OFF)];
    const oTot = CLASSES.reduce((a, k) => a + o0[k], 0);
    if (!(bTot > 0) || !(oTot > 0)) continue;
    live++;
    for (const k of CLASSES) {
      owedS[k].push(o0[k] / oTot);
      brokeS[k].push(win.reduce((t, h) => t + h[k], 0) / bTot);
    }
  }
}

console.log(`\nDOES THE CITY BUILD WHAT THE MARKET ORDERED — ${N} towns x ${HZ / 12} years, ${WIN}mo window, book read ${OFF}mo back\n`);
console.log(`  ${pad("class", 14)}${rp("r", 8)}${rp("ordered", 10)}${rp("built", 10)}${rp("sf broken", 14)}`);
let pooledX = [], pooledY = [];
for (const k of CLASSES) {
  const r = pearson(owedS[k], brokeS[k]);
  const mo = owedS[k].reduce((a, v) => a + v, 0) / Math.max(1, owedS[k].length);
  const mb = brokeS[k].reduce((a, v) => a + v, 0) / Math.max(1, brokeS[k].length);
  pooledX = pooledX.concat(owedS[k]); pooledY = pooledY.concat(brokeS[k]);
  console.log(`  ${pad(k, 14)}${rp(Number.isFinite(r) ? r.toFixed(2) : "n/a", 8)}${rp((mo * 100).toFixed(1) + "%", 10)}${rp((mb * 100).toFixed(1) + "%", 10)}${rp((brokeTot[k] / 1e6).toFixed(2) + "M sf", 14)}`);
}
console.log(`  ${pad("TOTAL", 14)}${rp("", 8)}${rp("", 10)}${rp("", 10)}${rp((CLASSES.reduce((a, k) => a + brokeTot[k], 0) / 1e6).toFixed(2) + "M sf", 14)}`);
const pool = pearson(pooledX, pooledY);
// The pooled number is across classes as well as time, so it also rewards a
// city that merely gets the RANKING right — office is usually the biggest share
// of both. The per-class numbers above are the ones that need a mechanism,
// because they ask whether a class being short THIS month changes anything.
console.log(`\n  pooled r  ${pool.toFixed(2)}   over ${live} live months of ${months} sampled`);
console.log(`\n  Near zero: the order book is decoration and the city builds its usual mix.`);
console.log(`  Near one: composition is respected and the queue is a queue.\n`);
