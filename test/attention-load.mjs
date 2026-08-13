// INTERRUPTION LOAD — decisions should stop time; routine state should not.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

const HZ = Number(process.env.HZ ?? 240);
let g = E.firstListings(E.newGame(77119, parcels), parcels, bbls);
g.cash = 100_000_000;

// A small diversified book: enough activity to generate real decisions, not
// enough that twenty simultaneous lease rolls are mistaken for UI noise.
for (const li of [...g.listings]) {
  if (Object.keys(g.holdings).length >= 5) break;
  const rec = E.resolveRec(parcels, g, li.bbl);
  if (!rec || rec.class === "land" || !rec.bldgArea) continue;
  const r = E.executePurchase(g, parcels, li.bbl, li.ask, "cash", true, 0);
  if (!r.err) g = r.s;
}
g.cash = Math.max(g.cash, 50_000_000);

const count = new Map();
let prior = new Set(E.attentionItems(g).map((x) => x.key));
let interruptedMonths = 0;
let maxFresh = 0;
const category = (key) => key.split(":")[0];

for (let m = 0; m < HZ && !g.gameOver; m++) {
  g = E.advanceQuarter(g, parcels, bbls, adjacency);
  const now = E.attentionItems(g);
  const fresh = now.filter((x) => !prior.has(x.key));
  if (fresh.length) interruptedMonths++;
  maxFresh = Math.max(maxFresh, fresh.length);
  for (const x of fresh) count.set(category(x.key), (count.get(category(x.key)) ?? 0) + 1);

  // A principal who answers the desk every month. These are real decisions,
  // and clearing them prevents an unanswered item being counted repeatedly.
  for (const loi of [...g.lois]) {
    const r = E.respondLOI(g, parcels, loi.id, "accept", true);
    g = r.err ? E.respondLOI(g, parcels, loi.id, "decline").s : r.s;
  }
  for (const ask of [...(g.asks ?? [])]) g = E.answerAsk(g, parcels, ask.id, "decline").s;
  for (const [bbl, a] of Object.entries(g.approaches ?? {})) {
    if (a.inbound) g = E.hangUpOnCall(g, bbl);
  }
  prior = new Set(E.attentionItems(g).map((x) => x.key));
}

const share = interruptedMonths / Math.max(1, Math.min(HZ, g.month));
console.log(`\nINTERRUPTION LOAD — ${Object.keys(g.holdings).length} buildings, ${g.month} months`);
console.log(`  months with a new stop: ${interruptedMonths} (${(share * 100).toFixed(1)}%)`);
console.log(`  most simultaneous new items: ${maxFresh}`);
for (const [k, n] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${n}`);
}

let bad = 0;
if (share > 0.35) {
  console.log("  FAIL  more than 35% of months interrupted for a five-building book");
  bad++;
}
if (maxFresh > 8) {
  console.log("  FAIL  more than eight new decisions landed in one month");
  bad++;
}
if (!bad) console.log("  OK    meaningful stops remain occasional rather than becoming the clock");
process.exit(bad ? 1 : 0);
