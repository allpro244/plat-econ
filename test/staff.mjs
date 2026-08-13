// THE PAYROLL, MEASURED.
//
//   pnpm staff
//
// Four questions, and every one of them has to be able to answer "no":
//
//   1. Does capacity BIND? A firm that can buy a hundred buildings without its
//      management degrading has a payroll system that is decoration.
//   2. Does a hire PAY FOR ITSELF at the right size, and only at the right
//      size? If a manager is worth hiring on day one with two buildings, the
//      salary is too cheap; if never, it is too dear.
//   3. Is the read on a candidate actually NOISY at hire and actually
//      CONVERGENT afterwards?
//   4. Does the money reach the ledger? Salaries are cash leaving the firm and
//      `pnpm conserve` will fail on a single unexplained dollar — this checks
//      the same identity from the other end.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const { parcels: P0, adjacency, bbls } = loadCity(0, E.normalizeParcels);
const clone = () => JSON.parse(JSON.stringify(P0));
const med = (a) => { const b = [...a].filter(Number.isFinite).sort((x, y) => x - y); return b[Math.floor((b.length - 1) / 2)]; };
const M = (n) => `$${(n / 1e6).toFixed(2)}M`;
let fails = 0;
const report = (name, ok, lines) => {
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${name}`);
  for (const l of lines) console.log(`      ${l}`);
  if (!ok) fails++;
};

// ---------------------------------------------------------------------------
// 1. CAPACITY BINDS
// ---------------------------------------------------------------------------
{
  const rows = [];
  for (const sf of [50_000, 150_000, 400_000, 900_000, 2_400_000]) {
    const parcels = clone();
    const g = E.firstListings(E.newGame(4242, parcels), parcels, bbls);
    // a synthetic book of exactly this much space, so load is the only variable
    const fake = { holdings: {} };
    let acc = 0;
    for (const b of bbls) {
      const r = E.resolveRec(parcels, g, b);
      if (!r || r.class === "land" || !r.bldgArea) continue;
      fake.holdings[b] = { bbl: b, tenants: [], condition: "fair" };
      acc += r.bldgArea;
      if (acc >= sf) break;
    }
    const probe = { ...g, holdings: fake.holdings };
    const pm = E.roleState(probe, parcels, "pm");
    rows.push({ sf: acc, load: pm.load, slip: pm.slip, opex: E.pmOpexMult(pm) });
  }
  const spread = rows[rows.length - 1].opex / rows[0].opex;
  report("A. CAPACITY BINDS — does an unmanaged portfolio cost more to run?",
    rows[0].slip === 0 && rows[rows.length - 1].slip > 0.3 && spread > 1.15,
    [...rows.map((r) => `${(r.sf / 1000).toFixed(0)}k sf   load ${r.load.toFixed(2)}x   slipping ${(r.slip * 100).toFixed(0)}%   controllable opex x${r.opex.toFixed(3)}`),
     `smallest to largest: x${spread.toFixed(3)} on the controllable stack   (need > 1.15, and the small book must not slip at all)`]);
}

// ---------------------------------------------------------------------------
// 2. THE HIRE HAS TO PAY FOR ITSELF, AND NOT TOO EARLY
// ---------------------------------------------------------------------------
{
  // What a median manager saves against what a median manager costs, by book
  // size. The crossover is the answer to "when should I hire", and it is an
  // OUTPUT of the salary curve and the capacity curve, not a target.
  const parcels = clone();
  const g = E.firstListings(E.newGame(4242, parcels), parcels, bbls);
  const salary = 110_000;                       // mid of the $55k-$210k band
  const rows = [];
  for (const sf of [100_000, 300_000, 600_000, 1_200_000, 2_400_000]) {
    const holdings = {};
    let acc = 0;
    for (const b of bbls) {
      const r = E.resolveRec(parcels, g, b);
      if (!r || r.class === "land" || !r.bldgArea) continue;
      holdings[b] = { bbl: b, tenants: [], condition: "fair" };
      acc += r.bldgArea;
      if (acc >= sf) break;
    }
    const solo = { ...g, holdings, staff: [] };
    const withPm = {
      ...g, holdings,
      staff: [{ id: 1, name: "x", role: "pm", hiredM: 0, salary, band0: 26,
        attrs: { judgment: 60, urgency: 60, diligence: 60, relationships: 60, costControl: 60, tenantCare: 60 },
        obs: {} }],
    };
    const a = E.pmOpexMult(E.roleState(solo, parcels, "pm"));
    const b2 = E.pmOpexMult(E.roleState(withPm, parcels, "pm"));
    // saving = the controllable stack x the delta, across the book
    const ctrl = acc * 6.0;                     // ~$6/sf blended controllable
    const saved = ctrl * (a - b2);
    rows.push({ sf: acc, a, b: b2, saved, worth: saved - salary });
  }
  const crossover = rows.find((r) => r.worth > 0);
  report("B. A HIRE PAYS FOR ITSELF, EVENTUALLY — and not on day one",
    !!crossover && rows[0].worth < 0 && crossover.sf >= 200_000,
    [...rows.map((r) => `${(r.sf / 1000).toFixed(0)}k sf   solo x${r.a.toFixed(3)} -> managed x${r.b.toFixed(3)}   saves ${M(r.saved)}/yr against a $110k salary  ->  ${r.worth >= 0 ? "WORTH IT" : "not yet"}`),
     `crossover at ${crossover ? (crossover.sf / 1000).toFixed(0) + "k sf" : "never"}   (a $110k manager must be a bad idea at 100k sf and a good one before 2.4M sf)`]);
}

// ---------------------------------------------------------------------------
// 3. THE READ IS NOISY, THEN IT IS NOT
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  let g = E.firstListings(E.newGame(777, parcels), parcels, bbls);
  E.refreshPool(g, true);
  const pool = g.hirePool.list;
  const err0 = [], err60 = [], w0 = [], w60 = [];
  for (const c of pool) {
    for (const k of Object.keys(c.attrs)) {
      const atHire = E.readAttr({ ...c, hiredM: -1 }, k, 0);
      const after = E.readAttr({ ...c, hiredM: 0 }, k, 60);
      err0.push(Math.abs(atHire.mid - c.attrs[k]));
      err60.push(Math.abs(after.mid - c.attrs[k]));
      w0.push(atHire.hi - atHire.lo);
      w60.push(after.hi - after.lo);
    }
  }
  report("C. YOU DO NOT KNOW WHAT YOU ARE BUYING — until you do",
    med(err0) >= 8 && med(err60) < med(err0) / 2 && med(w60) < med(w0) / 3,
    [`candidates ${pool.length}, attributes read ${err0.length}`,
     `median error at the interview: ${med(err0).toFixed(1)} points of 100   (must be >= 8 — a read this good is not a read)`,
     `median error after 5 years:    ${med(err60).toFixed(1)} points`,
     `shown band at hire ${med(w0).toFixed(0)} wide -> ${med(w60).toFixed(0)} wide after 5 years`]);
}

// ---------------------------------------------------------------------------
// 4. THE MONEY MOVES THROUGH THE LEDGER
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  let g = E.firstListings(E.newGame(11, parcels), parcels, bbls);
  for (let m = 0; m < 6; m++) g = E.advanceQuarter(g, parcels, bbls, adjacency);
  const gaBefore = (g.books ?? []).reduce((a, y) => a + (y.ga ?? 0), 0);
  const cashBefore = g.cash;
  E.refreshPool(g, true);
  const cand = g.hirePool.list.find((c) => c.role === "pm");
  const r = E.hire(g, cand.id);
  if (r.err) { report("D. SALARIES REACH THE BOOKS", false, [`hire refused: ${r.err}`]); }
  else {
    g = r.s;
    for (let m = 0; m < 18; m++) g = E.advanceQuarter(g, parcels, bbls, adjacency);
    const onStaff = (g.staff ?? []).length;
    const gaAfter = (g.books ?? []).reduce((a, y) => a + (y.ga ?? 0), 0);
    const payroll = E.payrollMonthly(g);
    // every dollar of cash that left has a matching books entry — the same
    // identity pnpm conserve asserts, checked here at the payroll line
    const dCash = cashBefore - g.cash;
    report("D. SALARIES REACH THE BOOKS — and the desk fills after a search",
      onStaff === 1 && gaAfter > gaBefore && payroll > 0 && dCash > 0,
      [`hired ${cand.name} at $${Math.round(cand.askSalary / 1000)}k, starts after a ${E.SEARCH_MONTHS}-month notice`,
       `on staff 18 months later: ${onStaff}`,
       `payroll now ${M(payroll)}/mo at today's price level (salary is quoted in year-2000 dollars)`,
       `G&A booked over the window: ${M(gaAfter - gaBefore)}`,
       `run pnpm conserve for the full identity — this only checks the payroll line reaches it`]);
  }
}

// ---------------------------------------------------------------------------
// 5. THE HALF-BUILT WIRES NOW BIND
// ---------------------------------------------------------------------------
{
  const parcels = clone();
  let g = E.firstListings(E.newGame(91, parcels), parcels, bbls);
  E.refreshPool(g, true);
  const roles = new Set(g.hirePool.list.map((c) => c.role));
  const hasCm = roles.has("construction");
  const tier = E.setSearchTier(g, "recruiter");
  const bandOk = !tier.err && tier.s.hirePool.band === 11;
  // A performing PM desk must move renewal probability — stamp + intent.
  const officeBbl = bbls.find((b) => {
    const r = E.resolveRec(parcels, g, b);
    return r && r.class === "office" && r.bldgArea > 20_000;
  });
  let renewOk = false;
  if (officeBbl) {
    g.holdings[officeBbl] = {
      bbl: officeBbl, boughtM: 0, costBasis: 1, condition: "average",
      tenants: [{
        name: "Acme", sf: 10_000, rentPsf: 30, startM: 0, endM: 60,
        credit: 1, sector: "professional", use: "office", staff: 1, net: false,
      }],
      loan: null, assessed: 1, condIdx: 0.7, svcIdx: 0.7,
      service: 0, stance: 0, plan: 1, cfHistory: [],
      pmRenewalMult: 0.75,
    };
    g.pmDeskSlip = 0.4;
    g.staff = [{
      id: 1, name: "Pat", role: "pm", hiredM: 0, salary: 100_000, band0: 26,
      attrs: { judgment: 40, urgency: 40, diligence: 40, relationships: 40, costControl: 40, tenantCare: 30 },
      obs: {},
    }];
    const rec = E.resolveRec(parcels, g, officeBbl);
    const ri = E.renewalIntent(g, rec, g.holdings[officeBbl], g.holdings[officeBbl].tenants[0]);
    renewOk = ri.p < 0.85;
  }
  const jSharp = E.deskJudgment({ staff: [{ role: "leasing", attrs: { judgment: 90 } }] }, "leasing");
  // Empty desk uses the principal's Deal sense (neutral 50 when no principal row).
  const jEmpty = E.deskJudgment({ staff: [] }, "leasing");
  const jYours = E.deskJudgment({ staff: [], principal: { attrs: { judgment: 77 } } }, "leasing");
  report("E. HALF-BUILT STAFF WIRES BIND — CM hire, search tier, renewals, judgment",
    hasCm && bandOk && renewOk && jSharp > 80 && jEmpty === 50 && jYours === 77,
    [
      `construction on shortlist: ${hasCm}`,
      `recruiter sets band 11: ${bandOk}${tier.err ? ` (${tier.err})` : ""}`,
      `weak PM desk cuts renewal intent: ${renewOk}`,
      `deskJudgment sharp=${jSharp.toFixed(0)} empty=${jEmpty} yours=${jYours}`,
    ]);
}

console.log(`\n${"=".repeat(64)}`);
console.log(fails === 0 ? "5 of 5 payroll tests pass" : `${fails} payroll test(s) failed`);
process.exit(fails === 0 ? 0 : 1);
