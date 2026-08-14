/** UI re-export — routing logic lives in engine for harness coverage. */
import type { GameState } from "@/engine/types";
import type { Page } from "@/state/store";
import {
  routeAttention as routeAttentionEngine,
  type AttentionRoute as EngineAttentionRoute,
} from "@/engine/attentionRoute";

export type AttentionRoute = Omit<EngineAttentionRoute, "page"> & { page?: Page };

export function routeAttention(key: string, game: GameState | null): AttentionRoute {
  return routeAttentionEngine(key, game);
}
