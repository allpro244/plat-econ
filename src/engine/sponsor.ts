// THE SPONSOR'S NAME.
//
// Real estate is a small business at the top. The same twenty lenders see
// every deal, and a foreclosure follows a name around for a decade. This file
// is the whole of that memory: what has gone wrong under your signature, how
// long it is remembered, and what it costs you while it is.
//
// It lives apart from the debt desk on purpose. The record is a property of
// the FIRM, not of any one loan — the revolver reads it, the mortgage desk
// reads it, and one day a rival will read it too — and keeping it here means
// none of them have to import each other.
import type { GameState } from "./types";

/**
 * How long the market remembers. Ten years is not a guess: it is roughly how
 * long a foreclosure stays on the record and how long a credit officer who was
 * burned stays in the business.
 */
const MEMORY_M = 120;

/**
 * What the desk thinks of you.
 *
 * Non-recourse debt is not a free option, and treating it as one was the
 * single largest untruth left in this game. A sponsor who hands back keys does
 * lose only the asset — that much is right — but they do not walk into the
 * next credit committee unrecognised. The institutional bid disappears, the
 * spread widens, the advance rate comes down, and it stays that way for years.
 * Over a century that is the difference between leverage being a tool and
 * leverage being strictly dominant.
 *
 * Marks decay linearly to nothing over ten years, and a recourse deficiency —
 * where you personally failed to pay — weighs nearly twice a clean handback.
 */
export function sponsorStanding(s: GameState): {
  mark: number; spreadAdd: number; advanceCut: number; institutional: boolean; label: string;
} {
  let mark = 0;
  for (const e of s.sponsor?.events ?? []) {
    const age = s.month - e.m;
    if (age < 0 || age >= MEMORY_M) continue;
    const w = 1 - age / MEMORY_M;
    mark += w * (e.kind === "deficiency" ? 1.3 : e.kind === "seized" ? 1.15 : e.kind === "dpo" ? 0.5 : 0.75);
  }
  return {
    mark,
    spreadAdd: Math.min(2.6, 0.45 * mark),
    advanceCut: Math.min(0.28, 0.075 * mark),
    // past this the life companies and the agencies stop returning calls, and
    // you are financing with bridge money at bridge prices
    institutional: mark < 1.6,
    label: mark < 0.25 ? "clean"
      : mark < 0.8 ? "a mark on the record"
      : mark < 1.6 ? "watch-listed"
      : mark < 3 ? "shut out of institutional money"
      : "untouchable",
  };
}


/**
 * What a building fetches when the seller has no choice.
 *
 * A forced sale used to clear at 92% of the appraisal in every market, which
 * made an involuntary exit a mild inconvenience — and in the common case where
 * the loan was well inside the value, it actually RETURNED cash. That is not
 * what a foreclosure sale is. The bid for distressed paper disappears at
 * exactly the moment distress appears: everyone who would buy it is dealing
 * with their own balloon, and the only money in the room knows you have to
 * transact today. In a good market you lose a tenth; in a crunch you lose a
 * third, and that gap is the entire cost of having been levered into it.
 */
export function distressPrice(s: GameState): number {
  const tight = Math.max(0, 1 - (s.econ.creditIdx ?? 1));
  const down = Math.max(0, -(s.econ.cycleDev ?? 0));
  return Math.max(0.62, 0.90 - 0.22 * tight - 0.08 * down);
}

/** Record a black mark, and say so out loud. */
// "dpo" is a discounted payoff: you bought your own debt back for less than
// you owed. types.ts already listed it as an exit kind; this signature had not
// caught up, so the one path that can produce it would not compile.
export function markSponsor(s: GameState, kind: "forced" | "deficiency" | "seized" | "dpo", address: string, amount = 0) {
  if (!s.sponsor) s.sponsor = { events: [] };
  const before = sponsorStanding(s);
  s.sponsor.events.push({ m: s.month, kind, address, amount: Math.round(amount) });
  const after = sponsorStanding(s);
  if (before.institutional && !after.institutional) {
    s.news.unshift({
      q: s.month, kind: "warn",
      text: "The institutional desks have stopped returning your calls. Agency and insurance money is closed to you until this ages off the record — bridge lenders will still talk, at bridge prices.",
    });
  }
}
