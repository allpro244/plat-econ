// THE STORIES PASS. centurymine.mjs counts things; this one finds the things
// worth telling. Building biographies, decade-by-decade city tables, and the
// question a player actually wants answered — is there a tell?
//
//   DIR=/tmp/century node tools/centurystories.mjs
//
// The tell section is deliberately not a correlation table. A correlation of
// -0.4 tells you nothing you can act on in March 2043. A rule tells you: when
// THIS is true, rents are lower three years later N% of the time, against a
// base rate of M%. If N is not far from M the signal is decoration.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.DIR ?? "/tmp/century";
const idx = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const M = (n) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`);
const yr = (m) => 2000 + Math.floor(m / 12);
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dt = (m) => `${MO[m % 12]} ${yr(m)}`;
const med = (a) => { const b = [...a].filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
const q = (a, p) => { const b = [...a].filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
const C = { m: 0, phase: 1, rOff: 2, rRet: 3, rMf: 4, rInd: 5, vOff: 6, vRet: 7, vMf: 8, vInd: 9,
  cap: 10, rate: 11, cpi: 12, wage: 13, pop: 14, jobs: 15, unemp: 16, credit: 17, land: 18, cost: 19,
  stock: 20, pipe: 21, nw: 22, holds: 23, natU: 24, natI: 25, policy: 26, demo: 27, built: 28 };
const say = (...a) => console.log(...a);
const H = (t) => say(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

const BLOCKS = "▁▂▃▄▅▆▇█";
function spark(vals, width = 60) {
  const step = Math.max(1, Math.floor(vals.length / width));
  const s = [];
  for (let i = 0; i < vals.length; i += step) s.push(vals[i]);
  const lo = Math.min(...s), hi = Math.max(...s);
  if (!(hi > lo)) return "─".repeat(s.length);
  return s.map((v) => BLOCKS[Math.min(7, Math.max(0, Math.round((v - lo) / (hi - lo) * 7)))]).join("");
}

const runs = idx.map((r) => JSON.parse(readFileSync(join(DIR, r.file), "utf8")));
const nulls = runs.filter((r) => r.meta.bot === "none");
say(`${runs.length} centuries — ${nulls.length} unplayed, ${runs.length - nulls.length} played`);

const rowAt = (run, y, bbl) => run.snapshots.find((s) => s.yr === y)?.rows.find((x) => x[0] === bbl) ?? null;
const addrOf = (run, bbl) => {
  for (const s of run.snapshots) { const r = s.rows.find((x) => x[0] === bbl); if (r) return r[9]; }
  return bbl;
};

// ---------------------------------------------------------------------------
H("BUILDING BIOGRAPHIES — the five busiest lots in a hundred years");
// A lot is interesting when a lot HAPPENED on it: deeds, wrecking balls,
// groundbreaks. Deliveries and demolitions count for more than trades because
// they are rarer and they change the skyline, not just the letterhead.
const lots = [];
for (const run of runs) {
  for (const [bbl, evs] of run.parcelEv) {
    const t = evs.filter((e) => e.kind === "trade");
    const dem = evs.filter((e) => e.kind === "demolish");
    const del = evs.filter((e) => e.kind === "deliver");
    if (!t.length && !dem.length && !del.length) continue;
    lots.push({ run, bbl, evs, score: t.length + dem.length * 6 + del.length * 6, nt: t.length, nd: dem.length, nb: del.length });
  }
}
lots.sort((a, b) => b.score - a.score);
// one lot per seed, so five biographies are five stories and not one story told
// five times from slightly different angles
const picked = [];
const seenSeed = new Set();
for (const l of lots) {
  const key = `${l.run.meta.marketSeed}`;
  if (seenSeed.has(key)) continue;
  seenSeed.add(key); picked.push(l);
  if (picked.length >= 5) break;
}
for (const l of picked) {
  const { run, bbl } = l;
  const a = addrOf(run, bbl);
  say(`\n${"-".repeat(78)}`);
  say(`${a}   [${bbl}]   seed ${run.meta.marketSeed} / ${run.meta.bot}`);
  say(`${l.nt} deeds, ${l.nb} buildings delivered, ${l.nd} demolished`);
  for (const y of [0, 25, 50, 75, 100]) {
    const r = rowAt(run, y, bbl);
    if (!r) continue;
    const cpi = run.macro[Math.min(run.macro.length - 1, y * 12)][C.cpi];
    say(`  ${String(2000 + y).padEnd(6)} ${String(r[1]).padEnd(12)} ${r[2] ? `${(r[2] / 1000).toFixed(1)}k sf, ${r[3]} fl, built ${r[4]}` : "vacant land"}` +
      `   land ${M(r[5])}  asset ${M(r[6])}  (real ${M(r[6] / cpi)})   ${r[8]}`);
  }
  say(`  timeline:`);
  for (const e of l.evs) {
    if (e.kind === "trade") {
      say(`    ${dt(e.m).padEnd(9)} SOLD  ${M(e.price).padStart(9)}  ${String(e.seller ?? "?").slice(0, 26).padEnd(28)} -> ${String(e.buyer ?? "?").slice(0, 26)}${e.distress ? "   [DISTRESS]" : ""}`);
    } else if (e.kind === "deliver") {
      say(`    ${dt(e.m).padEnd(9)} OPENED  ${e.cls}, ${(e.sf / 1000).toFixed(1)}k sf over ${e.fl} floors`);
    } else if (e.kind === "demolish") {
      say(`    ${dt(e.m).padEnd(9)} DEMOLISHED`);
    }
  }
}

// ---------------------------------------------------------------------------
H("THE CITY, DECADE BY DECADE — three unplayed centuries");
// Chosen for spread, not for prettiness: the seed that grew most, the seed that
// grew least, and the one nearest the median.
const byPop = [...nulls].sort((a, b) => a.macro[a.macro.length - 1][C.pop] - b.macro[b.macro.length - 1][C.pop]);
const three = [byPop[byPop.length - 1], byPop[Math.floor(byPop.length / 2)], byPop[0]];
const labels = ["the boom town", "the median town", "the town that stalled"];
for (const [i, run] of three.entries()) {
  const mac = run.macro;
  say(`\n${"-".repeat(78)}`);
  say(`seed ${run.meta.marketSeed} — ${labels[i]}`);
  say(`decade   pop      jobs     unemp  stock    vac%   rent(real)  cap%   loan%  CPI    recession mo`);
  for (let d = 0; d < 10; d++) {
    const a = mac[d * 120], b = mac[Math.min(mac.length - 1, d * 120 + 119)];
    const slice = mac.slice(d * 120, d * 120 + 120);
    const recM = slice.filter((x) => x[C.phase] === "recession").length;
    say(`  ${String(2000 + d * 10)}s ${String(b[C.pop]).padStart(8)} ${String(b[C.jobs]).padStart(8)} ` +
      `${b[C.unemp].toFixed(1).padStart(6)} ${(b[C.stock] / 1e6).toFixed(1).padStart(6)}M ${b[C.vOff].toFixed(1).padStart(6)} ` +
      `${(b[C.rOff] / b[C.cpi]).toFixed(0).padStart(9)} ${b[C.cap].toFixed(2).padStart(7)} ${b[C.rate].toFixed(2).padStart(7)} ` +
      `${b[C.cpi].toFixed(2).padStart(6)} ${String(recM).padStart(9)}`);
    void a;
  }
  say(`\n  real office rent, 2000-2100`);
  say(`  ${spark(mac.map((x) => x[C.rOff] / x[C.cpi]))}`);
  say(`  office vacancy`);
  say(`  ${spark(mac.map((x) => x[C.vOff]))}`);
  say(`  built stock`);
  say(`  ${spark(mac.map((x) => x[C.stock]))}`);
  say(`  policy rate`);
  say(`  ${spark(mac.map((x) => x[C.policy]))}`);
  const big = run.events.filter((e) => e[1] === "news" && e[2] === "event").slice(0, 0);
  void big;
}

// ---------------------------------------------------------------------------
H("IS THERE A TELL? — signals scored as rules, not as correlations");
// The question: standing in month t, does knowing X change what you should
// expect from real office rent three years out? Base rate first, so every rule
// is measured against doing nothing.
const OBS = [];
for (const run of runs) {
  const mac = run.macro;
  // trailing windows are per-run, because a rule a player could use can only
  // see the history of the city they are standing in
  for (let i = 120; i + 36 < mac.length; i++) {
    const x = mac[i];
    const back = mac.slice(i - 120, i);
    const realNow = x[C.rOff] / x[C.cpi];
    const realThen = mac[i + 36][C.rOff] / mac[i + 36][C.cpi];
    OBS.push({
      seed: run.meta.marketSeed, m: i,
      fwd: realThen / Math.max(0.01, realNow) - 1,
      pipe: x[C.pipe] / Math.max(1, x[C.stock]),
      pipeP80: q(back.map((b) => b[C.pipe] / Math.max(1, b[C.stock])), 0.8),
      vac: x[C.vOff],
      vacYoY: x[C.vOff] - mac[i - 12][C.vOff],
      vacMed: med(back.map((b) => b[C.vOff])),
      cap: x[C.cap], capMed: med(back.map((b) => b[C.cap])),
      rentYoY: i >= 12 ? x[C.rOff] / mac[i - 12][C.rOff] - 1 : 0,
      rentWage: (x[C.rOff] / x[C.cpi]) / Math.max(0.2, x[C.wage] / x[C.cpi]),
      rentWageMed: med(back.map((b) => (b[C.rOff] / b[C.cpi]) / Math.max(0.2, b[C.wage] / b[C.cpi]))),
      credit: x[C.credit], rate: x[C.rate], unemp: x[C.unemp],
      phase: x[C.phase],
    });
  }
}
const base = OBS.filter((o) => o.fwd < 0).length / OBS.length;
say(`base rate: over ${OBS.length.toLocaleString()} monthly observations, real office rent is LOWER three years later ${(base * 100).toFixed(1)}% of the time.`);
say(`median 3-year real rent change, unconditional: ${(med(OBS.map((o) => o.fwd)) * 100).toFixed(1)}%\n`);
const RULES = [
  ["pipeline above its own 10-yr 80th pctile", (o) => o.pipe > o.pipeP80],
  ["pipeline above 2.5% of stock",             (o) => o.pipe > 0.025],
  ["vacancy 2pp below its 10-yr median",       (o) => o.vac < o.vacMed - 2],
  ["vacancy 2pp above its 10-yr median",       (o) => o.vac > o.vacMed + 2],
  ["cap rate 50bp below its 10-yr median",     (o) => o.cap < o.capMed - 0.5],
  ["rent up more than 10% year on year",       (o) => o.rentYoY > 0.10],
  ["rent up more than 20% year on year",       (o) => o.rentYoY > 0.20],
  ["rent/wage 10% above its 10-yr median",     (o) => o.rentWage > o.rentWageMed * 1.10],
  ["credit index above 1.05",                  (o) => o.credit > 1.05],
  ["loan index above 9%",                      (o) => o.rate > 9],
  ["city unemployment below 4%",               (o) => o.unemp < 4],
  // The phase vocabulary is exactly expansion|peak|recession|recovery. This
  // line used to read `o.phase === "boom"`, fired 0 times out of 35,165, and
  // printed itself as "(too few to score)" rather than as what it was: a rule
  // that could not fire, sitting in a table of rules being scored on whether
  // they fire. Exactly the thing the house rules forbid.
  ["phase says peak",                          (o) => o.phase === "peak"],
  ["vacancy up 2pp from a year ago",           (o) => o.vacYoY > 2],
  ["vacancy over 11.5% AND up 2pp in a year",  (o) => o.vac > 11.5 && o.vacYoY > 2],
  ["TIGHT + BUILDING (vac low AND pipe hot)",  (o) => o.vac < o.vacMed - 2 && o.pipe > o.pipeP80],
  ["DEAR + BUILDING (rent/wage high AND pipe hot)", (o) => o.rentWage > o.rentWageMed * 1.10 && o.pipe > o.pipeP80],
];
say(`rule                                              fires    P(rent lower in 3y)   lift    median 3y change`);
const scored = [];
for (const [name, f] of RULES) {
  const hit = OBS.filter(f);
  if (hit.length < 200) { say(`  ${name.padEnd(48)} ${String(hit.length).padStart(6)}   (too few to score)`); continue; }
  const p = hit.filter((o) => o.fwd < 0).length / hit.length;
  const mv = med(hit.map((o) => o.fwd));
  scored.push({ name, n: hit.length, p, mv, f });
  say(`  ${name.padEnd(48)} ${String(hit.length).padStart(6)}   ${(p * 100).toFixed(1).padStart(8)}%` +
    `        ${(p - base >= 0 ? "+" : "")}${((p - base) * 100).toFixed(1).padStart(5)}pp   ${(mv * 100 >= 0 ? "+" : "")}${(mv * 100).toFixed(1).padStart(6)}%`);
}
scored.sort((a, b) => (b.p - base) - (a.p - base));
say(`\nSTRONGEST TELL: ${scored[0]?.name} — ${(scored[0]?.p * 100).toFixed(1)}% vs a ${(base * 100).toFixed(1)}% base rate ` +
  `(+${((scored[0]?.p - base) * 100).toFixed(1)}pp), median 3-year real rent ${(scored[0]?.mv * 100).toFixed(1)}%, ${scored[0]?.n.toLocaleString()} observations.`);
say(`WEAKEST/INVERTED: ${scored[scored.length - 1]?.name} — ${(scored[scored.length - 1]?.p * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
H("THE TELL, HONESTLY — non-overlapping windows, error bars, and a hold-out");
// Everything above pools 33,769 monthly observations that overlap almost
// completely: a 36-month forward window starting in March and one starting in
// April share 35 of their 36 months. The effective sample is one observation
// per 36 months per run, which is 34 x 33 = about 1,100, not 33,769 — and the
// standard error is thirty times what the raw count implies. Score the winner
// again on windows that do not overlap, split the runs in half by seed so the
// rule has to hold on cities it was not read off, and try thresholds a player
// could actually hold in their head.
{
  const indep = [];
  for (const run of runs) {
    const mac = run.macro;
    for (let i = 120; i + 36 < mac.length; i += 36) {      // stride = horizon
      const x = mac[i], back = mac.slice(i - 120, i);
      indep.push({
        seed: run.meta.marketSeed,
        fwd: (mac[i + 36][C.rOff] / mac[i + 36][C.cpi]) / Math.max(0.01, x[C.rOff] / x[C.cpi]) - 1,
        vac: x[C.vOff], vacYoY: x[C.vOff] - mac[i - 12][C.vOff], vacMed: med(back.map((b) => b[C.vOff])),
        pipe: x[C.pipe] / Math.max(1, x[C.stock]),
        pipeP80: q(back.map((b) => b[C.pipe] / Math.max(1, b[C.stock])), 0.8),
        rentYoY: x[C.rOff] / mac[i - 12][C.rOff] - 1,
        rentWage: (x[C.rOff] / x[C.cpi]) / Math.max(0.2, x[C.wage] / x[C.cpi]),
        rentWageMed: med(back.map((b) => (b[C.rOff] / b[C.cpi]) / Math.max(0.2, b[C.wage] / b[C.cpi]))),
        cap: x[C.cap], capMed: med(back.map((b) => b[C.cap])),
        unemp: x[C.unemp],
      });
    }
  }
  const seeds = [...new Set(indep.map((o) => o.seed))].sort((a, b) => a - b);
  const halfA = new Set(seeds.filter((_, i) => i % 2 === 0));
  const rate = (rows) => rows.length ? rows.filter((o) => o.fwd < 0).length / rows.length : NaN;
  const err = (p, n) => (n > 0 ? Math.sqrt(p * (1 - p) / n) : NaN);
  const b0 = rate(indep);
  say(`independent observations: ${indep.length} (one per 36 months per run), against ${OBS.length.toLocaleString()} overlapping ones`);
  say(`base rate on independent windows: ${(b0 * 100).toFixed(1)}% +/- ${(err(b0, indep.length) * 100).toFixed(1)}pp\n`);
  const HONEST = [
    ["vacancy 2pp above its 10-yr median", (o) => o.vac > o.vacMed + 2],
    ["vacancy above 10% flat",             (o) => o.vac > 10],
    ["vacancy above 12% flat",             (o) => o.vac > 12],
    ["vacancy below 6% flat",              (o) => o.vac < 6],
    ["rent up >20% year on year",          (o) => o.rentYoY > 0.20],
    ["rent/wage 10% over its 10-yr median", (o) => o.rentWage > o.rentWageMed * 1.10],
    ["pipeline over its 10-yr 80th pctile", (o) => o.pipe > o.pipeP80],
    ["vacancy up 2pp from a year ago",      (o) => o.vacYoY > 2],
    ["vacancy over 11.5% AND up 2pp/yr",    (o) => o.vac > 11.5 && o.vacYoY > 2],
  ];
  say(`rule                                    fires   P(lower in 3y)     lift vs base    half A    half B`);
  for (const [name, f] of HONEST) {
    const hit = indep.filter(f);
    if (hit.length < 30) { say(`  ${name.padEnd(38)} ${String(hit.length).padStart(5)}   (too few)`); continue; }
    const p = rate(hit), e = err(p, hit.length);
    const a = rate(hit.filter((o) => halfA.has(o.seed))), b = rate(hit.filter((o) => !halfA.has(o.seed)));
    say(`  ${name.padEnd(38)} ${String(hit.length).padStart(5)}   ${(p * 100).toFixed(1).padStart(5)}% +/- ${(e * 100).toFixed(1)}pp` +
      `   ${(p - b0 >= 0 ? "+" : "")}${((p - b0) * 100).toFixed(1).padStart(5)}pp    ${(a * 100).toFixed(0).padStart(4)}%    ${(b * 100).toFixed(0).padStart(4)}%`);
  }
  say(`\nA lift is only real if it clears its own error bar AND holds in both halves.`);
}

// ---------------------------------------------------------------------------
H("PRICES IN REAL TERMS, AND HOW OFTEN A BUILDING CHANGES HANDS");
{
  // Pooling a century of nominal prices measures inflation. Deflate each print
  // by the CPI of the month it printed in.
  const byCls = new Map(), early = [], late = [];
  let n = 0;
  for (const run of runs) {
    const cpiAt = new Map(run.macro.map((x) => [x[C.m], x[C.cpi]]));
    for (const t of run.trades) {
      const cpi = cpiAt.get(t[0]) ?? 1;
      if (!(t[5] > 0)) continue;
      const real = t[5] / cpi;
      n++;
      if (!byCls.has(t[2])) byCls.set(t[2], []);
      byCls.get(t[2]).push(real);
      if (t[0] < 120) early.push(real); else if (t[0] >= 1080) late.push(real);
    }
  }
  say(`${n.toLocaleString()} priced deeds, price per foot deflated to year-2000 dollars`);
  for (const [cls, v] of [...byCls.entries()].sort((a, b) => b[1].length - a[1].length)) {
    say(`  ${String(cls).padEnd(13)} ${String(v.length).padStart(6)} deeds   median $${med(v).toFixed(0)}/sf   p10 $${q(v, 0.1).toFixed(0)}   p90 $${q(v, 0.9).toFixed(0)}`);
  }
  say(`  first decade  median $${med(early).toFixed(0)}/sf real     last decade  median $${med(late).toFixed(0)}/sf real`);

  const lots = new Set();
  for (const run of runs) for (const [bbl] of run.parcelEv) lots.add(bbl);
  const deedsPerCentury = runs.reduce((a, r) => a + r.trades.length, 0) / runs.length;
  say(`\nTURNOVER: ${deedsPerCentury.toFixed(0)} deeds per century over ~${lots.size} lots that ever traded`);
  say(`  implied average hold ${(100 / (deedsPerCentury / lots.size)).toFixed(0)} years   (US commercial real estate runs 8-15)`);

  const om = [], mk = [];
  for (const run of runs) for (const t of run.trades) (t[10] ? om : mk).push(t[5]);
  say(`  off-market deeds ${om.length.toLocaleString()} of ${(om.length + mk.length).toLocaleString()}` +
    `${om.length === 0 ? "   <- NOTHING trades quietly; the off-market flag is written by no rival path" : ""}`);
}

// ---------------------------------------------------------------------------
H("HOW LONG DOES THE WARNING LAST? — lead time of the strongest tell");
const strongest = RULES.find((r) => r[0] === scored[0]?.name)?.[1];
if (strongest) {
  say(`horizon   P(real rent lower)   median change      base rate at that horizon`);
  for (const hz of [12, 24, 36, 48, 60, 84, 120]) {
    const hits = [], all = [];
    for (const run of runs) {
      const mac = run.macro;
      for (let i = 120; i + hz < mac.length; i++) {
        const x = mac[i], back = mac.slice(i - 120, i);
        const rn = x[C.rOff] / x[C.cpi], rt = mac[i + hz][C.rOff] / mac[i + hz][C.cpi];
        const ch = rt / Math.max(0.01, rn) - 1;
        all.push(ch);
        const probe = {
          pipe: x[C.pipe] / Math.max(1, x[C.stock]),
          pipeP80: q(back.map((b) => b[C.pipe] / Math.max(1, b[C.stock])), 0.8),
          vac: x[C.vOff], vacYoY: x[C.vOff] - mac[i - 12][C.vOff], vacMed: med(back.map((b) => b[C.vOff])),
          cap: x[C.cap], capMed: med(back.map((b) => b[C.cap])),
          rentYoY: x[C.rOff] / mac[i - 12][C.rOff] - 1,
          vacYoY: x[C.vOff] - mac[i - 12][C.vOff],
          rentWage: (x[C.rOff] / x[C.cpi]) / Math.max(0.2, x[C.wage] / x[C.cpi]),
          rentWageMed: med(back.map((b) => (b[C.rOff] / b[C.cpi]) / Math.max(0.2, b[C.wage] / b[C.cpi]))),
          credit: x[C.credit], rate: x[C.rate], unemp: x[C.unemp], phase: x[C.phase],
        };
        if (strongest(probe)) hits.push(ch);
      }
    }
    const p = hits.filter((c) => c < 0).length / Math.max(1, hits.length);
    const b0 = all.filter((c) => c < 0).length / Math.max(1, all.length);
    say(`  ${String(hz + " mo").padEnd(9)} ${(p * 100).toFixed(1).padStart(10)}%      ${(med(hits) * 100 >= 0 ? "+" : "")}${(med(hits) * 100).toFixed(1).padStart(6)}%          ${(b0 * 100).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------
H("EMERGENT — things nobody wrote a rule for");

// 1. Does the map concentrate or spread? Share of citywide value in the top decile of lots.
say(`\nCONCENTRATION — share of all built value held by the top 10% of lots`);
say(`seed        2000     2025     2050     2075     2100`);
for (const run of nulls.slice(0, 8)) {
  const cells = [];
  for (const y of [0, 25, 50, 75, 100]) {
    const s = run.snapshots.find((x) => x.yr === y);
    if (!s) { cells.push("   —  "); continue; }
    const vs = s.rows.map((r) => r[6]).sort((a, b) => b - a);
    const tot = vs.reduce((a, b) => a + b, 0);
    const top = vs.slice(0, Math.max(1, Math.round(vs.length * 0.1))).reduce((a, b) => a + b, 0);
    cells.push(`${(top / tot * 100).toFixed(1)}%`.padStart(7));
  }
  say(`${String(run.meta.marketSeed).padEnd(11)}${cells.join("  ")}`);
}

// 2. Distress clustering — what share of all deeds are distressed, by phase?
say(`\nDISTRESS — share of deeds recorded under duress, by the phase they printed in`);
const byPhase = new Map();
for (const run of runs) {
  const phaseAt = new Map(run.macro.map((x) => [x[C.m], x[C.phase]]));
  for (const t of run.trades) {
    const p = phaseAt.get(t[0]) ?? "?";
    const e = byPhase.get(p) ?? { n: 0, d: 0, psf: [] };
    e.n++; if (t[9]) e.d++; if (t[5] > 0) e.psf.push(t[5]);
    byPhase.set(p, e);
  }
}
for (const [p, e] of [...byPhase.entries()].sort((a, b) => b[1].n - a[1].n)) {
  say(`  ${String(p).padEnd(12)} ${String(e.n).padStart(7)} deeds   ${(e.d / e.n * 100).toFixed(1).padStart(5)}% distressed   median $${med(e.psf).toFixed(0)}/sf`);
}

// 3. Off-market vs marketed — do quiet deals print differently?
say(`\nOFF-MARKET vs MARKETED — median price per foot, all centuries`);
const om = [], mk = [];
for (const run of runs) for (const t of run.trades) (t[10] ? om : mk).push(t[5]);
say(`  off-market   ${om.length.toLocaleString()} deeds   median $${med(om).toFixed(0)}/sf   p10 $${q(om, 0.1).toFixed(0)}  p90 $${q(om, 0.9).toFixed(0)}`);
say(`  marketed     ${mk.length.toLocaleString()} deeds   median $${med(mk).toFixed(0)}/sf   p10 $${q(mk, 0.1).toFixed(0)}  p90 $${q(mk, 0.9).toFixed(0)}`);
say(`  the quiet discount: ${((med(om) / med(mk) - 1) * 100).toFixed(1)}%`);

// 4. The longest calm and the longest misery
say(`\nTHE LONGEST CALM AND THE LONGEST MISERY (consecutive months, any seed)`);
let calm = { n: 0 }, misery = { n: 0 };
for (const run of runs) {
  let cn = 0, mn = 0;
  for (const x of run.macro) {
    if (x[C.phase] === "recession") { mn++; cn = 0; if (mn > misery.n) misery = { n: mn, at: x[C.m], seed: run.meta.marketSeed, bot: run.meta.bot }; }
    else { cn++; mn = 0; if (cn > calm.n) calm = { n: cn, at: x[C.m], seed: run.meta.marketSeed, bot: run.meta.bot }; }
  }
}
say(`  longest stretch with no recession: ${(calm.n / 12).toFixed(1)} years, ending ${dt(calm.at)} (seed ${calm.seed}/${calm.bot})`);
say(`  longest unbroken recession:        ${(misery.n / 12).toFixed(1)} years, ending ${dt(misery.at)} (seed ${misery.seed}/${misery.bot})`);

// 5. Do the four markets move together?
say(`\nDO THE FOUR SPACE MARKETS MOVE TOGETHER? (corr of 12-mo real rent growth, pooled)`);
const gr = { office: [], retail: [], multifamily: [], industrial: [] };
const KEY = { office: C.rOff, retail: C.rRet, multifamily: C.rMf, industrial: C.rInd };
for (const run of runs) for (let i = 12; i < run.macro.length; i += 3) {
  const a = run.macro[i - 12], b = run.macro[i];
  for (const u of Object.keys(gr)) gr[u].push((b[KEY[u]] / b[C.cpi]) / Math.max(0.01, a[KEY[u]] / a[C.cpi]) - 1);
}
const corr = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; b += dx * dx; c += dy * dy; }
  return a / Math.sqrt(b * c);
};
const us = Object.keys(gr);
say(`              ${us.map((u) => u.slice(0, 6).padStart(8)).join("")}`);
for (const a of us) say(`  ${a.padEnd(12)}${us.map((b) => corr(gr[a], gr[b]).toFixed(2).padStart(8)).join("")}`);

// 6. Firm concentration over time
say(`\nWHO OWNS THE TOWN — top firm's share of all firm AUM`);
say(`seed        2025     2050     2075     2100    firms alive at 2100`);
for (const run of nulls.slice(0, 8)) {
  const cells = run.firmSeries.map((fs) => {
    const tot = fs.firms.reduce((a, f) => a + f.aum, 0);
    return tot > 0 ? `${(fs.firms[0].aum / tot * 100).toFixed(0)}%`.padStart(7) : "   —  ";
  });
  say(`${String(run.meta.marketSeed).padEnd(11)}${cells.join("  ")}    ${run.firmSeries[run.firmSeries.length - 1].firms.length}`);
}
say(`\ndone.`);
