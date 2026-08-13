// REACHABILITY — when does each Principal mechanic first fire?
//   pnpm engine && node test/principal-reach.mjs
//
// A playtest that cannot hit succession / fund / spinout in ~30–40 years
// wastes the session. Measure medians; do not tune.
import { assertFreshBundle } from "./fresh.mjs";
if (!process.env.ENGINE) assertFreshBundle();
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(process.env.ENGINE ? join(HERE, "..", process.env.ENGINE) : join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

const SEEDS = (process.env.SEEDS || "550991,12007,73303,11,22,33,4242,91117").split(",").map(Number);
const HZ = +(process.env.HZ || 600); // 50 years default
const START_AGES = [
  { age: 28, cash: 1_000_000 },
  { age: 35, cash: 2_500_000 },
  { age: 42, cash: 5_000_000 },
  { age: 48, cash: 10_000_000 },
  { age: 52, cash: 20_000_000 },
];

const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const yr = (m) => (m == null ? "—" : `y${(m / 12).toFixed(1)} (m${m})`);

function resurrect(g) {
  if (g.gameOver) return { ...g, gameOver: null, cash: Math.max(g.cash, 6_000_000) };
  return g;
}

function runSeed(seed, cash0, ageOverride) {
  const { parcels, bbls, adjacency } = loadCity(seed % 4, E.normalizeParcels);
  let g = E.firstListings(E.newGame(seed, parcels, cash0), parcels, bbls);
  if (ageOverride != null && g.principal) {
    // Force start age for reachability of player death (lifeForCash already pairs).
    const bornM = g.month - Math.round(ageOverride * 12);
    g = structuredClone(g);
    g.principal.bornM = bornM;
    g.startAge = ageOverride;
    // Keep the pre-drawn diesM — it was drawn at creation from the table at
    // the ORIGINAL age. Re-draw once so the life table matches the start age
    // under test (peopleRng advanced — this is a probe, not a paired test).
    g.principal.diesM = E.drawDeathM(g, bornM, g.month);
  }

  const out = {
    seed,
    cash0,
    startAge: ageOverride ?? g.startAge ?? E.ageYears(g.principal, g.month),
    diesM: g.principal?.diesM ?? null,
    firstRivalDeath: null,
    firstEstateListing: null,
    playerDeath: null,
    successionOk: null,
    gameOverAtDeath: null,
    frozenAfter: null,
    fundRaiseEligible: null,
    fundRaised: null,
    firstPromote: null,
    firstFounderBid: null,
    firstSpinout: null,
    careerVisible: null,
    peopleRngStepsByMonth: [],
  };

  // Career visible = principal has a class with ≥36 months (familiarity bites).
  const careerVisibleAt = (gg) => {
    const c = gg.principal?.career?.classM ?? {};
    return Object.values(c).some((m) => (m ?? 0) >= 36);
  };
  if (careerVisibleAt(g)) out.careerVisible = 0;

  for (let i = 0; i < HZ; i++) {
    const rng0 = g.peopleRng;
    const deaths0 = Object.values(g.rivalPrincipals ?? {}).filter((p) => p.diedM != null).length;
    const estateList0 = (g.listings ?? []).filter((l) => l.reason === "estate").length;
    const promote0 = g.fund?.promotePaid ?? 0;
    const spin0 = (g.rivals ?? []).filter((r) => r.spawnedFrom).length;
    const bids0 = (g.founderBids ?? []).length;
    const deadName = g.principal?.name;

    // Fund eligibility before tick (quote is pure-ish).
    if (out.fundRaiseEligible == null) {
      const q = E.fundRaiseQuote(g);
      if (q.ok) out.fundRaiseEligible = g.month;
    }

    g = resurrect(E.advanceMonth(g, parcels, bbls, adjacency));
    out.peopleRngStepsByMonth.push((g.peopleRng - rng0) | 0); // not exact for mulberry; track state change presence

    // Rival death
    if (out.firstRivalDeath == null) {
      const deaths1 = Object.values(g.rivalPrincipals ?? {}).filter((p) => p.diedM != null).length;
      if (deaths1 > deaths0) out.firstRivalDeath = g.month;
    }
    if (out.firstEstateListing == null) {
      const estateList1 = (g.listings ?? []).filter((l) => l.reason === "estate").length;
      if (estateList1 > estateList0) out.firstEstateListing = g.month;
    }

    // Player death / succession
    if (out.playerDeath == null && g.estateDue && g.principal?.name !== deadName) {
      out.playerDeath = g.month;
      out.successionOk = g.principal?.seat === "you" && !g.gameOver;
      out.gameOverAtDeath = !!g.gameOver;
      // Frozen-world check: advance 3 more months; month must move.
      const m0 = g.month;
      let g2 = g;
      for (let k = 0; k < 3; k++) g2 = resurrect(E.advanceMonth(g2, parcels, bbls, adjacency));
      out.frozenAfter = g2.month === m0;
      g = g2;
    }

    // Fund auto-raise once eligible + rich enough (probe only — not player skill).
    if (!g.fund && out.fundRaiseEligible != null && out.fundRaised == null) {
      const q = E.fundRaiseQuote(g);
      if (q.ok) {
        const r = E.raiseFund(g);
        if (!r.err) {
          g = r.s;
          out.fundRaised = g.month;
          // Seed promote: call + distribute with pref cleared.
          if (g.fund) {
            const c = E.callFundCapital(g, g.fund.uncalled);
            if (!c.err) g = c.s;
            g = structuredClone(g);
            g.fund.prefAccrued = 0;
            const d = E.distributeFund(g, Math.min(500_000, g.fund.cash));
            if (!d.err) {
              g = d.s;
              if ((g.fund?.promotePaid ?? 0) > promote0) out.firstPromote = g.month;
            }
          }
        }
      }
    }
    if (out.firstPromote == null && (g.fund?.promotePaid ?? 0) > 0) {
      out.firstPromote = g.month;
    }

    if (out.firstFounderBid == null && (g.founderBids?.length ?? 0) > bids0) {
      out.firstFounderBid = g.month;
    }
    if (out.firstSpinout == null && (g.rivals ?? []).filter((r) => r.spawnedFrom).length > spin0) {
      out.firstSpinout = g.month;
    }

    if (out.careerVisible == null && careerVisibleAt(g)) out.careerVisible = g.month;
  }

  // Scheduled player death even if probe didn't land succession (diesM future).
  out.scheduledDeathM = g.principal?.diesM ?? out.diesM;
  if (out.playerDeath == null && out.diesM != null && out.diesM < HZ) {
    // Death should have fired — flag miss.
    out.playerDeathMissed = true;
  }
  return out;
}

console.log(`REACHABILITY — ${SEEDS.length} seeds × ${HZ}m (${(HZ / 12).toFixed(0)}y)\n`);

// --- A. Rival mortality + estate disposition (default $2.5M start) ---
{
  const rows = SEEDS.map((s) => runSeed(s, 2_500_000, null));
  const rd = rows.map((r) => r.firstRivalDeath);
  const el = rows.map((r) => r.firstEstateListing);
  console.log("A. RIVAL MORTALITY / ESTATE TAPE");
  console.log(`   first rival death     median ${yr(median(rd))}  n=${rd.filter((x) => x != null).length}/${rows.length}`);
  console.log(`   first estate listing  median ${yr(median(el))}  n=${el.filter((x) => x != null).length}/${rows.length}`);
  for (const r of rows) {
    console.log(`     seed ${r.seed}: death ${yr(r.firstRivalDeath)}  estate ${yr(r.firstEstateListing)}`);
  }
  console.log();
}

// --- B. Player death by start-age (scheduled diesM + whether succession fires) ---
{
  console.log("B. PLAYER DEATH BY START AGE (scheduled diesM from life table)");
  for (const life of START_AGES) {
    const rows = SEEDS.slice(0, 6).map((s) => {
      const { parcels } = loadCity(s % 4, E.normalizeParcels);
      let g = E.newGame(s, parcels, life.cash);
      // newGame already pairs age via lifeForCash — trust that, don't re-draw.
      const age = E.ageYears(g.principal, g.month);
      const diesM = g.principal.diesM;
      const deathAge = diesM != null ? (diesM - g.principal.bornM) / 12 : null;
      return { seed: s, age, diesM, deathAge, yearsLeft: diesM != null ? diesM / 12 : null };
    });
    const yearsLeft = rows.map((r) => r.yearsLeft);
    const deathAges = rows.map((r) => r.deathAge);
    console.log(`   start $${(life.cash / 1e6).toFixed(1)}M → age ${life.age}: median years-to-death ${yr(median(rows.map((r) => r.diesM)))}  median death-age ${median(deathAges)?.toFixed(1) ?? "—"}`);
    for (const r of rows) {
      console.log(`     seed ${r.seed}: age ${r.age} diesM ${r.diesM} (death age ${r.deathAge?.toFixed(1)}, in ${r.yearsLeft?.toFixed(1)}y)`);
    }
  }
  console.log();
}

// --- C. Succession actually fires + no freeze (oldest start, short horizon if needed) ---
{
  console.log("C. SUCCESSION FIRE (age-52 / $20M, advance to diesM+3)");
  const rows = [];
  for (const seed of SEEDS.slice(0, 6)) {
    const { parcels, bbls, adjacency } = loadCity(seed % 4, E.normalizeParcels);
    let g = E.firstListings(E.newGame(seed, parcels, 20_000_000), parcels, bbls);
    const diesM = g.principal.diesM;
    const horizon = Math.min(HZ, (diesM ?? 9999) + 6);
    let playerDeath = null, frozen = null, gameOver = null, heir = null;
    for (let i = 0; i < horizon; i++) {
      const name0 = g.principal?.name;
      g = E.advanceMonth(g, parcels, bbls, adjacency);
      if (g.gameOver) { gameOver = g.gameOver.cause; break; }
      if (!playerDeath && g.estateDue && g.principal?.name !== name0) {
        playerDeath = g.month;
        heir = g.principal?.name;
        const m0 = g.month;
        for (let k = 0; k < 3; k++) g = E.advanceMonth(g, parcels, bbls, adjacency);
        frozen = g.month === m0 || !!g.gameOver;
        break;
      }
    }
    rows.push({ seed, diesM, playerDeath, frozen, gameOver, heir, yearsLeft: diesM / 12 });
    console.log(`     seed ${seed}: diesM ${diesM} (${(diesM / 12).toFixed(1)}y) fired ${yr(playerDeath)} heir=${heir ?? "—"} frozen=${frozen} gameOver=${gameOver ?? "no"}`);
  }
  const fired = rows.filter((r) => r.playerDeath != null);
  console.log(`   fired ${fired.length}/${rows.length}; any freeze: ${rows.some((r) => r.frozen)}; any gameOver-on-death: ${rows.some((r) => r.gameOver)}`);
  console.log(`   median years-to-death at $20M: ${median(rows.map((r) => r.yearsLeft))?.toFixed(1)}y`);
  console.log();
}

// --- D. Fund raise eligibility (passive bot — exits hard) ---
{
  console.log("D. FUND RAISE ELIGIBILITY (unassisted — needs 2 clean exits + standing + phase)");
  const rows = SEEDS.slice(0, 6).map((s) => {
    const r = runSeed(s, 20_000_000, null);
    return r;
  });
  console.log(`   first eligible median ${yr(median(rows.map((r) => r.fundRaiseEligible)))}  n=${rows.filter((r) => r.fundRaiseEligible != null).length}/${rows.length}`);
  console.log(`   (promote in this probe is forced after raise — not organic crystallisation)`);
  for (const r of rows) {
    console.log(`     seed ${r.seed}: eligible ${yr(r.fundRaiseEligible)} raised ${yr(r.fundRaised)} promote ${yr(r.firstPromote)}`);
  }
  console.log();
}

// --- E. Founder departure / spinout ---
{
  console.log("E. STAFF DEPARTURE → FOUNDER BID / SPINOUT");
  const rows = SEEDS.slice(0, 6).map((s) => runSeed(s, 10_000_000, null));
  console.log(`   first founder bid median ${yr(median(rows.map((r) => r.firstFounderBid)))}  n=${rows.filter((r) => r.firstFounderBid != null).length}/${rows.length}`);
  console.log(`   first spinout     median ${yr(median(rows.map((r) => r.firstSpinout)))}  n=${rows.filter((r) => r.firstSpinout != null).length}/${rows.length}`);
  for (const r of rows) {
    console.log(`     seed ${r.seed}: bid ${yr(r.firstFounderBid)} spinout ${yr(r.firstSpinout)}`);
  }
  console.log();
}

// --- F. Career visible ---
{
  console.log("F. CAREER SPECIALISATION VISIBLE (≥36m class exposure on principal)");
  const rows = SEEDS.slice(0, 6).map((s) => runSeed(s, 5_000_000, null));
  console.log(`   median ${yr(median(rows.map((r) => r.careerVisible)))}  n=${rows.filter((r) => r.careerVisible != null).length}/${rows.length}`);
  for (const r of rows) console.log(`     seed ${r.seed}: ${yr(r.careerVisible)}`);
  console.log();
}

// --- G. peopleRng: does monthly step count depend on living population? ---
{
  console.log("G. peopleRng — event-month vs quiet-month (variable budget check)");
  const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);
  let g = E.firstListings(E.newGame(550991, parcels, 20_000_000), parcels, bbls);
  const samples = [];
  for (let i = 0; i < 360; i++) {
    const before = g.peopleRng;
    const deathsBefore = Object.values(g.rivalPrincipals ?? {}).filter((p) => p.diedM != null).length;
    g = resurrect(E.advanceMonth(g, parcels, bbls, adjacency));
    const deathsAfter = Object.values(g.rivalPrincipals ?? {}).filter((p) => p.diedM != null).length;
    samples.push({
      m: g.month,
      delta: (g.peopleRng >>> 0) !== (before >>> 0),
      deathMonth: deathsAfter > deathsBefore,
      living: Object.values(g.rivalPrincipals ?? {}).filter((p) => p.diedM == null).length,
    });
  }
  const quiet = samples.filter((s) => !s.deathMonth);
  const death = samples.filter((s) => s.deathMonth);
  const quietChanged = quiet.filter((s) => s.delta).length;
  const deathChanged = death.filter((s) => s.delta).length;
  console.log(`   quiet months: ${quiet.length}, peopleRng changed in ${quietChanged}`);
  console.log(`   death months: ${death.length}, peopleRng changed in ${deathChanged}`);
  console.log(`   (quiet months should be ~0 changes if no poach/hire/seedCareer; death months must change)`);
}

console.log("\nreach probe done");
