/**
 * Park frontage must leave a real carriageway between turf and lots.
 * The painted green is inset from the reservation; lots sit outside the
 * obstacle. Regressing PARK_CLEAR / PARK_KERB brings back "park overlaps
 * parcels" at rotated commons (Hartford Green, seed 3252).
 */
import { makeCity, PROCEDURAL } from "../src/citygen/index.mjs";

const PARK_CLEAR = 12;
const PARK_KERB = 1.0;
const MIN_PARK_TO_LOT = PARK_CLEAR + PARK_KERB - 0.75; // allow tiny numeric slack

function makeProjection(lon0, lat0) {
  const R = 6378137;
  const toRad = Math.PI / 180;
  const cos = Math.cos(lat0 * toRad);
  return {
    toM: ([lon, lat]) => [(lon - lon0) * toRad * R * cos, (lat - lat0) * toRad * R],
  };
}

function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const inter = ((yi > p[1]) !== (yj > p[1]))
      && (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-15) + xi);
    if (inter) inside = !inside;
  }
  return inside;
}

function distToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

function ringOf(f) {
  const g = f.geometry;
  if (g.type === "Polygon") return g.coordinates[0].slice(0, -1);
  return null;
}

const seeds = [3252, 1, 42, 4604];
let failed = 0;

for (const seed of seeds) {
  const city = makeCity(PROCEDURAL, seed, { size: "harbour" });
  const core = city.manifest?.core ?? city.manifest?.bbox;
  const lon0 = Array.isArray(core) && core.length === 2 ? core[0] : (city.manifest.bbox[0] + city.manifest.bbox[2]) / 2;
  const lat0 = Array.isArray(core) && core.length === 2 ? core[1] : (city.manifest.bbox[1] + city.manifest.bbox[3]) / 2;
  const proj = makeProjection(lon0, lat0);

  const parks = city.context.features
    .filter((f) => f.properties?.kind === "park")
    .map(ringOf)
    .filter(Boolean)
    .map((r) => r.map(proj.toM));
  const lots = city.parcelFeatures.features
    .map(ringOf)
    .filter(Boolean)
    .map((r) => r.map(proj.toM));

  let minD = Infinity;
  let parkHitsLot = 0;
  for (const pr of parks) {
    for (const lr of lots) {
      for (const pv of pr) {
        if (inRing(pv, lr)) parkHitsLot++;
        else minD = Math.min(minD, distToRing(pv, lr));
      }
      for (const lv of lr) {
        if (inRing(lv, pr)) parkHitsLot++;
        else minD = Math.min(minD, distToRing(lv, pr));
      }
    }
  }

  const ok = parkHitsLot === 0 && minD >= MIN_PARK_TO_LOT;
  console.log(
    `${ok ? "OK" : "FAIL"} seed ${seed}: min park↔lot ${minD.toFixed(2)} m `
    + `(want ≥ ${MIN_PARK_TO_LOT}) overlaps=${parkHitsLot}`,
  );
  if (!ok) failed++;
}

if (failed) {
  console.error(`\npark-clearance: ${failed} seed(s) failed`);
  process.exit(1);
}
console.log("\npark-clearance: all seeds clear");
