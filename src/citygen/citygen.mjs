// CITYGEN — one generator, many cities.
//
// The rule this file exists to enforce: THE CITY HAS NO HOLES. Earlier maps
// defined each district as its own box of half-planes and hoped the boxes
// covered the land. They didn't, and every square metre they missed rendered
// as a beige void — land with no blocks, no streets, nothing.
//
// The fix is structural, not cosmetic. Districts are the LEAVES OF A BSP
// TREE: start with the whole plane, cut it with a line, cut each half again,
// and so on. Every leaf is convex (an intersection of half-planes) and the
// leaves partition the plane exactly — that is what a BSP is. Each district
// runs its own lattice across the whole plane and keeps the part inside its
// leaf. A lattice tiles the plane; the leaves tile the plane; therefore the
// clipped cells tile the plane. There is nowhere for a hole to come from.
//
// The second source of holes was obstacles. Parks and the diagonal boulevard
// used to PUSH a cell to one side of themselves, and a cell that wrapped a
// park corner had no convex answer, so a whole 200 m block got dropped. Now a
// cell is DIFFERENCED against the obstacle: for a convex obstacle with faces
// f1..fn, the pieces (outside f1), (inside f1 ∩ outside f2), ... exactly tile
// cell \ obstacle and every piece is convex. Nothing is dropped.
//
// What remains uncovered is only what should be: water, parks, and the
// boulevard — each of which draws its own surface. A rasterized coverage
// metric is computed at the end and printed, so a regression shows up as a
// number instead of as a screenshot somebody has to notice.
import {
  mulberry32, makeProjection, polygonArea, ringArea, centroid,
  insetRing, insetRingPerp, clipRingHalfPlane, bboxOfRing,
  isConvex, cleanRing, splitConvex,
  longestEdgeAngle, extentAlong, pointAt,
} from "./geom.mjs";

// --- small helpers ----------------------------------------------------------

const TAU_ = Math.PI * 2;

export function chaikin(ring, iterations) {
  let r = ring;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    r = out;
  }
  return r;
}

// A coastline that isn't a hand-drawn ellipse. Each control edge is split at
// its midpoint and the midpoint pushed off the chord by a seeded amount, twice
// — the same subdivision-with-displacement that makes a fractal coast, kept
// shallow enough that the inward offset for the esplanade never folds on
// itself. Chaikin then rounds what's left, so the result reads as headlands
// and coves rather than as a polygon.
export function crinkle(ring, rand, amp) {
  let r = ring;
  for (let pass = 0; pass < 2; pass++) {
    const a = amp / (pass + 1);
    const out = [];
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      out.push(p);
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy) || 1;
      if (len < 70) continue;
      const off = (rand() * 2 - 1) * Math.min(a, len * 0.22);
      out.push([p[0] + dx / 2 - (dy / len) * off, p[1] + dy / 2 + (dx / len) * off]);
    }
    r = out;
  }
  return r;
}

export function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Exported for island.mjs, which has to ask "is this core / park / station on
// dry ground" against THE SAME inset ring the generator builds its blocks from.
// Answering it with a private copy of this would be a second opinion, and two
// answers to one question is how a station ends up in the water.
export function offsetInward(ring, d) {
  const c = centroid(ring);
  return ring.map((p, i) => {
    const a = ring[(i - 1 + ring.length) % ring.length];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len, ny = dx / len;
    if ((c[0] - p[0]) * nx + (c[1] - p[1]) * ny < 0) { nx = -nx; ny = -ny; }
    return [p[0] + nx * d, p[1] + ny * d];
  });
}

// A rotated rectangle, in metres.
export const rect = (cx, cy, w, h, deg = 0) => {
  const t = (deg * Math.PI) / 180;
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => [x * Math.cos(t) - y * Math.sin(t) + cx, x * Math.sin(t) + y * Math.cos(t) + cy]);
};

// The half-planes of a CONVEX ring, oriented so "inside the ring" is
// `n·p <= d` for every one of them. `grow` pushes each face outward, which is
// how a park keeps a street's width of clearance around itself.
function insideFaces(ring, grow = 0) {
  const ccw = ringArea(ring) > 0;
  return ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    const ox = ccw ? ey / len : -ey / len;   // outward normal
    const oy = ccw ? -ex / len : ex / len;
    return [ox, oy, a[0] * ox + a[1] * oy + grow];
  });
}

// cell \ obstacle, as convex pieces that exactly tile the difference.
// A cell that misses the obstacle comes back whole and unsplit — the overlap
// is tested first, because the decomposition below would otherwise shred a
// perfectly good block into slivers just for sitting near a park.
function subtractConvex(cell, faces, minArea) {
  let hit = cell;
  for (const [nx, ny, d] of faces) {
    hit = hit && clipRingHalfPlane(hit, nx, ny, d);
    if (!hit) return [cell];
  }
  if (polygonArea([hit]) < 1) return [cell];

  const pieces = [];
  let rest = cell;
  for (const [nx, ny, d] of faces) {
    if (!rest) break;
    const out = cleanRing(clipRingHalfPlane(rest, -nx, -ny, -d) ?? []);
    if (out && polygonArea([out]) >= minArea) pieces.push(out);
    rest = cleanRing(clipRingHalfPlane(rest, nx, ny, d) ?? []);
  }
  // whatever `rest` still holds is inside the obstacle — the park's, not ours.
  return pieces;
}

// The inset of a convex polygon, done exactly: erode it by intersecting the
// half-planes of its own edges pushed inward. This is Minkowski erosion, and
// on a convex ring the result is always convex and always right — unlike a
// mitered vertex offset, which inverts on acute corners and hands back null.
// That failure is what left whole 170 m cells with no block on them: a
// perfectly good sliver block near a park or a district seam would come back
// as bare pavement because its sharpest corner defeated the miter.
// `dOf(edgeAngle, i)` may differ per edge — that is how avenues end up wider
// than side streets.
/**
 * Shortest distance from a point to a ring's boundary. Used to ask whether a
 * lot edge lies on the block perimeter — which is the same question as "does
 * this edge face the street, or does it face the building next door".
 */
function distToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey;
    let t = L2 > 1e-12 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = p[0] - (a[0] + ex * t), dy = p[1] - (a[1] + ey * t);
    const d = Math.hypot(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

function erode(ring, dOf) {
  const ccw = ringArea(ring) > 0;
  let r = ring;
  for (let i = 0; i < ring.length && r; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ox = ccw ? ey / len : -ey / len;   // outward normal
    const oy = ccw ? -ex / len : ex / len;
    const d = typeof dOf === "function" ? dOf(Math.atan2(ey, ex), i) : dOf;
    r = clipRingHalfPlane(r, ox, oy, a[0] * ox + a[1] * oy - d);
  }
  return r ? cleanRing(r) : null;
}

function dilateConvex(ring, d) {
  const ccw = ringArea(ring) > 0;
  const [x0, y0, x1, y1] = bboxOfRing(ring);
  const m = d + 10;
  let r = [[x0 - m, y0 - m], [x1 + m, y0 - m], [x1 + m, y1 + m], [x0 - m, y1 + m]];
  for (let i = 0; i < ring.length && r; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) continue;
    const ox = ccw ? ey / len : -ey / len;
    const oy = ccw ? -ex / len : ex / len;
    r = clipRingHalfPlane(r, ox, oy, a[0] * ox + a[1] * oy + d);
  }
  return r ? cleanRing(r) : null;
}

function chamfer(ring, i, cut) {
  const n = ring.length;
  const prev = ring[(i - 1 + n) % n], cur = ring[i], nxt = ring[(i + 1) % n];
  const p1 = [cur[0] + (prev[0] - cur[0]) * cut, cur[1] + (prev[1] - cur[1]) * cut];
  const p2 = [cur[0] + (nxt[0] - cur[0]) * cut, cur[1] + (nxt[1] - cur[1]) * cut];
  return cleanRing(ring.flatMap((pt, j) => (j === i ? [p1, p2] : [pt])));
}

// --- district flavors -------------------------------------------------------
// A config names a flavor instead of restating twenty numbers. The flavor is
// the economics of the neighbourhood: how finely it plats, how much you may
// build, how much of it is still empty, and whether a tower is thinkable.
// HOW MUCH OF THE CITY IS STILL A HOLE IN THE GROUND.
//
// These were 0.52 to 0.74, which after the edge multiplier left HALF the city
// as vacant lots and the industrial fringe about three-quarters empty. That is
// not a settled harbour town of the present day, it is a frontier survey — and
// it is why whole districts read as a paved grid with a few buildings dropped
// on it however carefully the ground was shaded.
//
// A real city of this age and size runs maybe a tenth vacant, concentrated on
// the industrial edge. These sit deliberately above that, because unbuilt land
// is the game's entire surface and a player needs sites to buy — but at
// roughly a third rather than a half, which is the difference between a city
// with gaps in it and a gap with a city in it.
export const FLAVOR = {
  // `assemble` is how hard the twentieth century bought this district up and
  // threw the lots together. Downtown hardest, row housing barely at all.
  core:       { lot: [380, 1050, 170, 32, 7],  far: 15, vac: 0.26, towerGate: 1.0,  maxFloors: 99, assemble: 1.30, matGain: 1.00, yr: [1925, 1960, 0.30, 1960, 2018], massAspect: 0.88, heightSpread: 1.05 },
  old:        { lot: [320, 1050, 150, 27, 14], far: 12, vac: 0.26, towerGate: 0.5,  maxFloors: 14, assemble: 0.85, matGain: 0.72, yr: [1885, 1945, 0.70, 1950, 1990], massAspect: 0.95, heightSpread: 0.85 },
  resi:       { lot: [400, 900, 180, 26, 6],   far: 7,  vac: 0.32, towerGate: 0.03, maxFloors: 7,  assemble: 0.40, matGain: 0.26, yr: [1900, 1950, 0.60, 1955, 1995], massAspect: 1.0, heightSpread: 0.75 },
  industrial: { lot: [800, 2300, 340, 46, 5],  far: 6,  vac: 0.40, towerGate: 0.0,  maxFloors: 5,  assemble: 1.05, matGain: 0.10, yr: [1915, 1978, 1.00, 1915, 1978], massAspect: 1.38, heightSpread: 0.45 },
  modern:     { lot: [430, 1250, 195, 36, 6],  far: 13, vac: 0.42, towerGate: 0.12, maxFloors: 40, assemble: 1.00, matGain: 0.88, yr: [1972, 2024, 1.00, 1972, 2024], massAspect: 0.92, heightSpread: 1.0 },
};

// WHAT GETS BUILT WHERE.
//
// The old weights put 39% of every building in the city into offices and left
// FOURTEEN industrial buildings standing in a working port. Both are wrong in
// the same direction: this is a harbour town, not a central business district
// with a marina. A city like this is mostly places to live, with shops at the
// bottom of them, a compact office core, and a real working waterfront.
//
// Roughly where these land now: housing around three-fifths, retail a sixth,
// offices an eighth, industry a tenth. The office core is still a core — it is
// concentrated in the districts whose flavour is `core` and `modern` rather
// than smeared across the whole map.
function classFor(flavor, heat, rand) {
  const r = rand();
  switch (flavor) {
    case "industrial":
      // A port district is sheds and yards. It was 56% sheds and then mostly
      // vacant, so almost none of them ever got built.
      if (r < 0.06) return "G1";
      if (r < 0.80) return "E9";
      if (r < 0.88) return "K2";
      if (r < 0.96) return "D0";
      return "S1";
    case "modern":
      if (r < 0.05) return "G1";
      if (r < 0.34) return "O4";
      if (r < 0.46) return "K2";
      if (r < 0.74) return "D0";
      return "RM";
    case "old":
      if (r < 0.22) return "O3";
      if (r < 0.48) return "K2";
      if (r < 0.76) return "S1";
      return "D0";
    case "resi":
      if (r < 0.64) return "D0";
      if (r < 0.82) return "S1";
      if (r < 0.92) return "K2";
      return "RM";
    default:
      // the Exchange: this is where the offices actually are
      if (r < 0.04) return "G1";
      if (r < 0.52) return heat > 0.5 ? "O4" : "O3";
      if (r < 0.70) return "RM";
      if (r < 0.86) return "K2";
      return "D0";
  }
}

// ---------------------------------------------------------------------------

// ------------------------------------------------------------ DENSITY PRESETS
//
// How big a town this is, as one dial. The same island, the same seed and the
// same streets read as a fishing village or a metropolis depending on four
// numbers: how hard dear ground raises the ORDINARY building (mat), how tall a
// tower roll comes out (tower), how often one fires (towerP), and where the
// landmark peak is capped (peakCap, in floors). Stock, jobs and demand indexes
// scale with what is standing so every preset stays a playable economy; the
// PRICE LEVEL does not self-normalise — `initEcon` reads citywide floor
// intensity off these parcels and opens wages, rents, costs and land from the
// Ahlfeldt–Pietrostefani density elasticities (see market.ts). A Metropolis
// is dearer than a Frontier town on the same island because the map is denser,
// not because a menu label said so.
// `vac` MULTIPLIES HOW MUCH OF THE TOWN IS STILL A HOLE IN THE GROUND, and it
// belongs on this ladder because in life it is the same ladder. A town that has
// not been built up yet is not merely shorter — it has gaps in it, whole
// blocks nobody has got to, and the industrial edge is half fields. A city that
// HAS been built up is tall AND full: the empty lots went first, which is why
// a mature downtown redevelops rather than infills.
//
// Modelling height without build-out would have made "less developed" mean a
// metropolis with its towers filed down — every lot still taken, nowhere to
// build, which is the opposite of a young town.
//
// The floor on this matters more than the ceiling: unbuilt land is the game's
// entire surface, so even the most built-out preset has to leave a player
// somewhere to go. Measured rather than assumed — `node test/buildout.mjs`
// prints the whole ladder and is where every number in these notes comes from.
//
// ---------------------------------------------------- `base`, AND WHY IT EXISTS
//
// `mat` was supposed to be the fabric dial and it could not reach the fabric.
// Measured across the seven presets on the standard island, the MEDIAN BUILDING
// was 3 or 4 floors at every single one of them — frontier and metropolis alike.
// The ladder moved the tallest building from 9 floors to 60 and left the
// ordinary building exactly where it was.
//
// The reason is in `blockDatum`: an ordinary building's height is 80% the
// block's datum, and the datum is `(rr(2, 4.6) + heat² · mat · …) · ambition`.
// That first term is a CONSTANT FLOOR that `mat` never multiplies. Drive `mat`
// to zero and the median block still comes out around three storeys, because
// three storeys is what the expression says a block is before dear ground adds
// anything to it. So "less built up" could only ever mean "same town, shorter
// towers", which is not what a young town is.
//
// `base` scales that floor. It is the storey count of an ORDINARY building
// before any land value premium — and in life that is genuinely a function of
// how old and how rich the town is. A frontier port is one and two storeys of
// timber and sheds. A working nineteenth-century town is three and four of
// brick. A capital's ordinary building is six or eight before you have looked
// at a tower. That is the gradient this column carries, and without it the
// bottom of the ladder was a metropolis with its towers filed down.
//
// THE DEFAULT MOVED, DELIBERATELY, AND IT IS THE OWNER'S CALL. There used to be
// a rule written here that an option must leave the default untouched. The
// owner has since asked for the opposite in as many words — "even in the lowest
// setting the game feels too built up... this should be applied to every level"
// — with the stated goal of watching a city go from nothing to big. So every
// rung moved, including `village`, and the economy was re-measured at every one
// of them rather than assumed to survive it. See test/buildout.mjs, which fails
// if any preset produces a town the engine cannot run.
export const DENSITY = {
  // THE BOTTOM OF THE LADDER: a survey and a harbour and not much else. Two
  // thirds of the plat is still grass, the ordinary building is a single storey,
  // and nothing anywhere is above four. This is the "from nothing" end.
  landing:    { mat: 0.06, base: 0.34, tower: 0.16, towerP: 0.10, peakCap: 4,  vac: 2.55 },
  // A town that has begun. Whole blocks nobody has got to, two-storey fabric,
  // and the tallest thing in it is a warehouse.
  frontier:   { mat: 0.13, base: 0.52, tower: 0.24, towerP: 0.20, peakCap: 7,  vac: 2.00 },
  village:    { mat: 0.25, base: 0.72, tower: 0.45, towerP: 0.50, peakCap: 14, vac: 1.42 },
  town1900:   { mat: 0.45, base: 0.84, tower: 0.60, towerP: 0.70, peakCap: 22, vac: 1.22 },
  provincial: { mat: 0.62, base: 0.92, tower: 0.75, towerP: 0.85, peakCap: 30, vac: 1.08 },
  harbour:    { mat: 0.80, base: 1.00, tower: 0.88, towerP: 0.90, peakCap: 40, vac: 0.92 },
  shipped:    { mat: 1.00, base: 1.06, tower: 1.00, towerP: 1.00, peakCap: 52, vac: 0.80 },
  capital:    { mat: 1.20, base: 1.16, tower: 1.12, towerP: 1.10, peakCap: 62, vac: 0.68 },
  metropolis: { mat: 1.45, base: 1.30, tower: 1.28, towerP: 1.25, peakCap: 75, vac: 0.54 },
  // low fabric with dramatic towers — the skyline of a town that boomed once
  spiky:      { mat: 0.50, base: 0.78, tower: 1.10, towerP: 1.15, peakCap: 48, vac: 1.20 },
};

export function generateCity(cfg) {
  // DEFAULT IS `village`, chosen by eye from the eight-preset sweep. A low
  // fabric with almost nothing over sixty metres, so the town you are handed
  // in month 0 has somewhere to go — the skyline is something the campaign
  // BUILDS rather than something it inherits. Override per browser with
  // localStorage "bw:density".
  const DZ = DENSITY[cfg.density] ?? DENSITY.village;
  const rand = mulberry32(cfg.seed);
  const rr = (a, b) => a + (b - a) * rand();
  const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
  const proj = makeProjection(cfg.center[0], cfg.center[1]);

  const COAST_M = chaikin(crinkle(cfg.coast, rand, cfg.coastAmp ?? 46), cfg.smooth ?? 1);
  const COAST = COAST_M.map(proj.toLL);
  const ESPLANADE_W = cfg.esplanade ?? 26;
  const innerRing = offsetInward(COAST_M, ESPLANADE_W);

  const landBox = bboxOfRing(COAST_M);

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const coreHeat = (p) => {
    let h = 0;
    for (const c of cfg.cores) h += c.w * Math.exp(-(dist(p, c.xy) ** 2) / (2 * c.r * c.r));
    return Math.min(1, h);
  };

  // --- obstacles ------------------------------------------------------------
  // PARK FRONTAGE IS A STREET, NOT A KERB STRIP.
  //
  // The clearance the obstacle subtraction leaves is the carriageway that
  // rings the green. It used to be 6 m — the comment called that "a street's
  // width", but district streetW is 9–17 m and pushBlock still takes streetW/2
  // outside the obstacle on top. Measured on procedural islands (Hartford
  // Green, seed 3252): park corners sat ~12–13 m from the nearest lot, of
  // which only six were apron asphalt. At game pitch the turf and the vacant-
  // lot grass read as one field cutting through the road into the triangular
  // parcels at each corner of a rotated common — the "park overlaps parcels"
  // fault. Twelve metres is a modest two-lane frontage the eye can hold, and
  // the drawn green is then inset by PARK_KERB so apron asphalt shows as a
  // kerb rather than turf painted to the reservation line.
  const PARK_CLEAR = 12, PARK_KERB = 1.0, DIAG_CLEAR = 2;
  const PARKS_M = cfg.parks.map((p) => p.ring ?? rect(p.cx, p.cy, p.w, p.h, p.deg ?? 0));
  // Turf the map and the 3D lawn actually paint. Kept inside the reservation
  // so the apron ring reads as pavement, not as more park.
  const PARK_GREEN_M = PARKS_M.map((ring) => erode(ring, PARK_KERB) ?? ring);
  const DIAG_M = (cfg.diagonals ?? []).map((d) => rect(d.cx, d.cy, d.w, d.h, d.deg));
  // Every obstacle is subtracted from any cell that meets it, so a cell never
  // has to be thrown away for touching one. The clearance the subtraction
  // leaves is the frontage road around the park — it has to be PAVED, or the
  // park comes ringed in a metre-wide moat of bare ground.
  const APRONS = [
    ...cfg.parks.map((p, i) => (p.ring
      ? (dilateConvex(PARKS_M[i], PARK_CLEAR) ?? PARKS_M[i])
      : rect(p.cx, p.cy, p.w + 2 * PARK_CLEAR, p.h + 2 * PARK_CLEAR, p.deg ?? 0))),
    ...(cfg.diagonals ?? []).map((d) => rect(d.cx, d.cy, d.w + 2 * DIAG_CLEAR, d.h + 2 * DIAG_CLEAR, d.deg)),
  ];
  const OBSTACLES = [
    ...PARKS_M.map((p) => ({ ring: p, faces: insideFaces(p, PARK_CLEAR) })),
    ...DIAG_M.map((p) => ({ ring: p, faces: insideFaces(p, DIAG_CLEAR) })),
  ];

  // --- the district partition ----------------------------------------------
  // Walk the BSP tree; every leaf carries the half-planes of the path that
  // reached it. Because each cut sends `n·p <= d` one way and `n·p >= d` the
  // other, the leaves are disjoint and their union is the whole plane.
  const leaves = [];
  (function walk(node, hp) {
    if (typeof node === "string") { leaves.push({ district: node, hp }); return; }
    const [nx, ny, d] = node.cut;
    walk(node.neg, [...hp, [nx, ny, d]]);
    walk(node.pos, [...hp, [-nx, -ny, -d]]);
  })(cfg.partition, []);

  const blocks = [];   // { ring, inset|null, district, numbered?, u?, uFifth? }
  const REJECT = {};
  const rej = (k) => { REJECT[k] = (REJECT[k] ?? 0) + 1; };

  const WARP = (() => {
    const f = Array.from({ length: 6 }, () => rr(0.0011, 0.0040));
    const p = Array.from({ length: 6 }, () => rr(0, Math.PI * 2));
    return (x, y, amp) => [
      amp * (Math.sin(x * f[0] + y * f[1] + p[0]) + 0.55 * Math.sin(y * f[2] + p[1])),
      amp * (Math.cos(y * f[3] - x * f[4] + p[2]) + 0.55 * Math.cos(x * f[5] + p[3])),
    ];
  })();

  // The shoreline, bucketed on a coarse grid so a cell only ever tests the
  // handful of segments near it rather than all six hundred.
  const SHORE_CCW = ringArea(innerRing) > 0;
  const SHORE_GRID = 120;
  const shoreBuckets = new Map();
  const skey = (gx, gy) => gx * 100000 + gy;
  for (let i = 0; i < innerRing.length; i++) {
    const a = innerRing[i], b = innerRing[(i + 1) % innerRing.length];
    const [lx, hx] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
    const [ly, hy] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
    for (let gx = Math.floor(lx / SHORE_GRID); gx <= Math.floor(hx / SHORE_GRID); gx++) {
      for (let gy = Math.floor(ly / SHORE_GRID); gy <= Math.floor(hy / SHORE_GRID); gy++) {
        const k = skey(gx, gy);
        if (!shoreBuckets.has(k)) shoreBuckets.set(k, []);
        shoreBuckets.get(k).push(i);
      }
    }
  }
  const segsCross = (p1, p2, p3, p4) => {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
  };

  function clipToShore(ring, minArea) {
    // Only the shore segments that ACTUALLY RUN THROUGH THIS CELL may cut it.
    // A segment's line is infinite and a real coast is concave, so the line of
    // a segment across the bay will happily slice good dry land two hundred
    // metres inland if you let it. Requiring a genuine crossing is the whole
    // difference between a waterfront and a bare margin along it.
    const [bx0, by0, bx1, by1] = bboxOfRing(ring);
    const cand = new Set();
    for (let gx = Math.floor(bx0 / SHORE_GRID) - 1; gx <= Math.floor(bx1 / SHORE_GRID) + 1; gx++) {
      for (let gy = Math.floor(by0 / SHORE_GRID) - 1; gy <= Math.floor(by1 / SHORE_GRID) + 1; gy++) {
        for (const i of shoreBuckets.get(skey(gx, gy)) ?? []) cand.add(i);
      }
    }
    let r = ring;
    for (const i of cand) {
      if (!r) break;
      const a = innerRing[i], b = innerRing[(i + 1) % innerRing.length];
      let meets = inRing(a, ring) || inRing(b, ring);
      for (let k = 0; !meets && k < ring.length; k++) {
        meets = segsCross(a, b, ring[k], ring[(k + 1) % ring.length]);
      }
      if (!meets) continue;
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey) || 1;
      const ox = SHORE_CCW ? ey / len : -ey / len;   // outward (seaward)
      const oy = SHORE_CCW ? -ex / len : ex / len;
      const lim = a[0] * ox + a[1] * oy;
      r = cleanRing(clipRingHalfPlane(r, ox, oy, lim) ?? []);
      if (!r || polygonArea([r]) < minArea) return null;
    }
    return r;
  }

  // A cell, resolved into the pieces of it that are actually buildable ground.
  // Returns [] only when the cell is water, another district's, or a park.
  // KEEP is deliberately tiny. A remnant below it is smaller than a parking
  // space; anything above it is kept, and if it is too thin to carry a block
  // it still goes in as pavement. Dropping remnants is how the old generator
  // tore holes along district seams and the waterline.
  const KEEP = 40;
  function claimCell(quad, hp, minArea) {
    let r = quad;
    for (const [nx, ny, d] of hp) r = r && clipRingHalfPlane(r, nx, ny, d);
    r = r && cleanRing(r);
    // no rejection tally here: every district's lattice spans the whole map,
    // so "not mine" is the normal answer, not a failure.
    if (!r || polygonArea([r]) < minArea) return [];
    // No "is this cell at sea?" pre-test. A cell that straddles a crinkled
    // shoreline can have every probe land in water and still hold real ground,
    // and throwing it out on that evidence cost the waterfront a block-deep
    // margin all the way round. The shore clip below plus the centroid test at
    // the end already decide it correctly, so let them.
    r = clipToShore(r, minArea);
    if (!r) { rej("shore"); return []; }

    let pieces = [r];
    for (const obs of OBSTACLES) {
      pieces = pieces.flatMap((pc) => subtractConvex(pc, obs.faces, minArea));
      if (!pieces.length) break;
    }
    const kept = pieces.filter((pc) => isConvex(pc) && polygonArea([pc]) >= minArea && inRing(centroid(pc), innerRing));
    if (!kept.length) rej("obstacle");
    return kept;
  }

  // Turn a claimed cell into a block. A cell too thin to carry a full setback
  // still goes in — as pavement with no block on it, which reads as a wide
  // street rather than as a hole.
  /**
   * `ways` is how a superblock gets an arterial round it and a service road
   * through it. The pieces of a split cell are eroded EDGE BY EDGE: an edge
   * that lies on the original cell's boundary is a piece of the arterial and
   * gives away half of `streetW`, and an edge that does not is an internal way
   * and gives away half of the much narrower `ways.innerW`. Without it the
   * estate paid a twenty-metre arterial on every internal line as well, which
   * took two-fifths of its ground and left it at a parcel and a half per block.
   */
  function pushBlock(cell, district, full, streetW, aveW, extra, chamferAll = 0, ways = null) {
    let inset = (ways
      ? erode(cell, (_a, e) => (ways.onRim(e) ? streetW / 2 : ways.innerW / 2))
      : erode(cell, (_a, e) => (full && e % 2 === 1 ? aveW / 2 : streetW / 2)))
      ?? erode(cell, streetW / 2)
      ?? erode(cell, streetW / 3);
    // THE CHAFLÁN. Cerdà cut twenty metres off all four corners of every 113 m
    // block in the Eixample so a cart could turn and so every crossing opened
    // into a small square, and the result is the most instantly recognisable
    // street plan in Europe from the air. It is a property of the SURVEY, not
    // of the individual block, so a district that has it has it everywhere and
    // does not also take the one-corner accident below — a chamfered grid with
    // a random extra bite out of it is neither Barcelona nor anywhere else.
    if (inset && chamferAll > 0 && inset.length <= 6) {
      // Each cut turns one corner into two, so after k cuts the (k+1)th
      // original corner has slid along to index 2k. A cut that collapses the
      // ring stops the sequence rather than leaving a block chamfered on three
      // sides — half a chaflán is worse than none.
      const corners = inset.length;
      for (let k = 0; k < corners; k++) {
        const next = chamfer(inset, k * 2, chamferAll);
        if (!next || next.length !== inset.length + 1) break;
        inset = next;
      }
    } else if (inset && rand() < 0.18) {
      inset = chamfer(inset, Math.floor(rand() * inset.length), rr(0.12, 0.3)) ?? inset;
    }
    if (inset && polygonArea([inset]) < 150) inset = null;
    if (!inset) rej("no-inset");
    blocks.push({ ring: cell, inset, district, ...extra });
  }

  // --- the layout kinds -----------------------------------------------------
  //
  // WHY THERE ARE SIX OF THESE AND NOT TWO.
  //
  // For as long as there were two — a lattice and one organic blob — every
  // generated island came out the same city with different numbers: an
  // irregular quarter on the waterfront and a grid over the rest of the land,
  // with the seed moving only the pitch, the bearing and the widths inside
  // narrow bands. Wider bands would not have fixed it. What makes two real
  // cities different at street level is not the size of their blocks, it is
  // that they were laid out under different ideas about what a street is for:
  //
  //   gridiron          Philadelphia 1682, the Commissioners' Plan of 1811 —
  //                     a surveyor's instrument, sold by the lot.
  //   organic           the City of London, Boston's North End — no plan at
  //                     all, streets that are the paths people already walked.
  //   radial / baroque  Karlsruhe 1715, L'Enfant's Washington, Haussmann's
  //                     Paris — sightlines to a monument, a circus where they
  //                     meet, and blocks that widen as they go out because an
  //                     arc does.
  //   chamfered grid    Cerdà's Eixample, 1859 — 113 m blocks with 20 m cut
  //                     off every corner, on a grid that ignores the terrain.
  //   curvilinear       Olmsted's Riverside 1869 and every streetcar suburb
  //                     after it — roads that follow the contour instead of
  //                     cutting it, because the selling point was the view.
  //   superblock        the postwar estate — one arterial ring, no through
  //                     streets, and whatever informal ways the plan allowed
  //                     inside the ring.
  //
  // EVERY ONE OF THEM IS A QUAD GRID OVER A NODE FIELD, which is the whole
  // reason they can be added without reopening the hole problem this file
  // exists to close. A lattice is a grid in Cartesian (u, w); a radial plan is
  // the same grid in polar (r, theta); a garden suburb is Cartesian with the
  // lines bent by a bounded amount. In all three, four consecutive nodes bound
  // a quad, the quads tile the field exactly, the field is built to overhang
  // the island, and each of the district's leaves keeps the part that falls
  // inside it. A kind that cannot be written as such a field does not go here.
  function emitCell(quad, name, d, mine, opt, i, j) {
    /**
     * THE ESTATE'S OWN PLAN IS CUT FIRST AND CLIPPED AFTERWARDS, and the order
     * is load-bearing.
     *
     * claimCell drops a piece whose CENTROID is outside the shoreline, which is
     * the backstop that stops a block floating in a bay the shore clip could not
     * reach. On an ordinary 70 x 200 m block that costs nothing. On a 300 x 330
     * superblock it costs a hundred thousand square metres in one go, and
     * measured across sixty islands the two worst-covered — 93.1% and 94.1%
     * against a median of 98.3 — were losing four per cent of their whole land
     * area to exactly two or three of these. Splitting the grid quad into the
     * estate's slabs BEFORE claiming them means each piece is a third the size
     * and answers the shoreline question on its own, and it is also what really
     * happened: the plan was drawn over the whole site, and the part of it in
     * the water was never built.
     */
    const plan = opt.split
      ? (() => { const out = []; splitCells(quad, opt.split, opt.splitJitter ?? 12, 1500, out); return out; })()
      : [quad];
    for (const leaf of mine) {
      for (const slab of plan) {
        for (const cell of claimCell(slab, leaf.hp, KEEP)) {
          const whole = cell.length === slab.length && cell.every((p, k) => p === slab[k]);
          const ways = plan.length > 1 && opt.innerW
            ? {
              innerW: opt.innerW,
              // An edge is on the arterial when its midpoint lies on the GRID
              // QUAD's boundary — the ring road round the estate — rather than
              // on a line the split drew inside it. Half a metre of tolerance:
              // splitConvex reuses the quad's own vertices, so the only error
              // here is the arithmetic of the cut points.
              onRim: (e) => {
                const a = cell[e], b = cell[(e + 1) % cell.length];
                return distToRing([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], quad) < 0.5;
              },
            }
            : null;
          pushBlock(cell, name, whole && plan.length === 1, d.streetW, d.aveW ?? d.streetW, {
            numbered: opt.numbered ? opt.numbered(i, j) : undefined,
            u: opt.uOf ? opt.uOf(i, j) : undefined,
            uFifth: opt.uMid,
          }, opt.chamferAll ?? 0, ways);
        }
      }
    }
  }

  /**
   * A layout, emitted from its node field. `nodeAt(i, j)` returns the corner of
   * cell (i, j); indices run 0..N and 0..M inclusive, so the caller hands over
   * (N+1)x(M+1) nodes and gets N*M quads.
   */
  function emitQuads(name, d, N, M, nodeAt, opt = {}) {
    const mine = leaves.filter((l) => l.district === name);
    if (!mine.length) return;
    const node = [];
    for (let i = 0; i <= N; i++) {
      const row = [];
      for (let j = 0; j <= M; j++) row.push(nodeAt(i, j));
      node.push(row);
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const quad = cleanRing([node[i][j], node[i + 1][j], node[i + 1][j + 1], node[i][j + 1]]);
        if (!quad || quad.length !== 4 || !isConvex(quad)) { rej("degenerate"); continue; }
        emitCell(quad, name, d, mine, opt, i, j);
      }
    }
  }

  /** The district's own axes and how far the island reaches along them. */
  function frameOf(d) {
    const th = (d.bearingDeg * Math.PI) / 180;
    const A = [Math.sin(th), Math.cos(th)];
    const S = [Math.cos(th), -Math.sin(th)];
    let wMin = Infinity, wMax = -Infinity, uMin = Infinity, uMax = -Infinity;
    for (const p of COAST_M) {
      const w = p[0] * A[0] + p[1] * A[1], u = p[0] * S[0] + p[1] * S[1];
      if (w < wMin) wMin = w; if (w > wMax) wMax = w;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    }
    return { A, S, wMin, wMax, uMin, uMax, at: (u, w) => [u * S[0] + w * A[0], u * S[1] + w * A[1]] };
  }

  // --- lattice districts ----------------------------------------------------
  // The lattice is built ONCE per district over the whole land, then each of
  // that district's leaves keeps its share. Two leaves of the same district
  // therefore stay in register — the streets line up across the seam.
  //
  // `regular` turns off the pitch and node jitter. A paced-out colonial grid
  // wanders; a nineteenth-century engineer's grid does not, and the Eixample
  // is the extreme case — 113 m, everywhere, for a hundred and fifty blocks.
  function latticeDistrict(name, d) {
    const F = frameOf(d);
    const reg = d.regular === true;
    // pad past the coast so the lattice provably overhangs every leaf
    const wMin = F.wMin - d.stPitch * 1.5, wMax = F.wMax + d.stPitch * 1.5;
    const uMin = F.uMin - d.avePitch * 1.2, uMax = F.uMax + d.avePitch * 1.2;

    const W = [];
    for (let w = wMin; w < wMax + d.stPitch; w += d.stPitch * (reg ? 1 : rr(0.85, 1.18))) W.push(w);
    const U = [];
    for (let u = uMin; u < uMax + d.avePitch; u += d.avePitch * (reg ? 1 : rr(0.82, 1.22))) U.push(u);

    const jig = reg ? 0 : 1.8;
    const nodeAt = (i, j) => {
      const base = F.at(U[i], W[j]);
      const [dx, dy] = WARP(base[0], base[1], d.warpAmp);
      return [base[0] + dx + rr(-jig, jig), base[1] + dy + rr(-jig, jig)];
    };
    emitQuads(name, d, U.length - 1, W.length - 1, nodeAt, {
      numbered: d.numbered ? (_i, j) => j + 1 : undefined,
      uOf: (i) => (U[i] + U[i + 1]) / 2,
      uMid: (uMin + uMax) / 2,
      chamferAll: d.chamferAll ?? 0,
      split: d.superCell ? () => rr(d.superCell[0], d.superCell[1]) : undefined,
      splitJitter: d.superJitter,
      innerW: d.wayW,
    });
  }

  // --- curvilinear districts ------------------------------------------------
  //
  // The garden suburb: the same two families of lines as a lattice, bent. Each
  // avenue is displaced across the grid by e(w) and each street by d(u), so the
  // node at (i, j) is at(U[i] + e(W[j]), W[j] + d(U[i])).
  //
  // WHY THAT PARTICULAR FORM AND NOT A GENERAL WARP. Written this way, the cell
  // between four consecutive nodes has corner offsets (0,0), (du, Dd),
  // (du+De, dw+Dd), (De, dw) — a PARALLELOGRAM, whatever the displacement is
  // doing, so it is convex by construction and can never be rejected as
  // degenerate. A displacement that depended on both u and w would not be, and
  // the failures would land exactly where a curve gets interesting: as holes on
  // the tightest bends. The amplitudes are clamped below so the parallelogram
  // also never inverts (|Dd*De| < du*dw).
  function curviDistrict(name, d) {
    const F = frameOf(d);
    const wMin = F.wMin - d.stPitch * 2.2, wMax = F.wMax + d.stPitch * 2.2;
    const uMin = F.uMin - d.avePitch * 2.0, uMax = F.uMax + d.avePitch * 2.0;

    const W = [];
    for (let w = wMin; w < wMax + d.stPitch; w += d.stPitch * rr(0.9, 1.12)) W.push(w);
    const U = [];
    for (let u = uMin; u < uMax + d.avePitch; u += d.avePitch * rr(0.9, 1.12)) U.push(u);

    // Two harmonics each, so a road bends back rather than tracing one sine.
    const lamE = d.curveLen ?? 720, lamD = (d.curveLen ?? 720) * rr(1.2, 1.9);
    const phE = rr(0, TAU_), phD = rr(0, TAU_);
    // The clamp: the steepest step either displacement may take is half the
    // pitch it is stepping across, which keeps the parallelogram's cross
    // product positive with a factor of four in hand.
    const capE = (0.5 * d.avePitch * lamE) / (TAU_ * d.stPitch * 1.12);
    const capD = (0.5 * d.stPitch * lamD) / (TAU_ * d.avePitch * 1.12);
    const ampE = Math.min(d.curveAmp ?? 60, capE);
    const ampD = Math.min((d.curveAmp ?? 60) * 0.45, capD);
    const eOf = (w) => ampE * (Math.sin((TAU_ * w) / lamE + phE) + 0.34 * Math.sin((TAU_ * w) / (lamE * 0.41) + phE * 1.7));
    const dOf = (u) => ampD * (Math.cos((TAU_ * u) / lamD + phD) + 0.30 * Math.cos((TAU_ * u) / (lamD * 0.47) + phD * 2.3));

    const nodeAt = (i, j) => {
      const base = F.at(U[i] + eOf(W[j]), W[j] + dOf(U[i]));
      return [base[0] + rr(-1.4, 1.4), base[1] + rr(-1.4, 1.4)];
    };
    emitQuads(name, d, U.length - 1, W.length - 1, nodeAt, {
      uOf: (i) => (U[i] + U[i + 1]) / 2,
      uMid: (uMin + uMax) / 2,
    });
  }

  // --- radial districts -----------------------------------------------------
  //
  // Spokes from a focus and ring streets across them: Karlsruhe, L'Enfant,
  // the Étoile. The focus is a real place — a palace, a capitol, a harbour
  // mouth — so island.mjs hands one over rather than letting this invent it,
  // and when the focus is off the district's own ground what comes out is a
  // FAN converging on the water, which is the same plan seen from the side.
  //
  // THE SPOKE COUNT IS CONSTANT AND THE BLOCKS GET BIGGER OUTWARD, because
  // that is what a radial plan actually does. An arc of fixed angle is longer
  // further out, so the block on the third ring is twice the block on the
  // first — true of every radial city ever built, and the reason they all have
  // a dense middle and a coarse edge without anyone deciding it. The centre
  // disc goes down as one cell: the circus the whole plan is aimed at.
  function radialDistrict(name, d) {
    const mine = leaves.filter((l) => l.district === name);
    if (!mine.length) return;
    const F = d.focus;
    let rMax = 0;
    for (const p of COAST_M) rMax = Math.max(rMax, Math.hypot(p[0] - F[0], p[1] - F[1]));
    rMax += d.ringPitch * 2;
    // THE CIRCUS IS A RING OF BUILDINGS ROUND A ROUNDABOUT, not a disc.
    // Emitting everything inside `circusR` as one cell made a 193 m circus into
    // a single 117,000 m2 block on seed 1234567, and a block that big straddling
    // a bay has its centroid in the water — where the generator drops it, taking
    // a tenth of the district's ground with it. So the plinth in the middle is
    // the monument island, small enough to be one, and the ground between it
    // and the first ring street is the circus frontage: deep lots facing in,
    // which is what stands round the Étoile and round Karlsruhe's Schlossplatz.
    const plinth = Math.max(18, Math.min(42, (d.circusR ?? 90) * 0.22));
    const r1 = Math.max(plinth + 40, d.circusR ?? 90);
    const M = Math.max(8, Math.round(d.spokes ?? 18));
    const N = Math.max(3, 1 + Math.ceil((rMax - r1) / d.ringPitch));
    const th0 = ((d.bearingDeg ?? 0) * Math.PI) / 180;

    // The ring radii wander a little — a ring road was surveyed once and then
    // widened where the traffic was, and a set of perfectly concentric circles
    // reads as a dartboard rather than as a town.
    const R = [plinth, r1];
    for (let i = 2; i <= N; i++) R.push(R[i - 1] + d.ringPitch * rr(0.86, 1.16));
    const nodeAt = (i, j) => {
      const a = th0 + (j / M) * TAU_;
      return [F[0] + R[i] * Math.cos(a) + rr(-1.4, 1.4), F[1] + R[i] * Math.sin(a) + rr(-1.4, 1.4)];
    };
    emitQuads(name, d, N, M, nodeAt, {
      uOf: (i) => (R[i] + R[i + 1]) / 2,
      uMid: (plinth + R[N]) / 2,
    });
    // The monument island in the middle. Convex by construction (a regular
    // polygon) and the one cell in the district no lattice would ever produce.
    const island = [];
    for (let j = 0; j < M; j++) {
      const a = th0 + (j / M) * TAU_;
      island.push([F[0] + plinth * Math.cos(a), F[1] + plinth * Math.sin(a)]);
    }
    emitCell(island, name, d, mine, { uOf: () => plinth / 2, uMid: (plinth + R[N]) / 2 }, 0, 0);
  }

  // --- organic districts ----------------------------------------------------
  // The colonial quarter: recursive convex splitting from the leaf itself.
  // Splitting a convex ring by a line is an exact partition, so this fills its
  // leaf with no more gaps than the lattice does.
  function splitCells(ring, targetArea, jitterDeg, minArea, out, depth = 0) {
    const area = polygonArea([ring]);
    if (depth > 18 || area < minArea * 2 || area <= targetArea()) { out.push(ring); return; }
    const axis = longestEdgeAngle(ring);
    const across = axis + Math.PI / 2;
    const longDir = extentAlong(ring, axis).span >= extentAlong(ring, across).span ? axis : across;
    const cutDir = longDir + Math.PI / 2 + (rr(-jitterDeg, jitterDeg) * Math.PI) / 180;
    const [a, b] = splitConvex(ring, pointAt(ring, longDir, rr(0.4, 0.6)), cutDir);
    if (!a || !b || polygonArea([a]) < minArea || polygonArea([b]) < minArea) { out.push(ring); return; }
    splitCells(a, targetArea, jitterDeg, minArea, out, depth + 1);
    splitCells(b, targetArea, jitterDeg, minArea, out, depth + 1);
  }

  function organicDistrict(name, d) {
    const pad = 400;
    const box = [
      [landBox[0] - pad, landBox[1] - pad], [landBox[2] + pad, landBox[1] - pad],
      [landBox[2] + pad, landBox[3] + pad], [landBox[0] - pad, landBox[3] + pad],
    ];
    for (const leaf of leaves.filter((l) => l.district === name)) {
      let seed = box;
      for (const [nx, ny, dd] of leaf.hp) seed = seed && clipRingHalfPlane(seed, nx, ny, dd);
      seed = seed && cleanRing(seed);
      if (!seed) continue;
      const cells = [];
      splitCells(seed, () => rr(d.cell[0], d.cell[1]), d.jitterDeg ?? 15, 1500, cells);
      for (const c of cells) {
        for (const cell of claimCell(c, [], KEEP)) {
          let ring = cell;
          if (rand() < 0.28) ring = chamfer(ring, Math.floor(rand() * ring.length), rr(0.15, 0.32)) ?? ring;
          pushBlock(ring, name, false, d.streetW, d.streetW, {});
        }
      }
    }
  }

  // "chamfer" and "superblock" are the lattice with its own options set —
  // a regular grid with every corner cut, and a coarse grid whose cells are
  // split from the inside — so they fall through to the same builder. The
  // default is the lattice too, and deliberately: an unknown kind in a config
  // has to come out as a surveyed grid rather than as bare ground.
  for (const [name, d] of Object.entries(cfg.districts)) {
    if (d.kind === "organic") organicDistrict(name, d);
    else if (d.kind === "curvi") curviDistrict(name, d);
    else if (d.kind === "radial") radialDistrict(name, d);
    else latticeDistrict(name, d);
  }

  // --- parcels & buildings --------------------------------------------------
  function splitLots(ring, opt, out, depth = 0) {
    const area = polygonArea([ring]);
    if (depth > 16 || area < opt.min * 1.9 || area <= opt.target()) { out.push(ring); return; }
    const axis = longestEdgeAngle(ring);
    const across = axis + Math.PI / 2;
    const spanAlong = extentAlong(ring, axis).span;
    const spanAcross = extentAlong(ring, across).span;
    let dir, p;
    if (spanAcross > opt.maxDepth * 1.8 && spanAcross > spanAlong * 0.55) {
      dir = axis + (rr(-3.5, 3.5) * Math.PI) / 180;
      p = pointAt(ring, across, rr(0.44, 0.56));
    } else {
      dir = across + (rr(-opt.jitter, opt.jitter) * Math.PI) / 180;
      p = pointAt(ring, axis, rr(0.36, 0.64));
    }
    const [a, b] = splitConvex(ring, p, dir);
    if (!a || !b || polygonArea([a]) < opt.min || polygonArea([b]) < opt.min) { out.push(ring); return; }
    splitLots(a, opt, out, depth + 1);
    splitLots(b, opt, out, depth + 1);
  }

  const flavorOf = (name) => FLAVOR[cfg.districts[name].flavor] ?? FLAVOR.core;
  /**
   * NO LOT IN THIS CITY WAS EVER BOUGHT BY ANYBODY.
   *
   * The subdivider cut every block down until each piece fell under a target
   * drawn flat from a narrow band, so the whole city came out one size. Median
   * lot 4,672 sf, ninetieth percentile 8,352 sf, and above that essentially
   * nothing — the largest ordinary lot in New Alden was smaller than the
   * FOOTPRINT of a single real office building.
   *
   * Three things followed from that, all of which the player can feel:
   *
   * The skyline could not exist. physicalMaxFloors() reads the plate, and a
   * 3,000 sf plate caps out around twenty storeys no matter what the zoning
   * says. Every tower in the game was slender because every plate was small.
   *
   * The silhouettes could not exist either. A setback gives away width, and a
   * 16 m wide building has none to give: four steps off a 256 m2 plate leave a
   * top floor eight metres across. Wedding cakes were geometrically impossible
   * in this city, which is why none were ever drawn.
   *
   * And assemblage had nothing to point at. The player is asked to buy two
   * lots and fold them together — in a city where every big building already
   * sits on a single lot, so the mechanic has no precedent anywhere on the map
   * and reads as a rule rather than as how this place got built.
   *
   * Real cities are heavy-tailed because the twentieth century ASSEMBLED them:
   * fine nineteenth-century lots bought up in twos and fours and eights for a
   * department store, a bank, a full-block tower — hardest downtown, where the
   * land was worth the assembly cost, and barely at all on the edge, where it
   * never was. So the stop-target gets a fat right tail scaled by heat, and
   * the 25-footer survives next door to the assembled site, which is exactly
   * what a real downtown block looks like.
   */
  /**
   * A DISTRICT MAY CARRY ITS OWN LOT CONVENTION, which is the other half of the
   * same fact. The flavour says what the ground is FOR — offices, housing,
   * yards — and that is an economic statement the engine reads. How the ground
   * was CUT UP is a separate one, and it is the one you can see from the
   * pavement: a Baltimore rowhouse block is 5 m of frontage on a 30 m depth,
   * a streetcar suburb is 15 m on 35, a 1960s estate is one parcel for the
   * whole block. Two districts can be `resi` in the engine's sense and be
   * completely different places to walk down, and until this override existed
   * they could not be, because `lot` was a property of the flavour alone.
   *
   * `[t0, t1, min, maxDepth, jitter]`, exactly as FLAVOR.lot — the district's
   * entry replaces the flavour's when it is present, and nothing else about
   * the flavour moves.
   */
  const lotOptOf = (name, heat = 0) => {
    const fl = flavorOf(name);
    const [t0, t1, min, maxDepth, jitter] = cfg.districts[name]?.lot ?? fl.lot;
    const k = (fl.assemble ?? 1) * (0.45 + 0.75 * Math.max(0, Math.min(1, heat)));
    return {
      target: () => {
        const u = rand();
        const mult =
          u > 1 - 0.045 * k ? rr(5.0, 13) :      // a full block, or most of one
          u > 1 - 0.115 * k ? rr(2.4, 4.8) :     // four or six lots thrown together
          1;                                      // never sold, never merged
        return rr(t0, t1) * mult;
      },
      min, maxDepth, jitter,
    };
  };

  // A CITY HAS MORE THAN ONE KIND OF ZONING DISTRICT.
  //
  // This only ever emitted C-2 through C-8 — commercial, everywhere, including
  // the working waterfront and the row housing. The engine reads the first
  // letter of this string to decide what may be built on a site
  // (dev.ts useForZone: "M" -> industrial, "R" -> multifamily), so BOTH of
  // those branches were unreachable and the demand fallback beneath them can
  // return office, mixed, retail or multifamily but never industrial. Measured
  // across thirty-four centuries: the city and its rivals broke ground on zero
  // industrial buildings, ever. Every shed standing in the port at year 100 was
  // one the generator placed at year zero.
  //
  // Real zoning codes name the use: M for manufacturing, R for residence, C for
  // commercial, with the number carrying the bulk allowance. Emitting the
  // letter the district actually is costs nothing and turns two dead branches
  // of the engine back on.
  // ---------------------------------------------------------------------
  // THE BULK ALLOWANCE, AND WHY IT IS NOW DERIVED FROM THE FABRIC.
  //
  // This was `flavor.far + heat² · 22`, set independently of everything that
  // decides what actually gets built. The two numbers had no relationship and
  // drifted a very long way apart. Measured on the shipped island: the MEDIAN
  // parcel was built to FAR 1.86 and zoned for FAR 16.5 — nine times what
  // stands on it — and 99% of built parcels were zoned above three times their
  // built form. For scale, New York's densest Midtown commercial districts run
  // FAR 15-21; this island was handing that allowance to its median lot.
  //
  // That is not a cosmetic mismatch, because the LAND PRICE IS A RESIDUAL and
  // the residual prices the envelope you are allowed to build, not the one that
  // is there. So the model correctly concluded that essentially every parcel in
  // the city was a teardown. Measured before this change: by year 10, 69% of
  // built parcels were worth more as bare dirt than as standing buildings, the
  // median parcel's land was 109% of its improved value, and real land went
  // from $98/sf to $1,918/sf in a decade — reaching $4,000/sf, about $175M an
  // acre, by year 20. Prime Manhattan is $1,000-2,000/sf. The residual was
  // doing correct arithmetic on a fictional envelope.
  //
  // It also could not see the build-out preset at all, so a Landing town of
  // one-storey sheds was zoned exactly like a Metropolis.
  //
  // So the allowance is anchored to the fabric the generator actually produces
  // — the same expression that sets a block's typical height, read at this
  // district's flavour and this heat — times a HEADROOM that widens toward the
  // middle of town. That headroom is the real quantity: a city zones its centre
  // for what it hopes to become and its edges for roughly what is there, and
  // the gap between the two is where redevelopment lives. Making it a gradient
  // rather than a constant is what turns "every lot is a teardown" into "some
  // lots are, and finding them is the game".
  const zoneFar = (name, heat) => {
    const fl = flavorOf(name);
    // The typical building this district puts up at this heat. Mirrors the
    // block datum below: a base storey count the preset scales, plus what dear
    // ground adds, at the mean of the `ambition` draw.
    const typFloors = ((fl.maxFloors <= 5 ? 2.0 : 3.3) * (DZ.base ?? 1)
      + heat * heat * 7.5 * (fl.matGain ?? 1) * DZ.mat) * 1.1;
    // Coverage of an ordinary building; towers cover less and are the reason
    // the core needs headroom rather than a bigger typical.
    const typFar = Math.max(0.7, typFloors * 0.68);
    // 2× at the fringe — room for a mid-rise without variance — rising to ~6×
    // downtown so a tower can be legal where a walk-up stands today.
    const headroom = 2.0 + 4.5 * heat * heat;
    return Math.round(Math.max(2.0, Math.min(38, typFar * headroom)) * 10) / 10;
  };

  function zoningFor(name, heat) {
    const flavor = cfg.districts[name]?.flavor ?? "core";
    const far = zoneFar(name, heat);
    let z;
    if (flavor === "industrial") {
      // M1 light manufacturing, M2 general, M3 heavy — bulk rises with the FAR
      // the district actually carries.
      z = far >= 5 ? "M3" : far >= 3 ? "M2" : "M1";
    } else if (flavor === "resi") {
      z = far >= 9 ? "R8" : far >= 6 ? "R6" : "R4";
    } else {
      z = far >= 24 ? "C-8" : far >= 18 ? "C-6" : far >= 12 ? "C-5" : far >= 8 ? "C-4" : "C-2";
    }
    return { z, commfar: far, resfar: far };
  }
  function vacancyP(name, heat) {
    const edge = Math.pow(1 - heat, 1.5);
    // THE MULTIPLIER GOES OUTSIDE THE ORIGINAL CLAMP, and that ordering is the
    // whole point. Folding it inside and widening the floor from 0.2 to 0.06
    // changed the DEFAULT town — the 0.2 was binding on core and resi lots at
    // high heat (0.26 x 0.42 = 0.109), so downtown got measurably less vacant
    // for everybody, from an option nobody had switched on. Clamped first, then
    // scaled, `village` is exactly the town it has always been and every other
    // preset is a stated multiple of it.
    const base = Math.min(0.88, Math.max(0.2, flavorOf(name).vac * (0.42 + 1.05 * edge)));
    // The maturity multiplier rides the same edge gradient rather than
    // flattening it: a built-up city fills its centre first and still has gaps
    // on the industrial fringe, which is where the gaps actually are.
    return Math.min(0.88, Math.max(0.05, base * (DZ.vac ?? 1)));
  }

  const FOUNDED = cfg.cores?.[0]?.xy ?? [0, 0];
  const FOUND_MAX = (() => {
    let m = 1;
    for (const q of innerRing) m = Math.max(m, dist(FOUNDED, q));
    return m;
  })();
  const growthRing = (p) => Math.min(1, dist(p, FOUNDED) / FOUND_MAX);
  const RING_W = 0.60;
  const pendingYears = [];
  function yearFor(name, at) {
    const [a0, a1, p, b0, b1] = flavorOf(name).yr;
    const u0 = rand();
    const mode = rand() < p;
    const rec = { name, ring: growthRing(at), u0, a0, a1, b0, b1, mode, year: 0 };
    pendingYears.push(rec);
    return rec;
  }
  function settleYears() {
    if (!pendingYears.length) return;
    const mean = pendingYears.reduce((a, r) => a + r.ring, 0) / pendingYears.length;
    for (const r of pendingYears) {
      const ring = 0.5 + (r.ring - mean);
      const u = Math.min(1, Math.max(0, r.u0 * (1 - RING_W) + ring * RING_W));
      r.year = Math.round(r.mode ? r.a0 + (r.a1 - r.a0) * u : r.b0 + (r.b1 - r.b0) * u);
      if (r.pf) r.pf.properties.yearbuilt = r.year;
      if (r.bf) r.bf.properties.cnstrct_yr = r.year;
    }
  }

  const corridorDist = (p) => {
    let best = Infinity;
    for (const r of DIAG_M) best = Math.min(best, inRing(p, r) ? 0 : distToRing(p, r));
    return Number.isFinite(best) ? best : 9999;
  };
  const cornerLot = (lotRing, blockRing) => lotRing !== blockRing
    && blockRing.some((v) => lotRing.some((q) => Math.abs(q[0] - v[0]) < 0.05 && Math.abs(q[1] - v[1]) < 0.05));

  const parcels = { type: "FeatureCollection", features: [] };
  const buildings = { type: "FeatureCollection", features: [] };
  const builtLots = [];   // the landmark pass picks its sites out of this
  let blockNo = 1, binNo = 1000001;

  for (const block of blocks) {
    const street = block.inset;
    if (!street || polygonArea([street]) < 420) continue;
    const bc = centroid(street);
    const d = block.district;
    const heat = coreHeat(bc);
    let houseNo = Math.round(rr(1, 60));
    const namedStreet = pick(cfg.streets[d] ?? cfg.streets.default);
    // ------------------------------------------------------ THE CORNICE LINE
    //
    // Measured on the generated city: the mean spread of building heights
    // WITHIN a block was 7.1m against 7.9m BETWEEN blocks — a ratio of 0.90,
    // which says a block was very nearly as jumbled inside itself as the whole
    // city was across all of it. Streets do not look like that. The buildings
    // on one block went up in the same decade, under the same code, for the
    // same rents and the same tenants, and they meet the sky along a shared
    // line. That line is why a street wall reads as a WALL and not as a bar
    // chart, and it is the reason a tower is legible when one does break it.
    //
    // So height is rolled ONCE here, for the block, and each building is
    // mostly that with a little of its own on top. Towers ignore it entirely —
    // a tower that respected the cornice would not be a tower.
    //
    // The datum is not read off the value surface alone. Blocks differ because
    // they were built at different moments, for different money, by people with
    // different nerve — a block that went up in one go for a syndicate is taller
    // than the block behind it that filled in lot by lot over forty years, and
    // they can be the same distance from the same corner. `ambition` is that,
    // and it is what makes the fabric read as having a HISTORY rather than as a
    // smooth function of distance from downtown.
    const blkFl = flavorOf(d);
    const ambition = rr(0.58, 1.62);
    // `DZ.base` scales the pre-premium storey count — see the note on DENSITY.
    // Without it this term was a constant, and it is 80% of what an ordinary
    // building ends up being, so no preset could make a town low.
    const bz = DZ.base ?? 1;
    const blockDatum = Math.max(1, Math.round(
      ((blkFl.maxFloors <= 5 ? rr(1, 3) : rr(2, 4.6)) * bz
       + heat * heat * 7.5 * (blkFl.matGain ?? 1) * DZ.mat * rr(0.45, 1.05)) * ambition,
    ));

    const lots = [];
    const fullBlockP = cfg.districts[d].fullBlockP ?? 0.05;
    if (rand() < fullBlockP) lots.push(street);
    else splitLots(street, lotOptOf(d, heat), lots);

    let lotNo = 1;
    const blockCorners = street;
    for (const lotRing of lots) {
      const areaM2 = polygonArea([lotRing]);
      if (areaM2 < 70) continue;
      const lotArea = Math.round(areaM2 * 10.7639);
      const c = centroid(lotRing);
      const h = coreHeat(c);
      const zone = zoningFor(d, h);
      const vacant = rand() < vacancyP(d, h);
      const cls = vacant ? "V1" : classFor(cfg.districts[d].flavor, h, rand);
      const bbl = 1000000000 + blockNo * 10000 + lotNo;

      const yearRec = vacant ? null : yearFor(d, c);
      const yearbuilt = 0;
      let floors = 0, bldgArea = 0, footprint = null, heightM = 0;
      if (!vacant) {
        const fl = flavorOf(d);
        // A TOWER GOES WHERE THE SITE IS.
        //
        // Height used to be rolled off heat alone, with a 1.2-point bonus if
        // the lot cleared 1,500 m2 — so a twenty-five-foot lot was very nearly
        // as likely to carry twenty storeys as the assembled site next door.
        // That is the density that reads as wrong: towers scattered through
        // row housing and four-storey walk-ups holding down the best corner in
        // the city. Nobody puts a tower on a site that cannot take one, and
        // everybody puts one on a site that can — which is the whole reason
        // anyone assembles land in the first place.
        const plate = areaM2 / 620;                    // 1.0 = an ordinary site
        const big = Math.max(0, Math.min(3.2, plate - 1));
        const towerP = Math.min(0.40, (h * h * 0.16 + 0.055 * big) * fl.towerGate * DZ.towerP);
        // ------------------------------------------------------- THE MAT
        //
        // THE CITY WAS A PLATEAU. Measured across the whole heat surface, in
        // five equal bands from the coldest ground to the dearest: the median
        // building was THREE STOREYS at heat 0.07, and THREE STOREYS at heat
        // 1.00. p90 crawled from four floors to six. Only the 99th percentile
        // moved at all. So the skyline was a flat carpet of walk-ups with a
        // handful of towers standing in it like flagpoles, and the towers were
        // never the problem — the carpet was.
        //
        // What makes a downtown look like a downtown is not its tallest
        // building, it is that its ORDINARY building is eight storeys while
        // the ordinary building four blocks out is three. That gradient is
        // the whole read of a city from the air, and it is the one thing the
        // generator did not have. `mat` is it: the floor count that dear
        // ground adds to everything standing on it, before any tower rolls.
        // It is squared in heat because land value is, and it is scaled per
        // district because a dear block in a row-house neighbourhood gets
        // brownstones, not a mid-rise.
        const mat = h * h * 7.5 * (fl.matGain ?? 1) * DZ.mat;
        const hSpread = fl.heightSpread ?? 1;
        let coverage;
        if (areaM2 > 240 && rand() < towerP) {
          floors = Math.round((rr(7, 12) + h * h * rr(10, 23)) * DZ.tower * (0.86 + 0.20 * Math.min(2.4, plate)));
          coverage = rr(0.42, 0.58);
        } else if (fl.maxFloors > 5 && rand() < 0.18 + h * 0.34) {
          floors = Math.round(rr(3, 6) * (DZ.base ?? 1) + mat * rr(0.55, 1.25));
          floors = Math.max(1, Math.round(floors * 0.22 + blockDatum * 1.20 * 0.78 + rr(-0.7, 0.7) * hSpread));
          coverage = rr(0.55, 0.72);
        } else {
          floors = Math.round((fl.maxFloors <= 5 ? rr(1, 3) : rr(2, 4)) * (DZ.base ?? 1) + mat * rr(0.22, 0.78));
          floors = Math.max(1, Math.round(floors * 0.20 + blockDatum * 0.80 + rr(-0.6, 0.6) * hSpread));
          coverage = rr(0.6, 0.78);
        }
        // Industrial yards read wide and low; office cores read narrower plates.
        const massAspect = fl.massAspect ?? 1;
        if (massAspect > 1.05) coverage = Math.min(0.88, coverage * massAspect);
        else if (massAspect < 0.95) coverage = Math.max(0.48, coverage * massAspect);
        // A tall building does not cover its lot the way a walk-up does: the
        // core, the light and the setback all take plate off it as it climbs.
        if (floors > 6) coverage *= Math.max(0.72, 1.0 - (floors - 6) * 0.012);
        floors = Math.min(floors, fl.maxFloors);
        // AND THE PRESET'S CEILING IS A CEILING. `peakCap` used to bind only on
        // the landmark pass, so an ordinary tower roll could sail past it: the
        // "low skyline" young town came out with an eighteen-floor building
        // against a stated cap of fourteen, and the note describing the preset
        // was wrong about the town it described. It is the town's tallest
        // building now, which is what the name says and what the menu promises
        // — and it is what makes the bottom of the ladder mean anything, since
        // "nothing above four floors" is the whole read of a place that has
        // barely been built.
        if (DZ.peakCap) floors = Math.min(floors, DZ.peakCap);
        if (cls === "G1") floors = Math.min(floors, 4);
        // SHOPS DO NOT STACK. Pure retail is one or two storeys — the second
        // floor already trades at a discount to the first and there is no
        // third. Anything taller with shops in it is a stacked building, and
        // that is a different building class entirely.
        if (cls === "K2") floors = Math.min(floors, 2);
        if (cls === "E9") floors = Math.min(floors, 4);
        floors = Math.min(floors, Math.max(1, Math.floor(Math.max(zone.commfar, zone.resfar) / coverage)));
        const side = Math.sqrt(areaM2);
        // ------------------------------------------------ THE PARTY WALL
        //
        // NOT ONE BUILDING IN THIS CITY TOUCHED ANOTHER.
        //
        // Every footprint was eroded by the SAME distance on every side, so a
        // row house pulled back from its neighbour exactly as far as it pulled
        // back from the street. Measured across three generated cities and
        // 4,684 lots: 66.9% of the average lot's perimeter abuts another lot
        // (median 72%), 50.3% of lots are midblock and 40.3% are corners — and
        // yet the minimum distance between any two buildings in New Alden was
        // 3.00 m and the median 3.51 m. A thousand freestanding boxes floating
        // inside their lots, with daylight down every party line.
        //
        // That is not a detail. It is why the city reads as a model railway
        // and not as a street: a real block is a CONTINUOUS WALL of masonry
        // with a serrated top, broken only where somebody knocked something
        // down. The buildings touch.
        //
        // So the erosion goes per-edge. An edge lying on the block perimeter
        // faces the street and keeps its setback; every interior edge is a
        // party line and gets almost nothing. The street setback is then
        // solved so the footprint still covers the SAME share of the lot it
        // did before — the shape changes, the area does not, and nothing
        // downstream of coverage moves by a square foot.
        const PARTY = 0.12;
        const party = [];
        for (let i = 0; i < lotRing.length; i++) {
          const a = lotRing[i], b = lotRing[(i + 1) % lotRing.length];
          const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          party.push(distToRing(mid, street) > 0.35);
        }
        const streetEdges = party.filter((x) => !x).length;
        if (streetEdges === 0) {
          // Landlocked: no frontage, so there is nothing to set back from.
          footprint = erode(lotRing, Math.max(1.2, (side * (1 - Math.sqrt(coverage))) / 2))
            ?? insetRingPerp(lotRing, 1.2);
        } else {
          const want = coverage * areaM2;
          const cut = (dd) => erode(lotRing, (_ang, i) => (party[i] ? PARTY : dd));
          let lo = 0, hi = side * 0.6, best = cut(0);
          for (let k = 0; k < 9; k++) {
            const mid = (lo + hi) / 2;
            const r = cut(mid);
            const a = r ? polygonArea([r]) : 0;
            if (a > want) { lo = mid; best = r; } else { hi = mid; if (a > 0) best = r; }
          }
          footprint = best ?? erode(lotRing, 1.5) ?? insetRingPerp(lotRing, 1.2);
        }
        const realCov = footprint ? polygonArea([footprint]) / areaM2 : coverage;
        bldgArea = Math.round(lotArea * realCov * floors);
        heightM = floors * 3.55 + rr(1, 4);
      }

      const landPsfBase = 60 + 380 * h;
      const assessland = Math.round(lotArea * landPsfBase * rr(0.85, 1.15) * 0.45);
      const bldgPsf = cls[0] === "O" ? rr(140, 280) : cls[0] === "D" ? rr(120, 230) : rr(70, 180);
      const assesstot = assessland + Math.round(bldgArea * bldgPsf * 0.45);
      const unitsres = cls[0] === "D" || cls === "S1" || cls === "RM"
        ? Math.max(1, Math.round((bldgArea * (cls === "D0" ? 0.9 : 0.45)) / 900)) : 0;

      let address;
      if (block.numbered !== undefined && rand() < 0.25) {
        address = `${houseNo * 10 + Math.round(rr(0, 9))} ${cfg.avenues[Math.abs(Math.round((block.u - block.uFifth) / 215)) % cfg.avenues.length]}`;
      } else if (block.numbered !== undefined) {
        const n = block.numbered;
        const suf = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
        address = `${houseNo} ${block.u < block.uFifth ? "W" : "E"} ${n}${suf} St`;
      } else {
        address = `${houseNo} ${namedStreet}`;
      }

      parcels.features.push({
        type: "Feature",
        id: bbl,
        geometry: { type: "Polygon", coordinates: [[...lotRing.map(proj.toLL), proj.toLL(lotRing[0])]] },
        properties: {
          bbl: String(bbl),
          borough: cfg.abbr ?? "XX", block: String(blockNo), lot: String(lotNo),
          address,
          zonedist1: zone.z, commfar: zone.commfar, resfar: zone.resfar,
          bldgclass: cls, landuse: vacant ? "11" : cls === "G1" ? "10" : cls[0] === "O" ? "05" : "04",
          lotarea: lotArea, bldgarea: bldgArea, numfloors: floors,
          yearbuilt, assessland, assesstot, unitsres,
          cd: cfg.district, district: d,
          shorem: Math.round(distToRing(c, innerRing)),
          shoreamen: blkFl === FLAVOR.industrial ? 0 : 1,
          corridorm: Math.round(corridorDist(c)),
          corner: cornerLot(lotRing, blockCorners) ? 1 : 0,
        },
      });

      if (yearRec) yearRec.pf = parcels.features[parcels.features.length - 1];
      if (!vacant && footprint) {
        builtLots.push({ h, areaM2, floors, cls, lotArea,
                         pf: parcels.features[parcels.features.length - 1],
                         bi: buildings.features.length, c, bbl });
        buildings.features.push({
          type: "Feature",
          id: binNo,
          geometry: { type: "Polygon", coordinates: [[...footprint.map(proj.toLL), proj.toLL(footprint[0])]] },
          properties: {
            bin: String(binNo++),
            base_bbl: String(bbl),
            heightroof: +(heightM * 3.28084).toFixed(1),
            cnstrct_yr: yearbuilt,
            groundelev: Math.round(rr(3, 20)),
          },
        });
        if (yearRec) yearRec.bf = buildings.features[buildings.features.length - 1];
      }
      houseNo += Math.round(rr(2, 8));
      lotNo++;
    }
    blockNo++;
  }

  // Every lot is cut; now the years can be centred on them. See yearFor.
  settleYears();

  // --- decorative waterfront ------------------------------------------------
  //
  // ORNAMENT DRAWS FROM ITS OWN STREAM, and that is not tidiness, it is the fix
  // for a bug this block already caused once.
  //
  // Removing the harbour furniture deleted about a dozen `rand()` sites from the
  // ONE stream the whole generator shares, so every draw after it shifted — and
  // what comes after it is not ornament. `citygen.mjs` picks the PEAK LANDMARK'S
  // FLOOR COUNT at `tallest * rr(1.26, 1.46)` and its ASSESSED VALUE at
  // `bldgarea * rr(200, 340)`, on a real tax lot, further down this same
  // function. Taking some scenery off the water silently changed the tallest
  // building in every existing save and what the assessor thinks it is worth.
  //
  // `swans.ts` had already worked this out and wrote down why: "drawing from the
  // shared stream here would shift every downstream consumer of it... which
  // turns 'this build added swans' into 'this build changed everything'." Same
  // reasoning, same remedy. Decoration now has a stream of its own, derived from
  // the city seed so it is still deterministic, and nothing that can be seen but
  // not owned can move anything that can be owned. Adding or deleting a boat is
  // free from here on.
  const drand = mulberry32((cfg.seed ^ 0x5eaf00d) >>> 0);
  const drr = (a, b) => a + (b - a) * drand();
  // Everything here carries a `deco` kind so the renderer can COLOR it — a
  // navy hull, a white wheelhouse, an ochre crane — instead of the fleet of
  // uniform grey boxes the harbor used to be.
  // THE HARBOUR FURNITURE IS GONE, BY REQUEST.
  //
  // Owner: "i am really not a fan of the 'dock' / 'harbor' looking like
  // structures, we should remove them from the game."
  //
  // Emptied at the source rather than deleted emitter by emitter, because the
  // piers are the root of all of it: the sheds sit on them (`slice(0, 4)`
  // below), the piles and bollards dress their edges, the channel buoys are
  // placed seaward of their tips, and the landscape layer draws them as
  // `kind: "pier"` polygons. One empty array and every one of those loops
  // produces nothing. The ships and the quay cranes are separately sourced and
  // are switched off where they are read.
  //
  // NOTHING STRUCTURAL DEPENDS ON THEM, which is why this is safe: piers carry
  // `base_bbl: ""` and are never parcelled, no block or lot is generated on
  // one, and no demand, transit, zoning or employment term reads them. The
  // coastline is its own feature and is untouched, so the harbour is still a
  // harbour — it just has nothing industrial standing in it.
  //
  // The lighthouse stays. It is a landmark on a headland rather than a dock.
  const PIERS_M = [];
  let decoN = 1;
  function addDeco(ringM, topM, baseM = 0, kind = "shed") {
    buildings.features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[...ringM.map(proj.toLL), proj.toLL(ringM[0])]] },
      properties: {
        bin: "deco" + decoN++, base_bbl: "",
        heightroof: +(topM * 3.28084).toFixed(1),
        base_ft: baseM ? +(baseM * 3.28084).toFixed(1) : 0,
        cnstrct_yr: 1990,
        deco: kind,
      },
    });
  }
  // Quay cranes, moored ships and the breakwaters go with the piers — see the
  // note at PIERS_M. `cfg.cranes`, `cfg.ships` and `cfg.breakwaters` are left
  // in the city definitions so the shape of a town is still described in one
  // place; nothing reads them.
  const BREAKWATERS = [];


  // --- the lighthouse --------------------------------------------------------
  // Every harbor town has one, on the headland the chart says it should be on:
  // the seaward point of the coast furthest from the middle of town.
  const headland = (() => {
    if (cfg.lighthouse) return cfg.lighthouse;
    let best = COAST_M[0], bd = 0;
    for (const p2 of COAST_M) {
      const d2 = Math.hypot(p2[0], p2[1]);
      if (d2 > bd) { bd = d2; best = p2; }
    }
    return best;
  })();
  {
    const [lx, ly] = headland;
    const oct = [];
    for (let k = 0; k < 8; k++) {
      const a2 = (k / 8) * Math.PI * 2;
      oct.push([lx + 3.1 * Math.cos(a2), ly + 3.1 * Math.sin(a2)]);
    }
    // A TOWER TAPERS. Fifteen metres of straight octagon with a shed beside it
    // is a navigation mark; what a harbour town actually has on its headland
    // is a stone cone you can see from every deck in the roads. Six courses,
    // each a little narrower and each with its own step, then the gallery and
    // the lantern — and the keeper gets a house, because somebody lived there.
    const ring = (f) => oct.map(([x2, y2]) => [lx + (x2 - lx) * f, ly + (y2 - ly) * f]);
    const hK = drr(4.6, 5.4);
    for (let k = 0; k < 6; k++) addDeco(ring(1.34 - k * 0.13), hK * (k + 1), hK * k, "light");
    addDeco(ring(1.62), hK * 6 + 1.5, hK * 6, "lightcap");            // gallery
    addDeco(ring(0.92), hK * 6 + 4.6, hK * 6 + 1.5, "light");         // lantern room
    addDeco(ring(1.06), hK * 6 + 6.0, hK * 6 + 4.6, "lightcap");      // the roof over the lamp
    const ka = drr(0, 30);
    addDeco(rect(lx + 11, ly + 3, 11, 7, ka), 4.4, 0, "civic");       // keeper's house
    addDeco(rect(lx + 11, ly + 3, 12.2, 8.2, ka), 6.2, 4.4, "civicroof");
    addDeco(rect(lx + 3.5, ly + 3, 5.5, 4, ka), 3.0, 0, "shed");      // the oil store
  }

  // --- context --------------------------------------------------------------
  // Districts already differ in block geometry, density and building stock.
  // A small, stable material shift lets that identity survive at map scale
  // without turning neighbourhoods into a colour-coded board game.
  const districtTone = (name) => {
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 5;
  };
  const drawn = blocks.filter((b) => b.inset);
  const pavementFeatures = blocks.map((b) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...b.ring.map(proj.toLL), proj.toLL(b.ring[0])]] },
    properties: {
      kind: "pavement", solo: b.inset ? 0 : 1, d: b.district,
      dt: districtTone(b.district), org: b.u === undefined ? 1 : 0,
    },
  }));
  const blockFeatures = drawn.map((b) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...b.inset.map(proj.toLL), proj.toLL(b.inset[0])]] },
    properties: {
      kind: "block", d: b.district,
      dt: districtTone(b.district), org: b.u === undefined ? 1 : 0,
    },
  }));
  // CROSSWALKS. A striped bar across the roadway at every corner of the
  // gridded blocks — laid out from the block's own kerb, spanning the full
  // street width, so the two blocks either side of a road each paint their
  // half and the crossing meets in the middle. The colonial quarter gets
  // none: nobody ever painted those lanes.
  const crosswalkFeatures = [];
  for (const b of blocks) {
    if (b.u === undefined || !b.inset) continue;      // lattice blocks only
    const r = b.inset;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], bb = r[(i + 1) % r.length];
      const dx = bb[0] - a[0], dy = bb[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 26) continue;                          // too short to be a street
      const ux = dx / len, uy = dy / len;
      // outward normal: away from the block's middle
      const c = centroid(r);
      let nx = -uy, ny = ux;
      if ((a[0] - c[0]) * nx + (a[1] - c[1]) * ny < 0) { nx = -nx; ny = -ny; }
      const road = 9;                                  // reach across the carriageway
      for (const end of [0, 1]) {
        const t = end === 0 ? 4.2 : len - 4.2;
        const px = a[0] + ux * t, py = a[1] + uy * t;
        const halfW = 1.9;                             // half the stripe band
        crosswalkFeatures.push([
          [px - ux * halfW, py - uy * halfW],
          [px + ux * halfW, py + uy * halfW],
          [px + ux * halfW + nx * road, py + uy * halfW + ny * road],
          [px - ux * halfW + nx * road, py - uy * halfW + ny * road],
        ]);
      }
    }
  }

  const centerFeatures = blocks.map((b) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [...b.ring.map(proj.toLL), proj.toLL(b.ring[0])] },
    properties: { kind: "centerline", cls: b.u !== undefined ? "grid" : "lane" },
  }));
  const streetFeatures = drawn.map((b) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [...b.inset.map(proj.toLL), proj.toLL(b.inset[0])] },
    properties: {
      kind: "street", cls: b.u !== undefined ? "grid" : "lane", d: b.district,
      dt: districtTone(b.district), org: b.u === undefined ? 1 : 0,
    },
  }));
  const shoreRoad = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: [...innerRing.map(proj.toLL), proj.toLL(innerRing[0])] },
    properties: { kind: "street", cls: "shore" },
  };
  const esplanade = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [...COAST, COAST[0]],
        [...innerRing.slice().reverse().map(proj.toLL), proj.toLL(innerRing[innerRing.length - 1])],
      ],
    },
    properties: { kind: "esplanade" },
  };
  // THE BACKSTOP. Everything inside the shoreline is paved before a single
  // block is drawn on top of it. If some sliver still escapes the partition it
  // shows up as asphalt between two blocks — which is what a street looks like
  // — instead of as a patch of bare ground.
  const paveland = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[...innerRing.map(proj.toLL), proj.toLL(innerRing[0])]] },
    properties: { kind: "paveland" },
  };

  // --- parks designed like parks --------------------------------------------
  // A park is not a green rectangle with confetti on it. It has a perimeter
  // promenade with an allée of trees, cross paths that meet in the middle, a
  // lawn kept open at the centre, and — in the big ones — a pond. The trees
  // cluster in the corners and along the walks, the way planting plans
  // actually read.
  const treeFeatures = [];
  const pathFeatures = [];
  const pondFeatures = [];
  let biggestPark = null, biggestA = 0;
  // Design against the painted green (inset by PARK_KERB), not the full
  // reservation — otherwise the promenade trees and corner groves sit on the
  // kerb strip the apron is supposed to show, and the turf reads past the road.
  for (let pi = 0; pi < PARKS_M.length; pi++) {
    const park = PARKS_M[pi];
    const green = PARK_GREEN_M[pi];
    const c = centroid(green);
    const areaP = polygonArea([park]);
    if (areaP > biggestA) { biggestA = areaP; biggestPark = park; }
    // the perimeter promenade, a walk in from the painted edge
    const walk = erode(green, 6);
    if (walk) {
      pathFeatures.push([...walk, walk[0]]);
      // cross paths corner-to-corner through the middle
      for (let k = 0; k < Math.min(4, walk.length); k += 1) {
        const a = walk[k % walk.length];
        pathFeatures.push([a, c]);
      }
      // the allée: paired trees marching along the promenade
      for (let i = 0; i < walk.length; i++) {
        const a = walk[i], b = walk[(i + 1) % walk.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let d = 4; d < len; d += rr(8, 12)) {
          const t = d / len;
          const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
          const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
          const tIn = [px + nx * 2.5, py + ny * 2.5];
          const tOut = [px - nx * 2.5, py - ny * 2.5];
          if (inRing(tIn, green)) treeFeatures.push(tIn);
          if (rand() < 0.6 && inRing(tOut, green)) treeFeatures.push(tOut);
        }
      }
    }
    // a pond in anything big enough to hold one, offset from centre
    const [bx0, by0, bx1, by1] = bboxOfRing(green);
    const pw = bx1 - bx0, ph = by1 - by0;
    if (Math.min(pw, ph) > 130) {
      const pcx = c[0] + pw * 0.14, pcy = c[1] - ph * 0.1;
      const pond = [];
      const rA = Math.min(pw, ph) * rr(0.16, 0.2), rB = rA * rr(0.6, 0.78), tilt = rr(0, Math.PI);
      for (let k = 0; k < 18; k++) {
        const a2 = (k / 18) * Math.PI * 2;
        const wob = 1 + 0.14 * Math.sin(a2 * 3 + tilt * 5);
        const ex = rA * Math.cos(a2) * wob, ey = rB * Math.sin(a2) * wob;
        pond.push([pcx + ex * Math.cos(tilt) - ey * Math.sin(tilt), pcy + ex * Math.sin(tilt) + ey * Math.cos(tilt)]);
      }
      pondFeatures.push(pond);
      // willows at the water's edge
      for (let k = 0; k < 18; k += 3) {
        const tw = [pond[k][0] + rr(-2, 2) + (pond[k][0] - pcx) * 0.14, pond[k][1] + rr(-2, 2) + (pond[k][1] - pcy) * 0.14];
        if (inRing(tw, green)) treeFeatures.push(tw);
      }
    }
    // corner groves, an open lawn in the middle
    const [minX, minY, maxX, maxY] = bboxOfRing(green);
    for (let x = minX; x < maxX; x += 12) {
      for (let y = minY; y < maxY; y += 12) {
        const p = [x + rr(-4, 4), y + rr(-4, 4)];
        if (!inRing(p, green)) continue;
        if (pondFeatures.some((pd) => inRing(p, pd))) continue;
        const dc = Math.hypot(p[0] - c[0], p[1] - c[1]);
        const edge = Math.min(maxX - minX, maxY - minY) / 2;
        // dense near the corners and edges, sparse across the lawn
        const pTree = dc > edge * 0.62 ? 0.62 : dc > edge * 0.38 ? 0.26 : 0.05;
        if (rand() < pTree) treeFeatures.push(p);
      }
    }
  }
  // --- the civic buildings ---------------------------------------------------
  // A town is not only its commerce. The meeting house, the town hall and the
  // market hall are the three buildings everybody in a colonial port could
  // name, and they belong on the squares, where they cannot collide with a
  // tax lot. They also give the skyline of a low town something to be about:
  // a white spire above the roofs is worth more than another six-storey block.
  // THE TOWN HALL GOES WHERE THE LAND IS DEAREST. A city puts its seat of
  // government on its most valuable corner — that is what makes it the seat.
  // `coreHeat` IS the land-value surface the whole generator prices off, so
  // ranking the squares by the heat under them puts the hall at the centre of
  // the town's gravity and the meeting house on the next square along.
  const civicSquares = PARKS_M
    .map((ring, i) => ({ ring, i, a: polygonArea([ring]), heat: coreHeat(centroid(ring)) }))
    .filter((x) => x.a < biggestA * 0.92)   // not the principal green — that is the Common
    .sort((x, y2) => y2.heat - x.heat)      // dearest ground first
    .slice(0, 2);
  civicSquares.forEach((sq, k) => {
    const c = centroid(sq.ring);
    const ang = cfg.districts[Object.keys(cfg.districts)[0]]?.bearingDeg ?? 0;
    if (k === 1) {
      // THE MEETING HOUSE. Nave, west tower, and a stepped spire — three
      // shrinking prisms, which is exactly how a New England steeple is built.
      addDeco(rect(c[0], c[1], 24, 12, ang), 11.5, 0, "civic");
      addDeco(rect(c[0], c[1], 25.4, 13.2, ang), 13.2, 11.5, "civicroof");
      const t2 = (ang * Math.PI) / 180;
      const tx = c[0] - 13 * Math.cos(t2), ty = c[1] - 13 * Math.sin(t2);
      addDeco(rect(tx, ty, 7.4, 7.4, ang), 26, 0, "civic");         // tower
      addDeco(rect(tx, ty, 6.4, 6.4, ang), 31.5, 26, "civic");      // belfry
      addDeco(rect(tx, ty, 4.6, 4.6, ang + 45), 37, 31.5, "civicroof");
      addDeco(rect(tx, ty, 2.9, 2.9, ang + 45), 42, 37, "civicroof");
      addDeco(rect(tx, ty, 1.3, 1.3, ang + 45), 46.5, 42, "civicroof");
    } else {
      // THE TOWN HALL. A long block with a clock tower and a cupola on top.
      addDeco(rect(c[0], c[1], 32, 16, ang), 14, 0, "civic");
      addDeco(rect(c[0], c[1], 33.4, 17.4, ang), 15.8, 14, "civicroof");
      addDeco(rect(c[0], c[1], 9.5, 9.5, ang), 29, 0, "civic");      // clock tower
      addDeco(rect(c[0], c[1], 7.8, 7.8, ang + 45), 34, 29, "civic"); // cupola
      addDeco(rect(c[0], c[1], 5.4, 5.4, ang + 45), 37.5, 34, "civicroof");
      addDeco(rect(c[0], c[1], 1.6, 1.6, ang), 41, 37.5, "civicroof");
    }
  });

  // --- THE LANDMARKS ---------------------------------------------------------
  //
  // Measured on the generated city: the tallest building beat the second
  // tallest by three per cent, and there were seven local maxima above sixty
  // per cent of the peak. That is not a skyline, it is a comb. Every real
  // town has a handful of buildings that are the answer to "which one is
  // that" from the water, and none of them are the tallest by a nose.
  //
  // The rule for each of them is the rule the real one was built by — the
  // tower goes on the most land under the dearest ground, the light goes at
  // the harbour mouth, the elevators go where the deep water meets the rail.
  // Nothing here is placed by hand, so every seed gets its own.
  {
    // THE PEAK. A real tax lot, not scenery: it has a BBL, an owner and a
    // price, and you can buy it. It is the site with the most land under the
    // dearest ground, which is how the tallest building in a city actually
    // gets chosen — and it is tallest by a third, not by three per cent,
    // because that is the difference between a landmark and a tall building.
    const site = builtLots.filter((x) => x.areaM2 > 400)
      .sort((a, b) => (b.h ** 2 * Math.sqrt(b.areaM2)) - (a.h ** 2 * Math.sqrt(a.areaM2)))[0];
    if (site) {
      const tallest = builtLots.reduce((m, x) => Math.max(m, x.floors), 0);
      // Tallest by a third, and capped: this is a harbour town with a
      // sixteen-metre median, not a financial capital. Fifty-two floors is
      // Hartford or Tulsa — a building the whole state knows — and it is the
      // right ceiling for a city this size. Above that it stops being the
      // landmark and starts being a different city.
      const want = Math.min(DZ.peakCap, Math.max(site.floors + 8, Math.round(tallest * rr(1.26, 1.46))));
      const pp = site.pf.properties;
      pp.numfloors = want;
      pp.bldgarea = Math.round((pp.bldgarea / Math.max(1, site.floors)) * want);
      pp.assesstot = pp.assessland + Math.round(pp.bldgarea * rr(200, 340) * 0.45);
      pp.landmark = "peak";
      const bf = buildings.features[site.bi];
      if (bf) {
        bf.properties.heightroof = +((want * 3.55 + rr(2, 6)) * 3.28084).toFixed(1);
        // A TOWER IS SLENDER. Left on its own plate the peak came out as a
        // fifty-storey slab the width of the block, which is a car park with
        // windows. Nobody builds that: above about thirty floors the lift
        // core, the daylight and the wind all argue for a small plate, and
        // slenderness is most of why a tall building looks tall. So the
        // footprint is pulled in toward its own centre and the lot keeps the
        // rest as its plaza — which is exactly the trade the zoning bonus
        // that produced these towers was written to buy.
        const ring = bf.geometry.coordinates[0];
        let cx = 0, cy = 0;
        for (let k = 0; k < ring.length - 1; k++) { cx += ring[k][0]; cy += ring[k][1]; }
        cx /= ring.length - 1; cy /= ring.length - 1;
        const f = want > 40 ? 0.52 : want > 28 ? 0.62 : 0.74;
        bf.geometry.coordinates[0] = ring.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f]);
        pp.bldgarea = Math.round(pp.bldgarea * f * f);
        pp.assesstot = pp.assessland + Math.round(pp.bldgarea * rr(220, 360) * 0.45);
      }
    }

    const gc = cfg.cores[0]?.xy ?? [0, 0];

    // THE ELEVATORS. Where the deep water meets the rail: a head house and a
    // rank of cylinders, which the renderer draws as many-sided prisms. Grain
    // silos are the one industrial building that is taller than the district
    // around it, and a working harbour without them is a marina.
// THE GRAIN ELEVATORS GO WITH THE REST OF THE HARBOUR — see PIERS_M above.
    // These were the tallest industrial structures on the waterfront at 30-37m,
    // a rank of silos on the quay, and they are exactly the "dock-looking"
    // thing that was asked to come off.
  }


  // STREET FURNITURE. A rail runs the whole waterfront; the benches are
  // placed further down, once the promenade has been added to the walks.
  // Both are the kind of thing you only notice when it is missing — an
  // esplanade with nothing to lean on is a drawing of an esplanade.
  const benchFeatures = [];
  const railFeatures = [];
  for (let i = 0; i < innerRing.length; i++) {
    const a = innerRing[i], b = innerRing[(i + 1) % innerRing.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    // innerRing came out of offsetInward, which is one output vertex per input
    // vertex, so COAST_M[i] is this vertex's own point on the shoreline. Walk
    // BOTH edges together — holding q at the segment's start vertex made the
    // rail wander back toward that corner across a long run of seawall.
    const qa = COAST_M[i % COAST_M.length], qb = COAST_M[(i + 1) % COAST_M.length];
    for (let d = 0; d < len; d += 3.2) {
      const t = d / len;
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const qx = qa[0] + (qb[0] - qa[0]) * t, qy = qa[1] + (qb[1] - qa[1]) * t;
      railFeatures.push({ p: [px * 0.45 + qx * 0.55, py * 0.45 + qy * 0.55], r: ang });
    }
  }

  // NO WALK CROSSES OPEN WATER. The cross paths run corner-to-centre and the
  // pond is deliberately offset from centre, so one of the four always cut
  // straight through it — and now that the walks are laid as real surfaces
  // above the pond rather than as a thin line under it, the result was a
  // gravel causeway across the middle of the lake.
  //
  // Split each polyline into the runs that stay on dry land, keeping the
  // original vertices so long straight walks stay long: the bench pass
  // downstream measures segment length, and a path chopped into two-metre
  // samples would never get a bench again.
  if (pondFeatures.length) {
    const dry = (p) => !pondFeatures.some((pd) => inRing(p, pd));
    const out = [];
    for (const line of pathFeatures) {
      let run = [];
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(len / 1.5));
        let prev = a, prevDry = dry(a);
        if (prevDry && !run.length) run.push(a);
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const pDry = dry(p);
          if (pDry !== prevDry) {
            // the shoreline crossing, to within the sample step
            const edge = [(prev[0] + p[0]) / 2, (prev[1] + p[1]) / 2];
            if (prevDry) { run.push(edge); if (run.length > 1) out.push(run); run = []; }
            else run = [edge];
          }
          prev = p; prevDry = pDry;
        }
        if (prevDry) run.push(b);
      }
      if (run.length > 1) out.push(run);
    }
    pathFeatures.length = 0;
    pathFeatures.push(...out);
  }

  // the bandstand on the town's principal green
  if (biggestPark) {
    const c = centroid(biggestPark);
    // deck, a ring of posts read as a narrow drum, then a roof that oversails
    // it — the silhouette everybody recognises. The old version put a cap the
    // same width as the base and it read as an oil tank.
    const ring8 = (r2, sc = 1) => {
      const out = [];
      for (let k = 0; k < 8; k++) {
        const a2 = (k / 8) * Math.PI * 2 + 0.39;
        out.push([bx + r2 * sc * Math.cos(a2), by + r2 * sc * Math.sin(a2)]);
      }
      return out;
    };
    const bx = c[0] + 15, by = c[1];
    addDeco(ring8(5.4), 0.9, 0, "banddeck");        // the deck, a step up
    addDeco(ring8(4.1), 3.6, 0.9, "bandpost");      // the open bay between posts
    addDeco(ring8(6.2), 4.6, 3.6, "bandroof");      // the oversailing roof
    addDeco(ring8(3.0), 5.6, 4.6, "bandroof");      // and its little cupola
    addDeco(ring8(0.9), 6.6, 5.6, "bandroof");
  }
  // THE PROMENADE. The esplanade was a blank cream band; now a walk runs the
  // whole waterfront halfway between the shore road and the sea, with trees
  // on its landward side — the harbor-front everybody actually strolls.
  const promenade = innerRing.map((p, i) => {
    const q = COAST_M[i % COAST_M.length];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  });
  pathFeatures.push([...promenade, promenade[0]]);
  for (let i = 0; i < innerRing.length; i += 2) {
    const p = innerRing[i], q = COAST_M[i % COAST_M.length];
    if (rand() < 0.62) treeFeatures.push([
      p[0] * 0.7 + q[0] * 0.3 + rr(-2, 2),
      p[1] * 0.7 + q[1] * 0.3 + rr(-2, 2),
    ]);
  }

  // AN ALLÉE DOWN THE BOULEVARD. The diagonal was the widest, barest strip in
  // town. Paired street trees down both edges make it read as the grand
  // avenue it is supposed to be.
  for (const d of cfg.diagonals ?? []) {
    const t2 = (d.deg * Math.PI) / 180;
    const ux = Math.cos(t2), uy = Math.sin(t2);
    const nx2 = -uy, ny2 = ux;
    for (let u = -d.w / 2 + 8; u < d.w / 2 - 8; u += rr(13, 18)) {
      for (const side of [-1, 1]) {
        const px = d.cx + ux * u + nx2 * side * (d.h / 2 - 2.2);
        const py = d.cy + uy * u + ny2 * side * (d.h / 2 - 2.2);
        if (inRing([px, py], innerRing)) treeFeatures.push([px + rr(-1, 1), py + rr(-1, 1)]);
      }
    }
  }

  // Nothing planted may end up standing in open water. The scatter pass
  // checked, the willow pass pushed outward and trusted the arithmetic, and
  // the wobble on the pond ring meant a few of them waded in anyway.
  //
  // This runs LAST, after the promenade and the boulevard allee have had
  // their say. It used to sit up with the park scatter, which meant it
  // never saw the allee — and the diagonal cuts straight across the Common,
  // so the grandest avenue in town planted two trees in the middle of the
  // pond and left them standing there.
  for (let i = treeFeatures.length - 1; i >= 0; i--) {
    const t2 = treeFeatures[i];
    const near = pondFeatures.some((pd) => {
      const pc = centroid(pd);
      // test against the pond grown by three metres — a tree on the very lip
      // of the water is a tree in the water once it has a canopy
      return inRing([pc[0] + (t2[0] - pc[0]) * 0.93, pc[1] + (t2[1] - pc[1]) * 0.93], pd);
    });
    if (near) treeFeatures.splice(i, 1);
  }

  // BENCHES, last, so the promenade counts as a walk. A bench model faces its
  // own local +Y, which is the LEFT of the direction the walk runs, so a bench
  // set down on the left-hand verge has to be spun to look back at the path —
  // otherwise half the seats in every park stare into a hedge.
  for (const line of pathFeatures) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 9) continue;
      const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
      for (let d = rr(5, 12); d < len - 4; d += rr(22, 38)) {
        const t = d / len;
        const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
        const side = rand() < 0.5 ? 1 : -1;
        benchFeatures.push({
          p: [px + nx * side * 2.6, py + ny * side * 2.6],
          r: ang + (side > 0 ? 180 : 0),
        });
      }
    }
  }
  // And the ones that matter most: the harbour seats. These do not face the
  // walk, they face the water, because nobody sits on a waterfront bench to
  // look at the pavement behind them.
  for (let i = 0; i < innerRing.length; i += 2) {
    const p = innerRing[i], q = COAST_M[i % COAST_M.length];
    if (rand() > 0.34) continue;
    const sx = q[0] - p[0], sy = q[1] - p[1];
    const sl = Math.hypot(sx, sy) || 1;
    // local +Y must point out to sea, so the bearing is the seaward one less 90°
    benchFeatures.push({
      p: [p[0] + sx * 0.34, p[1] + sy * 0.34],
      r: (Math.atan2(sy / sl, sx / sl) * 180) / Math.PI - 90,
    });
  }

  // --- the water itself ------------------------------------------------------
  // A band of shallows follows the coast, and the waterline gets a foam
  // stroke — the two cheapest things that stop the sea reading as one flat
  // sheet of blue paint.
  const shallowsRing = offsetInward(COAST_M, -34);

  const stations = {
    type: "FeatureCollection",
    features: cfg.stations.map((s, i) => ({
      type: "Feature", id: i + 1,
      geometry: { type: "Point", coordinates: proj.toLL(s.xy) },
      properties: { stop_name: s.name, daytime_routes: s.lines, weight: s.weight },
    })),
  };

  const jobsByBlock = new Map();
  for (const f of parcels.features) {
    const p = f.properties;
    const jobs = p.bldgclass[0] === "O" ? p.bldgarea / 230
      : p.bldgclass === "E9" ? p.bldgarea / 550
      : p.bldgclass === "K2" ? p.bldgarea / 400
      : p.bldgclass === "RM" || p.bldgclass === "S1" ? p.bldgarea / 700 : 0;
    if (!jobs) continue;
    const cur = jobsByBlock.get(p.block) ?? { jobs: 0, x: 0, y: 0, n: 0 };
    const ring = f.geometry.coordinates[0];
    cur.jobs += jobs;
    cur.x += ring.reduce((s, q) => s + q[0], 0) / ring.length;
    cur.y += ring.reduce((s, q) => s + q[1], 0) / ring.length;
    cur.n++;
    jobsByBlock.set(p.block, cur);
  }
  const employment = {
    type: "FeatureCollection",
    features: [...jobsByBlock.values()].map((b, i) => ({
      type: "Feature", id: i + 1,
      geometry: { type: "Point", coordinates: [b.x / b.n, b.y / b.n] },
      properties: { jobs: Math.round(b.jobs) },
    })),
  };

  const context = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...shallowsRing.map(proj.toLL), proj.toLL(shallowsRing[0])]] },
        properties: { kind: "shallows" },
      },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[...COAST, COAST[0]]] }, properties: { kind: "land" } },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [...COAST, COAST[0]] },
        properties: { kind: "coastline" },
      },
      esplanade,
      paveland,
      ...[...PIERS_M, ...BREAKWATERS].map((ring) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...ring.map(proj.toLL), proj.toLL(ring[0])]] },
        properties: { kind: "pier" },
      })),
      // Painted turf is the kerb-inset green, not the full reservation — see
      // PARK_KERB above. The 3D lawn reads the same rings via kind:"park".
      ...PARK_GREEN_M.map((ring) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...ring.map(proj.toLL), proj.toLL(ring[0])]] },
        properties: { kind: "park" },
      })),
      // The frontage road around each park and along the boulevard. It gets
      // its own kind because it has to be paved UNDER the park, not over it —
      // drawing it with the rest of the roadway used to paint the green out.
      ...APRONS.map((ring) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...ring.map(proj.toLL), proj.toLL(ring[0])]] },
        properties: { kind: "apron" },
      })),
      // Kerb line on the painted green's outer edge — same role as the block
      // street lines, so the park stops reading as turf that runs into the lots.
      ...PARK_GREEN_M.map((ring) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [...ring.map(proj.toLL), proj.toLL(ring[0])] },
        properties: { kind: "street", cls: "park" },
      })),
      ...(cfg.diagonals ?? []).map((d) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            proj.toLL([d.cx - (d.w / 2) * Math.cos((d.deg * Math.PI) / 180), d.cy - (d.w / 2) * Math.sin((d.deg * Math.PI) / 180)]),
            proj.toLL([d.cx + (d.w / 2) * Math.cos((d.deg * Math.PI) / 180), d.cy + (d.w / 2) * Math.sin((d.deg * Math.PI) / 180)]),
          ],
        },
        properties: { kind: "street", cls: "shore" },
      })),
      ...pavementFeatures,
      ...crosswalkFeatures.map((ring) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...ring.map(proj.toLL), proj.toLL(ring[0])]] },
        properties: { kind: "crosswalk" },
      })),
      ...blockFeatures,
      ...centerFeatures,
      ...streetFeatures,
      shoreRoad,
      ...pondFeatures.map((ring) => ({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...ring.map(proj.toLL), proj.toLL(ring[0])]] },
        properties: { kind: "pond" },
      })),
      ...pathFeatures.map((line) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: line.map(proj.toLL) },
        properties: { kind: "parkpath" },
      })),
      ...benchFeatures.map((b) => ({
        type: "Feature", geometry: { type: "Point", coordinates: proj.toLL(b.p) }, properties: { kind: "bench", rot: +b.r.toFixed(1) },
      })),
      ...railFeatures.map((b) => ({
        type: "Feature", geometry: { type: "Point", coordinates: proj.toLL(b.p) }, properties: { kind: "rail", rot: +b.r.toFixed(1) },
      })),
      ...treeFeatures.map((p) => ({
        type: "Feature", geometry: { type: "Point", coordinates: proj.toLL(p) }, properties: { kind: "tree" },
      })),
      ...cfg.stations.map((s) => ({
        type: "Feature", geometry: { type: "Point", coordinates: proj.toLL(s.xy) }, properties: { kind: "station", name: s.name },
      })),
      ...cfg.labels.map((l) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: proj.toLL(l.xy) },
        properties: { kind: "label", labelKind: l.labelKind, name: l.name },
      })),
    ],
  };

  const manifest = { source: "fictional", city: cfg.name, district: cfg.district, seed: cfg.seed, lodes: true };

  // --- coverage -------------------------------------------------------------
  // The whole point of the file, measured. Sample the buildable land on a 10 m
  // lattice; a sample is ACCOUNTED FOR if it sits in a block cell, a park, or
  // the boulevard. Anything else is bare ground the player would see as a void.
  const coverage = (() => {
    const STEP = 10;
    const [minX, minY, maxX, maxY] = bboxOfRing(innerRing);
    const GRID = 60;
    const buckets = new Map();
    const key = (gx, gy) => gx * 100000 + gy;
    for (const b of blocks) {
      const [bx0, by0, bx1, by1] = bboxOfRing(b.ring);
      for (let gx = Math.floor(bx0 / GRID); gx <= Math.floor(bx1 / GRID); gx++) {
        for (let gy = Math.floor(by0 / GRID); gy <= Math.floor(by1 / GRID); gy++) {
          const k = key(gx, gy);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(b.ring);
        }
      }
    }
    let land = 0, covered = 0;
    const voids = [];
    for (let x = minX; x <= maxX; x += STEP) {
      for (let y = minY; y <= maxY; y += STEP) {
        const p = [x, y];
        if (!inRing(p, innerRing)) continue;
        land++;
        const near = buckets.get(key(Math.floor(x / GRID), Math.floor(y / GRID))) ?? [];
        if (near.some((r) => inRing(p, r))) { covered++; continue; }
        if (APRONS.some((r) => inRing(p, r))) { covered++; continue; }
        voids.push(p);
      }
    }
    return { pct: land ? (100 * covered) / land : 100, landM2: land * STEP * STEP, voidM2: voids.length * STEP * STEP, voids };
  })();

  const vac = parcels.features.filter((f) => !f.properties.bldgarea).length;
  const byD = {};
  for (const f of parcels.features) byD[f.properties.district] = (byD[f.properties.district] ?? 0) + 1;

  return {
    parcels, buildings, stations, employment, context, manifest,
    // THE GREEN, IN METRES, for the demand surface. `context` carries these as
    // lon/lat polygons for the map to draw; build.mjs needs the centres and
    // sizes in the same projected metres the lot centroids are in, and
    // reprojecting a drawn polygon back is a second answer to a question the
    // generator already knows.
    parks: cfg.parks.map((pk) => ({ xy: [pk.cx, pk.cy], w: pk.w, h: pk.h, name: pk.name })),
    stats: {
      lots: parcels.features.length,
      blocks: blockNo - 1,
      unbuiltPct: Math.round((100 * vac) / Math.max(1, parcels.features.length)),
      buildings: buildings.features.length,
      byDistrict: byD,
      reject: REJECT,
      coverage,
    },
  };
}
