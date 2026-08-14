import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { assetValue, initialCondition, ownedHoldingValue, ownedHoldingNoiYr, resolveRec, rollQualitySpread, operatingStatement, remainingAbatement, inPlace } from "@/engine/value";
import { farMaxFor, maxFloorsFor, replacementCost } from "@/engine/dev";
import { walt, unitStatus } from "@/engine/leasing";
import { taxAppealQuote } from "@/engine/tax";
import { describePropertyEvent, propertyTimeline } from "@/engine/history";
import { usd, sf } from "@/ui/format";
import { ParcelPanel } from "@/ui/panels/ParcelDesk";
import { AssetHistory, WorkoutDesk } from "@/ui/panels/PropertyDesks";
import { useLabel, band, PropTab, Big, Row } from "@/ui/panels/shared";

export function PropertyPage() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const adjacency = useStore((s) => s.adjacency);
  const bbl = useStore((s) => s.selectedBBL);
  const [tab, setTab] = useState<PropTab>("summary");
  const fundingDue = !!bbl && !game.holdings[bbl] && !!game.talks?.[bbl]?.agreed;
  // A different building is a different file. Opening one and landing on the
  // last building's mortgage tab is how you misread a balance. The exception
  // is a signed purchase contract: opening it from Deals should show the
  // financing choices immediately, not hide them behind an Overview tab.
  useEffect(() => { setTab(fundingDue ? "deal" : "summary"); }, [bbl, fundingDue]);
  if (!bbl) return <div className="hint">Nothing selected.</div>;
  const rec = resolveRec(parcels, game, bbl);
  if (!rec) return <div className="hint">Unknown parcel.</div>;
  const h = game.holdings[bbl];
  const cond = h?.condition ?? initialCondition(rec);
  const value = h ? ownedHoldingValue(game, parcels, h) : assetValue(rec, game.econ, cond);
  // A ground-leased fee can resolve as a standing tower (the lessee's). That
  // is not a building YOU operate — Rent roll / Operations stay off, and the
  // headline NOI is the ground coupon, not a vacant shell.
  const leasedFee = !!h?.groundLeased;
  const built = rec.class !== "land" && rec.bldgArea > 0 && !leasedFee;
  // IN PLACE OR NOTHING. The unowned branch here quoted `noiYr` — which is the
  // class model AND is before property tax, so an unowned building's headline
  // NOI was overstated twice over against the owned one right beside it. One
  // accessor, both cases, and the tax comes off exactly once.
  const ipHdr = inPlace(rec, game, bbl, value);
  const occ = built ? ipHdr.occ : 0;
  const noi = leasedFee && h
    ? ownedHoldingNoiYr(game, parcels, h)
    : (built ? ipHdr.noi : 0);
  const dsYr = (h?.loan?.monthlyPmt ?? 0) * 12;
  const dev = game.developments[bbl];
  const taxAppeal = h ? taxAppealQuote(game, parcels, bbl) : null;
  const timeline = propertyTimeline(game, bbl);
  // WHICH DESKS THIS BUILDING HAS. A tab that would open on an empty page is
  // worse than no tab: it teaches the player that the page lies about where
  // things are. Assembly is the awkward one — the Land desk hides itself when
  // there is no adjoining deed of yours, so the tab has to ask the same
  // question the desk does.
  const ownsNeighbour = (adjacency?.[bbl] ?? []).some((n) => game.holdings[n]);
  const TABS: { key: PropTab; label: string; show: boolean }[] = [
    { key: "summary", label: "Overview", show: true },
    { key: "leasing", label: "Rent roll", show: !!h && built },
    { key: "money", label: "Money", show: !!h && (built || leasedFee || !!h.loan) },
    { key: "ops", label: "Operations", show: !!h && built },
    { key: "deal", label: h ? "Sell" : "Acquire", show: true },
    { key: "build", label: built ? "Convert / Build" : "Build",
      show: !!h && (leasedFee || rec.class === "land" || !!dev || ownsNeighbour
        || (!h.groundLeased && rec.class !== "multifamily")) },
    { key: "history", label: "Deed history", show: timeline.length > 0 },
  ];
  const shown = TABS.filter((t) => t.show);
  // A tab can disappear under you — you sell the neighbouring lot and Build
  // goes with it. Fall back rather than render a page with nothing on it.
  const active = shown.some((t) => t.key === tab) ? tab : "summary";
  return (
    <div>
      <div className="stat-strip">
        <Big label="Appraisal" value={band(bbl, value)} />
        <Big
          label={leasedFee ? "Ground rent / yr" : "NOI / yr"}
          value={(built || leasedFee) ? usd(noi) : "—"}
          bad={noi < 0}
        />
        <Big label="Debt service / yr" value={dsYr ? "−" + usd(dsYr) : "—"} />
        <Big label="Cash flow / yr" value={usd(noi - dsYr)} bad={noi - dsYr < 0} />
        {leasedFee ? (
          <Big label="Your role" value="leased fee" />
        ) : (
          <Big label="Occupancy" value={built ? (occ * 100).toFixed(0) + "%" : "—"} bad={built && occ < 0.75} />
        )}
        {leasedFee && rec.bldgArea > 0 && game.groundLeases?.[bbl] && (
          <>
            <Big label="Lessee building" value={`${game.groundLeases[bbl].floors ?? rec.floors} fl · ${sf(rec.bldgArea)}`} />
            <Big label="Lessee" value={game.groundLeases[bbl].tenant} />
          </>
        )}
        {built && h && (() => {
          const u = unitStatus(rec, h, game.month);
          return <Big label="Spaces leased" value={`${u.leased} / ${u.total}`} bad={u.leased < u.total * 0.6} />;
        })()}
        {built && h && h.tenants.length > 0 && (
          <Big label="WALT" value={`${walt(h, game.month).toFixed(1)} yrs`} bad={walt(h, game.month) < 3} />
        )}
        {built && h && (
          <Big
            label="Expense leakage"
            value={`${(operatingStatement(rec, game.econ, h, game.month).leakage * 100).toFixed(0)}%`}
            bad={operatingStatement(rec, game.econ, h, game.month).leakage > 0.45}
          />
        )}
        {built && h && (
          <Big
            label="Roll quality"
            value={`${rollQualitySpread(rec, h, game.month, game.econ) >= 0 ? "+" : ""}${(rollQualitySpread(rec, h, game.month, game.econ) * 100).toFixed(0)} bps`}
            bad={rollQualitySpread(rec, h, game.month, game.econ) > 0.15}
          />
        )}
        {/* Concessions already granted and not yet burned off. A buyer credits
            this off the price at closing, so it moves the appraisal directly —
            and there was nowhere to see it. */}
        {built && h && remainingAbatement(h, game.month) > 0 && (
          <Big label="Free rent owed" value={"−" + usd(remainingAbatement(h, game.month))} bad />
        )}
        {/* THE SANITY CHECK EVERY DEVELOPER RUNS AND THIS GAME COULD NOT.
            Above replacement cost, somebody will build a competitor across the
            street. Below it, nobody can — and you are buying bricks for less
            than the bricks cost. */}
        {built && (() => {
          const rc = replacementCost(rec as never, game.econ);
          if (!rc) return null;
          const x = value / rc;
          return (
            <Big
              label="Value vs cost to build"
              value={`${x.toFixed(2)}×`}
              bad={x > 1.25}
            />
          );
        })()}
        <Big label="Equity" value={h ? usd(value - (h.loan?.balance ?? 0)) : "—"} />
      </div>
      <div className="prop-head">
        <div>
          <div className="page-title" style={{ fontSize: 22 }}>{rec.address}</div>
          <div className="panel-bbl mono">Parcel {rec.bbl} · {useLabel(rec)} · {rec.zoneDist}</div>
          {/* Every building in this game is somewhere. Closing the page and
              putting the camera on it is one click, not a hunt.
              AND SELLING IS THE OTHER ONE. The exit used to be the ninth card
              down a page that is mostly operating detail — which is the wrong
              way round, because the decision to sell is the one you open this
              page having already half made. */}
          <div className="btn-row" style={{ marginTop: 6 }}>
            {h && (
              <button className="btn btn-sell" onClick={() => setTab("deal")}
                title={h.sale ? "Your listing, the bids and the offers" : "Take it to market — quietly or as a campaign"}>
                {h.sale
                  ? "◆ On the market — open the file"
                  : (leasedFee ? "Sell this leased fee" : "Sell this building")}
              </button>
            )}
            <button className="btn" onClick={() => useStore.getState().focus(bbl, true)}
              title="Close this page and fly the map to the building">
              ⌖ Go to property
            </button>
          </div>
        </div>
        <div className="grid" style={{ minWidth: 320 }}>
          {built && <Row k="Building" v={`${sf(rec.bldgArea)} · ${rec.floors} floors`} strong />}
          <Row k="Land" v={sf(rec.lotArea)} />
          <Row k="FAR built / envelope" v={`${(rec.bldgArea / Math.max(1, rec.lotArea)).toFixed(1)} / ${farMaxFor(rec).toFixed(1)}`} />
          <Row k="Buildable at max" v={`${sf(rec.lotArea * farMaxFor(rec))} · up to ${maxFloorsFor(rec, 0.6)} floors`} />
          {built && <Row k="Built" v={String(rec.yearBuilt)} />}
          <Row k="Demand" v={rec.demandScore + " / 100"} />
        </div>
      </div>
      {/* A default is not a tab. It is the only thing on the page that matters
          while it is running, so it stays above the tab bar on every one. */}
      <WorkoutDesk bbl={bbl} />
      {h?.taxAppeal ? (
        <div className="page-section">
          <div className="page-section-head">Assessment under appeal</div>
          <div className="grid">
            <Row k="Tax roll" v={usd(h.taxAppeal.assessedAtFile)} />
            <Row k="Market evidence filed" v={usd(h.taxAppeal.target)} strong />
            <Row k="Board sits" v={monthLabel(h.taxAppeal.decideM)} />
            <Row k="Odds as filed" v={`${(h.taxAppeal.odds * 100).toFixed(0)}%`} />
          </div>
        </div>
      ) : taxAppeal ? (
        <div className="page-section">
          <div className="page-section-head">Property-tax appeal</div>
          <div className="grid">
            <Row k="Tax assessment" v={usd(taxAppeal.assessed)} bad />
            <Row k="Current market evidence" v={usd(taxAppeal.target)} strong />
            <Row k="Potential annual saving" v={usd(taxAppeal.annualSavings)} />
            <Row k="Appraisal + counsel" v={usd(taxAppeal.fee)} />
            <Row k="Board timing / odds" v={`${taxAppeal.months} months · ${(taxAppeal.odds * 100).toFixed(0)}%`} />
          </div>
          <button className="btn" disabled={game.cash < taxAppeal.fee}
            onClick={() => useStore.getState().appealTax(bbl)}>
            Appeal the assessment · {usd(taxAppeal.fee)}
          </button>
          <div className="hint">
            The assessor follows markets up quickly and down slowly. You are paying for independent evidence;
            losing leaves the roll unchanged, and another challenge must wait three years.
          </div>
        </div>
      ) : null}

      <div className="prop-tabs">
        {shown.map((t) => (
          <button
            key={t.key}
            className={"prop-tab" + (active === t.key ? " on" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === "money" && <AssetHistory bbl={bbl} />}
      {active === "history" && (
        <div className="page-section">
          <div className="page-section-head">What has happened on this deed</div>
          <div className="mini-list">
            {timeline.map((event, i) => {
              const row = describePropertyEvent(event);
              return (
                <div className="mini-row" key={`${event.m}:${event.kind}:${i}`}>
                  <span>
                    <strong>{row.title}</strong>
                    <span className="dim"> · {row.detail}</span>
                  </span>
                  <span className="mono dim">{row.when}</span>
                </div>
              );
            })}
          </div>
          <div className="hint">
            Trades, major leases, construction, planning decisions and enforcement stay with the property,
            whoever owns it next. Your operating charts on Money cover only your own hold period.
          </div>
        </div>
      )}
      {active === "build" && dev && (
        <div className="page-section">
          <div className="page-section-head">{dev.mode === "reuse" ? "Conversion under way" : "Under construction"}</div>
          <div className="grid">
            <Row k="Program" v={`${sf(dev.sf)} of ${dev.use} · ${dev.floors} floors`} strong />
            {dev.bts && (
              <Row k="Build-to-suit"
                v={`${dev.bts.name} · ${sf(dev.bts.sf)} @ $${dev.bts.rentPsf.toFixed(2)}/sf · ${Math.round(dev.bts.termM / 12)} yrs`}
                strong />
            )}
            {/* THE BUDGET MOVES, AND SO DOES THE NUMBER THAT MATTERS.
                A job under way is not the job that was approved: change orders
                and cost-plus escalation grow costTotal every month it runs.
                Showing the budget alone made that invisible — the all-in per
                foot is the number a developer watches drift, because it is the
                one that decides whether the building is still worth finishing.
                Land is included for the same reason it is in the plan: it is
                in the basis the yield was underwritten against. */}
            <Row k="Budget" v={usd(dev.costTotal)} />
            <Row
              k="All in so far"
              v={`${usd(dev.costTotal + (dev.landBasis ?? 0) + dev.interestReserve)} · $${((dev.costTotal + (dev.landBasis ?? 0) + dev.interestReserve) / Math.max(1, dev.sf)).toFixed(0)}/sf`}
              strong
              title="Land, construction as it stands today including every change order booked so far, and the interest reserve. Compare it to what finished buildings on this street trade for per square foot — if the budget has drifted past that, the building is worth less than it costs to finish."
            />
            {/* Financed with the job, spent on tenants rather than steel, and
                paid across as cash the day the building opens. */}
            {(dev.leaseUpReserve ?? 0) > 0 && (
              <Row k="Lease-up reserve" v={`${usd(dev.leaseUpReserve!)} — released at delivery`} />
            )}
            <Row k="Delivers" v={monthLabel(dev.deliverM)} />
            {/* STILL TO FUND. The one number a developer mid-build checks every
                month, and it was nowhere on this screen. */}
            <Row
              k="Equity you have put in"
              v={`${usd(dev.equitySpent)} of ${usd(dev.equityBudget)}`}
            />
            <Row
              k="Still to come out of your account"
              v={usd(Math.max(0, dev.equityBudget - dev.equitySpent))}
              strong
              bad={dev.equityBudget - dev.equitySpent > game.cash}
            />
            {dev.costTotal > 0 && dev.contingencyUsed > 0 && (
              <Row k="Contingency used" v={`${usd(dev.contingencyUsed)} of ${usd(dev.contingency)}`} bad={dev.contingencyUsed > dev.contingency * 0.7} />
            )}
          </div>
        </div>
      )}
      <div className="prop-cols">
        <ParcelPanel embedded tab={active} />
      </div>
    </div>
  );
}
