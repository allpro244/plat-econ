import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import type { Approach, GameState } from "@/engine/types";
import { assetValue, initialCondition, resolveRec, inPlace, proFormaNOIYr } from "@/engine/value";
import { APPROACH_LIFE_M } from "@/engine/sim";
import { usd, sf } from "@/ui/format";
import { useLabel, Row } from "@/ui/panels/shared";

/**
 * EVERY OFF-MARKET FILE A BROKER IS CURRENTLY SHOPPING TO YOU, soonest to
 * lapse first — which is the order a principal works them in, because the one
 * with two months left is the only one on this list that is actually a
 * decision this quarter.
 *
 * Exported because the Marketplace tab carries the count and the tab lives in
 * TopBar. One expression, two readers: a badge that disagreed with the list
 * under it would be worse than no badge.
 */
export function liveBrokerCalls(game: GameState): { bbl: string; a: Approach; lapseM: number }[] {
  return Object.entries(game.approaches)
    .filter(([bbl, a]) => a.inbound && !a.refused && !!a.ask && !game.holdings[bbl])
    .map(([bbl, a]) => ({ bbl, a, lapseM: a.q + APPROACH_LIFE_M }))
    .sort((x, y) => x.lapseM - y.lapseM || (y.a.ask ?? 0) - (x.a.ask ?? 0));
}

/**
 * WHAT THE PLAYER HAD ALREADY SEEN WHEN THEY OPENED THIS PAGE.
 *
 * The modal marked itself read by existing — you had it in front of you, so
 * you had seen it. A list does not, so the "new since you last looked" mark has
 * to be kept somewhere. It is module scope rather than game state on purpose:
 * whether a card has been glanced at is a fact about this sitting at this
 * browser, exactly like `popupsOff` and the auction card's `seenM`, and it has
 * no business travelling inside a save that another machine will load. The cost
 * is that a page reload re-marks everything live as new, which is the harmless
 * direction to be wrong in — it shows you too much, not too little.
 */
export const brokerCallsSeen = new Set<string>();
/** Files the player has explicitly put down. Same scope, same reasoning. */
export const brokerCallsAside = new Set<string>();

/**
 * A BROKER'S CALL, AS A ROW ON THE TAPE.
 *
 * This is the pop-up, whole. Every field the card printed is printed here —
 * their number, the spread to appraisal, in-place NOI, the going-in cap struck
 * on the disclosed roll, the stabilised pro-forma beside it, occupancy, demand
 * — and all three of its actions are here too, plus the fourth the card never
 * had room for. What the card could not do, and a page can, is show you the
 * four of them at once and tell you which one is about to go away.
 *
 * THE CLOCK IS THE WHOLE POINT. An off-market file is worth something because
 * it is not on the tape and it will not be here next year: sim.ts drops the
 * approach `APPROACH_LIFE_M` months after it arrives — the engine's constant,
 * imported at the top of this file rather than copied — and it drops it whether
 * or not anybody read this page. A list you can ignore forever at no cost is
 * free optionality wearing a deal's clothes, so the count rides on the tab and
 * the countdown rides on the row, both of them the engine's own number.
 */
export function BrokerCalls() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const focus = useStore((s) => s.focus);
  const setPage = useStore((s) => s.setPage);
  // A re-render hook for the two module-scope sets above — they are not store
  // state, so nothing else would notice when a row is set aside.
  const [, bump] = useState(0);
  const calls = liveBrokerCalls(game);
  // WHAT HAD ALREADY BEEN SEEN WHEN THIS PAGE OPENED — a copy, taken once, of
  // the set the effect below is about to fill in. Two things fall out of
  // snapshotting the SEEN side rather than the NEW side: the marks survive the
  // very render that clears them (otherwise the effect wipes every one before
  // the player's eye reaches the row), and a call that lands while the page is
  // sitting open is not in the snapshot either, so it arrives marked, which is
  // the moment a mark is worth the most.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seenAtOpen = useMemo(() => new Set(brokerCallsSeen), []);
  useEffect(() => {
    for (const c of calls) brokerCallsSeen.add(c.bbl);
    // A file that has lapsed is not coming back, and its bbl must not sit in
    // the seen set poisoning the mark if a broker ever rings about that same
    // building again years later.
    const liveNow = new Set(calls.map((c) => c.bbl));
    for (const b of [...brokerCallsSeen]) if (!liveNow.has(b)) brokerCallsSeen.delete(b);
    for (const b of [...brokerCallsAside]) if (!liveNow.has(b)) brokerCallsAside.delete(b);
  }, [calls]);

  // ONE PREDICATE, TWO READERS. The header count and the chip on the row have
  // to agree about what "new" means or the section says "2 new" over a list
  // with one chip in it — the same fault the tab badge was written to avoid.
  const isFresh = (bbl: string) => !seenAtOpen.has(bbl) && !brokerCallsAside.has(bbl);
  const freshCount = calls.filter((c) => isFresh(c.bbl)).length;
  return (
    <>
      <div className="page-section">
        Brokers on the phone · {calls.length}{freshCount ? ` · ${freshCount} new` : ""}
      </div>
      {calls.length === 0 && (
        <div className="hint">
          {game.brokersOff
            ? "You have told the street to stop ringing. Nothing off-market will reach you until you switch the brokers back on above."
            : "Nobody is shopping you anything off-market today. Brokers ring a principal they have closed with, "
              + "about a building that is not on the tape — it takes a couple of years of trading before the phone starts."}
        </div>
      )}
      {calls.map(({ bbl, a, lapseM }) => {
        const rec = resolveRec(parcels, game, bbl);
        if (!rec || !a.ask) return null;
        const cond = initialCondition(rec);
        const v = assetValue(rec, game.econ, cond);
        // A broker with a file has the file — the roll came over when the call
        // did (Approach.roll). So this is in-place income off the actual
        // leases, not the class model's opinion of a building like this one.
        const ip = inPlace(rec, game, bbl, a.ask);
        const noi = ip.noi;
        const goingInPct = a.ask > 0 ? (noi / a.ask) * 100 : 0;
        const stab = proFormaNOIYr(rec, game.econ, ip.h?.condition ?? cond, a.ask);
        const over = v > 0 ? (a.ask / v - 1) * 100 : 0;
        const monthsLeft = lapseM - game.month;
        const aside = brokerCallsAside.has(bbl);
        // A FILE YOU PUT DOWN IS NOT A FILE YOU HAVE NOT SEEN. The comment on
        // "Not now" below said the row "stops reading as new", and it did not:
        // `seenAtOpen` is a snapshot taken when the page mounted, so setting a
        // row aside left the NEW chip on it for the whole sitting. A prose
        // claim about a chip is exactly the sort of thing nobody re-reads, so
        // the code is the half that moved.
        const isNew = isFresh(bbl);
        return (
          <div key={bbl} className="deal" style={{ marginBottom: 10, opacity: aside ? 0.62 : 1 }}>
            <div className="deal-head">
              {isNew && <span className="chip chip-distress" style={{ marginRight: 6 }}>NEW</span>}
              ☎ {rec.address}
              <span className="dim" style={{ fontWeight: 400 }}>
                {" "}· {useLabel(rec)} · {sf(rec.bldgArea)} · {rec.floors} fl · built {rec.yearBuilt}. Not on the market.
              </span>
            </div>
            <div className="grid">
              <Row k="Their number" v={usd(a.ask)} strong />
              <Row k="vs appraisal" v={`${over >= 0 ? "+" : ""}${over.toFixed(0)}%`} bad={over > 8} />
              <Row k="In-place NOI / yr" v={usd(noi)} />
              <Row k="Going-in cap" v={`${goingInPct.toFixed(2)}%`} bad={goingInPct < game.econ.indexRate + 1.6} />
              {/* THE OTHER HALF OF AN OFFERING MEMORANDUM, labelled so the two
                  cannot be read as one number. The spread between them is the
                  value-add trade: what it earns today, and what it would earn
                  full — which is a forecast, and the seller's forecast at that. */}
              <Row k="Stabilised pro-forma" v={`${usd(stab)} · ${a.ask > 0 ? ((stab / a.ask) * 100).toFixed(2) : "—"}%`} />
              <Row k={ip.disclosed ? "Occupancy (in place)" : "Occupancy (mkt est.)"} v={`${(ip.occ * 100).toFixed(0)}%`} />
              {/* demandScore carries the generator's fractional score; the card
                  printed it raw and produced "Demand 14.870000000000001 / 100". */}
              <Row k="Demand" v={`${Math.round(rec.demandScore)} / 100`} />
              {/* THE FIELD THE CARD DID NOT HAVE TO PRINT, because a card that
                  is in your face cannot be forgotten and a row can. This is the
                  engine's own sweep date, counted down. */}
              <Row
                k="Their client will listen"
                v={monthsLeft <= 0
                  ? "the file closes this month"
                  : `for ${monthsLeft} more month${monthsLeft === 1 ? "" : "s"} — lapses ${monthLabel(lapseM)}`}
                strong={monthsLeft <= 3}
                bad={monthsLeft <= 3}
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-buy" onClick={() => { setPage("none"); focus(bbl, true); }}>
                Open the file
              </button>
              {/* "NOT NOW" IS NOT "NEVER", AND IT NEVER WAS. On the card this
                  button dismissed the interruption and did nothing to the
                  approach — the file stayed live on the desk until it lapsed,
                  which is what the Deals page comment about set-aside calls has
                  always said. It means exactly the same thing here: the row
                  dims and stops reading as new, the clock keeps running, and
                  the offer is still openable until the month it dies. */}
              <button
                className="btn"
                title="Nothing happens to the file. It stays on this page, counting down, until their client stops listening."
                onClick={() => { brokerCallsAside.add(bbl); bump((n) => n + 1); }}
              >
                {aside ? "Set aside" : "Not now"}
              </button>
              {/* AND THE MOVE THAT WAS MISSING BETWEEN THEM. There were two
                  buttons and three answers: "not now" changes nothing, "stop
                  calling me" throws the whole switch, and the ordinary reply —
                  this building is not for me, ring me about the next one — had
                  nowhere to go. So a file you had already decided against sat on
                  this page for up to a year and went on stopping auto-advance
                  through `attentionItems` every month it lived.

                  It is the engine's own lapse, taken early: see `hangUpOnCall`
                  in sim.ts, which deletes the record exactly as the twelve-month
                  sweep does and deliberately does NOT write `refused` — that
                  flag means the OWNER turned YOU away, and acquire.ts reads it
                  as such, so setting it from here would put a refusal on a
                  conversation the owner never had. */}
              <button
                className="btn"
                title="Closes this file and nothing else. The owner is not told, the street is not told, and the phone still rings about other buildings."
                onClick={() => useStore.getState().hangUpCall(bbl)}
              >
                Not for me
              </button>
              <button
                className="btn"
                title="Brokers stop ringing you entirely, about everything. The switch is in the strip at the top of this page, and in Settings."
                onClick={() => {
                  const st = useStore.getState();
                  useStore.setState({ game: { ...st.game!, brokersOff: true } });
                }}
              >
                Stop calling me
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * ADDRESSES IN THE PAPER ARE PLACES YOU CAN GO.
 *
 * `NewsItem.bbl` has existed all along, with a comment saying "a story about a
 * place can put the camera on the place" — and nothing ever set it. Measured:
 * 143 places in the engine push news and zero of them pass a bbl, so the whole
 * feature was a field, a cursor style and a plane symbol that could never fire.
 *
 * Setting it at 143 call sites is the wrong repair. Every one of those lines
 * already contains the address, spelled exactly the way the parcel record
 * spells it, because that is where the string came from — so the link can be
 * recovered at render time from the text itself, once, for every line the
 * engine has ever written and every line it will write later.
 *
 * The match is longest-first: "30 Broad St" wins over "30 Broad" so a street
 * with a shorter neighbour cannot swallow it, and a candidate that is not a
 * real address in this town simply stays plain text.
 */
