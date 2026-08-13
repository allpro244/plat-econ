// THE BROKER WHO CALLS YOU FIRST.
//
// Every fee in this town is paid to somebody with a name, and the somebody
// remembers. A principal who has closed three times through the same shop is
// the first call that shop makes when a fresh mandate lands on the desk —
// before the tape, before the email blast, before the rival across the street
// has heard the address. That first look is the entire value of the
// relationship, and it is bought the only way it can be bought: fee by fee.
//
// Three house brokerages per campaign, named off the seed. Each parcel in
// town "belongs" to one of them — the shop that has the owner's ear — so the
// relationship you build decides WHICH THIRD of the tape you hear about
// early, which is how it works when there are three shops at two bars.
//
// The window is not free to keep. An early look you let lapse is an afternoon
// the broker wasted on you, and three of those cost more goodwill than a
// closing buys. Go quiet for six years and the score halves — reputations
// heal and fade at the same speed here as everywhere else in this engine
// (see lowballMs).
//
// Nothing here draws from the RNG. Names, assignment and the look gate are
// all seed-hashed, so the campaign's every seed-pinned number reproduces and
// a save-scummer cannot reroll whose phone rings.
import type { GameState, Listing } from "./types";

/** Closings through one shop before the first looks start. Aligned with the
 * #33 seller-relationship work, where one closing (relOf.deals > 0) opens the
 * private pools — a listing shown to nobody else is a bigger favour, so it
 * costs three. */
export const EARLY_FEES = 3;
/** How long a first look stays yours alone, in months. */
export const EARLY_WINDOW_M = 2;
/** No fee for this long and the shop starts forgetting you. */
const FADE_M = 72;

const FIRSTS = ["Marsh", "Calloway", "Whitfield", "Ostrander", "Vail", "Kerrigan", "Boland", "Ashe"];
const SECONDS = ["Reade", "Colton", "Fenwick", "Drummond", "Hale", "Quinn", "Marsden", "Voss"];

function hash01(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 2246822507);
  h ^= h >>> 13; h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The three shops in this campaign's town, stable for its whole life. */
export function houseBrokerName(s: GameState, i: number): string {
  const a = FIRSTS[Math.floor(hash01(`bk:${s.seed}:${i}:a`) * FIRSTS.length)];
  const b = SECONDS[Math.floor(hash01(`bk:${s.seed}:${i}:b`) * SECONDS.length)];
  return a === b ? `${a} & Partners` : `${a} ${b}`;
}

/** Which shop has this owner's ear. Stable per parcel per campaign. */
export function brokerIdFor(s: GameState, bbl: string): string {
  return `b${Math.floor(hash01(`bkof:${s.seed}:${bbl}`) * 3)}`;
}

function relFor(s: GameState, id: string) {
  s.brokerRel = s.brokerRel ?? {};
  const i = Number(id.slice(1)) || 0;
  s.brokerRel[id] = s.brokerRel[id] ?? { name: houseBrokerName(s, i), fees: 0, lastFeeM: s.month, ignores: 0 };
  return s.brokerRel[id];
}

/** A closing paid a fee through this parcel's shop. Called from executePurchase. */
export function creditBrokerFee(s: GameState, bbl: string) {
  const rel = relFor(s, brokerIdFor(s, bbl));
  rel.fees += 1;
  rel.lastFeeM = s.month;
}

/** The live score a shop holds you at: fees earned, less looks you wasted,
 * halved once you have been quiet long enough to be a story about the past. */
export function brokerScore(s: GameState, id: string): number {
  const rel = s.brokerRel?.[id];
  if (!rel) return 0;
  const raw = rel.fees - rel.ignores;
  return s.month - rel.lastFeeM > FADE_M ? raw * 0.5 : raw;
}

/**
 * A fresh mandate just landed on a shop's desk. If the shop knows you well
 * enough, you hear about it before the tape does: the listing exists, priced,
 * but for EARLY_WINDOW_M months nobody else in town can take it. Roughly half
 * of a known shop's mandates come to you first — the other half go to the
 * other name they like, which is how it feels from the buyer's chair.
 */
export function maybeEarlyLook(s: GameState, li: Listing, address: string) {
  const id = brokerIdFor(s, li.bbl);
  if (brokerScore(s, id) < EARLY_FEES) return;
  if (hash01(`look:${s.seed}:${li.bbl}:${li.listedM}`) >= 0.5) return;
  const rel = relFor(s, id);
  li.earlyUntilM = s.month + EARLY_WINDOW_M;
  li.via = id;
  s.news.unshift({
    q: s.month, kind: "deal",
    text: `${rel.name} rang you before the tape: ${address} is coming to market at $${(li.ask / 1e6).toFixed(2)}M. `
      + `You have ${EARLY_WINDOW_M} months before anybody else hears the address.`,
  });
}

/**
 * The month a private window closes with nothing to show for it, the shop
 * notices. Called once a month before absorption reopens the building to the
 * town. An early look you acted on — a live conversation, a contract, a deed —
 * costs nothing; one you let lapse is a wasted favour.
 */
export function tickEarlyLooks(s: GameState) {
  for (const li of s.listings) {
    if (!li.via || li.earlyUntilM === undefined || s.month < li.earlyUntilM) continue;
    if (s.talks?.[li.bbl] || s.holdings[li.bbl]) { delete li.via; delete li.earlyUntilM; continue; }
    const rel = s.brokerRel?.[li.via];
    if (rel) rel.ignores += 1;
    delete li.via;
    delete li.earlyUntilM;
  }
}
