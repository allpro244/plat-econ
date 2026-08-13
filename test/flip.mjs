// THE UNDATED DEED — a building a firm took title to yesterday, listed today
// because the hold clock thinks it has owned it since the day it opened.
//
// `heldSince` is what separates a family office from a fund with an IRR
// mandate. Three paths hand a rival a deed without writing that date: a note
// holder taking title, a firm buying at the foreclosure auction, and a lender
// taking REO onto a firm's book. The hold clock then reads
// `r.heldSince?.[bbl] ?? r.bornM`, so an undated building is as old as the FIRM
// — older than anything the firm legitimately owns, which means it always wins
// the "oldest holding" contest and goes straight back on the tape.
//
// This measures how often a firm lists a building it has owned for less than a
// year, and how much of that is buildings it never dated.
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

let listings = 0, quick = 0, undated = 0, undatedHeld = 0, ownedTotal = 0;
for (const seed of SEEDS) {
  const parcels = JSON.parse(JSON.stringify(P0));
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  // When each firm was last seen owning each building, so "how long have they
  // had it" is observed from outside rather than read off the field under test.
  const seen = new Map();          // `${firmId}|${bbl}` -> first month observed owned
  const listed = new Set();
  for (let m = 0; m < HZ; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const own = new Set();
    for (const r of g.rivals ?? []) {
      if (r.failedM !== undefined) continue;
      for (const b of r.bbls) {
        const k = `${r.id}|${b}`;
        own.add(k);
        if (!seen.has(k)) seen.set(k, g.month);
        ownedTotal++;
        if (r.heldSince?.[b] === undefined) undatedHeld++;
      }
    }
    for (const k of [...seen.keys()]) if (!own.has(k)) seen.delete(k);   // deed moved; the clock restarts
    for (const l of g.listings ?? []) {
      if (!l.sellerId) continue;
      const k = `${l.sellerId}|${l.bbl}`;
      const tag = `${k}|${l.listedM}`;
      if (listed.has(tag)) continue;
      listed.add(tag);
      listings++;
      const since = seen.get(k);
      if (since !== undefined && g.month - since < 12) {
        quick++;
        const r = (g.rivals ?? []).find((x) => x.id === l.sellerId);
        if (r && r.heldSince?.[l.bbl] === undefined) undated++;
      }
    }
  }
}
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(2) : "0.00") + "%";
console.log(`seeds ${SEEDS.length}  horizon ${HZ}m`);
console.log(`firm listings              : ${listings}`);
console.log(`listed inside a year of taking title: ${quick} (${pct(quick, listings)})`);
console.log(`  of those, the deed was never dated: ${undated} (${pct(undated, quick)})`);
console.log(`owned building-months with no date on the deed: ${undatedHeld} of ${ownedTotal} (${pct(undatedHeld, ownedTotal)})`);
