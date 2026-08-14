import { useState, Fragment } from "react";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { assetValue, initialCondition, resolveRec, netWorth } from "@/engine/value";
import { marketAppetite, markRival, rivalCondition, rivalTemperamentWeight } from "@/engine/rivals";
import { rivalPrincipalOf } from "@/engine/people";
import { PersonCard, personAgeLine } from "@/ui/PersonCard";
import { firmName } from "@/engine/firm";
import { usd, sf } from "@/ui/format";
import { useLabel, Row } from "@/ui/panels/shared";

// THE STREET. Who else is buying, what they own, and how much rope they have
// left. This is not decoration: the appetite number at the top is the same one
// that decides whether your lowball gets refused, and a firm sliding toward
// its covenants is a firm whose buildings are about to be cheap.
/**
 * WHAT A RIVAL IS WORTH, once — gross assets marked the way `markRival` marks
 * them, less the debt against them, plus what is in the bank. It is the same
 * arithmetic the player's own Books page calls net worth, which is the point:
 * a league table is only a league table if both sides are measured the same
 * way. Written down here because three places on this page print it and one
 * quantity does not get three expressions.
 */
export const rivalEquity = (m: { aum: number }, r: { debt: number; cash: number }) => m.aum - r.debt + r.cash;

export function TheStreet() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const focus = useStore((s) => s.focus);
  const [open, setOpen] = useState<string | null>(null);
  const rivals = game.rivals ?? [];
  if (!rivals.length) return null;
  const appetite = marketAppetite(game);
  // Same number as TopBar / Books — a street rank that re-derives equity is
  // one quantity with two answers (facility, loc, deposits, CIP, notes).
  const playerEquity = netWorth(game, parcels);
  const marked = rivals.map((r) => ({ r, m: markRival(game, parcels, r) }))
    .sort((a, b) => (a.r.failedM !== undefined ? 1 : 0) - (b.r.failedM !== undefined ? 1 : 0) || b.m.aum - a.m.aum);
  return (
    <>
      <div className="page-section">
        The street · competing money {appetite < 0.6 ? "has left the room" : appetite < 0.9 ? "is thin" : appetite > 1.15 ? "is everywhere" : "is normal"}
      </div>
      <div className="hint">
        These firms bid on the same tape you do, with their own money — a firm without the equity does not
        close, and one already at its covenant cannot borrow to. When their dry powder is high your lowballs
        get refused; when their leverage runs past their covenants they sell into whatever bid exists, and
        that bid is you. The principal column is who runs the shop and how old they are — equity alone cannot
        tell you the next thirty years. Click any firm for its balance sheet and what it owns.
      </div>
      {/* THE LEAGUE TABLE. They started where you started — five to eighteen
          million and a hundred years — so the only honest way to read your own
          number is against theirs. */}
      <div className="grid" style={{ marginBottom: 10 }}>
        {(() => {
          const board = [
            { name: firmName(game), eq: playerEquity, me: true },
            ...marked.filter((x) => x.r.failedM === undefined)
              .map((x) => ({ name: x.r.name, eq: rivalEquity(x.m, x.r), me: false })),
          ].sort((a, b) => b.eq - a.eq);
          const rank = board.findIndex((b) => b.me) + 1;
          return (
            <>
              <Row k="Your place on the street" v={`${rank} of ${board.length} by equity`} strong bad={rank > board.length / 2} />
              <Row k="The biggest book in town" v={`${board[0].name} · ${usd(board[0].eq)}`} />
            </>
          );
        })()}
      </div>
      <table className="tbl">
        <thead>
          <tr>
            {/* NET EQUITY, ON THE TABLE. It was computed twice already — once
                inside the league-table grid above, which ranks you against it,
                and once inside each firm's drawer as "Net worth" — and the
                column list did not carry it, so the one number that says who
                is actually winning was two clicks deep. Gross assets less debt
                plus cash, exactly as the drawer and the ranking compute it;
                three expressions for one quantity is how a table comes to
                disagree with the row it expands into, so all three now read
                the same `eq` off `markRival` and the firm's own balance. */}
            <th>Firm</th><th>Principal</th><th>Style</th><th className="num">Buildings</th><th className="num">Gross assets</th>
            <th className="num">Debt</th><th className="num">Net equity</th>
            <th className="num">Leverage</th><th className="num">Dry powder</th><th>Read</th>
          </tr>
        </thead>
        <tbody>
          {marked.map(({ r, m }) => {
            const dead = r.failedM !== undefined;
            const stress = (r.stressMs ?? 0) > 0;
            const isOpen = open === r.id;
            const principal = rivalPrincipalOf(game, r.id);
            return (
              <Fragment key={r.id}>
              <tr className={dead ? "dim" : ""} style={{ cursor: "pointer" }}
                onClick={() => setOpen(isOpen ? null : r.id)}>
                <td title={r.spawnedFrom ? `Raised out of ${r.spawnedFrom.firmName} · ${r.spawnedFrom.personName}` : undefined}>
                  {isOpen ? "▾ " : "▸ "}{r.name}
                  {r.spawnedFrom ? <span className="dim"> · from {r.spawnedFrom.firmName}</span> : null}
                </td>
                <td className="dim">{dead ? "—" : personAgeLine(principal, game.month)}</td>
                <td className="dim">{STYLE_WORD[r.style]}</td>
                <td className="num">{dead ? (r.bbls.length ? `${r.bbls.length} in workout` : "—") : r.bbls.length}</td>
                <td className="num">{dead ? "—" : usd(m.aum)}</td>
                <td className={"num" + (!dead && r.debt > 0 ? " dim" : "")}>{dead ? "—" : usd(r.debt)}</td>
                {/* THE NUMBER THE OWNER ASKED FOR. A firm running a billion of
                    gross assets at 85% leverage has less of its own money in
                    the game than a family trust with two hundred million
                    unencumbered, and the first four columns could not tell you
                    that. Negative is not a rounding artefact — it is a firm
                    whose buildings no longer cover its paper, which is the
                    condition that turns them into your seller. */}
                <td className={"num" + (!dead && rivalEquity(m, r) < 0 ? " neg" : "")}>
                  {dead ? "—" : usd(rivalEquity(m, r))}
                </td>
                {/* debt against no assets is not a ratio, it is a hole */}
                <td className={"num" + (!dead && m.ltv > 0.8 ? " neg" : "")}>
                  {dead ? "—" : m.aum <= 0 ? (r.debt > 0 ? "no assets" : "—") : `${(m.ltv * 100).toFixed(0)}%`}
                </td>
                <td className="num">{dead ? "—" : usd(Math.max(0, r.cash))}</td>
                <td className="dim">
                  {dead ? (r.bbls.length
                    ? `Failed ${monthLabel(r.failedM!)} — the receiver is still selling`
                    : `Gone, ${monthLabel(r.failedM!)}`)
                    : m.aum <= 0 && r.debt > 0 ? "Sold everything and still owes money — they are finished"
                    : stress ? "Selling under pressure — their tape is your opportunity"
                    : m.ltv > 0.75 ? "Levered up. One bad cycle from being a seller"
                    : r.cash > m.aum * 0.06 ? "Sitting on cash. They will outbid you"
                    : "Fully invested"}
                </td>
              </tr>
              {isOpen && (
                <tr>
                  <td colSpan={10} style={{ background: "rgba(43,37,26,0.035)" }}>
                    {/* THE BALANCE SHEET, the same one you are judged on. Gross
                        assets less debt is their equity; NOI over assets is what
                        the book yields; distributions are what they have already
                        taken off the table, which is why a firm with modest
                        equity is not necessarily a firm that did badly. */}
                    {principal && !dead && (
                      <PersonCard person={principal} game={game} showAttrs={false} title="Operating principal" />
                    )}
                    {principal && !dead && (() => {
                      const tw = rivalTemperamentWeight(game, r);
                      const pace = tw > 1.12 ? "Contests the tape hard"
                        : tw < 0.88 ? "Patient bidder — slower on contested asks"
                          : "Ordinary pace on the tape";
                      return (
                        <div className="hint" style={{ marginBottom: 6 }} title="Bandwidth × Access — temperament, not their balance sheet">
                          {pace}
                        </div>
                      );
                    })()}
                    <div className="grid" style={{ margin: "8px 0" }}>
                      <Row k="Gross assets" v={usd(m.aum)} />
                      <Row k="Debt" v={usd(r.debt)} bad={m.ltv > 0.8} />
                      <Row k="Equity in property" v={usd(m.aum - r.debt)} bad={m.aum - r.debt < 0} />
                      <Row k="Cash" v={usd(r.cash)} bad={r.cash < 0} />
                      {/* the number the league table ranks on, and the same one
                          your own Books page calls net worth */}
                      <Row k="Net worth" v={usd(rivalEquity(m, r))} strong bad={rivalEquity(m, r) < 0} />
                      <Row k="Leverage" v={`${(m.ltv * 100).toFixed(0)}% LTV · they stop at ${(STYLE_MAX[r.style] * 100).toFixed(0)}%`} bad={m.ltv > STYLE_MAX[r.style]} />
                      <Row k="NOI / yr" v={usd(m.noiYr)} />
                      <Row k="Yield on assets" v={m.aum > 0 ? `${((m.noiYr / m.aum) * 100).toFixed(2)}%` : "—"} />
                      {/* THE PART OF A COMPETITOR YOU COULD NEVER SEE. Their
                          buildings fill and empty and wear out like yours do,
                          and a firm running 74% full with a deferred capital
                          plan is a seller waiting for a reason. */}
                      {r.occ !== undefined && (
                        <Row k="Portfolio occupancy" v={`${(r.occ * 100).toFixed(0)}%`} bad={r.occ < 0.8} />
                      )}
                      <Row k="Condition of the book"
                        v={`${CONDITION_WORD[rivalCondition(r)]} · ${usd(r.capexYr ?? 0)} of capital spent this year`}
                        bad={(r.condIdx ?? 1) < 0.55} />
                      {game.street?.[r.id] && (
                        <Row k="Between you"
                          v={[
                            game.street[r.id].deals ? `${game.street[r.id].deals} deal${game.street[r.id].deals === 1 ? "" : "s"}` : null,
                            game.street[r.id].beats ? `outbid you ${game.street[r.id].beats}×` : null,
                            game.street[r.id].insults ? `${game.street[r.id].insults} conversation${game.street[r.id].insults === 1 ? "" : "s"} you ended badly` : null,
                          ].filter(Boolean).join(" · ") || "nothing yet"}
                          bad={(game.street[r.id].insults ?? 0) > 0} />
                      )}
                      <Row k="Debt service / yr" v={`−${usd((r.debt * (game.econ.indexRate + 1.9)) / 100 + r.debt / 30)}`} />
                      {/* realised, and no longer on this balance sheet — which
                          is why modest equity is not the same as a bad century */}
                      <Row k="Taken out to date" v={usd(r.distributed ?? 0)} />
                      <Row k="Founded" v={r.bornM > 0 ? monthLabel(r.bornM) : "before you arrived"} />
                    </div>
                    {/* WHAT THEY HAVE IN THE GROUND. A firm's live jobs are the
                        part of its balance sheet that is pure risk: money spent,
                        debt drawn, nothing earning. It is also the space that is
                        coming for your tenants in two years. */}
                    {(() => {
                      const jobs = (game.cityJobs ?? []).filter((j) => j.firmId === r.id);
                      if (!jobs.length) return null;
                      return (
                        <>
                          <div className="page-section" style={{ marginTop: 4 }}>
                            Under construction · {jobs.length}
                          </div>
                          <div className="mini-list">
                            {jobs.map((j) => {
                              const rec = resolveRec(parcels, game, j.bbl);
                              const pct = Math.min(100, Math.max(0, ((game.month - j.startM) / Math.max(1, j.deliverM - j.startM)) * 100));
                              return (
                                <button key={j.bbl} className="neighbor"
                                  onClick={(ev) => { ev.stopPropagation(); focus(j.bbl, true); }}>
                                  <span className="neighbor-addr">{rec?.address ?? j.bbl}</span>
                                  <span className="neighbor-meta">
                                    {sf(j.sf)} {j.use} · {j.floors} fl · {pct.toFixed(0)}% ·{" "}
                                    {j.orphaned ? "stalled — the sponsor is gone" : `due ${monthLabel(j.deliverM)}`}
                                    {j.debt ? ` · ${usd(j.debt)} drawn` : ""}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </>
                      );
                    })()}
                    <div className="page-section" style={{ marginTop: 4 }}>
                      What they own · {r.bbls.length}
                    </div>
                    {r.bbls.length === 0 && <div className="hint">Nothing. All cash, looking.</div>}
                    {/* EVERY DEED, not the first sixty. A truncated list of a
                        competitor's holdings is worse than none: it looks
                        complete and it is not, and you cannot see what somebody
                        is quietly assembling from a page that stops early.
                        Sorted by value, because that is how a book is read. */}
                    <div className="mini-list">
                      {r.bbls.map((b) => {
                        const rec = resolveRec(parcels, game, b);
                        if (!rec) return null;
                        return { b, rec, v: assetValue(rec, game.econ, initialCondition(rec)) };
                      }).filter(Boolean).sort((a, b2) => b2!.v - a!.v).map((row) => (
                        <button key={row!.b} className="neighbor"
                          onClick={(ev) => { ev.stopPropagation(); focus(row!.b, true); }}>
                          <span className="neighbor-addr">{row!.rec.address}</span>
                          <span className="neighbor-meta">
                            {row!.rec.class === "land" ? "vacant land" : `${useLabel(row!.rec)} · ${sf(row!.rec.bldgArea)}`} · {usd(row!.v)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// where each style stops borrowing — mirrored from the engine so the sheet can
// say what their own covenant is, not just where they are against it
export const STYLE_MAX: Record<string, number> = {
  family: 0.50, core: 0.65, opportunistic: 0.88, developer: 0.78,
  merchant: 0.80, pe: 0.75, reit: 0.58, vulture: 0.60,
  owneruser: 0.55, foreign: 0.35, slumlord: 0.72,
};

export const CONDITION_WORD: Record<string, string> = {
  good: "well kept", standard: "adequate", worn: "run down", obsolete: "finished",
};

// What the street calls each kind of shop. The point of the phrasing is that
// it tells you what they WANT, because that is what decides whether they are
// your competition on this building or your buyer for it next year.
export const STYLE_WORD: Record<string, string> = {
  family: "old money",
  core: "institutional",
  opportunistic: "opportunistic",
  developer: "developer",
  merchant: "merchant builder",
  pe: "private equity · IRR clock",
  reit: "listed REIT",
  vulture: "distressed specialist",
  owneruser: "owner-occupier",
  foreign: "offshore capital",
  slumlord: "milking the stock",
};
