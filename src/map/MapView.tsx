import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useStore } from "@/state/store";
import { composeStyle, gameLayers, landLensColor, LIVE_DEMAND, resolveBaseStyle } from "./style";
import { ThreeBuildings, type BuildingVolume } from "./ThreeBuildings";
import { occupancy, resolveRec, useOccupancy } from "@/engine/value";
import { useSf } from "@/engine/mix";
import { monthLabel, START_YEAR } from "@/engine/types";
import type { GameState } from "@/engine/types";
import { cityVisualState } from "./cityVisuals";
import { siteDeeds } from "@/engine/actions";

/**
 * What the map actually paints. LOI counters, cash draws and news writes clone
 * a new `game` every click; subscribing to that identity re-rendered the whole
 * MapView (and re-ran skyline/occupancy work) on every desk action. This
 * signature stays stable unless the picture changed.
 */
function mapPaintSig(g: GameState | null | undefined): string {
  if (!g) return "";
  let leased = 0;
  for (const h of Object.values(g.holdings)) {
    for (const t of h.tenants) leased += t.sf;
  }
  return [
    g.month,
    Object.keys(g.holdings).join(","),
    g.listings.map((l) => l.bbl).join(","),
    Object.keys(g.developments ?? {}).join(","),
    Object.keys(g.built ?? {}).length,
    (g.cityJobs ?? []).length,
    Object.keys(g.merged ?? {}).length,
    leased,
    g.econ.phase,
    g.auction?.m ?? "",
    (g.bankFcls ?? []).length,
    Object.keys(g.blockD ?? {}).length,
  ].join("|");
}

const CITY_CENTER: [number, number] = [-70.9, 41.1];

const mixRgb = (a: [number, number, number], b: [number, number, number], t: number) => {
  const k = Math.max(0, Math.min(1, t));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

// One colour per firm, in the order the street was founded, so a rival's book
// reads as a shape on the map under the Owners lens. Muted on purpose — these
// sit under the gold of your own holdings, which always wins.
export const FIRM_TINT: [number, number, number][] = [
  [0.72, 0.92, 1.24],   // slate blue
  [1.18, 0.78, 0.86],   // rose
  [0.80, 1.16, 0.86],   // sage
  [1.16, 1.02, 0.72],   // ochre
  [0.94, 0.82, 1.20],   // violet
  [0.74, 1.12, 1.16],   // teal
  [1.20, 0.92, 0.70],   // clay
  [0.86, 0.86, 0.86],   // grey
];

// The two cameras are READ FROM THE DATA, not written down here. The pipeline
// puts the city's bounding box and its demand-weighted core into the manifest,
// so the opening shot frames whatever city was built and the dive lands on its
// business district. Hand-tuned constants meant every new map opened looking at
// the wrong piece of water.
type CityFrame = { bbox: [number, number, number, number]; core: [number, number] };
const FALLBACK: CityFrame = { bbox: [-70.912, 41.092, -70.888, 41.109], core: [-70.8966, 41.0997] };

/**
 * THE ZOOM AT WHICH THE WHOLE ISLAND FITS THE WINDOW.
 *
 * Web Mercator puts 512 pixels across 360° of longitude at zoom 0 and doubles
 * every level, so the zoom that lays `span` degrees across `px` pixels is
 * log2(px·360 / (512·span)). The city has to fit in BOTH directions, so the
 * binding constraint is whichever of the two is tighter — and it is not always
 * the same one, which is why this used to get it wrong.
 *
 * It measured both spans and then compared them against the WIDTH: latitude
 * span was converted to its longitude equivalent (the /cos term, which is the
 * Mercator stretch) and then `max`'d with the longitude span, so a tall narrow
 * island in a wide window was sized as though the window were square. On a
 * 1500x1000 viewport that is a third of the height thrown away, and on a
 * portrait window it overflows instead. Measured against the two spans, not
 * against one of them twice.
 */
function fitZoom(frame: CityFrame, wpx: number, hpx: number) {
  const [w, s, e, n] = frame.bbox;
  const lonSpan = Math.max(1e-4, e - w);
  // latitude degrees are worth more pixels than longitude degrees away from
  // the equator; at 41°N the factor is about 1.33
  const latSpan = Math.max(1e-4, n - s) / Math.cos((((s + n) / 2) * Math.PI) / 180);
  const zFor = (span: number, px: number) => Math.log2((px * 360) / (512 * span));
  return Math.min(zFor(lonSpan, wpx), zFor(latSpan, hpx));
}

/**
 * THE OPENING SHOT IS THE ISLAND'S OWN, WHATEVER SIZE IT IS.
 *
 * Both cameras used to carry a constant. The establishing shot was clamped at
 * zoom 14.6 and the dive was hard-wired to 15.3, and the reason nobody noticed
 * is that 15.3 happens to be almost exactly right for ONE island: measured on
 * the standard City map (1,379 lots, bbox 0.0203° x 0.0085°) at 1500x1000, the
 * whole island fits at zoom 15.66, so the shipped dive sat 0.36 of a level
 * inside it — the town filling the frame with a little water around it, which
 * is the shot the game has always opened on.
 *
 * That constant is a fact about one map, not about framing. A Great City is
 * twice the island end to end (bbox 0.0411° x 0.0175°, 5,766 lots) and fits at
 * 14.65, so the same 15.3 lands the camera A FULL ZOOM LEVEL inside it: the
 * player opens looking at roughly a quarter of the town with the other
 * three-quarters running off every edge — measured, and screenshotted, before
 * this change. In the other direction a Hamlet fits at about 16.5 and the 14.6
 * clamp opened it on four times more ocean than town.
 *
 * So both shots are expressed as a distance from the island's OWN fit zoom.
 * The establishing frame preserves the old calibration; the gameplay frame
 * deliberately comes closer so the renderer's architectural detail survives
 * at the camera where the game is actually played.
 */
// How far OUTSIDE the island's fit zoom the dive lands — negative because a
// smaller zoom is further away.
// The gameplay camera should be a city view, not an island diagram. Six per
// cent of breathing room keeps the shoreline in frame while making roofs,
// streets and construction readable without the player's first action being
// a zoom gesture.
const DIVE_INSET = -0.08;
// The establishing shot pulls back further, because it is the "here is a
// place" frame and a coastline needs water around it to read as an island.
// 0.9 of a level is 1.87x the island's span, which is where the standard map's
// clamped 14.6 sat (fit 15.66, so 2.09x) less a little of the dead ocean.
const WIDE_INSET = -0.9;
const framesOf = (f: CityFrame, wpx: number, hpx: number) => {
  const [w, s, e, n] = f.bbox;
  const mid: [number, number] = [(w + e) / 2, (s + n) / 2];
  const fit = fitZoom(f, wpx, hpx);
  // WHERE THE DIVE LANDS. Not on the business district itself: `core` is the
  // demand-weighted centre of gravity and on a big island it sits well off the
  // geometric middle — on the Great City measured above it is 15% of the map's
  // width east of centre, so pointing the camera straight at it would push the
  // whole west side out of frame at the very moment the shot is supposed to be
  // showing the player their town. Most of the way there: the CBD is clearly
  // the subject, and the island still has both its ends.
  const toward = 0.55;
  const at: [number, number] = [
    mid[0] + (f.core[0] - mid[0]) * toward,
    mid[1] + (f.core[1] - mid[1]) * toward,
  ];
  return {
    // the establishing shot: the whole city in frame, low pitch
    wide: { center: mid, zoom: fit + WIDE_INSET, pitch: 30, bearing: -8 },
    // the dive: down onto the central business district, still framing the town
    core: { center: at, zoom: fit + DIVE_INSET, pitch: 55, bearing: -12 },
  };
};

// NEIGHBOURHOOD SEAMS, DERIVED. Under the demand and land lenses the whole
// ground plane becomes one colour ramp, and the districts stop being places —
// you can see where the city is hot without being able to say it is Harborside.
// The generator never emits district boundary geometry, but it does not need
// to: every pavement cell carries its district, and two cells that face each
// other across a district seam were both cut by the same BSP half-plane, so
// their seam edges are collinear to within numerical noise. Overlapping
// collinear edge pairs owned by DIFFERENT districts are exactly the seams.
// Brute force over the ~1-2k street-length edges runs in under 20ms, once,
// the first time a lens opens.
function hoodBoundaries(ctx: GeoJSON.FeatureCollection | null | undefined): GeoJSON.FeatureCollection {
  const M = 111320; // metres per degree of latitude
  const cosLat = Math.cos((CITY_CENTER[1] * Math.PI) / 180);
  type Seg = { ux: number; uy: number; c: number; t0: number; t1: number; d: string };
  const segs: Seg[] = [];
  for (const f of ctx?.features ?? []) {
    if (f.properties?.kind !== "pavement" || f.geometry.type !== "Polygon") continue;
    const d = String(f.properties?.d ?? "");
    if (!d) continue;
    const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
    for (let i = 0; i < ring.length - 1; i++) {
      const px = ring[i][0] * M * cosLat, py = ring[i][1] * M;
      const qx = ring[i + 1][0] * M * cosLat, qy = ring[i + 1][1] * M;
      let ux = qx - px, uy = qy - py;
      const len = Math.hypot(ux, uy);
      if (len < 6) continue; // a sliver cannot carry a seam
      ux /= len; uy /= len;
      // canonical direction, so the two facing edges land on the same line key
      if (uy < 0 || (Math.abs(uy) < 1e-9 && ux < 0)) { ux = -ux; uy = -uy; }
      const ta = ux * px + uy * py, tb = ux * qx + uy * qy;
      segs.push({ ux, uy, c: -uy * px + ux * py, t0: Math.min(ta, tb), t1: Math.max(ta, tb), d });
    }
  }
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (a.d === b.d) continue;                                  // same neighbourhood
      if (Math.abs(a.ux * b.uy - a.uy * b.ux) > 0.002) continue;  // not parallel (~0.1 deg)
      if (Math.abs(a.c - b.c) > 0.9) continue;                    // parallel but a different street
      const lo = Math.max(a.t0, b.t0), hi = Math.min(a.t1, b.t1);
      if (hi - lo < 8) continue;                                  // corners touching, not a shared front
      const pt = (t: number): [number, number] =>
        [(-a.uy * a.c + a.ux * t) / (M * cosLat), (a.ux * a.c + a.uy * t) / M];
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [pt(lo), pt(hi)] }, properties: {} });
    }
  }
  return { type: "FeatureCollection", features };
}

export default function MapView() {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoveredRef = useRef<string | null>(null);
  /** Every deed painted selected — a whole assemblage, not just the click. */
  const selectedRef = useRef<string[]>([]);
  const neighborsRef = useRef<string[]>([]);
  const ownedRef = useRef<Set<string>>(new Set());
  const listedRef = useRef<Set<string>>(new Set());
  const assembledRef = useRef<Set<string>>(new Set());
  const threeRef = useRef<ThreeBuildings | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const hover = useStore((s) => s.hover);
  const setFps = useStore((s) => s.setFps);

  // THE MAP WAITS FOR THE CITY. Nothing is fetched any more — the parcel
  // polygons, the footprints, the water and the parks are all generated in
  // `loadData` and handed over here, so the map cannot mount until they exist.
  const city = useStore((s) => s.city);
  useEffect(() => {
    if (!el.current || mapRef.current || !city) return;
    let disposed = false;

    (async () => {
      const m = city.manifest as unknown as CityFrame;
      const frame = Array.isArray(m?.bbox) && Array.isArray(m?.core) ? m : FALLBACK;
      const base = await resolveBaseStyle(city.context);
      if (disposed || !el.current) return;
      // BOTH DIMENSIONS OF THE WINDOW, because the island has to fit in both.
      // Only the width was ever read, and the height was assumed to be the
      // width — see fitZoom.
      const shot = framesOf(frame, el.current.clientWidth || 1280, el.current.clientHeight || 800);
      // Native pixel density by default — a capable machine keeps the same
      // sharpness it had before. Prefer-FPS is the only path that caps DPR,
      // and only when the player asks for it on a weak GPU.
      const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
      const preferFps = useStore.getState().preferFps;
      const map = new maplibregl.Map({
        container: el.current,
        style: composeStyle(base, city),
        ...shot.wide,
        minZoom: shot.wide.zoom - 0.9, // whole city stays in frame; tiles never vanish
        maxPitch: 70,
        attributionControl: { compact: true },
        canvasContextAttributes: { antialias: true },
        pixelRatio: preferFps ? Math.min(dpr, 1.25) : dpr,
      });
      mapRef.current = map;
      // handle for automated playtests and screenshots
      (window as unknown as { __map?: maplibregl.Map }).__map = map;
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

      const featureIdsFor = (bbl: string) => Number(bbl);
      // GeoJSON sources have no source-layer. Everything else about feature
      // state is unchanged — the features carry the same numeric ids they
      // carried as tiles, because the ids come from the BBL either way.
      const setState = (bbl: string, state: Record<string, boolean>) => {
        const id = featureIdsFor(bbl);
        map.setFeatureState({ source: "bw-parcels", id }, state);
        map.setFeatureState({ source: "bw-buildings", id }, state);
      };

      map.on("load", () => {
        setMapReady(true);
        // the beautiful-buildings renderer: meshes with procedural facades
        Promise.resolve([city.buildings3d as BuildingVolume[], city.context as GeoJSON.FeatureCollection | null] as const)
          .then(([volumes, ctx]: readonly [BuildingVolume[], GeoJSON.FeatureCollection | null]) => {
            if (disposed || !volumes?.length) return;
            const curbs: [number, number][][] = (ctx?.features ?? [])
              .filter((f) => f.properties?.kind === "street" && f.geometry.type === "LineString")
              .map((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]);
            // park & esplanade trees and pier piles come along as 3D dressing
            const pointsOf = (kind: string): [number, number][] => (ctx?.features ?? [])
              .filter((f) => f.properties?.kind === kind && f.geometry.type === "Point")
              .map((f) => (f.geometry as GeoJSON.Point).coordinates as [number, number]);
            // furniture carries a bearing, so it comes across as point + rot
            const orientedOf = (kind: string) => (ctx?.features ?? [])
              .filter((f) => f.properties?.kind === kind && f.geometry.type === "Point")
              .map((f) => ({
                p: (f.geometry as GeoJSON.Point).coordinates as [number, number],
                r: Number(f.properties?.rot ?? 0),
              }));
            const ringsOf = (kind: string): [number, number][][] => (ctx?.features ?? [])
              .filter((f) => f.properties?.kind === kind && f.geometry.type === "Polygon")
              .map((f) => ((f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]).slice(0, -1));
            // the land ring becomes the hole in the water plane
            const landRing = (ctx?.features ?? [])
              .find((f) => f.properties?.kind === "land" && f.geometry.type === "Polygon");
            const layer = new ThreeBuildings(volumes, CITY_CENTER, curbs, {
              trees: pointsOf("tree"),
              piles: pointsOf("pile"),
              benches: orientedOf("bench"),
              rails: orientedOf("rail"),
              // the lawns get a real turf surface laid over the flat park fill,
              // and the pond and walks come up with it — otherwise the turf
              // buries the MapLibre layers that were drawing them
              parks: ringsOf("park"),
              ponds: ringsOf("pond"),
              paths: (ctx?.features ?? [])
                .filter((f) => f.properties?.kind === "parkpath" && f.geometry.type === "LineString")
                .map((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]),
              land: landRing
                ? ((landRing.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]).slice(0, -1)
                : undefined,
              // THE DEEDS. The renderer had every building's outline and not a
              // single lot's, so a redevelopment was drawn inside the footprint
              // of whatever it replaced — see ThreeBuildings.parcelRings. The
              // geometry was already in the room: this is the same collection
              // MapLibre paints the parcel fill from.
              lots: (() => {
                const out: Record<string, [number, number][]> = {};
                const fc = city.parcelFeatures as GeoJSON.FeatureCollection | undefined;
                for (const f of fc?.features ?? []) {
                  const bbl = f.properties?.bbl as string | undefined;
                  if (!bbl || f.geometry?.type !== "Polygon") continue;
                  const ring = (f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
                  if (ring?.length >= 4) out[bbl] = ring.slice(0, -1);
                }
                return out;
              })(),
            }, (useStore.getState().game?.citySeed ?? 1) >>> 0);
            layer.setMonth(useStore.getState().game?.month ?? 0);
            // the foot-traffic gradient reads demand at plant time, so it has
            // to arrive before addLayer triggers the build
            {
              const ps = useStore.getState().parcels;
              if (ps) {
                const dm: Record<string, number> = {};
                for (const bbl in ps) dm[bbl] = ps[bbl].demandScore;
                layer.setDemandMap(dm);
              }
            }
            layer.setPreferFps(useStore.getState().preferFps);
            threeRef.current = layer;
            // A handle for automated playtests, same as window.__map. The 3D
            // layer is the one part of this game whose correctness cannot be
            // asserted from state alone — you have to be able to ask the
            // geometry how tall it still is.
            (window as unknown as { __three?: unknown }).__three = layer;
            map.addLayer(layer);
          })
          .catch(() => {
            // no mesh feed — fall back to the flat extrusions
            map.setLayoutProperty("bw-bldg-3d", "visibility", "visible");
          });
        // the cinematic fly-in
        map.flyTo({ ...shot.core, duration: 5500, essential: true });

        map.on("mousemove", "bw-parcel-fill", (e) => {
          const f = e.features?.[0];
          const bbl = f?.properties?.bbl as string | undefined;
          if (!bbl || bbl === hoveredRef.current) return;
          if (hoveredRef.current) setState(hoveredRef.current, { hover: false });
          hoveredRef.current = bbl;
          setState(bbl, { hover: true });
          hover(bbl);
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "bw-parcel-fill", () => {
          if (hoveredRef.current) setState(hoveredRef.current, { hover: false });
          hoveredRef.current = null;
          hover(null);
          map.getCanvas().style.cursor = "";
        });
        map.on("click", (e) => {
          const box: [[number, number], [number, number]] = [
            [e.point.x - 8, e.point.y - 8],
            [e.point.x + 8, e.point.y + 8],
          ];
          const fs = map.queryRenderedFeatures(box, { layers: ["bw-parcel-fill"] });
          const bbl = (fs[0]?.properties?.bbl as string | undefined) ?? null;
          // Map is the index: select the lot AND put the camera on it. Empty
          // clicks clear the glance card. Closing firm pages (`page: none`)
          // keeps the docked parcel card visible for the selection.
          // Read from the store — this listener outlives the render that mounted it.
          const st = useStore.getState();
          if (bbl) st.focus(bbl, true);
          else st.select(null);
        });
      });

      // fps meter — only write the store when the readout is on. An unconditional
      // setFps every second used to re-render TopBar (and re-walk net worth) forever.
      let frames = 0;
      let last = performance.now();
      const tick = () => {
        if (disposed) return;
        frames++;
        const now = performance.now();
        if (now - last >= 1000) {
          if (useStore.getState().fpsOn) {
            setFps(Math.round((frames * 1000) / (now - last)));
          }
          frames = 0;
          last = now;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();

    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city]);

  // reflect selection + neighbor highlight into feature-state
  const selectedBBL = useStore((s) => s.selectedBBL);
  const adjacency = useStore((s) => s.adjacency);
  const parcels = useStore((s) => s.parcels);
  // Re-paint the site when an assemble/unmerge changes the plate under the same click.
  const mergedN = useStore((s) => Object.keys(s.game?.merged ?? {}).length);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      // style may still be loading during the first selection — retry shortly
      const t = setTimeout(() => useStore.setState({ selectedBBL }), 150);
      if (!map) return () => clearTimeout(t);
      clearTimeout(t);
    }
    if (!map) return;
    const setState = (bbl: string, state: Record<string, boolean>) => {
      const id = Number(bbl);
      map.setFeatureState({ source: "bw-parcels", id }, state);
      map.setFeatureState({ source: "bw-buildings", id }, state);
    };
    for (const d of selectedRef.current) setState(d, { selected: false });
    for (const n of neighborsRef.current) setState(n, { neighbor: false });
    neighborsRef.current = [];
    selectedRef.current = [];
    if (selectedBBL) {
      // An assemblage is one site: paint every folded deed gold together so
      // the teal join reads as a plate, not three unrelated lots.
      const game = useStore.getState().game;
      const site = game ? siteDeeds(game, selectedBBL) : [selectedBBL];
      selectedRef.current = site;
      for (const d of site) setState(d, { selected: true });
      const siteSet = new Set(site);
      const nbrs: string[] = [];
      for (const d of site) {
        for (const n of adjacency?.[d] ?? []) {
          if (siteSet.has(n) || nbrs.includes(n)) continue;
          nbrs.push(n);
          setState(n, { neighbor: true });
        }
      }
      neighborsRef.current = nbrs;
      // ease toward the parcel if it's far from view
      const rec = parcels?.[selectedBBL];
      if (rec) {
        const c = map.getCenter();
        const d = Math.hypot(c.lng - rec.centroid[0], c.lat - rec.centroid[1]);
        if (d > 0.004) map.easeTo({ center: rec.centroid, duration: 800 });
      }
    }
  }, [selectedBBL, adjacency, parcels, mergedN]);

  // GO TO PROPERTY. An explicit request from a list somewhere in the panel —
  // unlike the gentle ease above, this one always moves and always zooms in
  // far enough to actually see the building.
  const flyTo = useStore((s) => s.flyTo);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo || !parcels) return;
    const rec = parcels[flyTo.bbl];
    if (!rec) return;
    map.flyTo({
      center: rec.centroid,
      zoom: Math.max(map.getZoom(), 16.1),
      pitch: Math.max(map.getPitch(), 52),
      duration: 1400,
      essential: true,
    });
  }, [flyTo, parcels]);

  // Fit the whole book — portfolio "Show book on map" and Map HUD filter.
  const fitBook = useStore((s) => s.fitBook);
  useEffect(() => {
    if (!fitBook) return;
    const map = mapRef.current;
    const game = useStore.getState().game;
    if (!map || !parcels || !game) return;
    const pts: [number, number][] = [];
    for (const bbl of Object.keys(game.holdings)) {
      if (game.merged?.[bbl]) continue;
      const c = parcels[bbl]?.centroid;
      if (c) pts.push(c);
    }
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.flyTo({
        center: pts[0],
        zoom: Math.max(map.getZoom(), 15.6),
        pitch: Math.max(map.getPitch(), 48),
        duration: 1200,
        essential: true,
      });
      return;
    }
    let w = pts[0][0], s = pts[0][1], e = pts[0][0], n = pts[0][1];
    for (const [lng, lat] of pts) {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    const pad = 0.0008;
    map.fitBounds(
      [[w - pad, s - pad], [e + pad, n + pad]],
      { padding: 72, duration: 1400, pitch: Math.max(map.getPitch(), 48), essential: true },
    );
  }, [fitBook, parcels]);

  // ownership + listings → feature-state and rooftop markers
  // Subscribe to a paint signature, not `game` identity — see mapPaintSig.
  const paintSig = useStore((s) => mapPaintSig(s.game));
  useEffect(() => {
    const game = useStore.getState().game;
    const map = mapRef.current;
    if (!map || !mapReady || !game || !parcels) return;
    const setState = (bbl: string, state: Record<string, boolean>) => {
      const id = Number(bbl);
      map.setFeatureState({ source: "bw-parcels", id }, state);
      map.setFeatureState({ source: "bw-buildings", id }, state);
    };
    const nowOwned = new Set(Object.keys(game.holdings));
    for (const bbl of ownedRef.current) if (!nowOwned.has(bbl)) setState(bbl, { owned: false });
    for (const bbl of nowOwned) if (!ownedRef.current.has(bbl)) setState(bbl, { owned: true });
    ownedRef.current = nowOwned;

    const nowListed = new Set(game.listings.map((l) => l.bbl));
    for (const h of Object.values(game.holdings)) if (h.sale) nowListed.add(h.bbl);
    for (const bbl of listedRef.current) if (!nowListed.has(bbl)) setState(bbl, { listed: false });
    for (const bbl of nowListed) if (!listedRef.current.has(bbl)) setState(bbl, { listed: true });
    listedRef.current = nowListed;

    // Teal join on every multi-deed site — children plus their parents.
    const nowAssembled = new Set<string>();
    for (const [child, parent] of Object.entries(game.merged ?? {})) {
      nowAssembled.add(child);
      nowAssembled.add(parent);
    }
    for (const bbl of assembledRef.current) if (!nowAssembled.has(bbl)) setState(bbl, { assembled: false });
    for (const bbl of nowAssembled) if (!assembledRef.current.has(bbl)) setState(bbl, { assembled: true });
    assembledRef.current = nowAssembled;

    const src = map.getSource("bw-owned") as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: "FeatureCollection",
      features: [...nowOwned].map((bbl) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: parcels[bbl]?.centroid ?? [0, 0] },
        properties: { bbl },
      })),
    });

    // Everything that can be bought right now, pinned over its roof: red for a
    // building on the tape, green for vacant land, violet for a motivated
    // seller priced under appraisal. Reading availability off the map is most of the
    // early game, and a 16%-opacity ground tint under a tower was invisible.
    const forSale = map.getSource("bw-forsale") as maplibregl.GeoJSONSource | undefined;
    forSale?.setData({
      type: "FeatureCollection",
      features: game.listings.map((l) => {
        const rec = parcels[l.bbl];
        return {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: rec?.centroid ?? [0, 0] },
          properties: {
            bbl: l.bbl,
            kind: l.distress ? "offmkt" : rec?.class === "land" ? "land" : "built",
          },
        };
      }),
    });
  }, [paintSig, parcels, mapReady]);

  const lens = useStore((s) => s.lens);

  // Live demand into feature-state, so the demand and land lenses paint what
  // the engine is actually pricing off. Only blocks that have MOVED are pushed
  // — on day one that is none of them, and after a century it is a few hundred
  // parcels, written once per month and only while a lens is open.
  const dmdRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const game = useStore.getState().game;
    const map = mapRef.current;
    if (!map || !mapReady || !game || !parcels) return;
    if (lens !== "demand" && lens !== "land") return;
    const drift = game.blockD ?? {};
    const next = new Map<string, number>();
    for (const bbl of Object.keys(parcels)) {
      const r = parcels[bbl];
      const d = drift[r.block];
      if (!d) continue;
      next.set(bbl, Math.max(2, Math.min(100, r.demandScore + d)));
    }
    for (const [bbl, v] of next) {
      if (dmdRef.current.get(bbl) === v) continue;
      map.setFeatureState({ source: "bw-parcels", id: Number(bbl) }, { dmd: v });
    }
    for (const bbl of dmdRef.current.keys()) {
      if (!next.has(bbl)) map.removeFeatureState({ source: "bw-parcels", id: Number(bbl) }, "dmd");
    }
    dmdRef.current = next;
  }, [paintSig, parcels, mapReady, lens]);

  // THE ZONING LENS PAINTS ROOM, NOT RULES.
  //
  // A map of zone districts tells you what the code says. It does not tell you
  // anything you can act on, because the code is the same on the corner that
  // was built out in 1912 and the one beside it carrying a parking lot. The
  // question a developer actually asks is the DIFFERENCE between them: how
  // much more could stand here than does?
  //
  // So this pushes the UNUSED SHARE OF THE ENVELOPE — one minus built FAR over
  // allowed FAR — which is the redevelopment surface, and it moves. It moves
  // when the board upzones a district, when a variance is won on one lot, when
  // something is landmarked and its remaining envelope goes to zero, and when
  // anybody finishes a building. Every one of those is a thing the player did
  // or a thing that happened to them, and none of them is visible on a map of
  // zone letters.
  const zoneRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const game = useStore.getState().game;
    const map = mapRef.current;
    if (!map || !mapReady || !game || !parcels) return;
    if (lens !== "zoning") return;
    const next = new Map<string, number>();
    for (const bbl of Object.keys(parcels)) {
      const rec = resolveRec(parcels, game, bbl);
      if (!rec || !rec.lotArea) continue;
      // The RESOLVED envelope: the district's multiplier, anything won at a
      // hearing on this lot, and nothing at all if it has been landmarked.
      const far = Math.max(rec.farMaxComm, rec.farMaxRes);
      if (!(far > 0)) { next.set(bbl, 0); continue; }        // landmarked: no room, and that is the point
      const used = rec.bldgArea / (rec.lotArea * far);
      next.set(bbl, Math.round(100 * Math.max(0, Math.min(1, 1 - used))));
    }
    for (const [bbl, v] of next) {
      if (zoneRef.current.get(bbl) === v) continue;
      map.setFeatureState({ source: "bw-parcels", id: Number(bbl) }, { room: v });
    }
    for (const bbl of zoneRef.current.keys()) {
      if (!next.has(bbl)) map.removeFeatureState({ source: "bw-parcels", id: Number(bbl) }, "room");
    }
    zoneRef.current = next;
  }, [paintSig, parcels, mapReady, lens]);

  // LEASE LENS — months to the next expiry on buildings you own.
  // Bright = soon (rollover risk); dark = long WALT. Unowned lots stay mute.
  const leaseRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const game = useStore.getState().game;
    const map = mapRef.current;
    if (!map || !mapReady || !game || !parcels) return;
    if (lens !== "leases") return;
    const next = new Map<string, number>();
    for (const h of Object.values(game.holdings)) {
      if (h.groundLeased || !h.tenants?.length) continue;
      let soonest = Infinity;
      for (const t of h.tenants) {
        const left = t.endM - game.month;
        if (left >= 0 && left < soonest) soonest = left;
      }
      if (!Number.isFinite(soonest)) continue;
      // 0–24 months mapped to 100–0 (bright when near). Beyond 24 → 0 (dark).
      next.set(h.bbl, Math.round(100 * Math.max(0, 1 - Math.min(24, soonest) / 24)));
    }
    for (const [bbl, v] of next) {
      if (leaseRef.current.get(bbl) === v) continue;
      map.setFeatureState({ source: "bw-parcels", id: Number(bbl) }, { leaseSoon: v });
    }
    for (const bbl of leaseRef.current.keys()) {
      if (!next.has(bbl)) map.removeFeatureState({ source: "bw-parcels", id: Number(bbl) }, "leaseSoon");
    }
    leaseRef.current = next;
  }, [paintSig, parcels, mapReady, lens]);

  // name labels: districts, parks, water — DOM markers, no glyph server needed
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const markers: maplibregl.Marker[] = [];
    let disposed = false;
    Promise.resolve(city?.context as { features: { geometry: { type: string; coordinates: [number, number] }; properties: Record<string, string> }[] } | null)
      .then((fc) => {
        if (disposed || !fc) return;
        for (const f of fc.features) {
          if (f.properties.kind !== "label") continue;
          const el = document.createElement("div");
          el.className = "map-label map-label-" + f.properties.labelKind;
          el.textContent = f.properties.name;
          markers.push(new maplibregl.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(map));
        }
        const fade = () => {
          const z = map.getZoom();
          for (const m of markers) {
            const el = m.getElement();
            const kind = el.className.includes("district") ? "district" : el.className.includes("park") ? "park" : "water";
            const on =
              kind === "district" ? z >= 12.2 && z <= 15.6 :
              kind === "park" ? z >= 13.2 :
              z <= 14.5;
            el.style.opacity = on ? "1" : "0";
          }
        };
        map.on("zoom", fade);
        fade();
      })
      .catch(() => { /* labels are decoration — never block the map */ });
    return () => {
      disposed = true;
      markers.forEach((m) => m.remove());
    };
  }, [mapReady, city]);

  // mesh tints: gold selection/ownership, teal neighbors, warm hover
  const hoveredBBL = useStore((s) => s.hoveredBBL);
  const mapFilter = useStore((s) => s.mapFilter);
  useEffect(() => {
    const game = useStore.getState().game;
    const layer = threeRef.current;
    if (!layer || !mapReady) return;
    const tints = new Map<string, [number, number, number]>();
    if (game) for (const l of game.listings) tints.set(l.bbl, [1.24, 0.9, 0.84]);   // on the market
    // THE OWNERS LENS. Who holds what, across the whole town, in one look —
    // a firm's book is a shape on a map, and reading that shape is how you
    // work out what somebody is assembling and where they will not sell.
    if (game && lens === "owners") {
      for (const r of game.rivals ?? []) {
        const c = FIRM_TINT[(game.rivals ?? []).indexOf(r) % FIRM_TINT.length];
        for (const b of r.bbls) tints.set(b, c);
      }
    }
    if (game) for (const bbl of Object.keys(game.holdings)) tints.set(bbl, [1.28, 1.1, 0.72]);
    // Assembled plates get a soft teal lift on the mesh so the join is
    // readable in 3D, not only on the MapLibre lot lines.
    if (game) {
      for (const [child, parent] of Object.entries(game.merged ?? {})) {
        tints.set(child, [0.78, 1.14, 1.12]);
        tints.set(parent, [0.82, 1.16, 1.14]);
      }
    }
    if (selectedBBL) {
      const site = game ? siteDeeds(game, selectedBBL) : [selectedBBL];
      const siteSet = new Set(site);
      for (const d of site) {
        for (const n of adjacency?.[d] ?? []) {
          if (!siteSet.has(n)) tints.set(n, [0.72, 1.12, 1.04]);
        }
      }
      for (const d of site) tints.set(d, [1.5, 1.14, 0.5]);
    }
    if (hoveredBBL && hoveredBBL !== selectedBBL) tints.set(hoveredBBL, [1.14, 1.08, 0.92]);

    // Map filter: dim everything outside the book / crane set without hiding it.
    if (game && mapFilter !== "all") {
      const keep = new Set<string>();
      if (mapFilter === "owned") {
        for (const bbl of Object.keys(game.holdings)) keep.add(bbl);
      } else {
        for (const d of Object.values(game.developments ?? {})) keep.add(d.bbl);
        for (const j of game.cityJobs ?? []) keep.add(j.bbl);
      }
      for (const bbl of layer.rangesByBBL.keys()) {
        if (keep.has(bbl)) continue;
        const cur = tints.get(bbl) ?? [1, 1, 1];
        tints.set(bbl, [cur[0] * 0.55, cur[1] * 0.55, cur[2] * 0.55]);
      }
    }
    layer.setTints(tints);
  }, [selectedBBL, hoveredBBL, adjacency, paintSig, mapReady, lens, mapFilter]);

  // THE CITY'S VACANCY, ON THE CITY.
  //
  // Nothing about the economy reached the map. You could own half the
  // waterfront and be bleeding on every foot of it and the picture would be
  // identical to the picture of a full book, so the simulation and the thing
  // filling the screen were two objects sharing a window. A principal does not
  // open a spreadsheet to find out which of his towers is empty — he looks at
  // it, and then he looks at everybody else's.
  //
  // Your own buildings report the truth off the rent roll, to the square foot.
  // Everything else reports what the model says a building of that class, on
  // that corner, in that condition is running at — which is not cheating,
  // because a half-dark building is the most public fact in real estate. It
  // moves with the cycle, so a glut arrives on the map as the city going dark
  // a district at a time, and you can watch it happen from the air.
  useEffect(() => {
    const game = useStore.getState().game;
    const layer = threeRef.current;
    if (!layer || !mapReady || !game || !parcels) return;
    const occ = new Map<string, number>();
    // ...and the shops separately, because a full office tower can still have
    // a dead ground floor, and the street knows the difference.
    const ret = new Map<string, number>();
    for (const bbl of layer.rangesByBBL.keys()) {
      const h = game.holdings[bbl];
      const rec = resolveRec(parcels, game, bbl);
      if (!rec || rec.class === "land" || !rec.bldgArea) continue;
      if (h) {
        const leased = h.tenants.reduce((n, t) => n + t.sf, 0);
        occ.set(bbl, Math.max(0, Math.min(1, leased / Math.max(1, rec.bldgArea))));
      } else {
        occ.set(bbl, occupancy(rec, game.econ));
      }
      const retailSf = useSf(rec, "retail");
      if (retailSf > 300) {
        if (h) {
          const let_ = h.tenants.reduce((n, t) => n + ((t.use ?? rec.class) === "retail" ? t.sf : 0), 0);
          ret.set(bbl, Math.max(0, Math.min(1, let_ / retailSf)));
        } else {
          ret.set(bbl, useOccupancy(rec, game.econ, "retail"));
        }
      }
    }
    // BLOCK TROUBLE AS A LOOK. One dark shop is noise; a street with three
    // empty bays is what you see from the air months before the Economy page
    // moves. Fold retail occupancy by block and write the block mean onto
    // every shopfront on that block — same shader, legible neighbourhood.
    {
      const byBlock = new Map<string, { sum: number; n: number; bbls: string[] }>();
      for (const [bbl, v] of ret) {
        const rec = resolveRec(parcels, game, bbl);
        if (!rec?.block) continue;
        const row = byBlock.get(rec.block) ?? { sum: 0, n: 0, bbls: [] };
        row.sum += v;
        row.n++;
        row.bbls.push(bbl);
        byBlock.set(rec.block, row);
      }
      for (const row of byBlock.values()) {
        if (row.n < 2) continue;
        const mean = row.sum / row.n;
        for (const bbl of row.bbls) ret.set(bbl, mean);
      }
    }
    layer.setOccupancy(occ);
    layer.setRetail(ret);
    // the courthouse on the door: auction lots, noticed foreclosures, and
    // owned balloons inside eighteen months — cycle risk on the skyline.
    const notices = new Set<string>();
    for (const l of game.auction?.lots ?? []) if (game.month < (game.auction?.m ?? 0)) notices.add(l.bbl);
    for (const f of game.bankFcls ?? []) notices.add(f.bbl);
    for (const h of Object.values(game.holdings)) {
      if (!h.loan) continue;
      const mo = h.loan.maturityM - game.month;
      if (mo > 0 && mo <= 18) notices.add(h.bbl);
    }
    layer.setNotices([...notices]);
  }, [paintSig, mapReady, parcels, city]);

  // player construction and city growth onto the skyline
  const dynSigRef = useRef("");
  useEffect(() => {
    const game = useStore.getState().game;
    const layer = threeRef.current;
    if (!layer || !mapReady || !game) return;
    // ONE FLOOR-TO-FLOOR, BECAUSE A STOREY IS A STOREY.
    //
    // The player's buildings extruded at 3.4 m a floor and the generator's city
    // at 3.55 (citygen.mjs:1250 and :1643), so the same twenty-storey building
    // stood three metres shorter if the player put it up — the same quantity
    // with two answers, in the one place the two populations stand next to each
    // other and get compared by eye. 3.55 is the city's, and the city is the
    // thing there is more of.
    const FLOOR_M = 3.55;
    // THE YEAR IT WAS FINISHED, because that is what decides what it looks
    // like. The renderer used to guess — every building the player or a rival
    // put up was painted somewhere in a hard-coded 1992-2017 band, whatever
    // year the campaign was actually in — and it chose its facade off class
    // alone. Both of those are answers `styles.ts` already has, and it needs
    // the year to give them.
    const nowYear = START_YEAR + Math.floor(game.month / 12);
    const items: { bbl: string; cls: string; heightM: number; floors: number; construction: boolean; fresh?: boolean; cov?: number; year?: number }[] = [];
    for (const d of Object.values(game.developments ?? {})) {
      const total = Math.max(1, d.deliverM - d.startM);
      const prog = Math.min(1, Math.max(0.15, (game.month - d.startM + 1) / total));
      items.push({ bbl: d.bbl, cls: d.use, heightM: d.floors * FLOOR_M * prog, floors: d.floors, construction: true, cov: d.coverage, year: nowYear });
    }
    // EVERYBODY ELSE'S CRANES. The city's pipeline was invisible until the day
    // it opened, so the supply you were reading about on the Economy page had
    // no presence on the map at all — and a rival's tower going up across the
    // street from your lease-up is the single most legible thing in this
    // business. An orphaned frame stops rising and stands there.
    for (const j of game.cityJobs ?? []) {
      if (game.built?.[j.bbl] || game.developments?.[j.bbl]) continue;
      const total = Math.max(1, j.deliverM - j.startM);
      const raw = (game.month - j.startM + 1) / total;
      const prog = Math.min(1, Math.max(0.12, j.orphaned ? Math.min(raw, 0.75) : raw));
      items.push({ bbl: j.bbl, cls: j.use, heightM: j.floors * FLOOR_M * prog, floors: j.floors, construction: true, year: nowYear });
    }
    for (const [bbl, b] of Object.entries(game.built ?? {})) {
      if (game.developments?.[bbl]) continue; // conversion shell is represented by the construction massing
      // bunting for the first three months after delivery — a grand opening
      const dM = game.holdings[bbl]?.deliveredM;
      const fresh = dM !== undefined && game.month - dM <= 3;
      // b.yearBuilt is the delivery year the engine stamped. A building keeps
      // the skin of the decade it went up in for the rest of the campaign;
      // it does not restyle itself as the years pass.
      items.push({ bbl, cls: b.class, heightM: b.floors * FLOOR_M, floors: b.floors, construction: false, fresh, cov: b.cov, year: b.yearBuilt || nowYear });
    }
    // AN ASSEMBLED SITE IS ONE BUILDING ON SEVERAL DEEDS. The massing lives on
    // the parent lot; without this a tower built on three merged lots rose out
    // of one of them while the other two stayed conspicuously empty, which is
    // the opposite of what assembling them was for.
    const merged = game.merged ?? {};
    if (Object.keys(merged).length) {
      const byParent = new Map(items.map((i) => [i.bbl, i]));
      for (const [child, parent] of Object.entries(merged)) {
        const p = byParent.get(parent);
        if (p) items.push({ ...p, bbl: child });
      }
    }
    // meshes are rebuilt only when the skyline actually changed
    const sig = items.map((i) => i.bbl + ":" + i.heightM.toFixed(1) + (i.construction ? "c" : "") + (i.fresh ? "f" : "")).join("|");
    if (sig === dynSigRef.current) return;
    dynSigRef.current = sig;
    layer.setPlayerBuildings(items);
  }, [paintSig, mapReady]);

  const gameMonth = useStore((s) => s.game?.month ?? 0);
  const visualGame = useStore.getState().game;
  const cityVisual = visualGame
    ? cityVisualState(visualGame)
    : { weather: "clear" as const, precipitation: 0, overcast: 0, activity: 1 };
  useEffect(() => {
    if (!mapReady) return;
    threeRef.current?.setMonth(gameMonth);
  }, [gameMonth, mapReady]);
  useEffect(() => {
    if (!mapReady) return;
    threeRef.current?.setActivity(cityVisual.activity);
  }, [cityVisual.activity, mapReady]);
  const preferFps = useStore((s) => s.preferFps);
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    const dpr = typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1;
    map?.setPixelRatio(preferFps ? Math.min(dpr, 1.25) : dpr);
    threeRef.current?.setPreferFps(preferFps);
  }, [preferFps, mapReady]);
  useEffect(() => {
    if (!mapReady) return;
    threeRef.current?.setWeather(
      cityVisual.weather,
      cityVisual.precipitation,
      cityVisual.overcast,
    );
    const map = mapRef.current;
    if (map) {
      const cloud = cityVisual.overcast;
      map.setSky({
        "sky-color": mixRgb([79, 147, 207], [112, 132, 145], cloud),
        "sky-horizon-blend": 0.52,
        "horizon-color": mixRgb([223, 233, 238], [190, 202, 207], cloud),
        "horizon-fog-blend": 0.72,
        "fog-color": mixRgb([195, 216, 230], [164, 177, 184], cloud),
        "fog-ground-blend": 0.8,
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 12, 0.72, 15.5, 0.52, 18, 0.32],
      });
      map.setLight({
        anchor: "map",
        color: mixRgb([255, 255, 255], [205, 211, 214], cloud),
        intensity: 0.42 - cloud * 0.12,
        position: [1.15, 135, 55],
      });
    }
  }, [cityVisual.weather, cityVisual.precipitation, cityVisual.overcast, mapReady]);

  // lenses — repaint when toggled and as the market moves
  useEffect(() => {
    const game = useStore.getState().game;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const ghostBuildings = (on: boolean) => {
      if (threeRef.current) {
        threeRef.current.visible = !on;
        map.triggerRepaint();
        map.setLayoutProperty("bw-bldg-3d", "visibility", on ? "visible" : "none");
      }
    };
    // NEIGHBOURHOODS UNDER THE LENSES. The heat map answers "where is it hot"
    // but not "what is that place called", so while either market lens is up
    // the district names come up full-strength at every zoom (the CSS side of
    // the class below) and the seams between districts get a dashed line.
    // Both go away with the lens — the normal view keeps its clean model look.
    const hoods = lens === "demand" || lens === "land" || lens === "zoning" || lens === "leases";
    map.getContainer().classList.toggle("bw-lens-hoods", hoods);
    if (hoods && !map.getLayer("bw-hood-line")) {
      const ctx = useStore.getState().city?.context as GeoJSON.FeatureCollection | null;
      map.addSource("bw-hoods", { type: "geojson", data: hoodBoundaries(ctx) as never });
      map.addLayer({
        id: "bw-hood-line",
        type: "line",
        source: "bw-hoods",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#6b6250",
          "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1.4, 16.5, 3] as never,
          "line-opacity": 0.5,
          "line-dasharray": [3, 2.4],
        },
      }, map.getLayer("bw-owned-pts") ? "bw-owned-pts" : undefined);
    }
    if (map.getLayer("bw-hood-line")) map.setLayoutProperty("bw-hood-line", "visibility", hoods ? "visible" : "none");
    if (lens === "demand" && parcels) {
      ghostBuildings(true);
      map.setPaintProperty("bw-parcel-fill", "fill-color", [
        "interpolate", ["linear"], LIVE_DEMAND,
        5, "#eef0e8", 30, "#cfe0d5", 50, "#93c4b1", 70, "#4f9887", 92, "#1e6a60",
      ] as never);
      map.setPaintProperty("bw-parcel-fill", "fill-opacity", 0.82 as never);
      map.setPaintProperty("bw-bldg-3d", "fill-extrusion-opacity", 0.18 as never);
      return;
    }
    if (lens === "zoning" && game && parcels) {
      ghostBuildings(true);
      // Dark where the envelope is spent, bright where it is not. The ramp is
      // deliberately steep at the bottom: the difference between a lot that is
      // 95% built out and one that is 80% built out is the difference between
      // nothing and a deal, and a linear ramp buries it.
      map.setPaintProperty("bw-parcel-fill", "fill-color", [
        "interpolate", ["linear"], ["coalesce", ["feature-state", "room"], 0],
        0, "#3b3327", 10, "#6b5836", 25, "#9c7f3c", 50, "#c9a23f", 75, "#e3c766", 100, "#f5e6a8",
      ] as never);
      map.setPaintProperty("bw-parcel-fill", "fill-opacity", 0.85 as never);
      map.setPaintProperty("bw-bldg-3d", "fill-extrusion-opacity", 0.16 as never);
      return;
    }
    if (lens === "leases" && game && parcels) {
      ghostBuildings(true);
      // Mute lots with no state (−1); owned roll-risk paints warm. leaseSoon is 0–100.
      map.setPaintProperty("bw-parcel-fill", "fill-color", [
        "case",
        ["<", ["coalesce", ["feature-state", "leaseSoon"], -1], 0], "#d8d2c4",
        ["interpolate", ["linear"], ["coalesce", ["feature-state", "leaseSoon"], 0],
          0, "#3a3428", 25, "#6b5230", 50, "#b07a2e", 75, "#d4a03a", 100, "#f0c96a"],
      ] as never);
      map.setPaintProperty("bw-parcel-fill", "fill-opacity", 0.88 as never);
      map.setPaintProperty("bw-bldg-3d", "fill-extrusion-opacity", 0.16 as never);
      return;
    }
    if (lens === "listings" && game) {
      ghostBuildings(false);
      map.setPaintProperty("bw-parcel-fill", "fill-color", [
        "case",
        ["boolean", ["feature-state", "listed"], false], "#c8452f",
        "#8d8a82",
      ] as never);
      map.setPaintProperty("bw-parcel-fill", "fill-opacity", [
        "case",
        ["boolean", ["feature-state", "listed"], false], 0.52,
        0.07,
      ] as never);
      map.setPaintProperty("bw-parcel-line", "line-color", [
        "case",
        ["boolean", ["feature-state", "listed"], false], "#a83828",
        "#8a8577",
      ] as never);
      map.setPaintProperty("bw-bldg-3d", "fill-extrusion-opacity", 0.28 as never);
      if (map.getLayer("bw-forsale-pts")) map.setLayoutProperty("bw-forsale-pts", "visibility", "visible");
      if (map.getLayer("bw-forsale-halo")) map.setLayoutProperty("bw-forsale-halo", "visibility", "visible");
      return;
    }
    if (lens === "land" && game && parcels) {
      ghostBuildings(true);
      // percentile stops over CURRENT land $/sf so the ramp stays contrasty
      const vals: number[] = [];
      const bbls = Object.keys(parcels);
      const step = Math.max(1, Math.floor(bbls.length / 4000));
      for (let i = 0; i < bbls.length; i += step) {
        const r = parcels[bbls[i]];
        const d = Math.max(2, Math.min(100, r.demandScore + (game.blockD?.[r.block] ?? 0)));
        vals.push(r.landPsf * game.econ.landIdx * (1 + 0.22 * (0.25 + 0.9 * (d / 100)) * game.econ.cycleDev));
      }
      vals.sort((a, b) => a - b);
      const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
      const stops = [q(0.05), q(0.35), q(0.6), q(0.82), q(0.97)];
      map.setPaintProperty("bw-parcel-fill", "fill-color", landLensColor(game.econ.landIdx, game.econ.cycleDev, stops) as never);
      map.setPaintProperty("bw-parcel-fill", "fill-opacity", 0.82 as never);
      map.setPaintProperty("bw-bldg-3d", "fill-extrusion-opacity", 0.18 as never);
    } else {
      ghostBuildings(false);
      // restore the default paints straight from the style definition
      const fill = gameLayers().find((l) => l.id === "bw-parcel-fill");
      const bldg = gameLayers().find((l) => l.id === "bw-bldg-3d");
      if (fill && "paint" in fill && fill.paint) {
        map.setPaintProperty("bw-parcel-fill", "fill-color", (fill.paint as Record<string, unknown>)["fill-color"] as never);
        map.setPaintProperty("bw-parcel-fill", "fill-opacity", (fill.paint as Record<string, unknown>)["fill-opacity"] as never);
      }
      if (bldg && "paint" in bldg && bldg.paint) {
        map.setPaintProperty("bw-bldg-3d", "fill-extrusion-opacity", (bldg.paint as Record<string, unknown>)["fill-extrusion-opacity"] as never);
      }
    }
  }, [lens, paintSig, parcels, mapReady]);

  // hover tooltip: address before you commit to a click
  const tipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const map = mapRef.current;
    const tip = tipRef.current;
    if (!map || !mapReady || !tip) return;
    const container = map.getContainer();
    const onMove = (e: MouseEvent) => {
      const { hoveredBBL, parcels: table, selectedBBL, game: g } = useStore.getState();
      const rec = hoveredBBL && hoveredBBL !== selectedBBL ? table?.[hoveredBBL] : null;
      if (!rec) { tip.style.display = "none"; return; }
      const dmd = Math.round(Math.max(2, Math.min(100, rec.demandScore + (g?.blockD?.[rec.block] ?? 0))));
      // A SITE WITH A CRANE ON IT IS NOT A VACANT LOT. The parcel stays class
      // "land" until the day it delivers, so a job eighteen months into
      // construction read as bare dirt on the one label you get without
      // clicking. The panel already flags it; the map did not.
      const job = g?.developments?.[rec.bbl];
      const cityJob = !job ? (g?.cityJobs ?? []).find((j) => j.bbl === rec.bbl) : undefined;
      tip.textContent = job
        ? `${rec.address} · UNDER CONSTRUCTION · ${Math.round(job.sf).toLocaleString()} sf of ${job.use}`
          + `, ${job.floors} fl · opens ${monthLabel(job.deliverM)}`
        : cityJob
        ? `${rec.address} · CRANE · ${Math.round(cityJob.sf).toLocaleString()} sf of ${cityJob.use}`
          + `, ${cityJob.floors} fl · ${cityJob.orphaned ? "stalled" : `due ${monthLabel(cityJob.deliverM)}`}`
          + (cityJob.firmId ? ` · ${g?.rivals.find((r) => r.id === cityJob.firmId)?.name ?? "a rival"}` : " · the city")
        : rec.class === "land"
        ? `${rec.address} · vacant · ${rec.lotArea.toLocaleString()} sf lot · demand ${dmd}`
        : `${rec.address} · ${rec.floors} fl · ${Math.round(rec.bldgArea).toLocaleString()} sf · demand ${dmd}`;
      tip.style.display = "block";
      const r = container.getBoundingClientRect();
      tip.style.left = e.clientX - r.left + 14 + "px";
      tip.style.top = e.clientY - r.top + 16 + "px";
    };
    const onLeave = () => { tip.style.display = "none"; };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    return () => {
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
    };
  }, [mapReady]);

  return (
    <>
      <div ref={el} className="map-root" />
      <div ref={tipRef} className="hover-tip" style={{ display: "none" }} />
    </>
  );
}
