// THE PLAYER PATH, ACROSS TOWNS, NOT ACROSS ONE TOWN.
//
// `playerslate.js` measures one city. That is the right shape for an A/B — pin
// the profile, change one line, diff — and the wrong shape for a claim about
// what this path can reach, for exactly the reason `tools/styleaudit.mjs`
// exists: every city here is generated from a seed, so "which families does
// this draw" is a question about a DISTRIBUTION. A family that needs a
// twenty-storey office is absent from a harbour town whose tallest building is
// fourteen floors, and that is correct rather than broken — but you cannot
// tell the two apart from one screenshot.
//
// So: N fresh browser profiles, which means N random seeds, which since the
// drawn cities were retired means N different coastlines, district plans and
// park programmes. Union of what any town reached, and the per-run spread.
//
//   node tools/probe/slatesweep.mjs [runs]   # default 3
//
// Needs `pnpm dev` up. Each run is a full city generation plus a paint, so
// budget about 45 seconds apiece.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = Number(process.argv[2] ?? 3);
const URL_BASE = process.env.BW_URL ?? "http://127.0.0.1:5173/";


const facadeUnion = new Set(), deckUnion = new Set();
const rows = [];

{
  for (let i = 0; i < RUNS; i++) {
    // A FRESH PROFILE IS THE WHOLE POINT. `startRun` rerolls the seed, so a
    // throwaway profile is a brand new town every time; reusing one would
    // measure the same city N times and report it as N samples.
    const profile = mkdtempSync(join(tmpdir(), "slate-"));
    const shot = join(profile, "shot.png");
    let out = "";
    try {
      out = execFileSync("node", [
        join(here, "..", "shoot.mjs"), URL_BASE, shot,
        "--wait", "12000", "--profile", profile, "--verbose", "--settle", "22000",
        "--eval", `${readProbe()}`,
      ], { encoding: "utf8", cwd: join(here, "..", "..") });
    } catch (e) {
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    // Chromium is still flushing the profile as we delete it; a failed rmdir
    // here is normal and must not end the sweep — the reading is already in
    // `out`. Same caveat as shoot.mjs.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS will collect it */ }

    const seed = /seed=(\d+)/.exec(out)?.[1] ?? "?";
    const fac = /FACADES (\d+) families :: (.*)/.exec(out);
    const dck = /DECKS +(\d+) surfaces :: (.*)/.exec(out);
    if (!fac || !dck) { console.log(`seed=${seed}  NO READING\n${out.slice(-400)}`); continue; }
    const ids = (s) => s.trim().split(/\s+/).map((p) => Number(p.split(":")[0]));
    ids(fac[2]).forEach((n) => facadeUnion.add(n));
    ids(dck[2]).forEach((n) => deckUnion.add(n));
    rows.push({ seed, fac: Number(fac[1]), deck: Number(dck[1]) });
    console.log(`seed=${String(seed).padStart(10)}  ${String(fac[1]).padStart(3)} facade families  ${dck[1]} roof surfaces`);
  }
}

function readProbe() {
  return execFileSync("cat", [join(here, "playerslate.js")], { encoding: "utf8" });
}

if (!rows.length) { console.log("no readings — is `pnpm dev` up?"); process.exit(1); }
const f = rows.map((r) => r.fac);
console.log(
  `\n${rows.length} generated islands · facade families per island: min ${Math.min(...f)} · median ` +
  `${f.slice().sort((a, b) => a - b)[f.length >> 1]} · max ${Math.max(...f)}` +
  `\nunion across all islands: ${facadeUnion.size} facade families, ${deckUnion.size} roof surfaces`,
);
