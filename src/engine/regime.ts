/**
 * THE DECADE YOU INHERIT.
 *
 * Every game of this used to open on exactly the same board. Measured across
 * twelve fresh seeds: identical rent indices, identical 11.5% vacancy,
 * identical 5.40% loan rate, identical 240,000 people, identical 35 firms with
 * identical names, identical fifteen listings, and the phase always
 * "expansion". The seed changed the weather from month one onward and changed
 * nothing at all about where you were standing when it started.
 *
 * That is not how anybody comes into this business. Buying your first building
 * in 1974 is a different profession from buying it in 1994, and the difference
 * is not difficulty — it is which problem you have. So a new game now draws a
 * STARTING REGIME: where in the cycle the city is, what money costs, what
 * inflation is doing, and how much empty space there is.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. THE DRAW IS COHERENT, NOT TWELVE DICE. Real macro variables are locked
 *    together. High inflation means a high policy rate, because the bank is
 *    responding to it. High vacancy means soft rents, because that is what
 *    vacancy does. Drawing each independently would produce a 14% policy rate
 *    beside 1% inflation, which is not variety, it is a fake number with extra
 *    steps. So an ERA is drawn first and everything else follows from it.
 *
 * 2. AN ERA IS NOT A DIFFICULTY SETTING. A high-rate, high-vacancy start is
 *    harder to borrow into and cheaper to buy in; a boom start is easy money
 *    and nothing on the shelf worth owning. Neither is the easy roll, and the
 *    archetypes are not tuned so that they score the same — they are the
 *    positions the American property market has actually opened from, and the
 *    consequences fall where they fall.
 *
 * THE OTHER HALF: A CENTURY SHOULD CONTAIN MORE THAN ONE MONETARY WORLD.
 *
 * A starting draw on its own washes out. The engine mean-reverts `neutralReal`
 * to a fixed 1.2% and the Taylor rule targets a hardcoded 2% inflation, so
 * whatever era you start in, you are back in the same one within a decade.
 * Measured over twenty-two unplayed centuries: the loan index sat above 11%
 * in 1.4% of months and TWELVE OF THE TWENTY-TWO CENTURIES NEVER SAW IT AT
 * ALL, against roughly 6-7% of the last real American century. Inflation ran
 * over 6% in 1.1% of months against roughly 10% in life.
 *
 * The reason is that 2% is written down as a constant, and it was not a
 * constant. Before 1990 no central bank had an explicit target at all; the
 * implicit one drifted with the politics, ran near 4-5% through the 1960s and
 * 70s, and only converged on 2% after a deliberate and expensive campaign to
 * put it there. So `inflTarget` becomes slow-moving state — anchored hard when
 * the bank is credible, free to drift when it is not — which is what lets a
 * century contain a Great Inflation, a Volcker, and a long disinflation
 * instead of one flat line with excursions.
 */
import type { GameState, Econ } from "./types";
import { mulberry32Step } from "./market";

/**
 * THIS DRAWS FROM ITS OWN GENERATOR. The engine has one shared PRNG for the
 * whole world, and anything that consumes it a different number of times
 * re-rolls the century — the payroll module learned this the expensive way
 * (see staff.ts). The regime is chosen once, before month one, and must not
 * shift the sequence the rest of the simulation is going to draw from.
 */
function rrng(seed: number, step: number): number {
  let st = (seed ^ 0x9e3779b9) | 0;
  for (let i = 0; i <= step; i++) st = mulberry32Step(st).state;
  return mulberry32Step(st).value;
}

export interface Era {
  key: string;
  label: string;
  /** one line the player reads on the opening screen */
  blurb: string;
  infl: [number, number];
  policy: [number, number];
  neutralReal: [number, number];
  /** how much the public believes the bank. Low credibility is what lets inflation run. */
  credibility: [number, number];
  inflTarget: [number, number];
  unemp: [number, number];
  /** office vacancy at the start, as a multiple of natural */
  vac: [number, number];
  /** rent index as a multiple of the long-run base, given that vacancy */
  rent: [number, number];
  /** cap rates move with money, not against it */
  capBump: [number, number];
  creditIdx: [number, number];
  phase: Econ["phase"];
  weight: number;
}

/**
 * FIVE POSITIONS THE AMERICAN PROPERTY MARKET HAS ACTUALLY OPENED FROM.
 *
 * The numbers in each are the real ones, not a spread around a mean. Weights
 * are how much of the last century each describes, so a fresh game is most
 * often ordinary and occasionally is not — which is also true of life.
 */
/**
 * WHAT THE GOVERNMENT INSURES, BY ERA — the fact that decides whether a bank
 * failure is a headline or a catastrophe for the people who banked there.
 *
 * These are the real FDIC limits and the real dates, and they are the reason
 * the same event feels completely different depending on when the game opens:
 *   1934 $2,500 · 1934 $5,000 · 1950 $10,000 · 1966 $15,000 · 1969 $20,000
 *   1974 $40,000 · 1980 $100,000 · 2008 $250,000 (permanent 2010)
 *
 * Mapped onto the five eras this engine actually opens from. In a postwar game
 * the limit is $10-20k and a failure genuinely wipes households out; in a ZIRP
 * game it is $250k and almost every resident is whole, so the damage has to
 * travel by another road entirely — uninsured BUSINESS deposits and the
 * withdrawal of local credit. That difference is a consequence of the date,
 * which is exactly how it works in life.
 *
 * Expressed in year-2000 dollars, like every other salary and price in this
 * engine; the reader multiplies by costIdx.
 */
export const DEPOSIT_INSURANCE: Record<string, number> = {
  postwar: 20_000,
  greatinflation: 40_000,
  volcker: 100_000,
  disinflation: 100_000,
  zirp: 250_000,
};

export const ERAS: Era[] = [
  {
    key: "postwar", label: "A long expansion",
    blurb: "Money is cheap, the town is filling up, and everybody you meet is sure it continues.",
    infl: [0.015, 0.032], policy: [3.0, 5.5], neutralReal: [0.015, 0.024],
    credibility: [0.72, 0.88], inflTarget: [0.020, 0.030], unemp: [0.040, 0.055],
    vac: [0.72, 0.95], rent: [1.00, 1.18], capBump: [-0.4, 0.3], creditIdx: [0.98, 1.10],
    phase: "expansion", weight: 30,
  },
  {
    key: "greatinflation", label: "The Great Inflation",
    blurb: "Prices are running, the bank has lost the argument, and a mortgage costs more every quarter you wait.",
    infl: [0.055, 0.105], policy: [8.0, 14.0], neutralReal: [0.018, 0.028],
    credibility: [0.28, 0.48], inflTarget: [0.035, 0.055], unemp: [0.055, 0.078],
    vac: [0.85, 1.15], rent: [0.86, 1.02], capBump: [1.4, 2.8], creditIdx: [0.72, 0.92],
    phase: "peak", weight: 13,
  },
  {
    key: "volcker", label: "The morning after",
    blurb: "Rates are at the moon to kill the inflation, half the tape is a receiver, and nobody can borrow a dollar.",
    infl: [0.030, 0.065], policy: [10.0, 16.0], neutralReal: [0.020, 0.030],
    credibility: [0.40, 0.62], inflTarget: [0.025, 0.040], unemp: [0.078, 0.105],
    vac: [1.25, 1.75], rent: [0.62, 0.82], capBump: [2.0, 3.6], creditIdx: [0.48, 0.68],
    phase: "recession", weight: 11,
  },
  {
    key: "disinflation", label: "The long disinflation",
    blurb: "Money gets cheaper every year, the empty space from the last bust is still letting, and values only go up.",
    infl: [0.018, 0.038], policy: [4.5, 8.0], neutralReal: [0.012, 0.022],
    credibility: [0.62, 0.82], inflTarget: [0.020, 0.032], unemp: [0.050, 0.070],
    vac: [1.05, 1.40], rent: [0.78, 0.96], capBump: [0.2, 1.2], creditIdx: [0.85, 1.02],
    phase: "recovery", weight: 26,
  },
  {
    key: "zirp", label: "After the crash",
    blurb: "Money is nearly free and nobody wants it. Half the buildings in town changed hands at the courthouse.",
    infl: [0.002, 0.018], policy: [0.25, 2.0], neutralReal: [0.001, 0.010],
    credibility: [0.70, 0.90], inflTarget: [0.016, 0.024], unemp: [0.070, 0.098],
    vac: [1.20, 1.60], rent: [0.70, 0.90], capBump: [-0.8, 0.4], creditIdx: [0.42, 0.66],
    phase: "recovery", weight: 20,
  },
];

const pick = (r: number, lo: number, hi: number) => lo + r * (hi - lo);

export function chooseEra(seed: number): Era {
  const total = ERAS.reduce((a, e) => a + e.weight, 0);
  let x = rrng(seed, 0) * total;
  for (const e of ERAS) { x -= e.weight; if (x <= 0) return e; }
  return ERAS[0];
}

/**
 * Apply the era to a freshly built economy. Called from initEcon after the
 * baseline is laid down, so everything here is a deliberate departure from the
 * old fixed opening and the old opening is still what `postwar` at the middle
 * of its ranges looks like.
 */
export function applyEra(econ: Econ, seed: number, natural: Record<string, number>): Era {
  const era = chooseEra(seed);
  const nat = econ.nat;
  if (!nat) return era;                       // nothing to position yet
  let k = 1;
  const d = (lo: number, hi: number) => pick(rrng(seed, k++), lo, hi);

  const infl = d(...era.infl);
  const policy = d(...era.policy);
  nat.infl = infl;
  // Expectations lag realised inflation and lag it further when nobody
  // believes the bank — which is the mechanism that makes an inflation
  // persist rather than a number that decides it should.
  const cred = d(...era.credibility);
  nat.credibility = cred;
  nat.inflExp = infl * (1 - cred * 0.45) + 0.02 * cred * 0.45;
  nat.policy = policy;
  nat.neutralReal = d(...era.neutralReal);
  // The era sets where r* is AND where it is heading, so a high-rate world
  // does not quietly decay into the low-rate one inside twenty years.
  nat.neutralAnchor = Math.max(0.004, Math.min(0.032, nat.neutralReal + d(-0.004, 0.004)));
  nat.unemp = d(...era.unemp);
  nat.inflTarget = d(...era.inflTarget);
  econ.unemployment = nat.unemp;
  econ.phase = era.phase;

  // The space market, positioned consistently with the money. Vacancy is drawn
  // as a multiple of each class's own natural rate so a glut is a glut
  // everywhere rather than a number that only means something to offices,
  // and the classes do not move in perfect lockstep because they never do.
  const vacMult = d(...era.vac);
  for (const cls of Object.keys(econ.cityVac) as (keyof typeof econ.cityVac)[]) {
    const jitter = d(0.88, 1.12);
    econ.cityVac[cls] = Math.max(0.02, Math.min(0.40, (natural[cls] ?? 0.11) * vacMult * jitter));
  }
  // Rents follow the vacancy, not a separate roll of the dice.
  const rentMult = d(...era.rent);
  for (const cls of Object.keys(econ.rentIdx) as (keyof typeof econ.rentIdx)[]) {
    econ.rentIdx[cls] = +(econ.rentIdx[cls] * rentMult * d(0.95, 1.05)).toFixed(2);
  }
  econ.effRentIdx = { ...econ.rentIdx };

  // Cap rates move WITH money. A property yield is a bond yield plus a spread,
  // so an era that opens at 14% short rates does not also open at a 5% cap.
  const bump = d(...era.capBump);
  for (const cls of Object.keys(econ.capRate) as (keyof typeof econ.capRate)[]) {
    econ.capRate[cls] = +Math.max(3.2, Math.min(14, econ.capRate[cls] + bump + d(-0.2, 0.2))).toFixed(2);
  }
  econ.creditIdx = +d(...era.creditIdx).toFixed(3);

  // AND WHAT A BORROWER ACTUALLY PAYS. The loan index is the policy rate plus
  // a term premium that widens when credit is frightened — the same identity
  // tickEcon uses every month. Without setting it here the opening screen
  // quoted 5.40% in a game whose central bank was at 13.3%, which is not a
  // starting position, it is two starting positions in one economy.
  const termPrem = 1.55 + 1.85 * Math.max(0, 1 - econ.creditIdx);
  econ.indexRate = +Math.max(0.75, Math.min(22, nat.policy + termPrem)).toFixed(2);
  econ.rateEma = econ.indexRate;
  econ.rateRegime = econ.indexRate;
  return era;
}

/**
 * THE TARGET IS NOT A CONSTANT OF NATURE.
 *
 * Called once a month from tickEcon. A credible bank's target barely moves —
 * that is what credibility IS. A bank that has lost the public drifts toward
 * whatever inflation has actually been running, which is the mechanism behind
 * every real inflation that got away: the target follows the outcome instead
 * of the outcome following the target.
 *
 * Bounded 1.2% to 6%. The floor is the modern world; the ceiling is roughly
 * where the United States actually got to before somebody decided to stop it,
 * and the engine's existing Volcker restore term is what stops it here too.
 */
export function driftInflTarget(econ: Econ, rnd: number) {
  const n = econ.nat;
  if (!n) return;
  if (n.inflTarget === undefined) n.inflTarget = 0.02;
  const cred = n.credibility ?? 0.8;
  // pull toward realised inflation, at a speed set by how little anyone
  // believes the bank; and a slow anchor back toward 2% when they do
  const drag = (1 - cred) * 0.010;
  const anchor = cred * 0.004;
  n.inflTarget = Math.max(0.012, Math.min(0.060,
    n.inflTarget + drag * ((n.inflExp ?? n.infl ?? 0.02) - n.inflTarget)
    + anchor * (0.02 - n.inflTarget)
    + (rnd - 0.5) * 0.00035));
}

export function eraOf(s: GameState): Era | null {
  const k = s.econ?.eraKey;
  return k ? ERAS.find((e) => e.key === k) ?? null : null;
}
