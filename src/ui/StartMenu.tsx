import { useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel, START_CASH_CHOICES } from "@/engine/types";
import { lifeForCash } from "@/engine/estate";
// `currentCity` is gone with the island column: there is one island and it is
// generated, so the run's island is a constant rather than a stored choice.
import { currentSize, currentDev, currentCash0 } from "@/state/city";
import { cityList, cityName, sizeList, developmentList, PROCEDURAL } from "@/citygen/index.mjs";
import { BUILD_STAMP } from "@/buildStamp";
import { usd } from "./format";

/**
 * THE START SCREEN.
 *
 * There was not one: the app generated a town on mount and the player woke up
 * in it, and the only way to ask for a different one was a dropdown hanging
 * off the top bar. With three sections in it — how big, how built up, which
 * island: fourteen options — that dropdown measured 973px tall at 1280x720,
 * putting its "Build …" confirm button 353px below the bottom of the window
 * with no way to scroll to it. A custom city was unreachable, which is to say
 * unbuildable.
 *
 * So the choice gets a room instead of a dropdown. The three questions sit in
 * columns rather than in one long list, because a column is what makes them
 * fit in a short window; the body scrolls if it does not; and the confirm
 * button lives in a footer OUTSIDE the scroller, so it cannot go off the
 * bottom of anything. Measured at 1280x720 and 1600x1000 — see the probe in
 * the report.
 *
 * Nothing is generated until Break ground is pressed. That is the other half
 * of the fault: choosing an island used to mean living with whatever town the
 * boot had already built.
 */
/**
 * What each opening actually buys, in the game's own numbers rather than in
 * adjectives. Measured: overhead starts at $57K/yr and reaches $131K by year
 * seventeen, and an idle firm holding $6M went insolvent in year fifteen on
 * overhead alone.
 */
const CASH_NOTE: Record<number, string> = {
  1_000_000: "Age 28. One small building outright, or two with debt, and almost no reserve — decades on the clock.",
  2_500_000: "Age 35. The standard opening. Room for a couple of buildings and a reserve to carry a lease-up.",
  5_000_000: "Age 42. A real first book. Enough to be wrong once and still be in business.",
  10_000_000: "Age 48. A small institutional platform. Capital bought with years you will not get back.",
  20_000_000: "Age 52. A serious acquisition book. The estate clock is already running.",
};

export default function StartMenu() {
  const phase = useStore((s) => s.phase);
  const resume = useStore((s) => s.resume);
  const building = useStore((s) => s.building);
  const loadError = useStore((s) => s.loadError);
  const startRun = useStore((s) => s.startRun);
  const continueRun = useStore((s) => s.continueRun);

  const sizes = sizeList();
  const devs = developmentList();
  // THERE IS NO ISLAND TO CHOOSE. Every new run is cut on a generated island —
  // its coast, its districts, its parks and its street names all come out of
  // the seed rolled when Break ground is pressed — so a column offering one
  // button was a control that could not be used. What this browser last played
  // is not a default any more either: the point is that it is somewhere new.
  const island = PROCEDURAL;
  const [size, setSize] = useState(currentSize());
  const [dev, setDev] = useState(currentDev());
  const [cash0, setCash0] = useState<number>(currentCash0());

  // Lot count goes as the square of the scale. The standard island is about
  // 1,420 lots measured, which is what this quotes off — it is a preview of a
  // decision, not a promise, so it is rounded hard.
  const lotsAt = (k: number) => {
    const n = 1420 * k * k;
    return n >= 1000 ? `${(n / 1000).toFixed(n < 3000 ? 1 : 0)}k` : `${Math.round(n / 50) * 50}`;
  };

  const islandName = (id: string) => cityList().find((c) => c.id === id)?.name ?? id;
  // A SAVED TOWN IS NAMED, even the generated one. The picker entry for a
  // procedural island can only say "Somewhere else", because the seed is not
  // rolled until Break ground is pressed and there is nothing yet to name. A
  // campaign is different: it carries the seed it was built from, so the
  // Continue row can say what the place is actually called rather than offering
  // to resume "Somewhere else", which is not where anyone has spent twenty
  // years.
  const townName = (id: string, seed: number) => cityName(id, seed) || islandName(id);
  const sizeName = sizes.find((s) => s.id === size)?.name ?? "City";
  const devName = devs.find((d) => d.id === dev)?.name ?? "Young town";
  if (phase === "generating") {
    return (
      <div className="start" aria-busy="true">
        <div className="start-wait">
          <div className="start-title">{building ?? "The city"}</div>
          <div className="start-wait-line">
            Cutting the blocks, drawing the lot lines, putting up what was built before you got here.
          </div>
          <div className="start-bar"><span /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="start">
      <div className="start-head">
        <div className="start-title">Broadway &amp; Wall</div>
        <div className="start-sub">A hundred years of somebody else&rsquo;s city, and whatever you can hold of it.</div>
      </div>

      <div className="start-body">
        {/* The inner block is what gets centred when the window is taller than
            the choices; it is a child of the scroller rather than the scroller
            itself, because centring a flex CONTAINER clips the top of its
            content the moment the content is taller than the box. */}
        <div className="start-inner">
          {phase === "boot" ? (
            <div className="start-boot">Looking for a game in progress&hellip;</div>
          ) : (
            <>
              {/* CONTINUE IS THE FIRST THING, because for anyone who has played
                  before it is the only thing they came here to press. It names
                  the town and the date so it is a decision and not a leap. */}
              {resume && (
                <button className="start-continue" onClick={() => void continueRun()}>
                  <span className="start-continue-l">
                    <span className="start-continue-head">Continue</span>
                    <span className="start-continue-town">
                      {townName(resume.island, resume.seed)}
                      <span className="start-continue-dim">
                        {" · "}{sizes.find((s) => s.id === resume.size)?.name ?? resume.size}
                        {" · "}{devs.find((d) => d.id === resume.dev)?.name ?? resume.dev}
                      </span>
                    </span>
                    <span className="start-continue-when">
                      {monthLabel(resume.month)} · Year {Math.floor(resume.month / 12) + 1} · {usd(resume.cash)} in hand
                    </span>
                  </span>
                  <span className="start-continue-go">Resume ▸</span>
                </button>
              )}

              <div className="start-or">{resume ? "or cut a new town" : "cut a town and break ground"}</div>

              <div className="start-cols">
                {/* HOW BIG, which is a decision about what game you are playing
                    rather than a graphics setting. Land area goes as the square
                    of the scale, so this moves the lot count from a few hundred
                    to a few thousand — and with it the standing stock, the size
                    of the banks that lend against it, rival dry powder, and how
                    much of the town one firm can ever be. Your opening cheque
                    does NOT scale: Hamlet is a concentration game, Great City
                    is a bigger pond. */}
                <div className="start-col">
                  <div className="start-col-head">how big</div>
                  <div className="start-opt-note" style={{ marginBottom: 8, padding: "0 2px" }}>
                    Same starting cash on every size. Bigger maps mean more lots, bigger banks and richer rivals — not higher rents by themselves.
                  </div>
                  {sizes.map((s) => (
                    <button
                      key={s.id}
                      className={"start-opt" + (s.id === size ? " start-opt-on" : "")}
                      onClick={() => setSize(s.id)}
                    >
                      <span className="start-opt-name">
                        {s.name}
                        <span className="start-opt-lots"> · about {lotsAt(s.k)} lots</span>
                      </span>
                      <span className="start-opt-note">{s.note}</span>
                    </button>
                  ))}
                </div>

                {/* HOW MUCH OF IT IS ALREADY THERE. Not a graphics preset: it
                    decides how many lots are still dirt and how tall what stands
                    on the rest is, which is the difference between a game about
                    building a city and a game about buying one. */}
                <div className="start-col">
                  <div className="start-col-head">how built up</div>
                  {devs.map((d) => (
                    <button
                      key={d.id}
                      className={"start-opt" + (d.id === dev ? " start-opt-on" : "")}
                      onClick={() => setDev(d.id)}
                    >
                      <span className="start-opt-name">{d.name}</span>
                      <span className="start-opt-note">{d.note}</span>
                    </button>
                  ))}
                </div>

                {/* WHAT YOU START WITH. Not a difficulty slider — the money does
                    not scale anything, it decides how many mistakes you get
                    before overhead eats you. Firm overhead runs $57K a year at
                    the start and $131K by year seventeen, and a small building
                    trades around $0.5-2.5M, so these are five different
                    openings rather than difficulty settings. */}
                <div className="start-col">
                  <div className="start-col-head">age · capital</div>
                  {START_CASH_CHOICES.map((v) => (
                    <button
                      key={v}
                      className={"start-opt" + (v === cash0 ? " start-opt-on" : "")}
                      onClick={() => setCash0(v)}
                    >
                      <span className="start-opt-name">{lifeForCash(v).age} · {usd(v)}</span>
                      <span className="start-opt-note">{CASH_NOTE[v]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* THE CONFIRM CANNOT LEAVE THE SCREEN. It is a sibling of the scroller,
          not a child of it — the old menu put it at the bottom of a 973px
          column in a 720px window and there was no way to reach it. */}
      <div className="start-foot">
        <div className="start-foot-sum">
          {/* No island name here: the island is generated when Break ground is
              pressed, so there is nothing truthful to name yet. The age and the
              bankroll are on the note line directly below rather than twice. */}
          <span className="start-foot-town">A new island · {sizeName} · {devName} · {usd(cash0)}</span>
          <span className="start-foot-note">
            Age {lifeForCash(cash0).age} with {usd(cash0)} and no holdings. The town is generated when you press this.
            {resume ? " Named saves stay on the Saves page." : ""}
            {" · "}build {BUILD_STAMP.commit} · office base ${BUILD_STAMP.rentBaseOffice}
          </span>
        </div>
        <button
          className="start-go"
          disabled={phase !== "menu"}
          onClick={() => void startRun(island, size, dev, cash0)}
        >
          Break ground ▸
        </button>
      </div>

      {loadError && <div className="start-err">{loadError}</div>}
    </div>
  );
}
