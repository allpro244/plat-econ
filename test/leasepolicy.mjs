// THE ONE LEASING RULE EVERY HARNESS BOT USES.
//
// It was copied into six files — tools/century.mjs, tools/centuryfork.mjs,
// tools/econstress.mjs twice, test/conserve.mjs — as the same four lines. Six
// implementations of one decision drift, and this one was wrong in all six at
// once, which is the argument for it living somewhere.
//
// WHAT WAS WRONG. The rule read `loi.rentPsf >= managedRentPsfYr * 0.92`: take
// a letter if it clears 92% of the market ask. That ask never moved with how
// long the space had been sitting, and the ENGINE'S ASK DOES. `staleDiscount`
// (absorption.ts) marks stale space down by up to 25% over about a two-year
// half-life, because that is what a managing agent does with an empty floor and
// what the 4% fee buys. So the engine generated exactly the discounted letters
// its own markdown implies, and the bot — comparing them against the
// UN-marked-down number — refused every one of them, for ever.
//
// Measured, 25-building all-cash commercial book, 3 seeds, 400 months,
// acceptance rate by how long the space had been dark:
//
//     months dark    0-11    12-35   36-59   60-119   120+
//     acceptance      67%      45%     14%      9%      5%   (n=934)
//
// Median physical occupancy under that rule: office 0%, industrial 0%,
// retail 30% — and multifamily 84%, which is the internal control, because
// flats fill through `h.occ` and never touch this rule at all. The one class
// that bypassed the bot was the one class that stayed full.
//
// That is a ratchet, and every conclusion drawn through these bots inherited
// it: a strategy tournament where three strategies "lose money", and a [G]
// where an UNLEVERED all-cash buyer is wiped out in three worlds of ten. Those
// were measurements of a bot that would not cut its rent, being read as
// findings about an economy.
//
// THE FIX IS NOT A NEW NUMBER. The reservation is the engine's OWN ask for that
// space today — the market rent times the markdown the engine has already
// decided on — and 0.92 stays exactly what it always was: the last bit of
// haggling on top of whatever the ask happens to be. A competent operator cuts
// the ask on space that will not let. This makes the bot do that by reading the
// number the engine already publishes, rather than by having a second opinion
// about it.
export function leaseAtMarket(E, g, parcels) {
  for (const loi of [...g.lois]) {
    const rec = E.resolveRec(parcels, g, loi.bbl);
    const h = g.holdings[loi.bbl];
    if (!rec || !h) continue;
    // The ask the engine itself is making on this space this month: the managed
    // market rent, marked down for however long it has been sitting.
    const ask = E.managedRentPsfYr(rec, g.econ, h, loi.use) * E.staleDiscount(h.darkMs);
    const r = E.respondLOI(g, parcels, loi.id, loi.rentPsf >= ask * 0.92 ? "accept" : "pass");
    if (!r.err) g = r.s;
  }
  return g;
}
