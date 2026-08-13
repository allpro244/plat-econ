// THE TAILS. A CYCLE COMES BACK; A LEVEL DOES NOT.
//
// Everything in market.ts turns. The phase machine turns, the ten industry
// clocks turn, the national supply shocks cluster and pass. Run that engine for
// a century and the city it describes ends the century being the same city it
// started as, richer or poorer by a trend but structurally identical. No real
// city has ever done that, and the reason is the thing this file adds.
//
// Rochester did not have a bad decade in imaging. Kodak employed about sixty
// thousand people there in 1982 and about thirteen hundred in 2019, and when
// the next expansion came those jobs did not come back, because they were not
// cyclically absent — they were gone. Detroit's motor-vehicle employment went
// from roughly 450,000 in the 1950s to roughly 120,000. Nokia's Oulu headcount
// went from about 4,500 to a few hundred between 2009 and 2014. And the mirror
// is just as real and just as permanent: Charlotte was not a banking town and
// then it was, Austin was not a technology town and then it was, and neither of
// them handed it back at the next recession.
//
// So a swan here is a LEVEL EVENT, and that word is doing all the work. It is
// not a deep bust. It is a restatement of how much of a trade this city holds,
// or of how much of a kind of space this city wants, and it RIDES UNDERNEATH
// the cycle rather than being one. When the clock turns, the cycle recovers to
// the new level and not to the old one. That asymmetry is the same one the
// sector-exit ratchet in market.ts already has, and it is here for the same
// reason: nobody reopens the foundry when rents dip.
//
// ---------------------------------------------------------------- both tails
//
// A distribution with only a left tail is not a distribution, it is a bleed,
// and it would also be a lie about what this business is. The fortunes in
// commercial real estate were made by people who happened to own the right dirt
// when something permanent and good arrived. So every family here is two-tailed
// and drawn symmetrically: same hazard, same magnitude distribution, opposite
// sign. That is not a balance decision, it is what stops the swans from
// smuggling a trend into a model whose price level is supposed to compound at
// about two per cent and nothing else.
//
// THE TEST THIS FILE HAS TO PASS, and it is a paired one because it can be.
// Nothing here draws from `s.rng` — see `hash01` — so an identical build with
// the firing lines switched off produces a bit-for-bit identical stream, and
// every seed is its own control. Twenty-four seeds, a hundred years each, swans
// off against swans on, paired:
//
//   price-level CAGR      +0.075 pp/yr,  t = 0.63,  95% CI -0.16 to +0.31
//   real office rent      -0.050 pp/yr,  t = -0.31
//   real housing rent     -0.371 pp/yr,  t = -1.37
//   real shed rent        -0.098 pp/yr,  t = -0.53
//   real shop rent        -0.539 pp/yr,  t = -2.31   <- see TRADE_WEIGHT
//   city jobs at year 100 +0.74%,        t = 0.18
//
// The centre does not move. What moves is the SPREAD, and it is supposed to:
// the cross-seed standard deviation of the century's CAGR goes from 0.295 to
// 0.428 pp, and the range from 1.28-2.41% to 0.28-2.37%. The 0.28% seed is a
// city that lost a trade and never replaced it, running two generations of
// near-zero local inflation — which is Rochester, and is the point.
//
// Retail is the one line that is not comfortably dead and it is left standing
// rather than tuned away. Uncorrected it is a 3% result; corrected for having
// asked the same question of four classes it is a 12% one, which is not a
// finding. Where it came from, what took half of it out, and the next place to
// look are all written up at TRADE_WEIGHT.
//
// ------------------------------------------------------- what is NOT in here
//
// NATIONAL SUPPLY SHOCKS already exist in market.ts (`shockM`, `shockSev`,
// `shockClusterM`) and are not duplicated. Swans are CITY-level and
// sectoral, which is the whole reason they are learnable: an oil shock is
// weather that happens to everybody, and a trade leaving your town is a fact
// about YOUR town that you could have read in the paper and acted on.
//
// A TRANSIT LINE OPENING is already built, in demand.ts — `tickTransit` funds
// about one line a decade, announces it six years before the first train, and
// reprices its corridor permanently through `blockD`. An upzoning is already
// built, in zoning.ts. Neither is re-implemented here.
//
// A FLOOD OR STORM SURGE IS NOT HERE AND IT SHOULD BE. It is the best swan
// this particular map could have — the city is an island with piers, the
// waterfront is legible from the screen, and a spatial catastrophe on a
// legible map is the most learnable event a player can be given. It needs
// parcel geometry, and the only monthly hook this file has is `tickEcon(s)`,
// which is not given the parcel table. Written down as a follow-up rather
// than faked citywide: a storm surge modelled as an index shock would be a
// number asserted where a mechanism belongs, and the mechanism is the map.
//
// A TAX OR REGULATORY SHOCK IS NOT HERE FOR THE SAME KIND OF REASON.
// `TAX_RATE` is a `const` in value.ts read directly by value.ts, dev.ts and
// leasing.ts; a reassessment or a millage change means turning it into a
// function of the economy in three files this one does not own.
import type { BuiltClass, Econ, GameState, Sector } from "./types";
import { BUILT_CLASSES, SECTOR_CLASSES, raiseAlert as raise } from "./types";
import { INDUSTRY_LABEL, SECTORS } from "./market";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Drawn off the CAMPAIGN SEED, not off `s.rng`, and the precedent is
 * `tickTransit` in demand.ts. Two reasons, both of them load-bearing.
 *
 * The first is that drawing from the shared stream here would shift every
 * downstream consumer of it — every tenant, every rival decision, every
 * listing — which turns "this build added swans" into "this build changed
 * everything" and makes every seed-pinned number anybody has ever measured
 * stop reproducing. Every before/after in the report on this file is a clean
 * control precisely because of this line.
 *
 * The second is that a save-scummer cannot reroll a swan. A catastrophe you
 * can reload out of is not a catastrophe.
 */
function hash01(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // one extra avalanche round: FNV alone leaves visible structure in the low
  // bits, and these draws are compared against hazards of a few per cent
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
const pick01 = (u: number, a: number, b: number) => a + (b - a) * u;

// ---------------------------------------------------------------- frequency
//
// HOW OFTEN A CITY GETS ONE OF THESE, counted off the real record rather than
// chosen for pacing.
//
// Trade-level events, one city at a time, in a century: Rochester had Kodak's
// collapse, Xerox's contraction and the arrival of a university-and-medical
// economy. Pittsburgh had steel out and health-and-education in. Seattle had
// Boeing in 1970 ("will the last person leaving turn out the lights"), then
// software in. Charlotte had banking in. Houston had oil out in 1983 and back
// in the 2000s. Hartford had insurance consolidate away. Glasgow had
// shipbuilding, Manchester cotton, Akron rubber, Bethlehem steel. Dublin,
// Austin, Bangalore, Nashville, Las Vegas all had one arrive. Three to six per
// city per century is the honest count, and it is not one-sided.
//
// Use-class events are rarer and bigger, because they restructure a whole
// building type rather than a trade: the department store's collapse and
// e-commerce hollowing the high street (2000s-2010s), last-mile logistics
// (2015-2022), remote work (2020-2024), the long fall in household size that
// made a city need far more dwellings per person than it used to. Call it
// three or four a century.
//
// MEASURED at these hazards, twenty-four seeds x a hundred years: a median of
// EIGHT level events a century, with a median of four trade and three use taken
// separately — inside the counts above on both families — and a median of FOUR
// in a fifty-year career, two black and two white. (Component medians do not
// add to the total's; each is its own order statistic.) The spread across
// careers runs from one to nine, which
// is the part that matters: some cities have a quiet fifty years and some are
// rewritten twice, and a player cannot plan on either.
const TRADE_HAZARD_YR = 1 / 22;
const USE_HAZARD_YR = 1 / 30;

/** Nothing structural in the opening two years. `regime.ts` already decides
 *  which decade you walked into; a level event in month six is that job done
 *  twice, and it arrives before the player owns anything it could happen to. */
const QUIET_M = 24;

// ------------------------------------------------------------- how big, how fast
//
// MAGNITUDE IS DRAWN SYMMETRICALLY ABOUT ZERO IN PROPORTIONAL TERMS: a black
// event takes 1-m of a level away, a white one adds m to it, same m, same
// hazard. That is the one thing that stops the swans from becoming a trend, and
// getting the symmetry in the WRONG UNITS is exactly how the first cut of this
// file smuggled one in.
//
// WHAT WENT WRONG, because it is worth writing down. These were first drawn
// symmetrically IN LOGS — down by exp(-x), up by exp(+x) — on the reasoning
// that a level is a multiplicative quantity and the log is the natural scale.
// Log-symmetric is Jensen-positive in the level: at x = 0.4 the up-step adds
// 49% and the down-step removes 33%, so the arithmetic mean of the trade levels
// drifts UP even though the median does not. The trade levels feed employment,
// employment feeds the labour market, and the labour market feeds the Phillips
// term — so a symmetry chosen on the wrong scale came out of the far end of the
// model as INFLATION. Measured, four seeds, a hundred years each: the price
// level compounded at 2.295%/yr against a baseline of 2.040%, and every one of
// the four seeds moved the same way. The tail distribution was not supposed to
// have an opinion about the price level and it had one worth a quarter of a
// point a year, forever.
//
// The quantity that has to be symmetric is the one that reaches the labour
// market, and that is the arithmetic level. So it is drawn arithmetically now
// and the residual is on the other side: composing an up-step and a down-step
// of the same size leaves 1 - m², a mild contraction in the LOG of the level.
// Measured directly — sixteen seeds x fifty years, summing this file's own
// monthly employment drift — the mean is -0.40% of the trade level over a
// career, against 32 black events and 33 white ones with total magnitudes of
// 7.59 and 7.09. The draw is fair to a fraction of a per cent and the residual
// is at least the harmless sign.
//
// A trade event moves 12% to 42% of a trade's local footprint. Anchors: Oulu's
// ICT employment fell about 30% around Nokia's retreat; Rochester's
// manufacturing employment fell about 60% over twenty-five years, which is two
// of these; Hartford's insurance employment fell about a quarter in the 1990s
// consolidations; Charlotte's banking employment more than doubled over the
// same kind of horizon.
const TRADE_MAG: [number, number] = [0.12, 0.42];
// And it takes three to eight years to land, because that is how long a trade
// takes to leave: leases run out, plants wind down, the head office announces
// in one year and closes over five. Kodak's was longer than this and Nokia's
// was shorter.
const TRADE_GLIDE_M: [number, number] = [36, 96];

// HOW BIG A USE EVENT IS, PER CLASS, AND ONE BAND FOR ALL THREE WAS WRONG.
//
// The first cut ran a single 8-24% band across office, retail and housing,
// anchored on the office number — US office demand is 15-20% structurally lower
// after 2020 and has not come back — and on "e-commerce took about a fifth of
// general-merchandise sales out of stores". The second of those does not say
// what it was being used to say. A fifth of general-merchandise SALES is not a
// fifth of a city's retail FLOOR AREA: most of what a parade is let to is food
// service, groceries, chemists, salons, clinics and gyms, none of which moved
// online at all. The checkable outcome is the one that settles it — US retail
// inventory barely moved between 2010 and 2023, and retail vacancy PEAKED at
// about 10.5% in 2011 and fell to about 4% by 2023. The e-commerce era did not
// produce a structural collapse in retail space demand; it reallocated demand
// inside retail, killed the enclosed mall and left the grocery-anchored centre
// tighter than it found it.
//
// THIS DID NOT FIX WHAT IT WAS AIMED AT, AND THAT IS WORTH MORE THAN IF IT HAD.
// The measurement that prompted it was real: twenty-four paired centuries,
// swans off against swans on, same seeds, same stream — office, housing and
// industrial came back statistically dead, real rent growth within 0.12pp/yr
// and t under 1.5 on every one, and RETAIL DID NOT. Real retail rent growth
// fell 0.97pp/yr (t = -3.3) with mean retail availability up 1.69pp. Halving
// retail's magnitude band and re-running the identical twenty-four made it
// -1.13pp/yr (t = -4.2). Cutting the shock in half did not move the damage at
// all, which is a clean refutation: the use events were never the cause. It was
// the trade channel double-counting into retail; `TRADE_WEIGHT` below took half
// of the damage out on the very next run, and the write-up is there.
//
// The band stays anyway, because it was independently wrong. It is anchored on
// what the online shift did to occupied FLOOR AREA now instead of on what it
// did to sales, and that is a better number whatever it does to the harness.
//
// Anchors, one per class, each to the thing the class actually did:
//   office  0.10-0.22  the 2020-24 step, measured and still standing.
//   retail  0.05-0.12  what the online shift did to occupied floor area rather
//                      than to sales, per the paragraph above.
//   housing 0.06-0.15  US household size went 3.3 to 2.5 between 1960 and 2020,
//                      a 30% rise in dwellings per resident — but that is six
//                      decades and several of these, not one event.
const USE_MAG: Partial<Record<BuiltClass, [number, number]>> = {
  office: [0.10, 0.22],
  retail: [0.05, 0.12],
  multifamily: [0.06, 0.15],
};
const USE_GLIDE_M: [number, number] = [30, 84];

/**
 * A GUARD, NOT A MECHANISM. Nothing stops three down-steps landing on the same
 * trade in one campaign, and the composed level has to stay somewhere a real
 * city has been. These are the OUTER rails of the historical record rather than
 * a comfortable band: Detroit's motor-vehicle employment fell to about 0.27 of
 * its 1950s level and Bethlehem's steel employment reached zero, so 0.25 is
 * about as far down as anywhere has gone and stayed a city; Austin's technology
 * employment grew more than fourfold over a working lifetime.
 *
 * THE FIRST CUT SET THESE AT 0.45 AND 2.4 AND ONE SEED IN FOUR RESTED ON THE
 * FLOOR — two logistics exoduses of a third each compounding to 0.44 — which is
 * a rail holding up the model rather than guarding it, and is the fifth kind of
 * fake number. Widened to the record's own bounds and re-measured over eight
 * seeds x a hundred years: neither binds.
 */
const LEVEL_FLOOR = 0.25, LEVEL_CEIL = 4.0;

/**
 * WHERE THE DISPLACED FEET GO, in square feet and not in per cent, because
 * that is the form the fact is actually known in.
 *
 * `spill` is feet gained by the partner per foot lost by the primary. It is
 * applied by converting through each class's own stock, so the answer is
 * right whatever size this particular island's inventory turns out to be —
 * a ratio expressed in per cent would silently mean something different on
 * every generated map.
 *
 *   office -> housing, 0.33. A remote worker gives back about 190 sf of
 *   office — the US average right before 2020 — and the dwelling space that
 *   actually gets rented on the back of it is a spare room for some of them
 *   and nothing at all for most. US apartment absorption did hit a record in
 *   2021 while office demand collapsed, so the number is not zero, and it is
 *   nowhere near one.
 *
 *   retail -> industrial, 0.30, AND THE FIRST CUT OF THIS WAS 1.50 AND WRECKED
 *   THE SHED MARKET. 1.50 is the right number for the wrong geography: it is
 *   Prologis' published figure, roughly 1.2M sf of logistics space per $1bn of
 *   e-commerce sales against roughly 0.8M sf of store space for the same sales,
 *   because a shop is a warehouse that customers pick from themselves. But that
 *   is a figure about a COUNTRY, and this is one island. Two thirds of it never
 *   lands here at all: regional fulfilment goes where land is cheap, which is
 *   the mainland, and the same demand pool in market.ts already says so —
 *   "demand that cannot be housed here stops looking here within months". Only
 *   the last-mile slice takes space in the city. And only part of the retail
 *   loss is postable in the first place: restaurants, salons, groceries and
 *   clinics are most of a parade and none of them ship.
 *
 *   What the first cut measured, four seeds x a hundred years — 1.50 here and
 *   the magnitude draw still on the log scale, so the two faults are entangled
 *   in this reading and only the arithmetic below separates them: industrial
 *   mean vacancy 16.8% against a 4.7% baseline, and real shed rent compounding
 *   at -2.41%/yr against +0.96%. Measured off the generated map rather than off
 *   the fallback table, this city stands up about 2.4M sf of retail and 1.2M sf
 *   of industrial. A 24% retail step is therefore 576k sf, and at a spill of
 *   1.50 that is 864k sf landing on a shed inventory of 1.2M — a SEVENTY PER
 *   CENT swing in industrial demand out of a medium-sized retail event. A spill
 *   expressed in feet amplifies by the ratio of the two inventories, and nothing
 *   in the first version noticed that it was pointing the big class at the small
 *   one. At 0.30, and with retail's own magnitude band corrected below, the
 *   largest retail event this file can draw moves industrial demand by about
 *   7%, which is a good decade for sheds rather than a new industry.
 *
 * Run in reverse — the high street comes back, the office fills again — the
 * same conversion runs at the same rate with the sign flipped, so a black event
 * and a white event of the same size on the same pair very nearly cancel: the
 * primary is left at 1 - m² and the partner at 1 - d², where d is the partner
 * step the conversion produced. NEARLY, not exactly, and the residual is the
 * same harmless log contraction the magnitude draw already has. What matters is
 * that the expectation of each level is flat, which it is, because the spill is
 * linear in the primary's step and the primary's step has mean zero.
 *
 * Housing has an entry with NO partner, because the event that moves it is not
 * a reallocation of anything. Household size is the quantity: US households
 * averaged 3.3 people in 1960 and 2.5 in 2020, which is a permanent 30% rise
 * in dwellings demanded per resident and one of the largest level events in
 * the history of housing demand. It went one way for sixty years and it has
 * gone the other way since 2010. It has no counterpart class.
 */
const USE_PAIRS: { primary: BuiltClass; partner?: BuiltClass; spill: number }[] = [
  { primary: "office", partner: "multifamily", spill: 0.33 },
  { primary: "retail", partner: "industrial", spill: 0.30 },
  { primary: "multifamily", spill: 0 },
];

/**
 * HOW A MOVING LEVEL BECOMES FELT DISTRESS, and how the distress ENDS while
 * the level stays where the event put it.
 *
 * This is the join between the two halves and it is the part that is easy to
 * get wrong. A trade that has finished leaving is not a trade in trouble — it
 * is a smaller trade, at peace, in fewer buildings. The firms that remain are
 * the ones that were always going to remain and they renew normally. What
 * hurts is the ADJUSTMENT: the years in which the shedding is happening, when
 * every renewal conversation in that trade is with somebody whose head office
 * has just announced a number.
 *
 * So distress is the trade's level measured against a MEMORY of the level, and
 * the memory catches up. `swanTradeRef` is a two-year exponential memory —
 * two years being about how long a lender's and a landlord's sense of "normal
 * for this tenant's business" takes to reset, and about the horizon a covenant
 * test looks back over. While the level is falling the gap is open and the
 * trade reads as distressed; once it stops falling the gap closes over the
 * next couple of years and the trade reads as ordinary again, permanently
 * smaller.
 *
 * `WAVE_GAIN` converts that gap into the same units `industryMom` is in, so it
 * can be added to the cycle rather than replacing it — a trade can be leaving
 * town AND in a cyclical bust, and the two compound the way they would. It is
 * set so that a trade running eighteen per cent below its own two-year normal
 * reads as `industryStress` = 1, full distress. For scale: US
 * financial-activities employment fell about 8% peak to trough over 2008-10,
 * which is the worst episode that sector has had in the modern record. Twice
 * that, sustained, is a trade whose landlords are getting keys back, and that
 * is what saturation should mean.
 *
 * WHAT IT ACTUALLY DELIVERS. `test/swanfork.mjs` is this probe and it is a
 * FILE now, because the table that used to sit here was hand-run once and had
 * drifted a long way from the engine underneath it — a comment asserting
 * numbers nothing can reproduce is a fake number with a citation. Run it:
 *
 *   node test/swanfork.mjs                  finance to 0.65
 *   MULT=1.35 node test/swanfork.mjs        the white mirror
 *
 * Five paired forks: warm a city fifteen years, clone it, force the trade in
 * one clone only over five years, run both fifteen more years off the same RNG
 * stream, average the last ten. Finance is 17.8% of the shipped town's payroll.
 *
 *                          BLACK (x0.65)          WHITE (x1.35)
 *   industryStress finance  0.114 -> 0.261        0.114 -> 0.054
 *   industryStress law      0.063 -> 0.080        0.063 -> 0.059
 *   office availability    10.65% -> 15.29%      10.65% ->  8.60%
 *   retail availability    10.23% -> 12.08%      10.23% ->  9.06%
 *   industrial availability 4.89% ->  5.39%       4.89% ->  3.91%
 *   multifamily            4.66% ->  6.31%        4.66% ->  3.42%
 *   city jobs             163,703 -> 152,158    163,703 -> 180,124
 *   real office rent       46.40 -> 27.29        46.40 -> 58.10
 *
 * The ordering is what says this is a mechanism rather than an index shock: the
 * class finance sat in moves furthest, and the spillovers into shops, sheds and
 * flats are the payroll arriving through the labour market and then through the
 * people, which is the route it takes in life. -7.1% of the city's jobs against
 * a trade that is 17.8% of them shedding 35% — 6.2% by direct arithmetic, so
 * the wire transmits about what it should and the rest is the multiplier.
 *
 * TWO CLAIMS THAT USED TO BE HERE ARE GONE, and it matters which:
 *
 * "Finance leaving is not bad news for the law firms" was read off a law stress
 * that FELL. It rises now, 0.063 -> 0.080. That is the better answer and the
 * reason is legible: a shock big enough to take 7% of the city's jobs is a
 * recession, and every trade's own two-year normal falls in a recession. The
 * old reading came from a shock too small to be one.
 *
 * "Losing a trade is worse than gaining one is good" no longer holds in
 * employment, and it had already stopped holding before the weighting fix in
 * this file: on the engine as it stood that morning the same probe gave -1.1%
 * against +4.4%, with the GAIN four times the loss. It survives in rents, much
 * weakened — -41.2% against +25.2%, a ratio of 1.6 where the comment claimed
 * 4.9 — and that part is real and is where the comment said it was, in the
 * superlinear glut branch of the vacancy term against a capped shortage branch.
 * Employment is now roughly symmetric in the shock with a mild upward skew from
 * compounding, which is what a symmetric drift on a multiplicative index does.
 *
 * So the distribution of OUTCOMES is no longer left-skewed by this wire. If
 * that skew is wanted it has to be argued for and built, not asserted here.
 */
const REF_TAU_M = 24;
const WAVE_GAIN = 0.03 / 0.18;

/**
 * HOW MUCH OF A CLASS'S DEMAND IS THE TRADE, AND HOW MUCH IS THE TOWN.
 *
 * When a trade leaves, does the space it was let to empty out? For an office
 * floor, obviously — the tenant IS the trade, and when the trade goes the
 * tenant goes. For a shed let to a logistics operator, the same. For a SHOP it
 * is not obvious at all, and getting it wrong is the largest single fault this
 * file has had.
 *
 * `SECTOR_CLASSES` says a shop is let to apparel, food or medical. Read
 * literally, that made a trade exodus land on retail at a THIRD weight against
 * office's SIXTH — twice as hard on the class with the smaller inventory and
 * the tighter natural vacancy — and the glut branch of the rent term in
 * market.ts is superlinear, so twice the shock is rather more than twice the
 * damage. Measured over twenty-four paired centuries that came to real retail
 * rent growth 1.13pp/yr lower with swans on than off, t = -4.2, while every
 * other class was statistically dead. One class in four carrying a permanent
 * penalty is not a tail distribution, it is a thumb on the scale.
 *
 * And read literally is the wrong reading. The clothes shop does not close
 * because the cutting floors closed; it closes if the PEOPLE leave. A shop's
 * tenant carries the name of a trade, but a shop's demand is its customers, and
 * its customers are residents and daytime workers. That is not an argument this
 * file is making up — market.ts's own demand driver already says it, in the
 * exponents it uses for each class: office and industrial read `employIdx`
 * outright, housing reads population outright, and retail reads
 * `popIdx^0.68 * employIdx^0.32`. Retail is 32% a firm business and 68% a
 * residents business, by the engine's own arithmetic.
 *
 * So the trade level enters each class in exactly that proportion. Retail's
 * exposure to a trade leaving is 0.32 of the naive one, and the other 0.68
 * still arrives — through the payroll, then the migration, then the population
 * term in the same demand equation. Nothing is lost; it is counted ONCE instead
 * of twice.
 *
 * Multifamily is 0 for the reason SECTOR_CLASSES has no entry for it.
 *
 * WHAT IT MEASURED, the same twenty-four paired centuries re-run with only this
 * changed: real retail rent growth -1.127 pp/yr (t = -4.18) becomes -0.539
 * (t = -2.31), and mean retail availability +1.90pp becomes +1.04pp. Half the
 * fault, gone, from the only change made — which is the confirmation that the
 * diagnosis was right where the previous one was not.
 *
 * AND HALF OF IT IS STILL THERE, WHICH IS WORTH LEAVING VISIBLE. -0.539 pp/yr
 * at t = -2.31 is a 3% result if retail were the only class asked and a 12% one
 * once you admit the question was put to all four, so it is not a finding and
 * it is not tuned away. THE NEXT PLACE TO LOOK, so the next reader does not
 * start from nothing: `swanClassLevel` multiplies the demand target from
 * OUTSIDE `Math.pow(driver, elastic)`, and `elastic` is 1.0 for office, 0.9 for
 * industrial and 0.7 for RETAIL. The trade level is the same kind of quantity
 * as the driver — how many of a thing are here — so it arguably belongs inside
 * that exponent, where it would enter retail at 0.7 power and office unchanged.
 * That is a dimensional argument rather than a numerical one and it was left
 * alone deliberately: two corrections chasing one reading is the edge of
 * honest, and a third is hill-climbing a harness.
 */
const TRADE_WEIGHT: Record<BuiltClass, number> = {
  office: 1.0, industrial: 1.0, retail: 0.32, multifamily: 0,
};

// --------------------------------------------------------------------- prose
//
// What an anchor in each trade looks like in a port city on an island. Flavour
// carries no arithmetic; it is here because "TECH: -0.31" is a spreadsheet and
// a city losing the company that put it on the map is a thing that happened.
const LEAVING: Record<Sector, string> = {
  finance: "the clearing bank whose name has been on the tallest building downtown since before anyone here was born is moving its book to the mainland",
  law: "the two largest partnerships in town have been absorbed into a mainland firm that will run them from somewhere else",
  tech: "the company that put this island on a map it had never been on before is consolidating everything into one campus, and it is not this one",
  media: "the paper is going, and so are the presses and the four floors of people who filled them",
  insurance: "the mutual that underwrote every hull that ever tied up at these piers has been bought and will be administered from out of state",
  logistics: "the line that made this a port has rerouted to a deeper harbour up the coast",
  apparel: "the last of the cutting floors is closing — the work has gone to a country with cheaper hands",
  food: "the packing houses and the market hall that fed half the county are being wound up",
  medical: "the group practices are consolidating into the mainland hospital system, and the consultants are following",
  design: "the studios that drew half of what is standing here are closing their doors or moving off the island",
};
const ARRIVING: Record<Sector, string> = {
  finance: "a clearing bank is moving its entire back office here, and the recruiters started calling last week",
  law: "a mainland firm is opening a full office here rather than flying people in, and two others are said to be looking",
  tech: "a company nobody here had heard of five years ago has picked this island for its second headquarters",
  media: "a broadcaster is moving production here, and the trades that feed it are moving with it",
  insurance: "an underwriter has chosen this city for its whole marine book, and the brokers are following the paper",
  logistics: "the shipping line is making this a hub port, and the boxes need somewhere to sit",
  apparel: "the trade is coming back — small houses, short runs, made where they are sold",
  food: "the market hall has been rebuilt and the county's growers are shipping through here again",
  medical: "a teaching hospital is siting its new campus here, and everything that lives off one comes with it",
  design: "the studios are coming back, and the people who hire them are opening offices to be near them",
};

/** What a person calls each kind of space out loud. "Multifamily" is a
 *  valuation term; nobody standing in one says it. */
const USE_WORD: Record<BuiltClass, string> = {
  office: "offices", retail: "shops", multifamily: "flats", industrial: "sheds",
};

const USE_STORY: Record<string, { title: string; body: string }> = {
  "office:-1": {
    title: "The offices are emptier every Wednesday, and this time it is not the cycle",
    body: "Something structural has happened to the working week. Firms are renewing on less floor than they had and telling their people to come in on Tuesdays. This is not the cycle — the space is not coming back when hiring does, because the jobs are still here and the desks are not.",
  },
  "office:+1": {
    title: "The floors are filling again, and the firms taking them want more room per head",
    body: "Whatever the working week settled into, it has settled the other way. Firms are back to full floors and taking more space per person than they did — collaboration areas, spare desks, room to grow into. The demand for office space in this city has stepped up and it is not a lease-up, it is a level.",
  },
  "retail:-1": {
    title: "The high street is going online, and it is not coming back off it",
    body: "The goods are still being sold; they are just not being sold from a shop. Anchor units are going dark, the covenants behind the leases are weakening, and the parades that survive are the ones selling things you cannot post. The space that used to hold the stock is moving to a shed somewhere with a loading dock.",
  },
  "retail:+1": {
    title: "The high street is coming back, and the parades are letting again",
    body: "The pendulum has swung. People want to buy things where they can see them, the returns costs of shipping everything have caught up with the people shipping it, and the units that had been dark for a decade are being fitted out. Retail demand in this city has stepped up permanently.",
  },
  "multifamily:-1": {
    title: "Households are getting bigger, and the city needs fewer of them",
    body: "People are doubling up. Grown children are staying, roommates are staying, and the number of dwellings this city's population needs has stepped down. The population has not fallen — the household count has, and it is the household that signs the lease.",
  },
  "multifamily:+1": {
    title: "Households are getting smaller, and the city needs far more of them",
    body: "The same number of people now want more front doors. Household size has stepped down again — later marriages, more people living alone, more people living apart — and every point of it is demand for dwellings that did not exist before. This is the single most reliable source of housing demand there has ever been, and it is permanent.",
  },
};

// ---------------------------------------------------------------- the wiring

function ensure(e: Econ) {
  if (!e.swanTrade) {
    e.swanTrade = {} as Record<Sector, number>;
    e.swanTradeTo = {} as Record<Sector, number>;
    e.swanTradeM = {} as Record<Sector, number>;
    e.swanTradeRef = {} as Record<Sector, number>;
    for (const k of SECTORS) {
      e.swanTrade[k] = 1; e.swanTradeTo![k] = 1; e.swanTradeM![k] = 0; e.swanTradeRef![k] = 1;
    }
  }
  if (!e.swanUse) {
    e.swanUse = {} as Record<BuiltClass, number>;
    e.swanUseTo = {} as Record<BuiltClass, number>;
    e.swanUseM = {} as Record<BuiltClass, number>;
    for (const k of BUILT_CLASSES) { e.swanUse[k] = 1; e.swanUseTo![k] = 1; e.swanUseM![k] = 0; }
  }
}


/**
 * IS THIS ACTUALLY A SWAN, OR IS IT JUST NEWS.
 *
 * Reported by the owner: "swans happen way too often, and a lot of these swans
 * aren't actually swans, they are just news. A black swan or a white swan
 * should be something with a major not a minor impact."
 *
 * The first half of that is not what the engine does. Measured over six careers
 * of fifty years, a swan CARD came up a median of three times a career — one
 * every seventeen years — which is rare. What the player is seeing constantly
 * is the news tape: `event` and `warn` items land at 12.4 a year and the News
 * badge lights in 57% of all months. That is a separate problem and it is not
 * this file's.
 *
 * The second half is exactly right, and it is this file's. `TRADE_MAG` runs
 * 0.12 to 0.42 — the top of that is Rochester losing imaging, and the bottom is
 * a city holding twelve per cent less of one trade over eight years, which is
 * roughly one per cent a year of one sector and is a thing no player will ever
 * feel. Both were being announced with a full-screen card headed "A black
 * swan". The card was making a promise the event could not keep, and a card
 * that cries wolf teaches the player to dismiss the one that matters.
 *
 * So the LEVEL EVENT still happens at its calibrated rate and magnitude —
 * nothing about the economics moves, the anchors in this file stand, and every
 * one of them is still filed as news. What is earned rather than automatic is
 * the INTERRUPTION.
 *
 * Two ways to earn it, because there are two ways for something to matter.
 * Either it is large in absolute terms — a quarter of a trade or more, which is
 * the Hartford-consolidation end of the anchors rather than the noise end — or
 * it is smaller but lands on the player specifically, because a fifteen per
 * cent move in the trade that fills their buildings is their swan even when it
 * is not the city's. Exposure is already computed here for the detail line; it
 * just was not being asked to decide anything.
 */
const CARD_MAG = 0.25;   // a quarter of a trade: Hartford's insurance, 1990s
const CARD_EXPOSURE = 0.15;   // or a sixth of the player's own rent roll
function worthACard(mag: number, exposure: number): boolean {
  return mag >= CARD_MAG || exposure >= CARD_EXPOSURE;
}

function news(s: GameState, kind: "event" | "warn", text: string) {
  s.news.unshift({ q: s.month, kind, text });
  if (s.news.length > 120) s.news.length = 120;
}

/** What share of the player's rent roll is let to this trade — the only number
 *  in the alert that is about them rather than about the city. */
export function exposureToTrade(s: GameState, k: Sector): number {
  let mine = 0, all = 0;
  for (const bbl in s.holdings) {
    for (const t of s.holdings[bbl]?.tenants ?? []) {
      all += t.sf;
      if (t.sector === k) mine += t.sf;
    }
  }
  return all > 0 ? mine / all : 0;
}
/**
 * …and how much of the player's book is in this kind of space, as a sentence
 * rather than as a number, because the two halves of a book are not counted in
 * the same unit and pretending otherwise would be a fake.
 *
 * COMMERCIAL space is a rent roll: every let square foot carries a `use`, so
 * the share is exact. HOUSING is not — a block of flats runs on an aggregate
 * `occ` and has no tenant rows at all — so a share of let footage would have
 * reported ZERO to a player who owned nothing but apartment buildings, on the
 * one alert most likely to matter to them. Counted as buildings there, and said
 * as buildings.
 */
/** The same share `exposureLine` describes, as a number the card gate can use. */
function exposureToUse(s: GameState, k: BuiltClass): number {
  let mine = 0, all = 0;
  for (const bbl in s.holdings) {
    for (const t of s.holdings[bbl]?.tenants ?? []) {
      all += t.sf;
      if ((t.use ?? "office") === k) mine += t.sf;
    }
  }
  return all > 0 ? mine / all : 0;
}

function exposureLine(s: GameState, k: BuiltClass): string {
  if (k === "multifamily") {
    let n = 0;
    for (const bbl in s.holdings) if (s.holdings[bbl]?.occ !== undefined) n++;
    return n > 0 ? ` — and ${n} of the buildings you own are flats.` : `. You own no housing today.`;
  }
  let mine = 0, all = 0;
  for (const bbl in s.holdings) {
    for (const t of s.holdings[bbl]?.tenants ?? []) {
      all += t.sf;
      if ((t.use ?? "office") === k) mine += t.sf;
    }
  }
  const share = all > 0 ? mine / all : 0;
  return share > 0.005 ? ` — and ${(share * 100).toFixed(0)}% of your let footage is in it.` : `. You own none of it today.`;
}

// ------------------------------------------------------------------ firing

function fireTrade(s: GameState, yr: number) {
  const e = s.econ;
  const u = (tag: string) => hash01(`${s.seed}:swan:trade:${yr}:${tag}`);
  const k = SECTORS[Math.min(SECTORS.length - 1, Math.floor(u("who") * SECTORS.length))];
  const dir: 1 | -1 = u("dir") < 0.5 ? -1 : 1;
  const mag = pick01(u("mag"), TRADE_MAG[0], TRADE_MAG[1]);
  const glide = Math.round(pick01(u("len"), TRADE_GLIDE_M[0], TRADE_GLIDE_M[1]));
  const mult = 1 + dir * mag;

  e.swanTradeTo![k] = clamp((e.swanTradeTo![k] ?? 1) * mult, LEVEL_FLOOR, LEVEL_CEIL);
  e.swanTradeM![k] = glide;

  const pct = Math.round(Math.abs(mult - 1) * 100);
  const yrs = (glide / 12).toFixed(0);
  const label = INDUSTRY_LABEL[k];
  const exp = exposureToTrade(s, k);
  const detail = exp > 0.005
    ? `${(exp * 100).toFixed(0)}% of your rent roll is let to that trade.`
    : `You have nothing let to that trade today. The question is what you buy next.`;

  const title = dir < 0
    ? `${label} is leaving this city, and it is not a cycle`
    : `${label} is coming to this city, and it is not a cycle`;
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const body = dir < 0
    ? `${cap(LEAVING[k])}. Over the next ${yrs} years this city expects to hold about ${pct}% less of that trade than it does today, and the space it sat in has to find something else to do. `
      + `When the next expansion arrives it will arrive in a town with less ${label.toLowerCase()} in it.`
    : `${cap(ARRIVING[k])}. Over the next ${yrs} years this city expects to hold about ${pct}% more of that trade than it does today. `
      + `The buildings that trade wants are the ones that will be bid for, and the ground under them reprices before the leases do.`;

  if (worthACard(mag, exp)) raise(s, { kind: "swan", tone: dir < 0 ? "bad" : "good", title, body, detail });
  news(s, dir < 0 ? "warn" : "event", `${title}. ${detail}`);
  if (!s.swanLog) s.swanLog = [];
  s.swanLog.push({ m: s.month, family: "trade", key: k, dir, mult: +mult.toFixed(4), glideM: glide, title });
}

function fireUse(s: GameState, yr: number) {
  const e = s.econ;
  const u = (tag: string) => hash01(`${s.seed}:swan:use:${yr}:${tag}`);
  const pair = USE_PAIRS[Math.min(USE_PAIRS.length - 1, Math.floor(u("which") * USE_PAIRS.length))];
  const dir: 1 | -1 = u("dir") < 0.5 ? -1 : 1;
  const k = pair.primary;
  const band = USE_MAG[k] ?? [0.08, 0.18];
  const mag = pick01(u("mag"), band[0], band[1]);
  const glide = Math.round(pick01(u("len"), USE_GLIDE_M[0], USE_GLIDE_M[1]));
  const mult = 1 + dir * mag;

  e.swanUseTo![k] = clamp((e.swanUseTo![k] ?? 1) * mult, LEVEL_FLOOR, LEVEL_CEIL);
  e.swanUseM![k] = glide;

  // THE PARTNER CLASS, IN FEET. The primary's step is converted to square feet
  // of structural demand at this city's own inventory, moved across at the
  // spill rate, and converted back into the partner's own units — so the same
  // event on a map with three times the housing produces a third of the
  // percentage move there, which is the correct answer and is not what a
  // percentage-to-percentage rule would have given.
  let spilled = "";
  if (pair.partner && pair.spill > 0) {
    const p = pair.partner;
    const base = e.baseStock ?? e.stock;
    const feet = (base?.[k] ?? 0) * (e.swanUse![k] ?? 1) * (mult - 1);
    const partnerBase = (base?.[p] ?? 0) * (e.swanUse![p] ?? 1);
    if (partnerBase > 0) {
      const partnerMult = 1 - (feet * pair.spill) / partnerBase;
      e.swanUseTo![p] = clamp((e.swanUseTo![p] ?? 1) * partnerMult, LEVEL_FLOOR, LEVEL_CEIL);
      e.swanUseM![p] = glide;
      spilled = ` ${dir < 0 ? "Some of that demand does not vanish — it turns up as" : "Some of it has to come from somewhere, and it comes out of"}`
        + ` about ${Math.round(Math.abs(partnerMult - 1) * 100)}% ${partnerMult > 1 ? "more" : "less"}`
        + ` demand for ${USE_WORD[p]}.`;
    }
  }

  const story = USE_STORY[`${k}:${dir < 0 ? "-1" : "+1"}`];
  const pct = Math.round(Math.abs(mult - 1) * 100);
  const yrs = (glide / 12).toFixed(0);
  const detail = `About ${pct}% of this city's demand for ${USE_WORD[k]} over the next ${yrs} years`
    + exposureLine(s, k);

  // A use event restructures a whole building type rather than one trade, so it
  // reaches further per point than a trade event does and its bar sits lower.
  // USE_MAG bands run 0.08-0.18 against the trade range's 0.12-0.42: a tenth of
  // a city's demand for a building type is the high street losing the
  // department store, and that is a card. Five per cent is a trend.
  if (mag >= 0.10 || exposureToUse(s, k) >= CARD_EXPOSURE) {
    raise(s, { kind: "swan", tone: dir < 0 ? "bad" : "good", title: story.title, body: story.body + spilled, detail });
  }
  news(s, dir < 0 ? "warn" : "event", `${story.title}. ${detail}`);
  if (!s.swanLog) s.swanLog = [];
  s.swanLog.push({ m: s.month, family: "use", key: k, dir, mult: +mult.toFixed(4), glideM: glide, title: story.title });
}

// -------------------------------------------------------------------- ticking

/**
 * One month of the tails. Called at the very top of `tickEcon`, before the
 * industry clock and before the demand block, so every reader downstream sees
 * the same level for the month.
 */
export function tickSwans(s: GameState) {
  const e = s.econ;
  ensure(e);

  // --- the levels glide, and they never revert ------------------------------
  //
  // Linear toward the target over the months the event said it would take.
  // Not exponential: a trade leaving is a schedule — plants close on dates,
  // leases expire on dates — and an exponential approach would leave a tail
  // of the event running for decades, which would make the distress wave
  // never quite close and the level never quite arrive.
  // WEIGHTED BY HOW BIG EACH TRADE ACTUALLY IS HERE — see `sectorShare`, which
  // the demand model publishes. A flat tenth is the fallback and it is only
  // right for the first tick of a campaign, before the model has run once.
  const share = (k: Sector) => e.sectorShare?.[k] ?? 1 / SECTORS.length;
  const tradeMean = () => SECTORS.reduce((a, k) => a + share(k) * (e.swanTrade![k] ?? 1), 0);
  const tradeBefore = tradeMean();
  for (const k of SECTORS) {
    const left = e.swanTradeM![k] ?? 0;
    if (left > 0) {
      e.swanTrade![k] += ((e.swanTradeTo![k] ?? 1) - e.swanTrade![k]) / left;
      e.swanTradeM![k] = left - 1;
      if (left - 1 <= 0) e.swanTrade![k] = e.swanTradeTo![k] ?? e.swanTrade![k];
    }
    // the two-year memory of what normal was — see REF_TAU_M
    e.swanTradeRef![k] = (e.swanTradeRef![k] ?? 1) + (e.swanTrade![k] - (e.swanTradeRef![k] ?? 1)) / REF_TAU_M;
  }
  for (const k of BUILT_CLASSES) {
    const left = e.swanUseM![k] ?? 0;
    if (left > 0) {
      e.swanUse![k] += ((e.swanUseTo![k] ?? 1) - e.swanUse![k]) / left;
      e.swanUseM![k] = left - 1;
      if (left - 1 <= 0) e.swanUse![k] = e.swanUseTo![k] ?? e.swanUse![k];
    }
  }

  // --- THE JOBS GO WITH THE TRADE -------------------------------------------
  //
  // A trade leaving takes its payroll, and this is the wire that lets a level
  // event reach housing, retail, the unemployment rate, migration and — through
  // the Phillips term — the price level, without any of them being written to
  // directly.
  //
  // HOW BIG THE TRADE WAS. This used to average the ten flat, and said so: "each
  // an equal share of the city's employment... nothing anywhere weights one
  // trade above another." That was not true when it was written. `TRADE_AFFINITY`
  // in demand.ts weights every trade by building class — finance 3 in an office,
  // 0.2 in a warehouse; logistics the other way round — and `EMP_CONC` raises
  // the result to the 2.2, so the spread is structural and large. Measured on
  // the shipped town: finance 17.8%, tech 16.4%, law 15.4% down to medical 5.2%
  // and logistics 2.5%, a 7.1x spread. Across four generated towns it runs 4.4x
  // to 7.1x and the leader is not always the same trade — law leads one of
  // them. The flat tenth made losing this city's logistics trade cost as many
  // jobs as losing its finance trade, which is seven times the payroll.
  //
  // Sized: a trade shedding 30% of its local footprint over five years is 3% of
  // the city's jobs over five years IF that trade is a tenth of the city — the
  // big three now cost more than that and the small ones less, which is the
  // point. Rochester lost roughly a tenth of its employment over the twenty-five
  // years of Kodak's decline.
  const tradeAfter = tradeMean();
  e.swanJobDrift = tradeBefore > 0 ? tradeAfter / tradeBefore - 1 : 0;

  // Halfway through a level event, when it has stopped being an announcement
  // and started being a vacancy figure, the tape says so once. This sits ABOVE
  // the annual gate deliberately and it was below it in the first cut, where it
  // was dead code: an event is announced in a month divisible by twelve and its
  // midpoint almost never is, so the follow-up fired for about one event in
  // twelve. A line of news that exists and is never printed is worse than no
  // line, because the tape then implies the event stopped mattering.
  for (const r of s.swanLog ?? []) {
    if (s.month !== r.m + Math.round(r.glideM / 2)) continue;
    news(s, r.dir < 0 ? "warn" : "event", r.family === "trade"
      ? `About half of the ${INDUSTRY_LABEL[r.key as Sector].toLowerCase()} adjustment has landed now. `
        + `The rest of it is in leases that have not expired yet, and every one of them expires.`
      : `The shift in what this city wants from its ${USE_WORD[r.key as BuiltClass] ?? r.key} is about half done. `
        + `The other half is already inside the pipeline decisions being taken this year.`);
  }

  // --- and once a year, the draw -------------------------------------------
  if (s.month < QUIET_M || s.month % 12 !== 0) return;
  const yr = Math.floor(s.month / 12);
  if (hash01(`${s.seed}:swan:trade:${yr}`) < TRADE_HAZARD_YR) fireTrade(s, yr);
  if (hash01(`${s.seed}:swan:use:${yr}`) < USE_HAZARD_YR) fireUse(s, yr);
}

/**
 * WHAT A LEVEL EVENT DOES TO DEMAND FOR A KIND OF SPACE.
 *
 * Two independent things multiply here and they are different in kind. The USE
 * level is a statement about the space itself — how much office this city wants
 * per office job. The TRADE level is a statement about who is here to want it,
 * averaged over the trades that actually occupy this class, because a class's
 * tenancy is drawn from exactly that list in leasing.ts and nothing there
 * weights one above another.
 *
 * Multifamily has no trades in it and gets 1.0 from that half, on purpose: a
 * trade leaving town reaches housing through jobs and then through people, and
 * routing it through a rent roll as well would be counting it twice. Retail is
 * the same argument at 32% rather than at 100% — see TRADE_WEIGHT, which is the
 * fix for the one measured fault this file had.
 */
export function swanClassLevel(e: Econ, k: BuiltClass): number {
  const use = e.swanUse?.[k] ?? 1;
  const list = SECTOR_CLASSES[k];
  const w = TRADE_WEIGHT[k] ?? 1;
  if (!list || !e.swanTrade || w <= 0) return use;
  let a = 0;
  for (const j of list) a += e.swanTrade[j] ?? 1;
  // AGAINST THE CITY, NOT AGAINST ONE — because the city mean has already
  // arrived by another road.
  //
  // `swanJobDrift` is by construction the ratio of the MEAN trade level, and it
  // multiplies `employIdx`, which is the office and industrial demand driver.
  // So by the time this function is consulted, the citywide average is already
  // inside `Math.pow(driver, elastic)`. Returning the class's ABSOLUTE mean
  // multiplied that same target by the average a second time: office demand
  // became mean x class where the right quantity is class alone.
  //
  // Measured with a shock carrying no compositional content at all — all ten
  // trades to 0.90, where the honest answer is "ten per cent fewer jobs, so
  // about ten per cent less office" — against an identical build with this term
  // suppressed, 5 seeds, 15-year means: office availability gap +7.25pp against
  // +3.52pp, industrial +7.72pp against +2.05pp, real office rent -43.4%
  // against -30.6%. Double the office response and nearly four times the
  // industrial one, for a shock that says nothing about which trade left.
  //
  // This is the exact fault TRADE_WEIGHT above was written to fix — "counted
  // ONCE instead of twice" — diagnosed for retail and left standing for office
  // and industrial. And the 0.32 retail weight does not cover it, because it
  // answers a different question: how much of retail's driver is firms, not
  // whether the mean has already been counted.
  //
  // The corrected shape is the one `tickEmployment` already uses in demand.ts,
  // where a block's trade advantage is `m - city` — a deviation from the town's
  // own average, precisely because the aggregate is carried elsewhere. So this
  // is the class's mean relative to the city's, and it is exactly 1.0 when
  // every trade has moved together, which is what leaves the aggregate to
  // `employIdx` alone.
  let cityTot = 0;
  for (const j of SECTORS) cityTot += e.swanTrade[j] ?? 1;
  const cityMean = SECTORS.length ? cityTot / SECTORS.length : 1;
  const rel = cityMean > 0 ? (a / list.length) / cityMean : 1;
  return use * (1 + w * (rel - 1));
}

/**
 * THE ADJUSTMENT, in `industryMom`'s own units, to be added to the cycle
 * rather than to replace it. Zero when a trade's level is standing still —
 * which is the point. See REF_TAU_M and WAVE_GAIN above for the derivation
 * and for why the distress ends but the level does not.
 */
export function swanTradeWave(e: Econ, k: Sector): number {
  const lvl = e.swanTrade?.[k];
  const ref = e.swanTradeRef?.[k];
  if (!lvl || !ref) return 0;
  return clamp((lvl / ref - 1) * WAVE_GAIN, -0.06, 0.06);
}
