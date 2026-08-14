import { useState } from "react";
import { useStore } from "@/state/store";
import { CLASS_LABEL } from "@/data/types";
import { monthLabel } from "@/engine/types";
import { firmShort } from "@/engine/firm";
import { LineChart } from "@/ui/Chart";
import { compFlows, compStats } from "@/engine/comps";
import { usd } from "@/ui/format";

/**
 * WHAT HAS ACTUALLY TRADED.
 *
 * Everything else on this page is the engine telling you what it thinks. This
 * is the only panel in the game built entirely out of things that happened:
 * closed sales, the price paid, the cap rate that price implies, and the names
 * on both sides. Forming a view out of prints rather than out of a stat block
 * is most of the job, and there was no way to do it.
 */
export function CompsSheet() {
  const game = useStore((s) => s.game)!;
  const select = useStore((s) => s.select);
  const setPage = useStore((s) => s.setPage);
  const [win, setWin] = useState(60);
  const comps = game.comps ?? [];
  if (comps.length < 3) {
    return (
      <>
        <div className="page-section">Comparable sales</div>
        <div className="hint">Nothing has changed hands yet that is worth calling a comp. Come back once the market has printed a few.</div>
      </>
    );
  }
  const recent = [...comps].reverse().filter((c) => c.m >= game.month - win).slice(0, 40);
  const flows = compFlows(game, win).slice(0, 8);
  return (
    <>
      <div className="page-section">
        Comparable sales · {recent.length} in the last {win / 12} years
      </div>
      <div className="hint">
        Closed prices, not appraisals. The cap rate is the going-in yield on what the buyer actually paid — when it
        drifts down across a class, the market is repricing and your own book is worth more than the tape says.
      </div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        {[36, 60, 120, 300].map((w) => (
          <button key={w} className={"btn-mini" + (win === w ? " on" : "")} onClick={() => setWin(w)}>
            {w / 12} yr
          </button>
        ))}
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Class</th><th className="num">Trades</th><th className="num">Median cap</th>
            <th className="num">Median $/sf</th><th className="num">Volume</th><th className="num">Distressed</th>
          </tr>
        </thead>
        <tbody>
          {(["office", "retail", "multifamily", "industrial", "land"] as const).map((k) => {
            const st = compStats(game, k, win);
            return (
              <tr key={k}>
                <td>{k === "land" ? "Land" : CLASS_LABEL[k]}</td>
                {st ? (
                  <>
                    <td className="num">{st.n}</td>
                    <td className="num">{k === "land" ? "—" : `${st.medCap.toFixed(2)}%`}</td>
                    <td className="num">${st.medPsf.toFixed(0)}{k === "land" ? " lot" : ""}</td>
                    <td className="num">{usd(st.volume)}</td>
                    <td className={"num" + (st.distressShare > 0.3 ? " neg" : "")}>{(st.distressShare * 100).toFixed(0)}%</td>
                  </>
                ) : (
                  <td colSpan={5} className="dim">too few prints to call it a market</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* THE TAPE'S YARDSTICK. The table above says where the median print
          cleared; this says where the market's own asking yields have been for
          twenty years, class by class — a print is only rich or cheap AGAINST
          this line, and until now holding the line in your head meant flipping
          back to the Economy page between rows. */}
      {(() => {
        const hist = (game.econ.history ?? []).slice(-240);
        if (hist.length < 2) return null;
        const KL = ["office", "retail", "multifamily", "industrial"] as const;
        const C: Record<(typeof KL)[number], string> = { office: "#3d6f9e", retail: "#a8562e", multifamily: "#4a7d5a", industrial: "#7a6a45" };
        return (
          <>
            <div className="page-section" style={{ marginTop: 14 }}>Cap rates — twenty years, by class</div>
            <LineChart height={132}
              series={KL.map((k) => ({ label: CLASS_LABEL[k], color: C[k], pts: hist.map((h) => h.cap?.[k] ?? game.econ.capRate[k]) }))}
              yFmt={(v) => `${v.toFixed(1)}%`}
              xLabels={[monthLabel(hist[0].q), monthLabel(hist[hist.length - 1].q)]}
            />
            <div className="hint">
              {KL.map((k) => (
                <span key={k} style={{ marginRight: 14, whiteSpace: "nowrap" }}>
                  <span style={{ display: "inline-block", width: 12, height: 3, background: C[k], verticalAlign: "middle", marginRight: 5 }} />
                  {CLASS_LABEL[k]}
                </span>
              ))}
              — a print well above its line bought a problem or a bargain; below it, somebody paid up. When a
              whole line drifts down, the market is repricing and your own book is worth more than the tape
              says yet.
            </div>
          </>
        );
      })()}

      {/* WHO IS DOING WHAT. A shop that has bought nine buildings in eighteen
          months is levering into the top, and you can watch them do it. */}
      {flows.length > 0 && (
        <>
          <div className="page-section" style={{ marginTop: 14 }}>Who has been active</div>
          <table className="tbl">
            <thead>
              <tr><th>Firm</th><th className="num">Bought</th><th className="num">Sold</th><th className="num">Net</th><th>Read</th></tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.name} className={f.name === firmShort(game) ? "row-me" : ""}>
                  <td>{f.name}</td>
                  <td className="num">{f.boughtN ? `${f.boughtN} · ${usd(f.bought)}` : "—"}</td>
                  <td className="num">{f.soldN ? `${f.soldN} · ${usd(f.sold)}` : "—"}</td>
                  <td className={"num" + (f.net < 0 ? " neg" : "")}>{f.net >= 0 ? "+" : "−"}{usd(Math.abs(f.net))}</td>
                  <td className="dim">
                    {f.boughtN >= 4 && f.net > 0 ? "Buying hard. They are the bid you are up against."
                      : f.soldN >= 3 && f.net < 0 ? "Getting out. Ask why before you buy what they are selling."
                      : f.net > 0 ? "Net buyer" : f.net < 0 ? "Net seller" : "Even"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="page-section" style={{ marginTop: 14 }}>Recent prints</div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Closed</th><th>Property</th><th>Class</th><th className="num">Price</th>
              <th className="num">$/sf</th><th className="num">Cap</th><th>Buyer</th><th>Seller</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((c, i) => (
              <tr key={c.bbl + c.m + i} className={c.distress ? "dim" : ""}
                style={{ cursor: "pointer" }}
                onClick={() => { setPage("none"); select(c.bbl); }}>
                <td className="mono">{monthLabel(c.m)}</td>
                <td>{c.address}{c.distress ? " · distressed" : ""}</td>
                <td className="dim">{CLASS_LABEL[c.cls as keyof typeof CLASS_LABEL] ?? c.cls}</td>
                <td className="num">{usd(c.price)}</td>
                <td className="num">{c.sf > 0 ? `$${c.psf.toFixed(0)}` : `$${c.psf.toFixed(0)} land`}</td>
                <td className="num">{c.capRate > 0 ? `${c.capRate.toFixed(2)}%` : "—"}</td>
                <td className={c.buyer === firmShort(game) ? "" : "dim"}>{c.buyer}</td>
                <td className={c.seller === firmShort(game) ? "" : "dim"}>{c.seller}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
