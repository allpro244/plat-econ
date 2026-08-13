// THINGS THAT MUST NEVER BE TRUE.
//
// Every bug this game has shipped had the same shape: a number that was wrong
// but plausible. A NOI before property tax. A condition string that wasn't a
// Condition, quietly turning the whole valuation chain into NaN. An overhead
// charge that billed a small operator more than their building earned. None of
// them threw; they all just produced a number, and the number looked fine
// until a hundred playthroughs said otherwise.
//
// So this is the other kind of test. Not "does the balance feel right" — the
// audit harness answers that — but "is the state internally coherent at all".
// It is cheap enough to run on every month of a full campaign, and it is meant
// to be run that way: the point is to catch the month it first went wrong, not
// the century it finally showed up in.
//
// Nothing here is a judgement call. Every check below is either an accounting
// identity, a definitional bound, or a rule the engine states elsewhere in
// prose. If a check is arguable, it does not belong in this file.
import type { ParcelTable } from "@/data/types";
import type { BuiltClass, DevUse, GameState } from "./types";
import { resolveRec, ownedHoldingValue, ownedHoldingNoiYr, netWorth, assetValue, FAR_CEILING } from "./value";
// ONE FUNCTION, ONE MEANING. Every price in the game now appraises at the grade
// the building is actually IN — its year, moved by whoever has been running it —
// so an invariant that appraises at its BIRTH grade is measuring a different
// building from the one being sold, and flags a correctly-cheap worn asset as a
// mispriced one.
import { gradeOf } from "./rivals";
import { leasableUses, minTenancySf, useVacantSf, notReadySf, unitStatusByUse } from "./leasing";
import { mixOf, useSf } from "./mix";
import { MAX_FLOORS_BY_USE } from "./dev";
import { SECTORS } from "./market";
import { saleTaxQuote } from "./actions";
import { PROPERTY_HISTORY_CAP } from "./history";

export interface Violation {
  code: string;
  where: string;
  detail: string;
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Check one state. Returns every violation found, so a broken month reports
 * its whole story rather than the first symptom.
 */
export function checkInvariants(s: GameState, parcels: ParcelTable, prev?: GameState): Violation[] {
  const v: Violation[] = [];
  const bad = (code: string, where: string, detail: string) => v.push({ code, where, detail });

  // ---------------------------------------------------------------- the firm
  if (!fin(s.cash)) bad("nan", "firm", `cash is ${s.cash}`);
  if (!fin(s.month) || s.month < 0) bad("month", "firm", `month is ${s.month}`);
  if (!fin(s.taxesPaid) || s.taxesPaid < 0) bad("tax", "firm", `lifetime tax ${s.taxesPaid}`);
  if (s.loc) {
    if (!fin(s.loc.balance) || s.loc.balance < 0) bad("loc", "firm", `line balance ${s.loc.balance}`);
    if (s.loc.balance > s.loc.drawnTotal + 1) bad("loc", "firm", `line balance ${Math.round(s.loc.balance)} exceeds everything ever drawn ${Math.round(s.loc.drawnTotal)}`);
  }
  const nw = netWorth(s, parcels);
  if (!fin(nw)) bad("nan", "firm", "net worth is not a number");

  // ----------------------------------------------------------------- planning
  // The envelope is the land value. A multiplier that runs away, or a variance
  // on a lot you do not own, is net worth invented out of nothing.
  for (const [d, x] of Object.entries(s.zoneAdj ?? {})) {
    if (!fin(x) || x < 0.4 || x > 3) bad("zoning", `district ${d}`, `envelope multiplier ${x}`);
  }
  for (const [bbl, x] of Object.entries(s.variance ?? {})) {
    if (!fin(x) || x < 0 || x > FAR_CEILING) bad("zoning", `variance ${bbl}`, `granted ${x} FAR`);
  }
  const pendingVariance = s.varianceApps
    ?? (s.varianceApp ? { [s.varianceApp.bbl]: s.varianceApp } : {});
  for (const [bbl, a] of Object.entries(pendingVariance)) {
    if (a.bbl !== bbl) bad("zoning", `variance ${bbl}`, `application points at ${a.bbl}`);
    if (a.decideM < a.filedM) bad("zoning", `variance ${bbl}`, "a hearing that decided before it was filed");
    if (!fin(a.odds) || a.odds < 0 || a.odds > 1) bad("zoning", `variance ${bbl}`, `odds ${a.odds}`);
  }
  // A landmark cannot also be under construction — nobody builds on one.
  for (const bbl of Object.keys(s.landmarks ?? {})) {
    if (s.developments[bbl]) bad("zoning", `landmark ${bbl}`, "landmarked and under construction at once");
  }

  // --------------------------------------------------------------- the trades
  for (const k of SECTORS) {
    const mom = s.econ.industryMom?.[k];
    if (mom !== undefined && (!fin(mom) || Math.abs(mom) > 0.06)) {
      bad("industry", "econ", `${k} momentum ${mom}`);
    }
    const ph = s.econ.industryPhase?.[k];
    if (ph !== undefined && ph !== "boom" && ph !== "steady" && ph !== "bust") {
      bad("industry", "econ", `${k} is in phase "${ph}"`);
    }
  }

  // ------------------------------------------------------------ what got built
  // SHOPS DO NOT STACK. This applies to buildings created during play only —
  // the shipped cities carry some three-storey retail as history, and that is
  // theirs to have. Anything the game itself puts up has to obey the rule, and
  // it did not: the city's growth loop was starting fifty-storey shops and the
  // planner would approve a sixty-one-storey one.
  for (const [bbl, b] of Object.entries(s.built ?? {})) {
    const cap = MAX_FLOORS_BY_USE[b.class as DevUse];
    if (cap !== undefined && b.floors > cap) {
      bad("massing", `built ${bbl}`, `${b.floors}-storey ${b.class} — the cap is ${cap}`);
    }
  }
  for (const j of s.cityJobs ?? []) {
    const cap = MAX_FLOORS_BY_USE[j.use as DevUse];
    if (cap !== undefined && j.floors > cap) {
      bad("massing", `job ${j.bbl}`, `${j.floors}-storey ${j.use} under construction — the cap is ${cap}`);
    }
  }
  for (const d of Object.values(s.developments ?? {})) {
    const cap = MAX_FLOORS_BY_USE[d.use];
    if (cap !== undefined && d.floors > cap) {
      bad("massing", `development ${d.bbl}`, `${d.floors}-storey ${d.use} — the cap is ${cap}`);
    }
    if (d.bts) {
      const at = `BTS ${d.bbl}`;
      const available = d.sf * (d.mix[d.bts.use] ?? 0);
      if (!fin(d.bts.sf) || d.bts.sf <= 0 || d.bts.sf > available + 1) {
        bad("dev", at, `${d.bts.sf} sf committed against ${available} sf programmed`);
      }
      if (d.bts.credit < 1 || d.bts.credit > 2) bad("dev", at, `unbankable credit ${d.bts.credit}`);
      if (!fin(d.bts.rentPsf) || d.bts.rentPsf <= 0) bad("dev", at, `rent ${d.bts.rentPsf}`);
    }
  }

  // ------------------------------------------------------- the supply queue
  // One physical project, one economic delivery. Cohorts are a derived view;
  // if they disagree, vacancy and the map are about to receive different
  // buildings again.
  if (s.econ.deliveryQueue) {
    const seen = new Set<string>();
    for (const p of s.econ.deliveryQueue) {
      const at = `supply ${p.id}`;
      if (!fin(p.deliverM) || !fin(p.startM) || p.deliverM < p.startM) {
        bad("supply", at, `bad dates ${p.startM}->${p.deliverM}`);
      }
      const sf = Object.values(p.sfByUse).reduce((a, v) => a + (v ?? 0), 0);
      if (!fin(sf) || sf <= 0) bad("supply", at, `non-positive programme ${sf}`);
      if (p.bbl && p.source !== "legacy") {
        if (seen.has(p.bbl)) bad("supply", at, `duplicate live project on ${p.bbl}`);
        seen.add(p.bbl);
        const d = s.developments[p.bbl];
        const j = (s.cityJobs ?? []).find((x) => x.bbl === p.bbl);
        const physical = !!d || !!j;
        if (!physical) bad("supply", at, "economic delivery has no physical project");
        if (d && d.deliverM !== p.deliverM) {
          bad("supply", at, `player deliverM ${d.deliverM} ≠ queue ${p.deliverM}`);
        }
        if (j && !j.orphaned && j.deliverM !== p.deliverM) {
          bad("supply", at, `city deliverM ${j.deliverM} ≠ queue ${p.deliverM}`);
        }
        if (j?.orphaned && p.status === "active") {
          bad("supply", at, "orphaned city job still active on the queue");
        }
      }
    }
    for (const d of Object.values(s.developments ?? {})) {
      if (!d.piped) continue;
      if (!seen.has(d.bbl)) bad("supply", `dev ${d.bbl}`, "piped development missing from deliveryQueue");
    }
    for (const j of s.cityJobs ?? []) {
      if (j.orphaned || !j.bbl) continue;
      if (!seen.has(j.bbl)) bad("supply", `job ${j.bbl}`, "live city job missing from deliveryQueue");
    }
    for (const k of ["office", "retail", "multifamily", "industrial"] as BuiltClass[]) {
      const queued = s.econ.deliveryQueue
        .filter((p) => p.status === "active")
        .reduce((a, p) => a + Math.max(0, Math.round(p.sfByUse[k] ?? 0)), 0);
      const scheduled = (s.econ.cohorts?.[k] ?? []).reduce((a, c) => a + c.sf, 0);
      if (queued !== scheduled) {
        bad("supply", `${k} queue`, `${queued} sf in projects but ${scheduled} sf on schedule`);
      }
    }
  }

  // ------------------------------------------------------------- assemblage
  // A merged deed's land has moved somewhere. If the parent is gone, or the
  // child is itself a parent, the land has either vanished or been counted in
  // two places — and land that is counted twice is net worth that is wrong.
  for (const [child, parent] of Object.entries(s.merged ?? {})) {
    const at = `assemblage ${child}`;
    if (child === parent) bad("merge", at, "a lot merged into itself");
    if (!s.holdings[child]) bad("merge", at, "a merged deed you do not own");
    if (!s.holdings[parent]) bad("merge", at, `merged into ${parent}, which you do not own`);
    if (s.merged![parent]) bad("merge", at, `merged into ${parent}, which is itself merged into something else`);
  }
  for (const [bbl, gl] of Object.entries(s.groundLeases ?? {})) {
    const at = `ground lease ${bbl}`;
    if (!s.holdings[bbl]) bad("ground", at, "a ground lease on land you do not own");
    if (s.cityGroundLeases?.[bbl]) bad("ground", at, "same parcel also keyed as an off-book leased fee");
    if (!fin(gl.rentYr) || gl.rentYr < 0) bad("ground", at, `ground rent ${gl.rentYr}`);
    if (gl.endM <= gl.startM) bad("ground", at, "a lease that ends before it starts");
  }
  for (const [bbl, gl] of Object.entries(s.cityGroundLeases ?? {})) {
    const at = `city ground lease ${bbl}`;
    if (s.holdings[bbl]) bad("ground", at, "off-book lease on a parcel you still own — should be on groundLeases");
    if (!fin(gl.rentYr) || gl.rentYr < 0) bad("ground", at, `ground rent ${gl.rentYr}`);
    if (gl.endM <= gl.startM) bad("ground", at, "a lease that ends before it starts");
  }
  for (const [bbl, events] of Object.entries(s.propertyLog ?? {})) {
    if (!parcels[bbl]) bad("history", `property ${bbl}`, "history attached to a parcel that does not exist");
    if (events.length > PROPERTY_HISTORY_CAP) bad("history", `property ${bbl}`, `${events.length} events exceed cap`);
    for (const e of events) {
      if (!fin(e.m) || e.m < 0 || e.m > s.month) bad("history", `property ${bbl}`, `event month ${e.m}`);
    }
  }

  // ------------------------------------------------------------- the economy
  const e = s.econ;
  for (const [k, x] of Object.entries({ indexRate: e.indexRate, landIdx: e.landIdx, costIdx: e.costIdx, cycleDev: e.cycleDev, creditIdx: e.creditIdx })) {
    if (!fin(x)) bad("nan", "econ", `${k} is ${x}`);
  }
  if (fin(e.indexRate) && (e.indexRate < 0 || e.indexRate > 40)) bad("rate", "econ", `index rate ${e.indexRate}%`);
  if (fin(e.cycleDev) && Math.abs(e.cycleDev) > 1.0001) bad("cycle", "econ", `cycleDev ${e.cycleDev} outside [-1,1]`);
  for (const [cls, r] of Object.entries(e.rentIdx ?? {})) {
    if (!fin(r) || r <= 0) bad("rent", "econ", `${cls} rent index ${r}`);
  }
  for (const [cls, c] of Object.entries(e.capRate ?? {})) {
    if (!fin(c) || c <= 0.5 || c > 40) bad("cap", "econ", `${cls} cap rate ${c}%`);
  }

  // ------------------------------------------------------------- the holdings
  for (const [bbl, h] of Object.entries(s.holdings)) {
    const at = `holding ${bbl}`;
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) { bad("orphan", at, "owned parcel is not in the parcel table"); continue; }
    if (h.bbl !== bbl) bad("key", at, `holding keyed ${bbl} but says it is ${h.bbl}`);
    if (!fin(h.costBasis) || h.costBasis < 0) bad("basis", at, `cost basis ${h.costBasis}`);
    if (h.boughtM > s.month) bad("time", at, `bought in month ${h.boughtM}, it is month ${s.month}`);
    if (h.deprTaken !== undefined && (!fin(h.deprTaken) || h.deprTaken < -1)) bad("depr", at, `accumulated depreciation ${h.deprTaken}`);
    if (h.taxAppeal) {
      if (h.taxAppeal.decideM < h.taxAppeal.filedM) bad("tax", at, "appeal decides before filing");
      if (!fin(h.taxAppeal.odds) || h.taxAppeal.odds < 0 || h.taxAppeal.odds > 1) bad("tax", at, `appeal odds ${h.taxAppeal.odds}`);
      if (!fin(h.taxAppeal.target) || h.taxAppeal.target <= 0) bad("tax", at, `appeal target ${h.taxAppeal.target}`);
    }

    const val = ownedHoldingValue(s, parcels, h);
    if (!fin(val) || val < 0) bad("value", at, `holding value ${val}`);
    const noi = ownedHoldingNoiYr(s, parcels, h);
    if (!fin(noi)) bad("nan", at, "NOI is not a number");

    // A leased fee is not a landlord holding — LOIs, exclusives and a rent roll
    // of yours are category errors, not soft bugs.
    if (h.groundLeased) {
      if (h.tenants.length) bad("ground", at, "fee owner has a rent roll on a ground-leased fee");
      if (h.broker) bad("ground", at, "leasing exclusive on a ground-leased fee");
      if (s.lois.some((l) => l.bbl === bbl)) bad("ground", at, "live LOI on a ground-leased fee");
      if ((s.asks ?? []).some((a) => a.bbl === bbl)) bad("ground", at, "tenant relief ask on a ground-leased fee");
    }

    // the rent roll cannot be bigger than the building
    const leased = h.tenants.reduce((a, t) => a + t.sf, 0);
    if (!fin(leased) || leased < 0) bad("roll", at, `leased area ${leased}`);
    if (rec.bldgArea > 0 && leased > rec.bldgArea + 1) {
      bad("overleased", at, `${Math.round(leased).toLocaleString()} sf leased in a ${rec.bldgArea.toLocaleString()} sf building`);
    }
    if (rec.class === "land" && leased > 0) bad("roll", at, "a vacant site has tenants on it");

    // THE MIX. Shares must be a real partition of the building, and no tenant
    // may occupy a use the building does not have — you cannot lease office
    // space in a building that is entirely flats.
    const m = mixOf(rec);
    const shares = Object.values(m);
    if (rec.class !== "land") {
      const tot = shares.reduce((x, y) => x + y, 0);
      if (!fin(tot) || Math.abs(tot - 1) > 0.005) bad("mix", at, `use shares sum to ${tot.toFixed(3)}, not 1`);
      for (const [u, sh] of Object.entries(m)) {
        if (!fin(sh) || sh <= 0 || sh > 1.0001) bad("mix", at, `${u} share is ${sh}`);
      }
      // each component holds only what fits in it
      for (const u of Object.keys(m) as BuiltClass[]) {
        const cap = useSf(rec, u);
        const inUse = h.tenants.filter((tn) => (tn.use ?? rec.class) === u).reduce((n, tn) => n + tn.sf, 0);
        if (inUse > cap + 1) {
          bad("overleased", at, `${Math.round(inUse).toLocaleString()} sf let in the ${u} part, which is ${Math.round(cap).toLocaleString()} sf`);
        }
      }
      for (const tn of h.tenants) {
        if (tn.use && !(tn.use in m)) bad("mix", at, `${tn.name} occupies ${tn.use} space in a building with none`);
        if (tn.use === "multifamily") bad("mix", at, `${tn.name} is a named tenant in the residential part`);
      }
    }
    for (const t of h.tenants) {
      if (!fin(t.sf) || t.sf <= 0) bad("tenant", at, `${t.name} occupies ${t.sf} sf`);
      if (!fin(t.rentPsf) || t.rentPsf < 0) bad("tenant", at, `${t.name} pays ${t.rentPsf}/sf`);
      if (t.endM < t.startM) bad("tenant", at, `${t.name}'s lease ends before it begins`);
    }
    // space being turned is space that exists
    const turning = (h.makeReady ?? []).reduce((a, m) => a + m.sf, 0);
    if (rec.bldgArea > 0 && leased + turning > rec.bldgArea * 1.02) {
      bad("overleased", at, `${Math.round(leased + turning).toLocaleString()} sf leased-or-turning in a ${rec.bldgArea.toLocaleString()} sf building`);
    }
    if (h.occ !== undefined && (!fin(h.occ) || h.occ < 0 || h.occ > 1)) bad("occ", at, `occupancy ${h.occ}`);

    // the loan
    const l = h.loan;
    if (l) {
      if (!fin(l.balance) || l.balance < 0) bad("loan", at, `balance ${l.balance}`);
      if (!fin(l.principal) || l.principal <= 0) bad("loan", at, `original principal ${l.principal}`);
      if (l.balance > l.principal + 1) bad("loan", at, `balance ${Math.round(l.balance)} exceeds original principal ${Math.round(l.principal)}`);
      if (!fin(l.ratePct) || l.ratePct < 0 || l.ratePct > 60) bad("loan", at, `coupon ${l.ratePct}%`);
      if (!fin(l.monthlyPmt) || l.monthlyPmt < 0) bad("loan", at, `payment ${l.monthlyPmt}`);
      if (l.maturityM <= l.originM) bad("loan", at, "matures on or before it was written");
      if (l.originM > s.month) bad("loan", at, `originated in month ${l.originM}, it is month ${s.month}`);
      // an interest-only loan pays interest; an amortising one pays more
      const interest = (l.balance * l.ratePct) / 100 / 12;
      if (l.balance > 1000 && l.monthlyPmt + 1 < interest * 0.999) {
        bad("loan", at, `payment ${Math.round(l.monthlyPmt)} does not cover interest ${Math.round(interest)}`);
      }
    }
    // you cannot be selling a building you are also building
    if (h.sale && s.developments[bbl]) bad("state", at, "listed for sale while under construction");
  }

  // ---------------------------------------------------------- the development
  for (const [bbl, d] of Object.entries(s.developments ?? {})) {
    const at = `development ${bbl}`;
    if (!fin(d.costTotal) || d.costTotal <= 0) bad("dev", at, `budget ${d.costTotal}`);
    if (!fin(d.drawn) || d.drawn < 0) bad("dev", at, `drawn ${d.drawn}`);
    if (d.drawn > d.commitment + 1) bad("dev", at, `drawn ${Math.round(d.drawn)} exceeds the commitment ${Math.round(d.commitment)}`);
    if (d.loanBalance < d.drawn - 1) bad("dev", at, `loan balance ${Math.round(d.loanBalance)} is below what has been drawn ${Math.round(d.drawn)}`);
    if (d.reserveUsed > d.interestReserve + 1) bad("dev", at, `interest reserve overdrawn by ${Math.round(d.reserveUsed - d.interestReserve)}`);
    if (d.contingencyUsed > d.contingency + 1) bad("dev", at, `contingency overdrawn by ${Math.round(d.contingencyUsed - d.contingency)}`);
    if (d.equitySpent > d.equityBudget * 3) bad("dev", at, `equity spent ${Math.round(d.equitySpent)} against a budget of ${Math.round(d.equityBudget)}`);
    if (d.deliverM <= d.startM) bad("dev", at, "delivers on or before it starts");
    if (!fin(d.sf) || d.sf <= 0) bad("dev", at, `programme is ${d.sf} sf`);
    if (s.holdings[bbl] && s.holdings[bbl].sale) bad("state", at, "under construction and on the market at once");
  }

  // -------------------------------------------------------------- the market
  const seen = new Set<string>();
  for (const li of s.listings) {
    if (!parcels[li.bbl]) bad("listing", `listing ${li.bbl}`, "not a real parcel");
    if (!fin(li.ask) || li.ask <= 0) bad("listing", `listing ${li.bbl}`, `ask ${li.ask}`);
    if (s.holdings[li.bbl]) bad("listing", `listing ${li.bbl}`, "the market is selling you a building you already own");
    if (seen.has(li.bbl)) bad("listing", `listing ${li.bbl}`, "listed twice at once");
    seen.add(li.bbl);
    // NOBODY GIVES A BUILDING AWAY. The deepest honest discount in this game is
    // a motivated seller or a receiver at about thirty per cent under; anything
    // beneath that is an arithmetic fault somewhere upstream, and it used to be
    // one — static records priced as dirt, and a compounding stale-listing
    // markdown with no floor under it. A little slack below the 70% floor for
    // a market that moved inside the month.
    {
      const lr = resolveRec(parcels, s, li.bbl);
      const v = lr ? assetValue(lr, s.econ, gradeOf(s, lr)) : 0;
      if (v > 0 && li.ask < v * 0.60) {
        bad("listing", `listing ${li.bbl}`, `asking ${(li.ask / 1e6).toFixed(2)}M against a ${(v / 1e6).toFixed(2)}M appraisal — ${((1 - li.ask / v) * 100).toFixed(0)}% under`);
      }
    }
  }
  // The same rule for an owner who was never selling: their number is a premium
  // to appraisal, and a fraction of it means something upstream mispriced them.
  for (const [bbl, a] of Object.entries(s.approaches)) {
    if (a.refused || !a.ask) continue;
    const ar = resolveRec(parcels, s, bbl);
    const v = ar ? assetValue(ar, s.econ, gradeOf(s, ar)) : 0;
    if (v > 0 && a.ask < v * 0.60) {
      bad("listing", `approach ${bbl}`, `owner asking ${(a.ask / 1e6).toFixed(2)}M against a ${(v / 1e6).toFixed(2)}M appraisal`);
    }
  }
  // NOBODY LEASES A CLOSET — BUT A SMALL BUILDING IS NOT A CLOSET.
  //
  // The 2,000 sf commercial floor was enforced in four separate places in
  // leasing.ts and leaked through three of them, and no invariant ever looked
  // — so 30.5% of an inherited rent roll could sit under the floor and nothing
  // said a word. A rule worth having in four places is worth checking once.
  //
  // Once, and against the right number. This asserted the CITY-WIDE norm on
  // every tenancy, including tenancies in buildings smaller than the norm —
  // and the same rule was ALSO checked forty lines below at 2,000 rather than
  // 1,900, which is the same quantity with two answers. A 692 sf office
  // building let to one firm is not a closet, it is the whole building; see
  // minTenancySf, which is what leasing.ts now enforces.
  for (const h of Object.values(s.holdings)) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    for (const t of h.tenants) {
      const use = t.use ?? leasableUses(rec)[0] ?? "office";
      const floor = minTenancySf(rec, use) - 1;    // a little slack for rounding
      if (t.sf > 0 && t.sf < floor) {
        bad("tenancy", `${h.bbl} ${t.name}`, `${Math.round(t.sf)} sf tenancy, under the ${floor} sf floor for ${use}`);
      }
    }
  }
  // A LETTER YOU CANNOT SIGN MUST NOT BE ON THE DESK.
  //
  // This is the invariant for a real bug a playtester hit: a second letter for
  // space the first letter had already taken stayed on the desk, and accepting
  // it ran the demising clamp, found less than a suite left, and returned
  // having signed nothing. The letter disappeared and no lease appeared —
  // software quietly eating an input. Letters are now withdrawn at the source
  // the month their space goes, and this is what stops that regressing.
  for (const l of s.lois) {
    if (l.kind !== "new" && l.kind !== "expansion") continue;
    const rec = resolveRec(parcels, s, l.bbl);
    const h = s.holdings[l.bbl];
    if (!rec || !h) continue;
    const use = l.use ?? leasableUses(rec)[0] ?? "office";
    const floor = minTenancySf(rec, use);
    const vac = useVacantSf(rec, h, use, s.month);
    if (vac < floor) {
      bad("loi", `${l.bbl} ${l.name}`, `letter for ${Math.round(l.sf)} sf of ${use} is live, but only `
        + `${Math.round(vac)} sf is lettable — under the ${floor} sf floor, so accepting it would sign nothing`);
    }
  }

  // SECURITY DEPOSITS. One to two months of rent, never more, never negative,
  // and never sitting on a lease that has already ended.
  for (const h of Object.values(s.holdings)) {
    const rec0 = resolveRec(parcels, s, h.bbl);
    for (const t of h.tenants) {
      const d = t.deposit ?? 0;
      if (d < 0 || !fin(d)) bad("deposit", `${h.bbl} ${t.name}`, `deposit ${d}`);
      const monthly = (t.rentPsf * t.sf) / 12;
      if (monthly > 0 && d > monthly * 3.2) {
        bad("deposit", `${h.bbl} ${t.name}`, `deposit is ${(d / monthly).toFixed(1)} months of rent`);
      }
      // The demise floor is checked ONCE, above, against the building's own
      // smallest tenancy. A second copy lived here at 2,000 against the other
      // one's 1,900 — one rule, two numbers, and whichever fired first was the
      // rule. See the block that begins NOBODY LEASES A CLOSET.
    }
    // A building you have stopped letting must not be signing anybody.
    if (h.leasingHold && s.lois.some((l) => l.bbl === h.bbl)) {
      bad("leasing", `hold ${h.bbl}`, "letting is stopped and there is a live letter of intent on it");
    }
    // A LEG CANNOT BE TURNING SPACE IT DOES NOT HAVE.
    //
    // `unitStatusByUse` is what the property panel renders per use, and its
    // not-ready count used to be the WHOLE building's make-ready apportioned
    // across the commercial legs by floor area. Measured, that was wrong on
    // 25.3% of rows sampled while anything was turning, in both directions: a
    // 4,036 sf shop front showed 1,455 sf "turning" with not one foot of retail
    // turning, and a 2,317 sf office leg with 2,316 sf genuinely down showed
    // zero. Since the panel computes vacancy as total - leased - notReady, that
    // is a suite the player has just let still reading as unavailable.
    //
    // This is a definitional bound rather than a judgement: the space a row
    // says is being turned has to be space that is being turned IN THAT LEG.
    if (rec0 && rec0.bldgArea) {
      for (const row of unitStatusByUse(rec0, h, s.month)) {
        if (row.use === "multifamily") continue;      // occupancy, not suites
        // COMPARED IN SUITES, WHICH IS THE UNIT THE ROW IS RENDERED IN, and
        // with no slack above. The first version of this check allowed a whole
        // suite of tolerance and therefore could not fail: the very case it was
        // written for — 1,455 sf shown against 0 real — rounds to one suite
        // against zero, and one suite of slack swallows it exactly. It ran
        // clean against the broken code, which is the only outcome worse than
        // no check at all. CLAUDE.md: check that a metric can move before
        // trusting that it did.
        //
        // Only an OVERSTATEMENT is a violation. The row legitimately shows
        // fewer turning suites than the raw footage implies, because it is
        // capped by the suites that are actually vacant.
        const realSf = notReadySf(h, s.month, row.use);
        const justified = Math.round(realSf / row.sfPer);
        if (row.notReady > justified) {
          bad("notready", `${h.bbl} ${row.use}`,
            `row shows ${row.notReady} suite(s) turning but only `
            + `${Math.round(realSf).toLocaleString()} sf of ${row.use} is in make-ready `
            + `(${justified} suite(s) at ${Math.round(row.sfPer).toLocaleString()} sf)`);
        }
      }
    }
  }
  const loiIds = new Set<number>();
  for (const loi of s.lois) {
    const at = `LOI ${loi.id}`;
    if (loiIds.has(loi.id)) bad("loi", at, "duplicate LOI id");
    loiIds.add(loi.id);
    if (!s.holdings[loi.bbl]) bad("loi", at, "a tenant is negotiating for a building you do not own");
    if (!fin(loi.sf) || loi.sf <= 0) bad("loi", at, `${loi.sf} sf`);
    if (!fin(loi.rentPsf) || loi.rentPsf < 0) bad("loi", at, `$${loi.rentPsf}/sf`);
    if (loi.id >= s.nextLoiId) bad("loi", at, `id ${loi.id} is at or past the next id ${s.nextLoiId}`);
  }

  // ----------------------------------------------------------- the city itself
  for (const [bbl, b] of Object.entries(s.built ?? {})) {
    const at = `built ${bbl}`;
    if (!parcels[bbl]) { bad("built", at, "not a real parcel"); continue; }
    // A CLEARED LOT IS A `built` RECORD, AND IT IS SUPPOSED TO BE EMPTY.
    //
    // A demolition writes `{ class: "land", bldgArea: 0, floors: 0,
    // yearBuilt: 0 }` — see dev.ts, "the lot is dirt again" — because that is
    // how every reader downstream learns the generator's building is gone.
    // These three lines called each of those fields a fault, so ONE teardown
    // printed three violations and every long run reported hundreds. A sweep
    // whose findings are all false is a sweep nobody can read.
    if ((b.class as string) === "land") {
      if (b.bldgArea !== 0) bad("built", at, `cleared lot carrying ${b.bldgArea} sf`);
      continue;
    }
    if (!fin(b.bldgArea) || b.bldgArea <= 0) bad("built", at, `${b.bldgArea} sf`);
    if (!fin(b.floors) || b.floors < 1) bad("built", at, `${b.floors} floors`);
    if (b.yearBuilt < 1800 || b.yearBuilt > 2200) bad("built", at, `built in ${b.yearBuilt}`);
    if (b.mix) {
      const tot = Object.values(b.mix).reduce((x, y) => x + y, 0);
      if (!fin(tot) || Math.abs(tot - 1) > 0.005) bad("mix", at, `delivered mix sums to ${tot}`);
      if (!(b.class in b.mix)) bad("mix", at, `filed as ${b.class}, which is not in its own mix`);
    }
  }
  for (const [id, d] of Object.entries(s.blockD ?? {})) {
    if (!fin(d)) bad("nan", `block ${id}`, `demand drift is ${d}`);
    else if (Math.abs(d) > 40) bad("demand", `block ${id}`, `demand drift ${d.toFixed(1)} beyond the cap`);
  }
  for (const [id, d] of Object.entries(s.blockE ?? {})) {
    if (!fin(d)) bad("nan", `block ${id}`, `demand drift is ${d}`);
    else if (Math.abs(d) > 36) bad("demand", `block ${id}`, `emergent drift ${d.toFixed(1)} beyond the cap`);
  }
  for (const [id, d] of Object.entries(s.blockJ ?? {})) {
    if (!fin(d)) bad("nan", `block ${id}`, `employment advantage is ${d}`);
    else if (Math.abs(d) > 17) bad("demand", `block ${id}`, `employment advantage ${d.toFixed(1)} beyond the cap`);
  }
  // The surface REDISTRIBUTES. If the whole city is drifting one way the
  // centring has broken, and every price in the game is riding on it.
  const em = Object.values(s.blockE ?? {});
  if (em.length > 20) {
    const mean = em.reduce((a, b) => a + b, 0) / em.length;
    if (Math.abs(mean) > 12) bad("demand", "the surface", `mean emergent drift is ${mean.toFixed(1)} — demand is no longer zero-sum`);
  }

  // ------------------------------------------------------------ negotiations
  // A price agreed puts you under contract, and the contract is a state that
  // can go wrong in ways a negotiation cannot: a stale closing date, a deed
  // reserved on a building somebody else already took, a contract with no
  // price on it.
  for (const [key, t] of Object.entries(s.talks ?? {})) {
    const at = `talks ${t.bbl}`;
    if (key !== t.bbl) bad("talks", at, `filed under ${key} but the deal is on ${t.bbl}`);
    // Earnest money is real cash and it left the account. A contract carrying
    // no deposit is a contract nobody paid for.
    if (t.agreed && !((t.deposit ?? 0) > 0)) bad("talks", at, "under contract with no deposit posted");
    if (!parcels[t.bbl]) bad("talks", at, "negotiating over a parcel that does not exist");
    if (s.holdings[t.bbl]) bad("talks", at, "negotiating over a building you already own");
    if (!fin(t.yourPrice) || t.yourPrice <= 0) bad("talks", at, `your price ${t.yourPrice}`);
    if (!fin(t.theirPrice) || t.theirPrice <= 0) bad("talks", at, `their price ${t.theirPrice}`);
    if (t.openedM > s.month) bad("talks", at, `opened in month ${t.openedM}, it is month ${s.month}`);
    if (t.round < 1) bad("talks", at, `round ${t.round}`);
    if (t.agreed) {
      if (!fin(t.agreedPrice ?? NaN) || (t.agreedPrice ?? 0) <= 0) bad("talks", at, `under contract at ${t.agreedPrice}`);
      if (t.closeByM === undefined) bad("talks", at, "under contract with no closing date");
      else if (t.closeByM <= s.month) bad("talks", at, `closing date ${t.closeByM} has passed and the contract is still live`);
      if (!s.listings.some((l) => l.bbl === t.bbl)) bad("talks", at, "under contract on something that is no longer for sale");
    }
  }


  // -------------------------------------------------------------- the street
  const claimed = new Map<string, string>();
  for (const r of s.rivals ?? []) {
    const at = `rival ${r.name}`;
    if (!fin(r.cash)) bad("nan", at, `cash is ${r.cash}`);
    if (!fin(r.debt) || r.debt < 0) bad("rival", at, `debt ${r.debt}`);
    // The street keeps books now — a cost basis, tax paid, distributions — so
    // those have to stay coherent too. A negative basis means a sale relieved
    // more basis than was ever put in, which would be a firm printing losses.
    if (r.basis !== undefined && (!fin(r.basis) || r.basis < 0)) bad("rival", at, `cost basis ${r.basis}`);
    if (r.taxPaid !== undefined && (!fin(r.taxPaid) || r.taxPaid < 0)) bad("rival", at, `lifetime tax ${r.taxPaid}`);
    if (r.distributed !== undefined && (!fin(r.distributed) || r.distributed < 0)) bad("rival", at, `distributions ${r.distributed}`);
    // a failed firm may still hold assets — a receiver sells the book down
    // over years — but it cannot have failed in the future
    if (r.failedM !== undefined && r.failedM > s.month) bad("rival", at, `failed in month ${r.failedM}, it is month ${s.month}`);
    for (const bbl of r.bbls) {
      if (!parcels[bbl]) { bad("rival", at, `owns ${bbl}, which is not a parcel`); continue; }
      if (s.holdings[bbl]) bad("rival", at, `owns ${bbl}, and so do you`);
      const other = claimed.get(bbl);
      if (other) bad("rival", at, `owns ${bbl}, and so does ${other}`);
      claimed.set(bbl, r.name);
    }
  }

  // --------------------------------------------------- the development ledger
  // The funding identity that broke silently for months: the day-one cheque is
  // money ON DEPOSIT, not budget consumed, and the S-curve must not be able to
  // spend it twice. A prefunded pot that goes negative, or exceeds the cheque
  // that created it, means the waterfall is drawing from somewhere it should
  // not — which is exactly how a job came to take 2.75x its day-one equity.
  for (const d of Object.values(s.developments ?? {})) {
    const at = `development ${d.bbl}`;
    if (!fin(d.equityBudget) || d.equityBudget < 0) bad("dev", at, `equity budget ${d.equityBudget}`);
    if (!fin(d.equitySpent) || d.equitySpent < 0) bad("dev", at, `equity spent ${d.equitySpent}`);
    const pre = d.equityPrefunded ?? 0;
    if (!fin(pre) || pre < 0) bad("dev", at, `prefunded equity ${pre}`);
    if (pre > d.equityBudget + 1) bad("dev", at, `prefunded ${Math.round(pre)} exceeds the whole equity budget ${Math.round(d.equityBudget)}`);
    if (!fin(d.drawn) || d.drawn < 0) bad("dev", at, `drawn ${d.drawn}`);
    if (d.drawn > d.commitment + 1) bad("dev", at, `drawn ${Math.round(d.drawn)} past a ${Math.round(d.commitment)} commitment`);
    if (!fin(d.loanBalance) || d.loanBalance < 0) bad("dev", at, `loan balance ${d.loanBalance}`);
  }

  // ---------------------------------------------------------------- the banks
  // A lender is a firm with a balance sheet, so it gets the same treatment as
  // any other balance sheet in here: no NaN, no negative book, no failing in
  // the future, and a capital ratio that is a number.
  for (const l of s.lenders ?? []) {
    const at = `lender ${l.name}`;
    if (!fin(l.book) || l.book < 0) bad("lender", at, `book ${l.book}`);
    if (!fin(l.capital)) bad("nan", at, `capital is ${l.capital}`);
    if (!fin(l.delinquent) || l.delinquent < 0 || l.delinquent > 1) bad("lender", at, `delinquency ${l.delinquent}`);
    if (!fin(l.appetite) || l.appetite < 0) bad("lender", at, `appetite ${l.appetite}`);
    if (!fin(l.yours) || l.yours < 0) bad("lender", at, `your balance ${l.yours}`);
    if (!fin(l.chargeOffsTotal) || l.chargeOffsTotal < 0) bad("lender", at, `lifetime charge-offs ${l.chargeOffsTotal}`);
    if (l.failedM !== undefined && l.failedM > s.month) bad("lender", at, `failed in month ${l.failedM}, it is month ${s.month}`);
    // A failed desk that is somehow quoting again is the one bug that would
    // quietly undo the whole point of giving them books.
    if (l.failedM !== undefined && l.appetite > 0) bad("lender", at, `in receivership and still quoting at ${l.appetite}`);
  }

  // ------------------------------------------------------------- the workouts
  // A file has to be about a building you own, with a loan on it, opened in
  // the past, and pointing at a decision date that has not already passed
  // unstuck. An orphaned workout is how you end up foreclosing on air.
  for (const w of Object.values(s.workouts ?? {})) {
    const at = `workout ${w.bbl}`;
    const h = s.holdings[w.bbl];
    if (!h) { bad("workout", at, "a file on a building you do not own"); continue; }
    if (!h.loan) bad("workout", at, "a file on a building with no loan on it");
    if (w.startM > s.month) bad("workout", at, `opened in month ${w.startM}, it is month ${s.month}`);
    if (!fin(w.cure) || w.cure < 0) bad("workout", at, `cure amount ${w.cure}`);
    if (w.asks < 0 || w.asks > 4) bad("workout", at, `${w.asks} forbearance requests`);
    if (!["notice", "forbearance", "foreclosure"].includes(w.stage)) bad("workout", at, `stage ${w.stage}`);
    // The clock has to run. A decide date more than a decade out means
    // something extended it and never came back.
    if (w.decideM > s.month + 180) bad("workout", at, `decision date is month ${w.decideM}, ${w.decideM - s.month} months away`);
  }

  // --------------------------------------------------- a deed taken by force
  //
  // WHAT A LEVY HANDS BACK, AND WHAT IT DOES NOT.
  //
  // The general creditors take the most valuable thing you own and sell it,
  // and the money used to arrive as if a buyer had walked in off the street:
  // the whole gross, no commission, no stamps, no legal, no tax on the gain,
  // and the lien netted but nothing else. Measured on a free-and-clear
  // $15.50M building with the insolvency clock at twelve months, the account
  // went from -$5.00M to +$8.03M in one tick — 84.1% of appraisal in cash for
  // a deed that had just been carried off. It was the cheapest exit in the
  // game and it was the one nobody chose, which is the wrong way round.
  //
  // So: in a month a deed leaves the book by levy, the account cannot have
  // risen by more than that deed could possibly have released — its price
  // less the friction of any sale and less the lien that is paid before the
  // borrower is — plus the rent that arrives in the month the bailiff does
  // and anything the month borrowed. A foreclosure is deliberately not in
  // scope: it has a file behind it and it settles on the steps in
  // engine/auction.ts, on a docket this check has no way to read.
  if (prev) {
    const levied = s.exits.filter((e) => e.forced && e.soldM === s.month && !prev.workouts?.[e.bbl] && prev.holdings[e.bbl]);
    if (levied.length) {
      let released = 0;
      for (const e of levied) {
        const h = prev.holdings[e.bbl]!;
        released += Math.max(0, saleTaxQuote(h, e.price, s).net - (h.loan?.balance ?? 0));
      }
      // Rent still arrives in the month the bailiff does — gross, because an
      // over-estimate of the month's income is the safe direction here.
      let income = 0;
      for (const h of Object.values(prev.holdings)) {
        income += Math.max(0, ownedHoldingNoiYr(prev, parcels, h)) / 12;
      }
      const owedNow = Object.values(s.holdings).reduce((a, h) => a + (h.loan?.balance ?? 0), 0)
        + Object.values(s.developments ?? {}).reduce((a, d) => a + d.loanBalance, 0);
      const owedWas = Object.values(prev.holdings).reduce((a, h) => a + (h.loan?.balance ?? 0), 0)
        + Object.values(prev.developments ?? {}).reduce((a, d) => a + d.loanBalance, 0);
      const borrowed = Math.max(0, owedNow - owedWas)
        + Math.max(0, (s.loc?.drawnTotal ?? 0) - (prev.loc?.drawnTotal ?? 0));
      const rose = s.cash - prev.cash;
      const ceiling = released + income + borrowed;
      const slack = Math.max(50_000, 0.004 * levied.reduce((a, e) => a + e.price, 0));
      if (rose > ceiling + slack) {
        bad("duress", `month ${s.month}`,
          `${levied.map((e) => e.address).join(", ")} was levied and the account rose `
          + `${(rose / 1e6).toFixed(2)}M against ${(ceiling / 1e6).toFixed(2)}M of equity, rent and borrowings`);
      }
    }
  }

  // ------------------------------------------------------------------- paper
  // A note is money and it can turn into a deed, which means every one of these
  // is a way to invent a building or a dollar out of nothing.
  for (const n of s.notes ?? []) {
    const at = `note ${n.id} on ${n.bbl}`;
    if (!fin(n.face) || n.face <= 0) bad("note", at, `face ${n.face}`);
    if (!fin(n.basis) || n.basis <= 0) bad("note", at, `basis ${n.basis}`);
    if (n.basis > n.face * 1.05) bad("note", at, `paid ${Math.round(n.basis)} for ${Math.round(n.face)} of face`);
    if (n.boughtM > s.month) bad("note", at, `bought in month ${n.boughtM}, it is month ${s.month}`);
    if (n.mods > 1) bad("note", at, `restructured ${n.mods} times; the limit is one`);
    if (n.filedM !== undefined && n.saleM === undefined) bad("note", at, "filed with no sale date");
    if (n.saleM !== undefined && n.saleM > s.month + 24) bad("note", at, `sale set ${n.saleM - s.month} months out`);
    if (s.holdings[n.bbl]) bad("note", at, "you hold a mortgage on a building you already own");
    if (n.perf === "performing" && n.filedM !== undefined) bad("note", at, "foreclosing on a performing loan");
  }
  {
    const seen = new Set<string>();
    for (const n of s.notes ?? []) {
      if (seen.has(n.bbl)) bad("note", `note ${n.id}`, `two notes secured by ${n.bbl}`);
      seen.add(n.bbl);
    }
  }
  for (const o of s.noteOffers ?? []) {
    if (!fin(o.askPct) || o.askPct <= 0 || o.askPct > 1.05) bad("note", `offer ${o.id}`, `ask ${o.askPct} of face`);
    if (o.expiresM <= o.offeredM) bad("note", `offer ${o.id}`, "expires before it was offered");
  }
  if ((s.noteOffers?.length ?? 0) > 3) bad("note", "offer sheet", `${s.noteOffers!.length} live offers; the cap is 3`);

  // ------------------------------------------------------- the portfolio trade
  // One process, many deeds, and every deed in it has to be one you still own.
  // A stale bbl here would allocate part of a sale price to a building
  // somebody else has — which is how you sell the same asset twice.
  if (s.portfolioSale) {
    const ps = s.portfolioSale;
    const at = "portfolio sale";
    if (!fin(ps.ask) || ps.ask <= 0) bad("portfolio", at, `ask ${ps.ask}`);
    if (ps.listedM > s.month) bad("portfolio", at, `listed in month ${ps.listedM}, it is month ${s.month}`);
    if (ps.bbls.length < 2) bad("portfolio", at, `${ps.bbls.length} building(s) in a portfolio`);
    if (new Set(ps.bbls).size !== ps.bbls.length) bad("portfolio", at, "the same deed appears twice");
    for (const b of ps.bbls) {
      if (!s.holdings[b]) bad("portfolio", at, `includes ${b}, which you do not own`);
      if (s.holdings[b]?.sale) bad("portfolio", at, `${b} is in the bundle AND listed on its own`);
    }
    for (const bid of ps.bids ?? []) {
      if (!fin(bid.price) || bid.price <= 0) bad("portfolio", at, `${bid.name} bid ${bid.price}`);
    }
  }

  return v;
}

/** Throwing form, for a test that should stop at the first broken month. */
export function assertInvariants(s: GameState, parcels: ParcelTable, prev?: GameState): void {
  const v = checkInvariants(s, parcels, prev);
  if (v.length) {
    throw new Error(`month ${s.month}: ${v.length} invariant violation(s)\n` + v.map((x) => `  [${x.code}] ${x.where}: ${x.detail}`).join("\n"));
  }
}
