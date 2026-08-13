// WHEN THE CONSTRUCTION LENDER IS SEIZED, DOES THE JOB ACTUALLY STOP?
//
// A bank failure is rare by design — three in a fifty-year town — and it has
// to catch a job in flight to reach this code at all. Waiting for that to
// happen by chance is not a test, it is a lottery, and a test that only
// sometimes runs is a test that cannot fail on the day it matters. So this
// forces the seizure: it puts a real job in the ground with a real facility
// from a real desk, closes that desk, and then asks the four questions that
// the borrower's survival actually turns on.
//
//   node test/repudiate.mjs
//
// N. the draw is NOT stubbed. The engine's shared PRNG decides how long the
// replacement paperwork takes and which desks are quoting that month, exactly
// as it would in play. What is forced is the seizure, and only the seizure.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const m$ = (n) => "$" + (n / 1e6).toFixed(2) + "M";
// HOW LONG TO RUN BEFORE CLOSING THE BANK, and why it is not a round number.
//
// The funding order on a construction job is prefunded equity, then the rest
// of the equity, then the bank. On a 26-floor office the loan does not advance
// a dollar until month 16 — so a fixture that seized the desk at month 8 was
// killing a facility that had never funded anything, and three of its
// assertions passed against a balance of exactly zero. A test that reads PASS
// off an empty number is not measuring the thing in its name. This lands the
// seizure in the middle of the draw period, with the job delivering at m32.
const PRERUN = 16;
let failed = 0;
const ok = (name, pass, detail) => {
  if (!pass) failed++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

// A SITE, A CRANE, AND A NAMED DESK ---------------------------------------
// Cordage is the debt fund: it quotes through the cycle, so picking it as the
// original lender guarantees the job closes, and it is NOT one of the two
// bank desks — which means when we close it, the other two are still there to
// refinance. That is the interesting case. The uninteresting one (nobody left
// quoting) is checked separately at the bottom.
function siteWithAJob(runIndex, lender) {
  const { parcels, bbls, adjacency, seed } = loadCity(runIndex, E.normalizeParcels);
  let g = E.newGame(seed, parcels);
  g = E.firstListings(g, parcels, bbls);
  g.cash = 400_000_000;

  // Any decent-sized vacant lot will do. Buy it outright, then build on it.
  // A MIDDLING LOT, ON PURPOSE. Sorting by size and taking the top picked the
  // largest site in the county and produced a billion-dollar job — a fixture
  // so far outside normal play that nothing it proves would transfer.
  const lots = bbls
    .map((b) => E.resolveRec(parcels, g, b))
    .filter((r) => r && r.class === "land" && r.lotArea > 9_000 && r.lotArea < 22_000)
    .sort((a, b) => a.bbl.localeCompare(b.bbl));
  if (!lots.length) return null;

  // Bought through the real purchase path, all cash — a hand-rolled holding
  // is missing half its fields and blows up three ticks later in sim.ts.
  for (const rec of lots.slice(0, 40)) {
    const price = Math.max(500_000, Math.round(E.landValue(rec, g.econ)));
    const bought = E.executePurchase(g, parcels, rec.bbl, price, "cash", false, 1);
    if (bought.err || !bought.s.holdings[rec.bbl]) continue;
    const r = E.startDevelopment(bought.s, parcels, rec.bbl, "office", 26, 0.6, "gmp", undefined, undefined, lender);
    if (!r.err) return { g: r.s, parcels, bbls, adjacency, bbl: rec.bbl };
    g = bought.s;
    delete g.holdings[rec.bbl];
  }
  return null;
}

// PUT THE DESK UNDER AND WAIT FOR THE EXAMINERS.
//
// The seizure itself is not deterministic and should not be: a desk with no
// capital left fails on a 35% roll each month, which is what makes it a Friday
// afternoon rather than a countdown. So this holds the capital under water and
// runs the real tickLenders path until it closes, rather than reaching in and
// setting failedM by hand — the wiring between "insolvent" and "repudiated" is
// exactly what is under test, and stubbing it would test nothing.
function seizeAndTick(g, name, parcels, bbls, adjacency, maxMonths = 12) {
  for (let i = 0; i < maxMonths; i++) {
    const l = (g.lenders ?? []).find((x) => x.name === name);
    if (!l) return { g, ok: false };
    if (l.failedM !== undefined) return { g, ok: true };
    // Capital of -1 is not insolvent enough: tickLenders adds a month of
    // interest income before it checks, and on a book this size that lifted
    // the desk straight back over zero every single tick — twenty-four months
    // of "critically insolvent" and never once seized. Half the book gone bad
    // and negative capital of the book's own size is a desk that cannot earn
    // its way out in a month, which is the actual precondition for a Friday.
    l.capital = -Math.abs(l.book);
    l.delinquent = 0.5;
    g = E.advanceQuarter(g, parcels, bbls, adjacency);
    g.insolventMs = 0; g.gameOver = null;
  }
  const l = (g.lenders ?? []).find((x) => x.name === name);
  return { g, ok: l?.failedM !== undefined };
}

console.log("\nREPUDIATED COMMITMENTS — a receiver does not advance\n");

// ---------------------------------------------------------------------------
// N. THE JOB STOPS FUNDING, AND THE BILL LANDS ON THE BORROWER.
// ---------------------------------------------------------------------------
{
  const site = siteWithAJob(0, "Cordage Debt Partners");
  if (!site) {
    ok("a job could be started at all", false, "no buildable vacant lot found — the fixture is broken, not the engine");
  } else {
    let { g, parcels, bbls, adjacency, bbl } = site;
    // Run a year so the S-curve is genuinely mid-job and there is real undrawn
    // room to kill. A job that has drawn everything is not harmed by this.
    for (let i = 0; i < PRERUN; i++) {
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      g.insolventMs = 0; g.gameOver = null;
    }
    const before = g.developments[bbl];
    const roomBefore = before ? Math.max(0, before.commitment - before.drawn) : 0;
    ok("the job is mid-draw with room still in the facility",
      !!before && roomBefore > 0 && before.drawn > 0 && before.loanBalance > 0,
      before ? `${m$(before.drawn)} drawn, ${m$(roomBefore)} still undrawn`
             : "the job vanished — PRERUN is past delivery and this file measures nothing");

    if (before && roomBefore > 0 && before.drawn > 0) {
      const seized = seizeAndTick(g, "Cordage Debt Partners", parcels, bbls, adjacency);
      g = seized.g;
      ok("the examiners closed the desk", seized.ok, seized.ok ? "" : "twelve months insolvent and never seized");
      const d = g.developments[bbl];
      ok("the receiver repudiated the undrawn commitment", !!d && d.repudiatedM !== undefined,
        d ? (d.repudiatedM !== undefined ? `stamped at month ${d.repudiatedM}` : "the job kept drawing as if nothing happened") : "the job vanished");
      ok("a replacement was given time to paper, not granted instantly",
        !!d && d.replaceM !== undefined && d.replaceM > d.repudiatedM,
        d?.replaceM !== undefined ? `${d.replaceM - d.repudiatedM} months of paperwork` : "no wait at all");

      if (d && d.repudiatedM !== undefined) {
        // Freeze the replacement so the next assertions measure the dead
        // period rather than the rescue. Pushing replaceM out is the same
        // thing as the paperwork taking longer, which is legal in the model.
        const drawn0 = d.drawn;
        const bal0 = d.loanBalance;
        d.replaceM = g.month + 240;
        const cashA = g.cash;
        g = E.advanceQuarter(g, parcels, bbls, adjacency);
        const e = g.developments[bbl];
        ok("not one further dollar was advanced", !!e && e.drawn === drawn0 && drawn0 > 0,
          e ? `drawn ${m$(drawn0)} -> ${m$(e.drawn)}` : "the job vanished");
        ok("the interest stopped capitalising and started costing cash",
          !!e && bal0 > 0 && e.loanBalance === bal0 && g.cash < cashA,
          e ? `balance ${m$(bal0)} -> ${m$(e.loanBalance)}, cash ${m$(cashA - g.cash)} out` : "");
        // The work in place still has to be paid for, and now it is equity.
        ok("work in place became the borrower's problem", g.cash < cashA,
          `${m$(cashA - g.cash)} left the account in one month with no building to show for it`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// N. AND THE WAY OUT EXISTS. A market with two live bank desks refinances a
// half-built office building; it does not simply strand it forever.
// ---------------------------------------------------------------------------
{
  const site = siteWithAJob(0, "Cordage Debt Partners");
  if (site) {
    let { g, parcels, bbls, adjacency, bbl } = site;
    for (let i = 0; i < PRERUN; i++) {
      g = E.advanceQuarter(g, parcels, bbls, adjacency);
      g.insolventMs = 0; g.gameOver = null;
    }
    if (g.developments[bbl]) {
      g = seizeAndTick(g, "Cordage Debt Partners", parcels, bbls, adjacency).g;
      const d0 = g.developments[bbl];
      const rate0 = d0?.ratePct ?? 0;
      // Guard against the false pass this test gave on its first run: if the
      // job was never repudiated, "another desk refinanced it" reads PASS on
      // the very first loop iteration and means nothing at all.
      ok("the job under test was actually repudiated", !!d0 && d0.repudiatedM !== undefined,
        d0?.repudiatedM === undefined ? "nothing to refinance — the rest of this block is meaningless" : "");
      let out = null;
      // Give it a year and a half — longer than the outside of the paperwork
      // draw — and see whether any desk in town takes the job out.
      for (let i = 0; i < 18 && g.developments[bbl]; i++) {
        g = E.advanceQuarter(g, parcels, bbls, adjacency);
        g.insolventMs = 0; g.gameOver = null;
        const d = g.developments[bbl];
        if (d && d.repudiatedM === undefined) { out = d; break; }
      }
      ok("another desk refinanced the job", !!out && d0?.repudiatedM !== undefined,
        out ? `${out.lender} at ${out.ratePct.toFixed(2)}%, was ${rate0.toFixed(2)}%`
            : "eighteen months and nobody would touch it — check whether any desk was open");
      if (out) {
        // THE FIRST VERSION OF THIS ASSERTED THE RESCUE MUST COST MORE, and it
        // failed against a correct engine. The job started with the debt fund,
        // which is the most expensive desk in town by design, so a bank taking
        // it out at a lower coupon is right — the developer is not being
        // rewarded, they are being moved off fund pricing onto bank pricing
        // and paying points and a season of dead carry for the privilege. What
        // is actually worth asserting is that the new desk quoted its own
        // market, not a bailout rate.
        ok("the rescue was quoted at the desk's own market, not a special rate",
          out.ratePct >= g.econ.indexRate,
          `${out.lender} at ${out.ratePct.toFixed(2)}% against an index of ${g.econ.indexRate.toFixed(2)}% (was ${rate0.toFixed(2)}% at the fund)`);
        ok("the new facility retired the receiver, not the borrower's cash",
          out.drawn > 0 && Math.abs(out.drawn - out.loanBalance) < 2,
          `first draw ${m$(out.drawn)} against a balance of ${m$(out.loanBalance)}`);
        // A facility that pays points, retires the receiver and still leaves
        // the building unfinished is one nobody signs. This is the sources-
        // and-uses test, checked from the outside.
        const room = out.commitment - out.interestReserve - out.drawn;
        const left = Math.max(0, out.costTotal - (out.leaseUpReserve ?? 0)) * (1 - (g.month - out.startM) / Math.max(1, out.deliverM - out.startM))
          + (out.leaseUpReserve ?? 0);
        ok("and it left enough in it to actually finish the building",
          room + Math.max(0, out.equityBudget - out.equitySpent) + (out.equityPrefunded ?? 0) + Math.max(0, g.cash) >= left,
          `${m$(room)} of construction room against roughly ${m$(left)} still to spend`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// N. THE LEDGER STILL BALANCES THROUGH ALL OF IT.
// ---------------------------------------------------------------------------
// Repudiation moves money three new ways — cash interest, capital calls on
// work in place, and a lease-up reserve that is now only partly fundable — and
// pnpm conserve is the only thing in the repo that can see a payment nobody
// booked. This is that check, run on the seized fixture specifically, because
// conserve's own runs will almost never contain a repudiation.
{
  const site = siteWithAJob(0, "Cordage Debt Partners");
  if (site) {
    let { g, parcels, bbls, adjacency, bbl } = site;
    for (let i = 0; i < PRERUN; i++) { g = E.advanceQuarter(g, parcels, bbls, adjacency); g.insolventMs = 0; g.gameOver = null; }
    g = seizeAndTick(g, "Cordage Debt Partners", parcels, bbls, adjacency).g;
    const cash0 = g.cash;
    const dep0 = Object.values(g.holdings).reduce((a, h) => a + (h.tenants ?? []).reduce((x, t) => x + (t.deposit ?? 0), 0), 0);
    const loc0 = g.loc?.balance ?? 0;
    const yr0 = JSON.parse(JSON.stringify(g.books ?? []));
    for (let i = 0; i < 36; i++) { g = E.advanceQuarter(g, parcels, bbls, adjacency); g.insolventMs = 0; g.gameOver = null; }
    const dep1 = Object.values(g.holdings).reduce((a, h) => a + (h.tenants ?? []).reduce((x, t) => x + (t.deposit ?? 0), 0), 0);
    const loc1 = g.loc?.balance ?? 0;

    const sum = (books, key) => books.reduce((a, e) => a + (e[key] ?? 0), 0);
    const delta = (key) => sum(g.books ?? [], key) - sum(yr0, key);
    const modelled =
      (delta("noi") + delta("sold") + delta("interest"))
      - (delta("debtSvc") + delta("leasing") + delta("capex") + delta("dev") + delta("taxes") + delta("bought") + delta("ga"))
      + (loc1 - loc0) + (dep1 - dep0);
    const actual = g.cash - cash0;
    const resid = Math.round(actual - modelled) || 0;   // || 0 kills a -0 that reads as a fault
    ok("cash reconciles to the ledger across the seizure", Math.abs(resid) < 1000,
      `${resid > 0 ? "+" : ""}$${resid.toLocaleString()} unexplained over 36 months`
      + (resid >= 1000 ? " — money APPEARING: a liability released without booking the gain"
        : resid <= -1000 ? " — money DISAPPEARING: a payment nobody booked" : ""));
  }
}

console.log(`\n${failed === 0 ? "all clear" : failed + " failing"}\n`);
process.exit(failed ? 1 : 0);
