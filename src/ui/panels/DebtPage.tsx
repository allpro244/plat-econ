import { useState, Fragment } from "react";
import Slider from "@/ui/Slider";
import { useStore } from "@/state/store";
import { CLASS_LABEL } from "@/data/types";
import { monthLabel, START_YEAR } from "@/engine/types";
import { ownedHoldingValue, ownedHoldingNoiYr, resolveRec } from "@/engine/value";
import { PRODUCTS, productById, payOffDue } from "@/engine/debt";
import { fundableNow, locRate } from "@/engine/credit";
import { facilityQuotes, facilityMetrics, facilityStatus, pledgeable, pledged, releaseCost, allocatedAmount, FACILITY_MIN_ASSETS, RELEASE_PREMIUM } from "@/engine/facility";
import { usd } from "@/ui/format";
import { RefiSection } from "@/ui/panels/RefiDesk";
import { Big, Row } from "@/ui/panels/shared";
import { FundDesk } from "@/ui/panels/FundDesk";
import { CreditLine } from "@/ui/panels/CreditLineDesk";

export { TheBanks } from "@/ui/panels/BanksDesk";
export { SponsorRecord } from "@/ui/panels/SponsorRecord";
export { CompsSheet } from "@/ui/panels/CompsSheet";
export { TheStreet, rivalEquity, STYLE_MAX, CONDITION_WORD, STYLE_WORD } from "@/ui/panels/StreetDesk";
export { FundDesk } from "@/ui/panels/FundDesk";
export { CreditLine } from "@/ui/panels/CreditLineDesk";
export { HousePolicy } from "@/ui/panels/HousePolicyDesk";
export { Landlords } from "@/ui/panels/LandlordsDesk";

/**
 * The saves page. The slot manager used to live at the bottom of the Books
 * page, below the ledger and the milestone list, which is why nobody knew the
 * game could be saved at all. Loading a game is not an accounting task.
 */
/**
 * SETTINGS. The first thing in here exists because of a sentence from the
 * owner: "sometimes I want to simulate the game" — twenty years of Advance
 * with nothing taking the screen hostage. Every pop-up decision also lives on
 * a page, so the master switch costs nothing but the interruptions. The other
 * rows are the switches that already existed, gathered where a person would
 * look for them.
 */
/**
 * THE ONE PAGE THAT ASSUMES YOU HAVE NEVER DONE THIS.
 *
 * Every other screen in this game is written for somebody who already knows
 * what a cap rate is — the tooltips explain what a NUMBER means, not what the
 * IDEA is, which is only useful once you have the idea. The owner asked for
 * "very basic", and the test applied here is that a reader who has never heard
 * the words should be able to buy their first building afterwards and know why.
 *
 * It uses the player's OWN market for the worked example rather than invented
 * round numbers, because a primer that says "imagine a 7% cap" and a game
 * showing 8.34% has just taught somebody that the primer is not about this.
 * Three ideas, in the order they depend on each other — the income, the yield,
 * the value — and then the two traps that follow from them.
 */

// Everything about who is paying you rent, in one room: occupancy by
// building, the whole rent roll, what rolls when, and the agent switch.
/**
 * THE DEBT PAGE — the whole balance sheet's borrowing on one screen.
 *
 * Every number here existed somewhere before and none of them existed
 * together. A player wanting to know what their book actually owed had to open
 * every building in turn, read a loan card each, and hold the weighted average
 * coupon in their head — which is not a thing anybody does, so nobody knew
 * their own WAM, their fixed/floating split, or how much was maturing in the
 * next three years until a balloon landed on them.
 *
 * The order is the order a lender's credit memo puts them in: what you owe,
 * what it costs, what covers it, when it comes due, and what could go wrong.
 */
export function DebtPage() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const { releaseFacility, repayFacility: payFac } = useStore.getState();
  // WHICH LOAN HAS ITS REFINANCING OPEN. The debt page is where a borrower
  // decides what to do about their debt, and until now the only door to the
  // refinance desk was the property record or a row on the portfolio — two
  // screens away from the maturity ladder that tells you which loan needs it.
  const [refiRow, setRefiRow] = useState<string | null>(null);
  const [pool, setPool] = useState<string[]>([]);
  const [prod, setProd] = useState<string>("savings");
  const [lev, setLev] = useState(1);
  const [building, setBuilding] = useState(false);

  const rows = Object.values(game.holdings)
    .map((h) => {
      const rec = resolveRec(parcels, game, h.bbl);
      return {
        h, rec,
        v: rec ? ownedHoldingValue(game, parcels, h) : 0,
        noi: rec ? ownedHoldingNoiYr(game, parcels, h) : 0,
      };
    })
    .filter((r) => r.rec);

  // ---- the aggregates, which is the point of the page ----------------------
  const agg = (() => {
    let bal = 0, wRate = 0, wam = 0, flo = 0, wall36 = 0, ds = 0, noi = 0, val = 0, recourseBal = 0;
    let ioBal = 0, n = 0;
    for (const { h, v, noi: nn } of rows) {
      val += v; noi += nn;
      const l = h.loan;
      const m = h.mezz && h.mezz.balance > 0 ? h.mezz : null;
      if (!l && !m) continue;
      if (l) {
        n++;
        bal += l.balance;
        wRate += l.balance * l.ratePct;
        wam += l.balance * Math.max(0, (l.maturityM - game.month) / 12);
        if (l.floating ?? l.product === "float") flo += l.balance;
        if (l.maturityM - game.month <= 36) wall36 += l.balance;
        if (game.month < l.ioUntilM) ioBal += l.balance;
        if (productById(l.product).recourse) recourseBal += l.balance;
        ds += l.monthlyPmt * 12;
      }
      if (m) {
        if (!l) n++;
        bal += m.balance;
        wRate += m.balance * m.ratePct;
        wam += m.balance * Math.max(0, (m.maturityM - game.month) / 12);
        if (m.maturityM - game.month <= 36) wall36 += m.balance;
        if (game.month < m.ioUntilM) ioBal += m.balance;
        ds += m.monthlyPmt * 12;
      }
    }
    const f = game.facility;
    if (f) {
      n++;
      bal += f.balance;
      wRate += f.balance * f.ratePct;
      wam += f.balance * Math.max(0, (f.maturityM - game.month) / 12);
      if (f.maturityM - game.month <= 36) wall36 += f.balance;
      if (game.month < f.ioUntilM) ioBal += f.balance;
      if (f.recourse) recourseBal += f.balance;
      ds += f.monthlyPmt * 12;
    }
    // Construction facilities are debt too, and they are the debt most likely
    // to be forgotten: they are drawn a bit at a time and they balloon on
    // delivery, which is exactly when the building earns nothing.
    let cons = 0, consDs = 0;
    for (const d of Object.values(game.developments ?? {})) {
      cons += d.loanBalance;
      consDs += (d.loanBalance * d.ratePct) / 100;
    }
    const loc = game.loc?.balance ?? 0;
    const locDs = (loc * locRate(game)) / 100;
    const total = bal + cons + loc;
    return {
      bal, cons, loc, total, n,
      rate: bal > 0 ? wRate / bal : 0,
      wam: bal > 0 ? wam / bal : 0,
      floShare: bal > 0 ? flo / bal : 0,
      ioShare: bal > 0 ? ioBal / bal : 0,
      recourseShare: bal > 0 ? recourseBal / bal : 0,
      wall36, val, noi,
      ds: ds + consDs + locDs,
      ltv: val > 0 ? total / val : 0,
      dscr: ds + consDs + locDs > 0 ? noi / (ds + consDs + locDs) : null,
      dy: total > 0 ? noi / total : null,
    };
  })();

  // ---- the maturity ladder, by calendar year -------------------------------
  const ladder = (() => {
    const by = new Map<number, number>();
    const yr = (m: number) => START_YEAR + Math.floor(m / 12);
    for (const { h } of rows) {
      if (h.loan) by.set(yr(h.loan.maturityM), (by.get(yr(h.loan.maturityM)) ?? 0) + h.loan.balance);
      if (h.mezz && h.mezz.balance > 0) {
        by.set(yr(h.mezz.maturityM), (by.get(yr(h.mezz.maturityM)) ?? 0) + h.mezz.balance);
      }
    }
    if (game.facility) by.set(yr(game.facility.maturityM), (by.get(yr(game.facility.maturityM)) ?? 0) + game.facility.balance);
    for (const d of Object.values(game.developments ?? {})) {
      if (d.loanBalance > 0) by.set(yr(d.deliverM + 12), (by.get(yr(d.deliverM + 12)) ?? 0) + d.loanBalance);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]).slice(0, 12);
  })();
  const ladderMax = Math.max(1, ...ladder.map(([, v]) => v));

  const fac = game.facility;
  const facM = facilityMetrics(game, parcels);
  const candidates = pledgeable(game, parcels);
  const quotes = building && pool.length >= FACILITY_MIN_ASSETS ? facilityQuotes(game, parcels, pool) : [];
  const qt = quotes.find((x) => x.productId === prod) ?? quotes.find((x) => x.available) ?? quotes[0];

  return (
    <div>
      <div className="stat-strip">
        <Big label="Total debt" value={usd(agg.total)} />
        <Big label="Weighted coupon" value={agg.rate > 0 ? agg.rate.toFixed(2) + "%" : "—"} />
        <Big label="Portfolio LTV" value={(agg.ltv * 100).toFixed(0) + "%"} bad={agg.ltv > 0.75} />
        <Big label="Coverage" value={agg.dscr !== null ? agg.dscr.toFixed(2) + "x" : "—"} bad={agg.dscr !== null && agg.dscr < 1.25} />
        <Big label="Debt yield" value={agg.dy !== null ? (agg.dy * 100).toFixed(1) + "%" : "—"} bad={agg.dy !== null && agg.dy < 0.08} />
        <Big label="WAM" value={agg.wam > 0 ? agg.wam.toFixed(1) + " yrs" : "—"} bad={agg.wam > 0 && agg.wam < 3} />
      </div>

      {/* WHAT IT IS MADE OF. Three different instruments with three different
          ways of hurting you, and the book showed one number for all of them. */}
      <div className="page-section">The stack</div>
      <div className="grid">
        <Row k="Mortgages" v={`${usd(agg.bal - (fac?.balance ?? 0))} across ${rows.filter((r) => r.h.loan).length} buildings`} />
        {fac && <Row k="Portfolio facility" v={`${usd(fac.balance)} across ${fac.bbls.length} deeds · ${fac.lender}`} strong />}
        <Row k="Construction" v={agg.cons > 0 ? `${usd(agg.cons)} drawn` : "none"} />
        <Row k="Line of credit" v={agg.loc > 0 ? `${usd(agg.loc)} at ${locRate(game).toFixed(2)}%` : "undrawn"} bad={agg.loc > 0} />
        <Row k="Annual debt service" v={usd(Math.round(agg.ds))} />
        <Row k="NOI against it" v={`${usd(Math.round(agg.noi))} — ${usd(Math.round(agg.noi - agg.ds))} after debt service`} bad={agg.noi - agg.ds < 0} />
      </div>

      {/* THE REVOLVER BELONGS WITH THE REST OF THE DEBT, not under the ledger.
          Books still shows the drawn balance as a liability; draw and repay live
          here with the mortgages and the facility. */}
      <FundDesk />
      <CreditLine />

      {(game.privateBorrowQuotes?.length ?? 0) > 0 && (
        <>
          <div className="page-section">Private borrow offers</div>
          <div className="hint" style={{ marginBottom: 8 }}>
            When the banks refuse or hold-cap a takeout, a rival with powder may quote a short bridge.
            Accept on the property refinance desk, or here. Expensive, finite, enforceable.
          </div>
          {(game.privateBorrowQuotes ?? []).map((q) => {
            const h = game.holdings[q.bbl];
            const payoff = (h?.loan?.balance ?? 0) + (h?.mezz?.balance ?? 0);
            const pts = Math.round(q.principal * q.points);
            const penalty = (h?.loan ? payOffDue(h.loan, game.month).penalty : 0)
              + (h?.mezz && h.mezz.balance > 0 ? payOffDue(h.mezz, game.month).penalty : 0);
            const net = q.principal - payoff - pts - penalty;
            return (
              <div key={q.id} className="hint" style={{ marginBottom: 10 }}>
                <div style={{ cursor: "pointer" }} onClick={() => useStore.getState().focus(q.bbl, true)}>
                  <strong>{q.address}</strong> · {q.lenderName} will write{" "}
                  <b className="mono">{usd(q.principal)}</b> at <b className="mono">{q.ratePct.toFixed(2)}%</b>,{" "}
                  {(q.points * 100).toFixed(1)} points, {q.termM} months
                </div>
                <div className="dim" style={{ marginTop: 4 }}>{q.why}</div>
                <div style={{ marginTop: 4 }}>
                  Net after takeout:{" "}
                  <b className={net >= 0 ? "mono" : "mono neg"}>{net >= 0 ? "+" : ""}{usd(net)}</b>
                  {" · "}lapses {monthLabel(q.expiresM)}.
                </div>
                <div className="btn-row" style={{ marginTop: 6 }}>
                  <button className="btn" onClick={() => useStore.getState().acceptPrivateBorrowQuote(q.id)}>
                    Take private · {usd(q.principal)}
                  </button>
                  <button className="btn-mini" onClick={() => useStore.getState().declinePrivateBorrowQuote(q.id)}>
                    Pass
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* THE THREE THINGS THAT ACTUALLY END FIRMS, and none of them is the
          coupon: how much of the book reprices, how much of it is due soon,
          and how much of it you signed for personally. */}
      <div className="page-section">Where the risk is</div>
      <div className="grid">
        <Row k="Floating" v={`${(agg.floShare * 100).toFixed(0)}% of the mortgage book`} bad={agg.floShare > 0.4} />
        <Row k="Interest-only today" v={`${(agg.ioShare * 100).toFixed(0)}% — amortisation starts later and the payment steps up`} bad={agg.ioShare > 0.6} />
        <Row k="Recourse" v={`${(agg.recourseShare * 100).toFixed(0)}% you signed personally`} bad={agg.recourseShare > 0.5} />
        <Row k="Maturing inside 3 years" v={`${usd(agg.wall36)} · ${agg.bal > 0 ? ((agg.wall36 / agg.bal) * 100).toFixed(0) : 0}% of the book`} bad={agg.bal > 0 && agg.wall36 / agg.bal > 0.35} />
      </div>

      <div className="page-section">The maturity ladder</div>
      {ladder.length === 0 ? (
        <div className="hint">Nothing borrowed yet.</div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 90, marginBottom: 6 }}>
          {ladder.map(([y, v]) => (
            <div key={y} style={{ flex: 1, textAlign: "center" }} title={`${usd(v)} matures in ${y}`}>
              <div style={{
                height: Math.max(2, Math.round((v / ladderMax) * 64)),
                background: v / Math.max(1, agg.total) > 0.35 ? "#a8402e" : "#5a6f8a",
                borderRadius: 2,
              }} />
              <div className="dim mono" style={{ fontSize: 10 }}>{y}</div>
            </div>
          ))}
        </div>
      )}
      <div className="hint">
        A wall is not a number, it is a year. Anything over a third of the book landing in one of these
        is a year you have to refinance in whatever market happens to be open.
      </div>

      {/* ---- the facility ---------------------------------------------- */}
      <div className="page-section">Borrowing against the whole book</div>
      {fac ? (
        <>
          <div className="grid">
            <Row k="Status" v={facilityStatus(game, parcels)} bad={fac.breachedSince !== undefined || fac.accelM !== undefined} strong />
            <Row k="Lender" v={`${fac.lender} · ${fac.ratePct.toFixed(2)}%`} />
            <Row k="Balance" v={`${usd(fac.balance)} of ${usd(fac.drawn)} drawn`} />
            <Row k="Pool" v={`${fac.bbls.length} buildings · ${usd(Math.round(facM.value))} of value`} />
            <Row k="Pool coverage" v={facM.dscr !== null ? `${facM.dscr.toFixed(2)}x against a ${fac.minDSCR.toFixed(2)}x covenant` : "—"} bad={facM.dscr !== null && facM.dscr < fac.minDSCR} />
            <Row k="Pool leverage" v={facM.ltv !== null ? `${(facM.ltv * 100).toFixed(0)}% against a ${(fac.maxLTV * 100).toFixed(0)}% covenant` : "—"} bad={facM.ltv !== null && facM.ltv > fac.maxLTV} />
            <Row k="Payment" v={`${usd(fac.monthlyPmt)}/mo · matures ${monthLabel(fac.maturityM)}`} />
            <Row k="Recourse" v={fac.recourse ? "yes — you signed personally" : "non-recourse"} bad={fac.recourse} />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={game.cash < 1_000_000} onClick={() => payFac(Math.min(fac.balance, Math.floor(game.cash * 0.5)))}>
              Pay down {usd(Math.min(fac.balance, Math.floor(game.cash * 0.5)))}
            </button>
            <button className="btn" disabled={game.cash < fac.balance} onClick={() => payFac(fac.balance)}>
              Repay in full · {usd(fac.balance)}
            </button>
          </div>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th>Pledged</th><th className="num">Value</th><th className="num">Allocated</th><th className="num">Release price</th><th></th></tr>
              </thead>
              <tbody>
                {fac.bbls.map((b) => {
                  const rec = resolveRec(parcels, game, b);
                  const h = game.holdings[b];
                  if (!rec || !h) return null;
                  const rel = releaseCost(game, parcels, b);
                  return (
                    <tr key={b}>
                      <td>{rec.address}</td>
                      <td className="num">{usd(ownedHoldingValue(game, parcels, h))}</td>
                      <td className="num">{usd(allocatedAmount(game, parcels, b))}</td>
                      <td className="num">{usd(rel)}</td>
                      <td>
                        <button className="btn btn-sm" disabled={game.cash < rel} onClick={() => releaseFacility(b)}>
                          Release
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="hint">
            The pool is crossed: every deed stands behind the whole balance, a covenant breach sweeps all of them
            at once, and selling one costs its allocated share plus {Math.round((RELEASE_PREMIUM - 1) * 100)}%.
            That premium is what you pay for having borrowed against the book instead of the buildings.
          </div>
        </>
      ) : !building ? (
        <>
          <div className="hint">
            Past a handful of buildings an owner stops financing buildings and starts financing a balance sheet.
            Pledge a pool, and one lender advances against all of it: a few points more leverage and a tighter coupon
            than the same buildings borrow one at a time, because a diversified pool cannot all go dark at once.
            What you give up is separability — the pool is cross-defaulted, it is recourse, and taking a building
            back out costs a premium over its share.
          </div>
          <div className="btn-row">
            <button className="btn btn-buy" disabled={candidates.length < FACILITY_MIN_ASSETS}
              onClick={() => { setBuilding(true); setPool(candidates.slice(0, Math.min(8, candidates.length)).map((c) => c.bbl)); }}>
              {candidates.length < FACILITY_MIN_ASSETS
                ? `You need ${FACILITY_MIN_ASSETS} eligible buildings — you have ${candidates.length}`
                : "Put a pool together"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th></th><th>Building</th><th>Class</th><th className="num">Value</th><th className="num">NOI</th><th className="num">Mortgage to repay</th></tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.bbl} style={{ cursor: "pointer" }}
                    onClick={() => setPool(pool.includes(c.bbl) ? pool.filter((b) => b !== c.bbl) : [...pool, c.bbl])}>
                    <td><input type="checkbox" readOnly checked={pool.includes(c.bbl)} /></td>
                    <td>{c.rec.address}</td>
                    <td>{CLASS_LABEL[c.rec.class] ?? c.rec.class}</td>
                    <td className="num">{usd(c.value)}</td>
                    <td className="num">{usd(Math.round(ownedHoldingNoiYr(game, parcels, c.h)))}</td>
                    <td className="num dim">{c.loan > 0 ? usd(c.loan) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {qt && (
            <>
              <div className="btn-row">
                {quotes.map((x) => (
                  <button key={x.productId}
                    className={"btn" + (qt.productId === x.productId ? " btn-on" : "")}
                    disabled={!x.available}
                    style={!x.available ? { opacity: 0.42, cursor: "not-allowed" } : undefined}
                    title={x.why ?? `${x.lender} · ${(x.advance * 100).toFixed(0)}% advance`}
                    onClick={() => setProd(x.productId)}>
                    {x.lender} · {x.available ? `${x.ratePct.toFixed(2)}%` : "won't quote"}
                  </button>
                ))}
              </div>
              <div className="grid">
                <Row k="The pool" v={`${pool.length} buildings · ${usd(Math.round(qt.quality.value))} · ${qt.quality.why}`} />
                <Row k="Diversification" v={`${(qt.quality.score * 100).toFixed(0)} of 100 — worth ${((qt.advance - PRODUCTS.find((p) => p.id === qt.productId)!.ltv) * 100).toFixed(1)} points of advance and ${(qt.spreadCut * 100).toFixed(0)}bp of coupon`} />
                <Row k="Borrowing base" v={`${usd(qt.base)} · ${(qt.advance * 100).toFixed(0)}% advance · capped by ${qt.binding}`} strong />
                <Row k="Mortgages repaid" v={qt.payoff > 0 ? `${usd(qt.payoff)}${qt.penalties > 0 ? ` + ${usd(qt.penalties)} to break them` : ""}` : "none — the pool is unencumbered"} bad={qt.penalties > 0} />
                {(() => {
                  const draw = Math.floor(qt.base * lev);
                  const fees = Math.round(draw * 0.01) + Math.round(draw * qt.points);
                  return <Row k="Fees" v={usd(fees)} />;
                })()}
                <Row k="Covenants" v={`${qt.minDSCR.toFixed(2)}x coverage, ${(qt.advance * 100).toFixed(0)}% leverage — tested on the POOL`} />
                <Row k="Structure" v={`${qt.ioM ? `${Math.round(qt.ioM / 12)}-yr IO, ` : ""}${qt.amortYears}-yr amort, ${Math.round(qt.termM / 12)}-yr term, recourse`} />
              </div>
              <Slider
                label="Draw"
                value={lev}
                min={0.2}
                max={1}
                step={0.02}
                onChange={setLev}
                format={() => `${usd(Math.floor(qt.base * lev))} · ${((qt.base * lev) / Math.max(1, qt.quality.value) * 100).toFixed(0)}% of the pool`}
                marks={[{ at: 0.5, label: "half" }, { at: 1, label: "the base" }]}
                hint={`Net to you ${usd(Math.floor(qt.base * lev) - qt.payoff - qt.penalties - Math.round(Math.floor(qt.base * lev) * (0.01 + qt.points)))} after the payoffs and fees. `
                  + "Drawing less than the base is the room you will have when the market turns — the covenant is tested against what you drew."}
              />
              <div className="btn-row">
                <button className="btn btn-buy" disabled={!qt.available || pool.length < FACILITY_MIN_ASSETS}
                  onClick={() => { useStore.getState().openFacility(pool, qt.productId, lev); setBuilding(false); }}>
                  Sign it · {usd(Math.floor(qt.base * lev))}
                </button>
                <button className="btn" onClick={() => setBuilding(false)}>Cancel</button>
              </div>
            </>
          )}
          {!qt && <div className="hint">Pick at least {FACILITY_MIN_ASSETS} buildings.</div>}
        </>
      )}

      {/* ---- every loan, one row each ---------------------------------- */}
      <div className="page-section">Loan by loan</div>
      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Building</th><th>Desk</th><th className="num">Balance</th><th className="num">Rate</th>
              <th className="num">LTV</th><th className="num">DSCR</th><th className="num">Payment</th>
              <th>Matures</th><th>Terms</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.filter((r) => r.h.loan).sort((a, b) => (b.h.loan!.balance) - (a.h.loan!.balance)).map(({ h, rec, v, noi }) => {
              const l = h.loan!;
              const p = productById(l.product);
              const ds = l.monthlyPmt * 12;
              const d = ds > 0 ? noi / ds : null;
              const lv = v > 0 ? l.balance / v : null;
              const near = l.maturityM - game.month <= 24;
              const due = payOffDue(l, game.month);
              const canPay = !pledged(game, h.bbl) && fundableNow(game, parcels) >= due.due;
              const crumb = due.balance > 0 && due.balance < 25_000;
              return (
                <Fragment key={h.bbl}>
                <tr>
                  <td>
                    <a className="lnk" onClick={() => useStore.getState().focus(h.bbl, true)}>{rec!.address}</a>
                    {pledged(game, h.bbl) ? <span className="dim"> · pledged</span> : null}
                  </td>
                  <td className="dim">{p.lender}</td>
                  <td className="num">{usd(l.balance)}</td>
                  <td className="num">{l.ratePct.toFixed(2)}%{(l.floating ?? l.product === "float") ? " fl" : ""}</td>
                  <td className={"num" + (lv !== null && lv > l.maxLTV ? " neg" : "")}>{lv !== null ? (lv * 100).toFixed(0) + "%" : "—"}</td>
                  <td className={"num" + (d !== null && d < l.minDSCR ? " neg" : "")}>{d !== null ? d.toFixed(2) : "—"}</td>
                  <td className="num">{usd(l.monthlyPmt)}</td>
                  <td className={near ? "neg" : ""}>{monthLabel(l.maturityM)}</td>
                  <td className="dim">
                    {[l.sweep ? "SWEPT" : null, game.month < l.ioUntilM ? "IO" : null, p.recourse ? "recourse" : null,
                      l.prepay === "yieldmaint" ? "YM" : null].filter(Boolean).join(" · ")}
                  </td>
                  <td>
                    <div className="btn-row" style={{ gap: 4, margin: 0, justifyContent: "flex-end" }}>
                      <button
                        className={"btn btn-sm" + (crumb ? " btn-buy" : "")}
                        disabled={!canPay}
                        title={pledged(game, h.bbl)
                          ? "Pledged to the facility — release it there first."
                          : !canPay
                            ? `Need ${usd(due.due)}${due.penalty > 0 ? ` incl. ${usd(due.penalty)} break fee` : ""} — short ${usd(due.due - fundableNow(game, parcels))}.`
                            : due.penalty > 0
                              ? `Retire the note: ${usd(due.balance)} + ${usd(due.penalty)} to break the paper. Deed free and clear.`
                              : `Retire the note for ${usd(due.due)}. Deed free and clear — required before a ground lease.`}
                        onClick={() => useStore.getState().payOffLoan(h.bbl)}
                      >
                        Pay off{crumb ? ` · ${usd(due.due)}` : ""}
                      </button>
                      <button
                        className={"btn btn-sm" + (refiRow === h.bbl ? " btn-on" : "")}
                        title={near
                          ? "This one matures inside two years. Refinance it while somebody is still lending."
                          : "What the desks would write against this building today."}
                        onClick={() => setRefiRow(refiRow === h.bbl ? null : h.bbl)}
                      >
                        Refi
                      </button>
                    </div>
                  </td>
                </tr>
                {refiRow === h.bbl && (
                  <tr>
                    <td colSpan={10} style={{ background: "rgba(43,37,26,0.035)" }}>
                      <RefiSection bbl={h.bbl} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {fac && (
              <tr>
                <td><strong>The facility</strong> <span className="dim">· {fac.bbls.length} deeds crossed</span></td>
                <td className="dim">{fac.lender}</td>
                <td className="num">{usd(fac.balance)}</td>
                <td className="num">{fac.ratePct.toFixed(2)}%</td>
                <td className={"num" + (facM.ltv !== null && facM.ltv > fac.maxLTV ? " neg" : "")}>{facM.ltv !== null ? (facM.ltv * 100).toFixed(0) + "%" : "—"}</td>
                <td className={"num" + (facM.dscr !== null && facM.dscr < fac.minDSCR ? " neg" : "")}>{facM.dscr !== null ? facM.dscr.toFixed(2) : "—"}</td>
                <td className="num">{usd(fac.monthlyPmt)}</td>
                <td className={fac.maturityM - game.month <= 24 ? "neg" : ""}>{monthLabel(fac.maturityM)}</td>
                <td className="dim">{[fac.sweep ? "SWEPT" : null, game.month < fac.ioUntilM ? "IO" : null, "recourse", "crossed"].filter(Boolean).join(" · ")}</td>
                <td className="dim">—</td>
              </tr>
            )}
            {!rows.some((r) => r.h.loan) && !fac && (
              <tr><td colSpan={10} className="dim">No debt. Every building here is owned outright.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
