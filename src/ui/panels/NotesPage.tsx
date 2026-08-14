import { useStore } from "@/state/store";
import type { ParcelTable } from "@/data/types";
import { monthLabel } from "@/engine/types";
import type { GameState } from "@/engine/types";
import { assetValue, ownedHoldingValue, resolveRec, collateralAsIs } from "@/engine/value";
import { PRODUCTS } from "@/engine/debt";
import { capitalRatio, lenderPressure, CONSTRUCTION_LENDER } from "@/engine/lenders";
import { noteBid } from "@/engine/notes";
import { PRIVATE_CASH_RESERVE, privateBookFace, privateSleeveCapacity } from "@/engine/privateCredit";
import { firmShort } from "@/engine/firm";
import { assetGrade } from "@/engine/rivals";
import { usd } from "@/ui/format";

export type StatementRow = {
  bbl: string; borrower: string; yours: boolean; dev: boolean;
  klass: string; district: string;
  balance: number; rate: number; matM: number;
  origLtv: number | null; curLtv: number | null;
  status: string; bad: boolean;
};

export function bankStatement(game: GameState, parcels: ParcelTable, lenderName: string): StatementRow[] {
  const rows: StatementRow[] = [];
  for (const h of Object.values(game.holdings)) {
    if (!h.loan) continue;
    const holder = h.loan.holder ?? PRODUCTS.find((p) => p.id === h.loan!.product)?.lender;
    if (holder !== lenderName) continue;
    const rec = resolveRec(parcels, game, h.bbl);
    if (!rec) continue;
    const v = ownedHoldingValue(game, parcels, h);
    const w = game.workouts?.[h.bbl];
    rows.push({
      bbl: h.bbl, borrower: firmShort(game), yours: true, dev: false,
      klass: rec.class, district: rec.district ?? "—",
      balance: h.loan.balance, rate: h.loan.ratePct, matM: h.loan.maturityM,
      origLtv: h.loan.origValue ? h.loan.principal / h.loan.origValue : null,
      curLtv: v > 0 ? h.loan.balance / v : null,
      status: w ? "workout" : h.loan.sweep ? "swept" : game.month >= h.loan.maturityM ? "due" : "current",
      bad: !!w || !!h.loan.sweep,
    });
  }
  for (const x of Object.values(game.cityLoans ?? {})) {
    if (x.lender !== lenderName) continue;
    const rec = resolveRec(parcels, game, x.bbl);
    if (!rec) continue;
    const r = game.rivals?.find((z) => z.id === x.obligorId);
    const v = r ? assetValue(rec, game.econ, assetGrade(r, rec)) : 0;
    rows.push({
      bbl: x.bbl, borrower: r?.name ?? "—", yours: false, dev: false,
      klass: x.klass, district: rec.district ?? "—",
      balance: x.balance, rate: x.ratePct, matM: x.maturityM,
      origLtv: x.origValue > 0 ? x.balance / x.origValue : null,
      curLtv: v > 0 ? x.balance / v : null,
      status: x.status, bad: x.status !== "current",
    });
  }
  {
    // Construction paper sits with whichever desk the developer picked at
    // groundbreak; older jobs and takeovers fall back to the regional.
    for (const d of Object.values(game.developments ?? {})) {
      if ((d.lender ?? CONSTRUCTION_LENDER) !== lenderName || d.loanBalance <= 0) continue;
      const rec = resolveRec(parcels, game, d.bbl);
      rows.push({
        bbl: d.bbl, borrower: firmShort(game), yours: true, dev: true,
        klass: "construction", district: rec?.district ?? "—",
        balance: d.loanBalance, rate: d.ratePct ?? 0, matM: d.deliverM ?? game.month,
        origLtv: d.costTotal > 0 ? d.commitment / d.costTotal : null, curLtv: null,
        status: "construction", bad: false,
      });
    }
  }
  return rows.sort((a, b) => (a.yours !== b.yours ? (a.yours ? -1 : 1) : b.balance - a.balance));
}

/** Fifty years of capital ratio against the target, four numbers wide. */
export function CapSpark({ hist, target }: { hist?: number[]; target: number }) {
  if (!hist || hist.length < 2) return null;
  const w = 180, hgt = 34;
  const n = hist.length;
  const max = Math.max(target * 1.8, ...hist);
  const pts = hist.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(hgt - Math.min(1, v / max) * hgt).toFixed(1)}`).join(" ");
  const ty = hgt - Math.min(1, target / max) * hgt;
  return (
    <svg width={w} height={hgt} style={{ verticalAlign: "middle", overflow: "visible" }}>
      <line x1={0} y1={ty} x2={w} y2={ty} stroke="rgba(190,130,60,0.55)" strokeDasharray="3 2" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.2} opacity={0.85} />
    </svg>
  );
}

/**
 * THE NOTE DESK.
 *
 * Everything that decides the price is on this screen: whose loan it is, how
 * levered they are, how much cash they have against the face, how long they
 * have been in trouble, and which desk is selling and why. The player is not
 * being asked to trust a percentage — they are being asked to disagree with
 * one, which is the only way a price can be a decision.
 */
/**
 * WHICH DESKS ARE CLOSE TO SELLING PAPER.
 *
 * `lenderPressure` is the exact quantity `tickNoteOffers` reads when it decides
 * whether a desk is a forced seller — impaired capital against the target its
 * own kind of institution runs at, or a receiver, which is a forced seller by
 * definition. Reading it here is the engine's own number, not a second copy of
 * it: a desk at the top of this table is where the next offer comes from.
 */
export function NoteSellers() {
  const game = useStore((s) => s.game)!;
  const lenders = [...(game.lenders ?? [])]
    .map((l) => ({ l, p: lenderPressure(l), cap: capitalRatio(l) }))
    .sort((a, b) => b.p - a.p);
  if (!lenders.length) return null;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Desk</th>
            <th className="num" title="Capital over book — the one number that decides whether a desk is open">Capital</th>
            <th className="num" title="How badly they need to sell something. This is the number the offer generator reads.">Pressure</th>
            <th>What that means</th>
          </tr>
        </thead>
        <tbody>
          {lenders.map(({ l, p, cap }) => (
            <tr key={l.name}>
              <td>{l.name}{l.failedM !== undefined ? <span className="neg"> · in receivership</span> : ""}</td>
              <td className="num mono">{(100 * cap).toFixed(1)}%</td>
              <td className={"num mono" + (p > 0.5 ? " neg" : "")}>{(100 * p).toFixed(0)}%</td>
              <td className="dim">
                {l.failedM !== undefined
                  ? "A receiver is a forced seller. Everything they hold is for sale and none of it is priced by them."
                  : p > 0.7 ? "Badly impaired. They will sell good paper cheap to raise capital, and that is when you want to be looking."
                    : p > 0.35 ? "Under real pressure. Expect them to shop the weakest files first."
                      : p > 0.1 ? "Comfortable. Anything they offer will be priced above fair and the right move is usually to pass."
                        : "No reason to sell anything to anybody."}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotesPage() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const focus = useStore((s) => s.focus);
  const { takeNote, restructureNote, fileNote, offloadNote, fundPrivateAsk, declinePrivateAsk } = useStore.getState();
  const offers = game.noteOffers ?? [];
  const asks = game.privateAsks ?? [];
  const notes = game.notes ?? [];
  const privateNotes = notes.filter((n) => n.privateOriginated);
  const sleeve = privateSleeveCapacity(game, parcels);
  const bookFace = privateBookFace(game);

  return (
    <div>
      <div className="hint">
        A note is a claim on somebody else's rent, secured by a building you do not own and cannot manage. What
        you are underwriting is not the collateral — it is whether the borrower can make you go away. A performing
        loan on a solvent firm is a bond. A defaulted loan on a half-empty block is a building you have bid on
        privately, in an auction with one bidder, at a price the owner never agreed to. Nothing here is serviced
        by hand: the coupon arrives on its own, every month, and a note asks you for something exactly twice.
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        You can also <b>write</b> paper — hard-money bridges to rivals the banks will not clear. That is the
        private sleeve below. Want the <b>deed</b>, not the paper? Receiver books are on{" "}
        <button className="news-link" onClick={() => useStore.getState().setPage("market")}>
          Marketplace · Books for sale
        </button>
        .
      </div>

      <div className="page-section">Private asks · your sleeve</div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Sleeve capacity {usd(sleeve)} more face · book outstanding {usd(bookFace)}.
        Funded from cash only; leave a reserve. Expensive, short, enforceable — Cordage with your name on it.
      </div>
      {asks.length === 0 && (
        <div className="hint" style={{ marginBottom: 10 }}>
          No rival is asking you for money this month. Asks appear when somebody is stressed, dry, or staring
          at a balloon the cheap desks will not re-paper — and they lapse in two months.
        </div>
      )}
      {asks.map((a) => (
        <div key={a.id} className="hint" style={{ marginBottom: 10 }}>
          <div style={{ cursor: "pointer" }} onClick={() => focus(a.bbl, true)}>
            <strong>{a.address}</strong> · {a.rivalName} wants{" "}
            <b className="mono">{usd(a.face)}</b> at <b className="mono">{a.ratePct.toFixed(2)}%</b>,{" "}
            {(a.points * 100).toFixed(1)} points, {a.termM} months · {(100 * a.ltv).toFixed(0)}% of as-is {usd(a.asIs)}
          </div>
          <div className="dim" style={{ marginTop: 4 }}>{a.why}</div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button
              className="btn"
              disabled={a.face > sleeve || game.cash < a.face + PRIVATE_CASH_RESERVE}
              onClick={() => fundPrivateAsk(a.id)}
            >
              Fund · {usd(a.face)}
            </button>
            <button className="btn-mini" onClick={() => declinePrivateAsk(a.id)}>Pass</button>
            <span className="dim">Lapses {monthLabel(a.expiresM)}.</span>
          </div>
        </div>
      ))}
      {privateNotes.length > 0 && (
        <div className="hint" style={{ marginBottom: 10 }}>
          Your originated book: {privateNotes.map((n) => `${n.address} (${usd(n.face)})`).join(" · ")}.
        </div>
      )}

      <div className="page-section">On the block · bank paper</div>
      {offers.length === 0 && (
        <div className="hint">
          Nobody is selling paper this month. A desk sells a loan for two reasons and neither of them is you: the
          loan has stopped paying, or the desk needs the capital more than it needs the asset. Both are visible
          before the offer is, which is what the table below is for.
        </div>
      )}
      {/* WHO IS LIKELY TO SELL, ON THE DESK WHERE YOU WOULD BUY IT.
          The page used to say "watch the capital ratios on Research" and leave
          you to it — which is a fine sentence and a bad market. Nothing here is
          generated for the player's benefit and offers are episodic by design,
          so on most months this room is empty; a market that is empty and
          silent is indistinguishable from a market that is broken. This is the
          pressure the offer generator itself reads, so the player is watching
          the same gauge the engine is. */}
      <NoteSellers />
      {offers.map((o) => {
        const r = game.rivals?.find((x) => x.id === o.obligorId);
        const px = Math.round(o.face * o.askPct);
        const rec = resolveRec(parcels, game, o.bbl);
        const ltv = r && (r.aum ?? 0) > 0 ? r.debt / r.aum! : 0;
        return (
          <div key={o.id} className="hint" style={{ marginBottom: 10 }}>
            <div style={{ cursor: "pointer" }} onClick={() => focus(o.bbl, true)}>
              <strong>{o.address}</strong> · {o.perf === "nonperforming"
                ? <span className="neg">not paying</span> : "current"} · {usd(o.face)} of face at{" "}
              <b className="mono">{(100 * o.askPct).toFixed(0)} cents</b> = <b className="mono">{usd(px)}</b>
            </div>
            <div className="dim" style={{ marginTop: 4 }}>{o.why}</div>
            <div style={{ marginTop: 4 }}>
              The borrower is <strong>{o.obligor}</strong>
              {r && <> — {(100 * ltv).toFixed(0)}% levered, {usd(Math.max(0, r.cash))} of cash against {usd(o.face)} owed here
                {(r.stressMs ?? 0) > 0 && <span className="neg">, and {r.stressMs} months into a squeeze</span>}
                {r.occ !== undefined && <>, running their book at {(r.occ * 100).toFixed(0)}% let</>}.</>}
            </div>
            <div style={{ marginTop: 4 }} className={o.cure > 0.4 ? "" : "dim"}>
              The desk puts about <b className="mono">{(100 * o.cure).toFixed(0)}%</b> odds on being repaid.{" "}
              {o.cure > 0.45
                ? "That is a bond with a discount on it — you are underwriting the borrower, not the bricks."
                : o.cure < 0.15
                  ? "They do not expect to see this money. You are buying the building, and the only question is what it is worth when you get it."
                  : "Neither one thing nor the other, which is why it is cheap."}
            </div>
            {rec && (
              <div className="dim" style={{ marginTop: 4 }}>
                Clean, the building appraises at {usd(assetValue(rec, game.econ, "standard"))}. Off a receiver, worn
                and at their occupancy, it marks nearer {usd(collateralAsIs(rec, game.econ, r?.occ ?? 0.5))} — and
                a foreclosure takes nine to seventeen months during which you collect nothing.
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button className="btn" disabled={game.cash < px} onClick={() => takeNote(o.id)}>
                Buy the paper · {usd(px)}
              </button>
              <span className="dim">Offer lapses {monthLabel(o.expiresM)}. Somebody else is looking at it.</span>
            </div>
          </div>
        );
      })}

      <div className="page-section">Your book</div>
      {notes.length === 0 && <div className="hint">You hold no paper.</div>}
      {notes.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Collateral</th><th>Borrower</th><th className="num">Face</th><th className="num">Basis</th>
              <th className="num">Coupon</th><th className="num">Collected</th><th>Standing</th><th></th>
            </tr>
          </thead>
          <tbody>
            {notes.map((n) => {
              const bid = noteBid(game, parcels, n);
              return (
                <tr key={n.id}>
                  <td style={{ cursor: "pointer" }} onClick={() => focus(n.bbl, true)}>{n.address}</td>
                  <td>{n.obligor}</td>
                  <td className="num">{usd(n.face)}</td>
                  <td className="num">{usd(n.basis)}</td>
                  <td className="num">{n.ratePct.toFixed(2)}%</td>
                  <td className="num">{n.collected > 0 ? usd(n.collected) : "—"}</td>
                  <td className={n.perf === "nonperforming" ? "neg" : "dim"}>
                    {n.filedM !== undefined
                      ? `filed — the sale is around ${monthLabel(n.saleM ?? game.month)}`
                      : n.perf === "nonperforming"
                        ? "not paying"
                        : `paying, matures ${monthLabel(n.maturityM)}`}
                  </td>
                  <td>
                    {n.filedM === undefined && (
                      <span className="btn-row">
                        {n.perf === "nonperforming" && n.mods < 1 && (
                          <button className="btn-mini" title="Extend them, cut the coupon, take a five per cent paydown today. Once only."
                            onClick={() => restructureNote(n.id)}>restructure</button>
                        )}
                        {n.perf === "nonperforming" && (
                          <button className="btn-mini" title="Two per cent of face in legal, then nine to seventeen months of nothing, then you own it."
                            onClick={() => fileNote(n.id)}>foreclose</button>
                        )}
                        <button className="btn-mini" disabled={!bid.buyer}
                          title={bid.buyer ? `${bid.buyer} would pay ${usd(bid.px)}` : "No bid this month."}
                          onClick={() => offloadNote(n.id)}>
                          {bid.buyer ? `sell · ${usd(bid.px)}` : "no bid"}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(game.rivalNotes?.length ?? 0) > 0 && (
        <>
          <div className="page-section">Paper you passed on</div>
          {game.rivalNotes!.map((rn) => (
            <div key={rn.bbl} className="hint" style={{ cursor: "pointer" }} onClick={() => focus(rn.bbl, true)}>
              {resolveRec(parcels, game, rn.bbl)?.address ?? rn.bbl} — {rn.firm} holds the mortgage. They take the
              deed around {monthLabel(rn.takeM)} unless the owner finds {usd(rn.face)}.
            </div>
          ))}
        </>
      )}
    </div>
  );
}

