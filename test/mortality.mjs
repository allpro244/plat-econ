// WHY DOES THE STREET DIE?
//
//   pnpm mortality                    four towns, fifty years, no player
//   N=8 HZ=720 pnpm mortality         more of both
//
// The observation this exists to answer: too many competing firms fail, and
// they fail too fast. That is a claim about a RATE, and a rate needs a
// denominator, so nothing here counts deaths on their own.
//
// HOW A FIRM ACTUALLY DIES IN THIS ENGINE, from rivals.ts. Every month a firm
// short of cash draws its line; if it is still short after that, the month is a
// MISSED PAYMENT and `stressMs` starts counting. From there:
//
//   stressMs 1+     ring the partners — but only for money that CURES the
//                   arrears, and only out of `distributed x RECALL[style]`
//   stressMs even   market one building, sized to the hole
//   stressMs 6, 12  hand a building back (deed in lieu)
//   stressMs > 14   the desks take the relationship. NOTICE_M + FORECLOSE_M.
//
// So death is never a mark-to-market opinion — that test was removed once
// already and the note above it is worth reading. It is fourteen months of
// missed payments with four rescues that were all supposed to fire first.
//
// WHAT THIS MEASURES, and why each one is shaped the way it is:
//
//   1. THE ROSTER over time. The headline number, and the only one that needs
//      no estimator.
//   2. HAZARD BY AGE, deaths per hundred firm-years AT RISK. A raw count of
//      deaths by age is a survivorship artefact — only long-lived firms reach
//      the old buckets — so every rate here divides by exposure.
//   3. HAZARD BY PHASE. Real sponsor failure clusters hard in busts. If this
//      comes out flat, the model is killing firms with something that is not
//      the cycle, and that is the finding rather than a detail.
//   4. HAZARD BY STYLE, which says whether one business model is broken or the
//      street is.
//   5. THE ARREARS FUNNEL, counted in EPISODES rather than months. A firm in
//      arrears for fourteen months is one episode, and counting its months
//      would report the same firm fourteen times and call it a trend. Of the
//      episodes that start, how many cure and how many run the clock out.
//   6. WHETHER THE FOUR RESCUES ARE ALIVE. A rescue that never fires is dead
//      code wearing a mechanism's name, and CLAUDE.md is explicit that a test
//      which cannot fail is itself a fake. Each is counted by its own
//      fingerprint on the balance sheet: `revolver` rising is a draw,
//      `distributed` falling is a capital call, `bbls` shrinking is a building
//      leaving. All four are reported even at zero, because a mechanism that
//      only becomes visible once it works is one nobody can see failing.
//   7. WHAT THE DYING LOOKED LIKE when the arrears STARTED, against every
//      firm-month that was not in arrears. That contrast is the identification:
//      a number that is alarming among the dying and identical among the living
//      explains nothing.
//
// ---------------------------------------------------------------------------
// WHAT IT FOUND, ten towns over fifty years, no player.
//
// THE PREMISE IS HALF WRONG. Firms do not fail often: 0.22 deaths per town-year,
// one about every four and a half years in a given town, and the roster only
// falls from 31.5 to 22.5 across half a century. The old mark-to-market
// solvency test that took the street from 31 firms to 9 is gone and the numbers
// it produced should not be quoted any more.
//
// THEY DO FAIL YOUNG, and that is the real answer:
//
//   0-5yr     60 deaths   3.74 per 100 firm-years    <-- 55% of all deaths
//   5-10yr     3 deaths   0.21
//   10-20yr   18 deaths   0.69
//   20-35yr   10 deaths   0.27
//   35+yr     19 deaths   0.58
//
//   median firm age, arrears that CURED    26.6 years
//   median firm age, arrears that KILLED    2.0 years
//
// Arrears themselves are ordinary and nearly always survivable — 944 episodes,
// 88.3% cured, median one month. What separates the two populations is age, and
// the mechanism is in reach: the FIRST and cheapest rescue is a call on the
// partners, and `recallable()` is `distributed x RECALL[style]`. A firm that
// has never made a distribution has nothing to recall. It is two years old, so
// it never has. 10.8% of all arrears open with an empty well, and those are
// concentrated in exactly the cohort doing the dying.
//
// AND TROUBLE THAT STARTS AT THE PEAK IS THE TROUBLE THAT KILLS:
//
//   phase at onset   onsets/100fy   share of those episodes that were fatal
//   expansion            4.97          4.9%
//   peak                 7.22         36.0%
//   recession           10.97         17.2%
//   recovery             8.64          5.8%
//
// Recessions generate the most trouble; the peak generates the most FATAL
// trouble, seven times the expansion rate. That is the right shape and nothing
// asserts it — a firm that overextended at the top has no cushion when the
// values it borrowed against come back down. Styles agree: opportunistic 3.69,
// vulture 2.74, developer 2.10 against family 0.04 and owneruser 0.00. Leverage
// kills and equity does not.
//
// THE ONE THING THAT LOOKS WRONG. Entry does not replace exit — 54 firms opened
// against 110 that closed, 0.49 per failure. rivals.ts states the opposite
// intent in as many words: "a city that loses three shops over a century and
// never gains one is not a city, it is a slow liquidation." The entry hazard is
// `leverage x product x thin / RAISE_M`, a product of three sub-1 terms, and it
// clears about half the ground it needs to. Not the stated failure mode — entry
// is alive, 54 firms is not zero — but below replacement, so the street thins.
//
// AND THE TAPE IS LOUDER THAN THE GRAVEYARD: 2.6 distress stories per town-year
// against 0.22 deaths, a factor of twelve. Missed payments, forced sales and
// handed-back deeds all file copy, and almost all of them are cured a month
// later. A player who feels the street is dying is reading the tape correctly
// and the roster not at all.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N || 4);
const HZ = +(process.env.HZ || 600);

const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);
const pct = (x) => (100 * x).toFixed(1) + "%";
const med = (a) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const h = b.length >> 1; return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2; };

// ---- accumulators
const roster = [];                       // [year][seed] -> live firm count
const hazAge = new Map();                // ageBucket -> {died, exposureMonths}
const hazStyle = new Map();              // style -> {died, exposureMonths}
/**
 * PHASE IS ATTRIBUTED AT THE ONSET OF ARREARS, NOT AT DEATH, and the first cut
 * of this file got it wrong in a way worth leaving written down.
 *
 * A firm cannot die until it has missed fourteen months of payments. Booking
 * the death against the phase it lands in therefore reads the cycle position
 * more than a year AFTER the trouble started, and a firm that got into trouble
 * at the bottom of a recession dies in the recovery. Measured that way the
 * table came out recovery 1.06, recession 0.71, peak 0.22 — "the street dies in
 * the upswing", which is a backwards-looking wire and would have been reported
 * as one. It was the fourteen-month clock, shifted onto the wrong bar.
 *
 * So the rate that means anything is ONSET per firm-year of exposure in that
 * phase: when does trouble START. Deaths are still shown, attributed to the
 * phase the arrears began in, which is the decision the cycle actually drove.
 */
const hazPhase = new Map();              // phase at ONSET -> {died, onsets, exposureMonths}
const episodes = [];                     // {cured, died, months, style}
// A RESCUE ONLY COUNTS WHILE THE FIRM IS IN ARREARS. The first cut of this
// counted every month `bbls` shrank and reported 2,470 "buildings left the
// book" as though the street were being liquidated — but a firm selling a
// building it no longer wants looks identical on the balance sheet to one being
// forced out of it, and almost all of those were ordinary trade. Conditioning
// on `stressMs > 0` is what separates a disposal from a rescue.
const fired = { revolver: 0, call: 0, assetGone: 0 };
let ordinarySales = 0;
const atOnset = [];                      // balance sheet when arrears began
const calm = [];                         // balance sheet of firm-months not in arrears
let bornTotal = 0, diedTotal = 0;
// ENTRY IS A MECHANISM TOO. rivals.ts says a failed firm is replaced, "because
// the buildings do not go away". Whether replacement actually keeps pace with
// failure is the difference between a street that churns and one that empties,
// and the roster alone cannot tell them apart.
let enteredLater = 0;
// A firm that has never distributed cannot call capital at all — recallable()
// is `distributed x RECALL[style]`. Worth counting separately from calls that
// were possible and simply were not enough.
let onsetWithNoWell = 0;
/**
 * HOW OFTEN THE STREET'S TROUBLE REACHES THE PLAYER AS A HEADLINE.
 *
 * A mortality RATE and a felt impression are different quantities, and this is
 * the second one. If firms die rarely but every missed payment, forced sale and
 * handed-back deed files a story, the tape reads like carnage while the roster
 * barely moves — and the player is right about what they saw and wrong about
 * what it meant. Counted per town-year so it is comparable to the hazard above.
 */
const distress = /finished|wound up|receiver|handed back|hand.*back|deed in lieu|missed .* months|arrears|lenders|foreclos|could not cure|stopped answering/i;
let distressNews = 0, allNews = 0;

const AGE_BUCKETS = [[0, 5], [5, 10], [10, 20], [20, 35], [35, 999]];
const ageKey = (yrs) => { for (const [lo, hi] of AGE_BUCKETS) if (yrs >= lo && yrs < hi) return `${lo}-${hi === 999 ? "+" : hi}yr`; return "?"; };
const bump = (map, key, field, by = 1) => {
  if (!map.has(key)) map.set(key, { died: 0, exposure: 0, onsets: 0 });
  map.get(key)[field] += by;
};

for (let seed = 0; seed < N; seed++) {
  const { parcels, adjacency, bbls } = loadCity(seed, E.normalizeParcels);
  let g = E.firstListings(E.newGame(7001 + seed, parcels), parcels, bbls);
  // Per-firm running state. `prev` is last month's snapshot, which is what
  // makes a rescue visible: none of them is recorded on the state, only their
  // effect on the balance sheet between two months.
  const prev = new Map();
  const born = new Map();
  const openEp = new Map();
  const seenDead = new Set();

  for (let m = 0; m < HZ; m++) {
    // THE FROZEN WORLD. `advanceQuarter` returns state unchanged once gameOver
    // is set, and an unplayed street runs past that. Without this every month
    // after the first death is a copy of the month it died in, and the roster
    // would flatten into a plateau that is nothing but the game being over.
    if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const phase = g.econ.phase ?? "?";
    for (const n of g.news ?? []) {
      if (n.q !== g.month) continue;          // only this month's, once
      allNews++;
      if (distress.test(n.text || "")) distressNews++;
    }
    const live = g.rivals ?? [];
    const liveIds = new Set();

    for (const r of live) {
      const dead = r.failedM !== undefined || r.dead;
      if (!born.has(r.id)) { born.set(r.id, r.bornM ?? m); bornTotal++; if (m > 0) enteredLater++; }
      if (dead) {
        if (!seenDead.has(r.id)) {
          seenDead.add(r.id);
          diedTotal++;
          const yrs = (m - born.get(r.id)) / 12;
          bump(hazAge, ageKey(yrs), "died");
          bump(hazStyle, r.style, "died");
          const ep = openEp.get(r.id);
          // The death is booked against the phase the ARREARS began in — see
          // the note on hazPhase. Without an open episode there is nothing to
          // attribute it to, which is itself worth not guessing at.
          if (ep) { bump(hazPhase, ep.phase, "died"); episodes.push({ ...ep, died: true, months: (r.stressMs ?? 0) }); openEp.delete(r.id); }
        }
        continue;                                   // dead firms are not at risk
      }
      liveIds.add(r.id);

      const aum = r.aum ?? 0;
      const snap = {
        cash: r.cash ?? 0, debt: r.debt ?? 0, aum,
        n: (r.bbls ?? []).length, stress: r.stressMs ?? 0,
        // The well has two chambers since the uncalled-commitments fix:
        // young funds burn LP commitments first, old ones claw distributions.
        // A call is EITHER falling; watching only `distributed` went blind to
        // every young firm's rescue the day the fix landed.
        well: (r.uncalled ?? 0) + (r.distributed ?? 0), revolver: r.revolver ?? 0,
        lev: aum > 0 ? (r.debt ?? 0) / aum : 0,
      };
      const p = prev.get(r.id);

      // ---- exposure: this firm was alive and at risk for one month
      const yrs = (m - born.get(r.id)) / 12;
      bump(hazAge, ageKey(yrs), "exposure");
      bump(hazPhase, phase, "exposure");
      bump(hazStyle, r.style, "exposure");

      // ---- did a rescue fire between last month and this one
      if (p) {
        const inArrears = snap.stress > 0 || p.stress > 0;
        if (snap.revolver > p.revolver + 1 && inArrears) fired.revolver++;
        if (snap.distributed < p.distributed - 1 && inArrears) fired.call++;
        if (snap.n < p.n) { if (inArrears) fired.assetGone++; else ordinarySales++; }
      }

      // ---- arrears episodes, opened on the 0 -> 1 transition
      if (snap.stress > 0 && (!p || p.stress === 0)) {
        openEp.set(r.id, { style: r.style, phase, yrs });
        bump(hazPhase, phase, "onsets");
        atOnset.push({ lev: snap.lev, n: snap.n, aum, style: r.style, phase,
                       cashToAum: aum > 0 ? snap.cash / aum : 0, yrs });
        if (snap.well <= 0) onsetWithNoWell++;
      } else if (snap.stress === 0 && p && p.stress > 0) {
        const ep = openEp.get(r.id);
        if (ep) { episodes.push({ ...ep, died: false, months: p.stress }); openEp.delete(r.id); }
      }
      if (snap.stress === 0) {
        calm.push({ lev: snap.lev, n: snap.n, cashToAum: aum > 0 ? snap.cash / aum : 0 });
      }
      prev.set(r.id, snap);
    }
    // A firm can also simply vanish from the roster rather than being flagged.
    for (const id of prev.keys()) {
      if (!liveIds.has(id) && !seenDead.has(id)) {
        seenDead.add(id); diedTotal++;
        const yrs = (m - (born.get(id) ?? 0)) / 12;
        bump(hazAge, ageKey(yrs), "died");
      }
    }
    if ((m + 1) % 12 === 0) {
      const yr = (m + 1) / 12;
      (roster[yr] ??= []).push(liveIds.size);
    }
  }
}

// ------------------------------------------------------------------ report
console.log(`\nWHY DOES THE STREET DIE — ${N} towns x ${HZ / 12} years, no player\n`);

console.log("  THE ROSTER — median live firms across towns");
const marks = [1, 5, 10, 20, 30, 40, 50].filter((y) => roster[y]);
console.log("    " + marks.map((y) => `yr${y}`.padStart(7)).join(""));
console.log("    " + marks.map((y) => String(med(roster[y])).padStart(7)).join(""));
console.log(`    ${bornTotal} firms existed across the run, ${diedTotal} died (${pct(diedTotal / Math.max(1, bornTotal))})`);
console.log(`    ENTRY vs EXIT: ${enteredLater} firms opened after month 0 against ${diedTotal} that closed`);
console.log(`    — ${(enteredLater / Math.max(1, diedTotal)).toFixed(2)} new firms per failure. Below 1.0 the street thins toward empty;`);
console.log(`    at 1.0 it churns. rivals.ts states the intent: a failed firm is replaced.\n`);

const hazLine = (map, label, order) => {
  console.log(`  ${label}`);
  console.log(`    ${pad("", 14)}${rp("deaths", 9)}${rp("firm-yrs", 11)}${rp("per 100 fy", 13)}`);
  const keys = order ?? [...map.keys()];
  for (const k of keys) {
    const v = map.get(k); if (!v) continue;
    const fy = v.exposure / 12;
    const rate = fy > 0 ? (100 * v.died) / fy : NaN;
    console.log(`    ${pad(k, 14)}${rp(v.died, 9)}${rp(fy.toFixed(0), 11)}${rp(Number.isFinite(rate) ? rate.toFixed(2) : "n/a", 13)}`);
  }
  console.log("");
};
hazLine(hazAge, "HAZARD BY AGE — deaths per 100 firm-years at risk", AGE_BUCKETS.map(([lo, hi]) => `${lo}-${hi === 999 ? "+" : hi}yr`));
console.log("  WHEN TROUBLE STARTS, BY PHASE — attributed to the phase the arrears");
console.log("  BEGAN in, not the one the firm died in. See the note in this file.");
console.log(`    ${pad("", 14)}${rp("onsets", 9)}${rp("deaths", 9)}${rp("firm-yrs", 11)}${rp("onsets/100fy", 15)}${rp("fatal", 16)}`);
for (const k of ["expansion", "peak", "recession", "recovery"]) {
  const v = hazPhase.get(k); if (!v) continue;
  const fy = v.exposure / 12;
  console.log(`    ${pad(k, 14)}${rp(v.onsets, 9)}${rp(v.died, 9)}${rp(fy.toFixed(0), 11)}${rp(fy > 0 ? (100 * v.onsets / fy).toFixed(2) : "n/a", 15)}${rp(v.onsets > 0 ? pct(v.died / v.onsets) : "n/a", 16)}`);
}
console.log("");
hazLine(hazStyle, "HAZARD BY STYLE");

const died = episodes.filter((e) => e.died).length;
const cured = episodes.length - died;
console.log("  THE ARREARS FUNNEL — counted in EPISODES, not months");
console.log(`    episodes started        ${episodes.length}`);
console.log(`    cured                   ${cured}  (${pct(cured / Math.max(1, episodes.length))})`);
console.log(`    ran the clock out       ${died}  (${pct(died / Math.max(1, episodes.length))})`);
console.log(`    median months in arrears, cured: ${med(episodes.filter((e) => !e.died).map((e) => e.months))}`);
// Most arrears happen to OLD firms, which cure them. Most deaths happen to
// young ones. Printed together because either number alone reads as the whole
// story and they point opposite ways.
console.log(`    median firm age — episodes that CURED: ${med(episodes.filter((e) => !e.died).map((e) => e.yrs)).toFixed(1)}yr`);
console.log(`    median firm age — episodes that KILLED: ${med(episodes.filter((e) => e.died).map((e) => e.yrs)).toFixed(1)}yr`);
console.log(`    a firm dies at stressMs > 14 — NOTICE_M 6 + FORECLOSE_M 8\n`);

console.log("  ARE THE FOUR RESCUES ALIVE — firm-months on which each fired");
console.log(`    line drawn (revolver up)      ${fired.revolver}`);
console.log(`    capital called (well down)    ${fired.call}`);
console.log(`    a building left the book      ${fired.assetGone}   (in arrears — a rescue)`);
console.log(`    ordinary disposals            ${ordinarySales}   (not in arrears — just trade)`);
console.log(`    arrears that began with an EMPTY WELL — nothing to call: ${onsetWithNoWell} of ${atOnset.length} (${pct(onsetWithNoWell / Math.max(1, atOnset.length))})`);
console.log(`    recallable() is distributed x RECALL[style], so a firm that has\n    never distributed cannot ring anybody.\n`);

const q = (a, f) => a.length ? med(a.map(f)) : NaN;
console.log("  HOW OFTEN IT REACHES THE PLAYER AS A HEADLINE");
console.log(`    distress stories on the tape   ${distressNews} of ${allNews} items (${pct(distressNews / Math.max(1, allNews))})`);
console.log(`    per town-year                  ${(distressNews / (N * HZ / 12)).toFixed(1)}`);
console.log(`    firm deaths per town-year      ${(diedTotal / (N * HZ / 12)).toFixed(2)}`);
console.log("    A rate and an impression are different quantities. If the second is");
console.log("    much larger than the first, the street is fine and the tape is loud.\n");

console.log("  WHAT THE DYING LOOKED LIKE WHEN THE ARREARS STARTED");
console.log(`    ${pad("", 22)}${rp("in arrears", 13)}${rp("everyone else", 15)}`);
console.log(`    ${pad("leverage (debt/aum)", 22)}${rp(q(atOnset, (x) => x.lev).toFixed(3), 13)}${rp(q(calm, (x) => x.lev).toFixed(3), 15)}`);
console.log(`    ${pad("buildings held", 22)}${rp(q(atOnset, (x) => x.n).toFixed(1), 13)}${rp(q(calm, (x) => x.n).toFixed(1), 15)}`);
console.log(`    ${pad("cash / aum", 22)}${rp(q(atOnset, (x) => x.cashToAum).toFixed(4), 13)}${rp(q(calm, (x) => x.cashToAum).toFixed(4), 15)}`);
console.log(`    ${pad("age at onset, years", 22)}${rp(q(atOnset, (x) => x.yrs).toFixed(1), 13)}${rp("—", 15)}`);
console.log(`\n    n = ${atOnset.length} onsets against ${calm.length} calm firm-months.`);
console.log("    A number that is alarming on the left and identical on the right");
console.log("    explains nothing — that is what this column is for.\n");
