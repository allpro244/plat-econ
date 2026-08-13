// THE EXTENDED-PAPER RECORD, and whether it survives the building it is about.
//
//   node test/extleak.mjs            five seeds, fifty years
//   SEEDS=11,22 HZ=1200 node ...
//
// `tickMaturities` files an extension under a prefixed key on `heldSince`, and
// `tickRivals` reads "does this firm have ANY extended paper" to decide whether
// the cash flow is swept — a firm in forbearance stops paying its partners.
// That reader scans every key in the map, so a record left behind for a
// building the firm no longer owns suppresses distributions forever.
//
// Eight sites take a bbl off a rival. Three clear the record. This counts what
// the other five leave behind, and — the number that matters — how many
// firm-months are swept by a record that does not correspond to any building
// the firm still owns.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22").split(",").map(Number);
const HZ = Number(process.env.HZ ?? 600);
const EXT = "ext|";

// A firm's extension records, split by whether the deed is still on its book.
const split = (r) => {
  let live = 0, stale = 0;
  const own = new Set(r.bbls ?? []);
  const map = r.extendedTo ?? r.heldSince ?? {};
  for (const k of Object.keys(map)) {
    // Post-fix the records live in their own map and carry no prefix; pre-fix
    // they are prefixed keys inside `heldSince`. Read both so the same probe
    // measures both builds.
    const bbl = r.extendedTo ? k : k.startsWith(EXT) ? k.slice(EXT.length) : null;
    if (bbl === null) continue;
    if (own.has(bbl)) live++; else stale++;
  }
  return { live, stale };
};

let firmMonths = 0, sweptMonths = 0, falseSweptMonths = 0, staleRecords = 0, liveRecords = 0;
let firmsEndingStale = 0, firmsEnding = 0, worstStale = 0;

for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    for (const r of g.rivals ?? []) {
      if (r.failedM !== undefined) continue;
      firmMonths++;
      const { live, stale } = split(r);
      liveRecords += live; staleRecords += stale;
      if (stale > worstStale) worstStale = stale;
      if (live + stale > 0) sweptMonths++;
      if (stale > 0 && live === 0) falseSweptMonths++;
    }
  }
  for (const r of g.rivals ?? []) {
    if (r.failedM !== undefined) continue;
    firmsEnding++;
    if (split(r).stale > 0) firmsEndingStale++;
  }
}

const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(2) : "0.00") + "%";
console.log(`seeds ${SEEDS.length}  horizon ${HZ}m  firm-months ${firmMonths}`);
console.log(`extension records seen : live ${liveRecords}  stale ${staleRecords}  (${pct(staleRecords, liveRecords + staleRecords)} stale)`);
console.log(`swept firm-months      : ${sweptMonths} (${pct(sweptMonths, firmMonths)})`);
console.log(`  of which the sweep is held up by a record with no building behind it:`);
console.log(`  FALSE SWEEP          : ${falseSweptMonths} (${pct(falseSweptMonths, firmMonths)} of all firm-months, ${pct(falseSweptMonths, sweptMonths)} of swept)`);
console.log(`firms alive at the end : ${firmsEnding}, carrying a stale record: ${firmsEndingStale} (${pct(firmsEndingStale, firmsEnding)})`);
console.log(`worst single firm      : ${worstStale} stale records at once`);

// AN IDENTITY, NOT A BAND. A firm's open files are about buildings it owns —
// there is no reading of the world in which a workout on a building somebody
// else has owned for forty years is still on this firm's desk. That is why
// this exits non-zero rather than printing a number: nothing about it is a
// matter of taste, and a stale record is the same fault whether there is one
// or nine thousand.
//
// WHAT THIS DOES AND DOES NOT CATCH, checked rather than assumed. Deleting one
// of the `forgetDeed` calls does NOT trip it, because `pruneExtensions` runs in
// every firm's tick and sweeps the record the following month. The guarantee is
// the prune; the call sites are same-month hygiene on top of it. So this test
// catches the prune being removed, weakened, or skipped for some class of firm
// — which is the load-bearing part — and it is honest about not being a lint on
// eight call sites. It exits 1 against the engine as it stood before the fix.
if (staleRecords > 0) {
  console.log(`\nFAIL  ${staleRecords} extension records outlived the building they are about.`);
  console.log(`      A firm is carrying an open workout file on a building somebody else owns.`);
  console.log(`      Look at pruneExtensions in rivals.ts first — it is what guarantees this.`);
  process.exit(1);
}
console.log(`\nOK    every open file is about a building the firm still owns`);
