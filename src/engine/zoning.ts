// ZONING IS NOT A CONSTANT.
//
// `farMaxComm` and `farMaxRes` were stamped on at generation and never moved
// again, for a hundred years, in a city that grew from half-empty to built
// out. That is the least realistic thing left in the model: a rezoning is the
// largest single value event that can happen to a piece of dirt — larger than
// any building you would put on it — and there was no such thing.
//
// Three mechanisms, and they are deliberately different in who drives them:
//
//   REZONING   — the CITY acts, on districts, over years. Places that have
//                filled up and got expensive get upzoned; places that have
//                emptied out or fought hard get held down. You do not control
//                it, you read it, and if you own the dirt when it lands you
//                did very well without doing anything.
//   VARIANCE   — YOU act, on one site. Lawyers, hearings, months of waiting
//                and a real chance of refusal. This is the natural partner to
//                assembling a site: you put the lots together, then you go
//                and ask for the envelope that makes them worth putting
//                together.
//   LANDMARK   — the city acts, on ONE BUILDING, and it is not a gift. The
//                redevelopment option is gone permanently; what you get back
//                is a building people care about, at a rent premium, that you
//                are no longer allowed to knock down.
import type { ParcelTable } from "@/data/types";
import type { GameState, VarianceApplication } from "./types";
import { logBooks, monthLabel, cloneState} from "./types";
import { rng, rrange, NATURAL_VAC, RENT_BASE } from "./market";
import { resolveRec, landValue, demandLinear, FAR_CEILING } from "./value";
import { recordPropertyEvent } from "./history";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** How far a district's envelope can be moved, either way, over a century. */
// A district can be held down but not gutted: repeated downzonings were
// taking whole neighbourhoods to 57% of their original envelope, which is not
// planning, it is demolition by paperwork.
const FAR_FLOOR = 0.72;
/** District envelope can reach ~gen cap as the city densifies — was 2.6× (~year 50 plateau). */
const FAR_CEIL = 3.8;
/**
 * The probability at which the rezoning walk neither grows nor shrinks the
 * city's envelope, derived from the two step sizes rather than chosen:
 * an up step averages x1.285, a down step x0.91, and
 *     p·ln(1.285) + (1 - p)·ln(0.91) = 0  =>  p = 0.273.
 * Change either step range and this number changes with it.
 */
const NEUTRAL_P = 0.273;

// ------------------------------------------------------------------ rezoning

/**
 * The city looks at a district and decides what it should be allowed to
 * become. It reads the same things a planning department reads: how much of
 * the district is actually built out against what it is permitted, and whether
 * the place has become somewhere people want to be.
 */
export function tickZoning(s: GameState, parcels: ParcelTable, bbls: string[]) {
  if (!s.zoneAdj) s.zoneAdj = {};
  // A SHORTAGE IS A POLITICS, and nothing here could see one.
  //
  // This read how much of a district's envelope was used and a STATIC
  // locational score, and nothing else — so a town at 3.7% vacancy with rents
  // tripling rezoned at exactly the rate of a town drowning in empty space,
  // and in the same direction. That is not how a planning board works. Scarcity
  // is the thing that puts people in the room: rents that have outrun what the
  // city earns are the argument for more envelope, they are why the argument
  // gets made more often, and a glut is why it stops being made at all.
  //
  // This is the supply side of the income anchor. With no wire from the price
  // of space back to permission to build more of it, a market that got tight
  // stayed tight for fifty years, and rent took the whole adjustment forever —
  // which is exactly what `sim:accept` F was measuring.
  const ez = s.econ;
  const tight = NATURAL_VAC.office - (ez.cityVac?.office ?? NATURAL_VAC.office);   // + when short
  const rentPress = clamp(
    (ez.rentIdx.office / RENT_BASE.office) / Math.max(0.35, ez.wageIdx ?? 1) - 1, -0.5, 1.5);
  const scarcity = clamp(tight * 2.2 + rentPress * 0.30, -0.30, 0.45);
  // A rezoning is a multi-year political process — roughly one district every
  // four or five years across the whole town, and MORE OFTEN when the town
  // cannot house what wants to be in it. The draw happens either way, so the
  // RNG stream is untouched and every paired run in the audits still lines up.
  if (rng(s) > 0.019 * clamp(1 + scarcity * 2.4, 0.45, 2.4)) return;

  // gather districts and how they are doing
  const byDist = new Map<string, { built: number; envelope: number; demand: number; n: number }>();
  for (const bbl of bbls) {
    const rec = parcels[bbl];
    if (!rec || !rec.lotArea) continue;
    const live = resolveRec(parcels, s, bbl);
    if (!live) continue;
    const d = rec.district || "—";
    const e = byDist.get(d) ?? { built: 0, envelope: 0, demand: 0, n: 0 };
    // COUNTED ON THE PARCELS THAT HAVE BUILDINGS, which is the question a
    // planning board is actually asking: has this neighbourhood used the
    // allowance it already has. The old ratio divided by the whole district
    // INCLUDING its vacant lots — the comment below even said so, "a third of
    // every district is vacant lots and the ratio is structurally low" — and
    // the base probability was then raised to compensate for a denominator
    // that was wrong. Fixing the ratio is what lets the base be honest.
    if (live.bldgArea > 0) {
      e.built += live.bldgArea;
      e.envelope += live.lotArea * Math.max(live.farMaxComm, live.farMaxRes, 2);
    }
    e.demand += live.demandScore;
    e.n++;
    byDist.set(d, e);
  }
  const rows = [...byDist.entries()].filter(([, v]) => v.n >= 20);
  if (!rows.length) return;

  const pick = rows[Math.floor(rng(s) * rows.length)];
  const [dist, v] = pick;
  const usedUp = v.envelope > 0 ? v.built / v.envelope : 0;
  const demand = v.demand / v.n;
  const cur = s.zoneAdj[dist] ?? 1;

  // A district that has built out its envelope and is somewhere people want to
  // be gets more envelope. One that is half empty does not need any, and a
  // place going backwards gets held down.
  // CITIES DENSIFY. Over a century upzonings comfortably outnumber
  // downzonings — a growing town keeps finding it needs more room, and the
  // downzonings are the exceptions that make the news. The first cut of this
  // read `usedUp` straight and biased hard the other way, because a third of
  // every district is vacant lots and the ratio is structurally low: nine
  // districts were downzoned for every three upzoned across three centuries.
  // WHERE THIS PROCESS IS NEUTRAL, which nothing here had worked out.
  //
  // The walk is multiplicative: an up step averages x1.285 and a down step
  // x0.91. So it is flat only where
  //     p·ln(1.285) + (1-p)·ln(0.91) = 0   =>   p = 0.273
  // and ANY base above that compounds without limit. The base was 0.42 before
  // the other three terms were even added, so every district in every town
  // drifted upward for ever, and the only thing stopping it was FAR_CEIL.
  //
  // Measured on the shipped island: 58.7% of the city was upzoned within TEN
  // YEARS and 99.8% by year 50, with the median parcel's envelope pinned at
  // exactly 2.6x its generated value — the ceiling, to the digit. A variable
  // resting on its rail in normal play is the rail holding up the model.
  //
  // That mattered far beyond zoning, because LAND IS PRICED OFF THE ENVELOPE
  // YOU ARE ALLOWED TO BUILD. With the whole city permanently upzoned 2.6x,
  // the residual concluded that essentially every parcel was a teardown: by
  // year 10, 69% of built parcels were worth more as bare dirt than as
  // standing buildings, and real land ran from $98/sf to $1,918/sf in a decade.
  // This is the mechanism behind the owner's report that land prices become
  // "too inflated and deflated", and the compounding is the whole of it.
  //
  // So the probability is CENTRED on neutral and moves with the one thing a
  // planning board actually responds to: whether the neighbourhood has used
  // the allowance it already has. A district that has built out asks for more
  // and gets it; a district sitting on unused envelope does not, which is what
  // makes the process self-limiting instead of a ratchet.
  const up = clamp(NEUTRAL_P + (usedUp - 0.45) * 1.1 + (demand - 50) / 150 + scarcity, 0.05, 0.95);
  const isUp = rng(s) < up;
  const step = isUp ? rrange(s, 1.12, 1.45) : rrange(s, 0.86, 0.96);
  const next = clamp(cur * step, FAR_FLOOR, FAR_CEIL);
  if (Math.abs(next - cur) < 0.02) return;
  s.zoneAdj[dist] = +next.toFixed(3);
  if (!s.zoneLog) s.zoneLog = {};
  s.zoneLog[dist] = { m: s.month, dir: isUp ? 1 : -1, adj: s.zoneAdj[dist] };

  // Land reprices the day it passes, because the envelope IS the land value.
  for (const bbl of bbls) {
    if (parcels[bbl]?.district !== dist) continue;
    s.landAdj[bbl] = Math.min(4, (s.landAdj[bbl] ?? 1) * (isUp ? 1 + (step - 1) * 0.45 : 1 - (1 - step) * 0.4));
  }
  const yours = Object.keys(s.holdings).filter((b) => parcels[b]?.district === dist).length;
  s.news.unshift({
    q: s.month, kind: isUp ? "event" : "warn",
    text: isUp
      ? `${dist} has been upzoned — the envelope goes to ${(next * 100).toFixed(0)}% of what it was at the start. `
        + `Every lot there is worth more this morning than it was last night${yours ? `, and you own ${yours} of them` : ""}.`
      : `${dist} has been downzoned to ${(next * 100).toFixed(0)}% of its original envelope. `
        + `The neighbourhood fought it and won${yours ? `, and you are holding ${yours} lots there` : ""}.`,
  });
}

// ------------------------------------------------------------------ variance

function pendingVariances(s: GameState): Record<string, VarianceApplication> {
  if (s.varianceApps) return s.varianceApps;
  return s.varianceApp ? { [s.varianceApp.bbl]: s.varianceApp } : {};
}

/** What it costs to try, and what the odds actually are. */
export function varianceQuote(
  s: GameState, parcels: ParcelTable, bbl: string, targetFar?: number,
) {
  const rec = resolveRec(parcels, s, bbl);
  if (!rec || !rec.lotArea) return null;
  if (s.landmarks?.[bbl] !== undefined) return null;
  const land = landValue(rec, s.econ);
  const current = Math.max(rec.farMaxComm, rec.farMaxRes, 2);
  const maxTarget = Math.min(FAR_CEILING, current * 3);
  if (maxTarget <= current + 0.05) return null;
  const target = clamp(
    Number.isFinite(targetFar as number) ? (targetFar as number) : current * 1.34,
    current * 1.10,
    maxTarget,
  );
  const askShare = target / current - 1;
  // Lawyers, an architect, an expediter, and a year of hearings. It scales
  // with what is at stake, because so do the objectors.
  const baseCost = Math.max(120_000, land * 0.035) * s.econ.costIdx;
  // Bigger asks draw more design work, opposition and hearing time, but not
  // linearly: the same survey, counsel and environmental record serve the
  // whole application. The old +34% request is the pivot and prices exactly as
  // before.
  const scale = Math.sqrt(askShare / 0.34);
  // Prior relief is allowed — the board can bend again — but each FAR already
  // won makes the next hearing harder and more expensive. Absolute stop is the
  // city ceiling on the resolved envelope (current already includes variance);
  // without that decay a patient refile loop once walked a parcel past forty.
  const already = s.variance?.[bbl] ?? 0;
  const priorCost = already > 0 ? 1.35 + 0.12 * already : 1;
  const priorOdds = already > 0 ? Math.exp(-0.55 * already) : 1;
  const cost = Math.round(baseCost * scale * priorCost);
  const months = Math.round(9 + 6 * scale + (already > 0 ? 3 : 0));
  const grant = +(target - current).toFixed(2);
  // A site the neighbourhood already accepts as dense is an easier hearing
  // than one on a quiet street.
  const dense = clamp(demandLinear(rec.demandScore) / 130, 0.1, 0.75);
  const ordinaryOdds = clamp(0.30 + dense - (s.econ.phase === "recession" ? 0.08 : 0), 0.08, 0.82);
  // Asking beyond the old one-third request is possible, not free. Opposition
  // compounds with the magnitude of relief; a 2× envelope has roughly half
  // the ordinary odds and a 3× ask is a genuine long shot.
  const odds = clamp(
    ordinaryOdds * Math.exp(-1.1 * Math.max(0, askShare - 0.34)) * priorOdds,
    0.02, 0.82,
  );
  return { cost, months, grant, targetFar: +target.toFixed(2), currentFar: current, odds };
}

export function fileVariance(
  s: GameState, parcels: ParcelTable, bbl: string, targetFar?: number,
): { s: GameState; err?: string; msg?: string } {
  if (!s.holdings[bbl]) return { s, err: "You have to own it to ask for anything." };
  if (pendingVariances(s)[bbl]) return { s, err: "This site already has an application in front of the board." };
  if (s.landmarks?.[bbl] !== undefined) return { s, err: "It is landmarked. The envelope is the envelope." };
  const q = varianceQuote(s, parcels, bbl, targetFar);
  if (!q) {
    // "NOTHING TO APPLY FOR HERE" WAS SEVERAL ANSWERS WEARING ONE SENTENCE.
    // varianceQuote returns null for an unknown parcel, a lot with no area, a
    // landmark, or a site already at the city FAR ceiling — and a refusal that
    // does not name its reason looks like a broken button.
    const rec = resolveRec(parcels, s, bbl);
    if (!rec) return { s, err: "There is no parcel there to apply about." };
    if (!rec.lotArea) {
      return {
        s,
        err: s.merged?.[bbl]
          ? `${rec.address} is part of an assemblage — its land has moved into the site it was folded into. `
            + "Apply on the parent lot, which is the one the board thinks exists."
          : `${rec.address} has no lot area on record, so there is no site to grant relief on. `
            + "That is a fault rather than a rule — please report the address.",
      };
    }
    const current = Math.max(rec.farMaxComm, rec.farMaxRes, 2);
    if (current >= FAR_CEILING - 0.05) {
      return { s, err: `The envelope is already at the city ceiling (${FAR_CEILING} FAR). There is nothing more to ask for.` };
    }
    return { s, err: "Nothing to apply for here." };
  }
  if (s.cash < q.cost) return { s, err: `The application runs $${(q.cost / 1e6).toFixed(2)}M in fees — you're short.` };
  const next: GameState = cloneState(s);
  next.cash -= q.cost;
  logBooks(next, "dev", q.cost);
  next.varianceApps = {
    ...pendingVariances(next),
    [bbl]: { bbl, filedM: next.month, decideM: next.month + q.months, cost: q.cost, grant: q.grant, odds: q.odds },
  };
  delete next.varianceApp;
  const rec = resolveRec(parcels, next, bbl);
  next.news.unshift({
    q: next.month, kind: "info",
    text: `Application filed at ${rec?.address ?? bbl}: ${q.grant.toFixed(1)} FAR over the district maximum. `
      + `The board sits ${monthLabel(next.month + q.months)} and they say yes about ${(q.odds * 100).toFixed(0)}% of the time.`,
  });
  return { s: next, msg: "Filed." };
}

function decideVariance(s: GameState, parcels: ParcelTable) {
  const apps = pendingVariances(s);
  if (!Object.keys(apps).length) return;
  // Migrate the old singular field even when none of the hearings is due yet.
  s.varianceApps = { ...apps };
  delete s.varianceApp;
  const due = Object.values(apps)
    .filter((app) => s.month >= app.decideM)
    .sort((a, b) => a.decideM - b.decideM || a.bbl.localeCompare(b.bbl));
  for (const app of due) {
    const rec = resolveRec(parcels, s, app.bbl);
    delete s.varianceApps[app.bbl];
    if (!s.holdings[app.bbl]) continue;      // sold it while they deliberated
    const granted = rng(s) < app.odds;
  // THE DECISION IS A FACT ABOUT THE SITE. Recorded on the parcel, not just
  // announced once and scrolled away — a refusal sits over a property for
  // years and everybody in the neighbourhood knows about it.
    if (!s.varianceLog) s.varianceLog = {};
    s.varianceLog[app.bbl] = { m: s.month, granted, far: app.grant, cost: app.cost };
    recordPropertyEvent(s, app.bbl, {
      kind: "planning",
      amount: app.cost,
      outcome: granted
        ? `Variance granted: +${app.grant.toFixed(1)} FAR`
        : `Variance refused: +${app.grant.toFixed(1)} FAR requested`,
    });
    if (granted) {
      if (!s.variance) s.variance = {};
      s.variance[app.bbl] = +((s.variance[app.bbl] ?? 0) + app.grant).toFixed(2);
      s.landAdj[app.bbl] = Math.min(4, (s.landAdj[app.bbl] ?? 1) * 1.22);
      s.news.unshift({
        q: s.month, kind: "deal",
        text: `The board approved the variance at ${rec?.address ?? app.bbl}. `
          + `${app.grant.toFixed(1)} FAR of extra envelope, and the dirt underneath it just repriced.`,
      });
    } else {
      s.news.unshift({
        q: s.month, kind: "warn",
        text: `The board refused the variance at ${rec?.address ?? app.bbl}. The fees are spent and the envelope is what it always was.`,
      });
    }
  }
}

// ----------------------------------------------------------------- landmarks

/**
 * The city designates a building, and it is not a gift.
 *
 * You lose the redevelopment option permanently — no demolition, no bigger
 * building on that site, ever. What you get is a building people care about,
 * which lets a little better than the market and holds its tenants. Whether
 * that trade is good depends entirely on whether the site was worth more than
 * the building, which is the same question every preservation fight is about.
 */
function tickLandmarks(s: GameState, parcels: ParcelTable, bbls: string[]) {
  if (rng(s) > 0.006) return;
  // old, characterful, and somewhere that has become worth caring about
  const cands = bbls.filter((b) => {
    if (s.landmarks?.[b] !== undefined || s.developments[b]) return false;
    const rec = resolveRec(parcels, s, b);
    return !!rec && rec.class !== "land" && rec.bldgArea > 0
      && rec.yearBuilt > 0 && rec.yearBuilt < 1940 && demandLinear(rec.demandScore) > 45;
  });
  if (!cands.length) return;
  const bbl = cands[Math.floor(rng(s) * cands.length)];
  const rec = resolveRec(parcels, s, bbl)!;
  if (!s.landmarks) s.landmarks = {};
  s.landmarks[bbl] = s.month;
  const mine = !!s.holdings[bbl];
  if (mine) s.holdings[bbl].landmarked = true;
  s.news.unshift({
    q: s.month, kind: mine ? "warn" : "info",
    text: `${rec.address} has been landmarked${mine ? " — one of yours" : ""}. `
      + `Nobody knocks it down now, and nobody builds anything bigger there. `
      + `It will let a little better than the market for the rest of its life, which is the whole of what you get for the site.`,
  });
}

export function tickPlanning(s: GameState, parcels: ParcelTable, bbls: string[]) {
  decideVariance(s, parcels);
  tickZoning(s, parcels, bbls);
  tickLandmarks(s, parcels, bbls);
}
