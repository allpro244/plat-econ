// APPROACH TOAST CONTRACT — named ask vs make-me-an-offer must not disagree.
//
//   pnpm engine && node test/approach-toast.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

/** Same sentence the store toast uses — keep this in lockstep with store.ts. */
function toastFor(r, bbl) {
  const ap = r.s.approaches[bbl];
  if (r.refused) return "The owner isn't selling.";
  if (r.blind || ap?.ask === undefined) return "They took the call — make them an offer.";
  return "They named a number.";
}

console.log("\nAPPROACH TOAST / PANEL CONTRACT\n");

const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);
let named = 0;
let blind = 0;
let refused = 0;

for (let seed = 1; seed <= 12; seed++) {
  let g = E.firstListings(E.newGame(91000 + seed, parcels, 80_000_000), parcels, bbls);
  const candidates = bbls.filter((b) => {
    const r = E.resolveRec(parcels, g, b);
    return r && r.class !== "land" && r.bldgArea > 0 && !g.holdings[b]
      && !(g.listings ?? []).some((l) => l.bbl === b);
  }).slice(0, 60);

  for (const bbl of candidates) {
    if (g.approaches[bbl]) continue;
    const r = E.approachOwner(g, parcels, adjacency, bbl);
    if (r.err) continue;
    g = r.s;
    const ap = g.approaches[bbl];
    if (!ap) {
      check(false, "approach wrote a record");
      continue;
    }
    if (r.refused || ap.refused) {
      refused++;
      check(toastFor(r, bbl) === "The owner isn't selling.", "refused toast");
      continue;
    }
    const msg = toastFor(r, bbl);
    const panelHasAsk = ap.ask !== undefined;
    if (panelHasAsk) {
      named++;
      check(msg === "They named a number.", `named ask toast (${msg})`);
      check(r.blind !== true, "named path is not marked blind");
      check(typeof ap.ask === "number" && ap.ask > 0, "ask is a real dollar figure");
    } else {
      blind++;
      check(msg === "They took the call — make them an offer.", `blind toast (${msg})`);
      check(r.blind === true, "blind path sets blind: true");
      check(ap.reserve !== undefined, "blind path keeps a private reserve");
      check(ap.mode === "offer", "blind path mode is offer");
    }
  }
}

check(named > 0 && blind > 0, `saw both shapes (named ${named}, blind ${blind}, refused ${refused})`);

if (bad) {
  console.error(`\n${bad} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll approach-toast checks passed.\n");
