// A CITY, FROM A NUMBER.
//
// `makeCity("somewhere", 481923)` is the whole content pipeline in one call:
// generate the geometry, turn it into the game's substrate, hand back the
// parcel table, the adjacency graph, the map layers and the skyline. About
// 350ms, no network, no files.
//
// Every island is generated. island.mjs draws the coast, the cores, the
// district plan, the parks, the piers, the railway and every name on the map
// from the run's seed, and hands back a config of exactly the shape the
// generator expects. Nothing below this line knows or cares that the config
// was computed rather than written down — the same scaleCity scales it, the
// same generateCity cuts it, the same buildCityData tabulates it.
//
// The seed is the address. A city is `(island, seed, size, build-out)` and
// every one of those has to survive a reload, or a deed in a save points at a
// parcel that no longer exists. Roll the seed and you get a different coast
// AND a different town on it; keep it and you get the same island back on
// every reload, forever, down to the byte.
import { generateCity } from "./citygen.mjs";
import { buildCityData } from "./build.mjs";
import { SIZES, DEFAULT_SIZE, scaleCity } from "./cities.mjs";
import { islandConfig, islandName } from "./island.mjs";

export { SIZES, DEFAULT_SIZE };

/** The sizes an island can be built at, for the picker. */
export function sizeList() {
  return Object.entries(SIZES).map(([id, s]) => ({ id, ...s }));
}

/**
 * HOW BUILT-UP THE TOWN IS ON DAY ONE, for the picker.
 *
 * A subset of DENSITY in citygen.mjs — that table has nine entries and some of
 * them are historical calibration points rather than places anyone would
 * choose to play. These are the ones that read as different towns. `village`
 * is the default and is exactly the town the game has always shipped; every
 * other entry is a stated move away from it in BOTH height and build-out,
 * because a town that has not been built up yet is not merely shorter, it has
 * gaps in it.
 *
 * The numbers in the notes are measured on the standard island, seed 20261.
 */
export const DEVELOPMENT = [
  { id: "landing",    name: "Landing",     note: "Two thirds of the plat is still grass. One-storey fabric, nothing above four floors, and a harbour. You are not buying a city here — you are watching one start." },
  { id: "frontier",   name: "Frontier",    note: "A town that has begun. Over half the lots are empty, the ordinary building is two storeys, and the tallest thing in it is a warehouse." },
  { id: "village",    name: "Young town",  note: "The standard opening. Two fifths of it unbuilt, three-storey fabric, and nothing over fourteen floors yet." },
  { id: "town1900",   name: "Working town", note: "It has filled in around the harbour. A third still vacant, and the first buildings over twenty floors." },
  { id: "provincial", name: "Provincial",  note: "A working town that has grown up. Thirty per cent vacant, and a few thirty-floor buildings downtown." },
  { id: "harbour",    name: "Established", note: "A real skyline and less dirt — 27% vacant, four-storey fabric, towers to forty floors." },
  { id: "spiky",      name: "Boomtown",    note: "Low fabric, dramatic towers. A town that boomed once and stopped — a third of it still gaps, beside forty-seven floors." },
  { id: "capital",    name: "Capital",     note: "Built up and tall. A fifth vacant, five-storey fabric; you will be redeveloping more than you are building." },
  { id: "metropolis", name: "Metropolis",  note: "14% vacant and towers past sixty floors. Very little dirt left — this is a game about buying what exists." },
];
export const DEFAULT_DEVELOPMENT = "village";

export function developmentList() {
  return DEVELOPMENT.map((d) => ({ ...d }));
}

/**
 * THE GENERATED ISLAND.
 *
 * This is an id like any other as far as everything downstream is concerned —
 * the autosave slot is `auto@somewhere`, the seed lives at `bw:seed:somewhere`,
 * and `makeCity("somewhere", seed, …)` is a pure function of its arguments.
 * The config it builds from is computed from the seed instead of written down.
 */
export const PROCEDURAL = "somewhere";

/** Fixed reference seed for harnesses and BASELINE.json — a stable town, not a special island. */
export const REFERENCE_SEED = 1;

/**
 * The cities you can play. There is one kind of island and it is generated.
 */
export function cityList() {
  return [
    {
      id: PROCEDURAL,
      name: "Somewhere else",
      tagline: "An island nobody has drawn. The coast, the districts, the parks and every street name come out of your seed.",
    },
  ];
}

/**
 * What the island at a given seed is CALLED, without building it.
 *
 * The picker cannot show this before the run starts — the seed is rolled when
 * Break ground is pressed — but a saved campaign carries its seed, so the
 * Continue row can name the town instead of saying "Somewhere else" about a
 * place the player has lived in for twenty years.
 */
export function cityName(cityId, seed) {
  if (cityId === PROCEDURAL) return islandName(seed);
  return cityId;
}

/**
 * A seed that is a real number in the JS sense and a plausible one in the
 * game's: unsigned 32-bit, never zero (mulberry32 with a zero seed is a
 * perfectly fine sequence but a zero in a save reads like a missing value).
 */
export function randomSeed() {
  return ((Math.random() * 0xffffffff) >>> 0) || 1;
}

const LEGACY_DRAWN = new Set(["newalden", "kestrel"]);

/**
 * Build a whole city. Deterministic: the same id and seed give byte-identical
 * output, which is what lets a save store six digits instead of two megabytes.
 */
export function makeCity(cityId, seed, opts) {
  if (LEGACY_DRAWN.has(cityId)) {
    throw new Error(`removed city: ${cityId} — all islands are generated from a seed now`);
  }
  if (cityId !== PROCEDURAL) throw new Error(`unknown city: ${cityId}`);
  const base = islandConfig(seed);
  const sizeId = opts?.size && SIZES[opts.size] ? opts.size : DEFAULT_SIZE;
  const cfg = scaleCity(base, SIZES[sizeId].k);
  const city = generateCity({ ...cfg, seed: seed >>> 0, density: opts?.density });
  const data = buildCityData({
    rawParcels: city.parcels,
    rawBuildings: city.buildings,
    rawStations: city.stations,
    manifest: { ...city.manifest, seed: seed >>> 0 },
    employment: city.employment ?? null,
    parks: city.parks ?? [],
  });
  return {
    id: cityId,
    seed: seed >>> 0,
    size: sizeId,
    sizeK: SIZES[sizeId].k,
    name: cfg.name,
    parcels: data.parcels,
    adjacency: data.adjacency,
    stations: data.stations,
    manifest: data.manifest,
    parcelFeatures: data.tileParcels,
    buildingFeatures: data.tileBuildings,
    context: city.context,
    buildings3d: data.buildings3d,
    stats: { ...data.stats, blocks: city.stats?.blocks ?? 0, coverage: city.stats?.coverage?.pct ?? 0 },
  };
}
