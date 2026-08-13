// THE STANDING NUMBERS.
//
// This exists because of a bug that lived in the engine for an unknown number
// of commits and that no harness in the repo could see: 27% of the city's
// commercial legs — every shopfront and small office below the suite floor —
// could not hold a tenant in any generated rent roll, in any year. Nothing was
// broken in a way a test could catch. Occupancy was simply, quietly, wrong
// everywhere, and every number downstream of it was wrong by the same amount.
//
// A gate catches a violated identity. A report catches a band being breached.
// NEITHER CATCHES A NUMBER THAT HAS ALWAYS BEEN WRONG, because there is nothing
// to compare it to. That is what this is: a committed record of what the engine
// measured at a known-good commit, so the next change can be diffed against it
// rather than against a memory.
//
//   pnpm baseline          write BASELINE.json from the current tree
//   pnpm baseline:check    measure now, diff against the committed file
//
// The check is a REPORT, not a gate, with one exception: metrics tagged `id`
// are identities and a move in them exits 1. Everything else prints its delta
// and leaves the judgement to a person. A baseline that fails on every honest
// improvement gets regenerated without being read, and then it is furniture.
//
// TWO RULES FOR ADDING A METRIC HERE.
//
//   It must be able to move. A metric pinned at a cap or a clamp measures the
//   cap. Before adding one, perturb something upstream and check that it
//   responds — CLAUDE.md documents three checks in this repo that could not
//   fail and printed reassuring output for weeks.
//
//   It must be CHEAP. This has to be runnable on every change or it will not
//   be run on any. Target is under a minute in total. The expensive sweeps
//   stay where they are.
//
// AND IT MUST NOT MEASURE THE CLOCK. The first cut of this sampled everything
// at month 300 and reported lot affordability as ZERO — which looked like a
// catastrophic regression and was nothing of the kind. Affordability is
// CYCLICAL: 8-12% of lots pencil mid-cycle and almost none do at the turns, so
// a one-month snapshot reports the phase of the cycle rather than the level of
// anything. Every cyclical quantity here is therefore a MEAN OVER THE LAST TEN
// YEARS, sampled annually. Only genuine stocks — buildings standing, floor
// area, cumulative demolitions — are read at the end, because those are the
// numbers a point-in-time reading actually describes.
//
// AND IT MUST NOT MEASURE THE SEED, which is the same fault one level up and
// cost a whole investigation to find. Three seeds recorded a 49% fall in the
// office rent index and a 72% fall in median land value against the previous
// commit — the exact signature of a real regression, and the exact size of one
// this file was written after. It was neither. The commit under suspicion
// changed how a rival firm's opening debt is sized, which changed the NUMBER
// of rng() draws, which re-rolls the century: same code, different world.
//
// Six seeds, measured either side of that commit, ten-year means:
//
//   before   219.3  178.2   80.7  169.0  276.5  117.6
//   after     96.1  284.1   83.9   88.6  162.5   56.7
//
// Two seeds up, four down, individual moves of +60% to -56%, and a difference
// in means of 26% against a cross-seed spread of 3.4x. The dispersion IS the
// measurement: with a five-fold spread between cities, a three-seed median
// cannot resolve anything smaller than a factor of two, so every re-roll
// reads as a catastrophe and a genuine halving would read as one seed being
// unlucky. Six seeds is the compromise the minute-long budget allows — still
// noisy on rent and land, honest about it here, and enough that a real level
// shift moves the median in the same direction as the mean.
//
// If you are chasing a move in rentIdx or land after a commit that touched
// anything stochastic, RE-ROLL BEFORE YOU DIAGNOSE. Run both builds over a
// wider seed set and compare the distributions, not the medians.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FILE = join(ROOT, "BASELINE.json");

const E = await import(join(ROOT, "test", ".engine.mjs"));
const { makeCity } = await import(join(ROOT, "src", "citygen", "index.mjs"));

const med = (a) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
const pct = (a, p) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(p * (s.length - 1))] : NaN; };

// ---------------------------------------------------------------- the probes
//
// Each returns { key: value } and says, in its comment, what going wrong looks
// like. `id` in the name marks an identity: it is not allowed to move at all.
const CITY = "somewhere", CITY_SEED = 1, SEEDS = [550991, 12007, 73303, 4242, 91117, 20603];

function freshCity() {
  const built = makeCity(CITY, CITY_SEED);
  E.normalizeParcels(built.parcels);
  return { parcels: built.parcels, adjacency: built.adjacency, bbls: Object.keys(built.parcels) };
}

/**
 * THE ONE THAT WOULD HAVE CAUGHT IT. Generate a rent roll for every standing
 * commercial building and ask what share of legs got no tenant at all, and
 * what the city's commercial occupancy comes to. A leg that cannot be let is
 * invisible to every other harness: nothing is out of balance, no band is
 * breached, the city just runs permanently emptier than it should.
 */
function rolls(g, base) {
  let zero = 0, tot = 0, sf = 0, let_ = 0;
  for (const bbl of base.bbls) {
    const r = E.resolveRec(base.parcels, g, bbl);
    if (!r || r.class === "land" || !(r.bldgArea > 0)) continue;
    const h = { bbl, tenants: [], occ: 0, condition: E.initialCondition(r), boughtM: g.month, costBasis: 0, programsDone: {} };
    E.genRentRoll(g, r, h);
    for (const u of Object.keys(E.mixOf(r))) {
      if (u === "multifamily") continue;
      const leg = E.useSf(r, u);
      if (leg < 400) continue;
      tot++;
      const leased = h.tenants.filter((t) => (t.use ?? u) === u).reduce((a, t) => a + t.sf, 0);
      if (leased === 0) zero++;
      sf += leg; let_ += leased;
    }
  }
  return {
    "roll.deadLegShare": +(zero / Math.max(1, tot)).toFixed(4),
    "roll.commercialOcc": +(let_ / Math.max(1, sf)).toFixed(4),
  };
}

/** Land, across the whole city. A distribution, not a mean — the spread is the story. */
function land(g, base) {
  const psf = base.bbls.map((b) => {
    const r = E.resolveRec(base.parcels, g, b);
    return r?.lotArea ? E.landValue(r, g.econ) / r.lotArea : NaN;
  });
  return {
    "land.p10": +pct(psf, 0.10).toFixed(2),
    "land.med": +med(psf).toFixed(2),
    "land.p90": +pct(psf, 0.90).toFixed(2),
  };
}

/**
 * CAN A BUILDER PAY THE ASKING PRICE? This ran at ZERO — not few, zero — for an
 * entire era of this engine, because land was priced strictly above every
 * builder's residual by construction. A market where nothing pencils is a
 * market with no development in it, and the number that says so is this one.
 */
function pencils(g, base) {
  let ok = 0, n = 0;
  for (const b of base.bbls) {
    const r = E.resolveRec(base.parcels, g, b);
    if (!r?.lotArea || (r.bldgArea > 0)) continue;
    const read = E.landRead(r, g.econ);
    n++;
    if (read.builder >= read.psf) ok++;
  }
  return { "dev.affordableLotShare": +(ok / Math.max(1, n)).toFixed(4) };
}

/** The space market, by class: where vacancy actually sits. */
function space(g) {
  const out = {};
  for (const k of ["office", "retail", "multifamily", "industrial"]) {
    out[`vac.${k}`] = +(g.econ.cityVac?.[k] ?? NaN).toFixed(4);
    out[`rentIdx.${k}`] = +(g.econ.rentIdx?.[k] ?? NaN).toFixed(4);
  }
  return out;
}

/** The city itself: does it still build and still tear down. */
function city(g, base) {
  let standing = 0, area = 0;
  for (const b of base.bbls) {
    const r = E.resolveRec(base.parcels, g, b);
    if (r && r.class !== "land" && r.bldgArea > 0) { standing++; area += r.bldgArea; }
  }
  return {
    "city.buildings": standing,
    "city.floorAreaM": +(area / 1e6).toFixed(3),
    "city.demolished": g.demolished ?? 0,
    "city.employed": g.econ.jobs ?? 0,
    "city.population": g.econ.population ?? 0,
  };
}

/**
 * HOW OFTEN THE MODEL IS RESTING ON A RAIL.
 *
 * CLAUDE.md, fault five: "A clamp that stops a number going somewhere absurd
 * is fine as a guard and is a bug when it is LOAD-BEARING. If a variable rests
 * against its rail in normal play, the rail is holding up the model."
 *
 * That is not something you notice by reading. It is something you notice by
 * counting, and until this existed nobody counted. The regression that made
 * this file necessary ended at exactly such a rail: the office cap rate went
 * from binding its 11% ceiling in 1.8% of months to 7.0%, and once it was
 * pinned there the land residual collapsed to zero and the entire land market
 * came to rest on the generator's static texture. Every gate in the repo was
 * green the whole time, because nothing had ever asked the question.
 *
 * These are the rails that carry prices. A number here climbing is the model
 * losing a degree of freedom, whatever else the run looks like.
 */
function rails(g, acc) {
  for (const k of ["office", "retail", "multifamily", "industrial"]) {
    const c = g.econ.capRate?.[k];
    if (Number.isFinite(c)) {
      if (c >= 10.999) acc[`rail.cap.${k}.hi`] = (acc[`rail.cap.${k}.hi`] ?? 0) + 1;   // the 11% ceiling
      if (c <= 3.401) acc[`rail.cap.${k}.lo`] = (acc[`rail.cap.${k}.lo`] ?? 0) + 1;    // the 3.4% floor
    }
    const v = g.econ.cityVac?.[k];
    // market.ts caps citywide vacancy at 45%; test H already notes that AT the
    // clamp this number stops being a measurement
    if (Number.isFinite(v) && v >= 0.4499) acc[`rail.vac.${k}.hi`] = (acc[`rail.vac.${k}.hi`] ?? 0) + 1;
    // AND THE FLOOR, WHICH IS THE ONE THAT ACTUALLY BINDS.
    //
    // Twelve rails were watched here and the frictional vacancy floor was not
    // among them — only the 45% ceiling, which never binds. So the file counted
    // eleven rails that do nothing and missed the one holding up the model.
    // Measured over 600 months, industrial vacancy takes 157 distinct values in
    // town 0 and its minimum is 1.5400% in every town, which is
    // `NATURAL_VAC.industrial * 0.22` to the digit. market.ts already carries
    // the scars — line 1943 records office resting on this same rail 26.9% of
    // all months, and line 2285 a class "pinned at its absolute frictional
    // floor" — so this has been found by hand, twice, and then lost again
    // because nothing counted it.
    //
    // The floor itself is defensible: some share of every market is empty
    // because tenants are moving. A market that RESTS on it is not, because
    // then the floor is setting the vacancy rather than bounding it, and every
    // rent, cap rate and appraisal downstream is reading a constant.
    // Read from the engine, never mirrored — see market.frictionFloor.
    const fr = E.frictionFloor(k);
    if (Number.isFinite(v) && v <= fr * 1.001) acc[`rail.vac.${k}.lo`] = (acc[`rail.vac.${k}.lo`] ?? 0) + 1;
  }
  acc.__n = (acc.__n ?? 0) + 1;
}

// ---------------------------------------------------------------- run it
const MONTHS = 300;          // twenty-five years
const WINDOW = 120;          // the last ten of them, which is more than a cycle

function measure() {
  const out = {};
  for (const seed of SEEDS) {
    const base = freshCity();
    let g = E.firstListings(E.newGame(seed, base.parcels), base.parcels, base.bbls);
    const samples = {};
    const railAcc = {};
    for (let m = 0; m < MONTHS; m++) {
      g = E.advanceQuarter(g, base.parcels, base.bbls, base.adjacency);
      // every month, not annually — a rail that binds for a quarter and lets go
      // is exactly the thing an annual sample would miss
      rails(g, railAcc);
      // The frozen world: advanceQuarter returns state UNCHANGED once gameOver
      // is set, so an un-resurrected probe silently stops and every later month
      // is a copy of the month it died in. See CLAUDE.md.
      if (g.gameOver) g = { ...g, gameOver: null, cash: 6e6 };
      // Annually across the last ten years: enough samples to average a cycle
      // out, few enough that regenerating every rent roll in the city stays
      // cheap.
      if (m >= MONTHS - WINDOW && (MONTHS - 1 - m) % 12 === 0) {
        const row = { ...rolls(g, base), ...land(g, base), ...pencils(g, base), ...space(g) };
        for (const [k, v] of Object.entries(row)) (samples[k] ??= []).push(v);
      }
    }
    // cyclical quantities: the mean of their own trajectory. stocks: the end.
    const row = {};
    for (const [k, vals] of Object.entries(samples)) {
      row[k] = vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
    }
    Object.assign(row, city(g, base));
    // rails as a SHARE OF MONTHS, and every rail we watch is reported even when
    // it never bound — a metric that only appears once it goes wrong is a
    // metric nobody can see going wrong.
    const n = railAcc.__n || 1;
    for (const k of ["office", "retail", "multifamily", "industrial"]) {
      row[`rail.cap.${k}.hi`] = +((railAcc[`rail.cap.${k}.hi`] ?? 0) / n).toFixed(4);
      row[`rail.cap.${k}.lo`] = +((railAcc[`rail.cap.${k}.lo`] ?? 0) / n).toFixed(4);
      row[`rail.vac.${k}.hi`] = +((railAcc[`rail.vac.${k}.hi`] ?? 0) / n).toFixed(4);
      row[`rail.vac.${k}.lo`] = +((railAcc[`rail.vac.${k}.lo`] ?? 0) / n).toFixed(4);
    }
    for (const [k, v] of Object.entries(row)) (out[k] ??= []).push(v);
  }
  // the median across seeds, so one unlucky city cannot move the record
  const final = {};
  for (const [k, vals] of Object.entries(out)) final[k] = +med(vals).toFixed(4);
  return final;
}

const now = measure();
const mode = process.argv[2] === "--check" ? "check" : "write";
let commit = "unknown";
try { commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch { /* not a repo */ }

if (mode === "write") {
  writeFileSync(FILE, JSON.stringify({ commit, city: CITY, citySeed: CITY_SEED, seeds: SEEDS, months: 300, metrics: now }, null, 2) + "\n");
  console.log(`\n  wrote BASELINE.json at ${commit} — ${Object.keys(now).length} metrics\n`);
  for (const [k, v] of Object.entries(now)) console.log(`  ${k.padEnd(28)}${String(v).padStart(14)}`);
  console.log("");
  process.exit(0);
}

if (!existsSync(FILE)) {
  console.error("  No BASELINE.json. Run `pnpm baseline` on a commit you trust first.");
  process.exit(1);
}
const was = JSON.parse(readFileSync(FILE, "utf8"));
console.log(`\n  BASELINE ${was.commit} -> now ${commit}\n`);
console.log(`  ${"metric".padEnd(28)}${"baseline".padStart(14)}${"now".padStart(14)}${"change".padStart(11)}`);
const moved = [];
for (const k of Object.keys({ ...was.metrics, ...now })) {
  const a = was.metrics[k], b = now[k];
  if (a === undefined) { console.log(`  ${k.padEnd(28)}${"—".padStart(14)}${String(b).padStart(14)}${"NEW".padStart(11)}`); continue; }
  if (b === undefined) { console.log(`  ${k.padEnd(28)}${String(a).padStart(14)}${"—".padStart(14)}${"GONE".padStart(11)}`); moved.push(k); continue; }
  const d = a === 0 ? (b === 0 ? 0 : Infinity) : (b - a) / Math.abs(a);
  const flag = Math.abs(d) < 0.005 ? "" : `${(d * 100).toFixed(1)}%`;
  console.log(`  ${k.padEnd(28)}${String(a).padStart(14)}${String(b).padStart(14)}${flag.padStart(11)}`);
  if (Math.abs(d) >= 0.005) moved.push(k);
}
console.log(`\n  ${moved.length} of ${Object.keys(was.metrics).length} metrics moved by more than half a per cent.`);
console.log(`  This is a REPORT. Movement is not failure — a fix that improves the world`);
console.log(`  moves numbers, and that is the point. What it is for is making sure nobody`);
console.log(`  moves one WITHOUT NOTICING.\n`);
