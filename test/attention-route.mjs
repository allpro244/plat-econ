// Every attentionItems key must route to a desk — no orphan inbox rows.
//   pnpm engine && pnpm attention
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const SEEDS = Number(process.env.SEEDS ?? 4);
const MONTHS = Number(process.env.HZ ?? 360);

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

const routed = (route) => !!(route.page || route.auction);

const seen = new Set();
for (let si = 0; si < SEEDS; si++) {
  let g = E.firstListings(E.newGame(9000 + si * 131, parcels), parcels, bbls);
  for (let m = 0; m < MONTHS; m++) {
    if (g.gameOver) g = { ...g, gameOver: null, cash: Math.max(g.cash, 6e6) };
    for (const item of E.attentionItems(g)) {
      seen.add(item.key);
      const route = E.routeAttention(item.key, g);
      if (!routed(route)) {
        fails++;
        console.log(`FAIL  orphan key ${item.key} (${item.label.slice(0, 60)})`);
      }
    }
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    for (const loi of [...g.lois].slice(0, 3)) {
      const r = E.respondLOI(g, parcels, loi.id, m % 5 === 0 ? "decline" : "accept");
      if (!r.err) g = r.s;
    }
  }
}

ok("collected attention keys from bot runs", seen.size > 20, `${seen.size} distinct keys`);
ok("every seen key routes", fails === 0, fails ? `${fails} orphan(s)` : `${seen.size} keys`);

// Static prefixes emitted by attentionItems — catch keys the bot never reached.
const PREFIXES = [
  "loi", "tenant-ask", "portfolio-bid", "broker", "offer", "sale-bids",
  "nonrenew", "lease-roll", "capital-plan", "balloon", "sweep",
  "facility-balloon", "facility-sweep", "capital-call", "workout",
  "contract", "talks", "exchange", "note", "npl", "private-ask", "private-borrow",
  "street-book", "auction", "line-over", "cash", "cash-runway", "ti-book",
  "estate", "over",
];
for (const p of PREFIXES) {
  const sample = p === "tenant-ask" ? `${p}:1`
    : p === "portfolio-bid" ? `${p}:Acme:1000000`
    : p === "broker" || p === "offer" || p === "sale-bids" || p === "nonrenew"
      || p === "lease-roll" || p === "capital-plan" || p === "balloon"
      || p === "sweep" || p === "capital-call" || p === "workout"
      || p === "contract" || p === "talks"
      ? `${p}:0000010001:extra`
    : p === "facility-balloon" ? `${p}:far`
    : p === "note" || p === "private-ask" || p === "private-borrow" ? `${p}:1`
    : p === "npl" ? `${p}:1:12`
    : p === "street-book" ? `${p}:pkg1`
    : p === "auction" ? `${p}:84`
    : p === "estate" ? `${p}:120`
    : p;
  const route = E.routeAttention(sample, E.newGame(1, parcels));
  ok(`prefix ${p}`, routed(route));
}

console.log(`\n${fails === 0 ? "attention-route pass" : `${fails} attention-route failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
