// EXPORT ONE CITY FOR A RENDERER.
//
// `node tools/export-city.mjs --seed=481923 --out=city.json` runs the whole
// pipeline — islandConfig, generateCity, buildCityData — and writes the subset
// a renderer is entitled to see: quantities and geometry, never form.
//
// This file IS the sim/renderer seam, serialized. The renderer (plat, today;
// anything else, later) gets:
//   - manifest ......... seed, name, projection origin, generation stats
//   - context .......... coast/esplanade/pier/park/apron rings (GeoJSON, lon/lat)
//   - stations ......... transit points with names and weights
//   - buildings3d ...... footprint rings + base/height metres + class/year/tone
//   - parcels .......... per-BBL quantities: class, mix, floors, areas,
//                        yearBuilt, district, demandScore, shore/corridor facts
// What it does NOT get: rents, balance sheets, adjacency, anything the game
// loop mutates. Those live in the save, not the map.
//
// Deterministic: same seed + size + density, byte-identical JSON (keys are
// written in fixed order by construction; JSON.stringify preserves insertion).
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCity, PROCEDURAL, DEFAULT_SIZE } from "../src/citygen/index.mjs";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};

const seed = (parseInt(arg("seed", "1"), 10) >>> 0) || 1;
const size = arg("size", DEFAULT_SIZE);
const density = arg("density", undefined);
const months = parseInt(arg("months", "0"), 10) || 0;
const out = arg("out", `city-${seed}.json`);

const t0 = Date.now();
const city = makeCity(PROCEDURAL, seed, { size, density });

// --months=N runs the actual simulation over the city before exporting, so
// per-parcel occupancy is the ECONOMY's answer, not a constant. Even N=0
// attaches the market model's day-one occupancy. Requires the engine bundle
// (pnpm engine) because the sim lives there, not in citygen.
let occOf = null;
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const bundle = join(HERE, "..", "test", ".engine.mjs");
  if (!existsSync(bundle)) {
    console.error("no engine bundle — run `pnpm engine` first (needed for occupancy export)");
    process.exit(1);
  }
  const E = await import(bundle);
  E.normalizeParcels(city.parcels);
  const bbls = Object.keys(city.parcels);
  let g = E.firstListings(E.newGame(7000 + seed, city.parcels), city.parcels, bbls);
  for (let m = 0; m < months; m++) g = E.advanceMonth(g, city.parcels, bbls, city.adjacency);
  occOf = (bbl) => {
    const rec = E.resolveRec(city.parcels, g, bbl);
    if (!rec || rec.class === "land") return { occ: 0, cond: null };
    const h = g.holdings[bbl];
    return {
      occ: +(h ? E.physicalOcc(rec, h) : E.occupancy(rec, g.econ)).toFixed(3),
      cond: h?.condIdx != null ? +h.condIdx.toFixed(3) : null,
    };
  };
}

// The renderer-facing parcel record: quantities only, and only the stable
// ones. landPsf/history/assessed values churn with calibration and belong to
// the economy; the renderer keys form off what is physically on the lot.
const parcels = {};
for (const [bbl, p] of Object.entries(city.parcels)) {
  const state = occOf(bbl);
  parcels[bbl] = {
    occ: state.occ,
    ...(state.cond != null ? { cond: state.cond } : {}),
    class: p.class,
    ...(p.mix ? { mix: p.mix } : {}),
    floors: p.floors,
    lotArea: p.lotArea,
    bldgArea: p.bldgArea,
    yearBuilt: p.yearBuilt,
    district: p.district,
    demandScore: p.demandScore,
    shoreM: p.shoreM,
    corridorM: p.corridorM,
    corner: p.corner,
    centroid: p.centroid,
  };
}

const doc = {
  months,
  format: "plat-city/1",
  id: city.id,
  seed: city.seed,
  size: city.size,
  name: city.name,
  manifest: city.manifest,
  stats: city.stats,
  context: city.context,
  stations: city.stations,
  buildings3d: city.buildings3d,
  parcels,
};

writeFileSync(out, JSON.stringify(doc));
console.log(
  `${out}: ${city.name} seed=${city.seed} size=${city.size} ` +
  `lots=${city.stats.lots} buildings=${city.stats.buildings} ` +
  `${(JSON.stringify(doc).length / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`,
);
