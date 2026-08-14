import { useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { useHeldGame } from "@/ui/heldGame";
import { monthLabel } from "@/engine/types";
import type { GameState } from "@/engine/types";
import type { ParcelTable, Adjacency } from "@/data/types";
import { ownedHoldingValue, resolveRec, landPsfNow, landRead, plateEfficiency } from "@/engine/value";
import { workoutMood } from "@/engine/workout";
import { fundableNow, locAvailable } from "@/engine/credit";
import { SECTOR_LABEL } from "@/engine/market";
import { LineChart } from "@/ui/Chart";
import Slider from "@/ui/Slider";
import { USE_WORD } from "@/engine/mix";
import { specSuiteQuote, blendExtendQuote, useVacantSf, leasableUses } from "@/engine/leasing";
import { leasingOdds } from "@/engine/absorption";
import {
  groundLeaseExpenseBreakdown, groundLeaseQuote, GROUND_REVIEW_LABEL, GROUND_TERM_MIN, GROUND_TOWER_TERM_MIN,
  mergeCost, siteDeeds, siteLotArea, contiguousOwnedRoots, hasOwnedSiteNeighbor,
} from "@/engine/actions";
import type { GroundReview } from "@/engine/types";
import { varianceQuote } from "@/engine/zoning";
import { bareLandRec, leasedFeeValue } from "@/engine/value";
import { usd, sf } from "@/ui/format";
import { useLabel, Row } from "@/ui/panels/shared";

type AssembleCand = {
  bbl: string;
  rec: ReturnType<typeof resolveRec>;
  why: string | null;
  area: number;
  deeds: number;
};

const EMPTY_ASSEMBLE: { eligible: AssembleCand[]; blocked: AssembleCand[] } = {
  eligible: [], blocked: [],
};

/** Assemble candidates for one site. Cheap neighbour gate first — the desk is
 *  mounted on every selected holding, and walking the contiguous owned block
 *  on every click was the lag. */
function useAssembleCandidates(
  game: GameState, parcels: ParcelTable, adjacency: Adjacency | null, bbl: string,
) {
  const touch = !!(adjacency && hasOwnedSiteNeighbor(game, adjacency, bbl));
  return useMemo(() => {
    if (!touch || !adjacency) return EMPTY_ASSEMBLE;
    const component = contiguousOwnedRoots(game, adjacency, bbl).filter((r) => r !== bbl);
    const candidates = component.map((n) => {
      const r = resolveRec(parcels, game, n);
      const area = siteLotArea(game, parcels, n);
      const deeds = siteDeeds(game, n).length;
      const why = !r ? "unknown parcel"
        : game.developments[n] ? "under construction"
        : game.groundLeases?.[n] ? "ground-leased to somebody else"
        : game.holdings[n]?.sale ? "on the market — pull the listing"
        : game.landmarks?.[n] !== undefined ? "landmarked"
        : game.holdings[n]?.loan ? "mortgage outstanding — pay it off first"
        : game.facility?.bbls?.includes(n) ? "in the portfolio facility — release it first"
        : r.class !== "land" || r.bldgArea > 0 ? `${useLabel(r)} standing — clear it first`
        : null;
      return { bbl: n, rec: r, why, area, deeds };
    });
    return {
      eligible: candidates.filter((x) => !x.why),
      blocked: candidates.filter((x) => x.why),
    };
    // When there is nothing to assemble, `touch` is false and `game` is not a
    // dependency — Advance/news/cash must not rewalk. When there is, `game` is.
  }, [touch, touch ? game : null, adjacency, bbl, parcels]);
}

/**
 * THE ASSET'S OWN TRACK RECORD.
 *
 * Three lines, three scales, one column: what share of it is let, what the let
 * space is paying per foot, and what the whole thing nets. Read together they
 * are the only diagnosis this game could not give you — because a falling NOI
 * has three completely different causes and the panel showed you a single
 * number that could not tell them apart. Occupancy down with rent flat is a
 * leasing problem. Rent down with occupancy flat is a market you cannot fix.
 * Both flat with NOI falling is the expense stack, and that one is yours.
 *
 * Recorded quarterly by the engine from the same operating statement the
 * appraisal runs — see Holding.hist. Nothing here is recomputed, so the chart
 * and the cash statement can never disagree about a month that has happened.
 */
export function AssetHistory({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const h = game.holdings[bbl];
  const rows = h?.hist ?? [];
  if (!h) return null;
  if (rows.length < 2) {
    return (
      <div className="deal">
        <div className="deal-head">Track record</div>
        <div className="hint">
          Held since {monthLabel(h.boughtM)}. The record is stamped every quarter — there is not
          enough of it yet to draw.
        </div>
      </div>
    );
  }
  const occ = rows.map((r) => r[1] / 10);          // per cent
  const rent = rows.map((r) => r[2] / 100);        // $/sf/yr
  const noi = rows.map((r) => r[3]);               // $/yr
  const xs: [string, string] = [monthLabel(rows[0][0]), monthLabel(rows[rows.length - 1][0])];
  // What it has actually done, in one line, so the charts have a conclusion
  // and not just a shape.
  const dOcc = occ[occ.length - 1] - occ[0];
  const dRent = rent[0] > 0 ? (rent[rent.length - 1] / rent[0] - 1) * 100 : 0;
  const yrs = Math.max(0.25, (rows[rows.length - 1][0] - rows[0][0]) / 12);
  return (
    <div className="deal">
      <div className="deal-head">Track record · {yrs.toFixed(1)} years on the books</div>
      <div className="grid">
        <Row k="Occupancy" v={`${occ[occ.length - 1].toFixed(0)}% · ${dOcc >= 0 ? "+" : ""}${dOcc.toFixed(0)}pp since you bought it`} bad={dOcc < -5} />
        <Row k="In-place rent" v={`$${rent[rent.length - 1].toFixed(2)}/sf · ${dRent >= 0 ? "+" : ""}${dRent.toFixed(0)}% · ${(Math.pow(1 + dRent / 100, 1 / yrs) - 1 >= 0 ? "+" : "")}${((Math.pow(1 + dRent / 100, 1 / yrs) - 1) * 100).toFixed(1)}%/yr`} />
        <Row k="NOI" v={`${usd(noi[noi.length - 1])}/yr`} bad={noi[noi.length - 1] < 0} strong />
      </div>
      <div className="chart-stack">
        <div className="chart-cap">Occupancy · % of the building let</div>
        <LineChart
          series={[{ label: "Occupied", color: "#5aa9e6", pts: occ }]}
          xLabels={xs} height={104} yFmt={(v) => v.toFixed(0) + "%"}
        />
        <div className="chart-cap">In-place rent · $/sf/yr on let space</div>
        <LineChart
          series={[{ label: "In place", color: "#e0a34a", pts: rent }]}
          xLabels={xs} height={104} yFmt={(v) => "$" + v.toFixed(0)}
        />
        <div className="chart-cap">Net operating income · $/yr</div>
        <LineChart
          series={[{ label: "NOI", color: "#6fcf97", pts: noi }]}
          xLabels={xs} height={104} zeroBase
        />
      </div>
    </div>
  );
}



/**
 * THE LAND DESK.
 *
 * Dirt used to cost 1.2% a year and do nothing else, which makes a land bank a
 * parking meter rather than a position. Two things you can do with a lot you
 * are not building on yet, and both of them are decisions:
 *
 *   • Fold the neighbours in. Assemblage pressure has been making every
 *     approach on this block dearer since the first one; this is what those
 *     premiums were for — one site, one envelope, one building.
 *   • Ground-lease it. A coupon on the land with no operating risk at all, and
 *     the certain knowledge that you will sit out every cycle in between.
 */
/**
 * THE LEASING DESK.
 *
 * Leasing was the shallowest thing on the screen: one letter of intent a month
 * with accept, counter or pass, and no way to do anything about it in between.
 * These are the two decisions a landlord actually makes about empty space and
 * about space that is about to be empty.
 */
/**
 * THE WORKOUT DESK.
 *
 * A default used to be a single line of news: the balloon came due, you had no
 * cash, the building was sold at a distress price in the same tick, and a
 * black mark went on the record. That is the last page of a foreclosure. What
 * actually happens is fourteen months of decisions with a lender who has
 * problems of their own — and this is that table.
 *
 * Nothing here is advice with a right answer. Curing is expensive and always
 * available if you have the money. Forbearance is buying time at their price,
 * and whether it is even offered depends on THEIR capital ratio, which you can
 * read on Research. A deed in lieu settles the debt in full and is usually the
 * right move, and it still costs you a building and a piece of your record.
 * Doing nothing is also a choice, and it is the most expensive one.
 */
export function WorkoutDesk({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const { cureDefault, askForbearance, handBackKeys } = useStore.getState();
  const w = game.workouts?.[bbl];
  const h = game.holdings[bbl];
  if (!w || !h?.loan) return null;
  const rec = resolveRec(parcels, game, bbl);
  if (!rec) return null;
  const mood = workoutMood(game, w.lender);
  const value = ownedHoldingValue(game, parcels, h);
  const bal = h.loan.balance;
  const monthsLeft = Math.max(0, w.decideM - game.month);
  const fee = Math.round(bal * mood.feePct);
  const paydown = Math.round(bal * mood.paydownPct);
  const equity = value - bal;
  const filed = w.stage === "foreclosure";
  // Equity cures are cash-only; arrears/balloon catch-ups may draw the line —
  // the Cure button used to look at cash alone and tell a funded sponsor they
  // were short while the revolver sat open.
  const allowLoc = w.cause !== "covenant";
  const liquidity = Math.max(0, Math.floor(game.cash)) + (allowLoc ? locAvailable(game, parcels) : 0);
  const canCure = liquidity >= w.cure;
  const couponOk = fundableNow(game, parcels) >= h.loan.monthlyPmt;
  return (
    <div className="page-section">
      <div className="page-section-head neg">
        {filed ? "Foreclosure filed" : w.stage === "forbearance" ? "Forbearance — extended paper" : "In default"}
        {" · "}{w.lender}
      </div>
      <div className="hint">
        {w.cause === "balloon"
          ? "The loan matured and there was no refinancing and no cash to close the gap."
          : w.cause === "covenant"
            ? "The covenant is broken and the cure period has not fixed it."
            : "The payments stopped."}{" "}
        {filed
          ? `They have filed. The auction is set for ${monthLabel(w.decideM)} — ${monthsLeft} month${monthsLeft === 1 ? "" : "s"} from now — and an auction fetches less than a distress sale does, because everybody bidding knows the seller has no choice at all.`
          : couponOk
            ? `The coupon is fundable — they will not file while you keep it current. Cure it outright, refinance, or sell before that changes.`
            : `You have until ${monthLabel(w.decideM)}, ${monthsLeft} month${monthsLeft === 1 ? "" : "s"}, before they file.`}
      </div>
      <div className="grid" style={{ marginBottom: 10 }}>
        <Row k="Balance owed" v={usd(bal)} strong />
        <Row k="What the building is worth" v={usd(value)} />
        <Row k="Equity behind it" v={usd(equity)} bad={equity < 0} strong={equity > 0} />
        <Row k="Paper" v={h.loan.recourse ? "recourse — a shortfall follows you" : "non-recourse — the keys are the answer"}
          bad={h.loan.recourse} />
        <Row k="To cure it outright" v={usd(w.cure)} bad={!canCure} />
        <Row k={allowLoc ? "Liquidity (cash + line)" : "Cash on hand"} v={usd(liquidity)} bad={!canCure} />
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>{mood.why}</div>
      <div className="btn-row">
        <button className="btn" disabled={!canCure} onClick={() => cureDefault(bbl)}
          title={!canCure ? `You are ${usd(w.cure - liquidity)} short` : "Pay it and the file closes"}>
          Cure — {usd(w.cure)}
        </button>
        {!filed && w.asks < 1 && (
          <button className="btn" onClick={() => askForbearance(bbl)}
            title={mood.willExtend
              ? `${(mood.feePct * 100).toFixed(0)}% fee and a ${(mood.paydownPct * 100).toFixed(0)}% paydown — ${usd(fee + paydown)} — for 18 to 30 months, at ${(h.loan.ratePct + mood.bumpPct).toFixed(2)}% with cash flow swept`
              : "They can be asked. On this balance sheet they will almost certainly say no."}>
            Ask them to extend{mood.willExtend ? ` — ${usd(fee + paydown)}` : ""}
          </button>
        )}
        <button className="btn btn-danger" onClick={() => handBackKeys(bbl)}
          title="Deed in lieu: the debt is settled in full, there is no deficiency even on recourse paper, and it is a smaller mark than an auction">
          Hand back the deed
        </button>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        {equity > bal * 0.12
          ? "There is real equity here. Curing it or selling it into the open market beats handing it over — a deed in lieu gives away everything above the debt."
          : h.loan.recourse
            ? "You signed for this one. At auction the shortfall comes out of your account; a deed in lieu settles the debt in full and there is no deficiency. That difference is the whole reason to walk into their office rather than wait."
            : "The paper is non-recourse and the debt is above the value. Handing it back costs you the building and nothing else, and it is a smaller mark than letting them take it."}
      </div>
    </div>
  );
}

/**
 * WHY THIS BUILDING IS OR IS NOT LETTING.
 *
 * A building that will not lease for reasons the owner cannot read is not
 * difficulty, it is a bug nobody can report. So the arithmetic that decides a
 * letter of intent is put on the screen in the terms a leasing agent would use
 * it in: how much space you are marketing, how much else the tenant could take
 * instead, what the city is actually looking for this month, and what share of
 * that your building can expect to win. Underneath it, every reason this
 * building beats or loses to the one across the street, named and multiplied
 * out.
 *
 * It is a readout, not a chore. There is nothing to press here — the moves it
 * argues for are the ones already on the Management block above: an exclusive,
 * a capital programme, pre-built suites, or coming off your asking rent.
 */
export function LettingOdds({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const h = game.holdings[bbl];
  const rec = h ? resolveRec(parcels, game, bbl) : null;
  if (!h || !rec || h.leasingHold) return null;
  const legs = leasableUses(rec)
    .map((u) => leasingOdds(game, parcels, rec, h, u))
    .filter((o): o is NonNullable<typeof o> => !!o && o.availSf > 1500);
  if (!legs.length) return null;
  return (
    <div className="deal">
      <div className="deal-head">Letting — where you stand in the market</div>
      {legs.map((o) => (
        <div key={o.use}>
          {legs.length > 1 && (
            <div className="page-section" style={{ marginTop: 2 }}>{SECTOR_LABEL[o.use]}</div>
          )}
          <div className="grid">
            <Row k="You are marketing" v={`${sf(Math.round(o.availSf))} · reads as ${sf(Math.round(o.marketedSf))} of usable space`} />
            <Row
              k="Vacancy · city / your corner"
              v={`${(o.cityVac * 100).toFixed(1)}% / ${(o.localVac * 100).toFixed(1)}%`}
              bad={o.localVac > o.cityVac * 1.12}
            />
            <Row k="Competing supply" v={`${sf(Math.round(o.competingSf))} available or coming back`} />
            <Row k="The city is looking for" v={`${sf(Math.round(o.requirementSf))} this month`} />
            <Row k="Your share of it" v={`${(o.shareOfMarket * 100).toFixed(2)}% · about ${sf(Math.round(o.captureSf))} a month`} />
            <Row
              k="Your ask vs the market"
              v={`${o.askPsf.toFixed(2)} vs ${o.marketPsf.toFixed(2)}`}
              bad={o.askPsf > o.marketPsf * 1.04}
            />
            <Row
              k="To 85% let at this pace"
              v={o.monthsToLet === null ? "it does not get there" : o.monthsToLet <= 0 ? "already there" : `${o.monthsToLet} months`}
              strong
              bad={o.monthsToLet === null || o.monthsToLet > 48}
            />
          </div>
          <div className="roll">
            {o.factors.map((f) => (
              <div className="roll-row" key={f.label}>
                <span className="roll-name">
                  {f.label} · <span className="dim">{f.detail}</span>
                </span>
                <span className="roll-meta mono">×{f.mult.toFixed(2)}</span>
              </div>
            ))}
            <div className="roll-row roll-group">
              <span className="roll-name">This building against an ordinary one</span>
              <span className="roll-meta mono">×{o.weight.toFixed(2)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LeasingDesk({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const { prebuild, extendLease } = useStore.getState();
  const [size, setSize] = useState(0);
  const h = game.holdings[bbl];
  const rec = h ? resolveRec(parcels, game, bbl) : null;
  if (!h || !rec) return null;

  const spec = h.specSuites;
  // the use with the most open space is the one worth pre-building
  const legs = leasableUses(rec)
    .map((u) => ({ u, free: useVacantSf(rec, h, u, game.month) }))
    .filter((x) => x.free > 900)
    .sort((a, b) => b.free - a.free);
  const leg = legs[0];
  const want = size || (leg ? Math.round(Math.min(leg.free, leg.free * 0.5)) : 0);
  const q = leg ? specSuiteQuote(game, rec, h, leg.u, want) : null;

  // sitting tenants worth going to early
  const extends_ = h.tenants
    .map((_, i) => blendExtendQuote(game, rec, h, i))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => (b.current - b.market) - (a.current - a.market));

  // Emptying the building moved to VacantPossession, next to the wrecking
  // bill, which is the only reason anybody empties one.
  if (!spec && !q && !extends_.length) return null;
  return (
    <div className="deal">
      <div className="deal-head">Leasing desk</div>

      {spec && (
        <div className="grid">
          <Row k="Pre-built space" v={`${sf(spec.sf)} of ${USE_WORD[spec.use]}`} strong />
          <Row k={game.month >= spec.readyM ? "Status" : "Ready"}
            v={game.month >= spec.readyM ? "Turnkey and being toured" : monthLabel(spec.readyM)} />
        </div>
      )}

      {!spec && q && leg && (
        <>
          <div className="page-section" style={{ marginTop: 2 }}>Pre-build the space</div>
          <div className="slider">
            <div className="slider-head">
              <span className="slider-label">{USE_WORD[leg.u]} to fit out · of {sf(Math.round(leg.free))} open</span>
              <span className="slider-value">{sf(q.sf)}</span>
            </div>
            <input type="range" min={800} max={Math.round(leg.free)} step={100} value={want}
              style={{ ["--fill" as string]: `${((want - 800) / Math.max(1, leg.free - 800)) * 100}%` }}
              onChange={(e) => setSize(Number(e.target.value))} />
          </div>
          <div className="grid">
            <Row k="Cost now" v={usd(q.cost)} strong />
            <Row k="Ready" v={monthLabel(q.readyM)} />
          </div>
          <div className="hint">
            Turnkey suites tour nearly twice as often, ask about 5% more rent, and need almost no fit-out allowance —
            because you have already paid it. If the space sits anyway, so does the money.
          </div>
          <button className="btn" onClick={() => prebuild(bbl, leg.u, q.sf)}>
            Pre-build {sf(q.sf)} for {usd(q.cost)}
          </button>
        </>
      )}

      {extends_.length > 0 && (
        <>
          <div className="page-section" style={{ marginTop: 10 }}>Go to a tenant early</div>
          <table className="tbl">
            <thead>
              <tr><th>Tenant</th><th className="num">Rent now</th><th className="num">Market</th><th className="num">They&apos;ll take</th><th className="num">Adds</th><th /></tr>
            </thead>
            <tbody>
              {extends_.slice(0, 5).map((e) => (
                <tr key={e.idx}>
                  <td>{e.name}</td>
                  <td className="num">${e.current.toFixed(0)}</td>
                  <td className="num">${e.market.toFixed(0)}</td>
                  <td className={"num" + (e.newRent < e.current ? " neg" : "")}>${e.newRent.toFixed(0)}</td>
                  <td className="num">{(e.addM / 12).toFixed(0)} yrs</td>
                  <td><button className="btn-mini" onClick={() => extendLease(bbl, e.idx)}>extend</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint">
            Blend and extend: give up rent today, take term for it. Cheap WALT if the market is about to soften,
            and a discount you did not need to give if it is not.
          </div>
        </>
      )}
    </div>
  );
}

/**
 * WHY THIS DIRT COSTS WHAT IT COSTS (ECONOMY.md: land value is a residual).
 *
 * This card used to work the residual out for itself and got a different answer
 * from the engine — median −$0.08M here against $0.46M there, on the same lots.
 * It forced 0.6 site coverage, took the margin as `value·(1−m)` instead of
 * `value/(1+m)`, skipped the discount for the years a site waits, and read spot
 * rent where the engine reads the rent a developer expects. Four defensible
 * choices adding up to a number the player could price land from that was not
 * the price of the land.
 *
 * So it renders `landRead` now: the same three bids the engine ran, and which of
 * them won. A builder bids what is left after the building pays for itself and
 * pays him. A holder bids the option — the residual at the next peak's rents,
 * discounted for the wait — which is why fringe dirt is cheap and not free. And
 * the map's own texture puts a floor under both. Shown on any vacant lot, owned
 * or not, because the read matters most BEFORE the money moves.
 */
export function ResidualRead({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const rec = resolveRec(parcels, game, bbl);
  if (!rec || !rec.lotArea) return null;
  const read = landRead(rec, game.econ);
  const s = read.scheme;
  const lot = Math.max(1, rec.lotArea);
  const USE_LABEL: Record<string, string> = {
    office: "office", multifamily: "flats", retail: "shops", industrial: "industrial",
  };
  if (read.winner === "builder" && s) {
    return (
      <div className="grid">
        <Row k="What pencils" v={`${USE_LABEL[s.use] ?? s.use} at ${s.floors} floors — worth $${s.valuePsf.toFixed(0)}/sf built against $${s.costPsf.toFixed(0)}/sf all-in`} strong />
        <Row k="Residual to the dirt" v={`${usd(Math.round(read.builder * lot))} · $${read.builder.toFixed(0)}/sf of land, after the builder's margin and the wait`} />
        <Row k="What it trades at" v={`${usd(Math.round(read.psf * lot))} · $${read.psf.toFixed(0)}/sf — a builder is the high bidder here`} />
      </div>
    );
  }
  return (
    <div className="grid">
      {s
        ? <Row k="Nothing pencils today" v={`the best scheme (${USE_LABEL[s.use] ?? s.use}) is worth $${s.valuePsf.toFixed(0)}/sf finished against $${s.costPsf.toFixed(0)}/sf to build`} strong />
        : <Row k="Nothing pencils today" v="no use covers its own construction at these rents" strong />}
      <Row k="Held for the next cycle" v={`${usd(Math.round(read.holder * lot))} · $${read.holder.toFixed(0)}/sf — the residual at peak rents, discounted for the years of waiting`} />
      <Row k="What it trades at" v={`${usd(Math.round(read.psf * lot))} · $${read.psf.toFixed(0)}/sf — ${read.winner === "holder" ? "a holder is the high bidder" : "the street sets it, not the income"}`} />
    </div>
  );
}

/**
 * Fold contiguous owned vacant lots into one site. Lives on the Land desk and
 * also opens from the portfolio row — the book is where you notice two vacant
 * addresses that share a property line, and the only other path was Property →
 * Build buried under planning and ground lease.
 */
export function AssembleSection({
  bbl, onDone, embedded,
}: {
  bbl: string;
  onDone?: () => void;
  /** Inside the Land desk — skip the outer deal chrome. */
  embedded?: boolean;
}) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const adjacency = useStore((s) => s.adjacency);
  const { assemble } = useStore.getState();
  const [picked, setPicked] = useState<string[]>([]);
  const { eligible, blocked } = useAssembleCandidates(game, parcels, adjacency, bbl);
  const h = game.holdings[bbl];
  const rec = h ? resolveRec(parcels, game, bbl) : null;
  if (!h || !rec) return null;

  const vacant = rec.class === "land" && rec.bldgArea === 0;
  const children = siteDeeds(game, bbl).slice(1);
  const selfBlocked = !vacant
    ? `${useLabel(rec)} standing — clear this site before folding anything in`
    : h.loan ? "mortgage outstanding on this site — pay it off first"
    : game.facility?.bbls?.includes(bbl) ? "this site is in the portfolio facility — release it first"
    : game.groundLeases?.[bbl] ? "ground-leased — pull it back before folding title"
    : h.sale ? "on the market — pull the listing first"
    : null;
  if (!children.length && !eligible.length && !blocked.length) return null;

  const farMax = Math.max(rec.farMaxComm, rec.farMaxRes);
  const livePicked = picked.filter((n) => eligible.some((x) => x.bbl === n));
  const pickedDeeds = livePicked.reduce((a, n) => a + siteDeeds(game, n).length, 0);
  const cost = mergeCost(game, siteDeeds(game, bbl).length + pickedDeeds);
  const addedArea = livePicked.reduce((a, n) => a + siteLotArea(game, parcels, n), 0);

  return (
    <div style={embedded ? undefined : { padding: "8px 2px" }}>
      {!embedded && <div className="deal-head">Assemble contiguous lots</div>}
      {selfBlocked && (eligible.length > 0 || blocked.length > 0) && (
        <div className="hint">
          You own contiguous dirt next to this parcel, but {selfBlocked.toLowerCase()}. Assembling moves the land into
          one site — every deed in the filing has to be clear vacant ground.
        </div>
      )}
      {children.length > 0 && (
        <div className="hint">
          Assembled site — {children.length + 1} deeds, {sf(rec.lotArea)} of land, {sf(Math.round(rec.lotArea * farMax))} buildable.
          {eligible.length > 0 ? " Fold in more contiguous lots below to grow it." : ""}
        </div>
      )}
      {(eligible.length > 0 || blocked.length > 0) && (
        <>
          <div className="page-section" style={{ marginTop: 2 }}>
            Assemble contiguous lots
            {eligible.length > 1 && vacant && !selfBlocked && (
              <button
                className="btn btn-sm"
                style={{ marginLeft: 8 }}
                onClick={() => setPicked(eligible.map((x) => x.bbl))}
              >
                Select all clear ({eligible.length})
              </button>
            )}
          </div>
          <div className="hint">
            Own two or more lots that touch — including through a lot you already folded in — and you can turn them
            into one site: one plate, one envelope, one address.
          </div>
          <div className="mini-list">
            {eligible.map((x) => {
              const on = livePicked.includes(x.bbl);
              return (
                <button key={x.bbl} className={"neighbor" + (on ? " neighbor-on" : "")}
                  disabled={!!selfBlocked}
                  onClick={() => setPicked(on ? livePicked.filter((n) => n !== x.bbl) : [...livePicked, x.bbl])}>
                  <span className="neighbor-addr">{on ? "✓ " : ""}{x.rec?.address ?? x.bbl}</span>
                  <span className="neighbor-meta">
                    {sf(x.area)} of land
                    {x.deeds > 1 ? ` · ${x.deeds} deeds already assembled` : " · vacant"}
                  </span>
                </button>
              );
            })}
            {blocked.map((x) => (
              <div key={x.bbl} className="neighbor" style={{ opacity: 0.55, cursor: "default" }}>
                <span className="neighbor-addr">{x.rec?.address ?? x.bbl}</span>
                <span className="neighbor-meta">{x.why}</span>
              </div>
            ))}
          </div>
          {livePicked.length > 0 && !selfBlocked && (
            <>
              <div className="grid">
                <Row k="Site after merger" v={`${sf(rec.lotArea + addedArea)} · ${sf(Math.round((rec.lotArea + addedArea) * farMax))} buildable`} strong />
                <Row k="Was" v={`${sf(rec.lotArea)} · ${sf(Math.round(rec.lotArea * farMax))} buildable`} />
                {(() => {
                  const before = plateEfficiency(rec.lotArea * 0.62);
                  const after = plateEfficiency((rec.lotArea + addedArea) * 0.62);
                  const gain = (after / before - 1) * 100;
                  return gain > 0.5
                    ? <Row k="Plate efficiency" v={`+${gain.toFixed(1)}% rentable on the same gross — one core, bigger floors`} />
                    : null;
                })()}
                {(() => {
                  const mergedRec = { ...rec, lotArea: rec.lotArea + addedArea };
                  const now = landPsfNow(rec, game.econ);
                  const then = landPsfNow(mergedRec, game.econ);
                  const d = (then / Math.max(1, now) - 1) * 100;
                  return Math.abs(d) > 0.5
                    ? <Row k="The dirt reprices" v={`${d > 0 ? "+" : ""}${d.toFixed(1)}% $/sf across the whole site`} />
                    : null;
                })()}
                <Row k="Survey, title and lawyers" v={usd(cost)} />
              </div>
              <button
                className="btn"
                onClick={() => {
                  assemble([bbl, ...livePicked]);
                  setPicked([]);
                  onDone?.();
                }}
              >
                Assemble into one site · {sf(rec.lotArea + addedArea)}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** True when the portfolio / land desk should offer an Assemble action. */
export function canAssembleFromBook(
  game: GameState, adjacency: Adjacency | null, bbl: string,
): boolean {
  if (!adjacency || !game.holdings[bbl] || game.merged?.[bbl]) return false;
  if (game.groundLeases?.[bbl]) return false;
  return hasOwnedSiteNeighbor(game, adjacency, bbl);
}

export function LandDesk({ bbl }: { bbl: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels)!;
  const adjacency = useStore((s) => s.adjacency);
  const select = useStore((s) => s.select);
  const focus = useStore((s) => s.focus);
  const { groundLease, pullGroundOffer, applyVariance } = useStore.getState();
  const [years, setYears] = useState(GROUND_TOWER_TERM_MIN);
  const [review, setReview] = useState<GroundReview>("fixed");
  const [farMultiple, setFarMultiple] = useState(1.5);
  // Cheap neighbour gate — same predicate AssembleSection uses, so the land
  // desk does not mount the full candidate walk when there is nothing to fold.
  const touch = !!(adjacency && hasOwnedSiteNeighbor(game, adjacency, bbl));
  const h = game.holdings[bbl];
  const rec = h ? resolveRec(parcels, game, bbl) : null;
  if (!h || !rec) return null;

  const gl = game.groundLeases?.[bbl];
  if (gl) {
    const yrsLeft = Math.max(0, (gl.endM - game.month) / 12);
    const rev: GroundReview = gl.review ?? "fixed";
    const bare = bareLandRec(parcels, game, bbl);
    const fee = bare ? leasedFeeValue(gl, bare, game.econ, game.month, gl.sf ?? game.built?.[bbl]?.bldgArea ?? 0) : 0;
    const cashFlow = groundLeaseExpenseBreakdown(gl.rentYr);
    const job = (game.cityJobs ?? []).find((j) => j.bbl === bbl && j.groundLease);
    const nextReview = rev === "fixed"
      ? `${monthLabel(gl.lastStepM + gl.stepEveryM)} · +${gl.stepPct}%`
      : rev === "cpi"
        ? `${monthLabel(gl.lastStepM + gl.stepEveryM)} · CPI (2–4%)`
        : `${monthLabel(gl.lastStepM + gl.stepEveryM)} · FMV, capped ${(gl.fmvCapPct ?? 3.5).toFixed(1)}%/yr`;
    return (
      <div className="deal">
        <div className="deal-head">Ground-leased · leased fee</div>
        <div className="grid">
          <Row k="Lessee" v={gl.tenant} />
          <Row k="Gross ground rent" v={`${usd(cashFlow.grossRentYr)} / yr`} />
          <Row k="Property tax" v="$0 to you · lessee pays" />
          <Row k="Insurance + operating" v="$0 to you · lessee pays" />
          <Row k="TI / building work" v="$0 to you · lessee pays" />
          <Row k="Brokerage + legal at signing" v="$0 to you · lessee pays" />
          <Row k="Net cash income" v={`${usd(cashFlow.netRentYr)} / yr`} strong />
          <Row k="Review" v={`${GROUND_REVIEW_LABEL[rev]} · ${nextReview}`} />
          <Row k="Leased-fee mark" v={usd(fee)} strong />
          <Row k="Reverts" v={`${monthLabel(gl.endM)} · ${yrsLeft.toFixed(0)} years to run`} />
          {job && !gl.builtM && (
            <Row k="Their frame" v={`${job.floors} fl of ${job.use} · opens ${monthLabel(job.deliverM)}`} />
          )}
          {gl.builtM !== undefined && (
            <Row k="Standing on it" v={`${gl.floors ?? "?"} fl of ${gl.use ?? "—"} · opened ${monthLabel(gl.builtM)}`} />
          )}
        </div>
        <div className="hint">
          Absolutely net: gross rent equals net rent. No tenants of yours, no roof, no vacancy and no signing
          cheque. Selling assigns the leased fee — the buyer takes the coupon and the reversion; the lease does
          not evaporate. The dirt and the bones come back to whoever holds the fee at expiry, or immediately
          after an uncured tenant default.
        </div>
      </div>
    );
  }

  const children = siteDeeds(game, bbl).slice(1);
  const isChild = game.merged?.[bbl];
  if (isChild) {
    const parent = resolveRec(parcels, game, isChild);
    return (
      <div className="deal">
        <div className="deal-head">Part of an assemblage</div>
        <div className="hint">
          This deed has been folded into {parent?.address ?? isChild}. Its land, its envelope and its value all sit
          with the site now — build there, not here.
        </div>
        <button
          className="btn"
          onClick={() => { select(isChild); focus(isChild, true); }}
        >
          Open the site · {parent?.address ?? isChild}
        </button>
      </div>
    );
  }

  const vacant = rec.class === "land" && rec.bldgArea === 0;
  const landmarked = game.landmarks?.[bbl] !== undefined;
  const currentFar = Math.max(rec.farMaxComm, rec.farMaxRes, 2);
  const targetFar = currentFar * farMultiple;
  const vq = landmarked ? null : varianceQuote(game, parcels, bbl, targetFar);
  const app = game.varianceApps?.[bbl]
    ?? (game.varianceApp?.bbl === bbl ? game.varianceApp : null);

  // THE PLANNING BOARD. Available on anything you own, built or not — the
  // envelope is worth asking about whether or not there is already something
  // standing on it, and on an assembled site it is the entire point.
  const planning = (
    <>
      {landmarked && (
        <div className="hint">
          Landmarked. The envelope is frozen at what is already standing, nobody knocks it down, and it lets about
          7% over the market for the rest of its life. That premium is the whole of what you get for the site.
        </div>
      )}
      {app && (
        <div className="grid">
          <Row k="Before the board" v={`${app.grant.toFixed(1)} FAR · they sit ${monthLabel(app.decideM)}`} strong />
          <Row k="Odds as filed" v={`${(app.odds * 100).toFixed(0)}%`} />
        </div>
      )}
      {(() => {
        const v = game.varianceLog?.[bbl];
        if (!v || game.month - v.m > 120) return null;
        const yrs = (game.month - v.m) / 12;
        return (
          <div className="grid">
            <Row
              k={v.granted ? "◆ Variance GRANTED" : "◇ Variance REFUSED"}
              v={`${v.far.toFixed(1)} FAR asked · ${monthLabel(v.m)}${yrs >= 1 ? ` · ${yrs.toFixed(0)} yr${yrs >= 2 ? "s" : ""} ago` : ""}`}
              strong
              bad={!v.granted}
            />
            <Row
              k="What it cost to find out"
              v={`${usd(v.cost)} in fees${v.granted ? "" : " — spent either way"}`}
            />
          </div>
        );
      })()}
      {!app && vq && (
        <>
          <Slider
            label="FAR to request"
            value={farMultiple}
            min={1.1}
            max={3}
            step={0.05}
            onChange={setFarMultiple}
            format={() => `${vq.targetFar.toFixed(1)} FAR · ${farMultiple.toFixed(2)}× current · ${sf(Math.round(rec.lotArea * vq.targetFar))} gross envelope`}
            marks={[{ at: 1.34, label: "ordinary" }, { at: 2, label: "2×" }, { at: 3, label: "3×" }]}
            hint="You may ask for a much taller envelope. Larger requests cost more, take longer and are harder to approve; a second trip after a grant is still possible, just tougher. Engineering and the 40-FAR city ceiling still apply."
          />
          <div className="grid">
            <Row k="District envelope" v={`${Math.max(rec.farMaxComm, rec.farMaxRes).toFixed(1)} FAR${game.zoneAdj?.[rec.district] ? ` · rezoned to ${((game.zoneAdj[rec.district]) * 100).toFixed(0)}%` : ""}`} />
            {(game.variance?.[bbl] ?? 0) > 0 && <Row k="Variance already won" v={`+${game.variance![bbl].toFixed(1)} FAR · next hearing is harder`} />}
            <Row k="Ask the board for" v={`${vq.targetFar.toFixed(1)} FAR total · +${vq.grant.toFixed(1)}`} strong />
            <Row k="Fees" v={usd(vq.cost)} />
            <Row k="They decide in" v={`${vq.months} months · ${(vq.odds * 100).toFixed(0)}% say yes`} bad={vq.odds < 0.3} />
          </div>
          <button className="btn" onClick={() => applyVariance(bbl, vq.targetFar)}>File for {vq.targetFar.toFixed(1)} FAR · {usd(vq.cost)}</button>
          <div className="hint">
            Lawyers, an architect and a year of hearings, spent whether they say yes or not. You can come back after a
            grant — the board will hear it — but each FAR already won makes the next ask costlier and less likely.
            On a site you have just assembled this is the other half of the trade: the lots are worth putting together
            because of what you are allowed to build on them.
          </div>
        </>
      )}
    </>
  );

  if (!vacant && !touch && children.length === 0) {
    return app || vq || landmarked
      ? <div className="deal"><div className="deal-head">The planning board</div>{planning}</div>
      : null;
  }

  // ON OFFER is a state of the lot, like LISTED. The quote is re-run at
  // today's land value because the offer is an intention, not a price lock —
  // the panel shows what a lessee arriving THIS month would actually sign.
  const offer = h.groundOffer;
  const oq = offer && vacant
    ? groundLeaseQuote(game, parcels, bbl, offer.years, offer.review ?? "fixed") : null;
  const glBlocked = h.loan
    ? "Pay off the mortgage first — a land lender will not sit under a ground lease."
    : game.facility?.bbls?.includes(bbl)
      ? "Release it from the facility first — the line is secured by vacant dirt, not a leased fee."
      : null;
  const q = vacant && !offer && !glBlocked
    ? groundLeaseQuote(game, parcels, bbl, years, review) : null;

  return (
    <div className="deal">
      <div className="deal-head">The land desk</div>
      {planning}
      {vacant && <ResidualRead bbl={bbl} />}
      <AssembleSection bbl={bbl} embedded />
      {offer && (
        <>
          <div className="page-section" style={{ marginTop: 10 }}>Offered for ground lease</div>
          <div className="grid">
            <Row k="On the book since" v={`${monthLabel(offer.sinceM)}${game.month - offer.sinceM > 0 ? ` · ${game.month - offer.sinceM} month${game.month - offer.sinceM === 1 ? "" : "s"} waiting` : ""}`} />
            <Row k="Structure" v={GROUND_REVIEW_LABEL[offer.review ?? "fixed"]} />
            <Row k="Terms as of today" v={oq
              ? `${usd(oq.rentYr)} / yr · ${offer.years} years · ${oq.reviewNote}`
              : "—"} strong />
            {oq && <Row k="Owner expenses" v="$0 tax · $0 insurance/opex · $0 TI · $0 signing costs" />}
            {oq && <Row k="Net cash income" v={`${usd(oq.cashFlow.netRentYr)} / yr`} strong />}
          </div>
          <div className="hint">
            Ground lessees are scarce — and an FMV reset is scarcer still, because their lender has to underwrite
            a coupon that can jump. One turns up when demand, the build climate and the structure say so.
            The deal signs at the terms quoted the month they arrive; they break ground after that.
          </div>
          <button className="btn" onClick={() => pullGroundOffer(bbl)}>Pull the offer</button>
        </>
      )}
      {vacant && !offer && glBlocked && (
        <>
          <div className="page-section" style={{ marginTop: 10 }}>Or ground-lease it</div>
          <div className="hint">{glBlocked}</div>
        </>
      )}
      {q && (
        <>
          <div className="page-section" style={{ marginTop: 10 }}>Or ground-lease it</div>
          <div className="btn-row" style={{ marginBottom: 8 }}>
            {(["fixed", "cpi", "fmv"] as GroundReview[]).map((r) => (
              <button key={r} className={"btn" + (review === r ? " btn-on" : "")} onClick={() => setReview(r)}>
                {GROUND_REVIEW_LABEL[r]}
              </button>
            ))}
          </div>
          <div className="slider">
            <div className="slider-head">
              <span className="slider-label">Term</span>
              <span className="slider-value">{years} years</span>
            </div>
            <input type="range" min={GROUND_TERM_MIN} max={99} step={1} value={years}
              style={{ ["--fill" as string]: `${((years - GROUND_TERM_MIN) / (99 - GROUND_TERM_MIN)) * 100}%` }}
              onChange={(e) => setYears(Number(e.target.value))} />
          </div>
          <div className="grid">
            <Row k="Gross ground rent" v={`${usd(q.cashFlow.grossRentYr)} / yr · ${q.capPct}% of land value`} />
            <Row k="Property tax" v="$0 to you · lessee pays" />
            <Row k="Insurance + operating" v="$0 to you · lessee pays" />
            <Row k="TI / construction" v="$0 to you · lessee pays" />
            <Row k="Brokerage + legal at signing" v="$0 to you · lessee pays" />
            <Row k="Net cash income" v={`${usd(q.cashFlow.netRentYr)} / yr`} strong />
            <Row k="Reviews" v={q.reviewNote} />
            <Row k="At term" v={q.padOnly
              ? "Dirt back — bones only if you fund a leasehold buyout"
              : `Aged vacant improvement reverts · ${monthLabel(game.month + years * 12)}`} />
          </div>
          <div className="hint">
            Absolutely-net form: no owner signing cheque and no property-level expenses after closing.
            {" "}{q.termNote} FMV opens cheaper and places slower; fixed opens dearer and places faster.
            The dirt costs carry only while the offer is waiting.
          </div>
          <button className="btn" onClick={() => groundLease(bbl, years, review)}>
            Offer a {years}-year {GROUND_REVIEW_LABEL[review].toLowerCase()} ground lease
          </button>
        </>
      )}
    </div>
  );
}

