import { useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { assetValue, marketRentPsfYr, resolveRec, landPsfNow, inPlace } from "@/engine/value";
import { streetBookStats } from "@/engine/portfoliosale";
import { holderOf, isCold } from "@/engine/owners";
import { demandNow } from "@/engine/demand";
import { LineChart } from "@/ui/Chart";
import { marketAppetite, ownerOf, gradeOf } from "@/engine/rivals";
import { usd, sf, pct } from "@/ui/format";
import { BrokerCalls } from "@/ui/panels/broker";
import { useLabel, Big, Row } from "@/ui/panels/shared";

export function BuildingDatabase() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const focus = useStore((s) => s.focus);
  const setPage = useStore((s) => s.setPage);
  const open = (bbl: string) => { focus(bbl); setPage("property"); };
  const [sortK, setSortK] = useState<string>("sf");
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [cls, setCls] = useState<string>("all");
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const out: { bbl: string; addr: string; cls: string; sf: number; fl: number; yr: number;
                 owner: string; occ: number; known: boolean; rent: number; noi: number; dmd: number; val: number; psf: number }[] = [];
    for (const bbl in parcels) {
      const rec = resolveRec(parcels, game, bbl);
      if (!rec || rec.class === "land" || !rec.bldgArea) continue;
      const h = game.holdings[bbl];
      // NOBODY IS CALLED "PRIVATE". Rival firms have names and so, now, does
      // every private holder in the register — which is the whole point of it:
      // a list of the fifty biggest buildings in town used to be fifty rows of
      // the same word.
      const own = h ? "You" : (ownerOf(game, bbl)?.name ?? holderOf(game, parcels, bbl)?.name ?? "private");
      // Your own buildings price on the condition you have actually let them
      // drift to; everyone else's on the street's grade, as before.
      const cond = h?.condition ?? gradeOf(game, rec);
      const val = assetValue(rec, game.econ, cond);
      // In-place rent where a roll exists — your own commercial leases,
      // weighted by the square feet each one covers — and the market's
      // estimate for the rest of town, which is the same model the engine
      // signs leases at. A mixed-use roll reads its commercial paper only;
      // the flats have no individual leases to read.
      const rollSf = h ? h.tenants.reduce((a, t) => a + t.sf, 0) : 0;
      const rent = h && rollSf > 0
        ? h.tenants.reduce((a, t) => a + t.rentPsf * t.sf, 0) / rollSf
        : marketRentPsfYr(rec, game.econ, cond);
      // NOI from the actual roll wherever there is one — yours, or the one the
      // seller has disclosed on a building that is for sale. For the rest of
      // the town's stock, which nobody has shown you and you cannot buy, it is
      // the market model net of the tax a buyer would carry at this value.
      const ip = inPlace(rec, game, bbl, val);
      const noi = ip.noi;
      out.push({
        bbl, addr: rec.address, cls: rec.class, sf: rec.bldgArea, fl: rec.floors,
        yr: rec.yearBuilt, owner: own,
        occ: ip.occ, known: ip.disclosed,
        rent, noi,
        dmd: Math.round(rec.demandScore + (game.blockD?.[rec.block] ?? 0)),
        val, psf: val / Math.max(1, rec.bldgArea),
      });
    }
    return out;
  }, [parcels, game]);
  const shown = useMemo(() => {
    let r = rows;
    if (cls !== "all") r = r.filter((x: (typeof rows)[number]) => x.cls === cls);
    if (q.trim()) { const t = q.trim().toLowerCase(); r = r.filter((x: (typeof rows)[number]) => x.addr.toLowerCase().includes(t) || x.owner.toLowerCase().includes(t)); }
    const k = sortK as keyof (typeof rows)[number];
    return [...r].sort((a, b) => {
      const av = a[k], bv = b[k];
      return (typeof av === "string" ? (av as string).localeCompare(bv as string) : (av as number) - (bv as number)) * dir;
    });
  }, [rows, sortK, dir, cls, q]);
  const H = ({ k, label, num }: { k: string; label: string; num?: boolean }) => (
    <th className={num ? "num" : undefined} style={{ cursor: "pointer", whiteSpace: "nowrap" }}
        onClick={() => { if (sortK === k) setDir((d) => (d === 1 ? -1 : 1)); else { setSortK(k); setDir(-1); } }}>
      {label}{sortK === k ? (dir === -1 ? " ▾" : " ▴") : ""}
    </th>
  );
  const CAP = 250;
  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 6 }}>
        {["all", "office", "retail", "multifamily", "industrial"].map((c) => (
          <button key={c} className={"btn" + (cls === c ? " btn-on" : "")} onClick={() => setCls(c)}>
            {c === "all" ? `All · ${rows.length}` : c}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="address or owner…"
          style={{ flex: 1, minWidth: 120, background: "transparent", border: "1px solid rgba(120,100,70,0.35)",
                   borderRadius: 4, padding: "4px 8px", font: "inherit", color: "inherit" }}
        />
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <H k="addr" label="Address" />
            <H k="cls" label="Class" />
            <H k="sf" label="SF" num />
            <H k="fl" label="Fl" num />
            <H k="yr" label="Built" num />
            <H k="occ" label="Occ" num />
            <H k="rent" label="Rent $/sf" num />
            <H k="noi" label="NOI / yr" num />
            <H k="dmd" label="Demand" num />
            <H k="val" label="Value" num />
            <H k="psf" label="$/sf" num />
            <H k="owner" label="Owner" />
          </tr>
        </thead>
        <tbody>
          {shown.slice(0, CAP).map((r: (typeof rows)[number]) => (
            <tr key={r.bbl} onClick={() => open(r.bbl)} onKeyDown={(e) => { if (e.key === "Enter") open(r.bbl); }}
              tabIndex={0} title={`Open the property file for ${r.addr}`} style={{ cursor: "pointer" }}>
              <td>{r.addr} <span className="dim">· Open →</span></td>
              <td className="dim">{r.cls}</td>
              <td className="num">{Math.round(r.sf).toLocaleString()}</td>
              <td className="num">{r.fl}</td>
              <td className="num">{r.yr || "—"}</td>
              {/* A tilde and a dimmed cell where the number is the class
                  model's read rather than a roll somebody showed you. The two
                  used to look identical in this column, which is how an
                  estimate gets mistaken for a measurement. */}
              <td className={"num" + (r.known ? "" : " dim")}
                  title={r.known ? "Off the rent roll." : "The class average — nobody has shown you this building's roll."}>
                {r.known ? "" : "~"}{(r.occ * 100).toFixed(0)}%
              </td>
              <td className="num">${r.rent.toFixed(0)}</td>
              <td className={"num" + (r.noi < 0 ? " neg" : "")}>{usd(r.noi)}</td>
              <td className="num">{r.dmd}</td>
              <td className="num">{usd(r.val)}</td>
              <td className="num">${r.psf.toFixed(0)}</td>
              <td className={r.owner === "You" ? undefined : "dim"}>{r.owner}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length > CAP && (
        <div className="hint">Showing {CAP} of {shown.length.toLocaleString()} — narrow it with the class buttons or the search box.</div>
      )}
    </div>
  );
}


export function NewsText({ text }: { text: string }) {
  const parcels = useStore((s) => s.parcels);
  const focus = useStore((s) => s.focus);
  const index = useMemo(() => {
    const m = new Map<string, string>();
    for (const [bbl, rec] of Object.entries(parcels ?? {})) {
      if (rec?.address) m.set(rec.address, bbl);
    }
    return m;
  }, [parcels]);

  const out: React.ReactNode[] = [];
  // A house number, then one to four words — the shape every address in this
  // generator takes ("30 Salem Row", "36 W 12th St").
  const re = /\d[\w'’.-]*(?:\s+[A-Za-z][\w'’.-]*){1,4}/g;
  let last = 0;
  for (let mt = re.exec(text); mt; mt = re.exec(text)) {
    const words = mt[0].split(/\s+/);
    let hit: string | null = null;
    for (let n = words.length; n >= 2; n--) {
      const s = words.slice(0, n).join(" ");
      if (index.has(s)) { hit = s; break; }
    }
    if (!hit) continue;
    if (mt.index > last) out.push(text.slice(last, mt.index));
    const bbl = index.get(hit)!;
    const label = hit;
    out.push(
      <button
        key={`${mt.index}-${bbl}`}
        className="news-link"
        title="Go to it"
        onClick={(ev) => { ev.stopPropagation(); focus(bbl, true); }}
      >{label}</button>,
    );
    last = mt.index + hit.length;
    re.lastIndex = last;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/**
 * THE TAPE'S COLUMNS, IN ONE PLACE so the header and the comparator cannot
 * disagree about what a column is. `desc` is the direction a column opens on
 * when you first click it — the one a buyer wants first. Nobody sorts ascending
 * by cap rate to find the best yield.
 */
export const MARKET_COLS: { key: string; label: string; num?: boolean; desc?: boolean }[] = [
  { key: "addr", label: "Property" },
  { key: "cls", label: "Class" },
  { key: "area", label: "Building", num: true, desc: true },
  { key: "ask", label: "Ask", num: true, desc: true },
  { key: "psf", label: "$/sf", num: true },
  { key: "noi", label: "NOI / yr", num: true, desc: true },
  { key: "cap", label: "Cap rate", num: true, desc: true },
  { key: "occ", label: "Occupancy", num: true, desc: true },
  { key: "dmd", label: "Demand", num: true, desc: true },
];

export function MarketPage() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const lens = useStore((s) => s.lens);
  const setLens = useStore((s) => s.setLens);
  const focus = useStore((s) => s.focus);
  const setPage = useStore((s) => s.setPage);
  const go = (bbl: string) => { focus(bbl); setPage("property"); };
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  // null = follow the docket (open when one is live), true/false = you decided.
  const [distressOpen, setDistressOpen] = useState<boolean | null>(null);
  const [expandedBook, setExpandedBook] = useState<string | null>(null);
  // YOUR OWN SIGN IN THE WINDOW. A building you have listed is for sale in the
  // same town, on the same tape, and leaving it off meant the one screen that
  // answers "what is on the market" was answering it incompletely — and you
  // could not see your own ask sitting next to the competition's.
  const mine = Object.values(game.holdings)
    .filter((h) => h.sale)
    .map((h) => ({ bbl: h.bbl, ask: h.sale!.ask, mine: true as const, distress: false, reason: undefined, sale: h.sale! }));
  const live = game.listings.length + mine.length;
  const distress = game.listings.filter((l) => l.distress).length;
  const frames = game.listings.filter((l) => l.halfBuilt).length;
  // Street / REO packages — not the player's own portfolioSale. These are the
  // books banks put out after a seizure; they used to raise an alert with no desk.
  const streetBooks = (game.portfolios ?? []).filter((p) => !p.player);
  const bankFcls = game.bankFcls ?? [];
  const { buyStreetBook } = useStore.getState();
  return (
    <div>
      <div className="stat-strip">
        <Big label="On the market" value={String(live)} />
        <button
          className={"btn" + (lens === "listings" ? " btn-on" : "")}
          style={{ alignSelf: "center" }}
          title="Highlight every listing on the map — red lots, pins on roofs"
          onClick={() => setLens(lens === "listings" ? "none" : "listings")}
        >
          {lens === "listings" ? "Map highlight on" : "Highlight on map"}
        </button>
        <Big label="Motivated sellers" value={String(distress)} bad={distress > 0} />
        <Big label="Books for sale" value={String(streetBooks.length)} bad={streetBooks.length > 0}
          title="Receiver packages and fund wind-downs — one cheque for the whole book" />
        <Big label="Half-built frames" value={String(frames)} />
        <Big label="Money in the room" value={
          marketAppetite(game) < 0.6 ? "gone" : marketAppetite(game) < 0.9 ? "thin"
            : marketAppetite(game) > 1.15 ? "everywhere" : "normal"} />
        <button
          className="btn"
          style={{ alignSelf: "center" }}
          title="Broker calls and the July auction card are firm settings — change them under Settings."
          onClick={() => useStore.getState().setPage("settings")}
        >
          {game.brokersOff ? "Brokers: off" : "Brokers: on"}
          {" · "}
          {game.auctionQuiet ? "Auction card: off" : "Auction card: on"}
          {" →"}
        </button>
      </div>
      <div className="hint">
        Everything for sale in town — single buildings on the tape, receiver books and fund wind-downs as packages,
        foreclosure lots on the July docket, and distressed notes under Notes. A motivated seller is priced under
        appraisal and will not last. What the market is DOING — cap rates, the trades, comps — is on Research.
      </div>

      {/* BOOKS FOR SALE — the desk the seizure alert always pointed at and never reached.
          Packages live on game.portfolios (REO / fund wind-down). They are pulled off the
          single-asset tape on purpose; buying them is one cash cheque via buyStreetBook. */}
      <div className="page-section" style={{ marginTop: 10 }}>
        Books for sale · {streetBooks.length}
      </div>
      {streetBooks.length === 0 ? (
        <div className="hint dim" style={{ marginBottom: 10 }}>
          No receiver books on the market. When a firm fails with four or more deeds, the lead lender puts the
          whole relationship out as one package here — priced to clear the balance sheet, walking down every quarter
          until somebody writes the cheque. Distressed paper (claims on a building, not the deed) is on Notes.
        </div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          <div className="hint" style={{ marginBottom: 8 }}>
            One cheque, all cash, no financing at the table — that is why a package trades back from the sum of its
            parts. Rivals are looking at the same books; a quiet month is how you lose them.
          </div>
          {streetBooks.map((p) => {
            const disc = p.gross > 0 ? (1 - p.ask / p.gross) * 100 : 0;
            const closing = Math.round(p.ask * 0.02);
            const need = p.ask + closing;
            const short = Math.max(0, need - game.cash);
            const open = expandedBook === p.id;
            const seller = p.sellerLender
              ?? (p.sellerId ? (game.rivals?.find((r) => r.id === p.sellerId)?.name ?? "A fund") : "A seller");
            // Income, occupancy, yield — the numbers a buyer underwrites before
            // the discount means anything. See streetBookStats.
            const st = streetBookStats(game, parcels, p);
            const mix = st.byClass
              .filter((c) => c.cls !== "land")
              .slice(0, 4)
              .map((c) => `${c.n} ${c.cls === "multifamily" ? "apt" : c.cls.slice(0, 3)}`)
              .join(" · ");
            const basisHint = st.basis === "receiver"
              ? "NOI and occupancy are underwritten worn at the borrower's book occupancy — the same basis the foreclosure docket uses, not a clean appraisal."
              : st.basis === "disclosed"
                ? "NOI and occupancy come off disclosed rent rolls."
                : st.basis === "mixed"
                  ? "Some buildings have disclosed rolls; the rest are underwritten on the market model or a receiver basis."
                  : "No rent roll has been disclosed — NOI and occupancy are the market model at street grade.";
            const monthsOut = Math.max(0, game.month - p.listedM);
            return (
              <div key={p.id} className="deal" style={{ marginBottom: 8 }}>
                <div className="deal-head" style={{ cursor: "pointer" }}
                  onClick={() => setExpandedBook(open ? null : p.id)}>
                  <span className="dim" style={{ marginRight: 6 }}>{open ? "▾" : "▸"}</span>
                  {p.reo ? "REO · " : ""}{p.bbls.length} buildings
                  {p.reoBorrower ? ` off ${p.reoBorrower}` : ""} · {seller}
                  {st.occ !== null && (
                    <span className={"mono" + (st.occ < 0.7 ? " neg" : "")} style={{ marginLeft: 10 }}>
                      {(st.occ * 100).toFixed(0)}% occ
                    </span>
                  )}
                  {st.yieldOnAsk !== null && (
                    <span className="mono dim" style={{ marginLeft: 8 }}>
                      {pct(st.yieldOnAsk * 100)} on ask
                    </span>
                  )}
                </div>
                <div className="grid">
                  <Row k="Ask" v={usd(p.ask)} strong />
                  <Row k="Sum of the parts" v={usd(p.gross)} />
                  <Row k="Inside the parts" v={`${disc.toFixed(0)}% back`} bad={disc > 8} />
                  <Row
                    k="Occupancy"
                    v={st.occ !== null ? `${(st.occ * 100).toFixed(0)}% · ${sf(st.leasedSf)} of ${sf(st.totSf)}` : "—"}
                    bad={st.occ !== null && st.occ < 0.7}
                  />
                  <Row
                    k="NOI / yr"
                    v={usd(st.noi)}
                    bad={st.noi <= 0}
                    title={basisHint}
                  />
                  <Row
                    k="Going-in on ask"
                    v={st.yieldOnAsk !== null ? pct(st.yieldOnAsk * 100) : "—"}
                    strong={st.yieldOnAsk !== null && st.yieldOnAsk > 0.08}
                    title="In-place NOI ÷ package ask — the yield the cash cheque buys today"
                  />
                  <Row
                    k="Cap on appraisal"
                    v={st.yieldOnGross !== null ? pct(st.yieldOnGross * 100) : "—"}
                    title="Same NOI against the sum of the parts — what the discount is buying you"
                  />
                  <Row k="Building area" v={st.totSf ? sf(st.totSf) : "sites only"} />
                  {st.askPsf !== null && <Row k="Ask / sf" v={`$${st.askPsf.toFixed(0)}`} />}
                  {mix && <Row k="Mix" v={mix} />}
                  <Row
                    k="On the market"
                    v={monthsOut === 0 ? monthLabel(p.listedM) : `${monthsOut} mo · since ${monthLabel(p.listedM)}`}
                  />
                  {p.cuts > 0 && <Row k="Price cuts" v={`${p.cuts} — walking down every quarter`} bad />}
                </div>
                <div className="hint" style={{ marginTop: 4 }}>{p.reason}</div>
                <div className="hint dim" style={{ marginTop: 2 }}>{basisHint}</div>
                {open && (
                  <table className="tbl" style={{ marginTop: 8 }}>
                    <thead>
                      <tr>
                        <th>Property</th>
                        <th>Class</th>
                        <th className="num">Area</th>
                        <th className="num">Occ</th>
                        <th className="num">NOI / yr</th>
                        <th className="num">Appraisal</th>
                        <th className="num">Share of ask</th>
                        <th className="num">Cap on share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {st.assets.map((a) => {
                        const shareCap = a.askShare > 0 && !a.land ? (a.noi / a.askShare) * 100 : null;
                        return (
                          <tr key={a.bbl} style={{ cursor: "pointer" }} onClick={() => go(a.bbl)}>
                            <td>{a.address}</td>
                            <td className="dim">{a.land ? "land" : a.cls}{a.floors ? ` · ${a.floors}fl` : ""}</td>
                            <td className="num">{a.land ? "—" : sf(a.sf)}</td>
                            <td className={"num" + (!a.land && a.occ < 0.7 ? " neg" : "")}>
                              {a.land ? "—" : `${(a.occ * 100).toFixed(0)}%`}
                            </td>
                            <td className={"num" + (a.noi <= 0 && !a.land ? " neg" : "")}>
                              {a.land ? "—" : usd(a.noi)}
                            </td>
                            <td className="num">{usd(a.val)}</td>
                            <td className="num">{usd(a.askShare)}</td>
                            <td className="num">{shareCap !== null ? pct(shareCap) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button
                    className="btn btn-buy"
                    disabled={short > 0}
                    title={short > 0
                      ? `Need ${usd(need)} including 2% closing — short ${usd(short)}`
                      : `${usd(p.ask)} plus ~${usd(closing)} closing, all cash`
                        + (st.yieldOnAsk !== null ? ` · ${pct(st.yieldOnAsk * 100)} going-in` : "")}
                    onClick={() => buyStreetBook(p.id)}
                  >
                    Buy the book · {usd(p.ask)}
                    {st.yieldOnAsk !== null ? ` · ${pct(st.yieldOnAsk * 100)}` : ""}
                  </button>
                  <button className="btn" onClick={() => setExpandedBook(open ? null : p.id)}>
                    {open ? "Hide schedule" : "See the schedule"}
                  </button>
                  {short > 0 && (
                    <span className="dim">Short {usd(short)} of the {usd(need)} cheque.</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* THE DOCKET, WHEREVER THE CARD SETTING STANDS. Foreclosure lots are the
          one thing on the tape nobody chose to sell, and they are gone in a
          month — so they live at the TOP of the page while they are live, and
          the button opens the same bidding sheet the card shows. */}
      {/* FORECLOSURES NEED A PLACE THAT IS ALWAYS THERE.
          The docket is published in July and the hammer falls the month after,
          so this block existed for ONE MONTH IN TWELVE and was invisible the
          other eleven — which is why the answer to "where do I buy a
          foreclosure" was that there was nowhere to look. Distress is not an
          annual event, it is a pipeline: loans go on watch, then into workout,
          then to the steps, and a buyer who wants the steps wants to have been
          watching the pipeline. So the section is permanent. It shows the
          docket when there is one and what is heading toward it when there is
          not, and it always says when the next one is called. */}
      {(() => {
        const liveDocket = game.auction && game.month < game.auction.m;
        // The county calls the list in July; the hammer falls the month after.
        const nextDocket = game.month + ((6 - (game.month % 12)) + 12) % 12 || 12;
        const loans = Object.values(game.cityLoans ?? {});
        const inWorkout = loans.filter((l) => l.status === "workout");
        const onWatch = loans.filter((l) => l.status === "watch");
        // COLLAPSIBLE, AND OPEN WHEN IT MATTERS. Opens on a live docket, when
        // banks have noticed sales, or when a receiver book is upstairs —
        // otherwise eleven months of watchlist stays tucked away.
        const open = distressOpen ?? !!(liveDocket || bankFcls.length || streetBooks.length);
        return (
          <div className="deal" style={{ marginBottom: 10 }}>
            <div className="deal-head" style={{ cursor: "pointer", userSelect: "none" }}
              title={open ? "Collapse" : "Expand"}
              onClick={() => setDistressOpen(!open)}>
              <span className="dim" style={{ marginRight: 6 }}>{open ? "▾" : "▸"}</span>
              {liveDocket
                ? `The county foreclosure docket · ${game.auction!.lots.length} lot${game.auction!.lots.length === 1 ? "" : "s"} · the hammer falls ${monthLabel(game.auction!.m)}`
                : `Distress pipeline · ${bankFcls.length} noticed for sale, ${inWorkout.length} in workout, ${onWatch.length} on watch · next docket ${monthLabel(nextDocket)}`}
            </div>
            {!open ? null : liveDocket ? (
              <>
                <div className="hint">
                  As-is, ten per cent down the day you register, no financing and no warranty. Nobody on this list
                  chose to sell. Receiver <b>books</b> (whole relationships) are under Books for sale above —
                  this docket is single lots.
                </div>
                <button className="btn btn-buy" onClick={() => useStore.getState().setAuctionOpen(true)}>
                  Open the docket
                </button>
              </>
            ) : (
              <>
                <div className="hint">
                  Nothing is on the steps this month. The county calls its list every July and sells the month
                  after. A loan goes on <b>watch</b>, into <b>workout</b>, then a bank <b>notices a sale</b>
                  toward the docket. Whole books seized from failed firms are under Books for sale above —
                  not here — because a package is one cheque, not a courthouse lot.
                </div>
                {bankFcls.length > 0 && (
                  <>
                    <div className="page-section" style={{ marginTop: 8 }}>Noticed for the courthouse · {bankFcls.length}</div>
                    <div className="mini-list">
                      {bankFcls.slice(0, 12).map((f) => {
                        const rec = resolveRec(parcels, game, f.bbl);
                        return (
                          <button key={`${f.bbl}:${f.noticedM}`} className="neighbor" onClick={() => go(f.bbl)}>
                            <span className="neighbor-addr">{rec?.address ?? f.bbl}</span>
                            <span className="neighbor-meta mono">
                              {f.lender} · {f.firm} · {usd(f.debt)} debt · sale {monthLabel(f.saleM)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                {inWorkout.length > 0 && (
                  <>
                    <div className="page-section" style={{ marginTop: 8 }}>In workout · {inWorkout.length}</div>
                    <div className="mini-list">
                      {inWorkout.slice(0, 8).map((l) => {
                        const rec = resolveRec(parcels, game, l.bbl);
                        return (
                          <button key={l.bbl} className="neighbor" onClick={() => go(l.bbl)}>
                            <span className="neighbor-addr">{rec?.address ?? l.bbl}</span>
                            <span className="neighbor-meta mono">
                              {l.lender} · {usd(l.balance)} against {usd(l.origValue)} at origination
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                {bankFcls.length === 0 && inWorkout.length === 0 && onWatch.length === 0 && (
                  <div className="hint dim">Nothing in town is even on watch. That is what a good market looks like, and it does not last.</div>
                )}
              </>
            )}
          </div>
        );
      })()}
      {/* THE PHONE, ABOVE THE TAPE. An off-market file is the one thing on this
          page that nobody else can bid on and the one thing that disappears on
          a schedule; the listings will still be there next month. */}
      <BrokerCalls />
      <div className="deals-grid">
        <section style={{ gridColumn: "1 / -1" }}>
          <div className="page-section" style={{ marginTop: 14 }}>On the market · {live}{mine.length ? ` · ${mine.length} of them yours` : ""}</div>
          <table className="tbl">
            <thead>
              <tr>
                {MARKET_COLS.map((c) => {
                  const on = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      className={(c.num ? "num" : "") + " th-sort" + (on ? " th-sort-on" : "")}
                      title={`Sort by ${c.label}`}
                      onClick={() => setSort(
                        on ? { key: c.key, dir: sort!.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.desc ? -1 : 1 },
                      )}
                    >
                      {c.label}{on ? (sort!.dir === 1 ? " ▲" : " ▼") : ""}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* THE DEFAULT IS STILL THE WAY A BUYER READS A TAPE: income
                  first, best going-in yield at the top, then the dirt by price
                  per foot. Sorting the whole thing by asking price buried every
                  building that made money under fourteen rows of vacant lots,
                  which is why that default exists and why clicking a header
                  REPLACES it rather than being the only order available. */}
              {[...game.listings, ...mine].map((li) => {
                const rec = resolveRec(parcels, game, li.bbl);
                const built = !!rec && rec.class !== "land" && rec.bldgArea > 0;
                const cap = built && li.ask > 0
                  ? inPlace(rec!, game, li.bbl, li.ask).noi / li.ask : -1;
                const psf = rec ? li.ask / Math.max(1, built ? rec.bldgArea : rec.lotArea) : Infinity;
                // Every sortable value is computed ONCE here, so the comparator
                // never recomputes an in-place roll and the column you sort on
                // is the same number the cell prints.
                const v: Record<string, number | string> = {
                  addr: rec?.address ?? "",
                  cls: rec ? useLabel(rec) : "",
                  area: rec ? (built ? rec.bldgArea : rec.lotArea) : 0,
                  ask: li.ask,
                  psf,
                  noi: built && rec ? inPlace(rec, game, li.bbl, li.ask).noi : -1,
                  cap: built ? cap * 100 : -1,
                  occ: built && rec ? (inPlace(rec, game, li.bbl, li.ask).occ ?? 0) : -1,
                  dmd: rec ? demandNow(game, rec) : -1,
                };
                return { li, built, cap, psf, v };
              }).sort((a, b) => {
                if (sort) {
                  const x = a.v[sort.key], y = b.v[sort.key];
                  const c = typeof x === "string" || typeof y === "string"
                    ? String(x).localeCompare(String(y)) : (x as number) - (y as number);
                  if (c !== 0) return c * sort.dir;
                }
                return a.built === b.built
                  ? (a.built ? b.cap - a.cap : a.psf - b.psf)
                  : (a.built ? -1 : 1);
              }).map(({ li }) => {
                const rec = resolveRec(parcels, game, li.bbl);
                if (!rec) return null;
                const built = rec.class !== "land" && rec.bldgArea > 0;
                // THE TAPE SORTS ITSELF ON THIS NUMBER — "income first, best
                // going-in" — so a quoted cap computed off a market estimate
                // did not merely mislead, it RANKED. Measured over 3,195
                // listings, the estimate was flat across cap-rate quartiles
                // (93/90/87/87% occupancy) while the actual roll collapsed
                // (83/80/67/46%): the quoted yield was high precisely BECAUSE
                // the estimate was wrong, so the default view put the most
                // overstated buildings at the top of the page. In place off
                // the disclosed roll, the sort is now a sort on income.
                const ip = built ? inPlace(rec, game, li.bbl, li.ask) : null;
                const noi = ip?.noi ?? 0;
                const goingIn = built && li.ask > 0 ? (noi / li.ask) * 100 : 0;
                const yours = "mine" in li;
                const h = yours ? game.holdings[li.bbl] : null;
                const held = yours ? null : holderOf(game, parcels, li.bbl);
                const notToYou = !!held && isCold(game, held.id);
                return (
                  <tr key={li.bbl} onClick={() => go(li.bbl)}
                    onKeyDown={(e) => { if (e.key === "Enter") go(li.bbl); }}
                    tabIndex={0}
                    title={notToYou
                      ? `${rec.address} — on the tape, but ${held!.name} will not sell to you`
                      : `Open the property file for ${rec.address}`}
                    className={yours ? "row-mine" : notToYou ? "row-cold" : undefined}>
                    <td>
                      {"earlyUntilM" in li && li.earlyUntilM !== undefined && game.month < li.earlyUntilM && (
                        <span className="chip chip-distress" style={{ marginRight: 6 }}
                          title={`${game.brokerRel?.[li.via ?? ""]?.name ?? "A house broker"} rang you before the tape — yours alone until then`}>
                          FIRST LOOK
                        </span>
                      )}
                      {li.distress && <span className="chip chip-distress" style={{ marginRight: 6 }}>HOT</span>}
                      {li.reason && (
                        <span className="chip" style={{ marginRight: 6 }}>
                          {li.reason === "merchant" ? "MERCHANT EXIT"
                            : li.reason === "fund-life" ? "FUND CLOCK"
                              : li.reason === "estate" ? "ESTATE"
                                : li.reason === "receiver" ? "RECEIVER" : "VOLUNTARY"}
                        </span>
                      )}
                      {yours && <span className="chip" style={{ marginRight: 6 }}>YOURS</span>}
                      {notToYou && (
                        <span className="chip chip-cold" style={{ marginRight: 6 }} title={held!.name}>
                          NOT TO YOU
                        </span>
                      )}
                      {rec.address}
                      <span className="dim"> · Open →</span>
                      {yours && h?.sale?.bids && h.sale.bids.length > 0 && (
                        <span className="dim mono"> · {h.sale.bids.length} bid{h.sale.bids.length === 1 ? "" : "s"} · best {usd(h.sale.bids[0].price)}</span>
                      )}
                      {yours && h?.sale?.offer && !(h.sale.bids && h.sale.bids.length) && (
                        <span className="dim mono"> · {usd(h.sale.offer.price)} offered</span>
                      )}
                      {yours && h?.sale && !h.sale.offer && !(h.sale.bids && h.sale.bids.length) && (
                        <span className="dim">
                          {h.sale.callM !== undefined ? " · book is out" : " · no offers yet"}
                        </span>
                      )}
                    </td>
                    <td>{useLabel(rec)}</td>
                    <td className="num">{built ? sf(rec.bldgArea) : sf(rec.lotArea) + " lot"}</td>
                    <td className="num">{usd(li.ask)}</td>
                    <td className="num">{built ? "$" + Math.round(li.ask / Math.max(1, rec.bldgArea)) : "$" + Math.round(li.ask / Math.max(1, rec.lotArea))}</td>
                    <td className="num">{built ? usd(noi) : "—"}</td>
                    <td className="num">{built ? goingIn.toFixed(2) + "%" : "—"}</td>
                    {/* THE BUILDING'S OCCUPANCY, AND IT IS A FACT.
                        This column used to be the CITY'S — occupancy(rec, econ),
                        the class model — because "you have not seen inside a
                        building you do not own". That was true of the old
                        engine and it was never true of the business: a building
                        on the market comes with a rent roll, it is the first
                        page of the offering memorandum, and a buyer who is not
                        given one walks. The roll is written the day the
                        building is listed and it is the roll the deed conveys
                        (Listing.roll), so the honest number was sitting on the
                        listing object this cell was ignoring. Measured, the
                        model read 89% where the rolls ran 69%. */}
                    <td className={"num" + (ip?.disclosed ? "" : " dim")}
                        title={ip?.disclosed ? "Off the disclosed rent roll — this is what the deed conveys."
                          : "The class average — nobody has shown you this building's roll."}>
                      {built ? (ip?.disclosed ? "" : "~") + ((ip?.occ ?? 0) * 100).toFixed(0) + "%" : "—"}
                    </td>
                    {/* DEMAND, WHERE "vs appraisal" USED TO BE. The appraisal
                        gap was a derived opinion about price sitting on a page
                        whose whole job is prices — and the number a buyer
                        actually cannot get anywhere else on this row is what
                        the neighbourhood is doing. `demandNow` is the engine's
                        own reader, the same one the parcel card and the
                        building database use, so the three cannot drift. */}
                    <td className="num" title="The block's demand score right now — the same number the parcel card shows.">
                      {Math.round(demandNow(game, rec))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

/**
 * WHAT THE DIRT HAS DONE, and what the city underneath it has done.
 *
 * Land is the only asset in this game you can hold without operating, and it
 * was the one thing with no chart: the index moved every month, it drove every
 * appraisal and every development pro forma, and the only way to read it was
 * to click a lot and squint at a number. A land cycle is slower and larger
 * than a rent cycle — it is the one that makes and unmakes fortunes — and it
 * deserves the same graph the sectors get.
 *
 * Beneath it, the economy the property market sits on. Rents are downstream of
 * jobs and jobs are downstream of whether anybody wants to live here, and none
 * of that was visible either.
 */
export function LandValueChart() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const h = game.econ.history ?? [];
  if (h.length < 4) return <div className="hint">Not enough history yet — advance a few years.</div>;
  const e = game.econ;

  // Today's land price per foot across the city, and at the best ground in it —
  // the spread between them is what "location" is worth in dollars.
  const psf = Object.keys(parcels).map((b) => {
    const rec = resolveRec(parcels, game, b);
    return rec && rec.lotArea > 0 ? { psf: landPsfNow(rec, e), d: rec.demandScore } : null;
  }).filter(Boolean) as { psf: number; d: number }[];
  psf.sort((a, b) => a.psf - b.psf);
  const q = (f: number) => psf.length ? psf[Math.min(psf.length - 1, Math.floor(psf.length * f))].psf : 0;
  const prime = psf.filter((x) => x.d >= 80);
  const primeAvg = prime.length ? prime.reduce((a, x) => a + x.psf, 0) / prime.length : 0;
  const fringe = psf.filter((x) => x.d <= 25);
  const fringeAvg = fringe.length ? fringe.reduce((a, x) => a + x.psf, 0) / fringe.length : 0;

  const yrs = (n: number) => h.length > n ? h[h.length - 1].landIdx / h[h.length - 1 - n].landIdx - 1 : 0;

  return (
    <>
      <div className="page-section">Land</div>
      <div className="hint">
        The only thing here you can own without operating it, and the slowest, largest cycle in the game.
        Every appraisal and every development budget is a function of this line.
      </div>
      {/* NOMINAL AND REAL, ON THE SAME AXES, because the gap between them IS
          the question a land owner is actually asking. A nominal index that
          triples over fifty years of inflation has not made anybody richer,
          and land is the one asset here bought to be held for decades — the
          holding period over which the price level stops being a detail and
          becomes most of the answer. `cpi` has always been on the history
          record; nothing needed to be measured to draw this, it just was not
          being drawn. */}
      <LineChart
        height={150}
        series={[
          { label: "Land index (nominal)", color: "#b08d3f", pts: h.map((p) => p.landIdx) },
          { label: "in today's money", color: "#6d8fa8",
            pts: h.map((p) => p.landIdx / Math.max(0.01, (p.cpi ?? 1) / (h[h.length - 1].cpi ?? 1))) },
        ]}
        yFmt={(v) => v.toFixed(2)}
        xLabels={[monthLabel(h[0].q), monthLabel(h[h.length - 1].q)]}
      />
      {(() => {
        // The one number that says whether holding dirt was worth doing.
        const first = h[0], last = h[h.length - 1];
        const yrsAll = Math.max(1, (last.q - first.q) / 12);
        const realNow = last.landIdx, realThen = first.landIdx * ((last.cpi ?? 1) / (first.cpi ?? 1));
        const realCagr = Math.pow(realNow / Math.max(0.01, realThen), 1 / yrsAll) - 1;
        return (
          <div className="hint">
            Since {monthLabel(first.q)}, land is up {((last.landIdx / first.landIdx - 1) * 100).toFixed(0)}% in cash
            and {realCagr >= 0 ? "up" : "down"} {Math.abs(realCagr * 100).toFixed(2)}% a year <b>after inflation</b>.
            The second number is the one a fifty-year hold is actually paid in.
          </div>
        );
      })()}
      <div className="grid">
        <Row k="Land index" v={e.landIdx.toFixed(2)} strong />
        <Row k="Over the last year" v={`${yrs(12) >= 0 ? "+" : ""}${(yrs(12) * 100).toFixed(1)}%`} bad={yrs(12) < 0} />
        <Row k="Over the last five" v={`${yrs(60) >= 0 ? "+" : ""}${(yrs(60) * 100).toFixed(1)}%`} bad={yrs(60) < 0} />
        <Row k="Over the last twenty" v={`${yrs(240) >= 0 ? "+" : ""}${(yrs(240) * 100).toFixed(1)}%`} bad={yrs(240) < 0} />
        <Row k="Cheapest quarter of the city" v={`$${q(0.25).toFixed(0)} /sf of lot`} />
        <Row k="Median lot" v={`$${q(0.5).toFixed(0)} /sf of lot`} strong />
        <Row k="Dearest tenth" v={`$${q(0.9).toFixed(0)} /sf of lot`} />
        <Row
          k="Prime against fringe"
          v={fringeAvg > 0 ? `${(primeAvg / fringeAvg).toFixed(1)}x — $${primeAvg.toFixed(0)} against $${fringeAvg.toFixed(0)}` : "—"}
        />
      </div>

      {/* THE CITY'S OWN SERIES USED TO BE PRINTED HERE TOO — population, jobs,
          unemployment, the real wage — because on Research this was the only
          place they appeared. Two copies of one series on one page is how a
          reader comes to take a level off one chart and a date off the other,
          so the CHARTS are gone from here and live on the "The city" card one
          click away, which draws all six with their deflation done and their
          notes attached, on the same window switch as everything else.
          The eight ROWS under those charts went with them and should not have:
          a line says which way and how fast and cannot say how many people are
          in the town this month. They are restored on that same card as
          `CityFigures` — the correct destination, since the deltas are struck
          off the history the charts there draw — and not duplicated here. */}
    </>
  );
}
