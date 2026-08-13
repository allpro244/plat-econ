// USE MIX.
//
// "Mixed-use" was an asset class, which is wrong and was quietly costing the
// game a lot of truth. There is no mixed-use market. Nobody quotes a mixed-use
// cap rate, no broker has a mixed-use comp set, and no tenant leases mixed-use
// space. What exists is a BUILDING with shops on the ground floor, offices on
// two through six and apartments above — and each of those competes in its own
// market, against its own comps, at its own rent, on its own lease terms.
//
// Treating it as a fifth class meant a mixed-use building had one blended rent
// that belonged to no market, one occupancy, one cap rate, and one kind of
// tenant. It also meant the retail on the ground floor did not count as retail
// anywhere in the model — including in the demand model, where amenity is the
// entire point of putting shops under apartments.
//
// So a building now carries a MIX: shares of floor area across the real
// classes. Everything economic is the share-weighted blend of the components,
// every tenant occupies a named component, and "mixed-use" is what we CALL a
// building whose mix has no dominant leg. That is the same direction as the
// rest of this engine — the label is downstream of the numbers, not the other
// way round.
import type { ParcelRecord } from "@/data/types";
import type { BuiltClass, UseMix } from "./types";

export type { UseMix };

/** A building reads as single-use above this share. */
export const DOMINANT_AT = 0.85;
/** Below this a leg is a rounding error, not a use. */
const MATERIAL = 0.04;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// Legacy parcel data still carries class "mixed" with no mix attached. Rather
// than a migration pass that every entry point has to remember to run, the mix
// is derived on demand and cached — so an old save, a fresh pipeline run and
// the test harness all agree without coordinating.
const DERIVED = new Map<string, UseMix>();

/** Stable per-parcel jitter, so a derived mix never changes between loads. */
function hash01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * What a legacy "mixed" record was actually describing: retail at grade,
 * everything else stacked above it. The ground floor is roughly one storey of
 * the building, which is why a three-storey mixed building is a third shops
 * and a twenty-storey one is five per cent shops — and why the tall ones are
 * really offices or apartments with a lobby-level cafe.
 */
function deriveMix(rec: ParcelRecord): UseMix {
  const hit = DERIVED.get(rec.bbl);
  if (hit) return hit;
  const j = hash01(rec.bbl);
  const floors = Math.max(1, rec.floors || 1);
  // grade-level retail runs a bit deeper than an average floor plate
  const retail = clamp((1 / floors) * (1.05 + 0.3 * j), 0.06, 0.42);
  const rest = 1 - retail;
  // the residential signal is already in the record; where it is silent, the
  // split leans commercial, because that is what a mixed block downtown is
  const resLean = rec.unitsRes > 0 ? 0.58 + 0.3 * j : 0.18 + 0.34 * j;
  const multifamily = rest * resLean;
  const office = rest - multifamily;
  const m = normalize({ retail, multifamily, office });
  DERIVED.set(rec.bbl, m);
  return m;
}

/** Drop immaterial legs and rescale to 1. */
export function normalize(raw: UseMix): UseMix {
  const out: UseMix = {};
  let total = 0;
  for (const k of Object.keys(raw) as BuiltClass[]) {
    const v = raw[k] ?? 0;
    if (v > MATERIAL) { out[k] = v; total += v; }
  }
  if (total <= 0) return { office: 1 };
  for (const k of Object.keys(out) as BuiltClass[]) out[k] = +((out[k] ?? 0) / total).toFixed(4);
  return out;
}

/** The composition of a building. Single-use buildings are a mix of one. */
export function mixOf(rec: Pick<ParcelRecord, "class" | "bbl" | "floors" | "unitsRes"> & { mix?: UseMix }): UseMix {
  if (rec.mix) return rec.mix;
  const cls = rec.class as string;
  if (cls === "land") return {};
  if (cls === "mixed") return deriveMix(rec as ParcelRecord);
  return { [cls as BuiltClass]: 1 };
}

/**
 * Rewrite a legacy parcel table in place: any record still filed as "mixed"
 * becomes its dominant use plus an explicit mix.
 *
 * The derived mix above makes reads safe, but it does not make `rec.class`
 * safe — and a surprising amount of code legitimately indexes a per-class
 * table by it. Rather than hunt every one of those forever, the data is made
 * true once, at the door. Idempotent, deterministic, and cheap.
 */
export function normalizeParcels(table: Record<string, ParcelRecord>): Record<string, ParcelRecord> {
  for (const bbl of Object.keys(table)) {
    const rec = table[bbl];
    if ((rec.class as string) !== "mixed") continue;
    const m = deriveMix(rec);
    rec.mix = m;
    rec.class = (Object.keys(m) as BuiltClass[]).sort((a, b) => (m[b] ?? 0) - (m[a] ?? 0))[0];
  }
  return table;
}

/** Square feet of one component. */
export function useSf(rec: ParcelRecord, use: BuiltClass): number {
  return (rec.bldgArea || 0) * (mixOf(rec)[use] ?? 0);
}

/** Every use present, biggest first. */
export function uses(rec: ParcelRecord): BuiltClass[] {
  const m = mixOf(rec);
  return (Object.keys(m) as BuiltClass[]).sort((a, b) => (m[b] ?? 0) - (m[a] ?? 0));
}

/** The leg the building is filed under. */
export function dominantUse(rec: ParcelRecord): BuiltClass {
  return uses(rec)[0] ?? "office";
}

/** True when no single use carries the building. */
export function isMixedUse(rec: ParcelRecord): boolean {
  if (rec.class === "land") return false;
  const m = mixOf(rec);
  return Math.max(0, ...Object.values(m)) < DOMINANT_AT;
}

/**
 * The blend. Any per-class number — rent, cap rate, opex, occupancy, cost —
 * weighted by how much of the building is that use. This is the whole of the
 * economics change: one function, applied wherever a class used to index a
 * table directly.
 */
export function blend(rec: ParcelRecord, table: Record<BuiltClass, number> | Partial<Record<BuiltClass, number>>): number {
  const m = mixOf(rec);
  let sum = 0, w = 0;
  for (const k of Object.keys(m) as BuiltClass[]) {
    const share = m[k] ?? 0;
    const v = table[k];
    if (v === undefined) continue;
    sum += v * share; w += share;
  }
  return w > 0 ? sum / w : 0;
}

/** Blend by an arbitrary per-use function, for tables that aren't plain records. */
export function blendBy(rec: ParcelRecord, f: (use: BuiltClass) => number): number {
  const m = mixOf(rec);
  let sum = 0, w = 0;
  for (const k of Object.keys(m) as BuiltClass[]) {
    const share = m[k] ?? 0;
    sum += f(k) * share; w += share;
  }
  return w > 0 ? sum / w : 0;
}

/** The share of the building that leases as commercial space with named tenants. */
export function commercialShare(rec: ParcelRecord): number {
  const m = mixOf(rec);
  return (m.office ?? 0) + (m.retail ?? 0) + (m.industrial ?? 0);
}

export const USE_WORD: Record<BuiltClass, string> = {
  office: "office",
  retail: "retail",
  multifamily: "apartments",
  industrial: "industrial",
};

/** "58% office · 27% apartments · 15% retail" — the label a broker would use. */
export function mixLabel(rec: ParcelRecord): string {
  const m = mixOf(rec);
  return uses(rec).map((u) => `${Math.round((m[u] ?? 0) * 100)}% ${USE_WORD[u]}`).join(" · ");
}
