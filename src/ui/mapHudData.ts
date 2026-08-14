/**
 * Pure snapshot for the map HUD — deliveries, balloons, attention count.
 * Reads game state only; no store, no DOM.
 */
import { attentionItems } from "@/engine/sim";
import { monthLabel } from "@/engine/types";
import type { GameState } from "@/engine/types";
import type { ParcelTable } from "@/data/types";
import { resolveRec } from "@/engine/value";

export type HudDelivery = { bbl: string; address: string; deliverM: number; label: string };
export type HudBalloon = { bbl: string; address: string; maturityM: number; months: number; label: string };

export type MapHudSnapshot = {
  attentionN: number;
  firstAttention: { key: string; label: string } | null;
  deliveries: HudDelivery[];
  balloons: HudBalloon[];
  deliveredSf: number;
};

export function mapHudSnapshot(game: GameState, parcels: ParcelTable | null): MapHudSnapshot {
  const attn = attentionItems(game);
  const deliveries: HudDelivery[] = [];
  for (const d of Object.values(game.developments ?? {})) {
    const rec = parcels ? resolveRec(parcels, game, d.bbl) : null;
    const address = rec?.address ?? d.bbl;
    deliveries.push({
      bbl: d.bbl,
      address,
      deliverM: d.deliverM,
      label: `${address} · delivers ${monthLabel(d.deliverM)}`,
    });
  }
  deliveries.sort((a, b) => a.deliverM - b.deliverM);

  const balloons: HudBalloon[] = [];
  for (const h of Object.values(game.holdings)) {
    if (!h.loan) continue;
    const months = h.loan.maturityM - game.month;
    if (months <= 0 || months > 18) continue;
    const rec = parcels ? resolveRec(parcels, game, h.bbl) : null;
    const address = rec?.address ?? h.bbl;
    balloons.push({
      bbl: h.bbl,
      address,
      maturityM: h.loan.maturityM,
      months,
      label: `${address} · balloon ${monthLabel(h.loan.maturityM)} (${months} mo)`,
    });
  }
  balloons.sort((a, b) => a.months - b.months);

  let deliveredSf = 0;
  for (const h of Object.values(game.holdings)) {
    if (h.deliveredM === undefined) continue;
    const b = game.built?.[h.bbl];
    if (b) deliveredSf += b.bldgArea ?? 0;
  }

  return {
    attentionN: attn.length,
    firstAttention: attn[0] ?? null,
    deliveries: deliveries.slice(0, 3),
    balloons: balloons.slice(0, 3),
    deliveredSf,
  };
}
