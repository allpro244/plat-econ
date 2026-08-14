import { useState, Fragment } from "react";
import Slider, { counterPriceBounds } from "@/ui/Slider";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import type { BuiltClass } from "@/engine/types";
import { ownedHoldingValue, ownedHoldingNoiYr, managedRentPsfYr, resolveRec, isLeasedFee } from "@/engine/value";
import { portfolioPropertyMonthlyCF } from "@/engine/sim";
import { unitStatus, avgUnitSf } from "@/engine/leasing";
import { payoffQuote } from "@/engine/notes";
import { fundableNow } from "@/engine/credit";
import { payOffDue } from "@/engine/debt";
import { portfolioQuote } from "@/engine/portfolio";
import { taxAppealQuote } from "@/engine/tax";
import type { PortfolioQuote } from "@/engine/portfolio";
import { allocatedAmount } from "@/engine/facility";
import { usd, sf } from "@/ui/format";
import { ListSection, GroundLeaseSection } from "@/ui/panels/AcquireDesk";
import { RefiSection } from "@/ui/panels/RefiDesk";
import { AssembleSection, canAssembleFromBook } from "@/ui/panels/PropertyDesks";
import { siteDeeds } from "@/engine/actions";
import { useLabel, devUseLabel, physicalOcc, Big, Row } from "@/ui/panels/shared";

export function PortfolioPage() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const adjacency = useStore((s) => s.adjacency);
  const select = useStore((s) => s.select);
  const setPage = useStore((s) => s.setPage);
  // Child deeds of an assemblage keep a $0 holding for title — they are not
  // separate assets. Show the site once, under the parent.
  const holdings = Object.values(game.holdings).filter((h) => !game.merged?.[h.bbl]);
  const { delistSale, focus } = useStore.getState();
  // Opening the record and finding the building are the same action now: the
  // panel changes AND the camera moves, so the thing you are reading about is
  // behind the page you are reading. A book of addresses was not a place.
  const go = (bbl: string) => { select(bbl); focus(bbl); setPage("property"); };
  // Which row has its refinancing panel open. Repricing a loan is a portfolio
  // decision — you do it while looking at the maturity wall, not after opening
  // one building's record and scrolling past its rent roll.
  const [refiRow, setRefiRow] = useState<string | null>(null);
  // The ask you are about to name, per row. See ListSection.
  const [listRow, setListRow] = useState<string | null>(null);
  // Vacant dirt: offer a ground lease from the row — same reach as List / Refi.
  const [glRow, setGlRow] = useState<string | null>(null);
  // Fold contiguous vacant lots from the book — same desk as Property → Build,
  // without leaving the portfolio when you notice two addresses that touch.
  const [assembleRow, setAssembleRow] = useState<string | null>(null);
  // Sort the book by value or by income. "By income" is the top-earners view:
  // the fifty best income producers, ranked — the question every owner asks
  // of a big book is "what is actually carrying this firm."
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "v", dir: -1 });
  // THE BUNDLE. Ticking buildings here is how you assemble a portfolio trade;
  // see engine/portfolio.ts for why the sum of the parts is not the price.
  const [bundling, setBundling] = useState(false);
  const [bundle, setBundle] = useState<string[]>([]);
  if (!holdings.length && !Object.keys(game.developments).length) {
    return (
      <div className="deal">
        <div className="deal-head">Your book is empty</div>
        <div className="hint">Start with the public tape: compare real rent rolls, agree a price, then choose the debt only after the seller says yes.</div>
        <button className="btn btn-buy" onClick={() => setPage("market")}>Browse properties in Marketplace →</button>
      </div>
    );
  }
  let totV = 0, totD = 0;
  const rows = holdings.map((h) => {
    const rec = resolveRec(parcels, game, h.bbl);
    const fee = isLeasedFee(h);
    const v = rec ? ownedHoldingValue(game, parcels, h) : 0;
    // Deed NOI — building roll or ground coupon. Same number the header CF
    // annualises (before firm-level construction / facility / revolver).
    const noi = ownedHoldingNoiYr(game, parcels, h);
    // Facility replaces the deed mortgage — allocated share is the lien that
    // still sits on this row once the pool is papered.
    const debt = (h.loan?.balance ?? 0) + allocatedAmount(game, parcels, h.bbl);
    const cf = noi / 12 - (h.loan?.monthlyPmt ?? 0);
    // Lessee's tower is not your occupancy — do not paint 0% on a coupon bond.
    const occ = fee || !rec ? 0 : physicalOcc(rec as never, h);
    totV += v; totD += debt;
    // EVERY COLUMN NEEDS A VALUE TO SORT ON, so the ones that used to be
    // computed inside the cell are computed here instead. That is also why
    // several of them were impossible to sort by: they did not exist until the
    // row was already being drawn.
    const leasedSf = fee ? 0 : h.tenants.reduce((a, t) => a + t.sf, 0);
    const rollYr = fee ? 0 : h.tenants.reduce((a, t) => a + t.rentPsf * t.sf, 0);
    const rentPsf = fee || !rec || rec.class === "land"
      ? 0
      : (leasedSf > 0 ? rollYr / leasedSf : managedRentPsfYr(rec, game.econ, h));
    const u = !fee && rec && rec.bldgArea ? unitStatus(rec, h, game.month) : null;
    return {
      h, rec, v, noi, cf, occ,
      addr: rec?.address ?? h.bbl,
      cls: fee ? "leased fee" : (rec ? useLabel(rec) : ""),
      area: fee ? 0 : (rec?.bldgArea ?? 0),
      spaces: u ? u.leased : -1,
      rentPsf,
      cost: h.costBasis,
      // WHAT YOU PAID, PER FOOT. Every other price in this business is quoted
      // per square foot — rent, NOI, value, replacement cost — and the one
      // number the book kept in whole dollars was the one you compare all of
      // them against. Land has no building to divide by, and a lot bought for
      // its dirt does not have a basis per foot of anything; it sorts last.
      basisPsf: rec && rec.bldgArea > 0 ? h.costBasis / rec.bldgArea : 0,
      gain: v - h.costBasis,
      debt,
      equity: v - debt,
      ds: h.loan?.monthlyPmt ?? 0,
    };
  });
  type PRow = (typeof rows)[number];
  // THE BOOK SORTS BY ITS OWN COLUMNS. It had two buttons — by value, by income
  // — and a top-50 slice on one of them. Anything else you wanted to rank the
  // book by (worst occupancy, biggest gain, heaviest debt service) meant reading
  // sixteen columns by eye.
  const dir = sort.dir;
  const cmp = (a: PRow, b: PRow) => {
    const k = sort.key as keyof PRow;
    const av = a[k], bv = b[k];
    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv)) * dir;
    }
    return ((av as number) - (bv as number)) * dir;
  };
  rows.sort(cmp);
  const shown = rows;
  const totCF = portfolioPropertyMonthlyCF(game, parcels);
  const ranked = sort.key === "noi" && sort.dir === -1;
  const assessmentWatch = holdings.flatMap((h) => {
    const q = taxAppealQuote(game, parcels, h.bbl);
    const rec = resolveRec(parcels, game, h.bbl);
    return q && rec ? [{ bbl: h.bbl, address: rec.address, ...q }] : [];
  }).sort((a, b) => b.annualSavings - a.annualSavings);
  // One header cell, the same idiom the Marketplace tape uses. `desc` is the
  // direction a column WANTS on first click: money and area read biggest-first,
  // an address reads A-Z.
  const H = ({ k, label, num, desc = true, title }: { k: string; label: string; num?: boolean; desc?: boolean; title?: string }) => {
    const on = sort.key === k;
    return (
      <th className={(num ? "num" : "") + " th-sort" + (on ? " th-sort-on" : "")}
        title={title ?? `Sort by ${label}`}
        onClick={() => setSort(on ? { key: k, dir: sort.dir === 1 ? -1 : 1 } : { key: k, dir: desc ? -1 : 1 })}>
        {label}{on ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
      </th>
    );
  };

  // ---- exposure ------------------------------------------------------------
  // Concentration and the maturity wall are what actually end firms, and both
  // were invisible. All of this is already in the state; none of it was ever
  // added up. A portfolio where one tenant is a fifth of the income, or where
  // half the debt matures inside three years, is a different business from one
  // where neither is true — even if the cash flow statements look identical.
  const exposure = (() => {
    const byTenant = new Map<string, number>();
    const bySector = new Map<string, number>();
    let roll = 0, floatDebt = 0, wamNum = 0, debtTot = 0, rollNext24 = 0, leasedSf = 0;
    let matWall = 0;   // debt maturing within 36 months
    for (const { h, rec } of rows) {
      if (!rec) continue;
      for (const t of h.tenants) {
        const annual = t.rentPsf * t.sf;
        roll += annual;
        leasedSf += t.sf;
        byTenant.set(t.name, (byTenant.get(t.name) ?? 0) + annual);
        bySector.set(t.sector, (bySector.get(t.sector) ?? 0) + annual);
        if (t.endM - game.month <= 24) rollNext24 += annual;
      }
      const l = h.loan;
      if (!l) continue;
      debtTot += l.balance;
      if (l.floating ?? l.product === "float") floatDebt += l.balance;
      wamNum += l.balance * Math.max(0, (l.maturityM - game.month) / 12);
      if (l.maturityM - game.month <= 36) matWall += l.balance;
    }
    const topTenant = [...byTenant.entries()].sort((a, b) => b[1] - a[1])[0];
    const topSector = [...bySector.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      roll, leasedSf,
      topTenant: topTenant ? { name: topTenant[0], share: roll > 0 ? topTenant[1] / roll : 0 } : null,
      topSector: topSector ? { name: topSector[0], share: roll > 0 ? topSector[1] / roll : 0 } : null,
      rollShare: roll > 0 ? rollNext24 / roll : 0,
      floatShare: debtTot > 0 ? floatDebt / debtTot : 0,
      wam: debtTot > 0 ? wamNum / debtTot : 0,
      wallShare: debtTot > 0 ? matWall / debtTot : 0,
      matWall,
    };
  })();

  const showAllOnMap = () => {
    useStore.getState().showBookOnMap();
  };

  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button type="button" className="btn" onClick={showAllOnMap}
          title="Close the book and show your footprints on the map">
          Show book on map →
        </button>
      </div>
      {assessmentWatch.length > 0 && (
        <div className="deal" style={{ marginTop: 0, marginBottom: 12 }}>
          <div className="deal-head">Assessment watch · {assessmentWatch.length} appealable</div>
          <div className="mini-list">
            {assessmentWatch.slice(0, 5).map((a) => (
              <button key={a.bbl} className="neighbor" onClick={() => go(a.bbl)}>
                <span className="neighbor-addr">{a.address}</span>
                <span className="neighbor-meta mono">
                  {usd(a.annualSavings)} / yr potential saving · file for {usd(a.fee)}
                </span>
              </button>
            ))}
          </div>
          <div className="hint">Open a property to review the evidence and file the appeal.</div>
        </div>
      )}
      <div className="stat-strip">
        {/* FIRST, NOT LAST. This sat rightmost, after "Buildings", in the same
            20px mono as every other stat — the only number in the game that can
            end the run, weighted identically to a count of how many things you
            own. */}
        {Object.keys(game.workouts ?? {}).length > 0 && (
          <Big label="In default" value={String(Object.keys(game.workouts ?? {}).length)} bad />
        )}
        <Big label="Assets" value={usd(totV)} />
        <Big label="Debt" value={usd(totD)} />
        <Big label="Equity" value={usd(totV - totD)} />
        <Big
          label="Cash flow / mo"
          value={usd(totCF)}
          bad={totCF < 0}
          title="Deed cash flow only — NOI (including ground rent) less mortgages. The header CF / yr also subtracts construction interest, facility and the revolver, then annualises."
        />
        {/* HOW BIG YOU ACTUALLY ARE, AND WHAT IT COST YOU A FOOT.
            Dollars of assets is a number about the market as much as about the
            book — the same buildings are worth half as much at the bottom of a
            cycle — and square feet is not. It is the one measure of a portfolio
            that does not move when the cap rate does, which is why every
            operator in this business quotes it first. The basis beside it is
            what you paid across all of it, per foot: the number to hold against
            the rent you collect, what a building is worth today, and what it
            would cost to put one up. Land is excluded from both, because a lot
            has no square footage of building to average. */}
        {(() => {
          const built = rows.filter((r) => r.rec && r.rec.class !== "land" && (r.rec.bldgArea ?? 0) > 0);
          const area = built.reduce((a, r) => a + (r.rec!.bldgArea ?? 0), 0);
          const basis = built.reduce((a, r) => a + r.h.costBasis, 0);
          const val = built.reduce((a, r) => a + r.v, 0);
          return (
            <>
              <Big label="Square feet" value={area > 0 ? sf(area) : "—"}
                title={`${built.length} building${built.length === 1 ? "" : "s"}${rows.length > built.length ? ` and ${rows.length - built.length} lot${rows.length - built.length === 1 ? "" : "s"} of land` : ""}. Square footage is the one measure of a book that does not move with the cap rate.`} />
              <Big label="Basis / psf" value={area > 0 ? `$${(basis / area).toFixed(0)}` : "—"}
                title={area > 0
                  ? `What you paid per foot across the whole book, including closing costs. Worth $${(val / area).toFixed(0)}/sf today.`
                  : "No buildings yet."} />
            </>
          );
        })()}
        {(() => {
          const cost = rows.reduce((a, r) => a + r.h.costBasis, 0);
          const g = totV - cost;
          return <Big label="Unrealised gain" value={`${g >= 0 ? "+" : "−"}${usd(Math.abs(g))} · ${cost > 0 ? ((g / cost) * 100).toFixed(0) : "0"}%`} bad={g < 0} />;
        })()}
        <Big label="Buildings" value={String(holdings.length)} />
        {/* THE ONE THING YOU CANNOT AFFORD TO MISS. */}

      </div>
      {Object.values(game.workouts ?? {}).length > 0 && (
        <div className="alarm" style={{ marginTop: 10 }}>
          {Object.values(game.workouts!).map((w) => {
            const r = resolveRec(parcels, game, w.bbl);
            const loan = game.holdings[w.bbl]?.loan;
            const couponOk = !!loan && fundableNow(game, parcels) >= loan.monthlyPmt;
            return (
              <div key={w.bbl} className="neg" style={{ cursor: "pointer" }} onClick={() => go(w.bbl)}>
                {(() => {
                  const q = payoffQuote(game, parcels, w.bbl);
                  if (!q?.open) return null;
                  return (
                    <div style={{ marginBottom: 4 }}>
                      <button className="btn-mini" disabled={game.cash < q.px}
                        title={q.why}
                        onClick={(e) => { e.stopPropagation(); useStore.getState().payOffAtDiscount(w.bbl); }}>
                        pay it off at {usd(q.px)} of {usd(q.bal)}
                      </button>
                    </div>
                  );
                })()}
                ⚠ {r?.address ?? w.bbl} — {w.lender} {w.stage === "foreclosure"
                  ? `has filed. Auction ${monthLabel(w.decideM)}.`
                  : w.stage === "forbearance"
                    ? `extended it to ${monthLabel(w.decideM)}.`
                    : couponOk
                      ? `opened a file. The coupon is current — they will not file while it stays that way.`
                      : `opened a file. They can file from ${monthLabel(w.decideM)}.`} Curing it takes {usd(w.cure)}.
              </div>
            );
          })}
        </div>
      )}
      {exposure.roll > 0 && (
        <>
          <div className="page-section">Exposure</div>
          <div className="grid">
            {exposure.topTenant && (
              <Row
                k="Largest tenant"
                v={`${exposure.topTenant.name} · ${(exposure.topTenant.share * 100).toFixed(0)}% of the roll`}
                bad={exposure.topTenant.share > 0.2}
              />
            )}
            {exposure.topSector && (
              <Row
                k="Largest sector"
                v={`${exposure.topSector.name} · ${(exposure.topSector.share * 100).toFixed(0)}% of the roll`}
                bad={exposure.topSector.share > 0.4}
              />
            )}
            <Row
              k="Rolling within 2 yrs"
              v={`${(exposure.rollShare * 100).toFixed(0)}% of the roll`}
              bad={exposure.rollShare > 0.3}
            />
            <Row
              k="Floating-rate debt"
              v={`${(exposure.floatShare * 100).toFixed(0)}% of the balance`}
              bad={exposure.floatShare > 0.5}
            />
            <Row k="Weighted avg maturity" v={`${exposure.wam.toFixed(1)} yrs`} bad={exposure.wam < 3} />
            <Row
              k="Maturing within 3 yrs"
              v={`${usd(exposure.matWall)} · ${(exposure.wallShare * 100).toFixed(0)}% of the debt`}
              bad={exposure.wallShare > 0.4}
            />
          </div>
        </>
      )}
      <PortfolioSaleDesk bundle={bundle} clear={() => { setBundle([]); setBundling(false); }} />
      <div className="btn-row" style={{ marginTop: 10 }}>
        {/* Shortcuts, not modes. Every column sorts from its own header now;
            these two are here because they are the two questions asked most. */}
        <button className={"btn" + (sort.key === "v" ? " btn-on" : "")}
          onClick={() => setSort({ key: "v", dir: -1 })}>By value</button>
        <button className={"btn" + (ranked ? " btn-on" : "")}
          onClick={() => setSort({ key: "noi", dir: -1 })}
          title="Ranked by NOI, biggest earner first.">Top earners</button>
        {!game.portfolioSale && holdings.length >= 2 && (
          <button className={"btn" + (bundling ? " btn-on" : "")}
            onClick={() => { setBundling(!bundling); if (bundling) setBundle([]); }}
            title="Tick two or more buildings and take them to market as one trade">
            {bundling ? `Bundling · ${bundle.length} picked` : "Sell several at once"}
          </button>
        )}
        {bundling && bundle.length > 0 && (
          <button className="btn" onClick={() => setBundle([])}>Clear picks</button>
        )}
        {bundling && (
          <button className="btn" onClick={() => setBundle(rows.filter((r) => !r.h.sale).map((r) => r.h.bbl))}>
            Pick everything
          </button>
        )}
      </div>
      <table className="tbl">
        <thead>
          <tr>
            {bundling && <th></th>}
            {ranked && <th className="num">#</th>}
            {/* Square feet is the denominator of every number to the right of
                it — NOI, value and debt are all quoted per foot in this
                business, and the book listed none of them against an area. */}
            <H k="addr" label="Property" desc={false} />
            <H k="cls" label="Class" desc={false} />
            <H k="area" label="Building sf" num />
            <H k="spaces" label="Spaces" num title="Leased spaces. Sorts on how many are let." />
            <H k="occ" label="Occ" num />
            <H k="rentPsf" label="Rent $/sf" num title="Average contract rent across the rent roll, per square foot per year" />
            <H k="noi" label="NOI / yr" num />
            <H k="v" label="Value" num />
            <H k="cost" label="Cost" num title="What you paid, including closing costs" />
            <H k="basisPsf" label="Basis / psf" num title="What you paid per square foot of building, including closing costs — the number to hold against rent, value and what it would cost to build" />
            <H k="gain" label="Gain" num title="Appraisal against cost basis — unrealised, before tax and before the cost of selling" />
            <H k="debt" label="Debt" num />
            <H k="equity" label="Equity" num />
            <H k="ds" label="Debt svc / mo" num />
            <H k="cf" label="CF / mo" num />
            <th>Status</th><th></th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ h, rec, v, noi, cf, occ, debt }, i) => {
            const wk = game.workouts?.[h.bbl];
            // a crane on your own dirt is a status, not a secret
            const dv = game.developments[h.bbl];
            // Vacant fee only — leased fees and improved sites are not this desk.
            const canGround = !!rec
              && rec.class === "land"
              && (rec.bldgArea ?? 0) === 0
              && !(game.built?.[h.bbl]?.bldgArea)
              && !h.groundLeased
              && !game.groundLeases?.[h.bbl]
              && !dv;
            return (
            <Fragment key={h.bbl}>
            <tr onClick={() => go(h.bbl)}>
              {bundling && (
                <td onClick={(ev) => {
                  ev.stopPropagation();
                  setBundle(bundle.includes(h.bbl) ? bundle.filter((x) => x !== h.bbl) : [...bundle, h.bbl]);
                }} style={{ cursor: "pointer", userSelect: "none" }}
                  title={h.sale ? "Already listed on its own — delist it first" : "Add to the bundle"}>
                  {bundle.includes(h.bbl) ? "☑" : h.sale ? "·" : "☐"}
                </td>
              )}
              {ranked && <td className="num dim">{i + 1}</td>}
              <td>{rec?.address ?? h.bbl}</td>
              <td>{rec ? useLabel(rec) : "—"}</td>
              <td className="num" title={h.groundLeased
                ? "Lessee improvement — not your building sf"
                : rec && rec.bldgArea ? `${usd(v / rec.bldgArea)}/sf of value · ${usd(noi / rec.bldgArea)}/sf of NOI` : "vacant land"}>
                {h.groundLeased || !rec || !rec.bldgArea ? "—" : sf(rec.bldgArea)}
                {/* THE SIZE OF THE PRODUCT, under the size of the building. A
                    hundred thousand feet cut into 450-foot studios and the same
                    hundred thousand cut into 1,800-foot family flats are two
                    different businesses at identical area — different rents,
                    different tenants, different turnover — and on anything you
                    programmed yourself it is a decision you made and can read
                    back. It hangs under the area instead of taking a column of
                    its own because half the book has no flats in it at all. */}
                {!h.groundLeased && rec && avgUnitSf(rec) > 0 && (
                  <div className="dim" style={{ fontSize: 11 }}>{sf(avgUnitSf(rec))}/flat</div>
                )}
              </td>
              <td className="num">{h.groundLeased || !rec || !rec.bldgArea ? "—" : (() => { const u = unitStatus(rec, h, game.month); return `${u.leased} / ${u.total}`; })()}</td>
              <td
                className="num"
                title={dv
                  ? ((dv.signed?.length ?? 0)
                    ? `${dv.signed!.length} construction pre-let${dv.signed!.length === 1 ? "" : "s"} · ${dv.signed!.reduce((a, x) => a + x.sf, 0).toLocaleString()} sf spoken for — land on the rent roll at delivery`
                    : "Under construction — no rent roll until it delivers")
                  : h.groundLeased ? "Ground coupon — the lessee lets the building" : undefined}
              >
                {dv
                  ? ((dv.signed?.length ?? 0) ? `${((dv.signed!.reduce((a, x) => a + x.sf, 0) / Math.max(1, dv.sf)) * 100).toFixed(0)}% pre` : "—")
                  : h.groundLeased || rec?.class === "land" ? "—" : (occ * 100).toFixed(0) + "%"}
              </td>
              {/* WHAT THE ROLL ACTUALLY COLLECTS, per foot. The rent every
                  decision in the game is denominated in, and the book quoted
                  NOI and value per foot but never the rent underneath them. */}
              {(() => {
                if (h.groundLeased || !rec || rec.class === "land") return <td className="num">—</td>;
                const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
                const roll = h.tenants.reduce((a, t) => a + t.rentPsf * t.sf, 0);
                if (leased > 0) {
                  // THE BENCHMARK HAS TO BE WEIGHTED THE WAY THE ROLL IS.
                  //
                  // The rent on the left is the average across the tenants who
                  // are actually in the building. The market it was compared
                  // against was the area-weighted blend of the building's
                  // markets — weighted by FLOOR AREA, not by who is in it. On
                  // anything mixed those are different numbers about different
                  // buildings: a tower whose shops are full and whose offices
                  // are half empty has a retail-heavy roll being marked
                  // against an office-heavy market, and it prints as a rent
                  // roll 30-40% under market when every lease in it was signed
                  // at the going rate for the space it is in. Same tenants,
                  // same weights, one quantity, one answer.
                  const mkt = h.tenants.reduce(
                    (a, t) => a + t.sf * managedRentPsfYr(rec, game.econ, h, t.use ?? (rec.class as BuiltClass)), 0) / leased;
                  return (
                    <td className="num" title={`Market for the space these tenants occupy is about $${mkt.toFixed(2)}/sf today`}>
                      ${(roll / leased).toFixed(2)}
                      <span className={"dim" + ((roll / leased) < mkt * 0.92 ? " neg" : "")}>
                        {" "}({(roll / leased) >= mkt ? "+" : ""}{(((roll / leased) / Math.max(1, mkt) - 1) * 100).toFixed(0)}%)
                      </span>
                    </td>
                  );
                }
                // flats have no named roll: quote what the building achieves
                return <td className="num dim">${managedRentPsfYr(rec, game.econ, h).toFixed(2)}</td>;
              })()}
              <td className="num">{usd(noi)}</td>
              <td className="num">{usd(v)}</td>
              {/* WHAT IT HAS DONE FOR YOU. Appraisal against what you actually
                  paid — the number every owner carries in their head and the
                  one this book never showed. Unrealised, before tax and before
                  the cost of getting out, which is why it is not net worth. */}
              <td className="num dim">{usd(h.costBasis)}</td>
              <td className="num dim">
                {!h.groundLeased && rec && rec.bldgArea > 0 ? `$${(h.costBasis / rec.bldgArea).toFixed(0)}` : "—"}
              </td>
              {(() => {
                const g = v - h.costBasis;
                const pctG = h.costBasis > 0 ? (g / h.costBasis) * 100 : 0;
                return (
                  <td className={"num" + (g < 0 ? " neg" : "")} title={`${(g / Math.max(1, (game.month - h.boughtM) / 12) / Math.max(1, h.costBasis) * 100).toFixed(1)}% a year over ${((game.month - h.boughtM) / 12).toFixed(1)} years`}>
                    {g >= 0 ? "+" : "−"}{usd(Math.abs(g))} · {g >= 0 ? "+" : ""}{pctG.toFixed(0)}%
                  </td>
                );
              })()}
              <td className="num">{usd(debt)}</td>
              <td className="num">{usd(v - debt)}</td>
              {/* A LEADING MINUS THAT WRAPS IS A BARE DASH. In a 62px column
                  `"−" + usd(...)` breaks after the sign, so a real payment
                  rendered as a dash over a number — visually identical to the
                  "—" that means no debt at all. Parenthesised the way an
                  accountant writes a negative, which cannot wrap apart. */}
              <td className="num nowrap">{h.loan ? `(${usd(h.loan.monthlyPmt)})` : "—"}</td>
              <td className={"num" + (cf < 0 ? " neg" : "")}>{usd(cf)}</td>
              {/* A BUILDING IN DEFAULT WAS INVISIBLE FROM HERE. The workout desk
                  lives on the property record, so the only way to find out a
                  lender had filed was to open that one building. On a
                  thirty-building book that is not a warning, it is a scavenger
                  hunt with a foreclosure at the end of it. */}
              <td className={wk ? "neg" : "dim"}>
                {[wk ? (wk.stage === "foreclosure" ? "⚠ FORECLOSURE"
                  : wk.stage === "forbearance" ? "⚠ EXTENDED"
                  : (h.loan && fundableNow(game, parcels) >= h.loan.monthlyPmt) ? "⚠ DEFAULT · CURRENT"
                  : "⚠ DEFAULT") : null,
                  dv ? "UNDER CONSTRUCTION" : null,
                  h.loan?.sweep ? "SWEEP" : null, h.sale ? "LISTED" : null,
                  h.renovatingUntilM !== undefined && game.month < h.renovatingUntilM ? "RENO" : null,
                  h.program ? "CAPEX" : null,
                  siteDeeds(game, h.bbl).length > 1 ? "ASSEMBLED" : null,
                  game.btsProspects?.[h.bbl] ? "BTS TERMS" : h.btsOffer ? "BTS LISTED" : null,
                  game.groundLeases?.[h.bbl] ? "GROUND-LEASED" : h.groundOffer ? "GL OFFERED" : null].filter(Boolean).join(" · ")}
                {(() => {
                  const g = game.groundLeases?.[h.bbl];
                  return g ? <div className="mono" style={{ fontSize: 11 }}>{g.tenant} · reverts {monthLabel(g.endM)}</div> : null;
                })()}
                {wk && <div className="mono" style={{ fontSize: 11 }}>
                  {wk.stage === "foreclosure"
                    ? `auction ${monthLabel(wk.decideM)}`
                    : (h.loan && fundableNow(game, parcels) >= h.loan.monthlyPmt)
                      ? "coupon current — will not file"
                      : `they file ${monthLabel(wk.decideM)}`}
                </div>}
                {dv && <div className="mono" style={{ fontSize: 11 }}>
                  {(dv.sf / 1000).toFixed(0)}k sf · delivers {monthLabel(dv.deliverM)}
                </div>}
              </td>
              <td>
                {/* list / refi / ground-lease from the row — no need to open the record */}
                <div className="btn-row" style={{ gap: 4, margin: 0 }}>
                  {h.sale ? (
                    <button className="btn btn-sm" onClick={(ev) => { ev.stopPropagation(); delistSale(h.bbl); }}
                      title={`Listed at ${usd(h.sale.ask)} — pull it off the market`}>
                      Delist
                    </button>
                  ) : (
                    <button className={"btn btn-sm" + (listRow === h.bbl ? " btn-on" : "")}
                      onClick={(ev) => { ev.stopPropagation(); setListRow(listRow === h.bbl ? null : h.bbl); }}
                      title="Name your ask, then take it to market">
                      List
                    </button>
                  )}
                  <button
                    className={"btn btn-sm" + (refiRow === h.bbl ? " btn-on" : "")}
                    onClick={(ev) => { ev.stopPropagation(); setRefiRow(refiRow === h.bbl ? null : h.bbl); }}
                    title={h.loan
                      ? `${usd(h.loan.balance)} at ${h.loan.ratePct.toFixed(2)}%, balloons ${monthLabel(h.loan.maturityM)} — see what the desks will do today`
                      : "Unlevered. See what a lender will advance against it."}
                  >
                    Refi
                  </button>
                  {h.loan && !game.facility?.bbls?.includes(h.bbl) && (() => {
                    const due = payOffDue(h.loan, game.month);
                    const canPay = fundableNow(game, parcels) >= due.due;
                    return (
                      <button
                        className={"btn btn-sm" + (due.balance < 25_000 ? " btn-buy" : "")}
                        disabled={!canPay}
                        onClick={(ev) => { ev.stopPropagation(); useStore.getState().payOffLoan(h.bbl); }}
                        title={canPay
                          ? `Retire the note for ${usd(due.due)}${due.penalty > 0 ? ` (incl. ${usd(due.penalty)} break)` : ""} — clears the lien for a ground lease`
                          : `Need ${usd(due.due)} to pay this off`}
                      >
                        Pay off
                      </button>
                    );
                  })()}
                  {canGround && (
                    <button
                      className={"btn btn-sm" + (glRow === h.bbl || h.groundOffer ? " btn-on" : "")}
                      onClick={(ev) => { ev.stopPropagation(); setGlRow(glRow === h.bbl ? null : h.bbl); }}
                      title={h.groundOffer
                        ? `Ground lease offered (${h.groundOffer.years} yr) — open to pull or review terms`
                        : h.loan || game.facility?.bbls?.includes(h.bbl) || h.sale
                          ? "Clear the lien first (Pay off), then offer a ground lease"
                          : "Offer vacant dirt as an absolutely-net ground lease"}
                    >
                      {h.groundOffer ? "GL" : "Ground"}
                    </button>
                  )}
                  {canAssembleFromBook(game, adjacency, h.bbl) && (
                    <button
                      className={"btn btn-sm" + (assembleRow === h.bbl ? " btn-on" : "")}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setAssembleRow(assembleRow === h.bbl ? null : h.bbl);
                      }}
                      title="You own contiguous vacant dirt next to this site — fold the deeds into one plate"
                    >
                      Assemble
                    </button>
                  )}
                </div>
              </td>
            </tr>
            {refiRow === h.bbl && (
              <tr>
                <td colSpan={ranked ? 18 : 17} style={{ background: "rgba(43,37,26,0.035)" }}>
                  <RefiSection bbl={h.bbl} />
                </td>
              </tr>
            )}
            {listRow === h.bbl && (
              <tr>
                <td colSpan={ranked ? 18 : 17} style={{ background: "rgba(43,37,26,0.035)" }}>
                  <ListSection bbl={h.bbl} appraisal={v} onDone={() => setListRow(null)} />
                </td>
              </tr>
            )}
            {glRow === h.bbl && canGround && (
              <tr>
                <td colSpan={ranked ? 18 : 17} style={{ background: "rgba(43,37,26,0.035)" }}>
                  <GroundLeaseSection bbl={h.bbl} onDone={() => setGlRow(null)} />
                </td>
              </tr>
            )}
            {assembleRow === h.bbl && (
              <tr>
                <td colSpan={ranked ? 18 : 17} style={{ background: "rgba(43,37,26,0.035)" }}>
                  <AssembleSection bbl={h.bbl} onDone={() => setAssembleRow(null)} />
                </td>
              </tr>
            )}
            </Fragment>
            );
          })}
          {Object.values(game.developments).map((dv) => (
            /* SIXTEEN CELLS, NOT FIFTEEN. This row was one short of the header
               and every value from the seventh column rightwards sat under the
               wrong heading — a job's construction loan balance was printing
               under "Gain". A misaligned number is worse than a missing one. */
            <tr key={dv.bbl} onClick={() => go(dv.bbl)}>
              {bundling && <td className="dim">·</td>}
              {ranked && <td className="num dim">—</td>}
              <td>{parcels[dv.bbl]?.address ?? dv.bbl}</td>
              <td>{devUseLabel(dv.use)}</td>
              <td className="num dim">{sf(dv.sf)}</td>
              <td className="num dim">—</td>
              <td className="num dim">—</td>
              <td className="num dim">—</td>
              <td className="num dim">—</td>
              <td className="num dim">—</td>
              <td className="num" title="The budget as it stands, escalation included">{usd(dv.costTotal)}</td>
              <td className="num dim">—</td>
              <td className="num">{usd(dv.loanBalance)}</td>
              <td className="num" title="What you have actually put in so far">{usd(dv.equitySpent)}</td>
              <td className="num neg" title="Construction interest accruing into the loan, not paid in cash">
                {usd(-(dv.loanBalance * dv.ratePct) / 100 / 12)}
              </td>
              <td className="num dim">—</td>
              <td className="dim">BUILDING · delivers {monthLabel(dv.deliverM)}</td>
              <td></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One letter of intent, as a negotiation instead of a coin-flip button.
 *
 * A renewal shows the spread against what the tenant pays TODAY — that delta
 * is the entire conversation in a real renewal. The counter is two sliders,
 * rent and TI, because that is what you actually trade: the tenant reads your
 * number against the market, not against their own opener, and they answer
 * once — take it, walk, or one final counter-back.
 */
/**
 * THE PORTFOLIO DESK.
 *
 * Two questions, and the whole feature is the gap between their answers: what
 * are these buildings worth, and what will somebody pay for all of them at
 * once? The breakdown below is not decoration — every line in it is a term the
 * engine actually applied, so a seventeen-point discount is legible before you
 * commit to it rather than a surprise at the closing table.
 *
 * The reason to do this anyway is the thing the numbers cannot show you: a
 * half-empty office in a soft market has no bid AT ALL on its own. Bundled
 * with three stabilised apartment blocks it trades on the same day they do.
 * You are paying the spread to make an unsellable building sellable, and
 * whether that is worth it depends entirely on what else you want to do with
 * the next three years.
 */
/**
 * WHAT CAP RATE YOU ARE ASKING, on a bundle.
 *
 * Weighted by income across the whole ticket rather than averaged across the
 * buildings, because yields do not average — see `portfolioQuote.noiYr`. The
 * market line beside it is the sf-weighted blend of the class cap rates the
 * buildings actually sit in, so a book of sheds is not being judged against
 * what offices trade at.
 */
export function PortfolioCap({ q, ask, bbls }: { q: PortfolioQuote; ask: number; bbls: string[] }) {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const cap = q.capAtAsk(ask);
  if (!(cap > 0)) return null;
  let wsum = 0, w = 0;
  for (const b of bbls) {
    const rec = resolveRec(parcels, game, b);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    const c = game.econ.capRate[rec.class as BuiltClass];
    if (!c) continue;
    wsum += c * rec.bldgArea; w += rec.bldgArea;
  }
  const mkt = w > 0 ? wsum / w : cap;
  return (
    <Row k="Asking a cap rate of" strong
      v={`${cap.toFixed(2)}%  ·  market ${mkt.toFixed(2)}%`}
      bad={cap < mkt - 0.4} />
  );
}

export function PortfolioSaleDesk({ bundle, clear }: { bundle: string[]; clear: () => void }) {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const { sellPortfolio, repricePortfolioSale, counterPortfolioBid, acceptPortfolio, pullPortfolio } =
    useStore.getState();
  const live = game.portfolioSale;
  const [askPct, setAskPct] = useState(100);
  const [counter, setCounter] = useState(0);

  // ---- a process already running -------------------------------------------
  if (live) {
    const q = portfolioQuote(game, parcels, live.bbls);
    const bid = live.bids?.[0];
    const age = game.month - live.listedM;
    return (
      <div className="page-section">
        <div className="page-section-head">
          {live.unsolicited ? "An unsolicited approach" : "Portfolio in the market"} · {live.bbls.length} buildings
        </div>
        <div className="grid">
          <Row k="Asking" v={usd(live.ask)} strong />
          {/* THE NUMBER THE COMMITTEE ON THE OTHER SIDE IS ACTUALLY LOOKING AT.
              A portfolio is quoted as a yield; the price is what the yield
              implies. This desk showed dollars and a spread against the parts
              and never once said what cap the ask was struck at. */}
          <PortfolioCap q={q} ask={live.ask} bbls={live.bbls} />
          <Row k="Sum of the individual marks" v={usd(q.sumOfParts)} />
          <Row k="What a bundle is indicated at" v={`${usd(q.indicative)} · ${(q.spreadPct * 100).toFixed(1)}%`}
            bad={q.spreadPct < -0.06} />
          <Row k="On the market" v={`${age} month${age === 1 ? "" : "s"} · stale at 9`} bad={age > 6} />
          <Row k="Buyers who can fund it" v={String(q.depth)} bad={q.depth <= 1} />
          <Row k="Ask vs indication"
            v={live.ask > q.indicative
              ? `${((live.ask / Math.max(1, q.indicative) - 1) * 100).toFixed(0)}% above · interest thins fast`
              : live.ask < q.indicative * 0.98
                ? `${((1 - live.ask / Math.max(1, q.indicative)) * 100).toFixed(0)}% under · priced to move`
                : "at the indication"}
            bad={live.ask > q.indicative * 1.05} />
          <Row k="Indications in hand" v={String(live.bids?.length ?? 0)} />
        </div>
        <div className="mini-list" style={{ marginTop: 8 }}>
          {live.bbls.map((b) => {
            const rec = resolveRec(parcels, game, b);
            return (
              <div key={b} className="mini-row" style={{ cursor: "pointer" }}
                onClick={() => useStore.getState().focus(b, true)}>
                <span>{rec?.address ?? b}</span>
                <span className="mono dim">{rec ? useLabel(rec) : ""}</span>
              </div>
            );
          })}
        </div>
        {bid ? (
          <>
            <div className="hint" style={{ marginTop: 10 }}>
              <strong>{bid.name}</strong> is at {usd(bid.price)} — {((1 - bid.price / Math.max(1, q.sumOfParts)) * 100).toFixed(1)}%
              inside the sum of the parts, good until {monthLabel(bid.expiresM)}.
              {bid.countered && " You have already been back to them once."}
            </div>
            <div className="btn-row">
              <button className="btn btn-buy" onClick={() => acceptPortfolio(false)}>
                Close it — {usd(bid.price)}
              </button>
              <button className="btn" onClick={() => acceptPortfolio(true)}
                title="Roll the whole gain into a 1031 and redeploy inside six months, or the tax comes due">
                Close into a 1031
              </button>
              {!bid.countered && (() => {
                const pb = counterPriceBounds(bid.price, q.sumOfParts);
                const cb = { ...pb, min: Math.max(pb.min, bid.price + pb.step) };
                return (
                <>
                  <Slider min={cb.min} max={cb.max} step={cb.step} editable="price"
                    value={counter || Math.round(bid.price * 1.05)} onChange={setCounter}
                    label="Counter at" format={(v: number) => usd(v)}
                    hint="Name any price above their indication. Push too hard and the whole portfolio trade walks." />
                  <button className="btn" onClick={() => counterPortfolioBid(counter || Math.round(bid.price * 1.05))}>
                    Counter
                  </button>
                </>
                );
              })()}
              <button className="btn" onClick={() => { pullPortfolio(); clear(); }}>Pull it</button>
            </div>
            <div className="hint">
              An institution has a committee number. You can push them a few points and no further, and pushing
              hard on a bundle is how the whole thing goes away — there is another portfolio next quarter and
              they know it.
            </div>
          </>
        ) : (
          <>
            <div className="hint" style={{ marginTop: 10 }}>
              No indications yet.
              {q.depth <= 0
                ? " Nobody in this city can fund a book this small as a portfolio — pull it and sell the deeds one at a time."
                : live.ask > q.indicative * 1.05
                  ? " Your ask sits above what a bundle is indicated at. Cut the number or wait out a thin room — nine months and the process goes stale."
                  : age > 5
                    ? " Half a year of silence on a portfolio is the market pricing the weakest building in it. Cut the number or take them out and sell them one at a time."
                    : " Institutional buyers underwrite a bundle for a quarter before they call. A live indication also lands on News and as a stop-everything card (unless you turned those off in Settings)."}
            </div>
            <div className="btn-row">
              <Slider min={Math.round(q.indicative * 0.8)} max={Math.round(q.sumOfParts * 1.05)} step={250_000}
                value={live.ask} onChange={(v: number) => repricePortfolioSale(v)} label="Ask" format={(v: number) => usd(v)} />
              <button className="btn" onClick={() => { pullPortfolio(); clear(); }}>Pull it</button>
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- assembling one ------------------------------------------------------
  if (bundle.length < 1) return null;
  const q = portfolioQuote(game, parcels, bundle);
  const ask = Math.round(q.indicative * (askPct / 100));
  return (
    <div className="page-section">
      <div className="page-section-head">Sell {bundle.length} buildings as one trade</div>
      {bundle.length < 2 ? (
        <div className="hint">Tick one more. A portfolio is two buildings or more — one building is a listing.</div>
      ) : (
        <>
          <div className="grid">
            <Row k="Sum of the individual marks" v={usd(q.sumOfParts)} strong />
            {q.why.map((w, i) => (
              <Row key={i} k={w.label} v={`${w.pct >= 0 ? "+" : ""}${(w.pct * 100).toFixed(1)}%`} bad={w.pct < 0} />
            ))}
            <Row k="What a bundle is worth" v={`${usd(q.indicative)} · ${(q.spreadPct * 100).toFixed(1)}% against the parts`}
              strong bad={q.spreadPct < 0} />
            <PortfolioCap q={q} ask={ask} bbls={bundle} />
            <Row k="Buyers who can fund it" v={String(q.depth)} bad={q.depth <= 1} />
          </div>
          <div className="hint">
            {q.depth <= 0
              ? "No desk in this city will underwrite a portfolio this small. Sell them one at a time — a bundle sale with an empty room is nine months of silence, not a process."
              : q.spreadPct < -0.10
              ? "That is a serious discount, and it is being driven by the buildings at the bottom of this list. Take them out and the blend improves — but those are the ones with no bid of their own, which is the entire reason to bundle."
              : q.spreadPct < -0.03
                ? "A few points inside the parts, which is what a clean portfolio costs. You are buying a single closing and a clean exit with it."
                : "A tight, coherent bundle. Institutions pay up for exactly this and there is very little discount in it."}
          </div>
          <Slider min={80} max={112} step={1} value={askPct} onChange={setAskPct}
            label="Ask, against the indicative" format={(v: number) => `${v}% · ${usd(Math.round(q.indicative * (v / 100)))}`} />
          <div className="hint">
            Ask over the indicative and you may get nothing for nine months; ask under it and you will have
            indications inside a quarter. Nine months is the whole run — after that every buyer in town has seen
            it and passed, and that is a fact about your portfolio that does not go away.
          </div>
          <div className="btn-row">
            <button
              className="btn btn-buy"
              disabled={q.depth <= 0}
              title={q.depth <= 0 ? "No buyer can fund this book as a portfolio" : undefined}
              onClick={() => { sellPortfolio(bundle, ask); clear(); }}
            >
              Take it to market at {usd(ask)}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

