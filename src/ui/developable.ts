/**
 * Owned sites where a builder residual still pencils — discovery for the map HUD
 * and parcel banner. Uses the same landRead the engine prices dirt with.
 */
import type { GameState } from "@/engine/types";
import type { ParcelTable } from "@/data/types";
import { landRead, resolveRec } from "@/engine/value";
import { farMaxFor } from "@/engine/dev";

export type DevelopableSite = {
  bbl: string;
  address: string;
  pencils: boolean;
  residualPsf: number;
  winner: string;
  room: number;
};

export function developableSites(game: GameState, parcels: ParcelTable): DevelopableSite[] {
  const out: DevelopableSite[] = [];
  for (const bbl of Object.keys(game.holdings)) {
    if (game.developments?.[bbl]) continue;
    const h = game.holdings[bbl];
    if (h.groundLeased) continue;
    const rec = resolveRec(parcels, game, bbl);
    if (!rec || !rec.lotArea) continue;
    const farMax = farMaxFor(rec);
    const used = rec.lotArea > 0 ? rec.bldgArea / rec.lotArea : 0;
    const room = farMax > 0 ? Math.max(0, 1 - used / farMax) : 0;
    // Vacant or substantial unused envelope.
    if (rec.class !== "land" && room < 0.25) continue;
    const read = landRead(rec, game.econ);
    out.push({
      bbl,
      address: rec.address,
      pencils: read.winner === "builder" && read.builder > 0,
      residualPsf: read.builder,
      winner: read.winner,
      room,
    });
  }
  out.sort((a, b) => {
    if (a.pencils !== b.pencils) return a.pencils ? -1 : 1;
    return b.residualPsf - a.residualPsf;
  });
  return out;
}
