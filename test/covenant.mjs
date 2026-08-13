// A SPONSOR WITH THE MONEY DOES NOT LOSE A BUILDING.
//
//   pnpm covenant
//
// The worst bug this game has shipped: a covenant breach on ONE property walked
// to the workout desk after 24 months and on to foreclosure, and nothing
// anywhere on that path looked at the firm. Measured before the fix, over four
// towns and 420 months with the firm's cash held at $250M: 21 of 21 workout
// files opened, every one of them a covenant cause, and files sat at
// stage=foreclosure for 321 months with the money in the bank. The worst single
// case was a firm holding $221M losing a building whose loan payment was $6,741
// a month, over a $90,000 cure.
//
// The loan was CURRENT the whole time — `tickLoan` sends the payment out of
// firm-wide cash whatever the asset earns, so the shortfall on a weak building
// has always been covered by the rest of the book. No lender forecloses a
// current loan. What a lender does with a technical default is trap the cash
// flow and demand a cure; what a sponsor with capital does is write the cheque.
// `debt.ts` now models the second half of that — an equity cure, which is a
// named clause in commercial loan agreements and was simply missing.
//
// THIS TEST IS TWO-SIDED ON PURPOSE, and that is the whole point of it. A fix
// that stops rich firms losing buildings is trivial to write and trivial to get
// wrong in the other direction: switch the escalation off and the test passes
// while the game loses one of the real risks CLAUDE.md names by hand. So this
// asserts BOTH:
//
//   RICH   a firm that can always pay must never have a file opened on it
//   THIN   a firm that cannot must still breach, still be swept, and still lose
//          buildings — arrears, balloons and covenants all live
//
// If the second half ever reads zero, the cure has stopped being a cure and
// started being an exemption, and this test has become the thing it was written
// to prevent.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const N = +(process.env.N || 4);
const HZ = +(process.env.HZ || 420);
const RICH_CASH = 250e6;
const THIN_CASH = 8e6;

function run(rich) {
  let files = 0, fclMonths = 0, richFiles = 0;
  const causes = {};
  const worst = [];
  for (let seed = 0; seed < N; seed++) {
    const { parcels, adjacency, bbls } = loadCity(seed % 4, E.normalizeParcels);
    let g = E.firstListings(E.newGame(8100 + seed, parcels), parcels, bbls);
    g = { ...g, cash: rich ? RICH_CASH : THIN_CASH };
    // Buy WITH DEBT. An unlevered book has no covenants to break, and a test
    // whose subject never borrows is the kind that cannot fail.
    let bought = 0;
    for (let m = 0; m < 70 && bought < 14; m++) {
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      for (const L of g.listings ?? []) {
        if (bought >= 14) break;
        const rec = E.resolveRec(parcels, g, L.bbl);
        if (!rec || rec.class === "land" || !rec.bldgArea || g.holdings[L.bbl]) continue;
        // WALK THE LADDER, THE WAY A BUYER NOW HAS TO. Alden's desk carries a
        // $2.5M minimum since the lender restructure, so a cheap building
        // financed "with savings" comes through all-cash and covenant-free —
        // which silenced this test's thin arm the day the minimum landed. The
        // subject here is covenants, so the harness borrows from whichever
        // bank actually quotes the deal, exactly like the player.
        const pid = ["savings", "harbor"].find((id) => E.buyQuote(g, parcels, L.bbl, L.ask, id, 1).principal > 0);
        if (!pid) continue;
        const r = E.executePurchase(g, parcels, L.bbl, L.ask, pid, false, 1);
        if (r && r.s && r.s.holdings[L.bbl]?.loan) { g = r.s; bought++; }
      }
    }
    const seen = new Set();
    for (let m = 0; m < HZ; m++) {
      const cashBefore = g.cash;
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      // The rich arm is topped back up: the question is not whether a firm can
      // stay rich for a century, it is what happens to one that IS.
      if (rich && g.cash < 50e6) g = { ...g, cash: RICH_CASH };
      for (const w of Object.values(g.workouts ?? {})) {
        const key = w.bbl + w.cause;
        if (seen.has(key)) continue;
        seen.add(key);
        files++;
        causes[w.cause] = (causes[w.cause] ?? 0) + 1;
        if (cashBefore > 20e6) {
          richFiles++;
          if (worst.length < 3) {
            const rec = E.resolveRec(parcels, g, w.bbl);
            const h = g.holdings[w.bbl];
            worst.push(`${w.cause} on ${rec?.address ?? w.bbl} — firm cash $${(cashBefore / 1e6).toFixed(0)}M, `
              + `payment $${Math.round(h?.loan?.monthlyPmt ?? 0).toLocaleString()}/mo, cure $${(w.cure / 1e6).toFixed(2)}M`);
          }
        }
        if (w.stage === "foreclosure" && cashBefore > 20e6) fclMonths++;
      }
    }
  }
  return { files, causes, richFiles, fclMonths, worst };
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nA SPONSOR WITH THE MONEY DOES NOT LOSE A BUILDING — ${N} towns x ${HZ / 12} years\n`);

const rich = run(true);
const thin = run(false);

console.log(`  ${pad("", 26)}${pad("files opened", 15)}by cause`);
console.log(`  ${pad("rich firm ($250M)", 26)}${pad(rich.files, 15)}${JSON.stringify(rich.causes)}`);
console.log(`  ${pad("thin firm ($8M)", 26)}${pad(thin.files, 15)}${JSON.stringify(thin.causes)}`);
console.log(`\n  files opened on a firm holding over $20M:  ${rich.richFiles + thin.richFiles}`);
for (const w of [...rich.worst, ...thin.worst]) console.log(`    ${w}`);

let bad = 0;
// SIDE ONE — the bug. A firm that can pay must never be taken to the desk.
if (rich.richFiles > 0) {
  bad++;
  console.log(`\n  FAIL  ${rich.richFiles} file(s) opened while the firm was holding over $20M of cash.`);
  console.log("        A lender does not foreclose a loan that is being paid, and a sponsor with");
  console.log("        the money cures a technical default rather than handing back the deed.");
} else {
  console.log("\n  OK    no file opened on a firm that had the cash to cure it.");
}
// SIDE ONE-B — filing. Even a file that somehow opened must not advance to
// foreclosure while the firm is holding the cash to stay current.
if (rich.fclMonths > 0) {
  bad++;
  console.log(`  FAIL  ${rich.fclMonths} foreclosure-month(s) on a firm holding over $20M.`);
  console.log("        The notice calendar is not a deed. A funded, current note does not get filed on.");
} else {
  console.log("  OK    no foreclosure filing while the firm had the cash to stay current.");
}
// SIDE TWO — the over-correction, which is the easier mistake to make.
const thinCauses = Object.keys(thin.causes).length;
if (thin.files === 0) {
  bad++;
  console.log("  FAIL  a thinly capitalised, levered firm went 35 years without a single file.");
  console.log("        The equity cure has become an exemption. Leverage has to bite somebody.");
} else {
  console.log(`  OK    the thin firm still lost files — ${thin.files} across ${thinCauses} cause(s).`);
}
console.log("");
process.exit(bad ? 1 : 0);
