import { useMemo } from "react";
import { attentionItems, MILESTONES } from "@/engine/sim";
import { netWorth } from "@/engine/value";
import { useStore, type Page } from "@/state/store";

/** First-year focus strip: next chapter marker + whatever is blocking Advance. */
export default function YearRail() {
  const game = useStore((s) => s.game);
  const parcels = useStore((s) => s.parcels);
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const rail = useMemo(() => {
    if (!game || !parcels || game.gameOver) return null;
    if (game.month >= 12) return null;
    const nw = netWorth(game, parcels);
    const next = MILESTONES.find((m) =>
      ["deed1", "lease1", "tower1", "exit1", "nw25"].includes(m.id) && !m.test(game, nw));
    const blockers = attentionItems(game).slice(0, 2);
    const left = 12 - game.month;
    return { next, blockers, left };
  }, [game, parcels]);
  if (!rail) return null;

  const openDesk = () => {
    const target: Page = rail.blockers.length ? "deals" : "market";
    setPage(page === target ? "none" : target);
  };

  return (
    <div className="year-rail" role="status">
      <div className="year-rail-kicker">Year one · {rail.left} mo left</div>
      {rail.blockers.length > 0 ? (
        <div className="year-rail-body">
          <span className="year-rail-label">On your desk</span>
          <span className="year-rail-text">{rail.blockers[0].label}</span>
          <button type="button" className="year-rail-go" onClick={openDesk}>Open</button>
        </div>
      ) : (
        <div className="year-rail-body">
          <span className="year-rail-label">Next</span>
          <span className="year-rail-text">{rail.next?.label ?? "Keep the city in view — buy, lease, or build."}</span>
          <button type="button" className="year-rail-go" onClick={openDesk}>Acquire</button>
        </div>
      )}
    </div>
  );
}
