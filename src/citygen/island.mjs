// AN ISLAND FROM A NUMBER.
//
// cities.mjs hand-draws two islands and says, in its own header, that the
// island does not move — that the coast, the districts and the street names
// are what make New Alden New Alden. That was written when there were two
// islands and no size dial, and it is a good argument for KEEPING those two
// exactly as they are. It is not an argument against a third door marked
// "somewhere else", and this file is that door: everything cities.mjs writes
// by hand, generated from one seed.
//
// WHAT THIS EMITS is a config of exactly the shape cities.mjs exports — coast,
// cores, partition, districts, parks, diagonals, piers, cranes, ships,
// breakwaters, stations, labels, avenues, streets. Nothing downstream knows
// the difference: scaleCity scales it, generateCity cuts it, buildCityData
// tabulates it, the map draws it and the engine plays it, all untouched.
//
// THE FOUR THINGS THAT ARE ACTUALLY HARD, and how each is settled:
//
//   1. The coast has to be a SIMPLE polygon or the whole pipeline is garbage.
//      It is built as a radius r(θ) about the origin, sampled at monotonically
//      increasing θ, then run through an affine map. A ring with r > 0 and θ
//      monotone cannot cross itself, and an affine map is a bijection, so it
//      still cannot afterwards. Simplicity is a property of the construction
//      here, not something checked for and hoped about.
//
//   2. The coast must not be STEEPER than the esplanade offset can survive.
//      generateCity insets the coast by `esplanade` metres with offsetInward(),
//      which decides which way is inland by asking whether a vertex normal
//      points at the ring's centroid. On a wall that runs nearly radially —
//      the wall of a river notch — that test is nearly degenerate and the
//      offset folds. So the profile carries a hard bound on |d(ln r)/dθ|, and
//      an estuary is a wide funnel rather than a hairline fjord, which is what
//      an estuary is anyway. See COAST_SLOPE_MAX.
//
//   3. The BSP leaves have to TILE. They do, structurally — a BSP tree's leaves
//      partition the plane by construction — but the districts also have to
//      each get real land, and "real land" is a measurement, not an assumption.
//      Every cut here is placed at a QUANTILE of the land actually sampled on
//      the far side of it, so a 30% band is 30% of the dry ground and not 30%
//      of a bounding box that is half sea.
//
//   4. The island has to be about the same SIZE as the authored two, or the
//      size dial stops meaning the same thing on it. Measured: the New Alden
//      coast ring is 1.495 km2 and Kestrel Point's is 1.386, and they build
//      1,378-1,421 and 1,283-1,360 lots at scale 1.0. This targets that band —
//      and it targets the area of the ring the generator ACTUALLY uses, which
//      is the crinkled and Chaikin-smoothed one, not the control polygon.
//
// DETERMINISM. A save stores (island, seed, size, build-out) and rebuilds the
// town from it, so the same seed must give a byte-identical island forever.
// Every draw here comes from a mulberry32 stream seeded off the island seed,
// and nothing touches the generator's own stream. The streams are SPLIT by
// concern — the names roll from one, the coast from another, the piers from a
// third — so that adding a pier does not rename the town.
import { mulberry32, ringArea, centroid, bboxOfRing } from "./geom.mjs";
import { chaikin, crinkle, inRing, rect, offsetInward } from "./citygen.mjs";
import { cut } from "./cities.mjs";

const TAU = Math.PI * 2;
const R2D = 180 / Math.PI;

/**
 * A SEPARATE STREAM PER CONCERN.
 *
 * One stream for the whole island would mean that changing how many piers get
 * built shifts every draw after it, so a seed's town would silently become a
 * different town on any edit to this file. The salt is mixed through the same
 * avalanche demand.ts uses on its string hashes, for the same reason: seeds
 * that differ in their low bits must not produce neighbouring streams.
 */
function stream(seed, salt) {
  let h = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return mulberry32((h ^ (h >>> 16)) >>> 0);
}

/** The small change every draw in this file is made of. */
function dice(rand) {
  const f = (a, b) => a + (b - a) * rand();
  return {
    rand,
    f,
    i: (a, b) => Math.min(b, a + Math.floor((b - a + 1) * rand())),
    sign: () => (rand() < 0.5 ? -1 : 1),
    chance: (p) => rand() < p,
    pick: (arr) => arr[Math.floor(rand() * arr.length) % arr.length],
    /** n distinct members, in the order the table lists them. */
    some: (arr, n) => {
      const a = [...arr];
      // Fisher-Yates on a copy, then re-sort the survivors into table order so
      // a street list reads like a street list and not like a shuffled deck.
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      const keep = new Set(a.slice(0, Math.min(n, a.length)));
      return arr.filter((x) => keep.has(x));
    },
  };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Shortest distance from a point to a ring's boundary. */
function distToRing(p, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const L2 = ex * ex + ey * ey;
    let t = L2 > 1e-12 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p[0] - (a[0] + ex * t), p[1] - (a[1] + ey * t));
    if (d < best) best = d;
  }
  return best;
}

// ---------------------------------------------------------------- THE COAST

/**
 * Periodic value noise in θ: n control values around the circle, interpolated.
 * Two of these at different n are the "couple of octaves" — the coarse one
 * makes lobes the size of a neighbourhood, the fine one makes the coves and
 * points between them. Value noise rather than a sum of sines because a Fourier
 * sum has a rotational symmetry you can see from the air.
 *
 * `kink` DECIDES WHETHER THIS IS A COAST OR A POTATO, and it took two rounds of
 * screenshots to see it. Smoothstep interpolation is C1 everywhere, so every
 * inch of the outline is a gentle curve, and an outline made only of gentle
 * curves reads as a boulder however deep its bays are — which is exactly what
 * the first two versions of this looked like on the map. A real shoreline is
 * runs that are locally straight meeting at corners. Linear interpolation gives
 * that: the coarse octave is kinked, the fine one is not, and crinkle and
 * Chaikin round the corners afterwards by about as much as the sea would.
 */
function valueRing(rand, n, kink) {
  const v = Array.from({ length: n }, () => rand() * 2 - 1);
  return (th) => {
    const t = ((th / TAU) % 1 + 1) % 1;
    const x = t * n, i = Math.floor(x), f = x - i;
    const s = kink ? f : f * f * (3 - 2 * f);
    return v[i % n] * (1 - s) + v[(i + 1) % n] * s;
  };
}

/**
 * A raised cosine centred on th0, reaching zero at wNeg behind and wPos ahead.
 * 1 at the middle, 0 at both edges, and C1 throughout.
 *
 * The two half-widths are separate because a symmetric bay is a bite out of a
 * biscuit. Every real bight on this coast has a long gentle arm on one side and
 * a short blunt one on the other — that asymmetry is most of what makes a
 * harbour look like a harbour instead of a semicircle.
 */
function lobe(th, th0, wNeg, wPos = wNeg) {
  let d = th - th0;
  d = Math.atan2(Math.sin(d), Math.cos(d));  // wrap into (-pi, pi]
  const w = d < 0 ? wNeg : wPos;
  if (Math.abs(d) >= w) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / w));
}

/**
 * HOW STEEP A COAST IS ALLOWED TO BE, as |d(ln r)/dθ|.
 *
 * This is not a look setting, it is the condition under which offsetInward()
 * — the esplanade offset generateCity runs on every coast — picks the right
 * side. That function orients each vertex normal by testing it against the
 * direction to the ring's centroid. On a boundary running at slope m = |dr/dθ|
 * / r, the inward normal's radial component is 1/sqrt(1 + m^2), which is the
 * margin the test has to work with. At m = 3.2 the margin is 0.30 — comfortable
 * against the crinkle that gets added afterwards. Above about m = 6 the test
 * starts flipping vertex to vertex and the inset ring self-intersects.
 *
 * The profile is smoothed on ln r until it clears the bound. This IS
 * load-bearing, not a rail sitting unused: at the feature depths this settled
 * on, the repair fires on roughly one island in twelve (10 passes on seed
 * 1234567, 0 on the other eleven verification islands), and it is what keeps
 * the two ladders below from having to soften a coast that only needed its one
 * steepest wall easing.
 */
const COAST_SLOPE_MAX = 4.6;

/**
 * THE LANDMASS, at unit radius.
 *
 * Radial perturbation with two octaves of value noise, plus four deliberate
 * features because noise alone makes a potato and not a place:
 *
 *   the HARBOUR — a broad shallow bight. Deep water reaching into the land is
 *     the only reason any of these towns exists, and the whole map is oriented
 *     off it: the old town sits on it, the dominant core sits behind it, the
 *     piers hang off it and the breakwater closes it.
 *   a COVE — a second, smaller bay somewhere else on the ring, so the harbour
 *     is not the only concavity and the island does not read as a disc with a
 *     bite out of it.
 *   the HEADLAND — an outward point. It carries the lighthouse, and it is what
 *     stops the silhouette being convex-everywhere.
 *   the RIVER MOUTH — a notch that is deep and wide-mouthed and narrows as it
 *     goes in, which is an ESTUARY: the arc a fixed angular wedge cuts is
 *     proportional to the radius, so the channel funnels inland on its own.
 *
 * The four sit at angles drawn with a guaranteed 1.4 rad of clear water
 * between any two, so they never stack into one enormous dent.
 */
function profile(D) {
  const oct1 = valueRing(D.rand, D.i(5, 8), true);
  const oct2 = valueRing(D.rand, D.i(13, 19), false);
  // THE NOISE IS THE MINOR GEOGRAPHY, NOT THE SHAPE. It ran at 0.115-0.165 of
  // the radius on the first cut, which is the same order as the features, and
  // the result was that every island came out a lumpy potato: nothing in the
  // outline was legible as a bay or a point because the noise was arguing with
  // all four of them at once. It is the coves and points BETWEEN the named
  // features, and it has to be quieter than they are.
  const a1 = D.f(0.085, 0.135), a2 = D.f(0.028, 0.050);

  // Four well-separated bearings. Three gaps drawn from [1.25, 1.62] leave the
  // fourth at least TAU - 4.86 = 1.42 rad, so no pair is ever closer than 1.25.
  const base = D.f(0, TAU);
  const g1 = D.f(1.25, 1.62), g2 = D.f(1.25, 1.62), g3 = D.f(1.25, 1.62);
  const slots = [base, base + g1, base + g1 + g2, base + g1 + g2 + g3];
  // Which feature lands on which bearing is the seed's business.
  const order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(D.rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const th = { harbour: slots[order[0]], cove: slots[order[1]], headland: slots[order[2]], river: slots[order[3]] };

  // HOW BIG A FEATURE HAS TO BE TO READ AS ONE. These started at roughly half
  // these depths and the islands came out as discs — rendered on the map at the
  // scale the game plays at, a bight 130 m deep across 500 m of shore is not a
  // harbour, it is a dent. A quarter to a half of the radius is what makes an
  // outline you can point at and name.
  // `sk` is how lopsided a feature is: one arm long, the other short.
  const sk = () => D.f(0.42, 0.78);
  const dHarb = D.f(0.30, 0.42), wHarb = D.f(0.55, 0.80), kHarb = sk();
  const dCove = D.f(0.15, 0.26), wCove = D.f(0.28, 0.44), kCove = sk();
  const dHead = D.f(0.26, 0.40), wHead = D.f(0.26, 0.40), kHead = sk();
  // The estuary, and the one feature whose width is not a free choice. Its
  // half-width is floored against its depth so the walls stay inside
  // COAST_SLOPE_MAX: at the steepest point of a raised cosine the slope is
  // d*pi / (2*w*(1 - d - slack)), and the second term below is that solved for
  // w at the bound. Deeper river, wider mouth — which is how rivers work, and
  // which is why the thing that comes out is an estuary rather than a fjord.
  const dRiv = D.f(0.38, 0.54);
  const wRiv = Math.max(D.f(0.40, 0.62), (dRiv * Math.PI) / (2 * COAST_SLOPE_MAX * (1 - dRiv - 0.18)));
  const kRiv = sk();

  // `soft` scales the FEATURES and leaves the noise alone. Some shapes cannot
  // carry an esplanade at every size the game builds them at — see the ladder
  // in coastline() — and the answer to one of those is not a different random
  // island, it is the same island with its bays taken in until the offset
  // survives. Softening the noise too would give a smooth blob back, which is
  // the failure this is trying to avoid.
  const make = (soft) => (t) => 1
    + a1 * oct1(t) + a2 * oct2(t)
    - soft * dHarb * lobe(t, th.harbour, wHarb * kHarb, wHarb)
    - soft * dCove * lobe(t, th.cove, wCove, wCove * kCove)
    - soft * dRiv * lobe(t, th.river, wRiv * kRiv, wRiv)
    + soft * dHead * lobe(t, th.headland, wHead, wHead * kHead);

  return { make, th, wHarb, wRiv };
}

/** Circular moving average on ln r, until the profile clears the slope bound. */
function flattenSteep(rs) {
  const n = rs.length, dth = TAU / n;
  let fired = 0;
  for (let pass = 0; pass < 24; pass++) {
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const a = rs[(i - 1 + n) % n], b = rs[(i + 1) % n];
      worst = Math.max(worst, Math.abs(Math.log(b / a)) / (2 * dth));
    }
    if (worst <= COAST_SLOPE_MAX) break;
    fired++;
    const out = rs.slice();
    for (let i = 0; i < n; i++) {
      out[i] = Math.exp(
        0.25 * Math.log(rs[(i - 1 + n) % n]) + 0.5 * Math.log(rs[i]) + 0.25 * Math.log(rs[(i + 1) % n]),
      );
    }
    for (let i = 0; i < n; i++) rs[i] = out[i];
  }
  return fired;
}

/** Resample a closed ring at even arc length — `n` points, evenly spaced along the shore. */
function evenSpaced(fine, n) {
  const cum = [0];
  for (let i = 1; i <= fine.length; i++) cum.push(cum[i - 1] + dist(fine[i - 1], fine[i % fine.length]));
  const total = cum[fine.length];
  const out = [];
  let k = 0;
  for (let j = 0; j < n; j++) {
    const want = (total * j) / n;
    while (k < fine.length - 1 && cum[k + 1] < want) k++;
    const seg = cum[k + 1] - cum[k] || 1;
    const t = (want - cum[k]) / seg;
    const a = fine[k], b = fine[(k + 1) % fine.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Does a closed ring cross itself anywhere? */
function selfCrosses(ring) {
  const n = ring.length;
  const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[j], p4 = ring[(j + 1) % n];
      const d1 = side(p3, p4, p1), d2 = side(p3, p4, p2), d3 = side(p1, p2, p3), d4 = side(p1, p2, p4);
      if (d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0) return true;
    }
  }
  return false;
}

/**
 * HOW COARSE THE CONTROL POLYGON HAS TO BE, and why it is not a look setting.
 *
 * generateCity offsets the coast inward by `esplanade` metres with
 * offsetInward(), which moves each vertex along a normal averaged from its two
 * neighbours. YOU CANNOT PUSH A POLYLINE IN BY MORE THAN ITS OWN VERTEX
 * SPACING without the vertices changing places — two neighbours 12 m apart,
 * each shoved 26 m inland, come out in the wrong order and the ring has a
 * bowtie in it. That bowtie is very nearly zero area, so it is invisible on the
 * map; it is not invisible to clipToShore(), which reads the inset ring segment
 * by segment and takes the seaward normal from the winding — a reversed segment
 * clips its cell from the WRONG SIDE and eats good land.
 *
 * MEASURED, on 24 islands at three size settings each (72 rings) as the target
 * spacing of the control polygon was swept:
 *
 *     150 m -> 31 control points, 33 bowties, median built edge 15.4 m
 *     210 m -> 22 control points, 13 bowties, median built edge 20.8 m
 *     240 m -> 19 control points,  6 bowties, median built edge 23.6 m
 *     320 m -> 16 control points,  6 bowties, median built edge 28.2 m
 *
 * Coarsening helps and never finishes the job — at 320 m the coast has lost its
 * bays and there are still bowties. The two authored islands sit at 226 m and
 * 298 m mean spacing and Kestrel Point produces one of these at seed 424242, so
 * this is not a fault this file introduced; it is one it has to actually close
 * rather than sit above the rate of.
 *
 * So it is closed by TESTING instead of by hoping: a candidate coast is built,
 * offset by the esplanade AT EVERY SIZE THE GAME CAN BUILD IT AT, and accepted
 * only if all five rings come back simple. If one does not, the next rung of
 * the ladder is tried. Checking every size is load-bearing rather than
 * cautious — crinkle's `len < 70` skip and its `min(amp, len*0.22)` clamp are
 * both absolute metres against an edge length that scales, so a coast that is
 * clean as a City is not thereby clean as a Hamlet.
 */
const SPACING_LADDER = [1.00, 1.14, 1.30, 0.88, 1.48, 0.78, 1.70];
/**
 * AND WHEN NO SPACING WORKS, THE SHAPE IS THE PROBLEM.
 *
 * Coarsening the control polygon cannot save every island, because the deepest
 * failure is not vertex spacing at all — it is that offsetInward() decides
 * which way is inland by asking whether a vertex normal points at the ring's
 * CENTROID, and on the wall of a deep narrow inlet that question has no answer.
 * Measured: with the spacing ladder alone, 21 of 200 seeds — 10.5% — ran out of
 * rungs and would have shipped a folded esplanade.
 *
 * So the second ladder takes the bays in. The features scale down together, the
 * noise does not, and the first rung that survives is the island. Measured with
 * both ladders: see the note in islandConfig.
 *
 * THE REAL FIX IS ONE LINE AND IS NOT MADE HERE. offsetInward should take its
 * inward direction from the ring's WINDING — for a counter-clockwise ring the
 * interior is to the left of every edge, full stop — instead of from the
 * centroid, which is only a heuristic and is exactly the heuristic that fails
 * on a concave coast. Measured on the two authored islands at all five sizes
 * and six seeds: the two rules disagree on 1 to 3 vertices out of 128-168, and
 * where they disagree the shipped rule puts the vertex 2 x esplanade on the
 * WRONG SIDE — which is the source of the one bowtie Kestrel Point produces at
 * seed 424242 today. It is a live bug in the shipped generator and it is not
 * fixed in this change, because the inset ring feeds clipToShore and therefore
 * every block boundary on both authored islands: correcting it moves their lot
 * lines, and continueRun() refuses any save whose deeds no longer land on
 * parcels that exist. That is a save-migration decision, not a coastline one.
 */
const DEPTH_LADDER = [1.00, 0.86, 0.72, 0.58, 0.44];
/** The size multipliers in SIZES. Restated rather than imported: this is a list of what must hold. */
const SIZE_KS = [0.55, 0.78, 1.0, 1.45, 2.0];

/**
 * THE COAST, sized so that the ring the generator actually builds is the right
 * landmass.
 *
 * generateCity does not use the control polygon: it crinkles it (fractal
 * midpoint displacement, twice) and then Chaikin-smooths it, and Chaikin loses
 * a couple of per cent of the area every time — 1.7% at the spacing this
 * settles on, measured. So the target is applied to the SMOOTHED ring, by a
 * three-step fixed point: build, measure, rescale.
 *
 * The crinkle is reproducible here because it is the very first thing in
 * generateCity to draw from mulberry32(cfg.seed). That coupling is what lets
 * every pier, label and station below be placed against the real shoreline
 * rather than against an approximation of it, and it is what lets the bowtie
 * test above test the actual ring instead of a proxy for it. If a rand() call
 * is ever inserted ahead of the crinkle in generateCity, this file's placements
 * go slightly stale — nothing breaks, but the margins are what carry it, so
 * they are kept wide.
 */
function coastline(seed, D, areaTarget, coastAmp, esplanade, spacing0) {
  const { make, th, wHarb, wRiv } = profile(D);

  // An island is not round. The affine below stretches one axis and squeezes
  // the other by the reciprocal, so it changes the SHAPE and not the area, and
  // it is a bijection, so a ring that did not cross itself still does not.
  // The authored two run 1.72:1 (New Alden, east-west) and 1:1.75 (Kestrel
  // Point, a north-south peninsula); this covers that ground.
  const el = D.f(0.72, 1.40), psi = D.f(0, TAU);
  const co = Math.cos(psi), si = Math.sin(psi);
  const xform = ([x, y]) => {
    const sx = x * el, sy = y / el;
    return [sx * co - sy * si, sx * si + sy * co];
  };

  const N = 720;
  let best = null;
  for (let depth = 0; depth < DEPTH_LADDER.length && !best; depth++) {
    const r = make(DEPTH_LADDER[depth]);
    const rs = new Array(N);
    for (let i = 0; i < N; i++) rs[i] = Math.max(0.30, Math.min(1.55, r((i * TAU) / N)));
    const smoothed = flattenSteep(rs);

    const at0 = (t) => {
      // the profile, read off the smoothed table so a feature point and the
      // ring it sits on can never disagree
      const x = (((t / TAU) % 1) + 1) % 1 * N;
      const i = Math.floor(x), f = x - i;
      const rr = rs[i % N] * (1 - f) + rs[(i + 1) % N] * f;
      return xform([rr * Math.cos(t), rr * Math.sin(t)]);
    };
    const fine = [];
    for (let i = 0; i < N; i++) fine.push(at0((i * TAU) / N));
    const fineArea = Math.abs(ringArea(fine));
    const finePerim = fine.reduce((s, p, i) => s + dist(p, fine[(i + 1) % fine.length]), 0);

    for (let rung = 0; rung < SPACING_LADDER.length; rung++) {
      const spacing = spacing0 * SPACING_LADDER[rung];
      // Size it. Three passes; the only nonlinearity is crinkle's fixed
      // amplitude against an edge length that is scaling under it.
      let g = Math.sqrt(areaTarget / fineArea), ring = null, built = null;
      for (let pass = 0; pass < 3; pass++) {
        // ROUNDED TO THE METRE HERE, not on the way out. The config coast ships
        // as integers — an island is a list of numbers a person may one day
        // read — and rounding after the acceptance test means testing a ring
        // that is not the one the generator gets. Measured: it is not a
        // theoretical gap, seed 424242 passed unrounded and shipped a bowtie.
        ring = evenSpaced(fine.map(([x, y]) => [x * g, y * g]), Math.max(16, Math.round((finePerim * g) / spacing)))
          .map(([x, y]) => [Math.round(x), Math.round(y)]);
        built = chaikin(crinkle(ring, mulberry32(seed >>> 0), coastAmp), 1);
        const a = Math.abs(ringArea(built));
        if (Math.abs(a / areaTarget - 1) < 0.004) break;
        g *= Math.sqrt(areaTarget / a);
      }
      // The acceptance test: the esplanade offset must be a simple ring at
      // every size the player can ask for.
      const ok = SIZE_KS.every((k) => {
        const c = chaikin(crinkle(ring.map(([x, y]) => [x * k, y * k]), mulberry32(seed >>> 0), coastAmp * k), 1);
        return !selfCrosses(offsetInward(c, esplanade * k));
      });
      // The last rung of the last ladder is taken whether it passed or not.
      // There is no third thing to try and a coast with a bowtie in it is a far
      // better outcome than a start button that does nothing, so `ok` is
      // reported rather than thrown — the harness reads it off `plan`.
      const last = depth === DEPTH_LADDER.length - 1 && rung === SPACING_LADDER.length - 1;
      if (ok || last) {
        best = { ring, built, smoothed, rung, depth, ok, scale: g, at: (t) => { const p = at0(t); return [p[0] * g, p[1] * g]; } };
        break;
      }
    }
  }
  return { ...best, th, wHarb, wRiv };
}

// ------------------------------------------------------------------- NAMES
//
// Anglo-colonial-American port names, built the way the real ones were: an
// English place-element for the stem and another for the ending, which is how
// you get Salem, Marblehead, Newburyport and Bristol on the same chart. The
// register to hit is "Kestrel Point", "New Alden", "Harborside", "Ardmore
// Green", "Denholm St" — plain, Protestant, and a little damp.

const STEM = [
  "Ald", "Ash", "Bram", "Cald", "Corb", "Denh", "Ell", "Fen", "Gran", "Hart",
  "Lang", "Mar", "Nor", "Orm", "Pemb", "Quin", "Rad", "Sal", "Thorn", "Vane",
  "Wend", "Yar", "Brack", "Chad", "Dun", "Esk", "Fal", "Hal", "Ing", "Kirk",
  "Lyn", "Mer", "Ott", "Pres", "Rook", "Stan", "Tarr", "Whit", "Barr", "Ced",
  "Glend", "Harr", "Melv", "Rand", "Sedg", "Trem", "Wick", "Ayl", "Bram", "Cort",
];
const TAILS = [
  "ley", "ford", "ton", "wick", "bury", "mere", "stead", "field", "worth",
  "bourne", "don", "ham", "by", "dale", "gate", "holm", "ridge", "cott",
  "well", "stone", "marsh", "combe", "cliff", "moor", "thorpe", "wold",
];
/** Endings that already say "port", so the name takes no suffix of its own. */
const SEA_TAILS = ["haven", "port", "mouth", "wich"];

const ISLAND_SUFFIX = ["Point", "Head", "Neck", "Bight", "Reach", "Island", "Haven", "Landing", "Roads", "Sound", "Ferry"];

/** Surname streets, one per letter — a filled-in nineteenth-century grid runs alphabetically. */
const ALPHA_STREETS = [
  "Ashby", "Bancroft", "Calvert", "Denholm", "Everett", "Fenwick", "Granby",
  "Hartwell", "Ingram", "Jarvis", "Kendrick", "Larkin", "Merrow", "Norbury",
  "Ordway", "Prescott", "Quimby", "Rutland", "Sedgwick", "Tilden", "Upsall",
  "Vance", "Wadsworth", "Yardley",
];
const OLD_STREETS = [
  "Water St", "Front St", "Dock Sq", "Custom House St", "Pearl St", "Broad St",
  "Batterymarch", "India Row", "Sloop Alley", "Cooper Ln", "Salt Ln", "Ropewalk",
  "Long Wharf Rd", "Ferry Slip", "Bell Alley", "Meeting St", "Anchor Ln",
  "Quaker Ln", "Beaver St", "Stone St", "Hanover Row", "Gouverneur Ln",
  "Coenties Slip", "Bethel St",
];
const IND_STREETS = [
  "Drydock Ave", "Gantry St", "Cooperage Rd", "Packet St", "Chandlery Row",
  "Foundry St", "Tannery Rd", "Coal Wharf", "Gasworks Ln", "Slipway Rd",
  "Kiln St", "Boilerhouse Ln", "Caulkers Ln", "Fulton Wharf", "Sailmakers Row",
];
const CORE_STREETS = [
  "Bank St", "Exchange Pl", "State St", "Commerce St", "Union St", "Milk St",
  "Federal St", "Court St", "Liberty St", "Trinity Pl", "Vesey St", "Cortland St",
  "Assembly St", "Post Office Sq",
];
const AVENUE_POOL = [
  "Commonwealth Ave", "Tremont Ave", "Lexington Ave", "Bowery Ave", "Park Ave",
  "Franklin Ave", "Chestnut Ave", "Beacon Ave", "Cathedral Ave", "Liberty Ave",
  "Federal Ave", "Washington Ave", "State Ave", "Bay Ave", "Highland Ave",
  "Concord Ave", "Harbour Ave",
];
const DEFAULT_STREETS = ["Market St", "Church St", "Mill St", "Bridge St", "School St", "Spring St"];

const OLD_DISTRICT = ["The Landing", "Harborside", "The Wharves", "Old Town", "The Quays", "Dockhead", "The Slips", "The Battery", "Shipside"];
const CORE_DISTRICT = ["The Exchange", "The Change", "Bankside", "Custom House", "Merchants Row", "The Counting House", "The Cross"];
const IND_DISTRICT = ["The Yards", "Millside", "The Ropewalk", "Foundry Flats", "Tannery Flats", "The Gasworks", "The Drydocks"];
const RESI_DISTRICT = ["The Brownstones", "The Terraces", "The Crescents", "Uptown", "The Rows"];

const COMPASS = ["East", "Northeast", "North", "Northwest", "West", "Southwest", "South", "Southeast"];
const octant = (dx, dy) => COMPASS[(((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8)];

/** The two islands that already exist. A generated one is never allowed to be either. */
const TAKEN = new Set(["new alden", "kestrel point"]);

/**
 * The name of the island at this seed, and the word-stock the rest of the map
 * is written from. Its own stream, so the town keeps its name through any
 * change to the geography.
 */
export function islandNaming(seed) {
  const D = dice(stream(seed >>> 0, 0x4e414d45));
  const word = () => D.pick(STEM) + D.pick(TAILS);
  const seaWord = () => D.pick(STEM) + D.pick(SEA_TAILS);

  let name = "";
  for (let tries = 0; tries < 8 && (!name || TAKEN.has(name.toLowerCase())); tries++) {
    const roll = D.rand();
    if (roll < 0.18) name = "New " + word();
    else if (roll < 0.30) name = "Port " + word();
    else if (roll < 0.46) name = seaWord();
    else name = word() + " " + D.pick(ISLAND_SUFFIX);
  }
  // Belt and braces: if the tables are ever edited into a collision, shift it.
  if (TAKEN.has(name.toLowerCase())) name = name + " Ferry";

  const stem = name.replace(/^(New|Port)\s+/, "").split(" ")[0];
  const abbr = (stem.slice(0, 1) + (name.split(" ")[1] ?? stem).slice(0, 1)).toUpperCase();
  return {
    name,
    stem,
    abbr,
    slug: name.toLowerCase().replace(/[^a-z]+/g, ""),
    /** Fresh place-words for parks, rivers and avenues — not the island's own. */
    words: Array.from({ length: 8 }, word),
    D,
  };
}

/** Just the name, for a picker that has not built the island yet. */
export function islandName(seed) {
  return islandNaming(seed).name;
}

// ---------------------------------------------------------------- THE TOWN

/**
 * Which branch of `cut(px, py, deg)` a point falls on.
 *
 * The half-plane convention (neg is the left hand of travel) is easy to get
 * backwards and impossible to see in a screenshot until a district is on the
 * wrong side of the island. Every assignment below is written as "the side the
 * docks are on" and resolved through this, so there is no sign to get wrong.
 */
const sideOf = (c, p) => (p[0] * c[0] + p[1] * c[1] <= c[2] ? "neg" : "pos");
const branch = (spec, atPt, here, there) =>
  sideOf(spec, atPt) === "neg" ? { cut: spec, neg: here, pos: there } : { cut: spec, pos: here, neg: there };
const inLeaf = (hp, p) => hp.every(([nx, ny, d]) => p[0] * nx + p[1] * ny <= d);

/** The half-planes reaching each leaf of a partition — the same walk generateCity does. */
function leavesOf(node, hp = []) {
  if (typeof node === "string") return [{ district: node, hp }];
  const [nx, ny, d] = node.cut;
  return [...leavesOf(node.neg, [...hp, [nx, ny, d]]), ...leavesOf(node.pos, [...hp, [-nx, -ny, -d]])];
}

/**
 * A whole island, from a seed.
 *
 * Emitted at scale 1.0 — SIZES/scaleCity multiplies it afterwards, exactly as
 * it does the two authored islands, so "Great City" means the same four-times-
 * the-land here as it does on New Alden.
 */
export function islandConfig(seed) {
  const s = seed >>> 0;
  const nm = islandNaming(s);

  // --- 1. the shoreline ------------------------------------------------------
  const Dc = dice(stream(s, 0xc0a57));
  // THE BAND THE TWO AUTHORED ISLANDS OCCUPY, and nothing wider. Measured: the
  // Kestrel Point coast ring is 1.386 km2 and New Alden's is 1.495, and those
  // two numbers are the endpoints here rather than a round band around them.
  // Landmass is what makes the size dial mean the same thing on every island —
  // "Great City" has to be four times the land wherever it is built.
  const areaTarget = Dc.f(1.386e6, 1.495e6);
  // Point spacing on the control polygon, before the ladder in coastline() gets
  // a say. The authored rings run 226 m and 298 m mean; this starts a little
  // finer than that because unlike them, this coast carries its bays in the
  // control polygon rather than leaving them all to the crinkle. It also stays
  // above crinkle's 70 m skip at the smallest size setting (0.55 x 215 = 118 m),
  // or a Hamlet would come out smooth and unfractured.
  const spacing = Dc.f(215, 255);
  const coastAmp = Dc.f(15, 26);
  const esplanade = Dc.f(22, 26);
  const C = coastline(s, Dc, areaTarget, coastAmp, esplanade, spacing);
  const COAST = C.built;
  const inner = offsetInward(COAST, esplanade);

  const harbourHead = C.at(C.th.harbour);          // innermost point of the bight
  const harbourMouth = (() => {                    // midpoint of the chord across it
    const a = C.at(C.th.harbour - C.wHarb), b = C.at(C.th.harbour + C.wHarb);
    return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], a, b };
  })();
  const headlandTip = C.at(C.th.headland);
  const riverHead = C.at(C.th.river);

  // --- 2. the land, sampled --------------------------------------------------
  // Every placement below asks the ground a question rather than assuming an
  // answer: how much land is on the far side of this cut, which leaf is this
  // point in, how far is it from the water. A 25 m lattice over a 1.4 km2
  // island is about 2,200 samples, which is cheap enough to do all of that
  // exactly and fine enough that a district cannot hide between two of them.
  const STEP = 25;
  const [bx0, by0, bx1, by1] = bboxOfRing(inner);
  const land = [];
  for (let x = bx0; x <= bx1; x += STEP) {
    for (let y = by0; y <= by1; y += STEP) {
      const p = [x, y];
      if (inRing(p, inner)) land.push({ p, edge: distToRing(p, inner) });
    }
  }
  const mid = land.reduce((a, l) => [a[0] + l.p[0] / land.length, a[1] + l.p[1] / land.length], [0, 0]);

  // The island's long axis, from the second moment of its own dry ground.
  let sxx = 0, sxy = 0, syy = 0;
  for (const l of land) {
    const dx = l.p[0] - mid[0], dy = l.p[1] - mid[1];
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  let phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let u = [Math.cos(phi), Math.sin(phi)];
  // Point it AWAY from the harbour: the spine runs from the water into the town.
  if ((harbourHead[0] - mid[0]) * u[0] + (harbourHead[1] - mid[1]) * u[1] > 0) {
    phi += Math.PI; u = [Math.cos(phi), Math.sin(phi)];
  }
  const v = [-u[1], u[0]];
  const along = (p) => (p[0] - mid[0]) * u[0] + (p[1] - mid[1]) * u[1];
  const across = (p) => (p[0] - mid[0]) * v[0] + (p[1] - mid[1]) * v[1];
  const phiDeg = phi * R2D;

  /** The spine coordinate below which a given share of the island's land lies. */
  const sSorted = land.map((l) => along(l.p)).sort((a, b) => a - b);
  const quantile = (q) => sSorted[Math.max(0, Math.min(sSorted.length - 1, Math.round(q * (sSorted.length - 1))))];
  const ptAt = (sc, cr = 0) => [mid[0] + u[0] * sc + v[0] * cr, mid[1] + u[1] * sc + v[1] * cr];

  // --- 3. the plan this town was laid out under ------------------------------
  /**
   * THE PLAN IS DRAWN, NOT FILLED IN.
   *
   * What used to be here was a TEMPLATE with numbers in it. The core got a
   * lattice, the old quarter got the one organic blob, the yards and the
   * housing got lattices, and the seed moved the pitch, the bearing and the
   * street widths inside bands a few degrees and a few metres wide. Every
   * island therefore came out the same city — an irregular quarter on the water
   * and a grid over all the rest — and the fault was NOT that the bands were
   * too narrow. Widening them gives the same city with different numbers, which
   * is exactly what it was already giving.
   *
   * What differs between two real cities at street level is the plan itself:
   * how many surveys were run and at what bearings, whether they were
   * reconciled or simply collide, which idea about what a street is for each
   * quarter was laid out under, how big a block is and how long, and how the
   * ground under it was cut into lots. Those are the draws below, and
   * everything after them is a consequence rather than a setting.
   *
   * WHAT IS NOT DRAWN is the mix of district ROLES. A district's flavour
   * decides what may be built on it, how tall, and of what class; the share
   * note under the bands below is measured against the two authored islands and
   * the economy is calibrated against it. Rerolling the role mix would not make
   * a different-looking city, it would make a different economy.
   */
  const Dpl = dice(stream(s, 0x91a4e5));
  const Dg = dice(stream(s, 0x51d55));
  // The avenues run down the island's long axis, which is what a surveyor does
  // with a peninsula: the long streets go the long way. bearingDeg is the
  // COMPASS bearing of the avenues, so it is 90 minus the spine's map angle,
  // folded into (-90, 90].
  const fold = (a) => ((((a + 90) % 180) + 180) % 180) - 90;
  const spineBearing = fold(90 - phiDeg);

  /**
   * THE SURVEYS — how many times somebody laid this town out, and at what
   * angles. This is the single most characterful thing a real city has and it
   * was entirely absent: every district took the spine's bearing with a jitter
   * on it, so the whole island was one grid that wobbled.
   *
   * A ONE-SURVEY town is Philadelphia: one instrument, one angle, the whole
   * peninsula, and the only thing that breaks it is the river. A TWO-SURVEY
   * town is Manhattan, where the Commissioners' grid of 1811 runs into the West
   * Village's older lanes at about twenty-nine degrees and the seam has been a
   * landmark ever since. A THREE-SURVEY town is Boston, where the Back Bay, the
   * South End and the North End were each laid out by different people at
   * different times with no intention whatever of agreeing.
   *
   * THE SEPARATIONS ARE DRAWN WIDE ENOUGH TO READ. Below about sixteen degrees
   * two grids look like one grid with a surveying error in it, which is exactly
   * the impression the old +/-22 degree jitter on the housing gave. The first
   * offset is 24-62 degrees off the spine and the second is thrown the other
   * way, so surveys one and two are never less than about forty degrees apart
   * after folding.
   *
   * The floor is 24 rather than 20 because each DISTRICT takes another +/-3
   * degrees of its own further down — the way a grid laid in two sittings never
   * quite closes — and two of those can eat six degrees off the separation.
   * MEASURED over 300 islands with the floor at 24 and the offsets taken off
   * the principal survey: surveys are 24.0 to 89.8 degrees apart (median 47.9),
   * and the closest pair of DISTRICTS that are on different surveys is 19.7
   * (median 41.0). At the first cut — floor 20, offsets taken off the spine —
   * those two numbers were 11 and 6, which is a surveying error, not a seam.
   */
  const nSurveys = Dpl.rand() < 0.28 ? 1 : Dpl.rand() < 0.62 ? 2 : 3;
  const surveySgn = Dpl.sign();
  const surveyOff = [0, surveySgn * Dpl.f(24, 62), -surveySgn * Dpl.f(24, 58)];
  const SURVEY = [];
  for (let k = 0; k < nSurveys; k++) {
    /**
     * BLOCK SIZE AND ASPECT, which are first-order visual facts and were fixed
     * constants of the flavour before this. Manhattan's 200 x 800 ft blocks and
     * Portland's 200 x 200 ft squares are the same city planted on the same
     * grid spacing and they are completely different places to walk: one gives
     * you a corner every sixty metres in one direction and every two hundred
     * and fifty in the other, the other gives you a corner every sixty metres
     * in both. The three modes below are those two and the ordinary American
     * block between them.
     *
     * MEASURED against what this used to emit: the core was 66-76 x 190-215 m
     * (aspect 2.8) on every island ever generated, the housing 56-63 x 144-160
     * (aspect 2.5). Both sit inside the middle mode here, which is the point —
     * the old numbers were not wrong, they were the only ones available.
     *
     * PITCH AND ASPECT ARE DRAWN TOGETHER, not independently, because in life
     * they are not independent: the long block is long because its SHORT side
     * is short. Manhattan is 200 x 800 ft — 61 x 244 m — so the aspect of four
     * comes with a sixty-metre pitch, not a ninety-metre one. Drawing them
     * separately allowed a 92 m pitch at aspect 4.5, which is a 414 m block,
     * longer than anything in any gridiron ever surveyed, and it cost the small
     * island sizes a quarter of their parcels because a Hamlet cannot fit many
     * of them.
     */
    const shape = Dpl.rand();
    const [aspect, pitch] = shape < 0.40
      ? [Dpl.f(1.00, 1.55), Dpl.f(62, 95)]              // Portland's 200 ft squares
      : shape < 0.78 ? [Dpl.f(1.90, 2.90), Dpl.f(58, 85)]  // the ordinary American block
        : [Dpl.f(3.20, 4.50), Dpl.f(52, 68)];           // the Commissioners' Plan
    SURVEY.push({
      // The offsets are measured off THE PRINCIPAL SURVEY, not off the spine.
      // Off the spine they were measured against a line survey 0 has already
      // moved up to nine degrees away from, so a nominal 24-degree offset could
      // arrive as 15 — measured, the closest pair on 300 islands was 15.3 —
      // and after each district takes its own +/-3 that is nine degrees, which
      // is a surveying error rather than a second survey.
      bearing: k === 0
        ? fold(spineBearing + Dpl.f(-9, 9))
        : fold(SURVEY[0].bearing + surveyOff[k]),
      aspect,
      pitch,
      warp: Dpl.f(1, 9),
    });
  }
  /**
   * STREET WIDTH IS A FRACTION OF THE PITCH, not a free number, and it has to
   * be or the lot budget moves with the block size.
   *
   * The ratios are read off what this file already emitted and the authored
   * islands agree with it: side streets ran 14-16 m on a 66-76 m pitch (0.21)
   * and avenues 25-28 m on 190-215 m (0.13). Holding those two ratios keeps the
   * share of the island that is roadway between 0.63 and 0.75 across the whole
   * range of block shapes above — measured — where a fixed 15 m street on a
   * 56 m square block would have paved over 42% of the town and taken a fifth
   * of its parcels with it.
   */
  const streetWOf = (p) => Math.round(Math.max(9, Math.min(22, p * 0.20)));
  const aveWOf = (p) => Math.round(Math.max(14, Math.min(34, p * 0.13)));

  /**
   * WHICH IDEA ABOUT STREETS EACH QUARTER WAS LAID OUT UNDER.
   *
   * The vocabulary is six kinds now rather than two — see the long note over
   * the layout kinds in citygen.mjs for what each one is and where it comes
   * from. What matters here is that a ROLE does not imply a KIND. There is no
   * law that says an old quarter is a medieval tangle: Savannah's old town is
   * the most rigid grid in North America and Karlsruhe's is a fan of thirty-two
   * avenues off a palace. There is no law that says downtown is a grid either —
   * plenty of European ones never got one, and plenty of American ones were
   * flattened and rebuilt as superblocks in the 1960s.
   *
   * So some of these islands have NO organic quarter anywhere on them, and
   * about one in nine is organic almost throughout, which is the medieval town
   * that never had a surveyor at all. That was the specific complaint: every
   * city had exactly one irregular blob and grid everywhere else.
   */
  // A whole town with no surveyor anywhere is one city in twenty-five, not
  // one in nine — at 0.11 the owner kept opening tangles and asking why
  // nothing looked like a normal city. The organic OLD QUARTER survives
  // per-district below; this dial is only "organic nearly throughout".
  const organicTown = Dpl.chance(0.04);
  /**
   * A RADIAL PLAN AND A SUPERBLOCK ESTATE ARE EACH ALLOWED ONCE.
   *
   * Not as a budget — because in life each of them is a single event. A radial
   * plan is aimed at ONE thing: Karlsruhe has one palace, Washington one
   * Capitol, and a town with two ceremonial foci a thousand metres apart has
   * neither. The estates went up in one programme, on the ground one authority
   * had, in one decade; a port whose downtown AND whose docks are both postwar
   * slab estates did not grow, it was invented.
   *
   * It is also what was breaking the parcel budget. A superblock district
   * genuinely carries about half the parcels the same ground would carry as a
   * gridiron — correctly, that is what an estate is — so two of them plus a
   * radial quarter put seed 555 at 744 lots on an island whose size dial
   * promises about fourteen hundred. Once each, and the same seed builds a
   * town.
   */
  let usedRadial = false, usedSuper = false;
  /**
   * AN EXTENSION IS AN EXTENSION. Cerdà's Eixample and every slab estate ever
   * built are things that happened BESIDE a city, on ground somebody could
   * assemble in one go, and neither has ever been most of a town. Barcelona's
   * chamfered grid is about a fifth of Barcelona; the Gothic Quarter and
   * Gràcia and Sants are the rest of it.
   *
   * It is also the last thing keeping the parcel budget honest. Both kinds
   * carry markedly fewer parcels per hectare than a gridiron — the Eixample
   * gives away 30% of its ground to roadway plus another 9% to the chamfers
   * themselves, and an estate is two slabs where a grid would put twelve. On a
   * district holding a fifth of the island that is a detail; on the ringed
   * arrangement, where the Exchange can hold 55% of the land, seed 555 came out
   * at 980 lots on an island whose size dial says about fourteen hundred. So a
   * role that holds more than a third of the island cannot draw either, and the
   * result reads as a city with an extension in it rather than as an extension.
   *
   * THE ESTATE'S LIMIT IS TIGHTER THAN THE EIXAMPLE'S, at a quarter rather than
   * a third, and for a different reason. A chamfered grid is a normal density
   * of parcels with a lot of roadway; an estate's parcel IS the slab's plot,
   * about a thousand square metres against six hundred for a platted lot — and
   * that is if anything generous, since a real slab stands on a fifth of a
   * hectare. Measured over sixty islands, four of the five sparsest carried a
   * superblock district, and the sparsest of all built 1,018 lots. Making the
   * estate's parcels smaller would be a thumb on the scale; keeping the estate
   * to a neighbourhood, which is what an estate is, is not.
   */
  const SPARSE_MAX = 0.34, ESTATE_MAX = 0.24;
  const kindFor = (role, share = 0) => {
    const once = (k) => {
      if (k === "chamfer" && share > SPARSE_MAX) return null;
      if (k === "superblock" && share > ESTATE_MAX) return null;
      if (k === "radial") { if (usedRadial) return null; usedRadial = true; }
      if (k === "superblock") { if (usedSuper) return null; usedSuper = true; }
      return k;
    };
    /**
     * THE TOWN THAT NEVER HAD A SURVEYOR, and the one honest limit on it.
     *
     * Siena and Bruges and the City of London are medieval to the middle and
     * they still have a nineteenth-century periphery, because the periphery was
     * built in the nineteenth century. So an organic town is organic where the
     * town was: the landing and the Exchange always, the housing usually, the
     * yards half the time — which is "organic nearly throughout" and not
     * "organic including the parts that were fields until 1890".
     *
     * It is also the top of the parcel range. An unplanned mesh puts more of
     * its ground inside blocks than a grid with avenues does, so an island that
     * came out organic in every district built 1,803 lots where the size dial
     * says about 1,420 — the widest miss in either direction across 24 seeds.
     */
    if (organicTown) {
      if (role === "old" || role === "core") return "organic";
      if (role === "ind") return Dpl.chance(0.5) ? "organic" : "lattice";
      return Dpl.chance(0.6) ? "organic" : Dpl.chance(0.5) ? "curvi" : "lattice";
    }
    const r = Dpl.rand();
    switch (role) {
      case "old":                                        // the landing
        return (r < 0.30 ? "organic" : r < 0.80 ? "lattice" : r < 0.90 ? once("radial") : once("chamfer")) ?? "lattice";
      case "core":
        // THE EXCHANGE CANNOT BE A SUPERBLOCK ESTATE, and that is a fact about
        // the world rather than a budget. Slab estates went up on cleared
        // industrial land and on the periphery, on ground one authority could
        // assemble; nowhere did a working port's whole commercial middle come
        // down for them. It is also the district that carries most of the
        // island — measured, the core takes 32-51% of a banded island and up to
        // 60% of a ringed one — so letting it draw the kind that carries half
        // the parcels per hectare put seed 555 at 786 lots against about 1,400.
        // A downtown is a GRID four times in five. Radial and chamfered
        // stay as the rare civic statement; an organic Exchange survives
        // only through the old-quarter roll or an organicTown. Measured
        // motivation: at lattice 0.52 most seeds read "tangle with one
        // gridded corner" from altitude — backwards from every real port.
        return (r < 0.80 ? "lattice" : r < 0.90 ? once("radial") : once("chamfer")) ?? "lattice";
      case "ind":                                        // the yards
        return (r < 0.80 ? "lattice" : once("superblock")) ?? "lattice";
      default:                                           // the housing
        // Housing fabric is surveyed fabric: grid first, one streetcar
        // suburb of bent streets as the accent, estates and old lanes rare.
        return (r < 0.60 ? "lattice" : r < 0.80 ? "curvi" : r < 0.88 ? once("chamfer")
          : r < 0.96 ? once("superblock") : "organic") ?? "curvi";
    }
  };

  /**
   * HOW THE GROUND WAS CUT UP — the half of this the complaint named out loud.
   *
   * The five numbers are FLAVOR.lot's: [t0, t1, min, maxDepth, jitter] in m2.
   * The flavour says what the ground is FOR, which is an economic statement the
   * engine reads; this says how the surveyor cut it, which is the one you can
   * see from the pavement.
   *
   * WHAT IS REAL HERE AND WHAT IS CONSTRAINED, stated plainly. The SHAPE terms
   * — maxDepth, which decides whether the splitter keeps cutting frontages off
   * a deep strip or turns and cuts the depth in half, and jitter, which decides
   * whether the side lines are parallel — are free and are drawn across the
   * full real range: a burgage plot behind a market frontage is four times as
   * deep as it is wide, a postwar suburban lot is half as deep as it is wide.
   * The AREA terms are NOT free. A real Baltimore row lot is 130 m2 and a real
   * Philadelphia one is 89, and dropping those in would have trebled the parcel
   * count in any district that drew them — the size dial promises "about
   * fourteen hundred lots" at City and a save's deeds are bbls in that table.
   * So the areas stay inside a band around the flavour's own and the variety
   * comes out of the shape. That is a game constraint wearing its own name and
   * not an economic claim.
   *
   * The areas are CENTRED on the flavour means they replace, measured: core
   * 715 m2, old 685, resi 650, industrial 1550. Row 590, burgage 630, fine 675
   * and villa 825 straddle the first three; estate and yard sit above them
   * because a block platted in one hand and a working wharf genuinely are
   * bigger parcels, and those two are drawn rarely enough that the island's
   * total stays in family. A first cut of this table ran 60-100 m2 lower across
   * the board and every district that drew from it came out at a 330-460 m2
   * mean lot against the 650-715 of the flavour it was replacing — a fifth more
   * parcels wherever it landed, which is not a lot convention, it is a thumb.
   */
  const LOTWAYS = {
    row:     [360, 820, 165, 34, 7],    // narrow frontages on a deep strip
    burgage: [360, 900, 165, 48, 15],   // deeper still, and nothing is parallel
    fine:    [400, 950, 180, 26, 12],   // a nineteenth-century commercial street
    villa:   [500, 1150, 230, 20, 5],   // shallow and wide: the streetcar suburb
    estate:  [620, 1500, 290, 40, 5],   // the block laid out in one hand
    yard:    [850, 2500, 360, 52, 5],   // a working waterfront parcel
  };
  const lotWayFor = (role, kind) => {
    // A superblock estate was platted as a whole and an organic quarter was
    // never platted at all, so those two answer before the role does.
    if (kind === "superblock") return Dpl.chance(0.75) ? "estate" : null;
    if (kind === "organic") return Dpl.chance(0.55) ? "burgage" : null;
    const r = Dpl.rand();
    switch (role) {
      case "old":  return r < 0.34 ? "burgage" : r < 0.66 ? "fine" : r < 0.82 ? "row" : null;
      case "core": return r < 0.30 ? "fine" : r < 0.44 ? "row" : null;
      case "ind":  return r < 0.70 ? "yard" : null;
      default:     return r < 0.30 ? "row" : r < 0.62 ? "villa" : r < 0.74 ? "fine" : null;
    }
  };

  /**
   * HOW THE TOWN IS ARRANGED, which is the other thing a template cannot vary.
   *
   * BANDS is the port that grew along its own spine: the landing on the water,
   * the Exchange behind it, the housing beyond that, and the yards cut off the
   * flank of the middle band on whichever side has the frontage. That is the
   * order every real port on this coast grew in and it is why the dear ground
   * is never at the far end. It was the only arrangement this file had.
   *
   * RINGS is the town that grew outward from its landing instead of along it —
   * a dense old core, then the streetcar-era blocks, then whatever came after,
   * in rings rather than in bands. A ring is not convex and the partition has
   * to stay a BSP, so it is built as a PINWHEEL: cuts through the hub give
   * wedges, and each wedge is cut once more at a radius measured off its own
   * land. The union of the inner pieces is a polygon around downtown, which is
   * a growth ring drawn with straight lines — which is what a growth ring is,
   * on the ground, once streets are involved.
   */
  const arrangement = Dpl.chance(0.55) ? "bands" : "rings";

  /**
   * HOW MANY STREETS REFUSE THE GRID.
   *
   * There was always exactly one — "every town on this coast has one and it is
   * always the oldest road on the map" — which is true of a small port and
   * false of everywhere that ever had a plan drawn for it. Washington has
   * fifteen state avenues, Paris has Haussmann's whole system, Philadelphia has
   * none at all worth the name. A town with none is not missing anything; a
   * town with three reads as one somebody thought about.
   */
  const nBoulevard = Dpl.rand() < 0.18 ? 0 : Dpl.rand() < 0.56 ? 1 : Dpl.rand() < 0.72 ? 2 : 3;

  const Dd = dice(stream(s, 0xd15701));
  const nDistricts = Dd.rand() < 0.16 ? 3 : Dd.rand() < 0.74 ? 4 : 5;

  /**
   * HOW MUCH OF THE ISLAND EACH DISTRICT GETS, and why it is not a free choice.
   *
   * A district's flavour decides how finely it plats, how much may be built on
   * it, how tall, and what class of building goes up — FLAVOR.core allows
   * ninety-nine floors and puts the offices there; FLAVOR.resi caps at seven
   * and is almost all housing. So the share of the island each band gets is a
   * statement about what kind of town this is, and getting it wrong does not
   * make a different-looking city, it makes a different economy.
   *
   * MEASURED on the two authored islands, as a share of all parcels:
   *
   *              old      core     resi     industrial
   *   New Alden  15-16%   45-47%   30-31%   8-9%
   *   Kestrel    27-28%   37-40%   26-28%   6%
   *
   * THE CORE IS THE BIGGEST DISTRICT IN BOTH, and that is the fact worth
   * keeping: a port city's commercial middle is most of its built fabric, not a
   * downtown crumb surrounded by houses. The first cut of these bands gave the
   * core 30-40% of the spine and then took a third of THAT away for the docks,
   * which left the generated islands with 13-19% of their parcels in the core
   * and 41-58% in housing — a suburb with a harbour attached, and 23% more
   * blocks per square kilometre than New Alden because resi blocks are half the
   * size of core ones. With the bands below, measured over six seeds: core
   * 32-51%, old 17-27%, resi 22-40%, industrial 4-6%, and 932-1026 lots per
   * square kilometre against New Alden's 922-951 and Kestrel Point's 926-981.
   *
   * The core band has to be WIDER than the share it is aiming for, because the
   * docks come out of it and because resi plats finer than core does: a resi
   * band lays down about 1.6 parcels for every one the same ground would carry
   * as Exchange, so land share and parcel share are not the same quantity.
   *
   * The old quarter is still the SHORTEST band. A colonial waterfront is a toe,
   * not a third of a city, and keeping it tight is what puts the core within a
   * few hundred metres of the water where it belongs.
   */
  const fOld = Dd.f(0.16, 0.23);
  const fCore = fOld + Dd.f(0.48, 0.58);
  const cutOld = cut(...ptAt(quantile(fOld)), phiDeg + 90);
  const cutCore = cut(...ptAt(quantile(fCore)), phiDeg + 90);

  const oldSide = ptAt(quantile(fOld * 0.4));
  const coreSide = ptAt(quantile((fOld + fCore) / 2));
  const farSide = ptAt(quantile((1 + fCore) / 2));

  // Which flank the yards go on: count the shoreline that the middle band
  // actually touches on each side. Docks go where the water is.
  const bandLo = quantile(fOld), bandHi = quantile(fCore);
  let coastPos = 0, coastNeg = 0;
  for (const p of COAST) {
    const sc = along(p);
    if (sc < bandLo || sc > bandHi) continue;
    if (across(p) > 0) coastPos++; else coastNeg++;
  }
  const dockSign = coastPos >= coastNeg ? 1 : -1;
  // A fifth of the middle band's land, taken from the dock side — which lands
  // the yards at 6-11% of the island, the share the authored two carry.
  const bandCross = land.filter((l) => along(l.p) >= bandLo && along(l.p) <= bandHi)
    .map((l) => across(l.p) * dockSign).sort((a, b) => b - a);
  const fDock = Dd.f(0.16, 0.24);
  const dockLine = bandCross[Math.max(0, Math.min(bandCross.length - 1, Math.round(fDock * (bandCross.length - 1))))] ?? 0;
  const cutDock = cut(...ptAt((bandLo + bandHi) / 2, dockLine * dockSign), phiDeg);
  const dockSide = ptAt((bandLo + bandHi) / 2, (dockLine + 240) * dockSign);
  const exchSide = ptAt((bandLo + bandHi) / 2, (dockLine - 320) * dockSign);

  // Names, once the geography knows where everything is.
  const Dn = nm.D;
  const dirOf = (p) => octant(p[0] - mid[0], p[1] - mid[1]);
  const cardinal = (w) => (["North", "South", "East", "West"].includes(w) ? w : null);
  const resiName = (p, used) => {
    const c = cardinal(dirOf(p));
    const opts = [...RESI_DISTRICT, ...(c ? [c + "side", c + " Hill"] : []), nm.words[3] + " Hill", nm.words[4] + " Heights"];
    const free = opts.filter((o) => !used.has(o));
    return Dn.pick(free.length ? free : opts);
  };
  const usedResi = new Set();

  /**
   * THE PARTITION IS BUILT OVER SLOTS AND THE SLOTS ARE MEASURED BEFORE THEY
   * ARE NAMED.
   *
   * A pinwheel of wedges cannot promise that every one of them lands on real
   * ground — a wedge pointing at a bay is mostly water, and one pointing along
   * the tail of a peninsula can be a hundred metres wide. The old bands could
   * promise it because every cut was placed at a quantile of the land on the
   * far side, and that argument does not survive contact with an arrangement
   * that cuts in two directions at once.
   *
   * So the tree is built with anonymous slot ids, the land samples are counted
   * into them, and only then does each slot get a role. A slot holding less
   * than 1.5% of the island is FOLDED into the largest slot of its own ring
   * rather than being handed a district name it cannot fill: the invariant that
   * no district may end up with zero blocks is then a property of the
   * construction rather than something to hope about. Several slots may share
   * one district key, which is what makes a ring a ring.
   */
  const slotTree = { node: null, hub: null };
  if (arrangement === "bands") {
    if (nDistricts === 3) {
      slotTree.node = branch(cutOld, oldSide, "old", branch(cutCore, coreSide, "core", "resiA"));
    } else if (nDistricts === 4) {
      slotTree.node = branch(cutOld, oldSide, "old",
        branch(cutCore, coreSide, branch(cutDock, dockSide, "ind", "core"), "resiA"));
    } else {
      const fResi = fCore + (1 - fCore) * Dd.f(0.48, 0.60);
      const cutResi = cut(...ptAt(quantile(fResi)), phiDeg + 90);
      const nearFar = ptAt(quantile((fCore + fResi) / 2));
      slotTree.node = branch(cutOld, oldSide, "old",
        branch(cutCore, coreSide, branch(cutDock, dockSide, "ind", "core"),
          branch(cutResi, nearFar, "resiA", "resiB")));
    }
  } else {
    // THE HUB is the landing — where the ships came in and the town started —
    // not the middle of the island. A town that grew outward grew outward from
    // somewhere, and putting the hub at the centroid would give a bullseye
    // rather than a port.
    const hub = ptAt(quantile(Dd.f(0.20, 0.33)), across(exchSide) * Dd.f(0.15, 0.45));
    const nCuts = Dd.rand() < 0.55 ? 2 : 3;         // 4 or 6 wedges
    const a0 = Dd.f(0, 180);
    const wedgeDegs = Array.from({ length: nCuts }, (_, i) => a0 + (i * 180) / nCuts + Dd.f(-13, 13));
    // How much of each wedge's own land falls inside the first ring. The bands
    // give the old quarter plus the Exchange 64-81% of the island between them
    // and this aims at the same place from the other direction.
    const fInner = Dd.f(0.56, 0.72);
    let nSlot = 0;
    const wedge = (k, hp) => {
      if (k === nCuts) {
        // The wedge's own bisector, found by asking which directions out of the
        // hub are actually in this region rather than by unpicking the signs.
        let sx = 0, sy = 0, n = 0;
        for (let t = 0; t < 720; t++) {
          const a = (t / 720) * TAU;
          const p = [hub[0] + Math.cos(a) * 20, hub[1] + Math.sin(a) * 20];
          if (!inLeaf(hp, p)) continue;
          sx += Math.cos(a); sy += Math.sin(a); n++;
        }
        const id = nSlot++;
        if (!n) return "dead" + id;                 // an empty sign combination
        const L = Math.hypot(sx, sy) || 1;
        const b = [sx / L, sy / L];
        // The radius is a quantile of THIS wedge's dry ground, so a wedge over
        // a bay gets a tight inner ring and one over the tail of the island
        // gets a long one — which is what an equal share of land means.
        const ds = land.filter((l) => inLeaf(hp, l.p))
          .map((l) => dist(l.p, hub)).sort((x, y) => x - y);
        if (ds.length < 12) return "dead" + id;      // no ground worth cutting
        const R = ds[Math.max(0, Math.min(ds.length - 1, Math.round(fInner * (ds.length - 1))))];
        const at = [hub[0] + b[0] * R, hub[1] + b[1] * R];
        // A line through `at` perpendicular to the bisector. cut() takes a
        // COMPASS bearing and a direction (dx, dy) has bearing atan2(dx, dy).
        const cR = cut(at[0], at[1], Math.atan2(-b[1], b[0]) * R2D);
        return branch(cR, hub, "in" + id, "out" + id);
      }
      const c = cut(hub[0], hub[1], wedgeDegs[k]);
      return {
        cut: c,
        neg: wedge(k + 1, [...hp, [c[0], c[1], c[2]]]),
        pos: wedge(k + 1, [...hp, [-c[0], -c[1], -c[2]]]),
      };
    };
    slotTree.node = wedge(0, []);
    slotTree.hub = hub;
  }

  // What each slot actually holds, and where it holds it.
  const slotLeaves = leavesOf(slotTree.node);
  const slotOf = (p) => slotLeaves.find((l) => inLeaf(l.hp, p))?.district ?? null;
  const slotLand = new Map();
  for (const l of land) {
    const sl = slotOf(l.p);
    if (!sl) continue;
    const e = slotLand.get(sl) ?? { n: 0, x: 0, y: 0, coast: 0 };
    e.n++; e.x += l.p[0]; e.y += l.p[1];
    slotLand.set(sl, e);
  }
  for (const p of COAST) {
    // A shoreline vertex belongs to whichever slot the dry ground just inside
    // it belongs to; that is the frontage the yards want.
    const q = [p[0] * 0.94 + mid[0] * 0.06, p[1] * 0.94 + mid[1] * 0.06];
    const sl = slotOf(q);
    if (sl && slotLand.has(sl)) slotLand.get(sl).coast++;
  }
  /**
   * THE ROLES, HANDED OUT ON THE EVIDENCE.
   *
   * Bands know their own roles by construction. Rings do not: the old quarter
   * is whichever inner wedge faces the water the town came in from, the yards
   * are whichever outer wedge has the most shoreline, and everything else
   * inside the first ring is the Exchange and everything else outside it is
   * housing. All three of those are questions about the ground, so all three
   * are answered by measuring it.
   */
  const roleOf = new Map();
  if (arrangement === "bands") {
    // The bands ARE the roles: every cut was placed at a quantile of the land
    // on the far side of it, so each slot is guaranteed its share by
    // construction and there is nothing left to decide.
    for (const l of slotLeaves) roleOf.set(l.district, l.district);
  } else {
    const live = [...slotLand.entries()].filter(([, e]) => e.n >= land.length * 0.015);
    const ins = live.filter(([id]) => id.startsWith("in")).sort((a, b) => b[1].n - a[1].n);
    const outs = live.filter(([id]) => id.startsWith("out")).sort((a, b) => b[1].n - a[1].n);
    // The landing: the inner wedge whose ground lies nearest the harbour head.
    let oldId = null, bd = Infinity;
    for (const [id, e] of ins) {
      const d = dist([e.x / e.n, e.y / e.n], harbourHead);
      if (d < bd) { bd = d; oldId = id; }
    }
    // The yards: the outer wedge with the most shoreline, exactly the question
    // the banded arrangement asks. A wedge with NO frontage is not a candidate
    // — there is no such thing as an inland dock — and if none of them has any,
    // this island has no yards and the role folds into downtown below.
    const indId = [...outs].sort((a, b) => b[1].coast - a[1].coast)
      .filter(([, e]) => e.coast > 0)[0]?.[0] ?? null;
    let r = 0;
    for (const [id] of live) {
      if (id === oldId) roleOf.set(id, "old");
      else if (id === indId && nDistricts >= 4) roleOf.set(id, "ind");
      else if (id.startsWith("in")) roleOf.set(id, "core");
      else roleOf.set(id, nDistricts >= 5 && r++ % 2 === 1 ? "resiB" : "resiA");
    }
    // Anything too small to be a district of its own joins the biggest slot in
    // its own ring. Nothing is dropped from the plane — a BSP leaf still exists
    // and still tiles; it simply answers to a neighbour's name.
    const biggestIn = ins[0]?.[0], biggestOut = outs[0]?.[0] ?? ins[0]?.[0];
    for (const l of slotLeaves) {
      if (roleOf.has(l.district)) continue;
      roleOf.set(l.district, roleOf.get(l.district.startsWith("in") ? biggestIn : biggestOut) ?? "core");
    }
  }
  // A role with no ground at all is not a district. This can only fire on the
  // ring arrangement, and it is why `nDistricts` is a request rather than a
  // promise — the island has the last word on how many quarters fit on it.
  const roleLand = {};
  for (const [id, e] of slotLand) roleLand[roleOf.get(id)] = (roleLand[roleOf.get(id)] ?? 0) + e.n;
  const hasRole = (r) => (roleLand[r] ?? 0) >= land.length * 0.015;

  // Where each role sits, for the naming and for everything that has to point
  // at it. Bands know these from their own geometry; rings measure them.
  const roleMid = (r) => {
    const ids = [...slotLand.keys()].filter((id) => roleOf.get(id) === r);
    if (!ids.length) return mid;
    let x = 0, y = 0, n = 0;
    for (const id of ids) { const e = slotLand.get(id); x += e.x; y += e.y; n += e.n; }
    return [x / n, y / n];
  };
  const dockAt = arrangement === "bands" ? dockSide : roleMid("ind");
  const farAt = arrangement === "bands" ? farSide : roleMid("resiA");

  const disp = { old: Dn.pick(OLD_DISTRICT), core: Dn.pick(CORE_DISTRICT) };
  disp.ind = (() => {
    const c = cardinal(dirOf(dockAt));
    return Dn.pick([...IND_DISTRICT, ...(c ? [c + " Docks", c + " Yards"] : [])]);
  })();
  disp.resi = resiName(farAt, usedResi); usedResi.add(disp.resi);
  if (hasRole("resiB")) {
    disp.resi2 = resiName(roleMid("resiB"), usedResi);
    usedResi.add(disp.resi2);
  }

  const key = (t) => t.toLowerCase().replace(/[^a-z]+/g, "");
  const kOld = key(disp.old), kCore = key(disp.core), kInd = key(disp.ind), kResi = key(disp.resi);
  const kResi2 = disp.resi2 ? key(disp.resi2) : null;
  // A role that did not survive the measurement folds into the one next to it
  // in the way a town actually works: no yards means the waterfront is part of
  // downtown, no landing means downtown reaches the water itself.
  const keyForRole = (r) =>
    r === "old" ? (hasRole("old") ? kOld : kCore)
      : r === "ind" ? (hasRole("ind") ? kInd : kCore)
        : r === "resiB" ? (kResi2 ?? kResi)
          : r === "resiA" ? kResi
            : kCore;

  const relabel = (node) => (typeof node === "string"
    ? keyForRole(roleOf.get(node) ?? "core")
    : { cut: node.cut, neg: relabel(node.neg), pos: relabel(node.pos) });
  const partition = relabel(slotTree.node);
  const districtKeys = {
    old: hasRole("old") ? kOld : kCore,
    core: kCore,
    ...(hasRole("ind") ? { ind: kInd } : {}),
    resi: [kResi, ...(hasRole("resiB") && kResi2 ? [kResi2] : [])],
  };
  const leaves = leavesOf(partition);
  const leafOf = (p) => leaves.find((l) => inLeaf(l.hp, p))?.district ?? null;
  for (const l of land) l.d = leafOf(l.p);

  // --- 4. the street grammars ------------------------------------------------
  /**
   * A DISTRICT'S GRAMMAR IS ITS ROLE PLUS ITS SURVEY PLUS ITS LAYOUT KIND, and
   * all three are already drawn. What is left here is arithmetic: turn a
   * survey's pitch and aspect into the numbers the layout kind wants, and hand
   * each district the lot convention its ground was cut under.
   *
   * WHICH SURVEY EACH QUARTER BELONGS TO is the decision that makes the seams.
   * Downtown always gets the principal survey — it is the one the town was laid
   * out from. The yards get another where there is one, because a working
   * waterfront was laid to the WATER and not to the surveyor's line, which is
   * true of every port on earth. The landing and the housing draw.
   */
  const surveyFor = (role) => {
    if (nSurveys === 1) return SURVEY[0];
    if (role === "core") return SURVEY[0];
    if (role === "ind") return SURVEY[nSurveys - 1];
    return SURVEY[Dg.i(0, nSurveys - 1)];
  };
  // Roles that get a bearing of their own even inside one survey: a couple of
  // degrees, the way a grid laid in two sittings never quite closes.
  const ROLE_SCALE = { old: 0.80, core: 1.00, ind: 1.34, resiA: 0.88, resiB: 0.86 };

  /**
   * One district's config, built from the plan rather than from a table.
   *
   * CERDÀ'S NUMBERS ARE HIS OWN. The Eixample is 113.3 m from façade to façade
   * with 20 m streets and a 20 m chamfer off every corner, surveyed in 1859 and
   * still exactly that; a "chamfered grid" with anything else in it is not the
   * thing anybody recognises. Those three numbers are hardcoded and the only
   * seeded part of that kind is which way it points.
   */
  const districts = {};
  const districtRole = {};
  const buildDistrict = (k, role, flavor) => {
    if (districts[k]) return;                        // a folded role: already there
    const sv = surveyFor(role);
    const kind = kindFor(role, (roleLand[role] ?? 0) / land.length);
    const way = lotWayFor(role, kind);
    const scale = ROLE_SCALE[role] ?? 1;
    const stPitch = Math.round(sv.pitch * scale);
    const avePitch = Math.round(stPitch * sv.aspect);
    const bearing = +fold(sv.bearing + Dg.f(-3, 3)).toFixed(1);
    const base = {
      flavor,
      bearingDeg: bearing,
      fullBlockP: role === "ind" ? 0.11 : role === "core" ? 0.05 : 0.02,
      ...(way ? { lot: LOTWAYS[way] } : {}),
    };
    if (kind === "organic") {
      /**
       * The colonial tangle. The cell range is the block AREA it splits down
       * to, so it is set from the survey's own pitch rather than from a
       * constant — a town of small blocks has a small old quarter block too.
       *
       * A THIRD TO THREE QUARTERS of a surveyed block, not one to one and a
       * half. An unplanned quarter is FINER than the grid beside it — that is
       * most of what makes it look unplanned from above — and the numbers this
       * replaced (3,050-8,400 m2 flat) say the same thing about the grid they
       * sat next to. Set at one to one and a half, an island that came out
       * organic nearly throughout built 1,949 lots against the 1,420 the size
       * dial promises, because a fine mesh of eight-metre lanes puts far more
       * of its ground inside blocks than a grid with avenues in it does.
       */
      const a = stPitch * avePitch;
      districts[k] = {
        ...base, kind: "organic",
        cell: [Math.round(a * 0.34), Math.round(a * 0.78)],
        jitterDeg: Math.round(Dg.f(11, 22)),
        streetW: Math.round(Math.max(8, streetWOf(stPitch) * 0.7)),
      };
    } else if (kind === "chamfer") {
      districts[k] = {
        ...base, kind: "chamfer", regular: true,
        stPitch: 113, avePitch: 113, streetW: 20, aveW: 20,
        // 20 m off a 113 m block, measured on the inset the block actually
        // gets: (113 - 20) = 93 m of frontage, so the cut is 20/93.
        chamferAll: 0.215, warpAmp: 0,
      };
    } else if (kind === "superblock") {
      const cell = Math.round(stPitch * Dg.f(2.2, 3.2));
      const long = Math.round(cell * Math.min(1.6, sv.aspect));
      districts[k] = {
        ...base, kind: "superblock",
        stPitch: cell, avePitch: long,
        // The arterial round the ring, and the service road inside it. They are
        // different roads and the estate only works if they are different
        // numbers — see the `ways` note in pushBlock.
        streetW: Math.round(Dg.f(22, 30)), aveW: Math.round(Dg.f(28, 38)),
        wayW: Math.round(Dg.f(8, 12)),
        warpAmp: Math.round(sv.warp * 0.5),
        /**
         * THE WAYS INSIDE THE RING, and the number that decides whether this is
         * an estate or just a grid with fat streets.
         *
         * A superblock is one arterial cell with two to four slabs in it. The
         * first cut of this asked for pieces a tenth to a fifth of the cell —
         * eight to seventeen of them — and since every piece is then set back
         * by the district's own street width, which on an arterial is twenty
         * metres, the "estate" lost forty per cent of its ground to internal
         * roadway and came out at 1.5 parcels per block. Seed 555 built 557
         * lots on a 1,420-lot island because two of its four districts were
         * that. Asking for a quarter to a half of the cell gives the two-to-
         * four slabs the thing actually has.
         */
        superCell: [Math.round(cell * long * 0.26), Math.round(cell * long * 0.52)],
        superJitter: Math.round(Dg.f(6, 26)),
      };
    } else if (kind === "curvi") {
      districts[k] = {
        ...base, kind: "curvi",
        stPitch, avePitch,
        streetW: streetWOf(stPitch), aveW: aveWOf(avePitch),
        // The bend: a wavelength of three to six blocks and an amplitude that
        // the emitter clamps to whatever keeps the cells convex.
        curveLen: Math.round(avePitch * Dg.f(2.6, 5.2)),
        curveAmp: Math.round(stPitch * Dg.f(0.7, 1.7)),
      };
    } else if (kind === "radial") {
      districts[k] = {
        ...base, kind: "radial",
        // The focus is filled in below, once the cores are known — the whole
        // point of a radial plan is that it is aimed at something.
        focus: null, focusWant: role,
        ringPitch: Math.round(stPitch * Dg.f(0.95, 1.35)),
        /**
         * THE CIRCUS IS AS BIG AS THE SPOKE COUNT MAKES IT.
         *
         * An arc of fixed angle is shorter the closer to the focus you stand,
         * so the first ring's blocks are as wide as 2*pi*R/spokes and no wider.
         * With twenty-five spokes and a ninety-metre circus that is a
         * twenty-three metre sliver — narrower than the street around it — and
         * measured on seed 99991 eighteen of the radial district's thirty-nine
         * cells came out as bare pavement with no block on them at all. So the
         * circus radius is SOLVED from the spokes and the pitch rather than
         * drawn: R = spokes * pitch / 2*pi puts the innermost block's frontage
         * at the district's own street pitch, which is the width every ring
         * further out will exceed.
         */
        spokes: Dg.i(9, 20),
        circusR: 0,                                    // solved just below
        streetW: streetWOf(stPitch), aveW: aveWOf(stPitch),
      };
      // 60 to 130 m of radius, which is 120 to 260 m across: the Étoile is 240,
      // Piccadilly Circus is under 100, and there is no such thing as a
      // six-hundred-metre one. Uncapped, the solve above put a 298 m circus on
      // one island — a 256 m deep frontage band, which is not a circus, it is a
      // quarter, and it cost that island two per cent of its coverage in cells
      // too big for the shoreline test to handle.
      districts[k].circusR = Math.max(60, Math.min(130,
        Math.round((districts[k].spokes * stPitch * Dg.f(0.9, 1.35)) / TAU)));
    } else {
      districts[k] = {
        ...base, kind: "lattice",
        stPitch, avePitch,
        streetW: streetWOf(stPitch), aveW: aveWOf(avePitch),
        // A surveyed grid is STRAIGHT — that is what the surveyor was for.
        // The full survey warp (1-9 m of node displacement) belonged to the
        // curvi kind; on lattice it bent every "grid" enough to read as
        // wobble from altitude, which the owner named directly. A metre or
        // two of setting-out error is all a real grid carries.
        warpAmp: Math.min(2, Math.round(sv.warp * 0.25)),
        numbered: role === "core" || (role === "resiA" && Dg.chance(0.4)),
      };
    }
    districtRole[k] = role;
  };
  buildDistrict(kCore, "core", "core");
  if (hasRole("old")) buildDistrict(kOld, "old", "old");
  if (hasRole("ind")) buildDistrict(kInd, "ind", "industrial");
  buildDistrict(kResi, "resiA", "resi");
  if (hasRole("resiB") && kResi2) buildDistrict(kResi2, "resiB", "resi");

  // --- 4b. the seams ---------------------------------------------------------
  /**
   * WHERE TWO SURVEYS MEET, SOMETHING HAS TO GIVE — and in a real city what
   * gives is a street.
   *
   * This is the payoff of drawing the plan and it is also the direct answer to
   * what the contrast used to look like. Two grids at different bearings run
   * into each other along a line, and the blocks that straddle that line come
   * out as wedges: triangles, trapezoids, the odd five-sided remnant. Left to
   * itself the boundary is a ragged tear — which is what a "stark contrast"
   * between a lattice and a blob is. Put a street on the join and the same
   * geometry reads as a decision somebody made: the wedges are the blocks that
   * reconcile the two surveys, and the street is where the reconciliation was
   * agreed. Manhattan's Greenwich Ave, Boston's Massachusetts Ave and every
   * "diagonal that makes no sense" in an American downtown is one of these.
   *
   * The seam is found on the partition itself rather than drawn by hand: every
   * internal cut whose two sides do not share a grain gets one, clipped to the
   * region the cut actually bounds and then to the longest run of it that is on
   * dry ground. A cut between two districts of the same survey and the same
   * kind gets nothing, because there is nothing there to reconcile — the grid
   * runs straight through, which is also what really happens.
   *
   * At most TWO: they are obstacles in the generator and every obstacle is
   * differenced out of every cell it meets, so this is a cost in land as well
   * as in time. The two longest are the ones a city would have named. Note what
   * that cap actually does: measured over 40 islands it BINDS on 38 of them, so
   * "at most two" is in practice "exactly two" and the plan's own answer to how
   * many places it has to reconcile is being discarded. That is a rail rather
   * than a mechanism, and it is only tolerable because the seam below is now
   * cheap; if it is ever widened again the cap goes first.
   *
   * ---------------------------------------------------------------------------
   * WHAT `h` IS, AND WHY IT IS SO MUCH SMALLER THAN THE STREET IT MAKES.
   *
   * `h` is a RESERVATION, not a street width, and the difference is the whole
   * of a fault that ran here unmeasured. citygen.mjs differences the rectangle
   * out of every cell it meets, leaves DIAG_CLEAR (2 m) of kerb on each side,
   * and THEN erodes the flanking cells by the ordinary streetW/2 they would
   * have paid to each other anyway. So the street on the ground is
   *
   *     delivered  =  h + 2*DIAG_CLEAR + streetW
   *
   * and streetW is the flanking district's, 8 to 27 m depending on which one it
   * runs through. Measured rather than derived — walk the centreline, take the
   * median gap between the two building lines: over 21 grid-refusing streets on
   * 8 islands, a seam declared at 15.1 m came out 35.6 m (ratio 2.32) and a
   * boulevard declared at 25.5 m came out 51.4 m (ratio 2.02). An ordinary
   * street on the same islands measures 11-27 m.
   *
   * A SEAM PAYS THAT TWICE OVER, because a seam sits ON a partition cut. The
   * leaves either side of a cut are disjoint half-planes, so both grids are
   * clipped at the line and both erode streetW/2 from it — there is already a
   * street on every cut, drawn by nobody, whether or not a seam is reserved.
   * Measured on 26 cuts that carry no seam: median 16 m, range 9-24, which is
   * the streetW of whichever districts meet there. A 15 m reservation fits
   * INSIDE that street and buys not one metre of it; all it does is push both
   * building lines out another twenty. Two of them, a kilometre each, on every
   * island: 6.9 ha of a 132 ha island. Controlled — the same configs with the
   * diagonals array emptied, 24 islands — the seams and boulevards together
   * were costing 98 lots per island and 4.7 points of the land's share in lots,
   * which is the whole of the gap to the authored islands and more.
   *
   * So the reservation is only the WIDENING that turns the join's own street
   * into one somebody named. Four to nine metres measures 26.5 m median between
   * the building lines (10 seams, 5 islands), against the 16 m the bare join
   * already gives and the 11-27 m of the streets around it: Greenwich Ave is
   * 18 m, Boylston St about 24, Broadway and Sixth Avenue and Boston's
   * Massachusetts Avenue about 30. It was 12-18 — 35.6 m measured, a six-lane
   * arterial through a town of fourteen hundred lots, twice.
   *
   * THE REST OF THE DOUBLE CHARGE CANNOT BE FIXED FROM THIS FILE. Charging the
   * setback once — an edge already fronting a diagonal's apron does not also
   * pay streetW/2 — is the correct model and is worth another 35 lots an island
   * (measured: 1297 -> 1332 over the 24-island sample). It lives in
   * citygen.mjs's pushBlock, and it moves the authored islands too: New Alden
   * +1 lot, Kestrel Point +13. Existing saves store three fields and rebuild
   * the map, so that is a save-breaking change and it is not taken here.
   */
  const seams = [];
  {
    const Dsm = dice(stream(s, 0x5ea115));
    const sameGrain = (a, b) => {
      const da = districts[a], db = districts[b];
      if (!da || !db || a === b) return true;
      if (da.kind !== db.kind) return false;
      if (da.kind === "organic") return true;
      return Math.abs(fold(da.bearingDeg - db.bearingDeg)) < 8;
    };
    const keysUnder = (node) => (typeof node === "string" ? [node] : [...keysUnder(node.neg), ...keysUnder(node.pos)]);
    const found = [];
    const addSeam = ([nx, ny, c], hp) => {
      // The cut's line, parameterised from its own closest point to the origin.
      const p0 = [nx * c, ny * c], dir = [-ny, nx];
      let t0 = -6000, t1 = 6000;
      for (const [ax, ay, ad] of hp) {
        const den = ax * dir[0] + ay * dir[1];
        const num = ad - (ax * p0[0] + ay * p0[1]);
        if (Math.abs(den) < 1e-9) { if (num < 0) return; continue; }
        const t = num / den;
        if (den > 0) t1 = Math.min(t1, t); else t0 = Math.max(t0, t);
      }
      if (t1 - t0 < 200) return;
      // Only the part of it that is on dry ground with room for a roadway.
      let bestA = null, bestB = null, curA = null;
      const close = (t) => {
        if (curA !== null && (bestA === null || t - curA > bestB - bestA)) { bestA = curA; bestB = t; }
        curA = null;
      };
      for (let t = t0; t <= t1; t += 10) {
        const p = [p0[0] + dir[0] * t, p0[1] + dir[1] * t];
        if (inRing(p, inner) && distToRing(p, inner) > 22) { if (curA === null) curA = t; } else close(t);
      }
      close(t1);
      if (bestA === null || bestB - bestA < 240) return;
      found.push({
        cx: Math.round(p0[0] + dir[0] * (bestA + bestB) / 2),
        cy: Math.round(p0[1] + dir[1] * (bestA + bestB) / 2),
        // A SEAM IS A STREET, NOT A BOULEVARD — and `h` is the widening, not
        // the street. See the note on the block above: the cut already carries
        // 16 m of street on its own, the reservation adds h + 2*DIAG_CLEAR +
        // streetW on top of it, so 4-9 here measures a 26.5 m avenue where
        // 12-18 measured a 35.6 m arterial.
        //
        // THE MEASUREMENT THIS COMMENT USED TO CARRY DOES NOT REPRODUCE. It
        // read: "At 15-23 m and three of them across a 1.4 km2 island the seams
        // alone were taking 3.4% of the land as roadway on top of the
        // boulevards, and the island's share of ground in lots fell from the
        // authored 59% to 49%." Rebuilding exactly that state — Dsm.f(15, 23)
        // and slice(0, 3) below — over 24 islands: the seams' own footprint is
        // 4.45% of the land, not 3.4%, and the share of ground in lots is
        // 52.4%, not 49%. The 12-18 that replaced it measures 53.5%, so the
        // change the comment credits with recovering ten points of lot share
        // recovered one. The authored 59% is right and was never reached; 4-9
        // gets to 54.7%, and the rest of the way is the double charge above,
        // which cannot be fixed from this file. Every number in this paragraph
        // is from test runs on the 24-island sample, none of it from arithmetic.
        w: Math.round(bestB - bestA), h: Math.round(Dsm.f(4, 9)),
        deg: +((Math.atan2(dir[1], dir[0]) * R2D + 360) % 360).toFixed(1),
      });
    };
    (function walk(node, hp) {
      if (typeof node === "string") return;
      const [nx, ny, c] = node.cut;
      const A = keysUnder(node.neg), B = keysUnder(node.pos);
      if (A.some((a) => B.some((b) => !sameGrain(a, b)))) addSeam(node.cut, hp);
      walk(node.neg, [...hp, [nx, ny, c]]);
      walk(node.pos, [...hp, [-nx, -ny, -c]]);
    })(partition, []);
    found.sort((a, b) => b.w - a.w);
    seams.push(...found.slice(0, 2));
  }

  // --- 5. the cores ----------------------------------------------------------
  // A site is only a candidate if it is on dry ground with room around it, in
  // the leaf it is supposed to be in. `wants` walks the land samples and takes
  // the one nearest where the core belongs, so a core can never end up at sea,
  // in a park, or in the wrong district.
  const wants = (target, want, clear) => {
    let best = null, bd = Infinity;
    for (const l of land) {
      if (l.edge < clear) continue;
      if (want && l.d !== want) continue;
      const d = dist(l.p, target);
      if (d < bd) { bd = d; best = l.p; }
    }
    return best;
  };

  const Dk = dice(stream(s, 0xc03e5));
  // The dominant core sits in the Exchange, hard against the old town's edge —
  // which is to say a few hundred metres off the harbour. That is where the
  // counting houses went: close enough to the ships to see them come in, far
  // enough back to be on a street a carriage could use.
  const seats = [];
  // WHERE DOWNTOWN IS depends on how the town is arranged. A banded port has it
  // a fixed way up the spine from the water; a town that grew in rings has it
  // at the hub the rings are drawn about, which is where its landing was. Both
  // answers are then snapped to real ground inside the Exchange, so neither can
  // put the counting houses at sea.
  const downtownAt = arrangement === "bands"
    ? ptAt(quantile(fOld + (fCore - fOld) * 0.28), across(exchSide) * 0.35)
    : slotTree.hub;
  const seatCore = wants(downtownAt, kCore, 90)
    ?? wants(downtownAt, kCore, 40)
    ?? mid;
  seats.push({ xy: seatCore, r: Math.round(Dk.f(245, 300)) });
  // Midtown, then the far end.
  seats.push({ xy: wants(ptAt(quantile(Dk.f(0.55, 0.66))), null, 80) ?? ptAt(quantile(0.6)), r: Math.round(Dk.f(265, 320)) });
  seats.push({ xy: wants(ptAt(quantile(Dk.f(0.84, 0.92))), null, 60) ?? ptAt(quantile(0.88)), r: Math.round(Dk.f(210, 270)) });
  // The docks, if there are any.
  if (districtKeys.ind) {
    seats.push({ xy: wants(dockAt, kInd, 55) ?? dockAt, r: Math.round(Dk.f(160, 205)) });
  }
  // WEIGHTS FALL OFF FROM THE SEAT, and that is arranged by construction rather
  // than asserted: rank the sites by how far they are from the dominant one and
  // hand out the weights in that order, so the second-densest employment
  // cluster in the town is always the one nearest downtown.
  const wLadder = [1.0, +Dk.f(0.46, 0.64).toFixed(2), +Dk.f(0.14, 0.24).toFixed(2), +Dk.f(0.08, 0.13).toFixed(2)];
  const cores = seats
    .map((c, i) => ({ ...c, d0: i === 0 ? -1 : dist(c.xy, seats[0].xy) }))
    .sort((a, b) => a.d0 - b.d0)
    .map((c, i) => ({ xy: [Math.round(c.xy[0]), Math.round(c.xy[1])], w: wLadder[i], r: c.r }));

  /**
   * A RADIAL PLAN IS AIMED AT SOMETHING, and that is the whole of what makes it
   * one. Karlsruhe's thirty-two avenues converge on the Schloss; L'Enfant's on
   * the Capitol and the President's house; the Étoile on a triumphal arch.
   * Aiming the spokes at the middle of the district's bounding box would be a
   * dartboard, not a plan, so each one is given a real place on this island:
   * downtown gets its own seat, the landing gets the head of the harbour — an
   * off-centre focus, which is what turns a wheel into a FAN opening on the
   * water — and the housing gets the middle of its own ground, which is where
   * a suburb's church and green usually are.
   */
  for (const [k, d] of Object.entries(districts)) {
    if (d.kind !== "radial") continue;
    const role = districtRole[k];
    const aim = role === "core" ? cores[0].xy
      : role === "old" ? harbourHead
        : role === "ind" ? dockAt
          : roleMid(role);
    d.focus = [Math.round(aim[0]), Math.round(aim[1])];
    delete d.focusWant;
  }

  // The land-value surface generateCity will compute, reproduced here so the
  // things that go on top of it — the squares, the railway — can be put where
  // the value is. `rawHeat` is the same sum without generateCity's clamp at 1;
  // see the station-weight note below for why the clamp is wrong for ranking.
  const rawHeat = (p) => cores.reduce((h, c) => h + c.w * Math.exp(-(dist(p, c.xy) ** 2) / (2 * c.r * c.r)), 0);
  const coreHeat = (p) => Math.min(1, rawHeat(p));

  // --- 6. parks --------------------------------------------------------------
  // A rectangle only goes down if its whole footprint is on land with a street's
  // width to spare, and if it is not sitting on another park. Nine probes round
  // the rim, then shrink and try again — the same thing a surveyor does when the
  // common will not fit where the plan said it would.
  const Dp = dice(stream(s, 0x9a2c5));
  const parkDeg = +(-districts[kCore].bearingDeg).toFixed(1);
  const parks = [];
  // ---- WHAT SHAPE A PARK IS ------------------------------------------------
  //
  // Every park in this game was a rotated rectangle, and every park in a town
  // shared one bearing. A rectangle is the one shape that says SOMEBODY DREW
  // THIS ON A PLAN, which is true of a formal square and true of almost
  // nothing else: a real park is usually the shape of the leftover. It is the
  // wedge where two grids meet at different angles, the strip along a shore or
  // a filled canal, the green whose corners were cut away for the traffic.
  //
  // THEY HAVE TO STAY CONVEX. Parks are obstacles the generator differences
  // out of the blocks around them, and `subtractConvex` decomposes cell \
  // obstacle into convex pieces using the obstacle's own half-planes — which
  // is what guarantees the map has no holes in it. An L-shaped green would
  // break that guarantee, so the shapes below are all convex and an L is
  // deliberately not among them.
  const parkShape = (kind, cx, cy, w, h, deg, k) => {
    const t = (deg * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
    const put = (pts) => pts.map(([x, y]) => [x * ct - y * st + cx, x * st + y * ct + cy]);
    if (kind === "wedge") {
      // THE LEFTOVER BETWEEN TWO GRIDS. Where a district at one bearing meets
      // one at another, the ground between them is a trapezoid, and a trapezoid
      // is what a great many real city greens actually are.
      const taper = 0.30 + 0.34 * k;
      return put([[-w / 2, -h / 2], [w / 2, -h * taper / 2], [w / 2, h * taper / 2], [-w / 2, h / 2]]);
    }
    if (kind === "clipped") {
      // CORNERS CUT FOR THE TRAFFIC. An octagonal green — the commonest thing
      // that happens to a square once carriages have to get round it.
      const c = Math.min(w, h) * (0.16 + 0.16 * k);
      return put([
        [-w / 2 + c, -h / 2], [w / 2 - c, -h / 2], [w / 2, -h / 2 + c], [w / 2, h / 2 - c],
        [w / 2 - c, h / 2], [-w / 2 + c, h / 2], [-w / 2, h / 2 - c], [-w / 2, -h / 2 + c],
      ]);
    }
    if (kind === "lozenge") {
      // A green on the skew, which is what you get when the reservation was
      // surveyed before the streets that ended up round it.
      const c = Math.min(w, h) * 0.34;
      return put([
        [-w / 2, -h / 2 + c], [-w / 2 + c, -h / 2], [w / 2 - c, -h / 2], [w / 2, -h / 2 + c],
        [w / 2, h / 2 - c], [w / 2 - c, h / 2], [-w / 2 + c, h / 2], [-w / 2, h / 2 - c],
      ]);
    }
    if (kind === "round") {
      // THE ROUND GREEN — a rotunda, a traffic circle planted, a reservoir
      // capped. Convex by construction, which is why it belongs here and an L
      // does not.
      const rx = w / 2;
      const ry = (h / 2) * (0.88 + 0.12 * k);
      const n = 28 + Math.floor(k * 8);
      return put(Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2;
        return [rx * Math.cos(a), ry * Math.sin(a)];
      }));
    }
    return rect(cx, cy, w, h, deg);
  };

  // The direction the shore runs at a point — the tangent of the nearest coast
  // edge. An esplanade that ignores this is a rectangle lying across the beach.
  const coastBearing = (p) => {
    let best = Infinity, ang = parkDeg;
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i], b = inner[(i + 1) % inner.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1;
      let u = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
      u = Math.max(0, Math.min(1, u));
      const d = dist(p, [a[0] + u * dx, a[1] + u * dy]);
      if (d < best) { best = d; ang = (Math.atan2(dy, dx) * 180) / Math.PI; }
    }
    return ang;
  };

  // `clear` is how close to the water this park may come. Everything inland
  // keeps the old street's-width standoff; an esplanade is allowed to reach the
  // shore, because reaching the shore is the entire point of one.
  const fitsRing = (ring, cx, cy, w, h, clear = 14, seamPad = 26) => {
    const probes = [...ring, ...ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    }), [cx, cy]];
    return probes.every((p) => inRing(p, inner) && distToRing(p, inner) > clear)
      && parks.every((q) => dist([cx, cy], [q.cx, q.cy]) > (Math.max(w, h) + Math.max(q.w, q.h)) * 0.62)
      // Nor ON TOP OF a seam street. Both are obstacles the generator
      // differences out of the same cells, so a common laid ACROSS one comes
      // out as a green with a road through the middle of it and no way in.
      //
      // Beside one is a different thing entirely, and it is the other park a
      // town like this should have: the long thin green along the arterial,
      // which exists precisely because the ground left over where two grids
      // are reconciled is too awkward to build on. `seamPad` is how much
      // clearance the test demands — the default keeps a green well clear, and
      // a linear park asks for the minimum that still leaves the road its
      // carriageway.
      && seams.every((q) => !probes.some((p) => inRing(p, rect(q.cx, q.cy, q.w, q.h + seamPad, q.deg))));
  };

  /**
   * `opts` — { want, shape, clear, bearing, aspect }. `bearing` is a function
   * of the candidate point, so an esplanade can follow the shore while an
   * inland green keeps the town's own grain.
   */
  const placePark = (target, w0, h0, name, opts = {}) => {
    const { want = null, shape = "square", clear = 14, bearing = null, seamPad = 26 } = opts;
    for (let shrink = 0; shrink < 4; shrink++) {
      const w = w0 * (1 - 0.14 * shrink), h = h0 * (1 - 0.14 * shrink);
      let best = null, bd = Infinity, bestRing = null, bestDeg = parkDeg;
      for (const l of land) {
        if (want && l.d !== want) continue;
        const d = dist(l.p, target);
        if (d >= bd) continue;
        // A GREEN IS SURVEYED WITH ITS NEIGHBOURHOOD, not with the town hall.
        // Every park shared one bearing — the core district's — so a square
        // dropped into a quarter laid out thirty degrees off sat skew to every
        // street around it. It takes the grid of the district it lands in,
        // which is what makes it read as part of that quarter rather than as
        // something the map remembered from somewhere else.
        const deg = bearing ? bearing(l.p)
          : l.d && districts[l.d] ? +(-districts[l.d].bearingDeg).toFixed(1)
            : parkDeg;
        const k = Dp.rand();
        const ring = parkShape(shape, l.p[0], l.p[1], w, h, deg, k);
        if (!fitsRing(ring, l.p[0], l.p[1], w, h, clear, seamPad)) continue;
        bd = d; best = l.p; bestRing = ring; bestDeg = deg;
      }
      if (best) {
        parks.push({
          cx: Math.round(best[0]), cy: Math.round(best[1]),
          w: Math.round(w), h: Math.round(h), deg: +bestDeg.toFixed(1), name,
          // The drawn shape. `w`/`h` stay the bounding box because the amenity
          // term and the station namer size a park off them, and a park's pull
          // is about how big it is rather than how many sides it has.
          ring: bestRing.map(([x, y]) => [Math.round(x), Math.round(y)]),
          shape,
        });
        return true;
      }
    }
    return false;
  };
  // WHAT KIND OF PARK CITY THIS IS — and it used to be only ever one kind.
  //
  // This laid down exactly three: a square on the core, a common between
  // downtown and the housing, and a green on the third core. Measured across
  // forty generated islands, all forty had exactly three parks and the largest
  // was 71-79% of the total green in EVERY ONE of them. That is not forty
  // cities, it is one park programme wearing forty seeds — and it is what the
  // owner meant by "the parks are always the same size relative to the city".
  //
  // Real cities differ in this more than in almost anything else you can see
  // from the air, and they differ in a way that is not noise — it is a decision
  // some council took once and the town has lived with ever since:
  //
  //   one great park   Manhattan, San Francisco: a single enormous reservation
  //                    and a handful of little squares round the edges
  //   a set of squares Savannah has twenty-two, Bloomsbury a dozen garden
  //                    squares — many small greens, no large one at all
  //   commons          Boston and the Victorian park movement: four to seven
  //                    mid-sized parks spread across the districts
  //   a few greens     the old shape: two or three large, no dominant one
  //   almost none      a dense port that never set the ground aside and now
  //                    cannot afford to
  //
  // So the town draws a PROGRAMME and then places to it. `share` is the
  // fraction of the largest park's area the rest are sized against, which is
  // what makes "one great park" read differently from "a few greens" even when
  // the total green is similar.
  const PARK_PROGRAMMES = [
    { key: "great", w: 0.20, n: [3, 5], big: [420, 560], rest: [70, 105] },
    { key: "squares", w: 0.20, n: [8, 14], big: [95, 130], rest: [60, 100] },
    { key: "commons", w: 0.24, n: [4, 7], big: [210, 265], rest: [130, 190] },
    { key: "greens", w: 0.24, n: [2, 3], big: [300, 360], rest: [150, 230] },
    { key: "sparse", w: 0.12, n: [1, 2], big: [110, 170], rest: [70, 95] },
  ];
  // MEASURED AND NOT A PROBLEM. Two things were suspected here and neither
  // held. The programme is drawn without asking whether the island can seat it
  // — but over 150 towns the great park was seatable at full size on every one
  // of them, so a veto would have been a check that cannot fail. And the placer
  // shrinks a park 14% and retries when it will not fit, which looked like it
  // would make a park's size an artifact of crowding rather than a decision —
  // but over 865 placements, 99.7% went down at full size, 0.3% shrank one
  // step, and none failed. Left alone deliberately; see the note in
  // GRAPHICS_HANDOFF.
  const programme = (() => {
    let r = Dp.rand() * PARK_PROGRAMMES.reduce((a, p) => a + p.w, 0);
    for (const p of PARK_PROGRAMMES) { r -= p.w; if (r <= 0) return p; }
    return PARK_PROGRAMMES[PARK_PROGRAMMES.length - 1];
  })();
  const nPark = Math.round(Dp.f(programme.n[0], programme.n[1]));
  // THE NAMES HAVE TO STRETCH TO FOURTEEN. Three hardcoded names were enough
  // for three parks; a city of squares needs a supply of them, so they are
  // drawn from the island's own word list with the suffix that matches what
  // the programme is building. A "Common" is not a "Square" is not a "Green",
  // and calling ten small greens "Commons" would be the map lying about what
  // it is showing.
  const SUFFIX = programme.key === "squares" ? ["Square", "Place", "Gardens"]
    : programme.key === "great" ? ["Park", "Common", "Green"]
      : programme.key === "commons" ? ["Common", "Park", "Green"]
        : ["Green", "Common", "Park"];
  const usedNames = new Set();
  const parkName = (i) => {
    for (let t = 0; t < 24; t++) {
      const stem = t === 0 && i === 0 ? nm.stem : nm.words[(i + t) % nm.words.length];
      const n = `${stem} ${SUFFIX[(i + Math.floor(t / nm.words.length)) % SUFFIX.length]}`;
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
    return `${nm.words[i % nm.words.length]} Green ${i}`;
  };
  // THE BIGGEST GOES DOWN FIRST, on the ground between downtown and the
  // housing, which is where a city puts the one piece of ground it agrees
  // never to build on. generateCity ranks the squares by the heat under them
  // and puts the town hall on the top one, so the order here is also the
  // decision about where the seat of government stands.
  const midCore = [(cores[0].xy[0] + cores[1].xy[0]) / 2, (cores[0].xy[1] + cores[1].xy[1]) / 2];
  const bigW = Dp.f(programme.big[0], programme.big[1]);
  // The great one keeps its formal shape — except in a city of squares, where
  // the dominant green is often round (Columbus Circle, the Place des Vosges).
  const bigShape = programme.key === "squares" && Dp.rand() < 0.55 ? "round"
    : programme.key === "commons" && Dp.rand() < 0.35 ? "round"
      : "square";
  placePark(midCore, bigW, bigW * Dp.f(0.62, 0.86), parkName(0), { shape: bigShape });

  // THE ESPLANADE, which a harbour town has and this one could not.
  //
  // `fits` required a street's width of dry land on every probe, so no park
  // could ever reach the water — in a game whose whole setting is a port. The
  // promenade along the shore is the most characteristic public ground such a
  // town has, and it is long, thin, and lies ALONG the coast rather than
  // across it, which is why it needs the shore's own bearing rather than the
  // town's grain.
  //
  // Placed early and given its own aim point on the wettest ground available,
  // because a strip that has to dodge three greens already down comes out
  // somewhere inland with no water anywhere near it.
  if (Dp.rand() < 0.62) {
    const shore = land.reduce((a, l) => (l.edge < a.edge ? l : a), land[0]);
    const len = bigW * Dp.f(0.75, 1.25);
    placePark(shore.p, len, Dp.f(38, 62), `${nm.words[3]} Esplanade`, {
      shape: "square", clear: 3, bearing: coastBearing,
    });
  }

  // THE LINEAR PARK, on the ground the plan could not reconcile.
  //
  // A seam is where two grids at different bearings are made to meet, and the
  // ground along one is the most awkward in the city — wedge-shaped lots, bad
  // angles, frontage nobody wants. That is exactly the ground a town gives up
  // on and plants: the strip along the arterial, the filled canal, the
  // boulevard's central reservation. `fits` rejected all of it, because the
  // one thing it knew about seams is that a park laid ACROSS one comes out
  // with a road through the middle. Beside one is the opposite: it is the
  // park that only exists because the road is there.
  //
  // Long, thin, on the seam's own bearing, and offset clear of the
  // carriageway. `seamPad` drops to the width of the road itself so "beside"
  // is reachable at all, and `placePark` still refuses anything overlapping.
  if (seams.length && Dp.rand() < 0.5) {
    const sm = seams[Math.floor(Dp.rand() * seams.length) % seams.length];
    const t = (sm.deg * Math.PI) / 180;
    const side = Dp.rand() < 0.5 ? 1 : -1;
    const wide = Dp.f(34, 58);
    const off = sm.h / 2 + wide / 2 + 16;
    const aim = [sm.cx - Math.sin(t) * off * side, sm.cy + Math.cos(t) * off * side];
    placePark(aim, Dp.f(150, 320), wide, `${nm.words[4]} Walk`, {
      shape: "square", seamPad: 2, bearing: () => +sm.deg.toFixed(1),
    });
  }

  // ...and the rest are scattered across the cores in turn, so a city of
  // squares gets them spread through its districts rather than piled on
  // downtown. Each takes the next core round the ring, which is what stops
  // the set reading as a starburst.
  //
  // THE SHAPE IS PART OF WHAT KIND OF GREEN IT IS. A formal square is drawn;
  // everything else is usually the shape of the ground that was left, so the
  // small ones lean to the wedge and the cut corner and the great one above
  // does not.
  const SHAPES = ["square", "clipped", "wedge", "lozenge", "round", "square", "wedge", "round"];
  for (let i = 1; i < nPark; i++) {
    const target = cores[i % cores.length].xy;
    const w = Dp.f(programme.rest[0], programme.rest[1]);
    // A jittered aim point, or every park after the first lands on the same
    // few cells and `fits` rejects it for sitting on its predecessor.
    const aim = [target[0] + Dp.f(-260, 260), target[1] + Dp.f(-260, 260)];
    const shape = SHAPES[Math.floor(Dp.rand() * SHAPES.length) % SHAPES.length];
    placePark(aim, w, w * Dp.f(0.66, 1.0), parkName(i), { shape });
  }

  // --- 7. the streets that refuse the grid -----------------------------------
  // The seams come first: they are structural, they are where the plan
  // reconciles itself, and they are the ones a city names. Then the
  // boulevards — nought to three of them, drawn back in the plan — each the
  // longest chord it can make on dry land through somewhere worth going. The
  // somewhere is the ground BETWEEN two cores, which is what `from` and `to`
  // are for and all they are for: the avenue is seeded on the midpoint of the
  // pair and then driven across the grain at 26-62 degrees to the core
  // district's own bearing. It is not aimed AT either core, and it should not
  // be described as if it were — an avenue that lies down with the grid is a
  // wide street, not an avenue, and the angle is the only thing that
  // guarantees it refuses one. Successive avenues take successive pairs, so
  // the second and third are laid between different cores rather than over the
  // same ground, which is what makes them a system rather than a starburst.
  //
  // `h`, like the seam's, is a RESERVATION and not a width — see the long note
  // on the seams. Measured on the ground, a boulevard declared at 25.5 m comes
  // out 51.4 m between the building lines. That number is left alone because
  // that number is right: Pennsylvania Avenue is 49 m building line to building
  // line, the Ringstrasse 57, Unter den Linden 60, Commonwealth Avenue 73. It
  // is only the LABEL that was wrong, and the authored islands declare 25 and
  // 27 in the same units, so they are the same street.
  const Db = dice(stream(s, 0xb0d1e));
  const diagonals = [...seams];
  const coreBearing = districts[kCore].bearingDeg;
  // ...AND WHAT KIND OF STREET THEY ARE, which was never a question before.
  //
  // The count already varied nought to three. The WIDTH did not: every one of
  // them was declared at 22-30 m, so a town with three got three grand
  // boulevards and there was no such thing as a city with a network of ordinary
  // wide roads. That is the commoner arrangement of the two. Paris and
  // Washington built monuments you drive down; most cities that outgrew their
  // grid just widened a few through-routes and called them avenues, and those
  // come out around half the width.
  //
  // So a town draws a CHARACTER as well as a count, and the two are related the
  // way they are in life: one refusal of the grid tends to be the grand one a
  // city is known for, and a set of three is usually a traffic plan rather than
  // three monuments. Declared width is a RESERVATION — see the note above; 25.5
  // declared measures 51 m between building lines, which is Pennsylvania Avenue.
  // An arterial at 15 measures about 30, which is a wide ordinary street.
  const grand = nBoulevard <= 1 ? Db.chance(0.72) : Db.chance(0.30);
  const boulevardW = () => (grand ? Db.f(23, 31) : Db.f(13, 19));
  for (let b = 0; b < nBoulevard; b++) {
    const from = cores[Math.min(cores.length - 1, b)].xy;
    const to = cores[Math.min(cores.length - 1, b + 1)].xy;
    const seed0 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const ang = (coreBearing + Db.f(26, 62) * Db.sign()) * Math.PI / 180;
    // bearingDeg is a compass bearing; the map angle of the same line is 90 - it.
    const dir = [Math.cos(Math.PI / 2 - ang), Math.sin(Math.PI / 2 - ang)];
    const reach = (sgn) => {
      let t = 0;
      for (; t < 900; t += 10) {
        const p = [seed0[0] + dir[0] * sgn * (t + 10), seed0[1] + dir[1] * sgn * (t + 10)];
        if (!inRing(p, inner) || distToRing(p, inner) < 26) break;
      }
      return t;
    };
    const rp = reach(1), rn = reach(-1);
    if (rp + rn <= 420) continue;
    const cand = {
      cx: Math.round(seed0[0] + dir[0] * (rp - rn) / 2),
      cy: Math.round(seed0[1] + dir[1] * (rp - rn) / 2),
      w: Math.round(rp + rn), h: Math.round(boulevardW()),
      deg: +((Math.atan2(dir[1], dir[0]) * R2D + 360) % 360).toFixed(1),
    };
    // Two boulevards a hundred metres apart at the same angle is one boulevard
    // drawn twice; a crossing is what makes the pair read as a plan.
    if (diagonals.some((q) => dist([q.cx, q.cy], [cand.cx, cand.cy]) < 200
      && Math.abs(fold(q.deg - cand.deg)) < 18)) continue;
    diagonals.push(cand);
  }

  // --- 8. the working waterfront ---------------------------------------------
  // A pier is rooted on the quay and reaches into the water, which is why the
  // authored ones straddle the shoreline instead of floating off it. Anchors go
  // in the harbour first — that is what the harbour is for — and then along the
  // dock district's frontage.
  const Dw = dice(stream(s, 0x2132));
  const piers = [];
  const anchorAt = (th) => {
    const ray = C.at(th);
    let best = 0, bd = Infinity;
    for (let i = 0; i < COAST.length; i++) {
      const d = dist(COAST[i], ray);
      if (d < bd) { bd = d; best = i; }
    }
    const a = COAST[(best - 1 + COAST.length) % COAST.length], b = COAST[(best + 1) % COAST.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
    let n = [ey / L, -ex / L];
    const c = centroid(COAST);
    if ((COAST[best][0] - c[0]) * n[0] + (COAST[best][1] - c[1]) * n[1] < 0) n = [-n[0], -n[1]];
    return { p: COAST[best], n, t: [-n[1], n[0]] };
  };
  const addPier = (th) => {
    const { p, n, t } = anchorAt(th);
    const back = Dw.f(30, 44), out = Dw.f(95, 135), hw = Dw.f(17, 22);
    const root = [p[0] - n[0] * back, p[1] - n[1] * back];
    const tip = [p[0] + n[0] * out, p[1] + n[1] * out];
    if (!inRing(root, inner)) return false;
    if (inRing(tip, COAST)) return false;
    if (piers.some((q) => dist(centroid(q), centroid([
      [root[0] + t[0] * hw, root[1] + t[1] * hw], [tip[0] + t[0] * hw, tip[1] + t[1] * hw],
      [tip[0] - t[0] * hw, tip[1] - t[1] * hw], [root[0] - t[0] * hw, root[1] - t[1] * hw],
    ])) < 150)) return false;
    piers.push([
      [root[0] + t[0] * hw, root[1] + t[1] * hw],
      [tip[0] + t[0] * hw, tip[1] + t[1] * hw],
      [tip[0] - t[0] * hw, tip[1] - t[1] * hw],
      [root[0] - t[0] * hw, root[1] - t[1] * hw],
    ].map(([x, y]) => [Math.round(x), Math.round(y)]));
    return true;
  };
  for (let k = 0; k < 3; k++) addPier(C.th.harbour + C.wHarb * Dw.f(-0.72, 0.72));
  // The dock district's own frontage: sweep the shoreline for the stretch that
  // belongs to it and hang two or three more off that.
  const dockThetas = [];
  for (let k = 0; k < 240; k++) {
    const th = (k / 240) * TAU;
    const p = C.at(th);
    const q = [p[0] * 0.93, p[1] * 0.93];
    if (inRing(q, inner) && leafOf(q) === kInd) dockThetas.push(th);
  }
  if (dockThetas.length) {
    for (let k = 0; k < 3; k++) addPier(dockThetas[Math.floor(((k + 0.5) / 3) * dockThetas.length)]);
  } else {
    for (let k = 0; k < 2; k++) addPier(C.th.cove + Dw.f(-0.4, 0.4));
  }

  const cranes = [];
  for (const pier of piers.slice(-2)) {
    const c = centroid(pier);
    const back = [c[0] + (mid[0] - c[0]) * 0.16, c[1] + (mid[1] - c[1]) * 0.16];
    if (inRing(back, inner) && distToRing(back, inner) > 12) {
      cranes.push([Math.round(back[0]), Math.round(back[1]), Math.round(Dw.f(0, 180))]);
    }
  }

  // Ships lie in the roads outside the harbour mouth and off the estuary.
  const ships = [];
  const offshore = (p, d, deg) => {
    const L = Math.hypot(p[0], p[1]) || 1;
    const q = [p[0] + (p[0] / L) * d, p[1] + (p[1] / L) * d];
    if (!inRing(q, COAST)) ships.push([Math.round(q[0]), Math.round(q[1]), Math.round(deg)]);
  };
  offshore(harbourMouth.mid, Dw.f(90, 190), Dw.f(0, 360));
  offshore(C.at(C.th.river), Dw.f(60, 150), Dw.f(0, 360));
  offshore(C.at(C.th.cove), Dw.f(120, 240), Dw.f(0, 360));

  // A breakwater across the harbour mouth, a third of the way over — enough to
  // make the roads a harbour and not enough to close it.
  const breakwaters = [];
  {
    const chord = dist(harbourMouth.a, harbourMouth.b);
    const bdeg = Math.atan2(harbourMouth.b[1] - harbourMouth.a[1], harbourMouth.b[0] - harbourMouth.a[0]) * R2D;
    const t = Dw.f(0.16, 0.30);
    const cx = harbourMouth.a[0] + (harbourMouth.b[0] - harbourMouth.a[0]) * t;
    const cy = harbourMouth.a[1] + (harbourMouth.b[1] - harbourMouth.a[1]) * t;
    if (!inRing([cx, cy], COAST)) {
      breakwaters.push([Math.round(cx), Math.round(cy), Math.round(chord * Dw.f(0.22, 0.34)), Math.round(Dw.f(12, 16)), +bdeg.toFixed(1)]);
    }
  }

  // --- 9. the railway --------------------------------------------------------
  /**
   * A STATION'S WEIGHT IS ITS RIDERSHIP, and ridership is the people who get on
   * plus the people who get off: the residents in its catchment plus the jobs
   * in it. The job surface is the core heat, which is the same surface the
   * whole generator prices land off. The residential base is very nearly flat
   * across a built-up island — everybody lives somewhere — so ridership is a
   * constant plus a multiple of the heat. That is the shape; the two numbers
   * are measured, not chosen.
   *
   * MEASURED, on all sixteen hand-set stations across New Alden and Kestrel
   * Point: regressing the authored weight on the core heat under each station
   * gives w = 21.6 + 53.8*heat, RMS residual 15.3 against a spread of 26.4 —
   * R2 = 0.67. So the heat surface explains two thirds of what the two authored
   * tables say, and the line below is that regression rounded.
   *
   * It is not a better fit than that and it should not pretend to be. The
   * remaining third is deliberate hand-authoring the surface cannot see: on
   * Kestrel Point "Custom House" is weighted 44 and "Battery" 100 with the same
   * heat under both, because one of them is a minor stop two hundred metres
   * from the principal one. A generated railway has no such history to encode.
   *
   * The heat used here is the RAW sum, not generateCity's version of it, which
   * clamps at 1. The clamp costs the fit a fifth of its R2 (0.60 against 0.67)
   * because it flattens every downtown station onto the same value — and this
   * is ranking stations against each other, which is exactly what the clamp
   * destroys. Nothing downstream reads the absolute number: build.mjs
   * normalises the transit kernel against its own 95th percentile.
   */
  const Ds = dice(stream(s, 0x57a71));
  const stations = [];
  const addStation = (xy, name) => {
    if (!xy) return;
    if (stations.some((q) => dist(q.xy, xy) < 210)) return;
    const heat = rawHeat(xy);
    const lines = [];
    if (Math.abs(across(xy)) < 300) lines.push("1");
    if (along(xy) > quantile(0.45)) lines.push("2");
    if (along(xy) < quantile(0.55)) lines.push("A");
    if (leafOf(xy) === kInd) lines.push("W");
    // WHAT MAKES A STATION BUSY, and it was only ever one thing.
    //
    // Ridership was `22 + 54 * heat`, and heat is proximity to the core — so
    // every station's weight was a restatement of the same downtown, and the
    // transit half of the demand surface said exactly what the employment half
    // said. Measured across six generated islands, demand came out with ONE
    // local peak and ONE top-decile cluster on every single one, correlating
    // 0.61 to 0.94 with distance from a single best point. That is the owner's
    // "all the demand surrounding one specific place", and this is half its
    // cause.
    //
    // An interchange is busy on its own account. Two lines crossing is a reason
    // to change trains, a reason to open a shop, and a reason for an office
    // that is not downtown — Shinjuku and Clapham Junction are not central and
    // are not quiet. So lines served counts, and it counts most where the core
    // heat is least, because an interchange in the middle of downtown adds
    // nothing you did not already have.
    const nLines = Math.max(1, (lines.length ? lines : ["1"]).length);
    const junction = (nLines - 1) * 26 * (1 - 0.55 * heat);
    stations.push({
      name, lines: (lines.length ? lines : ["1"]).join(" "),
      xy: [Math.round(xy[0]), Math.round(xy[1])],
      weight: Math.round(22 + 54 * heat + junction),
    });
  };
  // THE RAILWAY STOPS AT THE PARKS THAT EXIST, whatever they turned out to be.
  //
  // This looked up three parks BY NAME — the square, the common and the green —
  // which worked only while the generator always laid down exactly those three.
  // A city of twelve squares has no "Common" and a sparse port may have one
  // park in total, so the stops are chosen the way a railway chooses them: the
  // one nearest downtown gives the downtown platform its name, and the largest
  // greens elsewhere get a stop of their own because that is where the traffic
  // is on a Sunday.
  const parkArea = (p) => p.w * p.h;
  const nearestPark = (xy) => parks.reduce(
    (best, p) => (best === null || dist([p.cx, p.cy], xy) < dist([best.cx, best.cy], xy) ? p : best), null);
  const byArea = [...parks].sort((a, b) => parkArea(b) - parkArea(a));
  const sq = nearestPark(cores[0].xy);
  // ...and the two biggest that are not already the downtown stop.
  const [cm, gr] = byArea.filter((p) => p !== sq).slice(0, 2);
  addStation(cores[0].xy, sq && dist([sq.cx, sq.cy], cores[0].xy) < 320 ? sq.name : disp.core);
  if (cm) addStation(wants([cm.cx, cm.cy], null, 30), cm.name);
  addStation(wants(ptAt(quantile(fOld * 0.5)), kOld, 45), "Custom House");
  addStation(cores[1].xy, "Midtown");
  if (gr) addStation(wants([gr.cx, gr.cy], null, 30), gr.name);
  addStation(cores[2].xy, districtKeys.resi.length > 1 ? disp.resi2 : "Uptown");
  addStation(wants(ptAt(quantile(0.97)), null, 40), nm.words[2] + " End");
  if (districtKeys.ind) addStation(cores.find((c) => leafOf(c.xy) === kInd)?.xy ?? dockSide, nm.words[5] + " Wharf");
  // A working railway does not stop only at the landmarks. Fill the gaps along
  // the spine so nowhere in town is more than a few blocks from a platform.
  for (const q of [0.30, 0.44, 0.72, 0.86]) {
    addStation(wants(ptAt(quantile(q), Ds.f(-160, 160)), null, 55), nm.words[6] + " " + (q < 0.5 ? "St" : "Rd"));
  }

  // --- 10. what the map calls things -----------------------------------------
  const labels = [];
  const leafCentre = (k) => {
    const mine = land.filter((l) => l.d === k);
    if (!mine.length) return null;
    return [
      mine.reduce((a, l) => a + l.p[0], 0) / mine.length,
      mine.reduce((a, l) => a + l.p[1], 0) / mine.length,
    ];
  };
  // A DISTRICT'S LABEL GOES ON ITS OWN GROUND. The mean of a leaf's land
  // samples is not necessarily inside that leaf's land — a district wrapped
  // round a bay has its centroid in the water, which is how "MILLSIDE" ended up
  // floating offshore on seed 424242. So the mean is the target and the nearest
  // dry sample IN THAT LEAF is the answer.
  const labelDistrict = (k, text) => {
    const c = leafCentre(k);
    const at = c && (wants(c, k, 30) ?? wants(c, k, 0));
    if (at) labels.push({ name: text.toUpperCase(), labelKind: "district", xy: [Math.round(at[0]), Math.round(at[1])] });
  };
  labelDistrict(kOld, disp.old);
  labelDistrict(kCore, disp.core);
  if (districtKeys.ind) labelDistrict(kInd, disp.ind);
  labelDistrict(districtKeys.resi[0], disp.resi);
  if (districtKeys.resi[1]) labelDistrict(districtKeys.resi[1], disp.resi2);
  for (const p of parks) labels.push({ name: p.name, labelKind: "park", xy: [p.cx, p.cy] });

  // Water labels have to be ON the water. Each is pushed out along the ray it
  // sits on until it clears the coast, and dropped if it never does.
  const Dl = dice(stream(s, 0x1abe1));
  const waterAt = (th, want, name) => {
    for (let d = want; d < want + 420; d += 30) {
      const p = C.at(th);
      const L = Math.hypot(p[0], p[1]) || 1;
      const q = [p[0] + (p[0] / L) * d, p[1] + (p[1] / L) * d];
      if (!inRing(q, COAST)) {
        labels.push({ name, labelKind: "water", xy: [Math.round(q[0]), Math.round(q[1])] });
        return;
      }
    }
  };
  waterAt(C.th.harbour, Dl.f(120, 210), `${nm.name.replace(/^(New|Port)\s+/, "")} ${Dl.pick(["Harbor", "Bay", "Roads"])}`);
  waterAt(C.th.river, Dl.f(20, 70), `${nm.words[3]} River`);
  waterAt(C.th.cove, Dl.f(80, 170), `${nm.words[4]} ${Dl.pick(["Cove", "Bight", "Inlet"])}`);
  waterAt(C.th.headland + Math.PI, Dl.f(180, 320), `${nm.words[5]} ${Dl.pick(["Sound", "Channel", "Reach"])}`);

  // --- 11. the street names --------------------------------------------------
  const Dst = dice(stream(s, 0x57ee7));
  const streets = { default: DEFAULT_STREETS };
  streets[kOld] = Dst.some(OLD_STREETS, Dst.i(9, 13));
  streets[kCore] = Dst.some(CORE_STREETS, Dst.i(7, 10));
  if (districtKeys.ind) streets[kInd] = Dst.some(IND_STREETS, Dst.i(6, 9));
  // The housing gets its letters in order, starting wherever the surveyor did.
  districtKeys.resi.forEach((k, i) => {
    const start = Dst.i(0, ALPHA_STREETS.length - 9) + i * 2;
    streets[k] = ALPHA_STREETS.slice(start % ALPHA_STREETS.length, (start % ALPHA_STREETS.length) + 8)
      .map((n) => n + " St");
  });
  const avenues = [
    Dst.pick(["The Boulevard", "Grand Ave", nm.stem + "way", "The Parade"]),
    nm.stem + " Ave",
    ...Dst.some(AVENUE_POOL, 5),
  ];

  return {
    name: nm.name,
    district: nm.slug,
    abbr: nm.abbr,
    seed: s,
    generated: true,
    center: [-70.9, 41.1],
    coast: C.ring,
    coastAmp: Math.round(coastAmp),
    esplanade: Math.round(esplanade),
    // The lighthouse goes on the headland the profile put there, not on
    // whichever coast vertex happens to sit furthest from the origin.
    lighthouse: [Math.round(headlandTip[0]), Math.round(headlandTip[1])],
    cores,
    partition,
    districts,
    parks,
    diagonals,
    piers,
    cranes,
    ships,
    breakwaters,
    stations,
    labels,
    avenues,
    streets,
    // Not read by the generator — this is what the verification harness and any
    // future debugging need to ask the island what it thinks it is.
    plan: {
      spineDeg: +phiDeg.toFixed(2),
      mid: [Math.round(mid[0]), Math.round(mid[1])],
      harbour: [Math.round(harbourHead[0]), Math.round(harbourHead[1])],
      headland: [Math.round(headlandTip[0]), Math.round(headlandTip[1])],
      river: [Math.round(riverHead[0]), Math.round(riverHead[1])],
      keys: districtKeys,
      display: disp,
      nDistricts,
      // WHAT THE PLAN ACTUALLY SAID, so a harness can ask the island what it
      // thinks it is instead of inferring it from a picture. Nothing reads
      // these; they exist to be measured across seeds.
      arrangement,
      surveys: SURVEY.map((v) => ({ bearing: +v.bearing.toFixed(1), aspect: +v.aspect.toFixed(2), pitch: Math.round(v.pitch) })),
      kinds: Object.fromEntries(Object.entries(districts).map(([k, d]) => [k, d.kind])),
      lotways: Object.fromEntries(Object.entries(districts).map(([k, d]) => [k, d.lot ? d.lot.join("/") : "flavour"])),
      seams: seams.length,
      boulevards: diagonals.length - seams.length,
      boulevardKind: grand ? "grand" : "arterial",
      parkProgramme: programme.key,
      organicTown,
      smoothed: C.smoothed,
      rung: C.rung,
      depth: C.depth,
      coastOK: C.ok,
      builtArea: Math.round(Math.abs(ringArea(COAST))),
    },
  };
}
