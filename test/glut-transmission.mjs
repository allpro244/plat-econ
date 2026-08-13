// GLUT TRANSMISSION — empty space must reach NOI, credit, labour (ECONOMY.md H).
//
//   node test/glut-transmission.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const SEEDS = (process.env.SEEDS ?? "910117,550991,12007,73303,11,22").split(",").map(Number);
const WARM = 36;
const HZ = 144;

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const clone = () => structuredClone(P0);
const med = (a) => {
  const b = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN;
};
const keepAlive = (g) => (g.gameOver ? { ...g, gameOver: null, cash: 6e6 } : g);

function cityNoiProxy(e) {
  let noi = 0;
  for (const k of ["office", "retail", "multifamily", "industrial"]) {
    const occ = e.occupied?.[k] ?? 0;
    const ask = e.rentIdx?.[k] ?? 0;
    const conc = e.concIdx?.[k] ?? 0;
    noi += occ * ask * (1 - 0.14 * conc);
  }
  return noi;
}

console.log("\nGLUT TRANSMISSION — paired +4M empty office vs control\n");
let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

const rows = [];
for (const seed of SEEDS) {
  const parcels = clone();
  let g0 = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  for (let m = 0; m < WARM; m++) g0 = keepAlive(E.advanceMonth(g0, parcels, bbls, adjacency));

  const walk = (glut) => {
    const p = structuredClone(parcels);
    let g = structuredClone(g0);
    if (glut) E.addStock(g.econ, "office", 4_000_000);
    const series = [];
    for (let m = 0; m < HZ; m++) {
      g = keepAlive(E.advanceMonth(g, p, bbls, adjacency));
      const policy = g.econ.nat?.policy ?? g.econ.indexRate;
      series.push({
        vac: g.econ.cityVac.office,
        jobs: g.econ.jobs,
        unemp: g.econ.unemployment,
        credit: g.econ.creditIdx,
        policy,
        loan: g.econ.indexRate,
        prem: g.econ.indexRate - policy,
        conc: g.econ.concIdx?.office ?? 0,
        noi: cityNoiProxy(g.econ),
        phase: g.econ.phase,
      });
    }
    return series;
  };

  const g = walk(true), c = walk(false);
  const mean = (xs, a, b, f) => {
    const sl = xs.slice(a, b);
    return sl.reduce((acc, x) => acc + f(x), 0) / Math.max(1, sl.length);
  };
  const row = {
    seed,
    peakVac: Math.max(...g.map((x) => x.vac)),
    dJobs48: g[48].jobs - c[48].jobs,
    dUnemp48: g[48].unemp - c[48].unemp,
    dNoi48: g[48].noi / Math.max(1, c[48].noi) - 1,
    dConc: mean(g, 24, 96, (x) => x.conc) - mean(c, 24, 96, (x) => x.conc),
    dCredit: mean(g, 24, 96, (x) => x.credit) - mean(c, 24, 96, (x) => x.credit),
    dPolicy: mean(g, 24, 96, (x) => x.policy) - mean(c, 24, 96, (x) => x.policy),
    dPrem: mean(g, 24, 96, (x) => x.prem) - mean(c, 24, 96, (x) => x.prem),
  };
  rows.push(row);
  console.log(
    `  seed ${seed}: peakVac ${(row.peakVac * 100).toFixed(0)}%  `
    + `Δjobs ${Math.round(row.dJobs48)}  ΔU ${(row.dUnemp48 * 100).toFixed(2)}pp  `
    + `ΔNOI ${(row.dNoi48 * 100).toFixed(1)}%  Δcredit ${row.dCredit.toFixed(3)}  `
    + `Δpolicy ${row.dPolicy >= 0 ? "+" : ""}${row.dPolicy.toFixed(2)}  `
    + `Δprem ${row.dPrem >= 0 ? "+" : ""}${row.dPrem.toFixed(2)}`,
  );
}

const m = (k) => med(rows.map((r) => r[k]));
check(m("dNoi48") < -0.05, `landlord income hears glut: median ΔNOI@48 ${(m("dNoi48") * 100).toFixed(1)}% (need < −5%)`);
check(m("dCredit") < -0.02, `credit hears glut: median Δcredit ${m("dCredit").toFixed(3)} (need < −0.02)`);
check(m("dJobs48") < -200 || m("dUnemp48") > 0.002,
  `labour hears glut: Δjobs ${Math.round(m("dJobs48"))} ΔU ${(m("dUnemp48") * 100).toFixed(2)}pp`);
check(m("dConc") > 0.05, `concessions rise: median Δconc ${(m("dConc") * 100).toFixed(1)}pp (need > 5)`);
check(m("dPolicy") <= 0.35, `policy does not tighten into glut: Δpolicy ${m("dPolicy").toFixed(2)} (need ≤ +0.35)`);
check(m("dPrem") >= 0.05, `term premium widens: Δprem ${m("dPrem").toFixed(2)} (need ≥ +0.05)`);

if (bad) {
  console.log(`\n${bad} glut-transmission check(s) failed.\n`);
  process.exit(1);
}
console.log("\nAll glut-transmission checks passed.\n");
