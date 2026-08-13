// THE BUILD-OUT LADDER, measured rather than described.
//
//   node test/buildout.mjs                 every preset on the standard island
//   BW_SEED=12345 node test/buildout.mjs   a different town
//
// The notes in citygen/index.mjs quote a vacancy percentage and a floor count
// for each preset. Those are claims about generated output and nothing was
// checking them, so this prints what the generator actually produces: how much
// of the island is still dirt, how tall it gets, and how much floor area is
// standing.
//
// It also asks the question the ladder cannot be widened without answering —
// DOES THE ECONOMY RUN DOWN THERE. A town that is 70% empty has very little
// built stock, and the demand model calibrates its reference densities off
// exactly that stock. An emptier preset is only a legitimate option if the
// engine still produces a city with jobs in it, rents on the board and firms
// trading, rather than a division by something near zero.
//
// And it watches the opening PRICE LEVEL. Demand indexes cancel town size, so
// without density→price in initEcon a Frontier town and a Metropolis open at
// the same rent. That is the fault the gap check at the bottom catches.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { makeCity, DEVELOPMENT } = await import(join(HERE, "../src/citygen/index.mjs"));

const SEED = Number(process.env.BW_SEED ?? 20261) >>> 0;
const CITY = process.env.BW_CITY ?? "somewhere";
const SIZE = process.env.BW_SIZE ?? "city";
const MONTHS = Number(process.env.MONTHS ?? 120);

const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : "0.0") + "%";
const fin = (v) => Number.isFinite(v);

console.log(`build-out ladder — ${CITY} seed ${SEED}, size ${SIZE}, economy run ${MONTHS}m\n`);
console.log(
  "preset".padEnd(12) + "vacant".padStart(8) + "bldgs".padStart(8) + "medFl".padStart(7) +
  "maxFl".padStart(7) + "M sf".padStart(9) + "  |" + "m0 rent".padStart(9) + "m0 land".padStart(9) +
  "wage".padStart(7) + "  |" + "jobs".padStart(10) + "off rent".padStart(10) +
  "vac".padStart(8) + "firms".padStart(7) + "listings".padStart(9) + "  health",
);

const openings = {};

for (const d of DEVELOPMENT) {
  const built = makeCity(CITY, SEED, { size: SIZE, density: d.id });
  const parcels = built.parcels;
  E.normalizeParcels(parcels);
  const bbls = Object.keys(parcels);

  let vacant = 0, bldgs = 0, sf = 0, maxFl = 0;
  const floors = [];
  for (const b of bbls) {
    const r = parcels[b];
    if (!r) continue;
    const f = r.floors ?? 0;
    if (r.class === "land" || f <= 0) { vacant++; continue; }
    bldgs++; floors.push(f);
    sf += (r.sf ?? r.grossSf ?? r.buildingSf ?? 0);
    if (f > maxFl) maxFl = f;
  }
  floors.sort((a, b) => a - b);
  const medFl = floors.length ? floors[Math.floor(floors.length / 2)] : 0;

  // ...and now the half that matters: does a town this empty have an economy.
  let g = E.firstListings(E.newGame(SEED, parcels), parcels, bbls);
  const e0 = g.econ;
  const m0Rent = e0.rentIdx?.office ?? NaN;
  const m0Land = e0.landIdx ?? NaN;
  const m0Wage = e0.wageIdx ?? NaN;
  openings[d.id] = { rent: m0Rent, land: m0Land, wage: m0Wage };
  const problems = [];
  for (let m = 0; m < MONTHS; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, built.adjacency);
  }
  const e = g.econ;
  const jobs = e.jobs ?? NaN;
  const offRent = e.rentIdx?.office ?? NaN;
  const offVac = e.cityVac?.office ?? NaN;
  const firms = (g.rivals ?? []).filter((r) => r.failedM === undefined).length;
  const listings = (g.listings ?? []).length;

  for (const [k, v] of [["jobs", jobs], ["office rent", offRent], ["office vac", offVac],
                        ["cpi", e.cpi], ["employIdx", e.employIdx], ["population", e.population]]) {
    if (!fin(v)) problems.push(`${k} is ${v}`);
  }
  if (fin(jobs) && jobs <= 0) problems.push("no jobs at all");
  if (fin(offVac) && (offVac < 0 || offVac > 1)) problems.push(`office vacancy ${offVac}`);
  if (!firms) problems.push("no firms left");
  // Every sector share must be a real number that sums to one, or the swan
  // wire and the block employment term are both reading noise.
  const sh = e.sectorShare ?? {};
  const shTot = Object.values(sh).reduce((a, b) => a + b, 0);
  if (!fin(shTot) || Math.abs(shTot - 1) > 0.01) problems.push(`sectorShare sums to ${shTot}`);

  console.log(
    d.id.padEnd(12) + pct(vacant, bbls.length).padStart(8) + String(bldgs).padStart(8) +
    String(medFl).padStart(7) + String(maxFl).padStart(7) + (sf / 1e6).toFixed(1).padStart(9) + "  |" +
    (fin(m0Rent) ? m0Rent.toFixed(1) : "NaN").padStart(9) +
    (fin(m0Land) ? m0Land.toFixed(2) : "NaN").padStart(9) +
    (fin(m0Wage) ? m0Wage.toFixed(2) : "NaN").padStart(7) + "  |" +
    (fin(jobs) ? Math.round(jobs).toLocaleString() : "NaN").padStart(10) +
    (fin(offRent) ? offRent.toFixed(1) : "NaN").padStart(10) +
    (fin(offVac) ? (offVac * 100).toFixed(1) + "%" : "NaN").padStart(8) +
    String(firms).padStart(7) + String(listings).padStart(9) + "  " +
    (problems.length ? "BROKEN: " + problems.join("; ") : "ok"),
  );
}

// Frontier dirt and Metropolis towers are not the same city. Opening office
// rent and landIdx must separate them — not by a menu coefficient, but because
// citywide floor intensity fed the Ahlfeldt elasticities in initEcon.
if (openings.frontier && openings.metropolis) {
  const fr = openings.frontier, mt = openings.metropolis;
  const rentGap = mt.rent / fr.rent;
  const landGap = mt.land / fr.land;
  console.log(`\nopening price ladder — Metropolis / Frontier: rent ×${rentGap.toFixed(2)}, landIdx ×${landGap.toFixed(2)}, wage ×${(mt.wage / fr.wage).toFixed(2)}`);
  if (!(rentGap > 1.15)) {
    console.error(`FAIL: Metropolis office rent must open materially above Frontier (got ×${rentGap.toFixed(3)})`);
    process.exitCode = 1;
  }
  if (!(landGap > 1.15)) {
    console.error(`FAIL: Metropolis landIdx must open materially above Frontier (got ×${landGap.toFixed(3)})`);
    process.exitCode = 1;
  }
}
