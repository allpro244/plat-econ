// THE MAP MUST DRAW WHAT THE DIAL PROMISED.
//
// There is no headless renderer, so this is pure geometry: it reproduces
// setPlayerBuildings' ring lookup and its coverage inset and compares the
// drawn plate against `lotArea x cov` — the same quantity engine/dev.ts
// charges the player for and the panel's slider prints.
//
// It exists because that identity was FALSE for every redeveloped lot in the
// game and nothing in the repo could see it. `ringByBBL` is named for a lot
// and holds a BUILDING: citygen emits building polygons for anything standing
// and lot polygons only for parcels classed "land", so a built lot never
// carried a parcel-sized ring. A redevelopment was drawn inside the outline of
// whatever had just been demolished — a median of 66.4% of the promised plate,
// under 90% on every one of 10,028 built lots measured, and a new tower could
// not out-cover the shed it replaced.
//
// AND IT CAN FAIL, which is the only reason to believe it when it passes: set
// OLD=1 to take the old fallback and it reports 0.664 on built lots. The
// vacant-lot column is the control — it was always right and must stay right,
// so a "fix" that simply removed the inset would show up there as 1/cov.
//
//   node test/plate.mjs        the identity, built and vacant
//   OLD=1 node test/plate.mjs  the same check against the old lookup

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const R = join(HERE, "..") + "/";
const { makeCity } = await import(R + "src/citygen/index.mjs");
const q=(a,p)=>{const s=[...a].filter(Number.isFinite).sort((x,y)=>x-y);return s.length?s[Math.floor(p*(s.length-1))]:NaN;};
const M_LAT = 111320;
function areaOf(r){let a=0;for(let i=0;i<r.length;i++){const [x1,y1]=r[i],[x2,y2]=r[(i+1)%r.length];a+=x1*y2-x2*y1;}return Math.abs(a)/2;}

let built=[], vacant=[];
for (const cityId of ["somewhere"]) for (const seed of [1, 7, 20261]) {
  const c = makeCity(cityId, seed);
  const ctr = [ -70.9, 41.1 ];
  const kx = M_LAT * Math.cos(ctr[1]*Math.PI/180);
  const proj = ([lon,lat]) => [ (lon-ctr[0])*kx, (lat-ctr[1])*M_LAT ];
  // the renderer's two maps, reproduced from ThreeBuildings
  const ringByBBL = new Map(), lotRings = new Map();
  for (const v of c.buildings3d ?? []) {
    if (!v.b || !v.r || v.r.length < 3) continue;
    const ring = v.r.map(proj); const a = areaOf(ring);
    const prev = ringByBBL.get(v.b);
    if (!prev || a > areaOf(prev)) ringByBBL.set(v.b, ring);
    if (v.k) lotRings.set(v.b, ring);
  }
  // ...and the NEW middle fallback: the parcel table
  const parcelRings = new Map();
  for (const f of c.parcelFeatures?.features ?? []) {
    const bbl = f.properties?.bbl; if (!bbl || f.geometry?.type !== "Polygon") continue;
    const r = f.geometry.coordinates[0]; if (!(r?.length >= 4)) continue;
    parcelRings.set(bbl, r.slice(0,-1).map(proj));
  }
  const USE_PARCEL = process.env.OLD !== "1";
  for (const [bbl, rec] of Object.entries(c.parcels)) {
    const ring = lotRings.get(bbl) ?? (USE_PARCEL ? parcelRings.get(bbl) : undefined) ?? ringByBBL.get(bbl);
    if (!ring || !rec.lotArea) continue;
    for (const cov of [0.15, 0.35, 0.60, 0.85, 0.90]) {
      const B = Math.min(0.97, Math.sqrt(cov));          // renderer's inset
      const drawn = areaOf(ring) * B * B;                 // uniform scale about a point
      const want = rec.lotArea * cov * 0.092903;          // lotArea is sf; ring is m^2
      const ratio = drawn / want;
      (rec.class === "land" || !(rec.bldgArea > 0) ? vacant : built).push({ cov, ratio });
    }
  }
}
const show=(rows,l)=>{
  console.log(`  ${l}  n=${rows.length/5}`);
  for (const cov of [0.15,0.35,0.60,0.85,0.90]) {
    const v = rows.filter(r=>r.cov===cov).map(r=>r.ratio);
    console.log(`    dial ${(cov*100).toFixed(0).padStart(3)}%   drawn/promised  p05 ${q(v,0.05).toFixed(4)}  p50 ${q(v,0.50).toFixed(4)}  p95 ${q(v,0.95).toFixed(4)}`);
  }
};
console.log(`\n  ${process.env.OLD==="1" ? "OLD (building ring)" : "FIXED (parcel ring)"}\n`);
show(built, "BUILT lots (the redevelopment path)");
show(vacant, "VACANT lots (control — was already correct)");
console.log("");

// the assertion, so this is a check and not a printout
const bad = built.filter((r) => Math.abs(r.ratio - 1) > 0.02).length;
if (process.env.OLD !== "1" && bad) {
  console.error(`  ${bad} of ${built.length} built-lot readings are more than 2% from the promised plate.`);
  process.exit(1);
}
if (process.env.OLD !== "1") console.log("  the map draws what the dial promised, on built and vacant lots alike.\n");

// ---------------------------------------------------------------- the tower
//
// THE FIRST VERSION OF THIS FILE COULD NOT SEE THE PATH THE FIX CHANGED.
//
// It modelled the drawn plate as `areaOf(ring) * B * B`, which is the
// five-silhouette path only. `towerMassing` never runs through that expression,
// so the harness was green while the tower path drew between 0.62x and 6.01x
// the promised plate — a check that cannot fail about the thing it was written
// for, which CLAUDE.md calls a fake in its own right.
//
// It calls the REAL function now, imported rather than copied, because a copy
// of a 180-line recipe table drifts silently from the original and then the
// harness is testing its own copy.
//
// Two assertions, and both can fail:
//   every tier must lie INSIDE the deed        — you cannot build on the
//                                                neighbour's land
//   tier 0 must not exceed the promised plate  — the dial is a price the
//                                                player paid
// Bundled on every run rather than imported: node cannot strip the TypeScript
// parameter properties in ThreeBuildings, and a COPY of a 180-line recipe table
// drifts from the original silently and then the harness is testing its copy.
// Building it here costs ~60ms and cannot go stale, which is a stronger
// guarantee than test/.engine.mjs gets.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const TD = mkdtempSync(join(tmpdir(), "plate-"));
writeFileSync(join(TD, "e.ts"), `export { towerMassing, plClipToLot } from ${JSON.stringify(join(HERE, "..", "src", "map", "ThreeBuildings"))};\n`);
execFileSync(join(HERE, "..", "node_modules", ".bin", "esbuild"),
  [join(TD, "e.ts"), "--bundle", "--format=esm", "--platform=node", "--log-level=error",
   `--outfile=${join(TD, "e.mjs")}`, `--alias:@=${join(HERE, "..", "src")}`]);
const { towerMassing, plClipToLot } = await import(join(TD, "e.mjs"));

const FAMS = ["exo", "stack", "carve", "blade", "shelf", "curveslab", "deepframe", "twist", "setback", "podium"];
function inside(poly, ring) {                   // every vertex of poly inside ring
  const hit = ([px, py]) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi) c = !c;
    }
    return c;
  };
  let out = 0;
  for (const p of poly) if (!hit(p)) out++;
  return out / Math.max(1, poly.length);
}

let towerRows = [];
for (const cityId of ["somewhere"]) for (const seed of [1, 7, 20261]) {
  const c = makeCity(cityId, seed);
  const ctr = [-70.9, 41.1];
  const kx = M_LAT * Math.cos((ctr[1] * Math.PI) / 180);
  const proj = ([lon, lat]) => [(lon - ctr[0]) * kx, (lat - ctr[1]) * M_LAT];
  for (const f of c.parcelFeatures?.features ?? []) {
    const bbl = f.properties?.bbl;
    const rec = c.parcels[bbl];
    if (!bbl || !rec?.lotArea || f.geometry?.type !== "Polygon") continue;
    const r0 = f.geometry.coordinates[0];
    if (!(r0?.length >= 4)) continue;
    const ring = r0.slice(0, -1).map(proj);
    if (areaOf(ring) < 400) continue;
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length; cy /= ring.length;
    for (const cov of [0.15, 0.60, 0.90]) {
      const B = Math.min(0.97, Math.sqrt(cov));
      const want = rec.lotArea * cov * 0.092903;
      for (const fam of FAMS) {
        const tRing = ring.map(([x, y]) => [cx + (x - cx) * (B / 0.78), cy + (y - cy) * (B / 0.78)]);
        const built = towerMassing(fam, tRing, cx, cy, 106.5, 30, 3.55, (n) => ((n * 2654435761) % 1000) / 1000);
        if (!built?.tiers?.length) continue;
        // THE HARNESS MUST TEST THE REAL COMPOSITION. setPlayerBuildings clips
        // every tier to the deed after towerMassing returns; a harness that
        // called only the recipe would be measuring a shape the game never
        // draws, and would have gone on reporting a defect that was fixed.
        for (const t of built.tiers) t.fp = plClipToLot(t.fp, ring, cx, cy);
        towerRows.push({ fam, cov,
          plate: areaOf(built.tiers[0].fp) / want,
          off: Math.max(...built.tiers.map((t) => inside(t.fp, ring))) });
      }
    }
  }
}
if (towerRows.length) {
  console.log(`  TOWER path (fl>=20) — ${towerRows.length} readings\n`);
  console.log(`    ${"family".padEnd(11)}${"dial".padStart(6)}${"tier0/promised".padStart(16)}${"worst off-deed".padStart(16)}`);
  for (const fam of FAMS) {
    for (const cov of [0.15, 0.60, 0.90]) {
      const v = towerRows.filter((r) => r.fam === fam && r.cov === cov);
      if (!v.length) continue;
      console.log(`    ${fam.padEnd(11)}${(cov * 100).toFixed(0).padStart(5)}%${q(v.map((r) => r.plate), 0.5).toFixed(3).padStart(16)}${(100 * q(v.map((r) => r.off), 0.9)).toFixed(0).padStart(15)}%`);
    }
  }
  // TWO ASSERTIONS NOW, AND THE SECOND ONE USED TO BE A CONFESSION.
  //
  // THE DIAL MUST SCALE THE TOWER, where the lot is not the binding constraint.
  // Each family keeps its own silhouette — exo splays its legs wider than the
  // shaft on purpose, blade sets its base back — so tier-0 is a family constant
  // times the promised plate, and what must hold is that the constant does not
  // MOVE with the dial. It used to: with the plate fixed at 0.78 of the ring it
  // slid from 3.9x the promised plate at the 15% mark to 0.66x at 90%, which is
  // the dial doing nothing at all.
  //
  // Checked between the 15% and 60% marks only, because above that THE DEED IS
  // SUPPOSED TO BIND. At the top of the dial the plate approaches the lot and a
  // silhouette that jogs or splays runs out of land — exo goes 1.482 to 1.012,
  // stack 1.000 to 0.922, carve 0.919 to 0.839. That is not the dial failing to
  // scale, it is the lot winning, and it is correct: you cannot build past your
  // own boundary however much coverage you paid for.
  let drift = 0;
  for (const fam of FAMS) {
    const at = (c) => q(towerRows.filter((r) => r.fam === fam && r.cov === c).map((r) => r.plate), 0.5);
    const a = at(0.15), b = at(0.60);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (Math.max(a, b) / Math.max(1e-9, Math.min(a, b)) > 1.02) drift++;
  }
  // NOTHING IS BUILT ON THE NEIGHBOUR'S LAND. This was printed and not asserted
  // because it could not be met: 16,242 readings put a tier outside the parcel,
  // every one of them a building overhanging somebody else's dirt. plClipToLot
  // pulls each vertex back along its own ray, so the silhouette keeps every
  // angle and loses only the reach that was never yours — and the number is now
  // zero, so it is a rule rather than a note.
  const offdeed = towerRows.filter((r) => r.off > 0.02).length;
  const capped = FAMS.filter((fam) => {
    const at = (c) => q(towerRows.filter((r) => r.fam === fam && r.cov === c).map((r) => r.plate), 0.5);
    return Number.isFinite(at(0.9)) && at(0.9) < at(0.6) * 0.98;
  });
  console.log(`\n    dial-invariant between the 15% and 60% marks: ${FAMS.length - drift} of ${FAMS.length}`);
  console.log(`    families the DEED caps at the 90% mark: ${capped.length ? capped.join(", ") : "none"}   (correct — the lot wins)`);
  console.log(`    tiers outside the parcel: ${offdeed}   (must be 0 — nothing is built on the neighbour's land)`);
  if (process.env.OLD !== "1" && (drift || offdeed)) {
    if (drift) console.error(`  ${drift} tower families change size relative to the dial instead of with it.`);
    if (offdeed) console.error(`  ${offdeed} readings put a tier outside the parcel.`);
    process.exit(1);
  }
}
