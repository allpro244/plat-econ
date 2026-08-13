/**
 * Map an attentionItems key to a page / parcel / special action.
 * Lives in engine so harnesses can assert every inbox key routes somewhere.
 */
import type { GameState } from "./types";

export type AttentionPage =
  | "none" | "portfolio" | "deals" | "market" | "research" | "economy" | "books"
  | "news" | "leasing" | "debt" | "property" | "saves" | "notes" | "settings"
  | "staff" | "primer";

export type AttentionRoute = {
  page?: AttentionPage;
  bbl?: string;
  /** Open the July auction card. */
  auction?: boolean;
};

export function routeAttention(key: string, game: GameState | null): AttentionRoute {
  if (!game) return {};
  const head = key.split(":")[0];

  if (head === "loi") return { page: "deals" };
  if (head === "tenant-ask") {
    const id = Number(key.split(":")[1]);
    const ask = (game.asks ?? []).find((a) => a.id === id);
    return ask ? { page: "property", bbl: ask.bbl } : { page: "deals" };
  }
  if (head === "portfolio-bid") return { page: "portfolio" };
  if (head === "broker") {
    const bbl = key.split(":")[1];
    return { page: "market", bbl };
  }
  if (head === "offer" || head === "sale-bids") {
    const bbl = key.split(":")[1];
    return { page: "portfolio", bbl };
  }
  if (head === "nonrenew" || head === "lease-roll" || head === "capital-plan") {
    const bbl = key.split(":")[1];
    return { page: "leasing", bbl };
  }
  if (head === "balloon" || head === "sweep") {
    const bbl = key.split(":")[1];
    return { page: "debt", bbl };
  }
  if (head === "facility-balloon" || head === "facility-sweep") return { page: "debt" };
  if (head === "capital-call") {
    const bbl = key.split(":")[1];
    return { page: "property", bbl };
  }
  if (head === "workout") {
    const bbl = key.split(":")[1];
    return { page: "property", bbl };
  }
  if (head === "contract" || head === "talks") {
    const bbl = key.split(":")[1];
    return { page: "deals", bbl };
  }
  if (head === "exchange") return { page: "portfolio" };
  if (head === "note" || head === "npl" || head === "private-ask" || head === "private-borrow") {
    return { page: "notes" };
  }
  if (head === "street-book") return { page: "market" };
  if (head === "auction") return { page: "market", auction: true };
  if (head === "line-over" || head === "cash-runway") return { page: "debt" };
  if (head === "cash") return { page: "books" };
  if (head === "ti-book") return { page: "leasing" };
  if (head === "estate") return { page: "property" };
  if (head === "over") return { page: "saves" };
  return { page: "deals" };
}
