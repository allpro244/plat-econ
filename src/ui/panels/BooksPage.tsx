import { useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel, START_YEAR } from "@/engine/types";
import type { BooksYear } from "@/engine/types";
import { MILESTONES } from "@/engine/sim";
import { depositsHeld } from "@/engine/leasing";
import { ownedHoldingValue, resolveRec } from "@/engine/value";
import {
  balanceSnapshotView, buildBalanceSheet, booksMonthAsYear,
  type BalanceSheetView,
} from "@/engine/books";
import { taxAppealQuote } from "@/engine/tax";
import { compFlows } from "@/engine/comps";
import { usd, pct } from "@/ui/format";
import { NWChart, Big } from "@/ui/panels/shared";

type BooksTab = "balance" | "income";

export function BooksPage() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const focus = useStore((s) => s.focus);
  const setPage = useStore((s) => s.setPage);
  const select = useStore((s) => s.select);
  const [tab, setTab] = useState<BooksTab>("balance");
  const nw = game.nwHistory[game.nwHistory.length - 1] ?? 0;
  const realized = game.exits.reduce((a, e) => a + e.gain, 0);
  const exits = [...(game.exits ?? [])].reverse().slice(0, 12);
  const achieved = MILESTONES.filter((m) => game.milestones?.[m.id] !== undefined);
  const pending = MILESTONES.filter((m) => game.milestones?.[m.id] === undefined);
  const holdings = Object.values(game.holdings).filter((h) => !game.merged?.[h.bbl]);
  const pendingAppeals = holdings.flatMap((h) => {
    const rec = resolveRec(parcels, game, h.bbl);
    return h.taxAppeal && rec ? [{ bbl: h.bbl, address: rec.address, appeal: h.taxAppeal }] : [];
  });
  const appealable = holdings.flatMap((h) => {
    const q = taxAppealQuote(game, parcels, h.bbl);
    const rec = resolveRec(parcels, game, h.bbl);
    return q && rec ? [{ bbl: h.bbl, address: rec.address, ...q }] : [];
  }).sort((a, b) => b.annualSavings - a.annualSavings);
  const goProperty = (bbl: string) => { select(bbl); focus(bbl); setPage("property"); };
  return (
    <div>
      <div className="stat-strip">
        <Big label="Net worth" value={usd(nw)} bad={nw < 0} />
        <Big label="Cash" value={usd(game.cash)} bad={game.cash < 0} />
        {depositsHeld(game) > 0 && (
          <Big label="Deposits held" value={"−" + usd(depositsHeld(game))} />
        )}
        <Big label="Realized gains" value={usd(realized)} bad={realized < 0} />
        <Big label="Taxes paid, lifetime" value={usd(game.taxesPaid ?? 0)} />
        <Big label="Exits" value={String(game.exits.length)} />
      </div>
      <NWChart data={game.nwHistory} />

      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className={"btn" + (tab === "balance" ? " btn-on" : "")} onClick={() => setTab("balance")}>
          Balance sheet
        </button>
        <button className={"btn" + (tab === "income" ? " btn-on" : "")} onClick={() => setTab("income")}>
          Income statement
        </button>
        <button className="btn" onClick={() => useStore.getState().setPage("staff")}
          title="Property management, leasing and construction — capacity, the shortlist, and what the slip is costing you">
          The desk · {(game.staff ?? []).length} on the payroll →
        </button>
      </div>

      {tab === "balance" ? <BalanceSheet /> : <IncomeStatementTab />}

      {(pendingAppeals.length > 0 || appealable.length > 0) && (
        <div className="page-section">
          <div className="page-section-head">Property-tax desk</div>
          {pendingAppeals.length > 0 && (
            <div className="mini-list" style={{ marginBottom: 10 }}>
              {pendingAppeals.map(({ bbl, address, appeal }) => (
                <button key={bbl} className="neighbor" onClick={() => goProperty(bbl)}>
                  <span className="neighbor-addr">{address}</span>
                  <span className="neighbor-meta mono">
                    Board sits {monthLabel(appeal.decideM)} · {(appeal.odds * 100).toFixed(0)}% as filed
                  </span>
                </button>
              ))}
            </div>
          )}
          {appealable.length > 0 && (
            <>
              <div className="hint">
                {appealable.length} building{appealable.length === 1 ? "" : "s"} carry assessments materially above today&apos;s market evidence.
              </div>
              <div className="mini-list">
                {appealable.slice(0, 4).map((a) => (
                  <button key={a.bbl} className="neighbor" onClick={() => goProperty(a.bbl)}>
                    <span className="neighbor-addr">{a.address}</span>
                    <span className="neighbor-meta mono">
                      {usd(a.annualSavings)} / yr potential saving · file for {usd(a.fee)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="page-section">
        <div className="page-section-head">The wire</div>
        <div className="hint">Market and firm news now lives on its own desk — the last {(game.news ?? []).length} items, filterable by kind.</div>
        <button className="btn" onClick={() => setPage("news")}>Open News →</button>
      </div>

      {(() => {
        const peak = Math.max(0, ...(game.nwHistory ?? [0]));
        const peakAt = (game.nwHistory ?? []).lastIndexOf(peak);
        const flows = compFlows(game, 120).slice(0, 5);
        const failed = (game.rivals ?? [])
          .filter((r) => r.failedM !== undefined)
          .sort((a, b) => (b.failedM ?? 0) - (a.failedM ?? 0))
          .slice(0, 4);
        const decadePrints = [...(game.comps ?? [])]
          .filter((c) => c.sf > 0)
          .sort((a, b) => b.price - a.price)
          .slice(0, 3);
        if (!flows.length && !failed.length && !decadePrints.length && peak <= 0) return null;
        return (
          <div className="page-section">
            <div className="page-section-head">City census</div>
            <div className="hint">
              Who has been buying, who failed, and where your firm peaked — the campaign read that used to be scattered across Research and the game-over screen.
            </div>
            {peak > 0 && (
              <div className="mini-list" style={{ marginBottom: 8 }}>
                <div className="mini-row" style={{ cursor: "default" }}>
                  <span>Firm peak net worth</span>
                  <span className="mono">{usd(peak)}{peakAt >= 0 ? ` · ${monthLabel(peakAt)}` : ""}</span>
                </div>
                <div className="mini-row" style={{ cursor: "default" }}>
                  <span>Now</span>
                  <span className={"mono" + (nw < peak * 0.7 ? " neg" : "")}>{usd(nw)}</span>
                </div>
              </div>
            )}
            {decadePrints.length > 0 && (
              <div className="mini-list" style={{ marginBottom: 8 }}>
                {decadePrints.map((c) => (
                  <div key={`${c.m}:${c.bbl}`} className="mini-row" style={{ cursor: "default" }}>
                    <span>{c.address} · {c.buyer}</span>
                    <span className="mono">{usd(c.price)} · {monthLabel(c.m)}</span>
                  </div>
                ))}
              </div>
            )}
            {flows.length > 0 && (
              <div className="mini-list" style={{ marginBottom: 8 }}>
                {flows.map((f) => (
                  <div key={f.name} className="mini-row" style={{ cursor: "default" }}>
                    <span>{f.name}</span>
                    <span className="mono">
                      bought {usd(f.bought)} · sold {usd(f.sold)} · net {f.net >= 0 ? "+" : "−"}{usd(Math.abs(f.net))}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {failed.length > 0 && (
              <div className="mini-list">
                {failed.map((r) => (
                  <div key={r.id} className="mini-row" style={{ cursor: "default" }}>
                    <span>Failed · {r.name}</span>
                    <span className="mono">{monthLabel(r.failedM!)}</span>
                  </div>
                ))}
              </div>
            )}
            <button className="btn" onClick={() => setPage("research")}>Open Research for the full prints →</button>
          </div>
        );
      })()}

      <div className="deals-grid">
        <section className="page-section">
          <div className="page-section-head">Dispositions</div>
          <div className="mini-list">
            {exits.map((e, i) => (
              <div key={i} className="mini-row" style={{ cursor: "default" }}>
                <span>{e.forced ? "⚠ " : ""}{e.address}</span>
                <span className="mono">
                  {usd(e.price)} · {e.gain >= 0 ? "+" : "−"}{usd(Math.abs(e.gain))} · held {((e.soldM - e.boughtM) / 12).toFixed(1)} yrs
                </span>
              </div>
            ))}
            {!exits.length && <div className="hint">No sales yet. The first exit is the education.</div>}
          </div>
        </section>
        <section className="page-section">
          <div className="page-section-head">Milestones · {achieved.length} of {MILESTONES.length}</div>
          <div className="mini-list">
            {achieved.map((m) => (
              <div key={m.id} className="mini-row" style={{ cursor: "default" }}>
                <span>◆ {m.label}</span>
                <span className="mono">{monthLabel(game.milestones[m.id])}</span>
              </div>
            ))}
            {pending.slice(0, 4).map((m) => (
              <div key={m.id} className="mini-row mini-dim" style={{ cursor: "default" }}>
                <span>◇ {m.label}</span>
                <span className="mono dim">—</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/** One statement line: label, amount, optional note. */
function Row({ k, v, sub, strong, rule, note, bad }: {
  k: string; v: number; sub?: boolean; strong?: boolean; rule?: boolean; note?: string; bad?: boolean;
}) {
  const neg = bad ?? v < 0;
  return (
    <tr className={rule ? "is-rule" : undefined}>
      <td style={{ paddingLeft: sub ? 22 : 0, fontWeight: strong ? 600 : undefined }}>
        {k}{note && <span className="dim" style={{ fontWeight: 400 }}> · {note}</span>}
      </td>
      <td className={"num" + (neg ? " neg" : "") + (strong ? " is-strong" : "")}>
        {v === 0 ? "—" : (v < 0 ? "(" : "") + usd(Math.abs(v)) + (v < 0 ? ")" : "")}
      </td>
    </tr>
  );
}

/**
 * BALANCE SHEET — what you own, what you owe, what is left.
 *
 * Built from the same `netWorth` / `holdingValue` the rest of the engine reads,
 * so the Books page cannot disagree with the TopBar or the lender's sizing.
 * December of each year is frozen so you can reopen last year's close.
 */
function BalanceSheet() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const focus = useStore((s) => s.focus);
  const history = game.balanceHistory ?? [];
  // Prior calendar year only — the December you just closed while still in
  // that December is "today", not last year.
  const curYr = Math.floor(game.month / 12);
  const lastYear = [...history].reverse().find((b) => Math.floor(b.m / 12) < curYr) ?? null;
  const [view, setView] = useState<"today" | "yearEnd">("today");

  const live = useMemo(() => buildBalanceSheet(game, parcels), [game, parcels]);
  const sheet: BalanceSheetView = view === "yearEnd" && lastYear
    ? balanceSnapshotView(lastYear)
    : live;
  const holdings = Object.values(game.holdings);
  const showingHistory = sheet.historical;

  return (
    <div>
      <div className="page-section">
        <div className="page-section-head">
          Balance sheet · {showingHistory ? `year-end ${monthLabel(sheet.m)}` : monthLabel(game.month)}
        </div>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className={"btn btn-sm" + (view === "today" ? " btn-on" : "")}
            onClick={() => setView("today")}
          >
            Today
          </button>
          <button
            type="button"
            className={"btn btn-sm" + (view === "yearEnd" ? " btn-on" : "")}
            disabled={!lastYear}
            title={lastYear
              ? `Frozen marks from ${monthLabel(lastYear.m)}`
              : "Closes every December — advance through your first year-end to unlock."}
            onClick={() => lastYear && setView("yearEnd")}
          >
            {lastYear ? `Last year-end · ${monthLabel(lastYear.m)}` : "Last year-end"}
          </button>
        </div>
        <div className="hint">
          {showingHistory
            ? `A December close — the same marks the TopBar used that month, frozen. Holdings detail below is today's book; only the summary sheet travels with the year-end stamp.`
            : `Assets at the same values the TopBar, the lender and the desk use — not a second set of books. Engine net worth is ${usd(sheet.nwEngine)}; the equity line below is assets minus liabilities from the same marks.`}
        </div>
        <BalanceSheetTables sheet={sheet} />
        {sheet.propGross > 0 && (
          <div className="hint">
            Loan-to-value on the real-estate book: {((sheet.mortgages / sheet.propGross) * 100).toFixed(0)}%
            {sheet.locBal > 0 ? ` · Line is ${((sheet.locBal / Math.max(1, sheet.locLim)) * 100).toFixed(0)}% drawn` : ""}.
            {!showingHistory && " Draw and repay the line on Debt."}
          </div>
        )}
      </div>

      {!showingHistory && sheet.cipN > 0 && (
        <div className="page-section">
          <div className="page-section-head">Construction in progress · {sheet.cipN} job{sheet.cipN === 1 ? "" : "s"}</div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Use</th>
                  <th className="num">Sunk</th>
                  <th className="num">Loan bal</th>
                  <th className="num">Budget</th>
                  <th className="num">Drawn / commit</th>
                  <th className="num">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(game.developments ?? {}).map((d) => {
                  const rec = resolveRec(parcels, game, d.bbl);
                  const sunk = Math.max(0, (d.equitySpent ?? 0) + (d.drawn ?? 0) - (d.reserveUsed ?? 0));
                  return (
                    <tr key={d.bbl} style={{ cursor: "pointer" }} onClick={() => focus(d.bbl, true)}>
                      <td>{rec?.address ?? d.bbl}</td>
                      <td className="dim">{d.use}</td>
                      <td className="num">{usd(sunk)}</td>
                      <td className="num">{d.loanBalance ? usd(d.loanBalance) : "—"}</td>
                      <td className="num dim">{usd(d.costTotal)}</td>
                      <td className="num dim">{usd(d.drawn)} / {usd(d.commitment)}</td>
                      <td className="num dim">{monthLabel(d.deliverM)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!showingHistory && (
        <div className="page-section">
          <div className="page-section-head">Holdings detail · {holdings.length} deed{holdings.length === 1 ? "" : "s"}</div>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Class</th>
                  <th className="num">Value</th>
                  <th className="num">Debt</th>
                  <th className="num">Equity</th>
                  <th className="num">LTV</th>
                  <th className="num">Basis</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const rec = resolveRec(parcels, game, h.bbl);
                  if (!rec) return null;
                  const v = ownedHoldingValue(game, parcels, h);
                  const debt = h.loan?.balance ?? 0;
                  const eq = v - debt;
                  const ltv = v > 0 ? debt / v : 0;
                  return (
                    <tr key={h.bbl} style={{ cursor: "pointer" }} onClick={() => focus(h.bbl, true)}>
                      <td>{rec.address ?? h.bbl}</td>
                      <td className="dim">{rec.class}</td>
                      <td className="num">{usd(v)}</td>
                      <td className="num">{debt ? usd(debt) : "—"}</td>
                      <td className={"num" + (eq < 0 ? " neg" : "")}>{usd(eq)}</td>
                      <td className={"num" + (ltv > 0.75 ? " neg" : "")}>{debt ? (ltv * 100).toFixed(0) + "%" : "—"}</td>
                      <td className="num dim">{usd(h.costBasis ?? 0)}</td>
                    </tr>
                  );
                })}
                {!holdings.length && (
                  <tr><td colSpan={7} className="dim">No deeds yet — the balance sheet is cash and whatever the line says.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function BalanceSheetTables({ sheet }: { sheet: BalanceSheetView }) {
  return (
    <>
      <table className="tbl tbl-stmt">
        <thead>
          <tr><th>Assets</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          <Row k="Cash" v={sheet.cash} note={sheet.cash < 0 ? "overdrawn — the line should have covered this" : "operating account"} bad={sheet.cash < 0} />
          <Row k="Real estate — gross value" v={sheet.propGross} note={`${sheet.bldgCount} building${sheet.bldgCount === 1 ? "" : "s"}, ${sheet.landCount} land parcel${sheet.landCount === 1 ? "" : "s"}`} />
          {Object.entries(sheet.byClass).sort((a, b) => b[1].gross - a[1].gross).map(([cls, x]) => (
            <Row key={cls} k={cls === "land" ? " Land / sites" : ` ${cls}`} v={x.gross} sub note={`${x.n} deed${x.n === 1 ? "" : "s"} · ${usd(x.debt)} mortgaged`} />
          ))}
          {sheet.cipN > 0 && (
            <Row k="Construction in progress" v={sheet.cip} note={`${sheet.cipN} job${sheet.cipN === 1 ? "" : "s"} — money sunk, not the full budget`} />
          )}
          {sheet.noteCount > 0 && (
            <Row k="Notes receivable" v={sheet.notesVal} note={`${sheet.noteCount} note${sheet.noteCount === 1 ? "" : "s"} · lower of cost and collateral`} />
          )}
          <Row k="Total assets" v={sheet.totalAssets} strong rule />
        </tbody>
      </table>
      <table className="tbl tbl-stmt" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Liabilities</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          <Row k="Mortgages" v={sheet.mortgages} note="secured by individual deeds" bad={sheet.mortgages > sheet.propGross * 0.85} />
          {sheet.cipDebt > 0 && <Row k="Construction loans" v={sheet.cipDebt} sub />}
          {sheet.facility > 0 && <Row k="Cross-collateral facility" v={sheet.facility} note="one loan, many deeds" bad />}
          <Row k="Line of credit drawn" v={sheet.locBal} note={`limit ${usd(sheet.locLim)} · ${pct(sheet.rate)}`} bad={sheet.locBal > 0} />
          {sheet.deposits > 0 && (
            <Row k="Tenant deposits held" v={sheet.deposits} note="not yours — due when they leave" />
          )}
          <Row k="Total liabilities" v={sheet.totalLiab} strong rule />
          <Row k="Equity (assets − liabilities)" v={sheet.equity} strong rule bad={sheet.equity < 0} />
        </tbody>
      </table>
    </>
  );
}

function IncomeStatementTab() {
  const years = [...(useStore((s) => s.game)!.books ?? [])].reverse().slice(0, 15);
  return (
    <div>
      <IncomeStatement />
      <div className="page-section">
        <div className="page-section-head">The ledger, by year — every line, side by side</div>
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Year</th><th className="num">NOI</th><th className="num">Bank interest</th><th className="num">Borrowed</th><th className="num">Debt svc</th><th className="num">Leasing</th>
                <th className="num">Capex</th><th className="num">G&amp;A</th><th className="num">Development</th><th className="num">Taxes</th>
                <th className="num">Acquisitions</th><th className="num">Dispositions</th><th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {years.map((b) => {
                const net = b.noi + (b.interest ?? 0) + (b.borrowed ?? 0) - b.debtSvc - b.leasing - b.capex - (b.ga ?? 0) - b.dev - b.taxes - b.bought + b.sold;
                return (
                  <tr key={b.yr} style={{ cursor: "default" }}>
                    <td className="mono">{START_YEAR + b.yr}</td>
                    <td className="num">{usd(b.noi)}</td>
                    <td className="num dim" title="1.0% a year on positive cash balances">{b.interest ? usd(b.interest) : "—"}</td>
                    <td className="num dim" title="Cash-out refinance and facility draws">{b.borrowed ? usd(b.borrowed) : "—"}</td>
                    <td className="num">{b.debtSvc ? "−" + usd(b.debtSvc) : "—"}</td>
                    <td className="num">{b.leasing ? "−" + usd(b.leasing) : "—"}</td>
                    <td className="num">{b.capex ? "−" + usd(b.capex) : "—"}</td>
                    <td className="num">{b.ga ? "−" + usd(b.ga) : "—"}</td>
                    <td className="num">{b.dev ? "−" + usd(b.dev) : "—"}</td>
                    <td className="num">{b.taxes ? "−" + usd(b.taxes) : "—"}</td>
                    <td className="num">{b.bought ? "−" + usd(b.bought) : "—"}</td>
                    <td className="num">{b.sold ? usd(b.sold) : "—"}</td>
                    <td className={"num" + (net < 0 ? " neg" : "")}>{usd(net)}</td>
                  </tr>
                );
              })}
              {!years.length && <tr><td colSpan={13} className="dim">Nothing on the books yet — advance a month.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * THE INCOME STATEMENT.
 *
 * The ledger below this is a fine spreadsheet and a bad statement: twelve
 * columns wide, operating flows sitting next to investing flows, no subtotals,
 * and no way to answer the two questions anybody actually asks — did the
 * BUILDINGS make money this year, and did the FIRM?
 *
 * Period toggle: yearly is the firm year; monthly is the same buckets for one
 * month, so a loud December does not hide inside a quiet year.
 */
export function IncomeStatement() {
  const game = useStore((s) => s.game)!;
  const books = game.books ?? [];
  const months = game.booksMonthly ?? [];
  const [period, setPeriod] = useState<"year" | "month">("year");
  const [yr, setYr] = useState<number | null>(null);
  const [mo, setMo] = useState<number | null>(null);

  if (!books.length && !months.length) {
    return (
      <div className="page-section">
        <div className="page-section-head">Income statement</div>
        <div className="hint">Nothing on the books yet — advance a month and the year opens.</div>
      </div>
    );
  }

  const yearCur = books.find((b) => b.yr === yr) ?? books[books.length - 1];
  const yearPrior = yearCur ? books.find((b) => b.yr === yearCur.yr - 1) : undefined;
  const monthCur = months.find((b) => b.m === mo) ?? months[months.length - 1];
  // Prior month may have aged out of the keep window — fine; the vs column blanks.
  const priorMonth = monthCur
    ? [...months].reverse().find((b) => b.m < monthCur.m)
    : undefined;

  const usingMonth = period === "month" && !!monthCur;
  const cur: BooksYear | undefined = usingMonth
    ? booksMonthAsYear(monthCur)
    : yearCur;
  const prior: BooksYear | undefined = usingMonth
    ? (priorMonth ? booksMonthAsYear(priorMonth) : undefined)
    : yearPrior;
  const partial = !usingMonth && !!yearCur
    && yearCur.yr === Math.floor(game.month / 12) && game.month % 12 !== 0;
  const monthsIn = partial ? game.month % 12 : 12;
  const headLabel = usingMonth && monthCur
    ? monthLabel(monthCur.m)
    : yearCur
      ? `${START_YEAR + yearCur.yr}${partial ? ` · ${monthsIn} month${monthsIn === 1 ? "" : "s"} in, not a full year` : ""}`
      : "—";
  const vsLabel = usingMonth
    ? (priorMonth ? monthLabel(priorMonth.m) : "—")
    : (yearPrior ? String(START_YEAR + yearPrior.yr) : "—");

  const opCf = (b: BooksYear) => b.noi - b.leasing - b.capex - b.ga;
  const afterDebt = (b: BooksYear) => opCf(b) - b.debtSvc + (b.interest ?? 0) + (b.borrowed ?? 0);
  const investing = (b: BooksYear) => b.sold - b.bought - b.dev;
  const bottom = (b: BooksYear) => afterDebt(b) + investing(b) - b.taxes;

  const L = ({ k, v, sub, strong, rule, note }: {
    k: string; v: number; sub?: boolean; strong?: boolean; rule?: boolean; note?: string;
  }) => (
    <tr className={rule ? "is-rule" : undefined}>
      <td style={{ paddingLeft: sub ? 22 : 0, fontWeight: strong ? 600 : undefined }}>
        {k}{note && <span className="dim" style={{ fontWeight: 400 }}> · {note}</span>}
      </td>
      <td className={"num" + (v < 0 ? " neg" : "") + (strong ? " is-strong" : "")}>
        {v === 0 ? "—" : (v < 0 ? "(" : "") + usd(Math.abs(v)) + (v < 0 ? ")" : "")}
      </td>
      <td className="num dim">
        {prior ? (() => {
          const pv = ({
            "Net operating income": prior.noi, "Leasing costs": -prior.leasing,
            "Capital expenditure": -prior.capex, "Firm overhead": -prior.ga,
            "Property cash flow": opCf(prior), "Debt service": -prior.debtSvc,
            "Interest on cash": prior.interest ?? 0, "Debt drawn": prior.borrowed ?? 0, "Cash flow after debt": afterDebt(prior),
            "Development": -prior.dev, "Acquisitions": -prior.bought,
            "Disposition proceeds": prior.sold, "Taxes": -prior.taxes,
            "Change in cash": bottom(prior),
          } as Record<string, number>)[k];
          if (pv === undefined) return "";
          if (pv === 0) return v === 0 ? "" : "new";
          const d = (v - pv) / Math.abs(pv);
          return (d >= 0 ? "+" : "") + (d * 100).toFixed(0) + "%";
        })() : ""}
      </td>
    </tr>
  );

  const recentMonths = months.slice(-12);

  return (
    <div className="page-section">
      <div className="page-section-head">Income statement · {headLabel}</div>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className={"btn btn-sm" + (period === "year" ? " btn-on" : "")}
          onClick={() => setPeriod("year")}
        >
          Yearly
        </button>
        <button
          type="button"
          className={"btn btn-sm" + (period === "month" ? " btn-on" : "")}
          disabled={!months.length}
          title={months.length ? "Same buckets, one month at a time" : "Advance a month to open the monthly ledger"}
          onClick={() => months.length && setPeriod("month")}
        >
          Monthly
        </button>
      </div>
      <div className="hint">
        The buildings and the firm are two different businesses. Everything above <em>property cash flow</em> is
        what the portfolio produced; everything below it is what you did with the money.
        {usingMonth
          ? " This is one month's cash movement — not a twelfth of the year."
          : " A year with a terrible bottom line and a strong property line is a year you spent building — which is the good kind of terrible."}
      </div>
      <div className="btn-row">
        {period === "year"
          ? books.slice(-8).map((b) => (
            <button key={b.yr} className={"btn btn-sm" + (yearCur && b.yr === yearCur.yr ? " btn-on" : "")} onClick={() => setYr(b.yr)}>
              {START_YEAR + b.yr}
            </button>
          ))
          : recentMonths.map((b) => (
            <button
              key={b.m}
              className={"btn btn-sm" + (monthCur && b.m === monthCur.m ? " btn-on" : "")}
              onClick={() => setMo(b.m)}
            >
              {monthLabel(b.m)}
            </button>
          ))}
      </div>
      {!cur ? (
        <div className="hint">Nothing on the books for this period yet.</div>
      ) : (
        <>
          <table className="tbl tbl-stmt">
            <thead>
              <tr><th>{headLabel}</th><th className="num">Amount</th><th className="num">vs {vsLabel}</th></tr>
            </thead>
            <tbody>
              <L k="Net operating income" v={cur.noi} note="rent collected, less operating costs and property tax" />
              <L k="Leasing costs" v={-cur.leasing} sub note="fit-out and commissions" />
              <L k="Capital expenditure" v={-cur.capex} sub note="roofs, systems, make-ready" />
              <L k="Firm overhead" v={-cur.ga} sub note="asset management, accounting, legal" />
              <L k="Property cash flow" v={opCf(cur)} strong rule />
              <L k="Debt service" v={-cur.debtSvc} sub note="interest, amortisation, fees, voluntary paydowns" />
              <L k="Interest on cash" v={cur.interest ?? 0} sub note="1.0% on idle balances" />
              <L k="Debt drawn" v={cur.borrowed ?? 0} sub note="cash-out refinance and facility draws" />
              <L k="Cash flow after debt" v={afterDebt(cur)} strong rule />
              <L k="Development" v={-cur.dev} sub note="equity into the ground, construction carry, overruns" />
              <L k="Acquisitions" v={-cur.bought} sub note="equity out the door at closing" />
              <L k="Disposition proceeds" v={cur.sold} sub note="net of loan payoff and penalties" />
              <L k="Taxes" v={-cur.taxes} sub note="income and capital gains" />
              <L k="Change in cash" v={bottom(cur)} strong rule />
            </tbody>
          </table>
          <div className="hint">
            {(() => {
              const p = opCf(cur), a = afterDebt(cur), b = bottom(cur);
              const cover = cur.debtSvc > 0 ? (cur.noi / cur.debtSvc) : null;
              const span = usingMonth ? "this month" : "this year";
              const parts: string[] = [];
              if (p <= 0) parts.push(`The portfolio did not cover its own operating costs ${span} — before a dollar of debt service. That is an occupancy problem or an expense problem, and neither is fixed by borrowing.`);
              else if (a < 0 && p > 0) parts.push("The buildings made money and the debt took more than they made. Every month of this comes out of cash or out of the line.");
              else if (a > 0) parts.push(`The portfolio covered its debt with ${usd(a)} to spare.`);
              if (cover !== null) parts.push(`Portfolio coverage ran ${cover.toFixed(2)}× — NOI over debt service, across everything you own.`);
              if (cur.dev > 0 && b < 0 && a > 0) parts.push(`Cash fell because ${usd(cur.dev)} went into construction. That is not a loss; it is a building that is not finished.`);
              if (cur.taxes > 0 && cur.sold > 0) parts.push(`${usd(cur.taxes)} of tax against ${usd(cur.sold)} of disposals — the price of selling rather than exchanging.`);
              return parts.join(" ");
            })()}
          </div>
        </>
      )}
    </div>
  );
}
