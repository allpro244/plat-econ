// THE HARNESSES BUILD THEIR CITY TOO.
//
// Every bot used to read a pre-baked directory under public/data, which meant
// the whole balance of this game was calibrated against exactly two towns —
// and the game now makes a new one every run. Numbers tuned on one map are
// numbers that might only be true on that map.
//
// So the harnesses generate, from the same function the browser calls. Set
// BW_SEED to pin a town, or leave it and sweep:
//
//   BW_SEED=12345   pnpm test          one specific town
//   SEEDS=6 CITY_SEEDS=1 pnpm play50   a different town per run
//
// `CITY_SEEDS=1` is the important one: it makes each run of a multi-seed
// harness use a DIFFERENT city as well as a different market, which is the
// only honest way to ask whether a rule holds in general or just on one island.
import { makeCity, PROCEDURAL, REFERENCE_SEED } from "../src/citygen/index.mjs";

const DEFAULT_CITY = process.env.BW_CITY ?? PROCEDURAL;
const cache = new Map();

/** Deterministic town for a run index — stable across harnesses, so a bad seed is reproducible. */
export function seedFor(runIndex = 0) {
  if (process.env.BW_SEED) return Number(process.env.BW_SEED) >>> 0;
  if (process.env.CITY_SEEDS === "1") return (2166136261 ^ ((runIndex + 1) * 2654435761)) >>> 0;
  return REFERENCE_SEED;
}

/** Build (or reuse) a city. Returns the substrate every harness needs. */
export function loadCity(runIndex = 0, normalizeParcels) {
  const seed = seedFor(runIndex);
  const key = [DEFAULT_CITY, seed, process.env.BW_SIZE ?? "", process.env.BW_DENSITY ?? ""].join(":");
  if (!cache.has(key)) {
    const built = makeCity(DEFAULT_CITY, seed, {
      size: process.env.BW_SIZE || undefined,
      density: process.env.BW_DENSITY || undefined,
    });
    if (normalizeParcels) normalizeParcels(built.parcels);
    cache.set(key, {
      seed,
      city: DEFAULT_CITY,
      parcels: built.parcels,
      adjacency: built.adjacency,
      bbls: Object.keys(built.parcels),
    });
  }
  return cache.get(key);
}
