// Buy, sell, list, ground lease, disclosed roll, vacant possession.
// Extracted from ParcelDesk so the property shell stays readable.
import { useState } from "react";
import Slider, { widePriceBounds, counterPriceBounds } from "@/ui/Slider";
import { useStore } from "@/state/store";
import { useHeldGame } from "@/ui/heldGame";
import { monthLabel, CREDIT_LABEL } from "@/engine/types";
import type { Approach, BuiltClass, GroundReview } from "@/engine/types";
import {
  assetValue, initialCondition, holdingNOIYr, resolveRec, useRentPsfYr, operatingStatement,
  recoveryOf, inPlace, proFormaNOIYr, disclosureFor, asIfOwned, ownedHoldingNoiYr, isLeasedFee,
} from "@/engine/value";
import { demolitionCost } from "@/engine/dev";
import {
  buyQuote, saleTaxQuote, quietFeeRate, groundLeaseQuote,
  GROUND_REVIEW_LABEL, GROUND_TERM_MIN, GROUND_TOWER_TERM_MIN,
} from "@/engine/actions";
import { sellerOf, sellerProfile, MAX_TALKS, DEPOSIT_PCT } from "@/engine/acquire";
import { unitStatus, buyoutQuote, BUYOUT_PREMIUM } from "@/engine/leasing";
import { PRODUCTS } from "@/engine/debt";
import { coldOnDeed, coldRefuseMsg } from "@/engine/owners";
import { mixOf, uses as usesOf, useSf } from "@/engine/mix";
import { gradeOf } from "@/engine/rivals";
import { usd, sf } from "@/ui/format";
import { SaleAcceptConfirm } from "@/ui/panels/SaleConfirm";
import { useLabel, physicalOcc, band, apMid, annualPayment, Row } from "@/ui/panels/shared";

/**
 * EMPTYING A BUILDING. Lifted out of the leasing desk so the three moves sit
 * together and in the order you make them: stop signing, pay the sitting
 * tenants to go, take it down. The wrecker's number is on the same row as the
 * tenants' number because the sum of the two is the real cost of the dirt —
 * which is exactly why the site under a well-let building is worth less than
 * the site under a half-empty one.
 */
export function VacantPossession({ bbl, onRaze }: { bbl: string; onRaze: () => void }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const h = game.holdings[bbl];
  const rec = h ? resolveRec(parcels, game, bbl) : null;
  if (!h || !rec) return null;

  const bq = buyoutQuote(game, bbl);
  const occupied = (bq?.tenants ?? 0) > 0 || (h.occ ?? 0) > 0.02;
  const resSf = useSf(rec as never, "multifamily") * (h.occ ?? 0);
  const resCost = Math.round(resSf * useRentPsfYr(rec, game.econ, h.condition, "multifamily") * BUYOUT_PREMIUM);
  const clearCost = (bq?.cost ?? 0) + resCost;
  const demoCost = demolitionCost(rec, game);
  // The engine's own bar for a wrecking permit. Named on the button rather
  // than discovered by clicking it — see raze in actions.ts.
  const occNow = physicalOcc(rec as never, h);
  const canRaze = occNow < 0.20;

  return (
    <div className="deal">
      <div className="deal-head">Emptying the building</div>
      <div className="grid">
        <Row k="Letting" v={h.leasingHold ? "STOPPED — nobody new, nobody renewed" : "Open — new tenants and renewals"} bad={h.leasingHold} />
        <Row k="Occupied" v={(occNow * 100).toFixed(0) + "%"} />
        {occupied && <Row k="In place" v={`${bq?.tenants ?? 0} lease${(bq?.tenants ?? 0) === 1 ? "" : "s"}${resSf > 900 ? ` · ${sf(Math.round(resSf))} of let flats` : ""}`} />}
        {occupied && h.tenants.length > 0 && (
          <Row k="Longest lease runs to" v={monthLabel(Math.max(...h.tenants.map((t) => t.endM)))} />
        )}
        {occupied && <Row k="Cost to buy them all out" v={usd(clearCost)} strong />}
        <Row k="Demolition" v={usd(demoCost)} />
        {occupied && <Row k="Vacant dirt costs you" v={usd(clearCost + demoCost)} strong bad={clearCost + demoCost > game.cash} />}
      </div>
      <div className="btn-row">
        <button className={"btn" + (h.leasingHold ? " btn-on" : "")}
          onClick={() => useStore.getState().holdLeasing(bbl, !h.leasingHold)}
          title={h.leasingHold
            ? "Start letting again — new prospects and renewals resume next month"
            : "Sign nobody new and renew nobody. The roll runs off and the income with it."}>
          {h.leasingHold ? "Resume letting" : "Stop letting"}
        </button>
        {occupied && clearCost > 0 && (
          <button className="btn btn-sell" disabled={clearCost > game.cash}
            onClick={() => useStore.getState().buyOutLeases(bbl)}
            title={`Every remaining month of every contract, plus ${((BUYOUT_PREMIUM - 1) * 100).toFixed(0)}% for making them move`}>
            Buy out every lease · {usd(clearCost)}
          </button>
        )}
        <button
          className="btn btn-sell"
          disabled={!canRaze}
          title={canRaze
            ? "Clear the site back to dirt so you can rebuild to the full envelope."
            : `The building is ${(occNow * 100).toFixed(0)}% let. Nobody signs a wrecking permit over sitting tenants — it has to be under 20%.`}
          onClick={onRaze}
        >
          Demolish · {usd(demoCost)}
        </button>
      </div>
      {occupied && bq && bq.rows.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Tenant</th><th className="num">Left</th><th className="num">Rent / yr</th><th className="num">Buyout</th></tr></thead>
          <tbody>
            {bq.rows.slice(0, 8).map((r, i) => (
              <tr key={i} style={{ cursor: "default" }}>
                <td>{r.name}</td>
                <td className="num">{(r.monthsLeft / 12).toFixed(1)} yrs</td>
                <td className="num">{usd(r.annual)}</td>
                <td className="num">{usd(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {clearCost > game.cash && occupied && (
        <div className="hint">Short {usd(clearCost - game.cash)} of what it takes to clear it.</div>
      )}
    </div>
  );
}

/**
 * THE RENT ROLL, BEFORE YOU BID.
 *
 * "There will be no hidden or guessing work in the noi or occupancy when
 * buying a property. You need to know exactly what you are buying." The engine
 * prices the disclosed roll now; this is the roll itself, on the page where
 * the decision is taken — every lease, the tenant, the square feet, the
 * contract rent, the recovery structure and the expiry date, plus what is
 * vacant. It is the same object the deed conveys (Listing.roll, Approach.roll),
 * so nothing here can disagree with what you own tomorrow morning.
 *
 * THE BOUNDARY IS DELIBERATE. Everything on this card is the PRESENT and it is
 * exact. Whether any of these tenants renews when their date comes, what the
 * vacant feet re-let for, and where the market goes are not on it and must not
 * be — that risk is the business, and it is the only thing you are actually
 * being asked to have a view about.
 */
export function DisclosedRoll({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const rec = resolveRec(parcels, game, bbl);
  if (!rec || rec.class === "land" || !rec.bldgArea) return null;
  const d = disclosureFor(game, bbl);
  if (!d) {
    return (
      <div className="deal">
        <div className="deal-head">No rent roll</div>
        <div className="hint">
          Nobody is selling this building and nobody has shown you anything. The occupancy and income
          on this page are the class model's read on a building like this one, not a fact about this
          one. Ring the owner and the paper comes over with the conversation.
        </div>
      </div>
    );
  }
  const li = game.listings.find((l) => l.bbl === bbl);
  const px = li?.ask ?? game.approaches[bbl]?.ask ?? assetValue(rec, game.econ, gradeOf(game, rec));
  const h = asIfOwned(game, bbl, px, d, rec);
  const st = operatingStatement(rec, game.econ, h, game.month);
  const roll = [...(d.roll ?? [])].sort((a, b) => b.sf - a.sf);
  const commSf = Math.round(rec.bldgArea * (1 - (mixOf(rec).multifamily ?? 0)));
  const resSf = Math.round(useSf(rec, "multifamily"));
  const vacant = Math.max(0, commSf - roll.reduce((a, t) => a + t.sf, 0));
  return (
    <div className="deal">
      <div className="deal-head">
        The rent roll, as disclosed · {(physicalOcc(rec as never, h) * 100).toFixed(0)}% let
      </div>
      <div className="hint">
        {li ? "Off the offering memorandum." : "The owner's roll, sent over with the conversation."}{" "}
        This is what the deed conveys — the same leases, the same rents, the same dates.
        Whether any of them renews is not in here, and that is the deal you are being offered.
      </div>
      {roll.length > 0 && (
        <div className="roll">
          {roll.map((t, i) => {
            const yrsLeft = (t.endM - game.month) / 12;
            return (
              <div key={i} className="roll-row">
                <span className="roll-name">
                  {t.name} <span className="roll-credit mono">{CREDIT_LABEL[t.credit]}</span>
                </span>
                <span className="roll-meta mono">
                  {(t.sf / 1000).toFixed(1)}k sf · ${t.rentPsf.toFixed(0)} {recoveryOf(t).toUpperCase()} · exp {monthLabel(t.endM)}
                  {yrsLeft < 2 && <> · <span className="warn">{yrsLeft <= 0 ? "holding over" : `${yrsLeft.toFixed(1)} yrs left`}</span></>}
                </span>
              </div>
            );
          })}
          {vacant > 400 && (
            <div className="roll-row roll-vacant">
              <span className="roll-name">Vacant</span>
              <span className="roll-meta mono">
                {(vacant / 1000).toFixed(1)}k sf · ${useRentPsfYr(rec, game.econ, h.condition, (usesOf(rec).find((u) => u !== "multifamily") ?? "office") as BuiltClass).toFixed(0)}/sf market here
              </span>
            </div>
          )}
          {resSf > 0 && (
            <div className="roll-row roll-group">
              <span className="roll-name">apartments · {sf(resSf)}</span>
              <span className="roll-meta mono">{((d.occ ?? 0) * 100).toFixed(0)}% let</span>
            </div>
          )}
        </div>
      )}
      {roll.length === 0 && resSf === 0 && (
        <div className="hint">Not one square foot of it is let. That is the whole of the disclosure.</div>
      )}
      {/* THE TRAILING TWELVE, LINE BY LINE. Same statement the engine runs on a
          building you own — see operatingStatement — so the income you are
          shown before the closing and the income you are shown after it are
          one function, not two that agree. Property tax is struck at the price
          on the table, because a sale reassesses. */}
      <div className="grid" style={{ marginTop: 8 }}>
        <Row k="Base rent" v={usd(st.baseRent)} />
        {st.recoveredOpex + st.recoveredTax > 0 && <Row k="Recoveries" v={usd(st.recoveredOpex + st.recoveredTax)} />}
        <Row k="Effective gross income" v={usd(st.egi)} />
        <Row k="Operating expenses" v={"−" + usd(st.opex)} />
        <Row k="Management" v={"−" + usd(st.mgmt)} />
        <Row k={`Property tax at ${usd(px)}`} v={"−" + usd(st.tax)} />
        <Row k="In-place NOI / yr" v={usd(st.noi)} strong bad={st.noi < 0} />
        <Row k="Going-in cap at that price" v={px > 0 ? ((st.noi / px) * 100).toFixed(2) + "%" : "—"} strong />
      </div>
    </div>
  );
}

export function SaleSection({ bbl, value }: { bbl: string; value: number }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const { listSale, delistSale, acceptOffer, declineOffer, counterSale, runBestAndFinal, takeBid } = useStore.getState();
  const holding = game.holdings[bbl]!;
  const [ask, setAsk] = useState<string>("");
  const [counter, setCounter] = useState(0);
  // which bidder you are going back to privately, and at what number
  const [counterOn, setCounterOn] = useState<number | null>(null);
  const [counterPx, setCounterPx] = useState(0);
  const [acceptConfirm, setAcceptConfirm] = useState<null | { exchange?: boolean; bidIndex?: number }>(null);
  const sale = holding.sale;
  const exchangeBusy = !!game.exchange;
  if (sale) {
    const tq = sale.offer ? saleTaxQuote(holding, sale.offer.price) : null;
    const closeNet = (px: number) => {
      const q = saleTaxQuote(holding, px);
      return q.net - (holding.loan?.balance ?? 0) - q.tax;
    };
    const counterBounds = sale.offer
      ? (() => {
          const b = counterPriceBounds(sale.offer.price, apMid(bbl, value));
          return { ...b, min: Math.max(b.min, sale.offer!.price + b.step) };
        })()
      : null;
    const bidCounterBounds = (i: number) => {
      const p = sale.bids![i].price;
      const b = counterPriceBounds(p, apMid(bbl, value));
      return { ...b, min: Math.max(b.min, p + b.step) };
    };
    return (
      <div className="deal">
        {acceptConfirm && (() => {
          const px = acceptConfirm.bidIndex !== undefined
            ? sale.bids![acceptConfirm.bidIndex].price
            : sale.offer!.price;
          return (
            <SaleAcceptConfirm
              address={parcels[bbl]?.address ?? bbl}
              price={px}
              net={closeNet(px)}
              exchange={acceptConfirm.exchange}
              onCancel={() => setAcceptConfirm(null)}
              onConfirm={() => {
                if (acceptConfirm.bidIndex !== undefined) takeBid(bbl, acceptConfirm.bidIndex);
                else acceptOffer(bbl, acceptConfirm.exchange);
                setAcceptConfirm(null);
              }}
            />
          );
        })()}
        <div className="deal-head">For sale · listed {monthLabel(sale.listedM)}</div>
        <div className="grid">
          <Row k={sale.mode === "marketed" ? "Whisper price" : "Your ask"} v={usd(sale.ask)} strong />
          <Row k="vs. appraisal" v={((sale.ask / apMid(bbl, value) - 1) * 100).toFixed(1) + "%"} />
          <Row k="Process" v={sale.mode === "marketed" ? "Marketed campaign · 2.5% fee" : "Quiet listing · 1.5% fee"} />
          {sale.callM !== undefined && <Row k="Offers due" v={monthLabel(sale.callM)} strong />}
        </div>
        {/* THE BID LIST. Everybody who turned up, at once. The spread across
            it is the information: tight means the market agrees with you and
            there is nothing more to get; wide means the top bidder wants it
            much more than the rest, which is exactly when going back to them
            is worth the risk of losing them. */}
        {sale.bids?.length ? (
          <>
            <div className="page-section" style={{ marginTop: 2 }}>
              Bids · {sale.bids.filter((b) => !b.dropped).length} live{(sale.round ?? 0) > 0 ? " · best and final done" : ""}
            </div>
            <table className="tbl">
              <thead>
                <tr><th>Bidder</th><th className="num">Price</th><th className="num">vs appraisal</th><th>Read</th><th /></tr>
              </thead>
              <tbody>
                {sale.bids.map((b, i) => (
                  <tr key={b.name + i} className={b.dropped ? "dim" : ""}>
                    <td>{b.name}</td>
                    <td className="num">{usd(b.price)}</td>
                    <td className="num">{((b.price / apMid(bbl, value) - 1) * 100).toFixed(0)}%</td>
                    <td className="dim">{b.dropped ? "Walked at best and final." : b.note}</td>
                    <td>
                      {!b.dropped && (
                        <div className="btn-row" style={{ gap: 4, margin: 0 }}>
                          <button className="btn-mini" onClick={() => setAcceptConfirm({ bidIndex: i })}>take it</button>
                          {/* GOING BACK TO ONE BIDDER. Best-and-final puts the
                              whole list back in the room; this is the other
                              move — the private call to the one number you
                              would take five per cent more of. One per bid. */}
                          {!b.countered && (
                            <button className={"btn-mini" + (counterOn === i ? " on" : "")}
                              title={`Go back to ${b.name} alone with a number of your own`}
                              onClick={() => { setCounterOn(counterOn === i ? null : i); setCounterPx(Math.round(b.price * 1.06)); }}>
                              counter
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* NAME YOUR OWN NUMBER. This was a hardcoded "counter +6%" button,
                which is not a negotiation — it is a single scripted move. The
                engine has always taken an arbitrary price; only the UI was
                deciding for you. How hard you push is the entire decision:
                every point you ask for is a point of risk that the one bidder
                who was there walks and the process is over. */}
            {counterOn !== null && sale.bids?.[counterOn] && !sale.bids[counterOn].dropped && (() => {
              const bb = bidCounterBounds(counterOn);
              return (
              <div className="page-section" style={{ marginTop: 6 }}>
                <Slider
                  label={`Back to ${sale.bids![counterOn].name} at`}
                  value={counterPx}
                  min={bb.min}
                  max={bb.max}
                  step={bb.step}
                  editable="price"
                  onChange={setCounterPx}
                  format={(v: number) => usd(v)}
                  hint={`Name a counter above ${usd(sale.bids![counterOn!].price)}. Too far past their bid and they walk.`}
                />
                <div className="btn-row">
                  <button className="btn" onClick={() => { useStore.getState().counterBid(bbl, counterOn!, counterPx); setCounterOn(null); }}>
                    Send it — {usd(counterPx)}
                  </button>
                  <button className="btn" onClick={() => setCounterOn(null)}>Leave it</button>
                </div>
              </div>
              );
            })()}
            <div className="hint">
              Taking a bid is not a closing. The weaker the covenant behind a number, the likelier they come back
              with a reason it should be lower once they have been through the building.
            </div>
            {(sale.round ?? 0) === 0 && sale.bids.filter((b) => !b.dropped).length > 1 && (
              <div className="btn-row">
                <button className="btn" onClick={() => runBestAndFinal(bbl)}>
                  Best and final to the top {Math.min(3, sale.bids.filter((b) => !b.dropped).length)}
                </button>
              </div>
            )}
          </>
        ) : null}
        {sale.offer && tq ? (
          <>
            <div className="hint">
              {sale.offer.retrade
                ? <>{sale.offer.from ?? "The buyer"} has <b>retraded</b> you — {sale.offer.retrade}. They are at <b className="mono">{usd(sale.offer.price)}</b> now, good until {monthLabel(sale.offer.expiresM)}.</>
                : <>Offer on the table{sale.offer.from ? ` from ${sale.offer.from}` : ""}: <b className="mono">{usd(sale.offer.price)}</b> — good until {monthLabel(sale.offer.expiresM)}.</>}
              {tq.tax > 0 && <> Gain of {usd(tq.gain)} over depreciated basis owes <b className="mono">{usd(tq.tax)}</b> in tax.</>}
            </div>
            {/* WHAT THEY ARE ACTUALLY BUYING. A price is a price; the cap rate
                they are getting and the occupancy they are getting it on are
                the two numbers that say whether the offer is generous or
                whether they have spotted something you have not. */}
            {(() => {
              const orec = resolveRec(parcels, game, bbl);
              if (!orec || orec.class === "land" || !orec.bldgArea) return null;
              // THE CAP THEY ARE BUYING AT, computed the way they compute it:
              // your roll, re-assessed at THEIR price, because a sale
              // reassesses. Struck against your old basis this quoted a
              // different number from the one on the other side of the table.
              const noi = holdingNOIYr(orec, game.econ,
                asIfOwned(game, bbl, sale.offer!.price, { roll: holding.tenants, occ: holding.occ, cond: holding.condition }, orec),
                game.month);
              const cap = sale.offer!.price > 0 ? (noi / sale.offer!.price) * 100 : 0;
              const mkt = game.econ.capRate[orec.class as BuiltClass] ?? cap;
              const occ = physicalOcc(orec as never, holding);
              const u = unitStatus(orec, holding, game.month);
              return (
                <div className="grid">
                  <Row k="Cap rate they are buying at" v={`${cap.toFixed(2)}%`} strong bad={cap > mkt + 0.4} />
                  <Row
                    k="Against the market"
                    v={`${mkt.toFixed(2)}% for ${useLabel(orec)} — ${cap < mkt - 0.25 ? "they are paying up" : cap > mkt + 0.25 ? "that is a discount to the market" : "about where the market is"}`}
                  />
                  <Row k="NOI they are underwriting" v={usd(noi)} />
                  <Row k="Occupancy today" v={`${(occ * 100).toFixed(0)}% · ${u.leased} of ${u.total} spaces`} bad={occ < 0.75} />
                  <Row k="Against your ask" v={`${((sale.offer!.price / sale.ask - 1) * 100).toFixed(1)}%`} bad={sale.offer!.price < sale.ask * 0.92} />
                </div>
              );
            })()}
            <div className="btn-row">
              <button className="btn btn-buy" onClick={() => setAcceptConfirm({})}>
                Accept · net {usd(tq.net - (holding.loan?.balance ?? 0) - tq.tax)}
              </button>
              {tq.tax > 0 && !exchangeBusy && (
                <button
                  className="btn btn-buy"
                  title={`Roll the gain into your next purchase: defer ${usd(tq.tax)} of tax, but you must buy for ≥ 80% of this price within 6 months`}
                  onClick={() => setAcceptConfirm({ exchange: true })}
                >
                  1031 · defer {usd(tq.tax)}
                </button>
              )}
              <button className="btn" onClick={() => declineOffer(bbl)}>Decline</button>
            </div>
            {!sale.offer.countered && counterBounds && (
              <>
                <Slider
                  label="Counter"
                  value={counter || Math.round(sale.offer.price * 1.06)}
                  min={counterBounds.min}
                  max={counterBounds.max}
                  step={counterBounds.step}
                  editable="price"
                  onChange={setCounter}
                  format={(v) => usd(v)}
                  marks={[
                    { at: Math.round(sale.offer.price * 1.03), label: "+3%" },
                    { at: Math.round(sale.offer.price * 1.08), label: "+8%" },
                    { at: sale.ask, label: "ask" },
                  ]}
                  hint="Name any price above their bid. Well over appraisal and they may walk — that is the negotiation."
                />
                <div className="btn-row">
                  <button className="btn" onClick={() => counterSale(bbl, counter || Math.round(sale.offer!.price * 1.06))}>
                    Counter at {usd(counter || Math.round(sale.offer.price * 1.06))}
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="hint">
            {sale.callM !== undefined
              ? `The book is out. Nothing happens until offers are due in ${monthLabel(sale.callM)} — that is the point of a date.`
              : "No offers yet. Overpriced listings sit; the market talks back slowly."}
          </div>
        )}
        {/* MOVE THE PRICE WITHOUT PULLING THE SIGN DOWN.
            Changing an ask used to mean delisting and relisting, which throws
            away the campaign, the bid list and the time the building has been
            on the market. Every seller alive just tells the broker a new
            number. Cutting it is free; raising it past where you started reads
            as a seller who does not know what they have, and the market
            treats a repriced listing as a fresher one either way. */}
        <Slider
          label="Reprice"
          value={ask ? Number(ask) : sale.ask}
          min={Math.round(apMid(bbl, value) * 0.65)}
          max={Math.round(apMid(bbl, value) * 1.45)}
          step={Math.max(1000, Math.round(apMid(bbl, value) / 400))}
          onChange={(v) => setAsk(String(v))}
          format={(v) => `${usd(v)} · ${((v / apMid(bbl, value) - 1) * 100).toFixed(0)}% vs appraisal`}
          marks={[{ at: sale.ask, label: "now" }, { at: Math.round(apMid(bbl, value)), label: "fair" }]}
          hint={(() => {
            const want = ask ? Number(ask) : sale.ask;
            return want < sale.ask
              ? `Cutting ${usd(sale.ask - want)} off. A price cut brings the phone back — it also tells every bidder you are motivated.`
              : want > sale.ask
                ? `Asking ${usd(want - sale.ask)} more than you were. Raising an ask mid-campaign loses the buyers who were nearly there.`
                : "The number you are asking today.";
          })()}
        />
        <div className="btn-row">
          <button
            className="btn"
            disabled={!ask || Number(ask) === sale.ask}
            onClick={() => useStore.getState().reprice(bbl, Number(ask))}
          >
            Reprice to {usd(ask ? Number(ask) : sale.ask)}
          </button>
          <button className="btn btn-sell" onClick={() => delistSale(bbl)}>Delist</button>
        </div>
      </div>
    );
  }
  const mid = apMid(bbl, value);
  const askNum = parseFloat(ask);
  const price = Number.isFinite(askNum) ? askNum : mid;
  // What the ask means as a yield — the number the buyer converts it to.
  const saleRec = resolveRec(parcels, game, bbl);
  const saleH = game.holdings[bbl];
  // A leased fee is a coupon bond — yield off ground rent, not vacant-shell NOI.
  const fee = !!saleH && isLeasedFee(saleH);
  const saleClass = (fee
    ? "office"
    : (saleRec && saleRec.class !== "land" ? saleRec.class : "office")) as BuiltClass;
  // YOUR OWN ROLL, RE-ASSESSED AT YOUR ASK. This quoted the class model, so a
  // principal pricing their own half-empty building was shown the yield a full
  // one would offer — and every buyer in town was reading the real roll. The
  // number a seller needs is what a buyer will compute: in-place income off
  // the leases actually in place, against a tax bill struck at the new price.
  const saleNoi = fee && saleH
    ? ownedHoldingNoiYr(game, parcels, saleH)
    : saleRec && saleRec.class !== "land" && saleRec.bldgArea > 0 && saleH
      ? holdingNOIYr(saleRec, game.econ,
          asIfOwned(game, bbl, price, { roll: saleH.tenants, occ: saleH.occ, cond: saleH.condition }, saleRec),
          game.month)
      : 0;
  const askCap = saleNoi > 0 && price > 0 ? (saleNoi / price) * 100 : null;
  return (
    <div className="deal">
      <div className="deal-head">Sell</div>
      <div className="hint">Price it and let the market answer. Appraisal: {band(bbl, value)}.</div>
      <Slider
        label="Your ask"
        value={price}
        min={Math.round(mid * 0.7)}
        max={Math.round(mid * 1.4)}
        step={Math.max(1000, Math.round(mid / 400))}
        onChange={(v) => setAsk(String(v))}
        format={(v) => `${usd(v)} · ${((v / mid - 1) * 100).toFixed(0)}% vs appraisal`}
        marks={[
          { at: Math.round(mid * 0.92), label: "quick" },
          { at: Math.round(mid), label: "fair" },
          { at: Math.round(mid * 1.15), label: "reach" },
        ]}
        hint={price < mid * 0.95 ? "Priced to move — expect offers within months."
          : price > mid * 1.12 ? "Above the market. It may sit a long time."
          : "About right; offers should come."}
      />
      {/* WHAT YOU ARE ACTUALLY ASKING. A price is a number; a cap rate is the
          number every buyer on the other side will convert it to before they
          answer the phone, and it is the one that says whether the ask is
          serious. */}
      {askCap !== null && (
        <div className="hint">
          At {usd(price)} you are asking a <b className="mono">{askCap.toFixed(2)}%</b> cap on
          {" "}{usd(saleNoi)} of {fee ? "ground rent" : "NOI"}
          {fee
            ? " — buyers underwrite a leased fee as a bond with a reversion, not a vacant building."
            : ` — the market is paying about ${game.econ.capRate[saleClass].toFixed(2)}% for this class today.`}
          {!fee && (askCap < game.econ.capRate[saleClass] - 0.4
            ? " You are asking a premium to the market; it will take a buyer who wants this building specifically."
            : askCap > game.econ.capRate[saleClass] + 0.4
              ? " That is a discount to the market — it should go quickly."
              : " That is where the market is.")}
        </div>
      )}
      {/* TWO WAYS TO SELL, and they are genuinely different trades. A sign on
          the door is cheap and finds you one buyer at a time, so you never
          learn what the best buyer in the city would have paid. A run process
          costs a point more and three months, and puts every one of them in
          the same room on the same day. In a thin market the campaign finds
          nobody and you have paid for the privilege. */}
      {/* THE OWNER ASKED WHETHER THE QUIET LISTING SHOULD EXIST AT ALL. It
          should: selling off-market is a real and common way to trade a
          building, and the trade the engine models is the right one — you pay
          a point less in fees and you give up price discovery. What was wrong
          was that the choice was described in a paragraph instead of priced.
          A decision with two numbers on it is a decision; a decision with an
          adjective on it is a paragraph. Both buttons now carry the fee in
          dollars, and the ask is on both of them. */}
      <div className="btn-row">
        <button className="btn btn-buy" onClick={() => listSale(bbl, price, "marketed")}>
          Run a process · {usd(price)} less {usd(Math.round(price * 0.025))} fee
        </button>
        <button className="btn" onClick={() => listSale(bbl, price)}>
          Sell it quietly · {usd(price)}
          {quietFeeRate(game) <= 0.0001 ? " · no fee" : ` less ${usd(Math.round(price * quietFeeRate(game)))} fee`}
        </button>
      </div>
      <div className="hint">
        The campaign costs {usd(Math.round(price * (0.025 - quietFeeRate(game))))} more and two to four months, and
        ends with every bid on your desk on the same day — plus one go back to the top of the list. That is what
        the extra buys: not a better building, a better-tested price. A quiet sale finds you one buyer at a time,
        whoever happens to ring, and you never learn what the best buyer in the city would have paid.
        {quietFeeRate(game) <= 0.0001
          ? " It costs you nothing in fees today, because enough of the street has traded with you that you can find that buyer yourself."
          : ` The quiet fee is ${(quietFeeRate(game) * 100).toFixed(2)}% and falls toward nothing as more of the named firms in town have actually dealt with you.`}
      </div>
    </div>
  );
}

// Leverage is a dial, not three buttons: slide from all-cash to whatever the
// lender will actually fund, and watch the equity cheque and the coverage
// move together.

// Standard mortgage annuity, annualised — what an amortizing loan actually
// costs per year, as opposed to coupon-times-balance, which flattered every
// quote by the principal component.

export function OffMarketCounter({ bbl, ask }: { bbl: string; ask: number }) {
  const [frac, setFrac] = useState(0.88);
  const px = Math.round(ask * frac);
  return (
    <>
      <Slider
        label="Counter their number"
        value={frac}
        min={0.7}
        max={0.98}
        step={0.01}
        onChange={setFrac}
        format={() => `${usd(px)} · ${((frac - 1) * 100).toFixed(0)}%`}
        marks={[{ at: 0.88, label: "−12%" }, { at: 0.95, label: "−5%" }]}
        hint="One shot. Shallow cuts often land, or they come off their number a little. Deep cuts get the phone hung up."
      />
      <div className="btn-row">
        <button className="btn" onClick={() => useStore.getState().counterOff(bbl, px)}>
          Counter · {usd(px)}
        </button>
      </div>
    </>
  );
}

/**
 * "MAKE ME AN OFFER." — the off-market conversation with no number in it.
 *
 * `approachOwner` now has two ways of saying yes. One names a figure and this
 * panel has always drawn it. The other deflects, keeps the figure in the
 * owner's head as `Approach.reserve`, and leaves the player exactly one
 * instrument: a bid.
 *
 * THE ONE RULE HERE IS WHAT IS NOT ON THE SCREEN. types.ts is explicit that no
 * view may render the reserve "as a figure, a bar, a 'you're close' hint, a
 * disabled slider that stops at it, anything" — the refusal to anchor IS the
 * mechanic, and any of those hands the information straight back. So every
 * number below belongs to the player: the appraisal, which they can already
 * read off the summary tab, and their own bids.
 *
 * The dial is a multiple of that appraisal because the appraisal is the only
 * anchor in the room, and its endpoints are the SAME for every parcel in the
 * game — 0.5x to 4x — so where it stops says nothing about where THIS owner
 * is. The top end is a coverage number, not a taste: measured over 2,164 blind
 * conversations across four seeds, reserves run 0.22x to 9.42x appraisal with
 * a median of 1.26x, and a 4x ceiling can reach 97.2% of them (2x reaches only
 * 81.1%, which would have made the dial itself the thing that lost deals). The
 * ones past 4x are owners saying no in numbers, which is what the named-ask
 * path already does out loud at up to 5.86x.
 */
export function BlindBidDesk({ bbl, appr, value }: { bbl: string; appr: Approach; value: number }) {
  const game = useHeldGame(bbl);
  // Live record — the prop can lag a tick behind a bid that just moved probes
  // or drew an ask out; the desk signature now watches those fields, and we
  // read the store copy so the numbers on screen are the ones just written.
  const live = game.approaches[bbl] ?? appr;
  const ap = apMid(bbl, value);
  const [mult, setMult] = useState(1);
  // Round to the thousand the way approachOwner rounds its own number, so the
  // bid the player sees is the bid the engine books.
  const bid = Math.max(1000, Math.round((ap * mult) / 1000) * 1000);
  const probes = live.probes ?? 0;
  // buyOffMarket kills a blind conversation at q+6 with "that has gone cold";
  // approachOwner reopens the phone at q+6 as well, so the two meet exactly.
  const cold = game.month > live.q + 6;
  if (cold) {
    return (
      <>
        {/* Which sentence is true depends on whether the player ever bid. It
            says "you never put one in" only when probes is 0 — the record
            knows, and a panel that told a player who bid four times that they
            never bid would be reading the wrong field out loud. */}
        <div className="hint">
          {probes > 0
            ? `You bid ${live.lastBid ? usd(live.lastBid) : "once"} and never went back.`
            : "They asked you for a number and you never put one in."}
          {" "}That conversation is cold — six months is as long as anybody holds a door open for a buyer
          who is thinking about it.
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => useStore.getState().approach(bbl)}>Ring them again</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="hint">
        They took the call — and they will not put a price on it. <em>"Make me an offer."</em>
        {" "}There is no asking number to display; the only move is yours.
      </div>
      <div className="grid">
        <Row k="Asking price" v="they will not name one" strong />
        <Row k="Appraisal" v={band(bbl, value)} />
        <Row k="They will listen until" v={monthLabel(live.q + 6)} />
        {probes > 0 && (
          <Row
            k="Bids you have made"
            v={`${probes}${live.lastBid ? ` · last ${usd(live.lastBid)}` : ""}`}
            bad={probes >= 3}
          />
        )}
      </div>
      <Slider
        label="Your bid"
        value={mult}
        min={0.5}
        max={4}
        step={0.05}
        onChange={setMult}
        format={() => `${usd(bid)} · ${mult.toFixed(2)}× appraisal`}
        marks={[{ at: 0.8, label: "0.8×" }, { at: 1, label: "appraisal" }, { at: 1.5, label: "1.5×" }, { at: 2, label: "2×" }]}
        hint="Nothing on this screen knows what they want. The dial is measured against the appraisal because that is the only number anybody in this conversation has."
      />
      {/* WHAT EACH OUTCOME MEANS, because a blind bid has four of them and
          three look like failure. Written from bidBlind's branches, in the
          order they are checked, and deliberately without odds attached: the
          player is not entitled to the shape of the distribution either. */}
      <div className="hint">
        Over their number and it is done <strong>at yours</strong> — and nobody will ever tell you that you
        were twenty points high. Close under it and they may finally name a figure, which costs you the fact
        that they now know you want it. Well under and you get a no with nothing attached. Insulting and the
        conversation ends.
      </div>
      {probes >= 2 && (
        <div className="hint">
          {probes} bids in. Their patience is finite and this panel does not know how much of it is left —
          by the third number you have stopped being a buyer and started being a process.
        </div>
      )}
      {/* A NUMBER ONLY. Financing used to sit in front of this button — Thesis →
          Structure → Commit before the seller ever saw a figure. Agree a price
          first; if they take it you go under contract and structure the stack then. */}
      <div className="btn-row">
        <button
          className="btn btn-buy"
          onClick={() => useStore.getState().bidBlind(bbl, bid)}
        >
          Bid {usd(bid)}
        </button>
      </div>
      <div className="hint dim">
        No lender, no leverage, no stack — just the number. If they take it, {usd(Math.round(bid * DEPOSIT_PCT))} of
        earnest money goes hard and you get three months to structure the debt and close.
      </div>
    </>
  );
}

/**
 * THE OFFER. A price, and nothing else on the screen.
 *
 * This used to be one component with a lender selector, a leverage dial, three
 * coverage tests and a going-in cap table sitting above the button that said
 * "Offer" — so before the player was allowed to name a number they had to make
 * four financing decisions about a building they did not have. Nobody buys
 * anything that way. You agree a price with a person, and then you go and find
 * the money against a deal you actually have.
 *
 * So this is the conversation, whole: their number, your number, how far apart
 * you are, how many rounds are left, and what kind of seller you are reading.
 * The capital stack does not appear until there is something to fund.
 */
export function OfferDesk({ bbl, price, distress, loanBasis }: { bbl: string; price: number; distress?: boolean; loanBasis?: number }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const mid = apMid(bbl, price);
  const bounds = widePriceBounds(price, mid);
  const defaultOffer = distress ? 0.88 : 0.94;
  const [offerPrice, setOfferPrice] = useState(Math.round(price * defaultOffer));
  // BEST AND FINAL is an instrument, not a bluff. Certainty of a done deal is
  // worth about three and a half per cent to a seller who has been retraded
  // before — and every seller has been — so a credible final closes under
  // their floor. The price of the instrument: a no ends it, for both sides,
  // and it is only credible while the street still believes your finals.
  const [isFinal, setIsFinal] = useState(false);
  // THE PERSON, NOT THE LISTING. A cold holder still has a number on the tape
  // — the market can buy it — but the offer controls are a lie if they will
  // not sell to you.
  const cold = coldOnDeed(game, parcels, bbl);
  if (cold) {
    return (
      <div className="hint neg" style={{ marginTop: 6 }}>
        <strong>Not to you.</strong> {coldRefuseMsg(cold)}
        <div className="dim" style={{ marginTop: 4 }}>
          Ask stays {usd(price)}. Somebody else can buy it; you cannot until they take your call again.
        </div>
      </div>
    );
  }
  const offerPriceRounded = Math.round(offerPrice);
  const seller = sellerOf(game, parcels, bbl);
  const talks = game.talks?.[bbl] ?? null;
  // Everything else you have on the table. Not a blocker any more — a list,
  // because knowing what else you are committed to is exactly what you need
  // when you decide how hard to push on this one.
  const others = Object.values(game.talks ?? {}).filter((t) => t.bbl !== bbl);
  const atLimit = !talks && others.length >= MAX_TALKS;
  // THE RESOLVED RECORD. `parcels[bbl]` is the lot as GENERATED — a delivered
  // tower reads as the dirt it used to be, which is the same fault buyQuote
  // fixed on the lender's side and left standing here.
  const rec = resolveRec(parcels, game, bbl);
  const ip = rec ? inPlace(rec, game, bbl, offerPriceRounded) : null;
  const noi = ip?.noi ?? 0;
  const goingInPct = offerPriceRounded > 0 && noi > 0 ? (noi / offerPriceRounded) * 100 : null;
  const stab = rec ? proFormaNOIYr(rec, game.econ, ip?.h?.condition ?? initialCondition(rec), offerPriceRounded) : 0;
  return (
    <>
      <Slider
        label="Your offer"
        value={offerPriceRounded}
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        editable="price"
        onChange={setOfferPrice}
        format={(v) => usd(v)}
        marks={[{ at: Math.round(price * 0.85), label: "−15%" }, { at: Math.round(price * 0.95), label: "−5%" }, { at: price, label: "ask" }]}
        hint={talks
          ? (offerPriceRounded >= talks.theirPrice
            ? `You are at or above their ${usd(talks.theirPrice)} — send it and you are under contract.`
            : `They are at ${usd(talks.theirPrice)}, ${usd(talks.theirPrice - offerPriceRounded)} above you${talks.final ? ". This is their last word." : `. Round ${talks.round} of ${talks.maxRounds}.`}`)
          : distress
            ? `${((offerPriceRounded / Math.max(1, price) - 1) * 100).toFixed(1)}% vs ask ${usd(price)}.${loanBasis ? ` The desk is clearing ${usd(loanBasis)} of debt` : " Motivated seller"} — counter below the ask; they move more readily than a voluntary seller.`
            : `${((offerPriceRounded / Math.max(1, price) - 1) * 100).toFixed(1)}% vs ask ${usd(price)}. Name a price; they take it, counter, or walk.`}
      />
      {/* What the number MEANS, before anybody talks about debt. A going-in cap
          is the only thing you need to know to decide whether a price is a
          price — the capital stack changes what you earn on it, not whether it
          is worth owning. */}
      {goingInPct !== null && (
        <div className="grid">
          <Row k={ip?.disclosed ? "In-place NOI / yr, after taxes" : "NOI / yr (mkt est.)"} v={usd(noi)} />
          <Row k="Going-in cap at your number" v={`${goingInPct.toFixed(2)}%`} strong />
          {/* Stabilised beside it and never instead of it. If this line is far
              above the one at the top, you are buying a leasing job. */}
          <Row k="Stabilised pro-forma" v={`${usd(stab)} · ${offerPrice > 0 ? ((stab / offerPrice) * 100).toFixed(2) : "—"}%`} />
          {ip?.disclosed && <Row k="Occupancy (in place)" v={`${(ip.occ * 100).toFixed(0)}%`} bad={ip.occ < 0.75} />}
        </div>
      )}
      <div className="hint" style={{ marginTop: 6 }}>
        Across the table: <strong>{seller.name}</strong>. {sellerProfile(seller.kind).blurb}
      </div>
      {talks && (
        <>
          <div className="grid" style={{ marginTop: 6 }}>
            <Row k="They want" v={usd(talks.theirPrice)} strong />
            <Row k="You offered" v={usd(talks.yourPrice)} />
            <Row k="Apart" v={usd(Math.max(0, talks.theirPrice - talks.yourPrice))}
              bad={talks.theirPrice - talks.yourPrice > talks.yourPrice * 0.08} />
            <Row k="Rounds" v={talks.final ? "their final word" : `${talks.round} of ${talks.maxRounds}`} bad={talks.final} />
            <Row
              k="Waiting"
              v={(() => {
                const idleM = Math.max(0, game.month - talks.openedM);
                if (talks.agreed && talks.closeByM !== undefined) {
                  const left = talks.closeByM - game.month;
                  return left <= 0
                    ? "closing window — fund now"
                    : `${left} month${left === 1 ? "" : "s"} left to fund · open ${idleM} mo`;
                }
                if (idleM <= 0) return "opened this month — Advance for their next move";
                if (idleM === 1) return "1 month on the table — Advance when you want their answer";
                return `${idleM} months on the table — nothing moves until you Advance`;
              })()}
              strong={!!talks.agreed}
              bad={!!talks.agreed && (talks.closeByM ?? game.month) - game.month <= 1}
            />
          </div>
          <div className="hint">{talks.note}</div>
          {distress && !talks.agreed && (
            <div className="hint">
              Motivated sellers move on Advance, not on a clock you can sit out — a counter sits until you step the month.
            </div>
          )}
        </>
      )}
      {distress && !talks && (
        <div className="hint" style={{ marginTop: 4 }}>
          Distressed ask — send a number below ask; their answer lands when you Advance, not while you wait on this card.
        </div>
      )}
      {others.length > 0 && (
        <div className="hint">
          Also on the table: {others.map((t) => `${parcels[t.bbl]?.address ?? t.bbl} at ${usd(t.agreedPrice ?? t.theirPrice)}${t.agreed ? " (under contract)" : ""}`).join(" · ")}.
          {atLimit && " That is as many as you can hold — close one or walk away before opening another."}
        </div>
      )}
      <label className="hint" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
        <input type="checkbox" checked={isFinal} onChange={(e) => setIsFinal(e.target.checked)} />
        Best and final — they answer once, and a no ends it for both sides
      </label>
      <div className="btn-row">
        <button
          className="btn btn-buy"
          disabled={atLimit || (!!talks && talks.final && offerPriceRounded < talks.theirPrice)}
          onClick={() => { useStore.getState().offer(bbl, offerPriceRounded, isFinal); setIsFinal(false); }}
        >
          {talks ? `Counter at ${usd(offerPriceRounded)}` : `Offer ${usd(offerPriceRounded)}`}{isFinal ? " — final" : ""}
        </button>
        {!talks && (
          <button
            className="btn"
            title="Pay the posted ask — skips negotiation"
            onClick={() => useStore.getState().offer(bbl, price, false)}
          >
            Pay ask · {usd(price)}
          </button>
        )}
        {talks && (
          <>
            <button className="btn btn-buy" onClick={() => useStore.getState().acceptCounter(bbl)}
              title={`Take their number and go under contract. ${usd(Math.round(talks.theirPrice * DEPOSIT_PCT))} of earnest money goes hard today; the rest is due in three months.`}>
              Take {usd(talks.theirPrice)}
            </button>
            <button className="btn" onClick={() => useStore.getState().walkAway(bbl)}>Walk away</button>
          </>
        )}
      </div>
      {talks?.final && offerPriceRounded < talks.theirPrice && (
        <div className="hint">They have stopped moving. Take {usd(talks.theirPrice)} or walk.</div>
      )}
      <div className="hint dim">
        Agreeing a price puts you under contract and {usd(Math.round(offerPriceRounded * DEPOSIT_PCT))} of earnest money
        goes hard the same day. The lender, the leverage and the cheque come after that, and you get three months
        to arrange them — miss it and the deposit is theirs.
      </div>
    </>
  );
}

/**
 * THE MONEY. Only ever shown against a price that is already agreed.
 */
export function BuyButtons({ bbl, price, off, closeLabel, bid }: {
  bbl: string; price: number; off: boolean; closeLabel?: string;
  /** Named off-market ask path only — funds `approaches[bbl].ask` (or this
   *  override). Blind "make me an offer" bids no longer come through here. */
  bid?: number;
}) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const { buyOff } = useStore.getState();
  const isLand = parcels[bbl]?.class === "land";
  const [product, setProduct] = useState<string>(isLand ? "land" : "savings");
  const [lev, setLev] = useState(1);
  // Thesis → Structure → Commit: one job per stage so the close cheque is not
  // competing with product chips and the underwriting grid on the same scroll.
  const [stage, setStage] = useState<"thesis" | "structure" | "commit">("thesis");
  const offerPrice = Math.round(price);
  // Same pattern as RefiSection: default "savings" often won't quote, while
  // another desk will — fall through to a desk that actually writes so Commit
  // does not silently close all-cash against a card full of loan terms.
  const productChoices = PRODUCTS.filter((p) => !p.mezz && (isLand ? p.id === "land" : p.id !== "land"));
  const picked = (() => {
    const direct = buyQuote(game, parcels, bbl, offerPrice, product, 1);
    if (product === "cash" || direct.principal > 0) return product;
    const alt = productChoices.find((p) => buyQuote(game, parcels, bbl, offerPrice, p.id, 1).principal > 0);
    return alt?.id ?? "cash";
  })();
  const max = buyQuote(game, parcels, bbl, offerPrice, picked, 1);
  const principal = Math.round(max.principal * lev);
  const equity = max.equity > 0 && lev >= 0.999
    ? max.equity
    : offerPrice - principal + Math.round(offerPrice * 0.02)
      + (max.capPremium ? Math.round(max.capPremium * lev) : 0)
      + Math.round((max.pointsFee ?? 0) * lev);
  // THE RESOLVED RECORD, for the same reason buyQuote uses one: the static
  // table is the lot at generation, not what is standing on it today.
  const rec = resolveRec(parcels, game, bbl);
  // IN PLACE, NOT ESTIMATED. This is the screen the deal is decided on —
  // going-in cap, debt yield, year-one cash flow, cash-on-cash — and every one
  // of those numbers was computed off `noiAfterTaxYr`, which cannot see a rent
  // roll. Measured over 3,195 buildings that estimate ran 20 points of
  // occupancy above the real roll, worst on the highest quoted yields, so the
  // cash-on-cash on this panel was a forecast of income the building did not
  // earn. It is the disclosed roll now — the same roll the lender sizes on and
  // the same roll the deed conveys.
  const ip = rec ? inPlace(rec, game, bbl, offerPrice) : null;
  const noi = ip?.noi ?? 0;
  const stab = rec ? proFormaNOIYr(rec, game.econ, ip?.h?.condition ?? initialCondition(rec), offerPrice) : 0;
  // ACTUAL first-year debt service — amortizing payment for amortizing paper,
  // coupon-only for IO periods — not the IO approximation for everything.
  // Key off `picked` (the desk the numbers describe), not the chip the player
  // last clicked when that chip would not quote.
  const prodDef = PRODUCTS.find((pp) => pp.id === picked);
  const annualDs = principal > 0
    ? (prodDef && prodDef.ioM > 0
      ? principal * (max.ratePct / 100)
      : annualPayment(principal, max.ratePct, prodDef?.amortYears ?? 30))
    : 0;
  const dscrNow = annualDs > 0 ? noi / annualDs : null;
  const goingInPct = offerPrice > 0 ? (noi / offerPrice) * 100 : 0;
  const dy = principal > 0 ? (noi / principal) * 100 : 0;
  const cf = noi - annualDs;
  const coc = equity > 0 ? (cf / equity) * 100 : 0;
  const negLev = principal > 0 && goingInPct < max.ratePct;
  const stabPct = offerPrice > 0 ? (stab / offerPrice) * 100 : 0;
  return (
    <div className="deal-stages">
      <div className="deal-stage-tabs" role="tablist" aria-label="Close the deal">
        {([
          ["thesis", "Thesis"],
          ["structure", "Structure"],
          ["commit", "Commit"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={stage === id}
            className={"deal-stage-tab" + (stage === id ? " on" : "")}
            onClick={() => setStage(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {stage === "thesis" && (
        <div className="deal-stage" role="tabpanel">
          <div className="hint">What you are buying at {usd(offerPrice)} — income first, leverage later.</div>
          <div className="grid">
            {rec && rec.class !== "land" && rec.bldgArea > 0 ? (
              <>
                <Row k={ip?.disclosed ? "In-place NOI / yr" : "NOI / yr (mkt est.)"} v={usd(noi)} bad={noi < 0} />
                {ip?.disclosed && <Row k="Occupancy (in place)" v={`${(ip.occ * 100).toFixed(0)}%`} bad={ip.occ < 0.75} />}
                <Row k="Going-in cap" v={`${goingInPct.toFixed(2)}%`} strong />
                <Row k="Stabilised pro-forma" v={`${usd(stab)} · ${stabPct.toFixed(2)}%`} />
              </>
            ) : (
              <Row k="Price" v={usd(offerPrice)} strong />
            )}
          </div>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn btn-buy" onClick={() => setStage("structure")}>
              Structure the stack ▸
            </button>
          </div>
        </div>
      )}

      {stage === "structure" && (
        <div className="deal-stage" role="tabpanel">
          <div className="btn-row" style={{ marginTop: 4 }}>
            {productChoices.map((p) => {
              const pq = buyQuote(game, parcels, bbl, offerPrice, p.id, 1);
              return (
                <button
                  key={p.id}
                  className={"btn" + (picked === p.id ? " btn-on" : "")}
                  disabled={pq.principal <= 0}
                  style={pq.principal <= 0 ? { opacity: 0.42, cursor: "not-allowed" } : undefined}
                  title={pq.principal <= 0
                    ? `${p.label} will not lend against this building today — ${p.blurb}`
                    : `${p.blurb}\n${(p.maxLTV * 100).toFixed(0)}% max LTV · ${p.amortYears}-yr amort · ${Math.round(p.termM / 12)}-yr term`}
                  onClick={() => setProduct(p.id)}
                >
                  {p.label}{pq.principal > 0 ? ` · ${pq.ratePct.toFixed(2)}% · ${(p.maxLTV * 100).toFixed(0)}% LTV` : " · won't quote"}
                </button>
              );
            })}
            <button className={"btn" + (picked === "cash" ? " btn-on" : "")} title="No debt at all." onClick={() => setProduct("cash")}>
              All cash
            </button>
          </div>
          {max.principal > 0 ? (
            <Slider
              label="Leverage"
              value={lev}
              min={0}
              max={1}
              step={0.02}
              onChange={setLev}
              format={() => (principal > 0 ? `${usd(principal)} · ${((principal / Math.max(1, offerPrice)) * 100).toFixed(0)}% LTV` : "all cash")}
              marks={[{ at: 0, label: "cash" }, { at: 0.5, label: "half" }, { at: 1, label: "max" }]}
              hint={`${max.ratePct}% coupon${dscrNow ? ` · DSCR ${dscrNow.toFixed(2)}` : ""}`}
            />
          ) : null}
          {max.principal > 0 && (
            <div className="hint">
              {max.bind === "appraisal"
                ? `The lender underwrote ${usd(max.uwBasis ?? 0)}, not your ${usd(offerPrice)} — they ordered their own appraisal and it came back at ${usd(max.appraised ?? 0)}. `
                  + `They advance against the LESSER of that and what you agreed to pay, so the ${usd(max.overpay ?? 0)} above it is entirely yours. `
                  + `Their collateral is the building, not your enthusiasm for it.`
                : max.bind === "ltv"
                ? `Sized at this lender's ${(max.ltvCap * 100).toFixed(0)}% advance rate — the ceiling, and the income clears it comfortably.`
                : max.bind === "dscr"
                  ? `Their advance rate is ${(max.ltvCap * 100).toFixed(0)}%, but you are getting ${((max.principal / Math.max(1, offerPrice)) * 100).toFixed(0)}% — COVERAGE is binding, not leverage. `
                    + `At a ${max.ratePct}% coupon the income only services ${(max.principal / Math.max(1, offerPrice) * 100).toFixed(0)}% of the price at ${max.uwDscr.toFixed(2)}x. `
                    + `That is what a high index does: the cap rate you buy at has to carry the coupon you borrow at, and when it cannot, the loan shrinks.`
                  : max.bind === "dy"
                    ? `Their advance rate is ${(max.ltvCap * 100).toFixed(0)}%, but the DEBT YIELD test is binding — the income is too thin against the loan for this desk, regardless of what the building is worth.`
                    : `Their advance rate is ${(max.ltvCap * 100).toFixed(0)}%, cut back by the credit window and your own record. Leverage comes back when money does.`}
            </div>
          )}
          {max.principal <= 0 && (
            <div className="hint">{picked === "cash" ? "Buying it outright." : "No lender will size a loan against this income — all cash or nothing."}</div>
          )}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" onClick={() => setStage("thesis")}>◂ Thesis</button>
            <button type="button" className="btn btn-buy" onClick={() => setStage("commit")}>
              Review &amp; commit ▸
            </button>
          </div>
        </div>
      )}

      {stage === "commit" && (
        <div className="deal-stage" role="tabpanel">
          <div className="grid">
            {rec && rec.class !== "land" && rec.bldgArea > 0 && (
              <>
                <Row k="Going-in cap" v={`${goingInPct.toFixed(2)}%`} bad={negLev} />
                <Row k="Coupon" v={`${max.ratePct.toFixed(2)}%${negLev ? " — negative leverage" : ""}`} bad={negLev} />
                {principal > 0 && <Row k="Debt yield" v={`${dy.toFixed(1)}%`} bad={dy < 8} />}
                {principal > 0 && <Row k="Annual debt service" v={`−${usd(annualDs)}${prodDef && prodDef.ioM > 0 ? " (interest-only)" : ` (${prodDef?.amortYears ?? 30}-yr am)`}`} />}
                {prodDef && (
                  <Row
                    k="Terms"
                    v={`${prodDef.ioM ? `${Math.round(prodDef.ioM / 12)}-yr IO, ` : ""}${prodDef.amortYears}-yr amort, `
                      + `${Math.round(prodDef.termM / 12)}-yr term, ${(prodDef.maxLTV * 100).toFixed(0)}% max LTV`}
                  />
                )}
                <Row k="Year-1 cash flow" v={usd(cf)} bad={cf < 0} />
                <Row k="Cash-on-cash" v={`${coc.toFixed(1)}%`} bad={coc < 0} />
              </>
            )}
            <Row k="Equity to close" v={usd(equity)} strong bad={equity > game.cash} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => setStage("structure")}>◂ Structure</button>
            <button
              className="btn btn-buy"
              disabled={equity > game.cash}
              onClick={() => {
                const prod = principal <= 0 ? "cash" : picked;
                const l = principal <= 0 ? 1 : lev;
                if (off) buyOff(bbl, prod as never, l, bid);
                else useStore.getState().closeDeal(bbl, prod, l);
              }}
            >
              {closeLabel ?? `Close at ${usd(offerPrice)}`} · eq {usd(equity)}
            </button>
            {!off && (
              <button className="btn" onClick={() => useStore.getState().walkAway(bbl)}
                title="Tear up the contract. The building goes back on the market and the seller keeps the deposit.">
                Tear it up
              </button>
            )}
          </div>
          {(() => {
            const fromFund = !!(game.fundPay && game.fund && !game.fund.settled
              && game.month <= game.fund.investEndM);
            const purse = fromFund ? (game.fund?.cash ?? 0) : game.cash;
            if (equity <= purse) return null;
            return (
              <div className="hint">
                Short {usd(equity - purse)}
                {fromFund
                  ? " — call more capital, or buy from firm cash on Capital → Debt."
                  : " — the line of credit is on Capital → Debt."}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// Refinancing is a market, not a button: two products, what each will
// actually advance today, and a dial for how much of it you take.
/**
 * NAME YOUR ASK FROM THE ROW.
 *
 * The List button on the portfolio listed at appraisal plus two per cent and
 * told you, in a tooltip, to open the record if you wanted your own number.
 * That is the most consequential number in the transaction being chosen for
 * you by a button — and the record it points at has the slider, so the machine
 * to do this properly already existed one screen away.
 *
 * The two fees are on the two buttons, in dollars, for the same reason they are
 * on the record: a decision with two numbers on it is a decision, and a
 * decision with an adjective on it is a paragraph.
 */
/**
 * OFFER A GROUND LEASE FROM THE BOOK — same job as LandDesk's "Or ground-lease
 * it" block, sized for a portfolio expand row so vacant dirt does not force a
 * trip through Property → Build.
 */
export function GroundLeaseSection({ bbl, onDone }: { bbl: string; onDone?: () => void }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const { groundLease, pullGroundOffer } = useStore.getState();
  const h = game.holdings[bbl];
  const rec = resolveRec(parcels, game, bbl);
  const [years, setYears] = useState(GROUND_TOWER_TERM_MIN);
  const [review, setReview] = useState<GroundReview>("fixed");
  if (!h || !rec) return null;
  const vacant = rec.class === "land" && (rec.bldgArea ?? 0) === 0
    && !(game.built?.[bbl]?.bldgArea) && !h.groundLeased && !game.groundLeases?.[bbl];
  const offer = h.groundOffer;
  const oq = offer && vacant
    ? groundLeaseQuote(game, parcels, bbl, offer.years, offer.review ?? "fixed") : null;
  const blocked = !vacant
    ? "Only vacant dirt can be offered for ground lease."
    : h.sale ? "Pull the listing first — you cannot encumber a marketed lot."
    : game.developments[bbl] ? "Construction is already underway."
    : game.merged?.[bbl] ? "That lot is part of an assemblage — lease the whole site."
    : h.loan ? "Pay off the mortgage first — a land lender will not sit under a ground lease."
    : game.facility?.bbls?.includes(bbl)
      ? "Release it from the facility first — the line is secured by vacant dirt, not a leased fee."
      : null;
  const q = vacant && !offer && !blocked
    ? groundLeaseQuote(game, parcels, bbl, years, review) : null;

  if (offer) {
    return (
      <div style={{ padding: "8px 2px" }}>
        <div className="deal-head">Offered for ground lease</div>
        <div className="grid">
          <Row k="On the book since" v={`${monthLabel(offer.sinceM)}${game.month - offer.sinceM > 0 ? ` · ${game.month - offer.sinceM} month${game.month - offer.sinceM === 1 ? "" : "s"} waiting` : ""}`} />
          <Row k="Structure" v={GROUND_REVIEW_LABEL[offer.review ?? "fixed"]} />
          <Row k="Terms as of today" v={oq
            ? `${usd(oq.rentYr)} / yr · ${offer.years} years · ${oq.reviewNote}`
            : "—"} strong />
          {oq && <Row k="Net cash income" v={`${usd(oq.cashFlow.netRentYr)} / yr`} strong />}
        </div>
        <div className="hint">
          Ground lessees are scarce. The deal signs at the terms quoted the month they arrive.
        </div>
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="btn" onClick={() => { pullGroundOffer(bbl); onDone?.(); }}>
            Pull the offer
          </button>
        </div>
      </div>
    );
  }

  if (blocked || !q) {
    return (
      <div style={{ padding: "8px 2px" }}>
        <div className="deal-head">Ground lease</div>
        <div className="hint">{blocked ?? "Nobody will ground-lease that today."}</div>
      </div>
    );
  }

  return (
    <div style={{ padding: "8px 2px" }}>
      <div className="deal-head">Offer a ground lease</div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        {(["fixed", "cpi", "fmv"] as GroundReview[]).map((r) => (
          <button key={r} className={"btn" + (review === r ? " btn-on" : "")} onClick={() => setReview(r)}>
            {GROUND_REVIEW_LABEL[r]}
          </button>
        ))}
      </div>
      <Slider
        label="Term"
        value={years}
        min={GROUND_TERM_MIN}
        max={99}
        step={1}
        onChange={setYears}
        format={(v) => `${v} years`}
        hint={q.reviewNote}
      />
      <div className="grid">
        <Row k="Gross ground rent" v={`${usd(q.cashFlow.grossRentYr)} / yr · ${q.capPct}% of land value`} />
        <Row k="Owner expenses" v="$0 tax · $0 opex · $0 TI · $0 signing — lessee pays" />
        <Row k="Net cash income" v={`${usd(q.cashFlow.netRentYr)} / yr`} strong />
        <Row k="At term" v={q.padOnly
          ? "Dirt back — bones only if you fund a leasehold buyout"
          : `Aged vacant improvement reverts · ${monthLabel(game.month + years * 12)}`} />
      </div>
      <div className="hint">
        Absolutely-net form. {q.termNote} Fixed places faster; FMV opens cheaper and slower.
      </div>
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn btn-buy" onClick={() => { groundLease(bbl, years, review); onDone?.(); }}>
          Offer a {years}-year {GROUND_REVIEW_LABEL[review].toLowerCase()} ground lease
        </button>
      </div>
    </div>
  );
}

export function ListSection({ bbl, appraisal, onDone }: { bbl: string; appraisal: number; onDone: () => void }) {
  const game = useHeldGame(bbl);
  const listSale = useStore((s) => s.listSale);
  const [ask, setAsk] = useState(Math.round(appraisal * 1.02));
  const quiet = quietFeeRate(game);
  const over = appraisal > 0 ? ask / appraisal - 1 : 0;
  const leasedFee = !!game.groundLeases?.[bbl];
  return (
    <div style={{ padding: "8px 2px" }}>
      {leasedFee && (
        <div className="hint" style={{ marginBottom: 8 }}>
          This is the leased fee — the coupon and the reversion, not free-and-clear dirt. Buyers underwrite it as a
          bond, and the ground lease goes with the deed.
        </div>
      )}
      <Slider
        label="Your ask"
        value={ask}
        min={Math.round(appraisal * 0.7)}
        max={Math.round(appraisal * 1.6)}
        step={Math.max(1000, Math.round(appraisal / 400 / 1000) * 1000)}
        onChange={setAsk}
        format={(v) => `${usd(v)} · ${over >= 0 ? "+" : ""}${(over * 100).toFixed(0)}% vs appraisal`}
        hint={over > 0.12
          ? "Well over the appraisal. It can sit there a long time, and a listing that goes stale is read as a building nobody wanted."
          : over < -0.06
            ? "Under appraisal. It will go quickly, and every buyer in town will know why."
            : "About where the market is."}
      />
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn btn-buy" onClick={() => { listSale(bbl, ask, "marketed"); onDone(); }}>
          Run a process · less {usd(Math.round(ask * 0.025))} fee
        </button>
        <button className="btn" onClick={() => { listSale(bbl, ask); onDone(); }}>
          Sell it quietly · {quiet <= 0.0001 ? "no fee" : `less ${usd(Math.round(ask * quiet))} fee`}
        </button>
      </div>
      <div className="hint">
        {quiet <= 0.0001
          ? "Your name is worth the brokerage on this one: enough of the street has traded with you that you can sell it off-market yourself, and there is nobody in the room to pay."
          : `A quiet sale costs ${(quiet * 100).toFixed(2)}% today. That falls as more of the named firms in town have actually traded with you — a building sold off-market is sold to somebody who already knew you had it — and it goes straight back up if the street decides you are a lowballer.`}
      </div>
    </div>
  );
}
