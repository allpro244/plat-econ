// Private credit sleeve — fund a rival ask, collect, sleeve rails.
//
//   pnpm engine && node test/private-credit.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let fails = 0;
const check = (ok, msg) => {
  if (!ok) { fails++; console.log("  FAIL", msg); }
  else console.log("  OK  ", msg);
};

const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(12007, parcels, 10_000_000), parcels, bbls);
g.citySize = "city";

// Find a rival with a financed-looking building we can lien-free.
const rival = (g.rivals ?? []).find((r) => r.failedM === undefined && r.bbls.length >= 1);
check(!!rival, `have a live rival (${rival?.name ?? "none"})`);
const bbl = rival.bbls.find((b) => {
  const rec = E.resolveRec(parcels, g, b);
  return rec && rec.class !== "land" && rec.bldgArea > 0 && !g.cityLoans?.[b] && !g.holdings[b];
});
check(!!bbl, `rival deed without lien (${bbl ?? "none"})`);

const rec = E.resolveRec(parcels, g, bbl);
const asIs = Math.round(E.collateralAsIs(rec, g.econ, rival.occ ?? 0.7) || E.assetValue(rec, g.econ, "standard"));
const face = Math.round(Math.min(asIs * 0.6, 2_000_000) / 25_000) * 25_000;

// Inject an ask (skip the random spawn).
g.privateAsks = [{
  id: "Ptest",
  rivalId: rival.id,
  rivalName: rival.name,
  bbl,
  address: rec.address,
  face,
  ratePct: 12.5,
  points: 0.02,
  termM: 12,
  ltv: face / asIs,
  asIs,
  why: "Test ask.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];

const cash0 = g.cash;
const debt0 = rival.debt;
const rivalCash0 = rival.cash;
const points = Math.round(face * 0.02);
const funded = E.fundPrivateAsk(g, parcels, "Ptest");
check(!funded.err, `fund succeeds — ${funded.err ?? funded.msg}`);
g = funded.s;
const r2 = g.rivals.find((x) => x.id === rival.id);
check(g.cash === cash0 - face + points, `cash net −face +points (${g.cash} vs ${cash0 - face + points})`);
check(r2.debt === debt0 + face, `rival debt up by face`);
check(r2.cash === rivalCash0 + face - points, `rival received net advance (${r2.cash} vs ${rivalCash0 + face - points})`);
check(!!g.cityLoans?.[bbl], `cityLoans row written`);
check(g.cityLoans[bbl].lender === g.notes.find((n) => n.privateOriginated)?.originator,
  `lender matches note originator (${g.cityLoans[bbl].lender})`);
const note = (g.notes ?? []).find((n) => n.privateOriginated && n.bbl === bbl);
check(!!note, `private-originated note on book`);
check((g.privateAsks ?? []).length === 0, `ask consumed`);

// Second lien refused
g.privateAsks = [{
  id: "Ptest2",
  rivalId: rival.id,
  rivalName: rival.name,
  bbl,
  address: rec.address,
  face: 500_000,
  ratePct: 14,
  points: 0.02,
  termM: 9,
  ltv: 0.2,
  asIs,
  why: "Stack.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];
const stacked = E.fundPrivateAsk(g, parcels, "Ptest2");
check(!!stacked.err, `second lien refused — ${stacked.err}`);

// Coupon month
const cash1 = g.cash;
g = E.advanceMonth(g, parcels, bbls, adjacency);
const cpn = Math.round((face * note.ratePct) / 100 / 12);
check(g.cash >= cash1 + cpn - 50_000, `coupon roughly landed (cash ${g.cash} vs prior ${cash1}, cpn ${cpn})`);

// Sleeve helper
const sleeve = E.privateSleeveCapacity(g, parcels);
check(Number.isFinite(sleeve) && sleeve >= 0, `sleeve capacity ${sleeve}`);

// Attention stops Skip on a live ask
g.privateAsks = [{
  id: "Pattn",
  rivalId: rival.id,
  rivalName: rival.name,
  bbl: "attn-fake",
  address: "Attention St",
  face: 250_000,
  ratePct: 13,
  points: 0.02,
  termM: 9,
  ltv: 0.6,
  asIs: 400_000,
  why: "Stop the year.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];
const attn = E.attentionItems(g);
check(attn.some((a) => a.key === "private-ask:Pattn"), `attention lists private ask`);
g.privateAsks = [];

// Payoff clears rival debt + street record (same helper maturity/sale use)
const debtBeforeClear = g.rivals.find((x) => x.id === rival.id).debt;
const noteSnap = { ...note };
E.clearPrivateOrigination(g, noteSnap);
const rClear = g.rivals.find((x) => x.id === rival.id);
check(rClear.debt === debtBeforeClear - note.face, `payoff cuts rival debt by face`);
check(!g.cityLoans?.[bbl], `payoff drops cityLoans row`);

// Re-fund to exercise sell → street lender transfers, debt stays
g.cash = Math.max(g.cash, face + 600_000);
g.privateAsks = [{
  id: "Psell",
  rivalId: rival.id,
  rivalName: rival.name,
  bbl,
  address: rec.address,
  face,
  ratePct: 12.5,
  points: 0.02,
  termM: 12,
  ltv: face / asIs,
  asIs,
  why: "Sell path.",
  offeredM: g.month,
  expiresM: g.month + 2,
}];
// cityLoans was cleared; deed must be lien-free for fund
delete g.cityLoans?.[bbl];
g.notes = (g.notes ?? []).filter((n) => n.bbl !== bbl);
const debtPreSell = g.rivals.find((x) => x.id === rival.id).debt;
const funded2 = E.fundPrivateAsk(g, parcels, "Psell");
check(!funded2.err, `re-fund for sell — ${funded2.err ?? "ok"}`);
g = funded2.s;
const n2 = g.notes.find((n) => n.privateOriginated && n.bbl === bbl);
const debtHeld = g.rivals.find((x) => x.id === rival.id).debt;
// Force a bid: give an opportunistic rival cash
const buyer = (g.rivals ?? []).find((x) => x.id !== rival.id && x.failedM === undefined
  && (x.style === "opportunistic" || x.style === "core"));
if (buyer && n2) {
  buyer.cash = Math.max(buyer.cash, n2.face * 2);
  const sold = E.sellNote(g, parcels, n2.id);
  check(!sold.err, `sell private note — ${sold.err ?? "ok"}`);
  g = sold.s;
  check(g.cityLoans?.[bbl]?.lender === buyer.name, `street lender follows sale (${g.cityLoans?.[bbl]?.lender})`);
  check(g.rivals.find((x) => x.id === rival.id).debt === debtHeld, `sale does not forgive obligor debt`);
} else {
  check(false, `need a cash buyer rival for sell path`);
}

// Sleeve refuses face above capacity
g.cash = 400_000;
const tinySleeve = E.privateSleeveCapacity(g, parcels);
check(tinySleeve < 250_000, `thin cash → sleeve under min ask (${tinySleeve})`);

console.log(fails ? `\n${fails} failed\n` : "\nprivate-credit pass\n");
process.exit(fails ? 1 : 0);
