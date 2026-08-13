// Rebuild the harness bundle: regenerate the entry from the ONE module list,
// then bundle it. `pnpm engine` used to skip the first half and quietly build
// a stale entry, so a newly exported function was missing from a bundle that
// had just been rebuilt.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeEntry } from "./entry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(HERE, ".entry.ts"), writeEntry());
const r = spawnSync(join(HERE, "..", "node_modules", ".bin", "esbuild"),
  [join(HERE, ".entry.ts"), "--bundle", "--format=esm", "--platform=node",
   `--outfile=${join(HERE, ".engine.mjs")}`], { stdio: "inherit" });
process.exit(r.status ?? 1);
