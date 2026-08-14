// THE LETTER ON THE DESK — one counter UI, used by the interrupt modal and
// the Deals page. Two copies of the same sliders drifted the last time the
// engine grew a knob the player could not see on both surfaces; this file is
// the single desk.
import { useState } from "react";
import Slider from "@/ui/Slider";
import type { GameState, LOI } from "@/engine/types";
import { CREDIT_LABEL, monthLabel } from "@/engine/types";
import type { ParcelTable } from "@/data/types";
import { managedRentPsfYr, resolveRec } from "@/engine/value";
import { bumpOf, DEFAULT_BUMP_PCT, loiSigningCost, netEffectivePsf } from "@/engine/leasing";
import { usd, sf } from "@/ui/format";
import { Row } from "@/ui/panels/shared";

export function loiMarketPsf(
  game: GameState, parcels: ParcelTable, loi: LOI,
): number {
  const rec = resolveRec(parcels, game, loi.bbl);
  const h = game.holdings[loi.bbl];
  if (!rec || !h) return loi.rentPsf;
  return managedRentPsfYr(rec, game.econ, h, loi.use);
}

export function loiTiCap(loi: LOI, market: number): number {
  const years = Math.max(1, loi.termM / 12);
  // Always room to offer some fit-out — even on a letter that asked for none —
  // because buying face rent with capital is a real landlord move.
  const floor = Math.round(market * 0.35 * years);
  return Math.max(loi.tiPsf, Math.round(loi.tiPsf * 1.4), floor);
}

export function loiFreeCap(loi: LOI): number {
  const byTerm = Math.min(Math.round(loi.termM * 0.2), loi.kind === "renewal" ? 6 : 12);
  // Even a letter with zero free months can be answered with some — that is
  // how you buy a higher face rent without looking greedy on the rent dial.
  return Math.max(loi.freeM, byTerm, loi.kind === "renewal" ? 3 : 4);
}

/** Their opening letter's net effective — what is already on the table. */
export function openingNe(loi: LOI): number {
  const rent = loi.openRentPsf ?? loi.rentPsf;
  const ti = loi.openTiPsf ?? loi.tiPsf;
  const free = loi.openFreeM ?? loi.freeM;
  const bump = loi.openBumpPct ?? bumpOf(loi);
  // Build a view of the opener so TI delta is zeroed (open vs open).
  const view = { ...loi, tiPsf: ti, openTiPsf: ti, freeM: free, bumpPct: bump, openBumpPct: bump };
  return netEffectivePsf(view, rent, ti, free, bump);
}

/**
 * TERM AND SIZE FIRST. When a letter lands, those two facts decide whether
 * you even care about the rent — everything else is secondary ink.
 */
export function LoiHero({ loi }: { loi: LOI }) {
  const yrs = loi.termM / 12;
  const yrLabel = Number.isInteger(yrs) ? String(yrs) : yrs.toFixed(1);
  return (
    <div className="loi-hero" aria-label={`${sf(loi.sf)}, ${yrLabel} years`}>
      <span className="loi-hero-sf">{sf(loi.sf)}</span>
      <span className="loi-hero-sep">·</span>
      <span className="loi-hero-term">{yrLabel}-year term</span>
    </div>
  );
}

type Counter = { rentPsf: number; tiPsf: number; freeM: number; bumpPct: number; bestFinal?: boolean };

/**
 * Sliders + the live NE readout. Parent owns Accept / Pass / Decide later;
 * this owns the counter draft and Send / Best&final / Back.
 */
export function LoiCounterDraft({
  loi, market, feeRate, fundShort,
  onSend, onBack,
}: {
  loi: LOI;
  market: number;
  feeRate?: number;
  /** Whether signing draws the line — passed through to Send. */
  fundShort: boolean;
  onSend: (c: Counter) => void;
  onBack: () => void;
}) {
  const [cRent, setCRent] = useState(+(loi.rentPsf * 1.05).toFixed(2));
  const [cTi, setCTi] = useState(loi.tiPsf);
  const [cFree, setCFree] = useState(loi.freeM);
  const [cBump, setCBump] = useState(bumpOf(loi));
  const tiCap = loiTiCap(loi, market);
  const freeCap = loiFreeCap(loi);
  const theirNe = openingNe(loi);
  const yourNe = netEffectivePsf(loi, cRent, cTi, cFree, cBump);
  const vsMkt = (yourNe / market - 1) * 100;
  // Signing cost follows the TI on the dial — cutting fit-out has to show up
  // in the cash line before you send, or the player cannot learn the trade.
  const costNow = loiSigningCost({ ...loi, tiPsf: cTi, rentPsf: cRent, freeM: cFree }, feeRate);
  const pushy = vsMkt > 8;
  const soft = vsMkt < -2;
  const openBump = loi.openBumpPct ?? bumpOf(loi);

  return (
    <div className="loi-counter">
      <Slider
        label="Your rent"
        value={cRent}
        min={+(Math.min(loi.rentPsf, market) * 0.70).toFixed(2)}
        max={+(Math.max(loi.rentPsf * 1.3, market * 1.2)).toFixed(2)}
        step={0.25}
        onChange={setCRent}
        format={(v) => `$${v.toFixed(2)}/sf · ${((v / market - 1) * 100).toFixed(0)}% vs market`}
        marks={[
          { at: loi.rentPsf, label: "their offer" },
          { at: +market.toFixed(2), label: "market" },
        ]}
        hint={loi.kind === "renewal"
          ? "Moving is expensive — an incumbent bends further than a prospect."
          : "They read your number against the market, not against their own opener."}
      />
      <Slider
        label="TI allowance"
        value={cTi}
        min={0}
        max={tiCap}
        step={1}
        onChange={setCTi}
        format={(v) => v > 0 ? `$${v}/sf · ${usd(v * loi.sf)}` : "none"}
        marks={[
          ...(loi.tiPsf > 0 ? [{ at: loi.tiPsf, label: "they asked" }] : [{ at: 0, label: "none" }]),
          ...(loi.tiPsf > 4 ? [{ at: Math.round(loi.tiPsf / 2), label: "half" }] : []),
        ]}
        hint="Cutting fit-out raises net effective the same way raising rent does."
      />
      <Slider
        label="Free rent"
        value={cFree}
        min={0}
        max={freeCap}
        step={1}
        onChange={setCFree}
        format={(v) => v > 0 ? `${v} months` : "none"}
        marks={[
          { at: loi.freeM, label: loi.freeM > 0 ? "they asked" : "none" },
        ]}
        hint="Forgone rent, not a signing cheque — it still moves the net effective they judge."
      />
      <Slider
        label="Annual bump"
        value={cBump}
        min={0}
        max={5}
        step={0.25}
        onChange={setCBump}
        format={(v) => `${v.toFixed(2)}%/yr${Math.abs(v - DEFAULT_BUMP_PCT) < 0.01 ? " · market standard" : v > DEFAULT_BUMP_PCT ? " · steeper" : " · flatter"}`}
        marks={[
          { at: openBump, label: "they offered" },
          { at: DEFAULT_BUMP_PCT, label: "2.5%" },
        ]}
        hint="Compounded every anniversary. Steeper than 2.5% raises net effective; flatter gives it away."
      />
      <div className={"loi-ne" + (pushy ? " neg" : soft ? "" : "")}>
        Your NE ${yourNe.toFixed(2)}/sf
        {" · "}
        {vsMkt >= 0 ? "+" : ""}{vsMkt.toFixed(0)}% vs market
        {Math.abs(theirNe - yourNe) > 0.05 ? ` · their opener $${theirNe.toFixed(2)}` : ""}
        {" · "}
        cash to sign {usd(costNow)}
        {cTi !== loi.tiPsf ? ` (was ${usd(loiSigningCost(loi, feeRate))} on their letter)` : ""}
      </div>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-buy"
          onClick={() => onSend({ rentPsf: cRent, tiPsf: cTi, freeM: cFree, bumpPct: cBump })}
        >
          Send counter
        </button>
        <button
          type="button"
          className="btn"
          title="Take-it-or-leave-it. No counter-back — they sign or they walk."
          onClick={() => onSend({ rentPsf: cRent, tiPsf: cTi, freeM: cFree, bumpPct: cBump, bestFinal: true })}
        >
          Best &amp; final
        </button>
        <button type="button" className="btn" onClick={onBack}>Back</button>
      </div>
      {fundShort && (
        <div className="hint dim">Signing still draws the shortfall on the line if cash is short.</div>
      )}
    </div>
  );
}

/** Summary grid for the letter — opening terms, or the final conversation. */
export function LoiTermsGrid({
  loi, game, market, feeRate,
}: {
  loi: LOI;
  game: GameState;
  market: number;
  feeRate?: number;
}) {
  const h = game.holdings[loi.bbl];
  const annual = loi.rentPsf * loi.sf;
  const cost = loiSigningCost(loi, feeRate);
  const prevRent = loi.kind === "renewal" && loi.tenantIdx !== undefined
    ? h?.tenants[loi.tenantIdx]?.rentPsf : undefined;
  const isFinal = loi.stage === "countered";
  const theirNe = openingNe(loi);
  const nowNe = netEffectivePsf(loi, loi.rentPsf, loi.tiPsf, loi.freeM, bumpOf(loi));
  const bump = bumpOf(loi);

  return (
    <div className="grid">
      <div className="loi-hero-block">
        <LoiHero loi={loi} />
        <div className="loi-hero-sub mono dim">
          to {monthLabel(game.month + loi.termM)} · {usd(annual)}/yr face
        </div>
      </div>
      {prevRent !== undefined && (
        <Row
          k="They pay today"
          v={`$${prevRent.toFixed(2)}/sf → offering $${(loi.openRentPsf ?? loi.rentPsf).toFixed(2)} (${(loi.openRentPsf ?? loi.rentPsf) >= prevRent ? "+" : ""}${((((loi.openRentPsf ?? loi.rentPsf) / prevRent) - 1) * 100).toFixed(1)}%)`}
          strong
          bad={(loi.openRentPsf ?? loi.rentPsf) < prevRent}
        />
      )}
      {isFinal && loi.askedRentPsf !== undefined && (
        <>
          <Row
            k="You asked"
            v={`$${loi.askedRentPsf.toFixed(2)}/sf`
              + (loi.askedTiPsf !== undefined ? ` · TI $${loi.askedTiPsf}` : "")
              + (loi.askedFreeM ? ` · ${loi.askedFreeM}mo free` : "")
              + (loi.askedBumpPct !== undefined ? ` · ${loi.askedBumpPct.toFixed(2)}%/yr` : "")}
            strong
          />
          <Row
            k="Their final"
            v={`$${(loi.counterRentPsf ?? loi.rentPsf).toFixed(2)}/sf`
              + (loi.counterTiPsf !== undefined ? ` · TI $${loi.counterTiPsf}` : "")
              + ((loi.counterFreeM ?? 0) > 0 ? ` · ${loi.counterFreeM}mo free` : "")
              + (loi.counterBumpPct !== undefined ? ` · ${loi.counterBumpPct.toFixed(2)}%/yr` : ` · ${bump.toFixed(2)}%/yr`)}
            strong
          />
        </>
      )}
      {!isFinal && <Row k="Rent" v={`$${loi.rentPsf.toFixed(2)}/sf`} strong />}
      {!isFinal && (
        <Row
          k="Annual bump"
          v={`${bump.toFixed(2)}%/yr${Math.abs(bump - DEFAULT_BUMP_PCT) < 0.01 ? " · market standard" : bump > DEFAULT_BUMP_PCT ? " · steeper than standard" : " · flatter than standard"}`}
        />
      )}
      <Row
        k="Recovery"
        v={(loi.recovery ?? (loi.net ? "nnn" : "gross")) === "nnn" ? "triple net — they pay opex and taxes"
          : (loi.recovery ?? "gross") === "base" ? "base-year stop — you keep today's expense level"
          : "full gross — every expense is yours"}
        bad={(loi.recovery ?? (loi.net ? "nnn" : "gross")) === "gross"}
      />
      <Row
        k="Net effective"
        v={`$${nowNe.toFixed(2)}/sf · ${((nowNe / market - 1) * 100).toFixed(0)}% vs market ~$${market.toFixed(2)}`}
        strong
        bad={nowNe < market * 0.9}
      />
      {!isFinal && Math.abs(theirNe - nowNe) > 0.01 && (
        <Row k="Opening NE" v={`$${theirNe.toFixed(2)}/sf`} />
      )}
      <Row k="vs. face market" v={`${((loi.rentPsf / market - 1) * 100).toFixed(1)}% on face rent`} bad={loi.rentPsf < market * 0.9} />
      <Row k="TI allowance" v={loi.tiPsf > 0 ? `$${loi.tiPsf}/sf · ${usd(loi.tiPsf * loi.sf)}` : "none"} />
      <Row k="Free rent" v={loi.freeM > 0 ? `${loi.freeM} months` : "none"} />
      <Row k="Cash to sign" v={usd(cost)} bad={cost > game.cash} strong />
      {h?.broker && (
        <Row
          k="Your exclusive"
          v={`6% of ${usd(annual * (loi.termM / 12))} of base rent over the term — ${usd(Math.round(annual * (loi.termM / 12) * 0.06))}, inside the number above`}
        />
      )}
      <Row k="Answer by" v={monthLabel(loi.expiresM)} />
    </div>
  );
}

export function LoiHeaderSub({ loi, address }: { loi: LOI; address: string }) {
  return (
    <>
      {loi.sector} · credit {CREDIT_LABEL[loi.credit]} · {address}
    </>
  );
}
