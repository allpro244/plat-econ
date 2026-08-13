// THE CONSTRUCTION MARKET — is it a market, or a wall?
//
//   pnpm crews                    six seeds, fifty years
//   SEEDS=11,22 HZ=300 pnpm crews a quick pass
//
// The city's construction capacity used to be a hard ceiling on simultaneous
// jobs, derived from lot count. It was load-bearing: the town wanted a median
// 2.7 cranes for every one it could run and its headroom was fully exhausted in
// 64-88% of months, so the order book stood permanently unbuilt, was capped at
// 18 months, and was thrown away. Meanwhile the cost of building priced off the
// share of stock UNDER CONSTRUCTION — the quantity AFTER the wall had rationed
// it — so a city that wanted 26 cranes and got 10 looked exactly like a city
// that wanted 10 and got 10.
//
// A price that tracks the rationed quantity and not the demand for it is not a
// price, and this is the harness that says whether it is one now. It asks four
// things, and every one of them is a thing that was false before:
//
//   1. does the DEMAND for construction reach its price, not just the supply;
//   2. does the workforce index sit off its guards (a rail that binds in normal
//      play is holding up the model — CLAUDE.md);
//   3. does `heat` sit off ITS guards, so booms are not truncated;
//   4. is real construction cost roughly flat over fifty years, as the real
//      ENR-against-CPI record is, rather than falling through a shortage.
//
// The last one is the one that matters most, because a real cost that FALLS in
// a town desperate to build is a wire transmitting backwards, and CLAUDE.md
// calls backwards worse than broken.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ?? join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22,7").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 600);
const CLASSES = ["office", "retail", "multifamily", "industrial"];
const TYPICAL_SF = 26_000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))]; };
const pct = (x) => (x * 100).toFixed(2) + "%";
const f = (x, n = 3) => x.toFixed(n);
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
}
const crewCapacity = (nLots, e) => {
  const plat = Math.max(4, Math.round(nLots / 165));
  const grown = e?.pop0 && e.population ? clamp(e.population / e.pop0, 0.7, 4) : 1;
  return Math.max(4, Math.round(plat * grown * clamp(e?.crewIdx ?? 1, 0.5, 3.0)));
};

const runs = [];
for (const [i, seed] of SEEDS.entries()) {
  const { parcels: P0, adjacency, bbls } = loadCity(i, E.normalizeParcels);
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const s = [];
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;
    const owed = e.startOwed ? Object.values(e.startOwed).reduce((a, v) => a + Math.max(0, v), 0) : 0;
    const pipe = CLASSES.reduce((a, k) => a + (e.pipeline?.[k] ?? 0), 0);
    const stk = CLASSES.reduce((a, k) => a + (e.stock?.[k] ?? 0), 0);
    s.push({
      m, owed, pipe, stk,
      buildEma: e.buildEma ?? 0,
      util: e.crewUtil ?? 1,
      cidx: e.crewIdx ?? 1,
      pipeShare: stk > 0 ? pipe / stk : 0,
      wanted: owed / TYPICAL_SF,
      live: (g.cityJobs ?? []).filter((j) => !j.orphaned).length,
      cap: crewCapacity(bbls.length, e),
      cost: e.costIdx,
      cpi: e.cpi ?? 1,
      rent: e.rentIdx.office,
    });
  }
  runs.push({ seed, s });
}

console.log(`\nCAN THE COST CHANNEL SEE A BOOM? — ${SEEDS.length} seeds x ${HZ}m\n`);

// what pivot does the engine use, and where does heat actually sit?
console.log(`HEAT = clamp((crewUtil - 1) * 3.5, -1.9, 3.1)`);
console.log("  seed   crewUtil p05/median/p95     heat p05/median/p95    %at ceiling  %at floor");
for (const { seed, s } of runs) {
  const be = s.map((r) => r.util);
  const ht = be.map((v) => clamp((v - 1) * 3.5, -1.9, 3.1));
  console.log(`  ${String(seed).padStart(7)}  ${f(q(be, 0.05), 4)}/${f(q(be, 0.5), 4)}/${f(q(be, 0.95), 4)}`
    + `   ${f(q(ht, 0.05), 2).padStart(6)}/${f(q(ht, 0.5), 2)}/${f(q(ht, 0.95), 2)}`.padEnd(26)
    + `${pct(ht.filter((v) => v >= 3.099).length / ht.length).padStart(11)}`
    + `${pct(ht.filter((v) => v <= -1.899).length / ht.length).padStart(11)}`);
}

// THE CENTRAL QUESTION: does DEMAND for construction reach the PRICE of it?
console.log("\nDOES DEMAND FOR CONSTRUCTION REACH ITS PRICE?");
console.log("  corr(x, next 12m REAL cost growth) — a live price channel is positive and large");
console.log("  seed    supplied qty (pipeShare)   DEMANDED qty (wanted/cap)   excess demand (owed)");
for (const { seed, s } of runs) {
  const fwd = [], sup = [], dem = [], exc = [];
  for (let i = 0; i + 12 < s.length; i++) {
    const realNow = s[i].cost / s[i].cpi, realFwd = s[i + 12].cost / s[i + 12].cpi;
    fwd.push(Math.log(realFwd / realNow));
    sup.push(s[i].pipeShare);
    dem.push(s[i].wanted / Math.max(1, s[i].cap));
    exc.push(s[i].owed);
  }
  console.log(`  ${String(seed).padStart(7)} ${f(corr(sup, fwd), 2).padStart(20)} ${f(corr(dem, fwd), 2).padStart(26)} ${f(corr(exc, fwd), 2).padStart(22)}`);
}

// how far does demand exceed supply, and is that ratio itself cyclical?
console.log("\nEXCESS DEMAND FOR CRANES  (wanted / capacity — 1.0 means the town can just keep up)");
console.log("  seed      p05    median      p95      max     months >1.0");
for (const { seed, s } of runs) {
  const r = s.map((x) => x.wanted / Math.max(1, x.cap));
  console.log(`  ${String(seed).padStart(7)} ${f(q(r, 0.05), 2).padStart(8)} ${f(q(r, 0.5), 2).padStart(9)}`
    + ` ${f(q(r, 0.95), 2).padStart(8)} ${f(Math.max(...r), 2).padStart(8)} ${pct(r.filter((v) => v > 1).length / r.length).padStart(14)}`);
}

// what a live channel would have looked like: the pipe share the town WOULD
// have run at if every wanted crane had broken ground.
console.log("\nWHAT THE PIPELINE WOULD BE IF THE WALL WERE NOT THERE");
console.log("  (unconstrained share of stock under construction, vs the 0.018 pivot)");
console.log("  seed    actual pipeShare median    unconstrained median    ratio");
for (const { seed, s } of runs) {
  const act = s.map((r) => r.pipeShare);
  // every wanted crane at TYPICAL_SF, carried over a ~40m build
  const unc = s.map((r) => (r.pipe + r.owed) / r.stk);
  console.log(`  ${String(seed).padStart(7)} ${f(q(act, 0.5), 4).padStart(22)} ${f(q(unc, 0.5), 4).padStart(23)}`
    + ` ${f(q(unc, 0.5) / q(act, 0.5), 1).padStart(8)}x`);
}

// and the real cost trajectory this produces
console.log("\nREAL CONSTRUCTION COST OVER FIFTY YEARS  (cost / cpi)");
console.log("  seed     start      end    real CAGR      vs real rent CAGR");
for (const { seed, s } of runs) {
  const c0 = s[0].cost / s[0].cpi, c1 = s.at(-1).cost / s.at(-1).cpi;
  const r0 = s[0].rent / s[0].cpi, r1 = s.at(-1).rent / s.at(-1).cpi;
  console.log(`  ${String(seed).padStart(7)} ${f(c0, 2).padStart(8)} ${f(c1, 2).padStart(8)}`
    + ` ${pct(Math.pow(c1 / c0, 12 / HZ) - 1).padStart(12)} ${pct(Math.pow(r1 / r0, 12 / HZ) - 1).padStart(22)}`);
}
console.log("\nTHE WORKFORCE INDEX  (crewIdx — guards are 0.5 and 3.0 and should not bind)");
console.log("  seed      p05   median      p95      max   %at floor  %at ceiling");
for (const { seed, s } of runs) {
  const c = s.map((r) => r.cidx);
  console.log(`  ${String(seed).padStart(7)} ${f(q(c,0.05),2).padStart(8)} ${f(q(c,0.5),2).padStart(8)} ${f(q(c,0.95),2).padStart(8)} ${f(Math.max(...c),2).padStart(8)}`
    + ` ${pct(c.filter((v)=>v<=0.501).length/c.length).padStart(11)} ${pct(c.filter((v)=>v>=2.999).length/c.length).padStart(12)}`);
}
console.log("\n  Real US construction cost is roughly flat over the long run and swings");
console.log("  +8-10%/yr in a boom, -5-6%/yr in a bust. Real rent should not outrun it forever.\n");
