// The beautiful-buildings renderer: a Three.js custom layer inside MapLibre.
// Every building is a real mesh with a procedural facade — window grids
// aligned to actual floor counts, ~12 skin families by age and class,
// view-dependent sky reflections on glass, cornices, gabled colonial roofs,
// and instanced rooftop furniture. MapLibre still owns the ground map,
// camera, and picking.
import * as THREE from "three";
import maplibregl from "maplibre-gl";
import type { BuildingVolume } from "./volume";
export type { BuildingVolume };
import {
  S_LAWN, S_PATH, S_POND,
  S_GLASS, S_PREWAR, S_BRICK, S_MILL, S_PLAIN, S_ARTDECO, S_CORNICE, S_GREEN, S_LOT, S_GABLE, S_CRYSTAL, S_DIAGRID, S_PMOD,
  S_GOTHIC, S_BEAUX, S_ITALIANATE,
  S_FEDERAL, S_CHICAGO, S_CIVIC,
  S_CARRIAGE, S_MARKET, S_METALPAN,
  S_TERRAPIER, S_DEEPFRAME, S_STEELSHELF, S_UNITGLASS,
  S_MEGAPANEL,
  S_SKYGARDEN, S_PLEATED, S_SHINGLED, S_DOUBLESKIN, S_MEGABRACE, S_CHEVRON,
  S_MODULAR, S_PVCLAD, S_LABBLDG, S_MEDIAFACE, S_PRECAST, S_BALCONY, S_FRIT,
  T_MODERN, T_STONE, T_OLDROOF, T_CAPPED_PLAIN, T_TRADE,
  STYLE_SETS_GLSL, has, modernCap, styleFor, styleForBuilt, keyOf, hash01,
} from "./styles";

/** A context point that knows which way it is pointing. Bearing in degrees. */
export interface Oriented { p: [number, number]; r: number }

/**
 * Points scattered inside a ring, deterministically.
 *
 * A jittered lattice over the ring's bounding box, rejecting anything outside
 * the polygon. Lattice-then-reject rather than uniform random because a lot
 * wants its cars and its trees SPREAD — pure random clumps, and a clump of
 * cars in the corner of an acre of gravel reads as a wreck yard.
 */
function scatterInRing(ring: [number, number][], n: number, seed: number): [number, number][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const inside = (px: number, py: number) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * ((maxX - minX) / Math.max(1, maxY - minY)))));
  const rows = Math.max(1, Math.ceil(n / cols));
  let s = Math.floor(seed * 1e6) >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: [number, number][] = [];
  for (let r = 0; r < rows && out.length < n; r++) {
    for (let c = 0; c < cols && out.length < n; c++) {
      const px = minX + ((c + 0.5 + (rnd() - 0.5) * 0.7) / cols) * (maxX - minX);
      const py = minY + ((r + 0.5 + (rnd() - 0.5) * 0.7) / rows) * (maxY - minY);
      // 1.6 m in from the fence, so nothing straddles it
      if (inside(px, py) && inside(px + 1.6, py) && inside(px - 1.6, py) &&
          inside(px, py + 1.6) && inside(px, py - 1.6)) out.push([px, py]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE MASONRY. Four operations, and everything above ground is made of them.
//
// These were closures inside the generator's one big rebuild, which meant the
// only code that could lay a course of brick was code running inside that
// loop — and that is why the buildings the PLAYER puts up end in a flat plane
// while the ones the town started with have twelve different tops. The crown
// ladder could not be reached from the other path because the trowel could
// not be.
//
// They are pure geometry and they carry no state of their own; the per-volume
// scalars every triangle inherits live in a `MasonState` the caller owns and
// mutates as it walks its buildings. That is exactly how `curEra` and friends
// worked before, so the emitted vertex stream is unchanged.

/** The vertex buffers a wall or roof emitter writes into. */
export interface GeomBuf {
  pos: number[]; norm: number[]; u: number[]; style: number[]; rand: number[];
  varr: number[]; top: number[]; fh: number[]; seg: number[]; ccv: number[]; era: number[];
}

/** Blank buffers in the one shape every emitter here agrees on. */
export function geomBuf(): GeomBuf {
  return {
    pos: [], norm: [], u: [], style: [], rand: [],
    varr: [], top: [], fh: [], seg: [], ccv: [], era: [],
  };
}

/**
 * What every triangle emitted right now inherits, beyond its own meta.
 *
 * `era` is 0 = 1870, 1 = 2030 and is read by the facade and roof shaders for
 * patina and palette; `deck` and `wear` are the roof's surface and how tired
 * it is; `bearX`/`bearY` is the seam bearing the deck's felt runs along.
 */
export interface MasonState { era: number; deck: number; wear: number; bearX: number; bearY: number }

/**
 * Pull a ring in by `m` metres — negative to push it out, which is how a
 * cornice oversails. Toward the centroid rather than along the true offset,
 * so it collapses gracefully on a sliver instead of self-intersecting.
 */
export function insetRing(ring: [number, number][], m: number): [number, number][] | null {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  return ring.map(([x, y]) => {
    const vx = x - cx, vy = y - cy;
    const len = Math.hypot(vx, vy) || 1;
    const k = Math.max(0, 1 - m / len);
    return [cx + vx * k, cy + vy * k] as [number, number];
  });
}

/**
 * +1 at a convex ring vertex, -1 at a reflex one. Inside corners collect
 * shadow; outside corners catch light.
 */
function cornerSigns(ring: [number, number][]): number[] {
  const n = ring.length;
  return ring.map((p, i) => {
    const prev = ring[(i - 1 + n) % n], next = ring[(i + 1) % n];
    const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
    return cross >= 0 ? 1 : -1;   // rings are wound CCW by this point
  });
}

/**
 * On a roof, aU carries distance to the nearest edge — the shader uses it to
 * sink the deck into shade under its own parapet.
 */
function edgeDist(ring: [number, number][], p: [number, number]): number {
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

export interface Mason {
  /** One wall triangle, with its own edge span and corner convexity. */
  tri(T: GeomBuf, a: number[], b: number[], c: number[], n: number[], us: number[], meta: number[],
      seg?: [number, number], ccv?: [number, number]): void;
  /** A ring of wall between two heights. */
  wall(T: GeomBuf, ring: [number, number][], z0: number, z1: number, meta: number[]): void;
  /** A flat deck across a ring, subdivided so the edge gradient stays smooth. */
  cap(T: GeomBuf, ring: [number, number][], z: number, meta: number[]): void;
  /**
   * A PITCHED CAP: loft the footprint up and inward to a smaller ring, then
   * lay a deck across the top.
   *
   * One construction covers both roofs the old city is actually made of. Pull
   * the top ring in hard and the slopes nearly meet — a hip. Leave it wide and
   * make the rise steep and you get a mansard, its flat deck hidden behind the
   * slope, which is exactly what a Second Empire roof is. It works on any
   * convex footprint, unlike the four-sided gable path, so it reaches most of
   * the fabric instead of a handful of cottages.
   *
   * Returns false when the inset ate the whole footprint, so the caller can
   * fall back to a flat roof rather than emit a cone of slivers.
   */
  pitch(T: GeomBuf, ring: [number, number][], z: number, rise: number, inset: number, meta: number[]): boolean;
}

export function makeMason(st: MasonState): Mason {
  const tri: Mason["tri"] = (T, a, b, c, n, us, meta, seg = [-1e6, 1e6], ccv = [0, 0]) => {
    T.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) T.norm.push(n[0], n[1], n[2]);
    T.u.push(us[0], us[1], us[2]);
    for (let i = 0; i < 3; i++) {
      T.style.push(meta[0]); T.rand.push(meta[1]); T.varr.push(meta[2]); T.top.push(meta[3]); T.fh.push(meta[4]);
      T.era.push(st.era);
      T.seg.push(seg[0], seg[1]);
      T.ccv.push(ccv[0], ccv[1]);
    }
  };
  const wall: Mason["wall"] = (T, ring, z0, z1, meta) => {
    const signs = cornerSigns(ring);
    let perim = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      const n = [dy / len, -dx / len, 0];
      const u0 = perim, u1 = perim + len;
      perim += len;
      const seg: [number, number] = [u0, u1];
      const cc: [number, number] = [signs[i], signs[(i + 1) % ring.length]];
      tri(T, [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], n, [u0, u1, u1], meta, seg, cc);
      tri(T, [a[0], a[1], z0], [b[0], b[1], z1], [a[0], a[1], z1], n, [u0, u1, u0], meta, seg, cc);
    }
  };
  const cap: Mason["cap"] = (T, ring, z, meta) => {
    const pts = ring.map(([x, y]) => new THREE.Vector2(x, y));
    let tris: number[][] = [];
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch { tris = []; }
    // subdivide big triangles so the edge-distance gradient is smooth
    for (const t of tris) {
      const P = t.map((i) => ring[i]);
      const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const emit = (q: [number, number][]) => {
        const d = q.map((p) => edgeDist(ring, p));
        T.pos.push(q[0][0], q[0][1], z, q[1][0], q[1][1], z, q[2][0], q[2][1], z);
        for (let i = 0; i < 3; i++) T.norm.push(0, 0, 1);
        T.u.push(d[0], d[1], d[2]);
        for (let i = 0; i < 3; i++) {
          T.style.push(meta[0]); T.rand.push(meta[1]); T.varr.push(meta[2]); T.top.push(meta[3]); T.fh.push(meta[4]);
          T.era.push(st.era);
          T.seg.push(st.deck, st.wear); T.ccv.push(st.bearX, st.bearY);
        }
      };
      const area = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1])) / 2;
      if (area > 90) {
        const m01 = mid(P[0], P[1]), m12 = mid(P[1], P[2]), m20 = mid(P[2], P[0]);
        emit([P[0], m01, m20]); emit([m01, P[1], m12]); emit([m20, m12, P[2]]); emit([m01, m12, m20]);
      } else emit(P as [number, number][]);
    }
  };
  const pitch: Mason["pitch"] = (T, ring, z, rise, inset, meta) => {
    const top = insetRing(ring, inset);
    if (!top) return false;
    let span = 0;
    for (let i = 0; i < top.length; i++) {
      const a = top[i], b = top[(i + 1) % top.length];
      span = Math.max(span, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    if (span < 1.0) return false;   // insetRing clamps at the centroid
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const c = top[(i + 1) % top.length], d = top[i];
      const A = [a[0], a[1], z], B = [b[0], b[1], z];
      const C = [c[0], c[1], z + rise], D = [d[0], d[1], z + rise];
      const ux = B[0] - A[0], uy = B[1] - A[1];
      const wx = D[0] - A[0], wy = D[1] - A[1];
      // cross of the eave run (ux, uy, 0) with the rake (wx, wy, rise)
      let n = [uy * rise, -ux * rise, ux * wy - uy * wx];
      const L = Math.hypot(n[0], n[1], n[2]) || 1;
      n = n.map((q) => q / L);
      if (n[2] < 0) n = n.map((q) => -q);
      // u = 3 keeps the slope out of the parapet's edge-shading term, which
      // only means anything on a flat deck
      tri(T, A, B, C, n, [3, 3, 3], meta);
      tri(T, A, C, D, n, [3, 3, 3], meta);
    }
    cap(T, top, z + rise, meta);
    return true;
  };
  return { tri, wall, cap, pitch };
}


/**
 * WHAT A BUILDING WITH A FLAT ROOF ENDS IN.
 *
 * Crowns are 29% of a tower's pixels and roofs are 9.5% of the whole frame —
 * a bigger surface than the walls, and the part of it that sits against the
 * sky, where silhouette reads. "They all look similar" is almost always a
 * complaint about crowns rather than facades.
 *
 * Twelve families, offered by era, style and height, each built out of the
 * primitives in `Mason`. It emits the parapet or the cornice or the belvedere,
 * the optional green roof, and the bulkhead — and it reports back the deck the
 * roof kit should then be fitted to, which is the penthouse top when there is
 * one and the roof itself when there is not.
 */
export interface CrownIn {
  ring: [number, number][];
  z1: number;                 // top of this volume, in metres
  roof: boolean;              // this volume IS the building's roof, not a setback terrace
  deco: boolean;              // a decorative prop rather than a building
  bbl?: string;
  style: number; rnd: number; varr: number; fh: number;
  /** A shed, a plant or a warehouse — it ends in coping, never in a cornice. */
  industrial: boolean;
  area: number;               // signed plan area, for the pyramid's span
  cs: (n: number) => number;  // the crown's own hash stream, independent of the wall's
  pier: (n: number) => number;// a second stream, one draw per fin
  props: { kind: number; x: number; y: number; z: number; s: number; rot: number; b?: string }[];
}

export interface CrownOut {
  /** The plate the roof kit fits on: the bulkhead's top if it grew one. */
  mechDeck: { ring: [number, number][]; z: number } | null;
  /** How high that plate sits. */
  roofZ: number;
}

/**
 * WHAT THE FLAT ROOF IS COVERED IN.
 *
 * Nine surfaces — tar, EPDM, slag, terne, aluminised asphalt, PVC, white TPO,
 * mod-bit cap sheet, gravel ballast — and which one a building has is a
 * question about the decade it was roofed in, not about taste. Tar and gravel
 * before the war; single-ply from the eighties; a white cool roof is a
 * twenty-first century answer to an energy code.
 *
 * Shared, because it was two answers. `setPlayerBuildings` picked from a fixed
 * six-entry list off the deed hash, era-blind — so every roof the player laid
 * was drawn from the same handful whether the campaign was in its first year
 * or its ninetieth, and none of them could be the tar-and-gravel that a mill
 * conversion still has on it.
 */
export function roofDeck(style: number, year: number, floors: number, z1: number, roll: number): number {
  const modernCls = has(T_MODERN, style) || style === S_PMOD;
  const bigPlate = floors >= 6 || z1 >= 24;
  const pool: number[] = [];
  if (year < 1930)      pool.push(1, 1, 1, 0, 0, 0, 0, 3, 3, 4, 4, 5);
  else if (year < 1960) pool.push(1, 1, 1, 0, 0, 0, 3, 3, 5, 5, 4, 8);
  else if (year < 1982) pool.push(1, 1, 0, 0, 0, 3, 3, 5, 5, 8, 8, 4);
  else if (year < 2003) pool.push(2, 2, 2, 2, 0, 3, 5, 5, 8, 8, 6, 6);
  else                  pool.push(7, 7, 7, 6, 6, 6, 8, 8, 2, 5, 4);
  if (modernCls && bigPlate && year >= 1982) pool.push(6, 6, 7, 7, 2, 2);
  if (style === S_MILL && year < 1975) pool.push(0, 0, 4, 1, 1);
  return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))];
}

/**
 * WHAT STANDS ON A FLAT ROOF, AND IN WHAT ORDER.
 *
 * Each of these is up there because the real one would be — a lift overrun
 * only where there is a lift, a cooling tower only where there is a chiller,
 * PV only after somebody was selling it — so the parts on a deck tell you what
 * KIND of building you are looking at and roughly when it was last touched.
 *
 * The ORDER is the other half of it, and it is what stops a small roof looking
 * like a plant room that exploded. The list is written most-necessary first:
 * the way out, then the lift, then the plant that makes the building work,
 * then the things somebody chose to add. `fitRoofKit` walks it in order and
 * stops when the deck is full, so a sixteen-metre plate gets a bulkhead and a
 * vent and the tower next door still gets everything.
 *
 * Shared, because it was two lists. `setPlayerBuildings` asked for four kinds
 * — bulkhead, overrun, cooling tower, PV — off four coin flips, and could not
 * reach the other sixteen: no mast on a supertall, no tank, no condensers, no
 * skylight, no terrace, no dish, no window-washing rig. Twenty years into a
 * campaign that is most of the roofs in frame, and roofs are 9.5% of it.
 */
export interface RoofKitIn {
  style: number;
  year: number;                        // the year it was finished
  hgt: number;                         // the BUILDING's height, not the roof's altitude
  fh: number;                          // floor to floor
  area: number;                        // signed plan area
  hasMechDeck: boolean;                // the crown already built a penthouse
  seed: number;                        // integer off the deed, for the jitter
  rnd: (k: number) => number;          // the deck's own hash stream
  jit: (k: number, amp: number) => number;
}

/**
 * THE PROP KIT — one geometry and one colour per prop kind, built once.
 *
 * This was a local inside `buildCity`, which meant only the generator could
 * put anything on a roof: `setPlayerBuildings` carried a four-entry map of its
 * own — bulkhead, overrun, cooling tower, PV — and the other thirty-eight
 * kinds were unreachable from the half of the city the player builds.
 *
 * Lazily built and memoised. `BufferGeometry` is CPU-side, so this costs
 * nothing until something asks, and the geometries are safe to share between
 * the generator's instanced meshes and the dynamic group's plain ones.
 */
let PROP_DEFS: { geom: THREE.BufferGeometry; color: number }[] | null = null;
export function propKit(): { geom: THREE.BufferGeometry; color: number }[] {
  return (PROP_DEFS ??= [
  { geom: waterTowerGeom(), color: 0x8a7a63 },
  { geom: new THREE.BoxGeometry(2.2, 1.6, 1.3).translate(0, 0, 0.65), color: 0x9aa0a4 },
  { geom: new THREE.BoxGeometry(4.6, 3.4, 2.9).translate(0, 0, 1.45), color: 0xb9b5a8 },
  { geom: new THREE.CylinderGeometry(4.2, 4.2, 0.25, 20).rotateX(Math.PI / 2).translate(0, 0, 0.12), color: 0x7d8489 },
  { geom: antennaGeom(), color: 0x6d7276 },
  { geom: new THREE.BoxGeometry(0.9, 0.9, 2.4).translate(0, 0, 1.2), color: 0x8a5c48 },
  { geom: new THREE.BoxGeometry(6.5, 1.8, 1.3).translate(0, 0, 0.65), color: 0xaab4b8 },
  { geom: billboardGeom(), color: 0xffffff },
  { geom: new THREE.BufferGeometry(), color: 0x000000 },  // 8: unused slot
  { geom: fireEscapeGeom(2), color: 0x4a4238 },
  { geom: fireEscapeGeom(3), color: 0x4a4238 },
  { geom: fireEscapeGeom(4), color: 0x4a4238 },
  { geom: fireEscapeGeom(5), color: 0x4a4238 },
  { geom: bulkheadGeom(), color: 0x9d9382 },        // 13
  { geom: overrunGeom(), color: 0x93897a },         // 14
  { geom: coolingTowerGeom(), color: 0xa8ada9 },    // 15
  { geom: pressureTankGeom(), color: 0x7f868a },    // 16
  { geom: generatorGeom(), color: 0x8b8f86 },       // 17
  { geom: skylightGeom(), color: 0xbfd0d6 },        // 18
  { geom: pvRowGeom(), color: 0x2b3550 },           // 19
  { geom: guardrailGeom(), color: 0x6f7377 },       // 20
  // The roofscape proper — see the block by the geometry above.
  { geom: chimneyPotsGeom(), color: 0x8c5f4c },     // 21 sooted brick
  { geom: smokestackGeom(), color: 0x7d5748 },      // 22 works chimney
  { geom: cupolaGeom(), color: 0xc9c3b4 },          // 23 painted timber
  { geom: spireGeom(), color: 0x6f7a72 },           // 24 lead-grey
  { geom: domeGeom(), color: 0x63a08a },            // 25 copper gone green
  { geom: clockTowerGeom(), color: 0xbdb5a3 },      // 26 stone with pale faces
  { geom: steepleGeom(), color: 0xd6d2c6 },         // 27 whitewashed timber
  { geom: pergolaGeom(), color: 0x8b7355 },         // 28 weathered cedar
  { geom: planterRowGeom(), color: 0x5f7a48 },      // 29 planting
  { geom: helipadGeom(), color: 0x6a6f72 },         // 30 painted deck
  { geom: greenhouseGeom(), color: 0xbcd2d6 },      // 31 glass
  { geom: ventTurbineGeom(), color: 0x9aa0a0 },     // 32 galvanised
  { geom: flagpoleGeom(), color: 0xcfcfc8 },        // 33 white pole
  { geom: antennaArrayGeom(), color: 0x86898c },    // 34 galvanised lattice
  { geom: dishFarmGeom(), color: 0xb3b6b3 },        // 35 grey dishes
  { geom: davitGeom(), color: 0x767b7e },           // 36 machine grey
  { geom: roofSignGeom(), color: 0xffffff },        // 37 painted — see SIGN_COLORS
  { geom: tankTowerGeom(), color: 0x8a8f8c },       // 38 steel tank
  { geom: urnGeom(), color: 0xa9a293 },             // 39 cast stone
  { geom: dormerGeom(), color: 0xcfc7b4 },          // 40 painted trim
  { geom: dormerRoundGeom(), color: 0xc9c1af },     // 41 painted trim
  ]);
}

export function roofKitWants(o: RoofKitIn): RoofWant[] {
  const hgt = o.hgt;
  const bear = o.rnd(41) * Math.PI * 2;
  const floors = Math.max(1, Math.round(hgt / Math.max(2.6, o.fh)));
  const wants: RoofWant[] = [];
  // A mast IS the silhouette of a tall tower, so it is exempt from the
  // budget — but it still has to stand inside the parapet like
  // everything else.
  if (hgt >= 95) wants.push({ kind: 4, s: 1 + (hgt - 95) / 60, rot: 0, keep: true });
  if (hgt >= 105 && o.year >= 1975) wants.push({ kind: 3, s: 1, rot: 0, keep: true });

  // Somebody has to be able to get out here. Every flat roof has a way
  // up, and it is the most characteristic silhouette on the deck —
  // unless the building already grew a penthouse, because that IS the
  // stair and the lift, and a bulkhead standing beside it on its own
  // roof is the same object drawn twice.
  if (hgt >= 9 && !o.hasMechDeck) wants.push({ kind: 13, s: 0.9 + 0.3 * o.rnd(3), rot: bear });
  // A lift overrun exists where there is a lift, which is six floors
  // and up before the war and four floors and up after it.
  if (floors >= (o.year >= 1955 ? 4 : 6) && hgt >= 16 && !o.hasMechDeck) wants.push({ kind: 14, s: 0.9 + 0.25 * o.rnd(5), rot: bear + 0.4 });
  // A shed is lit through its roof rather than its walls, so a monitor
  // is the one thing on it that matters. It used to be dropped on top
  // of whatever the machine deck had already put there, at a six-metre
  // jitter off the centroid that hung nearly a fifth of them over the
  // gutter; taking it through the kit costs it a place in the budget
  // and makes it stand inside the parapet like everything else.
  if (o.style === S_MILL && hgt < 15) wants.push({ kind: 6, s: 0.85 + 0.3 * o.rnd(25), rot: bear });
  if (hgt >= 20) wants.push({ kind: 2, s: 1 + (hgt > 60 ? 0.6 : 0), rot: o.jit(3, 3) });
  // The timber tank on a pre-war roof, and the steel one that replaced
  // it after the war — the two never share a roof.
  if (o.year < 1968 && hgt >= 22) wants.push({ kind: 0, s: 1, rot: 0 });
  // Chilled water needs somewhere to reject the heat. Post-war, and
  // only on a building big enough to have a central plant.
  if (o.year >= 1948 && hgt >= 34 && o.rnd(7) < 0.72) wants.push({ kind: 15, s: 0.85 + 0.55 * o.rnd(9), rot: bear + 1.1 });
  if (o.year >= 1962 && hgt >= 26 && o.rnd(11) < 0.45) wants.push({ kind: 16, s: 0.85 + 0.3 * o.rnd(13), rot: 0 });
  // Standby power: hospitals, exchanges, anything with a computer
  // room in it, so tall and late.
  if (o.year >= 1972 && hgt >= 48 && o.rnd(15) < 0.5) wants.push({ kind: 17, s: 1, rot: bear + 2.3 });
  // Daylight into the top floor: a loft conversion or a studio.
  if (hgt >= 12 && hgt <= 34 && o.rnd(17) < 0.30) wants.push({ kind: 18, s: 0.8 + 0.5 * o.rnd(19), rot: bear + 1.57 });
  // Nobody put panels on a roof before somebody was selling them.
  if (o.year >= 1996 && hgt >= 10 && o.rnd(21) < 0.34) wants.push({ kind: 19, s: 0.9 + 0.4 * o.rnd(23), rot: bear });
  // ---- THE REST OF THE ROOFSCAPE -------------------------------------
  const plateM = Math.sqrt(Math.max(1, Math.abs(o.area) / 2));
  //
  // Not landmarks, so these queue for deck space with the plant. Each
  // still follows from what the building is: a chimney pot means
  // fireplaces, a whirlybird means a shed with no other ventilation, a
  // window-washing rig means a facade nobody can reach from a ladder.
  // Chimney pots — a house with fireplaces in it, so old and low.
  if (o.year < 1945 && hgt <= 24 && has(T_OLDROOF, o.style)) {
    wants.push({ kind: 21, s: 0.85 + 0.4 * o.rnd(67), rot: bear });
    if (plateM > 15 && o.rnd(68) < 0.5) wants.push({ kind: 21, s: 0.8 + 0.3 * o.rnd(69), rot: bear + 1.2 });
  }
  // A shed ventilates through its roof because it has no other way to.
  if ((o.style === S_METALPAN || o.style === S_MILL) && hgt < 18 && o.rnd(70) < 0.45) {
    wants.push({ kind: 32, s: 0.9 + 0.3 * o.rnd(71), rot: bear });
  }
  // A mast on a roof somebody rents to a carrier — post-war and up.
  if (o.year >= 1958 && hgt >= 28 && o.rnd(72) < 0.30) wants.push({ kind: 34, s: 0.8 + 0.5 * o.rnd(73), rot: bear });
  // Satellite dishes arrived with cable and never left.
  if (o.year >= 1980 && hgt >= 19 && o.rnd(74) < 0.26) wants.push({ kind: 35, s: 0.85 + 0.35 * o.rnd(75), rot: bear + 0.9 });
  // A facade too tall to reach off a ladder needs a rig on the roof.
  if (o.year >= 1968 && hgt >= 38 && o.rnd(76) < 0.55) wants.push({ kind: 36, s: 1, rot: bear + 1.57 });
  // A helipad wants a big deck and a client who wanted one.
  if (o.year >= 1965 && hgt >= 55 && plateM > 24 && o.rnd(77) < 0.28) wants.push({ kind: 30, s: 1, rot: bear });
  // The roof terrace: a deck, something to sit under, and planting.
  if (o.year >= 1988 && hgt >= 12 && o.rnd(78) < 0.30) {
    wants.push({ kind: 28, s: 0.9 + 0.3 * o.rnd(79), rot: bear + 0.6 });
    wants.push({ kind: 29, s: 0.9 + 0.3 * o.rnd(80), rot: bear + 0.6 });
  } else if (o.year >= 1996 && hgt >= 9 && o.rnd(81) < 0.22) {
    wants.push({ kind: 29, s: 0.85 + 0.3 * o.rnd(82), rot: bear });
  }
  // Growing food up here is a recent idea and it looks like one.
  if (o.year >= 2006 && hgt >= 9 && hgt <= 46 && o.rnd(83) < 0.14) {
    wants.push({ kind: 31, s: 0.85 + 0.35 * o.rnd(84), rot: bear + 1.57 });
  }
  // A flagpole: civic buildings always, and anybody else who felt like it.
  if ((o.style === S_CIVIC || o.style === S_BEAUX) && hgt >= 10 && o.rnd(85) < 0.55) {
    wants.push({ kind: 33, s: 0.9 + 0.35 * o.rnd(86), rot: 0 });
  } else if (hgt >= 16 && o.rnd(87) < 0.08) {
    wants.push({ kind: 33, s: 0.85 + 0.3 * o.rnd(88), rot: 0 });
  }
  // Condensers are the filler — they go on last, and only where a big
  // deck has room left over after the plant that matters.
  const nAc = hgt > 40 ? 3 : 1;
  for (let k = 0; k < nAc; k++) wants.push({ kind: 1, s: 0.8 + 0.4 * ((o.seed >> k) % 2), rot: o.jit(12 + k, 3) });
  return wants;
}

export function crownTop(m: Mason, W: GeomBuf, R: GeomBuf, o: CrownIn): CrownOut {
  const { ring, z1, style, rnd, varr, fh, area } = o;
  let mechDeck: CrownOut["mechDeck"] = null;
  let roofZ = z1;
  // ------------------------------------------------- THE FIFTH FACADE
  //
  // FOUR CROWNS FOR A WHOLE CITY.
  //
  // A flat-roofed building could end in exactly four ways: a stone
  // cornice if it was prewar or deco, a plain parapet otherwise, plus an
  // optional green roof and — on deco towers over 45 m only — a three
  // step cap. Everything else in the city stopped at the same rim, at
  // the same 0.35 m projection, at the same height.
  //
  // That is why the skyline reads as one building. Project the game's
  // own camera at pitch 55 over the measured stock: for the median LOW
  // building — 279 m2 plate, three floors, 11 m, which is 92% of this
  // city — the roof is 160 m2 of projected area against 219 m2 of wall.
  // FORTY-TWO PER CENT OF THAT BUILDING'S PIXELS ARE ITS ROOF. For a
  // tower the flat deck is only 12%, but the top three floors of wall
  // are another 191 m2, so the CROWN ZONE IS 29% OF A TOWER'S PIXELS —
  // and it is the 29% that sits against the sky, where silhouette reads.
  //
  // "They all look similar" is a complaint about crowns, not facades.
  //
  // Twelve families now, offered by era, style and height, each built
  // out of the primitives already here. Independent hash streams, so a
  // building's crown does not move when its wall colour does.
  const cs = o.cs;
  const tall = z1 >= 26 && !!o.roof;
  const deco = style === S_ARTDECO;
  const modern = has(T_MODERN, style);
  const stone = has(T_STONE, style);
  // WHAT THIS BUILDING'S TOP COULD PLAUSIBLY BE. Repeats are weights.
  const crowns: string[] = [];
  if (o.industrial) {
    // A WAREHOUSE DOES NOT GET A CORNICE, whatever its wall is made of. Brick
    // is T_STONE here, so without this branch a four-storey shed drew from the
    // prewar masonry ladder and ended in a stone cornice — a civic gesture on
    // a loading dock. Coping, a corbelled brick band, a shed slope or a plant
    // enclosure are the four things the top of one of these actually is.
    crowns.push("coping", "coping", "corbel", "slope", "mech");
  } else if (z1 >= 12) {
    if (stone) crowns.push("cornice", "cornice", "corbel", "decapitated");
    if (stone && tall) crowns.push("temple", "pyramid", "lantern");
    if (deco && tall) crowns.push("ziggurat", "ziggurat", "fin", "fin");
    if (modern) crowns.push("mech", "mech", "slope");
    if (modern && tall) crowns.push("amenity", "mech");
    if (!stone && !modern) crowns.push("coping", "corbel");
  }
  crowns.push("coping");                       // a plain parapet is a real answer
  const crown = crowns[Math.min(crowns.length - 1, Math.floor(cs(1) * crowns.length))];

  // The material a crown is made of is rarely the material of the wall
  // under it — that is most of what makes a top read as a top.
  const CROWN_MAT = [S_CORNICE, S_CORNICE, S_PLAIN, S_GABLE, S_BRICK, S_MILL];
  const cmat = deco || stone
    ? (cs(2) > 0.72 ? S_GABLE : S_CORNICE)     // copper and slate among the stone
    : CROWN_MAT[Math.floor(cs(2) * CROWN_MAT.length)];
  // Beta-ish: most crowns are shallow, a few are enormous.
  const ch = Math.max(1.2, Math.min(14, z1 * (0.028 + 0.087 * cs(3) * cs(4))));
  const M = (z: number, st = cmat) => [st, rnd, varr, z, fh];

  if (crown === "cornice") {
    // A PROJECTING CORNICE, in one to three courses. The projection was
    // hard-coded at 0.35 m on every cornice in the game; a real one runs
    // to two metres and throws a shadow you can see from the street.
    const courses = 1 + Math.floor(cs(5) * 3);
    let z = z1 - 0.55, proj = 0.35 + 1.75 * cs(6);
    for (let k = 0; k < courses; k++) {
      const lip = insetRing(ring, -proj);
      if (!lip) break;
      const zt = z + 0.5 + 0.35 * cs(7 + k);
      m.wall(W, lip, z, zt, M(zt));
      m.cap(R, lip, zt, M(zt));
      z = zt; proj *= 0.55;
    }
    // BALUSTRADE URNS. On the good addresses the cornice carries cast
    // stone at intervals along it, and it is the one ornament that
    // breaks a parapet line against the sky — which is exactly where a
    // roof is read from. These are placed ON the parapet rather than
    // through fitRoofKit, because the kit's whole job is to keep things
    // a metre INSIDE the edge and the edge is where an urn belongs.
    if (stone && o.roof && cs(16) < 0.30) {
      for (let i = 0; i < ring.length; i++) {
        const a2 = ring[i], b2 = ring[(i + 1) % ring.length];
        const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
        if (L < 4) continue;
        const n2 = Math.min(6, Math.max(1, Math.floor(L / 7.5)));
        for (let k2 = 0; k2 < n2; k2++) {
          const t = (k2 + 0.5) / n2;
          o.props.push({
            kind: 39, b: o.bbl, rot: 0,
            x: a2[0] + (b2[0] - a2[0]) * t, y: a2[1] + (b2[1] - a2[1]) * t, z,
            s: 0.8 + 0.4 * cs(17 + k2),
          });
        }
      }
    }
  } else if (crown === "corbel") {
    // CORBELLED BRICK — courses stepping OUT as they rise, under a
    // coping. The commonest top in any nineteenth-century city and the
    // game had no way to draw it.
    let z = z1 - 0.3;
    for (let k = 0; k < 3; k++) {
      const lip = insetRing(ring, -(0.12 + k * 0.14));
      if (!lip) break;
      const zt = z + 0.42;
      m.wall(W, lip, z, zt, [style, rnd, varr, zt, fh]);
      z = zt;
    }
    const cap = insetRing(ring, -(0.54 + 0.3 * cs(8)));
    if (cap) { m.wall(W, cap, z, z + 0.3, M(z + 0.3)); m.cap(R, cap, z + 0.3, M(z + 0.3)); }
  } else if (crown === "decapitated") {
    // THE CORNICE CAME OFF. Half the prewar stock in every American city
    // lost its cornice to a leak, a fire code or a bill, and what is
    // left is a raw parapet with a crude concrete cap and a scar of
    // clean brick where the brackets were.
    const ph = 0.9 + 0.7 * cs(9);
    m.wall(W, ring, z1 - 0.1, z1 + ph, [style, rnd, varr, z1, fh]);
    const cap = insetRing(ring, -0.10);
    if (cap) { m.wall(W, cap, z1 + ph, z1 + ph + 0.22, M(z1 + ph + 0.22, S_PLAIN)); m.cap(R, cap, z1 + ph + 0.22, M(z1 + ph + 0.22, S_PLAIN)); }
    const inner = insetRing(ring, 0.28);
    if (inner) m.cap(R, inner, z1 + ph, M(z1 + ph, S_PLAIN));
  } else if (crown === "ziggurat") {
    // Two to four stepped setbacks with usable terraces. This existed
    // for deco towers over 45 m at a fixed three steps of fixed height;
    // now the count, the depth and the taper all move.
    const n = 2 + Math.floor(cs(10) * 3);
    let step0 = ring, zc = z1 + 0.2, depth = 0.9 + 3.6 * cs(11);
    for (let k = 0; k < n; k++) {
      const inset = insetRing(step0, depth);
      if (!inset) break;
      const hStep = Math.max(1.4, ch * (0.55 - k * 0.09));
      m.wall(W, inset, zc, zc + hStep, [style, rnd, varr, zc + hStep, fh]);
      m.cap(R, inset, zc + hStep, M(zc + hStep));
      step0 = inset; zc += hStep; depth *= 0.75;
    }
  } else if (crown === "fin") {
    // VERTICAL PIERS OVERRUN THE ROOFLINE. The deco move: the shaft's
    // own mullions keep going past the last floor and the wall between
    // them stops, so the building ends in teeth rather than a line.
    const back = insetRing(ring, 0.55);
    if (back) { m.wall(W, back, z1, z1 + ch * 0.55, [style, rnd, varr, z1 + ch, fh]); m.cap(R, back, z1 + ch * 0.55, M(z1 + ch * 0.55)); }
    const nF = ring.length;
    for (let i = 0; i < nF; i++) {
      const a2 = ring[i], b2 = ring[(i + 1) % nF];
      const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
      const steps = Math.max(1, Math.floor(L / 4.2));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const px = a2[0] + (b2[0] - a2[0]) * t, py = a2[1] + (b2[1] - a2[1]) * t;
        const w = 0.62;
        const pier: [number, number][] = [[px - w, py - w], [px + w, py - w], [px + w, py + w], [px - w, py + w]];
        const hP = ch * (0.7 + 0.5 * o.pier(i * 31 + k));
        m.wall(W, pier, z1 - 1.0, z1 + hP, M(z1 + hP));
        m.cap(R, pier, z1 + hP, M(z1 + hP));
      }
    }
  } else if (crown === "temple") {
    // A COLONNADED BELVEDERE — the open loggia on top of a 1920s bank.
    const base = insetRing(ring, 1.1 + 1.6 * cs(12));
    if (base) {
      m.wall(W, base, z1, z1 + 0.5, M(z1 + 0.5));
      const colH = Math.max(2.6, ch * 1.1);
      const nT = base.length;
      for (let i = 0; i < nT; i++) {
        const a2 = base[i], b2 = base[(i + 1) % nT];
        const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
        const steps = Math.max(1, Math.floor(L / 3.4));
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          const px = a2[0] + (b2[0] - a2[0]) * t, py = a2[1] + (b2[1] - a2[1]) * t, w = 0.44;
          const col: [number, number][] = [[px - w, py - w], [px + w, py - w], [px + w, py + w], [px - w, py + w]];
          m.wall(W, col, z1 + 0.5, z1 + 0.5 + colH, M(z1 + 0.5 + colH));
        }
      }
      const roofR = insetRing(base, -0.45) ?? base;
      m.wall(W, roofR, z1 + 0.5 + colH, z1 + 0.5 + colH + 0.55, M(z1 + colH + 1.05));
      m.cap(R, roofR, z1 + 0.5 + colH + 0.55, M(z1 + colH + 1.05));
    }
  } else if (crown === "pyramid") {
    const cap = insetRing(ring, 0.35);
    const span = Math.sqrt(Math.abs(area) / 2);
    if (cap) m.pitch(R, cap, z1, Math.max(2.4, Math.min(13, ch * 1.5)), Math.max(0.8, span * 0.42), [S_GABLE, rnd, (varr * 3.71 + rnd * 1.93) % 1, z1 + ch, fh]);
  } else if (crown === "lantern") {
    // A TIERED TOWER: two shrinking stages and a cupola. What a spire
    // actually is, close up.
    let r0 = ring, z = z1;
    for (let k = 0; k < 3; k++) {
      const inset = insetRing(r0, k === 0 ? 1.6 + 1.4 * cs(13) : 0.9);
      if (!inset) break;
      const hS = Math.max(1.6, ch * (0.9 - k * 0.22));
      m.wall(W, inset, z, z + hS, M(z + hS));
      m.cap(R, inset, z + hS, M(z + hS));
      r0 = inset; z += hS;
    }
  } else if (crown === "mech") {
    // A LOUVRED MECHANICAL SCREEN wrapping the plate — what the top of
    // every postwar tower in the world actually is.
    const ph = Math.max(2.2, ch * 0.9);
    m.wall(W, ring, z1 - 0.1, z1 + ph, M(z1 + ph, S_MILL));
    const inner = insetRing(ring, 0.3);
    if (inner) m.cap(R, inner, z1 + ph, M(z1 + ph, S_PLAIN));
  } else if (crown === "slope") {
    // A CHAMFERED TOP. The last floor pulls in on every side and the
    // building ends on a slope instead of a plane.
    const cap = insetRing(ring, Math.max(0.9, Math.min(4.5, ch * 0.8)));
    if (cap) {
      m.wall(W, ring, z1 - 0.1, z1 + 0.2, [style, rnd, varr, z1, fh]);
      m.cap(R, cap, z1 + ch * 0.8, M(z1 + ch, style));
      m.wall(W, cap, z1 + 0.2, z1 + ch * 0.8, M(z1 + ch, style));
    }
  } else if (crown === "amenity") {
    // A GLASS PENTHOUSE SET BACK BEHIND A TERRACE.
    const deck = insetRing(ring, 0.8);
    const box = insetRing(ring, 3.2 + 2.4 * cs(14));
    if (deck) m.cap(R, deck, z1 + 0.1, M(z1, S_GREEN));
    if (box) {
      const hB = Math.max(3.0, ch * 1.1);
      m.wall(W, box, z1 + 0.1, z1 + hB, [S_GLASS, rnd, varr, z1 + hB, fh]);
      m.cap(R, box, z1 + hB, M(z1 + hB, S_PLAIN));
    }
    m.wall(W, ring, z1 - 0.1, z1 + 1.05, M(z1, S_CORNICE));
  } else {
    // FLAT COPING — a parapet with a cap on it, and the cap is not the
    // same stuff as the wall.
    const ph = 0.75 + 0.9 * cs(15) + (z1 > 45 ? 0.5 : 0);
    m.wall(W, ring, z1 - 0.1, z1 + ph, [style, rnd, varr, z1, fh]);
    const cop = insetRing(ring, -0.09);
    if (cop) { m.wall(W, cop, z1 + ph, z1 + ph + 0.18, M(z1 + ph + 0.18)); m.cap(R, cop, z1 + ph + 0.18, M(z1 + ph + 0.18)); }
    const inner = insetRing(ring, 0.28);
    if (inner) m.cap(R, inner, z1 + ph, [modernCap(style), rnd, varr, z1 + ph, fh]);
  }
  // some modern mid-rises grow a green roof
  if (style === S_GLASS && crown !== "amenity" && z1 >= 15 && z1 <= 60 && varr > 0.62) {
    const g = insetRing(ring, 1.6);
    if (g) m.cap(R, g, z1 + 0.08, [S_GREEN, rnd, varr, z1, fh]);
  }
  // bulkheads: the stair and lift overrun every tall building carries.
  // o.roof gates it to the roof: dropped on the base tier of a wedding cake
  // it is a box drawn inside the tower standing on that tier.
  if (z1 >= 26 && !o.deco && o.roof) {
    const pent = insetRing(ring, Math.min(6, Math.max(2.2, Math.sqrt(z1) * 0.55)));
    if (pent) {
      const ph2 = z1 > 70 ? 5.2 : 3.6;
      const pm = [has(T_MODERN, style) || has(T_CAPPED_PLAIN, style) ? S_PLAIN : style, rnd, varr, z1 + ph2, fh];
      m.wall(W, pent, z1 + 0.4, z1 + ph2, pm);
      m.cap(R, pent, z1 + ph2, [pm[0], rnd, varr, z1 + ph2, fh]);
      mechDeck = { ring: pent, z: z1 + ph2 };
      roofZ = z1 + ph2;
    }
  }
  return { mechDeck, roofZ };
}


// What each decorative kind is painted. The harbor used to be a fleet of
// uniform grey boxes; a hull is navy or rust, a wheelhouse is white, a crane
// is safety-ochre, containers come in shipping-line colors, the lighthouse
// is whitewashed. Small flat colors, same light rig as everything else.
const DECO_TINT: Record<string, [number, number, number]> = {
  hull0: [0.20, 0.24, 0.33], hull1: [0.48, 0.22, 0.17], hull2: [0.16, 0.17, 0.19],
  super: [1.12, 1.10, 1.05], funnel: [0.55, 0.20, 0.16],
  box0: [0.75, 0.38, 0.16], box1: [0.24, 0.38, 0.58], box2: [0.30, 0.52, 0.34],
  crane: [0.95, 0.72, 0.25], shed: [0.86, 0.83, 0.74],
  light: [1.14, 1.12, 1.06], lightcap: [0.55, 0.20, 0.16],
  boat: [1.06, 1.03, 0.96], mast: [0.90, 0.90, 0.88],
  // the bandstand's posts are one octagonal ring, not eight separate columns,
  // so painting them white made a drum. Dark, they read as the shadow you
  // actually see under a bandstand roof from any distance worth drawing at.
  banddeck: [0.92, 0.88, 0.78], bandroof: [0.40, 0.52, 0.43], bandpost: [0.30, 0.28, 0.26],
  // whitewashed clapboard and slate — the meeting house and the town hall
  civic: [1.16, 1.15, 1.10], civicroof: [0.44, 0.46, 0.50],
  // raw concrete and the galvanised headhouse on top of it — grain elevators
  // are the one industrial building taller than the district around them, and
  // they are not painted, they are poured
  silo: [0.80, 0.79, 0.75], siloroof: [0.52, 0.54, 0.55],
};

// facade / surface styles

const VERT = /* glsl */ `
attribute float aU;
attribute float aStyle;
attribute float aRand;
attribute float aVar;
attribute float aTop;
attribute float aFh;
attribute float aEra;
attribute vec2 aSeg;   // wall segment span in perimeter units (u0, u1)
attribute vec2 aCcv;   // corner sign at each end: +1 convex, -1 concave
attribute vec3 aTint;
attribute float aLit;
attribute float aRet;
varying vec3 vNormal;
varying vec3 vTint;
varying vec3 vPos;
varying vec2 vSeg, vCcv;
varying float vU, vZ, vStyle, vRand, vVar, vTop, vFh, vEra;
varying float vLit;
varying float vRet;
void main() {
  vNormal = normal;
  vTint = aTint;
  vPos = position;
  vSeg = aSeg; vCcv = aCcv;
  vLit = aLit;
  vRet = aRet;
  vU = aU; vZ = position.z; vStyle = aStyle; vRand = aRand; vVar = aVar; vTop = aTop; vFh = aFh; vEra = aEra;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The light rig. One sun, a sky dome, and a warm bounce off the pavement —
// which is what actually makes massing read: cool light from above, warm
// light from below, and a real shadow between them. Everything lands in a
// filmic curve so highlights roll off instead of clipping to paper white.
const LIGHT_GLSL = /* glsl */ `
// THE SUN SITS LOW. It used to stand at forty-eight degrees — near noon, the
// one hour no architectural photographer would ever shoot in. Twenty-eight
// degrees is late afternoon: shadows run nearly twice the height of what casts
// them, every west face lights up, every east face falls into shade, and the
// massing of the city finally has something to read against. The sun is warmer
// to match, and the sky fill is lifted so the long shadows stay blue and
// legible instead of going black.
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec2 uWeather; // rain, overcast
#define RAIN uWeather.x
#define OVERCAST uWeather.y
#define SUN_DIR uSunDir
#define SUN_COL (uSunCol * mix(1.0, 0.46, OVERCAST))
// THE FILL WAS DOING THE SUN'S JOB. A sky term this bright lands about
// two-thirds of full illumination on a surface the sun cannot see at all,
// which is why a city lit at 28 degrees — an angle chosen precisely so the
// massing would have something to read against — was throwing shadows you had
// to look for. Open shade outdoors is genuinely a couple of stops under
// sunlight, not a quarter of one. Pulling the dome down and pushing the sun up
// keeps the same exposure on the lit planes and buys back the contrast between
// a wall in the light and a wall in the shade.
const vec3 SKY_COL = vec3(0.408, 0.502, 0.688);
const vec3 GND_COL = vec3(0.372, 0.318, 0.248);

vec3 hemiLight(vec3 n, float ao) {
  // THE GROUND HALF OF THIS IS A BOUNCE, AND IT WAS NOT LIT.
  //
  // GND_COL is a flat brown that has no idea whether the sun is out. But the
  // downward half of an ambient term is not a light source in its own right —
  // it is sunlight that has already hit the pavement and come back up, so it
  // should carry the sun's own colour and its own strength. That is the light
  // filling the underside of every cornice, every awning, every balcony, and
  // the whole shaded lower half of a street canyon on a bright day.
  //
  // Warm, because it has bounced off warm stone, and stronger than the flat
  // constant it replaces: pavement is a far better reflector than a brown
  // constant implies, and getting it wrong is why undersides here have been
  // reading as holes.
  //
  // This is the pavement's share of the indirect light. The buildings' share
  // is done in screen space in the composite, off the blurred scene, because
  // no analytic term can know that the wall opposite happens to be red.
  // HUE, NOT AMPLITUDE. Multiplying straight by SUN_COL — which runs well
  // above 1 so that lit faces expose correctly — made this term 1.6x brighter
  // as a side effect, and since a vertical wall takes half its ambient from
  // the ground half, every facade in the city lifted and the contrast bought
  // by the light rig went straight back out. Normalising by the sun's own
  // luminance keeps the strength exactly where it was and changes only the
  // colour, which was the whole point.
  vec3 sunTint = SUN_COL / max(dot(SUN_COL, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  vec3 bounce = GND_COL * mix(vec3(1.0), sunTint, 0.85);
  vec3 sky = mix(SKY_COL, vec3(0.430, 0.466, 0.500), OVERCAST * 0.72);
  vec3 amb = mix(bounce, sky, clamp(n.z * 0.5 + 0.5, 0.0, 1.0));
  return amb * ao * mix(1.0, 0.84, OVERCAST);
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// filmic roll-off plus a gentle split-tone: cool in the shadows, warm in the
// light. Keeps the pale architectural-model palette but stops it going chalky.
vec3 grade(vec3 c) {
  c = max(c, vec3(0.0));

  // CONTRAST BEFORE THE CURVE, NOT AFTER.
  //
  // The palette here is pale on purpose, and it was arriving inside about a
  // third of a stop — sunlit stone, roadway, roof and open sea all within one
  // value of each other. Geometry cannot rescue that; a model photographed in
  // flat light reads as a model. But an S-curve applied to the OUTPUT of ACES
  // pushes the top of the range straight into the clamp, and because the clamp
  // is per-channel it takes the hue with it: a snow roof in January went to
  // flat paper white with no blue left in it, and the shoulder that ACES exists
  // to provide never got a chance to run.
  //
  // Doing it in linear, about middle grey, is the same contrast with none of
  // that. Values under 0.18 fall, values over it rise, and then the filmic
  // curve rolls the highlights off smoothly and keeps them coloured.
  c = 0.18 * pow(c / 0.18 + 1e-5, vec3(1.24));

  vec3 t = aces(c * 1.10);
  t = clamp(t, 0.0, 1.0);

  float lum = dot(t, vec3(0.2126, 0.7152, 0.0722));
  t = mix(vec3(lum), t, 1.40);                 // ACES eats chroma; put it back
  t = clamp(t, 0.0, 1.0);
  lum = dot(t, vec3(0.2126, 0.7152, 0.0722));
  t *= mix(vec3(0.910, 0.958, 1.108), vec3(1.078, 1.010, 0.904), smoothstep(0.14, 0.86, lum));
  return clamp(t, 0.0, 1.0);
}`;

const SEASON_GLSL = /* glsl */ `
uniform vec4 uSeason;
#define SNOW   uSeason.x
#define AUTUMN uSeason.y
#define BARE   uSeason.z
#define VIGOUR uSeason.w

vec3 seasonGreen(vec3 c) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 gold = l * vec3(1.62, 1.16, 0.42);
  vec3 dorm = l * vec3(1.32, 1.20, 0.86);
  c = mix(c, gold, AUTUMN * 0.72);
  c = mix(c, dorm, (1.0 - VIGOUR) * 0.42);
  return c;
}

// TURF DOES NOT TURN.
//
// A deciduous canopy goes gold in October because its leaves are dying and
// about to be abandoned. A lawn is a perennial: it stops growing, goes dull,
// grey and a little brown as it hardens off, and it stays GREEN through the
// whole of it. Both were running through seasonGreen, so every park in the
// city came out the colour of a wheatfield in autumn — which was, by some
// distance, the loudest wrong colour anywhere in the calendar.
//
// Same two drivers, quite different destination: toward a desaturated olive
// rather than toward gold, and never all the way there.
vec3 seasonTurf(vec3 c) {
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 dorm = mix(c, l * vec3(1.16, 1.10, 0.84), 0.60);
  return mix(c, dorm, clamp(max(AUTUMN * 0.50, (1.0 - VIGOUR) * 0.62), 0.0, 1.0));
}

vec3 snowOn(vec3 c, float up, float k) {
  return mix(c, vec3(0.905, 0.925, 0.975), clamp(SNOW * up * k, 0.0, 1.0));
}

// SNOW IS NOT A SHEET OF MATTE WHITE PAINT.
//
// It is a field of ice crystals lying at every angle, and the small fraction
// of them oriented to bounce the sun straight back at the eye is why fresh
// snow in low light GLITTERS rather than glowing. That single behaviour is
// most of what distinguishes snow from any other white surface, and this city
// spends five months a year under it — through a flat lerp to one colour, so
// half the calendar has been rendering the most optically interesting material
// in the scene as paper.
//
// Cheap version: dice world space into crystal-sized cells, give each cell a
// facet tilted a little off the true surface, and run a very tight specular
// against it. Cells that happen to line up with the half-vector fire; the rest
// stay dark. No texture, one hash pair, and because the cells are anchored in
// WORLD space the glitter belongs to the roof rather than sliding across it as
// the camera moves.
vec3 snowSparkle(vec3 p, vec3 n, vec3 V, float cover) {
  if (cover < 0.02) return vec3(0.0);
  vec3 cell = floor(p * 3.0);
  float h1 = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float h2 = fract(sin(dot(cell, vec3(93.9898, 27.345, 61.121))) * 24634.6345);
  vec3 facet = normalize(n + vec3(h1 - 0.5, h2 - 0.5, 0.22) * 0.62);
  vec3 H = normalize(SUN_DIR + V);
  float spec = pow(max(dot(facet, H), 0.0), 240.0);
  return SUN_COL * spec * cover * 2.4;
}
`;

// AERIAL PERSPECTIVE. Air is not transparent. Over a mile of it, contrast
// drains out of everything and the color creeps toward the sky — which is the
// single strongest depth cue human vision has, and the one thing separating a
// city from a diorama. Every fragment shader below ends with it. The falloff
// is scaled by how high the camera sits, so the effect reads the same whether
// you are looking down a street or across the whole harbor.
const HAZE_GLSL = /* glsl */ `
// AIR IS NOT ONE COLOUR, AND IT IS NOT EVENLY DISTRIBUTED.
//
// A single grey constant is haze; these two together are weather. Looking
// along the sun's bearing you are looking INTO forward-scattered light and the
// air goes warm, bright and low-contrast — the effect that makes the far end
// of a sunlit street glow. Looking away from it you are seeing the sky's own
// blue scattered back at you, which is cooler and darker. Every aerial
// photograph of a city has both in the same frame, and a renderer that picks
// one loses the single strongest cue that the city is sitting in atmosphere
// rather than in front of a backdrop.
const vec3 HAZE_COOL = vec3(0.742, 0.818, 0.900);   // the sky, scattered back
const vec3 HAZE_WARM = vec3(0.952, 0.906, 0.826);   // the sun, scattered forward
const vec3 HAZE_COL  = vec3(0.790, 0.845, 0.902);   // the average, for anything that wants one

vec3 aerial(vec3 c, vec3 p, vec3 cam) {
  vec3 d3 = p - cam;
  float d = length(d3);
  float k = max(cam.z, 140.0);
  // WEAKER, AND FURTHER OUT. At 0.47 the haze was doing the job of depth cue
  // and the job of a grey wash at the same time: by mid-frame it had eaten
  // half the contrast of every surface, so the far half of the city arrived
  // pre-flattened and no amount of grading downstream could get it back.
  // Depth reads better from a curve that stays clear up close and then falls
  // away hard, which is also what air actually does.
  float f = 1.0 - exp(-(d / k) * 0.056);

  // Which way am I looking, relative to where the sun is? Taken on the compass
  // only: the elevation of the sun is the same everywhere in frame, so letting
  // it into this term would just add a constant tilt top-to-bottom.
  vec2 vdir = d3.xy;
  vec2 sdir = SUN_DIR.xy;
  float toSun = 0.5;
  if (dot(vdir, vdir) > 1e-6 && dot(sdir, sdir) > 1e-6) {
    toSun = clamp(dot(normalize(vdir), normalize(sdir)) * 0.5 + 0.5, 0.0, 1.0);
  }
  vec3 haze = mix(HAZE_COOL, HAZE_WARM, pow(toSun, 2.4));
  haze = mix(haze, vec3(0.680, 0.710, 0.730), OVERCAST * 0.58);

  // AND IT POOLS IN THE STREETS. Haze is densest where the air is thickest and
  // dirtiest, which is at the bottom — so a distant street floor washes out
  // while the towers standing in the same air keep their edges, and the city
  // reads as rising out of something. A 46 m scale height puts the effect
  // across the low fabric and leaves anything tall standing clear of it.
  float lowFog = exp(-max(p.z, 0.0) / 46.0);
  f = clamp(f * (1.0 + 0.44 * lowFog), 0.0, 1.0);

  // AND THE AIR HAS A SEASON. Cold air holds almost no water and a great deal
  // less dust, which is why a clear February day sees for ever and August
  // haze closes the same view down to a mile — it is one of the largest
  // visible differences between two months of the year, and this term was a
  // constant. Winter also has the longest shadows and the lowest sun, so the
  // clarity and the drama arrive together, which is exactly what a northern
  // city looks like in January.
  float clarity = mix(1.06, 0.72, SNOW);
  // Summer's own contribution, taken off leaf vigour rather than a second
  // date: humid air and full canopies are the same weather.
  clarity *= mix(1.0, 1.16, VIGOUR);

  // AND AN ALTITUDE FLOOR. Dividing distance by camera height keeps the effect
  // reading the same down a street and across the harbour, which is what it is
  // for — but it also cancels itself at altitude, so the establishing shot,
  // three kilometres up over the whole island, was getting almost no
  // atmosphere at all. Real aerial photography from that height has a lot.
  float alt = smoothstep(1100.0, 4200.0, cam.z) * 0.20 * (1.0 - exp(-d / 1200.0));

  return mix(c, haze, clamp(f * (0.25 + OVERCAST * 0.13) * clarity + alt, 0.0, 1.0));
}`;

/**
 * A 32-bit key from a BBL, in EXACT integer arithmetic.
 *
 * The obvious `Number(bbl) * 2654435761` is 2.7e18 for a ten-digit BBL, which
 * is three hundred times past the 2^53 where doubles stop counting by ones —
 * so the bottom nine bits of the product are always zero and anything mixed in
 * below that granularity is silently discarded before the hash ever sees it.
 * It happens to survive here because every term is large, which is a bad
 * reason for a hash to work. FNV over the digits costs ten iterations and is
 * correct for any BBL anyone ever invents.
 */

/**
 * A well-mixed [0,1) from two integers. Two calls with different constants give
 * two INDEPENDENT streams, which is the whole point — the old scheme derived
 * its second scalar from its first, so colour and detail moved together.
 */

/** Twice the signed area of a ring — enough to compare two footprints. */
function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a);
}

const PROP_VERT = /* glsl */ `
// instanceColor is declared for us when the mesh carries one
uniform vec4 uSeason;
uniform float uFoliage;   // 0 = not a leaf, 1 = deciduous canopy, 2 = conifer
uniform vec3 uCamP;
uniform vec2 uFade;       // (start, end) metres — 0 disables
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
void main() {
  float bare = uSeason.z * step(0.5, uFoliage) * step(uFoliage, 1.5);
  vec3 p = position;
  p.xy *= mix(1.0, 0.32, bare);
  p.z  *= mix(1.0, 0.94, bare);

  // ---- THE SPECKLE ---------------------------------------------------------
  //
  // A guardrail is 7 m of 70 mm steel and there are four and a half thousand of
  // them. Up close that is the best object on the roof — a long horizontal line
  // floating above the deck reads as a roof when the deck itself is nine pixels
  // of flat colour. At the establishing zoom it is one or two pixels of hard
  // dark against pale render, four thousand times, and the city wears it as
  // GRAIN rather than as objects. Same for urns, chimney pots and condensers.
  //
  // So the small parts shrink out of existence over a band. They do not fade:
  // a fade needs blending and these are opaque and unsorted. Shrinking toward
  // the instance origin costs nothing, has no draw-order problem, and the last
  // thing to go is the middle of the object rather than its aliasing edge.
  //
  // These same parts are marked noShadow, and that is not a separate decision.
  // The bake replaces the vertex stage with MeshDepthMaterial, so it cannot see
  // this shrink and would go on casting a full-size shadow for a prop that is
  // no longer drawn — the orphan-shadow failure the pedestrians had. A rail's
  // cast shadow is worth nothing next to that.
  if (uFade.y > 0.0) {
    vec3 iOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float d = distance(uCamP, iOrigin);
    p *= 1.0 - smoothstep(uFade.x, uFade.y, d);
  }

  vN = normalize(mat3(instanceMatrix) * normal);
  vW = (instanceMatrix * vec4(p, 1.0)).xyz;
  vC = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}`;

// THE WALKERS' RIG. Pedestrians and traffic move in the VERTEX SHADER — the
// instance matrix parks each figure at the middle of its stretch of pavement
// and the shader slides it back and forth along the street direction off the
// shared clock, so five thousand moving people cost the CPU exactly nothing
// per frame. Two more ideas ride in the same attributes:
//
//   BREATH  the city swells and empties on a slow cycle (~six minutes of
//           real time reads as a day). Each figure carries a threshold; when
//           the breath drops below it they are simply not out — collapsed to
//           a point, invisible, free. Midday everyone is on the street; in
//           the quiet hours a third are.
//   WRAP    a walker patrols its own block face and wraps. At this art scale
//           a figure winking between the ends of a block is invisible; what
//           the eye reads is a pavement that MOVES.
const WALKER_VERT = /* glsl */ `
uniform vec4 uSeason;
uniform float uFoliage;
uniform float uTime;
uniform float uActivity;
attribute vec4 aWalk;    // street dir x, y · patrol length m · speed m/s
attribute vec2 aWalk2;   // phase 0..1 · breath threshold 0..1
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
void main() {
  float breath = 0.62 + 0.38 * sin(uTime * 0.018 + 1.7);
  // The slow breath keeps the pavement moving; the simulation decides how
  // many people are there to move. A weak labour market or empty buildings
  // visibly thins the crowd, while rain and snow trim it further upstream.
  float alive = step(aWalk2.y, clamp(breath * uActivity, 0.0, 1.0));
  vec3 p = position * alive;
  float travel = mod(aWalk2.x * aWalk.z + uTime * aWalk.w, aWalk.z) - aWalk.z * 0.5;
  vec4 wp = instanceMatrix * vec4(p, 1.0);
  wp.xy += aWalk.xy * travel;
  // the gait: a two-centimetre bob nobody consciously sees and everybody reads
  wp.z += alive * 0.03 * abs(sin(uTime * 5.2 + aWalk2.x * 47.0)) * step(aWalk.w, 3.0);
  vN = normalize(mat3(instanceMatrix) * normal);
  vW = wp.xyz;
  vC = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * wp;
}`;

// same rig, for props that aren't instanced (the construction crane)
const PROP_VERT_PLAIN = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
void main() {
  vN = normalize(normal);
  vW = position;
  vC = vec3(1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SHADOW_GLSL = /* glsl */ `
uniform sampler2D uShadow;
uniform mat4 uSunVP;
uniform float uShadowOn;
float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
// THE SHADOWS DID NOT TOUCH THE GROUND.
//
// The depth bias was 0.0028 in NDC. The sun camera runs near 1 to far 6000,
// so NDC depth is linear over 5,999 metres and that constant was
// 0.0028 x 5999 = SIXTEEN POINT EIGHT METRES of depth pushed along the light
// ray. At the shader's own sun elevation (asin(0.496) = 29.7 degrees) that is
// 14.6 m of it horizontal.
//
// The median building in this city is 13.0 m tall and throws a 22.8 m shadow.
// So 64% of the median building's shadow was erased before it was drawn, and
// anything under about 8.3 m cast NO SHADOW AT ALL — which is most of the
// city. Every building floated a car's length above its own footprint.
//
// A bias belongs in metres, where it can be reasoned about. 1.6 m is a little
// over one shadow texel (the sun camera covers 4,400 m across a 3,072 map, so
// a texel is 1.43 m) and that is what a constant bias is for. The rest of the
// acne is handled where acne actually comes from — surfaces seen edge-on to
// the light — by offsetting the sample along the surface normal instead of
// burying the whole scene deeper into the light.
// The sun camera's far minus its near, in metres. A uniform rather than a
// constant since the frustum is fitted to each city: hardcode it and the
// metre-denominated bias below silently means something different in every
// town, which is the kind of fault that shows up as shadows detaching from
// their buildings in one city and nowhere else.
uniform float uShadowSpan;
const float SHADOW_BIAS_M = 1.6;      // was 0.0028 NDC == 16.80 m
const float SHADOW_NORMAL_M = 1.15;   // ~one texel, along the surface normal

// A SHADOW IS NOT ONE BLUR WIDE ALONG ITS WHOLE LENGTH.
//
// Four taps at a fixed 1.4-texel radius gives every shadow in the city the
// same soft edge everywhere — the same at the foot of the wall that casts it
// as at the far tip forty metres away. Real ones do the opposite of that, and
// it is one of the most legible depth cues there is: the contact edge under a
// parapet is nearly a hard line, and the same parapet's shadow across the
// street has an edge you can put your thumb over. The sun is half a degree
// wide, so the penumbra opens in proportion to how far the blocker stands
// above what it lands on.
//
// So: find how deep the blockers are, take the gap, open the filter by it.
// Sixteen taps total, laid out on a Vogel disk (golden angle, sqrt radius)
// computed in the loop rather than read from a const array, because array
// constructors are GLSL ES 3.00 and this shader still has to compile as 1.00.
// The disk is rotated per fragment by a hash of world position, which turns
// what would be sixteen visible banding rings into noise the eye reads as
// grain.
const float SHADOW_TEXEL = 1.0 / 3072.0;
const float PENUMBRA_OPEN = 0.085;    // texels of blur per metre of blocker gap
const float PENUMBRA_MAX = 9.0;       // and it stops opening here

float shadowHash(vec2 v) {
  return fract(sin(dot(v, vec2(12.9898, 78.233))) * 43758.5453);
}

// 1.0 = fully sunlit, 0.0 = fully shadowed
//
// SCREEN-SPACE LOD. Up close the penumbra is a real depth cue and the full
// twenty-two taps earn their keep. At the establishing shot a soft edge is
// smaller than a pixel on most of the frame, and the facade shader has already
// dissolved the window grids for the same reason — paying for PCSS out there
// is pure fill-rate. fwidth of the shadow coordinate says how many shadow
// texels one screen pixel spans; past a couple, a hard tap is the same image.
float sunVis(vec3 p, vec3 n) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uSunVP * vec4(p + n * SHADOW_NORMAL_M, 1.0);
  vec3 ndc = sc.xyz / sc.w * 0.5 + 0.5;
  if (ndc.x < 0.0 || ndc.x > 1.0 || ndc.y < 0.0 || ndc.y > 1.0 || ndc.z > 1.0) return 1.0;
  float recv = ndc.z - SHADOW_BIAS_M / uShadowSpan;

  float shadowLod = max(fwidth(ndc.x), fwidth(ndc.y)) / SHADOW_TEXEL;
  if (shadowLod > 2.4) {
    return step(recv, unpackDepth(texture2D(uShadow, ndc.xy)));
  }
  if (shadowLod > 1.1) {
    // Four taps, fixed radius — still a soft contact, cheap enough for the
    // mid-distance roofs that are a few pixels across.
    float sum4 = 0.0;
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 2.39996323;
      float r = sqrt((float(i) + 0.5) / 4.0) * 2.2 * SHADOW_TEXEL;
      sum4 += step(recv, unpackDepth(texture2D(uShadow, ndc.xy + vec2(cos(a), sin(a)) * r)));
    }
    return sum4 * 0.25;
  }

  float ang = shadowHash(floor(p.xy * 4.0)) * 6.2831853;
  vec2 rc = vec2(cos(ang), sin(ang));

  // ---- 1. how far above me is whatever is blocking the sun? ----------------
  float bSum = 0.0, bHits = 0.0;
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 2.39996323 + ang;
    float r = sqrt((float(i) + 0.5) / 6.0) * 4.5 * SHADOW_TEXEL;
    float d = unpackDepth(texture2D(uShadow, ndc.xy + vec2(cos(a), sin(a)) * r));
    if (d < recv) { bSum += d; bHits += 1.0; }
  }
  // Nothing between this fragment and the sun. Full light, and we are done in
  // six taps rather than twenty-two — which is most of the frame, most of the
  // time, and is what pays for the rest of this function.
  if (bHits < 0.5) return 1.0;

  float gapM = max(recv - bSum / bHits, 0.0) * uShadowSpan;
  float radius = min(1.1 + gapM * PENUMBRA_OPEN, PENUMBRA_MAX) * SHADOW_TEXEL;

  // ---- 2. filter at that width --------------------------------------------
  float sum = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996323;
    float r = sqrt((float(i) + 0.5) / 16.0) * radius;
    vec2 o = vec2(cos(a), sin(a)) * r;
    // rotate the whole disk by the per-fragment angle
    o = vec2(o.x * rc.x - o.y * rc.y, o.x * rc.y + o.y * rc.x);
    sum += step(recv, unpackDepth(texture2D(uShadow, ndc.xy + o)));
  }
  return sum * (1.0 / 16.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vTint;
varying vec3 vPos;
varying vec2 vSeg, vCcv;
varying float vU, vZ, vStyle, vRand, vVar, vTop, vFh, vEra;
varying float vLit;
varying float vRet;
uniform float uOpacity;
uniform vec3 uCam;
${"" /* shadow sampling */}
` + SHADOW_GLSL + LIGHT_GLSL + SEASON_GLSL + HAZE_GLSL + STYLE_SETS_GLSL + /* glsl */ `

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  int s = int(vStyle + 0.5);
  vec3 n = normalize(vNormal);
  float vis = sunVis(vPos, n);

  // ---- ambient occlusion --------------------------------------------------
  // Light doesn't reach the bottom of a street wall, and it doesn't reach into
  // an inside corner. Without these two terms a building looks pasted onto
  // the ground instead of standing on it.
  float aoGround = mix(0.64, 1.0, smoothstep(0.0, 7.5, vZ));
  // A TIGHT CONTACT LINE, which is a different thing from the soft gradient
  // above it. The 7.5 m falloff is the street canyon losing sky; what makes a
  // wall look like it is STANDING on the pavement rather than hovering a
  // centimetre above it is a hard dark band in the bottom metre and a half,
  // and it has to survive into the direct term or a sunlit facade floats.
  float contact = mix(0.55, 1.0, smoothstep(0.0, 1.6, vZ));
  float dA = vU - vSeg.x, dB = vSeg.y - vU;
  float wA = 1.0 - smoothstep(0.0, 1.7, dA);
  float wB = 1.0 - smoothstep(0.0, 1.7, dB);
  float edge = clamp(wA * vCcv.x + wB * vCcv.y, -1.0, 1.0);
  float aoCorner = edge < 0.0 ? mix(1.0, 0.58, -edge) : 1.0;
  float edgeLift = edge > 0.0 ? 1.0 + 0.055 * edge : 1.0;   // convex arris catches light
  // the underside of a cornice or setback keeps its own shade
  float aoEave = mix(0.80, 1.0, smoothstep(0.0, 1.6, vTop - vZ));
  float ao = aoGround * aoCorner * aoEave * contact;

  // ---- palette by style + variant -----------------------------------------
  vec3 wall; vec3 glassA; vec3 glassB; float colW; vec2 win;
  bool glassy = false;
  // FLAT, NOT NESTED. This was one else-if chain 126 branches deep, and a
  // chain that long nests just as deep in the GLSL translator — which is
  // what tipped it into "expression too complex", a COMPILE-time failure
  // that blacks out the entire layer rather than making one building look
  // wrong. The branches are mutually exclusive on s, so independent ifs
  // over a default are identical in behaviour and flat in the translator.
  wall = vec3(0.82, 0.82, 0.80); glassA = wall; glassB = wall;
  colW = 100.0; win = vec2(0.0);
  if (s == 0) { // curtain wall — the "wall" is dark spandrel glass
    glassy = true; colW = 1.7; win = vec2(0.93, 0.78);
    if (vVar < 0.35)      { glassA = vec3(0.38, 0.58, 0.62); glassB = vec3(0.62, 0.80, 0.80); wall = vec3(0.20, 0.30, 0.32); } // blue-green
    else if (vVar < 0.7)  { glassA = vec3(0.55, 0.60, 0.66); glassB = vec3(0.78, 0.83, 0.88); wall = vec3(0.32, 0.35, 0.39); } // silver
    else                  { glassA = vec3(0.52, 0.44, 0.34); glassB = vec3(0.76, 0.66, 0.52); wall = vec3(0.30, 0.24, 0.18); } // bronze
  }
  if (s == 1) { colW = 3.0; win = vec2(0.46, 0.52);
    // SEVEN STONES, NOT THREE. A street of pre-war masonry is never three
    // colours repeated — it is limestone next to brownstone next to granite
    // next to something somebody painted in 1954, and the eye reads the
    // variety long before it reads any single building.
    // ERA CHOOSES THE STONE. These seven ran off vVar alone, so a building
    // finished in 1885 and one finished in 2018 drew from the same hat — and
    // this one style carries 1,655 buildings across 133 years. Sorted here
    // dark-to-pale against age: brownstone and granite are what the 1880s
    // built with, limestone and pale ashlar are the 1910s, and paint is what
    // somebody did to all of it in 1954.
    float pk = clamp(vVar * 0.58 + vEra * 0.42, 0.0, 0.999);
    if (pk < 0.14)        { wall = vec3(0.46, 0.35, 0.31); } // dark brownstone
    else if (pk < 0.30)   { wall = vec3(0.55, 0.40, 0.33); } // brownstone
    else if (pk < 0.44)   { wall = vec3(0.63, 0.60, 0.57); } // grey granite
    else if (pk < 0.58)   { wall = vec3(0.70, 0.66, 0.61); } // soot-washed
    else if (pk < 0.72)   { wall = vec3(0.79, 0.75, 0.66); } // pale ashlar
    else if (pk < 0.87)   { wall = vec3(0.86, 0.81, 0.70); } // limestone
    else                  { wall = vec3(0.78, 0.79, 0.72); } // painted
    glassA = vec3(0.30, 0.36, 0.42); glassB = vec3(0.44, 0.52, 0.58);
  }
  if (s == 2) { colW = 2.9; win = vec2(0.42, 0.50);
    // The same for brick, which carries 2,403 buildings across 109 years on
    // one palette. Deep red and dark brown are 19th-century common brick; tan
    // and buff are the 1920s; whitewash and grey paint are what happened later.
    float pk = clamp(vVar * 0.60 + vEra * 0.40, 0.0, 0.999);
    if (pk < 0.15)        { wall = vec3(0.63, 0.34, 0.28); } // deep red
    else if (pk < 0.29)   { wall = vec3(0.49, 0.38, 0.34); } // dark brown
    else if (pk < 0.43)   { wall = vec3(0.72, 0.46, 0.36); } // red brick
    else if (pk < 0.57)   { wall = vec3(0.58, 0.42, 0.34); } // brown
    else if (pk < 0.71)   { wall = vec3(0.76, 0.62, 0.46); } // tan
    else if (pk < 0.83)   { wall = vec3(0.80, 0.71, 0.55); } // buff
    else if (pk < 0.93)   { wall = vec3(0.83, 0.80, 0.74); } // whitewash
    else                  { wall = vec3(0.60, 0.55, 0.53); } // grey-painted
    glassA = vec3(0.32, 0.38, 0.44); glassB = vec3(0.50, 0.57, 0.62);
  }
  if (s == 3) { colW = 4.4; win = vec2(0.58, 0.50);
    wall = mix(vec3(0.72, 0.63, 0.52), vec3(0.62, 0.58, 0.55), step(0.5, vVar));
    glassA = vec3(0.40, 0.48, 0.54); glassB = vec3(0.58, 0.66, 0.70);
  }
  if (s == 4) { glassy = true; colW = 2.7; win = vec2(0.62, 0.58);
    wall = vec3(0.25, 0.27, 0.31); glassA = vec3(0.72, 0.60, 0.34); glassB = vec3(0.88, 0.78, 0.52);
  }
  if (s == 6) { colW = 2.4; win = vec2(0.48, 0.60);
    wall = mix(vec3(0.84, 0.78, 0.64), vec3(0.72, 0.64, 0.50), step(0.5, vVar));
    glassA = vec3(0.28, 0.33, 0.38); glassB = vec3(0.42, 0.48, 0.54);
  }
  if (s == 7) { glassy = true; colW = 6.5; win = vec2(0.94, 0.46);
    wall = mix(vec3(0.80, 0.80, 0.77), vec3(0.72, 0.74, 0.72), step(0.5, vVar));
    glassA = vec3(0.36, 0.48, 0.52); glassB = vec3(0.55, 0.68, 0.70);
  }
  if (s == 15) {
    // CRYSTAL — floor-to-ceiling vision glass with no spandrel band at all.
    // What makes a modern tower read as ALL glass is not the colour, it is that
    // the floor plate is hidden behind the glass instead of expressed as a band
    // of stone or metal across it. So the opening runs to 98% of the bay and
    // 92% of the floor: what is left is a shadow gap, not a wall. Low-iron
    // glass is nearly colourless face-on and goes deep blue-green at a grazing
    // angle, which is the whole optical signature of the thing.
    glassy = true; colW = 1.55; win = vec2(0.980, 0.920);
    if (vVar < 0.30)      { glassA = vec3(0.60, 0.74, 0.80); glassB = vec3(0.80, 0.90, 0.94); wall = vec3(0.42, 0.54, 0.60); } // water-white
    else if (vVar < 0.58) { glassA = vec3(0.44, 0.62, 0.70); glassB = vec3(0.66, 0.82, 0.88); wall = vec3(0.30, 0.44, 0.50); } // low-iron blue
    else if (vVar < 0.82) { glassA = vec3(0.52, 0.68, 0.64); glassB = vec3(0.72, 0.86, 0.82); wall = vec3(0.34, 0.48, 0.46); } // sea green
    else                  { glassA = vec3(0.34, 0.38, 0.46); glassB = vec3(0.58, 0.66, 0.76); wall = vec3(0.22, 0.26, 0.33); } // smoke
  }
  if (s == 16) {
    // DIAGRID — the structure is on the OUTSIDE. Hearst Tower and 30 St Mary
    // Axe are glass buildings whose bracing you can read from the street, and
    // the diagonal is drawn below over the whole facade rather than being
    // faked with a colour. The glass behind it is ordinary and pale on purpose:
    // the lattice is the building.
    glassy = true; colW = 1.7; win = vec2(0.96, 0.90);
    glassA = vec3(0.48, 0.62, 0.68); glassB = vec3(0.70, 0.82, 0.86); wall = vec3(0.70, 0.71, 0.73);
  }
  if (s == 17) {
    // POSTMODERN — polished granite piers with punched vertical glass between
    // them, and the pier is the point: a 1984 tower is a masonry building with
    // big windows, not a glass one. Four stones, because these were quarried
    // and every developer picked a different one.
    colW = 3.4; win = vec2(0.52, 0.78);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.28)        { wall = vec3(0.46, 0.36, 0.36); } // polished rose granite
    else if (pk < 0.54)   { wall = vec3(0.34, 0.34, 0.37); } // charcoal granite
    else if (pk < 0.80)   { wall = vec3(0.74, 0.70, 0.64); } // buff travertine
    else                  { wall = vec3(0.58, 0.60, 0.58); } // green serpentine
    glassA = vec3(0.24, 0.30, 0.36); glassB = vec3(0.40, 0.50, 0.58);
  }
  // ======================= THE OTHER HUNDRED AND FIFTY YEARS =================
  // Each of these is a TYPE before it is a colour. What sets them apart in the
  // three lines below is the bay width, the shape of the hole in the wall, and
  // how deep that hole is — proportion, which is what you actually read at
  // three hundred metres, long before you read a hue.
  if (s == 18) {
    // CAST IRON. A loft front is a kit of parts bolted together: slender
    // colonnettes carrying arched bays, and because the iron does the work the
    // wall between them is almost entirely glass. That glass ratio in an 1870s
    // building is the whole tell — it is why SoHo looks modern and Beacon Hill
    // does not. Painted, always, and in the colours iron paint came in.
    glassy = true; colW = 3.15; win = vec2(0.74, 0.80);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.20)      { wall = vec3(0.44, 0.48, 0.42); } // sage green
    else if (pk < 0.38) { wall = vec3(0.80, 0.77, 0.68); } // cream
    else if (pk < 0.54) { wall = vec3(0.48, 0.30, 0.26); } // oxide red
    else if (pk < 0.70) { wall = vec3(0.26, 0.34, 0.32); } // bottle green
    else if (pk < 0.86) { wall = vec3(0.70, 0.68, 0.64); } // stone grey
    else                { wall = vec3(0.28, 0.34, 0.44); } // prussian blue
    glassA = vec3(0.26, 0.32, 0.36); glassB = vec3(0.42, 0.50, 0.55);
  }
  if (s == 19) {
    // RICHARDSONIAN ROMANESQUE. Rough-faced stone in big courses, and arches
    // that spring from squat piers. The signature is WEIGHT: the openings are
    // small relative to the wall and every one of them sits at the back of a
    // deep reveal, so the facade is mostly shadow and rubble texture.
    colW = 3.7; win = vec2(0.42, 0.60);
    float pk = clamp(vVar * 0.7 + vEra * 0.3, 0.0, 0.999);
    if (pk < 0.30)      { wall = vec3(0.47, 0.33, 0.28); } // red sandstone
    else if (pk < 0.58) { wall = vec3(0.52, 0.44, 0.38); } // brownstone
    else if (pk < 0.82) { wall = vec3(0.58, 0.55, 0.52); } // grey granite
    else                { wall = vec3(0.64, 0.56, 0.46); } // buff rubble
    glassA = vec3(0.20, 0.25, 0.29); glassB = vec3(0.33, 0.40, 0.45);
  }
  if (s == 20) {
    // TERRA-COTTA GOTHIC. Vertical piers that never stop, a pointed head on
    // every opening, and a pale cream glaze that reads almost white in sun.
    // The proportion is the point: narrow bay, tall window, nothing horizontal.
    colW = 2.65; win = vec2(0.54, 0.76);
    wall = mix(vec3(0.84, 0.80, 0.70), vec3(0.76, 0.72, 0.64), step(0.5, vVar));
    glassA = vec3(0.24, 0.29, 0.34); glassB = vec3(0.38, 0.45, 0.52);
  }
  if (s == 21) {
    // BEAUX-ARTS. Three parts stacked — a rusticated base, a giant order
    // running through the middle, a heavy cornice — in pale limestone. The
    // giant order is drawn below; here it is the stone and the calm bay.
    colW = 3.9; win = vec2(0.46, 0.63);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.34)      { wall = vec3(0.795, 0.760, 0.680); } // limestone
    else if (pk < 0.64) { wall = vec3(0.80, 0.77, 0.70); } // pale ashlar
    else if (pk < 0.86) { wall = vec3(0.74, 0.71, 0.66); } // grey stone
    else                { wall = vec3(0.82, 0.76, 0.64); } // warm bath stone
    glassA = vec3(0.26, 0.31, 0.36); glassB = vec3(0.40, 0.47, 0.53);
  }
  if (s == 22) {
    // SECOND EMPIRE. Tall narrow openings with segmental heads, a bracket
    // rhythm under the eave, and a mansard over it (the massing draws that).
    colW = 3.0; win = vec2(0.40, 0.68);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.36)      { wall = vec3(0.52, 0.42, 0.35); } // brownstone
    else if (pk < 0.68) { wall = vec3(0.64, 0.61, 0.56); } // grey stone
    else                { wall = vec3(0.74, 0.70, 0.61); } // painted stucco
    glassA = vec3(0.24, 0.29, 0.34); glassB = vec3(0.38, 0.45, 0.51);
  }
  if (s == 23) {
    // ITALIANATE. The commonest nineteenth-century commercial front there is:
    // round-headed windows in a tall thin proportion, and a bracketed cornice
    // that throws a hard black line across the top of the wall.
    colW = 3.1; win = vec2(0.38, 0.70);
    float pk = clamp(vVar * 0.66 + vEra * 0.34, 0.0, 0.999);
    if (pk < 0.24)      { wall = vec3(0.50, 0.38, 0.32); } // brownstone
    else if (pk < 0.46) { wall = vec3(0.72, 0.62, 0.47); } // buff
    else if (pk < 0.68) { wall = vec3(0.78, 0.72, 0.60); } // ochre paint
    else if (pk < 0.86) { wall = vec3(0.66, 0.63, 0.60); } // grey paint
    else                { wall = vec3(0.80, 0.78, 0.74); } // white paint
    glassA = vec3(0.25, 0.30, 0.35); glassB = vec3(0.40, 0.46, 0.52);
  }
  if (s == 24) {
    // FEDERAL / GREEK REVIVAL. Small panes in a modest opening, a flat splayed
    // lintel over it, red brick with white trim. Domestic scale, and the thing
    // that says so is that the window is WIDER than it is tall-looking because
    // the panes are small and the sash is short.
    colW = 3.4; win = vec2(0.40, 0.52);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.44)      { wall = vec3(0.62, 0.38, 0.31); } // red brick
    else if (pk < 0.72) { wall = vec3(0.55, 0.36, 0.31); } // deep red
    else if (pk < 0.90) { wall = vec3(0.74, 0.70, 0.64); } // painted brick
    else                { wall = vec3(0.80, 0.78, 0.72); } // whitewash
    glassA = vec3(0.30, 0.35, 0.39); glassB = vec3(0.46, 0.52, 0.57);
  }
  if (s == 25) {
    // THE TENEMENT. Tight window rhythm, no ornament anybody paid for, painted
    // brick in whatever was cheap, and iron on the front (the fire escape is
    // real geometry and already instanced onto these).
    colW = 2.85; win = vec2(0.44, 0.56);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.26)      { wall = vec3(0.60, 0.40, 0.34); } // red
    else if (pk < 0.48) { wall = vec3(0.70, 0.60, 0.48); } // tan
    else if (pk < 0.68) { wall = vec3(0.62, 0.60, 0.58); } // grey paint
    else if (pk < 0.86) { wall = vec3(0.55, 0.52, 0.50); } // soot
    else                { wall = vec3(0.74, 0.71, 0.64); } // cream paint
    glassA = vec3(0.26, 0.30, 0.34); glassB = vec3(0.40, 0.45, 0.50);
  }
  if (s == 26) {
    // CHICAGO SCHOOL. The frame is steel, so the window can be as wide as the
    // bay — a big fixed pane with a narrow operable sash each side. That WIDE
    // opening in a masonry-looking building is the entire identification, and
    // it is why these buildings look a generation ahead of their neighbours.
    colW = 5.3; win = vec2(0.80, 0.62);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.36)      { wall = vec3(0.78, 0.74, 0.65); } // buff terra cotta
    else if (pk < 0.66) { wall = vec3(0.68, 0.65, 0.60); } // grey terra cotta
    else                { wall = vec3(0.62, 0.48, 0.38); } // red brick pier
    glassA = vec3(0.28, 0.34, 0.39); glassB = vec3(0.44, 0.52, 0.58);
  }
  if (s == 27) {
    // GLAZED WHITE TERRA COTTA. A fired glaze, so it is glossier than stone
    // and it washes clean in the rain — the one old building on the block that
    // never went black. Crisp, bright, and slightly cold.
    colW = 3.2; win = vec2(0.50, 0.66);
    // Held under 0.80: contrast runs in linear space about a 0.18 pivot, so an
    // albedo over ~0.85 clips to flat white before the light rig touches it.
    // A glaze reads bright because it is GLOSSY, not because it is pale, and
    // the sheen below is what carries that.
    wall = mix(vec3(0.795, 0.785, 0.740), vec3(0.760, 0.745, 0.675), step(0.5, vVar));
    glassA = vec3(0.26, 0.32, 0.38); glassB = vec3(0.42, 0.50, 0.57);
  }
  if (s == 28) {
    // STREAMLINE MODERNE. Everything horizontal: banded sills, a wrapped
    // corner, glass block, cream stucco. The 1930s answer to the deco tower,
    // built low and wide.
    glassy = true; colW = 5.9; win = vec2(0.88, 0.44);
    wall = mix(vec3(0.84, 0.81, 0.74), vec3(0.78, 0.76, 0.71), step(0.5, vVar));
    glassA = vec3(0.44, 0.54, 0.56); glassB = vec3(0.64, 0.75, 0.76);
  }
  if (s == 29) {
    // STRIPPED CLASSICISM. The civic building of 1935: the giant order is
    // still there but it has lost its capitals, and the windows sit at the
    // back of very deep piers. Pale granite, and mostly shadow.
    colW = 4.3; win = vec2(0.34, 0.70);
    wall = mix(vec3(0.80, 0.78, 0.73), vec3(0.72, 0.70, 0.66), step(0.5, vVar));
    glassA = vec3(0.20, 0.25, 0.30); glassB = vec3(0.34, 0.41, 0.47);
  }
  if (s == 30) {
    // CARRIAGE HOUSE. One big opening at grade for the vehicle, a hayloft door
    // over it, and very little else. The lower storey being MOSTLY HOLE is the
    // type, and it survives conversion — it is why these are desirable now.
    colW = 4.1; win = vec2(0.42, 0.46);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.40)      { wall = vec3(0.60, 0.42, 0.34); } // common brick
    else if (pk < 0.70) { wall = vec3(0.66, 0.62, 0.55); } // stucco
    else                { wall = vec3(0.52, 0.46, 0.40); } // dark brick
    glassA = vec3(0.22, 0.25, 0.28); glassB = vec3(0.34, 0.39, 0.43);
  }
  if (s == 31) {
    // MARKET HALL. A big arched arcade at ground level with a clerestory over
    // it — the building is one room and the section shows on the outside.
    colW = 4.7; win = vec2(0.62, 0.68);
    wall = mix(vec3(0.66, 0.48, 0.38), vec3(0.74, 0.68, 0.58), step(0.5, vVar));
    glassA = vec3(0.30, 0.36, 0.41); glassB = vec3(0.46, 0.54, 0.60);
  }
  if (s == 32) {
    // INTERNATIONAL STYLE. Bronze or black steel, and the mullion is an
    // I-BEAM welded to the face — a real projecting section, not a line. That
    // shadow every 2.8 m down the whole height is why a Seagram-family tower
    // reads as fabric rather than as a sheet.
    glassy = true; colW = 2.8; win = vec2(0.86, 0.82);
    if (vVar < 0.42)      { wall = vec3(0.22, 0.18, 0.13); glassA = vec3(0.40, 0.42, 0.34); glassB = vec3(0.58, 0.60, 0.48); } // bronze
    else if (vVar < 0.76) { wall = vec3(0.17, 0.18, 0.19); glassA = vec3(0.34, 0.40, 0.42); glassB = vec3(0.52, 0.60, 0.62); } // black steel
    else                  { wall = vec3(0.66, 0.67, 0.68); glassA = vec3(0.42, 0.50, 0.54); glassB = vec3(0.62, 0.72, 0.76); } // aluminium
  }
  if (s == 33) {
    // PRECAST EGGCRATE. A concrete waffle where every cell is a deep box with
    // the glass at the back of it. The facade is therefore mostly SELF-SHADOW,
    // and which side of each cell is dark tells you where the sun is.
    colW = 3.05; win = vec2(0.62, 0.60);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.40)      { wall = vec3(0.76, 0.75, 0.71); } // white cement
    else if (pk < 0.72) { wall = vec3(0.68, 0.66, 0.62); } // grey precast
    else                { wall = vec3(0.74, 0.69, 0.59); } // buff aggregate
    glassA = vec3(0.24, 0.29, 0.33); glassB = vec3(0.38, 0.45, 0.50);
  }
  if (s == 34) {
    // BRUTALISM. Board-formed concrete with the grain of the shuttering left
    // in it, and windows reduced to narrow vertical slots. No expressed floor
    // line at all — the wall is one monolithic thing from base to parapet.
    colW = 3.0; win = vec2(0.24, 0.74);
    wall = mix(vec3(0.62, 0.61, 0.58), vec3(0.55, 0.54, 0.52), step(0.5, vVar));
    glassA = vec3(0.16, 0.19, 0.22); glassB = vec3(0.27, 0.32, 0.37);
  }
  if (s == 35) {
    // MIRROR GLASS. The 1970s skin with no visible mullion and a reflectance
    // so high the building is mostly a picture of the sky next to it. Drawn as
    // reflection almost all the way — see the reflectance override below.
    glassy = true; colW = 3.4; win = vec2(0.965, 0.94);
    if (vVar < 0.38)      { glassA = vec3(0.50, 0.40, 0.26); glassB = vec3(0.74, 0.62, 0.40); wall = vec3(0.36, 0.29, 0.19); } // bronze mirror
    else if (vVar < 0.72) { glassA = vec3(0.52, 0.56, 0.58); glassB = vec3(0.76, 0.80, 0.82); wall = vec3(0.38, 0.41, 0.43); } // silver mirror
    else                  { glassA = vec3(0.30, 0.33, 0.36); glassB = vec3(0.50, 0.55, 0.58); wall = vec3(0.22, 0.25, 0.27); } // smoke mirror
  }
  if (s == 36) {
    // CORRUGATED METAL. The working waterfront's skin — a shed wall with a
    // vertical rib every 150 mm and almost no openings. The rib is drawn as
    // shading below; here it is the flat colour under it.
    colW = 6.0; win = vec2(0.30, 0.26);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.34)      { wall = vec3(0.72, 0.73, 0.71); } // galvanised
    else if (pk < 0.58) { wall = vec3(0.44, 0.50, 0.46); } // green painted
    else if (pk < 0.78) { wall = vec3(0.58, 0.42, 0.34); } // red oxide
    else                { wall = vec3(0.66, 0.64, 0.58); } // faded cream
    glassA = vec3(0.30, 0.34, 0.36); glassB = vec3(0.44, 0.50, 0.52);
  }
  if (s == 37) {
    // EIFS / STUCCO INFILL. The cheap modern mid-block filler: a foam-and-
    // render wall in a colour somebody picked off a chart, with thin punched
    // openings and a trim band. Every city is full of it and it had none.
    colW = 3.4; win = vec2(0.40, 0.54);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.26)      { wall = vec3(0.80, 0.74, 0.62); } // beige
    else if (pk < 0.48) { wall = vec3(0.74, 0.66, 0.58); } // taupe
    else if (pk < 0.68) { wall = vec3(0.80, 0.70, 0.62); } // peach
    else if (pk < 0.86) { wall = vec3(0.70, 0.72, 0.70); } // grey-green
    else                { wall = vec3(0.66, 0.60, 0.56); } // mushroom
    glassA = vec3(0.28, 0.33, 0.38); glassB = vec3(0.43, 0.50, 0.56);
  }
  if (s == 38) {
    // PARKING DECK. Open sides, a spandrel rail at every level, and the
    // openings are VOID rather than glass — you can see straight through to
    // the cars and the far wall, which is why a garage never reads as a
    // building even when it is the same size as one.
    colW = 5.2; win = vec2(0.88, 0.46);
    wall = mix(vec3(0.70, 0.69, 0.66), vec3(0.62, 0.62, 0.60), step(0.5, vVar));
    glassA = vec3(0.10, 0.11, 0.12); glassB = vec3(0.16, 0.17, 0.19);
  }
  if (s == 39) {
    // POSTWAR BRICK SLAB. Public housing and its private cousins: paired
    // windows, absolute regularity, no base and no top, brick from grade to
    // parapet. The relentlessness is the identification.
    colW = 3.7; win = vec2(0.54, 0.50);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.42)      { wall = vec3(0.66, 0.44, 0.36); } // red brick
    else if (pk < 0.74) { wall = vec3(0.74, 0.66, 0.53); } // buff brick
    else                { wall = vec3(0.62, 0.58, 0.54); } // grey brick
    glassA = vec3(0.30, 0.35, 0.40); glassB = vec3(0.46, 0.53, 0.58);
  }
  if (s == 40) {
    // GLAZED WHITE BRICK. The 1960s apartment house: a hard bright ivory
    // brick, dark aluminium windows, and a balcony slot punched in the wall.
    colW = 3.3; win = vec2(0.56, 0.54);
    wall = mix(vec3(0.790, 0.782, 0.735), vec3(0.752, 0.744, 0.706), step(0.5, vVar));
    glassA = vec3(0.24, 0.28, 0.32); glassB = vec3(0.38, 0.44, 0.49);
  }
  if (s == 41) {
    // THE BALCONY TOWER. On a modern residential slab the architecture IS the
    // slab edge: a continuous white line every floor with a dark recess behind
    // it and a rail across it. From the air it reads as a striped building,
    // and the stripe is a real shadow rather than a painted band.
    glassy = true; colW = 3.6; win = vec2(0.88, 0.74);
    wall = mix(vec3(0.84, 0.83, 0.80), vec3(0.74, 0.74, 0.73), step(0.5, vVar));
    glassA = vec3(0.36, 0.46, 0.52); glassB = vec3(0.56, 0.68, 0.74);
  }
  if (s == 42) {
    // FRITTED GLASS. A ceramic dot pattern screen-printed onto the unit,
    // densest at the slab and fading out at eye level — so the tower carries a
    // soft horizontal gradient that is not a spandrel and not a shadow.
    glassy = true; colW = 1.62; win = vec2(0.96, 0.92);
    if (vVar < 0.40)      { glassA = vec3(0.52, 0.64, 0.70); glassB = vec3(0.70, 0.79, 0.83); wall = vec3(0.44, 0.56, 0.62); }
    else if (vVar < 0.74) { glassA = vec3(0.47, 0.56, 0.63); glassB = vec3(0.66, 0.74, 0.79); wall = vec3(0.40, 0.48, 0.55); }
    else                  { glassA = vec3(0.54, 0.61, 0.60); glassB = vec3(0.72, 0.78, 0.76); wall = vec3(0.46, 0.53, 0.52); }
  }
  if (s == 43) {
    // MASS TIMBER. A CLT frame with the wood left visible in the spandrel: a
    // warm, slightly orange band at every floor between big square openings.
    // It is the only warm modern building on the block and it shows.
    colW = 3.65; win = vec2(0.70, 0.68);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.40)      { wall = vec3(0.72, 0.55, 0.35); } // fresh larch
    else if (pk < 0.74) { wall = vec3(0.64, 0.50, 0.36); } // oiled
    else                { wall = vec3(0.60, 0.56, 0.50); } // silvered
    glassA = vec3(0.32, 0.40, 0.45); glassB = vec3(0.50, 0.60, 0.66);
  }
  if (s == 44) {
    // RAINSCREEN. Terracotta baguettes or perforated metal hung in FRONT of
    // the glass — so the wall has two depths and the outer one is a comb. The
    // shading changes as you move past it, which nothing else here does.
    glassy = true; colW = 2.2; win = vec2(0.92, 0.86);
    if (vVar < 0.45) { wall = vec3(0.72, 0.46, 0.32); }      // terracotta baguette
    else             { wall = vec3(0.70, 0.71, 0.72); }      // perforated aluminium
    glassA = vec3(0.34, 0.42, 0.48); glassB = vec3(0.52, 0.62, 0.68);
  }
  if (s == 45) {
    // BIG BOX. A blank field of split-face block under a parapet with the
    // tenant's colour on it. There are no windows because there is nothing to
    // see out of, and that blankness at this size is unmistakable.
    colW = 8.0; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.78, 0.75, 0.69), vec3(0.70, 0.68, 0.64), step(0.5, vVar));
    glassA = wall; glassB = wall;
  }
  if (s == 126) {
    // MEDICAL OFFICE. Precast panels, punched openings on a tight regular
    // grid because every exam room is the same room, and a canopy at the door
    // deep enough to unload a patient under.
    colW = 3.0; win = vec2(0.46, 0.52);
    wall = mix(vec3(0.700, 0.680, 0.640), vec3(0.640, 0.600, 0.545), step(0.55, vVar));
    glassA = vec3(0.30, 0.37, 0.43); glassB = vec3(0.47, 0.57, 0.63);
  }
  if (s == 127) {
    // THE SUBURBAN OFFICE PARK. Three storeys of continuous reflective ribbon
    // over a dark spandrel, set behind a berm — the building is a horizontal
    // stripe, and it is the same stripe on all four sides.
    glassy = true; colW = 6.8; win = vec2(0.94, 0.54);
    wall = mix(vec3(0.360, 0.375, 0.390), vec3(0.560, 0.545, 0.520), step(0.55, vVar));
    glassA = vec3(0.44, 0.55, 0.58); glassB = vec3(0.66, 0.78, 0.80);
  }
  if (s == 128) {
    // THE GARDEN OFFICE. Brick, a hipped roof, small-paned windows — a
    // building deliberately pretending to be a large house, which is what an
    // executive suite in a business park always did.
    colW = 3.4; win = vec2(0.42, 0.50);
    wall = mix(vec3(0.585, 0.430, 0.360), vec3(0.640, 0.610, 0.560), step(0.6, vVar));
    glassA = vec3(0.28, 0.34, 0.40); glassB = vec3(0.44, 0.53, 0.59);
  }
  if (s == 129) {
    // THE OPERATIONS CENTRE. An enormous plate with almost no window, because
    // what is inside is desks and machines and neither needs a view — a strip
    // of glass at the top floor for the people who chose the building.
    colW = 5.6; win = vec2(0.22, 0.20);
    wall = mix(vec3(0.640, 0.630, 0.610), vec3(0.585, 0.560, 0.520), step(0.55, vVar));
    glassA = vec3(0.26, 0.32, 0.37); glassB = vec3(0.42, 0.50, 0.56);
  }
  if (s == 130) {
    // THE CAMPUS BLOCK. Very long, very low, and entirely horizontal — no
    // vertical anything, on purpose, so it lies in the landscape rather than
    // standing in it.
    glassy = true; colW = 7.6; win = vec2(0.92, 0.46);
    wall = mix(vec3(0.620, 0.615, 0.595), vec3(0.545, 0.560, 0.570), step(0.55, vVar));
    glassA = vec3(0.38, 0.48, 0.53); glassB = vec3(0.58, 0.70, 0.75);
  }
  if (s == 131) {
    // THE COMPANY SLAB. A precast grid — one cell per desk — repeated without
    // variation for two hundred metres. The relentlessness is the point: it
    // said the company was large and would be there forever.
    colW = 2.7; win = vec2(0.56, 0.56);
    wall = mix(vec3(0.700, 0.690, 0.665), vec3(0.620, 0.610, 0.585), step(0.55, vVar));
    glassA = vec3(0.28, 0.34, 0.39); glassB = vec3(0.44, 0.52, 0.58);
  }
  if (s == 132) {
    // LEASED GOVERNMENT. Blank precast, a deep security setback at grade with
    // bollards, and windows that are smaller than the budget implies.
    colW = 3.6; win = vec2(0.34, 0.44);
    wall = mix(vec3(0.665, 0.655, 0.630), vec3(0.600, 0.585, 0.560), step(0.55, vVar));
    glassA = vec3(0.24, 0.30, 0.35); glassB = vec3(0.39, 0.47, 0.53);
  }
  if (s == 133) {
    // THE CARRIER HOTEL. A telephone exchange for the internet: immensely
    // heavy floors, no windows at all, and banks of louvre where the openings
    // would be. Usually an old building nobody can see into any more.
    colW = 3.4; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.505, 0.400, 0.350), vec3(0.545, 0.530, 0.505), step(0.55, vVar));
    glassA = wall; glassB = wall;
  }
  if (s == 134) {
    // THE LOFT CONVERSION. The mill's openings kept exactly as they were, with
    // new frameless glass set inside them — so the wall is old and the glass
    // is obviously not, and the join between them is the whole character.
    glassy = true; colW = 3.3; win = vec2(0.70, 0.74);
    wall = mix(vec3(0.560, 0.395, 0.330), vec3(0.505, 0.450, 0.405), step(0.55, vVar));
    glassA = vec3(0.36, 0.46, 0.52); glassB = vec3(0.56, 0.68, 0.74);
  }
  if (s == 135) {
    // THE SKY LOBBY. A trophy tower changes plate where its lifts change over,
    // a third of the way up — and the two stacks do not quite line up, which
    // is a seam nothing else in a curtain wall has.
    glassy = true; colW = 1.9; win = vec2(0.95, 0.92);
    if (vVar < 0.45) { glassA = vec3(0.44, 0.58, 0.64); glassB = vec3(0.64, 0.76, 0.80); wall = vec3(0.34, 0.45, 0.51); }
    else             { glassA = vec3(0.38, 0.44, 0.52); glassB = vec3(0.58, 0.66, 0.74); wall = vec3(0.29, 0.35, 0.42); }
  }
  if (s == 136) {
    // THE PROFESSIONAL BUILDING. Two storeys, very shallow plate, and an
    // external walkway along the upper floor serving every suite door — a
    // motel plan sold to dentists and accountants.
    colW = 3.6; win = vec2(0.54, 0.52);
    wall = mix(vec3(0.660, 0.640, 0.600), vec3(0.585, 0.470, 0.400), step(0.6, vVar));
    glassA = vec3(0.30, 0.37, 0.43); glassB = vec3(0.47, 0.57, 0.63);
  }
  if (s == 137) {
    // THE BOUTIQUE. Small, expensive, and almost entirely stone: one storey of
    // very good glass at the base and deep punched openings above it, because
    // the money went into the wall rather than into the window.
    colW = 3.8; win = vec2(0.38, 0.60);
    wall = mix(vec3(0.700, 0.680, 0.640), vec3(0.470, 0.460, 0.455), step(0.6, vVar));
    glassA = vec3(0.24, 0.30, 0.36); glassB = vec3(0.40, 0.48, 0.55);
  }
  if (s == 138) {
    // BUILD-TO-SUIT. Where a cornice would be there is a LOGO BAND — a
    // saturated stripe of the tenant's colour running the whole frontage,
    // which is the only reason the building looks the way it does.
    glassy = true; colW = 4.2; win = vec2(0.88, 0.62);
    wall = mix(vec3(0.600, 0.605, 0.615), vec3(0.545, 0.530, 0.510), step(0.55, vVar));
    glassA = vec3(0.36, 0.46, 0.52); glassB = vec3(0.56, 0.67, 0.73);
  }
  if (s == 112) {
    // THE SKY GARDEN. Planted terraces at every level, so the tower is half
    // foliage — the only green vertical surface in any city, and from a
    // distance the building reads as a striped column of leaf and glass.
    glassy = true; colW = 3.4; win = vec2(0.90, 0.60);
    wall = mix(vec3(0.640, 0.635, 0.620), vec3(0.560, 0.560, 0.555), step(0.55, vVar));
    glassA = vec3(0.38, 0.48, 0.54); glassB = vec3(0.58, 0.70, 0.76);
  }
  if (s == 113) {
    // PLEATED. The glass is FOLDED in plan, so every bay has a flank turned
    // toward the sun and a flank turned away — a tower that is bright and dark
    // in alternating stripes from any angle, and changes as you move.
    glassy = true; colW = 2.4; win = vec2(0.96, 0.94);
    if (vVar < 0.40)      { glassA = vec3(0.42, 0.56, 0.63); glassB = vec3(0.62, 0.74, 0.79); wall = vec3(0.34, 0.44, 0.50); }
    else if (vVar < 0.74) { glassA = vec3(0.46, 0.54, 0.52); glassB = vec3(0.66, 0.74, 0.71); wall = vec3(0.36, 0.42, 0.41); }
    else                  { glassA = vec3(0.34, 0.40, 0.48); glassB = vec3(0.54, 0.62, 0.70); wall = vec3(0.27, 0.32, 0.38); }
  }
  if (s == 114) {
    // SHINGLED. Every panel leans out a little over the one below, like scales
    // — so each course catches its own line of light along its bottom edge and
    // the whole wall is a shallow stack rather than a plane.
    glassy = true; colW = 2.9; win = vec2(0.94, 0.90);
    wall = mix(vec3(0.520, 0.560, 0.590), vec3(0.470, 0.490, 0.510), step(0.55, vVar));
    glassA = vec3(0.44, 0.56, 0.62); glassB = vec3(0.64, 0.76, 0.80);
  }
  if (s == 115) {
    // THE DOUBLE SKIN. A second glass layer stood off the first, with the
    // cavity between them visible — you can see the maintenance walkway
    // grating at every floor THROUGH the outer sheet, which nothing else does.
    glassy = true; colW = 2.7; win = vec2(0.97, 0.93);
    wall = mix(vec3(0.470, 0.500, 0.520), vec3(0.400, 0.425, 0.445), step(0.55, vVar));
    glassA = vec3(0.40, 0.52, 0.58); glassB = vec3(0.60, 0.72, 0.78);
  }
  if (s == 116) {
    // THE MEGABRACE. Not a fine diagrid — ONE giant cross spanning eight floors
    // at a time, in painted steel, so the building is divided into a handful of
    // enormous triangles and you read the structure at building scale.
    glassy = true; colW = 3.0; win = vec2(0.93, 0.90);
    wall = mix(vec3(0.660, 0.665, 0.670), vec3(0.400, 0.405, 0.415), step(0.6, vVar));
    glassA = vec3(0.40, 0.52, 0.58); glassB = vec3(0.60, 0.72, 0.78);
  }
  if (s == 117) {
    // CHEVRON. Facets alternating left and right up the height, so the tower
    // zigzags — the reflection breaks at every band and the building never
    // shows one continuous sheet of sky.
    glassy = true; colW = 3.2; win = vec2(0.95, 0.92);
    wall = mix(vec3(0.480, 0.510, 0.535), vec3(0.420, 0.440, 0.470), step(0.55, vVar));
    glassA = vec3(0.42, 0.54, 0.60); glassB = vec3(0.62, 0.74, 0.79);
  }
  if (s == 118) {
    // MODULAR. The building arrived on lorries: a visible joint round every
    // single box, in both directions, at exactly one flat per module. Nothing
    // else has a seam that closes on all four sides.
    colW = 3.9; win = vec2(0.68, 0.62);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.34)      { wall = vec3(0.660, 0.650, 0.630); }
    else if (pk < 0.62) { wall = vec3(0.580, 0.600, 0.605); }
    else                { wall = vec3(0.640, 0.590, 0.530); }
    glassA = vec3(0.30, 0.38, 0.44); glassB = vec3(0.48, 0.58, 0.65);
  }
  if (s == 119) {
    // PHOTOVOLTAIC CLADDING. Near-black, glossy, and gridded with cell lines —
    // the darkest building in any skyline, and it reads as dark even in full
    // sun because that is the entire point of it.
    glassy = true; colW = 2.2; win = vec2(0.94, 0.88);
    wall = mix(vec3(0.140, 0.160, 0.200), vec3(0.190, 0.200, 0.225), step(0.55, vVar));
    glassA = vec3(0.16, 0.20, 0.28); glassB = vec3(0.30, 0.36, 0.46);
  }
  if (s == 120) {
    // THE PODIUM WRAP. Five storeys of timber frame over a concrete podium,
    // clad in fibre cement in BLOCKS OF COLOUR — three or four flat hues in
    // vertical strips, changing every few bays, over a glazed base. The most
    // built thing in America since 2000 and it looks like nothing else.
    colW = 3.3; win = vec2(0.52, 0.58);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.26)      { wall = vec3(0.620, 0.450, 0.360); }  // rust
    else if (pk < 0.48) { wall = vec3(0.500, 0.535, 0.545); }  // slate
    else if (pk < 0.68) { wall = vec3(0.700, 0.665, 0.590); }  // oatmeal
    else if (pk < 0.86) { wall = vec3(0.430, 0.470, 0.430); }  // moss
    else                { wall = vec3(0.560, 0.520, 0.500); }  // taupe
    glassA = vec3(0.28, 0.34, 0.40); glassB = vec3(0.44, 0.53, 0.60);
  }
  if (s == 121) {
    // LIFE SCIENCES. A lab needs enormous plant, so the top two storeys are a
    // louvred mechanical penthouse taller than any parapet — and the wall below
    // it is ribbon glass with a spandrel deep enough to hide a duct run.
    glassy = true; colW = 4.6; win = vec2(0.90, 0.52);
    wall = mix(vec3(0.610, 0.625, 0.635), vec3(0.660, 0.640, 0.600), step(0.55, vVar));
    glassA = vec3(0.36, 0.46, 0.52); glassB = vec3(0.56, 0.68, 0.74);
  }
  if (s == 122) {
    // CREATIVE OFFICE. The frame is left showing and the glazing is industrial
    // in scale — one enormous steel-framed opening per bay, subdivided by thin
    // bars, in a converted-warehouse language built new.
    glassy = true; colW = 5.0; win = vec2(0.82, 0.78);
    wall = mix(vec3(0.520, 0.400, 0.345), vec3(0.470, 0.475, 0.470), step(0.55, vVar));
    glassA = vec3(0.34, 0.42, 0.47); glassB = vec3(0.52, 0.63, 0.69);
  }
  if (s == 123) {
    // MICRO-UNITS. The tightest window rhythm in the city — one small opening
    // per flat and the flats are four metres wide — with a juliet balcony rail
    // on some of them and nothing else at all.
    colW = 3.9; win = vec2(0.40, 0.66);
    wall = mix(vec3(0.630, 0.615, 0.585), vec3(0.545, 0.560, 0.575), step(0.55, vVar));
    glassA = vec3(0.30, 0.37, 0.43); glassB = vec3(0.47, 0.57, 0.63);
  }
  if (s == 124) {
    // PASSIVE HOUSE. Walls half a metre thick, so the openings sit at the back
    // of very deep reveals and the wall between them is dead flat render with
    // no expression whatever. Fewer, smaller holes than anything modern.
    colW = 4.2; win = vec2(0.34, 0.50);
    wall = mix(vec3(0.700, 0.690, 0.665), vec3(0.640, 0.650, 0.640), step(0.55, vVar));
    glassA = vec3(0.28, 0.35, 0.41); glassB = vec3(0.45, 0.55, 0.62);
  }
  if (s == 125) {
    // THE MEDIA BAND. A podium whose corner carries a wrapping LED screen —
    // a band of saturated, self-lit colour that owes nothing to the sun, which
    // makes it the only surface in the city that is bright on its shaded side.
    glassy = true; colW = 4.4; win = vec2(0.88, 0.70);
    wall = mix(vec3(0.300, 0.310, 0.330), vec3(0.380, 0.375, 0.390), step(0.55, vVar));
    glassA = vec3(0.30, 0.38, 0.44); glassB = vec3(0.48, 0.58, 0.65);
  }
  if (s == 104) {
    // THE TRAIN SHED. One colossal semicircular glazed lunette filling the whole
    // end wall, its bars radiating from a single centre. The bay IS the shed.
    glassy = true; colW = 30.0; win = vec2(0.96, 0.97);
    wall = mix(vec3(0.580, 0.550, 0.500), vec3(0.340, 0.320, 0.300), step(0.55, vVar));
    glassA = vec3(0.30, 0.36, 0.34); glassB = vec3(0.52, 0.58, 0.54);
  }
  if (s == 105) {
    // THE CAR BARN. A segmental track arch every 5.8 m with a radiating
    // fanlight over vertical board leaves, and blind brick above.
    colW = 5.80; win = vec2(0.76, 0.92);
    wall = mix(vec3(0.620, 0.360, 0.280), vec3(0.560, 0.430, 0.360), step(0.55, vVar));
    glassA = vec3(0.28, 0.32, 0.34); glassB = vec3(0.46, 0.52, 0.54);
  }
  if (s == 106) {
    // THE HANGAR. The lower two thirds is ONE door in a dozen leaves, each
    // joint a hard shadow full height, with a single clerestory ribbon above.
    glassy = true; colW = 4.30; win = vec2(0.98, 0.98);
    wall = mix(vec3(0.660, 0.670, 0.660), vec3(0.560, 0.575, 0.580), step(0.55, vVar));
    glassA = vec3(0.42, 0.48, 0.50); glassB = vec3(0.62, 0.68, 0.70);
  }
  if (s == 107) {
    // THE BUS STATION. One deep canopy slab cantilevering clear of the front,
    // throwing an unbroken shadow the whole length with the glass behind it
    // permanently near black.
    glassy = true; colW = 6.40; win = vec2(0.95, 0.82);
    wall = mix(vec3(0.660, 0.650, 0.610), vec3(0.740, 0.730, 0.700), step(0.6, vVar));
    glassA = vec3(0.24, 0.28, 0.30); glassB = vec3(0.40, 0.46, 0.48);
  }
  if (s == 108) {
    // THE CONTROL TOWER. A blind battered shaft carrying one glass cab whose
    // glazing leans OUT over the wall below, so the soffit under it is the
    // darkest thing on the building.
    glassy = true; colW = 2.60; win = vec2(0.98, 0.86);
    wall = mix(vec3(0.700, 0.690, 0.660), vec3(0.620, 0.615, 0.600), step(0.6, vVar));
    glassA = vec3(0.20, 0.24, 0.26); glassB = vec3(0.46, 0.54, 0.58);
  }
  if (s == 109) {
    // THE TELEPHONE EXCHANGE. Almost entirely blind, because nothing inside
    // needs a view: one narrow slot per floor on about half the bays, set so
    // deep it reads as pure shadow.
    colW = 3.20; win = vec2(0.16, 0.28);
    wall = mix(vec3(0.560, 0.360, 0.290), vec3(0.620, 0.420, 0.330), step(0.55, vVar));
    glassA = vec3(0.18, 0.21, 0.24); glassB = vec3(0.30, 0.34, 0.38);
  }
  if (s == 110) {
    // THE SUBSTATION. Whole panels of horizontal ventilation louvre — a wall
    // combed with shadow from top to bottom, and no glass in it anywhere.
    colW = 4.80; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.580, 0.500, 0.420), vec3(0.520, 0.500, 0.460), step(0.6, vVar));
    glassA = wall; glassB = wall;
  }
  if (s == 111) {
    // THE LIGHTHOUSE. A pale shaft that visibly narrows as it rises, shaded
    // like a cylinder rather than a flat wall, under a black gallery.
    colW = 6.0; win = vec2(0.10, 0.13);
    wall = mix(vec3(0.720, 0.710, 0.670), vec3(0.680, 0.660, 0.630), step(0.6, vVar));
    glassA = vec3(0.52, 0.50, 0.40); glassB = vec3(0.74, 0.70, 0.54);
  }
  if (s == 94) {
    // THE PARISH CHURCH. Fat stone buttresses stepping back in weathered
    // stages, and one rose wheel high on a single bay. Stained glass, so the
    // openings are dark blue and ruby rather than sky.
    colW = 6.2; win = vec2(0.30, 0.72);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.36)      { wall = vec3(0.580, 0.570, 0.540); }  // grey granite
    else if (pk < 0.68) { wall = vec3(0.520, 0.440, 0.370); }  // brownstone
    else                { wall = vec3(0.740, 0.700, 0.600); }  // buff limestone
    glassA = vec3(0.18, 0.20, 0.34); glassB = vec3(0.52, 0.26, 0.24);
  }
  if (s == 95) {
    // THE MEETING HOUSE. Clapboard lap-lines the whole wall and white-cased
    // twelve-over-twelve sash sitting almost flush on the boards.
    colW = 3.4; win = vec2(0.30, 0.62);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.44)      { wall = vec3(0.780, 0.770, 0.720); }  // white lead paint
    else if (pk < 0.76) { wall = vec3(0.740, 0.720, 0.660); }  // weathered white
    else                { wall = vec3(0.620, 0.610, 0.570); }  // unpainted grey
    glassA = vec3(0.34, 0.38, 0.40); glassB = vec3(0.55, 0.60, 0.60);
  }
  if (s == 96) {
    // HORSESHOE HEADS over a wall banded in two stones, and a six-spoke wheel.
    colW = 4.0; win = vec2(0.34, 0.66);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.40)      { wall = vec3(0.660, 0.550, 0.440); }  // warm sandstone
    else if (pk < 0.74) { wall = vec3(0.740, 0.660, 0.540); }  // pale band
    else                { wall = vec3(0.600, 0.580, 0.550); }  // grey stone
    glassA = vec3(0.26, 0.22, 0.36); glassB = vec3(0.60, 0.42, 0.22);
  }
  if (s == 97) {
    // THE PAVILION HOSPITAL. In 1880 the cure for everything was fresh air, so
    // every floor above the ground is half open — a continuous recessed veranda
    // in deep shade behind slender white posts.
    colW = 3.2; win = vec2(0.50, 0.60);
    wall = mix(vec3(0.660, 0.440, 0.360), vec3(0.740, 0.680, 0.560), step(0.55, vVar));
    glassA = vec3(0.30, 0.36, 0.40); glassB = vec3(0.48, 0.55, 0.58);
  }
  if (s == 98) {
    // THE CELLBLOCK. A cell tier is HALF a storey, so the openings run at twice
    // the floor frequency and refuse to line up with anything — which is the
    // single most unsettling thing a facade can do, and it is why you know.
    colW = 3.0; win = vec2(0.16, 0.34);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.40)      { wall = vec3(0.550, 0.550, 0.530); }  // granite
    else if (pk < 0.74) { wall = vec3(0.620, 0.600, 0.560); }  // pale ashlar
    else                { wall = vec3(0.460, 0.450, 0.430); }  // soot granite
    glassA = vec3(0.14, 0.16, 0.18); glassB = vec3(0.24, 0.27, 0.30);
  }
  if (s == 99) {
    // THE ARMORY. Merlons and dark embrasures over a corbelled course, above a
    // battered base with arrow slits. A castle, built in 1890, for a militia.
    colW = 4.6; win = vec2(0.14, 0.55);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.42)      { wall = vec3(0.520, 0.310, 0.260); }  // dark red brick
    else if (pk < 0.76) { wall = vec3(0.460, 0.360, 0.310); }  // brown brick
    else                { wall = vec3(0.580, 0.560, 0.520); }  // granite trim
    glassA = vec3(0.16, 0.18, 0.20); glassB = vec3(0.26, 0.30, 0.32);
  }
  if (s == 100) {
    // COLLEGIATE GOTHIC. A square head split by heavy STONE mullions into four
    // lights and one transom, each under a drip hood stepped over it.
    colW = 4.2; win = vec2(0.56, 0.52);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.40)      { wall = vec3(0.660, 0.650, 0.600); }  // coursed grey limestone
    else if (pk < 0.74) { wall = vec3(0.720, 0.690, 0.610); }  // warm ashlar
    else                { wall = vec3(0.520, 0.540, 0.500); }  // seam-face granite
    glassA = vec3(0.30, 0.34, 0.33); glassB = vec3(0.50, 0.56, 0.52);
  }
  if (s == 101) {
    // THE BATHS. One enormous half-round thermal lunette per bay, divided by
    // two heavy mullions, in a wall of white glazed terracotta.
    colW = 5.4; win = vec2(0.62, 0.42);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.42)      { wall = vec3(0.790, 0.780, 0.740); }  // white glaze
    else if (pk < 0.76) { wall = vec3(0.760, 0.730, 0.650); }  // cream terracotta
    else                { wall = vec3(0.660, 0.720, 0.680); }  // pale green tile
    glassA = vec3(0.42, 0.50, 0.52); glassB = vec3(0.62, 0.72, 0.72);
  }
  if (s == 102) {
    // THE MUSEUM. A blind stone box that opens only in the last metre, because
    // the light comes from the roof. Nothing on the wall at all until then.
    colW = 6.0; win = vec2(0.88, 0.14);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.42)      { wall = vec3(0.760, 0.730, 0.660); }  // limestone ashlar
    else if (pk < 0.76) { wall = vec3(0.640, 0.630, 0.600); }  // grey stone
    else                { wall = vec3(0.440, 0.440, 0.430); }  // dark granite
    glassA = vec3(0.40, 0.44, 0.46); glassB = vec3(0.62, 0.66, 0.66);
  }
  if (s == 103) {
    // THE CONVENT. A cloister arcade at HALF the upper bay pitch opening into
    // shade, under three storeys of identical cell windows and nothing else.
    colW = 2.6; win = vec2(0.26, 0.52);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.42)      { wall = vec3(0.760, 0.740, 0.680); }  // lime stucco
    else if (pk < 0.76) { wall = vec3(0.720, 0.640, 0.500); }  // ochre wash
    else                { wall = vec3(0.620, 0.610, 0.580); }  // grey render
    glassA = vec3(0.24, 0.28, 0.30); glassB = vec3(0.38, 0.44, 0.46);
  }
  if (s == 82) {
    // THE TRIPLE-DECKER. Three floors, three families, and an OPEN PORCH on
    // each one stacked up the front — the porches are the building. Painted
    // clapboard, in whatever two colours were on sale.
    colW = 3.2; win = vec2(0.44, 0.60);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.24)      { wall = vec3(0.570, 0.510, 0.430); }  // buff
    else if (pk < 0.46) { wall = vec3(0.450, 0.470, 0.430); }  // sage
    else if (pk < 0.66) { wall = vec3(0.530, 0.390, 0.335); }  // barn red
    else if (pk < 0.84) { wall = vec3(0.430, 0.455, 0.500); }  // slate blue
    else                { wall = vec3(0.680, 0.665, 0.625); }  // white
    glassA = vec3(0.27, 0.32, 0.37); glassB = vec3(0.42, 0.49, 0.55);
  }
  if (s == 83) {
    // THE SHOTGUN. One room wide — a door, one window, a gable, and the whole
    // house running back off the street. The narrowness IS the type.
    colW = 4.2; win = vec2(0.30, 0.58);
    wall = mix(vec3(0.660, 0.630, 0.575), vec3(0.560, 0.520, 0.470), step(0.5, vVar));
    glassA = vec3(0.26, 0.31, 0.35); glassB = vec3(0.40, 0.47, 0.52);
  }
  if (s == 84) {
    // DUTCH COLONIAL. The gambrel comes down over the wall head with a flared
    // eave, so the top storey is roof rather than wall and the house looks
    // like it is wearing it.
    colW = 3.0; win = vec2(0.42, 0.54);
    wall = mix(vec3(0.680, 0.660, 0.615), vec3(0.585, 0.540, 0.485), step(0.5, vVar));
    glassA = vec3(0.27, 0.32, 0.36); glassB = vec3(0.42, 0.49, 0.54);
  }
  if (s == 85) {
    // THE FOURSQUARE. A cube: four rooms up, four down, a hipped roof with one
    // big dormer in it and a porch across the whole front. Utterly regular.
    colW = 3.4; win = vec2(0.42, 0.56);
    wall = mix(vec3(0.615, 0.475, 0.390), vec3(0.640, 0.615, 0.560), step(0.55, vVar));
    glassA = vec3(0.27, 0.32, 0.37); glassB = vec3(0.42, 0.50, 0.55);
  }
  if (s == 86) {
    // THE BUNGALOW. Deep eaves carried on exposed rafter tails, and porch piers
    // that TAPER — battered, wide at the base. Low, wide, and horizontal.
    colW = 3.8; win = vec2(0.48, 0.48);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.34)      { wall = vec3(0.510, 0.450, 0.360); }  // stained shingle
    else if (pk < 0.62) { wall = vec3(0.570, 0.520, 0.430); }  // olive
    else                { wall = vec3(0.620, 0.560, 0.480); }  // tan
    glassA = vec3(0.28, 0.33, 0.37); glassB = vec3(0.43, 0.50, 0.55);
  }
  if (s == 87) {
    // THE SRO. One room, one man, one bulb — so a hundred identical tiny
    // windows in a tight grid, and nothing else on the wall at all. The
    // FREQUENCY is the fact: these openings are half the size of a flat's.
    colW = 1.95; win = vec2(0.40, 0.44);
    wall = mix(vec3(0.545, 0.455, 0.400), vec3(0.590, 0.560, 0.520), step(0.5, vVar));
    glassA = vec3(0.24, 0.28, 0.32); glassB = vec3(0.37, 0.43, 0.48);
  }
  if (s == 88) {
    // THE ORIEL. A bay window carried the FULL HEIGHT of the front, standing
    // proud of the wall — the one move that gives a flat facade a shadow line
    // from top to bottom.
    colW = 3.3; win = vec2(0.46, 0.62);
    wall = mix(vec3(0.545, 0.435, 0.360), vec3(0.630, 0.590, 0.530), step(0.55, vVar));
    glassA = vec3(0.27, 0.32, 0.37); glassB = vec3(0.42, 0.49, 0.55);
  }
  if (s == 89) {
    // THE TWO-FLAT. A raised basement, so the front door is up a short flight;
    // a bowed bay running the height; a flat roof and a parapet. Two doors
    // side by side is the giveaway and the bay is what you see.
    colW = 3.6; win = vec2(0.46, 0.58);
    wall = mix(vec3(0.575, 0.420, 0.345), vec3(0.620, 0.585, 0.530), step(0.55, vVar));
    glassA = vec3(0.26, 0.31, 0.36); glassB = vec3(0.41, 0.48, 0.54);
  }
  if (s == 90) {
    // THE RANCH. Long, low, and horizontal: a picture window at one end, the
    // garage door on the front, and a shallow roof over the lot.
    colW = 5.0; win = vec2(0.56, 0.40);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.30)      { wall = vec3(0.640, 0.600, 0.535); }
    else if (pk < 0.58) { wall = vec3(0.585, 0.450, 0.375); }
    else if (pk < 0.80) { wall = vec3(0.520, 0.545, 0.510); }
    else                { wall = vec3(0.680, 0.665, 0.630); }
    glassA = vec3(0.30, 0.35, 0.40); glassB = vec3(0.46, 0.54, 0.59);
  }
  if (s == 91) {
    // THE GARDEN APARTMENT. Two or three storeys round a lawn, with the stairs
    // OUTSIDE in open breezeways — a dark slot cut clean through the block
    // every few bays, which no other housing type has.
    colW = 3.5; win = vec2(0.48, 0.52);
    wall = mix(vec3(0.605, 0.470, 0.395), vec3(0.660, 0.630, 0.575), step(0.55, vVar));
    glassA = vec3(0.26, 0.31, 0.36); glassB = vec3(0.41, 0.48, 0.53);
  }
  if (s == 92) {
    // THE MANSION BLOCK. The same window ninety times over, in good stone,
    // with a porte-cochere cut into the middle of the base for a carriage.
    colW = 3.1; win = vec2(0.42, 0.64);
    wall = mix(vec3(0.700, 0.665, 0.600), vec3(0.605, 0.485, 0.410), step(0.6, vVar));
    glassA = vec3(0.25, 0.30, 0.35); glassB = vec3(0.40, 0.47, 0.53);
  }
  if (s == 93) {
    // BACK-TO-BACK. The cheapest terrace ever built: one room per floor, one
    // window per room, a shared wall on three sides. Tiny openings, tight
    // rhythm, soot, and a chimney stack every two houses.
    colW = 2.5; win = vec2(0.36, 0.46);
    wall = mix(vec3(0.470, 0.360, 0.315), vec3(0.520, 0.470, 0.440), step(0.5, vVar));
    glassA = vec3(0.23, 0.27, 0.31); glassB = vec3(0.36, 0.42, 0.47);
  }
  if (s == 75) {
    // TILT-UP. The wall was cast flat on the slab and stood up by crane, so it
    // arrives in panels about seven metres wide with a joint down every one of
    // them and a shallow reveal band cast into the face. Painted, always, and
    // in whatever the tenant's colour was that decade.
    colW = 7.0; win = vec2(0.20, 0.22);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.28)      { wall = vec3(0.700, 0.695, 0.675); }  // off-white
    else if (pk < 0.50) { wall = vec3(0.640, 0.650, 0.645); }  // pale grey-green
    else if (pk < 0.68) { wall = vec3(0.660, 0.620, 0.560); }  // sand
    else if (pk < 0.84) { wall = vec3(0.560, 0.580, 0.605); }  // blue-grey
    else                { wall = vec3(0.605, 0.575, 0.560); }  // warm grey
    glassA = vec3(0.26, 0.32, 0.37); glassB = vec3(0.40, 0.49, 0.55);
  }
  if (s == 76) {
    // THE BIG SHED. A quarter of a mile of wall with a dock door every nine
    // metres and nothing else on it — no windows, because there is nothing to
    // look at and nobody to look. Scale is the whole identification.
    colW = 9.0; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.680, 0.680, 0.665), vec3(0.615, 0.630, 0.640), step(0.5, vVar));
    glassA = vec3(0.22, 0.24, 0.26); glassB = vec3(0.33, 0.37, 0.40);
  }
  if (s == 77) {
    // FLEX. A glazed office corner bolted onto a metal warehouse — two
    // completely different buildings sharing a slab, which is exactly what a
    // business park is.
    glassy = true; colW = 3.2; win = vec2(0.72, 0.56);
    wall = mix(vec3(0.610, 0.625, 0.630), vec3(0.660, 0.640, 0.600), step(0.5, vVar));
    glassA = vec3(0.32, 0.42, 0.48); glassB = vec3(0.50, 0.62, 0.68);
  }
  if (s == 78) {
    // THE QUONSET. A corrugated half-cylinder — no walls at all, strictly, and
    // the end is mostly door. The curve is drawn by the shading below.
    colW = 4.0; win = vec2(0.24, 0.26);
    wall = mix(vec3(0.605, 0.615, 0.605), vec3(0.545, 0.520, 0.480), step(0.6, vVar));
    glassA = vec3(0.26, 0.29, 0.31); glassB = vec3(0.39, 0.44, 0.47);
  }
  if (s == 79) {
    // CROSS-DOCK. Doors down BOTH long sides so a trailer backs in one side
    // and out the other, with a canopy over each run. Very long, very thin.
    colW = 4.4; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.655, 0.660, 0.650), vec3(0.590, 0.600, 0.615), step(0.5, vVar));
    glassA = vec3(0.20, 0.22, 0.24); glassB = vec3(0.30, 0.34, 0.37);
  }
  if (s == 80) {
    // SELF STORAGE. Rank upon rank of roller doors, all identical, under one
    // bright band of the operator's colour. The repetition is the building.
    colW = 3.0; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.690, 0.670, 0.630), vec3(0.640, 0.635, 0.620), step(0.5, vVar));
    glassA = vec3(0.24, 0.26, 0.28); glassB = vec3(0.36, 0.40, 0.43);
  }
  if (s == 81) {
    // THE DATA CENTRE. A blind box with banks of louvres where the air goes in
    // and out, and not one window anywhere — a building designed for machines
    // that reads, correctly, as having nobody in it.
    colW = 5.2; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.555, 0.565, 0.580), vec3(0.610, 0.605, 0.595), step(0.5, vVar));
    glassA = vec3(0.22, 0.25, 0.28); glassB = vec3(0.33, 0.38, 0.42);
  }
  if (s == 61) {
    // QUEEN ANNE. Shingle above, clapboard below, in two colours that were
    // chosen to be different — the "painted lady" is not a myth, it is what
    // the paint catalogues of the 1890s sold. Busy, and proud of it.
    colW = 2.6; win = vec2(0.44, 0.62);
    float pk = clamp(vVar, 0.0, 0.999);
    if (pk < 0.20)      { wall = vec3(0.560, 0.395, 0.335); }  // barn red
    else if (pk < 0.40) { wall = vec3(0.470, 0.480, 0.420); }  // sage
    else if (pk < 0.58) { wall = vec3(0.630, 0.575, 0.455); }  // buff
    else if (pk < 0.76) { wall = vec3(0.395, 0.430, 0.480); }  // slate blue
    else                { wall = vec3(0.700, 0.680, 0.630); }  // cream
    glassA = vec3(0.28, 0.33, 0.38); glassB = vec3(0.44, 0.51, 0.57);
  }
  if (s == 62) {
    // STICK STYLE. The framing is laid ON the wall as flat boards in a contrast
    // colour, so the house wears a diagram of its own structure.
    colW = 2.9; win = vec2(0.42, 0.60);
    wall = mix(vec3(0.610, 0.560, 0.475), vec3(0.520, 0.475, 0.430), step(0.5, vVar));
    glassA = vec3(0.27, 0.32, 0.37); glassB = vec3(0.42, 0.49, 0.55);
  }
  if (s == 63) {
    // TUDOR REVIVAL. Render below, half-timbering above — and only above,
    // because that is what makes it read: the upper floor is patterned and the
    // lower one is not.
    colW = 3.1; win = vec2(0.46, 0.56);
    wall = mix(vec3(0.700, 0.675, 0.615), vec3(0.640, 0.610, 0.550), step(0.5, vVar));
    glassA = vec3(0.26, 0.31, 0.36); glassB = vec3(0.41, 0.48, 0.54);
  }
  if (s == 64) {
    // MISSION REVIVAL. Smooth stucco, a shaped curved parapet, and a little
    // tiled pent roof running over the openings.
    colW = 3.6; win = vec2(0.40, 0.60);
    wall = mix(vec3(0.720, 0.665, 0.575), vec3(0.680, 0.640, 0.580), step(0.5, vVar));
    glassA = vec3(0.25, 0.29, 0.34); glassB = vec3(0.39, 0.46, 0.52);
  }
  if (s == 65) {
    // THE PICTURE PALACE. The auditorium has no windows at all, so the whole
    // building is a blind box with a marquee across the bottom of it and a
    // vertical blade sign up the corner. The blankness IS the type.
    colW = 6.0; win = vec2(0.10, 0.12);
    if (vVar < 0.4)      { wall = vec3(0.640, 0.545, 0.430); }
    else if (vVar < 0.75){ wall = vec3(0.560, 0.470, 0.455); }
    else                 { wall = vec3(0.690, 0.660, 0.600); }
    glassA = vec3(0.24, 0.27, 0.31); glassB = vec3(0.36, 0.42, 0.47);
  }
  if (s == 66) {
    // THE DINER. A stainless railcar: horizontal flutes the whole length, a
    // continuous band of glass, and a rounded end. Small, shiny, unmistakable.
    glassy = true; colW = 1.5; win = vec2(0.92, 0.42);
    wall = mix(vec3(0.700, 0.710, 0.715), vec3(0.620, 0.640, 0.655), step(0.5, vVar));
    glassA = vec3(0.44, 0.52, 0.56); glassB = vec3(0.64, 0.74, 0.78);
  }
  if (s == 67) {
    // THE FIREHOUSE. Apparatus doors are most of the ground floor because an
    // engine has to get out, and they are arched on the old ones. Everything
    // above is domestic in scale — it is where the crew lived.
    colW = 4.5; win = vec2(0.44, 0.58);
    wall = mix(vec3(0.560, 0.345, 0.290), vec3(0.610, 0.520, 0.440), step(0.55, vVar));
    glassA = vec3(0.25, 0.30, 0.35); glassB = vec3(0.40, 0.47, 0.53);
  }
  if (s == 68) {
    // THE SCHOOL. Windows in banks of three, floor to near-ceiling, because a
    // classroom needs daylight from one side — the most regular facade in any
    // town, with one raised entrance bay in the middle of it.
    colW = 5.4; win = vec2(0.74, 0.66);
    wall = mix(vec3(0.605, 0.430, 0.350), vec3(0.680, 0.640, 0.565), step(0.5, vVar));
    glassA = vec3(0.28, 0.34, 0.39); glassB = vec3(0.44, 0.52, 0.58);
  }
  if (s == 69) {
    // THE LIBRARY. A blind plinth — the stacks are behind it and books hate
    // daylight — with tall arched reading-room windows over it, and a portico.
    colW = 4.2; win = vec2(0.44, 0.72);
    wall = mix(vec3(0.735, 0.705, 0.640), vec3(0.680, 0.660, 0.615), step(0.5, vVar));
    glassA = vec3(0.23, 0.28, 0.33); glassB = vec3(0.37, 0.44, 0.50);
  }
  if (s == 70) {
    // THE BANK. A giant order across the front and NOTHING at street level —
    // a bank does not put its money behind a shop window. Two storeys of blind
    // ashlar, then the columns, then a heavy entablature.
    colW = 4.8; win = vec2(0.30, 0.62);
    wall = mix(vec3(0.760, 0.740, 0.690), vec3(0.700, 0.685, 0.650), step(0.5, vVar));
    glassA = vec3(0.20, 0.25, 0.30); glassB = vec3(0.33, 0.40, 0.46);
  }
  if (s == 71) {
    // THE HOTEL. Three parts and a canopy: rusticated base, a banded middle of
    // identical bedroom windows, a heavy cornice. The regularity of the middle
    // is the tell — every room is the same room.
    colW = 3.0; win = vec2(0.44, 0.62);
    wall = mix(vec3(0.680, 0.620, 0.535), vec3(0.615, 0.505, 0.425), step(0.55, vVar));
    glassA = vec3(0.26, 0.31, 0.36); glassB = vec3(0.41, 0.48, 0.54);
  }
  if (s == 72) {
    // THE DEPARTMENT STORE. Continuous display glazing floor after floor,
    // because the whole building is a shop window. Almost no wall left.
    glassy = true; colW = 5.6; win = vec2(0.88, 0.76);
    wall = mix(vec3(0.700, 0.665, 0.590), vec3(0.630, 0.600, 0.555), step(0.5, vVar));
    glassA = vec3(0.32, 0.38, 0.43); glassB = vec3(0.50, 0.58, 0.64);
  }
  if (s == 73) {
    // THE MOTEL. Every door opens onto an outdoor walkway with a rail — the
    // building is a corridor turned inside out, and you can see it from the road.
    colW = 3.4; win = vec2(0.50, 0.52);
    wall = mix(vec3(0.720, 0.680, 0.615), vec3(0.660, 0.615, 0.560), step(0.5, vVar));
    glassA = vec3(0.24, 0.28, 0.32); glassB = vec3(0.38, 0.44, 0.49);
  }
  if (s == 74) {
    // THE STRIP. A deep canopy over continuous glazing with a sign band above
    // it, running the length of the row — one building pretending to be six.
    colW = 6.4; win = vec2(0.86, 0.44);
    wall = mix(vec3(0.700, 0.660, 0.600), vec3(0.640, 0.615, 0.590), step(0.5, vVar));
    glassA = vec3(0.30, 0.35, 0.40); glassB = vec3(0.46, 0.54, 0.60);
  }
  if (s == 51) {
    // THE GENERATING STATION. One enormous room with turbines in it, so the
    // openings are the height of the whole building rather than the height of
    // a floor — a bay four storeys tall, arched, in engineering brick. Nothing
    // else in a city has that proportion and it reads from anywhere.
    colW = 7.4; win = vec2(0.56, 0.86);
    wall = mix(vec3(0.470, 0.330, 0.270), vec3(0.560, 0.470, 0.400), step(0.5, vVar));
    glassA = vec3(0.22, 0.27, 0.31); glassB = vec3(0.36, 0.44, 0.50);
  }
  if (s == 52) {
    // THE COLD STORE. Insulation means no windows: a blank brick cliff with a
    // stack of loading doors down one bay and a handful of tiny openings where
    // somebody has to see out. The blankness is the building.
    colW = 4.6; win = vec2(0.16, 0.14);
    wall = mix(vec3(0.545, 0.430, 0.380), vec3(0.610, 0.560, 0.505), step(0.6, vVar));
    glassA = vec3(0.20, 0.22, 0.24); glassB = vec3(0.30, 0.34, 0.37);
  }
  if (s == 53) {
    // THE BREWERY. Segmental-arched brick, a tall stair-and-liquor tower, and
    // the good ones got a cornice — a brewery was a proud building in a way a
    // warehouse never was, and it is usually the best brickwork in the district.
    colW = 3.6; win = vec2(0.44, 0.66);
    wall = mix(vec3(0.520, 0.330, 0.270), vec3(0.590, 0.420, 0.330), step(0.5, vVar));
    glassA = vec3(0.24, 0.28, 0.33); glassB = vec3(0.38, 0.45, 0.51);
  }
  if (s == 54) {
    // THE FOUNDRY. Steel sash from waist height to the roof because the work
    // needs light and the walls carry nothing, and a century of carbon on top
    // of it. Almost all glazing, and almost all of it filthy.
    colW = 4.0; win = vec2(0.82, 0.74);
    wall = mix(vec3(0.415, 0.400, 0.375), vec3(0.480, 0.455, 0.420), step(0.5, vVar));
    glassA = vec3(0.30, 0.33, 0.32); glassB = vec3(0.44, 0.48, 0.46);
  }
  if (s == 55) {
    // THE GRAIN ELEVATOR. Slip-formed concrete drums with no openings at all —
    // the one industrial building taller than the district round it, and it is
    // not clad, it is POURED. The drum lines are the whole facade.
    colW = 6.5; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.660, 0.650, 0.620), vec3(0.590, 0.580, 0.560), step(0.5, vVar));
    glassA = wall; glassB = wall;
  }
  if (s == 56) {
    // THE GASHOLDER. A lattice guide frame standing round a drum that rises
    // and falls with the gas in it — so what you see is mostly SKY, crossed by
    // ironwork, with the tank sitting somewhere inside.
    colW = 3.0; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.430, 0.415, 0.385), vec3(0.360, 0.370, 0.375), step(0.5, vVar));
    glassA = wall; glassB = wall;
  }
  if (s == 57) {
    // THE FABRICATION SHED. A portal frame with a crane rail down it and doors
    // big enough to take a hull out — profiled steel above, and the door is
    // most of the gable end.
    colW = 5.5; win = vec2(0.30, 0.20);
    wall = mix(vec3(0.545, 0.560, 0.545), vec3(0.470, 0.490, 0.505), step(0.5, vVar));
    glassA = vec3(0.28, 0.32, 0.34); glassB = vec3(0.42, 0.47, 0.49);
  }
  if (s == 58) {
    // THE MULTI-STOREY MILL. Bay after identical bay for a hundred metres,
    // because the frame is a grid and the machines sat on it — plus the stair
    // tower, which is the only thing that breaks the rhythm.
    colW = 3.25; win = vec2(0.62, 0.68);
    wall = mix(vec3(0.560, 0.395, 0.320), vec3(0.505, 0.440, 0.390), step(0.5, vVar));
    glassA = vec3(0.28, 0.33, 0.37); glassB = vec3(0.43, 0.50, 0.55);
  }
  if (s == 59) {
    // THE DEPOT. A long low building whose front is a platform canopy on iron
    // columns — so at street level it is mostly a colonnade with a deep shade
    // behind it, and the building proper starts well back.
    colW = 4.4; win = vec2(0.52, 0.56);
    wall = mix(vec3(0.590, 0.480, 0.400), vec3(0.640, 0.605, 0.545), step(0.5, vVar));
    glassA = vec3(0.26, 0.31, 0.36); glassB = vec3(0.40, 0.48, 0.54);
  }
  if (s == 60) {
    // THE PUMP HOUSE. A little brick temple built round one machine, with a
    // single arched window nearly the height of the wall — Victorian engineers
    // dressed their machinery, and this is the smallest example of it.
    colW = 5.0; win = vec2(0.46, 0.78);
    wall = mix(vec3(0.545, 0.375, 0.310), vec3(0.610, 0.545, 0.470), step(0.5, vVar));
    glassA = vec3(0.24, 0.29, 0.34); glassB = vec3(0.38, 0.46, 0.52);
  }
  if (s == 46) {
    // TERRACOTTA / BRONZE PIERS. The pier runs the whole height without a
    // single horizontal interruption and the glass is a slot behind it. That
    // unbroken vertical is why One Vanderbilt reads as one object from a mile
    // away while a 1980s tower reads as a stack of floors.
    glassy = true; colW = 2.35; win = vec2(0.62, 0.965);
    if (vVar < 0.34)      { wall = vec3(0.545, 0.400, 0.290); }  // warm terracotta
    else if (vVar < 0.62) { wall = vec3(0.470, 0.370, 0.255); }  // bronze anodise
    else if (vVar < 0.84) { wall = vec3(0.610, 0.560, 0.480); }  // pale stone pier
    else                  { wall = vec3(0.330, 0.300, 0.280); }  // dark bronze
    glassA = vec3(0.34, 0.44, 0.50); glassB = vec3(0.56, 0.68, 0.74);
  }
  if (s == 47) {
    // FRAMES PUNCHED HALF A METRE DEEP. The wall is mostly its own shadow, and
    // which half of each frame is dark tells you where the sun is — the one
    // modern facade that changes across the day the way masonry does.
    colW = 3.15; win = vec2(0.70, 0.72);
    if (vVar < 0.40)      { wall = vec3(0.625, 0.615, 0.590); }  // grey precast
    else if (vVar < 0.72) { wall = vec3(0.560, 0.530, 0.480); }  // warm precast
    else                  { wall = vec3(0.470, 0.475, 0.485); }  // dark metal
    glassA = vec3(0.26, 0.33, 0.39); glassB = vec3(0.42, 0.52, 0.60);
  }
  if (s == 48) {
    // THE STEEL WORN OUTSIDE. A painted shelf at every floor standing well
    // proud of the glass and throwing a hard shadow band across the whole
    // face: 425 Park is a glass building you read entirely as horizontal.
    glassy = true; colW = 3.05; win = vec2(0.90, 0.80);
    wall = mix(vec3(0.735, 0.730, 0.715), vec3(0.400, 0.405, 0.415), step(0.62, vVar));
    glassA = vec3(0.36, 0.47, 0.53); glassB = vec3(0.58, 0.70, 0.76);
  }
  if (s == 49) {
    // THE CONTEMPORARY UNITISED WALL. Nearly frameless, but not a mirror: a
    // mullion every 1.5 m and a tint that shifts panel to panel because the
    // units were coated in batches. That fine rhythm is what makes a modern
    // tower read as FABRIC rather than as a sheet of reflection.
    glassy = true; colW = 1.52; win = vec2(0.955, 0.945);
    if (vVar < 0.30)      { glassA = vec3(0.46, 0.60, 0.66); glassB = vec3(0.66, 0.78, 0.79); wall = vec3(0.36, 0.47, 0.52); }
    else if (vVar < 0.56) { glassA = vec3(0.42, 0.53, 0.60); glassB = vec3(0.62, 0.72, 0.78); wall = vec3(0.33, 0.42, 0.48); }
    else if (vVar < 0.80) { glassA = vec3(0.48, 0.58, 0.56); glassB = vec3(0.68, 0.76, 0.74); wall = vec3(0.38, 0.46, 0.45); }
    else                  { glassA = vec3(0.36, 0.42, 0.50); glassB = vec3(0.56, 0.64, 0.72); wall = vec3(0.29, 0.34, 0.40); }
  }
  if (s == 50) {
    // MEGA PANELS. A unit two storeys tall, with the slab edge between them
    // expressed as a deep shadow box — so the building is banded at HALF the
    // frequency of its own floors, a proportion nothing older here has.
    glassy = true; colW = 2.9; win = vec2(0.93, 0.885);
    wall = mix(vec3(0.335, 0.350, 0.375), vec3(0.500, 0.505, 0.510), step(0.55, vVar));
    glassA = vec3(0.40, 0.52, 0.58); glassB = vec3(0.62, 0.74, 0.79);
  }
  if (s == 139) {
    // THE ANCHOR. A blank box the size of a city block with ONE portal cut
    // into it — there are no windows because every square foot of wall is
    // shelving on the other side.
    colW = 9.0; win = vec2(0.0, 0.0);
    wall = mix(vec3(0.680, 0.640, 0.585), vec3(0.610, 0.600, 0.590), step(0.55, vVar));
    glassA = wall; glassB = wall;
  }
  if (s == 140) {
    // THE LIFESTYLE CENTRE. One building pretending to be eight: the fascia
    // changes height, colour and material every few bays, and none of the
    // changes correspond to anything behind them.
    colW = 4.2; win = vec2(0.72, 0.60);
    wall = mix(vec3(0.640, 0.520, 0.430), vec3(0.680, 0.655, 0.600), step(0.5, vVar));
    glassA = vec3(0.30, 0.37, 0.43); glassB = vec3(0.48, 0.58, 0.64);
  }
  if (s == 141) {
    // THE INLINE RUN. Blank above, glass below, and a deep canopy between —
    // the upper wall exists only to carry signs.
    colW = 7.0; win = vec2(0.86, 0.30);
    wall = mix(vec3(0.660, 0.640, 0.600), vec3(0.585, 0.590, 0.585), step(0.55, vVar));
    glassA = vec3(0.28, 0.34, 0.40); glassB = vec3(0.44, 0.53, 0.60);
  }
  if (s == 142) {
    // JUNIOR BOX. A gable parapet in the middle of a flat one, and a single
    // band of the chain's colour under it. That gable is the whole design.
    colW = 8.0; win = vec2(0.30, 0.26);
    wall = mix(vec3(0.700, 0.670, 0.615), vec3(0.620, 0.615, 0.600), step(0.55, vVar));
    glassA = vec3(0.28, 0.34, 0.40); glassB = vec3(0.44, 0.52, 0.58);
  }
  if (s == 143) {
    // AUTO PARTS. Split-face block below, a bright band above, and the band is
    // always the same colour because the chain owns it.
    colW = 5.0; win = vec2(0.34, 0.30);
    wall = mix(vec3(0.640, 0.630, 0.610), vec3(0.590, 0.575, 0.550), step(0.55, vVar));
    glassA = vec3(0.26, 0.32, 0.37); glassB = vec3(0.42, 0.50, 0.56);
  }
  if (s == 144) {
    // FAST FOOD. Small, low, a canopy over the door and a drive lane wrapping
    // one end — the building is mostly roof and the roof is mostly overhang.
    colW = 3.6; win = vec2(0.62, 0.46);
    wall = mix(vec3(0.660, 0.605, 0.520), vec3(0.545, 0.470, 0.430), step(0.55, vVar));
    glassA = vec3(0.32, 0.38, 0.44); glassB = vec3(0.50, 0.59, 0.65);
  }
  if (s == 145) {
    // THE BRANCH. A brick pavilion trying to look like a small bank temple,
    // with a drive-up canopy on a limb off one side.
    colW = 3.9; win = vec2(0.40, 0.56);
    wall = mix(vec3(0.600, 0.440, 0.370), vec3(0.680, 0.655, 0.610), step(0.6, vVar));
    glassA = vec3(0.26, 0.32, 0.38); glassB = vec3(0.42, 0.50, 0.57);
  }
  if (s == 146) {
    // THE PHARMACY. Brick, and a ROTUNDA on the corner — because the corner is
    // the door, and every one of these was built to the same drawing.
    colW = 4.4; win = vec2(0.44, 0.48);
    wall = mix(vec3(0.615, 0.430, 0.355), vec3(0.660, 0.620, 0.560), step(0.6, vVar));
    glassA = vec3(0.28, 0.34, 0.40); glassB = vec3(0.44, 0.53, 0.59);
  }
  if (s == 147) {
    // THE GROCERY ANCHOR. An arcade the length of the front under one very big
    // gable, with the cart bays notched into it.
    colW = 5.6; win = vec2(0.70, 0.48);
    wall = mix(vec3(0.690, 0.655, 0.590), vec3(0.605, 0.505, 0.435), step(0.55, vVar));
    glassA = vec3(0.30, 0.36, 0.42); glassB = vec3(0.46, 0.55, 0.62);
  }
  if (s == 148) {
    // THE RESTAURANT. A roof that changes height three times across one small
    // building, awnings on every opening, and a low patio wall in front.
    colW = 3.4; win = vec2(0.58, 0.54);
    wall = mix(vec3(0.575, 0.445, 0.380), vec3(0.640, 0.610, 0.555), step(0.5, vVar));
    glassA = vec3(0.30, 0.36, 0.42); glassB = vec3(0.47, 0.56, 0.62);
  }
  if (s == 149) {
    // THE SHOWROOM. Full-height glass, because the STOCK is the display — no
    // spandrel, no sill, nothing between the pavement and the merchandise.
    glassy = true; colW = 5.2; win = vec2(0.92, 0.88);
    wall = mix(vec3(0.560, 0.570, 0.580), vec3(0.500, 0.490, 0.480), step(0.55, vVar));
    glassA = vec3(0.40, 0.50, 0.56); glassB = vec3(0.62, 0.74, 0.79);
  }
  if (s == 150) {
    // THE OUTLET. A covered walkway the entire length, on posts, with a gable
    // over every second unit — a strip mall with a colonnade bolted on.
    colW = 4.8; win = vec2(0.66, 0.50);
    wall = mix(vec3(0.680, 0.640, 0.575), vec3(0.615, 0.560, 0.500), step(0.55, vVar));
    glassA = vec3(0.29, 0.35, 0.41); glassB = vec3(0.45, 0.54, 0.60);
  }
  if (s == 151) {
    // URBAN CORNER RETAIL. Glazed right down to the pavement under a deep
    // canopy, with the residential floors above it a different material —
    // two buildings stacked, and the seam between them is the point.
    glassy = true; colW = 4.0; win = vec2(0.86, 0.66);
    wall = mix(vec3(0.545, 0.450, 0.395), vec3(0.590, 0.585, 0.570), step(0.55, vVar));
    glassA = vec3(0.32, 0.40, 0.46); glassB = vec3(0.50, 0.60, 0.67);
  }
  if (s == 8) { wall = vec3(0.60, 0.56, 0.48); glassA = wall; glassB = wall; colW = 100.0; win = vec2(0.0); }
  if (s == 10) { wall = vec3(0.58, 0.55, 0.50); glassA = wall; glassB = wall; colW = 100.0; win = vec2(0.0); }


  wall *= 0.90 + 0.20 * vRand;

  // ---- window grid with analytic AA --------------------------------------
  float fh = max(vFh, 2.6);
  // The wall's own tangent frame: T runs along the facade, Z is up. Everything
  // that gives a window depth — parallax, jamb shading, the sun's angle across
  // the opening — is computed in this frame.
  vec3 T = normalize(cross(vec3(0.0, 0.0, 1.0), n));
  vec3 Vw = normalize(uCam - vPos);
  float facing = max(dot(n, Vw), 0.18);
  // reveal depth: masonry punches deep openings, curtain wall is nearly flush
  // A frameless curtain wall is a sheet of glass hung in front of the slab —
  // there is barely a reveal at all — while a granite postmodern tower punches
  // its openings almost as deep as pre-war masonry does.
  // HOW FAR BACK THE GLASS SITS is one of the strongest cues there is: it
  // decides how much of the opening is in shadow, and therefore whether a wall
  // reads as a thin skin hung off a frame or as a thick thing with holes cut
  // in it. A brutalist slot is half a metre deep; a mirror-glass unit is
  // flush enough to be a mirror.
  // HOW FAR BACK THE GLASS SITS. Was one nested ternary per family and grew
  // to forty levels, which is what tipped the GLSL compiler into
  // "expression too complex" — a real limit, and it fails at COMPILE time so
  // the whole layer goes black rather than one building looking wrong. A
  // chain of assignments costs the same and has no depth at all.
  float revealM = 0.30;
  if (s == 49) revealM = 0.028;
  if (s == 135) revealM = 0.030;
  if (s == 127 || s == 130) revealM = 0.055;
  if (s == 138) revealM = 0.09;
  if (s == 134) revealM = 0.12;
  if (s == 133) revealM = 0.20;
  if (s == 126 || s == 131 || s == 136) revealM = 0.26;
  if (s == 128) revealM = 0.28;
  if (s == 129 || s == 132) revealM = 0.34;
  if (s == 137) revealM = 0.44;
  if (s == 149 || s == 151) revealM = 0.05;
  if (s == 139 || s == 141 || s == 142) revealM = 0.10;
  if (s == 140 || s == 150) revealM = 0.16;
  if (s == 143 || s == 144) revealM = 0.20;
  if (s == 147) revealM = 0.24;
  if (s == 148) revealM = 0.26;
  if (s == 145 || s == 146) revealM = 0.30;
  if (s == 113 || s == 117 || s == 119) revealM = 0.030;
  if (s == 114 || s == 115) revealM = 0.040;
  if (s == 112 || s == 116 || s == 125) revealM = 0.075;
  if (s == 121) revealM = 0.10;
  if (s == 122) revealM = 0.16;
  if (s == 118 || s == 120) revealM = 0.20;
  if (s == 123) revealM = 0.26;
  if (s == 124) revealM = 0.52;
  if (s == 106) revealM = 0.06;
  if (s == 107) revealM = 0.90;
  if (s == 108) revealM = 0.50;
  if (s == 111) revealM = 0.45;
  if (s == 105) revealM = 0.45;
  if (s == 109) revealM = 0.55;
  if (s == 104) revealM = 0.55;
  if (s == 95) revealM = 0.09;
  if (s == 97 || s == 101) revealM = 0.30;
  if (s == 102) revealM = 0.36;
  if (s == 96) revealM = 0.38;
  if (s == 100) revealM = 0.40;
  if (s == 103) revealM = 0.42;
  if (s == 94) revealM = 0.55;
  if (s == 98) revealM = 0.65;
  if (s == 99) revealM = 0.70;
  if (s == 90) revealM = 0.14;
  if (s == 82 || s == 83 || s == 84 || s == 85 || s == 86) revealM = 0.20;
  if (s == 91) revealM = 0.24;
  if (s == 87 || s == 93) revealM = 0.28;
  if (s == 88 || s == 89) revealM = 0.32;
  if (s == 92) revealM = 0.38;
  if (s == 78) revealM = 0.05;
  if (s == 76 || s == 79 || s == 80) revealM = 0.10;
  if (s == 77) revealM = 0.12;
  if (s == 75) revealM = 0.16;
  if (s == 81) revealM = 0.34;
  if (s == 66) revealM = 0.045;
  if (s == 72 || s == 74) revealM = 0.09;
  if (s == 65 || s == 73) revealM = 0.20;
  if (s == 61 || s == 62 || s == 63 || s == 64) revealM = 0.22;
  if (s == 71 || s == 68 || s == 67) revealM = 0.30;
  if (s == 69) revealM = 0.40;
  if (s == 70) revealM = 0.46;
  if (s == 55 || s == 56 || s == 57) revealM = 0.06;
  if (s == 54) revealM = 0.13;
  if (s == 58 || s == 52) revealM = 0.30;
  if (s == 53) revealM = 0.34;
  if (s == 59) revealM = 0.36;
  if (s == 51 || s == 60) revealM = 0.44;
  if (s == 35 || s == 42) revealM = 0.030;
  if (s == 50) revealM = 0.055;
  if (s == 48) revealM = 0.075;
  if (s == 46) revealM = 0.34;
  if (s == 47) revealM = 0.52;
  if (s == 15 || s == 16) revealM = 0.045;
  if (s == 36 || s == 45) revealM = 0.055;
  if (s == 44) revealM = 0.065;
  if (s == 32) revealM = 0.090;
  if (s == 0 || s == 7) revealM = 0.10;
  if (s == 28 || s == 41) revealM = 0.125;
  if (s == 18) revealM = 0.14;
  if (s == 4) revealM = 0.16;
  if (s == 38) revealM = 0.20;
  if (s == 43) revealM = 0.22;
  if (s == 17 || s == 40 || s == 37) revealM = 0.26;
  if (s == 26 || s == 27) revealM = 0.28;
  if (s == 20 || s == 21 || s == 31) revealM = 0.34;
  if (s == 19) revealM = 0.42;
  if (s == 29) revealM = 0.46;
  if (s == 33) revealM = 0.50;
  if (s == 34) revealM = 0.56;

  float u = vU / colW;
  float v = vZ / fh;
  // how many pixels a floor spans: everything expensive below is skipped once
  // the facade is too small on screen for it to read
  float lod = clamp(max(fwidth(u), fwidth(v)) * 2.6 - 0.3, 0.0, 1.0);
  float near = 1.0 - lod;
  // parallax: shift the opening against the view so glass sits behind the wall
  float par = revealM * near / facing;
  u -= (dot(Vw, T) * par) / colW;
  v -= (dot(Vw, vec3(0.0, 0.0, 1.0)) * par) / fh;
  vec2 f = vec2(fract(u), fract(v));
  vec2 m = (1.0 - win) * 0.5;
  float aaX = fwidth(f.x) * 0.9 + 1e-4;
  float aaY = fwidth(f.y) * 0.9 + 1e-4;
  float wx = smoothstep(m.x - aaX, m.x + aaX, f.x) * (1.0 - smoothstep(1.0 - m.x - aaX, 1.0 - m.x + aaX, f.x));
  float wy = smoothstep(m.y + 0.04 - aaY, m.y + 0.04 + aaY, f.y) * (1.0 - smoothstep(1.0 - m.y - aaY, 1.0 - m.y + aaY, f.y));
  float winMask = wx * wy;

  if (vZ > vTop - 1.0) winMask = 0.0; // parapet

  // pre-war character: darker stone base and a cornice shadow line
  if (s == 1 || s == 6) {
    if (vZ < fh * 2.0 && vZ > fh * 1.15) wall *= 0.88;
    if (vZ > vTop - 2.3 && vZ < vTop - 1.0) wall *= 0.82;
  }

  // ---- ARCHITECTURE, not just colour --------------------------------------
  // Three details that carry almost all of the character of nineteenth and
  // early twentieth century masonry, and that the fabric had none of: a
  // string course banding the facade at a floor line, arched window heads on
  // the older stock, and quoins running up the corners of the good addresses.
  // They cost nothing — the shader already knows where the floors and the
  // window openings are — and they are what stops a brick wall reading as a
  // grid of holes.
  bool masonry = isMasonry(s);
  if (masonry && near > 0.15) {
    // STRING COURSE. A projecting band of stone at one floor line, on maybe
    // half the buildings, at a height that varies with the building.
    if (vRand > 0.46) {
      float bandFl = floor(2.0 + vRand * 3.0);          // 2nd to 4th floor
      float bz = vZ - bandFl * fh;
      if (bz > -0.34 && bz < 0.14) {
        // lit on top, shadowed underneath, the way a projecting course reads
        wall *= bz > -0.12 ? 1.12 : 0.80;
        winMask *= smoothstep(0.0, 0.10, abs(bz + 0.10));
      }
    }
    // ARCHED HEADS. Round-topped openings on the older stock: cut the top
    // corners off the window by pushing the mask in as it nears the head.
    if (vVar > 0.55 && isArched(s)) {
      float wyA = clamp((f.y - m.y - 0.04) / max(win.y, 0.001), 0.0, 1.0);
      float wxA = abs(f.x - 0.5) / max(win.x * 0.5, 0.001);
      // the arch springs at 70% of the opening height
      float spring = smoothstep(0.70, 1.0, wyA);
      float rad = sqrt(max(0.0, 1.0 - spring * spring));
      winMask *= 1.0 - smoothstep(rad - 0.16, rad + 0.02, wxA * spring);
      // a keystone-and-voussoir band follows the arch
      if (wyA > 0.86 && wyA < 1.06) wall *= 1.07;
    }
    // QUOINS. Alternating blocks up the corner, on the better buildings. vSeg
    // carries where this fragment sits along the wall, so "near the end" is
    // known exactly.
    if (vRand > 0.62 && vTop > fh * 2.2) {
      // A quoin is a corner, so it has to be measured as a FRACTION of the
      // wall it is on. At a flat 0.9 m from each end, a short return wall was
      // entirely quoin — which is why whole facades came out banded like a
      // deckchair and lost their windows to it.
      float segLen = max(1.0, vSeg.y - vSeg.x);
      float dEnd = min(vU - vSeg.x, vSeg.y - vU);
      if (segLen > 8.0 && dEnd < min(0.85, segLen * 0.09)) {
        float course = step(0.5, fract(vZ / (fh * 0.34)));
        wall *= mix(0.94, 1.09, course);
        winMask = 0.0;
      }
    }
  }
  // art deco: recessed spandrels keep the vertical piers running
  if (s == 6 && f.y < 0.18) wall *= 0.84;

  // ---- CRYSTAL: the slab edge is a shadow gap, not a band -------------------
  // On a 1980s curtain wall the floor plate is expressed: a metre of spandrel
  // panel across the whole facade at every level, which is what makes those
  // buildings read as striped. On a frameless wall the slab hides behind the
  // glass and all that is left at the floor line is a dark seam a few
  // centimetres deep. That one difference is most of why one looks like 1985
  // and the other looks like now.
  if (s == 15) {
    float gapK = 1.0 - smoothstep(0.0, 0.030, min(f.y, 1.0 - f.y));
    wall *= 1.0 - 0.45 * gapK;
  }

  // ---- DIAGRID: the structure worn on the outside --------------------------
  // Hearst Tower and 30 St Mary Axe are glass buildings whose bracing you read
  // from the pavement. The lattice is drawn, not implied: two families of
  // diagonals crossing at a node every four floors, in brushed aluminium, and
  // the glass simply is not there where a member is.
  if (s == 16) {
    float dH = fh * 4.0, dW = 7.2;
    float dA = abs(fract(vU / dW + vZ / dH + 0.5) - 0.5) * 2.0;
    float dB = abs(fract(vU / dW - vZ / dH + 0.5) - 0.5) * 2.0;
    float dD = min(dA, dB);
    float dHalf = 0.17;
    float dAA = fwidth(dD) + 1e-4;
    float member = 1.0 - smoothstep(dHalf - dAA, dHalf + dAA, dD);
    if (member > 0.001) {
      float round_ = smoothstep(dHalf, 0.0, dD);          // a section, not a stripe
      wall = mix(wall, vec3(0.78, 0.79, 0.81) * (0.80 + 0.36 * round_), member);
      winMask *= 1.0 - member;
    }
  }

  // ---- POSTMODERN: the pier is the point -----------------------------------
  // A 1984 granite tower is a masonry building with large windows, and the
  // thing the eye reads is the polished pier between the glass strips catching
  // the light on its return.
  if (s == 17) {
    float pier = 1.0 - smoothstep(0.0, 0.17, min(f.x, 1.0 - f.x));
    wall *= mix(1.0, 1.15, pier);
    if (vZ < fh * 3.0) wall *= 0.93;                      // a darker stone base
  }

  // ==================== WHAT EACH TYPE IS, AS OPPOSED TO WHAT COLOUR IT IS ===
  //
  // One block per family, each drawing the single thing you could name the
  // building by. These run on wall and winMask only — anything that acts on
  // the glass itself is further down, after the glass colour exists.
  //
  // Where the opening sits inside its bay, which most of these need:
  float ox = clamp((f.x - m.x) / max(win.x, 0.001), 0.0, 1.0);      // 0..1 across the hole
  float oy = clamp((f.y - m.y - 0.04) / max(win.y, 0.001), 0.0, 1.0); // 0..1 up the hole
  bool inHole = winMask > 0.5;
  // Shade a style's own signature casts onto its glass — a fin's return, the
  // back of a deep frame, the underside of a shelf. Collected here and applied
  // once, after the glass colour exists, so a branch can shade glass it cannot
  // yet see.
  float glassShade = 1.0;

  if (near > 0.10) {
    if (s == 18) {
      // CAST IRON: a slender colonnette on the bay line, catching light on its
      // round face, and a flat iron spandrel beam under each opening. The
      // column is thin — that thinness is the advertisement for iron.
      float colm = 1.0 - smoothstep(0.0, 0.055, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * (1.22 - 0.34 * abs(f.x - 0.5) * 2.0), colm);
      if (f.y < 0.13) wall *= 0.90;                       // the beam in shadow
    }
    if (s == 19) {
      // ROMANESQUE: rusticated coursing. Deep raked joints every 0.9 m, so the
      // wall is a stack of shadowed bands rather than a plane, and the arch
      // above each opening gets a ring of voussoirs a shade lighter.
      float course = fract(vZ / 0.92);
      wall *= 1.0 - 0.20 * (1.0 - smoothstep(0.0, 0.10, course));
      wall *= 0.96 + 0.08 * hash(vec2(floor(vU / 1.7), floor(vZ / 0.92)));  // rubble
      if (inHole && oy > 0.80) wall *= 1.06;
    }
    if (s == 20) {
      // GOTHIC: the head is POINTED, not round, and the piers between the bays
      // never stop — they run past every floor line to the parapet. Cut the
      // opening to a lancet by pushing the mask in linearly rather than on a
      // circle, which is exactly the difference between the two arches.
      float lance = smoothstep(0.62, 1.0, oy);
      winMask *= 1.0 - smoothstep(1.0 - lance * 1.05, 1.0 - lance * 1.05 + 0.14, abs(ox - 0.5) * 2.0 + lance * 0.9);
      float pier = 1.0 - smoothstep(0.0, 0.13, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.10, pier);
      if (fract(vZ / (fh * 3.0)) < 0.04) wall *= 0.94;    // a spandrel course
    }
    if (s == 21) {
      // BEAUX-ARTS: three parts. A rusticated base of two storeys, a giant
      // order of engaged columns running the middle, a plain attic above. The
      // column is wide and it spans several floors, which is the whole trick —
      // it makes a ten-storey building read as one room.
      float baseTop = fh * 2.1, atticAt = vTop - fh * 1.5;
      if (vZ < baseTop) {
        wall *= 0.94 + 0.10 * step(0.5, fract(vZ / 0.85));   // rusticated courses
      } else if (vZ < atticAt) {
        float colm = 1.0 - smoothstep(0.0, 0.16, min(f.x, 1.0 - f.x));
        wall = mix(wall, wall * 1.13, colm);
        wall *= 1.0 - 0.10 * (1.0 - smoothstep(0.0, 0.05, abs(fract(vZ / fh) - 0.5)));
      } else {
        wall *= 0.97;
      }
    }
    if (s == 22 || s == 23) {
      // SECOND EMPIRE and ITALIANATE both hang on a BRACKET RHYTHM: paired
      // scrolls under the eave at roughly twice the window frequency, reading
      // as a row of dark teeth just below the cornice line.
      float brz = vTop - vZ;
      if (brz < 1.5 && brz > 0.35) {
        float br = fract(vU / (colW * 0.5));
        wall *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.22, min(br, 1.0 - br)));
      }
      // Empire heads are segmental — a shallow curve, not a semicircle.
      if (s == 22 && inHole && oy > 0.86) winMask *= 1.0 - smoothstep(0.55, 0.95, abs(ox - 0.5) * 2.0);
    }
    if (s == 24) {
      // FEDERAL: SMALL PANES. Six over six, with white muntins — the window is
      // a grid, not a hole, and that reads as domestic at any distance where
      // the window reads at all. Plus a splayed flat lintel over each opening.
      if (inHole) {
        float mx = abs(fract(ox * 3.0) - 0.5), my = abs(fract(oy * 3.0) - 0.5);
        float mun = (1.0 - smoothstep(0.36, 0.50, mx)) + (1.0 - smoothstep(0.36, 0.50, my));
        winMask *= 1.0 - clamp(mun, 0.0, 1.0) * 0.85;
      }
      if (inHole && oy > 0.94) wall = mix(wall, vec3(0.88, 0.87, 0.83), 0.7);
    }
    if (s == 25) {
      // TENEMENT: a flat stone lintel and sill on every opening, in a stone
      // that is not the brick — the only ornament these ever got, and the one
      // that survives being painted over.
      if (inHole && (oy > 0.95 || oy < 0.05)) wall = mix(wall, vec3(0.78, 0.76, 0.71), 0.55);
    }
    if (s == 26) {
      // THE CHICAGO WINDOW: one wide fixed pane with a narrow operable sash
      // each side. Cut two mullions into the opening at the quarter points and
      // the wide window instantly stops being a hole and becomes this type.
      if (inHole) {
        float a1 = abs(ox - 0.22), a2 = abs(ox - 0.78);
        winMask *= 1.0 - (1.0 - smoothstep(0.0, 0.030, min(a1, a2))) * 0.9;
      }
      if (fract(vZ / fh) < 0.07) wall *= 0.93;             // terra-cotta sill course
    }
    if (s == 27) {
      // GLAZED TERRA COTTA: fine block joints in both directions, and a glaze
      // that is glossier than any stone — the sheen is added with the light.
      float jx = 1.0 - smoothstep(0.0, 0.025, min(fract(vU / 1.55), 1.0 - fract(vU / 1.55)));
      float jy = 1.0 - smoothstep(0.0, 0.030, min(fract(vZ / 0.78), 1.0 - fract(vZ / 0.78)));
      wall *= 1.0 - 0.10 * max(jx, jy);
    }
    if (s == 28) {
      // STREAMLINE MODERNE: continuous horizontal sill and head bands running
      // straight through the piers, so nothing vertical survives. Plus glass
      // block in a couple of bays per building, which reads as a pale panel.
      float fy = fract(vZ / fh);
      if (fy > 0.86 || fy < 0.10) wall = mix(wall, wall * 1.14, 0.85);
      float blockBay = step(0.80, hash(vec2(floor(u) + 5.0, floor(vRand * 31.0))));
      if (blockBay > 0.5 && inHole) {
        float gx = abs(fract(ox * 6.0) - 0.5), gy = abs(fract(oy * 6.0) - 0.5);
        wall = mix(wall, vec3(0.80, 0.86, 0.86) * (0.86 + 0.24 * max(gx, gy)), 0.9);
        winMask = 0.0;
      }
    }
    if (s == 29) {
      // STRIPPED CLASSICISM: a giant pilaster between every bay, very wide and
      // very shallow, running the full height without a capital. The window is
      // a slot at the back of the gap between them.
      float pil = 1.0 - smoothstep(0.10, 0.26, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.11, pil);
      if (vZ < fh * 1.6) wall *= 0.95;
    }
    if (s == 30) {
      // CARRIAGE HOUSE: the ground storey is one big opening. Nothing else on
      // the building matters as much as that hole being there.
      if (vZ < fh * 0.92 && vTop > fh * 1.5) {
        float dw = fract(vU / 5.2);
        if (dw > 0.14 && dw < 0.86) {
          float head = smoothstep(0.60, 0.96, vZ / (fh * 0.92));
          float cut = 1.0 - smoothstep(0.72 - head * 0.5, 0.98, abs(dw - 0.5) * 2.0 + head);
          wall = mix(wall, vec3(0.24, 0.20, 0.17), cut);
          winMask = 0.0;
        }
      }
    }
    if (s == 31) {
      // MARKET HALL: a clerestory. The top band of the wall is all glass and
      // the storey below it is blank, because the building is one room and the
      // light comes in over the stalls.
      float cl = vTop - vZ;
      if (cl < fh * 1.15 && vTop > fh * 2.2) { winMask = max(winMask, step(0.18, fract(vU / 2.6))); }
      else if (cl < fh * 2.3 && vTop > fh * 2.6) winMask = 0.0;
    }
    if (s == 32) {
      // THE I-BEAM MULLION. A real projecting section on the face of the
      // building: a bright outer flange, a dark web each side of it, every bay
      // for the whole height. This is the single most identifiable detail in
      // twentieth century architecture and it is two smoothsteps.
      float d = min(f.x, 1.0 - f.x);
      float flange = 1.0 - smoothstep(0.020, 0.042, d);
      float web = (1.0 - smoothstep(0.042, 0.075, d)) * (1.0 - flange);
      wall = mix(wall, wall * 1.85 + vec3(0.05), flange);
      wall = mix(wall, wall * 0.55, web);
      winMask *= 1.0 - clamp(flange + web, 0.0, 1.0);
    }
    if (s == 33) {
      // PRECAST EGGCRATE: every opening is at the back of a box, so it is the
      // CELL that is shaded rather than the window — one jamb dark, the head
      // dark, the sill catching. The frame between cells stays bright.
      float fr = max(1.0 - smoothstep(0.0, 0.10, min(f.x, 1.0 - f.x)),
                     1.0 - smoothstep(0.0, 0.10, min(f.y, 1.0 - f.y)));
      wall = mix(wall, wall * 1.12, fr);
      if (inHole) {
        float sunSide = dot(SUN_DIR, T) > 0.0 ? ox : 1.0 - ox;
        wall *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.35, sunSide));
      }
    }
    if (s == 34) {
      // BOARD-FORMED CONCRETE: the grain of the shuttering, left in. Boards
      // 200 mm deep with a lip between them, and a grid of tie holes. Nothing
      // else on the wall — no floor line, no base, no top.
      float bd = fract(vZ / 0.205);
      wall *= 0.94 + 0.10 * bd;
      wall *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.05, min(bd, 1.0 - bd)));
      float tx = fract(vU / 1.22), tz = fract(vZ / 1.64);
      wall *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.035, length(vec2(tx - 0.5, tz - 0.5))));
    }
    if (s == 36) {
      // CORRUGATION. A rib every 150 mm, lit on one flank and shaded on the
      // other — and which flank depends on where the sun is, so a metal shed
      // changes character across the day the way a real one does.
      float rib = fract(vU / 0.152);
      float lobe = sin(rib * 6.2831853);
      wall *= 1.0 + 0.19 * lobe * sign(dot(SUN_DIR, T));
      if (fract(vZ / 2.44) < 0.02) wall *= 0.90;           // the sheet lap
    }
    if (s == 37) {
      // EIFS: a trim band at every floor and a control joint grid, because the
      // render has to be broken up or it cracks. Cheap, and it looks it.
      float fy = fract(vZ / fh);
      if (fy < 0.06) wall = mix(wall, wall * 1.12, 0.8);
      float cj = 1.0 - smoothstep(0.0, 0.02, min(fract(vU / 3.4), 1.0 - fract(vU / 3.4)));
      wall *= 1.0 - 0.09 * cj;
    }
    if (s == 38) {
      // PARKING DECK: a spandrel rail at every level and the opening behind it
      // is a VOID. Also the decks slope, so the rail line is not quite level —
      // one of those details that is invisible until it is missing.
      float slope = fract(vU / 34.0) * 0.55;
      float fy = fract((vZ + slope) / fh);
      if (fy < 0.34) { wall = mix(wall, wall * 1.06, 0.9); winMask = 0.0; }
      else if (inHole) wall *= 0.4;
    }
    if (s == 39) {
      // PAIRED WINDOWS. One mullion down the middle of every opening turns a
      // regular grid into the postwar residential grid, which is a different
      // and much more relentless thing.
      if (inHole) winMask *= 1.0 - (1.0 - smoothstep(0.0, 0.045, abs(ox - 0.5))) * 0.92;
      if (fract(vZ / fh) < 0.05) wall *= 0.95;
    }
    if (s == 40) {
      // THE BALCONY SLOT. A 1960s white-brick apartment house punches a
      // recessed balcony into one bay of every other floor: a dark rectangle
      // with a pale rail across its bottom third, set INTO the wall plane.
      float bBay = step(0.66, hash(vec2(floor(u) + 2.0, floor(vZ / (fh * 2.0)) + vRand * 13.0)));
      if (bBay > 0.5 && f.y > 0.10 && f.y < 0.94 && f.x > 0.12 && f.x < 0.88) {
        wall = mix(wall, wall * 0.42, 0.9);
        winMask = 0.0;
        if (f.y < 0.42) wall = mix(wall, vec3(0.82, 0.81, 0.78), 0.75);  // the rail
      }
    }
    if (s == 41) {
      // THE SLAB EDGE IS THE ARCHITECTURE. A continuous white band at every
      // floor, standing PROUD of the glass, with the recess behind it in
      // shadow and a rail sitting on it. From the air this is a striped
      // building, and the stripe is a real shadow.
      float fy = fract(v);
      if (fy < 0.16) {
        wall = mix(wall, wall * 1.24, 0.92);               // the lit slab nose
        winMask = 0.0;
      } else if (fy < 0.30) {
        wall = mix(wall, wall * 0.46, 0.88);               // under the slab
        winMask *= 0.25;
      } else if (fy < 0.46) {
        wall = mix(wall, wall * 1.05, 0.5);                // the glass rail
        winMask *= 0.6;
      }
    }
    if (s == 43) {
      // MASS TIMBER: a warm wood spandrel with the grain running across it,
      // and the column line showing through at every bay.
      float fy = fract(v);
      if (fy < 0.24) {
        wall *= 0.94 + 0.11 * hash(vec2(floor(vU / 0.19), floor(vZ / 2.4)));
        winMask = 0.0;
      }
      float cl = 1.0 - smoothstep(0.0, 0.07, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.10, cl);
    }
    if (s == 44) {
      // THE RAINSCREEN COMB. Fins standing off the glass, so what you see
      // through the gap depends on the angle you are at — nearly opaque on the
      // returns running away from you, nearly clear face-on. One dot product,
      // and it is the only facade here that changes as the camera moves.
      float obliq = 1.0 - abs(dot(n, Vw));
      float bag = fract(vU / 0.30);
      float fin = 1.0 - smoothstep(0.10, 0.34, min(bag, 1.0 - bag));
      float cover = clamp(fin + obliq * 1.25, 0.0, 1.0);
      wall = mix(wall, wall * (0.82 + 0.30 * fin), 0.9);
      winMask *= 1.0 - cover * 0.92;
    }
    if (s == 126 || s == 131 || s == 132) {
      // THE REPEATED CELL. A precast grid where every opening is identical
      // because every room behind it is identical — an exam room, a desk, a
      // clerk. The panel joint round each cell is the only relief there is.
      float jx = 1.0 - smoothstep(0.0, 0.020, min(f.x, 1.0 - f.x));
      float jy = 1.0 - smoothstep(0.0, 0.024, min(f.y, 1.0 - f.y));
      wall = mix(wall, wall * 1.13, clamp(max(jx, jy), 0.0, 1.0));
      if (s == 126 && vZ < fh * 1.15 && fract(vU / 24.0) < 0.22) {
        wall = mix(wall, wall * 1.24, 0.85); winMask = 0.0;      // the entrance canopy
      }
      if (s == 132 && vZ < fh * 0.55) { wall *= 0.90; winMask = 0.0; }   // security base
    }
    if (s == 127 || s == 130) {
      // THE HORIZONTAL STRIPE. Continuous ribbon over a dark spandrel with
      // nothing vertical anywhere — a mullion so slim it disappears, and the
      // spandrel darker than the glass so the band reads from a mile off.
      float fy = fract(v);
      if (fy > 0.58) { wall = mix(wall, wall * 0.62, 0.9); winMask = 0.0; }
      float mull = 1.0 - smoothstep(0.006, 0.016, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.30, mull * 0.6); winMask *= 1.0 - mull * 0.5;
      if (s == 130 && vZ < 0.9) wall *= 0.92;
    }
    if (s == 129 || s == 133) {
      // ALMOST NO WINDOW. What is inside is desks and machines, and neither
      // needs a view — so the wall is a field of panel with louvre banks on a
      // carrier hotel, and one strip of glass at the top for the people who
      // chose the building.
      if (s == 133) {
        float t = fract(vU / 9.0);
        if (t > 0.16 && t < 0.54 && vZ > fh * 0.6 && vZ < vTop - fh * 0.4) {
          float bl = fract(vZ / 0.24);
          wall = mix(wall, wall * mix(0.44, 1.16, bl), 0.9);
        }
        winMask = 0.0;
      } else {
        if (vZ < vTop - fh * 1.1) winMask *= step(0.72, hash(vec2(floor(u), floor(v))));
      }
      float pj = 1.0 - smoothstep(0.0, 0.018, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.08, pj);
    }
    if (s == 134) {
      // OLD HOLE, NEW GLASS. The mill's opening is kept exactly, and the new
      // unit sits flush inside it with no frame at all — so there is a hard
      // shadow at the jamb where the old wall stops and nothing where the
      // glass begins. That join is the entire conversion.
      if (inHole) {
        glassShade = 0.94;
        float edge = min(min(ox, 1.0 - ox), min(oy, 1.0 - oy));
        glassShade *= 1.0 - 0.42 * (1.0 - smoothstep(0.0, 0.055, edge));
      } else if (oy > 0.86 && abs(ox - 0.5) < 0.5) {
        wall *= 1.05;                                            // the old segmental head
      }
      wall *= 0.96 + 0.08 * hash(vec2(floor(vU / 0.22), floor(vZ / 0.075)));
    }
    if (s == 135) {
      // THE SKY LOBBY SEAM. The lift stacks change over a third of the way up
      // and the plate changes with them — a band of mechanical louvre, and the
      // mullion rhythm above it does not line up with the rhythm below.
      float sz = vTop * (0.34 + 0.10 * vVar);
      float off = vZ > sz ? 0.37 : 0.0;
      float mull = 1.0 - smoothstep(0.010, 0.026, min(fract(vU / colW + off), 1.0 - fract(vU / colW + off)));
      wall = mix(wall, wall * 1.32, mull); winMask *= 1.0 - mull * 0.85;
      if (abs(vZ - sz) < fh * 0.55) {
        float bl = fract(vZ / 0.30);
        wall = mix(wall, wall * mix(0.46, 1.14, bl), 0.9); winMask = 0.0;
      }
    }
    if (s == 136) {
      // THE WALKWAY. An external deck along the upper floor with a rail and a
      // suite door every bay — the motel plan, sold to dentists.
      float fy = fract(v);
      if (vZ > fh * 0.95) {
        if (fy < 0.10) { wall = mix(wall, wall * 1.20, 0.9); winMask = 0.0; }
        else if (fy < 0.28) { wall = mix(wall, wall * 1.02, 0.6); winMask *= 0.3; }
        else if (fy < 0.38) { wall = mix(wall, wall * 0.44, 0.85); winMask = 0.0; }
        else if (hash(vec2(floor(u) + 3.0, floor(v))) > 0.55 && abs(f.x - 0.5) < 0.15) {
          wall = mix(wall, vec3(0.280, 0.250, 0.230), 0.85); winMask = 0.0;
        }
      }
    }
    if (s == 137) {
      // THE MONEY WENT INTO THE WALL. One storey of very good glass at grade,
      // then deep punched openings in big ashlar above — fewer holes, better
      // stone, and a reveal you could sit in.
      if (vZ < fh * 1.15) { winMask = step(0.06, fract(vU / 3.2)); glassShade = 0.80; }
      else {
        float jj = 1.0 - smoothstep(0.0, 0.020, min(fract(vU / 1.9), 1.0 - fract(vU / 1.9)));
        wall *= 1.0 - 0.07 * jj;
        if (inHole) {
          float sunSide = dot(SUN_DIR, T) > 0.0 ? ox : 1.0 - ox;
          glassShade = 1.0 - 0.44 * (1.0 - smoothstep(0.0, 0.36, sunSide));
        }
      }
    }
    if (s == 138) {
      // THE LOGO BAND. A saturated stripe of the tenant's colour where a
      // cornice would be, running the whole frontage. It is the only reason
      // the building looks the way it does and everybody knows it.
      if (vZ > vTop - fh * 0.85) {
        vec3 brand = vVar < 0.25 ? vec3(0.58, 0.16, 0.18)
                   : vVar < 0.50 ? vec3(0.14, 0.30, 0.56)
                   : vVar < 0.75 ? vec3(0.16, 0.38, 0.26)
                                 : vec3(0.60, 0.46, 0.10);
        wall = mix(wall, brand, 0.86); winMask = 0.0;
      }
      float fy = fract(v);
      if (fy > 0.66) { wall = mix(wall, wall * 0.78, 0.8); winMask = 0.0; }
    }
    if (s == 139 || s == 142 || s == 143) {
      // THE BLANK BOX AND ITS BAND. Every square foot of wall is shelving on
      // the other side, so the only things on it are the chain's colour band
      // and, on a junior box, one gable parapet standing above the flat one.
      float bandTop = vTop - fh * (s == 139 ? 0.55 : 0.85);
      if (vZ > bandTop) {
        vec3 chain = vVar < 0.3 ? vec3(0.60, 0.18, 0.18)
                   : vVar < 0.6 ? vec3(0.16, 0.32, 0.58)
                                : vec3(0.62, 0.46, 0.12);
        wall = mix(wall, chain, s == 139 ? 0.55 : 0.80);
      }
      if (s != 139) wall *= 0.96 + 0.07 * step(0.5, fract(vZ / 0.41));   // split-face block
      // the gable parapet, once, in the middle of the frontage
      float g = abs(fract(vU / 46.0) - 0.5);
      if (s == 142 && g < 0.13 && vZ > vTop - fh * 1.5) {
        float rise = (0.13 - g) / 0.13;
        if (vZ < vTop - fh * 1.5 + rise * fh * 1.5) wall = mix(wall, wall * 1.10, 0.8);
      }
      // the entrance portal: the one hole in the whole elevation
      if (s == 139 && vZ < fh * 1.5 && abs(fract(vU / 60.0) - 0.3) < 0.045) {
        wall = mix(wall, wall * 0.42, 0.9);
      }
    }
    if (s == 140 || s == 150) {
      // EIGHT SHOPS, ONE BUILDING. The fascia changes height, colour and
      // material every few bays and none of it corresponds to anything behind.
      float unit = floor(vU / 13.0);
      float h1 = hash(vec2(unit, vRand * 23.0));
      float lift = fh * (0.10 + 0.30 * h1);
      if (vZ > vTop - fh * 0.9 - lift) {
        vec3 c2 = mix(vec3(0.560, 0.430, 0.350), vec3(0.640, 0.620, 0.575), fract(h1 * 5.3));
        wall = mix(wall, c2, 0.7); winMask = 0.0;
      }
      // the covered walkway on an outlet: posts and a deep shade behind
      if (s == 150 && vZ < fh * 1.05) {
        float t = fract(vU / 3.4);
        float post = 1.0 - smoothstep(0.10, 0.18, min(t, 1.0 - t));
        wall = mix(wall * 0.40, wall * 1.12, post); winMask = 0.0;
      }
    }
    if (s == 141 || s == 147) {
      // BLANK ABOVE, GLASS BELOW, and a deep canopy between them. The upper
      // wall exists only to carry signs; the lower one is entirely shopfront.
      float cz = fh * 1.15;
      if (vZ > cz) {
        winMask = 0.0;
        if (vZ < cz + 0.75) wall = mix(wall, wall * 1.18, 0.85);          // canopy fascia
        else if (s == 147) {
          // one very big gable over the entrance of a grocery
          float g = abs(fract(vU / 52.0) - 0.42);
          if (g < 0.10) wall = mix(wall, wall * 1.08, 0.7);
        }
      } else {
        wall = mix(wall, wall * 0.66, 0.5);
        winMask = step(0.08, fract(vU / 2.6)) * step(0.55, vZ);
        glassShade = 0.78;
      }
    }
    if (s == 144 || s == 145 || s == 148) {
      // THE SMALL FREESTANDING BUILDING. A deep overhanging eave all round,
      // awnings over the openings, and on a bank a canopy on a limb off one
      // side. Mostly roof, and the roof is mostly overhang.
      if (vZ > vTop - 0.9) { wall = mix(wall, wall * 0.80, 0.85); winMask = 0.0; }
      if (inHole && oy > 0.80) {
        vec3 awn = vec3(0.44 + 0.20 * vVar, 0.30 + 0.14 * fract(vVar * 3.7), 0.28);
        wall = mix(wall, awn, 0.75); winMask = 0.0;
      }
      if (s == 145 && vZ < fh * 0.95 && fract(vU / 26.0) > 0.78) {
        wall = mix(wall, wall * 1.16, 0.7); winMask = 0.0;               // drive-up canopy
      }
    }
    if (s == 146) {
      // THE ROTUNDA. The corner is the door, so the corner is a drum — a
      // curved bay with a conical cap, and every one of these was built to the
      // same drawing in every town in the country.
      float t = fract(vU / 34.0);
      if (t < 0.14) {
        float across = t / 0.14;
        float face = sin(across * 3.14159265);
        wall *= 0.80 + 0.38 * face;
        if (vZ > vTop - fh * 0.9) { wall = mix(wall, wall * 0.88, 0.7); winMask = 0.0; }
        else winMask = step(0.10, fract(across * 5.0)) * step(fh * 0.35, vZ);
      } else {
        wall *= 0.96 + 0.07 * hash(vec2(floor(vU / 0.22), floor(vZ / 0.075)));
      }
    }
    if (s == 149) {
      // NOTHING BETWEEN THE PAVEMENT AND THE MERCHANDISE. Full-height glass,
      // no spandrel and no sill — only a slim column every bay and a shallow
      // fascia at the top.
      float col = 1.0 - smoothstep(0.0, 0.035, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.20, col); winMask *= 1.0 - col;
      if (vZ > vTop - 0.8) { wall = mix(wall, wall * 1.10, 0.85); winMask = 0.0; }
      if (inHole) glassShade = 1.12;                                     // lit interior
    }
    if (s == 151) {
      // TWO BUILDINGS STACKED. Glazed to the pavement under a deep canopy, and
      // above the canopy a completely different material. The seam is the type.
      float cz = fh * 1.35;
      if (vZ < cz) {
        winMask = step(0.06, fract(vU / 2.8)) * step(0.35, vZ);
        glassShade = 0.82;
        if (vZ > cz - 0.55) { wall = mix(wall, wall * 0.52, 0.9); winMask = 0.0; }
      } else {
        wall = mix(wall, wall * 1.10, 0.55);
        if (fract(v) < 0.08) wall *= 0.94;
      }
    }
    if (s == 112) {
      // THE PLANTING. A deep terrace at every floor with soil in it, and the
      // foliage spilling over the edge — so the tower alternates a band of
      // green and a band of glass all the way up, which nothing else does.
      float fy = fract(v);
      if (fy < 0.13) { wall = mix(wall, wall * 1.18, 0.85); winMask = 0.0; }        // slab nose
      else if (fy < 0.34) {
        float leaf = hash(vec2(floor(vU / 0.9), floor(v) * 3.1));
        vec3 grn = mix(vec3(0.230, 0.360, 0.190), vec3(0.330, 0.450, 0.250), leaf);
        wall = mix(wall, grn * (0.80 + 0.40 * hash(vec2(floor(vU / 0.35), floor(v)))), 0.92);
        winMask = 0.0;
      } else if (fy < 0.44) { wall = mix(wall, wall * 0.44, 0.85); winMask *= 0.3; } // under the slab
    }
    if (s == 113) {
      // THE FOLD. Each bay is a V in plan, so one flank faces the sun and the
      // other faces away — and which is which flips with the sun's direction,
      // so the whole tower restripes across the day.
      float t = f.x;
      float side = t < 0.5 ? 1.0 : -1.0;
      float k = side * sign(dot(SUN_DIR, T));
      float lit = 0.72 + 0.46 * (0.5 + 0.5 * k);
      wall *= lit; glassShade = lit;
      float crease = 1.0 - smoothstep(0.0, 0.03, min(abs(t - 0.5), min(t, 1.0 - t)));
      wall = mix(wall, wall * 1.30, crease * 0.8);
    }
    if (s == 114) {
      // THE SCALE. Every panel leans out over the one below, so its bottom edge
      // catches a hard line of light and its top slips into the shade of the
      // course above. A wall made of stacked overlaps rather than a plane.
      float sy = fract(v * 2.0);
      wall *= 0.82 + 0.34 * smoothstep(0.0, 0.30, sy);
      if (sy < 0.09) { wall = mix(wall, wall * 1.55, 0.85); winMask *= 0.5; }
      glassShade = 0.86 + 0.26 * smoothstep(0.0, 0.35, sy);
    }
    if (s == 115) {
      // THE CAVITY. You see the maintenance walkway grating at every floor
      // THROUGH the outer sheet — a hard horizontal bar of dark held some way
      // behind the glass, which is the one thing a single-skin wall cannot fake.
      float fy = fract(v);
      if (fy > 0.06 && fy < 0.20) {
        float grate = step(0.5, fract(vU / 0.11));
        glassShade = 0.32 + 0.26 * grate;
      }
      float mull = 1.0 - smoothstep(0.010, 0.028, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.30, mull);
      winMask *= 1.0 - mull * 0.7;
      // the outer sheet reads as a faint second reflection over everything
      glassShade *= 0.94 + 0.10 * pow(1.0 - abs(dot(n, Vw)), 2.0);
    }
    if (s == 116) {
      // ONE GIANT CROSS every eight floors. Not a diagrid — a member you could
      // walk along, in painted steel, so the building is a handful of enormous
      // triangles and you read its structure at BUILDING scale.
      float H = fh * 8.0, W = 16.0;
      float dA = abs(fract(vU / W + vZ / H + 0.5) - 0.5) * 2.0;
      float dB = abs(fract(vU / W - vZ / H + 0.5) - 0.5) * 2.0;
      float dD = min(dA, dB);
      float member = 1.0 - smoothstep(0.055, 0.075, dD);
      if (member > 0.001) {
        float round_ = smoothstep(0.075, 0.0, dD);
        wall = mix(wall, vec3(0.700, 0.700, 0.705) * (0.72 + 0.44 * round_), member);
        winMask *= 1.0 - member;
      }
      // and the belt truss where the braces meet
      float belt = 1.0 - smoothstep(0.0, 0.035, min(fract(vZ / H), 1.0 - fract(vZ / H)));
      if (belt > 0.0) { wall = mix(wall, wall * 1.18, belt * 0.9); winMask *= 1.0 - belt * 0.8; }
    }
    if (s == 117) {
      // THE ZIGZAG. Facets alternating left and right in bands up the height,
      // so the reflection breaks at every change and the tower never presents
      // one continuous sheet of sky.
      float band = floor(v / 3.0);
      float side = mod(band, 2.0) < 0.5 ? 1.0 : -1.0;
      float k = side * sign(dot(SUN_DIR, T));
      float lit = 0.76 + 0.38 * (0.5 + 0.5 * k);
      wall *= lit; glassShade = lit;
      float seam = 1.0 - smoothstep(0.0, 0.04, min(fract(v / 3.0), 1.0 - fract(v / 3.0)));
      wall = mix(wall, wall * 1.25, seam * 0.85);
    }
    if (s == 118) {
      // THE MODULE JOINT. A seam round every box, in BOTH directions, closing
      // on all four sides — one flat per module. Nothing else in the city has
      // a joint that closes, and it is why these buildings read as stacked.
      float jx = 1.0 - smoothstep(0.0, 0.024, min(f.x, 1.0 - f.x));
      float jy = 1.0 - smoothstep(0.0, 0.030, min(f.y, 1.0 - f.y));
      float j = clamp(max(jx, jy), 0.0, 1.0);
      wall = mix(wall, wall * 0.62, j * 0.9);
      winMask *= 1.0 - j;
      // modules came off the line in batches and the batches do not match
      wall *= 0.95 + 0.10 * hash(vec2(floor(u), floor(v)));
    }
    if (s == 119) {
      // THE CELL GRID. Photovoltaic laminate: a fine dark grid of cells with a
      // busbar every few, and a hard specular sheen because it is glass over
      // silicon. Dark even in full sun, which is the point of it.
      float cx = fract(vU / 0.16), cy = fract(vZ / 0.16);
      float cell = max(1.0 - smoothstep(0.0, 0.10, min(cx, 1.0 - cx)),
                       1.0 - smoothstep(0.0, 0.10, min(cy, 1.0 - cy)));
      glassShade = 0.88 + 0.22 * cell;
      if (fract(vU / 0.80) < 0.05) glassShade *= 1.30;    // busbar
      wall = mix(wall, wall * 1.25, 1.0 - smoothstep(0.0, 0.03, min(f.x, 1.0 - f.x)));
    }
    if (s == 120) {
      // BLOCKS OF COLOUR. Fibre cement in vertical strips, changing hue every
      // few bays, over a glazed podium two storeys tall. The colour blocking is
      // the entire architecture and it is applied without much thought, which
      // is exactly how it looks in life.
      float blk = floor(vU / 11.0);
      float h1 = hash(vec2(blk, vRand * 17.0));
      vec3 alt = h1 < 0.25 ? vec3(0.620, 0.450, 0.360)
               : h1 < 0.50 ? vec3(0.500, 0.535, 0.545)
               : h1 < 0.75 ? vec3(0.700, 0.665, 0.590)
                           : vec3(0.430, 0.470, 0.430);
      float podium = step(vZ, fh * 2.0);
      wall = mix(mix(wall, alt, 0.85), wall * 0.86, podium);
      // panel joints, which is all the relief fibre cement ever gets
      float pj = 1.0 - smoothstep(0.0, 0.016, min(fract(vU / 1.22), 1.0 - fract(vU / 1.22)));
      wall *= 1.0 - 0.10 * pj * (1.0 - podium);
      if (podium > 0.5) { winMask = step(0.10, fract(vU / 2.2)) * step(0.6, vZ); glassShade = 0.72; }
      else if (fract(v) < 0.07) wall *= 0.94;
    }
    if (s == 121) {
      // THE MECHANICAL PENTHOUSE, which on a lab is taller than the parapet of
      // most buildings — two storeys of louvre over ribbon glass with a
      // spandrel deep enough to hide a duct run.
      float mz = vTop - fh * 2.0;
      if (vZ > mz) {
        float bl = fract(vZ / 0.26);
        wall = mix(wall, wall * mix(0.40, 1.20, bl), 0.9);
        winMask = 0.0;
      } else {
        float fy = fract(v);
        if (fy > 0.56) { wall = mix(wall, wall * 1.06, 0.75); winMask = 0.0; }   // deep spandrel
        float mull = 1.0 - smoothstep(0.012, 0.030, min(f.x, 1.0 - f.x));
        wall = mix(wall, wall * 1.22, mull); winMask *= 1.0 - mull * 0.8;
      }
    }
    if (s == 122) {
      // THE EXPOSED FRAME. One enormous steel-framed opening per bay with thin
      // bars across it — warehouse glazing, built new, and the column and beam
      // left showing round every light.
      float fr = max(1.0 - smoothstep(0.0, 0.09, min(f.x, 1.0 - f.x)),
                     1.0 - smoothstep(0.0, 0.09, min(f.y, 1.0 - f.y)));
      wall = mix(wall, wall * 1.16, fr);
      winMask *= 1.0 - fr;
      if (inHole) {
        float gx = abs(fract(ox * 4.0) - 0.5), gy = abs(fract(oy * 3.0) - 0.5);
        winMask *= 1.0 - clamp((1.0 - smoothstep(0.36, 0.48, gx)) + (1.0 - smoothstep(0.36, 0.48, gy)), 0.0, 1.0) * 0.7;
      }
    }
    if (s == 123) {
      // ONE WINDOW PER FLAT, and the flats are four metres wide. The tightest
      // rhythm in the city — and a juliet rail on some of them, which is the
      // only thing that breaks it.
      float jr = step(0.62, hash(vec2(floor(u) + 6.0, floor(v))));
      if (jr > 0.5 && inHole && oy < 0.34) {
        wall = mix(wall, wall * 1.20, 0.8);
        winMask *= 0.35;
      }
      if (fract(v) < 0.05) wall *= 0.95;
    }
    if (s == 124) {
      // HALF A METRE OF WALL. The opening sits at the back of a very deep
      // reveal so it is mostly shadow, and the render between is dead flat —
      // no bands, no joints, no expression at all. Fewer holes, smaller.
      if (inHole) {
        float sunSide = dot(SUN_DIR, T) > 0.0 ? ox : 1.0 - ox;
        glassShade = 1.0 - 0.52 * (1.0 - smoothstep(0.0, 0.42, sunSide))
                         - 0.30 * smoothstep(0.55, 1.0, oy);
      }
      wall *= 0.995 + 0.012 * hash(vec2(floor(vU / 2.5), floor(vZ / 2.5)));
    }
    if (s == 125) {
      // THE SCREEN. A band of self-lit colour that owes nothing to the sun —
      // the only surface in the city that is BRIGHT ON ITS SHADED SIDE, which
      // is exactly why a media facade catches the eye from three blocks away.
      float bz = vZ - fh * 1.15;
      if (bz > 0.0 && bz < fh * 1.5) {
        float px = floor(vU / 0.42), py = floor(vZ / 0.42);
        float c1 = hash(vec2(px, py + floor(vRand * 40.0)));
        vec3 lit = mix(vec3(0.62, 0.16, 0.22), vec3(0.16, 0.34, 0.68), c1);
        lit = mix(lit, vec3(0.66, 0.52, 0.14), step(0.72, fract(c1 * 3.7)));
        wall = mix(wall, lit, 0.90);
        winMask = 0.0;
      } else if (vZ <= fh * 1.15) {
        winMask = step(0.08, fract(vU / 2.4)); glassShade = 0.70;
      }
    }
    if (s == 104) {
      // ONE ARCH, and every glazing bar radiating from its single centre. That
      // fan is the whole building — a shed end is not a wall with a window in
      // it, it is a window with two stone haunches holding it up.
      float R = min(13.2, vTop * 0.62), zs = R * 0.57;
      vec2 pq = vec2((f.x - 0.5) * colW, vZ - zs);
      float rq = length(vec2(pq.x, max(pq.y, 0.0)));
      float aq = atan(max(pq.y, 0.001), pq.x);
      winMask = step(rq, R) * step(0.45, vZ);
      winMask *= step(0.11, fract(aq * 11.0 / 3.14159265));
      winMask *= step(0.13, fract(rq / 3.30));
      winMask *= step(0.34, abs(pq.x)) * step(0.30, abs(pq.y));
      if (rq > R) wall = mix(wall, wall * 0.72, 0.6);
      if (rq < R + 0.55 && rq > R - 0.15) wall = mix(wall, vec3(0.300, 0.310, 0.300), 0.9);
      if (inHole) glassShade = 0.30 + 0.45 * smoothstep(zs, zs + R, vZ);
    }
    if (s == 105) {
      // THE TRACK ARCH. Segmental, flattened, with a radiating fanlight over
      // vertical board leaves — and above the arches, blind brick.
      float ax = (f.x - 0.5) * colW, ay = vZ - min(4.40, vTop * 0.55);
      float rq = length(vec2(ax, max(ay, 0.0) * 1.35));
      float dr = step(rq, 2.20);
      winMask = dr;
      if (dr > 0.5 && ay > 0.0) winMask *= step(0.12, fract(atan(ay * 1.35, ax) * 7.0 / 3.14159265));
      if (dr > 0.5 && ay <= 0.0) winMask *= step(0.055, fract(vU / 0.58));
      if (dr < 0.5) winMask = 0.0;
      if (rq > 2.20 && rq < 2.72) wall = mix(wall, wall * 0.84, 0.85);   // voussoir ring
      wall *= 0.93 + 0.13 * hash(floor(vec2(vU / 0.23, vZ / 0.081)));
      if (vZ > vTop - 1.4) wall = mix(wall, wall * 1.14, step(0.5, fract(vU / 0.58)));
    }
    if (s == 106) {
      // ONE DOOR, a dozen leaves. Every joint a hard shadow line full height,
      // and a single clerestory ribbon above it. Nothing else, anywhere.
      float dh = min(11.0, vTop * 0.62);
      float dr = step(vZ, dh);
      winMask = step(dh + 1.20, vZ) * step(vZ, dh + 3.40);
      if (dr > 0.5) wall = mix(wall, wall * 0.86, 0.8);
      if (dr > 0.5 && fract(vU / 2.15) < 0.055) wall = mix(wall, wall * 0.52, 0.9);
      if (dr < 0.5) wall *= 1.0 - 0.09 * step(0.5, fract(vU / 0.90));
      if (abs(vZ - (dh + 0.35)) < 0.22) wall = mix(wall, vec3(0.340, 0.340, 0.330), 0.9);
    }
    if (s == 107) {
      // THE CANTILEVER. A 950 mm slab edge clear of the front, dead flat and
      // unbroken, and everything under it in permanent shade.
      float cz = min(5.0, vTop * 0.45);
      if (vZ > cz && vZ < cz + 0.95) { wall = mix(wall, wall * 1.22, 0.9); winMask = 0.0; }
      else if (vZ > cz + 0.95) { wall = mix(wall, vec3(0.300, 0.420, 0.460), 0.55); winMask = 0.0; }
      else if (vZ > cz - 0.30) { wall = mix(wall, wall * 0.30, 0.9); winMask = 0.0; }
      else { winMask = step(0.10, fract(vU / 1.60)); wall *= 0.48; if (inHole) glassShade = 0.26; }
    }
    if (s == 108) {
      // THE CAB OVERSAILS. Glass that leans out over the shaft, so the soffit
      // beneath it is the darkest thing on the building and the shaft itself
      // has nothing but stair slits.
      float cz = vTop - 4.60;
      if (vZ > cz) {
        winMask = step(0.085, fract(vU / 2.05));
        if (inHole) glassShade = 0.18 + 0.40 * abs(dot(normalize(Vw), n));
        wall = mix(wall, vec3(0.260, 0.270, 0.280), 0.85);
        if (vZ > vTop - 0.45) wall = mix(wall, vec3(0.520, 0.530, 0.520), 0.9);
      } else {
        winMask = step(0.55, fract(vU / (colW * 4.0))) * step(fh, vZ);
        wall *= 1.0 - 0.030 * (vTop - vZ) / max(vTop, 1.0);
        if (vZ > cz - 1.00) wall *= 0.38;
      }
    }
    if (s == 109) {
      // ALMOST BLIND. Full-height piers with a recessed panel between them, and
      // only about half the cells getting a slot at all — so the pattern of
      // holes is irregular in a way no other building's is.
      float rec = step(0.14, f.x) * step(f.x, 0.86);
      float cell = hash(vec2(floor(vZ / fh) * 1.7, floor(vU / colW) + vVar * 29.0));
      winMask = rec * step(0.52, cell) * step(fh * 1.2, vZ) * step(vZ, vTop - 2.4)
              * step(abs(f.x - 0.5), win.x * 0.5) * step(abs(f.y - 0.52), win.y * 0.5);
      wall *= 0.92 + 0.14 * hash(floor(vec2(vU / 0.225, vZ / 0.081)));
      wall *= mix(1.06, 0.90, rec);
      if (vZ > vTop - 2.4 || vZ < 0.9) wall = mix(wall, vec3(0.700, 0.670, 0.600), 0.7);
      if (rec > 0.5 && vZ > 1.0 && vZ < 2.0 && fract(vU / 0.18) > 0.5) wall = mix(wall, vec3(0.240, 0.230, 0.210), 0.8);
    }
    if (s == 110) {
      // THE COMB. 155 mm louvre pitch over whole panels, lit on each blade face
      // and black in the gap behind it. There is no glass on this building.
      float lv = fract(vZ / 0.155);
      float blade = smoothstep(0.0, 0.35, lv) * smoothstep(1.0, 0.62, lv);
      float pan = step(0.10, f.x) * step(f.x, 0.90) * step(1.4, vZ) * step(vZ, vTop - 1.6);
      wall = mix(wall * 1.04, wall * mix(0.30, 1.20, blade), pan);
      if (vZ < 4.2 && abs(f.x - 0.5) < 0.30 && fract(vU / (colW * 2.0)) > 0.5)
        wall = mix(wall, vec3(0.300, 0.300, 0.290), 0.85);
      if (vZ > vTop - 1.2 && fract(vU / 1.20) > 0.5) wall = mix(wall, vec3(0.440, 0.420, 0.400), 0.8);
      winMask = 0.0;
    }
    if (s == 111) {
      // A CYLINDER, not a wall. It narrows as it rises and it is shaded round
      // its girth — one lobe of light down the middle, falling off hard to
      // both edges — under a black gallery with the lantern over it.
      float lobe = sin(clamp(f.x, 0.0, 1.0) * 3.14159265);
      float taper = 1.0 - 0.30 * (vZ / max(vTop, 1.0));
      wall *= (0.62 + 0.52 * lobe) * (0.92 + 0.12 * taper);
      float gy = vTop - vZ;
      if (gy < 3.2 && gy > 2.3) { wall = mix(wall, vec3(0.220, 0.220, 0.230), 0.92); winMask = 0.0; }
      else if (gy < 2.3) {
        winMask = step(0.14, fract(vU / 0.62));                       // the lantern's bars
        if (inHole) glassShade = 1.35;
      } else {
        winMask *= step(0.62, fract(vZ / (fh * 1.6)));                // the odd port, rarely
        if (vVar > 0.55 && fract(vZ / (vTop * 0.5)) < 0.22)
          wall = mix(wall, vec3(0.520, 0.240, 0.200), 0.7);           // a painted band
      }
    }
    if (s == 94) {
      // THE BUTTRESS, stepping back a stage at every floor and rounded on its
      // face, and one ROSE WHEEL high on a single bay of the building. Twelve
      // spokes, cut out of the mask rather than drawn on it.
      float bw = 0.21 - 0.045 * floor(vZ / (fh * 1.15));
      float bt = 1.0 - smoothstep(0.0, max(bw, 0.07), min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * (1.18 - 0.32 * abs(f.x - 0.5) * 2.0), bt);
      if (bt > 0.5 && fract(vZ / (fh * 1.15)) < 0.06) wall *= 1.28;
      winMask *= 1.0 - bt;
      vec2 rp = vec2((f.x - 0.5) * colW, vZ - (vTop - fh * 1.7));
      float rr = length(rp);
      if (abs(floor(vU / colW) - (floor(vRand * 3.0) + 1.0)) < 0.5 && rr < 2.35) {
        float spk = abs(fract(atan(rp.y, rp.x) * 1.9099) - 0.5) * 2.0;
        winMask = step(rr, 2.0) * max(smoothstep(0.10, 0.26, spk), step(rr, 0.40));
      }
    }
    if (s == 95) {
      // CLAPBOARD, lit up each board's face with a hard shadow at the butt,
      // and a white casing round every opening with twelve-over-twelve muntins.
      float lap = fract(vZ / 0.145);
      wall *= 0.90 + 0.16 * smoothstep(0.0, 0.55, lap);
      wall *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.09, lap));
      float cas = step(abs(f.x - 0.5), win.x * 0.5 + 0.055)
                * step(abs(f.y - 0.52), win.y * 0.5 + 0.055);
      if (cas > 0.5 && !inHole) wall = mix(wall, vec3(0.780, 0.770, 0.730), 0.85);
      if (inHole) {
        float gx = fract(ox * 3.0), gy = fract(oy * 4.0);
        winMask *= 1.0 - 0.90 * (1.0 - smoothstep(0.0, 0.055,
                   min(min(gx, 1.0 - gx), min(gy, 1.0 - gy))));
      }
    }
    if (s == 96) {
      // THE HORSESHOE. Pinched at the jamb, swelling above the spring, then
      // closing — the one arch profile nothing else here has. Voussoirs round
      // it, ablaq banding across the wall, and a six-spoke wheel on one bay.
      float ah = (oy - 0.60) / 0.40;
      float hw = oy < 0.60 ? 0.86
               : sqrt(max(0.0, 0.36 - (ah - 0.28) * (ah - 0.28))) * 1.667;
      if (inHole) winMask *= step(abs(ox - 0.5) * 2.0, hw);
      float ang = atan(max(oy - 0.60, 0.0) * 2.2, (ox - 0.5) * 2.0);
      if (oy > 0.58 && winMask < 0.5) wall *= 0.88 + 0.26 * step(0.5, fract(ang * 2.9));
      wall *= 0.94 + 0.12 * step(0.5, fract(vZ / 0.62));
      vec2 rp2 = vec2((f.x - 0.5) * colW, vZ - (vTop - fh * 1.5));
      float rr2 = length(rp2);
      if (abs(floor(vU / colW) - (floor(vRand * 2.0) + 2.0)) < 0.5 && rr2 < 1.90) {
        float spk2 = abs(fract(atan(rp2.y, rp2.x) * 0.9549) - 0.5) * 2.0;
        winMask = step(rr2, 1.6) * max(smoothstep(0.10, 0.24, spk2), step(rr2, 0.32));
      }
    }
    if (s == 97) {
      // THE VERANDA. Every floor above the ground is half open: a recessed
      // band in deep shade behind slender posts, over a solid balustrade.
      float vy = f.y / 0.62;
      if (f.y < 0.62 && vZ > fh) {
        winMask = 1.0; glassShade = 0.30;
        float post = 1.0 - smoothstep(0.0, 0.06, abs(fract(vU / 2.15) - 0.5));
        if (post > 0.4 || vy < 0.34) { winMask = 0.0; wall = vec3(0.760, 0.740, 0.680); }
        if (vy < 0.34) wall *= 0.92 + 0.10 * step(0.5, fract(vU / 0.18));
      } else {
        wall *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.05, f.y - 0.63));
      }
    }
    if (s == 98) {
      // TWICE THE FLOOR FREQUENCY. A cell tier is half a storey, so the
      // openings refuse to line up with the floors — and they are barred.
      float tier = fract(vZ / (fh * 0.5));
      float ty = smoothstep(0.30, 0.34, tier) * (1.0 - smoothstep(0.72, 0.76, tier));
      winMask = ty * step(abs(f.x - 0.5), win.x * 0.5);
      if (vZ < fh * 1.2 || vZ > vTop - fh * 0.8) winMask = 0.0;
      if (winMask > 0.5) {
        float bar = fract((f.x - 0.5) * colW / 0.11);
        winMask *= smoothstep(0.0, 0.22, min(bar, 1.0 - bar));
      }
      wall *= 0.97 + 0.06 * hash(vec2(floor(vU / 1.25), floor(vZ / 0.62)));
      wall *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.05, fract(vZ / 0.62)));
    }
    if (s == 99) {
      // THE BATTLEMENT. Merlons and embrasures on a corbelled course, over a
      // battered base that catches the light because it leans back.
      float topd = vTop - vZ;
      if (topd < 1.7) {
        float gap = step(0.55, fract(vU / 2.3));
        wall = mix(wall * 1.06, wall * 0.42, gap * smoothstep(1.1, 0.75, topd));
        winMask = 0.0;
      }
      if (topd > 1.6 && topd < 2.4) wall *= 0.72 + 0.34 * step(0.5, fract(vU / 0.62));
      wall *= 1.0 + 0.16 * smoothstep(fh * 1.6, 0.0, vZ);
      if (vZ < fh * 1.5) winMask = 0.0;
      if (inHole) winMask *= step(abs(ox - 0.5), 0.5 - 0.10 * smoothstep(0.75, 1.0, oy));
    }
    if (s == 100) {
      // STONE MULLIONS, thick enough to read as structure, splitting the head
      // into four lights and one transom — under a drip hood stepped over it.
      if (inHole) {
        float mull = fract(ox * 4.0);
        winMask *= smoothstep(0.0, 0.10, min(mull, 1.0 - mull));
        winMask *= smoothstep(0.0, 0.045, abs(oy - 0.62));
        float lead = min(fract(ox * 16.0), fract(oy * 9.0));
        glassShade *= 0.90 + 0.14 * step(0.12, lead);
      }
      float hd = f.y - (0.52 + win.y * 0.5);
      if (!inHole && abs(f.x - 0.5) < win.x * 0.62) {
        if (hd > 0.0 && hd < 0.055) wall *= 1.22;
        else if (hd < 0.075 && hd > 0.055) wall *= 0.80;
      }
    }
    if (s == 101) {
      // THE THERMAL LUNETTE. One enormous half-round per bay, sitting on a
      // shadowed sill, split by two heavy mullions, with a moulded archivolt.
      vec2 q = vec2((f.x - 0.5) / max(win.x * 0.5, 0.001),
                    (f.y - 0.52 + win.y * 0.5) / max(win.y, 0.001));
      float rq = length(q);
      winMask = step(rq, 1.0) * step(0.0, q.y);
      winMask *= smoothstep(0.0, 0.06, abs(abs(q.x) - 0.34));
      if (rq > 1.0 && rq < 1.20 && q.y > -0.02) wall *= 1.16;
      if (q.y < -0.03 && q.y > -0.14) wall *= 0.86;
      wall *= 1.0 - 0.05 * (1.0 - smoothstep(0.0, 0.025, fract(vU / 0.61)));
      if (vZ < 1.1) wall *= 0.88 + 0.08 * step(0.5, fract(vU / 0.28));
    }
    if (s == 102) {
      // BLIND, until the last metre. The galleries are lit from the roof, so
      // the wall opens only in a clerestory ribbon under a deep cornice slot.
      if (vZ < vTop - fh * 0.85) winMask = 0.0;
      float jj = fract(vU / 1.55);
      wall *= 1.0 - 0.05 * (1.0 - smoothstep(0.0, 0.02, min(jj, 1.0 - jj)));
      wall *= 1.0 - 0.05 * (1.0 - smoothstep(0.0, 0.02, fract(vZ / 1.05)));
      if (vZ < fh * 1.15) wall *= 0.90 + 0.08 * step(0.5, fract(vZ / 0.55));
      float cz = vTop - vZ;
      if (cz < 1.5 && cz > 0.9) { wall *= 0.66; winMask = 0.0; }
      else if (cz < 0.9) wall *= 1.10;
    }
    if (s == 103) {
      // THE CLOISTER, at HALF the pitch of everything above it — which is the
      // tell, because no other building changes bay rhythm at the ground.
      if (vZ < fh * 1.05) {
        float dx = (fract(vU / (colW * 0.5)) - 0.5) * 2.0;
        float dy = (vZ / (fh * 1.05) - 0.46) / 0.42;
        float arch = dy > 0.0 ? length(vec2(dx / 0.62, dy)) : abs(dx) / 0.62;
        winMask = step(arch, 1.0); glassShade = 0.30;
        if (arch > 1.0 && arch < 1.16) wall *= 1.12;
      } else {
        if (inHole && oy > 0.86) winMask *= 1.0 - smoothstep(0.45, 0.95, abs(ox - 0.5) * 2.0);
        float sy = f.y - (0.52 - win.y * 0.5);
        if (sy < 0.0 && sy > -0.045 && abs(f.x - 0.5) < win.x * 0.62) wall *= 1.18;
      }
      wall *= 0.97 + 0.05 * hash(vec2(floor(vU / 0.7), floor(vZ / 0.7)));
    }
    if (s == 82) {
      // THE STACKED PORCHES. One per floor, the full width of the front, with
      // a rail and a deep shadow behind — and the porch is set BACK from the
      // wall, so what you read is a column of dark with a pale rail across it
      // at every level. The porches are the building.
      float fy = fract(v);
      if (f.x > 0.12 && f.x < 0.88) {
        if (fy < 0.10) { wall = mix(wall, wall * 1.22, 0.9); winMask = 0.0; }        // deck edge
        else if (fy < 0.34) { wall = mix(wall, wall * 1.06, 0.55); winMask = 0.0; }  // the rail
        else if (fy < 0.80) { wall = mix(wall, wall * 0.42, 0.88); winMask *= 0.35; } // in shade
        else { wall = mix(wall, wall * 1.14, 0.7); winMask = 0.0; }                   // the beam
        // the posts at each end of the porch
        float pst = max(1.0 - smoothstep(0.12, 0.17, f.x), 1.0 - smoothstep(0.12, 0.17, 1.0 - f.x));
        if (pst > 0.0) wall = mix(wall, wall * 1.30, pst * 0.9);
      } else {
        wall *= 0.955 + 0.055 * step(0.5, fract(vZ / 0.22));    // clapboard beyond
      }
    }
    if (s == 83 || s == 90) {
      // CLAPBOARD, and one big opening. The shotgun puts its door and window
      // on a front one room wide; the ranch runs a picture window and a garage
      // door along a front five rooms long. Same siding, opposite proportion.
      wall *= 0.955 + 0.055 * step(0.5, fract(vZ / 0.21));
      if (s == 90 && vZ < fh * 0.95) {
        float t = fract(vU / 11.0);
        if (t > 0.58 && t < 0.92) { wall = mix(wall, wall * 0.60, 0.85); winMask = 0.0; }  // garage
      }
    }
    if (s == 84) {
      // THE GAMBREL comes down OVER the wall head, so the top of the wall is
      // roof: a dark band with a flared kick at its bottom edge where the eave
      // turns out. Below it, clapboard.
      float head = vTop - vZ;
      if (head < fh * 0.95) {
        wall = mix(wall, vec3(0.300, 0.270, 0.250), 0.88);
        winMask *= 0.4;
        if (head > fh * 0.80) wall = mix(wall, wall * 1.35, 0.7);   // the flare
      } else {
        wall *= 0.955 + 0.055 * step(0.5, fract(vZ / 0.22));
      }
    }
    if (s == 85 || s == 86) {
      // THE PORCH ACROSS THE FRONT, and what is over it. A foursquare carries
      // a plain post; a bungalow's pier is BATTERED — wide at the bottom,
      // narrowing as it rises — which is the one detail that names the type.
      if (vZ < fh * 1.05) {
        float t = fract(vU / 3.6);
        float taper = s == 86 ? (0.30 - 0.13 * (vZ / (fh * 1.05))) : 0.17;
        float pst = 1.0 - smoothstep(taper * 0.55, taper, min(t, 1.0 - t));
        wall = mix(wall * 0.44, wall * 1.20, pst);
        winMask = 0.0;
        if (vZ > fh * 0.92) wall = mix(wall, wall * 1.22, 0.8);     // the porch beam
      }
    if (s == 86 && vTop - vZ < 0.85) {
        // exposed rafter tails under a deep eave, which is the other half of it
        float rt = fract(vU / 0.78);
        wall = mix(wall, wall * 0.55, (1.0 - smoothstep(0.0, 0.22, min(rt, 1.0 - rt))) * 0.8);
      }
    }
    if (s == 87) {
      // A HUNDRED IDENTICAL WINDOWS. Nothing else — no bands, no base, no top.
      // What reads is the FREQUENCY: these openings are half the size of a
      // flat's and there are twice as many, and that alone says what it is.
      if (fract(vZ / fh) < 0.06) wall *= 0.96;
      if (inHole && oy > 0.92) wall = mix(wall, wall * 1.12, 0.6);   // a thin lintel
    }
    if (s == 88 || s == 89) {
      // THE BAY. Carried the full height on a mansion block, bowed and stopping
      // under the parapet on a two-flat. Drawn as a projection: bright on the
      // face, shaded on the return the sun is not on, with the wall beside it
      // dropping back.
      float t = fract(vU / (s == 88 ? 9.2 : 7.4));
      float inBay = smoothstep(0.14, 0.20, t) * (1.0 - smoothstep(0.66, 0.72, t));
      float lo = (vZ > fh * (s == 89 ? 0.85 : 0.0)) ? 1.0 : 0.0;
      if (inBay > 0.01 && (s == 88 || lo > 0.5) && vZ < vTop - 0.9) {
        float across = clamp((t - 0.17) / 0.49, 0.0, 1.0);
        float face = sin(across * 3.14159265);
        float sunK = dot(SUN_DIR, T) > 0.0 ? across : 1.0 - across;
        wall = mix(wall, wall * (0.78 + 0.42 * face) * (0.90 + 0.22 * sunK), inBay);
        // the returns are cheeks, so no window on them
        if (across < 0.16 || across > 0.84) winMask = 0.0;
      } else if (inBay <= 0.01) {
        wall *= 0.93;                                   // the wall behind the bay
      }
      if (s == 89 && vZ < fh * 0.85) { wall *= 0.90; winMask *= 0.5; }   // raised basement
    }
    if (s == 91) {
      // THE BREEZEWAY. Open stairs cut clean through the block every few bays,
      // so the building has a dark slot in it from grade to eaves — no other
      // housing type does that and it is visible from the air.
      float t = fract(vU / 17.0);
      if (t > 0.40 && t < 0.56) {
        wall = mix(wall, wall * 0.28, 0.92);
        winMask = 0.0;
        // the stair flights crossing the slot
        float fl2 = fract(v * 1.0 + (t - 0.40) * 3.0);
        if (fl2 < 0.16) wall = mix(wall, wall * 2.2, 0.5);
      }
    }
    if (s == 92) {
      // THE PORTE-COCHERE. One carriage arch cut into the middle of the base,
      // two storeys high, with the same window ninety times above it.
      float t = fract(vU / 38.0);
      if (vZ < fh * 1.9 && t > 0.42 && t < 0.58) {
        float head = smoothstep(0.55, 0.95, vZ / (fh * 1.9));
        float cut = 1.0 - smoothstep(0.72 - head * 0.55, 0.99, abs((t - 0.5) / 0.08) + head);
        wall = mix(wall, vec3(0.180, 0.165, 0.150), cut * 0.95);
        if (cut > 0.4) winMask = 0.0;
      }
      if (vZ < fh * 1.9) wall *= 0.95 + 0.06 * step(0.5, fract(vZ / 0.86));   // rustication
    }
    if (s == 93) {
      // ONE ROOM PER FLOOR. Tight rhythm, tiny openings, a flat stone lintel
      // on each, and a party wall you can see because the chimney stack sits
      // on it every second house.
      if (inHole && (oy > 0.94 || oy < 0.06)) wall = mix(wall, vec3(0.620, 0.600, 0.565), 0.5);
      float pw = fract(vU / 5.0);
      if (pw < 0.035 || pw > 0.965) wall = mix(wall, wall * 1.08, 0.7);
    }
    if (s == 75) {
      // THE PANEL JOINT. A 20 mm gap down every panel, full height, and a
      // shallow reveal band cast across the face — those two lines are the
      // entire architecture of a tilt-up and they are both free.
      float j = min(f.x, 1.0 - f.x);
      wall *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.012, j));
      float rv = fract(vZ / 2.35);
      wall *= 1.0 - 0.13 * (1.0 - smoothstep(0.0, 0.09, min(rv, 1.0 - rv)));
      // the taller entry element, once per building, with the only glass on it
      float ent = 1.0 - smoothstep(0.0, 0.30, abs(fract(vU / 62.0) - 0.20));
      if (ent > 0.5) {
        wall = mix(wall, wall * 1.10, 0.6);
        if (vZ > fh * 0.35 && vZ < fh * 1.25) { winMask = 1.0; }
      } else if (vZ < fh * 0.92 && fract(vU / 9.2) > 0.30 && fract(vU / 9.2) < 0.78) {
        wall = mix(wall, wall * 0.42, 0.9);       // a dock door
        winMask = 0.0;
      }
    }
    if (s == 76 || s == 79) {
      // DOCK DOORS, and nothing else. Every nine metres, a recessed leaf with
      // a bumper each side and a shallow canopy over it. On a cross-dock the
      // same run happens on the far side too, which you read in the roof.
      float t = fract(vU / 9.2);
      if (vZ < fh * 0.86) {
        if (t > 0.24 && t < 0.80) { wall = mix(wall, wall * 0.38, 0.92); }
        else if (t > 0.16 && t < 0.88) wall = mix(wall, wall * 1.10, 0.5);   // the jamb
      } else if (vZ < fh * 1.02 && t > 0.14 && t < 0.90) {
        wall = mix(wall, wall * 1.18, 0.75);      // the canopy
      }
      // the panelised skin above the doors
      float rib = fract(vU / 0.92);
      wall *= 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.05, min(rib, 1.0 - rib)));
    }
    if (s == 77) {
      // TWO BUILDINGS ON ONE SLAB. The office end is glazed and has a floor
      // line; the warehouse end is ribbed metal with none. The seam between
      // them is abrupt on purpose — nobody blends them in life either.
      float office = step(fract(vU / 54.0), 0.34);
      if (office > 0.5) {
        if (fract(v) < 0.14) { wall = mix(wall, wall * 1.12, 0.8); winMask = 0.0; }
      } else {
        float rib = fract(vU / 0.30);
        wall *= 1.0 + 0.11 * sin(rib * 6.2831853) * sign(dot(SUN_DIR, T));
        winMask = 0.0;
      }
    }
    if (s == 78) {
      // THE ARCH. A half-cylinder read as shading rather than as geometry:
      // brightest where the surface faces up, falling away hard to the eaves,
      // with the corrugation running over the top of it.
      float t = clamp(vZ / max(vTop, 1.0), 0.0, 1.0);
      wall *= 0.62 + 0.55 * sin(t * 3.14159265 * 0.85 + 0.25);
      float rib = fract(vU / 0.26);
      wall *= 1.0 + 0.10 * sin(rib * 6.2831853);
      if (vZ < fh * 0.7 && abs(fract(vU / 17.0) - 0.5) < 0.24) {
        wall = mix(wall, wall * 0.55, 0.85); winMask = 0.0;   // the end door
      }
    }
    if (s == 80) {
      // ROLLER DOORS, identically, for as far as the building goes — and one
      // band of the operator's colour along the top, which is the only thing
      // anybody remembers about the building.
      float t = fract(vU / 3.0);
      float fy = fract(v);
      if (fy > 0.18 && fy < 0.86 && t > 0.10 && t < 0.90) {
        wall = mix(wall, wall * 0.72, 0.85);
        // the corrugations of the shutter itself
        wall *= 1.0 - 0.10 * (1.0 - smoothstep(0.0, 0.06, min(fract(vZ / 0.16), 1.0 - fract(vZ / 0.16))));
      }
      if (vZ > vTop - fh * 0.5) {
        vec3 band = vec3(0.62 + 0.26 * vVar, 0.32 + 0.20 * fract(vVar * 4.3), 0.22 + 0.16 * fract(vVar * 7.1));
        wall = mix(wall, band, 0.72);
      }
    }
    if (s == 81) {
      // LOUVRE BANKS. Where the air goes in and out, in tall recessed panels
      // with a fine horizontal blade pitch — the only relief on the whole box,
      // and the reason you can tell it from a warehouse.
      float t = fract(vU / 10.4);
      if (t > 0.14 && t < 0.52 && vZ > fh * 0.35 && vZ < vTop - fh * 0.3) {
        float bl = fract(vZ / 0.22);
        wall = mix(wall, wall * (0.52 + 0.30 * bl), 0.9);
      }
      float pj = min(f.x, 1.0 - f.x);
      wall *= 1.0 - 0.14 * (1.0 - smoothstep(0.0, 0.02, pj));
    }
    if (s == 61 || s == 62 || s == 63) {
      // THE UPPER FLOOR IS DIFFERENT FROM THE LOWER ONE, which is the whole
      // grammar of these three: shingle over clapboard, half-timber over
      // render, boards over boards. Below, horizontal siding; above, the
      // pattern the style is named for.
      float upper = step(fh * 1.55, vZ);
      if (upper < 0.5) {
        wall *= 0.955 + 0.055 * step(0.5, fract(vZ / 0.24));      // clapboard
      }
    if (s == 61) {
        vec2 sc = vec2(vU / 0.42, vZ / 0.30);                     // shingle courses
        float row = floor(sc.y);
        float off = fract(sc.x + row * 0.5);
        wall *= 0.90 + 0.16 * fract(hash(vec2(floor(sc.x + row * 0.5), row)) * 3.1);
        wall *= 1.0 - 0.20 * (1.0 - smoothstep(0.0, 0.10, min(off, 1.0 - off)));
      }
    if (s == 63) {
        float bx = 1.0 - smoothstep(0.055, 0.10, min(fract(vU / 1.35), 1.0 - fract(vU / 1.35)));
        float bz = 1.0 - smoothstep(0.05, 0.09, min(fract(vZ / 1.5), 1.0 - fract(vZ / 1.5)));
        float dg = 1.0 - smoothstep(0.40, 0.48, abs(fract(vU / 2.4 + vZ / 2.4) - 0.5) * 2.0);
        wall = mix(wall, vec3(0.185, 0.145, 0.115), clamp(max(bx, max(bz, dg * 0.8)), 0.0, 1.0) * 0.92);
      } else {
        float bx = 1.0 - smoothstep(0.05, 0.09, min(fract(vU / 1.15), 1.0 - fract(vU / 1.15)));
        float bz = 1.0 - smoothstep(0.05, 0.09, min(fract(vZ / 1.9), 1.0 - fract(vZ / 1.9)));
        wall = mix(wall, wall * 0.58, clamp(bx + bz, 0.0, 1.0) * 0.85);
      }
    }
    if (s == 64) {
      // THE PENT. A little tiled roof running over the openings, and the
      // stucco below it kept deliberately smooth — no coursing anywhere.
      float fy = fract(v);
      if (fy > 0.80 && fy < 0.90) { wall = mix(wall, vec3(0.470, 0.290, 0.225), 0.85); winMask = 0.0; }
      else if (fy >= 0.90) wall *= 0.90;
    }
    if (s == 65) {
      // THE MARQUEE, and the blade. A deep lit canopy across the whole
      // frontage at first-floor level with the box blank above it, and one
      // vertical sign running up past the parapet.
      if (vZ < fh * 1.5) {
        if (vZ > fh * 0.95 && vZ < fh * 1.32) {
          wall = mix(wall, vec3(0.780, 0.700, 0.470), 0.9);       // the marquee
          winMask = 0.0;
        } else if (vZ <= fh * 0.95) {
          wall = mix(wall, wall * 0.72, 0.7); winMask = 0.0;      // its shadow, and the lobby
        }
      }
      float blade = 1.0 - smoothstep(0.02, 0.055, abs(fract(vU / 34.0) - 0.12));
      if (blade > 0.0 && vZ > fh * 1.2) wall = mix(wall, vec3(0.620, 0.245, 0.215), blade * 0.9);
    }
    if (s == 66) {
      // STAINLESS FLUTES the whole length, and a band of glass at counter
      // height. The flutes are what makes a railcar read as a railcar.
      float fl = fract(vZ / 0.115);
      wall *= 0.90 + 0.20 * sin(fl * 6.2831853);
      if (vZ > vTop - 0.55 || vZ < 0.7) wall = mix(wall, wall * 1.22, 0.8);
    }
    if (s == 67) {
      // APPARATUS DOORS. Most of the ground floor, arched, and set in a
      // surround — an engine has to get out and the opening says so.
      if (vZ < fh * 1.02 && vTop > fh * 1.6) {
        float t = fract(vU / 5.6);
        if (t > 0.10 && t < 0.90) {
          float head = smoothstep(0.66, 0.99, vZ / (fh * 1.02));
          float cut = 1.0 - smoothstep(0.70 - head * 0.55, 0.99, abs(t - 0.5) * 2.0 + head);
          wall = mix(wall, vec3(0.300, 0.235, 0.190), cut * 0.95);
          winMask = 0.0;
        }
      }
    }
    if (s == 68) {
      // BANKS OF THREE. A classroom is lit from one side, so the windows come
      // in threes with a pier between each group and nothing between the three.
      if (inHole) {
        float m1 = abs(ox - 0.3333), m2 = abs(ox - 0.6667);
        winMask *= 1.0 - (1.0 - smoothstep(0.0, 0.022, min(m1, m2))) * 0.9;
      }
      if (fract(vZ / fh) < 0.10) wall *= 0.94;                    // the spandrel course
    }
    if (s == 69 || s == 70) {
      // THE GIANT ORDER, and the blind plinth under it. Two storeys of solid
      // ashlar — a library keeps books behind it, a bank keeps money — then
      // columns running three floors, then a heavy entablature.
      float baseTop = fh * (s == 70 ? 2.0 : 1.35);
      if (vZ < baseTop) {
        wall *= 0.955 + 0.055 * step(0.5, fract(vZ / 0.92));      // coursed ashlar
        winMask = 0.0;
      } else if (vZ > vTop - fh * 0.85) {
        wall *= 1.06; winMask = 0.0;                              // the entablature
      } else {
        float d = min(f.x, 1.0 - f.x);
        float col = 1.0 - smoothstep(0.15, 0.27, d);
        float belly = smoothstep(0.27, 0.0, d);
        wall = mix(wall, wall * (0.84 + 0.40 * belly), col);
        winMask *= 1.0 - col;
        if (s == 69 && inHole && oy > 0.78) {                     // arched reading room
          float spring = smoothstep(0.78, 1.0, oy);
          float rad = sqrt(max(0.0, 1.0 - spring * spring));
          winMask *= 1.0 - smoothstep(rad - 0.16, rad + 0.02, abs(ox - 0.5) * 2.0 * spring);
        }
      }
    }
    if (s == 71) {
      // THREE PARTS AND A CANOPY. Rusticated base, a banded middle of
      // identical bedroom windows, a cornice — and a canopy over the door,
      // which is the one asymmetric thing on the whole front.
      if (vZ < fh * 1.9) wall *= 0.94 + 0.07 * step(0.5, fract(vZ / 0.88));
      if (fract(vZ / fh) < 0.08) wall *= 0.93;                    // the sill band
      float dcan = 1.0 - smoothstep(0.0, 0.22, abs(fract(vU / 31.0) - 0.28));
      if (dcan > 0.0 && vZ > fh * 0.85 && vZ < fh * 1.12) {
        wall = mix(wall, vec3(0.360, 0.235, 0.215), dcan * 0.9); winMask = 0.0;
      }
    }
    if (s == 72) {
      // CONTINUOUS DISPLAY GLAZING. The wall is reduced to a slim column
      // between bays and a slab band at each floor — the whole building is a
      // shop window and that is why it feels different from an office.
      float col = 1.0 - smoothstep(0.0, 0.045, min(f.x, 1.0 - f.x));
      float band = 1.0 - smoothstep(0.0, 0.11, min(f.y, 1.0 - f.y));
      wall = mix(wall, wall * 1.10, max(col, band));
      winMask *= 1.0 - clamp(col + band, 0.0, 1.0);
    }
    if (s == 73) {
      // THE OUTDOOR WALKWAY. A deck and a rail at every floor with all the
      // doors on it, and the recess behind in permanent shade.
      float fy = fract(v);
      if (fy < 0.12) { wall = mix(wall, wall * 1.22, 0.9); winMask = 0.0; }        // deck nose
      else if (fy < 0.30) { wall = mix(wall, wall * 1.02, 0.6); winMask *= 0.3; }  // the rail
      else if (fy < 0.42) { wall = mix(wall, wall * 0.46, 0.85); winMask = 0.0; }  // under it
      float dr = step(0.55, hash(vec2(floor(u) + 9.0, floor(v))));
      if (dr > 0.5 && fy > 0.42 && fy < 0.92 && abs(f.x - 0.5) < 0.16) {
        wall = mix(wall, vec3(0.290, 0.245, 0.215), 0.85); winMask = 0.0;
      }
    }
    if (s == 74) {
      // THE CANOPY AND THE SIGN BAND. One deep shadow line the whole length,
      // glazing under it, and each unit's colour painted above.
      if (vZ < fh * 1.25) {
        if (vZ > fh * 0.86) {
          float unit = hash(vec2(floor(vU / 9.5), floor(vRand * 11.0)));
          wall = mix(wall, vec3(0.32 + 0.42 * unit, 0.30 + 0.26 * fract(unit * 6.1), 0.28 + 0.30 * fract(unit * 2.3)), 0.72);
          winMask = 0.0;
        } else {
          wall = mix(wall, wall * 0.62, 0.55);                    // the canopy's shade
        }
      }
    }
    if (s == 51 || s == 60) {
      // THE ENGINE HALL. One room, so the bay is the height of the building and
      // the pier between bays is a buttress rather than a mullion — heavy,
      // stepped in at the top, with the arch springing off it. A round head on
      // an opening four storeys tall is unmistakable.
      float pil = 1.0 - smoothstep(0.0, 0.14, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.12, pil);
      if (inHole) {
        float spring = smoothstep(0.72, 1.0, oy);
        float rad = sqrt(max(0.0, 1.0 - spring * spring));
        winMask *= 1.0 - smoothstep(rad - 0.18, rad + 0.02, abs(ox - 0.5) * 2.0 * spring);
        // the glazing bars of an industrial sash, which are a real grid
        float gx = abs(fract(ox * 5.0) - 0.5), gy = abs(fract(oy * 8.0) - 0.5);
        winMask *= 1.0 - clamp((1.0 - smoothstep(0.34, 0.48, gx)) + (1.0 - smoothstep(0.34, 0.48, gy)), 0.0, 1.0) * 0.75;
      }
      if (vZ < fh * 0.9) wall *= 0.94;                  // a plinth of engineering brick
    }
    if (s == 52) {
      // THE COLD STORE. What the wall has instead of windows is a stack of
      // LOADING DOORS in one bay, floor after floor, each with its hoist beam
      // over it — the only thing on a hundred feet of blank brick.
      float dBay = step(0.72, hash(vec2(floor(u) + 4.0, floor(vRand * 17.0))));
      if (dBay > 0.5 && abs(f.x - 0.5) < 0.30) {
        float fy = fract(v);
        if (fy > 0.12 && fy < 0.72) { wall = mix(wall, vec3(0.24, 0.22, 0.20), 0.88); winMask = 0.0; }
        else if (fy >= 0.72 && fy < 0.80) wall = mix(wall, wall * 1.18, 0.7);   // the hoist beam
      }
      // pilaster strips, which is all the relief a blank wall ever gets
      float ps = 1.0 - smoothstep(0.0, 0.06, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.07, ps);
    }
    if (s == 53) {
      // SEGMENTAL ARCHES and a corbelled brick band under the eaves. A brewery
      // was a proud building in a way a warehouse never was.
      if (inHole && oy > 0.84) winMask *= 1.0 - smoothstep(0.50, 0.94, abs(ox - 0.5) * 2.0);
      float br = vTop - vZ;
      if (br < 1.9 && br > 0.5) {
        float t = fract(vU / 1.15);
        wall *= 1.0 - 0.20 * (1.0 - smoothstep(0.0, 0.26, min(t, 1.0 - t)));
      }
    }
    if (s == 54) {
      // STEEL SASH. A real glazing grid — small panes in a heavy frame — and a
      // solid plinth up to waist height because nobody glazes what gets hit.
      if (vZ < fh * 0.55) { winMask = 0.0; wall *= 0.95; }
      else if (inHole) {
        float gx = abs(fract(ox * 6.0) - 0.5), gy = abs(fract(oy * 7.0) - 0.5);
        winMask *= 1.0 - clamp((1.0 - smoothstep(0.32, 0.47, gx)) + (1.0 - smoothstep(0.32, 0.47, gy)), 0.0, 1.0) * 0.8;
      }
    }
    if (s == 55) {
      // THE DRUMS. Slip-formed silos stand in a row and each one is a cylinder,
      // so the wall is a series of vertical lobes — lit down one flank, shaded
      // down the other, with a hard seam where two drums meet. The pour lines
      // ring the whole thing every metre and a half.
      float drum = fract(vU / 7.6);
      float lobe = sin(drum * 3.14159265);
      wall *= 0.74 + 0.42 * lobe;
      wall *= 1.0 - 0.26 * (1.0 - smoothstep(0.0, 0.06, min(drum, 1.0 - drum)));
      wall *= 0.985 + 0.03 * step(0.5, fract(vZ / 1.55));
    }
    if (s == 56) {
      // THE GUIDE FRAME. Lattice columns round the tank with lattice girders
      // ringing them — mostly air, and what you actually read is the ironwork
      // against the sky rather than any wall at all.
      float col = 1.0 - smoothstep(0.055, 0.12, min(f.x, 1.0 - f.x));
      float ring = 1.0 - smoothstep(0.0, 0.05, min(fract(vZ / 6.4), 1.0 - fract(vZ / 6.4)));
      float diag = 1.0 - smoothstep(0.30, 0.44, abs(fract(vU / 3.1 + vZ / 6.4) - 0.5) * 2.0);
      float iron = clamp(max(col, max(ring, diag * 0.7)), 0.0, 1.0);
      wall = mix(wall * 0.55, wall * 1.25, iron);
      // the tank inside, which only reaches part way up
      if (vZ < vTop * 0.55) wall = mix(wall, wall * 0.88 + vec3(0.04), 0.5);
    }
    if (s == 57) {
      // THE PORTAL FRAME. Profiled sheet with a rib every 300 mm, the crane
      // rail expressed as a heavy band at gantry height, and one enormous door.
      float rib = fract(vU / 0.30);
      wall *= 1.0 + 0.13 * sin(rib * 6.2831853) * sign(dot(SUN_DIR, T));
      float rail = 1.0 - smoothstep(0.0, 0.55, abs(vZ - vTop * 0.62));
      wall = mix(wall, wall * 0.82, rail * 0.8);
      if (vZ < vTop * 0.46 && abs(fract(vU / 26.0) - 0.5) < 0.22) {
        wall = mix(wall, wall * 0.66, 0.85);            // the door leaf
        winMask = 0.0;
      }
    }
    if (s == 58) {
      // THE MILL BAY, repeated without mercy, and the STAIR TOWER that is the
      // only thing that breaks it: one bay running the full height with no
      // floor line in it and a different brick.
      if (fract(vZ / fh) < 0.09) wall *= 0.93;          // the floor band
      float tw = fract(vU / 46.0);
      if (tw > 0.02 && tw < 0.13) {
        wall = mix(wall, wall * 1.10, 0.8);
        if (inHole) winMask *= 0.55;                    // slit windows up the stair
      }
    }
    if (s == 59) {
      // THE PLATFORM CANOPY. At street level the building is a colonnade with
      // deep shade behind it, and the fascia runs the whole length above.
      float cH = fh * 1.25;
      if (vZ < cH) {
        float t = fract(vU / 3.9);
        float colm = 1.0 - smoothstep(0.10, 0.20, min(t, 1.0 - t));
        wall = mix(wall * 0.34, wall * 1.06, colm);     // shade, and the iron column in it
        winMask = 0.0;
        if (vZ > cH - 0.9) { wall = mix(wall, wall * 1.14, 0.85); }   // the fascia
      }
    }
    if (s == 46) {
      // THE PIER. A deep terracotta or bronze fin standing off the face, with
      // the glass in the slot behind it. Two things sell it: the pier is
      // ROUNDED, so it carries a highlight up its whole height, and it is
      // deep enough that the return catches shade on the shadow side. There
      // is deliberately nothing horizontal — no floor line, no spandrel.
      float d = min(f.x, 1.0 - f.x);
      float pier = 1.0 - smoothstep(0.11, 0.20, d);
      float belly = smoothstep(0.20, 0.0, d);                 // across the fin's face
      float sideK = dot(SUN_DIR, T) > 0.0 ? f.x : 1.0 - f.x;
      wall = mix(wall, wall * (0.80 + 0.52 * belly) * (0.86 + 0.30 * sideK), pier);
      winMask *= 1.0 - pier;
      // and the reveal the fin casts onto the glass beside it
      if (inHole) glassShade = 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.30, sideK));
    }
    if (s == 47) {
      // THE DEEP FRAME. Every opening sits at the back of a half-metre box, so
      // the head and one jamb are in shade and the sill is catching. At this
      // depth the frame reads before the glass does, which is the whole point
      // of the type — the building is a grid of shadows.
      float fr = max(1.0 - smoothstep(0.0, 0.13, min(f.x, 1.0 - f.x)),
                     1.0 - smoothstep(0.0, 0.13, min(f.y, 1.0 - f.y)));
      wall = mix(wall, wall * 1.14, fr);
      if (inHole) {
        float sunSide = dot(SUN_DIR, T) > 0.0 ? ox : 1.0 - ox;
        float jambK = 1.0 - smoothstep(0.0, 0.40, sunSide);
        float headK = smoothstep(0.58, 1.0, oy);
        glassShade = 1.0 - 0.46 * jambK - 0.30 * headK;
        glassShade *= 1.0 + 0.20 * (1.0 - smoothstep(0.0, 0.16, oy));   // the sill kicks light back
      }
    }
    if (s == 48) {
      // THE SHELF. A painted steel plate standing proud at every floor: bright
      // on its top face, black underneath, and the glass under it in shade for
      // a good part of a storey. The band is at FLOOR frequency and it is the
      // only thing you read on the building.
      float fy = fract(v);
      if (fy > 0.90) { wall = mix(wall, wall * 1.30, 0.92); winMask = 0.0; }   // the plate, lit
      else if (fy > 0.84) { wall = mix(wall, wall * 0.30, 0.90); winMask = 0.0; } // its underside
      else if (inHole) glassShade = mix(1.0, 0.72, smoothstep(0.58, 0.84, fy)); // shelf shade
    }
    if (s == 49) {
      // THE UNITISED WALL. A slim mullion cap every bay and a tint that steps
      // panel to panel, because the units were coated in batches and no two
      // batches match. Both are tiny; together they are the difference between
      // a modern tower and a mirror.
      float mull = 1.0 - smoothstep(0.010, 0.030, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.35 + vec3(0.03), mull);
      winMask *= 1.0 - mull * 0.85;
      float batch = hash(vec2(floor(u) * 0.37, floor(v / 3.0) + vRand * 23.0));
      if (inHole) glassShade = 0.93 + 0.14 * batch;
    }
    if (s == 50) {
      // MEGA PANELS. The unit is two storeys, so the expressed slab edge comes
      // at half the frequency of the floors — and between the two, at the
      // intermediate level, there is nothing at all. That mismatch is the tell.
      float p2 = fract(v * 0.5);
      if (p2 < 0.085) {
        wall = mix(wall, wall * 0.42, 0.92);                  // the shadow box
        winMask = 0.0;
      } else if (p2 < 0.125) {
        wall = mix(wall, wall * 1.26, 0.85);                  // its lit lower lip
        winMask = 0.0;
      }
      float mull = 1.0 - smoothstep(0.012, 0.032, min(f.x, 1.0 - f.x));
      wall = mix(wall, wall * 1.22, mull);
      winMask *= 1.0 - mull * 0.7;
    }
    if (s == 45) {
      // BIG BOX: split-face block coursing, and the tenant's colour on the
      // parapet band. The band is the only thing on the building.
      wall *= 0.96 + 0.07 * step(0.5, fract(vZ / 0.41));
      if (vZ > vTop - fh * 0.75) {
        vec3 sign_ = vec3(0.30 + 0.50 * vVar, 0.26 + 0.30 * fract(vVar * 5.3), 0.24 + 0.36 * fract(vVar * 2.7));
        wall = mix(wall, sign_, 0.72);
      }
    }
  }

  // ---- glass: per-window life + sky reflection ----------------------------
  float wid = hash(vec2(floor(u) + vRand * 61.0, floor(v)));
  vec3 glass = mix(glassA, glassB, clamp(vZ / max(vTop, 1.0), 0.0, 1.0));
  if (s == 15) {
    // LOW-IRON GLASS IS NEARLY COLOURLESS FACE-ON AND SATURATES HARD AT A
    // GRAZING ANGLE. It is the whole optical signature of an all-glass tower —
    // the face you are looking at is pale and the returns running away from you
    // go deep blue-green — and it is why one building can look like several
    // from a single viewpoint. One dot product.
    float graze = 1.0 - abs(dot(n, Vw));
    glass = mix(glass, glass * vec3(0.60, 0.86, 0.97), graze * graze * 0.85);
  }
  glass = mix(glass, glass * 1.25, step(0.82, wid));
  glass = mix(glass, glass * 0.72, step(wid, 0.14));

  // ---- what is actually behind the glass -----------------------------------
  // A WINDOW IS A HOLE, AND UNTIL NOW IT HAS BEEN A PAINTED ONE. Everything
  // above gives the opening depth in the MASONRY — the reveal, the jamb the
  // sun stands behind, the head it hangs under — and then stops dead at a flat
  // pane with a bit of sky on it. What was missing is the room. It is the
  // reason a real facade reads as a hundred separate boxes stacked up rather
  // than as one gridded surface, and no amount of work on the stonework around
  // the opening can stand in for it.
  //
  // Interior mapping, after van Dongen: walk the view ray into a virtual box
  // sitting behind the pane and shade whichever of its planes the ray reaches
  // first. It is analytic — no texture, no loop, three divides — and because
  // the box is anchored to the BUILDING rather than to the screen, the
  // parallax is correct from every angle and every distance: look along a
  // facade and you see the side walls, look square at it and you see the back
  // of the room. Each room takes its brightness and depth from a hash of its
  // own cell, so no two floors of the same tower come out stamped.
  //
  // Gated on the same LOD term the reveal uses. At the zoom where a floor is
  // four pixels tall there is nothing to see inside it and it would only
  // alias.
  if (near > 0.05 && winMask > 0.01) {
    float ix = clamp((f.x - m.x) / max(win.x, 0.001), 0.0, 1.0);
    float iy = clamp((f.y - m.y - 0.04) / max(win.y, 0.001), 0.0, 1.0);
    float rn = max(dot(n, Vw), 0.05);
    // how far the ray slides across the opening per metre it travels inward,
    // expressed in the opening's own 0..1 coordinates
    float sx = (dot(-Vw, T) / rn) / max(win.x * colW, 0.05);
    float sy = ((-Vw).z / rn) / max(win.y * fh, 0.05);
    float roomD = mix(2.2, 3.4, hash(vec2(floor(u) * 3.1, floor(v) * 1.9)));
    float tx = abs(sx) > 1e-5 ? ((sx > 0.0 ? 1.0 - ix : -ix) / sx) : 1e9;
    float ty = abs(sy) > 1e-5 ? ((sy > 0.0 ? 1.0 - iy : -iy) / sy) : 1e9;
    float t = roomD; int face = 0;          // 0 back wall, 1 side wall, 2 up/down
    if (tx < t) { t = tx; face = 1; }
    if (ty < t) { t = ty; face = 2; }

    vec3 room;
    if (face == 0)      room = vec3(0.44, 0.42, 0.385);                     // back wall
    else if (face == 1) room = vec3(0.28, 0.27, 0.255);                     // a side wall, edge-on to the light
    else                room = sy > 0.0 ? vec3(0.58, 0.57, 0.535)           // ceiling, pale, catches the opening
                                        : vec3(0.20, 0.185, 0.165);         // floor
    // deeper into the room is darker: the only light in there came in through
    // the hole we are looking through
    room *= mix(1.0, 0.40, clamp(t / roomD, 0.0, 1.0));
    // and one room is not another — blinds down, lights on, empty shell
    room *= 0.62 + 0.62 * hash(vec2(floor(u) * 1.7 + 5.0, floor(v) * 2.3));

    glass = mix(glass, room, 0.74 * near);
  }

  vec3 V = Vw;
  vec3 R = reflect(-V, n);
  // WHAT A GLASS WALL IS ACTUALLY LOOKING AT.
  //
  // Two colours lerped by height gave every reflective surface in this city the
  // same soft grey-blue wash, which is most of why the glass towers read as
  // pale boxes rather than as mirrors. A real environment has three parts and a
  // glass building shows you all of them down its own height at once: the dark
  // ground below the horizon, the bright band at the horizon itself — which is
  // the brightest thing in any outdoor scene that is not the sun — and the deep
  // sky above it. The transition at the horizon is sharp, which is exactly the
  // hard line you see running across a curtain wall.
  //
  // And then the sun, tight and very bright, because a tower flaring as you
  // pass it is the single most recognisable thing glass does.
  float rz = R.z;
  vec3 sky = rz < 0.0
    ? mix(vec3(0.345, 0.325, 0.292), vec3(0.845, 0.860, 0.870), clamp(rz * 2.8 + 1.0, 0.0, 1.0))
    : mix(vec3(0.845, 0.860, 0.870), vec3(0.315, 0.505, 0.795), clamp(rz * 1.45, 0.0, 1.0));
  sky += SUN_COL * pow(max(dot(normalize(R), SUN_DIR), 0.0), 300.0) * 2.4;
  float fres = pow(1.0 - abs(dot(n, V)), 2.0);
  float refl = glassy ? (0.30 + 0.38 * fres) : (0.10 + 0.18 * fres);
  // MIRROR GLASS IS MOSTLY NOT THE BUILDING. A 1970s reflective unit returns
  // enough that what you read is the sky and the tower opposite, which is why
  // one of these next to a masonry block looks like a hole in the city. The
  // only honest way to draw it is to let the reflection win.
  if (s == 35) refl = 0.74 + 0.24 * fres;
  glass = mix(glass, sky, refl);
  // FRIT: a ceramic dot pattern printed on the unit, densest at the slab edge
  // and thinning out at eye level, so the tower carries a soft horizontal
  // gradient that is neither a spandrel nor a shadow. Drawn as coverage, so it
  // survives to the distance a printed pattern actually reads at.
  if (s == 42) {
    float dens = 1.0 - smoothstep(0.0, 0.42, min(f.y, 1.0 - f.y));
    float dot_ = step(0.5 - 0.42 * dens, fract(vU * 5.4) * fract(vZ * 5.4) + 0.5 - 0.5);
    glass = mix(glass, glass * 0.72 + vec3(0.26, 0.28, 0.29), dens * (0.55 + 0.25 * dot_));
  }
  if (glassy) wall = mix(wall, sky, 0.16 + 0.22 * fres); // spandrel sheen

  // window inset depth: lintel shadow above, bright sill below
  float winV = clamp((f.y - m.y - 0.04) / max(1.0 - 2.0 * m.y - 0.02, 0.001), 0.0, 1.0);
  glass *= mix(1.06, 0.74, winV);

  // ---- the reveal: a window is a hole with sides ---------------------------
  if (near > 0.02) {
  // Position within the opening, then shade the jamb the sun is behind and
  // the head it hangs under. This is what sells masonry depth.
  float wxr = clamp((f.x - m.x) / max(win.x, 0.001), 0.0, 1.0);
  float wyr = clamp((f.y - m.y - 0.04) / max(win.y, 0.001), 0.0, 1.0);
  float sunAlong = dot(SUN_DIR, T);
  float jambSide = sunAlong > 0.0 ? wxr : 1.0 - wxr;
  float jamb = 1.0 - smoothstep(0.0, 0.26, jambSide);
  float head = smoothstep(0.62, 1.0, wyr);
  float depthK = revealM / 0.30;                 // 1.0 for deep masonry
  float reveal = 1.0 - (0.42 * jamb + 0.34 * head) * depthK * abs(sunAlong) - 0.10 * head * depthK;
  glass *= mix(1.0, reveal, winMask);
  // the sill catches light kicked back off the pavement
  glass *= 1.0 + 0.16 * depthK * (1.0 - smoothstep(0.0, 0.16, wyr));

  // curtain-wall mullions: vertical caps between the lites
  if (glassy && winMask > 0.5) {
    float mull = 1.0 - smoothstep(0.0, 0.055, min(wxr, 1.0 - wxr));
    glass = mix(glass, glass * 0.66 + vec3(0.06), mull * 0.8);
  }
  // spandrel band reads as its own panel, not more wall
  if (glassy && winMask < 0.5) {
    float band = 1.0 - smoothstep(0.0, 0.10, min(f.y, 1.0 - f.y));
    wall *= 1.0 - 0.14 * band;
  }
  }

  glass *= glassShade;
  vec3 col = mix(wall, glass, winMask);
  // sill highlight just under the window row
  col *= 1.0 + 0.10 * (1.0 - winMask) * smoothstep(0.0, 0.04, f.y) * (1.0 - smoothstep(0.04, 0.09, f.y)) * step(0.5, float(s != 0));
  // mullion shadow line under each floor
  col *= 1.0 - 0.10 * (1.0 - winMask) * (1.0 - smoothstep(0.08, 0.12, f.y))
       * (isFloorLine(s) ? 1.0 : 0.0);

  // ---- the ground floor ---------------------------------------------------
  // Where the building meets the street it stops being a facade and becomes
  // shopfronts: a stone plinth, a bulkhead, deep glazing bay by bay, a signage
  // band, awnings, and one bay given over to the entrance.
  // THE BROWNSTONE STOOP. A residential row is not a shopping street, and
  // giving it shopfronts was the last wrong thing about the old fabric. What
  // it has instead is a rusticated basement at grade with an areaway, a
  // PARLOUR floor lifted a metre and a half above the pavement, and a door
  // with a stone surround at the top of a stoop. Getting the front door off
  // the ground is the whole silhouette of the type.
  bool row = (s == 2 && vTop < 26.0 && vTop > fh * 1.6);
  if (row && near > 0.25 && vZ < fh * 1.9) {
    float dw = 7.4;                                  // one house wide
    float du = vU / dw, df = fract(du);
    float hh = hash(vec2(floor(du) + 3.0, floor(vRand * 29.0)));
    vec3 stone = wall * (0.80 + 0.14 * hh);          // brownstone base course
    float areaTop = 1.45;                            // top of the basement
    float parlour = areaTop + fh * 0.16;             // parlour floor level
    bool doorBay = df > 0.63 && df < 0.86;

    if (vZ < areaTop) {
      // rusticated basement, with coursing and the areaway well in front
      col = stone * (0.86 + 0.09 * step(0.5, fract(vZ * 2.2)));
      if (df > 0.16 && df < 0.44 && vZ > 0.55 && vZ < areaTop - 0.15) {
        col = vec3(0.20, 0.21, 0.22);                // areaway window
      }
      if (doorBay) col = vec3(0.15, 0.145, 0.14);    // the well under the stoop
      winMask = 0.0;
    } else if (doorBay && vZ < parlour + fh * 0.62) {
      // the doorway: stone surround, dark leaf, fanlight over
      float dEdge = min(df - 0.63, 0.86 - df);
      if (dEdge < 0.035 || vZ < parlour) col = stone * 1.06;      // surround / step
      else if (vZ > parlour + fh * 0.52) col = vec3(0.34, 0.38, 0.42);  // fanlight
      else col = vec3(0.16, 0.13, 0.11) * (1.0 + 0.5 * (vZ - parlour));
      winMask = 0.0;
    } else if (vZ < parlour) {
      col = stone;                                    // plinth under the parlour
      winMask = 0.0;
    }
  }

  bool trade = isTrade(s) && !row;
  float gfTop = fh * 1.04;

  if (trade && near > 0.25 && vZ < gfTop && vTop > fh * 1.7) {
    float bw = 4.7;                                   // one shopfront bay
    float bu = vU / bw;
    float bf = fract(bu);
    float bayH = hash(vec2(floor(bu) + 0.5, floor(vRand * 53.0)));
    float doorBay = step(0.90, hash(vec2(floor(bu) + 11.0, vRand * 17.0)));

    vec3 base = wall * 0.86;                          // stone plinth
    vec3 frame = wall * 0.66;                         // shopfront framing
    vec3 shopGlass = mix(vec3(0.30, 0.33, 0.36), sky, 0.36 + 0.28 * fres);
    // a lit interior behind the glass, warmer and brighter deeper in the bay
    shopGlass = mix(shopGlass, vec3(0.80, 0.70, 0.52), 0.40 + 0.22 * bayH);

    // THE SHOP THAT ISN'T THERE. vRet carries this building's retail
    // occupancy, straight off the simulation, monthly. Each bay's hash sits
    // uniformly in 0..1, so bayH > vRet papers EXACTLY the vacant share of
    // the strip — a 60%-let frontage has two dead shops in five, the same
    // two every month until a lease signs, and the street tells the truth
    // the rent roll knows. A dead bay is papered kraft over the glass, its
    // sign comes down to a faded board, its awning is gone, and an agent's
    // white card sits at eye level.
    bool deadBay = vRet >= 0.0 && bayH > vRet + 0.02;
    if (deadBay) {
      shopGlass = vec3(0.60, 0.54, 0.44) * (0.92 + 0.16 * fract(bayH * 9.7));
      // seams between the paper sheets
      shopGlass *= 1.0 - 0.08 * step(0.82, fract(vU * 1.35 + bayH));
    }

    float pierW = 0.14;                               // masonry between bays
    bool pier = bf < pierW || bf > 1.0 - pierW;
    float sillZ = 0.62, headZ = fh * 0.80, signTop = gfTop;

    vec3 gf;
    if (vZ < sillZ)            gf = base;                       // plinth
    else if (vZ > signTop)     gf = wall;                       // back to facade
    else if (vZ > headZ) {
      // signage band: each shop paints its own — a dead one's came down
      vec3 signCol = vec3(0.34 + 0.20 * bayH, 0.31 + 0.16 * fract(bayH * 7.3), 0.28 + 0.16 * fract(bayH * 3.1));
      gf = deadBay ? wall * 0.80 : mix(wall * 0.86, signCol, 0.62);
    }
    else if (pier)             gf = frame;
    else if (doorBay > 0.5 && bf > 0.38 && bf < 0.62 && !deadBay) {
      gf = vec3(0.13, 0.12, 0.12);                              // recessed doorway
      gf *= 1.0 + 0.5 * smoothstep(0.0, 0.5, vZ / max(headZ, 1.0));
    }
    else {
      gf = shopGlass;
      // transom bar and the bulkhead below the display window
      if (vZ < sillZ + 0.42) gf = frame * 1.06;
      if (abs(vZ - headZ * 0.82) < 0.09) gf = frame;
      // the letting agent's card, white and small, at eye level
      if (deadBay && abs(bf - 0.5) < 0.055 && vZ > 1.25 && vZ < 1.62) gf = vec3(0.90, 0.89, 0.84);
    }

    // awnings: a canvas over roughly half the bays, with its shadow on the
    // glass — and a dead shop's canvas is gone with its sign
    float hasAwn = step(0.46, bayH) * (deadBay ? 0.0 : 1.0);
    float awnZ0 = headZ * 0.86, awnZ1 = headZ * 1.02;
    if (hasAwn > 0.5 && !pier) {
      if (vZ > awnZ0 && vZ < awnZ1) {
        vec3 awn = vec3(0.44 + 0.22 * fract(bayH * 5.7), 0.34 + 0.16 * fract(bayH * 2.3), 0.30 + 0.14 * bayH);
        // scalloped valance
        float scallop = 0.5 + 0.5 * sin(bf * 34.0);
        gf = mix(awn, awn * 0.78, scallop * smoothstep(awnZ1 - 0.22, awnZ1, vZ));
      } else if (vZ < awnZ0) {
        gf *= mix(0.62, 1.0, smoothstep(0.0, 1.5, awnZ0 - vZ));   // the awning's shade
      }
    }
    col = gf;
    winMask = (vZ > sillZ && vZ < headZ && !pier) ? 1.0 : 0.0;
  }

  // THE DISSOLVE, AND WHAT HAS TO SURVIVE IT.
  //
  // A floor is roughly two pixels tall at the camera this game actually sits
  // at, so the window grid has to go before it aliases into noise. Measured
  // there: mean lod 0.959, and 85.4% of every wall pixel in the frame above
  // 0.9. That is the dissolve doing its job.
  //
  // It was also doing it to everything else. Every line above this one —
  // the reveals, the shopfronts, the stoops, a century of soot — was being
  // averaged out to within four per cent of a flat colour before it reached
  // the screen, and only came back when you put your nose on a single block.
  // A magenta test band on the ground floor rendered THIRTY-SEVEN PIXELS out
  // of a million at the default camera. It was not the ground-floor gate. It
  // was this line, eating the whole facade.
  //
  // So the shader is now in two halves. Above: PATTERN — window grids, bay
  // hashing, transom bars, things made of edges, which genuinely cannot be
  // drawn at two pixels a floor and are correctly dissolved. Below: VALUE —
  // tone, not edges, which is exactly what a facade still has at two pixels a
  // floor, and which now runs after the dissolve so distance cannot erase it.
  // WHAT DEPTH IS, AT TWO PIXELS A FLOOR.
  //
  // Reveal depth runs 28 mm to 900 mm across these families and it is the
  // strongest thing separating them — a thin skin hung off a frame against a
  // thick thing with holes cut in it. All of it lived above this line, in the
  // parallax and the jamb shading, so at the camera this game actually sits
  // at every family arrived as a flat mix of its own wall and its own glass
  // and the whole range collapsed into the palette. A hundred and forty-four
  // families, one
  // cue, and the cue that did the most work was the one that got dissolved.
  //
  // Depth has a consequence that is pure value and survives any distance: a
  // deep opening HIDES ITS OWN GLASS the moment you are off-axis, because the
  // jamb is in the way. Look along a brutalist slab and you see concrete;
  // look along a unitised glass tower at the same angle and you see glass,
  // because there is nothing standing in front of it. That is why a masonry
  // street reads as a wall with holes and a glass street reads as a mirror,
  // from a mile up, with no window grid drawn in either.
  //
  // So the glass the average is made of is the opening LESS what the reveal
  // occludes — depth times the tangent of the view angle, per axis, against
  // the opening's own size in metres. Which makes it depend on colW and win
  // as well, so bay proportion reaches the far view too.
  // Every quantity below is the geometry of one opening — how wide, how tall,
  // how deep, and where the eye and the sun are relative to it. None of it is
  // a number chosen to make a picture come out; the one calibrated constant is
  // named where it appears.
  float slotW = max(win.x * colW, 0.05);        // the opening, in metres
  float slotH = max(win.y * fh, 0.05);
  float hHide = revealM * abs(dot(Vw, T)) / facing;
  float vHide = revealM * abs(dot(Vw, vec3(0.0, 0.0, 1.0))) / facing;
  float seen = clamp(1.0 - hHide / slotW, 0.0, 1.0) * clamp(1.0 - vHide / slotH, 0.0, 1.0);
  // AND WHAT GLASS YOU CAN STILL SEE IS DARKER FOR THE SAME REASON. A recessed
  // opening sees less sky than a flush one, by the form factor of its own
  // slot: depth over depth plus the mean of its sides. That is 17% for a
  // board-formed concrete slot and 1% for a unitised glass lite — the range
  // this whole cue is made of.
  float skyLoss = revealM / (revealM + 0.5 * (slotW + slotH));
  // ...and the jamb throws a shadow across the opening whenever the sun runs
  // along the wall rather than square into it: depth times that tangent, over
  // the opening's width, is the fraction of it in shade. 0.55 is the only
  // calibrated number here — the share of a lit facade's light that is direct
  // sun rather than sky, which is what that fraction of the opening loses.
  float sunLoss = clamp(revealM * abs(dot(SUN_DIR, T)) / max(dot(SUN_DIR, n), 0.10) / slotW, 0.0, 1.0);
  // Smoothstepped rather than stepped: a wall the sun is grazing has a jamb
  // shadow that fades, and a hard cut there would draw the terminator as a
  // line across the city.
  float revShade = 1.0 - skyLoss - 0.55 * sunLoss * smoothstep(0.0, 0.18, dot(n, SUN_DIR));
  vec3 glassAvg = mix(glassA, glassB, 0.5) * revShade;
  // The part of the opening the jamb has taken over reads as wall in its own
  // shadow, because that is what it is.
  vec3 facadeAvg = mix(wall, mix(wall * revShade, glassAvg, seen), win.x * win.y * 0.8);
  col = mix(col, facadeAvg, lod);

  // ---- value: the half of the facade that reads from the air --------------

  // A GROUND FLOOR. Eighty-five lines of shopfront sit above, behind a
  // near > 0.25 gate that only 7.1% of wall pixels clear at the default
  // camera. What a shopfront is at that distance is not a transom bar, it is
  // a band of dark at the bottom of the wall, because glazing is a hole in a
  // building. So: one smoothstep, and a plinth line where the base stops —
  // crossfaded against lod so it carries the ground floor when the detailed
  // version cannot be drawn, and steps aside when it can.
  if (trade && vZ < gfTop && vTop > fh * 1.7) {
    float gfk = 1.0 - smoothstep(gfTop * 0.72, gfTop, vZ);
    // ...and at distance the truth survives as TONE: a let frontage is a dark
    // glass band, a dead one is a pale papered one. The two-pixel version of
    // the same fact the shopfront bays draw up close.
    float deadK = vRet >= 0.0 ? 1.0 - clamp(vRet, 0.0, 1.0) : 0.0;
    vec3 bandCol = mix(mix(col * 0.70, mix(glassA, glassB, 0.35), 0.42), vec3(0.58, 0.53, 0.44), deadK * 0.8);
    col = mix(col, bandCol, gfk * 0.66 * lod);
    float plinth = smoothstep(0.55, 0.75, vZ / gfTop) * (1.0 - smoothstep(0.75, 0.95, vZ / gfTop));
    col *= 1.0 - plinth * 0.22 * lod;
  }

  // OCCUPANCY YOU CAN SEE FROM THE AIR.
  //
  // Nothing about the economy reached this renderer. You could own half the
  // waterfront and be bleeding on every foot of it, and the map that fills the
  // screen would look exactly the same as the map of a full building — so the
  // simulation and the picture were two things sharing a window rather than
  // one object. A principal does not read a spreadsheet to know which of his
  // towers is empty. He looks at it.
  //
  // What a vacant floor actually is, from the air and in daylight, is a floor
  // with no fit-out in it: no ceiling, no blinds, no furniture, nothing behind
  // the glass to catch the light. It reads flat, cool and a little dark, and
  // it is the flatness that gives it away rather than the darkness. Let floors
  // read normal. In the low winter sun the let ones pick up a warm interior,
  // because at four o'clock in December the lights are already on.
  //
  // The bands are about three floors deep and their split is per building, so
  // a half-let tower reads as half dark and fills up over the quarters you
  // spend leasing it. They are deliberately NOT the window grid, which is two
  // pixels tall at the camera this game sits at and correctly dissolved a few
  // lines above — this has to survive the distance, so it is built out of
  // value at a frequency that can.
  if (vLit >= 0.0) {
    float bandH = fh * 3.0;
    float band = floor(vZ / bandH + hash(vec2(vRand * 91.0, 7.0)) * 5.0);
    float roll = hash(vec2(band, vRand * 47.0 + 3.0));
    // the bottom of a building lets first and stays let longest — ground-floor
    // retail and the anchor above it are the last space to go dark
    float low = 1.0 - smoothstep(0.0, vTop * 0.55, vZ);
    float let_ = smoothstep(roll - 0.14, roll + 0.14, clamp(vLit + low * 0.22, 0.0, 1.0));
    float dark = 1.0 - let_;
    // flatter, cooler, dimmer where nobody is
    col = mix(col, vec3(dot(col, vec3(0.34, 0.38, 0.28))) * vec3(0.90, 0.96, 1.10) * 0.68, dark * 0.90);
    // and warm behind the glass where somebody is, hardest when the sun is low
    float dusk = 1.0 - smoothstep(0.10, 0.42, SUN_DIR.z);
    col += vec3(0.085, 0.058, 0.022) * let_ * dusk * (0.35 + 0.65 * winMask);
  }

  // A CENTURY LEAVES A MARK.
  //
  // Not a dirt texture — the two things that actually make an old wall look
  // old at this distance. Airborne carbon darkens and warms everything that
  // has stood through it, hardest on the masonry styles that were there for
  // the coal. And it collects: rain washes the exposed field of a wall and
  // never reaches the sheltered courses, so an old building is streaked
  // light-and-dark down its own height while a new one is flat.
  if (!glassy) {
    float age = 1.0 - vEra;                             // 0 = new, 1 = 1870
    // age^1.5 rather than age^2: the median building sits at age 0.43, and a
    // square law put only four per cent of darkening on it, which is nothing.
    float soot = pow(age, 1.5) * 0.42;
    col = mix(col, col * vec3(0.80, 0.78, 0.74), soot);
    // washed where the weather gets at it, dirty where it does not
    vec2 wp = vec2(vU * 0.09, vZ * 0.055);
    vec2 wi = floor(wp), wf = fract(wp);
    wf = wf * wf * (3.0 - 2.0 * wf);
    float wash = mix(mix(hash(wi), hash(wi + vec2(1.0, 0.0)), wf.x),
                     mix(hash(wi + vec2(0.0, 1.0)), hash(wi + vec2(1.0, 1.0)), wf.x), wf.y);
    col *= 1.0 + age * 0.22 * (wash - 0.5);
  }

  // Rain belongs to the material, not to a blue screen laid over the city.
  // Masonry absorbs and deepens; glass changes much less.
  col *= mix(1.0, glassy ? 0.96 : 0.88, RAIN);

  // ---- light --------------------------------------------------------------
  float ndl = max(dot(n, SUN_DIR), 0.0);
  vec3 light = SUN_COL * (ndl * vis * 0.92 * mix(0.72, 1.0, smoothstep(0.0, 1.9, vZ))) + hemiLight(n, ao);
  vec3 eyeV = normalize(uCam - vPos);
  // glass throws a specular back at the sun; masonry doesn't
  if (glassy) {
    vec3 H = normalize(SUN_DIR + eyeV);
    light += SUN_COL * pow(max(dot(n, H), 0.0), 48.0) * 0.55 * vis * winMask;
  }
  col *= light * edgeLift;
  col *= vTint;

  // GRAZING SKY, WHICH IS WHAT SEPARATES A BUILDING FROM THE ONE BEHIND IT.
  //
  // Every material gets more reflective the further along it you look — it is
  // why the wet road ahead of you is a mirror and the same road at your feet
  // is grey. On a city this means the facades turned away from the camera pick
  // up a wash of sky along their length, and the near ones do not, so two
  // identical stone walls one street apart arrive at different values and read
  // as two walls. Without it every facade in the frame is lit purely by its
  // own normal, which is why a dense skyline flattens into one mass at the
  // point where the shadows stop separating it.
  //
  // Added AFTER the albedo multiply because it is reflected light, not more
  // illumination of the surface: it does not care what colour the brick is,
  // which is exactly why it lifts dark brick out of the background and leaves
  // pale stone alone. Squared falloff, small on masonry, real on glass.
  float graze = pow(1.0 - clamp(dot(n, eyeV), 0.0, 1.0), 4.0);
  col += SKY_COL * graze * (glassy ? 0.34 : 0.085) * mix(0.55, 1.0, ao);

  gl_FragColor = vec4(aerial(grade(col), vPos, uCam), uOpacity);
}`;

const ROOF_FRAG = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vTint;
varying vec3 vPos;
varying vec2 vSeg, vCcv;
varying float vU, vZ, vStyle, vRand, vVar, vTop, vFh, vEra;
varying float vLit;
varying float vRet;
uniform float uOpacity;
uniform vec3 uCam;
uniform float uTime;
` + SHADOW_GLSL + LIGHT_GLSL + SEASON_GLSL + HAZE_GLSL + STYLE_SETS_GLSL + /* glsl */ `
float rhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rhash(i), rhash(i + vec2(1.0, 0.0)), f.x),
             mix(rhash(i + vec2(0.0, 1.0)), rhash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  int s = int(vStyle + 0.5);
  vec3 roof;
  roof = vec3(0.76, 0.76, 0.74);   // the default, before any family overrides it
  if (s == 0)       roof = vec3(0.70, 0.715, 0.735);
  if (s == 1)  roof = vec3(0.64, 0.605, 0.545);
  if (s == 2)  roof = vec3(0.60, 0.53, 0.46);
  if (s == 3)  roof = vec3(0.58, 0.60, 0.615);
  if (s == 4)  roof = vec3(0.21, 0.225, 0.255);
  if (s == 6)  roof = vec3(0.585, 0.545, 0.455);
  if (s == 7)  roof = vec3(0.66, 0.68, 0.68);
  if (s == 15) roof = vec3(0.74, 0.755, 0.775); // crystal: pale membrane and a glass parapet
  if (s == 16) roof = vec3(0.72, 0.73, 0.74);   // diagrid: aluminium deck
  if (s == 17) roof = vec3(0.42, 0.41, 0.42);   // postmodern: dark granite coping
  if (s == 8)  roof = vec3(0.60, 0.56, 0.48);   // cornice cap
  if (s == 9)  roof = vec3(0.47, 0.62, 0.36);   // green roof
  if (s == 10) roof = vec3(0.575, 0.545, 0.475); // gravel lot
  if (s == 12) roof = vec3(0.455, 0.585, 0.335); // park turf
  if (s == 13) roof = vec3(0.760, 0.720, 0.630); // park walk
  if (s == 14) roof = vec3(0.272, 0.400, 0.436); // park water
  if (s == 11) {                                 // shingles
    if (vVar < 0.34)      roof = vec3(0.205, 0.135, 0.108);  // weathered red asphalt
    else if (vVar < 0.62) roof = vec3(0.150, 0.162, 0.185);  // slate
    else if (vVar < 0.84) roof = vec3(0.245, 0.340, 0.295);  // oxidised copper
    else                  roof = vec3(0.330, 0.306, 0.268);  // grey weathered wood
  }
  // A ROOF BELONGS TO ITS BUILDING. Every new family fell to one pale grey,
  // which is the same failure the walls had: a 1978 garage deck and a mass
  // timber roof terrace are not the same surface. What is on top follows from
  // what the building is made of and when somebody last re-covered it.
  if (s == 18) roof = vec3(0.50, 0.485, 0.45);   // loft: tar and gravel
  if (s == 19) roof = vec3(0.545, 0.515, 0.475);
  if (s == 20) roof = vec3(0.385, 0.445, 0.415); // gothic: copper gone green
  if (s == 21) roof = vec3(0.615, 0.595, 0.545); // beaux-arts: lead flat
  if (s == 22) roof = vec3(0.255, 0.275, 0.305); // empire: the slate mansard
  if (s == 23) roof = vec3(0.555, 0.520, 0.465);
  if (s == 24) roof = vec3(0.425, 0.365, 0.315); // federal: cedar shingle
  if (s == 25) roof = vec3(0.485, 0.460, 0.425); // tenement: patched tar
  if (s == 26) roof = vec3(0.595, 0.585, 0.555);
  if (s == 27) roof = vec3(0.690, 0.680, 0.635);
  if (s == 28) roof = vec3(0.670, 0.660, 0.620);
  if (s == 29) roof = vec3(0.600, 0.590, 0.560);
  if (s == 30) roof = vec3(0.450, 0.390, 0.335); // carriage house: shingle
  if (s == 31) roof = vec3(0.505, 0.545, 0.550); // market hall: standing seam
  if (s == 32) roof = vec3(0.330, 0.345, 0.355); // international: dark ballast
  if (s == 33) roof = vec3(0.650, 0.640, 0.610);
  if (s == 34) roof = vec3(0.575, 0.565, 0.545); // brutalist: more concrete
  if (s == 35) roof = vec3(0.435, 0.450, 0.470);
  if (s == 36) roof = vec3(0.655, 0.665, 0.645); // shed: the same metal
  if (s == 37) roof = vec3(0.595, 0.575, 0.545);
  if (s == 38) roof = vec3(0.585, 0.580, 0.565); // garage: the top deck
  if (s == 39) roof = vec3(0.515, 0.495, 0.465);
  if (s == 40) roof = vec3(0.615, 0.605, 0.575);
  if (s == 41) roof = vec3(0.700, 0.695, 0.675); // balcony tower: pale membrane
  if (s == 42) roof = vec3(0.715, 0.725, 0.740);
  if (s == 43) roof = vec3(0.565, 0.505, 0.430); // timber: a deck you walk on
  if (s == 44) roof = vec3(0.675, 0.670, 0.660);
  if (s == 45) roof = vec3(0.625, 0.625, 0.605); // big box: white TPO
  if (s == 46) roof = vec3(0.455, 0.430, 0.395); // terracotta pier: dark coping
  if (s == 47) roof = vec3(0.560, 0.550, 0.530); // deep frame: matching precast
  if (s == 48) roof = vec3(0.640, 0.640, 0.630); // steel shelf: painted deck
  if (s == 49) roof = vec3(0.615, 0.630, 0.645); // unitised: pale membrane
  if (s == 50) roof = vec3(0.430, 0.445, 0.465); // mega panel: dark ballast
  if (s == 51) roof = vec3(0.395, 0.400, 0.410); // powerhouse: sooted slate
  if (s == 52) roof = vec3(0.505, 0.490, 0.455); // cold store: patched felt
  if (s == 53) roof = vec3(0.455, 0.395, 0.350); // brewery: pantile
  if (s == 54) roof = vec3(0.440, 0.450, 0.450); // foundry: glazed monitor
  if (s == 55) roof = vec3(0.615, 0.610, 0.585); // silos: the same concrete
  if (s == 56) roof = vec3(0.395, 0.385, 0.365); // gasholder: the tank crown
  if (s == 57) roof = vec3(0.560, 0.575, 0.575); // shed: profiled sheet
  if (s == 58) roof = vec3(0.470, 0.445, 0.415); // mill: asphalt over timber
  if (s == 59) roof = vec3(0.505, 0.525, 0.530); // depot: standing seam
  if (s == 60) roof = vec3(0.430, 0.375, 0.335); // pump house: slate
  if (s == 61) roof = vec3(0.350, 0.300, 0.270); // queen anne: shingle
  if (s == 62) roof = vec3(0.365, 0.325, 0.290); // stick: shingle
  if (s == 63) roof = vec3(0.330, 0.300, 0.290); // tudor: dark tile
  if (s == 64) roof = vec3(0.505, 0.310, 0.245); // mission: terracotta tile
  if (s == 65) roof = vec3(0.430, 0.420, 0.400); // theatre: the flat over the house
  if (s == 66) roof = vec3(0.620, 0.635, 0.640); // diner: the same steel
  if (s == 67) roof = vec3(0.435, 0.395, 0.360); // firehouse
  if (s == 68) roof = vec3(0.470, 0.450, 0.425); // school
  if (s == 69) roof = vec3(0.545, 0.535, 0.510); // library: lead flat
  if (s == 70) roof = vec3(0.575, 0.565, 0.540); // bank: stone coping
  if (s == 71) roof = vec3(0.480, 0.455, 0.425); // hotel
  if (s == 72) roof = vec3(0.520, 0.505, 0.475); // department store
  if (s == 73) roof = vec3(0.545, 0.520, 0.485); // motel
  if (s == 74) roof = vec3(0.560, 0.545, 0.520); // strip
  if (s == 75) roof = vec3(0.640, 0.640, 0.625); // tilt-up: white TPO
  if (s == 76) roof = vec3(0.660, 0.660, 0.645); // big shed: acres of it
  if (s == 77) roof = vec3(0.595, 0.610, 0.615); // flex
  if (s == 78) roof = vec3(0.585, 0.595, 0.585); // quonset: the same sheet
  if (s == 79) roof = vec3(0.615, 0.620, 0.615); // cross-dock
  if (s == 80) roof = vec3(0.600, 0.590, 0.570); // self storage
  if (s == 81) roof = vec3(0.500, 0.510, 0.525); // data centre: chiller deck
  if (s == 82) roof = vec3(0.455, 0.435, 0.405); // triple-decker: tar
  if (s == 83) roof = vec3(0.390, 0.345, 0.310); // shotgun: tin
  if (s == 84) roof = vec3(0.320, 0.290, 0.270); // gambrel: shingle
  if (s == 85) roof = vec3(0.355, 0.315, 0.285); // foursquare: hipped shingle
  if (s == 86) roof = vec3(0.340, 0.310, 0.275); // bungalow: deep-eaved shingle
  if (s == 87) roof = vec3(0.470, 0.450, 0.425); // SRO
  if (s == 88) roof = vec3(0.475, 0.455, 0.425); // oriel block
  if (s == 89) roof = vec3(0.465, 0.445, 0.420); // two-flat
  if (s == 90) roof = vec3(0.410, 0.375, 0.345); // ranch
  if (s == 91) roof = vec3(0.485, 0.465, 0.435); // garden apartment
  if (s == 92) roof = vec3(0.505, 0.490, 0.460); // mansion block: lead
  if (s == 93) roof = vec3(0.330, 0.320, 0.315); // back-to-back: welsh slate
  if (s == 94) roof = vec3(0.300, 0.310, 0.320); // church: slate
  if (s == 95) roof = vec3(0.345, 0.335, 0.320); // meeting house: shingle
  if (s == 96) roof = vec3(0.380, 0.420, 0.400); // synagogue: copper
  if (s == 97) roof = vec3(0.430, 0.400, 0.375); // hospital pavilion
  if (s == 98) roof = vec3(0.470, 0.470, 0.455); // cellblock
  if (s == 99) roof = vec3(0.420, 0.390, 0.370); // armory
  if (s == 100) roof = vec3(0.315, 0.325, 0.330); // collegiate: slate
  if (s == 101) roof = vec3(0.545, 0.575, 0.570); // bathhouse: glazed vault
  if (s == 102) roof = vec3(0.580, 0.590, 0.600); // museum: the skylights
  if (s == 103) roof = vec3(0.470, 0.400, 0.345); // convent: pantile
  if (s == 104) roof = vec3(0.400, 0.430, 0.425); // train shed: glazed barrel
  if (s == 105) roof = vec3(0.435, 0.400, 0.375); // car barn
  if (s == 106) roof = vec3(0.585, 0.595, 0.595); // hangar: profiled sheet
  if (s == 107) roof = vec3(0.640, 0.635, 0.615); // bus station: the slab
  if (s == 108) roof = vec3(0.390, 0.395, 0.400); // control tower: the cab roof
  if (s == 109) roof = vec3(0.455, 0.440, 0.420); // exchange
  if (s == 110) roof = vec3(0.470, 0.455, 0.435); // substation
  if (s == 111) roof = vec3(0.235, 0.235, 0.245); // lighthouse: the gallery
  if (s == 112) roof = vec3(0.330, 0.430, 0.290); // sky garden: the top terrace
  if (s == 113) roof = vec3(0.600, 0.620, 0.640); // pleated
  if (s == 114) roof = vec3(0.560, 0.590, 0.610); // shingled
  if (s == 115) roof = vec3(0.545, 0.570, 0.590); // double skin
  if (s == 116) roof = vec3(0.610, 0.612, 0.618); // megabrace
  if (s == 117) roof = vec3(0.575, 0.595, 0.615); // chevron
  if (s == 118) roof = vec3(0.600, 0.595, 0.580); // modular
  if (s == 119) roof = vec3(0.190, 0.205, 0.235); // PV clad: more panels
  if (s == 120) roof = vec3(0.585, 0.570, 0.545); // podium wrap
  if (s == 121) roof = vec3(0.545, 0.555, 0.565); // lab: plant everywhere
  if (s == 122) roof = vec3(0.505, 0.480, 0.450); // creative office
  if (s == 123) roof = vec3(0.575, 0.565, 0.545); // micro-units
  if (s == 124) roof = vec3(0.650, 0.645, 0.625); // passive: pale membrane
  if (s == 125) roof = vec3(0.360, 0.370, 0.390); // media facade
  if (s == 126) roof = vec3(0.560, 0.550, 0.530); // medical office
  if (s == 127) roof = vec3(0.520, 0.520, 0.510); // office park
  if (s == 128) roof = vec3(0.365, 0.325, 0.295); // garden office: hipped shingle
  if (s == 129) roof = vec3(0.585, 0.580, 0.565); // back office: acres of membrane
  if (s == 130) roof = vec3(0.575, 0.575, 0.560); // campus block
  if (s == 131) roof = vec3(0.505, 0.500, 0.485); // insurance slab
  if (s == 132) roof = vec3(0.545, 0.540, 0.525); // government
  if (s == 133) roof = vec3(0.470, 0.470, 0.470); // carrier hotel: chillers
  if (s == 134) roof = vec3(0.470, 0.445, 0.415); // loft office
  if (s == 135) roof = vec3(0.600, 0.615, 0.630); // sky lobby tower
  if (s == 136) roof = vec3(0.535, 0.520, 0.495); // professional building
  if (s == 137) roof = vec3(0.560, 0.550, 0.525); // boutique
  if (s == 138) roof = vec3(0.555, 0.560, 0.565); // build-to-suit
  if (s == 139) roof = vec3(0.640, 0.635, 0.615); // mall anchor: acres of TPO
  if (s == 140) roof = vec3(0.470, 0.410, 0.365); // lifestyle: fake tile
  if (s == 141) roof = vec3(0.600, 0.595, 0.580); // power inline
  if (s == 142) roof = vec3(0.615, 0.610, 0.595); // junior box
  if (s == 143) roof = vec3(0.585, 0.575, 0.560); // auto parts
  if (s == 144) roof = vec3(0.455, 0.400, 0.365); // fast food
  if (s == 145) roof = vec3(0.400, 0.360, 0.330); // bank branch: hipped
  if (s == 146) roof = vec3(0.430, 0.380, 0.345); // pharmacy
  if (s == 147) roof = vec3(0.560, 0.545, 0.520); // grocery
  if (s == 148) roof = vec3(0.435, 0.385, 0.350); // restaurant
  if (s == 149) roof = vec3(0.585, 0.590, 0.595); // showroom
  if (s == 150) roof = vec3(0.475, 0.420, 0.375); // outlet
  if (s == 151) roof = vec3(0.545, 0.530, 0.505); // corner retail

  roof *= 0.92 + 0.16 * vRand;

  // ---- surface: membrane seams, gravel, patches, shingle courses ----------
  vec2 wp = vPos.xy;
  if (s == 9) {
    // planting beds read as clumped growth, not a green sheet
    float g = rnoise(wp * 0.55) * 0.6 + rnoise(wp * 1.7) * 0.4;
    roof *= 0.82 + 0.36 * g;
    roof = mix(roof, vec3(0.58, 0.55, 0.44), smoothstep(0.62, 0.78, rnoise(wp * 0.3)) * 0.35);
  } else if (s == 11) {
    // shingle courses run with the slope
    float course = fract(vPos.z * 1.6);
    roof *= 0.90 + 0.13 * step(0.5, course);
    roof *= 0.94 + 0.12 * rnoise(wp * 3.1);
  } else if (s == 12) {
    // TURF. Mown in bands, blond where it bakes, damper and darker under the
    // trees, worn through to dirt on the desire lines. A lawn is the largest
    // uniform surface in the city and the one the eye rests on longest, so it
    // is the last place a flat fill survives contact with a low sun.
    float band = sin(wp.x * 0.115 + wp.y * 0.052);
    roof *= 0.955 + 0.075 * step(0.0, band);
    float clump = rnoise(wp * 0.09) * 0.55 + rnoise(wp * 0.42) * 0.45;
    roof = mix(roof, vec3(0.545, 0.578, 0.375), smoothstep(0.52, 0.86, clump) * 0.55);
    roof = mix(roof, vec3(0.330, 0.455, 0.290), smoothstep(0.46, 0.14, clump) * 0.50);
    roof *= 0.94 + 0.12 * rnoise(wp * 1.9);
    roof = mix(roof, vec3(0.560, 0.515, 0.415), smoothstep(0.80, 0.96, rnoise(wp * 0.6 + 41.0)) * 0.45);
  } else if (s == 13) {
    roof *= 0.94 + 0.13 * rnoise(wp * 2.6);              // raked gravel
    roof *= 0.97 + 0.06 * rnoise(wp * 0.5);
  } else if (s == 14) {
    float rip = rnoise(wp * 0.9) * 0.6 + rnoise(wp * 3.3) * 0.4;
    roof *= 0.90 + 0.20 * rip;                            // ripple and depth
    roof = mix(roof, vec3(0.44, 0.55, 0.47), smoothstep(0.62, 0.88, rnoise(wp * 1.4)) * 0.30);
  } else if (s == 10) {
    // not every empty lot is gravel: some have gone to grass and weeds, and a
    // few are packed dirt — the patchwork a real city's vacant land actually is
    // Value separation matters more than hue here. Vacant ground was pitched
    // within a few percent of the sidewalk, so lots and streets merged into
    // one pale field and whole districts read as a blank apron. Ground is
    // DARKER than paving — it always is — and the city snaps into blocks the
    // moment it is.
    if (vVar > 0.62)      roof = mix(vec3(0.435, 0.520, 0.305), vec3(0.505, 0.560, 0.350), rnoise(wp * 1.1));
    else if (vVar < 0.18) roof = vec3(0.515, 0.435, 0.335);
    roof *= 0.88 + 0.24 * rnoise(wp * 2.4);   // gravel / scrub texture
  } else {
    int dk = int(max(vSeg.x, 0.0) + 0.5);
    vec3 deck;
    if (dk == 1)      deck = vec3(0.095, 0.091, 0.086);  // hot-mopped tar, weathered BUR
    else if (dk == 2) deck = vec3(0.118, 0.124, 0.134);  // black EPDM sheet
    else if (dk == 3) deck = vec3(0.190, 0.183, 0.172);  // dark slag ballast
    else if (dk == 4) deck = vec3(0.352, 0.362, 0.375);  // weathered galvanised / terne
    else if (dk == 5) deck = vec3(0.550, 0.553, 0.542);  // aluminised asphalt coating
    else if (dk == 6) deck = vec3(0.445, 0.458, 0.474);  // grey PVC
    else if (dk == 7) deck = vec3(0.780, 0.785, 0.768);  // white TPO cool roof
    else if (dk == 8) deck = vec3(0.470, 0.418, 0.340);  // tan mineral-cap mod-bit
    else              deck = vec3(0.300, 0.283, 0.250);  // gravel-ballasted built-up
    deck += (1.0 - deck) * (0.10 * (0.30 + 0.55 * vRand) * (1.0 - vEra));
    roof = deck * (0.90 + 0.20 * vRand);

    vec2 dir = vCcv;
    float dl = length(dir);
    dir = dl > 0.5 ? dir / dl : vec2(1.0, 0.0);
    vec2 rp = vec2(dot(wp, dir), dot(wp, vec2(-dir.y, dir.x)));
    roof *= 1.0 + 0.034 * cos(rp.x * 0.6866);
    roof *= 1.0 + 0.015 * cos(rp.y * 0.5150);
    // SEAM PITCH IS A PROPERTY OF THE MATERIAL, and it was one number for the
    // whole city: 0.3279, which is a seam every 3.05 m on every roof in town
    // whatever it is made of. A roll of modified bitumen is a metre wide. A
    // standing-seam metal pan is four hundred millimetres. A ballasted
    // built-up roof has no seams you can see at all, because there is four
    // inches of gravel on top of them. Getting this wrong makes every roof in
    // the city the same roof seen from different angles.
    float pitch =
        dk == 4 ? 2.42                    // standing-seam metal: narrow pans
      : dk == 7 ? 0.98                    // TPO sheet, welded laps
      : dk == 6 ? 0.86                    // PVC, wider sheet
      : dk == 2 ? 0.62                    // EPDM comes in big sheets
      : dk == 8 ? 1.06                    // mod-bit roll
      : dk == 1 ? 0.44                    // hot-mopped BUR: felt laps, coarse
      :           0.0;                    // ballast and slag: nothing shows
    float fine = 1.0 - smoothstep(0.30, 0.85, fwidth(rp.x));
    if (pitch > 0.0) {
      float sf = fract(rp.x * pitch);
      roof *= 1.0 - 0.13 * fine * (1.0 - smoothstep(0.0, 0.075, min(sf, 1.0 - sf)));
    }

    float ws = fract(abs(vSeg.y) * 0.61803399) * 40.0;
    float p1 = rnoise(wp * 0.115 + ws);
    float p2 = rnoise(wp * 0.27 + ws * 1.7);
    float pond = p1 * 0.62 + p2 * 0.38;
    // PONDING IS A SHEEN, NOT A HOLE. This mixed 45% toward half-brightness
    // inside a soft noise blob, and stacked with the repairs below it turned
    // every roof in the city into a field of dark amoebas — the single ugliest
    // thing in the render. Standing water on a roof is DAMP: a few per cent
    // darker, a little cooler, with no edge you could point at. That is all it
    // has ever looked like from the air.
    float stain = 0.10 + 0.20 * dot(deck, vec3(0.2126, 0.7152, 0.0722));
    roof = mix(roof, roof * vec3(0.90, 0.93, 0.96), smoothstep(0.50, 0.86, pond) * stain);
    if (dk == 0 || dk == 3) roof = mix(roof, roof * vec3(0.86, 0.85, 0.83), smoothstep(0.58, 0.86, p2) * 0.30);
    roof *= 0.955 + 0.09 * rnoise(wp * 0.7);
    roof = mix(roof, roof * 0.92, smoothstep(0.52, 0.86, rnoise(wp * 0.22 + 17.0)) * 0.42);

    // ---- what forty years on a roof actually looks like ------------------
    //
    // A roof is not resurfaced, it is PATCHED, over and over, by different
    // contractors in different decades with whatever was on the truck. That
    // map of repairs is the one thing that separates an old roof from a new
    // one at this distance — but only if it has the right SHAPE.
    //
    // I built it first as a threshold on smooth noise mixed 72% toward black,
    // and it read as holes: round dark amoebas sitting on every roof in town,
    // which is nothing like a roof and was the worst-looking thing in the
    // game. Two mistakes. A repair is not round — somebody rolls a STRIP of
    // membrane along the run and cuts it square, so a patched roof is a
    // patchwork of rectangles aligned to the same direction the seams are.
    // And a repair is not dark — it is the same material as the roof, laid at
    // a different time, so it differs from its neighbour by about a tenth of
    // its value, not by three quarters. Newer bitumen is darker; anything that
    // has been coated is lighter. Both happen.
    float wear = clamp(abs(vSeg.y), 0.0, 1.0) * (0.35 + 0.65 * (1.0 - vEra));
    vec2 pc = vec2(rp.x / 3.6, rp.y / 6.2);          // the roll grid, seam-aligned
    vec2 pcell = floor(pc), pf = fract(pc);
    float ph = rhash(pcell + ws);
    float patched = step(1.0 - (0.06 + 0.30 * wear), ph);
    // the strip does not fill its cell, and it is cut square
    float pw = 0.34 + 0.46 * rhash(pcell + 7.3);
    float phh = 0.40 + 0.44 * rhash(pcell + 13.1);
    float inPat = patched
      * step(abs(pf.x - 0.5), pw * 0.5)
      * step(abs(pf.y - 0.5), phh * 0.5);
    // a hard edge at three pixels is aliasing, not detail — fade the whole
    // thing out as the cell shrinks on screen, the same way the window grid does
    float pFine = 1.0 - smoothstep(0.22, 0.70, max(fwidth(pc.x), fwidth(pc.y)));
    float tone = rhash(pcell + 21.7) < 0.60 ? -1.0 : 1.0;
    roof *= 1.0 + tone * inPat * pFine * (0.055 + 0.075 * rhash(pcell + 31.0));

    // ALGAE AND BALD GRAVEL. A white roof does not stay white — it grows
    // gloeocapsa in streaks running down to the drains — and a ballasted roof
    // loses its stones wherever anybody walks or the wind scours, showing the
    // black felt underneath. Both are the deck telling you which deck it is.
    float lum = dot(deck, vec3(0.2126, 0.7152, 0.0722));
    if (lum > 0.45) {
      float alg = rnoise(vec2(rp.x * 0.5, rp.y * 0.09) + ws);
      roof = mix(roof, vec3(0.318, 0.352, 0.300), smoothstep(0.56, 0.86, alg) * wear * 0.62);
    }
    if (dk == 0 || dk == 3) {
      float bald = rnoise(wp * 0.44 + ws * 2.1);
      roof = mix(roof, vec3(0.135, 0.128, 0.120), smoothstep(0.68, 0.88, bald) * (0.25 + 0.5 * wear));
    }
    // (The drain sump used to be here — a darkened disc at every low point. At
    // the distance this game is played from it was a two-pixel dark dot, which
    // is a speck on a roof and not a roof detail, and it was a third of the
    // spotting problem. A roof drains; you cannot see it from an aeroplane.)
  }

  // A sedum roof genuinely does redden — that is what sedum does — so the
  // green roof keeps the leaf treatment. The park lawn and the grass that has
  // taken a vacant lot are turf, and turf goes dormant instead.
  if (s == 9) roof = seasonGreen(roof);
  if (s == 12 || (s == 10 && vVar > 0.62)) roof = seasonTurf(roof);
  vec3 n = normalize(vNormal);
  // Wet horizontal surfaces darken and gain a broad sun sheen. This survives
  // the gameplay camera as material contrast without drawing rain over the UI.
  roof *= mix(1.0, 0.80, RAIN * smoothstep(0.20, 0.85, n.z));
  if (SNOW > 0.001) {
    float up = smoothstep(0.28, 0.80, n.z);
    float drift = 0.62 + 0.55 * rnoise(wp * 0.22) + 0.20 * rnoise(wp * 1.3);
    if (s == 14) roof = mix(roof, vec3(0.63, 0.70, 0.76), clamp(SNOW * 1.15, 0.0, 1.0));
    roof = snowOn(roof, up, drift);
  }
  // ---- the pond, which is water and was never treated as any ---------------
  //
  // A hundred metres from a harbour that has waves, Fresnel, a sun road and a
  // planar reflection, the park pond was a flat green-grey with two octaves of
  // static noise laid over it. It did not need the harbour's swell — a
  // sheltered basin has none — but it did need the two things that make still
  // water read as water at all: a surface that MOVES, and a sky in it.
  //
  // Three slow crossed trains give the ripple; the slope of their sum is the
  // normal, and everything else falls out of that. vU carries distance to the
  // pond's own bank, baked per vertex, so the rim goes green and opaque where
  // you can see the bottom and the middle holds the sky.
  if (s == 14) {
    // FOUR TRAINS, DELIBERATELY UNCORRELATED. Three with similar bearings sum
    // into a corduroy of parallel ridges — the pond came out looking milled
    // rather than wet. Spread the headings around the compass, keep the
    // wavelengths incommensurate, and the interference pattern stops having a
    // direction.
    float t = uTime;
    float a1 = sin(wp.x *  0.97 + wp.y *  0.14 + t * 0.83);
    float a2 = sin(wp.x * -0.34 + wp.y *  0.92 + t * 1.27);
    float a3 = sin(wp.x *  1.51 - wp.y *  1.19 + t * 1.94);
    float a4 = sin(wp.x * -1.77 - wp.y *  1.05 + t * 2.61);
    // THE SLOPE HAS TO BE REAL OR THE SPECULAR IS NOT A GLINT, IT IS A FLARE.
    // At 0.028 the ripple barely tilted the normal, so every point on the pond
    // shared one alignment with the half-vector — and with a low sun over a
    // horizontal surface that alignment is near perfect, so the entire pond
    // went to white at once. Water sparkles because its normal VARIES; the
    // tight exponents below are only meaningful against a surface that moves
    // enough to put some of itself out of alignment.
    vec2 slope = vec2( 0.97 * a1 - 0.34 * a2 + 1.51 * a3 - 1.77 * a4,
                       0.14 * a1 + 0.92 * a2 - 1.19 * a3 - 1.05 * a4) * 0.075;
    vec3 pn = normalize(vec3(-slope, 1.0));
    vec3 Vp = normalize(uCam - vPos);

    // SCHLICK, NOT A GUESS. Water reflects about 2% of what hits it head-on
    // and nearly everything at a grazing angle, and the curve between the two
    // is very flat until it turns hard near the edge. A cubed falloff put 26%
    // of sky into a pond being looked at from well above it, which is four
    // times what is really there — and that, not the highlight, is why it kept
    // reading as a pale sheet instead of as water.
    float fr = 0.02 + 0.98 * pow(1.0 - clamp(dot(pn, Vp), 0.0, 1.0), 5.0);

    // AND A POND IS DARK. Standing water over silt and weed is one of the
    // darkest surfaces in a park — considerably darker than the grass around
    // it — which is exactly what makes it read as depth rather than as a
    // puddle of sky lying on the lawn.
    roof = vec3(0.088, 0.128, 0.116);
    float rim = 1.0 - smoothstep(0.0, 3.4, vU);
    // the bank: silt, weed and the bottom showing through
    roof = mix(roof, vec3(0.232, 0.290, 0.212), rim * 0.72);
    roof = mix(roof, vec3(0.556, 0.688, 0.836), fr * (1.0 - rim * 0.55));
    // and the sun on it — broad sheen, then the hard points
    float sd = max(dot(pn, normalize(SUN_DIR + Vp)), 0.0);
    // A small pond looked at down the sun's bearing IS a sheet of light — that
    // part was never wrong. What was wrong was the amount: enough to clip to
    // paper white and lose the ripple that makes it legible as water.
    roof += SUN_COL * (pow(sd, 30.0) * 0.03 + pow(sd, 260.0) * 0.14 + pow(sd, 900.0) * 0.38)
          * (1.0 - rim * 0.7);
  }

  float vis = sunVis(vPos, n);
  // vU carries distance to the roof edge: the parapet shades its own deck
  float aoEdge = mix(0.78, 1.0, smoothstep(0.0, 2.8, vU));
  float ndl = max(dot(n, SUN_DIR), 0.0);
  vec3 light = SUN_COL * (ndl * vis * 0.92) + hemiLight(n, aoEdge);
  vec3 outc = roof * light * vTint;

  vec3 Vr = normalize(uCam - vPos);
  // A ROOF IS NOT PERFECTLY MATTE EITHER. Membrane, asphalt, slate and metal
  // all go glossy toward grazing, which is why a city photographed into a low
  // sun has a sheen running across the rooftops rather than a flat field of
  // colour. Broad and weak — this is sheen, not a mirror — and it only shows
  // where the sun can actually see the roof.
  vec3 Hr = normalize(SUN_DIR + Vr);
  float sheen = pow(max(dot(n, Hr), 0.0), 26.0);
  outc += SUN_COL * sheen * (0.13 + RAIN * 0.34) * vis;

  // and the glitter, on whatever snow is lying up here
  if (SNOW > 0.001) {
    outc += snowSparkle(vPos, n, Vr, clamp(SNOW * smoothstep(0.28, 0.80, n.z), 0.0, 1.0)) * vis;
  }

  gl_FragColor = vec4(aerial(grade(outc), vPos, uCam), uOpacity);
}`;

// transparent quad over the whole city: darkens the MapLibre ground where
// buildings block the sun — streets get real cast shadows
const CATCHER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vPos;
uniform vec4 uSeason;
` + SHADOW_GLSL + /* glsl */ `
void main() {
  // The ground is flat and faces straight up; its own normal is the offset.
  float vis = sunVis(vPos, vec3(0.0, 0.0, 1.0));
  // A SHADOW YOU CAN SEE. This was 40% of a pale blue-grey, which was the
  // right call while the depth bias was erasing two thirds of every shadow
  // anyway — a faint smudge is less wrong than a faint smudge in the wrong
  // place. The bias is metres now and the shadows land where the buildings
  // are, so they are allowed to read: deeper, and cooler, because a shadow
  // outdoors is lit by the sky and the sky is blue.
  float sa = uSeason.x * 0.42;
  float a  = (1.0 - vis) * 0.74;
  vec3  sc = vec3(0.800, 0.828, 0.880);
  vec3  hc = mix(vec3(0.128, 0.158, 0.272), vec3(0.42, 0.49, 0.66), uSeason.x);
  float outA = sa + a * (1.0 - sa);
  vec3  outC = outA > 0.0001 ? (sc * sa * (1.0 - a) + hc * a) / outA : sc;
  gl_FragColor = vec4(outC, outA);
}`;

const CATCHER_VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// THE STREETS WERE NEVER LIT.
//
// Every road surface in this city is drawn by MapLibre as a flat fill. The
// renderer reaches them twice — the catcher lays a shadow on them, the
// occlusion pass darkens where buildings meet them — and both of those only
// ever SUBTRACT. No sun has ever touched the largest continuous surface in the
// frame, which is why the ground has stayed a flat grey field under a city
// that otherwise has warm stone, glinting glass and a harbour full of light.
//
// Asphalt and flagstone are nothing like matte. They go sharply glossy toward
// grazing angles, and a street photographed down the line of a low sun has a
// sheen running the whole way up it — one of the most recognisable things
// about a city in late light. That is a specular term on an up-facing plane,
// which is cheap, and it has to be gated on sun visibility or the road lights
// up inside the shadow of the building next to it.
//
// Added rather than blended, on its own quad, because the catcher composites
// with alpha and alpha can only ever darken toward a colour: to make the
// ground BRIGHTER than whatever MapLibre painted there, the contribution has
// to be additive.
const GROUND_SHEEN_FRAG = /* glsl */ `
precision highp float;
varying vec3 vPos;
uniform vec3 uCam;
uniform vec4 uSeason;
` + SHADOW_GLSL + LIGHT_GLSL + /* glsl */ `
void main() {
  vec3 n = vec3(0.0, 0.0, 1.0);          // the ground is flat and faces up
  float vis = sunVis(vPos, n);
  if (vis < 0.01) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }
  else {
    vec3 V = normalize(uCam - vPos);
    float sd = max(dot(n, normalize(SUN_DIR + V)), 0.0);
    // a broad wet-looking sheen, and a tighter core down the sun's own line
    // A FLAT PLANE UNDER A LOW SUN FIRES ALL AT ONCE. There is no ripple here
    // to break the highlight the way the harbour's swell does — asphalt is
    // flat, and that is the point — so the whole road network shares one
    // alignment with the half-vector and whatever gain this carries is applied
    // to all of it simultaneously. It has to be a sheen you notice on the
    // second look, not a light source.
    float sheen = pow(sd, 18.0) * 0.05 + pow(sd, 90.0) * 0.13;
    // Snow is diffuse and kills a specular stone dead — what snow does instead
    // is glitter, and that is handled per-crystal on the surfaces this layer
    // actually draws.
    gl_FragColor = vec4(SUN_COL * sheen * vis * (1.0 - uSeason.x * 0.85), 1.0);
  }
}`;

// ---------------------------------------------------------------------------
// THE POST STAGE
// ---------------------------------------------------------------------------
//
// Until now this layer rendered straight into MapLibre's framebuffer, which
// meant there was no frame to work ON — every effect had to be something a
// fragment could do knowing only about itself. That rules out the entire class
// of things that separate a render from a photograph, because all of them need
// to see the finished image: light that spills off a bright surface into the
// ones around it, and a lens that can only be focused at one distance at a
// time.
//
// So the scene goes to an offscreen target first, and what lands in MapLibre's
// buffer is a composite. Everything here is written to fail safe: if the target
// cannot be created the layer falls back to drawing directly, exactly as before.
const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// What is bright enough to spill. Working on premultiplied colour, so the
// threshold is against light actually emitted into the frame rather than
// against the surface's own brightness.
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThresh;
uniform float uKnee;
void main() {
  vec4 c = texture2D(uTex, vUv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  // a soft knee rather than a hard cut, or the bloom develops a visible
  // outline exactly where the threshold sits
  float k = smoothstep(uThresh, uThresh + uKnee, l);
  gl_FragColor = vec4(c.rgb * k, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  // 9-tap gaussian as 5 samples on the linear-filter trick
  vec3 s = texture2D(uTex, vUv).rgb * 0.227027;
  s += (texture2D(uTex, vUv + uDir * 1.3846).rgb + texture2D(uTex, vUv - uDir * 1.3846).rgb) * 0.316216;
  s += (texture2D(uTex, vUv + uDir * 3.2308).rgb + texture2D(uTex, vUv - uDir * 3.2308).rgb) * 0.070270;
  gl_FragColor = vec4(s, 1.0);
}`;

// AMBIENT OCCLUSION, IN WORLD SPACE, OFF THE DEPTH BUFFER.
//
// The hemisphere term in the light rig is analytic: it knows a wall's height
// off the ground and whether it sits in a concave corner of its OWN footprint,
// and that is all it can know, because a fragment cannot see the building
// across the alley. So the one place a dense city should be darkest — the slot
// between two blocks, the back of a courtyard, the notch where a setback meets
// its neighbour — was lit exactly like an open plaza.
//
// The reconstruction is exact rather than a depth-difference approximation:
// this layer's camera has an identity view matrix (MapLibre hands over a
// combined matrix and Three's camera sits at the origin), so inverting the
// projection takes a depth sample straight back to a world position. From
// there it is the ordinary normal-oriented estimator — sample a disk, ask how
// far each neighbour rises above this fragment's tangent plane, weight by
// distance so a building a street away cannot occlude anything.
//
// The surface normal comes from the derivatives of the reconstructed position,
// which costs nothing and is exact for the flat faces this city is made of.
const AO_GLSL = /* glsl */ `
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec2 uAoTexel;
uniform vec3 uAoCam;
uniform vec3 uAoSun;
uniform float uAoRadius;    // metres
uniform float uAoStrength;
uniform float uContactLen;  // metres the contact ray walks

vec3 worldAt(vec2 uv, float d) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = uInvProj * clip;
  return p.xyz / p.w;
}

float occlusion(vec2 uv) {
  float d = texture2D(uDepth, uv).x;
  if (d >= 0.9999) return 0.0;                 // sky: nothing to occlude
  vec3 P = worldAt(uv, d);

  // CONTACT IS A NEAR-FIELD EFFECT AND THE GROUND PLANE RUNS TO THE HORIZON.
  // Out at three or four kilometres that plane is edge-on to the eye, a whole
  // pixel spans hundreds of metres of it, and both the reconstruction and its
  // derivatives fall apart — which arrived on screen as ruled bands across the
  // sky. Nothing that far away has readable contact anyway, so the pass simply
  // stops, faded out rather than cut so the boundary is not its own edge.
  float dist = length(P - uAoCam);
  float reach = 1.0 - smoothstep(420.0, 850.0, dist);
  if (reach <= 0.001) return 0.0;

  vec3 dPx = dFdx(P), dPy = dFdy(P);
  if (length(dPx) < 1e-7 || length(dPy) < 1e-7) return 0.0;
  vec3 N = normalize(cross(dPx, dPy));

  // Sampling radius shrinks on screen as the fragment gets further away, so a
  // fixed pixel disk would sample metres at the front of the frame and
  // kilometres at the back. Scale it by how big a metre is here.
  vec3 Px = worldAt(uv + vec2(uAoTexel.x, 0.0), d);
  float mPerPx = max(length(Px - P), 1e-4);
  float rad = clamp(uAoRadius / mPerPx, 2.0, 64.0);

  // AND IT HAS TO STOP WHEN THE SCALE RUNS OUT FROM UNDER IT.
  //
  // That clamp has a floor of two pixels, which is doing something quietly
  // wrong at the far end: zoomed out to the whole island, one pixel already
  // spans more ground than the 2.5 m radius this is supposed to measure, so
  // the floor takes over and the estimator goes looking twenty or thirty
  // metres out. That is not contact any more — it is whole buildings occluding
  // each other — and the result was a grey wash over the entire city in the
  // establishing shot, which read as the roofs being muddy.
  //
  // Contact occlusion is meaningless once it is smaller than a pixel. Fade it
  // out there rather than let the clamp quietly redefine what is being asked.
  float scaleFade = 1.0 - smoothstep(uAoRadius * 0.75, uAoRadius * 2.6, mPerPx);
  if (scaleFade <= 0.002) return 0.0;

  float occ = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 2.39996323;
    float rr = sqrt((float(i) + 0.5) / 12.0) * rad;
    vec2 suv = uv + vec2(cos(a), sin(a)) * rr * uAoTexel;
    float sd = texture2D(uDepth, suv).x;
    if (sd >= 0.9999) continue;
    vec3 S = worldAt(suv, sd) - P;
    float len = length(S);
    if (len < 1e-4) continue;
    // how far above my own tangent plane the neighbour stands, and a falloff
    // so something across the street contributes nothing
    float rise = max(dot(S / len, N) - 0.06, 0.0);
    occ += rise * (uAoRadius / (uAoRadius + len * len / max(uAoRadius, 0.5)));
  }
  return clamp(occ / 12.0 * uAoStrength, 0.0, 1.0) * reach * scaleFade;
}`;

// SOLVED ONCE, AT HALF SIZE, AND BLURRED.
//
// The occlusion is needed in two places — as a multiply onto the pavement
// MapLibre drew, and again inside our own composite — and the first version
// computed it independently in both, twelve depth taps each, at full
// resolution. That is the same answer paid for twice.
//
// Solving it into its own buffer is cheaper AND better: a twelve-tap estimator
// on a rotated disk is inherently noisy, and the standard treatment is exactly
// the one this now gets for free — resolve at half resolution, then blur. AO
// is the lowest-frequency thing in the frame; there was never any detail in it
// to protect.
// SHADOWS SMALLER THAN A SHADOW-MAP TEXEL.
//
// The sun's depth map is 3072 across 4,400 m — 1.43 m per texel. A street tree
// is about four metres of canopy, a parked car is under two, a cornice is
// under one, and a fire escape is a handful of centimetres of ironwork. Every
// one of those is at or below the resolution of the map that is supposed to be
// shadowing them, so the city has thousands of objects sitting on the pavement
// casting either a blur or nothing at all. It is the reason props have always
// looked slightly pasted on rather than standing there.
//
// A short ray walked through the depth buffer toward the sun fixes exactly
// that band and nothing else: it is only accurate for a metre or two, which is
// precisely the range the shadow map cannot resolve. The two are complementary
// — the map does the buildings, this does everything standing next to them.
//
// The thickness test is what keeps it honest. A surface that is nearer the
// camera than the ray is only a blocker if it is nearer by a LITTLE; a tower
// half a kilometre in front is not shadowing this pavement, it is merely in
// front of it, and without an upper bound every distant silhouette would drag
// a black smear across everything behind it.
const AO_CALC_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
` + AO_GLSL + /* glsl */ `
float contactShadow(vec2 uv, vec3 P, vec3 N) {
  if (dot(N, uAoSun) <= 0.02) return 0.0;      // already facing away from the sun
  vec3 step = uAoSun * (uContactLen / 10.0);
  vec3 sp = P + N * 0.035;                     // off the surface, or it shadows itself
  for (int i = 0; i < 10; i++) {
    sp += step;
    vec4 c = uProj * vec4(sp, 1.0);
    if (c.w <= 0.0) return 0.0;
    vec2 su = (c.xy / c.w) * 0.5 + 0.5;
    if (su.x < 0.0 || su.x > 1.0 || su.y < 0.0 || su.y > 1.0) return 0.0;
    float sd = texture2D(uDepth, su).x;
    if (sd >= 0.9999) continue;                // open sky along the ray
    float dRay = length(sp - uAoCam);
    float dHit = length(worldAt(su, sd) - uAoCam);
    if (dHit < dRay - 0.06 && dHit > dRay - 1.6) {
      // fade the last steps out so the shadow ends rather than stopping
      return 1.0 - float(i) / 10.0 * 0.45;
    }
  }
  return 0.0;
}

void main() {
  float d = texture2D(uDepth, vUv).x;
  float csh = 0.0;
  if (d < 0.9999) {
    vec3 P = worldAt(vUv, d);
    vec3 dPx = dFdx(P), dPy = dFdy(P);
    if (length(dPx) > 1e-7 && length(dPy) > 1e-7) {
      // ONLY WHERE THE SCALE SUPPORTS IT, and this bound has to be tighter
      // than it first looks. The test is a metre-scale distance comparison
      // between two points reconstructed from depth, and depth precision at a
      // kilometre is worse than the 1.6 m thickness window the test uses — so
      // out at the horizon it starts finding blockers in its own quantisation
      // noise. That arrived as a hard-edged wedge of shade lying across the
      // far water, on the far side of wherever this cutoff happened to fall.
      //
      // Two bounds, both faded rather than cut, because a step in either one
      // is itself a visible edge: the pixel must be well under the ray length
      // in size, and the fragment must be near enough that depth still has
      // bits to spare.
      vec3 Px = worldAt(vUv + vec2(uAoTexel.x, 0.0), d);
      float pxOk = 1.0 - smoothstep(uContactLen * 0.18, uContactLen * 0.34, length(Px - P));
      float nearOk = 1.0 - smoothstep(180.0, 340.0, length(P - uAoCam));
      float gate = pxOk * nearOk;
      if (gate > 0.004) {
        csh = contactShadow(vUv, P, normalize(cross(dPx, dPy))) * gate;
      }
    }
  }
  gl_FragColor = vec4(occlusion(vUv), csh, 0.0, 1.0);
}`;

// The occlusion, alone, as a multiply over whatever is already in MapLibre's
// buffer. This is the pass that darkens the STREET — the pavement is drawn by
// MapLibre, so the only way to put a building's contact shadow on it is to
// multiply the destination.
const AO_MULT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uAoTex;
void main() {
  vec2 a = texture2D(uAoTex, vUv).rg;
  // Cool, because ambient occlusion is the absence of SKY light and the sky
  // here is blue. A neutral grey multiply reads as dirt.
  vec3 tint = mix(vec3(1.0), vec3(0.62, 0.68, 0.80), a.r);
  // The contact shadow is the absence of SUN, which is a different and deeper
  // thing than the absence of sky — and bluer still, because what is left
  // lighting it is the dome.
  tint *= mix(vec3(1.0), vec3(0.55, 0.61, 0.76), a.g * 0.80);
  gl_FragColor = vec4(tint, 1.0);
}`;

// CREPUSCULAR RAYS — the reason to put the sun at 28 degrees in the first place.
//
// A low sun behind a skyline is the single most photographed thing a city
// does, and every part of the machinery to draw it was already here: a sun
// whose screen position is known, and a depth buffer that says exactly which
// pixels it can shine through. What was missing is the air for it to shine
// through, which in screen space is a radial blur of the SKY MASK away from
// the sun — light accumulating along each ray until a building interrupts it.
//
// Quarter resolution, because a shaft of light is the softest thing in any
// frame and there is no detail in it to lose. Twenty-four steps with a
// geometric decay, so the near end of each ray counts for most of it and the
// far end trails off rather than ending.
const SHAFT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uDepth;
uniform vec3 uSunScreen;
uniform float uDensity;
uniform float uDecay;
void main() {
  if (uSunScreen.z < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }
  else {
    vec2 uv = vUv;
    vec2 stride = (uv - uSunScreen.xy) * (uDensity / 24.0);
    float illum = 1.0;
    float acc = 0.0;
    for (int i = 0; i < 24; i++) {
      uv -= stride;
      // 1 where the ray is still in open sky, 0 the moment a building eats it
      acc += step(0.9999, texture2D(uDepth, uv).x) * illum;
      illum *= uDecay;
    }
    gl_FragColor = vec4(vec3(acc / 24.0), 1.0);
  }
}`;

// The composite. Tilt-shift first, then the bloom on top of it, because light
// that has spilled has already left the lens and does not get defocused again.
const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uTexel;
uniform float uBloomAmt;
uniform float uFocus;      // where the plane of focus sits, 0..1 up the frame
uniform float uBand;       // how much of the frame is sharp
uniform float uDefocus;    // blur radius in pixels at the top and bottom
uniform float uGrain;
uniform vec3 uSunScreen;   // xy = where the sun is on screen, z = 1 if in front
uniform vec3 uSunTint;
uniform float uGlare;
uniform sampler2D uShaft;
uniform float uShaftAmt;
uniform sampler2D uAoTex;
uniform sampler2D uIrr;
uniform float uBounce;
// still needed here, though the occlusion moved out: the glare has to know
// whether a building is standing between the camera and the sun
uniform sampler2D uDepth;
uniform mat4 uInvProj;
uniform vec3 uEye;
` + /* glsl */ `

// A MODEL CITY PHOTOGRAPHS LIKE A MODEL CITY.
//
// This game's whole identity is an architectural model — the README says so,
// the palette says so, the pale card stock the buildings are made of says so.
// A real model gets shot on a view camera close up, and a lens that close has
// a depth of field measured in centimetres, so the plate is sharp in a band
// and falls off above and below it. That single cue is why tilt-shift makes
// photographs of real cities look like toys: our eyes read the shallow focus
// as "this is small and it is near".
//
// Here it is the honest description of what the thing IS, and it costs eight
// taps on a disk whose radius is zero through the focus band.
// EDGES, BECAUSE GOING OFFSCREEN THREW THE MSAA AWAY.
//
// The direct path rendered into MapLibre's own multisampled buffer and got
// antialiasing for free. A render target does not come with that — and it
// cannot simply be asked for one either, because a multisampled target cannot
// also hand back the depth texture the occlusion pass reads. So the edges are
// found and softened here instead.
//
// Run on RGBA rather than RGB. The most visible edge in the frame is the
// city's silhouette against the basemap, and that is an edge in ALPHA: treat
// only the colour and every roofline stays a staircase.
vec4 fxaa(vec2 uv) {
  vec3 L = vec3(0.299, 0.587, 0.114);
  vec4 m  = texture2D(uScene, uv);
  vec4 nw = texture2D(uScene, uv + vec2(-1.0, -1.0) * uTexel);
  vec4 ne = texture2D(uScene, uv + vec2( 1.0, -1.0) * uTexel);
  vec4 sw = texture2D(uScene, uv + vec2(-1.0,  1.0) * uTexel);
  vec4 se = texture2D(uScene, uv + vec2( 1.0,  1.0) * uTexel);
  // alpha counts toward luma so a silhouette registers as contrast
  float lM  = dot(m.rgb,  L) + m.a  * 0.5;
  float lNW = dot(nw.rgb, L) + nw.a * 0.5;
  float lNE = dot(ne.rgb, L) + ne.a * 0.5;
  float lSW = dot(sw.rgb, L) + sw.a * 0.5;
  float lSE = dot(se.rgb, L) + se.a * 0.5;
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  // A HIGHER BAR NOW THAT COVERAGE SAMPLING IS BACK. MSAA answers geometric
  // edges properly, so this is left with the one thing it cannot: aliasing
  // generated INSIDE the fragment shader — window grids, mullions, seams —
  // which no amount of coverage sampling touches, because the geometry there
  // is one flat quad. At 0.028 it was also filtering pixels that were already
  // clean and quietly costing sharpness for it.
  if (lMax - lMin < 0.055) return m;            // flat, or MSAA already had it

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
  dir = clamp(dir * (1.0 / (min(abs(dir.x), abs(dir.y)) + red)), -8.0, 8.0) * uTexel;

  vec4 a = 0.5 * (texture2D(uScene, uv + dir * (1.0 / 3.0 - 0.5))
                + texture2D(uScene, uv + dir * (2.0 / 3.0 - 0.5)));
  vec4 b = a * 0.5 + 0.25 * (texture2D(uScene, uv + dir * -0.5)
                           + texture2D(uScene, uv + dir *  0.5));
  float lB = dot(b.rgb, L) + b.a * 0.5;
  return (lB < lMin || lB > lMax) ? a : b;
}

vec4 defocused(vec2 uv, float r) {
  // Inside the focus band there is no blur to hide the stair-stepping, so this
  // is where the edge work goes. Outside it the disk is already doing more
  // smoothing than any edge filter would.
  if (r < 0.35) return fxaa(uv);
  vec4 sum = texture2D(uScene, uv);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 2.39996323;
    float rr = sqrt((float(i) + 0.5) / 8.0) * r;
    sum += texture2D(uScene, uv + vec2(cos(a), sin(a)) * rr * uTexel);
  }
  return sum * (1.0 / 9.0);
}

/** World position from a depth sample. The view matrix here is identity, so
    inverting the projection lands straight in world space. */
vec3 dofWorldAt(vec2 uv, float d) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = uInvProj * clip;
  return p.xyz / p.w;
}

void main() {
  // FOCUS IS A DISTANCE, NOT A HEIGHT ON THE SCREEN.
  //
  // The band was measured in screen Y, which is only a stand-in for depth and
  // stops being one the moment anything is tall: a tower standing squarely in
  // the plane of focus went soft toward its roof for no reason except that its
  // roof was higher up the picture, while a rooftop two kilometres away at the
  // same screen height stayed sharp. Both are backwards, and on a skyline both
  // are obvious.
  //
  // The depth buffer has been sitting here since the occlusion pass went in.
  // Focus on what is actually in the middle of the frame and defocus by how
  // far from THAT each fragment lies, and the effect keeps the toy-model look
  // — in a pitched aerial view distance still correlates with screen height —
  // while treating buildings as the solid objects they are.
  //
  // The spread is proportional to the focus distance rather than absolute, so
  // one setting holds from a street corner to the whole island.
  float dFoc = texture2D(uDepth, vec2(0.5, uFocus)).x;
  float defocus;
  if (dFoc >= 0.9999) {
    // nothing under the focus point but sky — fall back to the screen-space
    // band, which is what this always was
    defocus = smoothstep(uBand, 1.0, abs(vUv.y - uFocus)) * uDefocus;
  } else {
    float focusD = length(dofWorldAt(vec2(0.5, uFocus), dFoc) - uEye);
    float dHere = texture2D(uDepth, vUv).x;
    // sky defocuses fully: it is the far plane, and a sharp horizon behind a
    // soft city is the one combination that reads as a bug
    float rel = dHere >= 0.9999
      ? 1.0
      // A FEW PER CENT OF THE SUBJECT DISTANCE, which is what a macro lens on
      // a real model actually has and what the eye reads as "this thing is
      // small". At 85% the sharp band swallowed the entire island and the
      // effect vanished into ordinary correctness — everything in focus is
      // physically defensible and photographically pointless.
      : clamp(abs(length(dofWorldAt(vUv, dHere) - uEye) - focusD) / max(focusD * 0.17, 30.0), 0.0, 1.0);
    defocus = smoothstep(0.16, 1.0, rel) * uDefocus;
  }
  vec4 c = defocused(vUv, defocus);

  // The same occlusion the multiply pass put on the street, applied to the
  // city's own geometry. Before the bloom: light that has already spilled off
  // a surface is not sitting in the crevice any more.
  vec2 aoc = texture2D(uAoTex, vUv).rg;
  c.rgb *= mix(vec3(1.0), vec3(0.62, 0.68, 0.80), aoc.r);
  c.rgb *= mix(vec3(1.0), vec3(0.55, 0.61, 0.76), aoc.g * 0.80);

  // INDIRECT BOUNCE — light the occlusion took away, given back in the colour
  // of whatever is standing next to it.
  //
  // This city is lit by two things: a sun, and a uniform blue sky dome. Real
  // shaded surfaces are lit mostly by their NEIGHBOURS — sunlit pavement
  // throwing warm light up under a cornice, a brick wall tinting the wall
  // across the alley, a courtyard glowing with its own stone. None of that
  // existed, and the occlusion pass made its absence worse: it subtracted
  // light in precisely the places where, in life, bounced light is doing most
  // of the lighting. That is why strong AO so often reads as dirt.
  //
  // The blurred scene is a serviceable estimate of local irradiance — at any
  // pixel it holds the average colour of its surroundings, which is what
  // bounced light is made of. Weighted by AO, so it arrives exactly where the
  // occlusion removed something, and multiplied by the surface's own colour,
  // because reflected light is albedo times irradiance and a wall only returns
  // what it is able to reflect. A red wall in a grey courtyard stays red.
  //
  // Honest about its limits: the streets are drawn by MapLibre and are not in
  // this buffer, so pavement bounce is not in here — that is the analytic
  // ground term in the light rig, and the two are meant to be read together.
  vec3 irr = texture2D(uIrr, vUv).rgb;
  c.rgb += irr * c.rgb * (aoc.r + aoc.g * 0.6) * uBounce;

  c.rgb += texture2D(uBloom, vUv).rgb * uBloomAmt;

  // THE SUN HAS BEEN LIGHTING THIS CITY AND HAS NEVER BEEN IN IT.
  //
  // The whole rig is built around a 28-degree sun — the shadows, the warm
  // west faces, the forward-scattered haze along its bearing — and turn the
  // camera to face it and there is nothing there. Real glass in front of a low
  // sun veils: light scatters inside the lens and lifts the whole frame near
  // it, with no visible disc needed.
  //
  // It has to be occluded, or the glare sits happily in front of the building
  // between you and it. One depth tap where the sun is, so a tower crossing
  // the sun cuts the flare — which is the moment the effect earns its place,
  // because that is when a viewer reads the light as being IN the scene.
  // The shafts go on before the veil, because the veil is happening in the
  // lens and the shafts are happening out in the city.
  if (uSunScreen.z > 0.5 && uShaftAmt > 0.001) {
    c.rgb += uSunTint * texture2D(uShaft, vUv).r * uShaftAmt;
  }

  if (uSunScreen.z > 0.5 && uGlare > 0.001) {
    // aspect-corrected, or the glare is an ellipse on any non-square window
    vec2 d = (vUv - uSunScreen.xy) * vec2(uTexel.y / max(uTexel.x, 1e-6), 1.0);
    float r = length(d);
    float blocked = step(0.9999, texture2D(uDepth, uSunScreen.xy).x);
    float veil = exp(-r * 4.2) * 0.55 + exp(-r * 13.0) * 0.45;
    c.rgb += uSunTint * veil * uGlare * blocked;
    // AND THE BODY OF IT. The veil says light is scattering in the lens; it
    // never says where from. Half a degree of actual disc, blown well past
    // white so it reads as a source rather than a pale spot, and gone the
    // instant anything crosses in front — which is the same depth tap the
    // veil already pays for.
    c.rgb += uSunTint * (1.0 - smoothstep(0.007, 0.015, r)) * uGlare * 7.0 * blocked;
  }

  // A WHISPER OF GRAIN. Everything above is smooth gradients over smooth
  // gradients — bloom, defocus, aerial haze — and smooth gradients on an 8-bit
  // buffer band. A dither below the level anybody can consciously see costs
  // one hash and removes every one of them.
  float g = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c.rgb += g * uGrain;

  gl_FragColor = c;
}`;

// LIVING WATER. Two crossed wave trains give a normal that actually moves,
// and everything else falls out of it: a Fresnel mix between deep water and
// sky, a sun glitter that breaks into sparkles on the wave faces, and a band
// of paler shallows near the shore. It is a few dozen instructions on one
// mesh, and it is the difference between a harbour and a blue rectangle.
const WATER_VERT = /* glsl */ `
attribute float aDepth;
varying vec2 vXY;
varying float vDepth;
void main() {
  vXY = position.xy;
  vDepth = aDepth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vXY;
varying float vDepth;
uniform float uTime;
uniform vec3 uCam;
uniform sampler2D uReflect;
uniform vec2 uResolution;
uniform float uReflectOn;
` + LIGHT_GLSL + SEASON_GLSL + HAZE_GLSL + /* glsl */ `
float wave(vec2 p, vec2 dir, float len, float spd, float t) {
  return sin(dot(p, dir) / len + t * spd);
}
void main() {
  vec2 p = vXY;
  float t = uTime;
  // three trains at different bearings and scales: one swell, two chop
  float h = wave(p, vec2(0.92, 0.39), 26.0, 1.05, t) * 0.55
          + wave(p, vec2(-0.44, 0.90), 13.0, 1.55, t) * 0.30
          + wave(p, vec2(0.68, -0.73), 6.2, 2.35, t) * 0.15;
  float dx = (wave(p + vec2(0.9, 0.0), vec2(0.92, 0.39), 26.0, 1.05, t) * 0.55
            + wave(p + vec2(0.9, 0.0), vec2(-0.44, 0.90), 13.0, 1.55, t) * 0.30
            + wave(p + vec2(0.9, 0.0), vec2(0.68, -0.73), 6.2, 2.35, t) * 0.15) - h;
  float dy = (wave(p + vec2(0.0, 0.9), vec2(0.92, 0.39), 26.0, 1.05, t) * 0.55
            + wave(p + vec2(0.0, 0.9), vec2(-0.44, 0.90), 13.0, 1.55, t) * 0.30
            + wave(p + vec2(0.0, 0.9), vec2(0.68, -0.73), 6.2, 2.35, t) * 0.15) - h;
  vec3 n = normalize(vec3(-dx * 0.66, -dy * 0.66, 1.0));

  vec3 V = normalize(uCam - vec3(p, 0.0));
  float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);

  // THE CITY STANDS ON THIS AND HAS NEVER ONCE APPEARED IN IT.
  //
  // Everything below — the shoal gradient, the sun's road, the foam on the
  // crests — describes water very well and describes water with NOTHING ON THE
  // FAR SIDE OF IT. A harbour in front of a city is mostly a picture of that
  // city, upside down and shaken; it is the single largest thing this surface
  // was missing, and no amount of tuning the blue could stand in for it.
  //
  // Planar reflection: the scene is rendered a second time with world Z
  // negated, which puts every building exactly where its reflection belongs on
  // screen, so this samples at its own fragment position — no matrix work in
  // here at all. The wave normal displaces the lookup, which is what turns a
  // mirror into water, and the displacement grows with distance because a
  // reflection seen at a grazing angle travels further across the surface.
  //
  // Alpha carries whether anything was actually there: where the mirrored
  // render is empty the water keeps the sky mix it always had.
  // AND IT IS A NEAR-FIELD EFFECT, for the same reason the occlusion is. Out
  // at the horizon the sea is edge-on: a single pixel of it spans hundreds of
  // metres, its reflection lookup lands wherever the mirrored city happens to
  // be, and the result arrives as ruled bands across the sky rather than as a
  // reflection of anything. A real harbour goes flat and bright out there too.
  float reflFar = 1.0 - smoothstep(350.0, 1500.0, length(vec3(vXY, 0.0) - uCam));
  vec3 reflCol = vec3(0.0);
  float reflA = 0.0;
  if (uReflectOn > 0.01 && reflFar > 0.002) {
    vec2 suv = gl_FragCoord.xy / uResolution;
    suv += n.xy * 0.055 * (0.35 + 0.65 * fres);
    vec4 r = texture2D(uReflect, clamp(suv, vec2(0.002), vec2(0.998)));
    // premultiplied, so undo it to get the colour back out
    reflA = r.a * reflFar * uReflectOn;
    reflCol = r.a > 0.001 ? r.rgb / r.a : vec3(0.0);
  }

  // SHALLOWS FOLLOW THE COAST. vDepth carries distance to the land edge, baked
  // per vertex, so the water genuinely pales where it runs up on the shore
  // instead of being one flat sheet with a painted band around it.
  // A HARBOUR HAS A BOTTOM. The old deep tone was a mid blue-grey that sat at
  // almost exactly the value of the pale stone across the shoreline, so the
  // single hardest edge in the frame — where the city stops and the sea starts
  // — was carrying no contrast at all. Deep water offshore is dark and it is
  // saturated, and giving it back both is what makes the island read as an
  // island rather than a pale shape on a pale field.
  // A HARBOUR HAS A BOTTOM, but a bottom is not a halo. The shoal band reads
  // over a shorter run than the sea's own colour change, or the island wears a
  // bright ring that reads as glow rather than as shallow water.
  float shoal = 1.0 - smoothstep(0.0, 120.0, vDepth);
  vec3 deep    = vec3(0.096, 0.245, 0.372);
  vec3 shallow = vec3(0.310, 0.534, 0.632);
  vec3 sky     = vec3(0.706, 0.822, 0.906);

  // THE SEA DID NOT KNOW WHAT MONTH IT WAS.
  //
  // Every other surface in this city reads the season — the trees turn, the
  // roofs take snow, the lawns go dormant — and the harbour, which is a third
  // of the frame in half the shots, was byte-identical in January and July.
  // The shader never even included the season block.
  //
  // Cold water genuinely looks different, and not only in temperature of hue:
  // there is less life suspended in it and less light coming back up from the
  // bottom, so it goes darker and greyer, and the shallows lose the green
  // entirely. Winter light is coming in at a lower angle onto the same
  // surface, which is the other half of why a northern harbour in February
  // reads like slate.
  deep    = mix(deep,    vec3(0.062, 0.150, 0.228), SNOW * 0.85);
  shallow = mix(shallow, vec3(0.286, 0.412, 0.470), SNOW * 0.85);
  sky     = mix(sky,     vec3(0.742, 0.800, 0.848), SNOW * 0.70);

  vec3 body = mix(deep, shallow, shoal * 0.82);
  vec3 col = mix(body, sky, 0.10 + 0.54 * fres);
  // Water reflects hardly anything face-on and nearly everything at a grazing
  // angle — that Fresnel curve is the whole reason a harbour mirrors the far
  // shore and not your own feet. Damped in the shallows, where the bottom is
  // close enough to see and the light coming back up through it competes.
  col = mix(col, reflCol, reflA * (0.09 + 0.72 * fres) * (1.0 - shoal * 0.45));

  // the sun's road across the water — broad sheen, then hard sparkles on the
  // faces that happen to be pointing at it
  vec3 H = normalize(normalize(SUN_DIR) + V);
  float spec = pow(max(dot(n, H), 0.0), 220.0);
  float sheen = pow(max(dot(n, H), 0.0), 24.0);
  float glit = pow(max(dot(n, H), 0.0), 800.0);   // the hard points in the road
  col += SUN_COL * (spec * 2.3 + sheen * 0.26 + glit * 3.4);

  // foam: only on the real crests, and heavier in the shallows where the
  // swell actually breaks
  col += vec3(0.075) * smoothstep(0.86, 1.02, h) * (0.5 + 0.8 * shoal);

  // THE WATER'S EDGE MOVES, AND THIS ONE WAS RULED IN PEN.
  //
  // The whole harbour has been alive for a while — the swell runs, the sun
  // road breaks up, the city reflects in it — and it all stopped dead at the
  // coastline, which was a fixed boundary between blue and sand. That edge is
  // the longest line in the frame and it rings the entire island, so a static
  // one is the single largest thing telling you the sea is a texture.
  //
  // vDepth already carries metres to the shore, baked per vertex for the
  // shoal. Running the waterline in and out along it costs one sine: the band
  // of wash advances a few metres up the beach and drags back, and because the
  // phase is driven by position as well as time it arrives along the coast
  // rather than the whole island pulsing at once.
  float swell = sin(uTime * 0.55 + vXY.x * 0.011 + vXY.y * 0.008)
              + 0.4 * sin(uTime * 0.83 - vXY.x * 0.019 + vXY.y * 0.013);
  float edge = vDepth - (3.4 + 2.0 * swell);
  float wash = 1.0 - smoothstep(0.0, 4.8, abs(edge));
  // Thickest right at the top of its run, the way a spent wave is, and gone
  // under ice — a rimed harbour has no surf.
  col = mix(col, vec3(0.880, 0.910, 0.932),
            wash * 0.52 * smoothstep(0.0, 0.35, swell + 1.4) * (1.0 - SNOW * 0.75));

  // RIME. A cold harbour does not freeze over — this one has ships working it
  // all winter — but the still water inside the shoal line skins over and
  // takes a crust along the shore, and that pale fringe against dark water is
  // the single most legible sign that a port is in February. It sits where the
  // shallows already are, thickened by the same low-frequency noise the swell
  // uses so the edge is ragged rather than drawn with a compass.
  if (SNOW > 0.02) {
    float crust = smoothstep(0.45, 1.0, shoal) * SNOW;
    float ragged = 0.55 + 0.45 * sin(p.x * 0.031 + p.y * 0.047)
                            * sin(p.x * 0.017 - p.y * 0.023);
    col = mix(col, vec3(0.845, 0.878, 0.905), clamp(crust * ragged * 0.80, 0.0, 1.0));
  }

  // THE SEA HAS NO EDGE AND THIS MESH DOES. The sheet stops at six kilometres,
  // and the global aerial term — deliberately weakened so the city keeps its
  // contrast — no longer takes the far water all the way to the sky, so the
  // boundary of the plane arrives as a ruled line straight across the picture.
  // The sea gets its own far-field fade, run to completion, because the one
  // thing the horizon must never do is show you where the geometry ran out.
  // The sheet is a SQUARE six kilometres on the half-side, so its corners
  // reach 1.41x further than its edges and a fade that is still running at the
  // edge distance shows the diagonal. Finish well inside the boundary, and
  // finish on the sky's own horizon colour rather than the haze grey, so the
  // sea meets the sky instead of meeting a slightly different sky.
  vec3 outc = aerial(grade(col), vec3(vXY, 0.0), uCam);
  float dist = length(vec3(vXY, 0.0) - uCam);
  outc = mix(outc, vec3(0.874, 0.914, 0.933), smoothstep(1400.0, 3900.0, dist));
  gl_FragColor = vec4(outc, 1.0);
}`;

const PROP_FRAG = /* glsl */ `
precision highp float;
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
uniform vec3 uColor;
uniform float uOpacity;
uniform vec3 uCam;
uniform float uFoliage;   // 0 = not a leaf, 1 = deciduous canopy, 2 = conifer
` + SHADOW_GLSL + LIGHT_GLSL + SEASON_GLSL + HAZE_GLSL + /* glsl */ `
void main() {
  vec3 n = normalize(vN);
  vec3 base = uColor * vC;
  if (uFoliage > 0.5 && uFoliage < 1.5) {
    base = seasonGreen(base);
    base = mix(base, vec3(0.068, 0.045, 0.030), BARE * 0.80);
  } else if (uFoliage > 1.5) {
    base = mix(base, base * vec3(0.82, 0.90, 0.94), (1.0 - VIGOUR) * 0.45);
  }
  if (SNOW > 0.001) base = snowOn(base, smoothstep(0.30, 0.85, n.z), 0.85);
  base *= mix(1.0, 0.84, RAIN * smoothstep(0.18, 0.88, n.z));
  float vis = sunVis(vW, n);
  float ao = mix(0.62, 1.0, clamp(vW.z / 5.0, 0.0, 1.0));
  vec3 light;
  if (uFoliage > 0.5) {
    // A CANOPY IS NOT AN OPAQUE SOLID, and shading it like one is why every
    // tree in this city has been a green rock. Two things are wrong with a
    // Lambert term on foliage, and both have one-line fixes.
    //
    // It has no hard terminator. A canopy is a thousand leaves at a thousand
    // angles, not one surface, so the light wraps around it well past where
    // the geometric normal says it should stop.
    float wrap = max((dot(n, SUN_DIR) + 0.42) / 1.42, 0.0);
    //
    // And it TRANSMITS. Look at a sunlit tree from the shaded side and it does
    // not read dark, it GLOWS — you are seeing light that came THROUGH a leaf
    // rather than off one, which is why it arrives warmer and greener than the
    // light that fell on it. It is the single most recognisable thing foliage
    // does and it costs one dot product: strongest looking into the sun,
    // strongest on the faces the sun cannot reach directly.
    vec3 Vv = normalize(uCam - vW);
    float thru = pow(max(dot(-Vv, SUN_DIR), 0.0), 2.6)
               * (1.0 - max(dot(n, SUN_DIR), 0.0))
               * (1.0 - BARE);      // in February there is nothing to shine through
    light = SUN_COL * (wrap * vis * 0.80)
          + hemiLight(n, ao)
          + SUN_COL * vec3(0.72, 1.02, 0.50) * (thru * vis * 0.62);
  } else {
    light = SUN_COL * (max(dot(n, SUN_DIR), 0.0) * vis * 0.92) + hemiLight(n, ao);
  }
  gl_FragColor = vec4(aerial(grade(base * light), vW, uCam), uOpacity);
}`;

/** GLSL's smoothstep, on the CPU side, for uniforms that ease. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const SUN_LEN = 1.05799;
const SUN_EL_MID = 27.96, SUN_EL_AMP = 6.0;
const SUN_AZ_MID = 125.38, SUN_AZ_AMP = 12;
// Lifted with the sky dome's drop, so a sunlit wall keeps the exposure it had
// and only the shaded one moves. The ratio between them is the whole point.
const SUN_COL_SUMMER: readonly [number, number, number] = [1.462, 1.258, 0.936];
const SUN_COL_WINTER: readonly [number, number, number] = [1.686, 0.886, 0.272];
const SUN_WARMTH = 0.55;

const SEASON_TABLE: readonly (readonly [number, number, number, number])[] = [
  [0.95, 0.00, 1.00, 0.00],  // Jan
  [1.00, 0.00, 1.00, 0.00],  // Feb
  [0.50, 0.00, 0.90, 0.12],  // Mar
  [0.08, 0.00, 0.42, 0.55],  // Apr
  [0.00, 0.00, 0.04, 0.90],  // May
  [0.00, 0.00, 0.00, 1.00],  // Jun
  [0.00, 0.00, 0.00, 1.00],  // Jul
  [0.00, 0.05, 0.00, 0.96],  // Aug
  [0.00, 0.28, 0.00, 0.82],  // Sep
  [0.00, 0.80, 0.12, 0.52],  // Oct
  [0.10, 0.95, 0.68, 0.16],  // Nov
  [0.62, 0.55, 0.96, 0.02],  // Dec
];

interface Ranges { start: number; count: number }

export class ThreeBuildings implements maplibregl.CustomLayerInterface {
  id = "bw-three-buildings";
  type = "custom" as const;
  renderingMode = "3d" as const;

  private map!: maplibregl.Map;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private origin!: { x: number; y: number; z: number; s: number };
  private wallMat!: THREE.ShaderMaterial;
  private roofMat!: THREE.ShaderMaterial;
  private tintAttrs: THREE.BufferAttribute[] = [];
  private litAttrs: THREE.BufferAttribute[] = [];
  private retAttrs: THREE.BufferAttribute[] = [];
  private baseTints: Float32Array[] = [];
  // ONE camera uniform, shared by every material — walls, roofs and props all
  // have to haze against the same eye point or the city separates into layers.
  private camUni = { value: new THREE.Vector3(0, 0, 800) };
  private timeUni = { value: 0 };
  private activityUni = { value: 1 };
  private waterMat: THREE.ShaderMaterial | null = null;
  private lastFrame = 0;
  // ---- frame budget --------------------------------------------------------
  // The city is drawn as a photograph. Still frames keep the full post stack.
  // While the camera is moving, and when a frame overruns its budget on a weak
  // GPU, the most expensive passes are deferred — never deleted — so the look
  // returns the moment the map settles and the machine catches up.
  private camMoving = false;
  private moveListeners = false;
  private frameEma = 16;
  private reflFrame = 0;
  private preferFps = false;
  private msaaSamples = 4;
  private propMats = new Map<string, THREE.ShaderMaterial>();
  // ---- post stage ----
  private postOK = true;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  private reflectRT: THREE.WebGLRenderTarget | null = null;
  private shaftRT: THREE.WebGLRenderTarget | null = null;
  private irrA: THREE.WebGLRenderTarget | null = null;
  private irrB: THREE.WebGLRenderTarget | null = null;
  private aoA: THREE.WebGLRenderTarget | null = null;
  private aoB: THREE.WebGLRenderTarget | null = null;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postQuad: THREE.Mesh | null = null;
  private brightMat!: THREE.ShaderMaterial;
  private blurMat!: THREE.ShaderMaterial;
  private compMat!: THREE.ShaderMaterial;
  private aoMultMat!: THREE.ShaderMaterial;
  private shaftMat!: THREE.ShaderMaterial;
  private aoCalcMat!: THREE.ShaderMaterial;
  private postSize = new THREE.Vector2(0, 0);
  /** Exposed for playtests: the only way to assert a demolition really happened. */
  posAttrs: THREE.BufferAttribute[] = [];
  rangesByBBL = new Map<string, { attr: number; r: Ranges }[]>();
  private lotRings = new Map<string, [number, number][]>(); // vacant-lot footprints (meters)
  private ringByBBL = new Map<string, [number, number][]>(); // EVERY lot's BUILDING footprint, built or not
  /**
   * THE DEED'S OUTLINE, WHICH IS NOT THE BUILDING'S.
   *
   * `ringByBBL` is named for a lot and holds a BUILDING. Its two producers are
   * disjoint: citygen/build.mjs walks the building polygons for anything
   * standing, and appends lot polygons only for parcels whose class is "land".
   * So a built lot never carries a parcel-sized ring, and `setPlayerBuildings`
   * — which fell back to it — drew every redevelopment inside the outline of
   * whatever had just been demolished.
   *
   * Measured over 10,028 built lots across three cities and four seeds, the
   * building ring is a MEDIAN 66.5% of its lot and is under 90% on every
   * single one. End to end through twenty-one real redevelopments at the UI's
   * default dial: the panel promised 60% of the lot and the map drew a median
   * of 40.0%. A new tower could not out-cover the shed it replaced.
   *
   * Lazily projected from the parcel table, which the renderer is handed and
   * was not reading.
   */
  private parcelRings = new Map<string, [number, number][]>();
  private parcelRingsReady = false;
  private lotRing(bbl: string): [number, number][] | undefined {
    if (!this.parcelRingsReady) {
      this.parcelRingsReady = true;
      for (const [b, ll] of Object.entries(this.ctxPoints.lots ?? {})) {
        if (ll && ll.length >= 3) this.parcelRings.set(b, ll.map((p) => this.project(p)));
      }
    }
    // vacant-lot ring first (already projected and identical to the parcel),
    // then the deed, and the demolished building's outline only as a last
    // resort for a bbl the parcel table does not carry
    return this.lotRings.get(bbl) ?? this.parcelRings.get(bbl) ?? this.ringByBBL.get(bbl);
  }
  /** Exposed (not private) so a playtest can assert a demolition actually happened. */
  propsByBBL = new Map<string, { mesh: THREE.InstancedMesh; i: number }[]>();
  private flattened = new Set<string>();
  private dynGroup = new THREE.Group();
  // The pivoting jib assemblies of live construction cranes: render() swings
  // each Group's rotation.z off the shared clock, so the slew costs one
  // property write per crane per frame, and a dynGroup rebuild clears the
  // list wholesale alongside the meshes it points into.
  private cranes: { g: THREE.Group; bear: number; w: number; phase: number }[] = [];
  private shadowTex: THREE.Texture | null = null;
  private water: THREE.Mesh | null = null;
  // dressing for the unbuilt half of the city, collected while the volumes are
  // walked and instanced along with the street planting
  private lotTrees: { x: number; y: number; s: number; rot: number }[] = [];
  private lotCars: { x: number; y: number; s: number; rot: number }[] = [];
  private sunVP = new THREE.Matrix4();
  private sunDirUni = { value: new THREE.Vector3(0.762, -0.541, 0.496) };
  private sunColUni = { value: new THREE.Vector3(1.26, 1.09, 0.82) };
  private seasonUni = { value: new THREE.Vector4(0, 0, 0, 1) };
  private seasonBase = new THREE.Vector4(0, 0, 0, 1);
  private weatherUni = { value: new THREE.Vector2(0, 0) };
  private weatherSnow = 0;
  private simMonth = -1;
  private sunDirty = false;
  /** demandScore by bbl, pushed by MapView before the layer is added — the
   *  foot-traffic gradient reads it so a dying block LOOKS empty. */
  private demandByBbl: Record<string, number> = {};
  /** true once any walker mesh exists — gates the animation clock. */
  private hasWalkers = false;
  private hasPonds = false;
  private shadowTarget: THREE.WebGLRenderTarget | null = null;
  private shadowSpan = 5999;
  private depthMat: THREE.MeshDepthMaterial | null = null;
  private groundCatcher: THREE.Mesh | null = null;
  private groundSheen: THREE.Mesh | null = null;
  private aoGround: THREE.Mesh | null = null;
  visible = true;

  constructor(
    private volumes: BuildingVolume[],
    private center: [number, number],
    private curbs: [number, number][][] = [],
    private ctxPoints: {
      trees?: [number, number][];
      piles?: [number, number][];
      land?: [number, number][];
      // street furniture arrives with a baked bearing: a bench that does not
      // face its walk, or a railing post turned across the seawall, is worse
      // than no bench and no railing at all
      benches?: Oriented[];
      rails?: Oriented[];
      parks?: [number, number][][];
      ponds?: [number, number][][];
      paths?: [number, number][][];
      /**
       * THE PARCEL OUTLINES, BY BBL — the one piece of per-lot geometry this
       * class did not have and needed. See setPlayerBuildings: `volumes` only
       * ever carries BUILDING rings for a built lot, so a redevelopment was
       * drawn on the footprint of whatever was knocked down.
       */
      lots?: Record<string, [number, number][]>;
    } = {},
    /**
     * The town's seed, mixed into every per-building hash. Without it a reroll
     * gave block 40 lot 3 the identical facade it had in the last city — the
     * geometry changed and the skin did not.
     */
    private citySeed = 1,
  ) {}

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: this.center[0], lat: this.center[1] }, 0);
    this.origin = { x: mc.x, y: mc.y, z: mc.z, s: mc.meterInMercatorCoordinateUnits() };
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.camera.matrixAutoUpdate = false;
    this.buildCity();
    this.initPost();
    // Interaction is temporary: drop the second city draw and the lens extras
    // for the duration of a pan/zoom/pitch, restore them on settle. The still
    // photograph the player studies is unchanged.
    if (!this.moveListeners) {
      this.moveListeners = true;
      const start = () => { this.camMoving = true; };
      const end = () => { this.camMoving = false; this.map.triggerRepaint(); };
      for (const e of ["movestart", "zoomstart", "rotatestart", "pitchstart"] as const) map.on(e, start);
      for (const e of ["moveend", "zoomend", "rotateend", "pitchend"] as const) map.on(e, end);
    }
  }

  /**
   * Prefer smoother frames on weak GPUs. Keeps the same scene and the same
   * post vocabulary — lowers pixel density and MSAA, and lets the frame budget
   * skip the second city draw more readily. Off by default so a capable
   * machine still gets the native photograph.
   */
  setPreferFps(on: boolean) {
    if (this.preferFps === on) return;
    this.preferFps = on;
    this.msaaSamples = on ? 2 : 4;
    // Force the post targets to rebuild at the new sample count.
    this.postSize.set(0, 0);
    if (this.map) this.map.triggerRepaint();
  }

  // ---- the post stage ------------------------------------------------------

  /**
   * Build the offscreen targets and the three screen passes. Every failure
   * here is survivable: `postOK` goes false and `render` draws straight into
   * MapLibre's buffer the way it always did, so the worst case is the city
   * without bloom rather than no city.
   */
  private initPost() {
    try {
      const quad = new THREE.PlaneGeometry(2, 2);
      this.brightMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT, fragmentShader: BRIGHT_FRAG, depthTest: false, depthWrite: false,
        // MEASURED AGAINST THE WORST CASE, which is January. A city under snow
        // in low sun puts most of its roofs above 0.75 luminance, so a
        // threshold picked while looking at summer stone turns every roof in
        // town into a light source and the whole frame fogs. It has to sit
        // above the brightest thing that is merely WELL LIT, and catch only
        // what is actually specular: glints off water and glass.
        uniforms: { uTex: { value: null }, uThresh: { value: 0.86 }, uKnee: { value: 0.16 } },
      });
      this.blurMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
        uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
      });
      const aoUniforms = () => ({
        uDepth: { value: null as THREE.Texture | null },
        uInvProj: { value: new THREE.Matrix4() },
        uAoTexel: { value: new THREE.Vector2() },
        uAoCam: { value: new THREE.Vector3() },
        // Two and a half metres. An alley is three or four wide, a light well
        // less; much beyond this and a building starts occluding the one
        // across the street, which is a shadow, not contact.
        uAoRadius: { value: 2.5 },
        uAoStrength: { value: 1.30 },
        uProj: { value: new THREE.Matrix4() },
        uAoSun: { value: new THREE.Vector3() },
        // Two metres. Past that the shadow map has the resolution to do the
        // job properly and a screen-space ray starts inventing occluders out
        // of whatever happens to be in front.
        uContactLen: { value: 2.0 },
      });
      this.aoCalcMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT, fragmentShader: AO_CALC_FRAG, depthTest: false, depthWrite: false,
        uniforms: aoUniforms(),
      });
      this.aoMultMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT, fragmentShader: AO_MULT_FRAG, depthTest: false, depthWrite: false,
        transparent: true,
        // dst *= src — the only way to put a contact shadow onto pavement this
        // layer did not draw
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        uniforms: { uAoTex: { value: null } },
      });
      this.shaftMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT, fragmentShader: SHAFT_FRAG, depthTest: false, depthWrite: false,
        uniforms: {
          uDepth: { value: null }, uSunScreen: { value: new THREE.Vector3() },
          // Density is how far back along each ray the walk reaches. Much past
          // this and the shafts stop converging on the sun and start looking
          // like a zoom blur of the whole frame.
          uDensity: { value: 0.62 }, uDecay: { value: 0.955 },
        },
      });
      this.compMat = new THREE.ShaderMaterial({
        vertexShader: POST_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
        transparent: true,
        // THE SCENE TARGET HOLDS PREMULTIPLIED COLOUR, because that is what a
        // Three renderer writes. Compositing it over MapLibre's basemap with
        // the usual SRC_ALPHA blend would multiply by alpha a second time and
        // every translucent thing in the city — the shadow catcher above all —
        // would come out half strength. ONE / ONE_MINUS_SRC_ALPHA is the
        // premultiplied form and is what makes the composite invisible.
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        uniforms: {
          uScene: { value: null }, uBloom: { value: null },
          uTexel: { value: new THREE.Vector2() },
          // Bloom is a garnish. At 0.62 it was an atmosphere, and an
          // atmosphere made of clipped highlights is just fog with extra steps.
          uBloomAmt: { value: 0.20 },
          // The focus band sits a little above centre: in a pitched view the
          // middle of the frame is the middle distance, which is where the
          // city one is actually looking at lives.
          uFocus: { value: 0.56 }, uBand: { value: 0.26 }, uDefocus: { value: 2.7 },
          uGrain: { value: 0.006 },
          uSunScreen: { value: new THREE.Vector3() },
          uSunTint: { value: new THREE.Vector3(1.0, 0.86, 0.66) },
          uGlare: { value: 0.30 },
          uShaft: { value: null }, uShaftAmt: { value: 0.42 },
          uAoTex: { value: null }, uDepth: { value: null },
          uIrr: { value: null }, uBounce: { value: 0.40 },
          uInvProj: { value: new THREE.Matrix4() }, uEye: { value: new THREE.Vector3() },
        },
      });
      this.postQuad = new THREE.Mesh(quad, this.brightMat);
      this.postQuad.frustumCulled = false;
      this.postScene.add(this.postQuad);
    } catch {
      this.postOK = false;
    }
  }

  /** Match the targets to the drawing buffer; rebuild them when it changes. */
  private ensurePostSize(): boolean {
    if (!this.postOK || !this.postQuad) return false;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (size.x < 4 || size.y < 4) return false;
    // Prefer-FPS rebuilds with fewer samples; the sample count is part of the
    // identity of the target, so a change here has to tear it down too.
    if (
      this.sceneRT
      && size.x === this.postSize.x
      && size.y === this.postSize.y
      && (this.sceneRT.samples ?? 0) === this.msaaSamples
    ) return true;
    try {
      this.sceneRT?.dispose(); this.bloomA?.dispose(); this.bloomB?.dispose();
      const opts = {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: true, stencilBuffer: false,
      } as const;
      // MULTISAMPLING, IF THE DEPTH TEXTURE SURVIVES IT.
      // FXAA is a blur that guesses at edges from colour; it does nothing for
      // the real problem at the establishing zoom, which is geometry smaller
      // than a pixel — a roof vent or a parked car one pixel wide either
      // covers its pixel or does not, and the city speckles. Coverage sampling
      // is the only thing that actually answers that. The open question is
      // whether this implementation will resolve a multisampled depth
      // attachment back into a sampleable texture, which the occlusion, the
      // focus and the sun glare all now depend on.
      // Prefer-FPS drops to 2x — still coverage-sampled, half the resolve cost.
      this.sceneRT = new THREE.WebGLRenderTarget(size.x, size.y, { ...opts, samples: this.msaaSamples });
      // The occlusion pass reads this. UnsignedInt rather than the default
      // UnsignedShort: at 16 bits the reconstruction quantises into visible
      // terraces across a frame that spans kilometres.
      const dt = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      this.sceneRT.depthTexture = dt;
      // Bloom runs at quarter resolution. It is a wide blur — nobody can see
      // the resolution it was computed at, and it is the difference between
      // the pass costing something and costing nothing.
      const bw = Math.max(2, size.x >> 2), bh = Math.max(2, size.y >> 2);
      this.bloomA = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
      this.bloomB = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
      // The reflection runs at half resolution. It is about to be displaced by
      // a wave normal and then mixed in at a Fresnel weight; there is no
      // resolution in it left to see.
      this.irrA?.dispose(); this.irrB?.dispose();
      this.irrA = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
      this.irrB = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
      this.aoA?.dispose(); this.aoB?.dispose();
      const aw = Math.max(2, size.x >> 1), ah = Math.max(2, size.y >> 1);
      this.aoA = new THREE.WebGLRenderTarget(aw, ah, { ...opts, depthBuffer: false });
      this.aoB = new THREE.WebGLRenderTarget(aw, ah, { ...opts, depthBuffer: false });
      this.shaftRT?.dispose();
      this.shaftRT = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false });
      this.reflectRT?.dispose();
      this.reflectRT = new THREE.WebGLRenderTarget(
        Math.max(2, size.x >> 1), Math.max(2, size.y >> 1),
        { ...opts, depthBuffer: true },
      );
      this.postSize.copy(size);
      return true;
    } catch {
      this.postOK = false;
      return false;
    }
  }

  private blit(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.postQuad!.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.postScene, this.postCam);
  }

  private project([lon, lat]: [number, number]): [number, number] {
    const kx = 111320 * Math.cos((this.center[1] * Math.PI) / 180);
    return [(lon - this.center[0]) * kx, (lat - this.center[1]) * 111320];
  }

  private buildCity() {
    const blank = geomBuf;
    const W = blank();
    const R = blank();
    /**
     * THE RENDERER DID NOT KNOW HOW OLD ANY BUILDING WAS.
     *
     * `v.y` — the year the thing was built — sits on every volume record and
     * is used to gate gable, mansard and hip massing. Then it is thrown away.
     * meta is [style, rand, varr, top, fh]; there is no room in it for a date
     * and the fragment shader has never seen one.
     *
     * Measured over 5,697 built volumes in five cities: S_BRICK carries 2,403
     * buildings spanning 1885 to 1994 — a hundred and nine years, five
     * construction eras — through ONE eight-hue palette. S_PREWAR carries
     * 1,655 spanning 1885 to 2018 through one seven-stone palette. That is
     * 71.2% OF EVERY CITY painted by a style whose era span exceeds a century.
     * A house finished the year Grover Cleveland took office and a block of
     * flats finished the year the iPhone shipped are the same eight colours.
     *
     * One float fixes it. Set once per volume, read by every triangle that
     * volume emits, so a building's cornice ages with its wall.
     */
    const mst: MasonState = { era: 0.5, deck: 0, wear: 0.5, bearX: 1, bearY: 0 };
    const wallRanges: { bbl: string; r: Ranges }[] = [], roofRanges: { bbl: string; r: Ranges }[] = [];
    // EVERY PROP KNOWS WHICH BUILDING IT IS STANDING ON. Water tanks, cooling
    // towers, aerials and fire escapes were pushed into scene-level instanced
    // meshes with no reference back to a deed, so when a building came down
    // its roof furniture stayed hanging in the air over the empty lot. One
    // field fixes that.
    const props: { kind: number; x: number; y: number; z: number; s: number; rot: number; b?: string }[] = [];

    const volsPerBBL = new Map<string, number>();
    for (const v of this.volumes) if (v.b && !v.k) volsPerBBL.set(v.b, (volsPerBBL.get(v.b) ?? 0) + 1);

    // ONE TROWEL, SHARED. These were six local closures; they are the module
    // level `Mason` now so that `setPlayerBuildings` can lay the same courses.
    // `mst` is what `curEra` / `curDeck` / `curWear` / the deck bearing were —
    // mutated per volume below, read by every triangle that volume emits.
    const mason = makeMason(mst);
    const { tri: pushWallTri, wall: extrudeWalls, cap: capRoof } = mason;
    // Every pitched roof in the static stock goes into the roof buffer.
    const pitchCap = (ring: [number, number][], z: number, rise: number, inset: number, meta: number[]) =>
      mason.pitch(R, ring, z, rise, inset, meta);

    const decoTintRanges: { attr: number; r: Ranges; c: [number, number, number] }[] = [];
    for (const v of this.volumes) {
      const style = styleFor(v);
      // EVERY FACADE CHOICE IN THE CITY CAME OUT OF 485 NUMBERS.
      //
      // This was `((v.t + 1) * 0.19 + (bbl % 97) / 97) % 1`, with varr a pure
      // function of rnd — so the entire per-building random state was ONE
      // scalar with period lcm(5, 97) = 485. Four hundred and eighty-five
      // values existed, ever, in any city. And it never read the city seed, so
      // rerolling the town gave block 40 lot 3 the identical tone, banding,
      // quoins and parapet height it had before.
      //
      // Worse, it was periodic ON THE GROUND. bbl encodes block*10000 + lot,
      // so lot -> lot+5 moved rnd by 5/97 = 0.0515. Measured across every
      // parcel, mean |delta rnd| at lag 5 was 0.0515 against 0.333 for uniform
      // random — a row of houses ran light, mid, dark, light, mid and started
      // over every fifth lot. That stripe is what a street actually looks
      // like from above, and it is why the city read as wallpaper.
      //
      // Two independent hashes now, mixed with the city seed, so a reroll is a
      // genuinely different town and neighbours are uncorrelated.
      // 0 = 1870, 1 = 2030. Every triangle this volume emits carries it.
      mst.era = Math.max(0, Math.min(1, ((v.y || 1950) - 1870) / 160));
      const key = keyOf(v.b) ^ Math.imul(v.t + 1, 0x9e3779b1);
      const rnd = hash01(key, this.citySeed);
      const varr = hash01(key ^ 0x5bf03635, Math.imul(this.citySeed, 3) + 1);
      const fh = v.f > 0 && v.z1 > 0 ? Math.max(2.6, v.z1 / Math.max(v.f, 1)) : 3.55;
      let ring = v.r.map((p) => this.project(p));
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
        area += x1 * y2 - x2 * y1;
      }
      if (area < 0) ring = ring.slice().reverse();

      {
        mst.deck = roofDeck(style, v.y || 1950, v.f, v.z1,
          hash01(key ^ 0x2f7d3a11, this.citySeed ^ 0x5eed100f));
        if (v.d) mst.deck = 8;
        mst.wear = hash01(key ^ 0x7a1c9d3f, this.citySeed ^ 0x0badf00d);
        let bi = 0, bl = -1;
        for (let i = 0; i < ring.length; i++) {
          const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
          const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          if (L > bl) { bl = L; bi = i; }
        }
        const p0 = ring[bi], p1 = ring[(bi + 1) % ring.length];
        const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
        mst.bearX = (p1[0] - p0[0]) / L; mst.bearY = (p1[1] - p0[1]) / L;
      }

      const wallStart = W.pos.length / 3;
      const roofStart = R.pos.length / 3;

      // A FOOTPRINT FOR EVERY DEED. lotRings only ever recorded VACANT lots,
      // which is why demolishing a building you bought did nothing: the code
      // that clears a lot looked the ring up first and gave up when it was
      // missing. Keep the largest volume's ring for buildings made of several.
      if (v.b) {
        const prev = this.ringByBBL.get(v.b);
        if (!prev || Math.abs(area) > ringArea(prev)) this.ringByBBL.set(v.b, ring);
      }
      const propStart = props.length;

      // ---- vacant lot: gravel pad + low fence ------------------------------
      if (v.k) {
        if (v.b) this.lotRings.set(v.b, ring);
        capRoof(R, ring, 0.06, [S_LOT, rnd, varr, 1, fh]);
        const fence = insetRing(ring, 0.5);
        if (fence) extrudeWalls(W, fence, 0, 1.15, [S_LOT, rnd, varr, 1.15, fh]);
        // WHAT VACANT LAND ACTUALLY DOES. Nearly half this city is unbuilt —
        // that is the game's whole surface — and all of it read as blank plate
        // from the air, which is what turned whole districts into pale voids.
        // Empty ground in a real city is never empty: downtown lots get paved
        // and parked on, and the ones nobody bothers with go to weeds and
        // volunteer trees inside five years. The shader already splits gravel
        // / grass / dirt on vVar; this dresses each to match.
        const m2 = Math.abs(area) / 2;
        if (varr > 0.62) {
          // gone to scrub: small self-seeded trees, thicker toward the middle
          const n = Math.min(48, Math.max(3, Math.round(m2 / 85)));
          for (const p of scatterInRing(ring, n, rnd)) {
            this.lotTrees.push({ x: p[0], y: p[1], s: 0.55 + ((p[0] * 7.3 + p[1] * 3.1) % 1) * 0.45, rot: (p[1] * 2.1) % 6.28 });
          }
        } else if (varr > 0.18 && m2 > 380) {
          // surface parking, which is what a downtown hole in the ground earns
          // until somebody builds on it. Rows share one bearing — scattered
          // cars read as a junkyard, aligned ones read as a lot.
          let bi = 0, bl = -1;
          for (let i = 0; i < ring.length; i++) {
            const a2 = ring[i], b2 = ring[(i + 1) % ring.length];
            const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
            if (L > bl) { bl = L; bi = i; }
          }
          const a2 = ring[bi], b2 = ring[(bi + 1) % ring.length];
          const rot = Math.atan2(b2[1] - a2[1], b2[0] - a2[0]) + Math.PI / 2;
          // a stall plus its share of aisle is about 85 m2; the cap only
          // bites on the full-block lots, which really do hold that many
          const n = Math.min(90, Math.max(3, Math.round(m2 / 85)));
          for (const p of scatterInRing(ring, n, rnd + 0.37)) {
            this.lotCars.push({ x: p[0], y: p[1], s: 1, rot });
          }
        }
        if (v.b) {
          wallRanges.push({ bbl: v.b, r: { start: wallStart, count: W.pos.length / 3 - wallStart } });
          roofRanges.push({ bbl: v.b, r: { start: roofStart, count: R.pos.length / 3 - roofStart } });
        }
        continue;
      }

      const meta = [style, rnd, varr, v.z1, fh];
      const dWall0 = W.pos.length / 3, dRoof0 = R.pos.length / 3;
      // WHERE THE PLANT ACTUALLY STANDS. A tall building's roof is mostly
      // penthouse — the stair and lift overrun below covers the plate bar a
      // three-to-four-metre terrace — and the kit was being fitted to the
      // plate UNDERNEATH it. On all 89 penthoused buildings in New Alden every
      // piece of plant that got placed was placed inside the penthouse it
      // should have been standing on. The machine deck of a real tower is the
      // roof of that penthouse; where there is one, that is the polygon the
      // kit is laid out on, at the height its own cap was drawn.
      let mechDeck: { ring: [number, number][]; z: number } | null = null;
      // WHERE THE TOP OF THIS BUILDING ACTUALLY IS. A landmark stands on the
      // ridge of a pitched roof or on the deck of a penthouse, not on the
      // eaves line — each roof branch below reports its own height here.
      let roofZ = v.z1;
      extrudeWalls(W, ring, v.z0, v.z1, meta);

      // ---- gabled colonial roofs in the old fabric -------------------------
      const gable = ring.length === 4 && v.z1 > 0 && v.z1 <= 15 && v.y > 0 && v.y < 1945 &&
        has(T_OLDROOF, style) && volsPerBBL.get(v.b) === 1;
      // the rest of the old stock, which the gable path could never reach
      const oldStock = !v.d && !v.k && !gable && v.y > 0 &&
        has(T_OLDROOF, style) && ring.length >= 3;
      const mansard = oldStock && v.y < 1935 && v.z1 >= 11 && v.z1 <= 28 && varr > 0.66;
      const hip = oldStock && !mansard && v.y < 1945 && v.z1 > 3 && v.z1 <= 14 && varr > 0.34;
      if (gable) {
        const [v0, v1, v2, v3] = ring;
        const len = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
        let q = [v0, v1, v2, v3];
        if (len(v0, v1) + len(v2, v3) < len(v1, v2) + len(v3, v0)) q = [v1, v2, v3, v0];
        const [a0, a1, b0, b1] = [q[0], q[1], q[2], q[3]]; // eaves: a0→a1 and b0→b1
        const shortLen = Math.min(len(a1, b0), len(b1, a0));
        const rise = Math.min(3.4, Math.max(1.8, shortLen * 0.45));
        roofZ = v.z1 + rise;
        const m1 = [(a1[0] + b0[0]) / 2, (a1[1] + b0[1]) / 2, v.z1 + rise];
        const m3 = [(b1[0] + a0[0]) / 2, (b1[1] + a0[1]) / 2, v.z1 + rise];
        const rMeta = [S_GABLE, rnd, varr, v.z1 + rise, fh];
        const slope = (p1: number[], p2: number[], p3: number[]) => {
          const ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
          const wx = p3[0] - p1[0], wy = p3[1] - p1[1], wz = p3[2] - p1[2];
          let n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
          const l = Math.hypot(n[0], n[1], n[2]) || 1;
          n = n.map((c) => c / l);
          if (n[2] < 0) n = n.map((c) => -c);
          return n;
        };
        const A0 = [a0[0], a0[1], v.z1], A1 = [a1[0], a1[1], v.z1];
        const B0 = [b0[0], b0[1], v.z1], B1 = [b1[0], b1[1], v.z1];
        let n1 = slope(A0, A1, m1);
        pushWallTri(R, A0, A1, m1, n1, [0, 0, 0], rMeta);
        pushWallTri(R, A0, m1, m3, n1, [0, 0, 0], rMeta);
        let n2 = slope(B0, B1, m3);
        pushWallTri(R, B0, B1, m3, n2, [0, 0, 0], rMeta);
        pushWallTri(R, B0, m3, m1, n2, [0, 0, 0], rMeta);
        // gable-end walls (plain — aTop below them keeps windows out)
        const gMeta = [style, rnd, varr, v.z1, fh];
        const gnorm = (p: number[], qq: number[]) => {
          const dx = qq[0] - p[0], dy = qq[1] - p[1];
          const l = Math.hypot(dx, dy) || 1;
          return [dy / l, -dx / l, 0];
        };
        pushWallTri(W, A1, B0, m1, gnorm(A1, B0), [0, 0, 0], gMeta);
        pushWallTri(W, B1, A0, m3, gnorm(B1, A0), [0, 0, 0], gMeta);
      } else if (mansard || hip) {
        // THE ROOFSCAPE OF THE OLD CITY. From the angle this game is played
        // at you look at roofs far more than facades, and every one of them
        // was the same flat grey plate. The four-sided gable path above only
        // ever reached detached quadrilaterals — a fraction of the fabric.
        //
        // A mansard is steep and shallow-inset, so the deck hides behind it;
        // that is the 1870s commercial block and the Second Empire townhouse.
        // A hip pulls in hard and reads as a cottage roof. Both are gated to
        // a minority of the pre-war stock on purpose: brownstones and
        // tenements really did have flat roofs, and a city where every
        // building is pitched is a village, not a downtown.
        // Decorrelate the slate colour from the roof-type gate. S_GABLE picks
        // its shingle out of vVar, and both gates below are vVar thresholds —
        // so every mansard in the city came out the same copper green and no
        // hip was ever brown. Re-hash it and the three slates spread evenly
        // across both.
        const slate = (varr * 3.71 + rnd * 1.93) % 1;
        const rMeta = [S_GABLE, rnd, slate, v.z1 + 4, fh];
        const span = Math.sqrt(Math.abs(area) / 2);
        const rise = mansard ? Math.min(4.2, Math.max(2.6, span * 0.30)) : Math.min(3.4, Math.max(1.9, span * 0.34));
        const inset = mansard ? Math.min(2.4, span * 0.16) : Math.max(1.6, span * 0.34);
        roofZ = v.z1 + rise;
        if (!pitchCap(ring, v.z1, rise, inset, rMeta)) capRoof(R, ring, v.z1, meta);
        else {
          if (mansard) {
            // the cornice a mansard sits on — the eave line is the whole point
            const lip = insetRing(ring, -0.32);
            if (lip) {
              const cMeta = [S_CORNICE, rnd, varr, v.z1 + 0.3, fh];
              extrudeWalls(W, lip, v.z1 - 0.6, v.z1 + 0.1, cMeta);
              capRoof(R, lip, v.z1 + 0.1, cMeta);
            }
          }
          // ---- DORMERS, which are the thing a mansard is FOR ----------------
          //
          // A mansard exists so the top storey is a room rather than a void,
          // and that room gets its light through the slope. Every mansard and
          // hip in this city was a bare plane of slate — which is not a roof
          // shape, it is a hat.
          //
          // They go on the slope, so the deck kit cannot place them: it fits
          // parts to a flat polygon and every candidate here is on a pitch.
          // Walked along the eave instead, one per window bay, set a third of
          // the way up the slope and turned to face out of it — which is where
          // the rooms behind them are.
          const topR = insetRing(ring, inset);
          const dorm = mansard ? 41 : 40;
          if (topR && topR.length === ring.length && rise > 2.2 && varr > 0.18) {
            const t = 0.34;                       // up the slope, out of the gutter
            const dz = v.z1 + rise * t;
            const dScale = Math.min(1.25, Math.max(0.72, rise / 3.4));
            for (let i = 0; i < ring.length; i++) {
              const a2 = ring[i], b2 = ring[(i + 1) % ring.length];
              const d2 = topR[i], c2 = topR[(i + 1) % topR.length];
              const ex = b2[0] - a2[0], ey = b2[1] - a2[1];
              const eL = Math.hypot(ex, ey);
              if (eL < 5.5) continue;             // no room for one on a return
              const nx = ey / eL, ny = -ex / eL;  // outward: rings are CCW here
              const n2 = Math.min(5, Math.floor(eL / 4.6));
              for (let k = 0; k < n2; k++) {
                const f = (k + 0.5) / n2;
                const px = a2[0] + ex * f, py = a2[1] + ey * f;
                const qx = d2[0] + (c2[0] - d2[0]) * f, qy = d2[1] + (c2[1] - d2[1]) * f;
                props.push({
                  kind: dorm, b: v.b,
                  x: px + (qx - px) * t, y: py + (qy - py) * t, z: dz,
                  s: dScale, rot: Math.atan2(ny, nx),
                });
              }
            }
          }
        }
      } else {
        capRoof(R, ring, v.z1, meta);
        // The crown, the green roof and the bulkhead — see crownTop. This was
        // 240 lines inline here, which is why the other path that makes
        // buildings had none of it.
        const cr = crownTop(mason, W, R, {
          ring: ring as [number, number][], z1: v.z1, roof: !!v.x, deco: !!v.d, bbl: v.b,
          style, rnd, varr, fh, area, industrial: v.c === "industrial",
          cs: (n) => hash01(key ^ Math.imul(n + 1, 0x9e3779b1), this.citySeed ^ 0x00c0ffee),
          pier: (n) => hash01(key ^ Math.imul(n, 2654435761), this.citySeed),
          props,
        });
        if (cr.mechDeck) mechDeck = cr.mechDeck;
        roofZ = cr.roofZ;
      }

      if (v.b) {
        wallRanges.push({ bbl: v.b, r: { start: wallStart, count: W.pos.length / 3 - wallStart } });
        roofRanges.push({ bbl: v.b, r: { start: roofStart, count: R.pos.length / 3 - roofStart } });
      }
      // paint the decoratives: the color is baked into the base tint so
      // ownership highlights (setTints) never wash it away
      if (v.dk && DECO_TINT[v.dk]) {
        decoTintRanges.push({ attr: 0, r: { start: dWall0, count: W.pos.length / 3 - dWall0 }, c: DECO_TINT[v.dk] });
        decoTintRanges.push({ attr: 1, r: { start: dRoof0, count: R.pos.length / 3 - dRoof0 }, c: DECO_TINT[v.dk] });
      }

      // ---- rooftop furniture ----------------------------------------------
      // Everything up here keys off how tall the BUILDING is, not how high its
      // roof happens to sit. A two-storey house on a hillside terrace is still
      // a two-storey house; giving it a broadcast mast because the ground under
      // it is 90 m up put an antenna forest on every hill.
      const hgt = v.z1 - v.z0;

      // ---- THE LANDMARKS ---------------------------------------------------
      //
      // A steeple, a dome, a cupola, a works chimney. These are not equipment
      // and they do not queue with it: they ARE the building's silhouette, and
      // they are how you know where you are from the far side of the water.
      //
      // They get their own pass because the machine deck below cannot reach
      // them. That block is gated `hgt >= 12 && !gable && !hip`, which is
      // exactly right for plant — you do not put a chiller on a cottage — and
      // exactly wrong for these, because the buildings a steeple and a cupola
      // belong on are SHORT and PITCHED. Measured: with the landmarks inside
      // that gate the whole city produced one cupola, two clocks, and no
      // steeple, no dome and no chimney at all.
      //
      // The thresholds are read off the stock rather than off Manhattan. New
      // Alden's median building is 14.2 m and it has seven buildings over 34 m
      // in the entire town, so "tall enough to end in a point" is 24 m here.
      // A helipad still wants 55 m and there are none, which is correct — the
      // town has not built one yet, and the player can.
      if (v.b && !v.d && !v.k && v.x) {
        const L = (k: number) => hash01(keyOf(v.b!) ^ Math.imul(k + 1, 0x7feb352d), this.citySeed ^ 0x1a2b3c4d);
        const plateM = Math.sqrt(Math.max(1, Math.abs(area) / 2));
        const oldStone = has(T_STONE, style);
        const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
        const bearOf = () => Math.atan2(mst.bearY, mst.bearX);
        const put = (kind: number, s: number, rot = 0) => {
          // Room to stand on: half the plate has to clear the object's own
          // footprint, or a dome ends up wider than the building under it.
          if (plateM * 0.5 < (PROP_R[kind] ?? 2) * s * 0.9) return;
          props.push({ kind, x: c[0], y: c[1], z: roofZ, s, rot, b: v.b });
        };
        // The works chimney: only where something was burning coal.
        if (style === S_MILL && v.y < 1950 && hgt >= 7 && plateM > 11 && L(1) < 0.20) put(22, 0.75 + 0.5 * L(2));
        // A steeple stands on a small, old, tall-for-its-plate building. A New
        // England port town has half a dozen and they are its landmarks.
        else if (v.y < 1920 && plateM < 24 && hgt >= 8 && hgt <= 28 &&
          (style === S_FEDERAL || style === S_ITALIANATE || style === S_CIVIC ||
            style === S_PREWAR || style === S_MARKET || style === S_GOTHIC) &&
          L(3) < 0.10) put(27, 0.75 + 0.45 * L(4), bearOf());
        // A dome wants a public building with a big room under it.
        else if (oldStone && v.y < 1940 && plateM > 19 && hgt >= 12 && L(5) < 0.14) put(25, 0.75 + 0.5 * L(6));
        // A clock stage on a tower narrow for its height — a campanile, which
        // the plan families now actually build.
        else if (oldStone && v.y < 1945 && hgt >= 18 && hgt > plateM * 1.35 && L(7) < 0.24) put(26, 0.7 + 0.45 * L(8), bearOf());
        // A deco or Gothic tower ends in a point, and from across the harbour
        // that point is the only part of it you can see.
        else if ((style === S_ARTDECO || style === S_GOTHIC) && hgt >= 24 && L(9) < 0.45) put(24, 0.8 + 0.6 * L(10));
        // A cupola is the cheap version of all of it: a market, a firehouse, a
        // school, anything that wanted to look civic in 1890.
        else if (v.y < 1930 && hgt >= 6 && hgt <= 22 &&
          (style === S_MARKET || style === S_CIVIC || style === S_CARRIAGE ||
            style === S_FEDERAL || style === S_CHICAGO) && L(11) < 0.24) put(23, 0.8 + 0.4 * L(12), bearOf());
        // The tank on its own steel tower — a different object from the tank
        // sitting on the deck, and visible from the street.
        else if (v.y < 1975 && hgt >= 12 && plateM > 15 && L(13) < 0.20) put(38, 0.75 + 0.4 * L(14), bearOf());
        // Sign letters on a frame: commercial, and high enough to be read.
        else if (hgt >= 11 && !has(T_MODERN, style) && has(T_TRADE, style) && L(15) < 0.16) put(37, 0.7 + 0.5 * L(16), bearOf());
      }

      if (v.b && hgt >= 12 && !gable && !hip) {
        const seed = Number(v.b) % 1000;
        const jit = (k: number, amp: number) => (((seed * (k + 3) * 2654435761) % 1000) / 1000 - 0.5) * amp;
        // Deck-mounted plant needs a deck. A mansard's roof is a slope with a
        // small terrace hidden behind it, so a cooling tower dropped at the
        // parapet line ends up buried inside the slate — its fire escape and
        // its chimneys are what it gets.
        if (!mansard) {
          // ---- THE MACHINE DECK ------------------------------------------
          //
          // Each of these is on the roof because the real one would be — a lift
          // overrun only where there is a lift, a cooling tower only where
          // there is a chiller, PV only after somebody was selling it — so the
          // parts on a deck tell you what KIND of building you are looking at
          // and roughly when it was last touched.
          //
          // The ORDER is the other half of it, and it is what stops a small
          // roof looking like a plant room that exploded. This list is written
          // most-necessary first: the way out, then the lift, then the plant
          // that makes the building work, then the things somebody chose to
          // add. fitRoofKit walks it in order and stops when the deck is full,
          // so a sixteen-metre plate gets a bulkhead and a vent, and the tower
          // next door still gets everything.
          // What goes on the deck, and in what order — see roofKitWants. Was
          // ninety lines inline here, which is why the other path that makes
          // buildings could ask for four of the twenty kinds.
          const wants = roofKitWants({
            style, year: v.y, hgt, fh, area, hasMechDeck: !!mechDeck, seed, jit,
            rnd: (k) => hash01(keyOf(v.b ?? "x") ^ Math.imul(k + 1, 0x9e3779b1), this.citySeed),
          });
          for (const p of fitRoofKit(mechDeck ? mechDeck.ring : (ring as [number, number][]),
            mechDeck ? mechDeck.z : v.z1, wants,
            (i) => hash01(keyOf(v.b ?? "x") ^ Math.imul(i + 7, 0x85ebca6b), this.citySeed), hgt)) {
            props.push(p);
          }
          // And a rail round the edge, which is nearly all EDGE and therefore
          // the one roof part that reads at a distance no box does.
          if (hgt >= 14) {
            const rl = Math.min(1.8, Math.max(0.55, Math.sqrt(Math.abs(area)) / 26));
            for (let e = 0; e < ring.length; e++) {
              const p0 = ring[e], p1 = ring[(e + 1) % ring.length];
              const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
              const L = Math.hypot(ex, ey);
              if (L < 9) continue;
              const nx = -ey / L, ny = ex / L;      // inward is whichever way the ring winds
              const sgn = area > 0 ? 1 : -1;
              const n = Math.min(4, Math.floor(L / 7.2));
              // A rail is 7 m of geometry at s = 1 and rl is set off the whole
              // building's size, so a big building with one short wall asked
              // for a twelve-metre rail on a nine-metre edge and hung three
              // metres of it past the corner into the air. It cannot be longer
              // than the share of the wall it was given.
              const rs = Math.min(rl, L / (n * 7.0));
              for (let i = 0; i < n; i++) {
                const t = (i + 0.5) / n;
                props.push({
                  kind: 20,
                  x: p0[0] + ex * t + nx * sgn * 1.5,
                  y: p0[1] + ey * t + ny * sgn * 1.5,
                  z: v.z1,
                  s: rs,
                  rot: Math.atan2(ey, ex),
                });
              }
            }
          }
        }
        // FIRE ESCAPES. The single most characteristic thing on a brick
        // walk-up street and the game had none. One stack per building, on
        // the longest wall — which is the street wall — projecting off the
        // facade so it catches the low sun and throws a real shadow down the
        // brick. A tenement block without them looks like a rendering of a
        // tenement block.
        if (style === S_BRICK && v.f >= 3 && hgt >= 9) {
          let bi = 0, bl = -1;
          for (let i = 0; i < ring.length; i++) {
            const a2 = ring[i], b2 = ring[(i + 1) % ring.length];
            const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
            if (L > bl) { bl = L; bi = i; }
          }
          if (bl > 9) {
            const a2 = ring[bi], b2 = ring[(bi + 1) % ring.length];
            const dx = b2[0] - a2[0], dy = b2[1] - a2[1];
            const L = Math.hypot(dx, dy) || 1;
            const ox = dy / L, oy = -dx / L;          // outward from a CCW ring
            const levels = Math.max(2, Math.min(5, v.f - 1));
            props.push({
              kind: 7 + levels,                        // 9..12
              x: (a2[0] + b2[0]) / 2 + ox * 0.55,
              y: (a2[1] + b2[1]) / 2 + oy * 0.55,
              z: v.z0,
              s: Math.min(1.25, fh / 3.4),
              rot: Math.atan2(dy, dx),
            });
          }
        }
        // ROOFTOP SIGNAGE. The painted sign on the parapet is what a
        // commercial building did with its roof before anyone thought to put
        // plant up there — and it sits on the LONGEST edge, facing the street,
        // because that is the whole point of it.
        if (!mansard && (v.c === "retail" || v.c === "office") && hgt >= 19 && hgt <= 52 && seed % 7 < 2) {
          let bi = 0, bl = -1;
          for (let i = 0; i < ring.length; i++) {
            const a2 = ring[i], b2 = ring[(i + 1) % ring.length];
            const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
            if (L > bl) { bl = L; bi = i; }
          }
          if (bl > 11) {
            const a2 = ring[bi], b2 = ring[(bi + 1) % ring.length];
            props.push({
              kind: 7,
              x: (a2[0] + b2[0]) / 2, y: (a2[1] + b2[1]) / 2, z: v.z1 + 0.6,
              s: Math.min(0.95, bl / 22),
              rot: Math.atan2(b2[1] - a2[1], b2[0] - a2[0]),
            });
          }
        }
      }
      // Chimneys on everything with a pitched roof. A stack is the one thing
      // that tells you a roof is a roof over rooms rather than a lid, and a
      // mansard block carries several — it is a building full of fireplaces.
      if (v.b && (gable || hip || mansard)) {
        let cx = 0, cy = 0;
        for (const [x, y] of ring) { cx += x; cy += y; }
        cx /= ring.length; cy /= ring.length;
        const seed = Number(v.b) % 1000;
        const jit = (k: number, amp: number) => (((seed * (k + 3) * 2654435761) % 1000) / 1000 - 0.5) * amp;
        const stacks = mansard ? 3 : gable ? 1 : 2;
        const zc = mansard ? v.z1 + 3.4 : hip ? v.z1 + 1.4 : v.z1 + 0.8;
        for (let k = 0; k < stacks; k++) {
          props.push({ kind: 5, x: cx + jit(1 + k * 2, 7), y: cy + jit(2 + k * 2, 6), z: zc, s: 1, rot: 0 });
        }
      }
      if (v.b) for (let i = propStart; i < props.length; i++) props[i].b = v.b;
    }

    const mkGeom = (T: typeof W) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(T.pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(T.norm, 3));
      g.setAttribute("aU", new THREE.Float32BufferAttribute(T.u, 1));
      g.setAttribute("aStyle", new THREE.Float32BufferAttribute(T.style, 1));
      g.setAttribute("aRand", new THREE.Float32BufferAttribute(T.rand, 1));
      g.setAttribute("aVar", new THREE.Float32BufferAttribute(T.varr, 1));
      g.setAttribute("aTop", new THREE.Float32BufferAttribute(T.top, 1));
      g.setAttribute("aFh", new THREE.Float32BufferAttribute(T.fh, 1));
      g.setAttribute("aEra", new THREE.Float32BufferAttribute(T.era, 1));
      g.setAttribute("aSeg", new THREE.Float32BufferAttribute(T.seg, 2));
      g.setAttribute("aCcv", new THREE.Float32BufferAttribute(T.ccv, 2));
      g.setAttribute("aLit", (() => {
        const a = new THREE.Float32BufferAttribute(new Float32Array(T.pos.length / 3).fill(-1), 1);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
      })());
      g.setAttribute("aRet", (() => {
        const a = new THREE.Float32BufferAttribute(new Float32Array(T.pos.length / 3).fill(-1), 1);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
      })());
      const tint = new Float32Array((T.pos.length / 3) * 3).fill(1);
      const tintAttr = new THREE.Float32BufferAttribute(tint, 3);
      tintAttr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute("aTint", tintAttr);
      return g;
    };

    const uniforms = () => ({
      uOpacity: { value: 1 },
      uCam: this.camUni,
      uSunDir: this.sunDirUni,
      uSunCol: this.sunColUni,
      uSeason: this.seasonUni,
      uWeather: this.weatherUni,
      uShadow: { value: null as THREE.Texture | null },
      uSunVP: { value: new THREE.Matrix4() },
      uShadowOn: { value: 0 },
      uShadowSpan: { value: 5999 },
      uTime: this.timeUni,
    });
    this.wallMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: uniforms(), side: THREE.DoubleSide });
    this.roofMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: ROOF_FRAG, uniforms: uniforms(), side: THREE.DoubleSide });

    const wallGeom = mkGeom(W);
    const roofGeom = mkGeom(R);
    this.scene.add(new THREE.Mesh(wallGeom, this.wallMat));
    this.scene.add(new THREE.Mesh(roofGeom, this.roofMat));
    this.tintAttrs = [wallGeom.getAttribute("aTint") as THREE.BufferAttribute, roofGeom.getAttribute("aTint") as THREE.BufferAttribute];
    this.litAttrs = [wallGeom.getAttribute("aLit") as THREE.BufferAttribute, roofGeom.getAttribute("aLit") as THREE.BufferAttribute];
    this.retAttrs = [wallGeom.getAttribute("aRet") as THREE.BufferAttribute, roofGeom.getAttribute("aRet") as THREE.BufferAttribute];
    this.baseTints = this.tintAttrs.map((a) => {
      const arr = new Float32Array(a.array.length);
      arr.fill(1);
      return arr;
    });
    for (const { attr, r, c } of decoTintRanges) {
      const arr = this.baseTints[attr];
      for (let i = r.start; i < r.start + r.count; i++) {
        arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2];
      }
    }
    for (let i = 0; i < this.tintAttrs.length; i++) {
      (this.tintAttrs[i].array as Float32Array).set(this.baseTints[i]);
      this.tintAttrs[i].needsUpdate = true;
    }
    this.posAttrs = [wallGeom.getAttribute("position") as THREE.BufferAttribute, roofGeom.getAttribute("position") as THREE.BufferAttribute];
    this.scene.add(this.dynGroup);
    for (const { bbl, r } of wallRanges) {
      if (!this.rangesByBBL.has(bbl)) this.rangesByBBL.set(bbl, []);
      this.rangesByBBL.get(bbl)!.push({ attr: 0, r });
    }
    for (const { bbl, r } of roofRanges) {
      if (!this.rangesByBBL.has(bbl)) this.rangesByBBL.set(bbl, []);
      this.rangesByBBL.get(bbl)!.push({ attr: 1, r });
    }

    const propDefs = propKit();
    // painted signs come in painted-sign colours
    const SIGN_COLORS: [number, number, number][] = [
      [0.72, 0.24, 0.20], [0.20, 0.32, 0.50], [0.92, 0.88, 0.80],
      [0.24, 0.40, 0.32], [0.82, 0.66, 0.28], [0.32, 0.30, 0.34],
    ];
    for (let kind = 0; kind < propDefs.length; kind++) {
      const items = props.filter((p) => p.kind === kind);
      if (!items.length) continue;
      // WHICH PARTS ARE GRAIN AT DISTANCE. Radius is the honest test: a part
      // whose whole footprint is a metre or two is sub-pixel at the
      // establishing zoom and contributes nothing but aliasing, while a water
      // tower or a steeple is the reason you are looking. The band is set off
      // the part's own size, so a 0.7 m flagpole goes first and a 3 m plant
      // housing hangs on much longer.
      const pr = PROP_R[kind] ?? 2;
      const small = pr <= 2.6 && kind !== 22 && kind !== 24 && kind !== 27;
      const fade: [number, number] = small
        ? [520 + pr * 260, 900 + pr * 420]
        : [0, 0];
      const mesh = new THREE.InstancedMesh(propDefs[kind].geom, this.propMaterial(propDefs[kind].color, true, 0, fade), items.length);
      // Shrunk-out geometry the shadow bake cannot see would otherwise leave a
      // full-size shadow behind it — see the note in PROP_VERT.
      if (small) mesh.userData.noShadow = true;
      // Which kit part this is, so a count of what actually reached the roofs
      // can be taken from the scene rather than inferred from the placement
      // rules. A part gated at a 9% roll on a rare style is exactly the kind
      // of thing that silently never appears.
      mesh.name = `prop:${kind}`;
      const icol = new Float32Array(items.length * 3).fill(1);
      if (kind === 7 || kind === 37) {
        for (let i = 0; i < items.length; i++) {
          const c = SIGN_COLORS[(Math.round(items[i].x * 7 + items[i].y * 13) % SIGN_COLORS.length + SIGN_COLORS.length) % SIGN_COLORS.length];
          icol[i * 3] = c[0]; icol[i * 3 + 1] = c[1]; icol[i * 3 + 2] = c[2];
        }
      }
      mesh.instanceColor = new THREE.InstancedBufferAttribute(icol, 3);
      const m = new THREE.Matrix4();
      items.forEach((p, i) => {
        m.compose(
          new THREE.Vector3(p.x, p.y, p.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, p.rot)),
          new THREE.Vector3(p.s, p.s, p.s),
        );
        mesh.setMatrixAt(i, m);
        // so a demolition can find this instance again
        if (p.b) {
          const list = this.propsByBBL.get(p.b);
          if (list) list.push({ mesh, i });
          else this.propsByBBL.set(p.b, [{ mesh, i }]);
        }
      });
      this.finishInstances(mesh);
      this.scene.add(mesh);
    }
    this.plantStreets();
    this.buildAoGround();
    this.buildWater();
    this.buildSeawall();
    this.buildLawns();

    this.bakeShadows();
  }

  // Street trees and lamp standards along the curb. Nothing sells the scale of
  // a building like something human-sized standing next to it, and an empty
  // pavement is what made the city read as a model rather than a place.
  private plantStreets() {
    const c = this.ctxPoints;
    if (!this.curbs.length && !c.trees?.length && !c.benches?.length && !c.rails?.length) return;
    // ctx: where this thing stands — 0 street, 1 park, 2 a lot nobody tends.
    // Only the trees read it, and only to choose a species.
    type Item = { x: number; y: number; s: number; rot: number; ctx?: number };
    type Walker = Item & { dx: number; dy: number; len: number; spd: number; ph: number; den: number };
    const trees: Item[] = [], lamps: Item[] = [], cars: Item[] = [], people: Item[] = [];
    const walkers: Walker[] = [], movers: Walker[] = [];
    let seed = 1337;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    // THE FOOT-TRAFFIC GRADIENT. Demand is the location — and the pavement is
    // where it should be legible first. Every building's demand score lands in
    // a coarse grid; a stretch of kerb asks the grid what kind of street it
    // is, and the answer decides how many people walk it. A prime block gets
    // a crowd, the fringe gets a dog-walker — so a dying block LOOKS like a
    // dying block from the first frame, before the player reads a single
    // number.
    const CELL = 60;
    const dGrid = new Map<string, { sum: number; n: number }>();
    for (const v of this.volumes) {
      if (!v.b || v.d) continue;
      const d = this.demandByBbl[v.b];
      if (d === undefined) continue;
      let vx = 0, vy = 0;
      for (const p of v.r) { const q = this.project(p); vx += q[0]; vy += q[1]; }
      vx /= v.r.length; vy /= v.r.length;
      const key = `${Math.round(vx / CELL)},${Math.round(vy / CELL)}`;
      const cell = dGrid.get(key) ?? { sum: 0, n: 0 };
      cell.sum += d; cell.n++;
      dGrid.set(key, cell);
    }
    const demandAt = (x: number, y: number): number => {
      const cx = Math.round(x / CELL), cy = Math.round(y / CELL);
      let sum = 0, n = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const c = dGrid.get(`${cx + i},${cy + j}`);
        if (c) { sum += c.sum; n += c.n; }
      }
      return n ? sum / n : 32;
    };

    for (const curb of this.curbs) {
      const ring = curb.map((p) => this.project(p));
      if (ring.length < 3) continue;
      let cx = 0, cy = 0;
      for (const [x, y] of ring) { cx += x; cy += y; }
      cx /= ring.length; cy /= ring.length;
      let carry = rnd() * 14;
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i], b = ring[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len < 2) continue;
        // step along the frontage, planting into the pavement side
        for (let d = carry; d < len; d += 17 + rnd() * 9) {
          const t = d / len;
          const px = a[0] + dx * t, py = a[1] + dy * t;
          let nx = -dy / len, ny = dx / len;
          if ((px - cx) * nx + (py - cy) * ny < 0) { nx = -nx; ny = -ny; }  // point outward
          const off = 2.1 + rnd() * 0.7;
          const item = { x: px + nx * off, y: py + ny * off, s: 0.92 + rnd() * 0.55, rot: rnd() * 6.28, ctx: 0 };
          if (rnd() < 0.76) trees.push(item);
          else lamps.push({ ...item, s: 0.9 + rnd() * 0.2 });
        }
        // PEOPLE. A city with cars but nobody in it reads as an evacuation.
        // These are two boxes and a dot each, but at street level they are the
        // difference between a model and a place — and they are the only thing
        // in the scene at human scale, which is what everything else gets
        // measured against.
        // ...and how MANY of them stand here is the demand gradient too. The
        // walkers already thin toward the fringe; if the standing figures
        // plant uniformly they drown the signal, and a dead industrial
        // waterfront reads as busy as the high street. A quarter of the crowd
        // on the worst corner, half again on the best.
        const edgeDn = Math.max(0.04, Math.min(1, demandAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) / 90));
        for (let d = rnd() * 5; d < len - 2; d += 3.1 + rnd() * 6.5) {
          if (rnd() > 0.42 * (0.25 + 1.35 * edgeDn)) continue;
          const t = d / len;
          const px = a[0] + dx * t, py = a[1] + dy * t;
          let nx = -dy / len, ny = dx / len;
          if ((px - cx) * nx + (py - cy) * ny < 0) { nx = -nx; ny = -ny; }
          const off = 0.9 + rnd() * 1.1;             // on the pavement, not the road
          people.push({ x: px + nx * off, y: py + ny * off, s: 0.92 + rnd() * 0.2, rot: rnd() * 6.28 });
        }
        // CARS AT THE KERB. Nothing gives a street its scale like the row of
        // parked cars along it — a building is abstract until there is
        // something four metres long standing next to it. They sit in the
        // parking lane, nose-to-tail, aligned with the frontage.
        for (let d = rnd() * 6; d < len - 5; d += 5.4 + rnd() * 3.4) {
          if (rnd() > 0.62) continue;              // gaps: hydrants, drives, luck
          const t = d / len;
          const px = a[0] + dx * t, py = a[1] + dy * t;
          let nx = -dy / len, ny = dx / len;
          if ((px - cx) * nx + (py - cy) * ny < 0) { nx = -nx; ny = -ny; }
          cars.push({
            x: px + nx * (4.4 + rnd() * 0.4),
            y: py + ny * (4.4 + rnd() * 0.4),
            s: 0.94 + rnd() * 0.16,
            rot: Math.atan2(dy, dx) + (rnd() - 0.5) * 0.06,
          });
        }

        // THE STREET THAT MOVES. Walking figures on the pavement and running
        // traffic in the lane, both patrolling this block face in the shader.
        // How many is the demand grid's answer: a prime frontage seeds a
        // figure every ~5 metres, the fringe every ~28 — and each carries a
        // breath threshold so the crowd swells and thins on the slow clock.
        if (len > 14) {
          const dn = edgeDn;
          const rot = Math.atan2(dy, dx);
          const ux = dx / len, uy = dy / len;
          let nx = -dy / len, ny = dx / len;
          if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
          const walkStep = 5 + (1 - dn) * 23;
          for (let d = rnd() * walkStep; d < len; d += walkStep * (0.7 + rnd() * 0.6)) {
            const off = 0.8 + rnd() * 1.3;
            const flip = rnd() < 0.5 ? 1 : -1;   // both directions on a pavement
            walkers.push({
              x: a[0] + ux * len * 0.5 + nx * off, y: a[1] + uy * len * 0.5 + ny * off,
              s: 0.9 + rnd() * 0.22, rot,
              dx: ux * flip, dy: uy * flip, len: Math.max(10, len - 3),
              spd: 0.8 + rnd() * 0.9, ph: rnd(),
              den: Math.pow(rnd(), 0.7),         // most figures are fair-weather
            });
          }
          // running traffic: one-way per block face (the facing kerb runs the
          // other way), thicker downtown, always sparser than the parked lane
          const laneStep = 26 + (1 - dn) * 60;
          for (let d = rnd() * laneStep; d < len; d += laneStep * (0.7 + rnd() * 0.7)) {
            movers.push({
              x: a[0] + ux * len * 0.5 + nx * (7.2 + rnd() * 0.5),
              y: a[1] + uy * len * 0.5 + ny * (7.2 + rnd() * 0.5),
              s: 0.94 + rnd() * 0.14, rot,
              dx: ux, dy: uy, len: Math.max(16, len - 2),
              spd: 4.5 + rnd() * 3.5, ph: rnd(),
              den: Math.pow(rnd(), 0.85),
            });
          }
        }
        carry = Math.max(0, carry - len);
        if (carry === 0) carry = rnd() * 6;
      }
    }

    // Cars carry a real per-instance colour rather than a jitter around one
    // hue: a kerb of identical grey boxes reads as packaging, not traffic.
    const CAR_COLORS: [number, number, number][] = [
      [0.88, 0.88, 0.87], [0.72, 0.73, 0.75], [0.22, 0.24, 0.28], [0.17, 0.27, 0.42],
      [0.55, 0.19, 0.17], [0.40, 0.42, 0.38], [0.78, 0.72, 0.58], [0.20, 0.34, 0.29],
      [0.62, 0.62, 0.64], [0.35, 0.20, 0.16],
    ];
    const addCars = (items: Item[]) => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(carGeom(), this.propMaterial(0xffffff), items.length);
      const m = new THREE.Matrix4();
      const cols = new Float32Array(items.length * 3);
      items.forEach((p, i) => {
        m.compose(
          new THREE.Vector3(p.x, p.y, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, p.rot)),
          new THREE.Vector3(p.s, p.s, p.s * (0.94 + rnd() * 0.16)),
        );
        mesh.setMatrixAt(i, m);
        const c = CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length) % CAR_COLORS.length];
        cols[i * 3] = c[0]; cols[i * 3 + 1] = c[1]; cols[i * 3 + 2] = c[2];
      });
      mesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
      this.finishInstances(mesh);
      this.scene.add(mesh);
    };

    // Clothes, in the muted range a crowd actually averages to.
    const COAT: [number, number, number][] = [
      [0.30, 0.32, 0.38], [0.62, 0.58, 0.52], [0.20, 0.24, 0.30], [0.52, 0.28, 0.24],
      [0.86, 0.84, 0.80], [0.28, 0.36, 0.32], [0.44, 0.40, 0.46], [0.70, 0.62, 0.44],
    ];
    const addPeople = (items: Item[]) => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(personGeom(), this.propMaterial(0xffffff), items.length);
      const m = new THREE.Matrix4();
      const cols = new Float32Array(items.length * 3);
      items.forEach((p, i) => {
        m.compose(
          new THREE.Vector3(p.x, p.y, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, p.rot)),
          new THREE.Vector3(p.s, p.s, p.s * (0.93 + rnd() * 0.14)),
        );
        mesh.setMatrixAt(i, m);
        const c = COAT[Math.floor(rnd() * COAT.length) % COAT.length];
        cols[i * 3] = c[0]; cols[i * 3 + 1] = c[1]; cols[i * 3 + 2] = c[2];
      });
      mesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
      this.finishInstances(mesh);
      this.scene.add(mesh);
    };

    // THE MOVING CROWD, and the running lane. Same instancing as the static
    // props, plus the aWalk attributes WALKER_VERT patrols on — the geometry
    // is CLONED per mesh because instanced attributes live on the geometry
    // and the walkers' must not leak onto the parked cars' shared copy.
    const addWalkers = (
      geom: THREE.BufferGeometry, items: Walker[], palette: [number, number, number][],
    ) => {
      if (!items.length) return;
      const g = geom.clone();
      const walk = new Float32Array(items.length * 4);
      const walk2 = new Float32Array(items.length * 2);
      const cols = new Float32Array(items.length * 3);
      // Unique material: walkers rewrite the vertex stage; a shared prop mat
      // must not be mutated out from under the parked cars.
      const mat = this.propMaterial(0xffffff, true, 0, [0, 0], true);
      mat.vertexShader = WALKER_VERT;
      mat.uniforms.uTime = this.timeUni;
      mat.uniforms.uActivity = this.activityUni;
      const mesh = new THREE.InstancedMesh(g, mat, items.length);
      const m = new THREE.Matrix4();
      let maxLen = 0;
      items.forEach((p, i) => {
        m.compose(
          new THREE.Vector3(p.x, p.y, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, p.rot)),
          new THREE.Vector3(p.s, p.s, p.s),
        );
        mesh.setMatrixAt(i, m);
        walk[i * 4] = p.dx; walk[i * 4 + 1] = p.dy; walk[i * 4 + 2] = p.len; walk[i * 4 + 3] = p.spd;
        walk2[i * 2] = p.ph; walk2[i * 2 + 1] = p.den;
        if (p.len > maxLen) maxLen = p.len;
        const c = palette[Math.floor(rnd() * palette.length) % palette.length];
        cols[i * 3] = c[0]; cols[i * 3 + 1] = c[1]; cols[i * 3 + 2] = c[2];
      });
      g.setAttribute("aWalk", new THREE.InstancedBufferAttribute(walk, 4));
      g.setAttribute("aWalk2", new THREE.InstancedBufferAttribute(walk2, 2));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
      // Patrol is ±len/2 from the parked instance origin.
      this.finishInstances(mesh, maxLen * 0.5 + 2);
      // A WALKER'S SHADOW CANNOT BE BAKED, so it must not be.
      //
      // These figures are moved entirely by WALKER_VERT — the patrol along
      // aWalk, the gait bob, and the `alive` cull that scales half of them to
      // zero. The shadow pass swaps in a MeshDepthMaterial, which replaces the
      // VERTEX shader too, so none of that motion exists as far as the bake is
      // concerned: every walker was being stamped into the map at the base
      // instance position it never actually stands at, including the ones
      // culled to nothing. The result is a field of little shadows lying in
      // the street with nobody on them, drifting further from their owners the
      // longer the month runs.
      //
      // Nothing at this scale needs a shadow map anyway: a pedestrian is under
      // two metres and the screen-space contact pass resolves exactly that
      // band, dynamically, from the real animated depth.
      mesh.userData.noShadow = true;
      this.scene.add(mesh);
      this.hasWalkers = true;
    };

    // context points that carry their own bearing, put into world space. The
    // generator works in metres and Mercator scales uniformly, so a bearing in
    // its frame is the same bearing here — degrees to radians and nothing else.
    const oriented = (pts?: Oriented[]): Item[] =>
      (pts ?? []).map((o) => {
        const [x, y] = this.project(o.p);
        return { x, y, s: 1, rot: (o.r * Math.PI) / 180 };
      });

    const addRigid = (geom: THREE.BufferGeometry, color: number, items: Item[]) => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(geom, this.propMaterial(color), items.length);
      const m = new THREE.Matrix4();
      const one = new THREE.Vector3(1, 1, 1);
      items.forEach((p, i) => {
        m.compose(
          new THREE.Vector3(p.x, p.y, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, p.rot)),
          one,
        );
        mesh.setMatrixAt(i, m);
      });
      // PROP_VERT reads instanceColor unconditionally, so every instanced prop
      // has to carry one even when it has nothing to say: a flat 1 leaves the
      // material's own colour alone.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(items.length * 3).fill(1), 3,
      );
      this.finishInstances(mesh);
      this.scene.add(mesh);
    };

    const add = (geom: THREE.BufferGeometry, color: number, items: Item[], vary = 0, foliage = 0) => {
      if (!items.length) return;
      const mesh = new THREE.InstancedMesh(geom, this.propMaterial(color, true, foliage), items.length);
      const m = new THREE.Matrix4();
      const cols = new Float32Array(items.length * 3);
      items.forEach((p, i) => {
        m.compose(
          new THREE.Vector3(p.x, p.y, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, p.rot)),
          new THREE.Vector3(p.s, p.s * (0.9 + rnd() * 0.3), p.s * (0.85 + rnd() * 0.4)),
        );
        mesh.setMatrixAt(i, m);
        // no two street trees are the same green
        const k = vary * (rnd() - 0.5);
        cols[i * 3] = 1 + k * 1.5;
        cols[i * 3 + 1] = 1 + k * 0.4;
        cols[i * 3 + 2] = 1 - k * 0.9;
      });
      mesh.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
      this.finishInstances(mesh);
      this.scene.add(mesh);
    };
    // the parks and the esplanade get REAL trees, not map dots: same instanced
    // canopies as the street planting, denser and a touch bigger. This is most
    // of what makes a park read as a place from the game camera.
    for (const p of this.ctxPoints.trees ?? []) {
      const [x, y] = this.project(p);
      trees.push({ x, y, s: 1.02 + rnd() * 0.75, rot: rnd() * 6.28, ctx: 1 });
    }
    // the scrub that has taken the abandoned lots, planted a size down from
    // street trees because nobody chose these and nobody prunes them
    for (const t of this.lotTrees) trees.push({ ...t, ctx: 2 });
    for (const c2 of this.lotCars) cars.push(c2);
    // pier piles: short dark timbers standing at the deck edge over the water
    const piles: Item[] = (this.ctxPoints.piles ?? []).map((p) => {
      const [x, y] = this.project(p);
      return { x, y, s: 0.9 + rnd() * 0.3, rot: 0 };
    });
    // THREE SPECIES, not one. Every tree in the city was the same two lumps
    // at a different size, which reads as wallpaper from the air. A spreading
    // shade tree, a narrow columnar one for tight frontages, and a conifer —
    // split deterministically so a street keeps its planting between reloads.
    // Weighted, not thirds. A third of the city in conifers turned a New
    // England common into a Christmas tree farm: streets and parks are mostly
    // spreading shade trees, with columnar ones where the frontage is tight
    // and a few evergreens for winter structure.
    // A STREET IS NOT A PARK IS NOT A VACANT LOT.
    //
    // The three species already vary, and every tree already gets its own
    // green out of `add`'s vary term — that part was never the problem. What
    // WAS the problem is that the split was a hash of position and nothing
    // else, so all three populations drew from one 63/25/12 mix: the same
    // planting on a tight commercial frontage, in the middle of the Common,
    // and on a lot nobody has touched in thirty years.
    //
    // Nobody plants a spreading shade tree on a twenty-foot frontage — it goes
    // columnar or it goes in a tub. A park is mostly canopy with a few
    // evergreens for winter structure. And scrub on an abandoned lot is
    // whatever seeded itself, which in New England is a lot of white pine.
    const MIX: Record<number, [number, number]> = {
      0: [46, 90],   // street: columnar over half of it, a few conifers
      1: [78, 92],   // park: canopy, some columnar, evergreen structure
      2: [40, 62],   // scrub: scrappy, and heavily self-seeded pine
    };
    const sp: Item[][] = [[], [], []];
    for (let i = 0; i < trees.length; i++) {
      const h = (Math.abs(Math.round(trees[i].x * 3 + trees[i].y * 7)) + i * 11) % 100;
      const [a, b] = MIX[trees[i].ctx ?? 1];
      sp[h < a ? 0 : h < b ? 1 : 2].push(trees[i]);
    }
    add(treeTrunkGeom(), 0x6b5744, trees, 0.12, 0);
    add(treeCanopyGeom(), 0x71904f, sp[0], 0.34, 1);
    add(columnarCanopyGeom(), 0x6d8a4c, sp[1], 0.30, 1);
    add(coniferCanopyGeom(), 0x4e6f4a, sp[2], 0.26, 2);
    add(lampGeom(), 0x4e5459, lamps, 0.06);
    add(pileGeom(), 0x5c4a34, piles, 0.08);
    // Manufactured things do not come in random proportions. Benches and
    // railings go in rigid — uniform scale, exact bearing — because a rail
    // whose posts are each a different height is a fence, not an esplanade.
    addRigid(benchGeom(), 0x6d5a45, oriented(this.ctxPoints.benches));
    addRigid(railGeom(), 0x3f464b, oriented(this.ctxPoints.rails));

    // ---- what the walks were converging on -------------------------------
    //
    // The park generator drives its cross paths corner-to-corner "through the
    // middle" and keeps the lawn open where they meet. That intersection had
    // nothing standing on it, which leaves four walks arriving at a patch of
    // grass — and leaves a hundred-metre lawn with no vertical anything to
    // read its scale against.
    //
    // A column in the big parks, a fountain in the small ones. Both on the
    // centroid, which is where the paths already go; the pond is generated
    // offset from centre precisely so the middle stays free, so nothing has to
    // be dodged. Bearing comes off the position hash so a town's monuments do
    // not all face the same way, and the whole thing is deterministic in the
    // city seed like every other prop.
    {
      const columns: Item[] = [];
      const fountains: Item[] = [];
      for (const ring of this.ctxPoints.parks ?? []) {
        if (!ring || ring.length < 3) continue;
        const pts = ring.map((q) => this.project(q));
        // area and centroid of the ring, by the shoelace
        let a2 = 0, cx = 0, cy = 0;
        for (let i = 0; i < pts.length; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
          const cross = x1 * y2 - x2 * y1;
          a2 += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
        }
        if (Math.abs(a2) < 1e-6) continue;
        const area = Math.abs(a2) / 2;
        const p: Item = {
          x: cx / (3 * a2), y: cy / (3 * a2),
          // addRigid ignores scale by design — a manufactured thing is one
          // size — but Item carries it, so hand it the identity.
          s: 1,
          rot: (Math.abs(Math.round(cx * 7 + cy * 13)) % 360) * Math.PI / 180,
        };
        // A column is a civic gesture and it needs a park to stand in; a
        // square that would be crowded by one gets a basin instead.
        if (area > 9000) columns.push(p);
        else if (area > 1800) fountains.push(p);
      }
      addRigid(monumentGeom(), 0xb9b2a4, columns);          // weathered granite
      addRigid(monumentFigureGeom(), 0x6f8a72, columns);    // bronze gone verdigris
      addRigid(parterreGeom(), 0x5f8039, columns);          // clipped box hedge
      addRigid(fountainStoneGeom(), 0xc0b9ab, fountains);
      addRigid(fountainWaterGeom(), 0x2f5a63, fountains);
    }
    addCars(cars);
    addPeople(people);
    addWalkers(personGeom(), walkers, COAT);
    addWalkers(carGeom(), movers, CAR_COLORS);
  }

  /**
   * The sea, as one mesh with the land punched out of it.
   *
   * MapLibre draws its fills and then this layer draws on top, so a water
   * plane laid over everything would bury the city. The land ring becomes a
   * HOLE in the water polygon instead — triangulated once, drawn under
   * everything else at z = 0.01. Added before the shadow bake would matter,
   * and excluded from casting, because a flat sheet casts nothing.
   */
  /**
   * THE SEAWALL.
   *
   * The city and the sea are the two biggest surfaces on screen and until now
   * the join between them was a paper cut — the land plate simply stopped and
   * the water started. A harbour town's edge is BUILT: coursed granite with a
   * coping, standing a metre or so proud of the promenade behind it.
   *
   * One extruded band around the land ring — a couple of hundred segments, so
   * it is free — and because it goes in before the sun bake it lays a thin
   * hard shadow onto the water, which is most of what sells it.
   */
  private buildSeawall() {
    const land = this.ctxPoints.land;
    if (!land || land.length < 4) return;
    const ring = land.map((p) => this.project(p));
    // which way is out to sea? The land ring's winding decides it, and getting
    // it backwards leaves the sunlit face of the wall shaded and the coping
    // hanging over the water instead of the walk.
    let signed = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      signed += p[0] * q[1] - q[0] * p[1];
    }
    const out = signed > 0 ? 1 : -1;
    const pos: number[] = [], norm: number[] = [];
    // LOW. A first attempt stood 1 m proud and dropped 1.6 m below the water,
    // and because the sun sits in the south-east most of the island's seaward
    // face is in shade — the whole coast ringed itself in a black band that
    // read as a city wall. What was wanted is a stone EDGE: a course you can
    // see, catching light where the shore turns toward the sun.
    const TOP = 0.62, BOT = -0.3;
    const push = (a: number[], b: number[], c: number[], n: number[]) => {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      for (let i = 0; i < 3; i++) norm.push(n[0], n[1], n[2]);
    };
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy);
      if (L < 0.4) continue;
      const n = [(dy / L) * out, (-dx / L) * out, 0];
      push([a[0], a[1], BOT], [b[0], b[1], BOT], [b[0], b[1], TOP], n);
      push([a[0], a[1], BOT], [b[0], b[1], TOP], [a[0], a[1], TOP], n);
      // the coping: a narrow flat course along the top, laid landward over the
      // walk, so the wall reads as stone somebody set rather than an outline
      const ox = -n[0] * 0.42, oy = -n[1] * 0.42;
      const up = [0, 0, 1];
      push([a[0], a[1], TOP], [b[0], b[1], TOP], [b[0] + ox, b[1] + oy, TOP], up);
      push([a[0], a[1], TOP], [b[0] + ox, b[1] + oy, TOP], [a[0] + ox, a[1] + oy, TOP], up);
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(norm, 3));
    const mesh = new THREE.Mesh(g, this.propMaterial(0xb0aa99, false));
    g.computeBoundingSphere();
    mesh.frustumCulled = true;
    this.scene.add(mesh);
  }

  /**
   * THE LAWNS.
   *
   * A park was a flat mint plate — the single largest uniform surface on land,
   * and the one place the eye rests longest. Real turf under a low sun is
   * never one value: it is mown in bands, worn to dirt on the desire lines,
   * greener where it is shaded and blonder where it bakes.
   *
   * The green-roof shader already knows how to make growth read as growth, so
   * the lawn borrows it — laid a few centimetres over the MapLibre fill so
   * the flat colour underneath only ever shows through the gaps.
   */
  private buildLawns() {
    const parks = this.ctxPoints.parks;
    if (!parks?.length) return;
    const T = { pos: [] as number[], norm: [] as number[], u: [] as number[], style: [] as number[] };
    // `uOf` lets a surface bake something useful into the spare per-vertex
    // float. The lawn and the walks have nothing to say and push the old
    // constant; the pond writes its distance to its own bank, which is what
    // lets the shader shallow the rim and hold the sky in the middle.
    let uOf: ((v: [number, number]) => number) | null = null;
    const emit = (q: [number, number][], z: number, style: number) => {
      for (const v of q) {
        T.pos.push(v[0], v[1], z); T.norm.push(0, 0, 1);
        T.u.push(uOf ? uOf(v) : 6); T.style.push(style);
      }
    };
    /** Shortest distance from a point to a closed ring, in metres. */
    const distToRing = (v: [number, number], ring: [number, number][]) => {
      let best = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy;
        let t = l2 ? ((v[0] - a[0]) * dx + (v[1] - a[1]) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(v[0] - (a[0] + t * dx), v[1] - (a[1] + t * dy)));
      }
      return best;
    };
    // subdivide: the shader varies with world position, so a park drawn as
    // four huge triangles still shades smoothly, but the mown bands want
    // enough vertices that nothing interpolates across a whole lawn
    const split = (q: [number, number][], z: number, style: number, depth: number) => {
      const a = Math.abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1])) / 2;
      if (a < 400 || depth > 5) { emit(q, z, style); return; }
      const m = (u: [number, number], v: [number, number]): [number, number] => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
      const m01 = m(q[0], q[1]), m12 = m(q[1], q[2]), m20 = m(q[2], q[0]);
      split([q[0], m01, m20], z, style, depth + 1); split([m01, q[1], m12], z, style, depth + 1);
      split([m20, m12, q[2]], z, style, depth + 1); split([m01, m12, m20], z, style, depth + 1);
    };
    const fillRing = (ll: [number, number][], z: number, style: number, sub: boolean) => {
      const ring = ll.map((q) => this.project(q));
      if (ring.length < 3) return;
      const pts = ring.map(([x, y]) => new THREE.Vector2(x, y));
      let tris: number[][] = [];
      try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch { return; }
      for (const t of tris) {
        const q = t.map((i) => ring[i]) as [number, number][];
        if (sub) split(q, z, style, 0); else emit(q, z, style);
      }
    };

    for (const p of parks) fillRing(p, 0.07, S_LAWN, true);

    // The lawn is a real surface now, so it BURIES whatever MapLibre was
    // drawing on the ground beneath it — which was the pond and every path
    // through the park. They come up with it. Laid in metres rather than
    // screen pixels, they also hold their width properly at any pitch, which
    // the line layers never did.
    // Subdivided, and not only for the shading. Triangulating a ring produces
    // triangles whose every corner is ON the ring — there are no interior
    // vertices at all — so a per-vertex distance to the bank would have been
    // zero everywhere and the pond would have been all rim. Splitting to the
    // same 400 m² the lawn uses gives it a middle to be deep in.
    for (const p of this.ctxPoints.ponds ?? []) {
      const ring = p.map((q) => this.project(q));
      uOf = (v) => distToRing(v, ring);
      fillRing(p, 0.09, S_POND, true);
      uOf = null;
      this.hasPonds = true;
    }
    for (const line of this.ctxPoints.paths ?? []) {
      const pts = line.map((q) => this.project(q));
      const HW = 1.35;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L = Math.hypot(dx, dy);
        if (L < 0.2) continue;
        // run each segment a half-width long at both ends so the corners of a
        // dog-leg close instead of showing a wedge of grass
        const ex = (dx / L) * HW, ey = (dy / L) * HW;
        const nx = (-dy / L) * HW, ny = (dx / L) * HW;
        const a0: [number, number] = [a[0] - ex + nx, a[1] - ey + ny];
        const a1: [number, number] = [a[0] - ex - nx, a[1] - ey - ny];
        const b0: [number, number] = [b[0] + ex + nx, b[1] + ey + ny];
        const b1: [number, number] = [b[0] + ex - nx, b[1] + ey - ny];
        emit([a0, a1, b1], 0.11, S_PATH);
        emit([a0, b1, b0], 0.11, S_PATH);
      }
    }

    if (!T.pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(T.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(T.norm, 3));
    g.setAttribute("aU", new THREE.Float32BufferAttribute(T.u, 1));
    g.setAttribute("aStyle", new THREE.Float32BufferAttribute(T.style, 1));
    const n = T.pos.length / 3;
    const fill = (v: number, k: number) => new THREE.Float32BufferAttribute(new Float32Array(n * k).fill(v), k);
    g.setAttribute("aRand", fill(0.5, 1));
    g.setAttribute("aVar", fill(0.5, 1));
    g.setAttribute("aTop", fill(1, 1));
    g.setAttribute("aFh", fill(3.5, 1));
    g.setAttribute("aEra", fill(0.55, 1));
    g.setAttribute("aTint", fill(1, 3));
    g.setAttribute("aSeg", fill(0, 2));
    g.setAttribute("aCcv", fill(0, 2));
    const mesh = new THREE.Mesh(g, this.roofMat!);
    mesh.frustumCulled = false;
    mesh.userData.noShadow = true;
    this.scene.add(mesh);
  }

  /**
   * A FLOOR THAT IS NEVER DRAWN.
   *
   * The streets of this city are painted by MapLibre, not by this layer, so
   * the depth buffer the occlusion pass reads has buildings in it and nothing
   * underneath them. Screen-space occlusion against that finds a tower's
   * neighbours and never finds the pavement it is standing on — which loses
   * precisely the contact the effect exists to draw.
   *
   * One plane at ground level with colour writes off costs nothing to draw,
   * changes not a single pixel, and gives every building in town a floor to be
   * occluded against. It has to be hidden during the sun's depth pass, where
   * it would be a lid over the whole city.
   */
  private buildAoGround() {
    const g = new THREE.PlaneGeometry(13000, 13000);
    // AND IT HAS TO SIT UNDER THE SEA, NOT IN IT. At z = 0 this plane is half a
    // centimetre below the water sheet, which is inside the depth buffer's
    // precision out at a kilometre — the two fought, the floor won in patches,
    // and the harbour came out in ruled terraces where the water had simply
    // been depth-tested away. Half a metre down settles it for good, and the
    // occlusion cannot tell the difference: it is sampling contact between
    // buildings and a ground plane, and the ground moved by half a metre.
    const m = new THREE.MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.z = -0.5;
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;         // before the water, which sits just above it
    mesh.userData.noShadow = true;
    this.scene.add(mesh);
    this.aoGround = mesh;
  }

  private buildWater() {
    const land = this.ctxPoints.land;
    if (!land || land.length < 4) return;
    const ring = land.map((p) => this.project(p));
    // wind the hole opposite to the outer boundary or the triangulator fills it
    let a2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a2 += p[0] * q[1] - q[0] * p[1];
    }
    const hole = (a2 > 0 ? ring.slice().reverse() : ring).map(([x, y]) => new THREE.Vector2(x, y));
    const R = 6000;
    const outer = [
      new THREE.Vector2(-R, -R), new THREE.Vector2(R, -R),
      new THREE.Vector2(R, R), new THREE.Vector2(-R, R),
    ];
    let tris: number[][] = [];
    try { tris = THREE.ShapeUtils.triangulateShape(outer, [hole]); } catch { return; }
    if (!tris.length) return;
    const pts = [...outer, ...hole];
    // distance from each vertex to the shoreline — the shallows gradient
    const depthOf = (v: THREE.Vector2) => {
      let best = Infinity;
      for (let i = 0; i < hole.length; i++) {
        const a = hole[i], b = hole[(i + 1) % hole.length];
        const dx = b.x - a.x, dy = b.y - a.y;
        const l2 = dx * dx + dy * dy;
        let t = l2 ? ((v.x - a.x) * dx + (v.y - a.y) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(v.x - (a.x + t * dx), v.y - (a.y + t * dy)));
      }
      return best;
    };
    const depths = pts.map(depthOf);
    const pos: number[] = [];
    const dep: number[] = [];
    for (const t of tris) for (const i of t) { pos.push(pts[i].x, pts[i].y, 0.01); dep.push(depths[i]); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aDepth", new THREE.Float32BufferAttribute(dep, 1));
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: {
        uTime: this.timeUni, uCam: this.camUni, uSunDir: this.sunDirUni, uSunCol: this.sunColUni,
        uReflect: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) },
        uReflectOn: { value: 0 }, uSeason: this.seasonUni, uWeather: this.weatherUni,
      },
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, this.waterMat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    // a flat sheet has no business in the shadow map
    mesh.userData.noShadow = true;
    this.scene.add(mesh);
    this.water = mesh;
  }

  // Props share the buildings' light rig so a water tower and the roof it
  // stands on are lit by the same sun.
  //
  // Materials are cached by look: dozens of street batches used to each own a
  // duplicate ShaderMaterial with identical uniforms, which meant a state
  // change per batch for no visual difference. Walkers pass `unique` because
  // they rewrite the vertex stage onto the material after creation.
  private propMaterial(
    color: number,
    instanced = true,
    foliage = 0,
    fade: [number, number] = [0, 0],
    unique = false,
  ): THREE.ShaderMaterial {
    const key = unique ? "" : `${color}|${instanced ? 1 : 0}|${foliage}|${fade[0]}|${fade[1]}`;
    if (key) {
      const hit = this.propMats.get(key);
      if (hit) return hit;
    }
    const c = new THREE.Color(color);
    const mat = new THREE.ShaderMaterial({
      vertexShader: instanced ? PROP_VERT : PROP_VERT_PLAIN,
      fragmentShader: PROP_FRAG,
      uniforms: {
        uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
        uOpacity: { value: 1 },
        uCam: this.camUni,
        uSunDir: this.sunDirUni,
        uSunCol: this.sunColUni,
        uSeason: this.seasonUni,
        uWeather: this.weatherUni,
        uFoliage: { value: foliage },
        uCamP: this.camUni,
        uFade: { value: new THREE.Vector2(fade[0], fade[1]) },
        uShadow: { value: this.shadowTex },
        uSunVP: { value: this.sunVP },
        uShadowOn: { value: this.shadowTex ? 1 : 0 },
        uShadowSpan: { value: this.shadowSpan },
      },
      side: THREE.DoubleSide,
    });
    if (key) this.propMats.set(key, mat);
    return mat;
  }

  /**
   * Instanced street dressing used to set frustumCulled = false because the
   * default sphere is the unit geometry at the origin — which culls the whole
   * batch the moment the camera leaves downtown-zero. Compute the real sphere
   * from the instance matrices and the GPU can skip batches behind the camera.
   * `pad` covers vertex-shader motion (walker patrol length).
   */
  private finishInstances(mesh: THREE.InstancedMesh, pad = 0) {
    mesh.computeBoundingSphere();
    if (pad > 0 && mesh.boundingSphere) mesh.boundingSphere.radius += pad;
    mesh.frustumCulled = true;
  }

  // One-time sun depth pass — the city is static, so shadows are free at
  // runtime: a single texture sample per fragment.
  private bakeShadows() {
    this.sunDirty = false;
    try {
      // must be the SAME direction the shader lights with, or the shadows
      // detach from the shading that produced them
      const sunDir = this.sunDirUni.value.clone().normalize();
      const look = new THREE.Vector3(0, 150, 0);
      // a low sun throws long shadows: the frustum has to be wide enough to
      // hold them, or buildings at the edge cast into nothing
      const cam = new THREE.OrthographicCamera(-2200, 2200, 1900, -1900, 1, 6000);
      cam.position.copy(look.clone().add(sunDir.clone().multiplyScalar(3000)));
      cam.up.set(0, 0, 1);
      cam.lookAt(look);
      cam.updateMatrixWorld(true);

      // FIT THE FRUSTUM TO THE CITY INSTEAD OF GUESSING AT IT.
      //
      // Those bounds are a hand-picked 4,400 x 3,800 m, which across a 3,072
      // map is 1.43 m per texel — and every one of these cities is smaller
      // than that box, so a good part of the shadow map has been photographing
      // open water. Fitting to the actual coastline is free resolution: the
      // same texels spread over less ground, and shadows sharpen everywhere at
      // no cost in memory or time.
      //
      // Fitted in the LIGHT's own space, which is the only place the answer is
      // exact — the sun is low and off to one side, so the ground footprint of
      // this frustum is a sheared parallelogram, not the axis-aligned box the
      // world coordinates suggest. Corners are taken at ground level and at
      // the height of the tallest thing the generator builds, because a tower
      // must be inside the box to cast at all.
      const land = this.ctxPoints.land;
      if (land && land.length > 2) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of land) {
          const [x, y] = this.project(p);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        const TALLEST = 320;                   // metres, comfortably over any volume
        const inv = cam.matrixWorldInverse;
        let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, n = Infinity, f = -Infinity;
        const v = new THREE.Vector3();
        for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [0, TALLEST]) {
          v.set(x, y, z).applyMatrix4(inv);
          l = Math.min(l, v.x); r = Math.max(r, v.x);
          b = Math.min(b, v.y); t = Math.max(t, v.y);
          n = Math.min(n, -v.z); f = Math.max(f, -v.z);
        }
        const pad = 40;                        // a little slack for roof furniture
        cam.left = l - pad; cam.right = r + pad;
        cam.bottom = b - pad; cam.top = t + pad;
        cam.near = Math.max(1, n - pad); cam.far = f + pad;
        cam.updateProjectionMatrix();
      }
      this.shadowSpan = cam.far - cam.near;

      if (!this.shadowTarget) {
        this.shadowTarget = new THREE.WebGLRenderTarget(3072, 3072, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
        });
      }
      if (!this.depthMat) {
        this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
      }
      const target = this.shadowTarget;
      // WHAT DOES NOT CAST.
      //
      // `userData.noShadow` was being set on three meshes and read by nothing
      // — a flag that looked like it worked, which is worse than no flag,
      // because the next person to set it on a new mesh gets silence. The
      // actual exclusions were three hardcoded references maintained by hand
      // beside it. This honours the flag instead, so the list lives on the
      // meshes that know why they are on it:
      //   the sea            — a flat sheet casts nothing
      //   the occlusion floor — left in, it is a lid over the whole city and
      //                         every building in town stands in its shadow
      //   the pavement sheet  — flat, and only ever self-shadows into acne
      //   the walkers         — their motion is invisible to the depth pass
      const hidden: THREE.Object3D[] = [];
      this.scene.traverse((o) => {
        if (o.userData && o.userData.noShadow && o.visible) { o.visible = false; hidden.push(o); }
      });
      if (this.groundCatcher) { this.groundCatcher.visible = false; hidden.push(this.groundCatcher); }
      const prevClear = new THREE.Color();
      this.renderer.getClearColor(prevClear);
      const prevAlpha = this.renderer.getClearAlpha();
      this.scene.overrideMaterial = this.depthMat;
      this.renderer.setRenderTarget(target);
      this.renderer.setClearColor(0xffffff, 1);
      this.renderer.clear();
      this.renderer.render(this.scene, cam);
      this.renderer.setRenderTarget(null);
      this.renderer.setClearColor(prevClear, prevAlpha);
      this.scene.overrideMaterial = null;
      for (const o of hidden) o.visible = true;

      this.sunVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      this.shadowTex = target.texture;
      const sunVP = this.sunVP;
      // anything already instanced (roof furniture, trees) picks up the map
      this.scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (mat && mat.uniforms && mat.uniforms.uShadow && !mat.uniforms.uShadow.value) {
          mat.uniforms.uShadow.value = target.texture;
          mat.uniforms.uSunVP.value = sunVP;
          mat.uniforms.uShadowOn.value = 1;
        }
        if (mat && mat.uniforms && mat.uniforms.uShadowSpan) mat.uniforms.uShadowSpan.value = this.shadowSpan;
      });
      for (const mat of [this.wallMat, this.roofMat]) {
        mat.uniforms.uShadow.value = target.texture;
        mat.uniforms.uSunVP.value = sunVP;
        mat.uniforms.uShadowOn.value = 1;
      }
      // ground shadow catcher — added AFTER the depth pass so it never self-shadows
      if (!this.groundCatcher) {
        const catcherMat = new THREE.ShaderMaterial({
          vertexShader: CATCHER_VERT,
          fragmentShader: CATCHER_FRAG,
          uniforms: {
            uShadow: { value: target.texture }, uSunVP: { value: sunVP },
            uShadowOn: { value: 1 }, uShadowSpan: { value: this.shadowSpan },
            uSeason: this.seasonUni, uWeather: this.weatherUni,
          },
          transparent: true,
          depthWrite: false,
        });
        this.groundCatcher = new THREE.Mesh(new THREE.PlaneGeometry(3800, 3200).translate(0, 150, 0.07), catcherMat);
        this.scene.add(this.groundCatcher);

        // and the sun's own contribution to that same ground, added on top
        const sheenMat = new THREE.ShaderMaterial({
          vertexShader: CATCHER_VERT,
          fragmentShader: GROUND_SHEEN_FRAG,
          uniforms: {
            uShadow: { value: target.texture }, uSunVP: { value: sunVP },
            uShadowOn: { value: 1 }, uShadowSpan: { value: this.shadowSpan },
            uSeason: this.seasonUni, uCam: this.camUni,
            uSunDir: this.sunDirUni, uSunCol: this.sunColUni, uWeather: this.weatherUni,
          },
          transparent: true,
          depthWrite: false,
          // ADD LIGHT, TOUCH NOTHING ELSE — and THREE.AdditiveBlending will not
          // do it. Additive blends the ALPHA channel by the same factors as the
          // colour, so this quad was writing a=1 across the entire city while
          // carrying rgb near zero. The scene buffer is premultiplied, so the
          // composite read that as "opaque, and black" and dutifully replaced
          // every street MapLibre had drawn underneath. The streets went to
          // pitch from a pass that is arithmetically incapable of darkening
          // anything.
          //
          // Colour adds; alpha is left exactly as the geometry left it. In a
          // premultiplied buffer, rgb > 0 with a = 0 is precisely the encoding
          // for "light that arrived here without a surface", which is what a
          // specular highlight on somebody else's pavement is.
          blending: THREE.CustomBlending,
          blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
          blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        });
        // UNDER THE SEA, NOT OVER IT. This quad is a rectangle and the city is
        // an island, so at 0.08 it was laying a specular sheet across the whole
        // harbour — the sun's road on the water, painted twice, once by water
        // that had earned it and once by a slab of asphalt lighting that was
        // not there. Dropped below the water sheet at 0.01, the sea occludes it
        // by depth exactly where there is no ground, and the hole punched in
        // the water for the island is precisely where it should show through.
        this.groundSheen = new THREE.Mesh(
          new THREE.PlaneGeometry(3800, 3200).translate(0, 150, 0.005), sheenMat,
        );
        // a flat sheet lying on the ground: nothing to cast, nothing to mirror
        this.groundSheen.userData.noShadow = true;
        this.scene.add(this.groundSheen);
      }
    } catch {
      // shadows are enhancement, never a blocker — flat lighting still ships
    }
  }

  // Player construction and deliveries: a small dynamic mesh set rebuilt on
  // change (a handful of buildings — cheap), sharing the facade materials.
  /**
   * `styleOverride` exists for the style board — a development view that puts
   * every facade family on the map at once at identical height and plate. The
   * distribution audit can prove a family is CHOSEN; only looking at it can
   * prove it is distinguishable from the family beside it, which is a different
   * question and one no counter can answer.
   */
  setPlayerBuildings(items: { bbl: string; cls: string; heightM: number; floors: number; construction: boolean; fresh?: boolean; styleOverride?: number; cov?: number; year?: number }[]) {
    this.dynGroup.clear();
    this.cranes.length = 0;
    for (const item of items) {
      // FLATTEN FIRST, ALWAYS — and BEFORE the ring lookup, which is the whole
      // bug. Whatever the generator put on this lot comes off the moment the
      // game says something else is there, including when what is there is
      // nothing. This line used to sit below a `continue` that fired for every
      // building the player had BOUGHT rather than built, so demolishing a
      // purchased building flattened precisely nothing.
      if (!this.flattened.has(item.bbl)) this.flattenLot(item.bbl);
      const ring = this.lotRing(item.bbl);
      if (!ring) continue;
      // A DEMOLISHED LOT IS A LOT. `Math.max(3, heightM)` below meant a cleared
      // site drew a three-metre glass box where the building had been, so
      // knocking something down appeared to do nothing at all. Nought height
      // means nought: the original mesh is already flattened by the line above,
      // and now nothing replaces it.
      if (!(item.heightM > 0) || item.cls === "land") continue;
      let cx = 0, cy = 0;
      for (const [x, y] of ring) { cx += x; cy += y; }
      cx /= ring.length; cy /= ring.length;
      const h = Math.max(3, item.heightM);
      // EVERY TOWER THE GAME BUILT WAS THE SAME TOWER. Style by class, and then
      // rand 0.5, varr 0.4 — two constants — so every developed office in the
      // city was byte-identical: same glass, same palette, one flat prism, no
      // crown. Twenty years in, downtown was one white slab photocopied.
      //
      // A building's identity is now hashed off its deed, exactly like the
      // generator's stock: WHICH facade family it wears, WHERE in that
      // family's palette it sits, and WHAT SHAPE it is.
      const k = keyOf(item.bbl);
      const rnd = hash01(k, this.citySeed);
      const varr = hash01(k ^ 0x5bf03635, Math.imul(this.citySeed, 3) + 1);
      // AND THE FACADE COMES OUT OF THE REGISTRY, NOT OUT OF A LADDER HERE.
      //
      // This used to be six hard-coded ids — glass, brick, mill sash, dark
      // glass, deco piers, ribbon — chosen by class off two hash rolls. It had
      // the shape problem above in a second dimension: 144 facade families
      // exist and the half of the city the player is responsible for could
      // reach six of them, three of which were wrong for a building finished
      // this month rather than in 1955. New retail was drawn as mid-century
      // ribbon glazing, new industrial as a nineteenth-century mill, and one
      // new office in seven as a 1920s stone tower.
      //
      // `styleForBuilt` is `styleFor` — the chooser the generated stock uses —
      // less the four families nobody develops as an investment. Same class,
      // same year, same floors, same deed hash, so a tower the player finishes
      // in 2014 gets drawn by the rules that would have drawn it if the town
      // had started with it, and the two populations stop being tellable apart.
      const yearBuilt = item.year && item.year > 1800 ? item.year : 2000;
      const style = item.styleOverride !== undefined ? item.styleOverride
        : item.construction ? S_PLAIN
        : styleForBuilt({
          b: item.bbl, c: item.cls, y: yearBuilt, t: 0,
          f: Math.max(1, item.floors), z0: 0, z1: h, d: 0, r: [],
        });
      const fh2 = item.floors > 0 ? Math.max(2.6, item.heightM / item.floors) : 3.5;
      const meta = [style, rnd, varr, h, fh2];
      // THE SHAPE. One flat prism is one of five silhouettes now, picked by
      // hash and gated by height the way the real decisions are: podium and
      // tower is a zoning trade, the setback is a light-plane trade, and the
      // slender point only exists where the floors justify the core.
      const mroll = hash01(k ^ 0x77aa11, this.citySeed ^ 0x1234);
      const inset = (f: number) => ring.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f] as [number, number]);
      // THE BASE PLATE IS THE BUILDING'S OWN COVERAGE, NOT A CONSTANT.
      //
      // This was a flat 0.78 for every building the player or the city put up,
      // which meant the drawn footprint never changed and site coverage reached
      // the picture ONLY through the floor count — backwards, because covering
      // more of the lot buys FEWER floors for the same square footage. Owner's
      // report: "I have built some office buildings which are 2x the next
      // largest by square footage and visually they look like they are not
      // nearly the biggest." They were right. On a 10,000 sf lot at FAR 4,
      // every one of these is the same 40,000 sf building:
      //
      //     coverage 0.40   10 floors   drawn volume 60,840
      //     coverage 0.70    6 floors   drawn volume 36,504
      //     coverage 0.90    5 floors   drawn volume 30,420
      //
      // A 2:1 spread in apparent size across buildings of identical area, and
      // the wide ones — which is what a big floorplate office IS — lost.
      //
      // Coverage is an AREA ratio and the inset is a LINEAR one, so it enters
      // as a square root: inset f gives a plate of f^2 of the lot. The old 0.78
      // was implicitly claiming 61% coverage for everything. Buildings from
      // before this field existed fall back to that same 0.78 so nothing in an
      // old save moves.
      const B = item.cov && item.cov > 0 ? Math.min(0.97, Math.sqrt(item.cov)) : 0.78;
      let tiers: TowerTier[] = [];
      const fl = Math.max(1, item.floors);
      // ---- OVER TWENTY STOREYS IS ITS OWN PROBLEM --------------------------
      //
      // Below this the five silhouettes underneath are right: a podium, a
      // setback, a shaft — those are the trades a mid-rise actually makes.
      // Above it they are not, because every one of them is the plate scaled
      // toward its own centre, which is a 1961 move, and a tower finished last
      // year does not look like that. towerMassing rotates the plate, offsets
      // it, cuts its corners off and lets the top oversail — and it brings its
      // own skin, because these shapes and those walls were designed together.
      //
      // It can refuse: a spiral needs height to turn through and a blade needs
      // a plate long enough to be slender ON. When it does, the stack below
      // catches it.
      let towerStyle = -1;
      if (!item.construction && fl >= 20 && h >= 62) {
        const tf = TOWER_FAMILIES[Math.floor(hash01(k ^ 0x70e2, this.citySeed ^ 0xa11) * TOWER_FAMILIES.length) % TOWER_FAMILIES.length];
        // THE DIAL REACHES THE TOWER — BY SIMILARITY, NOT BY ARGUMENT.
        //
        // towerMassing builds every tier from `ring x 0.78`, and each of its
        // recipes offsets by a fraction of `span`, which it measures on the
        // ring it is given. Passing the coverage in as a parameter was tried
        // and reverted: it changes the plate without changing the offsets, so
        // the silhouettes detach from the plate they move and tiers walk off
        // the deed — measured, `stack` and `twist` put half their tier-0
        // vertices outside the parcel at the upper end of the dial.
        //
        // Handing it a ring pre-scaled by B/0.78 changes NOTHING inside: it is
        // one similarity transform of the whole recipe, so `base` lands exactly
        // on the promised plate, span scales with it, and every offset stays in
        // the same proportion to the plate it was calibrated against. The
        // silhouettes are identical shapes at a different size, which is what
        // the coverage dial is supposed to mean.
        const tRing = plScale(ring as [number, number][], cx, cy, B / 0.78);
        const built = towerMassing(tf, tRing, cx, cy, h, fl, fh2,
          (n) => hash01(k ^ Math.imul(n + 1, 0x9e3779b1), this.citySeed ^ 0x7057));
        if (built && built.tiers.length >= 2) {
          // ...and none of it leaves the deed. The recipes jog and rotate off
          // the base plate and none of them knows where the lot ends; at the
          // top of the coverage dial they walk off it. See plClipToLot.
          for (const t of built.tiers) t.fp = plClipToLot(t.fp, ring as [number, number][], cx, cy);
          tiers = built.tiers;
          towerStyle = built.style;
        }
      }
      if (towerStyle >= 0) { meta[0] = towerStyle; }
      else if (item.construction || fl < 7 || h < 22) {
        tiers = [{ fp: inset(B), z0: 0, z1: h }];
      } else {
        // ---- THE MID-RISE, WHICH WAS FIVE WAYS OF DOING ONE THING ---------
        //
        // Below the tower gate there were five silhouettes and EVERY ONE OF
        // THEM WAS THE PLATE SCALED TOWARD ITS OWN CENTROID — a podium, a
        // setback, a three-stage wedding cake, a tower on a podium, a prism.
        // That is the 1916-to-1961 envelope, and it is the wrong shape twice
        // over for a building finished after 2000. It puts the top of every
        // building directly over the middle of its bottom, so a street of them
        // is a row of pyramids; and it steps back on ALL FOUR SIDES, including
        // the two that are party walls a neighbour is standing against.
        //
        // What a real one does instead: the street wall goes straight up to
        // the lot line and the shaft goes to the BACK of the plate, so the
        // block keeps a continuous frontage and the light plane is met on the
        // side that has light to protect. That is one `plMove`, and no amount
        // of centroid scaling can produce it.
        //
        // Three shapes are new and none of them is a centroid scale: the
        // shifted shaft, the slab (narrowed on ONE axis, which is what an
        // apartment building is), and the chamfered shaft. The wedding cake
        // survives because terraced setbacks did come back — but as the rare
        // answer it now is rather than a third of everything.
        const P = tiers as TowerTier[];
        const plate = inset(B) as Plate;
        // The plate's own frame: `ax` is its long axis, which on an ordinary
        // urban parcel is the deep direction — street to rear. Half-extents
        // along and across it, measured rather than approximated off the area,
        // because a deep narrow lot and a square one of the same area give
        // very different answers about how far anything can travel.
        const ax = plAxis(plate);
        const ca = Math.cos(ax), sa = Math.sin(ax);
        let deep = 0, wide = 0;
        for (const [px, py] of plate) {
          const dx = px - cx, dy = py - cy;
          deep = Math.max(deep, Math.abs(dx * ca + dy * sa));
          wide = Math.max(wide, Math.abs(-dx * sa + dy * ca));
        }
        // WHICH END IS THE STREET IS NOT KNOWABLE HERE. The layer has the lot
        // ring and not the street graph, so the direction is hashed off the
        // deed. That is a real limitation and it is worth fixing when the
        // frontage is available — a block reads best when every shaft steps
        // back from the SAME side. What survives either way, and is the whole
        // point, is that the shaft is not over the middle of its own base.
        const dirS = hash01(k ^ 0x5b1f, this.citySeed) < 0.5 ? 1 : -1;
        const back = (fp: Plate, d: number): Plate => plMove(fp, ca * d * dirS, sa * d * dirS);
        const podTop = Math.min(h * 0.28, fh2 * 3.2);
        const resi = item.cls === "multifamily";
        if (mroll < 0.26) {
          // PODIUM AND SHAFT, SHAFT TO THE BACK. The zoning trade, done the
          // way it is actually done.
          const sc = 0.58 + 0.14 * hash01(k ^ 0x51, this.citySeed);
          const off = deep * (1 - sc) * (0.5 + 0.4 * hash01(k ^ 0x53, this.citySeed));
          P.push({ fp: inset(B), z0: 0, z1: podTop });
          P.push({ fp: plClipToLot(back(inset(B * sc) as Plate, off), ring as Plate, cx, cy), z0: podTop, z1: h });
        } else if (mroll < 0.46) {
          // A SLAB. Narrowed on ONE axis only, which is what nearly every
          // mid-rise apartment building on earth is, and which a centroid
          // scale cannot make — it shrinks both dimensions together and gives
          // you a smaller box instead of a thinner one.
          const cut = h * (0.30 + 0.16 * hash01(k ^ 0x52, this.citySeed));
          const thin = resi ? 0.46 + 0.12 * hash01(k ^ 0x54, this.citySeed) : 0.58 + 0.14 * hash01(k ^ 0x54, this.citySeed);
          const slab = plScaleAxis(inset(B) as Plate, cx, cy, ax, 0.97, thin);
          P.push({ fp: inset(B), z0: 0, z1: cut });
          P.push({ fp: plClipToLot(back(slab, deep * 0.16), ring as Plate, cx, cy), z0: cut, z1: h });
        } else if (mroll < 0.62) {
          // A CHAMFERED SHAFT. Corners off the tower and not off the base —
          // the base wants the floor area and the corner is where the tower
          // reads. Cheap, and it stops the thing being a rectangle from every
          // angle at once.
          const cut2 = h * (0.22 + 0.14 * hash01(k ^ 0x55, this.citySeed));
          const ch2 = Math.min(deep, wide) * (0.20 + 0.20 * hash01(k ^ 0x56, this.citySeed));
          P.push({ fp: inset(B), z0: 0, z1: cut2 });
          P.push({ fp: plChamfer(inset(B * 0.92) as Plate, ch2), z0: cut2, z1: h });
        } else if (mroll < 0.74) {
          // A SINGLE SETBACK, high up. The light-plane trade, and the one
          // centroid move that is still right — a top-floor step-in is
          // symmetric because it is above everything it could shade.
          const cut3 = h * (0.66 + 0.14 * hash01(k ^ 0x57, this.citySeed));
          P.push({ fp: inset(B), z0: 0, z1: cut3 });
          P.push({ fp: inset(B * 0.76), z0: cut3, z1: h });
        } else if (mroll < 0.80 && fl >= 14) {
          // TOWER ON A THIN PODIUM, shaft to the back.
          const pod = fh2 * 2.2;
          P.push({ fp: inset(B), z0: 0, z1: pod });
          P.push({ fp: plClipToLot(back(inset(B * 0.52) as Plate, deep * 0.40), ring as Plate, cx, cy), z0: pod, z1: h });
        } else if (mroll < 0.85 && fl >= 12) {
          // THE WEDDING CAKE. Kept, because terraced setbacks came back — Via
          // 57, the Hudson Yards residential — but it is a form for a tall
          // building on a big plate, not the answer to a third of everything.
          const c1 = h * 0.45, c2 = h * 0.75;
          P.push({ fp: inset(B), z0: 0, z1: c1 });
          P.push({ fp: inset(B * 0.80), z0: c1, z1: c2 });
          P.push({ fp: inset(B * 0.62), z0: c2, z1: h });
        } else {
          // A PLAIN SHAFT. The commonest building in any city and not a
          // failure to choose — most mid-rise is a box on its lot line.
          P.push({ fp: inset(B), z0: 0, z1: h });
        }
      }
      const mkBuf = () => ({
        pos: [] as number[], norm: [] as number[], u: [] as number[], style: [] as number[],
        rand: [] as number[], varr: [] as number[], top: [] as number[], fh: [] as number[],
        seg: [] as number[], ccv: [] as number[], era: [] as number[],
      });
      // ERA IS THE YEAR IT WAS FINISHED, on the same 0 = 1870, 1 = 2030 scale
      // the generated stock carries. This was `0.76 + 0.16 * hash` — a band
      // running 1992 to 2017 that every player building sat somewhere in
      // regardless of when it was actually delivered, so a tower topped out in
      // year 40 of a century campaign was drawn with the soiling of a building
      // twenty-five years older than the one beside it that the city had put
      // up on schedule. Era drives patina and the palette key, so a made-up
      // one is a made-up amount of weathering.
      const nowEra = Math.max(0, Math.min(1, (yearBuilt - 1870) / 160));
      const T = mkBuf();
      const R2 = mkBuf();
      let hb = 2166136261;
      for (let i = 0; i < item.bbl.length; i++) { hb ^= item.bbl.charCodeAt(i); hb = Math.imul(hb, 16777619); }
      hb = hb >>> 0;
      // ...and the roof surface off the same ladder as the stock. This was
      // `[7, 7, 6, 6, 8, 5][hb % 6]` — a fixed six off the deed hash, blind to
      // the year, so the roof the player laid in the campaign's ninetieth year
      // came out of the same handful as the one they laid in its first, and a
      // conversion of a mill could not keep its tar and gravel.
      const deck2 = item.construction ? 0
        : roofDeck(style, yearBuilt, item.floors, h, hash01(hb ^ 0x2f7d3a11, this.citySeed ^ 0x5eed100f));
      const wear2 = ((hb >>> 8) % 1024) / 1024;
      // seam bearing comes off the base plate's longest wall, whichever tier
      const fp0 = tiers[0].fp;
      let bi2 = 0, bl2 = -1;
      for (let i = 0; i < fp0.length; i++) {
        const q0 = fp0[i], q1 = fp0[(i + 1) % fp0.length];
        const L2 = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
        if (L2 > bl2) { bl2 = L2; bi2 = i; }
      }
      const bx2 = bl2 > 0 ? (fp0[(bi2 + 1) % fp0.length][0] - fp0[bi2][0]) / bl2 : 1;
      const by2 = bl2 > 0 ? (fp0[(bi2 + 1) % fp0.length][1] - fp0[bi2][1]) / bl2 : 0;
      // THE SAME TROWEL THE CITY WAS BUILT WITH. The walls and decks here were
      // a private copy of `extrudeWalls` and a private copy of `capRoof`, and
      // both had drifted: the walls declared every corner convex, so an L-plan
      // tower got no shadow in its inside corner, and the deck wrote a constant
      // 4 m edge distance, which is the term the roof shader uses to sink a
      // deck into shade under its own parapet — so no player roof had any.
      const mst2: MasonState = { era: nowEra, deck: deck2, wear: wear2, bearX: bx2, bearY: by2 };
      const mason2 = makeMason(mst2);
      for (const tier of tiers) {
        const wm = [tier.style ?? meta[0], meta[1], meta[2], tier.z1, meta[4]];
        mason2.wall(T, tier.fp as [number, number][], tier.z0, tier.z1, wm);
        const rs = item.construction ? S_PLAIN : (tier.roof ?? tier.style ?? meta[0]);
        mason2.cap(R2, tier.fp as [number, number][], tier.z1, [rs, rnd, varr, tier.z1, fh2]);
      }
      // ---- AND IT ENDS IN SOMETHING ----------------------------------------
      //
      // Every building the player or a rival put up stopped at a bare plane
      // with a small grey box on it — one ending, for the whole half of the
      // city they are responsible for, while the town's own stock had twelve.
      // Crowns are 29% of a tower's pixels and the part of it that meets the
      // sky, so this was the single largest thing separating the two
      // populations by eye. Same ladder, same inputs, same hash streams.
      //
      // Only the top tier gets one. A lower tier of a setback building is a
      // terrace with more building standing on it, and a cornice there would
      // be a cornice halfway up a wall.
      const crownProps: { kind: number; x: number; y: number; z: number; s: number; rot: number; b?: string }[] = [];
      let crownDeck: { ring: [number, number][]; z: number } | null = null;
      if (!item.construction) {
        const tt = tiers[tiers.length - 1];
        const tfp = tt.fp as [number, number][];
        let ar2 = 0;
        for (let i = 0; i < tfp.length; i++) {
          const a = tfp[i], b = tfp[(i + 1) % tfp.length];
          ar2 += a[0] * b[1] - b[0] * a[1];
        }
        const cr = crownTop(mason2, T, R2, {
          ring: tfp, z1: tt.z1, roof: true, deco: false, bbl: item.bbl,
          style: tt.style ?? meta[0], rnd, varr, fh: fh2, area: ar2 / 2,
          // The industrial gate arrived on the static path only. It belongs to
          // the crown, not to the path, so it reaches player and rival sheds
          // too — which is the whole reason this block was extracted.
          industrial: item.cls === "industrial",
          cs: (n) => hash01(k ^ Math.imul(n + 1, 0x9e3779b1), this.citySeed ^ 0x00c0ffee),
          pier: (n) => hash01(k ^ Math.imul(n, 2654435761), this.citySeed),
          props: crownProps,
        });
        crownDeck = cr.mechDeck;
      }
      // The only ornament the ladder places itself: balustrade urns along a
      // stone cornice. They sit ON the parapet rather than a metre inside it,
      // which is why they do not come through the roof kit.
      if (crownProps.length) {
        const urns = crownProps.filter((p) => p.kind === 39).map((p) =>
          urnGeom().scale(p.s, p.s, p.s).translate(p.x, p.y, p.z));
        if (urns.length) this.dynGroup.add(new THREE.Mesh(mergeGeoms(urns), this.propMaterial(0xa9a293, false)));
      }
      const mk = (D: typeof T) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(D.pos, 3));
        g.setAttribute("normal", new THREE.Float32BufferAttribute(D.norm, 3));
        g.setAttribute("aU", new THREE.Float32BufferAttribute(D.u, 1));
        g.setAttribute("aStyle", new THREE.Float32BufferAttribute(D.style, 1));
        g.setAttribute("aRand", new THREE.Float32BufferAttribute(D.rand, 1));
        g.setAttribute("aVar", new THREE.Float32BufferAttribute(D.varr, 1));
        g.setAttribute("aTop", new THREE.Float32BufferAttribute(D.top, 1));
        g.setAttribute("aFh", new THREE.Float32BufferAttribute(D.fh, 1));
        g.setAttribute("aEra", new THREE.Float32BufferAttribute(D.era, 1));
        g.setAttribute("aSeg", new THREE.Float32BufferAttribute(D.seg, 2));
        g.setAttribute("aCcv", new THREE.Float32BufferAttribute(D.ccv, 2));
        g.setAttribute("aTint", new THREE.Float32BufferAttribute(new Float32Array(D.pos.length).fill(1), 3));
        g.setAttribute("aLit", new THREE.Float32BufferAttribute(new Float32Array(D.pos.length / 3).fill(-1), 1));
        g.setAttribute("aRet", new THREE.Float32BufferAttribute(new Float32Array(D.pos.length / 3).fill(-1), 1));
        return g;
      };
      this.dynGroup.add(new THREE.Mesh(mk(T), this.wallMat));
      this.dynGroup.add(new THREE.Mesh(mk(R2), this.roofMat));
      // A NEW TOWER'S DECK IS NOT BARE. The static stock grew a machine deck
      // this week — bulkheads, overruns, plant — and a building delivered in
      // 2014 with an empty roof next to a 1920s walk-up with a full one reads
      // as unfinished. Same rules as the static pass: the way out, the lift,
      // and the plant a modern central system actually has.
      // THE GRAND OPENING. For the first three months after delivery the
      // frontage carries bunting — a sagging string of bright pennants over
      // the door. When the news says a building opened, the street agrees.
      if (!item.construction && item.fresh) {
        const fp = tiers[0].fp;
        let bi = 0, bl = -1;
        for (let i = 0; i < fp.length; i++) {
          const a2 = fp[i], b2 = fp[(i + 1) % fp.length];
          const L = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
          if (L > bl) { bl = L; bi = i; }
        }
        if (bl > 5) {
          const a2 = fp[bi], b2 = fp[(bi + 1) % fp.length];
          const ex = b2[0] - a2[0], ey = b2[1] - a2[1];
          const L = Math.hypot(ex, ey);
          let nx = -ey / L, ny = ex / L;
          if (((a2[0] + b2[0]) / 2 - cx) * nx + ((a2[1] + b2[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
          const FLAG: number[] = [0xc0392b, 0xf1e6c8, 0x2e6b9e, 0xd9a441];
          const pens: THREE.BufferGeometry[] = [];
          const n = Math.min(22, Math.floor(L / 0.9));
          for (let i2 = 1; i2 < n; i2++) {
            const t = i2 / n;
            const sag = 0.55 * Math.sin(Math.PI * t);
            pens.push(new THREE.BoxGeometry(0.34, 0.05, 0.5)
              .translate(a2[0] + ex * t + nx * 0.55, a2[1] + ey * t + ny * 0.55, 4.6 - sag));
          }
          // one mesh per colour keeps it to four draws for the whole party
          FLAG.forEach((col, ci) => {
            const mine = pens.filter((_, i2) => i2 % FLAG.length === ci);
            if (mine.length) this.dynGroup.add(new THREE.Mesh(mergeGeoms(mine), this.propMaterial(col, false)));
          });
        }
      }
      if (!item.construction && h >= 9) {
        const topTier = tiers[tiers.length - 1];
        // THE WHOLE KIT, NOT FOUR OF IT.
        //
        // This asked for bulkhead, overrun, cooling tower and PV off four coin
        // flips, and could reach none of the other sixteen: no mast on a
        // supertall, no water tank, no condensers, no skylight, no roof
        // terrace, no dish, no window-washing rig, and no guardrail — which is
        // nearly all EDGE and therefore the one roof part that reads at a
        // distance no box does. Twenty years into a campaign, the buildings
        // this path draws are most of the roofs in frame, and roofs are 9.5%
        // of the frame.
        //
        // `roofKitWants` is the ladder the static stock uses, on the same
        // inputs. It stands on whatever the crown left: a tall building grows
        // a bulkhead up there, and dropping a cooling tower on the roof BELOW
        // it buries the plant inside the penthouse.
        const kseed = Number(item.bbl) % 1000;
        const deckRing = crownDeck ? crownDeck.ring : (topTier.fp as [number, number][]);
        const deckZ = crownDeck ? crownDeck.z : topTier.z1;
        let karea = 0;
        for (let i = 0; i < deckRing.length; i++) {
          const a2 = deckRing[i], b2 = deckRing[(i + 1) % deckRing.length];
          karea += a2[0] * b2[1] - b2[0] * a2[1];
        }
        const wants = roofKitWants({
          style, year: yearBuilt, hgt: h, fh: fh2, area: karea / 2,
          hasMechDeck: !!crownDeck, seed: kseed,
          rnd: (n) => hash01(k ^ Math.imul(n + 1, 0x9e3779b1), this.citySeed),
          jit: (n, amp) => (((kseed * (n + 3) * 2654435761) % 1000) / 1000 - 0.5) * amp,
        });
        const KIT = propKit();
        for (const p of fitRoofKit(deckRing, deckZ, wants,
          (i) => hash01(k ^ Math.imul(i + 7, 0x85ebca6b), this.citySeed), h)) {
          const g = KIT[p.kind];
          if (!g) continue;
          const m = new THREE.Mesh(g.geom, this.propMaterial(g.color, false));
          m.name = "prop:" + p.kind;
          m.rotation.z = p.rot; m.scale.setScalar(p.s ?? 1); m.position.set(p.x, p.y, p.z);
          this.dynGroup.add(m);
        }
        // The rail round the edge. Not part of the deck budget — it stands on
        // the parapet rather than in the middle, so it competes with nothing.
        if (h >= 14) {
          const rl = Math.min(1.8, Math.max(0.55, Math.sqrt(Math.abs(karea)) / 26));
          const rails: THREE.BufferGeometry[] = [];
          for (let e = 0; e < deckRing.length; e++) {
            const p0 = deckRing[e], p1 = deckRing[(e + 1) % deckRing.length];
            const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
            const L2 = Math.hypot(ex, ey);
            if (L2 < 9) continue;
            const nx = -ey / L2, ny = ex / L2;
            const sgn = karea > 0 ? 1 : -1;
            const n2 = Math.min(4, Math.floor(L2 / 7.2));
            const rs = Math.min(rl, L2 / (n2 * 7.0));
            for (let i = 0; i < n2; i++) {
              const t = (i + 0.5) / n2;
              rails.push(KIT[20].geom.clone().scale(rs, rs, rs)
                .rotateZ(Math.atan2(ey, ex))
                .translate(p0[0] + ex * t + nx * sgn * 1.5, p0[1] + ey * t + ny * sgn * 1.5, deckZ));
            }
          }
          if (rails.length) {
            const rail = new THREE.Mesh(mergeGeoms(rails), this.propMaterial(KIT[20].color, false));
            rail.name = "prop:20";
            this.dynGroup.add(rail);
          }
        }
      }
      if (item.construction) {
        // THE HOARDING. A construction site is fenced before it is anything
        // else — painted plywood around the footprint, and a project board at
        // the street telling the town what is coming. The news says somebody
        // broke ground; this is the street corroborating it.
        {
          const fp = tiers[0].fp;
          const FH = 2.6;
          const panels: THREE.BufferGeometry[] = [];
          let bestLen = 0, bx = 0, by = 0, bnx = 0, bny = 0;
          for (let i = 0; i < fp.length; i++) {
            const a2 = fp[i], b2 = fp[(i + 1) % fp.length];
            const ex = b2[0] - a2[0], ey = b2[1] - a2[1];
            const L = Math.hypot(ex, ey);
            if (L < 1.5) continue;
            panels.push(new THREE.BoxGeometry(L + 0.18, 0.14, FH)
              .translate(L / 2, 0, FH / 2)
              .rotateZ(Math.atan2(ey, ex))
              .translate(a2[0], a2[1], 0));
            if (L > bestLen) {
              bestLen = L;
              bx = (a2[0] + b2[0]) / 2; by = (a2[1] + b2[1]) / 2;
              let nx = -ey / L, ny = ex / L;
              if ((bx - cx) * nx + (by - cy) * ny < 0) { nx = -nx; ny = -ny; }
              bnx = nx; bny = ny;
            }
          }
          if (panels.length) {
            const HOARD = [0x2e6b5e, 0x35547a, 0x6b4a2e];
            const hc = HOARD[keyOf(item.bbl) % 3];
            this.dynGroup.add(new THREE.Mesh(mergeGeoms(panels), this.propMaterial(hc, false)));
          }
          if (bestLen > 6) {
            const bAng = Math.atan2(bny, bnx) + Math.PI / 2;
            const board = mergeGeoms([
              new THREE.BoxGeometry(3.6, 0.10, 1.9).translate(0, 0, 2.6),
              new THREE.BoxGeometry(0.14, 0.14, 2.0).translate(-1.5, 0, 1.0),
              new THREE.BoxGeometry(0.14, 0.14, 2.0).translate(1.5, 0, 1.0),
            ]).rotateZ(bAng).translate(bx + bnx * 0.9, by + bny * 0.9, 0);
            this.dynGroup.add(new THREE.Mesh(board, this.propMaterial(0xe6e1d4, false)));
          }
        }
        // A TOWER CRANE, AND NOT THE SAME ONE TWICE.
        //
        // There was a crane here already — a smooth cylinder and a 26 m box —
        // but it stood at cx+6, cy+6 with its jib pointing down +x on EVERY
        // site in the city, forever. Identical and identically oriented, which
        // is the same wallpaper problem the facades had: the eye reads the
        // repetition long before it reads any single object.
        //
        // A real one slews. It has a counter-jib with a concrete block on it
        // to balance the load, a trolley somewhere out along the jib, and a
        // hook on a line hanging from the trolley — and the hook is the part
        // that tells you the thing is working rather than parked.
        const orange = this.propMaterial(0xc2803a, false);
        const grey = this.propMaterial(0x8d9096, false);
        const k = keyOf(item.bbl);
        const bear = hash01(k, this.citySeed ^ 0x517) * Math.PI * 2;
        const ca = Math.cos(bear), sa = Math.sin(bear);
        // stand it off a corner of the site rather than in the middle of it
        const off = 4.5 + hash01(k ^ 0x31, this.citySeed) * 3.5;
        const mx = cx + ca * off, my = cy + sa * off;
        const mastH = h + 12 + hash01(k ^ 0x77, this.citySeed) * 10;
        const jib = 22 + hash01(k ^ 0x99, this.citySeed) * 16;
        const back = jib * 0.34;
        // the trolley runs out along the jib, and the hook hangs off it
        const tro = 0.35 + hash01(k ^ 0xab, this.citySeed) * 0.5;
        const hook = mastH - 4 - hash01(k ^ 0xcd, this.citySeed) * (mastH - h * 0.4 - 6);
        const at = (g: THREE.BufferGeometry, x: number, y: number, z: number) =>
          g.rotateZ(bear).translate(x, y, z);
        this.dynGroup.add(
          // mast, on a wider foot so it does not look balanced on a pin
          new THREE.Mesh(at(new THREE.CylinderGeometry(0.42, 0.55, mastH, 6).rotateX(Math.PI / 2), mx, my, mastH / 2), orange),
          new THREE.Mesh(at(new THREE.BoxGeometry(3.2, 3.2, 1.0), mx, my, 0.5), grey),
        );
        // AND THE CRANE SLEWS. Everything above the slewing ring — jib,
        // counter-jib, counterweight, cab, hoist line and hook — hangs on one
        // Group whose local +x is the jib direction, so the whole working
        // assembly turns with a single rotation.z write. The mast and foot
        // stay put below it, world-placed by at() like every other prop.
        // render() drives the angle from the clock; nothing re-randomises.
        const slew = new THREE.Group();
        slew.position.set(mx, my, 0);
        slew.rotation.z = bear;
        slew.add(
          // jib forward, counter-jib back, and the counterweight that pays for it
          new THREE.Mesh(new THREE.BoxGeometry(jib, 1.1, 1.3).translate(jib / 2, 0, mastH - 1.4), orange),
          new THREE.Mesh(new THREE.BoxGeometry(back, 1.3, 1.5).translate(-back / 2, 0, mastH - 1.4), orange),
          new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.2, 2.0).translate(-back, 0, mastH - 1.6), grey),
          // operator's cab, at the slewing ring
          new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.9).translate(1.6, 0, mastH - 3.4), grey),
          // the hoist line and the hook block — the part that says it is working
          new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, mastH - 1.4 - hook, 4).rotateX(Math.PI / 2).translate(jib * tro, 0, (mastH - 1.4 + hook) / 2), grey),
          new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 1.0).translate(jib * tro, 0, hook), grey),
        );
        this.dynGroup.add(slew);
        // One lazy sweep every 22-38 seconds, period and phase hashed off the
        // deed like everything else about this crane, so two sites never move
        // in lockstep and a reload finds each crane mid-gesture, not reset.
        this.cranes.push({
          g: slew, bear,
          w: (Math.PI * 2) / (44 + hash01(k ^ 0xe1, this.citySeed) * 32),
          phase: hash01(k ^ 0xf3, this.citySeed) * Math.PI * 2,
        });
        // SITE HOARDING. A job with no fence around it is a building that grew.
        for (let i = 0; i < ring.length; i++) {
          const a2 = ring[i], b2 = ring[(i + 1) % ring.length];
          const dx = b2[0] - a2[0], dy = b2[1] - a2[1];
          const L = Math.hypot(dx, dy);
          if (L < 3) continue;
          this.dynGroup.add(new THREE.Mesh(
            new THREE.BoxGeometry(L, 0.22, 2.2)
              .rotateZ(Math.atan2(dy, dx))
              .translate((a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2, 1.1),
            orange));
        }
      }
    }
    this.sunDirty = true;
    this.map.triggerRepaint();
  }

  /**
   * TAKE THE WHOLE BUILDING DOWN.
   *
   * This flattened attribute 0 only — the walls — and left the roof cap
   * floating at forty metres with its water tower still on it. A demolition
   * that leaves the roof in the sky is not a demolition. Walls, roof and every
   * piece of rooftop furniture go together, which is what a wrecking crew does.
   */
  private flattenLot(bbl: string) {
    this.flattened.add(bbl);
    const ranges = this.rangesByBBL.get(bbl);
    if (ranges) {
      for (const { attr, r } of ranges) {
        const pa = this.posAttrs[attr];
        if (!pa) continue;
        const arr = pa.array as Float32Array;
        for (let i = r.start; i < r.start + r.count; i++) arr[i * 3 + 2] = Math.min(arr[i * 3 + 2], 0.02);
        pa.needsUpdate = true;
      }
    }
    this.hideProps(bbl);
    this.map.triggerRepaint();
  }

  /** Scale a building's rooftop and facade props to nothing. */
  private hideProps(bbl: string) {
    const list = this.propsByBBL.get(bbl);
    if (!list) return;
    const m = new THREE.Matrix4();
    for (const { mesh, i } of list) {
      mesh.getMatrixAt(i, m);
      m.scale(new THREE.Vector3(0, 0, 0));
      mesh.setMatrixAt(i, m);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  setTints(tints: Map<string, [number, number, number]>) {
    for (let i = 0; i < this.tintAttrs.length; i++) {
      (this.tintAttrs[i].array as Float32Array).set(this.baseTints[i]);
    }
    for (const [bbl, [r, g, b]] of tints) {
      const ranges = this.rangesByBBL.get(bbl);
      if (!ranges) continue;
      for (const { attr, r: range } of ranges) {
        const arr = this.tintAttrs[attr].array as Float32Array;
        for (let i = range.start; i < range.start + range.count; i++) {
          arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b;
        }
      }
    }
    for (const attr of this.tintAttrs) attr.needsUpdate = true;
    this.map.triggerRepaint();
  }

  /**
   * WHICH FLOORS ARE LET. -1 means "not yours to know" and switches the whole
   * treatment off for that building; 0..1 is the leased share. Uses the same
   * per-BBL vertex ranges the ownership tints already walk, so it costs one
   * pass over the buildings you actually have a number for.
   */
  setOccupancy(occ: Map<string, number>) {
    if (!this.litAttrs.length) return;
    for (const a of this.litAttrs) (a.array as Float32Array).fill(-1);
    for (const [bbl, v] of occ) {
      const ranges = this.rangesByBBL.get(bbl);
      if (!ranges) continue;
      const f = Math.max(0, Math.min(1, v));
      for (const { attr, r } of ranges) {
        const arr = this.litAttrs[attr].array as Float32Array;
        arr.fill(f, r.start, r.start + r.count);
      }
    }
    for (const a of this.litAttrs) a.needsUpdate = true;
    this.map.triggerRepaint();
  }

  /** Call BEFORE map.addLayer — planting reads it once, at build. */
  setDemandMap(m: Record<string, number>) {
    this.demandByBbl = m;
  }

  /**
   * LEGAL NOTICES ON DOORS. The July docket and the banks' foreclosure files
   * are news items until you drive past the building — a white board with a
   * red rule at the frontage is the street corroborating the courthouse.
   * Rebuilt monthly from whatever list the game sends; empty list clears.
   */
  private noticeGroup = new THREE.Group();
  setNotices(bbls: string[]) {
    if (!this.noticeGroup.parent) this.scene.add(this.noticeGroup);
    this.noticeGroup.clear();
    for (const bbl of bbls) {
      const v = this.volumes.find((x) => x.b === bbl && !x.d && x.r.length >= 3);
      if (!v) continue;
      const ring = v.r.map((p) => this.project(p));
      let cx = 0, cy = 0;
      for (const [x, y] of ring) { cx += x; cy += y; }
      cx /= ring.length; cy /= ring.length;
      let bi = 0, bl = -1;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > bl) { bl = L; bi = i; }
      }
      if (bl < 3) continue;
      const a = ring[bi], b = ring[(bi + 1) % ring.length];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const L = Math.hypot(ex, ey);
      let nx = -ey / L, ny = ex / L;
      if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
      const px = (a[0] + b[0]) / 2 + nx * 0.7, py = (a[1] + b[1]) / 2 + ny * 0.7;
      const ang = Math.atan2(ey, ex);
      const board = mergeGeoms([
        new THREE.BoxGeometry(1.1, 0.07, 1.4).translate(0, 0, 1.9),
        new THREE.BoxGeometry(0.10, 0.10, 1.3).translate(0, 0, 0.65),
      ]).rotateZ(ang).translate(px, py, 0);
      this.noticeGroup.add(new THREE.Mesh(board, this.propMaterial(0xe9e5da, false)));
      const stripe = new THREE.BoxGeometry(1.1, 0.075, 0.22).translate(0, 0, 2.48)
        .rotateZ(ang).translate(px, py, 0);
      this.noticeGroup.add(new THREE.Mesh(stripe, this.propMaterial(0xa8362a, false)));
    }
    this.map?.triggerRepaint();
  }

  /**
   * RETAIL OCCUPANCY, so the storefronts tell the truth. -1 for a building
   * with no shops (the band draws as it always did); 0..1 papers exactly the
   * vacant share of the bays. Same per-BBL ranges the tints walk, monthly.
   */
  setRetail(ret: Map<string, number>) {
    if (!this.retAttrs.length) return;
    for (const a of this.retAttrs) (a.array as Float32Array).fill(-1);
    for (const [bbl, f] of ret) {
      const ranges = this.rangesByBBL.get(bbl);
      if (!ranges) continue;
      for (const { attr, r } of ranges) {
        const arr = this.retAttrs[attr].array as Float32Array;
        arr.fill(f, r.start, r.start + r.count);
      }
    }
    for (const a of this.retAttrs) a.needsUpdate = true;
    this.map.triggerRepaint();
  }

  /** Economy and weather only change visibility; the instanced crowd is never rebuilt. */
  setActivity(activity: number) {
    const next = Math.max(0.25, Math.min(1.05, Number.isFinite(activity) ? activity : 1));
    if (Math.abs(next - this.activityUni.value) < 0.005) return;
    this.activityUni.value = next;
    this.map?.triggerRepaint();
  }

  private applySeason() {
    // Snow cover is weather, not a five-month paint scheme. A clear January
    // keeps only a trace in sheltered places; an active snow month carries a
    // real cover. The old table still controls foliage and dormancy.
    const residual = this.seasonBase.x * 0.07;
    const snow = Math.max(residual, this.weatherSnow);
    this.seasonUni.value.set(snow, this.seasonBase.y, this.seasonBase.z, this.seasonBase.w);
  }

  setWeather(kind: "clear" | "overcast" | "rain" | "snow", precipitation: number, overcast: number) {
    const p = Math.max(0, Math.min(1, Number.isFinite(precipitation) ? precipitation : 0));
    const cloud = Math.max(0, Math.min(1, Number.isFinite(overcast) ? overcast : 0));
    this.weatherUni.value.set(kind === "rain" ? p : 0, cloud);
    this.weatherSnow = kind === "snow" ? 0.32 + p * 0.62 : 0;
    this.applySeason();
    this.map?.triggerRepaint();
  }

  setMonth(m: number) {
    if (!Number.isFinite(m) || m === this.simMonth) return;
    this.simMonth = m;
    const mo = ((Math.floor(m) % 12) + 12) % 12;
    const w2 = Math.cos((2 * Math.PI * (mo - 6)) / 12);
    const w = 0.5 + 0.5 * w2;
    const el = ((SUN_EL_MID + SUN_EL_AMP * w2) * Math.PI) / 180;
    const az = ((SUN_AZ_MID + SUN_AZ_AMP * w2) * Math.PI) / 180;
    this.sunDirUni.value.set(
      Math.sin(az) * Math.cos(el) * SUN_LEN,
      Math.cos(az) * Math.cos(el) * SUN_LEN,
      Math.sin(el) * SUN_LEN,
    );
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const sc = (i: 0 | 1 | 2) =>
      lerp(SUN_COL_SUMMER[i], lerp(SUN_COL_WINTER[i], SUN_COL_SUMMER[i], w), SUN_WARMTH);
    this.sunColUni.value.set(sc(0), sc(1), sc(2));
    const [snow, turn, bare, vigour] = SEASON_TABLE[mo];
    this.seasonBase.set(snow, turn, bare, vigour);
    this.applySeason();
    this.sunDirty = true;
    if (this.map) this.map.triggerRepaint();
  }

  setOpacity(o: number) {
    this.wallMat.uniforms.uOpacity.value = o;
    this.roofMat.uniforms.uOpacity.value = o;
    const transparent = o < 1;
    this.wallMat.transparent = transparent;
    this.roofMat.transparent = transparent;
    this.map.triggerRepaint();
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, options: maplibregl.CustomRenderMethodInput) {
    if (!this.visible) return;
    const renderStart = performance.now();
    if (this.sunDirty) this.bakeShadows();
    // approximate camera position in city meters (for glass reflections):
    // derived from center/zoom/bearing/pitch — MapLibre has no free-camera getter
    {
      const c = this.map.getCenter();
      const z = this.map.getZoom();
      const bearing = (this.map.getBearing() * Math.PI) / 180;
      const pitch = (this.map.getPitch() * Math.PI) / 180;
      const mpp = (78271.517 * Math.cos((c.lat * Math.PI) / 180)) / Math.pow(2, z);
      const h = this.map.getContainer().clientHeight || 900;
      const distM = (0.5 * h) / Math.tan(0.32175) * mpp; // default fov ≈ 36.87°
      const [cx0, cy0] = this.project([c.lng, c.lat]);
      const back = distM * Math.sin(pitch);
      this.camUni.value.set(
        cx0 - Math.sin(bearing) * back,
        cy0 - Math.cos(bearing) * back,
        distM * Math.cos(pitch),
      );
    }
    // THE ANIMATED THINGS IN THE GAME — the water, and now the cranes —
    // share one clock and one budget, and they pay their way: ~30fps, and
    // only while the layer is actually visible. MapLibre repaints on demand,
    // so without this call the city would be a still photograph — and with it
    // uncapped, it would burn a core to redraw water nobody is looking at.
    //
    // When a frame is already over budget the animation clock backs off to
    // ~15fps so the next paint has a chance to finish; a hidden tab does not
    // schedule work at all.
    if (this.waterMat || this.cranes.length || this.hasWalkers || this.hasPonds) {
      const now = performance.now();
      this.timeUni.value = now / 1000;
      // A crane's slew is its parked bearing plus two slow incommensurate
      // sines: it sweeps, hesitates, reverses — a driver working a load, not
      // a turntable. Deterministic in the clock, no per-frame rng, and one
      // rotation.z write per crane, of which a handful exist at once.
      for (const c of this.cranes) {
        c.g.rotation.z = c.bear + 1.1 * Math.sin(this.timeUni.value * c.w + c.phase)
          + 0.45 * Math.sin(this.timeUni.value * c.w * 2.618 + c.phase * 3.1);
      }
      const animGap = this.frameEma > 40 ? 66 : 33;
      if (
        now - this.lastFrame > animGap
        && typeof document !== "undefined"
        && !document.hidden
      ) {
        this.lastFrame = now;
        this.map.triggerRepaint();
      }
    }
    const m = new THREE.Matrix4().fromArray(Array.from(options.defaultProjectionData.mainMatrix));
    const l = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.origin.s, -this.origin.s, this.origin.s));
    const base = new THREE.Matrix4().multiplyMatrices(m, l);
    this.camera.projectionMatrix = base;
    this.renderer.resetState();

    if (!this.ensurePostSize() || !this.sceneRT || !this.bloomA || !this.bloomB) {
      this.renderer.render(this.scene, this.camera);
      this.noteFrame(renderStart);
      return;
    }

    const prevTarget = this.renderer.getRenderTarget();
    // Budget flags. Still frames keep the full photograph — bloom, AO, bounce,
    // shafts, tilt-shift. While the camera is moving those lens extras are
    // deferred (the eye cannot read them on a moving frame anyway). A sustained
    // overrun only lengthens the harbour-reflection interval, never strips the
    // still image.
    const heavy = this.frameEma > (this.preferFps ? 26 : 36);
    const skipExtras = this.camMoving;

    // 0. THE CITY, UPSIDE DOWN, for the harbour to carry.
    //
    // Negating world Z projects every building to exactly where its reflection
    // belongs on screen, which is what lets the water shader sample at its own
    // fragment position with no matrix work of its own. The mirror flips
    // winding — normally that would cull the whole city away — but the wall and
    // roof materials are already DoubleSide for their own reasons, so the
    // buildings survive it and no cull-face juggling is needed.
    //
    // The water itself, the shadow catcher and the occlusion floor all sit ON
    // the mirror plane and are coplanar with their own reflections; they are
    // hidden, or they z-fight with themselves and cover the result.
    // HOW MUCH REFLECTION IS WORTH RENDERING FOR.
    //
    // The mirrored pass draws the entire city a second time, every frame. What
    // it buys is governed by Fresnel, and Fresnel is the reason it is not
    // always worth buying: looking straight down at water you see about two per
    // cent reflection and ninety-eight per cent riverbed, so the pass is
    // rendering a skyline nobody can see. It earns its cost at a graze and
    // almost nowhere else.
    //
    // Faded rather than switched, so there is no frame where the harbour pops,
    // and the pass is skipped outright only once the strength has already
    // reached zero.
    //
    // Under load the last good reflection is reused for a frame or two — the
    // harbour keeps a skyline, the second draw does not run. While the camera
    // is moving the pass is skipped entirely (strength fades to zero for the
    // duration) and restored on settle.
    const reflStrength = this.camMoving ? 0 : smoothstep(20, 46, this.map.getPitch());
    if (this.waterMat) this.waterMat.uniforms.uReflectOn.value = reflStrength;
    const wantRefl = !!(this.water && this.reflectRT && this.waterMat && reflStrength > 0.02);
    const reflInterval = this.preferFps || heavy ? 2 : 1;
    const refreshRefl = wantRefl && (this.reflFrame % reflInterval === 0);
    this.reflFrame++;
    if (refreshRefl) {
      // Everything lying ON the mirror plane is coplanar with its own
      // reflection — the same set the shadow bake excludes, for the same
      // reason it is flagged: flat ground sheets.
      const wasWater = this.water!.visible;
      const wasCatcher = this.groundCatcher?.visible ?? false;
      const wasAo = this.aoGround?.visible ?? false;
      const wasSheen = this.groundSheen?.visible ?? false;
      this.water!.visible = false;
      if (this.groundCatcher) this.groundCatcher.visible = false;
      if (this.aoGround) this.aoGround.visible = false;
      if (this.groundSheen) this.groundSheen.visible = false;

      // Mirrored projection breaks Three's frustum planes; street batches that
      // correctly cull in the forward pass would vanish from the harbour. Park
      // culling for this draw only.
      const reCull: THREE.Object3D[] = [];
      this.scene.traverse((o) => {
        if (o.frustumCulled) { o.frustumCulled = false; reCull.push(o); }
      });

      this.camera.projectionMatrix = new THREE.Matrix4()
        .multiplyMatrices(base, new THREE.Matrix4().makeScale(1, 1, -1));
      this.renderer.setRenderTarget(this.reflectRT);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, false);
      this.renderer.render(this.scene, this.camera);

      for (const o of reCull) o.frustumCulled = true;
      this.water!.visible = wasWater;
      if (this.groundCatcher) this.groundCatcher.visible = wasCatcher;
      if (this.aoGround) this.aoGround.visible = wasAo;
      if (this.groundSheen) this.groundSheen.visible = wasSheen;
      this.camera.projectionMatrix = base;

      this.waterMat!.uniforms.uReflect.value = this.reflectRT!.texture;
      (this.waterMat!.uniforms.uResolution.value as THREE.Vector2).copy(this.postSize);
    } else if (wantRefl && this.waterMat && this.reflectRT) {
      // Keep sampling the last good mirror while we skip the redraw.
      this.waterMat.uniforms.uReflect.value = this.reflectRT.texture;
      (this.waterMat.uniforms.uResolution.value as THREE.Vector2).copy(this.postSize);
    }

    // 1. the city, offscreen, onto nothing
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);

    // 2. what is bright enough to spill, at quarter res
    this.brightMat.uniforms.uTex.value = this.sceneRT.texture;
    this.blit(this.brightMat, this.bloomA);

    // 3. spill it, separably
    const bw = this.bloomA.width, bh = this.bloomA.height;
    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(1 / bw, 0);
    this.blit(this.blurMat, this.bloomB);
    this.blurMat.uniforms.uTex.value = this.bloomB.texture;
    (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 1 / bh);
    this.blit(this.blurMat, this.bloomA);

    // 4. the occlusion needs to reach the pavement, and the pavement belongs
    //    to MapLibre — so it goes down first, as a multiply on what is already
    //    in the buffer, before anything of ours covers it.
    const invProj = new THREE.Matrix4().copy(this.camera.projectionMatrix).invert();
    {
      const u = this.aoCalcMat.uniforms;
      u.uDepth.value = this.sceneRT.depthTexture;
      (u.uInvProj.value as THREE.Matrix4).copy(invProj);
      (u.uAoTexel.value as THREE.Vector2).set(1 / this.postSize.x, 1 / this.postSize.y);
      (u.uAoCam.value as THREE.Vector3).copy(this.camUni.value);
      (u.uProj.value as THREE.Matrix4).copy(this.camera.projectionMatrix);
      (u.uAoSun.value as THREE.Vector3).copy(this.sunDirUni.value).normalize();
    }
    // solve once at half size, then blur the estimator's noise off it
    if (this.aoA && this.aoB) {
      this.blit(this.aoCalcMat, this.aoA);
      // A NARROWER KERNEL THAN THE BLOOM USES. This is the same separable
      // gaussian, but its taps sit at 1.4 and 3.2 texels — at half resolution
      // that is a six-pixel reach at full size, which is fine on the low
      // frequencies of a courtyard and far too wide on a fire escape, where it
      // smears the occlusion off the ironwork and onto the wall behind as a
      // blob. Sixty per cent of the step keeps the estimator's noise down
      // without spreading contact past the thing making it.
      const aw = this.aoA.width, ah = this.aoA.height;
      this.blurMat.uniforms.uTex.value = this.aoA.texture;
      (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(0.6 / aw, 0);
      this.blit(this.blurMat, this.aoB);
      this.blurMat.uniforms.uTex.value = this.aoB.texture;
      (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 0.6 / ah);
      this.blit(this.blurMat, this.aoA);
      this.aoMultMat.uniforms.uAoTex.value = this.aoA.texture;
      this.compMat.uniforms.uAoTex.value = this.aoA.texture;
    }
    this.compMat.uniforms.uDepth.value = this.sceneRT.depthTexture;
    (this.compMat.uniforms.uInvProj.value as THREE.Matrix4).copy(invProj);
    (this.compMat.uniforms.uEye.value as THREE.Vector3).copy(this.camUni.value);
    {
    }
    // THE LENS READS THE CAMERA — AND IT READS ZOOM, NOT PITCH.
    //
    // This was gated on pitch first, on the reasoning that a horizontal focus
    // band needs a depth gradient running up the frame and a plan view has
    // none. That is true of real depth of field and it is exactly backwards
    // for this effect. Tilt-shift photographs of cities are shot from
    // altitude, near nadir, and the band is not simulating a focal plane —
    // it IS the cue, the thing that makes a viewer read a real city as a
    // model. Killing it at low pitch removed it from the establishing shot,
    // which is the one frame in the game that is most explicitly a photograph
    // of a model.
    //
    // Zoom is the right axis. Far out you are looking at the model; down at
    // street level you are looking at a building you are about to buy, and
    // there the blur is only in the way. Depth of field is decoration;
    // legibility is not.
    //
    // ONE RADIUS CANNOT SERVE BOTH CAMERAS. The establishing frame may carry a
    // model-photograph softness; the closer gameplay frame has to preserve
    // windows, cornices, occupancy bands and construction detail. The old
    // 3.1-to-1.0px range still erased too much of that work, so the gameplay
    // end now falls below half a pixel while the wide shot retains a restrained
    // photographic falloff.
    //
    // Zoom stands in for pitch here because the app's two cameras move both
    // together. The driver underneath is the depth spread, which is a
    // function of pitch alone.
    {
      const zoom = this.map.getZoom();
      // Keep the establishing shot photographic, but do not blur away the
      // facade and roof work at the camera where decisions are made.
      // While the camera is moving the disk samples are wasted work — the eye
      // cannot read tilt-shift on a frame that is already in motion.
      const model = skipExtras
        ? 0
        : 2.25 + (0.42 - 2.25) * smoothstep(14.6, 15.3, zoom);
      this.compMat.uniforms.uDefocus.value = model * (1 - smoothstep(16.4, 18.2, zoom));
    }

    // Where the sun sits on screen. Projected on the CPU because it is one
    // point per frame, and the fragment shader has no way to find it: the
    // combined matrix MapLibre hands over is not decomposable into a camera
    // the shader could reason about.
    {
      const sd = this.sunDirUni.value;
      const p = new THREE.Vector3(
        this.camUni.value.x + sd.x * 9000,
        this.camUni.value.y + sd.y * 9000,
        this.camUni.value.z + sd.z * 9000,
      ).applyMatrix4(this.camera.projectionMatrix);
      const inFront = p.z > -1 && p.z < 1;
      const su = this.compMat.uniforms.uSunScreen.value as THREE.Vector3;
      su.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5, inFront ? 1 : 0);
    }

    // 3a. IRRADIANCE — what every surface's neighbours are throwing back at it.
    //
    // Three blurs of the scene at quarter resolution. A heavily blurred image
    // is a crude but genuinely useful estimate of local incoming light: at a
    // given pixel it holds the average colour of everything around it, which
    // is exactly what bounced light IS. The first pass doubles as the
    // downsample, so the whole thing costs three quarter-res blits.
    if (this.irrA && this.irrB && !skipExtras) {
      const iw = this.irrA.width, ih = this.irrA.height;
      this.blurMat.uniforms.uTex.value = this.sceneRT.texture;
      (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(2.2 / iw, 0);
      this.blit(this.blurMat, this.irrA);
      this.blurMat.uniforms.uTex.value = this.irrA.texture;
      (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(0, 2.2 / ih);
      this.blit(this.blurMat, this.irrB);
      this.blurMat.uniforms.uTex.value = this.irrB.texture;
      (this.blurMat.uniforms.uDir.value as THREE.Vector2).set(2.2 / iw, 0);
      this.blit(this.blurMat, this.irrA);
      this.compMat.uniforms.uIrr.value = this.irrA.texture;
    }

    // 3b. light shafts, at quarter res, off the same depth and sun position.
    //     Skipped outright when the sun is behind the camera: the shader
    //     already returns black in that case, and a pass whose every output is
    //     known is a pass not worth dispatching. The composite is told to stop
    //     adding it so the last frame's shafts cannot linger.
    const sunUp = (this.compMat.uniforms.uSunScreen.value as THREE.Vector3).z > 0.5;
    if (this.shaftRT && sunUp && !skipExtras) {
      this.shaftMat.uniforms.uDepth.value = this.sceneRT.depthTexture;
      (this.shaftMat.uniforms.uSunScreen.value as THREE.Vector3)
        .copy(this.compMat.uniforms.uSunScreen.value as THREE.Vector3);
      this.blit(this.shaftMat, this.shaftRT);
      this.compMat.uniforms.uShaft.value = this.shaftRT.texture;
    }
    this.compMat.uniforms.uShaftAmt.value = sunUp && !skipExtras ? 0.42 : 0.0;

    this.renderer.setRenderTarget(prevTarget);
    this.blit(this.aoMultMat, prevTarget);

    // 5. lens and composite, back into MapLibre's buffer
    this.compMat.uniforms.uScene.value = this.sceneRT.texture;
    this.compMat.uniforms.uBloom.value = this.bloomA.texture;
    (this.compMat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.postSize.x, 1 / this.postSize.y);
    this.blit(this.compMat, prevTarget);

    // Hand the context back exactly as MapLibre expects to find it — it still
    // has its own symbol layers and controls to draw after this.
    this.renderer.resetState();
    this.noteFrame(renderStart);
  }

  /** Exponential moving average of frame cost — drives the adaptive skips. */
  private noteFrame(start: number) {
    const dt = performance.now() - start;
    this.frameEma = this.frameEma * 0.9 + dt * 0.1;
  }

  onRemove() {
    this.scene.clear();
  }
}

// A car in eleven boxes' worth of triangles: bonnet, cabin, boot. Length runs
// along +x so it can be dropped straight onto a kerb bearing.
// A painted parapet sign: the panel, and the two legs holding it up.
/**
 * A fire escape: two rails, a platform per floor, and a stair slanting between
 * them. Built projecting along -Y so it can be dropped on a wall with the
 * edge's own bearing and nothing else.
 */
function fireEscapeGeom(levels: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const H = 3.4;
  const top = H * levels + 1.2;
  parts.push(new THREE.BoxGeometry(0.11, 0.11, top).translate(-1.35, -1.5, top / 2 + H * 0.55));
  parts.push(new THREE.BoxGeometry(0.11, 0.11, top).translate(1.35, -1.5, top / 2 + H * 0.55));
  for (let i = 0; i < levels; i++) {
    const z = H * (i + 1.55);
    parts.push(new THREE.BoxGeometry(2.9, 1.5, 0.09).translate(0, -0.9, z));        // platform
    parts.push(new THREE.BoxGeometry(2.9, 0.07, 0.07).translate(0, -1.62, z + 0.95)); // handrail
    if (i < levels - 1) {
      // the stair, leaning back against the wall on alternate sides
      const side = i % 2 === 0 ? 0.85 : -0.85;
      // ROTATE, THEN TRANSLATE. BufferGeometry.rotateX turns the geometry about
      // the ORIGIN, so tilting an already-translated stair swung it out on a
      // radius equal to its height — every brick walk-up in the city had a
      // black spar the length of a ship's mast lancing off the fourth floor.
      const stair = new THREE.BoxGeometry(0.95, 0.1, H * 1.22)
        .rotateX(0.52)
        .translate(side, -1.1, z + H / 2);
      parts.push(stair);
    }
  }
  return mergeGeoms(parts);
}

function billboardGeom(): THREE.BufferGeometry {
  const panel = new THREE.BoxGeometry(9, 0.3, 2.4).translate(0, 0, 2.6);
  const legA = new THREE.BoxGeometry(0.24, 0.24, 1.5).translate(-2.9, 0, 0.75);
  const legB = new THREE.BoxGeometry(0.24, 0.24, 1.5).translate(2.9, 0, 0.75);
  return mergeGeoms([panel, legA, legB]);
}

function carGeom(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(4.35, 1.78, 0.82).translate(0, 0, 0.62);
  const cabin = new THREE.BoxGeometry(2.15, 1.62, 0.62).translate(-0.15, 0, 1.32);
  const bonnet = new THREE.BoxGeometry(1.15, 1.66, 0.22).translate(1.5, 0, 1.05);
  return mergeGeoms([body, cabin, bonnet]);
}

function pileGeom(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.22, 0.26, 1.7, 5).rotateX(Math.PI / 2).translate(0, 0, 0.85);
}

// A park bench, lying along +X so the baked bearing turns it to face its walk.
// Slat seat, low back, two cast ends — 1.85 m, which is the length a bench has
// been since before anybody was measuring them.
function benchGeom(): THREE.BufferGeometry {
  const seat = new THREE.BoxGeometry(1.85, 0.50, 0.07).translate(0, 0.02, 0.45);
  const back = new THREE.BoxGeometry(1.85, 0.06, 0.32).translate(0, -0.21, 0.67);
  const rail = new THREE.BoxGeometry(1.85, 0.05, 0.05).translate(0, -0.19, 0.86);
  const endA = new THREE.BoxGeometry(0.08, 0.46, 0.45).translate(-0.80, 0, 0.225);
  const endB = new THREE.BoxGeometry(0.08, 0.46, 0.45).translate(0.80, 0, 0.225);
  return mergeGeoms([seat, back, rail, endA, endB]);
}

// One bay of waterfront railing: a post, and the run of top and middle rail
// that reaches forward to the next one. Posts are dropped every 3.2 m and the
// rail is 3.3 m, so the bays overlap slightly and the line never breaks.
function railGeom(): THREE.BufferGeometry {
  const post = new THREE.BoxGeometry(0.10, 0.10, 1.02).translate(0, 0, 0.51);
  const cap = new THREE.BoxGeometry(0.16, 0.16, 0.08).translate(0, 0, 1.05);
  const top = new THREE.BoxGeometry(3.30, 0.08, 0.08).translate(1.6, 0, 0.99);
  const mid = new THREE.BoxGeometry(3.30, 0.05, 0.05).translate(1.6, 0, 0.62);
  return mergeGeoms([post, cap, top, mid]);
}

function treeTrunkGeom(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.16, 0.26, 3.1, 5).rotateX(Math.PI / 2).translate(0, 0, 1.55);
}

// three overlapping lumps read as a canopy from any angle and cost 60 tris
function treeCanopyGeom(): THREE.BufferGeometry {
  const a = new THREE.IcosahedronGeometry(1.85, 0).translate(0, 0, 4.3);
  const b = new THREE.IcosahedronGeometry(1.25, 0).translate(0.85, 0.3, 3.5);
  return mergeGeoms([a, b]);
}

// the narrow street tree that fits where a spreading one would not
function columnarCanopyGeom(): THREE.BufferGeometry {
  const a = new THREE.IcosahedronGeometry(1.1, 0).scale(1, 1, 2.1).translate(0, 0, 5.0);
  const b = new THREE.IcosahedronGeometry(0.85, 0).scale(1, 1, 1.5).translate(0.2, -0.15, 3.4);
  return mergeGeoms([a, b]);
}

function coniferCanopyGeom(): THREE.BufferGeometry {
  const a = new THREE.ConeGeometry(1.55, 4.2, 6).rotateX(Math.PI / 2).translate(0, 0, 4.6);
  const b = new THREE.ConeGeometry(1.05, 2.4, 6).rotateX(Math.PI / 2).translate(0, 0, 6.6);
  return mergeGeoms([a, b]);
}

// A person: legs, coat, head. Twenty-two triangles, and the only thing in the
// city at a scale everybody already knows.
function personGeom(): THREE.BufferGeometry {
  const legs = new THREE.BoxGeometry(0.34, 0.24, 0.82).translate(0, 0, 0.41);
  const coat = new THREE.BoxGeometry(0.46, 0.30, 0.62).translate(0, 0, 1.13);
  const head = new THREE.BoxGeometry(0.22, 0.22, 0.24).translate(0, 0, 1.56);
  return mergeGeoms([legs, coat, head]);
}

function lampGeom(): THREE.BufferGeometry {
  const post = new THREE.CylinderGeometry(0.09, 0.13, 4.6, 5).rotateX(Math.PI / 2).translate(0, 0, 2.3);
  const arm = new THREE.BoxGeometry(1.15, 0.12, 0.12).translate(0.5, 0, 4.55);
  const head = new THREE.BoxGeometry(0.52, 0.3, 0.26).translate(1.0, 0, 4.42);
  return mergeGeoms([post, arm, head]);
}

function waterTowerGeom(): THREE.BufferGeometry {
  const tank = new THREE.CylinderGeometry(1.7, 1.5, 3.2, 12).rotateX(Math.PI / 2).translate(0, 0, 3.4);
  const cone = new THREE.ConeGeometry(1.8, 1.2, 12).rotateX(Math.PI / 2).translate(0, 0, 5.6);
  const legs = new THREE.CylinderGeometry(0.9, 1.1, 1.9, 6).rotateX(Math.PI / 2).translate(0, 0, 0.95);
  return mergeGeoms([tank, cone, legs]);
}

function antennaGeom(): THREE.BufferGeometry {
  const mast = new THREE.CylinderGeometry(0.28, 0.42, 11, 6).rotateX(Math.PI / 2).translate(0, 0, 5.5);
  const tip = new THREE.CylinderGeometry(0.1, 0.16, 4, 5).rotateX(Math.PI / 2).translate(0, 0, 13);
  return mergeGeoms([mast, tip]);
}

// ---------------------------------------------------------------- roof parts
//
// SEVEN THINGS EVER REACHED A ROOF, and roofs are 9.5% of the frame — a bigger
// surface than the walls. A real roof is a machine deck: the thing that gets
// you onto it, the thing that lifts you to it, the plant that keeps the
// building alive, and a rail round the edge so nobody falls off. None of that
// was there, so every roof in the city was a bare plane with a tank and two
// boxes on it.
//
// Each one is placed by the rule the real one obeys — a lift overrun only
// exists where there is a lift, a cooling tower only where there is a chiller,
// PV only after somebody was selling it — so the parts on a roof tell you what
// KIND of building you are looking at and roughly when it was last touched.

// ---------------------------------------------------------------------------
// FITTING THE KIT TO THE ROOF IT IS STANDING ON.
//
// Every one of these was placed at the roof's centroid plus a hash jitter of
// six to thirteen metres, and nothing anywhere asked how big the roof was. On
// a tower that is invisible. On a six-storey building with a sixteen-metre
// plate it is a disaster: a cooling tower whose own body is 4.6 m across,
// offset 6 m from the middle of an 8 m half-width, hangs bodily over the
// parapet — and seen from the air, a box hanging off a tall building's edge
// reads as an object FLOATING above the lower roof next door, which is exactly
// what a playtester photographed. The same arithmetic let parts sit inside one
// another, because nothing knew where anything else had been put.
//
// So placement stops being a jitter and becomes a fit. Three rules, all of
// them the ones a real roof obeys:
//
//   1. Everything stands INSIDE the parapet, with a walkway round it. A part
//      is only placed where its own footprint clears every edge of the roof
//      polygon by its radius plus a metre of access.
//   2. Nothing stands inside anything else.
//   3. A small roof holds a small kit. Plant goes on a roof in order of how
//      necessary it is — the way out first, then the lift, then the plant that
//      makes the building work — and when the deck runs out of room the rest
//      of the list simply is not there, which is also what happens in life.
//
// The tall buildings are untouched by all of this: their decks are big enough
// that every part still fits and the budget never binds.

/** Half-footprint radius of each roof prop, metres. Measured off the geometry. */
const PROP_R: Record<number, number> = {
  0: 2.2,   // timber water tower
  1: 1.4,   // condenser unit
  2: 2.9,   // plant housing
  3: 4.2,   // dish pad
  4: 1.2,   // mast
  6: 3.4,   // sawtooth monitor — a 6.5 m box, so the half-diagonal
  13: 2.4,  // stair bulkhead
  14: 2.6,  // lift overrun
  15: 2.8,  // cooling tower
  16: 1.8,  // pressure tank
  17: 2.2,  // standby generator
  18: 3.3,  // ribbon skylight
  19: 4.4,  // PV rank — four rows at 2.1 m centres is 8.4 m deep
  20: 3.6,  // guardrail run
  21: 1.1,  // chimney pots
  22: 2.2,  // works smokestack — the base, not the shaft
  23: 1.7,  // cupola
  24: 1.6,  // spire finial
  25: 3.9,  // dome on its drum
  26: 3.2,  // clock stage
  27: 2.5,  // steeple
  28: 3.3,  // pergola
  29: 3.0,  // planter run
  30: 5.5,  // helipad — the deck is 10.8 m across
  31: 3.6,  // greenhouse
  32: 3.1,  // ventilator row
  33: 0.7,  // flagpole
  34: 2.2,  // lattice mast
  35: 3.6,  // dish farm
  36: 4.4,  // davit track
  37: 4.6,  // roof sign
  38: 2.6,  // tank on a steel tower
  39: 0.8,  // parapet urn
  40: 0.9,  // dormer — placed on the slope, not through the deck kit
  41: 0.9,  // round-headed dormer
};

/** A metre of walkway between anything and the parapet. Code, and it reads. */
const ROOF_MARGIN = 1.15;

function ringArea2D(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}

function pointInRing(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** How far the nearest parapet is. Negative outside, so one test covers both. */
function edgeClearance(px: number, py: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const dx = xj - xi, dy = yj - yi;
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / len2));
    const cx = xi + t * dx, cy = yi + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) best = d;
  }
  return pointInRing(px, py, ring) ? best : -best;
}

export interface RoofWant { kind: number; s?: number; rot?: number; keep?: boolean }
export interface RoofPlaced { kind: number; x: number; y: number; z: number; s: number; rot: number }

/**
 * Lay a roof kit out on an actual polygon. `wants` is in priority order — what
 * a building cannot fit, it does not get. `rnd(i)` must be deterministic for
 * the building so the deck is the same every time the tile is rebuilt.
 * A want marked `keep` is exempt from the count budget (a mast on a 95 m tower
 * is the silhouette, not clutter) but still has to fit inside the parapet.
 * `hgt` is how tall the building under the deck is: it decides how much plant
 * the building is entitled to, before the plate decides how much of it fits.
 */
function fitRoofKit(
  ring: [number, number][], z: number, wants: RoofWant[], rnd: (i: number) => number,
  hgt: number,
): RoofPlaced[] {
  const out: RoofPlaced[] = [];
  if (ring.length < 3) return out;
  const area = ringArea2D(ring);
  // HOW MUCH PLANT A DECK CAN CARRY, AND HOW BIG IT IS.
  //
  // The first cut of this budget was written against a tower and then applied
  // to a city that has almost none. Measured over New Alden and Kestrel Point,
  // 1,383 flat roofs stand more than 12 m off their own base, and their plates
  // run 220 m² at the lower quartile, 291 m² — 3,130 sq ft — at the median and
  // 586 m² at the ninth decile. EIGHTY-NINE PER CENT OF THIS CITY'S FLAT ROOFS
  // ARE UNDER 560 m². The old steps gave the median roof two pieces of plant
  // and the quartile roof two as well, so half the town wore a stair bulkhead
  // AND a lift overrun on a plate twelve metres across. That is the pile the
  // complaint is about, and it is the ordinary building, not the exception.
  //
  // These steps are a real building's. Nothing under 130 m² (1,400 sq ft) — a
  // plate that size is a stair, a hatch and nowhere to stand, and it is 2.3%
  // of the stock. One thing to 280 m² (3,000 sq ft), which is the ordinary
  // 25 x 100 lot and 47% of the stock. Two to 560 m². The full machine deck
  // only past 1,000 m², which in this town means a department store, a
  // warehouse or a tower's podium — 3.4% of roofs, and they can carry it.
  const areaCap = area < 130 ? 0 : area < 280 ? 1 : area < 560 ? 2
    : area < 1000 ? 3 : area < 1800 ? 4 : area < 2800 ? 5 : 6;
  // Stature is the other half of it, because the plate is not the only thing
  // that decides: a four-storey walk-up has no central plant however wide its
  // roof is — what stands on one is the way out and a condenser — while the
  // same plate under forty metres of building is somebody's machine deck.
  const statureCap = hgt < 16 ? 2 : hgt < 26 ? 3 : hgt < 45 ? 4 : 6;
  const budget = Math.min(areaCap, statureCap);
  // And the SIZE, which is the half that actually reads wrong: a catalogue
  // cooling tower is 4.4 m across, and on a 25-foot roof that is more than
  // half the width of the building. Size runs off sqrt(area) — a length, so a
  // plate four times bigger takes parts twice as big — reaching catalogue size
  // at 1,100 m² and stopping at 0.62, which is a 2.0 m stair bulkhead. Below
  // that you could not get a stair inside it and it stops reading as a
  // building part at all.
  const sizeK = Math.max(0.62, Math.min(1, Math.sqrt(area / 1100)));
  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
  for (const [x, y] of ring) {
    if (x < xlo) xlo = x; if (x > xhi) xhi = x;
    if (y < ylo) ylo = y; if (y > yhi) yhi = y;
  }
  // WHAT A PART COSTS A DECK IS ITS FOOTPRINT, NOT ITS EXISTENCE.
  //
  // The budget above is right about how much plant a small roof carries and it
  // was spending one unit per PART, so a flagpole 1.4 m across and a rank of PV
  // 8.8 m across made the identical claim on the plate. That is fine while
  // every part is a box of plant and wrong the moment the list also contains
  // ornament: the small things all sit late in the list, behind the plant that
  // has to be there, and they lost every time. Measured, that left the whole
  // city with three flagpoles and two ventilator rows.
  //
  // Cost is the part's own plan area against a 2.4 m reference radius — the
  // stair bulkhead, which still costs exactly 1 and keeps the steps above
  // calibrated where they were measured. Floored at a quarter, because nothing
  // is entirely free, and capped at three so one enormous part cannot eat a
  // deck that could physically hold it.
  //
  // It reads the part's CATALOGUE radius and its requested scale, NOT the size
  // it ends up drawn at. sizeK below shrinks everything on a small plate so a
  // catalogue cooling tower does not span a 25-foot roof — that is a drawing
  // decision, and charging against it would mean a small roof could afford
  // MORE parts precisely because they had been shrunk to fit. Measured, that
  // mistake put six pieces of plant on the median 291 m² roof, which is the
  // exact pile the budget was written to stop.
  const deckCost = (w: RoofWant) => {
    const r = (PROP_R[w.kind] ?? 2) * (w.s ?? 1);
    return Math.max(0.25, Math.min(3, (r * r) / (2.4 * 2.4)));
  };
  let spent = 0;
  let seq = 0;
  for (const w of wants) {
    if (!w.keep && spent >= budget) continue;
    const baseS = (w.s ?? 1) * sizeK;
    let placed = false;
    // Try it at full size, then a little smaller, before giving up on it.
    for (let attempt = 0; attempt < 3 && !placed; attempt++) {
      const s = baseS * (1 - attempt * 0.14);
      const r = (PROP_R[w.kind] ?? 2) * s;
      for (let i = 0; i < 14; i++) {
        const px = xlo + (xhi - xlo) * rnd(seq * 97 + i * 2 + 1);
        const py = ylo + (yhi - ylo) * rnd(seq * 97 + i * 2 + 2);
        if (edgeClearance(px, py, ring) < r + ROOF_MARGIN) continue;
        let clash = false;
        for (const p of out) {
          if (Math.hypot(px - p.x, py - p.y) < r + (PROP_R[p.kind] ?? 2) * p.s + 0.7) { clash = true; break; }
        }
        if (clash) continue;
        out.push({ kind: w.kind, x: px, y: py, z, s, rot: w.rot ?? 0 });
        placed = true;
        if (!w.keep) spent += deckCost(w);
        break;
      }
    }
    seq++;
  }
  return out;
}

/** The stair bulkhead: the door out onto the roof, with a hood over it. */
function bulkheadGeom(): THREE.BufferGeometry {
  const box = new THREE.BoxGeometry(3.2, 2.6, 2.7).translate(0, 0, 1.35);
  const hood = new THREE.BoxGeometry(3.7, 3.1, 0.26).translate(0, 0, 2.82);
  const door = new THREE.BoxGeometry(0.12, 1.0, 2.0).translate(1.62, 0, 1.0);
  return mergeGeoms([box, hood, door]);
}

/** The lift overrun: taller than the bulkhead, and it always has a vent. */
function overrunGeom(): THREE.BufferGeometry {
  const shaft = new THREE.BoxGeometry(3.6, 3.0, 4.4).translate(0, 0, 2.2);
  const cap = new THREE.BoxGeometry(4.0, 3.4, 0.3).translate(0, 0, 4.55);
  const vent = new THREE.BoxGeometry(0.9, 0.9, 0.7).translate(0.9, 0, 5.05);
  return mergeGeoms([shaft, cap, vent]);
}

/** Open-cell cooling tower: louvred body, fan deck, and the stack over it. */
function coolingTowerGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.BoxGeometry(4.4, 3.2, 2.5).translate(0, 0, 1.25));
  for (let i = 0; i < 4; i++) parts.push(new THREE.BoxGeometry(4.6, 0.14, 0.26).translate(0, -1.6, 0.5 + i * 0.5));
  parts.push(new THREE.CylinderGeometry(1.5, 1.7, 1.5, 12).rotateX(Math.PI / 2).translate(0, 0, 3.25));
  parts.push(new THREE.CylinderGeometry(1.55, 1.55, 0.18, 12).rotateX(Math.PI / 2).translate(0, 0, 4.09));
  for (const l of [[-1.9, -1.3], [1.9, -1.3], [-1.9, 1.3], [1.9, 1.3]])
    parts.push(new THREE.BoxGeometry(0.22, 0.22, 0.55).translate(l[0], l[1], 0.27));
  return mergeGeoms(parts);
}

/** The steel pressure tank — the timber tank's post-war replacement, on legs. */
function pressureTankGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(1.5, 1.5, 4.2, 14).rotateX(Math.PI / 2).translate(0, 0, 4.4));
  parts.push(new THREE.SphereGeometry(1.5, 12, 6).scale(1, 1, 0.55).translate(0, 0, 6.5));
  for (const a of [0, 1, 2, 3]) {
    const th = (a / 4) * Math.PI * 2 + 0.4;
    parts.push(new THREE.BoxGeometry(0.2, 0.2, 2.4).translate(Math.cos(th) * 1.2, Math.sin(th) * 1.2, 1.2));
  }
  return mergeGeoms(parts);
}

/** Standby generator in its weather housing, with the exhaust stack beside it. */
function generatorGeom(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(3.8, 1.9, 1.9).translate(0, 0, 0.95);
  const stack = new THREE.CylinderGeometry(0.24, 0.28, 3.4, 8).rotateX(Math.PI / 2).translate(1.6, 0, 2.6);
  const cap = new THREE.CylinderGeometry(0.34, 0.34, 0.14, 8).rotateX(Math.PI / 2).translate(1.6, 0, 4.35);
  return mergeGeoms([body, stack, cap]);
}

/** A ribbon skylight — a low glazed hump running the length of a bay. */
function skylightGeom(): THREE.BufferGeometry {
  const kerb = new THREE.BoxGeometry(6.4, 1.9, 0.34).translate(0, 0, 0.17);
  const glass = new THREE.CylinderGeometry(1.05, 1.05, 6.2, 8, 1, false, Math.PI, Math.PI)
    .rotateZ(Math.PI / 2).translate(0, 0, 0.34);
  return mergeGeoms([kerb, glass]);
}

/** A rank of photovoltaic panels on tilted rails. Modern roofs only. */
function pvRowGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(new THREE.BoxGeometry(3.0, 1.5, 0.09).rotateX(-0.42).translate(0, i * 2.1 - 3.15, 0.62));
    parts.push(new THREE.BoxGeometry(0.09, 0.09, 0.62).translate(-1.3, i * 2.1 - 3.15, 0.31));
    parts.push(new THREE.BoxGeometry(0.09, 0.09, 0.62).translate(1.3, i * 2.1 - 3.15, 0.31));
  }
  return mergeGeoms(parts);
}

/**
 * The guardrail. Set back from the parapet the way the code says, and the one
 * roof part that is nearly all EDGE — which is why it reads at a distance no
 * box does: a long horizontal line floating above the deck is unmistakably a
 * roof even when the roof itself is nine pixels of flat colour.
 */
function guardrailGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.BoxGeometry(7.0, 0.07, 0.07).translate(0, 0, 1.05));
  parts.push(new THREE.BoxGeometry(7.0, 0.06, 0.06).translate(0, 0, 0.55));
  for (let i = 0; i < 5; i++) parts.push(new THREE.BoxGeometry(0.07, 0.07, 1.05).translate(i * 1.75 - 3.5, 0, 0.52));
  return mergeGeoms(parts);
}

// ---------------------------------------------------------------------------
// THE THINGS THAT MAKE A ROOFSCAPE, AS OPPOSED TO A MACHINE DECK.
//
// The kit above is what keeps a building running: the way out, the lift, the
// plant, a rail so nobody falls off. It is correct and it is completely
// characterless, because none of it is what you actually look at from the air.
// What you look at is the spire, the dome, the clock, the chimneys, the water
// tank on its steel tower — the objects that give a skyline its LANDMARKS and
// tell you which way you are facing.
//
// Every one of these obeys the same rule as the plant does: it is placed where
// the real one would be. A steeple stands on a church, a smokestack on a
// nineteenth-century works, a helipad on a tower late enough and tall enough to
// have wanted one, chimney pots on a house with fireplaces in it.

/** Domestic chimney pots — a brick stack with three pots on it. */
function chimneyPotsGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(1.9, 0.85, 1.7).translate(0, 0, 0.85)];
  for (let i = 0; i < 3; i++) {
    parts.push(new THREE.CylinderGeometry(0.19, 0.22, 0.62, 7).rotateX(Math.PI / 2).translate(i * 0.58 - 0.58, 0, 2.0));
  }
  return mergeGeoms(parts);
}

/** The works chimney: tapered brick, a corbelled cap, and the iron bands. */
function smokestackGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(3.0, 3.0, 1.1).translate(0, 0, 0.55),
    new THREE.CylinderGeometry(0.78, 1.35, 15.5, 12).rotateX(Math.PI / 2).translate(0, 0, 8.85),
    new THREE.CylinderGeometry(1.0, 0.92, 0.9, 12).rotateX(Math.PI / 2).translate(0, 0, 17.0),
  ];
  for (let i = 0; i < 3; i++) {
    parts.push(new THREE.TorusGeometry(0.98 - i * 0.05, 0.055, 4, 12).translate(0, 0, 5.2 + i * 3.6));
  }
  return mergeGeoms(parts);
}

/** An octagonal cupola: open drum on posts, a little dome, a finial. */
function cupolaGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(1.5, 1.6, 0.35, 8).rotateX(Math.PI / 2).translate(0, 0, 0.17),
  ];
  for (let i = 0; i < 8; i++) {
    const th = (i / 8) * Math.PI * 2;
    parts.push(new THREE.BoxGeometry(0.17, 0.17, 1.9).translate(Math.cos(th) * 1.25, Math.sin(th) * 1.25, 1.3));
  }
  parts.push(new THREE.CylinderGeometry(1.6, 1.5, 0.24, 8).rotateX(Math.PI / 2).translate(0, 0, 2.36));
  parts.push(new THREE.SphereGeometry(1.42, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1, 0.85).translate(0, 0, 2.45));
  parts.push(new THREE.CylinderGeometry(0.05, 0.09, 1.5, 6).rotateX(Math.PI / 2).translate(0, 0, 4.0));
  parts.push(new THREE.SphereGeometry(0.2, 8, 6).translate(0, 0, 3.75));
  return mergeGeoms(parts);
}

/** A finial spire: a square base and a long thin cone with a ball on it. */
function spireGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.BoxGeometry(2.1, 2.1, 1.5).translate(0, 0, 0.75),
    new THREE.ConeGeometry(1.25, 9.0, 8).rotateX(Math.PI / 2).translate(0, 0, 6.0),
    new THREE.SphereGeometry(0.28, 8, 6).translate(0, 0, 10.8),
    new THREE.CylinderGeometry(0.045, 0.06, 2.2, 5).rotateX(Math.PI / 2).translate(0, 0, 11.9),
  ]);
}

/** A dome on a drum, with a lantern — a bank, a courthouse, a capitol. */
function domeGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.CylinderGeometry(3.5, 3.6, 2.2, 16).rotateX(Math.PI / 2).translate(0, 0, 1.1),
    new THREE.CylinderGeometry(3.75, 3.75, 0.3, 16).rotateX(Math.PI / 2).translate(0, 0, 2.35),
    new THREE.SphereGeometry(3.4, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1, 1.1).translate(0, 0, 2.45),
    new THREE.CylinderGeometry(0.85, 0.95, 1.5, 10).rotateX(Math.PI / 2).translate(0, 0, 6.4),
    new THREE.SphereGeometry(0.8, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0, 7.1),
    new THREE.CylinderGeometry(0.05, 0.07, 1.4, 5).rotateX(Math.PI / 2).translate(0, 0, 8.3),
  ]);
}

/** A clock stage: a square lantern with a face on each side, under a pyramid. */
function clockTowerGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(4.4, 4.4, 0.4).translate(0, 0, 0.2),
    new THREE.BoxGeometry(3.8, 3.8, 4.2).translate(0, 0, 2.4),
    new THREE.BoxGeometry(4.5, 4.5, 0.35).translate(0, 0, 4.65),
    new THREE.ConeGeometry(3.3, 3.6, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).translate(0, 0, 6.6),
    new THREE.CylinderGeometry(0.04, 0.05, 1.6, 5).rotateX(Math.PI / 2).translate(0, 0, 9.0),
  ];
  // the four faces, standing just proud of the wall so they catch their own light
  for (let i = 0; i < 4; i++) {
    const th = (i / 4) * Math.PI * 2;
    parts.push(new THREE.CylinderGeometry(1.25, 1.25, 0.16, 14)
      .rotateZ(Math.PI / 2).rotateZ(th).translate(Math.cos(th) * 1.94, Math.sin(th) * 1.94, 2.6));
  }
  return mergeGeoms(parts);
}

/** A church steeple: an octagonal belfry and a tall broach spire over it. */
function steepleGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(3.4, 3.4, 2.6).translate(0, 0, 1.3),
    new THREE.CylinderGeometry(1.65, 1.85, 3.2, 8).rotateX(Math.PI / 2).translate(0, 0, 4.2),
  ];
  for (let i = 0; i < 4; i++) {
    const th = (i / 4) * Math.PI * 2 + Math.PI / 8;
    parts.push(new THREE.BoxGeometry(0.5, 0.16, 1.9).rotateZ(th).translate(Math.cos(th) * 1.6, Math.sin(th) * 1.6, 4.3));
  }
  parts.push(new THREE.ConeGeometry(1.9, 9.5, 8).rotateX(Math.PI / 2).translate(0, 0, 10.6));
  parts.push(new THREE.CylinderGeometry(0.04, 0.055, 1.9, 5).rotateX(Math.PI / 2).translate(0, 0, 16.2));
  return mergeGeoms(parts);
}

/** A pergola over a roof terrace: posts, beams, and slats across them. */
function pergolaGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y] of [[-2.6, -1.7], [2.6, -1.7], [-2.6, 1.7], [2.6, 1.7]]) {
    parts.push(new THREE.BoxGeometry(0.16, 0.16, 2.5).translate(x, y, 1.25));
  }
  parts.push(new THREE.BoxGeometry(5.6, 0.14, 0.2).translate(0, -1.7, 2.55));
  parts.push(new THREE.BoxGeometry(5.6, 0.14, 0.2).translate(0, 1.7, 2.55));
  for (let i = 0; i < 8; i++) parts.push(new THREE.BoxGeometry(0.1, 3.7, 0.13).translate(i * 0.72 - 2.52, 0, 2.68));
  return mergeGeoms(parts);
}

/** A run of roof planters, with the hedge in them. */
function planterRowGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(new THREE.BoxGeometry(1.5, 0.75, 0.55).translate(i * 1.7 - 2.55, 0, 0.27));
    parts.push(new THREE.SphereGeometry(0.52, 7, 5).scale(1.25, 0.75, 0.72).translate(i * 1.7 - 2.55, 0, 0.88));
  }
  return mergeGeoms(parts);
}

/** A helipad: the deck, its perimeter kerb, and the H. */
function helipadGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.CylinderGeometry(5.4, 5.4, 0.22, 22).rotateX(Math.PI / 2).translate(0, 0, 0.11),
    new THREE.TorusGeometry(4.9, 0.09, 4, 24).translate(0, 0, 0.25),
    new THREE.BoxGeometry(0.42, 3.0, 0.05).translate(-1.1, 0, 0.25),
    new THREE.BoxGeometry(0.42, 3.0, 0.05).translate(1.1, 0, 0.25),
    new THREE.BoxGeometry(2.2, 0.42, 0.05).translate(0, 0, 0.25),
  ];
  return mergeGeoms(parts);
}

/** A rooftop greenhouse: a low glazed gable on a kerb. */
function greenhouseGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(6.2, 3.4, 0.3).translate(0, 0, 0.15),
    new THREE.BoxGeometry(6.0, 3.2, 1.5).translate(0, 0, 1.05),
  ];
  parts.push(new THREE.BoxGeometry(6.0, 1.85, 0.14).rotateX(0.62).translate(0, -0.82, 2.16));
  parts.push(new THREE.BoxGeometry(6.0, 1.85, 0.14).rotateX(-0.62).translate(0, 0.82, 2.16));
  return mergeGeoms(parts);
}

/** A row of whirlybird ventilators on a shed roof. */
function ventTurbineGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const x = i * 1.85 - 2.77;
    parts.push(new THREE.CylinderGeometry(0.30, 0.34, 0.5, 8).rotateX(Math.PI / 2).translate(x, 0, 0.25));
    parts.push(new THREE.SphereGeometry(0.42, 9, 6).scale(1, 1, 0.78).translate(x, 0, 0.78));
  }
  return mergeGeoms(parts);
}

/** A flagpole, with the truck and a furled flag at the head. */
function flagpoleGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.CylinderGeometry(0.5, 0.62, 0.4, 10).rotateX(Math.PI / 2).translate(0, 0, 0.2),
    new THREE.CylinderGeometry(0.075, 0.13, 9.5, 7).rotateX(Math.PI / 2).translate(0, 0, 5.1),
    new THREE.SphereGeometry(0.17, 8, 6).translate(0, 0, 9.95),
    new THREE.BoxGeometry(0.05, 1.5, 0.9).translate(0, 0.78, 9.1),
  ]);
}

/** A lattice communications mast with crossarms and a beacon. */
function antennaArrayGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
    parts.push(new THREE.BoxGeometry(0.11, 0.11, 12.0).translate(x * 0.85, y * 0.85, 6.0));
  }
  for (let i = 0; i < 6; i++) {
    parts.push(new THREE.BoxGeometry(1.5, 1.5, 0.07).translate(0, 0, 1.4 + i * 1.9));
  }
  for (let i = 0; i < 3; i++) {
    const z = 6.2 + i * 2.1;
    parts.push(new THREE.BoxGeometry(4.0, 0.09, 0.09).translate(0, 0, z));
    parts.push(new THREE.BoxGeometry(0.16, 0.16, 1.0).translate(-1.85, 0, z + 0.5));
    parts.push(new THREE.BoxGeometry(0.16, 0.16, 1.0).translate(1.85, 0, z + 0.5));
  }
  parts.push(new THREE.SphereGeometry(0.24, 8, 6).translate(0, 0, 12.3));
  return mergeGeoms(parts);
}

/** Three satellite dishes on their frames, all looking the same way. */
function dishFarmGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const x = i * 2.4 - 2.4;
    parts.push(new THREE.BoxGeometry(1.1, 1.1, 0.22).translate(x, 0, 0.11));
    parts.push(new THREE.CylinderGeometry(0.13, 0.15, 1.2, 7).rotateX(Math.PI / 2).translate(x, 0, 0.8));
    parts.push(new THREE.SphereGeometry(1.0, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)
      .scale(1, 1, 0.42).rotateX(-0.85).translate(x, 0, 1.7));
  }
  return mergeGeoms(parts);
}

/** The window-washing rig: a track along the parapet and the davit on it. */
function davitGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.BoxGeometry(8.5, 0.2, 0.16).translate(0, 0, 0.08),
    new THREE.BoxGeometry(1.5, 1.1, 0.55).translate(0, 0, 0.44),
    new THREE.BoxGeometry(0.16, 0.16, 2.4).translate(0, 0, 1.9),
    new THREE.BoxGeometry(0.14, 2.6, 0.14).translate(0, -1.1, 3.05),
    new THREE.BoxGeometry(0.9, 0.5, 0.35).translate(0, -2.2, 2.7),
  ]);
}

/** Rooftop sign letters on their steel frame, facing the long way. */
function roofSignGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(9.0, 0.18, 2.3).translate(0, 0, 2.6),
  ];
  for (let i = 0; i < 4; i++) {
    parts.push(new THREE.BoxGeometry(0.14, 0.14, 1.6).translate(i * 2.6 - 3.9, 0, 0.8));
    parts.push(new THREE.BoxGeometry(0.12, 1.3, 0.12).rotateX(0.7).translate(i * 2.6 - 3.9, 0.5, 1.2));
  }
  return mergeGeoms(parts);
}

/** The steel water tank on its tower, with the ladder cage up one leg. */
function tankTowerGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
    parts.push(new THREE.BoxGeometry(0.19, 0.19, 6.2).translate(x, y, 3.1));
  }
  for (let i = 0; i < 2; i++) {
    parts.push(new THREE.BoxGeometry(3.2, 0.1, 0.1).translate(0, -1.5, 2.0 + i * 2.2));
    parts.push(new THREE.BoxGeometry(3.2, 0.1, 0.1).translate(0, 1.5, 2.0 + i * 2.2));
  }
  parts.push(new THREE.CylinderGeometry(2.3, 2.3, 3.4, 14).rotateX(Math.PI / 2).translate(0, 0, 7.9));
  parts.push(new THREE.ConeGeometry(2.45, 1.3, 14).rotateX(Math.PI / 2).translate(0, 0, 10.2));
  parts.push(new THREE.TorusGeometry(0.42, 0.05, 4, 8).rotateY(Math.PI / 2).translate(1.5, -1.5, 4.4));
  return mergeGeoms(parts);
}

/**
 * A DORMER, which is the thing a mansard is FOR.
 *
 * A mansard roof exists so the top storey is a habitable room rather than a
 * void, and the only way that room gets light is a dormer punched through the
 * slope. A mansard without them is not a roof shape, it is a hat — and every
 * mansard and hip in this city was wearing one.
 *
 * Gabled, with cheeks and a little pitched hood, facing outward along +X.
 */
function dormerGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.BoxGeometry(1.30, 1.40, 1.60).translate(0.22, 0, 0.80),
    new THREE.ConeGeometry(1.12, 0.80, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).translate(0.22, 0, 1.98),
    new THREE.BoxGeometry(0.10, 1.55, 0.14).translate(0.86, 0, 1.62),   // the hood's drip
  ]);
}

/** The round-headed dormer of a good Second Empire roof: a drum with a hood. */
function dormerRoundGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.BoxGeometry(1.20, 1.30, 1.25).translate(0.20, 0, 0.62),
    new THREE.CylinderGeometry(0.65, 0.65, 1.20, 10, 1, false, 0, Math.PI)
      .rotateZ(-Math.PI / 2).rotateX(Math.PI / 2).translate(0.20, 0, 1.25),
    new THREE.SphereGeometry(0.72, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1, 0.7).translate(0.20, 0, 1.24),
  ]);
}

/** A parapet urn on its plinth — the cornice-level ornament of a good address. */
function urnGeom(): THREE.BufferGeometry {
  return mergeGeoms([
    new THREE.BoxGeometry(1.0, 1.0, 0.55).translate(0, 0, 0.27),
    new THREE.CylinderGeometry(0.30, 0.42, 0.35, 10).rotateX(Math.PI / 2).translate(0, 0, 0.72),
    new THREE.SphereGeometry(0.52, 10, 7).scale(1, 1, 1.25).translate(0, 0, 1.36),
    new THREE.CylinderGeometry(0.44, 0.30, 0.30, 10).rotateX(Math.PI / 2).translate(0, 0, 2.05),
  ]);
}

// ===========================================================================
// TEN TOWERS.
//
// Everything over twenty storeys in this game was one of five shapes: a prism,
// a prism on a podium, a prism with a setback, a prism with two setbacks, and a
// slender prism on a podium. All five are the same operation — scale the plate
// toward its own centre and stack it — which is the 1916 sky-exposure plane and
// nothing since. A city whose newest tower is a 1961 move does not look like a
// city anybody is building in now.
//
// What has actually gone up in New York in the last decade does four things
// that stack-and-shrink cannot express: it ROTATES the plate, it OFFSETS it,
// it CUTS the corners off at an angle, and it lets the top oversail the shaft.
// These ten are those moves, each taken from a building that exists.
//
// The kit below is four plate operations. Every family is a short recipe in
// them, which is also how the real ones were drawn.

type Plate = [number, number][];

/** Scale a plate about a point. */
/**
 * NOTHING IS BUILT ON THE NEIGHBOUR'S LAND.
 *
 * The tower recipes jog, rotate and splay off their base plate, and none of
 * them knows where the deed ends: `stack` steps sideways, `twist` rotates each
 * tier, `carve` cuts a notch and pushes the remainder out. On a plate that is a
 * modest fraction of a generous lot that is harmless, and at the top of the
 * coverage dial it is not. Measured with the real function over 62,568
 * readings, share of tier-0 vertices lying outside the parcel at the 90% mark:
 * `twist` 100%, `stack` 60%, `carve` 40%, `blade` 25% — 16,242 readings in all,
 * every one of them a building overhanging somebody else's dirt.
 *
 * The clip is RADIAL rather than a polygon intersection, deliberately. A true
 * boolean clip would cut corners off and leave the silhouette a different shape
 * than the family intended — the tower would stop being a twist or a blade at
 * exactly the sizes where it is most visible. Pulling each vertex back along
 * its own ray from the centre keeps every angle and every proportion and only
 * shortens the reach, which is what a setback does in life: the building keeps
 * its shape and loses the part that was never yours.
 */
export const plClipToLot = (r: Plate, lot: Plate, cx: number, cy: number): Plate => {
  if (!lot || lot.length < 3) return r;
  // How far the deed reaches in a given direction, from the centre.
  const reach = (dx: number, dy: number): number => {
    let best = Infinity;
    for (let i = 0, j = lot.length - 1; i < lot.length; j = i++) {
      const [x1, y1] = lot[j], [x2, y2] = lot[i];
      const ex = x2 - x1, ey = y2 - y1;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;                  // parallel
      const t = ((x1 - cx) * ey - (y1 - cy) * ex) / den;     // along the ray
      const u = ((x1 - cx) * dy - (y1 - cy) * dx) / den;     // along the edge
      if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
    }
    return best;
  };
  return r.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return [x, y] as [number, number];
    const lim = reach(dx / d, dy / d);
    // A hair inside the line: a wall exactly on the boundary z-fights the
    // pavement and reads as a building with no setback at all.
    const max = Number.isFinite(lim) ? lim * 0.985 : d;
    return (d <= max ? [x, y] : [cx + (dx / d) * max, cy + (dy / d) * max]) as [number, number];
  });
};

const plScale = (r: Plate, cx: number, cy: number, f: number): Plate =>
  r.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]);

/** Scale a plate differently along two perpendicular axes — how a slab gets slender. */
const plScaleAxis = (r: Plate, cx: number, cy: number, ang: number, fA: number, fB: number): Plate => {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return r.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const a = (dx * ca + dy * sa) * fA;      // along
    const b = (-dx * sa + dy * ca) * fB;     // across
    return [cx + a * ca - b * sa, cy + a * sa + b * ca];
  });
};

/** Rotate a plate about a point. */
const plRot = (r: Plate, cx: number, cy: number, a: number): Plate => {
  const c = Math.cos(a), s = Math.sin(a);
  return r.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
};

/** Slide a plate sideways. */
const plMove = (r: Plate, dx: number, dy: number): Plate => r.map(([x, y]) => [x + dx, y + dy]);

/**
 * Cut every corner off at `cut` metres. The chamfer is the single most
 * characteristic move of the current generation — One Vanderbilt is a box
 * whose corners have been taken off four times on the way up — and it is what
 * stops a tower reading as a rectangle from every angle at once.
 */
const plChamfer = (r: Plate, cut: number): Plate => {
  const n = r.length;
  if (n < 3 || cut <= 0.01) return r;
  const out: Plate = [];
  for (let i = 0; i < n; i++) {
    const p = r[i], a = r[(i - 1 + n) % n], b = r[(i + 1) % n];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    const ka = Math.min(cut, la * 0.45) / la, kb = Math.min(cut, lb * 0.45) / lb;
    out.push([p[0] + (a[0] - p[0]) * ka, p[1] + (a[1] - p[1]) * ka]);
    out.push([p[0] + (b[0] - p[0]) * kb, p[1] + (b[1] - p[1]) * kb]);
  }
  return out;
};

/** Round the corners — Chaikin, twice, which is a soft radius on a convex plate. */
const plRound = (r: Plate, iters: number): Plate => {
  let cur = r;
  for (let k = 0; k < iters; k++) {
    const out: Plate = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i], q = cur[(i + 1) % cur.length];
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    cur = out;
  }
  return cur;
};

/** The long axis of a plate, for the families that need to know which way is which. */
const plAxis = (r: Plate): number => {
  let best = 0, bl = -1;
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > bl) { bl = l; best = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return best;
};

export interface TowerTier {
  fp: Plate; z0: number; z1: number;
  /** Overrides the building's wall style for this tier — steel shelves, a glass box on a stone base. */
  style?: number;
  /** Overrides the roof surface where this tier's top is a terrace rather than a cap. */
  roof?: number;
}

export const TOWER_FAMILIES = [
  "vanderbilt", "spiral", "exo", "stack", "carve",
  "blade", "shelf", "curveslab", "deepframe", "twist",
] as const;

/**
 * The shape of a tower, and the skin that goes with it.
 *
 * `h` is metres, `fl` floors, `fh` the floor height. `u(k)` is a stable hash in
 * [0,1) for this building. Returns null when the site cannot carry the family —
 * a spiral needs the height to turn through, a blade needs a plate long enough
 * to be slender ON — and the caller falls back to the ordinary stack.
 */
/**
 * WHICH SKIN A TOWER SHAPE CAN WEAR.
 *
 * Each family used to return ONE hardcoded style, so every spiral in every city
 * was the same unitised glass and every carve was the same crystal. Shape and
 * skin are related but they are not the same choice — a folded plan can be
 * pleated glass or shingled or photovoltaic, and a braced frame can be a fine
 * diagrid or one giant megabrace depending on how big the members are.
 *
 * This matters more here than anywhere else in the registry, because the
 * generator makes almost no modern towers — New Alden has four buildings over
 * ten floors — so essentially every tower a player ever sees comes through this
 * function. If it has ten answers, the skyline has ten buildings in it.
 */
const TOWER_SKINS: Record<string, number[]> = {
  vanderbilt: [S_TERRAPIER, S_TERRAPIER, S_CHEVRON, S_UNITGLASS, S_PMOD],
  spiral: [S_SKYGARDEN, S_SKYGARDEN, S_UNITGLASS, S_BALCONY, S_PLEATED],
  exo: [S_DIAGRID, S_MEGABRACE, S_MEGABRACE, S_DOUBLESKIN],
  stack: [S_CRYSTAL, S_MODULAR, S_UNITGLASS, S_SHINGLED, S_MEGAPANEL],
  carve: [S_CRYSTAL, S_PLEATED, S_CHEVRON, S_SHINGLED],
  blade: [S_TERRAPIER, S_TERRAPIER, S_UNITGLASS, S_PVCLAD, S_FRIT],
  shelf: [S_STEELSHELF, S_STEELSHELF, S_LABBLDG, S_DOUBLESKIN],
  curveslab: [S_UNITGLASS, S_SHINGLED, S_DOUBLESKIN, S_FRIT, S_MEDIAFACE],
  deepframe: [S_DEEPFRAME, S_DEEPFRAME, S_PRECAST, S_LABBLDG, S_PVCLAD],
  twist: [S_MEGAPANEL, S_PLEATED, S_CHEVRON, S_UNITGLASS, S_SHINGLED],
};

export function towerMassing(
  fam: string, ring: Plate, cx: number, cy: number, h: number, fl: number, fh: number,
  u: (k: number) => number,
): { tiers: TowerTier[]; style: number } | null {
  const ax = plAxis(ring);
  /**
   * THE COVERAGE DIAL DOES NOT REACH THE TOWER, AND THAT IS A KNOWN GAP.
   *
   * Every recipe below — the leg chamfer, the stack jog, the carve depth, the
   * blade offset — is a fraction of `span`, and all of them were written
   * against a plate fixed at 0.78 of the ring. Threading the player's coverage
   * in here was tried and reverted in the same session it was written, because
   * it detaches those offsets from the plate they move: measured with the real
   * function over 62,568 readings, `exo` drew 1.48x the promised plate and
   * `stack`, `twist`, `carve` and `blade` put between 25% and 100% of their
   * tier-0 vertices OUTSIDE THE PARCEL at the upper end of the dial. A building
   * standing on the neighbour's land is worse than one drawn the wrong size.
   *
   * Doing it properly means re-expressing all six span-derived constants
   * against `base` and re-checking every silhouette, not passing one argument.
   * `pnpm plate` measures it now and will fail the moment somebody tries, which
   * is the difference between a gap and a secret.
   */
  const B = 0.78;                                  // the base plate the old prism used
  const base = plScale(ring, cx, cy, B);
  let span = 0;
  for (const [x, y] of ring) span = Math.max(span, Math.hypot(x - cx, y - cy));
  const T: TowerTier[] = [];
  const at = (f: number) => h * f;
  /** Pick this family's skin, falling back to the one it was written for. */
  const skinFor = (name: string, dflt: number) => {
    const pool = TOWER_SKINS[name];
    if (!pool || !pool.length) return dflt;
    return pool[Math.min(pool.length - 1, Math.floor(u(90) * pool.length))];
  };

  switch (fam) {
    case "vanderbilt": {
      // ONE VANDERBILT. A box whose corners come off four times on the way up,
      // each cut deeper than the last, so the tower is an octagon by the time
      // it reaches the top and never shows you the same width twice.
      const n = 4;
      const cuts = [1.2, 2.8, 5.0, 7.8].map((c) => c * (0.8 + 0.5 * u(1)));
      const sc = [1.0, 0.90, 0.79, 0.66];
      const tops = [0.30, 0.56, 0.80, 1.0];
      let z = 0;
      for (let k = 0; k < n; k++) {
        T.push({ fp: plChamfer(plScale(base, cx, cy, sc[k]), cuts[k] * span * 0.10), z0: z, z1: at(tops[k]) });
        z = at(tops[k]);
      }
      return { tiers: T, style: skinFor(fam, S_TERRAPIER) };
    }
    case "spiral": {
      // THE SPIRAL. A planted terrace that climbs the building one corner at a
      // time — every tier is the last one rotated and pulled in slightly, so
      // the setback travels round the tower instead of ringing it.
      // a terrace every four floors or so, which is what the real one does
      const n = Math.max(5, Math.min(9, Math.round(h / (fh * 4))));
      if (h < 55) return null;
      const dir = u(2) < 0.5 ? 1 : -1;
      let z = 0;
      for (let k = 0; k < n; k++) {
        const f = 1 - k * (0.052 + 0.018 * u(3));
        const fp = plRot(plScale(base, cx, cy, f), cx, cy, dir * k * (0.10 + 0.05 * u(4)));
        const top = at((k + 1) / n);
        // every tier but the last has somebody's garden on it
        T.push({ fp, z0: z, z1: top, roof: k === n - 1 ? undefined : S_GREEN });
        z = top;
      }
      return { tiers: T, style: skinFor(fam, S_UNITGLASS) };
    }
    case "exo": {
      // 270 PARK. The tower does not reach the ground — it stands on splayed
      // braced legs, so the base is WIDER than the shaft and open under it.
      // The diagrid skin is the same structure carried on up the building.
      if (h < 60) return null;
      const legTop = at(0.10 + 0.03 * u(5));
      T.push({ fp: plChamfer(plScale(ring, cx, cy, 0.98), span * 0.22), z0: 0, z1: legTop, style: S_DIAGRID });
      T.push({ fp: plScale(base, cx, cy, 0.94), z0: legTop, z1: at(0.16), style: S_PLAIN });
      T.push({ fp: plScale(base, cx, cy, 0.80), z0: at(0.16), z1: h });
      return { tiers: T, style: skinFor(fam, S_DIAGRID) };
    }
    case "stack": {
      // STACKED AND SHIFTED. Three or four boxes that do not sit over each
      // other — every one gives a terrace on one side and an overhang on the
      // other, and the tower has a different profile from all four elevations.
      const n = 3 + (u(6) > 0.55 ? 1 : 0);
      let z = 0;
      for (let k = 0; k < n; k++) {
        const f = 1 - k * 0.09;
        const off = (u(7 + k) - 0.5) * span * 0.42;
        const oa = ax + (k % 2 ? Math.PI / 2 : 0);
        const fp = plRot(plMove(plScale(base, cx, cy, f), Math.cos(oa) * off, Math.sin(oa) * off),
          cx, cy, (u(11 + k) - 0.5) * 0.14);
        const top = at((k + 1) / n);
        T.push({ fp, z0: z, z1: top, roof: k === n - 1 ? undefined : S_GREEN });
        z = top;
      }
      return { tiers: T, style: skinFor(fam, S_CRYSTAL) };
    }
    case "carve": {
      // SOLAR CARVE. The mass has planes sliced off it at an angle — the cut
      // is deepest where it would otherwise shade its neighbour, which is
      // literally how 40 Tenth Avenue was shaped. Each stage takes its slice
      // from the opposite side of the one below.
      const n = 3;
      let z = 0;
      for (let k = 0; k < n; k++) {
        const side = k % 2 ? 1 : -1;
        const cut = span * (0.16 + 0.10 * u(15 + k));
        // chamfer, then push the plate off-centre so the cut reads as a slice
        const fp = plMove(plChamfer(plScale(base, cx, cy, 1 - k * 0.10), cut),
          Math.cos(ax + Math.PI / 2) * side * cut * 0.42,
          Math.sin(ax + Math.PI / 2) * side * cut * 0.42);
        const top = at((k + 1) / n);
        T.push({ fp, z0: z, z1: top });
        z = top;
      }
      return { tiers: T, style: skinFor(fam, S_CRYSTAL) };
    }
    case "blade": {
      // 111 WEST 57TH. Hyper-slender: the plate is squeezed across its short
      // axis until the tower is a blade, and the setbacks feather up ONE face
      // in small steps rather than stepping all four. It ends as a wall.
      if (fl < 26) return null;
      const n = 7;
      let z = 0;
      for (let k = 0; k < n; k++) {
        const fA = 1 - k * 0.012;                     // barely narrows the long way
        const fB = 0.62 - k * 0.055;                  // and closes hard the short way
        if (fB < 0.14) break;
        const fp = plMove(plScaleAxis(base, cx, cy, ax, fA, fB),
          Math.cos(ax + Math.PI / 2) * span * 0.02 * k,
          Math.sin(ax + Math.PI / 2) * span * 0.02 * k);
        const top = at((k + 1) / n);
        T.push({ fp, z0: z, z1: top });
        z = top;
      }
      return T.length >= 3 ? { tiers: T, style: skinFor(fam, S_TERRAPIER) } : null;
    }
    case "shelf": {
      // 425 PARK. Three stacked volumes with the steel expressed BETWEEN them:
      // a shallow plate standing proud at each junction, which reads as a
      // shelf the whole width of the building.
      if (h < 55) return null;
      const cuts = [0.34, 0.66, 1.0];
      const sc = [1.0, 0.86, 0.70];
      let z = 0;
      for (let k = 0; k < 3; k++) {
        const fp = plScale(base, cx, cy, sc[k]);
        const top = at(cuts[k]);
        T.push({ fp, z0: z, z1: top - (k < 2 ? 1.4 : 0) });
        if (k < 2) {
          // the shelf itself: wider than both volumes, and made of steel
          T.push({ fp: plScale(base, cx, cy, sc[k]), z0: top - 1.4, z1: top, style: S_PLAIN });
        }
        z = top;
      }
      return { tiers: T, style: skinFor(fam, S_STEELSHELF) };
    }
    case "curveslab": {
      // ONE MANHATTAN WEST. Corners rounded rather than cut, and the top
      // sliced on a slope — a soft-edged slab, which at this size is a
      // completely different object from a sharp one.
      const r0 = plRound(base, 2);
      const cut = at(0.86 + 0.06 * u(19));
      T.push({ fp: r0, z0: 0, z1: cut });
      // the sloped crown, drawn as two shallow oversailing stages
      T.push({ fp: plMove(plScale(r0, cx, cy, 0.90), Math.cos(ax) * span * 0.030, Math.sin(ax) * span * 0.030), z0: cut, z1: at(0.95) });
      T.push({ fp: plMove(plScale(r0, cx, cy, 0.74), Math.cos(ax) * span * 0.055, Math.sin(ax) * span * 0.055), z0: at(0.95), z1: h });
      return { tiers: T, style: skinFor(fam, S_UNITGLASS) };
    }
    case "deepframe": {
      // 55 HUDSON YARDS. Almost no taper at all — the interest is entirely in
      // the wall, which is a half-metre-deep grid. One notch is taken out of a
      // corner for the whole height so the mass is not a plain box.
      const notch = plChamfer(base, span * 0.30);
      T.push({ fp: notch, z0: 0, z1: at(0.92) });
      T.push({ fp: plScale(notch, cx, cy, 0.965), z0: at(0.92), z1: h, style: S_PLAIN });
      return { tiers: T, style: skinFor(fam, S_DEEPFRAME) };
    }
    case "twist": {
      // THE TWIST. Every floor turns a degree or two on the one below, so the
      // corners run up the building as slow helices and the silhouette changes
      // as you walk round it. Drawn as a stack thin enough that the steps read
      // as a curve.
      if (fl < 22) return null;
      const n = Math.max(9, Math.min(16, Math.round(fl / 2.5)));
      const total = (0.42 + 0.30 * u(21)) * (u(22) < 0.5 ? 1 : -1);
      let z = 0;
      for (let k = 0; k < n; k++) {
        const t = (k + 1) / n;
        const fp = plRot(plScale(base, cx, cy, 1 - t * 0.16), cx, cy, total * (k / n));
        const top = at(t);
        T.push({ fp, z0: z, z1: top });
        z = top;
      }
      return { tiers: T, style: skinFor(fam, S_MEGAPANEL) };
    }
    default: return null;
  }
}

function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], norm: number[] = [];
  for (const g of geoms) {
    const ng = g.toNonIndexed();
    pos.push(...Array.from(ng.getAttribute("position").array as Float32Array));
    norm.push(...Array.from(ng.getAttribute("normal").array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(norm, 3));
  return out;
}

// ---------------------------------------------------------------------------
// PARK MONUMENTS
// ---------------------------------------------------------------------------
//
// The generator already lays these parks out like parks: a perimeter
// promenade, an allée of paired trees along it, cross paths driven
// corner-to-corner, corner groves, and a lawn deliberately kept open in the
// middle. Every one of those cross paths converges on a point — and that point
// had nothing on it.
//
// That is not a small omission, it is the omission. A nineteenth-century civic
// park is ORGANISED around its monument: the walks exist to arrive at it, and
// without one they are four paths meeting in the grass for no stated reason.
// It is also the only vertical thing in a hundred metres of flat lawn, which
// makes it the one element giving the Common a middle to read against.
//
// Kept to the prop path — instanced geometry, flat colour, the same light rig
// as a bench — because a monument is street furniture at civic scale, not a
// building, and it has no business in the massing pipeline.

/** Stepped plinth and tapered shaft, ~13 m. Z-up, like every prop here. */
function monumentGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // three-step base: a monument is approached, so it stands on stairs
  parts.push(new THREE.BoxGeometry(5.2, 5.2, 0.34).translate(0, 0, 0.17));
  parts.push(new THREE.BoxGeometry(4.2, 4.2, 0.34).translate(0, 0, 0.51));
  parts.push(new THREE.BoxGeometry(3.3, 3.3, 0.40).translate(0, 0, 0.88));
  // the die: the block that carries the inscription
  parts.push(new THREE.BoxGeometry(2.3, 2.3, 2.15).translate(0, 0, 2.15));
  parts.push(new THREE.BoxGeometry(2.7, 2.7, 0.26).translate(0, 0, 3.35));
  // the shaft, tapered — a column that does not taper reads as a pipe
  parts.push(new THREE.CylinderGeometry(0.62, 0.86, 7.6, 12)
    .rotateX(Math.PI / 2).translate(0, 0, 7.28));
  // capital
  parts.push(new THREE.CylinderGeometry(0.98, 0.72, 0.52, 12)
    .rotateX(Math.PI / 2).translate(0, 0, 11.34));
  parts.push(new THREE.BoxGeometry(1.9, 1.9, 0.22).translate(0, 0, 11.71));
  return mergeGeoms(parts);
}

/** The figure on top, in bronze — separate so it takes its own colour. */
function monumentFigureGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.CylinderGeometry(0.30, 0.40, 0.42, 8)
    .rotateX(Math.PI / 2).translate(0, 0, 12.03));
  // a standing figure, read at fifty metres: legs, coat, shoulders, head
  parts.push(new THREE.BoxGeometry(0.42, 0.34, 1.02).translate(0, 0, 12.75));
  parts.push(new THREE.BoxGeometry(0.62, 0.42, 0.30).translate(0, 0, 13.38));
  parts.push(new THREE.CylinderGeometry(0.17, 0.17, 0.26, 7)
    .rotateX(Math.PI / 2).translate(0, 0, 13.66));
  return mergeGeoms(parts);
}

/** A basin with a coping you could sit on, ~7 m across. */
function fountainStoneGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // the coping ring, built as a wide short drum with the water disc dropped
  // into it — cheaper than a real annulus and identical at this distance
  parts.push(new THREE.CylinderGeometry(3.5, 3.6, 0.62, 20)
    .rotateX(Math.PI / 2).translate(0, 0, 0.31));
  // the tiered centre
  parts.push(new THREE.CylinderGeometry(0.72, 0.95, 0.55, 12)
    .rotateX(Math.PI / 2).translate(0, 0, 0.72));
  parts.push(new THREE.CylinderGeometry(1.15, 1.15, 0.14, 14)
    .rotateX(Math.PI / 2).translate(0, 0, 1.05));
  parts.push(new THREE.CylinderGeometry(0.30, 0.44, 0.85, 10)
    .rotateX(Math.PI / 2).translate(0, 0, 1.52));
  parts.push(new THREE.CylinderGeometry(0.62, 0.62, 0.11, 12)
    .rotateX(Math.PI / 2).translate(0, 0, 2.00));
  return mergeGeoms(parts);
}

/** The water in it, a disc set just below the coping. */
function fountainWaterGeom(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(3.34, 3.34, 0.04, 20)
    .rotateX(Math.PI / 2).translate(0, 0, 0.50);
}

/**
 * A clipped parterre hedge ringing a monument. Twelve low blocks on a circle
 * rather than a torus: a formal bed is planted in segments with the walks
 * between them, and at this scale the gaps are what say "clipped" rather than
 * "green doughnut".
 */
function parterreGeom(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const R = 5.6;
  const N = 20;
  for (let i = 0; i < N; i++) {
    // four gaps, on the compass points, where the cross paths come in
    if (i % 5 === 0) continue;
    const a = (i / N) * Math.PI * 2;
    // Long enough to close on its neighbour and tall enough to cast: at 12
    // sparse segments these read as blocks dropped on the grass rather than as
    // a clipped bed, which is the difference between planting and litter.
    parts.push(new THREE.BoxGeometry(1.90, 1.05, 0.80)
      .rotateZ(a + Math.PI / 2)
      .translate(Math.cos(a) * R, Math.sin(a) * R, 0.40));
  }
  return mergeGeoms(parts);
}
