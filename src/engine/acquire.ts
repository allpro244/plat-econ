// ACQUISITION, AS A NEGOTIATION.
//
// Buying was a dice roll. You named a price, an invisible seller rolled
// against it, and if you won you got exactly the building the panel described.
// That is the single most skill-intensive activity in this business reduced to
// a coin toss with no counterparty.
//
// A seller is a person with a reason. An estate wants this closed before the
// tax year turns and will take less to be certain of it. An institution
// rebalancing out of the sector wants the number and does not care who you
// are. A partnership in litigation cannot agree on anything. That is what you
// are reading across the table, and it is what decides the price.
//
// There WAS a diligence period here too — sixty days or as-is, a consultants'
// report, then close or retrade or walk. Every piece of that is real, and
// together they put four screens and two months between deciding to buy a
// building and owning it, which made the most frequent action in the game its
// slowest. An offer is a price now, and agreeing one is buying the building.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { GameState, SellerKind, Talks } from "./types";
import { logBooks, monthLabel, START_YEAR, cloneState} from "./types";
import { assetValue, resolveRec } from "./value";
import { ownerOf, gradeOf, tie } from "./rivals";
import { describeFirm } from "./firm";
import { holderOf, offend, coldOnDeed, coldRefuseMsg } from "./owners";
import { rrange } from "./market";
import { executePurchase } from "./actions";

const clone = (s: GameState): GameState => cloneState(s);

/**
 * Who is on the other side, and what they actually want.
 *
 *   certainty — how much they will discount for a clean, fast, unconditional
 *               close. An estate is desperate for it; a fund does not care.
 *   floor     — the share of appraised value below which they simply refuse.
 *   patience  — how far they will let a retrade go before telling you to leave.
 *   dawdle    — the chance in any month that they hold everything up.
 */
// WHAT THEY WILL ACTUALLY TAKE, as a share of the ask.
//
// These floors were four to twenty per cent under the asking price, which made
// the negotiation a formality: open at ninety-two and almost everybody said
// yes, on almost every building, in almost every market. A real seller with a
// building anybody else wants does not take eight per cent off because you
// asked once. Every floor moved up between five and ten points, and the
// institution — a committee with a number and no reason to like you — now
// barely moves at all. The receiver is still the cheapest money in town at
// eighty cents, because that is what a receiver is for.
// AND WHAT THEY LOOK LIKE WHEN THEY ARE NOT SELLING.
//
// `blurb` is written for the far side of a table, which assumes there is a
// table. Most of this city is not on the market and never will be, and the
// record still has to answer the first question anybody asks about a building
// they want: who has it. `holds` is that answer — what a broker tells you
// before there is a deal to discuss, and, because the same six archetypes
// carry the floors below, the first honest read on how hard the door will be.
const SELLERS: Record<SellerKind, {
  label: string; blurb: string; holds: string; certainty: number; floor: number; patience: number; dawdle: number;
}> = {
  estate: {
    label: "an estate", certainty: 0.055, floor: 0.87, patience: 0.75, dawdle: 0.06,
    blurb: "Executors, three heirs and a deadline. They want it done more than they want the last dollar.",
    holds: "It sits in an estate — executors, heirs, and a clock nobody in the family controls. That is the easiest door in this town to get open.",
  },
  institution: {
    label: "an institutional owner", certainty: 0.012, floor: 0.98, patience: 0.25, dawdle: 0.02,
    blurb: "A fund rebalancing out of the sector. They have a committee, a number, and no reason to like you.",
    holds: "An institution holds it inside a fund. There is a committee, a mandate and a hold period, and none of the three has heard of you.",
  },
  partnership: {
    label: "a partnership in dispute", certainty: 0.04, floor: 0.90, patience: 0.55, dawdle: 0.16,
    blurb: "Two partners who no longer speak. Everything takes twice as long and nobody can say yes quickly.",
    holds: "It belongs to a partnership that no longer speaks. Nothing here gets agreed once — it has to be agreed twice, by people who will not be in the same room.",
  },
  developer: {
    label: "a developer taking profits", certainty: 0.03, floor: 0.93, patience: 0.4, dawdle: 0.04,
    blurb: "They built it, they leased it, and they are recycling the equity into the next one.",
    holds: "Whoever built it still owns it. They sell when the profit is banked and the next site is under contract, which makes the timing theirs and not yours.",
  },
  local: {
    label: "a local family owner", certainty: 0.035, floor: 0.92, patience: 0.6, dawdle: 0.08,
    blurb: "They have owned it since before you were born and they are in no hurry, but they are reasonable.",
    holds: "The same family has had it for decades. They will take your call and they will not be hurried — nobody here has to sell anything.",
  },
  lender: {
    label: "a lender's receiver", certainty: 0.07, floor: 0.80, patience: 0.85, dawdle: 0.05,
    blurb: "A special servicer clearing a book. They will take a haircut to be rid of it and they will not warrant a thing.",
    holds: "A servicer is holding the file for a lender who wants it off the book. It will be sold, and it will be sold to whoever makes it easy.",
  },
};

export const sellerProfile = (k: SellerKind) => SELLERS[k];

/**
 * WHO HOLDS THE NINE BUILDINGS IN TEN THAT BELONG TO NOBODY YOU HAVE HEARD OF.
 *
 * A dozen named firms own a few hundred lots between them; the rest of the city
 * belongs to people with no press release, and for those the game's only answer
 * was a hash. The hash was worse than no answer, because it folded the listing
 * month in "so the same parcel keeps the same seller while it is up" — which
 * meant the owner of four lots in five CHANGED the month the building came to
 * market, and changed again if it was pulled and relisted. Who holds a building
 * is a fact about the building. The listing is something that happens to it.
 *
 * So the archetype is read off the record instead, the way a broker reads it
 * before he picks the phone up. Nobody's family owns half a million feet; a
 * building finished in the last fifteen years is still owned by whoever built
 * it; a walk-up put up in 1912 on a 2,400-foot lot is somebody's grandfather's
 * building, and whether that is the family or the family's executors is the one
 * question the hash is still good for.
 *
 * Nothing is written down — it is derived on read, so it survives a reload with
 * no save-format change — and it is read against today's calendar, so a
 * building that was still the developer's in 2000 has passed into somebody's
 * long hold by 2030. Measured across both towns that reassigns about a fifth of
 * the city over thirty years, which is roughly the turnover a real block has.
 *
 * What it costs you is nearly nothing in aggregate and a great deal per
 * building: the mean floor across every lot moves from 0.920 of the ask to
 * 0.914 in New Alden and from 0.921 to 0.916 in Kestrel Point, while the towers
 * get materially harder to buy and the old walk-ups get easier — which is the
 * entire point of knowing who you are talking to.
 */
export function anonymousOwner(rec: ParcelRecord | null, month: number, r: number): SellerKind {
  // Dirt is held, not run. Whoever is sitting on it is waiting for something,
  // and there is no building to read them off.
  if (!rec || !rec.bldgArea) return r < 0.4 ? "local" : r < 0.75 ? "partnership" : "developer";
  // Past the size where a building needs a management company, it belongs to
  // somebody who has one.
  if (rec.bldgArea >= 150_000) return "institution";
  if (rec.bldgArea >= 60_000 || (rec.bldgArea >= 25_000 && rec.demandScore >= 70)) {
    return r < 0.7 ? "institution" : "partnership";
  }
  const age = START_YEAR + Math.floor(month / 12) - (rec.yearBuilt || START_YEAR);
  if (age <= 15) return r < 0.65 ? "developer" : "partnership";
  // A small lot held through two generations is a family's building until the
  // generation that bought it dies, and then it is an estate.
  if (age >= 55 && rec.lotArea <= 6_000) return r < 0.62 ? "local" : "estate";
  return r < 0.34 ? "local" : r < 0.6 ? "partnership" : r < 0.82 ? "estate" : "institution";
}

/** Who owns this building — a fact about the building, not about the listing. */
export function sellerOf(s: GameState, parcels: ParcelTable, bbl: string): { kind: SellerKind; name: string; holderId?: string } {
  const rival = ownerOf(s, bbl);
  // A RECEIVER WINDING UP A NAMED FIRM IS STILL A NAMED FIRM'S BUILDING.
  // Losing a bidding war to a receiver is nothing; buying Kestrel Capital's
  // last tower out of their receivership eleven years after they outbid you
  // on it is the whole reason to have rivals.
  if (rival?.failedM !== undefined) {
    return { kind: "lender", name: `the receiver for ${rival.name}` };
  }
  if (rival) {
    return {
      kind: rival.stressMs && rival.stressMs > 4 ? "lender" : rival.style === "family" ? "local" : rival.style === "developer" ? "developer" : "institution",
      name: rival.name,
    };
  }
  const li = s.listings.find((l) => l.bbl === bbl);
  // Per parcel and nothing else — see anonymousOwner for why the listing month
  // came out of this hash.
  let h = 2166136261;
  for (const ch of bbl) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const r = ((h >>> 0) % 1000) / 1000;
  if (li?.distress) return { kind: r < 0.45 ? "lender" : r < 0.8 ? "estate" : "partnership", name: SELLERS[r < 0.45 ? "lender" : r < 0.8 ? "estate" : "partnership"].label };
  // AND THE NINE BUILDINGS IN TEN HAVE NAMES NOW. `anonymousOwner` derived a
  // correct archetype off the record and left it anonymous, so the fifty
  // biggest buildings in town were owned by fifty copies of the same sentence.
  // The register holds the same distribution of archetypes — the tier bands in
  // owners.ts are the thresholds this function used — attached to people who
  // own more than one building and remember what you did on the last one.
  const held = holderOf(s, parcels, bbl);
  if (held) return { kind: held.kind, name: held.name, holderId: held.id };
  const kind = anonymousOwner(resolveRec(parcels, s, bbl), s.month, r);
  return { kind, name: SELLERS[kind].label };
}

// ------------------------------------------------------------------ diligence



// ------------------------------------------------------------------ the ticks
/** One month of a live negotiation. */
export function tickTalks(s: GameState, parcels: ParcelTable) {
  for (const t of Object.values(s.talks ?? {})) tickOne(s, parcels, t);
  if (s.talks && !Object.keys(s.talks).length) delete s.talks;
}

function tickOne(s: GameState, parcels: ParcelTable, t: Talks) {
  // A NEGOTIATION GOES STALE. Nobody holds a number open indefinitely while
  // you think about it, and a building somebody else buys is not yours to keep
  // talking about.
  const drop = () => { if (s.talks) delete s.talks[t.bbl]; };
  // UNDER CONTRACT. Nobody takes it out from under you while the paper is
  // signed — but the closing date is real, and a buyer who cannot fund by it is
  // a buyer who loses the building and looks like an amateur doing it.
  if (t.agreed) {
    if (s.month >= (t.closeByM ?? t.openedM + CLOSE_WINDOW_M)) {
      drop();
      forfeitDeposit(s, t);
      // It genuinely goes back on the market — the listing's own clock stopped
      // while the contract ran, so give it a fresh one rather than letting it
      // vanish the same month and make a liar of the news line.
      const li = s.listings.find((l) => l.bbl === t.bbl);
      if (li && li.expiresM <= s.month) li.expiresM = s.month + 4;
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `The contract on ${parcels[t.bbl]?.address ?? t.bbl} expired unfunded. `
          + `${Cap(t.sellerName)} keeps the ${fmtM(t.deposit ?? 0)} deposit and puts it back on the market. `
          + `Signing what you cannot fund is the most expensive way there is to look serious.`,
      });
    }
    return;
  }
  const gone = !s.listings.some((l) => l.bbl === t.bbl);
  if (gone) {
    drop();
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `${parcels[t.bbl]?.address ?? t.bbl} went to somebody else while you were still talking about it.`,
    });
  } else if (s.month - t.openedM >= 3) {
    drop();
    s.news.unshift({
      q: s.month, kind: "info",
      text: `${Cap(t.sellerName)} has stopped waiting on ${parcels[t.bbl]?.address ?? t.bbl}. The building is still for sale if you want to start again.`,
    });
  }
}

// ------------------------------------------------------------- the negotiation
/**
 * BUYING, AS A CONVERSATION.
 *
 * The old model was a single roll. You named a price, an unseen seller rolled
 * against it, and a refusal printed a line of news and left you exactly where
 * you started — no counter, no number to read, no way to tell whether you were
 * two per cent away or forty. The most skill-intensive thing in this business
 * was a slot machine with a percentage on it.
 *
 * This is the same trade with the counterparty put back in the room. Every
 * seller has a RESERVATION: what they will actually take today, which is their
 * floor against appraisal, moved by who they are, what the market is doing,
 * and whether they are distressed. You cannot see it. What you can see is
 * their number, your number, how far apart they are, and how much patience is
 * left — which is precisely what you can see across a real table.
 *
 * Offer inside the reservation and it is done. Offer close and they come back
 * with a number of their own, and the gap narrows each round because both
 * sides are converging on a deal they both want. Offer far below it and they
 * tell you where they are and stop moving. Run out of rounds and the next word
 * is final.
 */
const OPEN_ROUNDS: Record<SellerKind, number> = {
  estate: 4, institution: 2, partnership: 3, developer: 3, local: 4, lender: 4,
};

/** What this seller will actually take today. Never shown to the player. */
function reservationOf(
  s: GameState, parcels: ParcelTable, bbl: string, sellerKind: SellerKind,
): { reservation: number; ask: number } {
  const prof = SELLERS[sellerKind];
  const rec = resolveRec(parcels, s, bbl);
  const li = s.listings.find((l) => l.bbl === bbl);
  const ask = li?.ask ?? (rec ? assetValue(rec, s.econ, gradeOf(s, rec)) : 0);
  // A soft market drags the floor down; a hot one lets them hold out. Distress
  // is the seller's problem and your opportunity.
  const phase = s.econ.phase === "recession" ? -0.055 : s.econ.phase === "expansion" ? 0.03 : 0;
  // THE MOTIVATION IS ALREADY IN THE ASK for voluntary sellers — the tape price
  // carries their urgency. Lender/receiver sales are different: the ask is loan
  // basis, and servicers still negotiate below it to clear the book.
  const lenderSale = !!li?.distress && (sellerKind === "lender" || li.reason === "receiver" || !!li.receiverFor || !!li.loanBasis);
  const soured = s.approaches[bbl]?.soured ?? 0;
  let floor = Math.max(0.6, prof.floor + phase + soured);
  if (li?.distress) {
    if (lenderSale) floor = Math.min(floor, 0.68 + phase);
    else floor = Math.min(floor, prof.floor - 0.04 + phase);
  }
  // A clean, unconditional close is worth real money to somebody who has been
  // retraded before, and every seller has been. With no diligence to offer,
  // every deal here IS that close — so the discount they will take for it is
  // simply part of the floor, priced by who they are.
  // ...and what you did to EVERYBODY ELSE. The per-building memory above is
  // one seller pricing one story; this is the whole street pricing the pattern.
  let reservation = Math.round((ask * floor * repFloorMult(s)) / (1 + prof.certainty));
  // THE SELLER'S OUTSIDE OPTION IS THE TAPE ITSELF. A fairly-priced listing is
  // absorbed by the rest of the market at the ASK within a few months
  // (tickListingAbsorption) — so nobody holding a healthy building takes
  // materially less from you than the street is already offering them. The
  // floor binds hardest on stale, repriced listings, which a flipper bot was
  // grinding to 0.5-0.65x appraisal. Distress is exempt: a receiver's building
  // is impaired now, and the impairment is the discount.
  if (!li?.distress && rec && rec.class !== "land") {
    const value = assetValue(rec, s.econ, gradeOf(s, rec));
    reservation = Math.max(reservation, Math.min(Math.round(ask * 0.96), Math.round(value * 0.84)));
  }
  // Lenders price at loan basis but will take a haircut below the ask to move REO.
  if (lenderSale && li?.loanBasis !== undefined && li.loanBasis > 0) {
    reservation = Math.min(reservation, Math.round(Math.min(ask, li.loanBasis) * 0.88));
  } else if (lenderSale) {
    reservation = Math.min(reservation, Math.round(ask * 0.88));
  }
  return { reservation, ask };
}

/**
 * Open a negotiation, or answer their counter with one of your own.
 *
 * THERE IS NO LENDER IN THIS FUNCTION. It used to take a product and a
 * leverage dial, because agreeing a price and funding the purchase were one
 * button — which meant the player had to pick a lender, read three coverage
 * tests and set a leverage slider before they were allowed to say a number out
 * loud. That is backwards from how anybody buys a building. You agree a price
 * first, and then you go and find the money against a deal you actually have.
 */
/**
 * How many insults the street still remembers. Three years' memory, because a
 * reputation heals the way it was earned — slowly.
 */
export function recentLowballs(s: GameState): number {
  return (s.lowballMs ?? []).filter((m) => s.month - m < 36).length;
}

/**
 * WHAT SERIAL LOWBALLING COSTS, everywhere at once. Per-building the insult
 * already shuts one door; this is the market-wide bill. One story is noise.
 * Two is a pattern. Three or more and you are "the sixty-per-cent guy", every
 * seller's floor moves up for you specifically, and the brokers ring somebody
 * else first — a price nobody quotes you and everybody charges.
 */
export function repFloorMult(s: GameState): number {
  return 1 + 0.025 * Math.min(4, Math.max(0, recentLowballs(s) - 1));
}

export function negotiate(
  s: GameState, parcels: ParcelTable, bbl: string, price: number, finalOffer = false,
): { s: GameState; err?: string; msg?: string } {
  const existing = s.talks?.[bbl];
  // HOW MANY CONVERSATIONS A SHOP THIS SIZE CAN HOLD. Not one — that was the
  // old rule and it is not how anybody buys buildings. Four, because past that
  // you are not negotiating, you are answering the phone.
  const live = Object.keys(s.talks ?? {}).length;
  if (!existing && live >= MAX_TALKS) {
    return {
      s,
      err: `You have ${live} deals on the table already. Close one, or walk away from one, `
        + `before you open another — past four you stop being able to hold the numbers in your head.`,
    };
  }
  const rec = resolveRec(parcels, s, bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  if (!s.listings.some((l) => l.bbl === bbl)) return { s, err: "That property is no longer on the market." };
  // THE DOOR YOU SHUT. An insult is not undone by clicking Offer again.
  const shut = s.approaches[bbl]?.insultedUntilM;
  if (shut !== undefined && s.month < shut) {
    return {
      s,
      err: `They are not taking your calls on this one until ${monthLabel(shut)}. `
        + `It is still for sale — just not to you.`,
    };
  }
  const px = Math.round(price);
  if (!Number.isFinite(px) || px <= 0) return { s, err: "Name a real number." };
  const li = s.listings.find((l) => l.bbl === bbl);

  // TAKE IT OR LEAVE IT MEANS EXACTLY THAT. They named a last number; coming
  // back underneath it is leaving it. The talks end — theirs was the one
  // final in this conversation that was always credible, because they can
  // just sell it to somebody else.
  if (existing?.final && px < existing.theirPrice) {
    const next0 = clone(s);
    delete next0.talks![bbl];
    next0.news.unshift({
      q: next0.month, kind: "warn",
      text: `${Cap(existing.sellerName)} said ${fmtM(existing.theirPrice)} was final at ${rec.address}, and you `
        + `came back at ${fmtM(px)}. That is an answer. The conversation is over.`,
    });
    return { s: next0, msg: "They meant final. It's over." };
  }

  const next = clone(s);
  next.talks = next.talks ?? {};
  const seller = existing
    ? { kind: existing.sellerKind, name: existing.sellerName }
    : sellerOf(next, parcels, bbl);
  const held = holderOf(next, parcels, bbl);
  const cold = coldOnDeed(next, parcels, bbl);
  if (cold) return { s, err: coldRefuseMsg(cold) };
  const { reservation, ask } = reservationOf(next, parcels, bbl, seller.kind);
  const round = (existing?.round ?? 0) + 1;
  const maxRounds = existing?.maxRounds ?? OPEN_ROUNDS[seller.kind];
  const prof = SELLERS[seller.kind];

  // --- they take it ---------------------------------------------------------
  // And that is a handshake, not a closing. The deed is reserved and the clock
  // starts; the money is the next conversation.
  if (px >= reservation) {
    const struck = strikeDeal(next, bbl, px, seller, rec.address);
    return struck.err ? { s, err: struck.err } : { s: struck.s, msg: `Agreed at ${fmtM(px)}. Now fund it.` };
  }

  // --- your own take-it-or-leave-it ----------------------------------------
  //
  // Only worth saying if the street still believes you. A buyer with a
  // lowballing reputation who says "final" is telling a joke the seller has
  // heard before — they ignore the word and counter as usual. With a clean
  // name it is a real instrument: certainty of a done deal is worth about
  // three and a half per cent to a seller who has been retraded before, and
  // every seller has been. The price of the instrument is that a no ends it —
  // for both sides.
  if (finalOffer && px < reservation) {
    // A FINAL IS ANSWERED, NOT NEGOTIATED. The word only has two replies in
    // this business — they take it or the conversation is over — and this used
    // to have a third: a buyer with a lowballing record fell through to the
    // ordinary counter machinery, so saying "best and final" and then being
    // countered was a reachable state. That is the one thing a final cannot do.
    //
    // The reputation still bites, and it bites where it belongs — on the PRICE
    // of the instrument rather than on its existence. Certainty of a done deal
    // is worth about three and a half per cent to a seller who has been
    // retraded before; a seller who has heard what your "final" means around
    // town does not pay for certainty you have not got, so the discount goes to
    // zero and the number has to clear their reserve outright.
    const credible = recentLowballs(next) < 2;
    const bar = credible ? Math.round(reservation * 0.965) : reservation;
    if (px >= bar) {
      const struck = strikeDeal(next, bbl, px, seller, rec.address);
      if (struck.err) return { s, err: struck.err };
      struck.s.news.unshift({
        q: struck.s.month, kind: "deal",
        text: `Best and final at ${rec.address}: ${fmtM(px)}, and ${seller.name} took it. `
          + (credible
            ? `A number they can close on today beat the better number they might chase for a quarter.`
            : `They did not pay a penny for your certainty — that number simply cleared their reserve.`),
      });
      return { s: struck.s, msg: `They took your final at ${fmtM(px)}.` };
    } else {
      delete next.talks[bbl];
      next.news.unshift({
        q: next.month, kind: "warn",
        text: `Best and final at ${rec.address}: ${fmtM(px)}. ${Cap(seller.name)} said no, and a final refused is `
          + `finished — you cannot say "final" and then keep talking. `
          + (credible ? "" : `They have heard what your "final" means around town, so it bought you no benefit of the doubt. `)
          + `The building is still on the tape.`,
      });
      return { s: next, msg: "They said no. Final means it's over." };
    }
  }

  // --- too far below to be worth an answer ---------------------------------
  // A seller who is a long way from you does not counter, they tell you where
  // they are. That IS the information — and it is far more use than a refusal.
  const gap = px / Math.max(1, reservation);

  // AN INSULT ENDS THE CONVERSATION.
  //
  // A lowball used to be free: they told you where they were and waited while
  // you tried again, so the optimal play was always to open at sixty per cent
  // and walk it up. Nobody sells that way. Come in far enough under and the
  // seller stops taking your calls on this building — the listing stays, the
  // number stays, and you are not the one who gets it. That is the entire cost
  // of finding out where the floor is by kicking it.
  // WHAT COUNTS AS AN INSULT, measured against the number the player can
  // actually see. This was `gap < 0.62`, a share of the seller's HIDDEN
  // reservation — and since the reservation is never below about three
  // quarters of ask, and the offer slider bottoms out at 60% OF ASK, the
  // condition was arithmetically unreachable for five of the six seller types.
  // The penalty existed and had never once fired. Anchoring it on the ask
  // makes it reachable, legible and graduated: a proud seller takes offence
  // sooner than a distressed one, because their number is nearer their floor.
  const lenderSale = !!li?.distress && (seller.kind === "lender" || li.reason === "receiver" || !!li.receiverFor || !!li.loanBasis);
  const insultAt = lenderSale
    ? Math.max(ask * 0.58, reservation * 0.82)
    : li?.distress
      ? Math.max(ask * 0.62, reservation * 0.84)
      : Math.max(ask * 0.68, reservation * 0.80);
  if (px < insultAt) {
    delete next.talks[bbl];
    // The door shuts for a year or so, and their floor for YOU goes up for
    // good. A named firm remembers harder — you will be dealing with them
    // again on other buildings.
    const rival = ownerOf(next, bbl);
    // AND THE STREET KEEPS SCORE. The comment above has been claiming a named
    // firm remembers harder; until now the memory lived on the parcel and died
    // with the listing. A principal remembers the person, not the building.
    if (rival) tie(next, rival.id).insults++;
    if (held) offend(next, held.id, 14, parcels);
    next.lowballMs = [...(next.lowballMs ?? []).filter((m) => next.month - m < 36), next.month];
    if (recentLowballs(next) === 3) {
      next.news.unshift({
        q: next.month, kind: "warn",
        text: "Word is out. Three sellers in three years have hung up on your opening number, and the story " +
          "travels: floors are higher for you now, all over town, and the brokers ring somebody else first. " +
          "It rolls off — in about three years, if you stop.",
      });
    }
    const shutM = next.month + Math.round(rrange(next, rival ? 18 : 10, rival ? 30 : 18));
    const prior = next.approaches[bbl];
    next.approaches[bbl] = {
      ...(prior ?? {}), q: next.month, refused: true,
      insultedUntilM: shutM,
      soured: Math.min(0.10, (prior?.soured ?? 0) + (rival ? 0.05 : 0.03)),
    };
    next.news.unshift({
      q: next.month, kind: "warn",
      text: `${fmtM(px)} at ${rec.address} ended it — ${((1 - px / Math.max(1, ask)) * 100).toFixed(0)}% under the ask. `
        + `${Cap(seller.name)} is not interested in a conversation that starts there. They will not take your call on this `
        + `building until ${monthLabel(shutM)}, and when they do their number will be higher than it is today. `
        + `It is still for sale — just not to you.`,
    });
    // and the tape absorbs it faster now that a serious buyer has been rebuffed
    const li2 = next.listings.find((l) => l.bbl === bbl);
    if (li2) li2.expiresM = Math.min(li2.expiresM, next.month + 2);
    return { s: next, msg: "They ended it. That was an insult, not an offer." };
  }

  // --- A BUYER WHO DOES NOT MOVE IS NOT NEGOTIATING -------------------------
  //
  // The concession machinery below converges on `max(px, reservation)` and
  // gives up MORE of the remaining gap every round — `round * 0.06` — so
  // resending the same number was strictly better than improving it: the
  // seller walked down to you and paid you for the privilege of your patience.
  // That is the one thing no seller does. Sitting on a number is a legitimate
  // tactic and it has a cost, which is that the other side eventually decides
  // you are not a buyer and goes back to the tape.
  //
  // So an unchanged offer is counted, and each repeat carries a rising chance
  // the conversation ends. Patience is the whole of the modifier because it is
  // already the seller's model of how long they will be strung along: an
  // estate winding up an entailed building waits, a fund with a quarter to
  // close does not. It is a RISK and not a rule — the last clause of the
  // owner's own request — so a stubborn buyer facing a patient seller can
  // still win by attrition, just not for free and not reliably.
  //
  // Half a per cent is the threshold for "the same number": below that you have
  // moved by less than the rounding on the offer slider, which is not a
  // concession, it is a gesture.
  const stalled = !!existing && Math.abs(px - existing.yourPrice) < Math.max(1, existing.yourPrice * 0.005);
  const stalls = stalled ? (existing?.stalls ?? 0) + 1 : 0;
  if (stalls > 0) {
    // 18% on the first repeat against a median seller, rising with each one and
    // roughly halved for the most patient. A distressed seller has the least
    // patience for it and the most reason to take the money anyway, which is
    // why patience and not desperation is the axis.
    const stallRisk = Math.min(0.72, 0.18 * stalls * (1.35 - prof.patience * 0.7));
    if (rrange(next, 0, 1) < stallRisk) {
      delete next.talks[bbl];
      const prior = next.approaches[bbl];
      next.approaches[bbl] = {
        ...(prior ?? {}), q: next.month, refused: true,
        // Not an insult — no shut-out, no reputation hit. They just stopped
        // taking this particular conversation seriously.
        soured: Math.min(0.10, (prior?.soured ?? 0) + 0.02),
      };
      next.news.unshift({
        q: next.month, kind: "warn",
        text: `${rec.address}: you came back at ${fmtM(px)} for the ${stalls === 1 ? "second" : "third"} time. `
          + `${Cap(seller.name)} has stopped waiting for you to move — the conversation is over and the building `
          + `is still on the tape.`,
      });
      return { s: next, msg: "They walked. You never moved off your number." };
    }
  }

  if (gap < 0.80 || round > maxRounds) {
    const theirs = Math.round(round > maxRounds ? reservation * 1.005 : ask * 0.985);
    next.talks[bbl] = {
      bbl, sellerKind: seller.kind, sellerName: seller.name,
      yourPrice: px, theirPrice: theirs, round, maxRounds, stalls,
      openedM: existing?.openedM ?? next.month, final: true,
      note: round > maxRounds
        ? `${Cap(seller.name)} is done moving. ${fmtM(theirs)} is the number; take it or leave it.`
        : `${Cap(seller.name)} did not counter — ${fmtM(px)} is not in the conversation. They are at ${fmtM(theirs)}.`,
    };
    return { s: next, msg: round > maxRounds ? "Their final number." : "They didn't move." };
  }

  // --- they counter ---------------------------------------------------------
  // Converging: each round the seller gives up a share of the remaining gap,
  // and the impatient ones give up more to be finished.
  //
  // ...AND A REPEATED OFFER BUYS LESS OF IT. `round * 0.06` says a seller
  // concedes faster the longer this goes on, which is true of a conversation
  // that is actually moving and false of one that is not. A buyer who has said
  // the same number twice gets the acceleration taken back off them.
  const prev = existing?.theirPrice ?? ask;
  // Early rounds used to concede ~40% of the gap on a median seller — too
  // soft for a first answer. Real talks move in smaller steps; impatience and
  // later rounds still accelerate, just from a tighter base.
  const distressBoost = li?.distress ? (lenderSale ? 0.10 : 0.06) : 0;
  const give = 0.18 + prof.patience * 0.20 + Math.max(0, round - stalls * 1.5) * 0.055 + distressBoost;
  const theirs = Math.max(reservation, Math.round(prev - (prev - Math.max(px, reservation)) * Math.min(0.80, give)));
  const roundsLeft = maxRounds - round;
  next.talks[bbl] = {
    bbl, sellerKind: seller.kind, sellerName: seller.name,
    yourPrice: px, theirPrice: theirs, round, maxRounds, stalls,
    openedM: existing?.openedM ?? next.month,
    final: roundsLeft <= 0,
    note: roundsLeft <= 0
      ? `${Cap(seller.name)} counters at ${fmtM(theirs)} and says it is the last of it.`
      : `${Cap(seller.name)} counters at ${fmtM(theirs)}. You are ${fmtM(theirs - px)} apart.`,
  };
  next.news.unshift({
    q: next.month, kind: "info",
    text: `${rec.address}: you offered ${fmtM(px)}, ${seller.name} came back at ${fmtM(theirs)}.`,
  });
  return { s: next, msg: `They countered at ${fmtM(theirs)}.` };
}

/** Take the number on the table. Also a handshake, not a closing. */
export function acceptCounter(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; err?: string; msg?: string } {
  const t = s.talks?.[bbl];
  if (!t) return { s, err: "There is nothing on the table." };
  if (t.agreed) return { s, err: "The price is already agreed. What is left is funding it." };
  const cold = coldOnDeed(s, parcels, t.bbl);
  if (cold) return { s, err: coldRefuseMsg(cold) };
  const rec = resolveRec(parcels, s, t.bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const next = clone(s);
  const struck = strikeDeal(next, t.bbl, t.theirPrice, { kind: t.sellerKind, name: t.sellerName }, rec.address);
  return struck.err ? { s, err: struck.err } : { s: struck.s, msg: `Agreed at ${fmtM(t.theirPrice)}. Now fund it.` };
}

/** How long a contract holds while you go and find the money. */
export const CLOSE_WINDOW_M = 3;
/** Conversations a firm this size can genuinely hold at once. */
export const MAX_TALKS = 4;
/**
 * EARNEST MONEY, HARD ON SIGNATURE. One and a half per cent, which is what a
 * deposit on a building of this size actually is. Credited at closing; kept by
 * the seller if the clock runs out.
 */
export const DEPOSIT_PCT = 0.015;

/**
 * A DEAD DEAL IS AN EXPENSE, NOT AN ACQUISITION.
 *
 * When the seller keeps the earnest money there is no cash movement left to
 * make — it went at the handshake — but the entry sitting in `bought` is now a
 * lie: the acquisitions line would carry the price of a building that never
 * arrived, and the player reading their own books would find $0.29M of
 * purchases against no deed. So it is reclassified where the business puts it,
 * under dead deal costs in firm overhead, which is what a forfeited deposit
 * actually is. Both legs net to zero, so the conservation identity does not
 * move; only the story the P&L tells does.
 */
function forfeitDeposit(s: GameState, t: Talks) {
  const dep = t.deposit ?? 0;
  if (dep <= 0) return;
  logBooks(s, "bought", -dep);
  logBooks(s, "ga", dep);
}

/**
 * The handshake. A price is a price and the building comes off everybody
 * else's tape, but nothing has moved: no deed, no cash, no loan. What you have
 * is three months and an obligation.
 */
/**
 * Put a price under contract with hard earnest money. Used by listed
 * negotiations and by an accepted blind off-market bid — same instrument.
 */
export function strikeDeal(
  next: GameState, bbl: string, px: number,
  seller: { kind: SellerKind; name: string }, address: string,
): { s: GameState; err?: string } {
  // YOU CANNOT SIGN WHAT YOU CANNOT PUT MONEY BEHIND. This is the constraint
  // that replaces the old one-negotiation-at-a-time rule: chase as many as you
  // like, but every handshake costs real cash the day you make it, so the
  // number of contracts you can carry is set by your balance sheet rather than
  // by an arbitrary limit in the rules.
  const dep = Math.round(px * DEPOSIT_PCT);
  if (next.cash < dep) {
    return {
      s: next,
      err: `A deposit on ${fmtM(px)} is ${fmtM(dep)} and you have ${fmtM(next.cash)}. `
        + `You cannot sign a contract you cannot put earnest money behind.`,
    };
  }
  // AND IT GOES THROUGH THE BOOKS, because it is real money leaving on a real
  // day. This wrote `cash` and told nobody: measured across five seeds, the
  // handshake month came up short by exactly the deposit every time — $0.289M,
  // $0.036M, $0.122M, $0.016M, $0.028M — a payment nobody booked. `conserve`
  // never saw it because its bot buys with `executePurchase` and has never
  // signed a contract in its life.
  //
  // It goes to `bought` on the way out and comes back off `bought` at the
  // table, which is the same treatment the auction deposit already gets
  // (auction.ts, registering bids) for the same instrument: hard money down,
  // credited if you take the deed, gone if you do not. Same quantity, one
  // answer.
  next.cash -= dep;
  logBooks(next, "bought", dep);
  const prev = next.talks?.[bbl];
  next.talks = next.talks ?? {};
  next.talks[bbl] = {
    bbl, sellerKind: seller.kind, sellerName: seller.name,
    yourPrice: px, theirPrice: px, round: prev?.round ?? 1,
    maxRounds: prev?.maxRounds ?? OPEN_ROUNDS[seller.kind],
    openedM: prev?.openedM ?? next.month,
    agreed: true, agreedPrice: px, closeByM: next.month + CLOSE_WINDOW_M, deposit: dep,
    note: `Agreed at ${fmtM(px)} with ${seller.name}. ${fmtM(dep)} of earnest money is posted and hard. `
      + `Place the debt and fund it by ${monthLabel(next.month + CLOSE_WINDOW_M)} or the deposit is theirs.`,
  };
  next.news.unshift({
    q: next.month, kind: "deal",
    text: `Under contract at ${address}: ${fmtM(px)} agreed with ${seller.name}, ${fmtM(dep)} down. `
      + `The rest is due by ${monthLabel(next.month + CLOSE_WINDOW_M)}.`,
  });
  return { s: next };
}

/**
 * FUND IT. The second half of buying a building, and now a decision of its
 * own: which desk, how much leverage, and what that does to the coverage and
 * the cheque you write. The price is already settled and cannot move here.
 */
export function closeDeal(
  s: GameState, parcels: ParcelTable, bbl: string, product: string, lev: number,
): { s: GameState; err?: string; msg?: string } {
  const t = s.talks?.[bbl];
  if (!t?.agreed || t.agreedPrice === undefined) return { s, err: "Nothing is under contract." };
  const rec = resolveRec(parcels, s, t.bbl);
  if (!rec) return { s, err: "Unknown parcel." };
  const next = clone(s);
  return closeAgreed(next, parcels, t.bbl, t.agreedPrice, product, lev,
    { kind: t.sellerKind, name: t.sellerName }, rec.address);
}

/** Leave the table. */
export function walkAway(s: GameState, parcels: ParcelTable, bbl: string): { s: GameState; msg?: string } {
  const t = s.talks?.[bbl];
  if (!t) return { s };
  const next = clone(s);
  delete next.talks![t.bbl];
  if (t.agreed) forfeitDeposit(next, t);
  const li = next.listings.find((l) => l.bbl === t.bbl);
  if (li && li.expiresM <= next.month) li.expiresM = next.month + 4;
  if (!Object.keys(next.talks ?? {}).length) delete next.talks;
  next.news.unshift({
    q: next.month, kind: t.agreed ? "warn" : "info",
    text: t.agreed
      ? `You tore up the contract on ${parcels[t.bbl]?.address ?? t.bbl}. ${Cap(t.sellerName)} keeps the `
        + `${fmtM(t.deposit ?? 0)} deposit and will remember that you could not fund it.`
      : `You walked away from ${parcels[t.bbl]?.address ?? t.bbl}. ${Cap(t.sellerName)} will remember, but the building will still be there.`,
  });
  return { s: next, msg: t.agreed ? `Contract torn up. ${fmtM(t.deposit ?? 0)} gone.` : "Walked away." };
}

/**
 * Seller labels are common nouns — "an estate", "a local partnership" — which
 * is right in the middle of a sentence and wrong at the start of one. The news
 * tape has been printing "The contract expired unfunded. an estate keeps the
 * deposit" for as long as sellers have had labels.
 */
const Cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// A $610,000 lot quoted as "$0.61M" reads like a rounding error. Money in
// this game spans four orders of magnitude and the unit has to follow it.
const fmtM = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
};

/**
 * AGREEING A PRICE IS BUYING THE BUILDING.
 *
 * There used to be a diligence period between the handshake and the keys: pick
 * sixty days or as-is, wait, read a consultants' report, then close or retrade
 * or walk. Every one of those is a real thing in the business and together
 * they were four screens and two months of waiting between deciding to buy
 * something and owning it — which made the most frequent action in the game
 * the slowest one, and put a modal in front of a decision the player had
 * already made.
 *
 * So the trade closes when it is agreed. The negotiation IS the deal now, and
 * it is the part worth playing.
 */
function closeAgreed(
  next: GameState, parcels: ParcelTable, bbl: string, px: number,
  product: string, lev: number,
  seller: { kind: SellerKind; name: string }, address: string,
): { s: GameState; err?: string; msg?: string } {
  // THE DEPOSIT COMES BACK AT THE TABLE. It was posted at handshake and it is
  // part of the price, not on top of it — so credit it before the funding test
  // runs, or a buyer who put money down would be asked for the whole price
  // again and told they were short by exactly what they had already paid.
  const dep = next.talks?.[bbl]?.deposit ?? 0;
  if (dep > 0) next.cash += dep;
  const done = executePurchase(next, parcels, bbl, px, product as never, false, lev);
  if (done.err) { if (dep > 0) next.cash -= dep; return { s: next, err: done.err }; }
  const out = done.s;
  // ...and the credit comes back off the acquisitions line, because
  // `executePurchase` has just booked the WHOLE equity cheque and the earnest
  // money is inside it. Without this the deposit is counted twice on the way
  // out and once on the way in, and the closing month reconciles a deposit
  // richer than it should — measured at exactly +$0.289M / +$0.036M / +$0.122M
  // / +$0.016M / +$0.028M on the five seeds above, the mirror image of the
  // handshake break. `bought` now totals what the building actually cost.
  if (dep > 0) logBooks(out, "bought", -dep);
  out.listings = out.listings.filter((l: { bbl: string }) => l.bbl !== bbl);
  if (out.talks) { delete out.talks[bbl]; if (!Object.keys(out.talks).length) delete out.talks; }
  out.news.unshift({
    q: out.month, kind: "deal",
    text: `${describeFirm(next)} has bought ${address} from ${seller.name} at ${fmtM(px)}.`,
  });
  return { s: out, msg: `Bought at ${fmtM(px)}.` };
}
