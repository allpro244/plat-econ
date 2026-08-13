// FROM RAW GEOMETRY TO THE GAME'S SUBSTRATE.
//
// Everything between a generated city and the tables the simulation runs on:
// the parcel attribute table keyed by BBL, the adjacency graph built from
// shared lot lines, the demand surface computed off transit and employment
// gravity, the tile-ready polygon collections and the compact mesh feed the
// 3D renderer eats.
//
// THIS FILE TOUCHES NO FILES. It used to be the middle four hundred lines of
// pipeline/process.mjs, wrapped in reads at the top and writes at the bottom,
// which meant the only way to get a city was to run Node and write a
// directory. Pulled out as a pure function it runs identically in the browser,
// which is what lets every new run generate its own city instead of shipping
// two of them. `pipeline/process.mjs` is now a thin wrapper that reads files,
// calls this, and writes files.
//
// Pure: same inputs, same outputs, no I/O, no clock, no globals.
import {
  makeProjection, polygonArea, centroid, bboxOfRing, sharedBoundaryLength, insetRingPerp,
  clipRingHalfPlane, longestEdgeAngle, extentAlong, isConvex,
} from "./geom.mjs";

/**
 * @param {{rawParcels:object, rawBuildings:object, rawStations:object,
 *          manifest:object, employment:object|null}} src
 */
/**
 * WHAT A QUARTER IS WORTH BEYOND WHAT IT MEASURES.
 *
 * A stable hash of the district name and the town's seed, mapped into a modest
 * band. Stable so a neighbourhood keeps its character for the life of the city
 * — a cachet that moved would be weather, not a place — and seeded so the good
 * address is somewhere different in the next town.
 *
 * The band is deliberately narrow. This is a thumb on a scale that already
 * works, not a replacement for it: at the extremes it is worth about a fifth
 * either way, which is the difference between a good address and an ordinary
 * one and nothing like the difference between downtown and the marshes.
 */
function districtCachet(name, seed) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  const u = ((h >>> 8) & 0xffff) / 0xffff;          // 0..1, stable
  // A business district is bought on its numbers and varies least; the places
  // people live and the old quarters carry most of the intangible.
  const n = s.toLowerCase();
  const span = /exchange|financial|core|downtown|business/.test(n) ? 0.09
    : /dock|industrial|works|yard|wharf/.test(n) ? 0.12
      : 0.20;
  return 1 + span * (u * 2 - 1);
}

export function buildCityData(src) {
  const { rawParcels, rawBuildings, rawStations, manifest, employment, parks } = src;
  const num = (v) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : null;
  };

  // Asset-class remap from PLUTO building class letter. There is no "mixed"
  // class: a building that is shops at grade with flats above gets a MIX, and
  // its `class` is whichever leg is largest. See src/engine/mix.ts for why.
  function assetClass(bldgclass, landuse, bldgarea) {
    const c = (bldgclass ?? "").toUpperCase();
    const L = c[0];
    // "Land" means NOTHING IS STANDING ON IT. Every other route to that answer
    // has to go through this test first, because a record that says vacant with
    // a floor count on it is a lie the whole engine then prices off.
    if (!bldgarea) return "land";
    if (L === "V" || landuse === "11") return "land";
    // A GARAGE IS A BUILDING. These letters — garages, transport, utility and
    // misc structures — used to come back "land" while KEEPING their floor count
    // and their building area, which produced 32 lots in New Alden alone that
    // said "vacant land" on the record with a four-storey structure drawn on
    // them. Worse, everything that prices dirt read them as dirt: an off-market
    // approach on a 2011 garage quoted land value against a built appraisal and
    // looked like a 95% discount.
    //
    // They are still the cheapest thing standing and the easiest to knock down —
    // that is what `industrial` means in this model. Teardown economics come out
    // of a low rent and an old frame, not out of pretending the frame is absent.
    if (L === "G" || L === "T" || L === "Z" || L === "Q") return "industrial";
    if (L === "E") return "industrial"; // lofts, sheds, warehouses
    if (L === "O" || L === "H" || L === "I" || L === "J" || L === "Y" || L === "W" || L === "P") return "office";
    if (L === "K" || L === "L") return "retail";
    if (L === "S" || c === "RM" || L === "M") return "stacked";
    if (L === "A" || L === "B" || L === "C" || L === "D" || L === "N" || L === "R") return "multifamily";
    return "stacked";
  }

  /**
   * A stacked building, resolved into what it is actually made of: retail on the
   * ground floor and the rest above, leaning residential where PLUTO says there
   * are units. Returns { class, mix } — the mix is the truth and the class is
   * just the biggest leg, kept so everything that files buildings by type still
   * has an answer.
   */
  function resolveMix(kind, floors, unitsRes, bbl) {
    if (kind !== "stacked") return { klass: kind, mix: kind === "land" ? undefined : { [kind]: 1 } };
    let h = 2166136261;
    for (let i = 0; i < bbl.length; i++) { h ^= bbl.charCodeAt(i); h = Math.imul(h, 16777619); }
    const j = ((h >>> 0) % 10000) / 10000;
    const fl = Math.max(1, floors || 1);
    const retail = Math.max(0.06, Math.min(0.42, (1 / fl) * (1.05 + 0.3 * j)));
    const rest = 1 - retail;
    const resLean = unitsRes > 0 ? 0.58 + 0.3 * j : 0.18 + 0.34 * j;
    const raw = { retail, multifamily: rest * resLean, office: rest * (1 - resLean) };
    const mix = {};
    let tot = 0;
    for (const k of Object.keys(raw)) if (raw[k] > 0.04) { mix[k] = raw[k]; tot += raw[k]; }
    for (const k of Object.keys(mix)) mix[k] = +(mix[k] / tot).toFixed(4);
    const klass = Object.keys(mix).sort((a, b) => mix[b] - mix[a])[0];
    return { klass, mix };
  }

  // --- pass 1: extract, project, measure -------------------------------------
  // centroid of all features -> local meter frame
  let cx = 0, cy = 0, cn = 0;
  for (const f of rawParcels.features) {
    if (!f.geometry) continue;
    const ring = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0];
    for (const [x, y] of ring) { cx += x; cy += y; cn++; }
  }
  const proj = makeProjection(cx / cn, cy / cn);

  const lots = [];
  for (const f of rawParcels.features) {
    if (!f.geometry) continue;
    const p = f.properties;
    const bbl = String(p.bbl ?? p.BBL ?? "").replace(/\.0+$/, "");
    if (!bbl) continue;
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    // largest outer ring carries the lot for adjacency/centroid purposes
    let best = null, bestA = 0;
    for (const poly of polys) {
      const xy = poly[0].map(proj.toXY);
      const a = Math.abs(polygonArea([xy]));
      if (a > bestA) { bestA = a; best = xy; }
    }
    if (!best || bestA < 5) continue;
    lots.push({ bbl, p, ring: best, ringLL: f.geometry, areaM2: bestA, c: centroid(best) });
  }

  // medians by building class for imputation
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  const byClass = new Map();
  for (const l of lots) {
    const k = (l.p.bldgclass ?? "??")[0];
    if (!byClass.has(k)) byClass.set(k, { years: [], floors: [], psf: [] });
    const g = byClass.get(k);
    const yb = num(l.p.yearbuilt); if (yb && yb > 1800) g.years.push(yb);
    const nf = num(l.p.numfloors); if (nf && nf > 0) g.floors.push(nf);
    const at = num(l.p.assesstot), la = num(l.p.lotarea);
    if (at && la) g.psf.push(at / la);
  }

  // --- demand kernels ---------------------------------------------------------
  // keep stations within 1.5 km of the study area so a citywide dataset works
  let lotsMinX = Infinity, lotsMinY = Infinity, lotsMaxX = -Infinity, lotsMaxY = -Infinity;
  for (const l of lots) {
    if (l.c[0] < lotsMinX) lotsMinX = l.c[0]; if (l.c[0] > lotsMaxX) lotsMaxX = l.c[0];
    if (l.c[1] < lotsMinY) lotsMinY = l.c[1]; if (l.c[1] > lotsMaxY) lotsMaxY = l.c[1];
  }
  const stationPts = rawStations.features
    .filter((f) => f.geometry?.type === "Point")
    .map((f) => ({
      xy: proj.toXY(f.geometry.coordinates),
      w: num(f.properties.weight) ?? 30,
      name: f.properties.stop_name ?? f.properties.name ?? "station",
      lines: f.properties.daytime_routes ?? f.properties.line ?? "",
      ll: f.geometry.coordinates,
    }))
    .filter((s) =>
      s.xy[0] > lotsMinX - 1500 && s.xy[0] < lotsMaxX + 1500 &&
      s.xy[1] > lotsMinY - 1500 && s.xy[1] < lotsMaxY + 1500);

  let jobPts;
  if (employment?.features?.length) {
    jobPts = employment.features.map((f) => ({ xy: proj.toXY(f.geometry.coordinates), jobs: num(f.properties.jobs) ?? 0 }));
  } else {
    // fallback proxy: jobs from commercial built area
    jobPts = lots
      .filter((l) => ["O", "K", "S", "R", "M"].includes((l.p.bldgclass ?? "")[0]))
      .map((l) => ({ xy: l.c, jobs: (num(l.p.bldgarea) ?? 0) / 300 }));
    console.warn("No LODES employment file — using built-area employment proxy for demandScore.");
  }

  // gaussian kernels with a 3σ cutoff via a bucket index — island-scale safe
  const gauss = (d, r) => Math.exp(-(d * d) / (2 * r * r));
  function bucketIndex(pts, cell) {
    const m = new Map();
    for (const p of pts) {
      const k = Math.floor(p.xy[0] / cell) + ":" + Math.floor(p.xy[1] / cell);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return (c, radius, fn) => {
      const r = Math.ceil(radius / cell);
      const gx = Math.floor(c[0] / cell), gy = Math.floor(c[1] / cell);
      let acc = 0;
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (const p of m.get((gx + dx) + ":" + (gy + dy)) ?? []) {
            const d = Math.hypot(c[0] - p.xy[0], c[1] - p.xy[1]);
            if (d <= radius) acc += fn(p, d);
          }
      return acc;
    };
  }
  const nearStations = bucketIndex(stationPts, 350);
  const nearJobs = bucketIndex(jobPts, 300);
  // A THIRD REASON FOR GROUND TO BE GOOD, AND THE FIRST ONE THAT IS NOT JOBS.
  //
  // Demand was 45% transit gravity and 55% employment gravity, and the two were
  // the same field wearing two hats: employment is proxied by built floor area,
  // which is tallest downtown, and a station's ridership was `22 + 54 * heat`,
  // where heat is proximity to downtown. Measured across six generated islands,
  // the result had exactly ONE local peak and ONE top-decile cluster on every
  // one, correlating 0.61 to 0.94 with distance from a single best point. That
  // is the owner's "all the demand surrounding one specific place", measured.
  //
  // Green frontage is the oldest independent driver of urban land value there
  // is, and it is independent in the way that matters here: it is somewhere
  // else. The Fifth Avenue addresses face the park, not the exchange; Bloomsbury
  // and Bath are worth what they are worth because of squares. It is also
  // strongest for HOUSING rather than offices, which is exactly why it makes a
  // different KIND of good neighbourhood rather than a second downtown.
  //
  // Big parks reach further than small ones — the pull scales with the square
  // root of the area, which is the park's own radius — so this composes with the
  // park programme rather than flattening it: a city of twelve squares gets
  // twelve modest bumps spread through its districts, and a city with one great
  // park gets one prestige quarter beside it.
  const parkPts = (parks ?? []).map((pk) => ({
    xy: pk.xy,
    // the reach of a green, in metres: its own half-diagonal, floored so a
    // pocket square still registers and capped so a great park is not the
    // whole island.
    r: Math.max(90, Math.min(520, Math.sqrt(Math.max(1, pk.w * pk.h)) * 0.8)),
  }));
  const nearParks = bucketIndex(parkPts, 300);
  // THE WATER AND THE HIGH STREET, measured perpendicular rather than radially.
  //
  // Every term above is an isotropic kernel around a point, and two of the
  // strongest facts about urban land are not that shape: a shoreline premium
  // falls off perpendicular to the coast and a corridor premium perpendicular
  // to the road. No sum of point gravities makes either, which is why a port
  // town's harbour was worth nothing and its main road was worth nothing but a
  // wider carriageway.
  //
  // Decay lengths read off what people pay for: three hundred metres to the
  // water is four or five blocks, which is about where the hedonic literature
  // puts the half-life of a view; retail rent falls away from a high street
  // within a block or two, so ninety. Shape parameters, calibrated, not tuned.
  //
  // A WORKING DOCK IS NOT A WATERFRONT — `shoreamen` is 0 on the industrial
  // shore, because nobody pays to overlook a container yard. Same water,
  // opposite sign.
  const raws = lots.map((l) => ({
    transit: nearStations(l.c, 1050, (s, d) => s.w * gauss(d, 350)),
    emp: nearJobs(l.c, 900, (j, d) => j.jobs * gauss(d, 300)),
    // Frontage, not proximity: the premium is on the blocks that FACE it and
    // falls away fast behind them.
    amen: nearParks(l.c, 900, (pk, d) => pk.r * gauss(d, pk.r * 0.75)),
    shore: (l.p?.shoreamen ?? 1) ? Math.exp(-(num(l.p?.shorem) ?? 9999) / 300) : 0,
    corridor: Math.exp(-(num(l.p?.corridorm) ?? 9999) / 90),
  }));
  const p95 = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)] || 1; };
  const t95 = p95(raws.map((r) => r.transit));
  const e95 = p95(raws.map((r) => r.emp));
  const a95 = p95(raws.map((r) => r.amen)) || 1;
  // NORMALISED THE SAME WAY THE OTHER THREE ARE, and that is not a detail.
  // Un-normalised, an exponential decay sits far higher for the median lot
  // than a gravity term divided by its own 95th percentile does — so adding
  // the two of them at weight 22 raised the median lot's land value 11.8%
  // across the whole city. That is a level shift, and a level shift in land
  // is an economy change wearing a geometry label: it moves rents, cost basis
  // and the tax bill on every parcel. Against their own p95 they redistribute
  // instead, which is the only thing they were ever meant to do.
  const s95 = p95(raws.map((r) => r.shore)) || 1;
  const c95 = p95(raws.map((r) => r.corridor)) || 1;
  // The town's mean premium, so the three multipliers below redistribute
  // instead of inflating — see the note where they are applied.
  const premMean = (() => {
    let t = 0;
    for (let i = 0; i < lots.length; i++) {
      const r = raws[i];
      t += ((num(lots[i].p?.corner) ?? 0) === 1 ? 1.18 : 1)
        * (1 + 0.15 * Math.min(1, r.shore / s95))
        * (1 + 0.25 * Math.min(1, r.corridor / c95));
    }
    return lots.length ? t / lots.length : 1;
  })();

  // --- adjacency: bbox grid index + shared boundary length --------------------
  const CELL = 60; // meters
  const grid = new Map();
  lots.forEach((l, i) => {
    const [minX, minY, maxX, maxY] = bboxOfRing(l.ring);
    l.bbox = [minX, minY, maxX, maxY];
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++)
      for (let gy = Math.floor(minY / CELL); gy <= Math.floor(maxY / CELL); gy++) {
        const k = gx + ":" + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  const TOL = 1.5;   // meters — the "buffer" of buffer-and-intersect
  const MIN_SHARED = 3; // meters of shared lot line to count as adjacent
  const adjacency = {};
  let edgeCount = 0;
  lots.forEach((l, i) => {
    const cand = new Set();
    const [minX, minY, maxX, maxY] = l.bbox;
    for (let gx = Math.floor(minX / CELL); gx <= Math.floor(maxX / CELL); gx++)
      for (let gy = Math.floor(minY / CELL); gy <= Math.floor(maxY / CELL); gy++)
        for (const j of grid.get(gx + ":" + gy) ?? []) if (j > i) cand.add(j);
    for (const j of cand) {
      const m = lots[j];
      if (m.bbox[0] > maxX + TOL || m.bbox[2] < minX - TOL || m.bbox[1] > maxY + TOL || m.bbox[3] < minY - TOL) continue;
      const shared = sharedBoundaryLength(l.ring, m.ring, TOL);
      if (shared >= MIN_SHARED) {
        (adjacency[l.bbl] ??= []).push(m.bbl);
        (adjacency[m.bbl] ??= []).push(l.bbl);
        edgeCount++;
      }
    }
  });

  // --- assemble records --------------------------------------------------------
  const table = {};
  const tileParcels = { type: "FeatureCollection", features: [] };
  for (let i = 0; i < lots.length; i++) {
    const l = lots[i], p = l.p;
    const imputed = [];
    const cls = (p.bldgclass ?? "").toUpperCase() || "??";
    const g = byClass.get(cls[0]) ?? { years: [], floors: [], psf: [] };

    let lotArea = num(p.lotarea);
    const geomSf = Math.round(l.areaM2 * 10.7639);
    if (!lotArea || lotArea < 100 || Math.abs(lotArea - geomSf) / geomSf > 3) {
      lotArea = geomSf; imputed.push("lotArea");
    }
    let floors = num(p.numfloors);
    let bldgArea = num(p.bldgarea);
    const vacant = assetClass(cls, p.landuse, bldgArea) === "land";
    if (!vacant) {
      if (!floors) { floors = median(g.floors) ?? 4; imputed.push("floors"); }
      if (!bldgArea) { bldgArea = Math.round(lotArea * 0.7 * floors); imputed.push("bldgArea"); }
    } else { floors = floors ?? 0; bldgArea = bldgArea ?? 0; }
    let yearBuilt = num(p.yearbuilt);
    if (!vacant && (!yearBuilt || yearBuilt < 1800)) { yearBuilt = median(g.years) ?? 1930; imputed.push("yearBuilt"); }
    let assessLand = num(p.assessland);
    let assessTot = num(p.assesstot);
    if (!assessLand || assessLand <= 0) {
      assessLand = Math.round(lotArea * (median(g.psf) ?? 120) * 0.35); imputed.push("assessedLand");
    }
    if (!assessTot || assessTot < assessLand) {
      assessTot = assessLand + Math.round(bldgArea * (median(g.psf) ?? 120) * 0.4); imputed.push("assessedTotal");
    }

    const dem = raws[i];
    // GOOD GROUND IS SCARCE.
    //
    // The raw blend of transit gravity and employment gravity is two ratios that
    // each saturate at the 95th percentile, and a linear mix of two saturating
    // terms piles mass at the top: the median lot in New Alden scored 63, more
    // than a third of the city scored over 70, and better than a fifth scored
    // over 80. That is not a city, it is a plateau with a harbour on it — and it
    // is why every block felt like a good block.
    //
    // The gamma bends it back into the shape land actually takes. Value falls
    // away from a core steeply, not linearly: at 1.9 the median lot is a 42, the
    // top decile starts at 85, and about one lot in eight is genuinely prime.
    // The ORDER is untouched — the same ground is still the best ground — so
    // every district reads the same, it just stops flattering the fringe.
    const DEMAND_GAMMA = 1.9;
    // 38 / 44 / 18 — the two original terms keep their ratio to each other, so
    // the ground that was best is still best, and the amenity term is given the
    // weight that changes the SHAPE without rewriting the order.
    const blend = Math.min(1,
      (38 * Math.min(1, dem.transit / t95)
        + 44 * Math.min(1, dem.emp / e95)
        + 18 * Math.min(1, dem.amen / a95)) / 100);
    // AND SOME QUARTERS ARE SIMPLY BETTER ADDRESSES THAN THEIR NUMBERS SAY.
    //
    // Gravity fields cannot produce this and it is most of what a city actually
    // feels like. Two districts equidistant from the same jobs and the same
    // stations are not worth the same: one has the good school, the terraces
    // and the name people say when they are showing off, and the other has none
    // of that and a gasworks nobody has pulled down. Nothing measurable
    // separates Islington from Holloway, and everybody knows which is which.
    //
    // So a district carries a CACHET, drawn once per town from its own name so
    // it is stable for the life of the city and different between cities. It is
    // applied to the blend BEFORE the gamma, so it moves a whole quarter up or
    // down together rather than scattering — which is the difference between a
    // neighbourhood and noise, and the thing the owner asked to be thoughtful
    // about. Business districts vary least, because an office block is bought
    // on its numbers; residential and old quarters vary most, because a home is
    // not.
    const cachet = districtCachet(p.district ?? p.cd ?? "—", manifest.seed ?? 1);
    // THE WATER, THE HIGH STREET AND THE CORNER MULTIPLY. THEY DO NOT BLEND.
    //
    // The first cut of this put all three into the blend above at 22 of its
    // 100 points, scaling the accessibility terms down to make room. Measured
    // on the fixture, that FLATTENED THE CITY: the land distribution's p90/p10
    // spread fell from 110x to 75x, because the peak is made by the
    // accessibility terms and 22 points had been taken out of them — while the
    // ground that gained was every lot within ninety metres of an arterial and
    // three hundred of the water, which on an island is most of it. Undoing a
    // heavy tail is the opposite of what the gamma below exists to do.
    //
    // The structure was wrong, not the weights. A waterfront corner on the
    // high street is a premium ON TOP OF its location, not a substitute for
    // it: the same lot in the middle of nowhere is still in the middle of
    // nowhere. So they multiply, which preserves the gradient they sit on and
    // is what a hedonic model does with them anyway.
    //
    // Ceilings are the measured end of the real ranges: waterfront 15%,
    // high-street frontage 25%, corner 18% — the conservative end of the
    // 15-40% corner premium. Each ramps on its own p95 so it is a premium for
    // being NEAR the thing rather than a flat bonus for being on its side of
    // town.
    const cornerK = (num(p.corner) ?? 0) === 1 ? 1.18 : 1;
    const shoreK = 1 + 0.15 * Math.min(1, dem.shore / s95);
    const corridorK = 1 + 0.25 * Math.min(1, dem.corridor / c95);
    // Record the hedonic premium for desk/renderer. Not applied to demandScore
    // or landPsf — both feed the sim and a spatial premium decouples development
    // from the order book (see test/orderbook.mjs).
    const locPremium = (cornerK * shoreK * corridorK) / premMean;
    const rawDemand = Math.min(1, blend * cachet);
    const demandScore = Math.max(4, Math.min(100, Math.round(100 * Math.pow(rawDemand, DEMAND_GAMMA))));
    const assessedPsf = assessLand / lotArea;
    const landPsf = Math.max(30, Math.round((assessedPsf / 0.45) * (0.6 + 0.9 * (demandScore / 100))));

    const farMaxComm = num(p.commfar) ?? 0;
    const farMaxRes = num(p.resfar) ?? 0;
    const kind = assetClass(cls, p.landuse, bldgArea);
    let { klass, mix } = resolveMix(kind, floors, num(p.unitsres) ?? 0, l.bbl);
    // THE INVARIANT, ENFORCED AT THE DOOR. Whatever the source letters say, a
    // lot with floor area on it is not vacant and a lot without any is. Every
    // downstream reader — the appraisal, the off-market ask, the 3D layer, the
    // development desk — assumes these two agree, and for a couple of per cent
    // of every city they did not.
    if (klass === "land" && bldgArea > 0) { klass = "industrial"; mix = undefined; }
    if (klass !== "land" && bldgArea <= 0) { klass = "land"; mix = undefined; floors = 0; yearBuilt = 0; }

    table[l.bbl] = {
      bbl: l.bbl,
      address: p.address ?? "(no address)",
      borough: p.borough ?? "MN",
      block: p.block ?? l.bbl.slice(1, 6),
      lot: p.lot ?? l.bbl.slice(6),
      zoneDist: p.zonedist1 ?? "—",
      // the neighbourhood this lot sits in — the submarket view is built on it
      district: p.district ?? p.cd ?? "—",
      farMaxComm, farMaxRes,
      bldgClass: cls,
      class: klass,
      ...(mix && Object.keys(mix).length > 1 ? { mix } : {}),
      lotArea, bldgArea, floors, yearBuilt,
      unitsRes: num(p.unitsres) ?? 0,
      assessedLand: assessLand,
      assessedTotal: assessTot,
      demandScore,
      // The three geometric facts citygen measures at the moment the lot is
      // cut. `locPremium` is the hedonic multiplier (mean 1); not yet applied
      // to landPsf — see the note above.
      shoreM: num(p.shorem) ?? 9999,
      corridorM: num(p.corridorm) ?? 9999,
      corner: (num(p.corner) ?? 0) === 1,
      locPremium: +locPremium.toFixed(4),
      landPsf,
      landPsfHistory: [landPsf],
      imputed,
      centroid: proj.toLL(l.c).map((v) => +v.toFixed(6)),
    };

    tileParcels.features.push({
      type: "Feature",
      id: Number(l.bbl),
      geometry: l.ringLL,
      properties: {
        bbl: l.bbl, address: table[l.bbl].address, class: klass,
        demand: demandScore, landpsf: landPsf, zone: table[l.bbl].zoneDist,
      },
    });
  }

  // buildings for the tiler: join heights (feet -> meters) by base BBL.
  //
  // ------------------------------------------------------------------ MASSING
  //
  // TWO SHAPES WERE 61% OF EVERY TOWER IN THIS CITY.
  //
  // A pre-1961 tower got a wedding cake with its setbacks nailed to 52% and
  // 82% of its height and its insets nailed to 66% and 38% of its area: the
  // same three-step ziggurat at every scale, on every lot, in every city,
  // forever. A modern tower got a podium of exactly 8.0 m under an unaltered
  // footprint. Above 45 m nothing else existed. From the water the skyline
  // read as one building photocopied at eleven sizes, which is most of why a
  // generated city looks generated.
  //
  // Real silhouettes come from the rule that was in force when the money was
  // spent, and from how much lot there was to spend it on. The 1916 zoning
  // resolution pushed a building back from the street on a sky-exposure plane
  // as it rose — but exempted a tower standing on a QUARTER of the lot, which
  // let it go up as far as it liked. That exemption is the reason a prewar
  // downtown is ziggurats WITH SPIKES IN THEM rather than ziggurats. The 1961
  // rewrite priced height in floor-area ratio and paid a bonus for handing the
  // pavement a plaza, which is why a postwar downtown is slabs and shafts
  // standing off the street behind an apron of granite.
  //
  // Seven families now, with their proportions read off the lot: wedding cake
  // (2-4 setbacks), tower-on-a-base, single high setback, terraced prewar
  // mid-rise, podium-and-shaft, mechanical setback, taper. Plus the slab,
  // because a box is a real answer and a city with no boxes in it is as
  // obviously fake as a city with nothing but.
  const tileBuildings = { type: "FeatureCollection", features: [] };
  let missingH = 0, stacked = 0, tiersTotal = 0;
  // Which silhouette each building ended up as, so the histogram is a thing
  // you can look at rather than a thing you have to trust.
  const shapes = {};
  const shape = (k) => { shapes[k] = (shapes[k] ?? 0) + 1; };
  const lotRingByBBL = new Map(lots.map((l) => [l.bbl, l.ring]));

  const citySeed = (manifest?.seed ?? 1) >>> 0;
  /**
   * A 32-bit key from a BBL, in EXACT integer arithmetic. `Number(bbl) * P` is
   * 2.7e18 for a ten-digit BBL — three hundred times past the 2^53 where
   * doubles stop counting by ones, so the bottom nine bits of the product are
   * always zero and anything mixed in below that granularity is discarded
   * before the hash sees it. FNV over the digits is ten iterations and correct.
   */
  const keyCache = new Map();
  const keyOf = (bbl) => {
    let k = keyCache.get(bbl);
    if (k !== undefined) return k;
    const t = String(bbl);
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    k = h >>> 0; keyCache.set(bbl, k); return k;
  };
  /** A stable [0,1) per building per question, and different in a new town. */
  const bh = (bbl, salt) => {
    let x = (Math.imul(keyOf(bbl) ^ Math.imul(salt, 0x9e3779b1), 2654435761) ^
             Math.imul(citySeed, 2246822519)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 2246822507) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };

  /**
   * Shrink a ring toward a target fraction of its area, backing off toward the
   * original if the geometry will not take it. A long thin loft footprint
   * cannot lose seventy per cent of its area without the short dimension going
   * through itself; rather than drop the setback entirely, take the deepest one
   * that survives. Returns null only if even a gentle inset collapses.
   */
  function shrink(ringXY, side, frac) {
    for (let f = Math.max(0.16, frac); f < 0.97; f += (1 - f) * 0.45) {
      const r = insetRingPerp(ringXY, (side * (1 - Math.sqrt(f))) / 2);
      if (r && r.length >= 3) return r;
    }
    return null;
  }
  const toGeom = (ringXY) => {
    const ll = ringXY.map(proj.toLL);
    return { type: "Polygon", coordinates: [[...ll, ll[0]]] };
  };

  // -------------------------------------------------------------- PLAN SHAPES
  //
  // EVERY SILHOUETTE SO FAR WAS THE FOOTPRINT, SHRUNK.
  //
  // All ten families below take one ring and step it inward as it rises, so
  // however many of them there are, every building in the city is a stack of
  // concentric plates. That is a real move — it is what the sky-exposure plane
  // produces — but it is not the only thing a plan does, and a city where it
  // is the only thing has no courtyards in it, no light wells, no wings, and
  // no tower standing on the corner of a low block.
  //
  // Those shapes are not setbacks, they are the PLAN, and they exist for a
  // reason that has nothing to do with zoning: rooms need daylight. Before air
  // conditioning and the fluorescent tube, no habitable room could sit much
  // more than eight metres from a window, so any plate deeper than about
  // sixteen metres had to be cut open. The courtyard block, the light court
  // and the dumbbell tenement are that one constraint answered at three
  // different lot sizes, and together they are most of what a prewar
  // residential district looks like from the air.
  //
  // A volume is a single ring, so a plan with a hole in it is expressed the
  // way the building is actually built: as separate WINGS standing side by
  // side at the same height. The frame below measures the plate along its own
  // dominant axis, and every wing is an exact half-plane clip of the
  // footprint, so the pieces partition the plate instead of overlapping it.

  /** The plate measured on its own long axis: extents u (along) and v (across). */
  const plateFrame = (r) => {
    const th = longestEdgeAngle(r);
    const eu = extentAlong(r, th), ev = extentAlong(r, th + Math.PI / 2);
    return {
      ux: Math.cos(th), uy: Math.sin(th),
      vx: -Math.sin(th), vy: Math.cos(th),
      u0: eu.lo, u1: eu.hi, du: eu.span,
      v0: ev.lo, v1: ev.hi, dv: ev.span,
    };
  };
  /** Keep the part of r whose coordinate on axis (ax,ay) is at most c. */
  const clipLo = (r, ax, ay, c) => (r ? clipRingHalfPlane(r, ax, ay, c) : null);
  /** Keep the part of r whose coordinate on axis (ax,ay) is at least c. */
  const clipHi = (r, ax, ay, c) => (r ? clipRingHalfPlane(r, -ax, -ay, -c) : null);
  /** The slice of r between two coordinates on one axis. */
  const clipBand = (r, ax, ay, a, b) => clipLo(clipHi(r, ax, ay, a), ax, ay, b);
  /** Slide a ring sideways — for stacks whose plates do not sit over each other. */
  const slide = (r, dx, dy) => (r ? r.map(([x, y]) => [x + dx, y + dy]) : null);

  /**
   * Cut every corner off at `cut` metres — the move that separates a tower
   * built this decade from one built in 1985. The renderer's tower kit has the
   * same operation for the buildings the PLAYER puts up; this is the one for
   * the stock a city is generated with, so a scenario that starts with a
   * modern downtown looks like one.
   */
  const chamferRing = (r, cut) => {
    if (!r || r.length < 3 || cut <= 0.01) return r;
    const n = r.length, out = [];
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

  /** Turn a ring about a point — the twist, and the spiral's step. */
  const spin = (r, cx, cy, a) => {
    if (!r) return null;
    const c = Math.cos(a), s = Math.sin(a);
    return r.map(([x, y]) => {
      const dx = x - cx, dy = y - cy;
      return [cx + dx * c - dy * s, cy + dx * s + dy * c];
    });
  };

  /**
   * The stack of volumes a building actually stands as, base first.
   * null means "a plain extrusion is the right answer" — which for most of the
   * city it is, because most of a city is five storeys of brick.
   */
  function massing(geom, hM, year, klass, bbl, lotRingM) {
    if (geom.type !== "Polygon" || geom.coordinates.length !== 1) return null;
    const ringXY = geom.coordinates[0].slice(0, -1).map(proj.toXY);
    if (ringXY.length < 3) return null;
    const areaM2 = Math.abs(polygonArea([ringXY]));
    if (areaM2 < 180) return null;
    const side = Math.sqrt(areaM2);
    const W = side;                 // the plate's width, near enough, in metres
    const u = (k) => bh(bbl, k);
    const out = [];
    const push = (r, base, top) => {
      if (!r || top - base < 0.6) return false;
      out.push({ geom: Array.isArray(r) ? toGeom(r) : r, base: +base.toFixed(1), top: +top.toFixed(1) });
      return true;
    };
    /** File the silhouette and hand it back, or fall through to a slab. */
    const done = (name) => { if (out.length < 2) return null; shape(name); return out; };

    // ---- the plan families, which any era can reach --------------------------
    //
    // These are keyed to the DEPTH of the plate rather than to a date, because
    // that is the thing that actually forces them: a plate you cannot get
    // daylight into has to be opened up, whoever is building it and whenever.
    // Salts 60+ — everything below 60 is spoken for by the families above.

    /** Wings round a closed light well. The prewar big-lot answer. */
    const courtyard = (depth) => {
      const F = plateFrame(ringXY);
      if (F.du < depth * 2.9 || F.dv < depth * 2.9) return null;
      const uA = F.u0 + depth, uB = F.u1 - depth;
      const mid = clipBand(ringXY, F.ux, F.uy, uA, uB);
      const wings = [
        clipLo(ringXY, F.ux, F.uy, uA),
        clipHi(ringXY, F.ux, F.uy, uB),
        clipLo(mid, F.vx, F.vy, F.v0 + depth),
        clipHi(mid, F.vx, F.vy, F.v1 - depth),
      ].filter((r) => r && r.length >= 3 && Math.abs(polygonArea([r])) > 40);
      return wings.length === 4 ? wings : null;
    };

    /** The same, open on one side — a light court facing the rear yard. */
    const lightCourt = (depth) => {
      const F = plateFrame(ringXY);
      if (F.du < depth * 2.9 || F.dv < depth * 2.2) return null;
      const uA = F.u0 + depth, uB = F.u1 - depth;
      const mid = clipBand(ringXY, F.ux, F.uy, uA, uB);
      const wings = [
        clipLo(ringXY, F.ux, F.uy, uA),
        clipHi(ringXY, F.ux, F.uy, uB),
        clipLo(mid, F.vx, F.vy, F.v0 + depth),
      ].filter((r) => r && r.length >= 3 && Math.abs(polygonArea([r])) > 40);
      return wings.length === 3 ? wings : null;
    };

    /** The dumbbell: full-depth ends, and a waist notched on both long sides. */
    const dumbbell = (endW, notch) => {
      const F = plateFrame(ringXY);
      if (F.du < endW * 2.6 || F.dv < notch * 2.8) return null;
      const mid = clipBand(ringXY, F.ux, F.uy, F.u0 + endW, F.u1 - endW);
      const waist = clipBand(mid, F.vx, F.vy, F.v0 + notch, F.v1 - notch);
      const wings = [
        clipLo(ringXY, F.ux, F.uy, F.u0 + endW),
        clipHi(ringXY, F.ux, F.uy, F.u1 - endW),
        waist,
      ].filter((r) => r && r.length >= 3 && Math.abs(polygonArea([r])) > 30);
      return wings.length === 3 ? wings : null;
    };

    /** A square of plate at one corner — what a tower actually stands on. */
    const cornerCell = (cell, k) => {
      const F = plateFrame(ringXY);
      const uSide = k & 1 ? clipHi(ringXY, F.ux, F.uy, F.u1 - cell) : clipLo(ringXY, F.ux, F.uy, F.u0 + cell);
      const c = k & 2 ? clipHi(uSide, F.vx, F.vy, F.v1 - cell) : clipLo(uSide, F.vx, F.vy, F.v0 + cell);
      return c && c.length >= 3 && Math.abs(polygonArea([c])) > 25 ? c : null;
    };

    /** The plan families. Any era can reach these — the lot decides, not the date. */
    const PLAN = new Set([
      "courtyard", "lightcourt", "dumbbell", "campanile", "endtowers",
      "twins", "cruciform", "shifted", "notch",
      "chamfertaper", "twist",
    ]);
    function tryPlan(fam) {
      // The wing clip is Sutherland–Hodgman, which is an exact partition on a
      // convex ring and BRIDGES ACROSS THE CUT on a concave one — two wings
      // that both cover the same ground, drawn one inside the other. Measured,
      // every footprint this generator makes is convex in metres (1,113 of
      // 1,113 on New Alden; the same test in degrees reads 95% concave, which
      // is the epsilon being meaningless at 1e-4 rather than a real result).
      // The guard is here so that stays true rather than being assumed.
      if (!isConvex(ringXY)) return null;
      switch (fam) {
        case "courtyard": {
          // A block built solid round a closed well. Eight storeys of flats
          // with every room on either the street or the court.
          const wings = courtyard(9.5 + 4.0 * u(60));
          if (!wings) return null;
          for (const w of wings) push(w, 0, hM);
          return done("courtyard block");
        }
        case "lightcourt": {
          // The same idea on a lot too narrow to close: a U with the court
          // open to the rear, which is where the light was going to come from.
          const wings = lightCourt(9.0 + 3.5 * u(61));
          if (!wings) return null;
          for (const w of wings) push(w, 0, hM);
          return done("light court");
        }
        case "dumbbell": {
          // THE DUMBBELL. Full-depth ends and a waist pinched in on both sides
          // to get an air shaft down the middle of the block — the 1879 answer
          // to a law that said every room needed a window, and the single most
          // characteristic plan of a nineteenth century tenement district.
          const wings = dumbbell(7 + 4 * u(62), 3.6 + 2.4 * u(63));
          if (!wings) return null;
          for (const w of wings) push(w, 0, hM);
          return done("dumbbell");
        }
        case "campanile": {
          // A tower on the corner of a low block: a bank clock, a market
          // campanile, the tower over a station entrance. One small square of
          // plate carried up well past everything around it, and from a
          // distance it is the only thing on the block you can see.
          const cell = cornerCell(Math.max(7, Math.min(17, side * 0.36)), Math.floor(u(64) * 4));
          if (!cell) return null;
          push(geom, 0, hM);
          push(cell, hM, hM + Math.max(6, hM * (0.32 + 0.40 * u(65))));
          return done("corner tower");
        }
        case "endtowers": {
          // A low bar with its ends carried higher — the courthouse-and-wings
          // move, and it gives a block a profile instead of a line.
          const F = plateFrame(ringXY);
          const endW = Math.max(6, Math.min(F.du * 0.30, 15));
          const A = clipLo(ringXY, F.ux, F.uy, F.u0 + endW);
          const B = clipHi(ringXY, F.ux, F.uy, F.u1 - endW);
          if (!A || !B) return null;
          const barTop = hM * (0.52 + 0.16 * u(66));
          push(geom, 0, barTop);
          push(A, barTop, hM);
          push(B, barTop, hM * (0.90 + 0.10 * u(67)));
          return done("end towers");
        }
        case "twins": {
          // TWO SHAFTS OFF ONE PODIUM, and never quite the same height —
          // matched twins are rarer than the phrase suggests, and the offset
          // is what makes the pair read as a pair rather than as a mistake.
          const podTop = 7 + 13 * u(68);
          const sh = shrink(ringXY, side, 0.60 + 0.18 * u(69));
          if (!sh) return null;
          const F = plateFrame(sh);
          if (F.du < 26) return null;
          const gap = 3 + 4.5 * u(70), mid = (F.u0 + F.u1) / 2;
          const A = clipLo(sh, F.ux, F.uy, mid - gap / 2);
          const B = clipHi(sh, F.ux, F.uy, mid + gap / 2);
          if (!A || !B || podTop >= hM * 0.6) return null;
          push(geom, 0, podTop);
          push(A, podTop, hM);
          push(B, podTop, hM * (0.78 + 0.20 * u(71)));
          return done("twin towers");
        }
        case "cruciform": {
          // A PLUS-SHAPED SHAFT. Four short wings off a core, so every office
          // is near a window and the tower has a different width from every
          // angle — which is why it never reads as a slab however big it is.
          const baseTop = hM * (0.12 + 0.14 * u(72));
          const sh = shrink(ringXY, side, 0.72) ?? ringXY;
          const F = plateFrame(sh);
          const wA = Math.max(7, F.dv * 0.44), wB = Math.max(7, F.du * 0.34);
          const cu = (F.u0 + F.u1) / 2, cv = (F.v0 + F.v1) / 2;
          const barA = clipBand(sh, F.vx, F.vy, cv - wA / 2, cv + wA / 2);
          const barB = clipBand(sh, F.ux, F.uy, cu - wB / 2, cu + wB / 2);
          if (!barA || !barB) return null;
          push(geom, 0, baseTop);
          push(barA, baseTop, hM);
          push(barB, baseTop, hM * (0.92 + 0.08 * u(73)));
          return done("cruciform");
        }
        case "shifted": {
          // PLATES THAT DO NOT SIT OVER EACH OTHER. The contemporary move: each
          // stage slides sideways off the one below, so the building has an
          // overhang and a terrace on opposite faces at every level.
          const F = plateFrame(ringXY);
          const n = 2 + (u(74) > 0.5 ? 1 : 0);
          let z = 0, r = ringXY;
          for (let k = 0; k <= n; k++) {
            const top = k === n ? hM : hM * ((k + 1) / (n + 1));
            if (!push(r, z, top)) break;
            z = top;
            const s2 = shrink(ringXY, side, 0.86 - k * 0.08) ?? r;
            const off = (bh(bbl, 75 + k) - 0.5) * Math.min(10, F.dv * 0.34);
            r = slide(s2, F.vx * off, F.vy * off);
          }
          return done("shifted stack");
        }
        case "notch": {
          // A SLOT CUT THROUGH THE MIDDLE OF A SLAB, open at the top, with the
          // low link left across the bottom of it. A slab with a hole in it is
          // a completely different object against the sky.
          const F = plateFrame(ringXY);
          const cu = (F.u0 + F.u1) / 2;
          const slot = Math.max(6, F.du * (0.16 + 0.10 * u(80)));
          const A = clipLo(ringXY, F.ux, F.uy, cu - slot / 2);
          const B = clipHi(ringXY, F.ux, F.uy, cu + slot / 2);
          if (!A || !B) return null;
          push(A, 0, hM);
          push(B, 0, hM * (0.94 + 0.06 * u(81)));
          const link = clipBand(ringXY, F.ux, F.uy, cu - slot / 2, cu + slot / 2);
          if (link) push(link, 0, hM * (0.26 + 0.24 * u(82)));
          return done("notched slab");
        }
        case "chamfertaper": {
          // ONE VANDERBILT, as generated stock. The corners come off four
          // times on the way up, each cut deeper than the last, so the tower
          // is an octagon by the top and never shows the same width twice.
          // The renderer's tower kit does this for what the PLAYER builds;
          // this is the one for the stock a city STARTS with, so a scenario
          // that opens on a modern downtown looks like one.
          const cuts = [0.06, 0.13, 0.22, 0.33], sc = [1.0, 0.90, 0.79, 0.66];
          const tops = [0.30, 0.56, 0.80, 1.0];
          let z = 0, ok = 0;
          for (let k = 0; k < 4; k++) {
            const plate = k === 0 ? ringXY : shrink(ringXY, side, sc[k] * sc[k]);
            if (!plate) break;
            if (push(chamferRing(plate, cuts[k] * side * (0.7 + 0.6 * u(84))), z, hM * tops[k])) ok++;
            z = hM * tops[k];
          }
          return ok >= 3 ? done("chamfer taper") : null;
        }
        case "twist": {
          // Every stage turns on the one below, so the corners run up the
          // building as slow helices and the silhouette changes as you walk
          // round it. Thin enough that the steps read as a curve.
          const cen = centroid(ringXY);
          const n = 8 + Math.floor(u(85) * 5);
          const total = (0.40 + 0.30 * u(86)) * (u(87) < 0.5 ? 1 : -1);
          let z = 0, ok = 0;
          for (let k = 0; k < n; k++) {
            const t = (k + 1) / n;
            const plate = shrink(ringXY, side, (1 - t * 0.16) ** 2);
            if (!plate) break;
            if (push(spin(plate, cen[0], cen[1], total * (k / n)), z, hM * t)) ok++;
            z = hM * t;
          }
          return ok >= 4 ? done("twist") : null;
        }
        default: return null;
      }
    }

    // ---- a plate too deep to daylight has to be opened up -------------------
    //
    // THE PLAN FAMILIES CANNOT LIVE BEHIND THE HEIGHT GATE.
    //
    // Both era branches below start by refusing anything under about twenty
    // metres, because a setback is a thing that happens to a TALL building —
    // and that is right for setbacks. It is exactly wrong for the plan, and
    // measured it cost almost all of the effect: across three cities only 99
    // buildings out of 4,394 volumes ever reached massing() at all, so a
    // courtyard block could only ever appear on a lot that was both enormous
    // and tall. The types this is trying to draw — the dumbbell tenement, the
    // courtyard apartment house, the light court — are five and six storey
    // buildings. They are the fabric, not the skyline.
    //
    // The real gate is not height, it is DEPTH. A room needs a window; a plate
    // whose short dimension runs past about twenty metres has a middle that
    // cannot reach one, and it gets cut open — at any height, on any lot.
    //
    // And it stops. Air conditioning and the fluorescent tube between them
    // made a deep plate habitable, so from the mid-fifties nobody bothers
    // any more. That is why a prewar district reads as blocks with holes in
    // them and a postwar one reads as solid slabs, and it now falls out of the
    // dates rather than being asserted.
    if (hM >= 7.5 && year < 1958) {
      const F0 = plateFrame(ringXY);
      const deep = Math.min(F0.du, F0.dv);
      if (deep > 19.5) {
        const plans = [];
        if (deep > 29 && F0.du > 33 && areaM2 >= 1000) plans.push("courtyard", "courtyard", "courtyard");
        if (deep > 21 && F0.du > 25) plans.push("lightcourt", "lightcourt");
        if (F0.du > 23) plans.push("dumbbell", "dumbbell");
        // Not every deep plate got opened. Some were built solid and were
        // miserable, and those are the ones that got converted a century later.
        for (let k = 0; k < 3; k++) plans.push("solid");
        const pf = plans[Math.min(plans.length - 1, Math.floor(u(59) * plans.length))];
        if (pf !== "solid") {
          const r = tryPlan(pf);
          if (r) return r;
          out.length = 0;              // a plan that would not fit leaves no trace
        }
      }
    }

    // ---- pre-1961: the sky-exposure plane, and the tower that dodged it ----
    if (year < 1961) {
      // WHAT A PLATE WILL TAKE.
      //
      // A setback gives away WIDTH, and a building that has none cannot give
      // any: four steps off a sixteen-metre plate leave a top floor eight
      // metres across, which is a chimney. So each family is offered only to
      // plates wide enough to survive it, and the choice is made among the
      // families that are actually available rather than by one roll that
      // ignores the site. Repeats in the list are weights.
      if (hM < 22 || areaM2 < 200) return null;         // a walk-up stands straight
      const fams = [];
      if (hM >= 30) {
        if (W >= 22) fams.push("cake", "cake", "cake");
        if (W >= 19) fams.push("base", "base");
        if (W >= 15) fams.push("step", "step");
        fams.push("loft");
      }
      if (hM >= 24) fams.push("terrace");
      // THE PLAN FAMILIES, offered on the lots that force them. A plate you
      // cannot get daylight into the middle of has to be opened up, and how it
      // opens depends on how much frontage there is to do it with: a big
      // through-block lot closes a courtyard, a narrower one leaves the court
      // open at the back, and a tenement lot pinches its waist.
      if (areaM2 >= 1500 && W >= 36) fams.push("courtyard", "courtyard");
      if (areaM2 >= 850 && W >= 27) fams.push("lightcourt", "lightcourt");
      if (areaM2 >= 620 && W >= 23) fams.push("dumbbell", "dumbbell");
      if (hM >= 32 && W >= 20) fams.push("campanile");
      if (hM >= 28 && W >= 26) fams.push("endtowers");
      // A box is a real answer, and a city with no boxes in it is as obviously
      // fake as a city with nothing else. Fewer of them once a building is
      // tall enough that somebody had to think about its top.
      for (let k = hM >= 30 ? 2 : 3; k > 0; k--) fams.push("slab");
      const fam = fams[Math.min(fams.length - 1, Math.floor(u(4) * fams.length))];
      if (PLAN.has(fam)) return tryPlan(fam);
      switch (fam) {
        case "cake": {
          // WEDDING CAKE — two to four setbacks above a street wall whose
          // height comes off the lot rather than off a constant.
          const n = 2 + Math.floor(u(7) * 3);
          const baseTop = hM * (0.24 + 0.24 * u(8));
          let z = baseTop, frac = 1, lastR = ringXY;
          push(geom, 0, baseTop);
          for (let k = 0; k < n; k++) {
            frac *= 0.62 + 0.16 * bh(bbl, 20 + k);
            const r = shrink(ringXY, side, frac);
            if (!r) break;
            const top = k === n - 1 ? hM : z + (hM - z) * (0.34 + 0.26 * bh(bbl, 30 + k));
            if (!push(r, z, top)) break;
            z = top; lastR = r;
          }
          if (z < hM - 0.6) push(lastR, z, hM);
          return done("wedding cake");
        }
        case "base": {
          // TOWER ON A BASE — the 1916 exemption let a tower on a quarter of
          // the lot rise without limit, and that is the reason a prewar
          // skyline has spikes in it rather than only ziggurats.
          const shaftFrac = 0.30 + 0.20 * u(10);
          const shaft = shrink(ringXY, side, shaftFrac);
          if (!shaft) return null;
          const baseTop = Math.min(hM * 0.44, 11 + 13 * u(9));
          const crownAt = hM * (0.90 + 0.05 * u(11));
          push(geom, 0, baseTop);
          push(shaft, baseTop, crownAt);
          const crown = shrink(shaft, side * Math.sqrt(shaftFrac), 0.54 + 0.20 * u(12));
          if (!push(crown, crownAt, hM)) push(shaft, crownAt, hM);
          return done("tower on a base");
        }
        case "step": {
          // One high setback — the cheapest way to satisfy the sky plane.
          const zc = hM * (0.58 + 0.24 * u(13));
          push(geom, 0, zc);
          push(shrink(ringXY, side, 0.50 + 0.26 * u(14)), zc, hM);
          return done("high setback");
        }
        case "loft": {
          // A tall thin loft goes straight up and stops, with at most a small
          // step under the cornice.
          const zc = hM * (0.86 + 0.08 * u(5));
          push(geom, 0, zc);
          push(shrink(ringXY, side, 0.62 + 0.16 * u(6)), zc, hM);
          return done("loft step");
        }
        case "terrace": {
          // A prewar apartment house often gives its top floor a terrace.
          const zc = hM * (0.74 + 0.12 * u(2));
          push(geom, 0, zc);
          push(shrink(ringXY, side, 0.58 + 0.22 * u(3)), zc, hM);
          return done("prewar terrace");
        }
        default: return null;
      }
    }

    // ---- 1961 and after: floor-area ratio, and a bonus for a plaza ---------
    if (hM < 20) return null;
    const post = [];
    if (lotRingM && klass !== "industrial") post.push("retail base");
    if (hM >= 32) {
      if (lotRingM && klass !== "industrial") post.push("podium", "podium");
      post.push("mech", "mech");
      if (W >= 18) post.push("taper", "taper");
    }
    // The post-war plan families. The daylight constraint eased — air
    // conditioning and the fluorescent tube between them made a deep plate
    // habitable — so the courtyard becomes rare and the shapes that survive
    // are the ones done for PROFILE rather than for light: the cruciform, the
    // pair off one podium, the plates that slide, the hat that oversails.
    if (hM >= 38 && W >= 22) post.push("cruciform", "cruciform");
    if (hM >= 42 && W >= 26) post.push("twins");
    if (hM >= 40) post.push("shifted", "shifted");
    if (hM >= 30 && W >= 30) post.push("notch");
    // THE TOWERS OF THE LAST DECADE, for the stock a city is generated with.
    // Gated on 1998 and on 62 m — about twenty storeys — because a chamfered
    // faceted taper is a move nobody was making before that, and putting one
    // on a 1974 building would be the same anachronism as an arch on a 1958
    // brick slab.
    if (hM >= 62 && year >= 1998) post.push("chamfertaper", "chamfertaper", "twist");
    if (hM >= 78 && year >= 2005) post.push("chamfertaper", "twist");
    if (areaM2 >= 1600 && W >= 38 && hM < 46) post.push("courtyard");
    if (hM >= 26 && W >= 26) post.push("endtowers");
    for (let k = hM >= 32 ? 2 : 4; k > 0; k--) post.push("slab");
    const pfam = post[Math.min(post.length - 1, Math.floor(u(19) * post.length))];
    if (PLAN.has(pfam)) return tryPlan(pfam);
    switch (pfam) {
      case "retail base": {
        // Shops at grade run out to the lot line under a set-back upper floor.
        const pod = insetRingPerp(lotRingM, 1.2 + 1.8 * u(20));
        if (!pod) return null;
        push(pod, 0, 4.5 + 4 * u(21));
        push(geom, 0, hM);
        return done("retail base");
      }
      case "podium": {
        // PODIUM AND SHAFT. One to four storeys of base, not 8.0 m of it.
        const pod = insetRingPerp(lotRingM, 1.0 + 1.8 * u(22));
        if (!pod) return null;
        push(pod, 0, 5 + 10 * u(23));
        push(geom, 0, hM);
        return done("podium and shaft");
      }
      case "mech": {
        // The plant floor steps in — the commonest thing a 1970s tower does
        // to its own profile.
        const zc = hM * (0.42 + 0.26 * u(24));
        push(geom, 0, zc);
        push(shrink(ringXY, side, 0.74 + 0.16 * u(25)), zc, hM);
        return done("mechanical setback");
      }
      case "taper": {
        // Two or three steps through the top third.
        const n = 2 + (u(26) > 0.55 ? 1 : 0);
        let z = hM * (0.58 + 0.14 * u(27)), frac = 1, lastR = ringXY;
        push(geom, 0, z);
        for (let k = 0; k < n; k++) {
          frac *= 0.76 + 0.12 * bh(bbl, 40 + k);
          const r = shrink(ringXY, side, frac);
          if (!r) break;
          const top = k === n - 1 ? hM : z + (hM - z) * (0.42 + 0.20 * bh(bbl, 50 + k));
          if (!push(r, z, top)) break;
          z = top; lastR = r;
        }
        if (z < hM - 0.6) push(lastR, z, hM);
        return done("taper");
      }
      default: return null;
    }
    return null;   // a slab is a real shape, and a city needs some
  }

  for (const f of rawBuildings.features) {
    if (!f.geometry) continue;
    const bbl = String(f.properties.base_bbl ?? f.properties.bbl ?? "").replace(/\.0+$/, "");
    const rec = table[bbl];
    let hft = num(f.properties.heightroof);
    if (!hft || hft < 8) { hft = rec && rec.floors ? rec.floors * 11.5 : 30; missingH++; }
    const hM = +(hft * 0.3048).toFixed(1);
    const year = num(f.properties.cnstrct_yr) ?? rec?.yearBuilt ?? 1950;
    const props = {
      bbl: bbl || "",
      class: rec?.class ?? "office",
      year,
      // stable per-building tone jitter for the facade palette
      tone: bbl ? Number(bbl) % 5 : 0,
      // decorative kind (hull, crane, light...) — the renderer paints by it
      ...(f.properties.deco ? { deco: f.properties.deco } : {}),
    };
    const id = bbl && table[bbl] ? Number(bbl) : undefined;
    const stack = bbl
      ? massing(f.geometry, hM, year, rec?.class ?? "office", bbl, lotRingByBBL.get(bbl))
      : null;
    if (stack && stack.length > 1) {
      // Which volume is the ROOF matters: the stair and lift overrun, the
      // antenna and the stepped deco crown belong on the top of the building
      // and not on every setback terrace under it. A bulkhead dropped on the
      // base tier of a wedding cake is a box drawn inside the tower above it.
      let ti = 0;
      for (let i = 1; i < stack.length; i++) if (stack[i].top > stack[ti].top) ti = i;
      stacked++; tiersTotal += stack.length;
      stack.forEach((t, i) => {
        tileBuildings.features.push({
          type: "Feature", id,
          geometry: t.geom,
          properties: { ...props, heightM: t.top, baseM: t.base, ...(i === ti ? { crown: 1 } : {}) },
        });
      });
    } else {
      const baseFt = num(f.properties.base_ft);
      tileBuildings.features.push({
        type: "Feature", id,
        geometry: f.geometry,
        properties: { ...props, heightM: hM, baseM: baseFt ? +(baseFt * 0.3048).toFixed(1) : 0, crown: 1 },
      });
    }
  }

  // Where the city IS, and where its centre of gravity is — so the map can
  // frame any city without a hand-tuned camera per map. The core is the
  // demand-weighted centroid with demand CUBED, which lands on the central
  // business district rather than the geometric middle of the land (those are
  // rarely the same place, and the middle is usually somebody's back yard).
  const bounds = (() => {
    let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
    let bx = 0, by = 0, bw = 0;
    for (const l of lots) {
      const [lon, lat] = proj.toLL(centroid(l.ring));
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < so) so = lat; if (lat > n) n = lat;
      const d = (table[l.bbl]?.demandScore ?? 1) / 100;
      const wt = d * d * d;
      bx += lon * wt; by += lat * wt; bw += wt;
    }
    return { bbox: [w, so, e, n], core: bw ? [bx / bw, by / bw] : [(w + e) / 2, (so + n) / 2] };
  })();
  const outManifest = {
    ...manifest,
    lots: lots.length,
    adjacencyEdges: edgeCount,
    bbox: bounds.bbox.map((v) => +v.toFixed(6)),
    core: bounds.core.map((v) => +v.toFixed(6)),
    processed: true,
  };

  // The compact mesh feed for the 3D renderer — the same volumes as the tiles.
  const buildings3d = [];
  for (const f of tileBuildings.features) {
    if (f.geometry.type !== "Polygon") continue;
    const p = f.properties;
    const ring = f.geometry.coordinates[0].slice(0, -1).map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]);
    if (ring.length < 3) continue;
    const rec = p.bbl ? table[p.bbl] : null;
    buildings3d.push({
      b: p.bbl, c: p.class, y: p.year, t: p.tone,
      f: rec?.floors ?? 0, z0: p.baseM, z1: p.heightM,
      d: p.bbl ? 0 : 1,               // decorative: ships, cranes, sheds
      ...(p.crown ? { x: 1 } : {}),   // this volume is the roof of the building
      ...(p.deco ? { dk: p.deco } : {}),
      r: ring,
    });
  }
  // vacant lots go out flat, so the renderer can dress them (gravel and fence)
  for (const l of lots) {
    const rec = table[l.bbl];
    if (!rec || rec.class !== "land") continue;
    buildings3d.push({
      b: l.bbl, c: "land", y: 0, t: Number(l.bbl) % 5, f: 0,
      z0: 0, z1: 0, d: 0, k: 1,
      r: l.ring.map((p) => proj.toLL(p).map((v) => +v.toFixed(6))),
    });
  }

  return {
    parcels: table,
    adjacency,
    stations: stationPts.map((s) => ({ name: s.name, lines: s.lines, ll: s.ll })),
    manifest: outManifest,
    tileParcels,
    tileBuildings,
    buildings3d,
    stats: {
      lots: lots.length,
      withNeighbours: Object.keys(adjacency).length,
      edges: edgeCount,
      buildings: tileBuildings.features.length,
      heightsImputed: missingH,
      stacked, tiersTotal, shapes,
    },
  };
}
