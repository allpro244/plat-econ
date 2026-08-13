// WHAT THE PAPER ACTUALLY PRINTS.
//
// Nothing in this repo measured the news tape, so its volume was a matter of
// opinion until somebody counted: 11-14 warn/event items a YEAR reaching the
// player, and the notification badge lit in roughly three months out of five.
// When everything is news, nothing is.
//
// The badge is a raw count of this month's warn+event (src/ui/TopBar.tsx:27),
// with no dedup, no priority and no relevance layer — so it inherits every
// emitter one for one, and badge% tracks 1-e^(-loud/12) to within a couple of
// points. The only lever on it is what gets filed loud.
//
// TWO NUMBERS, AND THE SECOND IS THE ONE THAT KEEPS THIS HONEST.
//
//   loudPerYr / badgePct       — how noisy the paper is
//   distinct loud emitters     — how much of the CITY it can still tell you about
//
// The second exists because the first is trivially gamed. A change that files
// everything as `info` scores a perfect badge and leaves the player blind, and
// a check that only measures volume would call that a triumph. So the emitter
// count is asserted too: mute the tape below a floor of distinct voices and
// this fails, which is the difference between selective and silent.
//
// Emitters are grouped by TEMPLATE, not instance — numbers, money, addresses
// and dates are stripped — because "68 E 10th St sold" and "116 W 4th St sold"
// are one emitter printing twice, and counting them as two is how a tape that
// says one thing over and over looks varied.
import { assertFreshBundle } from "./fresh.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leaseAtMarket } from "./leasepolicy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
assertFreshBundle();
const E = await import(join(HERE, ".engine.mjs"));
const { makeCity } = await import(join(HERE, "..", "src", "citygen", "index.mjs"));

const SEEDS = (process.env.SEEDS ?? "550991,12007,73303,11,22,4242,90210").split(",").map(Number);
const MONTHS = Number(process.env.HZ ?? 600);
const LOUD = (n) => n.kind === "warn" || n.kind === "event";

// One emitter, many instances. PROPER NOUNS ARE THE HARD PART and getting them
// wrong makes this whole check useless: leave firm names, trade names and
// addresses in and "Technology is in trouble" and "Media is in trouble" count
// as two voices when they are one line printing twice. Measured with a naive
// strip, the tape scored 739 distinct emitters — which would let any floor
// pass no matter how badly the paper had been muted.
const KEEP = new Set(["The","A","An","It","You","Your","And","But","No","Not","This","That","There","They","We","If","In","On","At","Of","For","To","Nobody","Everyone","Every","Anyone","Somebody","Short","Long"]);
const template = (t) => String(t ?? "")
  .replace(/\$[\d.,]+[MBK]?/g, "$#")
  .replace(/\d+(\.\d+)?%/g, "#%")
  .replace(/\b\d[\d,.]*(st|nd|rd|th)?\b/g, "#")
  .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\b/g, "MON")
  // any capitalised word that is not ordinary English is a name, a trade or a
  // street, and none of those identify the EMITTER
  .replace(/\b[A-Z][a-zA-Z'&-]*\b/g, (w) => (KEEP.has(w) ? w : "NAME"))
  .replace(/(NAME[ ,]*)+/g, "NAME ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 80);

function play(seed, active) {
  const b = makeCity("somewhere", 1);
  E.normalizeParcels(b.parcels);
  const parcels = JSON.parse(JSON.stringify(b.parcels));
  const bbls = Object.keys(parcels);
  let g = E.firstListings(E.newGame(seed, parcels), parcels, bbls);
  const byKind = {}, byTpl = new Map();
  let loudMonths = 0, months = 0, resurrections = 0;
  let seen = 0;
  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, bbls, b.adjacency);
    // The frozen world: without this the run stops and every later month is a
    // copy of the month it died in, which would read as a very quiet paper.
    if (g.gameOver) { g = { ...g, gameOver: null, cash: 6e6 }; resurrections++; }
    if (active) {
      g = leaseAtMarket(E, g, parcels);
      if (g.cash > 3e6) {
        for (const li of [...g.listings]) {
          if (g.holdings[li.bbl]) continue;
          const rec = E.resolveRec(parcels, g, li.bbl);
          if (!rec || rec.class === "land") continue;
          const r = E.executePurchase(g, parcels, li.bbl, li.ask, "senior", false, 1);
          if (!r.err) { g = r.s; break; }
        }
      }
    }
    months++;
    // s.news is unshifted and capped, so read only what is NEW this month
    const fresh = (g.news ?? []).filter((n) => n.q === g.month);
    let loud = 0;
    for (const n of fresh) {
      byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
      seen++;
      if (!LOUD(n)) continue;
      loud++;
      const t = template(n.text);
      byTpl.set(t, (byTpl.get(t) ?? 0) + 1);
    }
    if (loud > 0) loudMonths++;
  }
  return { byKind, byTpl, loudMonths, months, seen, resurrections };
}

function report(active) {
  const label = active ? "ACTIVE" : "PASSIVE";
  const agg = { byKind: {}, byTpl: new Map(), loudMonths: 0, months: 0, seen: 0, res: 0 };
  for (const s of SEEDS) {
    const r = play(s, active);
    for (const [k, v] of Object.entries(r.byKind)) agg.byKind[k] = (agg.byKind[k] ?? 0) + v;
    for (const [k, v] of r.byTpl) agg.byTpl.set(k, (agg.byTpl.get(k) ?? 0) + v);
    agg.loudMonths += r.loudMonths; agg.months += r.months; agg.seen += r.seen; agg.res += r.resurrections;
  }
  const yrs = agg.months / 12;
  const loudN = (agg.byKind.warn ?? 0) + (agg.byKind.event ?? 0);
  const badge = agg.loudMonths / Math.max(1, agg.months);
  console.log(`\n  ${label} — ${SEEDS.length} seeds x ${MONTHS} months = ${yrs.toFixed(0)} firm-years, ${agg.res} resurrections\n`);
  console.log(`    warn + event        ${(loudN / yrs).toFixed(2)} a year`);
  console.log(`    the badge lights    ${(100 * badge).toFixed(1)}% of months`);
  console.log(`    whole tape          ${(agg.seen / yrs).toFixed(2)} a year   `
    + Object.entries(agg.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / yrs).toFixed(2)}`).join("  "));
  console.log(`    distinct loud emitters ${agg.byTpl.size}`);
  const top = [...agg.byTpl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`\n    the loudest, per firm-year:`);
  for (const [t, n] of top) console.log(`      ${(n / yrs).toFixed(2).padStart(6)}  ${t}`);
  return { loudPerYr: loudN / yrs, badge, emitters: agg.byTpl.size };
}

const p = report(false);
const a = report(true);

// A FLOOR, NOT A TARGET. A tape with fewer than this many distinct loud voices
// is not selective, it is broken — and that is the failure a volume-only check
// would score as a win, because filing everything as `info` gives a perfect
// badge and a blind player. Set an order of magnitude below what the game
// currently prints (400 passive / 436 active), so it fails on COLLAPSE and
// never on tuning: losing nine voices in ten is a bug, losing one in three is
// a judgement.
const FLOOR = 40;
console.log(`\n  distinct loud emitters: ${p.emitters} passive / ${a.emitters} active   (need >= ${FLOOR} — a quiet tape must still be a tape)\n`);
if (p.emitters < FLOOR || a.emitters < FLOOR) {
  console.error(`  The tape has gone quiet by losing VOICES, not by losing noise.`);
  process.exit(1);
}
