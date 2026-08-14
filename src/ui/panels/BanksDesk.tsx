import { useState, Fragment } from "react";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { resolveRec } from "@/engine/value";
import { lenderHealth, capitalRatio, lenderBlurb, targetCapital } from "@/engine/lenders";
import { LineChart } from "@/ui/Chart";
import { usd } from "@/ui/format";
import { bankStatement, CapSpark } from "@/ui/panels/NotesPage";

export function TheBanks() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const focus = useStore((s) => s.focus);
  const lenders = game.lenders ?? [];
  const [open, setOpen] = useState<string | null>(null);
  if (!lenders.length) return null;
  const yoursTotal = lenders.reduce((a, l) => a + l.yours, 0);
  return (
    <>
      <div className="page-section">The banks</div>
      <div className="hint">
        Every desk on this street has its own balance sheet, and when it goes wrong it goes wrong at a name, not
        at the market. Capital ratio is what they have behind the book; appetite is what is left of their advance
        rate. Below about 0.12 they stop quoting entirely — and unlike the cycle, you can watch this coming.
        {" "}<b>Click a bank to open its statement</b> — every loan on that desk, yours and the street's,
        property by property, with the funding margin and the capital history behind it.
      </div>
      {/* EVERY DESK ON ONE AXIS. The sparkline inside a statement answers
          "how is this desk"; opened one at a time it cannot answer "WHICH
          desk", which is the question refinancing actually asks. Each line is
          capital ratio over the desk's OWN target — the kinds run wildly
          different books (a conduit holds 4%, an insurer 18%), so the raw
          ratios share no scale but the multiples do. 1.0× is managed to plan;
          the examiners' patience runs out around 0.22× of target. */}
      {(() => {
        const withHist = lenders.filter((l) => (l.capHist?.length ?? 0) > 1);
        if (withHist.length < 2) return null;
        const C = ["#3d6f9e", "#a8562e", "#4a7d5a", "#7a6a45", "#8a5620", "#2f6f7a"];
        // capHist is sampled in lockstep, but a desk refounded by a receiver
        // starts its history short — right-align on the shortest so every
        // point in a vertical slice is the same quarter.
        const m = Math.min(...withHist.map((l) => l.capHist!.length));
        return (
          <>
            <LineChart height={140}
              series={withHist.map((l, i) => ({
                label: l.name, color: C[i % C.length],
                pts: l.capHist!.slice(-m).map((v) => v / targetCapital(l.name)),
              }))}
              bands={[{ at: 1, label: "own target", color: "#8b8370" }, { at: 0.22, label: "seized" }]}
              yFmt={(v) => `${v.toFixed(1)}×`}
              xLabels={[`${Math.round(m / 4)} yrs ago`, "now"]}
            />
            <div className="hint">
              {withHist.map((l, i) => (
                <span key={l.id} style={{ marginRight: 14, whiteSpace: "nowrap" }}>
                  <span style={{ display: "inline-block", width: 12, height: 3, background: C[i % C.length], verticalAlign: "middle", marginRight: 5 }} />
                  {l.name}
                </span>
              ))}
              — quarterly, as a multiple of each desk's own capital target. A line walking down toward the
              seizure band is the most readable warning in the game: refinance away from that desk while it
              still quotes.
            </div>
          </>
        );
      })()}
      <table className="tbl">
        <thead>
          <tr>
            <th>Lender</th><th>Funded by</th><th className="num">Book</th><th className="num">Capital</th>
            <th className="num">Cap ratio</th><th className="num">Income / yr</th><th className="num">Delinquent</th>
            <th className="num">Charge-offs yr</th>
            <th className="num">Appetite</th><th className="num">Your debt</th><th>Standing</th>
          </tr>
        </thead>
        <tbody>
          {lenders.map((l) => {
            const h = lenderHealth(l);
            const cr = capitalRatio(l);
            const conc = l.book > 0 ? l.yours / l.book : 0;
            return (
              <Fragment key={l.id}>
                <tr onClick={() => setOpen(open === l.id ? null : l.id)} style={{ cursor: "pointer" }}>
                  <td>{open === l.id ? "▾ " : "▸ "}{l.name}</td>
                  <td className="dim">
                    {l.kind === "bank" ? "deposits" : l.kind === "life" ? "insurance float"
                      : l.kind === "conduit" ? "selling the paper on" : "committed capital"}
                  </td>
                  <td className="num">{usd(l.book)}</td>
                  <td className={"num" + (l.capital <= 0 ? " neg" : "")}>{usd(l.capital)}</td>
                  <td className={"num" + (h.bad ? " neg" : "")}>{(cr * 100).toFixed(1)}%</td>
                  {/* WHAT THE DESK IS ACTUALLY EARNING, which the engine has
                      always computed and only ever showed inside the expanded
                      statement. It is the number that decides everything else
                      in this row: capital is last year's income, appetite is
                      this year's, and a desk earning nothing is a desk about to
                      stop quoting. Interest less funding cost less losses,
                      year to date — so it resets each January and a desk read
                      in February is showing you one month. */}
                  <td className={"num" + (l.netIncomeYr < 0 ? " neg" : "")}
                      title="Interest earned less funding cost less charge-offs, this calendar year to date. Resets each January.">
                    {l.failedM !== undefined ? "—" : usd(l.netIncomeYr)}
                  </td>
                  <td className={"num" + (l.delinquent > 0.045 ? " neg" : "")}>{(l.delinquent * 100).toFixed(2)}%</td>
                  <td className="num">{l.chargeOffsYr > 0 ? usd(l.chargeOffsYr) : "—"}</td>
                  <td className={"num" + (l.appetite < 0.5 ? " neg" : "")}>
                    {l.failedM !== undefined ? "—" : l.appetite.toFixed(2)}
                  </td>
                  <td className="num">{l.yours > 0 ? usd(l.yours) : "—"}</td>
                  <td className={h.bad ? "neg" : "dim"}>{h.word}</td>
                </tr>
                {open === l.id && (
                  <tr>
                    <td colSpan={11} className="dim" style={{ paddingBottom: 12 }}>
                      <div style={{ marginBottom: 6 }}>{lenderBlurb(l.name)}</div>
                      <div>
                        Net income this year {usd(l.netIncomeYr)} · losses since inception {usd(l.chargeOffsTotal)}
                        {l.yours > 0 && <> · you are {(conc * 100).toFixed(2)}% of their book</>}
                        {conc > 0.06 && <span className="neg"> — big enough that your problems are theirs</span>}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        {l.failedM !== undefined
                          ? "In receivership. Loans they wrote still have to be repaid; nothing new is being written, ever."
                          : l.appetite < 0.12
                            ? "Not quoting. Nothing you bring them gets underwritten until the capital comes back."
                            : l.appetite < 0.6
                              ? `Rationing — the advance rate on anything they write is about ${(100 * Math.min(1.02, 0.55 + 0.45 * l.appetite)).toFixed(0)}% of their stated sheet, and the coupon carries about ${(Math.max(0, 1 - l.appetite) * 80).toFixed(0)}bps of extra spread.`
                              : "Writing at their stated terms."}
                      </div>
                      {(() => {
                        const book = bankStatement(game, parcels, l.name);
                        const cityTotal = book.reduce((a, r) => a + r.balance, 0);
                        const target = targetCapital(l.name);
                        const nim = (l.bookYield ?? 0) - Math.max(0, l.fundCost ?? 0);
                        const byClass: Record<string, number> = {};
                        const byDistrict: Record<string, number> = {};
                        for (const r of book) {
                          byClass[r.klass] = (byClass[r.klass] ?? 0) + r.balance;
                          byDistrict[r.district] = (byDistrict[r.district] ?? 0) + r.balance;
                        }
                        const classCap = l.kind === "bank" ? 0.45 : l.kind === "life" ? 0.55 : l.kind === "conduit" ? 0.65 : 1;
                        const shares = Object.entries(byClass).sort((a, b) => b[1] - a[1]);
                        const districts = Object.entries(byDistrict).sort((a, b) => b[1] - a[1]).slice(0, 3);
                        const full = cityTotal > 40_000_000 ? shares.filter(([, v]) => classCap < 1 && v / cityTotal > classCap) : [];
                        const stranded = book.filter((r) => r.yours && h.bad && r.matM - game.month <= 60);
                        return (
                          <div style={{ marginTop: 10, paddingLeft: 12, borderLeft: "2px solid rgba(120,100,70,0.28)" }}>
                            {l.bookYield !== undefined && l.fundCost !== undefined && l.failedM === undefined && (
                              <div style={{ marginBottom: 6 }}>
                                The book earns <b className="mono">{l.bookYield.toFixed(2)}%</b> against funding at{" "}
                                <b className="mono">{Math.max(0, l.fundCost).toFixed(2)}%</b> — a{" "}
                                <b className={"mono" + (nim < 1.5 ? " neg" : "")}>{nim.toFixed(2)}pt</b> margin.{" "}
                                {nim < 1.5
                                  ? <span className="neg">The funding has repriced and the book has not. This is how a lender dies without writing a single bad loan — the advance rates go first.</span>
                                  : nim < 2.5
                                    ? "Compressed — loans written in a cheaper era against money priced in this one. They ration before it heals."
                                    : "A healthy spread; the desk earns its way out of ordinary losses."}
                                {(l.divYr ?? 0) > 0 && <span className="dim"> Paid {usd(l.divYr!)} out to the owners this year — capital above the buffer does not sit.</span>}
                              </div>
                            )}
                            {(l.capHist?.length ?? 0) > 1 && (
                              <div style={{ marginBottom: 6 }}>
                                <CapSpark hist={l.capHist} target={target} />
                                <span className="dim" style={{ marginLeft: 8 }}>
                                  capital ratio, quarterly · the dashed line is their {(target * 100).toFixed(1)}% target — a desk
                                  walking toward it is a desk to refinance away from
                                </span>
                              </div>
                            )}
                            {cityTotal > 0 && (
                              <div style={{ marginBottom: 6 }}>
                                <span className="dim">In this town: </span>
                                {shares.map(([k, v]) => `${k} ${(100 * v / cityTotal).toFixed(0)}%`).join(" · ")}
                                {districts.length > 1 && <span className="dim"> — by district {districts.map(([k, v]) => `${k} ${(100 * v / cityTotal).toFixed(0)}%`).join(", ")}</span>}
                                {full.length > 0 && (
                                  <span className="neg"> — full on {full.map(([k]) => k).join(" and ")} against their {(classCap * 100).toFixed(0)}% limit; new paper in that class is cut, whoever brings it</span>
                                )}
                              </div>
                            )}
                            {book.length > 0 && (
                              <>
                                <div style={{ margin: "8px 0 4px", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "0.82em" }}>
                                  The loan book — {book.length} loan{book.length === 1 ? "" : "s"} against deeds in this town, {usd(cityTotal)}
                                </div>
                                <table className="tbl">
                                  <thead>
                                    <tr>
                                      <th>Property</th><th>Borrower</th><th className="num">Balance</th><th className="num">Rate</th>
                                      <th className="num">Maturity</th><th className="num">LTV then → now</th><th>Standing</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {book.map((r) => {
                                      const yrs = (r.matM - game.month) / 12;
                                      return (
                                        <tr key={r.bbl} onClick={(e) => { e.stopPropagation(); focus(r.bbl, true); }}
                                          style={{ cursor: "pointer", ...(r.yours ? { background: "rgba(120,100,70,0.10)" } : {}) }}>
                                          <td>{resolveRec(parcels, game, r.bbl)?.address ?? r.bbl}{r.dev && <span className="dim"> · under construction</span>}</td>
                                          <td className={r.yours ? "" : "dim"}>{r.borrower}</td>
                                          <td className="num">{usd(r.balance)}</td>
                                          <td className="num">{r.rate > 0 ? r.rate.toFixed(2) + "%" : "—"}</td>
                                          <td className={"num" + (yrs <= 2 && !r.dev && r.yours ? " neg" : "")}>{monthLabel(r.matM)}</td>
                                          <td className="num">
                                            {r.origLtv !== null ? `${(100 * r.origLtv).toFixed(0)}%` : "—"}
                                            {" → "}
                                            {r.curLtv !== null
                                              ? <span className={r.curLtv > 1 ? "neg" : undefined}>{(100 * r.curLtv).toFixed(0)}%</span>
                                              : "—"}
                                          </td>
                                          <td className={r.bad ? "neg" : "dim"}>
                                            {r.dev ? "takeout at delivery"
                                              : r.status === "current" && yrs <= 2 ? `${Math.max(0, yrs).toFixed(1)} yrs`
                                                : r.status}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </>
                            )}
                            {l.book > cityTotal && (
                              <div className="dim" style={{ marginTop: 4 }}>
                                Plus {usd(l.book - cityTotal)} lent outside this town. The examiners see that book; you cannot —
                                the delinquency figure above is the only window into it.
                              </div>
                            )}
                            {stranded.length > 0 && (
                              <div className="alarm" style={{ marginTop: 6 }}>
                                {stranded.length === 1 ? "One balloon" : `${stranded.length} balloons`} of yours inside five years
                                at a desk that is {h.word}. A maturity here is a maturity that may not get refinanced —
                                move it while somebody else is still quoting.
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {yoursTotal > 0 && (
        <div className="hint">
          You owe {usd(yoursTotal)} across these desks. Where it sits matters as much as what it costs: a
          maturity at an impaired lender is a maturity that does not get refinanced.
        </div>
      )}
    </>
  );
}
