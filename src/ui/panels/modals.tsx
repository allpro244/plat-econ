import { useState } from "react";
import Slider, { counterPriceBounds } from "@/ui/Slider";
import { useStore } from "@/state/store";
import { monthLabel, CREDIT_LABEL } from "@/engine/types";
import { ownedHoldingValue, ownedMonthlyNoi, resolveRec, collateralAsIs, capRateFor } from "@/engine/value";
import { saleProceedsToSeller } from "@/engine/actions";
import { MILESTONES } from "@/engine/sim";
import { loiSigningCost, exclusiveFeeRate, loiNeedsPrincipal } from "@/engine/leasing";
import { depositFor as auctionDepositFor } from "@/engine/auction";
import { portfolioQuote } from "@/engine/portfolio";
import { fundableNow, locAvailable } from "@/engine/credit";
import { usd } from "@/ui/format";
import { PortfolioCap } from "@/ui/panels/PortfolioPage";
import { physicalOcc, apMid, NWChart, Big, Row } from "@/ui/panels/shared";
import { LoiCounterDraft, LoiTermsGrid, loiMarketPsf } from "@/ui/panels/LoiNegotiate";
import { SaleAcceptConfirm } from "@/ui/panels/SaleConfirm";

/**
 * THE JULY AUCTION — one card, once a year.
 *
 * The docket goes up when the calendar lands on July and the hammer falls on
 * the next tick, so this modal exists for exactly one month. Everything on it
 * is as-is: no diligence, no financing, ten per cent down the day you
 * register. Passing costs nothing but the bargain — "watch from the back"
 * dismisses it and the sale reports itself through the news like any other
 * thing that happened in this town without you.
 */
/**
 * THE LETTER FROM THE LENDER.
 *
 * A foreclosure in this engine already takes a year and a bit — six months of
 * notice, then a filing, then the next July docket at least eight months out —
 * and none of that reached the player as anything but one line of news in a
 * feed six months earlier. Auto-advance ran straight past it. The owner asked
 * for the notice to be a pop-up, in advance, so there is time to sell instead
 * of watching it go to the steps, and that is exactly how it works in life: the
 * default letter arrives long before the filing, and most of what happens next
 * is decided in that window.
 *
 * It fires ONCE per building per stage. Dismissing it is free — the file is on
 * the property page and in the attention list either way — and the popup
 * opt-out is honoured, because a player who has turned cards off has said what
 * they want.
 */
function workoutAwake(g: ReturnType<typeof useStore.getState>["game"], popupsOff: boolean): boolean {
  if (!g || g.gameOver || popupsOff) return false;
  return Object.keys(g.workouts ?? {}).length > 0;
}

export function DefaultNoticeModal() {
  // Idle: do not subscribe to full `game` — walking the book for "rest of CF"
  // on every Advance was one of the click-lag culprits.
  const awake = useStore((s) => workoutAwake(s.game, s.popupsOff));
  const [seen, setSeen] = useState<Record<string, boolean>>({});
  if (!awake) return null;
  return <DefaultNoticeBody seen={seen} setSeen={setSeen} />;
}

function DefaultNoticeBody({
  seen, setSeen,
}: {
  seen: Record<string, boolean>;
  setSeen: (s: Record<string, boolean>) => void;
}) {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels);
  const setPage = useStore((s) => s.setPage);
  const select = useStore((s) => s.select);
  const focus = useStore((s) => s.focus);
  const { serviceWorkout } = useStore.getState();
  if (!parcels || game.gameOver) return null;
  const open = Object.values(game.workouts ?? {})
    .filter((w) => !seen[`${w.bbl}:${w.stage}`])
    .sort((a, b) => (a.saleM ?? a.decideM) - (b.saleM ?? b.decideM))[0];
  if (!open) return null;
  const rec = resolveRec(parcels, game, open.bbl);
  const h = game.holdings[open.bbl];
  if (!rec || !h?.loan) return null;

  const filed = open.stage === "foreclosure";
  const deadline = open.saleM ?? open.decideM;
  const monthsLeft = Math.max(0, deadline - game.month);
  const value = ownedHoldingValue(game, parcels, h);
  const equity = value - open.cure;
  const monthly = Math.round(h.loan.monthlyPmt * 1.15);
  const allowLoc = open.cause !== "covenant";
  const liquidity = Math.max(0, Math.floor(game.cash)) + (allowLoc ? locAvailable(game, parcels) : 0);
  const couponOk = !filed && fundableNow(game, parcels) >= h.loan.monthlyPmt;
  // What the REST of the book throws off, which is the whole question the
  // owner asked: can the other buildings carry this one while you sell it?
  const otherCF = Object.values(game.holdings)
    .filter((x) => x.bbl !== open.bbl)
    .reduce((a, x) => a + ownedMonthlyNoi(game, parcels, x), 0);
  const dismiss = () => setSeen({ ...seen, [`${open.bbl}:${open.stage}`]: true });

  return (
    <div className="modal-backdrop modal-layer-default">
      <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: 660 }}>
        <div className="modal-kicker">{open.lender} · {monthLabel(game.month)}</div>
        <div className="modal-title">
          {filed ? `They have filed on ${rec.address}` : `Notice of default — ${rec.address}`}
        </div>
        <div className="modal-sub">
          {filed
            ? `It is down for the ${monthLabel(deadline)} auction. From here a payment is not a cure — it takes the
               arrears in full, a deed in lieu, or the hammer.`
            : couponOk
              ? `${open.cause === "balloon" ? "The loan has matured without a takeout."
                 : open.cause === "covenant" ? "The building has breached its covenants."
                 : "The payments have been late."} The monthly coupon is fundable — they will not file
                 while you keep it current. Cure it, refinance, or sell in this window.`
              : `${open.cause === "balloon" ? "The loan has matured and there is nothing to repay it with."
                 : open.cause === "covenant" ? "The building has breached its covenants."
                 : "The payments have stopped."} You have ${monthsLeft} month${monthsLeft === 1 ? "" : "s"} before
                 ${open.lender} can file. A building takes six to nine months to sell properly, so this is the window.`}
        </div>
        <div className="grid" style={{ marginTop: 10 }}>
          <Row k="What they want" v={usd(open.cure)} strong />
          <Row k="The building is worth" v={usd(value)} />
          <Row k={equity >= 0 ? "Your equity in it" : "It is under water by"} v={usd(Math.abs(equity))} bad={equity < 0} />
          <Row k={allowLoc ? "Liquidity (cash + line)" : "Cash on hand"} v={usd(liquidity)} bad={liquidity < open.cure} />
          <Row k="The rest of the book earns" v={`${usd(otherCF)} / mo`} />
          <Row k="Keeping this one current costs" v={`${usd(monthly)} / mo at the default rate`}
               bad={monthly > otherCF} />
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          {equity > 0
            ? `There is equity here. Selling it yourself beats the steps by a wide margin — the auction is a legal
               process with a calendar and it gets less than a distress sale does.`
            : `There is no equity left. A deed in lieu hands it back with a smaller mark than a foreclosure and no
               deficiency, which is usually the right answer on paper like this.`}
          {!filed && otherCF > monthly
            ? ` The rest of the book covers the payment ${(otherCF / Math.max(1, monthly)).toFixed(1)} times over —
                you can carry it while you find a buyer.`
            : ""}
        </div>
        <div className="btn-row" style={{ marginTop: 12, flexWrap: "wrap" }}>
          {!filed && !open.servicing && (
            <button className="btn btn-primary" onClick={() => { serviceWorkout(open.bbl, true); dismiss(); }}>
              Keep it current · {usd(monthly)}/mo
            </button>
          )}
          <button className="btn" onClick={() => { select(open.bbl); focus(open.bbl, true); setPage("property"); dismiss(); }}>
            Open the file
          </button>
          <button className="btn" onClick={dismiss}>Not now</button>
        </div>
      </div>
    </div>
  );
}

function auctionAwake(s: ReturnType<typeof useStore.getState>): boolean {
  const g = s.game;
  if (!g || g.gameOver) return false;
  if (g.auctionResults?.rows?.length) return true;
  const a = g.auction;
  if (!a || g.month >= a.m) return false;
  // Keep the subscriber alive when they asked for the sheet, or when the card
  // would still auto-open. Quiet/popups-off with no request stays cold.
  return s.auctionOpen || (!s.popupsOff && !g.auctionQuiet);
}

export function AuctionModal() {
  const awake = useStore(auctionAwake);
  const [seenM, setSeenM] = useState(-1);
  const [seenResM, setSeenResM] = useState(-1);
  const [bids, setBids] = useState<Record<string, string>>({});
  if (!awake) return null;
  return (
    <AuctionBody
      seenM={seenM} setSeenM={setSeenM}
      seenResM={seenResM} setSeenResM={setSeenResM}
      bids={bids} setBids={setBids}
    />
  );
}

function AuctionBody({
  seenM, setSeenM, seenResM, setSeenResM, bids, setBids,
}: {
  seenM: number; setSeenM: (n: number) => void;
  seenResM: number; setSeenResM: (n: number) => void;
  bids: Record<string, string>; setBids: (b: Record<string, string>) => void;
}) {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels);
  const focus = useStore((s) => s.focus);
  const auctionOpen = useStore((s) => s.auctionOpen);
  const popupsOff = useStore((s) => s.popupsOff);
  const setAuctionOpen = useStore((s) => s.setAuctionOpen);
  const { bidAuction } = useStore.getState();

  /* WHAT THE HAMMER DID TO YOUR NUMBER. You registered a bid, the sheet
     closed, and the only record of whether you owned a building was a line on
     the news ticker. The engine decided won / outbid / paid-off / could-not-
     close all along; this is that decision, said to the person who made it. */
  const res = game.auctionResults;
  if (res && res.rows.length && seenResM !== res.m && !popupsOff) {
    const WORD: Record<string, [string, string]> = {
      won: ["YOU TOOK IT", ""],
      outbid: ["OUTBID", " neg"],
      paidoff: ["PAID OFF IN FULL", ""],
      nocash: ["YOU COULD NOT CLOSE", " neg"],
      pulled: ["PULLED FROM THE DOCKET", ""],
      lostyours: ["YOUR BUILDING WAS SOLD", " neg"],
    };
    return (
      <div className="modal-backdrop modal-layer-auction">
        <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: 660 }}>
          <div className="modal-kicker">The hammer fell · {monthLabel(res.m)}</div>
          <div className="modal-title">{res.rows.length} lot{res.rows.length === 1 ? "" : "s"} you had a number on</div>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Lot</th><th>Outcome</th><th className="num">Your bid</th><th className="num">Hammer</th><th>Who took it</th></tr>
            </thead>
            <tbody>
              {res.rows.map((r) => (
                <tr key={r.bbl}>
                  <td style={{ cursor: "pointer" }} onClick={() => focus(r.bbl, true)}>{r.address}</td>
                  <td className={"mono" + (WORD[r.outcome]?.[1] ?? "")}>{WORD[r.outcome]?.[0] ?? r.outcome}</td>
                  <td className="num">{r.yourBid > 0 ? usd(r.yourBid) : "—"}</td>
                  <td className="num">{r.price > 0 ? usd(r.price) : "—"}</td>
                  <td className="dim">{r.winner ?? (r.outcome === "won" ? "you" : "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.rows.map((r) => r.note && (
            <div key={r.bbl} className="hint" style={{ marginTop: 6 }}><b>{r.address}</b> — {r.note}</div>
          ))}
          <div className="modal-actions">
            <button className="btn btn-buy" onClick={() => { setSeenResM(res.m); useStore.setState({ game: { ...game, auctionResults: undefined } }); }}>
              Right
            </button>
          </div>
        </div>
      </div>
    );
  }

  const a = game.auction;
  if (!parcels || game.gameOver || !a || game.month >= a.m) return null;
  // A player who has turned the card off still gets the auction — the docket
  // is on Marketplace and the bidding is the same — they just do not get it
  // thrown at them. Opening it from that page sets `auctionOpen`, and that
  // request beats BOTH of the reasons the sheet would otherwise stay shut:
  // having dismissed it once this month, and having turned the card off for
  // good. Asking for something and not getting it is the one outcome an
  // opt-out must never produce.
  if (auctionOpen) { /* they asked for it */ }
  else if (seenM === a.m || game.auctionQuiet || popupsOff) return null;

  const parsed: Record<string, number> = {};
  for (const [id, v] of Object.entries(bids)) {
    const n = Math.round(parseFloat(v) * 1e6);
    if (n > 0) parsed[id] = n;
  }
  const dep = a.lots.reduce((acc, l) => acc + (parsed[l.id] ? auctionDepositFor(l, parsed[l.id]) : 0), 0);
  const kindWord = (k: string) =>
    k === "note" ? "your foreclosure" : k === "yours" ? "YOUR BUILDING" : k === "bank" ? "bank foreclosure" : "receiver's lot";
  return (
    <div className="modal-backdrop modal-layer-auction">
      <div className="modal" role="dialog" aria-modal="true" style={{ maxWidth: 720 }}>
        <div className="modal-kicker">The county foreclosure auction · {monthLabel(game.month)}</div>
        <div className="modal-title">
          {a.lots.length} lot{a.lots.length === 1 ? "" : "s"} cross the block
          {/* THE ONE NUMBER YOU BID AGAINST. It was buried under the table in a
              dim line that only appeared once you had typed something, so the
              sheet asked for a number while hiding the constraint on it. */}
          <span className="mono dim" style={{ float: "right", fontSize: 15 }}>cash {usd(game.cash)}</span>
        </div>
        <div className="modal-sub">
          As-is, where-is. Ten per cent down when you register, the balance at the hammer, no financing and no
          warranty. A lender's debt bids for it without cash — beat the debt and the lender is simply paid off,
          with anything above it going to the borrower who just lost the building.
        </div>
        <table className="tbl" style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Lot</th><th>What it is</th><th className="num">NOI / yr</th><th className="num">Occ</th>
              <th className="num">Debt / floor</th><th className="num">Flyer est.</th><th className="num">Your bid ($M)</th></tr>
          </thead>
          <tbody>
            {a.lots.map((l) => (
              <tr key={l.id}>
                <td style={{ cursor: "pointer" }} onClick={() => focus(l.bbl, true)}>{l.address}</td>
                <td className={l.kind === "yours" ? "neg" : "dim"}>
                  {kindWord(l.kind)} · {l.holder}{l.borrower && l.kind !== "yours" ? ` v. ${l.borrower}` : ""}
                </td>
                {/* WHAT YOU ARE ACTUALLY BUYING. The sheet quoted the debt and a
                    flyer estimate — the seller's two numbers — and neither of
                    the two a buyer underwrites. These are read off the same
                    receiver's-condition basis `playerTakes` will hand you if you
                    win: worn, at the borrower's occupancy, not the clean
                    appraisal. Bidding blind on income was the whole complaint. */}
                {(() => {
                  const rec = resolveRec(parcels, game, l.bbl);
                  if (!rec || rec.class === "land" || !rec.bldgArea) {
                    return (<><td className="num dim">site</td><td className="num dim">—</td></>);
                  }
                  const borrower = game.rivals?.find((x) => x.id === l.borrowerId);
                  const occ = l.kind === "yours"
                    ? physicalOcc(rec as never, game.holdings[l.bbl]!)
                    : Math.max(0.15, Math.min(0.95, borrower?.occ ?? 0.4));
                  // The engine's own receiver basis: worn condition, scaled by
                  // the borrower's occupancy. Capitalised back through the
                  // building's cap rate so the row shows income rather than a
                  // second opinion about value. One source, two readings.
                  const asIs = collateralAsIs(rec, game.econ, occ);
                  const cap = capRateFor(rec, game.econ, "worn");
                  const noi = cap > 0 ? Math.round(asIs * cap / 100) : 0;
                  return (
                    <>
                      <td className="num" title="Underwritten worn and at the borrower's occupancy — what a receiver's building actually earns, not the clean appraisal">
                        {noi > 0 ? usd(noi) : <span className="neg">{usd(noi)}</span>}
                      </td>
                      <td className={"num" + (occ < 0.6 ? " neg" : "")}>{(occ * 100).toFixed(0)}%</td>
                    </>
                  );
                })()}
                <td className="num">{usd(l.kind === "receiver" ? l.upset : l.debt)}</td>
                <td className="num">{usd(l.est)}</td>
                <td className="num">
                  {l.kind === "yours"
                    ? <span className="dim" title="You do not bid on your own foreclosure — cure it, hand back the keys, or let the room decide.">—</span>
                    : <input className="mono" style={{ width: 72, textAlign: "right" }} inputMode="decimal"
                        placeholder={l.kind === "note" ? "credit" : (l.upset / 1e6).toFixed(2)}
                        value={bids[l.id] ?? ""}
                        onChange={(e) => setBids({ ...bids, [l.id]: e.target.value })} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dim" style={{ marginTop: 6 }}>
          {Object.keys(parsed).length
            ? <>Deposits due today: <b className="mono">{usd(dep)}</b> against {usd(game.cash)} of cash.</>
            : a.lots.some((l) => l.kind === "note")
              ? "Your debt already bids on your own lots — enter a number only to protect the building above it."
              : "Enter a number to bid, or watch from the back. Most years, watching is right."}
        </div>
        <div className="modal-actions">
          <button className="btn btn-buy" disabled={!Object.keys(parsed).length || dep > game.cash}
            onClick={() => { bidAuction(parsed); setSeenM(a.m); setAuctionOpen(false); }}>
            Register bids{dep > 0 ? ` · ${usd(dep)} down` : ""}
          </button>
          <button className="btn" onClick={() => { setSeenM(a.m); setAuctionOpen(false); }}>Watch from the back</button>
          {/* THE CARD IS NOT THE AUCTION. Turning this off stops the interruption
              and nothing else — so it has to say, in the same breath, where the
              docket went and how to get the card back. An opt-out that leaves
              the player unable to find the thing again is a trap. */}
          {!game.auctionQuiet && (
            <button
              className="btn"
              title="The docket still runs every July. You just read it on your own time."
              onClick={() => {
                const st = useStore.getState();
                useStore.setState({ game: { ...st.game!, auctionQuiet: true } });
                setSeenM(a.m);
                setAuctionOpen(false);
              }}
            >
              Don't show me this again
            </button>
          )}
        </div>
        <div className="modal-queue">
          The hammer falls at the end of the month. Results come through the news, win or lose.
          {" "}The docket is always on <b>Marketplace</b> while it is live, and the switch for this card sits
          beside it there — so turning it off costs you nothing but the interruption.
        </div>
      </div>
    </div>
  );
}

/**
 * THE THREE THINGS THIS GAME STILL INTERRUPTS YOU FOR.
 *
 * A broker calling was moved off the modal and onto Marketplace last pass, and
 * that was right: an off-market file runs for a year, it is a DECISION, and a
 * decision with a twelve-month fuse belongs on a page. None of that argument
 * applies to what this card carries. A bank going down, a level event in the
 * real economy, and a lender taking three quarters of your book are not
 * decisions and they are not waiting on you — they have already happened, there
 * is no button that undoes them, and the only reason to put them on the screen
 * is that a player who scrolls past one line of tape has not been told.
 *
 * WHAT THIS COMPONENT KNOWS ABOUT THE WORLD: nothing. The engine raises and the
 * UI renders. `tone` is the only styling instruction it takes and it is an
 * economic fact rather than a colour; the headline, the prose and the one
 * number that matters are all written where the event fires, by the code that
 * knows what happened. If the engine never pushes an alert, `game.alerts` is
 * undefined, this returns null on the first line, and nothing anywhere breaks.
 *
 * A WHITE SWAN IS NOT A WARNING PAINTED GREEN. The good and bad cards differ in
 * more than a colour, because they are read at different speeds: a black swan
 * is something you have to survive and the card's job is to make you stop, and
 * a white swan is something somebody is about to make a great deal of money on
 * and the card's job is to make you want to be that somebody. Same shape, three
 * differences — the rule down the side, the line under the button, and the fact
 * that the good one's dismiss is the affirmative button rather than the plain
 * one.
 *
 * IT IS NOT ON THE POP-UP SWITCH, and that is deliberate rather than an
 * oversight. Settings turns off the DECISION cards, and the reason it costs
 * nothing to turn them off is that every one of them also lives on a page with
 * its own clock — the letters on the Deals desk, the offers on the Portfolio,
 * the calls on Marketplace. These three do not live anywhere you can answer
 * them, because there is nothing to answer. Suppressing one would either lose
 * it outright or queue it up to ambush the player later, and a person who
 * turned cards off to simulate twenty years is exactly the person a bank
 * failure in year nine most needs to stop.
 */
export function AlertModal() {
  const awake = useStore((s) =>
    !s.alertsOff && !s.game?.gameOver && (s.game?.alerts?.length ?? 0) > 0);
  if (!awake) return null;
  return <AlertBody />;
}

function AlertBody() {
  const game = useStore((s) => s.game)!;
  const dismissAlert = useStore((s) => s.dismissAlert);
  const setPage = useStore((s) => s.setPage);
  const a = game.alerts?.[0];
  // A dead firm gets the game-over screen and nothing else on top of it.
  // ...and a player who has asked for total silence gets it. Every alert is
  // filed in the news feed by `raiseAlert` as it fires, so this drops the
  // interruption and not the event — which is the condition the paragraph
  // above sets for a card being safe to turn off.
  if (!a || game.gameOver) return null;
  const bad = a.tone !== "good";
  const KICKER: Record<string, [string, string]> = {
    // [what a bad one is called, what a good one is called]
    swan: ["A black swan", "A white swan"],
    bank: ["A desk has gone down", "The credit window"],
    portfolio: ["The book has been taken", "Your portfolio"],
    ground: ["Ground-lease default", "Your leased fee"],
    sale: ["A sale fell apart", "Bids are in"],
  };
  const kicker = (KICKER[a.kind] ?? ["Something has happened", "Something has happened"])[bad ? 0 : 1];
  const queued = (game.alerts?.length ?? 1) - 1;
  // A seized rival book is inventory, not scenery — the package is on Marketplace.
  const streetBooks = (game.portfolios ?? []).filter((p) => !p.player);
  const goBooks = a.kind === "portfolio" && bad && streetBooks.length > 0;
  // An indication on YOUR book belongs on Portfolio / Deals, not the tape.
  const goOwnBook = a.kind === "portfolio" && !bad && !!game.portfolioSale;
  const goNotes = a.kind === "bank" && bad;
  return (
    <div className={"modal-backdrop alert-back" + (bad ? " alert-tint-bad" : "")}>
      <div className={"modal alert-card " + (bad ? "alert-bad" : "alert-good")} role="dialog" aria-modal="true">
        <div className="alert-kicker">{kicker}</div>
        <div className="modal-title">{a.title}</div>
        <div className="modal-sub">{monthLabel(a.q)}</div>
        <div className="alert-body">{a.body}</div>
        {a.detail && <div className="alert-detail">{a.detail}</div>}
        <div className="alert-foot">
          {goBooks
            ? "The book is for sale on Marketplace under Books for sale — one cash cheque for the whole package. Rivals are looking at it too."
            : goOwnBook
              ? "Open Portfolio or Deals to answer the indication. It will not wait forever."
              : bad
                ? "This is not a decision and there is nothing on this card to accept. It has happened; "
                  + "what it does to your rents, your lenders and your book is the rest of the game."
                : "Nobody rings a bell for one of these either. It is on the tape and in the history, and the "
                  + "people who make money on it are the ones already standing where it lands."}
        </div>
        <div className="modal-actions">
          {goBooks && (
            <button className="btn btn-buy" onClick={() => { dismissAlert(); setPage("market"); }}>
              Open Marketplace · Books for sale
            </button>
          )}
          {goOwnBook && (
            <button className="btn btn-buy" onClick={() => { dismissAlert(); setPage("portfolio"); }}>
              Open Portfolio
            </button>
          )}
          {goNotes && (
            <button className="btn" onClick={() => { dismissAlert(); setPage("notes"); }}>
              Open Notes
            </button>
          )}
          <button className={"btn" + (!goBooks && !goOwnBook && !bad ? " btn-buy" : "")} onClick={dismissAlert}>
            {bad && !goBooks ? "Understood" : goBooks || goOwnBook ? "Later" : "Good."}
          </button>
        </div>
        {queued > 0 && (
          <div className="modal-queue">
            {queued} more {queued === 1 ? "thing" : "things"} happened this month.
          </div>
        )}
      </div>
    </div>
  );
}

// Some decisions don't wait their turn. A letter of intent and a live offer
// on your building both take the screen until you answer — they expire, and
// finding out later that one lapsed while you clicked past it is no fun.
function decisionAwake(g: ReturnType<typeof useStore.getState>["game"], popupsOff: boolean): boolean {
  if (!g || g.gameOver || popupsOff) return false;
  if (g.portfolioSale?.bids?.[0]) return true;
  // Desk-covered letters stay quiet (agent / exclusive / renewals).
  // Ground-leased fees never wake the modal — the lessee is the landlord.
  if (g.lois.some((l) => loiNeedsPrincipal(g, l))) return true;
  for (const h of Object.values(g.holdings)) {
    if (h.sale?.offer) return true;
    // Live bids only — a best-and-final where everyone walked left bids.length
    // > 0 with every row dropped, so the modal still woke and Take errored.
    if ((h.sale?.bids ?? []).some((b) => !b.dropped)) return true;
  }
  return false;
}

export function DecisionModal() {
  // Keep local outcome mounted after a counter resolves (lois may be empty).
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null);
  const awake = useStore((s) => decisionAwake(s.game, s.popupsOff));
  if (!awake && !outcome) return null;
  if (outcome) {
    return (
      <div className="modal-backdrop modal-layer-decision">
        <div className="modal" role="dialog" aria-modal="true">
          <div className={"modal-kicker" + (outcome.ok ? "" : " kicker-inbound")}>
            {outcome.ok ? "Their answer" : "It did not go through"}
          </div>
          <div className="modal-title" style={{ fontSize: 20, lineHeight: 1.35 }}>{outcome.text}</div>
          <div className="modal-actions">
            <button className="btn btn-buy" onClick={() => setOutcome(null)}>Right</button>
          </div>
        </div>
      </div>
    );
  }
  return <DecisionBody setOutcome={setOutcome} />;
}

function DecisionBody({
  setOutcome,
}: {
  setOutcome: (o: { text: string; ok: boolean } | null) => void;
}) {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels);
  const { respondLoi, acceptOffer, declineOffer, counterSale, takeBid, setPage, focus } = useStore.getState();
  const [deferred, setDeferred] = useState<Set<number>>(new Set());
  // Lease counter draft — sliders live in LoiCounterDraft so the modal and
  // the Deals page cannot drift apart.
  const [modalCounter, setModalCounter] = useState(false);
  // …and the same for an offer to buy one of yours. The card had Accept and
  // Decline and nothing between them, so the one move every seller alive makes
  // — pick up the phone once — could only be reached by dismissing the popup
  // and going to find the building's own record. `counterSale` has always
  // handled it, including the unsolicited case; nothing here ever called it.
  const [saleCounter, setSaleCounter] = useState(false);
  const [scPx, setScPx] = useState(0);
  const [saleAcceptConfirm, setSaleAcceptConfirm] = useState<null | { exchange?: boolean }>(null);
  if (!parcels || game.gameOver) return null;

  /* AN INDICATION ON YOUR BOOK IS A DECISION, AND IT ARRIVED SILENTLY.
     A bid on a single building throws this modal; a bid on a portfolio you
     listed did not, so the one trade that moves the most money was the one you
     had to go to Deals and hunt for. Same card, same three answers — the desk
     on the portfolio page still holds the counter slider for a number you want
     to set by hand. */
  const pb = game.portfolioSale?.bids?.[0];
  if (pb && !deferred.has(-2)) {
    const live = game.portfolioSale!;
    const q = portfolioQuote(game, parcels, live.bbls);
    const inside = q.sumOfParts > 0 ? (1 - pb.price / q.sumOfParts) * 100 : 0;
    // Same per-deed waterfall acceptPortfolioBid runs — payoffs, kick, break,
    // facility release, tax — so the button is not the gross bid.
    const marks = live.bbls.map((b) => {
      const h = game.holdings[b];
      return h ? ownedHoldingValue(game, parcels, h) : 0;
    });
    const totalMark = marks.reduce((a, v) => a + v, 0) || 1;
    let netToYou = 0, taxAtClose = 0, releaseTot = 0, loanTot = 0;
    live.bbls.forEach((bbl, i) => {
      const h = game.holdings[bbl];
      if (!h) return;
      const price = Math.round(pb.price * (marks[i] / totalMark));
      const p = saleProceedsToSeller(game, parcels, h, price);
      netToYou += p.toSeller - p.tax;
      taxAtClose += p.tax;
      releaseTot += p.release;
      loanTot += p.loanPayoff + p.breakFee + p.kick;
    });
    return (
      <div className="modal-backdrop modal-layer-decision">
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-kicker">◆ AN INDICATION ON YOUR PORTFOLIO — {live.bbls.length} buildings, one ticket</div>
          <div className="modal-title">{usd(pb.price)} from {pb.name}</div>
          <div className="modal-sub">Good until {monthLabel(pb.expiresM)}. Your ask is {usd(live.ask)}.</div>
          <div className="grid">
            <Row k="Their number" v={usd(pb.price)} strong />
            <Row k="vs. your ask" v={`${((pb.price / Math.max(1, live.ask) - 1) * 100).toFixed(1)}%`} />
            <Row k="Sum of the individual marks" v={usd(q.sumOfParts)} />
            <Row k="Inside the parts" v={`${inside.toFixed(1)}%`} bad={inside > 10} />
            <Row k="Loan / fee payoffs" v={usd(loanTot)} />
            {releaseTot > 0 && <Row k="Facility releases" v={usd(releaseTot)} bad />}
            {taxAtClose > 0 && <Row k="Capital-gains tax" v={usd(taxAtClose)} bad />}
            <Row k="Net to you" v={usd(netToYou)} strong bad={netToYou < 0} />
            <PortfolioCap q={q} ask={pb.price} bbls={live.bbls} />
            {pb.countered && <Row k="Rounds" v="you have been back to them once" bad />}
          </div>
          <div className="hint">
            An institution has a committee number. You can push them a few points and no further, and pushing hard
            on a bundle is how the whole thing goes away — there is another portfolio next quarter and they know it.
          </div>
          <div className="modal-actions">
            <button className="btn btn-buy" onClick={() => { useStore.getState().acceptPortfolio(false); setDeferred((d) => new Set(d).add(-2)); }}>
              Close it · net {usd(netToYou)}
            </button>
            <button className="btn btn-buy" title="Roll the whole gain into a 1031 and redeploy inside six months, or the tax comes due"
              onClick={() => { useStore.getState().acceptPortfolio(true); setDeferred((d) => new Set(d).add(-2)); }}>
              Close into a 1031{taxAtClose > 0 ? ` · defer ${usd(taxAtClose)}` : ""}
            </button>
            {!pb.countered && (
              <button className="btn" title="Set the number by hand on the portfolio desk"
                onClick={() => { setDeferred((d) => new Set(d).add(-2)); useStore.getState().setPage("portfolio"); }}>
                Counter…
              </button>
            )}
            <button className="btn" onClick={() => setDeferred((d) => new Set(d).add(-2))}>Decide later</button>
          </div>
        </div>
      </div>
    );
  }

  // A MARKETED BID LIST — the campaign's whole reason for existing.
  const bidBbl = deferred.has(-3)
    ? undefined
    : Object.keys(game.holdings).find((b) =>
      (game.holdings[b].sale?.bids ?? []).some((x) => !x.dropped));
  if (bidBbl) {
    const h = game.holdings[bidBbl];
    const sale = h.sale!;
    const live = (sale.bids ?? [])
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => !b.dropped);
    const top = live[0]!;
    const second = live[1];
    const rec = resolveRec(parcels, game, bidBbl);
    return (
      <div className="modal-backdrop modal-layer-decision">
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-kicker">◆ BIDS ARE IN — {live.length} name{live.length === 1 ? "" : "s"} on the list</div>
          <div className="modal-title">{usd(top.b.price)} from {top.b.name}</div>
          <div className="modal-sub">
            {rec?.address ?? bidBbl} · your whisper {usd(sale.ask)}
            {second ? ` · second ${usd(second.b.price)}` : ""}
          </div>
          <div className="grid">
            <Row k="Best bid" v={usd(top.b.price)} strong />
            <Row k="vs. whisper" v={`${((top.b.price / Math.max(1, sale.ask) - 1) * 100).toFixed(1)}%`}
              bad={top.b.price < sale.ask} />
            <Row k="On the list" v={`${live.length} bidder${live.length === 1 ? "" : "s"}`} />
            {top.b.note && <Row k="Their paper" v={top.b.note} />}
          </div>
          <div className="hint">
            A bid list lives on the property desk — take the top number, go back for best-and-final, or work a lower name.
            Sitting on it too long is how the whole campaign dies.
          </div>
          <div className="modal-actions">
            <button className="btn btn-buy" onClick={() => { takeBid(bidBbl, top.i); setDeferred((d) => new Set(d).add(-3)); }}>
              Take {top.b.name} · {usd(top.b.price)}
            </button>
            <button className="btn" onClick={() => {
              setDeferred((d) => new Set(d).add(-3));
              focus(bidBbl, true);
              setPage("property");
            }}>
              Open the list…
            </button>
            <button className="btn" onClick={() => setDeferred((d) => new Set(d).add(-3))}>Decide later</button>
          </div>
        </div>
      </div>
    );
  }

  // Only letters the principal still owns interrupt — covered / leased-fee paper is quiet.
  const loiOnDesk = (l: (typeof game.lois)[number]) =>
    !deferred.has(l.id) && loiNeedsPrincipal(game, l);
  const loi = game.lois.find(loiOnDesk);
  const offerBbl = deferred.has(-1) ? undefined : Object.keys(game.holdings).find((b) => game.holdings[b].sale?.offer);
  if (!loi && !offerBbl) return null;

  // THE BROKER'S CALL IS NOT A CARD ANY MORE — it is a row on Marketplace.
  //
  // It used to render here, a full-screen backdrop over whatever page you were
  // reading, and it was the only interruption in the game that was not a
  // deadline: a letter of intent expires in weeks and an offer on your own
  // building expires in weeks, but an off-market file runs for a YEAR (sim.ts
  // deletes the approach at a.q + 12). A decision with a twelve-month fuse does
  // not belong in front of the charts. The whole panel — their number, the
  // spread to appraisal, in-place NOI, the going-in cap off the disclosed roll,
  // the stabilised pro-forma, occupancy, demand — and all three of its actions
  // moved verbatim onto the Marketplace page, where the rest of the tape lives.
  // See BrokerCalls() below. The lapse is unchanged and still runs on the
  // engine's clock whether or not anybody opens that page, so the tab carries a
  // count and every row carries its own countdown.

  if (loi) {
    const rec = resolveRec(parcels, game, loi.bbl);
    const h = game.holdings[loi.bbl];
    if (!rec || !h) return null;
    // Market for THIS letter's use — not the blended building ask. Same desk
    // as DealsPage (LoiNegotiate), so the modal and the page never disagree.
    const market = loiMarketPsf(game, parcels, loi);
    const fee = exclusiveFeeRate(h);
    const cost = loiSigningCost(loi, fee);
    const live = game.lois.filter(loiOnDesk);
    const idx = live.findIndex((l) => l.id === loi.id) + 1;
    const short = Math.max(0, Math.ceil((cost - game.cash) / 1000) * 1000);
    const line = locAvailable(game, parcels);
    const fundable = short > 0 && short <= line;
    // No latch here on purpose. Every branch of respondLOI removes the letter
    // from the desk, so a double click is harmless — and a latch that only
    // cleared when the state changed was locking the whole modal any time an
    // action came back with an error instead of a new state.
    const act = (a: "accept" | "decline") => {
      const r = respondLoi(loi.id, a, short > 0);
      if (r.msg) setOutcome({ text: r.msg, ok: r.ok });
    };
    const isFinal = loi.stage === "countered";
    return (
      <div className="modal-backdrop modal-layer-decision">
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-kicker">
            {loi.referred ? "Referred by your desk · " : ""}
            {loi.kind === "renewal" ? "Renewal on the table" : "Letter of intent"}
            {isFinal ? " · their final answer" : ""}
          </div>
          <div className="modal-title">{loi.name}</div>
          <div className="modal-sub">
            {loi.sector} · credit {CREDIT_LABEL[loi.credit]} · {rec.address}
          </div>
          <LoiTermsGrid loi={loi} game={game} market={market} feeRate={fee} />
          {!modalCounter && (
            <div className="modal-actions">
              <button
                className="btn btn-buy"
                disabled={short > 0 && !fundable}
                title={short > 0 ? (fundable ? `Draws ${usd(short)} on your line to cover the fit-out` : `You are short ${usd(short)} and the line only has ${usd(line)} left`) : undefined}
                onClick={() => act("accept")}
              >
                {short > 0 && fundable ? `Draw ${usd(short)} and sign` : isFinal ? `Take their final · ${usd(cost)}` : `Sign the lease · ${usd(cost)}`}
              </button>
              {!isFinal && !loi.countered && (
                <button className="btn" title="Name your own rent, TI, free months and annual bump." onClick={() => setModalCounter(true)}>
                  Counter…
                </button>
              )}
              <button className="btn" onClick={() => act("decline")}>Pass</button>
              <button
                className="btn"
                title="Leave it on the desk and get back to it — it stays on the Deals page until it expires."
                onClick={() => setDeferred((d) => new Set(d).add(loi.id))}
              >
                Decide later
              </button>
            </div>
          )}
          {modalCounter && !isFinal && !loi.countered && (
            <LoiCounterDraft
              loi={loi}
              market={market}
              feeRate={fee}
              fundShort={short > 0}
              onSend={(c) => {
                const r = respondLoi(loi.id, "counter", short > 0, c);
                if (r.msg) setOutcome({ text: r.msg, ok: r.ok });
                setModalCounter(false);
              }}
              onBack={() => setModalCounter(false)}
            />
          )}
          <div className="modal-queue">
            {idx} of {live.length} on the desk
            {short > 0 && (fundable
              ? ` · the fit-out is ${usd(short)} more than your cash, so signing draws it on the line`
              : ` · you are ${usd(short)} short and the line has ${usd(line)} left — counter or sell something`)}
          </div>
        </div>
      </div>
    );
  }

  const h = game.holdings[offerBbl!]!;
  const rec = resolveRec(parcels, game, offerBbl!);
  const offer = h.sale!.offer!;
  if (!rec || !parcels) return null;
  // Same waterfall acceptSaleOffer runs — loan, kicker, break fee, facility release, tax.
  const proceeds = saleProceedsToSeller(game, parcels, h, offer.price);
  const cashAtClose = proceeds.toSeller - (game.exchange ? 0 : proceeds.tax);
  const value = ownedHoldingValue(game, parcels, h);
  const counterBounds = (() => {
    const b = counterPriceBounds(offer.price, apMid(offerBbl!, value));
    return { ...b, min: Math.max(b.min, offer.price + b.step) };
  })();
  if (saleAcceptConfirm) {
    return (
      <SaleAcceptConfirm
        address={rec.address}
        price={offer.price}
        net={cashAtClose}
        exchange={saleAcceptConfirm.exchange}
        onCancel={() => setSaleAcceptConfirm(null)}
        onConfirm={() => {
          acceptOffer(offerBbl!, saleAcceptConfirm.exchange);
          setSaleAcceptConfirm(null);
        }}
      />
    );
  }
  return (
    <div className="modal-backdrop modal-layer-decision">
      <div className="modal" role="dialog" aria-modal="true">
        {/* WHICH DIRECTION THIS DEAL POINTS, before anything else on the card.
            An offer to buy YOUR building and a letter of intent you sent for
            somebody else's arrive in the same modal shape, and the player has
            to know inside a second which one they are looking at — the money
            moves the opposite way. The unsolicited ones get the strongest form
            of it because nothing on screen led up to them. */}
        <div className={"modal-kicker" + (h.sale!.unsolicited ? " kicker-inbound" : "")}>
          {h.sale!.unsolicited
            ? "◆ SOMEBODY WANTS TO BUY THIS FROM YOU — you did not list it"
            : "Offer in hand — they are buying, you are selling"}
        </div>
        <div className="modal-title">{usd(offer.price)} for {rec.address}</div>
        <div className="modal-sub">Good until {monthLabel(offer.expiresM)}. Your ask is {usd(h.sale!.ask)}.</div>
        <div className="grid">
          <Row k="Offer" v={usd(offer.price)} strong />
          <Row k="vs. your ask" v={`${((offer.price / h.sale!.ask - 1) * 100).toFixed(1)}%`} />
          <Row k="vs. appraisal" v={`${((offer.price / apMid(offerBbl!, value) - 1) * 100).toFixed(1)}%`} />
          <Row k="Loan payoff" v={usd(proceeds.loanPayoff)} />
          {proceeds.breakFee > 0 && <Row k="Break fee" v={usd(proceeds.breakFee)} bad />}
          {proceeds.kick > 0 && <Row k="Lender kicker" v={usd(proceeds.kick)} bad />}
          {proceeds.release > 0 && <Row k="Facility release" v={usd(proceeds.release)} bad />}
          <Row k="Gain over basis" v={usd(proceeds.gain)} bad={proceeds.gain < 0} />
          {proceeds.tax > 0 && <Row k="Capital-gains tax" v={usd(proceeds.tax)} bad />}
          <Row k="Net to you" v={usd(cashAtClose)} strong bad={cashAtClose < 0} />
        </div>
        <div className="modal-actions">
          <button className="btn btn-buy" onClick={() => setSaleAcceptConfirm({})}>
            Accept · net {usd(cashAtClose)}
          </button>
          {proceeds.tax > 0 && !game.exchange && (
            <button className="btn btn-buy" title="Roll the gain into your next purchase within 6 months" onClick={() => setSaleAcceptConfirm({ exchange: true })}>
              1031 · defer {usd(proceeds.tax)}
            </button>
          )}
          {!offer.countered && !saleCounter && (
            <button className="btn" onClick={() => { setScPx(Math.round(offer.price * 1.06)); setSaleCounter(true); }}>
              Counter…
            </button>
          )}
          <button className="btn" onClick={() => declineOffer(offerBbl!)}>Decline</button>
          <button className="btn" title="Leave it — it stays live until it expires." onClick={() => setDeferred((d) => new Set(d).add(-1))}>
            Decide later
          </button>
        </div>
        {offer.countered && (
          <div className="modal-queue">You have been back to them once. This number is the number.</div>
        )}
        {saleCounter && !offer.countered && (
          <>
            <Slider
              label="Counter"
              value={scPx || Math.round(offer.price * 1.06)}
              min={counterBounds.min}
              max={counterBounds.max}
              step={counterBounds.step}
              editable="price"
              onChange={setScPx}
              format={(v) => `${usd(v)} · +${((v / offer.price - 1) * 100).toFixed(1)}% on their bid`}
              marks={[
                { at: Math.round(offer.price * 1.03), label: "+3%" },
                { at: Math.round(offer.price * 1.08), label: "+8%" },
                { at: h.sale!.ask, label: "ask" },
              ]}
              hint="Name any price above their bid. Well over appraisal and they may walk."
            />
            <div className="modal-actions">
              <button className="btn" onClick={() => { counterSale(offerBbl!, scPx || Math.round(offer.price * 1.06)); setSaleCounter(false); }}>
                Counter at {usd(scPx || Math.round(offer.price * 1.06))}
              </button>
              <button className="btn" onClick={() => setSaleCounter(false)}>Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function GameOverPage() {
  const game = useStore((s) => s.game)!;
  const over = game.gameOver!;
  const peak = Math.max(...game.nwHistory);
  const finalNw = game.nwHistory[game.nwHistory.length - 1] ?? 0;
  const realized = game.exits.reduce((a, e) => a + e.gain, 0);
  const miles = Object.keys(game.milestones ?? {}).length;
  return (
    <div className="page-backdrop">
      <div className="page gameover-page">
        {/* `over.complete` was never assigned by anything — the century stopped
            being an ending when it became a marker you pass (see the milestone
            in sim.ts, "It used to set gameOver and stop the run cold"), and
            this branch was left behind. The only way the run ends is
            insolvency, so that is the only title there is. */}
        <div className="page-title">The run is over.</div>
        <p style={{ maxWidth: 640, margin: "10px auto" }}>{over.cause}</p>
        <NWChart data={game.nwHistory} height={140} />
        <div className="stat-strip" style={{ justifyContent: "center", marginTop: 14 }}>
          <Big label="Final net worth" value={usd(finalNw)} bad={finalNw < 0} />
          <Big label="Peak" value={usd(peak)} />
          <Big label="Realized gains" value={usd(realized)} bad={realized < 0} />
          <Big label="Exits" value={String(game.exits.length)} />
          <Big label="Taxes paid" value={usd(game.taxesPaid ?? 0)} />
          <Big label="Milestones" value={`${miles} / ${MILESTONES.length}`} />
        </div>
        {/* THE RUN IS OVER IS NOT THE SAME AS THE CITY IS OVER.
            The only way out of this screen was "Start a new run", which rerolls
            the seed — so the town you had just spent forty years in stopped
            existing at the exact moment you wanted to go back three years and
            do it differently. Worse, the Saves page opened
            correctly UNDERNEATH this card and every button on it was
            unclickable, so it looked like the game had simply eaten your
            saves. */}
        <div className="btn-row" style={{ marginTop: 16, justifyContent: "center" }}>
          <button className="btn" onClick={() => useStore.getState().setPage("saves")}
            title="Go back to an earlier save of this same town">
            ⛁ Load an earlier save
          </button>
          <button className="btn btn-buy" onClick={() => useStore.getState().newRun()}>Start a new run</button>
        </div>
        <div className="hint" style={{ textAlign: "center", marginTop: 10 }}>
          Starting a new run rolls a new town. An earlier save of THIS town rebuilds it exactly as it was.
        </div>
      </div>
    </div>
  );
}

// The net-worth line, drawn plainly: a century in one stroke.
