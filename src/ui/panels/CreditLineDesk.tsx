import { useState } from "react";
import Slider from "@/ui/Slider";
import { useStore } from "@/state/store";
import { netWorth } from "@/engine/value";
import { locLimit, locRate } from "@/engine/credit";
import { usd, pct } from "@/ui/format";
import { Big } from "@/ui/panels/shared";
import { SponsorRecord } from "@/ui/panels/SponsorRecord";

// The revolving line: up to 35% of net worth at prime + 400bps, and the
// advance rate moves with the credit cycle — the label used to promise a
// fixed 35% while the engine was quietly cutting it in a crunch. It draws
// before a shortfall becomes insolvency, and idle cash sweeps against it.
export function CreditLine() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const { drawCredit, repayCredit } = useStore.getState();
  const limit = locLimit(game, parcels);
  const nw = netWorth(game, parcels);
  const balance = game.loc?.balance ?? 0;
  const avail = Math.max(0, limit - balance);
  const rate = locRate(game);
  const [amt, setAmt] = useState(0);
  const room = Math.max(avail, balance);
  return (
    <div className="page-section">
      <div className="page-section-head">Line of credit</div>
      <div className="stat-strip">
        {(() => {
          const adv = nw > 0 ? limit / nw : 0.35;
          return (
            <Big
              label={`Limit · ${(adv * 100).toFixed(0)}% of net worth`}
              value={usd(limit)}
              bad={adv < 0.3}
            />
          );
        })()}
        <Big label="Drawn" value={usd(balance)} bad={balance > limit * 0.8} />
        <Big label="Available" value={usd(avail)} />
        <Big label="Rate · index + 400" value={pct(rate)} />
        <Big label="Interest paid" value={usd(game.loc?.interestPaid ?? 0)} />
      </div>
      <SponsorRecord />
      {room > 0 ? (
        <>
          <Slider
            label="Amount"
            value={Math.min(amt, room)}
            min={0}
            max={Math.max(1, room)}
            step={Math.max(10_000, Math.round(room / 200))}
            onChange={setAmt}
            format={(v) => usd(v)}
            marks={[
              { at: Math.round(room * 0.25), label: "¼" },
              { at: Math.round(room * 0.5), label: "½" },
              { at: room, label: "all" },
            ]}
            hint={`Costs ${usd((Math.min(amt, room) * rate) / 100 / 12)} a month in interest while it's out.`}
          />
          <div className="btn-row">
            <button className="btn btn-buy" disabled={amt <= 0 || amt > avail} onClick={() => drawCredit(amt)}>
              Draw {usd(Math.min(amt, avail))}
            </button>
            <button className="btn" disabled={balance <= 0 || amt <= 0} onClick={() => repayCredit(amt)}>
              Repay {usd(Math.min(amt, balance))}
            </button>
          </div>
        </>
      ) : (
        <div className="hint">Build some net worth and the bank will open a line against it.</div>
      )}
      <div className="hint">
        The line covers a shortfall automatically before it can sink the run. Idle cash above $250K pays it back down
        the same month — and the moment a sale, refinance or portfolio close puts cash in the account.
      </div>
    </div>
  );
}
