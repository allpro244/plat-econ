import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { fundRaiseQuote, fundCanBuy, FUND_PREF, FUND_PROMOTE } from "@/engine/fund";
import { usd } from "@/ui/format";
import { Big, Row } from "@/ui/panels/shared";

/**
 * THE FUND — optional second cash account. Balance-sheet path stays default;
 * this panel is how you raise, call, distribute, and choose which purse buys.
 */
export function FundDesk() {
  const game = useStore((s) => s.game)!;
  const { raiseFund, callFundCapital, distributeFund, setFundPay } = useStore.getState();
  const q = fundRaiseQuote(game);
  const f = game.fund;
  const live = f && !f.settled;
  const fundDeeds = Object.values(game.holdings).filter((h) => h.fundOwned).length;
  if (!live && !game.fundFailedM && !q.ok && (game.exits ?? []).length < 2) {
    // Quiet until the player has something to show LPs — empty chrome is noise.
    return null;
  }
  return (
    <div className="page-section">
      <div className="page-section-head">The fund</div>
      {game.fundFailedM !== undefined && (
        <div className="hint" style={{ color: "var(--neg, #a33)" }}>
          Nobody will back you again. The last vehicle did not return capital
          ({monthLabel(game.fundFailedM)}). Succession clears the name; nothing else does.
        </div>
      )}
      {live && f ? (
        <>
          <div className="stat-strip">
            <Big label="Vehicle cash" value={usd(f.cash)} />
            <Big label="Called" value={usd(f.called)} />
            <Big label="Uncalled" value={usd(f.uncalled)} />
            <Big label="Distributed" value={usd(f.distributed)} />
            <Big label="Promote paid" value={usd(f.promotePaid)} />
            <Big label="Pref accrued" value={usd(f.prefAccrued)} bad={f.prefAccrued > 0} />
          </div>
          <div className="grid">
            <Row k="Vintage" v={`${monthLabel(f.raisedM)} · $${(f.size / 1e6).toFixed(0)}M`} />
            <Row k="Investment period" v={`ends ${monthLabel(f.investEndM)}${fundCanBuy(game) ? "" : " · closed"}`} />
            <Row k="Fund life" v={`ends ${monthLabel(f.lifeEndM)}`} />
            <Row k="Waterfall" v={`${(FUND_PREF * 100).toFixed(0)}% pref · ${(FUND_PROMOTE * 100).toFixed(0)}% promote`} />
            <Row k="Vehicle deeds" v={`${fundDeeds}`} />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={f.uncalled <= 0}
              onClick={() => callFundCapital(Math.round(f.uncalled * 0.5))}>
              Call half uncalled
            </button>
            <button className="btn" disabled={f.uncalled <= 0}
              onClick={() => callFundCapital(f.uncalled)}>
              Call remainder
            </button>
            <button className="btn" disabled={f.cash < 100_000}
              onClick={() => distributeFund(Math.round(f.cash * 0.5))}>
              Distribute half cash
            </button>
            <button className="btn" disabled={f.cash <= 0}
              onClick={() => distributeFund(f.cash)}>
              Distribute all cash
            </button>
          </div>
          <div className="btn-row">
            <button className={"btn" + (game.fundPay ? " btn-on" : "")}
              disabled={!fundCanBuy(game) && !game.fundPay}
              onClick={() => setFundPay(!game.fundPay)}>
              {game.fundPay ? "Buying from the vehicle" : "Buy from the vehicle"}
            </button>
          </div>
          <div className="hint">
            Vehicle cash is not yours. NOI and sale proceeds on fund deeds stay in the vehicle;
            the promote only crystallises once the pref is current. Miss returning capital and the street closes.
          </div>
        </>
      ) : (
        <>
          <div className="hint">{q.reason}</div>
          <div className="btn-row">
            <button className="btn btn-buy" disabled={!q.ok} onClick={() => raiseFund()}>
              {q.ok ? `Raise $${(q.size / 1e6).toFixed(0)}M` : "Cannot raise"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
