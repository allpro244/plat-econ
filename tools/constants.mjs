// WHICH NUMBERS IN THIS ENGINE ARE FACTS, AND WHICH ARE JUST NUMBERS.
//
//   node tools/constants.mjs                 named constants, census + leverage
//   CENSUS=1 node tools/constants.mjs        the census only, in three seconds
//   SCOPE=core node tools/constants.mjs      + every literal in the five price files
//   SCOPE=city node tools/constants.mjs      the generator instead of the engine
//   SCOPE=all  node tools/constants.mjs      every literal everywhere (hours)
//
// CLAUDE.md draws a line through the middle of every constant in this repo: a
// measured fact about the business belongs hardcoded, and a coefficient that
// exists because the median run looked wrong without it is a fake. The line is
// real and it is invisible from the code, because both sides of it look
// identical — a name, an equals sign and a number.
//
// So this asks two questions about each one and crosses them.
//
// PROVENANCE is textual and it is the weaker half. It looks in the three places
// a reader would actually look — the trailing comment, the comment block above
// the statement, the comment block above the enclosing declaration — and sorts
// what it finds:
//
//   CITED     a year, a period, or a named source. Somebody can go and check.
//   CLAIMED   asserts a fact about the world with nothing to check it against
//             ("typical", "industry", "$/sf"). Probably true. Not verifiable.
//   REASONED  explains a mechanism and cites nothing.
//   BARE      no comment reaches it at all.
//
// This half can be gamed by writing better comments, which is why it is not
// the answer on its own, and why every entry in the report prints the comment
// it was scored on. Read them. A classifier is not a referee.
//
// LEVERAGE is not textual and cannot be gamed. It moves the number by 15% in
// each direction, rebuilds the engine, runs the same two towns for the same
// two hundred months with no player in them, and measures how far the worst-
// affected of fifteen headline outputs moved. Same seeds, same city, so the
// comparison is paired and exact: there is no sampling error in it at all, and
// the baseline is probed twice and asserted identical before anything else
// runs. Reported as an ELASTICITY — move this constant 1%, the economy moves
// E%.
//
// Crossing them gives the three things worth acting on:
//
//   BARE x HIGH      a number nobody has defended that the whole economy
//                    rests on. This is the fake-number suspect list and it is
//                    the reason this tool exists.
//   INERT            15% each way and nothing moved. The constant is dead
//                    code, or a clamp downstream is holding the model up and
//                    the constant is decoration. CLAUDE.md calls the second
//                    one a rail that hides a fault.
//   ANECDOTE x HIGH  cited, but to ONE market in ONE period. Manhattan 1990
//                    is not a distribution, and a coefficient fitted to the
//                    most famous crash on record is a coefficient fitted to
//                    the tail. Named because this repo does it, in my code.
//
// Excluded from perturbation by rule: 0, 1, 12, 100, 1000 and 1e6. Zero and
// one are structural, twelve is the calendar, and the rest are unit
// conversions. Perturbing a unit is a type error, not an experiment. Also
// excluded: hex literals, and everything inside a named PRNG or hash — the
// bit-mixing constants in mulberry32 are the algorithm, not a claim about the
// world, and they would otherwise sit at the top of the BARE list forever.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const WORK = join(APP, ".audit");

const SCOPE = process.env.SCOPE ?? "named";
const CENSUS_ONLY = process.env.CENSUS === "1";
const JOBS = Number(process.env.JOBS ?? 3);
const DELTA = Number(process.env.DELTA ?? 0.15);
const INERT = Number(process.env.INERT ?? 0.01);

// ---------------------------------------------------------------- the scanner

const UNITS = new Set([0, 1, 12, 100, 1000, 1e6]);
const IDENT = /[A-Za-z0-9_$]/;
// A `/` here starts a regex, not a division. Standard heuristic; the engine has
// few regexes and getting this wrong the other way would splice a digit out of
// a character class and produce code that does not compile, which is loud.
const REGEX_AFTER = /[(,=:[!&|?{};]$|\breturn$/;

/** Every numeric literal in a TS/JS source, with its position and its line. */
function literals(src) {
  const out = [];
  let i = 0, line = 1;
  const N = src.length;
  while (i < N) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < N && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < N && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < N) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") { line++; if (q !== "`") break; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "/") {
      const before = src.slice(Math.max(0, i - 12), i).replace(/\s+$/, "");
      if (REGEX_AFTER.test(before)) {
        i++;
        while (i < N && src[i] !== "\n") {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") { while (i < N && src[i] !== "]" && src[i] !== "\n") { if (src[i] === "\\") i++; i++; } }
          if (src[i] === "/") { i++; break; }
          i++;
        }
        continue;
      }
      i++; continue;
    }
    if (c >= "0" && c <= "9") {
      const prev = i > 0 ? src[i - 1] : "";
      if (IDENT.test(prev) || prev === ".") { while (i < N && IDENT.test(src[i])) i++; continue; }
      const start = i;
      if (src[i] === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        i += 2; while (i < N && /[0-9a-fA-F_]/.test(src[i])) i++;
      } else {
        while (i < N && /[0-9_]/.test(src[i])) i++;
        if (src[i] === "." && /[0-9]/.test(src[i + 1] ?? "")) { i++; while (i < N && /[0-9_]/.test(src[i])) i++; }
        if ((src[i] === "e" || src[i] === "E") && /[0-9+-]/.test(src[i + 1] ?? "")) {
          i++; if (src[i] === "+" || src[i] === "-") i++;
          while (i < N && /[0-9]/.test(src[i])) i++;
        }
      }
      const text = src.slice(start, i);
      // `1_000n` and friends: if an identifier char follows, it was not a number.
      if (i < N && IDENT.test(src[i])) { while (i < N && IDENT.test(src[i])) i++; continue; }
      out.push({ start, end: i, text, value: Number(text.replace(/_/g, "")), line });
      continue;
    }
    i++;
  }
  return out;
}

/** The contiguous run of comment lines ending at (not including) line `ln`. */
function commentAbove(lines, ln) {
  const got = [];
  for (let j = ln - 2; j >= 0; j--) {
    const t = lines[j].trim();
    if (t.startsWith("//")) { got.unshift(t.replace(/^\/+\s?/, "")); continue; }
    if (t.startsWith("*") || t.startsWith("/*") || t.endsWith("*/")) { got.unshift(t.replace(/^[/*]+\s?|\s*\*\/$/g, "")); continue; }
    break;
  }
  return got.join(" ");
}

const DECL = /^(export\s+)?(async\s+)?(function|const|let|class|type|interface)\b/;

/** The comment a reader would find: trailing, above the statement, above the declaration. */
function provenanceText(lines, ln) {
  const here = lines[ln - 1] ?? "";
  const trail = here.includes("//") ? here.slice(here.indexOf("//") + 2) : "";
  const above = commentAbove(lines, ln);
  let declLn = 0;
  for (let j = ln - 1; j >= 0; j--) if (DECL.test(lines[j])) { declLn = j + 1; break; }
  const decl = declLn && declLn !== ln ? commentAbove(lines, declLn) : "";
  return { trail: trail.trim(), above, decl, all: [trail, above, decl].join(" ").trim() };
}

const SOURCES = /\b(NCREIF|CoStar|REIS|BLS|FRED|Census|ULI|RSMeans|NAIOP|CBRE|JLL|Cushman|Moody|Case-Shiller|Green Street|MBA|Trepp|Fannie|Freddie|IRS|the Fed|Federal Reserve)\b/i;
const PERIOD = /\b(1[89]|20)\d\d\b|\b\d{4}\s*[-–]\s*\d{2,4}\b|\b(post-war|interwar|the eighties|the nineties)\b/i;
const CLAIM = /%\s*\/\s*yr|\bbps\b|\$\s*\/\s*sf|\bper (cent|year)\b|\ba year\b|\b(typical|typically|industry|standard|actual|actually|in life|in practice|real[- ]world|measured|observed|empirical|survey|market rate|conventional)\b/i;
const REASON = /\b(so that|because|otherwise|which is why|enough to|keeps|prevents|guard|clamp|floor|ceiling|means|lets|stops)\b/i;
const PLACES = /\b(Manhattan|New York|Houston|Tokyo|Japan|London|Chicago|Dallas|Boston|San Francisco|Los Angeles|Denver|Phoenix|Atlanta|Miami|Seattle|Toronto|Hong Kong|Dublin|Madrid)\b/gi;

function classify(text) {
  if (!text) return { grade: "BARE", anecdote: false };
  const cited = SOURCES.test(text) || PERIOD.test(text);
  const places = [...new Set((text.match(PLACES) ?? []).map((s) => s.toLowerCase()))];
  const periods = (text.match(/\b(1[89]|20)\d\d\b/g) ?? []).length;
  const anecdote = cited && places.length === 1 && periods <= 2;
  if (cited) return { grade: "CITED", anecdote };
  if (CLAIM.test(text)) return { grade: "CLAIMED", anecdote: false };
  if (REASON.test(text)) return { grade: "REASONED", anecdote: false };
  return { grade: "BARE", anecdote: false };
}

// ------------------------------------------------------------ what to look at

const ENGINE = readdirSync(join(APP, "src", "engine")).filter((f) => f.endsWith(".ts")).map((f) => join("src", "engine", f));
const CITY = ["src/citygen/build.mjs", "src/citygen/island.mjs", "src/citygen/citygen.mjs"];
// The five files that make prices and quantities. `SCOPE=core` reads every
// literal in these, not just the named ones, because the coefficients that
// shape a rent curve are written inline and a name is not what makes a number
// load-bearing.
const CORE = ["src/engine/market.ts", "src/engine/value.ts", "src/engine/dev.ts",
  "src/engine/demand.ts", "src/engine/absorption.ts"];
const FILES = [...ENGINE, ...CITY];

const NAMED = /^(export\s+)?const\s+([A-Z][A-Z_0-9]*)\s*[:=]/;
const DECL_NAME = /^(export\s+)?(async\s+)?(function|const|let|class)\s+([A-Za-z_$][\w$]*)/;
const BITS = /rng|random|mulberry|hash|fnv|mix32|shuffle|jitter32|seedFrom/i;

const all = [];
for (const rel of FILES) {
  const src = readFileSync(join(APP, rel), "utf8");
  const lines = src.split("\n");
  for (const lit of literals(src)) {
    const lineText = lines[lit.line - 1] ?? "";
    const m = NAMED.exec(lineText);
    const named = m ? m[2] : null;
    const prov = provenanceText(lines, lit.line);
    let owner = "";
    for (let j = lit.line - 1; j >= 0; j--) {
      const d = DECL_NAME.exec(lines[j]);
      if (d) { owner = d[4]; break; }
    }
    all.push({ file: rel, ...lit, named, owner, lineText: lineText.trim(), prov, ...classify(prov.all) });
  }
}

const perturbable = (r) => !UNITS.has(r.value) && Number.isFinite(r.value) && r.value !== 0
  && !/^0[xX]/.test(r.text) && !BITS.test(r.owner) && !BITS.test(r.named ?? "");
let targets = all.filter(perturbable);
if (SCOPE === "named") targets = targets.filter((r) => r.named);
else if (SCOPE === "core") targets = targets.filter((r) => r.named || CORE.includes(r.file));
else if (SCOPE === "city") targets = targets.filter((r) => CITY.includes(r.file));
// PICK is for interrogating the instrument, not for producing the report: it
// narrows to constants whose name or file:line matches, which is how you check
// that a probe CAN move before believing that it did not.
if (process.env.PICK) {
  const re = new RegExp(process.env.PICK);
  targets = targets.filter((r) => re.test(r.named ?? "") || re.test(`${r.file}:${r.line}`));
}
if (Number(process.env.LIMIT) > 0) targets = targets.slice(0, Number(process.env.LIMIT));

// ------------------------------------------------------------------ the census

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
const GRADES = ["CITED", "CLAIMED", "REASONED", "BARE"];

console.log(`\nTHE NUMERIC SURFACE — ${all.length} literals across ${FILES.length} files\n`);
{
  const tally = {};
  for (const r of all) tally[r.grade] = (tally[r.grade] ?? 0) + 1;
  const live = all.filter(perturbable);
  const liveTally = {};
  for (const r of live) liveTally[r.grade] = (liveTally[r.grade] ?? 0) + 1;
  console.log(`  ${pad("", 12)}${rpad("all", 9)}${rpad("non-unit", 11)}`);
  for (const g of GRADES) console.log(`  ${pad(g, 12)}${rpad(tally[g] ?? 0, 9)}${rpad(liveTally[g] ?? 0, 11)}`);
  console.log(`  ${pad("", 12)}${rpad(all.length, 9)}${rpad(live.length, 11)}`);
  const bareShare = (liveTally.BARE ?? 0) / Math.max(1, live.length);
  console.log(`\n  ${(bareShare * 100).toFixed(0)}% of the engine's non-unit numbers have no comment reaching them.`);
  const anec = live.filter((r) => r.anecdote);
  console.log(`  ${anec.length} are cited to a single market in a single period.`);
}

console.log(`\nBY FILE — non-unit literals, share with nothing written about them\n`);
{
  const by = {};
  for (const r of all.filter(perturbable)) {
    const b = (by[r.file] ??= { n: 0, bare: 0 });
    b.n++; if (r.grade === "BARE") b.bare++;
  }
  const rows = Object.entries(by).sort((a, b) => b[1].bare - a[1].bare).slice(0, 14);
  for (const [f, b] of rows) {
    console.log(`  ${pad(f.replace("src/", ""), 26)}${rpad(b.n, 6)}${rpad(b.bare, 7)}  ${rpad((100 * b.bare / b.n).toFixed(0) + "%", 6)}`);
  }
}

if (CENSUS_ONLY) {
  console.log(`\n  Census only. Drop CENSUS=1 to measure which of these the economy depends on.\n`);
  process.exit(0);
}

// ----------------------------------------------------------------- the leverage

console.log(`\nMEASURING LEVERAGE — ${targets.length} constants, +-${(DELTA * 100).toFixed(0)}%, ${JOBS} workers`);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

function makeRoot(name) {
  const root = join(WORK, name);
  mkdirSync(join(root, "test"), { recursive: true });
  cpSync(join(APP, "src"), join(root, "src"), { recursive: true });
  cpSync(join(APP, "test", "city.mjs"), join(root, "test", "city.mjs"));
  cpSync(join(APP, "test", ".entry.ts"), join(root, "test", ".entry.ts"));
  return root;
}

const ESBUILD = join(APP, "node_modules", ".bin", "esbuild");
async function build(root) {
  await run(ESBUILD, [join(root, "test", ".entry.ts"), "--bundle", "--format=esm", "--platform=node",
    "--outfile=" + join(root, "test", ".engine.mjs")], { cwd: APP });
}
async function probe(root) {
  const { stdout } = await run(process.execPath, [join(HERE, "constants-probe.mjs"), root], { cwd: APP, maxBuffer: 1 << 22 });
  return JSON.parse(stdout);
}

const base = makeRoot("base");
await build(base);
const b1 = await probe(base);
const b2 = await probe(base);
for (const k of Object.keys(b1)) {
  if (b1[k] !== b2[k]) {
    console.error(`\nTHE RULER MOVES. Two runs of the untouched engine disagree on ${k}: ${b1[k]} vs ${b2[k]}.`);
    console.error(`Every leverage number below would be measuring that instead of the constant. Stopping.\n`);
    process.exit(1);
  }
}
const base_ = b1;
const KEYS = Object.keys(b1);
console.log(`  baseline probed twice, identical on all ${KEYS.length} outputs — the ruler holds still\n`);

/** Symmetric relative difference, bounded at 2, so a near-zero baseline cannot explode. */
const srd = (a, b) => (a === b ? 0 : 2 * Math.abs(a - b) / (Math.abs(a) + Math.abs(b) || 1));

// Two readings, because they answer different questions. WORST is how far the
// single most-affected output moved — depth. BREADTH is the average across all
// fifteen — reach. A constant that only bends one number is a knob on one
// channel; a constant that bends all fifteen is load-bearing structure.
function distance(v) {
  let worst = 0, who = "", sum = 0;
  for (const k of KEYS) {
    if (!Number.isFinite(v[k])) return { worst: Infinity, who: k + " went non-finite", breadth: Infinity };
    const d = srd(base_[k], v[k]);
    sum += d;
    if (d > worst) { worst = d; who = k; }
  }
  return { worst, who, breadth: sum / KEYS.length };
}

const queue = targets.map((t, i) => ({ ...t, i }));
const results = [];
let done = 0;

async function worker(w) {
  const root = makeRoot("w" + w);
  const pristine = new Map();
  for (const rel of new Set(targets.map((t) => t.file))) pristine.set(rel, readFileSync(join(root, rel), "utf8"));
  while (queue.length) {
    const t = queue.shift();
    if (!t) break;
    const src = pristine.get(t.file);
    const arms = [];
    for (const sign of [1, -1]) {
      const nv = t.value * (1 + sign * DELTA);
      const patched = src.slice(0, t.start) + String(nv) + src.slice(t.end);
      writeFileSync(join(root, t.file), patched);
      try {
        await build(root);
        arms.push(distance(await probe(root)));
      } catch (err) {
        const msg = String(err.stderr ?? err.message ?? err).split("\n").find((l) => l.trim()) ?? "threw";
        arms.push({ worst: Infinity, who: "CRASH: " + msg.slice(0, 70) });
      }
    }
    writeFileSync(join(root, t.file), src);
    const best = arms[0].worst >= arms[1].worst ? arms[0] : arms[1];
    const asym = Math.min(arms[0].worst, arms[1].worst) < INERT && Math.max(arms[0].worst, arms[1].worst) >= INERT;
    results.push({ ...t, lev: best.worst, who: best.who, breadth: best.breadth, up: arms[0].worst, down: arms[1].worst, asym });
    done++;
    if (done % 10 === 0 || done === targets.length) process.stdout.write(`\r  ${done}/${targets.length}   `);
  }
}
await Promise.all(Array.from({ length: JOBS }, (_, w) => worker(w)));
process.stdout.write("\n");
rmSync(WORK, { recursive: true, force: true });
// A run of this costs an hour or two. Keep the measurements so a different
// question can be asked of them without paying for them again.
if (process.env.OUT) {
  writeFileSync(process.env.OUT, JSON.stringify({ delta: DELTA, base: base_, results }, null, 1));
  console.log(`  measurements written to ${process.env.OUT}`);
}

// -------------------------------------------------------------------- the report

const elast = (r) => r.lev / DELTA;
const label = (r) => r.named ?? `${r.owner || "?"}/${r.text}`;
const where = (r) => `${r.file.replace("src/engine/", "").replace("src/citygen/", "gen/")}:${r.line}`;

const live = results.filter((r) => Number.isFinite(r.lev) && r.lev >= INERT).sort((a, b) => b.lev - a.lev);
const inert = results.filter((r) => Number.isFinite(r.lev) && r.lev < INERT);
const crashed = results.filter((r) => !Number.isFinite(r.lev));

const bar = (e) => "#".repeat(Math.min(16, Math.max(1, Math.round(Math.log10(e * 1000) * 3.5))));

function table(rows, title, note) {
  console.log(`\n${title}\n${note ? "  " + note + "\n" : ""}`);
  if (!rows.length) { console.log("  (none)\n"); return; }
  console.log(`  ${pad("constant", 28)}${pad("where", 21)}${rpad("value", 11)}${rpad("elast", 8)}${rpad("reach", 8)}  ${pad("grade", 9)}${pad("moves", 12)}`);
  for (const r of rows) {
    console.log(`  ${pad(label(r).slice(0, 27), 28)}${pad(where(r), 21)}${rpad(r.text, 11)}${rpad(elast(r).toFixed(2), 8)}`
      + `${rpad((r.breadth / DELTA).toFixed(2), 8)}  ${pad(r.grade, 9)}${pad(r.who.slice(0, 11), 12)}${bar(elast(r))}`);
  }
}

table(live.slice(0, 30), "WHAT THE ECONOMY ACTUALLY RESTS ON — the thirty highest-leverage numbers",
  "Move one of these 1% and the worst-affected of fifteen outputs moves `elast`%. Grade is the provenance, and it is the whole point of the two columns sitting next to each other.");

const bareHigh = live.filter((r) => r.grade === "BARE");
table(bareHigh.slice(0, 40), "BARE x HIGH LEVERAGE — the economy rests on these and nobody has said why",
  "Every one of these changes a headline number and has no comment reaching it.");
for (const r of bareHigh.slice(0, 14)) console.log(`    ${where(r)}  ${r.lineText.slice(0, 96)}`);

table(live.filter((r) => r.anecdote).slice(0, 20), "ANECDOTE x HIGH LEVERAGE — fitted to one market in one period",
  "Cited, and the citation is a single famous episode. A tail is not a distribution.");
for (const r of live.filter((r) => r.anecdote).slice(0, 8)) console.log(`    ${where(r)}  "${r.prov.all.slice(0, 92)}"`);

table(live.filter((r) => r.grade === "CLAIMED" || r.grade === "REASONED").slice(0, 20),
  "ASSERTED x HIGH LEVERAGE — a real-world claim with nothing to check it against",
  "Probably true. Not verifiable from the comment, which is the same problem in a nicer coat.");

console.log(`\nINERT — 15% each way moved nothing. Dead code, or a clamp is holding the model up.\n`);
const inertNamed = inert.filter((r) => r.named);
console.log(`  ${inert.length} of ${results.length} constants (${inertNamed.length} of them named).`);
for (const r of inertNamed.slice(0, 24)) console.log(`    ${pad(label(r).slice(0, 26), 28)}${pad(where(r), 22)}${rpad(r.text, 12)}`);
if (inertNamed.length > 24) console.log(`    ...and ${inertNamed.length - 24} more`);

const asym = live.filter((r) => r.asym);
if (asym.length) {
  console.log(`\nONE-SIDED — moved in one direction and not the other. Something is clamping it.\n`);
  for (const r of asym.slice(0, 16)) console.log(`    ${pad(label(r).slice(0, 26), 28)}${pad(where(r), 22)}  up ${(r.up / DELTA).toFixed(2)}  down ${(r.down / DELTA).toFixed(2)}`);
}

if (crashed.length) {
  console.log(`\nNO GUARD — a 15% move and the engine threw or went non-finite.\n`);
  for (const r of crashed.slice(0, 16)) console.log(`    ${pad(label(r).slice(0, 26), 28)}${pad(where(r), 22)}${rpad(r.text, 10)}  ${r.who.slice(0, 60)}`);
}

console.log(`\nSUMMARY\n`);
const g = (n) => live.filter((r) => r.grade === n).length;
console.log(`  ${results.length} constants perturbed, ${live.length} move the economy, ${inert.length} inert, ${crashed.length} unguarded.`);
console.log(`  Of the ${live.length} that matter:  ${g("CITED")} cited   ${g("CLAIMED")} claimed   ${g("REASONED")} reasoned   ${g("BARE")} bare`);
console.log(`  ${live.filter((r) => r.anecdote).length} of the cited ones are cited to one market in one period.`);
console.log(`\n  The BARE list is the answer to "is this simulated or arranged". Read it,`);
console.log(`  and for each one either write down where the number came from or find out`);
console.log(`  that it came from nowhere.\n`);
