// Order book composition — useForZone fills startOwed, not a clamped mirror.
//   pnpm engine && pnpm orderbook
// Faster gate-friendly subset of mixmatch.mjs with pass/fail thresholds.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N ?? 6);
const HZ = +(process.env.HZ ?? 360);
const WIN = +(process.env.WIN ?? 12);
const OFF = +(process.env.OFF ?? 0);
const CLASSES = ["office", "retail", "industrial", "multifamily"];

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

const owedS = Object.fromEntries(CLASSES.map((k) => [k, []]));
const brokeS = Object.fromEntries(CLASSES.map((k) => [k, []]));

for (let i = 0; i < N; i++) {
  const { parcels, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  let g = E.firstListings(E.newGame(9001 + i, parcels), parcels, bbls);
  const seen = new Set();
  const hist = [];
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
        if (share > 0) broke[k] += j.sf * share;
      }
    }
    hist.push(broke);
    if (hist.length < WIN) continue;
    const win = hist.slice(-WIN);
    const bTot = CLASSES.reduce((a, k) => a + win.reduce((t, h) => t + h[k], 0), 0);
    const o0 = owedAt[Math.max(0, owedAt.length - 1 - OFF)];
    const oTot = CLASSES.reduce((a, k) => a + o0[k], 0);
    if (!(bTot > 0) || !(oTot > 0)) continue;
    for (const k of CLASSES) {
      owedS[k].push(o0[k] / oTot);
      brokeS[k].push(win.reduce((t, h) => t + h[k], 0) / bTot);
    }
  }
}

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

const rOf = (k) => pearson(owedS[k], brokeS[k]);
let pooledX = [], pooledY = [];
for (const k of CLASSES) {
  const r = rOf(k);
  pooledX = pooledX.concat(owedS[k]); pooledY = pooledY.concat(brokeS[k]);
  console.log(`  ${k.padEnd(14)} r=${Number.isFinite(r) ? r.toFixed(2) : "n/a"}  n=${owedS[k].length}`);
}
const pool = pearson(pooledX, pooledY);
ok("pooled orders→breaks r", Number.isFinite(pool) && pool >= 0.40, `r=${Number.isFinite(pool) ? pool.toFixed(2) : "n/a"}`);
const leadSum = ["office", "multifamily"].reduce((a, k) => {
  const r = rOf(k); return a + (Number.isFinite(r) && r > 0 ? r : 0);
}, 0);
ok("office+multifamily track the book", leadSum >= 0.35, `positive r sum=${leadSum.toFixed(2)}`);
const std = (arr) => {
  const m = arr.reduce((a, v) => a + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length);
};
const retailSpread = std(brokeS.retail);
ok("retail composition responds to the book", retailSpread > 0.04,
  `break-share σ=${retailSpread.toFixed(3)}`);

console.log(`\n${fails === 0 ? "orderbook pass" : `${fails} orderbook failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
