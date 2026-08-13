// THE DEEP ECONOMY STRESS TEST.
//
//   pnpm stress                 the whole battery, writes ECONOMY_STRESS.md
//   pnpm stress --only=33,A,28  a subset
//   SEEDS=10 pnpm stress        wider tournament
//
// The interconnection audit (tools/econaudit.mjs) asks whether a shock in one
// place moves the right things elsewhere. This asks a harder and more hostile
// set of questions: does the world exist without the player, does the player
// exist to the world, is there a dominant strategy, is there a money pump, and
// does the whole thing survive being pushed to its bounds.
//
// The order below is deliberate and is the owner's: DETERMINISM FIRST, because
// every paired-run number in either audit is worthless if the engine does not
// reproduce. Then the null player, because a world that only moves when poked
// is a response function wearing a simulation's clothes. Then the tournament,
// because an economy with one right answer is a solved game.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E, USES, MONTHS, run, city, med, mean, pct, districtsOf } from "./econaudit-core.mjs";
import { makeCity, PROCEDURAL } from "../src/citygen/index.mjs";
import { leaseAtMarket } from "../test/leasepolicy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "ECONOMY_STRESS.md");
const CITY_SEED = Number(process.env.CITY_SEED ?? 20261);
const SEEDS = Number(process.env.SEEDS ?? 6);
const MARKET_SEEDS = [550991, 12007, 73303, 11, 22, 4242, 90210, 313, 777, 2468].slice(0, SEEDS);
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
/**
 * THE OPENING BANKROLL, OVERRIDABLE — so a claim about a broken world can be
 * RE-RUN rather than believed. START_CASH_CHOICES offers 1M / 2.5M / 5M and the
 * engine defaults to 2.5M; every check here goes through `newGame` below, so
 * `START_CASH=1000000 node tools/econstress.mjs --only=G` plays the whole
 * battery on a real, choosable opening cheque. It is how the assertion in [G]
 * that BROKEN is reachable is earned instead of asserted.
 */
const START_CASH = Number(process.env.START_CASH || 0) || undefined;
const newGame = (seed, parcels) => E.newGame(seed, parcels, START_CASH);
const want = (k) => !only.length || only.includes(String(k));
const md = [];
const say = (s) => md.push(s);
const log = (...a) => console.log(...a);
const RESULTS = [];
const report = (id, title, verdict, lines) => {
  RESULTS.push({ id, title, verdict, lines });
  log(`\n[${id}] ${title}: ${verdict}`);
  for (const l of lines) log("   " + l);
};
const M = (n) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);

// ---------------------------------------------------------------------------
// NUMERICAL HYGIENE (test 32) — rides along on every run in this file
// ---------------------------------------------------------------------------
const HYGIENE = [];
function scan(tag, g, parcels) {
  const e = g.econ, bad = [];
  const chk = (name, v, lo, hi) => {
    if (!Number.isFinite(v)) { bad.push(`${name} = ${v}`); return; }
    if (lo !== undefined && v < lo) bad.push(`${name} = ${v.toFixed(4)} (below ${lo})`);
    if (hi !== undefined && v > hi) bad.push(`${name} = ${v.toFixed(4)} (above ${hi})`);
  };
  chk("cash", g.cash);
  chk("indexRate", e.indexRate, 0, 40);
  chk("cpi", e.cpi, 0.05, 1000);
  chk("wageIdx", e.wageIdx, 0.05, 1000);
  chk("costIdx", e.costIdx, 0.05, 1000);
  chk("population", e.population, 1000);
  chk("unemployment", e.unemployment, 0, 1);
  chk("creditIdx", e.creditIdx, 0, 3);
  for (const u of USES) {
    chk(`rentIdx.${u}`, e.rentIdx?.[u], 0);
    chk(`cityVac.${u}`, e.cityVac?.[u], 0, 1);
    chk(`stock.${u}`, e.stock?.[u], 0);
    chk(`occupied.${u}`, e.occupied?.[u], 0);
    if ((e.occupied?.[u] ?? 0) > (e.stock?.[u] ?? 0) * 1.001) {
      bad.push(`occupied.${u} exceeds stock (${Math.round(e.occupied[u])} > ${Math.round(e.stock[u])})`);
    }
  }
  for (const h of Object.values(g.holdings ?? {})) {
    if (h.occ !== undefined && (h.occ < -0.001 || h.occ > 1.001)) bad.push(`holding ${h.bbl} occ = ${h.occ}`);
    if (h.loan && !Number.isFinite(h.loan.balance)) bad.push(`holding ${h.bbl} loan balance = ${h.loan.balance}`);
  }
  if (bad.length) HYGIENE.push({ tag, month: e.m, issues: bad.slice(0, 6) });
  return bad.length;
}

// ===========================================================================
// 33. DETERMINISM — run this first or nothing else means anything
// ===========================================================================
if (want(33)) {
  const lines = [];
  let identical = 0, differed = 0;
  const fingerprint = (g) => {
    const e = g.econ;
    return JSON.stringify([
      +e.indexRate.toFixed(6), +e.cpi.toFixed(6), +e.wageIdx.toFixed(6), +e.costIdx.toFixed(6),
      e.population, e.jobs, +e.unemployment.toFixed(6), e.phase, +e.creditIdx.toFixed(6),
      USES.map((u) => [+e.rentIdx[u].toFixed(6), +e.cityVac[u].toFixed(6), Math.round(e.stock[u])]),
      (g.rivals ?? []).map((r) => [r.id, r.bbls.length, Math.round(r.cash), Math.round(r.debt)]),
      (g.lenders ?? []).map((l) => [l.name, Math.round(l.capital), Math.round(l.book)]),
      g.news.length, g.listings.length, Math.round(g.cash),
    ]);
  };
  for (const ms of MARKET_SEEDS.slice(0, 3)) {
    const a = run(CITY_SEED, ms, { sampleEvery: 999999 });
    const b = run(CITY_SEED, ms, { sampleEvery: 999999 });
    const fa = fingerprint(a.end), fb = fingerprint(b.end);
    if (fa === fb) identical++; else { differed++; lines.push(`seed ${ms}: DIVERGED at year 50`); }
  }
  lines.unshift(`${identical}/${identical + differed} seeds reproduced bit-for-bit over ${MONTHS / 12} years`);

  // SAVE/LOAD ROUND TRIP. The engine is JSON-serialisable by contract; if a
  // round trip changes the state, every save in the game is a subtly different
  // universe from the one the player left.
  {
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(MARKET_SEEDS[0], parcels), parcels, base.bbls);
    for (let m = 0; m < 180; m++) g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
    const snapshot = JSON.parse(JSON.stringify(g));
    const pSnap = JSON.parse(JSON.stringify(parcels));
    let straight = g, loaded = snapshot;
    const pStraight = parcels, pLoaded = pSnap;
    for (let m = 0; m < 120; m++) {
      straight = E.advanceQuarter(straight, pStraight, base.bbls, base.adjacency);
      loaded = E.advanceQuarter(loaded, pLoaded, base.bbls, base.adjacency);
    }
    const same = fingerprint(straight) === fingerprint(loaded);
    lines.push(`save/load round trip after 15 years, then 10 more: ${same ? "identical" : "DIVERGED — a save is not the same universe"}`);
    if (!same) differed++;
  }
  report(33, "DETERMINISM", differed === 0 ? "WIRED" : "BROKEN", lines);
}

// ===========================================================================
// A. THE NULL PLAYER — does the city exist without you?
// ===========================================================================
function snapshotCity(g, parcels, base) {
  const e = g.econ;
  let built = 0, land = 0, sfTotal = 0, ageSum = 0, ageN = 0, tallest = 0;
  for (const b of base.bbls) {
    const rec = E.resolveRec(parcels, g, b) ?? parcels[b];
    if (!rec) continue;
    if (rec.class === "land" || !rec.bldgArea) { land++; continue; }
    built++; sfTotal += rec.bldgArea;
    ageSum += 2000 + Math.floor((e.m ?? 0) / 12) - (rec.yearBuilt || 2000); ageN++;
    tallest = Math.max(tallest, rec.floors || 0);
  }
  const rivals = (g.rivals ?? []).filter((r) => r.failedM === undefined && !r.dead);
  return {
    yr: Math.floor((e.m ?? 0) / 12),
    built, land, sfM: sfTotal / 1e6, age: ageN ? ageSum / ageN : 0, tallest,
    pop: e.population, jobs: e.jobs, vacOff: e.cityVac?.office ?? 0,
    rentOff: e.rentIdx?.office ?? 0, cpi: e.cpi,
    firms: rivals.length, aum: rivals.reduce((a, r) => a + (r.aum ?? 0), 0),
    // LOTS THAT HAVE CHANGED HANDS, not g.comps.length. The comps sheet is a
    // rolling window capped at MAX_COMPS (comps.ts), so over twenty-five years
    // it reports the cap and nothing else — this row read an identical "240"
    // at year 25 and at year 50 in every seed, and the world-activity check
    // that tests it for "> 50" could never fail for any reason connected to
    // the world. lastTradeM is the cumulative record.
    demolished: g.demolished ?? 0,
    comps: Object.keys(g.lastTradeM ?? {}).length,
    cityBuilt: (g.cityBuilt ?? []).length,
  };
}

if (want("A")) {
  const rows = [];
  for (const ms of MARKET_SEEDS.slice(0, 3)) {
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
    const snaps = [snapshotCity(g, parcels, base)];
    for (let m = 0; m < MONTHS; m++) {
      g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
      if (m % 60 === 0) scan(`null:${ms}`, g, parcels);
      if (m === 299 || m === MONTHS - 1) snaps.push(snapshotCity(g, parcels, base));
    }
    rows.push(snaps);
  }
  const at = (i, k) => med(rows.map((r) => r[i][k]));
  const lines = [
    `                    year 0        year 25       year 50`,
    `buildings standing  ${String(at(0, "built")).padEnd(13)} ${String(at(1, "built")).padEnd(13)} ${at(2, "built")}`,
    `vacant lots         ${String(at(0, "land")).padEnd(13)} ${String(at(1, "land")).padEnd(13)} ${at(2, "land")}`,
    `built sf            ${at(0, "sfM").toFixed(1)}M${" ".repeat(9)} ${at(1, "sfM").toFixed(1)}M${" ".repeat(9)} ${at(2, "sfM").toFixed(1)}M`,
    `mean building age   ${at(0, "age").toFixed(0)}${" ".repeat(12)} ${at(1, "age").toFixed(0)}${" ".repeat(12)} ${at(2, "age").toFixed(0)}`,
    `tallest building    ${String(at(0, "tallest")).padEnd(13)} ${String(at(1, "tallest")).padEnd(13)} ${at(2, "tallest")}`,
    `population          ${String(at(0, "pop")).padEnd(13)} ${String(at(1, "pop")).padEnd(13)} ${at(2, "pop")}`,
    `office vacancy      ${pct(at(0, "vacOff")).padEnd(13)} ${pct(at(1, "vacOff")).padEnd(13)} ${pct(at(2, "vacOff"))}`,
    `office rent index   ${at(0, "rentOff").toFixed(0)}${" ".repeat(12)} ${at(1, "rentOff").toFixed(0)}${" ".repeat(12)} ${at(2, "rentOff").toFixed(0)}`,
    `firms alive         ${String(at(0, "firms")).padEnd(13)} ${String(at(1, "firms")).padEnd(13)} ${at(2, "firms")}`,
    `street AUM          ${M(at(0, "aum")).padEnd(13)} ${M(at(1, "aum")).padEnd(13)} ${M(at(2, "aum"))}`,
    `lots ever traded    ${String(at(0, "comps")).padEnd(13)} ${String(at(1, "comps")).padEnd(13)} ${at(2, "comps")}`,
    `city groundbreaks   ${String(at(0, "cityBuilt")).padEnd(13)} ${String(at(1, "cityBuilt")).padEnd(13)} ${at(2, "cityBuilt")}`,
    `buildings demolished${String(at(0, "demolished")).padEnd(13)} ${String(at(1, "demolished")).padEnd(13)} ${at(2, "demolished")}`,
  ];
  // The verdict: did the world actually DO anything?
  const moved = [
    at(2, "comps") > 50, at(2, "cityBuilt") > 20, at(2, "demolished") > 5,
    Math.abs(at(2, "sfM") / Math.max(0.01, at(0, "sfM")) - 1) > 0.08,
    at(2, "firms") < at(0, "firms"),
  ].filter(Boolean).length;
  lines.push(`world-activity checks passed: ${moved}/5 (trades, city building, demolition, stock change, firm failure)`);
  report("A", "THE NULL PLAYER — 50 years, nobody playing",
    moved >= 4 ? "WIRED" : moved >= 2 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// H28. STRATEGY TOURNAMENT
// ===========================================================================
// Eight archetypes, each a real posture rather than a difficulty setting. They
// share one leasing policy (take anything at or near market) so that what is
// being compared is ACQUISITION and CAPITAL strategy, not leasing skill.

// WHAT A BUILDER WOULD ACTUALLY PUT ON THIS SITE, and whether it is worth
// putting anything there at all. Every use the zoning allows, at the height
// the envelope carries, and the winner is the one with the widest spread of
// yield on cost over the cap it will exit at — which is the only number in
// development that means anything. planDevelopment draws no random numbers, so
// asking it about a site the bot then declines to buy costs the run nothing
// and desynchronises no seed.
const USE_MENU = ["office", "multifamily", "retail", "industrial"];
function bestPlan(g, parcels, bbl) {
  const rec = E.resolveRec(parcels, g, bbl);
  if (!rec || rec.class !== "land") return null;
  let best = null;
  for (const use of USE_MENU) {
    const fl = Math.max(1, Math.min(E.maxFloorsFor(rec, 0.6, use), 12));
    const plan = E.planDevelopment(g, parcels, bbl, use, fl, 0.6);
    if (!plan || !Number.isFinite(plan.yieldOnCost)) continue;
    const spread = plan.yieldOnCost - plan.exitCap;
    if (!best || spread > best.spread) best = { use, floors: fl, plan, spread };
  }
  return best;
}
// The hurdle. A developer takes two to three years of construction risk, cost
// risk and lease-up risk to earn the difference between what a building yields
// on what it cost and what the market will pay for the income, and below a
// couple of hundred basis points of that there is no fee in it for the risk.
// It is the discipline that separates a merchant from a bot with a crane:
// measured over 941 land listings in this city, the MEDIAN site on the tape
// yields 0.76 points BELOW its own exit cap. Most dirt does not pencil, which
// is exactly why most dirt is still dirt.
//
const DEV_HURDLE_PP = 1.5;

const STRATS = {
  core: { ltv: 0.55, buyWhen: () => true, want: (r) => r.demandScore >= 55 && r.class !== "land", maxPrice: 1.0, sellAt: null, build: false },
  allcash: { ltv: 0, buyWhen: () => true, want: (r) => r.class !== "land", maxPrice: 0.96, sellAt: null, build: false },
  maxlev: { ltv: 0.80, buyWhen: () => true, want: (r) => r.class !== "land", maxPrice: 1.05, sellAt: null, build: false },
  valueadd: { ltv: 0.68, buyWhen: () => true, want: (r, g) => r.class !== "land" && E.initialCondition(r) !== "good", maxPrice: 0.92, sellAt: 96, build: false },
  landbank: { ltv: 0.35, buyWhen: () => true, want: (r) => r.class === "land", maxPrice: 1.0, sellAt: null, build: false },
  // A MERCHANT BUILDER BUYS DIRT WITH EQUITY AND LEVERS THE CONSTRUCTION, not
  // the other way round. The first cut of this bought land at 72% LTV, which
  // is a thing no lender writes and no builder asks for: raw land throws off
  // no income, so the debt service eats the sponsor alive while the site sits
  // there, and there is nothing left to fund the build with. It returned
  // -$0.1M with four wipeouts in four seeds and I reported that as an engine
  // blocker in the develop-lease-sell chain. It was the bot being stupid.
  // Land in cash, then build, then sell once it is leased -- which is the
  // actual business.
  //
  // AND IT UNDERWRITES THE SITE BEFORE IT BUYS IT. This bought whatever dirt
  // the tape offered under appraisal and then put eight floors of office on it
  // whatever the corner wanted, which is not a strategy — it is a coin toss
  // with a two-year settlement. A merchant's entire edge is the sites it walks
  // away from. It prices every use the envelope allows and only writes a
  // cheque where one of them clears the hurdle; then it builds THAT use.
  merchant: {
    ltv: 0, buyWhen: () => true, maxPrice: 1.0, sellAt: 60, build: true,
    want: (r, g, parcels) => {
      if (r.class !== "land") return false;
      const b = bestPlan(g, parcels, r.bbl);
      return !!b && b.spread >= DEV_HURDLE_PP;
    },
  },
  contrarian: { ltv: 0.60, buyWhen: (e) => e.phase === "recession" || (e.creditIdx ?? 1) < 0.8, want: (r) => r.class !== "land", maxPrice: 0.88, sellAt: null, build: false },
  industrial: { ltv: 0.62, buyWhen: () => true, want: (r) => r.class === "industrial", maxPrice: 1.0, sellAt: null, build: false },
};

function playStrategy(name, ms, base = city(CITY_SEED)) {
  const st = STRATS[name];
  const parcels = JSON.parse(JSON.stringify(base.parcels));
  let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
  let bought = 0, sold = 0, builtN = 0, peak = 0, trough = 1;
  // THE BOT CAN DIE, AND FIVE CHECKS READ THE NUMBER IT DIES AT.
  //
  // advanceQuarter returns state UNCHANGED once gameOver is set, so a bankrupt
  // strategy freezes and every later month is a copy of the month it failed.
  // Its terminal `nw` is then not a fifty-year outcome at all — it is the
  // INSOLVENCY EXIT CONDITION, a small negative number that barely varies with
  // the seed because it is a threshold rather than a result. [G] was reading
  // exactly that and dividing by it; 28 reports drawdowns "over 100%" out of
  // it. Recording the month makes the death a finding instead of a silent
  // freeze, and every caller can now say how long the strategy lasted rather
  // than implying it lasted fifty years.
  let deathM = 0;
  for (let m = 0; m < MONTHS; m++) {
    g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
    if (g.gameOver && !deathM) deathM = m + 1;
    const e = g.econ;
    // ---- leasing: identical for everyone
    for (const loi of [...g.lois]) {
      const rec = E.resolveRec(parcels, g, loi.bbl);
      const h = g.holdings[loi.bbl];
      if (!rec || !h) continue;
      const ask = E.managedRentPsfYr(rec, e, h, loi.use) * E.staleDiscount(h.darkMs);
      const r = E.respondLOI(g, parcels, loi.id, loi.rentPsf >= ask * 0.92 ? "accept" : "pass");
      if (!r.err) g = r.s;
    }
    // ---- take offers on anything we are selling
    for (const h of Object.values(g.holdings)) {
      if (!h.sale?.offer) continue;
      const r = E.acceptSaleOffer(g, parcels, h.bbl);
      if (!r.err) { g = r.s; sold++; }
    }
    // ---- buy
    // ONE SITE AT A TIME for a builder. Accumulating dirt is a land banker's
    // business, not a merchant's: seven vacant lots bought with the whole fund
    // earn nothing, cannot be built on because the equity is already spent,
    // and the property tax bleeds the account to zero. Which is exactly what
    // happened -- 101% drawdown, four wipeouts in four seeds. A merchant buys
    // a site, builds it, sells it, and buys the next one.
    // ...and it stays busy until the building is SOLD, not until it tops out.
    // The old rule freed the bot the month the job delivered, so it spent the
    // entire lease-up reserve on a second lot the same week it took delivery
    // of an empty building — and then had nothing to fit a tenant out with.
    // The reserve is the building's money, not the fund's.
    const busy = st.build
      && (Object.keys(g.developments).length > 0 || Object.keys(g.holdings).length > 0);
    if (st.buyWhen(e) && m > 2 && !busy) {
      // A DESK REVIEWS THE WHOLE TAPE, NOT THE FIRST SIX LINES OF IT.
      //
      // This read `[...g.listings].slice(0, 6)` — and `s.listings` is in
      // insertion order, so those six are the STALEST inventory on the market,
      // the lines nobody has taken. For a strategy that will buy any building
      // that is enough to find something. For `merchant`, which needs a LAND
      // listing that also clears a 1.5-point development spread, it is not:
      // measured, 13.29% of land listings clear that hurdle (95 of 715 across
      // three seeds and fifty years, about two a year), and the merchant bot
      // bought ZERO of them in any run. Its row in the table was therefore not
      // a finding about merchant development at all — it was the do-nothing arm
      // with a crane painted on it, and it was being read as "building
      // speculatively loses money".
      //
      // The window is gone rather than widened. `want` is cheap for everything
      // it rejects on class, so the expensive underwriting only runs on the
      // sites a merchant would actually price, and the bot is only in this loop
      // at all when it has nothing on site.
      for (const li of [...g.listings]) {
        const rec = E.resolveRec(parcels, g, li.bbl);
        if (!rec || g.holdings[li.bbl]) continue;
        if (!st.want(rec, g, parcels)) continue;
        const worth = rec.class === "land" ? E.landValue(rec, e)
          : E.assetValue?.(rec, e, E.initialCondition(rec)) ?? li.ask;
        if (li.ask > worth * st.maxPrice) continue;
        const prod = st.ltv <= 0.01 ? "cash" : "senior";
        const r = E.executePurchase(g, parcels, li.bbl, li.ask, prod, false, st.ltv <= 0.01 ? 1 : st.ltv / 0.65);
        if (!r.err) { g = r.s; bought++; break; }
      }
    }
    // ---- build (merchant)
    if (st.build && m > 6) {
      for (const h of Object.values(g.holdings)) {
        const rec = E.resolveRec(parcels, g, h.bbl);
        if (!rec || rec.class !== "land" || g.developments[h.bbl]) continue;
        // BREAK GROUND ON THE BUILDING THE SITE WANTS, or do not break ground.
        //
        // This asked maxFloorsFor(rec) for its height and got NaN back, because
        // coverage is not an optional argument: the function divides the FAR by
        // it, undefined poisons the division, and `?? 8` cannot catch a NaN
        // because NaN is not nullish. That NaN went in as the floor count and
        // came out the other side as the firm's entire cash balance — every
        // guard between the two is a comparison, and a comparison against NaN
        // is false, so all of them waved it through. It is why this bot read as
        // "-$0.1M, four wipeouts in four seeds" and why ground-up development
        // looked value-destructive when it was never once attempted. The engine
        // refuses an unpriceable job now; the harness has to ask a real
        // question anyway.
        //
        // The site was underwritten before the cheque was written, so re-price
        // it here rather than trusting a number from months ago — the market
        // moves between contract and closing, and a job that stopped pencilling
        // while the lawyers worked is a job you do not start.
        const b = bestPlan(g, parcels, h.bbl);
        if (!b || b.spread < DEV_HURDLE_PP) break;
        // A MERCHANT BUILDER BORROWS TO BUILD. THAT IS THE BUSINESS — and this
        // called startDevelopment with no LTC at all, funding construction out
        // of a $2.5M fund when a building costs multiples of it. 65% is not a
        // tuned number: it is the engine's own reference LTC, the divisor every
        // other levered strategy here is expressed against (`st.ltv / 0.65`
        // above), and it is the middle of the band a construction lender writes.
        //
        // IT DID NOT FIX THE BOT, AND I AM LEAVING THAT WRITTEN DOWN. I expected
        // the equity test to be what refused the job; measured, merchant still
        // buys 1 site and builds 0 across six seeds and fifty years, exactly as
        // before. So the missing loan was real and was NOT the binding
        // constraint, and whatever stops this bot breaking ground is still
        // unfound. The `did each strategy actually trade?` line below exists to
        // keep that visible instead of letting the row read as a verdict on
        // speculative development.
        const r = E.startDevelopment(g, parcels, h.bbl, b.use, b.floors, 0.6, "gmp", 0.65);
        if (!r.err) { g = r.s; builtN++; }
        break;
      }
    }
    // ---- sell on a clock (merchant / value-add)
    if (st.sellAt) {
      for (const h of Object.values(g.holdings)) {
        if (h.sale || g.developments[h.bbl]) continue;
        if (m - (h.boughtM ?? 0) < st.sellAt) continue;
        const rec = E.resolveRec(parcels, g, h.bbl);
        if (!rec || rec.class === "land") continue;
        // holdingValue(rec, econ, holding, month) — NOT (state, parcels, bbl).
        // Called the wrong way it read a GameState as a parcel, found no
        // bldgArea, fell through to landValue(state, parcels), and returned
        // NaN. listForSale refuses a price that is not a number, so this
        // branch has never once put a building on the market: every strategy
        // with a sell discipline — merchant and value-add, the only two — was
        // silently a buy-and-hold. Both of them sat at the bottom of the table
        // and the reason was that half of each was not running.
        const v = E.holdingValue(rec, e, h, g.month);
        if (!Number.isFinite(v) || v <= 0) break;
        const r = E.listForSale(g, parcels, h.bbl, Math.round(v * 1.02));
        if (!r.err) g = r.s;
        break;
      }
    }
    if (m % 12 === 0) {
      const nw = E.netWorth(g, parcels);
      peak = Math.max(peak, nw);
      if (peak > 0) trough = Math.min(trough, nw / peak);
    }
    if (m % 120 === 0) scan(`strat:${name}:${ms}`, g, parcels);
  }
  return { nw: E.netWorth(g, parcels), bought, sold, builtN, drawdown: 1 - trough,
           holdings: Object.keys(g.holdings).length, cpi: g.econ.cpi, deathM };
}

if (want(28)) {
  const table = [];
  const perSeed = new Map(MARKET_SEEDS.map((ms) => [ms, []]));
  for (const name of Object.keys(STRATS)) {
    const outs = MARKET_SEEDS.map((ms) => playStrategy(name, ms));
    outs.forEach((o, i) => perSeed.get(MARKET_SEEDS[i]).push({ name, real: o.nw / Math.max(0.1, o.cpi) }));
    const nws = outs.map((o) => o.nw).sort((a, b) => a - b);
    table.push({
      name, med: med(nws), worst: nws[0], best: nws[nws.length - 1],
      realMed: med(outs.map((o) => o.nw / Math.max(0.1, o.cpi))),
      dd: med(outs.map((o) => o.drawdown)), fails: outs.filter((o) => o.nw < 1e6).length,
      bought: med(outs.map((o) => o.bought)), sold: med(outs.map((o) => o.sold)), holds: med(outs.map((o) => o.holdings)),
      builtN: med(outs.map((o) => o.builtN)), died: outs.filter((o) => o.deathM > 0).length, deathM: med(outs.filter((o) => o.deathM > 0).map((o) => o.deathM)),
    });
    log(`   ${name.padEnd(11)} median ${M(med(nws))}  worst ${M(nws[0])}  best ${M(nws[nws.length - 1])}`);
  }
  table.sort((a, b) => b.realMed - a.realMed);
  const winner = table[0], loser = table[table.length - 1];
  // WHAT "DOMINANT" ACTUALLY MEANS, and what it does not.
  //
  // This divided the best strategy's return by the worst one's. The worst
  // strategy in a game with leverage in it goes BANKRUPT, so the denominator
  // is negative, and `Math.max(1, negative)` is 1 — which turned the headline
  // dominance measure into "the winner's net worth, in dollars, with an x
  // after it": 116,770,360x, reported to one decimal place. It could never
  // read anything else while any strategy ended under water, so the verdict
  // was pinned at BROKEN by arithmetic rather than by evidence.
  //
  // A dominant strategy is one that (a) wins most of the worlds it is played
  // in and (b) beats the FIELD by a wide margin. The median strategy is the
  // field, it is positive whenever the game is playable at all, and the win
  // rate is the part that cannot be faked by one lucky seed.
  const medianReal = med(table.map((t) => t.realMed));
  const edge = medianReal > 0 ? winner.realMed / medianReal : Infinity;
  let wins = 0;
  for (const [, rows] of perSeed) {
    rows.sort((a, b) => b.real - a.real);
    if (rows[0]?.name === winner.name) wins++;
  }
  const winRate = wins / MARKET_SEEDS.length;
  const lines = [
    `strategy     median NW    real NW      worst        best         maxDD   wipeouts  bought  sold  holds`,
    ...table.map((t) =>
      `${t.name.padEnd(12)} ${M(t.med).padEnd(12)} ${M(t.realMed).padEnd(12)} ${M(t.worst).padEnd(12)} ${M(t.best).padEnd(12)} ${pct(t.dd).padEnd(7)} ${String(t.fails).padEnd(9)} ${String(t.bought).padEnd(7)} ${String(t.sold).padEnd(5)} ${t.holds}`),
    ``,
    `strongest: ${winner.name} at ${M(winner.realMed)} real · weakest: ${loser.name} at ${M(loser.realMed)}`,
    `the field (median strategy): ${M(medianReal)} real`,
    `top strategy over the field: ${Number.isFinite(edge) ? edge.toFixed(2) + "x" : "unbounded — the median strategy loses money"}   (need <= 4x)`,
    `top strategy wins ${wins} of ${MARKET_SEEDS.length} worlds outright: ${pct(winRate)}   (need <= 70% — one right answer is a solved game)`,
    `strategies that end in the black: ${table.filter((t) => t.realMed > 1e6).length} of ${table.length}`,
    ``,
    // THE TOURNAMENT'S OWN COVERAGE — because a bot that stops is invisible.
    //
    // CLAUDE.md: "Any harness whose subject is a bot has a second failure mode
    // nothing else will catch — the bot stopping — and the harness is
    // responsible for noticing." conserve learned that when its buyer's cash
    // threshold outlived the bankroll it was sized against, and reconciled a
    // player who owned nothing for an unknown number of commits while printing
    // a pass.
    //
    // The same thing is happening here in plain sight: `merchant` buys NOTHING
    // and builds NOTHING across every seed, so its line in the table above is
    // not a measurement of merchant development at all — it is a second copy of
    // the do-nothing arm, priced in G&A, being read as "merchant loses money".
    // A strategy that never acts is not evidence about strategy.
    `did each strategy actually trade?`,
    ...table.map((t) => `   ${t.name.padEnd(12)} bought ${String(t.bought).padStart(3)}  sold ${String(t.sold).padStart(3)}  built ${String(t.builtN ?? 0).padStart(3)}`
      + `${(t.bought + t.sold + (t.builtN ?? 0)) === 0 ? "   <-- INERT: this row is not a finding about this strategy" : ""}`),
  ];
  const dominant = (edge > 4 ? 1 : 0) + (winRate > 0.7 ? 1 : 0);
  report(28, "STRATEGY TOURNAMENT", dominant === 2 ? "BROKEN" : dominant === 1 ? "WEAK" : "WIRED", lines);
  globalThis.__tourney = table;
}

// ===========================================================================
// SHARED APPARATUS FOR THE SECTIONS BELOW
// ===========================================================================
// A city other than the default one, for the sections that ask whether the map
// matters. econaudit-core's `city()` caches on the market seed alone because
// every experiment in that file plays New Alden; this keys on both.
const CITY_CACHE = new Map();
function cityNamed(id, seed) {
  const key = `${id}:${seed}`;
  if (!CITY_CACHE.has(key)) {
    const built = makeCity(id, seed);
    E.normalizeParcels(built.parcels);
    CITY_CACHE.set(key, { parcels: built.parcels, adjacency: built.adjacency, bbls: Object.keys(built.parcels), name: built.name });
  }
  return CITY_CACHE.get(key);
}

/** Land $/sf across a set of parcels — the number a district reprices through. */
const landPsf = (parcels, g, bbls) =>
  med(bbls.map((b) => { const r = E.resolveRec(parcels, g, b); return r?.lotArea ? E.landValue(r, g.econ) / r.lotArea : NaN; }));

/** One shared leasing policy, so nothing below is measuring leasing skill. */
// See test/leasepolicy.mjs — one rule, imported, not copied.

// ===========================================================================
// B. THE PLAYER EXISTS TO THE WORLD — the mirror of A
// ===========================================================================
// A asked whether the city moves when nobody plays. This asks the harder
// half: when somebody DOES play, does the city feel it? A simulation that
// runs beautifully on its own and treats the player as a spectator with a
// balance sheet is not a game, it is a screensaver with a ledger.
//
// A whale buys everything it can inside ONE district and nothing anywhere
// else. The measurement is a DIFFERENCE IN DIFFERENCES, and it has to be:
// buying consumes random numbers, so the treatment's RNG stream desynchronises
// from the control's on the first purchase and every citywide number after
// that carries seed drift as well as signal. What does NOT carry the drift is
// the gap between the bought district and the rest of the same town — so the
// statistic is (target - rest) under the whale, less (target - rest) without
// one. Anything that survives that is the player's own footprint.
if (want("B")) {
  const lines = [];
  const dd = [], compsD = [], listD = [];
  for (const ms of MARKET_SEEDS.slice(0, 3)) {
    const base = city(CITY_SEED);
    const dmap = districtsOf(base.parcels, base.bbls);
    // the biggest district that is not the industrial fringe — where a whale
    // would actually go
    const target = [...dmap.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const [dName, dBbls] = target;
    const rest = base.bbls.filter((b) => !dBbls.includes(b));
    const arm = (whale) => {
      const parcels = JSON.parse(JSON.stringify(base.parcels));
      let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
      if (whale) { g = JSON.parse(JSON.stringify(g)); g.cash = 400e6; }
      let bought = 0;
      for (let m = 0; m < 300; m++) {
        g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
        if (!whale) continue;
        g = leaseAtMarket(E, g, parcels);
        for (const li of [...g.listings]) {
          if (!dBbls.includes(li.bbl) || g.holdings[li.bbl]) continue;
          const rec = E.resolveRec(parcels, g, li.bbl);
          if (!rec) continue;
          const worth = rec.class === "land" ? E.landValue(rec, g.econ) : E.assetValue(rec, g.econ, E.initialCondition(rec));
          if (li.ask > worth * 1.15) continue;
          const r = E.executePurchase(g, parcels, li.bbl, li.ask, "cash", false, 1);
          if (!r.err) { g = r.s; bought++; break; }
        }
      }
      // DISTINCT PARCELS THAT HAVE TRADED, not g.comps — the comps sheet is a
      // rolling window capped at MAX_COMPS (comps.ts), so counting it over
      // twenty-five years measures the size of the cap and nothing else. It
      // read as an identical 240 in every arm of every experiment until this
      // was caught. `lastTradeM` is the cumulative record.
      return { g, parcels, bought,
        gap: landPsf(parcels, g, dBbls) / Math.max(1e-9, landPsf(parcels, g, rest)),
        traded: dBbls.filter((b) => g.lastTradeM?.[b] !== undefined).length,
        listings: g.listings.filter((l) => dBbls.includes(l.bbl)).length };
    };
    const ctrl = arm(false), treat = arm(true);
    dd.push(treat.gap / ctrl.gap);
    compsD.push(treat.traded / Math.max(1, ctrl.traded));
    listD.push(treat.listings - ctrl.listings);
    lines.push(`seed ${String(ms).padEnd(7)} whale took ${String(treat.bought).padStart(3)} lots in ${dName}: `
      + `land $/sf vs the rest of town ${ctrl.gap.toFixed(2)}x -> ${treat.gap.toFixed(2)}x, `
      + `lots that changed hands there ${ctrl.traded} -> ${treat.traded}, listings left standing ${ctrl.listings} -> ${treat.listings}`);
  }
  const lift = med(dd);
  lines.push(``);
  lines.push(`difference-in-differences on district land value: ${((lift - 1) * 100).toFixed(1)}%   (need >= 2% — buying a district must move its ground)`);
  // A HOLDER IS A SINK, and I wrote this clause expecting the opposite.
  // "More buying means more trades" is wrong for an accumulator: every lot the
  // whale takes leaves the tape for good (refreshListings skips anything in
  // s.holdings), so the district's turnover FALLS — which is exactly what an
  // institution buying up a neighbourhood does to it. The claim worth testing
  // is that the player is visible in the trade record at all, in whichever
  // direction their posture implies.
  lines.push(`lots in the bought district that changed hands: ${med(compsD).toFixed(2)}x the control   (must MOVE — a whale is a sink, not a source)`);
  lines.push(`listings still on the tape there: ${med(listD).toFixed(1)} versus the control (a buyer clears the shelf)`);
  const moved = [lift >= 1.02, Math.abs(1 - med(compsD)) > 0.15, med(listD) <= 0].filter(Boolean).length;
  report("B", "THE PLAYER EXISTS TO THE WORLD — 25 years, one district bought out",
    moved >= 3 ? "WIRED" : moved >= 2 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// C. THE STREET COMPETES — is anybody else actually bidding?
// ===========================================================================
// Rivals that hold buildings and never buy any are set dressing: the tape
// would clear at the player's price because there is nobody on the other side
// of it. The question is not whether firms exist, it is whether a listing the
// player wants can be taken away from them.
if (want("C")) {
  const lines = [];
  const absorbed = [], expired = [], rivalGrew = [], beaten = [];
  for (const ms of MARKET_SEEDS.slice(0, 3)) {
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
    const open = new Map();      // bbl -> the month it was listed
    let gone = 0, ran = 0, lost = 0;
    const startAum = (g.rivals ?? []).reduce((a, r) => a + (r.bbls?.length ?? 0), 0);
    for (let m = 0; m < MONTHS; m++) {
      const before = new Set(g.listings.map((l) => l.bbl));
      // what the player would have gone after this month, at a fair price
      const wanted = g.listings.filter((l) => {
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec || rec.class === "land") return false;
        return l.ask <= E.assetValue(rec, g.econ, E.initialCondition(rec));
      }).map((l) => l.bbl);
      g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
      const after = new Set(g.listings.map((l) => l.bbl));
      for (const b of before) {
        if (after.has(b)) continue;
        // it left the tape: sold if a comp was struck on it this month
        const sold = (g.comps ?? []).some((c) => c.bbl === b && Math.abs((c.m ?? c.month ?? -99) - g.month) <= 1);
        if (sold) { gone++; if (wanted.includes(b)) lost++; } else ran++;
      }
      void open;
    }
    const endAum = (g.rivals ?? []).reduce((a, r) => a + (r.bbls?.length ?? 0), 0);
    absorbed.push(gone); expired.push(ran); beaten.push(lost);
    rivalGrew.push(endAum / Math.max(1, startAum));
    lines.push(`seed ${String(ms).padEnd(7)} ${gone} listings taken off the tape by a buyer, ${ran} simply expired; `
      + `${lost} of the takes were assets the player would have bought at appraisal`);
  }
  const takeShare = med(absorbed) / Math.max(1, med(absorbed) + med(expired));
  lines.push(``);
  lines.push(`share of listings that ended in a TRADE rather than an expiry: ${pct(takeShare)}   (need >= 15% — a tape nobody clears is a shop with no customers)`);
  lines.push(`assets the player wanted and lost to somebody else: ${med(beaten)} over ${MONTHS / 12} years   (need >= 10 — competition has to cost you deals)`);
  lines.push(`rival holdings, end / start: ${med(rivalGrew).toFixed(2)}x`);
  const ok = [takeShare >= 0.15, med(beaten) >= 10, med(rivalGrew) > 0.5].filter(Boolean).length;
  report("C", "THE STREET COMPETES — who else is bidding, and does it cost you",
    ok >= 3 ? "WIRED" : ok >= 2 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// D. CREDIT IS A CONSTRAINT — does capital availability gate anything?
// ===========================================================================
// A paired run, and this one CAN be paired honestly: pinning the credit index
// is a direct write on econ state that draws no random numbers, so the two
// streams stay in step and every difference is the treatment.
if (want("D")) {
  const lines = [];
  const rows = [];
  // Its own loop rather than the core's `run`, because the honest trade count
  // is CUMULATIVE and g.comps is a rolling window capped at MAX_COMPS — read
  // at the end of fifty years it returns the cap in every arm of every
  // experiment, which is exactly the identical "240 vs 240" that first made
  // this test look like it had found something.
  const arm = (ms, credit) => {
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
    let trades = 0;
    for (let m = 0; m < MONTHS; m++) {
      g.econ.creditIdx = credit;                      // a plain write; draws no random numbers
      const before = new Set(g.listings.map((l) => l.bbl));
      g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
      const after = new Set(g.listings.map((l) => l.bbl));
      for (const b of before) if (!after.has(b) && g.lastTradeM?.[b] !== undefined && g.month - g.lastTradeM[b] <= 1) trades++;
    }
    return {
      builds: (g.cityBuilt ?? []).length,
      trades,
      stock: USES.reduce((a, u) => a + (g.econ.stock?.[u] ?? 0), 0) / 1e6,
      rent: g.econ.rentIdx?.office ?? 0,
      firms: (g.rivals ?? []).filter((x) => x.failedM === undefined && !x.dead).length,
    };
  };
  for (const ms of MARKET_SEEDS.slice(0, 2)) {
    rows.push({ ms, loose: arm(ms, 1.35), tight: arm(ms, 0.55) });
  }
  const r0 = (k) => med(rows.map((r) => r.loose[k])), r1 = (k) => med(rows.map((r) => r.tight[k]));
  lines.push(`                     credit loose (1.35)   credit tight (0.55)`);
  for (const [k, label] of [["builds", "city groundbreaks"], ["trades", "listings that traded"], ["stock", "built stock, M sf"], ["rent", "office rent index"], ["firms", "firms still alive"]]) {
    lines.push(`${label.padEnd(21)}${String(typeof r0(k) === "number" ? r0(k).toFixed(k === "stock" ? 2 : 0) : r0(k)).padEnd(22)}${typeof r1(k) === "number" ? r1(k).toFixed(k === "stock" ? 2 : 0) : r1(k)}`);
  }
  const buildGap = r0("builds") / Math.max(1, r1("builds"));
  const tradeGap = r0("trades") / Math.max(1, r1("trades"));
  lines.push(``);
  lines.push(`cranes, loose / tight: ${buildGap.toFixed(2)}x   (need >= 1.15 — cheap money has to build something)`);
  lines.push(`trades, loose / tight: ${tradeGap.toFixed(2)}x   (need >= 1.10 — dear money has to stop deals)`);
  const ok = [buildGap >= 1.15, tradeGap >= 1.10].filter(Boolean).length;
  report("D", "CREDIT IS A CONSTRAINT — pin the index loose, then tight",
    ok === 2 ? "WIRED" : ok === 1 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// E. FAILURE IS REACHABLE, AND IT IS A LADDER
// ===========================================================================
// A game you cannot lose is a toy, and a game that ends the instant you slip
// is a trap. What has to exist is the middle: a breach, then a sweep, then a
// file on somebody's desk, then a deed changing hands — each rung reachable,
// each one survivable, and the bottom actually the bottom. This drives a
// deliberately reckless sponsor into the wall and watches which rungs fire.
if (want("E")) {
  const lines = [];
  const tally = { breach: 0, sweep: 0, workout: 0, foreclosure: 0, seized: 0, gameOver: 0, cured: 0 };
  let seeds = 0;
  for (const ms of MARKET_SEEDS.slice(0, 3)) {
    seeds++;
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
    const hit = { breach: false, sweep: false, workout: false, foreclosure: false, seized: false, cured: false };
    for (let m = 0; m < MONTHS && !g.gameOver; m++) {
      g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
      g = leaseAtMarket(E, g, parcels);
      // buy anything, at the top of the market, with all the debt on offer
      for (const li of [...g.listings].slice(0, 4)) {
        const rec = E.resolveRec(parcels, g, li.bbl);
        if (!rec || rec.class === "land" || g.holdings[li.bbl]) continue;
        const r = E.executePurchase(g, parcels, li.bbl, li.ask, "senior", false, 0.85 / 0.65);
        if (!r.err) { g = r.s; break; }
      }
      for (const h of Object.values(g.holdings)) {
        if (h.loan?.sweep) hit.sweep = true;
        if ((h.loan?.breachMs ?? 0) > 0) hit.breach = true;
        if ((h.loan?.cleanQs ?? 0) > 0 && !h.loan?.sweep) hit.cured = true;
      }
      for (const w of Object.values(g.workouts ?? {})) {
        hit.workout = true;
        if (w.stage === "foreclosure") hit.foreclosure = true;
      }
      if ((g.seized ?? 0) > 0) hit.seized = true;
    }
    for (const k of Object.keys(hit)) if (hit[k]) tally[k]++;
    if (g.gameOver) tally.gameOver++;
    lines.push(`seed ${String(ms).padEnd(7)} ${Object.entries(hit).filter(([, v]) => v).map(([k]) => k).join(" -> ") || "nothing went wrong at 85% LTV on everything, which is its own finding"}`
      + `${g.gameOver ? "  [RUN ENDED]" : ""}`);
  }
  lines.push(``);
  lines.push(`of ${seeds} reckless sponsors: ${tally.breach} breached a covenant, ${tally.sweep} had cash trapped, ${tally.cured} cured one,`);
  lines.push(`${tally.workout} reached a workout desk, ${tally.foreclosure} were foreclosed, ${tally.seized} had assets seized, ${tally.gameOver} were ended`);
  lines.push(`(need every rung of the ladder to fire at least once, and at least one sponsor to survive its own breach)`);
  const rungs = [tally.breach, tally.sweep, tally.workout].filter((x) => x > 0).length;
  report("E", "FAILURE IS REACHABLE, AND IT IS A LADDER",
    rungs === 3 && tally.cured > 0 ? "WIRED" : rungs >= 2 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// F. GEOGRAPHY CHANGES THE ANSWER — or the maps are wallpaper
// ===========================================================================
// Five generated islands. If the same strategy on the same market seed returns the
// same money on all five, then the coastlines, the grids and the parks are a
// skin over one town and there is no reason to play the second one.
if (want("F")) {
  const lines = [];
  const rows = [];
  const GEO_SEEDS = [1, 20261, 30411, 481923, 550991];
  for (const seed of GEO_SEEDS) {
    const b = cityNamed(PROCEDURAL, seed);
    const outs = MARKET_SEEDS.slice(0, 2).map((ms) => playStrategy("core", ms, b));
    const lots = b.bbls.length;
    const landShare = b.bbls.filter((x) => b.parcels[x].class === "land").length / lots;
    rows.push({ name: b.name, nw: med(outs.map((o) => o.nw)), bought: med(outs.map((o) => o.bought)), lots, landShare });
  }
  rows.sort((a, b) => b.nw - a.nw);
  lines.push(`city          lots   vacant   the same core strategy, median net worth`);
  for (const r of rows) lines.push(`${r.name.padEnd(14)}${String(r.lots).padEnd(7)}${pct(r.landShare).padEnd(9)}${M(r.nw)}   (${r.bought} bought)`);
  // Against the FIELD, not against the worst map — a city the strategy goes
  // bankrupt in gives a negative denominator and a meaningless ratio, the same
  // trap the tournament's dominance number fell into.
  const fieldNw = med(rows.map((r) => r.nw));
  const spread = fieldNw > 0 ? rows[0].nw / fieldNw : Infinity;
  const bust = rows.filter((r) => r.nw < 1e6).length;
  lines.push(``);
  lines.push(`best map over the median map: ${Number.isFinite(spread) ? spread.toFixed(2) + "x" : "unbounded"}   (need >= 1.25x — the map has to be an argument)`);
  lines.push(`cities where one unchanged strategy goes broke: ${bust} of ${rows.length}   (geography should be able to beat a plan)`);
  report("F", "GEOGRAPHY CHANGES THE ANSWER — one strategy, five cities",
    spread >= 1.25 ? "WIRED" : spread >= 1.1 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// G. TIME COSTS SOMETHING — is doing nothing a strategy?
// ===========================================================================
// The deposit rate is deliberately dull and the firm carries overhead whether
// or not it owns anything, both on purpose. This checks the purpose landed:
// sitting on the opening cheque for fifty years has to LOSE, in real money, to
// somebody who bought buildings with it.
// THE OLD ESTIMATOR DIVIDED BY ONE DOLLAR AND COULD NOT REPORT BROKEN.
//
// It printed `med(active) / Math.max(1, idleReal)` and called it "penalty for
// idleness: 21357137.3x". That is not a ratio. The do-nothing firm is INSOLVENT
// by year 24-38 on 10 seeds out of 10 — fixed G&A against a 1% deposit rate,
// which is the mechanism working — so `idleReal` is never positive, the clamp
// returns the literal integer 1 in every run ever made, and the printed number
// is the active firm's net worth in dollars with an "x" stuck on the end. The
// second acceptance check therefore read "active must end with at least three
// dollars".
//
// The first check was worse. `idleReal < start` with `start = 6e6` is satisfied
// by MINUS FIFTY THOUSAND on every seed, so it is a tautology — and 6e6 was
// itself stale, from an era whose opening bankroll no longer exists
// (DEFAULT_START_CASH is 2,500,000). BROKEN needs ok===0 and ok was never below
// 1, so this check was structurally pinned to WIRED or WEAK and could not fail
// about anything. Fault-injected: an active strategy that DESTROYS 79% of the
// fund's real capital over fifty years — the claim flatly violated — scored
// "516042.0x" and WIRED.
//
// It also deflated the two arms by two different price levels: the idle arm by
// the CPI frozen at its own death, the active arm by the CPI at month 600. Same
// city, same market seed, two answers for the end of the measurement.
//
// This is the same fault this file already found and fixed for test 28 — see
// the note there about `Math.max(1, negative)` turning a dominance measure into
// "the winner's net worth, in dollars, with an x after it". [G] was never
// brought along.
//
// So: no ratio anywhere, no cross-arm deflator, and every denominator a
// positive constant read from the engine. Each arm's real return is measured
// against its OWN price level, which is the only internally consistent thing to
// do when one world stops at year 30 and the other runs to fifty. The claim
// splits into the three statements it was always made of, and each is checked
// per seed rather than on a median of three:
//
//   S1  doing nothing is FATAL — the idle firm goes insolvent inside the run
//   S2  buying buildings COMPOUNDS — the active firm's real return beats zero
//   S3  holding cash DECAYS — the idle firm's real return does not
//
// EACH STATEMENT CAN FAIL, AND HERE IS THE MEASUREMENT RATHER THAN THE CLAIM.
// The first version of this comment asserted "BROKEN is reachable: verified by
// injection", which I had not run. It is false as written, and an unearned
// claim in a test is the same species of fault the test was fixing.
//
//   START_CASH=1000000 node tools/econstress.mjs --only=G
//     S1  6 of 6   insolvent, median year 14.6 (against 30.7 at $2.5M)
//     S2  2 of 6   buyer's real return -105% -106% -115% -113% -110% +413%
//     S3  6 of 6   -106% every seed
//     -> WEAK
//
// So a real, choosable opening cheque breaks S2 and the verdict moves. BROKEN
// needs two of the three to fail, and S1 and S3 are the same mechanism seen
// twice — fixed overhead against a dull deposit rate — so they fall TOGETHER
// if that carry is ever removed, which is precisely the fault this check
// exists to catch. That is the design, not a gap: the verdict is severe when
// the thing being tested is actually gone, and merely WEAK when the world is
// simply hard.
if (want("G")) {
  const lines = [];
  const rows = [];
  for (const ms of MARKET_SEEDS) {
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    const g0 = newGame(ms, parcels);
    // READ THE OPENING CHEQUE, DO NOT ASSERT IT. The old `6e6` was a number
    // from a bankroll that no longer exists, and a hardcoded start is exactly
    // how conserve's bot went quiet for an unknown number of commits.
    const start = g0.cash;
    let g = E.firstListings(g0, parcels, base.bbls);
    // NO RESURRECTION HERE, ON PURPOSE — the death is the finding. But it is
    // RECORDED rather than silently frozen: advanceQuarter returns state
    // unchanged once gameOver is set, so without this the terminal "wealth" is
    // the insolvency exit condition wearing a fifty-year label.
    let deathM = 0;
    for (let m = 0; m < MONTHS; m++) {
      g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
      if (g.gameOver && !deathM) deathM = m + 1;
    }
    const idleReal = E.netWorth(g, parcels) / Math.max(0.1, g.econ.cpi);
    const a = playStrategy("allcash", ms);
    const activeReal = a.nw / Math.max(0.1, a.cpi);
    rows.push({ ms, start, deathM, idleReal, activeReal,
      idleEdge: idleReal / start - 1, activeEdge: activeReal / start - 1 });
  }

  const died = rows.filter((r) => r.deathM > 0);
  // THE CLAIM IS COMPARATIVE — the title says buying must BEAT sitting, so that
  // is what is counted, per seed, rather than a median of medians. Compounding
  // is printed beside it because a world where both arms lose is a different
  // story from one where the buyer merely trails the bank.
  const beat = rows.filter((r) => r.activeEdge > r.idleEdge);
  const compounded = rows.filter((r) => r.activeEdge > 0);
  const decayed = rows.filter((r) => r.idleEdge < 0);
  const n = rows.length;

  lines.push(`the opening cheque is ${M(rows[0].start)}, read from the engine — ${n} seeds, ${MONTHS / 12} years`);
  lines.push(``);
  lines.push(`S1  doing nothing is fatal:   insolvent in ${died.length} of ${n} runs   (need ${n} of ${n})`);
  lines.push(`      months to insolvency: ${rows.map((r) => (r.deathM || "—")).join("  ")}   median ${med(died.map((r) => r.deathM)).toFixed(0)}`
    + `${died.length ? ` (year ${(med(died.map((r) => r.deathM)) / 12).toFixed(1)})` : ""}`);
  lines.push(`S2  buying beats sitting:     in ${beat.length} of ${n} worlds   (need ${n} of ${n})`);
  lines.push(`      buyer's real return: ${rows.map((r) => `${(r.activeEdge * 100).toFixed(0)}%`).join("  ")}`);
  lines.push(`      and it COMPOUNDS (>0) in ${compounded.length} of ${n} — a world where both arms lose is a`);
  lines.push(`      different story from one where the buyer merely trails the bank`);
  lines.push(`S3  cash decays:              real return < 0 in ${decayed.length} of ${n}   (need ${n} of ${n})`);
  lines.push(`      per seed: ${rows.map((r) => `${(r.idleEdge * 100).toFixed(0)}%`).join("  ")}`);
  lines.push(``);
  lines.push(`each arm is deflated by its OWN world's price level — one of them stops at year `
    + `${(med(died.map((r) => r.deathM)) / 12).toFixed(0)} and the other runs to ${MONTHS / 12}, `
    + `so there is no single "end of the measurement" to share`);
  const ok = [died.length === n, beat.length === n, decayed.length === n].filter(Boolean).length;
  report("G", "TIME COSTS SOMETHING — fifty years of doing nothing",
    ok === 3 ? "WIRED" : ok === 2 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// 29. THE MONEY PUMP — is there a loop that mints money?
// ===========================================================================
// The question named in this file's own header and never asked. A pump is any
// repeatable sequence of legal moves that ends with more money than it began
// and can be run again immediately. It does not have to be large: a loop worth
// a hundred dollars a cycle with no cooldown is worth infinity, and every
// economy that has ever shipped with one has been beaten by it inside a week.
//
// Each loop below is run from a clean state and measured on the round trip.
// Every one of them MUST cost money. The size of the loss is the spread, the
// fees and the taxes doing their job.
if (want(29)) {
  const lines = [];
  const base = city(CITY_SEED);
  const loops = [];
  const fresh = (cash = 120e6) => {
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(MARKET_SEEDS[0], parcels), parcels, base.bbls);
    for (let m = 0; m < 24; m++) g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
    g = JSON.parse(JSON.stringify(g)); g.cash = cash;
    return { g, parcels };
  };

  // 1. BUY AT THE ASK, SELL AT THE APPRAISAL, IMMEDIATELY.
  {
    const { g: g0, parcels } = fresh();
    let g = g0, done = 0, total = 0;
    for (const li of [...g.listings].slice(0, 8)) {
      const rec = E.resolveRec(parcels, g, li.bbl);
      if (!rec || rec.class === "land") continue;
      const before = E.netWorth(g, parcels);
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, "cash", false, 1);
      if (r.err) continue;
      g = r.s;
      const h = g.holdings[li.bbl];
      const v = E.holdingValue(E.resolveRec(parcels, g, li.bbl), g.econ, h, g.month);
      const s2 = E.listForSale(g, parcels, li.bbl, Math.round(v));
      if (!s2.err) g = s2.s;
      total += E.netWorth(g, parcels) - before; done++;
    }
    loops.push({ name: "buy at ask, mark at appraisal", n: done, per: done ? total / done : NaN });
  }

  // 2. LIST AND DELIST, FOREVER. A free option on the market is still a pump.
  {
    const { g: g0, parcels } = fresh();
    let g = g0;
    const li = [...g.listings].find((l) => E.resolveRec(parcels, g, l.bbl)?.class !== "land");
    let per = NaN;
    if (li) {
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, "cash", false, 1);
      if (!r.err) {
        g = r.s;
        const before = E.netWorth(g, parcels);
        for (let i = 0; i < 12; i++) {
          const v = E.holdingValue(E.resolveRec(parcels, g, li.bbl), g.econ, g.holdings[li.bbl], g.month);
          const a = E.listForSale(g, parcels, li.bbl, Math.round(v * 1.4));   // priced never to sell
          if (!a.err) g = a.s;
          g = E.delist(g, li.bbl);   // returns the state, not a {s, err}
        }
        per = (E.netWorth(g, parcels) - before) / 12;
      }
    }
    loops.push({ name: "list high, delist, repeat", n: 12, per });
  }

  // 3. DRAW THE LINE AND PAY IT STRAIGHT BACK.
  {
    const { g: g0, parcels } = fresh(40e6);
    let g = g0;
    const li = [...g.listings].find((l) => E.resolveRec(parcels, g, l.bbl)?.class !== "land");
    let per = NaN;
    if (li) {
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, "cash", false, 1);
      if (!r.err) {
        g = r.s;
        const before = E.netWorth(g, parcels);
        for (let i = 0; i < 10; i++) {
          const avail = E.locAvailable(g, parcels);
          const d = E.drawLoc(g, parcels, Math.round(avail * 0.9));
          if (!d.err) g = d.s;
          const p = E.repayLoc(g, g.loc?.balance ?? 0);
          if (!p.err) g = p.s;
        }
        per = (E.netWorth(g, parcels) - before) / 10;
      }
    }
    loops.push({ name: "draw the revolver, repay it", n: 10, per });
  }

  // 4. REFINANCE REPEATEDLY. Cash-out that costs nothing is a printing press.
  {
    const { g: g0, parcels } = fresh();
    let g = g0;
    const li = [...g.listings].find((l) => E.resolveRec(parcels, g, l.bbl)?.class !== "land");
    let per = NaN, n = 0;
    if (li) {
      const r = E.executePurchase(g, parcels, li.bbl, li.ask, "senior", false, 1);
      if (!r.err) {
        g = r.s;
        const before = E.netWorth(g, parcels);
        for (let i = 0; i < 6; i++) {
          const { quotes } = E.refiQuotes(g, parcels, li.bbl);
          const open = (quotes ?? []).find((x) => (x.maxProceeds ?? 0) > 0);
          if (!open) break;
          const rr = E.refinance(g, parcels, li.bbl, open.id, 1);
          if (rr.err) break;
          g = rr.s; n++;
        }
        per = n ? (E.netWorth(g, parcels) - before) / n : NaN;
      }
    }
    loops.push({ name: "refinance, again and again", n, per });
  }

  for (const l of loops) {
    lines.push(`${l.name.padEnd(32)} ${String(l.n).padStart(3)} cycles   net worth per cycle: `
      + `${Number.isFinite(l.per) ? (l.per >= 0 ? "+" : "") + M(l.per) : "n/a — the loop does not run"}`);
  }
  const pumps = loops.filter((l) => Number.isFinite(l.per) && l.per > 1000);
  lines.push(``);
  lines.push(pumps.length
    ? `${pumps.length} loop(s) END RICHER THAN THEY STARTED: ${pumps.map((p) => p.name).join(", ")}`
    : `every loop costs money to run. There is no free round trip in this economy.`);
  report(29, "THE MONEY PUMP", pumps.length ? "BROKEN" : "WIRED", lines);
}

// ===========================================================================
// 30. THE BOUNDS — push it until it breaks, and see what breaking looks like
// ===========================================================================
// Every number in this engine has a plausible range and the interesting
// question is what happens outside it. Not because a 40% policy rate is
// realistic, but because the code that survives one is the code that has no
// hidden division by a thing that can be zero.
if (want(30)) {
  const lines = [];
  const base = city(CITY_SEED);
  const EXTREMES = [
    ["a 40% policy rate", (g) => { g.econ.indexRate = 40; }],
    ["ninety per cent vacant", (g) => { for (const u of USES) g.econ.cityVac[u] = 0.9; }],
    ["construction at 20x", (g) => { g.econ.costIdx = 20; }],
    ["the town half emptied", (g) => { g.econ.population = Math.max(1000, Math.round(g.econ.population * 0.5)); g.econ.jobs = Math.round(g.econ.jobs * 0.5); }],
    ["no credit at all", (g) => { g.econ.creditIdx = 0; }],
    ["rents at a tenth", (g) => { for (const u of USES) g.econ.rentIdx[u] *= 0.1; }],
    ["the player owns nothing and owes nothing", (g) => { g.cash = 0; }],
  ];
  let broke = 0;
  for (const [label, inject] of EXTREMES) {
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(MARKET_SEEDS[0], parcels), parcels, base.bbls);
    for (let m = 0; m < 12; m++) g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
    let err = null, bad = 0;
    try {
      for (let m = 0; m < 60; m++) {
        inject(g);
        g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
        if (m % 12 === 0) bad += scan(`bound:${label}`, g, parcels);
      }
    } catch (e) { err = e.message; }
    if (err || bad) broke++;
    lines.push(`${label.padEnd(42)} ${err ? `THREW: ${err}` : bad ? `${bad} numerical problems` : `survived 5 years`}`
      + (err ? "" : ` · vac ${pct(g.econ.cityVac.office)} · rent ${g.econ.rentIdx.office.toFixed(0)} · pop ${g.econ.population}`));
  }
  lines.push(``);
  lines.push(`${EXTREMES.length - broke} of ${EXTREMES.length} extremes ran five years without throwing or producing a number that is not a number`);
  report(30, "THE BOUNDS", broke === 0 ? "WIRED" : broke <= 1 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// 31. THE FOUR QUOTES AGREE — appraisal, tape, mark and loan
// ===========================================================================
// The engine prices the same building in four places: assetValue for a parcel
// nobody owns, holdingValue for one somebody does, the ask on the tape, and
// the proceeds a lender will advance. They are allowed to differ — that is the
// bid-ask spread and the advance rate doing their jobs — but they have to move
// TOGETHER, and no lender may advance more than the building is worth. Where
// they disagree systematically, somebody can stand between two of them and
// take the difference forever.
if (want(31)) {
  const lines = [];
  const base = city(CITY_SEED);
  const parcels = JSON.parse(JSON.stringify(base.parcels));
  let g = E.firstListings(newGame(MARKET_SEEDS[0], parcels), parcels, base.bbls);
  for (let m = 0; m < 120; m++) g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
  const pairs = [], overAdvance = [], binds = {};
  let n = 0;
  for (const b of base.bbls) {
    if (n >= 400) break;
    const rec = E.resolveRec(parcels, g, b);
    if (!rec || rec.class === "land" || !rec.bldgArea) continue;
    n++;
    const cond = E.initialCondition(rec);
    const appraisal = E.assetValue(rec, g.econ, cond);
    if (!(appraisal > 0)) continue;
    const q = E.buyQuote(g, parcels, b, Math.round(appraisal), "senior", 1);
    const debt = q?.principal ?? 0;
    const noi = E.noiAfterTaxYr(rec, g.econ, cond, appraisal);
    binds[q?.bind ?? "?"] = (binds[q?.bind ?? "?"] ?? 0) + 1;
    pairs.push({ appraisal, debt, noi });
    if (debt > appraisal) overAdvance.push({ b, appraisal, debt });
  }
  // RANK correlation, not Pearson. The advance is the SMALLEST of three tests —
  // an advance rate, a coverage ratio and a debt yield — so it is a kinked
  // function of value by construction and a linear correlation across four
  // hundred unlike buildings measures the kink, not the agreement. What has to
  // hold is the ORDER: a building an appraiser ranks above another must not
  // borrow less than it, other things equal.
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const corr = (xs, ys) => {
    const mx = mean(xs), my = mean(ys);
    let a = 0, bb = 0, cc = 0;
    for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; bb += dx * dx; cc += dy * dy; }
    return a / Math.max(1e-9, Math.sqrt(bb * cc));
  };
  const spearman = (xs, ys) => corr(rank(xs), rank(ys));
  const rLoan = pairs.length > 2 ? spearman(pairs.map((p) => p.appraisal), pairs.map((p) => p.debt)) : NaN;
  const rNoi = pairs.length > 2 ? spearman(pairs.map((p) => p.noi), pairs.map((p) => p.debt)) : NaN;
  const rVal = pairs.length > 2 ? spearman(pairs.map((p) => p.noi), pairs.map((p) => p.appraisal)) : NaN;
  const ltvs = pairs.filter((p) => p.debt > 0).map((p) => p.debt / p.appraisal);
  // and the tape against the appraisal, on live listings
  const asks = g.listings.map((l) => {
    const rec = E.resolveRec(parcels, g, l.bbl);
    if (!rec) return null;
    const v = rec.class === "land" ? E.landValue(rec, g.econ) : E.assetValue(rec, g.econ, E.initialCondition(rec));
    return v > 0 ? l.ask / v : null;
  }).filter((x) => x !== null);
  lines.push(`sampled ${pairs.length} standing buildings at year 10`);
  lines.push(`rank corr(appraisal, senior advance):  ${rLoan.toFixed(3)}   (need >= 0.6 — the desk and the appraiser read the same building)`);
  lines.push(`rank corr(income,    senior advance):  ${rNoi.toFixed(3)}   (a loan is sized on income, so this should be the tighter of the two)`);
  lines.push(`rank corr(income,    appraisal):       ${rVal.toFixed(3)}`);
  lines.push(`advance rate: median ${pct(med(ltvs))}, worst ${pct(Math.max(...ltvs, 0))}   (nothing may exceed 100% of appraisal)`);
  lines.push(`lenders advancing MORE than the building is worth: ${overAdvance.length}`);
  lines.push(`which test actually capped the loan: ${Object.entries(binds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  lines.push(`   (a desk where one test binds every time is a desk with two decorative tests)`);
  lines.push(`the tape against the appraisal: median ${med(asks).toFixed(2)}x over ${asks.length} live listings`);
  const liveBinds = Object.entries(binds).filter(([k, v]) => k !== "?" && k !== "none" && v > 0).length;
  const ok = [rLoan >= 0.6, overAdvance.length === 0, Math.abs(med(asks) - 1) <= 0.15, liveBinds >= 2].filter(Boolean).length;
  report(31, "THE FOUR QUOTES AGREE", ok >= 4 ? "WIRED" : ok >= 3 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// 34. THE LONG TAIL OF SEEDS — is the outcome a distribution or a coin flip?
// ===========================================================================
// One competent strategy, played identically across every seed available. A
// game whose result is decided by the draw rather than the play is a lottery
// with extra steps; one whose result is identical in every world has no
// weather in it. What is wanted is a spread you can see and a floor you can
// stand on.
if (want(34)) {
  const lines = [];
  const outs = MARKET_SEEDS.map((ms) => playStrategy("core", ms));
  const real = outs.map((o) => o.nw / Math.max(0.1, o.cpi)).sort((a, b) => a - b);
  const p = (x) => real[Math.min(real.length - 1, Math.floor(x * real.length))];
  lines.push(`${real.length} worlds, one core strategy, ${MONTHS / 12} years each:`);
  lines.push(`   worst ${M(real[0])}   p25 ${M(p(0.25))}   median ${M(med(real))}   p75 ${M(p(0.75))}   best ${M(real[real.length - 1])}`);
  lines.push(`   wipeouts: ${outs.filter((o) => o.nw < 1e6).length} of ${outs.length}   ·   median holdings ${med(outs.map((o) => o.holdings))}`);
  const ratio = p(0.75) / Math.max(1, p(0.25));
  lines.push(``);
  lines.push(`p75 / p25: ${ratio.toFixed(2)}x   (need 1.3x to 12x — narrower is a world with no weather, wider is a lottery)`);
  const survives = outs.filter((o) => o.nw >= 1e6).length / outs.length;
  lines.push(`share of worlds a competent operator survives: ${pct(survives)}   (need >= 60%)`);
  const ok = [ratio >= 1.3 && ratio <= 12, survives >= 0.6].filter(Boolean).length;
  report(34, "THE LONG TAIL OF SEEDS", ok === 2 ? "WIRED" : ok === 1 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// 35. THE HUMAN CLOCK — how much of a fifty-year run is a decision?
// ===========================================================================
// The engine can simulate six hundred months. A person cannot play six hundred
// months of nothing. This counts, month by month, whether ANY meaningful move
// was on the table: a letter to answer, a listing worth buying, a site that
// pencils, a loan worth refinancing. Months with none of those are months the
// game is asking the player to press Next, and a game that is mostly Next is a
// spreadsheet with a coastline.
if (want(35)) {
  const lines = [];
  const rows = [];
  for (const ms of MARKET_SEEDS.slice(0, 3)) {
    const base = city(CITY_SEED);
    const parcels = JSON.parse(JSON.stringify(base.parcels));
    let g = E.firstListings(newGame(ms, parcels), parcels, base.bbls);
    let live = 0, lois = 0, buys = 0, sites = 0, dead = 0, run = 0, worstRun = 0;
    for (let m = 0; m < MONTHS; m++) {
      g = E.advanceQuarter(g, parcels, base.bbls, base.adjacency);
      // COUNT THE LETTERS BEFORE ANSWERING THEM. Reading g.lois after
      // leaseAtMarket has run counts the ones the bot failed to deal with,
      // which is the opposite of the question and reads as a flat zero.
      const hasLoi = g.lois.length > 0;
      g = leaseAtMarket(E, g, parcels);
      // buy something occasionally so the run is a real portfolio, not an empty desk
      if (m % 18 === 0) {
        for (const li of [...g.listings].slice(0, 5)) {
          const rec = E.resolveRec(parcels, g, li.bbl);
          if (!rec || rec.class === "land" || g.holdings[li.bbl]) continue;
          if (li.ask > E.assetValue(rec, g.econ, E.initialCondition(rec))) continue;
          const r = E.executePurchase(g, parcels, li.bbl, li.ask, "senior", false, 1);
          if (!r.err) { g = r.s; break; }
        }
      }
      const buyable = g.listings.some((l) => {
        const rec = E.resolveRec(parcels, g, l.bbl);
        if (!rec || rec.class === "land" || g.holdings[l.bbl]) return false;
        return l.ask <= E.assetValue(rec, g.econ, E.initialCondition(rec)) * 0.98 && l.ask <= g.cash + E.locAvailable(g, parcels);
      });
      const pencils = g.listings.some((l) => {
        const rec = E.resolveRec(parcels, g, l.bbl);
        return rec?.class === "land" && (bestPlan(g, parcels, l.bbl)?.spread ?? -9) >= DEV_HURDLE_PP;
      });
      if (hasLoi) lois++;
      if (buyable) buys++;
      if (pencils) sites++;
      if (hasLoi || buyable || pencils) { live++; run = 0; }
      else { dead++; run++; worstRun = Math.max(worstRun, run); }
    }
    rows.push({ ms, live, lois, buys, sites, dead, worstRun });
  }
  lines.push(`                    months with a letter   a buy   a site that pencils   ANY move   longest dead stretch`);
  for (const r of rows) {
    lines.push(`seed ${String(r.ms).padEnd(8)}    ${String(r.lois).padEnd(21)} ${String(r.buys).padEnd(7)} ${String(r.sites).padEnd(21)} `
      + `${String(r.live).padEnd(10)} ${r.worstRun} months`);
  }
  const liveShare = med(rows.map((r) => r.live)) / MONTHS;
  const worst = Math.max(...rows.map((r) => r.worstRun));
  lines.push(``);
  lines.push(`share of a fifty-year run with something on the table: ${pct(liveShare)}   (need >= 60%)`);
  lines.push(`longest stretch with nothing at all: ${worst} months   (need <= 18 — a player should never press Next for two years)`);
  const ok = [liveShare >= 0.6, worst <= 18].filter(Boolean).length;
  report(35, "THE HUMAN CLOCK", ok === 2 ? "WIRED" : ok === 1 ? "WEAK" : "BROKEN", lines);
}

// ===========================================================================
// 32. NUMERICAL HYGIENE — the scan that rode along with everything above
// ===========================================================================
if (HYGIENE.length || want(32)) {
  const lines = HYGIENE.length
    ? [`${HYGIENE.length} sampled states carried a problem:`,
       ...HYGIENE.slice(0, 14).map((h) => `${h.tag} @ month ${h.month}: ${h.issues.join(" · ")}`)]
    : [`no NaN, no Infinity, no negative rents or stocks, no occupancy outside 0-100%, no occupied-exceeds-stock, across every state sampled in this run.`];
  report(32, "NUMERICAL HYGIENE", HYGIENE.length ? "BROKEN" : "WIRED", lines);
}

// ---------------------------------------------------------------------------
{
  say(`# ECONOMY STRESS TEST — Broadway & Wall`);
  say(``);
  say(`\`pnpm stress\` · ${MARKET_SEEDS.length} market seeds × ${MONTHS / 12} sim years · city seed ${CITY_SEED}.`);
  say(``);
  say(`Companion to ECONOMY_AUDIT.md. That report asks whether a shock in one place moves the right things elsewhere. This one asks whether the world exists without the player, whether the player exists to the world, whether there is a dominant strategy, and whether the engine survives being pushed to its bounds.`);
  say(``);
  for (const r of RESULTS) {
    say(`## ${r.id}. ${r.title} — **${r.verdict}**`);
    say(``);
    say("```");
    for (const l of r.lines) say(l);
    say("```");
    say(``);
  }
  // A PARTIAL RUN MUST NOT OVERWRITE THE WHOLE REPORT. `--only=B` used to
  // rewrite ECONOMY_STRESS.md containing section B and nothing else, so the
  // committed report silently lost every other check — and since investigating
  // one section is exactly when you reach for --only, the file was at its most
  // misleading precisely when somebody was working on it. The report on disk
  // is a record of a FULL battery or it is not a record.
  if (only.length) {
    log(`\n--only= run: ${OUT} left alone. Run \`pnpm stress\` for the full battery to rewrite it.`);
    process.exit(0);
  }
  writeFileSync(OUT, md.join("\n") + "\n");
  log(`\nwrote ${OUT}`);
}
