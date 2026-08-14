import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { headlineEpithet } from "@/engine/firm";
import { useStore, type Page } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { currentCity, currentSeed } from "@/state/city";
import { locLimit } from "@/engine/credit";
import { isLeasedFee, netWorth, resolveRec } from "@/engine/value";
import { useSf } from "@/engine/mix";
import { firmBookStress, portfolioMonthlyCF } from "@/engine/sim";
import { loiNeedsPrincipal } from "@/engine/leasing";
import { usd, pct } from "./format";
import { liveBrokerCalls } from "./RightPanel";

type JobId = "acquire" | "assets" | "capital" | "world" | "economy";

const JOBS: {
  id: JobId;
  label: string;
  pages: readonly { id: Page; label: string; note: string }[];
}[] = [
  {
    id: "acquire",
    label: "Acquire",
    pages: [
      { id: "market", label: "Marketplace", note: "Listings, receiver books, auctions and off-market calls" },
      { id: "deals", label: "Deals", note: "LOIs, negotiations and contracts" },
      { id: "notes", label: "Notes", note: "Distressed paper — claims on buildings, not the deed" },
    ],
  },
  {
    id: "assets",
    label: "Assets",
    pages: [
      { id: "portfolio", label: "Portfolio", note: "Holdings, income and concentration" },
      { id: "leasing", label: "Leasing", note: "Occupancy, expirations and mandate" },
      { id: "staff", label: "Staff", note: "People, capacity and judgment" },
    ],
  },
  {
    id: "capital",
    label: "Capital",
    pages: [
      { id: "debt", label: "Debt", note: "Loans, line and the maturity wall" },
      { id: "books", label: "Books", note: "Cash movement and the ledger" },
    ],
  },
  {
    id: "world",
    label: "World",
    pages: [
      { id: "research", label: "Research", note: "Comps, submarkets and underwriting" },
      { id: "news", label: "News", note: "What the city wrote this month" },
    ],
  },
  {
    id: "economy",
    label: "Economy",
    pages: [
      { id: "economy", label: "Economy", note: "Cycle, space markets and construction" },
    ],
  },
];

export default function TopBar() {
  const [armNewRun, setArmNewRun] = useState(false);
  const [jobOpen, setJobOpen] = useState<JobId | null>(null);
  const fpsOn = useStore((s) => s.fpsOn);
  // When the meter is off, this selector is a constant 0 — so the once-a-second
  // MapView fps write cannot re-render the whole bar (and re-walk the book).
  const fps = useStore((s) => (s.fpsOn ? s.fps : 0));
  const manifest = useStore((s) => s.manifest);
  const game = useStore((s) => s.game);
  // Cash/date stay on the live game; portfolio walks (NW/CF/line) lag one
  // paint so a counter click is not blocked on walking the whole book.
  const deferredGame = useDeferredValue(game);
  const lens = useStore((s) => s.lens);
  const setLens = useStore((s) => s.setLens);
  const mapOnly = useStore((s) => s.mapOnly);
  const setMapOnly = useStore((s) => s.setMapOnly);
  const advance = useStore((s) => s.advance);
  const advanceYear = useStore((s) => s.advanceYear);
  const advanceUntil = useStore((s) => s.advanceUntil);
  const advancing = useStore((s) => s.advancing);
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  // Portfolio walks (net worth, CF, line) only when `game` changes — not on
  // every Portfolio/Books/News click, which used to recompute them for free.
  const vitals = useMemo(() => {
    if (!deferredGame) {
      return {
        nw: 0, cf: 0, occSf: 0, occLeased: 0, vacDpp: null as number | null,
        line: 0, dealsCount: 0, unread: 0,
        bcalls: [] as ReturnType<typeof liveBrokerCalls>, bcallSoon: 0,
        notesLive: 0, booksLive: 0, debtHot: false, debtSwept: false, debtBal: 0, debtWall: 0,
      };
    }
    const parcels = useStore.getState().parcels;
    const nw = parcels ? netWorth(deferredGame, parcels) : 0;
    const cf = parcels ? portfolioMonthlyCF(deferredGame, parcels) : 0;
    const line = parcels ? locLimit(deferredGame, parcels, nw) : 0;
    // Office vacancy vs twelve months ago — the tell that predicts real rent
    // falls (~93% in century windows). Economy history already stamps vac.
    const hist = deferredGame.econ.history ?? [];
    let vacDpp: number | null = null;
    if (hist.length > 12) {
      const now = deferredGame.econ.cityVac?.office ?? 0;
      const then = hist[hist.length - 13]?.vac?.office ?? now;
      vacDpp = (now - then) * 100;
    }
    // Same book Leasing totals: operated deeds only (not coupon-only ground
    // fees), commercial tenants plus multifamily physical occupancy.
    let occSf = 0, occLeased = 0;
    if (parcels) {
      for (const h of Object.values(deferredGame.holdings)) {
        if (isLeasedFee(h)) continue;
        const rec = resolveRec(parcels, deferredGame, h.bbl);
        if (!rec || rec.class === "land" || !rec.bldgArea) continue;
        occSf += rec.bldgArea;
        const resSf = useSf(rec, "multifamily");
        occLeased += h.tenants.reduce((a, t) => a + t.sf, 0) + Math.round((h.occ ?? 0) * resSf);
      }
    }
    // Count every decision that actually lives on Deals. The badge used to
    // count only LOIs and single-building offers, so tenant relief, purchase
    // counters, contracts and portfolio bids could expire behind a clean tab.
    const loisOnDesk = deferredGame.lois.filter((l) => loiNeedsPrincipal(deferredGame, l)).length;
    const asksOnDesk = (deferredGame.asks ?? []).filter(
      (a) => !deferredGame.holdings[a.bbl]?.groundLeased,
    ).length;
    const dealsCount = loisOnDesk
      + asksOnDesk
      + Object.keys(deferredGame.talks ?? {}).length
      + (deferredGame.portfolioSale?.bids?.length ?? 0)
      + Object.values(deferredGame.holdings).filter((h) =>
        h.sale?.offer || (h.sale?.bids ?? []).some((b) => !b.dropped)).length;
    // What happened THIS MONTH that was not routine — the badge is the reason to
    // look, not a count of everything ever written.
    const unread = deferredGame.news.filter((n) =>
      n.q === deferredGame.month && (n.kind === "warn" || n.kind === "event")).length;
    // OFF-MARKET FILES WAITING, AND HOW LONG THE NEAREST ONE HAS.
    //
    // These arrived as a full-screen card until this pass, which meant the player
    // could not miss one and did not need a badge. On a page they can, and the
    // engine drops an approach twelve months after it lands whether or not
    // anybody read it — so a list with no signal would turn a file with a clock
    // on it into free optionality, which is a difficulty dial wearing a UI
    // change's clothes. Counted the same way News counts: what wants an answer,
    // not what exists. The tooltip carries the soonest lapse, because "3" tells
    // you there is something and not whether it is urgent.
    const bcalls = liveBrokerCalls(deferredGame);
    const bcallSoon = bcalls.length ? Math.max(0, bcalls[0].lapseM - deferredGame.month) : 0;
    const notesLive = (deferredGame.noteOffers?.length ?? 0)
      + (deferredGame.privateAsks?.length ?? 0)
      + (deferredGame.notes ?? []).filter((n) => n.perf === "nonperforming" && n.filedM === undefined).length;
    const privateBorrowLive = deferredGame.privateBorrowQuotes?.length ?? 0;
    // Receiver books / fund packages on Marketplace — the seizure alert's desk.
    const booksLive = (deferredGame.portfolios ?? []).filter((p) => !p.player).length
      + ((deferredGame.auction && deferredGame.month < deferredGame.auction.m) ? 1 : 0);
    let debtBal = 0, debtWall = 0;
    for (const h of Object.values(deferredGame.holdings)) {
      if (h.loan) {
        debtBal += h.loan.balance;
        if (h.loan.maturityM - deferredGame.month <= 36) debtWall += h.loan.balance;
      }
      if (h.mezz && h.mezz.balance > 0) {
        debtBal += h.mezz.balance;
        if (h.mezz.maturityM - deferredGame.month <= 36) debtWall += h.mezz.balance;
      }
    }
    if (deferredGame.facility) {
      debtBal += deferredGame.facility.balance;
      if (deferredGame.facility.maturityM - deferredGame.month <= 36) debtWall += deferredGame.facility.balance;
    }
    return {
      nw, cf, occSf, occLeased, vacDpp, line, dealsCount, unread, bcalls, bcallSoon, notesLive, booksLive,
      debtHot: privateBorrowLive > 0 || (debtBal > 0 && debtWall / debtBal > 0.35),
      debtSwept: !!deferredGame.facility?.breachedSince,
      debtBal, debtWall,
    };
  }, [deferredGame]);
  const { nw, cf, occSf, occLeased, vacDpp, line, dealsCount, unread, bcalls, bcallSoon, notesLive, booksLive, debtHot, debtSwept, debtBal, debtWall } = vitals;

  // WHICH TOWN IS NOT ASKED HERE ANY MORE. The island, the size and the
  // build-out used to hang off the New-city button as a three-section
  // dropdown, which measured 973px tall at 1280x720 with its confirm button
  // 353px below the bottom of the window — fourteen options and no way to
  // reach the end of them. They live on the start screen now, which has a
  // scroller and a footer that cannot scroll away. See ui/StartMenu.tsx.
  const newRunRef = useRef<HTMLDivElement>(null);
  const jobsRef = useRef<HTMLDivElement>(null);

  /* THE BAR PUBLISHES ITS OWN HEIGHT.
     Everything that hangs below it — the parcel panel, the page overlays, the
     deed stamp — was positioned from a constant of 60px, and the bar has not
     been 60px tall since the firm's name went under the title: it measures 91
     at 1600px and taller still when the controls wrap to a second row at
     narrow widths. While the bar faded to transparent the overlap was
     invisible; now that it is an opaque plate, it clips the panel's address
     off the top of the card.
     Fixed by measuring rather than by choosing a bigger constant, because the
     wrap means there is no constant that is right at every width. */
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty("--topbar-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The armed New-city button disarms on a click anywhere else, so a campaign
  // is never one click away from being erased.
  useEffect(() => {
    if (!armNewRun) return;
    const close = (e: MouseEvent) => {
      if (newRunRef.current && !newRunRef.current.contains(e.target as Node)) setArmNewRun(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [armNewRun]);
  useEffect(() => {
    if (!jobOpen) return;
    const close = (e: MouseEvent) => {
      if (jobsRef.current && !jobsRef.current.contains(e.target as Node)) setJobOpen(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [jobOpen]);

  return (
    <div className="topbar" ref={barRef}>
      <div className="brand">
        <span className="brand-name">Broadway &amp; Wall</span>
        {/* WHO THE CITY THINKS YOU ARE. Every rival firm has a name and a
            characterisation; the player was the string "You". This is the
            headline epithet — the most quotable true thing about the firm,
            recomputed every quarter from state the player could have looked
            up themselves. It costs nothing to read and nothing to maintain. */}
        {game?.firm && (
          <span className="firm-id" title={(game.firm.epithets ?? []).map((e) => e.text).join(" · ") || "The town has not formed a view yet."}>
            <span className="firm-name">{game.firm.name}</span>
            {(() => {
              const e = headlineEpithet(game);
              if (!e) return null;
              const yrs = Math.floor((game.month - e.sinceM) / 12);
              return <span className="firm-epithet">{e.text}{yrs >= 8 ? ` — ${yrs} years now` : ""}</span>;
            })()}
          </span>
        )}
        {/* YOU DO NOT GET TO CHANGE TOWNS MID-CAMPAIGN.
            The picker used to be live for the whole run, and every island kept
            its own autosave, so a bad decade in one town was two clicks away
            from a fresh start in another and the town you were "playing" was
            never a commitment. A city you are stuck with is the premise of the
            game: the submarket you misread is the submarket you have to trade
            your way out of.
            The choice does not disappear, it moves to where it belongs — the
            start screen, which is where a run begins now. The New city button
            still asks twice before erasing anything and then goes back there. */}
        {game ? (
          <span
            className="brand-sub city-locked"
            title={`You are playing ${manifest?.city ?? currentCity()}, built from seed ${game.citySeed ?? currentSeed()}. `
              + `A campaign belongs to its town — to play a different one, start a new game.`}
          >
            {manifest?.city ?? currentCity()}
          </span>
        ) : (
          <span className="brand-sub">
            {manifest?.city ?? (manifest?.district === "MN" ? "Manhattan" : "Lower Manhattan · CD 1")}
          </span>
        )}
        {manifest?.source === "synthetic" && (
          <span className="badge badge-warn" title="Generated stand-in data — run `pnpm pipeline` on an open network to fetch real PLUTO data.">
            SYNTHETIC DEV DATA
          </span>
        )}
      </div>

      {game && (
        <div className="topbar-game">
          {/* THE READOUTS ARE THE ONLY THING ALLOWED TO SHRINK.
              This row was one flat nowrap flex line — eight readouts, six nav
              buttons, three lenses and three advance buttons — inside a bar
              laid out with space-between. Once the contents exceeded the
              window the row simply overflowed its box and the advance buttons
              came to rest ON TOP of Saves, Settings and New city. The media
              queries hid readouts one at a time to buy room, which is a guess
              about how much room is needed rather than a guarantee.
              Boxing the numbers separately makes it structural: the numbers
              can shrink and clip because every one of them is also on a page,
              and the CONTROLS cannot, because a button you cannot reach is not
              a control. */}
          {/* Vital money/time — outside the clip box. A full nav used to push
              Line into overflow:hidden and show "$5.." for a multi-million limit. */}
          <div className="topbar-summary">
          <div className="topbar-vital">
            <Stat label={monthLabel(game.month)} value={`Yr ${Math.floor(game.month / 12) + 1}`} wide w={118} keep />
            <Stat label="Cash" value={usd(game.cash)} bad={game.cash < 0} w={88} keep
              title="GP liquidity — the firm's own cash. Vehicle cash, if any, is separate." />
            {game.fund && !game.fund.settled && (
              <Stat
                label="Vehicle"
                value={usd(game.fund.cash)}
                w={88}
                keep
                title={`Fund vehicle cash (LP capital). Called ${(game.fund.called / 1e6).toFixed(1)}M; uncalled ${(game.fund.uncalled / 1e6).toFixed(1)}M. Not GP liquidity.`}
              />
            )}
            {(() => {
              const drawn = game.loc?.balance ?? 0;
              const label = drawn > 0 ? "Line drawn" : "Line";
              const value = drawn > 0
                ? `${usd(drawn)} / ${usd(line)}`
                : line > 0 ? usd(line) : "—";
              return (
                <Stat
                  label={label}
                  value={value}
                  bad={drawn > 0}
                  keep
                  w={drawn > 0 ? 148 : 96}
                  title={drawn > 0
                    ? `Revolver drawn ${usd(drawn)} of ${usd(line)} available against net worth. Draw and repay on Debt.`
                    : `Undrawn line capacity ${usd(line)}. Opens against net worth; draw and repay on Debt.`}
                />
              );
            })()}
            {/* CF + Occupancy live in the vital strip (not droppable stats).
                They used to sit in .topbar-stats with drop 2 and vanished below
                1680px — and the whole stats box hides under 760px — so the
                occupancy readout the player asked for never appeared on a
                normal screen. Vitals stay up. */}
            <Stat
              label="CF / yr"
              value={usd(cf * 12)}
              bad={cf < 0}
              keep
              w={88}
              title={`Firm cash flow annualised: deed NOI (including ground rent) less mortgages, construction interest, facility and the revolver. ${usd(cf)} / mo. Portfolio "Cash flow / mo" is deeds only.`}
            />
            <Stat
              label="Occupancy"
              value={occSf ? ((100 * occLeased) / occSf).toFixed(1) + "%" : "—"}
              bad={occSf > 0 && occLeased / occSf < 0.8}
              keep
              w={80}
              title={occSf
                ? `Portfolio occupancy: ${((100 * occLeased) / occSf).toFixed(1)}% leased across operated buildings (excludes ground-leased fees). Same total as Leasing.`
                : "Portfolio occupancy — appears once you own an operated building."}
            />
            <Stat
              label="Base rate"
              value={pct(game.econ.indexRate)}
              keep
              w={72}
              title="The benchmark every loan in town prices off. Your floating loans reprice to it monthly (through the cap strike, if you bought one), and any new quote — mortgage, construction loan, credit line — is this rate plus the lender's spread."
            />
            {/* Vacancy change, not level — the single highest-EV cycle tell. */}
            <Stat
              label="Vac Δ / yr"
              value={vacDpp === null ? "—" : `${vacDpp >= 0 ? "+" : ""}${vacDpp.toFixed(1)} pp`}
              bad={vacDpp !== null && vacDpp >= 2}
              keep
              w={84}
              title={vacDpp === null
                ? "Office vacancy vs twelve months ago — appears after the first year of tape."
                : vacDpp >= 2
                  ? `Office vacancy is ${vacDpp.toFixed(1)} points higher than a year ago. In simulated centuries, real rents were lower three years later ~93% of the time — confirmation you are past the top, not a prophecy.`
                  : `Office vacancy change vs a year ago: ${vacDpp >= 0 ? "+" : ""}${vacDpp.toFixed(1)} percentage points. Rising ≥2 pp is the soft-market tell.`}
            />
          </div>
          <div className="topbar-stats">
          <Stat
            label="Net worth"
            value={usd(nw)}
            drop={2}
            w={96}
            title={`Firm going-concern equity ${usd(nw)} (cash + property − debt − deposits + CIP + notes; not estate net-of-tax; vehicle cash separate).`}
          />
          {/* NW rides drop 2. Market phase and vacant-lot counts are drop 3. */}
          <Stat
            label="Market"
            value={game.econ.phase}
            drop={3}
            w={84}
            title="City cycle phase — also on the Economy page. This is the street, not your firm. Watch Vac Δ / yr; watch Book when you are the one in trouble."
          />
          {(() => {
            const book = firmBookStress(game);
            return (
              <Stat
                label="Book"
                value={book.label}
                bad={book.bad}
                keep
                w={88}
                title={book.title}
              />
            );
          })()}
          <Stat
            drop={3}
            w={92}
            label="Vacant lots"
            value={String(Math.max(0, game.totalLots - game.builtAtStart - Object.keys(game.built).length))}
            title={`Empty lots left in ${manifest?.city ?? "town"}. Every one is a site someone can build on — as they run out, land gets scarce and prices climb. ${game.totalLots ? Math.round((100 * (game.builtAtStart + Object.keys(game.built).length)) / game.totalLots) : 0}% of the city is built.`}
          />
          </div>
          </div>
          <div className="topbar-workspace">
          <nav className="nav-cluster nav-cluster-desks" aria-label="Firm jobs" ref={jobsRef}>
          <span className="topbar-sep" />
          {/* Job-based IA: four verbs instead of a peer strip of desks. Each
              job opens its rooms; badges still sit on the job that owns them. */}
          {JOBS.map((job) => {
            const on = job.pages.some((p) => p.id === page);
            const badge = job.id === "acquire"
              ? dealsCount + notesLive + bcalls.length + booksLive
              : job.id === "capital" && (debtSwept || debtHot) ? 1
              : job.id === "world" ? unread
              : 0;
            const title = job.id === "acquire" && (bcalls.length || booksLive)
              ? [
                bcalls.length ? `${bcalls.length} off-market file${bcalls.length === 1 ? "" : "s"}; soonest lapses in ${bcallSoon} mo` : "",
                booksLive ? `${booksLive} book${booksLive === 1 ? "" : "s"}/docket on Marketplace` : "",
              ].filter(Boolean).join(" · ")
              : job.id === "capital" && debtBal > 0
                ? `${(debtBal / 1e6).toFixed(1)}M outstanding${debtHot ? ` — ${((debtWall / debtBal) * 100).toFixed(0)}% matures inside 3y` : ""}`
                : undefined;
            return (
              <div key={job.id} className="nav-job">
                <button
                  type="button"
                  className={"nav-btn" + (on || jobOpen === job.id ? " nav-on" : "")}
                  aria-haspopup="menu"
                  aria-expanded={jobOpen === job.id}
                  title={title}
                  onClick={() => {
                    if (job.pages.length === 1) {
                      setJobOpen(null);
                      const pid = job.pages[0].id;
                      setPage(page === pid ? "none" : pid);
                    } else {
                      setJobOpen((v) => (v === job.id ? null : job.id));
                    }
                  }}
                >
                  {job.label}
                  {job.id === "acquire" ? <Badge n={badge} /> : null}
                  {job.id === "capital" && debtSwept ? " · ⚠" : job.id === "capital" && debtHot ? " · !" : ""}
                  {job.id === "world" ? <Badge n={unread} /> : null}
                  {job.pages.length > 1 ? <span className="nav-caret" aria-hidden="true">▾</span> : null}
                </button>
                {jobOpen === job.id && (
                  <div className="nav-menu nav-job-menu" role="menu">
                    {job.pages.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitem"
                        className={"nav-menu-item" + (page === p.id ? " on" : "")}
                        onClick={() => {
                          setJobOpen(null);
                          setPage(page === p.id ? "none" : p.id);
                        }}
                      >
                        <span>{p.label}</span>
                        <small>{p.note}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          </nav>
          <div className="nav-cluster nav-cluster-map" role="group" aria-label="Map lenses">
          <span className="topbar-sep" />
          <button
            className={"lens-btn" + (lens === "listings" ? " lens-on" : "")}
            onClick={() => setLens(lens === "listings" ? "none" : "listings")}
            title="Market lens — highlight everything for sale on the map"
          >
            ◉ Market
          </button>
          <button
            className={"lens-btn" + (lens === "land" ? " lens-on" : "")}
            onClick={() => setLens(lens === "land" ? "none" : "land")}
            title="Land value lens — shade every lot by current land $/sf"
          >
            ◧ Land
          </button>
          <button
            className={"lens-btn" + (lens === "demand" ? " lens-on lens-on-teal" : "")}
            onClick={() => setLens(lens === "demand" ? "none" : "demand")}
            title="Demand lens — transit + employment gravity, the why behind the rents"
          >
            ◨ Demand
          </button>
          <button
            className={"lens-btn" + (lens === "zoning" ? " lens-on" : "")}
            onClick={() => setLens(lens === "zoning" ? "none" : "zoning")}
            title="Zoning lens — how much of the allowed envelope is still unbuilt. Bright is room to build; dark is spent, and landmarked lots go black."
          >
            ◩ Zoning
          </button>
          <button
            className={"lens-btn" + (lens === "owners" ? " lens-on lens-on-teal" : "")}
            onClick={() => setLens(lens === "owners" ? "none" : "owners")}
            title="Owners lens — every building the other firms hold, one colour per firm. Yours stay gold."
          >
            ◫ Owners
          </button>
          <button
            className={"lens-btn" + (lens === "leases" ? " lens-on" : "")}
            onClick={() => setLens(lens === "leases" ? "none" : "leases")}
            title="Lease lens — months to next expiry on buildings you own. Bright is soon; dark is long WALT."
          >
            ◬ Leases
          </button>
          </div>
          <div className="nav-cluster nav-cluster-time" role="group" aria-label="Time controls">
          <button className={"advance-btn" + (advancing ? " advance-pulse" : "")} onClick={advance} disabled={!!game.gameOver || advancing} title="One month (Space)">
            Advance ▸
          </button>
          <button className={"advance-btn advance-fast" + (advancing ? " advance-pulse" : "")} onClick={advanceYear} disabled={!!game.gameOver || advancing} title="A year, stopping if something needs you (Y)">
            {advancing ? "…" : "Yr ▸▸"}
          </button>
          <button className={"advance-btn advance-fast" + (advancing ? " advance-pulse" : "")} onClick={advanceUntil} disabled={!!game.gameOver || advancing} title="Skip to the next thing that needs a decision, up to 3 years (N)">
            {advancing ? "…" : "⏭"}
          </button>
          </div>
          </div>
        </div>
      )}

      <div className="topbar-right">
        <button
          className={"lens-btn" + (mapOnly ? " lens-on" : "")}
          title="Map only — hide firm pages and watch the skyline (M). Inbox and glance cards stay."
          onClick={() => setMapOnly(!mapOnly)}
        >
          ◈ Map
        </button>
        <button
          className="lens-btn"
          title="Photo frame — hide all chrome for a clean skyline still (P)"
          onClick={() => useStore.getState().setPhotoFrame(true)}
        >
          ◻ Frame
        </button>
        {/* SAVES, WHERE SOMEBODY CAN FIND THEM. The whole save/load panel was
            built and then rendered only at the bottom of the Books page, under
            the ledger — which is the same as not having one. It is a top-level
            control now, because loading a game is not an accounting task. */}
        <button
          className={"lens-btn" + (page === "saves" ? " lens-on" : "")}
          title="The live campaign autosaves; create or load named snapshots here"
          onClick={() => setPage(page === "saves" ? "none" : "saves")}
        >
          ⛁ Saves
        </button>
        {/* THE ONE PAGE THAT ASSUMES YOU HAVE NEVER DONE THIS. Everything else
            in this game is written for somebody who already knows what a cap
            rate is. */}
        <button
          className={"lens-btn" + (page === "primer" ? " lens-on" : "")}
          title="New to commercial real estate? Cap rates, NOI and appraisals, in plain words"
          onClick={() => setPage(page === "primer" ? "none" : "primer")}
        >
          ? Primer
        </button>
        <button
          className={"lens-btn" + (page === "settings" ? " lens-on" : "")}
          title="Settings — pop-up cards, broker calls, the auction card"
          onClick={() => setPage(page === "settings" ? "none" : "settings")}
        >
          ⚙ Settings
        </button>
        {/* No window.confirm here. Browsers that suppress dialogs (an iframe,
            or "prevent this page from creating dialogs" ticked once) make
            confirm() return false silently and forever — the button reads as
            dead. A two-click arm-then-fire needs nothing from the browser. */}
        {/* ONE BUTTON, ONE PROMISE. It used to open the three menus that chose
            the next town, which is how it grew taller than the window. It now
            does what its label says and nothing else: erase this campaign and
            go back to the start screen, where the next town is chosen with
            room to read the options. */}
        <div className="city-pick" ref={newRunRef}>
          <button
            className={"lens-btn" + (armNewRun ? " lens-on" : "")}
            title="End this campaign and go back to the start screen, where you pick the island, the size and how built up the town is. Named saves are left alone. No holdings, the opening bankroll you choose, a brand new town."
            onClick={() => {
              if (!armNewRun) { setArmNewRun(true); setTimeout(() => setArmNewRun(false), 12000); return; }
              setArmNewRun(false);
              useStore.getState().newRun();
            }}
          >
            {armNewRun ? "Erase this game?" : "↺ New city"}
          </button>
        </div>
        {fpsOn && (
          <span className={"stat mono " + (fps >= 55 ? "fps-good" : fps >= 30 ? "fps-ok" : "fps-bad")}>
            {fps} fps
          </span>
        )}
      </div>
    </div>
  );
}

// `drop` ranks a readout's expendability when the bar runs out of width: 3
// goes first, then 2, and anything unranked never goes. Every one of these
// numbers is also on a page — Books, the Economy — so losing one costs a
// glance, not information. The controls are not rankable: they stay.
/**
 * A COUNT THAT DOES NOT MOVE THE BUTTON IT IS ON.
 *
 * `Deals` becoming `Deals · 3` becoming `Deals · 12` widens the button and
 * walks every control to its right along with it — and the deals count changes
 * on almost every Advance, which is exactly when the player's cursor is parked
 * over a button. The badge gets a fixed slot; the label never moves. It renders
 * the slot even at zero so appearing and disappearing costs nothing either.
 */
function Badge({ n }: { n: number }) {
  return <span className="nav-badge">{n > 0 ? `· ${n}` : ""}</span>;
}

/**
 * A READOUT THAT KEEPS ITS PLACE.
 *
 * Every stat in this bar was a content-sized flex box, so the whole row moved
 * whenever any value changed WIDTH — and the values change width constantly:
 * `$2.5M` becomes `$12.4M`, `May 2000` becomes `September 2043`, `peak` becomes
 * `recession`. Press Advance a few times and the nav buttons walk left and
 * right under the cursor, which is the reported bug and is worst for exactly
 * the player who presses Advance the most.
 *
 * The digits were already tabular so the glyphs lined up; what moved was the
 * CHARACTER COUNT, which no font setting fixes. So each readout reserves the
 * room its widest plausible value needs and grows inside its own box. `w` is
 * that reservation in pixels — wide enough for the longest month name, the
 * longest phase word, and a negative nine-figure number with a suffix.
 */
function Stat({ label, value, bad, wide, title, drop, w, keep }: {
  label: string; value: string; bad?: boolean; wide?: boolean; title?: string; drop?: 2 | 3; w?: number; keep?: boolean;
}) {
  return (
    <div
      className={"tstat" + (wide ? " tstat-wide" : "") + (drop ? ` tstat-d${drop}` : "") + (keep ? " tstat-keep" : "")}
      title={title}
      style={w ? { minWidth: w, maxWidth: keep ? undefined : w } : undefined}
    >
      <span className="tstat-label">{label}</span>
      {value && <span className={"tstat-value mono" + (bad ? " neg" : "")}>{value}</span>}
    </div>
  );
}
