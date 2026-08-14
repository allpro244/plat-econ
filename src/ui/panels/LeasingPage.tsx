import Slider from "@/ui/Slider";
import { useStore } from "@/state/store";
import { monthLabel, CREDIT_LABEL, serviceSpec, planSpec } from "@/engine/types";
import { isLeasedFee, marketRentPsfYr, resolveRec, useRentPsfYr, recoveryOf } from "@/engine/value";
import {
  isCommercial, walt, notReadySf,
  agentFloor, agentPassBelow, agentMinCredit, agentMaxTiMonths, agentMaxSigningMonths, agentCashReserve,
  AGENT_FLOOR_MIN, AGENT_FLOOR_MAX, AGENT_PASS_MIN,
  AGENT_TI_MONTHS_MIN, AGENT_TI_MONTHS_MAX,
  AGENT_SIGNING_MONTHS_MIN, AGENT_SIGNING_MONTHS_MAX,
  deskHoldsPen, deskMonthNow, loiNeedsPrincipal, hasLeasingTeam,
} from "@/engine/leasing";
import { useSf } from "@/engine/mix";
import { portfolioIndustries } from "@/engine/comps";
import { INDUSTRY_LABEL } from "@/engine/market";
import { usd, sf } from "@/ui/format";
import { HousePolicy } from "@/ui/panels/HousePolicyDesk";
import { useLabel, physicalOcc, Big } from "@/ui/panels/shared";
import type { Credit } from "@/engine/types";

export function LeasingPage() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const select = useStore((s) => s.select);
  const setPage = useStore((s) => s.setPage);
  const {
    setAgent, setTeamLeasing, setRenewalMgmt, setAgentFloor, setAgentPassBelow,
    setAgentMinCredit, setAgentMaxTiMonths, setAgentMaxSigningMonths, broker,
  } = useStore.getState();
  const go = (bbl: string) => { setPage("none"); select(bbl); };
  const q = game.month;

  // Coupon-only fees: the lessee lets the tower. They must not dilute occ /
  // rent-roll totals or offer a "hire broker" button on an empty shell.
  const leasedFees = Object.values(game.holdings).flatMap((h) => {
    if (!isLeasedFee(h)) return [];
    const gl = game.groundLeases?.[h.bbl];
    if (!gl) return [];
    const rec = resolveRec(parcels, game, h.bbl);
    return [{ h, gl, rec }];
  });

  const rows = Object.values(game.holdings).flatMap((h) => {
    if (isLeasedFee(h)) return [];
    const rec = resolveRec(parcels, game, h.bbl);
    if (!rec || rec.class === "land" || !rec.bldgArea) return [];
    const commercial = isCommercial(rec);
    // Both halves of a stacked building count: the shops under lease and the
    // flats above that are occupied.
    const resSf = useSf(rec, "multifamily");
    const leased = h.tenants.reduce((a, t) => a + t.sf, 0) + Math.round((h.occ ?? 0) * resSf);
    const notReady = notReadySf(h, q);
    const occ = physicalOcc(rec as never, h);
    const rentRoll = h.tenants.reduce((a, t) => a + t.rentPsf * t.sf, 0)
      + resSf * useRentPsfYr(rec, game.econ, h.condition, "multifamily") * (h.occ ?? 0);
    const rolling = commercial ? h.tenants.filter((t) => t.endM - q <= 12).reduce((a, t) => a + t.sf, 0) : 0;
    return [{ h, rec, commercial, leased, notReady, occ, rentRoll, rolling }];
  });

  const ind = portfolioIndustries(game);

  function LeasedFeeStrip() {
    if (!leasedFees.length) return null;
    return (
      <div className="page-section">
        <div className="page-section-head">Leased fees · coupon only</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          Ground-leased lots pay you rent on the dirt. The lessee lets the building — there is no rent roll of yours to manage here.
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Property</th><th>Lessee</th><th className="num">Ground rent / yr</th><th className="num">Reverts</th>
            </tr>
          </thead>
          <tbody>
            {leasedFees.map(({ h, gl, rec }) => (
              <tr key={h.bbl} onClick={() => go(h.bbl)}>
                <td>{rec?.address ?? h.bbl}</td>
                <td className="dim">{gl.tenant}</td>
                <td className="num">{usd(gl.rentYr)}</td>
                <td className="num">{monthLabel(gl.endM)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div>
        <AgentBar />
        <RenewalBar />
        <DeskActivity />
        <MandateBar />
        <LeasedFeeStrip />
        <div className="hint">No buildings yet — occupancy starts when you own something with tenants in it.</div>
        <button className="btn btn-buy" onClick={() => setPage("market")}>
          Browse buildings in Marketplace →
        </button>
        {/* …but the house policy belongs here even with an empty book, because
            its other half is the deeds you have not closed yet: set it now and
            everything you buy arrives configured instead of being corrected
            afterwards. That is the whole argument for a default. */}
        <HousePolicy />
      </div>
    );
  }
  const totSf = rows.reduce((a, r) => a + r.rec.bldgArea, 0);
  const totLeased = rows.reduce((a, r) => a + r.leased, 0);
  const totRoll = rows.reduce((a, r) => a + r.rentRoll, 0);
  const totRolling = rows.reduce((a, r) => a + r.rolling, 0);

  function AgentBar() {
    const referred = (game.lois ?? []).filter((l) => loiNeedsPrincipal(game, l)).length;
    const teamOn = !!game.teamLeasing && hasLeasingTeam(game);
    const teamReady = hasLeasingTeam(game);
    // Three covers, one question: who holds the pen?
    const title = game.agent
      ? "Outside agent holds the pen."
      : teamOn
        ? "Your leasing desk holds the pen."
        : "You hold the pen.";
    const sub = game.agent
      ? `Vendor coverage at 6% — mid competence, not your payroll's judgment. They sign inside your mandate, counter soft letters, pick clear tour winners, and refer expansions, dead heats and capital calls. Scorecard below${referred ? `. ${referred} letter${referred === 1 ? "" : "s"} waiting on your desk.` : "."}`
      : teamOn
        ? `Staff coverage at 4%/2%. Unassigned leasing hires work the whole book; pinned hires only their buildings — anything left uncovered comes back to you. No LOI popups unless they refer${referred ? `. ${referred} on Deals.` : "."}`
        : "Default. Every letter lands on you unless a building has an exclusive, or you hand renewals to management below. Hire leasing on Staff, then hand them the book — or hire outside coverage at 6%.";
    return (
      <div className="agent-bar">
        <div>
          <div className="agent-title">{title}</div>
          <div className="agent-sub">{sub}</div>
        </div>
        <div className="btn-row" style={{ flexShrink: 0 }}>
          {game.agent ? (
            <button className="btn" onClick={() => setAgent(false)}>Take the pen back</button>
          ) : teamOn ? (
            <button className="btn" onClick={() => setTeamLeasing(false)}>Take the pen back</button>
          ) : (
            <>
              <button
                className="btn btn-on"
                disabled={!teamReady}
                title={teamReady
                  ? "Hand the leasing desk to your hires — no LOI popups"
                  : "Hire a leasing person on Staff first"}
                onClick={() => setTeamLeasing(true)}
              >
                Hand desk to staff
              </button>
              <button className="btn" onClick={() => setAgent(true)}>
                Outside coverage · 6%
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  /**
   * QUIET ACCOUNTABILITY. When somebody else holds the pen, popups stop.
   * Without a tally, a quiet month looks the same as a desk that is turning
   * every tenant away. Signed / passed / referred / walked is the proof.
   */
  function DeskActivity() {
    if (!deskHoldsPen(game)) return null;
    const tally = deskMonthNow(game);
    const referred = (game.lois ?? []).filter((l) => loiNeedsPrincipal(game, l)).length;
    return (
      <div className="agent-bar" style={{ display: "block" }}>
        <div className="agent-title">Desk this month · {monthLabel(game.month)}</div>
        {!tally ? (
          <div className="hint">
            No letters worked yet this month. When traffic arrives they sign, counter, pass or refer —
            you will see the counts here instead of a popup for every LOI.
            {referred ? ` ${referred} referred letter${referred === 1 ? "" : "s"} still need you on Deals.` : ""}
          </div>
        ) : (
          <>
            <div className="stat-strip" style={{ marginTop: 6 }}>
              <Big label="Signed" value={String(tally.signed)}
                title="Leases the desk closed inside your mandate" />
              <Big label="Passed" value={String(tally.passed)}
                title="Junk below your pass line — turned away on purpose" />
              <Big label="Referred" value={String(tally.referred)}
                title="Came back to you — expansions, capital calls, dead heats, failed counters" />
              <Big label="Walked" value={String(tally.walked)}
                title="Tenants who left after the desk countered" />
              <Big label="Countered" value={String(tally.countered)}
                title="Soft letters the desk pushed toward your sign line" />
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {tally.signed === 0 && tally.passed > 0 && tally.referred === 0
                ? "They have only been passing — check the pass line on your mandate if the market is soft."
                : tally.signed > 0
                  ? "They are closing. Passed letters are junk under your line, not silent refusals of good paper."
                  : referred
                    ? `${referred} letter${referred === 1 ? "" : "s"} on Deals need a principal decision.`
                    : "Desk is working the book quietly — activity shows up here as letters arrive."}
            </div>
          </>
        )}
      </div>
    );
  }

  /**
   * THE MIDDLE OPTION. The agent above takes the whole book at 6% and signs
   * everything, including the new leases — which is the half worth doing
   * yourself, where you trade term against allowance and decide whether a
   * covenant is worth a discount. This hands over only the RENEWALS: the paper
   * that rolls whether you are paying attention or not.
   *
   * The 2% is not a new charge. `leaseCosts` has always priced a renewal at 2%
   * of rent x sf x term against a new lease's 4%, because a renewal genuinely
   * is less work — no fit-out to negotiate, no tour, no covenant to underwrite.
   * Engaging the desk changes who signs, not what it costs.
   *
   * Hidden while the agent has the book, because the agent is already signing
   * the renewals and offering both would be offering the same thing twice.
   */
  function RenewalBar() {
    // Whole-book handoffs already cover renewals.
    if (game.agent || game.teamLeasing) return null;
    const on = !!game.renewalMgmt;
    return (
      <div className="agent-bar">
        <div>
          <div className="agent-title">
            {on ? "Property management has your renewals." : "You are handling your own renewals."}
          </div>
          <div className="agent-sub">
            {on
              ? "Sitting tenants get signed inside the same mandate below. The manager takes 2% of total lease value on top of the commission a renewal already pays (4% total). Soft renewals are referred; junk is passed. New leases still land on your desk."
              : "Every renewal letter comes to you six months before expiry, and signing one costs the 2% commission it always has. Hand them over and the routine ones stop asking, for a second 2% to the manager — you keep the new leases, which are the ones worth arguing about."}
          </div>
        </div>
        <button className={"btn" + (on ? "" : " btn-on")} onClick={() => setRenewalMgmt(!on)}>
          {on ? "Take renewals back" : "Management takes renewals · 2%"}
        </button>
      </div>
    );
  }

  /**
   * THE MANDATE — policy, not micromanagement.
   *
   * Three bands (sign / refer / pass), judged on net effective to the landlord
   * (face after free rent, less amortised TI), plus a credit floor and a TI
   * months cap. The desk decides which letters to work; you decide what
   * "good enough" means. Only shown when somebody else holds the pen.
   */
  function MandateBar() {
    // Firm agent, renewal desk, or exclusive — same mandate dials.
    if (!deskHoldsPen(game)) return null;
    const floor = agentFloor(game);
    const pass = agentPassBelow(game);
    const minCred = agentMinCredit(game);
    const tiM = agentMaxTiMonths(game);
    const signingM = agentMaxSigningMonths(game);
    const cashReserve = agentCashReserve(game);
    const creditLabel = (c: Credit) => (c === 2 ? "A only" : c === 1 ? "B or better" : "any credit");
    return (
      <div className="agent-bar" style={{ display: "block" }}>
        <div className="agent-title">Your mandate to the desk</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          They score each letter on <b>net effective</b> — face rent after free months, minus the fit-out
          amortised over the term — against the market for that use. Face rent alone was how a desk
          filled buildings twenty points cheap while looking busy.
        </div>
        <Slider
          label="Auto-sign at or above"
          value={Math.round(floor * 100)}
          min={Math.round(AGENT_FLOOR_MIN * 100)}
          max={Math.round(AGENT_FLOOR_MAX * 100)}
          step={1}
          onChange={(v) => setAgentFloor(v / 100)}
          marks={[{ at: 85, label: "85%" }, { at: 90, label: "usual" }, { at: 95, label: "95%" }, { at: 100, label: "par" }]}
          format={(v) => `${v}% of market, net effective`}
          hint={floor >= 0.97
            ? "At the market or nothing. Soft letters get a hard counter; most still come back if the tenant will not move."
            : floor >= 0.90
              ? "Tight. Good letters clear; soft ones they counter toward this line before bothering you."
              : floor <= 0.80
                ? "Wide. They will fill space, and some of what they sign will be cheap paper for a decade."
                : "A working mandate: a few points under market they close; worse they kill or bring back once."}
        />
        <Slider
          label="Auto-pass below"
          value={Math.round(pass * 100)}
          min={Math.round(AGENT_PASS_MIN * 100)}
          max={Math.round((floor - 0.02) * 100)}
          step={1}
          onChange={(v) => setAgentPassBelow(v / 100)}
          marks={[{ at: 70, label: "70%" }, { at: 78, label: "usual" }, { at: Math.round((floor - 0.02) * 100), label: "just under sign" }]}
          format={(v) => `${v}% of market — kill it, do not bother you`}
          hint={`Between ${Math.round(pass * 100)}% and ${Math.round(floor * 100)}% they counter and negotiate — you only see the letter if the tenant's final still needs a principal.`}
        />
        <Slider
          label="Maximum fit-out they may fund"
          value={tiM}
          min={AGENT_TI_MONTHS_MIN}
          max={AGENT_TI_MONTHS_MAX}
          step={1}
          onChange={(v) => setAgentMaxTiMonths(v)}
          marks={[{ at: 0, label: "none" }, { at: 6, label: "6 mo" }, { at: 9, label: "usual" }, { at: 12, label: "12 mo" }]}
          format={(v) => v === 0 ? "no TI without you" : `${v} months of face rent`}
          hint="Letters over the cap come back even if the rent clears — capital is a principal decision."
        />
        <Slider
          label="Maximum upfront signing cash"
          value={signingM}
          min={AGENT_SIGNING_MONTHS_MIN}
          max={AGENT_SIGNING_MONTHS_MAX}
          step={1}
          onChange={(v) => setAgentMaxSigningMonths(v)}
          marks={[{ at: 6, label: "6 mo" }, { at: 12, label: "usual" }, { at: 18, label: "18 mo" }]}
          format={(v) => `${v} months of face rent · TI + commission`}
          hint={`The desk also preserves ${usd(cashReserve)} of treasury reserve (six months of debt service, minimum $250K). Anything that breaches either limit comes back to you.`}
        />
        <div style={{ marginTop: 10 }}>
          <div className="slider-label" style={{ marginBottom: 4 }}>Minimum credit to auto-sign</div>
          <div className="btn-row">
            {([0, 1, 2] as Credit[]).map((c) => (
              <button
                key={c}
                className={"btn" + (minCred === c ? " btn-on" : "")}
                onClick={() => setAgentMinCredit(c)}
              >
                {creditLabel(c)}
              </button>
            ))}
          </div>
          <div className="hint">
            Weaker covenants than this are referred — you can still take them; the desk will not do it alone.
          </div>
        </div>
        <div className="hint" style={{ marginTop: 8 }}>
          Shop letters are judged on shop market, office on office — not the building's blended average.
        </div>
      </div>
    );
  }

  return (
    <div>
      <AgentBar />
      <RenewalBar />
      <DeskActivity />
      <MandateBar />
      <div className="stat-strip">
        <Big label="Portfolio occupancy" value={totSf ? ((100 * totLeased) / totSf).toFixed(1) + "%" : "—"} bad={totSf > 0 && totLeased / totSf < 0.8} />
        <Big label="Leased" value={sf(totLeased) + " of " + sf(totSf)} />
        <Big label="Rent roll / yr" value={usd(totRoll)} />
        <Big label="Rolling in 12 mo" value={sf(totRolling)} bad={totRolling > totLeased * 0.25} />
        <Big
          label="On your desk"
          value={String(game.lois.filter((l) => loiNeedsPrincipal(game, l)).length)}
          title="Letters that still need you — desk-covered paper is quiet"
        />
      </div>

      {/* WHAT YOUR RENT ROLL DOES FOR A LIVING.
          You can own twelve diversified buildings and still be sixty per cent
          finance — and when finance turns you find that out all at once, in
          every building, in the same eighteen months. It is the single most
          important thing a landlord can know about themselves and there was no
          way to see it. */}
      {ind.rows.length > 0 && (
        <div className="page-section">
          <div className="page-section-head">
            Exposure by trade{ind.atRisk > 0.18 ? ` · ${(ind.atRisk * 100).toFixed(0)}% of income in trades that are contracting` : ""}
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Trade</th><th className="num">Share of income</th><th className="num">Income / yr</th>
                <th className="num">Space</th><th className="num">Tenants</th><th>Cycle</th>
              </tr>
            </thead>
            <tbody>
              {ind.rows.map((r) => (
                <tr key={r.sector} className={r.stress > 0.4 ? "dim" : ""}>
                  <td>{INDUSTRY_LABEL[r.sector]}</td>
                  <td className={"num" + (r.share > 0.45 ? " neg" : "")}>{(r.share * 100).toFixed(0)}%</td>
                  <td className="num">{usd(r.income)}</td>
                  <td className="num">{sf(r.sf)}</td>
                  <td className="num">{r.tenants}</td>
                  <td className={r.phase === "bust" ? "neg" : "dim"}>
                    {r.phase === "boom" ? "hiring hard" : r.phase === "bust" ? "contracting" : "steady"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="hint">
            {ind.top && ind.top.share > 0.45
              ? `${(ind.top.share * 100).toFixed(0)}% of your rent comes from ${INDUSTRY_LABEL[ind.top.sector].toLowerCase()}. That is not a rent roll, it is a position in one trade — and both the buyers and the lenders price it that way.`
              : "A rent roll spread across trades survives a bad decade in any one of them. Lenders discount income concentrated in a single industry, and so does anyone buying the building off you."}
          </div>
        </div>
      )}

      <HousePolicy />

      <LeasedFeeStrip />

      <div className="page-section">
        <div className="page-section-head">By building</div>
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Property</th><th>Class</th><th className="num">Size</th><th className="num">Occupancy</th>
                <th className="num">Rent roll / yr</th><th className="num">Avg rent</th><th className="num">WALT</th>
                <th className="num">Rolling 12mo</th><th>Ask</th><th>Service</th><th>Plan</th><th>Leasing</th>
              </tr>
            </thead>
            <tbody>
              {rows.sort((a, b) => a.occ - b.occ).map((r) => (
                <tr key={r.h.bbl} onClick={() => go(r.h.bbl)}>
                  <td>{r.rec.address}</td>
                  <td>{useLabel(r.rec)}</td>
                  <td className="num">{sf(r.rec.bldgArea)}</td>
                  <td className={"num" + (r.occ < 0.75 ? " neg" : "")}>{(r.occ * 100).toFixed(0)}%</td>
                  <td className="num">{usd(r.rentRoll)}</td>
                  <td className="num">{r.leased ? "$" + (r.rentRoll / r.leased).toFixed(0) : "—"}</td>
                  <td className="num">{r.commercial ? walt(r.h, q).toFixed(1) + "y" : "—"}</td>
                  <td className={"num" + (r.rolling > r.leased * 0.3 ? " neg" : "")}>{r.rolling ? sf(r.rolling) : "—"}</td>
                  {/* THE THREE STANDING DECISIONS, so a book that has drifted off
                      the house policy shows it here rather than one card at a time. */}
                  <td className={(r.h.stance ?? 0) !== (game.opsPolicy?.stance ?? 0) ? "" : "dim"}>
                    {(r.h.stance ?? 0) > 0 ? "Push" : (r.h.stance ?? 0) < 0 ? "Fill" : "Market"}
                  </td>
                  <td className={(r.h.service ?? 0) !== (game.opsPolicy?.service ?? 0) ? "" : "dim"}>
                    {serviceSpec(r.h.service).label}
                  </td>
                  <td className={(r.h.plan ?? 1) !== (game.opsPolicy?.plan ?? 1) ? "" : "dim"}>
                    {planSpec(r.h.plan).label}
                  </td>
                  <td className="dim">
                    {[r.h.broker ? "BROKER" : null, r.notReady ? "TURNING" : null,
                      r.h.deliveredM !== undefined && q - r.h.deliveredM <= 30 ? "LEASE-UP" : null]
                      .filter(Boolean).join(" · ")}
                    {r.commercial && !r.h.broker && r.rec.bldgArea - r.leased > 500 && (
                      <button className="btn btn-mini" onClick={(e) => { e.stopPropagation(); broker(r.h.bbl, true); }}>hire</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="page-section">
        <div className="page-section-head">The rent roll</div>
        <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
          <table className="tbl">
            <thead>
              <tr><th>Tenant</th><th>Sector</th><th>Credit</th><th>Property</th><th className="num">Size</th><th className="num">Rent</th><th>Recovery</th><th className="num">Stop $/sf</th><th className="num">vs mkt</th><th className="num">Expires</th></tr>
            </thead>
            <tbody>
              {rows.flatMap((r) => r.h.tenants.map((t, i) => ({ t, r, i })))
                .sort((a, b) => a.t.endM - b.t.endM)
                .map(({ t, r, i }) => (
                  <tr key={r.h.bbl + ":" + i} onClick={() => go(r.h.bbl)}>
                    <td>{t.name}</td>
                    <td className="dim">{t.sector}</td>
                    <td className="mono">{CREDIT_LABEL[t.credit]}</td>
                    <td className="dim">{r.rec.address}</td>
                    <td className="num">{sf(t.sf)}</td>
                    <td className="num">${t.rentPsf.toFixed(2)}</td>
                    <td className="dim">{recoveryOf(t) === "nnn" ? "NNN" : recoveryOf(t) === "base" ? "base yr" : "gross"}</td>
                    <td className="num dim">{recoveryOf(t) === "base" ? `$${(t.baseStopPsf ?? 0).toFixed(2)}` : "—"}</td>
                    {(() => {
                      const mkt = marketRentPsfYr(r.rec, game.econ, r.h.condition);
                      const d = mkt > 0 ? t.rentPsf / mkt - 1 : 0;
                      return <td className={"num" + (d < -0.12 ? " neg" : "")}>{(d * 100).toFixed(0)}%</td>;
                    })()}
                    <td className={"num" + (t.endM - q <= 12 ? " neg" : "")}>{monthLabel(t.endM)}</td>
                  </tr>
                ))}
              {!rows.some((r) => r.h.tenants.length) && (
                <tr><td colSpan={10} className="dim">Nothing under lease yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/**
 * THE TAPE, AS ITS OWN PAGE.
 *
 * Every headline this economy writes was being rendered into a 260px scroll
 * box at the bottom of the Books page, under the ledger and the milestone
 * list — which is the same as not having a news page, and is why the owner
 * asked where it was. Saves was promoted out of that same page for the same
 * reason.
 *
 * The engine keeps the last 120 items (market.ts and sim.ts both trim to it),
 * so this shows all of them rather than a slice, grouped by month so a run of
 * headlines reads as a month rather than as a list, and filterable because in
 * a bad year the warnings are the only ones you want.
 */
