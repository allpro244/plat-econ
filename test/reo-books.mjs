// RECEIVER BOOKS ARE BUYABLE ON MARKETPLACE — not a news dead end.
//
//   pnpm engine && pnpm exec node test/reo-books.mjs
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

console.log("\nREO / STREET BOOKS\n");

check(typeof E.buyPortfolio === "function", "buyPortfolio is exported");
check(typeof E.openReoPortfolio === "function", "openReoPortfolio is exported");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.newGame(44101, parcels, 80_000_000);

// Pick four standing commercial buildings the player does not own.
const pack = [];
for (const b of bbls) {
  const rec = parcels[b];
  if (!rec || rec.class === "land" || !rec.bldgArea || rec.bldgArea < 20_000) continue;
  if (g.holdings[b]) continue;
  pack.push(b);
  if (pack.length >= 4) break;
}
if (pack.length < 4) throw new Error("need four buildings for REO package fixture");

// Put them on a living rival so ownership is coherent, then seize the book.
const rival = (g.rivals ?? []).find((r) => r.failedM === undefined) ?? g.rivals?.[0];
if (!rival) throw new Error("no rival");
rival.bbls = [...new Set([...(rival.bbls ?? []), ...pack])];
rival.failedM = undefined;

E.openReoPortfolio(g, parcels, "First Harbor", pack, rival.name, 12_000_000);
const p = (g.portfolios ?? []).find((x) => x.reoBorrower === rival.name);
check(!!p, "openReoPortfolio puts a package on game.portfolios");
check(!!p?.reo && p.sellerLender === "First Harbor", "package is marked REO with the desk");
check(pack.every((b) => !g.listings.some((l) => l.bbl === b)),
  "packaged BBLs are pulled off the single-asset tape");
check((g.news ?? []).some((n) => /Marketplace|Books for sale/i.test(n.text)),
  "news points the player at Marketplace · Books for sale");

const attn = E.attentionItems(g);
check(attn.some((a) => a.key === `street-book:${p.id}`),
  "attentionItems stops Skip for a buyable street book");
check(/Marketplace/i.test(attn.find((a) => a.key === `street-book:${p.id}`)?.label ?? ""),
  "attention label names Marketplace");

// Rich enough to close — buyPortfolio is one cash cheque + 2% closing.
g.cash = Math.max(g.cash, p.ask + Math.round(p.ask * 0.02) + 1_000_000);
const before = Object.keys(g.holdings).length;
const r = E.buyPortfolio(g, parcels, p.id);
check(!r.err, `buyPortfolio succeeds (${r.err ?? "ok"})`);
g = r.s;
check(!(g.portfolios ?? []).some((x) => x.id === p.id), "package leaves the street book after purchase");
check(Object.keys(g.holdings).length > before, "player takes deeds from the package");
const taken = pack.filter((b) => g.holdings[b]).length;
check(taken >= 2, `at least two deeds conveyed (${taken} of ${pack.length})`);
check(!E.attentionItems(g).some((a) => a.key === `street-book:${p.id}`),
  "attention clears once the book is bought");

console.log("");
process.exit(bad ? 1 : 0);
