// Permanent debt desk for a single deed — refinance / mezz / payoff.
// Extracted from ParcelDesk; also embedded from Portfolio and Debt pages.
import { useState } from "react";
import Slider from "@/ui/Slider";
import { useStore } from "@/state/store";
import { useHeldGame } from "@/ui/heldGame";
import { monthLabel } from "@/engine/types";
import { resolveRec, isVacantLandLoanCollateral } from "@/engine/value";
import { refiQuotes, prepayPenalty, mezzQuote } from "@/engine/debt";
import { usd, pct } from "@/ui/format";
import { annualPayment, Row } from "@/ui/panels/shared";

export function RefiSection({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const { refi, placeMezz, acceptPrivateBorrowQuote, declinePrivateBorrowQuote } = useStore.getState();
  const holding = game.holdings[bbl];
  const privateQuotes = (game.privateBorrowQuotes ?? []).filter((q) => q.bbl === bbl);
  const mq = mezzQuote(game, parcels, bbl);
  // A leased fee with a ground rent is income paper, not vacant dirt — open
  // on an income desk even when the resolved class is still "land".
  const refiRec = resolveRec(parcels, game, bbl);
  const vacantDirt = !!holding && !!refiRec && isVacantLandLoanCollateral(game, holding, refiRec);
  const [product, setProduct] = useState<string>(vacantDirt ? "land" : "savings");
  const [lev, setLev] = useState(1);
  const [showAllQuotes, setShowAllQuotes] = useState(false);
  const { quotes, value, payoff } = refiQuotes(game, parcels, bbl);
  const fundableQuotes = quotes.filter((x) => x.available && x.maxProceeds > 0);
  const deskQuotes = showAllQuotes ? quotes : fundableQuotes;
  const cur = game.holdings[bbl]?.loan;
  const existing = cur ? prepayPenalty(cur, game.month) : 0;
  if (!quotes.length && !privateQuotes.length) {
    return (
      <div className="refi">
        <div className="deal-head">Refinance</div>
        <div className="hint">
          No desk will quote against this today. Appraised at {usd(value)}{payoff > 0 ? `, ${usd(payoff)} outstanding` : ""} —
          the income is not there, or the credit window is shut.
        </div>
      </div>
    );
  }
  if (!quotes.length) {
    return (
      <div className="refi">
        <div className="deal-head">Refinance</div>
        <div className="hint">Appraised at {usd(value)}; {usd(payoff)} to pay off. The banks are silent — private paper below.</div>
        {privateQuotes.map((pq) => {
          const pts = Math.round(pq.principal * pq.points);
          const mezzPen = holding?.mezz && holding.mezz.balance > 0
            ? prepayPenalty(holding.mezz, game.month) : 0;
          // payoff from refiQuotes is already senior + mezz balance
          const net = pq.principal - payoff - pts - existing - mezzPen;
          return (
            <div key={pq.id} className="hint" style={{ marginBottom: 8, borderLeft: "3px solid #8a5620", paddingLeft: 8 }}>
              <div>
                <strong>{pq.lenderName}</strong> · private bridge ·{" "}
                <b className="mono">{usd(pq.principal)}</b> at <b className="mono">{pq.ratePct.toFixed(2)}%</b>
              </div>
              <div className="dim" style={{ marginTop: 4 }}>{pq.why}</div>
              <div style={{ marginTop: 4 }}>
                After payoff and points:{" "}
                <b className={net >= 0 ? "mono" : "mono neg"}>{net >= 0 ? "+" : ""}{usd(net)}</b>
              </div>
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button className="btn" onClick={() => acceptPrivateBorrowQuote(pq.id)}>
                  Take private · {usd(pq.principal)}
                </button>
                <button className="btn-mini" onClick={() => declinePrivateBorrowQuote(pq.id)}>Pass</button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  // WHICH DESK YOU ARE ACTUALLY LOOKING AT.
  //
  // `product` opened at "savings" whether or not the savings bank quoted this
  // building, and every highlight on the screen was drawn off `product` while
  // every number was drawn off `quotes[0]`. So on any building the regional
  // did not quote — which since their $2.5M minimum is a great many — nothing
  // was lit up, the table had no selected row, and the panel was reporting one
  // desk's terms with another desk's name nowhere. The selection is whatever
  // quote is being read, and everything on the card keys off that.
  // ...and the fallback is a desk that will actually write, not merely the
  // first one in the list. Falling through to quotes[0] could land the card on
  // a lender quoting nothing, which is the same "describing a desk you are not
  // using" fault one step further along.
  const q = quotes.find((x) => x.id === product)
    ?? quotes.find((x) => x.available && x.maxProceeds > 0)
    ?? quotes[0];
  const picked = q.id;
  const proceeds = Math.round(q.maxProceeds * lev);
  const capPremium = q.floating ? Math.round(proceeds * 0.0125) : 0;
  const fee = Math.round(Math.max(proceeds, payoff) * 0.01) + Math.round(proceeds * q.points) + existing + capPremium;
  const toYou = proceeds - payoff - fee;
  // real annuity, not "coupon times 1.28" — the old shortcut overstated a
  // 30-yr amort by a full point of proceeds at today's rates
  const annualDs = q.ioM > 0 ? (proceeds * q.ratePct) / 100 : annualPayment(proceeds, q.ratePct, q.amortYears);
  return (
    <div className="refi">
      <div className="deal-head">Refinance</div>
      {quotes.length > fundableQuotes.length && (
        <div className="hint" style={{ marginBottom: 6 }}>
          {fundableQuotes.length} of {quotes.length} desks will quote this building.
          {!showAllQuotes && (
            <> <button type="button" className="btn-mini" onClick={() => setShowAllQuotes(true)}>Show all</button></>
          )}
          {showAllQuotes && (
            <> <button type="button" className="btn-mini" onClick={() => setShowAllQuotes(false)}>Fundable only</button></>
          )}
        </div>
      )}
      <div className="hint">Appraised at {usd(value)}; {usd(payoff)} to pay off.</div>
      {existing > 0 && (
        <div className="hint">
          {existing > 0
            ? `Breaking the loan you have costs ${usd(existing)} in ${game.holdings[bbl]?.loan?.prepay === "yieldmaint" ? "yield maintenance" : "prepayment penalty"}.`
            : ""}
        </div>
      )}
      {privateQuotes.map((pq) => {
        const pts = Math.round(pq.principal * pq.points);
        const mezzPen = holding?.mezz && holding.mezz.balance > 0
          ? prepayPenalty(holding.mezz, game.month) : 0;
        // payoff from refiQuotes is already senior + mezz balance
        const net = pq.principal - payoff - pts - existing - mezzPen;
        return (
          <div key={pq.id} className="hint" style={{ marginBottom: 8, borderLeft: "3px solid #8a5620", paddingLeft: 8 }}>
            <div>
              <strong>{pq.lenderName}</strong> · private bridge ·{" "}
              <b className="mono">{usd(pq.principal)}</b> at <b className="mono">{pq.ratePct.toFixed(2)}%</b>,{" "}
              {(pq.points * 100).toFixed(1)} points, {pq.termM} months · {(100 * pq.ltv).toFixed(0)}% of as-is
            </div>
            <div className="dim" style={{ marginTop: 4 }}>{pq.why}</div>
            <div style={{ marginTop: 4 }}>
              After payoff and points:{" "}
              <b className={net >= 0 ? "mono" : "mono neg"}>{net >= 0 ? "+" : ""}{usd(net)}</b>
              {" · "}lapses {monthLabel(pq.expiresM)}.
            </div>
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button className="btn" onClick={() => acceptPrivateBorrowQuote(pq.id)}>
                Take private · {usd(pq.principal)}
              </button>
              <button className="btn-mini" onClick={() => declinePrivateBorrowQuote(pq.id)}>Pass</button>
            </div>
          </div>
        );
      })}
      {mq.available && (
        <div className="hint" style={{ marginBottom: 8, borderLeft: "3px solid #7a6a45", paddingLeft: 8 }}>
          <div>
            <strong>Cordage mezz</strong> · behind your senior ·{" "}
            <b className="mono">{usd(mq.principal)}</b> at <b className="mono">{mq.ratePct.toFixed(2)}%</b>,{" "}
            {(mq.points * 100).toFixed(1)} points · stack to {(100 * mq.ltvCombined).toFixed(0)}% LTV
          </div>
          <div className="dim" style={{ marginTop: 4 }}>
            A second lien, not a refinance. The coupon is why nobody does this twice.
          </div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn" onClick={() => placeMezz(bbl)}>Place mezz · {usd(mq.principal)}</button>
          </div>
        </div>
      )}
      <div className="btn-row">
        {deskQuotes.map((x) => (
          <button
            key={x.id}
            className={"btn" + (picked === x.id ? " btn-on" : "")}
            disabled={!x.available || x.maxProceeds <= 0}
            style={!x.available || x.maxProceeds <= 0 ? { opacity: 0.42, cursor: "not-allowed" } : undefined}
            title={x.why ?? x.blurb}
            onClick={() => setProduct(x.id)}
          >
            {x.label} · {x.available && x.maxProceeds > 0 ? pct(x.ratePct) : "won't quote"}
          </button>
        ))}
      </div>
      <div className="hint">{q.why ?? q.blurb}</div>

      {/* EVERY DESK AT ONCE, AND WHAT STOPPED EACH ONE.
          The complaint that started this was a $700M building with $130M of
          debt where every refinance option asked for money instead of giving
          it. The capital was there the whole time — the reason was not. Four
          desks quoted small for FOUR DIFFERENT reasons (a hold size, a minimum
          check, a shut securitisation window, a sponsor mark), and all four
          presented identically as "pay money in", so the screen read as one
          wall instead of four different ones with four different ways round.
          Reading them one at a time by clicking each button is not a market;
          this is the market. Sorted by what actually reaches your account. */}
      <div className="page-section" style={{ marginTop: 8 }}>The market for this building</div>
      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr><th>Desk</th><th className="num">Rate</th><th className="num">Advance</th><th className="num">Most they'll write</th><th className="num">To you</th><th>What stops them</th></tr>
          </thead>
          <tbody>
            {[...deskQuotes]
              .map((x) => {
                const px = Math.round(x.maxProceeds);
                const cap = x.floating ? Math.round(px * 0.0125) : 0;
                const f = Math.round(Math.max(px, payoff) * 0.01) + Math.round(px * x.points) + existing + cap;
                return { x, px, net: px - payoff - f };
              })
              .sort((a, b) => b.net - a.net)
              .map(({ x, px, net }) => (
                <tr
                  key={x.id}
                  className={x.id === picked ? "" : "dim"}
                  style={{
                    cursor: x.available && x.maxProceeds > 0 ? "pointer" : "not-allowed",
                    opacity: x.available && x.maxProceeds > 0 ? undefined : 0.5,
                    // The selected desk was distinguished only by NOT being
                    // dimmed, which on a four-row table reads as nothing at
                    // all. This is the row whose terms the rest of the card is
                    // describing, and it says so.
                    background: x.id === picked ? "rgba(120,160,255,0.14)" : undefined,
                    fontWeight: x.id === picked ? 600 : undefined,
                  }}
                  onClick={() => x.available && x.maxProceeds > 0 && setProduct(x.id)}
                >
                  <td>{x.id === picked ? "▸ " : ""}{x.label}</td>
                  <td className="num">{x.available ? pct(x.ratePct) : "—"}</td>
                  <td className="num">{((x.advanceLtv ?? x.maxLTV) * 100).toFixed(0)}%</td>
                  <td className="num">{px > 0 ? usd(px) : "—"}</td>
                  <td className="num" style={{ color: net > 0 ? undefined : "#a8402e" }}>
                    {px > 0 ? (net >= 0 ? usd(net) : "−" + usd(-net)) : "—"}
                  </td>
                  {/* The reason, in the lender's own words when there is one,
                      and otherwise the test that actually bound. Never blank —
                      a quote with no reason is the same defect as a dead
                      button, which is what this whole card is fixing. */}
                  <td className="dim">{x.why ?? (px > 0 ? x.binding : "nothing to lend against")}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <div className="grid">
        <Row k="Desk" v={`${q.label} · ${pct(q.ratePct)}`} strong />
        <Row k="Lender's maximum" v={`${usd(q.maxProceeds)} · ${(q.ltvAtMax * 100).toFixed(0)}% LTV against a ${((q.advanceLtv ?? q.maxLTV) * 100).toFixed(0)}% advance (${(q.maxLTV * 100).toFixed(0)}% covenant)`} />
        {/* THE THREE NUMBERS THE COVERAGE RATIO IS MADE OF, at the amount the
            dial is actually set to.
            This row printed `dscrAtMax` — the coverage at the LENDER'S maximum
            — and never moved, so a player halving the draw watched the ratio
            they were halving it to fix sit perfectly still. And the two inputs
            were nowhere on the screen at all: a borrower cannot check a
            coverage ratio they cannot see the numerator of. `noiUw` is the
            income the desk sized against, which inside a lease-up is
            stabilised-less-holdback rather than what the building earns today,
            and that distinction belongs in front of the person signing. */}
        <Row
          k="Income underwritten"
          v={q.noiUw > 0 ? `${usd(Math.round(q.noiUw))} NOI a year` : "— no income to lend against"}
        />
        <Row
          k="Debt service"
          v={proceeds > 0 ? `${usd(Math.round(annualDs))} a year on ${usd(proceeds)}` : "—"}
        />
        <Row
          k="Coverage / debt yield"
          v={proceeds > 0 && annualDs > 0 && q.noiUw > 0
            ? `DSCR ${(q.noiUw / annualDs).toFixed(2)} · DY ${((q.noiUw / proceeds) * 100).toFixed(1)}%`
            : "— no income to cover it"}
          bad={proceeds > 0 && annualDs > 0 && q.noiUw > 0 && q.noiUw / annualDs < 1.20}
        />
        <Row k="What caps it" v={q.maxProceeds > 0 ? q.binding : "nothing to lend against"} bad={q.binding === "debt yield" && q.maxProceeds > 0} />
        <Row k="Structure" v={`${q.ioM ? `${Math.round(q.ioM / 12)}-yr IO, ` : ""}${q.amortYears}-yr amort, ${q.termM / 12}-yr term, ${((q.advanceLtv ?? q.maxLTV) * 100).toFixed(0)}% advance / ${(q.maxLTV * 100).toFixed(0)}% covenant, ${q.floating ? "floating" : "fixed"}`} />
        <Row k="Origination" v={`${(q.points * 100).toFixed(1)} pts · ${usd(Math.round(proceeds * q.points))}`} />
        {capPremium > 0 && <Row k="Rate cap at close" v={usd(capPremium)} />}
        <Row
          k="Prepayment"
          v={q.prepay === "open" ? "open — leave any time"
            : q.prepay === "stepdown" ? `step-down, ${q.prepayM / 12} yrs (5% falling to 1%)`
            : `yield maintenance, ${q.prepayM / 12} yrs`}
          bad={q.prepay === "yieldmaint"}
        />
        <Row k="Recourse" v={q.recourse ? "yes — you sign personally" : "non-recourse"} bad={q.recourse} />
        {q.kicker !== undefined && <Row k="Lender's share of gain" v={`${(q.kicker * 100).toFixed(0)}% on sale`} bad />}
      </div>
      <Slider
        label="Take"
        value={lev}
        min={0}
        max={1}
        step={0.02}
        onChange={setLev}
        format={() => `${usd(proceeds)} · ${((proceeds / Math.max(1, value)) * 100).toFixed(0)}% LTV`
          + (proceeds > 0 && annualDs > 0 && q.noiUw > 0 ? ` · DSCR ${(q.noiUw / annualDs).toFixed(2)}` : "")}
        marks={[{ at: 0.5, label: "half" }, { at: 0.8, label: "80%" }, { at: 1, label: "max" }]}
        hint={`${usd(annualDs)} a year of debt service against ${usd(Math.round(q.noiUw))} of NOI. `
          + `${toYou >= 0 ? `Cash out ${usd(toYou)} after the ${usd(fee)} fee.` : `You'd write a cheque for ${usd(-toYou)}.`}`}
      />
      {/* THE WHOLE DEAL AT WHATEVER THE DIAL SAYS, SIDE BY SIDE WITH THE ONE
          YOU HAVE.
          A refinance is not a question about proceeds, it is a question about
          what the building looks like AFTERWARDS — and the panel answered the
          first one on a slider and the second one nowhere. Every number here
          recomputes as the dial moves, and each is paired with what it is
          today, because the only useful form of "your coverage would be 1.34x"
          is "your coverage would be 1.34x, against 1.71x now".
          The cash flow line is the one that decides it. A cash-out refinance
          that leaves the building running at a deficit is a loan you service
          out of your other buildings, and that is the single most common way a
          good portfolio is lost — so it is on the screen in dollars, before
          you sign, with the sign it will actually have. */}
      {(() => {
        const cur = game.holdings[bbl]?.loan;
        const curDs = cur
          ? (game.month < cur.ioUntilM
            ? (cur.balance * cur.ratePct) / 100
            : cur.monthlyPmt * 12)
          : 0;
        const noi = q.noiUw;
        const cfNow = noi - curDs;
        const cfAfter = noi - annualDs;
        const ltvNow = value > 0 && cur ? cur.balance / value : 0;
        const dscrNow = curDs > 0 ? noi / curDs : null;
        const dscrAfter = annualDs > 0 ? noi / annualDs : null;
        const dyAfter = proceeds > 0 ? noi / proceeds : null;
        const cell = (k: string, now: string, after: string, bad?: boolean) => (
          <tr>
            <td>{k}</td>
            <td className="num dim">{now}</td>
            <td className={"num" + (bad ? " neg" : "")}><strong>{after}</strong></td>
          </tr>
        );
        return (
          <div className="scroll-x" style={{ marginTop: 6 }}>
            <table className="tbl">
              <thead>
                <tr><th>At {usd(proceeds)}</th><th className="num">Today</th><th className="num">After</th></tr>
              </thead>
              <tbody>
                {cell("Debt on the building", cur ? usd(cur.balance) : "none", usd(proceeds))}
                {cell("LTV", cur ? `${(ltvNow * 100).toFixed(0)}%` : "0%",
                  `${((proceeds / Math.max(1, value)) * 100).toFixed(0)}%`,
                  proceeds / Math.max(1, value) > 0.75)}
                {cell("Coverage (DSCR)", dscrNow !== null ? `${dscrNow.toFixed(2)}x` : "—",
                  dscrAfter !== null ? `${dscrAfter.toFixed(2)}x` : "—",
                  dscrAfter !== null && dscrAfter < 1.25)}
                {cell("Debt yield", cur && cur.balance > 0 ? `${((noi / cur.balance) * 100).toFixed(1)}%` : "—",
                  dyAfter !== null ? `${(dyAfter * 100).toFixed(1)}%` : "—",
                  dyAfter !== null && dyAfter < 0.08)}
                {cell("Debt service / yr", cur ? `−${usd(Math.round(curDs))}` : "—", `−${usd(Math.round(annualDs))}`)}
                {cell("Cash flow after debt / yr", `${cfNow < 0 ? "−" : ""}${usd(Math.abs(Math.round(cfNow)))}`,
                  `${cfAfter < 0 ? "−" : ""}${usd(Math.abs(Math.round(cfAfter)))}`, cfAfter < 0)}
                {cell("...per month", `${cfNow < 0 ? "−" : ""}${usd(Math.abs(Math.round(cfNow / 12)))}`,
                  `${cfAfter < 0 ? "−" : ""}${usd(Math.abs(Math.round(cfAfter / 12)))}`, cfAfter < 0)}
              </tbody>
            </table>
          </div>
        );
      })()}
      <div className="hint">
        {(() => {
          const noi = q.noiUw;
          const cfAfter = noi - annualDs;
          const dscrAfter = annualDs > 0 ? noi / annualDs : null;
          if (proceeds <= 0) return "Nothing drawn.";
          if (cfAfter < 0) {
            return `At this number the building does not cover its own debt service — ${usd(Math.abs(Math.round(cfAfter / 12)))} a month `
              + `has to come from somewhere else, every month, until something changes. That is a decision, not an accident.`;
          }
          if (dscrAfter !== null && dscrAfter < q.minDSCR) {
            return `Coverage lands at ${dscrAfter.toFixed(2)}x against this desk's ${q.minDSCR.toFixed(2)}x covenant. `
              + `You would be signing a loan that is in breach the day it funds — they sweep the cash flow and start the clock.`;
          }
          if (dscrAfter !== null && dscrAfter < q.minDSCR * 1.15) {
            return `Coverage lands at ${dscrAfter.toFixed(2)}x against a ${q.minDSCR.toFixed(2)}x covenant. That is not much room: `
              + `one tenant leaving takes you through it.`;
          }
          return `Coverage at ${dscrAfter?.toFixed(2)}x with the covenant at ${q.minDSCR.toFixed(2)}x — room to lose a tenant.`;
        })()}
      </div>
      <div className="btn-row">
        <button
          className="btn btn-buy"
          disabled={proceeds < 100_000 || !q.available}
          onClick={() => refi(bbl, picked, lev)}
        >
          {toYou >= 0 ? `Refinance · take ${usd(toYou)}` : `Refinance · pay in ${usd(-toYou)}`}
        </button>
      </div>
    </div>
  );
}
