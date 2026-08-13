// Shared planar geometry helpers for the data pipeline.
// All polygon work happens in a local meter projection (equirectangular
// around the district centroid) — accurate to well under a meter at CD1 scale.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = 6378137;
export function makeProjection(lon0, lat0) {
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * R;
  return {
    toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: ([x, y]) => [lon0 + x / kx, lat0 + y / ky],
  };
}

export function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function polygonArea(poly) {
  // poly: array of rings, first outer, rest holes
  let a = Math.abs(ringArea(poly[0]));
  for (let i = 1; i < poly.length; i++) a -= Math.abs(ringArea(poly[i]));
  return a;
}

export function centroid(ring) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f; cy += (y1 + y2) * f; a += f;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function bboxOfRing(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// Clip a simple polygon ring against the half-plane (dot(p,n) <= d).
// Sutherland–Hodgman; adequate for pipeline use on tax-lot-shaped rings.
export function clipRingHalfPlane(ring, nx, ny, d) {
  const out = [];
  const inside = ([x, y]) => x * nx + y * ny <= d;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ia = inside(a), ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const da = a[0] * nx + a[1] * ny - d;
      const db = b[0] * nx + b[1] * ny - d;
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out.length >= 3 ? out : null;
}

// Split a ring by the line through point p with direction (dx,dy).
// Returns [left, right] rings (either may be null).
export function splitRing(ring, p, dx, dy) {
  // normal to the cut line
  const nx = -dy, ny = dx;
  const d = p[0] * nx + p[1] * ny;
  return [clipRingHalfPlane(ring, nx, ny, d), clipRingHalfPlane(ring, -nx, -ny, -d)];
}

// Inset a convex-ish ring toward its centroid by `m` meters (approximate).
export function insetRing(ring, m) {
  const c = centroid(ring);
  const out = ring.map(([x, y]) => {
    const vx = x - c[0], vy = y - c[1];
    const len = Math.hypot(vx, vy) || 1;
    const k = Math.max(0, 1 - m / len);
    return [c[0] + vx * k, c[1] + vy * k];
  });
  return polygonArea([out]) > 1 ? out : null;
}

// Minimum distance between two segments.
function segSegDist(p1, p2, q1, q2) {
  const d1 = ptSegDist(p1, q1, q2), d2 = ptSegDist(p2, q1, q2);
  const d3 = ptSegDist(q1, p1, p2), d4 = ptSegDist(q2, p1, p2);
  return Math.min(d1, d2, d3, d4);
}
function ptSegDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Length of the shared frontage between two rings within `tol` meters —
// the buffer-and-intersect adjacency test, done directly on the boundary.
export function sharedBoundaryLength(ringA, ringB, tol) {
  let shared = 0;
  for (let i = 0; i < ringA.length; i++) {
    const a1 = ringA[i], a2 = ringA[(i + 1) % ringA.length];
    const segLen = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
    if (segLen < 1e-6) continue;
    // sample the segment; a sample point counts if within tol of B's boundary
    const steps = Math.max(2, Math.ceil(segLen / 2));
    let hit = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = [a1[0] + (a2[0] - a1[0]) * t, a1[1] + (a2[1] - a1[1]) * t];
      let dmin = Infinity;
      for (let j = 0; j < ringB.length; j++) {
        const d = ptSegDist(p, ringB[j], ringB[(j + 1) % ringB.length]);
        if (d < dmin) dmin = d;
        if (dmin <= tol) break;
      }
      if (dmin <= tol) hit++;
    }
    shared += segLen * (hit / (steps + 1));
  }
  return shared;
}

export { segSegDist, ptSegDist };

// ---------------------------------------------------------------------------
// Exact subdivision primitives.
//
// The half-plane clip above is Sutherland–Hodgman, which is only correct for
// CONVEX rings: on a concave ring it bridges across the cut and both "halves"
// end up covering the same ground. Everything below keeps the city's polygons
// convex so recursive splitting is an exact partition — no overlaps, no gaps.

const CONVEX_EPS = 1e-7;

// Is the ring convex and simple? (allows collinear vertices)
export function isConvex(ring) {
  const n = ring.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], c = ring[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < CONVEX_EPS) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

// Andrew's monotone chain.
export function convexHull(points) {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Drop vertices that add nothing: duplicates and collinear runs.
export function cleanRing(ring, tol = 0.02) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tol) out.pop();
  if (out.length < 3) return null;
  const keep = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const scale = Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    if (Math.abs(cross) / scale > 1e-4) keep.push(b);
  }
  return keep.length >= 3 ? keep : null;
}

// Inset a CONVEX ring by offsetting each edge inward and re-intersecting the
// offset lines (miter join). Exact per-edge setbacks — `dOf(edgeAngle, i)`
// may return a different distance per edge, which is how avenues end up wider
// than the side streets. Returns null if the ring would collapse or invert.
export function insetConvex(ring, dOf, maxMiter = 2.2) {
  const n = ring.length;
  if (n < 3) return null;
  const ccw = ringArea(ring) > 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) return null;
    // interior normal: left of the edge for CCW rings, right for CW
    const nx = ccw ? -ey / len : ey / len;
    const ny = ccw ? ex / len : -ex / len;
    const d = typeof dOf === "function" ? dOf(Math.atan2(ey, ex), i) : dOf;
    lines.push({ nx, ny, c: a[0] * nx + a[1] * ny + d, d });
  }
  // closest point on an offset line to p
  const foot = (L, p) => {
    const k = L.c - (p[0] * L.nx + p[1] * L.ny);
    return [p[0] + L.nx * k, p[1] + L.ny * k];
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    const v = ring[i];
    const det = L1.nx * L2.ny - L1.ny * L2.nx;
    if (Math.abs(det) < 1e-9) { out.push(foot(L2, v)); continue; } // collinear edges
    const m = [
      (L1.c * L2.ny - L2.c * L1.ny) / det,
      (L1.nx * L2.c - L2.nx * L1.c) / det,
    ];
    // A sharp corner throws its miter point far into the polygon — on an
    // acute lot that swallows the whole parcel. Past the limit, bevel the
    // corner instead: two points, one per offset line. Still convex.
    const reach = Math.hypot(m[0] - v[0], m[1] - v[1]);
    const limit = maxMiter * Math.max(L1.d, L2.d);
    if (reach > limit) { out.push(foot(L1, v), foot(L2, v)); }
    else out.push(m);
  }
  const a0 = Math.abs(ringArea(ring)), a1 = ringArea(out);
  if (Math.sign(a1) !== Math.sign(ringArea(ring)) || Math.abs(a1) < a0 * 0.02) return null;
  const cleaned = cleanRing(out);
  return cleaned && isConvex(cleaned) ? cleaned : null;
}

// Split a CONVEX ring with the line through p at `angle`. The two pieces are
// convex and partition the parent exactly — this is the one cut the whole
// city is built from.
export function splitConvex(ring, p, angle) {
  const [a, b] = splitRing(ring, p, Math.cos(angle), Math.sin(angle));
  const ca = a && cleanRing(a), cb = b && cleanRing(b);
  return [ca, cb];
}

// Longest edge of a ring — for a block, the direction the street runs.
export function longestEdgeAngle(ring) {
  let best = 0, bestLen = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > bestLen) { bestLen = len; best = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return best;
}

// Extent of a ring along a direction, and the midpoint of that extent.
export function extentAlong(ring, angle) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let lo = Infinity, hi = -Infinity;
  for (const [x, y] of ring) {
    const t = x * dx + y * dy;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return { lo, hi, span: hi - lo };
}

// A point on the ring's interior at parameter `t` along `angle`.
export function pointAt(ring, angle, t) {
  const { lo, hi } = extentAlong(ring, angle);
  const c = centroid(ring);
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const target = lo + (hi - lo) * t;
  const cur = c[0] * dx + c[1] * dy;
  return [c[0] + dx * (target - cur), c[1] + dy * (target - cur)];
}

// Perpendicular ring inset (edge-normal offset). Unlike centroid scaling,
// this guarantees the requested setback on EVERY edge — centroid scaling on
// an elongated lot barely moves the long walls, which made neighboring
// buildings kiss. Falls back to null if the offset would invert the ring.
export function insetRingPerp(ring, d) {
  const n = ring.length;
  const a0 = Math.abs(ringArea(ring));
  const c = centroid(ring);
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n], cur = ring[i], next = ring[(i + 1) % n];
    const d1x = cur[0] - prev[0], d1y = cur[1] - prev[1];
    const d2x = next[0] - cur[0], d2y = next[1] - cur[1];
    const l1 = Math.hypot(d1x, d1y) || 1, l2 = Math.hypot(d2x, d2y) || 1;
    // averaged edge normals, oriented toward the interior
    let nx = (-d1y / l1 - d2y / l2), ny = (d1x / l1 + d2x / l2);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    if ((c[0] - cur[0]) * nx + (c[1] - cur[1]) * ny < 0) { nx = -nx; ny = -ny; }
    out.push([cur[0] + nx * d, cur[1] + ny * d]);
  }
  const a1 = ringArea(out);
  if (Math.abs(a1) < a0 * 0.15 || Math.sign(a1) !== Math.sign(ringArea(ring))) return null;
  return out;
}
