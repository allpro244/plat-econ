// Property panel shell — glance card + tab router for one selected deed.
// Deal desks live in sibling modules so this file stays the wiring, not the warehouse:
//   AcquireDesk   buy / sell / list / ground lease / disclosed roll / vacant possession
//   RefiDesk      permanent debt on a deed
//   DevelopDesk   ground-up + adaptive reuse (Programme · Design · Financing)
import { memo, useState } from "react";
import { useStore } from "@/state/store";
import { useHeldGame } from "@/ui/heldGame";
import { CLASS_COLOR, CLASS_LABEL } from "@/data/types";
import { monthLabel, CREDIT_LABEL, OPS_SERVICE, OPS_PLAN, serviceSpec, planSpec, START_YEAR } from "@/engine/types";
import { assetValue, displayValue, initialCondition, holdingValue, marketRentPsfYr, managedRentPsfYr, renovationCost, resolveRec, propertyTaxYr, useRentPsfYr, operatingStatement, landValue, proFormaNOIYr, remainingAbatement, bareLandRec, leasedFeeValue, landRead } from "@/engine/value";
import { PROGRAMS, programCost, demolitionCost } from "@/engine/dev";
import { assemblagePressure, hasOwnedSiteNeighbor, siteDeeds } from "@/engine/actions";
import { sellerOf, sellerProfile } from "@/engine/acquire";
import { isCommercial, vacantSf, walt, notReadySf, unitStatus, unitCount, suiteSf, useSuiteSf, avgUnitSf, leasableUses, renewalIntent } from "@/engine/leasing";
import { dscr, ltv, payOffDue, rateCapCost } from "@/engine/debt";
import { holderOf, holdingsOf, relOf, isCold, standingWith } from "@/engine/owners";
import { fundableNow } from "@/engine/credit";
import { isMixedUse, mixLabel, mixOf, uses as usesOf, useSf, USE_WORD } from "@/engine/mix";
import { ownerOf } from "@/engine/rivals";
import { taxAppealQuote } from "@/engine/tax";
import { usd, sf, pct } from "@/ui/format";
import { LettingOdds, LeasingDesk, ResidualRead, LandDesk } from "@/ui/panels/PropertyDesks";
import { VacantPossession, DisclosedRoll, SaleSection, OffMarketCounter, BlindBidDesk, OfferDesk, BuyButtons } from "@/ui/panels/AcquireDesk";
import { RefiSection } from "@/ui/panels/RefiDesk";
import { DevelopSection, ReuseSection } from "@/ui/panels/DevelopDesk";
import { useLabel, physicalOcc, goingIn, band, apMid, PropTab, openResearchOn, Neighbourhood, Row } from "@/ui/panels/shared";
import { Gloss } from "@/ui/Glossary";

// Re-exports so Portfolio / Debt / older imports keep a stable path.
export {
  VacantPossession, DisclosedRoll, SaleSection, OffMarketCounter, BlindBidDesk,
  OfferDesk, BuyButtons, GroundLeaseSection, ListSection,
} from "@/ui/panels/AcquireDesk";
export { RefiSection } from "@/ui/panels/RefiDesk";
export { DevelopSection, ReuseSection, capStack } from "@/ui/panels/DevelopDesk";
export type { Stack } from "@/ui/panels/DevelopDesk";

function ParcelPanelShell({ embedded = false, tab }: { embedded?: boolean; tab?: PropTab } = {}) {
  // Closed card: do not subscribe to `game` at all — every LOI/cash write used
  // to rebuild this whole file for a panel that was not on screen.
  const selectedBBL = useStore((s) => s.selectedBBL);
  if (!selectedBBL) return null;
  return <ParcelPanelInner embedded={embedded} tab={tab} selectedBBL={selectedBBL} />;
}

function ParcelPanelInner({
  embedded = false, tab, selectedBBL,
}: { embedded?: boolean; tab?: PropTab; selectedBBL: string }) {
  const parcels = useStore((s) => s.parcels);
  const adjacency = useStore((s) => s.adjacency);
  const select = useStore((s) => s.select);
  const game = useHeldGame(selectedBBL);
  const { renovate, approach } = useStore.getState();
  // Which parcel has a demolition order waiting for a signature. Keyed by BBL
  // rather than a bare boolean so selecting a different building simply
  // dismisses the question instead of asking it about the wrong address.
  const [razeAsk, setRazeAsk] = useState<string | null>(null);
  // Summary keeps the glance card readable; Full OM is the veteran default after year one.
  const [omFull, setOmFull] = useState(() => useStore.getState().game!.month >= 12);

  if (!parcels) return null;
  const rec = resolveRec(parcels, game, selectedBBL);
  if (!rec) return null;
  const dev = game.developments[selectedBBL];
  const neighbors = adjacency?.[selectedBBL] ?? [];
  const holding = game.holdings[selectedBBL];
  const listing = game.listings.find((l) => l.bbl === selectedBBL);
  const appr = game.approaches[selectedBBL];
  const cond = holding?.condition ?? initialCondition(rec);
  const glLive = holding ? game.groundLeases?.[selectedBBL] : undefined;
  const simValue = holding
    ? (holding.groundLeased && glLive
      ? leasedFeeValue(glLive, bareLandRec(parcels, game, selectedBBL) ?? rec, game.econ, game.month,
        glLive.sf ?? game.built?.[selectedBBL]?.bldgArea ?? 0)
      : holdingValue(rec, game.econ, holding, game.month))
    : assetValue(rec, game.econ, cond);
  const value = holding?.groundLeased && glLive
    ? simValue
    : displayValue(rec, game.econ, simValue);
  const builtFar = rec.lotArea > 0 ? rec.bldgArea / rec.lotArea : 0;
  const farMax = Math.max(rec.farMaxComm, rec.farMaxRes);
  // A ground lessee's building stands on your deed — it is not yours to let.
  const isBuilt = rec.class !== "land" && rec.bldgArea > 0 && !holding?.groundLeased;
  const renovating = holding?.renovatingUntilM !== undefined && game.month < (holding.renovatingUntilM ?? 0);
  const commercial = isCommercial(rec);
  const leasedSf = holding && commercial ? holding.tenants.reduce((s2, t) => s2 + t.sf, 0) : 0;
  const d = holding ? dscr(rec, game, holding) : null;
  const l = holding ? ltv(rec, game, holding) : null;
  const taxAppeal = holding ? taxAppealQuote(game, parcels, selectedBBL) : null;
  // No tab means the docked card, which shows the whole file as it always has.
  const on = (t: PropTab) => tab === undefined || tab === t;
  // Land desk: property-page Build tab always; docked card only when the lot
  // can assemble / is land / is already folded — not on every leased tower.
  // Ground-leased lots stay on this desk even after the lessee's frame rises.
  const showLandDesk = !!holding && on("build") && (
    tab === "build"
    || rec.class === "land"
    || !!holding.groundLeased
    || !!holding.groundOffer
    || !!game.merged?.[selectedBBL]
    || siteDeeds(game, selectedBBL).length > 1
    || !!(adjacency && hasOwnedSiteNeighbor(game, adjacency, selectedBBL))
  );

  return (
    <div className={embedded ? "panel-embed" : "panel"}>
      {!embedded && (
        <div className="panel-head">
          <div>
            <div className="panel-address">{rec.address}</div>
            <div className="panel-bbl mono">Parcel {rec.bbl}</div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <button className="btn-mini" title="Open the property as a full desk" onClick={() => useStore.getState().setPage("property")}>full view</button>
            <button className="panel-close" onClick={() => select(null)} aria-label="Close">×</button>
          </div>
        </div>
      )}

      {on("summary") && <div className="chip-row">
        <span className="chip" style={{ background: CLASS_COLOR[rec.class] }}>{useLabel(rec)}</span>
        <span className="chip chip-zone mono">{rec.zoneDist}</span>
        {holding && <span className="chip chip-owned">OWNED</span>}
        {holding?.groundLeased && game.groundLeases?.[selectedBBL] && (game.built?.[selectedBBL]?.bldgArea || game.groundLeases[selectedBBL].builtM !== undefined) && (
          <span className="chip">LESSEE BUILT</span>
        )}
        {dev && <span className="chip chip-reno">UNDER CONSTRUCTION</span>}
        {listing && !holding && <span className="chip chip-listed">FOR SALE</span>}
        {listing?.distress && !holding && <span className="chip chip-distress">MOTIVATED SELLER</span>}
        {holding?.sale && <span className="chip chip-listed">LISTED · {usd(holding.sale.ask)}</span>}
        {renovating && <span className="chip chip-reno">RENOVATING</span>}
        {holding?.loan?.sweep && <span className="chip chip-sweep">CASH SWEEP</span>}
        {game.landmarks?.[selectedBBL] !== undefined && <span className="chip chip-reno">LANDMARKED</span>}
      </div>}

      {on("summary") && !embedded && (
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <button
            type="button"
            className={"btn-mini" + (!omFull ? " on" : "")}
            onClick={() => setOmFull(false)}
            title="Essentials only — price, occupancy, one risk"
          >
            Summary
          </button>
          <button
            type="button"
            className={"btn-mini" + (omFull ? " on" : "")}
            onClick={() => setOmFull(true)}
            title="Full offering-memorandum detail"
          >
            Full OM
          </button>
        </div>
      )}

      {on("summary") && holding && !dev && (() => {
        const read = landRead(rec, game.econ);
        const room = farMax > 0 ? Math.max(0, 1 - builtFar / farMax) : 0;
        const vacant = rec.class === "land" || room >= 0.25;
        if (!vacant || game.landmarks?.[selectedBBL] !== undefined) return null;
        const pencils = read.winner === "builder" && read.builder > 0;
        return (
          <div className="deal" style={{ marginTop: 0 }}>
            <div className="deal-head">{pencils ? "Developable" : "Dirt — nothing pencils today"}</div>
            <div className="hint">
              {pencils
                ? `Builder residual $${read.builder.toFixed(0)}/sf · ${(room * 100).toFixed(0)}% of the envelope left. Open Build to break ground.`
                : `Holder bid $${read.holder.toFixed(0)}/sf wins the auction — wait for rents, or clear the site.`}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => useStore.getState().setPage("property")}
            >
              Open Build desk →
            </button>
          </div>
        );
      })()}

      {/* WHO OWNS IT. Every building in this city has an owner and for most of
          them that owner is a named firm with a balance sheet you can read —
          and there was nowhere on the record that said so. Knowing that the
          corner you want belongs to the shop that is three points over its
          covenant is the difference between a cold call and a bid. */}
      {on("summary") && (() => {
        if (holding) return null;
        const own = ownerOf(game, selectedBBL);
        // AND WHEN THERE IS NO NAME ON IT. Most of this city belongs to nobody
        // you can look up, and the record answered that with silence — which is
        // not what a broker would tell you. He would tell you it is an estate,
        // or a family that has had it since the war, or a fund three states
        // away, because the building itself says so: its age, its size, its lot
        // and the block it stands on. That is also the first thing you learn
        // about how hard the door is to open, which is why it belongs up here
        // beside the address and not inside a negotiation you have not opened.
        if (!own) {
          // ...AND MOST OF THE TIME THERE IS A NAME ON IT NOW. The archetype is
          // still what a broker leads with — it is the first thing you learn
          // about how hard the door is — but it belongs to somebody, that
          // somebody owns other buildings, and how you have treated them
          // before is the most important fact in the room. See engine/owners.ts.
          const held = holderOf(game, parcels, selectedBBL);
          const kind = sellerOf(game, parcels, selectedBBL).kind;
          if (!held) return <div className="hint">{sellerProfile(kind).holds}</div>;
          const book = holdingsOf(game, parcels, held.id);
          const rel = relOf(game, held.id);
          const cold = isCold(game, held.id);
          return (
            <div className="hint">
              Owned by <strong>{held.name}</strong>
              {book.length > 1 && <span> — {book.length} buildings in town</span>}.
              <div style={{ marginTop: 3 }}>{held.note}</div>
              <div style={{ marginTop: 3 }} className={cold ? "neg" : (rel.deals ?? 0) > 0 ? "" : "dim"}>
                {standingWith(game, held.id)}
              </div>
              {book.length > 1 && (
                <div className="dim" style={{ marginTop: 3 }}>
                  {book.filter((b) => b !== selectedBBL).slice(0, 4).map((b) => (
                    <span key={b}>
                      <a className="lnk" onClick={(e) => { e.stopPropagation(); useStore.getState().focus(b, true); }}>
                        {parcels[b]?.address ?? b}
                      </a>
                      {" · "}
                    </span>
                  ))}
                  {book.length > 5 ? `and ${book.length - 5} more` : ""}
                </div>
              )}
            </div>
          );
        }
        return (
          <div className="hint" style={{ cursor: "pointer" }}
            title="Open this firm's balance sheet on The street."
            onClick={() => { openResearchOn("street"); useStore.getState().setPage("research"); }}>
            Owned by <strong>{own.name}</strong>
            {own.failedM !== undefined
              ? " — in receivership. The book is being sold down."
              : (own.stressMs ?? 0) > 0
                ? " — and they are selling under pressure."
                : `. ${own.bbls.length} building${own.bbls.length === 1 ? "" : "s"} in town.`}
          </div>
        );
      })()}

      {on("summary") && <div className="grid">
        <Row k="Appraisal" v={band(selectedBBL, value)} strong />
        {(() => {
          const prem = rec.locPremium ?? 1;
          const tags: string[] = [];
          if (rec.corner) tags.push("corner");
          if ((rec.shoreM ?? 9999) < 300) tags.push("waterfront");
          if ((rec.corridorM ?? 9999) < 90) tags.push("high street");
          if (tags.length === 0 && prem <= 1.001) return null;
          const bump = ((prem - 1) * 100).toFixed(0);
          return (
            <Row
              k="Location"
              v={tags.length
                ? `${tags.join(" · ")}${prem > 1.001 ? ` · +${bump}% on land` : ""}`
                : `+${bump}% on land`}
              strong={prem > 1.08}
            />
          );
        })()}
        {/* ONE LINE PER MARKET, because a building with shops under offices is
            in two of them and the average of the two is a rent nobody signs.
            The blend is the right number for an appraisal and the wrong one
            for a lease — see managedRentPsfYr — and this row was the blend
            with "market rent" written next to it, which is where the sense
            that shops lease miles under the market came from: they were being
            compared against a number that was mostly office. */}
        {isBuilt && (() => {
          const legs = leasableUses(rec);
          if (legs.length <= 1) {
            return <Row k="Market rent" v={"$" + marketRentPsfYr(rec, game.econ, cond).toFixed(0) + " /sf/yr"} />;
          }
          return (
            <>
              {legs.map((u) => (
                <Row
                  key={u}
                  k={`Market rent · ${CLASS_LABEL[u] ?? u}`}
                  v={"$" + useRentPsfYr(rec, game.econ, cond, u).toFixed(0) + " /sf/yr"}
                />
              ))}
              <Row k="Blended" v={"$" + marketRentPsfYr(rec, game.econ, cond).toFixed(0) + " /sf/yr"} />
            </>
          );
        })()}
        {/* DISCLOSED, not estimated, whenever the seller has shown a roll. The
            label drops "(mkt)" with it, because it is no longer an opinion. */}
        {isBuilt && !holding && (() => {
          const ip = goingIn(game, selectedBBL, value);
          return <Row k={ip.disclosed ? "Occupancy (in place)" : "Occupancy (mkt est.)"}
            v={(ip.occ * 100).toFixed(0) + "%"} bad={ip.disclosed && ip.occ < 0.75} />;
        })()}
        {isBuilt && !holding && (
          isMixedUse(rec)
            ? <Row k="Leasable spaces" v={usesOf(rec).map((u) => `${Math.max(1, Math.round(useSf(rec, u) / useSuiteSf(rec, u)))} ${USE_WORD[u]}`).join(" · ")} />
            : <Row k="Leasable spaces" v={`${unitCount(rec)} · ${sf(Math.round(suiteSf(rec)))} each`} />
        )}
        {holding && isBuilt && <Row k="Occupancy" v={(physicalOcc(rec as never, holding) * 100).toFixed(0) + "%"} />}
        {holding && isBuilt && unitStatus(rec, holding, game.month).byUse.map((u) => (
          <Row
            key={u.use}
            k={u.use === "multifamily" ? "Apartments let" : `${USE_WORD[u.use][0].toUpperCase()}${USE_WORD[u.use].slice(1)} spaces let`}
            /* Flats quote the average of the leg, not the demise: the leg is
               divided into a whole number of apartments and they occupy all of
               it, so a 1,412 sf residential leg is two flats of 706 and saying
               "900 each" describes 1,800 feet the building does not have.
               Commercial keeps the demise, because there the remnant under the
               floor genuinely is not a suite — see toSuites. */
            v={`${u.leased} of ${u.total} · ${sf(u.use === "multifamily" ? avgUnitSf(rec) : u.sfPer)} each`}
            bad={u.leased < u.total * 0.6}
          />
        ))}
        {holding && isBuilt && commercial && holding.tenants.length > 0 && (
          <Row
            k="On the rent roll"
            v={`${holding.tenants.length} lease${holding.tenants.length === 1 ? "" : "s"} · ${sf(holding.tenants.reduce((a, t) => a + t.sf, 0))}`}
          />
        )}
        {holding && isBuilt && commercial && (
          <Row k={<Gloss term="WALT">WALT</Gloss>} v={walt(holding, game.month).toFixed(1) + " yrs"} />
        )}
        {/* One building must not quote two different NOIs on one panel. In
            place off the roll — yours, or the one the seller disclosed — and
            struck against the appraisal, which is the only price on offer
            until somebody names one. The stabilised line sits beside it,
            labelled, because the gap between them is the deal. */}
        {isBuilt && (() => {
          const ip = goingIn(game, selectedBBL, value);
          const stab = proFormaNOIYr(rec, game.econ, ip.h?.condition ?? cond, value);
          const os = holding && omFull ? operatingStatement(rec, game.econ, holding, game.month) : null;
          const abate = holding && omFull ? remainingAbatement(holding, game.month) : 0;
          return (
            <>
              <Row
                k={ip.disclosed
                  ? <><Gloss term="NOI">In-place NOI</Gloss> / yr</>
                  : <><Gloss term="NOI">NOI</Gloss> / yr (mkt est.)</>}
                v={usd(ip.noi)}
              />
              {os && os.freeRent > 0 && (
                <Row
                  k="Scheduled rent (abated)"
                  v={usd(os.baseRent + os.freeRent) + "/yr"}
                  title={`${usd(os.freeRent)}/yr is free rent still burning — occupancy is up; this NOI has not caught it yet`}
                />
              )}
              {abate > 0 && <Row k="Free rent still owed" v={"−" + usd(abate)} bad />}
              {omFull && ip.disclosed && stab > ip.noi * 1.02 && (
                <Row k="Stabilised pro-forma" v={usd(stab)} />
              )}
            </>
          );
        })()}
        {omFull && holding && isBuilt && <Row k="Property tax / yr" v={usd(propertyTaxYr(rec, holding)) + (commercial ? " (your share)" : "")} />}
        {omFull && <Row k="Lot area" v={sf(rec.lotArea)} />}
        {omFull && isBuilt && <Row k="Building" v={sf(rec.bldgArea) + ` · ${rec.floors} fl · ${rec.yearBuilt}`} />}
        {omFull && isBuilt && isMixedUse(rec) && <Row k="The stack" v={mixLabel(rec)} />}
        <Row k={<span><Gloss term="FAR">FAR</Gloss> built / max</span>} v={`${builtFar.toFixed(1)} / ${farMax.toFixed(1)}`} />
        <Row k="Demand" v={String(Math.round(rec.demandScore)) + " / 100"} />
      </div>}

      {/* the builder's read on vacant dirt, owned or not — see ResidualRead */}
      {on("summary") && rec.class === "land" && rec.bldgArea === 0 && !dev && <ResidualRead bbl={selectedBBL} />}

      {/* SOMEBODY ELSE'S CRANE. A job on this site that is not yours — named or
          anonymous — is the most important thing on the parcel, because it is
          the space that will be competing with yours the year it opens. */}
      {on("summary") && !dev && (() => {
        const j = (game.cityJobs ?? []).find((x) => x.bbl === selectedBBL);
        if (!j) return null;
        const firm = game.rivals?.find((r) => r.id === j.firmId);
        const pct = Math.min(100, Math.max(0, ((game.month - j.startM) / Math.max(1, j.deliverM - j.startM)) * 100));
        return (
          <div className="deal">
            <div className="deal-head">
              {j.orphaned ? "A stalled building" : firm ? `${firm.name} is building here` : "Under construction"}
            </div>
            <div className="grid">
              <Row k="Programme" v={`${sf(j.sf)} of ${j.use} · ${j.floors} floors`} strong />
              <Row k="Progress" v={`${pct.toFixed(0)}%`} />
              <Row k={j.orphaned ? "Status" : "Delivers"}
                v={j.orphaned ? "The sponsor is gone — the receiver holds it" : monthLabel(j.deliverM)}
                bad={j.orphaned} />
              {j.firmId && !j.orphaned && j.cost !== undefined && <Row k="Their budget" v={usd(j.cost)} />}
            </div>
            {j.orphaned && (
              <div className="hint">
                Buy the site and the frame comes with it — you take over the job where they left it,
                and you pay only for what is left to build.
              </div>
            )}
          </div>
        );
      })()}

      {on("summary") && <Neighbourhood bbl={rec.bbl} block={rec.block} />}

      {on("summary") && holding?.groundLeased && game.groundLeases?.[selectedBBL] && (() => {
        const gl = game.groundLeases[selectedBBL]!;
        const built = game.built?.[selectedBBL];
        const job = (game.cityJobs ?? []).find((j) => j.bbl === selectedBBL && j.groundLease);
        if (!built?.bldgArea && !job && gl.builtM === undefined) return null;
        return (
          <div className="deal">
            <div className="deal-head">Lessee&apos;s building on your land</div>
            <div className="grid">
              <Row k="Tenant" v={gl.tenant} />
              {job && !gl.builtM && (
                <Row k="Under construction" v={`${job.floors} fl · ${job.use} · ${sf(job.sf)} · opens ${monthLabel(job.deliverM)}`} strong />
              )}
              {(built?.bldgArea || gl.builtM !== undefined) && (
                <>
                  <Row k="Standing" v={`${gl.floors ?? built?.floors ?? "?"} fl · ${useLabel(rec)} · ${sf(built?.bldgArea ?? gl.sf ?? 0)}`} strong />
                  {gl.builtM !== undefined && <Row k="Delivered" v={monthLabel(gl.builtM)} />}
                </>
              )}
              <Row k="Your ground rent" v={`${usd(gl.rentYr)} / yr`} />
              <Row k="Term ends" v={monthLabel(gl.endM)} />
            </div>
            <div className="hint">You own the dirt and the coupon — they let, operate and insure the improvement.</div>
          </div>
        );
      })()}

      {on("leasing") && holding && commercial && holding.tenants.length > 0 && (
        <div className="deal">
          <div className="deal-head">Rent roll · {sf(leasedSf)} of {sf(Math.round(rec.bldgArea * (1 - (mixOf(rec).multifamily ?? 0))))} commercial</div>
          <div className="roll">
            {/* Grouped by market, because that is how it is managed. The shops
                at grade renew against retail comps and the floors above against
                office comps; one undifferentiated list hid which half of the
                building was in trouble. */}
            {usesOf(rec).filter((u) => u !== "multifamily").flatMap((u) => {
              const inUse = holding.tenants.map((t, i) => ({ t, i })).filter((x) => (x.t.use ?? rec.class) === u);
              if (!inUse.length && useSf(rec, u) < 400) return [];
              return [
                <div key={`h-${u}`} className="roll-row roll-group">
                  <span className="roll-name">{USE_WORD[u]} · {sf(Math.round(useSf(rec, u)))}</span>
                  {/* The market for THIS corner, not the citywide index — a shop
                      on a prime block does not rent at the city average, and
                      quoting one beside the other made every in-place rent look
                      like a windfall. */}
                  <span className="roll-meta mono">${useRentPsfYr(rec, game.econ, holding.condition, u).toFixed(0)}/sf market here</span>
                </div>,
                ...inUse.map(({ t, i }) => {
                  const near = t.endM - game.month <= 24;
                  const ri = near ? renewalIntent(game, rec, holding, t) : null;
                  const fit = (t.staff ?? 1) > 1.30 ? "growing" : (t.staff ?? 1) < 0.78 ? "shrinking" : null;
                  // TENURE ON THE ROW. The roll knows exactly how long every
                  // tenant has been here and never said so — and "since 2004"
                  // is what turns a row into a relationship.
                  const yrsIn = Math.floor((game.month - t.startM) / 12);
                  const strained = t.strainedM !== undefined && game.month - t.strainedM < 24;
                  return (
                  <div key={i} className="roll-row">
                    <span className="roll-name">{t.name} <span className="roll-credit mono">{CREDIT_LABEL[t.credit]}</span>
                      {yrsIn >= 5 && <span className="dim"> · since {START_YEAR + Math.floor(t.startM / 12)}</span>}
                    </span>
                    <span className="roll-meta mono">
                      {(t.sf / 1000).toFixed(1)}k sf · ${t.rentPsf.toFixed(0)} {t.net ? "NNN" : "G"} · exp {monthLabel(t.endM)}
                      {fit && <> · {fit}</>}
                      {strained && <> · <span className="warn">strained</span></>}
                      {ri && <> · <span className={ri.p < 0.5 ? "warn" : ""}>{Math.round(ri.p * 100)}% renews</span> — {ri.why[0]}</>}
                    </span>
                  </div>
                  );
                }),
              ];
            })}
            {(mixOf(rec).multifamily ?? 0) > 0 && (
              <div className="roll-row roll-group">
                <span className="roll-name">apartments · {sf(Math.round(useSf(rec, "multifamily")))}</span>
                <span className="roll-meta mono">
                  {((holding.occ ?? 0) * 100).toFixed(0)}% let · ${useRentPsfYr(rec, game.econ, holding.condition, "multifamily").toFixed(0)}/sf market here
                </span>
              </div>
            )}
            {notReadySf(holding, game.month) > 0 && (
              <div className="roll-row roll-vacant">
                <span className="roll-name">In make-ready</span>
                <span className="roll-meta mono">
                  {(notReadySf(holding, game.month) / 1000).toFixed(1)}k sf · showable {monthLabel(Math.max(...(holding.makeReady ?? []).map((m) => m.readyM)))}
                </span>
              </div>
            )}
            {vacantSf(rec, holding) - notReadySf(holding, game.month) > 500 && (
              <div className="roll-row roll-vacant">
                <span className="roll-name">Vacant</span>
                <span className="roll-meta mono">{((vacantSf(rec, holding) - notReadySf(holding, game.month)) / 1000).toFixed(1)}k sf</span>
              </div>
            )}
          </div>
        </div>
      )}

      {on("leasing") && holding && isBuilt && !renovating && <LettingOdds bbl={selectedBBL} />}

      {/* THE MONTHLY STATEMENT. Every income number on this panel was an
          annual headline, and the arithmetic between the rent and the cheque
          was nowhere: scheduled rent plus recoveries is revenue, less the
          expense stack is NOI, less the mortgage is what actually lands in
          the account each month. Built from the same lines the appraisal
          runs (operatingStatement), divided by twelve, so this block and the
          NOI quoted above can never disagree on one building. */}
      {on("money") && holding && holding.groundLeased && game.groundLeases?.[selectedBBL] && (() => {
        const gl = game.groundLeases[selectedBBL]!;
        const pmt = holding.loan?.monthlyPmt ?? 0;
        const noiMo = gl.rentYr / 12;
        const cfMo = noiMo - pmt;
        return (
          <div className="deal">
            <div className="deal-head">Cash statement · monthly</div>
            <div className="grid">
              <Row k="Ground rent" v={usd(Math.round(noiMo))} strong />
              <Row k="Property tax / opex" v="$0 · lessee pays" />
              <Row k="NOI / mo" v={usd(Math.round(noiMo))} strong />
              {pmt > 0 && <Row k="Debt service / mo" v={"−" + usd(Math.round(pmt))} />}
              <Row k="Cash flow / mo" v={usd(Math.round(cfMo))} strong bad={cfMo < 0} />
            </div>
          </div>
        );
      })()}

      {on("money") && holding && isBuilt && !renovating && (() => {
        const os = operatingStatement(rec, game.econ, holding, game.month);
        const apt = rec.class === "multifamily";
        const pmt = holding.loan?.monthlyPmt ?? 0;
        const cfMo = os.noi / 12 - pmt;
        const mo = (n: number) => usd(Math.round(n / 12));
        return (
          <div className="deal">
            <div className="deal-head">Cash statement · monthly</div>
            <div className="grid">
              <Row k={apt ? "Rent collections" : "Scheduled rent"} v={mo(os.baseRent + os.freeRent)} />
              {os.freeRent > 0 && <Row k="Free rent burning off" v={"−" + mo(os.freeRent)} bad />}
              {!apt && <Row k="Expense recoveries" v={mo(os.recoveredOpex + os.recoveredTax)} />}
              <Row k="Revenue" v={mo(os.egi)} strong />
              <Row k="Operating expenses" v={"−" + mo(os.opex)} />
              {/* TWO LINES, NOT ONE. Apartments used to show a single 7% line
                  doing two jobs. The fee goes to whoever runs the building;
                  the reserve is capital for carpets, appliances and roofs.
                  Different money, different people, different reasons. */}
              <Row k="Management fee" v={"−" + mo(os.mgmt)} />
              {apt && os.reserve !== undefined && (
                <Row k="Replacement reserve" v={"−" + mo(os.reserve)} />
              )}
              <Row k="Property tax" v={"−" + mo(os.tax)} />
              <Row k="NOI / mo" v={mo(os.noi)} strong bad={os.noi < 0} />
              {pmt > 0 && <Row k="Debt service / mo" v={"−" + usd(Math.round(pmt))} />}
              <Row k="Cash flow / mo" v={usd(Math.round(cfMo))} strong bad={cfMo < 0} />
            </div>
          </div>
        );
      })()}

      {on("money") && holding?.loan && (
        <div className="deal">
          <div className="deal-head">Debt</div>
          <div className="grid">
            <Row k="Balance" v={usd(holding.loan.balance)} strong />
            <Row k="Coupon" v={pct(holding.loan.ratePct) + ((holding.loan.floating ?? holding.loan.product === "float") ? " (floating)" : " (fixed)")} />
            {holding.loan.holder && <Row k="Holder" v={holding.loan.holder} />}
            {game.month < holding.loan.ioUntilM && <Row k="Interest-only" v={"until " + monthLabel(holding.loan.ioUntilM)} />}
            <Row k="Debt service / yr" v={usd(holding.loan.monthlyPmt * 12)} strong />
            <Row k="Balloon" v={monthLabel(holding.loan.maturityM)} />
            {holding.mezz && holding.mezz.balance > 0 && (
              <Row
                k="Mezz"
                v={`${usd(holding.mezz.balance)} @ ${pct(holding.mezz.ratePct)} · ${holding.mezz.holder ?? "Cordage"} · due ${monthLabel(holding.mezz.maturityM)}`}
                bad
              />
            )}
            {d !== null && <Row k="DSCR" v={d.toFixed(2) + " (min " + holding.loan.minDSCR.toFixed(2) + ")"} bad={d < holding.loan.minDSCR} />}
            {l !== null && <Row k="LTV" v={(l * 100).toFixed(0) + "% (max " + (holding.loan.maxLTV * 100).toFixed(0) + "%)"} bad={l > holding.loan.maxLTV} />}
            {holding.loan.cap && <Row k="Rate cap" v={`base rate ≤ ${holding.loan.cap.strike.toFixed(2)}% until ${monthLabel(holding.loan.cap.expiresM)}`} />}
          </div>
          <div className="btn-row">
            {(() => {
              const due = payOffDue(holding.loan, game.month);
              const facPledged = !!game.facility?.bbls?.includes(selectedBBL);
              const canPay = !facPledged && fundableNow(game, parcels) >= due.due;
              return (
                <button
                  className="btn btn-buy"
                  disabled={!canPay}
                  title={facPledged
                    ? "Pledged to the facility — release it there first."
                    : !canPay
                      ? `Need ${usd(due.due)} to retire this loan.`
                      : due.penalty > 0
                        ? `Pay ${usd(due.balance)} + ${usd(due.penalty)} break fee. Required before a ground lease.`
                        : `Pay ${usd(due.due)}. Deed free and clear — required before a ground lease.`}
                  onClick={() => useStore.getState().payOffLoan(selectedBBL)}
                >
                  Pay off · {usd(due.due)}
                </button>
              );
            })()}
            {(holding.loan.floating ?? holding.loan.product === "float") && !holding.loan.cap && (
              <button
                className="btn"
                title={`Base rate capped at ${(game.econ.indexRate + 0.5).toFixed(2)}% for 3 years`}
                onClick={() => useStore.getState().rateCap(selectedBBL)}
              >
                Buy rate cap · {usd(rateCapCost(holding.loan))}
              </button>
            )}
          </div>
          <RefiSection bbl={selectedBBL} />
        </div>
      )}

      {on("deal") && listing && !holding && (() => {
        const t0 = game.talks?.[selectedBBL];
        const contract = t0?.agreed ? t0 : null;
        return (
          <div className="deal">
            <div className="deal-head">{contract ? "Under contract" : "On the market"}</div>
            <div className="grid">
              {contract
                ? <Row k="Agreed price" v={usd(contract.agreedPrice ?? contract.theirPrice)} strong />
                : <>
                    <Row k="Ask" v={usd(listing.ask)} strong />
                    {listing.loanBasis !== undefined && listing.loanBasis > 0 && (
                      <Row k="Loan basis" v={usd(listing.loanBasis)} title="Outstanding debt the lender is clearing — the ask is anchored here, not appraisal." />
                    )}
                  </>}
              {contract && <Row k="Must fund by" v={monthLabel(contract.closeByM ?? game.month + 3)} bad />}
              {contract && <Row k="Deposit posted" v={usd(contract.deposit ?? 0)} />}
              {/* THE NUMBERS YOU BID ON ARE THE NUMBERS YOU CLOSE ON. Priced
                  off the disclosed rent roll where there is one, so the cap
                  rate on this card is the cap rate you actually buy at rather
                  than the one a building of this type ought to trade at. */}
              {isBuilt && (() => {
                const px = contract?.agreedPrice ?? listing.ask;
                const ip = goingIn(game, selectedBBL, px);
                const stab = proFormaNOIYr(rec, game.econ, ip.h?.condition ?? cond, px);
                return (
                  <>
                    <Row k={ip.disclosed ? "In-place NOI / yr" : "NOI / yr (mkt est.)"} v={usd(ip.noi)} bad={ip.noi < 0} />
                    <Row k="Going-in cap" v={((ip.noi / Math.max(1, px)) * 100).toFixed(2) + "%"} strong />
                    {/* The seller's other number, and it is labelled as the
                        forecast it is. What you buy is the line above. */}
                    <Row k="Stabilised pro-forma" v={`${usd(stab)} · ${((stab / Math.max(1, px)) * 100).toFixed(2)}%`} />
                    <Row
                      k={ip.disclosed ? "Occupancy (in place)" : "Occupancy (mkt est.)"}
                      v={(ip.occ * 100).toFixed(0) + "%"}
                    />
                    {ip.h && <Row k="In place" v={`${ip.h.tenants.length} lease${ip.h.tenants.length === 1 ? "" : "s"}`} />}
                  </>
                );
              })()}
              {!isBuilt && <Row k="Land" v={"$" + ((contract?.agreedPrice ?? listing.ask) / rec.lotArea).toFixed(0) + " /sf of lot"} />}
            </div>
            {/* TWO ACTS, and never both at once. Before a handshake there is
                only a price; after one there is only the money. */}
            {contract ? (
              <>
                <div className="hint">{contract.note}</div>
                <BuyButtons bbl={selectedBBL} price={contract.agreedPrice ?? contract.theirPrice} off={false} />
              </>
            ) : (
              <OfferDesk bbl={selectedBBL} price={listing.ask} distress={!!listing.distress} loanBasis={listing.loanBasis} />
            )}
          </div>
        );
      })()}

      {on("deal") && !listing && !holding && (() => {
        const offContract = game.talks?.[selectedBBL]?.agreed ? game.talks[selectedBBL] : null;
        return (
        <div className="deal">
          <div className="deal-head">Off-market</div>
          {offContract ? (
            <>
              <div className="hint">{offContract.note}</div>
              <div className="grid">
                <Row k="Agreed price" v={usd(offContract.agreedPrice ?? offContract.theirPrice)} strong />
                <Row k="Close by" v={monthLabel(offContract.closeByM ?? game.month)} bad />
                <Row k="Earnest money" v={usd(offContract.deposit ?? 0)} />
              </div>
              <BuyButtons
                bbl={selectedBBL}
                price={offContract.agreedPrice ?? offContract.theirPrice}
                off={false}
              />
            </>
          ) : appr && !appr.refused && appr.ask !== undefined ? (
            <>
              {/* A NUMBER THAT ARRIVED THE HARD WAY READS DIFFERENTLY.
                  `mode` says how the conversation opened and never changes, so
                  `mode === "offer"` with an ask present can only mean one
                  thing: they deflected, you bid at them, and the bid drew the
                  figure out. That is worth saying, because the ask below it
                  has the knowledge that you want the building priced into it —
                  and because the counter button is gone and the player is owed
                  a reason why (bidBlind spends the counter on the bid). */}
              {appr.mode === "offer" && (
                <div className="hint">
                  They would not name a price until you bid.
                  {appr.lastBid ? ` Your ${usd(appr.lastBid)} got this out of them` : " This came back"} —
                  and it is a number quoted to somebody they now know wants it.
                </div>
              )}
              <div className="grid">
                <Row k="Owner's ask" v={usd(appr.ask)} strong />
                <Row k="vs. appraisal" v={((appr.ask / apMid(selectedBBL, value) - 1) * 100).toFixed(1) + "%"} />
                <Row k="Good until" v={monthLabel(appr.q + 6)} />
              </div>
              {/* Off-market has always been two acts: they name a number, you
                  counter it once, and only then is there a price to fund. The
                  finance block goes underneath the price conversation, not
                  above it. */}
              {!appr.countered && <OffMarketCounter bbl={selectedBBL} ask={appr.ask} />}
              <div className="hint" style={{ marginTop: 6 }}>
                {appr.countered
                  ? `Their number is ${usd(appr.ask)} and that is where it stays. Fund it or leave it.`
                  : appr.named
                    ? "You can counter it — but they named this figure in answer to your bid, so it is already close to their floor and they know you want the building. A few per cent is a negotiation; fifteen is an insult."
                    : "Counter once if you want to, then place the debt against whatever number you end up with."}
              </div>
              <BuyButtons bbl={selectedBBL} price={appr.ask} off closeLabel={`Buy at ${usd(appr.ask)}`} />
            </>
          ) : appr && !appr.refused ? (
            /* THE THIRD STATE, WHICH THIS PANEL DID NOT HAVE.
               An approach that is neither refused nor carrying an ask is the
               "make me an offer" conversation, and it fell through to the
               else-arm below — the one that says "Not listed, but everything
               has a price" and offers an Approach button whose only possible
               answer is "You already have them. They are waiting on YOUR
               number, not another call." A live negotiation rendered as though
               it had never happened. */
            <BlindBidDesk bbl={selectedBBL} appr={appr} value={value} />
          ) : appr && appr.refused ? (
            /* THE DATE PASSES AND THE PHONE STILL WORKS.
               This branch printed "try again after March" and then rendered no
               button at all — the only Approach button lived in the else-arm,
               which needs the approach record GONE, and the record does not
               expire for a year. So the six-month cooling-off period was, in
               practice, twelve months of a dead screen. The engine was right
               the whole time; the panel simply never offered the call. */
            <>
              <div className="hint">
                The owner turned you away in {monthLabel(appr.q)}.
                {game.month < appr.q + 6
                  ? ` They will not take another call until ${monthLabel(appr.q + 6)}.`
                  : " Enough time has passed that it is worth another call."}
              </div>
              <div className="btn-row">
                <button
                  className="btn"
                  disabled={game.month < appr.q + 6}
                  title={game.month < appr.q + 6
                    ? `Too soon — ${appr.q + 6 - game.month} month${appr.q + 6 - game.month === 1 ? "" : "s"} to go`
                    : "Ring them again. They may have changed their mind; they may not."}
                  onClick={() => approach(selectedBBL)}
                >
                  Approach the owner again
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="hint">
                Not listed — but everything has a price.
                {adjacency && assemblagePressure(game, adjacency, selectedBBL) > 0.3 &&
                  " You own neighbors: expect holdout pricing."}
              </div>
              <div className="btn-row">
                <button className="btn" onClick={() => approach(selectedBBL)}>Approach the owner</button>
              </div>
            </>
          )}
        </div>
        );
      })()}

      {on("build") && holding && dev && (
        <div className="deal">
          <div className="deal-head">Construction</div>
          <div className="grid">
            <Row k="Program" v={`${(dev.sf / 1000).toFixed(0)}k sf ${dev.use} · ${dev.floors} fl`} />
            <Row k="Budget" v={usd(dev.costTotal)} />
            <Row k="Constr. loan" v={usd(dev.loanBalance) + " @ " + pct(dev.ratePct)} />
            <Row k="Delivers" v={monthLabel(dev.deliverM)} strong />
            <Row
              k="Pre-let"
              v={(dev.signed?.length ?? 0)
                ? `${dev.signed!.length} deal${dev.signed!.length === 1 ? "" : "s"} · ${sf(dev.signed!.reduce((a, x) => a + x.sf, 0))} spoken for`
                : "None yet — tenants who take delivery risk show up here"}
              strong={(dev.signed?.length ?? 0) > 0}
            />
          </div>
          {(dev.signed?.length ?? 0) > 0 && (
            <div className="mini-list" style={{ marginTop: 8 }}>
              {dev.signed!.map((sg, i) => (
                <div key={i} className="mini-row" style={{ cursor: "default" }}>
                  <span>{(sg.use || "space")} · {sf(sg.sf)}</span>
                  <span className="mono dim">{((1 - sg.discount) * 100).toFixed(0)}% under market for delivery risk</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Lessee builds on a live ground lease — do not offer Break ground beside the coupon desk. */}
      {on("build") && holding && !dev && rec.class === "land"
        && !holding.groundLeased && !game.groundLeases?.[selectedBBL]
        && <DevelopSection bbl={selectedBBL} />}
      {on("build") && holding && !dev && isBuilt && <ReuseSection bbl={selectedBBL} />}

      {/* THE LAND DESK — assemble contiguous owned lots into one site.
          Own two or more parcels that touch (including through a lot already
          folded in), clear them, and fold the deeds together: one plate, one
          envelope, one address. LandDesk lists every reachable site and why
          a blocked one cannot join yet. */}
      {showLandDesk && <LandDesk bbl={selectedBBL} />}

      {on("leasing") && holding && isBuilt && !renovating && <LeasingDesk bbl={selectedBBL} />}

      {/* VACANT POSSESSION, IN ONE PLACE. Stopping the letting, buying the roll
          out and taking the building down are three steps of one decision, and
          they were spread across two cards on opposite ends of the page — the
          buyout inside the leasing desk, the wrecking bill at the bottom of
          Management. Nobody empties a building for fun; they empty it because
          they intend to knock it down, so the wrecker's number belongs beside
          the tenants' number. */}
      {on("ops") && holding && isBuilt && !renovating && (
        <VacantPossession bbl={selectedBBL} onRaze={() => setRazeAsk(selectedBBL)} />
      )}

      {on("ops") && holding && isBuilt && !renovating && (
        <div className="deal">
          <div className="deal-head">Management</div>
          <div className="grid">
            {/* WHAT A LETTER WILL ACTUALLY BE MEASURED AGAINST. The desk, the
                renewal manager and every arriving prospect price one LEG of
                this building at a time; this row averaged the legs together
                and called the result the asking rent, so on a mixed building
                the number on the screen was one nobody was ever quoted. */}
            {leasableUses(rec).map((u) => (
              <Row
                key={u}
                k={leasableUses(rec).length > 1 ? `Asking · ${CLASS_LABEL[u] ?? u}` : "Asking rent"}
                v={"$" + managedRentPsfYr(rec, game.econ, holding, u).toFixed(2) + " /sf on new leases"}
              />
            ))}
          </div>
          <div className="btn-row">
            {([-1, 0, 1] as const).map((v) => (
              <button
                key={v}
                className={"btn" + ((holding.stance ?? 0) === v ? " btn-on" : "")}
                title={v === 1 ? "+8% asking rents, fewer LOIs" : v === -1 ? "−8% rents, faster lease-up" : "market rents"}
                onClick={() => useStore.getState().stance(selectedBBL, v)}
              >
                {v === 1 ? "Push rents" : v === -1 ? "Fill space" : "Market"}
              </button>
            ))}
          </div>
          <div className="grid">
            <Row k="Service" v={`${serviceSpec(holding.service).label} · tenants read it as ${Math.round(100 * (holding.svcIdx ?? 0.55))} of 100`} />
            <Row k="Capital plan" v={`${planSpec(holding.plan).label} · condition ${Math.round(100 * (holding.condIdx ?? 0.6))} of 100`} />
          </div>
          <div className="btn-row">
            {OPS_SERVICE.map((o) => (
              <button
                key={o.key}
                className={"btn" + ((holding.service ?? 0) === o.key ? " btn-on" : "")}
                title={o.blurb + " — three years to matter, three years to undo"}
                onClick={() => useStore.getState().ops(selectedBBL, { service: o.key })}
              >{o.label}</button>
            ))}
          </div>
          <div className="btn-row">
            {OPS_PLAN.map((o) => (
              <button
                key={o.key}
                className={"btn" + ((holding.plan ?? 1) === o.key ? " btn-on" : "")}
                title={o.blurb}
                onClick={() => useStore.getState().ops(selectedBBL, { plan: o.key })}
              >{o.label}</button>
            ))}
          </div>
          <div className="btn-row">
            {PROGRAMS.map((p) => {
              const done = holding.programsDone?.[p.id] !== undefined;
              const running = holding.program?.id === p.id;
              const cost = programCost(rec, game, p);
              return (
                <button
                  key={p.id}
                  className="btn"
                  disabled={done || !!holding.program}
                  title={`${p.blurb} · ${p.months} months`}
                  onClick={() => useStore.getState().program(selectedBBL, p.id)}
                >
                  {done ? "✓ " : running ? "⏳ " : ""}{p.label} · {usd(cost)}
                </button>
              );
            })}
          </div>
          {commercial && vacantSf(rec, holding) > 500 && (
            <div className="btn-row">
              <button
                className={"btn" + (holding.broker ? " btn-on" : "")}
                title="A leasing exclusive: ~45% more tenant traffic while the space is vacant, and no retainer at all while it sits. The house is paid a commission instead — 6% of the base rent over the full term of every lease signed while they hold the file, due at the signing, in place of the 4% on a new lease and 2% on a renewal your own people cost. Cheap to hold, expensive when it works."
                onClick={() => useStore.getState().broker(selectedBBL, !holding.broker)}
              >
                {holding.broker
                  ? "✓ Broker engaged — 6% of everything they sign"
                  : "Hire leasing broker · no retainer, 6% of the lease at signing"}
              </button>
            </div>
          )}
          {isBuilt && cond !== "good" && (
            <div className="btn-row">
              <button className="btn" onClick={() => renovate(selectedBBL)}>
                Gut renovation · {usd(renovationCost(rec, game.econ))} · {6} mo
              </button>
            </div>
          )}
        </div>
      )}

      {/* The demolition question, asked in the house's own voice. window.confirm
          painted it as a browser popup captioned "localhost:8080" — and a browser
          that suppresses dialogs makes confirm() return false silently, which
          reads as a dead button. This card also says what the click is actually
          weighing: the wrecking bill against what the cleared dirt is worth. */}
      {razeAsk === selectedBBL && (() => {
        const demoCost = demolitionCost(rec, game);
        const dirt = landValue(rec, game.econ);
        return (
          <div className="modal-backdrop">
            <div className="modal">
              <div className="modal-kicker">Demolition order</div>
              <div className="modal-title">{rec.address}</div>
              <div className="modal-sub">
                {useLabel(rec)} · {sf(rec.bldgArea)} · {rec.floors} fl · built {rec.yearBuilt}.
                The site goes back to vacant land — the building, and every lease in it, does not come back.
              </div>
              <div className="grid">
                <Row k="Demolition cost" v={usd(demoCost)} bad={demoCost > game.cash} strong />
                <Row k="Cleared site is worth" v={usd(dirt)} />
                {farMax > 0 && <Row k="Buildable envelope" v={`${sf(Math.round(rec.lotArea * farMax))} at ${farMax.toFixed(1)} FAR`} />}
                <Row k="Cash on hand" v={usd(game.cash)} bad={demoCost > game.cash} />
              </div>
              <div className="modal-actions">
                <button
                  className="btn btn-sell"
                  disabled={demoCost > game.cash}
                  title={demoCost > game.cash ? "The wreckers want cash you don't have." : undefined}
                  onClick={() => { setRazeAsk(null); useStore.getState().raze(selectedBBL); }}
                >
                  Take it down · {usd(demoCost)}
                </button>
                <button className="btn" onClick={() => setRazeAsk(null)}>Leave it</button>
              </div>
              <div className="modal-queue">Wreckers work fast — the lot is clean dirt the same month.</div>
            </div>
          </div>
        );
      })()}

      {/* THE OFFERING MEMORANDUM, ON THE PAGE WHERE YOU DECIDE. It is no use
          for the engine to price the disclosed roll if the player cannot read
          it: what is let, to whom, at what rent, expiring when. Renders on the
          acquire tab for anything the seller has actually shown you — a tape
          listing or an open off-market conversation — and on nothing else. */}
      {on("deal") && !holding && isBuilt && <DisclosedRoll bbl={selectedBBL} />}

      {on("deal") && holding && <SaleSection bbl={selectedBBL} value={value} />}

      {on("summary") && holding && (
        <div className="deal">
          <div className="deal-head">Your position · since {monthLabel(holding.boughtM)}</div>
          <div className="grid">
            <Row k="Basis" v={usd(holding.costBasis)} />
            {(holding.deprTaken ?? 0) > 0 && <Row k="Depreciation taken" v={"−" + usd(holding.deprTaken!)} />}
            <Row k="Assessed (tax)" v={usd(holding.assessed ?? holding.costBasis)} />
            <Row k="Equity" v={usd(value - (holding.loan?.balance ?? 0) - (holding.mezz?.balance ?? 0))} strong />
          </div>
        </div>
      )}
      {!embedded && on("summary") && holding && taxAppeal && (
        <div className="deal">
          <div className="deal-head">Assessment watch</div>
          <div className="grid">
            <Row k="Tax roll" v={usd(taxAppeal.assessed)} bad />
            <Row k="Market evidence" v={usd(taxAppeal.target)} />
            <Row k="Potential annual saving" v={usd(taxAppeal.annualSavings)} strong />
          </div>
          <button
            className="btn"
            disabled={game.cash < taxAppeal.fee}
            onClick={() => useStore.getState().appealTax(selectedBBL)}
          >
            Appeal assessment · {usd(taxAppeal.fee)}
          </button>
        </div>
      )}

      {on("summary") && <div className="neighbors">
        <div className="neighbors-head">Adjoining lots · {neighbors.length}</div>
        <div className="neighbors-list">
          {neighbors.map((n) => {
            const nr = parcels[n];
            return (
              <button key={n} className="neighbor" onClick={() => select(n)}>
                <span className="neighbor-addr">{game.holdings[n] ? "◆ " : ""}{nr?.address ?? n}</span>
                <span className="neighbor-meta mono">
                  {nr ? `${nr.lotArea.toLocaleString()} sf · ${useLabel(nr)}` : ""}
                </span>
              </button>
            );
          })}
          {neighbors.length === 0 && <div className="neighbor-none">No shared lot lines on record.</div>}
        </div>
      </div>}
    </div>
  );
}

/** Memo: GamePanels re-renders on every page toggle; the docked card must not. */
export const ParcelPanel = memo(ParcelPanelShell);
