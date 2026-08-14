import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { sponsorStanding } from "@/engine/sponsor";

// What the lending market remembers about you. Only shown once there is
// something to remember — a clean sponsor does not need to be told they are
// clean, and an empty panel is noise.
export function SponsorRecord() {
  const game = useStore((s) => s.game)!;
  const st = sponsorStanding(game);
  const events = (game.sponsor?.events ?? []).filter((e) => game.month - e.m < 120);
  if (!events.length) return null;
  return (
    <div className="deal">
      <div className="deal-head">Your record with the desks · {st.label}</div>
      <div className="roll">
        {events.slice().reverse().map((e, i) => (
          <div key={i} className="roll-row">
            <span className="roll-name">
              {e.kind === "deficiency" ? "Deficiency paid" : e.kind === "seized" ? "Seized by creditors" : "Sold under pressure"} · {e.address}
            </span>
            <span className="roll-meta mono">
              {monthLabel(e.m)}{e.amount > 0 ? ` · $${(e.amount / 1e6).toFixed(2)}M hole` : ""} · ages off {monthLabel(e.m + 120)}
            </span>
          </div>
        ))}
      </div>
      <div className="deal-note">
        {st.institutional
          ? `Priced in: about +${st.spreadAdd.toFixed(2)}% on the coupon and ${(st.advanceCut * 100).toFixed(0)}% off the advance rate, on every loan you write until it ages off.`
          : `Agency and insurance money is closed to you. Bridge and mezzanine desks will still quote — at about +${st.spreadAdd.toFixed(2)}% and ${(st.advanceCut * 100).toFixed(0)}% less proceeds.`}
      </div>
    </div>
  );
}
