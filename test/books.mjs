// MONTHLY LEDGER + YEAR-END BALANCE STAMPS.
//
//   pnpm engine && pnpm exec node test/books.mjs
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels, bbls } = loadCity(0, E.normalizeParcels);
let g = E.firstListings(E.newGame(61881, parcels, 50_000_000), parcels, bbls);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};

console.log("\nBOOKS PERIOD VIEWS\n");

E.logBooks(g, "noi", 100_000);
E.logBooks(g, "debtSvc", 40_000);
check(!!g.books?.length && g.books[g.books.length - 1].noi === 100_000, "year bucket receives the flow");
check(!!g.booksMonthly?.length && g.booksMonthly[g.booksMonthly.length - 1].noi === 100_000,
  "month bucket dual-writes the same dollars");
check(g.booksMonthly[g.booksMonthly.length - 1].m === g.month, "month stamp matches game.month");

const asYear = E.booksMonthAsYear(g.booksMonthly[g.booksMonthly.length - 1]);
check(asYear.yr === Math.floor(g.month / 12) && asYear.noi === 100_000 && asYear.debtSvc === 40_000,
  "booksMonthAsYear keeps flows and derives the year");

const live = E.buildBalanceSheet(g, parcels);
check(live.cash === g.cash && live.historical === false, "live sheet reads cash and is not historical");
check(Math.abs(live.equity - (live.totalAssets - live.totalLiab)) < 1, "equity is assets minus liabilities");

// Stamp only on December (month % 12 === 11). Advance from month 0 → 11.
while (g.month < 11) g = E.advanceMonth(g, parcels, bbls);
check(g.month === 11, "sitting in December of year 0");
check((g.balanceHistory ?? []).some((b) => b.m === 11), "December close stamped year 0");

const cashAtClose = g.cash;
const snap = g.balanceHistory.find((b) => b.m === 11);
check(snap.cash === cashAtClose, "year-end cash matches the December close");

// Next January: prior year-end is available; this year's stamp is not "last year".
g = E.advanceMonth(g, parcels, bbls);
check(g.month === 12, "January of year 1");
const curYr = Math.floor(g.month / 12);
const lastYear = [...(g.balanceHistory ?? [])].reverse().find((b) => Math.floor(b.m / 12) < curYr);
check(!!lastYear && lastYear.m === 11, "last year-end resolves to prior December");

const hist = E.balanceSnapshotView(lastYear);
check(hist.historical === true && hist.cash === snap.cash, "snapshot view is historical with frozen cash");

// A second December replaces that year's row, does not duplicate.
while (g.month < 23) g = E.advanceMonth(g, parcels, bbls);
const year0 = (g.balanceHistory ?? []).filter((b) => Math.floor(b.m / 12) === 0);
const year1 = (g.balanceHistory ?? []).filter((b) => Math.floor(b.m / 12) === 1);
check(year0.length === 1 && year1.length === 1, "one stamp per game year");

// Monthly buckets stay capped.
for (let i = 0; i < 60; i++) {
  g.month++;
  E.logBooks(g, "noi", 1);
}
check((g.booksMonthly?.length ?? 0) <= 48, "monthly ledger keeps at most 48 months");

console.log("");
process.exit(bad ? 1 : 0);
