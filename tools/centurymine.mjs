// THE ANALYSIS PASS. Reads what tools/century.mjs wrote and goes looking for
// the good bits. Prints a structured findings dump; the prose is written from
// it by hand, because a machine writing "the most spectacular collapse" is not
// the same thing as a machine finding one.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.DIR ?? "/tmp/century";
const idx = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8"));
const M = (n) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const yr = (m) => 2000 + Math.floor(m / 12);
const mo = (m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m % 12];
const dt = (m) => `${mo(m)} ${yr(m)}`;
const med = (a) => { const b = [...a].filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : NaN; };
const q = (a, p) => { const b = [...a].filter(Number.isFinite).sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
const corr = (xs, ys) => {
  const n = Math.min(xs.length, ys.length); if (n < 8) return NaN;
  let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; } mx /= n; my /= n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; a += dx * dy; b += dx * dx; c += dy * dy; }
  return b > 0 && c > 0 ? a / Math.sqrt(b * c) : NaN;
};
// macro row column names, in capture order
const C = { m: 0, phase: 1, rOff: 2, rRet: 3, rMf: 4, rInd: 5, vOff: 6, vRet: 7, vMf: 8, vInd: 9,
  cap: 10, rate: 11, cpi: 12, wage: 13, pop: 14, jobs: 15, unemp: 16, credit: 17, land: 18, cost: 19,
  stock: 20, pipe: 21, nw: 22, holds: 23, natU: 24, natI: 25, policy: 26, demo: 27, built: 28 };

const say = (...a) => console.log(...a);
const H = (t) => { say(`\n${"=".repeat(76)}\n${t}\n${"=".repeat(76)}`); };

const runs = [];
for (const r of idx) {
  const d = JSON.parse(readFileSync(join(DIR, r.file), "utf8"));
  runs.push(d);
}
const nulls = runs.filter((r) => r.meta.bot === "none");
const played = runs.filter((r) => r.meta.bot !== "none");
say(`${runs.length} centuries loaded — ${nulls.length} unplayed, ${played.length} played`);
say(`${runs.reduce((a, r) => a + r.trades.length, 0).toLocaleString()} recorded deeds, ` +
    `${runs.reduce((a, r) => a + r.events.length, 0).toLocaleString()} logged events, ` +
    `${(runs.length * 1200).toLocaleString()} simulated months`);

// ---------------------------------------------------------------------------
H("RECORDS AND EXTREMES");

// --- fortunes and collapses
const fortunes = played.map((r) => {
  const nws = r.macro.map((x) => x[C.nw]);
  let peak = -Infinity, peakM = 0, trough = Infinity, troughM = 0, maxDD = 0, ddPeak = 0, ddFrom = 0, ddTo = 0;
  let run = -Infinity, runM = 0;
  for (let i = 0; i < nws.length; i++) {
    if (nws[i] > run) { run = nws[i]; runM = i; }
    const dd = run > 0 ? 1 - nws[i] / run : 0;
    if (dd > maxDD) { maxDD = dd; ddPeak = run; ddFrom = runM; ddTo = i; }
    if (nws[i] > peak) { peak = nws[i]; peakM = i; }
    if (nws[i] < trough) { trough = nws[i]; troughM = i; }
  }
  const cpi = r.macro[r.macro.length - 1][C.cpi];
  return { seed: r.meta.marketSeed, bot: r.meta.bot, end: nws[nws.length - 1], real: nws[nws.length - 1] / cpi,
    peak, peakM, trough, troughM, maxDD, ddPeak, ddFrom, ddTo, ended: r.meta.ended, final: r.final, cpi };
}).sort((a, b) => b.end - a.end);
say(`\nTHE MONEY, sorted by nominal net worth at 2100:`);
say(`bot        seed      end NW      real NW     peak          worst drawdown         holds`);
for (const f of fortunes) {
  say(`${f.bot.padEnd(10)} ${String(f.seed).padEnd(9)} ${M(f.end).padEnd(11)} ${M(f.real).padEnd(11)} ${M(f.peak).padEnd(13)} ` +
      `${(f.maxDD * 100).toFixed(0)}% (${dt(f.ddFrom)}->${dt(f.ddTo)})`.padEnd(23) + ` ${f.final?.holds ?? 0}${f.ended ? "  RUINED" : ""}`);
}

// --- rent records
let hiRent = { v: 0 }, loRent = { v: 1e9 };
for (const r of runs) for (const x of r.macro) {
  for (const [k, u] of [[C.rOff, "office"], [C.rRet, "retail"], [C.rMf, "multifamily"], [C.rInd, "industrial"]]) {
    const real = x[k] / x[C.cpi];
    if (real > hiRent.v) hiRent = { v: real, nom: x[k], u, m: x[C.m], seed: r.meta.marketSeed, bot: r.meta.bot, cpi: x[C.cpi] };
    if (u === "office" && real < loRent.v) loRent = { v: real, nom: x[k], u, m: x[C.m], seed: r.meta.marketSeed, bot: r.meta.bot };
  }
}
say(`\nHIGHEST REAL RENT INDEX EVER: ${hiRent.u} at ${hiRent.v.toFixed(0)} real (${hiRent.nom.toFixed(0)} nominal, CPI ${hiRent.cpi.toFixed(2)}x) — ${dt(hiRent.m)}, seed ${hiRent.seed}/${hiRent.bot}`);
say(`LOWEST REAL OFFICE RENT:      ${loRent.v.toFixed(1)} real (${loRent.nom.toFixed(0)} nominal) — ${dt(loRent.m)}, seed ${loRent.seed}/${loRent.bot}`);

// --- biggest single-year swings in the office rent index
let swingUp = { v: 0 }, swingDn = { v: 0 };
for (const r of runs) {
  for (let i = 12; i < r.macro.length; i++) {
    const a = r.macro[i - 12][C.rOff], b = r.macro[i][C.rOff];
    if (a <= 0) continue;
    const ch = b / a - 1;
    if (ch > swingUp.v) swingUp = { v: ch, m: i, from: a, to: b, seed: r.meta.marketSeed, bot: r.meta.bot };
    if (ch < swingDn.v) swingDn = { v: ch, m: i, from: a, to: b, seed: r.meta.marketSeed, bot: r.meta.bot };
  }
}
say(`BIGGEST 12-MONTH RENT GAIN:   +${(swingUp.v * 100).toFixed(0)}% (${swingUp.from.toFixed(0)} -> ${swingUp.to.toFixed(0)}) ending ${dt(swingUp.m)}, seed ${swingUp.seed}/${swingUp.bot}`);
say(`BIGGEST 12-MONTH RENT FALL:   ${(swingDn.v * 100).toFixed(0)}% (${swingDn.from.toFixed(0)} -> ${swingDn.to.toFixed(0)}) ending ${dt(swingDn.m)}, seed ${swingDn.seed}/${swingDn.bot}`);

// --- vacancy extremes
// vacancy is captured in PERCENT, so the old floor of 1 meant "tightest" only
// ever matched a market below one percent and the record printed undefined
let hiVac = { v: -Infinity }, loVac = { v: Infinity };
for (const r of runs) for (const x of r.macro) {
  if (x[C.vOff] > hiVac.v) hiVac = { v: x[C.vOff], m: x[C.m], seed: r.meta.marketSeed, bot: r.meta.bot };
  if (x[C.vOff] < loVac.v) loVac = { v: x[C.vOff], m: x[C.m], seed: r.meta.marketSeed, bot: r.meta.bot };
}
say(`WORST OFFICE VACANCY:         ${hiVac.v.toFixed(1)}% — ${dt(hiVac.m)}, seed ${hiVac.seed}/${hiVac.bot}`);
say(`TIGHTEST OFFICE MARKET:       ${loVac.v.toFixed(1)}% — ${dt(loVac.m)}, seed ${loVac.seed}/${loVac.bot}`);

// --- the most-traded parcels, most-rebuilt parcels, longest holds
const tradeCount = new Map(), rebuilds = new Map(), demos = new Map();
for (const r of runs) {
  for (const [bbl, evs] of r.parcelEv) {
    const t = evs.filter((e) => e.kind === "trade").length;
    const d = evs.filter((e) => e.kind === "demolish").length;
    const b = evs.filter((e) => e.kind === "deliver").length;
    const key = `${bbl}`;
    if (t > (tradeCount.get(key)?.n ?? 0)) tradeCount.set(key, { n: t, seed: r.meta.marketSeed, bot: r.meta.bot, evs });
    if (b > (rebuilds.get(key)?.n ?? 0)) rebuilds.set(key, { n: b, d, seed: r.meta.marketSeed, bot: r.meta.bot, evs });
    if (d > (demos.get(key)?.n ?? 0)) demos.set(key, { n: d, seed: r.meta.marketSeed, bot: r.meta.bot });
  }
}
const topTraded = [...tradeCount.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
say(`\nMOST-TRADED PARCELS (deeds recorded in one century):`);
for (const [bbl, v] of topTraded) {
  const addr = addrOf(v.seed, v.bot, bbl);
  say(`  ${v.n}x  ${addr ?? bbl}  (seed ${v.seed}/${v.bot})  first ${dt(v.evs.find((e) => e.kind === "trade").m)}, last ${dt([...v.evs].reverse().find((e) => e.kind === "trade").m)}`);
}
// A "rebuild" is a wrecking ball AND a groundbreak on the same dirt. Scoring
// on deliveries alone printed an empty table: almost no lot in this city gets
// built on twice in a century, which is itself the finding — the skyline turns
// over by demolition far more often than by replacement.
const topRebuilt = [...rebuilds.entries()].map(([bbl, v]) => [bbl, { ...v, tot: v.n + v.d }])
  .filter(([, v]) => v.tot > 1).sort((a, b) => b[1].tot - a[1].tot).slice(0, 6);
say(`\nMOST-CHURNED LOTS (wrecking balls + groundbreaks on one lot in one century):`);
for (const [bbl, v] of topRebuilt) {
  say(`  ${v.d} demolished, ${v.n} delivered  ${addrOf(v.seed, v.bot, bbl) ?? bbl}  (seed ${v.seed}/${v.bot})`);
}
const demoTot = [...demos.values()].reduce((a, v) => a + v.n, 0);
say(`  lots that saw at least one wrecking ball, across all centuries: ${[...demos.values()].filter((v) => v.n > 0).length} (${demoTot} demolitions)`);

function addrOf(seed, bot, bbl) {
  const r = runs.find((x) => x.meta.marketSeed === seed && x.meta.bot === bot);
  const s = r?.snapshots?.[0]?.rows?.find((row) => row[0] === bbl);
  return s ? s[9] : null;
}
function snapAt(run, yrWanted, bbl) {
  const s = run.snapshots.find((x) => x.yr === yrWanted);
  return s?.rows.find((row) => row[0] === bbl) ?? null;
}

// --- tenants
const allTen = [];
for (const r of played) for (const t of r.tenants) allTen.push({ ...t, seed: r.meta.marketSeed, bot: r.meta.bot, len: t.lastM - t.startM });
allTen.sort((a, b) => b.len - a.len);
say(`\nLONGEST-TENURED TENANTS (player buildings only — the street does not keep a rent roll):`);
for (const t of allTen.slice(0, 5)) {
  say(`  ${(t.len / 12).toFixed(1)} yrs  ${t.name} (${t.sector}) at ${addrOf(t.seed, t.bot, t.bbl) ?? t.bbl}, ${(t.sf / 1000).toFixed(1)}k sf, ${dt(t.startM)} -> ${dt(t.lastM)}  [${t.bot}/${t.seed}]`);
}

// --- the most valuable block, then and now
H("THE MAP AT 2000 AND AT 2100");
for (const r of nulls.slice(0, 3)) {
  const s0 = r.snapshots.find((x) => x.yr === 0), s100 = r.snapshots[r.snapshots.length - 1];
  const byD0 = new Map(), byD100 = new Map();
  for (const row of s0.rows) byD0.set(row[8], (byD0.get(row[8]) ?? 0) + row[6]);
  for (const row of s100.rows) byD100.set(row[8], (byD100.get(row[8]) ?? 0) + row[6]);
  const cpi = r.macro[r.macro.length - 1][C.cpi];
  say(`\nseed ${r.meta.marketSeed} — district value, 2000 vs 2100 (2100 deflated to 2000 dollars, CPI ${cpi.toFixed(2)}x)`);
  for (const [d, v0] of [...byD0.entries()].sort((a, b) => b[1] - a[1])) {
    const v1 = (byD100.get(d) ?? 0) / cpi;
    say(`  ${d.padEnd(12)} ${M(v0).padStart(9)} -> ${M(v1).padStart(9)} real   ${((v1 / v0 - 1) * 100 >= 0 ? "+" : "")}${((v1 / v0 - 1) * 100).toFixed(0)}%`);
  }
}

// ---------------------------------------------------------------------------
H("CYCLE ANATOMY");
// run-length encode the phase string; a cycle is peak -> peak
const cycles = [];
for (const r of runs) {
  const ph = r.macro.map((x) => x[C.phase]);
  const runsOf = [];
  let cur = ph[0], start = 0;
  for (let i = 1; i < ph.length; i++) if (ph[i] !== cur) { runsOf.push({ p: cur, a: start, b: i - 1 }); cur = ph[i]; start = i; }
  runsOf.push({ p: cur, a: start, b: ph.length - 1 });
  const recs = runsOf.filter((x) => x.p === "recession");
  // IN REAL RENT, NOT NOMINAL. The first version of this measured the nominal
  // index and reported a median downturn of 4%, which is not a downturn — it
  // is inflation carrying the index up through a market that was falling
  // underneath it. A landlord whose rent rose 3% while the price level rose 9%
  // had a bad year and the nominal series will never say so.
  const real = (k) => r.macro[k][C.rOff] / r.macro[k][C.cpi];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    const rentA = real(Math.max(0, rec.a - 1));
    let trough = Infinity, troughAt = rec.a;
    for (let k = rec.a; k < Math.min(r.macro.length, rec.b + 60); k++) if (real(k) < trough) { trough = real(k); troughAt = k; }
    let recovAt = null;
    for (let k = troughAt; k < r.macro.length; k++) if (real(k) >= rentA) { recovAt = k; break; }
    cycles.push({ seed: r.meta.marketSeed, bot: r.meta.bot, start: rec.a, len: rec.b - rec.a + 1,
      drop: rentA > 0 ? 1 - trough / rentA : 0, troughAt, recovery: recovAt ? recovAt - troughAt : null,
      vacAtStart: r.macro[rec.a][C.vOff], vacPeak: Math.max(...r.macro.slice(rec.a, Math.min(r.macro.length, rec.b + 36)).map((x) => x[C.vOff])),
      pipeBefore: r.macro[Math.max(0, rec.a - 24)][C.pipe] / Math.max(1, r.macro[Math.max(0, rec.a - 24)][C.stock]),
      creditAtStart: r.macro[rec.a][C.credit] });
  }
  void runsOf;
}
say(`${cycles.length} recessions across ${runs.length} centuries — ${(cycles.length / runs.length).toFixed(1)} per century`);
say(`  length          median ${med(cycles.map((c) => c.len))} months   p10 ${q(cycles.map((c) => c.len), 0.1)}  p90 ${q(cycles.map((c) => c.len), 0.9)}`);
say(`  rent drawdown   median ${(med(cycles.map((c) => c.drop)) * 100).toFixed(0)}%   worst ${(Math.max(...cycles.map((c) => c.drop)) * 100).toFixed(0)}%`);
const recs = cycles.map((c) => c.recovery).filter((x) => x !== null);
say(`  months trough->prior peak: median ${med(recs)}   p90 ${q(recs, 0.9)}   never recovered: ${cycles.length - recs.length}`);
say(`  vacancy at onset ${med(cycles.map((c) => c.vacAtStart)).toFixed(1)}% -> peak ${med(cycles.map((c) => c.vacPeak)).toFixed(1)}%`);
say(`  construction pipeline 2 yrs BEFORE onset: ${(med(cycles.map((c) => c.pipeBefore)) * 100).toFixed(2)}% of stock`);

// leading indicators: what turns before the office rent index peaks?
H("LEADING INDICATORS — what turns before the peak?");
const cands = [["pipeline/stock", (x) => x[C.pipe] / Math.max(1, x[C.stock])], ["office vacancy", (x) => x[C.vOff]],
  ["credit index", (x) => x[C.credit]], ["cap rate", (x) => x[C.cap]], ["loan index", (x) => x[C.rate]],
  ["city unemployment", (x) => x[C.unemp]], ["cost index growth", (x) => x[C.cost]], ["land index", (x) => x[C.land]],
  ["jobs", (x) => x[C.jobs]], ["national unemployment", (x) => x[C.natU]]];
say(`correlation of each variable at month t with REAL office rent growth over t+12..t+36`);
say(`(negative = high readings precede weak rents — a warning sign)\n`);
const rows = [];
for (const [name, f] of cands) {
  const xs = [], ys = [];
  for (const r of runs) {
    for (let i = 0; i + 36 < r.macro.length; i += 3) {
      const a = r.macro[i], b12 = r.macro[i + 12], b36 = r.macro[i + 36];
      const g0 = (b36[C.rOff] / b36[C.cpi]) / Math.max(0.01, b12[C.rOff] / b12[C.cpi]) - 1;
      xs.push(f(a)); ys.push(g0);
    }
  }
  rows.push({ name, r: corr(xs, ys), n: xs.length });
}
rows.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
for (const x of rows) say(`  ${x.name.padEnd(24)} r = ${x.r >= 0 ? "+" : ""}${x.r.toFixed(3)}   ${"#".repeat(Math.round(Math.abs(x.r) * 40))}`);

// ---------------------------------------------------------------------------
H("DYNASTIES");
for (const r of nulls.slice(0, 3)) {
  say(`\nseed ${r.meta.marketSeed} — the league table, by AUM`);
  for (const fs of r.firmSeries) {
    const top = fs.firms.slice(0, 4).map((f) => `${f.name} ${M(f.aum)}(${f.n})`).join("  ·  ");
    say(`  ${String(2000 + fs.yr).padEnd(6)} ${fs.firms.length} alive   ${top}`);
  }
  const born = r.firms.length, died = r.firms.filter((f) => f.diedM !== null).length;
  const survivors = r.firms.filter((f) => f.diedM === null && f.bornM <= 12);
  say(`  ${born} firms existed, ${died} died. Survived the whole century from year 1: ${survivors.length ? survivors.map((f) => `${f.name} (${f.style})`).join(", ") : "none"}`);
}
// aggregate: does style predict survival?
const byStyle = new Map();
for (const r of runs) for (const f of r.firms) {
  const e = byStyle.get(f.style) ?? { n: 0, died: 0, peak: [], life: [] };
  e.n++; if (f.diedM !== null) { e.died++; e.life.push(f.diedM - f.bornM); }
  e.peak.push(f.peakAum); byStyle.set(f.style, e);
}
say(`\nSTYLE vs SURVIVAL, all ${runs.length} centuries:`);
say(`style          firms   died    death rate   median peak AUM   median lifespan if it died`);
for (const [s, e] of [...byStyle.entries()].sort((a, b) => b[1].n - a[1].n)) {
  say(`  ${String(s).padEnd(13)}${String(e.n).padEnd(8)}${String(e.died).padEnd(8)}${(e.died / e.n * 100).toFixed(0).padStart(4)}%${M(med(e.peak)).padStart(18)}${(e.life.length ? (med(e.life) / 12).toFixed(1) + " yrs" : "—").padStart(28)}`);
}

// ---------------------------------------------------------------------------
H("THE CITY ITSELF — a hundred years of the unplayed town");
const g0 = [], g100 = [];
for (const r of nulls) {
  const a = r.macro[0], b = r.macro[r.macro.length - 1];
  g0.push({ pop: a[C.pop], jobs: a[C.jobs], stock: a[C.stock] });
  g100.push({ pop: b[C.pop], jobs: b[C.jobs], stock: b[C.stock], cpi: b[C.cpi],
    rentReal: b[C.rOff] / b[C.cpi], demo: b[C.demo], built: b[C.built],
    wageReal: b[C.wage] / b[C.cpi] });
}
say(`across ${nulls.length} unplayed centuries, medians:`);
say(`  population     ${med(g0.map((x) => x.pop)).toLocaleString()} -> ${med(g100.map((x) => x.pop)).toLocaleString()}`);
say(`  jobs           ${med(g0.map((x) => x.jobs)).toLocaleString()} -> ${med(g100.map((x) => x.jobs)).toLocaleString()}`);
say(`  built stock    ${(med(g0.map((x) => x.stock)) / 1e6).toFixed(1)}M sf -> ${(med(g100.map((x) => x.stock)) / 1e6).toFixed(1)}M sf`);
say(`  CPI            ${med(g100.map((x) => x.cpi)).toFixed(2)}x over the century`);
say(`  real office rent index ${(med(g100.map((x) => x.rentReal))).toFixed(0)} vs 62 at the start`);
say(`  buildings demolished ${med(g100.map((x) => x.demo))}   city groundbreaks ${med(g100.map((x) => x.built))}`);
say(`  spread across seeds: population ${q(g100.map((x) => x.pop), 0.1).toLocaleString()} to ${q(g100.map((x) => x.pop), 0.9).toLocaleString()}, ` +
    `real rent ${q(g100.map((x) => x.rentReal), 0.1).toFixed(0)} to ${q(g100.map((x) => x.rentReal), 0.9).toFixed(0)}`);

// ---------------------------------------------------------------------------
H("ODDITIES — cross-seed correlations at year 100");
const feat = nulls.map((r) => {
  const b = r.macro[r.macro.length - 1];
  const recMonths = r.macro.filter((x) => x[C.phase] === "recession").length;
  return { seed: r.meta.marketSeed, pop: b[C.pop], jobs: b[C.jobs], stock: b[C.stock],
    rentReal: b[C.rOff] / b[C.cpi], cpi: b[C.cpi], demo: b[C.demo], built: b[C.built],
    recMonths, vac: med(r.macro.map((x) => x[C.vOff])), rate: med(r.macro.map((x) => x[C.rate])),
    trades: r.trades.length, firms: r.firmSeries[r.firmSeries.length - 1].firms.length };
});
const pairs = [["recession months", "rentReal"], ["recession months", "stock"], ["median vacancy", "rentReal"],
  ["median loan rate", "stock"], ["stock", "rentReal"], ["jobs", "rentReal"], ["demolitions", "stock"],
  ["trades", "firms"], ["cpi", "rentReal"]];
const pick = (k) => ({ "recession months": (x) => x.recMonths, "rentReal": (x) => x.rentReal, "stock": (x) => x.stock,
  "median vacancy": (x) => x.vac, "median loan rate": (x) => x.rate, "jobs": (x) => x.jobs,
  "demolitions": (x) => x.demo, "trades": (x) => x.trades, "firms": (x) => x.firms, "cpi": (x) => x.cpi }[k]);
for (const [a, b] of pairs) {
  const r = corr(feat.map(pick(a)), feat.map(pick(b)));
  say(`  corr(${a}, ${b})`.padEnd(46) + ` = ${r >= 0 ? "+" : ""}${r.toFixed(3)}`);
}
say(`\nspread at 2100 across ${nulls.length} unplayed seeds (the same city, different weather):`);
for (const [k, f] of [["population", (x) => x.pop], ["built stock (M sf)", (x) => x.stock / 1e6],
  ["real office rent", (x) => x.rentReal], ["CPI multiple", (x) => x.cpi], ["recession months of 1200", (x) => x.recMonths],
  ["firms alive", (x) => x.firms], ["demolitions", (x) => x.demo]]) {
  const v = feat.map(f);
  say(`  ${k.padEnd(28)} min ${q(v, 0).toFixed(1).padStart(10)}  med ${med(v).toFixed(1).padStart(10)}  max ${q(v, 0.999).toFixed(1).padStart(10)}   ratio ${(q(v, 0.999) / Math.max(0.01, q(v, 0))).toFixed(1)}x`);
}
say(`\ndone.`);
