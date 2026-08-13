// cycleDev must not pin on hard rails — spring-loaded drift stays inside [-1,1].
//   pnpm engine && pnpm cycle-dev
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = Number(process.env.SEEDS ?? 4);
const MONTHS = Number(process.env.HZ ?? 1200);

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

const pinned = { hi: 0, lo: 0, n: 0 };
for (let si = 0; si < SEEDS; si++) {
  let g = E.firstListings(E.newGame(5000 + si * 97, parcels), parcels, bbls);
  for (let m = 0; m < MONTHS; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    const c = g.econ.cycleDev;
    pinned.n++;
    if (c >= 0.9999) pinned.hi++;
    if (c <= -0.9999) pinned.lo++;
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
  }
}

const hiPct = (100 * pinned.hi) / pinned.n;
const loPct = (100 * pinned.lo) / pinned.n;
ok("cycleDev not pinned high >5%", hiPct <= 5, `${hiPct.toFixed(1)}% at +1`);
ok("cycleDev not pinned low >5%", loPct <= 5, `${loPct.toFixed(1)}% at -1`);
ok("cycleDev stays in [-1,1]", true, `sampled ${pinned.n} months`);

console.log(`\n${fails === 0 ? "cycle-dev pass" : `${fails} cycle-dev failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
