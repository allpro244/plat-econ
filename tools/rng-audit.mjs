// Fail if hot-path engine files gain rng()/rrange() calls without an RNG-NOTE.
//
//   node tools/rng-audit.mjs
//   RNG_NOTE=1 node tools/rng-audit.mjs   allow increases when commit documents re-roll
//
// Baseline counts live in tools/rng-baseline.json — bump only with measured re-roll note.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const HOT = ["sim.ts", "market.ts", "rivals.ts", "dev.ts"];
const baseline = JSON.parse(readFileSync(join(HERE, "rng-baseline.json"), "utf8"));
const allow = process.env.RNG_NOTE === "1" || /RNG-NOTE:/i.test(process.env.GIT_COMMIT_MESSAGE ?? "");

let fails = 0;
for (const file of HOT) {
  const src = readFileSync(join(APP, "src", "engine", file), "utf8");
  const rng = (src.match(/\brng\(/g) ?? []).length;
  const rrange = (src.match(/\brrange\(/g) ?? []).length;
  const base = baseline[file] ?? { rng: 0, rrange: 0 };
  const drift = (rng > base.rng || rrange > base.rrange);
  const line = `${file}: rng ${rng} (base ${base.rng}), rrange ${rrange} (base ${base.rrange})`;
  if (drift && !allow) {
    fails++;
    console.log(`FAIL  ${line} — set RNG_NOTE=1 or add RNG-NOTE: to commit when intentional`);
  } else {
    console.log(`OK    ${line}${drift ? " (allowed by RNG note)" : ""}`);
  }
}

if (fails) {
  console.log("\nHot-path RNG increased without note. Re-run paired audits if stream order changed.");
  process.exit(1);
}
console.log("\nrng-audit pass");
process.exit(0);
