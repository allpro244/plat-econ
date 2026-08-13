// newGame + advanceMonth — the pure heart of the game. No DOM, no store:
// (state, parcels) in, state out. The UI is a lens on this.
//
// Historical name `advanceQuarter` is kept as an alias: the tick has always
// been monthly; the name was a lie that trained the wrong instinct.
import type { ParcelRecord, ParcelTable } from "@/data/types";
import type { GameState, Listing } from "./types";
import { DEFAULT_START_CASH, CENTURY_MONTHS, CASH_APY, cloneState, logBooks, monthLabel } from "./types";
import { initEcon, initStreams, rng, newsChance, rrange, tickEcon, stockFromParcels } from "./market";
import { assetValue, ownedHoldingValue, ownedHoldingNoiYr, ownedMonthlyNoi, portfolioMark, operatingStatement, physicalOcc, resolveRec } from "./value";
import { recordComp, tickLandComps } from "./comps";
import { tickPlanning } from "./zoning";
import { tickLeasing, depositsOn, stampListing, loiSigningCost, exclusiveFeeRate, agentCashReserve, loiNeedsPrincipal, vacantSf } from "./leasing";
import { tickSales, tickListingAbsorption, tickBrokerCalls, tickGroundLeases, saleTaxQuote, transferGroundLeaseOffBook } from "./actions";
import { tickTalks } from "./acquire";
import { tickLoan, productById, stackPayoff } from "./debt";
import { distressPrice, markSponsor } from "./sponsor";
import { tickLoc, coverCashShortfall, locAvailable, locRate, fundableNow } from "./credit";
import { releaseCost, tickFacility } from "./facility";
import { tickHolders } from "./owners";
import { reoAsk } from "./lenders";
import { refreshDevelopmentFeasibility, tickDevelopments, tickPrograms, tickCityGrowth, tickConstructionLeasing, tickBuildToSuit } from "./dev";
import { payrollMonthly, tickStaff, NON_PAYROLL_GA_SHARE } from "./staff";
import { ensurePeople, tickPeople, makePlayerPrincipal } from "./people";
import { tickPlayerMortality, lifeForCash } from "./estate";
import { tickFund } from "./fund";
import { maybeStampYearEndBalance } from "./books";
import { tickDemand } from "./demand";
import { initRivals, tickRivals, fundJobs, gradeOf } from "./rivals";
import { initLenders, tickLenders, chargeLenderLoss } from "./lenders";
import { generateFirmName, tickFirm, firmShort } from "./firm";
import { reconcileDemand } from "./demand";
import { tickWorkouts, couponFundable } from "./workout";
import { tickPortfolios } from "./portfoliosale";
import { tickLedger } from "./ledger";
import { tickNotes, maybeSellYourLoan } from "./notes";
import { tickPrivateCredit, tickPrivateBorrow } from "./privateCredit";
import { tickAuction } from "./auction";
import { tickPortfolio } from "./portfolio";
import { reconcileSupplyQueue, clawbackSlippedDeliveries } from "./supply";
import { tickTaxAppeals } from "./tax";
import { maybeEarlyLook } from "./broker";

const LISTING_LIFE_M: [number, number] = [6, 12];

/**
 * HOW LONG AN OFF-MARKET CONVERSATION STAYS ON THE BOOKS.
 *
 * Twelve months, and this is the ONLY place it is written down. The sweep in
 * `advanceMonth` below reads it; so does the countdown the panel prints on a
 * broker's call. It used to be a literal `12` here and a second literal `12` in
 * the parcel panel, which is one quantity with two answers waiting to happen —
 * the row would have gone on counting down to a date the engine had stopped
 * using the moment anybody touched either number.
 *
 * The figure itself is the shelf life of an owner's willingness to talk, not of
 * their price: the ask is repriced or withdrawn much sooner (see the sweep —
 * six months on the number, and immediately if the ground under it moves). A
 * year is how long a principal stays warm to a buyer they have already spoken
 * to before the conversation has to start again from a cold call.
 */
export const APPROACH_LIFE_M = 12;

/**
 * HANG UP ON ONE FILE, without hanging up on the street.
 *
 * "Stop calling me" is a switch on the whole channel — `brokersOff` silences
 * every phone in town — and "Not now" does nothing to the file at all. Neither
 * of those is the ordinary move, which is telling a broker that THIS building
 * is not for you and to ring again with the next one. Without it the only way
 * to clear a call you have already decided against was to wait out the year, so
 * the page carried dead rows and `attentionItems` kept stopping auto-advance on
 * a decision the player had made months earlier.
 *
 * This is exactly the transition the clock performs — the same `delete` the
 * lapse sweep does, up to twelve months early — which is why it needs no new
 * state and no new field. Three things it deliberately does NOT do:
 *
 *   - It does not set `refused`. That flag means the OWNER turned YOU away, and
 *     `acquire.ts` reads it as such. Writing it from a hang-up would put a
 *     refusal on a conversation the owner never had.
 *   - It does not touch `soured` or `insultedUntilM`, the two things that
 *     actually damage a relationship. It cannot: `tickBrokerCalls` skips any
 *     parcel that already carries an approach record, so a building the phone
 *     rings about has no prior memory on it to lose.
 *   - It does not reach past inbound calls. A number YOU went and asked for is
 *     yours to keep until it lapses; there is no broker on the other end of it
 *     to hang up on.
 *
 * The broker may ring about the same building again afterwards, on the same
 * hazard as any other parcel, because the record that was suppressing that is
 * the record you just closed. That is the honest consequence of an early lapse
 * and not a leak: it is what a natural lapse does too.
 */
export function hangUpOnCall(s: GameState, bbl: string): GameState {
  const a = s.approaches[bbl];
  if (!a || !a.inbound || a.refused || !a.ask) return s;
  const next = { ...s, approaches: { ...s.approaches } };
  delete next.approaches[bbl];
  return next;
}

// 0.5–1.5% of the city is on the market at any time: thin in expansions
// (owners hold), heavier in recessions (distress shakes assets loose).
/**
 * Standing inventory, as a share of the city.
 *
 * Transaction volume in this business is PROCYCLICAL and violently so. It
 * peaks with confidence and collapses in a crunch — 2009 saw volume fall by
 * four fifths — because the bid and the ask stop being in the same postcode
 * and anyone who does not have to sell simply doesn't. Having the most
 * inventory in a recession, as this did, turned every downturn into a
 * shopping trip with no downside: exactly why a hundred playthroughs showed
 * nobody able to lose.
 *
 * So: thin the tape in a crunch, and let what IS on it be distress. Waiting
 * for the bottom should be a skill that costs you patience, not a free option.
 */
function targetListings(s: GameState, totalLots: number): number {
  const base = s.econ.phase === "peak" ? 0.013
    : s.econ.phase === "expansion" ? 0.010
    : s.econ.phase === "recovery" ? 0.006
    : s.econ.phase === "depression" ? 0.004
    : 0.004;                                  // recession: the market goes quiet
  // and the credit window gates it further — no debt, no buyers, no listings
  const ci = Math.max(0.4, Math.min(1.15, s.econ.creditIdx ?? 1));
  return Math.max(4, Math.round(totalLots * base * (0.55 + 0.5 * ci)));
}

/**
 * A NEW FIRM. `cash0` is the opening bankroll the player chose on the start
 * screen — see START_CASH_CHOICES. It defaults so every existing caller,
 * harness and probe keeps working unchanged.
 */
export function newGame(
  seed: number,
  parcels?: ParcelTable,
  cash0: number = DEFAULT_START_CASH,
  age0?: number,
): GameState {
  const startAge = age0 ?? lifeForCash(cash0).age;
  const s: GameState = {
    v: 34,
    seed,
    rng: seed,
    streams: initStreams(seed),
    month: 0,
    cash: cash0,
    startAge,
    peopleRng: (seed ^ 0x50454f50) | 0,
    nextPersonId: 1,
    econ: null as never,
    holdings: {},
    listings: [],
    lois: [],
    nextLoiId: 1,
    approaches: {},
    developments: {},
    built: {},
    cityBuilt: [],
    landAdj: {},
    blockD: {},
    blockA: {},
    blockE: {},
    blockJ: {},
    lines: [],
    sponsor: { events: [] },
    rivals: [],
    lenderRel: {},
    // Sized to the town they lend to — see initLenders. A newGame with no
    // parcels (a few harnesses) falls back to the reference island.
    lenders: initLenders(parcels ? stockFromParcels(parcels) : undefined),
    // A NAME, NOT A PRONOUN. Generated from the seed so it is stable across
    // reloads of the same run, and editable from the Books page.
    firm: { ...generateFirmName(seed), foundedM: 0, epithets: [] },
    delivered: 0,
    workouts: {},
    notes: [],
    noteOffers: [],
    nextNoteId: 1,
    rivalNotes: [],
    totalLots: parcels ? Object.keys(parcels).length : 0,
    builtAtStart: parcels ? Object.values(parcels).filter((p) => p.class !== "land").length : 0,
    exchange: null,
    taxesPaid: 0,
    agent: false,
    loc: { balance: 0, drawnTotal: 0, interestPaid: 0 },
    books: [],
    nwHistory: [cash0],
    exits: [],
    milestones: {},
    news: [],
    gameOver: null,
    insolventMs: 0,
    underwaterMs: 0,
  };
  s.econ = initEcon(s, parcels);
  // Player principal BEFORE rivals so start-age draws do not depend on roster
  // size — peopleRng only; s.rng untouched.
  s.principal = makePlayerPrincipal(s, startAge);
  if (parcels) s.rivals = initRivals(s, parcels, Object.keys(parcels));
  // Fill rival principals + staff life stamps. Player already seated.
  ensurePeople(s);
  // Make the map agree with itself before anybody looks at it: what is BUILT
  // on a block is part of what makes that block valuable, and the generator's
  // gravity score did not know that. See reconcileDemand.
  if (parcels) reconcileDemand(s, parcels);
  // THE FIRST SENTENCE OF THE CAMPAIGN, AND IT HAS TO BE TRUE OF THIS CAMPAIGN.
  // It used to be a fixed string: "You arrive with $6M... Half this town is
  // still empty lots." Both halves were wrong. The bankroll is a choice of
  // $1M / $2.5M / $5M and there has been no $6M for some time, so the very
  // first thing a player read contradicted the button they had just pressed.
  // And "half" is right at no preset on the build-out ladder — it runs from
  // 69% empty at Landing to 14% at Metropolis. Both numbers are read off the
  // state now.
  const emptyPct = (() => {
    if (!parcels) return null;
    let vacant = 0, n = 0;
    for (const bbl of Object.keys(parcels)) {
      const rec = parcels[bbl];
      if (!rec) continue;
      n++;
      if (rec.class === "land" || !(rec.floors > 0)) vacant++;
    }
    return n ? Math.round((vacant / n) * 100) : null;
  })();
  const howEmpty = emptyPct === null ? "A good deal of this town is still empty lots"
    : emptyPct >= 60 ? `Nearly ${emptyPct}% of the lots here are still empty`
    : emptyPct >= 30 ? `${emptyPct}% of this town is still empty lots`
    : `Only ${emptyPct}% of it is still empty lots`;
  const sizeLabel = s.citySize === "hamlet" ? "a Hamlet"
    : s.citySize === "town" ? "a Town"
    : s.citySize === "metro" ? "a Metropolis"
    : s.citySize === "giant" ? "a Great City"
    : "the City";
  s.news.push({
    q: 0,
    kind: "info",
    text: `${monthLabel(0)}. You arrive with $${(s.cash / 1e6).toFixed(2).replace(/\.00$/, "")}M and a hundred years in ${sizeLabel}. `
      + `${howEmpty} — the city will fill in around you, with or without your name on it. `
      + (s.citySize === "hamlet" || s.citySize === "town"
        ? "This pond is small enough that one firm can matter."
        : s.citySize === "metro" || s.citySize === "giant"
          ? "Same cheque, deeper pond — rivals and bank holds are sized to the map."
          : "The standard island: banks and rivals sized to what stands here."),
  });
  return s;
}

// Rotating for-sale stock: mostly assets a $6–50M buyer can reach, with the
// occasional trophy so the skyline stays aspirational. Some sellers are
// MOTIVATED — estates, margin calls, partnership blowups — and price to move.
// That's where a sharp buyer makes their money.
/**
 * A NAMED HOLDER LEAVING THE MARKET, listed on the seller's own terms.
 *
 * `tickHolders` decides WHO is selling and why; this prices it, because there
 * is one place in this engine that knows how to write an ask and it is the
 * function below. An estate and a split partnership want it done and take the
 * distress mark; a fund with a committee and a builder recycling do not have to
 * and will not.
 */
function listHolderExit(s: GameState, parcels: ParcelTable) {
  const { bbls, distress, kind } = tickHolders(s, parcels, (gs) => rng(gs, "owners"));
  for (const bbl of bbls) {
    if (s.listings.some((l) => l.bbl === bbl) || s.holdings[bbl]) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const value = assetValue(rec, s.econ, gradeOf(s, rec));
    if (value <= 0) continue;
    const ask = Math.round(value * (distress ? rrange(s, 0.78, 0.93) : rrange(s, 0.96, 1.08)) / 1000) * 1000;
    // Only a true estate holder (or a rival-principal death in people.ts) may
    // stamp reason:"estate". Partnership/fund/developer exits used to wear that
    // badge too — Marketplace then read every book sale as an estate, and the
    // Principal mortality signal was noise. Voluntary is the honest residual.
    const reason: Listing["reason"] = kind === "estate" ? "estate" : "voluntary";
    const listing: Listing = {
      bbl, ask, listedM: s.month,
      expiresM: s.month + Math.round(rrange(s, ...LISTING_LIFE_M)),
      distress: distress || undefined,
      reason,
    };
    if (rec.class !== "land" && rec.bldgArea > 0) stampListing(s, rec, listing);
    s.listings.push(listing);
  }
}

export function refreshListings(s: GameState, parcels: ParcelTable, bbls: string[]) {
  // The register's own life runs first, so a book that came to market this
  // month is on the tape the player reads this month.
  listHolderExit(s, parcels);
  // STALE LISTINGS REPRICE DOWN — TO A FLOOR, NOT TO ZERO.
  //
  // A monthly 1.5% cut compounded for the life of a listing, and the market
  // underneath it kept moving, so an ask set at 72% of appraisal in a soft year
  // could be a fraction of appraisal by the time anybody looked at it. Nobody
  // sells a building at a tenth of what it is worth because it has been on the
  // market a while — they take it off the market, or they hold.
  //
  // The floor is 70% of TODAY'S appraisal, which is the bottom of what a real
  // discount looks like: a motivated seller, a receiver clearing a book, an
  // estate that wants it done. Below that is not a bargain, it is a bug.
  // EVERY BUILDING ON THE TAPE CARRIES ITS ROLL, whichever door it came in
  // through. Eight places push a listing — the courthouse, the package desk,
  // and five in rivals.ts where a firm sells, is squeezed, or dies — and only
  // this one used to write a roll, so a building that reached the market via a
  // rival's distress arrived with no disclosed tenancy and the panel showed a
  // market estimate the deed did not honour. Measured at 36 of 200 purchases
  // disagreeing on NOI. Stamping here catches all of them the tick after they
  // appear, and costs nothing: the roll is deterministic per building and
  // drawn from a private stream. See stampListing.
  for (const li of s.listings) {
    if (li.roll) continue;
    const r = resolveRec(parcels, s, li.bbl);
    if (r) stampListing(s, r, li);
  }
  const ASK_FLOOR = 0.70;
  // ...AND A SELLER WHOSE BUILDING HAS APPRECIATED TAKES IT OFF THE MARKET.
  //
  // The cut above only ever ratchets DOWN. An ask is priced the month it is
  // written and then trimmed 1.5% every month it does not sell, with no
  // reference to what the building is doing meanwhile — so in a market whose
  // values are rising the gap opens until the 70% floor catches it, and the
  // tape fills up with buildings sitting at the floor. Measured after the
  // zoning wire started upzoning into shortages and values began moving
  // faster: the median listing asked 0.75x appraisal, and `pnpm stress
  // --only=29` found the consequence — buy at the ask, mark at the appraisal,
  // and you are half a million dollars richer, every time, forever. That is a
  // money pump, and the only reason it is not infinite is the size of the tape.
  //
  // This engine already knows the answer, in the other half of the same
  // mechanic: an off-market quote is DELETED when the ground moves under it
  // (see the approaches block below, and its note that otherwise the ask could
  // drift to a fraction of the appraisal beside it). A seller reads the news.
  // If the market has run away from the number they wrote, they do not honour
  // it out of politeness — they withdraw, and if they still want out they come
  // back at today's price, which refreshListings gives them.
  //
  // Distress is the exception and keeps the floor: a receiver clearing a book
  // or an estate that wants it done really will take 70 cents, and that is the
  // bargain the player is supposed to be hunting for.
  const WITHDRAW_AT = 0.85;
  const withdrawn: string[] = [];
  for (const li of s.listings) {
    const rec = resolveRec(parcels, s, li.bbl);
    const v = rec ? assetValue(rec, s.econ, gradeOf(s, rec)) : 0;
    const floor = v * ASK_FLOOR;
    if (s.month - li.listedM >= 4) li.ask = Math.round(li.ask * 0.985 / 1000) * 1000;
    if (v > 0 && !li.distress && li.ask < v * WITHDRAW_AT && !s.talks?.[li.bbl]?.agreed) {
      withdrawn.push(li.bbl);
      continue;
    }
    if (floor > 0 && li.ask < floor) li.ask = Math.round(floor / 1000) * 1000;
  }
  if (withdrawn.length) {
    const pulled = new Set(withdrawn);
    s.listings = s.listings.filter((l) => !pulled.has(l.bbl));
  }
  // A listing you are under contract on does not lapse out from under you. The
  // contract has its own clock; this one stops while it runs.
  s.listings = s.listings.filter((l) =>
    (l.expiresM > s.month || s.talks?.[l.bbl]?.agreed) && !s.holdings[l.bbl]);
  const listed = new Set(s.listings.map((l) => l.bbl));
  const target = targetListings(s, bbls.length);
  const pDistress = s.econ.phase === "recession" ? 0.42 : s.econ.phase === "depression" ? 0.32
    : s.econ.phase === "recovery" ? 0.18 : 0.03;
  let guard = 0;
  // Cap consecutive rejects so a city whose deeds are mostly on hold clocks
  // does not burn thousands of assetValue calls filling a short tape — that
  // was a multi-tens-of-ms spike inside otherwise quiet Year advances.
  let rejects = 0;
  while (s.listings.length < target && guard++ < 4000 && rejects < 250) {
    const bbl = bbls[Math.floor(rng(s) * bbls.length)];
    if (listed.has(bbl) || s.holdings[bbl] || s.cityGroundLeases?.[bbl]) { rejects++; continue; }
    // A BUILDING THAT SOLD LAST YEAR IS NOT FOR SALE THIS YEAR.
    //
    // This picked a parcel at random with no memory of what had just traded,
    // so a building the market absorbed came straight back onto the tape.
    // Measured over fifty years: 68 E 10th St was sold thirty-one times and
    // 116 W 4th St twenty-nine — the same addresses, over and over, which is
    // most of why the news read as a generator rather than as a city.
    //
    // Real holds run years, and they vary: a trader is out in three, an estate
    // sits for twenty. Hash the parcel so each building keeps its own tempo
    // instead of every building sharing one cooldown.
    const traded = s.lastTradeM?.[bbl];
    if (traded !== undefined) {
      let h = 2166136261;
      for (let i = 0; i < bbl.length; i++) { h ^= bbl.charCodeAt(i); h = Math.imul(h, 16777619); }
      const hold = 34 + ((h >>> 0) % 122);          // 34 to 155 months
      if (s.month - traded < hold) { rejects++; continue; }
    }
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) { rejects++; continue; }
    const value = assetValue(rec, s.econ, gradeOf(s, rec));
    if (value <= 0) { rejects++; continue; }
    if (value > 60_000_000 && rng(s) > 0.12) { rejects++; continue; }
    rejects = 0;
    const distress = rng(s) < pDistress;
    // THE BID-ASK GAP. A seller under no pressure does not mark their building
    // to the new cap rate; they hold last year's number and wait. So in a
    // downturn the honest asks vanish and the tape fills with either dreamers
    // or people who have run out of road — and telling those apart is the job.
    const denial = s.econ.phase === "recession" ? rrange(s, 1.10, 1.28)
      : s.econ.phase === "depression" ? rrange(s, 1.06, 1.20)
      : s.econ.phase === "recovery" ? rrange(s, 1.02, 1.14)
      : rrange(s, 0.94, 1.10);
    // A lender clearing troubled paper prices at loan basis, not appraisal.
    const cl = distress ? s.cityLoans?.[bbl] : undefined;
    let ask: number;
    let loanBasis: number | undefined;
    let receiverFor: string | undefined;
    let reason: Listing["reason"] | undefined;
    if (cl && (cl.status === "watch" || cl.status === "workout")) {
      loanBasis = Math.min(value, Math.max(0, cl.balance));
      ask = reoAsk(s, value, cl.balance, cl.lender);
      receiverFor = cl.lender;
      reason = "receiver";
    } else {
      ask = Math.round(value * (distress ? rrange(s, 0.72, 0.90) : denial) / 1000) * 1000;
    }
    // THE ROLL IS WRITTEN WHEN IT COMES TO MARKET, NOT AT THE CLOSING.
    // See Listing.roll. A scratch holding is used purely as a vessel for
    // genRentRoll to fill; nothing but the roll and the residential occupancy
    // is kept, and executePurchase takes them over verbatim so the deed and
    // the offering memorandum can never disagree.
    const listing: Listing = {
      bbl,
      ask,
      listedM: s.month,
      expiresM: s.month + Math.round(rrange(s, ...LISTING_LIFE_M)),
      distress: distress || undefined,
      reason,
      receiverFor,
      loanBasis,
      // Anonymous tape inventory is not a named firm's voluntary trim —
      // `reason: "voluntary"` is reserved for rival mandate/trim exits that
      // carry a sellerId. Leaving reason unset keeps the two markets distinct.
    };
    if (rec.class !== "land" && rec.bldgArea > 0) {
      // The grade the deed will convey: today's grade, less the notch a
      // distressed building takes at the closing (see executePurchase). Stamped
      // on the listing so the tape and the deed cannot disagree about it.
      stampListing(s, rec, listing);
    }
    s.listings.push(listing);
    listed.add(bbl);
    // A shop that knows you rings before the tape prints. Seed-hashed, no draw.
    maybeEarlyLook(s, listing, rec.address);
    if (distress && newsChance(s, "motivated:" + bbl, 0.6)) {
      s.news.unshift({ q: s.month, kind: "event", text: `Motivated seller: ${rec.address} hits the tape at $${(ask / 1e6).toFixed(2)}M — well under appraisal. It won't last.` });
    }
  }
}

/**
 * One month, mutating `s` in place. The public `advanceMonth` clones first;
 * `advanceUntilAttention` clones once and then ticks many months on the copy
 * — otherwise a year click paid for twelve deep-clones of a growing save, which
 * is most of why advancing decades felt like the UI had locked up.
 */
function tickMonth(
  s: GameState, parcels: ParcelTable, bbls: string[], adjacency: Record<string, string[]> | null,
): void {
  if (s.gameOver) return;
  s.month++;

  // ONE SETTLEMENT MOMENT. Physical funding can slip or orphan a job this
  // month; those mutations used to land AFTER settleSupplyDeliveries inside
  // tickEcon, so stock could gain square feet the map never opened.
  //
  // fundJobs draws no rng — only cash and schedule — so moving it ahead of
  // tickEcon does not re-roll the century. Reconcile after it so stalled /
  // slipped dates are what the economy settles.
  reconcileSupplyQueue(s, parcels);
  fundJobs(s);
  reconcileSupplyQueue(s, parcels);
  refreshDevelopmentFeasibility(s, parcels, bbls);
  tickEcon(s);
  // The neighbourhood settles before anyone acts on it: last month's
  // deliveries and lettings are now standing, so the city, the tenants and
  // the appraisers all read the same block this month.
  tickDemand(s, parcels);
  tickStaff(s, parcels);
  // Careers accrue from the book; rival principals die on their drawn date.
  // peopleRng only for estate asks — s.rng untouched.
  tickPeople(s, parcels);
  tickPlayerMortality(s, parcels);
  tickFund(s);
  tickLenders(s);
  // Workouts run AFTER the holdings debt pass below: equity cures and this
  // month's NOI have to land before the desk decides whether to file. Running
  // them first was how a funded firm watched a foreclosure notice print in the
  // same month the cure cheque would have cleared.
  tickPortfolio(s, parcels);
  tickFirm(s, parcels);
  tickRivals(s, parcels);
  // The mortgage record reconciles against the street the moment the street
  // has finished moving, so the statement the note desk sells out of below is
  // never a month stale.
  tickLedger(s, parcels);
  // The county's calendar: notices of sale on the street, the July docket,
  // and the August hammer. It reads the street the banks have just had, and
  // it must settle BEFORE the note desk services anything it just resolved.
  tickAuction(s, parcels);
  // Private credit asks spawn from the same stress the banks just revealed;
  // funding writes Notes that tickNotes will service. Phase B borrow quotes
  // read the same month — banks that just refused a takeout.
  tickPrivateCredit(s, parcels);
  tickPrivateBorrow(s, parcels);
  // The paper desk reads the month the banks and the street have just had:
  // whose capital ratio broke, who stopped leasing, whose building sold out
  // from under whose mortgage. It cannot run before either of them.
  tickNotes(s, parcels);
  maybeSellYourLoan(s, parcels);
  tickPlanning(s, parcels, bbls);
  tickCityGrowth(s, parcels, bbls, adjacency);
  tickDevelopments(s, parcels);
  // Player site-risk can slip a job after econ settled it. Put the SF back
  // into the queue and out of stock — same identity as city funding slips.
  clawbackSlippedDeliveries(s);
  tickConstructionLeasing(s, parcels);
  tickPrograms(s, parcels);
  tickLeasing(s, parcels);
  tickGroundLeases(s, parcels);
  tickBuildToSuit(s, parcels);
  tickSales(s, parcels, adjacency);
  // The dirt reprices off what the dirt has been fetching — after the month's
  // trades have printed, so a quarter's marks read that quarter's sales.
  tickLandComps(s, parcels);
  tickBrokerCalls(s, parcels, bbls);
  tickListingAbsorption(s, parcels); // other buyers work the tape too
  tickPortfolios(s, parcels);        // and the package market, where books trade whole
  tickTalks(s, parcels);             // a negotiation left open goes stale

  // the 1031 clock: redeploy in time or the deferred tax comes due
  if (s.exchange && s.month > s.exchange.deadlineM) {
    s.cash -= s.exchange.deferredTax;
    s.taxesPaid = (s.taxesPaid ?? 0) + s.exchange.deferredTax;
    logBooks(s, "taxes", s.exchange.deferredTax);
    s.news.unshift({
      q: s.month, kind: "warn",
      text: `The 1031 clock ran out — $${(s.exchange.deferredTax / 1e6).toFixed(2)}M of deferred capital-gains tax comes due.`,
    });
    s.exchange = null;
  }

  // holdings: collect NOI, run the debt stack, finish renovations
  let monthCF = 0;
  for (const h of Object.values(s.holdings)) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    if (h.renovatingUntilM !== undefined && s.month >= h.renovatingUntilM) {
      h.condition = "good";
      h.lastCapM = s.month;
      delete h.renovatingUntilM;
      s.news.unshift({ q: s.month, kind: "deal", text: `Renovation complete at ${rec.address} — space re-opens at the new rent.` });
    }
    // Deed NOI — building roll OR the absolutely-net ground coupon. holdingNOIYr
    // is correctly zero on a leased fee (opex sits with the lessee); cash still
    // arrives as ground rent and every CF / DSCR figure has to see it.
    const noiQ = ownedMonthlyNoi(s, parcels, h);
    const debtCash = tickLoan(s, parcels, rec, h, noiQ); // may refi, sweep, or force a sale
    logBooks(s, "noi", noiQ);
    logBooks(s, "debtSvc", debtCash);
    if (!s.holdings[h.bbl]) continue; // forced sale removed it
    const cf = noiQ - debtCash;
    h.cfHistory.push(Math.round(cf));
    if (h.cfHistory.length > 40) h.cfHistory.shift();
    // Vehicle deeds keep their cash in the vehicle — promote needs a
    // counterparty, and GP liquidity is not LP capital.
    if (h.fundOwned && s.fund && !s.fund.settled) s.fund.cash += cf;
    else monthCF += cf;

    // THE QUARTERLY REPORT ON ONE ASSET. See Holding.hist — the three lines an
    // owner watches, stamped at the same moment the month's NOI is booked so
    // the history and the cheque can never disagree. Rent is the in-place
    // average over LET space, not over the building, because a half-empty
    // tower at $40 is a $40 building with a leasing problem, not a $20 one.
    // Ground-leased fees stamp the coupon (no roll of yours) so the chart does
    // not read as a permanently empty building.
    if (s.month % 3 === 0 && (rec.bldgArea > 0 || h.groundLeased)) {
      const occNow = h.groundLeased ? 1 : physicalOcc(rec, h);
      const os = h.groundLeased ? null : operatingStatement(rec, s.econ, h, s.month);
      const letSf = occNow * rec.bldgArea;
      // Contract rent on LET space — include free-rent concessions. Dividing
      // only collecting base rent by physical occupancy made a newly signed
      // abated lease look like the building had let at $0/sf.
      const rentPsf = h.groundLeased
        ? 0
        : (letSf > 0 && os ? (os.baseRent + os.freeRent) / letSf : 0);
      (h.hist ??= []).push([
        s.month,
        Math.round(occNow * 1000),
        Math.round(rentPsf * 100),
        Math.round(noiQ * 12),
      ]);
      // 100 years of quarters. Past that the early rows go, which is the right
      // end to lose: nobody underwrites off the first decade of a century-old
      // hold, and the alternative is a save that grows without limit.
      if (h.hist.length > 400) h.hist.shift();
    }
  }
  s.cash += monthCF;

  // THE FACILITY, AFTER THE BUILDINGS AND BEFORE THE OVERHEAD.
  //
  // It runs here rather than inside the loop above because it is not a fact
  // about any one building: one payment, one covenant test struck on the whole
  // pool, one cure. It takes its own cash — the same way `tickLoan` does — and
  // reports what it took so the ledger can carry it on the same line as every
  // other piece of debt service, because that is what it is.
  {
    const facCash = tickFacility(s, parcels);
    if (facCash !== 0) logBooks(s, "debtSvc", facCash);
  }

  // DEBT HAS FIRST CLAIM ON LIQUIDITY. Cover a negative balance from the line
  // before the workout desk looks at anybody, then let that desk auto-cure any
  // file the firm can fund. Order matters: NOI → debt → line → workouts.
  coverCashShortfall(s, parcels);
  tickWorkouts(s, parcels);

  // --- the firm's own overhead ----------------------------------------------
  // Every cost in this game so far has been charged to a building. Real
  // operators also carry themselves: asset management, accounting, audit,
  // legal, the insurance programme, someone to answer the phone. It is not
  // billable to a property and it does not scale one-for-one with the
  // portfolio — the tenth building is cheaper to run than the first — but it
  // never goes away, and it is why an owner of two hundred assets does not
  // simply earn a hundred times the owner of two.
  //
  // Without it a century of accumulation was a free escalator; the sub-linear
  // exponent is what keeps scale worth having while still costing something.
  {
    // Charged against what you are RESPONSIBLE for, not how many doors you
    // have: a firm running fifty million needs one analyst, a firm running
    // five billion needs a department, and the second is cheaper per dollar.
    // A per-asset charge looked reasonable and was not — it billed a small
    // operator more overhead than their building earned in NOI.
    // AND IT IS CHARGED WHETHER OR NOT YOU OWN ANYTHING. This was gated on
    // holding something, so a firm that sold its book and sat on the cash paid
    // no overhead at all and compounded at the deposit rate for as long as it
    // liked — measured at $6M to $9.9M over fifty years with nothing deducted.
    // The fixed base is small and it never goes away, which is the point: an
    // office with no buildings in it is a cost, not a strategy.
    {
      // Last month's GAV (stamped at the portfolioMark below). Re-appraising
      // the book here AND again for net worth was two full walks per tick —
      // twelve redundant appraisals on every Year click. Month-one / old saves
      // with no stamp fall back to a single mark.
      const gav = s.prevGav ?? portfolioMark(s, parcels).gav;
      // ~30bps of gross asset value a year at scale, over a small fixed base.
      //
      // THE PEOPLE CAME OUT OF THIS NUMBER. This line used to carry the whole
      // office — asset management, leasing, property management, accounting,
      // legal, insurance — as one invisible charge, which is why hiring anyone
      // would otherwise have been billing the player twice for the same
      // person. What is left here is the part you cannot hire away: the audit,
      // the lawyers, the insurance programme, the rent on the office itself.
      // The rate is cut by the share of the stack that is now explicitly
      // payroll, so a firm with nobody on the books pays what it always paid,
      // and a firm with a full desk pays that plus its actual salaries rather
      // than a phantom on top of them.
      const annual = 60_000 * s.econ.costIdx + 0.0028 * gav * NON_PAYROLL_GA_SHARE;
      const ga = Math.round(annual / 12) + payrollMonthly(s);
      s.cash -= ga;
      logBooks(s, "ga", ga);
    }
  }

  // THE PLAN THAT IS NOT BEING FUNDED. The capital plan stops on its own when
  // the money is short, which is correct and is also the least visible thing in
  // the game: buildings quietly start sliding and nothing says why. Once a year,
  // and only when it is really happening.
  if (s.month % 12 === 6) {
    const cut = Object.values(s.holdings).filter((h) => h.planCutM !== undefined && s.month - h.planCutM <= 12).length;
    if (cut > 0) {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `The capital plan went unfunded on ${cut} building${cut > 1 ? "s" : ""} this year. Deferred maintenance is the cheapest money you will ever borrow and the dearest you will ever repay — those assets are ageing faster than the rest of the book.`,
      });
    }
  }

  // Idle balances sit in a bank account and earn what a bank account earns.
  //
  // This used to float two and a half points under the loan index, which made
  // the deposit rate a macro position: in a high-rate decade doing nothing
  // compounded at five per cent and competed with underwriting buildings. It is
  // a flat one per cent now and it is deliberately dull — cash is where you
  // stand between decisions, not a strategy. It is also booked to its own line
  // rather than into NOI, because bank interest is not property income and
  // dressing it as such flattered every yield on the Books page.
  if (s.cash > 0) {
    const interest = Math.round((s.cash * CASH_APY) / 12);
    if (interest > 0) { s.cash += interest; logBooks(s, "interest", interest); }
  }

  // EXPIRE STALE OFF-MARKET ASKS — on time, and on price.
  //
  // A number holds for six months and the record for twelve. What it does not
  // do is survive the ground underneath it being repriced: an owner who quoted
  // you a figure and then watched their district get upzoned reads the news
  // like everybody else, and the old number is gone. Without this the quote was
  // a free option on a rezoning, and the ask could drift to a fraction of the
  // appraisal beside it — which is exactly what it looked like from the panel.
  for (const [bbl, a] of Object.entries(s.approaches)) {
    if (s.month > a.q + APPROACH_LIFE_M) { delete s.approaches[bbl]; continue; }
    if (a.refused || !a.ask) continue;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) continue;
    const v = assetValue(rec, s.econ, gradeOf(s, rec));
    if (v > 0 && a.ask < v * 0.85) {
      delete s.approaches[bbl];
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `${rec.address}: the owner has withdrawn their number. The ground has moved since they gave it to you.`,
      });
    }
  }

  // January: the assessor and the taxman make their rounds
  if (s.month % 12 === 0 && s.month > 0) {
    let taxable = 0;
    for (const h of Object.values(s.holdings)) {
      const rec = resolveRec(parcels, s, h.bbl);
      if (!rec) continue;
      // phased reassessment: assessed value closes a quarter of the gap to market
      // THE ASSESSOR RATCHETS. This closed a quarter of the gap in both
      // directions, which is not how a tax roll behaves anywhere on earth: an
      // assessment chases a rising market almost at once and comes down
      // grudgingly, over years, and only if somebody files and wins. That
      // asymmetry is most of what makes a downturn expensive for an owner with
      // no debt — the mortgage is the levered owner's problem, and a 1.1% bill
      // on a value that no longer exists is everybody's.
      const v = ownedHoldingValue(s, parcels, h);
      const prior = h.assessed ?? h.costBasis;
      h.assessed = Math.round(prior + (v > prior ? 0.32 : 0.09) * (v - prior));
      // taxable income: NOI less interest less straight-line depreciation
      // (2.6%/yr on the 80% of basis that's improvements, not land)
      // Taxable income includes the ground coupon on a leased fee — same deed
      // NOI the header and the debt page use. Vacant freehold dirt still has
      // no taxable NOI here (carry is not income).
      const noi = ownedHoldingNoiYr(s, parcels, h);
      const interest = h.loan ? (h.loan.balance * h.loan.ratePct) / 100 : 0;
      // Straight-line over the statutory life, on the IMPROVEMENTS only —
      // land is never depreciable. Residential rental property runs 27.5
      // years and everything else 39, which is why an apartment building
      // shelters materially more income than an office block of the same
      // price, and why the recapture bill on the way out is larger too.
      const improvements = h.costBasis * 0.8;
      const life = rec.class === "multifamily" ? 27.5 : 39;
      const deprCapacity = improvements - (h.deprTaken ?? 0);
      const depr = rec.class === "land" ? 0 : Math.max(0, Math.min(improvements / life, deprCapacity));
      h.deprTaken = (h.deprTaken ?? 0) + depr;
      taxable += noi - interest - depr; // losses net against gains across the portfolio
    }
    const tax = Math.round(Math.max(0, taxable) * 0.25);
    if (tax > 1000) {
      s.cash -= tax;
      s.taxesPaid = (s.taxesPaid ?? 0) + tax;
      logBooks(s, "taxes", tax);
      s.news.unshift({ q: s.month, kind: "info", text: `Tax season: $${(tax / 1e6).toFixed(2)}M due on last year's portfolio income (after interest and depreciation).` });
    }
  }
  // Appeal decisions follow the annual roll so a successful challenge is not
  // immediately partly undone by the same January reassessment.
  tickTaxAppeals(s, parcels);

  // THE LINE BEFORE THE BAILIFF.
  //
  // G&A and January tax can leave cash briefly negative with undrawn revolver
  // capacity still on the desk. This used to run the insolvency clock first and
  // only then call tickLoc — so a firm that covered every month-end from the
  // line still racked up twelve "insolvent" months, lost buildings to seizure,
  // and could end the run while credit remained. Real sponsors draw the
  // revolver before they are insolvent; the month has to do the same.
  tickLoc(s, parcels);   // interest, sweeps, over-advance call, and the safety draw

  // insolvency: after a year underwater the creditors don't end you — they
  // start taking things. One asset a month, sold at a distressed bid, until the
  // balance is square. You only lose when the line is exhausted and there is
  // nothing left to take.
  if (s.cash < 0) {
    s.insolventMs++;
    s.underwaterMs = (s.underwaterMs ?? 0) + 1;
    if (s.insolventMs === 6) {
      s.news.unshift({ q: s.month, kind: "warn", text: "Your lenders have noticed the negative balance. Six more months of this and they start seizing assets." });
    }
    if ((s.underwaterMs ?? 0) >= 96) {
      s.gameOver = {
        cause: "Insolvency: seven years underwater and the hole still grows. The run ends here.",
      };
      s.news.unshift({ q: s.month, kind: "warn", text: "The run is over — the creditors have waited long enough." });
    } else if (s.insolventMs >= 12) {
      // Last draw before the bailiff — if the line still covers the hole,
      // there is nothing to seize.
      coverCashShortfall(s, parcels);
      if (s.cash >= 0) {
        s.insolventMs = 0;
      } else {
      // A FILE ON THE DESK OUTRANKS THE BAILIFF.
      //
      // This seizure path predates the workout desk and ran alongside it: a
      // building could be three months into a foreclosure you were actively
      // negotiating and get taken by the general creditors instead, deleting
      // the file mid-conversation. Anything already in workout is spoken for —
      // that lender has a lien and a process, and the unsecured creditors
      // queue behind both. A note whose monthly coupon the firm can still
      // fund (cash or line) is also off-limits — that is a performing debt,
      // not salvage for the general creditors.
      const owned = Object.values(s.holdings)
        .filter((h) => !s.developments[h.bbl] && !s.workouts?.[h.bbl]
          && !(h.loan && couponFundable(s, parcels, h)));
      if (owned.length) {
        // creditors take the most valuable thing you own
        let pick = owned[0], pickV = -Infinity;
        for (const h of owned) {
          const rec = resolveRec(parcels, s, h.bbl);
          const v = rec ? ownedHoldingValue(s, parcels, h) : 0;
          if (v > pickV) { pickV = v; pick = h; }
        }
        const rec = resolveRec(parcels, s, pick.bbl)!;
        // Creditors liquidating a distressed borrower get the distressed bid,
        // not a polite 15% off — and every seizure goes on the sponsor's record.
        const gross = Math.round(pickV * Math.min(0.85, distressPrice(s)));
        // A SEIZURE IS STILL A SALE, AND A SALE HAS A WATERFALL.
        //
        // The whole gross used to land in the account. Measured on a
        // free-and-clear $15.50M building with the clock at twelve months, that
        // moved the balance from -$5.00M to +$8.03M in a single tick — 84.1% of
        // appraisal, in cash, for a deed the creditors had just carried off,
        // with no commission, no transfer stamps, no legal and no tax on the
        // gain. It made the exit you did not choose cheaper than the one you
        // did, and on an unlevered building it read to the player exactly as it
        // was: the game taking the property and paying appraisal for it.
        //
        // The order is the real one. The referee, the broker and the county are
        // paid off the top, the mortgage is a lien and takes what is left
        // before anybody else, and only the surplus after all of that reaches
        // the borrower — which on anything levered is nothing. What the sale
        // does not cover does not evaporate either: it is the lender's loss on
        // non-recourse paper and yours on paper you signed for.
        const { net, tax } = saleTaxQuote(pick, gross, s);
        // Senior + mezz — same stack as a voluntary sale. Leaving mezz off
        // the waterfall paid the sponsor Cordage's junior in cash.
        const stack = stackPayoff(pick, s.month);
        const lien = stack.balance;
        const breakFee = stack.penalty;
        // Facility collateral used to walk off at seizure with only the
        // mortgage waterfall — facility loans clear the deed mortgage, so lien
        // was $0 and tickFacility then silently dropped the BBL. Same money
        // pump a voluntary sale pays releaseCost to stop.
        const release = releaseCost(s, parcels, pick.bbl);
        const toBorrower = net - lien - breakFee - release;
        const shortfall = Math.max(0, lien + breakFee - net);
        // toBorrower can go negative when the release premium exceeds net —
        // same as acceptSaleOffer: the lien settles even if cash deepens.
        s.cash += toBorrower;
        if (toBorrower >= 0) logBooks(s, "sold", toBorrower);
        else logBooks(s, "debtSvc", -toBorrower);
        // A forced disposition is a taxable one. The bill on a gain you never
        // saw in cash is the thing that finishes a distressed sponsor, and it
        // is the reason handing back the keys beats being levied.
        if (tax > 0) {
          s.cash -= tax;
          s.taxesPaid = (s.taxesPaid ?? 0) + tax;
          logBooks(s, "taxes", tax);
        }
        if (shortfall > 0 && (pick.loan || pick.mezz)) {
          if (pick.loan?.recourse) { s.cash -= shortfall; logBooks(s, "debtSvc", shortfall); }
          else {
            // Senior eats first; Cordage takes what's left of the hole.
            const seniorHole = Math.min(shortfall, stack.seniorBal + stack.seniorPenalty);
            const mezzHole = shortfall - seniorHole;
            if (seniorHole > 0 && pick.loan) {
              chargeLenderLoss(s, pick.loan.holder ?? productById(pick.loan.product).lender, seniorHole);
            }
            if (mezzHole > 0) {
              chargeLenderLoss(s, pick.mezz?.holder ?? "Cordage Debt Partners", mezzHole);
            }
          }
        }
        if (release > 0 && s.facility) {
          s.facility.balance = Math.max(0, s.facility.balance - release);
          s.facility.bbls = s.facility.bbls.filter((b) => b !== pick.bbl);
          if (s.facility.balance <= 0) delete s.facility;
        }
        recordComp(s, rec, gross, "a distressed buyer", firmShort(s), true, pick.condition);
        s.exits.push({ bbl: pick.bbl, address: rec.address, boughtM: pick.boughtM, soldM: s.month, price: gross, basis: pick.costBasis, gain: gross - pick.costBasis, forced: true });
        if (s.groundLeases?.[pick.bbl]) transferGroundLeaseOffBook(s, pick.bbl);
        s.cash -= depositsOn(s.holdings[pick.bbl]);   // the deposits go with the deed
        s.lastTradeM = s.lastTradeM ?? {};
        s.lastTradeM[pick.bbl] = s.month;
        delete s.holdings[pick.bbl];
        if (s.workouts?.[pick.bbl]) delete s.workouts[pick.bbl];
        markSponsor(s, shortfall > 0 && pick.loan?.recourse ? "deficiency" : "seized", rec.address, shortfall);
        s.lois = s.lois.filter((l) => l.bbl !== pick.bbl);
        // A seizure can leave cash still short while the revolver still has
        // room (the sale waterfall took the deed; the line was never asked).
        // Draw before the next month's clock reads the balance.
        coverCashShortfall(s, parcels);
        s.news.unshift({
          q: s.month, kind: "warn",
          text: `The creditors took ${rec.address} — sold at $${(gross / 1e6).toFixed(2)}M, ${(100 * (1 - gross / Math.max(1, pickV))).toFixed(0)}% under the mark. `
            + (lien > 0 || release > 0
              ? shortfall > 0
                ? `It did not cover the $${(lien / 1e6).toFixed(2)}M mortgage${pick.loan?.recourse ? `, and you signed for the $${(shortfall / 1e6).toFixed(2)}M shortfall` : `, and the paper was non-recourse`}. `
                : `Liens of $${(((lien + release) / 1e6)).toFixed(2)}M came off the top and $${(Math.max(0, toBorrower) / 1e6).toFixed(2)}M of surplus reached you. `
              : `$${(Math.max(0, toBorrower) / 1e6).toFixed(2)}M reached you after the costs of the sale${tax > 0 ? ` and $${(tax / 1e6).toFixed(2)}M of tax on the gain` : ``}. `)
            + `${s.cash < 0 ? "They're not done." : "The balance is square, barely."}`,
        });
        s.insolventMs = s.cash < 0 ? 12 : 0;
      } else if (locAvailable(s, parcels) > 0 || fundableNow(s, parcels) > 0) {
        // Book empty of seizable deeds (everything in workout / development /
        // coupon-current) but liquidity remains — keep the run alive.
        coverCashShortfall(s, parcels);
        if (s.cash >= 0) s.insolventMs = 0;
      } else {
        s.gameOver = {
          cause: "Insolvency: the creditors took everything, and it wasn't enough. A hundred-year town remembers a bankruptcy.",
        };
        s.news.unshift({ q: s.month, kind: "warn", text: "The run is over — the creditors own it now." });
      }
      } // cash still negative after the last draw
    }
  } else {
    s.insolventMs = 0;
  }

  // Liquidity, not solvency: cash positive but too thin to sign the leases
  // waiting on empty floors — the trap that kills unlevered buy-and-hold.
  if (s.cash >= 0 && !s.gameOver) {
    const liquid = s.cash + locAvailable(s, parcels);
    let emptySf = 0;
    for (const h of Object.values(s.holdings)) {
      if (s.developments[h.bbl]) continue;
      const rec = resolveRec(parcels, s, h.bbl);
      if (!rec || rec.class === "land") continue;
      emptySf += vacantSf(rec, h);
    }
    if (emptySf > 8000 && liquid < Math.max(400_000, emptySf * 0.35) && s.month % 6 === 0) {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `You have ${(emptySf / 1000).toFixed(0)}k sf waiting on leases and only ${liquid >= 1e6 ? `$${(liquid / 1e6).toFixed(2)}M` : `$${(liquid / 1000).toFixed(0)}k`} of cash and line — signing costs land before rent does.`,
      });
    }
  }

  // the record book — one appraisal for NW history, milestones, and next month's overhead base
  const { nw, gav } = portfolioMark(s, parcels);
  s.prevGav = Math.round(gav);
  s.nwHistory.push(Math.round(nw));
  // DECEMBER CLOSE. The live sheet is always "today"; this freezes the same
  // marks at year-end so Books can reopen last December without a second model.
  maybeStampYearEndBalance(s, parcels);
  checkMilestones(s, nw);

  // THE QUIET DESK — how long since anybody was at the door.
  //
  // Measured over six fifty-year runs of competent play: 69.8% of months had
  // NOTHING new arrive, the first decade ran at 87%, and the longest silence
  // was 41 consecutive months. The cause is structural and it is one sentence:
  // every inbound channel in this engine is gated on the SIZE of your book.
  // LOIs need vacancy you own, offers need buildings you own, balloons need
  // loans you took. A player with two buildings gets two buildings' worth of
  // post, forever, and the front of the game is a solitaire played against a
  // listings tape that never talks back.
  //
  // So one channel gets gated on the opposite — see tickBrokerCalls. This is
  // what it reads. It counts a letter, an offer, a bid list, an off-market
  // call and a live negotiation, and nothing else: a covenant breach is a
  // condition of your own balance sheet, not a person with a file waiting for
  // an answer, and a broker deciding whose afternoon is free does not consult
  // your loan documents.
  {
    // A LETTER GOES STALE. The tour puts one to three letters on the desk at
    // once and they sit there until they expire, so counting every standing
    // letter made the desk read as busy for the whole time a single unanswered
    // choice was open — and the floor below, which exists precisely to break a
    // drought, switched itself off for the duration. Somebody at the door is
    // somebody who arrived recently. After that they are furniture.
    const atDoor = s.lois.filter((l) => s.month - (l.arrivedM ?? s.month) <= 1).length
      + Object.values(s.holdings).filter((h) => h.sale?.offer || h.sale?.bids?.length).length
      + Object.values(s.approaches).filter((a) => a.inbound && !a.refused && a.ask).length
      + Object.keys(s.talks ?? {}).length;
    s.quietMs = atDoor ? 0 : (s.quietMs ?? 0) + 1;
  }

  // The century is a marker you pass, not the end of the game. It used to set
  // gameOver and stop the run cold.
  if (!s.milestones.century && s.month >= CENTURY_MONTHS) {
    s.milestones.century = s.month;
    const built = Math.round((100 * (s.builtAtStart + Object.keys(s.built).length)) / Math.max(1, s.totalLots));
    // WHAT IT WAS WHEN YOU GOT HERE, read off the town rather than asserted.
    // This said "two-fifths empty lots" as a fixed phrase, which was true of
    // one preset on a ladder that now runs from 69% empty to 14%. Same fault as
    // the opening news item, one line apart in the same file.
    const empty0 = Math.round(100 * (1 - s.builtAtStart / Math.max(1, s.totalLots)));
    s.news.unshift({
      q: s.month, kind: "event",
      text: `◆ A hundred years. The place you arrived in was ${empty0}% empty lots; ${built}% of it stands built today, and ${Object.keys(s.holdings).length} of those buildings are yours. The clock keeps running.`,
    });
  }

  refreshListings(s, parcels, bbls);
  if (s.news.length > 120) s.news.length = 120;

  // A deed that left the book takes its leased fee with it — the lease
  // continues off-book, it does not evaporate. A creditor can seize land out
  // from under a lease at any point in the month; the ledger agrees by month-end.
  for (const bbl of Object.keys(s.groundLeases ?? {})) {
    if (!s.holdings[bbl]) transferGroundLeaseOffBook(s, bbl);
  }
  for (const [child, parent] of Object.entries(s.merged ?? {})) {
    if (s.holdings[child] && s.holdings[parent]) continue;
    delete s.merged![child];
    delete s.holdings[child];
  }
  // The same for a workout file. A deed that left the book by any route takes
  // its default with it — a file on a building you no longer own would
  // otherwise sit there and eventually foreclose on somebody else's property.
  for (const bbl of Object.keys(s.workouts ?? {})) {
    if (!s.holdings[bbl]?.loan && !(s.holdings[bbl]?.mezz?.balance)) delete s.workouts![bbl];
  }

  // PHYSICAL AND ECONOMIC AGREE AT THE MONTH BOUNDARY.
  //
  // Reconcile already runs at the top of the tick so deliveries do not land
  // from ghost jobs. Paths mid-month can still drop a cityJob (or take over a
  // frame into developments) without cancelling the matching deliveryQueue
  // row; invariants checked at month-end then see an orphan that the next
  // month's opening reconcile would have cleared. Estate-driven rival exits
  // made that race load-bearing. Close it here so the month that ends is the
  // month the gate reads.
  reconcileSupplyQueue(s, parcels);
}

export function advanceMonth(
  prev: GameState, parcels: ParcelTable, bbls: string[], adjacency: Record<string, string[]> | null = null,
): GameState {
  if (prev.gameOver) return prev;
  const s: GameState = cloneState(prev);
  tickMonth(s, parcels, bbls, adjacency);
  return s;
}

// ---- milestones: the century needs chapter markers -------------------------
export const MILESTONES: { id: string; label: string; test: (s: GameState, nw: number) => boolean }[] = [
  { id: "deed1", label: "First deed recorded", test: (s) => Object.keys(s.holdings).length + s.exits.length >= 1 },
  { id: "lease1", label: "First lease signed", test: (s) => Object.values(s.holdings).some((h) => h.tenants.some((t) => t.startM > h.boughtM)) },
  { id: "tower1", label: "First development delivered", test: (s) => Object.keys(s.built).some((b) => !s.cityBuilt.includes(b)) },
  { id: "exit1", label: "First profitable exit", test: (s) => s.exits.some((e) => !e.forced && e.gain > 0) },
  { id: "nw25", label: "Net worth $25M", test: (_s, nw) => nw >= 25e6 },
  { id: "nw100", label: "Net worth $100M", test: (_s, nw) => nw >= 100e6 },
  { id: "nw500", label: "Net worth $500M", test: (_s, nw) => nw >= 500e6 },
  { id: "nw1b", label: "The billion-dollar book", test: (_s, nw) => nw >= 1e9 },
  { id: "ten", label: "Ten buildings under management", test: (s) => Object.keys(s.holdings).length >= 10 },
  { id: "twentyfive", label: "A quarter-hundred holdings", test: (s) => Object.keys(s.holdings).length >= 25 },
  { id: "half", label: "Fifty years in town", test: (s) => s.month >= 600 },
  // PAST THE HALF CENTURY.
  //
  // The ladder used to stop here: eleven rungs, the last of them at month 600,
  // in a campaign that starts in January 2000 and has no end date. Everything
  // after year fifty was unmarked — which is a strange thing to do to the back
  // half of a hundred-year game and a stranger one when the game does not stop
  // at a hundred either.
  //
  // These are deliberately not all about the number at the bottom of the page.
  // A big book is one way to matter; owning a recognisable share of the city,
  // or having built a quarter-hundred of the buildings standing in it, is
  // another, and it is the one a hundred-year town would actually remember.
  { id: "nw5b", label: "Five billion under management", test: (_s, nw) => nw >= 5e9 },
  { id: "fifty", label: "Fifty buildings under management", test: (s) => Object.keys(s.holdings).length >= 50 },
  { id: "hundred", label: "A hundred deeds recorded", test: (s) => Object.keys(s.holdings).length + s.exits.length >= 100 },
  { id: "builder", label: "Twenty-five buildings of your own making", test: (s) => (s.delivered ?? 0) >= 25 },
  { id: "share", label: "A twentieth of the city's built stock", test: (s) =>
      Object.keys(s.holdings).length >= Math.max(12, 0.05 * (s.builtAtStart + Object.keys(s.built).length)) },
  { id: "diamond", label: "Seventy-five years in town", test: (s) => s.month >= 900 },
  { id: "sesqui", label: "A hundred and fifty years in town", test: (s) => s.month >= 1800 },
  { id: "bicent", label: "Two centuries in town", test: (s) => s.month >= 2400 },
];

function checkMilestones(s: GameState, nw: number) {
  for (const m of MILESTONES) {
    if (s.milestones[m.id] === undefined && m.test(s, nw)) {
      s.milestones[m.id] = s.month;
      s.news.unshift({ q: s.month, kind: "event", text: `◆ Milestone: ${m.label}.` });
    }
  }
}

/**
 * YOUR BOOK, NOT THE CITY'S CYCLE.
 *
 * Market phase is a city fact. A firm can drown in an expansion — measured in
 * playthroughs as hundreds of months labelled boom while the LOC ate the
 * firm. The HUD must not rename the cycle; it must say the book is in trouble
 * next to it.
 */
export function firmBookStress(s: GameState): { label: string; bad: boolean; title: string } {
  const workouts = Object.keys(s.workouts ?? {}).length;
  if ((s.insolventMs ?? 0) > 0) {
    return {
      label: "insolvent",
      bad: true,
      title: `Insolvency month ${s.insolventMs} of 12 — the city cycle is still ${s.econ.phase}; your book is not.`,
    };
  }
  if (workouts > 0) {
    return {
      label: workouts === 1 ? "workout" : `${workouts} workouts`,
      bad: true,
      title: `${workouts} deed${workouts === 1 ? "" : "s"} in workout. City phase: ${s.econ.phase}.`,
    };
  }
  if ((s.locOverMs ?? 0) >= 3) {
    return {
      label: "over line",
      bad: true,
      title: `Credit line over-advanced ${s.locOverMs} months — the bank has stopped asking politely. City phase: ${s.econ.phase}.`,
    };
  }
  if ((s.locOverMs ?? 0) > 0) {
    return {
      label: "watch",
      bad: true,
      title: `Credit line over-advanced. Pay it down before it becomes a default. City phase: ${s.econ.phase}.`,
    };
  }
  if (s.cash < 0) {
    return {
      label: "short",
      bad: true,
      title: `Cash is negative — the insolvency clock starts if the line cannot cover it. City phase: ${s.econ.phase}.`,
    };
  }
  const monthlyDebt = Object.values(s.holdings).reduce(
    (a, h) => a + (h.loan?.monthlyPmt ?? 0) + (h.mezz?.monthlyPmt ?? 0), 0,
  )
    + (s.facility?.monthlyPmt ?? 0)
    + ((s.loc?.balance ?? 0) * ((s.econ.indexRate ?? 0) + 4)) / 100 / 12;
  if (monthlyDebt > 0 && s.cash < monthlyDebt * 3) {
    return {
      label: "thin",
      bad: true,
      title: `Cash covers less than three months of debt service. City phase: ${s.econ.phase}.`,
    };
  }
  return {
    label: "steady",
    bad: false,
    title: `Your book is current. City cycle: ${s.econ.phase} — that label is about the street, not your firm.`,
  };
}

// ---- attention: what needs the player right now ----------------------------
// Auto-advance stops when a NEW item appears on this list.
export function attentionItems(s: GameState): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  // Only letters the principal still owns — firm agent, exclusive, staff desk
  // or renewal management already worked the rest. Counting every LOI here is
  // why Year/Skip kept stopping for paper somebody else was hired to handle.
  for (const l of s.lois) {
    if (!loiNeedsPrincipal(s, l)) continue;
    out.push({ key: `loi:${l.id}`, label: `LOI from ${l.name} — answer by ${monthLabel(l.expiresM)}` });
  }
  // Tenant-relief letters expire in three months and a lapse is a refusal.
  // They lived on Deals but not in the attention list, so Year/Skip could run
  // straight past a decision the player had explicitly asked the game to stop
  // for. Each letter gets its own key because several tenants can ask together.
  for (const a of s.asks ?? []) {
    if (s.holdings[a.bbl]?.groundLeased) continue;
    out.push({ key: `tenant-ask:${a.id}`, label: `${a.name} is asking for rent relief — answer by ${monthLabel(a.expiresM)}` });
  }
  for (const b of s.portfolioSale?.bids ?? []) {
    out.push({ key: `portfolio-bid:${b.name}:${b.price}`, label: `${b.name} bid on your portfolio` });
  }
  for (const [bbl, a] of Object.entries(s.approaches)) {
    // Marketplace already lists live broker calls. Stopping Skip every month
    // a file sits on the phone is noise — stop only when the conversation is
    // about to lapse and a decision is actually required.
    if (a.inbound && !a.refused && a.ask) {
      const left = a.q + APPROACH_LIFE_M - s.month;
      if (left <= 2) {
        out.push({
          key: `broker:${bbl}:${a.q}`,
          label: left <= 0
            ? "A broker's off-market file is lapsing this month"
            : `A broker's off-market file lapses in ${left} month${left === 1 ? "" : "s"}`,
        });
      }
    }
  }
  for (const h of Object.values(s.holdings)) {
    if (h.sale?.offer) out.push({ key: `offer:${h.bbl}:${h.sale.offer.price}`, label: `Offer in hand — good until ${monthLabel(h.sale.offer.expiresM)}` });
    // A marketed bid list is the same kind of decision as a quiet offer — it
    // expires, and Year/Skip used to run straight past it because only
    // `sale.offer` was on this list.
    if (h.sale?.bids?.length) {
      const top = h.sale.bids[0];
      out.push({
        key: `sale-bids:${h.bbl}:${top.name}:${top.price}:${h.sale.bids.length}`,
        label: `${h.sale.bids.length} bid${h.sale.bids.length === 1 ? "" : "s"} on ${h.bbl} — best ${top.name}`,
      });
    }
    // Lease rolls, renewals and capital-plan alarms are landlord business —
    // not the fee owner's when a ground lessee runs the building. Debt on the
    // leased fee still belongs to you and must keep stopping Skip below.
    if (!h.groundLeased) {
      for (const t of h.tenants) {
        if (t.nonRenewM === s.month) {
          out.push({
            key: `nonrenew:${h.bbl}:${t.name}:${t.startM}:${t.nonRenewM}`,
            label: `${t.name} will leave ${h.bbl} in six months — ${t.nonRenewWhy ?? "renewal declined"}`,
          });
        }
        // Near-term rolls without a live LOI or non-renewal notice still need a
        // principal's eyes — otherwise Year runs past empty space forming.
        const moLeft = t.endM - s.month;
        if (moLeft > 0 && moLeft <= 6 && t.nonRenewM === undefined) {
          const covered = (s.lois ?? []).some((l) =>
            l.bbl === h.bbl && (l.kind === "renewal" ? l.tenantIdx !== undefined && h.tenants[l.tenantIdx]?.name === t.name : false));
          if (!covered) {
            out.push({
              key: `lease-roll:${h.bbl}:${t.name}:${t.endM}`,
              label: `${t.name} lease ends ${monthLabel(t.endM)} — ${moLeft} month${moLeft === 1 ? "" : "s"}`,
            });
          }
        }
      }
      if (h.planCutM === s.month) {
        out.push({
          key: `capital-plan:${h.bbl}:${h.planCutM}`,
          label: `${h.bbl} capital plan could not be funded from cash — condition will deteriorate`,
        });
      }
    }
    // A YEAR, NOT A QUARTER. Three months' notice on a balloon is not notice —
    // it is barely time to get an appraisal, let alone market a building. Real
    // lenders send a maturity letter six to twelve months out and real
    // borrowers start working the refinancing a year ahead, because selling an
    // income building takes six to nine months from decision to deed. The date
    // has been known since the day the loan closed; there is no reason to sit
    // on it.
    if (h.loan && h.loan.maturityM - s.month <= 12 && h.loan.maturityM > s.month) {
      const mo = h.loan.maturityM - s.month;
      out.push({
        key: `balloon:${h.bbl}:${mo > 6 ? "far" : "near"}`,
        label: `Balloon due ${monthLabel(h.loan.maturityM)} — ${mo} month${mo === 1 ? "" : "s"}`,
      });
    }
    if (h.loan?.sweep) out.push({ key: `sweep:${h.bbl}`, label: "Covenant breach — cash flow swept" });
  }
  // A portfolio facility is one loan against many deeds, so it never appears
  // in the holding loop above. Its balloon and covenant sweep are at least as
  // dangerous as a single-asset loan and must stop Skip on the same notice.
  if (s.facility) {
    const mo = s.facility.maturityM - s.month;
    if (mo <= 12 && mo > 0) {
      out.push({
        key: `facility-balloon:${mo > 6 ? "far" : "near"}`,
        label: `${s.facility.lender} facility due ${monthLabel(s.facility.maturityM)} — ${mo} month${mo === 1 ? "" : "s"}`,
      });
    }
    if (s.facility.sweep || s.facility.breachedSince !== undefined) {
      out.push({
        key: "facility-sweep",
        label: `${s.facility.lender} facility covenant breach — portfolio cash flow at risk`,
      });
    }
  }
  for (const d of Object.values(s.developments ?? {})) {
    if (d.lastCapitalCallM === s.month && (d.lastCapitalCall ?? 0) > 0) {
      const n = d.lastCapitalCall ?? 0;
      out.push({
        key: `capital-call:${d.bbl}:${d.lastCapitalCallM}`,
        label: `${d.bbl} construction capital call — ${n >= 1_000_000
          ? `$${(n / 1_000_000).toFixed(2)}M`
          : `$${Math.round(n / 1000)}K`} funded from cash`,
      });
    }
  }
  // A FILE IS OPEN AND THE CLOCK IS RUNNING. Nothing in this list said so,
  // which meant auto-advance would run straight past a foreclosure and the
  // only trace was one line of news six months earlier.
  for (const w of Object.values(s.workouts ?? {})) {
    const left = Math.max(0, (w.saleM ?? w.decideM) - s.month);
    out.push({
      key: `workout:${w.bbl}:${w.stage}${w.servicing ? ":paying" : ""}`,
      label: w.stage === "foreclosure"
        ? `${w.lender} has filed on ${w.bbl} — auction in ${left} months`
        : w.servicing
        ? `${w.bbl}: keeping it current, ${w.servicedMs ?? 0} months paid`
        : `${w.lender} wants ${Math.round(w.cure / 1000)}K on ${w.bbl} — ${left} months to decide`,
    });
  }
  // A counter on the table is the definition of something needing you — and an
  // unfunded contract is the same thing with a deadline attached.
  // Every conversation gets its own line. Four deals on the table is four
  // things needing you, and rolling them into one would hide the whole point
  // of being allowed to run four.
  for (const t of Object.values(s.talks ?? {})) {
    const idleM = Math.max(0, s.month - (t.openedM ?? s.month));
    const idle =
      idleM <= 0 ? "opened this month"
        : idleM === 1 ? "1 month on the table"
          : `${idleM} months on the table`;
    out.push(t.agreed
      ? {
        key: `contract:${t.bbl}`,
        label: `Under contract at $${((t.agreedPrice ?? t.theirPrice) / 1e6).toFixed(2)}M — fund it by ${monthLabel(t.closeByM ?? s.month)} (${idle})`,
      }
      : {
        key: `talks:${t.bbl}:${t.theirPrice}`,
        label: `${t.sellerName} is at $${(t.theirPrice / 1e6).toFixed(2)}M${t.final ? " — their final word" : ""} · ${idle}`,
      });
  }
  if (s.exchange && s.exchange.deadlineM - s.month <= 2) {
    out.push({ key: "exchange", label: `1031 clock: ${monthLabel(s.exchange.deadlineM)} deadline` });
  }
  for (const o of s.noteOffers ?? []) {
    out.push({ key: `note:${o.id}`, label: `${o.lender} is selling the ${o.address} loan — ${(100 * o.askPct).toFixed(0)} cents` });
  }
  // Private-credit asks lapse in two months — same Stop-on-new as bank paper.
  for (const a of s.privateAsks ?? []) {
    out.push({
      key: `private-ask:${a.id}`,
      label: `${a.rivalName} wants ${a.ratePct.toFixed(1)}% private money on ${a.address} — answer by ${monthLabel(a.expiresM)}`,
    });
  }
  for (const q of s.privateBorrowQuotes ?? []) {
    out.push({
      key: `private-borrow:${q.id}`,
      label: `${q.lenderName} will lend on ${q.address} at ${q.ratePct.toFixed(1)}% — answer by ${monthLabel(q.expiresM)}`,
    });
  }
  // Receiver books and fund wind-downs — buyable on Marketplace. Without this
  // Skip runs past the best buying window in the game while rivals clear them.
  for (const p of s.portfolios ?? []) {
    if (p.player) continue;
    const who = p.sellerLender ?? "A seller";
    const disc = p.gross > 0 ? ((1 - p.ask / p.gross) * 100).toFixed(0) : "0";
    out.push({
      key: `street-book:${p.id}`,
      label: p.reo
        ? `${who} has ${p.bbls.length} buildings in receivership at $${(p.ask / 1e6).toFixed(1)}M (${disc}% back) — Marketplace`
        : `${p.bbls.length}-building package at $${(p.ask / 1e6).toFixed(1)}M on Marketplace`,
    });
  }
  // The July docket is live for one month — miss it and the lots are gone.
  if (s.auction && s.month < s.auction.m) {
    out.push({
      key: `auction:${s.auction.m}`,
      label: `County foreclosure docket — ${s.auction.lots.length} lot${s.auction.lots.length === 1 ? "" : "s"}, hammer ${monthLabel(s.auction.m)}`,
    });
  }
  // A note tells you it has stopped paying ONCE. The key carries the month it
  // told you, so it can never stop the clock a second time.
  for (const n of s.notes ?? []) {
    if (n.perf === "nonperforming" && n.filedM === undefined && n.toldM !== undefined) {
      out.push({ key: `npl:${n.id}:${n.toldM}`, label: `${n.obligor} has stopped paying on ${n.address}` });
    }
  }
  if ((s.locOverMs ?? 0) > 0) {
    out.push({ key: "line-over", label: "Credit line is over-advanced — the lender requires a paydown" });
  }
  if (s.cash < 0) {
    const ms = s.insolventMs ?? 0;
    out.push({
      key: "cash",
      label: ms > 0
        ? `Cash is negative — insolvency month ${ms} of 12 before lender seizure`
        : "Cash is negative — the insolvency clock has started",
    });
  } else {
    // Forward runway: cash still positive but less than three months of
    // contractual debt service. Waiting for cash < 0 is waiting for the clock.
    const monthlyDebt = Object.values(s.holdings).reduce(
      (a, h) => a + (h.loan?.monthlyPmt ?? 0) + (h.mezz?.monthlyPmt ?? 0), 0,
    )
      // Use the contractual facility coupon, not an IO proxy off balance×rate —
      // post-IO amortizing paper is larger, and the runway warning was quiet
      // while the real cheque would drain the account in under three months.
      + (s.facility?.monthlyPmt ?? 0)
      + ((s.loc?.balance ?? 0) * ((s.econ.indexRate ?? 0) + 4)) / 100 / 12;
    if (monthlyDebt > 0 && s.cash < monthlyDebt * 3) {
      out.push({
        key: "cash-runway",
        label: `Cash covers less than three months of debt service`,
      });
    }
  }
  // Open LOI signing costs vs the treasury reserve the agent itself respects.
  {
    const committed = (s.lois ?? []).reduce((a, l) => {
      const fee = exclusiveFeeRate(s.holdings[l.bbl]);
      return a + loiSigningCost(l, fee);
    }, 0);
    if (committed > 0 && s.cash - committed < agentCashReserve(s)) {
      const n = committed >= 1_000_000
        ? `$${(committed / 1_000_000).toFixed(2)}M`
        : `$${Math.round(committed / 1000)}K`;
      out.push({
        key: "ti-book",
        label: `Open lease signing costs ${n} would breach the cash reserve`,
      });
    }
  }
  // Estate tax — nine-month clock, or §6166 instalments still running.
  if (s.estateDue && (s.estateDue.remaining ?? 0) > 0) {
    const bill = s.estateDue;
    const left = bill.deadlineM - s.month;
    out.push({
      key: `estate:${bill.deathM}`,
      label: bill.elect6166
        ? `Estate tax instalment — $${(bill.remaining / 1e6).toFixed(2)}M remaining under §6166`
        : left <= 0
          ? `Estate tax of $${(bill.remaining / 1e6).toFixed(2)}M is past due`
          : `Estate tax of $${(bill.remaining / 1e6).toFixed(2)}M due ${monthLabel(bill.deadlineM)} — ${left} month${left === 1 ? "" : "s"}`,
    });
  }
  // Milestones stay in the news tape; they are not decisions that should stop Skip.
  if (s.gameOver) out.push({ key: "over", label: "The run is over" });
  return out;
}

// Run up to `cap` months, stopping when something new needs the player.
// Returns the state plus why it stopped — the UI toasts the reason.
//
// ONE CLONE for the whole run. Re-cloning every month was correct and also
// twelve times the structuredClone cost on every Year click; a thirty-year
// skip paid for 360 deep copies of the save. The tick mutates the copy; the
// caller's state is untouched until they adopt the returned one.
export function advanceUntilAttention(
  s: GameState, parcels: ParcelTable, bbls: string[], adjacency: Record<string, string[]> | null, cap: number,
): { s: GameState; months: number; reason: string | null } {
  if (s.gameOver || cap <= 0) return { s, months: 0, reason: null };
  const before = new Set(attentionItems(s).map((a) => a.key));
  const cur = cloneState(s);
  for (let i = 1; i <= cap; i++) {
    tickMonth(cur, parcels, bbls, adjacency);
    const now = attentionItems(cur);
    const fresh = now.find((a) => !before.has(a.key));
    if (fresh) return { s: cur, months: i, reason: fresh.label };
    if (cur.gameOver) return { s: cur, months: i, reason: null };
  }
  return { s: cur, months: cap, reason: null };
}

/**
 * Same as `advanceUntilAttention`, but yields to the browser between months so
 * a Year / Skip click cannot freeze the tab for the whole run. Harnesses keep
 * using the sync form.
 */
export async function advanceUntilAttentionAsync(
  s: GameState, parcels: ParcelTable, bbls: string[], adjacency: Record<string, string[]> | null, cap: number,
  yieldEvery = 1,
): Promise<{ s: GameState; months: number; reason: string | null }> {
  if (s.gameOver || cap <= 0) return { s, months: 0, reason: null };
  const before = new Set(attentionItems(s).map((a) => a.key));
  const cur = cloneState(s);
  for (let i = 1; i <= cap; i++) {
    tickMonth(cur, parcels, bbls, adjacency);
    const now = attentionItems(cur);
    const fresh = now.find((a) => !before.has(a.key));
    if (fresh) return { s: cur, months: i, reason: fresh.label };
    if (cur.gameOver) return { s: cur, months: i, reason: null };
    if (yieldEvery > 0 && i % yieldEvery === 0 && i < cap) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return { s: cur, months: cap, reason: null };
}

/**
 * PROPERTY CASH FLOW / MONTH — deeds only.
 *
 * Ground rent on a leased fee is deed income (see `ownedMonthlyNoi`). Mortgages
 * on those deeds are deducted. Construction interest, the portfolio facility
 * and the revolver are firm capital costs and live in `portfolioMonthlyCF`.
 */
export function portfolioPropertyMonthlyCF(s: GameState, parcels: ParcelTable): number {
  let cf = 0;
  for (const h of Object.values(s.holdings)) {
    if (!resolveRec(parcels, s, h.bbl)) continue;
    cf += ownedMonthlyNoi(s, parcels, h) - (h.loan?.monthlyPmt ?? 0) - (h.mezz?.monthlyPmt ?? 0);
  }
  return cf;
}

/**
 * FIRM CASH FLOW / MONTH — property CF less construction interest, facility
 * and the revolver. The header annualises this. Name used to say "quarterly";
 * the tick has always been monthly.
 */
export function portfolioMonthlyCF(s: GameState, parcels: ParcelTable): number {
  let cf = portfolioPropertyMonthlyCF(s, parcels);
  for (const d of Object.values(s.developments ?? {})) {
    cf -= (d.loanBalance * d.ratePct) / 100 / 12; // construction interest
  }
  // ...and the facility, which is one payment against many buildings and
  // therefore belongs to none of their rows. See engine/facility.ts.
  if (s.facility) cf -= s.facility.monthlyPmt;
  // THE LINE IS DEBT, AND ITS INTEREST IS DEBT SERVICE.
  //
  // This walked every mortgage and every construction facility and then
  // stopped, so the one borrowing that is easiest to run up and hardest to see
  // — the revolver — was the one piece of interest the headline cash flow
  // pretended did not exist. A player sitting on a drawn line was shown a
  // cash flow that could not be reconciled with the money leaving the account,
  // and the gap grew precisely as the line got fuller, which is exactly when
  // it matters. Same rate `tickCredit` charges, same monthly convention.
  if (s.loc && s.loc.balance > 0) cf -= (s.loc.balance * locRate(s)) / 100 / 12;
  return cf;
}

/** @deprecated Name lied — returns a monthly figure. Prefer `portfolioMonthlyCF`. */
export const portfolioQuarterlyCF = portfolioMonthlyCF;

/** @deprecated Name lied — the tick is monthly. Prefer `advanceMonth`. */
export const advanceQuarter = advanceMonth;

export function firstListings(s: GameState, parcels: ParcelTable, bbls: string[]): GameState {
  const next = cloneState(s);
  refreshListings(next, parcels, bbls);
  return next;
}

export type { ParcelRecord };
