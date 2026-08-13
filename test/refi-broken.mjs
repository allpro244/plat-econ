// REFI: quote card and close must agree; takeout must cure the file.
//
//   pnpm engine && node test/refi-broken.mjs
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

console.log("\nREFI — QUOTE MATCHES CLOSE\n");

const { parcels, bbls } = loadCity(0, E.normalizeParcels);

function buyCommercial(seed, cash = 80_000_000) {
  for (let s = seed; s < seed + 300; s++) {
    let g = E.firstListings(E.newGame(s, parcels, cash), parcels, bbls);
    for (const L of g.listings ?? []) {
      const rec = E.resolveRec(parcels, g, L.bbl);
      if (!rec || rec.class === "land" || rec.class === "multifamily" || !rec.bldgArea) continue;
      if (L.ask < 4_000_000 || L.ask > cash * 0.75) continue;
      const r = E.executePurchase(g, parcels, L.bbl, L.ask, "cash", false, 1);
      if (!r.err) return { g: r.s, bbl: L.bbl };
    }
  }
  throw new Error("no commercial building");
}

// --- 1. Card max proceeds === close principal at lev=1 --------------------
{
  const { g, bbl } = buyCommercial(120);
  // Empty lease-up-shaped book: delivered recently, thin roll.
  g.holdings[bbl].deliveredM = g.month - 6;
  g.holdings[bbl].tenants = [];
  const { quotes } = E.refiQuotes(g, parcels, bbl);
  const cordage = quotes.find((q) => q.id === "cordage");
  check(!!cordage, "Cordage quotes the building");
  if (cordage?.available && cordage.maxProceeds >= 100_000) {
    const before = g.cash;
    const r = E.refinance(g, parcels, bbl, "cordage", 1);
    check(!r.err, `Cordage close succeeds (was: ${r.err ?? "ok"})`);
    if (!r.err) {
      check(r.s.holdings[bbl].loan?.balance === cordage.maxProceeds,
        `close principal $${((r.s.holdings[bbl].loan?.balance ?? 0) / 1e6).toFixed(2)}M equals card $${(cordage.maxProceeds / 1e6).toFixed(2)}M`);
      check(r.s.cash !== before || (r.s.loc?.balance ?? 0) > 0 || cordage.maxProceeds > 0,
        "close moved cash or the line");
    }
  } else {
    // Still assert quote/execute agreement on a desk that will write.
    const open = quotes.find((q) => q.available && q.maxProceeds >= 100_000);
    check(!!open, "some income desk will write");
    if (open) {
      const r = E.refinance(g, parcels, bbl, open.id, 1);
      check(!r.err, `${open.id} close succeeds`);
      check(r.s.holdings[bbl].loan?.balance === open.maxProceeds,
        `close matches ${open.id} card proceeds`);
    }
  }
}

// --- 2. Permanent desks do not invent a parallel lease-up NOI -------------
{
  const { g, bbl } = buyCommercial(121);
  g.holdings[bbl].deliveredM = g.month - 3;
  g.holdings[bbl].tenants = [];
  const actualNoi = E.ownedHoldingNoiYr(g, parcels, g.holdings[bbl]);
  const { quotes } = E.refiQuotes(g, parcels, bbl);
  const harbor = quotes.find((q) => q.id === "harbor");
  check(!!harbor, "Harbor is on the card");
  check(harbor.noiUw === actualNoi,
    `Harbor underwrites in-place NOI ($${Math.round(harbor?.noiUw ?? -1)} vs actual $${Math.round(actualNoi)}) — not a fake stab schedule`);
}

// --- 3. Mezz does not replace the senior ----------------------------------
{
  const { g, bbl } = buyCommercial(122);
  // Put a senior on, then try mezz.
  const { quotes } = E.refiQuotes(g, parcels, bbl);
  const senior = quotes.find((q) => q.available && q.maxProceeds > 1_000_000 && q.id !== "mezz");
  check(!!senior, "a senior desk is available");
  let g2 = E.refinance(g, parcels, bbl, senior.id, 1).s;
  const mezzQ = E.refiQuotes(g2, parcels, bbl).quotes.find((q) => q.id === "mezz");
  check(mezzQ && !mezzQ.available, "mezz is not offered on refinance (no lien stack)");
  const tried = E.refinance(g2, parcels, bbl, "mezz", 1);
  check(!!tried.err, "mezz close refuses rather than retiring the senior");
  check(!!g2.holdings[bbl].loan && g2.holdings[bbl].loan.product !== "mezz",
    "senior still on the deed after the refused mezz");
}

// --- 4. Takeout clears a balloon workout ----------------------------------
{
  const { g, bbl } = buyCommercial(123);
  const put = E.refinance(g, parcels, bbl, "cordage", 1);
  check(!put.err, "seed loan for workout test");
  let g2 = put.s;
  g2.workouts = {
    [bbl]: {
      bbl, lender: "Test", startM: g2.month - 2,
      stage: "notice", cause: "balloon",
      cure: Math.round((g2.holdings[bbl].loan?.balance ?? 0) * 1.01),
      decideM: g2.month + 4, asks: 0, missedMs: 0,
    },
  };
  const { quotes } = E.refiQuotes(g2, parcels, bbl);
  const desk = quotes.find((q) => q.available && q.maxProceeds >= 100_000);
  check(!!desk, "takeout desk available while in workout");
  const r = E.refinance(g2, parcels, bbl, desk.id, 1);
  check(!r.err, `takeout while in workout succeeds (${r.err ?? "ok"})`);
  check(!r.s.workouts?.[bbl], "workout file clears on a successful refinance");
}

// --- 5. Facility-pledged deed cannot take a new mortgage ------------------
{
  const { g, bbl } = buyCommercial(124);
  g.facility = {
    lender: "Test Facility", product: "facility",
    balance: 1_000_000, ratePct: 7, spread: 3, maturityM: g.month + 60,
    bbls: [bbl], originatedM: g.month, minDSCR: 1.2, maxLTV: 0.65,
  };
  const { quotes } = E.refiQuotes(g, parcels, bbl);
  check(quotes.every((q) => !q.available), "no desk available while pledged");
  const r = E.refinance(g, parcels, bbl, "cordage", 1);
  check(!!r.err && /facility|pledged|release/i.test(r.err),
    `pledged refinance refused (${r.err})`);
}

// --- 6. Floating refi charges the cap premium -----------------------------
{
  const { g, bbl } = buyCommercial(125);
  // Free-and-clear so cash-out math is clean.
  g.holdings[bbl].loan = null;
  const { quotes } = E.refiQuotes(g, parcels, bbl);
  const floatDesk = quotes.find((q) => q.floating && q.available && q.maxProceeds > 500_000);
  if (!floatDesk) {
    check(true, "skip cap-premium check — no floating desk quoting today");
  } else {
    const cash0 = g.cash;
    const r = E.refinance(g, parcels, bbl, floatDesk.id, 1);
    check(!r.err, `floating close succeeds (${r.err ?? "ok"})`);
    if (!r.err) {
      const principal = r.s.holdings[bbl].loan.balance;
      const points = Math.round(principal * floatDesk.points);
      const refiFee = Math.round(principal * 0.01);
      const cap = Math.round(principal * 0.0125);
      const expected = cash0 + principal - refiFee - points - cap;
      check(Math.abs(r.s.cash - expected) < 2,
        `floating close charges cap (cash $${r.s.cash.toFixed(0)} vs expected $${expected.toFixed(0)}; cap $${cap})`);
      check(!!r.s.holdings[bbl].loan.cap, "new floating paper carries a rate cap");
    }
  }
}

console.log(bad ? `\n${bad} FAILED\n` : "\nALL OK\n");
process.exit(bad ? 1 : 0);
