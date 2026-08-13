// ONE DEVELOPMENT HURDLE, READ BY EVERY BUILDER.
//
//   pnpm engine && pnpm exec node test/underwriting.mjs
//
// This is a directional test, not a calibration target: dearer money, dearer
// construction, more vacancy or dearer land may never improve the set of sites
// an autonomous builder can rationally start.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
const base = E.firstListings(E.newGame(88117, parcels), parcels, bbls);
const USES = ["office", "retail", "multifamily", "industrial"];
const sites = bbls.filter((b) => parcels[b]?.class === "land" && parcels[b]?.lotArea >= 2_500).slice(0, 240);

function read(g) {
  const ratios = [];
  let clear = 0, plans = 0;
  for (const bbl of sites) {
    const rec = parcels[bbl];
    for (const use of USES) {
      const floors = Math.min(14, E.maxFloorsFor(rec, 0.62, use));
      const u = E.underwriteDevelopment(g, parcels, bbl, use, floors, 0.62);
      if (!u) continue;
      plans++;
      ratios.push(u.plan.hurdleRatio);
      if (u.clears) clear++;
      const required = u.plan.exitCap * (1 + E.DEV_MARGIN);
      if (Math.abs(u.plan.requiredYield - required) > 1e-9) {
        throw new Error("Parcel desk and shared hurdle disagree.");
      }
    }
  }
  ratios.sort((a, b) => a - b);
  return {
    plans,
    clear,
    median: ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0,
  };
}

function shocked(edit) {
  const g = structuredClone(base);
  edit(g);
  return read(g);
}

const control = read(base);
const rate = shocked((g) => { g.econ.indexRate += 3; });
const cost = shocked((g) => { g.econ.costIdx *= 1.30; });
const vacancy = shocked((g) => {
  for (const k of USES) g.econ.cityVac[k] = Math.min(0.4, g.econ.cityVac[k] + 0.10);
});
const land = shocked((g) => { g.econ.landIdx *= 1.30; });

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};
const line = (name, x) =>
  console.log(`  ${name.padEnd(14)} ${String(x.clear).padStart(4)} clear / ${x.plans} · median ${(100 * x.median).toFixed(0)}% of hurdle`);

console.log("\nONE DEVELOPMENT UNDERWRITING HURDLE\n");
line("control", control);
line("+300bp", rate);
line("+30% cost", cost);
line("+10pt vacancy", vacancy);
line("+30% land", land);
console.log("");

check(control.plans > 100, "the test prices a real cross-section of sites and uses");
for (const [name, x] of [["rates", rate], ["costs", cost], ["vacancy", vacancy], ["land", land]]) {
  check(x.clear <= control.clear, `higher ${name} do not create more financeable projects`);
  check(x.median <= control.median + 1e-9, `higher ${name} do not improve median project economics`);
}

console.log("");
process.exit(bad ? 1 : 0);
