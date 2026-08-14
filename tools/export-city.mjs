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
import { writeFileSync } from "node:fs";
import { makeCity, PROCEDURAL, DEFAULT_SIZE } from "../src/citygen/index.mjs";

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};

const seed = (parseInt(arg("seed", "1"), 10) >>> 0) || 1;
const size = arg("size", DEFAULT_SIZE);
const density = arg("density", undefined);
const out = arg("out", `city-${seed}.json`);

const t0 = Date.now();
const city = makeCity(PROCEDURAL, seed, { size, density });

// The renderer-facing parcel record: quantities only, and only the stable
// ones. landPsf/history/assessed values churn with calibration and belong to
// the economy; the renderer keys form off what is physically on the lot.
const parcels = {};
for (const [bbl, p] of Object.entries(city.parcels)) {
  parcels[bbl] = {
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
