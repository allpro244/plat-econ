import { useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel, START_YEAR } from "@/engine/types";
import type { BuiltClass, EconHistoryPoint } from "@/engine/types";
import { capitalRatio, targetCapital } from "@/engine/lenders";
import { NATURAL_VAC, RENT_BASE, SECTOR_LABEL, CITY_STOCK, frictionFloor } from "@/engine/market";
import { marketRequirement } from "@/engine/absorption";
import { submarkets, legVacancy, legRent, legDemand, deliverySchedule, projectVacancy, marketBalance, monthsOfSupply } from "@/engine/space";
import { LineChart, BarChart, Gauge } from "@/ui/Chart";
import type { BarGroup } from "@/ui/Chart";
import { pct } from "@/ui/format";
import { TheBanks } from "@/ui/panels/BanksDesk";
import { LandValueChart } from "@/ui/panels/MarketPage";
import { creditWord, real, Big, Row } from "@/ui/panels/shared";

/**
 * THE CITY, SIX CHARTS WIDE — the "general" card's detail view.
 *
 * The stat strips print today's numbers; these are the six city series with
 * their history attached, one per cell, because the level of a demand series
 * is nearly meaningless without the path it took to get there.
 * Wages and output are REAL — already deflated by the price level in the
 * sixth chart — so a flat real wage across a decade of inflation is a city
 * treading water, not one getting richer.
 *
 * `spanYrs` is how much of the record the page's window switch has selected.
 * The heading used to say "the last twenty years" in fixed text, which stopped
 * being true the moment that switch existed.
 */
/**
 * DEFLATE. THE ENGINE KEEPS NOMINAL SERIES AND THIS PAGE WAS PLOTTING THEM RAW.
 *
 * `wageIdx` is nominal — `market.ts` says so in capitals ("WAGES ARE NOMINAL AND
 * THEY TRACK PRICES") and builds it out of `inflExp/12 + productivity/12`.
 * `outputIdx` is `jobs x wageIdx`, so it is nominal city product. Both were
 * drawn here under titles that said "real" and notes that said "inflation is
 * already taken out", and the division was simply never done.
 *
 * That is the third kind of fake number — one quantity with two answers — and
 * it is also the whole of the complaint that the wage chart "looks like a
 * straight line up that never comes down". A NOMINAL wage index cannot come
 * down: downward nominal rigidity is modelled on purpose (market.ts, the
 * wageDebt block), and measured over six seeds x 50 years it fell in 0.00% of
 * twelve-month windows, worst -0.01%. The real wage, the same runs, fell in
 * 15.87% of them, worst -3.64% — about one year in six, against US real average
 * hourly earnings falling roughly one year in five and -2.8% in 2022 alone.
 * Trend real growth is 0.87%/yr (range 0.50-1.09 across seeds), which is the
 * 1.1% productivity centre less labour hoarding and the wage debt worked off
 * after freezes.
 *
 * So the series the player was told they were looking at existed all along.
 */

export function CityEconCharts({ tail, spanYrs }: { tail: EconHistoryPoint[]; spanYrs: number }) {
  if (tail.length < 2) return <div className="hint">Not enough history yet — advance a few quarters.</div>;
  const x: [string, string] = [monthLabel(tail[0].q), monthLabel(tail[tail.length - 1].q)];
  const kFmt = (v: number) => `${v.toFixed(0)}k`;
  const idxFmt = (v: number) => v.toFixed(2);
  return (
    <>
      <div className="page-section">The city — the last {spanYrs} year{spanYrs === 1 ? "" : "s"}</div>
      <div className="hint">
        The demand behind every lease in the four markets above. Rents are downstream of jobs, and jobs are
        downstream of whether anybody wants to be here — none of these series reads as a level without the
        path it took.
      </div>
      <div className="chart-grid">
        <div className="chart-cell">
          <div className="chart-title">Population</div>
          <LineChart height={108} series={[{ label: "population", color: "#7a5c1e", pts: tail.map((h) => (h.population ?? 0) / 1000) }]} yFmt={kFmt} xLabels={x} />
          <div className="chart-note">
            Souls in the city. It follows jobs slowly, because people move for work and move back reluctantly —
            a downturn shows here a year after it shows in the chart to the right.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">Jobs</div>
          <LineChart height={108} series={[{ label: "jobs", color: "#2f6f7a", pts: tail.map((h) => (h.jobs ?? 0) / 1000) }]} yFmt={kFmt} xLabels={x} />
          <div className="chart-note">
            Filled positions — the line every lease is downstream of. Occupancy chases the space these jobs
            want, with a lag, which is why rents turn before employment does.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">Unemployment</div>
          <LineChart height={108} series={[{ label: "unemployment", color: "#a8402e", pts: tail.map((h) => (h.unemployment ?? 0) * 100) }]} yFmt={(v) => `${v.toFixed(1)}%`} xLabels={x} />
          <div className="chart-note">
            Of the labour force. The LAST thing to turn in a downturn — by the time this reads badly the rents
            already have, and by the time it recovers the cheap buildings are gone.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">Real wage — index, 1.00 = year 2000</div>
          {/* THE REAL WAGE GETS THIS AXIS TO ITSELF. Drawing the nominal index
              beside it was the obvious way to show the contrast and it does not
              work: nominal reaches 4.5x over a campaign against real's 1.35x, so
              the shared scale flattens the series that matters into a rule along
              the bottom — which is the very "straight line" complaint this chart
              exists to answer. The nominal figure is a Row instead, where a
              number does the job a squashed line cannot: see `CityFigures`
              directly below this grid. That sentence was written when the Row
              did not exist anywhere in the game — the line was dropped for a
              good reason and the number that was meant to replace it was never
              written — and it is true now. */}
          <LineChart height={108} series={[{ label: "real wage", color: "#3a7d46", pts: tail.map((h) => real(h.wageIdx, h.cpi)) }]} yFmt={idxFmt} xLabels={x} />
          <div className="chart-note">
            What a paycheque buys, with inflation actually taken out. It gives ground about one year in six —
            firms freeze pay rather than cut it, so the cutting is done by the price-level chart below instead.
            Dear money raises this line and cheap money erodes it, both with a lag of a year or two. Retail and
            apartment rents lean on it hardest.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">Real output — index, 1.00 = year 2000</div>
          <LineChart height={108} series={[{ label: "real output", color: "#3d6f9e", pts: tail.map((h) => real(h.outputIdx, h.cpi)) }]} yFmt={idxFmt} xLabels={x} />
          <div className="chart-note">
            Jobs times productivity, in real terms — the city's whole product on one line. When it grows faster
            than the standing stock of space, somebody has to build; when it does not, somebody already did.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">Price level — nominal, 1.00 = year 2000</div>
          <LineChart height={108} series={[{ label: "price level", color: "#8a5620", pts: tail.map((h) => h.cpi ?? 1) }]} yFmt={idxFmt} xLabels={x} />
          <div className="chart-note">
            Cumulative inflation — the one NOMINAL series here, and the deflator behind the two real ones.
            Every dollar elsewhere on this page is quoted in the money this chart is quietly shrinking.
          </div>
        </div>
      </div>
      <CityFigures />
    </>
  );
}

/**
 * THE CITY'S NUMBERS, WHICH A CHART CANNOT GIVE YOU.
 *
 * These eight rows used to be printed under the land chart on Research. When
 * Land moved onto the Economy page the two population/jobs charts above it came
 * with it — they are the six cells in `CityEconCharts` — and the eight ROWS were
 * deleted with the section rather than moved. Nothing asked for that, and it
 * took real information out of the game: a chart says which way and how fast,
 * and it cannot say how many people are in the town or what the price level has
 * done since the year 2000 — and those are the figures a person quotes.
 *
 * The nominal wage is the sharpest case, because the comment on the real-wage
 * chart above ASSERTS that it is "a Row on the Economy page instead, where a
 * number does the job a squashed line cannot." It was not. It was nowhere in
 * the game at all — the chart dropped the line for a good reason, and the Row
 * that was supposed to catch it never got written. That prose is now true.
 *
 * Levels, not deltas, except where a level says nothing: "jobs added this year"
 * is the one figure on this list that only exists as a change, and it is the
 * first thing anybody underwriting a market looks up.
 */
export function CityFigures() {
  const game = useStore((s) => s.game)!;
  const e = game.econ;
  const h = e.history ?? [];
  const n = h.length;
  // Twelve months back, on the same series the chart above draws — not a
  // separate estimate of the same growth rate.
  const jobsYr = n > 12 && h[n - 13].jobs ? (h[n - 1].jobs! / h[n - 13].jobs! - 1) * 100 : 0;
  return (
    <>
      <div className="page-section" style={{ marginTop: 14 }}>Where the city stands today</div>
      <div className="grid">
        <Row k="Population" v={(e.population ?? 0).toLocaleString()} strong />
        <Row k="Jobs" v={(e.jobs ?? 0).toLocaleString()} />
        <Row k="Jobs added this year" v={`${jobsYr >= 0 ? "+" : ""}${jobsYr.toFixed(1)}%`} bad={jobsYr < 0} strong />
        {/* The 8.5% flag is the one these rows carried before they were
            deleted, kept rather than re-picked: `initEcon` opens the city at
            5.2% and `tickEcon` falls back to 5.5% wherever the field is
            missing, so eight and a half is about three points of slack above
            where this town sits when nothing is wrong. */}
        <Row k="Unemployment" v={`${((e.unemployment ?? 0) * 100).toFixed(1)}%`} bad={(e.unemployment ?? 0) > 0.085} />
        <Row k="Real wage" v={`${((real(e.wageIdx, e.cpi) - 1) * 100).toFixed(0)}% against the year 2000`} />
        {/* THE ROW THE CHART ABOVE PROMISED. Its own note records why the line
            was dropped — nominal measured at 4.5x over a campaign against
            real's 1.35x, so a shared axis flattens the series that matters —
            and that is exactly why the figure has to be said SOMEWHERE, or the
            player has no way to see the gap between what they are paid and
            what it buys. */}
        <Row k="Nominal wage" v={`${(((e.wageIdx ?? 1) - 1) * 100).toFixed(0)}% against the year 2000`} />
        <Row k="Real output" v={`${((real(e.outputIdx, e.cpi) - 1) * 100).toFixed(0)}% against the year 2000`} />
        <Row k="Price level" v={`${(((e.cpi ?? 1) - 1) * 100).toFixed(0)}% of cumulative inflation`} />
      </div>
    </>
  );
}

/**
 * THE ECONOMY, WHOLE.
 *
 * Everything outside your buildings, on one page, arranged the way a market
 * report is: the cycle at the top, then — for each asset class — the four
 * questions that decide whether to buy, hold, or build.
 *
 *   How tight is it?      vacancy against its natural rate
 *   Which way is it going? rents and vacancy over the last twenty years, or
 *                          over the whole run — one switch, every chart
 *   What is coming?        the construction pipeline, by the year it lands
 *   Where does it end up?  vacancy projected forward if nobody else starts
 *
 * And below that, the same question asked of each NEIGHBOURHOOD, because
 * "office vacancy is 12%" is not a decision and "the Exchange is at 6% and
 * Millside is at 21%" is.
 */
export function EconomyPage() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const bbls = useStore((s) => s.bbls);
  const e = game.econ;
  const hist = e.history ?? [];
  // A fifth stance joins the four classes: "general" swaps the class detail
  // for the city itself — the six series every rent in the game is downstream
  // of. It lands first because the class cards only make sense against it.
  //
  // LAND AND THE BANKS ARE THE SIXTH AND SEVENTH, and they arrived here from
  // Research by request. They were never research: research is the view you
  // form before you shop, and these two are the market picture itself. Land is
  // the input to every appraisal and every development budget on this page —
  // reading the rent cycle on one screen and the land cycle on another is how
  // you come to believe a site pencils. The banks are the other half of a cap
  // rate: what a building is worth is what somebody can borrow against it, and
  // the credit-window stat at the top of this page is a single number derived
  // from those five balance sheets. Both are stances of the same page now, one
  // on screen at a time, exactly like the four classes.
  const [sel, setSel] = useState<BuiltClass | "general" | "land" | "banks">("general");
  const isClass = sel !== "general" && sel !== "land" && sel !== "banks";
  // Every per-class computation below still wants a concrete class, and the
  // cheapest way to keep the non-class stances from breaking marketBalance(e,
  // focus) and its neighbours is to let them run against office while another
  // grid is up — nothing they produce is rendered then.
  const focus: BuiltClass = isClass ? (sel as BuiltClass) : "office";
  const CLASSES: BuiltClass[] = ["office", "retail", "multifamily", "industrial"];
  const COLOR: Record<BuiltClass, string> = {
    office: "#3d6f9e", retail: "#a8562e", multifamily: "#4a7d5a", industrial: "#7a6a45",
  };

  const bal = marketBalance(e, focus);
  const vacNow = e.cityVac?.[focus] ?? NATURAL_VAC[focus];
  const stock = e.stock?.[focus] ?? CITY_STOCK[focus];
  const mos = monthsOfSupply(e, focus);
  const sched = deliverySchedule(e, game.month, 4)[focus];
  const proj = projectVacancy(e, focus, game.month, 36);
  const subs = submarkets(game, parcels, bbls);
  // The map's fly-to action, under a name that does not collide with the
  // class this page is focused on.
  const flyTo = useStore((s) => s.focus);

  // THE AUTHORITATIVE QUEUE. deliveryQueue is one row per physical project —
  // player, rival, city, reuse. Cohorts/pipeline are derived views. Walk the
  // queue so the table cannot disagree with what vacancy will receive.
  const pipeJobs = (() => {
    const rows: { bbl: string; who: string; sf: number; floors: number; deliverM: number; stalled?: boolean; mixed?: boolean }[] = [];
    for (const p of e.deliveryQueue ?? []) {
      if (!p.bbl || p.deliverM - game.month >= 24) continue;
      const csf = Math.round(p.sfByUse[focus] ?? 0);
      if (csf <= 0) continue;
      const d = game.developments[p.bbl];
      const j = (game.cityJobs ?? []).find((x) => x.bbl === p.bbl);
      const who = p.source === "player" || p.source === "reuse" ? "You"
        : j?.firmId ? (game.rivals.find((r) => r.id === j.firmId)?.name ?? "A rival")
        : p.source === "rival" ? "A rival"
        : "The city";
      const floors = d?.floors ?? j?.floors ?? 0;
      const legs = Object.values(p.sfByUse).filter((v) => (v ?? 0) > 0).length;
      rows.push({
        bbl: p.bbl,
        who,
        sf: csf,
        floors,
        deliverM: p.deliverM,
        stalled: p.status === "stalled" || !!j?.orphaned,
        mixed: legs > 1,
      });
    }
    return rows.sort((a, b) => b.sf - a.sf);
  })();
  const pipeJobsSf = pipeJobs.reduce((a, r) => a + r.sf, 0);

  // HOW MUCH OF THE RECORD THIS PAGE IS LOOKING AT.
  //
  // Twenty years was the only window there was, and twenty years is one and a
  // half cycles — long enough to see the last glut and too short to see
  // whether it was the biggest one. The owner asked for the whole run on the
  // vacancy chart.
  //
  // The switch drives EVERY chart on the page that reads `tail`, not just
  // vacancy, and that is deliberate: rent/cap, absorbed/delivered, the
  // concession gap and the six city series are all fed by this one array and
  // all sit inside one scroll. Moving one of them to a fifty-year axis while
  // its neighbour stays on a twenty-year one invites reading a level off one
  // chart and a date off the other, which is the specific mistake the page
  // exists to prevent. `flowYears` is untouched — it is explicitly the last
  // eight years of annual bars and slices `hist` itself.
  //
  // "All" really is all: recordHistory stamps one point a month and trims at
  // 1260 (105 years), so nothing a run of this game can produce hits the cap.
  const SPAN_M = 240;
  const [span, setSpan] = useState<"20y" | "all">("20y");
  const tail = span === "all" ? hist : hist.slice(-SPAN_M);
  // Every x-axis on the page was computed as `game.month - <some length>`,
  // which was right only while the window was exactly 240 long. The first
  // point carries its own month; use it, and the labels follow the switch.
  const xFrom = `${START_YEAR + Math.floor((tail[0]?.q ?? game.month) / 12)}`;
  const xTo = `${START_YEAR + Math.floor(game.month / 12)}`;
  const spanYrs = Math.max(1, Math.round(((tail[tail.length - 1]?.q ?? game.month) - (tail[0]?.q ?? game.month)) / 12));
  const vacSeries = tail.map((h) => (h.vac?.[focus] ?? NATURAL_VAC[focus]) * 100);
  const rentSeries = tail.map((h) => h.rent?.[focus] ?? e.rentIdx[focus]);
  // pre-v30 history has no effective series; fall back to asking so the two
  // lines simply overlap until the concession machinery has lived a month
  const effSeries = tail.map((h) => h.effRent?.[focus] ?? h.rent?.[focus] ?? e.rentIdx[focus]);
  const capSeries = tail.map((h) => h.cap?.[focus] ?? e.capRate[focus]);
  // the past twenty years of vacancy, then the next three of projection, on
  // one axis — the join is where the pipeline takes over from the record
  const vacWithProj = [...vacSeries, ...proj.map((v) => v * 100)];

  // annual flows: completions against net absorption, last eight years
  const flowYears: BarGroup[] = (() => {
    const byYear = new Map<number, { abs: number; comp: number }>();
    for (const h of hist) {
      const yr = Math.floor(h.q / 12);
      const cur = byYear.get(yr) ?? { abs: 0, comp: 0 };
      cur.abs += h.abs?.[focus] ?? 0;
      cur.comp += h.comp?.[focus] ?? 0;
      byYear.set(yr, cur);
    }
    return [...byYear.entries()].slice(-8).map(([yr, v]) => ({
      label: String((START_YEAR + yr) % 100).padStart(2, "0"),
      bars: [{ v: v.abs, color: "#4a7d5a" }, { v: -v.comp, color: "#a8562e" }],
    }));
  })();

  const pipeGroups: BarGroup[] = sched.map((sf, i) => ({
    label: i === 0 ? "next 12m" : `yr ${i + 1}`,
    bars: [{ v: sf, color: COLOR[focus] }],
  }));

  const phaseBlurb = {
    expansion: "Tenants expand, capital chases, rents push. Enjoy it — peaks are born here.",
    peak: "Priced to perfection. Every deal works on paper and none has margin for the turn.",
    recession: "Tenants retrench and lenders retreat. Cheap buildings and expensive money.",
    recovery: "The bleeding has stopped. Concessions burn off before face rents move.",
    depression: "Empty space is still winning. This is not healing — it is a glut that has not cleared.",
  }[e.phase];

  const pctFmt = (v: number) => `${v.toFixed(1)}%`;
  // square feet at whatever magnitude the data actually is — a 40,000 sf
  // pipeline printed as "0.0M" four times is not a chart, it is a blank
  const sfFmt = (v: number) => {
    const a = Math.abs(v);
    return a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${Math.round(v / 1e3)}k` : a >= 1 ? `${Math.round(v / 100) / 10}k` : "0";
  };

  return (
    <div>
      <div className="stat-strip">
        <Big label="Cycle" value={e.phase} />
        <Big label="Base rate" value={pct(e.indexRate)}
          title="Every loan in town prices off this benchmark: your floating coupons reprice to it monthly, a new quote is this rate plus the lender's spread, and cap rates lean on it — so it moves building values too." />
        {/* The era the index is moving inside. A cycle takes rates a point or
            two either way; the era decides whether that is 3% or 13%, and it
            changes on a scale of decades — which is what makes a loan you
            struck twenty years ago a different animal at maturity. */}
        {e.rateRegime !== undefined && (
          <Big label="Long-run rate" value={pct(e.rateRegime)}
            title="The level the base rate is being pulled toward — the cheap-money or dear-money era the cycle rides on top of. It re-aims every 12–25 years, which is why a loan struck today can mature in a very different rate world."
            bad={e.rateRegime > 9} />
        )}
        <Big label="Credit window" value={`${Math.round(e.creditIdx * 100)}%`} bad={e.creditIdx < 0.7} />
        <Big label="Employment" value={(e.employIdx * 100).toFixed(0)} />
        <Big label="Build costs" value={(e.costIdx * 100).toFixed(0)} />
        <Big label="Land index" value={(e.landIdx * 100).toFixed(0)} />
      </div>
      <div className="hint">{phaseBlurb}{e.rumoredPhase ? ` Word on the street: ${e.rumoredPhase} is coming.` : ""}</div>

      {/* THE RATE, WITH ITS HISTORY. Asked for twice. The series was already
          being written — every EconHistoryPoint carries indexRate, and
          recordHistory has been stamping one a month since month zero — and
          nothing had ever drawn it. A single number tells you what money costs
          today; the line tells you whether you are early or late, which is the
          whole fix-or-float decision and most of the refinancing one.
          The long-run rate is drawn alongside because the gap between them is
          the thing to read: the cycle moves the index a point or two, the era
          decides whether it is orbiting 3% or 13%. */}
      {hist.length > 8 && (
        <div className="page-section" style={{ marginTop: 12 }}>
          <div className="page-section-head">What money has cost</div>
          <LineChart
            height={132}
            series={[
              { label: "Base rate %", color: "#8a4b2a", pts: hist.map((p) => p.indexRate) },
              ...(hist.some((p) => p.rateRegime !== undefined)
                ? [{ label: "Long-run rate %", color: "#8b8370", dashed: true,
                     pts: hist.map((p) => p.rateRegime ?? p.indexRate) }]
                : []),
            ]}
            yFmt={(v) => v.toFixed(1) + "%"}
            xLabels={[monthLabel(hist[0].q), monthLabel(hist[hist.length - 1].q)]}
          />
          <div className="hint">
            Every loan in town prices off the solid line. Where it sits against the dashed one is
            whether today is a cheap-money year inside a dear-money era, or the other way round —
            and that is the difference between fixing and floating.
          </div>
        </div>
      )}

      {/* ---- the four markets, at a glance ---- */}
      <div className="page-section">The space market</div>
      <div className="mkt-cards">
        {/* The pseudo-card. No gauge, because the city has no natural rate to
            sit against — its numbers are the level everything else is read
            off. Clicking it swaps the class detail below for six city charts. */}
        <button
          className={"mkt-card" + (sel === "general" ? " mkt-card-on" : "")}
          onClick={() => setSel("general")}
        >
          <div className="mkt-card-head">
            <span className="mkt-card-name">The city</span>
            <span className="mono">{((e.population ?? 0) / 1000).toFixed(0)}k</span>
          </div>
          <div className="mkt-card-state">the demand under all four</div>
          <div className="mkt-card-sub mono">
            {((e.jobs ?? 0) / 1000).toFixed(0)}k jobs · {((e.unemployment ?? 0) * 100).toFixed(1)}% out of work
          </div>
        </button>
        {CLASSES.map((k) => {
          const b = marketBalance(e, k);
          const v = e.cityVac?.[k] ?? NATURAL_VAC[k];
          const history = e.history ?? [];
          const yearAgo = history.length > 12 ? history[history.length - 13] : undefined;
          const realEffNow = (e.effRentIdx?.[k] ?? e.rentIdx[k]) / Math.max(0.01, e.cpi ?? 1);
          const realEffThen = yearAgo
            ? (yearAgo.effRent?.[k] ?? yearAgo.rent?.[k] ?? e.rentIdx[k]) / Math.max(0.01, yearAgo.cpi ?? 1)
            : realEffNow;
          const rentYoy = realEffNow / Math.max(0.01, realEffThen) - 1;
          const rentWord = rentYoy > 0.025 ? "rising"
            : rentYoy < -0.025 ? "falling"
              : "flat";
          // The stock has always been the denominator under the pipeline
          // percentage on this card and the card never printed it, which made
          // the four classes unreadable against each other: a 6% pipeline on
          // 40M sf of office and the same 6% on 4M sf of industrial are not
          // the same fact about the city.
          const stockSf = e.stock?.[k] ?? CITY_STOCK[k];
          const pipe = (e.pipeline?.[k] ?? 0) / stockSf;
          return (
            <button
              key={k}
              className={"mkt-card" + (sel === k ? " mkt-card-on" : "")}
              onClick={() => setSel(k)}
            >
              <div className="mkt-card-head">
                <span className="mkt-card-name">{SECTOR_LABEL[k]}</span>
                <span className="mono">{(v * 100).toFixed(1)}%</span>
              </div>
              <Gauge value={v} natural={NATURAL_VAC[k]} lo={0} hi={0.28} fmt={(x) => `${(x * 100).toFixed(1)}%`} />
              <div className="mkt-card-state">{b.state}</div>
              <div className={"mkt-card-sub" + (rentYoy < -0.025 ? " neg" : "")}>
                effective rents {rentWord} · {rentYoy >= 0 ? "+" : ""}{(rentYoy * 100).toFixed(1)}% real / 12m
              </div>
              {/* Each class runs its own cycle now, and which part of it you
                  are standing in is the single most useful thing on this card:
                  the same vacancy means opposite things on the way up and on
                  the way down. */}
              {e.sectorPhase?.[k] && e.sectorPhase[k] !== "steady" && (
                <div className={"mkt-card-sub" + (e.sectorPhase[k] === "bust" ? " neg" : "")}>
                  sector {e.sectorPhase[k]} · {Math.max(1, Math.round((e.sectorPhaseM?.[k] ?? 0)))} mo left
                </div>
              )}
              <div className="mkt-card-sub mono">
                ${e.rentIdx[k].toFixed(0)}/sf · {e.capRate[k].toFixed(2)}% cap · {sfFmt(stockSf)} sf · pipeline {(pipe * 100).toFixed(1)}%
              </div>
              {e.rentWhy?.[k] && (
                <div className="mkt-card-sub" title={e.rentWhy[k]}>
                  {e.rentWhy[k]}
                </div>
              )}
            </button>
          );
        })}
        {/* THE TWO MARKETS THAT ARE NOT SPACE MARKETS, on the same rail as the
            four that are — because they are read the same way and at the same
            moment. Land has no vacancy and no natural rate to gauge against;
            the twelve-month move is its state. The banks have no rent; the
            credit window IS their state, and it is the multiplier on the next
            advance rate anybody in this town gets quoted. */}
        {(() => {
          const h = e.history ?? [];
          const yoy = h.length > 12 ? e.landIdx / h[h.length - 13].landIdx - 1 : 0;
          // DESKS THAT STILL QUOTE. A lender in receivership carries a capital
          // ratio that has already gone through the floor — measured, one sat
          // at −47% of book — and it is not a warning about anything, because
          // nothing new is ever written there again. The number worth putting
          // on a card is how close the WEAKEST LIVE desk is to the same fate.
          const banks = (game.lenders ?? []).filter((l) => l.failedM === undefined);
          const failed = (game.lenders ?? []).length - banks.length;
          const worst = banks.length
            ? banks.reduce((a, l) => Math.min(a, capitalRatio(l) / targetCapital(l.name)), Infinity) : 0;
          return (
            <>
              <button className={"mkt-card" + (sel === "land" ? " mkt-card-on" : "")} onClick={() => setSel("land")}>
                <div className="mkt-card-head">
                  <span className="mkt-card-name">Land</span>
                  <span className="mono">{e.landIdx.toFixed(2)}</span>
                </div>
                <div className={"mkt-card-state" + (yoy < -0.02 ? " neg" : "")}>
                  {yoy > 0.06 ? "running hard" : yoy > 0.015 ? "rising" : yoy < -0.06 ? "falling hard"
                    : yoy < -0.015 ? "easing" : "flat"}
                </div>
                <div className="mkt-card-sub mono">
                  {yoy >= 0 ? "+" : ""}{(yoy * 100).toFixed(1)}% over 12m · the slowest cycle here
                </div>
              </button>
              {/* The card exists while there is a lending market to read at
                  all — including a street where every desk has been seized,
                  which is the single most important thing the page could be
                  telling you. Only the "weakest" figure skips the dead ones. */}
              {(game.lenders ?? []).length > 0 && (
                <button className={"mkt-card" + (sel === "banks" ? " mkt-card-on" : "")} onClick={() => setSel("banks")}>
                  <div className="mkt-card-head">
                    <span className="mkt-card-name">The banks</span>
                    <span className="mono">{Math.round(e.creditIdx * 100)}%</span>
                  </div>
                  <div className={"mkt-card-state" + (e.creditIdx < 0.72 ? " neg" : "")}>
                    credit is {creditWord(e.creditIdx ?? 1)}
                  </div>
                  <div className="mkt-card-sub mono">
                    {banks.length} desk{banks.length === 1 ? "" : "s"} still quoting
                    {failed ? ` · ${failed} gone` : ""}
                    {banks.length ? ` · weakest at ${worst.toFixed(2)}× its capital target` : " · nobody is lending"}
                  </div>
                </button>
              )}
            </>
          );
        })()}
      </div>

      {/* THE WINDOW SWITCH, and it only exists when it can do something.
          Below month 240 the whole record IS the last twenty years, and a
          control that redraws the identical chart is worse than no control —
          it teaches the player that the button does nothing. */}
      {hist.length > SPAN_M && (
        <div className="btn-row" style={{ marginTop: 10, alignItems: "baseline" }}>
          <span className="hint" style={{ marginRight: 4 }}>Every chart below shows</span>
          <button className={"btn" + (span === "20y" ? " btn-on" : "")} onClick={() => setSpan("20y")}
            title="The last twenty years — about one and a half cycles.">
            the last 20 years
          </button>
          <button className={"btn" + (span === "all" ? " btn-on" : "")} onClick={() => setSpan("all")}
            title="Every month since the game began.">
            all {Math.round((hist.length - 1) / 12)} years
          </button>
        </div>
      )}

      {/* ---- the general view: the city's six series, or one class in depth ---- */}
      {sel === "general" && <CityEconCharts tail={tail} spanYrs={spanYrs} />}
      {sel === "land" && <LandValueChart />}
      {sel === "banks" && <TheBanks />}
      {isClass && <>
      <div className="page-section">{SECTOR_LABEL[focus]} — {bal.state}</div>
      <div className="hint">{bal.note}</div>
      <div className="grid" style={{ marginTop: 6 }}>
        <Row k="Inventory" v={`${(stock / 1e6).toFixed(1)}M sf standing`} />
        <Row k="Vacant space" v={`${((stock * vacNow) / 1e6).toFixed(2)}M sf · ${(vacNow * 100).toFixed(1)}% against a ${(NATURAL_VAC[focus] * 100).toFixed(1)}% natural rate`} bad={bal.gap > 0.025} strong />
        {(() => {
          // Same YoY tell as the top bar — for the focused class on this page.
          if (hist.length <= 12) return null;
          const then = hist[hist.length - 13]?.vac?.[focus] ?? vacNow;
          const dpp = (vacNow - then) * 100;
          return (
            <Row
              k="Vacancy Δ / yr"
              v={`${dpp >= 0 ? "+" : ""}${dpp.toFixed(1)} pp vs twelve months ago`}
              bad={dpp >= 2}
              strong={Math.abs(dpp) >= 1}
            />
          );
        })()}
        {/* THE DEMAND LEDGER — proof that letters come from a finite looking
            book, not from empty floors. Occupied + looking pool + this month's
            requirement are the same quantities leasingOdds reads on the desk. */}
        {(() => {
          const occ = e.occupied?.[focus] ?? stock * (1 - vacNow);
          const pool = e.pool?.[focus] ?? occ;
          const housable = stock * (1 - frictionFloor(focus));
          const req = marketRequirement(e, focus);
          const looking = Math.max(0, pool - occ);
          const struct = e.structTight?.[focus] ?? 0;
          return (
            <>
              <Row k="Occupied" v={`${(occ / 1e6).toFixed(2)}M sf let`} />
              <Row
                k="Looking for space"
                v={`${(looking / 1e6).toFixed(2)}M sf in the search pool · pool capped at housable ${(housable / 1e6).toFixed(2)}M`}
                strong={looking > stock * 0.02}
              />
              <Row
                k="City needs this month"
                v={`${(req / 1_000).toFixed(0)}k sf of requirement · every LOI competes for a share of this`}
              />
              {struct > 0.02 && (
                <Row
                  k="Unmet structural demand"
                  v={`${(struct * 100).toFixed(1)}% of stock — jobs want more floors than the city can house`}
                  bad
                />
              )}
            </>
          );
        })()}
        <Row k="Under construction" v={`${((e.pipeline?.[focus] ?? 0) / 1e6).toFixed(2)}M sf · ${(((e.pipeline?.[focus] ?? 0) / stock) * 100).toFixed(1)}% of stock`} bad={(e.pipeline?.[focus] ?? 0) / stock > 0.05} />
        <Row k="Net absorption (12m)" v={`${(e.absorb12?.[focus] ?? 0) >= 0 ? "+" : ""}${((e.absorb12?.[focus] ?? 0) / 1e6).toFixed(2)}M sf`} bad={(e.absorb12?.[focus] ?? 0) < 0} />
        <Row k="Completions (12m)" v={`${((e.completions12?.[focus] ?? 0) / 1e6).toFixed(2)}M sf`} />
        <Row
          k="Months of supply"
          v={mos === null
            ? "— tenants are handing space back; the vacancy is still growing"
            : `${mos.toFixed(0)} months to clear the vacancy and the pipeline`}
          bad={mos === null || mos > 60}
        />
        {/* "93% off its long-run base" reads as a discount when the rent is
            nearly double it. Say which way it has gone. */}
        <Row k="Rent" v={(() => {
          const d = ((e.rentIdx[focus] / RENT_BASE[focus]) - 1) * 100;
          return `$${e.rentIdx[focus].toFixed(2)}/sf · ${Math.abs(d).toFixed(0)}% ${d >= 0 ? "above" : "below"} its long-run base`;
        })()} />
        {(() => {
          const history = e.history ?? [];
          const yearAgo = history.length > 12 ? history[history.length - 13] : undefined;
          const now = (e.effRentIdx?.[focus] ?? e.rentIdx[focus]) / Math.max(0.01, e.cpi ?? 1);
          const then = yearAgo
            ? (yearAgo.effRent?.[focus] ?? yearAgo.rent?.[focus] ?? e.rentIdx[focus]) / Math.max(0.01, yearAgo.cpi ?? 1)
            : now;
          const move = now / Math.max(0.01, then) - 1;
          return <Row
            k="Effective rent trend"
            v={`${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}% real over 12 months · `
              + (move > 0.025 ? "rising" : move < -0.025 ? "falling" : "flat")}
            bad={move < -0.025}
            strong
          />;
        })()}
        {/* The concession dial, read out loud. Face rates are sticky by design
            (ECONOMY.md §2c) — this row is where the market tells the truth
            before asking admits it. */}
        {(() => {
          const c = e.concIdx?.[focus] ?? 0;
          const off = c * 14;
          return <Row k="Concessions"
            v={c < 0.05 ? "none to speak of — space lets at the quoted rate"
              : `deals striking ~${off.toFixed(0)}% under asking in free rent and work${c > 0.7 ? " — landlords are capitulating" : ""}`}
            bad={c > 0.7} />;
        })()}
      </div>

      <div className="chart-grid">
        <div className="chart-cell">
          <div className="chart-title">Vacancy — {spanYrs} year{spanYrs === 1 ? "" : "s"} back, three forward</div>
          {/* The projection is appended to whatever history is selected, and
              `split` is where the record stops — so it stays the length of
              vacSeries and the dotted join lands on the right month in both
              windows. The left x-label is the first point's own month rather
              than `game.month - 240`, which only agreed with the data while
              the window was exactly 240 long. */}
          <LineChart
            series={[{ label: "vacancy", color: COLOR[focus], pts: vacWithProj }]}
            bands={[{ at: NATURAL_VAC[focus] * 100, label: "natural rate" }]}
            yFmt={pctFmt}
            split={vacSeries.length}
            xLabels={[xFrom, `${START_YEAR + Math.floor((game.month + 36) / 12)}`]}
          />
          <div className="chart-note">
            Left of the dotted line is what happened. Right of it is where vacancy goes if NOBODY starts another
            building — pipeline delivering into today's pace of absorption. Anything above the natural rate is
            space the market has to eat before rents move.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">What is coming, and when</div>
          {sched.some((v) => v > 0)
            ? <BarChart groups={pipeGroups} yFmt={sfFmt} />
            : <div className="hint" style={{ padding: "26px 0" }}>Nothing is under construction. At these rents against these build costs, no {SECTOR_LABEL[focus].toLowerCase()} scheme pencils — which is how the next shortage begins.</div>}
          <div className="chart-note">
            Square feet already under construction, by the year they deliver. Nothing here can be cancelled — the
            decision to start was taken in a market that no longer exists.
          </div>
          {/* THE CRANES BEHIND THE BARS. "400k sf is coming" is a different
              fact when one tower is most of it than when twenty infills are —
              one delivery date to watch against twenty you can ignore. These
              are the largest jobs feeding the bars, named: the city's, the
              rivals', and yours. Click one and the map takes you there. */}
          {pipeJobs.length > 0 && (
            <>
              <div className="hint" style={{ marginTop: 8 }}>
                {pipeJobs.length} building{pipeJobs.length === 1 ? "" : "s"} · {sfFmt(pipeJobsSf)} sf of{" "}
                {SECTOR_LABEL[focus].toLowerCase()} due within 24 months
              </div>
              <div className="mini-list">
                {pipeJobs.slice(0, 5).map((j) => (
                  <button key={j.bbl} className="neighbor" onClick={() => flyTo(j.bbl, true)}>
                    <span className="neighbor-addr">{j.stalled ? "⚠ " : ""}{parcels[j.bbl]?.address ?? j.bbl}</span>
                    <span className="neighbor-meta mono">
                      {j.who} · {sfFmt(j.sf)} sf{j.mixed ? " of a mixed job" : ""} · {j.floors} fl ·{" "}
                      {j.stalled ? "stalled — the sponsor is gone" : `due ${monthLabel(j.deliverM)}`}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="chart-cell">
          <div className="chart-title">Absorption vs completions, per year</div>
          <BarChart groups={flowYears} yFmt={sfFmt} />
          <div className="chart-note">
            Green up is space tenants took. Orange down is space the market delivered. When orange outruns green,
            vacancy rises no matter what anybody says about demand.
          </div>
        </div>
        <div className="chart-cell">
          <div className="chart-title">Asking rent, effective rent, and cap rate</div>
          <LineChart series={[
            { label: "asking", color: COLOR[focus], pts: rentSeries },
            { label: "effective", color: "#7d8a96", pts: effSeries, dashed: true },
          ]} yFmt={(v) => `$${v.toFixed(0)}`} height={92}
            xLabels={[xFrom, xTo]} />
          <LineChart series={[{ label: "cap", color: "#8a5620", pts: capSeries, dashed: true }]} yFmt={pctFmt} height={92}
            xLabels={[xFrom, xTo]} />
          <div className="chart-note">
            Asking is the face rate landlords quote; effective is what deals actually strike after free rent and
            work — the gap between the two lines is the concessions market saying what asking will not admit.
            Cap rate below: what the market pays for the earning. None of the three move together, and the gaps
            are most of what makes or loses money here.
          </div>
        </div>
        <div className="chart-cell">
          {/* TWO CHARTS, TWO CAPTIONS.
              This cell had one title and one note covering both, and the note
              gave the bottom chart a single compressed sentence. The owner
              screenshotted the cell asking what it was — and what they had
              screenshotted was the CONCESSION GAP, the line that sits at 14%,
              collapses to nothing for twenty years and climbs back. Nothing on
              the page said what a concession gap is. Each chart now carries its
              own heading and its own note, directly above and below itself. */}
          <div className="chart-title">Demand met vs supply built</div>
          {(() => {
            // The annual bars in the cell to the left show the FLOWS; this
            // pair shows the stocks. Running totals of the same abs/comp
            // series — when the delivered line pulls away from the absorbed
            // line, the widening wedge between them is the vacancy the market
            // has to eat, and you can see which blade of the scissors cut.
            let a = 0, c = 0;
            const absCum: number[] = [], compCum: number[] = [];
            for (const h of tail) {
              a += h.abs?.[focus] ?? 0; c += h.comp?.[focus] ?? 0;
              absCum.push(a); compCum.push(c);
            }
            // The effective-vs-asking gap as ONE line, in per cent off asking.
            // The cell above charts the same pair, but the gap is the signal
            // and reading it off the distance between two lines hides its shape.
            const gap = tail.map((h) => {
              const ask = h.rent?.[focus] ?? 0;
              return ask > 0 ? Math.max(0, 1 - (h.effRent?.[focus] ?? ask) / ask) * 100 : 0;
            });
            const xl: [string, string] = [xFrom, xTo];
            return (<>
              <LineChart height={92} series={[
                { label: "absorbed", color: "#4a7d5a", pts: absCum },
                { label: "delivered", color: "#a8562e", pts: compCum, dashed: true },
              ]} yFmt={sfFmt} zeroBase xLabels={xl} />
              <div className="chart-note">
                Both lines start at zero at the left edge: every square foot tenants have taken since then
                (solid) against every square foot finished and handed over (dashed). The dashed one only
                climbs — a building, once delivered, stays delivered. The solid one can fall, and does,
                because net absorption goes negative in a downturn when tenants hand back more space than
                they take. What matters is the distance BETWEEN them. Dashed above solid means the city
                built more than it let, and that gap is standing empty space somebody has to absorb before
                rents can move. Solid above dashed is the opposite — demand arrived and nobody built for it,
                which is how a shortage, and the rent spike that follows one, is made.
              </div>
              <div className="chart-title" style={{ marginTop: 12 }}>The concession gap</div>
              <LineChart height={92} series={[{ label: "concession gap", color: "#7d8a96", pts: gap }]}
                yFmt={pctFmt} zeroBase xLabels={xl} />
              {/* WHAT THE OWNER WAS LOOKING AT. This is the line that sits flat
                  at 14, falls to nothing, and climbs back — and until now the
                  page assumed the reader already knew what a concession is. */}
              <div className="chart-note">
                A landlord advertises a face rent — the number in the brochure. What a lease actually strikes
                at is that number minus everything thrown in to get it signed: months of free rent at the
                start, and the landlord's cash for fitting the space out. This line is the difference, as a
                percentage off the advertised rent.
              </div>
              <div className="chart-note">
                At <strong>0%</strong> nobody is discounting. Space lets at the quoted rate, the tenant pays
                every month of the term, and asking rent means what it says. That is a landlord's market.
                At <strong>14%</strong> — as wide as this market goes — the brochure is fiction: a year free
                on a ten-year deal with the landlord buying the carpet, and a building whose asking rent has
                not moved is earning a seventh less than it claims. That is a tenant's market.
              </div>
              <div className="chart-note">
                It turns before asking rent does, in both directions, and that is not a quirk of the chart.
                Free rent is reversible and a cut to the face rate is not — the quoted number is what the
                building is valued and financed off, so a landlord will give away a year before touching it,
                and will claw the giveaway back long before daring to raise the quote. So this line moves
                within months of the market turning while asking sits still for half a year or more. Watch
                this one; the rent chart is the confirmation, not the signal.
              </div>
            </>);
          })()}
        </div>
      </div>

      {/* ---- submarkets ---- */}
      <div className="page-section">Submarkets — {SECTOR_LABEL[focus]} by neighbourhood</div>
      <div className="hint">
        Computed from the actual standing stock, lot by lot, with the same occupancy and rent model the engine
        prices off — so this table and your rent roll can never disagree.
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Neighbourhood</th><th className="num">Inventory</th><th className="num">Vacancy</th>
            <th className="num">vs city</th><th className="num">Avg rent</th><th className="num">Demand</th>
            <th className="num">Vacant lots</th><th>Read</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((m) => {
            const leg = m.legs[focus];
            if (leg.sf < 20000) return null;
            const v = legVacancy(leg);
            const d = v - vacNow;
            return (
              <tr key={m.district} style={{ cursor: "default" }}>
                <td>{m.district}</td>
                <td className="num">{(leg.sf / 1e6).toFixed(2)}M sf</td>
                <td className={"num" + (v > NATURAL_VAC[focus] + 0.03 ? " neg" : "")}>{(v * 100).toFixed(1)}%</td>
                <td className="num dim">{d >= 0 ? "+" : ""}{(d * 100).toFixed(1)} pts</td>
                <td className="num">${legRent(leg).toFixed(2)}</td>
                <td className="num">{legDemand(leg).toFixed(0)}</td>
                <td className="num">{m.vacantLots}</td>
                <td className="dim">
                  {v < NATURAL_VAC[focus] - 0.02 ? "tight — push rents here"
                    : v > NATURAL_VAC[focus] + 0.04 ? "soft — buy cheap, do not build"
                    : "balanced"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </>}

      {(() => {
        const emergent = Object.values(game.blockE ?? {});
        if (!emergent.length) return null;
        const abs = emergent.map((d) => Math.abs(d));
        const max = Math.max(...abs);
        const spread = Math.max(...emergent) - Math.min(...emergent);
        return (
          <>
            <div className="page-section">Neighbourhood demand</div>
            <div className="grid">
              <Row k="Blocks drifting" v={`${emergent.length} blocks with live drift`} />
              <Row k="Largest move" v={`±${max.toFixed(0)} pts since 2000`} strong={max >= 8} />
              <Row k="Winners vs losers" v={`${spread.toFixed(0)} pt spread across the city`} />
              <Row k="Civic works" v={(() => {
                const ls = game.lines ?? [];
                const rumoured = ls.filter((l) => l.rumorM !== undefined && game.month < l.annM).length;
                const building = ls.filter((l) => game.month >= l.annM && game.month < l.openM).length;
                return `${ls.length - rumoured - building} open · ${building} building · ${rumoured} rumoured`;
              })()} />
            </div>
            <div className="hint">
              Demand is redistributive — a block gaining desirability takes it from somewhere else. Construction cranes and
              deliveries nudge blocks before lease-up; occupied stock is what holds the shift.
            </div>
          </>
        );
      })()}

      <div className="page-section">How this works</div>
      <div className="hint">
        Employment decides how much space the city's tenants want; occupancy chases that target slowly, because
        firms sign leases slowly on the way up and shed space slowly on the way down. Deliveries add stock.
        Rents move on the GAP between vacancy and its natural rate, not on the calendar — so a boom ends when
        supply catches demand and not a month before. Starts respond to the spread between rents and construction
        cost, and to vacancy, because nobody breaks ground into a glut. Your own deliveries count as supply: build
        enough of one class and you will move its vacancy against yourself.
      </div>
    </div>
  );
}

/**
 * RESEARCH — what the market is doing, as opposed to what is for sale.
 *
 * These two things were one page and they are not one job. Deciding whether to
 * buy a specific building is a different activity from forming a view on where
 * office cap rates are going, which trades are hiring, what has actually
 * traded, and which of the other firms is levering into the top. Every real
 * shop separates them and so does this now: the tape lives on Marketplace,
 * and everything you would read BEFORE looking at the tape lives here.
 */

/**
 * THE MARKETPLACE — the tape, and only the tape.
 *
 * What is actually for sale, priced against what it earns and what it is
 * worth. Everything you would read to form a view BEFORE working this list —
 * where cap rates are, which trades are hiring, what has traded, who is
 * buying — is on Research, because reading the market and shopping it are two
 * different jobs and squeezing both onto one page made neither of them good.
 */
/**
 * EVERY BUILDING IN TOWN, AS A TABLE YOU CAN WORK.
 *
 * The street answers "who owns what", firm by firm; this answers "what exists"
 * — the whole standing stock, sortable on any column, filterable by class,
 * searchable by address. It is the screen a buyer's analyst actually keeps open: sort by
 * $/sf of value against demand and the mispriced corners fall out the bottom.
 * Occupancy and value here are the same models the engine prices with, so
 * this table cannot disagree with a deal card.
 */
