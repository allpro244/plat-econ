// THE COMMITTED PLAYABLE MUST MATCH THE SOURCE.
//
// PR #75 removed hand-drawn islands from citygen and the start screen, but the
// one-file bundle under playable/ was never rebuilt — so anyone opening
// playable/broadway-and-wall.html still saw New Alden and Kestrel Point in the
// island picker. This test fails if that stale bundle ships again.
//
// PR #82 merged UI + distress work but only refreshed the zip; the single-file
// HTML stayed older than TopBar/ParcelDesk. Guard against that too.
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYABLE = join(HERE, "..", "playable", "broadway-and-wall.html");
const PLAYABLE_ZIP = join(HERE, "..", "playable", "Broadway-and-Wall-playable.zip");

// Any UI change in these files must trigger a playable rebuild.
const SOURCE_ANCHORS = [
  join(HERE, "..", "src", "ui", "StartMenu.tsx"),
  join(HERE, "..", "src", "ui", "TopBar.tsx"),
  join(HERE, "..", "src", "ui", "panels", "ParcelDesk.tsx"),
  join(HERE, "..", "src", "ui", "panels", "DevelopDesk.tsx"),
  join(HERE, "..", "src", "ui", "panels", "AcquireDesk.tsx"),
  join(HERE, "..", "src", "ui", "panels", "RefiDesk.tsx"),
];

const LEGACY = [
  "which island",
  "district:`newalden`",
  "district:`kestrel`",
  "name:`New Alden`",
  "name:`Kestrel Point`",
];

// Strings that must appear in a post-#82 bundle — if source has them but html
// does not, someone merged code without `pnpm package:playable`.
const REQUIRED = [
  "Cycle, space markets and construction", // Economy tab (TopBar)
  "Pay ask",                                  // distressed offer desk
];

let html;
try {
  html = readFileSync(PLAYABLE, "utf8");
} catch {
  console.error("\nMissing playable/broadway-and-wall.html — rebuild it:\n"
    + "  pnpm --dir broadway-and-wall package:playable\n");
  process.exit(1);
}

const hits = LEGACY.filter((s) => html.includes(s));
if (hits.length) {
  console.error("\nSTALE PLAYABLE — hand-drawn cities still embedded in playable/broadway-and-wall.html:");
  for (const h of hits) console.error(`  · ${h}`);
  console.error("\nRebuild and commit:\n  pnpm --dir broadway-and-wall package:playable\n");
  process.exit(1);
}

const newestSource = Math.max(...SOURCE_ANCHORS.map((p) => statSync(p).mtimeMs));
const playableMtime = statSync(PLAYABLE).mtimeMs;
if (playableMtime < newestSource - 1000) {
  console.error("\nSTALE PLAYABLE — playable/broadway-and-wall.html is older than UI source.");
  console.error("Rebuild and commit:\n  pnpm --dir broadway-and-wall package:playable\n");
  process.exit(1);
}

const zipMtime = statSync(PLAYABLE_ZIP).mtimeMs;
if (zipMtime < playableMtime - 1000) {
  console.error("\nSTALE ZIP — Broadway-and-Wall-playable.zip is older than broadway-and-wall.html.");
  console.error("Rebuild and commit:\n  pnpm --dir broadway-and-wall package:playable\n");
  process.exit(1);
}

const missing = REQUIRED.filter((s) => !html.includes(s));
if (missing.length) {
  console.error("\nSTALE PLAYABLE — expected post-#82 UI strings missing from broadway-and-wall.html:");
  for (const s of missing) console.error(`  · ${s}`);
  console.error("\nRebuild and commit:\n  pnpm --dir broadway-and-wall package:playable\n");
  process.exit(1);
}

console.log("playable bundle: fresh html + zip, no legacy drawn cities");
