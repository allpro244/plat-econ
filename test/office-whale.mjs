// Office requirements may exceed 120k sf — rarely.
//
//   pnpm engine && node test/office-whale.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));

let fails = 0;
const check = (ok, msg) => {
  if (!ok) { fails++; console.log("  FAIL", msg); }
  else console.log("  OK  ", msg);
};

const N = 50_000;
const g = E.newGame(12007);
const sizes = [];
for (let i = 0; i < N; i++) sizes.push(E.drawRequirementSf(g, "office"));
const gt120 = sizes.filter((x) => x > 120_000).length;
const gtBody = sizes.filter((x) => x > 120_000);
const max = Math.max(...sizes);
const mean = sizes.reduce((a, b) => a + b, 0) / N;

console.log("\nOFFICE WHALE — rare consolidator draws\n");
check(gt120 > 0, `some draws exceed 120k (${gt120}/${N} = ${(100 * gt120 / N).toFixed(2)}%)`);
check(gt120 / N < 0.03, `whales stay rare (<3%; got ${(100 * gt120 / N).toFixed(2)}%)`);
check(gt120 / N > 0.005, `whales are not vanishingly rare (>0.5%; got ${(100 * gt120 / N).toFixed(2)}%)`);
check(max > 180_000, `tail reaches past 180k (max ${max.toLocaleString()} sf)`);
check(max <= 500_000, `tail respects 500k ceiling (max ${max.toLocaleString()} sf)`);
check(mean > 15_000 && mean < 28_000, `mixture mean still desk-sized (${Math.round(mean).toLocaleString()} sf)`);
if (gtBody.length) {
  const whaleMin = Math.min(...gtBody);
  check(whaleMin >= 120_000, `whale band starts at body ceiling (min whale ${whaleMin.toLocaleString()})`);
}

// Body still dominates: median well under 20k.
sizes.sort((a, b) => a - b);
const med = sizes[Math.floor(N / 2)];
check(med < 20_000, `median still a normal suite ask (${med.toLocaleString()} sf)`);

console.log(fails ? `\n${fails} failed\n` : "\noffice-whale pass\n");
process.exit(fails ? 1 : 0);
