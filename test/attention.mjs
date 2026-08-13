// THE CLOCK MUST STOP BEFORE A DECISION EXPIRES OR A CAPITAL EVENT ARRIVES.
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels } = loadCity(0, E.normalizeParcels);

let bad = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${msg}`);
  if (!ok) bad++;
};
const keys = (s) => new Set(E.attentionItems(s).map((x) => x.key));

console.log("\nATTENTION / AUTO-ADVANCE SAFETY\n");

const base = E.newGame(4242, parcels);
base.month = 24;

{
  const g = structuredClone(base);
  g.lois = [{ id: "l1", name: "Anchor Tenant", expiresM: 26 }];
  g.asks = [{ id: "a1", name: "Shop Tenant", expiresM: 27 }];
  g.talks = {
    "100": { bbl: "100", sellerName: "Estate", theirPrice: 2_000_000, final: false },
    "101": { bbl: "101", sellerName: "Fund", theirPrice: 3_000_000, agreed: true, agreedPrice: 2_900_000, closeByM: 25 },
  };
  const k = keys(g);
  check(k.has("loi:l1"), "tenant LOI stops the clock");
  check(k.has("tenant-ask:a1"), "tenant relief request stops the clock");
  check([...k].some((x) => x.startsWith("talks:100:")), "seller counter stops the clock");
  check(k.has("contract:101"), "unfunded acquisition contract stops the clock");
}

{
  const g = structuredClone(base);
  g.holdings["200"] = {
    bbl: "200",
    tenants: [],
    loan: { maturityM: 36, sweep: true },
  };
  const k = keys(g);
  check(k.has("balloon:200:far"), "single-asset maturity gives twelve months' notice");
  check(k.has("sweep:200"), "single-asset covenant sweep stops the clock");
}

{
  const g = structuredClone(base);
  g.facility = {
    bbls: [],
    balance: 8_000_000,
    drawn: 9_000_000,
    ratePct: 7,
    lender: "Harbor National",
    productId: "facility",
    originM: 0,
    maturityM: 36,
    ioUntilM: 24,
    amortYears: 25,
    monthlyPmt: 60_000,
    minDSCR: 1.2,
    maxLTV: 0.7,
    recourse: true,
    breachedSince: 22,
    sweep: true,
  };
  const a = E.attentionItems(g);
  const k = new Set(a.map((x) => x.key));
  check(k.has("facility-balloon:far"), "portfolio facility maturity gives twelve months' notice");
  check(k.has("facility-sweep"), "portfolio facility breach stops the clock");
  check(a.some((x) => x.key === "facility-sweep" && x.label.includes("Harbor National")),
    "facility warning names the lender");
}

{
  const g = structuredClone(base);
  g.workouts = {
    "300": {
      bbl: "300", lender: "Receiver Trust", stage: "foreclosure",
      decideM: 27, saleM: 30, cure: 500_000,
    },
  };
  const a = E.attentionItems(g);
  check(a.some((x) => x.key.startsWith("workout:300:foreclosure")),
    "open foreclosure remains visible to auto-advance");
}

{
  const g = structuredClone(base);
  g.holdings["400"] = {
    bbl: "400",
    planCutM: g.month,
    tenants: [{
      name: "Longstanding Tenant", sector: "finance", credit: 2,
      sf: 20_000, rentPsf: 40, net: true, startM: 0, endM: 30,
      nonRenewM: g.month, nonRenewWhy: "their headcount no longer fits",
    }],
  };
  g.developments = {
    "500": { bbl: "500", lastCapitalCallM: g.month, lastCapitalCall: 750_000 },
  };
  g.locOverMs = 1;
  g.cash = -25_000;
  g.insolventMs = 4;
  const a = E.attentionItems(g);
  const k = new Set(a.map((x) => x.key));
  check([...k].some((x) => x.startsWith("nonrenew:400:")),
    "tenant non-renewal notice stops the clock six months ahead");
  check(k.has(`capital-plan:400:${g.month}`),
    "unfunded property capital plan stops the clock");
  check(k.has(`capital-call:500:${g.month}`),
    "construction capital call stops the clock");
  check(k.has("line-over"), "over-advanced credit line stops the clock");
  check(a.some((x) => x.key.startsWith("nonrenew:") && x.label.includes("headcount")),
    "non-renewal stop preserves the economic reason");
  check(a.some((x) => x.key.startsWith("capital-call:") && x.label.includes("$750K")),
    "capital-call stop states the cash amount");
  check(a.some((x) => x.key === "cash" && x.label.includes("month 4 of 12")),
    "negative-cash stop explains the lender-seizure timeline");
  check(new Set(a.map((x) => x.key)).size === a.length,
    "simultaneous risks have unique attention keys");
}

{
  const g = E.newGame(55012, parcels);
  const bbl = Object.keys(parcels).find((b) => parcels[b].class !== "land" && parcels[b].bldgArea > 0)
    ?? Object.keys(parcels)[0];
  g.holdings[bbl] = {
    bbl, boughtM: 0, costBasis: 1_000_000, condition: 0.8,
    tenants: [{
      name: "Northwind LLC", sector: "tech", credit: "bb", sf: 10_000,
      rentPsf: 40, startM: 0, endM: g.month + 4, use: "office",
    }],
    loan: { balance: 800_000, ratePct: 6, monthlyPmt: 6_000, maturityM: g.month + 60, product: "fixed" },
  };
  g.cash = 10_000;
  g.milestones = { firstDeal: g.month };
  const a = E.attentionItems(g);
  const k = new Set(a.map((x) => x.key));
  check([...k].some((x) => x.startsWith("lease-roll:")),
    "near-term lease roll without an LOI stops the clock");
  check(k.has("cash-runway"), "thin cash vs debt service warns before insolvency");
  check(![...k].some((x) => x.startsWith("mile:")),
    "milestones do not stop Skip — they stay on the news tape");
}

console.log("");
process.exit(bad ? 1 : 0);
