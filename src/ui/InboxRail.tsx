import { useMemo } from "react";
import { attentionItems, MILESTONES } from "@/engine/sim";
import { netWorth } from "@/engine/value";
import { useStore, type Page } from "@/state/store";

/**
 * Persistent desk inbox: attentionItems with one Open action each, plus the
 * year-one milestone nudge when nothing is blocking.
 */
export default function InboxRail() {
  const game = useStore((s) => s.game);
  const parcels = useStore((s) => s.parcels);
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const openAttention = useStore((s) => s.openAttention);

  const rail = useMemo(() => {
    if (!game || !parcels || game.gameOver) return null;
    const blockers = attentionItems(game).slice(0, 4);
    const yearOne = game.month < 12;
    if (!yearOne && blockers.length === 0) return null;
    const nw = netWorth(game, parcels);
    const next = yearOne
      ? MILESTONES.find((m) =>
        ["deed1", "lease1", "tower1", "exit1", "nw25"].includes(m.id) && !m.test(game, nw))
      : undefined;
    return {
      blockers,
      next,
      left: yearOne ? 12 - game.month : null,
      yearOne,
    };
  }, [game, parcels]);

  if (!rail) return null;

  const openAcquire = () => {
    const target: Page = "market";
    setPage(page === target ? "none" : target);
  };

  return (
    <div className="year-rail inbox-rail" role="status">
      <div className="year-rail-kicker">
        {rail.yearOne
          ? `Year one · ${rail.left} mo left`
          : rail.blockers.length
            ? `On your desk · ${rail.blockers.length}`
            : "On your desk"}
      </div>

      {rail.blockers.length > 0 ? (
        <div className="inbox-list">
          {rail.blockers.map((b) => (
            <div key={b.key} className="year-rail-body inbox-row">
              <span className="year-rail-label">Desk</span>
              <span className="year-rail-text" title={b.label}>{b.label}</span>
              <button
                type="button"
                className="year-rail-go"
                onClick={() => openAttention(b.key)}
              >
                Open
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="year-rail-body">
          <span className="year-rail-label">Next</span>
          <span className="year-rail-text">
            {rail.next?.label ?? "Keep the city in view — buy, lease, or build."}
          </span>
          <button type="button" className="year-rail-go" onClick={openAcquire}>
            Acquire
          </button>
        </div>
      )}
    </div>
  );
}
