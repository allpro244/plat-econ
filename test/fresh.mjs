// THE BUNDLE MUST NOT BE OLDER THAN THE ENGINE IT CLAIMS TO TEST.
//
// test/.engine.mjs is gitignored and built by hand, so it can silently fall
// behind src/. That is not a small inconvenience: a harness running a stale
// bundle reports on an engine that no longer exists, and it reports with total
// confidence. CLAUDE.md's rule is that a test which cannot fail is itself a
// fake — a test measuring the wrong build is the same fault wearing a
// disguise, because it CAN fail, just not about anything real.
//
// This cost a full debugging session. A container restart left a bundle
// nineteen hours old in place; `pnpm conserve` then reported seven months out
// of balance, and the seven were real faults in an engine that had since been
// rewritten. Worse, the obvious control — stash the change, re-run, see if the
// failures persist — CONFIRMED the wrong conclusion, because both runs loaded
// the same stale bundle. The stale build survived every check made against it.
//
// So the harnesses assert freshness before they assert anything else.
import { statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) t = Math.max(t, newest(p));
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) t = Math.max(t, statSync(p).mtimeMs);
  }
  return t;
}

export function assertFreshBundle() {
  let bundle;
  try { bundle = statSync(join(HERE, ".engine.mjs")).mtimeMs; }
  catch {
    console.error("\nNo test/.engine.mjs. Build it:\n"
      + "  pnpm engine\n");
    process.exit(1);
  }
  const src = newest(SRC);
  if (src > bundle) {
    const mins = Math.round((src - bundle) / 60000);
    console.error(`\nSTALE BUNDLE — test/.engine.mjs is ${mins} minute(s) older than src/.`
      + `\nWhatever this harness reported would be about an engine that no longer exists.`
      + `\nRebuild it:\n  pnpm engine\n`
      + `\n(This scans ALL of src/, not just src/engine, so a UI-only edit trips it too.`
      + `\n Deliberate: a false "stale" costs 33ms, and a false "fresh" cost a whole`
      + `\n debugging session once. Erring on this side is the point.)\n`);
    process.exit(1);
  }
}
