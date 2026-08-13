// Seller reservation curve — bidOdds monotonicity, distress, cold holders (#33).
// Phase 4.1 measurement: also print accept odds by seller kind / distress / rel.
//   pnpm engine && pnpm seller-stats
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

// --- Unit surface on one seed (existing gates) ---
{
  let g = E.firstListings(E.newGame(550991, parcels), parcels, bbls);
  const listing = g.listings.find((l) => l.ask > 500_000);
  ok("tape has a listing", !!listing);
  if (!listing) process.exit(1);

  const bbl = listing.bbl;
  let prev = -0.01;
  for (const pct of [0.65, 0.75, 0.85, 0.90, 0.94, 0.97, 1.0]) {
    const p = E.bidOdds(g, parcels, bbl, listing, Math.round(listing.ask * pct));
    ok(`odds rise at ${(pct * 100).toFixed(0)}% of ask`, p >= prev - 1e-9, `p=${p.toFixed(3)} prev=${prev.toFixed(3)}`);
    prev = p;
  }

  const mid = E.bidOdds(g, parcels, bbl, listing, Math.round(listing.ask * 0.94));
  ok("94% of ask is near coin flip", mid > 0.35 && mid < 0.75, `p=${mid.toFixed(3)}`);

  const low = E.bidOdds(g, parcels, bbl, listing, Math.round(listing.ask * 0.70));
  ok("70% of ask is long shot", low < 0.05, `p=${low.toFixed(4)}`);

  const distress = { ...listing, distress: true };
  const distressMid = E.bidOdds(g, parcels, bbl, distress, Math.round(listing.ask * 0.94));
  ok("distress listing accepts lower bids", distressMid > mid,
    `distress=${distressMid.toFixed(3)} normal=${mid.toFixed(3)}`);

  for (let m = 0; m < 48 && !E.holderOf(g, parcels, bbl); m++) {
    g = E.advanceQuarter(g, parcels, bbls, adjacency ?? {});
    const li = g.listings.find((l) => l.bbl === bbl);
    if (!li) break;
  }
  const held = E.holderOf(g, parcels, bbl);
  if (held) {
    E.offend(g, held.id, 18, parcels);
    const li2 = g.listings.find((l) => l.bbl === bbl) ?? listing;
    ok("cold holder → bidOdds 0", E.bidOdds(g, parcels, bbl, li2, li2.ask) === 0);
  } else {
    console.log("SKIP  cold-holder case (no named holder on sample listing)");
  }
}

// --- Phase 4.1 report: histogram across seeds (measurement + light gates) ---
{
  const SEEDS = [550991, 12007, 73303, 11, 22, 33, 4242, 7777, 99, 1013];
  const YEARS = 40;
  const byKind = {};
  const byDistress = { yes: [], no: [] };
  const byRel = { cold: [], warm: [], hot: [], none: [] };
  let n = 0;

  const advance = E.advanceMonth ?? ((s, p, b, a) => E.advanceQuarter(s, p, b, a));
  for (const seed of SEEDS) {
    let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
    for (let m = 0; m < YEARS * 12; m++) {
      if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
      if (m % 12 === 0) {
        for (const li of g.listings) {
          if (li.ask < 250_000) continue;
          const seller = E.sellerOf(g, parcels, li.bbl);
          const kind = seller?.kind ?? "unknown";
          const p94 = E.bidOdds(g, parcels, li.bbl, li, Math.round(li.ask * 0.94));
          (byKind[kind] ??= []).push(p94);
          (li.distress ? byDistress.yes : byDistress.no).push(p94);
          const held = E.holderOf(g, parcels, li.bbl);
          if (!held) byRel.none.push(p94);
          else if (E.isCold(g, held.id)) byRel.cold.push(p94);
          else {
            const deals = E.relOf(g, held.id)?.deals ?? 0;
            if (deals >= 2) byRel.hot.push(p94);
            else byRel.warm.push(p94);
          }
          n++;
        }
      }
      g = advance(g, parcels, bbls, adjacency ?? null);
    }
  }

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const fmt = (arr) => {
    if (!arr.length) return "n=0";
    const s = sorted(arr);
    return `n=${arr.length}  mean@94%=${mean(arr).toFixed(3)}  p10=${s[Math.floor(arr.length * 0.1)].toFixed(3)}  p90=${s[Math.floor(arr.length * 0.9)].toFixed(3)}`;
  };

  console.log("\n--- #33 Phase 4.1 surface (report) ---");
  console.log(`samples: ${n} listing-years across ${SEEDS.length} seeds × ${YEARS}y (annual tape snapshot)`);
  console.log("\nby seller kind (bidOdds at 94% of ask):");
  for (const k of Object.keys(byKind).sort()) console.log(`  ${k.padEnd(14)} ${fmt(byKind[k])}`);
  console.log("\nby distress:");
  console.log(`  voluntary     ${fmt(byDistress.no)}`);
  console.log(`  distressed    ${fmt(byDistress.yes)}`);
  console.log("\nby holder relationship:");
  for (const k of ["none", "warm", "hot", "cold"]) console.log(`  ${k.padEnd(14)} ${fmt(byRel[k])}`);

  ok("sampled listings for histogram", n >= 50, `n=${n}`);
  const vol = mean(byDistress.no);
  const dist = mean(byDistress.yes);
  if (byDistress.yes.length >= 10 && byDistress.no.length >= 10) {
    ok("distress mean odds ≥ voluntary @94%", dist + 1e-9 >= vol,
      `distress=${dist.toFixed(3)} voluntary=${vol.toFixed(3)}`);
  } else {
    console.log("SKIP  distress vs voluntary mean (thin sample)");
  }
}

console.log(`\n${fails === 0 ? "seller-stats pass" : `${fails} seller-stats failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
