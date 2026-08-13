// Holder memory beyond approaches — cold holders block every acquire door,
// hang up mid-flight talks across their book, and stay visible (not buyable)
// on the open tape.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(550991, parcels), parcels, bbls);

function ok(label, cond) {
  if (!cond) throw new Error(`FAIL  ${label}`);
  console.log(`  OK   ${label}`);
}

let target = null;
for (let m = 0; m < 48 && !target; m++) {
  g = E.advanceQuarter(g, parcels, bbls, {});
  for (const l of g.listings) {
    const held = E.holderOf(g, parcels, l.bbl);
    if (held) { target = { bbl: l.bbl, id: held.id, name: held.name }; break; }
  }
}
ok("listed building with named holder", !!target);

// A second deed in the same book — hang-up has to reach past the insult address.
const book = E.holdingsOf(g, parcels, target.id).filter((b) => b !== target.bbl);
ok("holder owns more than one deed", book.length >= 1);
const other = book[0];

// Plant a live off-market ask on the OTHER deed, then insult on the listing.
g = {
  ...g,
  approaches: {
    ...g.approaches,
    [other]: { q: g.month, refused: false, ask: 1_000_000, mode: "ask" },
  },
  talks: {
    ...(g.talks ?? {}),
    [other]: {
      bbl: other,
      sellerKind: "estate",
      sellerName: target.name,
      yourPrice: 900_000,
      theirPrice: 1_000_000,
      round: 1,
      maxRounds: 4,
      final: false,
      note: "test",
    },
  },
};

E.offend(g, target.id, 18, parcels);
ok("holder cold after offence", E.isCold(g, target.id));
ok("hang-up refuses other approach", !!g.approaches[other]?.refused);
ok("hang-up drops open talks (not under contract)", !g.talks?.[other]);

const buy = E.buyListing(g, parcels, target.bbl, "cash");
ok("buyListing blocked", !!buy.err && /will not sell/i.test(buy.err));

const neg = E.negotiate(g, parcels, target.bbl, Math.round(g.listings.find((l) => l.bbl === target.bbl).ask * 0.85));
ok("negotiate blocked", !!neg.err);

const listing = g.listings.find((l) => l.bbl === target.bbl);
const odds = E.bidOdds(g, parcels, target.bbl, listing, Math.round(listing.ask * 0.9));
ok("bidOdds zero when cold", odds === 0);

// Mid-flight off-market doors — re-plant a live ask and prove each mutator.
g.approaches[other] = { q: g.month, refused: false, ask: 1_000_000, mode: "ask" };
const om = E.buyOffMarket(g, parcels, other, "cash");
ok("buyOffMarket blocked when cold", !!om.err && /will not sell/i.test(om.err));

const ctr = E.counterOffMarket(g, parcels, {}, other, 880_000);
ok("counterOffMarket blocked when cold", !!ctr.err && /will not sell/i.test(ctr.err));

g.approaches[other] = { q: g.month, refused: false, reserve: 1_200_000, mode: "offer" };
const blind = E.submitBlindBid(g, parcels, other, 1_000_000);
ok("submitBlindBid blocked when cold", !!blind.err && /will not sell/i.test(blind.err));

g.talks = {
  ...(g.talks ?? {}),
  [other]: {
    bbl: other,
    sellerKind: "estate",
    sellerName: target.name,
    yourPrice: 900_000,
    theirPrice: 1_000_000,
    round: 1,
    maxRounds: 4,
    final: false,
    note: "test",
  },
};
const take = E.acceptCounter(g, parcels, other);
ok("acceptCounter blocked when cold", !!take.err && /will not sell/i.test(take.err));

// Still on the tape for the market — cold is personal, not a delisting.
ok("listing still on tape when cold", g.listings.some((l) => l.bbl === target.bbl));
ok("coldOnDeed names the holder", E.coldOnDeed(g, parcels, target.bbl)?.id === target.id);

console.log("\nholder-listing pass");
