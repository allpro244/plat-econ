// WHAT HAPPENS IF THE RATE NEVER COMES DOWN.
//
// The owner's question, verbatim: test what happens if the interest rate stays
// above 12% for an entire simulation. This is not a hypothetical — the real
// thing did it for the better part of a decade, and every underwriting
// assumption anybody made in 1976 was wrong by 1981.
//
// The city is run three times over fifty years with nobody playing: once with
// the rate free to do whatever the central bank does, once pinned above 12%,
// once pinned above 16%. The pin is applied AFTER each month's engine step, so
// the whole of the rest of the simulation — values, development margins,
// lender capital, rival leverage, cap rates, the space market — reads the high
// rate and answers it. Nothing else is touched.
//
//   node test/rate-stress.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = [550991, 12007, 73303, 11, 22];
const MONTHS = 600;
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
const pct = (x) => (x * 100).toFixed(1) + "%";

function run(seed, pin) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const start = { ...g.econ.stock };
  let starts = 0, lenderFails = 0, rivalFails = 0, peakVac = 0;
  const liveAtStart = g.rivals.length;
  const failedLenders = new Set();
  let vacSum = 0, rateSum = 0;
  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const e = g.econ;
    if (pin) {
      // THE PIN GOES ON THE POLICY RATE, not just on the loan index. Pinning
      // the index alone was a lie by omission: the central bank never noticed,
      // the national recession hazard reads the REAL policy rate and so never
      // fired, and the country sailed through fifty years of twelve per cent
      // money without a downturn. Money that expensive is a macroeconomic
      // event, and the test has to let it be one.
      const n = e.nat;
      if (n) n.policy = Math.max(pin - 1.55, n.policy);
      e.indexRate = Math.max(pin, e.indexRate);
      e.rateRegime = Math.max(pin, e.rateRegime);
    }
    rateSum += e.indexRate;
    const vac = e.cityVac?.office ?? 0;
    peakVac = Math.max(peakVac, vac);
    vacSum += vac;
    for (const l of g.lenders) if (l.failedM !== undefined) failedLenders.add(l.name + ":" + l.failedM);
  }
  lenderFails = failedLenders.size;
  const liveNow = g.rivals.filter((r) => !r.dead && !r.failedM).length;
  rivalFails = Math.max(0, liveAtStart - liveNow);
  const e = g.econ;
  const grow = (k) => (e.stock[k] ?? 0) / Math.max(1, start[k] ?? 1) - 1;
  return {
    rate: rateSum / MONTHS,
    stockOffice: grow("office"),
    stockAll: (["office", "retail", "multifamily", "industrial"].reduce((a, k) => a + (e.stock[k] ?? 0), 0))
      / Math.max(1, ["office", "retail", "multifamily", "industrial"].reduce((a, k) => a + (start[k] ?? 0), 0)) - 1,
    vacAvg: vacSum / MONTHS, peakVac,
    rentReal: (e.rentIdx.office / 62.18) / Math.max(0.1, e.cpi),
    cpi: e.cpi, wage: e.wageIdx, pop: e.population, jobs: e.jobs,
    unemp: e.unemployment, credit: e.creditIdx,
    natUnemp: e.nat?.unemp ?? 0, natInfl: e.nat?.infl ?? 0,
    lenderFails, rivalFails, firmsLeft: liveNow,
  };
}

const SCEN = [["free", 0], ["pinned >12%", 12.0], ["pinned >16%", 16.0]];
const out = {};
for (const [label, pin] of SCEN) {
  const rs = SEEDS.map((s) => run(s, pin));
  out[label] = rs;
  const g = (k) => med(rs.map((r) => r[k]));
  console.log(`\n=== ${label} ${"=".repeat(46 - label.length)}`);
  console.log(`  loan index, mean over 50y      ${g("rate").toFixed(2)}%`);
  console.log(`  built stock, 50y change        office ${pct(g("stockOffice"))}   all classes ${pct(g("stockAll"))}`);
  console.log(`  office vacancy                 mean ${pct(g("vacAvg"))}   peak ${pct(g("peakVac"))}`);
  console.log(`  REAL office rent vs year 0     ${g("rentReal").toFixed(2)}x`);
  console.log(`  price level / wage index       CPI ${g("cpi").toFixed(2)}x   wages ${g("wage").toFixed(2)}x`);
  console.log(`  city at year 50                pop ${Math.round(g("pop")).toLocaleString()}   jobs ${Math.round(g("jobs")).toLocaleString()}   unemployment ${pct(g("unemp"))}`);
  console.log(`  credit index, year 50          ${g("credit").toFixed(2)}`);
  console.log(`  the nation at year 50          unemployment ${pct(g("natUnemp"))}   inflation ${pct(g("natInfl"))}`);
  console.log(`  failures                       ${g("lenderFails")} lender seizures   ${g("rivalFails")} firms gone, ${g("firmsLeft")} still standing`);
}

console.log("\n" + "=".repeat(64));
const f = out["free"], p = out["pinned >12%"];
const d = (k) => med(p.map((r) => r[k])) - med(f.map((r) => r[k]));
console.log(`A permanent 12% world versus a free one, over fifty years:`);
console.log(`  built stock            ${(d("stockAll") * 100).toFixed(1)}pp of 50-year growth`);
console.log(`  office vacancy         ${(d("vacAvg") * 100).toFixed(1)}pp on average`);
console.log(`  real office rent       ${(d("rentReal")).toFixed(2)}x`);
console.log(`  jobs                   ${Math.round(d("jobs")).toLocaleString()}`);
console.log(`  lender seizures        ${d("lenderFails").toFixed(1)}`);
console.log(`  firms lost             ${d("rivalFails").toFixed(1)}`);
console.log("");
